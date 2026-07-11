"""Persistence for user identities and friendships.

Uses Postgres when DATABASE_URL is set (durable, for production), and falls
back to a local SQLite file otherwise (zero-config for local dev / preview).
Both backends expose the same synchronous functions; friend/identity calls are
infrequent (login, add friend, etc.) so a fresh connection per call is fine.
"""

import hashlib
import hmac
import os
import re
import secrets
import time

import glicko2

DATABASE_URL = os.environ.get('DATABASE_URL')
USE_PG = bool(DATABASE_URL)

if USE_PG:
    import psycopg
    from psycopg.rows import dict_row
    DUP_ERRORS = (psycopg.errors.UniqueViolation,)
else:
    import sqlite3
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DB_PATH = os.environ.get('DUTCH_DB', os.path.join(BASE_DIR, 'dutch.db'))
    DUP_ERRORS = (sqlite3.IntegrityError,)

USERNAME_RE = re.compile(r'^[A-Za-z0-9_]{3,16}$')
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
MIN_PASSWORD = 6
PBKDF2_ROUNDS = 200_000
RESET_TTL_SECONDS = 3600


def _connect():
    if USE_PG:
        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def _ph(sql):
    """SQLite uses ? placeholders; psycopg uses %s."""
    return sql.replace('?', '%s') if USE_PG else sql


def _hash(s):
    """Fast hash for HIGH-ENTROPY secrets only (session tokens, recovery codes)."""
    return hashlib.sha256(s.encode()).hexdigest()


def _pw_hash(password, salt_hex):
    """Slow salted KDF for user-chosen passwords (low entropy)."""
    dk = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt_hex), PBKDF2_ROUNDS)
    return dk.hex()


