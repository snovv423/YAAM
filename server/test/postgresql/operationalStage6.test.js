'use strict';

// YAAM Production Switch — Stage 6 (operational infrastructure):
// integration-тесты для db/postgresql/bootstrap.js, services/postgresql/
// health.js, services/postgresql/lifecycle.js и server/server.postgresql.js
// против настоящего embedded PostgreSQL 16.14. Ничего здесь не подключено к
// production server.js — createApp()/main() экспортированы, но main()
// выполняется только при require.main===module (прямой запуск файла), не
// при require() из теста.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_operational_stage6_test';

let cluster;
let db;
let bootstrap;
let healthModule;
let lifecycleModule;
let schedulerModule;
let serverModule;

before(async () => {
  cluster = await startEmbeddedPostgres('operational-stage6');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  bootstrap = require('../../db/postgresql/bootstrap.js');
  healthModule = require('../../services/postgresql/health.js');
  lifecycleModule = require('../../services/postgresql/lifecycle.js');
  schedulerModule = require('../../services/postgresql/scheduler.js');
  serverModule = require('../../server.postgresql.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

// ===========================================================================
// A. Bootstrap / environment validation
// ===========================================================================

test('A1: validateEnv() бросает понятную ошибку, если ничего не сконфигурировано (без silent fallback)', () => {
  assert.throws(
    () => bootstrap.validateEnv({}),
    (err) => {
      assert.match(err.message, /DATABASE_URL/);
      assert.match(err.message, /PGHOST/);
      return true;
    }
  );
});

test('A2: validateEnv() принимает DATABASE_URL без остальных переменных', () => {
  assert.doesNotThrow(() => bootstrap.validateEnv({ DATABASE_URL: 'postgres://u:p@h:5432/d' }));
});

test('A3: validateEnv() принимает полный набор дискретных PG*-переменных', () => {
  assert.doesNotThrow(() => bootstrap.validateEnv({ PGHOST: 'h', PGDATABASE: 'd', PGUSER: 'u' }));
});

test('A4: validateEnv() бросает понятную ошибку на нечисловой PGPORT', () => {
  assert.throws(
    () => bootstrap.validateEnv({ DATABASE_URL: 'x', PGPORT: 'not-a-number' }),
    /PGPORT/
  );
});

test('A5: validateEnv() бросает понятную ошибку на некорректный PG_SSL', () => {
  assert.throws(
    () => bootstrap.validateEnv({ DATABASE_URL: 'x', PG_SSL: 'maybe' }),
    /PG_SSL/
  );
});

test('A6: waitForDatabase() успешно резолвится против реальной живой БД', async () => {
  await assert.doesNotReject(() => bootstrap.waitForDatabase({ retries: 2, delayMs: 10 }));
});

test('A7: waitForDatabase() исчерпывает retries и бросает понятную агрегированную ошибку против недостижимого адреса', async () => {
  // ВАЖНО: НЕ используем require.cache-трюк для "свежего" db-модуля — он
  // создал бы ВТОРОЙ, отдельный от уже загруженного объект, расходящийся с
  // тем, что уже захватили health.js/lifecycle.js/server.postgresql.js
  // (каждый сделал свой const db = require(...) один раз в before()) —
  // патчи/смена конфигурации через новый инстанс были бы для них невидимы.
  // Вместо этого закрываем ТЕКУЩИЙ (общий, тот же самый объект) пул —
  // getPool() лениво пересоздаст его при следующем обращении, читая
  // process.env.DATABASE_URL заново.
  const realUrl = process.env.DATABASE_URL;
  await db.close();
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/nonexistent'; // порт 1 — гарантированно закрыт
  try {
    const start = Date.now();
    await assert.rejects(
      () => bootstrap.waitForDatabase({ retries: 2, delayMs: 20 }),
      (err) => {
        assert.match(err.message, /не удалось подключиться к PostgreSQL за 2 попыток/);
        return true;
      }
    );
    assert.ok(Date.now() - start >= 20, 'должна была быть хотя бы одна пауза между попытками');
  } finally {
    process.env.DATABASE_URL = realUrl;
    await db.close(); // сбрасывает "плохой" пул — следующий getPool() пересоздаст с ХОРОШИМ адресом
  }
});

test('A8: bootstrap() = validateEnv + waitForDatabase — пробрасывает ошибку валидации ДО попытки подключения', async () => {
  const realUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(() => bootstrap.bootstrap({ retries: 1, delayMs: 1 }), /не заданы переменные окружения/);
  } finally {
    process.env.DATABASE_URL = realUrl;
  }
});

// ===========================================================================
// B. Lifecycle
// ===========================================================================

test('B1: start() бутстрапит БД и запускает schedulers; isRunning()=true', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [scheduler] });
  await lifecycle.start();
  try {
    assert.equal(lifecycle.isRunning(), true);
    assert.equal(scheduler.isRunning(), true);
  } finally {
    await lifecycle.stop();
  }
});

