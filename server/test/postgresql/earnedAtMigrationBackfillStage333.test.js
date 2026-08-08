'use strict';

// YAAM Stage 33.3 — единственная pre-deploy проверка миграции 0013 перед
// commit/push/deploy: доказывает, что migrations/0013_orders_earned_at.sql
// (ещё нигде не применена) корректно обновляет РЕАЛЬНО СУЩЕСТВУЮЩУЮ базу,
// а не только пустую.
//
// НАХОДКА этого этапа (до какого-либо commit/push/deploy): 0013 backfill'ила
// earned_at только для status='delivered'. Заказ, который на момент миграции
// уже находится в status='courier' (ресторан уже физически передал его
// курьеру — тот же физический факт, что и earned_at обязан фиксировать, см.
// комментарий в самой миграции), оставался без earned_at:
//   - сразу после миграции исчезал из EARNED_ORDER_FILTER_SQL
//     (services/hq/restaurantFinanceService.js) — earned_at IS NOT NULL;
//   - НАВСЕГДА оставался без earned_at даже после courier -> delivered,
//     потому что ни confirmReceiptByCustomer(), ни autoCompleteCourierOrders()
//     (services/postgresql/orderService.js) earned_at не устанавливают.
// Миграция исправлена ДО первого deploy (0013 нигде не применялась) —
// добавлен backfill для status='courier' той же логикой, что уже применена
// к 'delivered' (status_updated_at — единственный исторический timestamp
// перехода, ведущего в этот статус).
//
// Этот файл проверяет РЕАЛЬНЫЙ файл migrations/0013_orders_earned_at.sql
// (fs.readFileSync, не копия текста) на базе, приведённой к ТОЧНОМУ
// состоянию "после 0012, до 0013" — schema.sql (уже содержит 'ready'/
// 'courier'/delivered_via инлайн в CREATE TABLE orders, см. Stage 33) минус
// колонка earned_at, которую в реальности добавляет ИМЕННО 0013 (тот же
// приём "откатить одну колонку", что уже доказан в infraStage15.test.js,
// тест MB6: "yaam:allow-destructive не нужен — это тест, а не миграция").
//
// Не переаудирует Stage 33/33.1/33.2 (state machine/Telegram/клиент/
// рейтинг/auto-complete/settlement-архитектуру) — только сам факт
// правильного backfill на upgrade-пути.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const MIGRATION_0013_SQL = fs.readFileSync(
  path.join(__dirname, '../../db/postgresql/migrations/0013_orders_earned_at.sql'), 'utf8',
);
const DATABASE_NAME = 'yaam_earned_at_migration_backfill_333_test';

let cluster;
let db;
let pgOrderService;
let financeService;
let settlementService;
let resolvePeriodRange;

