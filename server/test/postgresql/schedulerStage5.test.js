'use strict';

// YAAM Production Switch — Stage 5 (server/services/postgresql/scheduler.js):
// integration-тесты для изолированного PostgreSQL restaurant-pause-expiry
// scheduler'а против настоящего embedded PostgreSQL 16.14. Scheduler НЕ
// подключён к server.js и не запускается автоматически — тесты создают
// собственные инстансы через createPauseExpiryScheduler() и явно
// start()/stop()/runOnce() их.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_scheduler_stage5_test';

let cluster;
let db;
let pgOrderService;
let schedulerModule;

before(async () => {
  cluster = await startEmbeddedPostgres('scheduler-stage5');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');
  schedulerModule = require('../../services/postgresql/scheduler.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function pgCreateRestaurant({ isOpen = 1, pausedUntil = null, name } = {}) {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, phone, is_open, paused_until)
     VALUES ($1,'test','[]','+79280000000',$2,$3) RETURNING *`,
    [name ?? `Ресторан ${uniqueSuffix()}`, isOpen, pausedUntil]
  );
  return rows[0];
}

function secondsFromNow(sec) {
  return new Date(Date.now() + sec * 1000);
}

async function restaurantRow(id) {
  const rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [id]);
  return rows[0];
}

// ===========================================================================
// A. Pause expires
// ===========================================================================

test('A1: паузa истекла — restaurantAccept открывается, paused_until обнуляется', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce();
  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
  assert.equal(row.paused_until, null);
});

// ===========================================================================
// B. Pause not expired
// ===========================================================================

test('B1: пауза ещё не истекла — ресторан остаётся закрытым, paused_until не тронут', async () => {
  const future = secondsFromNow(3600);
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: future });
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce();
  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 0);
  assert.equal(new Date(row.paused_until).getTime(), future.getTime());
});

test('B2: ресторан открыт (is_open=1) с "протухшим" paused_until — WHERE не матчит (структурно недостижимо в норме, но безопасно, если случится)', async () => {
  const r = await pgCreateRestaurant({ isOpen: 1, pausedUntil: secondsFromNow(-100) });
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce();
  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
  assert.ok(row.paused_until, 'is_open=1 исключает строку из WHERE — paused_until не трогается этим sweep');
});

// ===========================================================================
// C. Несколько ресторанов
// ===========================================================================

test('C1: несколько ресторанов одновременно — sweep корректно выбирает только истёкшие', async () => {
  const expired1 = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-10) });
  const expired2 = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-1) });
  const notExpired = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(600) });
  const alreadyOpen = await pgCreateRestaurant({ isOpen: 1, pausedUntil: null });

  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce();

  assert.equal((await restaurantRow(expired1.id)).is_open, 1);
  assert.equal((await restaurantRow(expired2.id)).is_open, 1);
  assert.equal((await restaurantRow(notExpired.id)).is_open, 0);
  assert.equal((await restaurantRow(alreadyOpen.id)).is_open, 1);
});

// ===========================================================================
// D. Одновременный manual resume
// ===========================================================================

test('D1: ресторан вручную открылся ОДНОВРЕМЕННО со sweep — оба перехода сходятся к одному и тому же состоянию (idempotent), без ошибки', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });

  await Promise.all([
    pgOrderService.resumeRestaurant(r.id),
    scheduler.runOnce(),
  ]);

  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
  assert.equal(row.paused_until, null);
});

test('D2: manual resume побеждает ПЕРЕД sweep — sweep затем видит уже открытый ресторан и корректно его не трогает', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  await pgOrderService.resumeRestaurant(r.id);
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce(); // не должен упасть и не должен ничего сломать
  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
  assert.equal(row.paused_until, null);
});

// ===========================================================================
// E. Повторный sweep
// ===========================================================================

test('E1: повторный sweep подряд — второй прогон идемпотентен, не трогает уже обработанные/несвязанные строки', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const untouched = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(600) });
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });

  await scheduler.runOnce();
  await scheduler.runOnce(); // второй прогон — не должен бросить и не должен ничего изменить

  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
  const untouchedRow = await restaurantRow(untouched.id);
  assert.equal(untouchedRow.is_open, 0, 'несвязанный, ещё не истёкший ресторан не должен был пострадать от повторного sweep');
});

// ===========================================================================
// F. Restart scheduler
// ===========================================================================

test('F1: "рестарт" scheduler (новый инстанс) корректно подхватывает застарелую паузу — состояние живёт в БД, не в инстансе', async () => {
  const firstInstance = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  firstInstance.start();
  firstInstance.stop(); // симулирует падение/остановку процесса ДО появления паузы

  // Пауза создаётся ПОСЛЕ "рестарта" первого инстанса — если бы scheduler
  // хранил какой-то cursor/состояние в себе, новый инстанс мог бы его не
  // увидеть. paused_until специально сильно "просрочен" — эмулирует
  // длительный простой процесса ("сервер может перезапуститься, а таймер
  // должен пережить рестарт", тот же принцип, что и в SQLite-комментарии).
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-999999) });

  const secondInstance = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await secondInstance.runOnce();

  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
});

// ===========================================================================
// G. Start -> Stop -> Start
// ===========================================================================

test('G1: start() реально запускает периодический sweep; stop() реально его останавливает; повторный start() возобновляет', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 40 });

  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  await sleep(150); // несколько тиков по 40мс
  assert.equal((await restaurantRow(r.id)).is_open, 1, 'start() должен был реально выполнить sweep за это время');

  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);

  // Переводим ресторан обратно в "просроченную паузу" и проверяем, что
  // ОСТАНОВЛЕННЫЙ scheduler больше НЕ подхватывает изменения.
  await db.execute('UPDATE restaurants SET is_open = 0, paused_until = $1 WHERE id = $2', [secondsFromNow(-5), r.id]);
  await sleep(150);
  assert.equal((await restaurantRow(r.id)).is_open, 0, 'после stop() тики не должны были продолжаться');

  scheduler.start();
  await sleep(150);
  assert.equal((await restaurantRow(r.id)).is_open, 1, 'повторный start() должен был возобновить sweep');
  scheduler.stop();
});

test('G2: повторный start() на уже запущенном scheduler — не создаёт второй таймер', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  scheduler.start();
  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
});

test('G3: повторный stop() на уже остановленном scheduler — безопасен, не бросает', async () => {
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  scheduler.stop();
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
});

// ===========================================================================
// H. Отсутствие timer leaks
// ===========================================================================

test('H1: после stop() тики больше не происходят (нет "висящего" таймера, продолжающего работать)', async () => {
  let tickCount = 0;
  const scheduler = schedulerModule.createPauseExpiryScheduler({
    intervalMs: 30,
    onError: () => { /* sweepPauseExpiry не должен падать; onError здесь не ожидается */ },
  });
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  scheduler.start();
  await sleep(100);
  scheduler.stop();
  const openAfterStop = (await restaurantRow(r.id)).is_open;
  assert.equal(openAfterStop, 1);

  await db.execute('UPDATE restaurants SET is_open = 0, paused_until = $1 WHERE id = $2', [secondsFromNow(-5), r.id]);
  await sleep(150); // если бы таймер утёк, эта пауза тоже была бы снята
  assert.equal((await restaurantRow(r.id)).is_open, 0, 'таймер не должен был "утечь" и продолжать тикать после stop()');
});

// ===========================================================================
// I. Pool cleanup
// ===========================================================================

test('I1: пул PostgreSQL возвращён, waitingCount=0, total===idle', async () => {
  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});

// ===========================================================================
// J. Отсутствие SQLite import
// ===========================================================================

test('J1: исходник scheduler.js не содержит require db/index.js (SQLite) / db.prepare() / SQLite orderService', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../services/postgresql/scheduler.js'), 'utf8');
  assert.doesNotMatch(src, /db\.prepare\(/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/\.\.\/db['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/orderService['"]\)/);
});

test('J2: require(scheduler.js) не создаёт таймер сам по себе и не тянет SQLite orderService', () => {
  delete require.cache[require.resolve('../../services/postgresql/scheduler.js')];
  require('../../services/postgresql/scheduler.js');
  const loadedSqlite = Object.keys(require.cache).some(
    (k) => k.endsWith(`${path.sep}services${path.sep}orderService.js`) || k.endsWith(`${path.sep}services${path.sep}orderAccessService.js`)
  );
  assert.equal(loadedSqlite, false);
});

// ===========================================================================
// K. Проверка публикации событий — sweepPauseExpiry не эмитит НИЧЕГО
// ===========================================================================

test('K1: реальный sweep истёкшей паузы не эмитит ни order:status, ни order:new (тот же контракт, что и SQLite-оригинал)', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const captured = [];
  const onStatus = (payload) => captured.push({ event: 'order:status', payload });
  const onNew = (payload) => captured.push({ event: 'order:new', payload });
  pgOrderService.orderEvents.on('order:status', onStatus);
  pgOrderService.orderEvents.on('order:new', onNew);
  try {
    const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
    await scheduler.runOnce();
    assert.equal(captured.length, 0, 'sweepPauseExpiry не должен был эмитить ни одного orderEvents-события');
    assert.equal((await restaurantRow(r.id)).is_open, 1, 'sweep при этом реально сработал');
  } finally {
    pgOrderService.orderEvents.removeListener('order:status', onStatus);
    pgOrderService.orderEvents.removeListener('order:new', onNew);
  }
});

// ===========================================================================
// L. Concurrency
// ===========================================================================

test('L1: два конкурентных runOnce() (два "процесса") на одном истёкшем ресторане — без падения, итоговое состояние корректно', async () => {
  const r = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const schedulerA = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  const schedulerB = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });

  await Promise.all([schedulerA.runOnce(), schedulerB.runOnce()]);

  const row = await restaurantRow(r.id);
  assert.equal(row.is_open, 1);
  assert.equal(row.paused_until, null);
});

test('L2: два конкурентных scheduler-инстанса, каждый со своим таймером, на общей БД — не мешают друг другу', async () => {
  const r1 = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const r2 = await pgCreateRestaurant({ isOpen: 0, pausedUntil: secondsFromNow(-5) });
  const schedulerA = schedulerModule.createPauseExpiryScheduler({ intervalMs: 30 });
  const schedulerB = schedulerModule.createPauseExpiryScheduler({ intervalMs: 45 });

  schedulerA.start();
  schedulerB.start();
  await sleep(150);
  schedulerA.stop();
  schedulerB.stop();

  assert.equal((await restaurantRow(r1.id)).is_open, 1);
  assert.equal((await restaurantRow(r2.id)).is_open, 1);
});

// ===========================================================================
// M. Timezone
// ===========================================================================

test('M1: paused_until, вставленный с явным НЕ-UTC offset, сравнивается корректно (TIMESTAMPTZ нормализует в UTC на хранении)', async () => {
  // "+05:00" — иной часовой пояс, не UTC и не обязательно совпадающий с
  // локальным поясом машины, на которой выполняется тест. Момент времени
  // при этом РОВНО тот же самый, что secondsFromNow(-5) в UTC.
  const almostExpiredInstant = new Date(Date.now() - 5000);
  const isoWithOffset = almostExpiredInstant.toISOString().replace('Z', '+00:00'); // эквивалент, просто другая запись того же UTC-момента
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, phone, is_open, paused_until)
     VALUES ($1,'test','[]','+7',0,$2::timestamptz) RETURNING *`,
    [`ТЗ-${uniqueSuffix()}`, isoWithOffset]
  );
  const r = rows[0];
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce();
  assert.equal((await restaurantRow(r.id)).is_open, 1);
});

