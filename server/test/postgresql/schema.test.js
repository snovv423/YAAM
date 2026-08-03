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
  // Stage 22 — реестр отвергнутых webhook и счётчик номеров документов.
  'webhook_rejections',
  'document_number_counters',
  'restaurants', 'categories', 'menu_items', 'orders', 'order_access_credentials',
  // Фича «Поделиться заказом» — read-only share-токен, отдельный от
  // order_access_credentials (см. orderShareService.js).
  'order_share_tokens',
  'order_items', 'payments', 'payment_retry_attempts', 'payment_retry_keys',
  'payment_presentations', 'payment_initial_attempts', 'refunds',
  // YAAM HQ Stage 3 (владелец HQ в PostgreSQL вместо .env) — см.
  // db/postgresql/schema.sql.
  'hq_owner', 'hq_security_log',
  // YAAM HQ Stage 4 (журнал административных изменений раздела «Рестораны»).
  'hq_audit_log',
  // YAAM HQ Stage 5B (медиа-система: фотографии ресторанов и блюд).
  'restaurant_photos', 'menu_item_photos',
  // YAAM HQ Stage 6 (юридические данные/банковские реквизиты/договор).
  'restaurant_legal_details', 'restaurant_bank_details', 'restaurant_contracts',
  // YAAM HQ Stage 8 (расчётные периоды и immutable snapshot обязательств).
  'settlement_periods', 'settlement_restaurant_lines', 'settlement_order_lines', 'settlement_refunds',
  'settlement_adjustments',
  // YAAM HQ Stage 13 — перенос долга и capability-доступ к документам.
  'restaurant_settlement_balances', 'restaurant_balance_entries',
  'settlement_document_access_tokens',
  // YAAM HQ Stage 14 — юр.данные YAAM и фискальные чеки.
  'yaam_legal_details', 'fiscal_receipts',
  // Stage 15 — хранилище HQ-сессий в PostgreSQL (было MemoryStore).
  'hq_sessions',
  // YAAM HQ Stage 9 (payout entity — без банковской интеграции).
  'restaurant_payouts',
  // YAAM HQ Stage 9.5 (payout attempts — реальные попытки обращения к банку).
  'payout_attempts',
  // YAAM HQ Stage 9.6 (T-Bank integration readiness): реквизиты YAAM как
  // плательщика (singleton) + неизменяемый снимок реквизитов на попытку.
  'yaam_bank_details', 'payout_attempt_requisites',
  // HQ «Обзор» — Центр событий (docs/HQ-PRODUCT-SPEC.md).
  'hq_events',
  // Расчётные документы периода: «Отчёт агента» и «Реестр заказов».
  'settlement_documents',
];

const EXPECTED_INDEXES = {
  ux_payments_one_active_per_order: { unique: true, partial: true },
  ux_payments_provider_reference: { unique: true, partial: true },
  // Единственный из 6 — обычный (не UNIQUE) индекс, см. server/db/postgresql/schema.sql
  ix_payment_retry_keys_payment: { unique: false, partial: false },
  ux_refunds_one_active_per_payment: { unique: true, partial: true },
  ux_refunds_one_succeeded_per_payment: { unique: true, partial: true },
  ux_refunds_provider_reference: { unique: true, partial: true },
  // YAAM HQ Stage 5B — ровно одна активная primary-фотография на владельца.
  ux_restaurant_photos_one_primary: { unique: true, partial: true },
  ux_menu_item_photos_one_primary: { unique: true, partial: true },
  // Stage 5B.1 — фотографиям больше не нужен archived_at (удаление
  // необратимо), поэтому "active"-индексы переименованы в "owner" и
  // перестали быть partial (нет WHERE archived_at IS NULL).
  ix_restaurant_photos_owner: { unique: false, partial: false },
  ix_menu_item_photos_owner: { unique: false, partial: false },
  // HQ «Обзор» — Центр событий (docs/HQ-PRODUCT-SPEC.md): сортировка ленты.
  ix_hq_events_occurred_at: { unique: false, partial: false },
};

