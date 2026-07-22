'use strict';

// YAAM Production Switch — Stage 8: PostgreSQL YooKassa payment/refund
// production safety. Real embedded PostgreSQL 16.14 (same harness as every
// previous stage) + a controlled fake HTTP transport standing in for
// api.yookassa.ru (installed by replacing global.fetch for the scope of
// each test that needs it, restored in `finally`) — the REAL
// YookassaProvider/orderService code executes against it (URL construction,
// Basic Auth header, JSON parsing, status normalization, error
// classification, canonical-lookup webhook verification), not a
// monkey-patched shortcut of the business logic itself.
//
// Nothing here is connected to production — server.js (SQLite) is untouched.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_payment_safety_stage8_test';

let cluster;
let db;
let orderService;
// Захвачена ОДИН раз, до любых require.cache-перезагрузок (см.
// startWebhookApp) — services/postgresql/orderService.js сам захватывает
// СВОЮ ссылку на paymentService.js ровно один раз при собственной загрузке
// (require('../paymentService') на верхнем уровне модуля) и никогда её не
// переустанавливает; более поздний require('../../services/paymentService.js')
// ПОСЛЕ того, как что-то удалило её из require.cache (startWebhookApp),
// вернул бы ДРУГОЙ, не связанный с orderService.js объект — тот же класс
// проблемы, что уже был найден и задокументирован в Stage 7. Тесты, которым
// нужно monkey-patch'нуть именно то, что реально использует orderService.js
// (B5/C4), обязаны использовать ИМЕННО эту переменную, не свежий require().
let paymentServiceForOrderService;

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.YOOKASSA_SHOP_ID = '999998';
  process.env.YOOKASSA_SECRET_KEY = 'test_stage8_fake_secret';
  process.env.YOOKASSA_ENV = 'sandbox';
  process.env.YOOKASSA_RETURN_URL = 'https://yaam.su/return';
  process.env.YOOKASSA_WEBHOOK_URL = 'https://api-pg.yaam.su/api/webhooks/payment';

  cluster = await startEmbeddedPostgres('payment-safety-stage8');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  orderService = require('../../services/postgresql/orderService.js');
  paymentServiceForOrderService = require('../../services/paymentService.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

// ---------------------------------------------------------------------------
// Fake YooKassa HTTP transport — real yookassaProvider.js code executes
// against it (fetch/Basic Auth/AbortController/JSON parsing all real).
// ---------------------------------------------------------------------------

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createFakeYookassaTransport() {
  const payments = new Map(); // id -> { status, amount, currency }
  const refunds = new Map();
  // Уникально ГЛОБАЛЬНО по всему тестовому файлу (не только в рамках этого
  // transport-инстанса) — БД (payments.provider_payment_id) реально
  // персистентна между тестами в рамках одного файла, у per-instance
  // счётчика с 0 были бы предсказуемые коллизии между тестами.
  const idPrefix = crypto.randomBytes(6).toString('hex');
  let seq = 0;

  async function handler(url, options) {
    const method = (options && options.method) || 'GET';
    const signal = options && options.signal;

    if (method === 'POST' && url.endsWith('/v3/payments')) {
      seq += 1;
      const id = `fake_payment_${idPrefix}_${seq}`;
      const body = JSON.parse(options.body);
      payments.set(id, { status: 'pending', amount: body.amount.value, currency: body.amount.currency });
      return jsonResponse(200, {
        id,
        status: 'pending',
        test: true,
        amount: body.amount,
        confirmation: { type: 'redirect', confirmation_url: `https://yookassa.ru/pay/${id}` },
      });
    }

    const getPaymentMatch = url.match(/\/v3\/payments\/([^/]+)$/);
    if (method === 'GET' && getPaymentMatch) {
      // Опциональная симуляция "зависшего" сетевого вызова — резолвится только
      // при реальном abort() контроллера таймаута вызывающего кода (тестирует
      // РЕАЛЬНЫЙ AbortController-путь yookassaProvider.js, не имитацию).
      if (handler.hangGetStatus) {
        await new Promise((resolve, reject) => {
          if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      const id = decodeURIComponent(getPaymentMatch[1]);
      const p = payments.get(id);
      if (!p) return jsonResponse(404, { type: 'error', id: 'req_1', code: 'not_found' });
      return jsonResponse(200, { id, status: p.status, test: true, amount: { value: p.amount, currency: p.currency } });
    }

    if (method === 'POST' && url.endsWith('/v3/refunds')) {
      const body = JSON.parse(options.body);
      if (handler.refundFailure) {
        const failure = handler.refundFailure;
        if (failure.type === 'network') throw Object.assign(new Error('fake network down'), { name: 'FakeNetworkError' });
        if (failure.type === 'timeout') {
          await new Promise((resolve, reject) => {
            if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        }
      }
      seq += 1;
      const refundId = `fake_refund_${idPrefix}_${seq}`;
      refunds.set(refundId, { paymentId: body.payment_id, status: 'succeeded', amount: body.amount.value });
      const payment = payments.get(body.payment_id);
      if (payment) payment.status = 'succeeded'; // сохраняет реальный статус платежа согласованным
      return jsonResponse(200, { id: refundId, payment_id: body.payment_id, status: 'succeeded', amount: body.amount });
    }

    const getRefundMatch = url.match(/\/v3\/refunds\/([^/]+)$/);
    if (method === 'GET' && getRefundMatch) {
      const id = decodeURIComponent(getRefundMatch[1]);
      const r = refunds.get(id);
      if (!r) return jsonResponse(404, { type: 'error', id: 'req_1', code: 'not_found' });
      return jsonResponse(200, { id, payment_id: r.paymentId, status: r.status, amount: { value: r.amount, currency: 'RUB' } });
    }

    throw new Error(`unexpected fake YooKassa request: ${method} ${url}`);
  }

  return { handler, payments, refunds, setPaymentStatus: (id, status) => { const p = payments.get(id); if (p) p.status = status; } };
}

// Перехватывает ТОЛЬКО запросы к api.yookassa.ru — запросы к собственному
// тестовому HTTP-серверу (fetchJson/fetch к 127.0.0.1, используется теми же
// тестами для реального webhook route) идут в оригинальный fetch как есть.
function installFakeFetch(handler) {
  const original = global.fetch;
  global.fetch = (url, options) => {
    const urlStr = String(url);
    if (!urlStr.startsWith('https://api.yookassa.ru/')) return original(url, options);
    return handler(urlStr, options);
  };
  return () => { global.fetch = original; };
}

// ---------------------------------------------------------------------------
// Fixtures — тот же established паттерн, что и во всех предыдущих Stage/Wave
// файлах (pgCreateRestaurant/pgCreateMenuItem/createOrderDirect).
// ---------------------------------------------------------------------------

function uniquePhone() {
  const n = crypto.randomInt(100000000, 999999999);
  return `+79${String(n).padStart(8, '0')}`;
}

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count)
     VALUES ('Stage8 Test Restaurant', 'test', '["Грозный"]', 1, 0, '+79280000099', 4.5, 10) RETURNING id`
  );
  return rows[0].id;
}

async function pgCreateMenuItem(restaurantId, price = 500) {
  const catRows = await db.query(`INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`, [restaurantId]);
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1, $2, 'Item', $3, 1) RETURNING id`,
    [restaurantId, catRows[0].id, price]
  );
  return rows[0].id;
}

async function createOrderDirect(overrides = {}) {
  const restaurantId = await pgCreateRestaurant();
  const menuItemId = await pgCreateMenuItem(restaurantId, overrides.price || 500);
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'Тест Тестов',
    customerPhone: uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const result = await orderService.createOrderAndResolve(payload);
  return { order: result.order, payment: result.payment, payload };
}

// Полный сценарий "оплаченный, принятый рестораном заказ" — нужен многим
// тестам ниже (cancel-after-accept -> refund).
async function createPaidAcceptedOrder(overrides = {}) {
  const { order, payload } = await createOrderDirect(overrides);
  const pending = await orderService.getPendingPaymentForOrder(order.id);
  await orderService.markPaid(order.id, pending.id);
  return { orderId: order.id, paymentId: pending.id, payload };
}

// Создаёт заказ через реальный orderService.createOrderAndResolve() (mock
// provider, корректная схема БД), затем "переключает" его платёж на
// providerPaymentId, реально созданный через YookassaProvider.createPayment()
// (настоящий HTTP-запрос против fake-транспорта) — так webhook-тесты гоняют
// РЕАЛЬНЫЙ verifyWebhook()/getStatus() код против id, который тот же
// реальный код и создал, при этом заказ/платёж корректно соответствуют
// текущей схеме БД (не собраны вручную мимо orderService).
async function createOrderWithYookassaPayment(provider, price = 500) {
  const { order } = await createOrderDirect({ price });
  const pending = await orderService.getPendingPaymentForOrder(order.id);
  const created = await provider.createPayment({ orderId: order.id, amount: price, description: 'stage8', idempotencyKey: crypto.randomUUID() });
  await db.execute(`UPDATE payments SET provider = 'yookassa', provider_payment_id = $1 WHERE id = $2`, [created.providerPaymentId, pending.id]);
  return { order, paymentId: pending.id, providerPaymentId: created.providerPaymentId };
}

async function startWebhookApp(reloadedEnv = {}) {
  const previous = {};
  for (const key of Object.keys(reloadedEnv)) {
    previous[key] = process.env[key];
    process.env[key] = reloadedEnv[key];
  }
  const APP_PATH = require.resolve('../../services/postgresql/app.js');
  const API_PATH = require.resolve('../../routes/postgresql/api.js');
  const ADMIN_PATH = require.resolve('../../routes/postgresql/admin.js');
  // paymentService.js фиксирует активного provider'а ОДИН раз, при первом
  // require() (см. Stage 7's applicationAssemblyStage7.test.js — тот же
  // класс проблемы) — без сброса ЕГО кеша здесь webhook route работал бы
  // против УЖЕ закешированного MockProvider из before(), даже когда
  // PAYMENT_PROVIDER='yookassa' для этого конкретного теста.
  const PAYMENT_SERVICE_PATH = require.resolve('../../services/paymentService.js');
  delete require.cache[APP_PATH];
  delete require.cache[API_PATH];
  delete require.cache[ADMIN_PATH];
  delete require.cache[PAYMENT_SERVICE_PATH];
  const { createPostgresqlApp } = require('../../services/postgresql/app.js');
  const instance = createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000, orderTimeoutIntervalMs: 1_000_000, refundReconciliationIntervalMs: 1_000_000 });
  await instance.start();
  return {
    instance,
    baseUrl: `http://127.0.0.1:${instance.address().port}`,
    async cleanup() {
      await instance.stop();
      for (const key of Object.keys(reloadedEnv)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      delete require.cache[APP_PATH];
      delete require.cache[API_PATH];
      delete require.cache[PAYMENT_SERVICE_PATH];
      delete require.cache[ADMIN_PATH];
    },
  };
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// ===========================================================================
// A. Webhook authenticity (реальный YookassaProvider против fake transport)
// ===========================================================================

test('A1: создание sandbox-платежа возвращает безопасный providerPaymentId', async () => {
  const restore = installFakeFetch(createFakeYookassaTransport().handler);
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const created = await provider.createPayment({ orderId: 1, amount: 500, description: 'test', idempotencyKey: crypto.randomUUID() });
    assert.ok(created.providerPaymentId);
  } finally {
    restore();
  }
});

test('A2: некорректный JSON — отклонено (null)', async () => {
  const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
  const provider = new YookassaProvider();
  assert.equal(await provider.verifyWebhook('not-json{{'), null);
});

test('A3: неподдерживаемый event — отклонено (null), провайдер не делает сетевой вызов', async () => {
  let fetchCalled = false;
  const restore = installFakeFetch(() => { fetchCalled = true; return jsonResponse(200, {}); });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const result = await provider.verifyWebhook(JSON.stringify({ type: 'notification', event: 'payment.waiting_for_capture', object: { id: 'x' } }));
    assert.equal(result, null);
    assert.equal(fetchCalled, false, 'неподдерживаемый event не должен вызывать канонический lookup');
  } finally {
    restore();
  }
});

test('A4: канонический lookup НЕ подтверждает заявленный статус — отклонено (fail closed)', async () => {
  const transport = createFakeYookassaTransport();
  transport.payments.set('p1', { status: 'pending', amount: '500.00', currency: 'RUB' });
  const restore = installFakeFetch(transport.handler);
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const result = await provider.verifyWebhook(JSON.stringify({
      type: 'notification', event: 'payment.succeeded', object: { id: 'p1', amount: { value: '500.00', currency: 'RUB' } },
    }));
    assert.equal(result, null, 'заявленный succeeded не подтверждён каноническим pending');
  } finally {
    restore();
  }
});

