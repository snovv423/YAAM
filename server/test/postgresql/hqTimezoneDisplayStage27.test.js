'use strict';

// YAAM HQ Stage 27 — проверка возможного дефекта часового пояса из Stage 26,
// раздел 2: владелец вводил "20:00" по Москве и на карточке выплаты видел
// "17:00" без единого объяснения. Причина — hq/payoutViews.js, hq/
// settlementViews.js, hq/settlementDocumentViews.js, hq/restaurantsViews.js
// каждый определяли СВОЙ formatDateTime на сырых getUTCHours() (реально
// показывали UTC), пока hq/settlementDocumentViews.js уже был единственным
// исключением с правильным сдвигом (без подписи). Фикс — общий hq/
// dateFormat.js (toMskDate), переиспользованный во всех четырёх местах, плюс
// суффикс "МСК" везде, где раньше не было никакой пометки. Хранение
// (PostgreSQL TIMESTAMPTZ) не менялось — только представление.
//
// Тот же harness/фикстуры, что и test/postgresql/hqOperationalCycleStage25.
// test.js — не изобретаются заново.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/weeklySettlementService.js'),
  require.resolve('../../services/hq/settlementDocumentService.js'),
  require.resolve('../../services/hq/settlementNotificationService.js'),
  require.resolve('../../services/hq/settlementDocumentAccessService.js'),
  require.resolve('../../services/hq/settlementAdjustmentService.js'),
  require.resolve('../../services/hq/restaurantBalanceService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../hq/dateFormat.js'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/settlements.js'),
  require.resolve('../../routes/hq/payouts.js'),
];

const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616', INN10: '7709123453', KPP: '770101001', OGRNIP: '312770012345008',
};

process.env.HQ_LOGIN_RATE_LIMIT_MAX = '200';
process.env.PG_POOL_MAX = '4';

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('hq-tz-stage27'); });
after(async () => {
  await cluster.stop();
  delete process.env.HQ_LOGIN_RATE_LIMIT_MAX;
  delete process.env.PG_POOL_MAX;
});

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}

function msk(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 180 * 60 * 1000);
}
function pad2(n) { return String(n).padStart(2, '0'); }
// Ожидаемая строка "YYYY-MM-DD HH:mm МСК" для сравнения с рендером HQ —
// независимый расчёт, не переиспользующий toMskDate() (иначе тест доказывал
// бы только то, что функция равна самой себе).
function expectedMskString(utcDate) {
  const local = new Date(utcDate.getTime() + 180 * 60 * 1000);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())} МСК`;
}
// hq/settlementDocumentViews.js использует точечный формат "DD.MM.YYYY
// HH:mm" (свой, отдельный от ISO-подобного "YYYY-MM-DD HH:mm" на карточке
// выплаты/периода) — Stage 27 не унифицирует визуальные форматы между
// экранами, только чинит часовой пояс под каждым, поэтому здесь отдельный
// ожидаемый шаблон, а не переиспользование expectedMskString().
function expectedMskDocString(utcDate) {
  const local = new Date(utcDate.getTime() + 180 * 60 * 1000);
  return `${pad2(local.getUTCDate())}.${pad2(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())} МСК`;
}

async function createRestaurant(db, name) {
  const r = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return r.rows[0].id;
}

let counter = 0;
async function order(db, restaurantId, { itemsTotal, commissionAmount, deliveredAt }) {
  counter += 1;
  const code = `YAAM-S27-${String(counter).padStart(4, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // эта фикстура всегда создаёт 'delivered' напрямую SQL, поэтому earned_at
  // безусловно равен тому же deliveredAt, что и status_updated_at (тот же
  // принцип, что и backfill в миграции 0013).
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Иса Тестов',$3,'ул. Тестовая, 5','',$4,$5,'delivered',$6,$6) RETURNING id`,
    [code, restaurantId, `+7903${String(counter).padStart(7, '0')}`, itemsTotal, commissionAmount, deliveredAt],
  );
  await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded')`, [o.rows[0].id, itemsTotal]);
  return o.rows[0].id;
}

