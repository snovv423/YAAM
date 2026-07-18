'use strict';

// YAAM PostgreSQL Order Service — Wave 7 (финальная SQL-side волна):
// integration-тесты для claimRefundForProcessing (claim-половина
// ensureRefundReady, server/services/postgresql/orderService.js) против
// настоящего embedded PostgreSQL 16.14.
//
// Реализует Вариант D ("lease-guarded conditional UPDATE"), согласованный в
// YAAM-ensure-refund-ready-architecture-review.pdf: claim разрешён из
// status='requested' ИЛИ из status='processing' с истёкшим/отсутствующим
// next_attempt_at (lease). Буквальный "WHERE status IN ('requested',
// 'processing')" БЕЗ учёта next_attempt_at был строго опровергнут в этом
// разборе — допускает двойной сетевой вызов для живой processing-попытки.
//
// Сетевой оркестратор ensureRefundReady() (реальный вызов провайдера) НЕ
// переносится в этой волне — тестируется исключительно claim-шаг, без сети,
// тем же принципом, что и все claim-функции волн 1-6.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { waitForBackendLock, connectWithPid } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_orderservice_wave7_test';

let cluster;
let db;
let pgOrderService;
let monitor;

before(async () => {
  cluster = await startEmbeddedPostgres('orderservice-wave7');
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

function idempotencyKey() {
  return `refund-key-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function pgCreateRestaurant() {
  const rows = await db.query(`INSERT INTO restaurants (name, cuisine, cities) VALUES ('Test', 'test', '[]') RETURNING id`);
  return rows[0].id;
}

async function pgCreatePaidOrder(restaurantId) {
  const suffix = uniqueSuffix();
  const orderRows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, 'awaiting_restaurant')
     RETURNING id`,
    [`YAAM-W7-${suffix}`, restaurantId]
  );
  const orderId = orderRows[0].id;
  const paymentRows = await db.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, 500, 'succeeded') RETURNING id`,
    [orderId]
  );
  return { orderId, paymentId: paymentRows[0].id };
}

// Полный контроль над полями refund-строки — обходит бизнес-логику
// (reserveRefundRow), нужен для точной настройки claim-сценариев (лизинг,
// attempt_count, произвольные терминальные состояния).
async function pgCreateRefund(paymentId, {
  status = 'requested', attemptCount = 0, lastAttemptAt = null, nextAttemptAt = null,
  key = idempotencyKey(), providerRefundId = null, lastErrorCode = null,
} = {}) {
  const rows = await db.query(
    `INSERT INTO refunds (
       payment_id, provider, amount, status, reason, provider_idempotency_key,
       attempt_count, last_attempt_at, next_attempt_at, provider_refund_id, last_error_code
     ) VALUES ($1, 'mock', 500, $2, 'customer_cancel', $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [paymentId, status, key, attemptCount, lastAttemptAt, nextAttemptAt, providerRefundId, lastErrorCode]
  );
  return rows[0];
}

async function pgRefundRow(refundId) {
  const rows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId]);
  return rows[0];
}

async function makeRequestedRefund() {
  const restaurantId = await pgCreateRestaurant();
  const { paymentId } = await pgCreatePaidOrder(restaurantId);
  return pgCreateRefund(paymentId, { status: 'requested' });
}

async function makeProcessingRefund({ nextAttemptAtOffsetSec, attemptCount = 1 } = {}) {
  const restaurantId = await pgCreateRestaurant();
  const { paymentId } = await pgCreatePaidOrder(restaurantId);
  const nextAttemptAt = nextAttemptAtOffsetSec === undefined
    ? null
    : new Date(Date.now() + nextAttemptAtOffsetSec * 1000);
  return pgCreateRefund(paymentId, {
    status: 'processing', attemptCount, lastAttemptAt: new Date(), nextAttemptAt,
  });
}

// ---------------------------------------------------------------------------
// 1. requested -> processing
// ---------------------------------------------------------------------------

test('claim: requested -> processing — успешен, attempt_count/last_attempt_at/next_attempt_at установлены, ключ не изменился', async () => {
  const refund = await makeRequestedRefund();
  const result = await pgOrderService.claimRefundForProcessing(refund.id);

  assert.equal(result.claimed, true);
  assert.equal(result.refund.status, 'processing');
  assert.equal(result.refund.attempt_count, 1);
  assert.ok(result.refund.last_attempt_at);
  assert.ok(result.refund.next_attempt_at);
  assert.ok(new Date(result.refund.next_attempt_at) > new Date(), 'next_attempt_at должен быть в будущем (backoff)');
  assert.equal(result.refund.provider_idempotency_key, refund.provider_idempotency_key);
});

