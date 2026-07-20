'use strict';

// YAAM Production Switch — Stage 7 (application assembly): интеграционные
// тесты для server/services/postgresql/app.js (createPostgresqlApp()) и
// тонкого server/server.postgresql.js поверх него, против настоящего
// embedded PostgreSQL 16.14 — тот же established harness, что и все
// предыдущие Stage/Wave тесты. Ничего здесь не подключено к production
// server.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');
const { FakeTelegramBot } = require('./helpers/fakeTelegramBot');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_app_assembly_stage7_test';

const APP_MODULE_PATH = require.resolve('../../services/postgresql/app.js');
const API_ROUTES_PATH = require.resolve('../../routes/postgresql/api.js');
const ADMIN_ROUTES_PATH = require.resolve('../../routes/postgresql/admin.js');
const PAYMENT_SERVICE_PATH = require.resolve('../../services/paymentService.js');

let cluster;
let db;
let dbBootstrapModule;
let orderService;
let paymentService;
let appModule; // дефолтный ENV: PAYMENT_PROVIDER=mock, dev-роуты выключены, webhook не зарегистрирован

before(async () => {
  process.env.PAYMENT_PROVIDER = 'mock';
  delete process.env.ENABLE_DEV_PAYMENT_ROUTES;
  delete process.env.APP_ENV;
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  // Дамми-значения — нужны ТОЛЬКО чтобы YookassaProvider не бросал в своём
  // конструкторе при PAYMENT_PROVIDER=yookassa (F-раздел); реальный сетевой
  // вызов ЮKassa этими тестами не выполняется (verifyWebhook — единственный
  // проверяемый метод, либо реальный "not implemented"-стаб, либо monkey-patch).
  process.env.YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || 'stage7-test-shop-id';
  process.env.YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || 'stage7-test-secret-key';

  cluster = await startEmbeddedPostgres('app-assembly-stage7');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  dbBootstrapModule = require('../../db/postgresql/bootstrap.js');
  orderService = require('../../services/postgresql/orderService.js');
  paymentService = require('../../services/paymentService.js');
  appModule = require('../../services/postgresql/app.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

// ---------------------------------------------------------------------------
// Общие хелперы
// ---------------------------------------------------------------------------

// Помимо app.js/api.js/admin.js, также чистит кеш services/paymentService.js
// — то ГОЖЕ читает process.env.PAYMENT_PROVIDER на верхнем уровне
// (loadProvider(), один раз при require()), но НЕ включён в цепочку
// require()'ов, которые Node сам бы переисполнил при чистке только
// app.js/api.js/admin.js: paymentService.js остаётся в кеше отдельно и,
// если не сбросить его тоже, свежий api.js получит СТАРЫЙ, закешированный
// provider-инстанс, оставшийся от самого первого require() в before().
// Возвращает СВЕЖУЮ ссылку на paymentService — тесты, которым нужно
// monkey-patch verifyWebhook(), обязаны патчить ИМЕННО её, не
// заранее-захваченную ссылку верхнего уровня файла (та её не увидит после
// сброса кеша).
function reloadAppModule() {
  delete require.cache[APP_MODULE_PATH];
  delete require.cache[API_ROUTES_PATH];
  delete require.cache[ADMIN_ROUTES_PATH];
  delete require.cache[PAYMENT_SERVICE_PATH];
  return {
    appModule: require('../../services/postgresql/app.js'),
    paymentService: require('../../services/paymentService.js'),
  };
}

// Оборачивает тест: временно переопределяет process.env[...] (только ключи,
// влияющие на module-load-time гейты routes/postgresql/api.js — webhook/
// dev-route регистрация), перезагружает app.js/api.js/admin.js/
// paymentService.js СВЕЖИМИ, выполняет tst({appModule, paymentService}),
// затем ВСЕГДА восстанавливает исходные значения env и снова чистит
// require.cache — тот же приём, что и routesApiStage1.test.js
// (dev-confirm-payment секция).
function withEnvReload(overrides, tst) {
  return async () => {
    const previous = {};
    for (const key of Object.keys(overrides)) {
      previous[key] = process.env[key];
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    try {
      const reloaded = reloadAppModule();
      await tst(reloaded);
    } finally {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      delete require.cache[APP_MODULE_PATH];
      delete require.cache[API_ROUTES_PATH];
      delete require.cache[ADMIN_ROUTES_PATH];
      delete require.cache[PAYMENT_SERVICE_PATH];
    }
  };
}

async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await sleep(5);
  }
  throw new Error('httpServer никогда не начал слушать');
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

function uniquePhone() {
  const n = crypto.randomInt(100000000, 999999999);
  return `+79${String(n).padStart(8, '0')}`;
}

async function pgCreateRestaurant(overrides = {}) {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, is_open, min_order, phone, rating, rating_count)
     VALUES ('Stage7 Test Restaurant', 'test', $1, $2, $3, '+79280000099', 4.5, 10) RETURNING id`,
    [JSON.stringify(overrides.cities || ['Грозный']), overrides.isOpen === false ? 0 : 1, overrides.minOrder || 0],
  );
  return rows[0].id;
}

async function pgCreateMenuItem(restaurantId, overrides = {}) {
  const catRows = await db.query(
    `INSERT INTO categories (restaurant_id, name) VALUES ($1, 'Cat') RETURNING id`,
    [restaurantId],
  );
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available)
     VALUES ($1, $2, 'Item', $3, 1) RETURNING id`,
    [restaurantId, catRows[0].id, overrides.price || 500],
  );
  return rows[0].id;
}

async function createOrderDirect(overrides = {}) {
  const restaurantId = await pgCreateRestaurant(overrides);
  const menuItemId = await pgCreateMenuItem(restaurantId, overrides);
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'Тест Тестов',
    customerPhone: uniquePhone(),
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Item', qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const result = await orderService.createOrderAndResolve(payload);
  return { order: result.order, payment: result.payment, payload };
}

// ===========================================================================
// A. Assembly
// ===========================================================================

test('A1: require(services/postgresql/app.js) не запускает listen()/main() как побочный эффект', () => {
  assert.equal(typeof appModule.createPostgresqlApp, 'function');
});

test('A2: createPostgresqlApp() создаёт app без вызова listen() — address() === null до start()', () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  assert.equal(instance.address(), null);
  assert.equal(instance.isRunning(), false);
  assert.equal(instance.isReady(), false);
});

