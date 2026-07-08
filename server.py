import json
import os
import random
import secrets
import string

from aiohttp import web, WSMsgType

from game import Game, GameError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

CODE_ALPHABET = ''.join(c for c in string.ascii_uppercase if c not in 'IO')


class Room:
    def __init__(self, code):
        self.code = code
        self.host_id = None
        # player_id -> {name, token, ws, connected}
        self.players = {}
        self.game = None

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
            {'id': pid, 'name': p['name'], 'connected': p['connected'], 'isYou': pid == viewer_id}
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
    connected = {pid: p['connected'] for pid, p in room.players.items()}
    for p in state['players']:
        p['connected'] = connected.get(p['id'], False)
    return state


async def broadcast_state(room):
    for pid, p in room.players.items():
        if p['ws'] is not None:
            await send(p['ws'], {'type': 'state', 'state': build_state(room, pid)})


async def handle_index(request):
    return web.FileResponse(os.path.join(PUBLIC_DIR, 'index.html'))


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)
    ctx = {'code': None, 'player_id': None}

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
            except GameError as e:
                await send(ws, {'type': 'errorMsg', 'message': str(e)})
    finally:
        room = rooms.get(ctx['code'])
        if room and ctx['player_id'] in room.players:
            room.players[ctx['player_id']]['ws'] = None
            room.players[ctx['player_id']]['connected'] = False
            await broadcast_state(room)

    return ws


async def handle_message(ws, ctx, data):
    mtype = data.get('type')

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

    if mtype == 'startGame':
        if pid != room.host_id:
            raise GameError('Only the host can start the game.')
        if room.game is not None:
            raise GameError('Game already started.')
        if len(room.players) < 2:
            raise GameError('Need at least 2 players to start.')
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names)
        await broadcast_state(room)
        return

    if mtype == 'playAgain':
        if pid != room.host_id:
            raise GameError('Only the host can start a new round.')
        if room.game is None or room.game.phase != 'reveal':
            raise GameError('Round is not over yet.')
        names = {p_id: p['name'] for p_id, p in room.players.items()}
        room.game = Game(list(room.players.keys()), names)
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
        game.swap_cell(pid, int(data.get('cellIndex', -1)))
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
        game.jack_select(pid, data.get('targetPlayerId'), int(data.get('targetCellIndex', -1)))
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
    app = web.Application()
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/', handle_index)
    app.router.add_static('/', path=PUBLIC_DIR, show_index=False)
    return app


if __name__ == '__main__':
    web.run_app(make_app(), host='0.0.0.0', port=int(os.environ.get('PORT', 8743)))
