'use strict';

// YAAM — PostgreSQL bot, Production Switch Stage 3 (изолированный порт).
//
// Этот модуль НЕ импортируется ни из server.js, ни из bot/index.js (SQLite) —
// та же архитектурная граница, что у routes/postgresql/api.js (Stage 1) и
// services/postgresql/orderService.js (Wave 1-7 + Stage 1/2). SQLite-бот
// (server/bot/index.js) остаётся полностью нетронутым и единственным,
// реально подключённым к server.js. Этот модуль не открывает SQLite
// DatabaseSync ни прямо, ни как побочный эффект require() — не импортирует
// server/db/index.js, server/services/orderService.js (SQLite) и
// server/services/orderAccessService.js.
//
// Разрешённый доступ к данным — только PostgreSQL: db.query()/db.execute()
// (server/db/postgresql/index.js) для ресторанов/меню (тот же архитектурный
// контур, что и в SQLite-оригинале — эти запросы никогда не проходили через
// orderService.js даже там, см. Stage 1 doc) и уже перенесённые функции
// server/services/postgresql/orderService.js (restaurantAccept/
// restaurantDecline/restaurantAdvance/getOrder/pauseRestaurant/
// resumeRestaurant — последние две добавлены этим же коммитом, см. комментарий
// "Production Switch — Stage 3" в orderService.js).
//
// Тексты, callback_data, эмодзи, порядок операций — дословная копия
// SQLite-оригинала (server/bot/index.js), без единого продуктового
// изменения. Единственные намеренные, документированные адаптации (обе —
// в разделе "Production Switch — Stage 3" ниже):
//   1. Все SQLite-синхронные вызовы заменены на await db.query()/
//      db.execute()/orderService-функции (неизбежное следствие асинхронного
//      pg-драйвера, не изменение бизнес-логики).
//   2. accept/decline получили pre-check текущего статуса заказа ПЕРЕД
//      мутацией — SQLite-оригинал этого не делает (слепо вызывает
//      restaurantAccept/restaurantDecline и всегда показывает "успех",
//      даже если это был тихий no-op) — сохранение этого поведения означало
//      бы дублирующее уведомление "выберите время готовки" на повторный
//      клик, что задание явно просит предотвратить ("защита от повторного
//      клика", "обработка уже изменённого статуса"). advance/cook_time
//      такой правки не требуют — restaurantAdvance() уже бросает на
//      недопустимом переходе, что и так предотвращает повторное
//      уведомление через существующий catch-блок, тем же принципом, что и
//      SQLite-оригинал.
//
// Тестируемость (тестовое окружение НЕ должно требовать реального Telegram
// token/сети): createBotHandlers(bot) принимает УЖЕ созданный bot-подобный
// клиент (реальный TelegramBot ИЛИ тестовый fake-double с тем же
// подмножеством API — onText/on/sendMessage/editMessageText/
// answerCallbackQuery) и только навешивает обработчики — не создаёт клиент
// сам. startBot(token) — обычная production-точка входа, создаёт настоящий
// TelegramBot с long polling и делегирует в createBotHandlers(), сохраняя
// тот же внешний контракт, что и SQLite startBot(token).

const { TelegramBot } = require('node-telegram-bot-api');
const db = require('../../db/postgresql');
const pgOrderService = require('../../services/postgresql/orderService');

const PAUSE_LABELS = { short: '33 мин', medium: '3 часа', long: '11 часов' };

// ---------------------------------------------------------------------------
// Прямые PostgreSQL-запросы ресторанов/меню — тот же архитектурный контур,
// что и routes/postgresql/api.js: не проходят через orderService.js.
// ---------------------------------------------------------------------------

async function restaurantByChat(chatId) {
  const rows = await db.query('SELECT * FROM restaurants WHERE telegram_chat_id = $1', [String(chatId)]);
  return rows[0] || null;
}

async function restaurantByConnectCode(code) {
  const rows = await db.query('SELECT * FROM restaurants WHERE connect_code = $1', [code]);
  return rows[0] || null;
}

async function restaurantById(id) {
  const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  return rows[0] || null;
}

async function menuItemsByRestaurant(restaurantId) {
  return db.query('SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order', [restaurantId]);
}

