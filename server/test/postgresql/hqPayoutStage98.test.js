'use strict';

// YAAM HQ Stage 9.8 — Final Payout Architecture Audit fixes. Целевые
// регрессионные тесты РОВНО на 4 находки аудита Stage 9.7 (F1/F2/F3/F7) —
// без изменения архитектуры, без новых сущностей, без UI, без банка.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-payout-stage98');
});

after(async () => {
  await cluster.stop();
});

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const setupClient = cluster.getClient(name);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
  return cluster.connectionString(name);
}

function requireFreshModules() {
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  delete require.cache[require.resolve('../../services/hq/yaamBankDetailsService')];
  delete require.cache[require.resolve('../../services/hq/restaurantBankDetailsService')];
  delete require.cache[require.resolve('../../services/hq/restaurantContractService')];
  delete require.cache[require.resolve('../../services/hq/tbankPayoutReadiness')];
  delete require.cache[require.resolve('../../services/hq/tbankRequestMapper')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  return {
    db: require('../../db/postgresql'),
    settlementService: require('../../services/hq/settlementService'),
    payoutService: require('../../services/hq/payoutService'),
  };
}

async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, {
  restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null,
}) {
  orderCounter += 1;
  const code = `YAAM-98${orderCounter}`;
  const phone = `+7905${String(orderCounter).padStart(7, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // фикстура пишет напрямую SQL, поэтому сама выставляет earned_at = NOW()
  // ровно когда status='delivered' (тот же принцип, что и backfill в
  // миграции 0013).
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,COALESCE($7,NOW()),
       CASE WHEN $6 = 'delivered' THEN COALESCE($7,NOW()) ELSE NULL END)
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status, statusUpdatedAt],
  );
  return rows.rows[0].id;
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}

async function closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal = 1000, commissionAmount = 70, dayOffset = 0 } = {}) {
  const statusUpdatedAt = dayOffset ? new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000) : null;
  const orderId = await createOrderRow(db, {
    restaurantId, status: 'delivered', itemsTotal, commissionAmount, statusUpdatedAt,
  });
  await addSucceededPayment(db, orderId, itemsTotal);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(dayOffset), periodTo: todayStr(dayOffset) });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}

// Те же вымышленные, но математически корректные реквизиты, что и во всех
// предыдущих Stage 9.6-тестах (server/test/postgresql/hqTBankReadinessStage96.test.js).
const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_INN10 = '7709123453';
const FICTITIOUS_KPP = '770101001';

async function seedFullReadiness(db, restaurantId) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, 'ООО YAAM Платформа', $1, $2, $3, $4, 'ТЕСТБАНК', $5)
     ON CONFLICT (id) DO NOTHING`,
    [FICTITIOUS_INN10, FICTITIOUS_KPP, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account, default_payment_purpose)
     VALUES ($1, 'ИП Тестов Тест Тестович', $2, '', $3, $4, 'ТЕСТБАНК', $5, 'Оплата услуг доставки по договору')`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1, $2, '2026-01-01', 'signed')`,
    [restaurantId, `Д-${restaurantId}`],
  );
}

// ===========================================================================
// Находка F1 — транзакционная граница: createPayoutAttempt() должен
// работать даже когда пул ограничен РОВНО ОДНИМ соединением. До исправления
// buildAndInsertAttemptRequisites() уходил на ВТОРОЕ, отдельное соединение
// для 3 из 4 чтений — с PG_POOL_MAX=1 транзакция (уже держащая единственное
// соединение) ждала бы освобождения слота, которого никогда не появится
// (классический self-deadlock на уровне пула, не PostgreSQL). Таймаут теста
// — единственный надёжный способ доказать "не зависло", если регрессия
// когда-либо вернётся.
// ===========================================================================
test('Stage9.8 F1: createPayoutAttempt работает с пулом из ОДНОГО соединения (все чтения — на client транзакции)', { timeout: 8000 }, async () => {
  const databaseUrl = await freshDatabase('stage98_pool_max_one');
  process.env.DATABASE_URL = databaseUrl;
  // Сначала — обычная подготовка данных С ОБЫЧНЫМ пулом (createDraftSettlement
  // Period/closeSettlementPeriod сами по себе используют несколько
  // одновременных соединений — это не относится к находке F1, ограничивать
  // пул нужно ТОЛЬКО на сам вызов createPayoutAttempt).
  const setup = requireFreshModules();
  const restaurantId = await createRestaurant(setup.db, 'PoolMaxOne');
  await seedFullReadiness(setup.db, restaurantId);
  const period = await closedPeriodWithEarnings(setup.db, setup.settlementService, restaurantId);
  const payout = await setup.payoutService.prepareRestaurantPayout(period.id, restaurantId);
  await setup.db.close();

  // Теперь — свежий db/payoutService instance с пулом РОВНО из одного
  // соединения. До исправления F1 createPayoutAttempt() требовал ДВА
  // одновременных соединения (client транзакции + отдельное соединение для
  // 3 из 4 чтений в buildAndInsertAttemptRequisites) — с PG_POOL_MAX=1 это
  // было бы самозависанием на уровне пула (транзакция ждёт свободный слот,
  // который никогда не появится, т.к. держит его сама). Таймаут теста —
  // единственный надёжный способ доказать "не зависло", если регрессия
  // когда-либо вернётся.
  process.env.PG_POOL_MAX = '1';
  const { db, payoutService } = requireFreshModules();
  try {
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    assert.ok(attempt.id, 'createPayoutAttempt должен успешно завершиться даже с пулом из одного соединения');

    const snapshot = await payoutService.getAttemptRequisites(attempt.id);
    assert.ok(snapshot, 'snapshot должен быть создан в той же транзакции');
    assert.equal(snapshot.account_number, FICTITIOUS_RS);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
    delete process.env.PG_POOL_MAX;
  }
});

