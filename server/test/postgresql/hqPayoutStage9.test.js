'use strict';

// YAAM HQ Stage 9 — Payout Entity Foundation (NO bank integration).
// Интеграционные тесты против настоящего embedded PostgreSQL (тот же
// harness, что и Stage 7/7.1/8). Заказы/платежи/возвраты сконструированы
// напрямую через SQL (та же фикстура, что и в предыдущих Stage-тестах) —
// фокус здесь НА НОВОМ Stage 9 поведении: создание/переходы/immutability/
// изоляция выплат, не на пересчёте формул заработка (уже доказано Stage 7/8).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/lifecycle.js'),
  require.resolve('../../services/postgresql/health.js'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../services/hq/ownerService.js'),
  require.resolve('../../services/hq/securityLog.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/hq/restaurantStatsService.js'),
  require.resolve('../../services/hq/menuAdminService.js'),
  require.resolve('../../services/hq/restaurantAdminService.js'),
  require.resolve('../../services/hq/media/photoService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/settlements.js'),
  require.resolve('../../routes/hq/payouts.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'j'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage9Payout';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-payout-stage9');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});

after(async () => {
  await cluster.stop();
});

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const setupClient = cluster.getClient(name);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
  return cluster.connectionString(name);
}

function reloadHqAppModule() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  return require('../../services/postgresql/app.js');
}

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице');
  return m[1];
}
async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer никогда не начал слушать');
}
async function startApp(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete process.env.MEDIA_PROVIDER;
  process.env.APP_ENV = 'local';
  const appModule = reloadHqAppModule();
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, port, base: `http://127.0.0.1:${port}` };
}
async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
}
async function loginHq(base) {
  const loginRes = await fetch(`${base}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD }).toString(),
  });
  return cookieHeaderFrom(postRes) || cookie;
}

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------
async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null }) {
  orderCounter += 1;
  const code = `YAAM-PO${orderCounter}`;
  const phone = `+7903${String(orderCounter).padStart(7, '0')}`;
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,COALESCE($7, NOW()))
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status, statusUpdatedAt],
  );
  return rows.rows[0].id;
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}
async function addRefund(db, paymentId, { amount, status = 'succeeded', reason = 'customer_cancel' }) {
  const crypto = require('node:crypto');
  const key = `refund-key-${paymentId}-${crypto.randomBytes(4).toString('hex')}`;
  const rows = await db.execute(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id`,
    [paymentId, amount, status, reason, key],
  );
  return rows.rows[0].id;
}

function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Готовит закрытый период с одним заработанным заказом на ресторан — общая
// фикстура для большинства тестов ниже.
async function closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal = 1000, commissionAmount = 70, dayOffset = 0 } = {}) {
  const orderId = await createOrderRow(db, {
    restaurantId, status: 'delivered', itemsTotal, commissionAmount,
    statusUpdatedAt: dayOffset ? new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000) : null,
  });
  await addSucceededPayment(db, orderId, itemsTotal);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(dayOffset), periodTo: todayStr(dayOffset) });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}

