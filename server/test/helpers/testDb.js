// Изолированная тестовая БД: свой файл SQLite на процесс/файл теста, схема
// применяется автоматически при require('../../db') (см. db/index.js).
// DB_PATH должен быть выставлен ДО первого require('../../db') в тесте.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

function useIsolatedDb() {
  const dbPath = path.join(os.tmpdir(), `yaam-test-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DB_PATH = dbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  // eslint-disable-next-line global-require
  const db = require('../../db');
  return { db, dbPath };
}

function cleanupDbFile(dbPath) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* уже нет — не проблема */ }
  }
}

// Минимальный набор данных, достаточный для createOrder()/rateOrder(): один
// открытый ресторан с одним доступным блюдом.
function seedMinimalRestaurant(db, overrides = {}) {
  const info = db.prepare(`
    INSERT INTO restaurants (name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes, is_open, is_new, rating, rating_count)
    VALUES (:name, :cuisine, '', '[]', '', '', :phone, 100, 0, 20, :is_open, 0, :rating, :rating_count)
  `).run({
    name: overrides.name || 'Тестовый ресторан',
    cuisine: 'Тест',
    phone: overrides.phone || '+79280000000',
    is_open: overrides.is_open ?? 1,
    rating: overrides.rating ?? 4.5,
    rating_count: overrides.rating_count ?? 10,
  });
  const restaurantId = info.lastInsertRowid;
  const catInfo = db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?, ?, 0)').run(restaurantId, 'Категория');
  const itemInfo = db.prepare(`
    INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, weight_g, kcal, protein_g, fat_g, carbs_g, composition, is_popular, sort_order)
    VALUES (?, ?, 'Тестовое блюдо', '', 300, '', 200, 0, 0, 0, 0, '', 0, 0)
  `).run(restaurantId, catInfo.lastInsertRowid);
  return { restaurantId, menuItemId: itemInfo.lastInsertRowid };
}

function basicOrderPayload(restaurantId, menuItemId, overrides = {}) {
  return {
    restaurantId,
    city: 'Грозный',
    customerName: overrides.customerName || 'Тест Тестов',
    customerPhone: overrides.customerPhone || '+79281234567',
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Тестовое блюдо', price: 300, qty: 1 }],
  };
}

module.exports = { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload };
