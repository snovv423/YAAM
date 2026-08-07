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

// Stage 31, раздел 1.3 — sweepTimeouts() теперь честно меряет окно ответа
// от COALESCE(bot_notifications.sent_at, orders.status_updated_at), а не
// только от status_updated_at (см. orderService.js). Тесты, которые
// проходят через РЕАЛЬНЫЙ handleOrderNew (markPaid -> order:new -> бот),
// уже получили настоящую bot_notifications-строку с sent_at «прямо
// сейчас» — одного backdate только orders.status_updated_at недостаточно
// для симуляции просроченного заказа: sent_at (свежий) выигрывает у
// COALESCE. Эта функция откатывает НАЗАД оба источника разом — тот же
// сдвиг, что тест и просит смоделировать.
async function backdateOrderResponseWindow(orderId, minutesAgo) {
  await db.execute(
    `UPDATE orders SET status_updated_at = NOW() - ($1 || ' minutes')::interval WHERE id = $2`,
    [minutesAgo, orderId],
  );
  await db.execute(
    `UPDATE bot_notifications SET sent_at = NOW() - ($1 || ' minutes')::interval
     WHERE dedup_key = $2 AND sent_at IS NOT NULL`,
    [minutesAgo, `order:${orderId}:new`],
  );
}

async function fullyPaidOrder({ fulfillmentType = 'delivery', restaurant } = {}) {
  const r = restaurant || (await pgCreateRestaurant({ telegramChatId: `chat-${uniqueSuffix()}` }));
  const order = await pgCreateOrder(r.id, { status: 'awaiting_payment', fulfillmentType });
  await pgCreateOrderItem(order.id, { name: 'Хинкали', price: 500, qty: 1 });
  const payment = await pgCreatePayment(order.id, { status: 'pending' });
  return { restaurant: r, order, payment };
}

