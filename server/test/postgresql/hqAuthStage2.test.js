'use strict';

// YAAM HQ Stage 2 — backend-интеграционные тесты auth-слоя и экрана «Обзор»
// против настоящего embedded PostgreSQL (тот же harness, что и все Stage/
// Wave тесты этой директории). Проверяет ИМЕННО то, что перечислено в
// задании (раздел 10, категория B): успешный/неуспешный вход, rate limit,
// доступ к защищённому маршруту с сессией и без, logout, флаги cookie,
// отклонение CSRF, отсутствие приватных полей в «Обзоре», fail-closed при
// отсутствующих ENV. Ничего не подключено к staging/production — только
// свежий эфемерный кластер, тестовый admin-аккаунт, mock-провайдер платежей
// не требуется (HQ Stage 2 не трогает платежи).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_hq_stage2_test';

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Test';
const TEST_SESSION_SECRET = 'a'.repeat(48);

let cluster;
let db;
let hashPassword;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  delete process.env.APP_ENV;
  delete process.env.HQ_ADMIN_USER;
  delete process.env.HQ_ADMIN_PASSWORD_HASH;
  delete process.env.HQ_SESSION_SECRET;

  cluster = await startEmbeddedPostgres('hq-stage2');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  ({ hashPassword } = require('../../services/hq/passwordHash'));
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

// Каждый rate-limit-чувствительный тест получает СВОЙ, свежий инстанс
// routes/hq/middleware.js (и всего, что от него зависит) — единственный
// express-rate-limit()-лимитер создаётся один раз на require() модуля и,
// без сброса require.cache, делил бы счётчик попыток между СОВСЕМ разными
// тестами (все запросы в этом файле идут с loopback, то есть с одного и
// того же IP) — тот же приём, что и reloadAppModule()/withEnvReload() в
// applicationAssemblyStage7.test.js.
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

// Свежий appModule + свежий, запущенный instance с тестовым HQ-аккаунтом —
// оборачивает тест и гарантированно останавливает instance по завершении,
// даже при падении assert.
function withHqApp(overrides, tst) {
  return async () => {
    const appModule = reloadHqAppModule();
    const instance = appModule.createPostgresqlApp({
      port: 0,
      schedulerIntervalMs: 1_000_000,
      hqAdminUser: TEST_HQ_USER,
      hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH,
      hqSessionSecret: TEST_SESSION_SECRET,
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

function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице логина');
  return m[1];
}

// undici (node fetch) отдаёt все Set-Cookie заголовки через getSetCookie() —
// собираем их в один Cookie-заголовок для следующего запроса той же "сессии
// браузера", как обычно делает cookie jar.
function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function getLoginPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const html = await res.text();
  return { res, html, cookie: cookieHeaderFrom(res), csrf: extractCsrf(html) };
}

async function postLogin(port, { cookie, csrf, username, password }) {
  const body = new URLSearchParams();
  if (csrf !== undefined) body.set('_csrf', csrf);
  body.set('username', username);
  body.set('password', password);
  return fetch(`http://127.0.0.1:${port}/hq/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
}

// Полный успешный вход одним вызовом — используется тестами, для которых
// сам логин не является предметом проверки (например, «Обзор» без
// приватных полей).
async function loginAsOwner(port) {
  const login = await getLoginPage(port);
  const res = await postLogin(port, { cookie: login.cookie, csrf: login.csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  assert.equal(res.status, 302, 'логин с верными данными должен редиректить (302) на /hq');
  const authedCookie = cookieHeaderFrom(res) || login.cookie;
  return authedCookie;
}

// ===========================================================================
// B1-B3: Login success/failure
// ===========================================================================

test('B1: успешный вход — верные логин/пароль редиректят на /hq, session ID ротируется', withHqApp({}, async ({ port }) => {
  const login = await getLoginPage(port);
  const res = await postLogin(port, { cookie: login.cookie, csrf: login.csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/hq');
  const newCookie = cookieHeaderFrom(res);
  assert.ok(newCookie, 'после успешного логина должна прийти новая cookie (regenerate)');
  assert.notEqual(newCookie, login.cookie, 'session ID должен смениться после логина (защита от session fixation)');
}));

test('B2: неверный пароль — 401, тот же текст ошибки, что и для неверного логина', withHqApp({}, async ({ port }) => {
  const login = await getLoginPage(port);
  const res = await postLogin(port, { cookie: login.cookie, csrf: login.csrf, username: TEST_HQ_USER, password: 'совершенно-неверный' });
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Неверный логин или пароль/);
}));

test('B3: неверный логин — 401, идентичная внешняя ошибка (нет сигнала «пользователь не существует»)', withHqApp({}, async ({ port }) => {
  const login = await getLoginPage(port);
  const res = await postLogin(port, { cookie: login.cookie, csrf: login.csrf, username: 'нет-такого-пользователя', password: TEST_HQ_PASSWORD });
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Неверный логин или пароль/);
}));

// ===========================================================================
// B4: Rate limit
// ===========================================================================

test('B4: перебор пароля — после превышения лимита попыток ответ 429', withHqApp({}, async ({ port }) => {
  const login = await getLoginPage(port);
  let lastStatus = null;
  for (let i = 0; i < 9; i += 1) {
    const res = await postLogin(port, { cookie: login.cookie, csrf: login.csrf, username: TEST_HQ_USER, password: 'неверный-пароль-' + i });
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'после 8 неверных попыток за 15 минут дальнейшие запросы должны быть заблокированы (429)');
}));

// ===========================================================================
// B5-B7: защищённый маршрут, logout
// ===========================================================================

test('B5: /hq без сессии — редирект на /hq/login (HTML), 401 без деталей (JSON)', withHqApp({}, async ({ port }) => {
  const htmlRes = await fetch(`http://127.0.0.1:${port}/hq`, { redirect: 'manual' });
  assert.equal(htmlRes.status, 302);
  assert.equal(htmlRes.headers.get('location'), '/hq/login');

  const jsonRes = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Accept: 'application/json' } });
  assert.equal(jsonRes.status, 401);
  const body = await jsonRes.json();
  assert.ok(!/stack|internal|error at/i.test(JSON.stringify(body)), 'ответ не должен содержать технических деталей');
}));