before(async () => {
  cluster = await startEmbeddedPostgres('earned-at-migration-333');
  await cluster.createDatabase(DATABASE_NAME);

  // Состояние "после 0012, до 0013": полная текущая схема (уже включает
  // 'ready'/'courier'/delivered_via — Stage 33/0012), затем откатываем ровно
  // ту одну колонку, которую добавляет проверяемая миграция.
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.query('ALTER TABLE orders DROP COLUMN earned_at');
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

// Заказ, вставленный НАПРЯМУЮ SQL — до применения 0013 колонки earned_at не
// существует вообще, поэтому её нет и не может быть в списке колонок ниже
// (в отличие от Stage 33.1/33.2 тестов, где orders создаются через уже
// полную схему).
async function pgCreateLegacyOrder(restaurantId, { status, statusUpdatedAt, fulfillmentType = 'delivery' }) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, fulfillment_type, status_updated_at
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, $3, $4, $5)
     RETURNING *`,
    [`YAAM-M333-${suffix}`, restaurantId, status, fulfillmentType, statusUpdatedAt]
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

async function applyMigration0013() {
  const client = cluster.getClient(DATABASE_NAME);
  await client.connect();
  try {
    await client.query(MIGRATION_0013_SQL);
  } finally {
    await client.end();
  }
}

async function earnedAtOf(orderId) {
  const row = (await db.query('SELECT earned_at FROM orders WHERE id = $1', [orderId]))[0];
  return row.earned_at;
}

// ===========================================================================
// A. Существующий courier-заказ переживает миграцию финансово
// ===========================================================================

test('A. Существующий status=courier заказ (создан ДО 0013) получает earned_at = status_updated_at при миграции', async () => {
  const restaurantId = await pgCreateRestaurant();
  const dayStr = todayStr(-2);
  const range = resolvePeriodRange({ period: 'custom', from: dayStr, to: dayStr });
  const t1 = new Date(range.startUtc.getTime() + 12 * 60 * 60 * 1000); // фиксированный T1, безопасно в середине суток

  const order = await pgCreateLegacyOrder(restaurantId, { status: 'courier', statusUpdatedAt: t1 });
  await pgCreatePayment(order.id);

  // До миграции колонки нет вообще.
  const beforeCols = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'earned_at'`
  );
  assert.equal(beforeCols.length, 0, 'до 0013 колонки earned_at не должно существовать');

  await applyMigration0013();

  // 1) earned_at = T1.
  const earnedAt = await earnedAtOf(order.id);
  assert.ok(earnedAt instanceof Date, 'earned_at должен быть установлен миграцией');
  assert.equal(earnedAt.getTime(), t1.getTime(), 'earned_at обязан совпасть с status_updated_at перехода ready->courier');

  // 2) заказ сразу проходит EARNED_ORDER_FILTER_SQL (succeeded payment, нет succeeded refund).
  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 1, 'заказ обязан немедленно попасть в финансовый расчёт после миграции');
  assert.equal(rows[0].turnover, 500);
  assert.equal(rows[0].commission, 35);
  assert.equal(rows[0].delivered_paid_orders, 1);

  // 3) customer confirm (courier -> delivered) не должен менять earned_at.
  await pgOrderService.confirmReceiptByCustomer(order.id);
  const earnedAtAfterConfirm = await earnedAtOf(order.id);
  assert.equal(earnedAtAfterConfirm.getTime(), t1.getTime(), 'confirmReceiptByCustomer не должен трогать earned_at, зафиксированный миграцией');

  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.status, 'delivered');

  // 4) settlement period остаётся периодом T1 (не "сегодня", не датой клика).
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: dayStr, periodTo: dayStr });
  const closed = await settlementService.closeSettlementPeriod(period.id);
  const ownLine = closed.lines.find((l) => l.restaurant_id === restaurantId);
  assert.ok(ownLine, `заказ обязан попасть в период T1 (${dayStr}) по earned_at, не по дате клика клиента`);
  assert.equal(ownLine.turnover, 500);
});

// ===========================================================================
// B. Исторический delivered-заказ (backfill уже был реализован) — доказательство upgrade-путём
// ===========================================================================

test('B. Исторический status=delivered заказ (создан ДО 0013) получает earned_at = status_updated_at при миграции', async () => {
  const restaurantId = await pgCreateRestaurant();
  const dayStr = todayStr(-3);
  const range = resolvePeriodRange({ period: 'custom', from: dayStr, to: dayStr });
  const t1 = new Date(range.startUtc.getTime() + 9 * 60 * 60 * 1000);

  const order = await pgCreateLegacyOrder(restaurantId, { status: 'delivered', statusUpdatedAt: t1 });
  await pgCreatePayment(order.id);

  await applyMigration0013();

  const earnedAt = await earnedAtOf(order.id);
  assert.ok(earnedAt instanceof Date);
  assert.equal(earnedAt.getTime(), t1.getTime(), 'исторический delivered-заказ обязан получить earned_at = status_updated_at');

  const rows = await financeService.computeEarningsAggregate({ restaurantId, range: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turnover, 500);
});

// ===========================================================================
// C. Незаработанные статусы остаются NULL после миграции
// ===========================================================================

test('C. Заказы в незаработанных статусах остаются с earned_at = NULL после миграции', async () => {
  const restaurantId = await pgCreateRestaurant();
  const now = new Date();

  const nonEarnedStatuses = [
    'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'ready',
    'cancelled', 'declined', 'timed_out', 'payment_failed',
  ];

  const orders = [];
  for (const status of nonEarnedStatuses) {
    // eslint-disable-next-line no-await-in-loop
    const order = await pgCreateLegacyOrder(restaurantId, { status, statusUpdatedAt: now });
    orders.push({ status, order });
  }

  await applyMigration0013();

  for (const { status, order } of orders) {
    // eslint-disable-next-line no-await-in-loop
    const earnedAt = await earnedAtOf(order.id);
    assert.equal(earnedAt, null, `status=${status} не должен получить earned_at от миграции`);
  }
});
