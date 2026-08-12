'use strict';

// YAAM Stage 22 — тесты на подтверждённые дефекты Stage 21.
//
// Каждый тест сначала воспроизводит сам дефект (то есть проверяет поведение,
// которого раньше НЕ было), и только потом — что решение работает.
//
// P — сверка платежей (CRITICAL-1).
// D — двойной успешный платёж (HIGH-1).
// R — полный возврат как инвариант базы (HIGH-2).
// I — контроль расчётных инвариантов (HIGH-3).
// W — реестр отвергнутых webhook (MEDIUM-4).
// N — нумерация и повтор документов (MEDIUM-1, MEDIUM-2).
// F — фискальные чеки (CRITICAL-2).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../services/postgresql/paymentReconciliationService.js'),
  require.resolve('../../services/postgresql/webhookRejectionService.js'),
  require.resolve('../../services/hq/settlementInvariantMonitor.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/settlementDocumentService.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/hq/eventLogService.js'),
  require.resolve('../../services/fiscalization/fiscalReceiptService.js'),
  require.resolve('../../services/paymentService.js'),
  require.resolve('../../services/paymentProviders/yookassaProvider.js'),
];

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('financial-safety-22'); });
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}

function requireFresh() {
  for (const p of MODULE_PATHS) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    orderService: require('../../services/postgresql/orderService'),
    reconciliation: require('../../services/postgresql/paymentReconciliationService'),
    rejections: require('../../services/postgresql/webhookRejectionService'),
    monitor: require('../../services/hq/settlementInvariantMonitor'),
    documents: require('../../services/hq/settlementDocumentService'),
    fiscal: require('../../services/fiscalization/fiscalReceiptService'),
    paymentService: require('../../services/paymentService'),
  };
}

// Подмена провайдера: сверка обязана работать без единого реального платежа.
function stubProviderStatus(paymentService, impl) {
  const original = paymentService.getPaymentStatus;
  paymentService.getPaymentStatus = impl;
  return () => { paymentService.getPaymentStatus = original; };
}

let seq = 0;
async function seedOrderWithPendingPayment(db, { ageMinutes = 30, providerPaymentId = null, amount = 1000 } = {}) {
  seq += 1;
  const r = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at)
     VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [`Кафе S22-${seq}`],
  );
  const restaurantId = r.rows[0].id;
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at)
     VALUES ($1,$2,'Грозный','Тест','+7900000000${seq % 10}','ул. Тестовая, 1','',$3,0,'awaiting_payment',NOW())
     RETURNING id`,
    [`YAAM-S22${String(seq).padStart(3, '0')}`, restaurantId, amount],
  );
  const orderId = o.rows[0].id;
  const pid = providerPaymentId || `prov-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  const p = await db.execute(
    `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status, created_at)
     VALUES ($1,'mock',$2,$4,'pending', NOW() - make_interval(mins => $3)) RETURNING id`,
    [orderId, pid, ageMinutes, amount],
  );
  return { restaurantId, orderId, paymentId: p.rows[0].id, providerPaymentId: pid };
}

// ===========================================================================
// P — сверка платежей
// ===========================================================================

