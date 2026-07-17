'use strict';

// Задача 1 (YAAM-postgresql-embedded-live-validation): исполняет
// server/db/postgresql/schema.sql против настоящего embedded PostgreSQL 16.14
// и проверяет результат через системные каталоги (information_schema/
// pg_catalog), а не через чтение текста файла. Схема исполняется на ДВУХ
// отдельных, изначально пустых базах на одном кластере, чтобы подтвердить
// воспроизводимость "с нуля" (не полагаясь на состояние первой базы).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const EXPECTED_TABLES = [
  'restaurants', 'categories', 'menu_items', 'orders', 'order_access_credentials',
  'order_items', 'payments', 'payment_retry_attempts', 'payment_retry_keys',
  'payment_presentations', 'payment_initial_attempts', 'refunds',
];

const EXPECTED_INDEXES = {
  ux_payments_one_active_per_order: { unique: true, partial: true },
  ux_payments_provider_reference: { unique: true, partial: true },
  // Единственный из 6 — обычный (не UNIQUE) индекс, см. server/db/postgresql/schema.sql
  ix_payment_retry_keys_payment: { unique: false, partial: false },
  ux_refunds_one_active_per_payment: { unique: true, partial: true },
  ux_refunds_one_succeeded_per_payment: { unique: true, partial: true },
  ux_refunds_provider_reference: { unique: true, partial: true },
};

// Таблицы, где по схеме есть колонка created_at (categories/menu_items/order_items — нет).
const TABLES_WITH_CREATED_AT = [
  'restaurants', 'orders', 'order_access_credentials', 'payments',
  'payment_retry_attempts', 'payment_retry_keys', 'payment_presentations',
  'payment_initial_attempts', 'refunds',
];

const EXPECTED_FUNCTIONS = [
  'fn_refunds_amount_matches_payment',
  'fn_refunds_block_after_succeeded',
  'fn_refunds_immutable_fields',
];

const EXPECTED_TRIGGERS = {
  trg_refunds_amount_matches_payment: 'INSERT',
  trg_refunds_block_after_succeeded: 'INSERT',
  trg_refunds_immutable_fields: 'UPDATE',
};

const IDENTITY_TABLES = ['restaurants', 'categories', 'menu_items', 'orders', 'order_items', 'payments', 'refunds'];

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('schema');
});

after(async () => {
  await cluster.stop();
});

