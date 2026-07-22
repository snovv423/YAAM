'use strict';

// YAAM Production Switch — Stage 2 (PostgreSQL Event Layer, orderEvents):
// integration-тесты для нового EventEmitter в
// server/services/postgresql/orderService.js против настоящего embedded
// PostgreSQL 16.14 + parity-тесты payload'а против SQLite-оригинала
// (server/services/orderService.js).
//
// Что проверяется (см. server/docs/postgresql-migration-status.md, раздел
// "Production Switch — Stage 2" для полного обоснования):
//   - все 8 точек эмиссии (markPaid, markPaymentFailed, restaurantAccept,
//     restaurantDecline, restaurantAdvance, cancelByCustomer,
//     finalizeRetryAttempt, sweepTimeouts) публикуют ожидаемое событие с
//     ожидаемым payload;
//   - каждый из четырёх гвард-паттернов (явный boolean / closure-переменная /
//     throw-based / post-hoc проверка статуса) реально предотвращает
//     повторную/лишнюю эмиссию на no-op и rollback-путях;
//   - порядок событий markPaid (order:status ДО order:new) сохранён;
//   - конкурентные вызовы дают ровно одну эмиссию на реальный переход;
//   - payload совместим с тем, что реально читает bot/index.js
//     ('order:new' handler);
//   - ни один тест не оставляет "висящих" слушателей на shared orderEvents.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { waitForBackendLock, connectWithPid, sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_eventlayer_stage2_test';

let cluster;
let db;
let pgOrderService;
let monitor;

let sqliteDb;
let sqliteOrderService;
let sqliteDbPath;

before(async () => {
  cluster = await startEmbeddedPostgres('eventlayer-stage2');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');

  monitor = cluster.getClient(DATABASE_NAME);
  await monitor.connect();

  sqliteDbPath = path.join(os.tmpdir(), `yaam-eventlayer-stage2-parity-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DB_PATH = sqliteDbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  sqliteDb = require('../../db');
  sqliteOrderService = require('../../services/orderService.js');
});

after(async () => {
  await monitor.end();
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(sqliteDbPath + suffix); } catch { /* уже нет */ }
  }
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Event-capture helper — гарантированно снимает слушателя даже при падении
// теста (try/finally на вызывающей стороне), чтобы ни один тест не оставлял
// висящих подписчиков на shared orderEvents между тестами этого файла.
// ---------------------------------------------------------------------------

function captureEvents(emitter, eventNames) {
  const captured = [];
  const listeners = {};
  for (const name of eventNames) {
    const listener = (payload) => captured.push({ event: name, payload });
    listeners[name] = listener;
    emitter.on(name, listener);
  }
  return {
    captured,
    stop() {
      for (const name of eventNames) emitter.removeListener(name, listeners[name]);
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL fixtures
// ---------------------------------------------------------------------------

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, phone) VALUES ('Test', 'test', '[]', '+79280000000') RETURNING id`
  );
  return rows[0].id;
}

async function pgCreateOrder(restaurantId, { status = 'awaiting_payment', fulfillmentType = 'delivery', statusUpdatedAt = null } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, fulfillment_type, comment, status_updated_at
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, $3, $4, 'без лука',
       COALESCE($5, NOW()))
     RETURNING *`,
    [`YAAM-EV-${suffix}`, restaurantId, status, fulfillmentType, statusUpdatedAt]
  );
  return rows[0];
}

async function pgCreateOrderItem(orderId, { name = 'Хачапури', price = 500, qty = 1 } = {}) {
  await db.execute(
    `INSERT INTO order_items (order_id, name, price, qty) VALUES ($1, $2, $3, $4)`,
    [orderId, name, price, qty]
  );
}

async function pgCreatePayment(orderId, { amount = 500, status = 'pending' } = {}) {
  const rows = await db.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3) RETURNING *`,
    [orderId, amount, status]
  );
  return rows[0];
}