def init_db():
    ts_type = 'DOUBLE PRECISION' if USE_PG else 'REAL'
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(f'''CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            pw_salt TEXT,
            pw_hash TEXT,
            recovery_hash TEXT,
            email TEXT,
            created_at {ts_type} NOT NULL
        )''')
        # Migrate installs created before passwords existed.
        if USE_PG:
            for col in ('pw_salt', 'pw_hash', 'recovery_hash', 'email', 'lang', 'card_back'):
                cur.execute(f'ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} TEXT')
            # The old passwordless schema had a NOT NULL secret_hash; new signups
            # don't set it, so relax the constraint if that column is still around.
            cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='users'")
            existing = {r['column_name'] for r in cur.fetchall()}
            if 'secret_hash' in existing:
                cur.execute('ALTER TABLE users ALTER COLUMN secret_hash DROP NOT NULL')
        else:
            have = {r[1] for r in cur.execute('PRAGMA table_info(users)').fetchall()}
            for col in ('pw_salt', 'pw_hash', 'recovery_hash', 'email', 'lang', 'card_back'):
                if col not in have:
                    cur.execute(f'ALTER TABLE users ADD COLUMN {col} TEXT')
        # Case-insensitive uniqueness via an expression index (both backends).
        cur.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uname ON users (lower(username))')
        # "Stay logged in" tokens — one row per signed-in device.
        cur.execute(f'''CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at {ts_type} NOT NULL
        )''')
        # One row per user pair; (low, high) sorted by id so a relationship in
        # either direction maps to the same row.
        cur.execute('''CREATE TABLE IF NOT EXISTS relations (
            low TEXT NOT NULL,
            high TEXT NOT NULL,
            requester TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (low, high)
        )''')
        cur.execute(f'''CREATE TABLE IF NOT EXISTS stats (
            user_id TEXT PRIMARY KEY,
            games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            total_score INTEGER NOT NULL DEFAULT 0,
            best_score INTEGER,
            plays_correct INTEGER NOT NULL DEFAULT 0,
            plays_total INTEGER NOT NULL DEFAULT 0,
            rating REAL NOT NULL DEFAULT 1500,
            rd REAL NOT NULL DEFAULT 350,
            vol REAL NOT NULL DEFAULT 0.06,
            ranked_games INTEGER NOT NULL DEFAULT 0,
            ranked_wins INTEGER NOT NULL DEFAULT 0
        )''')
        # Add newer columns to stats tables created before those features.
        int_cols = ('plays_correct', 'plays_total', 'ranked_games', 'ranked_wins')
        real_cols = (('rating', 1500), ('rd', 350), ('vol', 0.06))
        if USE_PG:
            for col in int_cols:
                cur.execute(f'ALTER TABLE stats ADD COLUMN IF NOT EXISTS {col} INTEGER NOT NULL DEFAULT 0')
            for col, dflt in real_cols:
                cur.execute(f'ALTER TABLE stats ADD COLUMN IF NOT EXISTS {col} REAL NOT NULL DEFAULT {dflt}')
        else:
            have = {r[1] for r in cur.execute('PRAGMA table_info(stats)').fetchall()}
            for col in int_cols:
                if col not in have:
                    cur.execute(f'ALTER TABLE stats ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0')
            for col, dflt in real_cols:
                if col not in have:
                    cur.execute(f'ALTER TABLE stats ADD COLUMN {col} REAL NOT NULL DEFAULT {dflt}')
        cur.execute(f'''CREATE TABLE IF NOT EXISTS password_resets (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at {ts_type} NOT NULL,
            used INTEGER NOT NULL DEFAULT 0
        )''')
        # Per-round match history (one row per account player per finished round).
        cur.execute(f'''CREATE TABLE IF NOT EXISTS game_history (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            played_at {ts_type} NOT NULL,
            total INTEGER NOT NULL,
            won INTEGER NOT NULL DEFAULT 0,
            players INTEGER NOT NULL DEFAULT 0,
            ranked INTEGER NOT NULL DEFAULT 0,
            rating_delta INTEGER,
            placement INTEGER,
            accuracy INTEGER,
            shed INTEGER NOT NULL DEFAULT 0,
            powers INTEGER NOT NULL DEFAULT 0
        )''')
        cur.execute('CREATE INDEX IF NOT EXISTS idx_history_user ON game_history (user_id, played_at)')
        # Add per-round detail columns to history tables created before this feature.
        if USE_PG:
            cur.execute('ALTER TABLE game_history ADD COLUMN IF NOT EXISTS placement INTEGER')
            cur.execute('ALTER TABLE game_history ADD COLUMN IF NOT EXISTS accuracy INTEGER')
            cur.execute('ALTER TABLE game_history ADD COLUMN IF NOT EXISTS shed INTEGER NOT NULL DEFAULT 0')
            cur.execute('ALTER TABLE game_history ADD COLUMN IF NOT EXISTS powers INTEGER NOT NULL DEFAULT 0')
        else:
            have = {r[1] for r in cur.execute('PRAGMA table_info(game_history)').fetchall()}
            for col, decl in (('placement', 'INTEGER'), ('accuracy', 'INTEGER'),
                              ('shed', 'INTEGER NOT NULL DEFAULT 0'), ('powers', 'INTEGER NOT NULL DEFAULT 0')):
                if col not in have:
                    cur.execute(f'ALTER TABLE game_history ADD COLUMN {col} {decl}')
        # Earned achievements (one row per user per achievement code).
        cur.execute(f'''CREATE TABLE IF NOT EXISTS achievements (
            user_id TEXT NOT NULL,
            code TEXT NOT NULL,
            earned_at {ts_type} NOT NULL,
            PRIMARY KEY (user_id, code)
        )''')
        # Referrals — each new user is referred by at most one existing user.
        cur.execute(f'''CREATE TABLE IF NOT EXISTS referrals (
            referee_id TEXT PRIMARY KEY,
            referrer_id TEXT NOT NULL,
            created_at {ts_type} NOT NULL
        )''')
        cur.execute('CREATE INDEX IF NOT EXISTS idx_referrer ON referrals (referrer_id)')
        conn.commit()
    finally:
        conn.close()


def _validate_credentials(username, password):
    username = (username or '').strip()
    if not USERNAME_RE.match(username):
        raise ValueError('Usernames are 3-16 letters, numbers, or underscores.')
    if len(password or '') < MIN_PASSWORD:
        raise ValueError(f'Password must be at least {MIN_PASSWORD} characters.')
    return username


def _clean_email(email):
    email = (email or '').strip()
    if not email:
        return None
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise ValueError('That email address looks invalid.')
    return email


