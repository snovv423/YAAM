'use strict';

// YAAM — PostgreSQL data-access layer (standalone, not wired into the app).
//
// Этот файл — параллельная, изолированная реализация слоя доступа к БД для
// будущего PostgreSQL backend'а. Он НЕ импортируется ни из server.js, ни из
// routes/, ни из orderService.js, ни из bot/ — существующий SQLite backend
// (server/db/index.js) продолжает быть единственным работающим слоем доступа
// к данным. Создание Pool здесь ленивое (см. getPool()) — просто require()
// этого модуля не открывает никакого сетевого соединения.
//
// Официальный драйвер: `pg` (node-postgres, https://node-postgres.com) —
// де-факто стандартный PostgreSQL-клиент экосистемы Node.js.
//
// Архитектурная цель модуля — дать orderService.js (когда для него будет
// отдельная, явно утверждённая задача на async-рефакторинг) те же по форме
// примитивы, что сегодня даёт server/db/index.js (`transaction`,
// `immediateTransaction`), но асинхронные. Это позволяет переводить
// orderService.js на PostgreSQL постепенно, функция за функцией, меняя внутри
// каждой только `db.prepare(...).run(...)` -> `await db.execute(...)`, а не
// переписывающий весь файл в один присест.
//
// Вопрос замены SQLite-модели `BEGIN IMMEDIATE` (single-writer write-lock) на
// PostgreSQL-нативную concurrency-модель (MVCC) НА ЭТОМ ЭТАПЕ НЕ РЕШЁН —
// см. immediateTransaction() ниже и YAAM-postgresql-migration-analysis.pdf,
// раздел 4.

const { Pool } = require('pg');

// -------------------------------------------------------------------------
// Конфигурация через ENV
// -------------------------------------------------------------------------
//
// Приоритет:
//   1. DATABASE_URL (или POSTGRES_URL) — единая connection string, формат
//      `postgres://user:password@host:port/database?sslmode=require`.
//      Это основной, рекомендуемый способ конфигурации (соответствует тому,
//      что managed PostgreSQL у большинства провайдеров, включая Timeweb
//      Cloud, выдаёт готовой строкой — см. YAAM-timeweb-vps-readonly-
//      deployment-plan.pdf, ENV inventory).
//   2. Если DATABASE_URL не задан — раздельные PGHOST/PGPORT/PGDATABASE/
//      PGUSER/PGPASSWORD (эти же имена `pg` умеет читать сам через libpq-
//      совместимые переменные окружения, но мы читаем их явно, чтобы
//      конфигурация была видна в одном месте и не зависела от неявного
//      поведения драйвера).
//
// Доп. настройка пула:
//   PG_POOL_MAX                    — макс. число соединений в пуле (default 10)
//   PG_POOL_IDLE_TIMEOUT_MS         — простаивающий клиент закрывается через (default 30000)
//   PG_POOL_CONNECT_TIMEOUT_MS      — таймаут на установление соединения (default 5000)
//   PG_SSL                          — 'true' включает TLS (нужно для большинства managed-провайдеров)
//   PG_SSL_REJECT_UNAUTHORIZED      — 'false' отключает проверку сертификата (default: проверка включена)
function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;

  const base = connectionString
    ? { connectionString }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
      };

  const ssl =
    process.env.PG_SSL === 'true'
      ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined;

  return {
    ...base,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS || 5000),
  };
}

// -------------------------------------------------------------------------
// Пул соединений (ленивый singleton)
// -------------------------------------------------------------------------

let pool = null;

// Возвращает существующий пул или создаёт новый. Создание Pool(config) само
// по себе не открывает TCP-соединение — pg открывает соединения лениво, при
// первом query()/connect(). Требование задачи "не подключать PostgreSQL к
// работающему приложению" соблюдается тем, что ни один вызывающий код
// приложения не импортирует этот модуль — сам факт наличия getPool() не
// нарушает это ограничение.
function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    // Пул эмитит 'error' при обрыве СВОБОДНОГО (idle) соединения сервером —
    // без этого обработчика необработанное событие 'error' уронит процесс.
    // Логируем только безопасные поля (message/code) — конфигурация пула
    // (включая пароль/connection string) никогда не попадает в лог.
    pool.on('error', (err) => {
      logDbError('idle client error', err);
    });
  }
  return pool;
}

// Закрывает пул и все его соединения. Идемпотентна — повторный вызов после
// закрытия безопасен (pool.end() на уже закрытом пуле у `pg` не бросает).
async function close() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

// -------------------------------------------------------------------------
// Безопасная обработка ошибок
// -------------------------------------------------------------------------

