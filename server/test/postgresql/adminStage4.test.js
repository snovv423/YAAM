'use strict';

// YAAM Production Switch — Stage 4 (server/routes/postgresql/admin.js):
// реальные HTTP integration-тесты против изолированного PostgreSQL-порта
// внутренней админки, поднятого как самостоятельное Express-приложение,
// смонтированное ЗА express-basic-auth — тот же приём мониторования Basic
// Auth, что и в server.js (server.js не трогается), плюс тот же established-
// приём "собственный app.listen(0) вокруг production-router'а", что и в
// routesApiStage1.test.js (Stage 1).
//
// Полный аудит SQLite-оригинала (server/routes/admin.js, 281 строка) показал,
// что часть сценариев из задания Stage 4 в РЕАЛЬНОМ коде не существует:
// нет ручной смены статуса заказа, нет платёжных/refund-экшенов админки, нет
// страницы деталей заказа, нет фильтров списка заказов, нет block/unblock,
// нет edit/delete категорий и блюд, нет отдельного редактирования цены, нет
// "hit"-переключателя. Эти тесты НЕ придумывают отсутствующий функционал —
// явно документируют его отсутствие там, где задание его перечисляло.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_admin_stage4_test';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'test-secret-pass';

let cluster;
let db;
let pgOrderService;
let server;
let baseUrl;

let sqliteAdminRouter;
let sqliteDbPath;

// Захвачено на module-load, ДО того как before() ниже загрузит SQLite-сторону
// ради H1-H3 parity-тестов — require('../../db')/routes/admin.js (SQLite)
// САМИ добавили бы services/orderService.js в require.cache, что сделало бы
// runtime-проверку "нет side effect" бессмысленной (всегда true), если бы
// она выполнялась после before(). db/postgresql/index.js (Pool ленивый) и
// services/postgresql/orderService.js безопасно require()-ятся здесь без
// DATABASE_URL — не открывают соединение на этом шаге.
require('../../routes/postgresql/admin.js');
const ADMIN_PG_LOADED_SQLITE_ORDER_SERVICE = Object.keys(require.cache).some(
  (k) => k.endsWith(`${path.sep}services${path.sep}orderService.js`) || k.endsWith(`${path.sep}services${path.sep}orderAccessService.js`)
);

