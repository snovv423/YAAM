'use strict';

// YAAM-postgresql-concurrency-strategy.pdf, Задача 2 — 12 обязательных
// concurrency-сценариев против настоящего embedded PostgreSQL 16.14.
//
// Каждый сценарий с ожидаемой блокировкой доказывает реальное пересечение
// через waitForBackendLock() (опрос pg_stat_activity со стороннего
// клиента-наблюдателя) — НЕ полагается на Promise.all и надежду на
// планировщик. Операции максимально близки к реальным инвариантам YAAM:
// таблицы orders/payments/refunds/restaurants из server/db/postgresql/
// schema.sql, те же partial UNIQUE indexes и тот же паттерн conditional
// UPDATE, что использует orderService.js сегодня на SQLite.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep, waitForBackendLock, connectWithPid } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_concurrency_test';

let cluster;
let db; // server/db/postgresql/index.js — требуется после установки DATABASE_URL
let monitor; // отдельный raw-клиент только для наблюдения за pg_stat_activity

before(async () => {
  cluster = await startEmbeddedPostgres('concurrency');
  await cluster.createDatabase(DATABASE_NAME);

  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');

  monitor = cluster.getClient(DATABASE_NAME);
  await monitor.connect();
});

after(async () => {
  await monitor.end();
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function createFixtureRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, rating, rating_count) VALUES ('Test', 'test', '[]', 0, 0) RETURNING id`
  );
  return rows[0].id;
}

async function createFixtureOrder(restaurantId, status = 'awaiting_restaurant') {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status
     ) VALUES ($1, $2, 'Грозный', 'Test', '+79280000000', 'ул. Тестовая', 500, 35, $3)
     RETURNING id`,
    [`YAAM-CC-${suffix}`, restaurantId, status]
  );
  return rows[0].id;
}

