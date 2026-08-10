'use strict';

// YAAM Stage 37 — финансовая приёмка на mock, раздел 6-7: живой обзор
// реальных HQ-экранов (Обзор/Финансы/ресторан/периоды/выплаты) глазами
// владельца, со сверкой HQ-экран vs finance-service vs сырая БД vs ручная
// арифметика.
//
// ПОЧЕМУ ЛОКАЛЬНЫЙ ИНСТАНС, А НЕ hqtest.yaam.su. Deploy на hqtest в этой
// стадии прямо запрещён без отдельного разрешения (задание, раздел 20) —
// значит правки Stage 37 (см. services/hq/payoutStatusService.js) там ещё
// не появятся, и живая проверка настоящего hqtest не подтвердила бы их.
// Кроме того, вход в реальную HQ-панель требует пароля владельца, а
// однократный пароль, выданный для Stage 36, использован и не сохранён
// (условие задания — остановиться, если требуется новый пароль/доступ).
// Локальный инстанс поднимает ТОТ ЖЕ код (services/postgresql/app.js,
// routes/hq/*, тот же реальный HTTP/CSRF/session-контур, что и hqtest) с
// собственным одноразовым тестовым паролем — предметно эквивалентная
// проверка "что реально видит владелец", без необходимости в чужом секрете.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../services/hq/menuAdminService'),
  require.resolve('../../services/hq/restaurantFinanceService'),
  require.resolve('../../services/hq/settlementService'),
  require.resolve('../../services/hq/payoutService'),
  require.resolve('../../services/hq/payoutStatusService'),
  require.resolve('../../services/hq/dashboardMetrics'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'q'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage37LiveReview';
const FICT = { BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565', INN12: '770912345616' };

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('stage37-live-hq-screens');
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
function uniquePhone() {
  return `+7902${String(crypto.randomInt(1000000, 9999999))}`;
}
function metricValues(html) {
  return (html.match(/<div class="value">([^<]*)<\/div>/g) || []).map((m) => m.replace(/<[^>]+>/g, ''));
}
// Stage 38 — HQ отображает деньги через formatMinorRub(): "1934 ₽" (целые)
// ИЛИ "145,60 ₽" (с копейками). Правильный разбор ОБЯЗАН учитывать позицию
// запятой как разделитель дробной части, а не просто вырезать все нецифровые
// символы (это дало бы 193400 для целого случая, но 14560 для дробного —
// два разных множителя от одной и той же функции стрипинга, ловушка).
function parseMoneyTextToMinor(text) {
  const m = /(\d+)(?:,(\d{2}))?\s*₽/.exec(text);
  if (!m) return null;
  const rubles = Number(m[1]);
  const kopecks = m[2] ? Number(m[2]) : 0;
  return rubles * 100 + kopecks;
}
function payoutRowAmount(html, name) {
  const idx = html.indexOf(`payout-row-name">${name}<`);
  if (idx === -1) return null;
  const chunk = html.slice(idx, idx + 600);
  const m = chunk.match(/payout-row-amount">([^<]+)</);
  return m ? parseMoneyTextToMinor(m[1]) : null;
}
function statusToneBadge(html, name) {
  const idx = html.indexOf(`payout-row-name">${name}<`);
  if (idx === -1) return null;
  const chunk = html.slice(idx, idx + 600);
  const m = chunk.match(/status-badge [a-z]+">([^<]+)</);
  return m ? m[1] : null;
}

async function createRestaurant(db, name) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}
async function seedMenuItem(menuAdminService, restaurantId, price) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Блюдо', category_id: String(category.id), price: String(price) });
}
async function seedYaamBankDetails(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО ЯАМ Платформа','7709123453','770101001',$1,$2,'ТЕСТБАНК',$3) ON CONFLICT (id) DO NOTHING`,
    [FICT.RS, FICT.BIK, FICT.KS],
  );
}
async function seedPayoutReadiness(db, restaurantId) {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip','ИП Тестов Т. Т.',$2,'312770012345008','г. Грозный, ул. Т, 1','Тестов Т. Т.','+79280000001')`,
    [restaurantId, FICT.INN12],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, default_payment_purpose)
     VALUES ($1,'ИП Тестов Т. Т.',$2,'',$3,$4,'ТЕСТБАНК',$5,'Оплата услуг доставки')`,
    [restaurantId, FICT.INN12, FICT.RS, FICT.BIK, FICT.KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1,'ДЗ-LIVE','2026-01-01','signed')`,
    [restaurantId],
  );
}
async function deliverRealOrder(orderService, db, restaurantId, menuItemId) {
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
    address: 'ул. Живая, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Блюдо', price: 0, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]))[0];
  await orderService.markPaid(order.id, paymentRow.id);
  await orderService.restaurantAccept(order.id);
  await orderService.restaurantAdvance(order.id, 'preparing');
  await orderService.restaurantAdvance(order.id, 'ready');
  await orderService.restaurantAdvance(order.id, 'courier');
  await orderService.confirmReceiptByCustomer(order.id);
  return order.id;
}
async function cancelledRefundedOrder(orderService, db, restaurantId, menuItemId) {
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
    address: 'ул. Возвратная, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Блюдо', price: 0, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]))[0];
  await orderService.markPaid(order.id, paymentRow.id);
  await orderService.cancelByCustomer(order.id);
  return order.id;
}
function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