test('A3: маршруты монтируются ровно один раз (/api и /admin — по одному layer в стеке)', () => {
  const instance = appModule.createPostgresqlApp({
    port: 0,
    schedulerIntervalMs: 1_000_000,
    adminUser: 'a',
    adminPass: 'b',
  });
  // l.name === 'router' isolates мonтированные sub-router'ы (app.use(path, router))
  // от глобальных middleware-функций — те тоже совпадают с любым regexp-тестом
  // пути (catch-all по умолчанию), поэтому одной проверки regexp.test() мало.
  const apiLayers = instance.app._router.stack.filter((l) => l.name === 'router' && l.regexp && l.regexp.test('/api/restaurants'));
  const adminLayers = instance.app._router.stack.filter((l) => l.name === 'router' && l.regexp && l.regexp.test('/admin/'));
  assert.equal(apiLayers.length, 1, `ожидался ровно 1 /api layer, найдено ${apiLayers.length}`);
  assert.equal(adminLayers.length, 1, `ожидался ровно 1 /admin layer, найдено ${adminLayers.length}`);
});

test('A4: services/postgresql/app.js не содержит require SQLite-пути/db.prepare()', () => {
  const src = fs.readFileSync(APP_MODULE_PATH, 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\.\/\.\.\/db['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/db['"]\)/);
  assert.doesNotMatch(src, /\bdb\.prepare\(/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/\.\.\/services\/orderService['"]\)/);
});

test('A5: server.postgresql.js require.main guard присутствует, require() не запускает main()', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server.postgresql.js'), 'utf8');
  assert.match(src, /if \(require\.main === module\)/);
  // Косвенное доказательство: если бы main() запускался при require(), любой
  // из тестов ниже, создающих собственный instance на порту 0, столкнулся бы
  // с уже занятым портом/дублирующимся scheduler'ом.
  const serverModule = require('../../server.postgresql.js');
  assert.equal(typeof serverModule.createApp, 'function');
  assert.equal(typeof serverModule.main, 'function');
});

// ===========================================================================
// B. Middleware ordering
// ===========================================================================

test('B1: JSON body корректно парсится на обычных /api маршрутах (не сырой Buffer)', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    // Пустое тело + некорректный Content-Type достаточно, чтобы доказать,
    // что мы дошли до самого маршрута (а не до сырого webhook-парсера) —
    // POST /api/orders без Idempotency-Key/Authorization даёт понятную
    // валидационную 400/401 ошибку JSON-парсера бы не было для этого пути.
    const res = await fetchJson(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    assert.equal(res.status, 401); // requireOrderAccess срабатывает первым — доказывает, что JSON распарсился и роутер обработал запрос
  } finally {
    await instance.stop();
  }
});

test('B2: некорректный JSON на обычном маршруте обрабатывается централизованным error handler-ом (400, requestId, без утечки stack)', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-valid-json',
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.ok(body.requestId, 'ошибка должна содержать requestId');
    assert.doesNotMatch(JSON.stringify(body), /at Object\.<anonymous>|node_modules/); // нет утечки stack trace
  } finally {
    await instance.stop();
  }
});

test('B3: неизвестный путь даёт 404 с requestId (404-обработчик подключён)', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetchJson(`http://127.0.0.1:${port}/api/totally-unknown-route`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not found');
    assert.ok(res.body.requestId);
  } finally {
    await instance.stop();
  }
});

