'use strict';

// Закрытие официального блокера по статусам H2H-выплат Т-Банка (поддержка
// подтвердила ровно 4 значения: IN_PROGRESS/EXECUTED/FAILED/CANCELLED) —
// см. server/services/hq/tbankPayoutStatusMapper.js. Никакого HTTP-клиента
// к Т-Банку, никакого webhook/polling здесь нет и не появляется — только
// применение уже полученного статуса к payout_attempts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('tbank-payout-status-mapper');
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
  delete require.cache[require.resolve('../../services/hq/tbankPayoutStatusMapper')];
  return {
    db: require('../../db/postgresql'),
    settlementService: require('../../services/hq/settlementService'),
    payoutService: require('../../services/hq/payoutService'),
    statusMapper: require('../../services/hq/tbankPayoutStatusMapper'),
  };
}

// -----------------------------------------------------------------------
// Fixtures — тот же стиль, что и hqPayoutStage98.test.js.
// -----------------------------------------------------------------------

async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70 }) {
  orderCounter += 1;
  const code = `YAAM-TBM${orderCounter}`;
  const phone = `+7906${String(orderCounter).padStart(7, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // фикстура пишет напрямую SQL, поэтому сама выставляет earned_at = NOW()
  // ровно когда status='delivered' (тот же принцип, что и backfill в
  // миграции 0013).
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,NOW(), CASE WHEN $6 = 'delivered' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status],
  );
  return rows.rows[0].id;
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}

async function closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal = 1000, commissionAmount = 70 } = {}) {
  const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal, commissionAmount });
  await addSucceededPayment(db, orderId, itemsTotal);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}

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

// Готовит попытку в статусе 'submitting' (первый реалистичный момент, когда
// внешний статус вообще может прийти) — общий сетап для большинства тестов.
async function setupSubmittingAttempt(db, settlementService, payoutService, label) {
  const restaurantId = await createRestaurant(db, label);
  await seedFullReadiness(db, restaurantId);
  const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
  const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
  const attempt = await payoutService.createPayoutAttempt(payout.id);
  await payoutService.markAttemptSubmitting(attempt.id);
  return { restaurantId, payout, attemptId: attempt.id };
}

function withCapturedConsoleError(fn) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args); };
  return fn(calls).finally(() => { console.error = original; });
}

// ===========================================================================
// 1. Строгая раскладка внешний -> внутренний статус
// ===========================================================================

test('IN_PROGRESS -> processing (обязательство и попытка)', async () => {
  const databaseUrl = await freshDatabase('tbm_in_progress');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'InProgress');
    const result = await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    assert.equal(result.action, 'processing');
    assert.equal(result.attempt.status, 'processing');
    assert.equal(result.attempt.bank_status, 'IN_PROGRESS');
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'processing');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('EXECUTED -> succeeded — единственный статус, означающий успешное завершение', async () => {
  const databaseUrl = await freshDatabase('tbm_executed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'Executed');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    const result = await statusMapper.applyTBankPayoutStatus(attemptId, 'EXECUTED');
    assert.equal(result.action, 'succeeded');
    assert.equal(result.attempt.status, 'succeeded');
    assert.equal(result.attempt.bank_status, 'EXECUTED');
    assert.ok(result.attempt.completed_at, 'succeeded обязана иметь completed_at');
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'succeeded');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('FAILED -> failed, обязательство уходит в blocked (retryable по умолчанию false — без автоматического повтора)', async () => {
  const databaseUrl = await freshDatabase('tbm_failed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'Failed');
    const result = await statusMapper.applyTBankPayoutStatus(attemptId, 'FAILED');
    assert.equal(result.action, 'failed');
    assert.equal(result.attempt.status, 'failed');
    assert.equal(result.attempt.bank_status, 'FAILED');
    assert.equal(result.attempt.error_code, 'FAILED');
    assert.equal(result.attempt.retryable, false);
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'blocked');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('CANCELLED -> failed (та же обработка, что FAILED) — различие сохраняется в bank_status/error_code, не теряется', async () => {
  const databaseUrl = await freshDatabase('tbm_cancelled');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'Cancelled');
    const result = await statusMapper.applyTBankPayoutStatus(attemptId, 'CANCELLED');
    assert.equal(result.action, 'failed');
    assert.equal(result.attempt.status, 'failed');
    assert.equal(result.attempt.bank_status, 'CANCELLED', 'исходное значение CANCELLED не должно теряться/подменяться на FAILED');
    assert.equal(result.attempt.error_code, 'CANCELLED');
    assert.match(result.attempt.error_message, /отменена/i);
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'blocked');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// 2. IN_PROGRESS не завершает выплату и не разрешает повторную отправку
// ===========================================================================

test('IN_PROGRESS не переводит попытку/обязательство в succeeded или любой terminal статус', async () => {
  const databaseUrl = await freshDatabase('tbm_in_progress_not_terminal');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'InProgressNotTerminal');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    const attempt = await payoutService.getAttemptById(attemptId);
    assert.equal(attempt.status, 'processing');
    assert.equal(payoutService.ATTEMPT_TERMINAL_STATUSES.includes(attempt.status), false);
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'processing');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('IN_PROGRESS не разрешает вторую одновременную попытку выплаты (существующий partial unique index)', async () => {
  const databaseUrl = await freshDatabase('tbm_in_progress_no_second_attempt');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'NoSecondAttempt');
    const firstAttempt = await payoutService.getAttemptById((await payoutService.listAttemptsForPayout(payout.id))[0].id);
    await statusMapper.applyTBankPayoutStatus(firstAttempt.id, 'IN_PROGRESS');
    // Обязательство сейчас 'processing' (не prepared/blocked) — существующий
    // createPayoutAttempt() уже не должен разрешать вторую попытку поверх
    // активной processing-попытки. Мы ничего не меняли в этой проверке —
    // подтверждаем отсутствие регрессии после добавления status-mapper'а.
    await assert.rejects(() => payoutService.createPayoutAttempt(payout.id));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// 3. Неизвестный внешний статус — fail-safe
// ===========================================================================

test('Неизвестный внешний статус: не успех, попытка помечается unknown (ручная проверка), исходное значение сохраняется, структурированный лог', async () => {
  const databaseUrl = await freshDatabase('tbm_unknown_status');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'UnknownStatus');
    const calls = [];
    const result = await withCapturedConsoleError(async (capturedCalls) => {
      const r = await statusMapper.applyTBankPayoutStatus(attemptId, 'SOME_NEW_STATUS_FROM_BANK');
      calls.push(...capturedCalls);
      return r;
    });
    assert.equal(result.action, 'flagged_for_manual_review');
    assert.equal(result.attempt.status, 'unknown', 'нераспознанный статус должен переводить попытку в unknown (ручная проверка), не в succeeded/failed');
    assert.equal(result.attempt.bank_status, 'SOME_NEW_STATUS_FROM_BANK', 'исходное значение обязано сохраниться дословно');
    assert.match(result.attempt.error_message, /SOME_NEW_STATUS_FROM_BANK/);
    assert.equal(calls.length >= 1, true, 'обязан быть хотя бы один структурированный console.error');
    const [, logPayload] = calls[0];
    assert.equal(logPayload.attemptId, attemptId);
    assert.equal(logPayload.externalStatus, 'SOME_NEW_STATUS_FROM_BANK');
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'unknown');
    assert.notEqual(reloadedPayout.status, 'succeeded');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Неизвестный статус НЕ создаёт автоматический повтор — обязательство не в prepared, вторая попытка невозможна', async () => {
  const databaseUrl = await freshDatabase('tbm_unknown_no_retry');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId, payout } = await setupSubmittingAttempt(db, settlementService, payoutService, 'UnknownNoRetry');
    await withCapturedConsoleError(async () => statusMapper.applyTBankPayoutStatus(attemptId, 'WHATEVER'));
    const reloadedPayout = await payoutService.getPayoutById(payout.id);
    assert.equal(reloadedPayout.status, 'unknown');
    await assert.rejects(() => payoutService.createPayoutAttempt(payout.id), 'unknown-обязательство не должно молча разрешать вторую попытку');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Неизвестный статус на уже терминальной (succeeded) попытке — игнорируется, ничего не меняет', async () => {
  const databaseUrl = await freshDatabase('tbm_unknown_on_terminal');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId } = await setupSubmittingAttempt(db, settlementService, payoutService, 'UnknownOnTerminal');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'EXECUTED');
    const result = await withCapturedConsoleError(() => statusMapper.applyTBankPayoutStatus(attemptId, 'MYSTERY'));
    assert.equal(result.action, 'ignored_unknown_status_on_terminal_attempt');
    const attempt = await payoutService.getAttemptById(attemptId);
    assert.equal(attempt.status, 'succeeded', 'терминальная попытка неизменяема — неизвестный статус не должен был её тронуть');
    assert.equal(attempt.bank_status, 'EXECUTED', 'bank_status не должен был перезаписаться значением MYSTERY');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// 4. Идемпотентность повторных webhook/poll-ответов
// ===========================================================================

test('Идемпотентность: повторный EXECUTED после уже succeeded — тихий no-op, не ошибка', async () => {
  const databaseUrl = await freshDatabase('tbm_idempotent_executed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId } = await setupSubmittingAttempt(db, settlementService, payoutService, 'IdempotentExecuted');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    const first = await statusMapper.applyTBankPayoutStatus(attemptId, 'EXECUTED');
    assert.equal(first.action, 'succeeded');
    const second = await statusMapper.applyTBankPayoutStatus(attemptId, 'EXECUTED');
    assert.equal(second.action, 'idempotent_noop', 'повторная доставка ТОГО ЖЕ финального статуса не должна бросать ошибку "гонка"');
    const attempt = await payoutService.getAttemptById(attemptId);
    assert.equal(attempt.status, 'succeeded');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Идемпотентность: повторный FAILED после уже failed — тихий no-op', async () => {
  const databaseUrl = await freshDatabase('tbm_idempotent_failed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId } = await setupSubmittingAttempt(db, settlementService, payoutService, 'IdempotentFailed');
    const first = await statusMapper.applyTBankPayoutStatus(attemptId, 'FAILED');
    assert.equal(first.action, 'failed');
    const second = await statusMapper.applyTBankPayoutStatus(attemptId, 'FAILED');
    assert.equal(second.action, 'idempotent_noop');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Идемпотентность: повторный CANCELLED после уже failed(CANCELLED) — тихий no-op (тот же internal target)', async () => {
  const databaseUrl = await freshDatabase('tbm_idempotent_cancelled');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId } = await setupSubmittingAttempt(db, settlementService, payoutService, 'IdempotentCancelled');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'CANCELLED');
    const second = await statusMapper.applyTBankPayoutStatus(attemptId, 'CANCELLED');
    assert.equal(second.action, 'idempotent_noop');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Идемпотентность: повторный IN_PROGRESS, пока уже processing — тихий no-op, не гонка', async () => {
  const databaseUrl = await freshDatabase('tbm_idempotent_in_progress');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId } = await setupSubmittingAttempt(db, settlementService, payoutService, 'IdempotentInProgress');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    const second = await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    assert.equal(second.action, 'idempotent_noop', 'повторный IN_PROGRESS на уже processing-попытке идёт через тот же общий idempotent-check, что и терминальные статусы');
    const attempt = await payoutService.getAttemptById(attemptId);
    assert.equal(attempt.status, 'processing');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Конфликт: терминальная (succeeded) попытка сообщает FAILED — не перезаписывается, только лог', async () => {
  const databaseUrl = await freshDatabase('tbm_conflict_terminal');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, statusMapper } = requireFreshModules();
  try {
    const { attemptId } = await setupSubmittingAttempt(db, settlementService, payoutService, 'ConflictTerminal');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'IN_PROGRESS');
    await statusMapper.applyTBankPayoutStatus(attemptId, 'EXECUTED');
    const result = await withCapturedConsoleError(() => statusMapper.applyTBankPayoutStatus(attemptId, 'FAILED'));
    assert.equal(result.action, 'conflict_terminal_status_mismatch');
    const attempt = await payoutService.getAttemptById(attemptId);
    assert.equal(attempt.status, 'succeeded', 'уже зафиксированный успех не должен быть перезаписан противоречащим статусом');
    assert.equal(attempt.bank_status, 'EXECUTED');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// 5. Прочее
// ===========================================================================

test('Несуществующая попытка выплаты — явная ошибка 404, а не тихий no-op', async () => {
  const databaseUrl = await freshDatabase('tbm_missing_attempt');
  process.env.DATABASE_URL = databaseUrl;
  const { db, statusMapper } = requireFreshModules();
  try {
    await assert.rejects(
      () => statusMapper.applyTBankPayoutStatus(999999, 'EXECUTED'),
      (err) => err instanceof statusMapper.UnknownAttemptError && err.statusCode === 404,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('KNOWN_EXTERNAL_STATUSES содержит ровно 4 подтверждённых значения, ничего больше', () => {
  const { statusMapper } = requireFreshModules();
  assert.deepEqual(
    [...statusMapper.KNOWN_EXTERNAL_STATUSES].sort(),
    ['CANCELLED', 'EXECUTED', 'FAILED', 'IN_PROGRESS'],
  );
});