// Таблицы, где по схеме есть колонка created_at (categories/menu_items/order_items — нет).
const TABLES_WITH_CREATED_AT = [
  'restaurants', 'orders', 'order_access_credentials', 'order_share_tokens', 'payments',
  'payment_retry_attempts', 'payment_retry_keys', 'payment_presentations',
  'payment_initial_attempts', 'refunds',
  'hq_owner', 'hq_security_log', 'hq_audit_log',
  'restaurant_photos', 'menu_item_photos',
  'restaurant_legal_details', 'restaurant_bank_details', 'restaurant_contracts',
  // YAAM HQ Stage 8.
  'settlement_periods', 'settlement_restaurant_lines', 'settlement_order_lines', 'settlement_refunds',
  // YAAM HQ Stage 9.
  'restaurant_payouts',
  // YAAM HQ Stage 9.5.
  'payout_attempts',
  // YAAM HQ Stage 9.6 — yaam_bank_details имеет created_at; payout_attempt_
  // requisites тоже (но не updated_at — строка неизменяема с момента вставки,
  // "updated" не может произойти никогда, поэтому этой колонки у неё нет).
  'yaam_bank_details', 'payout_attempt_requisites',
  // Документы расчётного периода.
  'settlement_adjustments',
  'settlement_documents',
  // Stage 13 — ledger долга и capability-токены документов.
  // restaurant_settlement_balances сюда НЕ входит: это текущее состояние с
  // updated_at, а не событие с моментом создания.
  'restaurant_balance_entries',
  'settlement_document_access_tokens',
  // Stage 14.
  'yaam_legal_details', 'fiscal_receipts',
];

const EXPECTED_FUNCTIONS = [
  'fn_refunds_amount_matches_payment',
  'fn_refunds_block_after_succeeded',
  'fn_refunds_immutable_fields',
  // YAAM HQ Stage 8 — immutability triggers на settlement_periods/
  // settlement_restaurant_lines/settlement_order_lines/settlement_refunds.
  'fn_settlement_period_immutable_after_close',
  'fn_settlement_period_block_delete_after_close',
  'fn_settlement_snapshot_row_immutable',
  // YAAM HQ Stage 9 — state-machine + immutability на restaurant_payouts
  // (тела функций ОБНОВЛЕНЫ в Stage 9.5 — CREATE OR REPLACE, имена те же).
  'fn_restaurant_payouts_valid_transition',
  'fn_restaurant_payouts_immutable_after_terminal',
  'fn_restaurant_payouts_block_delete_after_terminal',
  // YAAM HQ Stage 9.5 — state-machine + immutability на payout_attempts.
  'fn_payout_attempts_valid_transition',
  'fn_payout_attempts_immutable_after_terminal',
  'fn_payout_attempts_block_delete_after_terminal',
  // YAAM HQ Stage 9.6 — безусловная immutability на payout_attempt_requisites
  // (одна функция обслуживает и UPDATE-, и DELETE-триггер — см. schema.sql).
  'fn_fiscal_receipts_payload_immutable',
  'fn_payout_attempt_requisites_immutable',
  // YAAM HQ Stage 9.8 (аудит Stage 9.7, находка F2) — amount неизменяем с
  // момента создания restaurant_payouts, отдельная функция/триггер, не
  // встроено в fn_restaurant_payouts_valid_transition.
  'fn_restaurant_payouts_amount_immutable',
  // Документы периода неизменяемы — корректировка выпускает новую версию.
  'fn_settlement_document_chain_consistent',
  'fn_settlement_documents_immutable',
];