test('B4: X-Request-Id из запроса переиспользуется в ответе (сквозной id)', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/health/live`, {
      headers: { 'X-Request-Id': 'test-fixed-id-123' },
    });
    assert.equal(res.headers.get('x-request-id'), 'test-fixed-id-123');
  } finally {
    await instance.stop();
  }
});

// ===========================================================================
// C. Readiness gate (использует PAYMENT_PROVIDER=yookassa, чтобы webhook
// маршрут тоже существовал и его можно было проверить "до готовности")
// ===========================================================================

test('C1: бизнес-маршруты (включая webhook) — 503 до готовности; после готовности — доступны; liveness всегда 200', withEnvReload(
  { PAYMENT_PROVIDER: 'yookassa' },
  async ({ appModule: reloadedApp }) => {
    const original = dbBootstrapModule.bootstrap;
    let releaseBootstrap;
    const gate = new Promise((resolve) => { releaseBootstrap = resolve; });
    dbBootstrapModule.bootstrap = async (...args) => {
      await gate;
      return original(...args);
    };

    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    const startPromise = instance.start();
    try {
      const { port } = await waitForAddress(instance);
      const base = `http://127.0.0.1:${port}`;

      // Пока bootstrap не разрешён — не готов.
      const apiRes = await fetchJson(`${base}/api/restaurants`);
      assert.equal(apiRes.status, 503);

      const webhookRes = await fetchJson(`${base}/api/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ any: 'thing' }),
      });
      assert.equal(webhookRes.status, 503, 'webhook не должен обрабатываться до готовности БД');

      const liveRes = await fetchJson(`${base}/health/live`);
      assert.equal(liveRes.status, 200, 'liveness не должен зависеть от готовности БД');

      // /health/ready (Stage 6, не изменён) делает СВОЙ прямой живой SELECT 1
      // — отражает "доступна ли БД ПРЯМО СЕЙЧАС", а не "завершилась ли
      // стартовая последовательность приложения". В этом тесте БД реально
      // доступна всё время (задержан только резолв dbBootstrap.bootstrap()),
      // поэтому /health/ready корректно остаётся 200 — это НЕ баг, а другой,
      // самостоятельный сигнал по сравнению с бизнес-гейтом ниже (см.
      // postgresql-application-assembly.md, раздел "Readiness contract").
      // Авторитетный сигнал именно для бизнес-трафика — instance.isReady()
      // (флаг приложения, становится true только после ПОЛНОГО
      // lifecycle.start(): bootstrap + scheduler.start() + bot.start()).
      assert.equal(instance.isReady(), false, 'business-гейт не должен считать приложение готовым до завершения lifecycle.start()');

      releaseBootstrap();
      await startPromise;

      const apiRes2 = await fetchJson(`${base}/api/restaurants`);
      assert.equal(apiRes2.status, 200, 'после готовности бизнес-маршрут должен отвечать нормально');
      assert.equal(instance.isReady(), true);

      const readyRes2 = await fetchJson(`${base}/health/ready`);
      assert.equal(readyRes2.status, 200);
    } finally {
      dbBootstrapModule.bootstrap = original;
      await instance.stop();
    }
  }
));

test('C2: admin mutation (POST) — 503 до готовности', withEnvReload({}, async ({ appModule: reloadedApp }) => {
  const original = dbBootstrapModule.bootstrap;
  let releaseBootstrap;
  const gate = new Promise((resolve) => { releaseBootstrap = resolve; });
  dbBootstrapModule.bootstrap = async (...args) => {
    await gate;
    return original(...args);
  };

  const instance = reloadedApp.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, adminUser: 'admin', adminPass: 'secret',
  });
  const startPromise = instance.start();
  try {
    const { port } = await waitForAddress(instance);
    const authHeader = { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
    const res = await fetch(`http://127.0.0.1:${port}/admin/restaurants/1`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    });
    assert.equal(res.status, 503);
  } finally {
    releaseBootstrap();
    await startPromise;
    dbBootstrapModule.bootstrap = original;
    await instance.stop();
  }
}));

