'use strict';

// YAAM PostgreSQL routes/api.js — Production Switch Stage 1: реальные HTTP
// integration-тесты против server/routes/postgresql/api.js, поднятого как
// самостоятельное Express-приложение (тот же established-приём, что и
// server/test/publicOrderRoute.test.js/webhookPaymentRoute.test.js/
// devPaymentAccessRoute.test.js для SQLite-версии: собственный app.listen(0)
// вокруг НЕИЗМЕНЁННОГО production-router'а, без supertest — встроенный
// fetch() против реального эфемерного порта).
//
// Использует настоящий embedded PostgreSQL 16.14 (тот же helper, что и все
// волны Wave 1-7) + настоящий mock-провайдер оплаты (PAYMENT_PROVIDER=mock,
// по умолчанию) — сетевые вызовы внутри теста реальны, но 100% in-process
// (MockProvider), внешней сети не требуется.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_routes_api_stage1_test';
const ROUTES_MODULE_PATH = require.resolve('../../routes/postgresql/api.js');

let cluster;
let db;
let orderService;

// Основное приложение (дефолтный ENV: mock-провайдер, dev-роуты выключены,
// webhook не зарегистрирован) — поднимается один раз в before().
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
  cluster = await startEmbeddedPostgres('routes-api-stage1');
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
// Fixtures
// ---------------------------------------------------------------------------

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

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

async function pgCreateRestaurant(overrides = {}) {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count, connect_code, telegram_chat_id)
     VALUES ('Test Restaurant', 'test', $1, $2, $3, '+79280000099', 4.5, 10, $4, $5) RETURNING id`,
    [
      JSON.stringify(overrides.cities || ['Грозный']),
      overrides.isOpen === false ? 0 : 1,
      overrides.minOrder || 0,
      overrides.connectCode || null,
      overrides.telegramChatId || null,
    ],
  );
  return rows[0].id;
}

async function pgCreateMenuItem(restaurantId, overrides = {}) {
  const catRows = await db.query(
    `INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`,
    [restaurantId],
  );
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available)
     VALUES ($1, $2, 'Item', $3, $4) RETURNING id`,
    [restaurantId, catRows[0].id, overrides.price || 500, overrides.isAvailable === false ? 0 : 1],
  );
  return rows[0].id;
}

async function seedMinimalRestaurant(overrides = {}) {
  const restaurantId = await pgCreateRestaurant(overrides);
  const menuItemId = await pgCreateMenuItem(restaurantId, overrides);
  return { restaurantId, menuItemId };
}

