'use strict';

// Задача 2 (YAAM-postgresql-embedded-live-validation): реальные integration-
// тесты трёх финансовых PL/pgSQL-триггеров на refunds против настоящего
// embedded PostgreSQL 16.14 — проверяется фактическое runtime-поведение
// (срабатывание триггера при INSERT/UPDATE), а не наличие текста в schema.sql.
//
// Изоляция: один общий кластер + одна база (schema.sql исполняется один раз
// в before), но КАЖДЫЙ тест выполняется в своей собственной транзакции
// (BEGIN в beforeEach, ROLLBACK в afterEach) — фикстуры (restaurant/order/
// payment) создаются внутри той же транзакции и откатываются вместе с ней.
// Провал assertion в одном тесте не может загрязнить следующий: ROLLBACK в
// afterEach выполняется безусловно, независимо от исхода теста.

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_triggers_test';

let cluster;
let client;

before(async () => {
  cluster = await startEmbeddedPostgres('triggers');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
});

after(async () => {
  await cluster.stop();
});

beforeEach(async () => {
  client = cluster.getClient(DATABASE_NAME);
  await client.connect();
  await client.query('BEGIN');
});

afterEach(async () => {
  await client.query('ROLLBACK'); // безусловно — гарантирует изоляцию даже после провала assertion
  await client.end();
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

// Создаёт минимальную цепочку restaurant -> order -> payment внутри текущей
// транзакции теста и возвращает { paymentId, amount }.
async function createFixturePayment(amount = 500) {
  const suffix = uniqueSuffix();
  const { rows: restaurantRows } = await client.query(
    `INSERT INTO restaurants (name, cuisine, cities) VALUES ('Test', 'test', '[]') RETURNING id`
  );
  const restaurantId = restaurantRows[0].id;

  const { rows: orderRows } = await client.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status
     ) VALUES ($1, $2, 'Грозный', 'Test', '+79280000000', 'ул. Тестовая', $3, $4, 'delivered')
     RETURNING id`,
    [`YAAM-TRG-${suffix}`, restaurantId, amount, Math.round(amount * 0.07)]
  );
  const orderId = orderRows[0].id;

  const { rows: paymentRows } = await client.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, 'succeeded') RETURNING id`,
    [orderId, amount]
  );

  return { paymentId: paymentRows[0].id, amount };
}

// PostgreSQL "отравляет" транзакцию после первой ошибки (SQLSTATE 25P02:
// "current transaction is aborted, commands ignored until end of transaction
// block") — все последующие запросы в ТОЙ ЖЕ транзакции проваливаются с этой
// общей ошибкой, а не с содержательным сообщением триггера. Чтобы проверить
// НЕСКОЛЬКО ожидаемо-неудачных операций в одной тестовой транзакции, каждая
// оборачивается в SAVEPOINT/ROLLBACK TO SAVEPOINT — это реальное,
// протестированное-на-практике поведение PostgreSQL, а не выдумка теста.
async function expectRejection(queryFn, matcher, message) {
  await client.query('SAVEPOINT sp_expect_rejection');
  try {
    await assert.rejects(queryFn, matcher, message);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT sp_expect_rejection');
  }
}

async function insertRefund({ paymentId, amount, reason = 'customer_cancel', idempotencyKey }) {
  return client.query(
    `INSERT INTO refunds (payment_id, amount, reason, provider_idempotency_key, status)
     VALUES ($1, $2, $3, $4, 'requested') RETURNING id`,
    [paymentId, amount, reason, idempotencyKey || `refund-key-${uniqueSuffix()}`]
  );
}

test('1. Refund с суммой, равной payment.amount, успешно создаётся', async () => {
  const { paymentId, amount } = await createFixturePayment(500);
  const { rows } = await insertRefund({ paymentId, amount });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].id > 0);
});

test('2. Refund с другой суммой блокируется trg_refunds_amount_matches_payment', async () => {
  const { paymentId, amount } = await createFixturePayment(500);
  await assert.rejects(
    () => insertRefund({ paymentId, amount: amount - 1 }),
    (err) => {
      assert.match(err.message, /refund amount must equal payment amount/);
      assert.equal(err.code, 'P0001'); // default SQLSTATE для RAISE EXCEPTION без явного кода
      return true;
    }
  );
});

test('3. После succeeded-refund новая refund-строка для того же payment_id блокируется', async () => {
  const { paymentId, amount } = await createFixturePayment(700);
  const { rows } = await insertRefund({ paymentId, amount });
  await client.query(`UPDATE refunds SET status = 'succeeded', completed_at = NOW() WHERE id = $1`, [rows[0].id]);

  await assert.rejects(
    () => insertRefund({ paymentId, amount }),
    (err) => {
      assert.match(err.message, /payment already successfully refunded/);
      assert.equal(err.code, 'P0001');
      return true;
    }
  );
});