test('B2: повторный start() идемпотентен — не регистрирует второй набор signal listeners', async () => {
  const baseline = process.listenerCount('SIGTERM');
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [scheduler] });
  await lifecycle.start();
  await lifecycle.start();
  await lifecycle.start();
  try {
    assert.equal(process.listenerCount('SIGTERM'), baseline + 1);
  } finally {
    await lifecycle.stop();
  }
});

test('B3: stop() до start() — безопасный no-op', async () => {
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [] });
  await assert.doesNotReject(() => lifecycle.stop());
  assert.equal(lifecycle.isRunning(), false);
});

test('B4: повторный stop() идемпотентен', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [scheduler] });
  await lifecycle.start();
  await lifecycle.stop();
  await assert.doesNotReject(() => lifecycle.stop());
  assert.equal(lifecycle.isRunning(), false);
});

test('B5: stop() снимает signal listeners — listenerCount возвращается к базовому уровню', async () => {
  const baseline = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [scheduler] });
  await lifecycle.start();
  assert.equal(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'), baseline + 2);
  await lifecycle.stop();
  assert.equal(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'), baseline);
});

test('B6: stop() останавливает schedulers', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [scheduler] });
  await lifecycle.start();
  await lifecycle.stop();
  assert.equal(scheduler.isRunning(), false);
});

test('B7: stop() вызывает onShutdown-хук', async () => {
  let called = false;
  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [], onShutdown: async () => { called = true; } });
  await lifecycle.start();
  await lifecycle.stop();
  assert.equal(called, true);
});

test('B8: stop() закрывает переданный httpServer', async () => {
  const http = require('node:http');
  const httpServer = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const lifecycle = lifecycleModule.createLifecycle({ schedulers: [], httpServer });
  await lifecycle.start();
  await lifecycle.stop();

  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`), () => true);
});

test('B9: синтетический сигнал запускает полный stop() и вызывает onSignal — без реального process.exit', async () => {
  // ВАЖНО: НЕ используем реальные 'SIGTERM'/'SIGINT' здесь. embedded-postgres
  // (через зависимость async-exit-hook) сам регистрирует ГЛОБАЛЬНЫЙ
  // process.on('SIGTERM'/'SIGINT', ...) для аккуратной остановки дочернего
  // процесса embedded PostgreSQL — process.emit('SIGTERM') в тестовом
  // процессе вызвал бы ЧУЖОЙ обработчик точно так же, как и наш, реально
  // положив embedded-кластер ("the database system is shutting down" в
  // последующих тестах — так это и было обнаружено). lifecycle.js принимает
  // `signals` как настраиваемый список ИМЁН СОБЫТИЙ — используем приватное,
  // не являющееся реальным POSIX-сигналом имя, чтобы проверить ТОТ ЖЕ
  // код-путь (регистрация → handler → stop() → onSignal) изолированно, не
  // трогая ничего вне этого теста.
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const signalsSeen = [];
  const lifecycle = lifecycleModule.createLifecycle({
    schedulers: [scheduler],
    signals: ['SIGTERM_STAGE6_TEST_ONLY'],
    onSignal: (signal, err) => signalsSeen.push({ signal, err }),
  });
  await lifecycle.start();
  process.emit('SIGTERM_STAGE6_TEST_ONLY');
  await sleep(30); // stop() внутри обработчика асинхронный — дать ему завершиться
  assert.equal(lifecycle.isRunning(), false);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(signalsSeen.length, 1);
  assert.equal(signalsSeen[0].signal, 'SIGTERM_STAGE6_TEST_ONLY');
  assert.equal(signalsSeen[0].err, null);
});

// ===========================================================================
// C. Health
// ===========================================================================

test('C1: liveness() всегда ok:true с числовым uptimeSec, структурно не обращается к БД', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../../services/postgresql/health.js'), 'utf8');
  const fnMatch = src.match(/async function liveness\(\)[\s\S]*?\n  }/);
  assert.ok(fnMatch);
  assert.doesNotMatch(fnMatch[0], /db\.query|checkDatabase/);

  const health = healthModule.createHealthCheck({ getSchedulers: () => [] });
  const result = await health.liveness();
  assert.equal(result.ok, true);
  assert.equal(typeof result.uptimeSec, 'number');
  assert.ok(result.uptimeSec >= 0);
});

test('C2: readiness() с живой БД — ok:true, корректные pool/scheduler поля', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  scheduler.start();
  try {
    const health = healthModule.createHealthCheck({ getSchedulers: () => [scheduler] });
    const result = await health.readiness();
    assert.equal(result.ok, true);
    assert.equal(result.database.ok, true);
    assert.equal(typeof result.pool.totalCount, 'number');
    assert.equal(typeof result.pool.idleCount, 'number');
    assert.equal(typeof result.pool.waitingCount, 'number');
    assert.deepEqual(result.schedulers, [{ index: 0, running: true }]);
  } finally {
    scheduler.stop();
  }
});

test('C3: readiness() отражает остановленный scheduler', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const health = healthModule.createHealthCheck({ getSchedulers: () => [scheduler] });
  const result = await health.readiness();
  assert.equal(result.schedulers[0].running, false);
});

test('C4: readiness() — ok:false с понятной ошибкой, если БД недоступна (симулировано)', async () => {
  const health = healthModule.createHealthCheck({ getSchedulers: () => [] });
  const originalQuery = db.query;
  db.query = async () => { throw new Error('симулированный обрыв соединения'); };
  try {
    const result = await health.readiness();
    assert.equal(result.ok, false);
    assert.equal(result.database.ok, false);
    assert.match(result.database.error, /симулированный обрыв/);
  } finally {
    db.query = originalQuery;
  }
});

// ===========================================================================
// D. HTTP integration (server.postgresql.js)
// ===========================================================================

test('D1: полный HTTP-стек — /health, /health/live, /health/ready отвечают корректно', async () => {
  const instance = serverModule.createApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const base = `http://127.0.0.1:${port}`;

    const live = await fetchJson(`${base}/health/live`);
    assert.equal(live.status, 200);
    assert.equal(live.body.ok, true);

    const ready = await fetchJson(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ok, true);
    assert.equal(ready.body.database.ok, true);

    const health = await fetchJson(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  } finally {
    await instance.stop();
  }
});