function basicOrderPayload(restaurantId, menuItemId, overrides = {}) {
  return {
    restaurantId,
    city: 'Грозный',
    customerName: overrides.customerName || 'Тест Тестов',
    customerPhone: overrides.customerPhone || uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: overrides.fulfillmentType || 'delivery',
    items: [{ menuItemId, name: 'Item', qty: overrides.qty || 1 }],
    orderAccessToken: overrides.orderAccessToken || orderToken(),
    createIdempotencyKey: overrides.createIdempotencyKey || createKey(),
  };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

// Реальный HTTP-вызов POST /api/orders — используется ТОЛЬКО в тестах,
// которые проверяют поведение именно этого эндпоинта (их 5, см. ниже),
// чтобы не исчерпать orderCreateLimiter (10 запросов/5 минут — тот же лимит,
// что и в SQLite-оригинале, сознательно не увеличивался и не отключался для
// тестов, это реальное production-поведение).
async function createOrderViaHttp(overrides = {}) {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant(overrides);
  const payload = basicOrderPayload(restaurantId, menuItemId, overrides);
  const res = await fetch(`${mainBaseUrl}/api/orders`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': payload.createIdempotencyKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { res, body, payload, restaurantId, menuItemId };
}

// Прямой вызов orderService.createOrderAndResolve() (реальная PostgreSQL
// PG-логика, включая настоящий mock-provider network round-trip) — для ВСЕХ
// остальных тестов, которым просто нужен существующий заказ как фикстура,
// не тестирование самого POST /orders эндпоинта. Не проходит через
// orderCreateLimiter (тот привязан к HTTP-слою, не к сервису) — так тесты
// не соревнуются за общий rate-limit бюджет процесса.
async function createOrderDirect(overrides = {}) {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant(overrides);
  const payload = basicOrderPayload(restaurantId, menuItemId, overrides);
  const body = await orderService.createOrderAndResolve(payload);
  return {
    body: { order: orderService.toPublicOrderDTO(body.order), payment: orderService.toPublicPaymentDTO(body.payment) },
    payload, restaurantId, menuItemId,
  };
}

// ---------------------------------------------------------------------------
// 1. GET /api/restaurants — список ресторанов
// ---------------------------------------------------------------------------

test('GET /api/restaurants — возвращает список с cities как массив и orders_count', async () => {
  const restaurantId = await pgCreateRestaurant({ cities: ['Грозный', 'Аргун'] });
  await pgCreateMenuItem(restaurantId);
  const res = await fetch(`${mainBaseUrl}/api/restaurants`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found, 'созданный ресторан должен быть в списке');
  assert.deepEqual(found.cities, ['Грозный', 'Аргун']);
  assert.equal(typeof found.orders_count, 'number');
});

test('GET /api/restaurants?city=X — фильтрует по городу', async () => {
  const idA = await pgCreateRestaurant({ cities: ['Шали'] });
  const idB = await pgCreateRestaurant({ cities: ['Гудермес'] });
  const res = await fetch(`${mainBaseUrl}/api/restaurants?city=${encodeURIComponent('Шали')}`);
  const list = await res.json();
  const ids = list.map((r) => r.id);
  assert.ok(ids.includes(idA));
  assert.ok(!ids.includes(idB));
});

// ---------------------------------------------------------------------------
// 2. GET /api/restaurants/:id — меню ресторана
// ---------------------------------------------------------------------------

test('GET /api/restaurants/:id — возвращает меню, сгруппированное по категориям', async () => {
  const { restaurantId } = await seedMinimalRestaurant();
  const res = await fetch(`${mainBaseUrl}/api/restaurants/${restaurantId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, restaurantId);
  assert.ok(Array.isArray(body.menu));
  assert.equal(body.menu.length, 1);
  assert.equal(body.menu[0].items.length, 1);
  assert.ok('is_popular' in body.menu[0].items[0]);
});

test('GET /api/restaurants/:id — отсутствующий ресторан даёт 404', async () => {
  const res = await fetch(`${mainBaseUrl}/api/restaurants/999999999`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'ресторан не найден');
});

// ---------------------------------------------------------------------------
// 2b. Публичный контракт ресторана — internal fields must never leak
// ---------------------------------------------------------------------------
// Найдено в рамках "Critical Public API Data Exposure Audit": SELECT r.* +
// object spread отдавал connect_code (одноразовый код привязки Telegram-бота
// ресторана) и telegram_chat_id неавторизованному клиенту через оба публичных
// restaurant endpoint'а. Список ниже намеренно проверяется по КЛЮЧАМ, а не
// только по конкретному значению — так тест ловит и будущие новые внутренние
// колонки, а не только сегодняшний connect_code/telegram_chat_id.

const ALL_RESTAURANT_COLUMNS = [
  'id', 'name', 'cuisine', 'photo_url', 'cities', 'address', 'hours',
  'delivery_price', 'min_order', 'is_open', 'paused_until', 'is_new',
  'rating', 'rating_count', 'phone', 'default_cook_minutes',
  'telegram_chat_id', 'connect_code', 'created_at',
];
const PUBLIC_RESTAURANT_FIELDS = [
  'id', 'name', 'cuisine', 'photo_url', 'cities', 'address', 'hours',
  'delivery_price', 'min_order', 'is_open', 'is_new', 'rating',
  'rating_count', 'default_cook_minutes', 'orders_count',
];
const INTERNAL_RESTAURANT_FIELDS = ALL_RESTAURANT_COLUMNS.filter(
  (f) => !PUBLIC_RESTAURANT_FIELDS.includes(f),
);

test('GET /api/restaurants — не содержит внутренние поля (connect_code, telegram_chat_id, phone, paused_until, created_at)', async () => {
  const restaurantId = await pgCreateRestaurant({
    connectCode: `sec-test-${uniqueSuffix()}`,
    telegramChatId: '987654321',
  });
  const res = await fetch(`${mainBaseUrl}/api/restaurants`);
  assert.equal(res.status, 200);
  const list = await res.json();
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found, 'созданный ресторан должен быть в списке');
  for (const field of INTERNAL_RESTAURANT_FIELDS) {
    assert.ok(!(field in found), `внутреннее поле "${field}" не должно присутствовать в GET /api/restaurants`);
  }
});

test('GET /api/restaurants?city=X — фильтр по городу тоже не содержит внутренние поля', async () => {
  const restaurantId = await pgCreateRestaurant({
    cities: ['Шали'],
    connectCode: `sec-test-${uniqueSuffix()}`,
    telegramChatId: '987654321',
  });
  const res = await fetch(`${mainBaseUrl}/api/restaurants?city=${encodeURIComponent('Шали')}`);
  assert.equal(res.status, 200);
  const list = await res.json();
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found, 'ресторан должен быть виден по своему городу');
  for (const field of INTERNAL_RESTAURANT_FIELDS) {
    assert.ok(!(field in found), `внутреннее поле "${field}" не должно присутствовать в city-фильтре`);
  }
});

test('GET /api/restaurants/:id — не содержит внутренние поля', async () => {
  const restaurantId = await pgCreateRestaurant({
    connectCode: `sec-test-${uniqueSuffix()}`,
    telegramChatId: '987654321',
  });
  await pgCreateMenuItem(restaurantId);
  const res = await fetch(`${mainBaseUrl}/api/restaurants/${restaurantId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const field of INTERNAL_RESTAURANT_FIELDS) {
    assert.ok(!(field in body), `внутреннее поле "${field}" не должно присутствовать в GET /api/restaurants/:id`);
  }
});

test('GET /api/restaurants — разрешённые клиентские поля сохраняются (нет регрессии)', async () => {
  const restaurantId = await pgCreateRestaurant({ cities: ['Аргун'] });
  await pgCreateMenuItem(restaurantId);
  const res = await fetch(`${mainBaseUrl}/api/restaurants?city=${encodeURIComponent('Аргун')}`);
  const list = await res.json();
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found);
  for (const field of PUBLIC_RESTAURANT_FIELDS) {
    assert.ok(field in found, `публичное поле "${field}" должно присутствовать`);
  }
  assert.equal(found.name, 'Test Restaurant');
  assert.deepEqual(found.cities, ['Аргун']);
  assert.equal(typeof found.orders_count, 'number');
});

// ---------------------------------------------------------------------------
// 3. POST /api/orders — создание заказа
// ---------------------------------------------------------------------------

test('POST /api/orders — успешное создание, HTTP 201, JSON-контракт {order,payment,context}', async () => {
  const { res, body } = await createOrderViaHttp();
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(body).sort(), ['context', 'order', 'payment']);
  assert.equal(body.order.status, 'awaiting_payment');
  assert.ok(body.payment.qrPayload, 'mock-провайдер должен вернуть qrPayload');
  assert.equal(body.payment.paymentUrl, null);
});

test('POST /api/orders — без Authorization даёт 401', async () => {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant();
  const payload = basicOrderPayload(restaurantId, menuItemId);
  const res = await fetch(`${mainBaseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Idempotency-Key': payload.createIdempotencyKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 401);
});

test('POST /api/orders — некорректный Idempotency-Key заголовок даёт 400', async () => {
  const { restaurantId, menuItemId } = await seedMinimalRestaurant();
  const payload = basicOrderPayload(restaurantId, menuItemId);
  const res = await fetch(`${mainBaseUrl}/api/orders`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': 'garbage', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 400);
});

test('POST /api/orders — валидационная ошибка сервиса (пустая корзина) даёт 400 с текстом ошибки', async () => {
  const { restaurantId } = await seedMinimalRestaurant();
  const payload = basicOrderPayload(restaurantId, 1);
  payload.items = [];
  const res = await fetch(`${mainBaseUrl}/api/orders`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': payload.createIdempotencyKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'корзина пуста');
});

test('POST /api/orders — рollback: ошибка валидации не создаёт частичной записи заказа', async () => {
  const { restaurantId } = await seedMinimalRestaurant();
  const phone = uniquePhone();
  const payload = basicOrderPayload(restaurantId, 999999999, { customerPhone: phone });
  const res = await fetch(`${mainBaseUrl}/api/orders`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': payload.createIdempotencyKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 400);
  const rows = await db.query('SELECT count(*)::int AS n FROM orders WHERE customer_phone = $1', [phone]);
  assert.equal(rows[0].n, 0, 'невалидный запрос не должен был создать даже частичную orders-строку');
});

// ---------------------------------------------------------------------------
// 4. GET /api/orders/:code — получение заказа
// ---------------------------------------------------------------------------

const PUBLIC_ALLOWLIST = [
  'public_code', 'status', 'status_updated_at', 'items_total',
  'estimated_ready_minutes', 'restaurant_phone', 'fulfillment_type', 'rating',
  'refund_status',
];
const FORBIDDEN_FIELDS = [
  'id', 'restaurant_id', 'city', 'customer_name', 'customer_phone', 'address',
  'comment', 'commission_amount', 'created_at', 'restaurant_name', 'items',
];

test('GET /api/orders/:code — владелец получает 200 и DTO без запрещённых полей', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}`, {
    headers: auth(payload.orderAccessToken),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const field of PUBLIC_ALLOWLIST) assert.ok(field in body, `ожидали поле ${field}`);
  for (const field of FORBIDDEN_FIELDS) assert.ok(!(field in body), `поле ${field} не должно быть в публичном DTO`);
  assert.equal(body.refund_status, 'none');
});

test('GET /api/orders/:code — без токена 401, с чужим токеном 404', async () => {
  const { body: created } = await createOrderDirect();
  const noAuthRes = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}`);
  assert.equal(noAuthRes.status, 401);

  const wrongRes = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}`, { headers: auth(orderToken()) });
  assert.equal(wrongRes.status, 404);
});

