'use strict';

// YAAM HQ Stage 1: PostgreSQL-паритет server/test/ordersCountDeliveredOnly.test.js
// (SQLite). Публичный счётчик заказов на карточке ресторана должен считать
// только реально завершённые заказы — status='delivered' с оплатой, ещё
// succeeded на момент запроса. Тот же established-приём, что и
// routesApiStage1.test.js: настоящий embedded PostgreSQL + неизменённый
// production-роутер routes/postgresql/api.js, поднятый как отдельное
// Express-приложение, реальный HTTP-запрос против реального порта.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_orders_count_delivered_only_test';

let cluster;
let db;
let orderService;
let server;
let baseUrl;
let restaurantId;
let menuItemId;

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  cluster = await startEmbeddedPostgres('orders-count-delivered-only');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  orderService = require('../../services/postgresql/orderService.js');

  const express = require('express');
  const apiRoutes = require('../../routes/postgresql/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rRows = await db.query(
    // published_at — Stage 4.1: этот файл проверяет публичный API, который
    // теперь требует published_at IS NOT NULL, чтобы ресторан вообще был
    // виден (server/routes/postgresql/api.js) — без этого поля /api/
    // restaurants/:id отвечал бы 404 независимо от заказов.
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count, published_at)
     VALUES ('Test Restaurant', 'test', $1, 1, 0, '+79280000099', 4.5, 10, NOW()) RETURNING id`,
    [JSON.stringify(['Грозный'])],
  );
  restaurantId = rRows[0].id;
  const cRows = await db.query(`INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`, [restaurantId]);
  const iRows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1, $2, 'Item', 300, 1) RETURNING id`,
    [restaurantId, cRows[0].id],
  );
  menuItemId = iRows[0].id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniquePhone() {
  const n = crypto.randomInt(100000000, 999999999);
  return `+79${String(n).padStart(8, '0')}`;
}

function orderPayload(overrides = {}) {
  return {
    restaurantId,
    city: 'Грозный',
    customerName: 'Тест Тестов',
    customerPhone: uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', price: 300, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    ...overrides,
  };
}

async function fetchOrdersCount() {
  const res = await fetch(`${baseUrl}/api/restaurants/${restaurantId}`);
  const body = await res.json();
  return body.orders_count;
}

async function createOrderUpTo(status) {
  const { order } = await orderService.createOrderAndResolve(orderPayload());
  const paymentRows = await db.query(
    `SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  await orderService.markPaid(order.id, paymentRows[0].id);
  if (status === 'awaiting_restaurant') return order;
  await orderService.restaurantAccept(order.id);
  if (status === 'accepted') return order;
  await orderService.restaurantAdvance(order.id, 'preparing');
  if (status === 'preparing') return order;
  await orderService.restaurantAdvance(order.id, 'courier');
  if (status === 'courier') return order;
  await orderService.restaurantAdvance(order.id, 'delivered');
  return order;
}

test('оплаченный, но ещё не принятый рестораном заказ не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('awaiting_restaurant');
  assert.equal(await fetchOrdersCount(), before1);
});

test('принятый рестораном заказ (accepted) не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('accepted');
  assert.equal(await fetchOrdersCount(), before1);
});

test('заказ в статусе preparing не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('preparing');
  assert.equal(await fetchOrdersCount(), before1);
});

test('заказ в статусе courier не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('courier');
  assert.equal(await fetchOrdersCount(), before1);
});

test('заказ, дошедший до delivered, увеличивает публичный счётчик ровно на 1', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('delivered');
  assert.equal(await fetchOrdersCount(), before1 + 1);
});

test('отменённый заказ никогда не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  const { order } = await orderService.createOrderAndResolve(orderPayload());
  await orderService.cancelByCustomer(order.id);
  assert.equal(await fetchOrdersCount(), before1);
});
