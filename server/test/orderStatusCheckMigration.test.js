// FINAL ORDER STATE MACHINE HARDENING — Finding 2: orders.status была
// единственной статусной колонкой во всей БД без CHECK-ограничения
// (payments/refunds/payment_initial_attempts/payment_retry_attempts его
// всегда имели) — независимый аудит State Machine это эмпирически
// подтвердил, записав произвольную строку напрямую через UPDATE. Свежая БД
// теперь получает CHECK прямо в CREATE TABLE (см. schema.sql); эта БД
// проверяет также аддитивную миграцию для legacy-БД, у которых таблица orders
// уже существовала без ограничения (server/db/index.js:migrateOrdersStatusCheck).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const ORDERS_STATUS_CHECK_VALUES = [
  'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier',
  'delivered', 'payment_failed', 'declined', 'timed_out', 'cancelled',
];

function currentSchemaSql() {
  return fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
}

// Имитирует БД, созданную ДО этого фикса: та же схема, но без CHECK на
// orders.status — тем же способом, что и остальные "legacy-БД" тесты в этом
// проекте (см. orderAccessSchemaUpgrade.test.js), вырезаем блок из текущей
// schema.sql регулярным выражением вместо ручного дублирования всей схемы.
function legacySchemaWithoutOrdersStatusCheck() {
  const current = currentSchemaSql();
  const withoutCheck = current.replace(
    /status TEXT NOT NULL DEFAULT 'awaiting_payment'\s*\n\s*CHECK\([\s\S]*?\)\),/,
    "status TEXT NOT NULL DEFAULT 'awaiting_payment',",
  );
  assert.notEqual(withoutCheck, current, 'regex должен был вырезать CHECK — проверь, не изменился ли формат schema.sql');
  return withoutCheck;
}

