'use strict';

// YAAM HQ Stage 6 — интеграционные тесты юридических данных/банковских
// реквизитов/договора против настоящего embedded PostgreSQL (задание,
// раздел 14B). Тот же harness-паттерн, что и hqMediaStage5B.test.js.
//
// A — legal details create/update, один набор данных на ресторан.
// B — bank details create/update, невалидный счёт/ИНН отклоняются сервером.
// C — contract create/update/status, "подписан" требует номер+дату.
// D — изоляция между ресторанами (данные одного не видны/не путаются с другим).
// E — CSRF/auth/404.
// F — audit log: события создания/правки/смены статуса, маскировка счёта.
// G — payout readiness DTO и Finance-страница.
// H — public API / Telegram (bot query shape) leak scan.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

// См. server/test/postgresql/hqMediaStage5B.test.js — тот же полный список
// модулей, которые где-либо делают require('.../db/postgresql'), нужен для
// корректной изоляции между тестами (без него разные тесты этого файла
// могли бы делить один протухший пул соединений, указывающий на чужую БД —
// найденный и исправленный баг test harness'а в Stage 5B.2).
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
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'f'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage6Legal';

const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616'; // ИП, валидная контрольная сумма
const FICTITIOUS_OGRNIP = '312770012345008';
const FICTITIOUS_INN10 = '7709123453'; // ООО, валидная контрольная сумма
const FICTITIOUS_OGRN = '1027700123450';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-legal-bank-stage6');
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

async function createRestaurant(base, cookie, name) {
  const createPage = await getPage(base, cookie, '/hq/restaurants/new');
  const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name, cities: 'Грозный' });
  const restaurantPath = createRes.headers.get('location');
  const restaurantId = Number(restaurantPath.split('/').pop());
  return { restaurantId, restaurantPath };
}

const VALID_LEGAL_IP = {
  legal_form: 'ip', legal_name: 'ИП Тестов Тест Тестович', inn: FICTITIOUS_INN12,
  ogrn: FICTITIOUS_OGRNIP, legal_address: 'г. Грозный, ул. Тестовая, 1',
  director_name: 'Тестов Т.Т.', contact_phone: '+79001234567',
};
const VALID_BANK = {
  recipient_name: 'ИП Тестов Тест Тестович', recipient_inn: FICTITIOUS_INN12,
  account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК',
  correspondent_account: FICTITIOUS_KS,
};

// ---------------------------------------------------------------------------
// A — юридические данные: create/update, один набор на ресторан
// ---------------------------------------------------------------------------
test('A1: legal details — create, затем update, ровно одна запись на ресторан', async () => {
  const databaseUrl = await freshDatabase('legal_create_update');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Legal CRUD Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP });

    const db = require('../../db/postgresql');
    let rows = await db.query('SELECT * FROM restaurant_legal_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 1, 'ровно одна запись после создания');
    assert.equal(rows[0].legal_name, 'ИП Тестов Тест Тестович');

    // Update — то же самое ИЛИ другое значение, но ровно ОДНА строка после.
    editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, {
      _csrf: editPage.csrf, ...VALID_LEGAL_IP, legal_name: 'ИП Тестов Тест Тестович (обновлено)',
    });
    rows = await db.query('SELECT * FROM restaurant_legal_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 1, 'по-прежнему ровно одна запись после update (upsert, не второй insert)');
    assert.equal(rows[0].legal_name, 'ИП Тестов Тест Тестович (обновлено)');
  } finally {
    await stopApp(instance);
  }
});

test('A2: legal details — некорректный ИНН отклоняется сервером, строка не создаётся', async () => {
  const databaseUrl = await freshDatabase('legal_invalid_inn');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Invalid INN Restaurant');
    const editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    const res = await postForm(base, cookie, `${restaurantPath}/legal-details`, {
      _csrf: editPage.csrf, ...VALID_LEGAL_IP, inn: '770912345610', // неверная контрольная сумма
    });
    assert.equal(res.status, 400);
    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT * FROM restaurant_legal_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 0, 'невалидный ИНН не должен создавать строку');
  } finally {
    await stopApp(instance);
  }
});