async function menuItemById(id) {
  const rows = await db.query('SELECT * FROM menu_items WHERE id = $1', [id]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// order:new — уведомление ресторана о новом оплаченном заказе
// ---------------------------------------------------------------------------
//
// Payload — форма Stage 2 (services/postgresql/orderService.js getOrder()),
// дословно совместимая с SQLite (см. eventLayerStage2.test.js parity-тест).
// Обёрнут вызывающей стороной (createBotHandlers) в .catch(), чтобы ошибка
// Telegram-отправки ОДНОГО уведомления не превращалась в необработанное
// отклонение промиса и не мешала обработке СЛЕДУЮЩИХ событий — то же самое
// требование, что и явно сформулировано в задании Stage 3 ("ошибка одного
// уведомления не ломает event emitter и последующие события"). SQLite-
// оригинал этой защиты не имеет (голый bot.sendMessage(...) без await/catch
// внутри синхронного listener'а) — минимальная, документированная адаптация
// под более сетевой (более failure-prone) PostgreSQL/async-путь, продуктовая
// семантика (текст, кнопки, условия) не меняется.
async function handleOrderNew(bot, order) {
  const restaurant = await restaurantById(order.restaurant_id);
  if (!restaurant || !restaurant.telegram_chat_id) {
    console.error(`[bot/postgresql] заказ ${order.public_code}: у ресторана "${restaurant?.name}" не подключён Telegram`);
    return;
  }
  const itemsList = order.items.map((i) => `${i.qty} × ${i.name} — ${i.price * i.qty} ₽`).join('\n');
  const fulfillmentLine = order.fulfillment_type === 'pickup'
    ? '🏃 Самовывоз (курьер не нужен)'
    : `🛵 Доставка\nАдрес: ${order.address}`;
  const text = `🆕 Новый заказ ${order.public_code}\n\n${itemsList}\n\nИтого: ${order.items_total} ₽\n${fulfillmentLine}\nТелефон: ${order.customer_phone}\nКомментарий: ${order.comment || '—'}\n\nОтветьте в течение 3 минут, иначе заказ отменится автоматически.`;
  await bot.sendMessage(restaurant.telegram_chat_id, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Принять', callback_data: `accept:${order.id}` },
        { text: '❌ Отклонить', callback_data: `decline:${order.id}` },
      ]],
    },
  });
}

// Три варианта времени готовки относительно своего времени ресторана
// (default_cook_minutes из админки) — не одно фиксированное число на всех.
async function sendCookTimeButtons(bot, chatId, orderId) {
  const order = await pgOrderService.getOrder(orderId);
  const restaurant = await restaurantById(order.restaurant_id);
  const base = restaurant.default_cook_minutes || 40;
  const options = [Math.max(10, base - 10), base, base + 15];
  await bot.sendMessage(chatId, `Заказ ${order.public_code}: сколько времени на готовку?`, {
    reply_markup: {
      inline_keyboard: [options.map((m) => ({ text: `~${m} мин`, callback_data: `cook_time:${orderId}:${m}` }))],
    },
  });
}

async function sendProgressButton(bot, chatId, orderId, currentStatus) {
  const order = await pgOrderService.getOrder(orderId);
  const isPickup = order.fulfillment_type === 'pickup';
  const nextMap = isPickup ? { preparing: 'delivered' } : { preparing: 'courier', courier: 'delivered' };
  const labelMap = isPickup ? { delivered: 'Клиент забрал' } : { courier: 'Передал курьеру', delivered: 'Доставлен' };
  const next = nextMap[currentStatus];
  if (!next) return;
  await bot.sendMessage(chatId, `Заказ ${order.public_code}: когда будет готово, нажмите ниже.`, {
    reply_markup: { inline_keyboard: [[{ text: labelMap[next], callback_data: `advance:${next}:${orderId}` }]] },
  });
}

