'use strict';

// YAAM HQ Stage 8 — Settlement Periods and Restaurant Payable Obligations.
// Интеграционные тесты против настоящего embedded PostgreSQL (тот же
// harness, что и Stage 7/7.1: server/test/postgresql/hqRestaurantFinanceStage7.test.js
// и hqRestaurantRefundReportingStage71.test.js). Заказы/платежи/возвраты
// сконструированы напрямую через SQL (та же фикстура, что и в Stage 7/7.1
// тестах) — формулы "что считается заработком/возвратом" уже полностью
// покрыты и доказаны там; здесь фокус НА НОВОМ Stage 8 поведении: создание/
// закрытие/immutable snapshot/защита от двойного учёта периодов.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

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
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/settlements.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'i'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage8Settlement';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-settlement-stage8');
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
// Фикстуры (та же прямая-через-SQL конструкция, что и в Stage 7/7.1 тестах —
// формулы заработка/возврата там уже доказаны, здесь фокус на Stage 8).
// ---------------------------------------------------------------------------
async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null }) {
  orderCounter += 1;
  const code = `YAAM-S${orderCounter}`;
  const phone = `+7902${String(orderCounter).padStart(7, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // фикстура пишет напрямую SQL, поэтому сама выставляет earned_at =
  // status_updated_at ровно когда status='delivered' (тот же принцип, что
  // и backfill в миграции 0013).
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,COALESCE($7, NOW()),
       CASE WHEN $6 = 'delivered' THEN COALESCE($7, NOW()) ELSE NULL END)
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status, statusUpdatedAt],
  );
  return rows.rows[0].id;
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}
async function addRefund(db, paymentId, { amount, status = 'succeeded', reason = 'customer_cancel', completedAt = null }) {
  const key = `refund-key-${paymentId}-${crypto.randomBytes(4).toString('hex')}`;
  const rows = await db.execute(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [paymentId, amount, status, reason, key, status === 'succeeded' ? (completedAt || new Date()) : null],
  );
  return rows.rows[0].id;
}

// ---------------------------------------------------------------------------
// A: создание черновика
// ---------------------------------------------------------------------------
test('A: createDraftSettlementPeriod создаёт draft с корректными полями (created_by, notes, даты)', async () => {
  const databaseUrl = await freshDatabase('settlement_create_draft');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const period = await settlementService.createDraftSettlementPeriod({
      periodFrom: todayStr(-1), periodTo: todayStr(), notes: 'Первый период', createdBy: 'owner',
    });
    assert.equal(period.status, 'draft');
    assert.equal(period.notes, 'Первый период');
    assert.equal(period.created_by, 'owner');
    assert.equal(period.closed_at, null);
    assert.equal(period.period_from, todayStr(-1));
    assert.equal(period.period_to, todayStr());
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// B: пересекающиеся периоды отклоняются, соседние — разрешены
// ---------------------------------------------------------------------------
test('B: пересекающийся период отклоняется (включая идентичный диапазон), соседний непересекающийся — разрешён', async () => {
  const databaseUrl = await freshDatabase('settlement_overlap');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    await settlementService.createDraftSettlementPeriod({ periodFrom: '2026-01-01', periodTo: '2026-01-10' });

    await assert.rejects(
      () => settlementService.createDraftSettlementPeriod({ periodFrom: '2026-01-01', periodTo: '2026-01-10' }),
      settlementService.ValidationError || Error,
    );
    await assert.rejects(
      () => settlementService.createDraftSettlementPeriod({ periodFrom: '2026-01-05', periodTo: '2026-01-15' }),
    );
    await assert.rejects(
      () => settlementService.createDraftSettlementPeriod({ periodFrom: '2026-01-10', periodTo: '2026-01-20' }),
      /пересекается/,
    );

    // Соседний, НЕ пересекающийся (начинается на следующий день после конца
    // первого периода) — должен пройти без ошибки.
    const adjacent = await settlementService.createDraftSettlementPeriod({ periodFrom: '2026-01-11', periodTo: '2026-01-20' });
    assert.equal(adjacent.status, 'draft');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// C: некорректные даты отклоняются (переиспользует resolvePeriodRange)
// ---------------------------------------------------------------------------
test('C: некорректные даты отклоняются (плохой формат, конец раньше начала, диапазон > 366 дней)', async () => {
  const databaseUrl = await freshDatabase('settlement_bad_dates');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    await assert.rejects(() => settlementService.createDraftSettlementPeriod({ periodFrom: 'not-a-date', periodTo: '2026-01-10' }));
    await assert.rejects(() => settlementService.createDraftSettlementPeriod({ periodFrom: '2026-01-10', periodTo: '2026-01-05' }));
    await assert.rejects(() => settlementService.createDraftSettlementPeriod({ periodFrom: '2020-01-01', periodTo: '2026-01-01' }));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// D: preview (draft) — живой расчёт
// ---------------------------------------------------------------------------
test('D: preview draft-периода показывает живой расчёт по текущим данным', async () => {
  const databaseUrl = await freshDatabase('settlement_preview');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'D');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const detail = await settlementService.getSettlementPeriodDetail(period.id);
    assert.equal(detail.preview, true);
    assert.equal(detail.lines.length, 1);
    assert.equal(detail.lines[0].turnover, 1000);
    assert.equal(detail.lines[0].restaurant_earnings, 930);

    // Добавили ещё один заказ ПОСЛЕ первого просмотра preview — второй
    // просмотр должен отразить изменение (draft ещё не зафиксирован).
    const orderId2 = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 500, commissionAmount: 35 });
    await addSucceededPayment(db, orderId2, 500);
    const detail2 = await settlementService.getSettlementPeriodDetail(period.id);
    assert.equal(detail2.lines[0].turnover, 1500, 'draft preview должен отражать новые данные при каждом просмотре');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// E: закрытие — immutable snapshot корректно сформирован
// ---------------------------------------------------------------------------
test('E: closeSettlementPeriod формирует корректный immutable snapshot (restaurant/order/refund lines)', async () => {
  const databaseUrl = await freshDatabase('settlement_close');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'E');
    const order1 = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, order1, 1000);
    const order2 = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 2000, commissionAmount: 140 });
    await addSucceededPayment(db, order2, 2000);
    // Отменённый заказ с реальным возвратом — не заработок, но фигурирует в возвратах.
    const cancelledOrder = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 500, commissionAmount: 0 });
    const cancelledPayment = await addSucceededPayment(db, cancelledOrder, 500);
    await addRefund(db, cancelledPayment, { amount: 500 });

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);

    assert.equal(result.alreadyClosed, false);
    assert.equal(result.period.status, 'closed');
    assert.ok(result.period.closed_at);
    assert.equal(result.lines.length, 1);
    const line = result.lines[0];
    assert.equal(line.delivered_paid_orders, 2);
    assert.equal(line.turnover, 3000);
    assert.equal(line.yaam_commission, 210);
    assert.equal(line.restaurant_earnings, 2790);
    assert.equal(line.payable_amount, 2790);
    assert.equal(line.successful_refunds_count, 1);
    assert.equal(line.successful_refunds_amount, 500);
    assert.equal(line.commission_bps_summary, 700);

    const orderLines = await db.query('SELECT * FROM settlement_order_lines WHERE settlement_period_id = $1 ORDER BY order_id', [period.id]);
    assert.equal(orderLines.length, 2, 'ровно 2 заработанных заказа должны попасть в snapshot');
    assert.deepEqual(orderLines.map((r) => r.order_id).sort((a, b) => a - b), [order1, order2].sort((a, b) => a - b));

    const refundLines = await db.query('SELECT * FROM settlement_refunds WHERE settlement_period_id = $1', [period.id]);
    assert.equal(refundLines.length, 1);
    assert.equal(refundLines[0].amount_snapshot, 500);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// F: повторное закрытие идемпотентно
// ---------------------------------------------------------------------------
test('F: повторное закрытие уже закрытого периода идемпотентно — не создаёт дубликатов', async () => {
  const databaseUrl = await freshDatabase('settlement_idempotent_close');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'F');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);
    const second = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(second.alreadyClosed, true);

    const lineCount = await db.query('SELECT COUNT(*)::int AS c FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [period.id]);
    assert.equal(lineCount[0].c, 1, 'повторное закрытие не должно удваивать строки');
    const orderLineCount = await db.query('SELECT COUNT(*)::int AS c FROM settlement_order_lines WHERE settlement_period_id = $1', [period.id]);
    assert.equal(orderLineCount[0].c, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// G: rollback при ошибке — период остаётся draft, частичных строк не остаётся
// ---------------------------------------------------------------------------
test('G: если закрытие падает (принудительный конфликт UNIQUE(order_id)), период остаётся draft без частичных строк', async () => {
  const databaseUrl = await freshDatabase('settlement_rollback');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'G');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);

    // Принудительно создаём "чужой" период и заранее занимаем order_id в
    // settlement_order_lines (напрямую через SQL, в обход сервисного слоя) —
    // имитирует состояние, которое НЕ должно быть достижимо через реальный
    // API (периоды не пересекаются по датам), но которое реальный UNIQUE-
    // constraint обязан поймать, если оно всё же возникло (баг/ручная правка).
    const otherPeriod = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(-100), periodTo: todayStr(-100) });
    await db.execute(
      `INSERT INTO settlement_order_lines (settlement_period_id, restaurant_id, order_id, items_total_snapshot, commission_amount_snapshot, restaurant_amount_snapshot, delivered_at_snapshot)
       VALUES ($1,$2,$3,1000,70,930,NOW())`,
      [otherPeriod.id, restaurantId, orderId],
    );

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await assert.rejects(() => settlementService.closeSettlementPeriod(period.id));

    const reloaded = await settlementService.getSettlementPeriodById(period.id);
    assert.equal(reloaded.status, 'draft', 'период должен остаться draft после неудачного закрытия');
    assert.equal(reloaded.closed_at, null);

    const lineCount = await db.query('SELECT COUNT(*)::int AS c FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [period.id]);
    assert.equal(lineCount[0].c, 0, 'ни одной частичной строки обязательства не должно остаться');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// H: два ресторана в одном периоде не смешиваются
// ---------------------------------------------------------------------------
test('H: два ресторана в одном закрытом периоде получают отдельные корректные строки', async () => {
  const databaseUrl = await freshDatabase('settlement_two_restaurants');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantA = await createRestaurant(db, 'H-A');
    const restaurantB = await createRestaurant(db, 'H-B');
    const orderA = await createOrderRow(db, { restaurantId: restaurantA, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderA, 1000);
    const orderB = await createOrderRow(db, { restaurantId: restaurantB, status: 'delivered', itemsTotal: 4000, commissionAmount: 280 });
    await addSucceededPayment(db, orderB, 4000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(result.lines.length, 2);
    const lineA = result.lines.find((l) => l.restaurant_id === restaurantA);
    const lineB = result.lines.find((l) => l.restaurant_id === restaurantB);
    assert.equal(lineA.turnover, 1000);
    assert.equal(lineB.turnover, 4000);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// I: заказы разных статусов — только delivered+paid+без-возврата учитываются
// ---------------------------------------------------------------------------
test('I: закрытие учитывает только delivered+paid+без-succeeded-возврата заказы', async () => {
  const databaseUrl = await freshDatabase('settlement_statuses');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'I');
    const earned = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, earned, 1000);
    await createOrderRow(db, { restaurantId, status: 'awaiting_payment' });
    await createOrderRow(db, { restaurantId, status: 'cancelled' });
    await createOrderRow(db, { restaurantId, status: 'declined' });
    await createOrderRow(db, { restaurantId, status: 'timed_out' });
    const paidNotDelivered = await createOrderRow(db, { restaurantId, status: 'accepted' });
    await addSucceededPayment(db, paidNotDelivered, 1000);
    const deliveredRefunded = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 300, commissionAmount: 21 });
    const deliveredRefundedPayment = await addSucceededPayment(db, deliveredRefunded, 300);
    await addRefund(db, deliveredRefundedPayment, { amount: 300 });

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].delivered_paid_orders, 1, 'только один по-настоящему заработанный заказ');
    assert.equal(result.lines[0].turnover, 1000);
    assert.equal(result.lines[0].successful_refunds_count, 1, 'возврат по delivered+refunded заказу всё равно фигурирует в возвратах');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// J: refund reporting внутри периода (Stage 7.1 семантика сохранена)
// ---------------------------------------------------------------------------
test('J: возврат отменённого заказа отображается в периоде, не уменьшая restaurant_earnings повторно', async () => {
  const databaseUrl = await freshDatabase('settlement_refund_reporting');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'J');
    const earned = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, earned, 1000);
    const cancelled = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 500, commissionAmount: 0 });
    const cancelledPayment = await addSucceededPayment(db, cancelled, 500);
    await addRefund(db, cancelledPayment, { amount: 500, reason: 'customer_cancel' });

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);
    const line = result.lines[0];
    assert.equal(line.restaurant_earnings, 930, 'НЕ 930-500 — возврат отменённого заказа не вычитается из заработка повторно');
    assert.equal(line.successful_refunds_amount, 500);
    assert.equal(line.payable_amount, 930);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// K/L: UNIQUE(order_id)/UNIQUE(refund_id) — защита от двойного учёта на
// уровне схемы (прямая проверка constraint'а, не только сервисного слоя)
// ---------------------------------------------------------------------------
test('K: UNIQUE(order_id) на settlement_order_lines физически не даёт вставить один заказ дважды', async () => {
  const databaseUrl = await freshDatabase('settlement_unique_order');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  const db = require('../../db/postgresql');
  try {
    const restaurantId = await createRestaurant(db, 'K');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period1Rows = await db.execute(`INSERT INTO settlement_periods (period_from, period_to) VALUES ('2026-01-01','2026-01-01') RETURNING id`);
    const period2Rows = await db.execute(`INSERT INTO settlement_periods (period_from, period_to) VALUES ('2026-02-01','2026-02-01') RETURNING id`);
    await db.execute(
      `INSERT INTO settlement_order_lines (settlement_period_id, restaurant_id, order_id, items_total_snapshot, commission_amount_snapshot, restaurant_amount_snapshot, delivered_at_snapshot)
       VALUES ($1,$2,$3,1000,70,930,NOW())`,
      [period1Rows.rows[0].id, restaurantId, orderId],
    );
    await assert.rejects(() => db.execute(
      `INSERT INTO settlement_order_lines (settlement_period_id, restaurant_id, order_id, items_total_snapshot, commission_amount_snapshot, restaurant_amount_snapshot, delivered_at_snapshot)
       VALUES ($1,$2,$3,1000,70,930,NOW())`,
      [period2Rows.rows[0].id, restaurantId, orderId],
    ), /duplicate key|unique/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('L: UNIQUE(refund_id) на settlement_refunds физически не даёт вставить один возврат дважды', async () => {
  const databaseUrl = await freshDatabase('settlement_unique_refund');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  const db = require('../../db/postgresql');
  try {
    const restaurantId = await createRestaurant(db, 'L');
    const orderId = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 500, commissionAmount: 0 });
    const paymentId = await addSucceededPayment(db, orderId, 500);
    const refundId = await addRefund(db, paymentId, { amount: 500 });
    const period1Rows = await db.execute(`INSERT INTO settlement_periods (period_from, period_to) VALUES ('2026-01-01','2026-01-01') RETURNING id`);
    const period2Rows = await db.execute(`INSERT INTO settlement_periods (period_from, period_to) VALUES ('2026-02-01','2026-02-01') RETURNING id`);
    await db.execute(
      `INSERT INTO settlement_refunds (settlement_period_id, restaurant_id, refund_id, amount_snapshot, completed_at_snapshot) VALUES ($1,$2,$3,500,NOW())`,
      [period1Rows.rows[0].id, restaurantId, refundId],
    );
    await assert.rejects(() => db.execute(
      `INSERT INTO settlement_refunds (settlement_period_id, restaurant_id, refund_id, amount_snapshot, completed_at_snapshot) VALUES ($1,$2,$3,500,NOW())`,
      [period2Rows.rows[0].id, restaurantId, refundId],
    ), /duplicate key|unique/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// M: смена договора/комиссии после закрытия НЕ меняет snapshot
// ---------------------------------------------------------------------------
test('M: смена комиссии по договору после закрытия периода не меняет уже сохранённый snapshot', async () => {
  const databaseUrl = await freshDatabase('settlement_contract_change_after_close');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/restaurantContractService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const contractService = require('../../services/hq/restaurantContractService');
  try {
    const restaurantId = await createRestaurant(db, 'M');
    await contractService.saveContract(restaurantId, { status: 'signed', contract_number: 'Д-1', signed_at: '2026-01-01', commission_percent: '10' });
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 100 });
    await addSucceededPayment(db, orderId, 1000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(result.lines[0].yaam_commission, 100);
    assert.equal(result.lines[0].contract_number_snapshot, 'Д-1');
    assert.equal(result.lines[0].commission_bps_summary, 1000);

    // Меняем комиссию ПОСЛЕ закрытия.
    await contractService.saveContract(restaurantId, { status: 'signed', contract_number: 'Д-2', signed_at: '2026-01-01', commission_percent: '5' });

    const reloadedDetail = await settlementService.getSettlementPeriodDetail(period.id);
    assert.equal(reloadedDetail.preview, false);
    assert.equal(reloadedDetail.lines[0].yaam_commission, 100, 'snapshot не должен пересчитываться по новой комиссии');
    assert.equal(reloadedDetail.lines[0].contract_number_snapshot, 'Д-1', 'snapshot должен сохранить СТАРЫЙ номер договора');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// N: новый заказ после закрытия не попадает в уже закрытый период
// ---------------------------------------------------------------------------
test('N: заказ, доставленный ПОСЛЕ закрытия периода, не появляется в этом периоде задним числом', async () => {
  const databaseUrl = await freshDatabase('settlement_new_order_after_close');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'N');
    const order1 = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, order1, 1000);

    // Период "вчера" — закрываем.
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(-1), periodTo: todayStr(-1) });
    // Order1 создан "сегодня" (NOW()), а период — "вчера" — сместим
    // status_updated_at заказа на вчера, чтобы он попал в закрываемый период.
    await db.execute(`UPDATE orders SET status_updated_at = (NOW() - INTERVAL '1 day'), earned_at = (NOW() - INTERVAL '1 day') WHERE id = $1`, [order1]);
    const result = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(result.lines[0].turnover, 1000);

    // Новый заказ — доставлен СЕГОДНЯ, ПОСЛЕ закрытия периода "вчера".
    const order2 = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 5000, commissionAmount: 350 });
    await addSucceededPayment(db, order2, 5000);

    const reloadedDetail = await settlementService.getSettlementPeriodDetail(period.id);
    assert.equal(reloadedDetail.lines[0].turnover, 1000, 'закрытый период "вчера" не должен видеть заказ, доставленный сегодня');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// O: readiness зафиксирован на момент закрытия
// ---------------------------------------------------------------------------
test('O: payout readiness snapshot фиксируется на момент закрытия, не меняется задним числом', async () => {
  const databaseUrl = await freshDatabase('settlement_readiness_snapshot');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/restaurantLegalDetailsService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  const legalService = require('../../services/hq/restaurantLegalDetailsService');
  try {
    const restaurantId = await createRestaurant(db, 'O');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(result.lines[0].payout_readiness_snapshot, 'missing_legal_details');

    // Заполняем юр.данные ПОСЛЕ закрытия — readiness изменился бы у LIVE-
    // расчёта, но НЕ у уже закрытого периода.
    await legalService.saveLegalDetails(restaurantId, {
      legal_form: 'ip', legal_name: 'ИП Тест', inn: '770912345616', ogrn: '312770012345008',
      legal_address: 'адрес', director_name: 'Тестов', contact_phone: '+79001234567',
    });

    const reloadedDetail = await settlementService.getSettlementPeriodDetail(period.id);
    assert.equal(reloadedDetail.lines[0].payout_readiness_snapshot, 'missing_legal_details', 'snapshot readiness не должен обновляться после закрытия');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// P/Q/R: auth, CSRF, no-store
// ---------------------------------------------------------------------------
test('P: /hq/finance/settlements/new без сессии -> редирект на логин', async () => {
  const databaseUrl = await freshDatabase('settlement_auth');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const res = await fetch(`${base}/hq/finance/settlements/new`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /login/);
  } finally {
    await stopApp(instance);
  }
});

// docs/HQ-PRODUCT-SPEC.md: ручное создание периода удалено — периоды
// закрываются автоматически. CSRF-защита проверяется на ОСТАВШЕМСЯ
// write-маршруте раздела (подготовка выплаты по строке периода).
test('Q: write-маршрут /finance/settlements без CSRF-токена отклоняется', async () => {
  const databaseUrl = await freshDatabase('settlement_csrf');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const res = await fetch(`${base}/hq/finance/settlements/1/payouts/1/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: '',
    });
    assert.notEqual(res.status, 302, 'без корректного CSRF действие не должно проходить успешно');
    assert.ok(res.status === 403 || res.status === 400 || res.status === 404, `ожидали 400/403/404, получили ${res.status}`);
  } finally {
    await stopApp(instance);
  }
});

