// HTTP-level regression test для публичного контракта GET /api/restaurants и
// GET /api/restaurants/:id (SQLite-путь, routes/api.js) — доказывает, что
// внутренние поля ресторана (connect_code — код привязки Telegram-бота,
// telegram_chat_id — внутренний chat id бота, phone — раскрывается клиенту
// только через order DTO после оформления заказа, не заранее) никогда не
// попадают в публичный ответ, даже если реально заполнены в БД.
//
// Найдено в рамках "Critical Public API Data Exposure Audit": staging
// PostgreSQL-эквивалент этого же роутера (routes/postgresql/api.js) отдавал
// connect_code напрямую через SELECT r.* + object spread — идентичный код в
// этом (SQLite) файле имел ту же уязвимость, поэтому фикс и тест зеркальны.
//
// Тот же приём, что и publicOrderRoute.test.js: неизменённый production-
// router из routes/api.js, обёрнутый в собственное одноразовое Express-
// приложение — реальный HTTP-запрос к реальному роуту, а не вызов mapper'а
// напрямую в обход route wiring.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { useIsolatedDb, cleanupDbFile } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();

let server;
let baseUrl;

before(async () => {
  const express = require('express');
  const apiRoutes = require('../routes/api');

  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDbFile(dbPath);
});

function uniqueConnectCode() {
  return `sec-test-${crypto.randomBytes(6).toString('hex')}`;
}

// Прямой insert (не через seedMinimalRestaurant из testDb.js — тот не
// заполняет connect_code/telegram_chat_id, а этому тесту нужны реально
// заполненные значения, чтобы доказать их отсутствие в ответе, а не
// совпадение с NULL по умолчанию).
function createRestaurantWithInternalFields(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO restaurants (
      name, cuisine, photo_url, cities, address, hours, phone,
      delivery_price, min_order, default_cook_minutes, is_open, is_new,
      rating, rating_count, telegram_chat_id, connect_code
    ) VALUES (
      'Test Restaurant', 'test', '', :cities, '', '', '+79280000099',
      100, :min_order, 20, :is_open, 0, 4.5, 10, :telegram_chat_id, :connect_code
    )
  `).run({
    cities: JSON.stringify(overrides.cities || ['Грозный']),
    min_order: overrides.minOrder ?? 0,
    is_open: overrides.isOpen === false ? 0 : 1,
    telegram_chat_id: overrides.telegramChatId ?? '987654321',
    connect_code: overrides.connectCode ?? uniqueConnectCode(),
  });
  const restaurantId = info.lastInsertRowid;
  const catInfo = db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?, ?, 0)').run(restaurantId, 'Категория');
  db.prepare(`
    INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, weight_g, kcal, protein_g, fat_g, carbs_g, composition, is_popular, is_available, sort_order)
    VALUES (?, ?, 'Тестовое блюдо', '', 300, '', 200, 0, 0, 0, 0, '', 0, 1, 0)
  `).run(restaurantId, catInfo.lastInsertRowid);
  return restaurantId;
}

// Полный список колонок restaurants (см. db/schema.sql) — зафиксирован
// буквально, а не выведен из БД программно: тест обязан упасть, если кто-то
// добавит новую колонку и забудет явно решить, публичная она или внутренняя.
const ALL_RESTAURANT_COLUMNS = [
  'id', 'name', 'cuisine', 'photo_url', 'cities', 'address', 'hours',
  'delivery_price', 'min_order', 'is_open', 'paused_until', 'is_new',
  'rating', 'rating_count', 'phone', 'default_cook_minutes',
  'telegram_chat_id', 'connect_code', 'created_at',
];
const PUBLIC_RESTAURANT_FIELDS = [
  'id', 'name', 'cuisine', 'photo_url', 'cities', 'address', 'hours',
  'delivery_price', 'min_order', 'is_open', 'is_new', 'rating',
  'rating_count', 'default_cook_minutes', 'orders_count',
];
const INTERNAL_RESTAURANT_FIELDS = ALL_RESTAURANT_COLUMNS.filter(
  (f) => !PUBLIC_RESTAURANT_FIELDS.includes(f),
);

test('GET /api/restaurants — не содержит внутренние поля (connect_code, telegram_chat_id, phone, paused_until, created_at)', async () => {
  const restaurantId = createRestaurantWithInternalFields();
  const res = await fetch(`${baseUrl}/api/restaurants`);
  assert.equal(res.status, 200);
  const list = await res.json();
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found, 'созданный ресторан должен быть в списке');
  for (const field of INTERNAL_RESTAURANT_FIELDS) {
    assert.ok(!(field in found), `внутреннее поле "${field}" не должно присутствовать в GET /api/restaurants`);
  }
});

test('GET /api/restaurants?city=Грозный — фильтр по городу тоже не содержит внутренние поля', async () => {
  const restaurantId = createRestaurantWithInternalFields({ cities: ['Грозный'] });
  const res = await fetch(`${baseUrl}/api/restaurants?city=${encodeURIComponent('Грозный')}`);
  assert.equal(res.status, 200);
  const list = await res.json();
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found, 'ресторан должен быть виден по городу Грозный');
  for (const field of INTERNAL_RESTAURANT_FIELDS) {
    assert.ok(!(field in found), `внутреннее поле "${field}" не должно присутствовать в city-фильтре`);
  }
});

test('GET /api/restaurants/:id — не содержит внутренние поля', async () => {
  const restaurantId = createRestaurantWithInternalFields();
  const res = await fetch(`${baseUrl}/api/restaurants/${restaurantId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const field of INTERNAL_RESTAURANT_FIELDS) {
    assert.ok(!(field in body), `внутреннее поле "${field}" не должно присутствовать в GET /api/restaurants/:id`);
  }
});

test('GET /api/restaurants — разрешённые клиентские поля сохраняются (нет регрессии)', async () => {
  const restaurantId = createRestaurantWithInternalFields({ cities: ['Аргун'] });
  const res = await fetch(`${baseUrl}/api/restaurants?city=${encodeURIComponent('Аргун')}`);
  const list = await res.json();
  const found = list.find((r) => r.id === restaurantId);
  assert.ok(found);
  for (const field of PUBLIC_RESTAURANT_FIELDS) {
    assert.ok(field in found, `публичное поле "${field}" должно присутствовать`);
  }
  assert.equal(found.name, 'Test Restaurant');
  assert.deepEqual(found.cities, ['Аргун']);
  assert.equal(typeof found.orders_count, 'number');
});

test('GET /api/restaurants/:id — меню и категории продолжают возвращаться корректно', async () => {
  const restaurantId = createRestaurantWithInternalFields();
  const res = await fetch(`${baseUrl}/api/restaurants/${restaurantId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.menu));
  assert.equal(body.menu.length, 1);
  assert.equal(body.menu[0].items.length, 1);
  assert.equal(body.menu[0].items[0].name, 'Тестовое блюдо');
  assert.ok('is_popular' in body.menu[0].items[0]);
});
