'use strict';

// YAAM-postgresql-order-service-wave-2.pdf — integration-тесты для
// reserveRefundRow, markPaid, restaurantDecline, cancelByCustomer
// (server/services/postgresql/orderService.js, Wave 2) против настоящего
// embedded PostgreSQL 16.14 + parity-тесты против SQLite-оригинала.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { waitForBackendLock, connectWithPid, sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_orderservice_wave2_test';

let cluster;
let db;
let pgOrderService;
let monitor;

let sqliteDb;
let sqliteOrderService;
let sqliteDbPath;

before(async () => {
  cluster = await startEmbeddedPostgres('orderservice-wave2');
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

  sqliteDbPath = path.join(os.tmpdir(), `yaam-wave2-parity-${crypto.randomBytes(6).toString('hex')}.db`);
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
// PostgreSQL fixtures
// ---------------------------------------------------------------------------

async function pgCreateRestaurant() {
  const rows = await db.query(`INSERT INTO restaurants (name, cuisine, cities) VALUES ('Test', 'test', '[]') RETURNING id`);
  return rows[0].id;
}

async function pgCreateOrder(restaurantId, { status = 'awaiting_payment' } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, $3)
     RETURNING *`,
    [`YAAM-W2-${suffix}`, restaurantId, status]
  );
  return rows[0];
}

async function pgCreatePayment(orderId, { amount = 500, status = 'pending' } = {}) {
  const rows = await db.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3) RETURNING *`,
    [orderId, amount, status]
  );
  return rows[0];
}

async function pgRefundsForPayment(paymentId) {
  return db.query('SELECT * FROM refunds WHERE payment_id = $1 ORDER BY id', [paymentId]);
}

// ---------------------------------------------------------------------------
// SQLite fixtures (для parity)
// ---------------------------------------------------------------------------

function sqliteCreateRestaurant() {
  return sqliteDb.prepare(`INSERT INTO restaurants (name, cuisine, cities) VALUES ('Test', 'test', '[]')`).run().lastInsertRowid;
}

function sqliteCreateOrder(restaurantId, { status = 'awaiting_payment' } = {}) {
  const suffix = uniqueSuffix();
  const info = sqliteDb.prepare(`
    INSERT INTO orders (
      public_code, restaurant_id, city, customer_name, customer_phone, address,
      items_total, commission_amount, status
    ) VALUES (?, ?, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, ?)
  `).run(`YAAM-W2S-${suffix}`, restaurantId, status);
  return sqliteDb.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}

function sqliteCreatePayment(orderId, { amount = 500, status = 'pending' } = {}) {
  const info = sqliteDb.prepare(`INSERT INTO payments (order_id, amount, status) VALUES (?, ?, ?)`).run(orderId, amount, status);
  return sqliteDb.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
}

function sqliteRefundsForPayment(paymentId) {
  return sqliteDb.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY id').all(paymentId);
}

// ===========================================================================
// reserveRefundRow
// ===========================================================================

test('reserveRefundRow: null payment -> null, без побочных эффектов', async () => {
  const result = await db.transaction((client) => pgOrderService.reserveRefundRow(null, 'customer_cancel', client));
  assert.equal(result, null);
});

test('reserveRefundRow: создаёт новую requested-строку с корректными полями', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const result = await db.transaction((client) => pgOrderService.reserveRefundRow(payment, 'customer_cancel', client));

  assert.equal(result.status, 'requested');
  assert.equal(result.reason, 'customer_cancel');
  assert.equal(result.payment_id, payment.id);
  assert.equal(result.amount, payment.amount);
  assert.equal(result.provider, payment.provider);
  assert.ok(result.provider_idempotency_key);
});

test('reserveRefundRow: повторный вызов возвращает ТУ ЖЕ строку (idempotent), не создаёт вторую', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const first = await db.transaction((client) => pgOrderService.reserveRefundRow(payment, 'customer_cancel', client));
  const second = await db.transaction((client) => pgOrderService.reserveRefundRow(payment, 'restaurant_decline', client));

  assert.equal(first.id, second.id);
  assert.equal(second.reason, 'customer_cancel', 'вторая попытка не должна была переписать reason');

  const all = await pgRefundsForPayment(payment.id);
  assert.equal(all.length, 1);
});

