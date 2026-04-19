/**
 * Discord Clone - Main Server
 * Node.js + Express + WebSocket + SQLite
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище активных WebSocket соединений: userId -> ws
const clients = new Map();

// ─────────────────────────────────────────────
// WebSocket логика
// ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  let currentUserId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // Аутентификация по WS (после логина получаем userId+token)
      case 'auth': {
        const user = db.getUserById(msg.userId);
        if (user && user.token === msg.token) {
          currentUserId = user.id;
          clients.set(currentUserId, ws);
          db.setUserOnline(currentUserId, 1);
          broadcastUserStatus(currentUserId, true);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
        }
        break;
      }

      // Сообщение в канал сервера
      case 'channel_message': {
        if (!currentUserId) break;
        const { channelId, content } = msg;
        if (!content || !content.trim()) break;
        const message = db.createChannelMessage(currentUserId, channelId, content.trim());
        const fullMsg = db.getMessageById(message.id);
        broadcastToChannel(channelId, { type: 'channel_message', message: fullMsg });
        break;
      }

      // Личное сообщение
      case 'dm_message': {
        if (!currentUserId) break;
        const { toUserId, content } = msg;
        if (!content || !content.trim()) break;
        const message = db.createDM(currentUserId, toUserId, content.trim());
        const fullMsg = db.getDMById(message.id);
        // Отправить обоим участникам
        sendToUser(currentUserId, { type: 'dm_message', message: fullMsg });
        sendToUser(toUserId, { type: 'dm_message', message: fullMsg });
        break;
      }

      // Печатает...
      case 'typing': {
        if (!currentUserId) break;
        const user = db.getUserById(currentUserId);
        if (msg.channelId) {
          broadcastToChannel(msg.channelId, {
            type: 'typing', channelId: msg.channelId,
            userId: currentUserId, username: user.username
          }, currentUserId);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentUserId) {
      clients.delete(currentUserId);
      db.setUserOnline(currentUserId, 0);
      broadcastUserStatus(currentUserId, false);
    }
  });
});

// Отправить сообщение конкретному пользователю
function sendToUser(userId, data) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Рассылка всем участникам канала
function broadcastToChannel(channelId, data, excludeUserId = null) {
  const members = db.getChannelMembers(channelId);
  members.forEach(m => {
    if (m.userId !== excludeUserId) {
      sendToUser(m.userId, data);
    }
  });
}

// Рассылка статуса онлайн/оффлайн
function broadcastUserStatus(userId, isOnline) {
  const data = JSON.stringify({ type: 'user_status', userId, isOnline });
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

// ─────────────────────────────────────────────
// REST API — Авторизация
// ─────────────────────────────────────────────

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (username.length < 3) return res.status(400).json({ error: 'Имя минимум 3 символа' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (!/^[a-zA-Z0-9_а-яА-Я]+$/.test(username)) return res.status(400).json({ error: 'Только буквы, цифры и _' });

  const existing = db.getUserByUsername(username);
  if (existing) return res.status(400).json({ error: 'Имя занято' });

  const hash = bcrypt.hashSync(password, 10);
  const token = uuidv4();
  const user = db.createUser(username, hash, token);
  res.json({ id: user.id, username: user.username, token });
});

// Вход
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Неверные данные' });
  }
  const token = uuidv4();
  db.updateToken(user.id, token);
  res.json({ id: user.id, username: user.username, token });
});

// ─────────────────────────────────────────────
// REST API — Серверы (гильдии)
// ─────────────────────────────────────────────

app.get('/api/servers', requireAuth, (req, res) => {
  const servers = db.getUserServers(req.userId);
  res.json(servers);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название' });
  const server = db.createServer(name.trim(), req.userId);
  // Создать дефолтный канал
  db.createChannel(server.id, 'general', 'text');
  // Добавить создателя как участника
  db.addServerMember(server.id, req.userId, 'owner');
  const full = db.getServerById(server.id);
  res.json(full);
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Не найдено' });
  const isMember = db.isServerMember(req.params.id, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Нет доступа' });
  const channels = db.getServerChannels(req.params.id);
  const members = db.getServerMembersWithStatus(req.params.id, clients);
  res.json({ ...server, channels, members });
});

// Вступить по инвайт-коду (упрощённо — по ID сервера)
app.post('/api/servers/:id/join', requireAuth, (req, res) => {
  const isMember = db.isServerMember(req.params.id, req.userId);
  if (isMember) return res.status(400).json({ error: 'Уже участник' });
  const server = db.getServerById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });
  db.addServerMember(req.params.id, req.userId, 'member');
  res.json({ ok: true });
});

app.delete('/api/servers/:id/leave', requireAuth, (req, res) => {
  db.removeServerMember(req.params.id, req.userId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// REST API — Каналы
// ─────────────────────────────────────────────

app.post('/api/servers/:serverId/channels', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название' });
  const member = db.getServerMember(req.params.serverId, req.userId);
  if (!member || member.role !== 'owner') return res.status(403).json({ error: 'Только владелец' });
  const channel = db.createChannel(req.params.serverId, name.trim().toLowerCase().replace(/\s+/g, '-'), 'text');
  res.json(channel);
});

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const messages = db.getChannelMessages(req.params.id, 50);
  res.json(messages);
});

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  const channel = db.getChannelById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Не найдено' });
  const member = db.getServerMember(channel.serverId, req.userId);
  if (!member || member.role !== 'owner') return res.status(403).json({ error: 'Только владелец' });
  db.deleteChannel(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// REST API — Личные сообщения
// ─────────────────────────────────────────────

app.get('/api/dm/:userId', requireAuth, (req, res) => {
  const messages = db.getDMMessages(req.userId, req.params.userId, 50);
  res.json(messages);
});

// ─────────────────────────────────────────────
// REST API — Друзья
// ─────────────────────────────────────────────

app.get('/api/friends', requireAuth, (req, res) => {
  const friends = db.getFriends(req.userId);
  const withStatus = friends.map(f => ({
    ...f,
    isOnline: clients.has(f.friendId)
  }));
  res.json(withStatus);
});

app.post('/api/friends/add', requireAuth, (req, res) => {
  const { username } = req.body;
  const target = db.getUserByUsername(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.id === req.userId) return res.status(400).json({ error: 'Нельзя добавить себя' });
  const existing = db.getFriendship(req.userId, target.id);
  if (existing) return res.status(400).json({ error: 'Уже в друзьях' });
  db.addFriend(req.userId, target.id);
  res.json({ id: target.id, username: target.username });
});

app.delete('/api/friends/:friendId', requireAuth, (req, res) => {
  db.removeFriend(req.userId, req.params.friendId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// REST API — Поиск пользователей
// ─────────────────────────────────────────────

app.get('/api/users/search', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const users = db.searchUsers(q, req.userId);
  res.json(users);
});

app.get('/api/users/online', requireAuth, (req, res) => {
  const onlineIds = [...clients.keys()];
  res.json(onlineIds);
});

// ─────────────────────────────────────────────
// Middleware проверки авторизации
// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const user = db.getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Неверный токен' });
  req.userId = user.id;
  next();
}

// ─────────────────────────────────────────────
// Запуск сервера
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});