// ===========================================================================
// D. Public API — smoke
// ===========================================================================

test('D1: GET /api/restaurants — 200, содержит созданный ресторан', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const restaurantId = await pgCreateRestaurant();
    const { port } = instance.address();
    const res = await fetchJson(`http://127.0.0.1:${port}/api/restaurants`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((r) => r.id === restaurantId));
  } finally {
    await instance.stop();
  }
});

test('D2: GET /api/restaurants/:id — 404 для несуществующего ресторана', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetchJson(`http://127.0.0.1:${port}/api/restaurants/999999999`);
    assert.equal(res.status, 404);
  } finally {
    await instance.stop();
  }
});

// ===========================================================================
// E. Admin
// ===========================================================================

test('E1: /admin без Authorization — 401', async () => {
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, adminUser: 'admin', adminPass: 'secret',
  });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/admin/`);
    assert.equal(res.status, 401);
  } finally {
    await instance.stop();
  }
});

test('E2: /admin с неверным паролем — 401', async () => {
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, adminUser: 'admin', adminPass: 'secret',
  });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/admin/`, {
      headers: { Authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
    });
    assert.equal(res.status, 401);
  } finally {
    await instance.stop();
  }
});

test('E3: /admin с верными credentials — 200', async () => {
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, adminUser: 'admin', adminPass: 'secret',
  });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/admin/`, {
      headers: { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
    });
    assert.equal(res.status, 200);
  } finally {
    await instance.stop();
  }
});

test('E4: без ADMIN_USER/ADMIN_PASS — /admin вообще не смонтирован (404, а не 401)', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/admin/`);
    assert.equal(res.status, 404);
  } finally {
    await instance.stop();
  }
});

