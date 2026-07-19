'use strict';

// YAAM — PostgreSQL bootstrap, Production Switch Stage 6 (operational
// infrastructure). Изолированный, не подключённый к production модуль.
//
// server/db/postgresql/index.js (Stage 1) сознательно НЕ валидирует
// переменные окружения при создании пула — `buildPoolConfig()` тихо
// подставляет дефолты (`PGHOST=localhost`, `PGPORT=5432`), даже если ВООБЩЕ
// ничего не сконфигурировано, и ошибка обнаруживается только при первом
// реальном запросе, сырым текстом драйвера `pg` ("password authentication
// failed", "ECONNREFUSED" и т.п., без указания, какую переменную окружения
// проверить). Это осознанно (см. комментарий над `buildPoolConfig()`
// изначальной задачи — Stage 1 тесты сами всегда явно выставляют
// `DATABASE_URL`, поэтому лениво-дефолтное поведение им не мешало), и этот
// файл его НЕ меняет — `db/postgresql/index.js` не тронут ни строкой, чтобы
// не рисковать уже прошедшими 350+ тестами Stage 1-5, полагающимися на его
// текущее поведение.
//
// Вместо этого — отдельный, чисто аддитивный слой валидации+готовности,
// которым явно пользуется НОВЫЙ код Stage 6 (services/postgresql/
// lifecycle.js, server/server.postgresql.js), а существующие Stage 1-5
// модули как не звали его, так и не зовут — их поведение не меняется.

const db = require('./index');

const CONFIG_HINT =
  'DATABASE_URL (или POSTGRES_URL), либо полный набор PGHOST/PGDATABASE/PGUSER (+ опционально PGPORT/PGPASSWORD)';

// Бросает с понятным, конкретным сообщением (какая именно переменная не так
// и что нужно сделать) — задание явно требует "понятные сообщения об
// ошибках" и "отсутствие silent fallback" (раздел ENV).
function validateEnv(env = process.env) {
  const hasConnectionString = Boolean(env.DATABASE_URL || env.POSTGRES_URL);
  const hasDiscreteVars = Boolean(env.PGHOST && env.PGDATABASE && env.PGUSER);

  if (!hasConnectionString && !hasDiscreteVars) {
    throw new Error(
      `[db/postgresql/bootstrap] не заданы переменные окружения для подключения к PostgreSQL — ` +
        `нужен ${CONFIG_HINT}.`
    );
  }

  if (env.PGPORT !== undefined && env.PGPORT !== '' && !Number.isInteger(Number(env.PGPORT))) {
    throw new Error(`[db/postgresql/bootstrap] PGPORT="${env.PGPORT}" — должно быть целым числом.`);
  }

  if (env.PG_SSL !== undefined && env.PG_SSL !== '' && env.PG_SSL !== 'true' && env.PG_SSL !== 'false') {
    throw new Error(`[db/postgresql/bootstrap] PG_SSL="${env.PG_SSL}" — допустимы только "true" или "false".`);
  }

  if (env.PG_POOL_MAX !== undefined && env.PG_POOL_MAX !== '' && !(Number(env.PG_POOL_MAX) > 0)) {
    throw new Error(`[db/postgresql/bootstrap] PG_POOL_MAX="${env.PG_POOL_MAX}" — должно быть положительным числом.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Реальная проверка связности (не просто "Pool создан" — pg открывает TCP
// лениво, при первом запросе) с retry/backoff — покрывает задание, раздел
// "recovery after DB unavailable": PostgreSQL может быть ещё не готов в
// момент старта процесса (например, оба контейнера/юнита стартуют
// одновременно) — несколько попыток с паузой дают ему время подняться,
// вместо немедленного фатального отказа на первой же попытке.
async function waitForDatabase({ retries = 5, delayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw new Error(
    `[db/postgresql/bootstrap] не удалось подключиться к PostgreSQL за ${retries} попыток ` +
      `(последняя ошибка: ${lastErr.message}). Проверьте ${CONFIG_HINT} и доступность сервера.`
  );
}

// Полный старт: валидация конфигурации ДО первой попытки подключения (fail
// fast на опечатке в .env, не после нескольких секунд retry впустую) + живая
// проверка связности. Возвращает пул — вызывающий код (lifecycle.js) может
// сразу его использовать, не вызывая getPool() повторно.
async function bootstrap(options = {}) {
  validateEnv();
  await waitForDatabase(options);
  return db.getPool();
}

module.exports = { validateEnv, waitForDatabase, bootstrap, CONFIG_HINT };
