'use strict';

// YAAM HQ Stage 5A — интеграционные тесты рабочего меню/блюд против
// настоящего embedded PostgreSQL. Тот же harness-паттерн, что и
// hqRestaurantLifecycleStage41.test.js (Stage 4.1).
//
// M — идемпотентность повторного применения schema.sql (не трогает уже
//     созданное меню).
// A — services/hq/menuAdminService.js напрямую: категории/блюда, ownership,
//     availability, archive/restore, movement.
// B — полный HTTP-цикл через createPostgresqlApp(): создание категории и
//     блюда, редактирование, доступность, архив, audit log.
// C — защита цены/снимок order_items, отклонение архивированных/
//     недоступных/чужих блюд при создании заказа.
// D — публичный API: фильтрация архивированных категорий/блюд, allowlist
//     полей.
// E — запрет открытия ресторана без доступного блюда; авто-закрытие при
//     отключении последнего доступного блюда.
// F — CSRF/auth/404/ownership-изоляция между ресторанами.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'f'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Menu5A';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-menu-stage5a');
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
  const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
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
  return '+79' + String(crypto.randomInt(100000000, 999999999)).padStart(9, '0');
}

// Ресторан, готовый принимать заказы (опубликован + открыт) — HQ-путём:
// создать -> опубликовать -> добавить категорию+доступное блюдо -> открыть.
async function setupOpenRestaurantWithDish(base, cookie, { name, price = 500 } = {}) {
  const createPage = await getPage(base, cookie, '/hq/restaurants/new');
  const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name, cities: 'Грозный' });
  const restaurantPath = createRes.headers.get('location');
  const restaurantId = Number(restaurantPath.split('/').pop());

  let page = await getPage(base, cookie, restaurantPath);
  await postForm(base, cookie, `${restaurantPath}/publish`, { _csrf: page.csrf });

  page = await getPage(base, cookie, `${restaurantPath}/menu`);
  await postForm(base, cookie, `${restaurantPath}/menu/categories`, { _csrf: page.csrf, name: 'Горячее' });

  const menuDb = require('../../db/postgresql');
  const catRows = await menuDb.query('SELECT id FROM categories WHERE restaurant_id = $1', [restaurantId]);
  const categoryId = catRows[0].id;

  const itemPage = await getPage(base, cookie, `${restaurantPath}/menu/items/new`);
  await postForm(base, cookie, `${restaurantPath}/menu/items`, {
    _csrf: itemPage.csrf, name: 'Шашлык', category_id: String(categoryId), price: String(price),
  });
  const itemRows = await menuDb.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
  const itemId = itemRows[0].id;

  page = await getPage(base, cookie, restaurantPath);
  await postForm(base, cookie, `${restaurantPath}/open`, { _csrf: page.csrf });

  return { restaurantId, restaurantPath, categoryId, itemId };
}

// ===========================================================================
// M. Идемпотентность повторного применения schema.sql
// ===========================================================================

