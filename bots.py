"""AI opponents for Dutch, at four difficulty tiers.

The server drives bots: when the game is waiting on a bot (to choose a peek
count, peek, take a turn, resolve a power, or end/call Dutch), it calls
take_action(), which computes ONE step and applies it through the normal Game
methods. The Game engine itself has no idea which players are bots.

Knowledge model — each bot keeps a `Brain` of cards it legitimately knows:
its own initial peeks, cards it swapped in (public), and its own Queen peeks.
Knowledge follows cards through Jack swaps. Unknown cards are estimated at the
deck average (6.5). The 'impossible' bot ignores the Brain and reads the real
grids (omniscient) and plays to lock in a win.
"""

import random

UNKNOWN_EST = 6.5  # average card value across the 52-card deck under our scoring

BOT_NAME_POOL = [
    'Ada', 'Boole', 'Cauchy', 'Dijkstra', 'Euler', 'Fermat', 'Gauss', 'Hopper',
    'Ivarr', 'Jinx', 'Knuth', 'Lovelace', 'Minsky', 'Newton', 'Ohm', 'Pascal',
    'Ramanujan', 'Shannon', 'Turing', 'Volta', 'Wozniak', 'Xara', 'Yates', 'Zuse',
]

DIFFICULTIES = ('easy', 'medium', 'hard', 'impossible')


class Brain:
    def __init__(self):
        self.known = {}  # (owner_id, cell_index) -> card dict


def pick_bot_name(taken_names):
    taken = {n.lower() for n in taken_names}
    choices = [n for n in BOT_NAME_POOL if n.lower() not in taken]
    if not choices:
        return 'Bot' + str(random.randint(100, 999))
    return random.choice(choices)


def init_brains(room):
    # Every player (human and bot) gets a knowledge model. Bots use it to play;
    # for humans it's used to judge how "theoretically correct" their plays are.
    room.brains = {pid: Brain() for pid in room.players}


def _brains(room):
    return getattr(room, 'brains', {}) or {}


def record_private_peek(room, viewer_id, owner_id, cell, card):
    """A player privately learned a specific card (initial peek or Queen peek)."""
    b = _brains(room).get(viewer_id)
    if b is not None and card is not None:
        b.known[(owner_id, cell)] = card


def judge_main_play(room, game, player_id, actual):
    """Was this flip/swap the value-maximizing move given the player's knowledge?

    `actual` is ('flip',) or ('swap', cell_index). The reference play (using only
    what the player legitimately knows, unknowns estimated at the deck average):
    swap your highest-value card for the discard when that lowers your expected
    total, otherwise flip. Ties among equal-highest cells all count as correct.
    """
    brain = _brains(room).get(player_id) or Brain()
    discard = game.discard[-1] if game.discard else None
    if discard is None:
        return actual[0] == 'flip'
    D = discard['value']
    n = len(game.grids[player_id])
    vals = [_est_cell(brain, game, player_id, i, False) for i in range(n)]
    best_v = max(vals)
    if best_v > D:  # swapping the worst card is a positive-expected-value move
        best_cells = {i for i, v in enumerate(vals) if v == best_v}
        return actual[0] == 'swap' and actual[1] in best_cells
    return actual[0] == 'flip'


def judge_jack(room, game, player_id, la, lb):
    """Optimal Jack: dump your highest card onto an opponent, take their lowest."""
    brain = _brains(room).get(player_id) or Brain()
    own_vals = [_est_cell(brain, game, player_id, i, False) for i in range(len(game.grids[player_id]))]
    own_max = max(own_vals) if own_vals else 0
    opp_cells = [(p, i) for p in game.order if p != player_id for i in range(len(game.grids[p]))]
    if not opp_cells:
        return True
    opp_min = min(_est_cell(brain, game, p, i, False) for p, i in opp_cells)
    if own_max <= opp_min:
        return True  # no beneficial cross-swap exists; don't penalize
    best_own = {(player_id, i) for i, v in enumerate(own_vals) if v == own_max}
    best_opp = {(p, i) for p, i in opp_cells if _est_cell(brain, game, p, i, False) == opp_min}
    return (la in best_own and lb in best_opp) or (lb in best_own and la in best_opp)


