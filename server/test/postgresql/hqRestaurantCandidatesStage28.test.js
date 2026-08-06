'use strict';

// YAAM HQ «Кого ждём» — после Stage 28, раздел 2 задания. Интеграционные
// тесты против настоящего embedded PostgreSQL + настоящего HTTP-сервера,
// тот же harness/паттерн, что и test/postgresql/hqRestaurantAdminStage4.test.js.
//
// A — services/hq/restaurantCandidateService.js напрямую.
// B — полный HTTP-цикл через HQ: список/добавление/удаление, CSRF, auth,
//     валидация (только название обязательно, раздел 2.3).
// C — публичный GET /api/restaurant-candidates (без авторизации) — источник
//     данных клиентского голосования вместо захардкоженного массива.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
  require.resolve('../../routes/postgresql/api.js'),
];

const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const TEST_SESSION_SECRET = 'e'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Candidates';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-restaurant-candidates-stage28');
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});

after(async () => {
  await cluster.stop();
});

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const setupClient = cluster.getClient(name);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
  return cluster.connectionString(name);
}

function reloadHqAppModule() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  return require('../../services/postgresql/app.js');
}

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице');
  return m[1];
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

async function startApp(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  const appModule = reloadHqAppModule();
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, port, base: `http://127.0.0.1:${port}` };
}

async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
}