test('claim: backoff растёт экспоненциально с attempt_count (10s*2^n, cap 300s)', async () => {
  const refund = await makeRequestedRefund();
  const before = Date.now();
  const result = await pgOrderService.claimRefundForProcessing(refund.id);
  const deltaSec = (new Date(result.refund.next_attempt_at).getTime() - before) / 1000;
  // attempt_count становится 1 -> delaySec = min(10*2^1, 300) = 20
  assert.ok(deltaSec > 15 && deltaSec < 25, `ожидали ~20s backoff, получили ${deltaSec}s`);
});

// ---------------------------------------------------------------------------
// 2. processing с истёкшим next_attempt_at
// ---------------------------------------------------------------------------

test('claim: processing с истёкшим next_attempt_at — повторный claim успешен, attempt_count увеличен, тот же ключ', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: -5, attemptCount: 1 });
  const result = await pgOrderService.claimRefundForProcessing(refund.id);

  assert.equal(result.claimed, true);
  assert.equal(result.refund.attempt_count, 2);
  assert.equal(result.refund.provider_idempotency_key, refund.provider_idempotency_key);
  assert.ok(new Date(result.refund.next_attempt_at) > new Date());
});

test('claim: processing с next_attempt_at=NULL (никогда не claimался полноценно) — claim успешен', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: undefined, attemptCount: 0 });
  const result = await pgOrderService.claimRefundForProcessing(refund.id);
  assert.equal(result.claimed, true);
  assert.equal(result.refund.attempt_count, 1);
});

// ---------------------------------------------------------------------------
// 3. processing с живым next_attempt_at
// ---------------------------------------------------------------------------

test('claim: processing с живым next_attempt_at — claim не происходит, поля не изменяются', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: 30, attemptCount: 1 });
  const result = await pgOrderService.claimRefundForProcessing(refund.id);

  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'leased');
  assert.equal(result.refund.attempt_count, 1, 'attempt_count не должен был измениться');
  assert.equal(
    new Date(result.refund.next_attempt_at).getTime(),
    new Date(refund.next_attempt_at).getTime(),
    'next_attempt_at не должен был перезаписаться живой lease'
  );
});

// ---------------------------------------------------------------------------
// 7. Терминальные состояния
// ---------------------------------------------------------------------------

test('claim: succeeded — идемпотентный no-op, ничего не меняется', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: -5, attemptCount: 2 });
  await db.execute(
    `UPDATE refunds SET status='succeeded', provider_refund_id='ext-x', completed_at=NOW() WHERE id=$1`,
    [refund.id]
  );
  const before = await pgRefundRow(refund.id);
  const result = await pgOrderService.claimRefundForProcessing(refund.id);

  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'terminal');
  assert.equal(result.refund.status, 'succeeded');
  const after = await pgRefundRow(refund.id);
  assert.equal(after.attempt_count, before.attempt_count, 'succeeded не должен трогать attempt_count');
  assert.equal(after.provider_refund_id, before.provider_refund_id);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), 'succeeded строка не должна получать UPDATE вообще');
});

test('claim: failed — идемпотентный no-op, ничего не меняется', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: -5, attemptCount: 3 });
  await db.execute(
    `UPDATE refunds SET status='failed', last_error_code='provider_failed', completed_at=NOW() WHERE id=$1`,
    [refund.id]
  );
  const before = await pgRefundRow(refund.id);
  const result = await pgOrderService.claimRefundForProcessing(refund.id);

  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'terminal');
  assert.equal(result.refund.status, 'failed');
  const after = await pgRefundRow(refund.id);
  assert.equal(after.attempt_count, before.attempt_count);
  assert.equal(after.last_error_code, before.last_error_code);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
});

// ---------------------------------------------------------------------------
// 8. Отсутствующий refund
// ---------------------------------------------------------------------------

test('claim: несуществующий refundId — доменный not_found, не бросает', async () => {
  const result = await pgOrderService.claimRefundForProcessing(999999999);
  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'not_found');
  assert.equal(result.refund, null);
});

// ---------------------------------------------------------------------------
// 9. Rollback
// ---------------------------------------------------------------------------

test('claim: rollback на искусственной ошибке — ничего не персистируется', async () => {
  const refund = await makeRequestedRefund();

  await assert.rejects(
    () =>
      db.transaction(async (client) => {
        const updated = await db.execute(
          `UPDATE refunds SET status='processing', attempt_count=1, last_attempt_at=NOW(),
             next_attempt_at=NOW() + INTERVAL '20 seconds', updated_at=NOW()
           WHERE id=$1 AND status='requested'`,
          [refund.id],
          client
        );
        assert.equal(updated.rowCount, 1);
        throw new Error('искусственная ошибка после UPDATE refunds claim');
      }),
    /искусственная ошибка/
  );

  const row = await pgRefundRow(refund.id);
  assert.equal(row.status, 'requested', 'UPDATE должен был полностью откатиться');
  assert.equal(row.attempt_count, 0);
  assert.equal(row.next_attempt_at, null);
});

