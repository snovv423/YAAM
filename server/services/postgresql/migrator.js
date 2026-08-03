'use strict';

// YAAM — минимальная система миграций PostgreSQL (Stage 15).
//
// ЗАЧЕМ. До этого этапа схему НЕ применял никто: bootstrap только проверял
// переменные окружения и связность, а db/postgresql/schema.sql исполнялся
// исключительно тестами и локальными скриптами. На чистой VPS-базе
// приложение стартовало против ПУСТОЙ базы и падало на первом же запросе.
// Это и есть главный дефект, который здесь закрывается.
//
// ПОЧЕМУ НЕ «ПРИМЕНЯТЬ schema.sql КАЖДЫЙ РАЗ». schema.sql идемпотентен, и
// соблазн выполнять его на каждом старте велик. Но тогда любое будущее
// изменение схемы применялось бы молча, без следа и без порядка, а
// destructive-правку (DROP COLUMN) невозможно было бы отличить от безобидной.
// Задание прямо запрещает такой путь.
//
// МОДЕЛЬ. Две вещи одновременно:
//   1. migrations/0001_baseline.sql — ЗАМОРОЖЕННЫЙ самостоятельный снимок
//      схемы. Выполняется на пустой базе; на существующей совместимой только
//      отмечается применённым. Не редактируется никогда.
//   2. migrations/NNNN_name.sql — упорядоченные, однократные, отслеживаемые
//      изменения поверх baseline. Все будущие правки идут сюда И
//      дублируются в schema.sql, чтобы справочная картина не отставала.
//
// schema.sql в применении схемы НЕ участвует вообще — только справочник.
//
// На уже существующей базе (там, где схема появилась до Stage 15)
// 0001_baseline отмечается применённой БЕЗ выполнения — стандартный приём
// «baseline an existing database». Данные не трогаются.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../../db/postgresql');

const MIGRATIONS_DIR = path.join(__dirname, '../../db/postgresql/migrations');
const BASELINE_VERSION = 1;

// ВАЖНО: этот модуль НЕ ЧИТАЕТ db/postgresql/schema.sql. Раньше читал — и это
// был дефект: 0001 была заглушкой, а фактически применялся текущий schema.sql,
// поэтому смысл «применённой миграции 0001» менялся вместе с проектом, а
// контрольная сумма защищала пустышку. Теперь schema.sql — только справочное
// полное представление для человека; обновление схемы идёт ИСКЛЮЧИТЕЛЬНО
// через файлы migrations/.

// Отдельный от settlement-job ключ: миграции и еженедельный расчёт не должны
// блокировать друг друга.
const MIGRATION_LOCK_KEY = 8724302;