test('P1: потерянный webhook — сверка приводит систему в то же состояние', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p1');
  const { db, reconciliation, paymentService } = requireFresh();
  const restore = stubProviderStatus(paymentService, async () => 'succeeded');
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);

    // До сверки: заказ висит неоплаченным — ровно тот дефект Stage 21.
    let order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(order[0].status, 'awaiting_payment');

    const stats = await reconciliation.runPaymentReconciliation();
    assert.equal(stats.checked, 1);
    assert.equal(stats.confirmedPaid, 1);

    // После: ровно то же состояние, что дал бы полученный webhook.
    order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(order[0].status, 'awaiting_restaurant', 'заказ обязан уйти к ресторану');
    const payment = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(payment[0].status, 'succeeded');
  } finally {
    restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('P2: повтор сверки ничего не дублирует', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p2');
  const { db, reconciliation, paymentService } = requireFresh();
  const restore = stubProviderStatus(paymentService, async () => 'succeeded');
  try {
    const { orderId } = await seedOrderWithPendingPayment(db);
    await reconciliation.runPaymentReconciliation();
    const first = await db.query('SELECT status, status_updated_at FROM orders WHERE id = $1', [orderId]);

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const again = await reconciliation.runPaymentReconciliation();
      assert.equal(again.checked, 0, 'разрешённый платёж больше не выбирается');
    }

    const second = await db.query('SELECT status, status_updated_at FROM orders WHERE id = $1', [orderId]);
    assert.equal(second[0].status, first[0].status);
    assert.deepEqual(second[0].status_updated_at, first[0].status_updated_at, 'момент перехода не переписан');
    const payments = await db.query('SELECT COUNT(*)::int AS n FROM payments');
    assert.equal(payments[0].n, 1, 'вторая платёжная строка не создаётся');
  } finally {
    restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('P3: временная недоступность провайдера НЕ переводит платёж в терминальный статус', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p3');
  const { db, reconciliation, paymentService } = requireFresh();
  const err = new Error('провайдер недоступен');
  err.category = 'retryable';
  const restore = stubProviderStatus(paymentService, async () => { throw err; });
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);
    const stats = await reconciliation.runPaymentReconciliation();
    assert.equal(stats.unavailable, 1);

    const payment = await db.query(
      'SELECT status, reconcile_attempt_count, next_check_at, last_reconcile_error_code, last_reconcile_error_safe FROM payments WHERE id = $1',
      [paymentId],
    );
    assert.equal(payment[0].status, 'pending', 'платёж НЕ переводится в failed из-за сбоя API');
    assert.equal(payment[0].reconcile_attempt_count, 1, 'попытка наблюдаема');
    assert.ok(payment[0].next_check_at, 'следующая проверка запланирована');
    assert.equal(payment[0].last_reconcile_error_code, 'retryable');
    assert.ok(!/https?:\/\//.test(payment[0].last_reconcile_error_safe || ''), 'в ошибке нет URL');

    const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(order[0].status, 'awaiting_payment', 'заказ не закрывается по недоступности API');

    // Backoff: повторный проход в тот же момент платёж не берёт.
    const again = await reconciliation.runPaymentReconciliation();
    assert.equal(again.checked, 0);
  } finally {
    restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('P4: подтверждённый провайдером отказ закрывает заказ штатным переходом', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p4');
  const { db, reconciliation, paymentService } = requireFresh();
  const restore = stubProviderStatus(paymentService, async () => 'failed');
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);
    const stats = await reconciliation.runPaymentReconciliation();
    assert.equal(stats.confirmedFailed, 1);
    const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(order[0].status, 'payment_failed');
    const payment = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(payment[0].status, 'failed');
  } finally {
    restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('P5: слишком свежий платёж не сверяется — сверка не гонится с обычным потоком', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p5');
  const { db, reconciliation, paymentService } = requireFresh();
  let asked = 0;
  const restore = stubProviderStatus(paymentService, async () => { asked += 1; return 'succeeded'; });
  try {
    await seedOrderWithPendingPayment(db, { ageMinutes: 1 });
    const stats = await reconciliation.runPaymentReconciliation();
    assert.equal(stats.checked, 0);
    assert.equal(asked, 0, 'провайдер не опрашивается по свежему платежу');
  } finally {
    restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('P6: поздняя оплата ОТМЕНЁННОГО заказа уходит в существующий возвратный сценарий', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p6');
  const { db, reconciliation, paymentService } = requireFresh();
  const restore = stubProviderStatus(paymentService, async () => 'succeeded');
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);
    await db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);

    await reconciliation.runPaymentReconciliation();

    const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    assert.equal(order[0].status, 'cancelled', 'отменённый заказ не воскресает');
    const payment = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(payment[0].status, 'succeeded', 'факт денег зафиксирован');
    const refunds = await db.query('SELECT amount, reason, status FROM refunds WHERE payment_id = $1', [paymentId]);
    assert.equal(refunds.length, 1, 'создан ровно один возврат');
    assert.equal(refunds[0].amount, 1000, 'возврат на полную сумму');
    assert.equal(refunds[0].reason, 'customer_cancel');
  } finally {
    restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

async function withFakeYookassaCanonical(body, fn) {
  const previous = {
    provider: process.env.PAYMENT_PROVIDER,
    shopId: process.env.YOOKASSA_SHOP_ID,
    secret: process.env.YOOKASSA_SECRET_KEY,
    environment: process.env.YOOKASSA_ENV,
    fetch: global.fetch,
  };
  process.env.PAYMENT_PROVIDER = 'yookassa';
  process.env.YOOKASSA_SHOP_ID = '999999';
  process.env.YOOKASSA_SECRET_KEY = 'test_finance_hardening_fake_only';
  process.env.YOOKASSA_ENV = 'sandbox';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try {
    return await fn();
  } finally {
    for (const [key, value] of [
      ['PAYMENT_PROVIDER', previous.provider],
      ['YOOKASSA_SHOP_ID', previous.shopId],
      ['YOOKASSA_SECRET_KEY', previous.secret],
      ['YOOKASSA_ENV', previous.environment],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
}

test('P7: polling передаёт local amount/currency и принимает совпавший canonical payment', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_p7_amount_ok');
  let db;
  try {
    await withFakeYookassaCanonical({
      id: 'yk-p7', status: 'succeeded', test: true,
      amount: { value: '300.00', currency: 'RUB' },
    }, async () => {
      ({ db } = requireFresh());
      const reconciliation = require('../../services/postgresql/paymentReconciliationService');
      const { paymentId } = await seedOrderWithPendingPayment(db, { providerPaymentId: 'yk-p7', amount: 30000 });
      const stats = await reconciliation.runPaymentReconciliation();
      assert.equal(stats.confirmedPaid, 1);
      const payment = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
      assert.equal(payment[0].status, 'succeeded');
    });
  } finally {
    if (db) await db.close();
    delete process.env.DATABASE_URL;
  }
});

for (const [label, amount] of [
  ['amount', { value: '299.00', currency: 'RUB' }],
  ['currency', { value: '300.00', currency: 'USD' }],
]) {
  test(`P8 ${label}: polling fail-closed не подтверждает local payment при canonical mismatch`, async () => {
    process.env.DATABASE_URL = await freshDatabase(`s22_p8_${label}`);
    let db;
    try {
      await withFakeYookassaCanonical({ id: `yk-p8-${label}`, status: 'succeeded', test: true, amount }, async () => {
        ({ db } = requireFresh());
        const reconciliation = require('../../services/postgresql/paymentReconciliationService');
        const { orderId, paymentId } = await seedOrderWithPendingPayment(db, {
          providerPaymentId: `yk-p8-${label}`, amount: 30000,
        });
        const stats = await reconciliation.runPaymentReconciliation();
        assert.equal(stats.confirmedPaid, 0);
        assert.equal(stats.unknown, 1);
        const payment = await db.query('SELECT status, last_reconcile_error_code FROM payments WHERE id = $1', [paymentId]);
        assert.equal(payment[0].status, 'pending');
        assert.equal(payment[0].last_reconcile_error_code, 'unknown_result');
        const order = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
        assert.equal(order[0].status, 'awaiting_payment');
      });
    } finally {
      if (db) await db.close();
      delete process.env.DATABASE_URL;
    }
  });
}

// ===========================================================================
// D — двойной успешный платёж
// ===========================================================================

test('D1: поздний succeeded по старой попытке фиксируется как дубль и уходит в возврат', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_d1');
  const { db, orderService } = requireFresh();
  try {
    // 1-2. Платёж №1 создан и локально считается неудачным.
    const { orderId, paymentId: firstId } = await seedOrderWithPendingPayment(db);
    await orderService.markPaymentFailed(orderId, firstId);

    // 3-4. Платёж №2 создан и успешно оплачен.
    const second = await db.execute(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
       VALUES ($1,'mock','prov-second',1000,'pending') RETURNING id`,
      [orderId],
    );
    await db.execute("UPDATE orders SET status = 'awaiting_payment' WHERE id = $1", [orderId]);
    await orderService.markPaid(orderId, second.rows[0].id);

    // 5. Провайдер подтверждает успех платежа №1.
    const applied = await orderService.applyConfirmedPaymentSuccess(orderId, firstId, { source: 'reconciliation' });

    // Факт второго списания НЕ потерян и не проглочен молча.
    assert.equal(applied.outcome, 'duplicate');
    assert.equal(applied.canonicalPaymentId, second.rows[0].id);
    assert.ok(applied.refundId, 'лишняя сумма отправлена в возврат');

    const first = await db.query('SELECT status, duplicate_of_payment_id FROM payments WHERE id = $1', [firstId]);
    assert.equal(first[0].status, 'succeeded', 'каноническая правда провайдера сохранена');
    assert.equal(first[0].duplicate_of_payment_id, second.rows[0].id, 'дубль помечен ссылкой');

    // Учитываемый платёж ровно один.
    const counted = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE order_id = $1 AND duplicate_of_payment_id IS NULL AND status IN ('succeeded','refunded')`,
      [orderId],
    );
    assert.equal(counted[0].n, 1);

    // Финансовая аномалия видна владельцу и в аудите.
    const events = await db.query("SELECT message FROM hq_events WHERE category = 'payment_issue'");
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Двойное списание/);
    const audit = await db.query("SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'payment_duplicate_detected'");
    assert.equal(audit[0].n, 1);

    // Повторное событие не создаёт второго возврата.
    const again = await orderService.applyConfirmedPaymentSuccess(orderId, firstId, { source: 'webhook' });
    assert.equal(again.outcome, 'noop');
    const refunds = await db.query('SELECT COUNT(*)::int AS n FROM refunds WHERE payment_id = $1', [firstId]);
    assert.equal(refunds[0].n, 1, 'второй возврат не создаётся');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('D2: подтверждённый успех ЕДИНСТВЕННОЙ отклонённой попытки восстанавливает платёж, а не считает его дублем', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_d2');
  const { db, orderService } = requireFresh();
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);
    await orderService.markPaymentFailed(orderId, paymentId);

    const applied = await orderService.applyConfirmedPaymentSuccess(orderId, paymentId, { source: 'reconciliation' });
    assert.equal(applied.outcome, 'applied');
    assert.equal(applied.revived, true);

    const payment = await db.query('SELECT status, duplicate_of_payment_id FROM payments WHERE id = $1', [paymentId]);
    assert.equal(payment[0].status, 'succeeded');
    assert.equal(payment[0].duplicate_of_payment_id, null, 'единственный платёж не может быть дублем');
    const refunds = await db.query('SELECT COUNT(*)::int AS n FROM refunds');
    assert.equal(refunds[0].n, 0, 'возврат не нужен — деньги учтены');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('D3: база не допускает двух учитываемых успешных платежей одного заказа', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_d3');
  const { db } = requireFresh();
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);
    await db.execute("UPDATE payments SET status = 'succeeded' WHERE id = $1", [paymentId]);

    await assert.rejects(
      () => db.execute(
        `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
         VALUES ($1,'mock','prov-x2',1000,'succeeded')`,
        [orderId],
      ),
      (err) => err.code === '23505',
      'второй учитываемый успешный платёж обязан отвергаться базой',
    );

    // Но помеченный дублем — допустим: правда провайдера не теряется.
    await db.execute(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status, duplicate_of_payment_id)
       VALUES ($1,'mock','prov-dup',1000,'succeeded',$2)`,
      [orderId, paymentId],
    );
    const all = await db.query('SELECT COUNT(*)::int AS n FROM payments WHERE order_id = $1', [orderId]);
    assert.equal(all[0].n, 2);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// R — полный возврат как инвариант базы
// ===========================================================================

// ВАЖНО. Инвариант «возврат равен сумме платежа» существовал ЗАДОЛГО до
// Stage 22 и был закрыт ПОЛНОСТЬЮ: trg_refunds_amount_matches_payment на
// INSERT, trg_refunds_immutable_fields на UPDATE и
// ux_refunds_one_succeeded_per_payment на второй успешный возврат. Вывод
// аудита Stage 21 (HIGH-2) был ошибочным — он смотрел только на CHECK у
// колонки. Stage 22 не добавил здесь ничего; тест закрепляет фактическое
// поведение, чтобы защита не была снята будущим изменением.
test('R1: частичный возврат отвергается базой и на INSERT, и на UPDATE', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_r1');
  const { db } = requireFresh();
  try {
    const { paymentId } = await seedOrderWithPendingPayment(db);
    await db.execute("UPDATE payments SET status = 'succeeded' WHERE id = $1", [paymentId]);

    await assert.rejects(
      () => db.execute(
        `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
         VALUES ($1,'mock',200,'succeeded','customer_cancel','k-partial',NOW())`,
        [paymentId],
      ),
      /full-refund-only/,
    );

    // Возврат больше платежа — тоже отвергается, в любом статусе.
    await assert.rejects(
      () => db.execute(
        `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
         VALUES ($1,'mock',5000,'requested','customer_cancel','k-over')`,
        [paymentId],
      ),
      /full-refund-only/,
    );

    // Полный возврат продолжает работать.
    await db.execute(
      `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
       VALUES ($1,'mock',1000,'succeeded','customer_cancel','k-full',NOW())`,
      [paymentId],
    );
    const rows = await db.query('SELECT id, amount FROM refunds WHERE payment_id = $1', [paymentId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 1000);

    // UPDATE закрыт ДРУГИМ, уже существовавшим триггером: amount неизменяем.
    // Вместе с проверкой на INSERT это делает частичный возврат невозможным на
    // всех путях — вывод аудита Stage 21 (HIGH-2) был ошибочным.
    await assert.rejects(
      () => db.execute('UPDATE refunds SET amount = 200 WHERE id = $1', [rows[0].id]),
      /immutable/,
      'изменение суммы существующего возврата обязано отвергаться',
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('R2: два успешных возврата одного платежа невозможны', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_r2');
  const { db } = requireFresh();
  try {
    const { paymentId } = await seedOrderWithPendingPayment(db);
    await db.execute("UPDATE payments SET status = 'succeeded' WHERE id = $1", [paymentId]);
    await db.execute(
      `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
       VALUES ($1,'mock',1000,'succeeded','customer_cancel','k1',NOW())`,
      [paymentId],
    );
    await assert.rejects(
      () => db.execute(
        `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
         VALUES ($1,'mock',1000,'succeeded','timeout','k2',NOW())`,
        [paymentId],
      ),
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// I — контроль расчётных инвариантов
// ===========================================================================

test('I1: нарушение попадает в аудит и Центр событий, повтор не спамит, восстановление видно', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_i1');
  const { db, monitor } = requireFresh();
  try {
    // Чистое состояние.
    const clean = await monitor.runInvariantCheck();
    assert.equal(clean.ok, true);
    assert.equal(monitor.getFinancialHealth().state, 'ok');

    // Искусственное нарушение: закрытый период без единой строки расчёта.
    await db.execute(
      `INSERT INTO settlement_periods (period_from, period_to, status, closed_at)
       VALUES ('2026-01-05','2026-01-11','closed',NOW())`,
    );

    const bad = await monitor.runInvariantCheck();
    assert.equal(bad.ok, false);
    assert.equal(bad.reported, true);
    assert.equal(monitor.getFinancialHealth().state, 'degraded');

    let events = await db.query("SELECT message FROM hq_events WHERE category = 'backend_issue'");
    assert.equal(events.length, 1, 'проблема видна в Центре событий');
    assert.match(events[0].message, /расхождение в расчётах/);
    let audit = await db.query("SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_invariant_violated'");
    assert.equal(audit[0].n, 1);

    // Неизменившееся нарушение НЕ спамит.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const again = await monitor.runInvariantCheck();
      assert.equal(again.reported, false, 'повтор того же нарушения не порождает новых записей');
    }
    events = await db.query("SELECT COUNT(*)::int AS n FROM hq_events WHERE category = 'backend_issue'");
    assert.equal(events[0].n, 1);
    audit = await db.query("SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_invariant_violated'");
    assert.equal(audit[0].n, 1);

    // Данные автоматически НЕ исправлялись.
    const periods = await db.query('SELECT COUNT(*)::int AS n FROM settlement_periods');
    assert.equal(periods[0].n, 1, 'монитор не трогает финансовые данные');

    // Проблема устранена ШТАТНО: закрытый период неизменяем и неудаляем (это
    // правильная защита), поэтому нарушение снимается появлением недостающей
    // строки расчёта, а не удалением периода.
    const rest = await db.execute(
      `INSERT INTO restaurants (name, cities, is_open, published_at)
       VALUES ('Кафе I1','["Грозный"]',1,NOW()) RETURNING id`,
    );
    const periodRow = await db.query('SELECT id FROM settlement_periods LIMIT 1');
    await db.execute(
      `INSERT INTO settlement_restaurant_lines
         (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
          restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
          payout_readiness_snapshot, contract_number_snapshot, restaurant_name_snapshot)
       VALUES ($1,$2,0,0,0,0,0,0,0,'{}','','Кафе I1')`,
      [periodRow[0].id, rest.rows[0].id],
    );
    const recovered = await monitor.runInvariantCheck();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    const rec = await db.query("SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_invariant_recovered'");
    assert.equal(rec[0].n, 1);
    assert.equal(monitor.getFinancialHealth().state, 'ok');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// W — реестр отвергнутых webhook
// ===========================================================================

test('W1: отказ сохраняется без секретов, повторы дедуплицируются, критичное идёт в события', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_w1');
  const { db, rejections } = requireFresh();
  try {
    const fingerprint = 'a'.repeat(64);
    const first = await rejections.record({
      provider: 'yookassa', eventType: 'payment', reason: 'unknown_payment',
      payloadFingerprint: fingerprint, providerObjectId: 'prov-999', httpStatus: 404,
      detailSafe: 'платёж не найден, форма была на https://secret.example/pay/abc и токен yaam_ord_v1_SECRETVALUE',
      requestId: 'req-1',
    });
    assert.equal(first.recorded, true);
    assert.equal(first.rejection.occurrence_count, 1);

    // Ни URL, ни токена в сохранённом тексте.
    assert.ok(!/https?:\/\//.test(first.rejection.detail_safe), 'URL не сохраняется');
    assert.ok(!/yaam_ord_v1_SECRETVALUE/.test(first.rejection.detail_safe), 'токен не сохраняется');
    // И самого тела уведомления нет — только отпечаток.
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_rejections'`,
    );
    const names = cols.map((c) => c.column_name);
    assert.ok(!names.includes('payload'), 'сырое тело не хранится');
    assert.ok(!names.some((n) => /auth|cookie|secret|token/i.test(n)), 'нет колонок под секреты');

    // Повторы того же уведомления — одна строка, растущий счётчик.
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await rejections.record({
        provider: 'yookassa', eventType: 'payment', reason: 'unknown_payment',
        payloadFingerprint: fingerprint, httpStatus: 404, detailSafe: 'повтор', requestId: `req-${i + 2}`,
      });
    }
    const rows = await db.query('SELECT occurrence_count FROM webhook_rejections');
    assert.equal(rows.length, 1, 'повторы не плодят строки');
    assert.equal(rows[0].occurrence_count, 5);

    // Критичная причина попала в Центр событий ровно один раз.
    const events = await db.query("SELECT COUNT(*)::int AS n FROM hq_events WHERE category = 'payment_issue'");
    assert.equal(events[0].n, 1, 'событие только на первом появлении');

    const needsReview = await rejections.listNeedsReview();
    assert.equal(needsReview.length, 1);
    const resolved = await rejections.resolve(needsReview[0].id, 'разобрано');
    assert.equal(resolved.state, 'resolved');
    assert.equal((await rejections.listNeedsReview()).length, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// N — нумерация и повтор документов
// ===========================================================================

test('N1: одновременная выдача номеров не даёт коллизии', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_n1');
  const { db, documents } = requireFresh();
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => documents.nextDocumentNumber('agent_report', 2026)),
    );
    assert.equal(new Set(results).size, 12, 'все номера обязаны быть различны');
    const numbers = results.map((n) => Number(n.split('-').pop())).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 12 }, (_, i) => i + 1), 'нумерация без пропусков');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('N2: счётчик продолжает уже существующую нумерацию, а не начинает заново', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_n2');
  const { db, documents } = requireFresh();
  try {
    await db.execute(
      `INSERT INTO document_number_counters (kind, year, last_number) VALUES ('agent_report', 2026, 7)`,
    );
    const next = await documents.nextDocumentNumber('agent_report', 2026);
    assert.equal(next, 'YAAM-АО-2026-0008');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// F — фискальные чеки
// ===========================================================================

test('F1: чек прихода ставится один раз, повтор webhook второго не создаёт', async () => {
  process.env.DATABASE_URL = await freshDatabase('s22_f1');
  const { db, fiscal } = requireFresh();
  try {
    const { orderId, paymentId } = await seedOrderWithPendingPayment(db);
    await db.execute("UPDATE payments SET status = 'succeeded' WHERE id = $1", [paymentId]);
    await db.execute(
      `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, price_snapshot, qty)
       VALUES ($1, NULL, 'Тестовое блюдо', 1000, 1)`,
      [orderId],
    ).catch(() => {});

    const first = await fiscal.enqueueReceipt({ kind: 'payment', orderId, paymentId });
    const second = await fiscal.enqueueReceipt({ kind: 'payment', orderId, paymentId });
    assert.equal(second.created, false, 'повторный enqueue не создаёт второй чек');
    if (first.receipt) {
      assert.equal(first.receipt.id, second.receipt.id, 'ключ идемпотентности детерминирован');
      const rows = await db.query('SELECT COUNT(*)::int AS n FROM fiscal_receipts');
      assert.equal(rows[0].n, 1);
      // Признаки 54-ФЗ НЕ выдуманы.
      const payload = first.receipt.payload;
      assert.ok(payload.pendingLegal, 'нерешённые юридические признаки помечены явно');
      assert.equal(payload.pendingLegal.vatRate, 'не согласована');
      // Доставки в чеке нет — YAAM её не оказывает и не принимает за неё оплату.
      assert.equal(payload.order.deliveryAmount, 0);
    }
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('F2: live без готовой кассы не запускается, sandbox остаётся разрешённым', () => {
  const { inspectEnv } = require('../../services/config/env');
  const base = {
    APP_ENV: 'production',
    DATABASE_URL: 'postgres://validation-placeholder@127.0.0.1:5432/validation',
    PUBLIC_BACKEND_URL: 'https://api.example.test',
    TRUST_PROXY: 'loopback',
    PAYMENT_PROVIDER: 'yookassa',
    YOOKASSA_SHOP_ID: '123456',
  };

  // Live без кассы — запуск запрещён.
  const live = inspectEnv({ ...base, YOOKASSA_ENV: 'live', YOOKASSA_SECRET_KEY: 'live_KEY0123456789ABCDEF' });
  assert.ok(live.errors.some((e) => /FISCAL_PROVIDER/.test(e)), 'нет кассы — live запрещён');
  assert.ok(live.errors.some((e) => /54-ФЗ/.test(e)), 'нет юридического подтверждения — live запрещён');

  // Live с mock-кассой — тоже запрещён.
  const liveMock = inspectEnv({
    ...base, YOOKASSA_ENV: 'live', YOOKASSA_SECRET_KEY: 'live_KEY0123456789ABCDEF',
    FISCAL_PROVIDER: 'mock', FISCAL_LEGAL_CONFIRMED: 'true',
  });
  assert.ok(liveMock.errors.some((e) => /mock-кассу/.test(e)));

  // Sandbox — законный тестовый режим, но состояние обязано быть замечено.
  const sandbox = inspectEnv({ ...base, YOOKASSA_ENV: 'sandbox', YOOKASSA_SECRET_KEY: 'test_ABCDEFGHIJKLMNOPQRSTUVWX' });
  assert.ok(!sandbox.errors.some((e) => /FISCAL/.test(e)), 'sandbox не блокируется');
  assert.ok(sandbox.warnings.some((w) => /тестовом режиме/.test(w)), 'но предупреждение обязано быть');
});