def create_user(username, password, email=None, lang=None):
    username = _validate_credentials(username, password)
    email = _clean_email(email)
    if email and get_by_email(email):
        raise ValueError('That email is already in use.')
    lang = (lang or 'en')[:5]
    uid = secrets.token_hex(8)
    salt = secrets.token_hex(16)
    recovery = secrets.token_urlsafe(9)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('''INSERT INTO users (id, username, pw_salt, pw_hash, recovery_hash, email, lang, created_at)
                           VALUES (?,?,?,?,?,?,?,?)'''),
                    (uid, username, salt, _pw_hash(password, salt), _hash(recovery), email, lang, time.time()))
        conn.commit()
    except DUP_ERRORS:
        raise ValueError('That username is taken.')
    finally:
        conn.close()
    return {'id': uid, 'username': username, 'recovery_code': recovery, 'lang': lang}


def set_lang(user_id, lang):
    lang = (lang or 'en')[:5]
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('UPDATE users SET lang=? WHERE id=?'), (lang, user_id))
        conn.commit()
    finally:
        conn.close()


def set_card_back(user_id, skin):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('UPDATE users SET card_back=? WHERE id=?'), (skin[:20], user_id))
        conn.commit()
    finally:
        conn.close()


def get_by_email(email):
    email = (email or '').strip()
    if not email:
        return None
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT id, username, email FROM users WHERE lower(email)=lower(?)'), (email,))
        r = cur.fetchone()
    finally:
        conn.close()
    return {'id': r['id'], 'username': r['username'], 'email': r['email']} if r else None


def set_email(user_id, email):
    email = _clean_email(email)
    if email:
        other = get_by_email(email)
        if other and other['id'] != user_id:
            raise ValueError('That email is already in use.')
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('UPDATE users SET email=? WHERE id=?'), (email, user_id))
        conn.commit()
    finally:
        conn.close()
    return email


def _get_auth_row(username):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT id, username, pw_salt, pw_hash, recovery_hash FROM users WHERE lower(username)=lower(?)'),
                    ((username or '').strip(),))
        return cur.fetchone()
    finally:
        conn.close()


def verify_password(username, password):
    r = _get_auth_row(username)
    if not r or not r['pw_hash']:
        return None
    if hmac.compare_digest(_pw_hash(password or '', r['pw_salt']), r['pw_hash']):
        return get_by_id(r['id'])
    return None


def verify_recovery(username, code):
    r = _get_auth_row(username)
    if not r or not r['recovery_hash']:
        return None
    if hmac.compare_digest(_hash(code or ''), r['recovery_hash']):
        return get_by_id(r['id'])
    return None


def set_password(user_id, password):
    if len(password or '') < MIN_PASSWORD:
        raise ValueError(f'Password must be at least {MIN_PASSWORD} characters.')
    salt = secrets.token_hex(16)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?'),
                    (salt, _pw_hash(password, salt), user_id))
        conn.commit()
    finally:
        conn.close()


def get_by_id(uid):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT id, username, email, lang, card_back FROM users WHERE id=?'), (uid,))
        r = cur.fetchone()
    finally:
        conn.close()
    return {'id': r['id'], 'username': r['username'], 'email': r['email'], 'lang': r['lang'],
            'card_back': r['card_back'] or 'classic'} if r else None


def create_session(user_id):
    token = secrets.token_urlsafe(24)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)'),
                    (_hash(token), user_id, time.time()))
        conn.commit()
    finally:
        conn.close()
    return token


def verify_session(uid, token):
    if not uid or not token:
        return None
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT user_id FROM sessions WHERE token_hash=? AND user_id=?'), (_hash(token), uid))
        r = cur.fetchone()
    finally:
        conn.close()
    return get_by_id(uid) if r else None


def delete_session(token):
    if not token:
        return
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('DELETE FROM sessions WHERE token_hash=?'), (_hash(token),))
        conn.commit()
    finally:
        conn.close()


def get_by_username(username):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT id, username FROM users WHERE lower(username)=lower(?)'),
                    ((username or '').strip(),))
        r = cur.fetchone()
    finally:
        conn.close()
    return {'id': r['id'], 'username': r['username']} if r else None


def _pair(a, b):
    return (a, b) if a < b else (b, a)


