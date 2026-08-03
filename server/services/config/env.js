'use strict';

// YAAM — централизованная проверка конфигурации окружения (Stage 15).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Проверки были рассыпаны: часть в
// services/postgresql/app.js (validateEnv), часть в db/postgresql/bootstrap.js,
// часть в конструкторе YookassaProvider. Каждая по отдельности разумна, но
// вместе они не отвечали на главный эксплуатационный вопрос: «можно ли
// вообще запускать ЭТО окружение в ЭТОМ режиме». Например, ничто не мешало
// запустить APP_ENV=production с PAYMENT_PROVIDER=mock — то есть принимать
// настоящие заказы фиктивным провайдером.
//
// ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Не заменяет существующие проверки и не
// отключает их: они остаются как второй слой у самих подсистем. Здесь —
// решение о допустимости КОМБИНАЦИИ настроек, принимаемое до старта.
//
// ПРИНЦИП. Fail fast и никаких небезопасных значений по умолчанию: если
// секрет не задан, приложение не стартует, а не подставляет «дефолт».
// Секреты никогда не попадают в текст ошибок — только имена переменных.

const MODES = ['test', 'development', 'staging', 'production'];

// В проекте УЖЕ используется значение APP_ENV="local" (см. validateAppEnv в
// services/postgresql/app.js и существующие .env.*.example). Объявить его
// недопустимым значило бы сломать текущие окружения ради красоты словаря,
// поэтому 'local' принимается как синоним development.
const MODE_ALIASES = { local: 'development', dev: 'development', prod: 'production' };

// Явное значение APP_ENV — единственный источник истины о режиме.
// NODE_ENV намеренно НЕ используется как режим приложения: он про сборку и
// поведение библиотек, а не про то, боевые ли это деньги.
function resolveMode(env = process.env) {
  const raw = String(env.APP_ENV || '').trim().toLowerCase();
  if (!raw) return 'development';
  const normalized = MODE_ALIASES[raw] || raw;
  if (!MODES.includes(normalized)) {
    throw new Error(
      `APP_ENV="${env.APP_ENV}" — допустимы: ${MODES.join(', ')} `
      + `(а также синонимы: ${Object.keys(MODE_ALIASES).join(', ')}).`,
    );
  }
  return normalized;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// Признаки заведомо небезопасного/учебного значения. Проверяются только в
// staging/production: в тестах такие значения нормальны и обязательны.
const PLACEHOLDER_PATTERNS = [
  /^change[-_]?me$/i,
  /^replace[-_]?me$/i,
  /^ЗАМЕНИТЬ/i,
  /^test$/i,
  /^example$/i,
  /^secret$/i,
  /^password$/i,
  /^changeit$/i,
  /^xxx+$/i,
];

function looksLikePlaceholder(value) {
  const v = String(value).trim();
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(v))) return true;
  // Односимвольная «заглушка» вида 'ssssss…' — так секреты не выглядят.
  return v.length >= 8 && new Set(v).size === 1;
}

