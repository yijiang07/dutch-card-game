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
let langAsked = false;

let authTab = 'login'; // 'login' | 'signup' | 'recover'
let leaderboardOpen = false;
let leaderboardData = null;
let chatOpen = false;
let chatLog = [];
let chatUnread = 0;
let lastRankedUpdate = null;  // {rating, delta, won} for the most recent ranked round, shown on reveal
let publicRooms = [];         // joinable casual lobbies, shown on the landing
let publicRoomsTimer = null;

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
function clearProfile() { localStorage.removeItem('dutchProfile'); friendsState = null; applyTableFelt('classic'); }

function loadLastName() { try { return localStorage.getItem('dutchLastName') || ''; } catch (e) { return ''; } }
function saveLastName(n) { try { localStorage.setItem('dutchLastName', n); } catch (e) {} }

/* ---------- Internationalization ---------- */
const LANGS = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
];
const TRANSLATIONS = {
  en: {
    tagline: 'Lowest score wins. Play from anywhere.',
    createTitle: 'Create a Game', createSub: 'Start a new table and invite others with a code.',
    joinTitle: 'Join a Game', joinSub: 'Enter the code someone shared with you.',
    yourName: 'Your name', createGame: 'Create Game', joinGame: 'Join Game', codePlaceholder: 'CODE',
    flip: 'Flip from Deck', swap: 'Swap with Discard', match: 'Match', endTurn: 'End Turn',
    callDutch: 'Call Dutch', playAgain: 'Play Again', newMatch: 'New match', startGame: 'Start Game', leave: 'Leave',
    leaveRoom: 'Leave room', friends: 'Friends', chat: 'Chat', chatEmpty: 'No messages yet. Say hi!',
    chatPlaceholder: 'Message…', send: 'Send', howToPlay: 'How to play', yourTurn: 'Your turn',
    chooseLanguage: 'Choose your language', language: 'Language',
    // toasts
    enterName: 'Enter your name first.', enterCode: 'Enter a room code.',
    roomCodeCopied: 'Room code copied!', inviteLinkCopied: 'Invite link copied!',
    recoveryCopied: 'Recovery code copied!', playingGuest: 'Playing as guest — create or join a game below.',
    enterUserPass: 'Enter a username and password.', emailSaved: 'Email saved.',
    youWon: '🏆 You won! ({n} wins)', gameRecorded: 'Game recorded ({n} played)',
    // lobby
    roomShare: 'Room code — share this', tapCopy: 'Tap the code to copy', copyInvite: 'Copy invite link',
    addBotTitle: 'Add a bot', houseRules: 'House rules', cardsEach: 'Cards each', matchWindowLbl: 'Match window',
    matchingLbl: 'Matching', turnLimitLbl: 'Turn limit', optOff: 'off', optOn: 'on',
    needTwo: 'Need at least 2 players to start.', readyPlayers: 'Ready — {n} players',
    waitingHost: 'Waiting for the host to start the game…', hostTag: 'host', youTag: 'you', removeBot: 'Remove bot',
    rulesSummary: '{cards} cards · {win}s match window · matching {matching} · {limit}',
    turnLimitVal: '{n}s turn limit', noTurnLimit: 'no turn limit',
    diffEasy: 'Easy', diffMedium: 'Medium', diffMed: 'Med', diffHard: 'Hard', diffImpossible: 'Impossible',
    // peek
    choosePeek: 'Choose the peek count', isChoosing: '{name} is choosing',
    peekSub: 'Everyone will privately look at this many of their own {n} cards before play begins.',
    hangTight: 'Hang tight…', donePeeking: 'Done peeking',
    // table
    drawLbl: 'Draw', discardLbl: 'Discard', yourHand: 'Your Hand', yourHandDutch: 'Your Hand — you called Dutch',
    roomTag: 'Room {code}',
    // banners
    matchingPick: '⏸ Matching — pick a card', playPaused: 'Play is paused',
    xMatching: '⏸ {name} is matching', playPausedE: 'Play is paused…',
    yourTurnPeek: 'Your turn to peek', lookAtCards: 'Look at {n} of your own cards ({done}/{n} done)',
    xPeeking: '{name} is peeking at their cards', everyoneHang: 'Everyone else, hang tight…',
    xTurn: "{name}'s turn", finalRound: 'Final round! {name} called Dutch — {n} turn(s) left',
    jackSecondMsg: 'Jack: pick the second card', jackFirstMsg: 'Jack: pick the first card to swap',
    jackResolving: 'Resolving a Jack…', queenPickMsg: 'Queen: pick any card to peek at', queenResolving: 'Resolving a Queen…',
    aceChooseMsg: 'Ace: choose who receives a face-down card', aceResolving: 'Resolving an Ace…',
    endOrDutch: 'End your turn — or call Dutch', xFinishing: '{name} is finishing their turn…',
    // action bar
    waitingForX: 'Waiting for {name}…', matchPrompt: 'Matching! Tap one of your cards of the same rank as the discard ({card}). Wrong = penalty card.',
    cancel: 'Cancel', xMatchingPaused: '⏸ {name} is matching — play paused',
    clickOwnCard: 'Click one of your own cards above.', youCanAct: 'You can act in {n}s — anyone can match the discard now.',
    jackClickSecond: 'Click the second card to swap with.', jackClickAny: 'Click any card on the table to start the blind swap.',
    queenClickAny: 'Click any card on the table to peek at it.',
    // opponent tags
    tagLeft: 'LEFT', tagTurn: 'TURN', tagOffline: 'OFFLINE',
    // reveal
    roundOver: 'Round Over', allRevealed: 'All cards revealed', winner: 'WINNER', ptsUnit: 'pts',
    waitingNewRound: 'Waiting for the host to start a new round…', matchStandings: 'Match standings · {n} rounds',
    // reveal modal
    yourPeek: 'Your Peek', queensPeek: "Queen's Peek", gotIt: 'Got it',
    // fab tooltips
    soundTip: 'Sound', leaderboardTip: 'Leaderboard',
    // auth
    login: 'Log in', signup: 'Sign up',
    recoverIntro: 'Enter your username and recovery code to get back in and set a new password.',
    phUsername: 'username', phRecoveryCode: 'recovery code', phNewPw: 'new password (min 6)', resetLogin: 'Reset & log in',
    orEmailReset: 'Or email me a reset link', phUserOrEmail: 'username or email', backToLogin: '← Back to log in',
    signupIntro: 'Create an account so friends can find you and you can log in from any device.',
    loginIntro: 'Log in to see your friends and invites.', phUsernameRules: 'username (3–16 letters/numbers)',
    phPassword: 'password (min 6)', phEmailOpt: 'email (optional — for password resets)',
    createAccount: 'Create account', forgotPw: 'Forgot password?', playGuest: 'Play as guest →',
    // recovery modal
    saveRecovery: 'Save your recovery code',
    recoveryExplain: "There's no email reset. If you ever forget your password, this code is the only way back into your account. Keep it somewhere safe.",
    copy: 'Copy', savedIt: "I've saved it",
    // friends panel
    signedInAs: 'Signed in as', logout: 'Log out', phAddEmail: 'add email for password resets', save: 'Save',
    phAddFriend: 'Add friend by username', add: 'Add', requests: 'Requests', accept: 'Accept',
    sentWaiting: 'Sent — waiting', friendsCount: 'Friends ({n})', noFriends: 'No friends yet — add someone by their username.',
    invite: 'Invite', onlineInvite: 'Online friends can be invited straight into your lobby.',
    cancelRequest: 'Cancel request', unfriend: 'Unfriend', joinBtn: 'Join', invitedYou: '{name} invited you to game',
    // leaderboard
    leaderboardTitle: 'Leaderboard', loading: 'Loading…', yourStats: 'Your stats', statWins: 'wins', statGames: 'games',
    statBestRound: 'best round', statAccuracy: 'accuracy', statRank: 'rank',
    accuracyExplain: 'Accuracy = share of your draw/swap decisions that were the best move given what you knew at the time.',
    loginForLb: 'Log in (👥) to have your games counted on the leaderboard.', topPlayers: 'Top players',
    lbPlayer: 'Player', lbWins: 'Wins', lbAcc: 'Acc', noGames: 'No games played yet — be the first!',
    ranked1v1: 'Ranked 1v1', rankedNeedLogin: 'Log in to play ranked — open the 👥 menu.',
    rankedTag: 'Ranked 1v1', rankedRules: 'Standard rules · Glicko-rated',
    rankedWaitOpp: 'Share the code — waiting for an opponent to join…',
    ratingCol: 'Rating', recordCol: 'W–L', statRating: 'rating', statRanked: 'ranked', unranked: 'unranked',
    ratingToast: 'Ranked rating: {rating} ({delta})',
    authCta: 'Log in / Sign up', authCtaSub: 'Save your stats, add friends & play ranked.',
    powerYours: 'Matched power — your move!', powerOther: '{name} is using a matched power…',
    recentGames: 'Recent games', noHistory: 'No games yet — play a round!',
    liveGames: 'Live games — tap to join',
    finalMatch: 'Last chance to match!', finalMatchSub: 'Revealing scores…',
    histShed: 'Cards shed (matches)', histPowers: 'Powers used',
    tierBronze: 'Bronze', tierSilver: 'Silver', tierGold: 'Gold', tierPlatinum: 'Platinum', tierDiamond: 'Diamond', tierMaster: 'Master',
    achievementsLabel: 'Achievements', achUnlocked: 'Achievement unlocked',
    ach_first_win: 'First Win', ach_red_king: 'Red King', ach_perfect_round: 'Flawless Round', ach_shed3: 'Card Shark', ach_power3: 'Power Player', ach_low_score: 'Featherweight', ach_dutch_win: 'Called It', ach_ranked_win: 'Ranked Victory', ach_veteran: 'Veteran', ach_invite_1: 'Recruiter', ach_invite_5: 'Ambassador', ach_invite_10: 'Evangelist',
    inviteFriends: 'Invite friends', inviteCopied: 'Invite link copied!', inviteNeedLogin: 'Log in to get your invite link.', statInvited: 'invited',
    shareText: 'Play Dutch with me — lowest score wins!', referralJoined: 'A friend joined with your invite! ({n} total)',
    cardBacksLabel: 'Card backs', cardBacksHint: 'Unlock designs as you play — everyone at the table sees the back you equip.',
    backEquip: 'Equip', backEquippedTag: 'Equipped', backEquipped: '{name} equipped',
    back_classic: 'Classic', back_crimson: 'Crimson', back_emerald: 'Emerald', back_amber: 'Amber', back_royal: 'Royal', back_noir: 'Noir',
    backReqDefault: 'Always yours', backReqCrimson: 'Win a game', backReqEmerald: 'Play 10 games',
    backReqAmber: 'Invite a friend', backReqRoyal: 'Earn 5 achievements', backReqNoir: 'Reach Platinum (1700)',
    back_ocean: 'Ocean', back_rose: 'Rose', back_sunset: 'Sunset', back_frost: 'Frost', back_orchid: 'Orchid', back_aurora: 'Aurora',
    backReqOcean: 'Play 25 games', backReqRose: 'Win 5 games', backReqSunset: 'Win 25 games',
    backReqFrost: 'Invite 3 friends', backReqOrchid: 'Earn 10 achievements', backReqAurora: 'Reach Master (2000)',
    tableFeltsLabel: 'Table felt', tableFeltsHint: 'Set your table’s color — just for your own view.',
    felt_classic: 'Emerald', felt_midnight: 'Midnight', felt_slate: 'Slate', felt_crimson: 'Crimson', felt_royal: 'Royal', felt_sunrise: 'Sunrise',
    feltReqDefault: 'Always yours', feltReqMidnight: 'Play 5 games', feltReqSlate: 'Play 20 games',
    feltReqCrimson: 'Win 3 games', feltReqRoyal: 'Earn 3 achievements', feltReqSunrise: 'Reach Gold (1550)',
    powerCards: 'Power cards', powBasic: 'basic', powFull: 'full',
    peekSelfMsg: '7/8: peek one of your own cards', peekOtherMsg: "9/10: peek an opponent's card",
    peekResolving: 'Resolving a peek…', opponentPeek: 'Card revealed',
    // tutorial
    tutStep: 'Step {n} of {total}', tutBack: 'Back', tutNext: 'Next', tutPlay: "Let's play", tutClose: 'Close',
    tutTitle1: 'Welcome to Dutch',
    tutBody1: 'Everyone gets a row of face-down cards. The goal is simple: have the <strong>lowest total score</strong> when someone calls “Dutch”. Low cards good, high cards bad — and memory matters.',
    tutTitle2: 'What cards are worth',
    tutBody2: 'Number cards are worth their face value. <strong>Ace = 1</strong>, <strong>Jack = 11</strong>, <strong>Queen = 12</strong>.<br/>The twist: a <strong>red King is 0</strong> (the best card in the game!), but a <strong>black King is 13</strong> (the worst).',
    tutTitle3: 'Peek at the start',
    tutBody3: 'Before play begins, one player picks a number (0–4). Everyone then <strong>secretly looks at that many of their own cards</strong>. Try to remember what and where they are!',
    tutTitle4: 'On your turn',
    tutBody4: 'Do <strong>one</strong> of two things:<br/>• <strong>Swap</strong> the face-up discard card into your row — replace a high card with this lower one to cut your score.<br/>• <strong>Flip</strong> the top of the draw pile onto the discard — mainly to trigger a power card.<br/>Then end your turn.',
    tutTitle5: 'Power cards',
    tutBody5: 'When a <strong>J</strong>, <strong>Q</strong>, or <strong>A</strong> lands face-up (you flipped it, or discarded it from your row) its power fires:<br/>• <strong>Jack</strong> — blind-swap any two cards on the table.<br/>• <strong>Queen</strong> — secretly peek at any one card.<br/>• <strong>Ace</strong> — give a face-down card to any player (raising their score).',
    tutTitle6: 'Matching',
    tutBody6: "If you know one of your face-down cards has the <strong>same rank</strong> as the discard-pile card (e.g. any two 7s, or two Kings), tap <strong>Match</strong> and pick it to drop it — now you have one fewer card. You can do this <strong>even when it isn't your turn</strong>! But guess wrong and you draw a <strong>penalty card</strong>. When a turn begins, the player waits a couple seconds first, so everyone gets a chance to match.",
    tutTitle7: 'Calling “Dutch”',
    tutBody7: "Think you have the lowest total? Take your turn, then <strong>call Dutch</strong>. Everyone else gets <strong>one final turn</strong>, then all cards flip up and scores are revealed. Lowest wins — so call it when you're confident!",
    tutTitle8: "You're ready!",
    tutBody8: '<strong>Create a game</strong> and share the code with friends, <strong>add bots</strong> to practice against, or open the 👥 menu to claim a username and add friends. Have fun!',
    tutTagBest: '0 — best!', tutTag1: '1', tutTagWorst: '13 — worst', tutTagSwap: 'swap', tutTagPeek: 'peek',
    tutTagGive: 'give', tutTagDiscard: 'discard', tutTagYourCard: 'your card',
  },
  es: {
    tagline: 'Gana quien tenga menos puntos. Juega desde cualquier lugar.',
    createTitle: 'Crear partida', createSub: 'Crea una mesa nueva e invita con un código.',
    joinTitle: 'Unirse a una partida', joinSub: 'Introduce el código que te compartieron.',
    yourName: 'Tu nombre', createGame: 'Crear partida', joinGame: 'Unirse', codePlaceholder: 'CÓDIGO',
    flip: 'Robar del mazo', swap: 'Cambiar con el descarte', match: 'Emparejar', endTurn: 'Terminar turno',
    callDutch: 'Cantar Dutch', playAgain: 'Jugar de nuevo', newMatch: 'Nueva partida', startGame: 'Empezar', leave: 'Salir',
    leaveRoom: 'Salir de la sala', friends: 'Amigos', chat: 'Chat', chatEmpty: 'Aún no hay mensajes. ¡Saluda!',
    chatPlaceholder: 'Mensaje…', send: 'Enviar', howToPlay: 'Cómo jugar', yourTurn: 'Tu turno',
    chooseLanguage: 'Elige tu idioma', language: 'Idioma',
    enterName: 'Primero escribe tu nombre.', enterCode: 'Introduce un código de sala.',
    roomCodeCopied: '¡Código copiado!', inviteLinkCopied: '¡Enlace de invitación copiado!',
    recoveryCopied: '¡Código de recuperación copiado!', playingGuest: 'Jugando como invitado — crea o únete a una partida abajo.',
    enterUserPass: 'Introduce un usuario y contraseña.', emailSaved: 'Correo guardado.',
    youWon: '🏆 ¡Ganaste! ({n} victorias)', gameRecorded: 'Partida registrada ({n} jugadas)',
    roomShare: 'Código de sala — compártelo', tapCopy: 'Toca el código para copiar', copyInvite: 'Copiar enlace de invitación',
    addBotTitle: 'Añadir un bot', houseRules: 'Reglas de la casa', cardsEach: 'Cartas cada uno', matchWindowLbl: 'Ventana de emparejado',
    matchingLbl: 'Emparejado', turnLimitLbl: 'Límite de turno', optOff: 'no', optOn: 'sí',
    needTwo: 'Se necesitan al menos 2 jugadores.', readyPlayers: 'Listos — {n} jugadores',
    waitingHost: 'Esperando a que el anfitrión empiece…', hostTag: 'anfitrión', youTag: 'tú', removeBot: 'Quitar bot',
    rulesSummary: '{cards} cartas · ventana de {win}s · emparejado {matching} · {limit}',
    turnLimitVal: 'límite de {n}s por turno', noTurnLimit: 'sin límite de turno',
    diffEasy: 'Fácil', diffMedium: 'Media', diffMed: 'Med', diffHard: 'Difícil', diffImpossible: 'Imposible',
    choosePeek: 'Elige cuántas cartas mirar', isChoosing: '{name} está eligiendo',
    peekSub: 'Cada jugador mirará en privado esta cantidad de sus propias {n} cartas antes de empezar.',
    hangTight: 'Un momento…', donePeeking: 'Listo',
    drawLbl: 'Mazo', discardLbl: 'Descarte', yourHand: 'Tu mano', yourHandDutch: 'Tu mano — cantaste Dutch',
    roomTag: 'Sala {code}',
    matchingPick: '⏸ Emparejando — elige una carta', playPaused: 'Juego en pausa',
    xMatching: '⏸ {name} está emparejando', playPausedE: 'Juego en pausa…',
    yourTurnPeek: 'Tu turno de mirar', lookAtCards: 'Mira {n} de tus cartas ({done}/{n} hechas)',
    xPeeking: '{name} está mirando sus cartas', everyoneHang: 'Los demás, un momento…',
    xTurn: 'Turno de {name}', finalRound: '¡Ronda final! {name} cantó Dutch — quedan {n} turno(s)',
    jackSecondMsg: 'Jota: elige la segunda carta', jackFirstMsg: 'Jota: elige la primera carta a cambiar',
    jackResolving: 'Resolviendo una Jota…', queenPickMsg: 'Reina: elige cualquier carta para mirar', queenResolving: 'Resolviendo una Reina…',
    aceChooseMsg: 'As: elige quién recibe una carta boca abajo', aceResolving: 'Resolviendo un As…',
    endOrDutch: 'Termina tu turno — o canta Dutch', xFinishing: '{name} está terminando su turno…',
    waitingForX: 'Esperando a {name}…', matchPrompt: '¡Empareja! Toca una de tus cartas del mismo valor que el descarte ({card}). Si fallas = carta de penalización.',
    cancel: 'Cancelar', xMatchingPaused: '⏸ {name} está emparejando — juego en pausa',
    clickOwnCard: 'Toca una de tus propias cartas arriba.', youCanAct: 'Podrás actuar en {n}s — cualquiera puede emparejar el descarte ahora.',
    jackClickSecond: 'Toca la segunda carta para el cambio.', jackClickAny: 'Toca cualquier carta de la mesa para el cambio a ciegas.',
    queenClickAny: 'Toca cualquier carta de la mesa para mirarla.',
    tagLeft: 'SE FUE', tagTurn: 'TURNO', tagOffline: 'DESCONECTADO',
    roundOver: 'Fin de la ronda', allRevealed: 'Cartas reveladas', winner: 'GANADOR', ptsUnit: 'pts',
    waitingNewRound: 'Esperando a que el anfitrión empiece otra ronda…', matchStandings: 'Clasificación · {n} rondas',
    yourPeek: 'Tu vistazo', queensPeek: 'Vistazo de la Reina', gotIt: 'Entendido',
    soundTip: 'Sonido', leaderboardTip: 'Clasificación',
    login: 'Entrar', signup: 'Registrarse',
    recoverIntro: 'Introduce tu usuario y código de recuperación para volver y crear una nueva contraseña.',
    phUsername: 'usuario', phRecoveryCode: 'código de recuperación', phNewPw: 'nueva contraseña (mín. 6)', resetLogin: 'Restablecer y entrar',
    orEmailReset: 'O envíame un enlace por correo', phUserOrEmail: 'usuario o correo', backToLogin: '← Volver a entrar',
    signupIntro: 'Crea una cuenta para que tus amigos te encuentren y puedas entrar desde cualquier dispositivo.',
    loginIntro: 'Entra para ver tus amigos e invitaciones.', phUsernameRules: 'usuario (3–16 letras/números)',
    phPassword: 'contraseña (mín. 6)', phEmailOpt: 'correo (opcional — para restablecer contraseña)',
    createAccount: 'Crear cuenta', forgotPw: '¿Olvidaste tu contraseña?', playGuest: 'Jugar como invitado →',
    saveRecovery: 'Guarda tu código de recuperación',
    recoveryExplain: 'No hay restablecimiento por correo. Si olvidas tu contraseña, este código es la única forma de recuperar tu cuenta. Guárdalo en un lugar seguro.',
    copy: 'Copiar', savedIt: 'Ya lo guardé',
    signedInAs: 'Conectado como', logout: 'Salir', phAddEmail: 'añade correo para restablecer contraseña', save: 'Guardar',
    phAddFriend: 'Añadir amigo por usuario', add: 'Añadir', requests: 'Solicitudes', accept: 'Aceptar',
    sentWaiting: 'Enviada — esperando', friendsCount: 'Amigos ({n})', noFriends: 'Aún no tienes amigos — añade a alguien por su usuario.',
    invite: 'Invitar', onlineInvite: 'Puedes invitar a tu sala a los amigos conectados.',
    cancelRequest: 'Cancelar solicitud', unfriend: 'Eliminar amigo', joinBtn: 'Unirse', invitedYou: '{name} te invitó a la partida',
    leaderboardTitle: 'Clasificación', loading: 'Cargando…', yourStats: 'Tus estadísticas', statWins: 'victorias', statGames: 'partidas',
    statBestRound: 'mejor ronda', statAccuracy: 'precisión', statRank: 'puesto',
    accuracyExplain: 'Precisión = proporción de tus decisiones de robar/cambiar que fueron la mejor jugada según lo que sabías en ese momento.',
    loginForLb: 'Entra (👥) para que tus partidas cuenten en la clasificación.', topPlayers: 'Mejores jugadores',
    lbPlayer: 'Jugador', lbWins: 'Victorias', lbAcc: 'Prec', noGames: 'Aún no hay partidas — ¡sé el primero!',
    ranked1v1: 'Clasificatoria 1v1', rankedNeedLogin: 'Entra para jugar clasificatorias — abre el menú 👥.',
    rankedTag: 'Clasificatoria 1v1', rankedRules: 'Reglas estándar · con rating Glicko',
    rankedWaitOpp: 'Comparte el código — esperando a un rival…',
    ratingCol: 'Rating', recordCol: 'V–D', statRating: 'rating', statRanked: 'clasif.', unranked: 'sin rating',
    ratingToast: 'Rating de clasificatoria: {rating} ({delta})',
    authCta: 'Entrar / Registrarse', authCtaSub: 'Guarda tus estadísticas, añade amigos y juega clasificatorias.',
    powerYours: 'Poder emparejado — ¡te toca!', powerOther: '{name} está usando un poder emparejado…',
    recentGames: 'Partidas recientes', noHistory: 'Aún no hay partidas — ¡juega una ronda!',
    liveGames: 'Partidas en vivo — toca para unirte',
    finalMatch: '¡Última oportunidad para emparejar!', finalMatchSub: 'Revelando puntuaciones…',
    histShed: 'Cartas soltadas (emparejes)', histPowers: 'Poderes usados',
    tierBronze: 'Bronce', tierSilver: 'Plata', tierGold: 'Oro', tierPlatinum: 'Platino', tierDiamond: 'Diamante', tierMaster: 'Maestro',
    achievementsLabel: 'Logros', achUnlocked: '¡Logro desbloqueado!',
    ach_first_win: 'Primera victoria', ach_red_king: 'Rey rojo', ach_perfect_round: 'Ronda perfecta', ach_shed3: 'Tiburón', ach_power3: 'Jugador de poder', ach_low_score: 'Peso pluma', ach_dutch_win: '¡Cantado!', ach_ranked_win: 'Victoria clasificatoria', ach_veteran: 'Veterano', ach_invite_1: 'Reclutador', ach_invite_5: 'Embajador', ach_invite_10: 'Evangelista',
    inviteFriends: 'Invita amigos', inviteCopied: '¡Enlace de invitación copiado!', inviteNeedLogin: 'Entra para obtener tu enlace de invitación.', statInvited: 'invitados',
    shareText: '¡Juega a Dutch conmigo — gana el que tenga menos puntos!', referralJoined: '¡Un amigo se unió con tu invitación! ({n} en total)',
    cardBacksLabel: 'Reversos', cardBacksHint: 'Desbloquea diseños jugando — todos en la mesa ven el reverso que equipas.',
    backEquip: 'Equipar', backEquippedTag: 'Equipado', backEquipped: '{name} equipado',
    back_classic: 'Clásico', back_crimson: 'Carmesí', back_emerald: 'Esmeralda', back_amber: 'Ámbar', back_royal: 'Real', back_noir: 'Negro',
    backReqDefault: 'Siempre tuyo', backReqCrimson: 'Gana una partida', backReqEmerald: 'Juega 10 partidas',
    backReqAmber: 'Invita a un amigo', backReqRoyal: 'Consigue 5 logros', backReqNoir: 'Alcanza Platino (1700)',
    back_ocean: 'Océano', back_rose: 'Rosa', back_sunset: 'Ocaso', back_frost: 'Escarcha', back_orchid: 'Orquídea', back_aurora: 'Aurora',
    backReqOcean: 'Juega 25 partidas', backReqRose: 'Gana 5 partidas', backReqSunset: 'Gana 25 partidas',
    backReqFrost: 'Invita a 3 amigos', backReqOrchid: 'Consigue 10 logros', backReqAurora: 'Alcanza Maestro (2000)',
    tableFeltsLabel: 'Tapete', tableFeltsHint: 'Elige el color de tu mesa — solo para tu vista.',
    felt_classic: 'Esmeralda', felt_midnight: 'Medianoche', felt_slate: 'Pizarra', felt_crimson: 'Carmesí', felt_royal: 'Real', felt_sunrise: 'Amanecer',
    feltReqDefault: 'Siempre tuyo', feltReqMidnight: 'Juega 5 partidas', feltReqSlate: 'Juega 20 partidas',
    feltReqCrimson: 'Gana 3 partidas', feltReqRoyal: 'Consigue 3 logros', feltReqSunrise: 'Alcanza Oro (1550)',
    powerCards: 'Cartas de poder', powBasic: 'básico', powFull: 'completo',
    peekSelfMsg: '7/8: mira una de tus cartas', peekOtherMsg: ' 9/10: mira una carta de un rival',
    peekResolving: 'Resolviendo un vistazo…', opponentPeek: 'Carta revelada',
    tutStep: 'Paso {n} de {total}', tutBack: 'Atrás', tutNext: 'Siguiente', tutPlay: '¡A jugar!', tutClose: 'Cerrar',
    tutTitle1: 'Bienvenido a Dutch',
    tutBody1: 'Cada jugador recibe una fila de cartas boca abajo. El objetivo es simple: tener la <strong>puntuación total más baja</strong> cuando alguien cante “Dutch”. Cartas bajas bien, cartas altas mal — y la memoria importa.',
    tutTitle2: 'Cuánto valen las cartas',
    tutBody2: 'Las cartas numéricas valen su valor. <strong>As = 1</strong>, <strong>Jota = 11</strong>, <strong>Reina = 12</strong>.<br/>El truco: un <strong>Rey rojo vale 0</strong> (¡la mejor carta!), pero un <strong>Rey negro vale 13</strong> (la peor).',
    tutTitle3: 'Vistazo inicial',
    tutBody3: 'Antes de empezar, un jugador elige un número (0–4). Todos <strong>miran en secreto esa cantidad de sus propias cartas</strong>. ¡Intenta recordar cuáles son y dónde están!',
    tutTitle4: 'En tu turno',
    tutBody4: 'Haz <strong>una</strong> de dos cosas:<br/>• <strong>Cambia</strong> la carta boca arriba del descarte por una de tu fila — sustituye una carta alta por esta más baja para reducir tu puntuación.<br/>• <strong>Roba</strong> la carta superior del mazo al descarte — sobre todo para activar una carta de poder.<br/>Luego termina tu turno.',
    tutTitle5: 'Cartas de poder',
    tutBody5: 'Cuando una <strong>J</strong>, <strong>Q</strong> o <strong>A</strong> queda boca arriba (la robaste o la descartaste de tu fila) se activa su poder:<br/>• <strong>Jota</strong> — intercambia a ciegas dos cartas cualesquiera de la mesa.<br/>• <strong>Reina</strong> — mira en secreto cualquier carta.<br/>• <strong>As</strong> — da una carta boca abajo a cualquier jugador (subiendo su puntuación).',
    tutTitle6: 'Emparejar',
    tutBody6: 'Si sabes que una de tus cartas boca abajo tiene el <strong>mismo valor</strong> que la del descarte (p. ej. dos 7, o dos Reyes), toca <strong>Emparejar</strong> y elígela para soltarla — así tendrás una carta menos. ¡Puedes hacerlo <strong>incluso cuando no es tu turno</strong>! Pero si fallas, robas una <strong>carta de penalización</strong>. Al empezar un turno, el jugador espera unos segundos para que todos tengan opción de emparejar.',
    tutTitle7: 'Cantar “Dutch”',
    tutBody7: '¿Crees que tienes el total más bajo? Juega tu turno y luego <strong>canta Dutch</strong>. Los demás tienen <strong>un último turno</strong>, luego se revelan todas las cartas y las puntuaciones. ¡Gana la más baja, así que cántalo cuando estés seguro!',
    tutTitle8: '¡Listo!',
    tutBody8: '<strong>Crea una partida</strong> y comparte el código con amigos, <strong>añade bots</strong> para practicar, o abre el menú 👥 para elegir un usuario y añadir amigos. ¡Diviértete!',
    tutTagBest: '0 — ¡la mejor!', tutTag1: '1', tutTagWorst: '13 — la peor', tutTagSwap: 'cambio', tutTagPeek: 'mirar',
    tutTagGive: 'dar', tutTagDiscard: 'descarte', tutTagYourCard: 'tu carta',
  },
  fr: {
    tagline: 'Le score le plus bas gagne. Jouez où que vous soyez.',
    createTitle: 'Créer une partie', createSub: 'Créez une table et invitez avec un code.',
    joinTitle: 'Rejoindre une partie', joinSub: "Entrez le code qu'on vous a partagé.",
    yourName: 'Votre nom', createGame: 'Créer', joinGame: 'Rejoindre', codePlaceholder: 'CODE',
    flip: 'Piocher', swap: 'Échanger avec la défausse', match: 'Associer', endTurn: 'Finir le tour',
    callDutch: 'Annoncer Dutch', playAgain: 'Rejouer', newMatch: 'Nouveau match', startGame: 'Commencer', leave: 'Quitter',
    leaveRoom: 'Quitter la salle', friends: 'Amis', chat: 'Chat', chatEmpty: 'Aucun message. Dites bonjour !',
    chatPlaceholder: 'Message…', send: 'Envoyer', howToPlay: 'Comment jouer', yourTurn: 'Votre tour',
    chooseLanguage: 'Choisissez votre langue', language: 'Langue',
    enterName: "Entrez d'abord votre nom.", enterCode: 'Entrez un code de salle.',
    roomCodeCopied: 'Code copié !', inviteLinkCopied: "Lien d'invitation copié !",
    recoveryCopied: 'Code de récupération copié !', playingGuest: 'En invité — créez ou rejoignez une partie ci-dessous.',
    enterUserPass: 'Entrez un identifiant et un mot de passe.', emailSaved: 'E-mail enregistré.',
    youWon: '🏆 Gagné ! ({n} victoires)', gameRecorded: 'Partie enregistrée ({n} jouées)',
    roomShare: 'Code de salle — partagez-le', tapCopy: 'Touchez le code pour copier', copyInvite: "Copier le lien d'invitation",
    addBotTitle: 'Ajouter un bot', houseRules: 'Règles', cardsEach: 'Cartes chacun', matchWindowLbl: "Fenêtre d'association",
    matchingLbl: 'Association', turnLimitLbl: 'Limite de tour', optOff: 'non', optOn: 'oui',
    needTwo: 'Il faut au moins 2 joueurs.', readyPlayers: 'Prêt — {n} joueurs',
    waitingHost: "En attente du lancement par l'hôte…", hostTag: 'hôte', youTag: 'vous', removeBot: 'Retirer le bot',
    rulesSummary: '{cards} cartes · fenêtre de {win}s · association {matching} · {limit}',
    turnLimitVal: 'limite de {n}s par tour', noTurnLimit: 'sans limite de tour',
    diffEasy: 'Facile', diffMedium: 'Moyen', diffMed: 'Moy', diffHard: 'Difficile', diffImpossible: 'Impossible',
    choosePeek: 'Choisissez combien de cartes regarder', isChoosing: '{name} choisit',
    peekSub: "Avant de commencer, chacun regarde en privé ce nombre de ses propres {n} cartes.",
    hangTight: 'Un instant…', donePeeking: 'Terminé',
    drawLbl: 'Pioche', discardLbl: 'Défausse', yourHand: 'Votre main', yourHandDutch: 'Votre main — vous avez annoncé Dutch',
    roomTag: 'Salle {code}',
    matchingPick: '⏸ Association — choisissez une carte', playPaused: 'Jeu en pause',
    xMatching: '⏸ {name} associe', playPausedE: 'Jeu en pause…',
    yourTurnPeek: 'À vous de regarder', lookAtCards: 'Regardez {n} de vos cartes ({done}/{n} faites)',
    xPeeking: '{name} regarde ses cartes', everyoneHang: 'Les autres, patientez…',
    xTurn: 'Tour de {name}', finalRound: 'Dernier tour ! {name} a annoncé Dutch — {n} tour(s) restant(s)',
    jackSecondMsg: 'Valet : choisissez la deuxième carte', jackFirstMsg: 'Valet : choisissez la première carte à échanger',
    jackResolving: 'Résolution du Valet…', queenPickMsg: "Dame : choisissez une carte à regarder", queenResolving: 'Résolution de la Dame…',
    aceChooseMsg: 'As : choisissez qui reçoit une carte face cachée', aceResolving: "Résolution de l'As…",
    endOrDutch: 'Finissez votre tour — ou annoncez Dutch', xFinishing: '{name} finit son tour…',
    waitingForX: 'En attente de {name}…', matchPrompt: 'Association ! Touchez une de vos cartes du même rang que la défausse ({card}). Erreur = carte de pénalité.',
    cancel: 'Annuler', xMatchingPaused: '⏸ {name} associe — jeu en pause',
    clickOwnCard: 'Touchez une de vos cartes ci-dessus.', youCanAct: 'Vous pourrez agir dans {n}s — tout le monde peut associer la défausse maintenant.',
    jackClickSecond: 'Touchez la deuxième carte à échanger.', jackClickAny: "Touchez n'importe quelle carte pour l'échange à l'aveugle.",
    queenClickAny: "Touchez n'importe quelle carte de la table pour la regarder.",
    tagLeft: 'PARTI', tagTurn: 'TOUR', tagOffline: 'HORS LIGNE',
    roundOver: 'Fin de la manche', allRevealed: 'Cartes révélées', winner: 'GAGNANT', ptsUnit: 'pts',
    waitingNewRound: "En attente d'une nouvelle manche par l'hôte…", matchStandings: 'Classement · {n} manches',
    yourPeek: 'Votre coup d’œil', queensPeek: 'Coup d’œil de la Dame', gotIt: 'Compris',
    soundTip: 'Son', leaderboardTip: 'Classement',
    login: 'Connexion', signup: 'Inscription',
    recoverIntro: 'Entrez votre identifiant et votre code de récupération pour revenir et créer un nouveau mot de passe.',
    phUsername: 'identifiant', phRecoveryCode: 'code de récupération', phNewPw: 'nouveau mot de passe (min 6)', resetLogin: 'Réinitialiser et se connecter',
    orEmailReset: 'Ou envoyez-moi un lien par e-mail', phUserOrEmail: 'identifiant ou e-mail', backToLogin: '← Retour à la connexion',
    signupIntro: 'Créez un compte pour que vos amis vous trouvent et vous connecter depuis tout appareil.',
    loginIntro: 'Connectez-vous pour voir vos amis et invitations.', phUsernameRules: 'identifiant (3–16 lettres/chiffres)',
    phPassword: 'mot de passe (min 6)', phEmailOpt: 'e-mail (facultatif — pour réinitialiser)',
    createAccount: 'Créer un compte', forgotPw: 'Mot de passe oublié ?', playGuest: 'Jouer en invité →',
    saveRecovery: 'Enregistrez votre code de récupération',
    recoveryExplain: "Pas de réinitialisation par e-mail. Si vous oubliez votre mot de passe, ce code est le seul moyen de récupérer votre compte. Gardez-le en lieu sûr.",
    copy: 'Copier', savedIt: "C'est enregistré",
    signedInAs: 'Connecté en tant que', logout: 'Déconnexion', phAddEmail: 'ajoutez un e-mail pour réinitialiser', save: 'Enregistrer',
    phAddFriend: "Ajouter un ami par identifiant", add: 'Ajouter', requests: 'Demandes', accept: 'Accepter',
    sentWaiting: 'Envoyée — en attente', friendsCount: 'Amis ({n})', noFriends: "Aucun ami pour l'instant — ajoutez quelqu'un par son identifiant.",
    invite: 'Inviter', onlineInvite: 'Les amis en ligne peuvent être invités directement dans votre salle.',
    cancelRequest: 'Annuler la demande', unfriend: 'Retirer', joinBtn: 'Rejoindre', invitedYou: '{name} vous invite à la partie',
    leaderboardTitle: 'Classement', loading: 'Chargement…', yourStats: 'Vos stats', statWins: 'victoires', statGames: 'parties',
    statBestRound: 'meilleure manche', statAccuracy: 'précision', statRank: 'rang',
    accuracyExplain: 'Précision = part de vos décisions de pioche/échange qui étaient le meilleur coup selon ce que vous saviez à ce moment-là.',
    loginForLb: 'Connectez-vous (👥) pour que vos parties comptent au classement.', topPlayers: 'Meilleurs joueurs',
    lbPlayer: 'Joueur', lbWins: 'Victoires', lbAcc: 'Préc', noGames: 'Aucune partie jouée — soyez le premier !',
    ranked1v1: 'Classé 1v1', rankedNeedLogin: 'Connectez-vous pour jouer en classé — ouvrez le menu 👥.',
    rankedTag: 'Classé 1v1', rankedRules: 'Règles standard · classement Glicko',
    rankedWaitOpp: 'Partagez le code — en attente d\'un adversaire…',
    ratingCol: 'Rating', recordCol: 'V–D', statRating: 'rating', statRanked: 'classé', unranked: 'non classé',
    ratingToast: 'Rating classé : {rating} ({delta})',
    authCta: 'Connexion / Inscription', authCtaSub: 'Enregistrez vos stats, ajoutez des amis et jouez en classé.',
    powerYours: 'Pouvoir associé — à vous !', powerOther: '{name} utilise un pouvoir associé…',
    recentGames: 'Parties récentes', noHistory: 'Aucune partie — jouez une manche !',
    liveGames: 'Parties en direct — touchez pour rejoindre',
    finalMatch: "Dernière chance d'associer !", finalMatchSub: 'Révélation des scores…',
    histShed: 'Cartes posées (associations)', histPowers: 'Pouvoirs utilisés',
    tierBronze: 'Bronze', tierSilver: 'Argent', tierGold: 'Or', tierPlatinum: 'Platine', tierDiamond: 'Diamant', tierMaster: 'Maître',
    achievementsLabel: 'Succès', achUnlocked: 'Succès débloqué',
    ach_first_win: 'Première victoire', ach_red_king: 'Roi rouge', ach_perfect_round: 'Manche parfaite', ach_shed3: 'Requin', ach_power3: 'Joueur de pouvoir', ach_low_score: 'Poids plume', ach_dutch_win: 'Bien annoncé', ach_ranked_win: 'Victoire classée', ach_veteran: 'Vétéran', ach_invite_1: 'Recruteur', ach_invite_5: 'Ambassadeur', ach_invite_10: 'Évangéliste',
    inviteFriends: 'Inviter des amis', inviteCopied: "Lien d'invitation copié !", inviteNeedLogin: 'Connectez-vous pour obtenir votre lien.', statInvited: 'invités',
    shareText: 'Joue à Dutch avec moi — le score le plus bas gagne !', referralJoined: 'Un ami a rejoint avec votre invitation ! ({n} au total)',
    cardBacksLabel: 'Dos de cartes', cardBacksHint: 'Débloquez des motifs en jouant — toute la table voit le dos que vous équipez.',
    backEquip: 'Équiper', backEquippedTag: 'Équipé', backEquipped: '{name} équipé',
    back_classic: 'Classique', back_crimson: 'Cramoisi', back_emerald: 'Émeraude', back_amber: 'Ambre', back_royal: 'Royal', back_noir: 'Noir',
    backReqDefault: 'Toujours à vous', backReqCrimson: 'Gagnez une partie', backReqEmerald: 'Jouez 10 parties',
    backReqAmber: 'Invitez un ami', backReqRoyal: 'Obtenez 5 succès', backReqNoir: 'Atteignez Platine (1700)',
    back_ocean: 'Océan', back_rose: 'Rose', back_sunset: 'Couchant', back_frost: 'Givre', back_orchid: 'Orchidée', back_aurora: 'Aurore',
    backReqOcean: 'Jouez 25 parties', backReqRose: 'Gagnez 5 parties', backReqSunset: 'Gagnez 25 parties',
    backReqFrost: 'Invitez 3 amis', backReqOrchid: 'Obtenez 10 succès', backReqAurora: 'Atteignez Maître (2000)',
    tableFeltsLabel: 'Tapis', tableFeltsHint: 'Choisissez la couleur de votre table — pour votre vue seulement.',
    felt_classic: 'Émeraude', felt_midnight: 'Minuit', felt_slate: 'Ardoise', felt_crimson: 'Cramoisi', felt_royal: 'Royal', felt_sunrise: 'Aurore',
    feltReqDefault: 'Toujours à vous', feltReqMidnight: 'Jouez 5 parties', feltReqSlate: 'Jouez 20 parties',
    feltReqCrimson: 'Gagnez 3 parties', feltReqRoyal: 'Obtenez 3 succès', feltReqSunrise: 'Atteignez Or (1550)',
    powerCards: 'Cartes de pouvoir', powBasic: 'de base', powFull: 'complet',
    peekSelfMsg: '7/8 : regardez une de vos cartes', peekOtherMsg: "9/10 : regardez une carte d'un adversaire",
    peekResolving: 'Résolution du coup d’œil…', opponentPeek: 'Carte révélée',
    tutStep: 'Étape {n} sur {total}', tutBack: 'Retour', tutNext: 'Suivant', tutPlay: 'Jouons', tutClose: 'Fermer',
    tutTitle1: 'Bienvenue dans Dutch',
    tutBody1: "Chacun reçoit une rangée de cartes face cachée. Le but est simple : avoir le <strong>score total le plus bas</strong> quand quelqu'un annonce « Dutch ». Cartes basses = bien, cartes hautes = mal — et la mémoire compte.",
    tutTitle2: 'La valeur des cartes',
    tutBody2: 'Les cartes numérotées valent leur valeur. <strong>As = 1</strong>, <strong>Valet = 11</strong>, <strong>Dame = 12</strong>.<br/>L’astuce : un <strong>Roi rouge vaut 0</strong> (la meilleure carte !), mais un <strong>Roi noir vaut 13</strong> (la pire).',
    tutTitle3: 'Coup d’œil au début',
    tutBody3: "Avant de commencer, un joueur choisit un nombre (0–4). Chacun <strong>regarde en secret ce nombre de ses propres cartes</strong>. Essayez de retenir lesquelles et où !",
    tutTitle4: 'À votre tour',
    tutBody4: 'Faites <strong>une</strong> des deux choses :<br/>• <strong>Échangez</strong> la carte de la défausse dans votre rangée — remplacez une carte haute par celle-ci, plus basse, pour réduire votre score.<br/>• <strong>Piochez</strong> la carte du dessus vers la défausse — surtout pour déclencher une carte de pouvoir.<br/>Puis finissez votre tour.',
    tutTitle5: 'Cartes de pouvoir',
    tutBody5: "Quand un <strong>V</strong>, une <strong>D</strong> ou un <strong>A</strong> se retrouve face visible (piochée ou défaussée de votre rangée), son pouvoir s'active :<br/>• <strong>Valet</strong> — échangez à l'aveugle deux cartes de la table.<br/>• <strong>Dame</strong> — regardez en secret une carte.<br/>• <strong>As</strong> — donnez une carte face cachée à un joueur (augmentant son score).",
    tutTitle6: 'Association',
    tutBody6: "Si vous savez qu'une de vos cartes face cachée a le <strong>même rang</strong> que la défausse (p. ex. deux 7, ou deux Rois), touchez <strong>Associer</strong> et choisissez-la pour vous en défaire — vous avez une carte de moins. Possible <strong>même hors de votre tour</strong> ! Mais en cas d'erreur, vous piochez une <strong>carte de pénalité</strong>. Au début d'un tour, le joueur attend quelques secondes pour laisser à tous une chance d'associer.",
    tutTitle7: 'Annoncer « Dutch »',
    tutBody7: "Vous pensez avoir le total le plus bas ? Jouez votre tour puis <strong>annoncez Dutch</strong>. Les autres ont <strong>un dernier tour</strong>, puis toutes les cartes se retournent et les scores sont révélés. Le plus bas gagne — annoncez quand vous êtes sûr !",
    tutTitle8: 'Vous êtes prêt !',
    tutBody8: '<strong>Créez une partie</strong> et partagez le code avec vos amis, <strong>ajoutez des bots</strong> pour vous entraîner, ou ouvrez le menu 👥 pour choisir un identifiant et ajouter des amis. Amusez-vous !',
    tutTagBest: '0 — la meilleure !', tutTag1: '1', tutTagWorst: '13 — la pire', tutTagSwap: 'échange', tutTagPeek: 'regard',
    tutTagGive: 'donner', tutTagDiscard: 'défausse', tutTagYourCard: 'votre carte',
  },
  de: {
    tagline: 'Niedrigste Punktzahl gewinnt. Spiele von überall.',
    createTitle: 'Spiel erstellen', createSub: 'Neuen Tisch starten und mit Code einladen.',
    joinTitle: 'Spiel beitreten', joinSub: 'Gib den geteilten Code ein.',
    yourName: 'Dein Name', createGame: 'Erstellen', joinGame: 'Beitreten', codePlaceholder: 'CODE',
    flip: 'Vom Stapel ziehen', swap: 'Mit Ablage tauschen', match: 'Ablegen', endTurn: 'Zug beenden',
    callDutch: 'Dutch ansagen', playAgain: 'Nochmal spielen', newMatch: 'Neues Match', startGame: 'Starten', leave: 'Verlassen',
    leaveRoom: 'Raum verlassen', friends: 'Freunde', chat: 'Chat', chatEmpty: 'Noch keine Nachrichten. Sag Hallo!',
    chatPlaceholder: 'Nachricht…', send: 'Senden', howToPlay: 'Spielanleitung', yourTurn: 'Du bist dran',
    chooseLanguage: 'Wähle deine Sprache', language: 'Sprache',
    enterName: 'Gib zuerst deinen Namen ein.', enterCode: 'Gib einen Raumcode ein.',
    roomCodeCopied: 'Code kopiert!', inviteLinkCopied: 'Einladungslink kopiert!',
    recoveryCopied: 'Wiederherstellungscode kopiert!', playingGuest: 'Als Gast — erstelle oder tritt unten einem Spiel bei.',
    enterUserPass: 'Gib Benutzername und Passwort ein.', emailSaved: 'E-Mail gespeichert.',
    youWon: '🏆 Gewonnen! ({n} Siege)', gameRecorded: 'Spiel gespeichert ({n} gespielt)',
    roomShare: 'Raumcode — teile ihn', tapCopy: 'Tippe den Code zum Kopieren', copyInvite: 'Einladungslink kopieren',
    addBotTitle: 'Bot hinzufügen', houseRules: 'Hausregeln', cardsEach: 'Karten je Spieler', matchWindowLbl: 'Ablege-Fenster',
    matchingLbl: 'Ablegen', turnLimitLbl: 'Zug-Limit', optOff: 'aus', optOn: 'an',
    needTwo: 'Mindestens 2 Spieler nötig.', readyPlayers: 'Bereit — {n} Spieler',
    waitingHost: 'Warte auf den Host…', hostTag: 'Host', youTag: 'du', removeBot: 'Bot entfernen',
    rulesSummary: '{cards} Karten · {win}s Ablege-Fenster · Ablegen {matching} · {limit}',
    turnLimitVal: '{n}s Zug-Limit', noTurnLimit: 'kein Zug-Limit',
    diffEasy: 'Leicht', diffMedium: 'Mittel', diffMed: 'Mit', diffHard: 'Schwer', diffImpossible: 'Unmöglich',
    choosePeek: 'Wähle die Anzahl zum Ansehen', isChoosing: '{name} wählt',
    peekSub: 'Vor Spielbeginn sieht sich jeder heimlich so viele seiner eigenen {n} Karten an.',
    hangTight: 'Einen Moment…', donePeeking: 'Fertig',
    drawLbl: 'Stapel', discardLbl: 'Ablage', yourHand: 'Deine Hand', yourHandDutch: 'Deine Hand — du hast Dutch angesagt',
    roomTag: 'Raum {code}',
    matchingPick: '⏸ Ablegen — wähle eine Karte', playPaused: 'Spiel pausiert',
    xMatching: '⏸ {name} legt ab', playPausedE: 'Spiel pausiert…',
    yourTurnPeek: 'Du darfst ansehen', lookAtCards: 'Sieh dir {n} deiner Karten an ({done}/{n} erledigt)',
    xPeeking: '{name} sieht sich Karten an', everyoneHang: 'Alle anderen, einen Moment…',
    xTurn: '{name} ist dran', finalRound: 'Letzte Runde! {name} hat Dutch angesagt — noch {n} Zug/Züge',
    jackSecondMsg: 'Bube: wähle die zweite Karte', jackFirstMsg: 'Bube: wähle die erste Karte zum Tauschen',
    jackResolving: 'Bube wird aufgelöst…', queenPickMsg: 'Dame: wähle eine Karte zum Ansehen', queenResolving: 'Dame wird aufgelöst…',
    aceChooseMsg: 'Ass: wähle, wer eine verdeckte Karte bekommt', aceResolving: 'Ass wird aufgelöst…',
    endOrDutch: 'Beende deinen Zug — oder sag Dutch an', xFinishing: '{name} beendet den Zug…',
    waitingForX: 'Warte auf {name}…', matchPrompt: 'Ablegen! Tippe eine deiner Karten mit demselben Rang wie die Ablage ({card}). Falsch = Strafkarte.',
    cancel: 'Abbrechen', xMatchingPaused: '⏸ {name} legt ab — Spiel pausiert',
    clickOwnCard: 'Tippe oben eine deiner eigenen Karten.', youCanAct: 'Du kannst in {n}s handeln — jeder kann jetzt die Ablage ablegen.',
    jackClickSecond: 'Tippe die zweite Karte zum Tauschen.', jackClickAny: 'Tippe eine beliebige Karte für den Blindtausch.',
    queenClickAny: 'Tippe eine beliebige Karte auf dem Tisch zum Ansehen.',
    tagLeft: 'WEG', tagTurn: 'ZUG', tagOffline: 'OFFLINE',
    roundOver: 'Runde vorbei', allRevealed: 'Alle Karten aufgedeckt', winner: 'SIEGER', ptsUnit: 'Pkt',
    waitingNewRound: 'Warte auf eine neue Runde vom Host…', matchStandings: 'Gesamtstand · {n} Runden',
    yourPeek: 'Dein Blick', queensPeek: 'Blick der Dame', gotIt: 'Verstanden',
    soundTip: 'Ton', leaderboardTip: 'Bestenliste',
    login: 'Anmelden', signup: 'Registrieren',
    recoverIntro: 'Gib deinen Benutzernamen und Wiederherstellungscode ein, um zurückzukommen und ein neues Passwort zu setzen.',
    phUsername: 'Benutzername', phRecoveryCode: 'Wiederherstellungscode', phNewPw: 'neues Passwort (min. 6)', resetLogin: 'Zurücksetzen & anmelden',
    orEmailReset: 'Oder Link per E-Mail senden', phUserOrEmail: 'Benutzername oder E-Mail', backToLogin: '← Zurück zur Anmeldung',
    signupIntro: 'Erstelle ein Konto, damit Freunde dich finden und du dich von jedem Gerät anmelden kannst.',
    loginIntro: 'Melde dich an, um Freunde und Einladungen zu sehen.', phUsernameRules: 'Benutzername (3–16 Zeichen)',
    phPassword: 'Passwort (min. 6)', phEmailOpt: 'E-Mail (optional — für Passwort-Reset)',
    createAccount: 'Konto erstellen', forgotPw: 'Passwort vergessen?', playGuest: 'Als Gast spielen →',
    saveRecovery: 'Speichere deinen Wiederherstellungscode',
    recoveryExplain: 'Es gibt kein Zurücksetzen per E-Mail. Wenn du dein Passwort vergisst, ist dieser Code der einzige Weg zurück in dein Konto. Bewahre ihn sicher auf.',
    copy: 'Kopieren', savedIt: 'Gespeichert',
    signedInAs: 'Angemeldet als', logout: 'Abmelden', phAddEmail: 'E-Mail für Passwort-Reset hinzufügen', save: 'Speichern',
    phAddFriend: 'Freund per Benutzername hinzufügen', add: 'Hinzufügen', requests: 'Anfragen', accept: 'Annehmen',
    sentWaiting: 'Gesendet — wartend', friendsCount: 'Freunde ({n})', noFriends: 'Noch keine Freunde — füge jemanden per Benutzername hinzu.',
    invite: 'Einladen', onlineInvite: 'Online-Freunde können direkt in deinen Raum eingeladen werden.',
    cancelRequest: 'Anfrage abbrechen', unfriend: 'Entfernen', joinBtn: 'Beitreten', invitedYou: '{name} lädt dich ins Spiel ein',
    leaderboardTitle: 'Bestenliste', loading: 'Lädt…', yourStats: 'Deine Statistik', statWins: 'Siege', statGames: 'Spiele',
    statBestRound: 'beste Runde', statAccuracy: 'Genauigkeit', statRank: 'Rang',
    accuracyExplain: 'Genauigkeit = Anteil deiner Zieh-/Tausch-Entscheidungen, die der beste Zug waren, gemessen an dem, was du damals wusstest.',
    loginForLb: 'Melde dich an (👥), damit deine Spiele in der Bestenliste zählen.', topPlayers: 'Top-Spieler',
    lbPlayer: 'Spieler', lbWins: 'Siege', lbAcc: 'Gen', noGames: 'Noch keine Spiele — sei der Erste!',
    ranked1v1: 'Rangliste 1v1', rankedNeedLogin: 'Melde dich an, um ranked zu spielen — öffne das 👥-Menü.',
    rankedTag: 'Rangliste 1v1', rankedRules: 'Standardregeln · Glicko-gewertet',
    rankedWaitOpp: 'Teile den Code — warte auf einen Gegner…',
    ratingCol: 'Wertung', recordCol: 'S–N', statRating: 'Wertung', statRanked: 'ranked', unranked: 'ohne Wertung',
    ratingToast: 'Ranglisten-Wertung: {rating} ({delta})',
    authCta: 'Anmelden / Registrieren', authCtaSub: 'Statistiken speichern, Freunde hinzufügen, ranked spielen.',
    powerYours: 'Abgelegte Machtkarte — du bist dran!', powerOther: '{name} nutzt eine abgelegte Machtkarte…',
    recentGames: 'Letzte Spiele', noHistory: 'Noch keine Spiele — spiel eine Runde!',
    liveGames: 'Live-Spiele — zum Beitreten tippen',
    finalMatch: 'Letzte Chance zum Ablegen!', finalMatchSub: 'Punkte werden aufgedeckt…',
    histShed: 'Abgelegte Karten', histPowers: 'Machtkarten genutzt',
    tierBronze: 'Bronze', tierSilver: 'Silber', tierGold: 'Gold', tierPlatinum: 'Platin', tierDiamond: 'Diamant', tierMaster: 'Meister',
    achievementsLabel: 'Erfolge', achUnlocked: 'Erfolg freigeschaltet',
    ach_first_win: 'Erster Sieg', ach_red_king: 'Roter König', ach_perfect_round: 'Perfekte Runde', ach_shed3: 'Kartenhai', ach_power3: 'Machtspieler', ach_low_score: 'Federgewicht', ach_dutch_win: 'Angesagt', ach_ranked_win: 'Ranglisten-Sieg', ach_veteran: 'Veteran', ach_invite_1: 'Anwerber', ach_invite_5: 'Botschafter', ach_invite_10: 'Evangelist',
    inviteFriends: 'Freunde einladen', inviteCopied: 'Einladungslink kopiert!', inviteNeedLogin: 'Melde dich an, um deinen Link zu erhalten.', statInvited: 'eingeladen',
    shareText: 'Spiel Dutch mit mir — niedrigste Punktzahl gewinnt!', referralJoined: 'Ein Freund ist über deine Einladung beigetreten! ({n} insgesamt)',
    cardBacksLabel: 'Kartenrücken', cardBacksHint: 'Schalte Designs beim Spielen frei — alle am Tisch sehen den Rücken, den du ausrüstest.',
    backEquip: 'Ausrüsten', backEquippedTag: 'Ausgerüstet', backEquipped: '{name} ausgerüstet',
    back_classic: 'Klassisch', back_crimson: 'Karmesin', back_emerald: 'Smaragd', back_amber: 'Bernstein', back_royal: 'Königlich', back_noir: 'Noir',
    backReqDefault: 'Immer deins', backReqCrimson: 'Gewinne ein Spiel', backReqEmerald: 'Spiele 10 Spiele',
    backReqAmber: 'Lade einen Freund ein', backReqRoyal: 'Erringe 5 Erfolge', backReqNoir: 'Erreiche Platin (1700)',
    back_ocean: 'Ozean', back_rose: 'Rosé', back_sunset: 'Abendrot', back_frost: 'Frost', back_orchid: 'Orchidee', back_aurora: 'Aurora',
    backReqOcean: 'Spiele 25 Spiele', backReqRose: 'Gewinne 5 Spiele', backReqSunset: 'Gewinne 25 Spiele',
    backReqFrost: 'Lade 3 Freunde ein', backReqOrchid: 'Erringe 10 Erfolge', backReqAurora: 'Erreiche Meister (2000)',
    tableFeltsLabel: 'Spieltisch', tableFeltsHint: 'Wähle die Farbe deines Tisches — nur für deine Ansicht.',
    felt_classic: 'Smaragd', felt_midnight: 'Mitternacht', felt_slate: 'Schiefer', felt_crimson: 'Karmesin', felt_royal: 'Königlich', felt_sunrise: 'Morgenrot',
    feltReqDefault: 'Immer deins', feltReqMidnight: 'Spiele 5 Spiele', feltReqSlate: 'Spiele 20 Spiele',
    feltReqCrimson: 'Gewinne 3 Spiele', feltReqRoyal: 'Erringe 3 Erfolge', feltReqSunrise: 'Erreiche Gold (1550)',
    powerCards: 'Machtkarten', powBasic: 'einfach', powFull: 'voll',
    peekSelfMsg: '7/8: sieh eine eigene Karte an', peekOtherMsg: '9/10: sieh die Karte eines Gegners an',
    peekResolving: 'Blick wird aufgelöst…', opponentPeek: 'Karte aufgedeckt',
    tutStep: 'Schritt {n} von {total}', tutBack: 'Zurück', tutNext: 'Weiter', tutPlay: 'Los geht’s', tutClose: 'Schließen',
    tutTitle1: 'Willkommen bei Dutch',
    tutBody1: 'Jeder erhält eine Reihe verdeckter Karten. Das Ziel ist einfach: die <strong>niedrigste Gesamtpunktzahl</strong> haben, wenn jemand „Dutch“ ansagt. Niedrige Karten gut, hohe Karten schlecht — und Gedächtnis zählt.',
    tutTitle2: 'Kartenwerte',
    tutBody2: 'Zahlenkarten zählen ihren Wert. <strong>Ass = 1</strong>, <strong>Bube = 11</strong>, <strong>Dame = 12</strong>.<br/>Der Clou: ein <strong>roter König zählt 0</strong> (die beste Karte!), aber ein <strong>schwarzer König zählt 13</strong> (die schlechteste).',
    tutTitle3: 'Blick zu Beginn',
    tutBody3: 'Vor Spielbeginn wählt ein Spieler eine Zahl (0–4). Dann sieht sich jeder <strong>heimlich so viele eigene Karten</strong> an. Merke dir, welche und wo!',
    tutTitle4: 'In deinem Zug',
    tutBody4: 'Mache <strong>eines</strong> von zwei Dingen:<br/>• <strong>Tausche</strong> die offene Ablagekarte in deine Reihe — ersetze eine hohe Karte durch diese niedrigere, um Punkte zu senken.<br/>• <strong>Ziehe</strong> die oberste Stapelkarte auf die Ablage — vor allem um eine Machtkarte auszulösen.<br/>Dann beende deinen Zug.',
    tutTitle5: 'Machtkarten',
    tutBody5: 'Wenn ein <strong>B</strong>, eine <strong>D</strong> oder ein <strong>A</strong> offen liegt (gezogen oder aus deiner Reihe abgelegt), wirkt die Macht:<br/>• <strong>Bube</strong> — tausche blind zwei beliebige Karten auf dem Tisch.<br/>• <strong>Dame</strong> — sieh dir heimlich eine Karte an.<br/>• <strong>Ass</strong> — gib einem Spieler eine verdeckte Karte (erhöht dessen Punkte).',
    tutTitle6: 'Ablegen',
    tutBody6: 'Wenn du weißt, dass eine deiner verdeckten Karten den <strong>gleichen Rang</strong> wie die Ablage hat (z. B. zwei 7er oder zwei Könige), tippe <strong>Ablegen</strong> und wähle sie — nun hast du eine Karte weniger. Das geht <strong>auch außerhalb deines Zuges</strong>! Doch bei Fehlgriff ziehst du eine <strong>Strafkarte</strong>. Zu Zugbeginn wartet der Spieler ein paar Sekunden, damit alle ablegen können.',
    tutTitle7: '„Dutch“ ansagen',
    tutBody7: 'Glaubst du, die niedrigste Summe zu haben? Spiele deinen Zug und <strong>sag Dutch an</strong>. Alle anderen haben <strong>einen letzten Zug</strong>, dann werden alle Karten aufgedeckt und Punkte gezeigt. Niedrigste gewinnt — sag es an, wenn du sicher bist!',
    tutTitle8: 'Du bist bereit!',
    tutBody8: '<strong>Erstelle ein Spiel</strong> und teile den Code mit Freunden, <strong>füge Bots</strong> zum Üben hinzu, oder öffne das 👥-Menü, um einen Benutzernamen zu wählen und Freunde hinzuzufügen. Viel Spaß!',
    tutTagBest: '0 — beste!', tutTag1: '1', tutTagWorst: '13 — schlechteste', tutTagSwap: 'tauschen', tutTagPeek: 'ansehen',
    tutTagGive: 'geben', tutTagDiscard: 'Ablage', tutTagYourCard: 'deine Karte',
  },
  zh: {
    tagline: '分数最低者获胜。随时随地畅玩。',
    createTitle: '创建游戏', createSub: '开设新牌桌，用房间码邀请他人。',
    joinTitle: '加入游戏', joinSub: '输入别人分享给你的房间码。',
    yourName: '你的名字', createGame: '创建游戏', joinGame: '加入游戏', codePlaceholder: '房间码',
    flip: '从牌堆抽牌', swap: '与弃牌交换', match: '配对', endTurn: '结束回合',
    callDutch: '喊 Dutch', playAgain: '再玩一局', newMatch: '新的一局', startGame: '开始游戏', leave: '离开',
    leaveRoom: '离开房间', friends: '好友', chat: '聊天', chatEmpty: '还没有消息，打个招呼吧！',
    chatPlaceholder: '输入消息…', send: '发送', howToPlay: '玩法说明', yourTurn: '轮到你了',
    chooseLanguage: '选择你的语言', language: '语言',
    enterName: '请先输入你的名字。', enterCode: '请输入房间码。',
    roomCodeCopied: '房间码已复制！', inviteLinkCopied: '邀请链接已复制！',
    recoveryCopied: '恢复码已复制！', playingGuest: '以访客身份游玩 — 在下方创建或加入游戏。',
    enterUserPass: '请输入用户名和密码。', emailSaved: '邮箱已保存。',
    youWon: '🏆 你赢了！（{n} 胜）', gameRecorded: '对局已记录（已玩 {n} 局）',
    roomShare: '房间码 — 分享给好友', tapCopy: '点击房间码复制', copyInvite: '复制邀请链接',
    addBotTitle: '添加机器人', houseRules: '房间规则', cardsEach: '每人手牌', matchWindowLbl: '配对窗口',
    matchingLbl: '配对', turnLimitLbl: '回合时限', optOff: '关', optOn: '开',
    needTwo: '至少需要 2 名玩家才能开始。', readyPlayers: '准备就绪 — {n} 名玩家',
    waitingHost: '等待房主开始游戏…', hostTag: '房主', youTag: '你', removeBot: '移除机器人',
    rulesSummary: '{cards} 张牌 · {win} 秒配对窗口 · 配对{matching} · {limit}',
    turnLimitVal: '{n} 秒回合时限', noTurnLimit: '无回合时限',
    diffEasy: '简单', diffMedium: '中等', diffMed: '中', diffHard: '困难', diffImpossible: '地狱',
    choosePeek: '选择偷看的张数', isChoosing: '{name} 正在选择',
    peekSub: '开始前，每位玩家将私下查看自己 {n} 张手牌中的这么多张。',
    hangTight: '稍等…', donePeeking: '看好了',
    drawLbl: '牌堆', discardLbl: '弃牌', yourHand: '你的手牌', yourHandDutch: '你的手牌 — 你喊了 Dutch',
    roomTag: '房间 {code}',
    matchingPick: '⏸ 配对中 — 选一张牌', playPaused: '游戏暂停',
    xMatching: '⏸ {name} 正在配对', playPausedE: '游戏暂停…',
    yourTurnPeek: '轮到你偷看', lookAtCards: '查看你的 {n} 张牌（已看 {done}/{n}）',
    xPeeking: '{name} 正在查看手牌', everyoneHang: '其他人稍等…',
    xTurn: '{name} 的回合', finalRound: '最后一轮！{name} 喊了 Dutch — 还剩 {n} 个回合',
    jackSecondMsg: 'J：选择第二张牌', jackFirstMsg: 'J：选择要交换的第一张牌',
    jackResolving: '正在结算 J…', queenPickMsg: 'Q：选择任意一张牌偷看', queenResolving: '正在结算 Q…',
    aceChooseMsg: 'A：选择谁获得一张暗牌', aceResolving: '正在结算 A…',
    endOrDutch: '结束你的回合 — 或喊 Dutch', xFinishing: '{name} 正在结束回合…',
    waitingForX: '等待 {name}…', matchPrompt: '配对！点击你与弃牌（{card}）同点数的一张牌。配错 = 罚一张牌。',
    cancel: '取消', xMatchingPaused: '⏸ {name} 正在配对 — 游戏暂停',
    clickOwnCard: '点击上方你自己的一张牌。', youCanAct: '{n} 秒后可行动 — 现在任何人都可以配对弃牌。',
    jackClickSecond: '点击要交换的第二张牌。', jackClickAny: '点击桌上任意一张牌开始盲换。',
    queenClickAny: '点击桌上任意一张牌偷看。',
    tagLeft: '已离开', tagTurn: '回合', tagOffline: '离线',
    roundOver: '本轮结束', allRevealed: '所有牌已亮出', winner: '胜者', ptsUnit: '分',
    waitingNewRound: '等待房主开始新一轮…', matchStandings: '总积分榜 · {n} 轮',
    yourPeek: '你的偷看', queensPeek: 'Q 的偷看', gotIt: '知道了',
    soundTip: '声音', leaderboardTip: '排行榜',
    login: '登录', signup: '注册',
    recoverIntro: '输入你的用户名和恢复码即可重新登录并设置新密码。',
    phUsername: '用户名', phRecoveryCode: '恢复码', phNewPw: '新密码（至少 6 位）', resetLogin: '重置并登录',
    orEmailReset: '或给我发送重置链接邮件', phUserOrEmail: '用户名或邮箱', backToLogin: '← 返回登录',
    signupIntro: '创建账户，好友便能找到你，你也能在任意设备登录。',
    loginIntro: '登录以查看好友和邀请。', phUsernameRules: '用户名（3–16 位字母/数字）',
    phPassword: '密码（至少 6 位）', phEmailOpt: '邮箱（可选 — 用于重置密码）',
    createAccount: '创建账户', forgotPw: '忘记密码？', playGuest: '以访客身份游玩 →',
    saveRecovery: '保存你的恢复码',
    recoveryExplain: '没有邮箱重置。如果你忘记密码，这个恢复码是找回账户的唯一方法。请妥善保管。',
    copy: '复制', savedIt: '我已保存',
    signedInAs: '已登录为', logout: '登出', phAddEmail: '添加邮箱以便重置密码', save: '保存',
    phAddFriend: '按用户名添加好友', add: '添加', requests: '好友请求', accept: '接受',
    sentWaiting: '已发送 — 等待中', friendsCount: '好友（{n}）', noFriends: '还没有好友 — 按用户名添加一个吧。',
    invite: '邀请', onlineInvite: '在线好友可以直接被邀请进你的房间。',
    cancelRequest: '取消请求', unfriend: '删除好友', joinBtn: '加入', invitedYou: '{name} 邀请你加入游戏',
    leaderboardTitle: '排行榜', loading: '加载中…', yourStats: '你的战绩', statWins: '胜场', statGames: '总场次',
    statBestRound: '最佳单轮', statAccuracy: '准确率', statRank: '排名',
    accuracyExplain: '准确率 = 在你当时已知信息下，你的抽牌/交换决策中属于最佳选择的比例。',
    loginForLb: '登录（👥）后你的对局才会计入排行榜。', topPlayers: '顶尖玩家',
    lbPlayer: '玩家', lbWins: '胜场', lbAcc: '准确', noGames: '还没有对局 — 来当第一人吧！',
    ranked1v1: '排位 1v1', rankedNeedLogin: '登录后可玩排位 — 打开 👥 菜单。',
    rankedTag: '排位 1v1', rankedRules: '标准规则 · Glicko 计分',
    rankedWaitOpp: '分享房间码 — 等待对手加入…',
    ratingCol: '评分', recordCol: '胜–负', statRating: '评分', statRanked: '排位', unranked: '暂无评分',
    ratingToast: '排位评分：{rating}（{delta}）',
    authCta: '登录 / 注册', authCtaSub: '保存战绩、添加好友、畅玩排位。',
    powerYours: '配对能力牌 — 该你了！', powerOther: '{name} 正在使用配对的能力牌…',
    recentGames: '最近对局', noHistory: '还没有对局 —— 来玩一局吧！',
    liveGames: '进行中的对局 —— 点击加入',
    finalMatch: '最后的配对机会！', finalMatchSub: '正在亮出分数…',
    histShed: '打出的牌（配对）', histPowers: '使用的能力牌',
    tierBronze: '青铜', tierSilver: '白银', tierGold: '黄金', tierPlatinum: '铂金', tierDiamond: '钻石', tierMaster: '大师',
    achievementsLabel: '成就', achUnlocked: '成就解锁',
    ach_first_win: '首胜', ach_red_king: '红K', ach_perfect_round: '完美一轮', ach_shed3: '出牌高手', ach_power3: '能力大师', ach_low_score: '轻量级', ach_dutch_win: '喊中了', ach_ranked_win: '排位胜利', ach_veteran: '老兵', ach_invite_1: '招募者', ach_invite_5: '大使', ach_invite_10: '布道者',
    inviteFriends: '邀请好友', inviteCopied: '邀请链接已复制！', inviteNeedLogin: '登录后获取你的邀请链接。', statInvited: '已邀请',
    shareText: '来和我一起玩 Dutch —— 分数最低者获胜！', referralJoined: '有好友通过你的邀请加入了！（共 {n} 人）',
    cardBacksLabel: '牌背', cardBacksHint: '边玩边解锁牌背样式 —— 你装备的牌背，牌桌上所有人都能看到。',
    backEquip: '装备', backEquippedTag: '已装备', backEquipped: '已装备 {name}',
    back_classic: '经典', back_crimson: '绯红', back_emerald: '翡翠', back_amber: '琥珀', back_royal: '皇家', back_noir: '暗夜',
    backReqDefault: '始终拥有', backReqCrimson: '赢一局', backReqEmerald: '玩 10 局',
    backReqAmber: '邀请一位好友', backReqRoyal: '获得 5 个成就', backReqNoir: '达到白金（1700）',
    back_ocean: '海洋', back_rose: '玫瑰', back_sunset: '日落', back_frost: '霜寒', back_orchid: '兰花', back_aurora: '极光',
    backReqOcean: '玩 25 局', backReqRose: '赢 5 局', backReqSunset: '赢 25 局',
    backReqFrost: '邀请 3 位好友', backReqOrchid: '获得 10 个成就', backReqAurora: '达到大师（2000）',
    tableFeltsLabel: '牌桌', tableFeltsHint: '设置你的牌桌颜色 —— 仅你自己可见。',
    felt_classic: '翡翠', felt_midnight: '午夜', felt_slate: '石板', felt_crimson: '绯红', felt_royal: '皇家', felt_sunrise: '日出',
    feltReqDefault: '始终拥有', feltReqMidnight: '玩 5 局', feltReqSlate: '玩 20 局',
    feltReqCrimson: '赢 3 局', feltReqRoyal: '获得 3 个成就', feltReqSunrise: '达到黄金（1550）',
    powerCards: '能力牌', powBasic: '基础', powFull: '完整',
    peekSelfMsg: '7/8：查看你自己的一张牌', peekOtherMsg: '9/10：查看对手的一张牌',
    peekResolving: '正在结算偷看…', opponentPeek: '已亮出的牌',
    tutStep: '第 {n} / {total} 步', tutBack: '上一步', tutNext: '下一步', tutPlay: '开始游戏', tutClose: '关闭',
    tutTitle1: '欢迎来到 Dutch',
    tutBody1: '每位玩家都会得到一排背面朝上的牌。目标很简单：当有人喊出“Dutch”时，拥有<strong>最低的总分</strong>。小牌好、大牌差 —— 而记忆力很关键。',
    tutTitle2: '牌的分值',
    tutBody2: '数字牌按面值计分。<strong>A = 1</strong>，<strong>J = 11</strong>，<strong>Q = 12</strong>。<br/>特别之处：<strong>红色 K 为 0 分</strong>（全场最好的牌！），而<strong>黑色 K 为 13 分</strong>（最差）。',
    tutTitle3: '开局偷看',
    tutBody3: '开始前，一名玩家选一个数字（0–4）。然后每个人<strong>私下查看自己相应数量的牌</strong>。记住它们是什么、在哪里！',
    tutTitle4: '轮到你时',
    tutBody4: '在两件事中<strong>选一件</strong>：<br/>• <strong>交换</strong>：把正面朝上的弃牌换进你的一排 —— 用这张更小的牌替换掉大牌来降低分数。<br/>• <strong>抽牌</strong>：把牌堆顶的牌翻到弃牌堆 —— 主要用来触发能力牌。<br/>然后结束你的回合。',
    tutTitle5: '能力牌',
    tutBody5: '当一张 <strong>J</strong>、<strong>Q</strong> 或 <strong>A</strong> 正面朝上（你翻出的，或从你一排弃出的）时，其能力触发：<br/>• <strong>J</strong> —— 盲换桌上任意两张牌。<br/>• <strong>Q</strong> —— 秘密偷看任意一张牌。<br/>• <strong>A</strong> —— 给任意玩家一张暗牌（抬高其分数）。',
    tutTitle6: '配对',
    tutBody6: '如果你知道自己某张暗牌与弃牌堆顶牌<strong>点数相同</strong>（例如两张 7，或两张 K），点击<strong>配对</strong>并选中它打出 —— 这样你就少一张牌。<strong>即使不是你的回合也可以这么做</strong>！但猜错就要<strong>罚抽一张牌</strong>。每回合开始时，当前玩家会先等待几秒，让所有人都有机会配对。',
    tutTitle7: '喊“Dutch”',
    tutBody7: '觉得自己的总分最低了吗？先走完你的回合，然后<strong>喊 Dutch</strong>。其他人各有<strong>最后一个回合</strong>，随后所有牌亮出、公布分数。最低分获胜 —— 有把握时再喊！',
    tutTitle8: '你准备好了！',
    tutBody8: '<strong>创建一局游戏</strong>并把房间码分享给好友，<strong>添加机器人</strong>来练习，或打开 👥 菜单注册用户名并添加好友。玩得开心！',
    tutTagBest: '0 — 最好！', tutTag1: '1', tutTagWorst: '13 — 最差', tutTagSwap: '交换', tutTagPeek: '偷看',
    tutTagGive: '给牌', tutTagDiscard: '弃牌', tutTagYourCard: '你的牌',
  },
};
// Event-log templates (server sends structured {code, ...params}; the client localizes).
const LOGT = {
  en: {
    reshuffle: 'Draw pile was empty — reshuffled the discard pile.',
    matching: '{name} is matching — play paused.', flip: '{name} flipped {card}.',
    matched: '{name} matched {card} and dropped a card!',
    wrongMatch: '{name} tried to match {card} — wrong! Drew a penalty card.',
    swap: '{name} swapped in {card}, discarded {old}.', dutch: '{name} called Dutch!',
    jack: '{name} used the Jack to blind-swap two cards.',
    queen: "{name} used the Queen to peek at {target}'s card.",
    peekSelf: '{name} peeked at their own card.', peekOther: "{name} peeked at {target}'s card.",
    noGive: 'No cards left to give.', ace: '{name} used the Ace to give {target} a card.',
    matchExpired: 'Match window expired — play resumes.', autoplay: '{name} was {reason} — auto-playing their turn.',
  },
  es: {
    reshuffle: 'El mazo estaba vacío — se rebarajó el descarte.',
    matching: '{name} está emparejando — juego en pausa.', flip: '{name} robó {card}.',
    matched: '¡{name} emparejó {card} y soltó una carta!',
    wrongMatch: '{name} intentó emparejar {card} — ¡mal! Roba una carta de penalización.',
    swap: '{name} cambió por {card} y descartó {old}.', dutch: '¡{name} cantó Dutch!',
    jack: '{name} usó la Jota para cambiar dos cartas a ciegas.',
    queen: '{name} usó la Reina para mirar la carta de {target}.',
    peekSelf: '{name} miró una de sus cartas.', peekOther: '{name} miró una carta de {target}.',
    noGive: 'No quedan cartas para dar.', ace: '{name} usó el As para dar una carta a {target}.',
    matchExpired: 'La ventana de emparejado terminó — se reanuda el juego.', autoplay: '{name} estaba {reason} — se juega su turno automáticamente.',
  },
  fr: {
    reshuffle: 'La pioche était vide — la défausse a été remélangée.',
    matching: '{name} associe — jeu en pause.', flip: '{name} a pioché {card}.',
    matched: '{name} a associé {card} et posé une carte !',
    wrongMatch: "{name} a tenté d'associer {card} — raté ! Pioche une carte de pénalité.",
    swap: '{name} a échangé pour {card} et défaussé {old}.', dutch: '{name} a annoncé Dutch !',
    jack: "{name} a utilisé le Valet pour échanger deux cartes à l'aveugle.",
    queen: '{name} a utilisé la Dame pour regarder la carte de {target}.',
    peekSelf: '{name} a regardé une de ses cartes.', peekOther: '{name} a regardé une carte de {target}.',
    noGive: 'Plus de cartes à donner.', ace: "{name} a utilisé l'As pour donner une carte à {target}.",
    matchExpired: "La fenêtre d'association est terminée — le jeu reprend.", autoplay: '{name} était {reason} — son tour est joué automatiquement.',
  },
  de: {
    reshuffle: 'Der Stapel war leer — die Ablage wurde neu gemischt.',
    matching: '{name} legt ab — Spiel pausiert.', flip: '{name} zog {card}.',
    matched: '{name} legte {card} ab und wurde eine Karte los!',
    wrongMatch: '{name} wollte {card} ablegen — falsch! Zieht eine Strafkarte.',
    swap: '{name} tauschte {card} ein und legte {old} ab.', dutch: '{name} hat Dutch angesagt!',
    jack: '{name} nutzte den Buben für einen Blindtausch zweier Karten.',
    queen: '{name} nutzte die Dame, um die Karte von {target} anzusehen.',
    peekSelf: '{name} sah eine eigene Karte an.', peekOther: '{name} sah eine Karte von {target} an.',
    noGive: 'Keine Karten mehr zum Geben.', ace: '{name} nutzte das Ass, um {target} eine Karte zu geben.',
    matchExpired: 'Das Ablege-Fenster ist abgelaufen — das Spiel geht weiter.', autoplay: '{name} war {reason} — der Zug wird automatisch gespielt.',
  },
  zh: {
    reshuffle: '牌堆已空 —— 重新洗入弃牌堆。',
    matching: '{name} 正在配对 —— 游戏暂停。', flip: '{name} 抽到了 {card}。',
    matched: '{name} 用 {card} 配对成功，打出一张牌！',
    wrongMatch: '{name} 尝试用 {card} 配对 —— 配错了！罚抽一张牌。',
    swap: '{name} 换入 {card}，弃掉 {old}。', dutch: '{name} 喊了 Dutch！',
    jack: '{name} 使用 J 盲换了两张牌。',
    queen: '{name} 使用 Q 偷看了 {target} 的一张牌。',
    peekSelf: '{name} 查看了自己的一张牌。', peekOther: '{name} 查看了 {target} 的一张牌。',
    noGive: '没有牌可以给了。', ace: '{name} 使用 A 给了 {target} 一张牌。',
    matchExpired: '配对窗口已结束 —— 游戏继续。', autoplay: '{name} {reason} —— 自动完成其回合。',
  },
};
const REASONS = {
  en: { stuck: 'stuck', disconnected: 'disconnected', idle: 'idle' },
  es: { stuck: 'atascado', disconnected: 'desconectado', idle: 'inactivo' },
  fr: { stuck: 'bloqué', disconnected: 'déconnecté', idle: 'inactif' },
  de: { stuck: 'hängen geblieben', disconnected: 'getrennt', idle: 'untätig' },
  zh: { stuck: '卡住', disconnected: '掉线', idle: '挂机' },
};
function loadLang() { try { return localStorage.getItem('dutchLang') || ''; } catch (e) { return ''; } }
function saveLang(l) { try { localStorage.setItem('dutchLang', l); } catch (e) {} }
let lang = loadLang() || 'en';
try { document.documentElement.lang = lang; } catch (e) {}
// Remember a referral code from an invite link (?ref=NAME) until the visitor signs up.
try { const _ref = new URLSearchParams(location.search).get('ref'); if (_ref) localStorage.setItem('dutchRef', _ref.slice(0, 32)); } catch (e) {}
function t(key, params) {
  let s = (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.en[key] || key;
  if (params) for (const k in params) s = s.split('{' + k + '}').join(params[k]);
  return s;
}
function formatLog(entry) {
  if (typeof entry === 'string') return escapeHtml(entry); // backward-compat with any old string entries
  const set = LOGT[lang] || LOGT.en;
  let tmpl = set[entry.code] || LOGT.en[entry.code] || entry.code;
  const rset = REASONS[lang] || REASONS.en;
  const rep = {
    name: escapeHtml(entry.name || ''), card: escapeHtml(entry.card || ''),
    old: escapeHtml(entry.old || ''), target: escapeHtml(entry.target || ''),
    reason: escapeHtml((entry.reason && (rset[entry.reason] || entry.reason)) || ''),
  };
  for (const k in rep) tmpl = tmpl.split('{' + k + '}').join(rep[k]);
  return tmpl;
}
function setLanguage(code) {
  lang = code;
  saveLang(code);
  try { document.documentElement.lang = code; } catch (e) {}  // a11y: correct pronunciation
  const prof = loadProfile();
  if (prof && prof.userId) sendMsg({ type: 'setLang', lang: code });
  render();
}
function showLanguageModal(firstTime) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const box = el(`<div class="overlay" style="z-index:100;"><div class="overlay-box">
    <h2>🌐 ${t('chooseLanguage')}</h2>
    <div class="lang-grid"></div>
  </div></div>`);
  const grid = box.querySelector('.lang-grid');
  LANGS.forEach((L) => {
    const b = el(`<button class="lang-btn ${L.code === lang ? 'on' : ''}">${L.flag} ${L.name}</button>`);
    b.onclick = () => { setLanguage(L.code); root.innerHTML = ''; };
    grid.appendChild(b);
  });
  root.appendChild(box);
}

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

