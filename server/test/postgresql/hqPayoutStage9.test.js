'use strict';

// YAAM HQ Stage 9 / 9.5 — Payout Entity + Payout Attempts Foundation (NO bank
// integration). Интеграционные тесты против настоящего embedded PostgreSQL
// (тот же harness, что и Stage 7/7.1/8/9). Тесты A-E — Stage 9 (обязательство,
// без изменений в Stage 9.5 — раздел "Preserve the obligation model"). Тесты
// "Stage9.5 #N" — новые сценарии из задания Stage 9.5, раздел 14 (ровно 20
// пронумерованных сценариев); дополнительные тесты (audit log, migration)
// добавлены сверх этого списка, где задание требует их отдельно (разделы
// 12/13), но не включает в нумерацию раздела 14.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const OLD_STAGE9_SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, 'fixtures/stage9-pre-9.5-schema.sql'), 'utf8',
);

const HQ_MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/lifecycle.js'),
  require.resolve('../../services/postgresql/health.js'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../services/hq/ownerService.js'),
  require.resolve('../../services/hq/securityLog.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/hq/restaurantStatsService.js'),
  require.resolve('../../services/hq/menuAdminService.js'),
  require.resolve('../../services/hq/restaurantAdminService.js'),
  require.resolve('../../services/hq/media/photoService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  // Stage 9.6 — T-Bank integration readiness.
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/tbankPayoutReadiness.js'),
  require.resolve('../../services/hq/tbankRequestMapper.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/settlements.js'),
  require.resolve('../../routes/hq/payouts.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'j'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage9Payout';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-payout-stage9');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
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

function reloadHqAppModule() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  return require('../../services/postgresql/app.js');
}

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице');
  return m[1];
}
async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer никогда не начал слушать');
}
async function startApp(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete process.env.MEDIA_PROVIDER;
  process.env.APP_ENV = 'local';
  const appModule = reloadHqAppModule();
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, port, base: `http://127.0.0.1:${port}` };
}
async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
}
async function loginHq(base) {
  const loginRes = await fetch(`${base}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD }).toString(),
  });
  return cookieHeaderFrom(postRes) || cookie;
}

// Stage 9.6 — payoutService.js теперь ТАКЖЕ требует yaamBankDetailsService/
// restaurantBankDetailsService/restaurantContractService/tbankPayoutReadiness
// (для immutable snapshot реквизитов). Реальный баг, найденный этим же
// тестированием: если их require.cache НЕ очищать здесь, каждый из этих
// модулей навсегда сохраняет ссылку на db/postgresql ИЗ ТОГО теста, где он
// был впервые загружен (обычно самый первый тест файла) — на всех
// последующих тестах (со своей свежей embedded-базой) это приводит к
// незаметному запросу через чужой, не связанный с текущим тестом db-модуль.
// Тот же принцип очистки кэша, что уже применялся к db/settlementService/
// payoutService, теперь распространён на все новые зависимости.
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

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------
async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null }) {
  orderCounter += 1;
  const code = `YAAM-PO${orderCounter}`;
  const phone = `+7903${String(orderCounter).padStart(7, '0')}`;
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,COALESCE($7, NOW()))
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status, statusUpdatedAt],
  );
  return rows.rows[0].id;
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}
async function addRefund(db, paymentId, { amount, status = 'succeeded', reason = 'customer_cancel' }) {
  const crypto = require('node:crypto');
  const key = `refund-key-${paymentId}-${crypto.randomBytes(4).toString('hex')}`;
  const rows = await db.execute(
    `INSERT INTO refunds (payment_id, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id`,
    [paymentId, amount, status, reason, key],
  );
  return rows.rows[0].id;
}

// ---------------------------------------------------------------------------
// Stage 9.6 — реквизиты для готовности createPayoutAttempt (задание, раздел
// 5: попытка не может быть создана без immutable snapshot реквизитов).
// Заведомо вымышленные, но математически корректные значения (та же
// фикстура, что и test/postgresql/hqRestaurantLegalBankStage6.test.js —
// FICTITIOUS_BIK/RS/KS уже проверены там на реальную контрольную сумму
// БИК/счёта; переиспользуются, а не изобретаются заново).
// ---------------------------------------------------------------------------
const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616'; // ИП, валидная контрольная сумма
const FICTITIOUS_INN10 = '7709123453'; // ООО, валидная контрольная сумма
const FICTITIOUS_KPP = '770101001';

async function seedYaamBankDetails(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, 'ООО YAAM Платформа', $1, $2, $3, $4, 'ТЕСТБАНК', $5)
     ON CONFLICT (id) DO NOTHING`,
    [FICTITIOUS_INN10, FICTITIOUS_KPP, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
}

// Готовит ресторан к созданию попыток: реквизиты YAAM (singleton, один раз
// на базу) + банковские реквизиты ресторана (ИП без КПП — упражняет '' ->
// '0' трансформацию) + подписанный договор с номером (нужен для
// buildPaymentPurpose, если default_payment_purpose не задан явно).
async function seedRestaurantPayoutReadiness(db, restaurantId, { defaultPurpose = 'Оплата услуг доставки по договору' } = {}) {
  await seedYaamBankDetails(db);
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account, default_payment_purpose)
     VALUES ($1, 'ИП Тестов Тест Тестович', $2, '', $3, $4, 'ТЕСТБАНК', $5, $6)`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS, defaultPurpose],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1, $2, '2026-01-01', 'signed')`,
    [restaurantId, `Д-${restaurantId}`],
  );
}

// Готовит закрытый период с одним заработанным заказом на ресторан — общая
// фикстура для большинства тестов ниже.
async function closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal = 1000, commissionAmount = 70, dayOffset = 0 } = {}) {
  const orderId = await createOrderRow(db, {
    restaurantId, status: 'delivered', itemsTotal, commissionAmount,
    statusUpdatedAt: dayOffset ? new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000) : null,
  });
  await addSucceededPayment(db, orderId, itemsTotal);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(dayOffset), periodTo: todayStr(dayOffset) });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}

// Доводит только что prepareRestaurantPayout()-нную выплату до status
// 'processing' с первой попыткой в статусе 'processing' — общая отправная
// точка для многих тестов ниже (created -> submitting -> processing).
async function toFirstAttemptProcessing(payoutService, payoutId) {
  const attempt = await payoutService.createPayoutAttempt(payoutId);
  await payoutService.markAttemptSubmitting(attempt.id);
  const { attempt: processing, payout } = await payoutService.markAttemptProcessing(attempt.id);
  return { attempt: processing, payout };
}

