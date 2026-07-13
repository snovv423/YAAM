const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload,
} = require('./helpers/testDb');

process.env.ENABLE_DEV_PAYMENT_ROUTES = 'true';
process.env.APP_ENV = 'staging';
const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');

let server;
let baseUrl;
let payload;
let order;

before(async () => {
  const express = require('express');
  const apiRoutes = require('../routes/api');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  const { restaurantId, menuItemId } = seedMinimalRestaurant(db);
  payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280002001' });
  ({ order } = await orderService.createOrder(payload));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDbFile(dbPath);
});

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test('в закрытом staging dev-confirm всё равно не работает без order token', async () => {
  const res = await fetch(`${baseUrl}/api/orders/${order.public_code}/dev-confirm-payment`, { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal(orderService.getOrder(order.id).status, 'awaiting_payment');
});

test('чужой token не может подтвердить mock-оплату', async () => {
  const wrong = `yaam_ord_v1_${Buffer.alloc(32, 9).toString('base64url')}`;
  const res = await fetch(`${baseUrl}/api/orders/${order.public_code}/dev-confirm-payment`, {
    method: 'POST', headers: auth(wrong),
  });
  assert.equal(res.status, 404);
  assert.equal(orderService.getOrder(order.id).status, 'awaiting_payment');
});

test('владелец может подтвердить только свой mock-платёж, ответ без PII', async () => {
  const res = await fetch(`${baseUrl}/api/orders/${order.public_code}/dev-confirm-payment`, {
    method: 'POST', headers: auth(payload.orderAccessToken),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'awaiting_restaurant');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'customer_phone'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'address'), false);
});
