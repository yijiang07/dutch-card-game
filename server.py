import asyncio
import json
import os
import random
import secrets
import smtplib
import string
import time
import traceback
from email.message import EmailMessage

from aiohttp import web, WSMsgType

import bots
import storage
from game import Game, GameError, MATCH_CLAIM_SECONDS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

CODE_ALPHABET = ''.join(c for c in string.ascii_uppercase if c not in 'IO')

# Seconds a bot "thinks" between steps, so humans can follow the action.
BOT_DELAY = 3.0

# Email (optional) — configure these env vars to enable "email me a reset link".
SMTP_HOST = os.environ.get('SMTP_HOST')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER = os.environ.get('SMTP_USER')
SMTP_PASS = os.environ.get('SMTP_PASS')
SMTP_FROM = os.environ.get('SMTP_FROM') or SMTP_USER
APP_BASE_URL = (os.environ.get('APP_BASE_URL') or '').rstrip('/')
EMAIL_ENABLED = bool(SMTP_HOST and SMTP_FROM and APP_BASE_URL)

# user_id -> set of live websockets for that signed-in user (presence)
ONLINE = {}

# ---- abuse guards ----
CHAT_WINDOW, CHAT_MAX = 6.0, 6      # max chat messages per window, per connection
AUTH_WINDOW, AUTH_MAX = 300.0, 12   # max auth attempts per window, per IP (brute-force / spam guard)
_auth_hits = {}                     # ip -> [timestamps]


def _check_auth_rate(ip):
    now = time.time()
    q = _auth_hits.setdefault(ip or '?', [])
    q[:] = [t for t in q if now - t < AUTH_WINDOW]
    if len(q) >= AUTH_MAX:
        raise GameError('Too many attempts — please wait a minute and try again.')
    q.append(now)
    if len(_auth_hits) > 5000:       # crude cap so the dict can't grow unbounded
        for k in [k for k, v in _auth_hits.items() if not v or now - v[-1] > AUTH_WINDOW]:
            _auth_hits.pop(k, None)


