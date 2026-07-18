'use strict';

// YAAM Production Switch — Stage 3 (server/bot/postgresql/index.js):
// integration-тесты для изолированного PostgreSQL-порта Telegram-бота
// против настоящего embedded PostgreSQL 16.14, с fake Telegram client
// (server/test/postgresql/helpers/fakeTelegramBot.js) — без реального
// Telegram token/сети, без изменений в server/bot/index.js (SQLite).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');
const { sleep } = require('./helpers/concurrency');
const { FakeTelegramBot } = require('./helpers/fakeTelegramBot');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const DATABASE_NAME = 'yaam_bot_stage3_test';

let cluster;
let db;
let pgOrderService;
let botModule;

before(async () => {
  cluster = await startEmbeddedPostgres('bot-stage3');
  await cluster.createDatabase(DATABASE_NAME);
  const setupClient = cluster.getClient(DATABASE_NAME);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString(DATABASE_NAME);
  db = require('../../db/postgresql/index.js');
  pgOrderService = require('../../services/postgresql/orderService.js');
  botModule = require('../../bot/postgresql/index.js');
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

async function pgCreateRestaurant({ connectCode = null, telegramChatId = null, defaultCookMinutes = 40, name = 'Test' } = {}) {
  const rows = await db.query(
    `INSERT INTO restaurants (name, cuisine, cities, phone, connect_code, telegram_chat_id, default_cook_minutes)
     VALUES ($1, 'test', '[]', '+79280000000', $2, $3, $4) RETURNING *`,
    [name, connectCode, telegramChatId, defaultCookMinutes]
  );
  return rows[0];
}

async function pgCreateCategory(restaurantId, { name = 'Основное' } = {}) {
  const rows = await db.query(
    `INSERT INTO categories (restaurant_id, name) VALUES ($1, $2) RETURNING *`,
    [restaurantId, name]
  );
  return rows[0];
}

async function pgCreateMenuItem(restaurantId, categoryId, { name = 'Хинкали', price = 500, isAvailable = 1, sortOrder = 0 } = {}) {
  const rows = await db.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [restaurantId, categoryId, name, price, isAvailable, sortOrder]
  );
  return rows[0];
}

async function pgCreateOrder(restaurantId, { status = 'awaiting_payment', fulfillmentType = 'delivery' } = {}) {
  const suffix = uniqueSuffix();
  const rows = await db.query(
    `INSERT INTO orders (
       public_code, restaurant_id, city, customer_name, customer_phone, address,
       items_total, commission_amount, status, fulfillment_type, comment
     ) VALUES ($1, $2, 'Грозный', 'Test Customer', '+79280000001', 'ул. Тестовая, 1', 500, 35, $3, $4, 'без лука')
     RETURNING *`,
    [`YAAM-BOT-${suffix}`, restaurantId, status, fulfillmentType]
  );
  return rows[0];
}

async function pgCreateOrderItem(orderId, { name = 'Хинкали', price = 500, qty = 1 } = {}) {
  await db.execute(`INSERT INTO order_items (order_id, name, price, qty) VALUES ($1, $2, $3, $4)`, [orderId, name, price, qty]);
}

async function pgCreatePayment(orderId, { amount = 500, status = 'pending' } = {}) {
  const rows = await db.query(`INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3) RETURNING *`, [orderId, amount, status]);
  return rows[0];
}

async function fullyPaidOrder({ fulfillmentType = 'delivery', restaurant } = {}) {
  const r = restaurant || (await pgCreateRestaurant({ telegramChatId: `chat-${uniqueSuffix()}` }));
  const order = await pgCreateOrder(r.id, { status: 'awaiting_payment', fulfillmentType });
  await pgCreateOrderItem(order.id, { name: 'Хинкали', price: 500, qty: 1 });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });
  return { restaurant: r, order, payment };
}

// SQLite bot/index.js, строки 69-75 — дословная копия expression'а, которым
// оригинал строит текст уведомления. bot/index.js менять нельзя, а
// сконструировать реальный SQLite TelegramBot без сети/токена невозможно
// (конструктор сам стартует polling) — поэтому parity текста проверяется
// сравнением с этим верным, дословно скопированным эталоном, а не запуском
// самого SQLite-бота.
function sqliteRenderOrderNewText(order) {
  const itemsList = order.items.map((i) => `${i.qty} × ${i.name} — ${i.price * i.qty} ₽`).join('\n');
  const fulfillmentLine = order.fulfillment_type === 'pickup'
    ? '🏃 Самовывоз (курьер не нужен)'
    : `🛵 Доставка\nАдрес: ${order.address}`;
  return `🆕 Новый заказ ${order.public_code}\n\n${itemsList}\n\nИтого: ${order.items_total} ₽\n${fulfillmentLine}\nТелефон: ${order.customer_phone}\nКомментарий: ${order.comment || '—'}\n\nОтветьте в течение 3 минут, иначе заказ отменится автоматически.`;
}