async function runSchemaAndInspect(t, databaseName) {
  await cluster.createDatabase(databaseName);
  const client = cluster.getClient(databaseName);
  await client.connect();

  try {
    await t.test('schema.sql исполняется с нуля без ошибок', async () => {
      // client.query() без второго аргумента params — simple query protocol,
      // поддерживает многостатементный SQL (BEGIN...COMMIT; весь файл целиком).
      await client.query(SCHEMA_SQL);
    });

    await t.test('создаются все 12 таблиц', async () => {
      const { rows } = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      );
      const names = rows.map((r) => r.tablename).sort();
      assert.deepEqual(names, [...EXPECTED_TABLES].sort());
    });

    await t.test('создаются все 13 внешних ключей', async () => {
      const { rows } = await client.query(`
        SELECT count(*)::int AS n
        FROM information_schema.table_constraints
        WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
      `);
      assert.equal(rows[0].n, 13);
    });

    await t.test('CHECK-ограничения присутствуют (>=12, включая новый на payments.status)', async () => {
      const { rows } = await client.query(`
        SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE contype = 'c' AND connamespace = 'public'::regnamespace
      `);
      assert.ok(rows.length >= 12, `ожидали минимум 12 CHECK, получили ${rows.length}`);
      const onPayments = rows.find((r) => r.table_name === 'payments');
      assert.ok(onPayments, 'ожидали CHECK на payments.status (новый, отсутствовал в SQLite-версии)');
      assert.match(onPayments.def, /status = ANY|status = \(ARRAY|IN \(/);
      const onRefundsAmount = rows.find((r) => r.table_name === 'refunds' && /amount/.test(r.def));
      assert.ok(onRefundsAmount, 'ожидали CHECK(amount > 0) на refunds');
    });

    await t.test('создаются все 6 индексов, из них 5 partial unique', async () => {
      const { rows } = await client.query(`
        SELECT
          i.relname AS index_name,
          ix.indisunique AS is_unique,
          (ix.indpred IS NOT NULL) AS is_partial
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        WHERE t.relnamespace = 'public'::regnamespace
          AND i.relname = ANY($1::text[])
      `, [Object.keys(EXPECTED_INDEXES)]);

      const byName = Object.fromEntries(rows.map((r) => [r.index_name, r]));
      assert.equal(Object.keys(byName).length, 6, 'ожидали ровно 6 именованных индексов из schema.sql');

      let partialUniqueCount = 0;
      for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
        const actual = byName[name];
        assert.ok(actual, `индекс ${name} не найден`);
        assert.equal(actual.is_unique, expected.unique, `${name}: ожидали unique=${expected.unique}`);
        assert.equal(actual.is_partial, expected.partial, `${name}: ожидали partial=${expected.partial}`);
        if (actual.is_partial && actual.is_unique) partialUniqueCount += 1;
      }
      assert.equal(partialUniqueCount, 5, 'ожидали ровно 5 partial UNIQUE индексов');
    });

    await t.test('создаются 3 PL/pgSQL-функции', async () => {
      const { rows } = await client.query(`
        SELECT routine_name, external_language
        FROM information_schema.routines
        WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
        ORDER BY routine_name
      `);
      const names = rows.map((r) => r.routine_name).sort();
      assert.deepEqual(names, [...EXPECTED_FUNCTIONS].sort());
      for (const r of rows) {
        assert.equal(r.external_language, 'PLPGSQL', `${r.routine_name} должна быть PL/pgSQL`);
      }
    });

    await t.test('создаются 3 триггера на refunds с ожидаемым событием', async () => {
      const { rows } = await client.query(`
        SELECT trigger_name, event_manipulation, event_object_table
        FROM information_schema.triggers
        WHERE trigger_schema = 'public'
        ORDER BY trigger_name
      `);
      const byName = {};
      for (const r of rows) {
        byName[r.trigger_name] = r;
      }
      assert.equal(Object.keys(byName).length, 3);
      for (const [name, event] of Object.entries(EXPECTED_TRIGGERS)) {
        assert.ok(byName[name], `триггер ${name} не найден`);
        assert.equal(byName[name].event_object_table, 'refunds');
        assert.equal(byName[name].event_manipulation, event);
      }
    });

    await t.test('IDENTITY корректна на всех 7 автоинкрементных таблицах', async () => {
      for (const table of IDENTITY_TABLES) {
        const { rows } = await client.query(`
          SELECT is_identity, identity_generation
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
        `, [table]);
        assert.equal(rows.length, 1, `${table}.id не найден`);
        assert.equal(rows[0].is_identity, 'YES', `${table}.id должен быть IDENTITY`);
        assert.equal(rows[0].identity_generation, 'ALWAYS', `${table}.id должен быть GENERATED ALWAYS`);
      }
    });

    await t.test('TIMESTAMPTZ используется для дат (orders.created_at)', async () => {
      const { rows } = await client.query(`
        SELECT data_type, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at'
      `);
      assert.equal(rows[0].data_type, 'timestamp with time zone');
      assert.match(rows[0].column_default, /now\(\)/i);
    });

    await t.test('BYTEA используется для хэш-колонок (order_access_credentials.token_hash)', async () => {
      const { rows } = await client.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'order_access_credentials' AND column_name = 'token_hash'
      `);
      assert.equal(rows[0].data_type, 'bytea');
    });

    await t.test('DEFAULT NOW() присутствует на всех 9 датовых колонках created_at', async () => {
      const { rows } = await client.query(`
        SELECT table_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'created_at'
        ORDER BY table_name
      `);
      const names = rows.map((r) => r.table_name).sort();
      assert.deepEqual(names, [...TABLES_WITH_CREATED_AT].sort());
      for (const r of rows) {
        assert.match(r.column_default, /now\(\)/i, `${r.table_name}.created_at должен иметь DEFAULT NOW()`);
      }
    });

    await t.test('никаких SQLite-специфичных объектов (sqlite_master и т.п.) не требуется/не создаётся', async () => {
      const { rows } = await client.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ILIKE 'sqlite%'
      `);
      assert.equal(rows.length, 0);
    });
  } finally {
    await client.end();
  }
}

test('PostgreSQL DDL — live-исполнение на чистой базе A', async (t) => {
  await runSchemaAndInspect(t, 'yaam_ddl_test_a');
});

test('PostgreSQL DDL — повторное исполнение на НОВОЙ чистой базе B подтверждает воспроизводимость', async (t) => {
  await runSchemaAndInspect(t, 'yaam_ddl_test_b');
});
