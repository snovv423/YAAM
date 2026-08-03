'use strict';

// YAAM HQ — раздел «Финансы» переработан согласно docs/HQ-PRODUCT-SPEC.md.
// Интеграционные тесты против настоящего embedded PostgreSQL, тот же
// harness-паттерн, что и остальные Stage-файлы этой директории.
//
// A — readiness: полный набор backend-проверок готовности к выплате.
// B — невозможность выплаты при отсутствии реквизитов/договора/контакта.
// C — невозможность повторной выплаты того же периода (идемпотентность).
// D — массовая выплата: не готовые пропускаются, ошибка одного не отменяет
//     остальных, повторный запуск не создаёт дублей.
// E — immutable snapshot реквизитов: правка реквизитов не меняет выплату.
// F — ошибки провайдера отражаются на статусе и в карточке.
// G — HTTP: экран «Финансы», реестр выплат, карточка выплаты.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { projectTodayStr: todayStr } = require('./helpers/projectDate');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../services/hq/ownerService.js'),
  require.resolve('../../services/hq/restaurantAdminService.js'),
  require.resolve('../../services/hq/restaurantStatsService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/payoutStatusService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/restaurantPayoutStateService.js'),
  require.resolve('../../services/hq/tbankPayoutStatusMapper.js'),
  require.resolve('../../services/hq/tbankPayoutReadiness.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../services/hq/eventLogService.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/payouts.js'),
  require.resolve('../../routes/hq/settlements.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'f'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage12Fin';

const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_INN10 = '7709123453';
const FICTITIOUS_KPP = '770101001';
const FICTITIOUS_OGRNIP = '312770012345008';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-finance-stage12');
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

function requireFreshModules() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    payoutStatusService: require('../../services/hq/payoutStatusService'),
    payoutService: require('../../services/hq/payoutService'),
    settlementService: require('../../services/hq/settlementService'),
    tbankMapper: require('../../services/hq/tbankPayoutStatusMapper'),
  };
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
async function getPage(base, cookie, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  return { res, html, status: res.status, csrf: html.includes('name="_csrf"') ? extractCsrf(html) : null };
}
async function postForm(base, cookie, urlPath, fields) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- Фикстуры ---
async function createRestaurant(db, name) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createEarnedOrder(db, restaurantId, { itemsTotal = 1000, commissionAmount = 70 } = {}) {
  orderCounter += 1;
  const rows = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address,
                         items_total, commission_amount, status)
     VALUES ($1,$2,'Грозный','Клиент',$3,'ул. Тестовая',$4,$5,'delivered') RETURNING id`,
    [`YAAM-F${orderCounter}`, restaurantId, `+7900${String(orderCounter).padStart(7, '0')}`, itemsTotal, commissionAmount],
  );
  await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded')`, [rows.rows[0].id, itemsTotal]);
  return rows.rows[0].id;
}

async function seedYaamDetails(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, 'ООО YAAM Платформа', $1, $2, $3, $4, 'ТЕСТБАНК', $5) ON CONFLICT (id) DO NOTHING`,
    [FICTITIOUS_INN10, FICTITIOUS_KPP, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
}

async function seedLegal(db, restaurantId, { directorName = 'Тестов Т. Т.', contactPhone = '+79280000001' } = {}) {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip','ИП Тестов Тест Тестович',$2,$3,'г. Грозный, ул. Тестовая, 1',$4,$5)`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_OGRNIP, directorName, contactPhone],
  );
}
async function seedBank(db, restaurantId) {
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, default_payment_purpose)
     VALUES ($1,'ИП Тестов Тест Тестович',$2,'',$3,$4,'ТЕСТБАНК',$5,'Оплата услуг')`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
}
async function seedContract(db, restaurantId, status = 'signed') {
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status) VALUES ($1,$2,'2026-01-01',$3)`,
    [restaurantId, `Д-${restaurantId}`, status],
  );
}
async function seedFullyReady(db, restaurantId) {
  await seedYaamDetails(db);
  await seedLegal(db, restaurantId);
  await seedBank(db, restaurantId);
  await seedContract(db, restaurantId);
}
async function closePeriod(settlementService) {
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}