def request_friend(from_id, to_id):
    """Returns 'pending' or, if the other user had already requested, 'accepted'."""
    if from_id == to_id:
        raise ValueError("You can't friend yourself.")
    low, high = _pair(from_id, to_id)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT requester, status FROM relations WHERE low=? AND high=?'), (low, high))
        r = cur.fetchone()
        if r:
            if r['status'] == 'accepted':
                raise ValueError("You're already friends.")
            if r['requester'] == from_id:
                raise ValueError('Request already sent.')
            cur.execute(_ph('UPDATE relations SET status=? WHERE low=? AND high=?'), ('accepted', low, high))
            conn.commit()
            return 'accepted'
        cur.execute(_ph('INSERT INTO relations (low, high, requester, status) VALUES (?,?,?,?)'),
                    (low, high, from_id, 'pending'))
        conn.commit()
        return 'pending'
    finally:
        conn.close()


def respond_friend(user_id, other_id, accept):
    low, high = _pair(user_id, other_id)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT requester, status FROM relations WHERE low=? AND high=?'), (low, high))
        r = cur.fetchone()
        if not r or r['status'] != 'pending' or r['requester'] == user_id:
            raise ValueError('No such friend request.')
        if accept:
            cur.execute(_ph('UPDATE relations SET status=? WHERE low=? AND high=?'), ('accepted', low, high))
        else:
            cur.execute(_ph('DELETE FROM relations WHERE low=? AND high=?'), (low, high))
        conn.commit()
    finally:
        conn.close()


def remove_relation(user_id, other_id):
    """Unfriend, or cancel an outgoing request."""
    low, high = _pair(user_id, other_id)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('DELETE FROM relations WHERE low=? AND high=?'), (low, high))
        conn.commit()
    finally:
        conn.close()


def relations_of(user_id):
    out = {'friends': [], 'incoming': [], 'outgoing': []}
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT low, high, requester, status FROM relations WHERE low=? OR high=?'),
                    (user_id, user_id))
        rows = cur.fetchall()
        for r in rows:
            other = r['high'] if r['low'] == user_id else r['low']
            cur.execute(_ph('SELECT id, username FROM users WHERE id=?'), (other,))
            u = cur.fetchone()
            if not u:
                continue
            info = {'id': u['id'], 'username': u['username']}
            if r['status'] == 'accepted':
                out['friends'].append(info)
            elif r['requester'] == user_id:
                out['outgoing'].append(info)
            else:
                out['incoming'].append(info)
    finally:
        conn.close()
    for k in out:
        out[k].sort(key=lambda u: u['username'].lower())
    return out


# ---- password-reset tokens (for email recovery) ----

def create_reset_token(user_id):
    token = secrets.token_urlsafe(24)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('INSERT INTO password_resets (token_hash, user_id, expires_at, used) VALUES (?,?,?,0)'),
                    (_hash(token), user_id, time.time() + RESET_TTL_SECONDS))
        conn.commit()
    finally:
        conn.close()
    return token


def consume_reset_token(token):
    """Validate a one-time reset token; returns user_id or None. Marks it used."""
    if not token:
        return None
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT user_id, expires_at, used FROM password_resets WHERE token_hash=?'), (_hash(token),))
        r = cur.fetchone()
        if not r or r['used'] or r['expires_at'] < time.time():
            return None
        cur.execute(_ph('UPDATE password_resets SET used=1 WHERE token_hash=?'), (_hash(token),))
        conn.commit()
        return r['user_id']
    finally:
        conn.close()


# ---- stats & leaderboard ----

def _accuracy(correct, total):
    return round(100 * correct / total) if total else None


def record_game(results):
    """results: list of {user_id, total, won, plays_correct, plays_total}."""
    conn = _connect()
    try:
        cur = conn.cursor()
        for r in results:
            pc = r.get('plays_correct', 0)
            pt = r.get('plays_total', 0)
            cur.execute(_ph('SELECT games, wins, total_score, best_score, plays_correct, plays_total FROM stats WHERE user_id=?'),
                        (r['user_id'],))
            row = cur.fetchone()
            if row:
                best = row['best_score']
                best = r['total'] if best is None else min(best, r['total'])
                cur.execute(_ph('''UPDATE stats SET games=?, wins=?, total_score=?, best_score=?,
                                   plays_correct=?, plays_total=? WHERE user_id=?'''),
                            (row['games'] + 1, row['wins'] + (1 if r['won'] else 0),
                             row['total_score'] + r['total'], best,
                             row['plays_correct'] + pc, row['plays_total'] + pt, r['user_id']))
            else:
                cur.execute(_ph('''INSERT INTO stats (user_id, games, wins, total_score, best_score, plays_correct, plays_total)
                                   VALUES (?,?,?,?,?,?,?)'''),
                            (r['user_id'], 1, 1 if r['won'] else 0, r['total'], r['total'], pc, pt))
        conn.commit()
    finally:
        conn.close()