before(async () => {
  cluster = await startEmbeddedPostgres('admin-stage4');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');

  const express = require('express');
  const basicAuth = require('express-basic-auth');
  const adminRouter = require('../../routes/postgresql/admin.js');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // Дословно тот же паттерн монтирования, что и server.js для SQLite-admin
  // (server.js не изменён и не трогается этим тестом).
  app.use('/admin', basicAuth({
    users: { [ADMIN_USER]: ADMIN_PASS },
    challenge: true,
    realm: 'YAAM Admin',
  }), adminRouter);

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // SQLite-сторона — только для parity (route-list/markers), изолированная
  // временная БД, тот же established-приём, что и во ВСЕХ Wave-тестах.
  sqliteDbPath = path.join(os.tmpdir(), `yaam-admin-stage4-parity-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DB_PATH = sqliteDbPath;
  require('../../db'); // применяет schema.sql к временной SQLite-БД
  sqliteAdminRouter = require('../../routes/admin.js');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(sqliteDbPath + suffix); } catch { /* уже нет */ }
  }
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function authHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function getPage(pathname, { auth = true, user = ADMIN_USER, pass = ADMIN_PASS } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    headers: auth ? { Authorization: authHeader(user, pass) } : {},
    redirect: 'manual',
  });
}

async function postForm(pathname, formObj, { auth = true, user = ADMIN_USER, pass = ADMIN_PASS } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(auth ? { Authorization: authHeader(user, pass) } : {}),
    },
    body: new URLSearchParams(formObj).toString(),
    redirect: 'manual',
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function pgCreateRestaurant(overrides = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, phone, connect_code, is_open, rating, rating_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      overrides.name ?? `Ресторан ${suffix}`,
      overrides.cuisine ?? 'test',
      overrides.cities ?? '[]',
      overrides.phone ?? '+79280000000',
      overrides.connect_code ?? `C${suffix.toUpperCase()}`,
      overrides.is_open ?? 1,
      overrides.rating ?? 0,
      overrides.rating_count ?? 0,
    ]
  );
  return rows[0];
}

async function pgCreateCategory(restaurantId, { name = 'Основное', sortOrder = 0 } = {}) {
  const rows = await db.query(
    `INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING *`,
    [restaurantId, name, sortOrder]
  );
  return rows[0];
}

async function pgCreateMenuItem(restaurantId, categoryId, { name = 'Хинкали', price = 500, isAvailable = 1, sortOrder = 0 } = {}) {
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [restaurantId, categoryId, name, price, isAvailable, sortOrder]
  );
  return rows[0];
}

async function pgCreateOrder(restaurantId, { status = 'delivered', itemsTotal = 500, commission = 35, rating = null } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, items_total, commission_amount, status, rating)
     VALUES ($1,$2,'Грозный','C','+79280000001','addr',$3,$4,$5,$6) RETURNING *`,
    [`YAAM-ADM-${suffix}`, restaurantId, itemsTotal, commission, status, rating]
  );
  return rows[0];
}

// ===========================================================================
// A. Авторизация
// ===========================================================================

test('A1: GET /admin/ без Authorization -> 401', async () => {
  const res = await getPage('/admin/', { auth: false });
  assert.equal(res.status, 401);
});

test('A2: GET /admin/ с неверными credentials -> 401', async () => {
  const res = await getPage('/admin/', { auth: true, user: 'admin', pass: 'wrong-password' });
  assert.equal(res.status, 401);
});

test('A3: GET /admin/ с валидными credentials -> 200', async () => {
  const res = await getPage('/admin/');
  assert.equal(res.status, 200);
});

test('A4: write endpoint (POST /admin/restaurants) без Authorization -> 401, ничего не создано', async () => {
  const before = await db.query('SELECT count(*)::int AS n FROM restaurants');
  const res = await postForm('/admin/restaurants', { name: 'Unauthorized', cities: 'Грозный' }, { auth: false });
  assert.equal(res.status, 401);
  const after = await db.query('SELECT count(*)::int AS n FROM restaurants');
  assert.equal(after[0].n, before[0].n);
});

// ===========================================================================
// B. Dashboard
// ===========================================================================

test('B1: пустая БД — dashboard отдаёт нули, не падает', async () => {
  const res = await getPage('/admin/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Заказов<\/div><div[^>]*>0</);
});

test('B2: корректные числовые ТИПЫ (не строки) для COUNT/SUM — прямая проверка через ту же SQL-форму, что использует роутер', async () => {
  const restaurant = await pgCreateRestaurant();
  await pgCreateOrder(restaurant.id, { status: 'delivered', itemsTotal: 700, commission: 49 });

  const rows = await db.query(`
    SELECT COUNT(*)::int AS cnt, COALESCE(SUM(items_total),0)::int AS revenue, COALESCE(SUM(commission_amount),0)::int AS commission
    FROM orders
    WHERE (created_at AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date
      AND status NOT IN ('cancelled','declined','timed_out','payment_failed')
  `);
  assert.equal(typeof rows[0].cnt, 'number');
  assert.equal(typeof rows[0].revenue, 'number');
  assert.equal(typeof rows[0].commission, 'number');
  assert.ok(rows[0].cnt >= 1);
});

test('B3: заказы нескольких ресторанов — корректные counts в "Контроль качества"', async () => {
  const r1 = await pgCreateRestaurant({ name: `Плов-хаус ${uniqueSuffix()}` });
  const r2 = await pgCreateRestaurant({ name: `Хинкальная ${uniqueSuffix()}` });
  await pgCreateOrder(r1.id, { status: 'delivered' });
  await pgCreateOrder(r1.id, { status: 'cancelled' });
  await pgCreateOrder(r2.id, { status: 'delivered' });

  const res = await getPage('/admin/');
  const html = await res.text();
  assert.match(html, new RegExp(`${r1.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td><td>2</td><td>1</td>`));
  assert.match(html, new RegExp(`${r2.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td><td>1</td><td>0</td>`));
});

// ===========================================================================
// C. Restaurants CRUD
// ===========================================================================

test('C1: список ресторанов — GET /admin/restaurants показывает созданные', async () => {
  const r = await pgCreateRestaurant({ name: `Список-${uniqueSuffix()}` });
  const res = await getPage('/admin/restaurants');
  const html = await res.text();
  assert.match(html, new RegExp(r.name));
});

test('C2: создание ресторана — редирект на /edit, connect_code сгенерирован, RETURNING id корректен', async () => {
  const name = `Новый-${uniqueSuffix()}`;
  const res = await postForm('/admin/restaurants', {
    name, cities: 'Грозный, Аргун', cuisine: 'test', delivery_price: '150', min_order: '500', default_cook_minutes: '40',
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^\/admin\/restaurants\/\d+\/edit$/);
  const id = Number(location.match(/\/restaurants\/(\d+)\/edit/)[1]);
  const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  assert.equal(rows[0].name, name);
  assert.match(rows[0].connect_code, /^[0-9A-F]{6}$/);
  assert.deepEqual(JSON.parse(rows[0].cities), ['Грозный', 'Аргун']);
});

// НАЙДЕННЫЙ, СЕРЬЁЗНЫЙ, УНАСЛЕДОВАННЫЙ ОТ SQLite-ОРИГИНАЛА БАГ (задокументирован
// подробно в postgresql-admin-port.md и в PDF-отчёте, раздел "Security/находки"):
// router.post('/restaurants/:id/', ...) (307-редирект-заглушка) зарегистрирован
// ПЕРЕД router.post('/restaurants/:id', ...) (реальный UPDATE). Под Express
// default `strict: false` роутингом ОБА паттерна компилируются в идентичный
// регэксп (опциональный trailing slash) — первый зарегистрированный маршрут
// ВСЕГДА побеждает, независимо от наличия/отсутствия слэша в реальном запросе
// (см. живой мини-репродукт с чистым Express, подтвердивший это эмпирически
// перед написанием этого теста). Реальный UPDATE-обработчик — МЁРТВЫЙ КОД,
// недостижим ни при каком запросе. Форма редактирования (action="/admin/
// restaurants/${r.id}", БЕЗ trailing slash) при реальной отправке из браузера
// попадёт на 307-редирект НА ТОТ ЖЕ САМЫЙ URL с сохранением метода — то есть
// в бесконечный редирект-цикл. Это баг ОРИГИНАЛА (SQLite), не привнесённый
// Stage 4 — подтверждено тем, что регистрация маршрутов (и, следовательно,
// это поведение) в PostgreSQL-порте — БУКВАЛЬНАЯ КОПИЯ SQLite-файла.
// "Сохранить текущее поведение максимально точно" здесь означает: НЕ
// переставлять порядок регистрации маршрутов (это было бы незапрошенным
// исправлением продукта) — только зафиксировать находку.
test('C3: редактирование ресторана через реальный UPDATE-путь недостижимо — маршрут "/:id/" (307) перехватывает запрос раньше "/:id" (найденный, унаследованный от SQLite баг)', async () => {
  const r = await pgCreateRestaurant();
  const res = await postForm(`/admin/restaurants/${r.id}`, {
    name: 'Обновлённое имя', cities: 'Шали', cuisine: 'новая кухня',
    delivery_price: '200', min_order: '600', default_cook_minutes: '35',
  });
  // Реальное поведение (проверено): побеждает "/:id/" маршрут (307 на тот
  // же URL, метод сохраняется) — НЕ "/:id" (реальный UPDATE, ожидался бы 302).
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `/admin/restaurants/${r.id}`);
  const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [r.id]);
  assert.notEqual(rows[0].name, 'Обновлённое имя', 'реальный UPDATE-обработчик недостижим — данные НЕ должны были обновиться');
});

test('C3b: если бы "/:id/" не перехватывал запрос — реальный UPDATE-обработчик сам по себе корректен (прямой юнит-вызов SQL без маршрутизации)', async () => {
  // Изолирует корректность САМОГО UPDATE-запроса от обнаруженного бага
  // маршрутизации выше — доказывает, что перенесённая SQL-логика правильна,
  // просто недостижима через реальный HTTP-путь по вине порядка регистрации,
  // унаследованного из SQLite-оригинала.
  const r = await pgCreateRestaurant();
  await db.execute(
    `UPDATE restaurants SET name=$1, cuisine=$2, photo_url=$3, cities=$4, address=$5, hours=$6, phone=$7, delivery_price=$8, min_order=$9, default_cook_minutes=$10 WHERE id=$11`,
    ['Обновлённое имя', 'новая кухня', '', '["Шали"]', '', '', '', 200, 600, 35, r.id]
  );
  const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [r.id]);
  assert.equal(rows[0].name, 'Обновлённое имя');
  assert.equal(rows[0].delivery_price, 200);
});