// ===========================================================================
// Находка F2 — restaurant_payouts.amount неизменяем С МОМЕНТА СОЗДАНИЯ
// ===========================================================================
test('Stage9.8 F2: restaurant_payouts.amount неизменяем даже до succeeded (prepared/processing/blocked)', async () => {
  const databaseUrl = await freshDatabase('stage98_amount_immutable');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'AmountImmutable');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal: 1000, commissionAmount: 70 });
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    assert.equal(payout.amount, 930);

    // prepared — прямой SQL не может изменить amount, даже без смены статуса.
    await assert.rejects(() => db.execute(`UPDATE restaurant_payouts SET amount = 1 WHERE id = $1`, [payout.id]), /amount is immutable/i);

    // Легитимный переход статуса (без затрагивания amount) по-прежнему работает.
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    const { payout: processing } = await payoutService.markAttemptSubmitting(attempt.id);
    assert.equal(processing.status, 'processing');
    assert.equal(processing.amount, 930, 'amount не должен был измениться при легитимном переходе статуса');

    // processing — тоже неизменяем.
    await assert.rejects(() => db.execute(`UPDATE restaurant_payouts SET amount = 2 WHERE id = $1`, [payout.id]), /amount is immutable/i);

    await payoutService.markAttemptProcessing(attempt.id);
    const { payout: blocked } = await payoutService.markAttemptFailed(attempt.id, { errorMessage: 'реквизиты некорректны', retryable: false });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.amount, 930);

    // blocked — НЕ terminal (можно менять notes, задание Stage 9.5), но amount
    // всё равно неизменяем — новая находка F2 распространяется на ВСЕ статусы.
    await db.execute(`UPDATE restaurant_payouts SET notes = 'заметка оператора' WHERE id = $1`, [payout.id]);
    const rereadNotes = await payoutService.getPayoutById(payout.id);
    assert.equal(rereadNotes.notes, 'заметка оператора', 'правка notes должна оставаться разрешённой для blocked');
    await assert.rejects(() => db.execute(`UPDATE restaurant_payouts SET amount = 3 WHERE id = $1`, [payout.id]), /amount is immutable/i);

    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, true);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// Находка F3 — payout_attempts CHECK требует error_message И retryable при