async function createFixturePayment(orderId, { amount = 500, status = 'succeeded' } = {}) {
  const rows = await db.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3) RETURNING id`,
    [orderId, amount, status]
  );
  return rows[0].id;
}

async function createFixtureRefund(paymentId, { amount = 500, status = 'requested', reason = 'customer_cancel' } = {}) {
  const rows = await db.query(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [paymentId, amount, status, reason, `refund-key-${uniqueSuffix()}`]
  );
  return rows[0].id;
}

// ===========================================================================
// 1. Две одновременные попытки создать активный payment для одного order
// ===========================================================================
test('1. Два конкурентных активных payment на один order — успешна ровно одна попытка', async () => {
  const restaurantId = await createFixtureRestaurant();
  const orderId = await createFixtureOrder(restaurantId, 'awaiting_payment');

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  await clientA.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, 500, 'creating')`,
    [orderId]
  );
  // A держит незакоммиченную строку, конфликтующую с partial unique index
  // ux_payments_one_active_per_order — теперь INSERT от B должен реально
  // заблокироваться на ней (PostgreSQL ждёт исход A, чтобы решить, есть ли
  // конфликт), а не просто "случайно" не пересечься по времени.
  await clientB.query('BEGIN');
  const bPromise = clientB
    .query(`INSERT INTO payments (order_id, amount, status) VALUES ($1, 500, 'creating')`, [orderId])
    .catch((err) => err);

  await waitForBackendLock(monitor, pidB); // ДОКАЗАТЕЛЬСТВО реального пересечения
  await clientA.query('COMMIT');

  const bResult = await bPromise;
  assert.ok(bResult instanceof Error, 'вторая попытка должна получить ошибку конфликта');
  assert.equal(bResult.code, '23505', 'конфликт должен быть unique_violation от partial unique index');
  await clientB.query('ROLLBACK').catch(() => {});

  const rows = await db.query(
    `SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status IN ('creating','pending')`,
    [orderId]
  );
  assert.equal(rows[0].n, 1, 'в БД должна остаться ровно одна активная строка payment');

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// 2. Две одновременные попытки создать активный refund для одного payment
// ===========================================================================
test('2. Два конкурентных активных refund на один payment — успешна ровно одна попытка', async () => {
  const restaurantId = await createFixtureRestaurant();
  const orderId = await createFixtureOrder(restaurantId);
  const paymentId = await createFixturePayment(orderId);

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  await clientA.query(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key)
     VALUES ($1, 500, 'requested', 'customer_cancel', $2)`,
    [paymentId, `key-a-${uniqueSuffix()}`]
  );

  await clientB.query('BEGIN');
  const bPromise = clientB
    .query(
      `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key)
       VALUES ($1, 500, 'requested', 'customer_cancel', $2)`,
      [paymentId, `key-b-${uniqueSuffix()}`]
    )
    .catch((err) => err);

  await waitForBackendLock(monitor, pidB);
  await clientA.query('COMMIT');

  const bResult = await bPromise;
  assert.ok(bResult instanceof Error);
  assert.equal(bResult.code, '23505');
  await clientB.query('ROLLBACK').catch(() => {});

  const rows = await db.query(
    `SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1 AND status IN ('requested','processing')`,
    [paymentId]
  );
  assert.equal(rows[0].n, 1, 'в БД должна остаться ровно одна активная строка refund');

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// 3. Две одновременные попытки перевести refund в succeeded для одного payment
// ===========================================================================
test('3. Два конкурентных succeeded-refund на один payment — инвариант БД сохраняется', async () => {
  const restaurantId = await createFixtureRestaurant();
  const orderId = await createFixtureOrder(restaurantId);
  const paymentId = await createFixturePayment(orderId);
  // ux_refunds_one_active_per_payment уже не позволяет существовать ДВУМ
  // одновременно processing-строкам для одного payment — значит гонка "два
  // succeeded для одного payment" в реальности всегда происходит на ОДНОЙ и
  // той же строке: два конкурентных вызова finalizeRefundSucceeded() для
  // одного и того же refund.id (например, webhook продублирован сетью, либо
  // sweep и webhook пересеклись). Именно этот паттерн — WHERE id=? AND
  // status='processing' — и есть реальный код finalizeRefundSucceeded().
  const refundId = await createFixtureRefund(paymentId, { status: 'processing' });

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  const finalizeSucceeded = (client, id) =>
    client.query(
      `UPDATE refunds SET status = 'succeeded', completed_at = NOW() WHERE id = $1 AND status = 'processing'`,
      [id]
    );

  await clientA.query('BEGIN');
  const resA = await finalizeSucceeded(clientA, refundId);

  await clientB.query('BEGIN');
  const bPromise = finalizeSucceeded(clientB, refundId);

  await waitForBackendLock(monitor, pidB); // ДОКАЗАТЕЛЬСТВО: B реально ждёт строку, занятую A
  await clientA.query('COMMIT');

  const resB = await bPromise; // после commit A, B переоценивает WHERE status='processing' — уже не так
  await clientB.query('COMMIT');

  assert.equal(resA.rowCount, 1, 'A первой финализирует возврат');
  assert.equal(resB.rowCount, 0, 'B не должна повторно финализировать уже succeeded возврат — conditional UPDATE её не пропускает');

  const rows = await db.query(
    `SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1 AND status = 'succeeded'`,
    [paymentId]
  );
  assert.equal(rows[0].n, 1, 'нельзя получить два succeeded refund для одного payment');

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// 4. Atomic status transition: UPDATE ... WHERE id=? AND status=expected
// ===========================================================================
test('4. Conditional UPDATE: ровно один клиент получает rowCount=1, второй rowCount=0, lost update отсутствует', async () => {
  const restaurantId = await createFixtureRestaurant();
  const orderId = await createFixtureOrder(restaurantId, 'awaiting_restaurant');

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  const resA = await clientA.query(
    `UPDATE orders SET status = 'accepted', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_restaurant'`,
    [orderId]
  );

  await clientB.query('BEGIN');
  const bPromise = clientB.query(
    `UPDATE orders SET status = 'declined', status_updated_at = NOW() WHERE id = $1 AND status = 'awaiting_restaurant'`,
    [orderId]
  );

  await waitForBackendLock(monitor, pidB); // B реально заблокирован на строке, которую держит A
  await clientA.query('COMMIT');

  const resB = await bPromise; // после COMMIT A, B переоценивает WHERE (EvalPlanQual) и не находит совпадения
  await clientB.query('COMMIT');

  assert.equal(resA.rowCount, 1, 'A выполнила переход первой');
  assert.equal(resB.rowCount, 0, 'B не должна была применить переход — статус уже не awaiting_restaurant');

  const rows = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(rows[0].status, 'accepted', 'финальный статус — от победившей транзакции A, потерянного обновления нет');

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// Общий сетап для сценариев 5/6/7: агрегат рейтинга ресторана — РЕАЛЬНЫЙ
// read-modify-write БЕЗ conditional-UPDATE-эквивалента (см. rateOrder() в
// orderService.js) — находка аудита: под SQLite это безопасно только из-за
// синхронности; под PostgreSQL требует SELECT ... FOR UPDATE.
// ===========================================================================