test('GET /api/orders/:code — несуществующий код даёт 404', async () => {
  const res = await fetch(`${mainBaseUrl}/api/orders/YAAM-99999`, { headers: auth(orderToken()) });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// 5. POST /api/orders/recover — восстановление заказа
// ---------------------------------------------------------------------------

test('POST /api/orders/recover — теми же секретами возвращает тот же заказ', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/recover`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': payload.createIdempotencyKey },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.public_code, created.order.public_code);
  assert.equal(body.payment.qrPayload, created.payment.qrPayload);
});

test('POST /api/orders/recover — незнакомые секреты дают 404', async () => {
  const res = await fetch(`${mainBaseUrl}/api/orders/recover`, {
    method: 'POST',
    headers: { ...auth(orderToken()), 'Idempotency-Key': createKey() },
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'заказ не найден');
});

// ---------------------------------------------------------------------------
// 7. POST /api/orders/:code/cancel — отмена
// ---------------------------------------------------------------------------

test('POST /api/orders/:code/cancel — awaiting_payment заказ успешно отменяется', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/cancel`, {
    method: 'POST',
    headers: auth(payload.orderAccessToken),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'cancelled');
});

test('POST /api/orders/:code/cancel — заказ в неверном статусе даёт 400', async () => {
  const { body: created, payload } = await createOrderDirect();
  await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/cancel`, { method: 'POST', headers: auth(payload.orderAccessToken) });
  const second = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/cancel`, { method: 'POST', headers: auth(payload.orderAccessToken) });
  assert.equal(second.status, 400);
});

