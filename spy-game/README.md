# 🕵️ ШПИОН — Угадай кто

Мультиплеерная браузерная игра "Угадай кто шпион" с WebSocket.

## Структура проекта

```
spy-game/
├── server.js        ← Node.js сервер (WebSocket + Express)
├── package.json
└── public/
    └── index.html   ← Весь фронтенд
```

## Локальный запуск

```bash
npm install
npm start
# Открой http://localhost:3000
```

---

## 🚀 Деплой на Railway (бесплатно)

1. Зарегистрируйся на [railway.app](https://railway.app)
2. Нажми **New Project → Deploy from GitHub**
3. Залей папку на GitHub (или используй Railway CLI):
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
4. Railway сам определит Node.js и запустит `npm start`
5. Во вкладке **Settings → Networking** нажми **Generate Domain** — получишь публичный URL

---

## 🚀 Деплой на Render (бесплатно)

1. Зарегистрируйся на [render.com](https://render.com)
2. **New → Web Service → Connect GitHub repo**
3. Настройки:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
4. Нажми **Create Web Service**
5. Через 1-2 минуты получишь URL вида `https://spy-game-xxxx.onrender.com`

---

## 🚀 Деплой на VPS / хостинг с SSH

```bash
# На сервере:
git clone <твой_репо> spy-game
cd spy-game
npm install

# Установи PM2 для фонового запуска:
npm install -g pm2
pm2 start server.js --name spy-game
pm2 save
pm2 startup

# Если нужен nginx как прокси:
# /etc/nginx/sites-available/spy-game
server {
    listen 80;
    server_name твой-домен.ru;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `PORT`    | `3000`      | Порт сервера |

На Railway/Render `PORT` выставляется автоматически.

---

## Как играть

1. Один игрок создаёт лобби, выставляет количество слотов (4–16)
2. Остальные вводят **5-значный код** чтобы войти
3. Хост нажимает **Начать игру**
4. Каждый игрок по очереди видит свою роль (мирный / шпион)
5. По 2 круга — каждый называет слово-ассоциацию
6. После 2 кругов — **голосование**: кто шпион?
7. Если нашли шпиона — мирные победили. Нет — игра продолжается
