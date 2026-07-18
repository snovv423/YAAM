'use strict';

// YAAM PostgreSQL Order Service — Wave 6: integration-тесты для rateOrder
// (server/services/postgresql/orderService.js) против настоящего embedded
// PostgreSQL 16.14 + parity-тесты против SQLite-оригинала (rateOrder
// синхронна и не делает сетевых вызовов ни в одной из версий — прямое
// сравнение возможно полностью, в отличие от Wave 1-5).
//
// rateOrder — единственная функция всей 15-пунктовой матрицы, требующая
// SELECT ... FOR UPDATE (см. postgresql-concurrency-migration-matrix.md,
// строка #14): read-modify-write агрегат restaurants.rating/rating_count без
// conditional-UPDATE-эквивалента. Примечание по терминологии: в схеме НЕТ
// колонки rating_sum — сумма реконструируется каждый раз как
// rating*rating_count (дословно из SQLite-оригинала); лексика "rating_sum"
// в задании на волну — концептуальная, не буквальное имя колонки, схема не
// менялась.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { waitForBackendLock, connectWithPid } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_orderservice_wave6_test';

let cluster;
let db;
let pgOrderService;
let monitor;

let sqliteDb;
let sqliteOrderService;
let sqliteDbPath;

before(async () => {
  cluster = await startEmbeddedPostgres('orderservice-wave6');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');

  monitor = cluster.getClient(DATABASE_NAME);
  await monitor.connect();

  sqliteDbPath = path.join(os.tmpdir(), `yaam-wave6-parity-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DB_PATH = sqliteDbPath;
  process.env.PAYMENT_PROVIDER = 'mock';
  sqliteDb = require('../../db');
  sqliteOrderService = require('../../services/orderService.js');
});

after(async () => {
  await monitor.end();
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

function uniquePhone() {
  const n = crypto.randomInt(100000000, 999999999);
  return `+79${String(n).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// PostgreSQL fixtures
// ---------------------------------------------------------------------------

async function pgCreateRestaurant({ rating = 0, ratingCount = 0 } = {}) {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, rating, rating_count) VALUES ('Test', 'test', '[]', $1, $2) RETURNING id`,
    [rating, ratingCount]
  );
  return rows[0].id;
}

async function pgCreateOrder(restaurantId, { status = 'delivered', hasPayment = true, rating = null } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, rating
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', $3, 'ул. Тестовая, 1', 500, 35, $4, $5)
     RETURNING *`,
    [`YAAM-W6-${suffix}`, restaurantId, uniquePhone(), status, rating]
  );
  const order = rows[0];
  if (hasPayment) {
    await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1, 500, 'succeeded')`, [order.id]);
  }
  return order;
}

async function pgRestaurantRow(restaurantId) {
  const rows = await db.query('SELECT rating, rating_count FROM restaurants WHERE id = $1', [restaurantId]);
  return { rating: Number(rows[0].rating), rating_count: Number(rows[0].rating_count) };
}

async function pgOrderRating(orderId) {
  const rows = await db.query('SELECT rating FROM orders WHERE id = $1', [orderId]);
  return rows[0].rating;
}

// ---------------------------------------------------------------------------
// SQLite fixtures (для parity)
// ---------------------------------------------------------------------------

function sqliteCreateRestaurant({ rating = 0, ratingCount = 0 } = {}) {
  return sqliteDb.prepare(
    `INSERT INTO restaurants (name, cuisine, cities, rating, rating_count) VALUES ('Test','test','[]',?,?)`
  ).run(rating, ratingCount).lastInsertRowid;
}

function sqliteCreateOrder(restaurantId, { status = 'delivered', hasPayment = true } = {}) {
  const suffix = uniqueSuffix();
  const info = sqliteDb.prepare(`
    INSERT INTO orders (
      public_code, restaurant_id, city, customer_name, customer_phone, address,
      items_total, commission_amount, status
    ) VALUES (?, ?, 'Грозный', 'Test Customer', ?, 'ул. Тестовая, 1', 500, 35, ?)
  `).run(`YAAM-W6S-${suffix}`, restaurantId, uniquePhone(), status);
  const orderId = info.lastInsertRowid;
  if (hasPayment) {
    sqliteDb.prepare(`INSERT INTO payments (order_id, amount, status) VALUES (?, 500, 'succeeded')`).run(orderId);
  }
  return orderId;
}

// ---------------------------------------------------------------------------
// Happy path / диапазон оценки
// ---------------------------------------------------------------------------

test('rateOrder: успешная оценка доставленного оплаченного заказа — order.rating и restaurant-агрегат обновлены', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);

  const result = await pgOrderService.rateOrder(order.id, 4);
  assert.equal(result.rating, 4);
  assert.equal(await pgOrderRating(order.id), 4);

  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 1);
  assert.equal(restaurant.rating, 4);
});

test('rateOrder: минимальная оценка (1) принимается', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);
  const result = await pgOrderService.rateOrder(order.id, 1);
  assert.equal(result.rating, 1);
});

test('rateOrder: максимальная оценка (5) принимается', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);
  const result = await pgOrderService.rateOrder(order.id, 5);
  assert.equal(result.rating, 5);
});

test('rateOrder: невалидные значения оценки отклоняются с тем же сообщением', async () => {
  const restaurantId = await pgCreateRestaurant();
  const invalidValues = [0, 6, -1, 3.5, '5', null, undefined, NaN, {}, []];
  for (const value of invalidValues) {
    const order = await pgCreateOrder(restaurantId);
    await assert.rejects(
      () => pgOrderService.rateOrder(order.id, value),
      (err) => {
        assert.equal(err.message, 'оценка должна быть 1..5', `значение ${JSON.stringify(value)} должно быть отклонено`);
        return true;
      }
    );
  }
});

// ---------------------------------------------------------------------------
// Существование / статус / оплата
// ---------------------------------------------------------------------------

test('rateOrder: отсутствующий заказ — Error("заказ не найден")', async () => {
  await assert.rejects(() => pgOrderService.rateOrder(999999999, 5), { message: 'заказ не найден' });
});

const INVALID_STATUSES = [
  'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing',
  'courier', 'payment_failed', 'declined', 'timed_out', 'cancelled',
];

for (const status of INVALID_STATUSES) {
  test(`rateOrder: заказ в статусе "${status}" — Error("оценить можно только доставленный заказ")`, async () => {
    const restaurantId = await pgCreateRestaurant();
    const order = await pgCreateOrder(restaurantId, { status });
    await assert.rejects(() => pgOrderService.rateOrder(order.id, 5), { message: 'оценить можно только доставленный заказ' });
  });
}

test('rateOrder: доставленный заказ без succeeded-платежа — Error("заказ не оплачен")', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId, { hasPayment: false });
  await assert.rejects(() => pgOrderService.rateOrder(order.id, 5), { message: 'заказ не оплачен' });
});

test('rateOrder: повторная оценка того же заказа — Error("вы уже оценили этот заказ"), агрегат не меняется дважды', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(order.id, 5);
  await assert.rejects(() => pgOrderService.rateOrder(order.id, 3), { message: 'вы уже оценили этот заказ' });

  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 1, 'повторная оценка не должна была увеличить rating_count');
  assert.equal(restaurant.rating, 5);
});

// ---------------------------------------------------------------------------
// Агрегат: rating_count / средний рейтинг
// ---------------------------------------------------------------------------

test('rateOrder: последовательные оценки корректно увеличивают rating_count', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orderA = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(orderA.id, 5);
  assert.equal((await pgRestaurantRow(restaurantId)).rating_count, 1);

  const orderB = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(orderB.id, 5);
  assert.equal((await pgRestaurantRow(restaurantId)).rating_count, 2);

  const orderC = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(orderC.id, 5);
  assert.equal((await pgRestaurantRow(restaurantId)).rating_count, 3);
});

test('rateOrder: среднее корректно вычисляется по формуле оригинала (последовательно, 5 затем 3 -> 4)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orderA = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(orderA.id, 5);
  const orderB = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(orderB.id, 3);

  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating, 4, '(5+3)/2 = 4');
  assert.equal(restaurant.rating_count, 2);
});

test('rateOrder: среднее с округлением до 1 знака после запятой (5,5,4 -> 4.7)', async () => {
  const restaurantId = await pgCreateRestaurant();
  for (const rating of [5, 5, 4]) {
    const order = await pgCreateOrder(restaurantId);
    await pgOrderService.rateOrder(order.id, rating);
  }
  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating, 4.7, 'round((5+5+4)/3 * 10)/10 = round(46.666)/10 = 4.7');
  assert.equal(restaurant.rating_count, 3);
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test('rateOrder: rollback — искусственная ошибка МЕЖДУ UPDATE orders и SELECT...FOR UPDATE restaurants — order.rating не персистируется', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);

  await assert.rejects(
    () =>
      db.transaction(async (client) => {
        const updated = await db.execute(
          'UPDATE orders SET rating = $1 WHERE id = $2 AND rating IS NULL',
          [5, order.id],
          client
        );
        assert.equal(updated.rowCount, 1);
        throw new Error('искусственная ошибка после UPDATE orders, до SELECT FOR UPDATE restaurants');
      }),
    /искусственная ошибка/
  );

  assert.equal(await pgOrderRating(order.id), null, 'UPDATE orders должен был полностью откатиться');
  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 0);
});

test('rateOrder: rollback — искусственная ошибка МЕЖДУ SELECT...FOR UPDATE и UPDATE restaurants — ни order, ни restaurant не персистируются', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);

  await assert.rejects(
    () =>
      db.transaction(async (client) => {
        await db.execute('UPDATE orders SET rating = $1 WHERE id = $2 AND rating IS NULL', [5, order.id], client);
        const restaurantRows = await db.query(
          'SELECT rating, rating_count FROM restaurants WHERE id = $1 FOR UPDATE',
          [restaurantId],
          client
        );
        assert.ok(restaurantRows[0]);
        throw new Error('искусственная ошибка после SELECT FOR UPDATE, до UPDATE restaurants');
      }),
    /искусственная ошибка/
  );

  assert.equal(await pgOrderRating(order.id), null, 'заказ не должен был получить рейтинг — вся операция атомарна');
  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 0, 'агрегат ресторана не должен был измениться');
  assert.equal(restaurant.rating, 0);
});

// ---------------------------------------------------------------------------
// Concurrency — один заказ
// ---------------------------------------------------------------------------

test('rateOrder: два конкурентных UPDATE orders на один заказ — успешен ровно один (детерминированное доказательство)', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);

  const clientA = cluster.getClient(DATABASE_NAME);
  const clientB = cluster.getClient(DATABASE_NAME);
  const pidA = await connectWithPid(clientA);
  const pidB = await connectWithPid(clientB);

  await clientA.query('BEGIN');
  const resA = await clientA.query('UPDATE orders SET rating = 5 WHERE id = $1 AND rating IS NULL', [order.id]);

  await clientB.query('BEGIN');
  const bPromise = clientB.query('UPDATE orders SET rating = 3 WHERE id = $1 AND rating IS NULL', [order.id]);
  await waitForBackendLock(monitor, pidB);
  await clientA.query('COMMIT');
  const resB = await bPromise;
  await clientB.query('COMMIT');

  assert.equal(resA.rowCount, 1);
  assert.equal(resB.rowCount, 0, 'второй конкурент не должен был применить UPDATE повторно');
  await clientA.end();
  await clientB.end();

  // Реальный API-вызов поверх того же принципа: конкурентные rateOrder на
  // один и тот же заказ — успешен ровно один, проигравший получает штатную
  // доменную ошибку, а не сырую PostgreSQL-ошибку.
  const order2 = await pgCreateOrder(restaurantId);
  const results = await Promise.allSettled([
    pgOrderService.rateOrder(order2.id, 5),
    pgOrderService.rateOrder(order2.id, 3),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'ровно один конкурент должен успешно оценить заказ');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.message, 'вы уже оценили этот заказ');

  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 1, 'агрегат должен был увеличиться ровно один раз, а не дважды');
});

// ---------------------------------------------------------------------------
// Concurrency — разные заказы одного ресторана
// ---------------------------------------------------------------------------

test('rateOrder: два конкурентных вызова для РАЗНЫХ заказов одного ресторана — оба успешны, ни одна оценка не теряется', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orderA = await pgCreateOrder(restaurantId);
  const orderB = await pgCreateOrder(restaurantId);

  const [ra, rb] = await Promise.all([
    pgOrderService.rateOrder(orderA.id, 5),
    pgOrderService.rateOrder(orderB.id, 3),
  ]);
  assert.equal(ra.rating, 5);
  assert.equal(rb.rating, 3);

  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 2, 'lost update отсутствует — обе оценки учтены');
  assert.equal(restaurant.rating, 4, '(5+3)/2 = 4 независимо от порядка применения (округление не влияет на этот случай)');
});

test('rateOrder: 6 конкурентных оценок одного ресторана — rating_count и rating точно соответствуют всем успешным оценкам', async () => {
  const restaurantId = await pgCreateRestaurant();
  const orders = await Promise.all(Array.from({ length: 6 }, () => pgCreateOrder(restaurantId)));

  // Все оценки равны 5 — итоговое среднее детерминировано (5) НЕЗАВИСИМО от
  // порядка применения под FOR UPDATE, что даёт возможность точно проверить
  // rating_count/rating без гонки за порядок побед в реальном конкурентном
  // прогоне (см. соседний тест на точное среднее по 2 заказам).
  const results = await Promise.all(orders.map((order) => pgOrderService.rateOrder(order.id, 5)));
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.rating === 5));

  const restaurant = await pgRestaurantRow(restaurantId);
  assert.equal(restaurant.rating_count, 6, 'ни одна из 6 конкурентных оценок не должна была потеряться');
  assert.equal(restaurant.rating, 5);
});

test('rateOrder: конкурентные оценки ДВУХ РАЗНЫХ ресторанов одновременно — нет взаимного влияния, нет deadlock', async () => {
  const restaurantX = await pgCreateRestaurant();
  const restaurantY = await pgCreateRestaurant();
  const ordersX = await Promise.all(Array.from({ length: 3 }, () => pgCreateOrder(restaurantX)));
  const ordersY = await Promise.all(Array.from({ length: 3 }, () => pgCreateOrder(restaurantY)));

  const allCalls = [
    ...ordersX.map((o) => pgOrderService.rateOrder(o.id, 5)),
    ...ordersY.map((o) => pgOrderService.rateOrder(o.id, 3)),
  ];
  const results = await Promise.all(allCalls);
  assert.equal(results.length, 6);

  const restX = await pgRestaurantRow(restaurantX);
  const restY = await pgRestaurantRow(restaurantY);
  assert.equal(restX.rating_count, 3);
  assert.equal(restX.rating, 5);
  assert.equal(restY.rating_count, 3);
  assert.equal(restY.rating, 3);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('rateOrder: пул возвращён, waitingCount=0', async () => {
  const restaurantId = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurantId);
  await pgOrderService.rateOrder(order.id, 5);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});

// ---------------------------------------------------------------------------
// Parity — rateOrder синхронна и без сети в ОБЕИХ версиях, полное сравнение возможно
// ---------------------------------------------------------------------------

test('Parity: rateOrder — успешная оценка даёт тот же rating и тот же агрегат ресторана', async () => {
  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId);
  const pgResult = await pgOrderService.rateOrder(pgOrder.id, 4);

  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrderId = sqliteCreateOrder(sqliteRestaurantId);
  const sqliteResult = sqliteOrderService.rateOrder(sqliteOrderId, 4);

  assert.equal(pgResult.rating, sqliteResult.rating);
  const pgRestaurant = await pgRestaurantRow(pgRestaurantId);
  const sqliteRestaurant = sqliteDb.prepare('SELECT rating, rating_count FROM restaurants WHERE id = ?').get(sqliteRestaurantId);
  assert.equal(pgRestaurant.rating, sqliteRestaurant.rating);
  assert.equal(pgRestaurant.rating_count, sqliteRestaurant.rating_count);
});

test('Parity: rateOrder — невалидная оценка даёт дословно то же сообщение', async () => {
  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId);
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrderId = sqliteCreateOrder(sqliteRestaurantId);

  await assert.rejects(() => pgOrderService.rateOrder(pgOrder.id, 7), { message: 'оценка должна быть 1..5' });
  assert.throws(() => sqliteOrderService.rateOrder(sqliteOrderId, 7), { message: 'оценка должна быть 1..5' });
});

test('Parity: rateOrder — заказ в неверном статусе даёт дословно то же сообщение', async () => {
  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId, { status: 'accepted' });
  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrderId = sqliteCreateOrder(sqliteRestaurantId, { status: 'accepted' });

  await assert.rejects(() => pgOrderService.rateOrder(pgOrder.id, 5), { message: 'оценить можно только доставленный заказ' });
  assert.throws(() => sqliteOrderService.rateOrder(sqliteOrderId, 5), { message: 'оценить можно только доставленный заказ' });
});

test('Parity: rateOrder — отсутствующий заказ даёт дословно то же сообщение', async () => {
  await assert.rejects(() => pgOrderService.rateOrder(999999999, 5), { message: 'заказ не найден' });
  assert.throws(() => sqliteOrderService.rateOrder(999999999, 5), { message: 'заказ не найден' });
});

test('Parity: rateOrder — повторная оценка даёт дословно то же сообщение', async () => {
  const pgRestaurantId = await pgCreateRestaurant();
  const pgOrder = await pgCreateOrder(pgRestaurantId);
  await pgOrderService.rateOrder(pgOrder.id, 5);

  const sqliteRestaurantId = sqliteCreateRestaurant();
  const sqliteOrderId = sqliteCreateOrder(sqliteRestaurantId);
  sqliteOrderService.rateOrder(sqliteOrderId, 5);

  await assert.rejects(() => pgOrderService.rateOrder(pgOrder.id, 3), { message: 'вы уже оценили этот заказ' });
  assert.throws(() => sqliteOrderService.rateOrder(sqliteOrderId, 3), { message: 'вы уже оценили этот заказ' });
});