// Независимый эталон формата (Stage 31, раздел 2 — заголовок "Заказ:",
// позиции без цены, единая сумма "Оплачено: N ₽", опциональный "Чек
// оплаты", окно ответа 7 минут) — дословная копия expression'а, которым
// renderOrderNewText() в bot/postgresql/index.js строит текст, чтобы
// ловить случайные расхождения так же, как это раньше делал parity-тест с
// SQLite-оригиналом (с UX fix-stage после Stage 28 тексты двух ботов
// намеренно расходятся — см. header-комментарий модуля).
function pgRenderOrderNewText(order, { receiptUrl = null } = {}) {
  const itemsList = order.items.map((i) => `${i.qty} × ${i.name}`).join('\n');
  const fulfillmentBlock = order.fulfillment_type === 'pickup'
    ? 'Самовывоз (курьер не нужен)'
    : `Доставка\nАдрес: ${order.address}`;
  const blocks = [
    `Заказ ${order.public_code}`,
    `Заказ:\n${itemsList}`,
    `Комментарий: ${order.comment || 'без комментария'}`,
    fulfillmentBlock,
    `Клиент: ${order.customer_name}\nТелефон: ${order.customer_phone}`,
    `Оплачено: ${order.items_total} ₽`,
  ];
  if (receiptUrl) blocks.push(`Чек оплаты: ${receiptUrl}`);
  blocks.push('Ответьте в течение 7 минут, иначе заказ отменится автоматически.');
  return blocks.join('\n\n');
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
    // Stage 29.1, п.4: подтверждение подключения + сразу панель статуса
    // (не нужно отдельно вспоминать bare /start, чтобы увидеть кнопки).
    assert.equal(fakeBot.sentMessages.length, 2);
    assert.match(fakeBot.sentMessages[0].text, /Кафе Весна.*подключён/s);
    assert.match(fakeBot.sentMessages[1].text, /Кафе Весна.*открыт/s);
    assert.deepEqual(fakeBot.sentMessages[1].opts.reply_markup.inline_keyboard, [[
      { text: 'Закрыть ресторан', callback_data: 'close_menu' },
    ]]);
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

// docs/HQ-PRODUCT-SPEC.md, раздел «Telegram»: код ОДНОРАЗОВЫЙ. Прежнее
// поведение (повторный /start тем же кодом снова «подключает») больше не
// действует — код гасится той же транзакцией, что и привязка.
test('B4: повторный /start тем же кодом — код уже погашен, второй раз не подключает', async () => {
  const code = `CODE${uniqueSuffix().toUpperCase()}`;
  const restaurant = await pgCreateRestaurant({ connectCode: code });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-b4', `/start ${code}`);
    await fakeBot.triggerText('chat-b4', `/start ${code}`);
    const rows = await db.query('SELECT telegram_chat_id, connect_code FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].telegram_chat_id, 'chat-b4');
    assert.equal(rows[0].connect_code, null, 'код должен быть погашен сразу после привязки');
    // Stage 29.1, п.4: первый /start шлёт 2 сообщения (подключено + панель
    // статуса), второй (код уже погашен) — ещё одно сообщение об ошибке.
    assert.equal(fakeBot.sentMessages.length, 3);
    assert.match(fakeBot.sentMessages[0].text, /подключён/);
    assert.match(fakeBot.sentMessages[2].text, /не найден или уже использован/);
  } finally {
    handlers.stop();
  }
});

// docs/HQ-PRODUCT-SPEC.md: одна Telegram-группа не может обслуживать два
// ресторана. Прежнее поведение («последняя привязка побеждает», ресторан А
// молча оставался с устаревшим chat_id) заменено явным отказом — на уровне
// сервиса и частичным UNIQUE-индексом ux_restaurants_telegram_chat в схеме.
test('B5: /start другим кодом из УЖЕ привязанного чата — отказ, вторая привязка не создаётся', async () => {
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
    const rowsB = await db.query('SELECT telegram_chat_id, connect_code FROM restaurants WHERE id = $1', [restaurantB.id]);
    assert.equal(rowsA[0].telegram_chat_id, 'chat-b5', 'первая (легитимная) привязка сохраняется');
    assert.equal(rowsB[0].telegram_chat_id, null, 'второй ресторан НЕ привязывается к уже занятой группе');
    assert.equal(rowsB[0].connect_code, codeB, 'код второго ресторана не погашен — привязки не было');
    // Stage 29.1, п.4: первый /start (codeA) шлёт 2 сообщения (подключено +
    // панель статуса) — отказ второй привязки идёт третьим сообщением.
    assert.match(fakeBot.sentMessages[2].text, /уже привязана к другому ресторану/);
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// C. order:new
// ===========================================================================

test('C1: markPaid -> ровно одно сообщение, корректный chat, корректный текст (byte-for-byte с независимым эталоном), имя клиента включено, без emoji', async () => {
  const { restaurant, order, payment } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const result = await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();

    assert.equal(fakeBot.sentMessages.length, 1);
    const sent = fakeBot.sentMessages[0];
    assert.equal(sent.chatId, restaurant.telegram_chat_id);
    assert.equal(sent.text, pgRenderOrderNewText(result));
    assert.match(sent.text, /Клиент: Test Customer/, 'Stage 28 находка MEDIUM-1 — имя клиента теперь в тексте');
    assert.doesNotMatch(sent.text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'CLAUDE.md "без emoji в UI" — в тексте заказа не должно быть emoji');
    assert.deepEqual(sent.opts.reply_markup.inline_keyboard, [[
      { text: 'Принять', callback_data: `accept:${order.id}` },
      { text: 'Отклонить', callback_data: `decline:${order.id}` },
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

// docs/HQ-PRODUCT-SPEC.md, раздел «Выбор времени приготовления»: «Принять» —
// ПЕРВЫЙ из двух шагов и сам по себе заказ не принимает; заказ переходит в
// accepted только после выбора 30/45/60. Именно так «без выбора времени
// заказ нельзя принять» обеспечивается структурно.
test('D1 (Stage 31, раздел 1.4): Принять — заказ ЕЩЁ не принят, выбор 30/45/60 показан ОДНИМ editMessageText (не отдельным sendMessage), answerCallbackQuery вызван', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await fakeBot.triggerCallbackQuery({ id: 'cb1', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'awaiting_restaurant', 'без выбора времени заказ не принимается');
    // Stage 31, раздел 1.4 — ОДИН editMessageText несёт и текст, и кнопки
    // времени сразу: раньше был отдельный sendMessage для кнопок, сбой
    // которого оставлял ресторан без единой кликабельной кнопки (живая
    // находка Stage 30).
    assert.equal(fakeBot.editedMessages.length, 1);
    assert.match(fakeBot.editedMessages[0].text, /за сколько приготовите/i);
    const buttons = fakeBot.editedMessages[0].opts.reply_markup.inline_keyboard[0];
    assert.deepEqual(buttons.map((b) => b.text), ['30 мин', '45 мин', '60 мин']);
    assert.equal(fakeBot.sentMessages.length, 1, 'кнопки выбора времени пришли ОДНИМ editMessageText, отдельного sendMessage больше нет');
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
    assert.equal(fakeBot.editedMessages[0].text, 'Заказ отклонён, деньги клиенту возвращены.');
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
    await fakeBot.triggerCallbackQuery({ id: 'b', data: `cook_time:${order.id}:30`, chatId: sent.chatId, messageId: sent.messageId });
    let rows = await db.query('SELECT status, estimated_ready_minutes FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'preparing');
    assert.equal(rows[0].estimated_ready_minutes, 30);

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
    await fakeBot.triggerCallbackQuery({ id: 'b', data: `cook_time:${order.id}:45`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'c', data: `advance:delivered:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'delivered');
    const lastEdit = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.equal(lastEdit.text, 'Статус обновлён: Клиент забрал');
  } finally {
    handlers.stop();
  }
});

test('D5: недопустимый переход advance — сообщение отредактировано ("Заказ уже обработан."), кнопка не остаётся кликабельной, заказ не меняется', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    // Заказ ещё awaiting_restaurant — advance:delivered недопустим без accept/cook_time.
    await fakeBot.triggerCallbackQuery({ id: 'x', data: `advance:delivered:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    // UX fix-stage после Stage 28 (раздел 1.1): устаревшая/недопустимая
    // кнопка advance больше не оставляет живой алерт с кнопкой на месте —
    // сообщение редактируется тем же принципом, что accept/decline.
    assert.equal(fakeBot.editedMessages.length, 1);
    assert.equal(fakeBot.editedMessages[0].text, 'Заказ уже обработан.');
    assert.doesNotMatch(fakeBot.editedMessages[0].text, /SELECT|UPDATE|relation|column|SQLSTATE/i, 'не "сырая" ошибка PostgreSQL-драйвера');
    assert.equal(fakeBot.answeredCallbacks.length, 1);
    assert.notEqual(fakeBot.answeredCallbacks[0].opts?.show_alert, true, 'не пугающий алерт — тихий callback answer');

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'awaiting_restaurant');
  } finally {
    handlers.stop();
  }
});

// Двухшаговое принятие (docs/HQ-PRODUCT-SPEC.md): заказ реально принят
// только ПОСЛЕ выбора времени, поэтому «уже обработан» проверяется на клике
// «Принять» по заказу, у которого время уже выбрано.
test('D6: повторный клик "Принять" на уже принятом заказе — "уже обработан", НЕ второй набор cook-time кнопок', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'a2', data: `cook_time:${order.id}:30`, chatId: sent.chatId, messageId: sent.messageId });
    const sentAfterFirst = fakeBot.sentMessages.length;

    await fakeBot.triggerCallbackQuery({ id: 'b', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    assert.equal(fakeBot.sentMessages.length, sentAfterFirst, 'повторный клик не должен был отправить ещё один набор cook-time кнопок');
    const lastEdit = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.equal(lastEdit.text, 'Заказ уже обработан.');
    assert.equal(fakeBot.answeredCallbacks.length, 3, 'каждый клик должен был получить answerCallbackQuery');
  } finally {
    handlers.stop();
  }
});

test('D7: конкурентные клики "Принять" на одном заказе — данные безопасны (ровно один переход), обе callback-обработки завершаются без падения', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    // Реальное принятие происходит на шаге выбора времени (двухшаговое
    // «Принять», docs/HQ-PRODUCT-SPEC.md) — именно его и проверяем на гонку:
    // два сотрудника группы жмут кнопку времени одновременно.
    await Promise.all([
      fakeBot.triggerCallbackQuery({ id: 'a', data: `cook_time:${order.id}:30`, chatId: sent.chatId, messageId: sent.messageId }),
      fakeBot.triggerCallbackQuery({ id: 'b', data: `cook_time:${order.id}:45`, chatId: sent.chatId, messageId: sent.messageId }),
    ]);
    const rows = await db.query('SELECT status, estimated_ready_minutes FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'preparing', 'ровно один реальный переход, данные не повреждены гонкой');
    assert.ok([30, 45].includes(rows[0].estimated_ready_minutes), 'сохранено время ровно одного из двух кликов');
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
    // Принятие теперь двухшаговое — проверяем шаг, который реально меняет
    // статус (cook_time), иначе тест не проверял бы ничего.
    await fakeBot.triggerCallbackQuery({ id: 'foreign', data: `cook_time:${order.id}:30`, chatId: 'chat-совсем-другого-ресторана', messageId: 1 });
    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'preparing', 'принято "чужим" чатом — известный, унаследованный от SQLite-оригинала пробел (нет проверки владения), не Stage 3');
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
      { text: '✓ Плов', callback_data: `toggle_item:${item.id}` },
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
    // Stage 29.1, п.4: подтверждение паузы теперь несёт кнопку "Открыть
    // ресторан" — не нужно помнить /open (fallback остаётся рабочим).
    assert.equal(fakeBot.editedMessages[0].text, 'Перерыв: 33 мин. Вернуться раньше срока — кнопкой ниже (или /open).');
    assert.deepEqual(fakeBot.editedMessages[0].opts.reply_markup.inline_keyboard, [[
      { text: 'Открыть ресторан', callback_data: 'reopen_now' },
    ]]);

    await fakeBot.triggerText('chat-pause', '/open');
    rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 1);
    assert.equal(rows[0].paused_until, null);
    // /open (команда, fallback) тоже теперь несёт кнопку "Закрыть ресторан".
    const openConfirm = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(openConfirm.text, /снова открыт/);
    assert.deepEqual(openConfirm.opts.reply_markup.inline_keyboard, [[
      { text: 'Закрыть ресторан', callback_data: 'close_menu' },
    ]]);
  } finally {
    handlers.stop();
  }
});

// ===========================================================================
// F. UX fix-stage после Stage 28 (панель статуса, устаревшие кнопки)
// ===========================================================================

test('F1: bare /start у подключённого ОТКРЫТОГО ресторана — постоянная reply-клавиатура (Stage 31, раздел 6) + панель статуса с кнопкой "Закрыть ресторан"', async () => {
  await pgCreateRestaurant({ telegramChatId: 'chat-f1', name: 'Кафе Статус' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-f1', '/start');
    assert.equal(fakeBot.sentMessages.length, 2, 'reply-клавиатура + панель статуса');
    assert.ok(fakeBot.sentMessages[0].opts.reply_markup.keyboard, 'первое сообщение несёт ПОСТОЯННУЮ (не inline) клавиатуру');
    assert.deepEqual(fakeBot.sentMessages[0].opts.reply_markup.keyboard, [[{ text: 'Статус ресторана' }]]);
    assert.match(fakeBot.sentMessages[1].text, /Кафе Статус.*открыт/s);
    assert.doesNotMatch(fakeBot.sentMessages[1].text, /Код подключения/, 'уже подключён — инструкция по коду больше не нужна');
    assert.deepEqual(fakeBot.sentMessages[1].opts.reply_markup.inline_keyboard, [[
      { text: 'Закрыть ресторан', callback_data: 'close_menu' },
    ]]);
  } finally {
    handlers.stop();
  }
});

test('F2: bare /start у подключённого ЗАКРЫТОГО (на паузе) ресторана — панель статуса с кнопкой "Открыть ресторан"', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: 'chat-f2', name: 'Кафе Пауза' });
  await db.execute(`UPDATE restaurants SET is_open = 0, paused_until = NOW() + interval '1 hour' WHERE id = $1`, [restaurant.id]);
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-f2', '/start');
    assert.equal(fakeBot.sentMessages.length, 2, 'reply-клавиатура + панель статуса');
    assert.match(fakeBot.sentMessages[1].text, /Кафе Пауза.*закрыт/s);
    assert.deepEqual(fakeBot.sentMessages[1].opts.reply_markup.inline_keyboard, [[
      { text: 'Открыть ресторан', callback_data: 'reopen_now' },
    ]]);
  } finally {
    handlers.stop();
  }
});

test('F3: close_menu -> тот же выбор длительности, что и /pause; pause:key из этого пути работает штатно', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: 'chat-f3' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerCallbackQuery({ id: '1', data: 'close_menu', chatId: 'chat-f3', messageId: 1 });
    assert.equal(fakeBot.editedMessages.length, 1);
    assert.match(fakeBot.editedMessages[0].text, /На сколько закрыть ресторан/);
    assert.deepEqual(fakeBot.editedMessages[0].opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [
      'pause:short', 'pause:medium', 'pause:long',
    ]);

    await fakeBot.triggerCallbackQuery({ id: '2', data: 'pause:short', chatId: 'chat-f3', messageId: 1 });
    const rows = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 0);
  } finally {
    handlers.stop();
  }
});