test('M: повторное применение schema.sql не трогает уже созданные категории/блюда', async () => {
  const dbName = 'yaam_hq_menu_migration_test';
  await cluster.createDatabase(dbName);
  const client = cluster.getClient(dbName);
  await client.connect();
  try {
    await client.query(SCHEMA_SQL);
    const rRows = await client.query(`INSERT INTO restaurants (name, cities) VALUES ('R', '[]') RETURNING id`);
    const cRows = await client.query(`INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, 'Cat', 1) RETURNING id`, [rRows.rows[0].id]);
    const iRows = await client.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, price, sort_order, archived_at)
       VALUES ($1, $2, 'Item', 100, 1, NOW()) RETURNING id, archived_at`,
      [rRows.rows[0].id, cRows.rows[0].id],
    );
    const archivedAtBefore = iRows.rows[0].archived_at.toISOString();

    await client.query(SCHEMA_SQL); // повторный "деплой"

    const after = await client.query('SELECT name, sort_order, archived_at FROM menu_items WHERE id = $1', [iRows.rows[0].id]);
    assert.equal(after.rows[0].name, 'Item');
    assert.equal(after.rows[0].sort_order, 1);
    assert.equal(after.rows[0].archived_at.toISOString(), archivedAtBefore);
  } finally {
    await client.end();
  }
});

// ===========================================================================
// A. services/hq/menuAdminService.js — напрямую
// ===========================================================================

test('A: категории и блюда через сервисный слой', async (t) => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_service_test');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/menuAdminService')];
  delete require.cache[require.resolve('../../services/hq/restaurantAdminService')];
  const db = require('../../db/postgresql');
  const menuSvc = require('../../services/hq/menuAdminService');
  const { ValidationError } = require('../../services/hq/restaurantLifecycle');

  const r1 = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ('R1', '[]') RETURNING *`);
  const r2 = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ('R2', '[]') RETURNING *`);
  const restaurant1 = r1.rows[0].id;
  const restaurant2 = r2.rows[0].id;

  await t.test('A1: createCategory принадлежит ровно своему ресторану', async () => {
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Горячее' });
    assert.equal(cat.restaurant_id, restaurant1);
    const notFoundForOther = await menuSvc.getCategoryById(restaurant2, cat.id);
    assert.equal(notFoundForOther, null, 'категория ресторана 1 не должна быть видна ресторану 2');
  });

  await t.test('A2: createMenuItem отклоняет категорию чужого ресторана', async () => {
    const catR2 = await menuSvc.createCategory(restaurant2, { name: 'Чужая категория' });
    await assert.rejects(
      () => menuSvc.createMenuItem(restaurant1, { name: 'Блюдо', category_id: String(catR2.id), price: '100' }),
      ValidationError,
    );
  });

  await t.test('A3: updateMenuItem не меняет order_items прошлых заказов (структурно — сам UPDATE их не затрагивает)', async () => {
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Cat A3' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Старое имя', category_id: String(cat.id), price: '100' });
    await db.execute(`INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status) VALUES ('YAAM-A3', $1, 'Грозный', 'К', '+7', 'Адрес', 100, 7, 'delivered')`, [restaurant1]);
    const orderRow = await db.query(`SELECT id FROM orders WHERE public_code = 'YAAM-A3'`);
    await db.execute(`INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES ($1,$2,$3,$4,1)`, [orderRow[0].id, item.id, 'Старое имя', 100]);

    await menuSvc.updateMenuItem(restaurant1, item.id, { name: 'Новое имя', category_id: String(cat.id), price: '200' });

    const snapshot = await db.query('SELECT name, price FROM order_items WHERE order_id = $1', [orderRow[0].id]);
    assert.equal(snapshot[0].name, 'Старое имя', 'snapshot названия в order_items не должен измениться');
    assert.equal(snapshot[0].price, 100, 'snapshot цены в order_items не должен измениться');
  });

  await t.test('A4: availability — setMenuItemAvailability переключает is_available', async () => {
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Cat A4' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Блюдо A4', category_id: String(cat.id), price: '100' });
    const off = await menuSvc.setMenuItemAvailability(restaurant1, item.id, false);
    assert.equal(off.is_available, 0);
    const on = await menuSvc.setMenuItemAvailability(restaurant1, item.id, true);
    assert.equal(on.is_available, 1);
  });

  await t.test('A5: archive/restore блюда — restore не делает доступным автоматически', async () => {
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Cat A5' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Блюдо A5', category_id: String(cat.id), price: '100' });
    const archived = await menuSvc.archiveMenuItem(restaurant1, item.id);
    assert.ok(archived.archived_at);
    assert.equal(archived.is_available, 0, 'архивирование снимает доступность');
    await assert.rejects(() => menuSvc.setMenuItemAvailability(restaurant1, item.id, true), ValidationError, 'нельзя сделать доступным архивированное блюдо напрямую');
    const restored = await menuSvc.restoreMenuItem(restaurant1, item.id);
    assert.equal(restored.archived_at, null);
    assert.equal(restored.is_available, 0, 'восстановленное блюдо остаётся недоступным');
  });

  await t.test('A6: archiveCategory отклоняет непустую категорию, разрешает пустую', async () => {
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Cat A6' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Блюдо A6', category_id: String(cat.id), price: '100' });
    await assert.rejects(() => menuSvc.archiveCategory(restaurant1, cat.id), ValidationError);
    await menuSvc.archiveMenuItem(restaurant1, item.id);
    const archived = await menuSvc.archiveCategory(restaurant1, cat.id);
    assert.ok(archived.archived_at, 'после архивирования единственного блюда категория архивируется');
  });

  await t.test('A7: moveCategory — атомарный swap sort_order', async () => {
    const c1 = await menuSvc.createCategory(restaurant1, { name: 'Move Cat 1' });
    const c2 = await menuSvc.createCategory(restaurant1, { name: 'Move Cat 2' });
    assert.ok(c2.sort_order > c1.sort_order);
    const moved = await menuSvc.moveCategory(restaurant1, c2.id, 'up');
    assert.equal(moved.sort_order, c1.sort_order);
    const c1After = await menuSvc.getCategoryById(restaurant1, c1.id);
    assert.equal(c1After.sort_order, c2.sort_order, 'сосед должен получить старый sort_order перемещённого элемента');
  });

  await t.test('A8: moveCategory первого элемента вверх — no-op, не бросает', async () => {
    // Отдельный, изолированный ресторан — restaurant1 уже накопил категории
    // из предыдущих подтестов, поэтому "первой по sort_order" в НЁМ могла
    // бы оказаться совсем другая, ранее созданная категория.
    const soloRestaurant = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ('Solo Restaurant', '[]') RETURNING id`);
    const soloRestaurantId = soloRestaurant.rows[0].id;
    const cat = await menuSvc.createCategory(soloRestaurantId, { name: 'Solo Cat' });
    const result = await menuSvc.moveCategory(soloRestaurantId, cat.id, 'up');
    assert.equal(result.sort_order, cat.sort_order);
  });

  await t.test('A9: moveMenuItem — атомарный swap внутри своей категории', async () => {
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Cat A9' });
    const i1 = await menuSvc.createMenuItem(restaurant1, { name: 'I1', category_id: String(cat.id), price: '10' });
    const i2 = await menuSvc.createMenuItem(restaurant1, { name: 'I2', category_id: String(cat.id), price: '10' });
    const moved = await menuSvc.moveMenuItem(restaurant1, i2.id, 'up');
    assert.equal(moved.sort_order, i1.sort_order);
  });

  await t.test('A10: moveMenuItemToCategory — блюдо получает последнюю позицию в новой категории', async () => {
    const catA = await menuSvc.createCategory(restaurant1, { name: 'Cat From' });
    const catB = await menuSvc.createCategory(restaurant1, { name: 'Cat To' });
    await menuSvc.createMenuItem(restaurant1, { name: 'Existing in B', category_id: String(catB.id), price: '10' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Moving', category_id: String(catA.id), price: '10' });
    const moved = await menuSvc.moveMenuItemToCategory(restaurant1, item.id, catB.id);
    assert.equal(moved.category_id, catB.id);
    const inCatB = await db.query('SELECT MAX(sort_order) AS m FROM menu_items WHERE category_id = $1', [catB.id]);
    assert.equal(moved.sort_order, inCatB[0].m, 'перемещённое блюдо должно получить максимальный (последний) sort_order в новой категории');
  });

  await t.test('A11: moveMenuItemToCategory отклоняет категорию другого ресторана', async () => {
    const catOwn = await menuSvc.createCategory(restaurant1, { name: 'Own Cat A11' });
    const catOther = await menuSvc.createCategory(restaurant2, { name: 'Other Cat A11' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Item A11', category_id: String(catOwn.id), price: '10' });
    await assert.rejects(() => menuSvc.moveMenuItemToCategory(restaurant1, item.id, catOther.id), ValidationError);
  });

  await t.test('A12: countAvailableMenuItems учитывает только неархивированное доступное блюдо в неархивированной категории', async () => {
    // restaurant1 уже накопил блюда из предыдущих подтестов (A1-A11 — общий
    // ресторан в этом test()) — проверяем ДЕЛЬТУ, а не абсолютный 0.
    const cat = await menuSvc.createCategory(restaurant1, { name: 'Cat A12' });
    const item = await menuSvc.createMenuItem(restaurant1, { name: 'Item A12', category_id: String(cat.id), price: '10' });
    const before = await menuSvc.countAvailableMenuItems(restaurant1);
    assert.ok(before >= 1);
    await menuSvc.setMenuItemAvailability(restaurant1, item.id, false);
    const afterUnavailable = await menuSvc.countAvailableMenuItems(restaurant1);
    assert.equal(afterUnavailable, before - 1);
  });

  await db.close();
  delete process.env.DATABASE_URL;
});

// ===========================================================================
// B. Полный HTTP-цикл + audit log
// ===========================================================================

test('B: полный HTTP-цикл категория+блюдо, доступность, архив, audit log', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_http_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'Меню HTTP Тест', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());

    // Пустое меню.
    let menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    assert.match(menuPage.html, /В меню пока нет блюд/);
    assert.doesNotMatch(menuPage.html, /Выбрать блюдо/, 'кнопка не должна называться "Выбрать блюдо" (задание, раздел 6)');
    assert.match(menuPage.html, /Добавить блюдо/);

    // Создать категорию.
    let res = await postForm(base, cookie, `${restaurantPath}/menu/categories`, { _csrf: menuPage.csrf, name: 'Горячее' });
    assert.equal(res.status, 302);
    const auditCategory = await db.query("SELECT action, details FROM hq_audit_log WHERE action = 'category_created'");
    assert.equal(auditCategory.length, 1);
    assert.match(auditCategory[0].details, /Горячее/);

    menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    assert.match(menuPage.html, /Горячее/);
    const catRows = await db.query('SELECT id FROM categories WHERE restaurant_id = $1', [restaurantId]);
    const categoryId = catRows[0].id;

    // Создать блюдо с полными данными (состав/вес/БЖУ).
    const itemFormPage = await getPage(base, cookie, `${restaurantPath}/menu/items/new`);
    res = await postForm(base, cookie, `${restaurantPath}/menu/items`, {
      _csrf: itemFormPage.csrf, name: 'Шашлык из баранины', category_id: String(categoryId), price: '650',
      description: 'Сочный шашлык', composition: 'баранина, лук, специи',
      weight_g: '300', kcal: '540', protein_g: '25', fat_g: '40', carbs_g: '5',
    });
    assert.equal(res.status, 302);
    const auditItem = await db.query("SELECT action FROM hq_audit_log WHERE action = 'menu_item_created'");
    assert.equal(auditItem.length, 1);

    menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    assert.match(menuPage.html, /Шашлык из баранины/);
    assert.match(menuPage.html, /650/);
    const itemRows = await db.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
    const itemId = itemRows[0].id;

    // Открыть карточку блюда — реальные данные видны.
    const itemPage = await getPage(base, cookie, `${restaurantPath}/menu/items/${itemId}`);
    assert.match(itemPage.html, /Сочный шашлык/);
    assert.match(itemPage.html, /баранина, лук, специи/);

    // Редактировать — цена/название меняются.
    res = await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}`, {
      _csrf: itemPage.csrf, name: 'Шашлык из баранины (новый)', category_id: String(categoryId), price: '700',
      description: 'Сочный шашлык', composition: 'баранина, лук, специи',
    });
    assert.equal(res.status, 302);
    const auditUpdate = await db.query("SELECT details FROM hq_audit_log WHERE action = 'menu_item_updated'");
    assert.match(auditUpdate[0].details, /price: "650" -> "700"/);

    // Сделать недоступным.
    menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    res = await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}/available`, { _csrf: menuPage.csrf, available: '0' });
    assert.equal(res.status, 302);
    const auditUnavailable = await db.query("SELECT action FROM hq_audit_log WHERE action = 'menu_item_unavailable'");
    assert.equal(auditUnavailable.length, 1);
    menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    assert.match(menuPage.html, /Временно недоступно/);

    // Вернуть доступность.
    res = await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}/available`, { _csrf: menuPage.csrf, available: '1' });
    assert.equal(res.status, 302);
    const auditAvailable = await db.query("SELECT action FROM hq_audit_log WHERE action = 'menu_item_available'");
    assert.equal(auditAvailable.length, 1);

    // Архивировать блюдо.
    menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    res = await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}/archive`, { _csrf: menuPage.csrf });
    assert.equal(res.status, 302);
    const auditArchived = await db.query("SELECT action FROM hq_audit_log WHERE action = 'menu_item_archived'");
    assert.equal(auditArchived.length, 1);
    menuPage = await getPage(base, cookie, `${restaurantPath}/menu?filter=archived`);
    assert.match(menuPage.html, /Архивировано/);

    // Восстановить — остаётся недоступным.
    res = await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}/restore`, { _csrf: menuPage.csrf });
    assert.equal(res.status, 302);
    const auditRestored = await db.query("SELECT action FROM hq_audit_log WHERE action = 'menu_item_restored'");
    assert.equal(auditRestored.length, 1);
    menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    assert.match(menuPage.html, /Временно недоступно/, 'восстановленное блюдо остаётся недоступным, не открывается автоматически');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// C. Защита цены/снимок заказа
// ===========================================================================

test('C: сервер отклоняет поддельную цену/чужое/архивированное/недоступное блюдо; order_items — реальный snapshot', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_order_protection_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, itemId } = await setupOpenRestaurantWithDish(base, cookie, { name: 'Order Protection', price: 500 });

    function basePayload(overrides = {}) {
      return {
        restaurantId, city: 'Грозный', customerName: 'К', customerPhone: uniquePhone(),
        address: 'ул. 1', comment: '', fulfillmentType: 'delivery',
        items: [{ menuItemId: itemId, name: 'Подделанное имя', qty: 1, price: 1 }],
        orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
        createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
        ...overrides,
      };
    }

    // C1: клиент передаёт price=1 и чужое name — сервер использует реальную цену/название из БД.
    const { order } = await orderService.createOrderAndResolve(basePayload());
    assert.equal(order.items_total, 500, 'сервер должен был проигнорировать поддельную цену 1 и использовать реальную 500');
    const savedItems = await db.query('SELECT name, price FROM order_items WHERE order_id = $1', [order.id]);
    assert.equal(savedItems[0].name, 'Шашлык', 'name из БД, не из запроса клиента');
    assert.equal(savedItems[0].price, 500);

    // C2: недоступное блюдо отклоняется.
    await db.execute('UPDATE menu_items SET is_available = 0 WHERE id = $1', [itemId]);
    await assert.rejects(() => orderService.createOrderAndResolve(basePayload({
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    })), /стоп-лист/);
    await db.execute('UPDATE menu_items SET is_available = 1 WHERE id = $1', [itemId]);

    // C3: архивированное блюдо отклоняется.
    await db.execute('UPDATE menu_items SET archived_at = NOW() WHERE id = $1', [itemId]);
    await assert.rejects(() => orderService.createOrderAndResolve(basePayload({
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    })), /не найдено/);
    await db.execute('UPDATE menu_items SET archived_at = NULL WHERE id = $1', [itemId]);

    // C4: блюдо из архивированной категории отклоняется.
    const catRow = await db.query('SELECT category_id FROM menu_items WHERE id = $1', [itemId]);
    await db.execute('UPDATE categories SET archived_at = NOW() WHERE id = $1', [catRow[0].category_id]);
    await assert.rejects(() => orderService.createOrderAndResolve(basePayload({
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    })), /не найдено/);
    await db.execute('UPDATE categories SET archived_at = NULL WHERE id = $1', [catRow[0].category_id]);

    // C5: блюдо ДРУГОГО ресторана отклоняется.
    const other = await db.execute(`INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('Other', '[]', 1, NOW()) RETURNING id`);
    const otherCat = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1, $2) RETURNING id', [other.rows[0].id, 'Cat']);
    const otherItem = await db.execute(
      'INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id',
      [other.rows[0].id, otherCat.rows[0].id, 'Чужое блюдо', 100],
    );
    await assert.rejects(() => orderService.createOrderAndResolve(basePayload({
      items: [{ menuItemId: otherItem.rows[0].id, name: 'x', qty: 1 }],
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    })), /не найдено/, 'блюдо другого ресторана должно быть отклонено, как несуществующее');

    // C6: редактирование блюда ПОСЛЕ заказа не меняет уже созданный order_items.
    const itemPage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/${itemId}`);
    await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/${itemId}`, {
      _csrf: itemPage.csrf, name: 'Совсем другое имя', category_id: String(catRow[0].category_id), price: '999',
    });
    const stillOldSnapshot = await db.query('SELECT name, price FROM order_items WHERE order_id = $1', [order.id]);
    assert.equal(stillOldSnapshot[0].name, 'Шашлык', 'старый заказ должен сохранить прежнее название после редактирования блюда');
    assert.equal(stillOldSnapshot[0].price, 500, 'старый заказ должен сохранить прежнюю цену после редактирования блюда');
  } finally {
    await stopApp(instance);
  }
});

test('C7: заказ отклоняется для неопубликованного/архивированного/закрытого ресторана', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_restaurant_state_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    // is_open=0 явно — по умолчанию схема ставит is_open=1 (легаси-дефолт
    // для ботовских ресторанов), и без явного 0 шаг "опубликован, но закрыт"
    // ниже был бы уже открытым, а не закрытым.
    const r = await db.execute(`INSERT INTO restaurants (name, cities, is_open) VALUES ('Draft R', '[]', 0) RETURNING id`);
    const restaurantId = r.rows[0].id;
    const cat = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1, $2) RETURNING id', [restaurantId, 'Cat']);
    const item = await db.execute('INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id', [restaurantId, cat.rows[0].id, 'Item', 100]);

    function payload() {
      return {
        restaurantId, city: 'Грозный', customerName: 'К', customerPhone: uniquePhone(),
        address: 'ул. 1', comment: '', fulfillmentType: 'delivery',
        items: [{ menuItemId: item.rows[0].id, name: 'Item', qty: 1 }],
        orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
        createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      };
    }

    // Черновик (не опубликован).
    await assert.rejects(() => orderService.createOrderAndResolve(payload()), /не опубликован/);

    // Опубликован, но закрыт.
    await db.execute('UPDATE restaurants SET published_at = NOW() WHERE id = $1', [restaurantId]);
    await assert.rejects(() => orderService.createOrderAndResolve(payload()), /закрыт/);

    // Архивирован. is_open=1 здесь НЕ выставляется намеренно: DB CHECK
    // chk_restaurants_archived_closed (Stage 4.1) физически запрещает
    // одновременно archived_at IS NOT NULL и is_open=1 — сама база уже не
    // допускает эту комбинацию, orderService-проверка archived_at здесь
    // защищает именно "архивирован и формально закрыт" случай.
    await db.execute('UPDATE restaurants SET archived_at = NOW() WHERE id = $1', [restaurantId]);
    await assert.rejects(() => orderService.createOrderAndResolve(payload()), /архивирован/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// D. Публичный API
// ===========================================================================

test('D: публичный API скрывает архивированные категории/блюда и внутренние поля', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_public_api_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, categoryId, itemId } = await setupOpenRestaurantWithDish(base, cookie, { name: 'Public API Test', price: 321 });

    // Второе, недоступное (не архивированное) блюдо — должно быть видно с available:false.
    const itemPage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/new`);
    await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/items`, {
      _csrf: itemPage.csrf, name: 'Недоступное блюдо', category_id: String(categoryId), price: '200',
    });
    const unavailableRow = await db.query("SELECT id FROM menu_items WHERE name = 'Недоступное блюдо'");
    const unavailableId = unavailableRow[0].id;
    const menuPage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
    await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/${unavailableId}/available`, { _csrf: menuPage.csrf, available: '0' });

    // Третье, архивированное — должно ПОЛНОСТЬЮ отсутствовать.
    const itemPage2 = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/new`);
    await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/items`, {
      _csrf: itemPage2.csrf, name: 'Архивное блюдо', category_id: String(categoryId), price: '150',
    });
    const archivedRow = await db.query("SELECT id FROM menu_items WHERE name = 'Архивное блюдо'");
    const menuPage2 = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
    await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/${archivedRow[0].id}/archive`, { _csrf: menuPage2.csrf });

    const publicRes = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    const items = publicRes.menu[0].items;
    const names = items.map((i) => i.name);
    assert.ok(names.includes('Шашлык'));
    assert.ok(names.includes('Недоступное блюдо'), 'недоступное (но не архивированное) блюдо остаётся видимым в меню');
    assert.ok(!names.includes('Архивное блюдо'), 'архивированное блюдо не должно быть видно публично');

    const unavailablePublic = items.find((i) => i.name === 'Недоступное блюдо');
    assert.equal(unavailablePublic.available !== undefined ? unavailablePublic.available : unavailablePublic.is_available, 0);

    const mainDish = items.find((i) => i.name === 'Шашлык');
    assert.equal(mainDish.price, 321);
    assert.ok(!('archived_at' in mainDish), 'archived_at не должен утекать в публичный DTO');
    assert.ok(!('category_id' in mainDish), 'category_id — внутреннее поле, не нужно клиенту');
    assert.ok(!('restaurant_id' in mainDish));
    assert.ok(!('sort_order' in mainDish));

    // Архивируем саму категорию (сначала архивируем оставшиеся блюда) — категория тоже должна исчезнуть.
    for (const id of [itemId, unavailableId]) {
      const p = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
      await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/${id}/archive`, { _csrf: p.csrf });
    }
    const p2 = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
    await postForm(base, cookie, `/hq/restaurants/${restaurantId}/menu/categories/${categoryId}/archive`, { _csrf: p2.csrf });
    const publicAfterCategoryArchive = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    assert.equal(publicAfterCategoryArchive.menu.length, 0, 'архивированная категория не должна быть видна публично вовсе');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// E. Открытие требует доступное блюдо; авто-закрытие