test('A3: legal details — КПП для ИП отклоняется (только для ООО)', async () => {
  const databaseUrl = await freshDatabase('legal_kpp_ip');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath } = await createRestaurant(base, cookie, 'KPP IP Restaurant');
    const editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    const res = await postForm(base, cookie, `${restaurantPath}/legal-details`, {
      _csrf: editPage.csrf, ...VALID_LEGAL_IP, kpp: '770901001',
    });
    assert.equal(res.status, 400);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// B — банковские реквизиты
// ---------------------------------------------------------------------------
test('B1: bank details — create, затем update, ровно одна запись на ресторан', async () => {
  const databaseUrl = await freshDatabase('bank_create_update');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Bank CRUD Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK });

    const db = require('../../db/postgresql');
    let rows = await db.query('SELECT * FROM restaurant_bank_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_number, FICTITIOUS_RS);

    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK, bank_name: 'НОВЫЙ БАНК' });
    rows = await db.query('SELECT * FROM restaurant_bank_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 1, 'по-прежнему ровно одна запись');
    assert.equal(rows[0].bank_name, 'НОВЫЙ БАНК');
  } finally {
    await stopApp(instance);
  }
});

test('B2: bank details — расчётный счёт не соответствует БИК отклоняется', async () => {
  const databaseUrl = await freshDatabase('bank_invalid_account');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Invalid Account Restaurant');
    const editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    const res = await postForm(base, cookie, `${restaurantPath}/bank-details`, {
      _csrf: editPage.csrf, ...VALID_BANK, account_number: '40702810938050001239', // испорчена последняя цифра
    });
    assert.equal(res.status, 400);
    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT * FROM restaurant_bank_details WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 0);
  } finally {
    await stopApp(instance);
  }
});

test('B3: bank details — корреспондентский счёт не соответствует БИК отклоняется', async () => {
  const databaseUrl = await freshDatabase('bank_invalid_correspondent');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath } = await createRestaurant(base, cookie, 'Invalid Correspondent Restaurant');
    const editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    const res = await postForm(base, cookie, `${restaurantPath}/bank-details`, {
      _csrf: editPage.csrf, ...VALID_BANK, correspondent_account: '30101810400000004566',
    });
    assert.equal(res.status, 400);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// C — договор
// ---------------------------------------------------------------------------
test('C1: contract — create/update, статус "Подписан" требует номер и дату', async () => {
  const databaseUrl = await freshDatabase('contract_crud');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Contract CRUD Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    const badRes = await postForm(base, cookie, `${restaurantPath}/contract`, {
      _csrf: editPage.csrf, status: 'signed', commission_percent: '7',
    });
    assert.equal(badRes.status, 400, 'signed без номера/даты должен отклоняться');

    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, {
      _csrf: editPage.csrf, status: 'signed', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7',
    });

    const db = require('../../db/postgresql');
    let rows = await db.query('SELECT * FROM restaurant_contracts WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'signed');
    assert.equal(rows[0].commission_bps, 700);

    // Смена статуса на "Приостановлен" — не требует номер/дату заново, не
    // стирает уже сохранённые данные (задание, раздел 9).
    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, {
      _csrf: editPage.csrf, status: 'suspended', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7',
    });
    rows = await db.query('SELECT * FROM restaurant_contracts WHERE restaurant_id = $1', [restaurantId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'suspended');
    assert.equal(rows[0].contract_number, 'Д-1', 'номер договора не должен стираться при смене статуса');
  } finally {
    await stopApp(instance);
  }
});

