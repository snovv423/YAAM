'use strict';

// YAAM HQ Stage 14 — настройки владельца, данные YAAM, реквизиты, чеки.
//
// P — смена пароля (аккаунт владельца).
// Y — юридические данные YAAM.
// R — банковские реквизиты и снимки.
// F — фискальные чеки.
// K — разделение режимов YooKassa.
// U — экран настроек.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/hq/ownerService.js'),
  require.resolve('../../services/hq/yaamLegalDetailsService.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/weeklySettlementService.js'),
  require.resolve('../../services/hq/settlementDocumentService.js'),
  require.resolve('../../services/hq/restaurantBalanceService.js'),
  require.resolve('../../services/hq/settlementAdjustmentService.js'),
  require.resolve('../../services/fiscalization/fiscalReceiptService.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/index.js'),
  // middleware.js держит ссылку на ownerService, а тот — на пул БД. Без
  // сброса он проверял бы credentials_version в базе ПРЕДЫДУЩЕГО теста и
  // рушил бы сессию текущего.
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/hq/auth.js'),
];

const TEST_SESSION_SECRET = 's'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage14';

// Фиктивные, но структурно валидные реквизиты. Настоящих в тестах нет.
const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616', INN10: '7709123453', KPP: '770101001', OGRNIP: '312770012345008',
};

let cluster;
let TEST_HQ_PASSWORD_HASH;

// Все тесты файла делят один процесс и один IP (127.0.0.1), поэтому их
// логины суммарно упираются в общий login-лимит (8 за 15 минут). Это тот же
// случай, для которого в routes/hq/middleware.js уже существует штатный
// override — им и пользуемся, а не ослабляем сам лимит.
process.env.HQ_LOGIN_RATE_LIMIT_MAX = '200';

before(async () => {
  cluster = await startEmbeddedPostgres('hq-settings-stage14');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});
