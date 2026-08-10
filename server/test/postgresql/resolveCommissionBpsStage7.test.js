'use strict';

// YAAM HQ Stage 7 — юнит/live-DB тесты resolveCommissionBps() и
// todayDateStringMoscow() (задание, раздел 14: "commission fallback",
// "signed contract commission", "дробный процент", "период Europe/Moscow").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('resolve-commission-bps-stage7');
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

function offsetDateString(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// todayDateStringMoscow — чистая функция, без БД (те же граничные примеры,
// что уже закреплены для todayRangeUtc в test/hqDashboardMetrics.test.js —
// одинаковый якорь времени Europe/Moscow +180 минут).
// ---------------------------------------------------------------------------
test('todayDateStringMoscow: 00:30 UTC -> уже следующие сутки по Москве', () => {
  const orderService = require('../../services/postgresql/orderService');
  assert.equal(orderService.todayDateStringMoscow(new Date('2026-07-24T00:30:00Z')), '2026-07-24');
});

test('todayDateStringMoscow: 20:59 UTC -> ещё те же сутки по Москве', () => {
  const orderService = require('../../services/postgresql/orderService');
  assert.equal(orderService.todayDateStringMoscow(new Date('2026-07-23T20:59:00Z')), '2026-07-23');
});

// ---------------------------------------------------------------------------
// resolveCommissionBps — против настоящего embedded PostgreSQL
// ---------------------------------------------------------------------------
test('resolveCommissionBps: нет договора -> FALLBACK_COMMISSION_BPS (700)', async () => {
  const databaseUrl = await freshDatabase('rcb_no_contract');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    assert.equal(await orderService.resolveCommissionBps(restaurantId), orderService.FALLBACK_COMMISSION_BPS);
    assert.equal(orderService.FALLBACK_COMMISSION_BPS, 700);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('resolveCommissionBps: договор существует, но НЕ подписан (prepared) -> fallback', async () => {
  const databaseUrl = await freshDatabase('rcb_not_signed');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    await db.execute('INSERT INTO restaurant_contracts (restaurant_id, status, commission_bps) VALUES ($1,$2,$3)', [restaurantId, 'prepared', 500]);
    assert.equal(await orderService.resolveCommissionBps(restaurantId), 700);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('resolveCommissionBps: подписанный договор без дат — используется его commission_bps (дробный процент)', async () => {
  const databaseUrl = await freshDatabase('rcb_signed_fractional');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    await db.execute('INSERT INTO restaurant_contracts (restaurant_id, status, commission_bps) VALUES ($1,$2,$3)', [restaurantId, 'signed', 550]); // 5.5%
    assert.equal(await orderService.resolveCommissionBps(restaurantId), 550);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('resolveCommissionBps: подписанный договор с starts_at в будущем -> fallback (ещё не начал действовать)', async () => {
  const databaseUrl = await freshDatabase('rcb_future_start');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    await db.execute(
      'INSERT INTO restaurant_contracts (restaurant_id, status, commission_bps, starts_at) VALUES ($1,$2,$3,$4)',
      [restaurantId, 'signed', 500, offsetDateString(5)],
    );
    assert.equal(await orderService.resolveCommissionBps(restaurantId), 700);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('resolveCommissionBps: подписанный договор с ends_at в прошлом -> fallback (уже истёк)', async () => {
  const databaseUrl = await freshDatabase('rcb_past_end');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    await db.execute(
      'INSERT INTO restaurant_contracts (restaurant_id, status, commission_bps, ends_at) VALUES ($1,$2,$3,$4)',
      [restaurantId, 'signed', 500, offsetDateString(-5)],
    );
    assert.equal(await orderService.resolveCommissionBps(restaurantId), 700);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('resolveCommissionBps: подписанный договор, сегодня внутри [starts_at, ends_at] -> используется его bps', async () => {
  const databaseUrl = await freshDatabase('rcb_within_bounds');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('X','[]') RETURNING id");
    const restaurantId = rest.rows[0].id;
    await db.execute(
      'INSERT INTO restaurant_contracts (restaurant_id, status, commission_bps, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)',
      [restaurantId, 'signed', 600, offsetDateString(-5), offsetDateString(5)],
    );
    assert.equal(await orderService.resolveCommissionBps(restaurantId), 600);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// Изменение комиссии влияет только на НОВЫЕ заказы; старый заказ хранит snapshot
// ---------------------------------------------------------------------------
test('createOrder: старый заказ сохраняет snapshot комиссии, новый заказ после смены договора использует новую комиссию', async () => {
  const databaseUrl = await freshDatabase('rcb_snapshot_isolation');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/postgresql/orderService')];
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  const crypto = require('node:crypto');
  try {
    const rest = await db.execute(
      "INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('X','[\"Грозный\"]',1,NOW()) RETURNING id",
    );
    const restaurantId = rest.rows[0].id;
    const cat = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [restaurantId, 'Кат']);
    const item = await db.execute(
      'INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1,$2,$3,$4,1) RETURNING id',
      [restaurantId, cat.rows[0].id, 'Блюдо', 1000],
    );
    const menuItemId = item.rows[0].id;

    await db.execute('INSERT INTO restaurant_contracts (restaurant_id, status, commission_bps) VALUES ($1,$2,$3)', [restaurantId, 'signed', 500]);

    // Разные customerPhone — иначе второй createOrder() для того же
    // restaurantId в течение AWAITING_PAYMENT_DEDUP_TTL_SEC отклонится как
    // ActiveOrderConflictError (дедуп брошенных неоплаченных заказов,
    // Stage 5/orderService.js — не имеет отношения к этому тесту, просто
    // нужно его не задеть).
    function makeParams(phone) {
      return {
        restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: phone,
        address: 'ул. Т, 1', comment: '', fulfillmentType: 'delivery',
        items: [{ menuItemId, qty: 1 }],
        orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
        createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
      };
    }

    // Stage 38 — items_total/commission_amount теперь integer minor units
    // (копейки): 1000 ₽ товара -> 100000 minor, комиссия считается от него.
    const first = await orderService.createOrder(makeParams('+79001234567'));
    const firstOrder = (await db.query('SELECT * FROM orders WHERE id = $1', [first.orderId]))[0];
    assert.equal(firstOrder.items_total, 100000);
    assert.equal(firstOrder.commission_amount, Math.round(100000 * 500 / 10000)); // 5000 minor = 50 ₽

    // Комиссия договора меняется ПОСЛЕ создания первого заказа.
    await db.execute('UPDATE restaurant_contracts SET commission_bps = $1 WHERE restaurant_id = $2', [900, restaurantId]);

    const second = await orderService.createOrder(makeParams('+79007654321'));
    const secondOrder = (await db.query('SELECT * FROM orders WHERE id = $1', [second.orderId]))[0];
    assert.equal(secondOrder.commission_amount, Math.round(100000 * 900 / 10000)); // 9000 minor = 90 ₽

    // Старый заказ НЕ пересчитан задним числом.
    const firstOrderAfter = (await db.query('SELECT * FROM orders WHERE id = $1', [first.orderId]))[0];
    assert.equal(firstOrderAfter.commission_amount, 5000, 'старый заказ должен сохранить исходный snapshot комиссии');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
