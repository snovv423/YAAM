'use strict';

// YAAM HQ — раздел «Рестораны» переработан согласно docs/HQ-PRODUCT-SPEC.md.
// Интеграционные тесты против настоящего embedded PostgreSQL, тот же
// harness-паттерн, что и остальные Stage-файлы этой директории.
//
// A — список ресторанов: без поиска/фильтров/сортировки, корректная карточка,
//     без Telegram/выплат/юридических данных.
// B — обзор ресторана: заказы сегодня/за всё время, оборот, доход YAAM.
// C — блок «Выплаты»: состояния и невозможность выплаты при блокерах.
// D — меню: категория, блюдо внутри категории, наличие, архив, восстановление,
//     перенос блюд при архивации категории, порядок перетаскиванием.
// E — заказы: только фильтр по датам, полная карточка заказа.
// F — оценки и статистика: без технического пояснения и без дублирующей
//     финансовой сводки.
// G — настройки: города чипами, лимит 3 фотографий, Telegram, управление.
// H — Telegram-привязка: одноразовый код, один чат — один ресторан.
// I — пауза ресторана: события начала и завершения в «Центре событий».
// J — таймер приготовления: серверный дедлайн, обнуление при передаче курьеру.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
  require.resolve('../../services/hq/menuAdminService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/restaurantPayoutStateService.js'),
  require.resolve('../../services/hq/telegramLinkService.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../services/hq/eventLogService.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'r'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage11Rest';

const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_INN10 = '7709123453';
const FICTITIOUS_KPP = '770101001';
// ОГРНИП с валидной контрольной суммой — тот же, что в hqRestaurantLegalBankStage6.
const FICTITIOUS_OGRNIP = '312770012345008';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-restaurants-stage11');
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
    svc: require('../../services/hq/restaurantAdminService'),
    menuSvc: require('../../services/hq/menuAdminService'),
    orderService: require('../../services/postgresql/orderService'),
    statsService: require('../../services/hq/restaurantStatsService'),
    payoutStateService: require('../../services/hq/restaurantPayoutStateService'),
    telegramLinkService: require('../../services/hq/telegramLinkService'),
    settlementService: require('../../services/hq/settlementService'),
    payoutService: require('../../services/hq/payoutService'),
    eventLogService: require('../../services/hq/eventLogService'),
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

// --- Фикстуры (прямой SQL — точнее контролирует статусы/даты) ---
async function createRestaurant(db, name, { cities = ['Грозный'], published = true, isOpen = 1 } = {}) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, cuisine, is_open, published_at)
     VALUES ($1, $2, 'Кавказская', $3, ${published ? 'NOW()' : 'NULL'}) RETURNING id`,
    [name, JSON.stringify(cities), isOpen],
  );
  return rows.rows[0].id;
}

let orderCounter = 0;
async function createOrderRow(db, { restaurantId, status, itemsTotal = 1000, commissionAmount = 70, statusUpdatedAt = null }) {
  orderCounter += 1;
  const code = `YAAM-R${orderCounter}`;
  const phone = `+7900${String(orderCounter).padStart(7, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // фикстура пишет напрямую SQL, поэтому сама выставляет earned_at =
  // status_updated_at ровно когда status='delivered' (тот же принцип, что
  // и backfill в миграции 0013).
  const rows = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
        items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Тестовый Клиент',$3,'ул. Тестовая, 7','без лука',$4,$5,$6,COALESCE($7, NOW()),
       CASE WHEN $6 = 'delivered' THEN COALESCE($7, NOW()) ELSE NULL END)
     RETURNING id`,
    [code, restaurantId, phone, itemsTotal, commissionAmount, status, statusUpdatedAt],
  );
  return { id: rows.rows[0].id, code };
}
async function addSucceededPayment(db, orderId, amount) {
  const rows = await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`, [orderId, amount]);
  return rows.rows[0].id;
}
async function seedPayoutReadiness(db, restaurantId) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, 'ООО YAAM Платформа', $1, $2, $3, $4, 'ТЕСТБАНК', $5) ON CONFLICT (id) DO NOTHING`,
    [FICTITIOUS_INN10, FICTITIOUS_KPP, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1, 'ip', 'ИП Тестов Тест Тестович', $2, $3, 'г. Грозный, ул. Тестовая, 1', 'Тестов Т. Т.', '+79280000001')`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_OGRNIP],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name, correspondent_account, default_payment_purpose)
     VALUES ($1, 'ИП Тестов Тест Тестович', $2, '', $3, $4, 'ТЕСТБАНК', $5, 'Оплата услуг')`,
    [restaurantId, FICTITIOUS_INN12, FICTITIOUS_RS, FICTITIOUS_BIK, FICTITIOUS_KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status) VALUES ($1,$2,'2026-01-01','signed')`,
    [restaurantId, `Д-${restaurantId}`],
  );
}

