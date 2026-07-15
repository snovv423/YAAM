// HTTP-level regression test: доказывает не только корректность
// toPublicOrderDTO(), но и реальную route wiring-связь
//   GET /api/orders/:code -> orderService.getOrder() -> toPublicOrderDTO() -> res.json()
// Ловит будущую случайную замену res.json(orderService.toPublicOrderDTO(order))
// на res.json(order) — publicOrderDto.test.js этого не поймает, так как
// вызывает mapper напрямую, в обход самого HTTP-роута.
//
// Продакшен-код (routes/api.js, server.js) НЕ используется как есть: server.js
// сам вызывает app.listen() и планирует sweep-интервалы уже при require() и
// ничего не экспортирует — поднимать его в тесте небезопасно и не нужно.
// Здесь используется тот же самый неизменённый router из routes/api.js,
// обёрнутый в собственное одноразовое Express-приложение с app.listen(0)
// (эфемерный порт от ОС, не хардкод) — это и есть реальный production route,
// просто без побочных эффектов server.js вокруг него.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');

let server;
let baseUrl;
let restaurantId;
let menuItemId;
let orderCode;
let orderAccessToken;

before(async () => {
  const express = require('express');
  const apiRoutes = require('../routes/api');

  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79289990001' });
  orderAccessToken = payload.orderAccessToken;
  const { order } = await orderService.createOrder(payload);
  orderCode = order.public_code;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDbFile(dbPath);
});

const PUBLIC_ALLOWLIST = [
  'public_code', 'status', 'status_updated_at', 'items_total',
  'estimated_ready_minutes', 'restaurant_phone', 'fulfillment_type', 'rating',
  'refund_status',
];
const FORBIDDEN_FIELDS = [
  'id', 'restaurant_id', 'city', 'customer_name', 'customer_phone', 'address',
  'comment', 'commission_amount', 'created_at', 'restaurant_name', 'items',
];

function auth(token = orderAccessToken) {
  return { Authorization: `Bearer ${token}` };
}

test('GET /api/orders/:code для существующего заказа возвращает HTTP 200', async () => {
  const res = await fetch(`${baseUrl}/api/orders/${orderCode}`, { headers: auth() });
  assert.equal(res.status, 200);
});

test('GET /api/orders/:code — ответ содержит только утверждённый public allowlist', async () => {
  const res = await fetch(`${baseUrl}/api/orders/${orderCode}`, { headers: auth() });
  const body = await res.json();
  for (const field of PUBLIC_ALLOWLIST) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, field), true, `ответ должен содержать поле "${field}"`);
  }
  assert.equal(Object.keys(body).length, PUBLIC_ALLOWLIST.length, 'в ответе не должно быть полей сверх allowlist');
});

test('GET /api/orders/:code — ответ НЕ содержит PII и внутренних полей (проверка реального route, не mapper напрямую)', async () => {
  const res = await fetch(`${baseUrl}/api/orders/${orderCode}`, { headers: auth() });
  const body = await res.json();
  for (const field of FORBIDDEN_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, field), false, `ответ HTTP-роута не должен содержать поле "${field}"`);
  }
});

test('GET /api/orders/:code для неизвестного кода возвращает HTTP 404', async () => {
  const res = await fetch(`${baseUrl}/api/orders/YAAM-99999`, { headers: auth() });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('GET существующего заказа без bearer-токена возвращает HTTP 401', async () => {
  const res = await fetch(`${baseUrl}/api/orders/${orderCode}`);
  assert.equal(res.status, 401);
});

test('GET существующего заказа с чужим валидным токеном не раскрывает его существование', async () => {
  const wrong = `yaam_ord_v1_${Buffer.alloc(32, 7).toString('base64url')}`;
  const res = await fetch(`${baseUrl}/api/orders/${orderCode}`, { headers: auth(wrong) });
  assert.equal(res.status, 404);
});
