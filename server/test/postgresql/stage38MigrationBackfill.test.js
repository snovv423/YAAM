'use strict';

// YAAM Stage 38 — доказательство миграции 0014_financial_core_minor_units.sql
// на РЕАЛЬНОЙ, приближенной к продакшену pre-Stage38 базе (задание, раздел 5):
// платёж, возврат, заработанная доставка, самовывоз, закрытый период,
// settlement order lines, late-refund adjustment, долг ресторана, успешная
// выплата, заблокированная выплата — все одновременно, все в РУБЛЯХ на
// входе, все ×100 minor units на выходе, с точным экономическим смыслом
// (задание: "418 ₽ -> 41800 minor, не 4,18 ₽ и не 41 800 ₽").
//
// Не переаудирует Stage 37/37.1/37.2 бизнес-логику (реальную достижимость
// каждого сценария) — те уже доказаны. Здесь фикстуры вставляются НАПРЯМУЮ
// SQL в рублёвых величинах, ровно как их писал БЫ реальный pre-Stage38 код
// (тот же приём, что и во всех settlement/payout тестах этой сессии:
// order()/refund() helpers в hqSettlementClosureStage13.test.js) — задача
// этого файла ТОЛЬКО доказать корректность backfill, не реконструировать
// продуктовый жизненный цикл заново.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const MIGRATION_0014_SQL = fs.readFileSync(
  path.join(__dirname, '../../db/postgresql/migrations/0014_financial_core_minor_units.sql'), 'utf8',
);
const DATABASE_NAME = 'stage38_migration_backfill_test';

let cluster;
let db;