test('F4: reopen_now -> ресторан открыт (то же действие, что /open)', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: 'chat-f4' });
  await db.execute(`UPDATE restaurants SET is_open = 0, paused_until = NOW() + interval '1 hour' WHERE id = $1`, [restaurant.id]);
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerCallbackQuery({ id: '1', data: 'reopen_now', chatId: 'chat-f4', messageId: 1 });
    const rows = await db.query('SELECT is_open, paused_until FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 1);
    assert.equal(rows[0].paused_until, null);
    assert.match(fakeBot.editedMessages[0].text, /снова открыт/);
  } finally {
    handlers.stop();
  }
});

test('F5 (Stage 31, раздел 5): автоматический таймаут — РОВНО одно итоговое сообщение (кнопки убраны и финальный текст — один и тот же edit)', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    const sentBeforeSweep = fakeBot.sentMessages.length;
    await backdateOrderResponseWindow(order.id, 10);

    await pgOrderService.sweepTimeouts();
    await handlers.waitForIdle();

    // Ровно один edit — исходное сообщение заказа сразу становится
    // финальным текстом "Вы пропустили...", второго sendMessage больше нет
    // (раньше было два артефакта на одно событие — живая находка Stage 30).
    assert.equal(fakeBot.editedMessages.length, 1);
    assert.match(fakeBot.editedMessages[0].text, /^Вы пропустили заказ .+ — ответа не было 7 минут, заказ автоматически отменён\.$/);
    assert.equal(fakeBot.editedMessages[0].opts.message_id, 1, 'редактируется именно исходное сообщение заказа');
    assert.equal(fakeBot.sentMessages.length, sentBeforeSweep, 'ни одного НОВОГО сообщения на timeout не отправляется');

    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'timed_out');
  } finally {
    handlers.stop();
  }
});

