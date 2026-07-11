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


def test_referrals():
    host = _mk('refhost')
    r_b = _mk('refb')
    r_c = _mk('refc')
    # refb & refc both signed up via refhost's link
    r1 = storage.record_referral('refhost', r_b['id'])
    assert r1 and r1['referrer_id'] == host['id'] and r1['count'] == 1
    r2 = storage.record_referral('refhost', r_c['id'])
    assert r2['count'] == 2
    assert storage.referral_count(host['id']) == 2
    assert storage.get_stats(host['id'])['referrals'] == 2
    # a referee can't be re-credited, and self/unknown referrers are ignored
    assert storage.record_referral('refhost', r_b['id']) is None
    assert storage.record_referral('refhost', host['id']) is None
    assert storage.record_referral('nobody', _mk('refd')['id']) is None


def test_daily_streak_advances_and_lapses():
    # Two games on the same day = streak 1; consecutive days climb; a gap resets.
    assert storage._next_streak(None, 0) == (1, True)
    assert storage._next_streak(storage._utc_day(0), 5) == (5, False)   # already played today
    assert storage._next_streak(storage._utc_day(1), 5) == (6, True)    # played yesterday -> +1
    assert storage._next_streak(storage._utc_day(3), 5) == (1, True)    # 3-day gap -> reset

    u = _mk('heidi')
    storage.record_game([{'user_id': u['id'], 'total': 5, 'won': True, 'plays_correct': 1, 'plays_total': 1}])
    s = storage.get_stats(u['id'])
    assert s['streak'] == 1 and s['best_streak'] == 1
    # A second game the same day keeps the streak at 1 (not double-counted).
    storage.record_game([{'user_id': u['id'], 'total': 8, 'won': False, 'plays_correct': 1, 'plays_total': 1}])
    assert storage.get_stats(u['id'])['streak'] == 1
    assert storage.get_streak(u['id']) == 1


def test_cosmetics_default_and_persist():
    u = _mk('grace')
    row = storage.get_by_id(u['id'])
    assert row['card_back'] == 'classic' and row['table_felt'] == 'classic' and row['emblem'] == 'default'
    storage.set_card_back(u['id'], 'noir')
    storage.set_table_felt(u['id'], 'midnight')
    storage.set_cosmetic(u['id'], 'emblem', 'dragon')
    row = storage.get_by_id(u['id'])
    assert row['card_back'] == 'noir' and row['table_felt'] == 'midnight' and row['emblem'] == 'dragon'


def test_achievements_award_once():
    u = _mk('frank')
    assert set(storage.award_achievements(u['id'], ['first_win', 'veteran'])) == {'first_win', 'veteran'}
    assert storage.award_achievements(u['id'], ['first_win', 'red_king']) == ['red_king']  # only the new one
    assert set(storage.get_achievements(u['id'])) == {'first_win', 'veteran', 'red_king'}
