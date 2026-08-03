'use strict';

// YAAM HQ — «Обзор» переработан согласно docs/HQ-PRODUCT-SPEC.md.
// Интеграционные тесты против настоящего embedded PostgreSQL, тот же
// harness-паттерн, что и остальные Stage-файлы этой директории (Stage 7/9).
//
// A — getOverviewMetrics: today/week/month, "Рестораны" = COUNT DISTINCT
//     среди заработанных заказов периода, не is_open/published.
// B — eventLogService: createEvent валидация, порядок ленты, курсор очистки,
//     история игнорирует курсор, пагинация.
// C — formatEventTimestamp: сегодня -> время, старое -> дата+время, обе
//     ветки НЕ зависят от локального TZ окружения теста.
// D — sweepTimeouts эмитит ровно одно order_missed событие на просроченный
//     заказ (не задваивается повторным сканированием).
// E — finalizeRefundFailed эмитит refund_issue один раз (idempotent-повтор —
//     без дубликата).
// F — markAttemptFailed: blocked (retryable=false) эмитит payout_issue;
//     retryable=true (обратно в prepared) — НЕ эмитит.
// G — HTTP: GET / отдаёт 4 метрики + Центр событий; переключатель периода;
//     POST /events/clear прячет из основной ленты, но не удаляет; GET
//     /events/history показывает очищенное.
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
  require.resolve('../../services/hq/restaurantStatsService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../services/hq/eventLogService.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'k'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Overview10';

const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_INN10 = '7709123453';
const FICTITIOUS_KPP = '770101001';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-overview-stage10');
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
    orderService: require('../../services/postgresql/orderService'),
    dashboardMetrics: require('../../services/hq/dashboardMetrics'),
    eventLogService: require('../../services/hq/eventLogService'),
    settlementService: require('../../services/hq/settlementService'),
    payoutService: require('../../services/hq/payoutService'),
    yaamBankDetailsService: require('../../services/hq/yaamBankDetailsService'),
    restaurantBankDetailsService: require('../../services/hq/restaurantBankDetailsService'),
    restaurantContractService: require('../../services/hq/restaurantContractService'),
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

// ---------------------------------------------------------------------------
// Фикстуры (тот же принцип, что hqRestaurantFinanceStage7.test.js/
// hqPayoutStage9.test.js — прямой SQL быстрее и точнее контролирует статус/
// даты, чем полный HTTP-flow для каждого сценария).
// ---------------------------------------------------------------------------
async function createRestaurant(db, name) {
  const rows = await db.execute('INSERT INTO restaurants (name, cities) VALUES ($1,$2) RETURNING id', [name, '[]']);
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null }) {
  orderCounter += 1;
  const code = `YAAM-T${orderCounter}`;
  const phone = `+7900${String(orderCounter).padStart(7, '0')}`;
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

async function seedRestaurantPayoutReadiness(db, restaurantId) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, 'ООО YAAM Платформа', $1, $2, $3, $4, 'ТЕСТБАНК', $5) ON CONFLICT (id) DO NOTHING`,
    [FICTITIOUS_INN10, FICTITIOUS_KPP, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account, default_payment_purpose)
     VALUES ($1, 'ИП Тестов Тест Тестович', $2, '', $3, $4, 'ТЕСТБАНК', $5, 'Оплата услуг доставки по договору')`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status) VALUES ($1, $2, '2026-01-01', 'signed')`,
    [restaurantId, `Д-${restaurantId}`],
  );
}
async function closedPeriodWithEarnings(db, settlementService, restaurantId, { itemsTotal = 1000, commissionAmount = 70 } = {}) {
  const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal, commissionAmount });
  await addSucceededPayment(db, orderId, itemsTotal);
  const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
  await settlementService.closeSettlementPeriod(period.id);
  return period;
}
async function toProcessingAttempt(payoutService, payoutId) {
  const attempt = await payoutService.createPayoutAttempt(payoutId);
  await payoutService.markAttemptSubmitting(attempt.id);
  const { attempt: processing } = await payoutService.markAttemptProcessing(attempt.id);
  return processing;
}

// ===========================================================================
// A — getOverviewMetrics
// ===========================================================================
test('A1: getOverviewMetrics("today") считает только delivered+paid+не возвращённые заказы, "Рестораны" = COUNT DISTINCT среди них', async () => {
  const databaseUrl = await freshDatabase('overview_today');
  process.env.DATABASE_URL = databaseUrl;
  const { db, dashboardMetrics } = requireFreshModules();
  try {
    const restA = await createRestaurant(db, 'A');
    const restB = await createRestaurant(db, 'B');

    const earnedA = await createOrderRow(db, { restaurantId: restA, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, earnedA, 1000);
    const earnedB = await createOrderRow(db, { restaurantId: restB, status: 'delivered', itemsTotal: 500, commissionAmount: 35 });
    await addSucceededPayment(db, earnedB, 500);

    // Не должны учитываться: awaiting_restaurant, cancelled, payment_failed.
    const notDelivered = await createOrderRow(db, { restaurantId: restA, status: 'awaiting_restaurant', itemsTotal: 300, commissionAmount: 21 });
    await addSucceededPayment(db, notDelivered, 300);
    await createOrderRow(db, { restaurantId: restA, status: 'cancelled', itemsTotal: 200, commissionAmount: 14 });

    const result = await dashboardMetrics.getOverviewMetrics({ period: 'today' });
    assert.equal(result.ordersCount, 2);
    assert.equal(result.turnover, 1500);
    assert.equal(result.commission, 105);
    assert.equal(result.restaurantsCount, 2);
    assert.equal(result.period, 'today');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('A2: getOverviewMetrics — заказ за пределами периода (week/month) не считается; нулевой период даёт нули, не ошибку', async () => {
  const databaseUrl = await freshDatabase('overview_periods');
  process.env.DATABASE_URL = databaseUrl;
  const { db, dashboardMetrics } = requireFreshModules();
  try {
    const rest = await createRestaurant(db, 'A');
    const oldOrder = await createOrderRow(db, {
      restaurantId: rest, status: 'delivered', itemsTotal: 1000, commissionAmount: 70,
      statusUpdatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), // 40 дней назад — вне "месяца" (30д)
    });
    await addSucceededPayment(db, oldOrder, 1000);

    const today = await dashboardMetrics.getOverviewMetrics({ period: 'today' });
    assert.deepEqual({ o: today.ordersCount, t: today.turnover, r: today.restaurantsCount }, { o: 0, t: 0, r: 0 });

    const month = await dashboardMetrics.getOverviewMetrics({ period: 'month' });
    assert.equal(month.ordersCount, 0, 'заказ 40 дней назад не входит в скользящее окно 30 дней');

    const recentOrder = await createOrderRow(db, { restaurantId: rest, status: 'delivered', itemsTotal: 2000, commissionAmount: 140 });
    await addSucceededPayment(db, recentOrder, 2000);
    const week = await dashboardMetrics.getOverviewMetrics({ period: 'week' });
    assert.equal(week.ordersCount, 1);
    assert.equal(week.turnover, 2000);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// B — eventLogService
// ===========================================================================
test('B1: createEvent отклоняет неизвестную категорию и пустое сообщение', async () => {
  const databaseUrl = await freshDatabase('events_validation');
  process.env.DATABASE_URL = databaseUrl;
  const { eventLogService } = requireFreshModules();
  try {
    await assert.rejects(() => eventLogService.createEvent({ category: 'no_such_category', message: 'x' }), /неизвестная категория/i);
    await assert.rejects(() => eventLogService.createEvent({ category: 'other', message: '   ' }), /message обязателен/i);
  } finally {
    const { db } = requireFreshModules();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B2: listActiveEvents — хронологический порядок (старые сверху), курсор очистки скрывает старые, история их сохраняет', async () => {
  const databaseUrl = await freshDatabase('events_clear_history');
  process.env.DATABASE_URL = databaseUrl;
  const { db, eventLogService } = requireFreshModules();
  try {
    // clearActiveFeed() двигает курсор на singleton-строке hq_owner (id=1) —
    // в production она всегда создана при первом старте приложения
    // (ensureOwnerFromEnv), но эти тесты обращаются к сервису напрямую, без
    // полного HTTP-старта приложения (см. тест G ниже, где строка уже
    // существует) — создаём её здесь минимально сами.
    await db.execute(
      `INSERT INTO hq_owner (id, login, password_hash) VALUES (1, 'owner', 'x') ON CONFLICT (id) DO NOTHING`,
    );
    const e1 = await eventLogService.createEvent({ category: 'other', message: 'первое' });
    const e2 = await eventLogService.createEvent({ category: 'other', message: 'второе' });

    const beforeClear = await eventLogService.listActiveEvents();
    assert.deepEqual(beforeClear.map((e) => e.message), ['первое', 'второе']);

    await eventLogService.clearActiveFeed();
    const afterClear = await eventLogService.listActiveEvents();
    assert.deepEqual(afterClear, [], 'после очистки основная лента пуста');

    const stillInDb = await db.query('SELECT COUNT(*)::int AS c FROM hq_events');
    assert.equal(stillInDb[0].c, 2, 'очистка не удаляет строки из БД');

    const archive = await eventLogService.listArchive({ page: 1 });
    assert.deepEqual(archive.events.map((e) => e.message), ['первое', 'второе'], 'история игнорирует курсор очистки');

    const e3 = await eventLogService.createEvent({ category: 'other', message: 'третье, после очистки' });
    const afterNew = await eventLogService.listActiveEvents();
    assert.deepEqual(afterNew.map((e) => e.message), ['третье, после очистки'], 'новое событие после очистки снова видно в основной ленте');
    assert.ok(e1.id < e2.id && e2.id < e3.id);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B3: listArchive — пагинация возвращает корректный total/totalPages', async () => {
  const databaseUrl = await freshDatabase('events_archive_pagination');
  process.env.DATABASE_URL = databaseUrl;
  const { db, eventLogService } = requireFreshModules();
  try {
    for (let i = 0; i < 3; i += 1) {
      await eventLogService.createEvent({ category: 'other', message: `событие ${i}` });
    }
    const page1 = await eventLogService.listArchive({ page: 1 });
    assert.equal(page1.total, 3);
    assert.equal(page1.totalPages, 1);
    assert.equal(page1.events.length, 3);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// C — formatEventTimestamp
// ===========================================================================
test('C1: formatEventTimestamp — то же календарное число по Москве -> только время', async () => {
  const { eventLogService } = requireFreshModules();
  const now = new Date('2026-08-01T10:00:00Z'); // 13:00 МСК
  const occurredAt = new Date('2026-08-01T06:42:17Z'); // 09:42:17 МСК, тот же день
  assert.equal(eventLogService.formatEventTimestamp(occurredAt, now), '09:42:17');
});

test('C2: formatEventTimestamp — другой день -> дата и время в одной строке', async () => {
  const { eventLogService } = requireFreshModules();
  const now = new Date('2026-08-01T10:00:00Z');
  const occurredAt = new Date('2026-07-31T15:24:09Z'); // 18:24:09 МСК предыдущего дня
  assert.equal(eventLogService.formatEventTimestamp(occurredAt, now), '31.07.2026 · 18:24:09');
});

test('C3: formatEventTimestamp — граница полуночи по Москве, не по UTC', async () => {
  const { eventLogService } = requireFreshModules();
  // 2026-08-01 21:30 UTC = 2026-08-02 00:30 МСК — уже "завтра" по МСК, хотя UTC-дата ещё та же.
  const now = new Date('2026-08-01T21:30:00Z');
  const occurredAt = new Date('2026-08-01T20:00:00Z'); // 23:00 МСК 01.08 — вчера по МСК относительно now
  assert.equal(eventLogService.formatEventTimestamp(occurredAt, now), '01.08.2026 · 23:00:00');
});

// ===========================================================================
// D — sweepTimeouts эмитит order_missed
// ===========================================================================
test('D: sweepTimeouts создаёт ровно одно order_missed событие на просроченный заказ, с именем ресторана и кодом заказа', async () => {
  const databaseUrl = await freshDatabase('events_order_missed');
  process.env.DATABASE_URL = databaseUrl;
  const { db, orderService, eventLogService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Хачапурная');
    const orderId = await createOrderRow(db, {
      restaurantId, status: 'awaiting_restaurant', statusUpdatedAt: new Date(Date.now() - 3600 * 1000),
    });
    await addSucceededPayment(db, orderId, 1000);

    await orderService.sweepTimeouts();
    // Событие пишется fire-and-forget ПОСЛЕ коммита — короткая пауза на запись.
    await new Promise((r) => setTimeout(r, 200));

    const events = await eventLogService.listActiveEvents();
    const missed = events.filter((e) => e.category === 'order_missed');
    assert.equal(missed.length, 1);
    assert.equal(missed[0].restaurantName, 'Хачапурная');
    assert.match(missed[0].message, /не принят за 5 минут/);
    assert.match(missed[0].message, /YAAM-T\d+/);

    // Повторный sweep — заказ уже timed_out, второй раз событие не создаётся.
    await orderService.sweepTimeouts();
    await new Promise((r) => setTimeout(r, 200));
    const eventsAfterSecondSweep = await eventLogService.listActiveEvents();
    assert.equal(eventsAfterSecondSweep.filter((e) => e.category === 'order_missed').length, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// E — finalizeRefundFailed эмитит refund_issue
// ===========================================================================
test('E: finalizeRefundFailed создаёт ровно одно refund_issue событие, idempotent-повтор не дублирует', async () => {
  const databaseUrl = await freshDatabase('events_refund_issue');
  process.env.DATABASE_URL = databaseUrl;
  const { db, orderService, eventLogService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Ресторан С Возвратом');
    const orderId = await createOrderRow(db, { restaurantId, status: 'awaiting_restaurant' });
    const paymentId = await addSucceededPayment(db, orderId, 1000);
    const refundRows = await db.execute(
      `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
       VALUES ($1, 'mock', 1000, 'processing', 'timeout', $2) RETURNING id`,
      [paymentId, `refund-key-${orderId}`],
    );
    const refundId = refundRows.rows[0].id;

    const failed = await orderService.finalizeRefundFailed(refundId, 'provider_unavailable');
    assert.equal(failed.status, 'failed');
    await new Promise((r) => setTimeout(r, 200));

    let events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'refund_issue');
    assert.equal(events.length, 1);
    assert.match(events[0].message, /провайдер был недоступен/);

    // Idempotent-повтор (уже failed) — не создаёт второе событие.
    await orderService.finalizeRefundFailed(refundId, 'provider_unavailable');
    await new Promise((r) => setTimeout(r, 200));
    events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'refund_issue');
    assert.equal(events.length, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// F — markAttemptFailed: blocked эмитит payout_issue, retryable — нет
// ===========================================================================
test('F1: markAttemptFailed(retryable:false) блокирует обязательство и создаёт payout_issue', async () => {
  const databaseUrl = await freshDatabase('events_payout_blocked');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, eventLogService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Ресторан С Выплатой');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await toProcessingAttempt(payoutService, payout.id);

    const { payout: blocked } = await payoutService.markAttemptFailed(attempt.id, {
      errorMessage: 'реквизиты получателя некорректны', retryable: false,
    });
    assert.equal(blocked.status, 'blocked');
    await new Promise((r) => setTimeout(r, 200));

    const events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'payout_issue');
    assert.equal(events.length, 1);
    assert.equal(events[0].restaurantName, 'Ресторан С Выплатой');
    assert.match(events[0].message, /заблокирована/);
    assert.match(events[0].message, /реквизиты получателя некорректны/);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('F2: markAttemptFailed(retryable:true) возвращает в prepared и НЕ создаёт событие (самовосстанавливающийся сбой)', async () => {
  const databaseUrl = await freshDatabase('events_payout_retryable');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutService, eventLogService } = requireFreshModules();
  try {
    const restaurantId = await createRestaurant(db, 'Ресторан Ретрай');
    await seedRestaurantPayoutReadiness(db, restaurantId);
    const period = await closedPeriodWithEarnings(db, settlementService, restaurantId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restaurantId);
    const attempt = await toProcessingAttempt(payoutService, payout.id);

    const { payout: afterFail } = await payoutService.markAttemptFailed(attempt.id, {
      errorMessage: 'временный сбой шлюза', retryable: true,
    });
    assert.equal(afterFail.status, 'prepared');
    await new Promise((r) => setTimeout(r, 200));

    const events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'payout_issue');
    assert.equal(events.length, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// G — HTTP: страница «Обзор», переключатель периода, очистка/история
// ===========================================================================
test('G: GET / отдаёт 4 метрики + Центр событий; переключатель периода меняет числа; очистка/история работают через HTTP', async () => {
  const databaseUrl = await freshDatabase('overview_http');
  const { db } = requireFreshModules();
  process.env.DATABASE_URL = databaseUrl;
  const restaurantId = await createRestaurant(db, 'HTTP Ресторан');
  const orderId = await createOrderRow(db, { restaurantId, status: 'delivered', itemsTotal: 1200, commissionAmount: 84 });
  await addSucceededPayment(db, orderId, 1200);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const overview = await getPage(base, cookie, '/hq/');
    assert.equal(overview.status, 200);
    assert.match(overview.html, /Заказы/);
    assert.match(overview.html, /Оборот/);
    assert.match(overview.html, /Доход YAAM/);
    assert.match(overview.html, /Рестораны/);
    assert.match(overview.html, /Центр событий/);
    assert.match(overview.html, /1200 ₽/);
    assert.match(overview.html, /84 ₽/);
    assert.match(overview.html, /Проблем нет\./, 'пустая лента — спокойная фраза, без декоративных нулей');
    assert.ok(!/Требует внимания/.test(overview.html), 'старый блок "Требует внимания" удалён');
    assert.ok(!/Средний чек/.test(overview.html), 'средний чек не должен присутствовать на Обзоре');

    const week = await getPage(base, cookie, '/hq/?period=week');
    assert.match(week.html, /1200 ₽/, 'заказ "сегодня" тоже входит в "неделю"');

    // Создаём проблемное событие напрямую через сервис, затем проверяем
    // очистку/историю через реальные HTTP-маршруты.
    const { eventLogService } = requireFreshModules();
    process.env.DATABASE_URL = databaseUrl;
    await eventLogService.createEvent({ category: 'other', message: 'HTTP-тестовое событие' });

    const withEvent = await getPage(base, cookie, '/hq/');
    assert.match(withEvent.html, /HTTP-тестовое событие/);

    const clearRes = await postForm(base, cookie, '/hq/events/clear', { _csrf: withEvent.csrf });
    assert.equal(clearRes.status, 302);

    const afterClear = await getPage(base, cookie, '/hq/');
    assert.ok(!afterClear.html.includes('HTTP-тестовое событие'), 'очищенное событие больше не в основной ленте');
    assert.match(afterClear.html, /Проблем нет\./);

    const history = await getPage(base, cookie, '/hq/events/history');
    assert.equal(history.status, 200);
    assert.match(history.html, /HTTP-тестовое событие/, 'история сохраняет очищенное событие');
  } finally {
    await stopApp(instance);
  }
});