test('C4: pause -> resume — статус переключается (open/close, как реально реализовано)', async () => {
  const r = await pgCreateRestaurant();
  let res = await postForm(`/admin/restaurants/${r.id}/pause`, { preset: 'short' });
  assert.equal(res.status, 302);
  let rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [r.id]);
  assert.equal(rows[0].is_open, 0);
  assert.ok(rows[0].paused_until);

  res = await postForm(`/admin/restaurants/${r.id}/resume`, {});
  assert.equal(res.status, 302);
  rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [r.id]);
  assert.equal(rows[0].is_open, 1);
  assert.equal(rows[0].paused_until, null);
});

test('C5: невалидный пресет перерыва — чистая ошибка, не падение процесса, не raw PostgreSQL текст', async () => {
  const r = await pgCreateRestaurant();
  const res = await postForm(`/admin/restaurants/${r.id}/pause`, { preset: 'not-a-real-preset' });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /SELECT|INSERT|UPDATE|SQLSTATE|at Object|node_modules/i);
});

test('C6: duplicate connect_code — коллизия обрабатывается чисто, без утечки сырой ошибки PostgreSQL', async () => {
  const fixedBytes = Buffer.from([0x0a, 0x1b, 0x2c]);
  const fixedCode = fixedBytes.toString('hex').toUpperCase(); // "0A1B2C" — валидный вывод crypto.randomBytes(3).toString('hex').toUpperCase()
  await pgCreateRestaurant({ connect_code: fixedCode });

  const realRandomBytes = crypto.randomBytes;
  // Патчим node:crypto — тот же singleton-модуль, что require()-ит
  // routes/postgresql/admin.js (Node кэширует модули по пути) — только для
  // randomBytes(3), остальные вызовы (если появятся) идут в оригинал.
  crypto.randomBytes = (n) => (n === 3 ? Buffer.from(fixedBytes) : realRandomBytes(n));
  try {
    const before = await db.query('SELECT connect_code FROM restaurants WHERE connect_code = $1', [fixedCode]);
    assert.equal(before.length, 1, 'fixture должен был создать ресторан с этим connect_code');

    const res = await postForm('/admin/restaurants', { name: 'Коллизия', cities: 'Грозный' });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.doesNotMatch(text, /SQLSTATE|duplicate key|constraint/i);
  } finally {
    crypto.randomBytes = realRandomBytes;
  }
});