test('B6: /hq с валидной сессией — 200, содержит «Обзор»', withHqApp({}, async ({ port }) => {
  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Обзор/);
}));

test('B7: logout уничтожает сессию — /hq после выхода снова редиректит на /hq/login', withHqApp({}, async ({ port }) => {
  const cookie = await loginAsOwner(port);

  const overviewBefore = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  const csrfMatch = (await overviewBefore.text()).match(/name="_csrf" value="([^"]*)"/);
  assert.ok(csrfMatch, 'на странице «Обзор» тоже должен быть CSRF-токен для формы logout');

  const body = new URLSearchParams();
  body.set('_csrf', csrfMatch[1]);
  const logoutRes = await fetch(`http://127.0.0.1:${port}/hq/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  assert.equal(logoutRes.status, 302);
  assert.equal(logoutRes.headers.get('location'), '/hq/login');

  // Старая cookie (тот же browser-visible session ID) больше не должна работать.
  const afterLogout = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(afterLogout.status, 302);
  assert.equal(afterLogout.headers.get('location'), '/hq/login');
}));

// ===========================================================================
// B8: cookie flags
// ===========================================================================

test('B8: cookie сессии — HttpOnly, SameSite=Lax, Path=/hq, без Secure вне production', withHqApp({}, async ({ port }) => {
  const login = await getLoginPage(port);
  const res = await postLogin(port, { cookie: login.cookie, csrf: login.csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('yaam.hq.sid='));
  assert.ok(raw, 'ожидается cookie с именем yaam.hq.sid');
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Path=\/hq/i);
  assert.ok(!/Secure/i.test(raw), 'вне production Secure не должен выставляться (иначе логин сломается по обычному http)');
}));

test('B8b: production (isProduction через APP_ENV) — cookie получает флаг Secure', withHqApp({ env: { ...process.env, APP_ENV: 'production', TRUST_PROXY: 'loopback', PG_HEALTH_HOST: '127.0.0.1' } }, async ({ port }) => {
  // express-session с cookie.secure=true намеренно НЕ отправляет Set-Cookie
  // по-настоящему незащищённому HTTP-соединению (иначе флаг Secure был бы
  // фикцией) — в тесте нет реального TLS, поэтому здесь честно
  // эмулируется https через X-Forwarded-Proto за доверенным loopback-прокси
  // (TRUST_PROXY=loopback уже включён выше), тот же механизм, которым в
  // реальном production пользуется req.secure за Nginx.
  const httpsHeaders = { 'X-Forwarded-Proto': 'https' };
  const loginRes = await fetch(`http://127.0.0.1:${port}/hq/login`, { headers: httpsHeaders });
  const html = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(html);
  assert.ok(cookie, 'при https (через X-Forwarded-Proto за доверенным прокси) Secure-cookie должна выставляться');

  const body = new URLSearchParams();
  body.set('_csrf', csrf);
  body.set('username', TEST_HQ_USER);
  body.set('password', TEST_HQ_PASSWORD);
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...httpsHeaders, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  assert.equal(res.status, 302);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('yaam.hq.sid='));
  assert.ok(raw);
  assert.match(raw, /Secure/i);
}));

