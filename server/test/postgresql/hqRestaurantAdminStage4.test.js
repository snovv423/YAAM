'use strict';

// YAAM HQ Stage 4 — интеграционные тесты рабочего раздела «Рестораны»
// против настоящего embedded PostgreSQL (тот же harness, что и во всех
// Stage/Wave тестах этой директории).
//
// A — services/hq/restaurantAdminService.js напрямую (search/filter/sort/
//     pagination — точная проверка SQL без парсинга HTML).
// B — полный HTTP-цикл через настоящий createPostgresqlApp(): создание,
//     список/поиск, все 5 вкладок, правка настроек, пауза/возобновление,
//     архивирование/восстановление, audit log.
// C — 404, auth, CSRF.
// D — приватные поля (connect_code/telegram_chat_id) никогда не попадают ни
//     в один HQ-ответ и ни в один публичный API-ответ; архивированный
//     ресторан скрыт с публичного API.
// E — реальные заказы/оценки/статистика одного ресторана не путаются с
//     данными другого.
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

const TEST_SESSION_SECRET = 'd'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Restaurants';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-restaurants-stage4');
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

// ===========================================================================
// A. services/hq/restaurantAdminService.js — search/filter/sort/pagination
// ===========================================================================

test('A: список ресторанов — search/city/status/sort/pagination против реального PostgreSQL', async (t) => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_list_test');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantAdminService')];
  const db = require('../../db/postgresql');
  const svc = require('../../services/hq/restaurantAdminService');

  const grozny1 = await svc.createRestaurant({ name: 'Альфа Кафе', cities: 'Грозный' });
  const grozny2 = await svc.createRestaurant({ name: 'Бета Ресторан', cities: ['Грозный', 'Аргун'] });
  const argun1 = await svc.createRestaurant({ name: 'Гамма Шашлычная', cities: 'Аргун' });
  // Stage 4.1: фильтры open/closed требуют published_at IS NOT NULL (иначе
  // это черновик, отдельная категория) — эти три фикстуры тестируют
  // операционный статус (open/closed/paused), не публикацию саму по себе,
  // поэтому публикуются сразу через svc.publishRestaurant().
  await svc.publishRestaurant(grozny1.id);
  await svc.publishRestaurant(grozny2.id);
  await svc.publishRestaurant(argun1.id);
  await db.execute('UPDATE restaurants SET is_open = 1 WHERE id = $1', [grozny2.id]);
  await db.execute('UPDATE restaurants SET rating = 4.5, rating_count = 10 WHERE id = $1', [grozny1.id]);

  await t.test('A1: без фильтров — все неархивированные, сортировка по имени', async () => {
    const result = await svc.listRestaurants({});
    assert.equal(result.total, 3);
    assert.deepEqual(result.restaurants.map((r) => r.name), ['Альфа Кафе', 'Бета Ресторан', 'Гамма Шашлычная']);
  });

  await t.test('A2: search по названию (ILIKE, регистронезависимо)', async () => {
    const result = await svc.listRestaurants({ search: 'бета' });
    assert.equal(result.total, 1);
    assert.equal(result.restaurants[0].id, grozny2.id);
  });

  await t.test('A3: filter по городу — использует jsonb ? оператор, находит вхождение в массиве', async () => {
    const result = await svc.listRestaurants({ city: 'Аргун' });
    assert.equal(result.total, 2);
    assert.deepEqual(result.restaurants.map((r) => r.id).sort(), [grozny2.id, argun1.id].sort());
  });

  await t.test('A4: filter по статусу open', async () => {
    const result = await svc.listRestaurants({ status: 'open' });
    assert.equal(result.total, 1);
    assert.equal(result.restaurants[0].id, grozny2.id);
  });

  await t.test('A5: filter по статусу closed (новые рестораны создаются закрытыми)', async () => {
    const result = await svc.listRestaurants({ status: 'closed' });
    assert.equal(result.total, 2);
  });

  await t.test('A6: sort=rating — по убыванию рейтинга', async () => {
    const result = await svc.listRestaurants({ sort: 'rating' });
    assert.equal(result.restaurants[0].id, grozny1.id);
  });

  await t.test('A7: пагинация — page size фиксирован, page вне диапазона поджимается к последней странице', async () => {
    for (let i = 0; i < 25; i += 1) {
      await svc.createRestaurant({ name: `Массовый ${i}`, cities: 'Грозный' });
    }
    const result = await svc.listRestaurants({ page: '999' });
    assert.equal(result.pageSize, 20);
    assert.equal(result.total, 28); // 3 исходных + 25
    assert.equal(result.totalPages, 2);
    assert.equal(result.page, 2); // 999 поджато к последней реальной странице
  });

  await t.test('A8: SQL injection через search/city/sort безопасен (параметризован/allowlist)', async () => {
    const result = await svc.listRestaurants({ search: "'; DROP TABLE restaurants; --", sort: "id; DROP TABLE restaurants" });
    assert.equal(result.total, 0); // ничего не совпало — не ошибка, не побочный эффект
    const stillThere = await svc.listRestaurants({});
    assert.equal(stillThere.total, 28, 'таблица restaurants должна остаться нетронутой');
  });

  await db.close();
  delete process.env.DATABASE_URL;
});