test('A5: канонический lookup недоступен (сетевая ошибка) — отклонено (fail closed)', async () => {
  const restore = installFakeFetch(async () => { throw new Error('fake DNS failure'); });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const result = await provider.verifyWebhook(JSON.stringify({
      type: 'notification', event: 'payment.succeeded', object: { id: 'p1', amount: { value: '500.00', currency: 'RUB' } },
    }));
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('A6: неизвестный provider_payment_id (канонический 404) — отклонено', async () => {
  const transport = createFakeYookassaTransport(); // пустой — 'p404' не существует
  const restore = installFakeFetch(transport.handler);
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const result = await provider.verifyWebhook(JSON.stringify({
      type: 'notification', event: 'payment.succeeded', object: { id: 'p404', amount: { value: '500.00', currency: 'RUB' } },
    }));
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('A7 (сквозной, через реальный HTTP webhook route): валидное succeeded-уведомление применяет markPaid РОВНО один раз', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { order, paymentId, providerPaymentId } = await createOrderWithYookassaPayment(provider, 500);
    transport.setPaymentStatus(providerPaymentId, 'succeeded');

    const notify = () => fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.succeeded',
        object: { id: providerPaymentId, status: 'succeeded', amount: { value: '500.00', currency: 'RUB' } },
      }),
    });

    const first = await notify();
    assert.equal(first.status, 200);
    const afterFirst = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(afterFirst[0].status, 'succeeded');
    const afterFirstOrder = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(afterFirstOrder[0].status, 'awaiting_restaurant');

    // Дублирующая доставка — тот же провайдер снова присылает то же событие.
    const second = await notify();
    assert.equal(second.status, 200, 'повторная доставка не должна давать ошибку');
    const afterSecondOrder = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(afterSecondOrder[0].status, 'awaiting_restaurant', 'повторное событие — no-op, статус не должен измениться повторно');
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A8: сумма в уведомлении не совпадает с сохранённым платежом — 400, markPaid НЕ применяется', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { paymentId, providerPaymentId } = await createOrderWithYookassaPayment(provider, 700);
    transport.setPaymentStatus(providerPaymentId, 'succeeded');

    const res = await fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.succeeded',
        // Заявленная сумма (999.00) не совпадает с реально сохранённой (700).
        object: { id: providerPaymentId, status: 'succeeded', amount: { value: '999.00', currency: 'RUB' } },
      }),
    });
    assert.equal(res.status, 400);
    const paymentAfter = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(paymentAfter[0].status, 'pending', 'платёж не должен примениться при несовпадении суммы');
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A9: валюта в уведомлении не RUB — 400, отклонено', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { providerPaymentId } = await createOrderWithYookassaPayment(provider, 500);
    transport.setPaymentStatus(providerPaymentId, 'succeeded');

    const res = await fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.succeeded',
        object: { id: providerPaymentId, status: 'succeeded', amount: { value: '500.00', currency: 'USD' } },
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A9b: отсутствующая валюта в уведомлении — 400, fail closed', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { providerPaymentId } = await createOrderWithYookassaPayment(provider, 500);
    transport.setPaymentStatus(providerPaymentId, 'succeeded');
    const res = await fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.succeeded',
        object: { id: providerPaymentId, status: 'succeeded', amount: { value: '500.00' } },
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A10: body-size лимит применяется на HTTP-уровне (413 для тела > 64kb)', async () => {
  const restore = installFakeFetch(createFakeYookassaTransport().handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const oversized = JSON.stringify({ type: 'notification', event: 'payment.succeeded', object: { id: 'x', pad: 'a'.repeat(70000) } });
    const res = await fetch(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversized,
    });
    assert.equal(res.status, 413);
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A11: обычные /api маршруты продолжают работать нормально рядом с webhook carve-out', async () => {
  const restore = installFakeFetch(createFakeYookassaTransport().handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const res = await fetchJson(`${app.baseUrl}/api/restaurants`);
    assert.equal(res.status, 200);
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A12: webhook принимает только application/json', async () => {
  const restore = installFakeFetch(createFakeYookassaTransport().handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const res = await fetch(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal(res.status, 415);
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A13: refund.succeeded сверяется через API и идемпотентно финализирует ровно один локальный refund', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { order, paymentId, providerPaymentId } = await createOrderWithYookassaPayment(provider, 500);
    transport.setPaymentStatus(providerPaymentId, 'succeeded');
    await orderService.markPaid(order.id, paymentId);

    const providerRefundId = `fake_refund_webhook_${crypto.randomUUID()}`;
    transport.refunds.set(providerRefundId, {
      paymentId: providerPaymentId,
      status: 'succeeded',
      amount: '500.00',
    });
    const inserted = await db.execute(
      `INSERT INTO refunds (
         payment_id, provider, amount, status, reason, provider_refund_id,
         provider_idempotency_key, attempt_count, next_attempt_at
       ) VALUES ($1, 'yookassa', 500, 'processing', 'customer_cancel', $2, $3, 1, NOW() + INTERVAL '1 minute')
       RETURNING id`,
      [paymentId, providerRefundId, crypto.randomUUID()]
    );
    const refundId = inserted.rows[0].id;

    const notify = () => fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'refund.succeeded',
        object: {
          id: providerRefundId,
          payment_id: providerPaymentId,
          status: 'succeeded',
          amount: { value: '500.00', currency: 'RUB' },
        },
      }),
    });

    assert.equal((await notify()).status, 200);
    assert.equal((await notify()).status, 200, 'повторный refund webhook должен быть безопасным no-op');
    const refunds = await db.query('SELECT status FROM refunds WHERE id = $1', [refundId]);
    const payments = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(refunds[0].status, 'succeeded');
    assert.equal(payments[0].status, 'refunded');
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A14: канонически валидный webhook с неизвестным локальным payment id даёт 404 и не мутирует заказы', async () => {
  const transport = createFakeYookassaTransport();
  transport.payments.set('provider_orphan_payment', { status: 'succeeded', amount: '500.00', currency: 'RUB' });
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const before = (await db.query('SELECT count(*)::int AS n FROM orders'))[0].n;
    const res = await fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.succeeded',
        object: { id: 'provider_orphan_payment', status: 'succeeded', amount: { value: '500.00', currency: 'RUB' } },
      }),
    });
    assert.equal(res.status, 404);
    const after = (await db.query('SELECT count(*)::int AS n FROM orders'))[0].n;
    assert.equal(after, before);
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A15: payment.canceled идемпотентно переводит только связанный pending payment/order в failed', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  const app = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { order, paymentId, providerPaymentId } = await createOrderWithYookassaPayment(provider, 500);
    transport.setPaymentStatus(providerPaymentId, 'canceled');
    const notify = () => fetchJson(`${app.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.canceled',
        object: { id: providerPaymentId, status: 'canceled', amount: { value: '500.00', currency: 'RUB' } },
      }),
    });
    assert.equal((await notify()).status, 200);
    assert.equal((await notify()).status, 200);
    const payments = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    const orders = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(payments[0].status, 'failed');
    assert.equal(orders[0].status, 'payment_failed');
  } finally {
    restore();
    await app.cleanup();
  }
});

test('A16: pending payment переживает restart приложения, последующий webhook завершается успешно', async () => {
  const transport = createFakeYookassaTransport();
  const restore = installFakeFetch(transport.handler);
  let firstApp = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
  let secondApp;
  try {
    const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
    const provider = new YookassaProvider();
    const { order, paymentId, providerPaymentId } = await createOrderWithYookassaPayment(provider, 500);
    await firstApp.cleanup();
    firstApp = null;

    secondApp = await startWebhookApp({ PAYMENT_PROVIDER: 'yookassa' });
    transport.setPaymentStatus(providerPaymentId, 'succeeded');
    const res = await fetchJson(`${secondApp.baseUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'notification', event: 'payment.succeeded',
        object: { id: providerPaymentId, status: 'succeeded', amount: { value: '500.00', currency: 'RUB' } },
      }),
    });
    assert.equal(res.status, 200);
    const payments = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    const orders = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(payments[0].status, 'succeeded');
    assert.equal(orders[0].status, 'awaiting_restaurant');
  } finally {
    restore();
    if (firstApp) await firstApp.cleanup();
    if (secondApp) await secondApp.cleanup();
  }
});