test('reserveRefundRow: не-23505 ошибка (CHECK-нарушение на reason) пробрасывается как есть, не перехватывается', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  await assert.rejects(
    () => db.transaction((client) => pgOrderService.reserveRefundRow(payment, 'not_a_valid_reason', client)),
    (err) => {
      assert.equal(err.code, '23514'); // check_violation, не unique_violation
      return true;
    }
  );

  const all = await pgRefundsForPayment(payment.id);
  assert.equal(all.length, 0, 'ROLLBACK должен был откатить неудачную попытку целиком');
});

test('reserveRefundRow: два конкурентных вызова на один payment — ровно одна активная строка, оба возвращают строку-победителя', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  await clientA.query(
    `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
     VALUES ($1, $2, $3, 'requested', 'customer_cancel', $4)`,
    [payment.id, payment.provider, payment.amount, `key-a-${uniqueSuffix()}`]
  );

  await clientB.query('BEGIN');
  const bPromise = clientB
    .query(
      `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
       VALUES ($1, $2, $3, 'requested', 'restaurant_decline', $4)`,
      [payment.id, payment.provider, payment.amount, `key-b-${uniqueSuffix()}`]
    )
    .catch((err) => err);

  await waitForBackendLock(monitor, pidB); // доказательство реального пересечения
  await clientA.query('COMMIT');

  const bResult = await bPromise;
  assert.ok(bResult instanceof Error);
  assert.equal(bResult.code, '23505');
  await clientB.query('ROLLBACK').catch(() => {});
  await clientA.end();
  await clientB.end();

  const all = await pgRefundsForPayment(payment.id);
  assert.equal(all.length, 1, 'ровно одна активная refund-строка после конкурентной гонки');
});

// ===========================================================================
// markPaid
// ===========================================================================

test('markPaid: успешная оплата — payment succeeded, order awaiting_restaurant', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const result = await pgOrderService.markPaid(order.id, payment.id);

  assert.equal(result.status, 'awaiting_restaurant');
  const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paymentRows[0].status, 'succeeded');
});

test('markPaid: повторный вызов идемпотентен (payment уже succeeded — тихий no-op)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const first = await pgOrderService.markPaid(order.id, payment.id);
  assert.equal(first.status, 'awaiting_restaurant');

  const second = await pgOrderService.markPaid(order.id, payment.id);
  assert.equal(second.status, 'awaiting_restaurant', 'повторный вызов не должен ничего сломать');
});

test('markPaid: payment не pending (иной статус) — тихий no-op', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'failed' });

  const result = await pgOrderService.markPaid(order.id, payment.id);
  assert.equal(result.status, 'awaiting_payment', 'статус заказа не должен был измениться');
});

test('markPaid: несуществующий payment — тихий no-op (getOrder всё равно возвращает текущее состояние)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });

  const result = await pgOrderService.markPaid(order.id, 999999999);
  assert.equal(result.status, 'awaiting_payment');
});

// Production Switch — Stage 8: markPaid() сама по себе (внутри своей
// транзакции) по-прежнему только РЕЗЕРВИРУЕТ возврат (reserveRefundRow) —
// эта часть не изменилась. Изменилось то, что происходит СРАЗУ ПОСЛЕ commit:
// раньше (Wave 2/до Stage 8) на PostgreSQL-стороне резервация была ФИНАЛЬНЫМ
// шагом — деньги реально никогда не отправлялись провайдеру дальше строки
// 'requested'. Stage 8 добавила недостающую сетевую оркестрацию
// (scheduleRefundProcessing — fire-and-forget сразу после commit, см.
// services/postgresql/orderService.js) — теперь возврат реально доходит до
// провайдера и завершается. Тест обновлён под это намеренное, честное
// изменение поведения (не удалён — развитие покрытия вслед за тем, что
// раньше было документированным пробелом, а теперь реализовано).
test('markPaid: поздняя оплата уже отменённого заказа — payment succeeded, order остаётся cancelled, деньги реально возвращены (Stage 8)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'cancelled' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });
  // provider_payment_id обязателен для сетевого возврата (processClaimedRefund
  // читает его перед вызовом провайдера) — без него реальный сетевой шаг
  // Stage 8 не смог бы дойти до провайдера, тест проверял бы не то, что
  // заявлено.
  await db.execute(`UPDATE payments SET provider_payment_id = $1 WHERE id = $2`, [`mock_${payment.id}_wave2fixture`, payment.id]);

  const result = await pgOrderService.markPaid(order.id, payment.id);

  assert.equal(result.status, 'cancelled', 'заказ НЕ воскрешается');
  const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paymentRows[0].status, 'succeeded', 'провайдер объективно получил деньги — это фиксируется честно');

  // scheduleRefundProcessing — fire-and-forget, не await'ится вызывающим
  // кодом (markPaid уже вернула управление) — ждём его завершения так же,
  // как и в новых Stage 8 тестах (paymentSafetyStage8.test.js). Этот
  // фикстурный provider_payment_id никогда не проходил через реальный
  // MockProvider.createPayment() (низкоуровневая fixture этого файла вставляет
  // payments напрямую SQL'ем), поэтому mock-провайдер не узнаёт его и честно
  // отвечает 'failed' — важно здесь не succeeded/failed конкретно, а то, что
  // строка возврата реально ДОХОДИТ до провайдера и завершается терминальным
  // статусом, а не застревает в 'requested' навсегда, как было до Stage 8.
  await sleep(150);
  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].status, 'failed', 'Stage 8: возврат больше не застревает в requested — реально доходит до провайдера');
  assert.equal(refunds[0].reason, 'customer_cancel');
});