test('C2: contract — дата окончания раньше даты начала отклоняется', async () => {
  const databaseUrl = await freshDatabase('contract_bad_dates');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath } = await createRestaurant(base, cookie, 'Bad Dates Restaurant');
    const editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    const res = await postForm(base, cookie, `${restaurantPath}/contract`, {
      _csrf: editPage.csrf, status: 'not_signed', starts_at: '2026-06-01', ends_at: '2026-01-01', commission_percent: '7',
    });
    assert.equal(res.status, 400);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// D — изоляция между ресторанами
// ---------------------------------------------------------------------------
test('D1: данные одного ресторана не путаются с другим (legal/bank/contract)', async () => {
  const databaseUrl = await freshDatabase('isolation');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const restA = await createRestaurant(base, cookie, 'Isolation A');
    const restB = await createRestaurant(base, cookie, 'Isolation B');

    let editPage = await getPage(base, cookie, `${restA.restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restA.restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP, legal_name: 'Ресторан А' });

    // У B данных нет вовсе — страница настроек B должна показать "Не заполнено", а не данные A.
    const settingsB = await getPage(base, cookie, `${restB.restaurantPath}/settings`);
    assert.ok(!settingsB.html.includes('Ресторан А'), 'данные ресторана A не должны просачиваться в настройки B');

    const db = require('../../db/postgresql');
    const rowsA = await db.query('SELECT * FROM restaurant_legal_details WHERE restaurant_id = $1', [restA.restaurantId]);
    const rowsB = await db.query('SELECT * FROM restaurant_legal_details WHERE restaurant_id = $1', [restB.restaurantId]);
    assert.equal(rowsA.length, 1);
    assert.equal(rowsB.length, 0);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// E — CSRF/auth/404
// ---------------------------------------------------------------------------
test('E1: сохранение юридических данных без CSRF-токена отклоняется', async () => {
  const databaseUrl = await freshDatabase('csrf_check');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath } = await createRestaurant(base, cookie, 'CSRF Restaurant');
    const res = await fetch(`${base}${restaurantPath}/legal-details`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ ...VALID_LEGAL_IP }).toString(), // без _csrf
    });
    assert.equal(res.status, 403);
  } finally {
    await stopApp(instance);
  }
});

test('E2: без HQ-сессии — редирект на логин, реквизиты не читаются', async () => {
  const databaseUrl = await freshDatabase('auth_check');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const res = await fetch(`${base}/hq/restaurants/1/legal-details/edit`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /login/);
  } finally {
    await stopApp(instance);
  }
});

test('E3: несуществующий ресторан — честный 404, не 500', async () => {
  const databaseUrl = await freshDatabase('not_found_check');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const res = await fetch(`${base}/hq/restaurants/999999/legal-details/edit`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// F — audit log
// ---------------------------------------------------------------------------
test('F1: audit log — created/updated/status_changed события, маскированный счёт, полный счёт не логируется', async () => {
  const databaseUrl = await freshDatabase('audit_log_check');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Audit Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP });
    editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP, legal_name: 'ИП Тестов (обновлено)' });

    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK });
    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    // Другой ВАЛИДНЫЙ (проходит проверку против того же БИК) счёт — нужен
    // реальный diff "старое -> новое", а не идентичное значение, чтобы
    // проверить маскированную запись в audit log.
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK, account_number: '40702810938050009997' });

    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, { _csrf: editPage.csrf, status: 'signed', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7' });
    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, { _csrf: editPage.csrf, status: 'suspended', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7' });

    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT action, details FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id', [restaurantId]);
    const actions = rows.map((r) => r.action);
    for (const expected of [
      'restaurant_legal_details_created', 'restaurant_legal_details_updated',
      'restaurant_bank_details_created', 'restaurant_bank_details_updated',
      'restaurant_contract_created', 'restaurant_contract_status_changed',
    ]) {
      assert.ok(actions.includes(expected), `ожидали событие "${expected}", получили: ${actions.join(', ')}`);
    }

    const allDetails = rows.map((r) => r.details).filter(Boolean).join(' | ');
    assert.ok(!allDetails.includes(FICTITIOUS_RS), 'полный расчётный счёт не должен попадать в audit log');
    assert.ok(!allDetails.includes(FICTITIOUS_KS), 'полный корреспондентский счёт не должен попадать в audit log');
    assert.ok(/\*\*\*\*\d{4}/.test(allDetails), 'маскированный счёт (****NNNN) должен присутствовать в логе');

    const statusChangeRow = rows.find((r) => r.action === 'restaurant_contract_status_changed');
    assert.match(statusChangeRow.details, /status: "signed" -> "suspended"/);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// G — payout readiness DTO + Finance-страница
// ---------------------------------------------------------------------------
test('G1: payout readiness проходит все стадии missing_legal -> missing_bank -> contract_not_signed -> ready', async () => {
  const databaseUrl = await freshDatabase('readiness_stages');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Readiness Restaurant');

    const payoutService = require('../../services/hq/restaurantPayoutService');
    let payout = await payoutService.getRestaurantPayoutDetails(restaurantId);
    assert.equal(payout.readiness, 'missing_legal_details');

    let editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP });
    payout = await payoutService.getRestaurantPayoutDetails(restaurantId);
    assert.equal(payout.readiness, 'missing_bank_details');

    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK });
    payout = await payoutService.getRestaurantPayoutDetails(restaurantId);
    assert.equal(payout.readiness, 'contract_not_signed');

    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, { _csrf: editPage.csrf, status: 'signed', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7' });
    payout = await payoutService.getRestaurantPayoutDetails(restaurantId);
    assert.equal(payout.readiness, 'ready');
    assert.equal(payout.recipientName, VALID_BANK.recipient_name);
    assert.equal(payout.commissionBps, 700);

    // Finance-страница отражает ту же готовность.
    const financePage = await getPage(base, cookie, '/hq/finance');
    assert.ok(financePage.html.includes('Готов'));
    assert.ok(!financePage.html.includes('Выплатить'));
  } finally {
    await stopApp(instance);
  }
});

test('G2: invalid_details — данные, записанные напрямую в обход сервисного слоя, честно не считаются "ready"', async () => {
  const databaseUrl = await freshDatabase('readiness_invalid');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Invalid Details Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP });
    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK });
    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, { _csrf: editPage.csrf, status: 'signed', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7' });

    // Прямая порча БД в обход сервисного слоя — симулирует legacy/битые данные.
    const db = require('../../db/postgresql');
    await db.execute('UPDATE restaurant_bank_details SET bik = $1 WHERE restaurant_id = $2', ['000000000', restaurantId]);

    const payoutService = require('../../services/hq/restaurantPayoutService');
    const payout = await payoutService.getRestaurantPayoutDetails(restaurantId);
    assert.equal(payout.readiness, 'invalid_details');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// H — public API / Telegram (bot query shape) leak scan
// ---------------------------------------------------------------------------
test('H1: публичный API не содержит юридических/банковских данных ни в списке, ни в детальной карточке', async () => {
  const databaseUrl = await freshDatabase('public_api_leak');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Public Leak Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP });
    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK });
    editPage = await getPage(base, cookie, `${restaurantPath}/contract/edit`);
    await postForm(base, cookie, `${restaurantPath}/contract`, { _csrf: editPage.csrf, status: 'signed', contract_number: 'Д-1', signed_at: '2026-01-15', commission_percent: '7' });

    const listRes = await fetch(`${base}/api/restaurants`);
    const listText = await listRes.text();
    const detailRes = await fetch(`${base}/api/restaurants/${restaurantId}`);
    const detailText = await detailRes.text();

    const secrets = [
      FICTITIOUS_INN12, FICTITIOUS_OGRNIP, FICTITIOUS_RS, FICTITIOUS_KS, FICTITIOUS_BIK,
      'Д-1', 'Тестов Т.Т.', 'г. Грозный, ул. Тестовая, 1', 'ТЕСТБАНК',
    ];
    for (const secret of secrets) {
      assert.ok(!listText.includes(secret), `публичный список не должен содержать "${secret}"`);
      assert.ok(!detailText.includes(secret), `публичная карточка не должна содержать "${secret}"`);
    }
    for (const field of ['inn', 'ogrn', 'kpp', 'bik', 'account_number', 'correspondent_account', 'contract_number', 'commission_bps', 'legal_address', 'director_name']) {
      assert.ok(!listText.includes(field), `публичный список не должен содержать поле "${field}"`);
      assert.ok(!detailText.includes(field), `публичная карточка не должна содержать поле "${field}"`);
    }
  } finally {
    await stopApp(instance);
  }
});

test('H2: Telegram bot — запрос ресторана по схеме бота (SELECT * FROM restaurants) структурно не может содержать юридические/банковские поля', async () => {
  const databaseUrl = await freshDatabase('bot_leak_shape');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { restaurantPath, restaurantId } = await createRestaurant(base, cookie, 'Bot Shape Restaurant');

    let editPage = await getPage(base, cookie, `${restaurantPath}/legal-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/legal-details`, { _csrf: editPage.csrf, ...VALID_LEGAL_IP });
    editPage = await getPage(base, cookie, `${restaurantPath}/bank-details/edit`);
    await postForm(base, cookie, `${restaurantPath}/bank-details`, { _csrf: editPage.csrf, ...VALID_BANK });

    // Дословно тот же запрос, что использует server/bot/postgresql/index.js
    // для получения ресторана по id (см. getRestaurantById там) — не JOIN,
    // не SELECT из новых таблиц, поэтому структурно не может вернуть
    // юридические/банковские поля, даже если они полностью заполнены.
    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    const keys = Object.keys(rows[0]);
    for (const forbidden of ['inn', 'ogrn', 'kpp', 'bik', 'account_number', 'correspondent_account', 'legal_address', 'director_name', 'contract_number', 'commission_bps']) {
      assert.ok(!keys.includes(forbidden), `restaurants-строка, которую видит бот, не должна содержать поле "${forbidden}"`);
    }
  } finally {
    await stopApp(instance);
  }
});