test('F6: ресторан нажал "Принять", но не выбрал время, — таймаут убирает кнопки С СООБЩЕНИЯ ВЫБОРА ВРЕМЕНИ (то же сообщение, отредактированное на шаге "Принять"), а не создаёт новое', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    const sentBeforeAccept = fakeBot.sentMessages.length;
    await fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    // Stage 31, раздел 1.4 — "Принять" больше не шлёт отдельное сообщение с
    // кнопками времени, оно РЕДАКТИРУЕТ то же исходное сообщение — значит
    // "текущее кликабельное" остаётся тем же message_id, что и был.
    assert.equal(fakeBot.sentMessages.length, sentBeforeAccept, 'accept не создаёт новых сообщений, только редактирует');

    await backdateOrderResponseWindow(order.id, 10);
    await pgOrderService.sweepTimeouts();
    await handlers.waitForIdle();

    const lastEdit = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.equal(lastEdit.opts.message_id, sent.messageId, 'таймаут почистил то же (единственное) сообщение заказа');
    assert.match(lastEdit.text, /^Вы пропустили заказ/);
  } finally {
    handlers.stop();
  }
});

test('F7: клиент сам отменил заказ (cancelByCustomer) до ответа ресторана — кнопки убраны, "пропустили заказ" НЕ отправлялось', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order } = await notifyAndGetAcceptDeclineData(fakeBot, handlers);
    await pgOrderService.cancelByCustomer(order.id);
    await handlers.waitForIdle();

    assert.equal(fakeBot.editedMessages.length, 1);
    assert.match(fakeBot.editedMessages[0].text, /отменён клиентом/);
    const missedOrderPing = fakeBot.sentMessages.find((m) => /пропустили заказ/.test(m.text));
    assert.equal(missedOrderPing, undefined, 'отмена клиентом — не таймаут, "пропустили заказ" не по адресу');
  } finally {
    handlers.stop();
  }
});

