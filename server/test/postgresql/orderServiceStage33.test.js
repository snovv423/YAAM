'use strict';

// YAAM Stage 33 — «чистая логика заказа: Готово -> ждём курьера -> передан ->
// получен клиентом». Integration-тесты для новых/изменённых частей
// server/services/postgresql/orderService.js: ADVANCE_MAP (ready-статус),
// restaurantAdvance (preparing->ready->courier, курьер больше не может
// закрыться из Telegram), confirmReceiptByCustomer (courier->delivered
// клиентом), autoCompleteCourierOrders (6-часовой safety net). Против
// настоящего embedded PostgreSQL — тот же паттерн, что Wave1/Wave3.
//
// НЕ parity-тесты против SQLite: 'ready' — сознательно PostgreSQL-only
// статус (см. CLAUDE.md, миграция 0012) — в SQLite-схеме его не существует
// и никогда не будет, поэтому сравнивать здесь нечего.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_orderservice_stage33_test';

let cluster;
let db;
let pgOrderService;

before(async () => {
  cluster = await startEmbeddedPostgres('orderservice-stage33');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');
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
    [`YAAM-S33-${suffix}`, restaurantId, status, fulfillmentType, statusUpdatedAt]
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
// 1-5. restaurantAdvance — новая цепочка preparing -> ready -> courier
// ===========================================================================

test('1. restaurantAdvance: preparing -> ready успешен, preparation_deadline обнуляется', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing' });
  await db.execute('UPDATE orders SET preparation_deadline = NOW() + interval \'30 minutes\' WHERE id = $1', [order.id]);

  const result = await pgOrderService.restaurantAdvance(order.id, 'ready');
  assert.equal(result.status, 'ready');
  assert.equal(result.preparation_deadline, null);
});

test('2. restaurantAdvance: повторное «Готово» на уже ready-заказе бросает (не идемпотентно, как и остальные переходы)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing' });
  await pgOrderService.restaurantAdvance(order.id, 'ready');
  await assert.rejects(() => pgOrderService.restaurantAdvance(order.id, 'ready'));
});

test('3. restaurantAdvance: ready -> courier успешен', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  const result = await pgOrderService.restaurantAdvance(order.id, 'courier');
  assert.equal(result.status, 'courier');
});

test('4. restaurantAdvance: preparing -> courier напрямую (минуя ready) запрещён', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing' });
  await assert.rejects(
    () => pgOrderService.restaurantAdvance(order.id, 'courier'),
    /нельзя перейти из preparing в courier/,
  );
});

test('5. restaurantAdvance: ресторан НЕ может перевести courier -> delivered (delivery) — переход убран из ADVANCE_MAP', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier', fulfillmentType: 'delivery' });
  await assert.rejects(
    () => pgOrderService.restaurantAdvance(order.id, 'delivered'),
    /нельзя перейти из courier в delivered/,
  );
  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.status, 'courier', 'заказ обязан остаться в courier');
});

test('5b. Инвариант: ready -> delivered ресторану тоже запрещён', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await assert.rejects(() => pgOrderService.restaurantAdvance(order.id, 'delivered'));
});

test('5c. Инвариант: preparing -> delivered ресторану запрещён для delivery', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing', fulfillmentType: 'delivery' });
  await assert.rejects(() => pgOrderService.restaurantAdvance(order.id, 'delivered'));
});

test('5d. Инвариант: pickup по-прежнему может preparing -> delivered напрямую (не затронуто Stage 33)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'preparing', fulfillmentType: 'pickup' });
  const result = await pgOrderService.restaurantAdvance(order.id, 'delivered');
  assert.equal(result.status, 'delivered');
});

// ===========================================================================
// 6-10. confirmReceiptByCustomer — courier -> delivered клиентом
// ===========================================================================

test('6. confirmReceiptByCustomer: courier -> delivered, delivered_via=customer_confirmed', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier' });
  const result = await pgOrderService.confirmReceiptByCustomer(order.id);
  assert.equal(result.status, 'delivered');
  const row = (await db.query('SELECT delivered_via FROM orders WHERE id = $1', [order.id]))[0];
  assert.equal(row.delivered_via, 'customer_confirmed');
});

test('6b. confirmReceiptByCustomer: несуществующий заказ бросает «заказ не найден»', async () => {
  await assert.rejects(() => pgOrderService.confirmReceiptByCustomer(999999999), /заказ не найден/);
});