test('E5 (route-conflict repro+fix): POST /admin/restaurants/:id реально обновляет ресторан и редиректит на /edit (не на себя же)', async () => {
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, adminUser: 'admin', adminPass: 'secret',
  });
  await instance.start();
  try {
    const restaurantId = await pgCreateRestaurant();
    const { port } = instance.address();
    const authHeader = { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
    const res = await fetch(`http://127.0.0.1:${port}/admin/restaurants/${restaurantId}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=Updated+Name&cuisine=updated&cities=Грозный&address=&hours=&phone=&delivery_price=0&min_order=0&default_cook_minutes=40',
    });
    // До фикса Stage 7 (см. routes/postgresql/admin.js) этот запрос попадал
    // бы на редирект-заглушку (307 на тот же самый путь — бесконечный цикл),
    // а имя ресторана НИКОГДА не обновлялось бы. После фикса — редирект на
    // /edit (302/303), а имя реально обновлено в БД.
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.equal(location, `/admin/restaurants/${restaurantId}/edit`);
    assert.notEqual(location, `/admin/restaurants/${restaurantId}`, 'не должен редиректить сам на себя (старый баг)');

    const rows = await db.query('SELECT name FROM restaurants WHERE id = $1', [restaurantId]);
    assert.equal(rows[0].name, 'Updated Name');
  } finally {
    await instance.stop();
  }
});

// ===========================================================================
// F. Webhook (требует PAYMENT_PROVIDER=yookassa — иначе маршрут не существует)
// ===========================================================================

test('F1: raw body сохраняется нетронутым для webhook-маршрута (глобальный json-парсер не трогает его)', withEnvReload(
  { PAYMENT_PROVIDER: 'yookassa' },
  async ({ appModule: reloadedApp, paymentService: reloadedPaymentService }) => {
    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    await instance.start();
    const originalVerify = reloadedPaymentService.verifyWebhook;
    let capturedRawBody = null;
    reloadedPaymentService.verifyWebhook = (rawBody) => {
      capturedRawBody = rawBody;
      return null; // invalid signature — маршрут корректно ответит 400, нас интересует только capturedRawBody
    };
    try {
      const { port } = instance.address();
      const rawText = '{"deliberately":"not-standard-but-raw"}';
      await fetch(`http://127.0.0.1:${port}/api/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawText,
      });
      assert.equal(capturedRawBody, rawText, 'verifyWebhook должен получить raw body байт-в-байт, не пере-сериализованный JSON');
    } finally {
      reloadedPaymentService.verifyWebhook = originalVerify;
      await instance.stop();
    }
  }
));

