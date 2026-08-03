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
const path = require('node:path');

const apiRoutes = require('../../routes/postgresql/api');
const settlementDocumentRoutes = require('../../routes/postgresql/settlementDocuments');
const adminRoutes = require('../../routes/postgresql/admin');
const { createHqRouter } = require('../../routes/hq');
const hqOwnerService = require('../hq/ownerService');
const { createMediaProviderFromEnv, LocalMediaProvider } = require('../hq/media/provider');
const { buildCorsOptions } = require('../../config/cors');
const {
  createPauseExpiryScheduler, createOrderTimeoutScheduler, createRefundReconciliationScheduler,
  createWeeklySettlementScheduler,
} = require('./scheduler');
const { createHealthCheck } = require('./health');
const { createLifecycle } = require('./lifecycle');
const { assertEnv } = require('../config/env');
const { safeRoute } = require('../observability/logger');
const { PgSessionStore } = require('../hq/pgSessionStore');
const migrator = require('./migrator');
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

  if (env.PAYMENT_PROVIDER !== undefined && !['mock', 'yookassa'].includes(env.PAYMENT_PROVIDER)) {
    errors.push('PAYMENT_PROVIDER допускает только "mock" или "yookassa".');
  }

  if (env.PAYMENT_PROVIDER === 'yookassa') {
    if (env.YOOKASSA_ENV !== 'sandbox') {
      errors.push('Для текущего этапа PAYMENT_PROVIDER=yookassa требует YOOKASSA_ENV=sandbox.');
    }
    if (!/^\d+$/.test(env.YOOKASSA_SHOP_ID || '')) {
      errors.push('YOOKASSA_SHOP_ID обязателен и должен быть числовым идентификатором тестового магазина.');
    }
    if (typeof env.YOOKASSA_SECRET_KEY !== 'string' || !env.YOOKASSA_SECRET_KEY.startsWith('test_')) {
      errors.push('YOOKASSA_SECRET_KEY должен быть тестовым ключом с префиксом test_.');
    }
    for (const [name, value] of [
      ['YOOKASSA_RETURN_URL', env.YOOKASSA_RETURN_URL],
      ['YOOKASSA_WEBHOOK_URL', env.YOOKASSA_WEBHOOK_URL],
    ]) {
      try {
        if (!value || new URL(value).protocol !== 'https:') errors.push(`${name} должен быть задан как HTTPS URL.`);
      } catch {
        errors.push(`${name} должен быть задан как HTTPS URL.`);
      }
    }
    if (env.YOOKASSA_WEBHOOK_URL) {
      try {
        if (new URL(env.YOOKASSA_WEBHOOK_URL).pathname !== WEBHOOK_PATH) {
          errors.push(`YOOKASSA_WEBHOOK_URL должен вести точно на ${WEBHOOK_PATH}.`);
        }
      } catch {
        // Некорректный URL уже добавлен в errors выше.
      }
    }
    if (env.ENABLE_DEV_PAYMENT_ROUTES === 'true') {
      errors.push('ENABLE_DEV_PAYMENT_ROUTES нельзя включать вместе с PAYMENT_PROVIDER=yookassa.');
    }
  }

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

  if (
    env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST !== undefined
    && env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST !== ''
    && !['true', 'false'].includes(env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST)
  ) {
    errors.push('YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST допускает только "true" или "false".');
  }

  if (env.PG_HEALTH_PORT !== undefined && env.PG_HEALTH_PORT !== '') {
    const port = Number(env.PG_HEALTH_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`PG_HEALTH_PORT="${env.PG_HEALTH_PORT}" — требуется целое число 1..65535.`);
    }
  }

  const healthHost = env.PG_HEALTH_HOST || '127.0.0.1';
  if (env.APP_ENV === 'production' && !['127.0.0.1', '::1', 'localhost'].includes(healthHost)) {
    errors.push('PG_HEALTH_HOST в production должен быть loopback (127.0.0.1, ::1 или localhost).');
  }

  if (Boolean(env.ADMIN_USER) !== Boolean(env.ADMIN_PASS)) {
    errors.push('ADMIN_USER и ADMIN_PASS должны быть заданы вместе (сейчас задан только один из двух).');
  }

  // HQ Stage 2 — тот же fail-closed принцип, что у ADMIN_USER/ADMIN_PASS
  // (см. выше): HQ_ADMIN_USER без HQ_ADMIN_PASSWORD_HASH (и наоборот) —
  // явная ошибка конфигурации. Stage 3: эта пара больше НЕ обязательна для
  // работы HQ вообще — владелец хранится в PostgreSQL (hq_owner), .env
  // нужен только один раз, для самого первого bootstrap пустой таблицы (см.
  // hqOwnerService.bootstrapOwnerFromEnv() ниже). Правило "заданы либо обе,
  // либо ни одной" остаётся: наполовину заданная пара — конфигурационная
  // ошибка (опечатка), а не "бутстрап просто не произойдёт".
  if (Boolean(env.HQ_ADMIN_USER) !== Boolean(env.HQ_ADMIN_PASSWORD_HASH)) {
    errors.push('HQ_ADMIN_USER и HQ_ADMIN_PASSWORD_HASH должны быть заданы вместе (сейчас задан только один из двух).');
  }
  // Stage 3: HQ_SESSION_SECRET — теперь ЕДИНСТВЕННАЯ переменная, реально
  // обязательная для существования HQ (владелец больше не обязан жить в
  // .env — см. выше). Проверяется её собственная валидность БЕЗУСЛОВНО
  // (не только "если задан HQ_ADMIN_USER", как было в Stage 2) — короткий
  // секрет опасен сам по себе, независимо от того, откуда берётся владелец.
  if (env.HQ_SESSION_SECRET !== undefined && env.HQ_SESSION_SECRET !== '' && env.HQ_SESSION_SECRET.length < 32) {
    errors.push('HQ_SESSION_SECRET должен быть не короче 32 символов.');
  }
  // Stage 2.1 — clean-root routing для hq.yaam.su: HQ_LINK_BASE_PATH решает,
  // какой префикс роутер сам пишет в свои же ссылки/redirect'ы/form action/
  // cookie path — '/hq' (по умолчанию, локально) или '' (за отдельным
  // поддоменом-прокси, см. services/hq/basePath.js). Проверяется здесь ЕЩЁ
  // РАЗ (тем же правилом, что и в normalizeHqLinkBasePath) — ошибка в этой
  // переменной должна останавливать старт приложения понятным сообщением
  // ДО того, как до неё вообще дойдёт createHqRouter().
  if (env.HQ_LINK_BASE_PATH !== undefined && env.HQ_LINK_BASE_PATH !== '' && !/^\/[a-zA-Z0-9_-]+$/.test(env.HQ_LINK_BASE_PATH)) {
    errors.push('HQ_LINK_BASE_PATH допускает только пустую строку ("") для clean-root или один сегмент вида "/hq".');
  }

  // Production Switch — Stage 9: дословно тот же принцип, что уже
  // применяется в SQLite server.js (TRUST_PROXY поддерживает ТОЛЬКО
  // "loopback") — до Stage 9 этой проверки на PostgreSQL-стороне не было
  // вообще (найдено при подготовке деплоя). Без нативного express `trust
  // proxy` req.ip отражает адрес сокета (в проде — адрес локального Nginx),
  // НЕ реальный адрес клиента из X-Forwarded-For — это делает
  // isTrustedYookassaIp(req.ip) (см. routes/postgresql/api.js, Stage 8)
  // бессмысленной проверкой за реальным reverse-прокси: она либо всегда
  // видит адрес самого Nginx, либо (если прокси не настроен доверенно)
  // доверяет клиентскому заголовку без проверки — оба исхода небезопасны.
  // Единственное безопасное значение — "loopback" (доверять
  // X-Forwarded-For только от локального процесса на той же машине, что и
  // есть единственная поддерживаемая топология — один Nginx на одном VPS
  // перед одним backend-процессом). Production без корректно настроенного
  // TRUST_PROXY=loopback — fail-closed, не тихий дефолт.
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '' && env.TRUST_PROXY !== 'loopback') {
    errors.push('TRUST_PROXY поддерживает только безопасное значение "loopback".');
  }
  if (env.APP_ENV === 'production' && env.TRUST_PROXY !== 'loopback') {
    errors.push('Для production за локальным Nginx требуется TRUST_PROXY=loopback.');
  }

  // YAAM HQ Stage 5B/5B.2 — медиа-система (задание, раздел 4: fail-closed).
  // Не задан вовсе — медиа-функциональность просто не монтируется (см.
  // ниже), это не ошибка конфигурации сама по себе. Единственный
  // поддерживаемый provider — "local": YAAM работает в масштабе одного
  // региона (Чечня), отдельное S3-совместимое хранилище на этом масштабе —
  // инфраструктура "на вырост" (задание Stage 5B.2, раздел 1), фотографии
  // хранятся в постоянной директории на самом VPS. В production обязателен
  // MEDIA_LOCAL_ROOT (persistent-режим) — временный/auto-каталог означал бы,
  // что фотографии исчезают при каждом restart/deploy.
  if (env.MEDIA_PROVIDER !== undefined && env.MEDIA_PROVIDER !== '' && env.MEDIA_PROVIDER !== 'local') {
    errors.push('MEDIA_PROVIDER допускает только "local".');
  }
  if (env.MEDIA_PROVIDER === 'local' && env.MEDIA_LOCAL_ROOT && env.MEDIA_LOCAL_DIR) {
    errors.push('Заданы одновременно MEDIA_LOCAL_ROOT и MEDIA_LOCAL_DIR — укажите ровно один.');
  }
  if (env.MEDIA_PROVIDER === 'local' && env.APP_ENV === 'production' && !env.MEDIA_LOCAL_ROOT) {
    errors.push('В production MEDIA_PROVIDER=local требует MEDIA_LOCAL_ROOT (постоянная директория на VPS).');
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
// платёжные payload, ни PII клиента не попадают в лог).
//
// ПУТЬ ПРОПУСКАЕТСЯ ЧЕРЕЗ safeRoute(). Раньше здесь был просто req.path с
// пояснением, что query string не логируется. Этого стало недостаточно:
// capability-маршрут документов принимает секрет ПРЯМО В ПУТИ (/d/<токен>),
// и токен уходил в journald открытым текстом — обнаружено на staging при
// первом же обращении к этому маршруту. safeRoute() маскирует его до
// /d/:token и заодно вырезает узнаваемые формы секретов из остальных путей.
function accessLogMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `[app-postgresql] ${req.method} ${safeRoute(req)} ${res.statusCode} ${durationMs.toFixed(1)}ms id=${req.id}`
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

    async stop() {
      if (!handle) return;
      await handle.stop();
      handle = null;
      state = 'stopped';
    },

    isRunning() {
      return state === 'running';
    },

    getState() {
      return { state, lastError };
    },

    // Живой bot-клиент для HQ-действия «Отправить тест»
    // (docs/HQ-PRODUCT-SPEC.md, раздел «Telegram-подключение»). null, если
    // бот не запущен на этом процессе — HQ тогда честно сообщает, что тест
    // недоступен, вместо имитации успешной отправки.
    getBot() {
      return handle ? handle.bot : null;
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
  // Еженедельное закрытие расчётных периодов — параметры только для тестов
  // (production использует дефолты scheduler.js). runOnStart=false нужен
  // тестам, которые не хотят фонового прогона job во время своих сценариев.
  weeklySettlementIntervalMs,
  weeklySettlementRunOnStart = true,
  bootstrapOptions,
  // Stage 15: сколько ждать завершения активных HTTP-запросов при выключении.
  // Без предела httpServer.close() висит вечно на keep-alive-соединениях, и
  // systemd в итоге убивает процесс SIGKILL — то есть «graceful» shutdown
  // оказывался не graceful.
  shutdownTimeoutMs,
  // Stage 15: применять ли миграции при старте. Тесты сами накатывают схему
  // и выключают это; реальный запуск обязан их применять.
  runMigrations = true,
  corsOptions,
  adminUser,
  adminPass,
  hqAdminUser,
  hqAdminPasswordHash,
  hqSessionSecret,
  hqLinkBasePath,
  botToken,
  botClient,
  onSignal,
  env = process.env,
} = {}) {
  validateAppEnv(env);

  // Stage 16: централизованная проверка КОМБИНАЦИИ настроек (services/config/env.js).
  //
  // Она была написана в Stage 15, но нигде не вызывалась при старте — только
  // в readiness. То есть приложение по-прежнему МОГЛО запуститься с
  // запрещённой конфигурацией (например, production на mock-провайдере), а
  // «запрет» существовал лишь как отчёт постфактум. Здесь и есть fail fast:
  // до открытия пула, до миграций, до первого запроса.
  //
  // В тестах и development проверка почти ничего не требует (см. inspectEnv),
  // поэтому вызов безопасен для существующих 1000+ тестов.
  assertEnv(env);

  const resolvedAdminUser = adminUser !== undefined ? adminUser : env.ADMIN_USER;
  const resolvedAdminPass = adminPass !== undefined ? adminPass : env.ADMIN_PASS;
  const resolvedHqAdminUser = hqAdminUser !== undefined ? hqAdminUser : env.HQ_ADMIN_USER;
  const resolvedHqAdminPasswordHash = hqAdminPasswordHash !== undefined ? hqAdminPasswordHash : env.HQ_ADMIN_PASSWORD_HASH;
  const resolvedHqSessionSecret = hqSessionSecret !== undefined ? hqSessionSecret : env.HQ_SESSION_SECRET;
  const resolvedHqLinkBasePath = hqLinkBasePath !== undefined ? hqLinkBasePath : env.HQ_LINK_BASE_PATH;
  const resolvedBotToken = botToken !== undefined ? botToken : env.TELEGRAM_BOT_TOKEN;
  const resolvedPort = port !== undefined ? port : (Number(env.PG_HEALTH_PORT) || 3001);
  const resolvedHost = host !== undefined ? host : (env.PG_HEALTH_HOST || '127.0.0.1');

  // YAAM HQ Stage 5B — единственная точка создания media provider на весь
  // процесс (не пересоздаётся на каждый запрос). validateAppEnv() выше уже
  // гарантировал, что при MEDIA_PROVIDER=s3 конфигурация полная — здесь
  // createMediaProviderFromEnv() лишь конструирует объект, второй раз
  // бросить fail-closed уже не должен (но если всё же бросит — это
  // законный сбой старта приложения, не тихая деградация). Не задан вовсе
  // -> null, HQ рендерит раздел «Фотографии» как "медиа не настроено", без
  // крэша остального приложения (рестораны/заказы работают как раньше).
  const mediaProvider = createMediaProviderFromEnv(env);
  if (!mediaProvider) {
    console.warn('[app-postgresql] MEDIA_PROVIDER не задан — раздел «Фотографии» в HQ недоступен.');
  }

  const scheduler = createPauseExpiryScheduler({ intervalMs: schedulerIntervalMs });
  // Production Switch — Stage 8: без этих двух заказы никогда не истекали бы
  // по SLA-таймауту, а зарезервированные (reserveRefundRow) возвраты,
  // которые почему-то не были отправлены провайдеру сразу (падение процесса
  // между commit и scheduleRefundProcessing, неоднозначный сетевой исход),
  // никогда не были бы повторены — см. services/postgresql/orderService.js.
  const orderTimeoutScheduler = createOrderTimeoutScheduler({ intervalMs: orderTimeoutIntervalMs });
  // Еженедельное закрытие расчётных периодов (docs/HQ-PRODUCT-SPEC.md).
  // weeklySettlementIntervalMs — только для тестов; production использует
  // дефолт. runOnStart=true даёт catch-up после простоя сервера.
  const weeklySettlementScheduler = createWeeklySettlementScheduler({
    intervalMs: weeklySettlementIntervalMs,
    runOnStart: weeklySettlementRunOnStart,
  });

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
    getSchedulers: () => [scheduler, orderTimeoutScheduler, refundReconciliationScheduler, weeklySettlementScheduler],
    getBotState: () => (botAdapter ? botAdapter.getState() : { state: 'disabled' }),
    // GIT_COMMIT_SHA — см. п.2 задания/health.js. Через уже существующий
    // `env` параметр (по умолчанию process.env) — та же, уже установленная
    // в этом файле схема тестируемости, что и validateAppEnv(env) выше, а
    // не отдельное прямое чтение process.env внутри health.js.
    getCommitSha: () => env.GIT_COMMIT_SHA,
  });

  let ready = false;
  // Объявляется здесь, а не рядом с lifecycle ниже: монтирование HQ
  // происходит РАНЬШЕ, и обращение к переменной из TDZ уронило бы сборку.
  let hqSessionStore = null;

  const app = express();
  app.disable('x-powered-by');
  // Production Switch — Stage 9: см. validateAppEnv() выше — единственное
  // безопасное значение уже проверено там (fail-closed), здесь только
  // применяется. Без этого req.ip/req.ips за реальным Nginx отражали бы
  // адрес самого Nginx (127.0.0.1), не клиента — IP-allowlist вебхука
  // (Stage 8, routes/postgresql/api.js) была бы бессмысленной проверкой.
  if (env.TRUST_PROXY === 'loopback') {
    app.set('trust proxy', 'loopback');
  }

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

  // 6b. YAAM HQ Stage 5B/5B.2 — раздача файлов LocalMediaProvider только в
  // dev/test (persistent=false — временный/явный test-каталог). Production
  // persistent-режим (MEDIA_LOCAL_ROOT) НЕ монтирует этот маршрут вовсе —
  // на реальном VPS публичные фотографии отдаёт Nginx напрямую из
  // MEDIA_LOCAL_ROOT/public (см. server/deploy/nginx-yaam-postgresql.conf,
  // server/docs/persistent-local-media-runbook.md), Node вообще не
  // участвует в раздаче байт изображений. Смонтирован только public/
  // подкаталог — private/ (master) никогда не проходит через этот static
  // route, даже в dev/test (запрос /media-fixtures/private/... получит 404
  // от express.static, потому что private/ физически вне смонтированного
  // корня).
  if (mediaProvider instanceof LocalMediaProvider && !mediaProvider.persistent) {
    app.use('/media-fixtures', express.static(path.join(mediaProvider.baseDir, 'public'), { maxAge: '1h', etag: true }));
  }

  // 7. публичный API
  app.use('/api', apiRoutes);
  // Capability-доступ ресторана к своему расчётному документу: /d/:token.
  // Вне /hq и вне /api — это не HQ и не публичное API заказов. Монтируется на
  // ЯВНЫЙ префикс, а не как catch-all: иначе этот router попадал бы в стек
  // любого пути и ломал бы инварианты сборки приложения.
  app.use('/d', settlementDocumentRoutes);

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

  // 8b. HQ — закрытая панель владельца. Fail-closed по точке монтирования,
  // тем же принципом, что и /admin выше: без HQ_SESSION_SECRET HQ вообще не
  // существует в приложении (не 404 "по умолчанию", а маршрут физически не
  // зарегистрирован). Собственный auth-слой внутри (express-session +
  // scrypt), НЕ Basic Auth — см. services/hq/*.
  //
  // Stage 3: HQ_ADMIN_USER/HQ_ADMIN_PASSWORD_HASH БОЛЬШЕ НЕ входят в это
  // условие — владелец хранится в PostgreSQL (hq_owner), а не в .env;
  // единственное, без чего HQ не может существовать в принципе — секрет
  // сессии. Если ADMIN_USER/HASH заданы — они используются НИЖЕ ровно один
  // раз, для bootstrap пустой таблицы hq_owner (см. hqOwnerService), но их
  // отсутствие само по себе НЕ выключает HQ — если владелец уже был создан
  // раньше (этим же bootstrap'ом на прошлом запуске, или через
  // scripts/reset-hq-owner.js), .env для входа больше не требуется вовсе.
  //
  // Stage 2.1: внутренняя точка монтирования ВСЕГДА '/hq' — публичный
  // clean-root на hq.yaam.su достигается только тем, что resolvedHqLinkBasePath
  // (см. HQ_LINK_BASE_PATH выше) заставляет сам роутер писать другие ссылки
  // в свои ответы; Nginx на VPS добавляет '/hq' обратно на пути к backend'у
  // (см. докс в финальном отчёте Stage 2.1) — эта строка не меняется.
  if (resolvedHqSessionSecret) {
    // Живой bot-клиент доступен HQ через app-настройку (действие «Отправить
    // тест», docs/HQ-PRODUCT-SPEC.md). Геттер, а не сам клиент: бот может
    // стартовать/останавливаться позже создания роутера.
    app.set('yaamTelegramBot', null);
    // Stage 15: HQ-сессии живут в PostgreSQL, а не в памяти процесса.
    // MemoryStore не переживал перезапуск (деплой разлогинивал владельца),
    // не чистил истёкшие записи и не работал бы на двух инстансах.
    hqSessionStore = new PgSessionStore();
    app.use('/hq', createHqRouter({
      sessionSecret: resolvedHqSessionSecret,
      isProduction: env.APP_ENV === 'production',
      linkBasePath: resolvedHqLinkBasePath,
      mediaProvider,
      sessionStore: hqSessionStore,
    }));
  } else {
    console.warn('[app-postgresql] HQ_SESSION_SECRET не задан — YAAM HQ недоступен, пока его не задать в .env');
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

    const baseSchedulers = [scheduler, orderTimeoutScheduler, refundReconciliationScheduler, weeklySettlementScheduler];
    lifecycle = createLifecycle({
      schedulers: botAdapter ? [...baseSchedulers, botAdapter] : baseSchedulers,
      httpServer,
      onShutdown: () => {
        ready = false;
        // Таймер очистки истёкших сессий — тоже ресурс, удерживающий процесс.
        if (hqSessionStore) hqSessionStore.close();
      },
      onSignal,
      shutdownTimeoutMs,
      runMigrations,
    });

    try {
      await lifecycle.start({ bootstrap: bootstrapOptions });

      // Бот уже запущен (он входит в schedulers выше) — публикуем живой
      // клиент для HQ-действия «Отправить тест». Если бот не сконфигурирован,
      // значение остаётся null, и HQ честно сообщает, что тест недоступен.
      if (botAdapter) app.set('yaamTelegramBot', botAdapter.getBot());

      // Stage 3 — единственное место, где .env вообще участвует во
      // владельце HQ: заполняет ПУСТУЮ таблицу hq_owner РОВНО один раз (сам
      // bootstrapOwnerFromEnv() — ON CONFLICT DO NOTHING, идемпотентен на
      // каждом следующем перезапуске процесса). Выполняется здесь (после
      // успешного db-bootstrap, до ready=true), а не лениво при первом
      // логине — совпадает с буквальной формулировкой задания "при первом
      // запуске проекта". Если ADMIN_USER/HASH не заданы — просто ничего не
      // делает (не ошибка: значит, владелец либо уже есть в БД, либо HQ пока
      // не сконфигурирован для входа вообще, что уже отражено предупреждением
      // в консоли выше).
      if (resolvedHqSessionSecret && resolvedHqAdminUser && resolvedHqAdminPasswordHash) {
        const { created } = await hqOwnerService.bootstrapOwnerFromEnv({
          login: resolvedHqAdminUser,
          passwordHash: resolvedHqAdminPasswordHash,
        });
        if (created) {
          console.log('[app-postgresql] HQ owner создан из .env (первая инициализация hq_owner)');
        }
      }

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
    orderTimeoutScheduler, refundReconciliationScheduler, weeklySettlementScheduler,
  };
}

module.exports = { createPostgresqlApp, validateAppEnv, createBotLifecycleAdapter, WEBHOOK_PATH };