// ===========================================================================
// A. Инициализация
// ===========================================================================

test('A1: модуль загружается без SQLite side effect (нет require db/index.js, нет SQLite orderService)', () => {
  const before = Object.keys(require.cache).length;
  delete require.cache[require.resolve('../../bot/postgresql/index.js')];
  require('../../bot/postgresql/index.js');
  const loadedSqlite = Object.keys(require.cache).some(
    (k) => k.endsWith('/server/db/index.js') || k.endsWith('/services/orderService.js') || k.endsWith('/services/orderAccessService.js')
  );
  assert.equal(loadedSqlite, false);
  assert.ok(Object.keys(require.cache).length >= before);
});

test('A2: исходник bot/postgresql/index.js не содержит db.prepare()/require("../db")/require("../../db") (SQLite)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../bot/postgresql/index.js'), 'utf8');
  assert.doesNotMatch(src, /db\.prepare\(/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/db['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/\.\.\/db['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/services\/orderService['"]\)/);
});

test('A3: createBotHandlers(fakeBot) стартует с fake-клиентом, без токена/сети', () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  assert.equal(handlers.bot, fakeBot);
  assert.equal(typeof handlers.stop, 'function');
  handlers.stop();
});

test('A4: listener order:new добавляется РОВНО один раз при создании, снимается при stop()', () => {
  const baseline = pgOrderService.orderEvents.listenerCount('order:new');
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  assert.equal(pgOrderService.orderEvents.listenerCount('order:new'), baseline + 1);
  handlers.stop();
  assert.equal(pgOrderService.orderEvents.listenerCount('order:new'), baseline);
});

test('A5: повторная инициализация (create -> stop -> create -> stop) не накапливает listeners', () => {
  const baseline = pgOrderService.orderEvents.listenerCount('order:new');
  for (let i = 0; i < 3; i += 1) {
    const h = botModule.createBotHandlers(new FakeTelegramBot());
    assert.equal(pgOrderService.orderEvents.listenerCount('order:new'), baseline + 1);
    h.stop();
  }
  assert.equal(pgOrderService.orderEvents.listenerCount('order:new'), baseline);
});

// ===========================================================================
// B. Привязка ресторана
// ===========================================================================

test('B1: /start без кода — инструкция, ничего не меняет в БД', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-1', '/start');
    assert.equal(fakeBot.sentMessages.length, 1);
    assert.match(fakeBot.sentMessages[0].text, /Код подключения выдаёт команда YAAM/);
  } finally {
    handlers.stop();
  }
});

test('B2: /start ВАЛИДНЫЙКОД — привязывает ресторан, подтверждение отправлено', async () => {
  const code = `CODE${uniqueSuffix().toUpperCase()}`;
  const restaurant = await pgCreateRestaurant({ connectCode: code, name: 'Кафе Весна' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-b2', `/start ${code}`);
    const rows = await db.query('SELECT telegram_chat_id FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].telegram_chat_id, 'chat-b2');
    assert.equal(fakeBot.sentMessages.length, 1);
    assert.match(fakeBot.sentMessages[0].text, /Кафе Весна.*подключён/s);
  } finally {
    handlers.stop();
  }
});

test('B3: /start НЕВАЛИДНЫЙКОД — "Код не найден", ничего не меняет', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-b3', '/start NOSUCHCODE');
    assert.equal(fakeBot.sentMessages.length, 1);
    assert.match(fakeBot.sentMessages[0].text, /Код не найден/);
  } finally {
    handlers.stop();
  }
});

test('B4: повторный /start тем же кодом из того же чата — безопасен (идемпотентный UPDATE, без ошибки)', async () => {
  const code = `CODE${uniqueSuffix().toUpperCase()}`;
  const restaurant = await pgCreateRestaurant({ connectCode: code });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-b4', `/start ${code}`);
    await fakeBot.triggerText('chat-b4', `/start ${code}`);
    const rows = await db.query('SELECT telegram_chat_id FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].telegram_chat_id, 'chat-b4');
    assert.equal(fakeBot.sentMessages.length, 2);
    assert.match(fakeBot.sentMessages[1].text, /подключён/);
  } finally {
    handlers.stop();
  }
});