// event — массив (не строка): некоторые Stage 8 триггеры объявлены как
// "BEFORE UPDATE OR DELETE" ОДНИМ CREATE TRIGGER — information_schema.triggers
// показывает такой триггер как ПО ОДНОЙ СТРОКЕ НА КАЖДОЕ событие (тот же
// триггер, то же имя, две строки с разным event_manipulation) — это
// задокументированное поведение representation в information_schema, не
// два физически разных триггера.
const EXPECTED_TRIGGERS = {
  trg_refunds_amount_matches_payment: ['INSERT'],
  trg_refunds_block_after_succeeded: ['INSERT'],
  trg_refunds_immutable_fields: ['UPDATE'],
  trg_settlement_period_block_update_after_close: ['UPDATE'],
  trg_settlement_period_block_delete_after_close: ['DELETE'],
  trg_settlement_restaurant_lines_immutable: ['UPDATE', 'DELETE'],
  trg_settlement_order_lines_immutable: ['UPDATE', 'DELETE'],
  trg_settlement_refunds_immutable: ['UPDATE', 'DELETE'],
  trg_restaurant_payouts_valid_transition: ['UPDATE'],
  trg_restaurant_payouts_block_update_after_terminal: ['UPDATE'],
  trg_restaurant_payouts_block_delete_after_terminal: ['DELETE'],
  trg_payout_attempts_valid_transition: ['UPDATE'],
  trg_payout_attempts_block_update_after_terminal: ['UPDATE'],
  trg_payout_attempts_block_delete_after_terminal: ['DELETE'],
  trg_payout_attempt_requisites_block_update: ['UPDATE'],
  trg_payout_attempt_requisites_block_delete: ['DELETE'],
  trg_restaurant_payouts_amount_immutable: ['UPDATE'],
  trg_settlement_documents_immutable: ['UPDATE', 'DELETE'],
  // Цепочка корректирующих версий: период/ресторан/вид/номер версии.
  trg_settlement_document_chain: ['INSERT'],
  // Сторно позднего возврата — такая же неизменяемая финансовая запись.
  trg_settlement_adjustments_immutable: ['UPDATE', 'DELETE'],
  // Проводка долга — такая же неизменяемая финансовая запись.
  trg_restaurant_balance_entries_immutable: ['UPDATE', 'DELETE'],
  // payload и связи чека неизменяемы; статус и попытки меняться могут.
  trg_fiscal_receipts_payload_immutable: ['UPDATE'],
};