// ===========================================================================
// A — список ресторанов
// ===========================================================================
test('A: список без поиска/фильтров/сортировки; карточка без Telegram, выплат и юридических данных', async () => {
  const databaseUrl = await freshDatabase('stage11_list');
  const { db } = requireFreshModules();
  process.env.DATABASE_URL = databaseUrl;
  const restId = await createRestaurant(db, 'Хачапурная', { cities: ['Грозный', 'Шали'] });
  await db.execute(`UPDATE restaurants SET telegram_chat_id = '555000', rating = 4.7, rating_count = 12 WHERE id = $1`, [restId]);
  const archivedId = await createRestaurant(db, 'Архивный Ресторан');
  await db.execute('UPDATE restaurants SET is_open = 0, archived_at = NOW() WHERE id = $1', [archivedId]);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const page = await getPage(base, cookie, '/hq/restaurants');
    assert.equal(page.status, 200);

    // Панель поиска/фильтров удалена целиком.
    assert.doesNotMatch(page.html, /Поиск по названию/);
    assert.doesNotMatch(page.html, /Сортировка/);
    assert.doesNotMatch(page.html, /Применить/);
    assert.doesNotMatch(page.html, /name="search"/);
    assert.doesNotMatch(page.html, /name="sort"/);

    // Карточка: название, все города, кухня, статус, рейтинг, «Открыть».
    assert.match(page.html, /Хачапурная/);
    assert.match(page.html, /Грозный/);
    assert.match(page.html, /Шали/);
    assert.match(page.html, /Кавказская/);
    assert.match(page.html, /4\.7/);
    assert.match(page.html, /Открыть/);
    assert.match(page.html, /\+ Добавить ресторан/);

    // Запрещённое на карточке.
    assert.doesNotMatch(page.html, /Telegram/);
    assert.doesNotMatch(page.html, /Готовность к выплатам/);
    assert.doesNotMatch(page.html, /Доставлено/);
    assert.doesNotMatch(page.html, /555000/, 'telegram_chat_id не должен утекать в список');

    // Архивированный ресторан исчез из рабочего списка.
    assert.doesNotMatch(page.html, /Архивный Ресторан/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// B — обзор ресторана
// ===========================================================================
test('B: обзор — заказы сегодня и за всё время, оборот и доход YAAM; без активных заказов и среднего чека', async () => {
  const databaseUrl = await freshDatabase('stage11_overview');
  process.env.DATABASE_URL = databaseUrl;
  const { db, statsService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Обзорный');

    const todayOrder = await createOrderRow(db, { restaurantId: restId, status: 'delivered', itemsTotal: 1200, commissionAmount: 84 });
    await addSucceededPayment(db, todayOrder.id, 1200);
    const oldOrder = await createOrderRow(db, {
      restaurantId: restId, status: 'delivered', itemsTotal: 800, commissionAmount: 56,
      statusUpdatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    await addSucceededPayment(db, oldOrder.id, 800);
    // Не учитывается: не доставлен.
    const pending = await createOrderRow(db, { restaurantId: restId, status: 'awaiting_restaurant', itemsTotal: 500, commissionAmount: 35 });
    await addSucceededPayment(db, pending.id, 500);

    const overview = await statsService.getOverview(restId);
    assert.equal(overview.ordersToday, 1);
    assert.equal(overview.ordersAllTime, 2, 'за всё время — оба доставленных, включая 40-дневной давности');
    assert.equal(overview.turnoverToday, 1200);
    assert.equal(overview.commissionToday, 84);
    assert.ok(!('avgCheckToday' in overview), 'средний чек убран из обзора');
    assert.ok(!('active' in overview), 'блок активных заказов убран из обзора');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('B2: HTTP-обзор показывает блок «Заказы» и «Доход YAAM сегодня», без слова «доставлено»', async () => {
  const databaseUrl = await freshDatabase('stage11_overview_http');
  process.env.DATABASE_URL = databaseUrl;
  const { db } = requireFreshModules();
  const restId = await createRestaurant(db, 'HTTP Обзор');
  const o = await createOrderRow(db, { restaurantId: restId, status: 'delivered', itemsTotal: 1500, commissionAmount: 105 });
  await addSucceededPayment(db, o.id, 1500);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const page = await getPage(base, cookie, `/hq/restaurants/${restId}`);
    assert.match(page.html, /Заказы/);
    assert.match(page.html, /За всё время/);
    assert.match(page.html, /1500 ₽/);
    assert.match(page.html, /Доход YAAM сегодня/);
    assert.match(page.html, /105 ₽/);
    assert.match(page.html, /Выплаты/);
    assert.doesNotMatch(page.html, /Доставлено сегодня|Всего доставлено|Средний чек/, 'слово «доставлено» и средний чек убраны из управленческих показателей');
    assert.doesNotMatch(page.html, /Активные заказы/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// C — блок «Выплаты»
// ===========================================================================
test('C1: без закрытого расчёта — состояние «следующий расчёт», кнопки «Выплатить» нет', async () => {
  const databaseUrl = await freshDatabase('stage11_payout_scheduled');
  process.env.DATABASE_URL = databaseUrl;
  const { db, payoutStateService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Без расчёта');
    const state = await payoutStateService.getRestaurantPayoutState(restId);
    assert.equal(state.kind, 'scheduled');
    assert.ok(state.daysLeft >= 0 && state.daysLeft <= 7);
    assert.ok(state.at instanceof Date);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C2: закрытый расчёт + готовые реквизиты -> «Готово к выплате»; выплата использует существующую модель', async () => {
  const databaseUrl = await freshDatabase('stage11_payout_ready');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutStateService, payoutService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Готов к выплате');
    await seedPayoutReadiness(db, restId);
    const o = await createOrderRow(db, { restaurantId: restId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, o.id, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const ready = await payoutStateService.getRestaurantPayoutState(restId);
    assert.equal(ready.kind, 'ready');
    assert.equal(ready.amount, 930, 'сумма берётся из immutable snapshot расчётного периода');

    const payout = await payoutStateService.payRestaurantNow(restId);
    assert.equal(payout.amount, 930);
    // Та же сущность, что и на общей вкладке «Выплаты» — не параллельный расчёт.
    const stored = await payoutService.getPayoutById(payout.id);
    assert.equal(stored.restaurant_id, restId);
    assert.equal(stored.settlement_period_id, period.id);

    const after = await payoutStateService.getRestaurantPayoutState(restId);
    assert.equal(after.kind, 'processing', 'после запуска кнопка исчезает — состояние больше не ready');

    // Повторная выплата того же периода невозможна.
    await assert.rejects(() => payoutStateService.payRestaurantNow(restId), /недоступна/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C3: реквизиты не заполнены -> «Не готово к выплате», выплата отклоняется', async () => {
  const databaseUrl = await freshDatabase('stage11_payout_blocked');
  process.env.DATABASE_URL = databaseUrl;
  const { db, settlementService, payoutStateService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Без реквизитов');
    const o = await createOrderRow(db, { restaurantId: restId, status: 'delivered', itemsTotal: 1000, commissionAmount: 70 });
    await addSucceededPayment(db, o.id, 1000);
    const period = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(), periodTo: todayStr() });
    await settlementService.closeSettlementPeriod(period.id);

    const state = await payoutStateService.getRestaurantPayoutState(restId);
    assert.equal(state.kind, 'not_ready');
    assert.equal(state.readiness, 'missing_legal_details');
    await assert.rejects(() => payoutStateService.payRestaurantNow(restId), /недоступна/i);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// D — меню
// ===========================================================================
test('D1: категория, блюдо внутри категории, наличие, архив и восстановление', async () => {
  const databaseUrl = await freshDatabase('stage11_menu');
  process.env.DATABASE_URL = databaseUrl;
  const { db } = requireFreshModules();
  const restId = await createRestaurant(db, 'Меню Тест');
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    let menu = await getPage(base, cookie, `/hq/restaurants/${restId}/menu`);
    assert.match(menu.html, /Добавить категорию/);
    assert.match(menu.html, /Архив/);
    assert.doesNotMatch(menu.html, /Показывать блюда/, 'фильтр блюд удалён');
    assert.doesNotMatch(menu.html, /Выше|Ниже/, 'кнопки перемещения удалены');

    await postForm(base, cookie, `/hq/restaurants/${restId}/menu/categories`, { _csrf: menu.csrf, name: 'Горячее' });
    menu = await getPage(base, cookie, `/hq/restaurants/${restId}/menu`);
    assert.match(menu.html, /Горячее/);
    assert.match(menu.html, /0 блюд/);

    const dbAgain = require('../../db/postgresql');
    const catRows = await dbAgain.query('SELECT id FROM categories WHERE restaurant_id = $1', [restId]);
    const categoryId = catRows[0].id;

    // Блюдо создаётся ВНУТРИ категории.
    const newItemPage = await getPage(base, cookie, `/hq/restaurants/${restId}/menu/items/new?category=${categoryId}`);
    assert.match(newItemPage.html, new RegExp(`value="${categoryId}" selected`));
    await postForm(base, cookie, `/hq/restaurants/${restId}/menu/items`, {
      _csrf: newItemPage.csrf, name: 'Хинкал', category_id: String(categoryId), price: '450',
    });

    menu = await getPage(base, cookie, `/hq/restaurants/${restId}/menu`);
    assert.match(menu.html, /Хинкал/);
    assert.match(menu.html, /450 ₽/);
    assert.match(menu.html, /В наличии/);
    assert.match(menu.html, /1 блюдо/);

    const itemRows = await dbAgain.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restId]);
    const itemId = itemRows[0].id;

    // Убрать из наличия — то же поле is_available, что и Telegram /stoplist.
    const itemPage = await getPage(base, cookie, `/hq/restaurants/${restId}/menu/items/${itemId}`);
    assert.match(itemPage.html, /Нет в наличии/);
    assert.doesNotMatch(itemPage.html, /Сделать недоступным/, 'формулировка запрещена спецификацией');
    assert.doesNotMatch(itemPage.html, /витрин/i, 'наличие и архив больше не описываются через «витрину»');
    await postForm(base, cookie, `/hq/restaurants/${restId}/menu/items/${itemId}/available`, { _csrf: itemPage.csrf, available: '0' });
    menu = await getPage(base, cookie, `/hq/restaurants/${restId}/menu`);
    assert.match(menu.html, /Нет в наличии/);

    // Архивировать -> появляется в архиве, исчезает из меню.
    const itemPage2 = await getPage(base, cookie, `/hq/restaurants/${restId}/menu/items/${itemId}`);
    await postForm(base, cookie, `/hq/restaurants/${restId}/menu/items/${itemId}/archive`, { _csrf: itemPage2.csrf });
    menu = await getPage(base, cookie, `/hq/restaurants/${restId}/menu`);
    assert.doesNotMatch(menu.html, /Хинкал/);
    let archive = await getPage(base, cookie, `/hq/restaurants/${restId}/menu/archive`);
    assert.match(archive.html, /Хинкал/);
    assert.match(archive.html, /Горячее/, 'показывается прежняя категория');

    // Восстановить -> снова в меню, история заказов не тронута.
    await postForm(base, cookie, `/hq/restaurants/${restId}/menu/items/${itemId}/restore`, { _csrf: archive.csrf });
    menu = await getPage(base, cookie, `/hq/restaurants/${restId}/menu`);
    assert.match(menu.html, /Хинкал/);
    const stillThere = await dbAgain.query('SELECT archived_at FROM menu_items WHERE id = $1', [itemId]);
    assert.equal(stillThere[0].archived_at, null);
  } finally {
    await stopApp(instance);
  }
});

test('D2: архивирование непустой категории — перенос блюд либо архив вместе с блюдами', async () => {
  const databaseUrl = await freshDatabase('stage11_menu_category');
  process.env.DATABASE_URL = databaseUrl;
  const { db, menuSvc } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Категории');
    const catA = await menuSvc.createCategory(restId, { name: 'Горячее' });
    const catB = await menuSvc.createCategory(restId, { name: 'Салаты' });
    const item = await menuSvc.createMenuItem(restId, { name: 'Хинкал', category_id: String(catA.id), price: '450' });

    // Пустую категорию нельзя перепутать: непустая archiveCategory отклоняется.
    await assert.rejects(() => menuSvc.archiveCategory(restId, catA.id), /переместите или архивируйте/i);

    // Вариант 1 — перенос блюд.
    const moved = await menuSvc.moveItemsAndArchiveCategory(restId, catA.id, catB.id);
    assert.equal(moved.movedCount, 1);
    const afterMove = await menuSvc.getMenuItemById(restId, item.id);
    assert.equal(afterMove.category_id, catB.id, 'блюдо перенесено, а не удалено');
    assert.equal(afterMove.archived_at, null, 'перенесённое блюдо остаётся в рабочем меню');
    const archivedCat = await menuSvc.getCategoryById(restId, catA.id);
    assert.ok(archivedCat.archived_at);

    // Вариант 2 — архив вместе с блюдами.
    const catC = await menuSvc.createCategory(restId, { name: 'Напитки' });
    const drink = await menuSvc.createMenuItem(restId, { name: 'Компот', category_id: String(catC.id), price: '100' });
    await menuSvc.archiveCategoryWithItems(restId, catC.id);
    const archivedDrink = await menuSvc.getMenuItemById(restId, drink.id);
    assert.ok(archivedDrink.archived_at, 'блюдо архивировано вместе с категорией');
    // Физического удаления нет ни в одном варианте.
    const countRows = await db.query('SELECT COUNT(*)::int AS c FROM menu_items WHERE restaurant_id = $1', [restId]);
    assert.equal(countRows[0].c, 2);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('D3: порядок категорий и блюд меняется полным списком id (перетаскивание)', async () => {
  const databaseUrl = await freshDatabase('stage11_menu_reorder');
  process.env.DATABASE_URL = databaseUrl;
  const { db, menuSvc } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Порядок');
    const c1 = await menuSvc.createCategory(restId, { name: 'Первая' });
    const c2 = await menuSvc.createCategory(restId, { name: 'Вторая' });
    const c3 = await menuSvc.createCategory(restId, { name: 'Третья' });

    await menuSvc.reorderCategories(restId, [c3.id, c1.id, c2.id]);
    const menu = await menuSvc.listMenu(restId);
    assert.deepEqual(menu.map((c) => c.name), ['Третья', 'Первая', 'Вторая']);

    const i1 = await menuSvc.createMenuItem(restId, { name: 'A', category_id: String(c1.id), price: '100' });
    const i2 = await menuSvc.createMenuItem(restId, { name: 'Б', category_id: String(c1.id), price: '200' });
    await menuSvc.reorderMenuItems(restId, c1.id, [i2.id, i1.id]);
    const menu2 = await menuSvc.listMenu(restId);
    const cat1 = menu2.find((c) => c.id === c1.id);
    assert.deepEqual(cat1.items.map((i) => i.name), ['Б', 'A']);

    // Чужие id молча игнорируются, не ломая порядок.
    const applied = await menuSvc.reorderCategories(restId, [999999, c1.id]);
    assert.equal(applied, 1);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// E — заказы
// ===========================================================================
test('E: вкладка заказов — только фильтр по датам; карточка заказа содержит полную информацию', async () => {
  const databaseUrl = await freshDatabase('stage11_orders');
  process.env.DATABASE_URL = databaseUrl;
  const { db } = requireFreshModules();
  const restId = await createRestaurant(db, 'Заказы Тест');
  const order = await createOrderRow(db, { restaurantId: restId, status: 'delivered', itemsTotal: 900, commissionAmount: 63 });
  await addSucceededPayment(db, order.id, 900);
  await db.execute(`INSERT INTO order_items (order_id, name, price, qty) VALUES ($1, 'Хинкал', 450, 2)`, [order.id]);
  await db.execute('UPDATE orders SET rating = 5 WHERE id = $1', [order.id]);
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const ordersPage = await getPage(base, cookie, `/hq/restaurants/${restId}/orders`);
    assert.match(ordersPage.html, /С даты/);
    assert.match(ordersPage.html, /По дату/);
    assert.doesNotMatch(ordersPage.html, /Быстрый фильтр/);
    assert.doesNotMatch(ordersPage.html, /name="status"/);
    assert.doesNotMatch(ordersPage.html, /name="code"/);
    assert.match(ordersPage.html, new RegExp(order.code));

    const detail = await getPage(base, cookie, `/hq/restaurants/${restId}/orders/${order.id}`);
    assert.match(detail.html, new RegExp(order.code));
    assert.match(detail.html, /Хинкал/);
    assert.match(detail.html, /900 ₽/);
    assert.match(detail.html, /Оплачен/);
    assert.match(detail.html, /Тестовый Клиент/);
    assert.match(detail.html, /ул\. Тестовая, 7/);
    assert.match(detail.html, /без лука/, 'комментарий показывается, потому что он был');
    assert.match(detail.html, /★ 5/);
    assert.doesNotMatch(detail.html, /Скидка/, 'нулевые/отсутствующие строки не показываются');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// F — оценки и статистика
// ===========================================================================
test('F: оценки без технического пояснения; статистика по часам и без финансовой сводки', async () => {
  const databaseUrl = await freshDatabase('stage11_stats');
  process.env.DATABASE_URL = databaseUrl;
  const { db, statsService } = requireFreshModules();
  const restId = await createRestaurant(db, 'Статистика Тест');
  const order = await createOrderRow(db, { restaurantId: restId, status: 'delivered', itemsTotal: 700, commissionAmount: 49 });
  await addSucceededPayment(db, order.id, 700);
  await db.execute(`INSERT INTO order_items (order_id, name, price, qty) VALUES ($1, 'Лагман', 350, 2)`, [order.id]);
  await db.execute('UPDATE orders SET rating = 4 WHERE id = $1', [order.id]);
  await db.execute('UPDATE restaurants SET rating = 4, rating_count = 1 WHERE id = $1', [restId]);

  const stats = await statsService.getStatistics(restId, { period: 'today' });
  assert.ok(Array.isArray(stats.hourlySeries), 'для «сегодня» есть почасовой ряд');
  assert.equal(stats.hourlySeries.length, 24);
  const weekStats = await statsService.getStatistics(restId, { period: '7d' });
  assert.equal(weekStats.hourlySeries, null, 'для недели почасового ряда нет — он смешал бы сутки');
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const ratings = await getPage(base, cookie, `/hq/restaurants/${restId}/ratings`);
    assert.match(ratings.html, /Средний рейтинг/);
    assert.match(ratings.html, /Всего оценок/);
    assert.match(ratings.html, /Распределение/);
    assert.doesNotMatch(ratings.html, /В YAAM нет текстовых отзывов/, 'технический поясняющий блок удалён');

    const statsPage = await getPage(base, cookie, `/hq/restaurants/${restId}/statistics?period=today`);
    assert.match(statsPage.html, /Заказы по часам/);
    assert.match(statsPage.html, /Популярные блюда/);
    assert.match(statsPage.html, /Лагман/);
    assert.doesNotMatch(statsPage.html, /Комиссия YAAM/);
    assert.doesNotMatch(statsPage.html, /Сумма ресторана/);
    assert.doesNotMatch(statsPage.html, /Конверсия/);
    assert.doesNotMatch(statsPage.html, /Готовность к выплатам/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// G — настройки
// ===========================================================================
test('G: настройки — города чипами из поддерживаемого списка, лимит 3 фото, блок управления', async () => {
  const databaseUrl = await freshDatabase('stage11_settings');
  process.env.DATABASE_URL = databaseUrl;
  const { db, svc } = requireFreshModules();
  const restId = await createRestaurant(db, 'Настройки Тест', { cities: ['Грозный'] });
  await db.close();

  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const settings = await getPage(base, cookie, `/hq/restaurants/${restId}/settings`);
    assert.match(settings.html, /Фотографии ресторана/);
    assert.match(settings.html, /name="cities" value="Грозный"[^>]*checked/);
    assert.match(settings.html, /value="Аргун"/);
    assert.match(settings.html, /value="Гудермес"/);
    assert.match(settings.html, /value="Шали"/);
    assert.doesNotMatch(settings.html, /Города \(через запятую\)/, 'ввод одной строкой запрещён');
    assert.match(settings.html, /Управление рестораном/);
    assert.match(settings.html, /Скрыть с сайта/);
    assert.match(settings.html, /Архивировать/);
    assert.match(settings.html, /Telegram/);

    // Несколько городов сохраняются повторяющимися ключами (как реальные чекбоксы).
    const body = new URLSearchParams({ _csrf: settings.csrf, name: 'Настройки Тест', cuisine: 'Кавказская', min_order: '300' });
    body.append('cities', 'Грозный');
    body.append('cities', 'Шали');
    const res = await fetch(`${base}/hq/restaurants/${restId}/settings`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 200);
    const dbAgain = require('../../db/postgresql');
    const rows = await dbAgain.query('SELECT cities FROM restaurants WHERE id = $1', [restId]);
    assert.deepEqual(JSON.parse(rows[0].cities), ['Грозный', 'Шали']);

    // Город вне поддерживаемого списка отбрасывается.
    assert.deepEqual(svc.parseCitiesInput(['Грозный', 'Москва']), ['Грозный']);
  } finally {
    await stopApp(instance);
  }
});

test('G2: галерея ресторана ограничена тремя фотографиями', async () => {
  const photoService = require('../../services/hq/media/photoService');
  assert.equal(photoService.RESTAURANT_MAX_PHOTOS, 3);
});

// ===========================================================================
// H — Telegram-привязка
// ===========================================================================
test('H: одноразовый код подключения; один чат не может обслуживать два ресторана', async () => {
  const databaseUrl = await freshDatabase('stage11_telegram');
  process.env.DATABASE_URL = databaseUrl;
  const { db, telegramLinkService } = requireFreshModules();
  try {
    const restA = await createRestaurant(db, 'Ресторан А');
    const restB = await createRestaurant(db, 'Ресторан Б');

    const code = await telegramLinkService.issueConnectCode(restA);
    assert.match(code, /^YAAM-[A-Z0-9]{6}$/);

    const linked = await telegramLinkService.consumeConnectCode(code, 'chat-1', 'Группа А');
    assert.equal(linked.id, restA);
    assert.equal(linked.telegram_chat_title, 'Группа А');

    // Код одноразовый.
    const second = await telegramLinkService.consumeConnectCode(code, 'chat-1', 'Группа А');
    assert.equal(second, null);

    // Код после подключения не показывается.
    const state = await telegramLinkService.getLinkState(restA);
    assert.equal(state.connected, true);
    assert.equal(state.connectCode, null);
    assert.equal(state.chatTitle, 'Группа А');

    // Один чат — один ресторан.
    const codeB = await telegramLinkService.issueConnectCode(restB);
    await assert.rejects(() => telegramLinkService.consumeConnectCode(codeB, 'chat-1', 'Группа А'), /уже привязана/i);

    // Подключённому ресторану новый код не выпускается без отключения.
    await assert.rejects(() => telegramLinkService.issueConnectCode(restA), /уже подключён/i);

    // Переподключение отвязывает и выдаёт новый код.
    const newCode = await telegramLinkService.reconnect(restA);
    assert.notEqual(newCode, code);
    const afterReconnect = await telegramLinkService.getLinkState(restA);
    assert.equal(afterReconnect.connected, false);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// I — пауза ресторана
// ===========================================================================
test('I: перерыв через Telegram создаёт события начала и завершения в «Центре событий»', async () => {
  const databaseUrl = await freshDatabase('stage11_pause');
  process.env.DATABASE_URL = databaseUrl;
  const { db, orderService, eventLogService } = requireFreshModules();
  try {
    await db.execute(`INSERT INTO hq_owner (id, login, password_hash) VALUES (1,'owner','x') ON CONFLICT (id) DO NOTHING`);
    const restId = await createRestaurant(db, 'Хачапурная');

    await orderService.pauseRestaurant(restId, 'medium'); // 3 часа
    await new Promise((r) => setTimeout(r, 200));
    let events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'restaurant_pause');
    assert.equal(events.length, 1);
    assert.equal(events[0].restaurantName, 'Хачапурная');
    assert.match(events[0].message, /перерыв на 3 часа/);
    assert.match(events[0].message, /приостановлен до \d{2}:\d{2}/);

    await orderService.resumeRestaurant(restId);
    await new Promise((r) => setTimeout(r, 200));
    events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'restaurant_pause');
    assert.equal(events.length, 2);
    assert.match(events[1].message, /Перерыв завершён/);
    assert.match(events[1].message, /возобновлён/);

    // Повторный resume на уже открытом ресторане события не создаёт.
    await orderService.resumeRestaurant(restId);
    await new Promise((r) => setTimeout(r, 200));
    events = (await eventLogService.listActiveEvents()).filter((e) => e.category === 'restaurant_pause');
    assert.equal(events.length, 2, 'без информационного шума');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// J — таймер приготовления
// ===========================================================================
test('J: серверный дедлайн ставится один раз при «Готовится» и обнуляется на «Готово» (Stage 33 — раньше обнулялся на «Передал курьеру»)', async () => {
  const databaseUrl = await freshDatabase('stage11_prep_deadline');
  process.env.DATABASE_URL = databaseUrl;
  const { db, orderService } = requireFreshModules();
  try {
    const restId = await createRestaurant(db, 'Таймер');
    const order = await createOrderRow(db, { restaurantId: restId, status: 'awaiting_restaurant' });
    await addSucceededPayment(db, order.id, 1000);

    await orderService.restaurantAccept(order.id);
    let row = (await db.query('SELECT preparation_deadline FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(row.preparation_deadline, null, 'до выбора времени дедлайна нет');

    const beforeMs = Date.now();
    await orderService.restaurantAdvance(order.id, 'preparing', { estimatedMinutes: 45 });
    row = (await db.query('SELECT preparation_deadline, estimated_ready_minutes FROM orders WHERE id = $1', [order.id]))[0];
    assert.ok(row.preparation_deadline instanceof Date);
    assert.equal(row.estimated_ready_minutes, 45);
    const deltaMin = (row.preparation_deadline.getTime() - beforeMs) / 60000;
    assert.ok(deltaMin > 44 && deltaMin < 46, `дедлайн ~45 минут вперёд, получено ${deltaMin}`);

    // Публичный DTO отдаёт неизменяемый ISO — клиент считает остаток от него.
    const dto = orderService.toPublicOrderDTO(await orderService.getOrder(order.id));
    assert.equal(dto.preparation_deadline, row.preparation_deadline.toISOString());

    // Повторное чтение не сдвигает дедлайн (клиент не может его сбросить).
    const again = (await db.query('SELECT preparation_deadline FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(again.preparation_deadline.toISOString(), row.preparation_deadline.toISOString());

    // Stage 33 — таймер теперь исчезает на «Готово» (preparing -> ready), не
    // на «Передал курьеру»: ready уже недвусмысленно значит "готовка
    // закончена", раньше единственным сигналом этого была именно передача
    // курьеру.
    await orderService.restaurantAdvance(order.id, 'ready');
    row = (await db.query('SELECT preparation_deadline FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(row.preparation_deadline, null, 'после «Готово» таймер исчезает');

    await orderService.restaurantAdvance(order.id, 'courier');
    row = (await db.query('SELECT preparation_deadline FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(row.preparation_deadline, null, 'после передачи курьеру таймер по-прежнему отсутствует');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
