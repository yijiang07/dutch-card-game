/* ---------- Connection & session ---------- */

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = ['H', 'D'];

let ws = null;
let wsOpen = false;
let myId = null;
let latestState = null;
let landingMode = null; // null | 'create' | 'join'
let swapArmed = false;
let reconnectDelay = 1000;
let reconnectTimer = null;

// sessionStorage (not localStorage) so each browser tab is its own player —
// with localStorage a second tab would silently rejoin as the first tab's player.
// Survives reloads; a fully closed tab means rejoining by room code.
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem('dutchSession') || 'null'); }
  catch (e) { return null; }
}
function saveSession(sess) { sessionStorage.setItem('dutchSession', JSON.stringify(sess)); }
function clearSession() { sessionStorage.removeItem('dutchSession'); }

// Durable identity for the friend system — localStorage on purpose (unlike the
// per-tab game session): all tabs in this browser are the same person.
let friendsState = null; // {friends, incoming, outgoing} pushed by the server
let friendsPanelOpen = false;

let tutorialOpen = false;
let tutorialIndex = 0;
let autoTutorialDone = false;

let authTab = 'login'; // 'login' | 'signup' | 'recover'
let leaderboardOpen = false;
let leaderboardData = null;

// Briefly reveal which card a player just swapped in from the discard pile.
let recentSwap = null;
let lastSwapSeq = 0;
let swapInitialized = false;

// Matching (drop a grid card of the discard top's rank) + the turn-start buffer.
let recentWrong = null;    // {playerId, cellIndex, card} — flashes a failed match
let lastMatchSeq = 0;
let matchInitialized = false;
let lastFlipSeq = 0;
let flipInitialized = false;
let prevMyTurn = false;
let titleFlash = null;
// Power highlights (Jack swap / Queen peek / Ace gift) — which cells were affected.
let recentJack = null, recentQueen = null, recentAce = null;
let lastJackSeq = 0, lastQueenSeq = 0, lastAceSeq = 0;
let powersInitialized = false;
let dealtSeq = 0;
let bufferUntil = 0;       // ms timestamp until which the current player can't flip/swap
let matchPauseUntil = 0;   // ms timestamp until which play is paused for a matcher
let uiTicker = null;       // re-renders while a buffer / match countdown is running
let discardPulse = false;  // brief pulse on the discard pile when a match lands

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('dutchProfile') || 'null'); }
  catch (e) { return null; }
}
function saveProfile(p) { localStorage.setItem('dutchProfile', JSON.stringify(p)); }
function clearProfile() { localStorage.removeItem('dutchProfile'); friendsState = null; }

function loadLastName() { try { return localStorage.getItem('dutchLastName') || ''; } catch (e) { return ''; } }
function saveLastName(n) { try { localStorage.setItem('dutchLastName', n); } catch (e) {} }

/* ---------- Sound effects (synthesized, no assets) ---------- */
const sound = {
  ctx: null,
  enabled: (() => { try { return localStorage.getItem('dutchSound') !== 'off'; } catch (e) { return true; } })(),
  unlock() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) {}
  },
  setEnabled(on) { this.enabled = on; try { localStorage.setItem('dutchSound', on ? 'on' : 'off'); } catch (e) {} },
  tone(freq, dur, type, vol, when) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + (when || 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.18, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t); osc.stop(t + dur + 0.02);
  },
  play(name) {
    if (!this.enabled) return;
    this.unlock();
    if (!this.ctx) return;
    switch (name) {
      case 'flip': this.tone(300, 0.12, 'triangle', 0.16); this.tone(190, 0.13, 'sine', 0.1, 0.03); break;
      case 'swap': this.tone(440, 0.09, 'triangle', 0.15); this.tone(580, 0.1, 'triangle', 0.13, 0.06); break;
      case 'match': this.tone(523, 0.12, 'sine', 0.2); this.tone(784, 0.18, 'sine', 0.2, 0.1); break;
      case 'wrong': this.tone(160, 0.24, 'sawtooth', 0.14); break;
      case 'dutch': this.tone(330, 0.16, 'square', 0.14); this.tone(247, 0.32, 'square', 0.14, 0.13); break;
      case 'turn': this.tone(660, 0.11, 'sine', 0.17); this.tone(880, 0.14, 'sine', 0.15, 0.09); break;
      case 'win': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.24, 'sine', 0.2, i * 0.11)); break;
    }
  },
};
document.addEventListener('pointerdown', () => sound.unlock(), { passive: true });

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsOpen = true;
    reconnectDelay = 1000;
    const prof = loadProfile();
    if (prof && prof.userId && prof.secret) {
      sendMsg({ type: 'identify', userId: prof.userId, secret: prof.secret });
    }
    const sess = loadSession();
    if (sess && sess.code && sess.token) {
      sendMsg({ type: 'rejoin', code: sess.code, token: sess.token });
    } else {
      render();
    }
  };

  ws.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch (e) { return; }
    handleServerMessage(data);
  };

  ws.onclose = () => {
    wsOpen = false;
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 6000);
  };

  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleServerMessage(data) {
  if (data.type === 'youAre') {
    myId = data.playerId;
    saveSession({ code: data.code, token: data.token });
  } else if (data.type === 'state') {
    const prev = latestState;
    latestState = data.state;
    myId = latestState.youId;
    swapArmed = false;
    detectSwapReveal(latestState);
    detectMatchReveal(latestState);
    detectFlip(latestState);
    detectPowers(latestState);
    detectYourTurn(latestState);
    updateTimers(latestState);
    // One-shot celebrations (fired outside render so they aren't re-triggered)
    if (latestState.finalRound && (!prev || !prev.finalRound) && latestState.dutchCallerId) {
      flashDutch(nameOf(latestState, latestState.dutchCallerId));
    }
    if (latestState.phase === 'reveal' && (!prev || prev.phase !== 'reveal')) {
      launchConfetti();
    }
  } else if (data.type === 'privateReveal') {
    showRevealModal(data);
  } else if (data.type === 'identity') {
    const prof = loadProfile() || {};
    saveProfile({ userId: data.userId, secret: data.secret || prof.secret, username: data.username, email: data.email || null });
    if (data.recoveryCode) showRecoveryModal(data.recoveryCode);
  } else if (data.type === 'identityFailed') {
    // Stored session is no longer valid (expired, logged out elsewhere, or data reset).
    clearProfile();
  } else if (data.type === 'loggedOut') {
    clearProfile();
  } else if (data.type === 'emote') {
    popEmote(data.playerId, data.emoji);
    return;
  } else if (data.type === 'leftRoom') {
    clearSession();
    latestState = null;
    friendsPanelOpen = false;
    leaderboardOpen = false;
  } else if (data.type === 'emailUpdated') {
    const prof = loadProfile();
    if (prof) { prof.email = data.email || null; saveProfile(prof); }
  } else if (data.type === 'statsUpdate') {
    showToast(data.won ? `🏆 You won! (${data.stats.wins} wins)` : `Game recorded (${data.stats.games} played)`);
  } else if (data.type === 'leaderboard') {
    leaderboardData = data;
    if (leaderboardOpen) renderLeaderboardRoot();
  } else if (data.type === 'friendsUpdate') {
    friendsState = { friends: data.friends, incoming: data.incoming, outgoing: data.outgoing };
  } else if (data.type === 'infoMsg') {
    showToast(data.message, false);
  } else if (data.type === 'gameInvite') {
    showInviteToast(data.fromUsername, data.code);
  } else if (data.type === 'errorMsg') {
    if (/reconnect|no longer exists/i.test(data.message)) clearSession();
    showToast(data.message, true);
  }
  render();
}

/* ---------- Utilities ---------- */

const AVATAR_COLORS = ['#e2564f', '#4f6bed', '#2fa66e', '#e8b93f', '#a259e6', '#e67e22', '#17a2b8', '#d63384'];

