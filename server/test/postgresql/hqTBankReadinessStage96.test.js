'use strict';

// YAAM HQ Stage 9.6 — T-Bank Integration Readiness. Интеграционные тесты
// против настоящего embedded PostgreSQL (тот же harness, что и во всех
// предыдущих Stage-тестах). Покрывает сценарии 3-19 задания, раздел 13
// "PostgreSQL integration" (сценарии 1-2 — чистая схема / повторное
// применение — уже покрыты test/postgresql/schema.test.js, обновлённым под
// новые таблицы этого этапа; не дублируются здесь).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const OLD_STAGE95_SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, 'fixtures/stage9.5-pre-9.6-schema.sql'), 'utf8',
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

const TEST_SESSION_SECRET = 'k'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage9dot6';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-tbank-readiness-96');
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
async function postForm(base, cookie, urlPath, body) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(body).toString(),
  });
}
async function getPage(base, cookie, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  return { res, html, csrf: extractCsrf(html) };
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
  delete require.cache[require.resolve('../../services/hq/auditLog')];
  return {
    db: require('../../db/postgresql'),
    settlementService: require('../../services/hq/settlementService'),
    payoutService: require('../../services/hq/payoutService'),
    yaamBankDetailsService: require('../../services/hq/yaamBankDetailsService'),
    restaurantBankDetailsService: require('../../services/hq/restaurantBankDetailsService'),
    restaurantContractService: require('../../services/hq/restaurantContractService'),
    tbankPayoutReadiness: require('../../services/hq/tbankPayoutReadiness'),
    auditLog: require('../../services/hq/auditLog'),
  };
}

// ---------------------------------------------------------------------------
// Фикстуры (те же принципы и, где возможно, те же вымышленные значения, что
// в test/postgresql/hqRestaurantLegalBankStage6.test.js и
// test/postgresql/hqPayoutStage9.test.js)
// ---------------------------------------------------------------------------
async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70 }) {
  orderCounter += 1;
  const code = `YAAM-TB${orderCounter}`;
  const phone = `+7904${String(orderCounter).padStart(7, '0')}`;
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, status_updated_at)
     VALUES ($1,$2,'Грозный','Тест',$3,'адрес',$4,$5,$6,NOW())
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status],
  );
  return rows.rows[0].id;
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}

function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal = 1000, commissionAmount = 70, dayOffset = 0 } = {}) {
  const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal, commissionAmount });
  if (dayOffset) await db.execute(`UPDATE orders SET status_updated_at = NOW() + $2 * INTERVAL '1 day' WHERE id = $1`, [orderId, dayOffset]);
  await addSucceededPayment(db, orderId, itemsTotal);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(dayOffset), periodTo: todayStr(dayOffset) });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}

// Реквизиты — заведомо вымышленные, но математически корректные (тот же
// принцип и частично те же значения, что в hqRestaurantLegalBankStage6.test.js
// и hqPayoutStage9.test.js). Второй набор (BIK2/RS2/KS2) — независимо
// подобранный другой валидный БИК+счёт+корр.счёт, специально для сценариев
// "реквизиты ресторана изменились между попытками" (#7-#9).
const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616'; // ИП
const FICTITIOUS_INN10 = '7709123453'; // ООО
const FICTITIOUS_KPP = '770101001';

const FICTITIOUS_BIK2 = '044520100';
const FICTITIOUS_RS2 = '40702810900000000004';
const FICTITIOUS_KS2 = '30101810000000000002';

