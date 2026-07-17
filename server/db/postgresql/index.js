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
const { AsyncLocalStorage } = require('node:async_hooks');

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
// Высокоуровневый transaction() — concurrency-стратегия (см.
// YAAM-postgresql-concurrency-strategy.pdf для полного обоснования)
// -------------------------------------------------------------------------
//
// Аудит всех 14 текущих SQLite db.immediateTransaction()-вызовов в
// orderService.js (см. отчёт выше) показал: НЕТ одного глобального механизма,
// который подошёл бы всем сразу. Три разных класса операций требуют трёх
// разных нативных PostgreSQL-техник:
//
//   1. Простые atomic conditional state-transition'ы (markPaid,
//      restaurantAccept, finalizeRefundSucceeded и т.д. — `UPDATE ... WHERE
//      id = ? AND status = <ожидаемое>`, проверка rowCount === 1) — уже
//      корректны под ОБЫЧНЫМ READ COMMITTED без единой строки доп. кода:
//      PostgreSQL сам переоценивает WHERE-условие UPDATE после снятия
//      конфликтующей блокировки (EvalPlanQual) — второй конкурирующий UPDATE
//      просто не находит строку с ожидаемым старым статусом и получает
//      rowCount=0. Никакого SELECT ... FOR UPDATE, никакого повышенного
//      isolation level, никакого retry здесь не нужно.
//   2. "Резервация" уникальной сущности (payment/refund reservation) — уже
//      защищена partial UNIQUE indexes в схеме (ux_payments_one_active_per_
//      order, ux_refunds_one_active_per_payment и т.д.) — это ПОСЛЕДНЯЯ
//      линия защиты; конфликтующий INSERT получает 23505 unique_violation,
//      НЕ должен ретраиться (это не транзиентная ошибка — второй попытке
//      всегда нужно просто прочитать уже существующую строку-победителя).
//   3. Read-modify-write БЕЗ conditional-UPDATE-эквивалента (пример из
//      аудита: агрегат рейтинга ресторана — SELECT rating/rating_count,
//      посчитать новое значение в JS, затем безусловный UPDATE — сегодня
//      "безопасно" только благодаря синхронности SQLite; под PostgreSQL это
//      настоящий lost update) — требует SELECT ... FOR UPDATE, чтобы второй
//      клиент физически ждал освобождения строки первым, либо единого
//      атомарного UPDATE-выражения без промежуточного SELECT.
//
// Ни один из трёх классов не описывается табличной/глобальной блокировкой —
// поэтому transaction() НЕ имитирует SQLite BEGIN IMMEDIATE буквально.
// Вместо этого transaction() параметризован: isolationLevel — только когда
// нужен (класс 3 в его "SERIALIZABLE-вместо-FOR-UPDATE" варианте, либо
// операции с невыразимым через UNIQUE-индекс инвариантом вроде time-window
// дедупа в createOrder), retry — только для по-настоящему транзиентных
// SQLSTATE (40001 serialization_failure, 40P01 deadlock_detected), и никогда
// не включён по умолчанию — опечатка не должна тихо начать ретраить чужой
// callback с side effect'ами.

const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

// SQLSTATE, которые ИМЕЮТ СМЫСЛ повторять — обе сигнализируют "транзакция
// целиком не применена, состояние БД консистентно, конкретно ЭТА попытка
// проиграла гонку конкурентному соединению и можно попробовать заново с нуля":
//   40001 serialization_failure — SERIALIZABLE/REPEATABLE READ обнаружили
//     конфликт, который сделал бы историю не сериализуемой.
//   40P01 deadlock_detected — PostgreSQL сам разорвал взаимную блокировку,
//     выбрав эту транзакцию жертвой.
// Намеренно НЕ включены сюда: 23505 (unique_violation — это не транзиентная
// гонка, а осмысленный "кто-то другой уже создал эту сущность", повторный
// точно такой же INSERT даст ту же ошибку снова), 23503 (foreign_key_
// violation — данные реально некорректны), любые не-transient ошибки.
const DEFAULT_RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const HARD_MAX_ATTEMPTS_CEILING = 10; // защита от options.retry.maxAttempts = Infinity/9999 по ошибке
const DEFAULT_RETRY_BASE_DELAY_MS = 20;
const RETRY_DELAY_CAP_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter (см. AWS Architecture Blog, "Exponential Backoff And Jitter") —
// экспоненциальный рост верхней границы, случайная задержка от 0 до неё.
// Смягчает thundering herd при одновременном ретрае нескольких проигравших
// транзакций после общего конфликта.
function backoffWithJitter(baseDelayMs, attempt) {
  const upperBound = Math.min(baseDelayMs * 2 ** (attempt - 1), RETRY_DELAY_CAP_MS);
  return Math.random() * upperBound;
}

