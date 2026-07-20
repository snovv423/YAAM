'use strict';

// YAAM — PostgreSQL application assembly, Production Switch Stage 7.
// Изолированный, НЕ подключённый к production модуль. Собирает воедино
// компоненты Stage 1-6 (публичный API, admin, event layer, бот, scheduler,
// bootstrap/health/lifecycle) в один управляемый Express-app, но не меняет
// ни одной строки бизнес-логики ни в одном из них — только монтирование,
// middleware-порядок и координация lifecycle.
//
// server/server.postgresql.js остаётся тонкой точкой входа (main()/
// process.exit()) — вся сборка живёт здесь, в createPostgresqlApp(),
// require()-безопасной (не запускает listen()/main() как побочный эффект
// загрузки модуля), тестируемой без реального process.exit().
//
// SQLite-сторона (server.js, routes/api.js, routes/admin.js, bot/index.js)
// не импортируется отсюда ни прямо, ни транзитивно — подтверждено тестом
// A-раздела Stage 7 (статическая проверка исходника на отсутствие импорта
// SQLite-модуля БД по относительному пути).

const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const crypto = require('node:crypto');

const apiRoutes = require('../../routes/postgresql/api');
const adminRoutes = require('../../routes/postgresql/admin');
const { buildCorsOptions } = require('../../config/cors');
const { createPauseExpiryScheduler, createOrderTimeoutScheduler, createRefundReconciliationScheduler } = require('./scheduler');
const { createHealthCheck } = require('./health');
const { createLifecycle } = require('./lifecycle');
const { startBot } = require('../../bot/postgresql');

const WEBHOOK_PATH = '/api/webhooks/payment';
const KNOWN_APP_ENVS = ['local', 'staging', 'production'];

// Аддитивный к db/postgresql/bootstrap.js validateEnv() (который проверяет
// ТОЛЬКО переменные подключения к БД) — этот валидатор проверяет НОВЫЕ,
// специфичные для Stage 7 сборки переменные, тем же принципом fail-fast/
// понятная ошибка/без silent fallback. Вызывается СИНХРОННО в
// createPostgresqlApp(), до создания Express-приложения — опечатка в
// ENABLE_DEV_PAYMENT_ROUTES/APP_ENV не должна тихо трактоваться как
// "выключено", если явно похожа на попытку что-то включить.
function validateAppEnv(env) {
  const errors = [];

  if (
    env.ENABLE_DEV_PAYMENT_ROUTES !== undefined &&
    env.ENABLE_DEV_PAYMENT_ROUTES !== '' &&
    env.ENABLE_DEV_PAYMENT_ROUTES !== 'true' &&
    env.ENABLE_DEV_PAYMENT_ROUTES !== 'false'
  ) {
    errors.push(`ENABLE_DEV_PAYMENT_ROUTES="${env.ENABLE_DEV_PAYMENT_ROUTES}" — допустимы только "true" или "false".`);
  }

  if (env.APP_ENV !== undefined && env.APP_ENV !== '' && !KNOWN_APP_ENVS.includes(env.APP_ENV)) {
    errors.push(`APP_ENV="${env.APP_ENV}" — допустимы только ${KNOWN_APP_ENVS.map((v) => `"${v}"`).join('/')}.`);
  }

  if (Boolean(env.ADMIN_USER) !== Boolean(env.ADMIN_PASS)) {
    errors.push('ADMIN_USER и ADMIN_PASS должны быть заданы вместе (сейчас задан только один из двух).');
  }

  if (errors.length) {
    throw new Error(`[services/postgresql/app] некорректная конфигурация окружения:\n${errors.join('\n')}`);
  }
}

function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Логирует метод/путь/статус/длительность — намеренно НИКОГДА не тело
// запроса и не заголовки (значит, ни Authorization/Bearer-токен заказа, ни
// платёжные payload, ни PII клиента не попадают в лог). req.path, а не
// req.originalUrl — на случай, если в будущем какой-то маршрут когда-нибудь
// станет принимать чувствительные значения через query string.
function accessLogMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `[app-postgresql] ${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms id=${req.id}`
    );
  });
  next();
}