// ===========================================================================
// B9: CSRF
// ===========================================================================

test('B9: логин без CSRF-токена — 403', withHqApp({}, async ({ port }) => {
  const login = await getLoginPage(port);
  const res = await postLogin(port, { cookie: login.cookie, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  assert.equal(res.status, 403);
}));

test('B9b: logout без CSRF-токена — 403, сессия остаётся активной', withHqApp({}, async ({ port }) => {
  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: '',
  });
  assert.equal(res.status, 403);

  const stillIn = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  assert.equal(stillIn.status, 200, 'отклонённый без CSRF logout не должен был разлогинить пользователя');
}));

// ===========================================================================
// B10: отсутствие приватных полей на «Обзоре»
// ===========================================================================

test('B10: «Обзор» не содержит connect_code/telegram_chat_id ресторана', withHqApp({}, async ({ port }) => {
  const secretChatId = '999888777';
  const secretConnectCode = 'SECRET-CONNECT-CODE-123';
  await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count, telegram_chat_id, connect_code)
     VALUES ('HQ Stage2 Privacy Test', 'test', $1, 1, 0, '+79280000098', 4.5, 3, $2, $3)`,
    [JSON.stringify(['Грозный']), secretChatId, secretConnectCode],
  );

  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /HQ Stage2 Privacy Test/, 'ресторан должен быть виден в списке');
  assert.ok(!html.includes(secretChatId), 'telegram_chat_id не должен утекать в HTML «Обзора»');
  assert.ok(!html.includes(secretConnectCode), 'connect_code не должен утекать в HTML «Обзора»');
}));

// ===========================================================================
// B11: fail-closed при отсутствующих/некорректных ENV
// ===========================================================================

test('B11a: без HQ_ADMIN_USER/HQ_ADMIN_PASSWORD_HASH/HQ_SESSION_SECRET — /hq вообще не смонтирован (404)', withHqApp({
  hqAdminUser: undefined, hqAdminPasswordHash: undefined, hqSessionSecret: undefined,
}, async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  assert.equal(res.status, 404);
}));

test('B11b: HQ_ADMIN_USER задан один, без HQ_ADMIN_PASSWORD_HASH — приложение отказывается стартовать', () => {
  const appModule = reloadHqAppModule();
  assert.throws(() => {
    appModule.createPostgresqlApp({ port: 0, env: { ...process.env, HQ_ADMIN_USER: 'owner' } });
  }, /HQ_ADMIN_USER и HQ_ADMIN_PASSWORD_HASH должны быть заданы вместе/);
});

test('B11c (обновлено Stage 3): HQ_ADMIN_USER+HQ_ADMIN_PASSWORD_HASH заданы, но без HQ_SESSION_SECRET — приложение НЕ отказывается стартовать, HQ просто не смонтирован', withHqApp({
  hqAdminUser: 'owner', hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: undefined,
}, async ({ port }) => {
  // Stage 2: HQ_SESSION_SECRET был обязателен, ТОЛЬКО когда задан
  // HQ_ADMIN_USER (владелец жил в .env, "наполовину настроенный" вход был
  // бы небезопасен) — createPostgresqlApp() бросал на старте.
  //
  // Stage 3: владелец хранится в PostgreSQL (hq_owner), а HQ_ADMIN_USER/
  // HQ_ADMIN_PASSWORD_HASH используются ТОЛЬКО для одноразового bootstrap
  // пустой таблицы — сами по себе они больше не делают HQ "наполовину
  // настроенным". Единственное, без чего HQ не может существовать в
  // принципе — HQ_SESSION_SECRET (без него невозможны сессии вообще,
  // независимо от того, где живёт владелец). Поэтому теперь это НЕ ошибка
  // конфигурации, а прежний fail-closed сценарий "HQ выключен" (как B11a) —
  // приложение стартует нормально, роутер просто не монтируется (404).
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  assert.equal(res.status, 404, 'без HQ_SESSION_SECRET роутер не должен монтироваться, даже если заданы ADMIN_USER/HASH');
}));

test('B11d: HQ_SESSION_SECRET короче 32 символов — приложение отказывается стартовать', () => {
  const appModule = reloadHqAppModule();
  assert.throws(() => {
    appModule.createPostgresqlApp({
      port: 0,
      env: {
        ...process.env,
        HQ_ADMIN_USER: 'owner',
        HQ_ADMIN_PASSWORD_HASH: TEST_HQ_PASSWORD_HASH,
        HQ_SESSION_SECRET: 'слишком-короткий',
      },
    });
  }, /не короче 32 символов/);
});