// ---------------------------------------------------------------------------
// 10. Restart-safety
// ---------------------------------------------------------------------------

test('claim: restart-safety — после истечения lease claim успешен, тот же provider_idempotency_key, attempt_count продолжает расти', async () => {
  const refund = await makeRequestedRefund();
  const first = await pgOrderService.claimRefundForProcessing(refund.id);
  assert.equal(first.claimed, true);
  assert.equal(first.refund.attempt_count, 1);

  // Симулируем "падение процесса и рестарт" — сетевой вызов так и не
  // произошёл, next_attempt_at истекает естественным образом (бэкдейтим,
  // чтобы не ждать 20+ секунд backoff в тесте). in-process Map этой функции
  // уже пуст к этому моменту (finally очищает её сразу после resolve
  // claim-промиса) — восстановление полностью полагается на состояние БД,
  // не на память процесса, что и есть суть restart-safety.
  await db.execute(`UPDATE refunds SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [refund.id]);

  delete require.cache[require.resolve('../../services/postgresql/orderService.js')];
  const restartedOrderService = require('../../services/postgresql/orderService.js');

  const second = await restartedOrderService.claimRefundForProcessing(refund.id);
  assert.equal(second.claimed, true);
  assert.equal(second.refund.attempt_count, 2, 'attempt_count должен продолжить расти, а не сброситься');
  assert.equal(second.refund.provider_idempotency_key, refund.provider_idempotency_key, 'restart не должен породить новый idempotency key');
});

// ---------------------------------------------------------------------------
// 11-12. provider_refund_id / last_error не трогаются claim'ом
// ---------------------------------------------------------------------------

test('claim: не изменяет provider_refund_id (даже если он уже был проставлен до вызова)', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: -5, attemptCount: 1 });
  await db.execute(`UPDATE refunds SET provider_refund_id = 'pre-existing-ext-id' WHERE id = $1`, [refund.id]);

  const result = await pgOrderService.claimRefundForProcessing(refund.id);
  assert.equal(result.claimed, true);
  assert.equal(result.refund.provider_refund_id, 'pre-existing-ext-id', 'claim не должен трогать provider_refund_id');
});

test('claim: не изменяет last_error_code/last_error_message_safe', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: -5, attemptCount: 1 });
  await db.execute(
    `UPDATE refunds SET last_error_code = 'timeout', last_error_message_safe = 'pre-existing' WHERE id = $1`,
    [refund.id]
  );

  const result = await pgOrderService.claimRefundForProcessing(refund.id);
  assert.equal(result.claimed, true);
  assert.equal(result.refund.last_error_code, 'timeout', 'claim не должен очищать last_error_code');
  assert.equal(result.refund.last_error_message_safe, 'pre-existing');
});

// ---------------------------------------------------------------------------
// 4-6. Concurrency — детерминированные доказательства через реальные два клиента
// ---------------------------------------------------------------------------

const CLAIM_SQL = `
  UPDATE refunds SET
    status = 'processing', attempt_count = $1, last_attempt_at = NOW(),
    next_attempt_at = NOW() + ($2 || ' seconds')::interval, updated_at = NOW()
  WHERE id = $3
    AND (
      status = 'requested'
      OR (status = 'processing' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
    )`;

test('claim: два конкурентных claim на requested — успешен ровно один (детерминированное доказательство)', async () => {
  const refund = await makeRequestedRefund();

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  const resA = await clientA.query(CLAIM_SQL, [1, 20, refund.id]);

  await clientB.query('BEGIN');
  const bPromise = clientB.query(CLAIM_SQL, [1, 20, refund.id]);
  await waitForBackendLock(monitor, pidB);
  await clientA.query('COMMIT');
  const resB = await bPromise;
  await clientB.query('COMMIT');

  assert.equal(resA.rowCount, 1);
  assert.equal(resB.rowCount, 0, 'второй конкурент не должен был выиграть claim requested-строки');
  await clientA.end();
  await clientB.end();
});

// "Живая" lease (next_attempt_at в будущем) не создаёт блокировки вообще:
// WHERE ни у одного из двух конкурентов не матчит строку (условие ложно), а
// значит ни один UPDATE не берёт эксклюзивный row-lock — waitForBackendLock
// здесь структурно неприменим (нечего ждать: оба UPDATE завершаются сразу
// же, независимо от порядка). Сама суть теста — что ОБА получают rowCount=0
// одновременно/независимо от порядка, без гонки за блокировку.
test('claim: два конкурентных claim на processing с ЖИВОЙ lease — успешных claim ноль (оба UPDATE не матчат строку, блокировки не требуется)', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: 30, attemptCount: 1 });

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  await clientA.connect();
  await clientB.connect();

  const [resA, resB] = await Promise.all([
    clientA.query(CLAIM_SQL, [2, 40, refund.id]),
    clientB.query(CLAIM_SQL, [2, 40, refund.id]),
  ]);

  assert.equal(resA.rowCount, 0, 'живая lease не должна была позволить claim первому клиенту');
  assert.equal(resB.rowCount, 0, 'и второму — тоже нет');
  await clientA.end();
  await clientB.end();

  const row = await pgRefundRow(refund.id);
  assert.equal(row.attempt_count, 1, 'attempt_count не должен был измениться ни разу — это КЛЮЧЕВОЕ отличие от буквального Варианта B');
  assert.equal(
    new Date(row.next_attempt_at).getTime(),
    new Date(refund.next_attempt_at).getTime(),
    'next_attempt_at живой lease не должен был перезаписаться'
  );
});

test('claim: два конкурентных claim на processing с ИСТЁКШЕЙ lease — успешен ровно один (детерминированное доказательство)', async () => {
  const refund = await makeProcessingRefund({ nextAttemptAtOffsetSec: -5, attemptCount: 1 });

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  const resA = await clientA.query(CLAIM_SQL, [2, 40, refund.id]);

  await clientB.query('BEGIN');
  const bPromise = clientB.query(CLAIM_SQL, [2, 40, refund.id]);
  await waitForBackendLock(monitor, pidB);
  await clientA.query('COMMIT');
  const resB = await bPromise;
  await clientB.query('COMMIT');

  assert.equal(resA.rowCount, 1);
  assert.equal(resB.rowCount, 0, 'вторая попытка должна была увидеть уже "processing" с новой (будущей) lease и не матчнуть WHERE');
  await clientA.end();
  await clientB.end();

  const row = await pgRefundRow(refund.id);
  assert.equal(row.attempt_count, 2, 'ровно одно успешное повторное claim, не два');
});

// Реальный API-уровень: два вызова claimRefundForProcessing() для ОДНОГО
// refundId внутри ОДНОГО процесса корректно дедуплицируются через
// refundAttemptInFlight (fast-path, п.6 задания) — оба вызывающих получают
// ОДИН И ТОТ ЖЕ результат единственной DB-транзакции, а не два независимых
// похода в БД. Это ожидаемая оптимизация, не повторный обход WHERE-guard'а
// (тот уже исчерпывающе доказан выше двумя реальными PostgreSQL-клиентами).
test('claim: конкурентные claimRefundForProcessing() на один refundId в рамках процесса — in-process Map дедуплицирует до одной DB-транзакции', async () => {
  const refund = await makeRequestedRefund();

  const [r1, r2] = await Promise.all([
    pgOrderService.claimRefundForProcessing(refund.id),
    pgOrderService.claimRefundForProcessing(refund.id),
  ]);

  assert.equal(r1.claimed, true);
  assert.deepEqual(r1, r2, 'оба вызывающих должны получить идентичный результат одной и той же DB-транзакции');
  const row = await pgRefundRow(refund.id);
  assert.equal(row.attempt_count, 1, 'Map должна была свести два вызова к ровно одной claim-транзакции');
});

// Настоящая межпроцессная гонка (Map НЕ помогает — она per-process) через
// реальный API: имитируем "второй процесс" повторным require() модуля (тот
// же приём, что и restart-safety тест выше) — у него СВОЙ, пустой
// refundAttemptInFlight. Оба вызывают claimRefundForProcessing на ОДИН
// refundId "одновременно" (Promise.all) — единственная реальная защита
// здесь снова SQL WHERE-guard, не Map.
test('claim: конкурентные claimRefundForProcessing() из ДВУХ "процессов" (разные Map) на requested — успешен ровно один', async () => {
  const refund = await makeRequestedRefund();

  delete require.cache[require.resolve('../../services/postgresql/orderService.js')];
  const otherProcessOrderService = require('../../services/postgresql/orderService.js');
  assert.notEqual(otherProcessOrderService.claimRefundForProcessing, pgOrderService.claimRefundForProcessing, 'у "второго процесса" должна быть своя копия модуля/Map');

  const results = await Promise.allSettled([
    pgOrderService.claimRefundForProcessing(refund.id),
    otherProcessOrderService.claimRefundForProcessing(refund.id),
  ]);
  const claimedCount = results.filter((r) => r.status === 'fulfilled' && r.value.claimed).length;
  assert.equal(claimedCount, 1, 'ровно один из двух независимых "процессов" должен выиграть claim');
  const row = await pgRefundRow(refund.id);
  assert.equal(row.attempt_count, 1, 'ровно одна успешная claim-попытка, несмотря на два независимых процесса');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('claim: пул возвращён, waitingCount=0', async () => {
  const refund = await makeRequestedRefund();
  await pgOrderService.claimRefundForProcessing(refund.id);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});
