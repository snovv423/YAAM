'use strict';

// PRE-YOOKASSA PUBLIC CLEANUP — серверная половина трёх находок аудита.
//
// 1. Гейт платёжного провайдера отдавал голый 503 без машиночитаемого кода.
//    HTTP-статуса недостаточно: 503 бывает и от промежуточного слоя уже ПОСЛЕ
//    того, как запрос дошёл до приложения (тогда судьба заказа неизвестна), и
//    от этого гейта, который стоит ДО любой записи orderService (тогда заказа
//    заведомо нет). Клиент не мог их различить и на production вставал в
//    неразрешимый цикл восстановления — см. client/test/orderingUnavailableRecovery.test.js.
//
// 2. Адрес доставки не проверялся на сервере вовсе. Раньше пустым он прийти не
//    мог (в форме стояла автоподстановка выдуманного адреса), но после её
//    удаления это достижимое состояние, а прямой вызов API её и так не проходил.
//
// 3. Самовывоз принимался у ресторана без адреса — клиент платил за получение
//    неизвестно где. Клиент такой вариант больше не показывает, но правило
//    обязано жить и на сервере: вызов API в обход браузера минует любую форму.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_pre_yookassa_cleanup_test';
const ROUTES_MODULE_PATH = require.resolve('../../routes/postgresql/api.js');
const PAYMENT_SERVICE_PATH = require.resolve('../../services/paymentService.js');

let cluster;
let db;
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
  cluster = await startEmbeddedPostgres('pre-yookassa-cleanup');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');

  const express = require('express');
  const apiRoutes = require('../../routes/postgresql/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  mainServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => mainServer.once('listening', resolve));
  mainBaseUrl = `http://127.0.0.1:${mainServer.address().port}`;
});

function orderToken() { return `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`; }
function createKey() { return `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`; }
function uniquePhone() {
  return `+79${String(crypto.randomInt(100000000, 999999999)).padStart(8, '0')}`;
}

async function seedRestaurant({ address = '' } = {}) {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, address, is_open, min_order, phone, connect_code, published_at)
     VALUES ('Test Restaurant', 'test', $1, $2, 1, 0, '+79280000099', $3, $4) RETURNING id`,
    [JSON.stringify(['Грозный']), address, crypto.randomBytes(4).toString('hex'), new Date()],
  );
  const restaurantId = rows[0].id;
  const catRows = await db.query(
    `INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`, [restaurantId],
  );
  const itemRows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available)
     VALUES ($1, $2, 'Item', 500, 1) RETURNING id`,
    [restaurantId, catRows[0].id],
  );
  return { restaurantId, menuItemId: itemRows[0].id };
}

function orderPayload(restaurantId, menuItemId, overrides = {}) {
  return {
    restaurantId,
    city: 'Грозный',
    customerName: 'Тест Тестов',
    customerPhone: uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', qty: 1 }],
    ...overrides,
  };
}

async function postOrder(baseUrl, payload, { token = orderToken(), key = createKey() } = {}) {
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...payload, orderAccessToken: token, createIdempotencyKey: key }),
  });
  return { res, body: await res.json().catch(() => ({})), token, key };
}

// ---------------------------------------------------------------------------
// 1. Машиночитаемый код отказа платёжного гейта
// ---------------------------------------------------------------------------

// Гейт читает paymentService.providerName, который вычисляется при загрузке
// модуля — поэтому нужен свежий require() и роутов, и самого paymentService.
async function withDisabledProviderApp(run) {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = 'disabled';
  delete require.cache[PAYMENT_SERVICE_PATH];
  delete require.cache[ROUTES_MODULE_PATH];
  const express = require('express');
  const routes = require('../../routes/postgresql/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
    delete require.cache[PAYMENT_SERVICE_PATH];
    delete require.cache[ROUTES_MODULE_PATH];
  }
}

