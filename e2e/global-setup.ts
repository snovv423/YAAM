import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { FullConfig } from '@playwright/test';
import { startStaticServer } from './fixtures/static-server';

// Полностью локальный, эфемерный стек для критического smoke-сценария.
// Ничего из этого не касается staging/production:
//  - embedded PostgreSQL (server/test/postgresql/helpers/embeddedPg.js) —
//    тот же harness, что и все Wave/Stage integration-тесты backend'а;
//  - существующая схема (server/db/postgresql/schema.sql) как есть;
//  - существующий идемпотентный seed (server/db/postgresql/seed.js) —
//    ЗАПУЩЕН КАК ОТДЕЛЬНЫЙ ПРОЦЕСС (см. ниже, почему это не opt., а must);
//  - существующая фабрика приложения (server/services/postgresql/app.js,
//    createPostgresqlApp()) с PAYMENT_PROVIDER=mock — ни одного реального
//    вызова к ЮKassa, ни одного реального ключа.
//
// Ни Split/СБП/54-ФЗ/refunds/выплаты ресторанам, ни staging/production в
// этом файле не участвуют и не могут быть затронуты — приложение поднимается
// заново, с нуля, в отдельном процессе, против базы, которая существует
// только на время этого прогона.

const SERVER_DIR = path.resolve(__dirname, '../server');
const CLIENT_DIR = path.resolve(__dirname, '../client');
const DATABASE_NAME = 'yaam_e2e_critical_order_smoke';