test('F8: двойной клик advance (Передал курьеру дважды) — второй клик "Заказ уже обработан.", не второй переход', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    const { order, sent } = await notifyAndGetAcceptDeclineData(fakeBot, handlers, { fulfillmentType: 'delivery' });
    await fakeBot.triggerCallbackQuery({ id: 'a', data: `accept:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'b', data: `cook_time:${order.id}:30`, chatId: sent.chatId, messageId: sent.messageId });
    await fakeBot.triggerCallbackQuery({ id: 'c', data: `advance:courier:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });
    const editsAfterFirstAdvance = fakeBot.editedMessages.length;

    // Тот же клик повторно — например, второй сотрудник группы или двойной тап.
    await fakeBot.triggerCallbackQuery({ id: 'c2', data: `advance:courier:${order.id}`, chatId: sent.chatId, messageId: sent.messageId });

    assert.equal(fakeBot.editedMessages.length, editsAfterFirstAdvance + 1);
    assert.equal(fakeBot.editedMessages[fakeBot.editedMessages.length - 1].text, 'Заказ уже обработан.');
    const rows = await db.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].status, 'courier', 'повторный клик не откатил и не продвинул статус дальше');
  } finally {
    handlers.stop();
  }
});

// Stage 29.1, п.2 — orderMessages переехал из in-memory Map в bot_order_messages
// (PostgreSQL): очистка кнопок обязана работать, даже если событие таймаута
// произошло в ДРУГОМ процессе, чем тот, что отправил уведомление (рестарт
// backend между "заказ пришёл" и "заказ просрочен").
test('F9: устойчивость к рестарту — новый процесс (новый createBotHandlers/новый bot-клиент) чистит кнопки заказа, отправленного СТАРЫМ процессом', async () => {
  const oldFakeBot = new FakeTelegramBot();
  const oldHandlers = botModule.createBotHandlers(oldFakeBot);
  let order;
  let sent;
  try {
    ({ order, sent } = await notifyAndGetAcceptDeclineData(oldFakeBot, oldHandlers));
    // Запись messageId в БД — часть handleOrderNew, дожидаемся её так же,
    // как и самой отправки (оба await'ятся внутри одного handler'а).
  } finally {
    // "Рестарт backend": старый процесс останавливается ПОЛНОСТЬЮ — снимает
    // listeners, останавливает polling. bot_order_messages в БД остаётся —
    // в этом и весь смысл переноса из Map в таблицу.
    await oldHandlers.stop();
  }

  const newFakeBot = new FakeTelegramBot(); // "новый процесс" — с нуля, ничего не помнит
  const newHandlers = botModule.createBotHandlers(newFakeBot);
  try {
    await backdateOrderResponseWindow(order.id, 10);
    await pgOrderService.sweepTimeouts();
    await newHandlers.waitForIdle();

    // Кнопки убраны через НОВЫЙ bot-клиент, но с messageId/chatId СТАРОГО
    // сообщения — доказательство, что данные пришли из БД, а не из памяти
    // (у newFakeBot не было ни одного отправленного сообщения до этого момента).
    assert.equal(newFakeBot.editedMessages.length, 1);
    assert.equal(newFakeBot.editedMessages[0].opts.chat_id, sent.chatId);
    assert.equal(newFakeBot.editedMessages[0].opts.message_id, sent.messageId);
    assert.match(newFakeBot.editedMessages[0].text, /^Вы пропустили заказ/);

    // Старый bot-клиент, разумеется, ничего нового не получил — он уже остановлен.
    assert.equal(oldFakeBot.editedMessages.length, 0);
  } finally {
    await newHandlers.stop();
  }
});