test('B5: /start другим кодом из УЖЕ привязанного чата — не течёт в данные другого ресторана', async () => {
  const codeA = `CODEA${uniqueSuffix().toUpperCase()}`;
  const codeB = `CODEB${uniqueSuffix().toUpperCase()}`;
  const restaurantA = await pgCreateRestaurant({ connectCode: codeA, name: 'Ресторан А' });
  const restaurantB = await pgCreateRestaurant({ connectCode: codeB, name: 'Ресторан Б' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-b5', `/start ${codeA}`);
    await fakeBot.triggerText('chat-b5', `/start ${codeB}`);
    const rowsA = await db.query('SELECT telegram_chat_id FROM restaurants WHERE id = $1', [restaurantA.id]);
    const rowsB = await db.query('SELECT telegram_chat_id FROM restaurants WHERE id = $1', [restaurantB.id]);
    // Известное, унаследованное от SQLite-оригинала (и не устраняемое здесь
    // без изменения схемы — telegram_chat_id НЕ UNIQUE ни в одной из версий)
    // поведение: "последняя привязка побеждает" на уровне конкретного
    // ресторана, БЕЗ проверки, что чат уже был привязан к другому. Ресторан А
    // молча остаётся с УСТАРЕВШИМ chat_id (не течёт чужих данных, но и не
    // отвязывается автоматически) — тест фиксирует РЕАЛЬНОЕ поведение, не
    // гипотетическое "правильное".
    assert.equal(rowsA[0].telegram_chat_id, 'chat-b5', 'ресторан А не отвязан автоматически — известное ограничение схемы, не Stage 3');
    assert.equal(rowsB[0].telegram_chat_id, 'chat-b5');
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// C. order:new
// ===========================================================================

test('C1: markPaid -> ровно одно сообщение, корректный chat, корректный текст (byte-for-byte с SQLite-рендером)', async () => {
  const { restaurant, order, payment } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const result = await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();

    assert.equal(fakeBot.sentMessages.length, 1);
    const sent = fakeBot.sentMessages[0];
    assert.equal(sent.chatId, restaurant.telegram_chat_id);
    assert.equal(sent.text, sqliteRenderOrderNewText(result));
    assert.deepEqual(sent.opts.reply_markup.inline_keyboard, [[
      { text: '✅ Принять', callback_data: `accept:${order.id}` },
      { text: '❌ Отклонить', callback_data: `decline:${order.id}` },
    ]]);
  } finally {
    handlers.stop();
  }
});

test('C2: pickup-заказ — строка "Самовывоз", без "Адрес"', async () => {
  const { order, payment } = await fullyPaidOrder({ fulfillmentType: 'pickup' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();
    assert.match(fakeBot.sentMessages[0].text, /Самовывоз \(курьер не нужен\)/);
    assert.doesNotMatch(fakeBot.sentMessages[0].text, /Адрес:/);
  } finally {
    handlers.stop();
  }
});

test('C3: ресторан без подключённого Telegram — событие обработано, сообщение не отправлено, без исключения', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: null });
  const order = await pgCreateOrder(restaurant.id, { status: 'awaiting_payment' });
  await pgCreateOrderItem(order.id);
  const payment = await pgCreatePayment(order.id, { status: 'pending' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();
    assert.equal(fakeBot.sentMessages.length, 0);
  } finally {
    handlers.stop();
  }
});

test('C4: replay markPaid (payment уже succeeded) — второго сообщения нет (order:new не эмитится повторно)', async () => {
  const { order, payment } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();
    assert.equal(fakeBot.sentMessages.length, 1);

    await pgOrderService.markPaid(order.id, payment.id); // replay
    await handlers.waitForIdle();
    assert.equal(fakeBot.sentMessages.length, 1, 'повторный вызов не должен был отправить второе сообщение');
  } finally {
    handlers.stop();
  }
});

test('C5: два конкурентных markPaid на один payment — ровно одно сообщение', async () => {
  const { order, payment } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await Promise.all([
      pgOrderService.markPaid(order.id, payment.id),
      pgOrderService.markPaid(order.id, payment.id),
    ]);
    await handlers.waitForIdle();
    assert.equal(fakeBot.sentMessages.length, 1, 'ровно одно сообщение на два конкурентных вызова');
  } finally {
    handlers.stop();
  }
});

