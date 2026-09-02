'use strict';

// YAAM HQ — окончательное удаление из архива меню (кнопка «Удалить навсегда»
// рядом с «Восстановить»). Тот же harness-паттерн, что и
// hqMediaStage5B.test.js: настоящий embedded PostgreSQL, настоящий
// LocalMediaProvider, настоящий HTTP-цикл через createPostgresqlApp().
//
// A — сервис, блюдо: удаляется только архивированное; строка меню и все
//     метаданные фотографий исчезают; order_items ВЫЖИВАЕТ со своим снимком
//     name/price/qty и обнулённым menu_item_id (колонка nullable именно под
//     этот случай) — то есть история заказов не рвётся и FK не падает.
// B — сервис, категория: удаляется только архивированная и только когда
//     внутри нет НЕархивированных блюд; удаляется вместе со своими
//     архивированными блюдами; ссылка archived_with_category_id снимается
//     даже у блюда, которое уже восстановлено в ДРУГУЮ категорию (иначе
//     DELETE упал бы на FK без ON DELETE).
// C — медиа: файлы всех вариантов удалённого блюда физически исчезают из
//     хранилища (никакого мусора), включая приватный master.
// D — HTTP: архив показывает и блюда, и категории, у каждого «Восстановить»
//     и «Удалить навсегда»; подтверждение — data-confirm (CSP-safe), а не
//     инлайновый onsubmit; после удаления элемент исчезает и не возвращается
//     после повторной загрузки страницы; CSRF обязателен; чужой ресторан
//     недоступен; аудит пишет menu_item_deleted / category_deleted.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

// Полный список модулей, захватывающих db/postgresql — та же причина, что
// подробно описана в hqMediaStage5B.test.js.
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
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'd'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#ArchDel';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-menu-archive-delete');
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