// Stage 29.1, п.4 — сквозная проверка: подключение -> пауза -> открытие
// ЦЕЛИКОМ через кнопки, ни разу не набирая /pause или /open вручную (только
// код подключения — единственное, что реально нужно ввести текстом).
test('F10: полный цикл подключение -> закрыть -> открыть ИСКЛЮЧИТЕЛЬНО кнопками, без единой ручной команды /pause или /open', async () => {
  const code = `CODE${uniqueSuffix().toUpperCase()}`;
  const restaurant = await pgCreateRestaurant({ connectCode: code, name: 'Кнопочный ресторан' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    // 1. Единственный текст за весь тест — сам код подключения (его в любом
    // случае некому продиктовать кнопкой, это одноразовый секрет из HQ).
    await fakeBot.triggerText('chat-f10', `/start ${code}`);
    const statusMsg = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(statusMsg.text, /Кнопочный ресторан.*открыт/s);
    const closeBtn = statusMsg.opts.reply_markup.inline_keyboard[0][0];
    assert.equal(closeBtn.callback_data, 'close_menu');

    // 2. "Закрыть ресторан" (панель) -> выбор длительности -> "Открыть
    // ресторан" (прямо из подтверждения паузы) — ни одного /pause, /open.
    await fakeBot.triggerCallbackQuery({ id: '1', data: closeBtn.callback_data, chatId: 'chat-f10', messageId: statusMsg.messageId });
    const durationMsg = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    assert.match(durationMsg.text, /На сколько закрыть ресторан/);
    const shortBtn = durationMsg.opts.reply_markup.inline_keyboard[0][0];
    assert.equal(shortBtn.callback_data, 'pause:short');

    await fakeBot.triggerCallbackQuery({ id: '2', data: shortBtn.callback_data, chatId: 'chat-f10', messageId: statusMsg.messageId });
    let rows = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 0);
    const pausedMsg = fakeBot.editedMessages[fakeBot.editedMessages.length - 1];
    const reopenBtn = pausedMsg.opts.reply_markup.inline_keyboard[0][0];
    assert.equal(reopenBtn.callback_data, 'reopen_now');

    await fakeBot.triggerCallbackQuery({ id: '3', data: reopenBtn.callback_data, chatId: 'chat-f10', messageId: statusMsg.messageId });
    rows = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].is_open, 1, 'ресторан снова открыт — весь цикл пройден без единой ручной команды');
  } finally {
    handlers.stop();
  }
});

