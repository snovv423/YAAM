'use strict';

// YAAM Stage 37.2 — duplicate_payment accounting isolation.
//
// КАНОНИЧЕСКОЕ ПРАВИЛО (задание, раздел 1): succeeded-возврат с
// reason='duplicate_payment' — это provider/payment reconciliation (лишнее
// списание, реально возвращённое клиенту), а НЕ сторно продажи ресторана.
// Он не должен снимать заказ с заработка ресторана, не должен создавать
// late_refund adjustment/долг, не должен уменьшать будущий payout — при
// этом сам факт двойного списания и его возврат обязаны остаться видны в
// payment/refund audit (ничего не удаляется и не скрывается).
//
// Единственный источник различения — SALE_REVERSING_REFUND_REASONS
// (services/hq/restaurantFinanceService.js): customer_cancel/
// restaurant_decline/timeout — сторно продажи; duplicate_payment — нет.
// Использован ОДИН раз, и в EARNED_ORDER_FILTER_SQL, и в
// computeRefundsAggregate, и (через переиспользование fetchSucceededRefundRows)
// в late_refund adjustment — три места, один список, физически не может
// разойтись (задание, раздел 5: "не размазывать разные списки refund
// reason по SQL/service слоям").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('stage372-duplicate-payment');
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

function loadServices(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  const modulePaths = [
    require.resolve('../../db/postgresql'),
    require.resolve('../../services/postgresql/orderService.js'),
    require.resolve('../../services/paymentService'),
    require.resolve('../../services/hq/menuAdminService'),
    require.resolve('../../services/hq/restaurantFinanceService'),
    require.resolve('../../services/hq/settlementService'),
    require.resolve('../../services/hq/settlementAdjustmentService'),
    require.resolve('../../services/hq/restaurantBalanceService'),
    require.resolve('../../services/hq/auditLog'),
    require.resolve('../../services/hq/eventLogService'),
  ];
  for (const p of modulePaths) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    orderService: require('../../services/postgresql/orderService.js'),
    menuAdminService: require('../../services/hq/menuAdminService'),
    financeService: require('../../services/hq/restaurantFinanceService'),
    settlementService: require('../../services/hq/settlementService'),
    balanceService: require('../../services/hq/restaurantBalanceService'),
  };
}

async function createRestaurant(db, name) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}
async function seedMenuItem(menuAdminService, restaurantId, price) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Блюдо', category_id: String(category.id), price: String(price) });
}
function uniquePhone() {
  return `+7903${String(crypto.randomInt(1000000, 9999999))}`;
}
function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

// Реальный жизненный цикл до earned_at, тем же способом, что и в Stage 37
// (никаких SQL-обходов состояний) — доставка, целиком через сервис.
async function deliverRealOrder(orderService, db, restaurantId, menuItemId) {
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
    address: 'ул. Дубликат, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Блюдо', price: 0, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]))[0];
  await orderService.markPaid(order.id, paymentRow.id);
  await orderService.restaurantAccept(order.id);
  await orderService.restaurantAdvance(order.id, 'preparing');
  await orderService.restaurantAdvance(order.id, 'ready');
  await orderService.restaurantAdvance(order.id, 'courier');
  await orderService.confirmReceiptByCustomer(order.id);
  return { orderId: order.id, canonicalPaymentId: paymentRow.id };
}