// status='failed' (не только failed_at, как было раньше)
// ===========================================================================
test('Stage9.8 F3: failed-попытка на уровне схемы обязана иметь error_message И retryable, не только failed_at', async () => {
  const databaseUrl = await freshDatabase('stage98_failed_check');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'FailedCheck');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);

    // failed_at задан, но error_message/retryable — нет: должно быть отклонено.
    await assert.rejects(() => db.execute(
      `UPDATE payout_attempts SET status = 'failed', failed_at = NOW() WHERE id = $1`,
      [attempt.id],
    ), /violates check|payout_attempts_failed_requires_reason_check/i);

    // failed_at + error_message заданы, но retryable — нет: тоже отклонено.
    await assert.rejects(() => db.execute(
      `UPDATE payout_attempts SET status = 'failed', failed_at = NOW(), error_message = 'тест' WHERE id = $1`,
      [attempt.id],
    ), /violates check|payout_attempts_failed_requires_reason_check/i);

    // Попытка должна была остаться нетронутой (обе неудачные транзакции откатились).
    const stillSubmitting = await payoutService.getAttemptById(attempt.id);
    assert.equal(stillSubmitting.status, 'submitting');

    // Через сервисный слой (который ВСЕГДА передаёт оба поля) — по-прежнему работает.
    const { attempt: failed } = await payoutService.markAttemptFailed(attempt.id, { errorMessage: 'сбой шлюза', retryable: true });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_message, 'сбой шлюза');
    assert.equal(failed.retryable, true);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.8 F3 (усиление): failed-попытка с error_message из одних пробелов отклоняется CHECK', async () => {
  const databaseUrl = await freshDatabase('stage98_failed_blank_check');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'FailedBlankCheck');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);

    // failed_at + retryable заданы, error_message = '   ' (только пробелы):
    // NOT NULL проходит, но btrim(...) <> '' — нет. Должно быть отклонено.
    await assert.rejects(() => db.execute(
      `UPDATE payout_attempts SET status = 'failed', failed_at = NOW(), error_message = '   ', retryable = true WHERE id = $1`,
      [attempt.id],
    ), /violates check|payout_attempts_failed_requires_reason_check/i);

    // Попытка осталась нетронутой (транзакция откатилась).
    const stillSubmitting = await payoutService.getAttemptById(attempt.id);
    assert.equal(stillSubmitting.status, 'submitting');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.8 F3: миграционный backfill (Stage 9 -> 9.5, legacy failed-строки) по-прежнему проходит новый CHECK', async () => {
  // Backfill (Stage 9.5 секция schema.sql) синтезирует историческую попытку
  // ИЗ restaurant_payouts.status='failed' — этот статус обязательства
  // существовал ТОЛЬКО в Stage 9 (Stage 9.5 уже убрала 'failed' из
  // restaurant_payouts_status_check), поэтому фикстура здесь — именно
  // pre-9.5 (Stage 9), а не pre-9.6 (Stage 9.5, где 'failed' у обязательства
  // уже не существует). Проверяем узко: error_message (из failure_reason)
  // и retryable=FALSE, которые backfill всегда проставляет, удовлетворяют
  // НОВОМУ CHECK'у Stage 9.8.
  const OLD_STAGE9_SCHEMA_SQL = fs.readFileSync(
    path.join(__dirname, 'fixtures/stage9-pre-9.5-schema.sql'), 'utf8',
  );
  await cluster.createDatabase('stage98_backfill_check');
  const setupClient = cluster.getClient('stage98_backfill_check');
  await setupClient.connect();
  await setupClient.query(OLD_STAGE9_SCHEMA_SQL);

  process.env.DATABASE_URL = cluster.connectionString('stage98_backfill_check');
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restaurantId = await createRestaurant(db, 'BackfillCheck98');
    // Stage 33.1 — как и Stage9.6 #3 (hqTBankReadinessStage96.test.js):
    // OLD_STAGE9_SCHEMA_SQL — застывший снимок ДО earned_at (Stage 33.1,
    // миграция 0013), а createOrderRow/settlementService.closeSettlementPeriod
    // уже безусловно читают/пишут orders.earned_at. Тест проверяет ТОЛЬКО
    // backfill попыток выплат при миграции — не корректность расчёта
    // периода, поэтому period/order-line здесь собираются напрямую SQL.
    const orderRows = await db.execute(
      `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at)
       VALUES ('YAAM-98BACKFILL',$1,'Грозный','Тест','+79080000000','адрес',1000,70,'delivered',NOW()) RETURNING id`,
      [restaurantId],
    );
    const orderId = orderRows.rows[0].id;
    await addSucceededPayment(db, orderId, 1000);
    const periodRows = await db.execute(
      `INSERT INTO settlement_periods (period_from, period_to, status, closed_at) VALUES ($1,$1,'closed',NOW()) RETURNING id`,
      [todayStr()],
    );
    const period = { id: periodRows.rows[0].id };
    await db.execute(
      `INSERT INTO settlement_restaurant_lines
         (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission, restaurant_earnings, payable_amount, payout_readiness_snapshot)
       VALUES ($1,$2,1,1000,70,930,930,'{}')`,
      [period.id, restaurantId],
    );
    await db.execute(
      `INSERT INTO settlement_order_lines
         (settlement_period_id, restaurant_id, order_id, items_total_snapshot, commission_amount_snapshot, restaurant_amount_snapshot, delivered_at_snapshot)
       VALUES ($1,$2,$3,1000,70,930,NOW())`,
      [period.id, restaurantId, orderId],
    );
    const payoutRows = await db.execute(
      `INSERT INTO restaurant_payouts (restaurant_id, settlement_period_id, amount, status, failed_at, failure_reason)
       VALUES ($1,$2,930,'failed',NOW(),'Провайдер отклонил перевод') RETURNING id`,
      [restaurantId, period.id],
    );
    const payoutId = payoutRows.rows[0].id;
    await db.close();
    delete process.env.DATABASE_URL;

    // Применяем НОВЫЙ schema.sql (Stage 9.5 backfill + Stage 9.8 CHECK) поверх той же базы.
    await setupClient.query(SCHEMA_SQL);

    process.env.DATABASE_URL = cluster.connectionString('stage98_backfill_check');
    delete require.cache[require.resolve('../../db/postgresql')];
    const dbAfter = require('../../db/postgresql');
    const attempts = await dbAfter.query('SELECT * FROM payout_attempts WHERE payout_id = $1', [payoutId]);
    assert.equal(attempts.length, 1, 'backfill должен был создать ровно одну историческую попытку, не нарушив новый CHECK');
    assert.equal(attempts[0].status, 'failed');
    assert.equal(attempts[0].error_message, 'Провайдер отклонил перевод');
    assert.equal(attempts[0].retryable, false);
    await dbAfter.close();
    delete process.env.DATABASE_URL;
  } finally {
    delete process.env.DATABASE_URL;
    await setupClient.end();
  }
});