async function beginLockingRead(client, restaurantId) {
  await client.query('BEGIN');
  const { rows } = await client.query(
    'SELECT rating, rating_count FROM restaurants WHERE id = $1 FOR UPDATE',
    [restaurantId]
  );
  return rows[0];
}

function nextRating(current, incomingRating) {
  const newCount = current.rating_count + 1;
  const newRating = (Number(current.rating) * current.rating_count + incomingRating) / newCount;
  return { rating: Math.round(newRating * 10) / 10, rating_count: newCount };
}

// ===========================================================================
// 5. Read-modify-write под SELECT ... FOR UPDATE — второй клиент реально ждёт
// ===========================================================================
test('5. SELECT ... FOR UPDATE: второй клиент реально ждёт освобождения строки, lost update отсутствует', async () => {
  const restaurantId = await createFixtureRestaurant();

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  const currentA = await beginLockingRead(clientA, restaurantId); // A держит row lock

  await clientB.query('BEGIN');
  const bLockPromise = clientB.query(
    'SELECT rating, rating_count FROM restaurants WHERE id = $1 FOR UPDATE',
    [restaurantId]
  );
  await waitForBackendLock(monitor, pidB); // ДОКАЗАТЕЛЬСТВО: B реально заблокирован на строке A

  const nextA = nextRating(currentA, 5);
  await clientA.query('UPDATE restaurants SET rating = $1, rating_count = $2 WHERE id = $3', [
    nextA.rating, nextA.rating_count, restaurantId,
  ]);
  await clientA.query('COMMIT');

  const bLockResult = await bLockPromise; // разблокировался ПОСЛЕ commit A, видит уже новые значения
  const currentB = bLockResult.rows[0];
  assert.equal(Number(currentB.rating_count), 1, 'B должен увидеть committed-результат A (rating_count=1), не устаревшее значение 0');

  const nextB = nextRating(currentB, 3);
  await clientB.query('UPDATE restaurants SET rating = $1, rating_count = $2 WHERE id = $3', [
    nextB.rating, nextB.rating_count, restaurantId,
  ]);
  await clientB.query('COMMIT');

  const rows = await db.query('SELECT rating, rating_count FROM restaurants WHERE id = $1', [restaurantId]);
  assert.equal(Number(rows[0].rating_count), 2, 'обе оценки должны быть учтены — lost update отсутствует');
  assert.equal(Number(rows[0].rating), 4, '(5+3)/2 = 4');

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// 6. Rollback: заблокированная строка после rollback остаётся корректной,
//    ожидающий клиент продолжает работу с исходными (не изменёнными) данными
// ===========================================================================
test('6. Rollback первой транзакции: второй клиент разблокируется и видит исходные (не применённые) данные', async () => {
  const restaurantId = await createFixtureRestaurant();

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  const currentA = await beginLockingRead(clientA, restaurantId);
  assert.equal(Number(currentA.rating_count), 0);

  await clientB.query('BEGIN');
  const bLockPromise = clientB.query(
    'SELECT rating, rating_count FROM restaurants WHERE id = $1 FOR UPDATE',
    [restaurantId]
  );
  await waitForBackendLock(monitor, pidB);

  // A вычисляет новое значение, но передумывает и откатывает — как если бы
  // внутри транзакции произошла ошибка ДО commit.
  await clientA.query('UPDATE restaurants SET rating = 5, rating_count = 1 WHERE id = $1', [restaurantId]);
  await clientA.query('ROLLBACK');

  const bLockResult = await bLockPromise;
  const currentB = bLockResult.rows[0];
  assert.equal(Number(currentB.rating_count), 0, 'после ROLLBACK A строка должна остаться в исходном состоянии — B видит rating_count=0, не 1');
  assert.equal(Number(currentB.rating), 0);

  const nextB = nextRating(currentB, 4);
  await clientB.query('UPDATE restaurants SET rating = $1, rating_count = $2 WHERE id = $3', [
    nextB.rating, nextB.rating_count, restaurantId,
  ]);
  await clientB.query('COMMIT');

  const rows = await db.query('SELECT rating, rating_count FROM restaurants WHERE id = $1', [restaurantId]);
  assert.equal(Number(rows[0].rating_count), 1, 'только вклад B должен быть применён — вклад откаченной A отсутствует');
  assert.equal(Number(rows[0].rating), 4);

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// 7. Commit: ожидающий клиент видит состояние ПОСЛЕ commit и не нарушает инвариант
// ===========================================================================
test('7. Commit первой транзакции: второй клиент видит committed-состояние, а не устаревший снимок', async () => {
  const restaurantId = await createFixtureRestaurant();

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  const currentA = await beginLockingRead(clientA, restaurantId);

  await clientB.query('BEGIN');
  // B держит СВОЙ снимок (rating_count=0), взятый ДО begin FOR UPDATE-запроса —
  // проверяем, что после разблокировки B видит именно committed-данные A через
  // СВОЙ FOR UPDATE-запрос, а не через этот более ранний снимок.
  const staleSnapshotBeforeLock = { rating: 0, rating_count: 0 };

  const bLockPromise = clientB.query(
    'SELECT rating, rating_count FROM restaurants WHERE id = $1 FOR UPDATE',
    [restaurantId]
  );
  await waitForBackendLock(monitor, pidB);

  const nextA = nextRating(currentA, 2);
  await clientA.query('UPDATE restaurants SET rating = $1, rating_count = $2 WHERE id = $3', [
    nextA.rating, nextA.rating_count, restaurantId,
  ]);
  await clientA.query('COMMIT');

  const bLockResult = await bLockPromise;
  const currentB = bLockResult.rows[0];
  assert.notDeepEqual(
    { rating: Number(currentB.rating), rating_count: Number(currentB.rating_count) },
    staleSnapshotBeforeLock,
    'B обязан увидеть committed-изменение A через свой FOR UPDATE, а не устаревший снимок'
  );
  assert.equal(Number(currentB.rating_count), 1);

  await clientA.end();
  await clientB.end();
});

// ===========================================================================
// 8. Deadlock: обратный порядок блокировок -> 40P01; deterministic ordering
//    как альтернатива, которая полностью его исключает
// ===========================================================================
test('8a. Обратный порядок блокировок двух строк даёт настоящий deadlock (SQLSTATE 40P01)', async () => {
  const r1 = await createFixtureRestaurant();
  const r2 = await createFixtureRestaurant();

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  await clientA.connect();
  await clientB.connect();
  // Быстрый deadlock_timeout — тест не должен ждать default 1s дольше необходимого.
  await clientA.query("SET deadlock_timeout = '200ms'");
  await clientB.query("SET deadlock_timeout = '200ms'");

  await clientA.query('BEGIN');
  await clientB.query('BEGIN');

  // A блокирует r1, B блокирует r2 — оба успешно, конфликта пока нет.
  await clientA.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r1]);
  await clientB.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r2]);

  // Теперь A хочет r2 (держит B), B хочет r1 (держит A) — циклическое ожидание.
  const aPromise = clientA
    .query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r2])
    .then((r) => ({ ok: true, r }))
    .catch((err) => ({ ok: false, err }));
  const bPromise = clientB
    .query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r1])
    .then((r) => ({ ok: true, r }))
    .catch((err) => ({ ok: false, err }));

  const [resultA, resultB] = await Promise.all([aPromise, bPromise]);
  const outcomes = [resultA, resultB];
  const failed = outcomes.filter((o) => !o.ok);
  const succeeded = outcomes.filter((o) => o.ok);

  assert.equal(failed.length, 1, 'ровно одна сторона должна быть выбрана жертвой deadlock-детектора');
  assert.equal(succeeded.length, 1, 'вторая сторона должна благополучно продолжить работу');
  assert.equal(failed[0].err.code, '40P01', 'PostgreSQL обязан сообщить именно deadlock_detected');

  await clientA.query('ROLLBACK').catch(() => {});
  await clientB.query('ROLLBACK').catch(() => {});
  await clientA.end();
  await clientB.end();
});