def judge_queen(room, game, player_id, owner, cell):
    """Optimal Queen: peek a card you don't already know (peeking a known card wastes it)."""
    brain = _brains(room).get(player_id) or Brain()
    return (owner, cell) not in brain.known


def judge_ace(room, game, player_id, target):
    """Optimal Ace: burden the opponent currently doing best (lowest estimated total)."""
    brain = _brains(room).get(player_id) or Brain()
    opps = _opponents(game, player_id)
    if not opps:
        return True
    lo = min(_est_total(brain, game, p, False) for p in opps)
    return target in {p for p in opps if _est_total(brain, game, p, False) == lo}


def judge_dutch(room, game, player_id, called):
    """Was calling / not calling Dutch reasonable given the player's knowledge?
    Reference: call only with a confident, genuinely low hand that leads the table."""
    brain = _brains(room).get(player_id) or Brain()
    n = len(game.grids[player_id])
    own = _est_total(brain, game, player_id, False)
    known_ct = sum(1 for i in range(n) if (player_id, i) in brain.known)
    opps = _opponents(game, player_id)
    min_opp = min((_est_total(brain, game, p, False) for p in opps), default=999)
    should_call = known_ct >= n - 1 and own <= min_opp and own <= 12
    return called == should_call


# ---- knowledge updates (called by the server for ANY player's action) ----

def record_placement(room, game, owner, cell):
    """A card was swapped face-up into (owner, cell) — public, so all bots learn it."""
    if 0 <= cell < len(game.grids.get(owner, [])):
        card = game.grids[owner][cell]
        for b in _brains(room).values():
            b.known[(owner, cell)] = card


def record_table_swap(room, la, lb):
    """Two cells were blind-swapped; move each bot's knowledge along with the cards."""
    for b in _brains(room).values():
        a = b.known.get(la)
        c = b.known.get(lb)
        if a is not None:
            b.known[lb] = a
        else:
            b.known.pop(lb, None)
        if c is not None:
            b.known[la] = c
        else:
            b.known.pop(la, None)


def record_removal(room, owner, removed_index):
    """A card left `owner`'s grid (matched away); shift knowledge of higher indices down."""
    for b in _brains(room).values():
        shifted = {}
        for (o, i), card in b.known.items():
            if o != owner or i < removed_index:
                shifted[(o, i)] = card
            elif i == removed_index:
                continue
            else:
                shifted[(o, i - 1)] = card
        b.known = shifted


# ---- estimation helpers ----

def _est_cell(brain, game, owner, cell, omni):
    if omni:
        return game.grids[owner][cell]['value']
    c = brain.known.get((owner, cell))
    return c['value'] if c else UNKNOWN_EST


def _est_total(brain, game, owner, omni):
    return sum(_est_cell(brain, game, owner, i, omni) for i in range(len(game.grids[owner])))


def _opponents(game, bot_id):
    return [p for p in game.order if p != bot_id]


def required_actor(game):
    """Which player id the game is currently waiting on (or None)."""
    if game is None:
        return None
    if game.phase == 'choosePeekCount':
        return game.peek_chooser
    if game.phase == 'peeking':
        return game.peeking_player()
    if game.phase == 'playing':
        # A pending power is resolved by its actor — usually the current player,
        # but a matcher (possibly off-turn) resolves a power they matched.
        if game.turn_mode in ('jackSwap', 'queenPeek', 'aceGive') and game.power_actor:
            return game.power_actor
        return game.current_player()
    return None


# ---- the one-step driver ----