test('свежая БД: CHECK принимает все 10 легитимных статусов и отклоняет произвольный INSERT/UPDATE', () => {
  const dbPath = path.join(os.tmpdir(), `yaam-status-check-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DB_PATH = dbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../db')];
  const db = require('../db');
  const { restaurantId, menuItemId } = seedMinimalRestaurant(db, { phone: '+79280003001' });

  try {
    for (const status of ORDERS_STATUS_CHECK_VALUES) {
      const info = db.prepare(`
        INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
        VALUES (?, ?, 'City', 'N', '+79280009999', 'A', 'delivery', '', 300, 21, ?)
      `).run(`YAAM-CHK-${status}`, restaurantId, status);
      assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(info.lastInsertRowid).status, status);
    }

    assert.throws(
      () => db.prepare(`
        INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
        VALUES ('YAAM-BOGUS', ?, 'City', 'N', '+79280009998', 'A', 'delivery', '', 300, 21, 'not_a_real_status')
      `).run(restaurantId),
      /CHECK/,
    );

    const created = db.prepare(`
      INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
      VALUES ('YAAM-UPD', ?, 'City', 'N', '+79280009997', 'A', 'delivery', '', 300, 21, 'awaiting_payment')
    `).run(restaurantId);
    assert.throws(
      () => db.prepare("UPDATE orders SET status = 'also_not_real' WHERE id = ?").run(created.lastInsertRowid),
      /CHECK/,
    );
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(created.lastInsertRowid).status, 'awaiting_payment');
  } finally {
    cleanupDbFile(dbPath);
  }
});

test('legacy-БД без CHECK мигрирует аддитивно: CHECK появляется, ни одна сущность не теряется', () => {
  const dbPath = path.join(os.tmpdir(), `yaam-status-migrate-${crypto.randomBytes(6).toString('hex')}.db`);
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec('PRAGMA foreign_keys = ON;');
  legacyDb.exec(legacySchemaWithoutOrdersStatusCheck());

  const rest = legacyDb.prepare(`
    INSERT INTO restaurants (name, cuisine, cities, is_open, min_order) VALUES ('R', 'T', '[]', 1, 0)
  `).run();
  const cat = legacyDb.prepare(`INSERT INTO categories (restaurant_id, name) VALUES (?, 'C')`).run(rest.lastInsertRowid);
  const item = legacyDb.prepare(`
    INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES (?, ?, 'D', 300)
  `).run(rest.lastInsertRowid, cat.lastInsertRowid);
  const order = legacyDb.prepare(`
    INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status, rating, estimated_ready_minutes)
    VALUES ('YAAM-LEGACY1', ?, 'City', 'Cust', '+79280000101', 'Addr', 'delivery', 'Comment', 300, 21, 'delivered', 5, 35)
  `).run(rest.lastInsertRowid);
  legacyDb.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?, ?, 'D', 300, 1)
  `).run(order.lastInsertRowid, item.lastInsertRowid);
  const payment = legacyDb.prepare(`
    INSERT INTO payments (order_id, provider, provider_payment_id, amount, status) VALUES (?, 'mock', 'legacy-p1', 300, 'refunded')
  `).run(order.lastInsertRowid);
  const refundKey = crypto.randomUUID();
  legacyDb.prepare(`
    INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
    VALUES (?, 'mock', 300, 'succeeded', 'customer_cancel', ?)
  `).run(payment.lastInsertRowid, refundKey);
  legacyDb.prepare(`
    INSERT INTO order_access_credentials (order_id, token_hash, create_key_hash, request_hash)
    VALUES (?, randomblob(32), randomblob(32), randomblob(32))
  `).run(order.lastInsertRowid);
  legacyDb.close();

  process.env.DB_PATH = dbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../db')];
  const db = require('../db');

  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get().sql;
    assert.match(tableSql, /CHECK\s*\(\s*status\s+IN/i, 'CHECK должен появиться после миграции');

    const migratedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.lastInsertRowid);
    assert.equal(migratedOrder.status, 'delivered');
    assert.equal(migratedOrder.public_code, 'YAAM-LEGACY1');
    assert.equal(migratedOrder.rating, 5);
    assert.equal(migratedOrder.estimated_ready_minutes, 35);

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?').get(order.lastInsertRowid).c, 1);
    const migratedPayment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.lastInsertRowid);
    assert.equal(migratedPayment.status, 'refunded');
    const migratedRefund = db.prepare('SELECT * FROM refunds WHERE payment_id = ?').get(payment.lastInsertRowid);
    assert.equal(migratedRefund.status, 'succeeded');
    assert.equal(migratedRefund.provider_idempotency_key, refundKey);
    assert.ok(db.prepare('SELECT * FROM order_access_credentials WHERE order_id = ?').get(order.lastInsertRowid));

    // Внешние ключи не нарушены переносом таблицы (DROP + RENAME).
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check(orders)').all(), []);

    // Ограничение реально работает после миграции, не только присутствует текстом.
    assert.throws(
      () => db.prepare("UPDATE orders SET status = 'bogus_after_migration' WHERE id = ?").run(order.lastInsertRowid),
      /CHECK/,
    );

    // Повторный require (например, второй тест-файл/рестарт процесса) не
    // должен пытаться мигрировать уже мигрированную таблицу повторно.
    delete require.cache[require.resolve('../db')];
    assert.doesNotThrow(() => require('../db'));
  } finally {
    cleanupDbFile(dbPath);
  }
});