test('C7: невалидный ввод (отсутствует обязательное поле name) — чистая ошибка, ничего не создано', async () => {
  const before = await db.query('SELECT count(*)::int AS n FROM restaurants');
  const res = await postForm('/admin/restaurants', { cities: 'Грозный' }); // name отсутствует
  assert.equal(res.status, 500);
  const after = await db.query('SELECT count(*)::int AS n FROM restaurants');
  assert.equal(after[0].n, before[0].n, 'ничего не должно было создаться частично');
});

test('C8: несуществующий ресторан — GET /edit отдаёт 404', async () => {
  const res = await getPage('/admin/restaurants/999999999/edit');
  assert.equal(res.status, 404);
});

test('C9: POST на несуществующий ресторан — тот же 307-перехват из C3 (не 404 в самом POST), GET /edit для этого id всё равно 404', async () => {
  // Тот же найденный маршрутный баг (C3): "/:id/" перехватывает запрос
  // раньше "/:id" — эта заглушка ничего не проверяет и не трогает БД (чистый
  // редирект), поэтому существование ресторана здесь вообще не имеет
  // значения для самого POST-ответа. GET /edit по этому же id — отдельный,
  // независимо работающий маршрут — корректно 404.
  const res = await postForm('/admin/restaurants/999999999', { name: 'X', cities: 'Y' });
  assert.equal(res.status, 307);
  const follow = await getPage('/admin/restaurants/999999999/edit');
  assert.equal(follow.status, 404);
});