function avatarColor(playerId, state) {
  const idx = state.players.findIndex((p) => p.id === playerId);
  return AVATAR_COLORS[(idx >= 0 ? idx : 0) % AVATAR_COLORS.length];
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function nameOf(state, id) {
  const p = state.players.find((p) => p.id === id);
  return p ? p.name : '?';
}

function el(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstElementChild;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function avatarEl(playerId, state, sizeClass) {
  const p = state.players.find((pl) => pl.id === playerId);
  const a = el(`<div class="avatar ${sizeClass || ''}"></div>`);
  a.style.background = avatarColor(playerId, state);
  a.textContent = initials(p ? p.name : '?');
  return a;
}

function cardFront(card, sizeClass) {
  const color = RED_SUITS.includes(card.suit) ? 'red' : 'black';
  const s = SUIT_SYMBOL[card.suit];
  return el(`<div class="card front ${color} ${sizeClass}">
    <span class="corner tl">${card.rank}<br>${s}</span>
    <span class="pip">${s}</span>
    <span class="corner br">${card.rank}<br>${s}</span>
  </div>`);
}

function cardBack(sizeClass) {
  return el(`<div class="card back ${sizeClass}"></div>`);
}

function cardLabel(card) {
  return card ? `${card.rank}${SUIT_SYMBOL[card.suit]}` : '';
}

function cardEmpty(sizeClass) {
  return el(`<div class="card empty ${sizeClass}"></div>`);
}

function showToast(message, isError) {
  const root = document.getElementById('toast-root');
  const t = el(`<div class="toast ${isError ? 'error' : ''}">${escapeHtml(message)}</div>`);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s ease'; }, 2400);
  setTimeout(() => t.remove(), 2800);
}

function showRevealModal(data) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const title = data.context === 'peek' ? 'Your Peek' : 'Queen’s Peek';
  const box = el(`<div class="overlay">
    <div class="overlay-box">
      <h2>${title}</h2>
      <div class="big-card-wrap"></div>
      <button class="btn-blue" id="reveal-close-btn">Got it</button>
    </div>
  </div>`);
  const wrap = box.querySelector('.big-card-wrap');
  const c = cardFront(data.card, 'size-lg');
  c.classList.add('flip-in');
  wrap.appendChild(c);
  box.querySelector('#reveal-close-btn').onclick = () => { root.innerHTML = ''; };
  root.appendChild(box);
}

/* ---------- Friends ---------- */

function showInviteToast(fromUsername, code) {
  if (latestState && latestState.code === code) return; // already in that room
  const root = document.getElementById('toast-root');
  const t = el(`<div class="toast invite">
    <span>${escapeHtml(fromUsername)} invited you to game <strong>${escapeHtml(code)}</strong></span>
    <button class="btn-gold" id="inv-join">Join</button>
    <button class="btn-ghost" id="inv-close">✕</button>
  </div>`);
  t.querySelector('#inv-join').onclick = () => {
    const prof = loadProfile();
    clearSession();
    sendMsg({ type: 'joinRoom', name: (prof && prof.username) || 'Player', code });
    t.remove();
  };
  t.querySelector('#inv-close').onclick = () => t.remove();
  root.appendChild(t);
  setTimeout(() => t.remove(), 60000);
}

function friendsFab() {
  const incoming = friendsState ? friendsState.incoming.length : 0;
  const fab = el(`<button class="friends-fab" title="Friends">👥${incoming ? `<span class="fab-badge">${incoming}</span>` : ''}</button>`);
  fab.onclick = () => { friendsPanelOpen = !friendsPanelOpen; leaderboardOpen = false; refreshFriendsPanel(); };
  return fab;
}

function refreshFriendsPanel() {
  const root = document.getElementById('panel-root');
  root.innerHTML = '';
  if (leaderboardOpen) { root.appendChild(renderLeaderboard()); return; }
  if (friendsPanelOpen) root.appendChild(renderFriendsPanel());
}

function showRecoveryModal(code) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const box = el(`<div class="overlay" style="z-index:100;">
    <div class="overlay-box">
      <h2>Save your recovery code</h2>
      <p class="help-text">There's no email reset. If you ever forget your password, this code is the only way back into your account. Keep it somewhere safe.</p>
      <div class="recovery-code" id="rec-code">${escapeHtml(code)}</div>
      <div class="row center" style="gap:10px; margin-top:16px;">
        <button class="btn-ghost" id="rec-copy">Copy</button>
        <button class="btn-gold" id="rec-done">I've saved it</button>
      </div>
    </div>
  </div>`);
  box.querySelector('#rec-copy').onclick = () => navigator.clipboard?.writeText(code).then(() => showToast('Recovery code copied!'));
  box.querySelector('#rec-done').onclick = () => { root.innerHTML = ''; };
  root.appendChild(box);
}

function renderAuthForm() {
  const wrap = el(`<div class="col"></div>`);
  const tabs = el(`<div class="auth-tabs">
    <button class="auth-tab ${authTab === 'login' ? 'on' : ''}" data-tab="login">Log in</button>
    <button class="auth-tab ${authTab === 'signup' ? 'on' : ''}" data-tab="signup">Sign up</button>
  </div>`);
  tabs.querySelectorAll('.auth-tab').forEach((t) => {
    t.onclick = () => { authTab = t.dataset.tab; refreshFriendsPanel(); };
  });
  wrap.appendChild(tabs);

  if (authTab === 'recover') {
    wrap.appendChild(el(`<p class="help-text">Enter your username and recovery code to get back in and set a new password.</p>`));
    const form = el(`<div class="col">
      <input type="text" id="auth-user" placeholder="username" maxlength="16" autocomplete="username" />
      <input type="text" id="auth-code" placeholder="recovery code" autocomplete="off" />
      <input type="password" id="auth-newpw" placeholder="new password (min 6)" autocomplete="new-password" />
      <button class="btn-gold" id="auth-submit">Reset & log in</button>
    </div>`);
    form.querySelector('#auth-submit').onclick = () => {
      const u = form.querySelector('#auth-user').value.trim();
      const c = form.querySelector('#auth-code').value.trim();
      const pw = form.querySelector('#auth-newpw').value;
      if (u && c) sendMsg({ type: 'recover', username: u, code: c, newPassword: pw || undefined });
    };
    wrap.appendChild(form);

    wrap.appendChild(el(`<div class="section-label">Or email me a reset link</div>`));
    const emForm = el(`<div class="row">
      <input type="text" id="reset-ident" class="grow" placeholder="username or email" autocomplete="off" />
      <button class="btn-blue" id="reset-send">Send</button>
    </div>`);
    emForm.querySelector('#reset-send').onclick = () => {
      const v = emForm.querySelector('#reset-ident').value.trim();
      if (v) sendMsg({ type: 'requestEmailReset', identifier: v });
    };
    wrap.appendChild(emForm);

    const back = el(`<button class="btn-ghost" style="background:transparent;">← Back to log in</button>`);
    back.onclick = () => { authTab = 'login'; refreshFriendsPanel(); };
    wrap.appendChild(back);
    return wrap;
  }

  const isSignup = authTab === 'signup';
  wrap.appendChild(el(`<p class="help-text">${isSignup
    ? 'Create an account so friends can find you and you can log in from any device.'
    : 'Log in to see your friends and invites.'}</p>`));
  const form = el(`<div class="col">
    <input type="text" id="auth-user" placeholder="username (3–16 letters/numbers)" maxlength="16" autocomplete="username" />
    <input type="password" id="auth-pw" placeholder="password (min 6)" autocomplete="${isSignup ? 'new-password' : 'current-password'}" />
    ${isSignup ? '<input type="email" id="auth-email" placeholder="email (optional — for password resets)" autocomplete="email" />' : ''}
    <button class="btn-gold" id="auth-submit">${isSignup ? 'Create account' : 'Log in'}</button>
    ${isSignup ? '' : '<button class="btn-ghost" id="auth-forgot" style="background:transparent;">Forgot password?</button>'}
  </div>`);
  form.querySelector('#auth-submit').onclick = () => {
    const u = form.querySelector('#auth-user').value.trim();
    const pw = form.querySelector('#auth-pw').value;
    if (!u || !pw) { showToast('Enter a username and password.', true); return; }
    const msg = { type: isSignup ? 'signup' : 'login', username: u, password: pw };
    if (isSignup) { const em = form.querySelector('#auth-email').value.trim(); if (em) msg.email = em; }
    sendMsg(msg);
  };
  const forgot = form.querySelector('#auth-forgot');
  if (forgot) forgot.onclick = () => { authTab = 'recover'; refreshFriendsPanel(); };
  form.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') form.querySelector('#auth-submit').click(); });
  });
  wrap.appendChild(form);

  const guest = el(`<button class="btn-ghost" style="background:transparent; margin-top:4px;">Play as guest →</button>`);
  guest.onclick = () => { friendsPanelOpen = false; refreshFriendsPanel(); showToast('Playing as guest — create or join a game below.'); };
  wrap.appendChild(guest);
  return wrap;
}