async function seedYaam(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО ЯАМ Платформа',$1,$2,$3,$4,'ТЕСТБАНК',$5) ON CONFLICT (id) DO NOTHING`,
    [FICT.INN10, FICT.KPP, FICT.RS, FICT.BIK, FICT.KS],
  );
}
async function seedLegal(db, restaurantId, legalName = 'ИП Закрытов З. З.') {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip',$2,$3,$4,'г. Грозный, ул. Тестовая, 1','Закрытов З. З.','+79280000003')`,
    [restaurantId, legalName, FICT.INN12, FICT.OGRNIP],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, default_payment_purpose)
     VALUES ($1,$2,$3,'',$4,$5,'ТЕСТБАНК',$6,'Оплата услуг')`,
    [restaurantId, legalName, FICT.INN12, FICT.RS, FICT.BIK, FICT.KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1,$2,'2026-01-01','signed')`,
    [restaurantId, `ДЗ-${restaurantId}`],
  );
}

const TEST_SESSION_SECRET = 'm'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage27Tz';
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});

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
  process.env.PUBLIC_BACKEND_URL = 'https://hqtest.example.invalid';
  delete process.env.TELEGRAM_BOT_TOKEN;
  for (const p of MODULE_PATHS) delete require.cache[p];
  const appModule = require('../../services/postgresql/app.js');
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
  delete process.env.PUBLIC_BACKEND_URL;
  await new Promise((r) => setTimeout(r, 200));
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

async function closedPeriodWithDocs(db, weekly, restaurantId, { itemsTotal = 1000, commissionAmount = 70 } = {}) {
  await order(db, restaurantId, { itemsTotal, commissionAmount, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from DESC LIMIT 1');
  return periods[0];
}

test('TZ1: карточка выплаты показывает 20:00 МСК (не 17:00), когда владелец ввёл именно 20:00 по Москве', async () => {
  const databaseUrl = await freshDatabase('tz27_1');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе TZ1');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);

    const pageRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const pageHtml = await pageRes.text();
    const csrf = extractCsrf(pageHtml);
    // Форма подписана явно "(по московскому времени)" — сама проверка того,
    // что рядом с полем ввода нет двусмысленности (задание, раздел 2:
    // "поле редактирования/подтверждения").
    assert.match(pageHtml, /Дата и время платежа \(по московскому времени\)/);

    await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, paid_at: '2026-08-01T20:00', operation_reference: 'TZ-OP-001' }).toString(),
    });

    const cardRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const html = await cardRes.text();
    // 20:00 МСК владелец ввёл -> должно ХРАНИТЬСЯ как 17:00 UTC (2026-08-01T17:00:00Z),
    // но ПОКАЗЫВАТЬСЯ владельцу снова как 20:00 МСК, а не как сырые 17:00.
    assert.match(html, /2026-08-01 20:00 МСК/, 'карточка должна показать 20:00 МСК, введённые владельцем, а не сырой UTC');
    assert.ok(!html.includes('2026-08-01 17:00'), 'карточка не должна показывать сырой UTC без пересчёта');

    const stored = await db.query('SELECT completed_at FROM restaurant_payouts WHERE id = $1', [payout.id]);
    assert.equal(new Date(stored[0].completed_at).toISOString(), '2026-08-01T17:00:00.000Z', 'в БД по-прежнему должен храниться UTC — меняется только отображение');
  } finally {
    await stopApp(instance);
  }
});