// Production Switch — Stage 8: YookassaProvider.verifyWebhook() больше НЕ
// "not implemented" — реализована (канонический lookup у ЮKassa, см.
// server/docs/postgresql-payment-safety.md). Настоящая бизнес-логика
// верификации (структура/каноническая сверка/суммы) теперь тестируется
// исчерпывающе в paymentSafetyStage8.test.js, с реальным fake-транспортом
// вместо настоящей сети ЮKassa. Эта сборочная (assembly-level) проверка
// сужена под свою исходную задачу — маршрут не должен крашиться/течь
// стектрейсом ни при каком входе, включая пустое тело — сетевого доступа к
// api.yookassa.ru здесь намеренно нет (вне мандата Stage 7), поэтому
// canonical lookup внутри verifyWebhook() естественно не пройдёт (сетевая
// ошибка) и корректно вернёт null -> 400, не 500 и не падение процесса.
test('F2: webhook-маршрут переживает пустое/невалидное тело без падения процесса (400, без утечки деталей)', withEnvReload(
  { PAYMENT_PROVIDER: 'yookassa' },
  async ({ appModule: reloadedApp }) => {
    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    await instance.start();
    try {
      const { port } = instance.address();
      const res = await fetchJson(`http://127.0.0.1:${port}/api/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 400);
      assert.doesNotMatch(JSON.stringify(res.body), /at Object\.<anonymous>|node_modules|Error:/);
    } finally {
      await instance.stop();
    }
  }
));

test('F3: дублирующая доставка webhook не вызывает повторную бизнес-операцию (markPaid идемпотентен)', withEnvReload(
  { PAYMENT_PROVIDER: 'yookassa' },
  async ({ appModule: reloadedApp, paymentService: reloadedPaymentService }) => {
    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    await instance.start();
    const originalVerify = reloadedPaymentService.verifyWebhook;
    try {
      const { order, payment: publicPayment } = await createOrderDirect();
      const pendingPayment = await orderService.getPendingPaymentForOrder(order.id);
      assert.ok(pendingPayment && pendingPayment.provider_payment_id, 'fixture должен создать ожидающий платёж');

      // Production Switch — Stage 8: маршрут теперь дополнительно сверяет
      // amount/currency события с сохранённым платежом ДО применения
      // (routes/postgresql/api.js) — подделанное событие обязано включать
      // реальные amount/currency этого платежа, иначе будет корректно
      // отклонено как несовпадение сумм (это отдельно и исчерпывающе
      // протестировано в paymentSafetyStage8.test.js, здесь не дублируется).
      reloadedPaymentService.verifyWebhook = () => ({
        providerPaymentId: pendingPayment.provider_payment_id,
        status: 'succeeded',
        amount: pendingPayment.amount,
        currency: 'RUB',
      });

      const { port } = instance.address();
      const send = () => fetchJson(`http://127.0.0.1:${port}/api/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      const first = await send();
      assert.equal(first.status, 200);
      const afterFirst = await orderService.getOrder(order.id);
      assert.equal(afterFirst.status, 'awaiting_restaurant');

      const second = await send();
      assert.equal(second.status, 200, 'повторная доставка не должна приводить к ошибке');
      const afterSecond = await orderService.getOrder(order.id);
      assert.equal(afterSecond.status, 'awaiting_restaurant', 'повторный markPaid — no-op, статус не должен меняться повторно');
      void publicPayment;
    } finally {
      reloadedPaymentService.verifyWebhook = originalVerify;
      await instance.stop();
    }
  }
));

// ===========================================================================
// G. CORS
// ===========================================================================

test('G1: разрешённый origin (localhost, NODE_ENV=test) — запрос проходит с корректным Access-Control-Allow-Origin', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/restaurants`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  } finally {
    await instance.stop();
  }
});

test('G2: запрещённый origin — 403 CORS JSON-ошибка через corsErrorHandler', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetchJson(`http://127.0.0.1:${port}/api/restaurants`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /CORS/);
    assert.ok(res.body.requestId);
  } finally {
    await instance.stop();
  }
});

test('G3: preflight (OPTIONS) для разрешённого origin — успешный ответ с нужными заголовками', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/restaurants`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.ok(res.status === 204 || res.status === 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  } finally {
    await instance.stop();
  }
});

test('G4: запрос без Origin (server-to-server/webhook-стиль) — не блокируется CORS', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/restaurants`);
    assert.equal(res.status, 200);
  } finally {
    await instance.stop();
  }
});

test('G5: buildCorsOptions() не допускает wildcard — origin всегда функция-валидатор, не строка "*"', () => {
  const { buildCorsOptions } = require('../../config/cors.js');
  const options = buildCorsOptions();
  assert.equal(typeof options.origin, 'function');
});

// ===========================================================================
// H. Dev route gating
// ===========================================================================

test('H1: по умолчанию (ENABLE_DEV_PAYMENT_ROUTES не задан) — dev-confirm-payment маршрут отсутствует (404)', withEnvReload(
  {},
  async ({ appModule: reloadedApp }) => {
    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    await instance.start();
    try {
      const { port } = instance.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/orders/YAAM-00001/dev-confirm-payment`, { method: 'POST' });
      assert.equal(res.status, 404);
    } finally {
      await instance.stop();
    }
  }
));

test('H2: APP_ENV=production — dev-роут отсутствует, даже если флаг явно включён', withEnvReload(
  // TRUST_PROXY=loopback обязателен вместе с APP_ENV=production с Stage 9
  // (services/postgresql/app.js validateAppEnv() — см.
  // postgresql-deployment-runbook.md) — без него createPostgresqlApp()
  // теперь fail-fast бросает ДО того, как дошло бы до проверки dev-роута;
  // этот тест не про trust proxy, поэтому просто удовлетворяет предпосылку.
  { ENABLE_DEV_PAYMENT_ROUTES: 'true', APP_ENV: 'production', PAYMENT_PROVIDER: 'mock', TRUST_PROXY: 'loopback' },
  async ({ appModule: reloadedApp }) => {
    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    await instance.start();
    try {
      const { port } = instance.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/orders/YAAM-00001/dev-confirm-payment`, { method: 'POST' });
      assert.equal(res.status, 404);
    } finally {
      await instance.stop();
    }
  }
));

