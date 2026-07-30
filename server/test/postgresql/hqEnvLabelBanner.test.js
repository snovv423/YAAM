'use strict';

// Тестовая маркировка HQ (HQ_ENV_LABEL) — задача "hqtest deployment prep",
// п.1. Тот же embedded-PostgreSQL HTTP-harness, что и hqAuthStage2.test.js
// (реальный createPostgresqlApp(), реальный HTTP-логин), плюс прямые
// unit-проверки renderTestBanner()/renderLoginPage() без HTTP там, где это
// достаточно и быстрее.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_hq_env_label_banner_test';

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../hq/layout.js'),
];

const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Test';
const TEST_SESSION_SECRET = 'a'.repeat(48);
const BANNER_TEXT = 'ТЕСТОВЫЙ РЕЖИМ — ДАННЫЕ И ОПЕРАЦИИ НЕ РЕАЛЬНЫЕ';

let cluster;
let db;
let hashPassword;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  delete process.env.APP_ENV;
  delete process.env.HQ_ADMIN_USER;
  delete process.env.HQ_ADMIN_PASSWORD_HASH;
  delete process.env.HQ_SESSION_SECRET;
  delete process.env.HQ_ENV_LABEL;

  cluster = await startEmbeddedPostgres('hq-env-label-banner');
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