function reloadHqModules() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
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
async function waitForAddress(instance, timeoutMs = 3000) {
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
  process.env.MEDIA_PROVIDER = 'local';
  process.env.APP_ENV = 'local';
  reloadHqModules();
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
  delete process.env.MEDIA_PROVIDER;
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
async function makeJpeg(color) {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg({ quality: 85 }).toBuffer();
}

// Ресторан + категория + блюдо напрямую в БД: этим тестам не нужен весь
// HQ-путь создания, важна только конечная форма данных.
async function seedRestaurant(db, { name = 'Тестовый' } = {}) {
  const r = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ($1, '[]') RETURNING id`, [name]);
  const restaurantId = r.rows[0].id;
  const c = await db.execute(
    `INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, 'Горячее', 1) RETURNING id`,
    [restaurantId],
  );
  return { restaurantId, categoryId: c.rows[0].id };
}
async function seedItem(db, restaurantId, categoryId, name, price = 500) {
  const rows = await db.execute(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, sort_order) VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [restaurantId, categoryId, name, price],
  );
  return rows.rows[0].id;
}
// Заказ со строкой, ссылающейся на блюдо — ровно та зависимость, из-за
// которой в этом разделе никогда не было физического DELETE.
async function seedOrderWithItem(db, restaurantId, menuItemId, { name, price, qty = 2 }) {
  const order = await db.execute(
    `INSERT INTO orders (restaurant_id, public_code, city, customer_name, customer_phone, address,
                         items_total, commission_amount, status)
     VALUES ($1, $2, 'Грозный', 'Клиент', '+79000000000', 'Адрес', $3, 0, 'delivered') RETURNING id`,
    [restaurantId, `T${Date.now() % 100000}-${menuItemId}`, price * qty],
  );
  const oi = await db.execute(
    'INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [order.rows[0].id, menuItemId, name, price, qty],
  );
  return { orderId: order.rows[0].id, orderItemId: oi.rows[0].id };
}

// ===========================================================================
// A. Сервис — блюдо
// ===========================================================================

test('A1: блюдо удаляется навсегда только из архива; история заказов выживает, FK не падает', async () => {
  const url = await freshDatabase('yaam_arch_del_a1');
  process.env.DATABASE_URL = url;
  reloadHqModules();
  const db = require('../../db/postgresql');
  const menuSvc = require('../../services/hq/menuAdminService');
  const { ValidationError } = require('../../services/hq/restaurantLifecycle');
  try {
    const { restaurantId, categoryId } = await seedRestaurant(db);
    const itemId = await seedItem(db, restaurantId, categoryId, 'Шашлык', 700);
    const { orderItemId } = await seedOrderWithItem(db, restaurantId, itemId, { name: 'Шашлык', price: 700, qty: 3 });

    // Активное блюдо удалить нельзя — сначала архив.
    await assert.rejects(
      () => menuSvc.deleteMenuItemPermanently(restaurantId, itemId),
      ValidationError,
      'неархивированное блюдо не должно удаляться',
    );
    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [itemId])).length, 1);

    await menuSvc.archiveMenuItem(restaurantId, itemId);
    const result = await menuSvc.deleteMenuItemPermanently(restaurantId, itemId);
    assert.ok(result, 'удаление должно вернуть результат');
    assert.equal(result.deletedItemsCount, 1);

    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [itemId])).length, 0, 'строка меню должна исчезнуть');

    const orderLine = (await db.query('SELECT * FROM order_items WHERE id = $1', [orderItemId]))[0];
    assert.ok(orderLine, 'строка заказа обязана пережить удаление блюда');
    assert.equal(orderLine.menu_item_id, null, 'ссылка на удалённое блюдо обнулена');
    assert.equal(orderLine.name, 'Шашлык', 'снимок названия в заказе сохранён');
    assert.equal(orderLine.price, 700, 'снимок цены в заказе сохранён');
    assert.equal(orderLine.qty, 3);

    // Повторный вызов на уже удалённом id — не ошибка, просто null.
    assert.equal(await menuSvc.deleteMenuItemPermanently(restaurantId, itemId), null);

    // Чужой ресторан не может удалить блюдо этого ресторана.
    const other = await seedRestaurant(db, { name: 'Чужой' });
    const foreignId = await seedItem(db, restaurantId, categoryId, 'Люля', 400);
    await menuSvc.archiveMenuItem(restaurantId, foreignId);
    assert.equal(await menuSvc.deleteMenuItemPermanently(other.restaurantId, foreignId), null, 'ownership обязан отсекать чужое блюдо');
    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [foreignId])).length, 1);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// B. Сервис — категория
// ===========================================================================

test('B1: категория удаляется только архивированная, только без активных блюд, и вместе со своими архивированными блюдами', async () => {
  const url = await freshDatabase('yaam_arch_del_b1');
  process.env.DATABASE_URL = url;
  reloadHqModules();
  const db = require('../../db/postgresql');
  const menuSvc = require('../../services/hq/menuAdminService');
  const { ValidationError } = require('../../services/hq/restaurantLifecycle');
  try {
    const { restaurantId, categoryId } = await seedRestaurant(db);
    const itemA = await seedItem(db, restaurantId, categoryId, 'Хинкали', 300);
    const itemB = await seedItem(db, restaurantId, categoryId, 'Хачапури', 350);
    const { orderItemId } = await seedOrderWithItem(db, restaurantId, itemA, { name: 'Хинкали', price: 300, qty: 4 });

    // Активную категорию удалить нельзя.
    await assert.rejects(() => menuSvc.deleteCategoryPermanently(restaurantId, categoryId), ValidationError);

    // Архивированная категория с НЕархивированным блюдом внутри (состояние,
    // достижимое только в обход UI) — тоже нельзя: это и есть защита от
    // сиротских блюд и поломанного рабочего меню.
    await db.execute('UPDATE categories SET archived_at = NOW() WHERE id = $1', [categoryId]);
    await assert.rejects(
      () => menuSvc.deleteCategoryPermanently(restaurantId, categoryId),
      (err) => err instanceof ValidationError && /неархивированные блюда/i.test(err.message),
      'категория с активными блюдами не должна удаляться',
    );
    assert.equal((await db.query('SELECT id FROM categories WHERE id = $1', [categoryId])).length, 1);

    // Нормальный путь: архивировать категорию вместе с блюдами, затем удалить.
    await db.execute('UPDATE categories SET archived_at = NULL WHERE id = $1', [categoryId]);
    await menuSvc.archiveCategoryWithItems(restaurantId, categoryId);

    // Одно из блюд владелец успел восстановить в ДРУГУЮ категорию — метка
    // archived_with_category_id при этом осталась указывать на удаляемую
    // категорию. Без явного снятия этой ссылки DELETE упал бы на FK.
    const other = await db.execute(
      `INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, 'Салаты', 2) RETURNING id`,
      [restaurantId],
    );
    const otherCategoryId = other.rows[0].id;
    await menuSvc.restoreMenuItemToCategory(restaurantId, itemB, otherCategoryId);
    const movedBefore = (await db.query('SELECT archived_with_category_id FROM menu_items WHERE id = $1', [itemB]))[0];
    assert.equal(movedBefore.archived_with_category_id, categoryId, 'предусловие теста: метка ещё указывает на удаляемую категорию');

    const result = await menuSvc.deleteCategoryPermanently(restaurantId, categoryId);
    assert.ok(result);
    assert.equal(result.deletedItemsCount, 1, 'вместе с категорией удаляется только оставшееся в ней блюдо');

    assert.equal((await db.query('SELECT id FROM categories WHERE id = $1', [categoryId])).length, 0, 'категория удалена');
    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [itemA])).length, 0, 'блюдо из категории удалено');

    const survivor = (await db.query('SELECT * FROM menu_items WHERE id = $1', [itemB]))[0];
    assert.ok(survivor, 'блюдо, восстановленное в другую категорию, не должно быть тронуто');
    assert.equal(survivor.category_id, otherCategoryId);
    assert.equal(survivor.archived_with_category_id, null, 'висячая ссылка на удалённую категорию снята');

    const orderLine = (await db.query('SELECT * FROM order_items WHERE id = $1', [orderItemId]))[0];
    assert.ok(orderLine, 'история заказа переживает удаление категории');
    assert.equal(orderLine.menu_item_id, null);
    assert.equal(orderLine.name, 'Хинкали');
    assert.equal(orderLine.price, 300);

    // Осиротевших строк не осталось ни в одной из связанных таблиц.
    const orphans = await db.query(`
      SELECT (SELECT COUNT(*)::int FROM menu_items WHERE category_id NOT IN (SELECT id FROM categories)) AS items,
             (SELECT COUNT(*)::int FROM menu_item_photos WHERE menu_item_id NOT IN (SELECT id FROM menu_items)) AS photos,
             (SELECT COUNT(*)::int FROM menu_items WHERE archived_with_category_id IS NOT NULL
                AND archived_with_category_id NOT IN (SELECT id FROM categories)) AS labels`);
    assert.deepEqual(
      { items: orphans[0].items, photos: orphans[0].photos, labels: orphans[0].labels },
      { items: 0, photos: 0, labels: 0 },
      'после удаления не должно остаться ни одной сиротской записи',
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// C. Медиа — без мусора в хранилище
// ===========================================================================

test('C1: удаление блюда стирает все варианты его фотографий из хранилища, включая приватный master', async () => {
  const url = await freshDatabase('yaam_arch_del_c1');
  process.env.DATABASE_URL = url;
  reloadHqModules();
  const db = require('../../db/postgresql');
  const menuSvc = require('../../services/hq/menuAdminService');
  const photoService = require('../../services/hq/media/photoService');
  const { LocalMediaProvider } = require('../../services/hq/media/provider');
  const provider = new LocalMediaProvider();
  try {
    const { restaurantId, categoryId } = await seedRestaurant(db);
    const itemId = await seedItem(db, restaurantId, categoryId, 'Пахлава', 250);
    const photo = await photoService.uploadMenuItemPhoto(provider, restaurantId, itemId, await makeJpeg({ r: 20, g: 120, b: 60 }), 'фото');
    const keys = ['thumb', 'card', 'full', 'master'].map((v) => photoService.variantObjectKey(photo.storage_key, v));
    for (const key of keys) {
      await provider.readFileForTest(key); // предусловие: все варианты на месте
    }

    await menuSvc.archiveMenuItem(restaurantId, itemId);
    const result = await menuSvc.deleteMenuItemPermanently(restaurantId, itemId);
    assert.deepEqual(result.storageKeys, [photo.storage_key]);
    await photoService.deleteStoredPhotoObjects(provider, result.storageKeys);

    assert.equal(
      (await db.query('SELECT id FROM menu_item_photos WHERE menu_item_id = $1', [itemId])).length, 0,
      'метаданные фотографий удалены вместе с блюдом',
    );
    for (const key of keys) {
      await assert.rejects(() => provider.readFileForTest(key), `объект ${key} должен физически исчезнуть`);
    }
  } finally {
    await provider.cleanup();
    await db.close();
  }
});

// ===========================================================================
// D. HTTP — экран архива
// ===========================================================================

test('D1: архив показывает блюда и категории с «Восстановить» и «Удалить навсегда»; удаление CSP-safe, необратимо и переживает reload', async () => {
  const url = await freshDatabase('yaam_arch_del_d1');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);

    const { restaurantId, categoryId } = await seedRestaurant(db, { name: 'Архивный' });
    const soloItem = await seedItem(db, restaurantId, categoryId, 'Одинокое блюдо', 100);
    const emptyCat = await db.execute(
      `INSERT INTO categories (restaurant_id, name, sort_order, archived_at) VALUES ($1, 'Пустая категория', 5, NOW()) RETURNING id`,
      [restaurantId],
    );
    const emptyCategoryId = emptyCat.rows[0].id;

    const restaurantPath = `/hq/restaurants/${restaurantId}`;
    const archivePath = `${restaurantPath}/menu/archive`;

    // Архивируем блюдо HQ-путём, чтобы оно попало в архив.
    let page = await getPage(base, cookie, `${restaurantPath}/menu/items/${soloItem}`);
    await postForm(base, cookie, `${restaurantPath}/menu/items/${soloItem}/archive`, { _csrf: page.csrf });

    page = await getPage(base, cookie, archivePath);
    assert.equal(page.status, 200);
    assert.match(page.html, /Одинокое блюдо/, 'архивированное блюдо видно в архиве');
    assert.match(page.html, /Пустая категория/, 'архивированная категория видна в архиве');
    assert.match(page.html, /Восстановить/, 'у элементов архива есть «Восстановить»');

    const deleteForms = page.html.match(/<form[^>]*\/delete"[\s\S]*?<\/form>/g) || [];
    assert.equal(deleteForms.length, 2, 'по одной форме удаления на блюдо и на категорию');
    for (const form of deleteForms) {
      assert.match(form, /data-confirm="/, 'подтверждение задаётся data-confirm');
      assert.match(form, /class="danger compact"/, 'кнопка удаления красная');
      assert.match(form, /Удалить навсегда/);
      assert.doesNotMatch(form, /onsubmit=/, 'инлайновый JS запрещён CSP страницы');
      assert.doesNotMatch(form, /onclick=/, 'инлайновый JS запрещён CSP страницы');
    }
    // Строгий CSP, при котором инлайновый обработчик и не мог бы сработать.
    assert.match(page.res.headers.get('content-security-policy') || '', /script-src 'self'/);

    // Без CSRF удаление не проходит.
    const noCsrf = await postForm(base, cookie, `${restaurantPath}/menu/items/${soloItem}/delete`, {});
    assert.equal(noCsrf.status, 403);
    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [soloItem])).length, 1);

    // Чужой ресторан -> 404, ничего не удалено.
    const foreign = await seedRestaurant(db, { name: 'Чужой' });
    const foreignRes = await postForm(base, cookie, `/hq/restaurants/${foreign.restaurantId}/menu/items/${soloItem}/delete`, { _csrf: page.csrf });
    assert.equal(foreignRes.status, 404);
    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [soloItem])).length, 1);

    // Удаление блюда.
    const delItem = await postForm(base, cookie, `${restaurantPath}/menu/items/${soloItem}/delete`, { _csrf: page.csrf });
    assert.equal(delItem.status, 302);
    assert.match(delItem.headers.get('location'), /\/menu\/archive\?notice=/);

    // Удаление категории.
    page = await getPage(base, cookie, archivePath);
    const delCat = await postForm(base, cookie, `${restaurantPath}/menu/categories/${emptyCategoryId}/delete`, { _csrf: page.csrf });
    assert.equal(delCat.status, 302);

    // Элементы исчезли и НЕ возвращаются после повторной загрузки страницы.
    const after = await getPage(base, cookie, archivePath);
    assert.doesNotMatch(after.html, /Одинокое блюдо/, 'удалённое блюдо не возвращается в архив');
    assert.doesNotMatch(after.html, /Пустая категория/, 'удалённая категория не возвращается в архив');
    assert.match(after.html, /Архив пуст/);
    assert.equal((await db.query('SELECT id FROM menu_items WHERE id = $1', [soloItem])).length, 0);
    assert.equal((await db.query('SELECT id FROM categories WHERE id = $1', [emptyCategoryId])).length, 0);

    const audit = await db.query(
      `SELECT action FROM hq_audit_log WHERE restaurant_id = $1 AND action IN ('menu_item_deleted','category_deleted') ORDER BY action`,
      [restaurantId],
    );
    assert.deepEqual(audit.map((r) => r.action), ['category_deleted', 'menu_item_deleted']);
  } finally {
    await stopApp(instance);
  }
});
