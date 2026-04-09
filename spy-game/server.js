const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const path = require('path');

const app = express();
const server = createServer(app);

// Явный путь /ws — обязателен для Railway, Render и большинства хостингов
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// Keepalive ping каждые 25 сек — без этого хостинги рвут соединение через 30-60 сек
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
wss.on('close', () => clearInterval(pingInterval));

const WORD_CATEGORIES = {
  'Русские стримеры': ['мармок','эдисон','брейнмапс','литвин','егорик','вилсаком','фрост','адамтомасморан','куплинов','винди31','фиксай','глент','познаватель','ледидиана','ванзай','холдик','алексбойко','домер','тимончавес','амелка','птушкин','ивангай','иеногай','румфактори','хаймен','софиядельмонстро','карина','стрей228','братишкинофф','эвелон','т2х2','стинтик','артас','джесус','шадоукекв','рофланебало','лагода','блэкафа','денисстример'],
  'Зарубежные стримеры': ['мистербист','айшовспид','кси','логанпол','кейсо','покимейн','ниндзя','икскьюси','адинросс','кайсенат','дрим','техноблейд','маркплаер','пьюдипай','ссснайпервульф','асмонголд'],
  'Персонажи': ['гумбол','бентен','спайдермен','бетмен','айронмен','халк','тор','локи','веном','дэдпул','шрек','спанчбоб','патрик','скубиду','том','джерри','миккимаус'],
  'Политики': ['путин','зеленский','байден','трамп'],
  'Рэперы': ['моргенштерн','скриптонит','фараон','фейс','элджей','кизару'],
  'Аниме': ['наруто','саске','гоку','вегета','луффи','зоро','эрен','леви','лайт','ягами'],
  'ФНАФ': ['freddyfazbear','chica','bonnie','foxy'],
  'Майнкрафт': ['minecraft','steve','alex','herobrine'],
  'Соцсети': ['tiktok','instagram','youtube','twitch'],
  'Игры': ['roblox','fortnite','csgo','dota2','valorant'],
  'Шпионаж': ['ghost','spy','agent','detective','mafia','killer']
};
const ALL_WORDS = Object.values(WORD_CATEGORIES).flat();
const AVATARS = ['🕵️','👤','🦝','🐺','🦊','🐭','🦁','🐯','👁','🎭','🃏','💀','🌙','⚡','🔥','🌊'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function genCode() {
  let code;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); } while (lobbies.has(code));
  return code;
}

const lobbies = new Map();
const wsToPlayer = new Map();

function createLobby(code, hostId, maxSlots) {
  return { code, hostId, maxSlots, phase: 'lobby', players: [], spyId: null, word: '',
    round: 1, turnIdx: 0, roundTurnsDone: 0, revealIdx: 0, votes: {},
    timerEnd: null, timerTimeout: null, chat: [] };
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcastAll(lobby, msg) {
  const str = JSON.stringify(msg);
  lobby.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(str); });
}
function broadcastState(lobby) {
  lobby.players.forEach(p => send(p.ws, { type: 'state', state: buildStateFor(lobby, p) }));
}
function buildStateFor(lobby, player) {
  const isResult = lobby.phase === 'result';
  return {
    code: lobby.code, phase: lobby.phase, hostId: lobby.hostId, maxSlots: lobby.maxSlots,
    myId: player.id,
    spyId: isResult ? lobby.spyId : null,
    word: isResult ? lobby.word : (player.id === lobby.spyId ? null : lobby.word),
    isSpy: player.id === lobby.spyId,
    players: lobby.players.map(p => ({ id: p.id, nick: p.nick, avatar: p.avatar, photoUrl: p.photoUrl || null, eliminated: p.eliminated })),
    round: lobby.round, turnIdx: lobby.turnIdx, roundTurnsDone: lobby.roundTurnsDone,
    revealIdx: lobby.revealIdx,
    votes: lobby.phase === 'vote' ? lobby.votes : {},
    timerEnd: lobby.timerEnd,
    chat: lobby.chat
  };
}

function activePlayers(lobby) { return lobby.players.filter(p => !p.eliminated); }
function clearTimer(lobby) {
  if (lobby.timerTimeout) { clearTimeout(lobby.timerTimeout); lobby.timerTimeout = null; }
  lobby.timerEnd = null;
}

function startGame(lobby) {
  clearTimer(lobby);
  lobby.spyId = lobby.players[Math.floor(Math.random() * lobby.players.length)].id;
  lobby.word = rand(ALL_WORDS);
  lobby.phase = 'reveal'; lobby.revealIdx = 0; lobby.round = 1;
  lobby.turnIdx = 0; lobby.roundTurnsDone = 0; lobby.votes = {};
  lobby.players.forEach(p => { p.eliminated = false; });
  broadcastState(lobby);
}

