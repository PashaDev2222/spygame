const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const path = require('path');

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
wss.on('close', () => clearInterval(pingInterval));

// Словари по темам
const WORD_CATEGORIES = {
  'Все темы': [],
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
// Собираем "Все темы"
WORD_CATEGORIES['Все темы'] = Object.values(WORD_CATEGORIES).flat();

const AVATARS = ['🕵️','👤','🦝','🐺','🦊','🐭','🦁','🐯','👁','🎭','🃏','💀','🌙','⚡','🔥','🌊'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function genCode() {
  let code;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); } while (lobbies.has(code));
  return code;
}

function getWordsForCategory(cat) {
  if (!cat || cat === 'Все темы') return WORD_CATEGORIES['Все темы'];
  return WORD_CATEGORIES[cat] || WORD_CATEGORIES['Все темы'];
}

const lobbies = new Map();
const wsToPlayer = new Map();

function createLobby(code, hostId, maxSlots, spyCount, category) {
  return { 
    code, hostId, maxSlots, spyCount: spyCount || 1, category: category || 'Все темы',
    phase: 'lobby', players: [], spyIds: [], word: '',
    round: 1, turnIdx: 0, roundTurnsDone: 0, revealIdx: 0, votes: {},
    timerEnd: null, timerTimeout: null, chat: [],
    sessionStats: new Map(), // playerId -> {wins, spyWins, totalGames}
    preStartCountdown: null
  };
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
  const stats = lobby.sessionStats.get(player.id) || { wins: 0, spyWins: 0, totalGames: 0 };
  return {
    code: lobby.code, phase: lobby.phase, hostId: lobby.hostId, maxSlots: lobby.maxSlots,
    spyCount: lobby.spyCount, category: lobby.category,
    myId: player.id,
    spyIds: isResult ? lobby.spyIds : null,
    word: isResult ? lobby.word : (lobby.spyIds.includes(player.id) ? null : lobby.word),
    isSpy: lobby.spyIds.includes(player.id),
    players: lobby.players.map(p => ({ id: p.id, nick: p.nick, avatar: p.avatar, photoUrl: p.photoUrl || null, eliminated: p.eliminated })),
    round: lobby.round, turnIdx: lobby.turnIdx, roundTurnsDone: lobby.roundTurnsDone,
    revealIdx: lobby.revealIdx,
    votes: lobby.phase === 'vote' ? lobby.votes : {},
    timerEnd: lobby.timerEnd,
    chat: lobby.chat,
    sessionStats: stats,
    preStartCountdown: lobby.preStartCountdown
  };
}

function activePlayers(lobby) { return lobby.players.filter(p => !p.eliminated); }
function clearTimer(lobby) {
  if (lobby.timerTimeout) { clearTimeout(lobby.timerTimeout); lobby.timerTimeout = null; }
  lobby.timerEnd = null;
}
function clearCountdown(lobby) {
  if (lobby.preStartCountdown) { clearInterval(lobby.preStartCountdown); lobby.preStartCountdown = null; }
}

function startPreGameCountdown(lobby) {
  clearCountdown(lobby);
  let count = 3;
  broadcastAll(lobby, { type: 'chat', from: 'system', text: `Игра начнётся через ${count}...` });
  lobby.preStartCountdown = setInterval(() => {
    count--;
    if (count > 0) {
      broadcastAll(lobby, { type: 'chat', from: 'system', text: `${count}...` });
    } else {
      clearCountdown(lobby);
      broadcastAll(lobby, { type: 'chat', from: 'system', text: '🔫 НАЧАЛИ!' });
      startGame(lobby);
    }
  }, 1000);
}

