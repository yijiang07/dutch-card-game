import glicko2


def test_defaults():
    assert glicko2.DEFAULT_RATING == 1500.0
    assert glicko2.DEFAULT_RD == 350.0


def test_even_win_moves_symmetrically_and_shrinks_rd():
    a = (1500, 350, 0.06)
    (ra, rda, _), (rb, rdb, _) = glicko2.rate_pair(a, a, 1.0)
    assert ra > 1500 and rb < 1500
    assert round(ra - 1500) == round(1500 - rb)   # symmetric around 1500
    assert rda < 350 and rdb < 350                # certainty increases


def test_draw_between_equals_is_roughly_neutral():
    a = (1500, 350, 0.06)
    (ra, *_), (rb, *_) = glicko2.rate_pair(a, a, 0.5)
    assert abs(ra - 1500) < 1 and abs(rb - 1500) < 1


def test_expected_win_small_upset_large():
    strong, weak = (1800, 60, 0.06), (1400, 60, 0.06)
    (s_exp, *_), _ = glicko2.rate_pair(strong, weak, 1.0)   # expected
    (s_ups, *_), _ = glicko2.rate_pair(strong, weak, 0.0)   # upset
    assert abs(s_exp - 1800) < abs(s_ups - 1800)
    assert s_ups < 1800                                      # losing the upset drops the favorite
