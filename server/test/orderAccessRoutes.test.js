const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload,
} = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');
const orderAccess = require('../services/orderAccessService');

let server;
let baseUrl;
let restaurantId;
let menuItemId;

before(async () => {
  process.env.ENABLE_DEV_PAYMENT_ROUTES = 'false';
  const express = require('express');
  const apiRoutes = require('../routes/api');
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use('/api', apiRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDbFile(dbPath);
});

function publicBody(payload) {
  const { orderAccessToken, createIdempotencyKey, ...body } = payload;
  return body;
}

let requestIpSequence = 10;
function headers(payload, { includeCreateKey = false } = {}) {
  const result = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${payload.orderAccessToken}`,
    'X-Forwarded-For': `198.51.100.${requestIpSequence++}`,
  };
  if (includeCreateKey) result['Idempotency-Key'] = payload.createIdempotencyKey;
  return result;
}

async function createViaHttp(payload) {
  return fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: headers(payload, { includeCreateKey: true }),
    body: JSON.stringify(publicBody(payload)),
  });
}

function retryKey() {
  return `yaam_retry_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

const FORBIDDEN_FIELDS = [
  'id', 'restaurant_id', 'city', 'customer_name', 'customer_phone', 'address',
  'comment', 'commission_amount', 'created_at', 'restaurant_name', 'items',
  'access_token_hash', 'token_hash', 'create_key_hash', 'request_hash', 'providerPaymentId',
];

function assertNoInternalFields(value) {
  const serialized = JSON.stringify(value);
  for (const field of FORBIDDEN_FIELDS) {
    assert.equal(serialized.includes(`"${field}"`), false, `ответ не должен содержать ${field}`);
  }
}

test('POST /orders без capability отклоняется до создания заказа', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001001' });
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(publicBody(payload)),
  });
  assert.equal(res.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
});

test('POST /orders с коротким/предсказуемым bearer отклоняется', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001014' });
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer YAAM-00001',
      'Idempotency-Key': payload.createIdempotencyKey,
    },
    body: JSON.stringify(publicBody(payload)),
  });
  assert.equal(res.status, 401);
});

test('POST /orders с корректной парой создаёт заказ, не возвращая секреты/PII/provider id', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001002' });
  const res = await createViaHttp(payload);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(body.order.public_code, /^YAAM-\d+$/);
  assert.deepEqual(Object.keys(body.payment).sort(), ['paymentUrl', 'qrPayload']);
  assertNoInternalFields(body);
  assert.equal(JSON.stringify(body).includes(payload.orderAccessToken), false);
  assert.equal(JSON.stringify(body).includes(payload.createIdempotencyKey), false);

  const credential = db.prepare(`
    SELECT token_hash, create_key_hash, request_hash FROM order_access_credentials a
    JOIN orders o ON o.id = a.order_id WHERE o.public_code = ?
  `).get(body.order.public_code);
  assert.equal(ArrayBuffer.isView(credential.token_hash), true);
  assert.equal(credential.token_hash.length, 32);
  assert.equal(credential.create_key_hash.length, 32);
  assert.equal(credential.request_hash.length, 32);
  assert.deepEqual(Buffer.from(credential.token_hash), orderAccess.hashSecret(payload.orderAccessToken));
  assert.deepEqual(Buffer.from(credential.create_key_hash), orderAccess.hashSecret(payload.createIdempotencyKey));
});

test('потерянный ответ: повтор POST с той же парой возвращает тот же заказ без дубля', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001003' });
  const first = await (await createViaHttp(payload)).json();
  const secondResponse = await createViaHttp(payload);
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  assert.equal(second.order.public_code, first.order.public_code);
  assert.deepEqual(second.payment, first.payment, 'повтор должен вернуть ту же безопасную ссылку/QR оплаты');
  const count = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE customer_phone = ?').get('+79280001003').count;
  assert.equal(count, 1);
});

test('idempotency key привязан к содержимому заказа и отклоняет изменённый replay', async () => {
  const original = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001015' });
  await createViaHttp(original);
  const changedRequest = { ...original, address: 'другой адрес' };
  const res = await createViaHttp(changedRequest);
  assert.equal(res.status, 409);
  assert.deepEqual(Object.keys(await res.json()), ['error']);
});

