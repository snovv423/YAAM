'use strict';

// YAAM HQ Stage 35, раздел 2.2 — живая находка владельца: в карточке блюда
// показывалось поле ручного ввода «Ссылка на фото (необязательно)» —
// администратор не должен искать/вставлять URL картинки (задание, раздел 2).
// Фикс: server/hq/menuViews.js убрал видимый <label>/текстовое поле,
// заменив на <input type="hidden">, который молча переносит текущее
// значение photo_url при каждом сохранении формы — legacy-данные
// (задание: «не ломать уже существующие блюда, у которых photo_url
// заполнен старым способом») не теряются, просто больше не видны и не
// редактируемы вручную. Загрузка настоящего файла остаётся через
// renderPhotoManager (server/hq/photosViews.js) — не менялся.
//
// Тот же harness-паттерн (login/CSRF/postForm), что и
// hqMenuAdminStage5A.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

const TEST_SESSION_SECRET = 'e'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Photo35';

let cluster;
let TEST_HQ_PASSWORD_HASH;
let db;
let instance;
let base;
let cookie;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-menu-photourl-stage35');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);

  const dbName = 'yaam_hq_menu_photourl_stage35_test';
  await cluster.createDatabase(dbName);
  const setupClient = cluster.getClient(dbName);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(dbName);
  process.env.PAYMENT_PROVIDER = 'mock';
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  const appModule = require('../../services/postgresql/app.js');
  db = require('../../db/postgresql');
  instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const addr = instance.address();
  base = `http://127.0.0.1:${addr.port}`;

  const loginRes = await fetch(`${base}/hq/login`);
  const loginHtml = await loginRes.text();
  const loginCookie = cookieHeaderFrom(loginRes);
  const loginCsrf = extractCsrf(loginHtml);
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: loginCookie },
    body: new URLSearchParams({ _csrf: loginCsrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD }).toString(),
  });
  cookie = cookieHeaderFrom(postRes) || loginCookie;
});

after(async () => {
  await instance.stop();
  delete process.env.DATABASE_URL;
  await cluster.stop();
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

async function getPage(urlPath) {
  const res = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  return { res, html, status: res.status, csrf: html.includes('name="_csrf"') ? extractCsrf(html) : null };
}

async function postForm(urlPath, fields) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

async function setupRestaurantWithDish() {
  const createPage = await getPage('/hq/restaurants/new');
  const createRes = await postForm('/hq/restaurants', { _csrf: createPage.csrf, name: 'Тест-фото-35', cities: 'Грозный' });
  const restaurantPath = createRes.headers.get('location');
  const restaurantId = Number(restaurantPath.split('/').pop());

  const menuPage = await getPage(`${restaurantPath}/menu`);
  await postForm(`${restaurantPath}/menu/categories`, { _csrf: menuPage.csrf, name: 'Горячее' });
  const catRows = await db.query('SELECT id FROM categories WHERE restaurant_id = $1', [restaurantId]);
  const categoryId = catRows[0].id;

  const itemPage = await getPage(`${restaurantPath}/menu/items/new`);
  await postForm(`${restaurantPath}/menu/items`, {
    _csrf: itemPage.csrf, name: 'Шашлык', category_id: String(categoryId), price: '500',
  });
  const itemRows = await db.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
  const itemId = itemRows[0].id;

  return { restaurantPath, itemId };
}

test('Форма блюда больше не показывает видимое текстовое поле «Ссылка на фото»', async () => {
  const { restaurantPath, itemId } = await setupRestaurantWithDish();
  const page = await getPage(`${restaurantPath}/menu/items/${itemId}`);

  assert.equal(page.status, 200);
  assert.doesNotMatch(page.html, /Ссылка на фото/, 'видимая подпись поля не должна присутствовать в разметке');
  assert.doesNotMatch(
    page.html, /name="photo_url" type="text"/,
    'photo_url не должен рендериться как видимый текстовый input',
  );
  assert.match(page.html, /name="photo_url" type="hidden"/, 'photo_url обязан остаться в форме как hidden (переносит значение)');
});

test('Существующий legacy photo_url не стирается при сохранении формы без изменения фото', async () => {
  const { restaurantPath, itemId } = await setupRestaurantWithDish();
  const legacyUrl = 'https://example.com/legacy-dish-photo.jpg';
  await db.execute('UPDATE menu_items SET photo_url = $1 WHERE id = $2', [legacyUrl, itemId]);

  // Реальный браузер отправил бы ТЕКУЩЕЕ значение hidden-поля как есть —
  // здесь оно явно извлекается со страницы (та же техника, что extractCsrf),
  // а не берётся из переменной legacyUrl напрямую, чтобы тест проверял
  // именно то, что реально отрендерено в форме.
  const editPage = await getPage(`${restaurantPath}/menu/items/${itemId}`);
  const hiddenMatch = editPage.html.match(/name="photo_url" type="hidden" value="([^"]*)"/);
  assert.ok(hiddenMatch, 'hidden-поле photo_url не найдено в разметке');
  const hiddenValue = hiddenMatch[1];
  assert.equal(hiddenValue, legacyUrl, 'hidden-поле обязано содержать текущее значение photo_url без искажений');

  // Владелец меняет ТОЛЬКО цену — фотографии не касается вообще.
  const saveRes = await postForm(`${restaurantPath}/menu/items/${itemId}`, {
    _csrf: editPage.csrf,
    name: 'Шашлык', category_id: String((await db.query('SELECT category_id FROM menu_items WHERE id = $1', [itemId]))[0].category_id),
    price: '600',
    photo_url: hiddenValue,
  });
  assert.equal(saveRes.status, 302, 'сохранение формы обязано пройти успешно (redirect)');

  const after = await db.query('SELECT price, photo_url FROM menu_items WHERE id = $1', [itemId]);
  assert.equal(after[0].price, 600, 'цена обновилась');
  assert.equal(after[0].photo_url, legacyUrl, 'legacy photo_url НЕ должен быть стёрт сохранением формы, где поле скрыто');
});

test('Новое блюдо без photo_url сохраняется с пустым photo_url (hidden-поле не подставляет мусор)', async () => {
  const { restaurantPath, itemId } = await setupRestaurantWithDish();
  const row = await db.query('SELECT photo_url FROM menu_items WHERE id = $1', [itemId]);
  assert.equal(row[0].photo_url, '', 'новое блюдо без загруженного фото и без legacy-ссылки должно иметь пустой photo_url');
});
