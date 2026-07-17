'use strict';

// Test harness для реального embedded PostgreSQL (пакет `embedded-postgres`,
// настоящий бинарник PostgreSQL 16.14 из zonky/embedded-postgres-binaries —
// см. YAAM-postgresql-embedded-live-validation.pdf, раздел 3).
//
// Этот модуль НЕ является частью приложения — он используется только из
// server/test/postgresql/*.test.js. Требует NODE_ENV=test (см. guard ниже) и
// принудительно стирает любые внешние DATABASE_URL/PG*-переменные окружения
// в момент своей загрузки, чтобы integration-тесты не могли случайно
// подключиться к настоящей/внешней/production базе — тестовый connection
// string создаётся только этим harness'ом, из свежесозданного эфемерного
// кластера.

if (process.env.NODE_ENV !== 'test') {
  throw new Error(
    'server/test/postgresql/helpers/embeddedPg.js requires NODE_ENV=test — ' +
      'run via `npm run test:postgresql`, not directly.'
  );
}

// Стираем любой унаследованный из окружения DATABASE_URL/PG* ДО того, как
// что-либо в этом процессе успеет их прочитать. Тестовый connection string
// генерируется исключительно ниже, в startEmbeddedPostgres().
for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  delete process.env[key];
}

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
// `embedded-postgres` — ESM-only пакет ("type": "module" в его package.json);
// CommonJS require() интеропа даёт module namespace object, а не сам класс
// напрямую — реальный default export лежит в `.default`.
const EmbeddedPostgres = require('embedded-postgres').default;

// Находит свободный localhost-порт, отдавая ОС выбрать его (bind на порт 0).
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Эфемерный пароль только для этого процесса: используется исключительно
// локальным кластером, чей data-каталог удаляется при stop(). Никогда не
// логируется, никогда не пишется в файл, никогда не коммитится.
function randomTestPassword() {
  return crypto.randomBytes(24).toString('hex');
}

// Поднимает изолированный, одноразовый PostgreSQL-кластер:
//  - слушает только 127.0.0.1/localhost (postgresFlags: listen_addresses),
//    явно, а не полагаясь на default;
//  - собственный временный data-каталог (os.tmpdir()-based, уникальный);
//  - persistent:false — stop() удаляет данные кластера сам;
//  - случайный свободный порт, не 5432 по умолчанию.
async function startEmbeddedPostgres(label) {
  const port = await getFreePort();
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), `yaam-embedded-pg-${label}-`));
  const user = 'yaam_test';
  const password = randomTestPassword();

  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user,
    password,
    persistent: false,
    postgresFlags: ['-c', 'listen_addresses=localhost'],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await pg.initialise();
    await pg.start();
  } catch (err) {
    // Если старт кластера не удался, databaseDir уже создан mkdtempSync —
    // без этого catch он остался бы висеть в os.tmpdir() навсегда, так как
    // stop() (обычный путь очистки) в этом случае никогда не будет вызван.
    fs.rmSync(databaseDir, { recursive: true, force: true });
    throw err;
  }

  let stopped = false;

  return {
    port,
    user,
    password,
    databaseDir,

    async createDatabase(name) {
      await pg.createDatabase(name);
    },

    getClient(database) {
      return pg.getPgClient(database);
    },

    connectionString(database) {
      return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${port}/${database}`;
    },

    async stop() {
      if (stopped) return; // повторный stop() безопасен
      stopped = true;
      await pg.stop(); // persistent:false — сам удаляет содержимое databaseDir
      fs.rmSync(databaseDir, { recursive: true, force: true }); // подчищаем сам каталог
    },
  };
}

module.exports = { startEmbeddedPostgres, getFreePort };
