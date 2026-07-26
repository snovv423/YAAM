'use strict';

// YAAM HQ Stage 2.1 — clean-root routing для hq.yaam.su: интеграционные
// тесты против настоящего embedded PostgreSQL (тот же harness, что и во
// всех Stage/Wave тестах этой директории). Раздел A — прямые запросы к
// приложению с linkBasePath='' (без прокси, проверяет, что САМО приложение
// перестаёт писать "/hq" в свои ответы). Раздел B — те же сценарии ЧЕРЕЗ
// тестовый reverse-proxy (server/test/postgresql/helpers/hqReverseProxy.js),
// воспроизводящий точное поведение реального Nginx-блока `location / {
// proxy_pass .../hq/; }` — см. этот файл за подробным разбором nginx
// rewrite-семантики. Ничего не подключено к staging/production/реальному
// DNS/Nginx.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { startHqReverseProxy } = require('./helpers/hqReverseProxy');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_hq_clean_root_stage21_test';

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#CleanRoot';
const TEST_SESSION_SECRET = 'b'.repeat(48);
const PUBLIC_HOST = 'hq.yaam.su';

let cluster;
let db;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  delete process.env.APP_ENV;
  delete process.env.HQ_ADMIN_USER;
  delete process.env.HQ_ADMIN_PASSWORD_HASH;
  delete process.env.HQ_SESSION_SECRET;
  delete process.env.HQ_LINK_BASE_PATH;
  delete process.env.CORS_ALLOWED_ORIGINS;

  cluster = await startEmbeddedPostgres('hq-clean-root-stage21');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function reloadHqAppModule() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  return require('../../services/postgresql/app.js');
}

async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer никогда не начал слушать');
}

// linkBasePath: '' по умолчанию в этом файле — именно clean-root и есть
// предмет теста (обычный '/hq'-режим уже полностью покрыт
// hqAuthStage2.test.js и здесь не дублируется).
function withHqApp(overrides, tst) {
  return async () => {
    const appModule = reloadHqAppModule();
    const instance = appModule.createPostgresqlApp({
      port: 0,
      schedulerIntervalMs: 1_000_000,
      hqAdminUser: TEST_HQ_USER,
      hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH,
      hqSessionSecret: TEST_SESSION_SECRET,
      hqLinkBasePath: '',
      ...overrides,
    });
    await instance.start();
    try {
      const { port } = await waitForAddress(instance);
      await tst({ instance, port, appModule });
    } finally {
      await instance.stop();
    }
  };
}

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице логина');
  return m[1];
}

// ===========================================================================
// A. Прямые запросы к приложению (linkBasePath='', БЕЗ прокси) — физический
// mount point всё ещё '/hq' (см. services/postgresql/app.js), но всё, что
// приложение САМО пишет в ответы, должно быть root-relative.
// ===========================================================================

test('A1: GET /hq/login напрямую (linkBasePath="") — form action="/login", НЕ "/hq/login"', withHqApp({}, async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /action="\/login"/);
  assert.doesNotMatch(html, /action="\/hq\/login"/);
}));

test('A2: GET /hq/login напрямую — script src="/static/hq.js", НЕ "/hq/static/hq.js"', withHqApp({}, async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const html = await res.text();
  assert.match(html, /src="\/static\/hq\.js"/);
  assert.doesNotMatch(html, /src="\/hq\/static\/hq\.js"/);
}));

test('A3: cookie Path — "/" в clean-root режиме (не "/hq")', withHqApp({}, async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('yaam.hq.sid='));
  assert.ok(raw);
  assert.match(raw, /Path=\//);
  assert.doesNotMatch(raw, /Path=\/hq/);
}));

test('A4: неавторизованный GET /hq напрямую — редирект на "/login" (root-relative), НЕ "/hq/login"', withHqApp({}, async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
}));