// HQ_ENV_LABEL читается напрямую из process.env (см. hq/layout.js) —
// каждый тест ставит и снимает своё значение, чтобы тесты не влияли друг
// на друга (тот же принцип изоляции, что и остальные ENV-мутирующие тесты
// этой директории).
beforeEach(() => { delete process.env.HQ_ENV_LABEL; });
afterEach(() => { delete process.env.HQ_ENV_LABEL; });

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
function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
async function getLoginPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const html = await res.text();
  return { res, html, cookie: cookieHeaderFrom(res), csrf: extractCsrf(html) };
}
async function loginAsOwner(port) {
  const login = await getLoginPage(port);
  const body = new URLSearchParams();
  body.set('_csrf', login.csrf);
  body.set('username', TEST_HQ_USER);
  body.set('password', TEST_HQ_PASSWORD);
  const res = await fetch(`http://127.0.0.1:${port}/hq/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: login.cookie },
    body: body.toString(),
  });
  assert.equal(res.status, 302);
  return cookieHeaderFrom(res) || login.cookie;
}

// ===========================================================================
// Unit-level: renderTestBanner()/testBannerStyle() напрямую (без HTTP)
// ===========================================================================

test('renderTestBanner(): пусто, если HQ_ENV_LABEL не задан', () => {
  delete require.cache[require.resolve('../../hq/layout.js')];
  const { renderTestBanner } = require('../../hq/layout.js');
  delete process.env.HQ_ENV_LABEL;
  assert.equal(renderTestBanner(), '');
});

test('renderTestBanner(): содержит обязательный фиксированный текст и НЕ зависит от конкретного значения переменной', () => {
  delete require.cache[require.resolve('../../hq/layout.js')];
  const { renderTestBanner } = require('../../hq/layout.js');
  process.env.HQ_ENV_LABEL = 'TEST';
  const html1 = renderTestBanner();
  assert.match(html1, new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  process.env.HQ_ENV_LABEL = 'QA-2';
  const html2 = renderTestBanner();
  assert.match(html2, new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'фиксированный текст обязан присутствовать при ЛЮБОМ непустом значении переменной');
});

test('renderTestBanner(): значение переменной экранируется перед выводом (HTML escaping)', () => {
  delete require.cache[require.resolve('../../hq/layout.js')];
  const { renderTestBanner } = require('../../hq/layout.js');
  process.env.HQ_ENV_LABEL = '<script>alert(1)</script>&"\'';
  const html = renderTestBanner();
  assert.equal(html.includes('<script>alert(1)</script>'), false, 'сырой HTML/JS не должен попасть в вывод не экранированным');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;/);
  assert.match(html, /&#39;/);
});

test('renderTestBanner(): пусто для пустой строки (значение задано, но фактически пустое)', () => {
  delete require.cache[require.resolve('../../hq/layout.js')];
  const { renderTestBanner } = require('../../hq/layout.js');
  process.env.HQ_ENV_LABEL = '';
  assert.equal(renderTestBanner(), '');
});

// ===========================================================================
// HTTP-level: страница логина
// ===========================================================================

test('Логин: баннер отсутствует полностью, если HQ_ENV_LABEL не задан', withHqApp({}, async ({ port }) => {
  delete process.env.HQ_ENV_LABEL;
  const { html } = await getLoginPage(port);
  assert.equal(html.includes('hq-test-banner'), false);
  assert.equal(html.includes('ТЕСТОВЫЙ РЕЖИМ'), false);
}));

test('Логин: баннер присутствует и виден, если HQ_ENV_LABEL задан', withHqApp({}, async ({ port }) => {
  process.env.HQ_ENV_LABEL = 'TEST';
  const { html } = await getLoginPage(port);
  assert.match(html, /class="hq-test-banner"/);
  assert.match(html, new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Баннер — самый первый элемент внутри <body>, до формы логина (гарантия
  // "несъёмности": он не спрятан внутри условно рендерящегося блока формы).
  // indexOf('hq-test-banner') находил бы первым CSS-правило .hq-test-banner{
  // в <style> (до <body>) — ищем именно сам элемент (class="hq-test-banner"),
  // не любое упоминание строки.
  const bodyIdx = html.indexOf('<body>');
  const bannerIdx = html.indexOf('class="hq-test-banner"');
  const formIdx = html.indexOf('id="hq-login-form"');
  assert.ok(bodyIdx < bannerIdx && bannerIdx < formIdx, 'баннер должен быть между <body> и формой логина');
}));

// ===========================================================================
// HTTP-level: авторизованные страницы (Обзор, Рестораны, ...)
// ===========================================================================

test('Обзор (авторизованная страница): баннер отсутствует без HQ_ENV_LABEL', withHqApp({}, async ({ port }) => {
  delete process.env.HQ_ENV_LABEL;
  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.equal(html.includes('hq-test-banner'), false);
  assert.equal(html.includes('ТЕСТОВЫЙ РЕЖИМ'), false);
}));

test('Обзор (авторизованная страница): баннер присутствует с HQ_ENV_LABEL, включает экранированное значение', withHqApp({}, async ({ port }) => {
  process.env.HQ_ENV_LABEL = 'hqtest<x>';
  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.match(html, /class="hq-test-banner"/);
  assert.match(html, new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(html.includes('<x>'), false);
  assert.match(html, /hqtest&lt;x&gt;/);
  // Баннер — сразу после <body>, ДО .shell (sidebar+main) — не встроен
  // внутрь тела страницы, где его можно было бы случайно не вывести.
  const bodyIdx = html.indexOf('<body>');
  const bannerIdx = html.indexOf('class="hq-test-banner"');
  const shellIdx = html.indexOf('class="shell"');
  assert.ok(bodyIdx < bannerIdx && bannerIdx < shellIdx);
}));

test('Настройки/Рестораны/Финансы/Выплаты — баннер присутствует на КАЖДОЙ авторизованной странице, не только на «Обзоре»', withHqApp({}, async ({ port }) => {
  process.env.HQ_ENV_LABEL = 'TEST';
  const cookie = await loginAsOwner(port);
  for (const url of ['/hq', '/hq/restaurants', '/hq/finance', '/hq/payouts', '/hq/settings']) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /class="hq-test-banner"/, `баннер отсутствует на ${url}`);
  }
}));

// ===========================================================================
// Геометрия: баннер не перекрывает header/nav/safe-area (сдвиг остальных
// фиксированных элементов вычисляется корректно)
// ===========================================================================

test('CSS: при заданном HQ_ENV_LABEL мобильный header (.mobile-top) сдвинут на высоту баннера, не перекрыт им', withHqApp({}, async ({ port }) => {
  process.env.HQ_ENV_LABEL = 'TEST';
  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.match(html, /\.hq-test-banner\{[^}]*height:32px/);
  assert.match(html, /\.mobile-top\{[^}]*top:32px/, '.mobile-top должен сдвинуться ровно на высоту баннера (32px), а не остаться на top:0');
  assert.match(html, /body\{[^}]*padding:32px 0 0/, 'body должен получить padding-top ровно на высоту баннера — сдвигает desktop-сайдбар/main вниз');
}));

test('CSS: без HQ_ENV_LABEL геометрия НЕ меняется (нулевой сдвиг, поведение как раньше)', withHqApp({}, async ({ port }) => {
  delete process.env.HQ_ENV_LABEL;
  const cookie = await loginAsOwner(port);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.equal(html.includes('.hq-test-banner{'), false);
  assert.match(html, /\.mobile-top\{[^}]*top:0px/);
  assert.match(html, /body\{[^}]*padding:0px 0 0/);
}));

// ===========================================================================
// Безопасность/бизнес-логика — не затронуты этой фичей
// ===========================================================================

test('HQ_ENV_LABEL не влияет на login/CSRF/сессию — существующий флоу логина работает как раньше', withHqApp({}, async ({ port }) => {
  process.env.HQ_ENV_LABEL = 'TEST';
  const cookie = await loginAsOwner(port);
  assert.ok(cookie);
  const res = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
}));