// ===========================================================================

test('E1: openRestaurant отклоняется без доступного блюда, с понятным сообщением', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_open_guard_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'Пустое Меню Тест', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');

    let page = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/publish`, { _csrf: page.csrf });

    page = await getPage(base, cookie, restaurantPath);
    const res = await postForm(base, cookie, `${restaurantPath}/open`, { _csrf: page.csrf });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.match(location, /error=/);

    const afterPage = await getPage(base, cookie, location);
    assert.match(afterPage.html, /Добавьте хотя бы одно доступное блюдо/);
    assert.doesNotMatch(afterPage.html, />Открыт</, 'ресторан не должен был открыться');
  } finally {
    await stopApp(instance);
  }
});

test('E2: отключение последнего доступного блюда автоматически закрывает открытый ресторан', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_autoclose_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, restaurantPath, itemId } = await setupOpenRestaurantWithDish(base, cookie, { name: 'Автозакрытие Тест' });

    let overview = await getPage(base, cookie, restaurantPath);
    assert.match(overview.html, />Открыт</);

    const menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    const res = await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}/available`, { _csrf: menuPage.csrf, available: '0' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /notice=/);

    const restaurantRow = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [restaurantId]);
    assert.equal(restaurantRow[0].is_open, 0, 'ресторан должен был автоматически закрыться');

    overview = await getPage(base, cookie, restaurantPath);
    assert.match(overview.html, /Закрыт/);

    const auditAutoClose = await db.query("SELECT details FROM hq_audit_log WHERE action = 'restaurant_updated' AND details LIKE '%auto%'");
    assert.equal(auditAutoClose.length, 1, 'авто-закрытие должно быть в audit log');

    // Клиент больше не может создать новый заказ — ресторан закрыт.
    const orderService = require('../../services/postgresql/orderService');
    await assert.rejects(() => orderService.createOrderAndResolve({
      restaurantId, city: 'Грозный', customerName: 'К', customerPhone: uniquePhone(),
      address: 'ул. 1', comment: '', fulfillmentType: 'delivery',
      items: [{ menuItemId: itemId, name: 'x', qty: 1 }],
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    }), /закрыт/);
  } finally {
    await stopApp(instance);
  }
});