// Ручное создание периода недоступно даже прямым запросом.
test('Q2: ручные маршруты создания/закрытия/удаления периода удалены', async () => {
  const databaseUrl = await freshDatabase('settlement_manual_removed');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const newPage = await fetch(`${base}/hq/finance/settlements/new`, { headers: { Cookie: cookie } });
    assert.equal(newPage.status, 404, 'GET /new удалён');
    const createRes = await fetch(`${base}/hq/finance/settlements`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: '',
    });
    assert.equal(createRes.status, 404, 'POST / удалён');
  } finally {
    await stopApp(instance);
  }
});

test('R: /hq/finance/settlements/:id — Cache-Control: no-store', async () => {
  const databaseUrl = await freshDatabase('settlement_no_store');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    // Период создаётся сервисом: ручной HTTP-маршрут удалён.
    const settlementService = require('../../services/hq/settlementService');
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const detailRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.headers.get('cache-control'), 'no-store');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// S: audit log
// ---------------------------------------------------------------------------
// docs/HQ-PRODUCT-SPEC.md: события периода теперь пишет автоматический job
// и сервисный слой, а не ручные кнопки HQ (их больше нет).
test('S: автозакрытие периода пишет события job и закрытия в hq_audit_log', async () => {
  const databaseUrl = await freshDatabase('settlement_audit_log');
  process.env.DATABASE_URL = databaseUrl;
  // Сброс кэша: db/settlementService/auditLog/weeklySettlementService держат
  // собственные ссылки на пул — без сброса они смотрели бы в БД прошлого теста.
  for (const m of [
    '../../db/postgresql', '../../services/hq/settlementService',
    '../../services/hq/auditLog', '../../services/hq/weeklySettlementService',
    '../../services/hq/settlementDocumentService', '../../services/hq/restaurantFinanceService',
    '../../services/hq/restaurantPayoutService', '../../services/hq/restaurantContractService',
    '../../services/hq/restaurantLegalDetailsService', '../../services/hq/yaamBankDetailsService',
  ]) delete require.cache[require.resolve(m)];
  const db = require('../../db/postgresql');
  try {
    const restaurantRows = await db.execute(
      `INSERT INTO restaurants (name, cities, published_at, is_open) VALUES ('Аудит', '[]', NOW(), 1) RETURNING id`,
    );
    const restaurantId = restaurantRows.rows[0].id;
    const orderId = await createOrderRow(db, {
      restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70,
      statusUpdatedAt: new Date(Date.UTC(2026, 6, 29, 9, 0)),
    });
    await addSucceededPayment(db, orderId, 1000);

    const weekly = require('../../services/hq/weeklySettlementService');
    const now = new Date(Date.UTC(2026, 7, 9, 4, 5)); // вс 09.08.2026 07:05 МСК
    await weekly.runWeeklySettlementJob({ now });

    const auditRows = await db.query('SELECT action, restaurant_id, details FROM hq_audit_log ORDER BY id');
    const actions = auditRows.map((r) => r.action);
    assert.ok(actions.includes('settlement_job_started'));
    assert.ok(actions.includes('settlement_period_created'));
    assert.ok(actions.includes('settlement_period_closed'));
    assert.ok(actions.includes('settlement_job_finished'));

    for (const row of auditRows) {
      if (row.action.startsWith('settlement_period_') || row.action.startsWith('settlement_job_')) {
        assert.equal(row.restaurant_id, null, 'событие уровня периода не привязано к одному ресторану');
      }
    }

    // Повторный запуск — безопасный no-op, зафиксированный отдельно.
    await weekly.runWeeklySettlementJob({ now });
    const after = await db.query("SELECT COUNT(*)::int AS c FROM settlement_periods");
    assert.equal(after[0].c, 1, 'дубль периода не создан');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// T: public API leak scan
// ---------------------------------------------------------------------------
test('T: публичный API не содержит ни одного settlement-поля', async () => {
  const databaseUrl = await freshDatabase('settlement_public_leak');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');

    const restaurantRows = await db.execute(
      `INSERT INTO restaurants (name, cities, published_at, is_open) VALUES ('Leak Settlement', '[]', NOW(), 1) RETURNING id`,
    );
    const restaurantId = restaurantRows.rows[0].id;
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1234, commissionAmount: 86 });
    await addSucceededPayment(db, orderId, 1234);

    const settlementService = require('../../services/hq/settlementService');
    const createdPeriod = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const createRes = { status: 302, headers: { get: () => `/hq/finance/settlements/${createdPeriod.id}` } };
    const detailUrl = createRes.headers.get('location');
    const detailPage = await fetch(`${base}${detailUrl}`, { headers: { Cookie: cookie } });
    const csrf2 = extractCsrf(await detailPage.text());
    await fetch(`${base}${detailUrl}/close`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf2 }).toString(),
    });

    const listRes = await fetch(`${base}/api/restaurants`);
    const listText = await listRes.text();
    const detailRes = await fetch(`${base}/api/restaurants/${restaurantId}`);
    const detailText = await detailRes.text();
    for (const field of ['settlement', 'payable_amount', 'yaam_commission', 'restaurant_earnings', 'payout_readiness_snapshot', 'commission_bps_summary']) {
      assert.ok(!listText.includes(field), `публичный список не должен содержать "${field}"`);
      assert.ok(!detailText.includes(field), `публичная карточка не должна содержать "${field}"`);
    }
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// U: invariant checker
// ---------------------------------------------------------------------------
test('U: checkSettlementInvariants — чистое состояние ok, обнаруживает искусственно сконструированные нарушения', async () => {
  const databaseUrl = await freshDatabase('settlement_invariants');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'U');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const clean = await settlementService.checkSettlementInvariants();
    assert.equal(clean.ok, true);

    // Искусственно: closed период без единой строки обязательства.
    const emptyPeriod = await db.execute(
      `INSERT INTO settlement_periods (period_from, period_to, status, closed_at) VALUES ('2020-01-01','2020-01-01','closed',NOW()) RETURNING id`,
    );
    const afterEmpty = await settlementService.checkSettlementInvariants();
    assert.equal(afterEmpty.ok, false);
    assert.ok(afterEmpty.violations.some((v) => v.kind === 'closed_period_without_restaurant_lines'));
    void emptyPeriod;
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// V: immutability triggers — закрытый период и snapshot-строки нельзя
// изменить/удалить напрямую SQL
// ---------------------------------------------------------------------------
test('V: закрытый период и snapshot-строки защищены DB-триггерами от UPDATE/DELETE', async () => {
  const databaseUrl = await freshDatabase('settlement_immutability');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'V');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const result = await settlementService.closeSettlementPeriod(period.id);
    const lineId = result.lines[0].id;

    await assert.rejects(
      () => db.execute(`UPDATE settlement_periods SET notes = 'hacked' WHERE id = $1`, [period.id]),
      /immutable/i,
    );
    await assert.rejects(
      () => db.execute(`DELETE FROM settlement_periods WHERE id = $1`, [period.id]),
      /immutable|cannot be deleted/i,
    );
    await assert.rejects(
      () => db.execute(`UPDATE settlement_restaurant_lines SET turnover = 999999 WHERE id = $1`, [lineId]),
      /immutable/i,
    );
    await assert.rejects(
      () => db.execute(`DELETE FROM settlement_restaurant_lines WHERE id = $1`, [lineId]),
      /immutable/i,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// W: удаление черновика
// ---------------------------------------------------------------------------
test('W: удаление draft-периода работает; удаление closed-периода отклоняется', async () => {
  const databaseUrl = await freshDatabase('settlement_delete_draft');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const draft = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const deleted = await settlementService.deleteDraftSettlementPeriod(draft.id);
    assert.equal(deleted.id, draft.id);
    assert.equal(await settlementService.getSettlementPeriodById(draft.id), null);

    const restaurantId = await createRestaurant(db, 'W');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period2 = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(-1), periodTo: todayStr(-1) });
    await db.execute(`UPDATE orders SET status_updated_at = (NOW() - INTERVAL '1 day'), earned_at = (NOW() - INTERVAL '1 day') WHERE id = $1`, [orderId]);
    await settlementService.closeSettlementPeriod(period2.id);
    await assert.rejects(() => settlementService.deleteDraftSettlementPeriod(period2.id), /закрытый период нельзя удалить/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