// Вставляет ВТОРОЙ (старый, "ранее failed") платёж того же заказа — то, что
// реально описывает Stage 37.1: попытка, которую YAAM счёл неудачной, но
// провайдер потом подтверждает как успешную. Порядок INSERT здесь не важен
// для воспроизведения бага — важно только финальное состояние: у заказа
// два платежа, один канонический succeeded, один пришедший 'failed' извне.
//
// paymentService.createPayment() зарегистрирован ЧЕРЕЗ тот же mock-провайдер
// (paymentService.js держит один process-level instance), иначе его
// последующий refund() не найдёт providerPaymentId в своей внутренней карте
// и вернёт 'failed' независимо от бизнес-логики — это артефакт stateful
// mock-провайдера, не то, что проверяет этот тест.
async function addOldFailedAttempt(db, orderId, amount) {
  const paymentService = require('../../services/paymentService');
  const idempotencyKey = `yaam_pay_v1_${crypto.randomBytes(16).toString('base64url')}`;
  const created = await paymentService.createPayment({
    orderId, amount, description: 'Stage 37.2 duplicate-payment fixture', idempotencyKey,
  });
  const rows = await db.execute(
    `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
     VALUES ($1,'mock',$2,$3,'failed') RETURNING id`,
    [orderId, created.providerPaymentId, amount],
  );
  return rows.rows[0].id;
}