async function seedYaamBankDetails(db, overrides = {}) {
  const v = {
    legalName: 'ООО YAAM Платформа', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
    accountNumber: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bankName: 'ТЕСТБАНК', correspondentAccount: FICTITIOUS_KS,
    ...overrides,
  };
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET legal_name=EXCLUDED.legal_name, inn=EXCLUDED.inn, kpp=EXCLUDED.kpp,
       account_number=EXCLUDED.account_number, bik=EXCLUDED.bik, bank_name=EXCLUDED.bank_name,
       correspondent_account=EXCLUDED.correspondent_account, updated_at=NOW()`,
    [v.legalName, v.inn, v.kpp, v.accountNumber, v.bik, v.bankName, v.correspondentAccount],
  );
}

async function setRestaurantBankDetails(db, restaurantId, overrides = {}) {
  const v = {
    recipientName: 'ИП Тестов Тест Тестович', recipientInn: FICTITIOUS_INN12, recipientKpp: '',
    accountNumber: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bankName: 'ТЕСТБАНК', correspondentAccount: FICTITIOUS_KS,
    defaultPurpose: 'Оплата услуг доставки по договору',
    ...overrides,
  };
  const existing = await db.query('SELECT restaurant_id FROM restaurant_bank_details WHERE restaurant_id = $1', [restaurantId]);
  if (existing.length > 0) {
    await db.execute(
      `UPDATE restaurant_bank_details SET recipient_name=$2, recipient_inn=$3, recipient_kpp=$4, account_number=$5,
         bik=$6, bank_name=$7, correspondent_account=$8, default_payment_purpose=$9, updated_at=NOW()
       WHERE restaurant_id=$1`,
      [restaurantId, v.recipientName, v.recipientInn, v.recipientKpp, v.accountNumber, v.bik, v.bankName, v.correspondentAccount, v.defaultPurpose],
    );
  } else {
    await db.execute(
      `INSERT INTO restaurant_bank_details
         (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account, default_payment_purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [restaurantId, v.recipientName, v.recipientInn, v.recipientKpp, v.accountNumber, v.bik, v.bankName, v.correspondentAccount, v.defaultPurpose],
    );
  }
}