function renderFriendsPanel() {
  const prof = loadProfile();
  const overlay = el(`<div class="overlay drawer-overlay"></div>`);
  overlay.onclick = (e) => { if (e.target === overlay) { friendsPanelOpen = false; refreshFriendsPanel(); } };
  const drawer = el(`<div class="friends-drawer"></div>`);
  overlay.appendChild(drawer);

  const header = el(`<div class="row between"><h2 style="margin:0; font-size:1.2rem;">Friends</h2><button class="btn-ghost" style="padding:6px 12px;">✕</button></div>`);
  header.querySelector('button').onclick = () => { friendsPanelOpen = false; refreshFriendsPanel(); };
  drawer.appendChild(header);

  if (!prof || !prof.username) {
    drawer.appendChild(renderAuthForm());
    return overlay;
  }

  const signedRow = el(`<div class="row between" style="align-items:center;">
    <div class="help-text">Signed in as <strong style="color:var(--ink);">${escapeHtml(prof.username)}</strong></div>
    <button class="btn-ghost" style="padding:6px 12px;">Log out</button>
  </div>`);
  signedRow.querySelector('button').onclick = () => {
    const p = loadProfile();
    sendMsg({ type: 'logout', secret: p && p.secret });
    clearProfile();
    refreshFriendsPanel();
  };
  drawer.appendChild(signedRow);

  // Email — enables "email me a reset link"
  const emailRow = el(`<div class="row">
    <input type="email" id="acct-email" class="grow" placeholder="add email for password resets" value="${escapeHtml(prof.email || '')}" autocomplete="email" />
    <button class="btn-ghost" id="acct-email-save" style="padding:8px 12px;">Save</button>
  </div>`);
  emailRow.querySelector('#acct-email-save').onclick = () => {
    sendMsg({ type: 'setEmail', email: emailRow.querySelector('#acct-email').value.trim() });
  };
  drawer.appendChild(emailRow);

  const addForm = el(`<div class="row">
    <input type="text" id="add-friend-input" class="grow" placeholder="Add friend by username" maxlength="16" autocomplete="off" />
    <button class="btn-blue" id="add-friend-btn">Add</button>
  </div>`);
  addForm.querySelector('#add-friend-btn').onclick = () => {
    const name = addForm.querySelector('#add-friend-input').value.trim();
    if (name) { sendMsg({ type: 'friendRequest', username: name }); addForm.querySelector('#add-friend-input').value = ''; }
  };
  addForm.querySelector('#add-friend-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addForm.querySelector('#add-friend-btn').click();
  });
  drawer.appendChild(addForm);

  const fs = friendsState || { friends: [], incoming: [], outgoing: [] };

  if (fs.incoming.length) {
    drawer.appendChild(el(`<div class="section-label">Requests</div>`));
    fs.incoming.forEach((u) => {
      const row = el(`<div class="friend-row">
        <span class="grow">${escapeHtml(u.username)}</span>
        <button class="btn-gold" style="padding:6px 12px;">Accept</button>
        <button class="btn-ghost" style="padding:6px 10px;">✕</button>
      </div>`);
      const [acceptBtn, declineBtn] = row.querySelectorAll('button');
      acceptBtn.onclick = () => sendMsg({ type: 'friendRespond', userId: u.id, accept: true });
      declineBtn.onclick = () => sendMsg({ type: 'friendRespond', userId: u.id, accept: false });
      drawer.appendChild(row);
    });
  }

  if (fs.outgoing.length) {
    drawer.appendChild(el(`<div class="section-label">Sent — waiting</div>`));
    fs.outgoing.forEach((u) => {
      const row = el(`<div class="friend-row">
        <span class="grow">${escapeHtml(u.username)}</span>
        <button class="btn-ghost" style="padding:6px 10px;" title="Cancel request">✕</button>
      </div>`);
      row.querySelector('button').onclick = () => sendMsg({ type: 'friendRemove', userId: u.id });
      drawer.appendChild(row);
    });
  }

  drawer.appendChild(el(`<div class="section-label">Friends (${fs.friends.length})</div>`));
  if (!fs.friends.length) {
    drawer.appendChild(el(`<div class="help-text">No friends yet — add someone by their username.</div>`));
  }
  const canInvite = latestState && latestState.phase === 'lobby';
  fs.friends.forEach((u) => {
    const row = el(`<div class="friend-row">
      <span class="online-dot ${u.online ? '' : 'off'}"></span>
      <span class="grow">${escapeHtml(u.username)}</span>
      ${canInvite && u.online ? '<button class="btn-blue" style="padding:6px 12px;">Invite</button>' : ''}
      <button class="btn-ghost" style="padding:6px 10px;" title="Unfriend">✕</button>
    </div>`);
    const btns = row.querySelectorAll('button');
    if (canInvite && u.online) {
      btns[0].onclick = () => sendMsg({ type: 'inviteFriend', userId: u.id });
      btns[1].onclick = () => sendMsg({ type: 'friendRemove', userId: u.id });
    } else {
      btns[0].onclick = () => sendMsg({ type: 'friendRemove', userId: u.id });
    }
    drawer.appendChild(row);
  });

  if (canInvite) {
    drawer.appendChild(el(`<div class="help-text">Online friends can be invited straight into your lobby.</div>`));
  }

  return overlay;
}

/* ---------- Tutorial ---------- */

function helpFab() {
  const fab = el(`<button class="help-fab" title="How to play">?</button>`);
  fab.onclick = () => openTutorial();
  return fab;
}

function soundFab() {
  const fab = el(`<button class="sound-fab" title="Sound">${sound.enabled ? '🔊' : '🔇'}</button>`);
  fab.onclick = () => {
    sound.setEnabled(!sound.enabled);
    if (sound.enabled) { sound.unlock(); sound.play('turn'); }
    fab.textContent = sound.enabled ? '🔊' : '🔇';
  };
  return fab;
}

/* ---------- Leaderboard ---------- */

function leaderboardFab() {
  const fab = el(`<button class="lb-fab" title="Leaderboard">🏆</button>`);
  fab.onclick = () => { leaderboardOpen = true; friendsPanelOpen = false; leaderboardData = null; sendMsg({ type: 'getLeaderboard' }); refreshFriendsPanel(); };
  return fab;
}

function renderLeaderboardRoot() { refreshFriendsPanel(); }

function renderLeaderboard() {
  const overlay = el(`<div class="overlay drawer-overlay"></div>`);
  overlay.onclick = (e) => { if (e.target === overlay) { leaderboardOpen = false; renderLeaderboardRoot(); } };
  const drawer = el(`<div class="friends-drawer"></div>`);
  overlay.appendChild(drawer);

  const header = el(`<div class="row between"><h2 style="margin:0; font-size:1.2rem;">🏆 Leaderboard</h2><button class="btn-ghost" style="padding:6px 12px;">✕</button></div>`);
  header.querySelector('button').onclick = () => { leaderboardOpen = false; renderLeaderboardRoot(); };
  drawer.appendChild(header);

  if (!leaderboardData) {
    drawer.appendChild(el(`<div class="help-text">Loading…</div>`));
    return overlay;
  }

  const board = leaderboardData.board || [];
  if (leaderboardData.myStats && leaderboardData.myUsername) {
    const s = leaderboardData.myStats;
    drawer.appendChild(el(`<div class="my-stats">
      <div class="section-label">Your stats</div>
      <div class="row wrap" style="gap:14px; margin-top:6px;">
        <span><strong>${s.wins}</strong> wins</span>
        <span><strong>${s.games}</strong> games</span>
        <span>best round <strong>${s.best_score == null ? '—' : s.best_score}</strong></span>
        <span>accuracy <strong>${s.accuracy == null ? '—' : s.accuracy + '%'}</strong></span>
        ${s.rank ? `<span>rank <strong>#${s.rank}</strong></span>` : ''}
      </div>
      <div class="help-text" style="margin-top:8px;">Accuracy = share of your draw/swap decisions that were the best move given what you knew at the time.</div>
    </div>`));
  } else {
    drawer.appendChild(el(`<div class="help-text">Log in (👥) to have your games counted on the leaderboard.</div>`));
  }

  drawer.appendChild(el(`<div class="section-label">Top players</div>`));
  const table = el(`<div class="lb-table"></div>`);
  table.appendChild(el(`<div class="lb-row lb-head"><span class="lb-rank">#</span><span class="grow">Player</span><span class="lb-num">Wins</span><span class="lb-num">Acc</span></div>`));
  if (!board.length) {
    table.appendChild(el(`<div class="help-text" style="padding:10px;">No games played yet — be the first!</div>`));
  }
  board.forEach((r, i) => {
    const mine = leaderboardData.myUsername && r.username === leaderboardData.myUsername;
    const row = el(`<div class="lb-row ${mine ? 'me' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="grow">${escapeHtml(r.username)}</span>
      <span class="lb-num">${r.wins}</span>
      <span class="lb-num">${r.accuracy == null ? '—' : r.accuracy + '%'}</span>
    </div>`);
    table.appendChild(row);
  });
  drawer.appendChild(table);
  return overlay;
}

function openTutorial() {
  tutorialOpen = true;
  tutorialIndex = 0;
  renderTutorialRoot();
}

function closeTutorial() {
  tutorialOpen = false;
  try { localStorage.setItem('dutchTutorialSeen', '1'); } catch (e) {}
  renderTutorialRoot();
}

function tutorialIllus(items, size) {
  const row = el(`<div class="tutorial-illus"></div>`);
  items.forEach((it) => {
    if (it === 'back') { row.appendChild(cardBack(size)); return; }
    if (it.gap) { row.appendChild(el(`<span class="tutorial-arrow">→</span>`)); return; }
    const wrap = el(`<div class="tutorial-card-wrap"></div>`);
    wrap.appendChild(cardFront(it.card, size));
    if (it.tag) wrap.appendChild(el(`<div class="tutorial-tag ${it.tagClass || ''}">${escapeHtml(it.tag)}</div>`));
    row.appendChild(wrap);
  });
  return row;
}

const TUTORIAL_PAGES = [
  {
    title: 'Welcome to Dutch',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus(['back', 'back', 'back', 'back'], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">Everyone gets a row of face-down cards. The goal is simple: have the <strong>lowest total score</strong> when someone calls “Dutch”. Low cards good, high cards bad — and memory matters.</div>`));
      return box;
    },
  },
  {
    title: 'What cards are worth',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: 'K', suit: 'H' }, tag: '0 — best!', tagClass: 'good' },
        { card: { rank: 'A', suit: 'S' }, tag: '1' },
        { card: { rank: 'K', suit: 'S' }, tag: '13 — worst', tagClass: 'bad' },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">
        Number cards are worth their face value. <strong>Ace = 1</strong>, <strong>Jack = 11</strong>, <strong>Queen = 12</strong>.<br/>
        The twist: a <strong>red King is 0</strong> (the best card in the game!), but a <strong>black King is 13</strong> (the worst).
      </div>`));
      return box;
    },
  },
  {
    title: 'Peek at the start',
    build: () => {
      const box = el(`<div></div>`);
      const row = el(`<div class="tutorial-illus"></div>`);
      row.appendChild(cardFront({ rank: '3', suit: 'C' }, 'size-md'));
      row.appendChild(cardFront({ rank: '7', suit: 'D' }, 'size-md'));
      row.appendChild(cardBack('size-md'));
      row.appendChild(cardBack('size-md'));
      box.appendChild(row);
      box.appendChild(el(`<div class="tutorial-body">Before play begins, one player picks a number (0–4). Everyone then <strong>secretly looks at that many of their own cards</strong>. Try to remember what and where they are!</div>`));
      return box;
    },
  },
  {
    title: 'On your turn',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: 'K', suit: 'D' } },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">Do <strong>one</strong> of two things:<br/>
        • <strong>Swap</strong> the face-up discard card into your row — replace a high card with this lower one to cut your score.<br/>
        • <strong>Flip</strong> the top of the draw pile onto the discard — mainly to trigger a power card.<br/>
        Then end your turn.</div>`));
      return box;
    },
  },
  {
    title: 'Power cards',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: 'J', suit: 'S' }, tag: 'swap' },
        { card: { rank: 'Q', suit: 'H' }, tag: 'peek' },
        { card: { rank: 'A', suit: 'C' }, tag: 'give' },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">When a <strong>J</strong>, <strong>Q</strong>, or <strong>A</strong> lands face-up (you flipped it, or discarded it from your row) its power fires:<br/>
        • <strong>Jack</strong> — blind-swap any two cards on the table.<br/>
        • <strong>Queen</strong> — secretly peek at any one card.<br/>
        • <strong>Ace</strong> — give a face-down card to any player (raising their score).</div>`));
      return box;
    },
  },
  {
    title: 'Matching',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: '7', suit: 'H' }, tag: 'discard' },
        { gap: true },
        { card: { rank: '7', suit: 'S' }, tag: 'your card' },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">If you know one of your face-down cards has the <strong>same rank</strong> as the discard-pile card (e.g. any two 7s, or two Kings), tap <strong>Match</strong> and pick it to drop it — now you have one fewer card. You can do this <strong>even when it isn't your turn</strong>! But guess wrong and you draw a <strong>penalty card</strong>. When a turn begins, the player waits a couple seconds first, so everyone gets a chance to match.</div>`));
      return box;
    },
  },
  {
    title: 'Calling “Dutch”',
    build: () => {
      const box = el(`<div></div>`);
      const chip = el(`<div class="tutorial-illus"><span class="tutorial-dutch-chip">Call Dutch</span></div>`);
      box.appendChild(chip);
      box.appendChild(el(`<div class="tutorial-body">Think you have the lowest total? Take your turn, then <strong>call Dutch</strong>. Everyone else gets <strong>one final turn</strong>, then all cards flip up and scores are revealed. Lowest wins — so call it when you're confident!</div>`));
      return box;
    },
  },
  {
    title: "You're ready!",
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(el(`<div class="tutorial-illus" style="font-size:2.4rem;">♠ ♥ ♣ ♦</div>`));
      box.appendChild(el(`<div class="tutorial-body"><strong>Create a game</strong> and share the code with friends, <strong>add bots</strong> to practice against, or open the 👥 menu to claim a username and add friends. Have fun!</div>`));
      return box;
    },
  },
];