// Оставляет доступными programmatic-поля ошибки PostgreSQL (err.code,
// например '23505' unique_violation, '23503' foreign_key_violation — они
// понадобятся будущему коду reconciliation/orderService для тех же решений,
// для которых сегодня используется сопоставление текста ошибки SQLite в
// server/db/index.js), но гарантирует, что при логировании наружу никогда не
// уходит конфигурация подключения (connection string/пароль лежат на объекте
// Pool/Client, а не на объекте ошибки query — поэтому достаточно логировать
// только явно перечисленные безопасные поля, а не весь err целиком).
function safeErrorFields(err) {
  return {
    message: err && err.message,
    code: err && err.code,
    severity: err && err.severity,
  };
}

function logDbError(context, err) {
  console.error(`[db/postgresql] ${context}`, safeErrorFields(err));
}

// -------------------------------------------------------------------------
// Query / execute helpers
// -------------------------------------------------------------------------

// Для SELECT — возвращает массив строк. `client` необязателен: если передан
// (внутри транзакции), выполняется на нём; иначе берётся временное
// соединение из пула само собой (через pool.query, который делает
// checkout/release автоматически для одиночного запроса).
async function query(text, params = [], client = null) {
  const runner = client || getPool();
  const result = await runner.query(text, params);
  return result.rows;
}

// Для INSERT/UPDATE/DELETE — возвращает { rowCount, rows }. `rows` заполнены,
// только если запрос содержит RETURNING (замена SQLite-паттерна
// `.lastInsertRowid` на `INSERT ... RETURNING id` + `execute(...).rows[0].id`).
// rowCount — замена паттерна `info.changes === 1`, которым orderService.js
// сегодня проверяет, что conditional UPDATE затронул ровно одну строку.
async function execute(text, params = [], client = null) {
  const runner = client || getPool();
  const result = await runner.query(text, params);
  return { rowCount: result.rowCount, rows: result.rows };
}

// -------------------------------------------------------------------------
// Транзакционные примитивы: begin / commit / rollback
// -------------------------------------------------------------------------
//
// Низкоуровневые примитивы для случаев, когда высокоуровневого transaction()
// недостаточно (например, будущий код, которому нужно держать транзакцию
// открытой через несколько отдельных вызовов). Для подавляющего большинства
// случаев следует использовать transaction()/immediateTransaction() ниже —
// они гарантируют commit/rollback и release клиента даже при исключении.

async function beginTransaction() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function commitTransaction(client) {
  try {
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function rollbackTransaction(client) {
  try {
    await client.query('ROLLBACK');
  } catch (err) {
    logDbError('rollback failed', err);
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------------------
// Высокоуровневый transaction helper
// -------------------------------------------------------------------------

// fn(client) — асинхронная функция; получает pg-клиент для выполнения
// query()/execute() внутри той же транзакции (передавать его третьим
// аргументом в query/execute). Commit при успехе, rollback при исключении;
// клиент всегда возвращается в пул (finally), независимо от исхода.
async function transaction(fn) {
  // beginTransaction() сам освобождает клиент и пробрасывает ошибку, если
  // BEGIN не удался — в этом случае ниже нечего откатывать/освобождать.
  const client = await beginTransaction();
  try {
    const result = await fn(client);
    await commitTransaction(client); // COMMIT + release
    return result;
  } catch (err) {
    await rollbackTransaction(client); // ROLLBACK (лог при неудаче) + release
    throw err;
  }
}

// SQLite-версия (server/db/index.js) использует BEGIN IMMEDIATE, чтобы сразу
// взять write-lock и избежать SQLITE_BUSY под single-writer движком — у
// PostgreSQL (MVCC, множественные писатели) нет прямого аналога этой
// операции. Какой конкретно механизм заменит BEGIN IMMEDIATE — row-level
// `SELECT ... FOR UPDATE`, более строгий isolation level с retry-on-
// serialization-failure, или advisory locks — ЭТО РЕШЕНИЕ НЕ ПРИНИМАЕТСЯ НА
// ЭТОМ ЭТАПЕ (см. YAAM-postgresql-migration-analysis.pdf, раздел 4, Critical
// risk). immediateTransaction() существует уже сейчас именно для того, чтобы
// у будущих call site'ов (переносимых из db.immediateTransaction() в
// orderService.js) было одно именованное место для вызова — когда стратегия
// конкурентности будет спроектирована и утверждена отдельной задачей, она
// подключается ЗДЕСЬ, без необходимости трогать вызывающий код второй раз.
async function immediateTransaction(fn) {
  // TODO(postgresql-concurrency-strategy): сейчас — обычная transaction().
  // Не задействовать в денежной логике до отдельного архитектурного решения.
  return transaction(fn);
}

module.exports = {
  getPool,
  close,
  query,
  execute,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  transaction,
  immediateTransaction,
};
