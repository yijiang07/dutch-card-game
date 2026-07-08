"""Glicko-2 rating (Glickman). Single-game updates for 1v1 ranked play.

Each ranked round is treated as a one-game rating period. Both players are
updated using each other's *pre-game* rating/deviation/volatility. Scores are
1.0 (win), 0.0 (loss), 0.5 (draw).

Public API:
    DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL
    update(rating, rd, vol, opp_rating, opp_rd, score) -> (rating', rd', vol')
    rate_pair(a, b, a_score) -> ((ra,rda,vola), (rb,rdb,volb))
        where a/b are (rating, rd, vol) tuples.
"""
import math

DEFAULT_RATING = 1500.0
DEFAULT_RD = 350.0
DEFAULT_VOL = 0.06

_TAU = 0.5          # system constant: constrains volatility change (0.3–1.2)
_SCALE = 173.7178   # Glicko -> Glicko-2 scale factor
_EPS = 1e-6


def _g(phi):
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi * math.pi))


def _E(mu, mu_j, phi_j):
    return 1.0 / (1.0 + math.exp(-_g(phi_j) * (mu - mu_j)))


def update(rating, rd, vol, opp_rating, opp_rd, score):
    """Return the new (rating, rd, vol) for a player after one game."""
    # Step 2: to Glicko-2 scale.
    mu = (rating - DEFAULT_RATING) / _SCALE
    phi = rd / _SCALE
    mu_j = (opp_rating - DEFAULT_RATING) / _SCALE
    phi_j = opp_rd / _SCALE

    # Step 3: variance of the rating based on game outcome.
    g_j = _g(phi_j)
    e = _E(mu, mu_j, phi_j)
    v = 1.0 / (g_j * g_j * e * (1.0 - e))

    # Step 4: estimated improvement in rating.
    delta = v * g_j * (score - e)

    # Step 5: new volatility via Illinois algorithm.
    a = math.log(vol * vol)

    def f(x):
        ex = math.exp(x)
        num = ex * (delta * delta - phi * phi - v - ex)
        den = 2.0 * (phi * phi + v + ex) ** 2
        return num / den - (x - a) / (_TAU * _TAU)

    A = a
    if delta * delta > phi * phi + v:
        B = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * _TAU) < 0:
            k += 1
        B = a - k * _TAU

    fA, fB = f(A), f(B)
    while abs(B - A) > _EPS:
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB <= 0:
            A, fA = B, fB
        else:
            fA /= 2.0
        B, fB = C, fC

    new_vol = math.exp(A / 2.0)

    # Step 6: pre-rating-period deviation.
    phi_star = math.sqrt(phi * phi + new_vol * new_vol)

    # Step 7: new deviation and rating.
    new_phi = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
    new_mu = mu + new_phi * new_phi * g_j * (score - e)

    # Step 8: back to Glicko scale.
    new_rating = _SCALE * new_mu + DEFAULT_RATING
    new_rd = _SCALE * new_phi
    # Keep RD in a sane band.
    new_rd = max(30.0, min(DEFAULT_RD, new_rd))
    return new_rating, new_rd, new_vol


def rate_pair(a, b, a_score):
    """a, b are (rating, rd, vol). a_score is a's result (1/0/0.5).
    Returns (new_a, new_b) using each other's pre-game values."""
    na = update(a[0], a[1], a[2], b[0], b[1], a_score)
    nb = update(b[0], b[1], b[2], a[0], a[1], 1.0 - a_score)
    return na, nb