function renderTutorialRoot() {
  const root = document.getElementById('tutorial-root');
  root.innerHTML = '';
  if (!tutorialOpen) return;

  const page = TUTORIAL_PAGES[tutorialIndex];
  const overlay = el(`<div class="overlay tutorial-overlay"></div>`);
  overlay.onclick = (e) => { if (e.target === overlay) closeTutorial(); };

  const box = el(`<div class="tutorial-box"></div>`);
  const skip = el(`<button class="tutorial-skip" title="Close">✕</button>`);
  skip.onclick = () => closeTutorial();
  box.appendChild(skip);
  box.appendChild(el(`<div class="tutorial-step">Step ${tutorialIndex + 1} of ${TUTORIAL_PAGES.length}</div>`));
  box.appendChild(el(`<div class="tutorial-title">${escapeHtml(page.title)}</div>`));
  box.appendChild(page.build());

  const dots = el(`<div class="tutorial-dots"></div>`);
  TUTORIAL_PAGES.forEach((_, i) => {
    const d = el(`<span class="tutorial-dot ${i === tutorialIndex ? 'on' : ''}"></span>`);
    d.onclick = () => { tutorialIndex = i; renderTutorialRoot(); };
    dots.appendChild(d);
  });

  const nav = el(`<div class="tutorial-nav"></div>`);
  const back = el(`<button class="btn-ghost">Back</button>`);
  back.style.visibility = tutorialIndex === 0 ? 'hidden' : 'visible';
  back.onclick = () => { if (tutorialIndex > 0) { tutorialIndex--; renderTutorialRoot(); } };
  nav.appendChild(back);
  nav.appendChild(dots);
  const isLast = tutorialIndex === TUTORIAL_PAGES.length - 1;
  const next = el(`<button class="btn-gold">${isLast ? "Let's play" : 'Next'}</button>`);
  next.onclick = () => { if (isLast) closeTutorial(); else { tutorialIndex++; renderTutorialRoot(); } };
  nav.appendChild(next);
  box.appendChild(nav);

  overlay.appendChild(box);
  root.appendChild(overlay);
}

function detectSwapReveal(state) {
  const ls = state && state.lastSwap;
  if (!ls) { lastSwapSeq = 0; swapInitialized = true; return; }
  if (swapInitialized && ls.seq > lastSwapSeq) {
    const seq = ls.seq;
    sound.play('swap');
    recentSwap = { playerId: ls.playerId, cellIndex: ls.cellIndex, card: ls.card, seq };
    setTimeout(() => {
      if (recentSwap && recentSwap.seq === seq) { recentSwap = null; render(); }
    }, 3500);
  }
  lastSwapSeq = ls.seq;
  swapInitialized = true;
}

function swapReveal(playerId, cellIndex) {
  return (recentSwap && recentSwap.playerId === playerId && recentSwap.cellIndex === cellIndex)
    ? recentSwap.card : null;
}

function detectMatchReveal(state) {
  const lm = state && state.lastMatch;
  if (!lm) { lastMatchSeq = 0; matchInitialized = true; return; }
  if (matchInitialized && lm.seq > lastMatchSeq) {
    const seq = lm.seq;
    if (lm.matched) {
      sound.play('match');
      discardPulse = true;
      setTimeout(() => { discardPulse = false; render(); }, 700);
    } else {
      sound.play('wrong');
      // A wrong match — briefly flash the mis-guessed card in red.
      recentWrong = { playerId: lm.playerId, cellIndex: lm.cellIndex, card: lm.card, seq };
      setTimeout(() => {
        if (recentWrong && recentWrong.seq === seq) { recentWrong = null; render(); }
      }, 2600);
    }
  }
  lastMatchSeq = lm.seq;
  matchInitialized = true;
}

function wrongReveal(playerId, cellIndex) {
  return (recentWrong && recentWrong.playerId === playerId && recentWrong.cellIndex === cellIndex)
    ? recentWrong.card : null;
}

function detectPowers(state) {
  if (!state) return;
  const clearLater = (which, seq) => setTimeout(() => {
    if (which === 'jack' && recentJack && recentJack.seq === seq) recentJack = null;
    else if (which === 'queen' && recentQueen && recentQueen.seq === seq) recentQueen = null;
    else if (which === 'ace' && recentAce && recentAce.seq === seq) recentAce = null;
    else return;
    render();
  }, 3200);

  const lj = state.lastJack;
  if (lj && powersInitialized && lj.seq > lastJackSeq) { recentJack = lj; sound.play('swap'); clearLater('jack', lj.seq); }
  if (lj) lastJackSeq = lj.seq;

  const lq = state.lastQueen;
  if (lq && powersInitialized && lq.seq > lastQueenSeq) { recentQueen = lq; sound.play('turn'); clearLater('queen', lq.seq); }
  if (lq) lastQueenSeq = lq.seq;

  const la = state.lastAce;
  if (la && powersInitialized && la.seq > lastAceSeq) { recentAce = la; sound.play('wrong'); clearLater('ace', la.seq); }
  if (la) lastAceSeq = la.seq;

  powersInitialized = true;
}

// Returns a transient highlight for a grid cell affected by a recent power.
function cellFx(pid, i) {
  if (recentJack && ((recentJack.a.playerId === pid && recentJack.a.cellIndex === i) ||
                     (recentJack.b.playerId === pid && recentJack.b.cellIndex === i))) {
    return { cls: 'fx-jack', badge: '⇄' };
  }
  if (recentQueen && recentQueen.playerId === pid && recentQueen.cellIndex === i) {
    return { cls: 'fx-queen', badge: '👁' };
  }
  if (recentAce && recentAce.playerId === pid && recentAce.cellIndex === i) {
    return { cls: 'fx-ace', badge: '+' };
  }
  return null;
}

function applyCellFx(cardEl, pid, i) {
  const fx = cellFx(pid, i);
  if (fx) {
    cardEl.classList.add(fx.cls);
    cardEl.appendChild(el(`<span class="cell-badge ${fx.cls}-badge">${fx.badge}</span>`));
  }
}

