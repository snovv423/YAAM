require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const { acquireLock, releaseLock } = require('./singleInstanceLock');

// orderService/автосвипы полагаются на единственный процесс (см.
// singleInstanceLock.js) — отказываемся стартовать, если другой экземпляр уже жив.
// Лок нужно взять ДО require('./routes/api') и любых других require, которые
// транзитивно трогают ../db — иначе миграция схемы (db/index.js) успевает
// выполниться до того, как лок вообще проверен, и два процесса, стартующие
// одновременно на немигрированной legacy-БД, гонятся за BEGIN IMMEDIATE друг
// с другом вместо того, чтобы один из них аккуратно отказался стартовать
// (независимый аудит SQLite migration/backup воспроизвёл это эмпирически).
let lockPath;
try {
  lockPath = acquireLock();
} catch (err) {
  console.error(`[server] ${err.message}`);
  process.exit(1);
}

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const orderService = require('./services/orderService');
const { buildCorsOptions } = require('./config/cors');

function shutdown() {
  releaseLock(lockPath);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// За одним локальным Nginx доверяем forwarded IP только от loopback. Нельзя
// использовать blanket `true`: если порт Node когда-либо окажется доступен
// напрямую, клиент сможет подделать X-Forwarded-For и обходить rate limits.
if (process.env.TRUST_PROXY === 'loopback') {
  app.set('trust proxy', 'loopback');
} else if (process.env.TRUST_PROXY) {
  throw new Error('TRUST_PROXY поддерживает только безопасное значение "loopback"');
} else if (process.env.APP_ENV === 'production') {
  throw new Error('Для production за локальным Nginx требуется TRUST_PROXY=loopback');
}

app.use(cors(buildCorsOptions()));

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

// CORS-мидлварь передаёт запрет origin сюда через next(err) — без этого
// обработчика Express отдал бы дефолтную HTML-страницу ошибки вместо JSON.
app.use((err, req, res, next) => {
  if (err && /^CORS:/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }
  next(err);
});

// Автосвип заказов, на которые ресторан не ответил за 3 минуты (см. orderService).
setInterval(() => orderService.sweepTimeouts(), 10_000);
// Автосвип истёкших перерывов ресторанов (33 мин / 3 часа / 11 часов).
setInterval(() => orderService.sweepPauseExpiry(), 30_000);
// Автосвип "зависших" возвратов — requested/processing строк, чья попытка не
// стартовала (падение процесса между commit и fire-and-forget вызовом) или
// закончилась неоднозначно (throw/timeout у провайдера). Тот же интервал, что
// и у sweepTimeouts — возвраты не более срочны, чем истечение ответа ресторана.
setInterval(() => orderService.sweepStuckRefunds(), 10_000);

app.listen(PORT, HOST, () => {
  console.log(`[server] YAAM API слушает на ${HOST}:${PORT}`);

  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { startBot } = require('./bot');
    startBot(process.env.TELEGRAM_BOT_TOKEN);
  } else {
    console.warn('[server] TELEGRAM_BOT_TOKEN не задан — бот ресторана не запущен');
  }
});
