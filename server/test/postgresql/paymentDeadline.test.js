'use strict';

// Stage 11A follow-up: неизменяемый серверный срок оплаты
// (payment_expires_at / paymentExpiresAt) — PostgreSQL-параллель
// server/test/paymentDeadline.test.js, против настоящего embedded
// PostgreSQL 16.14. Покрывает те же 8 пунктов из задачи, что и SQLite-файл
// (см. комментарий там для полного списка).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_payment_deadline_test';

let cluster;
let db;
let orderService;

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  cluster = await startEmbeddedPostgres('payment-deadline');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  orderService = require('../../services/postgresql/orderService.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniquePhone() {
  const n = crypto.randomInt(100000000, 999999999);
  return `+79${String(n).padStart(8, '0')}`;
}

function orderToken() {
  return `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

function createKey() {
  return `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

function retryKeyGen() {
  return `yaam_retry_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order) VALUES ('Test', 'test', '[]', 1, 0) RETURNING id`,
  );
  return rows[0].id;
}

async function pgCreateMenuItem(restaurantId) {
  const catRows = await db.query(`INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`, [restaurantId]);
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1, $2, 'Item', 500, 1) RETURNING id`,
    [restaurantId, catRows[0].id],
  );
  return rows[0].id;
}

async function seedMinimalRestaurant() {
  const restaurantId = await pgCreateRestaurant();
  const menuItemId = await pgCreateMenuItem(restaurantId);
  return { restaurantId, menuItemId };
}

function basicOrderPayload(restaurantId, menuItemId, overrides = {}) {
  return {
    restaurantId,
    city: 'Грозный',
    customerName: 'Тест Тестов',
    customerPhone: overrides.customerPhone || uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', qty: 1 }],
    orderAccessToken: overrides.orderAccessToken || orderToken(),
    createIdempotencyKey: overrides.createIdempotencyKey || createKey(),
    ...overrides.extraFields,
  };
}

async function createOrderDirect(overrides = {}) {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant();
  const payload = basicOrderPayload(restaurantId, menuItemId, overrides);
  const resolved = await orderService.createOrderAndResolve(payload);
  return {
    order: orderService.toPublicOrderDTO(resolved.order),
    payment: orderService.toPublicPaymentDTO(resolved.payment),
    payload,
    orderId: resolved.order.id,
  };
}

// 1. -------------------------------------------------------------------
test('paymentExpiresAt — ровно PAYMENT_DEADLINE_MINUTES (15) минут от создания платежа', async () => {
  const before1 = Date.now();
  const { payment } = await createOrderDirect();
  const after1 = Date.now();
  assert.ok(payment.paymentExpiresAt, 'создание заказа должно вернуть paymentExpiresAt');

  const deadline = new Date(payment.paymentExpiresAt).getTime();
  const minExpected = before1 + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000;
  const maxExpected = after1 + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000;
  assert.ok(
    deadline >= minExpected - 1000 && deadline <= maxExpected + 1000,
    `paymentExpiresAt должен быть ровно ${orderService.PAYMENT_DEADLINE_MINUTES} минут после created_at`,
  );
});

// 2. -------------------------------------------------------------------
test('payment_expires_at сохраняется в orderService.getOrder() и в toPublicOrderDTO()', async () => {
  const { orderId, payment } = await createOrderDirect();
  const fetched = await orderService.getOrder(orderId);
  assert.ok(fetched.payment_expires_at, 'getOrder() должен вернуть payment_expires_at');
  const dto = orderService.toPublicOrderDTO(fetched);
  assert.equal(dto.payment_expires_at, payment.paymentExpiresAt);
});

// 3. -------------------------------------------------------------------
test('payment_expires_at не сбрасывается при повторном GET (симуляция refresh/reopen)', async () => {
  const { orderId } = await createOrderDirect();
  const first = orderService.toPublicOrderDTO(await orderService.getOrder(orderId)).payment_expires_at;
  const second = orderService.toPublicOrderDTO(await orderService.getOrder(orderId)).payment_expires_at;
  const third = orderService.toPublicOrderDTO(await orderService.getOrder(orderId)).payment_expires_at;
  assert.equal(second, first);
  assert.equal(third, first);
});

// 4. -------------------------------------------------------------------
test('повторный create (exact replay теми же credentials) не продлевает срок', async () => {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant();
  const payload = basicOrderPayload(restaurantId, menuItemId);
  const first = await orderService.createOrderAndResolve(payload);
  const replay = await orderService.createOrderAndResolve(payload);
  assert.equal(replay.order.id, first.order.id, 'replay должен вернуть тот же заказ');
  assert.equal(
    orderService.toPublicPaymentDTO(replay.payment).paymentExpiresAt,
    orderService.toPublicPaymentDTO(first.payment).paymentExpiresAt,
    'replay не должен создавать новый дедлайн',
  );
});

test('recoverOrder() (body-less восстановление) тоже не продлевает срок', async () => {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant();
  const payload = basicOrderPayload(restaurantId, menuItemId);
  const first = await orderService.createOrderAndResolve(payload);
  const recovered = await orderService.recoverOrder({
    orderAccessToken: payload.orderAccessToken,
    createIdempotencyKey: payload.createIdempotencyKey,
  });
  assert.equal(recovered.order.id, first.order.id);
  assert.equal(
    orderService.toPublicPaymentDTO(recovered.payment).paymentExpiresAt,
    orderService.toPublicPaymentDTO(first.payment).paymentExpiresAt,
  );
});

// 5. -------------------------------------------------------------------
test('истёкший дедлайн отображается как есть (в прошлом), сервер его не скрывает и не обнуляет', async () => {
  const { orderId, payment } = await createOrderDirect();
  await db.query(
    `UPDATE payment_presentations SET expires_at = NOW() - interval '1 minute'
     WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1)`,
    [orderId],
  );
  const dto = orderService.toPublicOrderDTO(await orderService.getOrder(orderId));
  assert.ok(dto.payment_expires_at, 'истёкший дедлайн должен остаться в DTO');
  assert.ok(new Date(dto.payment_expires_at).getTime() < Date.now(), 'дедлайн должен быть в прошлом');
  assert.notEqual(dto.payment_expires_at, payment.paymentExpiresAt);
});

// 6. -------------------------------------------------------------------
test('успешная оплата ДО истечения дедлайна проходит штатно (deadline не блокирует markPaid)', async () => {
  const { orderId, payment } = await createOrderDirect();
  assert.ok(new Date(payment.paymentExpiresAt).getTime() > Date.now(), 'дедлайн ещё не истёк на момент оплаты');
  const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]))[0];
  const paid = await orderService.markPaid(orderId, paymentRow.id);
  assert.equal(paid.status, 'awaiting_restaurant', 'оплата должна пройти штатно независимо от наличия дедлайна');
});

// 7. -------------------------------------------------------------------
test('payment retry: явная повторная попытка получает СВОЙ новый дедлайн (независимо посчитанный от собственного payments.created_at)', async () => {
  const { orderId } = await createOrderDirect();
  const firstPaymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]))[0];
  await orderService.markPaymentFailed(orderId, firstPaymentRow.id);

  const retried = await orderService.retryPayment(orderId, retryKeyGen());
  const publicRetried = orderService.toPublicPaymentDTO(retried);
  assert.ok(publicRetried.paymentExpiresAt, 'retry должен получить свой дедлайн');

  const retryPaymentRow = (await db.query(`SELECT id, created_at FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]))[0];
  assert.notEqual(retryPaymentRow.id, firstPaymentRow.id, 'retry должен создать новую строку payments, а не переиспользовать первую');
  const expectedRetryDeadline = new Date(new Date(retryPaymentRow.created_at).getTime() + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000);
  assert.equal(publicRetried.paymentExpiresAt, expectedRetryDeadline.toISOString(), 'дедлайн retry должен считаться от created_at именно retry-платежа');

  const rereadOrder = orderService.toPublicOrderDTO(await orderService.getOrder(orderId));
  assert.equal(rereadOrder.payment_expires_at, publicRetried.paymentExpiresAt, 'повторное GET не должно менять уже выданный retry-дедлайн');
});