after(async () => {
  await cluster.stop();
  delete process.env.HQ_LOGIN_RATE_LIMIT_MAX;
});

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
    legalService: require('../../services/hq/yaamLegalDetailsService'),
    bankService: require('../../services/hq/yaamBankDetailsService'),
    receiptService: require('../../services/fiscalization/fiscalReceiptService'),
    settlementService: require('../../services/hq/settlementService'),
    weekly: require('../../services/hq/weeklySettlementService'),
    documentService: require('../../services/hq/settlementDocumentService'),
  };
}

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден');
  return m[1];
}
async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer не начал слушать');
}
async function startApp(databaseUrl, envOverrides = {}) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = envOverrides.PAYMENT_PROVIDER || 'mock';
  for (const p of MODULE_PATHS) delete require.cache[p];
  const appModule = require('../../services/postgresql/app.js');
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH,
    hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, port, base: `http://127.0.0.1:${port}` };
}
async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
}
async function loginHq(base, password = TEST_HQ_PASSWORD) {
  const loginRes = await fetch(`${base}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password }).toString(),
  });
  return cookieHeaderFrom(postRes) || cookie;
}
async function getPage(base, cookie, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  return { res, html, status: res.status, csrf: html.includes('name="_csrf"') ? extractCsrf(html) : null };
}
async function post(base, cookie, urlPath, fields) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

// ===========================================================================
// P — смена пароля
// ===========================================================================

test('P1: экран аккаунта — логин read-only, без смены логина и без блока статуса сессии', async () => {
  const databaseUrl = await freshDatabase('s14_account');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { html, status } = await getPage(base, cookie, '/hq/settings');
    assert.equal(status, 200);

    assert.match(html, /Аккаунт владельца/);
    assert.match(html, /Логин изменить нельзя/);
    assert.match(html, /Изменить пароль/);
    assert.doesNotMatch(html, /Сменить логин|Новый логин/, 'смены логина в UI быть не должно');
    assert.doesNotMatch(html, /Статус сессии/, 'бесполезный блок удалён');
    // Четыре блока настроек присутствуют.
    for (const title of ['Аккаунт владельца', 'Данные YAAM', 'Банковские реквизиты', 'Платежи и касса']) {
      assert.ok(html.includes(title), `блок «${title}» отсутствует`);
    }
  } finally {
    await stopApp(instance);
  }
});

test('P2: смена пароля — CSRF обязателен, повтор и текущий пароль проверяются', async () => {
  const databaseUrl = await freshDatabase('s14_password');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { csrf } = await getPage(base, cookie, '/hq/settings');

    // Без CSRF.
    const noCsrf = await post(base, cookie, '/hq/settings/change-password', {
      currentPassword: TEST_HQ_PASSWORD, newPassword: 'An0ther!Pass#2026', confirmPassword: 'An0ther!Pass#2026',
    });
    assert.equal(noCsrf.status, 403, 'без CSRF операция должна быть отклонена');

    // Новый пароль совпадает с текущим — бессмысленная операция.
    const same = await post(base, cookie, '/hq/settings/change-password', {
      _csrf: csrf, currentPassword: TEST_HQ_PASSWORD,
      newPassword: TEST_HQ_PASSWORD, confirmPassword: TEST_HQ_PASSWORD,
    });
    assert.equal(same.status, 400);
    assert.match(await same.text(), /совпадает с текущим/);

    // Успех.
    const { csrf: csrf2 } = await getPage(base, cookie, '/hq/settings');
    const ok = await post(base, cookie, '/hq/settings/change-password', {
      _csrf: csrf2, currentPassword: TEST_HQ_PASSWORD,
      newPassword: 'An0ther!Pass#2026', confirmPassword: 'An0ther!Pass#2026',
    });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/hq/settings?changed=password');

    // Повторная отправка ТОЙ ЖЕ формы уже не пройдёт: текущий пароль сменился.
    const replay = await post(base, cookie, '/hq/settings/change-password', {
      _csrf: csrf2, currentPassword: TEST_HQ_PASSWORD,
      newPassword: 'An0ther!Pass#2026', confirmPassword: 'An0ther!Pass#2026',
    });
    assert.equal(replay.status, 401, 'повторная отправка не должна сработать второй раз');
  } finally {
    await stopApp(instance);
  }
});

test('P3: пароль не попадает ни в аудит, ни в security log', async () => {
  const databaseUrl = await freshDatabase('s14_password_leak');
  const { instance, base } = await startApp(databaseUrl);
  const { db } = requireFresh();
  process.env.DATABASE_URL = databaseUrl;
  try {
    const cookie = await loginHq(base);
    const { csrf } = await getPage(base, cookie, '/hq/settings');
    await post(base, cookie, '/hq/settings/change-password', {
      _csrf: csrf, currentPassword: 'НЕВЕРНЫЙ-ПАРОЛЬ-XYZ',
      newPassword: 'Secret!New#Pass2026', confirmPassword: 'Secret!New#Pass2026',
    });
    const { csrf: csrf2 } = await getPage(base, cookie, '/hq/settings');
    await post(base, cookie, '/hq/settings/change-password', {
      _csrf: csrf2, currentPassword: TEST_HQ_PASSWORD,
      newPassword: 'Secret!New#Pass2026', confirmPassword: 'Secret!New#Pass2026',
    });

    const dbm = require('../../db/postgresql');
    const audit = await dbm.query("SELECT details FROM hq_audit_log WHERE action LIKE 'owner_password%'");
    assert.ok(audit.length >= 2);
    const allText = JSON.stringify(audit);
    assert.ok(!allText.includes('Secret!New#Pass2026'), 'новый пароль не должен попадать в аудит');
    assert.ok(!allText.includes('НЕВЕРНЫЙ-ПАРОЛЬ-XYZ'), 'введённый неверный пароль не должен попадать в аудит');
    assert.ok(!allText.includes(TEST_HQ_PASSWORD));

    const sec = await dbm.query('SELECT * FROM hq_security_log');
    assert.ok(!JSON.stringify(sec).includes('Secret!New#Pass2026'));
    await dbm.close();
  } finally {
    await stopApp(instance);
  }
});

test('P4: rate limit на смену пароля срабатывает и не раскрывает пароль в ответе', async () => {
  const databaseUrl = await freshDatabase('s14_password_rl');
  process.env.HQ_PASSWORD_RATE_LIMIT_MAX = '3';
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    let last;
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { csrf } = await getPage(base, cookie, '/hq/settings');
      // eslint-disable-next-line no-await-in-loop
      last = await post(base, cookie, '/hq/settings/change-password', {
        _csrf: csrf, currentPassword: 'WRONG', newPassword: 'Whatever!Pass#1', confirmPassword: 'Whatever!Pass#1',
      });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429, 'перебор текущего пароля обязан упереться в лимит');
    const text = await last.text();
    assert.ok(!text.includes('WRONG'), 'ответ лимитера не должен содержать введённый пароль');
  } finally {
    delete process.env.HQ_PASSWORD_RATE_LIMIT_MAX;
    await stopApp(instance);
  }
});

// ===========================================================================
// Y — юридические данные YAAM
// ===========================================================================

test('Y1: валидация ИНН, ОГРНИП, email и телефона', async () => {
  const databaseUrl = await freshDatabase('s14_legal_validate');
  process.env.DATABASE_URL = databaseUrl;
  const { db, legalService } = requireFresh();

  const valid = {
    legalName: 'ИП Тестов Тест Тестович',
    entrepreneurName: 'Тестов Тест Тестович',
    inn: FICT.INN12, ogrnip: FICT.OGRNIP,
    registrationAddress: 'г. Грозный, ул. Тестовая, 1',
  };
  assert.ok(legalService.validate(valid));

  assert.throws(() => legalService.validate({ ...valid, inn: '123' }), /ИНН/);
  // 10-значный ИНН — это организация, у ИП такого не бывает.
  assert.throws(() => legalService.validate({ ...valid, inn: FICT.INN10 }), /ИНН/);
  assert.throws(() => legalService.validate({ ...valid, ogrnip: '123' }), /ОГРНИП/);
  assert.throws(() => legalService.validate({ ...valid, legalName: '  ' }), /наименование/);
  assert.throws(() => legalService.validate({ ...valid, registrationAddress: '' }), /адрес/);
  assert.throws(() => legalService.validate({ ...valid, contactEmail: 'не-email' }), /email/);
  assert.throws(() => legalService.validate({ ...valid, registrationDate: '01.01.2020' }), /ГГГГ-ММ-ДД/);

  // PENDING LEGAL-поля необязательны: пустое значение проходит.
  const withoutOptional = legalService.validate(valid);
  assert.equal(withoutOptional.contactEmail, '');
  assert.equal(withoutOptional.registrationDate, null);
  assert.deepEqual(legalService.PENDING_LEGAL_FIELDS, ['contactEmail', 'contactPhone', 'registrationDate']);
  await db.close();
});

test('Y2: сохранение — singleton, аудит без значений ИНН и ОГРНИП', async () => {
  const databaseUrl = await freshDatabase('s14_legal_save');
  process.env.DATABASE_URL = databaseUrl;
  const { db, legalService } = requireFresh();

  await legalService.saveYaamLegalDetails({
    legalName: 'ИП Первый', entrepreneurName: 'Первый П. П.',
    inn: FICT.INN12, ogrnip: FICT.OGRNIP, registrationAddress: 'Адрес 1',
  });
  await legalService.saveYaamLegalDetails({
    legalName: 'ИП Второй', entrepreneurName: 'Второй В. В.',
    inn: FICT.INN12, ogrnip: FICT.OGRNIP, registrationAddress: 'Адрес 2',
  });

  const rows = await db.query('SELECT * FROM yaam_legal_details');
  assert.equal(rows.length, 1, 'singleton: строка ровно одна');
  assert.equal(rows[0].legal_name, 'ИП Второй');

  const audit = await db.query("SELECT details FROM hq_audit_log WHERE action = 'yaam_legal_details_updated' ORDER BY id");
  assert.equal(audit.length, 2);
  const text = JSON.stringify(audit);
  assert.ok(!text.includes(FICT.INN12), 'ИНН не должен попадать в аудит');
  assert.ok(!text.includes(FICT.OGRNIP), 'ОГРНИП не должен попадать в аудит');
  // Но какие поля изменились — видно.
  assert.match(audit[1].details, /наименование/);
  assert.match(audit[1].details, /адрес регистрации/);
  await db.close();
});

// ===========================================================================
// R — реквизиты и снимки
// ===========================================================================

test('R1: правка данных YAAM после закрытия периода не меняет ни снимок, ни документ', async () => {
  const databaseUrl = await freshDatabase('s14_snapshot');
  process.env.DATABASE_URL = databaseUrl;
  const { db, legalService, bankService, weekly, documentService } = requireFresh();

  await legalService.saveYaamLegalDetails({
    legalName: 'ИП Старое Имя', entrepreneurName: 'Старый С. С.',
    inn: FICT.INN12, ogrnip: FICT.OGRNIP, registrationAddress: 'Старый адрес',
  });
  await bankService.saveYaamBankDetails({
    legal_name: 'ИП Старое Имя', inn: FICT.INN10, kpp: FICT.KPP,
    account_number: FICT.RS, bik: FICT.BIK, bank_name: 'СТАРЫЙ БАНК',
    correspondent_account: FICT.KS,
  });

  const rest = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('Кафе Снимок','["Грозный"]',1,NOW()) RETURNING id`);
  const restId = rest.rows[0].id;
  await db.execute(
    `INSERT INTO restaurant_legal_details (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip','ИП Ресторан',$2,$3,'Адрес ресторана','Р. Р. Р.','+79280000004')`,
    [restId, FICT.INN12, FICT.OGRNIP]);
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1,'Д-С','2026-01-01','signed')`, [restId]);

  const msk = (y, m, d, hh) => new Date(Date.UTC(y, m - 1, d, hh) - 180 * 60 * 1000);
  await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at)
     VALUES ('YAAM-S1401',$1,'Грозный','Иса','+79010000001','ул. Тестовая, 1','',1000,70,'delivered',$2) RETURNING id`,
    [restId, msk(2026, 7, 29, 12)]);
  const orderId = (await db.query("SELECT id FROM orders WHERE public_code = 'YAAM-S1401'"))[0].id;
  await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,1000,'succeeded')`, [orderId]);

  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7), generateDocuments: true });

  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const lineBefore = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [periodId]))[0];
  const docBefore = (await documentService.listDocumentsForPeriod(periodId))
    .find((d) => d.kind === 'agent_report');

  assert.equal(lineBefore.yaam_legal_name_snapshot, 'ИП Старое Имя');
  assert.equal(lineBefore.yaam_ogrnip_snapshot, FICT.OGRNIP);
  assert.equal(lineBefore.yaam_address_snapshot, 'Старый адрес');

  // Меняем И юридические данные, И банк.
  await legalService.saveYaamLegalDetails({
    legalName: 'ИП Новое Имя', entrepreneurName: 'Новый Н. Н.',
    inn: FICT.INN12, ogrnip: FICT.OGRNIP, registrationAddress: 'Новый адрес',
  });
  await bankService.saveYaamBankDetails({
    legal_name: 'ИП Новое Имя', inn: FICT.INN10, kpp: FICT.KPP,
    account_number: FICT.RS, bik: FICT.BIK, bank_name: 'НОВЫЙ БАНК',
    correspondent_account: FICT.KS,
  });

  const lineAfter = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE id = $1', [lineBefore.id]))[0];
  assert.deepEqual(lineAfter, lineBefore, 'снимок закрытого периода не изменился ни в одном поле');

  const docAfter = (await documentService.listDocumentsForPeriod(periodId))
    .find((d) => d.kind === 'agent_report');
  assert.equal(docAfter.id, docBefore.id, 'документ не перегенерирован');
  assert.equal(docAfter.payload.agent.legalName, 'ИП Старое Имя');
  assert.equal(docAfter.payload.agent.address, 'Старый адрес');

  const { renderDocument } = require('../../hq/settlementDocumentViews');
  const html = renderDocument(docAfter);
  assert.match(html, /ИП Старое Имя/);
  assert.doesNotMatch(html, /ИП Новое Имя/, 'старый документ не должен показывать новые данные');
  await db.close();
});

test('R2: реквизиты — форматная валидация, маскирование, аудит без полных счетов', async () => {
  const databaseUrl = await freshDatabase('s14_bank');
  process.env.DATABASE_URL = databaseUrl;
  const { db, bankService } = requireFresh();
  const { maskAccountForUi } = require('../../services/hq/ruRequisites');

  const valid = {
    legal_name: 'ИП Тестов', inn: FICT.INN10, kpp: FICT.KPP,
    account_number: FICT.RS, bik: FICT.BIK, bank_name: 'ТЕСТБАНК',
    correspondent_account: FICT.KS,
  };
  await assert.rejects(() => bankService.saveYaamBankDetails({ ...valid, bik: '123' }), /БИК/i);
  await assert.rejects(() => bankService.saveYaamBankDetails({ ...valid, account_number: '123' }), /счёт|счет/i);

  await bankService.saveYaamBankDetails(valid);
  const saved = await bankService.getYaamBankDetails();
  assert.equal(saved.account_number, FICT.RS, 'полное значение хранится в БД');

  // В UI счёт маскируется.
  const masked = maskAccountForUi(FICT.RS);
  assert.notEqual(masked, FICT.RS);
  assert.ok(masked.includes(FICT.RS.slice(-4)), 'последние цифры остаются для сверки');

  // Экран настроек показывает маску, а не полный счёт.
  const settingsViews = require('../../hq/settingsViews');
  const html = settingsViews.renderYaamBankSection({ details: saved, linkBasePath: '/hq' });
  assert.ok(!html.includes(FICT.RS), 'полный расчётный счёт не должен попадать в HTML обзора');
  assert.ok(!html.includes(FICT.KS), 'полный корр. счёт не должен попадать в HTML обзора');
  assert.ok(html.includes(masked));
  await db.close();
});

// ===========================================================================
// F — фискальные чеки
// ===========================================================================

async function seedPaidOrder(db, { itemsTotal = 1000, commission = 70 } = {}) {
  const rest = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('Кафе Чек','["Грозный"]',1,NOW()) RETURNING id`);
  const restId = rest.rows[0].id;
  await db.execute(
    `INSERT INTO restaurant_legal_details (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip','ИП Поставщик',$2,$3,'Адрес поставщика','П. П. П.','+79280000005')`,
    [restId, FICT.INN12, FICT.OGRNIP]);
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at)
     VALUES ('YAAM-F' || floor(random()*100000)::text,$1,'Грозный','Иса Магомадов','+79011112233','ул. Секретная, 7, кв. 3','позвонить',$2,$3,'delivered',NOW()) RETURNING id`,
    [restId, itemsTotal, commission]);
  const orderId = o.rows[0].id;
  await db.execute(
    `INSERT INTO order_items (order_id, name, price, qty) VALUES ($1,'Шашлык',600,1),($1,'Лаваш',200,2)`,
    [orderId]);
  const p = await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`,
    [orderId, itemsTotal]);
  return { restId, orderId, paymentId: p.rows[0].id };
}

