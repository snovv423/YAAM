'use strict';

// Stage 11B — минимальный, идемпотентный, ТОЛЬКО-аддитивный набор тестовых
// данных для PostgreSQL staging (api-pg.yaam.su + БД yaam_production).
//
// В отличие от server/db/seed.js (SQLite demo-seed, который начинается с
// DELETE FROM ... и полностью пересоздаёт demo-данные при каждом запуске),
// этот скрипт НИКОГДА не удаляет и не изменяет ни одной существующей строки.
// Идемпотентность обеспечена не DELETE-then-INSERT, а уникальным маркером
// restaurants.connect_code (UNIQUE в схеме, см. db/postgresql/schema.sql) +
// `ON CONFLICT (connect_code) DO NOTHING` — если тестовый ресторан уже
// существует, INSERT молча не создаёт вторую строку, а сам скрипт не трогает
// вообще ничего в БД. connect_code в норме используется для привязки бота
// реального ресторана случайным одноразовым кодом — фиксированный маркер
// ниже практически не может случайно совпасть с реальным будущим рестораном.
//
// Не подключён к приложению и не выполняется автоматически ни при старте
// сервиса, ни в тестах — запуск только вручную, см. server/docs/ или
// сопроводительный отчёт "Stage 11B Test Data Preparation".
const db = require('./index');

const SEED_MARKER = 'stage11b-test-seed-v1';

const MENU_ITEMS = [
  {
    name: 'Тестовое блюдо №1',
    description: 'Stage 11B seed — безопасно для тестового заказа, не реальное блюдо',
    price: 350,
  },
  {
    name: 'Тестовое блюдо №2',
    description: 'Stage 11B seed — безопасно для тестового заказа, не реальное блюдо',
    price: 420,
  },
  {
    name: 'Тестовое блюдо №3',
    description: 'Stage 11B seed — безопасно для тестового заказа, не реальное блюдо',
    price: 290,
  },
];

async function main() {
  const result = await db.transaction(async (client) => {
    // cities включает ровно "Грозный" — client/js/app.js использует
    // selectedCity='Грозный' как город по умолчанию (см. GET /api/restaurants
    // ?city= фильтр в routes/postgresql/api.js: r.cities.includes(city)),
    // поэтому тестовый ресторан виден сразу, без переключения города вручную.
    const insertedRestaurant = await db.execute(
      `INSERT INTO restaurants (
         name, cuisine, photo_url, cities, address, hours,
         delivery_price, min_order, is_open, is_new, rating, rating_count,
         phone, default_cook_minutes, connect_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (connect_code) DO NOTHING
       RETURNING id`,
      [
        'YAAM QA — Тестовый ресторан (Stage 11B)',
        'Тестовые данные · Stage 11B seed',
        '',
        JSON.stringify(['Грозный']),
        'г. Грозный, тестовый адрес (Stage 11B seed, не реальный)',
        '00:00–23:59',
        100, // delivery_price — маленькая, некритичная сумма
        300, // min_order — заведомо ниже суммы любых 1-3 позиций меню ниже
        1, // is_open — ресторан доступен для заказа сразу
        0, // is_new
        5, // rating — косметическое значение
        1, // rating_count
        '+7 900 000-00-00',
        30, // default_cook_minutes
        SEED_MARKER,
      ],
      client
    );

    if (!insertedRestaurant.rows[0]) {
      const existing = await db.query(
        'SELECT id FROM restaurants WHERE connect_code = $1',
        [SEED_MARKER],
        client
      );
      return { created: false, restaurantId: existing[0].id };
    }

    const restaurantId = insertedRestaurant.rows[0].id;

    const insertedCategory = await db.execute(
      `INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [restaurantId, 'Тестовое меню', 0],
      client
    );
    const categoryId = insertedCategory.rows[0].id;

    for (const [index, item] of MENU_ITEMS.entries()) {
      await db.execute(
        `INSERT INTO menu_items (
           restaurant_id, category_id, name, description, price, photo_url,
           weight_g, kcal, protein_g, fat_g, carbs_g, composition,
           is_popular, is_available, sort_order
         ) VALUES ($1,$2,$3,$4,$5,'',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          restaurantId,
          categoryId,
          item.name,
          item.description,
          item.price,
          300, // weight_g
          400, // kcal
          15, // protein_g
          15, // fat_g
          40, // carbs_g
          'Тестовый состав (Stage 11B seed)',
          0, // is_popular
          1, // is_available — обязательно 1, иначе createOrder() отклонит блюдо
          index,
        ],
        client
      );
    }

    return { created: true, restaurantId };
  });

  if (result.created) {
    console.log(
      `Stage 11B seed: создан тестовый ресторан id=${result.restaurantId}, ` +
        `connect_code=${SEED_MARKER}, 1 категория, ${MENU_ITEMS.length} блюда.`
    );
  } else {
    console.log(
      `Stage 11B seed: тестовый ресторан уже существует (id=${result.restaurantId}, ` +
        `connect_code=${SEED_MARKER}) — пропущено, ничего не изменено.`
    );
  }
}

main()
  .catch((err) => {
    console.error('Stage 11B seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