test('4. Нельзя изменить payment_id/amount/provider/reason/provider_idempotency_key', async () => {
  const { paymentId, amount } = await createFixturePayment(300);
  const { rows } = await insertRefund({ paymentId, amount });
  const refundId = rows[0].id;

  const otherPayment = await createFixturePayment(300);

  const protectedUpdates = [
    { sql: 'UPDATE refunds SET payment_id = $2 WHERE id = $1', params: [refundId, otherPayment.paymentId] },
    { sql: 'UPDATE refunds SET amount = $2 WHERE id = $1', params: [refundId, amount + 1] },
    { sql: "UPDATE refunds SET provider = $2 WHERE id = $1", params: [refundId, 'yookassa'] },
    { sql: "UPDATE refunds SET reason = $2 WHERE id = $1", params: [refundId, 'restaurant_decline'] },
    { sql: 'UPDATE refunds SET provider_idempotency_key = $2 WHERE id = $1', params: [refundId, `changed-${uniqueSuffix()}`] },
  ];

  for (const { sql, params } of protectedUpdates) {
    await expectRejection(
      () => client.query(sql, params),
      (err) => {
        assert.match(err.message, /immutable/);
        assert.equal(err.code, 'P0001');
        return true;
      },
      `ожидали блокировку для: ${sql}`
    );
  }

  // После всех попыток строка осталась полностью неизменной.
  const { rows: finalRows } = await client.query('SELECT * FROM refunds WHERE id = $1', [refundId]);
  assert.equal(finalRows[0].payment_id, paymentId);
  assert.equal(finalRows[0].amount, amount);
  assert.equal(finalRows[0].provider, 'mock');
  assert.equal(finalRows[0].reason, 'customer_cancel');
});

test('5. Можно изменить разрешённые поля: status/provider_refund_id/last_error_code/completed_at/updated_at', async () => {
  const { paymentId, amount } = await createFixturePayment(450);
  const { rows } = await insertRefund({ paymentId, amount });
  const refundId = rows[0].id;

  await client.query(
    `UPDATE refunds
     SET status = 'failed',
         provider_refund_id = $2,
         last_error_code = 'provider_failed',
         last_error_message_safe = 'test failure',
         updated_at = NOW()
     WHERE id = $1`,
    [refundId, 'ext-ref-123']
  );

  const { rows: after1 } = await client.query('SELECT * FROM refunds WHERE id = $1', [refundId]);
  assert.equal(after1[0].status, 'failed');
  assert.equal(after1[0].provider_refund_id, 'ext-ref-123');
  assert.equal(after1[0].last_error_code, 'provider_failed');

  // completed_at — отдельно, при переходе в терминальный успешный статус
  await client.query(`UPDATE refunds SET status = 'succeeded', completed_at = NOW() WHERE id = $1`, [refundId]);
  const { rows: after2 } = await client.query('SELECT status, completed_at FROM refunds WHERE id = $1', [refundId]);
  assert.equal(after2[0].status, 'succeeded');
  assert.ok(after2[0].completed_at instanceof Date);
});

test('6. Сообщения об ошибках триггеров соответствуют ожидаемому смыслу (не общая ошибка)', async () => {
  const { paymentId, amount } = await createFixturePayment(200);

  await expectRejection(
    () => insertRefund({ paymentId, amount: amount + 50 }),
    /full-refund-only for MVP/
  );

  const { rows } = await insertRefund({ paymentId, amount });
  await client.query(`UPDATE refunds SET status = 'succeeded', completed_at = NOW() WHERE id = $1`, [rows[0].id]);
  await expectRejection(
    () => insertRefund({ paymentId, amount }),
    /payment already successfully refunded/
  );

  await expectRejection(
    () => client.query('UPDATE refunds SET amount = $2 WHERE id = $1', [rows[0].id, amount + 1]),
    /payment_id\/amount\/provider\/reason\/provider_idempotency_key are immutable/
  );
});

test('7-8. Изоляция: предыдущий (провалившийся по amount) сценарий не оставил следов в этой транзакции', async () => {
  // Эта фикстура создаёт СВОЙ собственный payment — если бы предыдущий тест
  // (сценарий 2, ожидаемо провалившийся INSERT) протёк в общую БД, эта
  // проверка бы либо получила лишние строки, либо конфликт уникальности.
  const { paymentId, amount } = await createFixturePayment(999);
  const { rows: existingRefunds } = await client.query(
    'SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1',
    [paymentId]
  );
  assert.equal(existingRefunds[0].n, 0, 'новый payment в свежей транзакции не должен иметь refund-строк');

  const { rows } = await insertRefund({ paymentId, amount });
  assert.equal(rows.length, 1);
});