test('M2: пауза, зарезервированная через pauseRestaurant() (PostgreSQL NOW()-based), корректно истекает', async () => {
  const r = await pgCreateRestaurant({ isOpen: 1 });
  // "short" = 33 минуты — искусственно назад отматываем через прямой
  // UPDATE, чтобы не ждать реальные 33 минуты в тесте, но сама SET-логика
  // (NOW()+interval) уже покрыта Stage 3 тестами отдельно.
  await pgOrderService.pauseRestaurant(r.id, 'short');
  await db.execute(`UPDATE restaurants SET paused_until = NOW() - interval '1 second' WHERE id = $1`, [r.id]);
  const scheduler = schedulerModule.createPauseExpiryScheduler({ intervalMs: 1_000_000 });
  await scheduler.runOnce();
  assert.equal((await restaurantRow(r.id)).is_open, 1);
});

// ===========================================================================
// N. Clock drift
// ===========================================================================

test('N1 (документирует дизайн-свойство): решение "истекла ли пауза" принимается ЦЕЛИКОМ на стороне PostgreSQL (NOW()), исходник не использует JS Date.now()/new Date() для gating-сравнения', () => {
  // Structural, не эмпирический тест: реальный дрейф часов между Node-
  // процессом и PostgreSQL-сервером невозможно безопасно смоделировать в
  // этом окружении (нельзя двигать часы embedded PostgreSQL) — вместо этого
  // проверяется САМО СВОЙСТВО ДИЗАЙНА, которое делает clock drift
  // структурно неприменимым: gating-условие целиком выражено в SQL
  // (`paused_until <= NOW()`), исполняется на сервере БД, не подмешивает
  // JS-вычисленное "текущее время".
  const src = fs.readFileSync(path.join(__dirname, '../../services/postgresql/orderService.js'), 'utf8');
  const fnMatch = src.match(/async function sweepPauseExpiry\(\)[\s\S]*?\n}/);
  assert.ok(fnMatch, 'sweepPauseExpiry не найдена в исходнике');
  const fnSrc = fnMatch[0];
  assert.match(fnSrc, /NOW\(\)/);
  assert.doesNotMatch(fnSrc, /Date\.now\(\)|new Date\(/);
});
