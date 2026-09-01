'use strict';

// YAAM HQ Stage 5B/5B.1 — интеграционные тесты медиа-системы против
// настоящего embedded PostgreSQL. Тот же harness-паттерн, что и
// hqMenuAdminStage5A.test.js (Stage 5A).
//
// M — идемпотентность повторного применения schema.sql (старые фотографии
//     переживают повторный apply, как и остальные Stage-additive колонки).
// A — upload metadata: реальная загрузка через photoService формирует
//     корректные width/height/storage_key/is_primary.
// B — ровно один primary на владельца (partial unique index), setPrimary
//     не может его нарушить.
// D — Stage 5B.1: удаление необратимо — DB-строка и объекты в хранилище
//     реально исчезают; удаление primary-фотографии авто-переносит флаг на
//     следующую по sort_order.
// E — ownership: блюдо из чужого ресторана недоступно ни сервису, ни HTTP.
// F — public API: primary_photo/gallery по HTTP, allowlist полей.
// G — storage failure: upload() провайдера падает — не остаётся ни файла,
//     ни строки в БД.
// H — DB failure после успешной загрузки в хранилище -> компенсирующее
//     удаление всех вариантов (no orphan objects).
// I — audit log: все 6 событий (Stage 5B.1: upload/primary/delete на
//     ресторан и на блюдо) реально пишутся с ожидаемым action.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

// Stage 5B.2 — этот список должен включать КАЖДЫЙ модуль, который где-либо
// делает `require('.../db/postgresql')`, а не только сами роутеры. Причина:
// db/postgresql/index.js — ленивый singleton (getPool()/close()), и любой
// сервисный модуль, загруженный ОДИН раз раньше в этом файле (например,
// когда предыдущий тест явно сделал delete require.cache для photoService.js
// и потребовал его заново — см. тесты A/B/D, G1, H1 ниже), навсегда
// закрепляет за собой ТУ версию db/postgresql, что была в кэше в момент его
// собственной загрузки — а не текущую. lifecycle.stop()/db.close() закрывает
// пул только ТОЙ версии db/postgresql, которую сам lifecycle.js захватил, а
// НЕ версии, захваченной другими сервисами. Без полного списка ниже
// startApp()-based тесты после теста, который явно пересобирал photoService
// (A/B/D, G1, H1), могли бы тихо писать в БД ПРЕДЫДУЩЕГО теста через
// оставшийся открытым чужой пул — что и происходило до этого исправления.
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

const TEST_SESSION_SECRET = 'e'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Media5B';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-media-stage5b');
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

async function startApp(databaseUrl, { mediaProvider = 'local', mediaLocalRoot } = {}) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  if (mediaProvider) process.env.MEDIA_PROVIDER = mediaProvider; else delete process.env.MEDIA_PROVIDER;
  // Stage 5B.2 — persistent-режим (MEDIA_LOCAL_ROOT), используется тестом
  // K1 ниже, чтобы проверить "restart backend не теряет фотографии" на
  // уровне настоящего HTTP-приложения, а не только самого провайдера.
  if (mediaLocalRoot) process.env.MEDIA_LOCAL_ROOT = mediaLocalRoot; else delete process.env.MEDIA_LOCAL_ROOT;
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
  delete process.env.MEDIA_PROVIDER;
  delete process.env.MEDIA_LOCAL_ROOT;
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
  return sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
}
async function uploadPhoto(base, cookie, uploadPath, csrf, { altText = '', color = { r: 100, g: 50, b: 200 } } = {}) {
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('alt_text', altText);
  form.append('photo', new Blob([await makeJpeg(color)], { type: 'image/jpeg' }), 'p.jpg');
  return fetch(`${base}${uploadPath}`, { method: 'POST', headers: { Cookie: cookie }, body: form, redirect: 'manual' });
}

async function setupPublishedRestaurantWithDish(base, cookie, { name }) {
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
    _csrf: itemPage.csrf, name: 'Тестовое блюдо', category_id: categoryId, price: '300',
  });
  const itemRows = await menuDb.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
  const itemId = itemRows[0].id;

  page = await getPage(base, cookie, restaurantPath);
  await postForm(base, cookie, `${restaurantPath}/open`, { _csrf: page.csrf });

  return { restaurantId, restaurantPath, itemId };
}

