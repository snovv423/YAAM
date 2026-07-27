'use strict';

// YAAM HQ Stage 4.1 — интеграционные тесты publication lifecycle (черновик /
// публикация / открытие-закрытие / пауза / архив) против настоящего embedded
// PostgreSQL. Тот же harness-паттерн, что и test/postgresql/
// hqRestaurantAdminStage4.test.js (Stage 4) — каждый Stage-файл в этой
// директории держит свою копию, не общий модуль (устоявшаяся конвенция).
//
// M — миграция/backfill: апгрейд уже существующей (Stage 4) БД.
// A — services/hq/restaurantAdminService.js напрямую: draft/publish/
//     unpublish/open/close/pause/archive/restore transitions.
// B — публичный API: черновик/снятый с публикации/архивированный скрыты;
//     опубликованный закрытый виден.
// C — история заказов/оценок сохраняется через archive/restore.
// D — audit log содержит restaurant_published/restaurant_unpublished.
// E — CSRF/auth/404 на новых lifecycle-маршрутах.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'e'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Lifecycle41';

let cluster;
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-restaurants-stage41');
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

function uniquePhone() {
  return '+79' + String(crypto.randomInt(100000000, 999999999)).padStart(9, '0');
}

// Stage 5A добавил серверную проверку "открыть можно только если есть
// доступное блюдо" (services/hq/restaurantAdminService.js:openRestaurant) —
// эти тесты Stage 4.1 проверяют publication lifecycle, а не меню, поэтому
// им нужен минимальный доступный dish исключительно для того, чтобы
// openRestaurant() вообще мог пройти дальше своих lifecycle-guard'ов.
async function insertAvailableDish(db, restaurantId) {
  const cat = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1, $2) RETURNING id', [restaurantId, 'Cat']);
  await db.execute(
    'INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4)',
    [restaurantId, cat.rows[0].id, 'Dish', 100],
  );
}

// ===========================================================================
// M. Миграция/backfill — апгрейд уже существующей (Stage 4) БД
// ===========================================================================

test('M: повторное применение schema.sql на "старой" (Stage 4, без published_at) БД — backfill существующих, черновик для новых', async () => {
  const dbName = 'yaam_hq_lifecycle_migration_test';
  await cluster.createDatabase(dbName);
  const client = cluster.getClient(dbName);
  await client.connect();
  try {
    await client.query(SCHEMA_SQL); // текущая схема, как на чистом деплое

    // Откатываем ровно то, что добавил Stage 4.1, — воспроизводим состояние
    // реальной БД, которая уже прошла Stage 4 (commit 0a641a3), но ещё не
    // видела эту миграцию.
    await client.query(`
      ALTER TABLE restaurants DROP COLUMN IF EXISTS published_at;
      ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS chk_restaurants_archived_closed;
      ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS chk_restaurants_archived_not_paused;
      ALTER TABLE hq_audit_log DROP CONSTRAINT IF EXISTS hq_audit_log_action_check;
      ALTER TABLE hq_audit_log ADD CONSTRAINT hq_audit_log_action_check CHECK (action IN (
        'restaurant_created', 'restaurant_updated', 'restaurant_paused',
        'restaurant_resumed', 'restaurant_archived', 'restaurant_restored'
      ));
    `);

    // "Существующие" данные — как будто реальный staging после Stage 4.
    const activeRow = await client.query(
      `INSERT INTO restaurants (name, cities, is_open) VALUES ('Существующий Активный', '["Грозный"]', 1) RETURNING id`,
    );
    const archivedRow = await client.query(
      `INSERT INTO restaurants (name, cities, is_open, archived_at) VALUES ('Существующий Архив', '["Грозный"]', 0, NOW()) RETURNING id`,
    );

    // Повторно применяем ТЕКУЩИЙ schema.sql — ровно то, что происходит на
    // staging при деплое (server/docs/postgresql-deployment-runbook.md:
    // `psql --file=db/postgresql/schema.sql` поверх уже существующей БД).
    await client.query(SCHEMA_SQL);

    const rows = (await client.query('SELECT id, published_at FROM restaurants ORDER BY id')).rows;
    const active = rows.find((r) => r.id === activeRow.rows[0].id);
    const archived = rows.find((r) => r.id === archivedRow.rows[0].id);
    assert.ok(active.published_at, 'существующий неархивированный ресторан должен стать опубликованным при апгрейде — не должен пропасть с публичного сайта');
    assert.ok(archived.published_at, 'существующий архивированный тоже backfill-ится (безвредно — видимость и так закрыта archived_at)');

    // Новый ресторан, вставленный ПОСЛЕ повторного применения schema.sql, —
    // черновик (published_at=NULL): DROP DEFAULT сработал, INSERT без явного
    // published_at больше НЕ подхватывает NOW().
    const freshRow = await client.query(
      `INSERT INTO restaurants (name, cities) VALUES ('Новый После Миграции', '["Грозный"]') RETURNING id, published_at`,
    );
    assert.equal(freshRow.rows[0].published_at, null, 'новый ресторан после апгрейда — черновик, не подхватывает бывший default');

    await client.query(`INSERT INTO hq_audit_log (action, restaurant_id) VALUES ('restaurant_published', $1)`, [activeRow.rows[0].id]);

    // Второй подряд редеплой — идемпотентность: ничего не меняет повторно.
    await client.query(SCHEMA_SQL);
    const stillDraft = (await client.query('SELECT published_at FROM restaurants WHERE id = $1', [freshRow.rows[0].id])).rows[0];
    assert.equal(stillDraft.published_at, null, 'повторное применение schema.sql не публикует уже существующий черновик задним числом');
  } finally {
    await client.end();
  }
});