test('A5: успешный логин в clean-root — редирект на "/", НЕ "/hq"; «Обзор» не содержит подстроки "/hq" нигде в HTML', withHqApp({}, async ({ port }) => {
  const loginRes = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);

  const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  const postRes = await fetch(`http://127.0.0.1:${port}/hq/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  assert.equal(postRes.status, 302);
  assert.equal(postRes.headers.get('location'), '/');

  const authedCookie = cookieHeaderFrom(postRes) || cookie;
  const overviewRes = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: authedCookie } });
  const overviewHtml = await overviewRes.text();
  assert.equal(overviewRes.status, 200);
  assert.match(overviewHtml, /Обзор/);
  assert.ok(!overviewHtml.includes('/hq'), '«Обзор» в clean-root режиме не должен содержать ни одного вхождения "/hq"');
}));

// ===========================================================================
// B. Reverse-proxy integration — через тестовый harness, воспроизводящий
// реальный Nginx `location / { proxy_pass .../hq/; }`.
// ===========================================================================

function withProxiedHqApp(overrides, tst) {
  return async () => {
    const appModule = reloadHqAppModule();
    const instance = appModule.createPostgresqlApp({
      port: 0,
      schedulerIntervalMs: 1_000_000,
      hqAdminUser: TEST_HQ_USER,
      hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH,
      hqSessionSecret: TEST_SESSION_SECRET,
      hqLinkBasePath: '',
      ...overrides,
    });
    await instance.start();
    const { port: upstreamPort } = await waitForAddress(instance);
    const proxy = await startHqReverseProxy({ upstreamPort, port: 0, publicHost: PUBLIC_HOST, forwardedProto: 'http' });
    const proxyPort = proxy.server.address().port;
    try {
      await tst({ instance, proxyPort, appModule });
    } finally {
      await proxy.close();
      await instance.stop();
    }
  };
}

test('B1: GET / через прокси — редирект на "/login"', withProxiedHqApp({}, async ({ proxyPort }) => {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
}));

test('B2: GET /login через прокси — 200, форма логина, action="/login"', withProxiedHqApp({}, async ({ proxyPort }) => {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/login`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /YAAM HQ/);
  assert.match(html, /action="\/login"/);
}));

test('B3-B6: полный цикл через прокси — login (Path=/) -> «Обзор»/restaurants/finance/settings -> logout -> старая cookie не работает', withProxiedHqApp({}, async ({ proxyPort }) => {
  const loginRes = await fetch(`http://127.0.0.1:${proxyPort}/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);

  // B3: успешный POST /login через прокси.
  const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  const postRes = await fetch(`http://127.0.0.1:${proxyPort}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  assert.equal(postRes.status, 302);
  assert.equal(postRes.headers.get('location'), '/');
  const raw = postRes.headers.getSetCookie().find((c) => c.startsWith('yaam.hq.sid='));
  assert.match(raw, /Path=\//);
  const authedCookie = cookieHeaderFrom(postRes);

  // B4: cookie работает на "/" через прокси.
  const overviewRes = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: { Cookie: authedCookie } });
  assert.equal(overviewRes.status, 200);
  const overviewHtml = await overviewRes.text();
  assert.match(overviewHtml, /Обзор/);

  // B5: навигация по всем трём заглушкам + статика.
  for (const p of ['/restaurants', '/finance', '/settings']) {
    const r = await fetch(`http://127.0.0.1:${proxyPort}${p}`, { headers: { Cookie: authedCookie } });
    assert.equal(r.status, 200, `${p} должен отвечать 200 через прокси с валидной cookie`);
  }
  const staticRes = await fetch(`http://127.0.0.1:${proxyPort}/static/hq.js`);
  assert.equal(staticRes.status, 200);
  assert.match(String(staticRes.headers.get('content-type')), /javascript/);

  // B6: logout через прокси -> редирект на /login, cookie сброшена с Path=/.
  const settingsRes = await fetch(`http://127.0.0.1:${proxyPort}/settings`, { headers: { Cookie: authedCookie } });
  const settingsHtml = await settingsRes.text();
  const logoutCsrf = extractCsrf(settingsHtml);
  const logoutBody = new URLSearchParams({ _csrf: logoutCsrf });
  const logoutRes = await fetch(`http://127.0.0.1:${proxyPort}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: authedCookie },
    body: logoutBody.toString(),
  });
  assert.equal(logoutRes.status, 302);
  assert.equal(logoutRes.headers.get('location'), '/login');

  // старая cookie после logout больше не пускает.
  const afterLogout = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: { Cookie: authedCookie }, redirect: 'manual' });
  assert.equal(afterLogout.status, 302);
  assert.equal(afterLogout.headers.get('location'), '/login');
}));

test('B7: прямой заход на публичный "/hq/login" через прокси (двойной префикс "/hq/hq/login" на backend) — не рабочая вторая копия панели, не redirect loop', withProxiedHqApp({}, async ({ proxyPort }) => {
  // Владелец руками вводит https://hq.yaam.su/hq/login — прокси, следуя
  // ТОЧНО тому же правилу nginx, преобразует это в внутренний "/hq/hq/login"
  // (см. helpers/hqReverseProxy.js), которого как отдельного, открывающего
  // страницу маршрута не существует. Без сессии requireHqAuth (см.
  // routes/hq/middleware.js) перехватывает ЛЮБОЙ непойманный путь под /hq
  // РАНЬШЕ, чем Express дойдёт до "нет такого маршрута" — то есть
  // неавторизованный владелец просто попадает на настоящую страницу логина
  // (безопасно, без второй копии панели и без redirect loop), а не видит
  // пугающую ошибку. С активной сессией пойманных маршрутов для
  // "/hq/login" всё равно нет — там честный 404, без утечки чужого
  // содержимого HQ под этим адресом.
  const anonRes = await fetch(`http://127.0.0.1:${proxyPort}/hq/login`, { redirect: 'manual' });
  assert.equal(anonRes.status, 302, 'без сессии — редирект (не открывшаяся вторая панель, не 200 с контентом)');
  assert.equal(anonRes.headers.get('location'), '/login', 'редирект должен вести на настоящий /login, а не зацикливаться на "/hq/login"');
  const followed = await fetch(`http://127.0.0.1:${proxyPort}/hq/login`);
  assert.equal(followed.status, 200);
  assert.match(await followed.text(), /YAAM HQ/);

  const loginRes = await fetch(`http://127.0.0.1:${proxyPort}/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  const postRes = await fetch(`http://127.0.0.1:${proxyPort}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  const authedCookie = cookieHeaderFrom(postRes);
  const authedRes = await fetch(`http://127.0.0.1:${proxyPort}/hq/login`, { headers: { Cookie: authedCookie } });
  assert.equal(authedRes.status, 404, 'с активной сессией "/hq/login" не должен открывать вторую рабочую копию панели');
}));

test('B8: без CORS_ALLOWED_ORIGINS=hq.yaam.su в production — POST /login через прокси с Origin: https://hq.yaam.su отклоняется общим CORS-мидлварем', withProxiedHqApp(
  { env: { ...process.env, APP_ENV: 'production', TRUST_PROXY: 'loopback', PG_HEALTH_HOST: '127.0.0.1' } },
  async ({ proxyPort }) => {
    const loginRes = await fetch(`http://127.0.0.1:${proxyPort}/login`, { headers: { 'X-Forwarded-Proto': 'https' } });
    const loginHtml = await loginRes.text();
    const cookie = cookieHeaderFrom(loginRes);
    const csrf = extractCsrf(loginHtml);
    const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
    const postRes = await fetch(`http://127.0.0.1:${proxyPort}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        Origin: `https://${PUBLIC_HOST}`,
        'X-Forwarded-Proto': 'https',
      },
      body: body.toString(),
    });
    assert.equal(postRes.status, 403, 'без hq.yaam.su в allowlist глобальный CORS-мидлварь должен отклонять собственный же POST панели');
    const respBody = await postRes.text();
    assert.match(respBody, /CORS/);
  }
));

