"""Server-authoritative rules engine for Dutch. No networking here — server.py
owns connections and calls into this module, which just mutates a Game object."""

import random

RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
SUITS = ['S', 'H', 'D', 'C']
RED_SUITS = {'H', 'D'}
SUIT_SYMBOL = {'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣'}


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
    def __init__(self, player_ids, names_by_id):
        self.order = list(player_ids)
        self.names = dict(names_by_id)

        deck = make_deck()
        self.grids = {pid: [deck.pop(), deck.pop(), deck.pop(), deck.pop()] for pid in self.order}
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

        self.log = []

    # ---- helpers ----

    def _log(self, msg):
        self.log.append(msg)
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
                self._log('Draw pile was empty — reshuffled the discard pile.')
            else:
                return None
        if not self.deck:
            return None
        return self.deck.pop()

    def _advance_turn(self):
        self.turn_mode = 'awaitingAction'
        self.jack_first = None
        self.current_index = (self.current_index + 1) % len(self.order)

    def _action_resolved(self):
        """Called once the turn's action (and any power) has fully resolved.
        Outside the final round the player still gets an end-of-turn choice:
        end the turn, or call Dutch. During the final round there is no choice
        to make, so the turn advances automatically."""
        self.jack_first = None
        if self.final_round:
            self.final_round_remaining -= 1
            if self.final_round_remaining <= 0:
                self.phase = 'reveal'
                return
            self._advance_turn()
        else:
            self.turn_mode = 'endOfTurn'

    def _trigger_power_or_complete(self, card):
        if card['rank'] == 'J':
            self.turn_mode = 'jackSwap'
            self.jack_first = None
        elif card['rank'] == 'Q':
            self.turn_mode = 'queenPeek'
        elif card['rank'] == 'A':
            self.turn_mode = 'aceGive'
        else:
            self._action_resolved()

    # ---- peek-count / peeking phase ----

    def choose_peek_count(self, sender, count):
        if self.phase != 'choosePeekCount':
            raise GameError('Not choosing a peek count right now.')
        if sender != self.peek_chooser:
            raise GameError("It's not your choice to make.")
        if count not in (0, 1, 2, 3, 4):
            raise GameError('Pick a number from 0 to 4.')
        self.peek_count = count
        if count == 0:
            self.phase = 'playing'
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

    # ---- main turn actions ----

    def flip(self, sender):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'awaitingAction':
            raise GameError('Resolve the current power first.')
        card = self.draw_one()
        if card is None:
            raise GameError('No cards left to draw.')
        self.discard.append(card)
        self._log(f"{self.names[sender]} flipped {card_label(card)}.")
        self._trigger_power_or_complete(card)

    def swap_cell(self, sender, cell_index):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'awaitingAction':
            raise GameError('Resolve the current power first.')
        grid = self.grids[sender]
        if not (0 <= cell_index < len(grid)):
            raise GameError('Invalid card.')
        discard_top = self.discard.pop()
        old_card = grid[cell_index]
        grid[cell_index] = discard_top
        self.discard.append(old_card)
        self._log(f"{self.names[sender]} swapped in {card_label(discard_top)}, discarded {card_label(old_card)}.")
        self._trigger_power_or_complete(old_card)

    def end_turn(self, sender):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'endOfTurn':
            raise GameError('Play your turn first.')
        self._advance_turn()

    def call_dutch(self, sender):
        if self.phase != 'playing':
            raise GameError('Game is not in progress.')
        if sender != self.current_player():
            raise GameError("It's not your turn.")
        if self.turn_mode != 'endOfTurn':
            raise GameError('Play your turn first — you call Dutch at the end of it.')
        if self.final_round:
            raise GameError('Dutch has already been called.')
        self.final_round = True
        self.dutch_caller = sender
        self.final_round_remaining = len(self.order) - 1
        self._log(f"{self.names[sender]} called Dutch!")
        self._advance_turn()

    def jack_select(self, sender, target_player, target_cell):
        if self.turn_mode != 'jackSwap' or sender != self.current_player():
            raise GameError('Not resolving a Jack right now.')
        if target_player not in self.grids or not (0 <= target_cell < len(self.grids[target_player])):
            raise GameError('Invalid card.')
        if self.jack_first is None:
            self.jack_first = {'playerId': target_player, 'cellIndex': target_cell}
            return
        a = self.jack_first
        if a['playerId'] == target_player and a['cellIndex'] == target_cell:
            return
        ga, gb = self.grids[a['playerId']], self.grids[target_player]
        ga[a['cellIndex']], gb[target_cell] = gb[target_cell], ga[a['cellIndex']]
        self._log(f"{self.names[sender]} used the Jack to blind-swap two cards.")
        self.jack_first = None
        self._action_resolved()

    def queen_select(self, sender, target_player, target_cell):
        if self.turn_mode != 'queenPeek' or sender != self.current_player():
            raise GameError('Not resolving a Queen right now.')
        if target_player not in self.grids or not (0 <= target_cell < len(self.grids[target_player])):
            raise GameError('Invalid card.')
        card = self.grids[target_player][target_cell]
        self._log(f"{self.names[sender]} used the Queen to peek at a card.")
        self._action_resolved()
        return card

    def ace_give(self, sender, target_player):
        if self.turn_mode != 'aceGive' or sender != self.current_player():
            raise GameError('Not resolving an Ace right now.')
        if target_player not in self.grids:
            raise GameError('Invalid player.')
        card = self.draw_one()
        if card is None:
            self._log('No cards left to give.')
            self._action_resolved()
            return
        self.grids[target_player].append(card)
        self._log(f"{self.names[sender]} used the Ace to give {self.names[target_player]} a face-down card.")
        self._action_resolved()

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