async function pgCreateRetryAttempt(paymentId, { state = 'creating' } = {}) {
  const rows = await db.query(
    `INSERT INTO payment_retry_attempts (payment_id, provider_idempotency_key, state)
     VALUES ($1, $2, $3) RETURNING *`,
    [paymentId, crypto.randomUUID(), state]
  );
  return rows[0];
}

// Полный "штатный" fixture для finalizeRetryAttempt: order(payment_failed)
// + payment(creating) + payment_retry_attempts(creating) — тот же fixture,
// что и orderServiceWave4.test.js.
async function pgSetupRetryAttempt() {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'payment_failed' });
  const payment = await pgCreatePayment(order.id, { status: 'creating' });
  await pgCreateRetryAttempt(payment.id, { state: 'creating' });
  return { order, payment };
}

function secondsAgo(sec) {
  return new Date(Date.now() - sec * 1000);
}

function extRef() {
  return `ext_${crypto.randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// SQLite fixtures (для parity)
// ---------------------------------------------------------------------------

function sqliteCreateRestaurant() {
  return sqliteDb.prepare(`INSERT INTO restaurants (name, cuisine, cities, phone) VALUES ('Test', 'test', '[]', '+79280000000')`).run().lastInsertRowid;
}

function sqliteCreateOrder(restaurantId, { status = 'awaiting_payment', fulfillmentType = 'delivery' } = {}) {
  const suffix = uniqueSuffix();
  const info = sqliteDb.prepare(`
    INSERT INTO orders (
      public_code, restaurant_id, city, customer_name, customer_phone, address,
      items_total, commission_amount, status, fulfillment_type, comment
    ) VALUES (?, ?, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, ?, ?, 'без лука')
  `).run(`YAAM-EVS-${suffix}`, restaurantId, status, fulfillmentType);
  return sqliteDb.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}

function sqliteCreateOrderItem(orderId, { name = 'Хачапури', price = 500, qty = 1 } = {}) {
  sqliteDb.prepare(`INSERT INTO order_items (order_id, name, price, qty) VALUES (?, ?, ?, ?)`).run(orderId, name, price, qty);
}

function sqliteCreatePayment(orderId, { amount = 500, status = 'pending' } = {}) {
  const info = sqliteDb.prepare(`INSERT INTO payments (order_id, amount, status) VALUES (?, ?, ?)`).run(orderId, amount, status);
  return sqliteDb.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
}

// ===========================================================================
// markPaymentFailed
// ===========================================================================

test('markPaymentFailed: успешный переход эмитит order:status с payload = getOrder()', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    const result = await pgOrderService.markPaymentFailed(order.id, payment.id);

    assert.equal(cap.captured.length, 1);
    assert.equal(cap.captured[0].event, 'order:status');
    assert.equal(cap.captured[0].payload.id, order.id);
    assert.equal(cap.captured[0].payload.status, 'payment_failed');
    assert.deepEqual(cap.captured[0].payload, result, 'payload должен быть тем же объектом, что и возвращаемый результат');
  } finally {
    cap.stop();
  }
});

test('markPaymentFailed: no-op (заказ не awaiting_payment) — ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    await pgOrderService.markPaymentFailed(order.id, payment.id);
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// markPaid
// ===========================================================================

test('markPaid: успешная оплата эмитит order:status ЗАТЕМ order:new, оба с одинаковым payload', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  await pgCreateOrderItem(order.id, { name: 'Хинкали', price: 500, qty: 1 });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    const result = await pgOrderService.markPaid(order.id, payment.id);

    assert.equal(cap.captured.length, 2, 'должно быть ровно два события — status и new');
    assert.equal(cap.captured[0].event, 'order:status', 'order:status должен эмититься ПЕРВЫМ');
    assert.equal(cap.captured[1].event, 'order:new', 'order:new — ВТОРЫМ (дословный порядок SQLite-оригинала)');
    assert.deepEqual(cap.captured[0].payload, result);
    assert.deepEqual(cap.captured[1].payload, result);
    assert.equal(result.status, 'awaiting_restaurant');
    assert.ok(Array.isArray(result.items) && result.items.length === 1, 'payload должен содержать items[] — bot их читает напрямую');
  } finally {
    cap.stop();
  }
});

test('markPaid: no-op (payment уже не pending) — ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'failed' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

test('markPaid: поздняя оплата уже отменённого заказа — ничего не эмитит (заказ не воскрешается)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'cancelled' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    const result = await pgOrderService.markPaid(order.id, payment.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(cap.captured.length, 0, 'claim-резервация возврата коммитится, но событие СТАТУСА заказа не эмитится — статус не менялся');
  } finally {
    cap.stop();
  }
});

test('markPaid: throw-путь (заказ в недостижимом статусе) — ничего не эмитит, rollback', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' }); // не awaiting_payment и не cancelled
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    await assert.rejects(() => pgOrderService.markPaid(order.id, payment.id));
    assert.equal(cap.captured.length, 0, 'исключение до commit — событие не должно было эмититься');

    const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
    assert.equal(paymentRows[0].status, 'pending', 'rollback должен был откатить любые промежуточные изменения');
  } finally {
    cap.stop();
  }
});

test('markPaid: повторный вызов (replay) — эмитит только на ПЕРВОМ вызове, не на втором', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    assert.equal(cap.captured.length, 2);
    cap.captured.length = 0;

    await pgOrderService.markPaid(order.id, payment.id); // replay — payment уже succeeded, no-op
    assert.equal(cap.captured.length, 0, 'повторный вызов не должен был эмитить события повторно');
  } finally {
    cap.stop();
  }
});

test('markPaid: два конкурентных вызова на один payment — ровно одна пара событий (не две)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status', 'order:new']);
  try {
    await Promise.all([
      pgOrderService.markPaid(order.id, payment.id),
      pgOrderService.markPaid(order.id, payment.id),
    ]);
    assert.equal(cap.captured.length, 2, 'ровно одна пара (status+new) на двух конкурентов — второй должен был проиграть гонку как no-op');
    assert.equal(cap.captured[0].event, 'order:status');
    assert.equal(cap.captured[1].event, 'order:new');
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// restaurantAccept
// ===========================================================================

test('restaurantAccept: успешный переход эмитит order:status', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const result = await pgOrderService.restaurantAccept(order.id);
    assert.equal(cap.captured.length, 1);
    assert.deepEqual(cap.captured[0].payload, result);
    assert.equal(result.status, 'accepted');
  } finally {
    cap.stop();
  }
});

test('restaurantAccept: no-op (неверный статус) — ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'delivered' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const result = await pgOrderService.restaurantAccept(order.id);
    assert.equal(result.status, 'delivered');
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// restaurantDecline
// ===========================================================================

test('restaurantDecline: успешный отказ эмитит order:status', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const result = await pgOrderService.restaurantDecline(order.id);
    assert.equal(cap.captured.length, 1);
    assert.equal(cap.captured[0].payload.status, 'declined');
    assert.deepEqual(cap.captured[0].payload, result);
  } finally {
    cap.stop();
  }
});

test('restaurantDecline: no-op (неверный статус) — ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await pgOrderService.restaurantDecline(order.id);
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

test('restaurantDecline: несуществующий заказ — ничего не эмитит', async () => {
  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const result = await pgOrderService.restaurantDecline(999999999);
    assert.equal(result, null);
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

test('restaurantDecline: повторный ПОСЛЕДОВАТЕЛЬНЫЙ вызов на уже declined-заказе — второй вызов НЕ эмитит (rowCount-гвард, не post-hoc status)', async () => {
  // Прямая регрессия на баг, найденный при проектировании Stage 2: буквальная
  // post-hoc проверка status==='declined' прошла бы у ВТОРОГО вызова тоже
  // (заказ уже declined), эмитировав повторно — см. "Production Switch —
  // Stage 2", п.4 в services/postgresql/orderService.js.
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const first = await pgOrderService.restaurantDecline(order.id);
    assert.equal(first.status, 'declined');
    assert.equal(cap.captured.length, 1);

    const second = await pgOrderService.restaurantDecline(order.id);
    assert.equal(second.status, 'declined', 'второй вызов видит уже declined — no-op, но status остаётся корректным');
    assert.equal(cap.captured.length, 1, 'второй вызов НЕ должен был эмитить повторно');
  } finally {
    cap.stop();
  }
});

test('restaurantDecline: два конкурентных вызова — ровно ОДНО событие (только победитель гонки)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const [r1, r2] = await Promise.all([
      pgOrderService.restaurantDecline(order.id),
      pgOrderService.restaurantDecline(order.id),
    ]);
    assert.equal(r1.status, 'declined');
    assert.equal(r2.status, 'declined');
    assert.equal(cap.captured.length, 1, 'только реальный переход должен был эмитить — проигравший гонку получил уже declined и НЕ прошёл post-hoc проверку своего собственного UPDATE');
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// restaurantAdvance
// ===========================================================================

test('restaurantAdvance: успешный переход эмитит order:status', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const result = await pgOrderService.restaurantAdvance(order.id, 'preparing', { estimatedMinutes: 20 });
    assert.equal(cap.captured.length, 1);
    assert.equal(cap.captured[0].payload.status, 'preparing');
    assert.deepEqual(cap.captured[0].payload, result);
  } finally {
    cap.stop();
  }
});

test('restaurantAdvance: недопустимый переход — throw, ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await assert.rejects(() => pgOrderService.restaurantAdvance(order.id, 'delivered'));
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// cancelByCustomer
// ===========================================================================

test('cancelByCustomer: отмена awaiting_payment эмитит order:status', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const result = await pgOrderService.cancelByCustomer(order.id);
    assert.equal(cap.captured.length, 1);
    assert.equal(cap.captured[0].payload.status, 'cancelled');
    assert.deepEqual(cap.captured[0].payload, result);
  } finally {
    cap.stop();
  }
});

test('cancelByCustomer: недопустимый статус — throw, ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await assert.rejects(() => pgOrderService.cancelByCustomer(order.id));
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

// Production Switch — Stage 9 HIGH-фикс (независимый Codex-аудит,
// "concurrent cancel HTTP 500"): раньше проигравший конкурент БЕЗУСЛОВНО
// бросал RefundInvariantError (500) на rowCount!==1 — здесь это проверялось
// как "один rejects". Теперь проигравший, увидев, что заказ уже реально
// cancelled (переведён победителем), возвращает БЕЗОПАСНЫЙ ИДЕМПОТЕНТНЫЙ
// успех вместо ошибки — оба конкурента fulfilled. Ключевой инвариант этого
// теста НЕ изменился и остаётся главной проверкой: событие 'order:status'
// эмитируется РОВНО ОДИН раз, не дважды (changed-guard, тот же принцип, что
// уже был у restaurantDecline/sweepTimeouts) — победитель эмитит, проигравший
// НЕ эмитит повторно за тот же реальный переход.
test('cancelByCustomer: два конкурентных вызова — оба fulfilled (Stage 9 фикс), но ровно одна эмиссия', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    const [r1, r2] = await Promise.allSettled([
      pgOrderService.cancelByCustomer(order.id),
      pgOrderService.cancelByCustomer(order.id),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 2, 'Stage 9: оба конкурента должны безопасно завершиться успехом, не 500');
    for (const r of fulfilled) assert.equal(r.value.status, 'cancelled');
    assert.equal(cap.captured.length, 1, 'ровно одна эмиссия на один реальный переход — changed-guard предотвращает дубликат от идемпотентного проигравшего');
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// finalizeRetryAttempt
// ===========================================================================

test('finalizeRetryAttempt: успешная финализация эмитит order:status с payload.status=awaiting_payment', async () => {
  const { order, payment } = await pgSetupRetryAttempt();

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await pgOrderService.finalizeRetryAttempt(payment.id, {
      providerPaymentId: extRef(),
      paymentUrl: 'https://pay.example/r1',
      qrPayload: 'qr-r1',
    });
    assert.equal(cap.captured.length, 1);
    assert.equal(cap.captured[0].payload.id, order.id);
    assert.equal(cap.captured[0].payload.status, 'awaiting_payment');
  } finally {
    cap.stop();
  }
});

test('finalizeRetryAttempt: идемпотентный replay (attempt уже pending) — НЕ эмитит второй раз', async () => {
  const { payment } = await pgSetupRetryAttempt();
  const providerResult = { providerPaymentId: extRef(), paymentUrl: 'u', qrPayload: 'q' };

  await pgOrderService.finalizeRetryAttempt(payment.id, providerResult); // первый вызов — реальный переход

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await pgOrderService.finalizeRetryAttempt(payment.id, providerResult); // replay — attempt.status уже 'pending'
    assert.equal(cap.captured.length, 0, 'orderTransitioned не должен был установиться на replay-ветке');
  } finally {
    cap.stop();
  }
});

test('finalizeRetryAttempt: конфликт (payment уже не creating/pending) — throw, ничего не эмитит', async () => {
  const { payment } = await pgSetupRetryAttempt();
  await db.execute(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await assert.rejects(() => pgOrderService.finalizeRetryAttempt(payment.id, { providerPaymentId: extRef(), paymentUrl: 'u', qrPayload: 'q' }));
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// sweepTimeouts
// ===========================================================================

test('sweepTimeouts: просроченный заказ эмитит order:status с payload.status=timed_out', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(200) });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await pgOrderService.sweepTimeouts();
    assert.equal(cap.captured.length, 1);
    assert.equal(cap.captured[0].payload.id, order.id);
    assert.equal(cap.captured[0].payload.status, 'timed_out');
  } finally {
    cap.stop();
  }
});

test('sweepTimeouts: свежий заказ — ничего не эмитит', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(5) });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await pgOrderService.sweepTimeouts();
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.stop();
  }
});

test('sweepTimeouts: несколько просроченных заказов в одном свипе — по одному событию на каждый', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orderA = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(300) });
  await pgCreatePayment(orderA.id, { status: 'succeeded' });
  const orderB = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(250) });
  await pgCreatePayment(orderB.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await pgOrderService.sweepTimeouts();
    assert.equal(cap.captured.length, 2);
    const ids = cap.captured.map((c) => c.payload.id).sort();
    assert.deepEqual(ids, [orderA.id, orderB.id].sort());
  } finally {
    cap.stop();
  }
});

test('sweepTimeouts: ошибка на одном заказе не мешает эмиссии для соседнего заказа того же свипа', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orderFail = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(300) });
  await pgCreatePayment(orderFail.id, { status: 'succeeded' });
  const orderOk = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(300) });
  await pgCreatePayment(orderOk.id, { status: 'succeeded' });

  const originalExecute = db.execute;
  db.execute = async function patched(text, params, client) {
    if (text.includes(`UPDATE orders SET status = 'timed_out'`) && params && params[0] === orderFail.id) {
      db.execute = originalExecute;
      throw new Error('искусственная ошибка для orderFail');
    }
    return originalExecute.call(db, text, params, client);
  };

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    try {
      await pgOrderService.sweepTimeouts();
    } finally {
      db.execute = originalExecute;
    }
    assert.equal(cap.captured.length, 1, 'только соседний заказ должен был эмитить — упавший заказ не эмитит и не откатывает соседа');
    assert.equal(cap.captured[0].payload.id, orderOk.id);
  } finally {
    cap.stop();
    // orderFail намеренно остался в awaiting_restaurant (rollback) — без
    // этого он оставался бы "просроченным" и попадал бы в stale-выборку
    // ВСЕХ последующих sweepTimeouts-тестов этого файла, искажая счётчик
    // событий. Выводим его из sweep-окна, не трогая сам факт rollback'а.
    await db.execute(`UPDATE orders SET status_updated_at = NOW() WHERE id = $1`, [orderFail.id]);
  }
});

test('sweepTimeouts: два конкурентных прогона на один заказ — ровно одна эмиссия', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant', statusUpdatedAt: secondsAgo(300) });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  const cap = captureEvents(pgOrderService.orderEvents, ['order:status']);
  try {
    await Promise.all([pgOrderService.sweepTimeouts(), pgOrderService.sweepTimeouts()]);
    assert.equal(cap.captured.length, 1, 'второй прогон должен был увидеть заказ уже timed_out и не эмитить повторно');
  } finally {
    cap.stop();
  }
});

// ===========================================================================
// Parity: payload PostgreSQL совместим с payload SQLite (то, что реально
// читает bot/index.js 'order:new' handler — restaurant_id/public_code/items/
// fulfillment_type/address/items_total/customer_phone/comment/id).
// ===========================================================================

const BOT_RELEVANT_FIELDS = [
  'fulfillment_type',
  'address',
  'items_total',
  'customer_phone',
  'comment',
  'status',
];

function normalizeBotPayload(order) {
  const picked = {};
  for (const field of BOT_RELEVANT_FIELDS) picked[field] = order[field];
  picked.items = order.items.map((i) => ({ name: i.name, price: i.price, qty: i.qty }));
  picked.hasId = typeof order.id === 'number';
  picked.hasRestaurantId = typeof order.restaurant_id === 'number';
  // public_code — независимая последовательность в каждом движке/каждой
  // фикстуре (SQLite AUTOINCREMENT vs PostgreSQL IDENTITY, разные счётчики
  // в разных тестовых БД) — сравнивать точное значение бессмысленно, только
  // форму контракта "YAAM-<что-то>", которую и использует bot в тексте
  // уведомления.
  picked.publicCodeLooksRight = typeof order.public_code === 'string' && order.public_code.startsWith('YAAM-');
  return picked;
}

test('Parity: markPaid — order:new payload содержит те же поля/значения, что читает bot/index.js на SQLite', async () => {
  const sqliteCap = [];
  const sqliteListener = (order) => sqliteCap.push(order);
  sqliteOrderService.orderEvents.on('order:new', sqliteListener);
  let sqliteResult;
  try {
    const sqliteRestaurantId = sqliteCreateRestaurant();
    const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'awaiting_payment' });
    sqliteCreateOrderItem(sqliteOrder.id, { name: 'Хинкали', price: 500, qty: 1 });
    const sqlitePayment = sqliteCreatePayment(sqliteOrder.id, { status: 'pending' });
    sqliteResult = sqliteOrderService.markPaid(sqliteOrder.id, sqlitePayment.id);
  } finally {
    sqliteOrderService.orderEvents.removeListener('order:new', sqliteListener);
  }

  const pgCap = captureEvents(pgOrderService.orderEvents, ['order:new']);
  let pgResult;
  try {
    const pgRestaurantId = await pgCreateRestaurant();
    const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'awaiting_payment' });
    await pgCreateOrderItem(pgOrder.id, { name: 'Хинкали', price: 500, qty: 1 });
    const pgPayment = await pgCreatePayment(pgOrder.id, { status: 'pending' });
    pgResult = await pgOrderService.markPaid(pgOrder.id, pgPayment.id);
  } finally {
    pgCap.stop();
  }

  assert.equal(sqliteCap.length, 1);
  assert.equal(pgCap.captured.length, 1);
  assert.deepEqual(normalizeBotPayload(sqliteCap[0]), normalizeBotPayload(pgResult));
  assert.deepEqual(normalizeBotPayload(sqliteResult), normalizeBotPayload(pgResult));
});

// ===========================================================================
// Listener leak / cleanup
// ===========================================================================

test('orderEvents: ни один предыдущий тест этого файла не оставил висящих слушателей', () => {
  assert.equal(pgOrderService.orderEvents.listenerCount('order:status'), 0);
  assert.equal(pgOrderService.orderEvents.listenerCount('order:new'), 0);
});

test('orderEvents: пул PostgreSQL возвращён после всех событийных тестов, waitingCount=0', async () => {
  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});
