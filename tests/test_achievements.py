import server
from game import Game, make_card


def _game(grids):
    ids = list(grids)
    g = Game(ids, {i: i for i in ids}, {'cardsPer': 4, 'bufferSeconds': 0, 'matching': True})
    for pid, cards in grids.items():
        g.grids[pid] = cards
    return g


def test_earned_codes_all_and_none():
    g = _game({'A': [make_card('K', 'H')], 'B': [make_card('5', 'C')]})   # A holds a red King (0)
    g.dutch_caller = 'A'
    winner = {'pid': 'A', 'won': True, 'total': 0, 'plays_correct': 3, 'plays_total': 3, 'shed': 3, 'powers': 3}
    codes = server._earned_codes(g, winner, {'games': 30}, ranked=True)
    for c in ('first_win', 'red_king', 'perfect_round', 'shed3', 'power3',
              'low_score', 'dutch_win', 'ranked_win', 'veteran'):
        assert c in codes

    loser = {'pid': 'B', 'won': False, 'total': 20, 'plays_correct': 1, 'plays_total': 5, 'shed': 0, 'powers': 0}
    assert server._earned_codes(g, loser, {'games': 1}, ranked=False) == []