test('8b. Детерминированный порядок блокировок (всегда id по возрастанию) исключает deadlock', async () => {
  const r1 = await createFixtureRestaurant();
  const r2 = await createFixtureRestaurant();
  const [lo, hi] = r1 < r2 ? [r1, r2] : [r2, r1];

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  await clientA.connect();
  await clientB.connect();

  async function touchBothInOrder(client) {
    await client.query('BEGIN');
    await client.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [lo]);
    await client.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [hi]);
    await client.query('COMMIT');
  }

  // Оба клиента следуют ОДНОМУ и тому же порядку (lo -> hi) — один просто
  // ждёт своей очереди на lo, никакого цикла ожидания образоваться не может.
  const start = Date.now();
  await Promise.all([touchBothInOrder(clientA), touchBothInOrder(clientB)]);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 5000, `обе транзакции должны завершиться быстро без deadlock (заняло ${elapsedMs}мс)`);

  const rows = await db.query('SELECT rating_count FROM restaurants WHERE id = $1', [lo]);
  assert.equal(rows[0].rating_count, 2, 'обе транзакции должны были успешно примениться');

  await clientA.end();
  await clientB.end();
});

test('8c. transaction() с retry на 40001/40P01 самовосстанавливается после deadlock-жертвы', async () => {
  const r1 = await createFixtureRestaurant();
  const r2 = await createFixtureRestaurant();

  const adversary = cluster.getClient(DATABASE_NAME);
  await adversary.connect();
  await adversary.query("SET deadlock_timeout = '200ms'");
  await adversary.query('BEGIN');
  await adversary.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r2]);

  let attempts = 0;
  let adversaryOutcome = null;

  const result = await db.transaction(
    async (client, { attempt }) => {
      attempts = attempt;
      await client.query("SET deadlock_timeout = '200ms'");
      await client.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r1]);
      if (attempt === 1) {
        // На первой попытке намеренно создаём цикл ожидания с adversary —
        // adversary держит r2 и сейчас попытается взять r1 (который держит
        // наша transaction()), а наша попытка одновременно хочет r2.
        // .then/.catch навешаны СРАЗУ — этот промис никогда не станет
        // источником unhandled rejection независимо от того, что произойдёт
        // с нашей стороной ниже (мы или adversary — кто-то один обязательно
        // станет жертвой PostgreSQL-детектора дедлоков).
        const adversaryWantsR1 = adversary
          .query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r1])
          .then(() => ({ ok: true }))
          .catch((err) => ({ ok: false, err }));
        await sleep(50); // даём adversary время реально дойти до ожидания r1
        // Если ИМЕННО эта сторона станет жертвой — следующая строка бросит
        // 40P01, adversaryWantsR1 останется неawait'нутым в этой попытке
        // (это безопасно — у него уже есть .catch), transaction() поймает
        // ошибку и по retry-политике перезапустит fn с чистого листа.
        await client.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [r2]);
        // Мы не стали жертвой — adversary либо тоже прошёл (после того как
        // наш commit снял конфликт), либо был выбран жертвой сам.
        adversaryOutcome = await adversaryWantsR1;
      }
      return 'ok';
    },
    { retry: { maxAttempts: 3, retryOn: new Set(['40001', '40P01']) } }
  ).catch((err) => err);

  await adversary.query('ROLLBACK').catch(() => {});
  await adversary.end();

  // Либо наша сторона стала жертвой на попытке 1 и retry её восстановил
  // (attempts >= 2, результат 'ok'), либо жертвой стал adversary
  // (adversaryOutcome.ok === false), а наша сторона прошла с первого раза —
  // оба исхода доказывают, что retry-путь работает корректно и не остаётся в
  // противоречивом состоянии.
  assert.notEqual(result instanceof Error, true, `transaction() с retry не должен был исчерпаться: ${result && result.message}`);
  assert.equal(result, 'ok');
  if (attempts === 1) {
    assert.ok(adversaryOutcome, 'если наша сторона прошла с первой попытки, adversary должен был получить исход (успех или 40P01)');
  }
});