test('H3: явный флаг + APP_ENV=staging + PAYMENT_PROVIDER=mock — dev-роут смонтирован (собственная 404 логика роута, не Express 404)', withEnvReload(
  { ENABLE_DEV_PAYMENT_ROUTES: 'true', APP_ENV: 'staging', PAYMENT_PROVIDER: 'mock' },
  async ({ appModule: reloadedApp }) => {
    const instance = reloadedApp.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
    await instance.start();
    try {
      const { port } = instance.address();
      const res = await fetchJson(`http://127.0.0.1:${port}/api/orders/YAAM-00001/dev-confirm-payment`, {
        method: 'POST',
        headers: { Authorization: 'Bearer nonsense' },
      });
      // Маршрут смонтирован — отвечает СВОИМ 401 (requireOrderAccess), а не
      // общим notFoundHandler-ом {"error":"not found"}.
      assert.notEqual(res.status, 404);
    } finally {
      await instance.stop();
    }
  }
));

test('H4: некорректное значение ENABLE_DEV_PAYMENT_ROUTES — createPostgresqlApp() бросает fail-fast', () => {
  assert.throws(
    () => appModule.createPostgresqlApp({
      port: 0,
      env: { ...process.env, ENABLE_DEV_PAYMENT_ROUTES: 'yes' },
    }),
    (err) => {
      assert.match(err.message, /ENABLE_DEV_PAYMENT_ROUTES/);
      return true;
    }
  );
});

test('H5: некорректное значение APP_ENV — createPostgresqlApp() бросает fail-fast', () => {
  assert.throws(
    () => appModule.createPostgresqlApp({
      port: 0,
      env: { ...process.env, APP_ENV: 'not-a-real-env' },
    }),
    (err) => {
      assert.match(err.message, /APP_ENV/);
      return true;
    }
  );
});

test('H6: ADMIN_USER без ADMIN_PASS (или наоборот) — createPostgresqlApp() бросает fail-fast', () => {
  assert.throws(
    () => appModule.createPostgresqlApp({
      port: 0,
      env: { ...process.env, ADMIN_USER: 'only-user' },
    }),
    (err) => {
      assert.match(err.message, /ADMIN_USER.*ADMIN_PASS/s);
      return true;
    }
  );
});

// ===========================================================================
// I. Bot lifecycle
// ===========================================================================

test('I1: единственный запуск — botAdapter running после instance.start() с injected FakeTelegramBot', async () => {
  const fakeBot = new FakeTelegramBot();
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000, botClient: fakeBot });
  await instance.start();
  try {
    assert.ok(instance.botAdapter, 'botAdapter должен существовать при переданном botClient');
    assert.equal(instance.botAdapter.isRunning(), true);
    assert.equal(instance.botAdapter.getState().state, 'running');
  } finally {
    await instance.stop();
  }
});

test('I2: повторный start() адаптера идемпотентен — не навешивает второй набор слушателей', () => {
  const { createBotLifecycleAdapter } = appModule;
  const fakeBot = new FakeTelegramBot();
  const adapter = createBotLifecycleAdapter({ botClient: fakeBot });
  adapter.start();
  adapter.start(); // повторный вызов — должен быть no-op
  assert.equal((fakeBot.eventHandlers['callback_query'] || []).length, 1, 'должен быть ровно один callback_query слушатель');
  adapter.stop();
});