def _send_email_sync(to_addr, subject, body):
    msg = EmailMessage()
    msg['Subject'] = subject
    msg['From'] = SMTP_FROM
    msg['To'] = to_addr
    msg.set_content(body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        s.starttls()
        if SMTP_USER:
            s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


async def send_email(to_addr, subject, body):
    if not EMAIL_ENABLED:
        return False
    try:
        await asyncio.to_thread(_send_email_sync, to_addr, subject, body)
        return True
    except Exception as e:
        print(f'[email] failed to send to {to_addr}: {e}')
        return False


class Room:
    def __init__(self, code):
        self.code = code
        self.host_id = None
        # player_id -> {name, token, ws, connected, is_bot, difficulty}
        self.players = {}
        self.game = None
        self.brains = {}
        self.bot_task_running = False
        self.stats_recorded = False
        self.series = {}          # player_id -> cumulative score across rounds
        self.rounds_played = 0
        self.settings = {'cardsPer': 4, 'bufferSeconds': 2.5, 'matching': True, 'turnLimit': 30, 'powers': 'basic'}
        self.monitor_running = False
        self.deal_seq = 0         # bumps each new round so clients can deal-in cards
        self.ranked = False       # ranked 1v1: standard rules, no bots, Glicko-rated
        self.reveal_scheduled = False  # guards the end-of-round match-grace reveal task

    def connected_count(self):
        return sum(1 for p in self.players.values() if p['connected'])


rooms = {}


def new_code():
    while True:
        code = ''.join(random.choices(CODE_ALPHABET, k=4))
        if code not in rooms:
            return code


def new_id():
    return secrets.token_hex(4)


def new_token():
    return secrets.token_urlsafe(16)


def _humans(room):
    return [pid for pid, p in room.players.items() if not p.get('is_bot')]


def _reassign_host(room):
    humans = _humans(room)
    room.host_id = humans[0] if humans else next(iter(room.players), None)


def clean_name(raw):
    name = (raw or '').strip()[:20]
    return name or 'Player'


async def send(ws, payload):
    if ws is not None and not ws.closed:
        try:
            await ws.send_str(json.dumps(payload))
        except ConnectionResetError:
            pass


def lobby_state(room, viewer_id):
    return {
        'phase': 'lobby',
        'code': room.code,
        'hostId': room.host_id,
        'youId': viewer_id,
        'players': [
            {'id': pid, 'name': p['name'], 'connected': p['connected'], 'isYou': pid == viewer_id,
             'isBot': p.get('is_bot', False), 'difficulty': p.get('difficulty'),
             'cardBack': p.get('card_back', 'classic'), 'emblem': p.get('emblem', 'default')}
            for pid, p in room.players.items()
        ],
        'settings': room.settings,
        'ranked': room.ranked,
    }


def build_state(room, viewer_id):
    if room.game is None:
        return lobby_state(room, viewer_id)
    state = room.game.public_state(viewer_id)
    state['code'] = room.code
    state['hostId'] = room.host_id
    state['youId'] = viewer_id
    meta = room.players
    for p in state['players']:
        info = meta.get(p['id'], {})
        p['connected'] = info.get('connected', False)
        p['isBot'] = info.get('is_bot', False)
        p['difficulty'] = info.get('difficulty')
        p['cardBack'] = info.get('card_back', 'classic')
        p['emblem'] = info.get('emblem', 'default')
        p['account'] = bool(info.get('account_id'))
        p['left'] = info.get('left', False)
    state['roundsPlayed'] = room.rounds_played
    state['dealSeq'] = room.deal_seq
    state['ranked'] = room.ranked
    state['series'] = [{'id': pid, 'name': meta[pid]['name'], 'total': tot}
                       for pid, tot in room.series.items() if pid in meta]
    return state


def _bump(room, pid, key):
    """Increment a per-round counter on a (human) player. Bots/guests are harmless to track."""
    p = room.players.get(pid)
    if p is not None:
        p[key] = p.get(key, 0) + 1


def _count_play(room, pid, correct):
    """Tally one judged decision for a human player (bots/guests-without-account ignored)."""
    p = room.players.get(pid)
    if not p or p.get('is_bot'):
        return
    p['play_total'] = p.get('play_total', 0) + 1
    if correct:
        p['play_correct'] = p.get('play_correct', 0) + 1


def _score_play(room, game, pid, actual):
    """Tally whether a human's flip/swap matched the knowledge-optimal play."""
    if game.phase == 'playing' and game.turn_mode == 'awaitingAction' and game.current_player() == pid:
        _count_play(room, pid, bots.judge_main_play(room, game, pid, actual))


# Unlockable cosmetics. Each entry maps a skin id to a predicate over a player's
# stats dict + achievement code set. Purely visual; enforced here so a crafted
# setCosmetic can't equip a locked skin.
CARD_BACKS = {
    'classic': lambda s, a: True,
    'crimson': lambda s, a: s.get('wins', 0) >= 1,
    'emerald': lambda s, a: s.get('games', 0) >= 10,
    'amber':   lambda s, a: s.get('referrals', 0) >= 1,
    'royal':   lambda s, a: len(a) >= 5,
    'noir':    lambda s, a: (s.get('rating') or 0) >= 1700,
    'ocean':   lambda s, a: s.get('games', 0) >= 25,
    'rose':    lambda s, a: s.get('wins', 0) >= 5,
    'sunset':  lambda s, a: s.get('wins', 0) >= 25,
    'frost':   lambda s, a: s.get('referrals', 0) >= 3,
    'orchid':  lambda s, a: len(a) >= 10,
    'aurora':  lambda s, a: (s.get('rating') or 0) >= 2000,
}
TABLE_FELTS = {
    'classic':  lambda s, a: True,
    'midnight': lambda s, a: s.get('games', 0) >= 5,
    'slate':    lambda s, a: s.get('games', 0) >= 20,
    'crimson':  lambda s, a: s.get('wins', 0) >= 3,
    'royal':    lambda s, a: len(a) >= 3,
    'sunrise':  lambda s, a: (s.get('rating') or 0) >= 1550,
}
EMBLEMS = {
    'default': lambda s, a: True,
    'clover':  lambda s, a: s.get('games', 0) >= 3,
    'gift':    lambda s, a: s.get('referrals', 0) >= 1,
    'star':    lambda s, a: s.get('wins', 0) >= 3,
    'fox':     lambda s, a: s.get('games', 0) >= 15,
    'joker':   lambda s, a: len(a) >= 5,
    'crown':   lambda s, a: (s.get('rating') or 0) >= 1700,
    'dragon':  lambda s, a: s.get('wins', 0) >= 20,
}
# kind -> (users column, rule table). `shared` marks a cosmetic other players see
# in-game (so equipping it must rebroadcast room state); felt is viewer-only.
COSMETIC_DEFS = {
    'cardBack':  {'col': 'card_back',  'rules': CARD_BACKS,  'shared': True},
    'tableFelt': {'col': 'table_felt', 'rules': TABLE_FELTS, 'shared': False},
    'emblem':    {'col': 'emblem',     'rules': EMBLEMS,     'shared': True},
}


def _cosmetic_unlocked(kind, skin, user_id):
    defn = COSMETIC_DEFS.get(kind)
    rule = defn['rules'].get(skin) if defn else None
    if rule is None:
        return False
    stats = storage.get_stats(user_id) or {}
    achs = set(storage.get_achievements(user_id) or [])
    return bool(rule(stats, achs))


def _referral_codes(count):
    codes = []
    if count >= 1:
        codes.append('invite_1')
    if count >= 5:
        codes.append('invite_5')
    if count >= 10:
        codes.append('invite_10')
    return codes


def _earned_codes(game, r, stats, ranked):
    """Which achievement codes a player qualifies for from a finished round."""
    pid = r['pid']
    codes = []
    if r['won']:
        codes.append('first_win')
    if any(c['value'] == 0 for c in game.grids.get(pid, [])):   # only a red King scores 0
        codes.append('red_king')
    if r['plays_total'] >= 3 and r['plays_correct'] == r['plays_total']:
        codes.append('perfect_round')
    if r['shed'] >= 3:
        codes.append('shed3')
    if r['powers'] >= 3:
        codes.append('power3')
    if r['won'] and r['total'] <= 3:
        codes.append('low_score')
    if r['won'] and game.dutch_caller == pid:
        codes.append('dutch_win')
    if ranked and r['won']:
        codes.append('ranked_win')
    if (stats or {}).get('games', 0) >= 25:
        codes.append('veteran')
    streak = (stats or {}).get('streak', 0)
    if streak >= 3:
        codes.append('streak_3')
    if streak >= 7:
        codes.append('streak_7')
    if streak >= 30:
        codes.append('streak_30')
    return codes


async def record_game_if_needed(room):
    """Once a round reaches reveal, record stats for account-linked players."""
    game = room.game
    if game is None or game.phase != 'reveal' or room.stats_recorded:
        return
    room.stats_recorded = True
    totals = {pid: sum(c['value'] for c in grid) for pid, grid in game.grids.items()}
    if not totals:
        return
    # Cumulative match standings across rounds (all players, incl. bots/guests).
    for pid, total in totals.items():
        room.series[pid] = room.series.get(pid, 0) + total
    room.rounds_played += 1
    min_total = min(totals.values())
    results = []
    for pid, total in totals.items():
        p = room.players.get(pid, {})
        acct = p.get('account_id')
        if acct:
            pc, pt = p.get('play_correct', 0), p.get('play_total', 0)
            # Placement: 1 + number of players who scored strictly lower (ties share a rank).
            placement = 1 + sum(1 for t in totals.values() if t < total)
            results.append({'user_id': acct, 'pid': pid, 'total': total, 'won': total == min_total,
                            'plays_correct': pc, 'plays_total': pt,
                            'placement': placement, 'accuracy': (round(100 * pc / pt) if pt else None),
                            'shed': p.get('shed', 0), 'powers': p.get('powers', 0)})
    if not results:
        return
    await asyncio.to_thread(storage.record_game, results)

    # Ranked 1v1: update Glicko ratings when both seats are still real accounts.
    ranked_out = None
    if room.ranked and len(room.players) == 2:
        seats = [(pid, room.players[pid]) for pid in totals if pid in room.players]
        if len(seats) == 2 and all(
                p.get('account_id') and not p.get('is_bot') and not p.get('left') for _, p in seats):
            (pa, ainfo), (pb, binfo) = seats
            a_total, b_total = totals[pa], totals[pb]
            a_score = 1.0 if a_total < b_total else (0.0 if a_total > b_total else 0.5)
            ranked_out = await asyncio.to_thread(
                storage.record_ranked_1v1, ainfo['account_id'], binfo['account_id'], a_score)
            room.players[pa]['_ranked_acct'] = ainfo['account_id']
            room.players[pb]['_ranked_acct'] = binfo['account_id']

    # Per-round match history for each account player.
    now = time.time()
    history = [{'user_id': r['user_id'], 'played_at': now, 'total': r['total'], 'won': r['won'],
                'players': len(totals), 'ranked': bool(room.ranked),
                'rating_delta': (ranked_out.get(r['user_id'], {}).get('delta') if ranked_out else None),
                'placement': r['placement'], 'accuracy': r['accuracy'],
                'shed': r['shed'], 'powers': r['powers']}
               for r in results]
    await asyncio.to_thread(storage.record_history, history)

    for r in results:
        stats = await asyncio.to_thread(storage.get_stats, r['user_id'])
        earned = await asyncio.to_thread(
            storage.award_achievements, r['user_id'], _earned_codes(game, r, stats, bool(room.ranked)))
        for w in list(ONLINE.get(r['user_id'], ())):
            await send(w, {'type': 'statsUpdate', 'stats': stats, 'won': r['won']})
            if earned:
                await send(w, {'type': 'achievements', 'earned': earned})
    if ranked_out:
        for pid, p in room.players.items():
            acct = p.get('_ranked_acct')
            res = ranked_out.get(acct) if acct else None
            if res and p.get('ws'):
                await send(p['ws'], {'type': 'rankedUpdate', 'rating': res['rating'],
                                     'delta': res['delta'], 'won': res['won']})


async def broadcast_state(room):
    await record_game_if_needed(room)
    game = room.game
    if game and getattr(game, 'ending', False) and game.phase == 'playing' and not room.reveal_scheduled:
        room.reveal_scheduled = True
        asyncio.create_task(final_reveal(room))
    for pid, p in room.players.items():
        if p['ws'] is not None:
            await send(p['ws'], {'type': 'state', 'state': build_state(room, pid)})


async def final_reveal(room):
    """Hold the round open for last-second matching, then reveal. The window is
    extended each time someone matches (game.end_at) and waits out active matchers."""
    try:
        while True:
            game = room.game
            if game is None or game.phase == 'reveal' or not game.ending:
                return
            now = time.time()
            if game.matcher is not None:
                await asyncio.sleep(0.3)  # let the in-progress match resolve/expire
                continue
            if now >= game.end_at:
                game.finish_round()
                await broadcast_state(room)
                return
            await asyncio.sleep(min(0.35, max(0.05, game.end_at - now)))
    finally:
        room.reveal_scheduled = False


# ---- bot driver ----

def schedule_bots(room):
    if room.game is None or room.game.phase == 'reveal' or room.bot_task_running:
        return
    actor = bots.required_actor(room.game)
    if actor and room.players.get(actor, {}).get('is_bot'):
        asyncio.create_task(drive_bots(room))


async def drive_bots(room):
    if room.bot_task_running:
        return
    room.bot_task_running = True
    try:
        while True:
            game = room.game
            if game is None or game.phase == 'reveal':
                break
            actor = bots.required_actor(game)
            if not actor or not room.players.get(actor, {}).get('is_bot'):
                break
            await asyncio.sleep(BOT_DELAY)
            # re-check: state may have changed while we slept
            game = room.game
            if game is None or game.phase == 'reveal':
                break
            if game.matcher is not None:
                continue  # play is paused while someone matches; wait it out
            if bots.required_actor(game) != actor:
                continue
            try:
                status = bots.take_action(room, game, actor)
            except GameError:
                break
            if status == 'wait':
                continue  # match buffer still active; loop sleeps and retries
            await broadcast_state(room)
    finally:
        room.bot_task_running = False


async def expire_match(room, deadline):
    """Auto-release the match lock if the matcher doesn't pick a card in time."""
    await asyncio.sleep(MATCH_CLAIM_SECONDS + 0.3)
    game = room.game
    if game and game.matcher is not None and game.matcher_deadline == deadline:
        game.matcher = None
        game._log('matchExpired')
        await broadcast_state(room)
        schedule_bots(room)


def _progress_sig(game):
    """Changes on any real progress (turn/action/peek), so the monitor can tell
    whether the game is actually advancing or genuinely stalled."""
    return (game.phase, game.turn_counter, game.action_seq, game.peeking_index,
            bots.required_actor(game))


def _idle_limit(room, game, actor):
    """How long the current actor may stall before the monitor steps in.
    Always kept above the bot pace so nobody is skipped mid-move, and stuck
    bots get rescued too."""
    p = room.players.get(actor, {})
    bot_backstop = BOT_DELAY + game.buffer_seconds + 5  # generous: drive_bots is the normal driver
    if p.get('is_bot'):
        return bot_backstop
    if not p.get('connected'):
        return max(25, BOT_DELAY + 2)         # disconnected human — grace to reconnect & rejoin
    if game.turn_limit:
        return max(game.turn_limit, BOT_DELAY + 2)  # never faster than a bot moves
    return bot_backstop                        # limit "off": still backstop a truly stuck seat


async def turn_monitor(room):
    """Never let the game stall. If whoever's turn it is stops making progress for
    longer than their idle limit (disconnected/idle human, or a wedged bot),
    auto-play their turn. Timings are tied to the bot delay so a healthy bot is
    never interrupted."""
    if room.monitor_running:
        return
    room.monitor_running = True
    last_sig, since = None, time.time()
    try:
        while room.game and room.game.phase != 'reveal':
            await asyncio.sleep(1)
            game = room.game
            if not game or game.phase == 'reveal':
                break
            sig = _progress_sig(game)
            if sig != last_sig:
                last_sig, since = sig, time.time()
                continue
            actor = bots.required_actor(game)
            if not actor or game.matcher is not None:
                since = time.time()
                continue
            if time.time() - since < _idle_limit(room, game, actor):
                continue
            # Stalled — finish this seat's turn automatically.
            p = room.players.get(actor, {})
            if p.get('is_bot'):
                reason = 'stuck'
            elif not p.get('connected'):
                reason = 'disconnected'
            else:
                reason = 'idle'
            game._log('autoplay', name=game.names.get(actor, ''), reason=reason)
            guard = 0
            while room.game and room.game.phase != 'reveal' and bots.required_actor(room.game) == actor and guard < 12:
                guard += 1
                try:
                    st = bots.take_action(room, room.game, actor)
                except GameError:
                    break
                await broadcast_state(room)
                await asyncio.sleep(0.6 if st == 'wait' else 0.35)
            last_sig, since = (_progress_sig(room.game), time.time()) if room.game else (None, time.time())
            schedule_bots(room)
    finally:
        room.monitor_running = False


def start_monitor(room):
    if not room.monitor_running:
        asyncio.create_task(turn_monitor(room))


# ---- friends / presence ----

def friends_payload(user_id):
    rel = storage.relations_of(user_id)
    for f in rel['friends']:
        f['online'] = f['id'] in ONLINE
    return {'type': 'friendsUpdate', **rel}


async def push_friends(user_id):
    for ws in list(ONLINE.get(user_id, ())):
        await send(ws, friends_payload(user_id))


async def notify_friends_of(user_id):
    """Presence or relationship changed — refresh everyone who lists this user."""
    rel = storage.relations_of(user_id)
    for group in (rel['friends'], rel['incoming'], rel['outgoing']):
        for u in group:
            await push_friends(u['id'])


async def set_online(ws, ctx, user):
    ctx['user'] = {'id': user['id'], 'username': user['username'],
                   'card_back': user.get('card_back') or 'classic',
                   'table_felt': user.get('table_felt') or 'classic',
                   'emblem': user.get('emblem') or 'default'}
    ONLINE.setdefault(user['id'], set()).add(ws)
    payload = {'type': 'identity', 'userId': user['id'], 'username': user['username'],
               'email': user.get('email'), 'lang': user.get('lang'),
               'cardBack': user.get('card_back') or 'classic',
               'tableFelt': user.get('table_felt') or 'classic',
               'emblem': user.get('emblem') or 'default',
               'streak': storage.get_streak(user['id'])}
    if user.get('secret'):
        payload['secret'] = user['secret']
    if user.get('recovery_code'):
        payload['recoveryCode'] = user['recovery_code']
    await send(ws, payload)
    await push_friends(user['id'])
    await notify_friends_of(user['id'])


async def set_offline(ws, ctx):
    user = ctx.get('user')
    if not user:
        return
    conns = ONLINE.get(user['id'])
    if conns:
        conns.discard(ws)
        if not conns:
            del ONLINE[user['id']]
            await notify_friends_of(user['id'])


async def handle_index(request):
    return web.FileResponse(os.path.join(PUBLIC_DIR, 'index.html'))


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)
    xff = request.headers.get('X-Forwarded-For')
    ip = xff.split(',')[0].strip() if xff else request.remote
    ctx = {'code': None, 'player_id': None, 'user': None, 'ip': ip, 'chat_times': []}

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except (ValueError, TypeError):
                continue
            try:
                await handle_message(ws, ctx, data)
            except (GameError, ValueError) as e:
                await send(ws, {'type': 'errorMsg', 'message': str(e)})
            except Exception:
                # Log unexpected errors (visible in Render logs) and keep the
                # connection alive instead of silently dropping it.
                print('[error] handling %r:\n%s' % (data.get('type'), traceback.format_exc()), flush=True)
                await send(ws, {'type': 'errorMsg', 'message': 'Something went wrong. Please try again.'})
            room = rooms.get(ctx['code'])
            if room:
                schedule_bots(room)
    finally:
        await set_offline(ws, ctx)
        room = rooms.get(ctx['code'])
        if room and ctx['player_id'] in room.players:
            room.players[ctx['player_id']]['ws'] = None
            room.players[ctx['player_id']]['connected'] = False
            await broadcast_state(room)

    return ws