// Проверка конфигурации. Возвращает {mode, errors, warnings}.
// Ошибка — запуск невозможен. Предупреждение — запуск возможен, но об этом
// нужно знать.
function inspectEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const mode = resolveMode(env);
  const isProdLike = mode === 'production' || mode === 'staging';

  // --- Приложение и порт ---
  if (!isBlank(env.PG_HEALTH_PORT) && !(Number(env.PG_HEALTH_PORT) > 0)) {
    errors.push('PG_HEALTH_PORT должен быть положительным числом.');
  }

  // --- PostgreSQL ---
  const hasConnString = !isBlank(env.DATABASE_URL) || !isBlank(env.POSTGRES_URL);
  const hasDiscrete = !isBlank(env.PGHOST) && !isBlank(env.PGDATABASE) && !isBlank(env.PGUSER);
  if (isProdLike && !hasConnString && !hasDiscrete) {
    errors.push('Не задано подключение к PostgreSQL: нужен DATABASE_URL либо PGHOST/PGDATABASE/PGUSER.');
  }

  // --- Публичные URL ---
  // Нужны для capability-ссылок на документы и для return_url YooKassa.
  // Без них ресторан получил бы ссылку в никуда.
  if (isProdLike && isBlank(env.PUBLIC_BACKEND_URL)) {
    errors.push('PUBLIC_BACKEND_URL обязателен: без него capability-ссылки на документы и return URL некуда вести.');
  }
  for (const name of ['PUBLIC_BACKEND_URL', 'PUBLIC_FRONTEND_URL']) {
    const value = env[name];
    if (isBlank(value)) continue;
    if (isProdLike && !/^https:\/\//i.test(value)) {
      errors.push(`${name} в ${mode} обязан использовать https://.`);
    }
    if (/localhost|127\.0\.0\.1/i.test(value) && isProdLike) {
      errors.push(`${name} указывает на localhost — это недопустимо в ${mode}.`);
    }
  }

  // --- HQ session/auth ---
  //
  // HQ_SESSION_SECRET НЕ обязателен сам по себе. В фактической архитектуре
  // проекта HQ обслуживает отдельный сервис (hqtest.yaam.su), а публичный
  // API-бэкенд (api-pg.yaam.su) раздел HQ не монтирует вовсе — и это
  // сознательное решение, а не недоделка. Требовать секрет там, где HQ не
  // отдаётся, значит заставлять заводить credentials ради формальности.
  //
  // Правило: отсутствует — HQ выключен, это предупреждение. Задан — обязан
  // быть настоящим секретом достаточной длины.
  if (isProdLike) {
    if (isBlank(env.HQ_SESSION_SECRET)) {
      warnings.push('HQ_SESSION_SECRET не задан — раздел HQ на этом сервисе не будет доступен.');
    } else {
      if (String(env.HQ_SESSION_SECRET).length < 32) {
        errors.push('HQ_SESSION_SECRET короче 32 символов.');
      }
      if (looksLikePlaceholder(env.HQ_SESSION_SECRET)) {
        errors.push('HQ_SESSION_SECRET выглядит как заглушка, а не как секрет.');
      }
    }
  }
  if (mode === 'production' && !isBlank(env.HQ_LOGIN_RATE_LIMIT_MAX)) {
    warnings.push('HQ_LOGIN_RATE_LIMIT_MAX переопределён в production — это тестовый override.');
  }

  // --- Платежи ---
  const provider = env.PAYMENT_PROVIDER;
  if (!isBlank(provider) && !['mock', 'yookassa'].includes(provider)) {
    errors.push('PAYMENT_PROVIDER допускает только "mock" или "yookassa".');
  }
  if (mode === 'production' && provider !== 'yookassa') {
    // Главная проверка всего модуля: production на mock-провайдере означал бы
    // приём настоящих заказов без настоящей оплаты.
    errors.push('В production PAYMENT_PROVIDER обязан быть "yookassa": mock-провайдер не принимает реальных денег.');
  }
  if (provider === 'yookassa') {
    if (isBlank(env.YOOKASSA_SHOP_ID) || isBlank(env.YOOKASSA_SECRET_KEY)) {
      errors.push('PAYMENT_PROVIDER=yookassa требует YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.');
    }
    // Live остаётся заблокированным до отдельного разрешения — то же правило,
    // что и в самом провайдере, но проверенное ДО старта.
    if (env.YOOKASSA_ENV !== 'sandbox') {
      errors.push('YOOKASSA_ENV=sandbox обязателен: live-режим намеренно заблокирован до отдельного этапа.');
    }
    if (!isBlank(env.YOOKASSA_SECRET_KEY) && !String(env.YOOKASSA_SECRET_KEY).startsWith('test_')) {
      errors.push('YOOKASSA_SECRET_KEY должен быть тестовым ключом (префикс test_), пока live не разрешён.');
    }
  }
  // Staging не имеет права работать боевыми ключами даже случайно.
  if (mode === 'staging' && !isBlank(env.YOOKASSA_SECRET_KEY)
      && String(env.YOOKASSA_SECRET_KEY).startsWith('live_')) {
    errors.push('В staging обнаружен боевой ключ YooKassa (live_). Staging обязан работать на песочнице.');
  }
  // Dev-маршрут подтверждения оплаты. В production запрещён безусловно.
  //
  // В STAGING он разрешён при mock-провайдере — и это не послабление, а уже
  // существующее и протестированное решение проекта (см. validateAppEnv в
  // services/postgresql/app.js): именно так staging проверяет прохождение
  // заказа по статусам, не трогая реальные деньги. Запретить его здесь
  // значило бы сломать основной smoke-сценарий staging.
  if (env.ENABLE_DEV_PAYMENT_ROUTES === 'true') {
    if (mode === 'production') {
      errors.push('ENABLE_DEV_PAYMENT_ROUTES=true недопустим в production ни при каких условиях.');
    } else if (mode === 'staging' && provider !== 'mock') {
      errors.push('ENABLE_DEV_PAYMENT_ROUTES=true в staging допустим только с PAYMENT_PROVIDER=mock.');
    }
  }

  // --- Telegram ---
  if (mode === 'staging' && !isBlank(env.TELEGRAM_BOT_TOKEN) && isBlank(env.TELEGRAM_STAGING_ACK)) {
    // Staging с настоящим ботом разослал бы сообщения настоящим ресторанам.
    errors.push(
      'В staging задан TELEGRAM_BOT_TOKEN без TELEGRAM_STAGING_ACK=1. '
      + 'Подтвердите, что это ТЕСТОВЫЙ бот и тестовые группы, иначе уведомления уйдут реальным ресторанам.',
    );
  }
  if (mode === 'production' && isBlank(env.TELEGRAM_BOT_TOKEN)) {
    warnings.push('TELEGRAM_BOT_TOKEN не задан — уведомления ресторанам работать не будут.');
  }

  // --- Выплаты ---
  if (mode === 'production' && env.PAYOUT_PROVIDER === 'tbank' && isBlank(env.TBANK_ACK)) {
    errors.push('Реальный провайдер выплат требует явного подтверждения TBANK_ACK.');
  }

  // --- Фискализация ---
  if (!isBlank(env.FISCAL_PROVIDER) && !['mock', 'none'].includes(env.FISCAL_PROVIDER)) {
    errors.push('FISCAL_PROVIDER: реальные провайдеры пока не поддерживаются, допустимы "mock" или "none".');
  }
  if (mode === 'production') {
    warnings.push('Онлайн-касса не подключена: фискальные чеки не отправляются (BLOCKED LEGAL).');
  }

  // --- Proxy / HTTPS ---
  if (isProdLike && isBlank(env.TRUST_PROXY)) {
    errors.push(
      'TRUST_PROXY обязателен за reverse proxy: иначе все клиенты выглядят как один IP '
      + 'и rate limit защищает от всех сразу или ни от кого.',
    );
  }
  if (!isBlank(env.TRUST_PROXY) && String(env.TRUST_PROXY).trim() === 'true') {
    errors.push(
      'TRUST_PROXY="true" доверяет ЛЮБОМУ X-Forwarded-For, включая подделанный клиентом. '
      + 'Укажите конкретное значение, например "loopback" или "1".',
    );
  }

  // --- Логирование ---
  if (!isBlank(env.LOG_LEVEL) && !['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL)) {
    errors.push('LOG_LEVEL допускает только debug, info, warn, error.');
  }
  if (mode === 'production' && env.LOG_LEVEL === 'debug') {
    warnings.push('LOG_LEVEL=debug в production — повышенный риск попадания лишних данных в логи.');
  }

  // --- Scheduler ---
  for (const name of ['SCHEDULER_INTERVAL_MS', 'ORDER_TIMEOUT_INTERVAL_MS', 'WEEKLY_SETTLEMENT_INTERVAL_MS']) {
    if (!isBlank(env[name]) && !(Number(env[name]) > 0)) {
      errors.push(`${name} должен быть положительным числом.`);
    }
  }

  // --- Демо-данные ---
  if (isProdLike && env.SEED_DEMO_DATA === 'true') {
    errors.push('SEED_DEMO_DATA=true недопустим в staging/production: демо-данные не должны попадать в реальную базу.');
  }

  return { mode, errors, warnings };
}

// Строгая проверка: бросает при любой ошибке. Сообщение содержит ТОЛЬКО
// имена переменных и суть проблемы — ни одного значения секрета.
function assertEnv(env = process.env, { logger = console } = {}) {
  const { mode, errors, warnings } = inspectEnv(env);
  for (const w of warnings) logger.warn(`[config] предупреждение (${mode}): ${w}`);
  if (errors.length > 0) {
    throw new Error(
      `[config] конфигурация окружения (${mode}) не позволяет запуск:\n`
      + errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return { mode, warnings };
}

module.exports = { MODES, MODE_ALIASES, resolveMode, inspectEnv, assertEnv, looksLikePlaceholder };