// ---------------------------------------------------------------------------
// A: период не закрыт -> отклонено
// ---------------------------------------------------------------------------
test('A: prepareRestaurantPayout отклоняет создание для НЕ закрытого периода', async () => {
  const databaseUrl = await freshDatabase('payout_period_not_closed');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'A');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered' });
    await addSucceededPayment(db, orderId, 1000);
    const draft = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await assert.rejects(() => payoutService.prepareRestaurantPayout(draft.id, restaurantId), /период ещё не закрыт|нет зафиксированной строки/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// B: нет строки обязательства (ресторан без активности в периоде)
// ---------------------------------------------------------------------------
test('B: prepareRestaurantPayout отклоняет создание для ресторана без активности в периоде', async () => {
  const databaseUrl = await freshDatabase('payout_no_line');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantWithActivity = await createRestaurant(db, 'B-active');
    const restaurantWithoutActivity = await createRestaurant(db, 'B-idle');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantWithActivity);
    await assert.rejects(
      () => payoutService.prepareRestaurantPayout(period.id, restaurantWithoutActivity),
      /нет зафиксированной строки/i,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// C: payable_amount <= 0 (единственный реальный случай — ресторан, чья
// ЕДИНСТВЕННАЯ активность периода — возврат отменённого заказа)
// ---------------------------------------------------------------------------
test('C: prepareRestaurantPayout отклоняет создание при payable_amount <= 0', async () => {
  const databaseUrl = await freshDatabase('payout_zero_amount');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'C');
    const cancelledOrder = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 500, commissionAmount: 0 });
    const paymentId = await addSucceededPayment(db, cancelledOrder, 500);
    await addRefund(db, paymentId, { amount: 500 });

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const closeResult = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(closeResult.lines[0].payable_amount, 0, 'предпосылка теста: payable_amount должен быть 0');

    await assert.rejects(() => payoutService.prepareRestaurantPayout(period.id, restaurantId), /не положительна/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// D: успешное создание — сумма БЕЗ пересчёта, ровно из settlement snapshot
// ---------------------------------------------------------------------------
test('D: prepareRestaurantPayout создаёт payout с amount, скопированным из settlement_restaurant_lines.payable_amount', async () => {
  const databaseUrl = await freshDatabase('payout_create_success');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'D');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal: 1000, commissionAmount: 70 });

    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId, { createdBy: 'owner', notes: 'первая выплата' });
    assert.equal(payout.status, 'prepared');
    assert.equal(payout.amount, 930, 'должно совпасть ровно с payable_amount (1000-70), не пересчитано заново');
    assert.equal(payout.created_by, 'owner');
    assert.equal(payout.notes, 'первая выплата');
    assert.ok(payout.prepared_at);
    assert.ok(payout.created_at);
    assert.ok(payout.updated_at);
    assert.equal(payout.processing_at, null);
    assert.equal(payout.completed_at, null);
    assert.equal(payout.failed_at, null);
    assert.equal(payout.failure_reason, null);
    assert.equal(payout.external_payout_id, null);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// E: повторное создание отклонено
// ---------------------------------------------------------------------------
test('E: повторное prepareRestaurantPayout на ту же пару (период, ресторан) отклонено', async () => {
  const databaseUrl = await freshDatabase('payout_duplicate');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'E');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    await assert.rejects(() => payoutService.prepareRestaurantPayout(period.id, restaurantId), /уже существует/i);

    const countRows = await db.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts WHERE settlement_period_id = $1 AND restaurant_id = $2', [period.id, restaurantId]);
    assert.equal(countRows[0].c, 1, 'не должно быть создано две строки');

    // Прямой SQL-обход сервисного слоя — доказывает, что UNIQUE-ограничение
    // само по себе (не только проверка в коде) физически не даёт вставить
    // вторую строку.
    await assert.rejects(() => db.execute(
      `INSERT INTO restaurant_payouts (restaurant_id, settlement_period_id, amount) VALUES ($1,$2,930)`,
      [restaurantId, period.id],
    ), /duplicate key|unique/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// F: валидные переходы prepared -> processing -> succeeded, свои timestamp'ы
// ---------------------------------------------------------------------------
test('F: валидный путь prepared -> processing -> succeeded, каждый переход со своим timestamp', async () => {
  const databaseUrl = await freshDatabase('payout_valid_path');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'F');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    assert.equal(prepared.status, 'prepared');

    const processing = await payoutService.markProcessing(prepared.id, { externalPayoutId: 'ext-001' });
    assert.equal(processing.status, 'processing');
    assert.ok(processing.processing_at);
    assert.equal(processing.external_payout_id, 'ext-001');
    assert.equal(processing.completed_at, null);

    const succeeded = await payoutService.markSucceeded(processing.id);
    assert.equal(succeeded.status, 'succeeded');
    assert.ok(succeeded.completed_at);
    assert.equal(succeeded.failed_at, null);
    assert.equal(succeeded.external_payout_id, 'ext-001', 'external_payout_id, заданный на processing, не теряется');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// G/H: валидные переходы в failed (из prepared И из processing)
// ---------------------------------------------------------------------------
test('G: валидный переход prepared -> failed (отказ до processing) с failure_reason', async () => {
  const databaseUrl = await freshDatabase('payout_failed_from_prepared');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'G');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const failed = await payoutService.markFailed(prepared.id, { failureReason: 'Реквизиты не прошли предварительную проверку' });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.failed_at);
    assert.equal(failed.processing_at, null, 'отказ до processing — processing_at остаётся null');
    assert.equal(failed.failure_reason, 'Реквизиты не прошли предварительную проверку');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('H: валидный переход processing -> failed (реальный отказ провайдера) с failure_reason', async () => {
  const databaseUrl = await freshDatabase('payout_failed_from_processing');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'H');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const processing = await payoutService.markProcessing(prepared.id);
    const failed = await payoutService.markFailed(processing.id, { failureReason: 'Провайдер отклонил перевод' });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.processing_at, 'processing_at должен остаться с прошлого перехода');
    assert.ok(failed.failed_at);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// I-L: неверные переходы отклонены
// ---------------------------------------------------------------------------
test('I: prepared -> succeeded напрямую (минуя processing) отклонён', async () => {
  const databaseUrl = await freshDatabase('payout_invalid_skip_processing');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'I');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    await assert.rejects(() => payoutService.markSucceeded(prepared.id), /разрешено только из "processing"/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('J: succeeded -> processing отклонён (terminal, нельзя вернуть в обработку)', async () => {
  const databaseUrl = await freshDatabase('payout_invalid_terminal_succeeded');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'J');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const processing = await payoutService.markProcessing(prepared.id);
    const succeeded = await payoutService.markSucceeded(processing.id);
    await assert.rejects(() => payoutService.markProcessing(succeeded.id), /разрешено только из "prepared"/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('K: failed -> processing отклонён (задание, дословно: "нельзя failed -> processing")', async () => {
  const databaseUrl = await freshDatabase('payout_invalid_failed_to_processing');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'K');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const failed = await payoutService.markFailed(prepared.id, { failureReason: 'тест' });
    await assert.rejects(() => payoutService.markProcessing(failed.id), /разрешено только из "prepared"/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('L: failed -> succeeded отклонён (terminal)', async () => {
  const databaseUrl = await freshDatabase('payout_invalid_failed_to_succeeded');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'L');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const failed = await payoutService.markFailed(prepared.id, { failureReason: 'тест' });
    await assert.rejects(() => payoutService.markSucceeded(failed.id), /разрешено только из "processing"/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('M: markFailed без failureReason отклонён', async () => {
  const databaseUrl = await freshDatabase('payout_failed_reason_required');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantId = await createRestaurant(db, 'M');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const prepared = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    await assert.rejects(() => payoutService.markFailed(prepared.id, {}), /failureReason обязателен/i);
    await assert.rejects(() => payoutService.markFailed(prepared.id, { failureReason: '   ' }), /failureReason обязателен/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// N: immutability на уровне БД после terminal
// ---------------------------------------------------------------------------
test('N: succeeded/failed выплаты защищены DB-триггером от UPDATE/DELETE напрямую через SQL', async () => {
  const databaseUrl = await freshDatabase('payout_immutability');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantA = await createRestaurant(db, 'N-succeeded');
    const periodA = await closedPeriodWithEarnings(db, settlementService, restaurantA);
    const preparedA = await payoutService.prepareRestaurantPayout(periodA.id, restaurantA);
    const processingA = await payoutService.markProcessing(preparedA.id);
    const succeeded = await payoutService.markSucceeded(processingA.id);

    await assert.rejects(() => db.execute(`UPDATE restaurant_payouts SET notes = 'hacked' WHERE id = $1`, [succeeded.id]), /immutable/i);
    await assert.rejects(() => db.execute(`DELETE FROM restaurant_payouts WHERE id = $1`, [succeeded.id]), /immutable|cannot be deleted/i);

    const restaurantB = await createRestaurant(db, 'N-failed');
    const periodB = await closedPeriodWithEarnings(db, settlementService, restaurantB, { dayOffset: -1 });
    const preparedB = await payoutService.prepareRestaurantPayout(periodB.id, restaurantB);
    const failed = await payoutService.markFailed(preparedB.id, { failureReason: 'тест' });

    await assert.rejects(() => db.execute(`UPDATE restaurant_payouts SET notes = 'hacked' WHERE id = $1`, [failed.id]), /immutable/i);
    await assert.rejects(() => db.execute(`DELETE FROM restaurant_payouts WHERE id = $1`, [failed.id]), /immutable|cannot be deleted/i);

    // Не-terminal (prepared/processing) НЕ должны быть immutable — иначе
    // сам markProcessing/markSucceeded/markFailed выше не сработал бы.
    // Дополнительно явно проверяем, что prepared-строку МОЖНО обновить
    // штатным переходом (уже доказано выше тем, что succeeded/failed вообще
    // существуют), поэтому здесь только негативный кейс terminal.
    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, true);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// O: изоляция ресторанов
// ---------------------------------------------------------------------------
test('O: выплаты двух ресторанов в одном периоде не смешиваются', async () => {
  const databaseUrl = await freshDatabase('payout_isolation');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const restaurantA = await createRestaurant(db, 'O-A');
    const restaurantB = await createRestaurant(db, 'O-B');
    const orderA = await createOrderRow(db, { restaurantId: restaurantA, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderA, 1000);
    const orderB = await createOrderRow(db, { restaurantId: restaurantB, status: 'delivered', itemsTotal: 5000, commissionAmount: 350 });
    await addSucceededPayment(db, orderB, 5000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const payoutA = await payoutService.prepareRestaurantPayout(period.id, restaurantA);
    const payoutB = await payoutService.prepareRestaurantPayout(period.id, restaurantB);
    assert.equal(payoutA.amount, 930);
    assert.equal(payoutB.amount, 4650);

    await payoutService.markProcessing(payoutA.id);
    // A -> processing НЕ должно влиять на B, которая осталась prepared.
    const bStillPrepared = await payoutService.getPayoutById(payoutB.id);
    assert.equal(bStillPrepared.status, 'prepared');

    const map = await payoutService.listPayoutsForPeriod(period.id);
    assert.equal(map.get(restaurantA).status, 'processing');
    assert.equal(map.get(restaurantB).status, 'prepared');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// P: public API leak scan
// ---------------------------------------------------------------------------
test('P: публичный API не содержит ни одного payout-поля', async () => {
  const databaseUrl = await freshDatabase('payout_public_leak');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const payoutService = require('../../services/hq/payoutService');

    const restaurantRows = await db.execute(
      `INSERT INTO restaurants (name, cities, published_at, is_open) VALUES ('Leak Payout', '[]', NOW(), 1) RETURNING id`,
    );
    const restaurantId = restaurantRows.rows[0].id;
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1234, commissionAmount: 86 });
    await addSucceededPayment(db, orderId, 1234);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);
    await payoutService.prepareRestaurantPayout(period.id, restaurantId, { notes: 'секретная внутренняя заметка' });

    const listRes = await fetch(`${base}/api/restaurants`);
    const listText = await listRes.text();
    const detailRes = await fetch(`${base}/api/restaurants/${restaurantId}`);
    const detailText = await detailRes.text();
    for (const field of ['payout', 'prepared_at', 'processing_at', 'external_payout_id', 'failure_reason', 'секретная внутренняя заметка']) {
      assert.ok(!listText.includes(field), `публичный список не должен содержать "${field}"`);
      assert.ok(!detailText.includes(field), `публичная карточка не должна содержать "${field}"`);
    }
    void cookie;
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// Q/R: CSRF, Auth
// ---------------------------------------------------------------------------
test('Q: POST prepare без CSRF-токена отклоняется', async () => {
  const databaseUrl = await freshDatabase('payout_csrf');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const restaurantId = await createRestaurant(db, 'Q');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const res = await fetch(`${base}/hq/finance/settlements/${period.id}/payouts/${restaurantId}/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({}).toString(),
    });
    assert.ok(res.status === 400 || res.status === 403, `ожидали 400/403, получили ${res.status}`);
  } finally {
    await stopApp(instance);
  }
});

test('R: /hq/payouts и /hq/finance/settlements/:id/payouts/:rid/prepare без сессии -> редирект на логин', async () => {
  const databaseUrl = await freshDatabase('payout_auth');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const listRes = await fetch(`${base}/hq/payouts`, { redirect: 'manual' });
    assert.equal(listRes.status, 302);
    assert.match(listRes.headers.get('location') || '', /login/);

    const prepareRes = await fetch(`${base}/hq/finance/settlements/1/payouts/1/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    assert.equal(prepareRes.status, 302);
    assert.match(prepareRes.headers.get('location') || '', /login/);
  } finally {
    await stopApp(instance);
  }
});

test('R2: /hq/payouts — Cache-Control: no-store', async () => {
  const databaseUrl = await freshDatabase('payout_no_store');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const res = await fetch(`${base}/hq/payouts`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// S: audit log
// ---------------------------------------------------------------------------
test('S: подготовка выплаты через HQ пишет payout_created с правильным restaurant_id', async () => {
  const databaseUrl = await freshDatabase('payout_audit_log');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const restaurantId = await createRestaurant(db, 'S');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const periodPage = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await periodPage.text());
    const prepareRes = await fetch(`${base}/hq/finance/settlements/${period.id}/payouts/${restaurantId}/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(prepareRes.status, 302);

    const auditRows = await db.query(`SELECT action, restaurant_id, details FROM hq_audit_log WHERE action = 'payout_created'`);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].restaurant_id, restaurantId, 'payout_created ДОЛЖЕН быть привязан к ресторану (в отличие от settlement-событий)');
    assert.match(auditRows[0].details, /payout_id=\d+/);
  } finally {
    await stopApp(instance);
  }
});

// payout_processing/payout_succeeded/payout_failed — задание требует
// "добавить события" (задание, раздел "Audit") — они добавлены в allowlist
// hq_audit_log.action и services/hq/auditLog.js ACTIONS (инфраструктура
// готова), но НЕ вызываются ни одним текущим маршрутом: markProcessing/
// markSucceeded/markFailed не подключены к HQ UI в этом этапе (нет банка —
// нет реального триггера для этих переходов, задание: "Пока Read Only",
// "Без ручной отправки"). Следующий тест доказывает, что allowlist их
// принимает — то есть Stage 10 (когда появится реальный вызывающий код —
// банковский webhook/API) сможет писать эти события без миграции схемы.
test('T: payout_processing/payout_succeeded/payout_failed принимаются allowlist hq_audit_log (готово для Stage 10, ещё не вызывается ни одним маршрутом)', async () => {
  const databaseUrl = await freshDatabase('payout_audit_future_actions');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/auditLog')];
  const db = require('../../db/postgresql');
  const { logAuditEvent } = require('../../services/hq/auditLog');
  try {
    const restaurantId = await createRestaurant(db, 'T');
    for (const action of ['payout_processing', 'payout_succeeded', 'payout_failed']) {
      await logAuditEvent({ action, restaurantId, details: 'test', ip: '127.0.0.1' });
    }
    const rows = await db.query(`SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id`, [restaurantId]);
    assert.deepEqual(rows.map((r) => r.action), ['payout_processing', 'payout_succeeded', 'payout_failed']);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// U: dashboard-статистика
// ---------------------------------------------------------------------------
test('U: getPayoutDashboardStats считает prepared/succeeded/failed раздельно, суммы корректны', async () => {
  const databaseUrl = await freshDatabase('payout_dashboard_stats');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    const r1 = await createRestaurant(db, 'U1');
    const r2 = await createRestaurant(db, 'U2');
    const r3 = await createRestaurant(db, 'U3');
    for (const [rid, total, comm] of [[r1, 1000, 70], [r2, 2000, 140], [r3, 3000, 210]]) {
      const orderId = await createOrderRow(db, { restaurantId: rid, status: 'delivered', itemsTotal: total, commissionAmount: comm });
      await addSucceededPayment(db, orderId, total);
    }
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const p1 = await payoutService.prepareRestaurantPayout(period.id, r1); // остаётся prepared (930)
    const p2 = await payoutService.prepareRestaurantPayout(period.id, r2);
    await payoutService.markProcessing(p2.id);
    const succeeded2 = await payoutService.getPayoutById(p2.id);
    await payoutService.markSucceeded(succeeded2.id); // succeeded (1860)
    const p3 = await payoutService.prepareRestaurantPayout(period.id, r3);
    await payoutService.markFailed(p3.id, { failureReason: 'тест' }); // failed (2790)

    const stats = await payoutService.getPayoutDashboardStats();
    assert.equal(stats.preparedCount, 2, 'prepared+processing+succeeded = p1(prepared) + p2(succeeded)');
    assert.equal(stats.succeededCount, 1);
    assert.equal(stats.failedCount, 1);
    assert.equal(stats.preparedAmount, 930 + 1860);
    assert.equal(stats.succeededAmount, 1860);
    void p1;
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