test('7. confirmReceiptByCustomer: заказ не найден — тот же путь, что и в API «неверный/отсутствующий доступ» (маршрут вызывает эту функцию только после успешной авторизации по токену)', async () => {
  // Сама проверка токена — на уровне routes/postgresql/api.js
  // (requireOrderAccess), см. test/postgresql/routesApiStage1.test.js
  // "без токена даёт 401". orderService-слой здесь гарантирует только то,
  // что несуществующий/чужой orderId не создаёт побочных эффектов.
  await assert.rejects(() => pgOrderService.confirmReceiptByCustomer(999999998));
});

test('8. confirmReceiptByCustomer: последовательный двойной клик — идемпотентный успех, без второй ошибки', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier' });
  const first = await pgOrderService.confirmReceiptByCustomer(order.id);
  const second = await pgOrderService.confirmReceiptByCustomer(order.id);
  assert.equal(first.status, 'delivered');
  assert.equal(second.status, 'delivered');
});

test('9. confirmReceiptByCustomer: два конкурентных вызова — ровно один переход, оба резолвятся успешно', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier' });

  let statusEvents = 0;
  const onStatus = () => { statusEvents += 1; };
  pgOrderService.orderEvents.on('order:status', onStatus);
  try {
    const [a, b] = await Promise.all([
      pgOrderService.confirmReceiptByCustomer(order.id),
      pgOrderService.confirmReceiptByCustomer(order.id),
    ]);
    assert.equal(a.status, 'delivered');
    assert.equal(b.status, 'delivered');
    assert.equal(statusEvents, 1, 'order:status должен эмититься РОВНО один раз на реальный переход, не на проигранную гонку');
  } finally {
    pgOrderService.orderEvents.off('order:status', onStatus);
  }
});

test('10. confirmReceiptByCustomer: запрещённые исходные статусы не подтверждаются', async () => {
  const restaurantId = await pgCreateRestaurant();
  for (const status of ['awaiting_restaurant', 'accepted', 'preparing', 'ready', 'cancelled', 'declined', 'timed_out']) {
    // eslint-disable-next-line no-await-in-loop
    const order = await pgCreateOrder(restaurantId, { status });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => pgOrderService.confirmReceiptByCustomer(order.id),
      undefined,
      `статус ${status} не должен позволять confirmReceiptByCustomer`,
    );
  }
});

// ===========================================================================
// 11-14. autoCompleteCourierOrders — 6-часовой safety net
// ===========================================================================

test('11. autoCompleteCourierOrders: заказ старше 6 часов в courier -> delivered, delivered_via=auto_timeout', async () => {
  const restaurantId = await pgCreateRestaurant();
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000).toISOString();
  const order = await pgCreateOrder(restaurantId, { status: 'courier', statusUpdatedAt: staleAt });

  await pgOrderService.autoCompleteCourierOrders();

  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.status, 'delivered');
  const row = (await db.query('SELECT delivered_via FROM orders WHERE id = $1', [order.id]))[0];
  assert.equal(row.delivered_via, 'auto_timeout');
});

test('12. autoCompleteCourierOrders: свежий courier-заказ (моложе порога) не трогается', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier' }); // status_updated_at = NOW()

  await pgOrderService.autoCompleteCourierOrders();

  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.status, 'courier');
});

test('13. autoCompleteCourierOrders: чисто на основе состояния БД (restart-safe) — вызов без предшествующего состояния процесса всё равно находит и закрывает просроченный заказ', async () => {
  const restaurantId = await pgCreateRestaurant();
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 3600) * 1000).toISOString();
  // Заказ создан напрямую SQL — orderService ничего "не помнит" о нём заранее
  // (никакого предварительного restaurantAdvance/confirmReceiptByCustomer в
  // этом же процессе) — единственный источник данных для sweep'а — таблица orders.
  const order = await pgCreateOrder(restaurantId, { status: 'courier', statusUpdatedAt: staleAt });

  await pgOrderService.autoCompleteCourierOrders();

  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.status, 'delivered');
});

test('14. autoCompleteCourierOrders: не создаёт рейтинг', async () => {
  const restaurantId = await pgCreateRestaurant();
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000).toISOString();
  const order = await pgCreateOrder(restaurantId, { status: 'courier', statusUpdatedAt: staleAt });

  await pgOrderService.autoCompleteCourierOrders();

  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.rating, null, 'auto-complete не должен ставить оценку за клиента');
});