// Таблица учёта. Создаётся до всего остального и сама по себе идемпотентна.
const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms INTEGER
  )`;

// Признаки разрушающей операции. Список намеренно грубый: лучше потребовать
// явного подтверждения на безобидной строке, чем пропустить DROP COLUMN.
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i,
];

// Разрешающий маркер. Автор миграции обязан написать его ЯВНО — тогда
// разрушающее действие становится осознанным решением, а не случайностью,
// проехавшей в общем потоке правок.
const ALLOW_DESTRUCTIVE_MARKER = '-- yaam:allow-destructive';

function checksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

// Читает и упорядочивает файлы миграций. Имя обязано начинаться с номера:
// порядок определяется номером, а не сортировкой строк (иначе 10 оказалось
// бы раньше 9).
function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const m = /^(\d+)[_-](.+)\.sql$/.exec(file);
      if (!m) {
        throw new Error(
          `[migrator] файл миграции "${file}" не соответствует формату NNNN_name.sql — `
          + 'порядок применения определяется номером и не может быть угадан.',
        );
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return {
        version: Number(m[1]),
        name: m[2],
        file,
        sql,
        checksum: checksum(sql),
      };
    })
    .sort((a, b) => a.version - b.version);
}

function assertNoDuplicateVersions(migrations) {
  const seen = new Map();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(
        `[migrator] две миграции с номером ${m.version}: "${seen.get(m.version)}" и "${m.file}". `
        + 'Порядок применения был бы неопределённым.',
      );
    }
    seen.set(m.version, m.file);
  }
}

// Разрушающая миграция без явного маркера не выполняется — вместо этого
// запуск приложения останавливается с внятным объяснением.
function assertNotSilentlyDestructive(migration) {
  if (migration.sql.includes(ALLOW_DESTRUCTIVE_MARKER)) return;
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(migration.sql)) {
      throw new Error(
        `[migrator] миграция "${migration.file}" содержит разрушающую операцию `
        + `(${pattern}), но не помечена маркером "${ALLOW_DESTRUCTIVE_MARKER}". `
        + 'Разрушающие изменения обязаны быть явными.',
      );
    }
  }
}

// --- Совместимость существующей схемы --------------------------------------
//
// ЗАЧЕМ. Нельзя ставить отметку «baseline применён» только потому, что база
// непустая. Наличие одной таблицы orders ещё ничего не доказывает: база могла
// быть создана частично (упавший прогон), могла отстать на несколько версий,
// могла быть чужой. Молчаливая отметка в таком случае навсегда пропускает
// baseline, и приложение работает на схеме, которой не соответствует.
//
// ЧТО ПРОВЕРЯЕМ. Не абсолютное совпадение всех объектов — это сделало бы
// невозможным любое ручное расширение базы. Проверяется КРИТИЧЕСКИЙ минимум,
// без которого текущий код не работает: таблицы, ключевые колонки,
// ограничения, индексы и функции/триггеры, на которые он прямо полагается.
//
// Список намеренно короткий и осмысленный: каждая строка здесь — то, чей
// отсутствие вызвало бы ошибку во время работы, а не косметическое различие.
const REQUIRED_TABLES = [
  'restaurants', 'menu_items', 'orders', 'order_items', 'payments', 'refunds',
  'hq_owner', 'hq_audit_log', 'hq_security_log',
  'settlement_periods', 'settlement_restaurant_lines', 'settlement_order_lines',
  'settlement_refunds', 'settlement_adjustments', 'settlement_documents',
  'restaurant_payouts', 'restaurant_legal_details', 'restaurant_bank_details',
  'restaurant_settlement_balances', 'restaurant_balance_entries',
  'yaam_bank_details', 'yaam_legal_details', 'fiscal_receipts',
];

// Колонки, добавленные поздними этапами: именно по ним отличается «отставшая»
// база от актуальной, и именно их отсутствие роняет расчёт периодов.
const REQUIRED_COLUMNS = [
  ['settlement_restaurant_lines', 'carry_forward_applied'],
  ['settlement_restaurant_lines', 'carry_forward_remaining'],
  ['settlement_restaurant_lines', 'refund_adjustment_restaurant_amount'],
  ['settlement_restaurant_lines', 'refund_adjustment_commission'],
  ['settlement_restaurant_lines', 'payout_blocked_reason'],
  ['settlement_restaurant_lines', 'yaam_ogrnip_snapshot'],
  ['orders', 'status_updated_at'],
  ['orders', 'commission_amount'],
  ['refunds', 'completed_at'],
  ['settlement_documents', 'supersedes_document_id'],
  ['fiscal_receipts', 'idempotency_key'],
];

// Ограничения и индексы, которые ОБЕСПЕЧИВАЮТ инварианты, а не ускоряют
// запросы: без них двойной учёт и двойное удержание становятся возможны.
const REQUIRED_CONSTRAINTS = [
  'settlement_periods_no_overlap',
  'chk_srl_payable_matches_carry_forward',
];
const REQUIRED_INDEXES = [
  'ux_settlement_documents_supersedes',
  'ux_fiscal_receipts_payment',
  'ux_fiscal_receipts_refund',
];

const REQUIRED_FUNCTIONS = [
  'fn_settlement_snapshot_row_immutable',
  'fn_settlement_documents_immutable',
  'fn_settlement_document_chain_consistent',
  'fn_refunds_amount_matches_payment',
  'fn_fiscal_receipts_payload_immutable',
];
const REQUIRED_TRIGGERS = [
  'trg_settlement_restaurant_lines_immutable',
  'trg_settlement_order_lines_immutable',
  'trg_restaurant_balance_entries_immutable',
  'trg_fiscal_receipts_payload_immutable',
];

// Собирает отпечаток схемы одним проходом. Возвращает список НЕДОСТАЮЩЕГО —
// пустой список означает совместимость.
async function inspectSchemaFingerprint(client) {
  const missing = [];

  const tables = new Set((await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`, [], client,
  )).map((r) => r.tablename));
  for (const t of REQUIRED_TABLES) if (!tables.has(t)) missing.push(`таблица ${t}`);

  // Колонки спрашиваем только для существующих таблиц: иначе одна отсутствующая
  // таблица породила бы десяток шумных сообщений про её колонки.
  const columns = new Set((await db.query(
    `SELECT table_name || '.' || column_name AS ref
       FROM information_schema.columns WHERE table_schema = 'public'`, [], client,
  )).map((r) => r.ref));
  for (const [t, c] of REQUIRED_COLUMNS) {
    if (tables.has(t) && !columns.has(`${t}.${c}`)) missing.push(`колонка ${t}.${c}`);
  }

  const constraints = new Set((await db.query(
    'SELECT conname FROM pg_constraint', [], client,
  )).map((r) => r.conname));
  for (const c of REQUIRED_CONSTRAINTS) if (!constraints.has(c)) missing.push(`ограничение ${c}`);

  const indexes = new Set((await db.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`, [], client,
  )).map((r) => r.indexname));
  for (const i of REQUIRED_INDEXES) if (!indexes.has(i)) missing.push(`индекс ${i}`);

  const functions = new Set((await db.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'`, [], client,
  )).map((r) => r.proname));
  for (const f of REQUIRED_FUNCTIONS) if (!functions.has(f)) missing.push(`функция ${f}`);

  const triggers = new Set((await db.query(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`, [], client,
  )).map((r) => r.tgname));
  for (const t of REQUIRED_TRIGGERS) if (!triggers.has(t)) missing.push(`триггер ${t}`);

  return { compatible: missing.length === 0, missing, tableCount: tables.size };
}

// Пустая ли база. Пустая — это ОТСУТСТВИЕ любых пользовательских таблиц, а не
// отсутствие одной конкретной: база с половиной объектов пустой не является и
// обязана разбираться отдельно, а не проскакивать как «уже существующая».
async function isDatabaseEmpty(client) {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    [], client,
  );
  return rows[0].n === 0;
}

async function appliedVersions(client) {
  const rows = await db.query('SELECT version, checksum, name FROM schema_migrations ORDER BY version', [], client);
  return new Map(rows.map((r) => [r.version, r]));
}

// Главная точка входа. Вызывается из lifecycle до того, как приложение
// начнёт принимать запросы.
//
// КОНКУРЕНТНОСТЬ. pg_advisory_lock — БЛОКИРУЮЩИЙ (в отличие от try-варианта
// в еженедельном расчёте): второй процесс обязан ДОЖДАТЬСЯ окончания
// миграций, а не пропустить их и начать работать со старой схемой.
async function migrate({ logger = console } = {}) {
  const migrations = listMigrationFiles();
  assertNoDuplicateVersions(migrations);
  // Baseline проверке на разрушающие операции НЕ подвергается — и это
  // обосновано, а не поблажка. Он выполняется ИСКЛЮЧИТЕЛЬНО на пустой базе
  // (на существующей только отмечается), поэтому уничтожать там нечего.
  // Внутри снимка есть ALTER ... DROP COLUMN IF EXISTS — след того, что
  // schema.sql годами накапливал ALTER'ы поверх CREATE. Помечать снимок
  // маркером «разрешаю разрушение» было бы враньём: разрушения нет.
  // Для ВСЕХ остальных миграций проверка обязательна.
  for (const m of migrations) {
    if (m.version === BASELINE_VERSION) continue;
    assertNotSilentlyDestructive(m);
  }

  const client = await db.getPool().connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(MIGRATIONS_TABLE_SQL);

    const already = await appliedVersions(client);

    // Сверка контрольных сумм: если уже применённый файл изменили, это почти
    // всегда ошибка — база и репозиторий разошлись. Останавливаемся.
    for (const m of migrations) {
      const record = already.get(m.version);
      if (record && record.checksum !== m.checksum) {
        throw new Error(
          `[migrator] миграция ${m.version} ("${m.file}") изменена после применения `
          + '(контрольная сумма не совпадает). База и репозиторий разошлись — '
          + 'нужна новая миграция, а не правка старой.',
        );
      }
    }

    const empty = await isDatabaseEmpty(client);

    // Адопция baseline на СУЩЕСТВУЮЩЕЙ базе разрешена только если её схема
    // доказанно совместима. Иначе — остановка запуска без единого изменения
    // данных: частично созданная или отставшая база должна разбираться
    // человеком, а не «усыновляться» молча.
    const needsBaseline = !already.has(BASELINE_VERSION);
    if (needsBaseline && !empty) {
      const fingerprint = await inspectSchemaFingerprint(client);
      if (!fingerprint.compatible) {
        throw new Error(
          '[migrator] база не пуста, но её схема несовместима с текущим кодом, '
          + 'а таблицы schema_migrations в ней нет. Отметить baseline применённым нельзя — '
          + 'это скрыло бы расхождение навсегда.\n'
          + `Не хватает (${fingerprint.missing.length}):\n`
          + fingerprint.missing.map((m) => `  - ${m}`).join('\n')
          + '\nДанные не изменены. Приведите схему в соответствие вручную '
          + 'или разворачивайте на чистой базе.',
        );
      }
      logger.log(
        `[migrator] существующая база совместима (${fingerprint.tableCount} таблиц) — `
        + 'baseline отмечается применённым без выполнения',
      );
    }

    for (const m of migrations) {
      if (already.has(m.version)) continue;

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        // Baseline на непустой совместимой базе только ОТМЕЧАЕТСЯ. Во всех
        // остальных случаях — включая пустую базу — миграция выполняется как
        // обычный SQL-файл. Никаких спецслучаев с чтением schema.sql больше нет.
        const adoptOnly = m.version === BASELINE_VERSION && !empty;
        if (!adoptOnly) {
          await client.query(m.sql);
        }

        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1,$2,$3,$4)`,
          [m.version, m.name, m.checksum, Date.now() - startedAt],
        );
        await client.query('COMMIT');
        applied.push({ version: m.version, name: m.name, adopted: adoptOnly });
        logger.log(
          `[migrator] ${adoptOnly ? 'отмечена (adopt)' : 'применена'} миграция ${m.version}_${m.name}`,
        );
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // Останавливаем запуск: работать на наполовину мигрированной схеме нельзя.
        throw new Error(`[migrator] миграция ${m.version}_${m.name} не применена: ${err.message}`);
      }
    }

    return { applied, pending: 0 };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Для readiness: все ли миграции репозитория применены к базе.
async function getMigrationStatus() {
  const migrations = listMigrationFiles();
  try {
    const rows = await db.query('SELECT version FROM schema_migrations');
    const appliedSet = new Set(rows.map((r) => r.version));
    const pending = migrations.filter((m) => !appliedSet.has(m.version)).map((m) => m.version);
    return {
      ok: pending.length === 0,
      applied: appliedSet.size,
      total: migrations.length,
      pending,
    };
  } catch (err) {
    // Таблицы нет — миграции не выполнялись вовсе.
    return { ok: false, applied: 0, total: migrations.length, pending: migrations.map((m) => m.version) };
  }
}

module.exports = {
  MIGRATION_LOCK_KEY,
  BASELINE_VERSION,
  ALLOW_DESTRUCTIVE_MARKER,
  inspectSchemaFingerprint,
  isDatabaseEmpty,
  listMigrationFiles,
  assertNoDuplicateVersions,
  assertNotSilentlyDestructive,
  migrate,
  getMigrationStatus,
};