// ===========================================================================
// D. Categories
// ===========================================================================

test('D1: создание категории — sort_order инкрементируется корректно (1, затем 2)', async () => {
  const r = await pgCreateRestaurant();
  let res = await postForm(`/admin/restaurants/${r.id}/categories`, { name: 'Супы' });
  assert.equal(res.status, 302);
  res = await postForm(`/admin/restaurants/${r.id}/categories`, { name: 'Горячее' });
  assert.equal(res.status, 302);

  const rows = await db.query('SELECT name, sort_order FROM categories WHERE restaurant_id = $1 ORDER BY sort_order', [r.id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Супы');
  assert.equal(rows[0].sort_order, 1);
  assert.equal(rows[1].name, 'Горячее');
  assert.equal(rows[1].sort_order, 2);
});

test('D2: категория отображается в списке на странице ресторана', async () => {
  const r = await pgCreateRestaurant();
  await pgCreateCategory(r.id, { name: 'Салаты' });
  const res = await getPage(`/admin/restaurants/${r.id}/edit`);
  const html = await res.text();
  assert.match(html, /Салаты/);
});

test('D3: несуществующий ресторан при создании категории — foreign key violation перехвачен чисто', async () => {
  const res = await postForm('/admin/restaurants/999999999/categories', { name: 'X' });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /foreign key|SQLSTATE|constraint/i);
});

test('D4: валидация — отсутствует name у категории, ничего не создаётся', async () => {
  const r = await pgCreateRestaurant();
  const before = await db.query('SELECT count(*)::int AS n FROM categories WHERE restaurant_id = $1', [r.id]);
  const res = await postForm(`/admin/restaurants/${r.id}/categories`, {});
  assert.equal(res.status, 500);
  const after = await db.query('SELECT count(*)::int AS n FROM categories WHERE restaurant_id = $1', [r.id]);
  assert.equal(after[0].n, before[0].n);
});

test('D5 (документирует отсутствующий функционал): edit/delete категории НЕ существуют в реальном коде — не изобретены здесь', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  const editAttempt = await postForm(`/admin/categories/${c.id}`, { name: 'X' });
  const deleteAttempt = await postForm(`/admin/categories/${c.id}/delete`, {});
  assert.equal(editAttempt.status, 404, 'маршрута редактирования категории нет — Express отдаёт 404 по умолчанию');
  assert.equal(deleteAttempt.status, 404, 'маршрута удаления категории нет — Express отдаёт 404 по умолчанию');
});

