'use strict';

// server/db/postgresql/seed-hqtest.js — задача "hqtest deployment prep", п.3.
// Тестирует РЕАЛЬНЫЙ CLI-запуск (child_process, не require()) — скрипт сам
// выполняет fail-closed проверки и main() как побочный эффект загрузки,
// require() в том же процессе не было бы честной проверкой того, как он
// реально запускается оператором (node db/postgresql/seed-hqtest.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const execFileAsync = promisify(execFile);
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const SEED_SCRIPT_PATH = path.join(__dirname, '../../db/postgresql/seed-hqtest.js');
const SERVER_ROOT = path.join(__dirname, '../..');

let cluster;
let db;

before(async () => {
  cluster = await startEmbeddedPostgres('seed-hqtest');
  await cluster.createDatabase('yaam_hqtest');
  const setupClient = cluster.getClient('yaam_hqtest');
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
});

after(async () => {
  if (db) await db.close();
  await cluster.stop();
});

function runSeed(envOverrides, { timeout = 30_000 } = {}) {
  return execFileAsync('node', [SEED_SCRIPT_PATH], {
    cwd: SERVER_ROOT,
    timeout,
    env: { ...process.env, ...envOverrides },
  });
}

const HQTEST_DATABASE_URL = () => cluster.connectionString('yaam_hqtest');

// ===========================================================================
// Fail-closed
// ===========================================================================

test('Fail-closed: без HQTEST_SEED_CONFIRM=YES скрипт отказывает, не подключаясь к БД', async () => {
  await assert.rejects(
    runSeed({ DATABASE_URL: HQTEST_DATABASE_URL(), HQTEST_SEED_CONFIRM: undefined }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /HQTEST_SEED_CONFIRM=YES обязателен/);
      return true;
    },
  );
});

test('Fail-closed: HQTEST_SEED_CONFIRM с другим значением (не "YES") тоже отказывает', async () => {
  await assert.rejects(
    runSeed({ DATABASE_URL: HQTEST_DATABASE_URL(), HQTEST_SEED_CONFIRM: 'yes' }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /HQTEST_SEED_CONFIRM=YES обязателен/);
      return true;
    },
  );
});

test('Fail-closed: DATABASE_URL, указывающий НЕ на yaam_hqtest, отказывает — даже с верным HQTEST_SEED_CONFIRM', async () => {
  await assert.rejects(
    runSeed({
      DATABASE_URL: cluster.connectionString('yaam_production'), // другое имя базы — не создавалась, но отказ должен произойти ДО попытки подключения
      HQTEST_SEED_CONFIRM: 'YES',
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /должен указывать на базу с именем РОВНО "yaam_hqtest"/);
      assert.match(err.stderr, /"yaam_production"/);
      return true;
    },
  );
});

test('Fail-closed: отсутствующий/некорректный DATABASE_URL тоже безопасно отказывает (не бросает необработанное исключение)', async () => {
  await assert.rejects(
    runSeed({ DATABASE_URL: 'not-a-valid-url', HQTEST_SEED_CONFIRM: 'YES' }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /не удалось разобрать DATABASE_URL/);
      return true;
    },
  );
});

// ===========================================================================
// Успешный прогон + идемпотентность
// ===========================================================================

