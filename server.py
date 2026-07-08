import asyncio
import json
import os
import random
import secrets
import smtplib
import string
from email.message import EmailMessage

from aiohttp import web, WSMsgType

import bots
import storage
from game import Game, GameError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

CODE_ALPHABET = ''.join(c for c in string.ascii_uppercase if c not in 'IO')

# Seconds a bot "thinks" between steps, so humans can follow the action.
BOT_DELAY = 0.9

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
             'isBot': p.get('is_bot', False), 'difficulty': p.get('difficulty')}
            for pid, p in room.players.items()
        ],
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
        p['left'] = info.get('left', False)
    return state


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


async def record_game_if_needed(room):
    """Once a round reaches reveal, record stats for account-linked players."""
    game = room.game
    if game is None or game.phase != 'reveal' or room.stats_recorded:
        return
    room.stats_recorded = True
    totals = {pid: sum(c['value'] for c in grid) for pid, grid in game.grids.items()}
    if not totals:
        return
    min_total = min(totals.values())
    results = []
    for pid, total in totals.items():
        p = room.players.get(pid, {})
        acct = p.get('account_id')
        if acct:
            results.append({'user_id': acct, 'total': total, 'won': total == min_total,
                            'plays_correct': p.get('play_correct', 0), 'plays_total': p.get('play_total', 0)})
    if not results:
        return
    await asyncio.to_thread(storage.record_game, results)
    for r in results:
        stats = await asyncio.to_thread(storage.get_stats, r['user_id'])
        for w in list(ONLINE.get(r['user_id'], ())):
            await send(w, {'type': 'statsUpdate', 'stats': stats, 'won': r['won']})


async def broadcast_state(room):
    await record_game_if_needed(room)
    for pid, p in room.players.items():
        if p['ws'] is not None:
            await send(p['ws'], {'type': 'state', 'state': build_state(room, pid)})


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
    ctx['user'] = {'id': user['id'], 'username': user['username']}
    ONLINE.setdefault(user['id'], set()).add(ws)
    payload = {'type': 'identity', 'userId': user['id'], 'username': user['username'],
               'email': user.get('email')}
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
    ctx = {'code': None, 'player_id': None, 'user': None}

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
        created = storage.create_user(data.get('username'), data.get('password') or '', data.get('email'))
        secret = storage.create_session(created['id'])
        await set_online(ws, ctx, {'id': created['id'], 'username': created['username'],
                                   'email': data.get('email') or None,
                                   'secret': secret, 'recovery_code': created['recovery_code']})
        return

    if mtype == 'login':
        if ctx.get('user'):
            raise GameError('You are already signed in.')
        user = storage.verify_password(data.get('username'), data.get('password') or '')
        if not user:
            raise GameError('Wrong username or password.')
        secret = storage.create_session(user['id'])
        await set_online(ws, ctx, {**user, 'secret': secret})
        return

    if mtype == 'recover':
        if ctx.get('user'):
            raise GameError('You are already signed in.')
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
        await send(ws, {'type': 'leaderboard', 'board': board, 'myStats': my_stats,
                        'myUsername': me['username'] if me else None})
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
        code = new_code()
        room = Room(code)
        pid, token = new_id(), new_token()
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True, 'account_id': acct_id}
        room.host_id = pid
        rooms[code] = room
        ctx['code'], ctx['player_id'] = code, pid
        await send(ws, {'type': 'youAre', 'playerId': pid, 'token': token, 'code': code})
        await broadcast_state(room)
        return

    if mtype == 'joinRoom':
        code = (data.get('code') or '').strip().upper()
        room = rooms.get(code)
        if not room:
            raise GameError('Room not found. Check the code and try again.')
        if room.game is not None:
            raise GameError('That game has already started.')
        if len(room.players) >= 8:
            raise GameError('That room is full.')
        name = clean_name(data.get('name'))
        pid, token = new_id(), new_token()
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True, 'account_id': acct_id}
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
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names)
        room.stats_recorded = False
        for p in room.players.values():
            p['play_correct'] = 0
            p['play_total'] = 0
        bots.init_brains(room)
        await broadcast_state(room)
        return

    if mtype == 'playAgain':
        if pid != room.host_id:
            raise GameError('Only the host can start a new round.')
        if room.game is None or room.game.phase != 'reveal':
            raise GameError('Round is not over yet.')
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names)
        room.stats_recorded = False
        for p in room.players.values():
            p['play_correct'] = 0
            p['play_total'] = 0
        bots.init_brains(room)
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

    if mtype == 'matchCard':
        cell = int(data.get('cellIndex', -1))
        brain = room.brains.get(pid)
        knew = bool(brain and (pid, cell) in brain.known)
        res = game.match_card(pid, cell)
        if res.get('matched'):
            bots.record_removal(room, pid, res['cellIndex'])
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
        bots.record_private_peek(room, pid, target_player, target_cell, card)
        await send(ws, {'type': 'privateReveal', 'context': 'queen', 'card': card,
                         'targetPlayerId': target_player, 'cellIndex': target_cell})
        await broadcast_state(room)
        return

    if mtype == 'aceGiveTo':
        if game.turn_mode == 'aceGive' and game.current_player() == pid:
            _count_play(room, pid, bots.judge_ace(room, game, pid, data.get('targetPlayerId')))
        game.ace_give(pid, data.get('targetPlayerId'))
        await broadcast_state(room)
        return

    raise GameError(f'Unknown action: {mtype}')


def make_app():
    storage.init_db()
    app = web.Application()
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/', handle_index)
    app.router.add_static('/', path=PUBLIC_DIR, show_index=False)
    return app


if __name__ == '__main__':
    web.run_app(make_app(), host='0.0.0.0', port=int(os.environ.get('PORT', 8743)))
