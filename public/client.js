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
let reclaimTried = false;

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('dutchProfile') || 'null'); }
  catch (e) { return null; }
}
function saveProfile(p) { localStorage.setItem('dutchProfile', JSON.stringify(p)); }
function clearProfile() { localStorage.removeItem('dutchProfile'); friendsState = null; }

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
    latestState = data.state;
    myId = latestState.youId;
    swapArmed = false;
  } else if (data.type === 'privateReveal') {
    showRevealModal(data);
  } else if (data.type === 'identity') {
    const prof = loadProfile() || {};
    saveProfile({ userId: data.userId, secret: data.secret || prof.secret, username: data.username });
  } else if (data.type === 'identityFailed') {
    // Server no longer knows this account (e.g. data reset) — reclaim the name once.
    const prof = loadProfile();
    clearProfile();
    if (prof && prof.username && !reclaimTried) {
      reclaimTried = true;
      sendMsg({ type: 'identify', username: prof.username });
    }
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
  return el(`<div class="card front ${color} ${sizeClass}">
    <div>${card.rank}</div><div>${SUIT_SYMBOL[card.suit]}</div>
  </div>`);
}

function cardBack(sizeClass) {
  return el(`<div class="card back ${sizeClass}"></div>`);
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
  fab.onclick = () => { friendsPanelOpen = !friendsPanelOpen; refreshFriendsPanel(); };
  return fab;
}

