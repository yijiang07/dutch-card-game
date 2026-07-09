"""Server-authoritative rules engine for Dutch. No networking here — server.py
owns connections and calls into this module, which just mutates a Game object."""

import random
import time

RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
SUITS = ['S', 'H', 'D', 'C']
RED_SUITS = {'H', 'D'}
SUIT_SYMBOL = {'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣'}

# On turn start, the active player must wait this long before flipping/swapping,
# giving everyone a window to "match" the current discard card.
BUFFER_SECONDS = 2.5

# Once a player declares a match, play pauses this long for them to pick a card.
MATCH_CLAIM_SECONDS = 6

# After the final turn of a round (someone called Dutch), hold this long so
# players can still match the last discard before cards are revealed.
FINAL_MATCH_GRACE = 2.5


class GameError(Exception):
    pass


def card_value(rank, suit):
    if rank == 'A':
        return 1
    if rank == 'J':
        return 11
    if rank == 'Q':
        return 12
    if rank == 'K':
        return 0 if suit in RED_SUITS else 13
    return int(rank)


def make_card(rank, suit):
    return {'rank': rank, 'suit': suit, 'value': card_value(rank, suit)}


def make_deck():
    deck = [make_card(r, s) for s in SUITS for r in RANKS]
    random.shuffle(deck)
    return deck


def card_label(card):
    return f"{card['rank']}{SUIT_SYMBOL[card['suit']]}"


