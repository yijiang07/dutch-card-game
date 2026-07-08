import asyncio
import json
import os
import random
import secrets
import string

from aiohttp import web, WSMsgType

import bots
import storage
from game import Game, GameError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

CODE_ALPHABET = ''.join(c for c in string.ascii_uppercase if c not in 'IO')

# Seconds a bot "thinks" between steps, so humans can follow the action.
BOT_DELAY = 0.9

# user_id -> set of live websockets for that signed-in user (presence)
ONLINE = {}


class Room:
    def __init__(self, code):
        self.code = code
        self.host_id = None
        # player_id -> {name, token, ws, connected, is_bot, difficulty}
        self.players = {}
        self.game = None
        self.bot_brains = {}
        self.bot_task_running = False

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
    return state


async def broadcast_state(room):
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
                bots.take_action(room, game, actor)
            except GameError:
                break
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
    ctx['user'] = user
    ONLINE.setdefault(user['id'], set()).add(ws)
    await send(ws, {'type': 'identity', 'userId': user['id'], 'username': user['username'],
                    **({'secret': user['secret']} if 'secret' in user else {})})
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
        # Either re-authenticate an existing identity, or claim a new username.
        if data.get('userId') and data.get('secret'):
            user = storage.verify_user(data['userId'], data['secret'])
            if user:
                await set_online(ws, ctx, user)
            else:
                await send(ws, {'type': 'identityFailed'})
            return
        if data.get('username'):
            if ctx.get('user'):
                raise GameError('You already have a username.')
            user = storage.create_user(data['username'])
            await set_online(ws, ctx, user)
            return
        raise GameError('Nothing to identify with.')

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

    if mtype == 'createRoom':
        name = clean_name(data.get('name'))
        code = new_code()
        room = Room(code)
        pid, token = new_id(), new_token()
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True}
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
        room.players[pid] = {'name': name, 'token': token, 'ws': ws, 'connected': True}
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
        card = game.peek_card(pid, int(data.get('cellIndex', -1)))
        await send(ws, {'type': 'privateReveal', 'context': 'peek', 'card': card, 'cellIndex': data.get('cellIndex')})
        await broadcast_state(room)
        return

    if mtype == 'donePeeking':
        game.done_peeking(pid)
        await broadcast_state(room)
        return

    if mtype == 'flip':
        game.flip(pid)
        await broadcast_state(room)
        return

    if mtype == 'swapCell':
        cell = int(data.get('cellIndex', -1))
        game.swap_cell(pid, cell)
        bots.record_placement(room, game, pid, cell)
        await broadcast_state(room)
        return

    if mtype == 'endTurn':
        game.end_turn(pid)
        await broadcast_state(room)
        return

    if mtype == 'callDutch':
        game.call_dutch(pid)
        await broadcast_state(room)
        return

    if mtype == 'jackSelect':
        res = game.jack_select(pid, data.get('targetPlayerId'), int(data.get('targetCellIndex', -1)))
        if res:
            bots.record_table_swap(room, res[0], res[1])
        await broadcast_state(room)
        return

    if mtype == 'queenSelect':
        target_player = data.get('targetPlayerId')
        target_cell = int(data.get('targetCellIndex', -1))
        card = game.queen_select(pid, target_player, target_cell)
        await send(ws, {'type': 'privateReveal', 'context': 'queen', 'card': card,
                         'targetPlayerId': target_player, 'cellIndex': target_cell})
        await broadcast_state(room)
        return

    if mtype == 'aceGiveTo':
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