// ---------------------------------------------------------------------------
// A-E: prepareRestaurantPayout (Stage 9, БЕЗ ИЗМЕНЕНИЙ в Stage 9.5 — задание,
// раздел 2: "Preserve the obligation model")
// ---------------------------------------------------------------------------
test('A: prepareRestaurantPayout отклоняет создание для НЕ закрытого периода', async () => {
  const databaseUrl = await freshDatabase('payout_period_not_closed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'A');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered' });
    await addSucceededPayment(db, orderId, 1000);
    const draft = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await assert.rejects(() => payoutService.prepareRestaurantPayout(draft.id, restaurantId), /период ещё не закрыт|нет зафиксированной строки/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B: prepareRestaurantPayout отклоняет создание для ресторана без активности в периоде', async () => {
  const databaseUrl = await freshDatabase('payout_no_line');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantWithActivity = await createRestaurant(db, 'B-active');
    const restaurantWithoutActivity = await createRestaurant(db, 'B-idle');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantWithActivity);
    await assert.rejects(
      () => payoutService.prepareRestaurantPayout(period.id, restaurantWithoutActivity),
      /нет зафиксированной строки/i,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C: prepareRestaurantPayout отклоняет создание при payable_amount <= 0', async () => {
  const databaseUrl = await freshDatabase('payout_zero_amount');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'C');
    const cancelledOrder = await createOrderRow(db, { restaurantId, status: 'cancelled', itemsTotal: 500, commissionAmount: 0 });
    const paymentId = await addSucceededPayment(db, cancelledOrder, 500);
    await addRefund(db, paymentId, { amount: 500 });

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    const closeResult = await settlementService.closeSettlementPeriod(period.id);
    assert.equal(closeResult.lines[0].payable_amount, 0, 'предпосылка теста: payable_amount должен быть 0');

    await assert.rejects(() => payoutService.prepareRestaurantPayout(period.id, restaurantId), /не положительна/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('D: prepareRestaurantPayout создаёт payout с amount, скопированным из settlement_restaurant_lines.payable_amount, никогда не пересчитывается (задание Stage 9.5, сценарий #16)', async () => {
  const databaseUrl = await freshDatabase('payout_create_success');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'D');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal: 1000, commissionAmount: 70 });

    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId, { createdBy: 'owner', notes: 'первая выплата' });
    assert.equal(payout.status, 'prepared');
    assert.equal(payout.amount, 930, 'должно совпасть ровно с payable_amount (1000-70), не пересчитано заново');
    assert.equal(payout.created_by, 'owner');
    assert.equal(payout.notes, 'первая выплата');
    assert.ok(payout.prepared_at);
    assert.equal(payout.processing_at, null);
    assert.equal(payout.completed_at, null);

    // Полный цикл нескольких попыток НЕ должен ни разу изменить amount —
    // ни при создании попытки, ни при её провале, ни при успехе.
    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt1.id);
    await payoutService.markAttemptProcessing(attempt1.id);
    const { payout: afterFail } = await payoutService.markAttemptFailed(attempt1.id, { errorMessage: 'тест', retryable: true });
    assert.equal(afterFail.amount, 930, 'amount не должен измениться после провалившейся попытки');

    const attempt2 = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt2.id);
    await payoutService.markAttemptProcessing(attempt2.id);
    const { payout: afterSucceed } = await payoutService.markAttemptSucceeded(attempt2.id);
    assert.equal(afterSucceed.amount, 930, 'amount не должен измениться после успешной попытки');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('E: повторное prepareRestaurantPayout на ту же пару (период, ресторан) отклонено физически (UNIQUE), не только в коде', async () => {
  const databaseUrl = await freshDatabase('payout_duplicate');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'E');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    await assert.rejects(() => payoutService.prepareRestaurantPayout(period.id, restaurantId), /уже существует/i);

    const countRows = await db.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts WHERE settlement_period_id = $1 AND restaurant_id = $2', [period.id, restaurantId]);
    assert.equal(countRows[0].c, 1, 'не должно быть создано две строки');

    await assert.rejects(() => db.execute(
      `INSERT INTO restaurant_payouts (restaurant_id, settlement_period_id, amount) VALUES ($1,$2,930)`,
      [restaurantId, period.id],
    ), /duplicate key|unique/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// Stage 9.5 — 20 сценариев задания, раздел 14 (пронумерованы в том же порядке)
// ===========================================================================

// ---------------------------------------------------------------------------
// #1: migration — старые Stage 9 данные должны корректно смигрироваться
// (задание, раздел 13). Применяем OLD (pre-9.5) schema.sql к базе, руками
// вставляем реалистичные Stage 9 строки во ВСЕХ 4 старых статусах, затем
// применяем НОВЫЙ schema.sql (тот же файл содержит и rework, и backfill) —
// и проверяем результат. Затем повторно применяем НОВЫЙ schema.sql ещё раз,
// чтобы доказать идемпотентность (задание: "All migration logic must be
// idempotent").
// ---------------------------------------------------------------------------
test('Stage9.5 #1: миграция существующих Stage 9 строк (prepared/processing/succeeded/failed) в новую модель', async () => {
  await cluster.createDatabase('payout_migration');
  const setupClient = cluster.getClient('payout_migration');
  await setupClient.connect();
  await setupClient.query(OLD_STAGE9_SCHEMA_SQL);

  // Реалистичные Stage 9 фикстуры через реальный settlementService (схема
  // settlement_periods/settlement_restaurant_lines не менялась в Stage 9.5),
  // но restaurant_payouts вставляются НАПРЯМУЮ SQL — так же, как это делал
  // старый payoutService.prepareRestaurantPayout/markProcessing/markFailed,
  // чтобы не зависеть от уже переписанного нового payoutService.js.
  process.env.DATABASE_URL = cluster.connectionString('payout_migration');
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');

  const rPrepared = await createRestaurant(db, 'Mig-prepared');
  const rProcessing = await createRestaurant(db, 'Mig-processing');
  const rSucceeded = await createRestaurant(db, 'Mig-succeeded');
  const rFailedFromProcessing = await createRestaurant(db, 'Mig-failed-processing');
  const rFailedFromPrepared = await createRestaurant(db, 'Mig-failed-prepared');

  for (const rid of [rPrepared, rProcessing, rSucceeded, rFailedFromProcessing, rFailedFromPrepared]) {
    const orderId = await createOrderRow(db, { restaurantId: rid, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
  }
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
  await settlementService.closeSettlementPeriod(period.id);

  async function insertOldPayout(restaurantId, { status, processingAt = null, completedAt = null, failedAt = null, failureReason = null }) {
    const rows = await db.execute(
      `INSERT INTO restaurant_payouts
         (restaurant_id, settlement_period_id, amount, status, processing_at, completed_at, failed_at, failure_reason)
       VALUES ($1,$2,930,$3,$4,$5,$6,$7) RETURNING id`,
      [restaurantId, period.id, status, processingAt, completedAt, failedAt, failureReason],
    );
    return rows.rows[0].id;
  }

  const preparedId = await insertOldPayout(rPrepared, { status: 'prepared' });
  const processingId = await insertOldPayout(rProcessing, { status: 'processing', processingAt: new Date() });
  const succeededId = await insertOldPayout(rSucceeded, { status: 'succeeded', processingAt: new Date(Date.now() - 1000), completedAt: new Date() });
  const failedFromProcessingId = await insertOldPayout(rFailedFromProcessing, {
    status: 'failed', processingAt: new Date(Date.now() - 2000), failedAt: new Date(), failureReason: 'Провайдер отклонил перевод',
  });
  const failedFromPreparedId = await insertOldPayout(rFailedFromPrepared, {
    status: 'failed', failedAt: new Date(), failureReason: 'Реквизиты не прошли предварительную проверку',
  });

  await db.close();
  delete process.env.DATABASE_URL;

  // Применяем НОВЫЙ schema.sql (уже содержит и rework restaurant_payouts, и
  // backfill payout_attempts) поверх той же самой базы данных.
  await setupClient.query(SCHEMA_SQL);

  process.env.DATABASE_URL = cluster.connectionString('payout_migration');
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/payoutService')];
  const dbAfter = require('../../db/postgresql');
  const payoutServiceAfter = require('../../services/hq/payoutService');
  try {
    const [prepared, processing, succeeded, failedFromProcessing, failedFromPrepared] = await Promise.all(
      [preparedId, processingId, succeededId, failedFromProcessingId, failedFromPreparedId].map((id) => payoutServiceAfter.getPayoutById(id)),
    );

    assert.equal(prepared.status, 'prepared', 'prepared должен остаться нетронутым');
    assert.equal(processing.status, 'processing', 'processing должен остаться нетронутым');
    assert.equal(succeeded.status, 'succeeded', 'succeeded должен остаться нетронутым');
    assert.ok(succeeded.completed_at, 'completed_at succeeded-строки не должен потеряться');

    assert.equal(failedFromProcessing.status, 'blocked', 'старый failed должен стать blocked (задание, раздел 13)');
    assert.equal(failedFromProcessing.failure_reason, 'Провайдер отклонил перевод', 'failure_reason должен сохраниться как кэш');
    assert.ok(failedFromProcessing.failed_at, 'failed_at должен сохраниться');

    assert.equal(failedFromPrepared.status, 'blocked');
    assert.equal(failedFromPrepared.failure_reason, 'Реквизиты не прошли предварительную проверку');

    // Синтетические исторические попытки — ровно по одной на каждую бывшую
    // 'failed' строку, НИ ОДНОЙ на prepared/processing/succeeded.
    const attemptsProcessing = await payoutServiceAfter.listAttemptsForPayout(processingId);
    assert.equal(attemptsProcessing.length, 0);
    const attemptsPrepared = await payoutServiceAfter.listAttemptsForPayout(preparedId);
    assert.equal(attemptsPrepared.length, 0);
    const attemptsSucceeded = await payoutServiceAfter.listAttemptsForPayout(succeededId);
    assert.equal(attemptsSucceeded.length, 0);

    const attemptsA = await payoutServiceAfter.listAttemptsForPayout(failedFromProcessingId);
    assert.equal(attemptsA.length, 1);
    assert.equal(attemptsA[0].attempt_number, 1);
    assert.equal(attemptsA[0].status, 'failed');
    assert.equal(attemptsA[0].bank_status, null, 'задание: "Do not invent provider status"');
    assert.equal(attemptsA[0].retryable, false);
    assert.equal(attemptsA[0].payment_id, `legacy-payout-${failedFromProcessingId}`);
    assert.equal(attemptsA[0].error_message, 'Провайдер отклонил перевод');

    const attemptsB = await payoutServiceAfter.listAttemptsForPayout(failedFromPreparedId);
    assert.equal(attemptsB.length, 1);
    assert.equal(attemptsB[0].payment_id, `legacy-payout-${failedFromPreparedId}`);
    assert.equal(attemptsB[0].retryable, false);

    // РЕАЛЬНАЯ НАХОДКА этого этапа (Stage 9.6, задание раздел 2 — "Legacy
    // consistency"): legacy Stage 9 'processing' обязательство (rProcessing)
    // пережило миграцию БЕЗ ИЗМЕНЕНИЙ (status остаётся валидным значением в
    // новом enum), но под НОВОЙ семантикой "processing = есть активная
    // попытка" это обязательство больше не согласовано с реальностью — в
    // payout_attempts нет ни одной строки для него (payout_attempts вообще
    // не существовал, когда Stage 9 создавал такие строки). Задание ЯВНО
    // запрещает автоматически чинить это (запрещено молча переводить в
    // unknown; blocked — только если "это действительно безопасно") — ни
    // banк, ни статус, ни payment_id для такой исторической попытки
    // придумать невозможно честно. checkPayoutInvariants() ОБЯЗАН увидеть
    // это как нарушение — молчаливое "ok: true" здесь было бы неправильным
    // сокрытием реальной проблемы данных.
    const invariants = await payoutServiceAfter.checkPayoutInvariants();
    assert.equal(invariants.ok, false, 'legacy processing без active attempt ДОЛЖЕН быть обнаружен, не скрыт');
    assert.deepEqual(invariants.violations, [{ kind: 'processing_without_active_attempt', count: 1 }],
      'единственное найденное нарушение — legacy processing без попытки; никаких иных сюрпризов миграция вносить не должна');

    // Задокументированная РУЧНАЯ процедура восстановления (задание: "fail
    // closed и задокументировать ручную процедуру") — оператор, вручную
    // подтвердивший через внешние данные (банковская выписка, переписка),
    // что деньги не ушли, переводит строку в 'blocked' САМ, прямым SQL, с
    // пометкой в notes. Сервисный код НЕ делает это автоматически.
    await dbAfter.execute(
      `UPDATE restaurant_payouts SET status = 'blocked', notes = 'Ручной разбор Stage 9.6: legacy processing без attempt, деньги не подтверждены' WHERE id = $1`,
      [processingId],
    );
    const invariantsAfterManualReview = await payoutServiceAfter.checkPayoutInvariants();
    assert.equal(invariantsAfterManualReview.ok, true, 'после документированного ручного вмешательства инварианты снова чисты');

    await dbAfter.close();
    delete process.env.DATABASE_URL;

    // Идемпотентность: повторное применение НОВОГО schema.sql на уже
    // смигрированной (и вручную дообработанной) базе НЕ должно ни упасть с
    // ошибкой, ни задвоить попытки, ни отменить ручное решение оператора.
    await setupClient.query(SCHEMA_SQL);

    process.env.DATABASE_URL = cluster.connectionString('payout_migration');
    delete require.cache[require.resolve('../../db/postgresql')];
    delete require.cache[require.resolve('../../services/hq/payoutService')];
    const dbRerun = require('../../db/postgresql');
    const payoutServiceRerun = require('../../services/hq/payoutService');
    const attemptsARerun = await payoutServiceRerun.listAttemptsForPayout(failedFromProcessingId);
    assert.equal(attemptsARerun.length, 1, 'повторный прогон schema.sql не должен задваивать историческую попытку');
    const processingAfterRerun = await payoutServiceRerun.getPayoutById(processingId);
    assert.equal(processingAfterRerun.status, 'blocked', 'повторный прогон schema.sql не должен откатывать ручное решение оператора');
    const invariantsRerun = await payoutServiceRerun.checkPayoutInvariants();
    assert.equal(invariantsRerun.ok, true);
    await dbRerun.close();
  } finally {
    delete process.env.DATABASE_URL;
    await setupClient.end();
  }
});

// ---------------------------------------------------------------------------
// #2: multiple historical attempts per obligation — полный retry-цикл
// (провал с retryable=true -> новая попытка -> успех), обе попытки остаются
// видны в истории.
// ---------------------------------------------------------------------------
test('Stage9.5 #2: несколько исторических попыток на одно обязательство остаются видны после успеха', async () => {
  const databaseUrl = await freshDatabase('attempt_history');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Hist');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt1.id);
    await payoutService.markAttemptProcessing(attempt1.id, 'REJECTED');
    const { payout: afterFail } = await payoutService.markAttemptFailed(attempt1.id, {
      bankStatus: 'REJECTED', errorCode: 'insufficient_funds', errorMessage: 'Недостаточно средств на счёте банка-отправителя', retryable: true,
    });
    assert.equal(afterFail.status, 'prepared');

    const attempt2 = await payoutService.createPayoutAttempt(payout.id);
    assert.notEqual(attempt2.payment_id, attempt1.payment_id, 'новая попытка должна получить НОВЫЙ payment_id');
    assert.equal(attempt2.attempt_number, 2);
    await payoutService.markAttemptSubmitting(attempt2.id);
    await payoutService.markAttemptProcessing(attempt2.id, 'COMPLETED');
    const { payout: succeeded } = await payoutService.markAttemptSucceeded(attempt2.id, 'COMPLETED');
    assert.equal(succeeded.status, 'succeeded');
    assert.ok(succeeded.completed_at);

    const history = await payoutService.listAttemptsForPayout(payout.id);
    assert.equal(history.length, 2, 'обе попытки должны остаться в истории — ни одна не удаляется/не переписывается');
    assert.equal(history[0].attempt_number, 1);
    assert.equal(history[0].status, 'failed');
    assert.equal(history[0].error_message, 'Недостаточно средств на счёте банка-отправителя');
    assert.equal(history[1].attempt_number, 2);
    assert.equal(history[1].status, 'succeeded');

    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, true);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #3: no more than one active attempt per payout — И на уровне сервиса, И
// физически на уровне партиального UNIQUE-индекса (задание, раздел 5:
// "must be physically impossible").
// ---------------------------------------------------------------------------
test('Stage9.5 #3a: createPayoutAttempt отклоняет создание второй попытки, пока первая активна (сервисный уровень)', async () => {
  const databaseUrl = await freshDatabase('attempt_one_active_service');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'OneActive');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    await payoutService.createPayoutAttempt(payout.id); // status='created', уже активна
    await assert.rejects(() => payoutService.createPayoutAttempt(payout.id), /уже есть активная попытка/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.5 #3b: партиальный UNIQUE-индекс физически запрещает вторую активную попытку в обход сервисного слоя', async () => {
  const databaseUrl = await freshDatabase('attempt_one_active_db');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'OneActiveDb');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    assert.equal(attempt1.status, 'created');

    // Прямой SQL-обход всего сервисного слоя — доказывает, что ограничение
    // физическое (уровень БД), а не только проверка в JS до INSERT.
    await assert.rejects(() => db.execute(
      `INSERT INTO payout_attempts (payout_id, attempt_number, payment_id, status) VALUES ($1, 2, 'manual-bypass-attempt', 'created')`,
      [payout.id],
    ), /duplicate key|unique/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #4: payment_id uniqueness — физическое ограничение
// ---------------------------------------------------------------------------
test('Stage9.5 #4: payment_id уникален физически (UNIQUE), повторное использование отклоняется', async () => {
  const databaseUrl = await freshDatabase('payment_id_unique');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'PayIdUnique');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt1.id);
    await payoutService.markAttemptProcessing(attempt1.id);
    await payoutService.markAttemptFailed(attempt1.id, { errorMessage: 'тест', retryable: true });

    // Другая выплата (другой ресторан/период) НЕ должна иметь возможность
    // переиспользовать тот же payment_id, даже вручную через SQL.
    const restaurantId2 = await createRestaurant(db, 'PayIdUnique2');
    const period2 = await closedPeriodWithEarnings(db, settlementService, restaurantId2, { dayOffset: -1 });
    const payout2 = await payoutService.prepareRestaurantPayout(period2.id, restaurantId2);

    await assert.rejects(() => db.execute(
      `INSERT INTO payout_attempts (payout_id, attempt_number, payment_id, status) VALUES ($1, 1, $2, 'created')`,
      [payout2.id, attempt1.payment_id],
    ), /duplicate key|unique/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #5: sequential attempt_number
// ---------------------------------------------------------------------------
test('Stage9.5 #5a: attempt_number растёт последовательно 1, 2, 3 при повторных retryable-провалах', async () => {
  const databaseUrl = await freshDatabase('attempt_number_sequential');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Sequential');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    const numbers = [];
    for (let i = 0; i < 3; i += 1) {
      const attempt = await payoutService.createPayoutAttempt(payout.id);
      numbers.push(attempt.attempt_number);
      await payoutService.markAttemptSubmitting(attempt.id);
      await payoutService.markAttemptProcessing(attempt.id);
      await payoutService.markAttemptFailed(attempt.id, { errorMessage: `провал ${i + 1}`, retryable: true });
    }
    assert.deepEqual(numbers, [1, 2, 3]);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.5 #5b: checkPayoutInvariants обнаруживает пропуск в attempt_number (ручная порча данных)', async () => {
  const databaseUrl = await freshDatabase('attempt_number_gap');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Gap');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    // Обходим сервисный слой напрямую SQL, чтобы создать физически валидную
    // (никакое ограничение схемы это не запрещает), но логически испорченную
    // ситуацию — attempt_number=5 без предшествующих 1-4.
    await db.execute(
      `INSERT INTO payout_attempts (payout_id, attempt_number, payment_id, status) VALUES ($1, 5, 'manual-gap-attempt', 'created')`,
      [payout.id],
    );

    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, false);
    assert.ok(invariants.violations.some((v) => v.kind === 'non_sequential_attempt_numbers'));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #6: valid transitions — полный набор реально достижимых путей
// ---------------------------------------------------------------------------
test('Stage9.5 #6: валидные переходы попытки — submitting->unknown->processing->succeeded', async () => {
  const databaseUrl = await freshDatabase('valid_transitions_via_unknown');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'ValidUnknown');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    const attempt = await payoutService.createPayoutAttempt(payout.id);
    assert.equal(attempt.status, 'created');
    const { payout: afterSubmit } = await payoutService.markAttemptSubmitting(attempt.id);
    assert.equal(afterSubmit.status, 'processing', 'обязательство переходит в processing именно на submitting, не раньше');

    const { attempt: unknownAttempt, payout: unknownPayout } = await payoutService.markAttemptUnknown(attempt.id, 'нет ответа от банка за отведённое время');
    assert.equal(unknownAttempt.status, 'unknown');
    assert.equal(unknownPayout.status, 'unknown');

    const { attempt: backToProcessing, payout: payoutBackToProcessing } = await payoutService.markAttemptProcessing(attempt.id, 'IN_PROGRESS');
    assert.equal(backToProcessing.status, 'processing');
    assert.equal(backToProcessing.bank_status, 'IN_PROGRESS');
    assert.equal(payoutBackToProcessing.status, 'processing');

    const { attempt: succeeded, payout: succeededPayout } = await payoutService.markAttemptSucceeded(attempt.id, 'COMPLETED');
    assert.equal(succeeded.status, 'succeeded');
    assert.ok(succeeded.completed_at);
    assert.equal(succeededPayout.status, 'succeeded');
    assert.ok(succeededPayout.completed_at);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.5 #6b: unknown -> failed — валидный переход (неопределённость в итоге разрешилась отказом)', async () => {
  const databaseUrl = await freshDatabase('valid_unknown_to_failed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'UnknownFailed');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await payoutService.markAttemptUnknown(attempt.id, 'timeout');
    const { attempt: failed, payout: blocked } = await payoutService.markAttemptFailed(attempt.id, {
      errorMessage: 'Банк подтвердил: перевод не прошёл', retryable: false,
    });
    assert.equal(failed.status, 'failed');
    assert.equal(blocked.status, 'blocked');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #7: invalid transitions — сервисный уровень И уровень БД (defense in depth)
// ---------------------------------------------------------------------------
test('Stage9.5 #7a: created -> processing напрямую (минуя submitting) отклонён на сервисном уровне', async () => {
  const databaseUrl = await freshDatabase('invalid_created_to_processing');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'InvalidSkip');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await assert.rejects(() => payoutService.markAttemptProcessing(attempt.id), /разрешено только из "submitting" или "unknown"/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.5 #7b: succeeded -> любой другой статус отклонён (terminal, сервисный уровень)', async () => {
  const databaseUrl = await freshDatabase('invalid_from_succeeded');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'InvalidFromSucceeded');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const { attempt } = await toFirstAttemptProcessing(payoutService, payout.id);
    const { attempt: succeeded } = await payoutService.markAttemptSucceeded(attempt.id);
    await assert.rejects(() => payoutService.markAttemptProcessing(succeeded.id), /разрешено только из/i);
    await assert.rejects(() => payoutService.markAttemptFailed(succeeded.id, { errorMessage: 'x', retryable: true }), /разрешено только из/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('Stage9.5 #7c: невалидный переход попытки отклонён и НА УРОВНЕ БД напрямую (в обход сервиса)', async () => {
  const databaseUrl = await freshDatabase('invalid_db_level');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'InvalidDbLevel');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id); // status='created'

    // created -> succeeded напрямую через сырой SQL — граф переходов
    // fn_payout_attempts_valid_transition не разрешает такой прыжок.
    await assert.rejects(() => db.execute(
      `UPDATE payout_attempts SET status = 'succeeded', completed_at = NOW() WHERE id = $1`,
      [attempt.id],
    ), /invalid status transition/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #8: timeout/unknown never becomes failed automatically (задание, раздел 4,
// дословно: "timeout / exception / HTTP 500 alone must never cause failed")
// ---------------------------------------------------------------------------
test('Stage9.5 #8: markAttemptUnknown не переводит попытку в failed сама по себе; markAttemptFailed требует явных errorMessage/retryable', async () => {
  const databaseUrl = await freshDatabase('unknown_never_auto_failed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'NeverAutoFailed');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    const { attempt: unknown } = await payoutService.markAttemptUnknown(attempt.id, 'network timeout');
    assert.equal(unknown.status, 'unknown', 'попытка остаётся unknown — НЕ становится failed автоматически');

    // markAttemptFailed без errorMessage/retryable должен быть физически
    // невозможен вызвать "просто по таймауту" без осознанного решения.
    await assert.rejects(() => payoutService.markAttemptFailed(attempt.id, { retryable: true }), /errorMessage обязателен/i);
    await assert.rejects(() => payoutService.markAttemptFailed(attempt.id, { errorMessage: 'timeout' }), /retryable обязателен/i);
    await assert.rejects(() => payoutService.markAttemptFailed(attempt.id, { errorMessage: '   ', retryable: true }), /errorMessage обязателен/i);

    const stillUnknown = await payoutService.getAttemptById(attempt.id);
    assert.equal(stillUnknown.status, 'unknown', 'неудачные вызовы markAttemptFailed не должны были изменить статус');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #9: unknown blocks creation of new attempt
// ---------------------------------------------------------------------------
test('Stage9.5 #9: активная попытка в статусе unknown блокирует создание новой попытки', async () => {
  const databaseUrl = await freshDatabase('unknown_blocks_new_attempt');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'UnknownBlocks');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    const { payout: unknownPayout } = await payoutService.markAttemptUnknown(attempt.id, 'timeout');
    assert.equal(unknownPayout.status, 'unknown');

    await assert.rejects(() => payoutService.createPayoutAttempt(payout.id), /Нельзя создать попытку|уже есть активная попытка/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #10: processing blocks creation of new attempt
// ---------------------------------------------------------------------------
test('Stage9.5 #10: активная попытка в статусе processing блокирует создание новой попытки', async () => {
  const databaseUrl = await freshDatabase('processing_blocks_new_attempt');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'ProcessingBlocks');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    await toFirstAttemptProcessing(payoutService, payout.id);

    await assert.rejects(() => payoutService.createPayoutAttempt(payout.id), /Нельзя создать попытку|уже есть активная попытка/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #11: succeeded attempt makes parent succeeded
// ---------------------------------------------------------------------------
test('Stage9.5 #11: успешная попытка переводит обязательство в succeeded с реальной датой завершения', async () => {
  const databaseUrl = await freshDatabase('succeeded_attempt_parent');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'SucceededParent');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const before = Date.now();
    const { attempt } = await toFirstAttemptProcessing(payoutService, payout.id);
    const { payout: succeeded } = await payoutService.markAttemptSucceeded(attempt.id, 'COMPLETED');
    assert.equal(succeeded.status, 'succeeded');
    assert.ok(new Date(succeeded.completed_at).getTime() >= before);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #12: failed+retryable leaves obligation unpaid and allows new attempt
// ---------------------------------------------------------------------------
test('Stage9.5 #12: провал с retryable=true оставляет обязательство неоплаченным (prepared) и разрешает новую попытку', async () => {
  const databaseUrl = await freshDatabase('failed_retryable_allows_retry');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'RetryableAllows');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const { attempt } = await toFirstAttemptProcessing(payoutService, payout.id);
    const { payout: afterFail } = await payoutService.markAttemptFailed(attempt.id, { errorMessage: 'временный сбой шлюза', retryable: true });
    assert.equal(afterFail.status, 'prepared', 'retryable=true -> prepared, не blocked');

    const attempt2 = await payoutService.createPayoutAttempt(payout.id);
    assert.equal(attempt2.attempt_number, 2);
    assert.notEqual(attempt2.payment_id, attempt.payment_id);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #13: failed+non-retryable moves to blocked, new attempt rejected
// ---------------------------------------------------------------------------
test('Stage9.5 #13: провал с retryable=false переводит обязательство в blocked, новая попытка отклоняется без решения оператора', async () => {
  const databaseUrl = await freshDatabase('failed_nonretryable_blocked');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'NonRetryableBlocked');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const { attempt } = await toFirstAttemptProcessing(payoutService, payout.id);
    const { payout: afterFail } = await payoutService.markAttemptFailed(attempt.id, { errorMessage: 'реквизиты получателя некорректны', retryable: false });
    assert.equal(afterFail.status, 'blocked');

    await assert.rejects(() => payoutService.createPayoutAttempt(payout.id), /retryable|решения оператора/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #14: terminal attempt immutable
// ---------------------------------------------------------------------------
test('Stage9.5 #14: succeeded/failed попытки защищены DB-триггером от UPDATE/DELETE напрямую через SQL', async () => {
  const databaseUrl = await freshDatabase('attempt_immutability');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'AttemptImmutable');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const { attempt } = await toFirstAttemptProcessing(payoutService, payout.id);
    const { attempt: succeeded } = await payoutService.markAttemptSucceeded(attempt.id);

    await assert.rejects(() => db.execute(`UPDATE payout_attempts SET bank_status = 'hacked' WHERE id = $1`, [succeeded.id]), /immutable/i);
    await assert.rejects(() => db.execute(`DELETE FROM payout_attempts WHERE id = $1`, [succeeded.id]), /immutable|cannot be deleted/i);

    const restaurantId2 = await createRestaurant(db, 'AttemptImmutableFailed');
    await seedRestaurantPayoutReadiness(db, restaurantId2);
    const period2 = await closedPeriodWithEarnings(db, settlementService, restaurantId2, { dayOffset: -1 });
    const payout2 = await payoutService.prepareRestaurantPayout(period2.id, restaurantId2);
    const { attempt: attempt2 } = await toFirstAttemptProcessing(payoutService, payout2.id);
    const { attempt: failed } = await payoutService.markAttemptFailed(attempt2.id, { errorMessage: 'тест', retryable: false });

    await assert.rejects(() => db.execute(`UPDATE payout_attempts SET bank_status = 'hacked' WHERE id = $1`, [failed.id]), /immutable/i);
    await assert.rejects(() => db.execute(`DELETE FROM payout_attempts WHERE id = $1`, [failed.id]), /immutable|cannot be deleted/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #15: succeeded obligation immutable (тот же принцип, что Stage 9, теперь
// ТОЛЬКО succeeded — blocked/unknown/prepared/processing остаются
// редактируемыми, задание раздел 6)
// ---------------------------------------------------------------------------
test('Stage9.5 #15: succeeded обязательство защищено DB-триггером, blocked — НЕ защищено (контраст)', async () => {
  const databaseUrl = await freshDatabase('obligation_immutability');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantA = await createRestaurant(db, 'ObligImmutableSucceeded');
    await seedRestaurantPayoutReadiness(db, restaurantA);
    const periodA = await closedPeriodWithEarnings(db, settlementService, restaurantA);
    const payoutA = await payoutService.prepareRestaurantPayout(periodA.id, restaurantA);
    const { attempt } = await toFirstAttemptProcessing(payoutService, payoutA.id);
    const { payout: succeeded } = await payoutService.markAttemptSucceeded(attempt.id);

    await assert.rejects(() => db.execute(`UPDATE restaurant_payouts SET notes = 'hacked' WHERE id = $1`, [succeeded.id]), /immutable/i);
    await assert.rejects(() => db.execute(`DELETE FROM restaurant_payouts WHERE id = $1`, [succeeded.id]), /immutable|cannot be deleted/i);

    const restaurantB = await createRestaurant(db, 'ObligMutableBlocked');
    await seedRestaurantPayoutReadiness(db, restaurantB);
    const periodB = await closedPeriodWithEarnings(db, settlementService, restaurantB, { dayOffset: -1 });
    const payoutB = await payoutService.prepareRestaurantPayout(periodB.id, restaurantB);
    const { attempt: attemptB } = await toFirstAttemptProcessing(payoutService, payoutB.id);
    const { payout: blocked } = await payoutService.markAttemptFailed(attemptB.id, { errorMessage: 'тест', retryable: false });
    assert.equal(blocked.status, 'blocked');
    // blocked НЕ terminal — обычный SQL UPDATE (не через триггер валидных
    // переходов, просто правка не-статусного поля) должен пройти свободно.
    await db.execute(`UPDATE restaurant_payouts SET notes = 'заметка оператора' WHERE id = $1`, [blocked.id]);
    const reread = await payoutService.getPayoutById(blocked.id);
    assert.equal(reread.notes, 'заметка оператора');

    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, true);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #16: amount copied, never recalculated — уже проверено тестом D выше
// (задание, раздел 2/16). Отдельный тест здесь не дублируется намеренно.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #17: restaurant isolation
// ---------------------------------------------------------------------------
test('Stage9.5 #17: выплаты и попытки двух ресторанов в одном периоде не смешиваются', async () => {
  const databaseUrl = await freshDatabase('restaurant_isolation');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantA = await createRestaurant(db, 'Iso-A');
    const restaurantB = await createRestaurant(db, 'Iso-B');
    await seedRestaurantPayoutReadiness(db, restaurantA);
    const orderA = await createOrderRow(db, { restaurantId: restaurantA, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderA, 1000);
    const orderB = await createOrderRow(db, { restaurantId: restaurantB, status: 'delivered', itemsTotal: 5000, commissionAmount: 350 });
    await addSucceededPayment(db, orderB, 5000);

    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const payoutA = await payoutService.prepareRestaurantPayout(period.id, restaurantA);
    const payoutB = await payoutService.prepareRestaurantPayout(period.id, restaurantB);
    assert.equal(payoutA.amount, 930);
    assert.equal(payoutB.amount, 4650);

    const attemptA = await payoutService.createPayoutAttempt(payoutA.id);
    await payoutService.markAttemptSubmitting(attemptA.id);
    // A -> processing НЕ должно влиять на B, которая осталась prepared, и не
    // должно создавать никаких попыток для B.
    const bStillPrepared = await payoutService.getPayoutById(payoutB.id);
    assert.equal(bStillPrepared.status, 'prepared');
    const bAttempts = await payoutService.listAttemptsForPayout(payoutB.id);
    assert.equal(bAttempts.length, 0);

    const map = await payoutService.listPayoutsForPeriod(period.id);
    assert.equal(map.get(restaurantA).status, 'processing');
    assert.equal(map.get(restaurantB).status, 'prepared');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// #18: public API leak scan
// ---------------------------------------------------------------------------
test('Stage9.5 #18: публичный API не содержит ни одного payout/attempt-поля', async () => {
  const databaseUrl = await freshDatabase('public_leak_scan');
  const { instance, base } = await startApp(databaseUrl);
  try {
    await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const payoutService = require('../../services/hq/payoutService');

    const restaurantRows = await db.execute(
      `INSERT INTO restaurants (name, cities, published_at, is_open) VALUES ('Leak Payout Attempt', '[]', NOW(), 1) RETURNING id`,
    );
    const restaurantId = restaurantRows.rows[0].id;
    await seedRestaurantPayoutReadiness(db, restaurantId, { defaultPurpose: 'секретное назначение платежа' });
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1234, commissionAmount: 86 });
    await addSucceededPayment(db, orderId, 1234);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId, { notes: 'секретная внутренняя заметка' });
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await payoutService.markAttemptProcessing(attempt.id, 'SECRET_BANK_STATUS');
    await payoutService.markAttemptFailed(attempt.id, { errorMessage: 'секретная причина отказа банка', errorCode: 'SECRET_CODE', retryable: false });

    const listRes = await fetch(`${base}/api/restaurants`);
    const listText = await listRes.text();
    const detailRes = await fetch(`${base}/api/restaurants/${restaurantId}`);
    const detailText = await detailRes.text();
    const forbiddenFields = [
      'payout', 'prepared_at', 'processing_at', 'external_payout_id', 'failure_reason',
      'секретная внутренняя заметка', attempt.payment_id, 'SECRET_BANK_STATUS',
      'секретная причина отказа банка', 'SECRET_CODE', 'bank_status', 'retryable',
      'секретное назначение платежа', FICTITIOUS_RS, FICTITIOUS_KS, 'ИП Тестов Тест Тестович',
    ];
    for (const field of forbiddenFields) {
      assert.ok(!listText.includes(field), `публичный список не должен содержать "${field}"`);
      assert.ok(!detailText.includes(field), `публичная карточка не должна содержать "${field}"`);
    }
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// #19: HQ auth/no-store/CSRF
// ---------------------------------------------------------------------------
test('Stage9.5 #19a: /hq/payouts и карточка /hq/payouts/:id без сессии -> редирект на логин', async () => {
  const databaseUrl = await freshDatabase('hq_auth_redirect');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const listRes = await fetch(`${base}/hq/payouts`, { redirect: 'manual' });
    assert.equal(listRes.status, 302);
    assert.match(listRes.headers.get('location') || '', /login/);

    const detailRes = await fetch(`${base}/hq/payouts/1`, { redirect: 'manual' });
    assert.equal(detailRes.status, 302);
    assert.match(detailRes.headers.get('location') || '', /login/);

    const prepareRes = await fetch(`${base}/hq/finance/settlements/1/payouts/1/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    assert.equal(prepareRes.status, 302);
    assert.match(prepareRes.headers.get('location') || '', /login/);
  } finally {
    await stopApp(instance);
  }
});

test('Stage9.5 #19b: /hq/payouts и /hq/payouts/:id — Cache-Control: no-store', async () => {
  const databaseUrl = await freshDatabase('hq_no_store');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restaurantId = await createRestaurant(db, 'NoStore');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    const listRes = await fetch(`${base}/hq/payouts`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get('cache-control'), 'no-store');

    const detailRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.headers.get('cache-control'), 'no-store');
  } finally {
    await stopApp(instance);
  }
});

test('Stage9.5 #19c: POST prepare без CSRF-токена отклоняется (единственный write-маршрут этого раздела HQ)', async () => {
  const databaseUrl = await freshDatabase('hq_csrf');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const restaurantId = await createRestaurant(db, 'Csrf');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const res = await fetch(`${base}/hq/finance/settlements/${period.id}/payouts/${restaurantId}/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({}).toString(),
    });
    assert.ok(res.status === 400 || res.status === 403, `ожидали 400/403, получили ${res.status}`);
  } finally {
    await stopApp(instance);
  }
});

test('Stage9.5 #19d: карточка выплаты показывает историю попыток и НЕ содержит кнопок «Выплатить»/«Отправить»/«Повторить» (T-Bank по-прежнему не подключён)', async () => {
  const databaseUrl = await freshDatabase('hq_detail_no_buttons');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restaurantId = await createRestaurant(db, 'DetailNoButtons');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await payoutService.markAttemptFailed(attempt.id, { errorMessage: 'тестовая причина отказа', retryable: true });

    const detailRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const html = await detailRes.text();
    assert.equal(detailRes.status, 200);
    assert.ok(html.includes(attempt.payment_id), 'история попыток должна показывать payment_id');
    assert.ok(html.includes('тестовая причина отказа'), 'причина ошибки должна быть видна');
    // T-Bank по-прежнему не подключён (Stage 25, задание: "не подключать
    // Т-Банк") — этих кнопок карточка не должна содержать НИКОГДА.
    for (const forbidden of ['Выплатить', 'Отправить в банк', 'Повторить попытку', 'value="submit_attempt"']) {
      assert.ok(!html.includes(forbidden), `карточка не должна содержать "${forbidden}"`);
    }
    // Stage 25, раздел 1: retryable=true возвращает обязательство в
    // 'prepared', поэтому единственное write-действие карточки — ручное
    // подтверждение уже совершённого владельцем перевода — теперь ОБЯЗАНО
    // присутствовать (это не T-Bank-кнопка: форма ведёт на /confirm-manual,
    // не на /submit-attempt или /retry).
    assert.ok(html.includes(`action="/hq/payouts/${payout.id}/confirm-manual"`), 'должна быть форма ручного подтверждения выплаты в статусе prepared');
    assert.ok(html.includes('Отметить выплаченной'), 'должна быть подпись действия ручного подтверждения');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// #20: dashboard no double-counting
// ---------------------------------------------------------------------------
test('Stage9.5 #20: getPayoutDashboardStats считает обязательства (не попытки), без задвоения при нескольких попытках на одно обязательство', async () => {
  const databaseUrl = await freshDatabase('dashboard_no_double_count');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const r1 = await createRestaurant(db, 'Dash1'); // остаётся prepared, 0 попыток
    const r2 = await createRestaurant(db, 'Dash2'); // succeeded ПОСЛЕ 2 попыток (1 failed + 1 succeeded)
    const r3 = await createRestaurant(db, 'Dash3'); // blocked после 1 non-retryable failed
    const r4 = await createRestaurant(db, 'Dash4'); // processing (активная попытка)
    const r5 = await createRestaurant(db, 'Dash5'); // unknown
    for (const [rid, total, comm] of [
      [r1, 1000, 70], [r2, 2000, 140], [r3, 3000, 210], [r4, 4000, 280], [r5, 5000, 350],
    ]) {
      const orderId = await createOrderRow(db, { restaurantId: rid, status: 'delivered', itemsTotal: total, commissionAmount: comm });
      await addSucceededPayment(db, orderId, total);
    }
    for (const rid of [r2, r3, r4, r5]) {
      await seedRestaurantPayoutReadiness(db, rid);
    }
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const p1 = await payoutService.prepareRestaurantPayout(period.id, r1); // 930, prepared

    const p2 = await payoutService.prepareRestaurantPayout(period.id, r2); // 1860
    const p2a1 = await payoutService.createPayoutAttempt(p2.id);
    await payoutService.markAttemptSubmitting(p2a1.id);
    await payoutService.markAttemptProcessing(p2a1.id);
    await payoutService.markAttemptFailed(p2a1.id, { errorMessage: 'первая попытка провалилась', retryable: true });
    const p2a2 = await payoutService.createPayoutAttempt(p2.id);
    await payoutService.markAttemptSubmitting(p2a2.id);
    await payoutService.markAttemptProcessing(p2a2.id);
    await payoutService.markAttemptSucceeded(p2a2.id); // succeeded, 1860 — ДВЕ попытки, ОДНО обязательство

    const p3 = await payoutService.prepareRestaurantPayout(period.id, r3); // 2790
    const p3a1 = await payoutService.createPayoutAttempt(p3.id);
    await payoutService.markAttemptSubmitting(p3a1.id);
    await payoutService.markAttemptProcessing(p3a1.id);
    await payoutService.markAttemptFailed(p3a1.id, { errorMessage: 'реквизиты некорректны', retryable: false }); // blocked

    const p4 = await payoutService.prepareRestaurantPayout(period.id, r4); // 3720
    const p4a1 = await payoutService.createPayoutAttempt(p4.id);
    await payoutService.markAttemptSubmitting(p4a1.id); // processing

    const p5 = await payoutService.prepareRestaurantPayout(period.id, r5); // 4650
    const p5a1 = await payoutService.createPayoutAttempt(p5.id);
    await payoutService.markAttemptSubmitting(p5a1.id);
    await payoutService.markAttemptUnknown(p5a1.id, 'timeout'); // unknown

    const stats = await payoutService.getPayoutDashboardStats();
    assert.equal(stats.preparedCount, 1, 'ровно 1 обязательство (p1) — попытки внутри p2 НЕ считаются отдельными обязательствами');
    assert.equal(stats.processingCount, 1);
    assert.equal(stats.unknownCount, 1);
    assert.equal(stats.blockedCount, 1);
    assert.equal(stats.succeededCount, 1, 'p2 succeeded ровно ОДИН раз, несмотря на 2 попытки внутри неё');
    assert.equal(stats.succeededAmount, 1860);
    assert.equal(stats.owedAmount, 930 + 2790 + 3720 + 4650, 'всё, кроме succeeded, считается ещё не выплаченным');

    void p1;
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// Дополнительно (сверх 20 сценариев раздела 14) — audit log (задание,
// раздел 12): payout_created по-прежнему пишется реальным HQ-маршрутом;
// payout_attempt_* приняты allowlist'ом, но НЕ emitted никаким текущим кодом.
// ---------------------------------------------------------------------------
test('Stage9.5 audit: payout_created пишется реальным маршрутом; payout_attempt_* приняты allowlist, но пока не emitted', async () => {
  const databaseUrl = await freshDatabase('payout_audit_log_95');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const restaurantId = await createRestaurant(db, 'Audit95');
    const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderId, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const periodPage = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await periodPage.text());
    const prepareRes = await fetch(`${base}/hq/finance/settlements/${period.id}/payouts/${restaurantId}/prepare`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(prepareRes.status, 302);

    const auditRows = await db.query(`SELECT action, restaurant_id FROM hq_audit_log WHERE action = 'payout_created'`);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].restaurant_id, restaurantId);

    // allowlist готовность (задание: "ensure schema allowlist is ready for
    // Stage 10") — проверяется напрямую logAuditEvent, без реального
    // вызывающего маршрута (которого пока не существует).
    const { logAuditEvent } = require('../../services/hq/auditLog');
    for (const action of ['payout_attempt_created', 'payout_attempt_processing', 'payout_attempt_unknown', 'payout_attempt_succeeded', 'payout_attempt_failed']) {
      await logAuditEvent({ action, restaurantId, details: 'test', ip: '127.0.0.1' });
    }
    const attemptAuditRows = await db.query(
      `SELECT action FROM hq_audit_log WHERE restaurant_id = $1 AND action LIKE 'payout_attempt_%' ORDER BY id`, [restaurantId],
    );
    assert.deepEqual(attemptAuditRows.map((r) => r.action), [
      'payout_attempt_created', 'payout_attempt_processing', 'payout_attempt_unknown', 'payout_attempt_succeeded', 'payout_attempt_failed',
    ]);
  } finally {
    await stopApp(instance);
  }
});
