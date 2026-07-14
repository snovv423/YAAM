const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupDbFile } = require('./helpers/testDb');

const dbPath = path.join(os.tmpdir(), `yaam-upgrade-${crypto.randomBytes(6).toString('hex')}.db`);

function withoutCreateTable(schema, tableName) {
  const startMarker = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
  const start = schema.indexOf(startMarker);
  assert.notEqual(start, -1, `таблица ${tableName} должна быть в текущей schema.sql`);
  const end = schema.indexOf('\n);', start);
  assert.notEqual(end, -1, `конец таблицы ${tableName} должен быть найден`);
  return schema.slice(0, start) + schema.slice(end + 4);
}

const currentSchema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
let oldSchema = withoutCreateTable(currentSchema, 'order_access_credentials');
oldSchema = withoutCreateTable(oldSchema, 'payment_presentations');
oldSchema = withoutCreateTable(oldSchema, 'payment_initial_attempts');
oldSchema = withoutCreateTable(oldSchema, 'payment_retry_keys');
oldSchema = withoutCreateTable(oldSchema, 'payment_retry_attempts');
oldSchema = oldSchema.replace(/CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_active_per_order[\s\S]*?;\n/, '');
oldSchema = oldSchema.replace(/CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_reference[\s\S]*?;\n/, '');
oldSchema = oldSchema.replace(/CREATE INDEX IF NOT EXISTS ix_payment_retry_keys_payment[\s\S]*?;\n/, '');

// Имитируем БД предыдущей версии: заказы/платежи уже есть, security-таблиц ещё нет.
const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec('PRAGMA foreign_keys = ON;');
legacyDb.exec(oldSchema);
const restaurant = legacyDb.prepare(`
  INSERT INTO restaurants (name, cuisine, cities, is_open, min_order)
  VALUES ('Legacy restaurant', 'Test', '["Грозный"]', 1, 0)
`).run();
const category = legacyDb.prepare(`
  INSERT INTO categories (restaurant_id, name) VALUES (?, 'Menu')
`).run(restaurant.lastInsertRowid);
const menuItem = legacyDb.prepare(`
  INSERT INTO menu_items (restaurant_id, category_id, name, price)
  VALUES (?, ?, 'Dish', 300)
`).run(restaurant.lastInsertRowid, category.lastInsertRowid);
const legacyOrder = legacyDb.prepare(`
  INSERT INTO orders (
    public_code, restaurant_id, city, customer_name, customer_phone, address,
    fulfillment_type, comment, items_total, commission_amount, status
  ) VALUES ('YAAM-00001', ?, 'Грозный', 'Legacy', '+79280000001', '',
    'delivery', '', 300, 21, 'awaiting_payment')
`).run(restaurant.lastInsertRowid);
legacyDb.prepare(`
  INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
  VALUES (?, 'mock', 'legacy-provider-id', 300, 'pending')
`).run(legacyOrder.lastInsertRowid);
legacyDb.close();

process.env.DB_PATH = dbPath;
process.env.PAYMENT_PROVIDER = 'mock';
const db = require('../db');
const orderService = require('../services/orderService');
const orderAccess = require('../services/orderAccessService');

after(() => cleanupDbFile(dbPath));

test('аддитивное обновление закрывает legacy-заказ и поддерживает новый защищённый заказ', async () => {
  const credentialColumns = db.prepare('PRAGMA table_info(order_access_credentials)').all().map((row) => row.name);
  assert.deepEqual(
    credentialColumns,
    ['order_id', 'token_hash', 'create_key_hash', 'request_hash', 'created_at'],
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='payment_presentations'").get().count,
    1,
  );
  const initialColumns = db.prepare('PRAGMA table_info(payment_initial_attempts)').all().map((row) => row.name);
  assert.deepEqual(
    initialColumns,
    ['payment_id', 'provider_idempotency_key', 'state', 'created_at', 'updated_at'],
  );
  const retryColumns = db.prepare('PRAGMA table_info(payment_retry_attempts)').all().map((row) => row.name);
  assert.deepEqual(
    retryColumns,
    ['payment_id', 'provider_idempotency_key', 'state', 'created_at', 'updated_at'],
  );
  const retryKeyColumns = db.prepare('PRAGMA table_info(payment_retry_keys)').all().map((row) => row.name);
  assert.deepEqual(
    retryKeyColumns,
    ['client_key_hash', 'payment_id', 'created_at'],
  );

  const legacyToken = `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`;
  assert.equal(orderAccess.findAuthorizedOrderId('YAAM-00001', legacyToken), null);

  const token = `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`;
  const createKey = `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`;
  const created = await orderService.createOrder({
    restaurantId: restaurant.lastInsertRowid,
    city: 'Грозный',
    customerName: 'New customer',
    customerPhone: '+79280000002',
    address: 'New address',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId: menuItem.lastInsertRowid, qty: 1 }],
    orderAccessToken: token,
    createIdempotencyKey: createKey,
  });

  assert.equal(orderAccess.findAuthorizedOrderId(created.order.public_code, token), created.order.id);
  const presentation = db.prepare(`
    SELECT pp.qr_payload FROM payment_presentations pp
    JOIN payments p ON p.id = pp.payment_id WHERE p.order_id = ?
  `).get(created.order.id);
  assert.match(presentation.qr_payload, /^yaam-demo:\/\/pay\//);
});