class Game:
    def __init__(self, player_ids, names_by_id, settings=None):
        self.order = list(player_ids)
        self.names = dict(names_by_id)

        s = settings or {}
        self.cards_per = max(2, min(6, int(s.get('cardsPer', 4))))
        self.buffer_seconds = max(0, float(s.get('bufferSeconds', BUFFER_SECONDS)))
        self.matching_enabled = bool(s.get('matching', True))
        self.turn_limit = max(0, int(s.get('turnLimit', 30)))

        deck = make_deck()
        self.grids = {pid: [deck.pop() for _ in range(self.cards_per)] for pid in self.order}
        self.discard = [deck.pop()]
        self.deck = deck

        self.phase = 'choosePeekCount'
        self.peek_chooser = random.choice(self.order)
        self.peek_count = None
        self.peeking_index = 0
        self.peeked_cells = set()

        self.current_index = 0
        self.final_round = False
        self.dutch_caller = None
        self.final_round_remaining = 0

        self.turn_mode = 'awaitingAction'
        self.jack_first = None
        self.turn_counter = 0
        # Who resolves a pending power (J/Q/A). Usually the current player, but a
        # player who *matches* a power card resolves it themselves, even off-turn.
        self.power_actor = None
        # When a matched power interrupts a turn, the turn_mode to restore afterward.
        self.power_return_mode = None
        # End-of-round match grace: after the last final-round turn, play stays open
        # for matching until end_at, then the server reveals.
        self.ending = False
        self.end_at = 0.0

        # Most recent discard-swap / match / flip / power, so clients can animate them.
        self.last_swap = None
        self.last_match = None
        self.last_flip = None
        self.last_jack = None
        self.last_queen = None
        self.last_ace = None
        self.action_seq = 0
        self.turn_started_at = 0.0
        # Match lock: while set, play is paused for everyone until it resolves.
        self.matcher = None
        self.matcher_deadline = 0.0

        self.log = []

    # ---- helpers ----

    def _log(self, code, **params):
        # Structured log entry: {code, ...params}. The client localizes it.
        # Card/name params are passed as display strings (card symbols are universal).
        entry = {'code': code}
        entry.update(params)
        self.log.append(entry)
        if len(self.log) > 30:
            self.log.pop(0)

    def current_player(self):
        return self.order[self.current_index] if self.order else None

    def peeking_player(self):
        return self.order[self.peeking_index] if self.phase == 'peeking' else None

    def draw_one(self):
        if not self.deck:
            if len(self.discard) > 1:
                top = self.discard.pop()
                self.deck = self.discard
                random.shuffle(self.deck)
                self.discard = [top]
                self._log('reshuffle')
            else:
                return None
        if not self.deck:
            return None
        return self.deck.pop()

    def _advance_turn(self):
        self.turn_mode = 'awaitingAction'
        self.jack_first = None
        self.power_actor = None
        self.power_return_mode = None
        self.turn_counter += 1
        self.current_index = (self.current_index + 1) % len(self.order)
        self.turn_started_at = time.time()

    def can_act_now(self):
        """False during the post-turn-start buffer, when only matching is allowed."""
        return time.time() - self.turn_started_at >= self.buffer_seconds

    def _act_wait_ms(self):
        if self.phase != 'playing' or self.turn_mode != 'awaitingAction':
            return 0
        return max(0, int((self.buffer_seconds - (time.time() - self.turn_started_at)) * 1000))

    def _action_resolved(self):
        """Called once the turn's action (and any power) has fully resolved.
        Outside the final round the player still gets an end-of-turn choice:
        end the turn, or call Dutch. During the final round there is no choice
        to make, so the turn advances automatically."""
        self.jack_first = None
        if self.final_round:
            self.final_round_remaining -= 1
            if self.final_round_remaining <= 0:
                # Everyone has taken their last turn. Give a short window for a
                # final match before revealing (skipped if matching is off).
                if self.matching_enabled:
                    self.ending = True
                    self.turn_mode = 'awaitingMatch'
                    self.end_at = time.time() + FINAL_MATCH_GRACE
                else:
                    self.phase = 'reveal'
                return
            self._advance_turn()
        else:
            self.turn_mode = 'endOfTurn'

    def finish_round(self):
        """Called by the server once the end-of-round match grace elapses."""
        self.ending = False
        self.turn_mode = 'awaitingAction'
        self.phase = 'reveal'

    _POWER_MODE = {'J': 'jackSwap', 'Q': 'queenPeek', 'A': 'aceGive'}

    def _trigger_power_or_complete(self, card):
        """Flip / swap-discard: the current player resolves any power, then the
        turn completes normally."""
        mode = self._POWER_MODE.get(card['rank'])
        if mode:
            self.power_actor = self.current_player()
            self.power_return_mode = None
            self.jack_first = None
            self.turn_mode = mode
        else:
            self._action_resolved()

    def _trigger_match_power(self, matcher, card):
        """A matched power card fires its power for the matcher (who may be
        off-turn). The interrupted turn's mode is restored once it resolves."""
        mode = self._POWER_MODE.get(card['rank'])
        if not mode:
            return
        self.power_actor = matcher
        self.power_return_mode = self.turn_mode
        self.jack_first = None
        self.turn_mode = mode

    def _power_complete(self):
        """Finish a power. A match-triggered power restores the interrupted turn;
        a flip/swap power completes the turn normally."""
        self.jack_first = None
        self.power_actor = None
        if self.power_return_mode is not None:
            self.turn_mode = self.power_return_mode
            self.power_return_mode = None
        else:
            self._action_resolved()

    # ---- peek-count / peeking phase ----

    def choose_peek_count(self, sender, count):
        if self.phase != 'choosePeekCount':
            raise GameError('Not choosing a peek count right now.')
        if sender != self.peek_chooser:
            raise GameError("It's not your choice to make.")
        if not (0 <= count <= self.cards_per):
            raise GameError(f'Pick a number from 0 to {self.cards_per}.')
        self.peek_count = count
        if count == 0:
            self.phase = 'playing'
            self.turn_started_at = time.time()
        else:
            self.phase = 'peeking'
            self.peeking_index = 0
            self.peeked_cells = set()

    def peek_card(self, sender, cell_index):
        if self.phase != 'peeking':
            raise GameError('Not in the peeking phase.')
        if sender != self.peeking_player():
            raise GameError("It's not your turn to peek.")
        grid = self.grids[sender]
        if not (0 <= cell_index < len(grid)):
            raise GameError('Invalid card.')
        if cell_index in self.peeked_cells:
            return grid[cell_index]
        if len(self.peeked_cells) >= self.peek_count:
            raise GameError("You've already peeked at your allotted cards.")
        self.peeked_cells.add(cell_index)
        return grid[cell_index]

    def done_peeking(self, sender):
        if self.phase != 'peeking':
            raise GameError('Not in the peeking phase.')
        if sender != self.peeking_player():
            raise GameError("It's not your turn to peek.")
        if len(self.peeked_cells) < self.peek_count:
            raise GameError('Peek at your remaining cards first.')
        self.peeked_cells = set()
        self.peeking_index += 1
        if self.peeking_index >= len(self.order):
            self.phase = 'playing'
            self.turn_started_at = time.time()

    # ---- main turn actions ----

    def _ensure_no_matcher(self):
        if self.matcher is not None:
            raise GameError('Hold on — a player is matching.')

    def claim_match(self, sender):
        """Declare a match — freezes play for everyone until it resolves or times out."""
        if not self.matching_enabled:
            raise GameError('Matching is turned off in this game.')
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if self.turn_mode not in ('awaitingAction', 'endOfTurn', 'awaitingMatch'):
            raise GameError('You can only match between actions.')
        if not self.discard:
            raise GameError('Nothing to match.')
        if self.matcher is not None:
            raise GameError('Someone is already matching.')
        if sender not in self.grids:
            raise GameError('You are not in this game.')
        self.matcher = sender
        self.matcher_deadline = time.time() + MATCH_CLAIM_SECONDS
        self._log('matching', name=self.names[sender])

    def cancel_match(self, sender):
        if self.matcher == sender:
            self.matcher = None

    def flip(self, sender):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'awaitingAction':
            raise GameError('Resolve the current power first.')
        self._ensure_no_matcher()
        if not self.can_act_now():
            raise GameError('Hold on — players can still match the discard for a moment.')
        card = self.draw_one()
        if card is None:
            raise GameError('No cards left to draw.')
        self.discard.append(card)
        self.action_seq += 1
        self.last_flip = {'seq': self.action_seq, 'playerId': sender, 'card': card}
        self._log('flip', name=self.names[sender], card=card_label(card))
        self._trigger_power_or_complete(card)

    def match_card(self, sender, cell_index):
        """Drop a grid card of the discard top's rank (fewer cards is better).
        A wrong guess costs a penalty card. Allowed off-turn; resolves the match lock."""
        if not self.matching_enabled:
            raise GameError('Matching is turned off in this game.')
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if self.turn_mode not in ('awaitingAction', 'endOfTurn', 'awaitingMatch'):
            raise GameError('You can only match between actions.')
        if self.matcher is not None and self.matcher != sender:
            raise GameError('Another player is matching right now.')
        if not self.discard:
            raise GameError('Nothing to match.')
        grid = self.grids.get(sender)
        if grid is None or not (0 <= cell_index < len(grid)):
            raise GameError('Invalid card.')
        top = self.discard[-1]
        card = grid[cell_index]
        self.matcher = None  # match resolves (success or penalty) — release the lock
        self.action_seq += 1
        if card['rank'] == top['rank']:
            del grid[cell_index]
            self.discard.append(card)  # placed face-up — a power card fires for the matcher
            self.last_match = {'seq': self.action_seq, 'playerId': sender, 'cellIndex': cell_index,
                               'card': card, 'matched': True}
            self._log('matched', name=self.names[sender], card=card_label(card))
            if self.ending:
                # Final match grace: shed the card, extend the window a touch, but
                # don't fire its power (the round is over — no more turns).
                self.end_at = time.time() + FINAL_MATCH_GRACE
            else:
                self._trigger_match_power(sender, card)
            return {'matched': True, 'cellIndex': cell_index, 'card': card}
        penalty = self.draw_one()
        if penalty is not None:
            grid.append(penalty)
        self.last_match = {'seq': self.action_seq, 'playerId': sender, 'cellIndex': cell_index,
                           'card': card, 'matched': False}
        self._log('wrongMatch', name=self.names[sender], card=card_label(card))
        if self.ending:
            self.end_at = time.time() + FINAL_MATCH_GRACE
        return {'matched': False, 'cellIndex': cell_index, 'card': card}

    def swap_cell(self, sender, cell_index):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'awaitingAction':
            raise GameError('Resolve the current power first.')
        self._ensure_no_matcher()
        if not self.can_act_now():
            raise GameError('Hold on — players can still match the discard for a moment.')
        grid = self.grids[sender]
        if not (0 <= cell_index < len(grid)):
            raise GameError('Invalid card.')
        discard_top = self.discard.pop()
        old_card = grid[cell_index]
        grid[cell_index] = discard_top
        self.discard.append(old_card)
        self.action_seq += 1
        self.last_swap = {'seq': self.action_seq, 'playerId': sender, 'cellIndex': cell_index, 'card': discard_top}
        self._log('swap', name=self.names[sender], card=card_label(discard_top), old=card_label(old_card))
        self._trigger_power_or_complete(old_card)

    def end_turn(self, sender):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'endOfTurn':
            raise GameError('Play your turn first.')
        self._ensure_no_matcher()
        self._advance_turn()

    def call_dutch(self, sender):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'endOfTurn':
            raise GameError('Play your turn first — you call Dutch at the end of it.')
        self._ensure_no_matcher()
        if self.final_round:
            raise GameError('Dutch has already been called.')
        self.final_round = True
        self.dutch_caller = sender
        self.final_round_remaining = len(self.order) - 1
        self._log('dutch', name=self.names[sender])
        self._advance_turn()

    def jack_select(self, sender, target_player, target_cell):
        if self.turn_mode != 'jackSwap' or sender != self.power_actor:
            raise GameError('Not resolving a Jack right now.')
        if target_player not in self.grids or not (0 <= target_cell < len(self.grids[target_player])):
            raise GameError('Invalid card.')
        if self.jack_first is None:
            self.jack_first = {'playerId': target_player, 'cellIndex': target_cell}
            return None
        a = self.jack_first
        if a['playerId'] == target_player and a['cellIndex'] == target_cell:
            return None
        ga, gb = self.grids[a['playerId']], self.grids[target_player]
        ga[a['cellIndex']], gb[target_cell] = gb[target_cell], ga[a['cellIndex']]
        self._log('jack', name=self.names[sender])
        loc_a = (a['playerId'], a['cellIndex'])
        loc_b = (target_player, target_cell)
        self.action_seq += 1
        self.last_jack = {'seq': self.action_seq,
                          'a': {'playerId': a['playerId'], 'cellIndex': a['cellIndex']},
                          'b': {'playerId': target_player, 'cellIndex': target_cell},
                          'by': sender}
        self.jack_first = None
        self._power_complete()
        return (loc_a, loc_b)

    def queen_select(self, sender, target_player, target_cell):
        if self.turn_mode != 'queenPeek' or sender != self.power_actor:
            raise GameError('Not resolving a Queen right now.')
        if target_player not in self.grids or not (0 <= target_cell < len(self.grids[target_player])):
            raise GameError('Invalid card.')
        card = self.grids[target_player][target_cell]
        self.action_seq += 1
        # Public: everyone sees WHICH card was peeked (not its value).
        self.last_queen = {'seq': self.action_seq, 'playerId': target_player,
                           'cellIndex': target_cell, 'by': sender}
        self._log('queen', name=self.names[sender], target=self.names[target_player])
        self._power_complete()
        return card

    def ace_give(self, sender, target_player):
        if self.turn_mode != 'aceGive' or sender != self.power_actor:
            raise GameError('Not resolving an Ace right now.')
        if target_player not in self.grids:
            raise GameError('Invalid player.')
        card = self.draw_one()
        if card is None:
            self._log('noGive')
            self._power_complete()
            return
        self.grids[target_player].append(card)
        self.action_seq += 1
        self.last_ace = {'seq': self.action_seq, 'playerId': target_player,
                         'cellIndex': len(self.grids[target_player]) - 1, 'by': sender}
        self._log('ace', name=self.names[sender], target=self.names[target_player])
        self._power_complete()

    # ---- serialization ----

    def public_state(self, viewer_id):
        players = []
        for pid in self.order:
            players.append({
                'id': pid,
                'name': self.names[pid],
                'gridSize': len(self.grids[pid]),
                'isYou': pid == viewer_id,
            })
        state = {
            'phase': self.phase,
            'players': players,
            'currentPlayerId': self.current_player(),
            'turnMode': self.turn_mode,
            'powerActorId': self.power_actor,
            'ending': self.ending,
            'endMatchMs': max(0, int((self.end_at - time.time()) * 1000)) if self.ending else 0,
            'jackFirst': self.jack_first,
            'peekChooserId': self.peek_chooser,
            'peekCount': self.peek_count,
            'peekingPlayerId': self.peeking_player(),
            'peekedCells': sorted(self.peeked_cells) if viewer_id == self.peeking_player() else [],
            'discardTop': self.discard[-1] if self.discard else None,
            'drawCount': len(self.deck),
            'finalRound': self.final_round,
            'dutchCallerId': self.dutch_caller,
            'finalRoundRemaining': self.final_round_remaining,
            'lastSwap': self.last_swap,
            'lastMatch': self.last_match,
            'lastFlip': self.last_flip,
            'lastJack': self.last_jack,
            'lastQueen': self.last_queen,
            'lastAce': self.last_ace,
            'cardsPer': self.cards_per,
            'matchingEnabled': self.matching_enabled,
            'actWaitMs': self._act_wait_ms(),
            'matcherId': self.matcher,
            'matchWaitMs': max(0, int((self.matcher_deadline - time.time()) * 1000)) if self.matcher else 0,
            'log': self.log[-8:],
        }
        if self.phase == 'reveal':
            reveal = []
            for pid in self.order:
                grid = self.grids[pid]
                reveal.append({
                    'id': pid,
                    'name': self.names[pid],
                    'grid': grid,
                    'total': sum(c['value'] for c in grid),
                })
            state['reveal'] = reveal
        return state
