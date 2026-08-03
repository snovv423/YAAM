'use strict';

// YAAM HQ — автоматические расчётные периоды и документы ресторанов
// (docs/HQ-PRODUCT-SPEC.md). Интеграционные тесты против настоящего
// embedded PostgreSQL, тот же harness-паттерн, что и остальные Stage-файлы.
//
// A — границы недели и расписание (Europe/Moscow).
// B — автозакрытие: due-недели, идемпотентность, конкурентность, catch-up.
// C — заказ до/на/после границы попадает ровно в один период.
// D — snapshot: суммы, возвраты, immutable после изменения данных.
// E — документы: отчёт агента, реестр, совпадение итогов, отсутствие ПДн.
// F — нумерация и корректирующие версии.
// G — доступ к документам: только HQ, без cross-restaurant.
// H — Telegram: успешная выплата, prepared, нет группы, ошибка adapter.
// I — UI: карточки периодов, детальная страница, статусы, отсутствие ручных кнопок.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

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
  require.resolve('../../services/hq/weeklySettlementService.js'),
  require.resolve('../../services/hq/settlementDocumentService.js'),
  require.resolve('../../services/hq/settlementNotificationService.js'),
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

const TEST_SESSION_SECRET = 's'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage13Settle';

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
  cluster = await startEmbeddedPostgres('hq-settlement-stage13');
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
    weekly: require('../../services/hq/weeklySettlementService'),
    settlementService: require('../../services/hq/settlementService'),
    documentService: require('../../services/hq/settlementDocumentService'),
    notificationService: require('../../services/hq/settlementNotificationService'),
    payoutService: require('../../services/hq/payoutService'),
    payoutStatusService: require('../../services/hq/payoutStatusService'),
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
    // Фоновый settlement-job выключен: тесты запускают его явно.
    weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
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

// --- Фикстуры ---
async function createRestaurant(db, name) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}

let orderCounter = 0;
// deliveredAt — момент, когда заказ стал delivered (status_updated_at): именно
// он и есть якорь попадания заказа в расчётный период.
async function createEarnedOrder(db, restaurantId, { itemsTotal = 1000, commissionAmount = 70, deliveredAt = null } = {}) {
  orderCounter += 1;
  const code = `YAAM-S${orderCounter}`;
  const rows = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at)
     VALUES ($1,$2,'Грозный','Иса Магомадов',$3,'ул. Секретная, 5, кв. 3','позвонить заранее',$4,$5,'delivered',COALESCE($6, NOW()))
     RETURNING id`,
    [code, restaurantId, `+7900${String(orderCounter).padStart(7, '0')}`, itemsTotal, commissionAmount, deliveredAt],
  );
  const orderId = rows.rows[0].id;
  const pay = await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`,
    [orderId, itemsTotal],
  );
  return { orderId, code, paymentId: pay.rows[0].id };
}

async function addSucceededRefund(db, paymentId, amount, completedAt = null) {
  const rows = await db.execute(
    `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,'mock',$2,'succeeded','customer_cancel',$3, COALESCE($4, NOW())) RETURNING id`,
    [paymentId, amount, `k-${paymentId}-${Math.random().toString(36).slice(2)}`, completedAt],
  );
  return rows.rows[0].id;
}

async function seedYaam(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО ЯАМ Платформа',$1,$2,$3,$4,'ТЕСТБАНК',$5) ON CONFLICT (id) DO NOTHING`,
    [FICTITIOUS_INN10, FICTITIOUS_KPP, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
}
async function seedRestaurantLegal(db, restaurantId, legalName = 'ИП Тестов Тест Тестович') {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip',$2,$3,$4,'г. Грозный, ул. Тестовая, 1','Тестов Т. Т.','+79280000001')`,
    [restaurantId, legalName, FICTITIOUS_INN12, FICTITIOUS_OGRNIP],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, default_payment_purpose)
     VALUES ($1,$2,$3,'',$4,$5,'ТЕСТБАНК',$6,'Оплата услуг')`,
    [restaurantId, legalName, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1,$2,'2026-01-01','signed')`,
    [restaurantId, `Д-${restaurantId}`],
  );
}

// Понедельник 00:05 МСК прошлой недели относительно now — гарантированно
// внутри «последней завершившейся недели».
function utcFromMoscow(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 180 * 60 * 1000);
}