test('C6: ошибка Telegram API на отправке — заказ остаётся committed (paid), исключение не пробрасывается наружу', async () => {
  const { order, payment } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  fakeBot.sendMessageImpl = async () => { throw new Error('Telegram API недоступен'); };
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const result = await pgOrderService.markPaid(order.id, payment.id); // не должен бросить
    assert.equal(result.status, 'awaiting_restaurant');
    await handlers.waitForIdle(); // ошибка внутри handleOrderNew поймана .catch(), не всплывает
    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'awaiting_restaurant', 'commit заказа не откатывается ошибкой уведомления');
  } finally {
    handlers.stop();
  }
});

test('C7: следующее событие после ошибки Telegram всё равно обрабатывается (emitter не сломан)', async () => {
  const { order: orderFail, payment: paymentFail } = await fullyPaidOrder();
  const { order: orderOk, payment: paymentOk } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  let failNext = true;
  fakeBot.sendMessageImpl = async (...args) => {
    if (failNext) { failNext = false; throw new Error('Telegram API недоступен'); }
    return fakeBot._defaultSendMessage(...args);
  };
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await pgOrderService.markPaid(orderFail.id, paymentFail.id);
    await handlers.waitForIdle();
    assert.equal(fakeBot.sentMessages.length, 0);

    await pgOrderService.markPaid(orderOk.id, paymentOk.id);
    await handlers.waitForIdle();
    assert.equal(fakeBot.sentMessages.length, 1, 'второе событие должно было успешно обработаться после сбоя первого');
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// D. Кнопки статусов
// ===========================================================================

async function notifyAndGetAcceptDeclineData(fakeBot, handlers, opts) {
  const { order, payment } = await fullyPaidOrder(opts);
  await pgOrderService.markPaid(order.id, payment.id);
  await handlers.waitForIdle();
  const sent = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
  return { order, sent };
}

test('D1: Принять — заказ accepted, edit + cook-time кнопки, answerCallbackQuery вызван', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await fakeBot.triggerCallbackQuery({ id: 'cb1', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'accepted');
    assert.equal(fakeBot.editedMessages.length, 1);
    assert.equal(fakeBot.editedMessages[0].text, '✅ Заказ принят.');
    assert.equal(fakeBot.sentMessages.length, 2, 'должно было прийти сообщение с выбором времени готовки');
    assert.match(fakeBot.sentMessages[1].text, /сколько времени на готовку/);
    assert.equal(fakeBot.answeredCallbacks.length, 1);
  } finally {
    handlers.stop();
  }
});

test('D2: Отказаться — заказ declined, деньги возвращены (refund зарезервирован), edit-текст корректен', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await fakeBot.triggerCallbackQuery({ id: 'cb2', data: `decline:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'declined');
    assert.equal(fakeBot.editedMessages[0].text, '❌ Заказ отклонён, деньги клиенту возвращены.');
    const refunds = await db.query(
      `SELECT count(*)::int AS n FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE p.order_id = $1`,
      [order.id]
    );
    assert.equal(refunds[0].n, 1);
  } finally {
    handlers.stop();
  }
});

test('D3: полный delivery-цикл — accepted -> cook_time(preparing) -> advance(courier) -> advance(delivered)', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers, { fulfillmentType: 'delivery' });
    await fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'b', data: `cook_time:${order.id}:25`, chatId: sent.chatId, messageId: sent.messageId });
    let rows = await db.query('SELECT status, estimated_ready_minutes FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'preparing');
    assert.equal(rows[0].estimated_ready_minutes, 25);

    await fakeBot.triggerCallbackQuery({ id: 'c', data: `advance:courier:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'courier');

    await fakeBot.triggerCallbackQuery({ id: 'd', data: `advance:delivered:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'delivered');

    const lastEdit = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.equal(lastEdit.text, 'Статус обновлён: Доставлен');
  } finally {
    handlers.stop();
  }
});

test('D4: pickup-цикл — accepted -> cook_time(preparing) -> advance(delivered), без courier', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers, { fulfillmentType: 'pickup' });
    await fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'b', data: `cook_time:${order.id}:20`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'c', data: `advance:delivered:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'delivered');
    const lastEdit = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.equal(lastEdit.text, 'Статус обновлён: Клиент забрал');
  } finally {
    handlers.stop();
  }
});

test('D5: недопустимый переход — чистое сообщение об ошибке (без raw PostgreSQL деталей), заказ не меняется', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    // Заказ ещё awaiting_restaurant — advance:delivered недопустим без accept/cook_time.
    await fakeBot.triggerCallbackQuery({ id: 'x', data: `advance:delivered:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    assert.equal(fakeBot.answeredCallbacks.length, 1);
    const alert = fakeBot.answeredCallbacks[0];
    assert.equal(alert.opts.show_alert, true);
    // Плановая бизнес-ошибка (не проходит проверку ADVANCE_MAP) — дословно
    // тот же читаемый текст, что и SQLite-оригинал бросает в этой ветке;
    // не "сырая" ошибка PostgreSQL-драйвера в любом случае.
    assert.equal(alert.opts.text, 'Ошибка: нельзя перейти из awaiting_restaurant в delivered');
    assert.doesNotMatch(alert.opts.text, /SELECT|UPDATE|relation|column|SQLSTATE/i);

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'awaiting_restaurant');
  } finally {
    handlers.stop();
  }
});

test('D6: повторный клик "Принять" на уже принятом заказе — "уже обработан", НЕ второй набор cook-time кнопок', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    const sentAfterFirst = fakeBot.sentMessages.length;

    await fakeBot.triggerCallbackQuery({ id: 'b', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    assert.equal(fakeBot.sentMessages.length, sentAfterFirst, 'повторный клик не должен был отправить ещё один набор cook-time кнопок');
    const lastEdit = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.equal(lastEdit.text, 'Заказ уже обработан.');
    assert.equal(fakeBot.answeredCallbacks.length, 2, 'оба клика должны были получить answerCallbackQuery');
  } finally {
    handlers.stop();
  }
});

test('D7: конкурентные клики "Принять" на одном заказе — данные безопасны (ровно один переход), обе callback-обработки завершаются без падения', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await Promise.all([
      fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId }),
      fakeBot.triggerCallbackQuery({ id: 'b', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId }),
    ]);
    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'accepted', 'ровно один реальный переход, данные не повреждены гонкой');
    assert.equal(fakeBot.answeredCallbacks.length, 2, 'оба конкурентных клика должны были получить answerCallbackQuery, без необработанных исключений');
  } finally {
    handlers.stop();
  }
});

test('D8: два конкурентных "Отказаться" — данные безопасны, максимум один refund', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await Promise.all([
      fakeBot.triggerCallbackQuery({ id: 'a', data: `decline:${order.id}`, chatId: sent.chatId, messageId: sent.messageId }),
      fakeBot.triggerCallbackQuery({ id: 'b', data: `decline:${order.id}`, chatId: sent.chatId, messageId: sent.messageId }),
    ]);
    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'declined');
    const refunds = await db.query(
      `SELECT count(*)::int AS n FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE p.order_id = $1`,
      [order.id]
    );
    assert.equal(refunds[0].n, 1, 'максимум один refund при конкурентном отказе');
  } finally {
    handlers.stop();
  }
});

test('D9: отсутствующий заказ — "Заказ не найден.", корректный callback answer, без падения', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerCallbackQuery({ id: 'x', data: 'accept:999999999', chatId: 'chat-d9', messageId: 1 });
    assert.equal(fakeBot.editedMessages[0].text, 'Заказ не найден.');
    assert.equal(fakeBot.answeredCallbacks.length, 1);
  } finally {
    handlers.stop();
  }
});

test('D10 (документирует унаследованное ограничение): accept/decline не проверяют принадлежность ресторана — ЛЮБОЙ чат может управлять ЛЮБЫМ orderId, если его знает (как и в SQLite-оригинале)', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    // "Чужой" чат, никогда не получавший уведомление об этом заказе.
    await fakeBot.triggerCallbackQuery({ id: 'foreign', data: `accept:${order.id}`, chatId: 'chat-совсем-другого-ресторана', messageId: 1 });
    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'accepted', 'принято "чужим" чатом — известный, унаследованный от SQLite-оригинала пробел (нет проверки владения), не Stage 3');
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// E. Стоп-лист
// ===========================================================================

test('E1: /stoplist — список блюд с текущим состоянием', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: 'chat-e1' });
  const category = await pgCreateCategory(restaurant.id);
  const item = await pgCreateMenuItem(restaurant.id, category.id, { name: 'Плов', isAvailable: 1 });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-e1', '/stoplist');
    assert.equal(fakeBot.sentMessages.length, 1);
    assert.deepEqual(fakeBot.sentMessages[0].opts.reply_markup.inline_keyboard, [[
      { text: '✅ Плов', callback_data: `toggle_item:${item.id}` },
    ]]);
  } finally {
    handlers.stop();
  }
});

test('E2: toggle_item — добавить в стоп-лист, затем убрать (двойной toggle возвращает исходное состояние)', async () => {
  const restaurant = await pgCreateRestaurant();
  const category = await pgCreateCategory(restaurant.id);
  const item = await pgCreateMenuItem(restaurant.id, category.id, { isAvailable: 1 });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerCallbackQuery({ id: '1', data: `toggle_item:${item.id}`, chatId: 'c', messageId: 1 });
    let rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
    assert.equal(rows[0].is_available, 0);

    await fakeBot.triggerCallbackQuery({ id: '2', data: `toggle_item:${item.id}`, chatId: 'c', messageId: 1 });
    rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
    assert.equal(rows[0].is_available, 1);
    assert.equal(fakeBot.answeredCallbacks.length, 2);
  } finally {
    handlers.stop();
  }
});

test('E3: toggle_item отсутствующего блюда — без падения, callback отвечен', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerCallbackQuery({ id: '1', data: 'toggle_item:999999999', chatId: 'c', messageId: 1 });
    assert.equal(fakeBot.answeredCallbacks.length, 1);
  } finally {
    handlers.stop();
  }
});

test('E4 (документирует унаследованное ограничение): toggle_item не проверяет принадлежность ресторана', async () => {
  const restaurant = await pgCreateRestaurant();
  const category = await pgCreateCategory(restaurant.id);
  const item = await pgCreateMenuItem(restaurant.id, category.id, { isAvailable: 1 });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerCallbackQuery({ id: '1', data: `toggle_item:${item.id}`, chatId: 'chat-совсем-другого-ресторана', messageId: 1 });
    const rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
    assert.equal(rows[0].is_available, 0, '"чужой" чат смог переключить блюдо — известный, унаследованный от SQLite-оригинала пробел, не Stage 3');
  } finally {
    handlers.stop();
  }
});

test('E5: два конкурентных toggle одного блюда — детерминированный результат (чётное число переключений = исходное состояние), без потери апдейта', async () => {
  const restaurant = await pgCreateRestaurant();
  const category = await pgCreateCategory(restaurant.id);
  const item = await pgCreateMenuItem(restaurant.id, category.id, { isAvailable: 1 });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await Promise.all([
      fakeBot.triggerCallbackQuery({ id: '1', data: `toggle_item:${item.id}`, chatId: 'c', messageId: 1 }),
      fakeBot.triggerCallbackQuery({ id: '2', data: `toggle_item:${item.id}`, chatId: 'c', messageId: 1 }),
    ]);
    const rows = await db.query('SELECT is_available FROM menu_items WHERE id = $1', [item.id]);
    assert.equal(rows[0].is_available, 1, 'два конкурентных toggle сериализуются построчной блокировкой — чётное число флипов возвращает исходное состояние');
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// /pause, /open
// ===========================================================================

test('/pause без привязанного ресторана — просит подключиться', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-nopause', '/pause');
    assert.match(fakeBot.sentMessages[0].text, /Сначала подключите ресторан/);
  } finally {
    handlers.stop();
  }
});

test('/pause -> кнопка short -> is_open=0, paused_until в будущем; /open -> is_open=1', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: 'chat-pause' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-pause', '/pause');
    assert.deepEqual(fakeBot.sentMessages[0].opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [
      'pause:short', 'pause:medium', 'pause:long',
    ]);

    await fakeBot.triggerCallbackQuery({ id: '1', data: 'pause:short', chatId: 'chat-pause', messageId: 1 });
    let rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 0);
    assert.ok(new Date(rows[0].paused_until).getTime() > Date.now());
    assert.equal(fakeBot.editedMessages[0].text, 'Перерыв: 33 мин. /open — вернуться раньше срока.');

    await fakeBot.triggerText('chat-pause', '/open');
    rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 1);
    assert.equal(rows[0].paused_until, null);
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// G. Cleanup
// ===========================================================================

test('G1: после всех тестов файла listenerCount(order:new) вернулся к базовому уровню', () => {
  // Косвенная проверка отсутствия утечек — каждый тест выше сам снимает
  // listener через handlers.stop() в finally; если бы хоть один не снял,
  // счётчик здесь был бы > изначального (проверено A4/A5 более строго).
  assert.ok(pgOrderService.orderEvents.listenerCount('order:new') <= 1);
});

test('G2: пул PostgreSQL возвращён, waitingCount=0, total===idle', async () => {
  await sleep(20);
  const pool = db.getPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, pool.idleCount);
});