test('E3: авто-закрытие НЕ срабатывает, если остаются другие доступные блюда', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_no_autoclose_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, restaurantPath, categoryId, itemId } = await setupOpenRestaurantWithDish(base, cookie, { name: 'Два Блюда Тест' });

    const itemPage = await getPage(base, cookie, `${restaurantPath}/menu/items/new`);
    await postForm(base, cookie, `${restaurantPath}/menu/items`, {
      _csrf: itemPage.csrf, name: 'Второе блюдо', category_id: String(categoryId), price: '300',
    });

    const menuPage = await getPage(base, cookie, `${restaurantPath}/menu`);
    await postForm(base, cookie, `${restaurantPath}/menu/items/${itemId}/available`, { _csrf: menuPage.csrf, available: '0' });

    const restaurantRow = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [restaurantId]);
    assert.equal(restaurantRow[0].is_open, 1, 'ресторан должен остаться открытым — есть ещё одно доступное блюдо');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// F. CSRF / auth / 404 / изоляция между ресторанами
// ===========================================================================

test('F1: маршруты меню требуют auth+CSRF; несуществующие категория/блюдо — 404', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_csrf_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'CSRF Menu Test', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');

    const noAuthRes = await fetch(`${base}${restaurantPath}/menu`, { redirect: 'manual' });
    assert.equal(noAuthRes.status, 302);

    const noCsrfRes = await postForm(base, cookie, `${restaurantPath}/menu/categories`, { name: 'Без CSRF' });
    assert.equal(noCsrfRes.status, 403);

    const notFoundCategory = await fetch(`${base}${restaurantPath}/menu/categories/999999/edit`, { headers: { Cookie: cookie } });
    assert.equal(notFoundCategory.status, 404);

    const notFoundItem = await fetch(`${base}${restaurantPath}/menu/items/999999`, { headers: { Cookie: cookie } });
    assert.equal(notFoundItem.status, 404);
  } finally {
    await stopApp(instance);
  }
});