test('Успешный запуск создаёт полный набор тестовых данных, второй запуск идемпотентен (без дублей)', async (t) => {
  const env = { DATABASE_URL: HQTEST_DATABASE_URL(), HQTEST_SEED_CONFIRM: 'YES' };

  const first = await runSeed(env, { timeout: 60_000 });
  assert.match(first.stdout, /\[seed-hqtest\] готово\./);

  process.env.DATABASE_URL = HQTEST_DATABASE_URL();
  delete require.cache[require.resolve('../../db/postgresql/index.js')];
  db = require('../../db/postgresql/index.js');

  await t.test('2 тестовых ресторана, явно помечены как тестовые', async () => {
    const rows = await db.query(`SELECT name, connect_code FROM restaurants WHERE connect_code LIKE 'HQTEST-%' ORDER BY id`);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.match(r.name, /\(тест\)/i, `название "${r.name}" должно явно помечать ресторан как тестовый`);
    }
  });

  await t.test('категории и блюда, включая недоступное блюдо', async () => {
    const restA = (await db.query(`SELECT id FROM restaurants WHERE connect_code = 'HQTEST-CONNECT-A'`))[0];
    const categories = await db.query('SELECT id, name FROM categories WHERE restaurant_id = $1', [restA.id]);
    assert.ok(categories.length >= 2);
    const items = await db.query('SELECT name, is_available FROM menu_items WHERE restaurant_id = $1', [restA.id]);
    assert.ok(items.length >= 3);
    assert.ok(items.some((i) => i.is_available === 0 || i.is_available === false), 'обязано быть хотя бы одно недоступное блюдо');
    assert.ok(items.some((i) => i.is_available === 1 || i.is_available === true), 'и хотя бы одно доступное');
  });

  await t.test('заказы во всех основных статусах присутствуют', async () => {
    const rows = await db.query(`SELECT public_code, status FROM orders WHERE public_code LIKE 'YAAM-HQT%' ORDER BY public_code`);
    const byCode = Object.fromEntries(rows.map((r) => [r.public_code, r.status]));
    assert.equal(byCode['YAAM-HQT001'], 'awaiting_payment');
    assert.equal(byCode['YAAM-HQT002'], 'payment_failed');
    assert.equal(byCode['YAAM-HQT003'], 'awaiting_restaurant');
    assert.equal(byCode['YAAM-HQT004'], 'accepted');
    assert.equal(byCode['YAAM-HQT005'], 'preparing');
    assert.equal(byCode['YAAM-HQT006'], 'courier');
    assert.equal(byCode['YAAM-HQT007'], 'delivered');
    assert.equal(byCode['YAAM-HQT008'], 'declined');
    assert.equal(byCode['YAAM-HQT009'], 'timed_out');
    assert.equal(byCode['YAAM-HQT010'], 'cancelled');
  });

  await t.test('успешный возврат (реальный, через mock-провайдер) и неуспешный (документированное исключение)', async () => {
    const succeeded = await db.query(
      `SELECT r.status FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orders o ON o.id = p.order_id WHERE o.public_code = 'YAAM-HQT010'`,
    );
    assert.equal(succeeded[0].status, 'succeeded');
    const failed = await db.query(
      `SELECT r.status, r.last_error_code FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orders o ON o.id = p.order_id WHERE o.public_code = 'YAAM-HQT012'`,
    );
    assert.equal(failed[0].status, 'failed');
    assert.ok(failed[0].last_error_code);
  });

  await t.test('закрытый расчётный период существует', async () => {
    const rows = await db.query(`SELECT status FROM settlement_periods WHERE notes = '' ORDER BY id DESC LIMIT 5`);
    assert.ok(rows.some((r) => r.status === 'closed'));
  });

  await t.test('успешная выплата (EXECUTED) и проблемная (CANCELLED, blocked)', async () => {
    const restA = (await db.query(`SELECT id FROM restaurants WHERE connect_code = 'HQTEST-CONNECT-A'`))[0];
    const restB = (await db.query(`SELECT id FROM restaurants WHERE connect_code = 'HQTEST-CONNECT-B'`))[0];
    const payoutA = (await db.query('SELECT id, status FROM restaurant_payouts WHERE restaurant_id = $1', [restA.id]))[0];
    assert.equal(payoutA.status, 'succeeded');
    const attemptA = (await db.query('SELECT status, bank_status FROM payout_attempts WHERE payout_id = $1', [payoutA.id]))[0];
    assert.equal(attemptA.status, 'succeeded');
    assert.equal(attemptA.bank_status, 'EXECUTED');

    const payoutB = (await db.query('SELECT id, status FROM restaurant_payouts WHERE restaurant_id = $1', [restB.id]))[0];
    assert.equal(payoutB.status, 'blocked');
    const attemptB = (await db.query('SELECT status, bank_status, retryable FROM payout_attempts WHERE payout_id = $1', [payoutB.id]))[0];
    assert.equal(attemptB.status, 'failed');
    assert.equal(attemptB.bank_status, 'CANCELLED');
    assert.equal(attemptB.retryable, false);
  });

  // --- Идемпотентность: снимок количества строк по каждой таблице, второй прогон, сравнение ---
  const countsBefore = await snapshotCounts();
  const second = await runSeed(env, { timeout: 60_000 });
  assert.match(second.stdout, /\[seed-hqtest\] готово\./);
  const countsAfter = await snapshotCounts();
  assert.deepEqual(countsAfter, countsBefore, 'повторный запуск не должен создавать ни одной дополнительной строки ни в одной из проверяемых таблиц');
});

async function snapshotCounts() {
  const tables = ['restaurants', 'categories', 'menu_items', 'orders', 'payments', 'refunds', 'settlement_periods', 'restaurant_payouts', 'payout_attempts'];
  const result = {};
  for (const table of tables) {
    const rows = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    result[table] = rows[0].n;
  }
  return result;
}