// ===========================================================================
// 9. Serializable conflict: настоящий 40001, ограниченный retry восстанавливает
// ===========================================================================
test('9. SERIALIZABLE: настоящий serialization failure (40001), retry восстанавливает результат', async () => {
  const restaurantId = await createFixtureRestaurant();
  let fnCalls = 0;

  const result = await db.serializableTransaction(
    async (client, { attempt }) => {
      fnCalls += 1;
      const { rows } = await client.query('SELECT rating_count FROM restaurants WHERE id = $1', [restaurantId]);
      if (attempt === 1) {
        // Реальный конкурирующий commit МЕЖДУ нашим чтением и нашей записью —
        // classic recipe для serialization_failure под SERIALIZABLE.
        const adversary = cluster.getClient(DATABASE_NAME);
        await adversary.connect();
        await adversary.query('BEGIN');
        await adversary.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [restaurantId]);
        await adversary.query('COMMIT');
        await adversary.end();
      }
      await client.query('UPDATE restaurants SET rating_count = $1 WHERE id = $2', [rows[0].rating_count + 1, restaurantId]);
      return attempt;
    },
    { retry: { maxAttempts: 3 } }
  );

  assert.ok(fnCalls >= 2, `callback должен был быть вызван повторно после конфликта (fnCalls=${fnCalls})`);
  assert.ok(fnCalls <= 3, 'callback не должен вызываться бесконечно — не больше maxAttempts');
  assert.equal(result, fnCalls, 'финальная попытка должна была завершиться успехом');
});

