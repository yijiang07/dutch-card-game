"""SQLite persistence for user identities and friendships.

Synchronous sqlite3 is fine at this scale — every call is a tiny indexed
query. The DB path can be overridden with the DUTCH_DB env var (e.g. to put
it on a mounted disk in production)."""

import hashlib
import os
import re
import secrets
import sqlite3
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('DUTCH_DB', os.path.join(BASE_DIR, 'dutch.db'))

USERNAME_RE = re.compile(r'^[A-Za-z0-9_]{3,16}$')


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with _conn() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            secret_hash TEXT NOT NULL,
            created_at REAL NOT NULL
        )''')
        # One row per user pair; (low, high) is the pair sorted by id so a
        # relationship in either direction maps to the same row.
        c.execute('''CREATE TABLE IF NOT EXISTS relations (
            low TEXT NOT NULL,
            high TEXT NOT NULL,
            requester TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (low, high)
        )''')


def _hash(s):
    return hashlib.sha256(s.encode()).hexdigest()


def create_user(username):
    username = (username or '').strip()
    if not USERNAME_RE.match(username):
        raise ValueError('Usernames are 3-16 letters, numbers, or underscores.')
    uid = secrets.token_hex(8)
    secret = secrets.token_urlsafe(24)
    try:
        with _conn() as c:
            c.execute('INSERT INTO users (id, username, secret_hash, created_at) VALUES (?,?,?,?)',
                      (uid, username, _hash(secret), time.time()))
    except sqlite3.IntegrityError:
        raise ValueError('That username is taken.')
    return {'id': uid, 'username': username, 'secret': secret}


def verify_user(uid, secret):
    with _conn() as c:
        r = c.execute('SELECT id, username, secret_hash FROM users WHERE id=?', (uid,)).fetchone()
    if r and r['secret_hash'] == _hash(secret or ''):
        return {'id': r['id'], 'username': r['username']}
    return None


def get_by_username(username):
    with _conn() as c:
        r = c.execute('SELECT id, username FROM users WHERE username=?', ((username or '').strip(),)).fetchone()
    return {'id': r['id'], 'username': r['username']} if r else None


def _pair(a, b):
    return (a, b) if a < b else (b, a)


def request_friend(from_id, to_id):
    """Returns 'pending' or, if the other user had already requested, 'accepted'."""
    if from_id == to_id:
        raise ValueError("You can't friend yourself.")
    low, high = _pair(from_id, to_id)
    with _conn() as c:
        r = c.execute('SELECT * FROM relations WHERE low=? AND high=?', (low, high)).fetchone()
        if r:
            if r['status'] == 'accepted':
                raise ValueError("You're already friends.")
            if r['requester'] == from_id:
                raise ValueError('Request already sent.')
            c.execute('UPDATE relations SET status=? WHERE low=? AND high=?', ('accepted', low, high))
            return 'accepted'
        c.execute('INSERT INTO relations (low, high, requester, status) VALUES (?,?,?,?)',
                  (low, high, from_id, 'pending'))
        return 'pending'


def respond_friend(user_id, other_id, accept):
    low, high = _pair(user_id, other_id)
    with _conn() as c:
        r = c.execute('SELECT * FROM relations WHERE low=? AND high=?', (low, high)).fetchone()
        if not r or r['status'] != 'pending' or r['requester'] == user_id:
            raise ValueError('No such friend request.')
        if accept:
            c.execute('UPDATE relations SET status=? WHERE low=? AND high=?', ('accepted', low, high))
        else:
            c.execute('DELETE FROM relations WHERE low=? AND high=?', (low, high))


def remove_relation(user_id, other_id):
    """Unfriend, or cancel an outgoing request."""
    low, high = _pair(user_id, other_id)
    with _conn() as c:
        c.execute('DELETE FROM relations WHERE low=? AND high=?', (low, high))


def relations_of(user_id):
    out = {'friends': [], 'incoming': [], 'outgoing': []}
    with _conn() as c:
        rows = c.execute('SELECT * FROM relations WHERE low=? OR high=?', (user_id, user_id)).fetchall()
        for r in rows:
            other = r['high'] if r['low'] == user_id else r['low']
            u = c.execute('SELECT id, username FROM users WHERE id=?', (other,)).fetchone()
            if not u:
                continue
            info = {'id': u['id'], 'username': u['username']}
            if r['status'] == 'accepted':
                out['friends'].append(info)
            elif r['requester'] == user_id:
                out['outgoing'].append(info)
            else:
                out['incoming'].append(info)
    for k in out:
        out[k].sort(key=lambda u: u['username'].lower())
    return out
