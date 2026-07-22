'use strict';

// YAAM Production Switch — Stage 9: trust proxy / IP allowlist correctness.
//
// Найдено при подготовке деплоя: server/services/postgresql/app.js не имел
// НИКАКОЙ trust-proxy конфигурации — за реальным Nginx req.ip отражал бы
// адрес самого прокси (127.0.0.1), не клиента, делая
// isTrustedYookassaIp(req.ip) (Stage 8, routes/postgresql/api.js)
// бессмысленной проверкой. Добавлено и проверено здесь — дословно тот же
// принцип, что уже применяется в SQLite server.js (TRUST_PROXY=loopback,
// fail-closed на любое другое значение).
//
// Реальный VPS/Nginx недоступны в этом окружении (см. PDF-отчёт Stage 9) —
// эти тесты проверяют ПРИЛОЖЕНИЕ (Express trust proxy + IP-allowlist
// wiring), не саму физическую прокси-цепочку, которую невозможно
// протестировать без реального сервера.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_trust_proxy_stage9_test';

let cluster;
let db;

before(async () => {
  process.env.PAYMENT_PROVIDER = 'yookassa';
  process.env.YOOKASSA_SHOP_ID = '999996';
  process.env.YOOKASSA_SECRET_KEY = 'test_stage9_fake_secret';
  process.env.YOOKASSA_ENV = 'sandbox';
  process.env.YOOKASSA_RETURN_URL = 'https://yaam.su/return';
  process.env.YOOKASSA_WEBHOOK_URL = 'https://api-pg.yaam.su/api/webhooks/payment';
  process.env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST = 'true';

  cluster = await startEmbeddedPostgres('trust-proxy-stage9');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

async function startApp(envOverrides = {}) {
  const { createPostgresqlApp } = require('../../services/postgresql/app.js');
  const instance = createPostgresqlApp({
    port: 0,
    schedulerIntervalMs: 1_000_000,
    orderTimeoutIntervalMs: 1_000_000,
    refundReconciliationIntervalMs: 1_000_000,
    env: { ...process.env, ...envOverrides },
  });
  await instance.start();
  return instance;
}

test('A1: validateAppEnv() отклоняет некорректное значение TRUST_PROXY (fail-fast)', () => {
  const { validateAppEnv } = require('../../services/postgresql/app.js');
  assert.throws(
    () => validateAppEnv({ TRUST_PROXY: 'true' }),
    (err) => {
      assert.match(err.message, /TRUST_PROXY/);
      return true;
    }
  );
});

test('A2: validateAppEnv() отклоняет APP_ENV=production без TRUST_PROXY=loopback', () => {
  const { validateAppEnv } = require('../../services/postgresql/app.js');
  assert.throws(
    () => validateAppEnv({ APP_ENV: 'production' }),
    (err) => {
      assert.match(err.message, /TRUST_PROXY=loopback/);
      return true;
    }
  );
});

test('A3: validateAppEnv() принимает APP_ENV=production с TRUST_PROXY=loopback', () => {
  const { validateAppEnv } = require('../../services/postgresql/app.js');
  assert.doesNotThrow(() => validateAppEnv({ APP_ENV: 'production', TRUST_PROXY: 'loopback' }));
});

test('B1: без TRUST_PROXY — req.ip не доверяет X-Forwarded-For (webhook IP-гейт видит адрес сокета, не клиента)', async () => {
  const instance = await startApp({ TRUST_PROXY: undefined });
  try {
    const { port } = instance.address();
    // Подделанный X-Forwarded-For с реальным официальным диапазоном ЮKassa —
    // без trust proxy Express ИГНОРИРУЕТ этот заголовок для req.ip, поэтому
    // проверка видит адрес самого TCP-сокета (127.0.0.1 в тесте) — не
    // входит в allowlist -> 403, СПУФИНГ через заголовок не проходит.
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '77.75.156.11' },
      body: '{}',
    });
    assert.equal(res.status, 403, 'без trust proxy подделанный заголовок не должен обмануть IP-гейт');
  } finally {
    await instance.stop();
  }
});

test('B2: с TRUST_PROXY=loopback — доверенный IP из X-Forwarded-For проходит IP-гейт', async () => {
  const instance = await startApp({ TRUST_PROXY: 'loopback' });
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '77.75.156.11' },
      body: '{}',
    });
    // Прошёл IP-гейт (не 403) — дальше упал на верификации пустого тела
    // (400), что и ожидается для '{}' без обязательных полей уведомления.
    assert.notEqual(res.status, 403, 'доверенный IP из X-Forwarded-For должен пройти гейт при TRUST_PROXY=loopback');
    assert.equal(res.status, 400);
  } finally {
    await instance.stop();
  }
});

test('B3: с TRUST_PROXY=loopback — НЕдоверенный IP из X-Forwarded-For отклоняется (403)', async () => {
  const instance = await startApp({ TRUST_PROXY: 'loopback' });
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally {
    await instance.stop();
  }
});

test('B4: IP-allowlist выключен по умолчанию (YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST не задан) — недоверенный IP не блокируется гейтом', async () => {
  // enforceIpAllowlist — константа, фиксируемая при require() routes/postgresql/
  // api.js (тот же module-load-time принцип, что и у PAYMENT_PROVIDER-гейта
  // самого маршрута) — options.env, передаваемый в createPostgresqlApp(),
  // на неё НЕ влияет (она читает process.env напрямую). Чтобы честно
  // проверить "выключено по умолчанию", нужно реально убрать переменную из
  // process.env и пересобрать модуль с чистым require.cache — тот же приём,
  // что и в paymentSafetyStage8.test.js/applicationAssemblyStage7.test.js.
  const previous = process.env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST;
  delete process.env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST;
  const APP_PATH = require.resolve('../../services/postgresql/app.js');
  const API_PATH = require.resolve('../../routes/postgresql/api.js');
  delete require.cache[APP_PATH];
  delete require.cache[API_PATH];
  try {
    const { createPostgresqlApp } = require('../../services/postgresql/app.js');
    const instance = createPostgresqlApp({
      port: 0, schedulerIntervalMs: 1_000_000, orderTimeoutIntervalMs: 1_000_000,
      refundReconciliationIntervalMs: 1_000_000, env: { ...process.env, TRUST_PROXY: 'loopback' },
    });
    await instance.start();
    try {
      const { port } = instance.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' },
        body: '{}',
      });
      // Гейт выключен -> не 403 из-за IP; дальше падает на верификации тела (400).
      assert.equal(res.status, 400, 'по умолчанию (флаг не включён) IP-гейт не должен участвовать вовсе');
    } finally {
      await instance.stop();
    }
  } finally {
    if (previous === undefined) delete process.env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST;
    else process.env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST = previous;
    delete require.cache[APP_PATH];
    delete require.cache[API_PATH];
  }
});