// Отслеживает "уже внутри transaction()" на асинхронном стеке текущего
// вызова. Без этой защиты вызов transaction()/serializableTransaction()
// ВНУТРИ callback'а другой transaction() не был бы ошибкой — он просто тихо
// открыл бы ВТОРОЕ, никак не связанное соединение из пула со своей
// независимой BEGIN/COMMIT, полностью изолированной от внешней транзакции
// (внешняя её не видит до своего собственного COMMIT). Это тихо ломает
// атомарность, которую вызывающий код почти наверняка предполагает. Здесь —
// явная ошибка вместо тихого неверного поведения.
const transactionContext = new AsyncLocalStorage();

function assertNotNested(apiName) {
  if (transactionContext.getStore()) {
    throw new Error(
      `${apiName}() called while already inside another transaction() on this async call stack. ` +
        'Nested transaction() calls do NOT nest at the SQL level — each call checks out a NEW, ' +
        'unrelated client from the pool and starts an independent BEGIN/COMMIT, silently breaking ' +
        'the atomicity the caller almost certainly expects. Pass the existing `client` argument into ' +
        'query()/execute() instead of calling transaction()/serializableTransaction() again.'
    );
  }
}

// fn(client, { attempt }) — асинхронная функция; получает pg-клиент для
// query()/execute() внутри транзакции (передавать его третьим аргументом) и
// номер текущей попытки (1 при первом запуске, растёт только если retry
// сконфигурирован и предыдущая попытка получила retryable SQLSTATE).
//
// options:
//   isolationLevel  — null (PostgreSQL default, READ COMMITTED) |
//                      'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'.
//   retry           — null (default — БЕЗ повторов вообще) | {
//                        maxAttempts?: number  (default 3, максимум 10 — жёсткий потолок,
//                                                бесконечный retry невозможен ни при какой конфигурации),
//                        baseDelayMs?: number   (default 20 — экспоненциальный рост с full jitter, потолок 2000мс),
//                        retryOn?: Set<string>  (default {40001, 40P01} — см. выше),
//                      }
//   lockTimeoutMs      — null | number. SET LOCAL lock_timeout сразу после BEGIN — ограничивает,
//                         сколько эта транзакция готова ЖДАТЬ чужую блокировку (напр. в SELECT
//                         ... FOR UPDATE) прежде чем сама получит ошибку (SQLSTATE 55P03) вместо
//                         зависания на неопределённое время.
//   statementTimeoutMs — null | number. SET LOCAL statement_timeout — жёсткий потолок на любой
//                         отдельный запрос внутри транзакции (SQLSTATE 57014 при превышении).
//
// ВАЖНО — задокументированное, не спрятанное поведение:
//   - Если retry задан, fn МОЖЕТ БЫТЬ ВЫЗВАН ПОВТОРНО с нуля (новый client,
//     новый BEGIN) после ROLLBACK предыдущей попытки. fn обязан быть
//     идемпотентным/безопасным для повторного запуска и НЕ должен выполнять
//     необратимые внешние side effects (сетевые вызовы к YooKassa и т.п.) —
//     это ответственность вызывающего кода, transaction() это не проверяет.
//   - err.code (оригинальный SQLSTATE от PostgreSQL) никогда не подменяется
//     и не оборачивается — после исчерпания retry наружу уходит ИСХОДНАЯ
//     ошибка последней попытки, с её настоящим err.code.
//   - Клиент гарантированно возвращается в пул на КАЖДОЙ попытке (успешной
//     или нет) — beginTransaction/commitTransaction/rollbackTransaction сами
//     это гарантируют (см. выше), transaction() лишь их компонует в цикле.
async function transaction(fn, options = {}) {
  assertNotNested('transaction');

  const { isolationLevel = null, retry = null, lockTimeoutMs = null, statementTimeoutMs = null } = options;

  if (isolationLevel !== null && !ISOLATION_LEVELS.has(isolationLevel)) {
    throw new Error(
      `transaction(): недопустимый isolationLevel ${JSON.stringify(isolationLevel)} — ` +
        `допустимы: ${[...ISOLATION_LEVELS].join(', ')}`
    );
  }

  const maxAttempts = retry
    ? Math.min(Math.max(Number(retry.maxAttempts) || DEFAULT_RETRY_MAX_ATTEMPTS, 1), HARD_MAX_ATTEMPTS_CEILING)
    : 1;
  const retryableSqlStates = retry?.retryOn instanceof Set ? retry.retryOn : DEFAULT_RETRYABLE_SQLSTATES;
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  return transactionContext.run(true, async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // beginTransaction() сам освобождает клиент и пробрасывает ошибку, если
      // BEGIN не удался — в этом случае ниже нечего откатывать/освобождать.
      const client = await beginTransaction();
      try {
        // SET LOCAL — действует только до конца ЭТОЙ транзакции, безопасно
        // переустанавливается на каждой попытке retry с нуля.
        if (isolationLevel) {
          await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
        }
        if (lockTimeoutMs !== null) {
          await client.query(`SET LOCAL lock_timeout = '${Number(lockTimeoutMs)}ms'`);
        }
        if (statementTimeoutMs !== null) {
          await client.query(`SET LOCAL statement_timeout = '${Number(statementTimeoutMs)}ms'`);
        }

        const result = await fn(client, { attempt });
        await commitTransaction(client); // COMMIT + release
        return result;
      } catch (err) {
        await rollbackTransaction(client); // ROLLBACK (лог при неудаче) + release

        const canRetry = retry && attempt < maxAttempts && retryableSqlStates.has(err.code);
        if (!canRetry) throw err; // исходная ошибка, err.code не тронут

        await sleep(backoffWithJitter(baseDelayMs, attempt));
        // цикл продолжается — fn будет вызван заново, с нуля, на новом client
      }
    }
    // Недостижимо: цикл либо возвращает результат, либо бросает на последней
    // попытке (canRetry всегда false при attempt === maxAttempts).
    throw new Error('transaction(): retry loop exited without result or error — unreachable');
  });
}