// ===========================================================================
// 10. Exhausted retry: после максимума попыток исходная ошибка пробрасывается
// ===========================================================================
test('10. Исчерпанный retry: после maxAttempts исходная 40001 пробрасывается, клиент возвращён в пул', async () => {
  const restaurantId = await createFixtureRestaurant();
  const poolBefore = db.getPool();
  const before1 = { total: poolBefore.totalCount, idle: poolBefore.idleCount };

  let fnCalls = 0;
  const maxAttempts = 3;

  await assert.rejects(
    () =>
      db.serializableTransaction(
        async (client) => {
          fnCalls += 1;
          const { rows } = await client.query('SELECT rating_count FROM restaurants WHERE id = $1', [restaurantId]);
          // На КАЖДОЙ попытке — реальный конкурирующий commit, конфликт
          // гарантированно повторяется, retry не может восстановиться никогда.
          const adversary = cluster.getClient(DATABASE_NAME);
          await adversary.connect();
          await adversary.query('BEGIN');
          await adversary.query('UPDATE restaurants SET rating_count = rating_count + 1 WHERE id = $1', [restaurantId]);
          await adversary.query('COMMIT');
          await adversary.end();
          await client.query('UPDATE restaurants SET rating_count = $1 WHERE id = $2', [rows[0].rating_count + 1, restaurantId]);
        },
        { retry: { maxAttempts } }
      ),
    (err) => {
      assert.equal(err.code, '40001', 'наружу должна выйти исходная ошибка последней попытки, не обёртка');
      return true;
    }
  );

  assert.equal(fnCalls, maxAttempts, `callback должен был быть вызван ровно ${maxAttempts} раз, не больше и не меньше`);

  // Небольшая пауза — pool.release() происходит в микротаске rollbackTransaction,
  // даём event loop её обработать перед проверкой состояния пула.
  await sleep(20);
  const poolAfter = db.getPool();
  const after1 = { total: poolAfter.totalCount, idle: poolAfter.idleCount, waiting: poolAfter.waitingCount };
  assert.equal(after1.waiting, 0, 'не должно быть зависших запросов на клиента');
  assert.equal(after1.total, after1.idle, 'клиент из исчерпанной retry-транзакции должен быть возвращён в пул');
});