// ---------------------------------------------------------------------------
// 6/9. pending payment + retry-payment
// ---------------------------------------------------------------------------

test('POST /api/orders/:code/retry-payment — после payment_failed успешно создаёт новую попытку', async () => {
  const { body: created, payload, restaurantId } = await createOrderDirect();
  const orderRow = (await db.query('SELECT id FROM orders WHERE public_code=$1', [created.order.public_code]))[0];
  const paymentRow = (await db.query(`SELECT * FROM payments WHERE order_id=$1 AND status='pending'`, [orderRow.id]))[0];
  await orderService.markPaymentFailed(orderRow.id, paymentRow.id);

  const rk = retryKeyGen();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/retry-payment`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': rk },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.payment.qrPayload);

  const afterRes = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}`, { headers: auth(payload.orderAccessToken) });
  const afterBody = await afterRes.json();
  assert.equal(afterBody.status, 'awaiting_payment');
});

test('POST /api/orders/:code/retry-payment — некорректный retry-ключ даёт 400', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/retry-payment`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': 'garbage' },
  });
  assert.equal(res.status, 400);
});

test('POST /api/orders/:code/retry-payment — заказ не в payment_failed даёт конфликт', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/retry-payment`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': retryKeyGen() },
  });
  assert.equal(res.status, 409);
});

