'use strict';

// YAAM HQ Stage 7 — интеграционные тесты финансового учёта против настоящего
// embedded PostgreSQL (задание, раздел 14B). Тот же harness-паттерн, что и
// hqRestaurantLegalBankStage6.test.js/hqMediaStage5B.test.js.
//
// A — оплаченный доставленный заказ учитывается.
// B — оплаченный, но недоставленный — не учитывается.
// C — доставленный без успешной оплаты — не учитывается (defensive, state
//     machine структурно этого не допускает, но проверяем данные, не код).
// D — cancelled/declined/timed_out — не учитываются.
// E — полный refund succeeded на delivered+paid (сконструировано напрямую
//     через SQL — структурно недостижимо через текущий жизненный цикл
//     заказа, см. server/services/hq/restaurantFinanceService.js за полным
//     обоснованием) — исключается из заработка, попадает в successfulRefunds.
// F — refund requested/processing/failed — НЕ считается успешным, заказ
//     остаётся заработком.
// G — два ресторана не смешиваются.
// H — изменение комиссии влияет только на новые заказы (см. отдельный файл
//     resolveCommissionBpsStage7.test.js за полным покрытием этой темы).
// I — повторный webhook (повторный UPDATE payments/orders до того же
//     значения) не удваивает агрегат.
// J — диапазоны дат (today/7d/30d/custom).
// K — пустой период -> нули, не ошибка.
// L — отрицательный payable balance невозможен (invariant check).
// M — public API leak scan.
// N — auth/no-store.
// O — dashboardMetrics.getFinanceSummary согласован с restaurantFinanceService.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

// См. server/test/postgresql/hqRestaurantLegalBankStage6.test.js — тот же
// полный список модулей, которые где-либо делают require('.../db/postgresql'),
// расширенный restaurantFinanceService.js/orderService.js (Stage 7).
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
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'g'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage7Finance';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-finance-stage7');
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
// Прямое построение фикстур через SQL (тот же принцип, что уже используется
// в hqMediaStage5B.test.js/hqRestaurantLegalBankStage6.test.js — быстрее и
// точнее контролирует статус/даты, чем ведение заказа через полный HTTP-flow
// для КАЖДОГО сценария этого файла).
// ---------------------------------------------------------------------------
async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
// Stage 33.1 — earned_at теперь единственный якорь финансового времени
// (см. restaurantFinanceService.js). Эта фикстура пишет заказ напрямую SQL
// (в обход orderService.restaurantAdvance, которая в реальном приложении
// устанавливает earned_at атомарно) — поэтому для status='delivered' она
// сама выставляет earned_at = тот же момент, что и status_updated_at,
// ровно тем же принципом, что и backfill в миграции 0013: для этого теста
// НЕ delivery/pickup-путь важен, а сам факт "заказ доставлен" — earned_at
// должен существовать, иначе заказ структурно не попадёт ни в один
// финансовый диапазон (earned_at IS NULL никогда не проходит >=/< сравнение).
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null, phone = null }) {
  orderCounter += 1;
  const code = `YAAM-T${orderCounter}`;
  const phoneValue = phone || `+7900${String(orderCounter).padStart(7, '0')}`;
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,COALESCE($7, NOW()),
       CASE WHEN $6 = 'delivered' THEN COALESCE($7, NOW()) ELSE NULL END)
     RETURNING id`,
    [code, restaurantId, phoneValue, itemsTotal, commissionAmount, status, statusUpdatedAt],
  );
  return rows.rows[0].id;
}

async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`,
    [orderId, amount],
  );
  return rows.rows[0].id;
}

async function addRefund(db, paymentId, { amount, status = 'succeeded', reason = 'customer_cancel' }) {
  const key = `refund-key-${paymentId}-${crypto.randomBytes(4).toString('hex')}`;
  const rows = await db.execute(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [paymentId, amount, status, reason, key],
  );
  return rows.rows[0].id;
}

