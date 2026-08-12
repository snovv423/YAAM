'use strict';

// YAAM Stage 33.2 — «завершить финансовую независимость earned_at»: убирает
// последнюю дырку Stage 33.1 — EARNED_ORDER_FILTER_SQL требовал
// status='delivered' ПОВЕРХ earned_at IS NOT NULL, то есть delivery-заказ
// сразу после ready->courier уже имел earned_at (ресторан физически передал
// заказ), но НЕ попадал в финансовый расчёт, пока клиент не подтвердит
// получение или не сработает 6-часовой auto-complete. Доказывает пункты A-J
// задания через РЕАЛЬНЫЕ функции orderService/restaurantFinanceService/
// settlementService.
//
// Не переаудирует Stage 33/33.1 (state machine/Telegram/клиент/рейтинг/
// auto-complete/HQ) — только financial eligibility gate.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_financial_eligibility_332_test';

let cluster;
let db;
let pgOrderService;
let financeService;
let settlementService;
let resolvePeriodRange;

before(async () => {
  cluster = await startEmbeddedPostgres('financial-eligibility-332');
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

// Расчётные периоды глобальны (по календарной дате, не по ресторану) — тесты
// этого файла, закрывающие период, обязаны использовать РАЗНЫЕ дни, иначе
// settlement_periods_no_overlap (EXCLUDE-ограничение) отклонит второй период
// на ту же дату. Каждый такой тест берёт свой собственный, ЗАРАНЕЕ
// зафиксированный сдвиг в прошлое (projectTodayStr(dayOffset), тот же
// MSK-корректный якорь, что и в остальных Stage-тестах, см.
// helpers/projectDate.js) — не "сегодня"/"вчера" (те заняты другими тестами
// этого же файла) и не пересекаются друг с другом.
function uniqueDayStr(dayOffset) {
  return todayStr(dayOffset);
}

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

async function pgCreateOrder(restaurantId, {
  status = 'preparing', fulfillmentType = 'delivery', statusUpdatedAt = null, earnedAt = null,
} = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, fulfillment_type, status_updated_at, earned_at
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, $3, $4,
       COALESCE($5, NOW()), $6)
     RETURNING *`,
    [`YAAM-FE-${suffix}`, restaurantId, status, fulfillmentType, statusUpdatedAt, earnedAt]
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

// ===========================================================================
// A. courier (delivery) уже финансово заработан ДО customer confirm
// ===========================================================================

test('A. Delivery ready->courier: earned_at установлен, status ещё courier, заказ УЖЕ в live earnings', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgCreatePayment(order.id);

  await pgOrderService.restaurantAdvance(order.id, 'courier');

  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.status, 'courier', 'заказ обязан ещё быть courier — клиент не подтверждал получение');

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 1, 'courier-заказ обязан УЖЕ учитываться в live earnings');
  assert.equal(rows[0].turnover, 500);
  assert.equal(rows[0].delivered_paid_orders, 1);

  const position = await financeService.getRestaurantFinancialPosition(restaurantId);
  assert.equal(position.turnover, 500);
  assert.equal(position.deliveredPaidOrders, 1);
});

// ===========================================================================
// B. courier-заказ уже в settlement preview ДО customer confirm
// ===========================================================================

test('B. Courier-заказ уже виден в settlement preview (fetchEarnedOrderRows/computeSettlementPreview) до confirm', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgCreatePayment(order.id);
  await pgOrderService.restaurantAdvance(order.id, 'courier');

  // Диапазон — узкое окно вокруг "сейчас" (не all-time от эпохи — тот
  // раньше случайно захватывал earned-заказы ДРУГИХ тестов этого файла),
  // но preview глобален по всем ресторанам, поэтому проверяем присутствие
  // СВОЕГО заказа/ресторана, не строгую длину массивов.
  const range = { startUtc: new Date(Date.now() - 5 * 60 * 1000), endUtc: new Date(Date.now() + 60 * 60 * 1000) };
  const preview = await settlementService.computeSettlementPreview(range);
  const orderIds = preview.orderRows.map((r) => r.order_id);
  assert.ok(orderIds.includes(order.id), 'courier-заказ обязан присутствовать в preview периода ДО customer confirm');
  const ownLine = preview.restaurantLines.find((l) => l.restaurantId === restaurantId);
  assert.ok(ownLine, 'строка своего ресторана обязана присутствовать в preview');
  assert.equal(ownLine.turnover, 500);
});

// ===========================================================================
// C. Закрытие периода ПОКА заказ ещё courier — критический сценарий задания
// (23:58 Sunday courier / 23:59 close / 00:10 Monday customer confirm)
// ===========================================================================

test('C. closeSettlementPeriod() закрывает период, ПОКА заказ ещё courier — заказ попадает в settlement_order_lines', async () => {
  const restaurantId = await pgCreateRestaurant();
  const day = uniqueDayStr(-10);
  const dayRange = resolvePeriodRange({ period: 'custom', from: day, to: day });
  const earnedAt = new Date(dayRange.startUtc.getTime() + 12 * 60 * 60 * 1000);
  const order = await pgCreateOrder(restaurantId, {
    status: 'courier', statusUpdatedAt: earnedAt, earnedAt,
  });
  await pgCreatePayment(order.id);

  const stillCourier = await pgOrderService.getOrder(order.id);
  assert.equal(stillCourier.status, 'courier', 'до закрытия периода клиент ещё не подтверждал получение');

  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: day, periodTo: day });
  const closed = await settlementService.closeSettlementPeriod(period.id); // "23:59" — период закрывается

  assert.equal(closed.lines.length, 1, 'заказ обязан попасть в закрываемый период, даже оставаясь courier');
  assert.equal(closed.lines[0].turnover, 500);

  const orderLineRows = await db.query('SELECT * FROM settlement_order_lines WHERE order_id = $1', [order.id]);
  assert.equal(orderLineRows.length, 1, 'settlement_order_lines обязана содержать снимок по этому заказу');
});

// ===========================================================================
// D. После закрытия периода клиент подтверждает получение — снимок не меняется
// ===========================================================================

test('D. Customer confirm ПОСЛЕ закрытия периода не меняет snapshot/сумму/период — без второго учёта', async () => {
  const restaurantId = await pgCreateRestaurant();
  const day = uniqueDayStr(-11); // свой день, не пересекается с тестом C/E/J
  const dayRange = resolvePeriodRange({ period: 'custom', from: day, to: day });
  const earnedAt = new Date(dayRange.startUtc.getTime() + 12 * 60 * 60 * 1000);
  const order = await pgCreateOrder(restaurantId, {
    status: 'courier', statusUpdatedAt: earnedAt, earnedAt,
  });
  await pgCreatePayment(order.id);

  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: day, periodTo: day });
  const closed = await settlementService.closeSettlementPeriod(period.id); // "23:59"
  assert.equal(closed.lines[0].turnover, 500);
  const lineBefore = (await db.query('SELECT * FROM settlement_order_lines WHERE order_id = $1', [order.id]))[0];

  // "00:10 Monday" — клиент нажимает «Заказ получен».
  await pgOrderService.confirmReceiptByCustomer(order.id);
  const afterConfirm = await pgOrderService.getOrder(order.id);
  assert.equal(afterConfirm.status, 'delivered');

  const lineAfter = (await db.query('SELECT * FROM settlement_order_lines WHERE order_id = $1', [order.id]))[0];
  assert.deepEqual(lineAfter, lineBefore, 'иммутабельный снимок обязан остаться байт-в-байт тем же после клика');

  const reloaded = await settlementService.getSettlementPeriodDetail(period.id);
  assert.equal(reloaded.lines.length, 1, 'не должно появиться второй строки/повторного учёта');
  assert.equal(reloaded.lines[0].turnover, 500);
  assert.equal(reloaded.period.status, 'closed');

  // DB-триггер иммутабельности settlement_order_lines (не Stage 33.2, уже
  // существовал) — прямое подтверждение, что confirmReceiptByCustomer не
  // мог физически переписать строку, даже если бы попытался.
  const orderLineCount = await db.query('SELECT COUNT(*)::int AS c FROM settlement_order_lines WHERE order_id = $1', [order.id]);
  assert.equal(orderLineCount[0].c, 1);
});

// ===========================================================================
// E. Тот же сценарий через auto-complete — идентичный финансовый результат
// ===========================================================================

test('E. Auto-complete ПОСЛЕ закрытия периода даёт идентичный финансовый результат, что и customer confirm', async () => {
  const restaurantId = await pgCreateRestaurant();
  const day = uniqueDayStr(-12); // свой день, не пересекается с тестом C/D/J
  const dayRange = resolvePeriodRange({ period: 'custom', from: day, to: day });
  const earnedAt = new Date(dayRange.startUtc.getTime() + 12 * 60 * 60 * 1000);
  const order = await pgCreateOrder(restaurantId, {
    status: 'courier', statusUpdatedAt: earnedAt, earnedAt,
  });
  await pgCreatePayment(order.id);

  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: day, periodTo: day });
  const closed = await settlementService.closeSettlementPeriod(period.id);
  const lineBefore = (await db.query('SELECT * FROM settlement_order_lines WHERE order_id = $1', [order.id]))[0];

  // Состариваем заказ за порог auto-complete и запускаем его — заказ всё
  // ещё числился closed-периодом, клиент так и не нажал кнопку.
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000);
  await db.execute('UPDATE orders SET status_updated_at = $1 WHERE id = $2', [staleAt, order.id]);
  await pgOrderService.autoCompleteCourierOrders();

  const afterAuto = await pgOrderService.getOrder(order.id);
  assert.equal(afterAuto.status, 'delivered');

  const lineAfter = (await db.query('SELECT * FROM settlement_order_lines WHERE order_id = $1', [order.id]))[0];
  assert.deepEqual(lineAfter, lineBefore, 'auto-complete не должен был тронуть иммутабельный снимок');
  assert.equal(closed.lines[0].turnover, 500);
});

// ===========================================================================
// F. Быстрый confirm vs confirm через 5 часов — eligibility одинакова с
// момента ready->courier, а не с момента клика
// ===========================================================================

test('F. Live earnings и settlement eligibility одинаковы для courier-заказа независимо от того, когда (и подтвердит ли вообще) клиент нажмёт', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orderFast = await pgCreateOrder(restaurantId, { status: 'ready' });
  const orderSlow = await pgCreateOrder(restaurantId, { status: 'ready' });
  await pgCreatePayment(orderFast.id);
  await pgCreatePayment(orderSlow.id);

  await pgOrderService.restaurantAdvance(orderFast.id, 'courier');
  await pgOrderService.restaurantAdvance(orderSlow.id, 'courier');

  // Оба заказа ЕЩЁ courier (ни один клиент не подтвердил) — оба уже обязаны
  // быть eligible ОДИНАКОВО, независимо от будущего сценария подтверждения.
  const rowsBeforeEitherConfirm = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rowsBeforeEitherConfirm[0].delivered_paid_orders, 2);
  assert.equal(rowsBeforeEitherConfirm[0].turnover, 1000);

  await new Promise((r) => setTimeout(r, 10));
  await pgOrderService.confirmReceiptByCustomer(orderFast.id); // "confirm через 10мс"

  // orderSlow остаётся courier ещё "5 часов" (симулируем — здесь просто не
  // трогаем его) — eligibility (сумма/количество) обязана остаться той же.
  const rowsAfterFastConfirm = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rowsAfterFastConfirm[0].delivered_paid_orders, 2, 'подтверждение одного заказа не должно менять общий count');
  assert.equal(rowsAfterFastConfirm[0].turnover, 1000);
});

// ===========================================================================
// G. Pickup — регрессия (не затронуто Stage 33.2 логически, но проверяем явно)
// ===========================================================================

test('G. Pickup: preparing->delivered по-прежнему корректно учитывается (earned_at + status=delivered совпадают, как и раньше)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing', fulfillmentType: 'pickup' });
  await pgCreatePayment(order.id);

  await pgOrderService.restaurantAdvance(order.id, 'delivered');

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turnover, 500);
});

// ===========================================================================
// H. Отменённые/отклонённые/просроченные — без earned_at, не earned
// ===========================================================================

test('H. cancelled/declined/timed_out/payment_failed (без earned_at) не учитываются в финансовом агрегате', async () => {
  const restaurantId = await pgCreateRestaurant();
  for (const status of ['cancelled', 'declined', 'timed_out', 'payment_failed']) {
    // eslint-disable-next-line no-await-in-loop
    const order = await pgCreateOrder(restaurantId, { status });
    // eslint-disable-next-line no-await-in-loop
    await pgCreatePayment(order.id, { status: status === 'payment_failed' ? 'failed' : 'succeeded' });
  }

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 0, 'ни один из этих статусов не должен иметь earned_at и попасть в заработок');
});

// ===========================================================================
// I. Succeeded refund по-прежнему исключает сумму
// ===========================================================================

test('I. Заказ с succeeded-возвратом исключается из заработка даже после ready->courier', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  const paymentId = await pgCreatePayment(order.id);
  await pgOrderService.restaurantAdvance(order.id, 'courier');

  await db.query(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1, 500, 'succeeded', 'customer_cancel', $2, NOW())`,
    [paymentId, `refund-${uniqueSuffix()}`],
  );

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 0, 'заказ с succeeded-возвратом не должен считаться заработком, даже уже будучи courier');
});