function detectYourTurn(state) {
  const mine = state && state.phase === 'playing' && state.currentPlayerId === state.youId
    && (state.turnMode === 'awaitingAction' || state.turnMode === 'endOfTurn');
  if (mine && !prevMyTurn) {
    sound.play('turn');
    if (document.hidden) startTitleFlash();
  }
  if (!mine) stopTitleFlash();
  prevMyTurn = mine;
}

function startTitleFlash() {
  if (titleFlash) return;
  let on = false;
  titleFlash = setInterval(() => { document.title = on ? 'Dutch' : '▶ Your turn!'; on = !on; }, 900);
}
function stopTitleFlash() {
  if (titleFlash) { clearInterval(titleFlash); titleFlash = null; document.title = 'Dutch'; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTitleFlash(); });

function detectFlip(state) {
  const lf = state && state.lastFlip;
  if (!lf) { lastFlipSeq = 0; flipInitialized = true; return; }
  if (flipInitialized && lf.seq > lastFlipSeq) {
    sound.play('flip');
    // let render() paint the new discard first, then fly a card over it
    requestAnimationFrame(() => flyFlip(lf.card));
  }
  lastFlipSeq = lf.seq;
  flipInitialized = true;
}

// Animate a card travelling from the draw pile to the discard pile, flipping face-up.
function flyFlip(card) {
  const root = document.getElementById('fx-root');
  const draw = document.getElementById('draw-slot');
  const disc = document.getElementById('discard-slot');
  if (!root || !draw || !disc) return;
  const from = draw.getBoundingClientRect();
  const to = disc.getBoundingClientRect();
  if (!from.width || !to.width) return;

  // hide the real discard card until the flying one lands, so the reveal feels live
  const discCard = disc.querySelector('.card');
  if (discCard) discCard.style.visibility = 'hidden';

  const color = RED_SUITS.includes(card.suit) ? 'red' : 'black';
  const fly = el(`<div class="fly-card">
    <div class="fly-inner">
      <div class="fly-face card back size-md"></div>
      <div class="fly-face fly-front card front ${color} size-md">
        <span class="corner tl">${card.rank}<br>${SUIT_SYMBOL[card.suit]}</span>
        <span class="pip">${SUIT_SYMBOL[card.suit]}</span>
        <span class="corner br">${card.rank}<br>${SUIT_SYMBOL[card.suit]}</span>
      </div>
    </div>
  </div>`);
  fly.style.left = from.left + 'px';
  fly.style.top = from.top + 'px';
  fly.style.width = from.width + 'px';
  fly.style.height = from.height + 'px';
  root.appendChild(fly);

  const dx = to.left - from.left;
  const dy = to.top - from.top;
  requestAnimationFrame(() => {
    fly.style.transform = `translate(${dx}px, ${dy}px)`;
    fly.querySelector('.fly-inner').style.transform = 'rotateY(180deg)';
  });
  setTimeout(() => {
    fly.remove();
    if (discCard) discCard.style.visibility = '';
  }, 560);
}

/* ---------- Emotes ---------- */

function emoteFab() {
  const fab = el(`<button class="emote-fab" title="React">😀</button>`);
  fab.onclick = (e) => { e.stopPropagation(); sound.unlock(); toggleEmotePicker(); };
  return fab;
}

function toggleEmotePicker() {
  const root = document.getElementById('fx-root');
  if (!root) return;
  const existing = document.getElementById('emote-picker');
  if (existing) { existing.remove(); return; }
  const p = el(`<div id="emote-picker" class="emote-picker"></div>`);
  ['👍', '😂', '😮', '🎉', '😎', '😢', '🔥', '🤔'].forEach((em) => {
    const b = el(`<button>${em}</button>`);
    b.onclick = () => { sendMsg({ type: 'emote', emoji: em }); p.remove(); };
    p.appendChild(b);
  });
  root.appendChild(p);
  setTimeout(() => document.addEventListener('pointerdown', function h() {
    p.remove(); document.removeEventListener('pointerdown', h);
  }, { once: true }), 0);
}

function popEmote(playerId, emoji) {
  const root = document.getElementById('fx-root');
  if (!root) return;
  const anchor = document.querySelector(`[data-pid="${playerId}"]`);
  let x = window.innerWidth / 2, y = window.innerHeight / 2;
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + 8; }
  const e = el(`<div class="emote-pop">${emoji}</div>`);
  e.style.left = x + 'px';
  e.style.top = y + 'px';
  root.appendChild(e);
  setTimeout(() => e.remove(), 1700);
}

/* ---------- Deal-out animation ---------- */

function maybeDeal(state) {
  if (!state || (state.phase !== 'peeking' && state.phase !== 'playing')) return;
  if (!state.dealSeq || state.dealSeq === dealtSeq) return;
  dealtSeq = state.dealSeq;
  requestAnimationFrame(() => requestAnimationFrame(dealAnimation));
}

function dealAnimation() {
  const root = document.getElementById('fx-root');
  const deck = document.getElementById('draw-slot');
  if (!root || !deck) return;
  const from = deck.getBoundingClientRect();
  if (!from.width) return;
  const cells = [...document.querySelectorAll('.opponents-row .opp-card .row .card, .your-hand .card')];
  cells.forEach((cell, idx) => {
    const to = cell.getBoundingClientRect();
    if (!to.width) return;
    cell.style.visibility = 'hidden';
    const fly = el(`<div class="card back deal-fly"></div>`);
    fly.style.left = from.left + 'px';
    fly.style.top = from.top + 'px';
    fly.style.width = from.width + 'px';
    fly.style.height = from.height + 'px';
    root.appendChild(fly);
    const delay = idx * 55;
    setTimeout(() => {
      fly.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;
      fly.style.width = to.width + 'px';
      fly.style.height = to.height + 'px';
    }, delay + 20);
    setTimeout(() => { cell.style.visibility = ''; fly.remove(); }, delay + 430);
  });
}

function updateTimers(state) {
  const bufMine = state && state.phase === 'playing' && state.currentPlayerId === state.youId
    && state.turnMode === 'awaitingAction' && state.actWaitMs > 0 && !state.matcherId;
  bufferUntil = bufMine ? Date.now() + state.actWaitMs : 0;
  matchPauseUntil = (state && state.matcherId) ? Date.now() + state.matchWaitMs : 0;

  const active = () => bufferRemainingMs() > 0 || matchPauseRemainingMs() > 0;
  if (active() && !uiTicker) {
    uiTicker = setInterval(tickCountdowns, 300);
  } else if (!active() && uiTicker) {
    clearInterval(uiTicker); uiTicker = null;
  }
}

// Update only the countdown number while a timer runs, so continuous animations
// stay smooth; do one full re-render when the timer elapses (to re-enable buttons).
function tickCountdowns() {
  const bufR = bufferRemainingMs();
  const matchR = matchPauseRemainingMs();
  if (bufR <= 0 && matchR <= 0) {
    if (uiTicker) { clearInterval(uiTicker); uiTicker = null; }
    render();
    return;
  }
  const bc = document.getElementById('buffer-count');
  if (bc) bc.textContent = Math.ceil(bufR / 1000);
  const mc = document.getElementById('match-count');
  if (mc) mc.textContent = Math.ceil(matchR / 1000);
}

function bufferRemainingMs() { return Math.max(0, bufferUntil - Date.now()); }
function matchPauseRemainingMs() { return Math.max(0, matchPauseUntil - Date.now()); }

function leaveRoom() {
  if (!confirm('Leave this game? You can’t rejoin the same round.')) return;
  sendMsg({ type: 'leaveRoom' });
  clearSession();
  latestState = null;
  friendsPanelOpen = false;
  leaderboardOpen = false;
  recentSwap = null;
  lastSwapSeq = 0;
  render();
}

function leaveBtn(label) {
  const b = el(`<button class="btn-ghost leave-btn">${label || 'Leave'}</button>`);
  b.onclick = leaveRoom;
  return b;
}

/* ---------- Celebratory effects (one-shot, in #fx-root) ---------- */

function flashDutch(name) {
  sound.play('dutch');
  const root = document.getElementById('fx-root');
  if (!root) return;
  const fx = el(`<div class="dutch-flash"><div class="dutch-flash-text">DUTCH!</div><div class="dutch-flash-sub">${escapeHtml(name)} called it</div></div>`);
  root.appendChild(fx);
  setTimeout(() => fx.remove(), 1600);
}

function launchConfetti() {
  sound.play('win');
  const root = document.getElementById('fx-root');
  if (!root) return;
  const canvas = el(`<canvas class="confetti-canvas"></canvas>`);
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const W = canvas.width = window.innerWidth;
  const H = canvas.height = window.innerHeight;
  const colors = ['#e8b93f', '#3ddc84', '#4f6bed', '#e2564f', '#a259e6', '#ffffff'];
  const N = Math.min(160, Math.floor(W / 5));
  const parts = [];
  for (let i = 0; i < N; i++) {
    parts.push({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.5,
      r: 4 + Math.random() * 6,
      c: colors[i % colors.length],
      vx: -1.5 + Math.random() * 3,
      vy: 2 + Math.random() * 3.5,
      rot: Math.random() * Math.PI,
      vr: -0.2 + Math.random() * 0.4,
    });
  }
  const start = performance.now();
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - t / 3200);
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    });
    if (t < 3200) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

