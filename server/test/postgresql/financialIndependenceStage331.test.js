'use strict';

// YAAM Stage 33.1 — «отвязать финансовый заработок ресторана от кнопки
// «Заказ получен»». Доказывает пункты A-I задания через РЕАЛЬНЫЕ функции
// orderService (restaurantAdvance/confirmReceiptByCustomer/
// autoCompleteCourierOrders) и restaurantFinanceService/settlementService —
// не через прямые SQL-фикстуры, там, где это возможно, чтобы тест
// действительно проверял то, что делает production-код, а не повторял его
// формулу.
//
// Не переаудирует Stage 33 (state machine/Telegram/клиент/рейтинг/HQ) —
// только новый earned_at-якорь и его независимость от клиентской кнопки.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_financial_independence_331_test';

let cluster;
let db;
let pgOrderService;
let financeService;
let settlementService;
let resolvePeriodRange;

before(async () => {
  cluster = await startEmbeddedPostgres('financial-independence-331');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');
  financeService = require('../../services/hq/restaurantFinanceService.js');
  settlementService = require('../../services/hq/settlementService.js');
  ({ resolvePeriodRange } = require('../../services/hq/restaurantStatsService.js'));
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, phone) VALUES ('Test', 'test', '[]', '+79280000000') RETURNING id`
  );
  return rows[0].id;
}

async function pgCreateOrder(restaurantId, { status = 'preparing', fulfillmentType = 'delivery', statusUpdatedAt = null } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, fulfillment_type, status_updated_at
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, $3, $4,
       COALESCE($5, NOW()))
     RETURNING *`,
    [`YAAM-FI-${suffix}`, restaurantId, status, fulfillmentType, statusUpdatedAt]
  );
  return rows[0];
}