// ===========================================================================
// 11. Non-retryable error: 23505 не ретраится, callback вызывается один раз
// ===========================================================================
test('11. Non-retryable 23505: не повторяется даже при включённом retry, callback вызван один раз', async () => {
  const restaurantId = await createFixtureRestaurant();
  const orderId = await createFixtureOrder(restaurantId);
  const paymentId = await createFixturePayment(orderId);
  const idempotencyKey = `non-retry-${uniqueSuffix()}`;
  await db.execute(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key)
     VALUES ($1, 500, 'requested', 'customer_cancel', $2)`,
    [paymentId, idempotencyKey]
  );

  let fnCalls = 0;
  await assert.rejects(
    () =>
      db.transaction(
        async (client) => {
          fnCalls += 1;
          // Тот же provider_idempotency_key ещё раз — UNIQUE-нарушение,
          // не имеет отношения к транзиентной гонке.
          await client.query(
            `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key)
             VALUES ($1, 500, 'requested', 'customer_cancel', $2)`,
            [paymentId, idempotencyKey]
          );
        },
        { retry: { maxAttempts: 5 } } // retry ВКЛЮЧЁН, но 23505 не входит в retryOn по умолчанию
      ),
    (err) => {
      assert.equal(err.code, '23505');
      return true;
    }
  );
  assert.equal(fnCalls, 1, '23505 не ретраится — callback должен был выполниться ровно один раз');
});

// ===========================================================================
// 12. Lock timeout: тест завершается предсказуемо, не висит бесконечно
// ===========================================================================
test('12. lockTimeoutMs: заблокированный SELECT ... FOR UPDATE завершается предсказуемой ошибкой, а не зависает', async () => {
  const restaurantId = await createFixtureRestaurant();

  const holder = cluster.getClient(DATABASE_NAME);
  const holderPid = await connectWithPid(holder);
  await holder.query('BEGIN');
  await holder.query('SELECT * FROM restaurants WHERE id = $1 FOR UPDATE', [restaurantId]);
  // holder НЕ коммитит и НЕ роллбэкает — держит блокировку "вечно" (в рамках теста).

  const start = Date.now();
  await assert.rejects(
    () =>
      db.transaction(
        async (client) => {
          await client.query('SELECT * FROM restaurants WHERE id = $1 FOR UPDATE', [restaurantId]);
        },
        { lockTimeoutMs: 300 }
      ),
    (err) => {
      assert.equal(err.code, '55P03', 'ожидаем lock_not_available, а не зависание');
      return true;
    }
  );
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 3000, `должно было завершиться быстро благодаря lock_timeout (заняло ${elapsedMs}мс)`);
  assert.ok(elapsedMs >= 280, `не должно было завершиться РАНЬШЕ настроенного lock_timeout (заняло ${elapsedMs}мс)`);

  await holder.query('ROLLBACK');
  await holder.end();

  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.total ?? pool.totalCount, pool.idleCount, 'клиент из timeout-транзакции должен быть возвращён в пул, транзакция не висит');
});