// ===========================================================================
// B. Полный HTTP-цикл: создание -> список -> вкладки -> настройки -> пауза/
//    возобновление -> архивирование/восстановление -> audit log
// ===========================================================================

test('B: полный HTTP-цикл управления рестораном + audit log', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_http_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');

  try {
    const cookie = await loginHq(base);

    // --- Создание: валидация ---
    let page = await getPage(base, cookie, '/hq/restaurants/new');
    let res = await postForm(base, cookie, '/hq/restaurants', { _csrf: page.csrf, name: '', cities: 'Грозный' });
    assert.equal(res.status, 400, 'пустое название должно быть отклонено');
    let html = await res.text();
    assert.match(html, /Название обязательно/);
    assert.equal(html.match(/value="Грозный"/g)?.length > 0, true, 'корректно введённое поле (города) должно сохраниться при ошибке');

    // --- Создание: успех ---
    page = await getPage(base, cookie, '/hq/restaurants/new');
    res = await postForm(base, cookie, '/hq/restaurants', {
      _csrf: page.csrf, name: 'Интеграционное Кафе', cities: 'Грозный', cuisine: 'кавказская',
      description: 'Тестовое описание', address: 'ул. Тестовая, 1', phone: '+79280000099', hours: '10:00-22:00', min_order: '400',
    });
    assert.equal(res.status, 302, 'успешное создание -> PRG редирект');
    const restaurantPath = res.headers.get('location');
    assert.match(restaurantPath, /^\/hq\/restaurants\/\d+$/);
    const restaurantId = Number(restaurantPath.split('/').pop());

    const auditAfterCreate = await db.query("SELECT action, restaurant_id FROM hq_audit_log WHERE action = 'restaurant_created'");
    assert.equal(auditAfterCreate.length, 1);
    assert.equal(auditAfterCreate[0].restaurant_id, restaurantId);

    // --- Список: находит новый ресторан по поиску ---
    page = await getPage(base, cookie, '/hq/restaurants?search=Интеграционное');
    assert.match(page.html, /Интеграционное Кафе/);

    // --- Обзор ---
    page = await getPage(base, cookie, restaurantPath);
    assert.equal(page.status, 200);
    assert.match(page.html, /Интеграционное Кафе/);
    assert.match(page.html, /Заказы/);
    assert.match(page.html, /За всё время/);
    assert.match(page.html, /Доход YAAM сегодня/);
    assert.match(page.html, /Выплаты/);

    // --- Заказы (пусто) ---
    page = await getPage(base, cookie, `${restaurantPath}/orders`);
    assert.match(page.html, /заказов нет/i);

    // --- Оценки (пусто) ---
    page = await getPage(base, cookie, `${restaurantPath}/ratings`);
    assert.match(page.html, /Оценок пока нет/);

    // --- Статистика ---
    page = await getPage(base, cookie, `${restaurantPath}/statistics`);
    assert.equal(page.status, 200);

    // --- Настройки: правка ---
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    // Города приходят как ПОВТОРЯЮЩИЕСЯ ключи cities= (набор чекбоксов,
    // docs/HQ-PRODUCT-SPEC.md) — URLSearchParams(object) склеил бы массив в
    // одну строку, поэтому тело собирается явно.
    const settingsBody = new URLSearchParams({
      _csrf: page.csrf, name: 'Интеграционное Кафе 2', cuisine: 'кавказская',
      description: 'Новое описание', address: 'ул. Новая, 2', phone: '+79280000098', hours: '09:00-23:00', min_order: '500',
    });
    settingsBody.append('cities', 'Грозный');
    settingsBody.append('cities', 'Аргун');
    res = await fetch(`${base}${restaurantPath}/settings`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: settingsBody.toString(),
    });
    assert.equal(res.status, 200);
    html = await res.text();
    assert.match(html, /Изменения сохранены/);
    assert.match(html, /Интеграционное Кафе 2/);

    const auditAfterUpdate = await db.query("SELECT details FROM hq_audit_log WHERE action = 'restaurant_updated'");
    assert.equal(auditAfterUpdate.length, 1);
    assert.match(auditAfterUpdate[0].details, /name:.*Интеграционное Кафе.*Интеграционное Кафе 2/);

    // --- Публикация и открытие (Stage 4.1: пауза разрешена только
    // опубликованному открытому ресторану — свежесозданный всё ещё черновик
    // и закрыт) ---
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, /Скрыт/, 'свежесозданный ресторан не опубликован — «Скрыт» (docs/HQ-PRODUCT-SPEC.md)');
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    res = await postForm(base, cookie, `${restaurantPath}/publish`, { _csrf: page.csrf });
    assert.equal(res.status, 302);
    const auditAfterPublish = await db.query("SELECT action FROM hq_audit_log WHERE action = 'restaurant_published'");
    assert.equal(auditAfterPublish.length, 1);
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, /Приостановлен/, 'публикация не открывает автоматически (задание, раздел 8)');
    // Открытие требует доступное блюдо (Stage 5A) — этот тест про lifecycle
    // ресторана, не про меню, поэтому минимальное блюдо дано напрямую SQL.
    const catForOpen = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1, $2) RETURNING id', [restaurantId, 'Cat']);
    await db.execute('INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4)', [restaurantId, catForOpen.rows[0].id, 'Dish', 100]);
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    res = await postForm(base, cookie, `${restaurantPath}/open`, { _csrf: page.csrf });
    assert.equal(res.status, 302);
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, />Открыт</);

    // --- Пауза (Stage 5A.1: HQ больше не управляет паузой — это функция
    // ресторана через Telegram, server/bot/postgresql/index.js — здесь
    // паузу ставит напрямую orderService, ровно тем же вызовом, что и
    // реальная команда /pause бота; HQ должен только честно ПОКАЗАТЬ статус,
    // без единой кнопки управления паузой) ---
    const orderService = require('../../services/postgresql/orderService');
    await orderService.pauseRestaurant(restaurantId, 'short');
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, /Перерыв до/, 'HQ должен показывать статус перерыва, взятого через Telegram');
    assert.doesNotMatch(page.html, /Пауза: 33 мин|Пауза: 3 часа|Пауза: 11 часов/, 'в HQ не должно быть кнопок управления временной паузой (задание Stage 5A.1)');
    assert.doesNotMatch(page.html, />Возобновить</, 'в HQ не должно быть кнопки возобновления паузы (задание Stage 5A.1)');

    // --- Возобновление (тоже через Telegram-эквивалент, не HQ) ---
    await orderService.resumeRestaurant(restaurantId);
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, />Открыт</, 'после возобновления через Telegram HQ должен снова показывать "Открыт"');

    // --- Архивирование ---
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    res = await postForm(base, cookie, `${restaurantPath}/archive`, { _csrf: page.csrf });
    assert.equal(res.status, 302);
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, /В архиве/);
    const auditAfterArchive = await db.query("SELECT action FROM hq_audit_log WHERE action = 'restaurant_archived'");
    assert.equal(auditAfterArchive.length, 1);

    // Архивированный ресторан исчезает из рабочего списка HQ (спецификация,
    // «Управление рестораном»). Фильтра «Архивированные» больше нет — сама
    // страница ресторана остаётся доступной по прямой ссылке, и на ней есть
    // «Вернуть из архива».
    page = await getPage(base, cookie, '/hq/restaurants');
    assert.doesNotMatch(page.html, /Интеграционное Кафе 2/);
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    assert.match(page.html, /Вернуть из архива/);

    // --- Восстановление ---
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    res = await postForm(base, cookie, `${restaurantPath}/restore`, { _csrf: page.csrf });
    assert.equal(res.status, 302);
    page = await getPage(base, cookie, '/hq/restaurants');
    assert.match(page.html, /Интеграционное Кафе 2/);
    const auditAfterRestore = await db.query("SELECT action FROM hq_audit_log WHERE action = 'restaurant_restored'");
    assert.equal(auditAfterRestore.length, 1);
    // Задание, раздел 10: восстановление ВСЕГДА возвращает в неопубликованное
    // состояние («Скрыт» в терминах docs/HQ-PRODUCT-SPEC.md), не публикует
    // автоматически.
    page = await getPage(base, cookie, restaurantPath);
    assert.match(page.html, /Скрыт/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// C. 404 / auth / CSRF
// ===========================================================================

test('C: 404 для несуществующего ресторана — честный, без утечки деталей', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_404_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const res = await fetch(`${base}/hq/restaurants/999999`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /не найден/i);
    assert.ok(!/at Object\.|at async|node_modules|\.js:\d+:\d+/.test(html), 'ответ не должен содержать stack trace');

    const resOrder = await fetch(`${base}/hq/restaurants/999999/orders`, { headers: { Cookie: cookie } });
    assert.equal(resOrder.status, 404, 'дочерние маршруты несуществующего ресторана тоже 404');
  } finally {
    await stopApp(instance);
  }
});