test('B9: с CORS_ALLOWED_ORIGINS, включающим https://hq.yaam.su — тот же POST /login через прокси проходит', async () => {
  const previousCors = process.env.CORS_ALLOWED_ORIGINS;
  // buildCorsOptions() (config/cors.js) читает process.env.CORS_ALLOWED_ORIGINS
  // в момент createPostgresqlApp() — значение должно быть выставлено ДО
  // создания instance, поэтому здесь (в отличие от B8) не переиспользуется
  // withProxiedHqApp, а всё собирается вручную с явным try/finally.
  process.env.CORS_ALLOWED_ORIGINS = `https://yaam.su,https://www.yaam.su,https://${PUBLIC_HOST}`;
  let instance;
  let proxy;
  try {
    const appModule = reloadHqAppModule();
    instance = appModule.createPostgresqlApp({
      port: 0,
      schedulerIntervalMs: 1_000_000,
      hqAdminUser: TEST_HQ_USER,
      hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH,
      hqSessionSecret: TEST_SESSION_SECRET,
      hqLinkBasePath: '',
      env: { ...process.env, APP_ENV: 'production', TRUST_PROXY: 'loopback', PG_HEALTH_HOST: '127.0.0.1' },
    });
    await instance.start();
    const { port: upstreamPort } = await waitForAddress(instance);
    proxy = await startHqReverseProxy({ upstreamPort, port: 0, publicHost: PUBLIC_HOST, forwardedProto: 'https' });
    const proxyPort = proxy.server.address().port;

    const loginRes = await fetch(`http://127.0.0.1:${proxyPort}/login`, { headers: { 'X-Forwarded-Proto': 'https' } });
    const loginHtml = await loginRes.text();
    const cookie = cookieHeaderFrom(loginRes);
    const csrf = extractCsrf(loginHtml);
    const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
    const postRes = await fetch(`http://127.0.0.1:${proxyPort}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        Origin: `https://${PUBLIC_HOST}`,
        'X-Forwarded-Proto': 'https',
      },
      body: body.toString(),
    });
    assert.equal(postRes.status, 302, 'с hq.yaam.su в CORS_ALLOWED_ORIGINS собственный POST панели должен проходить');
    assert.equal(postRes.headers.get('location'), '/');
  } finally {
    if (proxy) await proxy.close();
    if (instance) await instance.stop();
    if (previousCors === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previousCors;
  }
});