test('D2: /health возвращает 503, когда БД недоступна (симулировано)', async () => {
  const instance = serverModule.createApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const originalQuery = db.query;
    db.query = async () => { throw new Error('симулированный обрыв'); };
    try {
      const res = await fetchJson(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 503);
      assert.equal(res.body.ok, false);
    } finally {
      db.query = originalQuery;
    }
  } finally {
    await instance.stop();
  }
});

test('D3: require(server.postgresql.js) не запускает main() автоматически (require.main !== module в тесте)', () => {
  // Косвенное, но решающее доказательство: если бы main() запускался при
  // require(), D1/D2 выше не смогли бы создать СВОЙ собственный слушающий
  // сервер на произвольном порту (или упали бы на конфликте порта/двойном
  // старте scheduler'а). Дополнительно — статическая проверка исходника.
  const src = fs.readFileSync(path.join(__dirname, '../../server.postgresql.js'), 'utf8');
  assert.match(src, /if \(require\.main === module\)/);
});

// ===========================================================================
// E. Graceful shutdown checklist / отсутствие hanging handles
// ===========================================================================

test('E1: полный graceful shutdown — scheduler остановлен, listeners сняты, httpServer закрыт, БД доступна на следующем запросе', async () => {
  const baseline = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
  const instance = serverModule.createApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  const { port } = instance.address();

  await instance.stop();

  assert.equal(instance.scheduler.isRunning(), false);
  assert.equal(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'), baseline);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`), () => true);

  // Пул был закрыт stop()'ом — следующий запрос должен прозрачно открыть
  // новый (getPool() лениво пересоздаёт), а не остаться в сломанном
  // состоянии.
  const rows = await db.query('SELECT 1 AS ok');
  assert.equal(rows[0].ok, 1);
});

// ===========================================================================
// F. Static isolation checks
// ===========================================================================

test('F1: bootstrap.js/health.js/lifecycle.js/server.postgresql.js не содержат db.prepare()/require SQLite', () => {
  for (const file of [
    '../../db/postgresql/bootstrap.js',
    '../../services/postgresql/health.js',
    '../../services/postgresql/lifecycle.js',
    '../../server.postgresql.js',
  ]) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(src, /db\.prepare\(/, `${file} не должен содержать db.prepare()`);
    assert.doesNotMatch(src, /require\(['"]\.\.\/db['"]\)|require\(['"]\.\/db['"]\)/, `${file} не должен require SQLite db/index.js`);
    assert.doesNotMatch(src, /require\(['"].*\/services\/orderService['"]\)/, `${file} не должен require SQLite orderService`);
  }
});

test('F2: server.js (SQLite, production) не изменён — только статическая сверка наличия исходных трёх setInterval', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  assert.match(src, /setInterval\(\(\) => orderService\.sweepTimeouts\(\), 10_000\)/);
  assert.match(src, /setInterval\(\(\) => orderService\.sweepPauseExpiry\(\), 30_000\)/);
  assert.match(src, /setInterval\(\(\) => orderService\.sweepStuckRefunds\(\), 10_000\)/);
  assert.doesNotMatch(src, /server\.postgresql/);
});

// ===========================================================================
// G. Cleanup
// ===========================================================================

test('G1: пул PostgreSQL возвращён, waitingCount=0, total===idle', async () => {
  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});