async function globalSetup(_config: FullConfig) {
  // embeddedPg.js сам требует NODE_ENV==='test' (fail-closed guard против
  // случайного использования вне тестового контекста) и стирает любые
  // унаследованные DATABASE_URL/PG*. Как побочный, документированный в
  // server/config/cors.js эффект: NODE_ENV!=='production' одновременно
  // включает localhost-bypass в CORS — то есть локальному client-серверу
  // (другой origin, другой порт) не нужна отдельная настройка
  // CORS_ALLOWED_ORIGINS, чтобы обращаться к локальному backend'у.
  process.env.NODE_ENV = 'test';

  const { startEmbeddedPostgres, getFreePort } = require(
    path.join(SERVER_DIR, 'test/postgresql/helpers/embeddedPg.js')
  );

  const schemaSql = fs.readFileSync(path.join(SERVER_DIR, 'db/postgresql/schema.sql'), 'utf8');

  const cluster = await startEmbeddedPostgres('e2e-critical-order-smoke');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(schemaSql);
  await setupClient.end();

  const databaseUrl = cluster.connectionString(DATABASE_NAME);

  // server/db/postgresql/seed.js исполняет main() и закрывает общий пул
  // соединений (`db.close()` в .finally()) сразу при require() — если
  // требовать его в этом же процессе, он закрыл бы пул, который затем нужен
  // createPostgresqlApp(). Поэтому сид запускается ТОЧНО так же, как его уже
  // реально запускали против настоящего staging (см. отчёт "Stage 11B Deploy
  // Seed to Staging") — отдельным `node` процессом с DATABASE_URL в env.
  // Это переиспользование существующего скрипта как есть, без модификации
  // и без копирования его содержимого.
  execFileSync(process.execPath, [path.join(SERVER_DIR, 'db/postgresql/seed.js')], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  // Теперь поднимаем настоящее приложение в этом процессе, со свежим пулом.
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.APP_ENV = 'local';
  // YAAM HQ Stage 6 — /hq/login rate-limit (services/routes/hq/middleware.js:
  // loginRateLimiter, дефолт 8 попыток/15 мин, защита от подбора пароля) —
  // ВСЕ spec-файлы этого прогона делят ОДИН запущенный app-instance и один
  // IP (127.0.0.1), поэтому логины из разных файлов суммируются в один и тот
  // же счётчик за всё время прогона (окно 15 минут длиннее самого прогона).
  // При росте числа HQ e2e-сценариев (Stage 6 добавил ещё один, суммарно
  // упёрлось в потолок) реальные тестовые логины начинают получать 429,
  // никак не связанный с проверяемой функциональностью. HQ_LOGIN_RATE_LIMIT_MAX
  // — единственный ENV-переключатель этого лимита, по умолчанию НЕ задан
  // (production продолжает использовать жёсткие 8/15мин без изменений) —
  // здесь поднимается только для этого эфемерного e2e-инстанса.
  process.env.HQ_LOGIN_RATE_LIMIT_MAX = '50';
  // Явно убираем случайно унаследованные переменные, которых этот smoke-тест
  // не использует (bot, admin, dev-payment-роут) — сценарий первой реализации
  // намеренно ограничен созданием заказа + refresh/restore + защитой от
  // двойного клика, без продвижения по жизненному циклу через
  // dev-confirm-payment (см. отчёт-анализ, это осознанно вне scope этой
  // задачи, а не забыто).
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  delete process.env.ENABLE_DEV_PAYMENT_ROUTES;

  const appPort = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${appPort}`;

  // YAAM HQ Stage 5B — LocalMediaProvider (задание, раздел 14D: "using
  // LocalMediaProvider and a temp directory, never touching real external
  // services"). MEDIA_LOCAL_BASE_URL указывает на статический маршрут
  // /media-fixtures, который services/postgresql/app.js монтирует САМ,
  // ТОЛЬКО когда активен LocalMediaProvider (никогда не в production —
  // см. services/hq/media/provider.js) — это даёт реальному Chromium в
  // Playwright реально загрузить фотографию по <img src>, а не выдуманный
  // local-media://-URL, который браузер не умеет открыть.
  //
  // ВАЖНО: эти переменные ОБЯЗАНЫ быть выставлены ДО require()
  // services/postgresql/app.js — тот при своём require() тянет
  // routes/postgresql/api.js, а он создаёт СВОЙ собственный module-level
  // mediaProvider (см. комментарий там же) читая process.env.MEDIA_PROVIDER
  // ровно один раз, в момент этого самого require(). Если выставить их
  // позже (как было до этого исправления), HQ-загрузка фото работает (её
  // provider создаётся позже, внутри createPostgresqlApp()), но публичный
  // API (GET /api/restaurants) навсегда получает mediaProvider=null и
  // отдаёт primary_photo/gallery пустыми независимо от реальных данных в БД.
  process.env.MEDIA_PROVIDER = 'local';
  process.env.MEDIA_LOCAL_BASE_URL = `${apiBaseUrl}/media-fixtures`;
  // Известный (не авто-сгенерированный) каталог — чтобы сам e2e-сценарий
  // (hq-media-photos-flow.spec.ts, шаг 18: "confirm storage was cleaned up
  // after the test") мог проверить его содержимое во время прогона, а
  // globalTeardown ниже — реально удалить и подтвердить удаление, а не
  // полагаться на то, что ОС когда-нибудь сама подчистит os.tmpdir().
  const mediaLocalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-e2e-media-'));
  process.env.MEDIA_LOCAL_DIR = mediaLocalDir;
  process.env.YAAM_E2E_MEDIA_LOCAL_DIR = mediaLocalDir;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createPostgresqlApp } = require(path.join(SERVER_DIR, 'services/postgresql/app.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hashPassword } = require(path.join(SERVER_DIR, 'services/hq/passwordHash.js'));

  // HQ Stage 2 — тестовый admin-аккаунт только для этого эфемерного прогона
  // (пароль нигде не хранится и не используется повторно — генерируется
  // заново на каждый запуск e2e; см. tests/hq-login-flow.spec.ts).
  const hqAdminUser = 'owner';
  const hqAdminPassword = `E2E-${crypto.randomBytes(9).toString('base64url')}`;
  const hqAdminPasswordHash = await hashPassword(hqAdminPassword);
  const hqSessionSecret = crypto.randomBytes(32).toString('hex');

  const appInstance = createPostgresqlApp({
    port: appPort,
    host: '127.0.0.1',
    hqAdminUser,
    hqAdminPasswordHash,
    hqSessionSecret,
  });
  await appInstance.start(); // резолвится только после lifecycle.start() — бизнес-маршруты уже ready

  const clientPort = await getFreePort();
  const staticServer = await startStaticServer({ rootDir: CLIENT_DIR, port: clientPort });
  const clientBaseUrl = `http://127.0.0.1:${clientPort}`;

  // Передача в тестовые воркеры — Playwright официально поддерживает чтение
  // process.env, установленного внутри globalSetup, из тестовых процессов
  // (воркеры наследуют env родительского процесса на момент запуска, который
  // происходит уже после globalSetup).
  process.env.YAAM_E2E_API_BASE_URL = apiBaseUrl;
  process.env.YAAM_E2E_CLIENT_BASE_URL = clientBaseUrl;
  // HQ Stage 2 (server-rendered, отдаётся тем же backend'ом, что и /api —
  // не через client static-server) — см. tests/hq-login-flow.spec.ts.
  process.env.YAAM_E2E_HQ_ADMIN_USER = hqAdminUser;
  process.env.YAAM_E2E_HQ_ADMIN_PASSWORD = hqAdminPassword;
  // Только для DB-уровневого доказательства "не создано два заказа" в
  // tests/critical-order-smoke.spec.ts — публичный GET /api/restaurants
  // намеренно считает orders_count только по оплаченным заказам
  // (routes/postgresql/api.js: ORDERS_COUNT_JOIN исключает status=
  // 'awaiting_payment'), а mock-заказ в этом smoke-тесте намеренно не
  // продвигается дальше awaiting_payment (см. шапку файла) — поэтому для
  // самого надёжного доказательства тест читает таблицу orders напрямую,
  // тем же пакетом `pg`, что уже стоит в server/node_modules (не добавляем
  // вторую копию зависимости в e2e/package.json).
  process.env.YAAM_E2E_DATABASE_URL = databaseUrl;

  console.log(`[e2e:global-setup] backend  ${apiBaseUrl}`);
  console.log(`[e2e:global-setup] frontend ${clientBaseUrl}`);
  console.log(`[e2e:global-setup] database ${DATABASE_NAME} (embedded, ephemeral)`);

  return async function globalTeardown() {
    await staticServer.close();
    await appInstance.stop();
    await cluster.stop(); // сама удаляет свой временный data-каталог
    // Stage 5B, шаг 18 сценария — реально удаляем и подтверждаем удаление
    // временного каталога LocalMediaProvider (не полагаемся на ОС).
    fs.rmSync(mediaLocalDir, { recursive: true, force: true });
    if (fs.existsSync(mediaLocalDir)) {
      throw new Error(`[e2e:global-teardown] временный каталог медиа не был удалён: ${mediaLocalDir}`);
    }
    console.log('[e2e:global-teardown] static server + app + embedded PostgreSQL + временный медиа-каталог остановлены и удалены');
  };
}

export default globalSetup;