// ---------------------------------------------------------------------------
// M — идемпотентность повторного применения schema.sql
// ---------------------------------------------------------------------------
test('M1: повторное применение schema.sql не теряет уже существующие restaurant_photos/menu_item_photos', async () => {
  const databaseUrl = await freshDatabase('media_idempotent');
  const client = cluster.getClient('media_idempotent');
  await client.connect();
  try {
    const rest = await client.query("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    await client.query(
      'INSERT INTO restaurant_photos (restaurant_id, storage_key, width, height, is_primary) VALUES ($1,$2,$3,$4,$5)',
      [rest.rows[0].id, 'restaurants/1/abc', 800, 600, 1],
    );
    // Повторный apply — то же самое, что происходит при перезапуске
    // приложения на уже существующей (staging) БД.
    await client.query(SCHEMA_SQL);
    const rows = await client.query('SELECT * FROM restaurant_photos WHERE restaurant_id = $1', [rest.rows[0].id]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].storage_key, 'restaurants/1/abc');
  } finally {
    await client.end();
  }
  void databaseUrl;
});

// ---------------------------------------------------------------------------
// A/B/C/D — photoService напрямую (LocalMediaProvider, без HTTP)
// ---------------------------------------------------------------------------
test('A/B/D: upload metadata, primary invariant, permanent delete — через photoService', async () => {
  const databaseUrl = await freshDatabase('media_service_direct');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/media/photoService')];
  const db = require('../../db/postgresql');
  const photoService = require('../../services/hq/media/photoService');
  const { LocalMediaProvider } = require('../../services/hq/media/provider');
  const provider = new LocalMediaProvider();

  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('Media Direct','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;

    // A — upload metadata (включая непубличный master-вариант, Stage 5B.1)
    const photo1 = await photoService.uploadRestaurantPhoto(provider, restaurantId, await makeJpeg({ r: 10, g: 20, b: 30 }), 'Первое фото');
    assert.equal(photo1.is_primary, 1, 'первая загруженная фотография становится primary автоматически');
    assert.ok(photo1.storage_key.startsWith(`restaurants/${restaurantId}/`));
    assert.equal(photo1.width, 900);
    assert.equal(photo1.height, 600);
    assert.equal(photo1.alt_text, 'Первое фото');
    const masterBuf = await provider.readFileForTest(photoService.variantObjectKey(photo1.storage_key, 'master'));
    assert.ok(masterBuf.length > 0, 'master-вариант должен физически существовать в хранилище');
    assert.deepEqual(Object.keys(photoService.photoVariantUrls(provider, photo1)).sort(), ['card', 'full', 'thumb'], 'master не должен попадать в публичные URL');

    const photo2 = await photoService.uploadRestaurantPhoto(provider, restaurantId, await makeJpeg({ r: 40, g: 50, b: 60 }), '');
    assert.equal(photo2.is_primary, 0);

    // B — ровно один primary; setPrimary переносит флаг атомарно
    await photoService.setRestaurantPhotoPrimary(restaurantId, photo2.id);
    const afterSetPrimary = await photoService.listRestaurantPhotos(restaurantId);
    assert.equal(afterSetPrimary.filter((p) => p.is_primary === 1).length, 1);
    assert.equal(afterSetPrimary.find((p) => p.id === photo2.id).is_primary, 1);
    // DB-уровень: partial unique index физически не даёт вставить вторую
    // primary мимо сервисного слоя.
    await assert.rejects(() => db.execute(
      'INSERT INTO restaurant_photos (restaurant_id, storage_key, width, height, is_primary) VALUES ($1,$2,$3,$4,1)',
      [restaurantId, 'restaurants/x/manual-bypass', 10, 10],
    ));

    // D — удаление необратимо (Stage 5B.1): удаляем ТЕКУЩУЮ primary (photo2)
    // -> оставшаяся (photo1) должна быть авто-назначена primary, строка и
    // объекты в хранилище должны реально исчезнуть.
    const cardKey2 = photoService.variantObjectKey(photo2.storage_key, 'card');
    const deleted = await photoService.deleteRestaurantPhoto(restaurantId, photo2.id, provider);
    assert.equal(deleted.id, photo2.id);
    const afterDelete = await photoService.listRestaurantPhotos(restaurantId);
    assert.equal(afterDelete.length, 1, 'удалённая фотография должна физически исчезнуть из списка (hard delete, не soft)');
    assert.equal(afterDelete[0].id, photo1.id);
    assert.equal(afterDelete[0].is_primary, 1, 'оставшаяся фотография должна быть авто-назначена primary');
    await assert.rejects(() => provider.readFileForTest(cardKey2), 'объект удалённой фотографии должен физически исчезнуть из хранилища');

    // Повторное удаление того же (уже несуществующего) id — не ошибка, просто no-op.
    const secondDelete = await photoService.deleteRestaurantPhoto(restaurantId, photo2.id, provider);
    assert.equal(secondDelete, null);
  } finally {
    await provider.cleanup();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// E — ownership: блюдо из чужого ресторана недоступно
// ---------------------------------------------------------------------------
test('E1: menu_item_photos недоступны через чужой restaurantId — ни сервису, ни HTTP', async () => {
  const databaseUrl = await freshDatabase('media_ownership');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const restA = await setupPublishedRestaurantWithDish(base, cookie, { name: 'Ресторан А' });
    const restB = await setupPublishedRestaurantWithDish(base, cookie, { name: 'Ресторан Б' });

    const itemPage = await getPage(base, cookie, `${restA.restaurantPath}/menu/items/${restA.itemId}`);
    const uploadRes = await uploadPhoto(base, cookie, `${restA.restaurantPath}/menu/items/${restA.itemId}/photos`, itemPage.csrf, { altText: 'Фото А' });
    assert.equal(uploadRes.status, 302);

    // Тот же itemId, но чужой restaurantId в пути — 404 через router.param('itemId', ...).
    const crossRes = await fetch(`${base}/hq/restaurants/${restB.restaurantId}/menu/items/${restA.itemId}`, { headers: { Cookie: cookie } });
    assert.equal(crossRes.status, 404);

    // Прямой сервисный вызов с чужим restaurantId тоже отклоняется.
    delete require.cache[require.resolve('../../services/hq/media/photoService')];
    const photoService = require('../../services/hq/media/photoService');
    await assert.rejects(() => photoService.listMenuItemPhotos(restB.restaurantId, restA.itemId));
  } finally {
    await stopApp(instance);
  }
});

test('E2: rotation/crops persist per gallery media and primary switching does not move metadata', async () => {
  const databaseUrl = await freshDatabase('media_rotation_persistence');
  process.env.DATABASE_URL = databaseUrl;
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  const db = require('../../db/postgresql');
  const photoService = require('../../services/hq/media/photoService');
  try {
    const restaurant = (await db.execute("INSERT INTO restaurants (name, cities) VALUES ('Rotation','[]') RETURNING id")).rows[0];
    const category = (await db.execute("INSERT INTO categories (restaurant_id, name) VALUES ($1,'Основное') RETURNING id", [restaurant.id])).rows[0];
    const item = (await db.execute("INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,'Блюдо',500) RETURNING id", [restaurant.id, category.id])).rows[0];
    const first = (await db.execute("INSERT INTO menu_item_photos (menu_item_id,storage_key,width,height,is_primary) VALUES ($1,'menu-items/one',900,1600,1) RETURNING id", [item.id])).rows[0];
    const second = (await db.execute("INSERT INTO menu_item_photos (menu_item_id,storage_key,width,height,is_primary) VALUES ($1,'menu-items/two',900,1600,0) RETURNING id", [item.id])).rows[0];

    await photoService.updateMenuItemPhotoCrop(restaurant.id, item.id, first.id, 'menu_card', { x: 0, y: 0.2, width: 0.7, height: 0.3 }, 90);
    await photoService.updateMenuItemPhotoCrop(restaurant.id, item.id, first.id, 'dish_detail', { x: 0.1, y: 0, width: 0.9, height: 0.9 }, 90);
    await photoService.setMenuItemPhotoPrimary(restaurant.id, item.id, second.id);

    const reloaded = await photoService.listMenuItemPhotos(restaurant.id, item.id);
    const persistedFirst = reloaded.find((photo) => photo.id === first.id);
    const persistedSecond = reloaded.find((photo) => photo.id === second.id);
    assert.equal(persistedFirst.rotation_degrees, 90);
    assert.deepEqual(persistedFirst.menu_card_crop, { x: 0, y: 0.2, width: 0.7, height: 0.3 });
    assert.deepEqual(persistedFirst.dish_detail_crop, { x: 0.1, y: 0, width: 0.9, height: 0.9 });
    assert.equal(persistedFirst.is_primary, 0);
    assert.equal(persistedSecond.is_primary, 1);
    assert.equal(persistedSecond.rotation_degrees, 0);
    assert.equal(persistedSecond.menu_card_crop, null);
    assert.equal(persistedSecond.dish_detail_crop, null);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// F — public API
// ---------------------------------------------------------------------------
test('F1: публичный API отдаёт primary_photo/gallery без внутренних полей', async () => {
  const databaseUrl = await freshDatabase('media_public_api');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const rest = await setupPublishedRestaurantWithDish(base, cookie, { name: 'Публичный ресторан' });
    const settingsPage = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    await uploadPhoto(base, cookie, `${rest.restaurantPath}/photos`, settingsPage.csrf, { altText: 'Фасад', color: { r: 5, g: 200, b: 5 } });

    const listRes = await fetch(`${base}/api/restaurants`);
    const list = await listRes.json();
    const found = list.find((r) => r.id === rest.restaurantId);
    assert.ok(found.primary_photo);
    assert.equal(found.primary_photo.alt, 'Фасад');
    assert.equal(found.gallery.length, 1);
    assert.ok(!JSON.stringify(found).includes('storage_key'));
    assert.ok(!JSON.stringify(found).includes('archived_at'));

    const detailRes = await fetch(`${base}/api/restaurants/${rest.restaurantId}`);
    const detail = await detailRes.json();
    assert.ok(detail.primary_photo);
    assert.equal(detail.menu[0].items[0].primary_photo, null, 'у блюда без фото primary_photo=null, не падает');
    assert.deepEqual(detail.menu[0].items[0].gallery, []);
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// G/H — сбои хранилища и БД, компенсация (no orphan objects)
// ---------------------------------------------------------------------------
test('G1: upload() провайдера падает на втором варианте — уже загруженный вариант откатывается, строка в БД не создаётся', async () => {
  const databaseUrl = await freshDatabase('media_storage_failure');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/media/photoService')];
  const db = require('../../db/postgresql');
  const photoService = require('../../services/hq/media/photoService');
  const { LocalMediaProvider } = require('../../services/hq/media/provider');

  const real = new LocalMediaProvider();
  let uploadCount = 0;
  const deletedKeys = [];
  const flaky = {
    async upload(key, buf, ct) {
      uploadCount += 1;
      if (uploadCount === 2) throw new Error('simulated storage outage');
      return real.upload(key, buf, ct);
    },
    async delete(key) { deletedKeys.push(key); return real.delete(key); },
    getPublicUrl: (key) => real.getPublicUrl(key),
  };

  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('Storage Fail','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    const before = await db.query('SELECT COUNT(*)::int AS n FROM restaurant_photos');
    const sourceBuf = await makeJpeg({ r: 1, g: 1, b: 1 });
    await assert.rejects(() => photoService.uploadRestaurantPhoto(flaky, restaurantId, sourceBuf, ''));
    const after = await db.query('SELECT COUNT(*)::int AS n FROM restaurant_photos');
    assert.equal(after[0].n, before[0].n, 'ни одна строка не должна была появиться в БД');
    assert.equal(deletedKeys.length, 1, 'единственный успевший загрузиться вариант должен быть откачен');
  } finally {
    await real.cleanup();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('H1: DB-транзакция падает ПОСЛЕ успешной загрузки в хранилище — все варианты (включая master) удаляются компенсирующим действием (no orphan objects)', async () => {
  const databaseUrl = await freshDatabase('media_db_failure');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/media/photoService')];
  const db = require('../../db/postgresql');
  const photoService = require('../../services/hq/media/photoService');
  const { LocalMediaProvider } = require('../../services/hq/media/provider');
  const provider = new LocalMediaProvider();

  function countFiles(dir) {
    let n = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      n += entry.isDirectory() ? countFiles(p) : 1;
    }
    return n;
  }

  try {
    const before = countFiles(provider.baseDir);
    // Несуществующий restaurant_id -> FK violation при INSERT, ПОСЛЕ того,
    // как все WebP-варианты (включая master) уже успешно загружены в LocalMediaProvider.
    const sourceBuf = await makeJpeg({ r: 2, g: 2, b: 2 });
    await assert.rejects(() => photoService.uploadRestaurantPhoto(provider, 999999, sourceBuf, ''));
    const after = countFiles(provider.baseDir);
    assert.equal(after, before, 'после компенсации в хранилище не должно остаться orphan-файлов');
  } finally {
    await provider.cleanup();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// I — audit log: все 10 событий
// ---------------------------------------------------------------------------
test('I1: все 6 audit-событий (Stage 5B.1) реально пишутся с ожидаемым action', async () => {
  const databaseUrl = await freshDatabase('media_audit_log');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const rest = await setupPublishedRestaurantWithDish(base, cookie, { name: 'Audit Restaurant' });

    // restaurant_photo_uploaded ×2
    let page = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    await uploadPhoto(base, cookie, `${rest.restaurantPath}/photos`, page.csrf, { altText: 'Р1', color: { r: 9, g: 9, b: 9 } });
    page = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    await uploadPhoto(base, cookie, `${rest.restaurantPath}/photos`, page.csrf, { altText: 'Р2', color: { r: 8, g: 8, b: 8 } });

    page = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    const photoIdMatch = page.html.match(/\/photos\/(\d+)\/delete/);
    const photoId = photoIdMatch[1];

    // restaurant_photo_primary_changed
    await postForm(base, cookie, `${rest.restaurantPath}/photos/${photoId}/primary`, { _csrf: page.csrf });
    // restaurant_photo_deleted
    page = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    await postForm(base, cookie, `${rest.restaurantPath}/photos/${photoId}/delete`, { _csrf: page.csrf });

    // menu_item_photo_uploaded
    page = await getPage(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}`);
    await uploadPhoto(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}/photos`, page.csrf, { altText: 'Б1', color: { r: 7, g: 7, b: 7 } });
    page = await getPage(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}`);
    await uploadPhoto(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}/photos`, page.csrf, { altText: 'Б2', color: { r: 6, g: 6, b: 6 } });

    page = await getPage(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}`);
    const dishPhotoIdMatch = page.html.match(/\/photos\/(\d+)\/delete/);
    const dishPhotoId = dishPhotoIdMatch[1];

    // menu_item_photo_primary_changed
    await postForm(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}/photos/${dishPhotoId}/primary`, { _csrf: page.csrf });
    // menu_item_photo_deleted
    page = await getPage(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}`);
    await postForm(base, cookie, `${rest.restaurantPath}/menu/items/${rest.itemId}/photos/${dishPhotoId}/delete`, { _csrf: page.csrf });

    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id', [rest.restaurantId]);
    const actions = rows.map((r) => r.action);
    const expected = [
      'restaurant_photo_uploaded', 'restaurant_photo_primary_changed', 'restaurant_photo_deleted',
      'menu_item_photo_uploaded', 'menu_item_photo_primary_changed', 'menu_item_photo_deleted',
    ];
    for (const action of expected) {
      assert.ok(actions.includes(action), `ожидали событие "${action}" в audit log, получили: ${actions.join(', ')}`);
    }
    // Убраны вместе с самой функциональностью (Stage 5B.1), не просто
    // перестали вызываться — не должны появляться в CHECK/логе вовсе.
    for (const removed of ['restaurant_photo_moved', 'restaurant_photo_archived', 'restaurant_photo_restored', 'menu_item_photo_moved', 'menu_item_photo_archived', 'menu_item_photo_restored']) {
      assert.ok(!actions.includes(removed), `событие "${removed}" не должно существовать в Stage 5B.1`);
    }
    // Никаких секретов/URL/storage_key в details.
    const details = await db.query('SELECT details FROM hq_audit_log WHERE restaurant_id = $1 AND details IS NOT NULL', [rest.restaurantId]);
    for (const row of details) {
      assert.ok(!row.details.includes('local-media://'), 'details не должен содержать полный URL/endpoint хранилища');
      assert.ok(!/storage_key|bucket/i.test(row.details));
    }
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// K — Stage 5B.2: persistent-режим переживает restart backend, приватный
// master не проходит через /media-fixtures (только public/ смонтирован)
// ---------------------------------------------------------------------------
test('K1: persistent MEDIA_LOCAL_ROOT — restart backend (новый инстанс приложения над тем же каталогом) не теряет фотографии', async () => {
  const databaseUrl = await freshDatabase('media_persistent_restart');
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-persistent-test-'));
  try {
    const first = await startApp(databaseUrl, { mediaProvider: 'local', mediaLocalRoot: mediaRoot });
    let restaurantId;
    let storageKeyBase;
    try {
      const cookie = await loginHq(first.base);
      const rest = await setupPublishedRestaurantWithDish(first.base, cookie, { name: 'Persistent Restart' });
      restaurantId = rest.restaurantId;
      const settingsPage = await getPage(first.base, cookie, `${rest.restaurantPath}/settings`);
      await uploadPhoto(first.base, cookie, `${rest.restaurantPath}/photos`, settingsPage.csrf, { altText: 'Переживёт рестарт' });

      const db = require('../../db/postgresql');
      const rows = await db.query('SELECT storage_key FROM restaurant_photos WHERE restaurant_id = $1', [restaurantId]);
      storageKeyBase = rows[0].storage_key;
      // Сразу после загрузки — файлы физически на диске персистентного корня.
      assert.ok(fs.existsSync(path.join(mediaRoot, 'public', storageKeyBase, 'thumb.webp')));
      assert.ok(fs.existsSync(path.join(mediaRoot, 'private', 'masters', storageKeyBase, 'master.webp')));
    } finally {
      // "Restart" — останавливаем ИМЕННО этот инстанс приложения, каталог
      // MEDIA_LOCAL_ROOT НЕ удаляется (задание: "restart не удаляет файлы").
      await first.instance.stop();
    }

    const second = await startApp(databaseUrl, { mediaProvider: 'local', mediaLocalRoot: mediaRoot });
    try {
      // Новый процесс/новый provider-инстанс над тем же persistent root и
      // той же БД — фотография должна остаться полностью рабочей.
      const cookie = await loginHq(second.base);
      const settingsPage = await getPage(second.base, cookie, `/hq/restaurants/${restaurantId}/settings`);
      assert.ok(settingsPage.html.includes('class="photo-card is-primary"'), 'фотография должна остаться видна в HQ после restart');
      assert.ok(fs.existsSync(path.join(mediaRoot, 'public', storageKeyBase, 'card.webp')), 'файл должен физически пережить restart, не быть пересоздан/утерян');

      const publicRes = await fetch(`${second.base}/api/restaurants/${restaurantId}`);
      const publicJson = await publicRes.json();
      assert.equal(publicJson.primary_photo.alt, 'Переживёт рестарт');
    } finally {
      await stopApp(second.instance);
    }
  } finally {
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  }
});

test('L1: приватный master недоступен через /media-fixtures (смонтирован только public/) — 404, соответствующий public thumb — 200', async () => {
  const databaseUrl = await freshDatabase('media_private_not_served');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const rest = await setupPublishedRestaurantWithDish(base, cookie, { name: 'Private Master Restaurant' });
    const settingsPage = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    await uploadPhoto(base, cookie, `${rest.restaurantPath}/photos`, settingsPage.csrf, { altText: 'Проверка приватности' });

    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT storage_key FROM restaurant_photos WHERE restaurant_id = $1', [rest.restaurantId]);
    const storageKeyBase = rows[0].storage_key;

    const masterRes = await fetch(`${base}/media-fixtures/private/masters/${storageKeyBase}/master.webp`);
    assert.equal(masterRes.status, 404, 'private/masters/ не должен быть доступен даже при точном знании пути');

    // /media-fixtures монтирует ИМЕННО baseDir/public как корень — сам
    // objectKey уже включает "public/" (см. photoService.js:variantObjectKey),
    // а getPublicUrl() стрипает этот префикс при выводе URL (см.
    // provider.js) — поэтому реальный HTTP-путь к варианту НЕ повторяет
    // "public/" второй раз.
    const thumbRes = await fetch(`${base}/media-fixtures/${storageKeyBase}/thumb.webp`);
    assert.equal(thumbRes.status, 200, 'контраст: соответствующий публичный вариант должен быть доступен');
  } finally {
    await stopApp(instance);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed: MEDIA_PROVIDER не задан — раздел недоступен, остальной HQ жив
// ---------------------------------------------------------------------------
test('J1: без MEDIA_PROVIDER раздел «Фотографии» показывает честное сообщение, upload отклоняется, остальной HQ работает', async () => {
  const databaseUrl = await freshDatabase('media_disabled');
  const { instance, base } = await startApp(databaseUrl, { mediaProvider: null });
  try {
    const cookie = await loginHq(base);
    const rest = await setupPublishedRestaurantWithDish(base, cookie, { name: 'No Media Restaurant' });
    const page = await getPage(base, cookie, `${rest.restaurantPath}/settings`);
    assert.ok(page.html.includes('не настроено'));
    const uploadRes = await uploadPhoto(base, cookie, `${rest.restaurantPath}/photos`, page.csrf, {});
    assert.equal(uploadRes.status, 302);
    assert.ok(uploadRes.headers.get('location').includes('error='), 'upload без провайдера должен явно завершиться ошибкой, не тихо');
    // остальной HQ (не медиа) продолжает работать нормально
    const overview = await getPage(base, cookie, rest.restaurantPath);
    assert.equal(overview.status, 200);
  } finally {
    await stopApp(instance);
  }
});