// ===========================================================================
// J. Один заказ не может попасть в два settlement period
// ===========================================================================

test('J. Заказ, попавший в закрытый период как courier, не попадает повторно в следующий период после delivered', async () => {
  const restaurantId = await pgCreateRestaurant();
  const day = uniqueDayStr(-13); // свой день, не пересекается с тестом C/D/E
  const dayRange = resolvePeriodRange({ period: 'custom', from: day, to: day });
  const earnedAt = new Date(dayRange.startUtc.getTime() + 12 * 60 * 60 * 1000);
  const order = await pgCreateOrder(restaurantId, {
    status: 'courier', statusUpdatedAt: earnedAt, earnedAt,
  });
  await pgCreatePayment(order.id);

  const period1 = await settlementService.createDraftSettlementPeriod({ periodFrom: day, periodTo: day });
  const closed1 = await settlementService.closeSettlementPeriod(period1.id);
  assert.equal(closed1.lines.length, 1);

  await pgOrderService.confirmReceiptByCustomer(order.id);

  // Попытка "второго" периода на тот же диапазон дат физически невозможна
  // (EXCLUDE-ограничение settlement_periods_no_overlap) — что и является
  // структурной гарантией "один заказ — один период" наравне с
  // UNIQUE(order_id) на settlement_order_lines. Проверяем ОБА уровня.
  await assert.rejects(
    () => settlementService.createDraftSettlementPeriod({ periodFrom: day, periodTo: day }),
    /пересека|overlap|уже существует/i,
  );

  const dupRows = await db.query('SELECT order_id FROM settlement_order_lines WHERE order_id = $1 GROUP BY order_id HAVING COUNT(*) > 1', [order.id]);
  assert.equal(dupRows.length, 0, 'заказ не должен встречаться в settlement_order_lines дважды');

  const invariants = await settlementService.checkSettlementInvariants();
  assert.equal(invariants.ok, true);
});