function advanceReveal(lobby) {
  lobby.revealIdx++;
  if (lobby.revealIdx >= lobby.players.length) startRound(lobby);
  else broadcastState(lobby);
}

function startRound(lobby) {
  lobby.phase = 'game'; lobby.turnIdx = 0; lobby.roundTurnsDone = 0;
  broadcastAll(lobby, { type: 'chat', from: 'system', text: `🔫 Раунд ${lobby.round} начался!` });
  startTurnTimer(lobby);
}

function startTurnTimer(lobby) {
  clearTimer(lobby);
  lobby.timerEnd = Date.now() + 30000;
  broadcastState(lobby);
  lobby.timerTimeout = setTimeout(() => endTurn(lobby), 30000);
}

function endTurn(lobby) {
  clearTimer(lobby);
  const active = activePlayers(lobby);
  lobby.turnIdx++;
  if (lobby.turnIdx >= active.length) {
    lobby.turnIdx = 0; lobby.roundTurnsDone++;
    if (lobby.roundTurnsDone >= 2) { startVoting(lobby); return; }
  }
  startTurnTimer(lobby);
}

function startVoting(lobby) {
  clearTimer(lobby);
  lobby.phase = 'vote'; lobby.votes = {};
  lobby.timerEnd = Date.now() + 60000;
  broadcastState(lobby);
  broadcastAll(lobby, { type: 'chat', from: 'system', text: '⚡ ГОЛОСОВАНИЕ! Кто шпион?' });
  lobby.timerTimeout = setTimeout(() => resolveVote(lobby), 60000);
}