async function pgCreatePayment(orderId, { amount = 500, status = 'succeeded' } = {}) {
  const rows = await db.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3) RETURNING id`,
    [orderId, amount, status]
  );
  return rows[0].id;
}

async function earnedAtOf(orderId) {
  const row = (await db.query('SELECT earned_at FROM orders WHERE id = $1', [orderId]))[0];
  return row.earned_at;
}

// ===========================================================================
// A. ready -> courier фиксирует earned_at
// ===========================================================================

test('A. restaurantAdvance(ready->courier): earned_at устанавливается атомарно, был NULL', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  assert.equal(await earnedAtOf(order.id), null, 'до courier earned_at не должен быть установлен');

  await pgOrderService.restaurantAdvance(order.id, 'courier');

  const earnedAt = await earnedAtOf(order.id);
  assert.ok(earnedAt instanceof Date, 'earned_at должен быть установлен на courier');
});

test('A2. restaurantAdvance(preparing->ready) НЕ устанавливает earned_at (рано)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing' });
  await pgOrderService.restaurantAdvance(order.id, 'ready');
  assert.equal(await earnedAtOf(order.id), null, 'на ready earned_at ещё не должен быть установлен');
});

// ===========================================================================
// B. customer confirm НЕ меняет earned_at
// ===========================================================================

test('B. confirmReceiptByCustomer: earned_at (зафиксированный на courier) не меняется', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgOrderService.restaurantAdvance(order.id, 'courier');
  const earnedAtBefore = await earnedAtOf(order.id);

  await new Promise((r) => setTimeout(r, 50)); // гарантируем измеримую разницу, если бы earned_at перезаписывался
  await pgOrderService.confirmReceiptByCustomer(order.id);

  const earnedAtAfter = await earnedAtOf(order.id);
  assert.equal(earnedAtAfter.getTime(), earnedAtBefore.getTime(), 'клиентское подтверждение не должно менять earned_at');
});

// ===========================================================================
// C. auto-complete НЕ меняет earned_at
// ===========================================================================

test('C. autoCompleteCourierOrders: earned_at (зафиксированный на courier) не меняется', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgOrderService.restaurantAdvance(order.id, 'courier');
  const earnedAtBefore = await earnedAtOf(order.id);

  // Состариваем status_updated_at за порог auto-complete напрямую SQL —
  // тот же приём, что и в orderServiceStage33.test.js.
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000);
  await db.execute('UPDATE orders SET status_updated_at = $1 WHERE id = $2', [staleAt, order.id]);

  await pgOrderService.autoCompleteCourierOrders();

  const earnedAtAfter = await earnedAtOf(order.id);
  assert.equal(earnedAtAfter.getTime(), earnedAtBefore.getTime(), 'auto-complete не должен менять earned_at');
});

// ===========================================================================
// D. Одинаковый финансовый момент независимо от того, когда/как подтверждён заказ
// ===========================================================================

test('D. Два одинаковых заказа (confirm через 10мс vs auto-complete позже) дают ОДИНАКОВЫЙ earned_at — момент ready->courier', async () => {
  const restaurantId = await pgCreateRestaurant();

  const orderFast = await pgCreateOrder(restaurantId, { status: 'ready' });
  const orderSlow = await pgCreateOrder(restaurantId, { status: 'ready' });

  await pgOrderService.restaurantAdvance(orderFast.id, 'courier');
  await pgOrderService.restaurantAdvance(orderSlow.id, 'courier');

  const earnedAtFastAtCourier = await earnedAtOf(orderFast.id);
  const earnedAtSlowAtCourier = await earnedAtOf(orderSlow.id);

  await new Promise((r) => setTimeout(r, 10));
  await pgOrderService.confirmReceiptByCustomer(orderFast.id);

  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000);
  await db.execute('UPDATE orders SET status_updated_at = $1 WHERE id = $2', [staleAt, orderSlow.id]);
  await pgOrderService.autoCompleteCourierOrders();

  const fastFinal = await earnedAtOf(orderFast.id);
  const slowFinal = await earnedAtOf(orderSlow.id);

  assert.equal(fastFinal.getTime(), earnedAtFastAtCourier.getTime(), 'быстрый confirm не должен был сдвинуть earned_at');
  assert.equal(slowFinal.getTime(), earnedAtSlowAtCourier.getTime(), 'поздний auto-complete не должен был сдвинуть earned_at');
  // Оба заказа перешли в courier практически одновременно (последовательные
  // await без задержки между ними) — earned_at должен совпадать с точностью
  // до нормального джиттера теста, а не отличаться на порядки (что было бы
  // сигналом, что один из путей всё-таки пересчитал момент по-своему).
  assert.ok(
    Math.abs(fastFinal.getTime() - slowFinal.getTime()) < 5000,
    `earned_at обоих заказов должен быть близким (момент ready->courier), получено fast=${fastFinal.toISOString()} slow=${slowFinal.toISOString()}`,
  );
});

// ===========================================================================
// E. Double-click confirm-receipt не влияет на финансовые поля
// ===========================================================================

test('E. Двойной клик confirmReceiptByCustomer не меняет earned_at/items_total/commission_amount', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgOrderService.restaurantAdvance(order.id, 'courier');
  const earnedAtBefore = await earnedAtOf(order.id);

  await pgOrderService.confirmReceiptByCustomer(order.id);
  await pgOrderService.confirmReceiptByCustomer(order.id); // повторный клик — идемпотентный успех

  const fresh = await pgOrderService.getOrder(order.id);
  const earnedAtAfter = await earnedAtOf(order.id);
  assert.equal(earnedAtAfter.getTime(), earnedAtBefore.getTime());
  assert.equal(fresh.items_total, 500);
  assert.equal(fresh.commission_amount, 35);
});

// ===========================================================================
// F. Pickup — регрессия: earned_at по-прежнему корректно проставляется
// ===========================================================================

test('F. Pickup: restaurantAdvance(preparing->delivered) устанавливает earned_at (не затронуто Stage 33.1)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing', fulfillmentType: 'pickup' });
  assert.equal(await earnedAtOf(order.id), null);

  await pgOrderService.restaurantAdvance(order.id, 'delivered');

  const earnedAt = await earnedAtOf(order.id);
  assert.ok(earnedAt instanceof Date, 'pickup: earned_at должен быть установлен на preparing->delivered');
});

test('F2. Pickup: заказ корректно учитывается в финансовом агрегате за период', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing', fulfillmentType: 'pickup' });
  await pgCreatePayment(order.id);
  await pgOrderService.restaurantAdvance(order.id, 'delivered');

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turnover, 500);
});

// ===========================================================================
// G. Отменённые/отклонённые/просроченные заказы не становятся earned
// ===========================================================================

test('G. cancelled/declined/timed_out/payment_failed не учитываются в финансовом агрегате', async () => {
  const restaurantId = await pgCreateRestaurant();
  for (const status of ['cancelled', 'declined', 'timed_out', 'payment_failed']) {
    // eslint-disable-next-line no-await-in-loop
    const order = await pgCreateOrder(restaurantId, { status });
    // eslint-disable-next-line no-await-in-loop
    await pgCreatePayment(order.id, { status: status === 'payment_failed' ? 'failed' : 'succeeded' });
  }

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 0, 'ни один из этих статусов не должен попасть в заработок');
});

// ===========================================================================
// H. Succeeded refund по-прежнему исключает заказ из заработка
// ===========================================================================

test('H. Заказ с succeeded-возвратом исключается из заработка (EARNED_ORDER_FILTER_SQL не менялся)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  const paymentId = await pgCreatePayment(order.id);
  await pgOrderService.restaurantAdvance(order.id, 'courier');
  await pgOrderService.confirmReceiptByCustomer(order.id);

  const refundRows = await db.query(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1, 500, 'succeeded', 'customer_cancel', $2, NOW()) RETURNING id`,
    [paymentId, `refund-${uniqueSuffix()}`],
  );
  assert.ok(refundRows[0].id);

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 0, 'заказ с succeeded-возвратом не должен считаться заработком');
});