// hq_owner НЕ входит: его id — фиксированная константа (DEFAULT 1 CHECK
// id=1), не GENERATED ALWAYS AS IDENTITY (единственная строка никогда не
// "автоинкрементируется" — см. db/postgresql/schema.sql).
const IDENTITY_TABLES = [
  'restaurants', 'categories', 'menu_items', 'orders', 'order_items', 'payments', 'refunds',
  'hq_security_log', 'hq_audit_log', 'restaurant_photos', 'menu_item_photos',
  // YAAM HQ Stage 8.
  'settlement_periods', 'settlement_restaurant_lines', 'settlement_order_lines', 'settlement_refunds',
  // YAAM HQ Stage 9.
  'restaurant_payouts',
  // YAAM HQ Stage 9.5.
  'payout_attempts',
  // HQ «Обзор» — Центр событий (docs/HQ-PRODUCT-SPEC.md).
  'hq_events',
  // Расчётные документы периода: «Отчёт агента» и «Реестр заказов».
  'settlement_adjustments',
  'settlement_documents',
];

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

    await t.test('создаются все 40 таблиц', async () => {
      const { rows } = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      );
      const names = rows.map((r) => r.tablename).sort();
      assert.deepEqual(names, [...EXPECTED_TABLES].sort());
    });

    await t.test('создаются все 53 внешних ключа', async () => {
      // Stage 25 добавила один новый FK: menu_items.archived_with_category_id
      // -> categories(id) (миграция 0006) — было 52, стало 53.
      const { rows } = await client.query(`
        SELECT count(*)::int AS n
        FROM information_schema.table_constraints
        WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
      `);
      assert.equal(rows[0].n, 53);
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

    await t.test('создаются все 11 индексов, из них 7 partial unique', async () => {
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
      assert.equal(Object.keys(byName).length, 11, 'ожидали ровно 11 именованных индексов из schema.sql');

      let partialUniqueCount = 0;
      for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
        const actual = byName[name];
        assert.ok(actual, `индекс ${name} не найден`);
        assert.equal(actual.is_unique, expected.unique, `${name}: ожидали unique=${expected.unique}`);
        assert.equal(actual.is_partial, expected.partial, `${name}: ожидали partial=${expected.partial}`);
        if (actual.is_partial && actual.is_unique) partialUniqueCount += 1;
      }
      assert.equal(partialUniqueCount, 7, 'ожидали ровно 7 partial UNIQUE индексов');
    });

    await t.test('создаются 17 PL/pgSQL-функций', async () => {
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

    await t.test('создаются 22 триггера (refunds + Stage 8 settlement-immutability + Stage 9/9.5/9.6/9.8 payout state machine) с ожидаемыми событиями', async () => {
      const { rows } = await client.query(`
        SELECT trigger_name, event_manipulation, event_object_table
        FROM information_schema.triggers
        WHERE trigger_schema = 'public'
        ORDER BY trigger_name, event_manipulation
      `);
      // По одному Set событий на имя триггера — многособытийный (UPDATE OR
      // DELETE) триггер даёт несколько строк с одним и тем же именем (см.
      // комментарий у EXPECTED_TRIGGERS выше), поэтому группируем в Set, а не
      // перезаписываем последней строкой.
      const eventsByName = new Map();
      const tableByName = new Map();
      for (const r of rows) {
        if (!eventsByName.has(r.trigger_name)) eventsByName.set(r.trigger_name, new Set());
        eventsByName.get(r.trigger_name).add(r.event_manipulation);
        tableByName.set(r.trigger_name, r.event_object_table);
      }
      assert.equal(eventsByName.size, 22, `ожидали 22 различных триггеров, получили: ${[...eventsByName.keys()].join(', ')}`);

      const EXPECTED_TABLE_BY_TRIGGER = {
        trg_refunds_amount_matches_payment: 'refunds',
        trg_refunds_block_after_succeeded: 'refunds',
        trg_refunds_immutable_fields: 'refunds',
        trg_settlement_period_block_update_after_close: 'settlement_periods',
        trg_settlement_period_block_delete_after_close: 'settlement_periods',
        trg_settlement_restaurant_lines_immutable: 'settlement_restaurant_lines',
        trg_settlement_order_lines_immutable: 'settlement_order_lines',
        trg_settlement_refunds_immutable: 'settlement_refunds',
        trg_restaurant_payouts_valid_transition: 'restaurant_payouts',
        trg_restaurant_payouts_block_update_after_terminal: 'restaurant_payouts',
        trg_restaurant_payouts_block_delete_after_terminal: 'restaurant_payouts',
        trg_restaurant_payouts_amount_immutable: 'restaurant_payouts',
        trg_settlement_documents_immutable: 'settlement_documents',
        trg_settlement_document_chain: 'settlement_documents',
        trg_settlement_adjustments_immutable: 'settlement_adjustments',
        trg_restaurant_balance_entries_immutable: 'restaurant_balance_entries',
        trg_fiscal_receipts_payload_immutable: 'fiscal_receipts',
        trg_payout_attempts_valid_transition: 'payout_attempts',
        trg_payout_attempts_block_update_after_terminal: 'payout_attempts',
        trg_payout_attempts_block_delete_after_terminal: 'payout_attempts',
        trg_payout_attempt_requisites_block_update: 'payout_attempt_requisites',
        trg_payout_attempt_requisites_block_delete: 'payout_attempt_requisites',
      };
      for (const [name, expectedEvents] of Object.entries(EXPECTED_TRIGGERS)) {
        assert.ok(eventsByName.has(name), `триггер ${name} не найден`);
        assert.equal(tableByName.get(name), EXPECTED_TABLE_BY_TRIGGER[name]);
        assert.deepEqual([...eventsByName.get(name)].sort(), [...expectedEvents].sort(), `${name}: неожиданный набор событий`);
      }
    });

    await t.test('IDENTITY корректна на всех 17 автоинкрементных таблицах', async () => {
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

    await t.test('DEFAULT NOW() присутствует на всех 30 датовых колонках created_at', async () => {
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