// ---------------------------------------------------------------------------
// Кнопки (callback_query)
// ---------------------------------------------------------------------------
async function handleCallbackQuery(bot, query) {
  const parts = query.data.split(':');
  const action = parts[0];
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  try {
    if (action === 'accept') {
      const orderId = Number(parts[1]);
      const current = await pgOrderService.getOrder(orderId);
      if (!current) {
        await bot.editMessageText('Заказ не найден.', { chat_id: chatId, message_id: messageId });
      } else if (current.status !== 'awaiting_restaurant') {
        // Повторный клик по старой кнопке/replay после смены статуса другим
        // событием — см. header-комментарий модуля, адаптация п.2.
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
      } else {
        await pgOrderService.restaurantAccept(orderId);
        await bot.editMessageText(`✅ Заказ принят.`, { chat_id: chatId, message_id: messageId });
        await sendCookTimeButtons(bot, chatId, orderId);
      }
    } else if (action === 'decline') {
      const orderId = Number(parts[1]);
      const current = await pgOrderService.getOrder(orderId);
      if (!current) {
        await bot.editMessageText('Заказ не найден.', { chat_id: chatId, message_id: messageId });
      } else if (current.status !== 'awaiting_restaurant') {
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
      } else {
        await pgOrderService.restaurantDecline(orderId);
        await bot.editMessageText(`❌ Заказ отклонён, деньги клиенту возвращены.`, { chat_id: chatId, message_id: messageId });
      }
    } else if (action === 'cook_time') {
      // cook_time:orderId:minutes — ресторан выбрал время на шаге "Готовится"
      const orderId = Number(parts[1]);
      const minutes = Number(parts[2]);
      await pgOrderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: minutes });
      await bot.editMessageText(`Готовится — клиенту показано «~${minutes} мин».`, { chat_id: chatId, message_id: messageId });
      await sendProgressButton(bot, chatId, orderId, 'preparing');
    } else if (action === 'advance') {
      // advance:nextStatus:orderId (courier -> delivered, или preparing -> delivered напрямую для самовывоза)
      const nextStatus = parts[1];
      const orderId = Number(parts[2]);
      const updated = await pgOrderService.restaurantAdvance(orderId, nextStatus);
      const labels = updated.fulfillment_type === 'pickup'
        ? { delivered: 'Клиент забрал' }
        : { courier: 'Передал курьеру', delivered: 'Доставлен' };
      await bot.editMessageText(`Статус обновлён: ${labels[nextStatus]}`, { chat_id: chatId, message_id: messageId });
      if (nextStatus !== 'delivered') await sendProgressButton(bot, chatId, orderId, nextStatus);
    } else if (action === 'pause') {
      const r = await restaurantByChat(chatId);
      if (r) {
        await pgOrderService.pauseRestaurant(r.id, parts[1]);
        await bot.editMessageText(`Перерыв: ${PAUSE_LABELS[parts[1]]}. /open — вернуться раньше срока.`, { chat_id: chatId, message_id: messageId });
      }
    } else if (action === 'toggle_item') {
      const id = Number(parts[1]);
      const item = await menuItemById(id);
      if (item) await db.execute('UPDATE menu_items SET is_available = 1 - is_available WHERE id = $1', [id]);
    }
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    await bot.answerCallbackQuery(query.id, { text: `Ошибка: ${err.message}`, show_alert: true });
  }
}