async def handle_message(ws, ctx, data):
    mtype = data.get('type')

    # ---- identity & friends (independent of any room) ----

    if mtype == 'identify':
        # Auto-reconnect with a stored session token.
        user = storage.verify_session(data.get('userId'), data.get('secret'))
        if user:
            await set_online(ws, ctx, user)
        else:
            await send(ws, {'type': 'identityFailed'})
        return

    if mtype == 'signup':
        if ctx.get('user'):
            raise GameError('You are already signed in.')
        _check_auth_rate(ctx.get('ip'))
        created = storage.create_user(data.get('username'), data.get('password') or '',
                                      data.get('email'), data.get('lang'))
        secret = storage.create_session(created['id'])
        await set_online(ws, ctx, {'id': created['id'], 'username': created['username'],
                                   'email': data.get('email') or None, 'lang': created.get('lang'),
                                   'secret': secret, 'recovery_code': created['recovery_code']})
        # Credit a referral if this signup came through someone's invite link.
        ref = data.get('ref')
        if ref:
            res = await asyncio.to_thread(storage.record_referral, ref, created['id'])
            if res:
                earned = await asyncio.to_thread(
                    storage.award_achievements, res['referrer_id'], _referral_codes(res['count']))
                for w in list(ONLINE.get(res['referrer_id'], ())):
                    await send(w, {'type': 'referralJoined', 'count': res['count']})
                    if earned:
                        await send(w, {'type': 'achievements', 'earned': earned})
        return

    if mtype == 'setLang':
        user = ctx.get('user')
        if user:
            storage.set_lang(user['id'], data.get('lang') or 'en')
        return

    if mtype == 'setCosmetic':
        user = ctx.get('user')
        if not user:
            raise GameError('Log in to change your cosmetics.')
        kind = data.get('kind', 'cardBack')
        defn = COSMETIC_DEFS.get(kind)
        if not defn:
            raise GameError('Unknown cosmetic.')
        skin = data.get('id') or data.get('cardBack') or 'classic'
        if skin not in defn['rules']:
            raise GameError('Unknown cosmetic.')
        if not _cosmetic_unlocked(kind, skin, user['id']):
            raise GameError('That cosmetic is still locked.')
        storage.set_cosmetic(user['id'], defn['col'], skin)
        user[defn['col']] = skin
        await send(ws, {'type': 'cosmetic', 'kind': kind, 'id': skin})
        if defn['shared']:
            code = ctx.get('code')
            room = rooms.get(code) if code else None
            if room and ctx.get('player_id') in room.players:
                room.players[ctx['player_id']][defn['col']] = skin
                await broadcast_state(room)
        return

    if mtype == 'login':
        if ctx.get('user'):
            raise GameError('You are already signed in.')
        _check_auth_rate(ctx.get('ip'))
        user = storage.verify_password(data.get('username'), data.get('password') or '')
        if not user:
            raise GameError('Wrong username or password.')
        secret = storage.create_session(user['id'])
        await set_online(ws, ctx, {**user, 'secret': secret})
        return

    if mtype == 'recover':
        if ctx.get('user'):
            raise GameError('You are already signed in.')
        _check_auth_rate(ctx.get('ip'))
        user = storage.verify_recovery(data.get('username'), data.get('code') or '')
        if not user:
            raise GameError('Wrong username or recovery code.')
        new_pw = data.get('newPassword')
        if new_pw:
            storage.set_password(user['id'], new_pw)
        secret = storage.create_session(user['id'])
        await set_online(ws, ctx, {**user, 'secret': secret})
        return

    if mtype == 'logout':
        storage.delete_session(data.get('secret'))
        await set_offline(ws, ctx)
        ctx['user'] = None
        await send(ws, {'type': 'loggedOut'})
        return

    if mtype == 'setEmail':
        user = ctx.get('user')
        if not user:
            raise GameError('Log in first.')
        email = storage.set_email(user['id'], data.get('email'))
        await send(ws, {'type': 'emailUpdated', 'email': email})
        await send(ws, {'type': 'infoMsg', 'message': 'Email saved.' if email else 'Email removed.'})
        return

    if mtype == 'requestEmailReset':
        # Respond generically to avoid revealing which accounts / emails exist.
        generic = 'If an account with that email exists, a reset link is on its way.'
        ident = (data.get('identifier') or '').strip()
        target = storage.get_by_email(ident) or storage.get_by_username(ident)
        if target:
            full = storage.get_by_id(target['id'])
            if full and full.get('email') and EMAIL_ENABLED:
                token = storage.create_reset_token(full['id'])
                link = f"{APP_BASE_URL}/reset.html?token={token}"
                await send_email(full['email'], 'Reset your Dutch password',
                                 f"Hi {full['username']},\n\nReset your password with this link (valid 1 hour):\n{link}\n\n"
                                 "If you didn't request this, you can ignore this email.")
        if not EMAIL_ENABLED:
            await send(ws, {'type': 'infoMsg', 'message': 'Email isn’t set up on this server yet — use your recovery code instead.'})
        else:
            await send(ws, {'type': 'infoMsg', 'message': generic})
        return

    if mtype == 'resetPassword':
        uid = storage.consume_reset_token(data.get('token'))
        if not uid:
            raise GameError('That reset link is invalid or has expired.')
        storage.set_password(uid, data.get('newPassword') or '')
        await send(ws, {'type': 'resetDone'})
        return

    if mtype == 'getLeaderboard':
        board = await asyncio.to_thread(storage.get_leaderboard, 10)
        me = ctx.get('user')
        my_stats = await asyncio.to_thread(storage.get_stats, me['id']) if me else None
        history = await asyncio.to_thread(storage.get_history, me['id'], 15) if me else None
        achievements = await asyncio.to_thread(storage.get_achievements, me['id']) if me else None
        await send(ws, {'type': 'leaderboard', 'board': board, 'myStats': my_stats,
                        'myUsername': me['username'] if me else None, 'history': history,
                        'achievements': achievements})
        return

    if mtype == 'getPublicRooms':
        # Every casual lobby that hasn't started and has room is publicly joinable.
        out = []
        for c, r in rooms.items():
            if r.game is None and not r.ranked and 0 < len(r.players) < 8:
                host = (r.players.get(r.host_id) or {}).get('name') or 'Host'
                out.append({'code': c, 'host': host, 'players': len(r.players), 'max': 8})
        out.sort(key=lambda x: x['players'], reverse=True)
        await send(ws, {'type': 'publicRooms', 'rooms': out})
        return

    if mtype == 'getProfile':
        target = await asyncio.to_thread(storage.get_by_username, data.get('username'))
        if not target:
            raise GameError('No player with that name.')
        stats = await asyncio.to_thread(storage.get_stats, target['id'])
        achievements = await asyncio.to_thread(storage.get_achievements, target['id'])
        full = await asyncio.to_thread(storage.get_by_id, target['id'])
        await send(ws, {'type': 'profile', 'username': target['username'], 'stats': stats,
                        'achievements': achievements, 'emblem': (full or {}).get('emblem', 'default')})
        return

    if mtype == 'friendRequest':
        user = ctx.get('user')
        if not user:
            raise GameError('Claim a username first.')
        target = storage.get_by_username(data.get('username'))
        if not target:
            raise GameError('No player with that username.')
        result = storage.request_friend(user['id'], target['id'])
        await push_friends(user['id'])
        await push_friends(target['id'])
        await send(ws, {'type': 'infoMsg',
                        'message': 'You are now friends!' if result == 'accepted' else f"Request sent to {target['username']}."})
        return

    if mtype == 'friendRespond':
        user = ctx.get('user')
        if not user:
            raise GameError('Claim a username first.')
        storage.respond_friend(user['id'], data.get('userId'), bool(data.get('accept')))
        await push_friends(user['id'])
        await push_friends(data.get('userId'))
        return

    if mtype == 'friendRemove':
        user = ctx.get('user')
        if not user:
            raise GameError('Claim a username first.')
        storage.remove_relation(user['id'], data.get('userId'))
        await push_friends(user['id'])
        await push_friends(data.get('userId'))
        return

    if mtype == 'inviteFriend':
        user = ctx.get('user')
        if not user:
            raise GameError('Claim a username first.')
        room = rooms.get(ctx['code'])
        if not room or room.game is not None:
            raise GameError('You can only invite friends from a game lobby.')
        rel = storage.relations_of(user['id'])
        target_id = data.get('userId')
        if not any(f['id'] == target_id for f in rel['friends']):
            raise GameError('You can only invite your friends.')
        target_conns = ONLINE.get(target_id)
        if not target_conns:
            raise GameError('That friend is not online right now.')
        for tws in list(target_conns):
            await send(tws, {'type': 'gameInvite', 'fromUsername': user['username'], 'code': room.code})
        await send(ws, {'type': 'infoMsg', 'message': 'Invite sent!'})
        return

    acct_id = ctx['user']['id'] if ctx.get('user') else None

    if mtype == 'createRoom':
        name = clean_name(data.get('name'))
        ranked = bool(data.get('ranked'))
        if ranked and not acct_id:
            raise GameError('Log in to play ranked games.')
        code = new_code()
        room = Room(code)
        room.ranked = ranked
        pid, token = new_id(), new_token()
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True, 'account_id': acct_id,
                             'card_back': (ctx.get('user') or {}).get('card_back', 'classic'),
                             'emblem': (ctx.get('user') or {}).get('emblem', 'default')}
        room.host_id = pid
        rooms[code] = room
        ctx['code'], ctx['player_id'] = code, pid
        await send(ws, {'type': 'youAre', 'playerId': pid, 'token': token, 'code': code})
        await broadcast_state(room)
        return

    if mtype == 'quickPlay':
        # One-tap solo game: new room, three bots of mixed skill, dealt at once.
        name = clean_name(data.get('name'))
        code = new_code()
        room = Room(code)
        pid, token = new_id(), new_token()
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True, 'account_id': acct_id,
                             'card_back': (ctx.get('user') or {}).get('card_back', 'classic'),
                             'emblem': (ctx.get('user') or {}).get('emblem', 'default')}
        room.host_id = pid
        rooms[code] = room
        ctx['code'], ctx['player_id'] = code, pid
        for diff in ('easy', 'medium', 'hard'):
            bot_id = new_id()
            bname = bots.pick_bot_name([p['name'] for p in room.players.values()])
            room.players[bot_id] = {'name': bname, 'token': None, 'ws': None,
                                    'connected': True, 'is_bot': True, 'difficulty': diff}
        await send(ws, {'type': 'youAre', 'playerId': pid, 'token': token, 'code': code})
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names, room.settings)
        room.stats_recorded = False
        room.reveal_scheduled = False
        for p in room.players.values():
            p['play_correct'] = 0
            p['play_total'] = 0
            p['shed'] = 0
            p['powers'] = 0
        bots.init_brains(room)
        room.deal_seq += 1
        start_monitor(room)
        await broadcast_state(room)
        return

    if mtype == 'joinRoom':
        code = (data.get('code') or '').strip().upper()
        room = rooms.get(code)
        if not room:
            raise GameError('Room not found. Check the code and try again.')
        if room.game is not None:
            raise GameError('That game has already started.')
        if room.ranked and not acct_id:
            raise GameError('Log in to join a ranked game.')
        if room.ranked and len(room.players) >= 2:
            raise GameError('Ranked games are 1v1 — this room is full.')
        if len(room.players) >= 8:
            raise GameError('That room is full.')
        name = clean_name(data.get('name'))
        pid, token = new_id(), new_token()
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True, 'account_id': acct_id,
                             'card_back': (ctx.get('user') or {}).get('card_back', 'classic'),
                             'emblem': (ctx.get('user') or {}).get('emblem', 'default')}
        ctx['code'], ctx['player_id'] = code, pid
        await send(ws, {'type': 'youAre', 'playerId': pid, 'token': token, 'code': code})
        await broadcast_state(room)
        return

    if mtype == 'rejoin':
        code = (data.get('code') or '').strip().upper()
        token = data.get('token')
        room = rooms.get(code)
        if not room:
            raise GameError('That room no longer exists.')
        found_pid = None
        for pid, p in room.players.items():
            if p['token'] == token:
                found_pid = pid
                break
        if not found_pid:
            raise GameError('Could not reconnect to that game.')
        room.players[found_pid]['ws'] = ws
        room.players[found_pid]['connected'] = True
        ctx['code'], ctx['player_id'] = code, found_pid
        await send(ws, {'type': 'youAre', 'playerId': found_pid, 'token': token, 'code': code})
        await broadcast_state(room)
        return

    # everything below requires an established room/player
    room = rooms.get(ctx['code'])
    pid = ctx['player_id']
    if not room or pid not in room.players:
        raise GameError('You are not in a room.')

    if mtype == 'leaveRoom':
        code = ctx['code']
        if room.game is not None and room.game.phase != 'reveal':
            # Mid-game: hand the seat to an easy bot so the round continues for others.
            p = room.players[pid]
            p['is_bot'] = True
            p['difficulty'] = 'easy'
            p['left'] = True
            p['ws'] = None
            p['connected'] = True
            p['account_id'] = None
            room.brains.setdefault(pid, bots.Brain())
        else:
            del room.players[pid]
            room.brains.pop(pid, None)
        if room.host_id == pid:
            _reassign_host(room)
        ctx['code'], ctx['player_id'] = None, None
        await send(ws, {'type': 'leftRoom'})
        if not _humans(room):
            rooms.pop(code, None)  # nobody left to play — abandon the room
        else:
            await broadcast_state(room)
            schedule_bots(room)
        return

    if mtype == 'addBot':
        if pid != room.host_id:
            raise GameError('Only the host can add bots.')
        if room.ranked:
            raise GameError('Ranked games are 1v1 — no bots.')
        if room.game is not None:
            raise GameError('Add bots before the game starts.')
        if len(room.players) >= 8:
            raise GameError('That room is full.')
        difficulty = data.get('difficulty')
        if difficulty not in bots.DIFFICULTIES:
            raise GameError('Unknown bot difficulty.')
        bot_id = new_id()
        name = bots.pick_bot_name([p['name'] for p in room.players.values()])
        room.players[bot_id] = {'name': name, 'token': None, 'ws': None,
                                'connected': True, 'is_bot': True, 'difficulty': difficulty}
        await broadcast_state(room)
        return

    if mtype == 'setSettings':
        if pid != room.host_id:
            raise GameError('Only the host can change settings.')
        if room.ranked:
            raise GameError('Ranked games use standard rules.')
        if room.game is not None:
            raise GameError('Change settings before the game starts.')
        s = data.get('settings') or {}
        if 'cardsPer' in s:
            room.settings['cardsPer'] = max(2, min(6, int(s['cardsPer'])))
        if 'bufferSeconds' in s:
            room.settings['bufferSeconds'] = max(0, min(6, float(s['bufferSeconds'])))
        if 'matching' in s:
            room.settings['matching'] = bool(s['matching'])
        if 'turnLimit' in s:
            room.settings['turnLimit'] = max(0, min(120, int(s['turnLimit'])))
        if 'powers' in s:
            room.settings['powers'] = 'full' if s['powers'] == 'full' else 'basic'
        await broadcast_state(room)
        return

    if mtype == 'emote':
        emoji = (data.get('emoji') or '')[:4]
        allowed = {'👍', '😂', '😮', '🎉', '😎', '😢', '🔥', '🤔'}
        if emoji in allowed:
            for other in room.players.values():
                if other.get('ws') is not None:
                    await send(other['ws'], {'type': 'emote', 'playerId': pid, 'emoji': emoji})
        return

    if mtype == 'chat':
        text = (data.get('text') or '').strip()[:200]
        if text:
            now = time.time()
            ct = ctx['chat_times']
            ct[:] = [t for t in ct if now - t < CHAT_WINDOW]
            if len(ct) >= CHAT_MAX:
                raise GameError('You are sending messages too fast — slow down a moment.')
            ct.append(now)
            payload = {'type': 'chat', 'playerId': pid, 'name': room.players[pid]['name'], 'text': text}
            for other in room.players.values():
                if other.get('ws') is not None:
                    await send(other['ws'], payload)
        return

    if mtype == 'removeBot':
        if pid != room.host_id:
            raise GameError('Only the host can remove bots.')
        if room.game is not None:
            raise GameError('Cannot remove bots mid-game.')
        bot_id = data.get('botId')
        b = room.players.get(bot_id)
        if not b or not b.get('is_bot'):
            raise GameError('No such bot.')
        del room.players[bot_id]
        await broadcast_state(room)
        return

    if mtype == 'startGame':
        if pid != room.host_id:
            raise GameError('Only the host can start the game.')
        if room.game is not None:
            raise GameError('Game already started.')
        if len(room.players) < 2:
            raise GameError('Need at least 2 players to start.')
        if room.ranked:
            if len(room.players) != 2:
                raise GameError('Ranked games need exactly 2 players.')
            if not all(p.get('account_id') and not p.get('is_bot') for p in room.players.values()):
                raise GameError('Both players must be logged in for a ranked game.')
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names, room.settings)
        room.stats_recorded = False
        room.reveal_scheduled = False
        for p in room.players.values():
            p['play_correct'] = 0
            p['play_total'] = 0
            p['shed'] = 0
            p['powers'] = 0
        bots.init_brains(room)
        room.deal_seq += 1
        start_monitor(room)
        await broadcast_state(room)
        return

    if mtype == 'playAgain':
        if pid != room.host_id:
            raise GameError('Only the host can start a new round.')
        if room.game is None or room.game.phase != 'reveal':
            raise GameError('Round is not over yet.')
        if data.get('reset'):                 # "New match" — clear the running standings
            room.series = {}
            room.rounds_played = 0
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names, room.settings)
        room.stats_recorded = False
        room.reveal_scheduled = False
        for p in room.players.values():
            p['play_correct'] = 0
            p['play_total'] = 0
            p['shed'] = 0
            p['powers'] = 0
        bots.init_brains(room)
        room.deal_seq += 1
        start_monitor(room)
        await broadcast_state(room)
        return

    game = room.game
    if game is None:
        raise GameError('Game has not started.')

    if mtype == 'choosePeekCount':
        game.choose_peek_count(pid, int(data.get('count', -1)))
        await broadcast_state(room)
        return

    if mtype == 'peekCard':
        cell = int(data.get('cellIndex', -1))
        card = game.peek_card(pid, cell)
        bots.record_private_peek(room, pid, pid, cell, card)
        await send(ws, {'type': 'privateReveal', 'context': 'peek', 'card': card, 'cellIndex': cell})
        await broadcast_state(room)
        return

    if mtype == 'donePeeking':
        game.done_peeking(pid)
        await broadcast_state(room)
        return

    if mtype == 'flip':
        _score_play(room, game, pid, ('flip',))
        game.flip(pid)
        await broadcast_state(room)
        return

    if mtype == 'swapCell':
        cell = int(data.get('cellIndex', -1))
        _score_play(room, game, pid, ('swap', cell))
        game.swap_cell(pid, cell)
        bots.record_placement(room, game, pid, cell)
        await broadcast_state(room)
        return

    if mtype == 'claimMatch':
        game.claim_match(pid)
        deadline = game.matcher_deadline
        await broadcast_state(room)
        asyncio.create_task(expire_match(room, deadline))
        return

    if mtype == 'cancelMatch':
        game.cancel_match(pid)
        await broadcast_state(room)
        return

    if mtype == 'matchCard':
        cell = int(data.get('cellIndex', -1))
        brain = room.brains.get(pid)
        knew = bool(brain and (pid, cell) in brain.known)
        res = game.match_card(pid, cell)
        if res.get('matched'):
            bots.record_removal(room, pid, res['cellIndex'])
            _bump(room, pid, 'shed')
        _count_play(room, pid, bool(res.get('matched') and knew))
        await broadcast_state(room)
        return

    if mtype == 'endTurn':
        if game.phase == 'playing' and game.turn_mode == 'endOfTurn' and game.current_player() == pid:
            _count_play(room, pid, bots.judge_dutch(room, game, pid, False))
        game.end_turn(pid)
        await broadcast_state(room)
        return

    if mtype == 'callDutch':
        if game.phase == 'playing' and game.turn_mode == 'endOfTurn' and game.current_player() == pid and not game.final_round:
            _count_play(room, pid, bots.judge_dutch(room, game, pid, True))
        game.call_dutch(pid)
        await broadcast_state(room)
        return

    if mtype == 'jackSelect':
        tp = data.get('targetPlayerId')
        tc = int(data.get('targetCellIndex', -1))
        first = game.jack_first
        # Judge the completing selection using pre-swap state.
        judge_correct = None
        if (game.turn_mode == 'jackSwap' and game.current_player() == pid and first is not None
                and not (first['playerId'] == tp and first['cellIndex'] == tc)
                and tp in game.grids and 0 <= tc < len(game.grids[tp])):
            judge_correct = bots.judge_jack(room, game, pid, (first['playerId'], first['cellIndex']), (tp, tc))
        res = game.jack_select(pid, tp, tc)
        if res:
            bots.record_table_swap(room, res[0], res[1])
            _bump(room, pid, 'powers')
            if judge_correct is not None:
                _count_play(room, pid, judge_correct)
        await broadcast_state(room)
        return

    if mtype == 'queenSelect':
        target_player = data.get('targetPlayerId')
        target_cell = int(data.get('targetCellIndex', -1))
        if game.turn_mode == 'queenPeek' and game.current_player() == pid:
            _count_play(room, pid, bots.judge_queen(room, game, pid, target_player, target_cell))
        card = game.queen_select(pid, target_player, target_cell)
        _bump(room, pid, 'powers')
        bots.record_private_peek(room, pid, target_player, target_cell, card)
        await send(ws, {'type': 'privateReveal', 'context': 'queen', 'card': card,
                         'targetPlayerId': target_player, 'cellIndex': target_cell})
        await broadcast_state(room)
        return

    if mtype == 'peekSelfSelect':
        cell = int(data.get('cellIndex', -1))
        card = game.peek_self_select(pid, cell)
        _bump(room, pid, 'powers')
        bots.record_private_peek(room, pid, pid, cell, card)
        await send(ws, {'type': 'privateReveal', 'context': 'peek', 'card': card, 'cellIndex': cell})
        await broadcast_state(room)
        return

    if mtype == 'peekOtherSelect':
        target_player = data.get('targetPlayerId')
        target_cell = int(data.get('targetCellIndex', -1))
        card = game.peek_other_select(pid, target_player, target_cell)
        _bump(room, pid, 'powers')
        bots.record_private_peek(room, pid, target_player, target_cell, card)
        await send(ws, {'type': 'privateReveal', 'context': 'peekOther', 'card': card,
                         'targetPlayerId': target_player, 'cellIndex': target_cell})
        await broadcast_state(room)
        return

    if mtype == 'aceGiveTo':
        if game.turn_mode == 'aceGive' and game.current_player() == pid:
            _count_play(room, pid, bots.judge_ace(room, game, pid, data.get('targetPlayerId')))
        game.ace_give(pid, data.get('targetPlayerId'))
        _bump(room, pid, 'powers')
        await broadcast_state(room)
        return

    raise GameError(f'Unknown action: {mtype}')


@web.middleware
async def no_cache(request, handler):
    resp = await handler(request)
    # Frequently-updated static assets should always revalidate so players
    # never get a stale UI after a deploy.
    if request.path == '/' or request.path.endswith(('.html', '.css', '.js')):
        resp.headers['Cache-Control'] = 'no-cache'
    return resp


def make_app():
    storage.init_db()
    # Log the active storage backend so persistence is verifiable from the deploy logs.
    if storage.USE_PG:
        print('[dutch] storage backend: postgres (persistent)', flush=True)
    else:
        print('[dutch] storage backend: sqlite at %s '
              '(EPHEMERAL on Render — accounts/stats reset on every redeploy; '
              'set DATABASE_URL to use Postgres)' % storage.DB_PATH, flush=True)
    app = web.Application(middlewares=[no_cache])
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/', handle_index)
    app.router.add_static('/', path=PUBLIC_DIR, show_index=False)
    return app


if __name__ == '__main__':
    web.run_app(make_app(), host='0.0.0.0', port=int(os.environ.get('PORT', 8743)))