def _ensure_stats_row(cur, user_id):
    cur.execute(_ph('SELECT 1 FROM stats WHERE user_id=?'), (user_id,))
    if not cur.fetchone():
        cur.execute(_ph('INSERT INTO stats (user_id) VALUES (?)'), (user_id,))


def record_ranked_1v1(a_id, b_id, a_score):
    """Update Glicko-2 ratings for a 1v1 ranked round.
    a_score is player a's result: 1.0 win, 0.0 loss, 0.5 draw.
    Returns {a_id: {rating, delta, won}, b_id: {...}} with rounded ratings."""
    conn = _connect()
    try:
        cur = conn.cursor()
        _ensure_stats_row(cur, a_id)
        _ensure_stats_row(cur, b_id)
        cur.execute(_ph('SELECT user_id, rating, rd, vol, ranked_games, ranked_wins FROM stats WHERE user_id IN (?,?)'),
                    (a_id, b_id))
        rows = {r['user_id']: r for r in cur.fetchall()}
        ra, rb = rows[a_id], rows[b_id]
        na, nb = glicko2.rate_pair((ra['rating'], ra['rd'], ra['vol']),
                                   (rb['rating'], rb['rd'], rb['vol']), a_score)
        out = {}
        for uid, old, new, score in ((a_id, ra, na, a_score), (b_id, rb, nb, 1.0 - a_score)):
            won = 1 if score == 1.0 else 0
            cur.execute(_ph('''UPDATE stats SET rating=?, rd=?, vol=?, ranked_games=?, ranked_wins=?
                               WHERE user_id=?'''),
                        (new[0], new[1], new[2], old['ranked_games'] + 1, old['ranked_wins'] + won, uid))
            out[uid] = {'rating': round(new[0]), 'delta': round(new[0]) - round(old['rating']), 'won': bool(won)}
        conn.commit()
        return out
    finally:
        conn.close()


def record_history(entries):
    """entries: list of {user_id, played_at, total, won, players, ranked, rating_delta}.
    Keeps the most recent 50 rows per user."""
    if not entries:
        return
    conn = _connect()
    try:
        cur = conn.cursor()
        for e in entries:
            cur.execute(_ph('''INSERT INTO game_history
                               (id, user_id, played_at, total, won, players, ranked, rating_delta,
                                placement, accuracy, shed, powers)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'''),
                        (secrets.token_hex(8), e['user_id'], e['played_at'], e['total'],
                         1 if e.get('won') else 0, e.get('players', 0),
                         1 if e.get('ranked') else 0, e.get('rating_delta'),
                         e.get('placement'), e.get('accuracy'),
                         e.get('shed', 0), e.get('powers', 0)))
        for uid in {e['user_id'] for e in entries}:
            cur.execute(_ph('''DELETE FROM game_history WHERE user_id=? AND id NOT IN
                               (SELECT id FROM game_history WHERE user_id=?
                                ORDER BY played_at DESC LIMIT 50)'''), (uid, uid))
        conn.commit()
    finally:
        conn.close()


def get_history(user_id, limit=15):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('''SELECT played_at, total, won, players, ranked, rating_delta,
                                  placement, accuracy, shed, powers
                           FROM game_history WHERE user_id=? ORDER BY played_at DESC LIMIT ?'''),
                    (user_id, limit))
        return [{'playedAt': r['played_at'], 'total': r['total'], 'won': bool(r['won']),
                 'players': r['players'], 'ranked': bool(r['ranked']), 'ratingDelta': r['rating_delta'],
                 'placement': r['placement'], 'accuracy': r['accuracy'],
                 'shed': r['shed'], 'powers': r['powers']}
                for r in cur.fetchall()]
    finally:
        conn.close()