// ---------------------------------------------------------------------------
// A-D — какие заказы считаются заработком
// ---------------------------------------------------------------------------
test('A: оплаченный доставленный заказ учитывается в заработке', async () => {
  const databaseUrl = await freshDatabase('finance_earned_order');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'A');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered' });
    await addSucceededPayment(db, orderId, 1000);

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 1);
    assert.equal(position.turnover, 1000);
    assert.equal(position.commission, 70);
    assert.equal(position.restaurantEarnings, 930);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B: оплаченный заказ БЕЗ earned_at (ещё не заработан рестораном) не учитывается', async () => {
  const databaseUrl = await freshDatabase('finance_paid_not_delivered');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'B');
    // Stage 33.2 — 'courier' сознательно убран из этого списка: с новым
    // gate'ом earned_at IS NOT NULL РЕАЛЬНЫЙ courier-заказ (после
    // ready->courier через restaurantAdvance) уже финансово учтён — см.
    // server/test/postgresql/financialEligibilityStage332.test.js, тест A.
    // Здесь остаются только статусы, которые СТРУКТУРНО никогда не получают
    // earned_at (createOrderRow создаёт их напрямую SQL, без реального
    // restaurantAdvance-перехода — earned_at физически NULL).
    for (const status of ['awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing']) {
      const orderId = await createOrderRow(db, { restaurantId, status });
      await addSucceededPayment(db, orderId, 1000);
    }
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 0);
    assert.equal(position.turnover, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C: доставленный заказ БЕЗ succeeded-платежа не учитывается (defensive)', async () => {
  const databaseUrl = await freshDatabase('finance_delivered_unpaid');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'C');
    await createOrderRow(db, { restaurantId, status: 'delivered' }); // без payments вовсе
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 0);

    const invariants = await financeService.checkFinancialInvariants();
    assert.equal(invariants.ok, false);
    // Stage 33.2 — переименовано в earned_without_succeeded_payment
    // (courier добавлен к delivered, см. restaurantFinanceService.js).
    assert.ok(invariants.violations.some((v) => v.kind === 'earned_without_succeeded_payment'));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('D: cancelled/declined/timed_out/payment_failed не учитываются', async () => {
  const databaseUrl = await freshDatabase('finance_terminal_non_delivered');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'D');
    for (const status of ['cancelled', 'declined', 'timed_out', 'payment_failed']) {
      await createOrderRow(db, { restaurantId, status });
    }
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 0);
    assert.equal(position.turnover, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// E-F — возвраты
// ---------------------------------------------------------------------------
test('E: delivered+paid+succeeded refund (сконструировано напрямую) исключается из заработка, попадает в successfulRefunds', async () => {
  const databaseUrl = await freshDatabase('finance_delivered_refunded');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'E');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered' });
    const paymentId = await addSucceededPayment(db, orderId, 1000);
    await addRefund(db, paymentId, { amount: 1000, status: 'succeeded' });

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 0, 'возвращённый заказ не должен считаться заработком');
    assert.equal(position.turnover, 0);
    assert.equal(position.commission, 0);
    assert.equal(position.restaurantEarnings, 0);
    assert.equal(position.successfulRefunds, 1000);
    assert.equal(position.successfulRefundsCount, 1);
    assert.equal(position.payableBalance, 0, 'возвращённый заказ не должен создавать остаток к выплате');

    const invariants = await financeService.checkFinancialInvariants();
    assert.equal(invariants.ok, true, 'корректно исключённый возврат — не нарушение инварианта');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('F: refund requested/processing/failed НЕ считается успешным — заказ остаётся заработком', async () => {
  const databaseUrl = await freshDatabase('finance_refund_not_succeeded');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'F');
    for (const refundStatus of ['requested', 'processing', 'failed']) {
      const orderId = await createOrderRow(db, { restaurantId, status: 'delivered' });
      const paymentId = await addSucceededPayment(db, orderId, 1000);
      await addRefund(db, paymentId, { amount: 1000, status: refundStatus });
    }
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 3, 'ни один незавершённый возврат не должен исключать заказ из заработка');
    assert.equal(position.turnover, 3000);
    assert.equal(position.successfulRefunds, 0, 'незавершённые возвраты не считаются успешными');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// G — изоляция между ресторанами
// ---------------------------------------------------------------------------
test('G: два ресторана не смешиваются', async () => {
  const databaseUrl = await freshDatabase('finance_isolation');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantA = await createRestaurant(db, 'Iso A');
    const restaurantB = await createRestaurant(db, 'Iso B');
    const orderA = await createOrderRow(db, { restaurantId: restaurantA, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderA, 1000);
    const orderB = await createOrderRow(db, { restaurantId: restaurantB, status: 'delivered', itemsTotal: 2000, commissionAmount: 140 });
    await addSucceededPayment(db, orderB, 2000);

    const positionA = await financeService.getRestaurantFinancialPosition(restaurantA);
    const positionB = await financeService.getRestaurantFinancialPosition(restaurantB);
    assert.equal(positionA.turnover, 1000);
    assert.equal(positionB.turnover, 2000);

    const list = await financeService.listRestaurantsFinancialPositions();
    const rowA = list.find((r) => r.restaurantId === restaurantA);
    const rowB = list.find((r) => r.restaurantId === restaurantB);
    assert.equal(rowA.turnover, 1000);
    assert.equal(rowB.turnover, 2000);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// I — повторный webhook не удваивает агрегат
// ---------------------------------------------------------------------------
test('I: повторное подтверждение той же оплаты (повторный UPDATE до succeeded) не удваивает агрегат', async () => {
  const databaseUrl = await freshDatabase('finance_idempotent_webhook');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'I');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered' });
    const paymentId = await addSucceededPayment(db, orderId, 1000);
    // "Повторный webhook" — идемпотентный UPDATE того же payment в тот же
    // статус (ровно так это устроено в markPaid()/finalizeInitialAttempt() —
    // conditional UPDATE, не INSERT новой строки).
    await db.execute(`UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1`, [paymentId]);
    await db.execute(`UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1`, [paymentId]);

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 1, 'один заказ должен остаться одним заказом независимо от количества повторных webhook');
    assert.equal(position.turnover, 1000);

    const invariants = await financeService.checkFinancialInvariants();
    assert.equal(invariants.ok, true);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// J-K — диапазоны дат
// ---------------------------------------------------------------------------
test('J: диапазон "today" не включает заказ, доставленный вчера', async () => {
  const databaseUrl = await freshDatabase('finance_period_today');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'J');
    const todayOrder = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, todayOrder, 1000);
    const yesterdayOrder = await createOrderRow(db, {
      restaurantId, status: 'delivered', itemsTotal: 2000, commissionAmount: 140,
      statusUpdatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    await addSucceededPayment(db, yesterdayOrder, 2000);

    const today = await financeService.getRestaurantFinancialPosition(restaurantId, { period: 'today' });
    assert.equal(today.turnover, 1000, '"сегодня" не должно включать вчерашний заказ');

    const sevenDays = await financeService.getRestaurantFinancialPosition(restaurantId, { period: '7d' });
    assert.equal(sevenDays.turnover, 3000, '"7 дней" должно включать оба заказа');

    const allTime = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(allTime.turnover, 3000, 'без периода — все заказы');
    // payableBalance ВСЕГДА за всё время, даже при периоде "сегодня".
    assert.equal(today.payableBalance, allTime.restaurantEarnings);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('K: пустой период — нули, не ошибка', async () => {
  const databaseUrl = await freshDatabase('finance_empty_period');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'K');
    const position = await financeService.getRestaurantFinancialPosition(restaurantId, { period: 'today' });
    assert.deepEqual(position, {
      restaurantId,
      turnover: 0,
      commission: 0,
      restaurantEarnings: 0,
      successfulRefunds: 0,
      successfulRefundsCount: 0,
      deliveredPaidOrders: 0,
      paidOut: 0,
      payableBalance: 0,
      payoutReadiness: 'missing_legal_details',
    });
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// L — отрицательный payable balance невозможен
// ---------------------------------------------------------------------------
test('L: отрицательный payable balance невозможен даже при commission_amount, искусственно превышающем items_total', async () => {
  const databaseUrl = await freshDatabase('finance_negative_balance');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'L');
    // Искусственно испорченные данные (в обход сервисного слоя, ни один
    // легитимный путь не может создать commission_amount > items_total —
    // commission_bps CHECK 0..10000) — invariant-check должен это заметить.
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 100, commissionAmount: 500 });
    await addSucceededPayment(db, orderId, 100);

    const invariants = await financeService.checkFinancialInvariants();
    assert.equal(invariants.ok, false);
    assert.ok(invariants.violations.some((v) => v.kind === 'negative_restaurant_earnings'));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// M — public API leak scan
// ---------------------------------------------------------------------------
test('M: публичный API не содержит финансовых полей (commission_amount/commission_bps и т.п.)', async () => {
  const databaseUrl = await freshDatabase('finance_public_leak');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const createPage = await fetch(`${base}/hq/restaurants/new`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await createPage.text());
    const createRes = await fetch(`${base}/hq/restaurants`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, name: 'Leak Restaurant', cities: 'Грозный' }).toString(),
    });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());

    // Публичный API фильтрует archived_at/published_at (см.
    // routes/postgresql/api.js) — без публикации оба запроса ниже вернули бы
    // пустой список/404 и проверка на утечку полей ничего бы не проверяла.
    const restaurantPage = await fetch(`${base}${restaurantPath}`, { headers: { Cookie: cookie } });
    const restaurantCsrf = extractCsrf(await restaurantPage.text());
    const publishRes = await fetch(`${base}${restaurantPath}/publish`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: restaurantCsrf }).toString(),
    });
    assert.equal(publishRes.status, 302, 'публикация ресторана должна пройти успешно');

    const db = require('../../db/postgresql');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1234, commissionAmount: 86 });
    await addSucceededPayment(db, orderId, 1234);

    const listRes = await fetch(`${base}/api/restaurants`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.some((r) => r.id === restaurantId), 'опубликованный ресторан должен появиться в публичном списке');
    const listText = JSON.stringify(listBody);

    const detailRes = await fetch(`${base}/api/restaurants/${restaurantId}`);
    assert.equal(detailRes.status, 200, 'опубликованный ресторан должен быть доступен по прямой ссылке');
    const detailText = await detailRes.text();

    for (const field of ['commission_amount', 'commission_bps', 'commissionBps', 'items_total', 'restaurant_earnings', 'payableBalance', 'payable_balance']) {
      assert.ok(!listText.includes(field), `публичный список не должен содержать поле "${field}"`);
      assert.ok(!detailText.includes(field), `публичная карточка не должна содержать поле "${field}"`);
    }
    assert.ok(!listText.includes('86'), 'сумма комиссии не должна утекать в публичный список');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// N — auth/no-store