def take_action(room, game, bot_id):
    brain = _brains(room).get(bot_id) or Brain()
    diff = room.players[bot_id].get('difficulty', 'medium')
    omni = diff == 'impossible'

    if game.phase == 'choosePeekCount':
        _choose_peek(game, bot_id, diff)
        return
    if game.phase == 'peeking':
        _do_peek(game, bot_id, brain)
        return

    tm = game.turn_mode
    if tm == 'awaitingAction':
        # First drop any card we know matches the discard top (fewer cards = better).
        if diff != 'easy' and _try_match(room, game, bot_id, brain, omni):
            return 'acted'
        if not game.can_act_now():
            return 'wait'  # respect the match buffer; the driver will retry
        _act(room, game, bot_id, brain, diff, omni)
    elif tm == 'jackSwap':
        _resolve_jack(room, game, bot_id, brain, diff, omni)
    elif tm == 'queenPeek':
        _resolve_queen(game, bot_id, brain, diff, omni)
    elif tm == 'aceGive':
        _resolve_ace(game, bot_id, brain, diff, omni)
    elif tm == 'endOfTurn':
        _end_or_dutch(game, bot_id, brain, diff, omni)
    return 'acted'


def _try_match(room, game, bot_id, brain, omni):
    """If the bot knows a grid card of the discard top's rank, drop it. Returns True if it did."""
    if not game.discard:
        return False
    top_rank = game.discard[-1]['rank']
    for i in range(len(game.grids[bot_id])):
        card = game.grids[bot_id][i] if omni else brain.known.get((bot_id, i))
        if card and card['rank'] == top_rank:
            res = game.match_card(bot_id, i)
            if res.get('matched'):
                record_removal(room, bot_id, i)
            return True
    return False


def _choose_peek(game, bot_id, diff):
    if diff == 'easy':
        n = random.randint(0, 4)
    elif diff == 'impossible':
        n = 0  # deny everyone info; it sees all cards anyway
    else:
        n = 2
    game.choose_peek_count(bot_id, n)


def _do_peek(game, bot_id, brain):
    need = game.peek_count
    grid = game.grids[bot_id]
    for i in range(len(grid)):
        if len(game.peeked_cells) >= need:
            break
        if i in game.peeked_cells:
            continue
        card = game.peek_card(bot_id, i)
        brain.known[(bot_id, i)] = card
    game.done_peeking(bot_id)


def _highest_own(brain, game, bot_id, omni):
    best_i, best_v = 0, -1
    for i in range(len(game.grids[bot_id])):
        v = _est_cell(brain, game, bot_id, i, omni)
        if v > best_v:
            best_v, best_i = v, i
    return best_i, best_v


def _act(room, game, bot_id, brain, diff, omni):
    discard = game.discard[-1] if game.discard else None
    D = discard['value'] if discard else None
    n = len(game.grids[bot_id])
    best_i, best_v = _highest_own(brain, game, bot_id, omni)

    def do_swap(i):
        game.swap_cell(bot_id, i)
        record_placement(room, game, bot_id, i)

    if D is None:
        game.flip(bot_id)
        return

    if diff == 'easy':
        # only grabs obviously-low cards, and dumps them into a random slot
        if D <= 4:
            do_swap(random.randrange(n))
        else:
            game.flip(bot_id)
    elif diff in ('medium', 'hard'):
        if best_v - D >= 1:
            do_swap(best_i)
        else:
            game.flip(bot_id)
    else:  # impossible — swap on any real improvement
        if best_v - D > 0:
            do_swap(best_i)
        else:
            game.flip(bot_id)


