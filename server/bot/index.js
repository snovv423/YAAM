const { TelegramBot } = require('node-telegram-bot-api');
const db = require('../db');
const orderService = require('../services/orderService');

const PAUSE_LABELS = { short: '33 мин', medium: '3 часа', long: '11 часов' };

function startBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  const restaurantByChat = (chatId) =>
    db.prepare('SELECT * FROM restaurants WHERE telegram_chat_id = ?').get(String(chatId));

  // --- Подключение ресторана по коду ---
  bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const code = (match[1] || '').trim().toUpperCase();
    if (!code) {
      return bot.sendMessage(msg.chat.id,
        'Здравствуйте! Это бот YAAM для ресторанов.\n' +
        'Код подключения выдаёт команда YAAM при добавлении вашего ресторана в админке — пришлите его командой:\n/start ВАШКОД');
    }
    const restaurant = db.prepare('SELECT * FROM restaurants WHERE connect_code = ?').get(code);
    if (!restaurant) return bot.sendMessage(msg.chat.id, 'Код не найден. Проверьте и попробуйте снова.');
    db.prepare('UPDATE restaurants SET telegram_chat_id = ? WHERE id = ?').run(String(msg.chat.id), restaurant.id);
    bot.sendMessage(msg.chat.id, `Готово! «${restaurant.name}» подключён. Сюда будут приходить новые заказы.`);
  });

  // Перерыв — не мгновенное выключение, а выбор одного из трёх пресетов;
  // снимается сам по истечении (orderService.sweepPauseExpiry).
  bot.onText(/\/pause/, (msg) => {
    const r = restaurantByChat(msg.chat.id);
    if (!r) return bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
    bot.sendMessage(msg.chat.id, 'На сколько уйти на перерыв?', {
      reply_markup: {
        inline_keyboard: [Object.keys(PAUSE_LABELS).map((key) => ({
          text: PAUSE_LABELS[key], callback_data: `pause:${key}`,
        }))],
      },
    });
  });
  bot.onText(/\/open/, (msg) => {
    const r = restaurantByChat(msg.chat.id);
    if (!r) return bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
    orderService.resumeRestaurant(r.id);
    bot.sendMessage(msg.chat.id, `«${r.name}» снова открыт.`);
  });

  bot.onText(/\/stoplist/, (msg) => {
    const r = restaurantByChat(msg.chat.id);
    if (!r) return bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
    const items = db.prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY sort_order').all(r.id);
    if (!items.length) return bot.sendMessage(msg.chat.id, 'В меню пока нет блюд.');
    bot.sendMessage(msg.chat.id, 'Нажмите на блюдо, чтобы поставить/снять со стоп-листа:', {
      reply_markup: {
        inline_keyboard: items.map((i) => [{
          text: `${i.is_available ? '✅' : '🚫'} ${i.name}`,
          callback_data: `toggle_item:${i.id}`,
        }]),
      },
    });
  });

  // --- Уведомление о новом заказе ---
  orderService.orderEvents.on('order:new', (order) => {
    const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(order.restaurant_id);
    if (!restaurant || !restaurant.telegram_chat_id) {
      console.error(`[bot] заказ ${order.public_code}: у ресторана "${restaurant?.name}" не подключён Telegram`);
      return;
    }
    const itemsList = order.items.map((i) => `${i.qty} × ${i.name} — ${i.price * i.qty} ₽`).join('\n');
    // Самовывоз — ресторан и так знает свой адрес, курьера ждать не нужно;
    // строку "Адрес" показываем только для доставки.
    const fulfillmentLine = order.fulfillment_type === 'pickup'
      ? '🏃 Самовывоз (курьер не нужен)'
      : `🛵 Доставка\nАдрес: ${order.address}`;
    const text = `🆕 Новый заказ ${order.public_code}\n\n${itemsList}\n\nИтого: ${order.items_total} ₽\n${fulfillmentLine}\nТелефон: ${order.customer_phone}\nКомментарий: ${order.comment || '—'}\n\nОтветьте в течение 3 минут, иначе заказ отменится автоматически.`;
    bot.sendMessage(restaurant.telegram_chat_id, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Принять', callback_data: `accept:${order.id}` },
          { text: '❌ Отклонить', callback_data: `decline:${order.id}` },
        ]],
      },
    });
  });

  // --- Кнопки ---
  bot.on('callback_query', async (query) => {
    const parts = query.data.split(':');
    const action = parts[0];
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    try {
      if (action === 'accept') {
        const orderId = Number(parts[1]);
        orderService.restaurantAccept(orderId);
        await bot.editMessageText(`✅ Заказ принят.`, { chat_id: chatId, message_id: messageId });
        await sendCookTimeButtons(bot, chatId, orderId);
      } else if (action === 'decline') {
        const orderId = Number(parts[1]);
        await orderService.restaurantDecline(orderId);
        await bot.editMessageText(`❌ Заказ отклонён, деньги клиенту возвращены.`, { chat_id: chatId, message_id: messageId });
      } else if (action === 'cook_time') {
        // cook_time:orderId:minutes — ресторан выбрал время на шаге "Готовится"
        const orderId = Number(parts[1]);
        const minutes = Number(parts[2]);
        orderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: minutes });
        await bot.editMessageText(`Готовится — клиенту показано «~${minutes} мин».`, { chat_id: chatId, message_id: messageId });
        await sendProgressButton(bot, chatId, orderId, 'preparing');
      } else if (action === 'advance') {
        // advance:nextStatus:orderId (courier -> delivered, или preparing -> delivered напрямую для самовывоза)
        const nextStatus = parts[1];
        const orderId = Number(parts[2]);
        const updated = orderService.restaurantAdvance(orderId, nextStatus);
        const labels = updated.fulfillment_type === 'pickup'
          ? { delivered: 'Клиент забрал' }
          : { courier: 'Передал курьеру', delivered: 'Доставлен' };
        await bot.editMessageText(`Статус обновлён: ${labels[nextStatus]}`, { chat_id: chatId, message_id: messageId });
        if (nextStatus !== 'delivered') await sendProgressButton(bot, chatId, orderId, nextStatus);
      } else if (action === 'pause') {
        const r = restaurantByChat(chatId);
        if (r) {
          orderService.pauseRestaurant(r.id, parts[1]);
          await bot.editMessageText(`Перерыв: ${PAUSE_LABELS[parts[1]]}. /open — вернуться раньше срока.`, { chat_id: chatId, message_id: messageId });
        }
      } else if (action === 'toggle_item') {
        const id = Number(parts[1]);
        const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
        if (item) db.prepare('UPDATE menu_items SET is_available = 1 - is_available WHERE id = ?').run(id);
      }
      bot.answerCallbackQuery(query.id);
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: `Ошибка: ${err.message}`, show_alert: true });
    }
  });

  // Три варианта времени готовки относительно своего времени ресторана
  // (default_cook_minutes из админки) — не одно фиксированное число на всех.
  async function sendCookTimeButtons(botInstance, chatId, orderId) {
    const order = orderService.getOrder(orderId);
    const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(order.restaurant_id);
    const base = restaurant.default_cook_minutes || 40;
    const options = [Math.max(10, base - 10), base, base + 15];
    await botInstance.sendMessage(chatId, `Заказ ${order.public_code}: сколько времени на готовку?`, {
      reply_markup: {
        inline_keyboard: [options.map((m) => ({ text: `~${m} мин`, callback_data: `cook_time:${orderId}:${m}` }))],
      },
    });
  }

  async function sendProgressButton(botInstance, chatId, orderId, currentStatus) {
    const order = orderService.getOrder(orderId);
    const isPickup = order.fulfillment_type === 'pickup';
    const nextMap = isPickup ? { preparing: 'delivered' } : { preparing: 'courier', courier: 'delivered' };
    const labelMap = isPickup ? { delivered: 'Клиент забрал' } : { courier: 'Передал курьеру', delivered: 'Доставлен' };
    const next = nextMap[currentStatus];
    if (!next) return;
    await botInstance.sendMessage(chatId, `Заказ ${order.public_code}: когда будет готово, нажмите ниже.`, {
      reply_markup: { inline_keyboard: [[{ text: labelMap[next], callback_data: `advance:${next}:${orderId}` }]] },
    });
  }

  bot.on('polling_error', (err) => console.error('[bot] polling error:', err.message));

  console.log('[bot] запущен (long polling)');
  return bot;
}

module.exports = { startBot };
