import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 2.1 — clean-root browser E2E, запускается ИМЕННО против
// origin тестового reverse-proxy (server/test/postgresql/helpers/
// hqReverseProxy.js), который воспроизводит точное поведение реального
// production Nginx-блока `location / { proxy_pass .../hq/; }` (см. финальный
// отчёт Stage 2.1). Ни один URL браузера за весь сценарий не должен
// содержать "/hq".
//
// Намеренно НЕ переиспользует общий global-setup.ts инстанс приложения
// (тот собран с linkBasePath='/hq' — им пользуется hq-login-flow.spec.ts
// для локального режима) — поднимает СВОЙ, второй createPostgresqlApp() с
// linkBasePath='' поверх ТОЙ ЖЕ уже поднятой embedded PostgreSQL (через
// YAAM_E2E_DATABASE_URL из global-setup.ts: схема и тестовые данные уже
// существуют, второй раз накатывать их не нужно).
//
// Playwright исполняет globalSetup и сами тесты в РАЗНЫХ Node-процессах
// (globalSetup — в родительском процессе CLI, тесты — в отдельном worker-
// процессе; process.env, установленный в globalSetup, наследуется дочерним
// worker-процессом при его запуске, но это ДВА разных процесса с
// независимой памятью). Поэтому module-level singleton пул соединений
// server/db/postgresql/index.js в этом worker-процессе — СВОЙ, отдельный от
// пула главного instance (тот живёт в процессе globalSetup) — вызывать
// .stop() (а значит и db.close()) на этом втором instance безопасно и НЕ
// затрагивает главный instance/остальные spec-файлы.
const SERVER_DIR = path.resolve(__dirname, '../../server');

let hqInstance: { stop(): Promise<void> } | null = null;
let proxyHandle: { server: import('node:http').Server; close(): Promise<void> } | null = null;
let cleanRootUrl: string;
let hqAdminUser: string;
let hqAdminPassword: string;

test.beforeAll(async () => {
  const databaseUrl = process.env.YAAM_E2E_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('YAAM_E2E_DATABASE_URL не задан — global-setup.ts не выполнился?');
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createPostgresqlApp } = require(path.join(SERVER_DIR, 'services/postgresql/app.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hashPassword } = require(path.join(SERVER_DIR, 'services/hq/passwordHash.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startHqReverseProxy } = require(path.join(SERVER_DIR, 'test/postgresql/helpers/hqReverseProxy.js'));
  // embeddedPg.js стирает DATABASE_URL/PG*-переменные КАК ПОБОЧНЫЙ ЭФФЕКТ
  // СВОЕЙ ЗАГРУЗКИ (см. его собственный заголовок) — require() выполняется
  // раньше, чем ниже выставляется process.env.DATABASE_URL, специально в
  // этом порядке, а не наоборот.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getFreePort } = require(path.join(SERVER_DIR, 'test/postgresql/helpers/embeddedPg.js'));

  // db/postgresql/bootstrap.js читает process.env.DATABASE_URL напрямую (не
  // через опцию `env`, которая влияет только на собственную валидацию
  // services/postgresql/app.js) — в этом worker-процессе она ещё не
  // установлена (сюда доехало только YAAM_E2E_DATABASE_URL), выставляем явно.
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';

  hqAdminUser = 'owner';
  hqAdminPassword = `CleanRoot-${crypto.randomBytes(9).toString('base64url')}`;
  const hqAdminPasswordHash = await hashPassword(hqAdminPassword);
  const hqSessionSecret = crypto.randomBytes(32).toString('hex');

  const appPort = await getFreePort();
  hqInstance = createPostgresqlApp({
    port: appPort,
    host: '127.0.0.1',
    schedulerIntervalMs: 1_000_000,
    hqAdminUser,
    hqAdminPasswordHash,
    hqSessionSecret,
    hqLinkBasePath: '', // clean-root — предмет этого теста
  });
  await hqInstance.start();

  const proxyPort = await getFreePort();
  proxyHandle = await startHqReverseProxy({
    upstreamPort: appPort,
    port: proxyPort,
    publicHost: 'hq.yaam.su',
    forwardedProto: 'http',
  });
  cleanRootUrl = `http://127.0.0.1:${proxyPort}`;
  console.log(`[hq-clean-root-flow] proxy origin ${cleanRootUrl} -> upstream 127.0.0.1:${appPort}/hq`);
});

test.afterAll(async () => {
  if (proxyHandle) await proxyHandle.close();
  if (hqInstance) await hqInstance.stop();
});

test('YAAM HQ clean-root: вход и вся навигация через отдельный поддомен без единого "/hq" в адресной строке', async ({ page }) => {
  const seenUrls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seenUrls.push(frame.url());
  });

  // 1-2. Открыть "/" без сессии -> "/login".
  await page.goto(`${cleanRootUrl}/`);
  await expect(page).toHaveURL(`${cleanRootUrl}/login`);
  await expect(page.locator('h1')).toHaveText('YAAM HQ');

  // 3-4. Войти.
  await page.getByLabel('Логин').fill(hqAdminUser);
  await page.getByLabel('Пароль').fill(hqAdminPassword);
  await page.getByRole('button', { name: 'Войти' }).click();

  // после входа URL — корень, без "/hq".
  await expect(page).toHaveURL(`${cleanRootUrl}/`);
  await expect(page.locator('h1')).toHaveText('Обзор');

  // 5. Все четыре раздела через чистый корень.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await expect(page).toHaveURL(`${cleanRootUrl}/restaurants`);

  await page.getByRole('link', { name: 'Финансы' }).click();
  await expect(page).toHaveURL(`${cleanRootUrl}/finance`);

  await page.getByRole('link', { name: 'Настройки' }).click();
  await expect(page).toHaveURL(`${cleanRootUrl}/settings`);
  await expect(page.getByText(hqAdminUser, { exact: true })).toBeVisible();

  // 6. Статический JS — тоже с чистого корня, без "/hq".
  const staticRes = await page.request.get(`${cleanRootUrl}/static/hq.js`);
  expect(staticRes.status()).toBe(200);

  // 7. Выход.
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(`${cleanRootUrl}/login`);

  // 8-9. "Назад" не восстанавливает защищённую страницу.
  await page.goBack();
  await expect(page).toHaveURL(`${cleanRootUrl}/login`);

  // 10. Ни один URL адресной строки за весь сценарий не содержал "/hq".
  expect(seenUrls.length).toBeGreaterThan(0);
  for (const url of seenUrls) {
    expect(url, `URL не должен содержать "/hq": ${url}`).not.toContain('/hq');
  }
});
