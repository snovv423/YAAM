'use strict';

// Задача 3 (YAAM-postgresql-embedded-live-validation): проверяет
// server/db/postgresql/index.js против настоящего embedded PostgreSQL 16.14.
//
// DATABASE_URL для db-layer устанавливается ЗДЕСЬ, из значения, которое
// вернул test harness (startEmbeddedPostgres) для собственного эфемерного
// кластера — модуль embeddedPg.js уже стирает любой унаследованный из
// окружения DATABASE_URL/PG* при своей загрузке (см. её комментарии), так
// что до этой строчки переменная гарантированно пуста. db-layer читает
// process.env лениво, внутри getPool(), поэтому установка ДО первого вызова
// query()/execute()/getPool() достаточна.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_dblayer_test';

let cluster;
let db; // server/db/postgresql/index.js, требуется ПОСЛЕ установки DATABASE_URL

before(async () => {
  cluster = await startEmbeddedPostgres('dblayer');
  await cluster.createDatabase(DATABASE_NAME);

  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

test('getPool() возвращает рабочий pg.Pool', async () => {
  const pool = db.getPool();
  assert.equal(typeof pool.query, 'function');
  assert.equal(typeof pool.connect, 'function');
});

test('query() выполняет SELECT и возвращает массив строк', async () => {
  const rows = await db.query('SELECT 1 AS one, $1::text AS echoed', ['hi']);
  assert.deepEqual(rows, [{ one: 1, echoed: 'hi' }]);
});

test('execute() с INSERT ... RETURNING id возвращает rowCount и rows', async () => {
  const { rowCount, rows } = await db.execute(
    `INSERT INTO restaurants (name, cuisine, cities) VALUES ('DB Layer Test', 'test', '[]') RETURNING id`
  );
  assert.equal(rowCount, 1);
  assert.equal(rows.length, 1);
  assert.ok(Number.isInteger(rows[0].id) && rows[0].id > 0);
});

test('execute() с UPDATE возвращает корректный rowCount', async () => {
  const created = await db.execute(
    `INSERT INTO restaurants (name, cuisine, cities) VALUES ('RowCount Test', 'test', '[]') RETURNING id`
  );
  const id = created.rows[0].id;

  const updated = await db.execute(`UPDATE restaurants SET cuisine = 'updated' WHERE id = $1`, [id]);
  assert.equal(updated.rowCount, 1);

  const noMatch = await db.execute(`UPDATE restaurants SET cuisine = 'x' WHERE id = $1`, [-1]);
  assert.equal(noMatch.rowCount, 0);
});

test('beginTransaction()/commitTransaction() — запись после COMMIT сохраняется', async () => {
  const client = await db.beginTransaction();
  const { rows } = await db.execute(
    `INSERT INTO restaurants (name, cuisine, cities) VALUES ('Commit Primitive Test', 'test', '[]') RETURNING id`,
    [],
    client
  );
  await db.commitTransaction(client);

  const after1 = await db.query('SELECT name FROM restaurants WHERE id = $1', [rows[0].id]);
  assert.equal(after1.length, 1);
  assert.equal(after1[0].name, 'Commit Primitive Test');
});

test('beginTransaction()/rollbackTransaction() — запись после ROLLBACK отсутствует', async () => {
  const client = await db.beginTransaction();
  const { rows } = await db.execute(
    `INSERT INTO restaurants (name, cuisine, cities) VALUES ('Rollback Primitive Test', 'test', '[]') RETURNING id`,
    [],
    client
  );
  await db.rollbackTransaction(client);

  const after1 = await db.query('SELECT id FROM restaurants WHERE id = $1', [rows[0].id]);
  assert.equal(after1.length, 0, 'после ROLLBACK строка не должна существовать');
});

test('transaction() при успехе — commit, запись сохраняется, возвращает результат fn', async () => {
  const result = await db.transaction(async (client) => {
    const { rows } = await db.execute(
      `INSERT INTO restaurants (name, cuisine, cities) VALUES ('Tx Success Test', 'test', '[]') RETURNING id`,
      [],
      client
    );
    return rows[0].id;
  });

  assert.ok(Number.isInteger(result));
  const rows = await db.query('SELECT name FROM restaurants WHERE id = $1', [result]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Tx Success Test');
});

test('transaction() при исключении — rollback, запись НЕ сохраняется, ошибка пробрасывается', async () => {
  let insertedId;
  await assert.rejects(
    () => db.transaction(async (client) => {
      const { rows } = await db.execute(
        `INSERT INTO restaurants (name, cuisine, cities) VALUES ('Tx Failure Test', 'test', '[]') RETURNING id`,
        [],
        client
      );
      insertedId = rows[0].id;
      throw new Error('deliberate failure inside transaction()');
    }),
    /deliberate failure inside transaction\(\)/
  );

  const rows = await db.query('SELECT id FROM restaurants WHERE id = $1', [insertedId]);
  assert.equal(rows.length, 0, 'после исключения внутри transaction() запись не должна сохраняться');
});

test('immediateTransaction(fn) на этом этапе — честный делегат в transaction(fn), не отдельная concurrency-стратегия', async () => {
  // Единственное, что здесь допустимо утверждать (см. задание): что вызов
  // проходит через тот же commit/rollback-путь, что и transaction(). НЕ
  // тестируется и НЕ заявляется никакая гарантия конкурентности,
  // эквивалентная SQLite BEGIN IMMEDIATE — такой гарантии сейчас нет.
  const result = await db.immediateTransaction(async (client) => {
    const { rows } = await db.execute(
      `INSERT INTO restaurants (name, cuisine, cities) VALUES ('Immediate Delegate Test', 'test', '[]') RETURNING id`,
      [],
      client
    );
    return rows[0].id;
  });
  const rows = await db.query('SELECT name FROM restaurants WHERE id = $1', [result]);
  assert.equal(rows[0].name, 'Immediate Delegate Test');

  await assert.rejects(
    () => db.immediateTransaction(async () => {
      throw new Error('immediateTransaction rollback check');
    }),
    /immediateTransaction rollback check/
  );
});

test('оригинальный err.code сохраняется — unique_violation даёт код 23505', async () => {
  const code = `dup-${Date.now()}`;
  await db.execute(
    `INSERT INTO restaurants (name, cuisine, cities, connect_code) VALUES ('Dup A', 'test', '[]', $1)`,
    [code]
  );
  await assert.rejects(
    () => db.execute(
      `INSERT INTO restaurants (name, cuisine, cities, connect_code) VALUES ('Dup B', 'test', '[]', $1)`,
      [code]
    ),
    (err) => {
      assert.equal(err.code, '23505');
      return true;
    }
  );
});

test('клиенты возвращаются в пул и после успеха, и после ошибки (нет утечки)', async () => {
  const pool = db.getPool();
  const before1 = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };

  await db.transaction(async (client) => {
    await db.execute(`SELECT 1`, [], client);
  });

  await assert.rejects(
    () => db.transaction(async (client) => {
      await db.execute(`SELECT 1`, [], client);
      throw new Error('force rollback for leak check');
    }),
    /force rollback for leak check/
  );

  // Клиент из failed transaction() тоже обязан вернуться в пул (release()
  // вызывается в rollbackTransaction() в finally) — иначе totalCount рос бы
  // без возврата в idle, и следующий connect() требовал бы нового клиента.
  const after1 = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  assert.equal(after1.waiting, 0, 'не должно быть зависших ожидающих запросов на клиента');
  assert.ok(after1.idle >= 1, 'хотя бы один клиент должен быть свободен в пуле после операций');
  assert.equal(after1.total, after1.idle, 'все клиенты пула сейчас должны быть свободны (idle) — ни один не потерян в checked-out состоянии');
});

test('close() закрывает пул', async () => {
  const poolBeforeClose = db.getPool();
  await db.close();
  await assert.rejects(
    () => poolBeforeClose.query('SELECT 1'),
    /Cannot use a pool after calling end on the pool/
  );
});

test('повторный close() безопасен (не бросает)', async () => {
  await db.close();
  await db.close();
});

test('после close() новый getPool()/query() создаёт новый рабочий pool', async () => {
  const poolBeforeClose = db.getPool();
  await db.close();

  const rows = await db.query('SELECT 1 AS ok');
  assert.deepEqual(rows, [{ ok: 1 }]);

  const poolAfterClose = db.getPool();
  assert.notEqual(poolAfterClose, poolBeforeClose, 'после close() должен быть создан НОВЫЙ экземпляр Pool');
});