function statusOf(statuses, restaurantId) {
  return statuses.find((s) => s.restaurantId === restaurantId);
}

// ===========================================================================
// A — readiness
// ===========================================================================
test('A: полностью готовый ресторан с закрытым периодом -> «Готов к выплате»', async () => {
  const databaseUrl = await freshDatabase('fin12_ready');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Готовый');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    const row = statusOf(await payoutStatusService.listPayoutStatuses(), restId);
    assert.equal(row.status, 'ready');
    assert.equal(row.statusLabel, 'Готов к выплате');
    assert.equal(row.statusTone, 'ok');
    assert.equal(row.canPay, true);
    assert.equal(row.amount, 930);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('A2: без закрытого периода -> «Ожидает закрытия периода», выплата недоступна', async () => {
  const databaseUrl = await freshDatabase('fin12_no_period');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Без периода');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);

    const row = statusOf(await payoutStatusService.listPayoutStatuses(), restId);
    assert.equal(row.status, 'waiting_period');
    assert.equal(row.canPay, false);
    await assert.rejects(() => payoutStatusService.payRestaurant(restId), /недоступна/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('A3: закрытый период с нулевой суммой не делает ресторан готовым', async () => {
  const databaseUrl = await freshDatabase('fin12_zero_amount');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Нулевой');
    await seedFullyReady(db, restId);
    await closePeriod(settlementService); // заказов нет -> строки расчёта нет

    const row = statusOf(await payoutStatusService.listPayoutStatuses(), restId);
    assert.equal(row.canPay, false);
    assert.equal(row.amount, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// B — блокеры готовности
// ===========================================================================
test('B: нет реквизитов / нет договора / нет ответственного — каждый блокер даёт свой статус и запрещает выплату', async () => {
  const databaseUrl = await freshDatabase('fin12_blockers');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  try {
    await seedYaamDetails(db);

    const noLegal = await createRestaurant(db, 'Без юрданных');
    await createEarnedOrder(db, noLegal);

    const noBank = await createRestaurant(db, 'Без реквизитов');
    await seedLegal(db, noBank);
    await createEarnedOrder(db, noBank);

    const noContract = await createRestaurant(db, 'Без договора');
    await seedLegal(db, noContract);
    await seedBank(db, noContract);
    await createEarnedOrder(db, noContract);

    const noContact = await createRestaurant(db, 'Без ответственного');
    await seedLegal(db, noContact, { directorName: '', contactPhone: '' });
    await seedBank(db, noContact);
    await seedContract(db, noContact);
    await createEarnedOrder(db, noContact);

    await closePeriod(settlementService);
    const statuses = await payoutStatusService.listPayoutStatuses();

    assert.equal(statusOf(statuses, noLegal).status, 'no_requisites');
    assert.equal(statusOf(statuses, noBank).status, 'no_requisites');
    assert.equal(statusOf(statuses, noContract).status, 'no_contract');
    assert.equal(statusOf(statuses, noContact).status, 'no_contact');

    for (const id of [noLegal, noBank, noContract, noContact]) {
      assert.equal(statusOf(statuses, id).canPay, false);
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => payoutStatusService.payRestaurant(id), /недоступна/i);
    }
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B2: договор в статусе «Не оформлен» — «Нет договора»', async () => {
  const databaseUrl = await freshDatabase('fin12_draft_contract');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Договор не подписан');
    await seedYaamDetails(db);
    await seedLegal(db, restId);
    await seedBank(db, restId);
    await seedContract(db, restId, 'not_signed');
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    assert.equal(statusOf(await payoutStatusService.listPayoutStatuses(), restId).status, 'no_contract');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// C — повторная выплата невозможна (идемпотентность)
// ===========================================================================
test('C: повторная выплата того же периода невозможна; статус становится «Подготовлено»', async () => {
  const databaseUrl = await freshDatabase('fin12_no_double');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService } = requireFreshModules();
  const settlementService = require('../../services/hq/settlementService');
  try {
    const restId = await createRestaurant(db, 'Однократный');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    const payout = await payoutStatusService.payRestaurant(restId);
    assert.ok(payout.id);

    const after = statusOf(await payoutStatusService.listPayoutStatuses(), restId);
    assert.equal(after.status, 'prepared');
    assert.equal(after.canPay, false, 'кнопка больше не доступна');

    await assert.rejects(() => payoutStatusService.payRestaurant(restId), /недоступна/i);

    const count = await db.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts WHERE restaurant_id = $1', [restId]);
    assert.equal(count[0].c, 1, 'вторая выплата не создана');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// D — массовая выплата
// ===========================================================================
test('D: «Подготовить все» готовит выплаты только готовым, пропускает остальных и идемпотентна при повторе', async () => {
  const databaseUrl = await freshDatabase('fin12_batch');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  try {
    await seedYaamDetails(db);
    const readyA = await createRestaurant(db, 'Готовый А');
    await seedLegal(db, readyA); await seedBank(db, readyA); await seedContract(db, readyA);
    await createEarnedOrder(db, readyA, { itemsTotal: 1000, commissionAmount: 70 });

    const readyB = await createRestaurant(db, 'Готовый Б');
    await seedLegal(db, readyB); await seedBank(db, readyB); await seedContract(db, readyB);
    await createEarnedOrder(db, readyB, { itemsTotal: 500, commissionAmount: 35 });

    const notReady = await createRestaurant(db, 'Не готовый');
    await createEarnedOrder(db, notReady, { itemsTotal: 700, commissionAmount: 49 });

    await closePeriod(settlementService);

    const result = await payoutStatusService.payAllReady();
    assert.equal(result.paid.length, 2, 'подготовлено обоим готовым');
    assert.equal(result.failed.length, 0);
    assert.ok(result.skipped >= 1, 'не готовый пропущен, а не провален');

    const paidIds = result.paid.map((p) => p.restaurantId).sort();
    assert.deepEqual(paidIds, [readyA, readyB].sort());

    // Повторный запуск — новых выплат нет (идемпотентность), ошибок нет.
    const again = await payoutStatusService.payAllReady();
    assert.equal(again.paid.length, 0);
    assert.equal(again.failed.length, 0);

    const total = await db.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts');
    assert.equal(total[0].c, 2, 'дублей не создано');

    // У не готового выплаты по-прежнему нет.
    const none = await db.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts WHERE restaurant_id = $1', [notReady]);
    assert.equal(none[0].c, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('D2: ошибка одного ресторана не отменяет выплаты остальным', async () => {
  const databaseUrl = await freshDatabase('fin12_batch_partial');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  const payoutService = require('../../services/hq/payoutService');
  try {
    await seedYaamDetails(db);
    const restA = await createRestaurant(db, 'А');
    await seedLegal(db, restA); await seedBank(db, restA); await seedContract(db, restA);
    await createEarnedOrder(db, restA);

    const restB = await createRestaurant(db, 'Б');
    await seedLegal(db, restB); await seedBank(db, restB); await seedContract(db, restB);
    await createEarnedOrder(db, restB, { itemsTotal: 800, commissionAmount: 56 });

    await closePeriod(settlementService);

    // Ломаем подготовку РОВНО для первого ресторана — остальные должны пройти.
    const original = payoutService.prepareRestaurantPayout;
    let firstCall = true;
    payoutService.prepareRestaurantPayout = async (...args) => {
      if (firstCall) {
        firstCall = false;
        throw new payoutService.ValidationError('искусственный сбой провайдера');
      }
      return original(...args);
    };
    let result;
    try {
      result = await payoutStatusService.payAllReady();
    } finally {
      payoutService.prepareRestaurantPayout = original;
    }

    assert.equal(result.failed.length, 1, 'один ресторан провалился');
    assert.equal(result.paid.length, 1, 'второй всё равно подготовлен');
    assert.match(result.failed[0].error, /искусственный сбой/);

    const total = await db.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts');
    assert.equal(total[0].c, 1, 'создана ровно одна выплата — та, что не упала');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// E — immutable snapshot реквизитов
// ===========================================================================
test('E: правка банковских реквизитов ресторана НЕ меняет снимок уже созданной попытки', async () => {
  const databaseUrl = await freshDatabase('fin12_snapshot');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, payoutService, settlementService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Снимок');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    const payout = await payoutStatusService.payRestaurant(restId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    const before = await payoutService.getAttemptRequisites(attempt.id);
    assert.equal(before.recipient_name, 'ИП Тестов Тест Тестович');
    assert.equal(before.amount, 930);

    // Ресторан сменил получателя и счёт уже ПОСЛЕ создания попытки.
    await db.execute(
      `UPDATE restaurant_bank_details SET recipient_name = 'ИП Новый Получатель', account_number = $2 WHERE restaurant_id = $1`,
      [restId, '40702810938050001238'],
    );

    const after = await payoutService.getAttemptRequisites(attempt.id);
    assert.equal(after.recipient_name, 'ИП Тестов Тест Тестович', 'снимок неизменяем');
    assert.equal(after.amount, 930);

    // Прямая попытка изменить снимок отклоняется на уровне БД.
    await assert.rejects(
      () => db.execute(`UPDATE payout_attempt_requisites SET recipient_name = 'X' WHERE attempt_id = $1`, [attempt.id]),
      /immutable/i,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// F — ошибки провайдера
// ===========================================================================
test('F: неуспешная попытка без права повтора -> статус «Заблокировано», причина видна', async () => {
  const databaseUrl = await freshDatabase('fin12_provider_error');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, payoutService, settlementService, tbankMapper } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'С ошибкой');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    const payout = await payoutStatusService.payRestaurant(restId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_CANCELLED, { retryableOnFailure: false });

    const row = statusOf(await payoutStatusService.listPayoutStatuses(), restId);
    assert.equal(row.status, 'blocked');
    assert.equal(row.statusTone, 'danger');
    assert.equal(row.canPay, false);

    const stored = await payoutService.getPayoutById(payout.id);
    assert.equal(stored.status, 'blocked');
    assert.ok(stored.failure_reason, 'причина ошибки сохранена');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('F2: успешная выплата -> статус «Выплачено», повторная выплата невозможна', async () => {
  const databaseUrl = await freshDatabase('fin12_paid');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, payoutService, settlementService, tbankMapper } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Выплаченный');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    const payout = await payoutStatusService.payRestaurant(restId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_IN_PROGRESS);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_EXECUTED);

    const row = statusOf(await payoutStatusService.listPayoutStatuses(), restId);
    assert.equal(row.status, 'paid');
    assert.equal(row.statusTone, 'ok');
    assert.equal(row.canPay, false);
    await assert.rejects(() => payoutStatusService.payRestaurant(restId), /недоступна/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// G — HTTP
// ===========================================================================
test('G: экран «Финансы» — сводка, «Статус выплат», кнопки; реестр и карточка выплаты', async () => {
  const databaseUrl = await freshDatabase('fin12_http');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService } = requireFreshModules();
  const restId = await createRestaurant(db, 'HTTP Финансы');
  await seedFullyReady(db, restId);
  await createEarnedOrder(db, restId, { itemsTotal: 1000, commissionAmount: 70 });
  await closePeriod(settlementService);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const finance = await getPage(base, cookie, '/hq/finance');
    assert.equal(finance.status, 200);

    // Сводка — только нужные показатели, без служебных пояснений.
    assert.match(finance.html, /Выполненные заказы/);
    assert.match(finance.html, /Оборот/);
    assert.match(finance.html, /Доход YAAM/);
    assert.match(finance.html, /Сумма ресторанов/);
    assert.doesNotMatch(finance.html, /Остаток к будущим выплатам/, 'служебная формулировка удалена');
    assert.doesNotMatch(finance.html, /Возвраты показаны отдельно/, 'длинное пояснение удалено');

    // «Статус выплат» вместо таблицы ресторанов с аналитикой.
    assert.match(finance.html, /Статус выплат/);
    assert.match(finance.html, /Готов к выплате/);
    // Названия действий честные (docs/HQ-PRODUCT-SPEC.md): до подключения
    // банка операция только СОЗДАЁТ обязательство, деньги не отправляются.
    assert.match(finance.html, /Подготовить выплату/);
    assert.match(finance.html, /Подготовить все/);
    assert.doesNotMatch(finance.html, />Выплатить</, 'формулировка не должна обещать реальный перевод');
    assert.match(finance.html, /Все выплаты/);
    // Старая таблица позиций ресторанов (Договор/Готовность/Заказов/Оборот/
    // Комиссия/Сумма ресторана/Остаток) удалена целиком — аналитика не
    // дублируется на рабочем экране выплат.
    assert.doesNotMatch(finance.html, /<th>Договор<\/th>/);
    assert.doesNotMatch(finance.html, /<th>Готовность<\/th>/);
    assert.doesNotMatch(finance.html, /data-label="Сумма ресторана"/);

    // Календарь: на своём периоде есть «Применить» и нет авто-submit.
    const custom = await getPage(base, cookie, '/hq/finance?period=custom');
    assert.match(custom.html, /Применить/);
    assert.doesNotMatch(custom.html, /onchange="this\.form\.submit\(\)"/, 'дата не применяется без подтверждения');

    // Выплата через HTTP.
    const payRes = await postForm(base, cookie, `/hq/finance/payouts/${restId}/pay`, { _csrf: finance.csrf });
    assert.equal(payRes.status, 302);
    assert.match(payRes.headers.get('location'), /notice=/);

    // Реестр выплат — разделы, без технической таблицы.
    const registry = await getPage(base, cookie, '/hq/payouts');
    assert.equal(registry.status, 200);
    assert.match(registry.html, /Все выплаты/);
    assert.match(registry.html, /К отправке/);
    assert.match(registry.html, /HTTP Финансы/);

    // Карточка выплаты.
    const dbAgain = require('../../db/postgresql');
    const payoutRows = await dbAgain.query('SELECT id FROM restaurant_payouts WHERE restaurant_id = $1', [restId]);
    const detail = await getPage(base, cookie, `/hq/payouts/${payoutRows[0].id}`);
    assert.equal(detail.status, 200);
    assert.match(detail.html, /Дата подготовки/);
    assert.match(detail.html, /Дата выплаты/);
    assert.match(detail.html, /История попыток/);
    assert.match(detail.html, /неизменяемый снимок/);

    // Повторное нажатие «Подготовить выплату» через HTTP — ошибка, не второй payout.
    const financeAgain = await getPage(base, cookie, '/hq/finance');
    const payAgain = await postForm(base, cookie, `/hq/finance/payouts/${restId}/pay`, { _csrf: financeAgain.csrf });
    assert.equal(payAgain.status, 302);
    assert.match(payAgain.headers.get('location'), /error=/);
    const total = await dbAgain.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts WHERE restaurant_id = $1', [restId]);
    assert.equal(total[0].c, 1);
  } finally {
    await stopApp(instance);
  }
});

test('G2: массовая выплата через HTTP защищена CSRF и идемпотентна', async () => {
  const databaseUrl = await freshDatabase('fin12_http_batch');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService } = requireFreshModules();
  await seedYaamDetails(db);
  const restA = await createRestaurant(db, 'Пакет А');
  await seedLegal(db, restA); await seedBank(db, restA); await seedContract(db, restA);
  await createEarnedOrder(db, restA);
  await closePeriod(settlementService);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);

    // Без CSRF — отказ.
    const noCsrf = await fetch(`${base}/hq/finance/payouts/pay-all`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: '',
    });
    assert.equal(noCsrf.status, 403);

    const finance = await getPage(base, cookie, '/hq/finance');
    const batch = await postForm(base, cookie, '/hq/finance/payouts/pay-all', { _csrf: finance.csrf });
    assert.equal(batch.status, 302);

    const dbAgain = require('../../db/postgresql');
    let total = await dbAgain.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts');
    assert.equal(total[0].c, 1);

    // Повторное нажатие — дублей нет.
    const financeAgain = await getPage(base, cookie, '/hq/finance');
    await postForm(base, cookie, '/hq/finance/payouts/pay-all', { _csrf: financeAgain.csrf });
    total = await dbAgain.query('SELECT COUNT(*)::int AS c FROM restaurant_payouts');
    assert.equal(total[0].c, 1, 'повторное нажатие не создало вторую выплату');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// I — навигация: «Выплаты» не пункт основного меню, но маршрут жив
// ===========================================================================
test('I: пункта «Выплаты» нет в основной навигации, при этом /payouts и карточка выплаты открываются', async () => {
  const databaseUrl = await freshDatabase('fin12_nav');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService } = requireFreshModules();
  const restId = await createRestaurant(db, 'Навигация');
  await seedFullyReady(db, restId);
  await createEarnedOrder(db, restId);
  await closePeriod(settlementService);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const finance = await getPage(base, cookie, '/hq/finance');

    // В навигации (боковой и нижней мобильной) ссылки на /payouts нет.
    const navLinks = finance.html.match(/<a href="\/hq\/payouts"[^>]*>[^<]*<\/a>/g) || [];
    assert.equal(navLinks.length, 0, 'пункт меню «Выплаты» удалён');
    assert.match(finance.html, /Обзор/);
    assert.match(finance.html, /Рестораны/);
    assert.match(finance.html, /Настройки/);

    // Кнопка «Все выплаты» — единственная точка входа в реестр.
    assert.match(finance.html, /Все выплаты/);

    // Маршрут и обратный переход продолжают работать.
    const registry = await getPage(base, cookie, '/hq/payouts');
    assert.equal(registry.status, 200);
    assert.match(registry.html, /К финансам/);

    // Прямая ссылка на карточку выплаты работает.
    await postForm(base, cookie, `/hq/finance/payouts/${restId}/pay`, { _csrf: finance.csrf });
    const dbAgain = require('../../db/postgresql');
    const rows = await dbAgain.query('SELECT id FROM restaurant_payouts WHERE restaurant_id = $1', [restId]);
    const detail = await getPage(base, cookie, `/hq/payouts/${rows[0].id}`);
    assert.equal(detail.status, 200);
    assert.match(detail.html, /Выплата #/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// Аудит (спецификация, раздел 12) — журнал отдельный от выплат
// ===========================================================================
test('H: подготовка выплаты фиксируется в аудите, но выплаты и аудит остаются разными разделами', async () => {
  const databaseUrl = await freshDatabase('fin12_audit');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStatusService, settlementService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Аудит');
    await seedFullyReady(db, restId);
    await createEarnedOrder(db, restId);
    await closePeriod(settlementService);

    await payoutStatusService.payRestaurant(restId, { ip: '127.0.0.1' });

    const audit = await db.query("SELECT action, details FROM hq_audit_log WHERE action = 'payout_created'");
    assert.equal(audit.length, 1);
    assert.match(audit[0].details, /выплата #\d+: 930 ₽/);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