test('14b. После auto-complete клиент всё ещё может поставить РЕАЛЬНУЮ оценку (архитектура рейтинга это разрешает)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000).toISOString();
  const order = await pgCreateOrder(restaurantId, { status: 'courier', statusUpdatedAt: staleAt });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  await pgOrderService.autoCompleteCourierOrders();
  const rated = await pgOrderService.rateOrder(order.id, 4);
  assert.equal(rated.rating, 4);
});

// ===========================================================================
// 15. Финансовая независимость от кнопки клиента
// ===========================================================================

test('15. confirmReceiptByCustomer не меняет финансовые поля заказа и не трогает payments/refunds', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier' });
  const paymentId = await pgCreatePayment(order.id, { status: 'succeeded' });

  const before = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
  await pgOrderService.confirmReceiptByCustomer(order.id);
  const after = await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  const refunds = await db.query('SELECT * FROM refunds WHERE payment_id = $1', [paymentId]);
  const freshOrder = await pgOrderService.getOrder(order.id);

  assert.equal(after[0].status, before[0].status, 'payments.status не должен меняться');
  assert.equal(refunds.length, 0, 'confirmReceiptByCustomer не должен создавать возвраты');
  assert.equal(freshOrder.items_total, 500);
  assert.equal(freshOrder.commission_amount, 35);
});

// ===========================================================================
// 16. ready не ломает существующие инварианты отмены/возврата
// ===========================================================================

test('16. cancelByCustomer: заказ в статусе ready нельзя отменить (та же ошибка, что и preparing/courier)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  await assert.rejects(
    () => pgOrderService.cancelByCustomer(order.id),
    /заказ уже готовится — отменить нельзя/,
  );
});

test('16b. cancelByCustomer: courier по-прежнему нельзя отменить через старый маршрут', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'courier' });
  await assert.rejects(() => pgOrderService.cancelByCustomer(order.id));
});

// ===========================================================================
// 17. HQ/API сериализация ready
// ===========================================================================

test('17. toPublicOrderDTO/toSharedOrderDTO корректно отдают status=ready', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'ready' });
  const fresh = await pgOrderService.getOrder(order.id);

  const publicDto = pgOrderService.toPublicOrderDTO(fresh);
  assert.equal(publicDto.status, 'ready');
  assert.equal(publicDto.delivered_via, undefined, 'delivered_via — внутреннее поле, не должно утекать в публичный DTO');

  const sharedDto = pgOrderService.toSharedOrderDTO(fresh);
  assert.equal(sharedDto.status, 'ready');
  assert.equal(sharedDto.is_paid, true, 'ready — оплаченный, реально идущий заказ');
});

// ===========================================================================
// 18. delivered_via различает клиента и auto-complete на разных заказах
// ===========================================================================

test('18. delivered_via различает customer_confirmed и auto_timeout для двух независимых заказов', async () => {
  const restaurantId = await pgCreateRestaurant();
  const confirmed = await pgCreateOrder(restaurantId, { status: 'courier' });
  const staleAt = new Date(Date.now() - (pgOrderService.COURIER_AUTO_COMPLETE_SEC + 60) * 1000).toISOString();
  const timedOut = await pgCreateOrder(restaurantId, { status: 'courier', statusUpdatedAt: staleAt });

  await pgOrderService.confirmReceiptByCustomer(confirmed.id);
  await pgOrderService.autoCompleteCourierOrders();

  const rows = await db.query(
    'SELECT id, delivered_via FROM orders WHERE id = ANY($1)',
    [[confirmed.id, timedOut.id]],
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.delivered_via]));
  assert.equal(byId[confirmed.id], 'customer_confirmed');
  assert.equal(byId[timedOut.id], 'auto_timeout');
});

// ===========================================================================
// Дополнительный инвариант (задание, раздел 12): delivered — терминален,
// restaurantAdvance из delivered никуда не переводит.
// ===========================================================================

test('Инвариант: restaurantAdvance из delivered всегда бросает (терминальное состояние)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'delivered' });
  await assert.rejects(() => pgOrderService.restaurantAdvance(order.id, 'courier'));
  await assert.rejects(() => pgOrderService.restaurantAdvance(order.id, 'ready'));
});