test('payment retry: повторный вызов с ТЕМ ЖЕ retryKey — идемпотентен, дедлайн не меняется', async () => {
  const { orderId } = await createOrderDirect();
  const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]))[0];
  await orderService.markPaymentFailed(orderId, paymentRow.id);

  const key = retryKeyGen();
  const firstRetry = orderService.toPublicPaymentDTO(await orderService.retryPayment(orderId, key));
  const secondRetry = orderService.toPublicPaymentDTO(await orderService.retryPayment(orderId, key));
  assert.equal(secondRetry.paymentExpiresAt, firstRetry.paymentExpiresAt, 'повтор с тем же ключом должен быть идемпотентным, включая дедлайн');
});

// 8. -------------------------------------------------------------------
test('некорректные/произвольные поля от клиента (в т.ч. попытка передать свой expiresAt) не влияют на серверное значение', async () => {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant();
  const payload = {
    ...basicOrderPayload(restaurantId, menuItemId),
    paymentExpiresAt: '1999-01-01T00:00:00.000Z',
    now: '1999-01-01T00:00:00.000Z',
    clientClock: 0,
  };
  const before1 = Date.now();
  const resolved = await orderService.createOrderAndResolve(payload);
  const payment = orderService.toPublicPaymentDTO(resolved.payment);
  const deadline = new Date(payment.paymentExpiresAt).getTime();
  assert.ok(deadline > before1, 'дедлайн должен вычисляться от реального серверного времени, а не от посторонних клиентских полей');
  assert.ok(
    Math.abs(deadline - (before1 + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000)) < 5000,
    'дедлайн должен остаться равным ровно PAYMENT_DEADLINE_MINUTES от серверного now()',
  );
});