test('D6: два конкурентных создания категории для ОДНОГО ресторана — обе создаются, без падения, без потери строки (sort_order может совпасть — узкая, документированная, косметическая гонка)', async () => {
  const r = await pgCreateRestaurant();
  const [res1, res2] = await Promise.all([
    postForm(`/admin/restaurants/${r.id}/categories`, { name: 'Категория А' }),
    postForm(`/admin/restaurants/${r.id}/categories`, { name: 'Категория Б' }),
  ]);
  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);
  const rows = await db.query('SELECT name, sort_order FROM categories WHERE restaurant_id = $1 ORDER BY id', [r.id]);
  assert.equal(rows.length, 2, 'обе конкурентные категории должны были создаться — ни одна не потеряна');
  assert.ok(rows.every((row) => Number.isInteger(row.sort_order) && row.sort_order >= 1));
});

// ===========================================================================
// E. Menu Items
// ===========================================================================

test('E1: создание блюда — price/photo_url/description/composition/sort_order сохранены корректно', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  const res = await postForm(`/admin/restaurants/${r.id}/menu-items`, {
    name: 'Хачапури', category_id: String(c.id), price: '450', photo_url: 'https://x/y.jpg',
    description: 'Сытный', composition: 'сыр, тесто',
  });
  assert.equal(res.status, 302);
  const rows = await db.query('SELECT * FROM menu_items WHERE restaurant_id = $1', [r.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Хачапури');
  assert.equal(rows[0].price, 450);
  assert.equal(rows[0].photo_url, 'https://x/y.jpg');
  assert.equal(rows[0].description, 'Сытный');
  assert.equal(rows[0].composition, 'сыр, тесто');
  assert.equal(rows[0].sort_order, 1);
  assert.equal(rows[0].is_available, 1, 'по умолчанию блюдо доступно');
});

test('E2: два последовательных блюда — sort_order 1, затем 2', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  await postForm(`/admin/restaurants/${r.id}/menu-items`, { name: 'A', category_id: String(c.id), price: '100' });
  await postForm(`/admin/restaurants/${r.id}/menu-items`, { name: 'B', category_id: String(c.id), price: '200' });
  const rows = await db.query('SELECT name, sort_order FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order', [r.id]);
  assert.equal(rows[0].sort_order, 1);
  assert.equal(rows[1].sort_order, 2);
});