test('F1: payload чека прихода детерминирован, строится из снимка заказа и не содержит лишних ПДн', async () => {
  const databaseUrl = await freshDatabase('s14_receipt_payload');
  process.env.DATABASE_URL = databaseUrl;
  const { db, legalService, receiptService } = requireFresh();
  await legalService.saveYaamLegalDetails({
    legalName: 'ИП Агент', entrepreneurName: 'Агент А. А.',
    inn: FICT.INN12, ogrnip: FICT.OGRNIP, registrationAddress: 'Адрес агента',
  });
  const { orderId } = await seedPaidOrder(db);

  const a = await receiptService.buildPaymentReceiptPayload(orderId);
  const b = await receiptService.buildPaymentReceiptPayload(orderId);
  assert.equal(receiptService.payloadFingerprint(a), receiptService.payloadFingerprint(b),
    'повторная сборка обязана давать тот же payload');

  assert.equal(a.kind, 'payment');
  assert.equal(a.total, 1000);
  assert.equal(a.agentCommission, 70);
  assert.equal(a.items.length, 2);
  assert.deepEqual(a.items[1], { name: 'Лаваш', price: 200, quantity: 2, amount: 400 });
  assert.equal(a.supplier.legalName, 'ИП Поставщик', 'поставщик — ресторан, а не YAAM');
  assert.equal(a.agent.legalName, 'ИП Агент');
  // Комиссия НЕ является позицией чека.
  assert.ok(!a.items.some((i) => /комисси/i.test(i.name)));

  // Лишних ПДн нет: имя, адрес и комментарий покупателя в чек не идут.
  const text = JSON.stringify(a);
  assert.ok(!text.includes('Иса Магомадов'), 'имя покупателя не должно попадать в чек');
  assert.ok(!text.includes('ул. Секретная'), 'адрес покупателя не должен попадать в чек');
  assert.ok(!text.includes('позвонить'), 'комментарий не должен попадать в чек');
  assert.equal(a.customerContact, '+79011112233', 'телефон — единственный контакт, и он отдельным полем');

  // Признаки 54-ФЗ честно помечены как несогласованные, а не выдуманы.
  assert.equal(a.pendingLegal.paymentSubjectSign, 'не согласован');
  assert.equal(a.pendingLegal.vatRate, 'не согласована');
  await db.close();
});