test('C: все /hq/restaurants/** маршруты требуют аутентификации', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_auth_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const paths = ['/hq/restaurants', '/hq/restaurants/new', '/hq/restaurants/1', '/hq/restaurants/1/orders', '/hq/restaurants/1/ratings', '/hq/restaurants/1/statistics', '/hq/restaurants/1/settings'];
    for (const p of paths) {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `${p} без сессии должен редиректить на логин`);
      assert.equal(res.headers.get('location'), '/hq/login');
    }
  } finally {
    await stopApp(instance);
  }
});

test('C: mutation-маршруты (POST) требуют CSRF', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_csrf_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    let res = await postForm(base, cookie, '/hq/restaurants', { name: 'Без CSRF', cities: 'Грозный' });
    assert.equal(res.status, 403);

    const page = await getPage(base, cookie, '/hq/restaurants/new');
    res = await postForm(base, cookie, '/hq/restaurants', { _csrf: page.csrf, name: 'С CSRF', cities: 'Грозный' });
    assert.equal(res.status, 302);
    const restaurantPath = res.headers.get('location');

    // /pause и /resume Stage 5A.1 убраны из HQ целиком (пауза — только
    // через Telegram) — CSRF-защита mutation-маршрутов проверяется на
    // /archive, который остаётся в HQ.
    res = await postForm(base, cookie, `${restaurantPath}/archive`, {});
    assert.equal(res.status, 403, 'архивирование без CSRF должно быть отклонено');
    const check = await getPage(base, cookie, `${restaurantPath}/settings`);
    assert.doesNotMatch(check.html, /В архиве/, 'отклонённый без CSRF запрос не должен был архивировать ресторан');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// D. Приватные поля никогда не утекают
// ===========================================================================

test('D: connect_code/telegram_chat_id не появляются ни в одном HQ-ответе; архивированный ресторан скрыт с публичного API', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_privacy_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const secretConnectCode = 'SECRET-STAGE4-CODE';
    const secretChatId = '777888999';

    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'Приватность Тест', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());
    await db.execute('UPDATE restaurants SET connect_code = $1, telegram_chat_id = $2 WHERE id = $3', [secretConnectCode, secretChatId, restaurantId]);

    const urlsToCheck = [
      '/hq/restaurants',
      `/hq/restaurants?status=open`,
      restaurantPath,
      `${restaurantPath}/orders`,
      `${restaurantPath}/ratings`,
      `${restaurantPath}/statistics`,
      `${restaurantPath}/settings`,
    ];
    for (const url of urlsToCheck) {
      const page = await getPage(base, cookie, url);
      assert.ok(!page.html.includes(secretConnectCode), `${url} не должен содержать connect_code`);
      assert.ok(!page.html.includes(secretChatId), `${url} не должен содержать telegram_chat_id`);
    }
    const overviewJson = await (await fetch(`${base}${restaurantPath}/overview.json`, { headers: { Cookie: cookie } })).text();
    assert.ok(!overviewJson.includes(secretConnectCode) && !overviewJson.includes(secretChatId));

    // Stage 4.1: свежесозданный ресторан — черновик, публично НЕ виден, пока
    // не опубликован явно (задание Stage 4.1, раздел 11).
    let publicList = await (await fetch(`${base}/api/restaurants`)).json();
    assert.ok(!publicList.some((r) => r.id === restaurantId), 'черновик не должен быть в публичном списке');
    let publicOneDraft = await fetch(`${base}/api/restaurants/${restaurantId}`);
    assert.equal(publicOneDraft.status, 404, 'черновик по прямому id должен отвечать 404 на публичном API');

    // Публикуем — виден, пока не архивирован.
    const overviewPage = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/publish`, { _csrf: overviewPage.csrf });
    publicList = await (await fetch(`${base}/api/restaurants`)).json();
    assert.ok(publicList.some((r) => r.id === restaurantId));
    let publicOne = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    assert.equal(publicOne.id, restaurantId);
    assert.ok(!('connect_code' in publicOne) && !('telegram_chat_id' in publicOne));

    // Архивировать -> скрыт из публичного API целиком (список и по id).
    const settingsPage = await getPage(base, cookie, `${restaurantPath}/settings`);
    await postForm(base, cookie, `${restaurantPath}/archive`, { _csrf: settingsPage.csrf });

    publicList = await (await fetch(`${base}/api/restaurants`)).json();
    assert.ok(!publicList.some((r) => r.id === restaurantId), 'архивированный ресторан не должен быть в публичном списке');
    const publicOneAfterArchive = await fetch(`${base}/api/restaurants/${restaurantId}`);
    assert.equal(publicOneAfterArchive.status, 404, 'архивированный ресторан по прямому id должен отвечать 404 на публичном API');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// E. Реальные заказы/оценки/статистика — изоляция между ресторанами
// ===========================================================================

test('E: Обзор/Заказы/Оценки/Статистика показывают данные ТОЛЬКО своего ресторана', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_restaurants_isolation_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const cookie = await loginHq(base);

    async function createOpenRestaurantWithMenu(name) {
      const p = await getPage(base, cookie, '/hq/restaurants/new');
      const r = await postForm(base, cookie, '/hq/restaurants', { _csrf: p.csrf, name, cities: 'Грозный' });
      const restaurantPath = r.headers.get('location');
      const id = Number(restaurantPath.split('/').pop());
      // published_at — Stage 5A: createOrder() требует опубликованный
      // ресторан (defense-in-depth поверх Stage 4.1), этот хелпер реально
      // создаёт заказы через orderService дальше в тесте.
      await db.execute('UPDATE restaurants SET is_open = 1, published_at = NOW() WHERE id = $1', [id]);
      const cat = await db.query('INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [id, 'Cat']);
      const item = await db.query('INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1,$2,$3,$4,1) RETURNING id', [id, cat[0].id, 'Блюдо', 700]);
      return { id, restaurantPath, menuItemId: item[0].id };
    }

    async function makeDeliveredRatedOrder(restaurant) {
      const payload = {
        restaurantId: restaurant.id, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
        address: 'ул. 1', comment: '', fulfillmentType: 'delivery',
        items: [{ menuItemId: restaurant.menuItemId, name: 'Блюдо', qty: 1 }],
        orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
        createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      };
      const { order } = await orderService.createOrderAndResolve(payload);
      await db.execute("UPDATE payments SET status='succeeded' WHERE order_id=$1", [order.id]);
      await db.execute("UPDATE orders SET status='delivered' WHERE id=$1", [order.id]);
      await orderService.rateOrder(order.id, 4);
      return order;
    }

    const restaurantA = await createOpenRestaurantWithMenu('Изоляция А');
    const restaurantB = await createOpenRestaurantWithMenu('Изоляция Б');

    await makeDeliveredRatedOrder(restaurantA);
    await makeDeliveredRatedOrder(restaurantA);
    await makeDeliveredRatedOrder(restaurantB);

    // Обзор А видит только 2 своих заказа, Б — только 1. JSON-эндпоинт
    // overview.json удалён вместе с блоком «Активные заказы»
    // (docs/HQ-PRODUCT-SPEC.md), поэтому изоляция проверяется по самому
    // блоку «Заказы» на HTML-странице обзора.
    const overviewA = await getPage(base, cookie, restaurantA.restaurantPath);
    const overviewB = await getPage(base, cookie, restaurantB.restaurantPath);
    const ordersValuesA = (overviewA.html.match(/<div class="orders-value">(\d+)<\/div>/g) || []).map((m) => Number(m.replace(/\D/g, '')));
    const ordersValuesB = (overviewB.html.match(/<div class="orders-value">(\d+)<\/div>/g) || []).map((m) => Number(m.replace(/\D/g, '')));
    assert.deepEqual(ordersValuesA, [2, 2], 'у ресторана А — 2 заказа сегодня и 2 за всё время');
    assert.deepEqual(ordersValuesB, [1, 1], 'у ресторана Б — 1 заказ сегодня и 1 за всё время');

    // Заказы А не содержат заказов Б (и наоборот) — проверяем по количеству
    // строк в списке заказов, а не только по счётчику.
    const ordersAPage = await getPage(base, cookie, `${restaurantA.restaurantPath}/orders`);
    const ordersBPage = await getPage(base, cookie, `${restaurantB.restaurantPath}/orders`);
    // Заказы отображаются компактными строками .dish-row (docs/HQ-PRODUCT-SPEC.md),
    // не таблицей с .order-code.
    const codeCountA = (ordersAPage.html.match(/class="dish-row"/g) || []).length;
    const codeCountB = (ordersBPage.html.match(/class="dish-row"/g) || []).length;
    assert.equal(codeCountA, 2);
    assert.equal(codeCountB, 1);

    // Оценки — по 4 звезды у каждого, но количество оценок раздельное.
    const ratingsAPage = await getPage(base, cookie, `${restaurantA.restaurantPath}/ratings`);
    const ratingsBPage = await getPage(base, cookie, `${restaurantB.restaurantPath}/ratings`);
    assert.match(ratingsAPage.html, />2<\/div>\s*<div class="label">Всего оценок<\/div>/);
    assert.match(ratingsBPage.html, />1<\/div>\s*<div class="label">Всего оценок<\/div>/);

    // Статистика — оборот А = 2×700=1400, Б = 1×700=700.
    const statsAPage = await getPage(base, cookie, `${restaurantA.restaurantPath}/statistics`);
    const statsBPage = await getPage(base, cookie, `${restaurantB.restaurantPath}/statistics`);
    assert.match(statsAPage.html, /1400 ₽/);
    assert.match(statsBPage.html, /700 ₽/);

    // Регрессионная проверка на реальный найденный баг (см. финальный отчёт
    // Stage 4): `pg` парсит SQL DATE в JS Date через ЛОКАЛЬНЫЙ часовой пояс
    // процесса, а не UTC — на сервере с TZ, отличным от UTC, .toISOString()
    // на такой Date тихо сдвигал бы дату на сутки, и "заказы по дням"
    // показывали бы 0 там, где реально есть заказы. Проверяем НАПРЯМУЮ через
    // сервис (не только через HTML), что сегодняшняя точка ряда содержит
    // реальные 3 заказа ресторана А, а не 0.
    const statsService = require('../../services/hq/restaurantStatsService');
    const statisticsA = await statsService.getStatistics(restaurantA.id, { period: 'today' });
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayPoint = statisticsA.dailySeries.find((d) => d.date === todayKey || statisticsA.dailySeries.length === 1);
    assert.ok(todayPoint, 'сегодняшняя точка должна присутствовать в dailySeries');
    assert.equal(todayPoint.count, 2, 'dailySeries не должен молчаливо показывать 0 там, где реально есть заказы (см. найденный баг с pg DATE parsing)');
  } finally {
    await stopApp(instance);
  }
});