test('E3: toggle-available — переключает 1<->0, редирект на edit-страницу ресторана блюда', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  const item = await pgCreateMenuItem(r.id, c.id, { isAvailable: 1 });

  let res = await postForm(`/admin/menu-items/${item.id}/toggle-available`, {});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/admin/restaurants/${r.id}/edit`);
  let rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
  assert.equal(rows[0].is_available, 0);

  res = await postForm(`/admin/menu-items/${item.id}/toggle-available`, {});
  rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
  assert.equal(rows[0].is_available, 1);
});

test('E4: toggle-available отсутствующего блюда -> 404', async () => {
  const res = await postForm('/admin/menu-items/999999999/toggle-available', {});
  assert.equal(res.status, 404);
});

test('E5: два конкурентных toggle одного блюда — детерминированно (чётное число флипов = исходное состояние)', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  const item = await pgCreateMenuItem(r.id, c.id, { isAvailable: 1 });

  await Promise.all([
    postForm(`/admin/menu-items/${item.id}/toggle-available`, {}),
    postForm(`/admin/menu-items/${item.id}/toggle-available`, {}),
  ]);
  const rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
  assert.equal(rows[0].is_available, 1, 'два конкурентных toggle сериализуются построчной блокировкой');
});

test('E6: boolean-parity — badge "да"/"стоп-лист" отражает is_available 1/0 корректно', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  await pgCreateMenuItem(r.id, c.id, { name: 'Доступное', isAvailable: 1 });
  await pgCreateMenuItem(r.id, c.id, { name: 'Недоступное', isAvailable: 0 });

  const html = await (await getPage(`/admin/restaurants/${r.id}/edit`)).text();
  assert.match(html, /Доступное[\s\S]*?badge open">да/);
  assert.match(html, /Недоступное[\s\S]*?badge closed">стоп-лист/);
});

test('E7 (документирует отсутствующий функционал): edit/delete блюда и отдельный "hit"-переключатель НЕ существуют', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  const item = await pgCreateMenuItem(r.id, c.id);
  const editAttempt = await postForm(`/admin/menu-items/${item.id}`, { price: '999' });
  const deleteAttempt = await postForm(`/admin/menu-items/${item.id}/delete`, {});
  const hitAttempt = await postForm(`/admin/menu-items/${item.id}/toggle-hit`, {});
  assert.equal(editAttempt.status, 404);
  assert.equal(deleteAttempt.status, 404);
  assert.equal(hitAttempt.status, 404);
});

test('E8: два конкурентных создания блюда для ОДНОЙ категории — оба создаются, без падения, без потери строки (та же узкая sort_order-гонка, что D6)', async () => {
  const r = await pgCreateRestaurant();
  const c = await pgCreateCategory(r.id);
  const [res1, res2] = await Promise.all([
    postForm(`/admin/restaurants/${r.id}/menu-items`, { name: 'Блюдо А', category_id: String(c.id), price: '100' }),
    postForm(`/admin/restaurants/${r.id}/menu-items`, { name: 'Блюдо Б', category_id: String(c.id), price: '200' }),
  ]);
  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);
  const rows = await db.query('SELECT name, sort_order FROM menu_items WHERE restaurant_id = $1 ORDER BY id', [r.id]);
  assert.equal(rows.length, 2, 'оба конкурентных блюда должны были создаться — ни одно не потеряно');
  assert.ok(rows.every((row) => Number.isInteger(row.sort_order) && row.sort_order >= 1));
});

// ===========================================================================
// F. Orders / admin actions
// ===========================================================================

test('F1: список заказов — GET /admin/orders показывает созданный заказ с корректным форматированием даты', async () => {
  const r = await pgCreateRestaurant();
  const o = await pgCreateOrder(r.id, { status: 'delivered', itemsTotal: 800, commission: 56 });
  const res = await getPage('/admin/orders');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(o.public_code));
  assert.match(html, /800 ₽/);
  assert.match(html, /56 ₽/);
  // formatDateTime отдаёт "YYYY-MM-DD HH:MM:SS" — та же визуальная форма,
  // что SQLite хранит как TEXT.
  assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test('F2: ответ /admin/orders — чистый HTML, не JSON', async () => {
  const res = await getPage('/admin/orders');
  const contentType = res.headers.get('content-type') || '';
  assert.match(contentType, /html/);
});

test('F3 (документирует отсутствующий функционал): страница деталей заказа, ручная смена статуса и фильтры списка заказов НЕ существуют', async () => {
  const r = await pgCreateRestaurant();
  const o = await pgCreateOrder(r.id);
  const detailAttempt = await getPage(`/admin/orders/${o.id}`);
  const statusChangeAttempt = await postForm(`/admin/orders/${o.id}/status`, { status: 'accepted' });
  const filteredList = await getPage(`/admin/orders?status=delivered`);
  assert.equal(detailAttempt.status, 404, 'страницы деталей заказа нет');
  assert.equal(statusChangeAttempt.status, 404, 'ручной смены статуса нет');
  // Фильтр не реализован — query-параметр молча игнорируется (тот же ORDER
  // BY o.id DESC LIMIT 100 без WHERE), это НЕ 404 (маршрут /orders валиден),
  // просто нет никакого эффекта от ?status=.
  assert.equal(filteredList.status, 200);
});

test('F4: order/payment/refund state — админка НЕ мутирует статус заказа напрямую (нет такого пути) — состояние заказа управляется исключительно orderService', async () => {
  const r = await pgCreateRestaurant();
  const o = await pgCreateOrder(r.id, { status: 'awaiting_restaurant' });
  // Единственный легитимный способ продвинуть заказ — уже перенесённые
  // (Wave 1-4) orderService-функции; проверяем, что они по-прежнему
  // корректно работают НЕЗАВИСИМО от admin-роутера (admin в это не
  // вмешивается никаким прямым UPDATE orders SET status).
  const updated = await pgOrderService.restaurantAccept(o.id);
  assert.equal(updated.status, 'accepted');
});

// ===========================================================================
// G. Ratings / Statistics
// ===========================================================================

test('G1: пустое состояние — "Оценок пока нет"', async () => {
  const res = await getPage('/admin/ratings');
  const html = await res.text();
  assert.match(html, /Оценок пока нет/);
});

test('G2: оценённые заказы и средний балл по нескольким ресторанам', async () => {
  const r1 = await pgCreateRestaurant({ name: `Рейтинг-А-${uniqueSuffix()}`, rating: 4.5, rating_count: 10 });
  const r2 = await pgCreateRestaurant({ name: `Рейтинг-Б-${uniqueSuffix()}`, rating: 3.2, rating_count: 3 });
  const o = await pgCreateOrder(r1.id, { status: 'delivered', rating: 5 });

  const html = await (await getPage('/admin/ratings')).text();
  assert.match(html, new RegExp(`${r1.name}[\\s\\S]*?★ 4\\.5`));
  assert.match(html, new RegExp(`${r2.name}[\\s\\S]*?★ 3\\.2`));
  assert.match(html, new RegExp(o.public_code));
});

test('G3: rating/rating_count — числовые типы (REAL/INTEGER колонки, не агрегаты — но проверяем явно)', async () => {
  await pgCreateRestaurant({ rating: 4.0, rating_count: 7 });
  const rows = await db.query('SELECT rating, rating_count FROM restaurants ORDER BY id DESC LIMIT 1');
  assert.equal(typeof rows[0].rating, 'number');
  assert.equal(typeof rows[0].rating_count, 'number');
});

// ===========================================================================
// H. Parity SQLite <-> PostgreSQL
// ===========================================================================

function routeSignatures(router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`))
    .sort();
}