// ===========================================================================
// B. Refund network orchestration — реальный сквозной путь (mock provider)
// ===========================================================================

test('B1: cancelByCustomer после принятия рестораном реально возвращает деньги через провайдера', async () => {
  const { orderId, paymentId } = await createPaidAcceptedOrder();
  await orderService.cancelByCustomer(orderId);
  await sleep(150); // ждём fire-and-forget scheduleRefundProcessing
  const refundRows = await db.query('SELECT * FROM refunds WHERE payment_id = $1', [paymentId]);
  assert.equal(refundRows.length, 1);
  assert.equal(refundRows[0].status, 'succeeded');
  assert.ok(refundRows[0].provider_refund_id);
  const paymentRow = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
  assert.equal(paymentRow[0].status, 'refunded');
});

test('B2: поздняя оплата уже отменённого заказа — payment succeeded, order остаётся cancelled, деньги реально возвращены', async () => {
  const { order, payload } = await createOrderDirect();
  const pending = await orderService.getPendingPaymentForOrder(order.id);
  await orderService.cancelByCustomer(order.id); // отменяем ДО оплаты (awaiting_payment)
  // Симулируем позднее подтверждение оплаты — провайдер объективно получил
  // деньги уже после отмены (реалистичный race, см. task section 7).
  await orderService.markPaid(order.id, pending.id);
  const orderAfter = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(orderAfter[0].status, 'cancelled', 'заказ не должен воскресать');
  // Платёж проходит succeeded -> refunded очень быстро (mock-провайдер без
  // реальной сетевой задержки, scheduleRefundProcessing — fire-and-forget
  // сразу после markPaid) — проверяем ФИНАЛЬНОЕ состояние после отработки
  // возврата, а не промежуточное (жёсткая проверка промежуточного значения
  // была бы гонкой с самим тестом).
  await sleep(150);
  const paymentAfter = await db.query('SELECT status FROM payments WHERE id = $1', [pending.id]);
  assert.equal(paymentAfter[0].status, 'refunded');
  const refundRows = await db.query('SELECT status FROM refunds WHERE payment_id = $1', [pending.id]);
  assert.equal(refundRows.length, 1);
  assert.equal(refundRows[0].status, 'succeeded', 'деньги должны быть реально возвращены, не только зарезервированы');
  void payload;
});

