'use strict';

// «Нет в наличии» и «Архивировать» — две разные операции над одним блюдом, и
// путать их нельзя:
//
//   наличие (is_available) — блюдо ОСТАЁТСЯ на сайте, серым и незаказываемым;
//                            тем же полем управляет Telegram /stoplist;
//   архив (archived_at)    — блюдо уходит и с сайта, и из рабочего меню HQ.
//
// Здесь это проверяется сквозным путём: HQ-кнопка, кнопка бота и публичный
// API смотрят на одно и то же состояние, а формулировки в HQ соответствуют
// смыслу поля.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { FakeTelegramBot } = require('./helpers/fakeTelegramBot');

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
  require.resolve('../../bot/postgresql/index.js'),
];

const TEST_SESSION_SECRET = 'a'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stock';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-menu-availability');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}
function cookieHeaderFrom(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return set.map((x) => x.split(';')[0]).join('; ');
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден');
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
  process.env.APP_ENV = 'local';
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  const appModule = require('../../services/postgresql/app.js');
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, base: `http://127.0.0.1:${port}` };
}
async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
}
async function loginHq(base) {
  const r = await fetch(`${base}/hq/login`);
  const html = await r.text();
  const cookie = cookieHeaderFrom(r);
  const post = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: extractCsrf(html), username: TEST_HQ_USER, password: TEST_HQ_PASSWORD }).toString(),
  });
  return cookieHeaderFrom(post) || cookie;
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

async function seed(db, { chatId }) {
  const r = await db.execute(
    `INSERT INTO restaurants (name, cities, connect_code, telegram_chat_id, published_at, is_open)
     VALUES ('Наличие', '["Грозный"]', 'stock-code', $1, NOW(), 1) RETURNING id`,
    [chatId],
  );
  const restaurantId = r.rows[0].id;
  const c = await db.execute(
    'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, $2, 1) RETURNING id',
    [restaurantId, 'Горячее'],
  );
  const categoryId = c.rows[0].id;
  const ids = {};
  for (const [key, name, order] of [['shashlyk', 'Шашлык', 1], ['lulya', 'Люля', 2]]) {
    const i = await db.execute(
      'INSERT INTO menu_items (restaurant_id, category_id, name, price, sort_order, is_available) VALUES ($1,$2,$3,500,$4,1) RETURNING id',
      [restaurantId, categoryId, name, order],
    );
    ids[key] = i.rows[0].id;
  }
  return { restaurantId, categoryId, ids };
}

const publicItem = (payload, name) => {
  for (const cat of payload.menu || []) {
    const found = (cat.items || []).find((i) => i.name === name);
    if (found) return found;
  }
  return null;
};

// ---------------------------------------------------------------------------

test('A: «Нет в наличии» из HQ — блюдо остаётся на сайте, но заказать его нельзя', async () => {
  const url = await freshDatabase('yaam_stock_a');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const { restaurantId, ids } = await seed(db, { chatId: 'chat-stock-a' });
    const itemPath = `/hq/restaurants/${restaurantId}/menu/items/${ids.shashlyk}`;

    // Подписи говорят про наличие, а не про витрину.
    let page = await getPage(base, cookie, itemPath);
    assert.match(page.html, /В наличии/);
    assert.match(page.html, />Нет в наличии</, 'у доступного блюда кнопка предлагает убрать его из наличия');
    assert.doesNotMatch(page.html, /витрин/i);

    // Убираем из наличия.
    let res = await postForm(base, cookie, `${itemPath}/available`, { _csrf: page.csrf, available: '0' });
    assert.equal(res.status, 302);
    assert.equal((await db.query('SELECT is_available FROM menu_items WHERE id = $1', [ids.shashlyk]))[0].is_available, 0);

    // Кнопка стала обратной, статус — «Нет в наличии».
    page = await getPage(base, cookie, itemPath);
    assert.match(page.html, />Вернуть в наличие</);
    const menuPage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
    assert.match(menuPage.html, /Нет в наличии/);
    assert.match(menuPage.html, /Шашлык/, 'блюдо остаётся в рабочем меню HQ');

    // Публичная карточка: блюдо ВИДНО, но помечено недоступным.
    const payload = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    const dish = publicItem(payload, 'Шашлык');
    assert.ok(dish, 'блюдо не должно исчезать с сайта');
    assert.equal(dish.is_available, 0, 'клиент видит его как недоступное');

    // Заказать его нельзя.
    const order = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId, city: 'Грозный', customerName: 'К', customerPhone: '+79280000001',
        address: 'ул. 1', fulfillmentType: 'delivery', items: [{ menuItemId: ids.shashlyk, qty: 1 }],
      }),
    });
    assert.ok(order.status >= 400, `заказ недоступного блюда должен отклоняться, получено ${order.status}`);

    // Возвращаем в наличие.
    page = await getPage(base, cookie, itemPath);
    res = await postForm(base, cookie, `${itemPath}/available`, { _csrf: page.csrf, available: '1' });
    assert.equal(res.status, 302);
    const back = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    assert.equal(publicItem(back, 'Шашлык').is_available, 1);
  } finally {
    await stopApp(instance);
  }
});