// ===========================================================================
// Находка F7 — checkPayoutInvariants() обнаруживает processing без processing_at
// ===========================================================================
test('Stage9.8 F7: checkPayoutInvariants обнаруживает processing-обязательство без processing_at (ручная порча данных)', async () => {
  const databaseUrl = await freshDatabase('stage98_processing_at_invariant');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'ProcessingAtInvariant');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    // Прямой SQL — обходит сервисный слой (markAttemptSubmitting ВСЕГДА
    // проставляет processing_at атомарно с переходом), физически создаёт
    // рассогласование, недостижимое иначе.
    await db.execute(`UPDATE restaurant_payouts SET status = 'processing' WHERE id = $1`, [payout.id]);

    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, false);
    assert.ok(
      invariants.violations.some((v) => v.kind === 'processing_without_processing_at'),
      `ожидали processing_without_processing_at среди нарушений: ${JSON.stringify(invariants.violations)}`,
    );

    // Контрастная проверка: нормальный переход через сервис НЕ должен
    // срабатывать на этот инвариант (processing_at проставлен атомарно).
    const restaurantId2 = await createRestaurant(db, 'ProcessingAtOk');
    await seedFullReadiness(db, restaurantId2);
    const period2 = await closedPeriodWithEarnings(db, settlementService, restaurantId2, { dayOffset: -1 });
    const payout2 = await payoutService.prepareRestaurantPayout(period2.id, restaurantId2);
    const attempt2 = await payoutService.createPayoutAttempt(payout2.id);
    await payoutService.markAttemptSubmitting(attempt2.id);
    const invariantsAfterLegit = await payoutService.checkPayoutInvariants();
    // Не "нет нарушений вообще" — restaurantId (испорченная строка выше)
    // остаётся в ТОЙ ЖЕ базе и по-прежнему обязана флагироваться (count=1).
    // Проверяем, что count НЕ ВЫРОС до 2 — т.е. легитимный переход
    // restaurantId2 НЕ добавил себя в список нарушений.
    const violationAfterLegit = invariantsAfterLegit.violations.find((v) => v.kind === 'processing_without_processing_at');
    assert.equal(
      violationAfterLegit && violationAfterLegit.count,
      1,
      'легитимный переход в processing через сервис не должен ложно флагаться (count должен остаться 1, только от испорченной строки выше)',
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// Контрольная проверка (не новая находка, а подтверждение того, что второй
// пункт задания раздела 4 — "processing/unknown без корректной active
// attempt" — уже реализован в Stage 9.6 и НЕ регрессировал в Stage 9.8).
// ===========================================================================
test('Stage9.8: processing/unknown без active attempt (уже реализовано в Stage 9.6) — без регрессии', async () => {
  const databaseUrl = await freshDatabase('stage98_active_attempt_no_regression');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'ActiveAttemptNoRegression');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    await db.execute(`UPDATE restaurant_payouts SET status = 'processing', processing_at = NOW() WHERE id = $1`, [payout.id]);

    const invariants = await payoutService.checkPayoutInvariants();
    assert.ok(invariants.violations.some((v) => v.kind === 'processing_without_active_attempt'));
    // processing_at был задан явно — этот инвариант НЕ должен сработать здесь.
    assert.ok(!invariants.violations.some((v) => v.kind === 'processing_without_processing_at'));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