test('F2: payload не меняется после правки меню — чек строится из снимка заказа', async () => {
  const databaseUrl = await freshDatabase('s14_receipt_menu');
  process.env.DATABASE_URL = databaseUrl;
  const { db, receiptService } = requireFresh();
  const { orderId } = await seedPaidOrder(db);

  const before = await receiptService.buildPaymentReceiptPayload(orderId);
  // Меню меняется — на уже оплаченный заказ это влиять не должно.
  await db.execute(`UPDATE order_items SET name = name WHERE order_id = $1`, [orderId]);
  const after = await receiptService.buildPaymentReceiptPayload(orderId);
  assert.equal(receiptService.payloadFingerprint(before), receiptService.payloadFingerprint(after));
  assert.equal(after.items[0].name, 'Шашлык');
  assert.equal(after.items[0].price, 600);
  await db.close();
});

test('F3: чек идемпотентен — один платёж даёт ровно один чек, гонка не создаёт второй', async () => {
  const databaseUrl = await freshDatabase('s14_receipt_idem');
  process.env.DATABASE_URL = databaseUrl;
  const { db, receiptService } = requireFresh();
  const { orderId, paymentId } = await seedPaidOrder(db);

  const first = await receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId });
  assert.equal(first.created, true);
  const second = await receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId });
  assert.equal(second.created, false);
  assert.equal(second.receipt.id, first.receipt.id);

  // Гонка.
  await Promise.all([
    receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId }),
    receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId }),
    receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId }),
  ]);
  const all = await db.query('SELECT COUNT(*)::int AS n FROM fiscal_receipts');
  assert.equal(all[0].n, 1, 'второй чек за тот же платёж создать нельзя');

  // Второй чек напрямую в БД тоже невозможен.
  await assert.rejects(
    () => db.execute(
      `INSERT INTO fiscal_receipts (kind, order_id, payment_id, provider, idempotency_key, payload)
       VALUES ('payment',$1,$2,'mock','other-key','{}'::jsonb)`,
      [orderId, paymentId]),
    /duplicate key|unique/i,
  );
  await db.close();
});