before(async () => {
  cluster = await startEmbeddedPostgres('stage38-migration-backfill');
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

async function applyMigration0014() {
  const client = cluster.getClient(DATABASE_NAME);
  await client.connect();
  try {
    await client.query(MIGRATION_0014_SQL);
  } finally {
    await client.end();
  }
}

async function createRestaurant(name) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}

let orderSeq = 0;
async function insertOrder(restaurantId, { itemsTotal, commissionAmount, status, earnedAt = null, fulfillmentType = 'delivery' }) {
  orderSeq += 1;
  const rows = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address,
                          items_total, commission_amount, status, fulfillment_type, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Т','+7900${String(orderSeq).padStart(7, '0')}','адрес',$3,$4,$5,$6,NOW(),$7) RETURNING id`,
    [`YAAM-S38-${orderSeq}`, restaurantId, itemsTotal, commissionAmount, status, fulfillmentType, earnedAt],
  );
  return rows.rows[0].id;
}
async function insertPayment(orderId, amount, status = 'succeeded') {
  const rows = await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,$3) RETURNING id`,
    [orderId, amount, status],
  );
  return rows.rows[0].id;
}
let refundKeySeq = 0;
async function insertRefund(paymentId, amount, { reason = 'customer_cancel', completedAt = new Date() } = {}) {
  refundKeySeq += 1;
  const rows = await db.execute(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,$2,'succeeded',$3,$4,$5) RETURNING id`,
    [paymentId, amount, reason, `s38-refund-key-${refundKeySeq}`, completedAt],
  );
  return rows.rows[0].id;
}
async function insertClosedPeriod(periodFrom, periodTo) {
  const rows = await db.execute(
    `INSERT INTO settlement_periods (period_from, period_to, status, closed_at) VALUES ($1,$2,'closed',NOW()) RETURNING id`,
    [periodFrom, periodTo],
  );
  return rows.rows[0].id;
}
async function insertRestaurantLine(periodId, restaurantId, {
  deliveredPaidOrders = 0, turnover = 0, yaamCommission = 0, restaurantEarnings = 0,
  successfulRefundsCount = 0, successfulRefundsAmount = 0, payableAmount,
  refundAdjustmentRestaurantAmount = 0, refundAdjustmentCommission = 0,
  carryForwardApplied = 0, carryForwardRemaining = 0,
}) {
  const rows = await db.execute(
    `INSERT INTO settlement_restaurant_lines
       (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
        restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
        payout_readiness_snapshot, refund_adjustment_restaurant_amount, refund_adjustment_commission,
        carry_forward_applied, carry_forward_remaining)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12,$13) RETURNING *`,
    [periodId, restaurantId, deliveredPaidOrders, turnover, yaamCommission, restaurantEarnings,
      successfulRefundsCount, successfulRefundsAmount, payableAmount,
      refundAdjustmentRestaurantAmount, refundAdjustmentCommission, carryForwardApplied, carryForwardRemaining],
  );
  return rows.rows[0];
}
async function insertOrderLine(periodId, restaurantId, orderId, { itemsTotal, commissionAmount, restaurantAmount }) {
  await db.execute(
    `INSERT INTO settlement_order_lines
       (settlement_period_id, restaurant_id, order_id, items_total_snapshot, commission_amount_snapshot,
        restaurant_amount_snapshot, delivered_at_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [periodId, restaurantId, orderId, itemsTotal, commissionAmount, restaurantAmount],
  );
}
async function insertSettlementRefund(periodId, restaurantId, refundId, amount) {
  await db.execute(
    `INSERT INTO settlement_refunds (settlement_period_id, restaurant_id, refund_id, amount_snapshot, completed_at_snapshot)
     VALUES ($1,$2,$3,$4,NOW())`,
    [periodId, restaurantId, refundId, amount],
  );
}
async function insertAdjustment(periodId, restaurantId, { refundId, orderId, originPeriodId, restaurantAmount, commissionAmount }) {
  await db.execute(
    `INSERT INTO settlement_adjustments
       (settlement_period_id, restaurant_id, kind, refund_id, order_id, origin_period_id, restaurant_amount, commission_amount)
     VALUES ($1,$2,'late_refund',$3,$4,$5,$6,$7)`,
    [periodId, restaurantId, refundId, orderId, originPeriodId, restaurantAmount, commissionAmount],
  );
}
async function insertBalance(restaurantId, debtAmount) {
  await db.execute(
    `INSERT INTO restaurant_settlement_balances (restaurant_id, debt_amount) VALUES ($1,$2)`,
    [restaurantId, debtAmount],
  );
}
async function insertBalanceEntry(restaurantId, periodId, kind, amount, balanceAfter) {
  await db.execute(
    `INSERT INTO restaurant_balance_entries (restaurant_id, settlement_period_id, kind, amount, balance_after)
     VALUES ($1,$2,$3,$4,$5)`,
    [restaurantId, periodId, kind, amount, balanceAfter],
  );
}
async function insertPayout(periodId, restaurantId, amount, status, extra = {}) {
  const cols = ['restaurant_id', 'settlement_period_id', 'amount', 'status'];
  const vals = [restaurantId, periodId, amount, status];
  if (status === 'succeeded') { cols.push('completed_at', 'processing_at'); vals.push(new Date(), new Date()); }
  if (status === 'blocked') { cols.push('failure_reason', 'failed_at'); vals.push('provider rejected', new Date()); }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.execute(
    `INSERT INTO restaurant_payouts (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  return rows.rows[0].id;
}
async function insertPayoutAttempt(payoutId, amount, status, extra = {}) {
  const cols = ['payout_id', 'attempt_number', 'payment_id', 'status'];
  const vals = [payoutId, 1, `s38-attempt-${payoutId}`, status];
  if (status === 'succeeded') { cols.push('completed_at'); vals.push(new Date()); }
  if (status === 'failed') { cols.push('failed_at', 'error_message', 'retryable'); vals.push(new Date(), 'provider rejected', false); }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.execute(
    `INSERT INTO payout_attempts (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  return rows.rows[0].id;
}
async function insertPayoutRequisites(attemptId, amount) {
  await db.execute(
    `INSERT INTO payout_attempt_requisites
       (attempt_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, payment_purpose, amount, payer_account_number, payer_kpp)
     VALUES ($1,'ИП Т','770912345616','','40702810900000000001','044525225','Т','30101810400000000225','Оплата','$AMT','40702810900000000002','')`
      .replace("'$AMT'", '$2'),
    [attemptId, amount],
  );
}

test('Полный upgrade-фикстур: платёж, возврат, доставка, самовывоз, закрытый период, order lines, late-refund adjustment, долг, succeeded/blocked payout — все ×100 minor units после миграции, экономический смысл сохранён', async () => {
  // --- Ресторан R: обычный закрытый период с доставкой+самовывозом, succeeded payout ---
  const r = await createRestaurant('R');
  const orderDelivery = await insertOrder(r, { itemsTotal: 1000, commissionAmount: 70, status: 'delivered', earnedAt: new Date(), fulfillmentType: 'delivery' });
  const paymentDelivery = await insertPayment(orderDelivery, 1000);
  const orderPickup = await insertOrder(r, { itemsTotal: 500, commissionAmount: 35, status: 'delivered', earnedAt: new Date(), fulfillmentType: 'pickup' });
  await insertPayment(orderPickup, 500);

  const periodP1 = await insertClosedPeriod('2026-01-01', '2026-01-07');
  const lineP1 = await insertRestaurantLine(periodP1, r, {
    deliveredPaidOrders: 2, turnover: 1500, yaamCommission: 105, restaurantEarnings: 1395,
    payableAmount: 1395,
  });
  await insertOrderLine(periodP1, r, orderDelivery, { itemsTotal: 1000, commissionAmount: 70, restaurantAmount: 930 });
  await insertOrderLine(periodP1, r, orderPickup, { itemsTotal: 500, commissionAmount: 35, restaurantAmount: 465 });

  const payoutR = await insertPayout(periodP1, r, 1395, 'succeeded');
  const attemptR = await insertPayoutAttempt(payoutR, 1395, 'succeeded');
  await insertPayoutRequisites(attemptR, 1395);

  // --- Ресторан R, отдельный заказ: реальный экономический возврат (customer_cancel), НЕ заработан ---
  const orderCancelled = await insertOrder(r, { itemsTotal: 600, commissionAmount: 0, status: 'cancelled' });
  const paymentCancelled = await insertPayment(orderCancelled, 600);
  await insertRefund(paymentCancelled, 600, { reason: 'customer_cancel' });

  // --- Ресторан R2: late-refund adjustment (ранний период P0 закрыт, возврат приходит уже в P1-подобный период) ---
  const r2 = await createRestaurant('R2');
  const periodP0 = await insertClosedPeriod('2025-12-01', '2025-12-07');
  const orderOld = await insertOrder(r2, { itemsTotal: 800, commissionAmount: 56, status: 'delivered', earnedAt: new Date('2025-12-03') });
  const paymentOld = await insertPayment(orderOld, 800);
  await insertRestaurantLine(periodP0, r2, {
    deliveredPaidOrders: 1, turnover: 800, yaamCommission: 56, restaurantEarnings: 744, payableAmount: 744,
  });
  await insertOrderLine(periodP0, r2, orderOld, { itemsTotal: 800, commissionAmount: 56, restaurantAmount: 744 });

  const periodP1b = await insertClosedPeriod('2026-01-08', '2026-01-14');
  const lateRefundId = await insertRefund(paymentOld, 800, { reason: 'restaurant_decline', completedAt: new Date('2026-01-10') });
  const lineP1b = await insertRestaurantLine(periodP1b, r2, {
    deliveredPaidOrders: 0, turnover: 0, yaamCommission: 0, restaurantEarnings: 0,
    successfulRefundsCount: 1, successfulRefundsAmount: 800,
    refundAdjustmentRestaurantAmount: 744, refundAdjustmentCommission: 56,
    payableAmount: 0, // GREATEST(0, 0 - 744 - 0) = 0
  });
  await insertSettlementRefund(periodP1b, r2, lateRefundId, 800);
  await insertAdjustment(periodP1b, r2, {
    refundId: lateRefundId, orderId: orderOld, originPeriodId: periodP0, restaurantAmount: 744, commissionAmount: 56,
  });

  // --- Ресторан R3: долг (поздний возврат ПРЕВЫШАЕТ заработок периода) + blocked payout ---
  const r3 = await createRestaurant('R3');
  const periodQ0 = await insertClosedPeriod('2025-11-01', '2025-11-07');
  const orderQ0 = await insertOrder(r3, { itemsTotal: 1000, commissionAmount: 70, status: 'delivered', earnedAt: new Date('2025-11-03') });
  const paymentQ0 = await insertPayment(orderQ0, 1000);
  await insertRestaurantLine(periodQ0, r3, {
    deliveredPaidOrders: 1, turnover: 1000, yaamCommission: 70, restaurantEarnings: 930, payableAmount: 930,
  });
  await insertOrderLine(periodQ0, r3, orderQ0, { itemsTotal: 1000, commissionAmount: 70, restaurantAmount: 930 });

  const periodQ1 = await insertClosedPeriod('2025-11-08', '2025-11-14');
  const debtRefundId = await insertRefund(paymentQ0, 1000, { reason: 'restaurant_decline', completedAt: new Date('2025-11-10') });
  await insertRestaurantLine(periodQ1, r3, {
    deliveredPaidOrders: 0, turnover: 0, yaamCommission: 0, restaurantEarnings: 0,
    successfulRefundsCount: 1, successfulRefundsAmount: 1000,
    refundAdjustmentRestaurantAmount: 930, refundAdjustmentCommission: 70,
    carryForwardApplied: 0, carryForwardRemaining: 930,
    payableAmount: 0, // GREATEST(0, 0 - 930 - 0) = 0
  });
  await insertSettlementRefund(periodQ1, r3, debtRefundId, 1000);
  await insertAdjustment(periodQ1, r3, {
    refundId: debtRefundId, orderId: orderQ0, originPeriodId: periodQ0, restaurantAmount: 930, commissionAmount: 70,
  });
  await insertBalance(r3, 930);
  await insertBalanceEntry(r3, periodQ1, 'debt_accrued', 930, 930);

  // Blocked payout для R3 на другом периоде с положительным payable.
  const periodS0 = await insertClosedPeriod('2025-10-01', '2025-10-07');
  const orderS0 = await insertOrder(r3, { itemsTotal: 300, commissionAmount: 21, status: 'delivered', earnedAt: new Date('2025-10-03') });
  await insertPayment(orderS0, 300);
  await insertRestaurantLine(periodS0, r3, {
    deliveredPaidOrders: 1, turnover: 300, yaamCommission: 21, restaurantEarnings: 279, payableAmount: 279,
  });
  await insertOrderLine(periodS0, r3, orderS0, { itemsTotal: 300, commissionAmount: 21, restaurantAmount: 279 });
  const payoutR3 = await insertPayout(periodS0, r3, 279, 'blocked');
  const attemptR3 = await insertPayoutAttempt(payoutR3, 279, 'failed');
  await insertPayoutRequisites(attemptR3, 279);

  // ===========================================================================
  // Снимок ДО миграции — контроль, что фикстура реально в рублях.
  // ===========================================================================
  assert.equal((await db.query('SELECT items_total FROM orders WHERE id=$1', [orderDelivery]))[0].items_total, 1000);
  assert.equal((await db.query('SELECT payable_amount FROM settlement_restaurant_lines WHERE id=$1', [lineP1.id]))[0].payable_amount, 1395);

  // ===========================================================================
  // МИГРАЦИЯ
  // ===========================================================================
  await applyMigration0014();

  // ===========================================================================
  // ПРОВЕРКА — каждое значение ровно ×100, экономический смысл (418 -> 41800,
  // display 418 ₽) сохранён, ничего не стало 4,18 ₽ или 41 800 ₽.
  // ===========================================================================

  // --- orders / payments / refunds ---
  const oD = (await db.query('SELECT items_total, commission_amount FROM orders WHERE id=$1', [orderDelivery]))[0];
  assert.equal(oD.items_total, 100000);
  assert.equal(oD.commission_amount, 7000);
  const oP = (await db.query('SELECT items_total, commission_amount FROM orders WHERE id=$1', [orderPickup]))[0];
  assert.equal(oP.items_total, 50000);
  assert.equal(oP.commission_amount, 3500);
  const pD = (await db.query('SELECT amount FROM payments WHERE id=$1', [paymentDelivery]))[0];
  assert.equal(pD.amount, 100000);
  const pCancelled = (await db.query('SELECT amount FROM payments WHERE id=$1', [paymentCancelled]))[0];
  assert.equal(pCancelled.amount, 60000);
  const refundCancelled = (await db.query('SELECT amount FROM refunds WHERE payment_id=$1', [paymentCancelled]))[0];
  assert.equal(refundCancelled.amount, 60000, 'обычный экономический возврат тоже ×100');

  // --- settlement_restaurant_lines (P1, обычный закрытый период) ---
  const lineP1After = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE id=$1', [lineP1.id]))[0];
  assert.equal(lineP1After.turnover, 150000);
  assert.equal(lineP1After.yaam_commission, 10500);
  assert.equal(lineP1After.restaurant_earnings, 139500);
  assert.equal(lineP1After.payable_amount, 139500);
  assert.equal(lineP1After.yaam_commission_net, 10500, 'GENERATED-колонка пересчиталась автоматически, тоже ×100');
  assert.equal(lineP1After.payout_blocked_reason, null, 'знак-only GENERATED не зависит от масштаба');

  // --- settlement_order_lines ---
  const orderLinesP1 = await db.query(
    'SELECT items_total_snapshot, commission_amount_snapshot, restaurant_amount_snapshot FROM settlement_order_lines WHERE order_id=$1',
    [orderDelivery],
  );
  assert.equal(orderLinesP1[0].items_total_snapshot, 100000);
  assert.equal(orderLinesP1[0].commission_amount_snapshot, 7000);
  assert.equal(orderLinesP1[0].restaurant_amount_snapshot, 93000);

  // --- late-refund adjustment (R2) — экономический смысл: 744 -> 74400 ---
  const lineP1bAfter = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE id=$1', [lineP1b.id]))[0];
  assert.equal(lineP1bAfter.successful_refunds_amount, 80000);
  assert.equal(lineP1bAfter.refund_adjustment_restaurant_amount, 74400);
  assert.equal(lineP1bAfter.refund_adjustment_commission, 5600);
  assert.equal(lineP1bAfter.payable_amount, 0);
  const adjustmentRow = (await db.query('SELECT restaurant_amount, commission_amount FROM settlement_adjustments WHERE order_id=$1', [orderOld]))[0];
  assert.equal(adjustmentRow.restaurant_amount, 74400);
  assert.equal(adjustmentRow.commission_amount, 5600);
  const settlementRefundRow = (await db.query('SELECT amount_snapshot FROM settlement_refunds WHERE refund_id=$1', [lateRefundId]))[0];
  assert.equal(settlementRefundRow.amount_snapshot, 80000);

  // --- долг ресторана R3: 930 -> 93000 ---
  const balanceR3 = (await db.query('SELECT debt_amount FROM restaurant_settlement_balances WHERE restaurant_id=$1', [r3]))[0];
  assert.equal(balanceR3.debt_amount, 93000);
  const entryR3 = (await db.query('SELECT amount, balance_after FROM restaurant_balance_entries WHERE restaurant_id=$1 AND kind=$2', [r3, 'debt_accrued']))[0];
  assert.equal(entryR3.amount, 93000);
  assert.equal(entryR3.balance_after, 93000);

  // --- succeeded payout (R): 1395 -> 139500 ---
  const payoutRAfter = (await db.query('SELECT amount, status FROM restaurant_payouts WHERE id=$1', [payoutR]))[0];
  assert.equal(payoutRAfter.amount, 139500);
  assert.equal(payoutRAfter.status, 'succeeded', 'статус не тронут миграцией');
  const requisitesRAfter = (await db.query('SELECT amount FROM payout_attempt_requisites WHERE attempt_id=$1', [attemptR]))[0];
  assert.equal(requisitesRAfter.amount, 139500, 'снимок реквизитов остаётся согласован с обязательством');

  // --- blocked payout (R3): 279 -> 27900 ---
  const payoutR3After = (await db.query('SELECT amount, status FROM restaurant_payouts WHERE id=$1', [payoutR3]))[0];
  assert.equal(payoutR3After.amount, 27900);
  assert.equal(payoutR3After.status, 'blocked');
  const requisitesR3After = (await db.query('SELECT amount FROM payout_attempt_requisites WHERE attempt_id=$1', [attemptR3]))[0];
  assert.equal(requisitesR3After.amount, 27900);

  // --- Инварианты финансового ядра ПОСЛЕ миграции, точно, без единого расхождения ---
  const financeService = require('../../services/hq/restaurantFinanceService');
  const settlementService = require('../../services/hq/settlementService');
  const payoutServiceModule = require('../../services/hq/payoutService');
  const finInv = await financeService.checkFinancialInvariants();
  assert.deepEqual(finInv.violations, []);
  const setInv = await settlementService.checkSettlementInvariants();
  assert.deepEqual(setInv.violations, []);
  const payInv = await payoutServiceModule.checkPayoutInvariants();
  assert.deepEqual(payInv.violations, []);

  // --- Экономическое отображение владельцу: 139500 minor -> "1395 ₽", не "13,95 ₽"/"13950 000 ₽" ---
  const money = require('../../services/money');
  assert.equal(money.formatMinorRub(lineP1After.payable_amount), '1395 ₽');
  assert.equal(money.formatMinorRub(balanceR3.debt_amount), '930 ₽');
  assert.equal(money.formatMinorRub(payoutRAfter.amount), '1395 ₽');
});

// ===========================================================================
// РЕАЛЬНЫЙ migrator.js: fresh install (задание, раздел 16.B) + отсутствие
// двойного умножения при повторном migrate() (задание, раздел 6/17 #2) —
// НЕ через прямое повторное выполнение SQL-файла (это тривиально удвоило бы
// значения нарочно), а через настоящий драйвер migrator.migrate(), который
// обязан сам определить, что версия 14 уже применена, и пропустить её.
// ===========================================================================
test('РЕАЛЬНЫЙ migrator.migrate(): применяет 0001..0014 на пустой базе один раз; повторный вызов не удваивает ×100', async () => {
  const migrator = require('../../services/postgresql/migrator');
  const quietLogger = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} };

  await cluster.createDatabase('stage38_real_migrator_fresh');
  process.env.DATABASE_URL = cluster.connectionString('stage38_real_migrator_fresh');
  for (const p of [
    require.resolve('../../db/postgresql'),
    require.resolve('../../services/postgresql/migrator.js'),
  ]) delete require.cache[p];
  const freshDb = require('../../db/postgresql');
  const freshMigrator = require('../../services/postgresql/migrator');

  try {
    // Пустая база -> migrate() выполняет ВСЮ цепочку 1..14 по-настоящему
    // (не adopt — adopt относится только к version=1, и то только если
    // схема уже доказанно совместима, чего на пустой базе быть не может).
    const first = await freshMigrator.migrate({ logger: quietLogger });
    assert.ok(first.applied.some((m) => m.version === 14 && !m.adopted), 'миграция 14 обязана реально выполниться, не быть adopt-нутой, на пустой базе');

    const status1 = await freshMigrator.getMigrationStatus();
    assert.equal(status1.ok, true);
    assert.equal(status1.applied, status1.total, 'все миграции применены, включая 14');

    // Вставляем рублёвую по СМЫСЛУ фикстуру уже ПОСЛЕ полной миграции —
    // то есть сразу пишем реалистичное minor-unit значение (100000 = 1000 ₽),
    // как и будет делать реальный код после Stage 38.
    const rest = await freshDb.execute(
      `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('X','[]',1,NOW()) RETURNING id`,
    );
    const restaurantId = rest.rows[0].id;
    const order = await freshDb.execute(
      `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address,
                            items_total, commission_amount, status, status_updated_at)
       VALUES ('YAAM-S38-REAL',$1,'Грозный','Т','+79000000000','адрес',100000,7000,'awaiting_payment',NOW())
       RETURNING id`,
      [restaurantId],
    );
    const before = (await freshDb.query('SELECT items_total, commission_amount FROM orders WHERE id=$1', [order.rows[0].id]))[0];
    assert.equal(before.items_total, 100000);

    // Повторный вызов migrate() на той же уже полностью мигрированной базе —
    // ДОЛЖЕН быть чистым no-op для версии 14 (и для всех остальных).
    const second = await freshMigrator.migrate({ logger: quietLogger });
    assert.equal(second.applied.length, 0, 'повторный migrate() не должен ничего применять заново — всё уже в schema_migrations');

    const after = (await freshDb.query('SELECT items_total, commission_amount FROM orders WHERE id=$1', [order.rows[0].id]))[0];
    assert.equal(after.items_total, 100000, 'повторный migrate() НЕ должен удвоить значение (100000 -> 10000000 было бы удвоением)');
    assert.equal(after.commission_amount, 7000);

    const versionCount = await freshDb.query('SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = 14');
    assert.equal(versionCount[0].n, 1, 'версия 14 обязана присутствовать в schema_migrations РОВНО один раз');
  } finally {
    await freshDb.close();
    delete process.env.DATABASE_URL;
  }
});
