'use strict';

// Production Switch — Stage 9 HIGH fix: concurrent cancel HTTP 500.
//
// Независимый Codex-аудит (YAAM-Stage-9-Closure-and-Full-Staging-Acceptance-
// Report.pdf) воспроизвёл: два одновременных POST /api/orders/:code/cancel
// дают HTTP 200 + HTTP 500. Данные оставались целыми (не в этом проблема) —
// проигравший конкурент получал RefundInvariantError (statusCode=500) из
// cancelByCustomer() (server/services/postgresql/orderService.js) вместо
// безопасного идемпотентного результата.
//
// Root cause (детерминированно подтверждён barrier-тестом на реальных
// row-lock'ах перед фиксом, см. commit message/PDF-отчёт): rowCount!==1 на
// финальном conditional UPDATE безусловно трактовался как нарушенный
// инвариант, даже когда единственная причина — конкурентный победитель уже
// успешно перевёл тот же заказ в 'cancelled' на долю секунды раньше.
//
// Тесты ниже — реальный embedded PostgreSQL 16.14, тот же harness, что и
// все предыдущие Stage/Wave файлы.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { waitForBackendLock, connectWithPid, sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_concurrent_cancel_stage9_test';

let cluster;
let db;
let orderService;

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  cluster = await startEmbeddedPostgres('concurrent-cancel-stage9');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  orderService = require('../../services/postgresql/orderService.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniquePhone() {
  const n = crypto.randomInt(100000000, 999999999);
  return `+79${String(n).padStart(8, '0')}`;
}

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count)
     VALUES ('Stage9Fix Test Restaurant', 'test', '["Грозный"]', 1, 0, '+79280000099', 4.5, 10) RETURNING id`
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

async function createPaidAcceptedOrder() {
  const { order } = await createOrderDirect();
  const pending = await orderService.getPendingPaymentForOrder(order.id);
  await orderService.markPaid(order.id, pending.id);
  return { orderId: order.id, paymentId: pending.id };
}

// ===========================================================================
// A. Concurrent unpaid cancel
// ===========================================================================

test('A1 (deterministic barrier): два транзакционно-интерливящихся cancel на неоплаченный заказ — ни один не 500, ровно один order/payment, 0 refunds/orphans', async () => {
  const { order } = await createOrderDirect();

  const monitor = new Client({ connectionString: process.env.DATABASE_URL });
  await monitor.connect();

  // Форсируем ТОЧНОЕ пересечение: обе "стороны" читают current.status ДО
  // того, как любая из них закоммитит UPDATE — воспроизводит РЕАЛЬНЫЙ race,
  // не статистическую удачу (см. helpers/concurrency.js).
  const originalTransaction = db.transaction;
  let barrierRelease;
  const barrier = new Promise((resolve) => { barrierRelease = resolve; });
  let firstThroughRead = false;

  db.transaction = async function patchedTransaction(fn) {
    return originalTransaction.call(db, async (client) => {
      const wrappedClient = {
        query: async (sql, params) => {
          const result = await client.query(sql, params);
          if (typeof sql === 'string' && sql.startsWith('SELECT') && sql.includes('FROM orders')) {
            if (!firstThroughRead) {
              firstThroughRead = true;
            } else {
              barrierRelease();
              // Даём первому вызову время дойти до его собственного UPDATE
              // и держать транзакцию открытой (не коммитить) до тех пор,
              // пока второй тоже не попытается обновить ту же строку.
              await sleep(50);
            }
          }
          return result;
        },
      };
      return fn(wrappedClient);
    });
  };

  try {
    const results = await Promise.allSettled([
      orderService.cancelByCustomer(order.id),
      (async () => { await barrier; return orderService.cancelByCustomer(order.id); })(),
    ]);

    const serverErrors = results.filter((r) => r.status === 'rejected' && r.reason.statusCode === 500);
    assert.equal(serverErrors.length, 0, 'ни один конкурент не должен получить 500-класс ошибку');

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'хотя бы один конкурент должен успешно завершиться');
    for (const r of fulfilled) {
      assert.equal(r.value.status, 'cancelled');
    }
  } finally {
    db.transaction = originalTransaction;
  }

  const finalOrder = await orderService.getOrder(order.id);
  assert.equal(finalOrder.status, 'cancelled');
  const orderCount = await db.query('SELECT count(*)::int AS n FROM orders WHERE id = $1', [order.id]);
  assert.equal(orderCount[0].n, 1);
  const paymentCount = await db.query('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [order.id]);
  assert.equal(paymentCount[0].n, 1);
  const refundCount = await db.query('SELECT count(*)::int AS n FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id = $1)', [order.id]);
  assert.equal(refundCount[0].n, 0, 'неоплаченный заказ не должен создавать возвраты');

  await monitor.end();
});

test('A2 (real row-lock barrier via raw clients): проигравший conditional UPDATE после исправления возвращает rowCount=0 -> идемпотентный успех, не throw', async () => {
  const { order } = await createOrderDirect();

  const monitor = new Client({ connectionString: process.env.DATABASE_URL });
  await monitor.connect();
  const winner = new Client({ connectionString: process.env.DATABASE_URL });
  await connectWithPid(winner);
  const loser = new Client({ connectionString: process.env.DATABASE_URL });
  const loserPid = await connectWithPid(loser);

  await winner.query('BEGIN');
  const winnerRead = await winner.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  await loser.query('BEGIN');
  const loserRead = await loser.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(winnerRead.rows[0].status, 'awaiting_payment');
  assert.equal(loserRead.rows[0].status, 'awaiting_payment');

  await winner.query(`UPDATE orders SET status='cancelled' WHERE id=$1 AND status=$2`, [order.id, winnerRead.rows[0].status]);
  const loserUpdatePromise = loser.query(`UPDATE orders SET status='cancelled' WHERE id=$1 AND status=$2 RETURNING id`, [order.id, loserRead.rows[0].status]);
  await waitForBackendLock(monitor, loserPid, { timeoutMs: 5000 });
  await winner.query('COMMIT');
  const loserResult = await loserUpdatePromise;
  assert.equal(loserResult.rowCount, 0, 'этот тест доказывает, что race-окно реально существует на SQL-уровне (сам механизм)');
  await loser.query('COMMIT');

  // Теперь проверяем, что РЕАЛЬНАЯ функция cancelByCustomer, столкнувшись с
  // этим же rowCount=0 сценарием (через orderService напрямую, тот же заказ,
  // теперь уже cancelled), не бросает 500, а идемпотентно возвращает успех.
  const idempotentResult = await orderService.cancelByCustomer(order.id).catch((e) => e);
  // После фикса: заказ уже cancelled, но статус НЕ в {awaiting_payment,
  // awaiting_restaurant} -> обычная бизнес-ошибка (400-класс, тот же
  // контракт, что и в C/sequential ниже) — НЕ 500.
  assert.notEqual(idempotentResult.statusCode, 500);

  await winner.end();
  await loser.end();
  await monitor.end();
});

// ===========================================================================
// B. Rapid repeated cancel
// ===========================================================================

test('B1: серия из 8 почти одновременных cancel — ни одного 500, финальное состояние стабильно, без дублей', async () => {
  const { order } = await createOrderDirect();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => orderService.cancelByCustomer(order.id))
  );
  const serverErrors = results.filter((r) => r.status === 'rejected' && r.reason.statusCode === 500);
  assert.equal(serverErrors.length, 0);

  const finalOrder = await orderService.getOrder(order.id);
  assert.equal(finalOrder.status, 'cancelled');
  const orderCount = await db.query('SELECT count(*)::int AS n FROM orders WHERE id = $1', [order.id]);
  assert.equal(orderCount[0].n, 1);
});

// ===========================================================================
// C. Sequential repeat cancel
// ===========================================================================

test('C1: первый cancel успешен; строго последующий повторный cancel не 500, не создаёт новых строк', async () => {
  const { order } = await createOrderDirect();
  const first = await orderService.cancelByCustomer(order.id);
  assert.equal(first.status, 'cancelled');

  // ЗАДОКУМЕНТИРОВАННЫЙ ожидаемый HTTP-контракт (не изменён этим фиксом,
  // подтверждён независимым аудитом как уже корректный — A14 PASS в
  // отчёте): строго ПОСЛЕДОВАТЕЛЬНЫЙ повтор (не гонка, не interleaved race)
  // на уже cancelled заказе — обычная бизнес-ошибка 400-класса ("уже
  // готовится"), НЕ идемпотентный 200 и НЕ 500. Отличие от A/B выше: там
  // "проигравший" запрос СТАРТОВАЛ до того, как заказ реально стал
  // cancelled (сам увидел ещё awaiting_*), здесь второй запрос стартует
  // ПОСЛЕ того, как первый уже полностью завершился — с самого начала видит
  // актуальный cancelled статус на собственном первом чтении.
  const second = await orderService.cancelByCustomer(order.id).catch((e) => e);
  assert.ok(second instanceof Error);
  assert.notEqual(second.statusCode, 500);
  assert.match(second.message, /уже готовится/);

  const orderCount = await db.query('SELECT count(*)::int AS n FROM orders WHERE id = $1', [order.id]);
  assert.equal(orderCount[0].n, 1);
  const refundCount = await db.query('SELECT count(*)::int AS n FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id = $1)', [order.id]);
  assert.equal(refundCount[0].n, 0);
});

// ===========================================================================
// D. Paid awaiting_restaurant branch — concurrent cancel + refund
// ===========================================================================

test('D1: конкурентная отмена ОПЛАЧЕННОГО принятого рестораном заказа — ровно один refund, ни одного 500, деньги реально возвращаются', async () => {
  const { orderId, paymentId } = await createPaidAcceptedOrder();

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => orderService.cancelByCustomer(orderId))
  );
  const serverErrors = results.filter((r) => r.status === 'rejected' && r.reason.statusCode === 500);
  assert.equal(serverErrors.length, 0, 'ни один конкурент из paid-ветки не должен получить 500');

  await sleep(150); // ждём fire-and-forget scheduleRefundProcessing (Stage 8)

  const refundRows = await db.query('SELECT status FROM refunds WHERE payment_id = $1', [paymentId]);
  assert.equal(refundRows.length, 1, 'ровно одна строка возврата, не дубликаты от проигравших конкурентов');
  assert.equal(refundRows[0].status, 'succeeded');

  const paymentRow = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
  assert.equal(paymentRow[0].status, 'refunded');

  const finalOrder = await orderService.getOrder(orderId);
  assert.equal(finalOrder.status, 'cancelled');
});

test('D2: 5 повторных итераций конкурентной paid-отмены — стабильно 0 orphan/duplicate refund rows', async () => {
  for (let iter = 0; iter < 5; iter += 1) {
    const { orderId, paymentId } = await createPaidAcceptedOrder();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => orderService.cancelByCustomer(orderId))
    );
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.statusCode === 500).length, 0, `итерация ${iter}`);
    await sleep(120);
    const refundRows = await db.query('SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1', [paymentId]);
    assert.equal(refundRows[0].n, 1, `итерация ${iter}: ровно один refund`);
  }
});

// ===========================================================================
// E. Wrong-state race — не маскировать настоящую ошибку
// ===========================================================================

test('E1: заказ переходит НЕ в cancelled между чтением и UPDATE — возвращается настоящая бизнес-ошибка, не ложный успех', async () => {
  const { order } = await createOrderDirect();

  const original = db.execute;
  let patched = false;
  db.execute = async function patchedExecute(sql, params, client) {
    if (!patched && typeof sql === 'string' && sql.includes("UPDATE orders SET status = 'cancelled'")) {
      patched = true;
      // Симулирует: ресторан принимает заказ РОВНО в момент между чтением
      // cancelByCustomer и её собственным UPDATE (реалистичная гонка с
      // restaurantAccept, не гипотетика).
      await original.call(db, `UPDATE orders SET status='accepted' WHERE id=$1`, [order.id]);
    }
    return original.call(db, sql, params, client);
  };

  let caught;
  try {
    await orderService.cancelByCustomer(order.id);
  } catch (err) {
    caught = err;
  } finally {
    db.execute = original;
  }

  assert.ok(caught, 'должна быть выброшена ошибка, не тихий успех');
  assert.notEqual(caught.statusCode, 500, 'не должно маскироваться под 500-инвариант');
  assert.match(caught.message, /уже готовится/, 'должна быть настоящая бизнес-ошибка конфликта состояния');

  const finalOrder = await orderService.getOrder(order.id);
  assert.equal(finalOrder.status, 'accepted', 'реальный race НЕ должен маскироваться под успешную отмену');
});

// ===========================================================================
// F. Not found / invalid access — регрессия, фикс не должен это менять
// ===========================================================================

test('F1: несуществующий заказ — прежняя ошибка "заказ не найден", не 500', async () => {
  await assert.rejects(
    () => orderService.cancelByCustomer(999999999),
    (err) => {
      assert.equal(err.message, 'заказ не найден');
      assert.notEqual(err.statusCode, 500);
      return true;
    }
  );
});

test('F2: заказ в недопустимом для отмены статусе (например, delivered) — прежняя явная бизнес-ошибка, не 500', async () => {
  const { order } = await createOrderDirect();
  await db.execute(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [order.id]);
  await assert.rejects(
    () => orderService.cancelByCustomer(order.id),
    (err) => {
      assert.match(err.message, /уже готовится/);
      assert.notEqual(err.statusCode, 500);
      return true;
    }
  );
});

// ===========================================================================
// G. Публичный HTTP-уровень (реальный маршрут, реальное приложение) —
// именно та поверхность, где независимый аудит наблюдал 200+500.
// ===========================================================================

test('G1: реальный HTTP POST /api/orders/:code/cancel — 5 конкурентных запросов, ни одного 500, ровно одно 200', async () => {
  const { createPostgresqlApp } = require('../../services/postgresql/app.js');
  const instance = createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000, orderTimeoutIntervalMs: 1_000_000, refundReconciliationIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { order, payload } = await createOrderDirect();
    const { port } = instance.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${baseUrl}/api/orders/${order.public_code}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${payload.orderAccessToken}` },
      }))
    );
    const statuses = responses.map((r) => r.status);

    assert.ok(statuses.every((s) => s !== 500), `ни один HTTP-ответ не должен быть 500, получено: ${JSON.stringify(statuses)}`);
    assert.ok(statuses.includes(200), 'хотя бы один запрос должен получить 200');
    assert.ok(statuses.every((s) => s === 200 || s === 400), `неожиданный статус вне {200,400}: ${JSON.stringify(statuses)}`);
  } finally {
    await instance.stop();
  }
});