// Удобная обёртка над transaction({ isolationLevel: 'SERIALIZABLE', retry: {...} }).
// SERIALIZABLE — НЕ универсальный ответ на любую гонку (см. комментарий выше
// transaction()): он оправдан только там, где инвариант физически не
// выразим через partial UNIQUE index или conditional UPDATE — например,
// сложные многотабличные проверки или условия по временному окну (аналог
// createOrder's phone+restaurant dedup-проверки в orderService.js). Для
// простых state-transition'ов и уникальных резерваций — обычный
// transaction() без опций либо с partial index в схеме почти всегда дешевле
// и достаточен.
function serializableTransaction(fn, options = {}) {
  const { retry = {}, ...rest } = options;
  return transaction(fn, {
    ...rest,
    isolationLevel: 'SERIALIZABLE',
    retry: {
      maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      retryOn: DEFAULT_RETRYABLE_SQLSTATES,
      ...retry,
    },
  });
}

// SQLite-версия (server/db/index.js) использует BEGIN IMMEDIATE, чтобы сразу
// взять write-lock и избежать SQLITE_BUSY под single-writer движком.
// PostgreSQL (MVCC, множественные писатели) НЕ ИМЕЕТ прямого аналога этой
// операции, и — по итогам аудита выше — ей НЕ НУЖЕН единый заменитель: три
// разных класса операций из orderService.js требуют трёх разных техник
// (conditional UPDATE / partial UNIQUE index / SELECT...FOR UPDATE или
// SERIALIZABLE), см. YAAM-postgresql-concurrency-strategy.pdf.
//
// immediateTransaction() остаётся ТОЛЬКО как совместимый, явно помеченный
// deprecated wrapper — на случай, если какой-то будущий промежуточный шаг
// переноса уже вызывает его по имени. Он НИЧЕГО не гарантирует сверх обычной
// transaction() без опций (см. тест "immediateTransaction(fn) на этом этапе —
// честный делегат в transaction()" в test/postgresql/dbLayer.test.js) — НЕ
// используйте его для нового кода. Для явного намерения используйте
// transaction()/serializableTransaction() с осознанно выбранными опциями по
// соответствующему классу операции из матрицы переноса (см. PDF, раздел "Задача 3").
//
// @deprecated Используйте transaction()/serializableTransaction() явно.
async function immediateTransaction(fn) {
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
  serializableTransaction,
  immediateTransaction,
  // Экспортируется для тестов/диагностики — не предполагается к использованию
  // прикладным кодом напрямую.
  DEFAULT_RETRYABLE_SQLSTATES,
};
