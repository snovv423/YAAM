'use strict';

// YAAM Stage 31, раздел 1.2/1.3/9 — persistent outbox для критичных
// Telegram-уведомлений (server/services/postgresql/botOutboxService.js,
// таблица bot_notifications, миграция 0010). Integration-тесты против
// настоящего embedded PostgreSQL 16.14, с fake Telegram client (тот же
// helper, что и botStage3.test.js) — без реального Telegram token/сети.
//
// Живой Stage 30 дважды поймал "EFATAL: fetch failed" при прямой отправке
// order:new — этот файл целенаправленно проверяет ИМЕННО устойчивость
// доставки (retry/backoff/dedup/честный дедлайн), а не повторяет уже
// покрытый botStage3.test.js функционал самих callback-сценариев бота.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');
const { FakeTelegramBot } = require('./helpers/fakeTelegramBot');
const { FatalError, TelegramError } = require('node-telegram-bot-api');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_bot_outbox_stage31_test';

let cluster;
let db;
let pgOrderService;
let botOutboxService;
let eventLogService;

before(async () => {
  cluster = await startEmbeddedPostgres('bot-outbox-stage31');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');
  botOutboxService = require('../../services/postgresql/botOutboxService.js');
  eventLogService = require('../../services/hq/eventLogService.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

async function pgCreateRestaurant() {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, telegram_chat_id) VALUES ('Test', 'test', '[]', $1) RETURNING *`,
    [`chat-${uniqueSuffix()}`],
  );
  return rows[0];
}

async function pgCreateOrder(restaurantId, { statusUpdatedAt = null, status = 'awaiting_restaurant' } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, status_updated_at
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35,
       $4, COALESCE($3, NOW()))
     RETURNING *`,
    [`YAAM-OUTBOX-${suffix}`, restaurantId, statusUpdatedAt, status],
  );
  return rows[0];
}

async function pgCreatePayment(orderId, { status = 'succeeded' } = {}) {
  const rows = await db.query(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1, 500, $2) RETURNING *`,
    [orderId, status],
  );
  return rows[0];
}

async function notificationRow(dedupKey) {
  const rows = await db.query('SELECT * FROM bot_notifications WHERE dedup_key = $1', [dedupKey]);
  return rows[0] || null;
}

// ===========================================================================
// Классификация ошибок
// ===========================================================================

test('classifyTelegramError: EFATAL (сетевой сбой транспорта) -> retry', () => {
  const err = new FatalError(new Error('fetch failed'));
  assert.equal(botOutboxService.classifyTelegramError(err), 'retry');
});

test('classifyTelegramError: ETELEGRAM 403 (бот заблокирован/чат не найден) -> permanent', () => {
  const err = new TelegramError('403 Forbidden: bot was blocked by the user', { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
  assert.equal(botOutboxService.classifyTelegramError(err), 'permanent');
});

test('classifyTelegramError: ETELEGRAM 400 (некорректный запрос) -> permanent', () => {
  const err = new TelegramError('400 Bad Request', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request' } });
  assert.equal(botOutboxService.classifyTelegramError(err), 'permanent');
});

test('classifyTelegramError: ETELEGRAM 502 (сбой на стороне Telegram) -> retry', () => {
  const err = new TelegramError('502 Bad Gateway', { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } });
  assert.equal(botOutboxService.classifyTelegramError(err), 'retry');
});

test('describeError: EFATAL не содержит токен/URL, но сохраняет структурные поля (code/errno) вложенной причины', () => {
  const cause = new Error('connect ECONNREFUSED 149.154.167.220:443');
  cause.code = 'ECONNREFUSED';
  cause.errno = -111;
  cause.syscall = 'connect';
  const err = new FatalError(cause);
  const described = botOutboxService.describeError(err);
  assert.match(described, /ECONNREFUSED/);
  assert.doesNotMatch(described, /bot\d+:/i, 'токен бота (формат "bot<id>:<secret>" в URL) никогда не должен попасть в лог');
});

// ===========================================================================
// Retry / backoff
// ===========================================================================

test('enqueueAndDispatch: транзиентный сбой (EFATAL) на первой попытке -> строка остаётся pending с next_attempt_at в будущем, HQ-алерт НЕ создаётся (попытки не исчерпаны)', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const fakeBot = new FakeTelegramBot();
  fakeBot.sendMessageImpl = async () => { throw new FatalError(new Error('fetch failed')); };

  const dedupKey = `order:${order.id}:new`;
  const result = await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест',
  });
  assert.equal(result.outcome, 'retry-scheduled');

  const row = await notificationRow(dedupKey);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > new Date(), 'следующая попытка назначена в будущем (backoff)');
  assert.match(row.last_error, /fetch failed/);

  const events = await db.query(`SELECT * FROM hq_events WHERE order_id = $1`, [order.id]);
  assert.equal(events.length, 0, 'после ОДНОЙ временной неудачи алерт ещё не создаётся — только после исчерпания попыток');
});

test('dispatchPending: transient failure -> retry -> успешная доставка на следующем тике (переживает "рестарт" — новый вызов, новый вымышленный процесс)', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const dedupKey = `order:${order.id}:new`;

  // "Старый процесс" — первая попытка падает.
  const failingBot = new FakeTelegramBot();
  failingBot.sendMessageImpl = async () => { throw new FatalError(new Error('fetch failed')); };
  await botOutboxService.enqueueAndDispatch(failingBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест retry',
  });
  let row = await notificationRow(dedupKey);
  assert.equal(row.status, 'pending');

  // Приблизим next_attempt_at к прошлому — не ждать реальный backoff в тесте.
  await db.execute(`UPDATE bot_notifications SET next_attempt_at = NOW() - interval '1 second' WHERE dedup_key = $1`, [dedupKey]);

  // "Новый процесс" — независимый bot-клиент, ничего не помнит про первую попытку.
  const workingBot = new FakeTelegramBot();
  const { dispatched } = await botOutboxService.dispatchPending(workingBot);
  assert.equal(dispatched, 1);

  row = await notificationRow(dedupKey);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 2);
  assert.ok(row.sent_at, 'sent_at заполнен при успешной доставке');
  assert.equal(workingBot.sentMessages.length, 1);
  assert.equal(failingBot.sentMessages.length, 0, 'первая (упавшая) попытка не оставила сообщения в старом клиенте');
});

test('permanent Telegram error (403) -> без бессмысленных retry, status=failed с одной попытки, диагностируемый hq_events-алерт создаётся', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const fakeBot = new FakeTelegramBot();
  fakeBot.sendMessageImpl = async () => {
    throw new TelegramError('403 Forbidden: bot was blocked by the user', {
      status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    });
  };

  const dedupKey = `order:${order.id}:new`;
  const result = await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест permanent',
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.classification, 'permanent');

  const row = await notificationRow(dedupKey);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1, 'постоянная ошибка НЕ повторяется — ни одной лишней попытки');
  assert.match(row.last_error, /403/);

  const events = await db.query(`SELECT * FROM hq_events WHERE order_id = $1 AND category = 'telegram_issue'`, [order.id]);
  assert.equal(events.length, 1, 'диагностируемый алерт для YAAM создан после окончательного сбоя');
  assert.match(events[0].message, /не доставлено/);
});

test('исчерпание всех попыток (постоянные транзиентные сбои) -> status=failed, hq_events-алерт создаётся ровно один раз', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const fakeBot = new FakeTelegramBot();
  fakeBot.sendMessageImpl = async () => { throw new FatalError(new Error('fetch failed')); };

  const dedupKey = `order:${order.id}:new`;
  await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест exhaustion', maxAttempts: 2,
  });
  let row = await notificationRow(dedupKey);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);

  await db.execute(`UPDATE bot_notifications SET next_attempt_at = NOW() - interval '1 second' WHERE dedup_key = $1`, [dedupKey]);
  await botOutboxService.dispatchPending(fakeBot);

  row = await notificationRow(dedupKey);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2, 'ровно maxAttempts попыток, не больше');

  const events = await db.query(`SELECT * FROM hq_events WHERE order_id = $1 AND category = 'telegram_issue'`, [order.id]);
  assert.equal(events.length, 1, 'ровно один алерт, а не по одному на каждую попытку');
});

// ===========================================================================
// Dedup
// ===========================================================================

test('enqueueAndDispatch: повторный вызов с тем же dedup_key -> ни второй строки, ни второго сообщения (защита от дублей при повторном emit события)', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const fakeBot = new FakeTelegramBot();
  const dedupKey = `order:${order.id}:new`;

  const first = await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест dedup',
  });
  const second = await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест dedup (повтор)',
  });

  assert.equal(first.outcome, 'sent');
  assert.equal(second.outcome, 'duplicate');
  assert.equal(fakeBot.sentMessages.length, 1, 'ровно одно сообщение, несмотря на два вызова');

  const rows = await db.query('SELECT count(*)::int AS n FROM bot_notifications WHERE dedup_key = $1', [dedupKey]);
  assert.equal(rows[0].n, 1, 'ровно одна строка outbox на dedup_key');
});

// ===========================================================================
// Честный 7-минутный дедлайн (раздел 1.3)
// ===========================================================================

test('sweepTimeouts: задержанная доставка (retry) НЕ сокращает обещанное окно — 7 минут отсчитываются от sent_at, а не от создания заказа', async () => {
  const restaurant = await pgCreateRestaurant();
  // Заказ "создан" 6 минут назад — если бы окно отсчитывалось от создания,
  // он уже был бы близок к просрочке (< 1 минуты запаса).
  const order = await pgCreateOrder(restaurant.id, { statusUpdatedAt: new Date(Date.now() - 6 * 60 * 1000) });
  const fakeBot = new FakeTelegramBot();
  const dedupKey = `order:${order.id}:new`;

  // Уведомление доставлено только ТОЛЬКО ЧТО (например, после нескольких
  // retry) — sent_at «прямо сейчас», намного позже status_updated_at.
  await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест честного окна',
  });

  await pgOrderService.sweepTimeouts();

  const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(rows[0].status, 'awaiting_restaurant', 'заказ НЕ должен был просрочиться — от факта доставки прошло секунды, а не 7 минут');
});

test('sweepTimeouts: без bot_notifications (никогда не доставлено) -> запасной источник status_updated_at не даёт заказу зависнуть бесконечно', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { statusUpdatedAt: new Date(Date.now() - 10 * 60 * 1000) });
  await pgCreatePayment(order.id, { status: 'succeeded' });
  // Ни одной строки bot_notifications для этого заказа не создавалось —
  // симулирует случай, когда order:new вообще не смог поставиться в очередь.

  await pgOrderService.sweepTimeouts();

  const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(rows[0].status, 'timed_out', 'запасной источник (status_updated_at) сработал — заказ не завис навсегда');
});

test('sweepTimeouts: доставленное 8 минут назад уведомление -> заказ просрочен (окно 7 минут истекло с момента реальной доставки)', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { statusUpdatedAt: new Date(Date.now() - 20 * 60 * 1000) });
  const fakeBot = new FakeTelegramBot();
  const dedupKey = `order:${order.id}:new`;
  await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'тест',
  });
  await db.execute(`UPDATE bot_notifications SET sent_at = NOW() - interval '8 minutes' WHERE dedup_key = $1`, [dedupKey]);

  await pgOrderService.sweepTimeouts();

  const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(rows[0].status, 'timed_out');
});

// ===========================================================================
// Stage 31.1, Issue 1 — atomic claim (concurrency: immediate vs scheduler)
// ===========================================================================

test('Issue 1: immediate dispatch и scheduler-тик, гоняющиеся за ОДНОЙ и той же pending-строкой — ровно один bot.sendMessage()', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const dedupKey = `order:${order.id}:new`;
  // Вставлена (next_attempt_at = NOW() по умолчанию — сразу "готова"), но
  // ЕЩЁ не заклеймлена — та самая щель, в которой раньше могли столкнуться
  // immediate dispatch (сразу после enqueue) и scheduler-тик.
  const inserted = await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'race test',
  });
  assert.ok(inserted, 'строка вставлена');

  const immediateBot = new FakeTelegramBot();
  const schedulerBot = new FakeTelegramBot();

  await Promise.all([
    // "immediate dispatch" — ровно то, что enqueueAndDispatch делает внутри
    // (claim, затем dispatchOne только если claim выигран).
    (async () => {
      const claimed = await botOutboxService.claimNotification(inserted.id);
      if (claimed) await botOutboxService.dispatchOne(immediateBot, claimed);
    })(),
    // "scheduler-тик" — независимый worker, видящий ту же строку кандидатом.
    botOutboxService.dispatchPending(schedulerBot),
  ]);

  const totalSent = immediateBot.sentMessages.length + schedulerBot.sentMessages.length;
  assert.equal(totalSent, 1, 'ровно один Telegram send на одну claimed-запись, а не два');

  const row = await notificationRow(dedupKey);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1, 'ровно одна попытка засчитана — не удвоена гонкой');
});

test('Issue 1: два независимых scheduler-тика ("два worker\'а"), гоняющиеся за одной строкой — ровно один send', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const dedupKey = `order:${order.id}:new`;
  await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'race test 2',
  });

  const workerA = new FakeTelegramBot();
  const workerB = new FakeTelegramBot();

  await Promise.all([
    botOutboxService.dispatchPending(workerA),
    botOutboxService.dispatchPending(workerB),
  ]);

  assert.equal(workerA.sentMessages.length + workerB.sentMessages.length, 1);
});

test('Issue 1: заклеймленная (processing) строка НЕ отдаётся повторно, пока не истёк lease', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const dedupKey = `order:${order.id}:new`;
  const inserted = await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'lease test',
  });

  const firstClaim = await botOutboxService.claimNotification(inserted.id);
  assert.ok(firstClaim, 'первый claim выигран');
  assert.equal(firstClaim.status, 'processing');

  const secondClaim = await botOutboxService.claimNotification(inserted.id);
  assert.equal(secondClaim, null, 'повторный claim СВЕЖЕЙ processing-строки обязан проиграть');

  const stillPending = await notificationRow(dedupKey);
  assert.equal(stillPending.status, 'processing', 'строка остаётся processing, не откатывается сама по себе');
});

test('Issue 1: строка, брошенная в processing дольше CLAIM_LEASE_SECONDS (упавший процесс), становится claimable снова — crash не блокирует навечно', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id);
  const dedupKey = `order:${order.id}:new`;
  const inserted = await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'crash recovery test',
  });
  const claimed = await botOutboxService.claimNotification(inserted.id);
  assert.ok(claimed);

  // Симулируем "процесс упал сразу после claim, ничего не записал" —
  // искусственно состариваем updated_at за пределы lease.
  await db.execute(
    `UPDATE bot_notifications SET updated_at = NOW() - ($2 || ' seconds')::interval WHERE id = $1`,
    [inserted.id, botOutboxService.CLAIM_LEASE_SECONDS + 5],
  );

  const bot = new FakeTelegramBot();
  const { dispatched } = await botOutboxService.dispatchPending(bot);
  assert.equal(dispatched, 1, 'просроченный lease должен быть переклеймлен и обработан');
  assert.equal(bot.sentMessages.length, 1);

  const row = await notificationRow(dedupKey);
  assert.equal(row.status, 'sent');
});

// ===========================================================================
// Stage 31.1, Issue 2 — устаревший order:new (заказ уже не awaiting_restaurant)
// ===========================================================================

test('Issue 2: awaiting_restaurant -> order:new отправляется нормально (контроль, не должно ничего сломаться)', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant' });
  const fakeBot = new FakeTelegramBot();
  const dedupKey = `order:${order.id}:new`;

  const result = await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'свежий заказ',
  });
  assert.equal(result.outcome, 'sent');
  assert.equal(fakeBot.sentMessages.length, 1);
});

test('Issue 2: заказ стал timed_out ДО фактической отправки (retry) -> Telegram НЕ получает устаревшее "Новый заказ", notification помечается skipped, БЕЗ telegram_issue', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant' });
  const dedupKey = `order:${order.id}:new`;
  // Уведомление поставлено в очередь, но НЕ отправлено сразу (bot=null —
  // имитирует "бот пока не создан" или "immediate dispatch не успел").
  await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'устареет до отправки',
  });

  // Заказ уходит из awaiting_restaurant МЕЖДУ enqueue и фактической
  // попыткой отправки — ровно сценарий задания.
  await db.execute(`UPDATE orders SET status = 'timed_out', status_updated_at = NOW() WHERE id = $1`, [order.id]);

  const fakeBot = new FakeTelegramBot();
  const { dispatched } = await botOutboxService.dispatchPending(fakeBot);

  assert.equal(dispatched, 1, 'попытка была сделана (заклеймлена), но не привела к реальной отправке');
  assert.equal(fakeBot.sentMessages.length, 0, 'Telegram НЕ должен получить устаревшее "Новый заказ"');

  const row = await notificationRow(dedupKey);
  assert.equal(row.status, 'skipped');
  assert.notEqual(row.last_error, null);

  // Не должно быть создано telegram_issue — это штатный исход, не сбой.
  const events = await db.query(
    `SELECT * FROM hq_events WHERE order_id = $1 AND category = 'telegram_issue'`, [order.id],
  );
  assert.equal(events.length, 0, 'штатно устаревший event не должен создавать telegram_issue алерт');

  // Статус самого заказа не тронут этим механизмом.
  const orderRow = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
  assert.equal(orderRow[0].status, 'timed_out');
});

test('Issue 2: заказ отменён клиентом (cancelled) ДО фактической отправки -> тот же skip, без сообщения', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant' });
  const dedupKey = `order:${order.id}:new`;
  await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'отменят до отправки',
  });
  await db.execute(`UPDATE orders SET status = 'cancelled', status_updated_at = NOW() WHERE id = $1`, [order.id]);

  const fakeBot = new FakeTelegramBot();
  await botOutboxService.dispatchPending(fakeBot);

  assert.equal(fakeBot.sentMessages.length, 0);
  const row = await notificationRow(dedupKey);
  assert.equal(row.status, 'skipped');
});

test('Issue 2: skipped-уведомление НЕ оживает повторным scheduler-тиком', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant' });
  const dedupKey = `order:${order.id}:new`;
  await botOutboxService.enqueue({
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'устареет и останется устаревшим',
  });
  await db.execute(`UPDATE orders SET status = 'declined', status_updated_at = NOW() WHERE id = $1`, [order.id]);

  const firstBot = new FakeTelegramBot();
  await botOutboxService.dispatchPending(firstBot);
  assert.equal((await notificationRow(dedupKey)).status, 'skipped');

  // Повторный тик (например, следующий 5-секундный интервал) не должен
  // подобрать уже skipped-строку — она не входит в кандидаты вовсе (не
  // 'pending' и не просроченный 'processing').
  const secondBot = new FakeTelegramBot();
  const { dispatched } = await botOutboxService.dispatchPending(secondBot);
  assert.equal(dispatched, 0);
  assert.equal(secondBot.sentMessages.length, 0);
});

// ===========================================================================
// Stage 31.1, Issue 3 — restaurant_response_deadline_at (серверный источник истины)
// ===========================================================================

test('Issue 3: без доставленного order:new -> дедлайн = status_updated_at + 7 минут (запасной источник)', async () => {
  const restaurant = await pgCreateRestaurant();
  const statusUpdatedAt = new Date(Date.now() - 60 * 1000); // минуту назад
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant', statusUpdatedAt });

  const fresh = await pgOrderService.getOrder(order.id);
  assert.ok(fresh.restaurant_response_deadline_at);
  const deadlineMs = new Date(fresh.restaurant_response_deadline_at).getTime();
  const expectedMs = statusUpdatedAt.getTime() + 420 * 1000;
  assert.ok(Math.abs(deadlineMs - expectedMs) < 1000, `дедлайн должен быть status_updated_at+420с, разница ${deadlineMs - expectedMs}мс`);
});

test('Issue 3: order:new доставлен с задержкой -> дедлайн = sent_at + 7 минут, НЕ status_updated_at + 7 минут', async () => {
  const restaurant = await pgCreateRestaurant();
  // Заказ "создан" 2 минуты назад — если бы дедлайн считался от создания,
  // он истёк бы заметно раньше, чем от факта задержанной доставки.
  const statusUpdatedAt = new Date(Date.now() - 2 * 60 * 1000);
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant', statusUpdatedAt });
  const dedupKey = `order:${order.id}:new`;
  const fakeBot = new FakeTelegramBot();
  // Доставлено ТОЛЬКО ЧТО (не 2 минуты назад) — имитирует Telegram-retry с задержкой.
  await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'задержанная доставка',
  });

  const fresh = await pgOrderService.getOrder(order.id);
  const deadlineMs = new Date(fresh.restaurant_response_deadline_at).getTime();
  const expectedFromStatusUpdated = statusUpdatedAt.getTime() + 420 * 1000;
  const expectedFromSentAt = Date.now() + 420 * 1000; // sent_at ~= сейчас

  assert.ok(deadlineMs > expectedFromStatusUpdated + 60000,
    'дедлайн ОБЯЗАН быть позже, чем status_updated_at+7мин — иначе задержка Telegram отняла бы время у ресторана');
  assert.ok(Math.abs(deadlineMs - expectedFromSentAt) < 2000,
    `дедлайн должен быть от факта доставки (sent_at), разница ${deadlineMs - expectedFromSentAt}мс`);
});

test('Issue 3: повторное чтение заказа (эмуляция hard reload / повторного poll) даёт ТОТ ЖЕ дедлайн', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_restaurant' });
  const dedupKey = `order:${order.id}:new`;
  const fakeBot = new FakeTelegramBot();
  await botOutboxService.enqueueAndDispatch(fakeBot, {
    dedupKey, orderId: order.id, chatId: restaurant.telegram_chat_id, text: 'reload test',
  });

  const first = await pgOrderService.getOrder(order.id);
  const second = await pgOrderService.getOrder(order.id);
  assert.equal(first.restaurant_response_deadline_at.getTime(), second.restaurant_response_deadline_at.getTime(),
    'повторное чтение (hard reload/повторный poll) не должно ни сбрасывать, ни продлевать дедлайн');
});

test('Issue 3: дедлайн становится NULL вне awaiting_restaurant (нечего отсчитывать)', async () => {
  const restaurant = await pgCreateRestaurant();
  const order = await pgCreateOrder(restaurant.id, { status: 'preparing' });
  const fresh = await pgOrderService.getOrder(order.id);
  assert.equal(fresh.restaurant_response_deadline_at, null);
});

// ===========================================================================
// Пул PostgreSQL — гигиена (тот же паттерн, что во всех *.test.js этого набора)
// ===========================================================================

test('пул возвращён, waitingCount=0', async () => {
  // Даём settle-нуться фоновому fire-and-forget (scheduleRefundProcessing и
  // т.п. из предыдущего теста) — тот же паттерн, что и во всех остальных
  // *.test.js этого набора (см. orderServiceWave3.test.js).
  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});