/* ---------- Root render ---------- */

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  if (!wsOpen && !latestState) {
    app.appendChild(el(`<div class="connecting-wrap">Connecting…</div>`));
    refreshFriendsPanel();
    return;
  }
  if (!wsOpen) {
    showToastOnce();
  }

  const onLanding = !latestState;
  const inLobby = latestState && latestState.phase === 'lobby';

  if (onLanding) {
    app.appendChild(renderLanding());
  } else if (inLobby) {
    app.appendChild(renderLobby(latestState));
  } else if (latestState.phase === 'choosePeekCount') {
    app.appendChild(renderChoosePeekCount(latestState));
  } else if (latestState.phase === 'reveal') {
    app.appendChild(renderReveal(latestState));
  } else {
    app.appendChild(renderTable(latestState));
  }

  app.appendChild(friendsFab());
  app.appendChild(leaderboardFab());
  app.appendChild(soundFab());
  if (onLanding || inLobby) app.appendChild(helpFab());
  if (latestState && latestState.code) app.appendChild(emoteFab());
  refreshFriendsPanel();

  // First-time players: auto-open the tutorial once on the landing screen.
  if (onLanding && !autoTutorialDone) {
    autoTutorialDone = true;
    let seen = false;
    try { seen = !!localStorage.getItem('dutchTutorialSeen'); } catch (e) {}
    if (!seen) openTutorial();
  }
  renderTutorialRoot();
  maybeDeal(latestState);
}

let toastedDisconnect = false;
function showToastOnce() {
  if (!toastedDisconnect) { toastedDisconnect = true; showToast('Connection lost — reconnecting…', true); }
}
window.addEventListener('online', () => {});

/* ---------- Landing ---------- */

function renderLanding() {
  const wrap = el(`<div class="landing-wrap">
    <div class="brand">
      <div class="suits">&spades; &hearts; &clubs; &diams;</div>
      <h1>DUTCH</h1>
      <div class="tagline">Lowest score wins. Play from anywhere.</div>
    </div>
    <div class="landing-cards">
      <div class="card-panel">
        <h2>Create a Game</h2>
        <div class="sub">Start a new table and invite others with a code.</div>
        <div class="col">
          <input type="text" id="create-name" placeholder="Your name" maxlength="20" autocomplete="off" />
          <button class="btn-gold" id="create-btn">Create Game</button>
        </div>
      </div>
      <div class="card-panel">
        <h2>Join a Game</h2>
        <div class="sub">Enter the code someone shared with you.</div>
        <div class="col">
          <input type="text" id="join-name" placeholder="Your name" maxlength="20" autocomplete="off" />
          <input type="text" id="join-code" class="code-input" placeholder="CODE" maxlength="4" autocomplete="off" />
          <button class="btn-blue" id="join-btn">Join Game</button>
        </div>
      </div>
    </div>
  </div>`);

  const prof = loadProfile();
  const savedName = (prof && prof.username) || loadLastName();
  if (savedName) {
    wrap.querySelector('#create-name').value = savedName;
    wrap.querySelector('#join-name').value = savedName;
  }

  // Invite link: /?join=CODE prefills the join form so friends join in one tap.
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) {
    wrap.querySelector('#join-code').value = joinCode.toUpperCase().slice(0, 4);
    const jn = wrap.querySelector('#join-name');
    setTimeout(() => (savedName ? wrap.querySelector('#join-btn') : jn).focus(), 50);
  }

  wrap.querySelector('#create-btn').onclick = () => {
    const name = wrap.querySelector('#create-name').value.trim();
    if (!name) { showToast('Enter your name first.', true); return; }
    saveLastName(name);
    sendMsg({ type: 'createRoom', name });
  };
  wrap.querySelector('#join-btn').onclick = () => {
    const name = wrap.querySelector('#join-name').value.trim();
    const code = wrap.querySelector('#join-code').value.trim();
    if (!name) { showToast('Enter your name first.', true); return; }
    if (!code) { showToast('Enter a room code.', true); return; }
    saveLastName(name);
    sendMsg({ type: 'joinRoom', name, code });
  };
  wrap.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const panel = inp.closest('.card-panel');
        panel.querySelector('button').click();
      }
    });
  });
  return wrap;
}

/* ---------- Game settings (lobby) ---------- */