def award_achievements(user_id, codes):
    """Insert any not-yet-earned achievement codes. Returns the newly earned ones."""
    if not codes:
        return []
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT code FROM achievements WHERE user_id=?'), (user_id,))
        have = {r['code'] for r in cur.fetchall()}
        fresh = [c for c in codes if c not in have]
        now = time.time()
        for c in fresh:
            cur.execute(_ph('INSERT INTO achievements (user_id, code, earned_at) VALUES (?,?,?)'),
                        (user_id, c, now))
        conn.commit()
        return fresh
    finally:
        conn.close()


def get_achievements(user_id):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT code FROM achievements WHERE user_id=?'), (user_id,))
        return [r['code'] for r in cur.fetchall()]
    finally:
        conn.close()


def record_referral(referrer_username, referee_id):
    """Credit a signup to the referrer named by their username. Returns
    {referrer_id, count} on a new credit, or None (unknown/self/already-referred)."""
    referrer = get_by_username(referrer_username or '')
    if not referrer or referrer['id'] == referee_id:
        return None
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT 1 FROM referrals WHERE referee_id=?'), (referee_id,))
        if cur.fetchone():
            return None                       # already referred by someone
        cur.execute(_ph('INSERT INTO referrals (referee_id, referrer_id, created_at) VALUES (?,?,?)'),
                    (referee_id, referrer['id'], time.time()))
        cur.execute(_ph('SELECT count(*) AS c FROM referrals WHERE referrer_id=?'), (referrer['id'],))
        count = cur.fetchone()['c']
        conn.commit()
        return {'referrer_id': referrer['id'], 'count': count}
    except DUP_ERRORS:
        return None
    finally:
        conn.close()


def referral_count(user_id):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT count(*) AS c FROM referrals WHERE referrer_id=?'), (user_id,))
        return cur.fetchone()['c']
    finally:
        conn.close()


def get_stats(user_id):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT count(*) AS c FROM referrals WHERE referrer_id=?'), (user_id,))
        referrals = cur.fetchone()['c']
        cur.execute(_ph('''SELECT games, wins, total_score, best_score, plays_correct, plays_total,
                                  rating, rd, ranked_games, ranked_wins FROM stats WHERE user_id=?'''),
                    (user_id,))
        r = cur.fetchone()
        if not r:
            return {'games': 0, 'wins': 0, 'total_score': 0, 'best_score': None, 'accuracy': None,
                    'rank': None, 'rating': None, 'ranked_games': 0, 'ranked_wins': 0, 'ranked_rank': None,
                    'referrals': referrals}
        # Ranked ladder rank (by rating, among players who've played ranked).
        ranked_rank = None
        if r['ranked_games'] > 0:
            cur.execute(_ph('SELECT count(*) AS c FROM stats WHERE ranked_games > 0 AND rating > ?'), (r['rating'],))
            ranked_rank = cur.fetchone()['c'] + 1
        return {'games': r['games'], 'wins': r['wins'], 'total_score': r['total_score'],
                'best_score': r['best_score'], 'accuracy': _accuracy(r['plays_correct'], r['plays_total']),
                'rank': ranked_rank,
                'rating': round(r['rating']) if r['ranked_games'] > 0 else None,
                'ranked_games': r['ranked_games'], 'ranked_wins': r['ranked_wins'],
                'referrals': referrals}
    finally:
        conn.close()


def get_leaderboard(limit=10):
    conn = _connect()
    try:
        cur = conn.cursor()
        # Ranked players (by Glicko rating) first, then casual players by wins.
        cur.execute(_ph('''SELECT u.username, s.games, s.wins, s.best_score, s.plays_correct, s.plays_total,
                                  s.rating, s.ranked_games, s.ranked_wins
                           FROM stats s JOIN users u ON u.id = s.user_id
                           ORDER BY (CASE WHEN s.ranked_games > 0 THEN 1 ELSE 0 END) DESC,
                                    s.rating DESC, s.wins DESC, s.games DESC LIMIT ?'''), (limit,))
        return [{'username': r['username'], 'games': r['games'], 'wins': r['wins'],
                 'best_score': r['best_score'], 'accuracy': _accuracy(r['plays_correct'], r['plays_total']),
                 'rating': round(r['rating']) if r['ranked_games'] > 0 else None,
                 'ranked_games': r['ranked_games'], 'ranked_wins': r['ranked_wins']}
                for r in cur.fetchall()]
    finally:
        conn.close()
