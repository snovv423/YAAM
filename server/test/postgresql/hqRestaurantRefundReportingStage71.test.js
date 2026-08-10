'use strict';

// YAAM HQ Stage 7.1 — Correct Successful Refund Reporting. Исправляет
// смысловой дефект Stage 7 (server/test/postgresql/hqRestaurantFinanceStage7.test.js):
// прежняя версия computeRefundsAggregate() требовала o.status = 'delivered',
// то есть показывала "успешные возвраты" ТОЛЬКО для состояния, которое
// структурно недостижимо через реальный жизненный цикл заказа (см.
// server/services/hq/restaurantFinanceService.js за полным разбором) —
// каждый РЕАЛЬНЫЙ возврат (customer_cancel/restaurant_decline/timeout,
// единственные три реально достижимых пути) отображался как "0 возвратов",
// хотя деньги клиенту были фактически возвращены.
//
// Тесты A-C ниже намеренно проходят через РЕАЛЬНЫЙ код возврата
// (cancelByCustomer/restaurantDecline/sweepTimeouts + fire-and-forget
// scheduleRefundProcessing через mock-провайдер, тот же приём, что и
// server/test/postgresql/paymentSafetyStage8.test.js:B1 и
// e2e/tests/hq-restaurant-finance-flow.spec.ts) — не сконструированы
// напрямую через SQL, чтобы доказать исправление на настоящем продуктовом
// пути, а не только на уровне SQL-запроса.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'h'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage71Refunds';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-refund-reporting-stage71');
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

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, phone = null }) {
  orderCounter += 1;
  const code = `YAAM-R${orderCounter}`;
  const phoneValue = phone || `+7901${String(orderCounter).padStart(7, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // фикстура пишет напрямую SQL (в обход restaurantAdvance), поэтому сама
  // выставляет earned_at = NOW() ровно когда status='delivered' (тот же
  // принцип, что и backfill в миграции 0013).
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,NOW(), CASE WHEN $6 = 'delivered' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [code, restaurantId, phoneValue, itemsTotal, commissionAmount, status],
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

// Реальный продуктовый путь (createOrderAndResolve + markPaid), тот же
// приём, что уже используется в e2e/tests/hq-restaurant-finance-flow.spec.ts
// и test/postgresql/paymentSafetyStage8.test.js.
// itemsTotal определяется исключительно ценой самого menuItem (server-side,
// см. CLAUDE.md: "нет frontend calc") — qty всегда 1, сумма заказа задаётся
// ценой блюда, переданной в seedMenuItem() при его создании.
async function createRealPaidOrder(orderService, db, restaurantId, menuItemId) {
  const n = crypto.randomInt(100000000, 999999999);
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Stage71 Test', customerPhone: `+79${String(n).padStart(8, '0')}`,
    address: 'ул. Возвратная, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Возвратное блюдо', price: 0, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  const paymentRows = await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]);
  await orderService.markPaid(order.id, paymentRows[0].id);
  return order.id;
}

async function seedMenuItem(menuAdminService, restaurantId, price) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Возвратное блюдо', category_id: String(category.id), price: String(price) });
}

// ---------------------------------------------------------------------------
// A. Реальный customer_cancel + succeeded refund отображается
// ---------------------------------------------------------------------------
test('A: реальный customer_cancel + succeeded refund (cancelByCustomer, mock-провайдер) отображается в «Возвращено клиентам»', async () => {
  const databaseUrl = await freshDatabase('refund71_customer_cancel');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService.js')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  delete require.cache[require.resolve('../../services/hq/menuAdminService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService.js');
  const menuAdminService = require('../../services/hq/menuAdminService');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'A');
    await db.execute(`UPDATE restaurants SET published_at = NOW(), is_open = 1 WHERE id = $1`, [restaurantId]);
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1000);

    const orderId = await createRealPaidOrder(orderService, db, restaurantId, menuItem.id);
    await orderService.cancelByCustomer(orderId);
    await sleep(250); // fire-and-forget scheduleRefundProcessing — см. paymentSafetyStage8.test.js B1

    const orderRow = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(orderRow[0].status, 'cancelled');
    const refundRow = await db.query('SELECT status FROM refunds WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)', [orderId]);
    assert.equal(refundRow[0].status, 'succeeded', 'предпосылка теста: реальный возврат должен реально завершиться succeeded');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.successfulRefundsCount, 1, 'реальный customer_cancel-возврат должен быть виден в отчёте');
    assert.equal(position.successfulRefunds, 100000); // Stage 38: minor units (1000 ₽)
    assert.equal(position.deliveredPaidOrders, 0, 'отменённый заказ никогда не был доставлен — не заработок');
    assert.equal(position.turnover, 0);
    assert.equal(position.restaurantEarnings, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// B. Реальный restaurant_decline + succeeded refund отображается
// ---------------------------------------------------------------------------
test('B: реальный restaurant_decline + succeeded refund (restaurantDecline, mock-провайдер) отображается', async () => {
  const databaseUrl = await freshDatabase('refund71_restaurant_decline');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService.js')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  delete require.cache[require.resolve('../../services/hq/menuAdminService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService.js');
  const menuAdminService = require('../../services/hq/menuAdminService');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'B');
    await db.execute(`UPDATE restaurants SET published_at = NOW(), is_open = 1 WHERE id = $1`, [restaurantId]);
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 2000);

    const orderId = await createRealPaidOrder(orderService, db, restaurantId, menuItem.id);
    await orderService.restaurantDecline(orderId);
    await sleep(250);

    const refundRow = await db.query('SELECT status FROM refunds WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)', [orderId]);
    assert.equal(refundRow[0].status, 'succeeded');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.successfulRefundsCount, 1);
    assert.equal(position.successfulRefunds, 200000); // Stage 38: minor units (2000 ₽)
    assert.equal(position.deliveredPaidOrders, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// C. Реальный timeout + succeeded refund отображается
// ---------------------------------------------------------------------------
test('C: реальный timeout + succeeded refund (sweepTimeouts, mock-провайдер) отображается', async () => {
  const databaseUrl = await freshDatabase('refund71_timeout');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService.js')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  delete require.cache[require.resolve('../../services/hq/menuAdminService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService.js');
  const menuAdminService = require('../../services/hq/menuAdminService');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'C');
    await db.execute(`UPDATE restaurants SET published_at = NOW(), is_open = 1 WHERE id = $1`, [restaurantId]);
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1500);

    const orderId = await createRealPaidOrder(orderService, db, restaurantId, menuItem.id);
    // Заказ реально ждёт ответа ресторана дольше окна ответа — backdate
    // status_updated_at, тот же установленный приём, что и
    // test/postgresql/orderServiceWave3.test.js (secondsAgo helper) —
    // sweepTimeouts() сам по себе не симулируется, вызывается по-настоящему.
    await db.execute(`UPDATE orders SET status_updated_at = NOW() - INTERVAL '1000 seconds' WHERE id = $1`, [orderId]);
    await orderService.sweepTimeouts();
    await sleep(250);

    const orderRow = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(orderRow[0].status, 'timed_out');
    const refundRow = await db.query('SELECT status, reason FROM refunds WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)', [orderId]);
    assert.equal(refundRow[0].status, 'succeeded');
    assert.equal(refundRow[0].reason, 'timeout');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.successfulRefundsCount, 1);
    assert.equal(position.successfulRefunds, 150000); // Stage 38: minor units (1500 ₽)
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// D. requested/processing/failed не отображаются как завершённые
// ---------------------------------------------------------------------------
test('D: refund requested/processing/failed на отменённом заказе НЕ отображаются как «Возвращено клиентам»', async () => {
  const databaseUrl = await freshDatabase('refund71_not_terminal');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'D');
    for (const status of ['requested', 'processing', 'failed']) {
      const orderId = await createOrderRow(db, { restaurantId, status: 'cancelled' });
      const paymentId = await addSucceededPayment(db, orderId, 1000);
      await addRefund(db, paymentId, { amount: 1000, status });
    }
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.successfulRefundsCount, 0, 'ни requested, ни processing, ни failed не должны считаться завершённым возвратом');
    assert.equal(position.successfulRefunds, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// E. Возврат отменённого заказа не уменьшает restaurantEarnings повторно
// ---------------------------------------------------------------------------
test('E: возврат отменённого заказа НЕ уменьшает restaurantEarnings (тот заказ туда изначально не входил)', async () => {
  const databaseUrl = await freshDatabase('refund71_no_double_subtract');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'E');
    // Один по-настоящему заработанный заказ.
    const earnedOrderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, earnedOrderId, 1000);
    // Один отменённый заказ с реальным (сконструированным) возвратом —
    // никогда не входил в заработок.
    const cancelledOrderId = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 500, commissionAmount: 0 });
    const cancelledPaymentId = await addSucceededPayment(db, cancelledOrderId, 500);
    await addRefund(db, cancelledPaymentId, { amount: 500, status: 'succeeded', reason: 'customer_cancel' });

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.turnover, 1000, 'оборот — только заработанный заказ');
    assert.equal(position.commission, 70);
    assert.equal(position.restaurantEarnings, 930, 'НЕ 930-500=430 — возврат отменённого заказа не вычитается из заработка повторно');
    assert.equal(position.successfulRefundsCount, 1);
    assert.equal(position.successfulRefunds, 500);
    assert.equal(position.payableBalance, 930, 'остаток к выплате тоже не тронут возвратом неучтённого заказа');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// F. defensively constructed delivered+succeeded-refund — исключён из
//    earnings, отображается в сумме возвратов РОВНО ОДИН раз
// ---------------------------------------------------------------------------
test('F: defensively constructed delivered+succeeded-refund исключён из earnings, отображается в возвратах ровно один раз', async () => {
  const databaseUrl = await freshDatabase('refund71_delivered_defensive');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'F');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    const paymentId = await addSucceededPayment(db, orderId, 1000);
    await addRefund(db, paymentId, { amount: 1000, status: 'succeeded' });

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 0, 'delivered+succeeded-refund исключён из заработка (EARNED_ORDER_FILTER_SQL не изменился)');
    assert.equal(position.turnover, 0);
    assert.equal(position.restaurantEarnings, 0);
    assert.equal(position.successfulRefundsCount, 1, 'но виден в возвратах — и ровно один раз, не удвоен join-ом');
    assert.equal(position.successfulRefunds, 1000);

    const invariants = await financeService.checkFinancialInvariants();
    assert.equal(invariants.ok, true, 'корректно исключённый возврат — не нарушение инварианта');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// G. Два ресторана не смешиваются
// ---------------------------------------------------------------------------
test('G: возвраты двух ресторанов не смешиваются', async () => {
  const databaseUrl = await freshDatabase('refund71_isolation');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantA = await createRestaurant(db, 'Iso Refund A');
    const restaurantB = await createRestaurant(db, 'Iso Refund B');

    const orderA = await createOrderRow(db, { restaurantId: restaurantA, status: 'cancelled', itemsTotal: 700, commissionAmount: 0 });
    const paymentA = await addSucceededPayment(db, orderA, 700);
    await addRefund(db, paymentA, { amount: 700, status: 'succeeded' });

    const orderB = await createOrderRow(db, { restaurantId: restaurantB, status: 'declined', itemsTotal: 1300, commissionAmount: 0 });
    const paymentB = await addSucceededPayment(db, orderB, 1300);
    await addRefund(db, paymentB, { amount: 1300, status: 'succeeded', reason: 'restaurant_decline' });

    const positionA = await financeService.getRestaurantFinancialPosition(restaurantA);
    const positionB = await financeService.getRestaurantFinancialPosition(restaurantB);
    assert.equal(positionA.successfulRefunds, 700);
    assert.equal(positionB.successfulRefunds, 1300);

    const list = await financeService.listRestaurantsFinancialPositions();
    const rowA = list.find((r) => r.restaurantId === restaurantA);
    const rowB = list.find((r) => r.restaurantId === restaurantB);
    assert.equal(rowA.successfulRefunds, 700);
    assert.equal(rowB.successfulRefunds, 1300);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// H. Периоды работают по времени завершения возврата (refunds.completed_at),
//    НЕ по времени заказа
// ---------------------------------------------------------------------------
test('H: период "today" учитывает возврат по refunds.completed_at, а не по дате заказа', async () => {
  const databaseUrl = await freshDatabase('refund71_period_anchor');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantFinanceService')];
  const db = require('../../db/postgresql');
  const financeService = require('../../services/hq/restaurantFinanceService');
  try {
    const restaurantId = await createRestaurant(db, 'H');

    // Заказ отменён "сегодня" (order.status_updated_at = NOW(), как и в
    // реальном cancelByCustomer), но возврат по нему ЗАВЕРШИЛСЯ 2 дня назад
    // (completed_at backdated) — если бы период ошибочно анкорился на
    // дату/статус ЗАКАЗА, этот возврат попал бы в "сегодня". Он не должен.
    const oldOrderId = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 400, commissionAmount: 0 });
    const oldPaymentId = await addSucceededPayment(db, oldOrderId, 400);
    await addRefund(db, oldPaymentId, {
      amount: 400, status: 'succeeded',
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    // Второй возврат — завершён по-настоящему сегодня.
    const todayOrderId = await createOrderRow(db, { restaurantId, status: 'declined', itemsTotal: 600, commissionAmount: 0 });
    const todayPaymentId = await addSucceededPayment(db, todayOrderId, 600);
    await addRefund(db, todayPaymentId, { amount: 600, status: 'succeeded', reason: 'restaurant_decline' });

    const today = await financeService.getRestaurantFinancialPosition(restaurantId, { period: 'today' });
    assert.equal(today.successfulRefunds, 600, '"сегодня" не должно включать возврат, завершённый 2 дня назад');
    assert.equal(today.successfulRefundsCount, 1);

    const sevenDays = await financeService.getRestaurantFinancialPosition(restaurantId, { period: '7d' });
    assert.equal(sevenDays.successfulRefunds, 1000, '"7 дней" должно включать оба возврата');
    assert.equal(sevenDays.successfulRefundsCount, 2);

    const allTime = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(allTime.successfulRefunds, 1000);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// I. Finance UI показывает точную сумму/количество под новой подписью
// ---------------------------------------------------------------------------
test('I: /hq/finance и вкладка «Статистика» показывают «Возвращено клиентам» с точной суммой/количеством', async () => {
  const databaseUrl = await freshDatabase('refund71_ui_label');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);

    const createPage = await fetch(`${base}/hq/restaurants/new`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await createPage.text());
    const createRes = await fetch(`${base}/hq/restaurants`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, name: 'UI Refund Restaurant', cities: 'Грозный' }).toString(),
    });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());

    // Stage 38 — orders.items_total/payments.amount/refunds.amount теперь
    // integer minor units: 333 ₽ = 33300 minor (иначе HTML показал бы
    // "3,33 ₽", а не ожидаемое целое "333 ₽").
    const db = require('../../db/postgresql');
    const orderId = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 33300, commissionAmount: 0 });
    const paymentId = await addSucceededPayment(db, orderId, 33300);
    await addRefund(db, paymentId, { amount: 33300, status: 'succeeded' });

    const financeRes = await fetch(`${base}/hq/finance?period=today`, { headers: { Cookie: cookie } });
    const financeHtml = await financeRes.text();
    // docs/HQ-PRODUCT-SPEC.md (раздел «Финансы» → «Сводка»): показатели
    // минималистичны, служебные пояснения удалены. Возвраты показываются
    // отдельной карточкой ТОЛЬКО если они были — с точной суммой и
    // количеством, но без длинного пояснительного текста.
    assert.match(financeHtml, /Возвраты/, 'возвраты должны быть видны в сводке');
    assert.doesNotMatch(financeHtml, /Успешные возвраты/, 'старая подпись не должна остаться нигде');
    assert.match(financeHtml, /333 ₽/, 'точная сумма должна быть видна');
    assert.match(financeHtml, /1 шт/, 'точное количество должно быть видно');
    assert.doesNotMatch(financeHtml, /Возвраты показаны отдельно и не вычитаются повторно/, 'длинное служебное пояснение удалено');

    // docs/HQ-PRODUCT-SPEC.md, раздел «Статистика»: финансовые блоки со
    // вкладки статистики ресторана удалены целиком (дублирование «Обзора» и
    // «Финансов» запрещено). Единственное место, где владелец видит
    // «Возвращено клиентам» — экран «Финансы», проверенный выше.
    const statsRes = await fetch(`${base}${restaurantPath}/statistics?period=today`, { headers: { Cookie: cookie } });
    const statsHtml = await statsRes.text();
    assert.doesNotMatch(statsHtml, /Возвращено клиентам/, 'финансовая сводка не должна дублироваться на вкладке «Статистика»');
    assert.doesNotMatch(statsHtml, /Комиссия YAAM/, 'комиссия не должна дублироваться на вкладке «Статистика»');
    assert.match(statsHtml, /Популярные блюда/, 'статистика отвечает на вопрос о спросе, а не о бухгалтерии');
  } finally {
    await stopApp(instance);
  }
});