// ===========================================================================
// I. КРИТИЧЕСКИЙ ТЕСТ — граница расчётного периода: заказ относится к периоду
// передачи курьеру, а не к периоду клиентского клика.
// ===========================================================================

test('I. Заказ передан курьеру ДО границы периода, клиент подтвердил ПОСЛЕ — заказ относится к периоду передачи курьеру', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgCreatePayment(order.id);

  // Момент передачи курьеру — "вчера" (симулируем, что расчётный период уже
  // закрылся вчера ночью) — backdate earned_at сразу после реального
  // restaurantAdvance-перехода, тем же принципом, что и в orderServiceStage33
  // (сначала реальный переход, потом только сдвиг времени для теста границы).
  await pgOrderService.restaurantAdvance(order.id, 'courier');
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db.execute('UPDATE orders SET earned_at = $1 WHERE id = $2', [yesterday, order.id]);

  // Клиент подтверждает получение "сегодня", ПОСЛЕ границы периода —
  // status_updated_at и delivered_via обновятся на "сегодня", earned_at
  // (задан выше) остаётся "вчера".
  await pgOrderService.confirmReceiptByCustomer(order.id);
  const afterConfirm = await pgOrderService.getOrder(order.id);
  assert.equal(afterConfirm.status, 'delivered');

  const earnedAtRow = (await db.query('SELECT earned_at FROM orders WHERE id = $1', [order.id]))[0];
  assert.ok(
    earnedAtRow.earned_at.getTime() < yesterday.getTime() + 60000 && earnedAtRow.earned_at.getTime() > yesterday.getTime() - 60000,
    'earned_at обязан остаться "вчерашним" — confirmReceiptByCustomer не должен был его тронуть',
  );

  // "Вчерашний" период — от начала вчерашнего дня (UTC) до начала сегодняшнего.
  const now = new Date();
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterdayStartUtc = new Date(todayStartUtc.getTime() - 24 * 60 * 60 * 1000);
  // Гарантируем, что и earned_at("вчера"), и status_updated_at("сегодня")
  // действительно лежат по разные стороны этой границы — иначе тест
  // ничего бы не доказывал.
  assert.ok(earnedAtRow.earned_at.getTime() < todayStartUtc.getTime(), 'earned_at должен быть строго до сегодняшней границы');
  assert.ok(new Date(afterConfirm.status_updated_at).getTime() >= todayStartUtc.getTime(), 'status_updated_at (момент клика) должен быть уже сегодня');

  const yesterdayRange = { startUtc: yesterdayStartUtc, endUtc: todayStartUtc };
  const todayRange = { startUtc: todayStartUtc, endUtc: new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000) };

  const yesterdayRows = await financeService.computeEarningsAggregate({ restaurantId, range: yesterdayRange });
  const todayRows = await financeService.computeEarningsAggregate({ restaurantId, range: todayRange });

  assert.equal(yesterdayRows.length, 1, 'заказ обязан попасть во "вчерашний" период (момент передачи курьеру)');
  assert.equal(yesterdayRows[0].turnover, 500);
  assert.equal(todayRows.length, 0, 'заказ НЕ должен попасть в "сегодняшний" период только из-за клика клиента');
});