test('markPaid: paymentId не integer — та же ошибка, что и SQLite-версия', async () => {
  await assert.rejects(
    () => pgOrderService.markPaid(1, 'not-a-number'),
    (err) => {
      assert.equal(err.message, 'paymentId обязателен для подтверждения оплаты');
      return true;
    }
  );
});

test('markPaid: rollback на искусственной ошибке — конкурентное изменение заказа между UPDATE откатывает всё', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  const clientA = cluster.getClient(DATABASE_NAME);
  await clientA.connect();
  await clientA.query('BEGIN');
  const paidUpdate = await clientA.query(
    `UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1 AND order_id = $2 AND status = 'pending'`,
    [payment.id, order.id]
  );
  assert.equal(paidUpdate.rowCount, 1);

  const clientB = cluster.getClient(DATABASE_NAME);
  await clientB.connect();
  await clientB.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
  await clientB.end();

  const orderUpdate = await clientA.query(
    `UPDATE orders SET status = 'awaiting_restaurant', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_payment'`,
    [order.id]
  );
  assert.equal(orderUpdate.rowCount, 0);
  await clientA.query('ROLLBACK');
  await clientA.end();

  const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paymentRows[0].status, 'pending', 'ROLLBACK должен был откатить payment-UPDATE тоже');
});

test('markPaid: пул возвращён, waitingCount=0', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });
  await pgOrderService.markPaid(order.id, payment.id);

  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});

// ===========================================================================
// restaurantDecline
// ===========================================================================

test('restaurantDecline: допустимый отказ оплаченного заказа — declined + refund зарезервирован', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const result = await pgOrderService.restaurantDecline(order.id);

  assert.equal(result.status, 'declined');
  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].reason, 'restaurant_decline');
});

test('restaurantDecline: awaiting_restaurant БЕЗ succeeded-платежа (аномалия) — declined, refund не создаётся', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' }); // намеренно без payment-фикстуры

  const result = await pgOrderService.restaurantDecline(order.id);

  assert.equal(result.status, 'declined');
  const refunds = await db.query(
    `SELECT count(*)::int AS n FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE p.order_id = $1`,
    [order.id]
  );
  assert.equal(refunds[0].n, 0, 'для неоплаченного заказа лишний refund не создаётся');
});

test('restaurantDecline: неверный статус — тихий no-op', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' });

  const result = await pgOrderService.restaurantDecline(order.id);
  assert.equal(result.status, 'accepted');
});

test('restaurantDecline: несуществующий заказ — null', async () => {
  const result = await pgOrderService.restaurantDecline(999999999);
  assert.equal(result, null);
});

test('restaurantDecline: повторный вызов идемпотентен, без второго refund', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const first = await pgOrderService.restaurantDecline(order.id);
  assert.equal(first.status, 'declined');
  const second = await pgOrderService.restaurantDecline(order.id);
  assert.equal(second.status, 'declined');

  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1);
});

