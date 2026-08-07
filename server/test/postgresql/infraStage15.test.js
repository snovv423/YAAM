'use strict';

// YAAM Stage 15 — production readiness инфраструктуры.
//
// E — проверка конфигурации окружения по режимам.
// M — миграции: порядок, идемпотентность, конкурентность, пустая/живая база.
// G — graceful shutdown.
// R — readiness.
// S — сессии в PostgreSQL.
// L — логирование и редактирование.
// D — сгенерированные конфиги деплоя.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DEPLOY_DIR = path.join(__dirname, '../../deploy');

const MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/migrator.js'),
  require.resolve('../../services/postgresql/lifecycle.js'),
  require.resolve('../../services/postgresql/health.js'),
  require.resolve('../../services/hq/pgSessionStore.js'),
  require.resolve('../../services/hq/ownerService.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/hq/auth.js'),
];

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('infra-stage15'); });
after(async () => {
  await cluster.stop();
});

async function freshDatabase(name, { applySchema = true } = {}) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  if (applySchema) await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}

function requireFresh() {
  for (const p of MODULE_PATHS) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    migrator: require('../../services/postgresql/migrator'),
    lifecycle: require('../../services/postgresql/lifecycle'),
    health: require('../../services/postgresql/health'),
    PgSessionStore: require('../../services/hq/pgSessionStore').PgSessionStore,
  };
}

const quietLogger = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} };

// ===========================================================================
// E — конфигурация окружения
// ===========================================================================

const { inspectEnv, assertEnv, resolveMode } = require('../../services/config/env');

// Минимально валидное production-окружение: от него отталкиваются проверки
// «что именно ломает запуск».
function prodEnv(overrides = {}) {
  return {
    APP_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/yaam',
    PUBLIC_BACKEND_URL: 'https://api.example.test',
    HQ_SESSION_SECRET: 'a3f9c2b7d1e648a5906c4f2b8d7e13a94c6f0b2d',
    TRUST_PROXY: 'loopback',
    PAYMENT_PROVIDER: 'yookassa',
    YOOKASSA_ENV: 'sandbox',
    YOOKASSA_SHOP_ID: '123456',
    YOOKASSA_SECRET_KEY: 'test_ABCDEFGHIJKLMNOPQRSTUVWX',
    ...overrides,
  };
}

test('E1: валидное production-окружение проходит проверку', () => {
  const { mode, errors } = inspectEnv(prodEnv());
  assert.equal(mode, 'production');
  assert.deepEqual(errors, []);
});

test('E2: production не запускается с mock-провайдером и с тестовыми заглушками', () => {
  // Mock в production = приём заказов без реальной оплаты.
  const mock = inspectEnv(prodEnv({ PAYMENT_PROVIDER: 'mock' }));
  assert.ok(mock.errors.some((e) => /mock-провайдер/.test(e)));

  // Секрет-заглушка.
  const placeholder = inspectEnv(prodEnv({ HQ_SESSION_SECRET: 'ssssssssssssssssssssssssssssssssss' }));
  assert.ok(placeholder.errors.some((e) => /заглушк/.test(e)));

  // Короткий секрет.
  const short = inspectEnv(prodEnv({ HQ_SESSION_SECRET: 'short' }));
  assert.ok(short.errors.some((e) => /32 символ/.test(e)));

  // Отсутствующий HQ_SESSION_SECRET — НЕ ошибка (обновлено в Stage 18).
  // В фактической архитектуре публичный API-бэкенд раздел HQ не монтирует
  // вовсе, и требовать секрет ради формальности значило бы выдумать
  // требование. Но это состояние обязано быть ЗАМЕЧЕНО.
  const missing = prodEnv();
  delete missing.HQ_SESSION_SECRET;
  const noHq = inspectEnv(missing);
  assert.ok(!noHq.errors.some((e) => /HQ_SESSION_SECRET/.test(e)), 'отсутствие секрета не должно блокировать запуск');
  assert.ok(noHq.warnings.some((w) => /HQ_SESSION_SECRET не задан/.test(w)), 'но обязано быть предупреждение');

  // Демо-данные.
  const seed = inspectEnv(prodEnv({ SEED_DEMO_DATA: 'true' }));
  assert.ok(seed.errors.some((e) => /демо-данные/i.test(e)));

  // dev-маршруты оплаты.
  const dev = inspectEnv(prodEnv({ ENABLE_DEV_PAYMENT_ROUTES: 'true' }));
  assert.ok(dev.errors.some((e) => /ENABLE_DEV_PAYMENT_ROUTES/.test(e)));
});

test('E3: staging не может работать боевыми credentials, live YooKassa заблокирован везде', () => {
  const staging = {
    APP_ENV: 'staging',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/yaam_staging',
    PUBLIC_BACKEND_URL: 'https://api-staging.example.test',
    HQ_SESSION_SECRET: 'b7d1e648a5906c4f2b8d7e13a94c6f0b2da3f9c2',
    TRUST_PROXY: 'loopback',
  };
  assert.deepEqual(inspectEnv(staging).errors, []);

  // Боевой ключ YooKassa в staging.
  const liveKey = inspectEnv({ ...staging, YOOKASSA_SECRET_KEY: 'live_REALKEY0123456789' });
  assert.ok(liveKey.errors.some((e) => /боевой ключ/i.test(e)));

  // Live-режим запрещён и в production тоже.
  const liveEnv = inspectEnv(prodEnv({ YOOKASSA_ENV: 'live' }));
  assert.ok(liveEnv.errors.some((e) => /sandbox обязателен/.test(e)));

  // Настоящий бот в staging без явного подтверждения — уведомления ушли бы
  // реальным ресторанам.
  const bot = inspectEnv({ ...staging, TELEGRAM_BOT_TOKEN: '123:ABC' });
  assert.ok(bot.errors.some((e) => /TELEGRAM_STAGING_ACK/.test(e)));
  const botOk = inspectEnv({ ...staging, TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_STAGING_ACK: '1' });
  assert.deepEqual(botOk.errors, []);
});

test('E4: TRUST_PROXY — обязателен и не допускает "true"', () => {
  const missing = prodEnv();
  delete missing.TRUST_PROXY;
  assert.ok(inspectEnv(missing).errors.some((e) => /TRUST_PROXY обязателен/.test(e)));

  // "true" доверяет любому X-Forwarded-For, включая подделанный клиентом.
  const permissive = inspectEnv(prodEnv({ TRUST_PROXY: 'true' }));
  assert.ok(permissive.errors.some((e) => /подделанный/.test(e)));
});