async function loginHq(base) {
  const loginRes = await fetch(`${base}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const body = new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD });
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  return cookieHeaderFrom(postRes) || cookie;
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
// A. services/hq/restaurantCandidateService.js
// ===========================================================================

test('A1: createCandidate — пустое название отклонено (ValidationError), пробелы обрезаются', async () => {
  const databaseUrl = await freshDatabase('cand_svc_a1');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../services/hq/restaurantCandidateService.js')];
  delete require.cache[require.resolve('../../db/postgresql')];
  const svc = require('../../services/hq/restaurantCandidateService.js');
  const db = require('../../db/postgresql');
  try {
    await assert.rejects(() => svc.createCandidate({ name: '  ', cuisine: 'Фастфуд' }), svc.ValidationError);
    const created = await svc.createCandidate({ name: '  KFC  ', cuisine: '  Фастфуд  ' });
    assert.equal(created.name, 'KFC');
    assert.equal(created.cuisine, 'Фастфуд');
    assert.equal(created.votes, 0, 'новый кандидат стартует с нуля голосов — форма добавления их не задаёт (раздел 2.3)');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('A2: listCandidates — сортировка по голосам по убыванию; deleteCandidate убирает запись полностью', async () => {
  const databaseUrl = await freshDatabase('cand_svc_a2');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../services/hq/restaurantCandidateService.js')];
  delete require.cache[require.resolve('../../db/postgresql')];
  const svc = require('../../services/hq/restaurantCandidateService.js');
  const db = require('../../db/postgresql');
  try {
    const low = await svc.createCandidate({ name: 'Низкий рейтинг', cuisine: '' });
    const high = await svc.createCandidate({ name: 'Высокий рейтинг', cuisine: '' });
    await db.execute('UPDATE restaurant_candidates SET votes = 50 WHERE id = $1', [high.id]);
    await db.execute('UPDATE restaurant_candidates SET votes = 5 WHERE id = $1', [low.id]);

    const list = await svc.listCandidates();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, high.id, 'больше голосов — выше в списке');
    assert.equal(list[1].id, low.id);

    await svc.deleteCandidate(high.id);
    const afterDelete = await svc.listCandidates();
    assert.equal(afterDelete.length, 1);
    assert.equal(afterDelete[0].id, low.id);
    assert.equal(await svc.getCandidateById(high.id), null, 'удаление — не мягкое, записи не остаётся вовсе (раздел 2.4)');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// B. Полный HTTP-цикл через HQ
// ===========================================================================

test('B1: HQ — список пуст, добавление кандидата, отображается с 0 голосов, кнопка удаления работает', async () => {
  const databaseUrl = await freshDatabase('cand_http_b1');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);

    let page = await getPage(base, cookie, '/hq/restaurants/candidates');
    assert.equal(page.status, 200);
    assert.match(page.html, /Кандидатов пока нет/);

    // Форма добавления — только название и кухня (раздел 2.3): страница не
    // должна содержать полей фото/меню/адреса/часов/статуса.
    assert.doesNotMatch(page.html, /name="photo"|name="menu"|name="address"|name="hours"|name="status"/);

    let res = await postForm(base, cookie, '/hq/restaurants/candidates', { _csrf: page.csrf, name: 'KFC', cuisine: 'Фастфуд' });
    assert.equal(res.status, 302, 'успешное добавление -> PRG редирект');
    assert.equal(res.headers.get('location'), '/hq/restaurants/candidates');

    page = await getPage(base, cookie, '/hq/restaurants/candidates');
    assert.match(page.html, /KFC/);
    assert.match(page.html, /Фастфуд/);
    assert.match(page.html, /0 голосов/);

    // Удаление.
    const db = require('../../db/postgresql');
    const rows = await db.query("SELECT id FROM restaurant_candidates WHERE name = 'KFC'");
    const candidateId = rows[0].id;
    res = await postForm(base, cookie, `/hq/restaurants/candidates/${candidateId}/delete`, { _csrf: page.csrf });
    assert.equal(res.status, 302);
    page = await getPage(base, cookie, '/hq/restaurants/candidates');
    assert.doesNotMatch(page.html, /KFC/);
    assert.match(page.html, /Кандидатов пока нет/);
  } finally {
    await stopApp(instance);
  }
});

test('B2: HQ — пустое название отклонено с понятной ошибкой, ничего не создаётся', async () => {
  const databaseUrl = await freshDatabase('cand_http_b2');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const page = await getPage(base, cookie, '/hq/restaurants/candidates');
    const res = await postForm(base, cookie, '/hq/restaurants/candidates', { _csrf: page.csrf, name: '', cuisine: 'Пицца' });
    assert.equal(res.status, 302, 'ValidationError -> PRG редирект с ?error=');
    assert.match(res.headers.get('location'), /error=/);
    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT count(*)::int AS n FROM restaurant_candidates');
    assert.equal(rows[0].n, 0);
  } finally {
    await stopApp(instance);
  }
});

test('B3: /hq/restaurants/candidates требует аутентификации и CSRF на POST', async () => {
  const databaseUrl = await freshDatabase('cand_http_b3');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const noAuth = await fetch(`${base}/hq/restaurants/candidates`, { redirect: 'manual' });
    assert.equal(noAuth.status, 302, 'без сессии — редирект на логин, не 200');

    const cookie = await loginHq(base);
    const noCsrf = await fetch(`${base}/hq/restaurants/candidates`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ name: 'Без CSRF' }).toString(),
    });
    assert.ok(noCsrf.status === 403 || noCsrf.status === 400, 'POST без CSRF-токена должен быть отклонён');
    const db = require('../../db/postgresql');
    const rows = await db.query('SELECT count(*)::int AS n FROM restaurant_candidates');
    assert.equal(rows[0].n, 0);
  } finally {
    await stopApp(instance);
  }
});

test('B4: кнопка "Кого ждём" — на странице списка ресторанов, ведёт на /hq/restaurants/candidates, не совпадает с /:id ресторана', async () => {
  const databaseUrl = await freshDatabase('cand_http_b4');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const list = await getPage(base, cookie, '/hq/restaurants');
    assert.match(list.html, /href="\/hq\/restaurants\/candidates"/);
    assert.match(list.html, /Кого ждём/);

    // GET '/candidates' не должен попасть в обработчик '/:id' (честная
    // страница со списком кандидатов, а не 404 "ресторан не найден").
    const page = await getPage(base, cookie, '/hq/restaurants/candidates');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.html, /Ресторан не найден/);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// C. Публичный API — источник данных клиентского голосования
// ===========================================================================

test('C1: GET /api/restaurant-candidates — без авторизации, отсортирован по голосам, только name/cuisine/votes', async () => {
  const databaseUrl = await freshDatabase('cand_http_c1');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    let page = await getPage(base, cookie, '/hq/restaurants/candidates');
    await postForm(base, cookie, '/hq/restaurants/candidates', { _csrf: page.csrf, name: 'Домино\'с Пицца', cuisine: 'Пицца' });
    page = await getPage(base, cookie, '/hq/restaurants/candidates');
    await postForm(base, cookie, '/hq/restaurants/candidates', { _csrf: page.csrf, name: 'KFC', cuisine: 'Фастфуд' });

    const db = require('../../db/postgresql');
    await db.execute('UPDATE restaurant_candidates SET votes = 100 WHERE name = $1', ['KFC']);
    await db.execute('UPDATE restaurant_candidates SET votes = 10 WHERE name = $1', ['Домино\'с Пицца']);

    // Без cookie/авторизации — публичный, как и /api/restaurants.
    const res = await fetch(`${base}/api/restaurant-candidates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].name, 'KFC', 'больше голосов — первый в списке');
    // Stage 29.1, п.3: id теперь ОБЯЗАТЕЛЕН в публичном ответе — клиент
    // должен адресовать голос (POST /restaurant-candidates/:id/vote)
    // конкретному кандидату; id не секрет (уже виден в HQ). created_at по-
    // прежнему не отдаётся — это внутренняя деталь, карточке не нужна.
    assert.deepEqual(Object.keys(body[0]).sort(), ['cuisine', 'id', 'name', 'votes'], 'id нужен для голосования (Stage 29.1), created_at — нет');
  } finally {
    await stopApp(instance);
  }
});

test('C2: GET /api/restaurant-candidates — пустой список без кандидатов, не 500', async () => {
  const databaseUrl = await freshDatabase('cand_http_c2');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const res = await fetch(`${base}/api/restaurant-candidates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, []);
  } finally {
    await stopApp(instance);
  }
});