function widePeriodBounds() {
  const pad = (n) => String(n).padStart(2, '0');
  const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const now = new Date();
  return {
    periodFrom: toDateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    periodTo: toDateStr(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
  };
}

// ---------------------------------------------------------------------------
// A. earned order + duplicate_payment refund ДО закрытия периода
// ---------------------------------------------------------------------------
test('A: earned-заказ переживает succeeded duplicate_payment-возврат — остаётся заработком ресторана', async () => {
  const databaseUrl = await freshDatabase('s372_a_before_close');
  const { db, orderService, menuAdminService, financeService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'A');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1000);
    const { orderId } = await deliverRealOrder(orderService, db, restaurantId, menuItem.id);

    // Предпосылка: обычная live-позиция ДО дубля — оборот/комиссия/заработок как обычно.
    const before = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(before.turnover, 1000);
    assert.equal(before.commission, 70);
    assert.equal(before.restaurantEarnings, 930);
    assert.equal(before.deliveredPaidOrders, 1);

    // Старая попытка, ранее failed, теперь подтверждена провайдером как успешная.
    const oldPaymentId = await addOldFailedAttempt(db, orderId, 1000);
    const applied = await orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' });
    assert.equal(applied.outcome, 'duplicate');
    assert.ok(applied.refundId, 'лишняя сумма должна уйти в возврат');
    await sleep(300); // fire-and-forget scheduleRefundProcessing, тот же приём, что в Stage 7.1

    const refundRow = (await db.query('SELECT status, reason FROM refunds WHERE id = $1', [applied.refundId]))[0];
    assert.equal(refundRow.reason, 'duplicate_payment');
    assert.equal(refundRow.status, 'succeeded', 'предпосылка: возврат дубля должен реально завершиться succeeded');

    // ГЛАВНАЯ ПРОВЕРКА (задание, раздел 1 и 3): заказ ОСТАЁТСЯ заработком.
    const after = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(after.deliveredPaidOrders, 1, 'заказ не должен исчезнуть из заработка');
    assert.equal(after.turnover, 1000, 'оборот не должен обнулиться из-за возврата дубля');
    assert.equal(after.commission, 70, 'комиссия YAAM за настоящую продажу не должна обнулиться');
    assert.equal(after.restaurantEarnings, 930, 'заработок ресторана не должен обнулиться');

    // Заказ ровно один раз в settlement preview.
    const { periodFrom, periodTo } = widePeriodBounds();
    const settlementService = require('../../services/hq/settlementService');
    const range = settlementService.resolvePeriodRangeForPeriod(periodFrom, periodTo);
    const { restaurantLines, orderRows } = await settlementService.computeSettlementPreview(range);
    const ordersOfThisOrder = orderRows.filter((o) => o.order_id === orderId);
    assert.equal(ordersOfThisOrder.length, 1, 'заказ должен попасть в preview ровно один раз, не ноль и не дважды');
    const line = restaurantLines.find((l) => l.restaurantId === restaurantId);
    assert.equal(line.turnover, 1000);
    assert.equal(line.restaurantEarnings, 930);

    // Возврат дубля НЕ должен появляться в «Возвраты» ресторана (задание,
    // раздел 8: не должен выглядеть как «ресторан вернул заказ»).
    assert.equal(after.successfulRefundsCount, 0, 'возврат дубля не должен считаться возвратом ресторана');
    assert.equal(after.successfulRefunds, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// B. earned order + settlement close + duplicate_payment refund ПОСЛЕ закрытия
// ---------------------------------------------------------------------------
test('B: поздний duplicate_payment-возврат ПОСЛЕ закрытия периода не создаёт late_refund adjustment и не создаёт долг', async () => {
  const databaseUrl = await freshDatabase('s372_b_after_close');
  const { db, orderService, menuAdminService, settlementService, balanceService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'B');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1000);
    const { orderId } = await deliverRealOrder(orderService, db, restaurantId, menuItem.id);

    // T1: задним числом переносим earned_at в позавчера — тот же приём, что
    // и в hqSettlementClosureStage13.test.js (order() с явным deliveredAt),
    // нужен только чтобы период 1 успел ЗАКРЫТЬСЯ ДО того, как случится
    // duplicate-возврат (который в этом тесте происходит "сейчас").
    await db.execute(`UPDATE orders SET earned_at = NOW() - interval '2 days' WHERE id = $1`, [orderId]);

    const pad = (n) => String(n).padStart(2, '0');
    const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const period1From = toDateStr(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const period1To = toDateStr(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000));

    // T2: период 1 закрыт — заказ зафиксирован в snapshot нормально.
    const draft1 = await settlementService.createDraftSettlementPeriod({ periodFrom: period1From, periodTo: period1To });
    const closed1 = await settlementService.closeSettlementPeriod(draft1.id);
    const line1 = closed1.lines.find((l) => l.restaurant_id === restaurantId);
    assert.equal(line1.payable_amount, 930, 'предпосылка: период 1 закрылся с нормальным заработком');
    const snapshotBefore = { ...line1 };

    // T3-T4: поздняя попытка платежа подтверждается провайдером как успешная,
    // лишнее списание уходит в duplicate_payment-возврат.
    const oldPaymentId = await addOldFailedAttempt(db, orderId, 1000);
    const applied = await orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' });
    await sleep(300);
    const refundRow = (await db.query('SELECT status, reason, completed_at FROM refunds WHERE id = $1', [applied.refundId]))[0];
    assert.equal(refundRow.status, 'succeeded');
    assert.equal(refundRow.reason, 'duplicate_payment');

    // Период 1 (уже закрытый) — snapshot НЕ изменился ни на йоту.
    const line1After = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE id = $1', [line1.id]))[0];
    assert.equal(line1After.payable_amount, snapshotBefore.payable_amount);
    assert.equal(line1After.turnover, snapshotBefore.turnover);
    assert.equal(line1After.refund_adjustment_restaurant_amount, 0, 'закрытый период не должен задним числом получить сторно');

    // T5: закрываем период 2, чей диапазон накрывает момент завершения
    // duplicate-возврата (completed_at = "сейчас"). period1's "to" включён
    // целиком (resolvePeriodRange трактует to как границу с +1 день), поэтому
    // период 2 начинается на день позже, а не с той же даты.
    const period2From = toDateStr(new Date(Date.now()));
    const period2To = toDateStr(new Date(Date.now() + 1 * 24 * 60 * 60 * 1000));
    const draft2 = await settlementService.createDraftSettlementPeriod({ periodFrom: period2From, periodTo: period2To });
    const closed2 = await settlementService.closeSettlementPeriod(draft2.id);

    // ГЛАВНАЯ ПРОВЕРКА: период 2 либо вообще не создаёт строку для этого
    // ресторана (нет новой активности), либо создаёт строку без единого
    // adjustment/carry-forward, связанного с этим возвратом.
    const line2 = closed2.lines.find((l) => l.restaurant_id === restaurantId);
    if (line2) {
      assert.equal(line2.refund_adjustment_restaurant_amount, 0, 'duplicate_payment не должен породить сторно в будущем периоде');
      assert.equal(line2.carry_forward_applied, 0, 'duplicate_payment не должен погашать несуществующий долг');
    }
    const adjustmentRows = await db.query(
      `SELECT * FROM settlement_adjustments WHERE order_id = $1`, [orderId],
    );
    assert.equal(adjustmentRows.length, 0, 'ни одной settlement_adjustments строки для этого заказа быть не должно');

    const debt = await balanceService.getDebt(restaurantId);
    assert.equal(debt, 0, 'duplicate_payment не должен создавать долг ресторана');

    // Выплата исходного заказа (если бы её готовили) осталась бы экономически
    // верной — payable_amount периода 1 по-прежнему 930, ничего не отняли.
    const line1Final = (await db.query('SELECT payable_amount FROM settlement_restaurant_lines WHERE id = $1', [line1.id]))[0];
    assert.equal(line1Final.payable_amount, 930);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// C. Финансовый факт двойного списания остаётся в audit/refund history
// ---------------------------------------------------------------------------
test('C: duplicate_payment payment/refund остаются полностью видны в audit и в самих таблицах', async () => {
  const databaseUrl = await freshDatabase('s372_c_audit');
  const { db, orderService, menuAdminService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'C');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1000);
    const { orderId } = await deliverRealOrder(orderService, db, restaurantId, menuItem.id);

    const oldPaymentId = await addOldFailedAttempt(db, orderId, 1000);
    const applied = await orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' });
    await sleep(300);

    // Сам финансовый факт — оба платежа и возврат — остаются в таблицах как есть.
    const paymentsRows = await db.query('SELECT id, status, duplicate_of_payment_id FROM payments WHERE order_id = $1 ORDER BY id', [orderId]);
    assert.equal(paymentsRows.length, 2, 'оба платежа (канонический и лишний) должны остаться в таблице');
    const oldPayment = paymentsRows.find((p) => p.id === oldPaymentId);
    // 'succeeded' сразу после recordDuplicatePaymentSuccess (правда
    // провайдера зафиксирована честно), затем 'refunded' — терминальный
    // статус после того, как лишнее списание реально вернулось клиенту (тот
    // же переход succeeded->refunded, что и у любого другого возвращённого
    // платежа в системе) — ни то, ни другое не является потерей факта.
    assert.equal(oldPayment.status, 'refunded', 'платёж не удалён и не скрыт — дошёл до честного терминального статуса');
    assert.ok(oldPayment.duplicate_of_payment_id, 'дубль явно помечен ссылкой на канонический платёж');

    const refundRows = await db.query('SELECT id, reason, status, amount FROM refunds WHERE payment_id = $1', [oldPaymentId]);
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0].reason, 'duplicate_payment');
    assert.equal(refundRows[0].status, 'succeeded');
    assert.equal(refundRows[0].amount, 1000);

    // Аудит и Центр событий — та же проверка, что уже существовала до Stage
    // 37.2 (не трогали эту часть), подтверждаем, что фикс её не сломал.
    const audit = await db.query("SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'payment_duplicate_detected'");
    assert.equal(audit[0].n, 1);
    const events = await db.query("SELECT category, message FROM hq_events WHERE category = 'payment_issue'");
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Двойное списание/);
    // Явно НЕ содержит формулировок «возврат ресторану»/«удержано из заработка».
    assert.doesNotMatch(events[0].message, /ресторан.*верн|удержан.*заработ/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// D. Обычный экономический возврат (customer_cancel) — семантика НЕ изменилась
// ---------------------------------------------------------------------------
test('D: обычный customer_cancel-возврат по-прежнему корректно снимает заказ с заработка (регресс на фикс не распространяется)', async () => {
  const databaseUrl = await freshDatabase('s372_d_ordinary_refund');
  const { db, orderService, menuAdminService, financeService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'D');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1500);

    const payload = {
      restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
      address: 'ул. Обычная, 1', comment: '', fulfillmentType: 'delivery',
      items: [{ menuItemId: menuItem.id, name: 'Блюдо', price: 0, qty: 1 }],
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    };
    const { order } = await orderService.createOrderAndResolve(payload);
    const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1`, [order.id]))[0];
    await orderService.markPaid(order.id, paymentRow.id);

    await orderService.cancelByCustomer(order.id);
    await sleep(300);

    const refundRow = (await db.query(
      `SELECT status, reason FROM refunds WHERE payment_id = $1`, [paymentRow.id],
    ))[0];
    assert.equal(refundRow.status, 'succeeded');
    assert.equal(refundRow.reason, 'customer_cancel');

    // Обычный возврат ПО-ПРЕЖНЕМУ (не изменено этой стадией) не даёт заработка
    // и по-прежнему виден в «Возвраты» ресторана — в отличие от duplicate_payment.
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 0, 'отменённый заказ никогда не был доставлен — не заработок, как и раньше');
    assert.equal(position.turnover, 0);
    assert.equal(position.successfulRefundsCount, 1, 'обычный возврат ДОЛЖЕН попадать в «Возвраты» — не задет фиксом');
    assert.equal(position.successfulRefunds, 1500);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// E. Повторное событие (не гонка) — идемпотентность не сломана фиксом
// ---------------------------------------------------------------------------
test('E: повторный вызов applyConfirmedPaymentSuccess для того же дубля — не создаёт второй возврат, заработок стабилен', async () => {
  const databaseUrl = await freshDatabase('s372_e_repeat');
  const { db, orderService, menuAdminService, financeService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'E');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1000);
    const { orderId } = await deliverRealOrder(orderService, db, restaurantId, menuItem.id);

    const oldPaymentId = await addOldFailedAttempt(db, orderId, 1000);
    const first = await orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' });
    await sleep(300);
    assert.equal(first.outcome, 'duplicate');

    const second = await orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' });
    assert.equal(second.outcome, 'noop', 'повторное подтверждение уже обработанного дубля — no-op');

    const refunds = await db.query('SELECT COUNT(*)::int AS n FROM refunds WHERE payment_id = $1', [oldPaymentId]);
    assert.equal(refunds[0].n, 1, 'второй возврат не создан повторным вызовом');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 1, 'повторный вызов не должен дополнительно портить заработок');
    assert.equal(position.restaurantEarnings, 930);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// F. Конкурентный (действительно одновременный) повтор webhook
// ---------------------------------------------------------------------------
test('F: два ОДНОВРЕМЕННЫХ вызова applyConfirmedPaymentSuccess для одного дубля — ровно один возврат, заработок не задвоен и не обнулён', async () => {
  const databaseUrl = await freshDatabase('s372_f_concurrent');
  const { db, orderService, menuAdminService, financeService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'F');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1000);
    const { orderId } = await deliverRealOrder(orderService, db, restaurantId, menuItem.id);

    const oldPaymentId = await addOldFailedAttempt(db, orderId, 1000);

    const [r1, r2] = await Promise.allSettled([
      orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' }),
      orderService.applyConfirmedPaymentSuccess(orderId, oldPaymentId, { source: 'webhook' }),
    ]);
    await sleep(300);

    // Один из двух — реальный переход, второй — либо no-op, либо тоже
    // 'duplicate' (гонка на conditional UPDATE), но НИКОГДА не должно
    // получиться двух РАЗНЫХ refund-строк.
    const outcomes = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value.outcome : `rejected:${r.reason.message}`));
    assert.ok(outcomes.every((o) => o === 'duplicate' || o === 'noop'), `неожиданный исход гонки: ${outcomes.join(', ')}`);

    const refunds = await db.query('SELECT COUNT(*)::int AS n FROM refunds WHERE payment_id = $1', [oldPaymentId]);
    assert.equal(refunds[0].n, 1, 'конкурентный повтор не должен создать вторую refund-строку');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.deliveredPaidOrders, 1, 'гонка не должна ни задвоить, ни обнулить заработок ресторана');
    assert.equal(position.restaurantEarnings, 930);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
