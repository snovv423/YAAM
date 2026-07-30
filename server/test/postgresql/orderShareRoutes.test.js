'use strict';

// Фича «Поделиться заказом» (Web Share API) — read-only share-токен,
// отдельный от владельческого access_token (см. orderShareService.js и
// order_share_tokens в db/postgresql/schema.sql). Тот же embedded-PostgreSQL
// HTTP-harness, что и routesApiStage1.test.js: реальный Express-роутер
// server/routes/postgresql/api.js, поднятый на эфемерном порту.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_order_share_routes_test';

let cluster;
let db;
let orderService;
let mainServer;
let mainBaseUrl;

after(async () => {
  if (mainServer) await new Promise((resolve) => mainServer.close(resolve));
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  cluster = await startEmbeddedPostgres('order-share-routes');
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

// ---------------------------------------------------------------------------
// Fixtures (тот же стиль, что и routesApiStage1.test.js)
// ---------------------------------------------------------------------------

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
  const catRows = await db.query(
    `INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`,
    [restaurantId],
  );
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available)
     VALUES ($1, $2, 'Item', 500, 1) RETURNING id`,
    [restaurantId, catRows[0].id],
  );
  return rows[0].id;
}

async function createOrderDirect() {
  const restaurantId = await pgCreateRestaurant();
  const menuItemId = await pgCreateMenuItem(restaurantId);
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'Тест Тестов',
    customerPhone: uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', qty: 1 }],
    orderAccessToken: orderToken(),
    createIdempotencyKey: createKey(),
  };
  const body = await orderService.createOrderAndResolve(payload);
  return { order: orderService.toPublicOrderDTO(body.order), payload };
}

// ---------------------------------------------------------------------------
// POST /api/orders/:code/share
// ---------------------------------------------------------------------------

test('POST /orders/:code/share — без владельческого Authorization даёт 401', async () => {
  const { order } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { 'X-Share-Token': shareToken() },
  });
  assert.equal(res.status, 401);
});

test('POST /orders/:code/share — некорректный формат share-токена даёт 400', async () => {
  const { order, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': 'not-a-real-token' },
  });
  assert.equal(res.status, 400);
});

test('POST /orders/:code/share — владелец успешно регистрирует share-токен (204)', async () => {
  const { order, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': shareToken() },
  });
  assert.equal(res.status, 204);
});

// ---------------------------------------------------------------------------
// GET /api/orders/:code/shared
// ---------------------------------------------------------------------------

// Строгий, точный allowlist — НЕ toPublicOrderDTO (владельческий, содержит
// refund_status/payment_expires_at/rating, которых здесь быть не должно).
// Явный список ключей защищает от будущей регрессии, если toSharedOrderDTO
// когда-нибудь по ошибке начнёт спредить весь order-объект.
const SHARED_DTO_ALLOWLIST = [
  'public_code', 'restaurant_name', 'restaurant_phone', 'fulfillment_type',
  'status', 'estimated_ready_minutes', 'items', 'items_total',
].sort();

test('GET /orders/:code/shared — DTO содержит РОВНО allowlist полей, не владельческий toPublicOrderDTO', async () => {
  const { order, payload } = await createOrderDirect();
  const token = shareToken();
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': token },
  });

  const sharedRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, {
    headers: auth(token),
  });
  assert.equal(sharedRes.status, 200);
  const sharedBody = await sharedRes.json();
  assert.deepEqual(Object.keys(sharedBody).sort(), SHARED_DTO_ALLOWLIST);
  assert.equal(sharedBody.public_code, order.public_code);
  assert.equal(sharedBody.restaurant_name, 'Test Restaurant');
  assert.equal(sharedBody.restaurant_phone, '+79280000099');
  assert.equal(sharedBody.fulfillment_type, 'delivery');
  assert.equal(sharedBody.status, 'awaiting_payment');
  assert.deepEqual(sharedBody.items, [{ name: 'Item', price: 500, qty: 1 }]);
  assert.equal(sharedBody.items_total, 500);
});

test('GET /orders/:code/shared — без Authorization даёт 401', async () => {
  const { order } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`);
  assert.equal(res.status, 401);
});

test('GET /orders/:code/shared — незарегистрированный (чужой) share-токен даёт 404', async () => {
  const { order, payload } = await createOrderDirect();
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': shareToken() },
  });
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, {
    headers: auth(shareToken()),
  });
  assert.equal(res.status, 404);
});

test('GET /orders/:code/shared — владельческий access_token НЕ принимается этим роутом (401)', async () => {
  const { order, payload } = await createOrderDirect();
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': shareToken() },
  });
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, {
    headers: auth(payload.orderAccessToken),
  });
  assert.equal(res.status, 401, 'requireOrderShareAccess должен отклонять токены с другим префиксом, не только чужие share-токены');
});

test('Безопасность: share-токен НЕ даёт доступа к cancel/retry-payment/rate (только к GET /shared)', async () => {
  const { order, payload } = await createOrderDirect();
  const token = shareToken();
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': token },
  });

  const cancelRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/cancel`, {
    method: 'POST', headers: auth(token),
  });
  assert.equal(cancelRes.status, 401, 'cancel не должен приниматься share-токеном');

  const rateRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/rate`, {
    method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: 5 }),
  });
  assert.equal(rateRes.status, 401, 'rate не должен приниматься share-токеном');

  const retryRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/retry-payment`, {
    method: 'POST', headers: auth(token),
  });
  assert.equal(retryRes.status, 401, 'retry-payment не должен приниматься share-токеном');
});

test('POST /orders/:code/share повторно — новый share-токен заменяет старый (старая ссылка перестаёт работать)', async () => {
  const { order, payload } = await createOrderDirect();
  const firstToken = shareToken();
  const secondToken = shareToken();
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': firstToken },
  });
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': secondToken },
  });

  const oldRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, { headers: auth(firstToken) });
  assert.equal(oldRes.status, 404, 'старый share-токен должен перестать работать после замены');

  const newRes = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, { headers: auth(secondToken) });
  assert.equal(newRes.status, 200, 'новый share-токен должен работать');
});

test('GET /orders/:code/shared — не содержит клиентских ПДн и внутренних/платёжных/технических полей', async () => {
  const { order, payload } = await createOrderDirect();
  const token = shareToken();
  await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/share`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'X-Share-Token': token },
  });
  const res = await fetch(`${mainBaseUrl}/api/orders/${order.public_code}/shared`, { headers: auth(token) });
  const body = await res.json();
  const FORBIDDEN = [
    // ПДн заказчика
    'customer_name', 'customer_phone', 'address', 'comment',
    // внутренние/административные поля заказа
    'id', 'restaurant_id', 'city', 'created_at', 'commission_amount',
    // управляющие/платёжные/технические поля — присутствовали в
    // владельческом toPublicOrderDTO, но НЕ должны попадать сюда
    'rating', 'refund_status', 'payment_expires_at', 'status_updated_at',
    // токены/секреты и Telegram-данные ресторана
    'access_token', 'token_hash', 'telegram_chat_id',
  ];
  for (const forbidden of FORBIDDEN) {
    assert.equal(forbidden in body, false, `поле ${forbidden} не должно быть в публичном share-DTO`);
  }
});
