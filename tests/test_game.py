import time

import pytest

from game import Game, GameError, card_value, make_card


def start_game(n=2, matching=True):
    ids = [chr(ord('A') + i) for i in range(n)]
    g = Game(ids, {i: i for i in ids},
             {'cardsPer': 4, 'bufferSeconds': 0, 'matching': matching, 'turnLimit': 30})
    g.choose_peek_count(g.peek_chooser, 0)   # 0 peeks -> straight to playing
    assert g.phase == 'playing'
    return g


def test_card_values():
    assert card_value('A', 'S') == 1
    assert card_value('J', 'H') == 11
    assert card_value('Q', 'C') == 12
    assert card_value('7', 'D') == 7
    assert card_value('K', 'H') == 0     # red king best
    assert card_value('K', 'D') == 0
    assert card_value('K', 'S') == 13    # black king worst
    assert card_value('K', 'C') == 13


def test_flip_nonpower_completes_turn():
    g = start_game()
    cur = g.current_player()
    g.deck.append(make_card('5', 'C'))
    g.turn_started_at = 0
    g.flip(cur)
    assert g.turn_mode == 'endOfTurn'      # non-power -> end-of-turn choice


def test_flip_power_triggers_and_resolves():
    g = start_game()
    cur = g.current_player()
    g.deck.append(make_card('Q', 'H'))
    g.turn_started_at = 0
    g.flip(cur)
    assert g.turn_mode == 'queenPeek' and g.power_actor == cur
    g.queen_select(cur, cur, 0)            # peek own card
    assert g.turn_mode == 'endOfTurn'


def test_swap_discards_old_card():
    g = start_game()
    cur = g.current_player()
    g.discard = [make_card('3', 'C')]
    g.grids[cur][0] = make_card('9', 'S')
    g.turn_started_at = 0
    g.swap_cell(cur, 0)
    assert g.grids[cur][0]['rank'] == '3'          # took the discard
    assert g.discard[-1]['rank'] == '9'            # old card is now face-up


def test_match_sheds_card_and_offturn_power_goes_to_matcher():
    g = start_game()
    cur = g.current_player()
    other = 'B' if cur == 'A' else 'A'
    g.discard = [make_card('J', 'H')]              # a Jack on the discard
    g.grids[other][0] = make_card('J', 'S')        # matcher holds a Jack
    n = len(g.grids[other])
    g.claim_match(other)
    res = g.match_card(other, 0)
    assert res['matched'] and len(g.grids[other]) == n - 1
    assert g.turn_mode == 'jackSwap' and g.power_actor == other   # matcher resolves it
    with pytest.raises(GameError):
        g.jack_select(cur, cur, 0)                 # wrong actor cannot resolve
    g.jack_select(other, other, 0)
    g.jack_select(other, cur, 0)
    assert g.turn_mode == 'awaitingAction' and g.current_player() == cur  # turn restored


def test_dutch_end_grace_then_reveal():
    g = start_game()
    cur = g.current_player()
    g.deck.append(make_card('5', 'C'))
    g.turn_started_at = 0
    g.flip(cur)
    g.call_dutch(cur)
    assert g.final_round and g.final_round_remaining == 1
    g.deck.append(make_card('6', 'C'))
    g.turn_started_at = 0
    g.flip(g.current_player())                     # last final-round turn
    assert g.phase == 'playing' and g.turn_mode == 'awaitingMatch' and g.ending
    g.finish_round()
    assert g.phase == 'reveal' and not g.ending


def test_matching_off_reveals_immediately_at_end():
    g = start_game(matching=False)
    cur = g.current_player()
    g.deck.append(make_card('5', 'C'))
    g.turn_started_at = 0
    g.flip(cur)
    g.call_dutch(cur)
    g.deck.append(make_card('6', 'C'))
    g.turn_started_at = 0
    g.flip(g.current_player())
    assert g.phase == 'reveal' and not g.ending    # no grace when matching is off