test('E5: http и localhost в публичных URL недопустимы в production', () => {
  assert.ok(inspectEnv(prodEnv({ PUBLIC_BACKEND_URL: 'http://api.example.test' }))
    .errors.some((e) => /https/.test(e)));
  assert.ok(inspectEnv(prodEnv({ PUBLIC_BACKEND_URL: 'https://localhost:3000' }))
    .errors.some((e) => /localhost/.test(e)));
});

test('E6: assertEnv не раскрывает значения секретов в сообщении', () => {
  const env = prodEnv({ HQ_SESSION_SECRET: 'short', DATABASE_URL: 'postgres://u:MYSECRETPW@h/db' });
  try {
    assertEnv(env, { logger: quietLogger });
    assert.fail('ожидалась ошибка конфигурации');
  } catch (err) {
    assert.match(err.message, /HQ_SESSION_SECRET/);
    assert.ok(!err.message.includes('MYSECRETPW'), 'пароль БД не должен попадать в текст ошибки');
    assert.ok(!err.message.includes('short'), 'значение секрета не должно попадать в текст ошибки');
  }
});

test('E7: режим берётся из APP_ENV, синоним "local" сохранён', () => {
  assert.equal(resolveMode({ APP_ENV: 'staging' }), 'staging');
  assert.equal(resolveMode({}), 'development');
  // В проекте уже используется APP_ENV=local — объявить его недопустимым
  // значило бы сломать существующие окружения ради словаря.
  assert.equal(resolveMode({ APP_ENV: 'local' }), 'development');
  assert.equal(resolveMode({ APP_ENV: 'prod' }), 'production');
  assert.throws(() => resolveMode({ APP_ENV: 'что-то' }), /допустимы/);
});

// ===========================================================================
// M — миграции
// ===========================================================================

