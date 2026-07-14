const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupDbFile } = require('./helpers/testDb');

test('legacy-БД с двумя активными платежами останавливает миграцию с явной диагностикой', () => {
  const dbPath = path.join(os.tmpdir(), `yaam-duplicate-payments-${crypto.randomBytes(6).toString('hex')}.db`);
  const schemaPath = path.join(__dirname, '../db/schema.sql');
  let legacySchema = fs.readFileSync(schemaPath, 'utf8');
  legacySchema = legacySchema
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_active_per_order[\s\S]*?;\n/, '')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_reference[\s\S]*?;\n/, '');

  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec('PRAGMA foreign_keys = ON;');
  legacyDb.exec(legacySchema);
  const restaurant = legacyDb.prepare(`
    INSERT INTO restaurants (name, cuisine, cities) VALUES ('Legacy', 'Test', '[]')
  `).run();
  const order = legacyDb.prepare(`
    INSERT INTO orders (
      public_code, restaurant_id, city, customer_name, customer_phone, address,
      items_total, commission_amount, status
    ) VALUES ('YAAM-00999', ?, 'Грозный', 'Test', '+79280009999', '', 300, 21, 'awaiting_payment')
  `).run(restaurant.lastInsertRowid);
  legacyDb.prepare(`
    INSERT INTO payments (order_id, amount, status) VALUES (?, 300, 'pending')
  `).run(order.lastInsertRowid);
  legacyDb.prepare(`
    INSERT INTO payments (order_id, amount, status) VALUES (?, 300, 'creating')
  `).run(order.lastInsertRowid);
  legacyDb.close();

  try {
    const result = spawnSync(process.execPath, ['-e', "require('./db')"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_PATH: dbPath, PAYMENT_PROVIDER: 'mock' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Нарушен платёжный инвариант legacy-БД/);
  } finally {
    cleanupDbFile(dbPath);
  }
});

test('legacy-БД с повторяющимся provider payment id останавливает миграцию', () => {
  const dbPath = path.join(os.tmpdir(), `yaam-duplicate-provider-${crypto.randomBytes(6).toString('hex')}.db`);
  let legacySchema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  legacySchema = legacySchema
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_active_per_order[\s\S]*?;\n/, '')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_reference[\s\S]*?;\n/, '');

  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec('PRAGMA foreign_keys = ON;');
  legacyDb.exec(legacySchema);
  const restaurant = legacyDb.prepare(`
    INSERT INTO restaurants (name, cuisine, cities) VALUES ('Legacy provider', 'Test', '[]')
  `).run();
  for (let i = 1; i <= 2; i += 1) {
    const order = legacyDb.prepare(`
      INSERT INTO orders (
        public_code, restaurant_id, city, customer_name, customer_phone, address,
        items_total, commission_amount, status
      ) VALUES (?, ?, 'Грозный', 'Test', ?, '', 300, 21, 'payment_failed')
    `).run(`YAAM-00${990 + i}`, restaurant.lastInsertRowid, `+7928000999${i}`);
    legacyDb.prepare(`
      INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
      VALUES (?, 'mock', 'duplicate-provider-id', 300, 'failed')
    `).run(order.lastInsertRowid);
  }
  legacyDb.close();

  try {
    const result = spawnSync(process.execPath, ['-e', "require('./db')"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_PATH: dbPath, PAYMENT_PROVIDER: 'mock' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Нарушен платёжный инвариант legacy-БД/);
  } finally {
    cleanupDbFile(dbPath);
  }
});