test('legacy-БД: удалённая последняя строка не приводит к повторному использованию её id после миграции (sqlite_sequence)', () => {
  // Независимый аудит SQLite migration/backup (Review 3, Finding 1):
  // CREATE TABLE orders_new + INSERT...SELECT + DROP + RENAME — стандартный
  // способ добавить CHECK в SQLite — сам по себе НЕ переносит исторический
  // sqlite_sequence.seq таблицы orders, а INSERT в orders_new заново создаёt
  // свою запись в sqlite_sequence на основе только СКОПИРОВАННЫХ строк. Если
  // самая "старшая" по id строка была удалена до миграции, sqlite_sequence
  // после наивной миграции откатывается назад, и AUTOINCREMENT готов выдать
  // повторно уже использованный id — с реальным риском коллизии public_code
  // и путаницы в inline-кнопках Telegram-бота (accept:<id>/decline:<id>),
  // которые могут быть нажаты после того, как объект с этим id уже другой.
  const dbPath = path.join(os.tmpdir(), `yaam-status-seq-${crypto.randomBytes(6).toString('hex')}.db`);
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec('PRAGMA foreign_keys = ON;');
  legacyDb.exec(legacySchemaWithoutOrdersStatusCheck());

  const rest = legacyDb.prepare(`
    INSERT INTO restaurants (name, cuisine, cities, is_open, min_order) VALUES ('R', 'T', '[]', 1, 0)
  `).run();

  const insertOrder = (code) => legacyDb.prepare(`
    INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
    VALUES (?, ?, 'City', 'Cust', '+79280000201', 'Addr', 'delivery', '', 300, 21, 'delivered')
  `).run(code, rest.lastInsertRowid);

  insertOrder('YAAM-SEQ1');
  insertOrder('YAAM-SEQ2');
  const third = insertOrder('YAAM-SEQ3');
  const highestId = third.lastInsertRowid;

  // Удаляем самую "старшую" по id строку ДО миграции — именно этот сценарий
  // воспроизвёл ревьюер: sqlite_sequence хранит исторический максимум (3),
  // а после удаления в таблице orders физически остаются только id 1 и 2.
  legacyDb.prepare('DELETE FROM orders WHERE id = ?').run(highestId);
  const seqBefore = legacyDb.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orders'").get();
  assert.equal(seqBefore.seq, highestId, 'sanity: sqlite_sequence должен помнить исторический максимум ДО миграции');
  legacyDb.close();

  process.env.DB_PATH = dbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../db')];
  const db = require('../db');

  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get().sql;
    assert.match(tableSql, /CHECK\s*\(\s*status\s+IN/i, 'CHECK должен появиться после миграции');

    const seqAfter = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orders'").get();
    assert.ok(seqAfter, 'запись sqlite_sequence для orders должна пережить RENAME');
    assert.equal(seqAfter.seq, highestId, 'seq не должен откатиться назад после миграции таблицы с удалённой старшей строкой');

    const { restaurantId, menuItemId } = seedMinimalRestaurant(db, { phone: '+79280000202' });
    const created = db.prepare(`
      INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
      VALUES ('YAAM-SEQ-NEW', ?, 'City', 'Cust', '+79280000203', 'Addr', 'delivery', '', 300, 21, 'awaiting_payment')
    `).run(restaurantId);
    assert.ok(
      created.lastInsertRowid > highestId,
      `новый заказ (id=${created.lastInsertRowid}) не должен повторно использовать удалённый id=${highestId}`,
    );
    void menuItemId;
  } finally {
    cleanupDbFile(dbPath);
  }
});

test('legacy-БД с уже некорректным orders.status: миграция fail-closed, статус не исправляется и заказ не удаляется', () => {
  const dbPath = path.join(os.tmpdir(), `yaam-status-failclosed-${crypto.randomBytes(6).toString('hex')}.db`);
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec('PRAGMA foreign_keys = ON;');
  legacyDb.exec(legacySchemaWithoutOrdersStatusCheck());
  const rest = legacyDb.prepare(`
    INSERT INTO restaurants (name, cuisine, cities, is_open, min_order) VALUES ('R', 'T', '[]', 1, 0)
  `).run();
  const corrupted = legacyDb.prepare(`
    INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
    VALUES ('YAAM-CORRUPT', ?, 'City', 'Cust', '+79280000102', 'Addr', 'delivery', '', 300, 21, 'some_unexpected_legacy_value')
  `).run(rest.lastInsertRowid);
  legacyDb.close();

  process.env.DB_PATH = dbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete require.cache[require.resolve('../db')];

  assert.throws(
    () => require('../db'),
    /Миграция CHECK-ограничения orders\.status остановлена/,
  );

  try {
    const readOnly = new DatabaseSync(dbPath, { readOnly: true });
    const stillThere = readOnly.prepare("SELECT status FROM orders WHERE id = ?").get(corrupted.lastInsertRowid);
    readOnly.close();
    assert.ok(stillThere, 'заказ не должен быть удалён при fail-closed миграции');
    assert.equal(stillThere.status, 'some_unexpected_legacy_value', 'статус не должен быть молча исправлен');
  } finally {
    cleanupDbFile(dbPath);
  }
});