// a11y: make a clickable non-button element keyboard-operable (Enter/Space).
function makeKeyActivatable(node, handler) {
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
  });
}

// a11y: Escape closes the top-most open overlay.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (typeof tutorialOpen !== 'undefined' && tutorialOpen) { closeTutorial(); return; }
  const modal = document.getElementById('modal-root');
  if (modal && modal.innerHTML) { modal.innerHTML = ''; return; }
  if (chatOpen || friendsPanelOpen || leaderboardOpen) {
    chatOpen = false; friendsPanelOpen = false; leaderboardOpen = false;
    refreshFriendsPanel();
    return;
  }
  document.getElementById('emote-picker')?.remove();
});

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsOpen = true;
    reconnectDelay = 1000;
    const prof = loadProfile();
    if (prof && prof.userId && prof.secret) {
      applyTableFelt(prof.tableFelt || 'classic');   // avoid a felt flash before identity lands
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
    if (latestState.phase !== 'reveal') lastRankedUpdate = null;  // stale after a new round starts
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
    saveProfile({ userId: data.userId, secret: data.secret || prof.secret, username: data.username, email: data.email || null,
                  cardBack: data.cardBack || 'classic', tableFelt: data.tableFelt || 'classic' });
    applyTableFelt(data.tableFelt || 'classic');
    if (data.lang && data.lang !== lang) { lang = data.lang; saveLang(data.lang); }
    try { localStorage.removeItem('dutchRef'); } catch (e) {}  // referral consumed / no longer needed
    if (data.recoveryCode) showRecoveryModal(data.recoveryCode);
  } else if (data.type === 'identityFailed') {
    // Stored session is no longer valid (expired, logged out elsewhere, or data reset).
    clearProfile();
  } else if (data.type === 'loggedOut') {
    clearProfile();
  } else if (data.type === 'emote') {
    popEmote(data.playerId, data.emoji);
    return;
  } else if (data.type === 'chat') {
    chatLog.push({ playerId: data.playerId, name: data.name, text: data.text, mine: data.playerId === myId });
    if (chatLog.length > 100) chatLog.shift();
    if (chatOpen) { refreshFriendsPanel(); scrollChatToBottom(); }
    else { chatUnread++; if (data.playerId !== myId) showToast(`${data.name}: ${data.text}`); render(); }
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
    showToast(data.won ? t('youWon', { n: data.stats.wins }) : t('gameRecorded', { n: data.stats.games }));
  } else if (data.type === 'rankedUpdate') {
    lastRankedUpdate = { rating: data.rating, delta: data.delta, won: data.won };
    const sign = data.delta > 0 ? '+' : '';
    showToast(t('ratingToast', { rating: data.rating, delta: sign + data.delta }));
  } else if (data.type === 'publicRooms') {
    publicRooms = data.rooms || [];
    if (!latestState) render();  // only the landing shows this list
    return;
  } else if (data.type === 'leaderboard') {
    leaderboardData = data;
    if (leaderboardOpen) renderLeaderboardRoot();
  } else if (data.type === 'friendsUpdate') {
    friendsState = { friends: data.friends, incoming: data.incoming, outgoing: data.outgoing };
  } else if (data.type === 'referralJoined') {
    showToast(`🎉 ${t('referralJoined', { n: data.count })}`);
    return;
  } else if (data.type === 'cosmetic') {
    const prof = loadProfile();
    if (data.kind === 'tableFelt') {
      if (prof) { prof.tableFelt = data.id; saveProfile(prof); }
      applyTableFelt(data.id);
      showToast(`🎨 ${t('backEquipped', { name: t('felt_' + data.id) })}`);
    } else {
      if (prof) { prof.cardBack = data.id; saveProfile(prof); }
      showToast(`🎨 ${t('backEquipped', { name: t('back_' + data.id) })}`);
    }
    if (leaderboardOpen) renderLeaderboardRoot();
    return;
  } else if (data.type === 'achievements') {
    (data.earned || []).forEach((code) => {
      showToast(`${ACHIEVEMENTS[code] || '🏅'} ${t('achUnlocked')}: ${achName(code)}`);
    });
    return;
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

// Glicko rating -> visible rank tier (only for players who've played ranked).
const RANK_TIERS = [
  { min: 2000, key: 'tierMaster', cls: 'master', icon: '👑' },
  { min: 1850, key: 'tierDiamond', cls: 'diamond', icon: '💎' },
  { min: 1700, key: 'tierPlatinum', cls: 'platinum', icon: '🛡️' },
  { min: 1550, key: 'tierGold', cls: 'gold', icon: '🥇' },
  { min: 1400, key: 'tierSilver', cls: 'silver', icon: '🥈' },
  { min: -Infinity, key: 'tierBronze', cls: 'bronze', icon: '🥉' },
];
function tierBadge(rating) {
  if (rating == null) return '';
  const tier = RANK_TIERS.find((x) => rating >= x.min);
  return `<span class="tier-badge ${tier.cls}">${tier.icon} ${escapeHtml(t(tier.key))}</span>`;
}

// Unlockable card-back skins. `unlock(stats, achCount)` mirrors the server's
// gate in server.py; `req` is an i18n key describing how to earn it. Order is
// the display order in the picker.
const CARD_BACKS = [
  { id: 'classic', unlock: () => true,                    req: 'backReqDefault' },
  { id: 'crimson', unlock: (s) => (s.wins || 0) >= 1,      req: 'backReqCrimson' },
  { id: 'emerald', unlock: (s) => (s.games || 0) >= 10,    req: 'backReqEmerald' },
  { id: 'amber',   unlock: (s) => (s.referrals || 0) >= 1, req: 'backReqAmber' },
  { id: 'royal',   unlock: (s, ac) => ac >= 5,             req: 'backReqRoyal' },
  { id: 'noir',    unlock: (s) => (s.rating || 0) >= 1700, req: 'backReqNoir' },
  { id: 'ocean',   unlock: (s) => (s.games || 0) >= 25,    req: 'backReqOcean' },
  { id: 'rose',    unlock: (s) => (s.wins || 0) >= 5,      req: 'backReqRose' },
  { id: 'sunset',  unlock: (s) => (s.wins || 0) >= 25,     req: 'backReqSunset' },
  { id: 'frost',   unlock: (s) => (s.referrals || 0) >= 3, req: 'backReqFrost' },
  { id: 'orchid',  unlock: (s, ac) => ac >= 10,            req: 'backReqOrchid' },
  { id: 'aurora',  unlock: (s) => (s.rating || 0) >= 2000, req: 'backReqAurora' },
];

// Table-felt themes — recolor your table, for your view only (mirrors TABLE_FELTS
// in server.py). Applied as a felt-<id> class on <html>.
const TABLE_FELTS = [
  { id: 'classic',  unlock: () => true,                    req: 'feltReqDefault' },
  { id: 'midnight', unlock: (s) => (s.games || 0) >= 5,     req: 'feltReqMidnight' },
  { id: 'slate',    unlock: (s) => (s.games || 0) >= 20,    req: 'feltReqSlate' },
  { id: 'crimson',  unlock: (s) => (s.wins || 0) >= 3,      req: 'feltReqCrimson' },
  { id: 'royal',    unlock: (s, ac) => ac >= 3,             req: 'feltReqRoyal' },
  { id: 'sunrise',  unlock: (s) => (s.rating || 0) >= 1550, req: 'feltReqSunrise' },
];

function applyTableFelt(id) {
  const ok = TABLE_FELTS.some((f) => f.id === id) ? id : 'classic';
  const root = document.documentElement;
  [...root.classList].forEach((c) => { if (c.startsWith('felt-')) root.classList.remove(c); });
  root.classList.add('felt-' + ok);
}

// Achievement code -> icon; the name comes from t('ach_' + code).
const ACHIEVEMENTS = {
  first_win: '🏆', red_king: '👑', perfect_round: '🎯', shed3: '🃏', power3: '⚡',
  low_score: '🪶', dutch_win: '📣', ranked_win: '⚔️', veteran: '🎖️',
  invite_1: '🎁', invite_5: '🤝', invite_10: '🌟',
};
function achName(code) { return t('ach_' + code); }

// Motivate sharing: a personal invite link (?ref=username). New signups
// through it earn the inviter the Recruiter/Ambassador badges.
function inviteFriends() {
  const p = loadProfile();
  if (!p || !p.username) {
    showToast(t('inviteNeedLogin'), true);
    authTab = 'signup'; friendsPanelOpen = true; leaderboardOpen = false; chatOpen = false; refreshFriendsPanel();
    return;
  }
  const link = `${location.origin}/?ref=${encodeURIComponent(p.username)}`;
  if (navigator.share) {
    navigator.share({ title: 'Dutch', text: t('shareText'), url: link }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(link).then(() => showToast(t('inviteCopied'))).catch(() => showToast(link));
  }
}

// Localized "3h ago" / "hace 3 h" / "3小时前" from an epoch-seconds timestamp.
function relTime(sec) {
  if (!sec) return '';
  const diff = sec - Date.now() / 1000; // negative for the past
  const abs = Math.abs(diff);
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 2592000) return rtf.format(Math.round(diff / 86400), 'day');
    return rtf.format(Math.round(diff / 2592000), 'month');
  } catch (e) {
    return Math.round(abs / 3600) + 'h';
  }
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

function cardBack(sizeClass, skin) {
  const s = CARD_BACKS.some(b => b.id === skin) ? skin : 'classic';
  return el(`<div class="card back back-${s} ${sizeClass}"></div>`);
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
  const title = data.context === 'peek' ? t('yourPeek')
    : data.context === 'peekOther' ? t('opponentPeek')
    : t('queensPeek');
  const box = el(`<div class="overlay">
    <div class="overlay-box">
      <h2>${escapeHtml(title)}</h2>
      <div class="big-card-wrap"></div>
      <button class="btn-blue" id="reveal-close-btn">${escapeHtml(t('gotIt'))}</button>
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
  const toast = el(`<div class="toast invite">
    <span>${escapeHtml(t('invitedYou', { name: fromUsername }))} <strong>${escapeHtml(code)}</strong></span>
    <button class="btn-gold" id="inv-join">${escapeHtml(t('joinBtn'))}</button>
    <button class="btn-ghost" id="inv-close">✕</button>
  </div>`);
  toast.querySelector('#inv-join').onclick = () => {
    const prof = loadProfile();
    clearSession();
    sendMsg({ type: 'joinRoom', name: (prof && prof.username) || 'Player', code });
    toast.remove();
  };
  toast.querySelector('#inv-close').onclick = () => toast.remove();
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 60000);
}

function friendsFab() {
  const incoming = friendsState ? friendsState.incoming.length : 0;
  const fab = el(`<button class="friends-fab" aria-label="${t('friends')}" title="${t('friends')}">👥${incoming ? `<span class="fab-badge">${incoming}</span>` : ''}</button>`);
  fab.onclick = () => { friendsPanelOpen = !friendsPanelOpen; leaderboardOpen = false; chatOpen = false; refreshFriendsPanel(); };
  return fab;
}

function chatFab() {
  const fab = el(`<button class="chat-fab" aria-label="${escapeHtml(t('chat'))}" title="${escapeHtml(t('chat'))}">💬${chatUnread ? `<span class="fab-badge">${chatUnread}</span>` : ''}</button>`);
  fab.onclick = () => {
    chatOpen = !chatOpen;
    if (chatOpen) { chatUnread = 0; friendsPanelOpen = false; leaderboardOpen = false; }
    refreshFriendsPanel();
    if (chatOpen) scrollChatToBottom();
  };
  return fab;
}

function refreshFriendsPanel() {
  const root = document.getElementById('panel-root');
  root.innerHTML = '';
  if (leaderboardOpen) { root.appendChild(renderLeaderboard()); return; }
  if (chatOpen) { root.appendChild(renderChat()); return; }
  if (friendsPanelOpen) root.appendChild(renderFriendsPanel());
}

function renderChat() {
  const overlay = el(`<div class="overlay drawer-overlay"></div>`);
  overlay.onclick = (e) => { if (e.target === overlay) { chatOpen = false; refreshFriendsPanel(); } };
  const drawer = el(`<div class="friends-drawer"></div>`);
  overlay.appendChild(drawer);
  const header = el(`<div class="row between"><h2 style="margin:0; font-size:1.2rem;">💬 ${t('chat')}</h2><button class="btn-ghost" style="padding:6px 12px;">✕</button></div>`);
  header.querySelector('button').onclick = () => { chatOpen = false; refreshFriendsPanel(); };
  drawer.appendChild(header);

  const list = el(`<div class="chat-list" id="chat-list"></div>`);
  if (!chatLog.length) list.appendChild(el(`<div class="help-text" style="text-align:center;">${t('chatEmpty')}</div>`));
  chatLog.forEach((m) => {
    const row = el(`<div class="chat-msg ${m.mine ? 'mine' : ''}"></div>`);
    if (!m.mine) row.appendChild(el(`<div class="chat-name">${escapeHtml(m.name)}</div>`));
    row.appendChild(el(`<div class="chat-bubble">${escapeHtml(m.text)}</div>`));
    list.appendChild(row);
  });
  drawer.appendChild(list);

  const form = el(`<div class="row" style="margin-top:8px;">
    <input type="text" id="chat-input" class="grow" placeholder="${t('chatPlaceholder')}" maxlength="200" autocomplete="off" />
    <button class="btn-blue" id="chat-send">${t('send')}</button>
  </div>`);
  const send = () => {
    const inp = form.querySelector('#chat-input');
    const text = inp.value.trim();
    if (text) { sendMsg({ type: 'chat', text }); inp.value = ''; inp.focus(); }
  };
  form.querySelector('#chat-send').onclick = send;
  form.querySelector('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  drawer.appendChild(form);
  return overlay;
}

function scrollChatToBottom() {
  setTimeout(() => { const l = document.getElementById('chat-list'); if (l) l.scrollTop = l.scrollHeight; }, 20);
}

function showRecoveryModal(code) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const box = el(`<div class="overlay" style="z-index:100;">
    <div class="overlay-box">
      <h2>${escapeHtml(t('saveRecovery'))}</h2>
      <p class="help-text">${escapeHtml(t('recoveryExplain'))}</p>
      <div class="recovery-code" id="rec-code">${escapeHtml(code)}</div>
      <div class="row center" style="gap:10px; margin-top:16px;">
        <button class="btn-ghost" id="rec-copy">${escapeHtml(t('copy'))}</button>
        <button class="btn-gold" id="rec-done">${escapeHtml(t('savedIt'))}</button>
      </div>
    </div>
  </div>`);
  box.querySelector('#rec-copy').onclick = () => navigator.clipboard?.writeText(code).then(() => showToast(t('recoveryCopied')));
  box.querySelector('#rec-done').onclick = () => { root.innerHTML = ''; };
  root.appendChild(box);
}

function renderAuthForm() {
  const wrap = el(`<div class="col"></div>`);
  const tabs = el(`<div class="auth-tabs">
    <button class="auth-tab ${authTab === 'login' ? 'on' : ''}" data-tab="login">${escapeHtml(t('login'))}</button>
    <button class="auth-tab ${authTab === 'signup' ? 'on' : ''}" data-tab="signup">${escapeHtml(t('signup'))}</button>
  </div>`);
  tabs.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.onclick = () => { authTab = tab.dataset.tab; refreshFriendsPanel(); };
  });
  wrap.appendChild(tabs);

  if (authTab === 'recover') {
    wrap.appendChild(el(`<p class="help-text">${escapeHtml(t('recoverIntro'))}</p>`));
    const form = el(`<div class="col">
      <input type="text" id="auth-user" placeholder="${escapeHtml(t('phUsername'))}" maxlength="16" autocomplete="username" />
      <input type="text" id="auth-code" placeholder="${escapeHtml(t('phRecoveryCode'))}" autocomplete="off" />
      <input type="password" id="auth-newpw" placeholder="${escapeHtml(t('phNewPw'))}" autocomplete="new-password" />
      <button class="btn-gold" id="auth-submit">${escapeHtml(t('resetLogin'))}</button>
    </div>`);
    form.querySelector('#auth-submit').onclick = () => {
      const u = form.querySelector('#auth-user').value.trim();
      const c = form.querySelector('#auth-code').value.trim();
      const pw = form.querySelector('#auth-newpw').value;
      if (u && c) sendMsg({ type: 'recover', username: u, code: c, newPassword: pw || undefined });
    };
    wrap.appendChild(form);

    wrap.appendChild(el(`<div class="section-label">${escapeHtml(t('orEmailReset'))}</div>`));
    const emForm = el(`<div class="row">
      <input type="text" id="reset-ident" class="grow" placeholder="${escapeHtml(t('phUserOrEmail'))}" autocomplete="off" />
      <button class="btn-blue" id="reset-send">${escapeHtml(t('send'))}</button>
    </div>`);
    emForm.querySelector('#reset-send').onclick = () => {
      const v = emForm.querySelector('#reset-ident').value.trim();
      if (v) sendMsg({ type: 'requestEmailReset', identifier: v });
    };
    wrap.appendChild(emForm);

    const back = el(`<button class="btn-ghost" style="background:transparent;">${escapeHtml(t('backToLogin'))}</button>`);
    back.onclick = () => { authTab = 'login'; refreshFriendsPanel(); };
    wrap.appendChild(back);
    return wrap;
  }

  const isSignup = authTab === 'signup';
  wrap.appendChild(el(`<p class="help-text">${escapeHtml(isSignup ? t('signupIntro') : t('loginIntro'))}</p>`));
  const form = el(`<div class="col">
    <input type="text" id="auth-user" placeholder="${escapeHtml(t('phUsernameRules'))}" maxlength="16" autocomplete="username" />
    <input type="password" id="auth-pw" placeholder="${escapeHtml(t('phPassword'))}" autocomplete="${isSignup ? 'new-password' : 'current-password'}" />
    ${isSignup ? `<input type="email" id="auth-email" placeholder="${escapeHtml(t('phEmailOpt'))}" autocomplete="email" />` : ''}
    <button class="btn-gold" id="auth-submit">${escapeHtml(isSignup ? t('createAccount') : t('login'))}</button>
    ${isSignup ? '' : `<button class="btn-ghost" id="auth-forgot" style="background:transparent;">${escapeHtml(t('forgotPw'))}</button>`}
  </div>`);
  form.querySelector('#auth-submit').onclick = () => {
    const u = form.querySelector('#auth-user').value.trim();
    const pw = form.querySelector('#auth-pw').value;
    if (!u || !pw) { showToast(t('enterUserPass'), true); return; }
    const msg = { type: isSignup ? 'signup' : 'login', username: u, password: pw };
    if (isSignup) {
      const em = form.querySelector('#auth-email').value.trim();
      if (em) msg.email = em;
      msg.lang = lang;
      try { const r = localStorage.getItem('dutchRef'); if (r) msg.ref = r; } catch (e) {}
    }
    sendMsg(msg);
  };
  const forgot = form.querySelector('#auth-forgot');
  if (forgot) forgot.onclick = () => { authTab = 'recover'; refreshFriendsPanel(); };
  form.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') form.querySelector('#auth-submit').click(); });
  });
  wrap.appendChild(form);

  const guest = el(`<button class="btn-ghost" style="background:transparent; margin-top:4px;">${escapeHtml(t('playGuest'))}</button>`);
  guest.onclick = () => { friendsPanelOpen = false; refreshFriendsPanel(); showToast(t('playingGuest')); };
  wrap.appendChild(guest);
  return wrap;
}

function renderFriendsPanel() {
  const prof = loadProfile();
  const overlay = el(`<div class="overlay drawer-overlay"></div>`);
  overlay.onclick = (e) => { if (e.target === overlay) { friendsPanelOpen = false; refreshFriendsPanel(); } };
  const drawer = el(`<div class="friends-drawer"></div>`);
  overlay.appendChild(drawer);

  const header = el(`<div class="row between"><h2 style="margin:0; font-size:1.2rem;">${escapeHtml(t('friends'))}</h2><button class="btn-ghost" style="padding:6px 12px;">✕</button></div>`);
  header.querySelector('button').onclick = () => { friendsPanelOpen = false; refreshFriendsPanel(); };
  drawer.appendChild(header);

  if (!prof || !prof.username) {
    drawer.appendChild(renderAuthForm());
    return overlay;
  }

  const signedRow = el(`<div class="row between" style="align-items:center;">
    <div class="help-text">${escapeHtml(t('signedInAs'))} <strong style="color:var(--ink);">${escapeHtml(prof.username)}</strong></div>
    <button class="btn-ghost" style="padding:6px 12px;">${escapeHtml(t('logout'))}</button>
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
    <input type="email" id="acct-email" class="grow" placeholder="${escapeHtml(t('phAddEmail'))}" value="${escapeHtml(prof.email || '')}" autocomplete="email" />
    <button class="btn-ghost" id="acct-email-save" style="padding:8px 12px;">${escapeHtml(t('save'))}</button>
  </div>`);
  emailRow.querySelector('#acct-email-save').onclick = () => {
    sendMsg({ type: 'setEmail', email: emailRow.querySelector('#acct-email').value.trim() });
  };
  drawer.appendChild(emailRow);

  const addForm = el(`<div class="row">
    <input type="text" id="add-friend-input" class="grow" placeholder="${escapeHtml(t('phAddFriend'))}" maxlength="16" autocomplete="off" />
    <button class="btn-blue" id="add-friend-btn">${escapeHtml(t('add'))}</button>
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
    drawer.appendChild(el(`<div class="section-label">${escapeHtml(t('requests'))}</div>`));
    fs.incoming.forEach((u) => {
      const row = el(`<div class="friend-row">
        <span class="grow">${escapeHtml(u.username)}</span>
        <button class="btn-gold" style="padding:6px 12px;">${escapeHtml(t('accept'))}</button>
        <button class="btn-ghost" style="padding:6px 10px;">✕</button>
      </div>`);
      const [acceptBtn, declineBtn] = row.querySelectorAll('button');
      acceptBtn.onclick = () => sendMsg({ type: 'friendRespond', userId: u.id, accept: true });
      declineBtn.onclick = () => sendMsg({ type: 'friendRespond', userId: u.id, accept: false });
      drawer.appendChild(row);
    });
  }

  if (fs.outgoing.length) {
    drawer.appendChild(el(`<div class="section-label">${escapeHtml(t('sentWaiting'))}</div>`));
    fs.outgoing.forEach((u) => {
      const row = el(`<div class="friend-row">
        <span class="grow">${escapeHtml(u.username)}</span>
        <button class="btn-ghost" style="padding:6px 10px;" title="${escapeHtml(t('cancelRequest'))}">✕</button>
      </div>`);
      row.querySelector('button').onclick = () => sendMsg({ type: 'friendRemove', userId: u.id });
      drawer.appendChild(row);
    });
  }

  drawer.appendChild(el(`<div class="section-label">${escapeHtml(t('friendsCount', { n: fs.friends.length }))}</div>`));
  if (!fs.friends.length) {
    drawer.appendChild(el(`<div class="help-text">${escapeHtml(t('noFriends'))}</div>`));
  }
  const canInvite = latestState && latestState.phase === 'lobby';
  fs.friends.forEach((u) => {
    const row = el(`<div class="friend-row">
      <span class="online-dot ${u.online ? '' : 'off'}"></span>
      <span class="grow">${escapeHtml(u.username)}</span>
      ${canInvite && u.online ? `<button class="btn-blue" style="padding:6px 12px;">${escapeHtml(t('invite'))}</button>` : ''}
      <button class="btn-ghost" style="padding:6px 10px;" title="${escapeHtml(t('unfriend'))}">✕</button>
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
    drawer.appendChild(el(`<div class="help-text">${escapeHtml(t('onlineInvite'))}</div>`));
  }

  return overlay;
}

/* ---------- Tutorial ---------- */

function helpFab() {
  const fab = el(`<button class="help-fab" aria-label="${t('howToPlay')}" title="${t('howToPlay')}">?</button>`);
  fab.onclick = () => openTutorial();
  return fab;
}

function langFab() {
  const fab = el(`<button class="lang-fab" aria-label="${t('language')}" title="${t('language')}">🌐</button>`);
  fab.onclick = () => showLanguageModal(false);
  return fab;
}

function soundFab() {
  const fab = el(`<button class="sound-fab" aria-label="${escapeHtml(t('soundTip'))}" title="${escapeHtml(t('soundTip'))}">${sound.enabled ? '🔊' : '🔇'}</button>`);
  fab.onclick = () => {
    sound.setEnabled(!sound.enabled);
    if (sound.enabled) { sound.unlock(); sound.play('turn'); }
    fab.textContent = sound.enabled ? '🔊' : '🔇';
  };
  return fab;
}

/* ---------- Leaderboard ---------- */

function leaderboardFab() {
  const fab = el(`<button class="lb-fab" aria-label="${escapeHtml(t('leaderboardTip'))}" title="${escapeHtml(t('leaderboardTip'))}">🏆</button>`);
  fab.onclick = () => { leaderboardOpen = true; friendsPanelOpen = false; chatOpen = false; leaderboardData = null; sendMsg({ type: 'getLeaderboard' }); refreshFriendsPanel(); };
  return fab;
}

function renderLeaderboardRoot() { refreshFriendsPanel(); }

function renderLeaderboard() {
  const overlay = el(`<div class="overlay drawer-overlay"></div>`);
  overlay.onclick = (e) => { if (e.target === overlay) { leaderboardOpen = false; renderLeaderboardRoot(); } };
  const drawer = el(`<div class="friends-drawer"></div>`);
  overlay.appendChild(drawer);

  const header = el(`<div class="row between"><h2 style="margin:0; font-size:1.2rem;">🏆 ${escapeHtml(t('leaderboardTitle'))}</h2><button class="btn-ghost" style="padding:6px 12px;">✕</button></div>`);
  header.querySelector('button').onclick = () => { leaderboardOpen = false; renderLeaderboardRoot(); };
  drawer.appendChild(header);

  if (!leaderboardData) {
    drawer.appendChild(el(`<div class="help-text">${escapeHtml(t('loading'))}</div>`));
    return overlay;
  }

  const board = leaderboardData.board || [];
  if (leaderboardData.myStats && leaderboardData.myUsername) {
    const s = leaderboardData.myStats;
    drawer.appendChild(el(`<div class="my-stats">
      <div class="section-label">${escapeHtml(t('yourStats'))}</div>
      <div class="row wrap" style="gap:14px; margin-top:6px;">
        <span>${escapeHtml(t('statRating'))} <strong>${s.rating == null ? escapeHtml(t('unranked')) : s.rating}</strong> ${tierBadge(s.rating)}</span>
        ${s.ranked_games ? `<span>${escapeHtml(t('statRanked'))} <strong>${s.ranked_wins}–${s.ranked_games - s.ranked_wins}</strong></span>` : ''}
        ${s.rank ? `<span>${escapeHtml(t('statRank'))} <strong>#${s.rank}</strong></span>` : ''}
        <span><strong>${s.wins}</strong> ${escapeHtml(t('statWins'))}</span>
        <span><strong>${s.games}</strong> ${escapeHtml(t('statGames'))}</span>
        ${s.referrals ? `<span>🎁 <strong>${s.referrals}</strong> ${escapeHtml(t('statInvited'))}</span>` : ''}
        <span>${escapeHtml(t('statBestRound'))} <strong>${s.best_score == null ? '—' : s.best_score}</strong></span>
        <span>${escapeHtml(t('statAccuracy'))} <strong>${s.accuracy == null ? '—' : s.accuracy + '%'}</strong></span>
      </div>
      <div class="help-text" style="margin-top:8px;">${escapeHtml(t('accuracyExplain'))}</div>
    </div>`));
  } else {
    drawer.appendChild(el(`<div class="help-text">${escapeHtml(t('loginForLb'))}</div>`));
  }

  // Achievements (signed-in players only)
  if (leaderboardData.achievements && leaderboardData.achievements.length) {
    drawer.appendChild(el(`<div class="section-label" style="margin-top:12px;">${escapeHtml(t('achievementsLabel'))}</div>`));
    const wrap = el(`<div class="ach-list"></div>`);
    leaderboardData.achievements.forEach((code) => {
      wrap.appendChild(el(`<span class="ach-badge" title="${escapeHtml(achName(code))}">${ACHIEVEMENTS[code] || '🏅'} ${escapeHtml(achName(code))}</span>`));
    });
    drawer.appendChild(wrap);
  }

  // Cosmetics (signed-in players only): card backs + table felt
  if (leaderboardData.myStats && leaderboardData.myUsername) {
    const s = leaderboardData.myStats;
    const achCount = (leaderboardData.achievements || []).length;
    const prof = loadProfile() || {};

    const renderPicker = (opts, { kind, nameKey, equipped, preview, label, hint }) => {
      drawer.appendChild(el(`<div class="section-label" style="margin-top:14px;">${escapeHtml(t(label))}</div>`));
      drawer.appendChild(el(`<div class="help-text" style="margin-bottom:8px;">${escapeHtml(t(hint))}</div>`));
      const grid = el(`<div class="back-picker"></div>`);
      opts.forEach((o) => {
        const unlocked = o.unlock(s, achCount);
        const isOn = o.id === equipped;
        const cell = el(`<div class="back-option ${unlocked ? '' : 'locked'} ${isOn ? 'equipped' : ''}"></div>`);
        cell.appendChild(preview(o.id));
        cell.appendChild(el(`<div class="back-name">${escapeHtml(t(nameKey + o.id))}</div>`));
        if (isOn) cell.appendChild(el(`<div class="back-tag on">✓ ${escapeHtml(t('backEquippedTag'))}</div>`));
        else if (unlocked) cell.appendChild(el(`<div class="back-tag">${escapeHtml(t('backEquip'))}</div>`));
        else cell.appendChild(el(`<div class="back-tag lock">🔒 ${escapeHtml(t(o.req))}</div>`));
        if (unlocked && !isOn) {
          const equip = () => sendMsg({ type: 'setCosmetic', kind, id: o.id });
          cell.classList.add('selectable');
          cell.onclick = equip;
          makeKeyActivatable(cell, equip);
        }
        grid.appendChild(cell);
      });
      drawer.appendChild(grid);
    };

    renderPicker(CARD_BACKS, {
      kind: 'cardBack', nameKey: 'back_', equipped: prof.cardBack || 'classic',
      label: 'cardBacksLabel', hint: 'cardBacksHint',
      preview: (id) => cardBack('size-md', id),
    });
    renderPicker(TABLE_FELTS, {
      kind: 'tableFelt', nameKey: 'felt_', equipped: prof.tableFelt || 'classic',
      label: 'tableFeltsLabel', hint: 'tableFeltsHint',
      preview: (id) => el(`<div class="felt-swatch felt-${id}"></div>`),
    });
  }

  // Recent games (signed-in players only)
  if (leaderboardData.history) {
    drawer.appendChild(el(`<div class="section-label" style="margin-top:14px;">${escapeHtml(t('recentGames'))}</div>`));
    if (!leaderboardData.history.length) {
      drawer.appendChild(el(`<div class="help-text">${escapeHtml(t('noHistory'))}</div>`));
    } else {
      const list = el(`<div class="hist-list"></div>`);
      leaderboardData.history.forEach((g) => {
        let right;
        if (g.ranked && g.ratingDelta != null) {
          const d = (g.ratingDelta > 0 ? '+' : '') + g.ratingDelta;
          right = `<span class="hist-delta ${g.ratingDelta >= 0 ? 'up' : 'down'}">${escapeHtml(d)}</span>`;
        } else {
          right = `<span class="hist-players">${g.players}p</span>`;
        }
        const place = g.won ? '🏆' : (g.placement ? '#' + g.placement : '');
        const chips = [];
        if (g.accuracy != null) chips.push(`<span title="${escapeHtml(t('statAccuracy'))}">🎯 ${g.accuracy}%</span>`);
        chips.push(`<span title="${escapeHtml(t('histShed'))}">🃏 ${g.shed || 0}</span>`);
        chips.push(`<span title="${escapeHtml(t('histPowers'))}">⚡ ${g.powers || 0}</span>`);
        list.appendChild(el(`<div class="hist-item ${g.won ? 'won' : ''}">
          <div class="hist-row">
            <span class="hist-when">${escapeHtml(relTime(g.playedAt))}</span>
            <span class="hist-score">${place} ${g.total} ${escapeHtml(t('ptsUnit'))}</span>
            <span class="hist-right">${right}</span>
          </div>
          <div class="hist-sub">${chips.join('')}</div>
        </div>`));
      });
      drawer.appendChild(list);
    }
  }

  drawer.appendChild(el(`<div class="section-label">${escapeHtml(t('topPlayers'))}</div>`));
  const table = el(`<div class="lb-table"></div>`);
  table.appendChild(el(`<div class="lb-row lb-head"><span class="lb-rank">#</span><span class="grow">${escapeHtml(t('lbPlayer'))}</span><span class="lb-num lb-rating">${escapeHtml(t('ratingCol'))}</span><span class="lb-num">${escapeHtml(t('recordCol'))}</span></div>`));
  if (!board.length) {
    table.appendChild(el(`<div class="help-text" style="padding:10px;">${escapeHtml(t('noGames'))}</div>`));
  }
  board.forEach((r, i) => {
    const mine = leaderboardData.myUsername && r.username === leaderboardData.myUsername;
    const record = r.ranked_games ? `${r.ranked_wins}–${r.ranked_games - r.ranked_wins}` : '—';
    const tier = r.rating == null ? null : RANK_TIERS.find((x) => r.rating >= x.min);
    const ratingCell = tier ? `${tier.icon} ${r.rating}` : '—';
    const row = el(`<div class="lb-row ${mine ? 'me' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="grow">${escapeHtml(r.username)}</span>
      <span class="lb-num lb-rating" title="${tier ? escapeHtml(t(tier.key)) : ''}">${ratingCell}</span>
      <span class="lb-num">${record}</span>
    </div>`);
    table.appendChild(row);
  });
  drawer.appendChild(table);
  return overlay;
}

function startPublicRoomsPoll() {
  if (publicRoomsTimer) return;              // already polling
  if (wsOpen) sendMsg({ type: 'getPublicRooms' });
  publicRoomsTimer = setInterval(() => {
    if (!latestState && wsOpen) sendMsg({ type: 'getPublicRooms' });
  }, 5000);
}
function stopPublicRoomsPoll() {
  if (publicRoomsTimer) { clearInterval(publicRoomsTimer); publicRoomsTimer = null; }
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
    titleKey: 'tutTitle1',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus(['back', 'back', 'back', 'back'], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody1')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle2',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: 'K', suit: 'H' }, tag: t('tutTagBest'), tagClass: 'good' },
        { card: { rank: 'A', suit: 'S' }, tag: t('tutTag1') },
        { card: { rank: 'K', suit: 'S' }, tag: t('tutTagWorst'), tagClass: 'bad' },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody2')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle3',
    build: () => {
      const box = el(`<div></div>`);
      const row = el(`<div class="tutorial-illus"></div>`);
      row.appendChild(cardFront({ rank: '3', suit: 'C' }, 'size-md'));
      row.appendChild(cardFront({ rank: '7', suit: 'D' }, 'size-md'));
      row.appendChild(cardBack('size-md'));
      row.appendChild(cardBack('size-md'));
      box.appendChild(row);
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody3')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle4',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: 'K', suit: 'D' } },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody4')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle5',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: 'J', suit: 'S' }, tag: t('tutTagSwap') },
        { card: { rank: 'Q', suit: 'H' }, tag: t('tutTagPeek') },
        { card: { rank: 'A', suit: 'C' }, tag: t('tutTagGive') },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody5')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle6',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(tutorialIllus([
        { card: { rank: '7', suit: 'H' }, tag: t('tutTagDiscard') },
        { gap: true },
        { card: { rank: '7', suit: 'S' }, tag: t('tutTagYourCard') },
      ], 'size-md'));
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody6')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle7',
    build: () => {
      const box = el(`<div></div>`);
      const chip = el(`<div class="tutorial-illus"><span class="tutorial-dutch-chip">${escapeHtml(t('callDutch'))}</span></div>`);
      box.appendChild(chip);
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody7')}</div>`));
      return box;
    },
  },
  {
    titleKey: 'tutTitle8',
    build: () => {
      const box = el(`<div></div>`);
      box.appendChild(el(`<div class="tutorial-illus" style="font-size:2.4rem;">♠ ♥ ♣ ♦</div>`));
      box.appendChild(el(`<div class="tutorial-body">${t('tutBody8')}</div>`));
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
  const skip = el(`<button class="tutorial-skip" title="${escapeHtml(t('tutClose'))}">✕</button>`);
  skip.onclick = () => closeTutorial();
  box.appendChild(skip);
  box.appendChild(el(`<div class="tutorial-step">${escapeHtml(t('tutStep', { n: tutorialIndex + 1, total: TUTORIAL_PAGES.length }))}</div>`));
  box.appendChild(el(`<div class="tutorial-title">${escapeHtml(t(page.titleKey))}</div>`));
  box.appendChild(page.build());

  const dots = el(`<div class="tutorial-dots"></div>`);
  TUTORIAL_PAGES.forEach((_, i) => {
    const d = el(`<span class="tutorial-dot ${i === tutorialIndex ? 'on' : ''}"></span>`);
    d.onclick = () => { tutorialIndex = i; renderTutorialRoot(); };
    dots.appendChild(d);
  });

  const nav = el(`<div class="tutorial-nav"></div>`);
  const back = el(`<button class="btn-ghost">${escapeHtml(t('tutBack'))}</button>`);
  back.style.visibility = tutorialIndex === 0 ? 'hidden' : 'visible';
  back.onclick = () => { if (tutorialIndex > 0) { tutorialIndex--; renderTutorialRoot(); } };
  nav.appendChild(back);
  nav.appendChild(dots);
  const isLast = tutorialIndex === TUTORIAL_PAGES.length - 1;
  const next = el(`<button class="btn-gold">${escapeHtml(isLast ? t('tutPlay') : t('tutNext'))}</button>`);
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
  const fab = el(`<button class="emote-fab" aria-label="React" title="React">😀</button>`);
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
  if (onLanding || inLobby) { app.appendChild(helpFab()); app.appendChild(langFab()); }
  if (latestState && latestState.code) { app.appendChild(emoteFab()); app.appendChild(chatFab()); }
  else { document.getElementById('emote-picker')?.remove(); }  // clear a stale picker after leaving a game
  if (onLanding) startPublicRoomsPoll(); else stopPublicRoomsPoll();
  refreshFriendsPanel();

  // First-time players: auto-open the tutorial once on the landing screen.
  // First run: ask language before anything else, then the tutorial.
  if (onLanding && !loadLang() && !langAsked) {
    langAsked = true;
    showLanguageModal(true);
  } else if (onLanding && !autoTutorialDone) {
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
      <div class="tagline">${escapeHtml(t('tagline'))}</div>
    </div>
    ${(() => { const a = loadProfile(); return a && a.username
      ? `<button class="account-cta signed" id="account-cta">👤 ${escapeHtml(t('signedInAs'))} <strong>${escapeHtml(a.username)}</strong></button>`
      : `<button class="account-cta" id="account-cta"><span class="account-cta-main">👤 ${escapeHtml(t('authCta'))}</span><span class="account-cta-sub">${escapeHtml(t('authCtaSub'))}</span></button>`; })()}
    <div class="ranked-cta"><button class="btn-blue" id="ranked-btn">⚔️ ${escapeHtml(t('ranked1v1'))}</button>
      <button class="btn-ghost" id="invite-btn">🎁 ${escapeHtml(t('inviteFriends'))}</button></div>
    ${publicRooms.length ? `<div class="public-games">
      <div class="pg-head">🎲 ${escapeHtml(t('liveGames'))}</div>
      <div class="pg-list">${publicRooms.map((r) => `
        <div class="pg-row">
          <span class="pg-info">${escapeHtml(r.host)} · ${r.players}/${r.max}</span>
          <button class="btn-blue pg-join" data-code="${escapeHtml(r.code)}">${escapeHtml(t('joinBtn'))}</button>
        </div>`).join('')}</div>
    </div>` : ''}
    <div class="landing-cards">
      <div class="card-panel">
        <h2>${escapeHtml(t('createTitle'))}</h2>
        <div class="sub">${escapeHtml(t('createSub'))}</div>
        <div class="col">
          <input type="text" id="create-name" placeholder="${escapeHtml(t('yourName'))}" maxlength="20" autocomplete="off" />
          <button class="btn-gold" id="create-btn">${escapeHtml(t('createGame'))}</button>
        </div>
      </div>
      <div class="card-panel">
        <h2>${escapeHtml(t('joinTitle'))}</h2>
        <div class="sub">${escapeHtml(t('joinSub'))}</div>
        <div class="col">
          <input type="text" id="join-name" placeholder="${escapeHtml(t('yourName'))}" maxlength="20" autocomplete="off" />
          <input type="text" id="join-code" class="code-input" placeholder="${escapeHtml(t('codePlaceholder'))}" maxlength="4" autocomplete="off" />
          <button class="btn-blue" id="join-btn">${escapeHtml(t('joinGame'))}</button>
        </div>
      </div>
    </div>
    <div class="landing-footer"><a href="/rules.html">${escapeHtml(t('howToPlay'))}</a></div>
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
    if (!name) { showToast(t('enterName'), true); return; }
    saveLastName(name);
    sendMsg({ type: 'createRoom', name });
  };
  wrap.querySelector('#invite-btn').onclick = () => inviteFriends();
  wrap.querySelector('#account-cta').onclick = () => {
    const a = loadProfile();
    authTab = (a && a.username) ? 'login' : 'signup';
    friendsPanelOpen = true; leaderboardOpen = false; chatOpen = false;
    refreshFriendsPanel();
  };
  wrap.querySelector('#ranked-btn').onclick = () => {
    const p = loadProfile();
    if (!p || !p.username) {
      showToast(t('rankedNeedLogin'), true);
      friendsPanelOpen = true; leaderboardOpen = false; chatOpen = false; refreshFriendsPanel();
      return;
    }
    saveLastName(p.username);
    sendMsg({ type: 'createRoom', name: p.username, ranked: true });
  };
  wrap.querySelector('#join-btn').onclick = () => {
    const name = wrap.querySelector('#join-name').value.trim();
    const code = wrap.querySelector('#join-code').value.trim();
    if (!name) { showToast(t('enterName'), true); return; }
    if (!code) { showToast(t('enterCode'), true); return; }
    saveLastName(name);
    sendMsg({ type: 'joinRoom', name, code });
  };
  wrap.querySelectorAll('.pg-join').forEach((b) => {
    b.onclick = () => {
      const nameField = wrap.querySelector('#create-name');
      const p = loadProfile();
      const name = (nameField.value || '').trim() || (p && p.username) || loadLastName();
      if (!name) { showToast(t('enterName'), true); nameField.focus(); return; }
      saveLastName(name);
      sendMsg({ type: 'joinRoom', name, code: b.dataset.code });
    };
  });
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
    const lim = s.turnLimit ? t('turnLimitVal', { n: s.turnLimit }) : t('noTurnLimit');
    const summary = t('rulesSummary', { cards: s.cardsPer, win: s.bufferSeconds, matching: s.matching ? t('optOn') : t('optOff'), limit: lim });
    const powers = `${t('powerCards')}: ${s.powers === 'full' ? t('powFull') : t('powBasic')}`;
    return el(`<div class="settings-box"><div class="section-label" style="text-align:center;">${t('houseRules')}</div>
      <div class="help-text" style="text-align:center;">${escapeHtml(summary)} · ${escapeHtml(powers)}</div></div>`);
  }
  const box = el(`<div class="settings-box"><div class="section-label" style="text-align:center;">${t('houseRules')}</div></div>`);
  const set = (patch) => sendMsg({ type: 'setSettings', settings: patch });

  const group = (label, options, current, key) => {
    const row = el(`<div class="settings-row"><span class="settings-label">${escapeHtml(label)}</span><div class="seg"></div></div>`);
    const seg = row.querySelector('.seg');
    options.forEach(([val, text]) => {
      const b = el(`<button class="seg-btn ${current === val ? 'on' : ''}">${escapeHtml(text)}</button>`);
      b.onclick = () => set({ [key]: val });
      seg.appendChild(b);
    });
    return row;
  };

  const OFF = t('optOff'), ON = t('optOn');
  box.appendChild(group(t('cardsEach'), [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']], s.cardsPer, 'cardsPer'));
  box.appendChild(group(t('matchWindowLbl'), [[0, OFF], [1.5, '1.5s'], [2.5, '2.5s'], [4, '4s']], s.bufferSeconds, 'bufferSeconds'));
  box.appendChild(group(t('matchingLbl'), [[true, ON], [false, OFF]], s.matching, 'matching'));
  box.appendChild(group(t('turnLimitLbl'), [[0, OFF], [15, '15s'], [30, '30s'], [45, '45s']], s.turnLimit, 'turnLimit'));
  box.appendChild(group(t('powerCards'), [['basic', t('powBasic')], ['full', t('powFull')]], s.powers || 'basic', 'powers'));
  return box;
}

/* ---------- Lobby ---------- */

function renderLobby(state) {
  const isHost = state.hostId === state.youId;
  const ranked = !!state.ranked;
  const startHelp = ranked && state.players.length < 2
    ? escapeHtml(t('rankedWaitOpp'))
    : (state.players.length < 2 ? escapeHtml(t('needTwo')) : escapeHtml(t('readyPlayers', { n: state.players.length })));
  const wrap = el(`<div class="lobby-wrap">
    ${ranked ? `<div class="ranked-banner">⚔️ ${escapeHtml(t('rankedTag'))} · <span class="ranked-sub">${escapeHtml(t('rankedRules'))}</span></div>` : ''}
    <div class="room-code-box">
      <div class="label">${escapeHtml(t('roomShare'))}</div>
      <div class="code" id="room-code-text">${escapeHtml(state.code)}</div>
      <div class="copy-hint">${escapeHtml(t('tapCopy'))}</div>
      <button class="btn-ghost" id="copy-link-btn" style="margin-top:12px; padding:8px 16px; font-size:0.85rem;">🔗 ${escapeHtml(t('copyInvite'))}</button>
    </div>
    <div class="player-chip-list" id="player-chips"></div>
    ${isHost && !ranked ? `<div class="add-bot-box">
      <div class="section-label" style="text-align:center;">${escapeHtml(t('addBotTitle'))}</div>
      <div class="row center wrap" id="bot-buttons"></div>
    </div>` : ''}
    <div id="settings-box"></div>
    <div class="col" style="align-items:center;">
      ${isHost
        ? `<button class="btn-gold" id="start-btn" style="font-size:1.05rem; padding:14px 30px;" ${state.players.length < 2 ? 'disabled' : ''}>${t('startGame')}</button>
           <div class="help-text">${startHelp}</div>`
        : `<div class="help-text">${escapeHtml(t('waitingHost'))}</div>`}
      <div id="lobby-leave" style="margin-top:6px;"></div>
    </div>
  </div>`);
  wrap.querySelector('#lobby-leave').appendChild(leaveBtn(t('leaveRoom')));

  wrap.querySelector('#room-code-text').onclick = () => {
    navigator.clipboard?.writeText(state.code).then(() => showToast(t('roomCodeCopied')));
  };
  wrap.querySelector('#copy-link-btn').onclick = () => {
    const link = `${location.origin}/?join=${state.code}`;
    navigator.clipboard?.writeText(link).then(() => showToast(t('inviteLinkCopied')))
      .catch(() => showToast(link));
  };
  if (!ranked) wrap.querySelector('#settings-box').appendChild(renderSettings(state, isHost));

  const chipList = wrap.querySelector('#player-chips');
  state.players.forEach((p) => {
    const chip = el(`<div class="player-chip ${p.connected ? '' : 'offline'}"></div>`);
    chip.appendChild(avatarEl(p.id, state, 'sm'));
    const label = p.id === state.hostId ? `${p.name} (${t('hostTag')})` : p.name;
    chip.appendChild(document.createTextNode(label + (p.isYou ? ` (${t('youTag')})` : '')));
    if (p.isBot) chip.appendChild(el(`<span class="diff-badge ${p.difficulty}">${difficultyLabel(p.difficulty)}</span>`));
    if (isHost && p.isBot) {
      const rm = el(`<button class="btn-ghost" style="padding:2px 8px; margin-left:2px;" title="${escapeHtml(t('removeBot'))}">✕</button>`);
      rm.onclick = () => sendMsg({ type: 'removeBot', botId: p.id });
      chip.appendChild(rm);
    }
    chipList.appendChild(chip);
  });

  if (isHost) {
    const botRow = wrap.querySelector('#bot-buttons');
    if (botRow) {
      const full = state.players.length >= 8;
      [['easy', t('diffEasy')], ['medium', t('diffMedium')], ['hard', t('diffHard')], ['impossible', t('diffImpossible')]].forEach(([diff, label]) => {
        const b = el(`<button class="btn-ghost diff-btn ${diff}">+ ${escapeHtml(label)}</button>`);
        b.disabled = full;
        b.onclick = () => sendMsg({ type: 'addBot', difficulty: diff });
        botRow.appendChild(b);
      });
    }
    wrap.querySelector('#start-btn').onclick = () => sendMsg({ type: 'startGame' });
  }
  return wrap;
}

function difficultyLabel(diff) {
  return { easy: t('diffEasy'), medium: t('diffMed'), hard: t('diffHard'), impossible: t('diffImpossible') }[diff] || diff;
}

/* ---------- Choose peek count ---------- */

function renderChoosePeekCount(state) {
  const isChooser = state.peekChooserId === state.youId;
  const wrap = el(`<div class="lobby-wrap">
    <div class="card-panel" style="max-width:420px; text-align:center;">
      <h2>${isChooser ? escapeHtml(t('choosePeek')) : escapeHtml(t('isChoosing', { name: nameOf(state, state.peekChooserId) }))}</h2>
      <div class="sub">${escapeHtml(t('peekSub', { n: state.cardsPer || 4 }))}</div>
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
    row.appendChild(el(`<div class="help-text">${escapeHtml(t('hangTight'))}</div>`));
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
      <div class="room-tag" id="room-tag">${escapeHtml(t('roomTag', { code: state.code }))}</div>
    </div>
  </div>`);
  topBar.querySelector('#room-tag').onclick = () => {
    navigator.clipboard?.writeText(state.code).then(() => showToast(t('roomCodeCopied')));
  };
  topBar.querySelector('.row').appendChild(leaveBtn(t('leave')));
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
    if (p.left) tags.appendChild(el(`<span class="mini-tag offline">${escapeHtml(t('tagLeft'))}</span>`));
    else if (p.isBot) tags.appendChild(el(`<span class="mini-tag bot ${p.difficulty}">${difficultyLabel(p.difficulty)}</span>`));
    if (isActive) tags.appendChild(el(`<span class="mini-tag turn">${escapeHtml(t('tagTurn'))}</span>`));
    if (isDutch) tags.appendChild(el(`<span class="mini-tag dutch">DUTCH</span>`));
    if (!p.connected && !p.isBot) tags.appendChild(el(`<span class="mini-tag offline">${escapeHtml(t('tagOffline'))}</span>`));
    if (tags.children.length) card.appendChild(tags);

    const cardsRow = el(`<div class="row" style="gap:4px;"></div>`);
    for (let i = 0; i < p.gridSize; i++) {
      const wr = wrongReveal(p.id, i);
      const rc = swapReveal(p.id, i);
      let c;
      if (wr) { c = cardFront(wr, 'size-sm'); c.classList.add('just-wrong'); }
      else if (rc) { c = cardFront(rc, 'size-sm'); c.classList.add('just-swapped'); }
      else c = cardBack('size-sm', p.cardBack);
      const handler = cellClickHandler(state, p.id, i);
      if (handler) { c.classList.add('selectable'); c.onclick = handler; makeKeyActivatable(c, handler); }
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
      <div class="pile-label">${escapeHtml(t('drawLbl'))} (${state.drawCount})</div>
      <div id="draw-slot"></div>
    </div>
    <div class="pile">
      <div class="pile-label">${escapeHtml(t('discardLbl'))}</div>
      <div id="discard-slot"></div>
    </div>
  </div>`);
  const myBack = (state.players.find((p) => p.isYou) || {}).cardBack;
  table.querySelector('#draw-slot').appendChild(state.drawCount > 0 ? cardBack('size-md', myBack) : cardEmpty('size-md'));
  const discardCard = state.discardTop ? cardFront(state.discardTop, 'size-md') : cardEmpty('size-md');
  if (discardPulse) discardCard.classList.add('just-matched');
  table.querySelector('#discard-slot').appendChild(discardCard);
  wrap.appendChild(table);

  // Your hand
  const myPlayer = state.players.find((p) => p.isYou);
  const handWrap = el(`<div class="your-hand-wrap" data-pid="${me}"></div>`);
  let handLabel = t('yourHand');
  if (myPlayer && myPlayer.id === state.dutchCallerId) handLabel = t('yourHandDutch');
  handWrap.appendChild(el(`<div class="your-hand-label">${escapeHtml(handLabel)}</div>`));
  const handRow = el(`<div class="your-hand"></div>`);
  const myGridSize = myPlayer ? myPlayer.gridSize : 0;
  for (let i = 0; i < myGridSize; i++) {
    const wr = wrongReveal(me, i);
    const rc = swapReveal(me, i);
    let c;
    if (wr) { c = cardFront(wr, 'size-lg'); c.classList.add('just-wrong'); }
    else if (rc) { c = cardFront(rc, 'size-lg'); c.classList.add('just-swapped'); }
    else c = cardBack('size-lg', myPlayer && myPlayer.cardBack);
    const handler = cellClickHandler(state, me, i);
    if (handler) { c.classList.add('selectable'); c.onclick = handler; makeKeyActivatable(c, handler); }
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
    wrap.appendChild(el(`<div class="log-panel">${state.log.map(formatLog).join('<br/>')}</div>`));
  }

  return wrap;
}

function turnBannerInfo(state) {
  const me = state.youId;
  if (state.matcherId) {
    return state.matcherId === me
      ? { headline: t('matchingPick'), sub: t('playPaused'), mine: true }
      : { headline: t('xMatching', { name: nameOf(state, state.matcherId) }), sub: t('playPausedE'), mine: false };
  }
  if (state.phase === 'peeking') {
    const p = state.peekingPlayerId;
    if (p === me) {
      return { headline: t('yourTurnPeek'), sub: t('lookAtCards', { n: state.peekCount, done: state.peekedCells.length }), mine: true };
    }
    return { headline: t('xPeeking', { name: nameOf(state, p) }), sub: t('everyoneHang'), mine: false };
  }
  if (state.ending || state.turnMode === 'awaitingMatch') {
    return { headline: t('finalMatch'), sub: t('finalMatchSub'), mine: true };
  }
  const cur = state.currentPlayerId;
  // A power matched off-turn is resolved by the matcher, not the current player.
  const powerMode = ['jackSwap', 'queenPeek', 'aceGive', 'peekSelf', 'peekOther'].includes(state.turnMode);
  if (powerMode && state.powerActorId && state.powerActorId !== cur) {
    const pa = state.powerActorId;
    const paMine = pa === me;
    const promptKey = state.turnMode === 'jackSwap' ? (state.jackFirst ? 'jackSecondMsg' : 'jackFirstMsg')
      : state.turnMode === 'queenPeek' ? 'queenPickMsg'
      : state.turnMode === 'peekSelf' ? 'peekSelfMsg'
      : state.turnMode === 'peekOther' ? 'peekOtherMsg' : 'aceChooseMsg';
    return {
      headline: paMine ? t('powerYours') : t('powerOther', { name: nameOf(state, pa) }),
      sub: paMine ? t(promptKey) : '', mine: paMine,
    };
  }
  const mine = cur === me;
  let headline = mine ? t('yourTurn') : t('xTurn', { name: nameOf(state, cur) });
  const subParts = [];
  if (state.finalRound) subParts.push(t('finalRound', { name: nameOf(state, state.dutchCallerId), n: state.finalRoundRemaining }));
  if (state.turnMode === 'jackSwap') subParts.push(mine ? (state.jackFirst ? t('jackSecondMsg') : t('jackFirstMsg')) : t('jackResolving'));
  else if (state.turnMode === 'queenPeek') subParts.push(mine ? t('queenPickMsg') : t('queenResolving'));
  else if (state.turnMode === 'peekSelf') subParts.push(mine ? t('peekSelfMsg') : t('peekResolving'));
  else if (state.turnMode === 'peekOther') subParts.push(mine ? t('peekOtherMsg') : t('peekResolving'));
  else if (state.turnMode === 'aceGive') subParts.push(mine ? t('aceChooseMsg') : t('aceResolving'));
  else if (state.turnMode === 'endOfTurn') subParts.push(mine ? t('endOrDutch') : t('xFinishing', { name: nameOf(state, cur) }));
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
  // For a pending power, the actor is the matcher (maybe off-turn); otherwise the current player.
  const powerMode = ['jackSwap', 'queenPeek', 'aceGive', 'peekSelf', 'peekOther'].includes(state.turnMode);
  const actingPlayer = powerMode && state.powerActorId ? state.powerActorId : state.currentPlayerId;
  if (actingPlayer !== me) return null;
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
  if (state.turnMode === 'peekSelf') {          // 7/8 — only your own cards
    if (playerId !== me) return null;
    return () => sendMsg({ type: 'peekSelfSelect', cellIndex });
  }
  if (state.turnMode === 'peekOther') {         // 9/10 — only opponents' cards
    if (playerId === me) return null;
    return () => sendMsg({ type: 'peekOtherSelect', targetPlayerId: playerId, targetCellIndex: cellIndex });
  }
  return null;
}

function renderActionBar(state) {
  const me = state.youId;
  const bar = el(`<div class="action-bar"></div>`);

  if (state.phase === 'peeking') {
    if (state.peekingPlayerId !== me) {
      bar.appendChild(el(`<span class="help-text">${escapeHtml(t('waitingForX', { name: nameOf(state, state.peekingPlayerId) }))}</span>`));
      return bar;
    }
    const doneBtn = el(`<button class="btn-gold">${escapeHtml(t('donePeeking'))}</button>`);
    doneBtn.disabled = state.peekedCells.length < state.peekCount;
    doneBtn.onclick = () => sendMsg({ type: 'donePeeking' });
    bar.appendChild(doneBtn);
    return bar;
  }

  // I'm the one matching — pick a card (play is paused for everyone).
  if (state.matcherId === me) {
    const secs = Math.ceil(matchPauseRemainingMs() / 1000);
    bar.appendChild(el(`<span class="help-text">${escapeHtml(t('matchPrompt', { card: cardLabel(state.discardTop) }))}${secs ? ` (<span id="match-count">${secs}</span>s)` : ''}</span>`));
    const cancel = el(`<button class="btn-ghost">${escapeHtml(t('cancel'))}</button>`);
    cancel.onclick = () => sendMsg({ type: 'cancelMatch' });
    bar.appendChild(cancel);
    return bar;
  }

  // Someone else is matching — everyone waits.
  if (state.matcherId) {
    const secs = Math.ceil(matchPauseRemainingMs() / 1000);
    bar.appendChild(el(`<span class="help-text">${escapeHtml(t('xMatchingPaused', { name: nameOf(state, state.matcherId) }))}${secs ? ` (<span id="match-count">${secs}</span>s)` : ''}…</span>`));
    return bar;
  }

  const canMatch = state.matchingEnabled && state.phase === 'playing' && state.discardTop
    && (state.turnMode === 'awaitingAction' || state.turnMode === 'endOfTurn' || state.turnMode === 'awaitingMatch');

  function matchButton() {
    const b = el(`<button class="btn-match">${t('match')}</button>`);
    b.onclick = () => { swapArmed = false; sendMsg({ type: 'claimMatch' }); };
    return b;
  }

  // End-of-round grace: everyone gets a last window to match before the reveal.
  if (state.ending || state.turnMode === 'awaitingMatch') {
    bar.appendChild(el(`<span class="help-text" style="width:100%; text-align:center;">${escapeHtml(t('finalMatchSub'))}</span>`));
    if (canMatch) bar.appendChild(matchButton());
    return bar;
  }

  // A matched power is resolved by its (possibly off-turn) actor; otherwise the current player acts.
  const powerMode = ['jackSwap', 'queenPeek', 'aceGive', 'peekSelf', 'peekOther'].includes(state.turnMode);
  const actingPlayer = powerMode && state.powerActorId ? state.powerActorId : state.currentPlayerId;
  if (actingPlayer !== me) {
    bar.appendChild(el(`<span class="help-text">${escapeHtml(t('waitingForX', { name: nameOf(state, actingPlayer) }))}</span>`));
    if (canMatch) bar.appendChild(matchButton());
    return bar;
  }

  if (state.turnMode === 'awaitingAction') {
    if (swapArmed) {
      const cancel = el(`<button class="btn-ghost">${escapeHtml(t('cancel'))}</button>`);
      cancel.onclick = () => { swapArmed = false; render(); };
      bar.appendChild(el(`<span class="help-text">${escapeHtml(t('clickOwnCard'))}</span>`));
      bar.appendChild(cancel);
      return bar;
    }
    const remaining = bufferRemainingMs();
    const flip = el(`<button class="btn-blue">${t('flip')}</button>`);
    flip.disabled = remaining > 0 || (state.drawCount === 0 && !state.discardTop);
    flip.onclick = () => sendMsg({ type: 'flip' });
    const swap = el(`<button class="btn-blue">${t('swap')}</button>`);
    swap.disabled = remaining > 0 || !state.discardTop;
    swap.onclick = () => { swapArmed = true; render(); };
    bar.appendChild(flip); bar.appendChild(swap);
    if (canMatch) bar.appendChild(matchButton());
    if (remaining > 0) {
      const txt = t('youCanAct', { n: `<span id="buffer-count">${Math.ceil(remaining / 1000)}</span>` });
      bar.appendChild(el(`<span class="help-text" style="width:100%; text-align:center;">${txt}</span>`));
    }
    return bar;
  }

  if (state.turnMode === 'endOfTurn') {
    const endBtn = el(`<button class="btn-gold">${t('endTurn')}</button>`);
    endBtn.onclick = () => sendMsg({ type: 'endTurn' });
    const dutch = el(`<button class="btn-red">${t('callDutch')}</button>`);
    dutch.onclick = () => sendMsg({ type: 'callDutch' });
    bar.appendChild(endBtn); bar.appendChild(dutch);
    if (canMatch) bar.appendChild(matchButton());
    return bar;
  }

  if (state.turnMode === 'jackSwap') {
    bar.appendChild(el(`<span class="help-text">${escapeHtml(state.jackFirst ? t('jackClickSecond') : t('jackClickAny'))}</span>`));
    return bar;
  }
  if (state.turnMode === 'queenPeek') {
    bar.appendChild(el(`<span class="help-text">${escapeHtml(t('queenClickAny'))}</span>`));
    return bar;
  }
  if (state.turnMode === 'peekSelf') {
    bar.appendChild(el(`<span class="help-text">${escapeHtml(t('peekSelfMsg'))}</span>`));
    return bar;
  }
  if (state.turnMode === 'peekOther') {
    bar.appendChild(el(`<span class="help-text">${escapeHtml(t('peekOtherMsg'))}</span>`));
    return bar;
  }
  if (state.turnMode === 'aceGive') {
    state.players.forEach((p) => {
      const b = el(`<button class="btn-blue">${escapeHtml(p.name)}${p.isYou ? ` (${t('youTag')})` : ''}</button>`);
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

  const ru = state.ranked && lastRankedUpdate ? lastRankedUpdate : null;
  const ruSign = ru && ru.delta > 0 ? '+' : '';
  const wrap = el(`<div class="reveal-wrap">
    <div class="brand" style="margin-bottom:18px;">
      <h1 style="font-size:2rem;">${escapeHtml(t('roundOver'))}</h1>
      <div class="tagline">${escapeHtml(t('allRevealed'))}</div>
    </div>
    ${ru ? `<div class="rating-change ${ru.delta >= 0 ? 'up' : 'down'}">
      <span class="rating-delta">${ruSign}${ru.delta}</span>
      <span class="rating-new">${escapeHtml(t('ratingCol'))} ${ru.rating}</span>
    </div>` : ''}
    <div id="reveal-rows"></div>
    <div id="series-standings"></div>
    <div class="row center" style="margin-top:20px;">
      ${isHost
        ? `<button class="btn-gold" id="play-again-btn" style="font-size:1.05rem; padding:14px 30px;">${t('playAgain')}</button>
           ${(state.roundsPlayed > 1 && !state.ranked) ? `<button class="btn-ghost" id="new-match-btn" style="padding:14px 22px;">${escapeHtml(t('newMatch'))}</button>` : ''}`
        : `<span class="help-text">${escapeHtml(t('waitingNewRound'))}</span>`}
    </div>
    <div class="row center" style="margin-top:12px;" id="reveal-leave"></div>
  </div>`);
  wrap.querySelector('#reveal-leave').appendChild(leaveBtn(t('leaveRoom')));

  // Cumulative match standings once more than one round has been played.
  const series = (state.series || []).slice().sort((a, b) => a.total - b.total);
  if (state.roundsPlayed > 1 && series.length) {
    const lead = series[0].total;
    const box = el(`<div class="series-box"><div class="section-label" style="text-align:center;">${escapeHtml(t('matchStandings', { n: state.roundsPlayed }))}</div></div>`);
    series.forEach((s, i) => {
      const row = el(`<div class="series-row ${s.total === lead ? 'leader' : ''}">
        <span class="series-rank">${i + 1}</span>
        <span class="grow">${escapeHtml(s.name)}${s.id === state.youId ? ` (${t('youTag')})` : ''}</span>
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
    if (isWinner) nameDiv.appendChild(el(`<span class="badge-winner">🏆 ${escapeHtml(t('winner'))}</span>`));
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
    row.appendChild(el(`<div class="rtotal">${r.total} ${escapeHtml(t('ptsUnit'))}</div>`));
    rows.appendChild(row);
  });

  if (isHost) {
    wrap.querySelector('#play-again-btn').onclick = () => sendMsg({ type: 'playAgain' });
    const nm = wrap.querySelector('#new-match-btn');
    if (nm) nm.onclick = () => sendMsg({ type: 'playAgain', reset: true });
  }
  return wrap;
}

/* ---------- Init ---------- */

connect();
render();