// Минимальный набор security-заголовков штатными средствами Express/Node —
// без новой зависимости (helmet и т.п.), задание прямо просит обосновывать
// новые пакеты и предпочитать встроенные возможности, если их достаточно.
function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not found', requestId: req.id });
}

// CORS-мидлварь передаёт запрет origin через next(err) (см. config/cors.js) —
// тот же обработчик, что и в SQLite server.js, с добавлением requestId.
function corsErrorHandler(err, req, res, next) {
  if (err && /^CORS:/.test(err.message)) {
    return res.status(403).json({ error: err.message, requestId: req.id });
  }
  next(err);
}

// Последний обработчик — единственное место, решающее, показывать ли
// err.message клиенту. В production — только общая фраза, НИКОГДА
// err.stack/err.message (могут содержать внутренние детали: имена таблиц,
// куски SQL, пути к файлам). requestId сохраняется, чтобы связать жалобу
// пользователя/тикет с конкретной строкой в access-логе.
function createErrorHandler(env) {
  const isProduction = env.APP_ENV === 'production' || env.NODE_ENV === 'production';
  return function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    console.error(`[app-postgresql] unhandled error id=${req.id}:`, err && err.stack ? err.stack : err);
    const status = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 500;
    res.status(status).json({
      error: isProduction ? 'Внутренняя ошибка сервера' : (err && err.message) || 'Внутренняя ошибка сервера',
      requestId: req.id,
    });
  };
}

// Оборачивает bot/postgresql (createBotHandlers/startBot) в тот же
// {start(), stop(), isRunning()}-контракт, что и scheduler, чтобы
// services/postgresql/lifecycle.js мог управлять и им, ничего не меняя в
// самом lifecycle.js — бот "конструирование = запуск" (createBotHandlers
// синхронно навешивает слушатели и, для реального TelegramBot, синхронно
// запускает long polling), а не отдельный двухфазный API, поэтому не
// подходит под интерфейс lifecycle.schedulers напрямую без этой обёртки.
//
// botClient — только для тестов (см. bot/postgresql/index.js header):
// позволяет внедрить FakeTelegramBot вместо реального токена/сети.
function createBotLifecycleAdapter({ token, botClient }) {
  let handle = null;
  let state = 'stopped'; // stopped | running | failed
  let lastError = null;

  return {
    // Идемпотентен — повторный start() на уже запущенном адаптере не
    // создаёт второй bot-инстанс/второй набор слушателей (тот же принцип,
    // что и у scheduler.start()).
    start() {
      if (handle) return;
      try {
        handle = botClient ? startBot(token || 'test-only-unused-token', { bot: botClient }) : startBot(token);
        state = 'running';
        lastError = null;
      } catch (err) {
        // node-telegram-bot-api с polling:true не бросает синхронно на
        // сетевых сбоях (см. bot/postgresql/index.js header — сбои приходят
        // асинхронно как 'polling_error', уже обработанные внутри
        // createBotHandlers) — этот catch укрывает от ГИПОТЕТИЧЕСКОГО
        // синхронного сбоя конструктора (например, сломанный fakeBot в
        // тесте), чтобы старт бота НИКОГДА не мог уронить HTTP-приложение
        // (задание, раздел "Telegram bot lifecycle").
        state = 'failed';
        lastError = err.message;
        console.error('[app-postgresql] bot start failed (изолировано, HTTP не затронут):', err.message);
      }
    },

    stop() {
      if (!handle) return;
      handle.stop();
      handle = null;
      state = 'stopped';
    },

    isRunning() {
      return state === 'running';
    },

    getState() {
      return { state, lastError };
    },
  };
}