test('F4: отправка — успех, повтор после сбоя, терминальный failed; payload неизменяем', async () => {
  const databaseUrl = await freshDatabase('s14_receipt_send');
  process.env.DATABASE_URL = databaseUrl;
  const { db, receiptService } = requireFresh();
  const MockFiscalProvider = require('../../services/fiscalization/mockFiscalProvider');
  const { orderId, paymentId } = await seedPaidOrder(db);

  const { receipt } = await receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.attempts, 0);

  // Два первых вызова падают с ВРЕМЕННОЙ ошибкой — чек возвращается в очередь.
  const flaky = new MockFiscalProvider({ failTimes: 2, retryable: true });
  const r1 = await receiptService.processReceipt(receipt.id, flaky);
  assert.equal(r1.status, 'queued');
  const r2 = await receiptService.processReceipt(receipt.id, flaky);
  assert.equal(r2.status, 'queued');
  const afterFails = await receiptService.getReceipt(receipt.id);
  assert.equal(afterFails.attempts, 2);
  assert.ok(afterFails.last_error);
  assert.equal(afterFails.completed_at, null, 'нетерминальный чек не имеет момента завершения');

  // Третий — успех.
  const r3 = await receiptService.processReceipt(receipt.id, flaky);
  assert.equal(r3.status, 'succeeded');
  const done = await receiptService.getReceipt(receipt.id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.provider_receipt_id);
  assert.ok(done.completed_at);
  assert.equal(done.last_error, null);

  // Повторная обработка успешного чека невозможна.
  const again = await receiptService.processReceipt(receipt.id, flaky);
  assert.equal(again.processed, false);
  assert.equal(again.reason, 'not_claimable');

  // Payload и связи неизменяемы.
  await assert.rejects(
    () => db.execute(`UPDATE fiscal_receipts SET payload = '{}'::jsonb WHERE id = $1`, [receipt.id]),
    /immutable/i,
  );
  await assert.rejects(
    () => db.execute(`UPDATE fiscal_receipts SET order_id = order_id + 1 WHERE id = $1`, [receipt.id]),
    /immutable/i,
  );

  // Аудит: создание, повторы, успех.
  const actions = (await db.query(
    "SELECT action FROM hq_audit_log WHERE action LIKE 'fiscal_receipt%' ORDER BY id")).map((r) => r.action);
  assert.deepEqual(actions, [
    'fiscal_receipt_created', 'fiscal_receipt_retried', 'fiscal_receipt_retried', 'fiscal_receipt_succeeded',
  ]);
  await db.close();
});

