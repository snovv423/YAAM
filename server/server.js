require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const orderService = require('./services/orderService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// webhook читает raw body сам (routes/api.js), остальным нужен json
app.use((req, res, next) => {
  if (req.path === '/api/webhooks/payment') return next();
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true })); // для форм админки

app.use('/api', apiRoutes);

if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
  console.warn('[server] ADMIN_USER/ADMIN_PASS не заданы — админка недоступна, пока их не задать в .env');
} else {
  app.use('/admin', basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true,
    realm: 'YAAM Admin',
  }), adminRoutes);
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Автосвип заказов, на которые ресторан не ответил за 3 минуты (см. orderService).
setInterval(() => orderService.sweepTimeouts(), 10_000);

app.listen(PORT, () => {
  console.log(`[server] YAAM API слушает на порту ${PORT}`);

  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { startBot } = require('./bot');
    startBot(process.env.TELEGRAM_BOT_TOKEN);
  } else {
    console.warn('[server] TELEGRAM_BOT_TOKEN не задан — бот ресторана не запущен');
  }
});
