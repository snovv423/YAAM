'use strict';

// Текст на главной странице сайта редактируется владельцем в HQ («Обзор» ->
// «Текст на главной») и хранится в app_settings. Клиент своей копии текста не
// держит вовсе, поэтому сервер обязан всегда отдавать готовую пару строк —
// сохранённую или встроенную.
//
// A — сервис: значения по умолчанию, сохранение, нормализация, пределы.
// B — HQ: блок на «Обзоре», сохранение, спокойное подтверждение, аудит, CSRF.
// C — публичная ручка: то же значение, что сохранил владелец.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/lifecycle.js'),
  require.resolve('../../services/postgresql/health.js'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../services/hq/ownerService.js'),
  require.resolve('../../services/hq/securityLog.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/hq/homeContentService.js'),
  require.resolve('../../services/hq/restaurantStatsService.js'),
  require.resolve('../../services/hq/menuAdminService.js'),
  require.resolve('../../services/hq/restaurantAdminService.js'),
  require.resolve('../../services/hq/media/photoService.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/admin.js'),
];

const TEST_SESSION_SECRET = 'b'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#HomeTxt';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-home-content');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}
function cookieHeaderFrom(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return set.map((x) => x.split(';')[0]).join('; ');
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден');
  return m[1];
}
async function waitForAddress(instance, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer никогда не начал слушать');
}
async function startApp(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.APP_ENV = 'local';
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  const appModule = require('../../services/postgresql/app.js');
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, base: `http://127.0.0.1:${port}` };
}
async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
}
async function loginHq(base) {
  const r = await fetch(`${base}/hq/login`);
  const html = await r.text();
  const cookie = cookieHeaderFrom(r);
  const post = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: extractCsrf(html), username: TEST_HQ_USER, password: TEST_HQ_PASSWORD }).toString(),
  });
  return cookieHeaderFrom(post) || cookie;
}
async function getPage(base, cookie, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  return { res, html, status: res.status, csrf: html.includes('name="_csrf"') ? extractCsrf(html) : null };
}
async function postForm(base, cookie, urlPath, fields) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

// ===========================================================================
// A. Сервис
// ===========================================================================