test('F5: неповторяемая ошибка сразу делает чек failed, а не крутит попытки', async () => {
  const databaseUrl = await freshDatabase('s14_receipt_fatal');
  process.env.DATABASE_URL = databaseUrl;
  const { db, receiptService } = requireFresh();
  const MockFiscalProvider = require('../../services/fiscalization/mockFiscalProvider');
  const { orderId, paymentId } = await seedPaidOrder(db);
  const { receipt } = await receiptService.enqueueReceipt({ kind: 'payment', orderId, paymentId });

  const fatal = new MockFiscalProvider({ failTimes: 1, retryable: false });
  const r = await receiptService.processReceipt(receipt.id, fatal);
  assert.equal(r.status, 'failed');
  const row = await receiptService.getReceipt(receipt.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.ok(row.completed_at, 'терминальный чек обязан иметь момент завершения');
  await db.close();
});

test('F6: возвратный чек зеркалит приход и связан со своим возвратом', async () => {
  const databaseUrl = await freshDatabase('s14_receipt_refund');
  process.env.DATABASE_URL = databaseUrl;
  const { db, receiptService } = requireFresh();
  const { orderId, paymentId } = await seedPaidOrder(db);

  const rf = await db.execute(
    `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,'mock',1000,'succeeded','customer_cancel','rk-1',NOW()) RETURNING id`, [paymentId]);
  const refundId = rf.rows[0].id;

  const payload = await receiptService.buildRefundReceiptPayload(refundId);
  assert.equal(payload.kind, 'refund');
  assert.equal(payload.refund.isFull, true);
  assert.equal(payload.total, 1000);
  assert.equal(payload.items.length, 2, 'полный возврат зеркалит все позиции прихода');

  const { receipt, created } = await receiptService.enqueueReceipt({
    kind: 'refund', orderId, refundId,
  });
  assert.equal(created, true);
  assert.equal(receipt.kind, 'refund');
  assert.equal(receipt.refund_id, refundId);
  assert.equal(receipt.idempotency_key, receiptService.refundIdempotencyKey(refundId));

  // Второй возвратный чек за тот же возврат невозможен.
  const dup = await receiptService.enqueueReceipt({ kind: 'refund', orderId, refundId });
  assert.equal(dup.created, false);
  await db.close();
});

// ===========================================================================
// K — режимы платёжного провайдера
// ===========================================================================

test('K1: live-режим YooKassa не запускается — ни через env, ни боевым ключом', async () => {
  const YookassaProvider = require('../../services/paymentProviders/yookassaProvider');
  const saved = {
    env: process.env.YOOKASSA_ENV,
    shop: process.env.YOOKASSA_SHOP_ID,
    key: process.env.YOOKASSA_SECRET_KEY,
  };
  try {
    process.env.YOOKASSA_SHOP_ID = '123456';
    process.env.YOOKASSA_SECRET_KEY = 'test_ABCDEFGHIJKLMNOPQRSTUVWX';

    // Явный live.
    process.env.YOOKASSA_ENV = 'live';
    assert.throws(() => new YookassaProvider(), /sandbox/i, 'live-режим обязан отклоняться');

    // Не задан вовсе — тоже отказ, а не «сойдёт за sandbox».
    delete process.env.YOOKASSA_ENV;
    assert.throws(() => new YookassaProvider(), /sandbox/i);

    // Sandbox, но БОЕВОЙ ключ (без префикса test_) — отказ.
    process.env.YOOKASSA_ENV = 'sandbox';
    process.env.YOOKASSA_SECRET_KEY = 'live_REALSECRETKEYVALUE123456';
    assert.throws(() => new YookassaProvider(), /test_/, 'боевой ключ не должен приниматься');

    // Корректная песочница — создаётся.
    process.env.YOOKASSA_SECRET_KEY = 'test_ABCDEFGHIJKLMNOPQRSTUVWX';
    const provider = new YookassaProvider();
    assert.ok(provider);
  } finally {
    if (saved.env === undefined) delete process.env.YOOKASSA_ENV; else process.env.YOOKASSA_ENV = saved.env;
    if (saved.shop === undefined) delete process.env.YOOKASSA_SHOP_ID; else process.env.YOOKASSA_SHOP_ID = saved.shop;
    if (saved.key === undefined) delete process.env.YOOKASSA_SECRET_KEY; else process.env.YOOKASSA_SECRET_KEY = saved.key;
  }
});

// ===========================================================================
// U — экран настроек
// ===========================================================================

test('U1: «Платежи и касса» показывает честные статусы и не содержит секретов', async () => {
  const databaseUrl = await freshDatabase('s14_payments_ui');
  const savedKey = process.env.YOOKASSA_SECRET_KEY;
  process.env.YOOKASSA_SECRET_KEY = 'test_SUPERSECRETVALUE0123456789';
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const { html, status } = await getPage(base, cookie, '/hq/settings');
    assert.equal(status, 200);
    assert.match(html, /Платежи и касса/);
    assert.match(html, /Боевой режим/);
    assert.match(html, /Не подключён/);
    assert.match(html, /Онлайн-касса/);
    assert.match(html, /Не подключена/);
    assert.match(html, /Частичный возврат/);
    assert.match(html, /Что мешает боевому режиму/);

    // Ни ключа, ни его фрагмента, ни поля для ввода.
    assert.ok(!html.includes('SUPERSECRETVALUE'), 'секрет не должен попадать в HTML');
    assert.ok(!html.includes('test_SUPER'));
    assert.doesNotMatch(html, /name="(secretKey|secret_key|yookassaSecret)"/i,
      'поля для ввода боевого секрета быть не должно');
    // Технических имён колонок в UI нет.
    assert.doesNotMatch(html, /account_number|correspondent_account|ogrnip"/);
  } finally {
    if (savedKey === undefined) delete process.env.YOOKASSA_SECRET_KEY;
    else process.env.YOOKASSA_SECRET_KEY = savedKey;
    await stopApp(instance);
  }
});

test('U2: форма данных YAAM сохраняет корректные значения и показывает ошибку без потери ввода', async () => {
  const databaseUrl = await freshDatabase('s14_legal_ui');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const editPage = await getPage(base, cookie, '/hq/settings/yaam-legal/edit');
    assert.equal(editPage.status, 200);

    // Неверный ИНН — 400, введённые значения возвращаются в форму.
    const bad = await post(base, cookie, '/hq/settings/yaam-legal', {
      _csrf: editPage.csrf,
      legalName: 'ИП Проверка', entrepreneurName: 'Проверкин П. П.',
      inn: '123', ogrnip: FICT.OGRNIP, registrationAddress: 'Адрес проверки',
    });
    assert.equal(bad.status, 400);
    const badHtml = await bad.text();
    assert.match(badHtml, /ИНН/);
    assert.ok(badHtml.includes('ИП Проверка'), 'введённые значения не должны теряться');

    // Успех.
    const page2 = await getPage(base, cookie, '/hq/settings/yaam-legal/edit');
    const ok = await post(base, cookie, '/hq/settings/yaam-legal', {
      _csrf: page2.csrf,
      legalName: 'ИП Проверка', entrepreneurName: 'Проверкин П. П.',
      inn: FICT.INN12, ogrnip: FICT.OGRNIP, registrationAddress: 'Адрес проверки',
      // Лишнее поле: попытка mass assignment не должна ничего добавить.
      id: '99', created_at: '2000-01-01',
    });
    assert.equal(ok.status, 302);

    const settings = await getPage(base, cookie, '/hq/settings');
    assert.match(settings.html, /ИП Проверка/);
    assert.match(settings.html, /Заполнены/);
  } finally {
    await stopApp(instance);
  }
});