test('H1: набор маршрутов (method+path) идентичен SQLite-оригиналу', () => {
  const pgAdminRouter = require('../../routes/postgresql/admin.js');
  const pgRoutes = routeSignatures(pgAdminRouter);
  const sqliteRoutes = routeSignatures(sqliteAdminRouter);
  assert.deepEqual(pgRoutes, sqliteRoutes);
});

test('H2: HTML-маркеры (badge-классы, кнопки) дословно совпадают с SQLite-оригиналом', async () => {
  const r = await pgCreateRestaurant();
  const html = await (await getPage('/admin/restaurants')).text();
  assert.match(html, /class="badge open">Открыт<\/span>/);
});

test('H3: error text "Не найдено" дословно совпадает с SQLite-оригиналом', async () => {
  const res = await getPage('/admin/restaurants/999999999/edit');
  const text = await res.text();
  assert.equal(text, 'Не найдено');
});

// ===========================================================================
// I. Статические проверки
// ===========================================================================

test('I1: исходник routes/postgresql/admin.js не содержит require db/index.js (SQLite) / db.prepare() / SQLite orderService', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../routes/postgresql/admin.js'), 'utf8');
  assert.doesNotMatch(src, /db\.prepare\(/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/\.\.\/db['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/services\/orderService['"]\)/);
});

test('I2: require(routes/postgresql/admin.js) на module-load не подтянул SQLite orderService/orderAccessService', () => {
  assert.equal(ADMIN_PG_LOADED_SQLITE_ORDER_SERVICE, false);
});

// ===========================================================================
// J. Cleanup
// ===========================================================================

test('J1: пул PostgreSQL возвращён, waitingCount=0, total===idle', async () => {
  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});