function refreshFriendsPanel() {
  const root = document.getElementById('panel-root');
  root.innerHTML = '';
  if (!friendsPanelOpen) return;
  root.appendChild(renderFriendsPanel());
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
    drawer.appendChild(el(`<p class="help-text">Claim a username so friends can find you. You'll stay signed in on this browser — no password needed.</p>`));
    const form = el(`<div class="col">
      <input type="text" id="claim-input" placeholder="username (3–16 letters/numbers)" maxlength="16" autocomplete="off" />
      <button class="btn-gold" id="claim-btn">Claim Username</button>
    </div>`);
    form.querySelector('#claim-btn').onclick = () => {
      const name = form.querySelector('#claim-input').value.trim();
      if (name) sendMsg({ type: 'identify', username: name });
    };
    form.querySelector('#claim-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') form.querySelector('#claim-btn').click();
    });
    drawer.appendChild(form);
    return overlay;
  }

  drawer.appendChild(el(`<div class="help-text">Signed in as <strong style="color:var(--ink);">${escapeHtml(prof.username)}</strong></div>`));

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

  if (!latestState) {
    app.appendChild(renderLanding());
  } else if (latestState.phase === 'lobby') {
    app.appendChild(renderLobby(latestState));
  } else if (latestState.phase === 'choosePeekCount') {
    app.appendChild(renderChoosePeekCount(latestState));
  } else if (latestState.phase === 'reveal') {
    app.appendChild(renderReveal(latestState));
  } else {
    app.appendChild(renderTable(latestState));
  }

  app.appendChild(friendsFab());
  refreshFriendsPanel();
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
  if (prof && prof.username) {
    wrap.querySelector('#create-name').value = prof.username;
    wrap.querySelector('#join-name').value = prof.username;
  }

  wrap.querySelector('#create-btn').onclick = () => {
    const name = wrap.querySelector('#create-name').value.trim();
    if (!name) { showToast('Enter your name first.', true); return; }
    sendMsg({ type: 'createRoom', name });
  };
  wrap.querySelector('#join-btn').onclick = () => {
    const name = wrap.querySelector('#join-name').value.trim();
    const code = wrap.querySelector('#join-code').value.trim();
    if (!name) { showToast('Enter your name first.', true); return; }
    if (!code) { showToast('Enter a room code.', true); return; }
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

/* ---------- Lobby ---------- */

function renderLobby(state) {
  const isHost = state.hostId === state.youId;
  const wrap = el(`<div class="lobby-wrap">
    <div class="room-code-box">
      <div class="label">ROOM CODE — SHARE THIS</div>
      <div class="code" id="room-code-text">${escapeHtml(state.code)}</div>
      <div class="copy-hint">Tap the code to copy</div>
    </div>
    <div class="player-chip-list" id="player-chips"></div>
    <div class="col" style="align-items:center;">
      ${isHost
        ? `<button class="btn-gold" id="start-btn" style="font-size:1.05rem; padding:14px 30px;" ${state.players.length < 2 ? 'disabled' : ''}>Start Game</button>
           <div class="help-text">${state.players.length < 2 ? 'Need at least 2 players to start.' : `Ready — ${state.players.length} players`}</div>`
        : `<div class="help-text">Waiting for the host to start the game…</div>`}
    </div>
  </div>`);

  wrap.querySelector('#room-code-text').onclick = () => {
    navigator.clipboard?.writeText(state.code).then(() => showToast('Room code copied!'));
  };

  const chipList = wrap.querySelector('#player-chips');
  state.players.forEach((p) => {
    const chip = el(`<div class="player-chip ${p.connected ? '' : 'offline'}"></div>`);
    chip.appendChild(avatarEl(p.id, state, 'sm'));
    const label = p.id === state.hostId ? `${p.name} (host)` : p.name;
    chip.appendChild(document.createTextNode(label + (p.isYou ? ' (you)' : '')));
    chipList.appendChild(chip);
  });

  if (isHost) {
    wrap.querySelector('#start-btn').onclick = () => sendMsg({ type: 'startGame' });
  }
  return wrap;
}

/* ---------- Choose peek count ---------- */

function renderChoosePeekCount(state) {
  const isChooser = state.peekChooserId === state.youId;
  const wrap = el(`<div class="lobby-wrap">
    <div class="card-panel" style="max-width:420px; text-align:center;">
      <h2>${isChooser ? 'Choose the peek count' : `${escapeHtml(nameOf(state, state.peekChooserId))} is choosing`}</h2>
      <div class="sub">Everyone will privately look at this many of their own 4 cards before play begins.</div>
      <div class="row center wrap" id="peek-buttons" style="margin-top:8px;"></div>
    </div>
  </div>`);
  const row = wrap.querySelector('#peek-buttons');
  if (isChooser) {
    for (let n = 0; n <= 4; n++) {
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
    <div class="room-tag" id="room-tag">Room ${escapeHtml(state.code)}</div>
  </div>`);
  topBar.querySelector('#room-tag').onclick = () => {
    navigator.clipboard?.writeText(state.code).then(() => showToast('Room code copied!'));
  };
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
    const card = el(`<div class="opp-card ${isActive ? 'active' : ''} ${isDutch ? 'dutch' : ''}"></div>`);
    const nameRow = el(`<div class="opp-name"></div>`);
    nameRow.appendChild(avatarEl(p.id, state, 'sm'));
    nameRow.appendChild(document.createTextNode(p.name));
    card.appendChild(nameRow);
    const tags = el(`<div class="opp-tags"></div>`);
    if (isActive) tags.appendChild(el(`<span class="mini-tag turn">TURN</span>`));
    if (isDutch) tags.appendChild(el(`<span class="mini-tag dutch">DUTCH</span>`));
    if (!p.connected) tags.appendChild(el(`<span class="mini-tag offline">OFFLINE</span>`));
    if (tags.children.length) card.appendChild(tags);

    const cardsRow = el(`<div class="row" style="gap:4px;"></div>`);
    for (let i = 0; i < p.gridSize; i++) {
      const c = cardBack('size-sm');
      const handler = cellClickHandler(state, p.id, i);
      if (handler) { c.classList.add('selectable'); c.onclick = handler; }
      if (isJackChosen(state, p.id, i)) c.classList.add('chosen');
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
  table.querySelector('#discard-slot').appendChild(state.discardTop ? cardFront(state.discardTop, 'size-md') : cardEmpty('size-md'));
  wrap.appendChild(table);

  // Your hand
  const myPlayer = state.players.find((p) => p.isYou);
  const handWrap = el(`<div class="your-hand-wrap"></div>`);
  let handLabel = 'Your Hand';
  if (myPlayer && myPlayer.id === state.dutchCallerId) handLabel = 'Your Hand — you called Dutch';
  handWrap.appendChild(el(`<div class="your-hand-label">${escapeHtml(handLabel)}</div>`));
  const handRow = el(`<div class="your-hand"></div>`);
  const myGridSize = myPlayer ? myPlayer.gridSize : 0;
  for (let i = 0; i < myGridSize; i++) {
    const c = cardBack('size-lg');
    const handler = cellClickHandler(state, me, i);
    if (handler) { c.classList.add('selectable'); c.onclick = handler; }
    if (isJackChosen(state, me, i)) c.classList.add('chosen');
    if (state.phase === 'peeking' && state.peekingPlayerId === me && state.peekedCells.includes(i)) c.classList.add('dimmed');
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

  if (state.currentPlayerId !== me) {
    bar.appendChild(el(`<span class="help-text">Waiting for ${escapeHtml(nameOf(state, state.currentPlayerId))}…</span>`));
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
    const flip = el(`<button class="btn-blue">Flip from Deck</button>`);
    flip.disabled = state.drawCount === 0 && !state.discardTop;
    flip.onclick = () => sendMsg({ type: 'flip' });
    const swap = el(`<button class="btn-blue">Swap with Discard</button>`);
    swap.disabled = !state.discardTop;
    swap.onclick = () => { swapArmed = true; render(); };
    bar.appendChild(flip); bar.appendChild(swap);
    return bar;
  }

  if (state.turnMode === 'endOfTurn') {
    const endBtn = el(`<button class="btn-gold">End Turn</button>`);
    endBtn.onclick = () => sendMsg({ type: 'endTurn' });
    const dutch = el(`<button class="btn-red">Call Dutch</button>`);
    dutch.onclick = () => sendMsg({ type: 'callDutch' });
    bar.appendChild(endBtn); bar.appendChild(dutch);
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
    <div class="row center" style="margin-top:20px;">
      ${isHost
        ? `<button class="btn-gold" id="play-again-btn" style="font-size:1.05rem; padding:14px 30px;">Play Again</button>`
        : `<span class="help-text">Waiting for the host to start a new round…</span>`}
    </div>
  </div>`);

  const rows = wrap.querySelector('#reveal-rows');
  reveal.forEach((r) => {
    const isWinner = r.total === minTotal;
    const row = el(`<div class="reveal-row ${isWinner ? 'winner' : ''}"></div>`);
    const nameDiv = el(`<div class="rname"></div>`);
    nameDiv.appendChild(avatarEl(r.id, state, 'sm'));
    nameDiv.appendChild(document.createTextNode(r.name));
    if (isWinner) nameDiv.appendChild(el(`<span class="badge-winner">WINNER</span>`));
    if (r.id === state.dutchCallerId) nameDiv.appendChild(el(`<span class="badge-winner" style="background:#e2564f;color:white;">DUTCH</span>`));
    row.appendChild(nameDiv);
    const cardsDiv = el(`<div class="rcards"></div>`);
    r.grid.forEach((c) => cardsDiv.appendChild(cardFront(c, 'size-sm')));
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
