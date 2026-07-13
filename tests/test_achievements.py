import server
from game import Game, make_card


def _game(grids):
    ids = list(grids)
    g = Game(ids, {i: i for i in ids}, {'cardsPer': 4, 'bufferSeconds': 0, 'matching': True})
    for pid, cards in grids.items():
        g.grids[pid] = cards
    return g


def test_cosmetic_unlock_gates(monkeypatch):
    # High-tier player unlocks everything; a fresh account only the defaults.
    def fake_stats(uid):
        return {'games': 40, 'wins': 30, 'referrals': 5, 'rating': 2100} if uid == 'pro' else {}
    monkeypatch.setattr(server.storage, 'get_stats', fake_stats)
    monkeypatch.setattr(server.storage, 'get_achievements',
                        lambda uid: [f'a{i}' for i in range(12)] + ['welcomed'] if uid == 'pro' else [])
    for kind, rules in (('cardBack', server.CARD_BACKS), ('tableFelt', server.TABLE_FELTS), ('emblem', server.EMBLEMS)):
        for skin in rules:
            assert server._cosmetic_unlocked(kind, skin, 'pro')            # all unlocked for the pro
        locked = [s for s in rules if not server._cosmetic_unlocked(kind, s, 'new')]
        assert locked and 'classic' not in locked and 'default' not in locked  # defaults always free
    assert not server._cosmetic_unlocked('cardBack', 'nope', 'pro')        # unknown id stays locked

    # The 'welcome' card back is gated on the 'welcomed' achievement (double-sided referral reward).
    monkeypatch.setattr(server.storage, 'get_stats', lambda uid: {})
    monkeypatch.setattr(server.storage, 'get_achievements', lambda uid: ['welcomed'] if uid == 'referred' else [])
    assert server._cosmetic_unlocked('cardBack', 'welcome', 'referred')
    assert not server._cosmetic_unlocked('cardBack', 'welcome', 'stranger')


def test_house_lobbies_seed_and_host_transfer():
    server.rooms.clear()
    try:
        server.ensure_house_lobbies()
        seeds = server._house_seeds()
        assert len(seeds) == server.HOUSE_TARGET
        r = seeds[0]
        assert r.house and r.game is None
        assert all(p['is_bot'] for p in r.players.values())        # bots only
        assert r.players[r.host_id]['is_bot']                      # a bot holds the seat
        assert 0 < len(r.players) < 8                              # shows as joinable

        # A human joins the seed -> takes host, a replacement seed is spun up.
        pid = 'human1'
        r.players[pid] = {'name': 'Al', 'is_bot': False, 'connected': True, 'ws': None}
        if r.house and r.players.get(r.host_id, {}).get('is_bot'):
            r.host_id = pid
            server.ensure_house_lobbies()
        assert r.host_id == pid
        assert r not in server._house_seeds()                      # taken (has a human)
        assert len(server._house_seeds()) == server.HOUSE_TARGET   # topped back up
    finally:
        server.rooms.clear()


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