test('I2. То же самое на уровне settlementService.closeSettlementPeriod (реальное закрытие периода)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgCreatePayment(order.id);
  await pgOrderService.restaurantAdvance(order.id, 'courier');

  // projectTodayStr (не наивный UTC toISOString) — тот же якорь MSK-дня,
  // которым реально пользуется resolvePeriodRangeForPeriod внутри
  // closeSettlementPeriod; иначе тест плавает в окне 21:00-24:00 UTC
  // (00:00-03:00 МСК), см. helpers/projectDate.js. earned_at выставляется
  // серединой вчерашнего MSK-дня (не "now - 24h" — та же наивная ловушка),
  // гарантированно внутри диапазона, который вычислит closeSettlementPeriod.
  const yesterdayStr = todayStr(-1);
  const yesterdayRange = resolvePeriodRange({ period: 'custom', from: yesterdayStr, to: yesterdayStr });
  const safeYesterdayMoment = new Date(yesterdayRange.startUtc.getTime() + 12 * 60 * 60 * 1000);
  await db.execute(
    `UPDATE orders SET earned_at = $1 WHERE id = $2`,
    [safeYesterdayMoment, order.id],
  );

  // Клиент подтверждает ПОСЛЕ того, как "вчерашний" период уже закрыт ниже.
  // Период — глобальный (по календарной дате, не по ресторану), поэтому
  // строки других тестов этого файла (например, теста I выше, у которого
  // earned_at тоже "вчера") могут законно попасть в тот же период — тест
  // ищет строку СВОЕГО ресторана, не полагается на length===1 по всем.
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: yesterdayStr, periodTo: yesterdayStr });
  const closed = await settlementService.closeSettlementPeriod(period.id);
  // closeSettlementPeriod().lines — сырые строки settlement_restaurant_lines
  // (INSERT ... RETURNING *), поле restaurant_id — snake_case, НЕ camelCase
  // restaurantId (тот — только в промежуточном JS-объекте buildRestaurantLines,
  // до записи в БД).
  const ownLine = closed.lines.find((l) => l.restaurant_id === restaurantId);
  assert.ok(ownLine, 'заказ обязан попасть в закрываемый период по earned_at');
  assert.equal(ownLine.turnover, 500);

  await pgOrderService.confirmReceiptByCustomer(order.id);

  // Период уже закрыт (immutable snapshot) — повторное чтение обязано
  // отдавать тот же снимок, не пересчитывать его из-за клика клиента.
  const reloaded = await settlementService.getSettlementPeriodDetail(period.id);
  const ownLineReloaded = reloaded.lines.find((l) => l.restaurant_id === restaurantId);
  assert.ok(ownLineReloaded);
  assert.equal(ownLineReloaded.turnover, 500);
  assert.equal(reloaded.period.status, 'closed');
});