test('тот же телефон+ресторан с другой парой получает нейтральный 409 без данных заказа', async () => {
  const phone = '+79280001004';
  await createViaHttp(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  const res = await createViaHttp(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['error']);
});

test('для idempotent replay должны совпасть оба секрета, не только bearer', async () => {
  const phone = '+79280001013';
  const original = basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone });
  await createViaHttp(original);
  const changedKey = basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: phone,
    orderAccessToken: original.orderAccessToken,
  });
  const res = await createViaHttp(changedKey);
  assert.equal(res.status, 409);
  assert.deepEqual(Object.keys(await res.json()), ['error']);
});

test('чужой токен не может прочитать или отменить заказ', async () => {
  const owner = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001005' });
  const stranger = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001006' });
  const created = await (await createViaHttp(owner)).json();
  const code = created.order.public_code;

  const read = await fetch(`${baseUrl}/api/orders/${code}`, { headers: headers(stranger) });
  const cancel = await fetch(`${baseUrl}/api/orders/${code}/cancel`, {
    method: 'POST', headers: headers(stranger),
  });
  assert.equal(read.status, 404);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(cancel.status, 404);
  assert.equal(orderService.getOrder(code).status, 'awaiting_payment');
});

test('владелец отменяет заказ, а ответ cancel использует безопасный DTO', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001007' });
  const created = await (await createViaHttp(payload)).json();
  const res = await fetch(`${baseUrl}/api/orders/${created.order.public_code}/cancel`, {
    method: 'POST', headers: headers(payload),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'cancelled');
  assertNoInternalFields(body);
});

test('retry-payment доступен только владельцу и не раскрывает provider id', async () => {
  const owner = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001010' });
  const stranger = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001011' });
  const created = await (await createViaHttp(owner)).json();
  const order = orderService.getOrder(created.order.public_code);
  const failedPayment = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'pending'").get(order.id);
  orderService.markPaymentFailed(order.id, failedPayment.id);

  const denied = await fetch(`${baseUrl}/api/orders/${order.public_code}/retry-payment`, {
    method: 'POST', headers: { ...headers(stranger), 'Idempotency-Key': retryKey() },
  });
  assert.equal(denied.status, 404);

  const missingKey = await fetch(`${baseUrl}/api/orders/${order.public_code}/retry-payment`, {
    method: 'POST', headers: headers(owner),
  });
  assert.equal(missingKey.status, 400);

  const malformedKey = await fetch(`${baseUrl}/api/orders/${order.public_code}/retry-payment`, {
    method: 'POST', headers: { ...headers(owner), 'Idempotency-Key': 'retry-1' },
  });
  assert.equal(malformedKey.status, 400);

  const allowed = await fetch(`${baseUrl}/api/orders/${order.public_code}/retry-payment`, {
    method: 'POST', headers: { ...headers(owner), 'Idempotency-Key': retryKey() },
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.deepEqual(Object.keys(body.payment).sort(), ['paymentUrl', 'qrPayload']);
  assertNoInternalFields(body);
});

test('rate требует токен владельца и никогда не возвращает PII', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001008' });
  const stranger = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001012' });
  const created = await (await createViaHttp(payload)).json();
  const order = orderService.getOrder(created.order.public_code);
  const paidPayment = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'pending'").get(order.id);
  orderService.markPaid(order.id, paidPayment.id);
  orderService.restaurantAccept(order.id);
  orderService.restaurantAdvance(order.id, 'preparing');
  orderService.restaurantAdvance(order.id, 'courier');
  orderService.restaurantAdvance(order.id, 'delivered');

  const denied = await fetch(`${baseUrl}/api/orders/${order.public_code}/rate`, {
    method: 'POST', headers: headers(stranger), body: JSON.stringify({ rating: 1 }),
  });
  assert.equal(denied.status, 404);
  assert.equal(orderService.getOrder(order.id).rating, null);

  const res = await fetch(`${baseUrl}/api/orders/${order.public_code}/rate`, {
    method: 'POST', headers: headers(payload), body: JSON.stringify({ rating: 5 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rating, 5);
  assertNoInternalFields(body);
});

test('dev-payment маршруты выключены по умолчанию', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280001009' });
  const created = await (await createViaHttp(payload)).json();
  const res = await fetch(`${baseUrl}/api/orders/${created.order.public_code}/dev-confirm-payment`, {
    method: 'POST', headers: headers(payload),
  });
  assert.equal(res.status, 404);
});