def _resolve_jack(room, game, bot_id, brain, diff, omni):
    n = len(game.grids[bot_id])
    all_cells = [(p, i) for p in game.order for i in range(len(game.grids[p]))]

    if diff == 'easy':
        a = random.choice(all_cells)
        b = random.choice([c for c in all_cells if c != a])
        _do_jack(room, game, bot_id, a, b)
        return

    own_i, own_v = _highest_own(brain, game, bot_id, omni)
    opps = _opponents(game, bot_id)
    # lowest card held by an opponent
    opp_best, opp_best_v = None, 999
    for p in opps:
        for i in range(len(game.grids[p])):
            v = _est_cell(brain, game, p, i, omni)
            if v < opp_best_v:
                opp_best_v, opp_best = v, (p, i)

    if opp_best is not None and own_v > opp_best_v:
        # dump our worst card onto them, take their best — pure gain
        _do_jack(room, game, bot_id, (bot_id, own_i), opp_best)
        return

    # no beneficial cross-swap: pass by swapping two of our own cells (no total change)
    low_i, low_v = own_i, 999
    for i in range(n):
        v = _est_cell(brain, game, bot_id, i, omni)
        if v < low_v:
            low_v, low_i = v, i
    if low_i != own_i:
        _do_jack(room, game, bot_id, (bot_id, own_i), (bot_id, low_i))
    elif opp_best is not None:
        _do_jack(room, game, bot_id, (bot_id, own_i), opp_best)
    else:
        # degenerate: only one cell in the whole game; swap with any other cell
        other = next((c for c in all_cells if c != (bot_id, own_i)), None)
        if other:
            _do_jack(room, game, bot_id, (bot_id, own_i), other)


def _do_jack(room, game, bot_id, a, b):
    if a == b:
        return
    game.jack_select(bot_id, a[0], a[1])       # first pick
    res = game.jack_select(bot_id, b[0], b[1])  # completes the swap
    if res:
        record_table_swap(room, a, b)


def _resolve_queen(game, bot_id, brain, diff, omni):
    all_cells = [(p, i) for p in game.order for i in range(len(game.grids[p]))]
    target = None

    if omni:
        target = (bot_id, 0)  # gains no info; just resolve
    elif diff == 'easy':
        target = random.choice(all_cells)
    else:
        # first an unknown own cell, else an unknown cell of the current leader
        for i in range(len(game.grids[bot_id])):
            if (bot_id, i) not in brain.known:
                target = (bot_id, i)
                break
        if target is None:
            for p in sorted(_opponents(game, bot_id), key=lambda p: _est_total(brain, game, p, omni)):
                for i in range(len(game.grids[p])):
                    if (p, i) not in brain.known:
                        target = (p, i)
                        break
                if target:
                    break
        if target is None:
            target = (bot_id, 0)

    card = game.queen_select(bot_id, target[0], target[1])
    if not omni and card is not None:
        brain.known[target] = card


def _resolve_ace(game, bot_id, brain, diff, omni):
    opps = _opponents(game, bot_id)
    if not opps:
        target = bot_id
    elif diff == 'easy':
        target = random.choice(opps)
    else:
        # burden whoever is doing best (lowest estimated total)
        target = min(opps, key=lambda p: _est_total(brain, game, p, omni))
    game.ace_give(bot_id, target)


def _end_or_dutch(game, bot_id, brain, diff, omni):
    if game.final_round:
        game.end_turn(bot_id)
        return

    n = len(game.grids[bot_id])
    own = _est_total(brain, game, bot_id, omni)
    known_ct = sum(1 for i in range(n) if omni or (bot_id, i) in brain.known)
    opp_totals = [_est_total(brain, game, p, omni) for p in _opponents(game, bot_id)]
    min_opp = min(opp_totals) if opp_totals else 999
    late = game.turn_counter > 6 * max(1, len(game.order))

    if diff == 'easy':
        call = random.random() < (0.22 if late else 0.06)
    elif diff == 'medium':
        call = own <= 12 or (late and own <= 18)
    elif diff == 'hard':
        confident = known_ct >= n - 1
        call = (confident and own <= min_opp and own <= 16) or (late and own <= min_opp)
    else:  # impossible — exact totals; lock in the win the moment it's (tied-)lowest
        call = own <= min_opp

    if call:
        game.call_dutch(bot_id)
    else:
        game.end_turn(bot_id)
