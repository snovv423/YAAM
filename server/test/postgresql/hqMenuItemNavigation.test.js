'use strict';

// YAAM HQ — карточка блюда: фотографии выше формы + возврат «← Назад» ровно
// в то место меню, откуда владелец ушёл редактировать.
//
// Тот же harness, что и hqMenuArchiveDelete.test.js: настоящий embedded
// PostgreSQL, настоящий HTTP-цикл через createPostgresqlApp().
//
// A — порядок блоков на карточке блюда: заголовок, статус, ФОТОГРАФИИ, форма.
// B — «← Назад» несёт состояние навигации (?item=N#dish-N), и сервер по нему
//     раскрывает нужную категорию САМ, без участия клиентского скрипта.
// C — устойчивость ?item: мусор, чужое блюдо, архивированное блюдо не
//     раскрывают ничего и ничего не ломают.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

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

const TEST_SESSION_SECRET = 'c'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#ItemNav';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-menu-item-navigation');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const setupClient = cluster.getClient(name);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
  return cluster.connectionString(name);
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
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
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
  return { res, html, status: res.status };
}

// Какие категории пришли РАСКРЫТЫМИ с сервера.
function openCategoryIds(html) {
  return (html.match(/<details class="cat-block" data-category-id="(\d+)" open>/g) || [])
    .map((tag) => Number(/data-category-id="(\d+)"/.exec(tag)[1]));
}

async function seed(db, { name }) {
  const r = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ($1, '[]') RETURNING id`, [name]);
  const restaurantId = r.rows[0].id;
  const cats = {};
  for (const [key, label, order] of [['hot', 'Горячее', 1], ['salad', 'Салаты', 2], ['dessert', 'Десерты', 3]]) {
    const c = await db.execute(
      'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id',
      [restaurantId, label, order],
    );
    cats[key] = c.rows[0].id;
  }
  const items = {};
  for (const [key, label, categoryKey] of [['shashlyk', 'Шашлык', 'hot'], ['lulya', 'Люля', 'hot'], ['cesar', 'Цезарь', 'salad']]) {
    const i = await db.execute(
      'INSERT INTO menu_items (restaurant_id, category_id, name, price, sort_order) VALUES ($1,$2,$3,500,1) RETURNING id',
      [restaurantId, cats[categoryKey], label],
    );
    items[key] = i.rows[0].id;
  }
  return { restaurantId, cats, items };
}

// ===========================================================================
// A. Карточка блюда — фотографии выше формы
// ===========================================================================

test('A1: на карточке блюда «Фотографии блюда» стоят между заголовком и формой, а не под ней', async () => {
  const url = await freshDatabase('yaam_item_nav_a1');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, items } = await seed(db, { name: 'Порядок блоков' });
    const page = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/${items.shashlyk}`);
    assert.equal(page.status, 200);

    const at = (needle) => {
      const index = page.html.indexOf(needle);
      assert.notEqual(index, -1, `на странице нет «${needle}»`);
      return index;
    };
    const heading = at('<h2>Шашлык</h2>');
    // Строка статуса под заголовком осталась только у архивированного блюда:
    // наличие активного показывает переключатель, а не вторая подпись.
    const toggle = at('data-stock-toggle');
    const photos = at('Фотографии блюда');
    const nameField = at('id="if-name"');
    const priceField = at('id="if-price"');
    const saveButton = at('>Сохранить<');

    assert.ok(heading < photos, 'фотографии идут сразу после заголовка блюда');
    assert.ok(photos < toggle, 'переключатель наличия — в действиях под формой');
    assert.ok(photos < nameField, 'название формы — НИЖЕ фотографий');
    assert.ok(nameField < priceField && priceField < saveButton, 'форма осталась целой и в прежнем порядке');

    // Загрузка фотографий по-прежнему доступна с этой же страницы.
    assert.match(page.html, new RegExp(`action="/hq/restaurants/${restaurantId}/menu/items/${items.shashlyk}/photos"`));
  } finally {
    await stopApp(instance);
  }
});

