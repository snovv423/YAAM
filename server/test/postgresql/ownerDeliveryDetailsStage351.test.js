'use strict';

// YAAM Stage 35.1 — owner order DTO: address/comment должны переживать
// потерю localStorage. До этой стадии единственным источником блока
// «Доставка» на клиенте был client-side fallbackContext/yaam_active_order —
// toPublicOrderDTO() (owner-protected GET /api/orders/:code) их не
// возвращал вовсе. Этот файл — минимальные, явно поименованные тесты
// A/B/C из задания Stage 35.1; более широкое регрессионное покрытие уже
// расширено в routesApiStage1.test.js (PUBLIC_ALLOWLIST/FORBIDDEN_FIELDS)
// и orderShareRoutes.test.js (SHARED_DTO_ALLOWLIST, точный allowlist).
//
// Тот же embedded-PostgreSQL HTTP-harness, что и оба файла выше: реальный
// Express-роутер server/routes/postgresql/api.js на эфемерном порту.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_owner_delivery_details_351_test';

let cluster;
let db;
let orderService;
let mainServer;
let mainBaseUrl;

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  cluster = await startEmbeddedPostgres('owner-delivery-details-351');
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
  app.use((req, res, next) => {
    if (req.path === '/api/webhooks/payment') return next();
    express.json()(req, res, next);
  });
  app.use('/api', apiRoutes);
  mainServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => mainServer.once('listening', resolve));
  mainBaseUrl = `http://127.0.0.1:${mainServer.address().port}`;
});

after(async () => {
  if (mainServer) await new Promise((resolve) => mainServer.close(resolve));
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
function shareToken() {
  return `yaam_shr_v1_${crypto.randomBytes(32).toString('base64url')}`;
}
function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count, published_at)
     VALUES ('Test Restaurant', 'test', $1, 1, 0, '+79280000099', 4.5, 10, NOW()) RETURNING id`,
    [JSON.stringify(['Грозный'])],
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
async function createOrderDirect({ address = 'ул. Тестовая, 1', comment = 'Позвоните заранее' } = {}) {
  const restaurantId = await pgCreateRestaurant();
  const menuItemId = await pgCreateMenuItem(restaurantId);
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Тест Тестов', customerPhone: uniquePhone(),
    address, comment, fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', qty: 1 }],
    orderAccessToken: orderToken(), createIdempotencyKey: createKey(),
  };
  const body = await orderService.createOrderAndResolve(payload);
  return { order: orderService.toPublicOrderDTO(body.order), payload };
}

// ===========================================================================
// A. Owner DTO содержит delivery address/comment
// ===========================================================================

test('A. GET /api/orders/:code (владелец) содержит address и comment заказа', async () => {
  const { order, payload } = await createOrderDirect({ address: 'ул. Победы, 5, кв. 12', comment: 'Домофон сломан' });
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}`, { headers: auth(payload.orderAccessToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.address, 'ул. Победы, 5, кв. 12');
  assert.equal(body.comment, 'Домофон сломан');
  assert.equal(body.fulfillment_type, 'delivery');
});

// ===========================================================================
// B. Share DTO НЕ содержит address/comment
// ===========================================================================

test('B. GET /api/orders/:code/shared (share-токен) НЕ содержит address/comment', async () => {
  const { order, payload } = await createOrderDirect({ address: 'секретный домашний адрес', comment: 'секретный комментарий' });
  const token = shareToken();
  const shareRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': token },
  });
  assert.equal(shareRes.status, 204);

  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, { headers: auth(token) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'address'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'comment'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'customer_name'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'customer_phone'), false);
  assert.equal(JSON.stringify(body).includes('секретный'), false, 'секретные значения не должны утечь ни в одно поле DTO');
});

// ===========================================================================
// C. Без/с невалидным owner-токеном защищённые данные недоступны
// ===========================================================================

test('C1. GET /api/orders/:code без Authorization — 401, тело не содержит данных заказа', async () => {
  const { order } = await createOrderDirect({ address: 'секретный адрес C1' });
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(JSON.stringify(body).includes('секретный'), false);
});

test('C2. GET /api/orders/:code с чужим/неверным токеном — 404, адрес не раскрыт', async () => {
  const { order } = await createOrderDirect({ address: 'секретный адрес C2' });
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}`, { headers: auth(orderToken()) });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(JSON.stringify(body).includes('секретный'), false);
});