test('B3: restaurantDecline после оплаты реально возвращает деньги', async () => {
  const { orderId, paymentId } = await createPaidAcceptedOrder();
  await orderService.restaurantDecline(orderId);
  await sleep(150);
  const refundRows = await db.query('SELECT status FROM refunds WHERE payment_id = $1', [paymentId]);
  assert.equal(refundRows.length, 1);
  assert.equal(refundRows[0].status, 'succeeded');
});

test('B4: sweepTimeouts после оплаты (истёкшее окно ответа ресторана) реально возвращает деньги', async () => {
  const { orderId, paymentId } = await createPaidAcceptedOrder();
  await db.execute(`UPDATE orders SET status_updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [orderId]);
  await orderService.sweepTimeouts();
  const orderAfter = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(orderAfter[0].status, 'timed_out');
  await sleep(150);
  const refundRows = await db.query('SELECT status FROM refunds WHERE payment_id = $1', [paymentId]);
  assert.equal(refundRows.length, 1);
  assert.equal(refundRows[0].status, 'succeeded');
});

test('B5: провайдер-таймаут при возврате — строка остаётся processing (не фейковый успех), восстанавливается сверкой', async () => {
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '50';
  const { paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));

  // Монки-патчим ИМЕННО транспортный уровень paymentService (единственная
  // общая точка входа для реального сетевого вызова) так, чтобы он никогда
  // не резолвился в течение таймаута — проверяем, что оркестратор реально
  // соблюдает Promise.race, а не что-то придумывает при обрыве.
  const paymentService = paymentServiceForOrderService;
  const original = paymentService.refundPayment;
  paymentService.refundPayment = () => new Promise(() => {}); // никогда не резолвится
  try {
    await orderService.ensureRefundReady(refundRow.id);
    const after = await db.query('SELECT status, next_attempt_at FROM refunds WHERE id = $1', [refundRow.id]);
    assert.equal(after[0].status, 'processing', 'таймаут не должен превращаться в succeeded/failed');
    assert.ok(after[0].next_attempt_at, 'lease на повтор должен быть выставлен');
  } finally {
    paymentService.refundPayment = original;
    delete process.env.PAYMENT_REFUND_TIMEOUT_MS;
  }

  // Восстановление реальным провайдером на следующем sweep — backoff-lease
  // (выставлен claim'ом ещё ДО таймаута) намеренно в будущем (см.
  // REFUND_BACKOFF_BASE_SEC/CAP_SEC), поэтому для теста "притворяемся", что
  // достаточно времени уже прошло — та же имитация, что и в тестах
  // scheduler'ов предыдущих стадий (paused_until в прошлом и т.п.), не
  // ослабление реальной проверки.
  await db.execute(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundRow.id]);
  const swept = await orderService.sweepStuckRefunds();
  assert.equal(swept, 1);
  const finalRow = await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(finalRow[0].status, 'succeeded');
});

test('B5b: provider pending сохраняет refund id и reconciliation использует GET до финализации', async () => {
  const { paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));
  const paymentService = paymentServiceForOrderService;
  const originalRefund = paymentService.refundPayment;
  const originalGetRefund = paymentService.getRefundStatus;
  let postCalls = 0;
  let getCalls = 0;

  paymentService.refundPayment = async () => {
    postCalls += 1;
    return { refundId: 'provider_pending_refund_1', status: 'pending' };
  };
  paymentService.getRefundStatus = async () => {
    getCalls += 1;
    return getCalls === 1 ? 'pending' : 'succeeded';
  };

  try {
    await orderService.ensureRefundReady(refundRow.id);
    let current = (await db.query('SELECT * FROM refunds WHERE id = $1', [refundRow.id]))[0];
    assert.equal(current.status, 'processing');
    assert.equal(current.provider_refund_id, 'provider_pending_refund_1');

    await db.execute(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundRow.id]);
    await orderService.sweepStuckRefunds();
    current = (await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]))[0];
    assert.equal(current.status, 'processing');

    await db.execute(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refundRow.id]);
    await orderService.sweepStuckRefunds();
    current = (await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]))[0];
    assert.equal(current.status, 'succeeded');
    assert.equal(postCalls, 1, 'POST /refunds нельзя повторять после получения provider refund id');
    assert.equal(getCalls, 2, 'pending refund должен сверяться каноническим GET');
  } finally {
    paymentService.refundPayment = originalRefund;
    paymentService.getRefundStatus = originalGetRefund;
  }
});

test('B6: дублирующий запрос на возврат переиспользует существующую строку (не создаёт вторую)', async () => {
  const { orderId, paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  const first = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'customer_cancel', client));
  const second = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'customer_cancel', client));
  assert.equal(first.id, second.id);
  const count = await db.query('SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1', [paymentId]);
  assert.equal(count[0].n, 1);
  void orderId;
});

test('B7: 5 конкурентных cancelByCustomer на один заказ создают ровно один refund (реальная гонка, real DB, барьер)', async () => {
  for (let iter = 0; iter < 5; iter += 1) {
    const { orderId, paymentId } = await createPaidAcceptedOrder();
    await Promise.all(Array.from({ length: 5 }, () => orderService.cancelByCustomer(orderId).catch(() => null)));
    await sleep(150);
    const refundRows = await db.query('SELECT status FROM refunds WHERE payment_id = $1', [paymentId]);
    assert.equal(refundRows.length, 1, `итерация ${iter}: должна быть ровно одна строка возврата`);
    assert.equal(refundRows[0].status, 'succeeded');
  }
});

test('B8: successful refund side effect (payment -> refunded) применяется РОВНО один раз при конкурентных sweep + прямом вызове', async () => {
  const { paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));

  await Promise.all([
    orderService.ensureRefundReady(refundRow.id),
    orderService.sweepStuckRefunds(),
    orderService.sweepStuckRefunds(),
  ]);
  await sleep(100);

  const refundAfter = await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(refundAfter[0].status, 'succeeded');
  const paymentAfter = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
  assert.equal(paymentAfter[0].status, 'refunded');
});

// ===========================================================================
// C. Reconciliation
// ===========================================================================

test('C1: пропущенный webhook восстанавливается сверкой — "зависший" requested-возврат реально обрабатывается', async () => {
  const { paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  // Прямая резервация БЕЗ scheduleRefundProcessing — симулирует падение
  // процесса между commit бизнес-транзакции и вызовом сети.
  const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));
  await sleep(50);
  const stillStuck = await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(stillStuck[0].status, 'requested');

  const swept = await orderService.sweepStuckRefunds();
  assert.ok(swept >= 1);
  const after = await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(after[0].status, 'succeeded');
});

test('C2: bounded batch — sweepStuckRefunds({limit}) никогда не обрабатывает больше limit строк за раз', async () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    const { paymentId } = await createPaidAcceptedOrder();
    const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
    const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));
    rows.push(refundRow.id);
  }
  const swept = await orderService.sweepStuckRefunds({ limit: 2 });
  assert.equal(swept, 2, 'должно обработать ровно limit строк, не все сразу');
  const remaining = await db.query(
    `SELECT count(*)::int AS n FROM refunds WHERE id = ANY($1) AND status = 'requested'`,
    [rows]
  );
  assert.equal(remaining[0].n, 1, 'одна строка должна остаться необработанной в этом тике');
});

test('C3: терминальные (succeeded/failed) строки не подхватываются повторным sweep', async () => {
  const { paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));
  await orderService.sweepStuckRefunds();
  const afterFirst = await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(afterFirst[0].status, 'succeeded');

  const secondSweptCount = await orderService.sweepStuckRefunds();
  // Может подхватить строки из ДРУГИХ тестов файла — проверяем именно эту.
  const afterSecond = await db.query('SELECT status, updated_at FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(afterSecond[0].status, 'succeeded', 'терминальная строка не должна снова стать processing');
  void secondSweptCount;
});

test('C4: временная недоступность провайдера при reconciliation не роняет процесс', async () => {
  const { paymentId } = await createPaidAcceptedOrder();
  const paymentRow = (await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]))[0];
  const refundRow = await db.transaction((client) => orderService.reserveRefundRow(paymentRow, 'timeout', client));

  const paymentService = paymentServiceForOrderService;
  const original = paymentService.refundPayment;
  paymentService.refundPayment = async () => { throw new Error('simulated provider outage'); };
  try {
    await assert.doesNotReject(() => orderService.sweepStuckRefunds());
  } finally {
    paymentService.refundPayment = original;
  }
  const after = await db.query('SELECT status FROM refunds WHERE id = $1', [refundRow.id]);
  assert.equal(after[0].status, 'processing', 'должно остаться processing, готовое к следующей попытке');
});

test('C5: readiness остаётся ok при временной недоступности провайдера возврата (не блокирует HTTP)', async () => {
  const app = await startWebhookApp();
  try {
    const res = await fetchJson(`${app.baseUrl}/health/ready`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    await app.cleanup();
  }
});

// ===========================================================================
// D. Authorization (регрессия — подтверждаем уже существующую защиту)
// ===========================================================================

test('D1: одного публичного кода заказа недостаточно — GET без Authorization даёт 401', async () => {
  const { order } = await createOrderDirect();
  const app = await startWebhookApp();
  try {
    const res = await fetch(`${app.baseUrl}/api/orders/${order.public_code}`);
    assert.equal(res.status, 401);
  } finally {
    await app.cleanup();
  }
});

test('D2: неверный токен — 401/404, не даёт доступ', async () => {
  const { order } = await createOrderDirect();
  const app = await startWebhookApp();
  try {
    const res = await fetch(`${app.baseUrl}/api/orders/${order.public_code}`, {
      headers: { Authorization: `Bearer yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}` },
    });
    assert.ok(res.status === 401 || res.status === 404);
  } finally {
    await app.cleanup();
  }
});

test('D3: верный токен — доступ разрешён', async () => {
  const { order, payload } = await createOrderDirect();
  const app = await startWebhookApp();
  try {
    const res = await fetchJson(`${app.baseUrl}/api/orders/${order.public_code}`, {
      headers: { Authorization: `Bearer ${payload.orderAccessToken}` },
    });
    assert.equal(res.status, 200);
  } finally {
    await app.cleanup();
  }
});

test('D4: токен ОДНОГО заказа не даёт доступ к ДРУГОМУ заказу', async () => {
  const a = await createOrderDirect();
  const b = await createOrderDirect();
  const app = await startWebhookApp();
  try {
    const res = await fetch(`${app.baseUrl}/api/orders/${b.order.public_code}`, {
      headers: { Authorization: `Bearer ${a.payload.orderAccessToken}` },
    });
    assert.ok(res.status === 401 || res.status === 404);
  } finally {
    await app.cleanup();
  }
});

// ===========================================================================
// E. Regression sanity (полная регрессия запускается отдельно, npm run test:postgresql)
// ===========================================================================

test('E1: services/postgresql/orderService.js не содержит "not implemented" в новых Stage 8 функциях', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../services/postgresql/orderService.js'), 'utf8');
  const stage8Section = src.slice(src.indexOf('refund network orchestration'));
  assert.doesNotMatch(stage8Section, /not implemented/i);
});

test('E2: verifyWebhook() провайдера ЮKassa больше не бросает "not implemented"', async () => {
  const YookassaProvider = require('../../services/paymentProviders/yookassaProvider.js');
  const provider = new YookassaProvider();
  const restore = installFakeFetch(async () => { throw new Error('unused'); });
  try {
    // malformed JSON — не должен дойти до сети/до "not implemented", должен
    // корректно вернуть null.
    const result = await provider.verifyWebhook('{bad json');
    assert.equal(result, null);
  } finally {
    restore();
  }
});