test('F11 (Stage 31, раздел 6): постоянная reply-клавиатура — нажатие кнопки "Статус ресторана" открывает актуальную панель БЕЗ команды /start', async () => {
  const restaurant = await pgCreateRestaurant({ telegramChatId: 'chat-f11', name: 'Кафе Клавиатура' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    // Нажатие reply-клавиатуры приходит как обычный текст с текстом кнопки —
    // ни разу не /start.
    await fakeBot.triggerText('chat-f11', 'Статус ресторана');
    assert.equal(fakeBot.sentMessages.length, 1, 'нажатие не пересылает клавиатуру заново — только панель');
    assert.match(fakeBot.sentMessages[0].text, /Кафе Клавиатура.*открыт/s);
    assert.deepEqual(fakeBot.sentMessages[0].opts.reply_markup.inline_keyboard, [[
      { text: 'Закрыть ресторан', callback_data: 'close_menu' },
    ]]);

    // Состояние изменилось НЕ через это же сообщение (например, из HQ) —
    // повторное нажатие обязано показать АКТУАЛЬНОЕ состояние.
    await pgOrderService.pauseRestaurant(restaurant.id, 'short');
    await fakeBot.triggerText('chat-f11', 'Статус ресторана');
    assert.equal(fakeBot.sentMessages.length, 2);
    assert.match(fakeBot.sentMessages[1].text, /закрыт/);
    assert.deepEqual(fakeBot.sentMessages[1].opts.reply_markup.inline_keyboard, [[
      { text: 'Открыть ресторан', callback_data: 'reopen_now' },
    ]]);
  } finally {
    handlers.stop();
  }
});

test('F12 (Stage 31, раздел 6): постоянная reply-клавиатура присылается сразу при подключении по коду', async () => {
  const code = `CODE${uniqueSuffix().toUpperCase()}`;
  await pgCreateRestaurant({ connectCode: code, name: 'Свежее подключение' });
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-f12', `/start ${code}`);
    assert.equal(fakeBot.sentMessages.length, 2, 'подтверждение подключения (с клавиатурой) + панель статуса');
    assert.deepEqual(fakeBot.sentMessages[0].opts.reply_markup.keyboard, [[{ text: 'Статус ресторана' }]]);
    assert.match(fakeBot.sentMessages[0].text, /подключён/);
  } finally {
    handlers.stop();
  }
});