function startGame(lobby) {
  clearTimer(lobby);
  // Выбираем шпионов
  const shuffled = [...lobby.players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  lobby.spyIds = shuffled.slice(0, Math.min(lobby.spyCount, lobby.players.length - 1)).map(p => p.id);
  if (lobby.spyIds.length === 0 && lobby.players.length > 0) lobby.spyIds = [lobby.players[0].id];
  
  const wordsPool = getWordsForCategory(lobby.category);
  lobby.word = rand(wordsPool);
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
  const isSpy = eliminatedId && lobby.spyIds.includes(eliminatedId);
  broadcastAll(lobby, { type: 'vote_result', eliminatedId, eliminatedNick: eliminated?.nick, isSpy, word: isSpy ? lobby.word : null });
  
  if (isSpy) {
    // Убираем шпиона из списка
    lobby.spyIds = lobby.spyIds.filter(id => id !== eliminatedId);
    if (lobby.spyIds.length === 0) {
      // Все шпионы пойманы — победа мирных
      endGame(lobby, true);
    } else {
      if (eliminated) eliminated.eliminated = true;
      const remaining = activePlayers(lobby);
      if (remaining.length <= lobby.spyIds.length + 1) {
        endGame(lobby, false);
      } else {
        lobby.round++;
        setTimeout(() => startRound(lobby), 3000);
      }
    }
  } else {
    if (eliminated) eliminated.eliminated = true;
    const remaining = activePlayers(lobby);
    if (remaining.length <= lobby.spyIds.length + 1) {
      endGame(lobby, false);
    } else {
      lobby.round++;
      setTimeout(() => startRound(lobby), 3000);
    }
  }
}

function spyGuessWord(lobby, playerId, guessedWord) {
  if (lobby.phase !== 'result') return false;
  const isSpy = lobby.spyIds.includes(playerId);
  if (!isSpy) return false;
  const normalizedGuess = guessedWord.toLowerCase().trim();
  const normalizedWord = lobby.word.toLowerCase();
  if (normalizedGuess === normalizedWord) {
    // Шпион угадал слово — побеждает
    endGame(lobby, false, true);
    return true;
  }
  return false;
}

function endGame(lobby, civilianWin, spyGuessed = false) {
  lobby.phase = 'result';
  // Обновляем статистику
  const winners = spyGuessed ? lobby.spyIds : (civilianWin ? lobby.players.filter(p => !lobby.spyIds.includes(p.id)).map(p => p.id) : lobby.spyIds);
  lobby.players.forEach(p => {
    let stats = lobby.sessionStats.get(p.id) || { wins: 0, spyWins: 0, totalGames: 0 };
    stats.totalGames++;
    if (winners.includes(p.id)) {
      if (lobby.spyIds.includes(p.id)) stats.spyWins++;
      else stats.wins++;
    }
    lobby.sessionStats.set(p.id, stats);
  });
  broadcastState(lobby);
  broadcastAll(lobby, { type: 'game_over', civilianWin, spyGuessed, spyIds: lobby.spyIds, word: lobby.word });
}

function resetLobby(lobby) {
  clearTimer(lobby);
  clearCountdown(lobby);
  lobby.phase = 'lobby'; lobby.spyIds = []; lobby.word = '';
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
  lobby.sessionStats.delete(playerId);
  if (lobby.players.length === 0) { clearTimer(lobby); clearCountdown(lobby); lobbies.delete(code); return; }
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
      const maxSlots = Math.min(16, Math.max(4, parseInt(msg.maxSlots) || 8));
      const spyCount = Math.min(3, Math.max(1, parseInt(msg.spyCount) || 1));
      const category = msg.category || 'Все темы';
      const lobby = createLobby(code, playerId, maxSlots, spyCount, category);
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
      if (!lobby.sessionStats.has(playerId)) lobby.sessionStats.set(playerId, { wins: 0, spyWins: 0, totalGames: 0 });
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
      if (lobby.spyCount >= lobby.players.length) { send(ws, { type: 'error', text: 'Слишком много шпионов!' }); return; }
      startPreGameCountdown(lobby);
    } else if (type === 'update_slots') {
      if (!isHost || lobby.phase !== 'lobby') return;
      lobby.maxSlots = Math.min(16, Math.max(lobby.players.length, Math.max(4, parseInt(msg.maxSlots) || 8)));
      broadcastState(lobby);
    } else if (type === 'update_spy_count') {
      if (!isHost || lobby.phase !== 'lobby') return;
      lobby.spyCount = Math.min(3, Math.max(1, parseInt(msg.spyCount) || 1));
      broadcastState(lobby);
    } else if (type === 'update_category') {
      if (!isHost || lobby.phase !== 'lobby') return;
      if (WORD_CATEGORIES[msg.category]) lobby.category = msg.category;
      broadcastState(lobby);
    } else if (type === 'kick_player') {
      if (!isHost || lobby.phase !== 'lobby') return;
      const targetId = parseInt(msg.targetId);
      if (targetId === playerId) return;
      const target = lobby.players.find(p => p.id === targetId);
      if (target) {
        if (target.ws.readyState === 1) send(target.ws, { type: 'kicked', reason: 'Хост кикнул вас' });
        target.ws.close();
        handleDisconnect(target.ws);
      }
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
    } else if (type === 'spy_guess') {
      const guessedWord = (msg.word || '').toString().trim();
      if (!guessedWord) return;
      spyGuessWord(lobby, playerId, guessedWord);
    } else if (type === 'set_avatar') {
      if (lobby.phase !== 'lobby') return;
      const photoUrl = (msg.photoUrl || '').toString();
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