test('A: до первой правки отдаётся встроенный текст, после — сохранённый', async () => {
  const url = await freshDatabase('yaam_home_a');
  process.env.DATABASE_URL = url;
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  const db = require('../../db/postgresql');
  const svc = require('../../services/hq/homeContentService');
  const { ValidationError } = require('../../services/hq/restaurantLifecycle');
  try {
    const initial = await svc.getHomeContent();
    assert.equal(initial.neon, svc.DEFAULT_NEON);
    assert.equal(initial.subtext, svc.DEFAULT_SUBTEXT);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_settings'))[0].n, 0,
      'встроенный текст не создаёт строк — «не меняли» остаётся «не меняли»');

    await svc.updateHomeContent({ neon: '  Новый неон  ', subtext: 'Первая строка\r\nВторая строка   ' });
    const saved = await svc.getHomeContent();
    assert.equal(saved.neon, 'Новый неон', 'края обрезаются');
    assert.equal(saved.subtext, 'Первая строка\nВторая строка',
      'перенос владельца сохраняется, хвостовые пробелы и \\r — нет');

    // Повторное сохранение обновляет ту же строку, а не плодит новые.
    await svc.updateHomeContent({ neon: 'Ещё раз', subtext: 'И подтекст' });
    assert.equal((await db.query('SELECT count(*)::int n FROM app_settings'))[0].n, 2);

    for (const bad of [
      { neon: '', subtext: 'ок' },
      { neon: '   ', subtext: 'ок' },
      { neon: 'ок', subtext: '' },
      { neon: 'x'.repeat(svc.NEON_MAX + 1), subtext: 'ок' },
      { neon: 'ок', subtext: 'y'.repeat(svc.SUBTEXT_MAX + 1) },
    ]) {
      await assert.rejects(() => svc.updateHomeContent(bad), ValidationError);
    }
    // Отказ ничего не переписал.
    const after = await svc.getHomeContent();
    assert.equal(after.neon, 'Ещё раз');
    assert.equal(after.subtext, 'И подтекст');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// B + C. HQ и публичная ручка
// ===========================================================================

test('B: блок «Текст на главной» стоит под Центром событий, сохраняет и переживает reload', async () => {
  const url = await freshDatabase('yaam_home_b');
  const { instance, base } = await startApp(url);
  const db = require('../../db/postgresql');
  const svc = require('../../services/hq/homeContentService');
  try {
    const cookie = await loginHq(base);
    let page = await getPage(base, cookie, '/hq/');
    assert.equal(page.status, 200);

    // Блок — сразу ПОСЛЕ Центра событий. Ищем именно разметку блока, а не
    // фразу: она встречается ещё и в комментарии к стилям в <head>.
    const eventCenterAt = page.html.indexOf('id="hq-event-center"');
    const blockAt = page.html.indexOf('<div class="panel home-text">');
    assert.ok(eventCenterAt > -1, 'Центр событий должен быть на «Обзоре»');
    assert.ok(blockAt > eventCenterAt, 'блок обязан идти под Центром событий');
    // И ничего постороннего между ними — блок стоит сразу под лентой.
    const between = page.html.slice(page.html.indexOf('</div>', page.html.indexOf('event-center-footer')), blockAt);
    assert.ok(!/<div class="panel/.test(between), 'между Центром событий и блоком не должно быть других панелей');

    // Два поля, авто-рост, одна кнопка сохранения.
    assert.match(page.html, /<textarea id="hc-neon" name="neon" data-autogrow[^>]*>/);
    assert.match(page.html, /<textarea id="hc-subtext" name="subtext" data-autogrow[^>]*>/);
    assert.match(page.html, />Неон</);
    assert.match(page.html, />Подтекст</);
    const formHtml = /<form method="post" action="\/hq\/home-content"[\s\S]*?<\/form>/.exec(page.html)[0];
    assert.equal((formHtml.match(/<button type="submit"/g) || []).length, 1, 'одна кнопка «Сохранить»');
    assert.match(formHtml, />Сохранить</);
    // До сохранения поля содержат действующий текст, а не пустоту.
    assert.ok(formHtml.includes(svc.DEFAULT_NEON));

    // Без CSRF не сохраняется.
    assert.equal((await postForm(base, cookie, '/hq/home-content', { neon: 'x', subtext: 'y' })).status, 403);

    // Сохранение — Post/Redirect/Get, подтверждение спокойной строкой.
    const res = await postForm(base, cookie, '/hq/home-content', {
      _csrf: page.csrf, neon: 'HQ неон', subtext: 'HQ подтекст, довольно длинный, чтобы поле подросло.',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/hq/?saved=1');

    page = await getPage(base, cookie, '/hq/?saved=1');
    assert.match(page.html, /home-text-saved">Сохранено</);
    assert.ok(page.html.includes('HQ неон'));

    // Reload HQ без параметра — текст на месте, подтверждение исчезло.
    page = await getPage(base, cookie, '/hq/');
    assert.ok(page.html.includes('HQ неон'));
    assert.ok(page.html.includes('HQ подтекст'));
    // Снова ищем разметку, а не имя класса: правило .home-text-saved лежит
    // в общем <style> на каждой странице.
    assert.doesNotMatch(page.html, /home-text-saved">Сохранено</);

    // Аудит зафиксировал правку.
    const audit = await db.query("SELECT action FROM hq_audit_log WHERE action = 'home_content_updated'");
    assert.equal(audit.length, 1);

    // C. Публичная ручка отдаёт ровно то же самое.
    const publicRes = await fetch(`${base}/api/home-content`);
    assert.equal(publicRes.status, 200);
    assert.deepEqual(await publicRes.json(), {
      neon: 'HQ неон', subtext: 'HQ подтекст, довольно длинный, чтобы поле подросло.',
    });

    // Ошибка валидации возвращает на «Обзор» с понятным текстом, не 500.
    page = await getPage(base, cookie, '/hq/');
    const bad = await postForm(base, cookie, '/hq/home-content', { _csrf: page.csrf, neon: '   ', subtext: 'ок' });
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location'), /^\/hq\/\?error=/);
    const errPage = await getPage(base, cookie, bad.headers.get('location'));
    assert.match(errPage.html, /Неон/);
    assert.ok(errPage.html.includes('HQ неон'), 'прежний текст не затёрт неудачной попыткой');
  } finally {
    await stopApp(instance);
  }
});

test('C: без единой правки публичная ручка отдаёт встроенный текст, а не пустоту', async () => {
  const url = await freshDatabase('yaam_home_c');
  const { instance, base } = await startApp(url);
  const svc = require('../../services/hq/homeContentService');
  try {
    const payload = await (await fetch(`${base}/api/home-content`)).json();
    assert.equal(payload.neon, svc.DEFAULT_NEON);
    assert.equal(payload.subtext, svc.DEFAULT_SUBTEXT);
    assert.ok(payload.neon.length > 0 && payload.subtext.length > 0);
  } finally {
    await stopApp(instance);
  }
});