test('F13 (Stage 31, раздел 6): "Статус ресторана" без подключённого ресторана в чате — просит код, не падает', async () => {
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await fakeBot.triggerText('chat-f13-unbound', 'Статус ресторана');
    assert.equal(fakeBot.sentMessages.length, 1);
    assert.match(fakeBot.sentMessages[0].text, /Сначала подключите ресторан/);
  } finally {
    handlers.stop();
  }
});

test('C1b (Stage 31, раздел 3): чек оплаты — отсутствует в сообщении, когда payments.receipt_url пуст (текущий mock-провайдер его никогда не заполняет)', async () => {
  const { order, payment } = await fullyPaidOrder();
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();
    assert.doesNotMatch(fakeBot.sentMessages[0].text, /Чек оплаты/, 'нет безопасного URL — блока в сообщении быть не должно вовсе');
  } finally {
    handlers.stop();
  }
});

test('C1c (Stage 31, раздел 3): чек оплаты — появляется СТРОГО когда payments.receipt_url реально задан', async () => {
  const { order, payment } = await fullyPaidOrder();
  await db.execute(`UPDATE payments SET receipt_url = $1 WHERE id = $2`, ['https://example.yookassa.ru/receipts/abc123', payment.id]);
  const fakeBot = new FakeTelegramBot();
  const handlers = botModule.createBotHandlers(fakeBot);
  try {
    await pgOrderService.markPaid(order.id, payment.id);
    await handlers.waitForIdle();
    assert.match(fakeBot.sentMessages[0].text, /Чек оплаты: https:\/\/example\.yookassa\.ru\/receipts\/abc123/);
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