test('B: HQ и Telegram /stoplist переключают одно и то же состояние', async () => {
  const url = await freshDatabase('yaam_stock_b');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  const botModule = require('../../bot/postgresql/index.js');
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const cookie = await loginHq(base);
    const { restaurantId, ids } = await seed(db, { chatId: 'chat-stock-b' });
    const itemPath = `/hq/restaurants/${restaurantId}/menu/items/${ids.shashlyk}`;

    // 1. Ресторан убрал блюдо из наличия в Telegram — HQ видит то же самое.
    await fakeBot.triggerCallbackQuery({ id: '1', data: `toggle_item:${ids.shashlyk}`, chatId: 'chat-stock-b', messageId: 1 });
    assert.equal((await db.query('SELECT is_available FROM menu_items WHERE id = $1', [ids.shashlyk]))[0].is_available, 0);
    let page = await getPage(base, cookie, itemPath);
    assert.match(page.html, />Вернуть в наличие</, 'HQ сразу показывает состояние, выставленное из Telegram');
    const menuPage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
    assert.match(menuPage.html, /Нет в наличии/);

    // 2. Владелец вернул наличие из HQ — Telegram показывает то же самое.
    await postForm(base, cookie, `${itemPath}/available`, { _csrf: page.csrf, available: '1' });
    fakeBot.sentMessages.length = 0;
    await fakeBot.triggerText('chat-stock-b', '/stoplist');
    const keyboard = fakeBot.sentMessages[0].opts.reply_markup.inline_keyboard;
    const row = keyboard.find((r) => r[0].callback_data === `toggle_item:${ids.shashlyk}`);
    assert.ok(row, 'блюдо есть в стоп-листе');
    assert.match(row[0].text, /^✓ /, 'бот показывает блюдо как имеющееся в наличии');
  } finally {
    handlers.stop();
    await stopApp(instance);
  }
});

test('C: архив — отдельная операция: блюдо исчезает и с сайта, и из рабочего меню, и из стоп-листа', async () => {
  const url = await freshDatabase('yaam_stock_c');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  const botModule = require('../../bot/postgresql/index.js');
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const cookie = await loginHq(base);
    const { restaurantId, ids } = await seed(db, { chatId: 'chat-stock-c' });
    const itemPath = `/hq/restaurants/${restaurantId}/menu/items/${ids.shashlyk}`;

    const page = await getPage(base, cookie, itemPath);
    // Архивирование — своя кнопка, рядом с наличием, а не вместо него.
    assert.match(page.html, />Архивировать</);
    assert.match(page.html, />Нет в наличии</);
    await postForm(base, cookie, `${itemPath}/archive`, { _csrf: page.csrf });

    // Пропало из рабочего меню HQ, но лежит в архиве.
    const menuPage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu`);
    assert.doesNotMatch(menuPage.html, /Шашлык/);
    const archivePage = await getPage(base, cookie, `/hq/restaurants/${restaurantId}/menu/archive`);
    assert.match(archivePage.html, /Шашлык/);
    assert.match(archivePage.html, /Восстановить/);

    // Пропало с сайта совсем — в отличие от «нет в наличии».
    const payload = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    assert.equal(publicItem(payload, 'Шашлык'), null, 'архивированное блюдо не показывается клиенту вовсе');
    assert.ok(publicItem(payload, 'Люля'), 'соседнее блюдо на месте');

    // И из стоп-листа тоже — переключать наличие у архивированного нечего.
    await fakeBot.triggerText('chat-stock-c', '/stoplist');
    const keyboard = fakeBot.sentMessages[0].opts.reply_markup.inline_keyboard;
    assert.deepEqual(keyboard.map((r) => r[0].callback_data), [`toggle_item:${ids.lulya}`]);
  } finally {
    handlers.stop();
    await stopApp(instance);
  }
});