// ===========================================================================
// A. services/hq/restaurantAdminService.js — переходы напрямую
// ===========================================================================

test('A: полный цикл переходов через сервисный слой', async (t) => {
  const databaseUrl = await freshDatabase('yaam_hq_lifecycle_service_test');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/restaurantAdminService')];
  delete require.cache[require.resolve('../../services/hq/restaurantLifecycle')];
  const db = require('../../db/postgresql');
  const svc = require('../../services/hq/restaurantAdminService');
  const { ValidationError } = require('../../services/hq/restaurantLifecycle');

  await t.test('A1: createRestaurant -> черновик (published_at=NULL, is_open=0)', async () => {
    const r = await svc.createRestaurant({ name: 'Черновик Тест', cities: 'Грозный' });
    assert.equal(r.published_at, null);
    assert.equal(r.is_open, 0);
  });

  await t.test('A2: openRestaurant на черновике -> ValidationError "Сначала опубликуйте"', async () => {
    const r = await svc.createRestaurant({ name: 'Открыть Черновик', cities: 'Грозный' });
    await assert.rejects(() => svc.openRestaurant(r.id), ValidationError);
    await assert.rejects(() => svc.openRestaurant(r.id), /Сначала опубликуйте/);
  });

  await t.test('A3: pauseRestaurant на черновике -> отклонено', async () => {
    const r = await svc.createRestaurant({ name: 'Пауза Черновик', cities: 'Грозный' });
    await assert.rejects(() => svc.pauseRestaurant(r.id, 'short'), ValidationError);
  });

  await t.test('A4: publishRestaurant не открывает автоматически', async () => {
    const r = await svc.createRestaurant({ name: 'Публикация Без Открытия', cities: 'Грозный' });
    const published = await svc.publishRestaurant(r.id);
    assert.ok(published.published_at);
    assert.equal(published.is_open, 0, 'публикация НЕ открывает ресторан автоматически (задание, раздел 8)');
  });

  await t.test('A5: publishRestaurant дважды -> ValidationError ("уже опубликован")', async () => {
    const r = await svc.createRestaurant({ name: 'Двойная Публикация', cities: 'Грозный' });
    await svc.publishRestaurant(r.id);
    await assert.rejects(() => svc.publishRestaurant(r.id), ValidationError);
  });

  await t.test('A6: openRestaurant после публикации -> is_open=1', async () => {
    const r = await svc.createRestaurant({ name: 'Открыть После Публикации', cities: 'Грозный' });
    await svc.publishRestaurant(r.id);
    await insertAvailableDish(db, r.id);
    const opened = await svc.openRestaurant(r.id);
    assert.equal(opened.is_open, 1);
  });

  await t.test('A7: closeRestaurant возвращает в "опубликован и закрыт"', async () => {
    const r = await svc.createRestaurant({ name: 'Закрыть', cities: 'Грозный' });
    await svc.publishRestaurant(r.id);
    await insertAvailableDish(db, r.id);
    await svc.openRestaurant(r.id);
    const closed = await svc.closeRestaurant(r.id);
    assert.equal(closed.is_open, 0);
    assert.ok(closed.published_at, 'закрытие не снимает публикацию');
  });

  await t.test('A8: unpublishRestaurant закрывает и снимает паузу', async () => {
    const r = await svc.createRestaurant({ name: 'Снять С Публикации', cities: 'Грозный' });
    await svc.publishRestaurant(r.id);
    await insertAvailableDish(db, r.id);
    await svc.openRestaurant(r.id);
    await svc.pauseRestaurant(r.id, 'short');
    const unpublished = await svc.unpublishRestaurant(r.id);
    assert.equal(unpublished.published_at, null);
    assert.equal(unpublished.is_open, 0);
    assert.equal(unpublished.paused_until, null, 'снятие с публикации очищает активную паузу (задание, раздел 8)');
  });

  await t.test('A9: resumeRestaurant НЕ подменяет "Открыть" — отклонено, если ресторан не на паузе', async () => {
    const r = await svc.createRestaurant({ name: 'Resume Не Пауза', cities: 'Грозный' });
    await svc.publishRestaurant(r.id);
    await insertAvailableDish(db, r.id);
    await svc.openRestaurant(r.id);
    await svc.closeRestaurant(r.id);
    await assert.rejects(() => svc.resumeRestaurant(r.id), /не на паузе/);
  });

  await t.test('A10: archiveRestaurant работает из ЛЮБОГО неархивированного статуса, включая черновик', async () => {
    const r = await svc.createRestaurant({ name: 'Архив Из Черновика', cities: 'Грозный' });
    const archived = await svc.archiveRestaurant(r.id);
    assert.ok(archived.archived_at);
    assert.equal(archived.is_open, 0);
  });

  await t.test('A11: restoreRestaurant ВСЕГДА возвращает в черновик', async () => {
    const r = await svc.createRestaurant({ name: 'Восстановить В Черновик', cities: 'Грозный' });
    await svc.publishRestaurant(r.id);
    await insertAvailableDish(db, r.id);
    await svc.openRestaurant(r.id);
    await svc.archiveRestaurant(r.id);
    const restored = await svc.restoreRestaurant(r.id);
    assert.equal(restored.archived_at, null);
    assert.equal(restored.published_at, null, 'восстановление обнуляет публикацию — не возвращает клиентам автоматически');
    assert.equal(restored.is_open, 0);
  });

  await t.test('A12: publishRestaurant на архивированном -> отклонено ("сначала восстановите")', async () => {
    const r = await svc.createRestaurant({ name: 'Публикация Архива', cities: 'Грозный' });
    await svc.archiveRestaurant(r.id);
    await assert.rejects(() => svc.publishRestaurant(r.id), /восстанов/i);
  });

  await db.close();
  delete process.env.DATABASE_URL;
});