test('F2: ресторан A не может редактировать/видеть категорию или блюдо ресторана B (подмена URL)', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_menu_isolation_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);

    const createA = await getPage(base, cookie, '/hq/restaurants/new');
    const resA = await postForm(base, cookie, '/hq/restaurants', { _csrf: createA.csrf, name: 'Ресторан A', cities: 'Грозный' });
    const pathA = resA.headers.get('location');

    const createB = await getPage(base, cookie, '/hq/restaurants/new');
    const resB = await postForm(base, cookie, '/hq/restaurants', { _csrf: createB.csrf, name: 'Ресторан B', cities: 'Грозный' });
    const pathB = resB.headers.get('location');

    const menuPageB = await getPage(base, cookie, `${pathB}/menu`);
    await postForm(base, cookie, `${pathB}/menu/categories`, { _csrf: menuPageB.csrf, name: 'Категория B' });
    const db = require('../../db/postgresql');
    const restaurantIdB = Number(pathB.split('/').pop());
    const catB = await db.query('SELECT id FROM categories WHERE restaurant_id = $1', [restaurantIdB]);

    // Подмена URL: открыть категорию B через путь ресторана A.
    const crossRes = await fetch(`${base}${pathA}/menu/categories/${catB[0].id}/edit`, { headers: { Cookie: cookie } });
    assert.equal(crossRes.status, 404, 'категория другого ресторана должна быть недоступна через подмену :id в URL');

    const itemFormB = await getPage(base, cookie, `${pathB}/menu/items/new`);
    await postForm(base, cookie, `${pathB}/menu/items`, { _csrf: itemFormB.csrf, name: 'Блюдо B', category_id: String(catB[0].id), price: '100' });
    const itemB = await db.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantIdB]);

    const crossItemRes = await fetch(`${base}${pathA}/menu/items/${itemB[0].id}`, { headers: { Cookie: cookie } });
    assert.equal(crossItemRes.status, 404, 'блюдо другого ресторана должно быть недоступно через подмену :id в URL');
  } finally {
    await stopApp(instance);
  }
});