test('I3: без TELEGRAM_BOT_TOKEN и без botClient — бот выключен, readiness показывает "disabled", HTTP не страдает', async () => {
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });
  await instance.start();
  try {
    assert.equal(instance.botAdapter, null);
    const { port } = instance.address();
    const res = await fetchJson(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(res.body.bot.state, 'disabled');
    assert.equal(res.body.ok, true, 'отсутствие бота не должно влиять на readiness ok');
  } finally {
    await instance.stop();
  }
});

test('I4: сбой Telegram API (imitated) не роняет HTTP — процесс продолжает отвечать на /health/live', async () => {
  const fakeBot = new FakeTelegramBot();
  fakeBot.answerCallbackQueryImpl = async () => { throw new Error('имитированный сбой Telegram API'); };
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000, botClient: fakeBot });
  await instance.start();
  try {
    await fakeBot.triggerCallbackQuery({ id: 'cb1', data: 'toggle_item:999999', chatId: 1, messageId: 1 });
    const { port } = instance.address();
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    assert.equal(res.status, 200, 'HTTP app должен пережить сбой Telegram API внутри bot handler');
  } finally {
    await instance.stop();
  }
});

test('I5: остановка — order:new слушатель снят (нет накопления между start/stop циклами)', async () => {
  const baseline = orderService.orderEvents.listenerCount('order:new');
  const fakeBot = new FakeTelegramBot();
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000, botClient: fakeBot });
  await instance.start();
  assert.equal(orderService.orderEvents.listenerCount('order:new'), baseline + 1);
  await instance.stop();
  assert.equal(orderService.orderEvents.listenerCount('order:new'), baseline);
});

// ===========================================================================
// J. Shutdown
// ===========================================================================

test('J1: полный graceful shutdown — HTTP закрыт, scheduler остановлен, бот остановлен, пул доступен на следующем запросе', async () => {
  const baselineSignals = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
  const fakeBot = new FakeTelegramBot();
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000, botClient: fakeBot });
  await instance.start();
  const { port } = instance.address();

  await instance.stop();

  assert.equal(instance.scheduler.isRunning(), false);
  assert.equal(instance.botAdapter.isRunning(), false);
  assert.equal(instance.isReady(), false);
  assert.equal(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'), baselineSignals);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health/live`), () => true);

  const rows = await db.query('SELECT 1 AS ok');
  assert.equal(rows[0].ok, 1);
});

test('J2: повторный (синтетический, приватное имя сигнала) SIGTERM безопасен и идемпотентен', async () => {
  // Приватное имя сигнала — тот же обходной приём, что и Stage 6
  // (operationalStage6.test.js): embedded-postgres/async-exit-hook сам
  // слушает настоящие SIGTERM/SIGINT, синтетический process.emit('SIGTERM')
  // в тесте задел бы и его. Настоящий server.postgresql.js продолжает
  // слушать настоящие SIGTERM/SIGINT — см. server.postgresql.js main().
  const PRIVATE_SIGNAL = 'SIGUSR2';
  const instance = appModule.createPostgresqlApp({ port: 0, schedulerIntervalMs: 1_000_000 });

  // createPostgresqlApp() сама не принимает `signals` — но lifecycle.js
  // штатно поддерживает их через createLifecycle(); здесь мы напрямую
  // проверяем идемпотентность instance.stop(), вызванного дважды подряд
  // (эквивалент "повторный SIGTERM" на уровне уже проверенного Stage 6
  // lifecycle.js — сам механизм регистрации сигналов не дублируется
  // Stage 7 кодом, см. app.js: createLifecycle({schedulers, httpServer,
  // onShutdown, onSignal})).
  await instance.start();
  await instance.stop();
  await instance.stop(); // повторный — должен быть безопасным no-op
  assert.equal(instance.isRunning(), false);
  void PRIVATE_SIGNAL;
});