// ---------------------------------------------------------------------------
// 8. POST /api/orders/:code/rate — рейтинг
// ---------------------------------------------------------------------------

test('POST /api/orders/:code/rate — заказ не в статусе delivered даёт ошибку', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/rate`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 5 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'оценить можно только доставленный заказ');
});

test('POST /api/orders/:code/rate — успешная оценка доставленного заказа', async () => {
  const { body: created, payload } = await createOrderDirect();
  const orderRow = (await db.query('SELECT id FROM orders WHERE public_code=$1', [created.order.public_code]))[0];
  await db.execute(`UPDATE orders SET status='delivered' WHERE id=$1`, [orderRow.id]);
  await db.execute(`UPDATE payments SET status='succeeded' WHERE order_id=$1`, [orderRow.id]);

  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}/rate`, {
    method: 'POST',
    headers: { ...auth(payload.orderAccessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 5 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rating, 5);
});

// ---------------------------------------------------------------------------
// Webhook — регистрация маршрута зависит от PAYMENT_PROVIDER (module-load-time gate)
// ---------------------------------------------------------------------------

test('POST /api/webhooks/payment — не зарегистрирован при PAYMENT_PROVIDER=mock (текущее приложение)', async () => {
  const res = await fetch(`${mainBaseUrl}/api/webhooks/payment`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404, 'маршрут не должен существовать при mock-провайдере — тот же гейт, что в SQLite-оригинале');
});

// ---------------------------------------------------------------------------
// dev-confirm-payment — отдельное приложение с ENABLE_DEV_PAYMENT_ROUTES=true
// (module-load-time gate, требует свежего require() модуля роутов)
// ---------------------------------------------------------------------------

test('POST /api/orders/:code/dev-confirm-payment — pending payment подтверждается, заказ переходит в awaiting_restaurant', async () => {
  const previousEnable = process.env.ENABLE_DEV_PAYMENT_ROUTES;
  const previousAppEnv = process.env.APP_ENV;
  process.env.ENABLE_DEV_PAYMENT_ROUTES = 'true';
  process.env.APP_ENV = 'staging';
  delete require.cache[ROUTES_MODULE_PATH];
  const express = require('express');
  const devRoutes = require('../../routes/postgresql/api.js');
  const devApp = express();
  devApp.use(express.json());
  devApp.use('/api', devRoutes);
  const devServer = devApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => devServer.once('listening', resolve));
  const devBaseUrl = `http://127.0.0.1:${devServer.address().port}`;

  try {
    const { restaurantId, menuItemId } = await seedMinimalRestaurant();
    const payload = basicOrderPayload(restaurantId, menuItemId);
    const createRes = await fetch(`${devBaseUrl}/api/orders`, {
      method: 'POST',
      headers: { ...auth(payload.orderAccessToken), 'Idempotency-Key': payload.createIdempotencyKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const created = await createRes.json();
    assert.equal(created.order.status, 'awaiting_payment', 'исходное состояние — pending payment');

    const noTokenRes = await fetch(`${devBaseUrl}/api/orders/${created.order.public_code}/dev-confirm-payment`, { method: 'POST' });
    assert.equal(noTokenRes.status, 401);

    const wrongTokenRes = await fetch(`${devBaseUrl}/api/orders/${created.order.public_code}/dev-confirm-payment`, {
      method: 'POST', headers: auth(orderToken()),
    });
    assert.equal(wrongTokenRes.status, 404);

    const confirmRes = await fetch(`${devBaseUrl}/api/orders/${created.order.public_code}/dev-confirm-payment`, {
      method: 'POST', headers: auth(payload.orderAccessToken),
    });
    assert.equal(confirmRes.status, 200);
    const confirmBody = await confirmRes.json();
    assert.equal(confirmBody.status, 'awaiting_restaurant');
  } finally {
    await new Promise((resolve) => devServer.close(resolve));
    if (previousEnable === undefined) delete process.env.ENABLE_DEV_PAYMENT_ROUTES; else process.env.ENABLE_DEV_PAYMENT_ROUTES = previousEnable;
    if (previousAppEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previousAppEnv;
    delete require.cache[ROUTES_MODULE_PATH];
  }
});

// ---------------------------------------------------------------------------
// DTO compatibility — структурное сравнение с SQLite-версией того же ответа
// ---------------------------------------------------------------------------

test('DTO compatibility: набор полей GET /orders/:code идентичен SQLite-версии', async () => {
  const { body: created, payload } = await createOrderDirect();
  const res = await fetch(`${mainBaseUrl}/api/orders/${created.order.public_code}`, { headers: auth(payload.orderAccessToken) });
  const pgBody = await res.json();

  const sqliteDbPath = path.join(require('node:os').tmpdir(), `yaam-stage1-dto-${uniqueSuffix()}.db`);
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = sqliteDbPath;
  delete require.cache[require.resolve('../../db')];
  delete require.cache[require.resolve('../../services/orderService')];
  // eslint-disable-next-line global-require
  const sqliteDb = require('../../db');
  // eslint-disable-next-line global-require
  const sqliteOrderService = require('../../services/orderService');
  try {
    const info = sqliteDb.prepare(`
      INSERT INTO restaurants (name, cuisine, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes, is_open, rating, rating_count)
      VALUES ('T','t','[]','','','+79280000000',0,0,20,1,4.5,10)
    `).run();
    const restaurantId = info.lastInsertRowid;
    const catId = sqliteDb.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?, ?, 0)').run(restaurantId, 'Cat').lastInsertRowid;
    const itemId = sqliteDb.prepare(`
      INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, weight_g, kcal, protein_g, fat_g, carbs_g, composition, is_popular, sort_order)
      VALUES (?, ?, 'Item', '', 500, '', 0,0,0,0,0, '', 0, 0)
    `).run(restaurantId, catId).lastInsertRowid;
    const sqlitePayload = basicOrderPayload(restaurantId, itemId);
    const { order: sqliteOrder } = await sqliteOrderService.createOrder(sqlitePayload);
    const sqliteBody = sqliteOrderService.toPublicOrderDTO(sqliteOrder);

    assert.deepEqual(Object.keys(pgBody).sort(), Object.keys(sqliteBody).sort(), 'PostgreSQL и SQLite версии GET /orders/:code обязаны отдавать один и тот же набор полей');
  } finally {
    for (const suffix of ['', '-shm', '-wal']) { try { fs.unlinkSync(sqliteDbPath + suffix); } catch { /* нет файла */ } }
    if (previousDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousDbPath;
  }
});

// ---------------------------------------------------------------------------
// Убедиться, что SQLite не используется routes/postgresql/api.js
// ---------------------------------------------------------------------------

test('routes/postgresql/api.js не содержит require SQLite-слоя и db.prepare()', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../routes/postgresql/api.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\.\/\.\.\/db['"]\)/, 'не должно быть require SQLite db-слоя');
  assert.doesNotMatch(source, /require\(['"]\.\.\/\.\.\/services\/orderService['"]\)/, 'не должно быть require SQLite orderService');
  assert.doesNotMatch(source, /require\(['"]\.\.\/\.\.\/services\/orderAccessService['"]\)/, 'не должно быть require SQLite orderAccessService');
  assert.doesNotMatch(source, /\bdb\.prepare\(/, 'не должно быть db.prepare() (SQLite API)');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('пул PostgreSQL возвращён, waitingCount=0', async () => {
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
});