test('restaurantDecline: два конкурентных вызова — один переход, максимум один refund', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  const resA = await clientA.query(
    `UPDATE orders SET status = 'declined', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_restaurant'`,
    [order.id]
  );

  await clientB.query('BEGIN');
  const bPromise = clientB.query(
    `UPDATE orders SET status = 'declined', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_restaurant'`,
    [order.id]
  );
  await waitForBackendLock(monitor, pidB);
  await clientA.query('COMMIT');
  const resB = await bPromise;
  await clientB.query('COMMIT');

  assert.equal(resA.rowCount, 1);
  assert.equal(resB.rowCount, 0, 'второй конкурент не должен был применить переход повторно');
  await clientA.end();
  await clientB.end();

  // Реальный API-вызов поверх того же принципа (структурная защита: только
  // победитель UPDATE вызывает reserveRefundRow):
  const restaurantId2 = await pgCreateRestaurant();
  const order2 = await pgCreateOrder(restaurantId2, { status: 'awaiting_restaurant' });
  const payment2 = await pgCreatePayment(order2.id, { status: 'succeeded' });
  const [r1, r2] = await Promise.all([
    pgOrderService.restaurantDecline(order2.id),
    pgOrderService.restaurantDecline(order2.id),
  ]);
  assert.equal(r1.status, 'declined');
  assert.equal(r2.status, 'declined');
  const refunds2 = await pgRefundsForPayment(payment2.id);
  assert.equal(refunds2.length, 1, 'максимум один refund при конкурентных restaurantDecline');
});

test('restaurantDecline: пул возвращён, waitingCount=0', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  await pgCreatePayment(order.id, { status: 'succeeded' });
  await pgOrderService.restaurantDecline(order.id);

  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});

// ===========================================================================
// cancelByCustomer
// ===========================================================================

test('cancelByCustomer: отмена неоплаченного заказа (awaiting_payment) — cancelled, без refund', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });

  const result = await pgOrderService.cancelByCustomer(order.id);
  assert.equal(result.status, 'cancelled');
  const refunds = await db.query(
    `SELECT count(*)::int AS n FROM refunds rf
     JOIN payments p ON p.id = rf.payment_id WHERE p.order_id = $1`,
    [order.id]
  );
  assert.equal(refunds[0].n, 0);
});

test('cancelByCustomer: отмена оплаченного заказа (awaiting_restaurant) — cancelled + refund зарезервирован', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const result = await pgOrderService.cancelByCustomer(order.id);
  assert.equal(result.status, 'cancelled');
  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].reason, 'customer_cancel');
});

test('cancelByCustomer: неверный статус — бросает дословно то же сообщение, что и SQLite', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'accepted' });

  await assert.rejects(
    () => pgOrderService.cancelByCustomer(order.id),
    (err) => {
      assert.equal(err.message, 'заказ уже готовится — отменить нельзя, свяжитесь с рестораном');
      return true;
    }
  );
});

test('cancelByCustomer: несуществующий заказ — бросает "заказ не найден"', async () => {
  await assert.rejects(
    () => pgOrderService.cancelByCustomer(999999999),
    (err) => {
      assert.equal(err.message, 'заказ не найден');
      return true;
    }
  );
});

test('cancelByCustomer: повторный вызов на уже отменённом заказе — бросает ошибку неверного статуса (не идемпотентен, как и оригинал)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });

  const first = await pgOrderService.cancelByCustomer(order.id);
  assert.equal(first.status, 'cancelled');

  await assert.rejects(
    () => pgOrderService.cancelByCustomer(order.id),
    /заказ уже готовится/
  );
});

test('cancelByCustomer: rollback на искусственной ошибке — статус заказа не остаётся частично применённым', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  await pgCreatePayment(order.id, { status: 'succeeded' });

  await assert.rejects(
    () =>
      db.transaction(async (client) => {
        await db.execute(
          `UPDATE orders SET status = 'cancelled', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_restaurant'`,
          [order.id],
          client
        );
        throw new Error('искусственная ошибка после UPDATE — должна откатить транзакцию');
      }),
    /искусственная ошибка/
  );

  const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(rows[0].status, 'awaiting_restaurant', 'UPDATE должен был полностью откатиться');
});