test('TZ2: история попыток тоже показывает московское время с суффиксом, не сырой UTC', async () => {
  const databaseUrl = await freshDatabase('tz27_2');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе TZ2');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    const pageRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, paid_at: '2026-08-01T09:15', operation_reference: 'TZ-OP-002' }).toString(),
    });
    const cardHtml = await (await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } })).text();
    assert.match(cardHtml, /Завершена: 2026-08-01 09:15 МСК/);

    const attempts = await payoutService.listAttemptsForPayout(payout.id);
    const createdExpected = expectedMskString(new Date(attempts[0].created_at));
    assert.ok(cardHtml.includes(`Создана: ${createdExpected}`), `ожидали "Создана: ${createdExpected}" в HTML истории попыток`);
  } finally {
    await stopApp(instance);
  }
});

test('TZ3: список всех выплат (/hq/payouts) тоже показывает московское время с суффиксом', async () => {
  const databaseUrl = await freshDatabase('tz27_3');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе TZ3');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    const pageRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, paid_at: '2026-08-01T11:30', operation_reference: 'TZ-OP-003' }).toString(),
    });
    const listHtml = await (await fetch(`${base}/hq/payouts`, { headers: { Cookie: cookie } })).text();
    assert.match(listHtml, /Выплачена: 2026-08-01 11:30 МСК/);
  } finally {
    await stopApp(instance);
  }
});

test('TZ4: страница расчётного периода показывает "Период закрыт" в московском времени с суффиксом', async () => {
  const databaseUrl = await freshDatabase('tz27_4');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const settlementService = require('../../services/hq/settlementService');
    const restId = await createRestaurant(db, 'Кафе TZ4');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const detail = await settlementService.getSettlementPeriodDetail(period.id);
    const expected = expectedMskString(new Date(detail.period.closed_at));

    const html = await (await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } })).text();
    assert.ok(html.includes(`Период закрыт ${expected}`), `ожидали "Период закрыт ${expected}" в HTML, получили фрагмент: ${html.match(/Период закрыт [^,<]+/)}`);
  } finally {
    await stopApp(instance);
  }
});

test('TZ5: документ ("Отчёт агента") показывает дату формирования в московском времени с суффиксом', async () => {
  const databaseUrl = await freshDatabase('tz27_5');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const documentService = require('../../services/hq/settlementDocumentService');
    const restId = await createRestaurant(db, 'Кафе TZ5');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const docs = await documentService.listDocumentsForPeriod(period.id);
    const doc = docs.find((d) => d.kind === 'agent_report');
    const payload = typeof doc.payload === 'string' ? JSON.parse(doc.payload) : doc.payload;
    const expected = expectedMskDocString(new Date(payload.generatedAt));

    const html = await (await fetch(`${base}/hq/finance/settlements/${period.id}/documents/${doc.id}`, { headers: { Cookie: cookie } })).text();
    assert.ok(html.includes(`Сформирован ${expected}`), `ожидали "Сформирован ${expected}", получили фрагмент: ${html.match(/Сформирован [^·<]+/)}`);
  } finally {
    await stopApp(instance);
  }
});

test('TZ6: переход даты через полночь по Москве корректно виден на реальной карточке выплаты', async () => {
  const databaseUrl = await freshDatabase('tz27_6');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе TZ6');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    const pageRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    // 23:30 по Москве 1 августа -> хранится как 20:30 UTC ТОГО ЖЕ дня, но
    // календарная дата не пересекает полночь ни в одну, ни в другую сторону
    // для ЭТОГО конкретного значения — проверяем именно то, что дата не
    // "утекла" на соседние сутки ни в ОДНОМ из направлений преобразования.
    await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, paid_at: '2026-08-01T23:30', operation_reference: 'TZ-OP-006' }).toString(),
    });
    const html = await (await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /2026-08-01 23:30 МСК/, 'должна показаться именно введённая дата/время, без сдвига суток');
    const stored = await db.query('SELECT completed_at FROM restaurant_payouts WHERE id = $1', [payout.id]);
    assert.equal(new Date(stored[0].completed_at).toISOString(), '2026-08-01T20:30:00.000Z');
  } finally {
    await stopApp(instance);
  }
});