// ---------------------------------------------------------------------------
// createBotHandlers(bot) — навешивает обработчики на УЖЕ созданный
// bot-подобный клиент (реальный TelegramBot или тестовый fake-double).
// Не создаёт клиент сам — см. header-комментарий модуля про тестируемость.
// ---------------------------------------------------------------------------
function createBotHandlers(bot) {
  // Node EventEmitter.emit() не ждёт async-слушателей (ни настоящий
  // node-telegram-bot-api, ни pgOrderService.orderEvents тут не исключение)
  // — вызывающий markPaid()/etc. код резолвится, как только emit() вернул
  // управление, а не когда фактическая отправка в Telegram завершилась.
  // inFlight/waitForIdle() — тестовый (и только тестовый) хук, позволяющий
  // детерминированно дождаться завершения асинхронной обработки конкретного
  // order:new вместо polling/sleep в тестах; в production никем не
  // вызывается и не меняет поведение.
  const inFlight = new Set();
  const onOrderNew = (order) => {
    const p = handleOrderNew(bot, order)
      .catch((err) => {
        console.error(`[bot/postgresql] order:new handler failed for order ${order && order.public_code}:`, err.message);
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  };
  pgOrderService.orderEvents.on('order:new', onOrderNew);

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    try {
      const code = (match[1] || '').trim().toUpperCase();
      if (!code) {
        await bot.sendMessage(msg.chat.id,
          'Здравствуйте! Это бот YAAM для ресторанов.\n' +
          'Код подключения выдаёт команда YAAM при добавлении вашего ресторана в админке — пришлите его командой:\n/start ВАШКОД');
        return;
      }
      const restaurant = await restaurantByConnectCode(code);
      if (!restaurant) {
        await bot.sendMessage(msg.chat.id, 'Код не найден. Проверьте и попробуйте снова.');
        return;
      }
      await db.execute('UPDATE restaurants SET telegram_chat_id = $1 WHERE id = $2', [String(msg.chat.id), restaurant.id]);
      await bot.sendMessage(msg.chat.id, `Готово! «${restaurant.name}» подключён. Сюда будут приходить новые заказы.`);
    } catch (err) {
      console.error('[bot/postgresql] /start failed:', err.message);
    }
  });

  // Перерыв — не мгновенное выключение, а выбор одного из трёх пресетов;
  // снимается сам по истечении (server.js setInterval -> sweepPauseExpiry,
  // вне scope этого изолированного bot-модуля).
  bot.onText(/\/pause/, async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      await bot.sendMessage(msg.chat.id, 'На сколько уйти на перерыв?', {
        reply_markup: {
          inline_keyboard: [Object.keys(PAUSE_LABELS).map((key) => ({
            text: PAUSE_LABELS[key], callback_data: `pause:${key}`,
          }))],
        },
      });
    } catch (err) {
      console.error('[bot/postgresql] /pause failed:', err.message);
    }
  });

  bot.onText(/\/open/, async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      await pgOrderService.resumeRestaurant(r.id);
      await bot.sendMessage(msg.chat.id, `«${r.name}» снова открыт.`);
    } catch (err) {
      console.error('[bot/postgresql] /open failed:', err.message);
    }
  });

  bot.onText(/\/stoplist/, async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      const items = await menuItemsByRestaurant(r.id);
      if (!items.length) {
        await bot.sendMessage(msg.chat.id, 'В меню пока нет блюд.');
        return;
      }
      await bot.sendMessage(msg.chat.id, 'Нажмите на блюдо, чтобы поставить/снять со стоп-листа:', {
        reply_markup: {
          inline_keyboard: items.map((i) => [{
            text: `${i.is_available ? '✅' : '🚫'} ${i.name}`,
            callback_data: `toggle_item:${i.id}`,
          }]),
        },
      });
    } catch (err) {
      console.error('[bot/postgresql] /stoplist failed:', err.message);
    }
  });

  // Возвращает промис (не { }-блок) — нужно тестам, вызывающим этот
  // listener напрямую (см. FakeTelegramBot.triggerCallbackQuery), чтобы
  // детерминированно дождаться завершения обработки без polling/sleep;
  // реальный node-telegram-bot-api это значение просто игнорирует (тот же
  // fire-and-forget, что и everywhere else в этом модуле/оригинале).
  bot.on('callback_query', (query) =>
    handleCallbackQuery(bot, query).catch((err) => {
      console.error('[bot/postgresql] callback_query handler failed:', err.message);
    })
  );

  bot.on('polling_error', (err) => console.error('[bot/postgresql] polling error:', err.message));

  console.log('[bot/postgresql] запущен (long polling)');

  return {
    bot,
    async stop() {
      pgOrderService.orderEvents.removeListener('order:new', onOrderNew);
      if (typeof bot.stopPolling === 'function') {
        await bot.stopPolling({ cancel: true, reason: 'YAAM graceful shutdown' });
      }
    },
    // Тестовый хук — см. комментарий у объявления inFlight выше.
    async waitForIdle() {
      await Promise.all([...inFlight]);
    },
  };
}

// Production-точка входа — тот же внешний контракт, что и SQLite startBot(token).
// options.bot — только для тестов (см. header-комментарий); production-вызов
// всегда передаёт только token.
function startBot(token, options = {}) {
  const bot = options.bot || new TelegramBot(token, { polling: true });
  return createBotHandlers(bot);
}

module.exports = { startBot, createBotHandlers };