// ===========================================================================
// B. Публичный API — видимость по статусу
// ===========================================================================

test('B: публичный API скрывает черновик/снятый с публикации/архивированный; показывает опубликованный закрытый', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_lifecycle_public_api_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'Публичность Тест', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());

    // Черновик — скрыт.
    let list = await (await fetch(`${base}/api/restaurants`)).json();
    assert.ok(!list.some((r) => r.id === restaurantId));
    let one = await fetch(`${base}/api/restaurants/${restaurantId}`);
    assert.equal(one.status, 404);

    // Публикуем (остаётся закрытым) — виден, с корректным is_open=0.
    let page = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/publish`, { _csrf: page.csrf });
    list = await (await fetch(`${base}/api/restaurants`)).json();
    assert.ok(list.some((r) => r.id === restaurantId), 'опубликованный ЗАКРЫТЫЙ ресторан должен быть виден публично');
    one = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    assert.equal(one.is_open, 0);
    assert.ok(!('published_at' in one), 'published_at — внутреннее поле HQ, не должно быть в публичном DTO');
    assert.ok(!('archived_at' in one), 'archived_at — внутреннее поле HQ, не должно быть в публичном DTO');

    // Открываем — всё ещё виден, теперь is_open=1. Открытие требует
    // доступное блюдо (Stage 5A) — эта проверка не о меню, поэтому дано
    // напрямую через SQL.
    await insertAvailableDish(db, restaurantId);
    page = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/open`, { _csrf: page.csrf });
    one = await (await fetch(`${base}/api/restaurants/${restaurantId}`)).json();
    assert.equal(one.is_open, 1);

    // Снимаем с публикации — скрыт снова.
    page = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/unpublish`, { _csrf: page.csrf });
    list = await (await fetch(`${base}/api/restaurants`)).json();
    assert.ok(!list.some((r) => r.id === restaurantId));
    one = await fetch(`${base}/api/restaurants/${restaurantId}`);
    assert.equal(one.status, 404);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// C. История заказов/оценок сохраняется через archive/restore
// ===========================================================================

test('C: заказы и оценки остаются доступны в HQ после archive -> restore', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_lifecycle_history_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  const orderService = require('../../services/postgresql/orderService');
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'История Тест', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());

    await db.execute('UPDATE restaurants SET is_open = 1, published_at = NOW() WHERE id = $1', [restaurantId]);
    const cat = await db.query('INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [restaurantId, 'Cat']);
    const item = await db.query('INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1,$2,$3,$4,1) RETURNING id', [restaurantId, cat[0].id, 'Блюдо', 500]);

    const { order } = await orderService.createOrderAndResolve({
      restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
      address: 'ул. 1', comment: '', fulfillmentType: 'delivery',
      items: [{ menuItemId: item[0].id, name: 'Блюдо', qty: 1 }],
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    });
    await db.execute("UPDATE payments SET status = 'succeeded' WHERE order_id = $1", [order.id]);
    await db.execute("UPDATE orders SET status = 'delivered' WHERE id = $1", [order.id]);
    await orderService.rateOrder(order.id, 5);

    // Архивируем.
    let page = await getPage(base, cookie, `${restaurantPath}/settings`);
    await postForm(base, cookie, `${restaurantPath}/archive`, { _csrf: page.csrf });

    let ordersPage = await getPage(base, cookie, `${restaurantPath}/orders`);
    assert.match(ordersPage.html, new RegExp(order.public_code), 'заказ виден в HQ и у архивированного ресторана');
    let ratingsPage = await getPage(base, cookie, `${restaurantPath}/ratings`);
    assert.match(ratingsPage.html, /★ 5/, 'оценка сохранена у архивированного ресторана');

    // Восстанавливаем.
    page = await getPage(base, cookie, `${restaurantPath}/settings`);
    await postForm(base, cookie, `${restaurantPath}/restore`, { _csrf: page.csrf });

    ordersPage = await getPage(base, cookie, `${restaurantPath}/orders`);
    assert.match(ordersPage.html, new RegExp(order.public_code), 'заказ по-прежнему виден после восстановления');
    ratingsPage = await getPage(base, cookie, `${restaurantPath}/ratings`);
    assert.match(ratingsPage.html, /★ 5/, 'оценка по-прежнему видна после восстановления');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// D. Audit log содержит publish/unpublish
// ===========================================================================

test('D: audit log фиксирует restaurant_published и restaurant_unpublished', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_lifecycle_audit_test');
  const { instance, base } = await startApp(databaseUrl);
  const db = require('../../db/postgresql');
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'Audit Тест', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');
    const restaurantId = Number(restaurantPath.split('/').pop());

    let page = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/publish`, { _csrf: page.csrf });
    page = await getPage(base, cookie, restaurantPath);
    await postForm(base, cookie, `${restaurantPath}/unpublish`, { _csrf: page.csrf });

    const rows = await db.query('SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id', [restaurantId]);
    const actions = rows.map((r) => r.action);
    assert.ok(actions.includes('restaurant_published'));
    assert.ok(actions.includes('restaurant_unpublished'));
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// E. CSRF / auth / 404 на новых lifecycle-маршрутах
// ===========================================================================

test('E: publish/unpublish/open/close требуют auth+CSRF; 404 для несуществующего ресторана', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_lifecycle_csrf_test');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const createPage = await getPage(base, cookie, '/hq/restaurants/new');
    const createRes = await postForm(base, cookie, '/hq/restaurants', { _csrf: createPage.csrf, name: 'CSRF Lifecycle', cities: 'Грозный' });
    const restaurantPath = createRes.headers.get('location');

    for (const action of ['publish', 'unpublish', 'open', 'close']) {
      const noAuthRes = await fetch(`${base}${restaurantPath}/${action}`, { method: 'POST', redirect: 'manual' });
      assert.equal(noAuthRes.status, 302, `${action} без сессии должен редиректить на логин`);

      const noCsrfRes = await postForm(base, cookie, `${restaurantPath}/${action}`, {});
      assert.equal(noCsrfRes.status, 403, `${action} без CSRF-токена должен быть отклонён`);

      const notFoundRes = await postForm(base, cookie, `/hq/restaurants/999999/${action}`, { _csrf: createPage.csrf });
      assert.equal(notFoundRes.status, 404, `${action} для несуществующего ресторана — честный 404`);
    }
  } finally {
    await stopApp(instance);
  }
});