// ===========================================================================
// A — границы недели и расписание
// ===========================================================================
test('A1: неделя — понедельник..воскресенье по Москве; закрытие в понедельник 07:00 МСК', async () => {
  const { weekly } = requireFreshModules();

  // Среда 2026-08-05 12:00 МСК -> последняя полная неделя 27.07..02.08.
  const wed = utcFromMoscow(2026, 8, 5, 12, 0);
  assert.deepEqual(weekly.lastCompletedWeek(wed), { periodFrom: '2026-07-27', periodTo: '2026-08-02' });

  // Плановое закрытие недели, закончившейся 02.08 (вс) — 03.08 (пн) 07:00 МСК:
  // сразу после недели, а не через семь суток.
  const closeAt = weekly.scheduledCloseAt('2026-08-02');
  assert.equal(closeAt.toISOString(), utcFromMoscow(2026, 8, 3, 7, 0).toISOString());
  assert.equal(weekly.SETTLEMENT_WEEKDAY, 1);
  assert.equal(weekly.SETTLEMENT_HOUR, 7);
});

test('A2: граница timezone — 00:30 МСК понедельника это уже новая неделя, 23:30 МСК воскресенья ещё старая', async () => {
  const { weekly } = requireFreshModules();
  // 2026-08-03 — понедельник. 00:30 МСК = 2026-08-02T21:30Z.
  const mondayEarly = utcFromMoscow(2026, 8, 3, 0, 30);
  assert.deepEqual(weekly.lastCompletedWeek(mondayEarly), { periodFrom: '2026-07-27', periodTo: '2026-08-02' });
  // Воскресенье 2026-08-02 23:30 МСК — прошлая полная неделя ещё 20..26 июля.
  const sundayLate = utcFromMoscow(2026, 8, 2, 23, 30);
  assert.deepEqual(weekly.lastCompletedWeek(sundayLate), { periodFrom: '2026-07-20', periodTo: '2026-07-26' });
});