test('A2: у нового блюда фотографий ещё нет — панель не показывается, возврат ведёт просто в меню', async () => {
  const url = await freshDatabase('yaam_item_nav_a2');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId } = await seed(db, { name: 'Новое блюдо' });
    const page = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu/items/new`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.html, /Фотографии блюда/);
    assert.match(page.html, new RegExp(`class="detail-back" href="/hq/restaurants/${restaurantId}/menu"`));
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// B. «← Назад» возвращает в то же место меню
// ===========================================================================

test('B1: «← Назад» несёт ?item=N#dish-N, и сервер по нему раскрывает ровно категорию этого блюда', async () => {
  const url = await freshDatabase('yaam_item_nav_b1');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, cats, items } = await seed(db, { name: 'Возврат' });
    const menuPath = `/hq/restaurants/${restaurantId}/menu`;

    // Меню без состояния — все категории свёрнуты, у строк есть якоря.
    const plain = await getPage(base, cookie, menuPath);
    assert.deepEqual(openCategoryIds(plain.html), [], 'по умолчанию ни одна категория не раскрыта');
    assert.match(plain.html, new RegExp(`<li class="dish-row" id="dish-${items.cesar}" data-item-id="${items.cesar}">`));
    assert.match(plain.html, new RegExp(`data-menu-screen="${restaurantId}"`));

    // Карточка блюда «Цезарь» (категория «Салаты»).
    const item = await getPage(base, cookie, `${menuPath}/items/${items.cesar}`);
    const backHref = (item.html.match(/class="detail-back" href="([^"]+)"/) || [])[1];
    assert.equal(backHref, `${menuPath}?item=${items.cesar}#dish-${items.cesar}`);

    // Переход по этой ссылке раскрывает ИМЕННО «Салаты» и только их.
    const returned = await getPage(base, cookie, `${menuPath}?item=${items.cesar}`);
    assert.equal(returned.status, 200);
    assert.deepEqual(openCategoryIds(returned.html), [cats.salad], 'раскрыта только категория вернувшегося блюда');
    assert.match(returned.html, new RegExp(`<li class="dish-row" id="dish-${items.cesar}"`), 'строка-цель на месте');

    // Другое блюдо — другая категория.
    const other = await getPage(base, cookie, `${menuPath}?item=${items.lulya}`);
    assert.deepEqual(openCategoryIds(other.html), [cats.hot]);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// C. Устойчивость ?item
// ===========================================================================

test('C1: мусорный, чужой и архивированный ?item ничего не раскрывают и ничего не ломают', async () => {
  const url = await freshDatabase('yaam_item_nav_c1');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const mine = await seed(db, { name: 'Свой' });
    const foreign = await seed(db, { name: 'Чужой' });
    const menuPath = `/hq/restaurants/${mine.restaurantId}/menu`;

    for (const raw of ['abc', '-1', '0', '99999999', '"><script>alert(1)</script>', String(foreign.items.cesar)]) {
      const page = await getPage(base, cookie, `${menuPath}?item=${encodeURIComponent(raw)}`);
      assert.equal(page.status, 200, `?item=${raw} должен отдавать обычную страницу меню`);
      assert.deepEqual(openCategoryIds(page.html), [], `?item=${raw} не должен ничего раскрывать`);
      assert.doesNotMatch(page.html, /<script>alert/, 'значение из адреса не попадает в разметку');
    }

    // Архивированное блюдо: его строки в рабочем меню нет, раскрывать нечего,
    // но страница обязана оставаться рабочей.
    await db.execute('UPDATE menu_items SET archived_at = NOW(), is_available = 0 WHERE id = $1', [mine.items.cesar]);
    const archived = await getPage(base, cookie, `${menuPath}?item=${mine.items.cesar}`);
    assert.equal(archived.status, 200);
    assert.deepEqual(openCategoryIds(archived.html), []);
    assert.doesNotMatch(archived.html, new RegExp(`id="dish-${mine.items.cesar}"`));
  } finally {
    await stopApp(instance);
  }
});