test('1.1 POST /api/orders при disabled-провайдере отдаёт 503 с кодом ORDERING_UNAVAILABLE', async () => {
  await withDisabledProviderApp(async (baseUrl) => {
    const { restaurantId, menuItemId } = await seedRestaurant();
    const { res, body } = await postOrder(baseUrl, orderPayload(restaurantId, menuItemId));
    assert.equal(res.status, 503);
    assert.equal(body.code, 'ORDERING_UNAVAILABLE',
      'без кода клиент не отличает этот отказ от 503 промежуточного слоя');
    assert.equal(body.error, 'Оформление заказов временно недоступно');
  });
});

test('1.2 POST /api/orders/recover при disabled-провайдере отдаёт тот же код', async () => {
  await withDisabledProviderApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/orders/recover`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${orderToken()}`,
        'Idempotency-Key': createKey(),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ORDERING_UNAVAILABLE');
  });
});

test('1.3 гейт срабатывает ДО любой записи: заказ в БД не появляется', async () => {
  await withDisabledProviderApp(async (baseUrl) => {
    const { restaurantId, menuItemId } = await seedRestaurant();
    const before = (await db.query('SELECT COUNT(*)::int AS n FROM orders'))[0].n;
    await postOrder(baseUrl, orderPayload(restaurantId, menuItemId));
    const after = (await db.query('SELECT COUNT(*)::int AS n FROM orders'))[0].n;
    assert.equal(after, before, 'именно это и делает отказ однозначным для клиента');
  });
});

test('1.4 гейт не трогает чтение каталога — витрина остаётся доступной', async () => {
  await withDisabledProviderApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/restaurants`);
    assert.equal(res.status, 200);
  });
});

test('1.5 при работающем провайдере кода отказа нет и заказ создаётся', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant();
  const { res, body } = await postOrder(mainBaseUrl, orderPayload(restaurantId, menuItemId));
  assert.equal(res.status, 201);
  assert.equal(body.order.status, 'awaiting_payment');
  assert.equal(body.code, undefined);
});

// ---------------------------------------------------------------------------
// 2. Адрес доставки обязателен
// ---------------------------------------------------------------------------

test('2.1 доставка без адреса отклоняется', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant();
  const { res, body } = await postOrder(mainBaseUrl,
    orderPayload(restaurantId, menuItemId, { address: '' }));
  assert.equal(res.status, 400);
  assert.match(body.error, /адрес доставки/i);
});

test('2.2 адрес из одних пробелов не считается адресом', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant();
  const { res } = await postOrder(mainBaseUrl,
    orderPayload(restaurantId, menuItemId, { address: '    ' }));
  assert.equal(res.status, 400);
});

test('2.3 отказ по адресу не создаёт заказ', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant();
  const before = (await db.query('SELECT COUNT(*)::int AS n FROM orders'))[0].n;
  await postOrder(mainBaseUrl, orderPayload(restaurantId, menuItemId, { address: '' }));
  const after = (await db.query('SELECT COUNT(*)::int AS n FROM orders'))[0].n;
  assert.equal(after, before);
});

// ---------------------------------------------------------------------------
// 3. Самовывоз только у ресторана с адресом
// ---------------------------------------------------------------------------

test('3.1 самовывоз у ресторана без адреса отклоняется', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant({ address: '' });
  const { res, body } = await postOrder(mainBaseUrl,
    orderPayload(restaurantId, menuItemId, { fulfillmentType: 'pickup', address: '' }));
  assert.equal(res.status, 400);
  assert.match(body.error, /самовывоз недоступен/i);
});

test('3.2 самовывоз у ресторана с адресом проходит и адрес клиента не требуется', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant({ address: 'г. Аргун, ул. Ресторанная, 1' });
  const { res, body } = await postOrder(mainBaseUrl,
    orderPayload(restaurantId, menuItemId, { fulfillmentType: 'pickup', address: '' }));
  assert.equal(res.status, 201);
  assert.equal(body.order.status, 'awaiting_payment');
});

test('3.3 адрес ресторана из одних пробелов самовывоз не открывает', async () => {
  const { restaurantId, menuItemId } = await seedRestaurant({ address: '   ' });
  const { res } = await postOrder(mainBaseUrl,
    orderPayload(restaurantId, menuItemId, { fulfillmentType: 'pickup', address: '' }));
  assert.equal(res.status, 400);
});