function renderSettings(state, isHost) {
  const s = state.settings || { cardsPer: 4, bufferSeconds: 2.5, matching: true, turnLimit: 30 };
  if (!isHost) {
    const lim = s.turnLimit ? `${s.turnLimit}s turn limit` : 'no turn limit';
    return el(`<div class="settings-box"><div class="section-label" style="text-align:center;">House rules</div>
      <div class="help-text" style="text-align:center;">${s.cardsPer} cards · ${s.bufferSeconds}s match window · matching ${s.matching ? 'on' : 'off'} · ${lim}</div></div>`);
  }
  const box = el(`<div class="settings-box"><div class="section-label" style="text-align:center;">House rules</div></div>`);
  const set = (patch) => sendMsg({ type: 'setSettings', settings: patch });

  const group = (label, options, current, key) => {
    const row = el(`<div class="settings-row"><span class="settings-label">${label}</span><div class="seg"></div></div>`);
    const seg = row.querySelector('.seg');
    options.forEach(([val, text]) => {
      const b = el(`<button class="seg-btn ${current === val ? 'on' : ''}">${text}</button>`);
      b.onclick = () => set({ [key]: val });
      seg.appendChild(b);
    });
    return row;
  };

  box.appendChild(group('Cards each', [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']], s.cardsPer, 'cardsPer'));
  box.appendChild(group('Match window', [[0, 'off'], [1.5, '1.5s'], [2.5, '2.5s'], [4, '4s']], s.bufferSeconds, 'bufferSeconds'));
  box.appendChild(group('Matching', [[true, 'on'], [false, 'off']], s.matching, 'matching'));
  box.appendChild(group('Turn limit', [[0, 'off'], [15, '15s'], [30, '30s'], [45, '45s']], s.turnLimit, 'turnLimit'));
  return box;
}

/* ---------- Lobby ---------- */

function renderLobby(state) {
  const isHost = state.hostId === state.youId;
  const wrap = el(`<div class="lobby-wrap">
    <div class="room-code-box">
      <div class="label">ROOM CODE — SHARE THIS</div>
      <div class="code" id="room-code-text">${escapeHtml(state.code)}</div>
      <div class="copy-hint">Tap the code to copy</div>
      <button class="btn-ghost" id="copy-link-btn" style="margin-top:12px; padding:8px 16px; font-size:0.85rem;">🔗 Copy invite link</button>
    </div>
    <div class="player-chip-list" id="player-chips"></div>
    ${isHost ? `<div class="add-bot-box">
      <div class="section-label" style="text-align:center;">Add a bot</div>
      <div class="row center wrap" id="bot-buttons"></div>
    </div>` : ''}
    <div id="settings-box"></div>
    <div class="col" style="align-items:center;">
      ${isHost
        ? `<button class="btn-gold" id="start-btn" style="font-size:1.05rem; padding:14px 30px;" ${state.players.length < 2 ? 'disabled' : ''}>Start Game</button>
           <div class="help-text">${state.players.length < 2 ? 'Need at least 2 players to start.' : `Ready — ${state.players.length} players`}</div>`
        : `<div class="help-text">Waiting for the host to start the game…</div>`}
      <div id="lobby-leave" style="margin-top:6px;"></div>
    </div>
  </div>`);
  wrap.querySelector('#lobby-leave').appendChild(leaveBtn('Leave room'));

  wrap.querySelector('#room-code-text').onclick = () => {
    navigator.clipboard?.writeText(state.code).then(() => showToast('Room code copied!'));
  };
  wrap.querySelector('#copy-link-btn').onclick = () => {
    const link = `${location.origin}/?join=${state.code}`;
    navigator.clipboard?.writeText(link).then(() => showToast('Invite link copied!'))
      .catch(() => showToast(link));
  };
  wrap.querySelector('#settings-box').appendChild(renderSettings(state, isHost));

  const chipList = wrap.querySelector('#player-chips');
  state.players.forEach((p) => {
    const chip = el(`<div class="player-chip ${p.connected ? '' : 'offline'}"></div>`);
    chip.appendChild(avatarEl(p.id, state, 'sm'));
    const label = p.id === state.hostId ? `${p.name} (host)` : p.name;
    chip.appendChild(document.createTextNode(label + (p.isYou ? ' (you)' : '')));
    if (p.isBot) chip.appendChild(el(`<span class="diff-badge ${p.difficulty}">${difficultyLabel(p.difficulty)}</span>`));
    if (isHost && p.isBot) {
      const rm = el(`<button class="btn-ghost" style="padding:2px 8px; margin-left:2px;" title="Remove bot">✕</button>`);
      rm.onclick = () => sendMsg({ type: 'removeBot', botId: p.id });
      chip.appendChild(rm);
    }
    chipList.appendChild(chip);
  });

  if (isHost) {
    const botRow = wrap.querySelector('#bot-buttons');
    const full = state.players.length >= 8;
    [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['impossible', 'Impossible']].forEach(([diff, label]) => {
      const b = el(`<button class="btn-ghost diff-btn ${diff}">+ ${label}</button>`);
      b.disabled = full;
      b.onclick = () => sendMsg({ type: 'addBot', difficulty: diff });
      botRow.appendChild(b);
    });
    wrap.querySelector('#start-btn').onclick = () => sendMsg({ type: 'startGame' });
  }
  return wrap;
}

function difficultyLabel(diff) {
  return { easy: 'Easy', medium: 'Med', hard: 'Hard', impossible: 'Impossible' }[diff] || diff;
}

/* ---------- Choose peek count ---------- */

function renderChoosePeekCount(state) {
  const isChooser = state.peekChooserId === state.youId;
  const wrap = el(`<div class="lobby-wrap">
    <div class="card-panel" style="max-width:420px; text-align:center;">
      <h2>${isChooser ? 'Choose the peek count' : `${escapeHtml(nameOf(state, state.peekChooserId))} is choosing`}</h2>
      <div class="sub">Everyone will privately look at this many of their own ${state.cardsPer || 4} cards before play begins.</div>
      <div class="row center wrap" id="peek-buttons" style="margin-top:8px;"></div>
    </div>
  </div>`);
  const row = wrap.querySelector('#peek-buttons');
  if (isChooser) {
    for (let n = 0; n <= (state.cardsPer || 4); n++) {
      const b = el(`<button class="btn-blue">${n}</button>`);
      b.onclick = () => sendMsg({ type: 'choosePeekCount', count: n });
      row.appendChild(b);
    }
  } else {
    row.appendChild(el(`<div class="help-text">Hang tight…</div>`));
  }
  return wrap;
}

/* ---------- Main table (peeking + playing) ---------- */

function renderTable(state) {
  const me = state.youId;
  const wrap = el(`<div class="game-wrap"></div>`);

  const topBar = el(`<div class="top-bar">
    <div class="brand-mini">DUTCH</div>
    <div class="row" style="gap:8px;">
      <div class="room-tag" id="room-tag">Room ${escapeHtml(state.code)}</div>
    </div>
  </div>`);
  topBar.querySelector('#room-tag').onclick = () => {
    navigator.clipboard?.writeText(state.code).then(() => showToast('Room code copied!'));
  };
  topBar.querySelector('.row').appendChild(leaveBtn('Leave'));
  wrap.appendChild(topBar);

  const banner = turnBannerInfo(state);
  wrap.appendChild(el(`<div class="turn-banner ${banner.mine ? 'your-turn' : ''}">
    <div class="headline">${escapeHtml(banner.headline)}</div>
    ${banner.sub ? `<div class="sub">${escapeHtml(banner.sub)}</div>` : ''}
  </div>`));

  // Opponents
  const oppRow = el(`<div class="opponents-row"></div>`);
  state.players.filter((p) => !p.isYou).forEach((p) => {
    const isActive = p.id === state.currentPlayerId && state.phase === 'playing';
    const isDutch = p.id === state.dutchCallerId;
    const card = el(`<div class="opp-card ${isActive ? 'active' : ''} ${isDutch ? 'dutch' : ''}" data-pid="${p.id}"></div>`);
    const nameRow = el(`<div class="opp-name"></div>`);
    nameRow.appendChild(avatarEl(p.id, state, 'sm'));
    nameRow.appendChild(document.createTextNode((p.isBot ? '🤖 ' : '') + p.name));
    card.appendChild(nameRow);
    const tags = el(`<div class="opp-tags"></div>`);
    if (p.left) tags.appendChild(el(`<span class="mini-tag offline">LEFT</span>`));
    else if (p.isBot) tags.appendChild(el(`<span class="mini-tag bot ${p.difficulty}">${difficultyLabel(p.difficulty)}</span>`));
    if (isActive) tags.appendChild(el(`<span class="mini-tag turn">TURN</span>`));
    if (isDutch) tags.appendChild(el(`<span class="mini-tag dutch">DUTCH</span>`));
    if (!p.connected && !p.isBot) tags.appendChild(el(`<span class="mini-tag offline">OFFLINE</span>`));
    if (tags.children.length) card.appendChild(tags);

    const cardsRow = el(`<div class="row" style="gap:4px;"></div>`);
    for (let i = 0; i < p.gridSize; i++) {
      const wr = wrongReveal(p.id, i);
      const rc = swapReveal(p.id, i);
      let c;
      if (wr) { c = cardFront(wr, 'size-sm'); c.classList.add('just-wrong'); }
      else if (rc) { c = cardFront(rc, 'size-sm'); c.classList.add('just-swapped'); }
      else c = cardBack('size-sm');
      const handler = cellClickHandler(state, p.id, i);
      if (handler) { c.classList.add('selectable'); c.onclick = handler; }
      if (isJackChosen(state, p.id, i)) c.classList.add('chosen');
      applyCellFx(c, p.id, i);
      cardsRow.appendChild(c);
    }
    card.appendChild(cardsRow);
    oppRow.appendChild(card);
  });
  wrap.appendChild(oppRow);

  // Table area
  const table = el(`<div class="table-area">
    <div class="pile">
      <div class="pile-label">Draw (${state.drawCount})</div>
      <div id="draw-slot"></div>
    </div>
    <div class="pile">
      <div class="pile-label">Discard</div>
      <div id="discard-slot"></div>
    </div>
  </div>`);
  table.querySelector('#draw-slot').appendChild(state.drawCount > 0 ? cardBack('size-md') : cardEmpty('size-md'));
  const discardCard = state.discardTop ? cardFront(state.discardTop, 'size-md') : cardEmpty('size-md');
  if (discardPulse) discardCard.classList.add('just-matched');
  table.querySelector('#discard-slot').appendChild(discardCard);
  wrap.appendChild(table);

  // Your hand
  const myPlayer = state.players.find((p) => p.isYou);
  const handWrap = el(`<div class="your-hand-wrap" data-pid="${me}"></div>`);
  let handLabel = 'Your Hand';
  if (myPlayer && myPlayer.id === state.dutchCallerId) handLabel = 'Your Hand — you called Dutch';
  handWrap.appendChild(el(`<div class="your-hand-label">${escapeHtml(handLabel)}</div>`));
  const handRow = el(`<div class="your-hand"></div>`);
  const myGridSize = myPlayer ? myPlayer.gridSize : 0;
  for (let i = 0; i < myGridSize; i++) {
    const wr = wrongReveal(me, i);
    const rc = swapReveal(me, i);
    let c;
    if (wr) { c = cardFront(wr, 'size-lg'); c.classList.add('just-wrong'); }
    else if (rc) { c = cardFront(rc, 'size-lg'); c.classList.add('just-swapped'); }
    else c = cardBack('size-lg');
    const handler = cellClickHandler(state, me, i);
    if (handler) { c.classList.add('selectable'); c.onclick = handler; }
    if (isJackChosen(state, me, i)) c.classList.add('chosen');
    if (state.matcherId === me) c.classList.add('selectable');
    if (state.phase === 'peeking' && state.peekingPlayerId === me && state.peekedCells.includes(i)) c.classList.add('dimmed');
    applyCellFx(c, me, i);
    handRow.appendChild(c);
  }
  handWrap.appendChild(handRow);
  wrap.appendChild(handWrap);

  // Action bar
  wrap.appendChild(renderActionBar(state));

  // Log
  if (state.log && state.log.length) {
    wrap.appendChild(el(`<div class="log-panel">${state.log.map(escapeHtml).join('<br/>')}</div>`));
  }

  return wrap;
}

function turnBannerInfo(state) {
  const me = state.youId;
  if (state.matcherId) {
    return state.matcherId === me
      ? { headline: '⏸ Matching — pick a card', sub: 'Play is paused', mine: true }
      : { headline: `⏸ ${nameOf(state, state.matcherId)} is matching`, sub: 'Play is paused…', mine: false };
  }
  if (state.phase === 'peeking') {
    const p = state.peekingPlayerId;
    if (p === me) {
      return { headline: 'Your turn to peek', sub: `Look at ${state.peekCount} of your own cards (${state.peekedCells.length}/${state.peekCount} done)`, mine: true };
    }
    return { headline: `${nameOf(state, p)} is peeking at their cards`, sub: 'Everyone else, hang tight…', mine: false };
  }
  const cur = state.currentPlayerId;
  const mine = cur === me;
  let headline = mine ? 'Your turn' : `${nameOf(state, cur)}'s turn`;
  const subParts = [];
  if (state.finalRound) subParts.push(`Final round! ${nameOf(state, state.dutchCallerId)} called Dutch — ${state.finalRoundRemaining} turn(s) left`);
  if (state.turnMode === 'jackSwap') subParts.push(mine ? (state.jackFirst ? 'Jack: pick the second card' : 'Jack: pick the first card to swap') : 'Resolving a Jack…');
  else if (state.turnMode === 'queenPeek') subParts.push(mine ? 'Queen: pick any card to peek at' : 'Resolving a Queen…');
  else if (state.turnMode === 'aceGive') subParts.push(mine ? 'Ace: choose who receives a face-down card' : 'Resolving an Ace…');
  else if (state.turnMode === 'endOfTurn') subParts.push(mine ? 'End your turn — or call Dutch' : `${nameOf(state, cur)} is finishing their turn…`);
  return { headline, sub: subParts.join(' · '), mine };
}

function isJackChosen(state, playerId, cellIndex) {
  return state.jackFirst && state.jackFirst.playerId === playerId && state.jackFirst.cellIndex === cellIndex;
}

function cellClickHandler(state, playerId, cellIndex) {
  const me = state.youId;
  // Matching your own card is allowed any time during play, even off-turn.
  if (state.matcherId === me && state.phase === 'playing' && playerId === me) {
    return () => sendMsg({ type: 'matchCard', cellIndex });
  }
  if (state.phase === 'peeking') {
    if (playerId === me && state.peekingPlayerId === me) {
      return () => sendMsg({ type: 'peekCard', cellIndex });
    }
    return null;
  }
  if (state.phase !== 'playing') return null;
  if (state.currentPlayerId !== me) return null;
  if (state.turnMode === 'awaitingAction') {
    if (swapArmed && playerId === me) {
      return () => { swapArmed = false; sendMsg({ type: 'swapCell', cellIndex }); };
    }
    return null;
  }
  if (state.turnMode === 'jackSwap') {
    return () => sendMsg({ type: 'jackSelect', targetPlayerId: playerId, targetCellIndex: cellIndex });
  }
  if (state.turnMode === 'queenPeek') {
    return () => sendMsg({ type: 'queenSelect', targetPlayerId: playerId, targetCellIndex: cellIndex });
  }
  return null;
}

function renderActionBar(state) {
  const me = state.youId;
  const bar = el(`<div class="action-bar"></div>`);

  if (state.phase === 'peeking') {
    if (state.peekingPlayerId !== me) {
      bar.appendChild(el(`<span class="help-text">Waiting for ${escapeHtml(nameOf(state, state.peekingPlayerId))}…</span>`));
      return bar;
    }
    const doneBtn = el(`<button class="btn-gold">Done peeking</button>`);
    doneBtn.disabled = state.peekedCells.length < state.peekCount;
    doneBtn.onclick = () => sendMsg({ type: 'donePeeking' });
    bar.appendChild(doneBtn);
    return bar;
  }

  // I'm the one matching — pick a card (play is paused for everyone).
  if (state.matcherId === me) {
    const secs = Math.ceil(matchPauseRemainingMs() / 1000);
    bar.appendChild(el(`<span class="help-text">Matching! Tap one of your cards of the same rank as the discard (${escapeHtml(cardLabel(state.discardTop))}). Wrong = penalty card.${secs ? ` (<span id="match-count">${secs}</span>s)` : ''}</span>`));
    const cancel = el(`<button class="btn-ghost">Cancel</button>`);
    cancel.onclick = () => sendMsg({ type: 'cancelMatch' });
    bar.appendChild(cancel);
    return bar;
  }

  // Someone else is matching — everyone waits.
  if (state.matcherId) {
    const secs = Math.ceil(matchPauseRemainingMs() / 1000);
    bar.appendChild(el(`<span class="help-text">⏸ ${escapeHtml(nameOf(state, state.matcherId))} is matching — play paused${secs ? ` (<span id="match-count">${secs}</span>s)` : ''}…</span>`));
    return bar;
  }

  const canMatch = state.matchingEnabled && state.phase === 'playing' && state.discardTop
    && (state.turnMode === 'awaitingAction' || state.turnMode === 'endOfTurn');

  function matchButton() {
    const b = el(`<button class="btn-match">Match</button>`);
    b.onclick = () => { swapArmed = false; sendMsg({ type: 'claimMatch' }); };
    return b;
  }

  if (state.currentPlayerId !== me) {
    bar.appendChild(el(`<span class="help-text">Waiting for ${escapeHtml(nameOf(state, state.currentPlayerId))}…</span>`));
    if (canMatch) bar.appendChild(matchButton());
    return bar;
  }

  if (state.turnMode === 'awaitingAction') {
    if (swapArmed) {
      const cancel = el(`<button class="btn-ghost">Cancel</button>`);
      cancel.onclick = () => { swapArmed = false; render(); };
      bar.appendChild(el(`<span class="help-text">Click one of your own cards above.</span>`));
      bar.appendChild(cancel);
      return bar;
    }
    const remaining = bufferRemainingMs();
    const flip = el(`<button class="btn-blue">Flip from Deck</button>`);
    flip.disabled = remaining > 0 || (state.drawCount === 0 && !state.discardTop);
    flip.onclick = () => sendMsg({ type: 'flip' });
    const swap = el(`<button class="btn-blue">Swap with Discard</button>`);
    swap.disabled = remaining > 0 || !state.discardTop;
    swap.onclick = () => { swapArmed = true; render(); };
    bar.appendChild(flip); bar.appendChild(swap);
    if (canMatch) bar.appendChild(matchButton());
    if (remaining > 0) {
      bar.appendChild(el(`<span class="help-text" style="width:100%; text-align:center;">You can act in <span id="buffer-count">${Math.ceil(remaining / 1000)}</span>s — anyone can match the discard now.</span>`));
    }
    return bar;
  }

  if (state.turnMode === 'endOfTurn') {
    const endBtn = el(`<button class="btn-gold">End Turn</button>`);
    endBtn.onclick = () => sendMsg({ type: 'endTurn' });
    const dutch = el(`<button class="btn-red">Call Dutch</button>`);
    dutch.onclick = () => sendMsg({ type: 'callDutch' });
    bar.appendChild(endBtn); bar.appendChild(dutch);
    if (canMatch) bar.appendChild(matchButton());
    return bar;
  }

  if (state.turnMode === 'jackSwap') {
    bar.appendChild(el(`<span class="help-text">${state.jackFirst ? 'Click the second card to swap with.' : 'Click any card on the table to start the blind swap.'}</span>`));
    return bar;
  }
  if (state.turnMode === 'queenPeek') {
    bar.appendChild(el(`<span class="help-text">Click any card on the table to peek at it.</span>`));
    return bar;
  }
  if (state.turnMode === 'aceGive') {
    state.players.forEach((p) => {
      const b = el(`<button class="btn-blue">${escapeHtml(p.name)}${p.isYou ? ' (you)' : ''}</button>`);
      b.onclick = () => sendMsg({ type: 'aceGiveTo', targetPlayerId: p.id });
      bar.appendChild(b);
    });
    return bar;
  }
  return bar;
}

/* ---------- Reveal ---------- */

function renderReveal(state) {
  const isHost = state.hostId === state.youId;
  const reveal = state.reveal || [];
  const minTotal = Math.min(...reveal.map((r) => r.total));

  const wrap = el(`<div class="reveal-wrap">
    <div class="brand" style="margin-bottom:18px;">
      <h1 style="font-size:2rem;">Round Over</h1>
      <div class="tagline">All cards revealed</div>
    </div>
    <div id="reveal-rows"></div>
    <div id="series-standings"></div>
    <div class="row center" style="margin-top:20px;">
      ${isHost
        ? `<button class="btn-gold" id="play-again-btn" style="font-size:1.05rem; padding:14px 30px;">Play Again</button>`
        : `<span class="help-text">Waiting for the host to start a new round…</span>`}
    </div>
    <div class="row center" style="margin-top:12px;" id="reveal-leave"></div>
  </div>`);
  wrap.querySelector('#reveal-leave').appendChild(leaveBtn('Leave room'));

  // Cumulative match standings once more than one round has been played.
  const series = (state.series || []).slice().sort((a, b) => a.total - b.total);
  if (state.roundsPlayed > 1 && series.length) {
    const lead = series[0].total;
    const box = el(`<div class="series-box"><div class="section-label" style="text-align:center;">Match standings · ${state.roundsPlayed} rounds</div></div>`);
    series.forEach((s, i) => {
      const row = el(`<div class="series-row ${s.total === lead ? 'leader' : ''}">
        <span class="series-rank">${i + 1}</span>
        <span class="grow">${escapeHtml(s.name)}${s.id === state.youId ? ' (you)' : ''}</span>
        <span class="series-total">${s.total}</span>
      </div>`);
      box.appendChild(row);
    });
    wrap.querySelector('#series-standings').appendChild(box);
  }

  const rows = wrap.querySelector('#reveal-rows');
  let flipIdx = 0;
  reveal.forEach((r, ri) => {
    const isWinner = r.total === minTotal;
    const row = el(`<div class="reveal-row ${isWinner ? 'winner' : ''}"></div>`);
    row.style.animationDelay = `${ri * 0.12}s`;
    const nameDiv = el(`<div class="rname"></div>`);
    nameDiv.appendChild(avatarEl(r.id, state, 'sm'));
    nameDiv.appendChild(document.createTextNode(r.name));
    if (isWinner) nameDiv.appendChild(el(`<span class="badge-winner">🏆 WINNER</span>`));
    if (r.id === state.dutchCallerId) nameDiv.appendChild(el(`<span class="badge-winner" style="background:#e2564f;color:white;">DUTCH</span>`));
    row.appendChild(nameDiv);
    const cardsDiv = el(`<div class="rcards"></div>`);
    r.grid.forEach((c) => {
      const card = cardFront(c, 'size-sm');
      card.classList.add('flip-in');
      card.style.animationDelay = `${0.25 + flipIdx * 0.06}s`;
      flipIdx++;
      cardsDiv.appendChild(card);
    });
    row.appendChild(cardsDiv);
    row.appendChild(el(`<div class="rtotal">${r.total} pts</div>`));
    rows.appendChild(row);
  });

  if (isHost) {
    wrap.querySelector('#play-again-btn').onclick = () => sendMsg({ type: 'playAgain' });
  }
  return wrap;
}

/* ---------- Init ---------- */

connect();
render();