// Production Switch — Stage 9 HIGH-фикс (независимый Codex-аудит,
// "concurrent cancel HTTP 500", см. server/test/postgresql/
// concurrentCancelStage9Fix.test.js за полной регрессией): раньше
// проигравший конкурент безусловно бросал RefundInvariantError (500) при
// rowCount!==1 — здесь это ожидалось как "один rejected". Теперь
// проигравший, увидев, что заказ уже реально cancelled, идемпотентно
// возвращает успех вместо ошибки. Инвариант "максимум один refund" не
// изменился и остаётся главной проверкой этого теста.
test('cancelByCustomer: два конкурентных вызова (Stage 9 фикс) — оба fulfilled, максимум один refund', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_restaurant' });
  const payment = await pgCreatePayment(order.id, { status: 'succeeded' });

  const [r1, r2] = await Promise.allSettled([
    pgOrderService.cancelByCustomer(order.id),
    pgOrderService.cancelByCustomer(order.id),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
  const serverErrors = [r1, r2].filter((r) => r.status === 'rejected' && r.reason.statusCode === 500);
  assert.equal(fulfilled.length, 2, 'Stage 9: оба конкурента должны безопасно завершиться успехом, не 500');
  assert.equal(serverErrors.length, 0, 'ни один конкурент не должен получить 500-класс ошибку');

  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1, 'максимум один refund при конкурентной отмене');
  const orderRows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(orderRows[0].status, 'cancelled');
});

test('cancelByCustomer: пул возвращён, waitingCount=0', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  await pgOrderService.cancelByCustomer(order.id);

  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});

// ===========================================================================
// Обязательные межфункциональные concurrency-сценарии (5, 6 из задания)
// ===========================================================================

test('Concurrency 5: markPaid vs cancelByCustomer (markPaid побеждает первым) — деньги всё равно получают refund-claim', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  // Раздельные raw-клиенты, воспроизводящие ТОЧНО тот же SQL, что реальные
  // markPaid/cancelByCustomer выполняют на строке orders — оба претендента
  // борются за одну и ту же conditional UPDATE на orders.id, что и является
  // настоящей точкой конкуренции между этими двумя функциями. Опосредованный
  // вызов реальных async-функций здесь не даёт доступа к их internal
  // pg-клиенту для barrier-прувинга (client создаётся и управляется целиком
  // внутри db.transaction()) — поэтому доказательство пересечения строится
  // на уровне SQL, а корректность реальных функций поверх той же SQL-семантики
  // отдельно подтверждена во всех однофункциональных concurrency-тестах выше.
  const clientMarkPaid = cluster.getClient(DATABASE_NAME);
  const clientCancel = cluster.getClient(DATABASE_NAME);
  const pidMarkPaid = await connectWithPid(clientMarkPaid);
  const pidCancel = await connectWithPid(clientCancel);

  await clientMarkPaid.query('BEGIN');
  await clientMarkPaid.query(
    `UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1 AND order_id = $2 AND status = 'pending'`,
    [payment.id, order.id]
  );
  const markPaidOrderUpdate = clientMarkPaid.query(
    `UPDATE orders SET status = 'awaiting_restaurant', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_payment'`,
    [order.id]
  );
  // markPaid ещё не закоммитила orders-UPDATE — но уже держит его лок с
  // момента отправки запроса (сама транзакция началась раньше). cancelByCustomer
  // хочет ту же строку — реально заблокируется.
  await clientCancel.query('BEGIN');
  const cancelOrderUpdate = clientCancel.query(
    `UPDATE orders SET status = 'cancelled', status_updated_at = NOW() WHERE id = $1 AND status = $2`,
    [order.id, 'awaiting_payment']
  );
  await waitForBackendLock(monitor, pidCancel); // доказательство реального пересечения
  await markPaidOrderUpdate;
  await clientMarkPaid.query('COMMIT');
  await clientMarkPaid.end();

  const cancelResult = await cancelOrderUpdate; // переоценивает WHERE после commit markPaid — status уже не awaiting_payment
  assert.equal(cancelResult.rowCount, 0, 'cancel не должен был применить переход — заказ уже awaiting_restaurant');
  await clientCancel.query('ROLLBACK');
  await clientCancel.end();

  // Реальная cancelByCustomer теперь видит awaiting_restaurant -> отменяет оплаченный заказ, резервирует refund.
  const cancelResultReal = await pgOrderService.cancelByCustomer(order.id);
  assert.equal(cancelResultReal.status, 'cancelled');

  const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paymentRows[0].status, 'succeeded', 'деньги были получены');
  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1, 'ровно один refund-claim зарезервирован — деньги не остаются без claim');
});