// createPostgresqlApp(options) — фабрика (не singleton). require() этого
// файла НЕ вызывает её сам — вызывающий код (server.postgresql.js либо тест)
// решает, когда и с какими опциями создавать конкретный instance.
//
// options.env — только для тестов (позволяет передать изолированный объект
// вместо process.env); production-вызов (server.postgresql.js) всегда
// использует дефолт.
function createPostgresqlApp({
  port,
  host,
  schedulerIntervalMs,
  orderTimeoutIntervalMs,
  refundReconciliationIntervalMs,
  refundReconciliationLimit,
  bootstrapOptions,
  corsOptions,
  adminUser,
  adminPass,
  botToken,
  botClient,
  onSignal,
  env = process.env,
} = {}) {
  validateAppEnv(env);

  const resolvedAdminUser = adminUser !== undefined ? adminUser : env.ADMIN_USER;
  const resolvedAdminPass = adminPass !== undefined ? adminPass : env.ADMIN_PASS;
  const resolvedBotToken = botToken !== undefined ? botToken : env.TELEGRAM_BOT_TOKEN;
  const resolvedPort = port !== undefined ? port : (Number(env.PG_HEALTH_PORT) || 3001);
  const resolvedHost = host !== undefined ? host : (env.PG_HEALTH_HOST || '127.0.0.1');

  const scheduler = createPauseExpiryScheduler({ intervalMs: schedulerIntervalMs });
  // Production Switch — Stage 8: без этих двух заказы никогда не истекали бы
  // по SLA-таймауту, а зарезервированные (reserveRefundRow) возвраты,
  // которые почему-то не были отправлены провайдеру сразу (падение процесса
  // между commit и scheduleRefundProcessing, неоднозначный сетевой исход),
  // никогда не были бы повторены — см. services/postgresql/orderService.js.
  const orderTimeoutScheduler = createOrderTimeoutScheduler({ intervalMs: orderTimeoutIntervalMs });
  const refundReconciliationScheduler = createRefundReconciliationScheduler({
    intervalMs: refundReconciliationIntervalMs,
    limit: refundReconciliationLimit,
  });

  const botEnabled = Boolean(resolvedBotToken || botClient);
  const botAdapter = botEnabled ? createBotLifecycleAdapter({ token: resolvedBotToken, botClient }) : null;
  if (!botEnabled) {
    console.warn('[app-postgresql] TELEGRAM_BOT_TOKEN не задан — бот ресторана не запущен');
  }

  // Bot НЕ входит в getSchedulers() (то самостоятельное понятие — только
  // периодические sweep'ы, как и в Stage 6) — состояние бота отдельное,
  // наблюдаемое поле readiness(), не участвующее в `ok` (см. health.js).
  const health = createHealthCheck({
    getSchedulers: () => [scheduler, orderTimeoutScheduler, refundReconciliationScheduler],
    getBotState: () => (botAdapter ? botAdapter.getState() : { state: 'disabled' }),
  });

  let ready = false;

  const app = express();
  app.disable('x-powered-by');

  // 1. request id
  app.use(requestIdMiddleware);
  // 2. access log (без секретов/тела)
  app.use(accessLogMiddleware);
  // 3. security headers
  app.use(securityHeadersMiddleware);
  // 4. CORS
  app.use(cors(corsOptions || buildCorsOptions()));

  // Health-эндпоинты — намеренно ДО readiness-гейта и ДО JSON-парсинга (не
  // нуждаются в body, не должны зависеть от готовности PostgreSQL сами по
  // себе — иначе /health/ready никогда не смог бы честно сообщить "не
  // готов", получая от гейта 503 вместо реальной readiness-формы ответа).
  app.get('/health/live', async (req, res) => {
    const result = await health.liveness();
    res.status(200).json(result);
  });
  app.get('/health/ready', async (req, res) => {
    const result = await health.readiness();
    res.status(result.ok ? 200 : 503).json(result);
  });
  app.get('/health', async (req, res) => {
    const result = await health.readiness();
    res.status(result.ok ? 200 : 503).json(result);
  });

  // 5. webhook — сырое тело ДО обычного JSON-парсера (сам маршрут внутри
  // routes/postgresql/api.js уже использует express.raw() точечно; этот
  // carve-out нужен только чтобы ГЛОБАЛЬНЫЙ express.json() ниже не пытался
  // распарсить тот же body до того, как до него дойдёт роутер — дословно
  // тот же приём, что и в SQLite server.js).
  // 6. json/urlencoded для всех остальных маршрутов
  app.use((req, res, next) => {
    if (req.path === WEBHOOK_PATH) return next();
    express.json()(req, res, next);
  });
  app.use(express.urlencoded({ extended: true }));

  // Readiness-гейт для БИЗНЕС-трафика (не health) — Variant A (см.
  // postgresql-application-assembly.md): HTTP-listener поднимается сразу
  // (см. start() ниже), но ни один business-маршрут, включая webhook и
  // admin mutations, не обрабатывается до успешного завершения
  // lifecycle.start() (bootstrap + scheduler/bot). Дешёвый boolean-флаг, не
  // повторный live-запрос к БД на каждый запрос — сама readiness к БД уже
  // проверяется живым SELECT 1 на каждый вызов /health/ready; per-request
  // проверка тут была бы избыточной задержкой без дополнительной пользы,
  // т.к. каждый маршрут и так обрабатывает свои собственные ошибки БД.
  app.use((req, res, next) => {
    if (req.path.startsWith('/health')) return next();
    if (!ready) {
      return res.status(503).json({ error: 'Сервис инициализируется — PostgreSQL ещё не готов', requestId: req.id });
    }
    next();
  });

  // 7. публичный API
  app.use('/api', apiRoutes);

  // 8. admin API — Basic Auth на точке монтирования, тот же паттерн, что
  // SQLite server.js (роутер сам auth-агностичен, см. Stage 4). Fail-closed:
  // без обеих переменных админка вообще не монтируется (недоступна), а не
  // монтируется без защиты.
  if (resolvedAdminUser && resolvedAdminPass) {
    app.use('/admin', basicAuth({
      users: { [resolvedAdminUser]: resolvedAdminPass },
      challenge: true,
      realm: 'YAAM Admin',
    }), adminRoutes);
  } else {
    console.warn('[app-postgresql] ADMIN_USER/ADMIN_PASS не заданы — админка недоступна, пока их не задать в .env');
  }

  // 9. dev/test-маршруты — единственный существующий (dev-confirm-payment)
  // уже смонтирован ВНУТРИ apiRoutes, гейт применяется на уровне require()
  // самого routes/postgresql/api.js (ENABLE_DEV_PAYMENT_ROUTES==='true' &&
  // PAYMENT_PROVIDER==='mock' && APP_ENV in [local,staging]) — тот же
  // трёхкратный fail-closed гейт, что и SQLite-оригинал. Дополнительный
  // gate на этом уровне сборки не нужен — задваивал бы уже корректный
  // механизм, не усиливая его.
  app.use(corsErrorHandler);

  // 10. 404
  app.use(notFoundHandler);

  // 11. централизованный error handler — последний
  app.use(createErrorHandler(env));

  let httpServer = null;
  let lifecycle = null;

  async function start() {
    httpServer = app.listen(resolvedPort, resolvedHost);
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });

    const baseSchedulers = [scheduler, orderTimeoutScheduler, refundReconciliationScheduler];
    lifecycle = createLifecycle({
      schedulers: botAdapter ? [...baseSchedulers, botAdapter] : baseSchedulers,
      httpServer,
      onShutdown: () => {
        ready = false;
      },
      onSignal,
    });

    try {
      await lifecycle.start({ bootstrap: bootstrapOptions });
      ready = true;
    } catch (err) {
      ready = false;
      await new Promise((resolve) => httpServer.close(resolve));
      throw err;
    }
  }

  async function stop() {
    if (lifecycle) await lifecycle.stop();
    ready = false;
  }

  function isRunning() {
    return Boolean(lifecycle && lifecycle.isRunning());
  }

  function isReady() {
    return ready;
  }

  function address() {
    return httpServer ? httpServer.address() : null;
  }

  return {
    app, start, stop, isRunning, isReady, address, health, scheduler, botAdapter,
    orderTimeoutScheduler, refundReconciliationScheduler,
  };
}

module.exports = { createPostgresqlApp, validateAppEnv, createBotLifecycleAdapter, WEBHOOK_PATH };