async function signContract(db, restaurantId, contractNumber = `Д-${restaurantId}`) {
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1, $2, '2026-01-01', 'signed')
     ON CONFLICT (restaurant_id) DO UPDATE SET contract_number=EXCLUDED.contract_number, signed_at=EXCLUDED.signed_at, status='signed', updated_at=NOW()`,
    [restaurantId, contractNumber],
  );
}

// Готовит ресторан полностью готовым к созданию попытки (все три блока
// реквизитов + подписанный договор) — тот же helper-принцип, что в
// hqPayoutStage9.test.js, но собран из более гранулярных функций выше,
// чтобы отдельные Stage 9.6-тесты могли изменять/убирать один блок за раз.
async function seedFullReadiness(db, restaurantId) {
  await seedYaamBankDetails(db);
  await setRestaurantBankDetails(db, restaurantId);
  await signContract(db, restaurantId);
}

// ===========================================================================
// #3: миграция Stage 9.5 -> Stage 9.6
// ===========================================================================
test('Stage9.6 #3: миграция Stage 9.5 -> Stage 9.6 — новые таблицы появляются, существующие данные не теряются, идемпотентно', async () => {
  await cluster.createDatabase('tbank96_migration');
  const setupClient = cluster.getClient('tbank96_migration');
  await setupClient.connect();
  await setupClient.query(OLD_STAGE95_SCHEMA_SQL);

  process.env.DATABASE_URL = cluster.connectionString('tbank96_migration');
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/settlementService')];
  const db = require('../../db/postgresql');
  const settlementService = require('../../services/hq/settlementService');

  const restaurantId = await createRestaurant(db, 'Migration96');
  await db.execute(
    `INSERT INTO restaurant_bank_details (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account)
     VALUES ($1,'ИП Тестов Тест Тестович',$2,'',$3,$4,'ТЕСТБАНК',$5)`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
  await addSucceededPayment(db, orderId, 1000);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
  await settlementService.closeSettlementPeriod(period.id);
  const payoutRows = await db.execute(
    `INSERT INTO restaurant_payouts (restaurant_id, settlement_period_id, amount) VALUES ($1,$2,930) RETURNING id`,
    [restaurantId, period.id],
  );
  const payoutId = payoutRows.rows[0].id;
  const attemptRows = await db.execute(
    `INSERT INTO payout_attempts (payout_id, attempt_number, payment_id, status) VALUES ($1,1,'legacy-pre-96','created') RETURNING id`,
    [payoutId],
  );
  const attemptId = attemptRows.rows[0].id;

  await db.close();
  delete process.env.DATABASE_URL;

  // Применяем НОВЫЙ schema.sql (добавляет yaam_bank_details/payout_attempt_requisites).
  await setupClient.query(SCHEMA_SQL);

  process.env.DATABASE_URL = cluster.connectionString('tbank96_migration');
  delete require.cache[require.resolve('../../db/postgresql')];
  const dbAfter = require('../../db/postgresql');
  try {
    const tables = await dbAfter.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('yaam_bank_details','payout_attempt_requisites')`);
    assert.equal(tables.length, 2, 'обе новые таблицы должны появиться после миграции');

    const bankDetailsRows = await dbAfter.query('SELECT * FROM restaurant_bank_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(bankDetailsRows.length, 1, 'существующие Stage 9.5 реквизиты ресторана не должны потеряться');
    assert.equal(bankDetailsRows[0].account_number, FICTITIOUS_RS);

    const attemptRowsAfter = await dbAfter.query('SELECT * FROM payout_attempts WHERE id = $1', [attemptId]);
    assert.equal(attemptRowsAfter.length, 1, 'существующая Stage 9.5 попытка не должна потеряться');
    assert.equal(attemptRowsAfter[0].payment_id, 'legacy-pre-96');

    const requisitesRows = await dbAfter.query('SELECT * FROM payout_attempt_requisites WHERE attempt_id = $1', [attemptId]);
    assert.equal(requisitesRows.length, 0, 'у legacy Stage 9.5 попытки НЕТ снимка (создан до Stage 9.6) — это честно, не выдумано');

    await dbAfter.close();
    delete process.env.DATABASE_URL;

    // Идемпотентность.
    await setupClient.query(SCHEMA_SQL);
    process.env.DATABASE_URL = cluster.connectionString('tbank96_migration');
    delete require.cache[require.resolve('../../db/postgresql')];
    const dbRerun = require('../../db/postgresql');
    const tablesRerun = await dbRerun.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('yaam_bank_details','payout_attempt_requisites')`);
    assert.equal(tablesRerun.length, 2);
    await dbRerun.close();
  } finally {
    delete process.env.DATABASE_URL;
    await setupClient.end();
  }
});

// ===========================================================================
// #4: singleton реквизитов YAAM
// ===========================================================================
test('Stage9.6 #4: yaam_bank_details — физический singleton (PRIMARY KEY + CHECK id=1)', async () => {
  const databaseUrl = await freshDatabase('tbank96_singleton');
  process.env.DATABASE_URL = databaseUrl;
  const { db } = requireFreshModules();
  try {
    await seedYaamBankDetails(db);
    await assert.rejects(() => db.execute(
      `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
       VALUES (2,'x','7709123453','770101001',$1,$2,'x',$3)`,
      [FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
    ), /violates check|duplicate key/i);
    const rows = await db.query('SELECT COUNT(*)::int AS c FROM yaam_bank_details');
    assert.equal(rows[0].c, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #5: create/update реквизитов YAAM через сервис
// ===========================================================================
test('Stage9.6 #5: yaamBankDetailsService.saveYaamBankDetails создаёт, затем обновляет ту же singleton-строку', async () => {
  const databaseUrl = await freshDatabase('tbank96_create_update');
  process.env.DATABASE_URL = databaseUrl;
  const { yaamBankDetailsService } = requireFreshModules();
  try {
    const created = await yaamBankDetailsService.saveYaamBankDetails({
      legal_name: 'ООО YAAM', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
      account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК', correspondent_account: FICTITIOUS_KS,
    });
    assert.equal(created.created, true);
    assert.equal(created.before, null);
    assert.equal(created.record.legal_name, 'ООО YAAM');

    const updated = await yaamBankDetailsService.saveYaamBankDetails({
      legal_name: 'ООО YAAM Платформа (новое)', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
      account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК', correspondent_account: FICTITIOUS_KS,
    });
    assert.equal(updated.created, false);
    assert.equal(updated.before.legal_name, 'ООО YAAM');
    assert.equal(updated.record.legal_name, 'ООО YAAM Платформа (новое)');

    const all = await require('../../db/postgresql').query('SELECT COUNT(*)::int AS c FROM yaam_bank_details');
    assert.equal(all[0].c, 1, 'update не должен создавать вторую строку');
  } finally {
    await require('../../db/postgresql').close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #6: российская валидация — на уровне БД (defense-in-depth поверх
// сервисного уровня, уже покрытого test/tbankReadinessUnit.test.js)
// ===========================================================================
test('Stage9.6 #6: bank_name длиннее 255 символов отклоняется на уровне схемы (CHECK), не только сервисом', async () => {
  const databaseUrl = await freshDatabase('tbank96_bank_name_check');
  process.env.DATABASE_URL = databaseUrl;
  const { db } = requireFreshModules();
  try {
    await assert.rejects(() => db.execute(
      `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
       VALUES (1,'x','7709123453','770101001',$1,$2,$3,$4)`,
      [FICTITIOUS_RS, FICTITIOUS_BIK, 'Б'.repeat(256), FICTITIOUS_KS],
    ), /violates check/i);

    const restaurantId = await createRestaurant(db, 'BankNameCheck');
    await assert.rejects(() => db.execute(
      `INSERT INTO restaurant_bank_details (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account)
       VALUES ($1,'x',$2,'',$3,$4,$5,$6)`,
      [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, 'Б'.repeat(256), FICTITIOUS_KS],
    ), /violates check/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #7: snapshot фиксирует реквизиты на момент создания попытки — БЕЗУСЛОВНАЯ
// immutability на уровне БД (не только "после terminal", как у самой
// payout_attempts)
// ===========================================================================
test('Stage9.6 #7: payout_attempt_requisites неизменяема с момента создания (UPDATE/DELETE запрещены всегда, не только после terminal)', async () => {
  const databaseUrl = await freshDatabase('tbank96_snapshot_immutable');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'SnapshotImmutable');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id); // status='created', ещё НЕ terminal

    await assert.rejects(() => db.execute(`UPDATE payout_attempt_requisites SET bank_name = 'hacked' WHERE attempt_id = $1`, [attempt.id]), /immutable/i);
    await assert.rejects(() => db.execute(`DELETE FROM payout_attempt_requisites WHERE attempt_id = $1`, [attempt.id]), /immutable/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #8: изменение реквизитов ресторана после создания attempt не меняет
// уже созданный snapshot
// ===========================================================================
test('Stage9.6 #8: изменение restaurant_bank_details после создания попытки не меняет её snapshot', async () => {
  const databaseUrl = await freshDatabase('tbank96_snapshot_frozen');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'SnapshotFrozen');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    const snapshot1 = await payoutService.getAttemptRequisites(attempt1.id);
    assert.equal(snapshot1.account_number, FICTITIOUS_RS);
    assert.equal(snapshot1.bik, FICTITIOUS_BIK);

    // Провал (retryable) -> обязательство возвращается в prepared -> реквизиты
    // ресторана меняются (например, оператор исправил ошибку в счёте).
    await payoutService.markAttemptSubmitting(attempt1.id);
    await payoutService.markAttemptProcessing(attempt1.id);
    await payoutService.markAttemptFailed(attempt1.id, { errorMessage: 'реквизиты некорректны', retryable: true });
    await setRestaurantBankDetails(db, restaurantId, {
      accountNumber: FICTITIOUS_RS2, bik: FICTITIOUS_BIK2, correspondentAccount: FICTITIOUS_KS2, bankName: 'НОВЫЙ ТЕСТБАНК',
    });

    // Старый snapshot НЕ должен был измениться.
    const snapshot1Again = await payoutService.getAttemptRequisites(attempt1.id);
    assert.equal(snapshot1Again.account_number, FICTITIOUS_RS, 'старый snapshot должен остаться со СТАРЫМ счётом');
    assert.equal(snapshot1Again.bik, FICTITIOUS_BIK);
    assert.equal(snapshot1Again.bank_name, 'ТЕСТБАНК');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #9: новая попытка после исправления реквизитов получает НОВЫЙ snapshot
// ===========================================================================
test('Stage9.6 #9: новая попытка после изменения реквизитов ресторана получает НОВЫЙ snapshot с новыми данными', async () => {
  const databaseUrl = await freshDatabase('tbank96_new_snapshot');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'NewSnapshot');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt1.id);
    await payoutService.markAttemptProcessing(attempt1.id);
    await payoutService.markAttemptFailed(attempt1.id, { errorMessage: 'реквизиты некорректны', retryable: true });

    await setRestaurantBankDetails(db, restaurantId, {
      accountNumber: FICTITIOUS_RS2, bik: FICTITIOUS_BIK2, correspondentAccount: FICTITIOUS_KS2, bankName: 'НОВЫЙ ТЕСТБАНК',
    });

    const attempt2 = await payoutService.createPayoutAttempt(payout.id);
    const snapshot2 = await payoutService.getAttemptRequisites(attempt2.id);
    assert.equal(snapshot2.account_number, FICTITIOUS_RS2, 'новый snapshot должен использовать НОВЫЙ счёт');
    assert.equal(snapshot2.bik, FICTITIOUS_BIK2);
    assert.equal(snapshot2.bank_name, 'НОВЫЙ ТЕСТБАНК');

    const snapshot1 = await payoutService.getAttemptRequisites(attempt1.id);
    assert.equal(snapshot1.account_number, FICTITIOUS_RS, 'первый snapshot по-прежнему со старым счётом');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #10: snapshot amount совпадает с payout amount
// ===========================================================================
test('Stage9.6 #10: snapshot.amount всегда совпадает с обязательством при создании; checkPayoutInvariants ловит ручное рассогласование', async () => {
  const databaseUrl = await freshDatabase('tbank96_snapshot_amount');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'SnapshotAmount');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal: 1000, commissionAmount: 70 });
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    const snapshot = await payoutService.getAttemptRequisites(attempt.id);
    assert.equal(snapshot.amount, payout.amount);
    assert.equal(snapshot.amount, 930);

    // Ручная порча (в обход сервиса — недостижимо иначе, snapshot immutable
    // для UPDATE, поэтому конструируем рассогласование ЗАРАНЕЕ через прямой
    // INSERT для ВТОРОЙ, отдельной попытки/обязательства).
    const restaurantId2 = await createRestaurant(db, 'SnapshotAmountBad');
    await seedFullReadiness(db, restaurantId2);
    const period2 = await closedPeriodWithEarnings(db, settlementService, restaurantId2, { dayOffset: -1, itemsTotal: 2000, commissionAmount: 140 });
    const payout2 = await payoutService.prepareRestaurantPayout(period2.id, restaurantId2);
    const attempt2Rows = await db.execute(
      `INSERT INTO payout_attempts (payout_id, attempt_number, payment_id, status) VALUES ($1,1,'manual-amount-mismatch','created') RETURNING id`,
      [payout2.id],
    );
    await db.execute(
      `INSERT INTO payout_attempt_requisites
         (attempt_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account, payment_purpose, amount, payer_account_number, payer_kpp)
       VALUES ($1,'x',$2,'0',$3,$4,'x',$5,'test purpose', 999999, $3, $6)`,
      [attempt2Rows.rows[0].id, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS, FICTITIOUS_KPP],
    );

    const invariants = await payoutService.checkPayoutInvariants();
    assert.equal(invariants.ok, false);
    assert.ok(invariants.violations.some((v) => v.kind === 'attempt_requisites_amount_mismatch'));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #11: readiness проходит все причины до ready
// ===========================================================================
test('Stage9.6 #11: getTBankPayoutReadiness проходит все причины неготовности по очереди до ready', async () => {
  const databaseUrl = await freshDatabase('tbank96_readiness_progression');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, tbankPayoutReadiness } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'ReadinessProgression');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);

    let readiness = await tbankPayoutReadiness.getTBankPayoutReadiness(payout.id);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reasons.includes('missing_yaam_bank_details'));

    await seedYaamBankDetails(db);
    readiness = await tbankPayoutReadiness.getTBankPayoutReadiness(payout.id);
    assert.ok(readiness.reasons.includes('missing_restaurant_bank_details'));

    await setRestaurantBankDetails(db, restaurantId, { defaultPurpose: '' });
    await db.execute(`INSERT INTO restaurant_contracts (restaurant_id, status) VALUES ($1,'not_signed')`, [restaurantId]);
    readiness = await tbankPayoutReadiness.getTBankPayoutReadiness(payout.id);
    assert.ok(readiness.reasons.includes('contract_not_signed'));
    assert.ok(readiness.reasons.includes('missing_payment_purpose'), 'без подписанного договора и без default_purpose нет откуда взять номер договора для генерации');

    await db.execute(`UPDATE restaurant_contracts SET status='signed', signed_at='2026-01-01', contract_number=$2 WHERE restaurant_id=$1`, [restaurantId, 'Д-1']);
    readiness = await tbankPayoutReadiness.getTBankPayoutReadiness(payout.id);
    assert.equal(readiness.ready, true, `ожидали ready, получили: ${JSON.stringify(readiness.reasons)}`);
    assert.deepEqual(readiness.reasons, ['ready']);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #12: legacy processing без attempt определяется readiness'ом как
// legacy_state_requires_review (не как обычная неготовность)
// ===========================================================================
test('Stage9.6 #12: legacy processing-обязательство без активной попытки -> readiness сообщает legacy_state_requires_review', async () => {
  const databaseUrl = await freshDatabase('tbank96_legacy_processing');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, tbankPayoutReadiness } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'LegacyProcessing');
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    // Прямой SQL — симулирует legacy Stage 9 processing-строку без попытки
    // (структурно недостижимо через сервисный слой Stage 9.5+, только через
    // обход, как и в реальном legacy-случае — задание, раздел 1/2).
    await db.execute(`UPDATE restaurant_payouts SET status = 'processing', processing_at = NOW() WHERE id = $1`, [payout.id]);

    const readiness = await tbankPayoutReadiness.getTBankPayoutReadiness(payout.id);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.reasons, ['legacy_state_requires_review']);

    const invariants = await payoutService.checkPayoutInvariants();
    assert.ok(invariants.violations.some((v) => v.kind === 'processing_without_active_attempt'));
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #13: public API leak scan (специфично для Stage 9.6 полей)
// ===========================================================================
test('Stage9.6 #13: публичный API не содержит ни одного поля yaam_bank_details/payout_attempt_requisites', async () => {
  const databaseUrl = await freshDatabase('tbank96_public_leak');
  const { instance, base } = await startApp(databaseUrl);
  try {
    await loginHq(base);
    const db = require('../../db/postgresql');
    const settlementService = require('../../services/hq/settlementService');
    const payoutService = require('../../services/hq/payoutService');

    await seedYaamBankDetails(db, { legalName: 'СЕКРЕТНОЕ ЮРЛИЦО YAAM' });
    const restaurantRows = await db.execute(
      `INSERT INTO restaurants (name, cities, published_at, is_open) VALUES ('Leak96', '[]', NOW(), 1) RETURNING id`,
    );
    const restaurantId = restaurantRows.rows[0].id;
    await setRestaurantBankDetails(db, restaurantId, { defaultPurpose: 'СЕКРЕТНОЕ назначение платежа Stage96' });
    await signContract(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    void attempt;

    const listText = await (await fetch(`${base}/api/restaurants`)).text();
    const detailText = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).text();
    const forbidden = [
      'СЕКРЕТНОЕ ЮРЛИЦО YAAM', 'СЕКРЕТНОЕ назначение платежа Stage96',
      FICTITIOUS_RS, FICTITIOUS_KS, FICTITIOUS_BIK, 'payer_account_number', 'recipient_inn', 'yaam_bank_details',
    ];
    for (const field of forbidden) {
      assert.ok(!listText.includes(field), `публичный список не должен содержать "${field}"`);
      assert.ok(!detailText.includes(field), `публичная карточка не должна содержать "${field}"`);
    }
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// #14: Telegram leak scan — статическая проверка исходников бота (задание,
// раздел 12/адаптация для Stage 9.6): бот НЕ должен ссылаться ни на одну из
// новых таблиц/сервисов ни в одном файле.
// ===========================================================================
test('Stage9.6 #14: исходники Telegram-бота (bot/postgresql/index.js) не ссылаются на yaam_bank_details/restaurant_bank_details/payout_attempt_requisites', () => {
  const fsSync = require('node:fs');
  const botSource = fsSync.readFileSync(path.join(__dirname, '../../bot/postgresql/index.js'), 'utf8');
  for (const forbidden of ['yaam_bank_details', 'restaurant_bank_details', 'payout_attempt_requisites', 'yaamBankDetailsService', 'tbankRequestMapper', 'tbankPayoutReadiness']) {
    assert.ok(!botSource.includes(forbidden), `bot/postgresql/index.js не должен упоминать "${forbidden}"`);
  }
});

// ===========================================================================
// #15: HQ auth/CSRF/no-store для новых маршрутов реквизитов YAAM
// ===========================================================================
test('Stage9.6 #15a: /hq/settings/yaam-bank-details/edit и POST без сессии -> редирект на логин', async () => {
  const databaseUrl = await freshDatabase('tbank96_auth');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const editRes = await fetch(`${base}/hq/settings/yaam-bank-details/edit`, { redirect: 'manual' });
    assert.equal(editRes.status, 302);
    assert.match(editRes.headers.get('location') || '', /login/);

    const postRes = await fetch(`${base}/hq/settings/yaam-bank-details`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    assert.equal(postRes.status, 302);
    assert.match(postRes.headers.get('location') || '', /login/);
  } finally {
    await stopApp(instance);
  }
});

test('Stage9.6 #15b: /hq/settings/yaam-bank-details/edit — Cache-Control: no-store', async () => {
  const databaseUrl = await freshDatabase('tbank96_no_store');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const res = await fetch(`${base}/hq/settings/yaam-bank-details/edit`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await stopApp(instance);
  }
});

test('Stage9.6 #15c: POST /hq/settings/yaam-bank-details без CSRF-токена отклоняется', async () => {
  const databaseUrl = await freshDatabase('tbank96_csrf');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const res = await postForm(base, cookie, '/hq/settings/yaam-bank-details', {
      legal_name: 'ООО YAAM', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
      account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК', correspondent_account: FICTITIOUS_KS,
    });
    assert.ok(res.status === 400 || res.status === 403, `ожидали 400/403, получили ${res.status}`);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// #16: audit log маскирует счета (yaam_bank_details_created/updated)
// ===========================================================================
test('Stage9.6 #16: yaam_bank_details_created/updated логируются с маскированными счетами, без полных значений', async () => {
  const databaseUrl = await freshDatabase('tbank96_audit_mask');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const editPage = await getPage(base, cookie, '/hq/settings/yaam-bank-details/edit');
    const createRes = await postForm(base, cookie, '/hq/settings/yaam-bank-details', {
      _csrf: editPage.csrf, legal_name: 'ООО YAAM', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
      account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК', correspondent_account: FICTITIOUS_KS,
    });
    assert.equal(createRes.status, 302);

    const editPage2 = await getPage(base, cookie, '/hq/settings/yaam-bank-details/edit');
    const updateRes = await postForm(base, cookie, '/hq/settings/yaam-bank-details', {
      _csrf: editPage2.csrf, legal_name: 'ООО YAAM', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
      account_number: FICTITIOUS_RS2, bik: FICTITIOUS_BIK2, bank_name: 'НОВЫЙ БАНК', correspondent_account: FICTITIOUS_KS2,
    });
    assert.equal(updateRes.status, 302);

    const rows = await db.query(`SELECT action, details FROM hq_audit_log WHERE action LIKE 'yaam_bank_details_%' ORDER BY id`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'yaam_bank_details_created');
    assert.equal(rows[0].details, null, 'создание не логирует diff (нечего сравнивать)');
    assert.equal(rows[1].action, 'yaam_bank_details_updated');
    assert.ok(!rows[1].details.includes(FICTITIOUS_RS2), 'полный новый счёт не должен попасть в лог');
    assert.ok(!rows[1].details.includes(FICTITIOUS_KS2), 'полный новый корр.счёт не должен попасть в лог');
    assert.match(rows[1].details, /account_number:\s*\*+\d{4}\s*->\s*\*+\d{4}/, 'должна быть маскированная форма ****XXXX');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// #17: изоляция — snapshot ресторана A никогда не содержит данные B
// ===========================================================================
test('Stage9.6 #17: снимки реквизитов двух ресторанов не смешиваются', async () => {
  const databaseUrl = await freshDatabase('tbank96_isolation');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    await seedYaamBankDetails(db);
    const restaurantA = await createRestaurant(db, 'IsoA96');
    const restaurantB = await createRestaurant(db, 'IsoB96');
    await setRestaurantBankDetails(db, restaurantA, { recipientName: 'Ресторан А' });
    await setRestaurantBankDetails(db, restaurantB, {
      recipientName: 'Ресторан Б', accountNumber: FICTITIOUS_RS2, bik: FICTITIOUS_BIK2, correspondentAccount: FICTITIOUS_KS2,
    });
    await signContract(db, restaurantA);
    await signContract(db, restaurantB);

    const orderA = await createOrderRow(db, { restaurantId: restaurantA, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, orderA, 1000);
    const orderB = await createOrderRow(db, { restaurantId: restaurantB, status: 'delivered', itemsTotal: 5000, commissionAmount: 350 });
    await addSucceededPayment(db, orderB, 5000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const payoutA = await payoutService.prepareRestaurantPayout(period.id, restaurantA);
    const payoutB = await payoutService.prepareRestaurantPayout(period.id, restaurantB);
    const attemptA = await payoutService.createPayoutAttempt(payoutA.id);
    const attemptB = await payoutService.createPayoutAttempt(payoutB.id);

    const snapshotA = await payoutService.getAttemptRequisites(attemptA.id);
    const snapshotB = await payoutService.getAttemptRequisites(attemptB.id);
    assert.equal(snapshotA.recipient_name, 'Ресторан А');
    assert.equal(snapshotA.account_number, FICTITIOUS_RS);
    assert.equal(snapshotB.recipient_name, 'Ресторан Б');
    assert.equal(snapshotB.account_number, FICTITIOUS_RS2);
    assert.notEqual(snapshotA.account_number, snapshotB.account_number);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #18: succeeded payout не получает "новую" готовность — остаётся terminal
// ===========================================================================
test('Stage9.6 #18: readiness succeeded-обязательства всегда payout_already_succeeded, независимо от реквизитов', async () => {
  const databaseUrl = await freshDatabase('tbank96_succeeded_readiness');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, tbankPayoutReadiness } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'SucceededReadiness');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await payoutService.markAttemptProcessing(attempt.id);
    await payoutService.markAttemptSucceeded(attempt.id);

    // Даже если YAAM реквизиты потом удалить — succeeded остаётся
    // succeeded, readiness не должна пытаться "переоценивать" готовность.
    await db.execute('DELETE FROM yaam_bank_details WHERE id = 1');
    const readiness = await tbankPayoutReadiness.getTBankPayoutReadiness(payout.id);
    assert.deepEqual(readiness, { ready: false, reasons: ['payout_already_succeeded'] });
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// #19: dashboard не регрессировал (форма getPayoutDashboardStats не менялась
// в Stage 9.6 — smoke-проверка отсутствия регрессии)
// ===========================================================================
test('Stage9.6 #19: getPayoutDashboardStats продолжает работать без регрессии после добавления snapshot-логики', async () => {
  const databaseUrl = await freshDatabase('tbank96_dashboard_regression');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'DashboardRegression96');
    await seedFullReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal: 1000, commissionAmount: 70 });
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await payoutService.markAttemptProcessing(attempt.id);
    await payoutService.markAttemptSucceeded(attempt.id);

    const stats = await payoutService.getPayoutDashboardStats();
    assert.equal(typeof stats.preparedCount, 'number');
    assert.equal(typeof stats.processingCount, 'number');
    assert.equal(typeof stats.unknownCount, 'number');
    assert.equal(typeof stats.blockedCount, 'number');
    assert.equal(stats.succeededCount, 1);
    assert.equal(stats.succeededAmount, 930);
    assert.equal(stats.owedAmount, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