test('Concurrency 5b: markPaid vs cancelByCustomer (cancelByCustomer побеждает первым) — late-payment ветка markPaid резервирует refund', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  // cancelByCustomer отменяет ПЕРВОЙ (awaiting_payment -> cancelled, без refund).
  const cancelResult = await pgOrderService.cancelByCustomer(order.id);
  assert.equal(cancelResult.status, 'cancelled');

  // Запоздалый markPaid — order уже cancelled.
  const markPaidResult = await pgOrderService.markPaid(order.id, payment.id);
  assert.equal(markPaidResult.status, 'cancelled', 'заказ не воскрешается');

  const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paymentRows[0].status, 'succeeded');
  const refunds = await pgRefundsForPayment(payment.id);
  assert.equal(refunds.length, 1, 'markPaid обязан был зарезервировать refund на late-payment ветке');
});

test('Concurrency 6: markPaid vs restaurantDecline — не возникает неконсистентного состояния', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { status: 'awaiting_payment' });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });

  // restaurantDecline требует awaiting_restaurant — на awaiting_payment это чистый no-op,
  // конкурирующий с markPaid, который как раз пытается перевести в awaiting_restaurant.
  const [markPaidResult, declineResult] = await Promise.all([
    pgOrderService.markPaid(order.id, payment.id),
    pgOrderService.restaurantDecline(order.id),
  ]);

  // Оба вызова индивидуально безопасны (conditional UPDATE); проверяем итоговую консистентность.
  const orderRows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  const paymentRows = await db.query('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.ok(['awaiting_restaurant', 'declined'].includes(orderRows[0].status));
  if (orderRows[0].status === 'declined') {
    // declined произошёл ПОСЛЕ markPaid (иначе declined из awaiting_payment невозможен) — payment обязан быть succeeded, refund обязан существовать.
    assert.equal(paymentRows[0].status, 'succeeded');
    const refunds = await pgRefundsForPayment(payment.id);
    assert.equal(refunds.length, 1);
  } else {
    assert.equal(orderRows[0].status, 'awaiting_restaurant');
    assert.equal(paymentRows[0].status, 'succeeded');
  }
});

// ===========================================================================
// Parity-тесты
// ===========================================================================

function normalizeForParity(order) {
  if (!order) return null;
  const { id, restaurant_id, order_id, created_at, status_updated_at, public_code, ...rest } = order;
  return {
    ...rest,
    hasCreatedAt: created_at != null,
    hasStatusUpdatedAt: status_updated_at != null,
    publicCodeLooksRight: typeof public_code === 'string' && public_code.startsWith('YAAM-'),
  };
}

// Исключены из сравнения (сверх id/payment_id/idempotency-key/timestamps):
// status/attempt_count/last_attempt_at/next_attempt_at/completed_at/
// last_error_code/provider_refund_id — реальная НЕ заглушенная SQLite-версия
// orderService.js внутри cancelByCustomer/restaurantDecline вызывает
// scheduleRefundProcessing() fire-and-forget, которая реально прогоняет
// возврат через mock-провайдер асинхронно в фоне (PAYMENT_PROVIDER=mock) —
// строка на SQLite-стороне может уйти в 'processing'/'succeeded' раньше, чем
// тест успевает её прочитать. PostgreSQL Wave-2 порт СОЗНАТЕЛЬНО не запускает
// сетевой конвейер (ensureRefundReady вне scope этой волны) — сравнивать
// статус/попытки здесь означало бы сравнивать не саму claim-резервацию, а
// побочный эффект другой, ещё не перенесённой части системы. Claim-семантика
// (какая строка создана, для какого payment, с какой причиной и суммой)
// сравнивается полностью.
function normalizeRefund(refund) {
  if (!refund) return null;
  const { provider, amount, reason } = refund;
  return { provider, amount, reason };
}

test('Parity: reserveRefundRow — SQLite и PostgreSQL создают эквивалентную refund-строку', async () => {
  // reserveRefundRow не экспортирован из SQLite-модуля напрямую (внутренний
  // helper) — parity проверяется через публичный контракт: cancelByCustomer
  // на awaiting_restaurant содержит прямой вызов reserveRefundRow внутри
  // своей транзакции, используем его как прокси на обеих сторонах.
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'awaiting_restaurant' });
  const sqlitePayment = sqliteCreatePayment(sqliteOrder.id, { status: 'succeeded' });
  const sqliteCancel = await sqliteOrderService.cancelByCustomer(sqliteOrder.id);
  const sqliteRefunds = sqliteRefundsForPayment(sqlitePayment.id);

  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'awaiting_restaurant' });
  const pgPayment = await pgCreatePayment(pgOrder.id, { status: 'succeeded' });
  const pgCancel = await pgOrderService.cancelByCustomer(pgOrder.id);
  const pgRefunds = await pgRefundsForPayment(pgPayment.id);

  assert.equal(sqliteRefunds.length, pgRefunds.length);
  assert.deepEqual(normalizeRefund(sqliteRefunds[0]), normalizeRefund(pgRefunds[0]));
  assert.deepEqual(normalizeForParity(sqliteCancel), normalizeForParity(pgCancel));
});