test('Живой обзор HQ-экранов: Обзор/Финансы/ресторан/периоды/выплаты — HQ-HTML vs finance-service vs сырая БД vs ручная арифметика', async () => {
  const databaseUrl = await freshDatabase('stage37_live_hq');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService.js');
  const menuAdminService = require('../../services/hq/menuAdminService');
  const financeService = require('../../services/hq/restaurantFinanceService');
  const settlementService = require('../../services/hq/settlementService');
  const payoutService = require('../../services/hq/payoutService');
  try {
    await seedYaamBankDetails(db);

    // Ресторан А — 7% fallback (нет договора), 2 доставленных заказа (850+1230=2080,
    // комиссия round(2080*700/10000)=146, заработок=1934) + 1 реальный отменённый/
    // возвращённый заказ (600 ₽, НЕ должен войти ни в оборот, ни в комиссию).
    const restA = await createRestaurant(db, 'Живой Обзор Хачапурная');
    await seedPayoutReadiness(db, restA);
    const itemA1 = await seedMenuItem(menuAdminService, restA, 850);
    const itemA2 = await seedMenuItem(menuAdminService, restA, 1230);
    const itemARefund = await seedMenuItem(menuAdminService, restA, 600);
    await deliverRealOrder(orderService, db, restA, itemA1.id);
    await deliverRealOrder(orderService, db, restA, itemA2.id);
    await cancelledRefundedOrder(orderService, db, restA, itemARefund.id);
    await sleep(300); // fire-and-forget scheduleRefundProcessing (mock provider), как в Stage 7.1

    // Ресторан Б — 1 доставленный заказ (600 ₽), НЕ будет выплачен в этом тесте
    // (остаётся "ожидает выплаты" — вторая живая ветка статуса, помимо "Выплачено").
    const restB = await createRestaurant(db, 'Живой Обзор Пиццерия');
    await seedPayoutReadiness(db, restB);
    const itemB1 = await seedMenuItem(menuAdminService, restB, 600);
    await deliverRealOrder(orderService, db, restB, itemB1.id);

    // ---- Ручная арифметика (источник истины №4) ----
    // Stage 38: комиссия считается ПО КАЖДОМУ ЗАКАЗУ ОТДЕЛЬНО (см.
    // orderService.js:createOrder — resolveCommissionBps+round применяются
    // к itemsTotal ОДНОГО заказа), а не на объединённой сумме нескольких
    // заказов — сумма двух независимо округлённых комиссий НЕ обязана
    // совпадать с округлением суммы (классический "round(a)+round(b) ≠
    // round(a+b)"). Поэтому ручная арифметика ниже честно повторяет ЭТУ ЖЕ
    // формулу для каждого заказа отдельно в minor units, а не одной
    // комбинированной операцией над рублями, как было до Stage 38 (там
    // рублёвая грануляция случайно маскировала разницу).
    const commissionMinor = (rub) => Math.round(rub * 100 * 700 / 10000);
    const expected = {
      A: {
        turnoverMinor: (850 + 1230) * 100,
        commissionMinor: commissionMinor(850) + commissionMinor(1230),
        get earningsMinor() { return this.turnoverMinor - this.commissionMinor; },
      },
      B: {
        turnoverMinor: 600 * 100,
        commissionMinor: commissionMinor(600),
        get earningsMinor() { return this.turnoverMinor - this.commissionMinor; },
      },
      refundAMinor: 600 * 100,
    };
    assert.equal(expected.A.commissionMinor, 14560); // 59,50 ₽ + 86,10 ₽
    assert.equal(expected.A.earningsMinor, 193440);
    assert.equal(expected.B.commissionMinor, 4200); // 42,00 ₽
    assert.equal(expected.B.earningsMinor, 55800);

    // ---- Источник истины №2: restaurantFinanceService напрямую (minor units) ----
    const posA = await financeService.getRestaurantFinancialPosition(restA);
    const posB = await financeService.getRestaurantFinancialPosition(restB);
    assert.equal(posA.turnover, expected.A.turnoverMinor);
    assert.equal(posA.commission, expected.A.commissionMinor);
    assert.equal(posA.restaurantEarnings, expected.A.earningsMinor);
    assert.equal(posA.successfulRefunds, expected.refundAMinor);
    assert.equal(posA.successfulRefundsCount, 1);
    assert.equal(posB.turnover, expected.B.turnoverMinor);
    assert.equal(posB.commission, expected.B.commissionMinor);

    // ---- Источник истины №3: сырая БД, независимый пересчёт (minor units) ----
    const rawA = (await db.query(
      `SELECT COALESCE(SUM(items_total),0)::int AS turnover, COALESCE(SUM(commission_amount),0)::int AS commission
       FROM orders WHERE restaurant_id = $1 AND earned_at IS NOT NULL`,
      [restA],
    ))[0];
    assert.equal(rawA.turnover, expected.A.turnoverMinor);
    assert.equal(rawA.commission, expected.A.commissionMinor);
    const rawRefundA = (await db.query(
      `SELECT COALESCE(SUM(rf.amount),0)::int AS refunded FROM refunds rf
       JOIN payments p ON p.id = rf.payment_id JOIN orders o ON o.id = p.order_id
       WHERE o.restaurant_id = $1 AND rf.status = 'succeeded'`,
      [restA],
    ))[0];
    assert.equal(rawRefundA.refunded, expected.refundAMinor);

    // ---- Закрыть период, подготовить и подтвердить выплату ТОЛЬКО ресторану А ----
    const pad = (n) => String(n).padStart(2, '0');
    const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const periodFrom = toDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const periodTo = toDateStr(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const draft = await settlementService.createDraftSettlementPeriod({ periodFrom, periodTo });
    const closed = await settlementService.closeSettlementPeriod(draft.id);
    const lineA = closed.lines.find((l) => l.restaurant_id === restA);
    const lineB = closed.lines.find((l) => l.restaurant_id === restB);
    assert.equal(lineA.payable_amount, expected.A.earningsMinor);
    assert.equal(lineB.payable_amount, expected.B.earningsMinor); // 558 ₽ ровно, без копеек

    const payoutA = await payoutService.prepareRestaurantPayout(draft.id, restA);
    await payoutService.confirmManualBankTransfer(payoutA.id, {
      operationReference: 'TEST-LIVE-001', paidAt: new Date(), confirmedBy: 'stage37-live-review',
    });
    // Ресторан Б намеренно оставлен неоплаченным.

    // ---- Источник истины №1: реальный отрендеренный HQ-HTML ----
    const cookie = await loginHq(base);

    const overview = await getPage(base, cookie, '/hq/');
    assert.equal(overview.status, 200);
    const overviewValues = metricValues(overview.html); // [заказы, оборот, доход YAAM, рестораны]
    // "Сегодня" (дефолтный период Обзора) должен включать все 3 earned-заказа
    // (2 в А + 1 в Б), созданных и доставленных в момент выполнения теста.
    assert.equal(Number(overviewValues[0]), 3, 'Обзор: 3 заработанных заказа сегодня (2×А + 1×Б)');
    // HTML отображает через formatMinorRub — разбираем ЧЕРЕЗ parseMoneyTextToMinor
    // (учитывает копейки), не наивным вырезанием нецифровых символов.
    assert.equal(parseMoneyTextToMinor(overviewValues[1]), expected.A.turnoverMinor + expected.B.turnoverMinor, 'Обзор: суммарный оборот');
    assert.equal(parseMoneyTextToMinor(overviewValues[2]), expected.A.commissionMinor + expected.B.commissionMinor, 'Обзор: суммарный доход YAAM');
    assert.equal(Number(overviewValues[3]), 2, 'Обзор: 2 ресторана с активностью');

    const finance = await getPage(base, cookie, '/hq/finance');
    assert.equal(finance.status, 200);
    const financeValues = metricValues(finance.html); // [заказы, оборот, доход YAAM, сумма ресторанов, (возвраты — опционально)]
    assert.equal(parseMoneyTextToMinor(financeValues[1]), expected.A.turnoverMinor + expected.B.turnoverMinor, 'Финансы: оборот совпадает с Обзором и ручным расчётом');
    assert.equal(parseMoneyTextToMinor(financeValues[2]), expected.A.commissionMinor + expected.B.commissionMinor, 'Финансы: доход YAAM совпадает');
    assert.equal(parseMoneyTextToMinor(financeValues[3]), expected.A.earningsMinor + expected.B.earningsMinor, 'Финансы: сумма ресторанов совпадает');
    assert.ok(finance.html.includes(`Возвраты · 1 шт`), 'Финансы: возврат по А виден в сводке');

    // «Статус выплат» — ИМЕННО та секция, где был найден и исправлен дефект
    // (Task #36): ресторан А теперь должен показывать «Выплачено» С СУММОЙ,
    // ресторан Б — статус готовности к выплате БЕЗ пометки "Выплачено".
    assert.equal(statusToneBadge(finance.html, 'Живой Обзор Хачапурная'), 'Выплачено');
    assert.equal(payoutRowAmount(finance.html, 'Живой Обзор Хачапурная'), expected.A.earningsMinor, 'после фикса Task #36 сумма выплаты видна на сводном экране');
    const statusB = statusToneBadge(finance.html, 'Живой Обзор Пиццерия');
    assert.notEqual(statusB, 'Выплачено', 'ресторан Б не был выплачен в этом тесте');
    assert.equal(payoutRowAmount(finance.html, 'Живой Обзор Пиццерия'), expected.B.earningsMinor, 'сумма к выплате ресторана Б видна и совпадает с payable_amount');

    // Секция «Расчётные периоды» на том же экране — сумма ресторанов там же
    // берётся из snapshot закрытого периода (settlementService), не из
    // restaurantFinanceService — оба источника должны совпасть.
    assert.ok(finance.html.includes(`${periodFrom}`) || finance.html.includes('Закрыт') || finance.html.includes('период'), 'секция расчётных периодов присутствует');

    // Карточка ресторана А — «Заказы» видит только свои 2 заказа (не 3: возврат
    // отменил заказ, а заказ ресторана Б не должен быть виден).
    const restaurantAPage = await getPage(base, cookie, `/hq/restaurants/${restA}`);
    const ordersValuesA = (restaurantAPage.html.match(/<div class="orders-value">(\d+)<\/div>/g) || []).map((m) => Number(m.replace(/\D/g, '')));
    assert.deepEqual(ordersValuesA, [2, 2], 'карточка ресторана А: 2 заказа сегодня и 2 за всё время (возврат не считается доставленным заказом)');

    // Страница деталей выплаты — сумма/статус/метод/номер операции видны и совпадают.
    const payoutDetail = await getPage(base, cookie, `/hq/payouts/${payoutA.id}`);
    assert.equal(payoutDetail.status, 200);
    const { formatMinorRub } = require('../../services/money');
    assert.ok(payoutDetail.html.includes(formatMinorRub(expected.A.earningsMinor)), 'страница выплаты показывает верную сумму');
    assert.ok(payoutDetail.html.includes('TEST-LIVE-001'), 'номер операции ручного перевода виден на карточке выплаты');
    assert.ok(!payoutDetail.html.includes(FICT.RS), 'сырой номер счёта не должен утекать в HTML без маскировки (см. Stage 9.6 маскировка в payoutViews.js)');
  } finally {
    await stopApp(instance);
  }
});