function resolveVote(lobby) {
  clearTimer(lobby);
  const counts = {};
  Object.values(lobby.votes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  let maxVotes = 0, eliminatedId = null;
  Object.entries(counts).forEach(([id, c]) => { if (c > maxVotes) { maxVotes = c; eliminatedId = parseInt(id); } });
  const eliminated = lobby.players.find(p => p.id === eliminatedId);
  const isSpy = eliminatedId === lobby.spyId;
  broadcastAll(lobby, { type: 'vote_result', eliminatedId, eliminatedNick: eliminated?.nick, isSpy, word: isSpy ? lobby.word : null });
  if (isSpy) {
    setTimeout(() => endGame(lobby, true), 3000);
  } else {
    if (eliminated) eliminated.eliminated = true;
    const remaining = activePlayers(lobby);
    if (remaining.length <= 2) setTimeout(() => endGame(lobby, false), 3000);
    else { lobby.round++; setTimeout(() => startRound(lobby), 3000); }
  }
}

function endGame(lobby, civilianWin) {
  lobby.phase = 'result';
  broadcastState(lobby);
  broadcastAll(lobby, { type: 'game_over', civilianWin, spyId: lobby.spyId, word: lobby.word });
}

function resetLobby(lobby) {
  clearTimer(lobby);
  lobby.phase = 'lobby'; lobby.spyId = null; lobby.word = '';
  lobby.round = 1; lobby.turnIdx = 0; lobby.roundTurnsDone = 0;
  lobby.revealIdx = 0; lobby.votes = {};
  lobby.players.forEach(p => { p.eliminated = false; });
  broadcastState(lobby);
}

function handleDisconnect(ws) {
  const meta = wsToPlayer.get(ws);
  if (!meta) return;
  wsToPlayer.delete(ws);
  const { code, playerId } = meta;
  const lobby = lobbies.get(code);
  if (!lobby) return;
  const nick = lobby.players.find(p => p.id === playerId)?.nick || 'Игрок';
  lobby.players = lobby.players.filter(p => p.id !== playerId);
  if (lobby.players.length === 0) { clearTimer(lobby); lobbies.delete(code); return; }
  if (playerId === lobby.hostId) {
    lobby.hostId = lobby.players[0].id;
    broadcastAll(lobby, { type: 'chat', from: 'system', text: `${lobby.players[0].nick} стал хостом` });
  }
  broadcastAll(lobby, { type: 'chat', from: 'system', text: `${nick} покинул лобби` });
  if (lobby.phase === 'game' || lobby.phase === 'vote') {
    const active = activePlayers(lobby);
    if (active.length < 2) { endGame(lobby, false); return; }
    if (lobby.turnIdx >= active.length) lobby.turnIdx = 0;
  }
  broadcastState(lobby);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type } = msg;

    if (type === 'create_lobby') {
      const nick = (msg.nick || '').toString().trim().slice(0, 20);
      if (!nick) return;
      const code = genCode();
      const playerId = Date.now() % 999998 + 2;
      const lobby = createLobby(code, playerId, Math.min(16, Math.max(4, parseInt(msg.maxSlots) || 8)));
      lobby.players.push({ id: playerId, nick, avatar: rand(AVATARS), eliminated: false, ws });
      lobbies.set(code, lobby);
      wsToPlayer.set(ws, { code, playerId });
      send(ws, { type: 'created', code });
      broadcastState(lobby);
      console.log(`[+] Лобби ${code} создано (${nick})`);
      return;
    }

    if (type === 'join_lobby') {
      const nick = (msg.nick || '').toString().trim().slice(0, 20);
      const code = (msg.code || '').toString().trim();
      if (!nick || !code) return;
      const lobby = lobbies.get(code);
      if (!lobby) { send(ws, { type: 'error', text: 'Лобби не найдено. Проверь код.' }); return; }
      if (lobby.phase !== 'lobby') { send(ws, { type: 'error', text: 'Игра уже началась.' }); return; }
      if (lobby.players.length >= lobby.maxSlots) { send(ws, { type: 'error', text: 'Лобби заполнено.' }); return; }
      const playerId = Date.now() % 999998 + Math.floor(Math.random() * 9999) + 2;
      lobby.players.push({ id: playerId, nick, avatar: AVATARS[lobby.players.length % AVATARS.length], eliminated: false, ws });
      wsToPlayer.set(ws, { code, playerId });
      broadcastAll(lobby, { type: 'chat', from: 'system', text: `${nick} вошёл в лобби` });
      broadcastState(lobby);
      console.log(`[+] ${nick} вошёл в ${code}`);
      return;
    }

    const meta = wsToPlayer.get(ws);
    if (!meta) return;
    const { code, playerId } = meta;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === playerId);
    if (!player) return;
    const isHost = playerId === lobby.hostId;

    if (type === 'start_game') {
      if (!isHost || lobby.phase !== 'lobby') return;
      if (lobby.players.length < 4) { send(ws, { type: 'error', text: 'Минимум 4 игрока!' }); return; }
      startGame(lobby);
    } else if (type === 'update_slots') {
      if (!isHost || lobby.phase !== 'lobby') return;
      lobby.maxSlots = Math.min(16, Math.max(lobby.players.length, Math.max(4, parseInt(msg.maxSlots) || 8)));
      broadcastState(lobby);
    } else if (type === 'confirm_role') {
      if (lobby.phase !== 'reveal' || lobby.players[lobby.revealIdx]?.id !== playerId) return;
      advanceReveal(lobby);
    } else if (type === 'end_turn') {
      if (lobby.phase !== 'game') return;
      if (activePlayers(lobby)[lobby.turnIdx]?.id !== playerId) return;
      endTurn(lobby);
    } else if (type === 'vote') {
      if (lobby.phase !== 'vote' || lobby.votes[playerId] !== undefined) return;
      const targetId = parseInt(msg.targetId);
      if (targetId === playerId || !lobby.players.find(p => p.id === targetId && !p.eliminated)) return;
      lobby.votes[playerId] = targetId;
      broadcastState(lobby);
      const active = activePlayers(lobby);
      if (active.filter(p => lobby.votes[p.id] !== undefined).length >= active.length) {
        clearTimer(lobby); resolveVote(lobby);
      }
    } else if (type === 'set_avatar') {
      if (lobby.phase !== 'lobby') return;
      const photoUrl = (msg.photoUrl || '').toString();
      // max ~200KB base64
      if (photoUrl.length > 280000) { send(ws, { type: 'error', text: 'Фото слишком большое! Макс 200KB.' }); return; }
      if (photoUrl && !photoUrl.startsWith('data:image/')) { return; }
      player.photoUrl = photoUrl || null;
      broadcastState(lobby);
    } else if (type === 'chat') {
      const text = (msg.text || '').toString().trim().slice(0, 120);
      if (!text) return;
      const chatMsg = { from: 'player', playerId, nick: player.nick, avatar: player.avatar, text };
      lobby.chat.push(chatMsg);
      if (lobby.chat.length > 200) lobby.chat.shift();
      broadcastAll(lobby, { type: 'chat', ...chatMsg });
    } else if (type === 'restart') {
      if (isHost) resetLobby(lobby);
    } else if (type === 'leave') {
      handleDisconnect(ws);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🕵️  Spy Game server: http://0.0.0.0:${PORT}`);
});