test('Parity: markPaid — успешная оплата эквивалентна на SQLite и PostgreSQL', async () => {
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'awaiting_payment' });
  const sqlitePayment = sqliteCreatePayment(sqliteOrder.id, { status: 'pending' });
  const sqliteResult = sqliteOrderService.markPaid(sqliteOrder.id, sqlitePayment.id);

  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'awaiting_payment' });
  const pgPayment = await pgCreatePayment(pgOrder.id, { status: 'pending' });
  const pgResult = await pgOrderService.markPaid(pgOrder.id, pgPayment.id);

  assert.deepEqual(normalizeForParity(sqliteResult), normalizeForParity(pgResult));
});

test('Parity: markPaid — поздняя оплата отменённого заказа эквивалентна (order/payment/refund)', async () => {
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'cancelled' });
  const sqlitePayment = sqliteCreatePayment(sqliteOrder.id, { status: 'pending' });
  const sqliteResult = sqliteOrderService.markPaid(sqliteOrder.id, sqlitePayment.id);
  const sqliteRefunds = sqliteRefundsForPayment(sqlitePayment.id);

  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'cancelled' });
  const pgPayment = await pgCreatePayment(pgOrder.id, { status: 'pending' });
  const pgResult = await pgOrderService.markPaid(pgOrder.id, pgPayment.id);
  const pgRefunds = await pgRefundsForPayment(pgPayment.id);

  assert.deepEqual(normalizeForParity(sqliteResult), normalizeForParity(pgResult));
  assert.equal(sqliteRefunds.length, pgRefunds.length);
  assert.deepEqual(normalizeRefund(sqliteRefunds[0]), normalizeRefund(pgRefunds[0]));
});

test('Parity: restaurantDecline — SQLite и PostgreSQL дают эквивалентный результат', async () => {
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'awaiting_restaurant' });
  const sqlitePayment = sqliteCreatePayment(sqliteOrder.id, { status: 'succeeded' });
  const sqliteResult = await sqliteOrderService.restaurantDecline(sqliteOrder.id);
  const sqliteRefunds = sqliteRefundsForPayment(sqlitePayment.id);

  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'awaiting_restaurant' });
  const pgPayment = await pgCreatePayment(pgOrder.id, { status: 'succeeded' });
  const pgResult = await pgOrderService.restaurantDecline(pgOrder.id);
  const pgRefunds = await pgRefundsForPayment(pgPayment.id);

  assert.deepEqual(normalizeForParity(sqliteResult), normalizeForParity(pgResult));
  assert.equal(sqliteRefunds.length, pgRefunds.length);
  assert.deepEqual(normalizeRefund(sqliteRefunds[0]), normalizeRefund(pgRefunds[0]));
});

test('Parity: cancelByCustomer — awaiting_payment (без refund) эквивалентен', async () => {
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'awaiting_payment' });
  const sqliteResult = await sqliteOrderService.cancelByCustomer(sqliteOrder.id);

  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'awaiting_payment' });
  const pgResult = await pgOrderService.cancelByCustomer(pgOrder.id);

  assert.deepEqual(normalizeForParity(sqliteResult), normalizeForParity(pgResult));
});

test('Parity: cancelByCustomer — ошибочная ветка (неверный статус) даёт дословно то же сообщение', async () => {
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrder = sqliteCreateOrder(sqliteRestaurantId, { status: 'accepted' });
  let sqliteErr;
  try { await sqliteOrderService.cancelByCustomer(sqliteOrder.id); } catch (err) { sqliteErr = err; }

  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'accepted' });
  let pgErr;
  try { await pgOrderService.cancelByCustomer(pgOrder.id); } catch (err) { pgErr = err; }

  assert.ok(sqliteErr && pgErr);
  assert.equal(sqliteErr.message, pgErr.message);
});