// ===========================================================================
// B — автозакрытие
// ===========================================================================
test('B1: job закрывает прошедшую неделю; повторный запуск идемпотентен', async () => {
  const databaseUrl = await freshDatabase('settle13_close');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Ресторан А');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    // Заказ в среду прошлой недели.
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 29, 13, 0) });

    const now = utcFromMoscow(2026, 8, 9, 7, 5); // воскресенье после недели
    const first = await weekly.runWeeklySettlementJob({ now });
    assert.equal(first.skipped, false);
    assert.equal(first.closed.length, 1);
    assert.equal(first.closed[0].periodFrom, '2026-07-27');
    assert.equal(first.closed[0].periodTo, '2026-08-02');

    const periods = await db.query('SELECT * FROM settlement_periods');
    assert.equal(periods.length, 1);
    assert.equal(periods[0].status, 'closed');

    // Повторный запуск: новых периодов нет, ошибок нет.
    const second = await weekly.runWeeklySettlementJob({ now });
    assert.equal(second.closed.length, 0);
    assert.equal(second.failed.length, 0);
    const periodsAfter = await db.query('SELECT COUNT(*)::int AS c FROM settlement_periods');
    assert.equal(periodsAfter[0].c, 1, 'дубль периода не создан');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B2: конкурентный запуск не создаёт дубли (advisory-лока)', async () => {
  const databaseUrl = await freshDatabase('settle13_concurrent');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Ресторан Б');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 29, 13, 0) });

    const now = utcFromMoscow(2026, 8, 9, 7, 5);
    const [a, b] = await Promise.all([
      weekly.runWeeklySettlementJob({ now }),
      weekly.runWeeklySettlementJob({ now }),
    ]);
    const skippedCount = [a, b].filter((r) => r.skipped).length;
    const closedTotal = a.closed.length + b.closed.length;
    assert.ok(skippedCount >= 1 || closedTotal === 1, 'второй запуск не должен закрыть тот же период повторно');

    const periods = await db.query('SELECT COUNT(*)::int AS c FROM settlement_periods');
    assert.equal(periods[0].c, 1);
    const lines = await db.query('SELECT COUNT(*)::int AS c FROM settlement_restaurant_lines');
    assert.equal(lines[0].c, 1, 'строк расчёта ровно одна — двойного учёта нет');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B3: catch-up — после простоя закрываются ВСЕ пропущенные недели, без пересечений', async () => {
  const databaseUrl = await freshDatabase('settle13_catchup');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Ресторан В');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    // Заказы в трёх разных неделях подряд.
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 15, 12, 0) }); // 13..19 июля
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 22, 12, 0) }); // 20..26 июля
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) }); // 27.07..02.08

    // Сервер «лежал» три недели и стартовал 09.08 в 07:05.
    const now = utcFromMoscow(2026, 8, 9, 7, 5);
    const result = await weekly.runWeeklySettlementJob({ now });
    assert.equal(result.closed.length, 3, 'закрыты все три пропущенные недели');

    const periods = await db.query('SELECT period_from, period_to, status FROM settlement_periods ORDER BY period_from');
    assert.deepEqual(periods.map((p) => `${p.period_from}..${p.period_to}`), [
      '2026-07-13..2026-07-19', '2026-07-20..2026-07-26', '2026-07-27..2026-08-02',
    ]);
    assert.ok(periods.every((p) => p.status === 'closed'));

    // Каждый заказ ровно в одном периоде — гарантия UNIQUE(order_id).
    const orderLines = await db.query('SELECT order_id, COUNT(*)::int AS c FROM settlement_order_lines GROUP BY order_id');
    assert.ok(orderLines.every((r) => r.c === 1));

    // Catch-up отмечен в аудите.
    const audit = await db.query("SELECT COUNT(*)::int AS c FROM hq_audit_log WHERE action = 'settlement_period_catch_up'");
    assert.ok(audit[0].c >= 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B4: неделя без активности не создаёт пустой период', async () => {
  const databaseUrl = await freshDatabase('settle13_empty');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  try {
    await createRestaurant(db, 'Без заказов');
    const now = utcFromMoscow(2026, 8, 9, 7, 5);
    const result = await weekly.runWeeklySettlementJob({ now });
    assert.equal(result.closed.length, 0);
    const periods = await db.query('SELECT COUNT(*)::int AS c FROM settlement_periods');
    assert.equal(periods[0].c, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// C — границы: заказ до / на / после
// ===========================================================================
test('C: заказы до, на и после границы недели попадают ровно в один (правильный) период', async () => {
  const databaseUrl = await freshDatabase('settle13_boundary');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Границы');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);

    // Воскресенье 02.08 23:59 МСК — последняя минута недели 27.07..02.08.
    const before = await createEarnedOrder(db, restId, { itemsTotal: 100, commissionAmount: 7, deliveredAt: utcFromMoscow(2026, 8, 2, 23, 59) });
    // Понедельник 03.08 00:00 МСК — ровно граница, уже НОВАЯ неделя.
    const atBoundary = await createEarnedOrder(db, restId, { itemsTotal: 200, commissionAmount: 14, deliveredAt: utcFromMoscow(2026, 8, 3, 0, 0) });
    // Понедельник 03.08 00:01 МСК — новая неделя.
    const after = await createEarnedOrder(db, restId, { itemsTotal: 300, commissionAmount: 21, deliveredAt: utcFromMoscow(2026, 8, 3, 0, 1) });

    // Закрываем обе недели: запуск 16.08 закроет и 27.07..02.08, и 03.08..09.08.
    const result = await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 16, 7, 5) });
    assert.equal(result.closed.length, 2);

    const rows = await db.query(`
      SELECT sp.period_from, sp.period_to, sol.order_id
        FROM settlement_order_lines sol
        JOIN settlement_periods sp ON sp.id = sol.settlement_period_id
       ORDER BY sol.order_id`);
    const byOrder = new Map(rows.map((r) => [r.order_id, `${r.period_from}..${r.period_to}`]));

    assert.equal(byOrder.get(before.orderId), '2026-07-27..2026-08-02', 'заказ до границы — в старой неделе');
    assert.equal(byOrder.get(atBoundary.orderId), '2026-08-03..2026-08-09', 'заказ ровно на границе — в новой неделе');
    assert.equal(byOrder.get(after.orderId), '2026-08-03..2026-08-09', 'заказ после границы — в новой неделе');
    assert.equal(rows.length, 3, 'каждый заказ учтён ровно один раз');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// D — snapshot
// ===========================================================================
test('D: snapshot фиксирует суммы, возвраты и юр.данные; последующие правки его НЕ меняют', async () => {
  const databaseUrl = await freshDatabase('settle13_snapshot');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Снимок');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId, 'ИП Первоначальный');
    const o1 = await createEarnedOrder(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await createEarnedOrder(db, restId, { itemsTotal: 500, commissionAmount: 35, deliveredAt: utcFromMoscow(2026, 7, 30, 12, 0) });
    await addSucceededRefund(db, o1.paymentId, 1000, utcFromMoscow(2026, 7, 31, 12, 0));

    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });

    const before = (await db.query('SELECT * FROM settlement_restaurant_lines'))[0];
    assert.equal(before.legal_name_snapshot, 'ИП Первоначальный');
    assert.equal(before.inn_snapshot, FICTITIOUS_INN12);
    assert.equal(before.yaam_legal_name_snapshot, 'ООО ЯАМ Платформа');
    assert.equal(before.successful_refunds_count, 1);
    assert.equal(before.successful_refunds_amount, 1000);
    assert.equal(before.restaurant_name_snapshot, 'Снимок');

    // Меняем ВСЁ, что попало в снимок.
    await db.execute("UPDATE restaurants SET name = 'Новое имя' WHERE id = $1", [restId]);
    await db.execute("UPDATE restaurant_legal_details SET legal_name = 'ИП Изменённый', inn = '770912345616' WHERE restaurant_id = $1", [restId]);
    await db.execute("UPDATE restaurant_contracts SET commission_bps = 1500 WHERE restaurant_id = $1", [restId]);
    await db.execute("UPDATE yaam_bank_details SET legal_name = 'ООО Другое' WHERE id = 1");

    const after = (await db.query('SELECT * FROM settlement_restaurant_lines'))[0];
    assert.equal(after.legal_name_snapshot, 'ИП Первоначальный', 'снимок юр.имени неизменен');
    assert.equal(after.restaurant_name_snapshot, 'Снимок', 'снимок названия неизменен');
    assert.equal(after.yaam_legal_name_snapshot, 'ООО ЯАМ Платформа', 'снимок данных YAAM неизменен');
    assert.equal(after.turnover, before.turnover);
    assert.equal(after.yaam_commission, before.yaam_commission);

    // Прямая попытка изменить снимок отклоняется БД.
    await assert.rejects(
      () => db.execute('UPDATE settlement_restaurant_lines SET turnover = 1 WHERE id = $1', [before.id]),
      /immutable/i,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// E — документы
// ===========================================================================
test('E: отчёт агента и реестр строятся из snapshot, итоги совпадают, ПДн отсутствуют', async () => {
  const databaseUrl = await freshDatabase('settle13_docs');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Документы');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    const o1 = await createEarnedOrder(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await createEarnedOrder(db, restId, { itemsTotal: 500, commissionAmount: 35, deliveredAt: utcFromMoscow(2026, 7, 30, 12, 0) });
    await addSucceededRefund(db, o1.paymentId, 1000, utcFromMoscow(2026, 7, 31, 12, 0));

    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });
    const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;

    const docs = await documentService.listDocumentsForPeriod(periodId);
    assert.equal(docs.length, 2, 'сформированы оба документа');

    const agent = docs.find((d) => d.kind === 'agent_report');
    const registry = docs.find((d) => d.kind === 'order_registry');
    assert.equal(agent.status, 'generated');
    assert.equal(registry.status, 'generated');

    const ap = typeof agent.payload === 'string' ? JSON.parse(agent.payload) : agent.payload;
    const rp = typeof registry.payload === 'string' ? JSON.parse(registry.payload) : registry.payload;

    // Полностью возвращённый заказ (1000 ₽) НЕ входит в продажи — он исключён
    // из учтённых заказов ещё на уровне EARNED_ORDER_FILTER_SQL. Поэтому:
    // продажи 500, возвраты 1000 (информационно), база 500, комиссия 35.
    // Вычитание возвратов из базы было бы двойным учётом — см. обоснование
    // в services/hq/settlementDocumentService.js.
    assert.equal(ap.totals.sales, 500);
    assert.equal(ap.totals.refunds, 1000);
    assert.equal(ap.totals.commissionBase, 500);
    assert.equal(ap.totals.commissionAmount, 35);
    assert.equal(ap.totals.ordersCount, 1);

    // Итоги реестра ОБЯЗАНЫ совпадать с отчётом агента.
    assert.equal(rp.totals.sales, ap.totals.sales);
    assert.equal(rp.totals.refunds, ap.totals.refunds);
    assert.equal(rp.totals.commissionBase, ap.totals.commissionBase);
    assert.equal(rp.totals.commission, ap.totals.commissionAmount);
    assert.equal(rp.totals.payableAmount, ap.totals.payableAmount);

    // Данные сторон — из snapshot.
    assert.equal(ap.agent.legalName, 'ООО ЯАМ Платформа');
    assert.equal(ap.principal.legalName, 'ИП Тестов Тест Тестович');
    assert.equal(ap.contract.number, `Д-${restId}`);

    // ПДн клиента в реестре отсутствуют.
    const registryJson = JSON.stringify(rp);
    for (const pii of ['Иса Магомадов', 'ул. Секретная', 'позвонить заранее', '+7900']) {
      assert.ok(!registryJson.includes(pii), `реестр не должен содержать ПДн: ${pii}`);
    }

    // Юридическая формулировка не выдумана.
    assert.equal(ap.acceptanceTermsPending, true);
    assert.equal(ap.acceptanceTerms, null);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('E2: renderer детерминирован и не обращается к БД', async () => {
  const databaseUrl = await freshDatabase('settle13_render');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Рендер');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });
    const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
    const docs = await documentService.listDocumentsForPeriod(periodId);

    const views = require('../../hq/settlementDocumentViews');
    const first = views.renderDocument(docs[0]);
    const second = views.renderDocument(docs[0]);
    assert.equal(first, second, 'повторный рендер даёт тот же документ');
    assert.match(first, /Отчёт агента|Реестр заказов/);
    assert.match(first, /<meta charset="UTF-8">/, 'кириллица корректна за счёт UTF-8');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// F — нумерация и корректировки
// ===========================================================================
test('F: номера уникальны; корректировка создаёт новую версию, не трогая исходник', async () => {
  const databaseUrl = await freshDatabase('settle13_correction');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFreshModules();
  try {
    const restA = await createRestaurant(db, 'Корр А');
    const restB = await createRestaurant(db, 'Корр Б');
    await seedYaam(db);
    await seedRestaurantLegal(db, restA);
    await seedRestaurantLegal(db, restB);
    await createEarnedOrder(db, restA, { deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await createEarnedOrder(db, restB, { deliveredAt: utcFromMoscow(2026, 7, 29, 13, 0) });
    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });

    const all = await db.query('SELECT document_number FROM settlement_documents');
    assert.equal(new Set(all.map((d) => d.document_number)).size, all.length, 'все номера уникальны');

    const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
    const docs = await documentService.listDocumentsForPeriod(periodId);
    const original = docs.find((d) => d.kind === 'agent_report');

    const corrected = await documentService.createCorrectingVersion(original.id, { reason: 'Исправлены реквизиты' });
    assert.equal(corrected.version, 2);
    assert.equal(corrected.supersedes_document_id, original.id);
    assert.equal(corrected.correction_reason, 'Исправлены реквизиты');
    assert.match(corrected.document_number, /-и2$/);

    // Исходная версия сохранена без изменений.
    const stillThere = (await db.query('SELECT * FROM settlement_documents WHERE id = $1', [original.id]))[0];
    assert.equal(stillThere.version, 1);
    assert.equal(stillThere.document_number, original.document_number);

    // Причина обязательна.
    await assert.rejects(() => documentService.createCorrectingVersion(original.id, { reason: '  ' }), /Причина/i);

    // Прямое изменение документа отклоняется БД.
    await assert.rejects(
      () => db.execute("UPDATE settlement_documents SET status = 'failed' WHERE id = $1", [original.id]),
      /immutable/i,
    );

    const audit = await db.query("SELECT COUNT(*)::int AS c FROM hq_audit_log WHERE action = 'settlement_document_corrected'");
    assert.equal(audit[0].c, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// G — доступ к документам
// ===========================================================================
test('G: документы доступны только авторизованному владельцу и только внутри своего периода', async () => {
  const databaseUrl = await freshDatabase('settle13_access');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  const restA = await createRestaurant(db, 'Доступ А');
  const restB = await createRestaurant(db, 'Доступ Б');
  await seedYaam(db);
  await seedRestaurantLegal(db, restA);
  await seedRestaurantLegal(db, restB);
  await createEarnedOrder(db, restA, { deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
  await createEarnedOrder(db, restB, { deliveredAt: utcFromMoscow(2026, 8, 5, 12, 0) });
  // Две разные недели -> два периода.
  await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 16, 7, 5) });
  const periods = await db.query('SELECT id FROM settlement_periods ORDER BY period_from');
  const docsB = await db.query(
    'SELECT id FROM settlement_documents WHERE settlement_period_id = $1 LIMIT 1', [periods[1].id],
  );
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    // Без авторизации — редирект на логин, документ не отдаётся.
    const anon = await fetch(`${base}/hq/finance/settlements/${periods[1].id}/documents/${docsB[0].id}`, { redirect: 'manual' });
    assert.ok([302, 401, 403].includes(anon.status), `ожидали отказ без авторизации, получили ${anon.status}`);

    const cookie = await loginHq(base);
    const ok = await getPage(base, cookie, `/hq/finance/settlements/${periods[1].id}/documents/${docsB[0].id}`);
    assert.equal(ok.status, 200);

    // Тот же документ через ЧУЖОЙ период — 404, а не выдача.
    const cross = await getPage(base, cookie, `/hq/finance/settlements/${periods[0].id}/documents/${docsB[0].id}`);
    assert.equal(cross.status, 404, 'подмена периода в URL не должна отдавать документ');

    // Скачивание — тот же документ с Content-Disposition.
    const download = await fetch(`${base}/hq/finance/settlements/${periods[1].id}/documents/${docsB[0].id}?download=1`, {
      headers: { Cookie: cookie },
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// H — Telegram
// ===========================================================================
test('H1: при статусе prepared сообщение о перечислении НЕ отправляется', async () => {
  const databaseUrl = await freshDatabase('settle13_tg_prepared');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutStatusService, notificationService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'ТГ Подготовлено');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    await db.execute("UPDATE restaurants SET telegram_chat_id = 'chat-h1' WHERE id = $1", [restId]);
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });

    const payout = await payoutStatusService.payRestaurant(restId);
    const sent = [];
    const fakeBot = { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } };

    const result = await notificationService.notifyRestaurantAboutPayout(payout.id, { bot: fakeBot });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'payout_not_succeeded');
    assert.equal(sent.length, 0, 'ни одного сообщения о выплате при prepared');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('H2: после подтверждённой выплаты сообщение уходит в группу ЭТОГО ресторана', async () => {
  const databaseUrl = await freshDatabase('settle13_tg_paid');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutStatusService, payoutService, tbankMapper, notificationService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'ТГ Выплачено');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    await db.execute("UPDATE restaurants SET telegram_chat_id = 'chat-h2' WHERE id = $1", [restId]);
    await createEarnedOrder(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });

    const payout = await payoutStatusService.payRestaurant(restId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_IN_PROGRESS);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_EXECUTED);

    const sent = [];
    const fakeBot = { sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } };
    const result = await notificationService.notifyRestaurantAboutPayout(payout.id, {
      bot: fakeBot, publicBaseUrl: 'https://api.example',
    });

    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 'chat-h2', 'сообщение ушло в группу своего ресторана');
    assert.match(sent[0].text, /Выплата за/);
    assert.match(sent[0].text, /Продажи: 1000 ₽/);
    assert.match(sent[0].text, /Комиссия YAAM: 70 ₽/);
    assert.match(sent[0].text, /Перечислено: 930 ₽/);
    // Банковские реквизиты в чат не уходят.
    assert.ok(!sent[0].text.includes(FICTITIOUS_RS));
    assert.ok(!sent[0].text.includes(FICTITIOUS_BIK));
    // Ссылки есть, но ТОЛЬКО capability: /d/<token>, ведущие ровно на один
    // документ этого ресторана. HQ-ссылок быть не может — у ресторана нет
    // и не должно быть HQ-сессии.
    const buttons = sent[0].opts.reply_markup.inline_keyboard[0];
    assert.deepEqual(buttons.map((b) => b.text), ['Отчёт агента', 'Реестр заказов']);
    for (const b of buttons) {
      assert.match(b.url, /\/d\/yaam_doc_v1_/);
      assert.doesNotMatch(b.url, /\/hq\//);
    }
    assert.doesNotMatch(sent[0].text, /https?:\/\//, 'сам текст без URL — ссылки только кнопками');

    const audit = await db.query("SELECT COUNT(*)::int AS c FROM hq_audit_log WHERE action = 'settlement_notification_sent'");
    assert.equal(audit[0].c, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('H3: группа не подключена и ошибка adapter — доставка НЕ считается успешной, документы остаются', async () => {
  const databaseUrl = await freshDatabase('settle13_tg_fail');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutStatusService, payoutService, tbankMapper, notificationService, documentService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'ТГ Ошибка');
    await seedYaam(db);
    await seedRestaurantLegal(db, restId);
    await createEarnedOrder(db, restId, { deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
    await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });

    const payout = await payoutStatusService.payRestaurant(restId);
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_IN_PROGRESS);
    await tbankMapper.applyTBankPayoutStatus(attempt.id, tbankMapper.EXTERNAL_STATUS_EXECUTED);

    // Группы нет.
    const noGroup = await notificationService.notifyRestaurantAboutPayout(payout.id, { bot: { sendMessage: async () => {} } });
    assert.equal(noGroup.sent, false);
    assert.equal(noGroup.reason, 'telegram_not_connected');

    // Группа есть, но adapter падает.
    await db.execute("UPDATE restaurants SET telegram_chat_id = 'chat-h3' WHERE id = $1", [restId]);
    const failing = { sendMessage: async () => { throw new Error('network down'); } };
    const failed = await notificationService.notifyRestaurantAboutPayout(payout.id, { bot: failing });
    assert.equal(failed.sent, false);
    assert.equal(failed.reason, 'send_failed');

    // Оба случая в аудите, документы на месте.
    //
    // Событий три, а не два: с Stage 19.2 сам job после закрытия периода тоже
    // пытается уведомить ресторан, и в этом тесте бот в job не передан —
    // попытка честно фиксируется как 'bot_unavailable'. Проверяем не голое
    // число, а состав: две проверяемые здесь причины плюс попытка job.
    const audit = await db.query(
      "SELECT details FROM hq_audit_log WHERE action = 'settlement_notification_failed' ORDER BY id",
    );
    assert.equal(audit.length, 3);
    assert.equal(audit.filter((r) => /Telegram-группа ресторана не подключена/.test(r.details)).length, 2,
      'группа не подключена: попытка job при закрытии периода и явная проверка выше');
    assert.equal(audit.filter((r) => /network down/.test(r.details)).length, 1,
      'сбой adapter зафиксирован ровно один раз');
    // Токен не попадает в аудит ни при одной из причин.
    assert.ok(!audit.some((r) => /yaam_doc_v1_/.test(r.details)), 'в аудите не должно быть токена');
    const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
    const docs = await documentService.listDocumentsForPeriod(periodId);
    assert.equal(docs.length, 2, 'документы не зависят от доставки уведомления');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// I — UI
// ===========================================================================
// Регрессия: реестр — широкая таблица (8 колонок). На мобильном viewport она
// обязана скроллиться внутри своего контейнера (.table-scroll), а не растягивать
// страницу. И строка возврата не должна УТВЕРЖДАТЬ, что заказ из прошлого
// периода: полностью возвращённый заказ ЭТОЙ недели попадает в ту же ветку.
test('E3: реестр — таблица в скролл-контейнере, ярлык возврата не врёт про период', async () => {
  const databaseUrl = await freshDatabase('settle13_registry_ui');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFreshModules();
  const restId = await createRestaurant(db, 'Кафе Реестр');
  await seedYaam(db);
  await seedRestaurantLegal(db, restId);
  const inWeek = utcFromMoscow(2026, 7, 29, 12, 0);
  await createEarnedOrder(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: inWeek });
  // Полностью возвращённый заказ ЭТОЙ ЖЕ недели.
  const refunded = await createEarnedOrder(db, restId, { itemsTotal: 400, commissionAmount: 28, deliveredAt: inWeek });
  await addSucceededRefund(db, refunded.paymentId, 400, inWeek);

  await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const docs = await documentService.listDocumentsForPeriod(periodId);
  const registry = docs.find((d) => d.kind === 'order_registry');
  await db.close();

  const { renderDocument } = require('../../hq/settlementDocumentViews');
  const html = renderDocument(registry);

  assert.match(html, /class="table-scroll"/, 'широкая таблица обязана быть в скролл-контейнере');
  assert.match(html, /overflow-x:auto/, 'контейнер обязан скроллиться по горизонтали');
  assert.doesNotMatch(
    html,
    /прошлого периода/,
    'заказ этой недели, возвращённый полностью, не из прошлого периода — ярлык не должен это утверждать',
  );
  assert.match(html, /продажа в базу периода не включена/);
  // Возврат заказа этой недели виден отдельной строкой, итоги сходятся.
  assert.equal(registry.payload.totals.sales, 1000);
  assert.equal(registry.payload.totals.refunds, 400);
  assert.equal(registry.payload.totals.commissionBase, 1000);
});

test('I: карточки периодов и детальная страница без ручных кнопок, со статусом выплат и документами', async () => {
  const databaseUrl = await freshDatabase('settle13_ui');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFreshModules();
  const restId = await createRestaurant(db, 'Ресторан С Очень Длинным Названием Для Проверки Вёрстки');
  await seedYaam(db);
  await seedRestaurantLegal(db, restId);
  await createEarnedOrder(db, restId, { itemsTotal: 1234567, commissionAmount: 86419, deliveredAt: utcFromMoscow(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5) });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);

    // Финансы: карточка периода со статусом выплат, без ручного создания.
    const finance = await getPage(base, cookie, '/hq/finance');
    assert.equal(finance.status, 200);
    assert.match(finance.html, /Расчётные периоды/);
    assert.match(finance.html, /Ожидает выплат/);
    assert.doesNotMatch(finance.html, /\+ Новый период/, 'ручное создание периода удалено');
    assert.match(finance.html, /закрываются автоматически/);

    // Детальная страница.
    const detail = await getPage(base, cookie, `/hq/finance/settlements/${periodId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.html, /Ресторан С Очень Длинным Названием/);
    assert.match(detail.html, /Документы/);
    assert.match(detail.html, /Отчёт агента/);
    assert.match(detail.html, /Реестр заказов/);
    assert.match(detail.html, /Не подготовлена/, 'статус выплаты человеческим языком');
    assert.doesNotMatch(detail.html, /Закрыть период/, 'ручное закрытие удалено');
    assert.doesNotMatch(detail.html, /Удалить черновик/, 'ручное удаление удалено');
    // Большие суммы отображаются.
    assert.match(detail.html, /1234567 ₽/);
    // Технических статусов быть не должно.
    assert.doesNotMatch(detail.html, /payout_readiness_snapshot|commission_bps_summary/);

    // Ручных маршрутов больше нет.
    const removedNew = await fetch(`${base}/hq/finance/settlements/new`, { headers: { Cookie: cookie } });
    assert.equal(removedNew.status, 404, 'GET /finance/settlements/new удалён');
  } finally {
    await stopApp(instance);
  }
});

// Регрессия: «База» в строке ресторана на детальной странице ДОЛЖНА совпадать
// с базой комиссии в отчёте агента. Раньше UI считал её как
// turnover - возвраты, что при полностью возвращённом заказе давало число,
// не сходящееся ни с yaam_commission, ни с документом (двойной учёт: такой
// заказ и так исключён из turnover через EARNED_ORDER_FILTER_SQL).
test('I2: база комиссии в UI совпадает с базой в отчёте агента при полном возврате', async () => {
  const databaseUrl = await freshDatabase('settle13_ui_base');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFreshModules();
  const restId = await createRestaurant(db, 'Кафе Сверка Базы');
  await seedYaam(db);
  await seedRestaurantLegal(db, restId);
  const inWeek = utcFromMoscow(2026, 7, 29, 12, 0);
  await createEarnedOrder(db, restId, { itemsTotal: 1200, commissionAmount: 84, deliveredAt: inWeek });
  await createEarnedOrder(db, restId, { itemsTotal: 800, commissionAmount: 56, deliveredAt: inWeek });
  // Полностью возвращённый заказ: в turnover не попадает, но возврат виден.
  const refunded = await createEarnedOrder(db, restId, { itemsTotal: 500, commissionAmount: 35, deliveredAt: inWeek });
  await addSucceededRefund(db, refunded.paymentId, 500, inWeek);

  await weekly.runWeeklySettlementJob({ now: utcFromMoscow(2026, 8, 9, 7, 5), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const docs = await documentService.listDocumentsForPeriod(periodId);
  const agentReport = docs.find((d) => d.kind === 'agent_report' && d.restaurant_id === restId);
  const commissionBase = agentReport.payload.totals.commissionBase;
  await db.close();

  // Продажи = 2000 (возвращённый заказ исключён), база = продажи, НЕ 1500.
  assert.equal(commissionBase, 2000);

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const detail = await getPage(base, cookie, `/hq/finance/settlements/${periodId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.html, /Продажи 2000 ₽/);
    assert.match(detail.html, /Возвраты 500 ₽/);
    assert.match(
      detail.html,
      new RegExp(`База ${commissionBase} ₽`),
      'база в UI обязана совпадать с базой комиссии в отчёте агента',
    );
    assert.doesNotMatch(detail.html, /База 1500 ₽/, 'вычитание возвратов из базы — двойной учёт');
  } finally {
    await stopApp(instance);
  }
});