// ---------------------------------------------------------------------------
test('N: /hq/finance без сессии -> редирект на логин; с сессией -> no-store', async () => {
  const databaseUrl = await freshDatabase('finance_auth_no_store');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const unauthedRes = await fetch(`${base}/hq/finance`, { redirect: 'manual' });
    assert.equal(unauthedRes.status, 302);
    assert.match(unauthedRes.headers.get('location') || '', /login/);

    const cookie = await loginHq(base);
    const authedRes = await fetch(`${base}/hq/finance`, { headers: { Cookie: cookie } });
    assert.equal(authedRes.status, 200);
    assert.equal(authedRes.headers.get('cache-control'), 'no-store');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// O — dashboardMetrics.getFinanceSummary согласован с restaurantFinanceService
// ---------------------------------------------------------------------------
test('O: dashboardMetrics.getFinanceSummary("сегодня") даёт те же числа, что и restaurantFinanceService', async () => {
  const databaseUrl = await freshDatabase('finance_dashboard_consistency');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  delete require.cache[require.resolve('../../services/hq/dashboardMetrics')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  const dashboardMetrics = require('../../services/hq/dashboardMetrics');
  try {
    const restaurantId = await createRestaurant(db, 'O');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    const paymentId = await addSucceededPayment(db, orderId, 1000);
    // Ещё один заказ ВЧЕРА с succeeded-возвратом — не должен попасть НИ в
    // getFinanceSummary (today), НИ создать расхождение между источниками.
    const refundedOrder = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 500, commissionAmount: 35 });
    const refundedPaymentId = await addSucceededPayment(db, refundedOrder, 500);
    await addRefund(db, refundedPaymentId, { amount: 500, status: 'succeeded' });
    void paymentId;

    const summary = await dashboardMetrics.getFinanceSummary(db);
    const positions = await financeService.listRestaurantsFinancialPositions({ period: 'today' });
    const overall = financeService.summarizeOverall(positions);

    assert.equal(summary.turnover, overall.turnover);
    assert.equal(summary.commission, overall.commission);
    assert.equal(summary.restaurantsShare, overall.restaurantEarnings);
    assert.equal(summary.refundedAmount, overall.successfulRefunds);
    assert.equal(summary.refundedOrders, overall.successfulRefundsCount);
    // Явная сверка формулы (задание, раздел 10): комиссия/оборот не должны
    // включать возвращённый заказ.
    assert.equal(summary.turnover, 1000);
    assert.equal(summary.commission, 70);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