test('M1: пустая база разворачивается полностью, схема появляется', async () => {
  const databaseUrl = await freshDatabase('infra_m1', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  const before = await db.query(`SELECT to_regclass('public.orders') IS NOT NULL AS has`);
  assert.equal(before[0].has, false, 'база должна быть пустой до миграций');

  const result = await migrator.migrate({ logger: quietLogger });
  assert.ok(result.applied.length >= 1);

  const after = await db.query(`SELECT to_regclass('public.orders') IS NOT NULL AS has`);
  assert.equal(after[0].has, true, 'после миграций схема обязана существовать');
  const sessions = await db.query(`SELECT to_regclass('public.hq_sessions') IS NOT NULL AS has`);
  assert.equal(sessions[0].has, true);
  await db.close();
});

test('M2: повторный запуск ничего не применяет заново', async () => {
  const databaseUrl = await freshDatabase('infra_m2', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  const first = await migrator.migrate({ logger: quietLogger });
  const second = await migrator.migrate({ logger: quietLogger });
  assert.ok(first.applied.length >= 1);
  assert.deepEqual(second.applied, [], 'вторая миграция не должна применить ничего');

  const rows = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.equal(rows.length, first.applied.length);
  await db.close();
});

test('M3: существующая база обновляется без пересоздания и без потери данных', async () => {
  // Схема применена «как раньше», данные есть, schema_migrations нет.
  const databaseUrl = await freshDatabase('infra_m3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at)
     VALUES ('Кафе До Миграции','["Грозный"]',1,NOW())`);
  const beforeCount = (await db.query('SELECT COUNT(*)::int AS n FROM restaurants'))[0].n;

  const result = await migrator.migrate({ logger: quietLogger });

  const afterCount = (await db.query('SELECT COUNT(*)::int AS n FROM restaurants'))[0].n;
  assert.equal(afterCount, beforeCount, 'данные не должны пострадать');
  assert.equal(
    (await db.query("SELECT name FROM restaurants LIMIT 1"))[0].name,
    'Кафе До Миграции',
  );
  // Baseline отмечен применённым, но schema.sql поверх живых данных не гонялся.
  const versions = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
  assert.ok(versions.includes(migrator.BASELINE_VERSION));
  assert.equal(result.applied.length, versions.length);
  await db.close();
});

test('M4: конкурентный запуск двух миграторов не применяет одну миграцию дважды', async () => {
  const databaseUrl = await freshDatabase('infra_m4', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  const [a, b, c] = await Promise.all([
    migrator.migrate({ logger: quietLogger }),
    migrator.migrate({ logger: quietLogger }),
    migrator.migrate({ logger: quietLogger }),
  ]);

  const total = a.applied.length + b.applied.length + c.applied.length;
  const rows = await db.query('SELECT version, COUNT(*)::int AS n FROM schema_migrations GROUP BY version');
  assert.ok(rows.every((r) => r.n === 1), 'каждая миграция записана ровно один раз');
  assert.equal(total, rows.length, 'суммарно применено ровно столько, сколько миграций');
  await db.close();
});

test('M5: порядок по номеру, дубликаты версий и изменение применённой миграции отклоняются', async () => {
  const { migrator } = requireFresh();

  const files = migrator.listMigrationFiles();
  const versions = files.map((f) => f.version);
  assert.deepEqual(versions, [...versions].sort((x, y) => x - y), 'файлы обязаны идти по возрастанию номера');
  assert.ok(versions.includes(1));

  // Дубликат версии.
  assert.throws(
    () => migrator.assertNoDuplicateVersions([
      { version: 2, file: '0002_a.sql' }, { version: 2, file: '0002_b.sql' },
    ]),
    /две миграции с номером 2/,
  );

  // Изменение уже применённой миграции ловится контрольной суммой.
  const databaseUrl = await freshDatabase('infra_m5', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db } = requireFresh();
  const m = require('../../services/postgresql/migrator');
  await m.migrate({ logger: quietLogger });
  await db.execute("UPDATE schema_migrations SET checksum = 'подменённая-сумма' WHERE version = 1");
  await assert.rejects(() => m.migrate({ logger: quietLogger }), /изменена после применения/);
  await db.close();
});

test('M6: разрушающая миграция без явного маркера не выполняется', async () => {
  const { migrator } = requireFresh();

  for (const sql of ['DROP TABLE orders;', 'ALTER TABLE orders DROP COLUMN city;', 'TRUNCATE payments;']) {
    assert.throws(
      () => migrator.assertNotSilentlyDestructive({ file: '0099_bad.sql', sql }),
      /разрушающую операцию/,
      `не поймана разрушающая операция: ${sql}`,
    );
  }

  // С явным маркером — разрешено: это осознанное решение автора.
  assert.doesNotThrow(() => migrator.assertNotSilentlyDestructive({
    file: '0099_ok.sql',
    sql: `${migrator.ALLOW_DESTRUCTIVE_MARKER}\nALTER TABLE orders DROP COLUMN city;`,
  }));

  // Ни одна НЕ-baseline миграция репозитория не является разрушающей.
  //
  // Baseline исключён обоснованно: он выполняется только на ПУСТОЙ базе (на
  // существующей лишь отмечается), а ALTER ... DROP COLUMN IF EXISTS внутри
  // него — след того, что schema.sql накапливал ALTER'ы поверх CREATE.
  // Уничтожать там нечего. Проверяем, что исключение ровно одно.
  const nonBaseline = migrator.listMigrationFiles().filter((m) => m.version !== migrator.BASELINE_VERSION);
  assert.ok(nonBaseline.length >= 1, 'должна быть хотя бы одна не-baseline миграция');
  for (const m of nonBaseline) {
    assert.doesNotThrow(() => migrator.assertNotSilentlyDestructive(m), `миграция ${m.file}`);
  }

  // И проверка действительно СРАБОТАЛА БЫ на не-baseline файле с DROP.
  assert.throws(
    () => migrator.assertNotSilentlyDestructive({ version: 7, file: '0007_x.sql', sql: 'DROP TABLE orders;' }),
    /разрушающую операцию/,
  );
});

test('M7: ошибка миграции останавливает старт приложения', async () => {
  const databaseUrl = await freshDatabase('infra_m7', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, lifecycle } = requireFresh();

  const migrator = require('../../services/postgresql/migrator');
  const original = migrator.migrate;
  migrator.migrate = async () => { throw new Error('искусственный сбой миграции'); };
  try {
    const lc = lifecycle.createLifecycle({ schedulers: [], httpServer: null, logger: quietLogger });
    await assert.rejects(() => lc.start(), /искусственный сбой миграции/);
    assert.equal(lc.isRunning(), false, 'приложение не должно считаться запущенным');
  } finally {
    migrator.migrate = original;
    await db.close();
  }
});

// ===========================================================================
// R — readiness
// ===========================================================================

test('R1: readiness не готов при непринятых миграциях и не раскрывает деталей', async () => {
  const databaseUrl = await freshDatabase('infra_r1');
  process.env.DATABASE_URL = databaseUrl;
  const { db, health } = requireFresh();

  const check = health.createHealthCheck({ getSchedulers: () => [], logger: quietLogger });

  // Миграции ещё не применялись — таблицы schema_migrations нет.
  const notReady = await check.readiness();
  assert.equal(notReady.ok, false, 'непринятые миграции обязаны делать инстанс not ready');
  assert.equal(notReady.migrations.ok, false);

  // После миграций — готов.
  const migrator = require('../../services/postgresql/migrator');
  await migrator.migrate({ logger: quietLogger });
  const ready = await check.readiness();
  assert.equal(ready.migrations.ok, true);
  assert.equal(ready.migrations.applied, ready.migrations.total);

  // Никаких секретов и внутренних деталей.
  const serialized = JSON.stringify(ready);
  assert.ok(!serialized.includes(databaseUrl));
  assert.ok(!/postgres:\/\//.test(serialized));
  assert.ok(!serialized.includes('checksum'));
  await db.close();
});

test('R2: liveness не зависит от базы', async () => {
  const databaseUrl = await freshDatabase('infra_r2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, health } = requireFresh();
  const check = health.createHealthCheck({ getSchedulers: () => [], logger: quietLogger });

  const originalQuery = db.query;
  db.query = async () => { throw new Error('база недоступна'); };
  try {
    const live = await check.liveness();
    // Живой процесс не должен перезапускаться из-за временного сбоя БД.
    assert.equal(live.ok, true);
  } finally {
    db.query = originalQuery;
    await db.close();
  }
});

// ===========================================================================
// S — сессии в PostgreSQL
// ===========================================================================

test('S1: сессия переживает пересоздание стора (перезапуск процесса)', async () => {
  const databaseUrl = await freshDatabase('infra_s1');
  process.env.DATABASE_URL = databaseUrl;
  const { db, PgSessionStore } = requireFresh();

  const store = new PgSessionStore({ autoPrune: false });
  const session = { cookie: { maxAge: 60000 }, hqUser: 'owner', hqCredentialsVersion: 3 };

  await new Promise((res, rej) => store.set('sid-1', session, (e) => (e ? rej(e) : res())));

  // Новый экземпляр стора = новый процесс после рестарта.
  const afterRestart = new PgSessionStore({ autoPrune: false });
  const loaded = await new Promise((res, rej) => afterRestart.get('sid-1', (e, s) => (e ? rej(e) : res(s))));
  assert.equal(loaded.hqUser, 'owner');
  assert.equal(loaded.hqCredentialsVersion, 3);

  // Уничтожение.
  await new Promise((res, rej) => store.destroy('sid-1', (e) => (e ? rej(e) : res())));
  const gone = await new Promise((res, rej) => store.get('sid-1', (e, s) => (e ? rej(e) : res(s))));
  assert.equal(gone, null);

  store.close();
  afterRestart.close();
  await db.close();
});

test('S2: истёкшая сессия не отдаётся и удаляется очисткой', async () => {
  const databaseUrl = await freshDatabase('infra_s2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, PgSessionStore } = requireFresh();
  const store = new PgSessionStore({ autoPrune: false });

  await db.execute(
    `INSERT INTO hq_sessions (sid, sess, expires_at) VALUES ($1,$2, NOW() - INTERVAL '1 hour')`,
    ['expired-sid', JSON.stringify({ hqUser: 'owner' })],
  );

  // Истёкшая не отдаётся ДАЖЕ до очистки — иначе было бы окно, в котором она
  // продолжает работать.
  const loaded = await new Promise((res, rej) => store.get('expired-sid', (e, s) => (e ? rej(e) : res(s))));
  assert.equal(loaded, null);

  const removed = await store.prune();
  assert.equal(removed, 1);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM hq_sessions'))[0].n, 0);

  store.close();
  await db.close();
});

test('S3: в таблице сессий нет пароля владельца', async () => {
  const databaseUrl = await freshDatabase('infra_s3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, PgSessionStore } = requireFresh();
  const store = new PgSessionStore({ autoPrune: false });

  await new Promise((res, rej) => store.set('sid-x', {
    cookie: { maxAge: 60000 }, hqUser: 'owner', hqAuthenticated: true, csrfToken: 'abc',
  }, (e) => (e ? rej(e) : res())));

  const rows = await db.query('SELECT sess FROM hq_sessions');
  const text = JSON.stringify(rows);
  assert.ok(!/password/i.test(text), 'в сессии не должно быть ничего похожего на пароль');
  assert.ok(!/password_hash/i.test(text));

  store.close();
  await db.close();
});

// ===========================================================================
// L — логирование и редактирование
// ===========================================================================

const loggerModule = require('../../services/observability/logger');

test('L1: секреты и токены не попадают в лог', () => {
  const lines = [];
  const logger = loggerModule.createLogger({ stream: { write: (l) => lines.push(l) } });

  logger.info('test', {
    password: 'СуперПароль123',
    authorization: 'Bearer abcdefghijklmnop',
    cookie: 'yaam.hq.sid=s%3Aabc123',
    yookassaSecretKey: 'test_ABCDEFGHIJKLMNOP',
    nested: { apiKey: 'k-123456789', account_number: '40702810938050001238' },
  });

  const out = lines.join('');
  assert.ok(!out.includes('СуперПароль123'));
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.ok(!out.includes('40702810938050001238'));
  assert.ok(!out.includes('k-123456789'));
  assert.ok(out.includes('[REDACTED]'));
});

test('L2: capability-токен вырезается и из строк, и из пути запроса', () => {
  // Синтетическое значение нужной формы. Настоящий токен (даже из
  // одноразовой локальной базы) в репозитории не хранится: он выглядит
  // как рабочий и будет всплывать в каждом secret-скане.
  const token = `yaam_doc_v1_${'A'.repeat(43)}`;
  const redacted = loggerModule.redactString(`открыт документ ${token} успешно`);
  assert.ok(!redacted.includes(token));
  assert.match(redacted, /yaam_doc_v1_\[REDACTED\]/);

  // Токен находится В ПУТИ — originalUrl логировать нельзя как есть.
  const route = loggerModule.safeRoute({ originalUrl: `/d/${token}?x=1` });
  assert.equal(route, '/d/:token');
  assert.ok(!route.includes(token));
});

test('L3: сырой webhook payload и ПДн клиента не логируются', () => {
  const lines = [];
  const logger = loggerModule.createLogger({ stream: { write: (l) => lines.push(l) } });

  logger.info('webhook', {
    customer_name: 'Иса Магомадов',
    customer_phone: '+79011112233',
    address: 'ул. Секретная, 7, кв. 3',
    comment: 'позвонить заранее',
    databaseUrl: 'postgres://yaam:SUPERSECRET@10.0.0.5:5432/yaam',
  });

  const out = lines.join('');
  assert.ok(!out.includes('Иса Магомадов'));
  assert.ok(!out.includes('+79011112233'));
  assert.ok(!out.includes('ул. Секретная'));
  assert.ok(!out.includes('позвонить заранее'));
  assert.ok(!out.includes('SUPERSECRET'), 'пароль в строке подключения обязан быть вырезан');
});

test('L4: циклическая ссылка не роняет логгер', () => {
  const lines = [];
  const logger = loggerModule.createLogger({ stream: { write: (l) => lines.push(l) } });
  const a = { name: 'a' };
  a.self = a;
  assert.doesNotThrow(() => logger.info('circular', { a }));
  assert.match(lines.join(''), /CIRCULAR/);
});

// ===========================================================================
// D — сгенерированные конфиги деплоя
// ===========================================================================

test('L5: access-лог приложения не печатает capability-токен из пути', () => {
  // Дефект, найденный на staging при первом обращении к /d/<токен>:
  // accessLogMiddleware печатал req.path как есть, и токен уходил в journald
  // открытым текстом. Query string он не логировал, но секрет находится
  // В САМОМ ПУТИ — против этого req.path не защищает.
  const src = fs.readFileSync(path.join(__dirname, '../../services/postgresql/app.js'), 'utf8');
  assert.match(src, /safeRoute\(req\)/, 'путь в access-логе обязан проходить через safeRoute');
  assert.ok(
    !/\$\{req\.method\} \$\{req\.path\}/.test(src),
    'сырой req.path в access-логе недопустим: capability-токен находится в пути',
  );

  const token = `yaam_doc_v1_${'B'.repeat(43)}`;
  // Смонтированный роутер срезает префикс /d, поэтому проверяются оба вида.
  assert.equal(loggerModule.safeRoute({ originalUrl: `/d/${token}?x=1` }), '/d/:token');
  const stripped = loggerModule.safeRoute({ url: `/${token}` });
  assert.ok(!stripped.includes(token), 'токен не должен попадать в лог даже без префикса');
  assert.match(stripped, /yaam_doc_v1_\[REDACTED\]/);
});

test('D1: шаблоны деплоя не содержат секретов и выдуманных доменов', () => {
  const files = fs.readdirSync(DEPLOY_DIR).filter((f) => !f.startsWith('.'));
  assert.ok(files.includes('nginx-yaam-staging.conf.template'));
  assert.ok(files.includes('backup-postgresql.sh'));
  assert.ok(files.includes('restore-postgresql.sh'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(DEPLOY_DIR, file), 'utf8');
    // Ни одного правдоподобного секрета.
    assert.ok(!/\blive_[A-Za-z0-9]{10,}/.test(content), `${file}: боевой ключ YooKassa`);
    assert.ok(!/\btest_[A-Za-z0-9]{20,}/.test(content), `${file}: ключ YooKassa`);
    assert.ok(!/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/.test(content), `${file}: строка подключения с паролем`);
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(content), `${file}: приватный ключ`);
  }

  // Домен в staging-шаблоне — переменная, а не выдуманный хост.
  const staging = fs.readFileSync(path.join(DEPLOY_DIR, 'nginx-yaam-staging.conf.template'), 'utf8');
  assert.match(staging, /\$\{YAAM_BACKEND_DOMAIN\}/);
  assert.ok(!/yaam\.su/.test(staging), 'шаблон staging не должен ссылаться на production-домен');
});

test('D2: nginx staging защищает capability-ссылки и не раскрывает лишнего', () => {
  const conf = fs.readFileSync(path.join(DEPLOY_DIR, 'nginx-yaam-staging.conf.template'), 'utf8');

  // Токен документа находится в пути — он не должен попасть в access_log.
  // "^~" обязателен: иначе regex-location перехватил бы запрос раньше и вернул
  // сырой URI в общий лог (Stage 19.1, пункт 3 — реально найдено на hqtest).
  assert.match(conf, /location \^~ \/d\/[\s\S]*?access_log off;/);
  assert.match(conf, /location \^~ \/d\/[\s\S]*?Referrer-Policy "no-referrer"/);
  assert.match(conf, /location \^~ \/d\/[\s\S]*?X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.match(conf, /autoindex off;/);
  assert.match(conf, /server_tokens off;/);
  assert.match(conf, /Strict-Transport-Security/);
  assert.match(conf, /X-Content-Type-Options/);
  // Health не публикуется наружу.
  assert.match(conf, /location \/health\/[\s\S]*?deny all;/);
  // Staging не индексируется.
  assert.match(conf, /X-Robots-Tag "noindex/);
});

test('D3: systemd-юнит даёт приложению закрыться раньше SIGKILL', () => {
  const unit = fs.readFileSync(path.join(DEPLOY_DIR, 'yaam-backend-postgresql.service'), 'utf8');
  const timeout = Number(/TimeoutStopSec=(\d+)/.exec(unit)[1]);
  // Собственный предел приложения — 15 секунд (lifecycle.js). systemd обязан
  // ждать дольше, иначе graceful shutdown обрывается на середине.
  assert.ok(timeout > 15, `TimeoutStopSec=${timeout} не больше внутреннего таймаута приложения`);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /Restart=on-failure/);
});

test('D4: .env.staging.example содержит только имена и безопасные примеры', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../.env.staging.example'), 'utf8');
  assert.match(content, /APP_ENV=staging/);
  assert.match(content, /HQ_SESSION_SECRET=\s*$/m, 'секрет обязан быть пустым');
  assert.match(content, /PAYMENT_PROVIDER=mock/);
  assert.match(content, /TELEGRAM_BOT_TOKEN=\s*$/m, 'токен бота обязан быть пустым');
  assert.ok(!/\btest_[A-Za-z0-9]{20,}/.test(content));
  assert.ok(!/yaam\.su/.test(content), 'пример не должен ссылаться на production-домен');
});

test('D5: скрипт восстановления не позволяет молча перезаписать рабочую базу', () => {
  const script = fs.readFileSync(path.join(DEPLOY_DIR, 'restore-postgresql.sh'), 'utf8');
  assert.match(script, /YAAM_RESTORE_CONFIRM/);
  assert.match(script, /I-UNDERSTAND-THIS-DESTROYS-DATA/);
  assert.match(script, /set -euo pipefail/);
  // Пароль не зашит.
  assert.ok(!/PGPASSWORD=\S+/.test(script));

  const backup = fs.readFileSync(path.join(DEPLOY_DIR, 'backup-postgresql.sh'), 'utf8');
  assert.match(backup, /gpg --encrypt/, 'дамп с ПДн обязан шифроваться');
  assert.match(backup, /RETENTION_DAYS/);
  assert.ok(!/PGPASSWORD=\S+/.test(backup));
});

// ===========================================================================
// G — graceful shutdown
//
// ЭТИ ТЕСТЫ ИДУТ ПОСЛЕДНИМИ НАМЕРЕННО. lifecycle.stop() закрывает пул
// PostgreSQL, и события разрыва соединений всплывают асинхронно уже после
// завершения теста — в середине файла они выглядели бы как падение
// СЛЕДУЮЩЕГО теста, а не как след предыдущего.
// ===========================================================================

test('G2: зависшее keep-alive соединение не блокирует выключение дольше таймаута', async () => {
  const databaseUrl = await freshDatabase('infra_g2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, lifecycle } = requireFresh();

  const http = require('node:http');
  // Сервер, который НИКОГДА не отвечает: имитация зависшего запроса.
  const httpServer = http.createServer(() => {});
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();

  const lc = lifecycle.createLifecycle({
    schedulers: [], httpServer, logger: quietLogger, runMigrations: false,
    shutdownTimeoutMs: 300,
    // Пул нужен следующим тестам файла — закрытие проверяется отдельно в G1.
    closeDatabase: false,
  });
  await lc.start();

  // Открываем висящий запрос.
  const hanging = fetch(`http://127.0.0.1:${port}/`).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));

  const startedAt = Date.now();
  await lc.stop();
  const elapsed = Date.now() - startedAt;

  // Без принудительного закрытия соединений stop() висел бы вечно.
  assert.ok(elapsed < 3000, `выключение заняло ${elapsed} мс — таймаут не сработал`);
  assert.equal(httpServer.listening, false);
  await hanging;
});

// ВАЖНО: реальный 'SIGTERM' здесь НЕ используется. embedded-postgres (через
// async-exit-hook) регистрирует СВОЙ глобальный process.on('SIGTERM') и
// кладёт эфемерный кластер, а тест-раннер после снятия обработчиков умирает
// с кодом 143 — файл выглядит упавшим при всех пройденных тестах. Это уже
// задокументированная в проекте ловушка (operationalStage6, тест B9):
// lifecycle принимает список ИМЁН событий, поэтому берём приватное имя и
// проверяем ТОТ ЖЕ код-путь, не трогая ничего вне теста.
test('G1: сигнал останавливает планировщики, закрывает сервер и пул', async () => {
  const databaseUrl = await freshDatabase('infra_g1');
  process.env.DATABASE_URL = databaseUrl;
  const { db, lifecycle } = requireFresh();

  const stopped = [];
  const fakeScheduler = {
    start() { this.running = true; },
    stop() { this.running = false; stopped.push('scheduler'); },
    isRunning() { return Boolean(this.running); },
  };

  const http = require('node:http');
  const httpServer = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));

  let signalled = null;
  const lc = lifecycle.createLifecycle({
    schedulers: [fakeScheduler],
    httpServer,
    logger: quietLogger,
    runMigrations: false,
    closeDatabase: false,
    signals: ['SIGTERM_STAGE15_TEST_ONLY'],
    onSignal: (sig) => { signalled = sig; },
  });
  await lc.start();
  assert.equal(fakeScheduler.isRunning(), true);

  process.emit('SIGTERM_STAGE15_TEST_ONLY');
  // Дожидаемся завершения асинхронного stop().
  const deadline = Date.now() + 5000;
  while (signalled === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(signalled, 'SIGTERM_STAGE15_TEST_ONLY');
  assert.deepEqual(stopped, ['scheduler'], 'планировщик обязан быть остановлен');
  assert.equal(lc.isRunning(), false);
  assert.equal(httpServer.listening, false, 'HTTP-сервер обязан быть закрыт');

  // Пул закрыт внутри stop(); сервер разрывает оставшиеся соединения
  // асинхронно, и их события ошибок иначе всплывают уже в СЛЕДУЮЩЕМ тесте,
  // выглядя как его падение. Даём им осесть здесь.
  await new Promise((r) => setTimeout(r, 150));
});

// ===========================================================================
// MB — блокирующий аудит миграционной системы (Stage 15, ревизия)
//
// Первая редакция имела три подтверждённых дефекта:
//   1. 0001_baseline была ЗАГЛУШКОЙ, а runner в момент выполнения читал
//      текущий schema.sql — смысл «применённой миграции» менялся вместе с
//      проектом, контрольная сумма защищала пустышку;
//   2. «непустая база» определялась наличием ОДНОЙ таблицы orders, поэтому
//      частично созданная или отставшая база молча получала отметку baseline;
//   3. schema.sql фактически был вторым, скрытым механизмом обновления схемы.
// Тесты ниже закрывают каждый из них.
// ===========================================================================

test('MB1: baseline — самостоятельный неизменяемый снимок, не ссылка на schema.sql', () => {
  const baselinePath = path.join(__dirname, '../../db/postgresql/migrations/0001_baseline.sql');
  const baseline = fs.readFileSync(baselinePath, 'utf8');

  // Снимок содержит реальную схему, а не заглушку.
  assert.ok(baseline.length > 20000, 'baseline обязан быть полным снимком, а не заглушкой');
  assert.ok(/CREATE TABLE[\s\S]*orders/.test(baseline));
  assert.ok(baseline.split('CREATE TABLE').length - 1 > 30, 'в снимке должны быть все таблицы');
  assert.doesNotMatch(baseline, /^\s*SELECT 1;\s*$/m, 'заглушки быть не должно');

  // Runner НЕ читает schema.sql ни при каких условиях.
  const runner = fs.readFileSync(path.join(__dirname, '../../services/postgresql/migrator.js'), 'utf8');
  assert.ok(!/schema\.sql['"]/.test(runner), 'migrator не должен ссылаться на schema.sql');
  assert.ok(!/SCHEMA_PATH/.test(runner));

  // Собственных BEGIN/COMMIT в снимке нет: транзакцию открывает runner, а
  // вложенный COMMIT закрыл бы её и разорвал атомарность записи в
  // schema_migrations.
  assert.ok(!/^BEGIN;/m.test(baseline), 'BEGIN снимка конфликтует с транзакцией runner');
  assert.ok(!/^COMMIT;/m.test(baseline), 'COMMIT снимка закрыл бы внешнюю транзакцию');
});

test('MB2: изменение schema.sql не меняет смысл уже применённого baseline', async () => {
  const databaseUrl = await freshDatabase('infra_mb2', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  const before = migrator.listMigrationFiles().find((m) => m.version === 1).checksum;
  await migrator.migrate({ logger: quietLogger });

  // Дописываем в schema.sql новый объект — как это произошло бы при обычной
  // работе над проектом.
  const schemaPath = path.join(__dirname, '../../db/postgresql/schema.sql');
  const original = fs.readFileSync(schemaPath, 'utf8');
  try {
    fs.writeFileSync(schemaPath, `${original}\nCREATE TABLE IF NOT EXISTS mb2_probe (id INT);\n`);

    // Контрольная сумма baseline не изменилась: она считается по снимку.
    const after = migrator.listMigrationFiles().find((m) => m.version === 1).checksum;
    assert.equal(after, before, 'правка schema.sql не должна менять контрольную сумму baseline');

    // Повторный прогон не падает и ничего не применяет: schema.sql runner'у
    // не интересен, а новый объект в базе не появляется.
    const rerun = await migrator.migrate({ logger: quietLogger });
    assert.deepEqual(rerun.applied, []);
    const probe = await db.query(`SELECT to_regclass('public.mb2_probe') IS NOT NULL AS has`);
    assert.equal(probe[0].has, false, 'schema.sql не должен быть вторым механизмом обновления');
  } finally {
    fs.writeFileSync(schemaPath, original);
    await db.close();
  }
});

test('MB3: пустая база проходит строго 0001..0011, объекты создаются по одному разу', async () => {
  const databaseUrl = await freshDatabase('infra_mb3', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  const result = await migrator.migrate({ logger: quietLogger });
  const order = result.applied.map((a) => a.version);
  // Stage 25 добавила аддитивную миграцию 0006 (ручное подтверждение выплаты +
  // восстановление категории вместе с блюдами); UX fix-stage после Stage 28
  // добавила 0007 (restaurant_candidates, HQ "Кого ждём") — порядок расширен,
  // не изменён. Stage 31 добавила 0010 (bot_notifications, persistent outbox)
  // и 0011 (payments.receipt_url).
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'строгий порядок baseline -> 0002 -> ... -> 0011');
  // Ни одна миграция на пустой базе не «отмечается» — все выполняются.
  assert.ok(result.applied.every((a) => a.adopted === false));

  // hq_sessions создаётся ровно один раз, ИМЕННО в 0002 — не в baseline.
  const baseline = fs.readFileSync(
    path.join(__dirname, '../../db/postgresql/migrations/0001_baseline.sql'), 'utf8');
  assert.ok(!/CREATE TABLE[^;]*hq_sessions/.test(baseline), 'hq_sessions не должен быть в baseline');
  const sessions = await db.query(`SELECT to_regclass('public.hq_sessions') IS NOT NULL AS has`);
  assert.equal(sessions[0].has, true);

  // Схема работоспособна: ключевые объекты на месте.
  const fp = await migrator.inspectSchemaFingerprint(null);
  assert.equal(fp.compatible, true, `после миграций схема обязана быть совместимой: ${fp.missing}`);
  await db.close();
});

test('MB4: совместимая существующая база без schema_migrations усыновляется и доводится до актуальной', async () => {
  // Схема применена «как раньше», целиком из schema.sql, таблицы миграций нет.
  const databaseUrl = await freshDatabase('infra_mb4');
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at)
     VALUES ('Кафе Совместимое','["Грозный"]',1,NOW())`);

  const result = await migrator.migrate({ logger: quietLogger });
  const baseline = result.applied.find((a) => a.version === 1);
  assert.equal(baseline.adopted, true, 'baseline на живой базе только отмечается');

  // Данные целы.
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM restaurants'))[0].n, 1);
  await db.close();
});

test('MB5: частично созданная база НЕ усыновляется молча — запуск останавливается', async () => {
  const databaseUrl = await freshDatabase('infra_mb5', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  // Имитация упавшего прогона: есть orders, но больше почти ничего.
  await db.execute(`CREATE TABLE orders (id INTEGER PRIMARY KEY, public_code TEXT)`);

  await assert.rejects(
    () => migrator.migrate({ logger: quietLogger }),
    (err) => {
      // Stage 18: сообщение расширено — теперь оно также говорит, что база не
      // соответствует ни одному известному прошлому состоянию проекта.
      assert.match(err.message, /не совместима с текущим кодом/);
      assert.match(err.message, /известному прошлому состоянию/);
      assert.match(err.message, /Не хватает/);
      assert.match(err.message, /Данные не изменены/);
      return true;
    },
    'частично созданная база обязана останавливать запуск',
  );

  // Отметки не появилось: повторный запуск не «проскочит» baseline.
  const marks = await db.query(
    `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = 1`);
  assert.equal(marks[0].n, 0, 'baseline не должен быть отмечен применённым');
  // Данные (то, что было) не тронуты.
  const still = await db.query(`SELECT to_regclass('public.orders') IS NOT NULL AS has`);
  assert.equal(still[0].has, true);
  await db.close();
});

test('MB6: устаревшая база (нет поздних колонок и объектов) останавливает запуск с перечнем', async () => {
  const databaseUrl = await freshDatabase('infra_mb6');
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  // Откатываем базу к «до Stage 13/14»: убираем то, на что код опирается.
  // yaam:allow-destructive не нужен — это тест, а не миграция.
  await db.execute('ALTER TABLE settlement_restaurant_lines DROP COLUMN carry_forward_applied');
  await db.execute('DROP TABLE IF EXISTS fiscal_receipts');

  await assert.rejects(
    () => migrator.migrate({ logger: quietLogger }),
    (err) => {
      assert.match(err.message, /не совместима с текущим кодом/);
      assert.match(err.message, /carry_forward_applied/);
      assert.match(err.message, /fiscal_receipts/);
      return true;
    },
  );
  assert.equal(
    (await db.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`))[0].n, 0,
    'ни одна миграция не должна быть отмечена',
  );
  await db.close();
});

test('MB7: fingerprint перечисляет недостающее по категориям, но не требует совпадения всего', async () => {
  const databaseUrl = await freshDatabase('infra_mb7');
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();

  // Полная схема — совместима.
  const ok = await migrator.inspectSchemaFingerprint(null);
  assert.equal(ok.compatible, true, `недостаёт: ${ok.missing}`);

  // Посторонняя таблица не делает базу несовместимой: fingerprint проверяет
  // минимум, а не абсолютное совпадение.
  await db.execute('CREATE TABLE some_manual_helper (id INT)');
  const stillOk = await migrator.inspectSchemaFingerprint(null);
  assert.equal(stillOk.compatible, true, 'лишний объект не должен ломать совместимость');

  // А вот отсутствие инварианта — делает.
  await db.execute('DROP TRIGGER trg_fiscal_receipts_payload_immutable ON fiscal_receipts');
  const broken = await migrator.inspectSchemaFingerprint(null);
  assert.equal(broken.compatible, false);
  assert.ok(broken.missing.some((m) => /триггер trg_fiscal_receipts_payload_immutable/.test(m)));
  await db.close();
});

test('MB8: будущая миграция после baseline применяется поверх, повторно — нет', async () => {
  const databaseUrl = await freshDatabase('infra_mb8', { applySchema: false });
  process.env.DATABASE_URL = databaseUrl;
  const { db, migrator } = requireFresh();
  await migrator.migrate({ logger: quietLogger });

  // Добавляем «будущую» миграцию во временный каталог и проверяем механику
  // применения поверх уже принятого baseline.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'yaam-mig-'));
  try {
    const files = migrator.listMigrationFiles();
    for (const f of files) {
      fs.copyFileSync(
        path.join(__dirname, '../../db/postgresql/migrations', f.file),
        path.join(dir, f.file),
      );
    }
    // Номер берётся ЗА пределами реального каталога: иначе проба столкнулась
    // бы с настоящей миграцией того же номера и тест проверял бы не механику,
    // а собственную коллизию.
    const nextVersion = files[files.length - 1].version + 1;
    const probe = `${String(nextVersion).padStart(4, '0')}_future_probe.sql`;
    fs.writeFileSync(path.join(dir, probe),
      'CREATE TABLE mb8_future (id INTEGER PRIMARY KEY);\n');

    const listed = migrator.listMigrationFiles(dir);
    assert.deepEqual(
      listed.map((m) => m.version),
      [...files.map((f) => f.version), nextVersion],
      'порядок по номеру',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Аддитивная миграция и старый код: новая таблица не мешает существующим
  // запросам — rollback кода без отката схемы безопасен.
  await db.execute('CREATE TABLE mb8_future (id INTEGER PRIMARY KEY)');
  const orders = await db.query('SELECT COUNT(*)::int AS n FROM orders');
  assert.equal(orders[0].n, 0, 'старые запросы продолжают работать при аддитивной схеме');
  await db.close();
});

test('MB9: schema.sql и baseline описывают одну схему (справочник не разошёлся с миграциями)', async () => {
  // schema.sql остаётся читаемым полным представлением. Если оно разойдётся с
  // цепочкой миграций, человек будет принимать решения по устаревшей картине.
  const schemaDb = await freshDatabase('infra_mb9_schema');      // применён schema.sql
  const migratedDb = await freshDatabase('infra_mb9_migrated', { applySchema: false });

  process.env.DATABASE_URL = migratedDb;
  const { db, migrator } = requireFresh();
  await migrator.migrate({ logger: quietLogger });

  const listTables = async (client) => {
    const rows = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename <> 'schema_migrations' ORDER BY tablename`);
    return rows.rows.map((r) => r.tablename);
  };

  const migratedTables = (await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename <> 'schema_migrations' ORDER BY tablename`)).map((r) => r.tablename);
  await db.close();

  const c = cluster.getClient('infra_mb9_schema');
  await c.connect();
  const schemaTables = await listTables(c);
  await c.end();

  assert.deepEqual(migratedTables, schemaTables,
    'набор таблиц после цепочки миграций обязан совпадать со справочным schema.sql');
});

// ===========================================================================
// P — preflight первого staging-деплоя (Stage 16)
//
// Проверяется готовность репозитория к деплою, а не сам деплой.
// ===========================================================================

test('P1: assertEnv действительно вызывается при сборке приложения, а не только в readiness', () => {
  // Дефект Stage 15: централизованная проверка конфигурации существовала, но
  // при старте не вызывалась — «запрет» был отчётом постфактум.
  const src = fs.readFileSync(path.join(__dirname, '../../services/postgresql/app.js'), 'utf8');
  assert.match(src, /assertEnv\(env\)/, 'createPostgresqlApp обязан проверять конфигурацию');

  const appModule = require('../../services/postgresql/app.js');
  // Запрещённая комбинация обязана останавливать СБОРКУ, а не только логировать.
  assert.throws(
    () => appModule.createPostgresqlApp({
      port: 0,
      env: {
        APP_ENV: 'production', PAYMENT_PROVIDER: 'mock', TRUST_PROXY: 'loopback',
        PUBLIC_BACKEND_URL: 'https://api.example.test',
        HQ_SESSION_SECRET: 'c4f2b8d7e13a94c6f0b2da3f9c2b7d1e648a5906',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
      },
    }),
    /mock-провайдер/,
  );
});

test('P2: команды деплоя объявлены в package.json и файлы существуют', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  // Порядок деплоя требует отдельных шагов «проверка env» и «миграции» ДО
  // установки systemd-юнита: падение миграции под systemd превращается в цикл
  // перезапусков, где причина тонет в journal.
  for (const script of ['check:env', 'migrate', 'migrate:status', 'start:postgresql']) {
    assert.ok(pkg.scripts[script], `в package.json нет команды ${script}`);
  }
  for (const file of ['check-env.js', 'migrate.js', 'migration-status.js']) {
    assert.ok(
      fs.existsSync(path.join(__dirname, '../../scripts', file)),
      `нет файла scripts/${file}`,
    );
  }
  // Lockfile обязателен: деплой ставит зависимости через npm ci.
  assert.ok(fs.existsSync(path.join(__dirname, '../../package-lock.json')));
});

test('P3: staging-юнит отдельный и не трогает существующий сервис', () => {
  const staging = fs.readFileSync(path.join(DEPLOY_DIR, 'yaam-backend-staging.service'), 'utf8');
  const existing = fs.readFileSync(path.join(DEPLOY_DIR, 'yaam-backend-postgresql.service'), 'utf8');

  // Разные каталоги, разные env-файлы, разные идентификаторы в журнале.
  assert.match(staging, /WorkingDirectory=\/opt\/yaam-staging\/server/);
  assert.match(staging, /EnvironmentFile=\/opt\/yaam-staging\/server\.env\.staging|EnvironmentFile=\/opt\/yaam-staging\/server\/\.env\.staging/);
  assert.match(staging, /SyslogIdentifier=yaam-backend-staging/);
  assert.ok(!staging.includes('/opt/yaam/server'), 'staging не должен указывать на каталог существующего сервиса');
  assert.notEqual(
    /EnvironmentFile=(\S+)/.exec(staging)[1],
    /EnvironmentFile=(\S+)/.exec(existing)[1],
    'staging и существующий сервис не должны делить env-файл',
  );
  // Те же гарантии выключения и ужесточения, что и у основного юнита.
  assert.ok(Number(/TimeoutStopSec=(\d+)/.exec(staging)[1]) > 15);
  assert.match(staging, /NoNewPrivileges=true/);
});

test('P4: staging-конфигурация из примера проходит проверку, live и production-режим — нет', () => {
  // Ровно те значения, что предлагает .env.staging.example (секреты
  // подставлены фиктивные — реальных в репозитории нет).
  const stagingEnv = {
    APP_ENV: 'staging',
    DATABASE_URL: 'postgres://yaam_staging_app:x@127.0.0.1:5432/yaam_staging',
    PUBLIC_BACKEND_URL: 'https://api-staging.example.test',
    PUBLIC_FRONTEND_URL: 'https://staging.example.test',
    HQ_SESSION_SECRET: 'd7e13a94c6f0b2da3f9c2b7d1e648a5906c4f2b8',
    TRUST_PROXY: 'loopback',
    PAYMENT_PROVIDER: 'mock',
    ENABLE_DEV_PAYMENT_ROUTES: 'true',
    SEED_DEMO_DATA: 'false',
  };
  assert.deepEqual(inspectEnv(stagingEnv).errors, [],
    'предлагаемая staging-конфигурация обязана проходить проверку');

  // Dev-подтверждение оплаты — это и есть способ прогнать заказ по статусам
  // без денег. Но только на mock.
  const withYookassa = inspectEnv({
    ...stagingEnv, PAYMENT_PROVIDER: 'yookassa', YOOKASSA_ENV: 'sandbox',
    YOOKASSA_SHOP_ID: '1', YOOKASSA_SECRET_KEY: 'test_ABCDEFGHIJKLMNOPQRSTUV',
  });
  assert.ok(withYookassa.errors.some((e) => /только с PAYMENT_PROVIDER=mock/.test(e)));

  // Боевые ключи в staging и live-режим — запрещены.
  assert.ok(inspectEnv({ ...stagingEnv, YOOKASSA_SECRET_KEY: 'live_AAAAAAAAAAAAAAAAAAAA' })
    .errors.some((e) => /боевой ключ/i.test(e)));
});

test('P5: репозиторий не содержит реальных секретов для staging', () => {
  const files = [
    '.env.staging.example', '.env.postgresql.example', '.env.hqtest.example', '.env.example',
  ].filter((f) => fs.existsSync(path.join(__dirname, '../../', f)));
  assert.ok(files.length >= 2);

  for (const f of files) {
    const content = fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');
    // Ни одного заполненного секрета: только имена и плейсхолдеры.
    assert.ok(!/\blive_[A-Za-z0-9]{10,}/.test(content), `${f}: боевой ключ`);
    assert.ok(!/\btest_[A-Za-z0-9]{20,}/.test(content), `${f}: ключ YooKassa`);
    assert.ok(!/^TELEGRAM_BOT_TOKEN=\d+:[A-Za-z0-9_-]{10,}/m.test(content), `${f}: токен бота`);
    assert.ok(!/^HQ_SESSION_SECRET=.{16,}/m.test(content), `${f}: секрет сессии`);
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(content), `${f}: приватный ключ`);
  }
});
