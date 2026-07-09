import pytest

import storage


@pytest.fixture(scope='module', autouse=True)
def _db():
    storage.init_db()


def _mk(username):
    return storage.create_user(username, 'password123')


def test_signup_login_and_duplicate():
    u = _mk('alice')
    assert storage.verify_password('alice', 'password123')['id'] == u['id']
    assert storage.verify_password('alice', 'wrong') is None
    with pytest.raises(ValueError):
        storage.create_user('Alice', 'password123')   # case-insensitive dup


def test_record_game_updates_stats():
    u = _mk('bob')
    storage.record_game([{'user_id': u['id'], 'total': 10, 'won': True,
                          'plays_correct': 8, 'plays_total': 10}])
    s = storage.get_stats(u['id'])
    assert s['games'] == 1 and s['wins'] == 1 and s['best_score'] == 10 and s['accuracy'] == 80


def test_ranked_updates_rating_and_leaderboard_order():
    a, b = _mk('carol'), _mk('dave')
    out = storage.record_ranked_1v1(a['id'], b['id'], 1.0)   # carol wins
    assert out[a['id']]['rating'] > 1500 and out[b['id']]['rating'] < 1500
    sa = storage.get_stats(a['id'])
    assert sa['rating'] > 1500 and sa['ranked_games'] == 1 and sa['ranked_wins'] == 1
    board = storage.get_leaderboard(10)
    ranked = [r for r in board if r['ranked_games'] > 0]
    assert [r['username'] for r in ranked][:2] == ['carol', 'dave']  # sorted by rating desc


def test_history_records_detail_and_prunes():
    u = _mk('erin')
    storage.record_history([{'user_id': u['id'], 'played_at': 1000.0, 'total': 7, 'won': True,
                             'players': 3, 'ranked': False, 'rating_delta': None,
                             'placement': 1, 'accuracy': 90, 'shed': 2, 'powers': 1}])
    h = storage.get_history(u['id'])
    assert h[0]['placement'] == 1 and h[0]['accuracy'] == 90 and h[0]['shed'] == 2 and h[0]['powers'] == 1
    for i in range(60):
        storage.record_history([{'user_id': u['id'], 'played_at': 2000.0 + i, 'total': i,
                                 'won': False, 'players': 2, 'ranked': False, 'rating_delta': None,
                                 'placement': 2, 'accuracy': None, 'shed': 0, 'powers': 0}])
    assert len(storage.get_history(u['id'], 999)) == 50   # capped at 50 per user
