"""Persistence for user identities and friendships.

Uses Postgres when DATABASE_URL is set (durable, for production), and falls
back to a local SQLite file otherwise (zero-config for local dev / preview).
Both backends expose the same synchronous functions; friend/identity calls are
infrequent (login, add friend, etc.) so a fresh connection per call is fine.
"""

import hashlib
import os
import re
import secrets
import time

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
    return hashlib.sha256(s.encode()).hexdigest()


def init_db():
    ts_type = 'DOUBLE PRECISION' if USE_PG else 'REAL'
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(f'''CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            secret_hash TEXT NOT NULL,
            created_at {ts_type} NOT NULL
        )''')
        # Case-insensitive uniqueness via an expression index (both backends).
        cur.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uname ON users (lower(username))')
        # One row per user pair; (low, high) sorted by id so a relationship in
        # either direction maps to the same row.
        cur.execute('''CREATE TABLE IF NOT EXISTS relations (
            low TEXT NOT NULL,
            high TEXT NOT NULL,
            requester TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (low, high)
        )''')
        conn.commit()
    finally:
        conn.close()


def create_user(username):
    username = (username or '').strip()
    if not USERNAME_RE.match(username):
        raise ValueError('Usernames are 3-16 letters, numbers, or underscores.')
    uid = secrets.token_hex(8)
    secret = secrets.token_urlsafe(24)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('INSERT INTO users (id, username, secret_hash, created_at) VALUES (?,?,?,?)'),
                    (uid, username, _hash(secret), time.time()))
        conn.commit()
    except DUP_ERRORS:
        raise ValueError('That username is taken.')
    finally:
        conn.close()
    return {'id': uid, 'username': username, 'secret': secret}


def verify_user(uid, secret):
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_ph('SELECT id, username, secret_hash FROM users WHERE id=?'), (uid,))
        r = cur.fetchone()
    finally:
        conn.close()
    if r and r['secret_hash'] == _hash(secret or ''):
        return {'id': r['id'], 'username': r['username']}
    return None


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
