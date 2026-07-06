const { TelegramBot } = require('node-telegram-bot-api');
const db = require('../db');
const orderService = require('../services/orderService');

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

  bot.onText(/\/pause/, (msg) => {
    const r = restaurantByChat(msg.chat.id);
    if (!r) return bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
    db.prepare('UPDATE restaurants SET is_open = 0 WHERE id = ?').run(r.id);
    bot.sendMessage(msg.chat.id, `«${r.name}» поставлен на паузу — новые заказы не приходят. /open чтобы снова открыться.`);
  });
  bot.onText(/\/open/, (msg) => {
    const r = restaurantByChat(msg.chat.id);
    if (!r) return bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
    db.prepare('UPDATE restaurants SET is_open = 1 WHERE id = ?').run(r.id);
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
    const text = `🆕 Новый заказ ${order.public_code}\n\n${itemsList}\n\nИтого: ${order.items_total} ₽\nАдрес: ${order.address}\nТелефон: ${order.customer_phone}\nКомментарий: ${order.comment || '—'}\n\nОтветьте в течение 3 минут, иначе заказ отменится автоматически.`;
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
    // accept/decline/toggle_item: "action:id" — id = parts[1]
    // advance: "advance:nextStatus:orderId" — три части
    const id = Number(parts[1]);
    try {
      if (action === 'accept') {
        orderService.restaurantAccept(id);
        await bot.editMessageText(`✅ Заказ принят.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await sendProgressButtons(bot, query.message.chat.id, id, 'preparing');
      } else if (action === 'decline') {
        await orderService.restaurantDecline(id);
        await bot.editMessageText(`❌ Заказ отклонён, деньги клиенту возвращены.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
      } else if (action === 'advance') {
        const nextStatus = parts[1];
        const orderId = Number(parts[2]);
        orderService.restaurantAdvance(orderId, nextStatus);
        const labels = { preparing: 'Готовится', courier: 'Передал курьеру', delivered: 'Доставлен' };
        await bot.editMessageText(`Статус обновлён: ${labels[nextStatus]}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        if (nextStatus !== 'delivered') await sendProgressButtons(bot, query.message.chat.id, orderId, nextStatus);
      } else if (action === 'toggle_item') {
        const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
        if (item) db.prepare('UPDATE menu_items SET is_available = 1 - is_available WHERE id = ?').run(id);
      }
      bot.answerCallbackQuery(query.id);
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: `Ошибка: ${err.message}`, show_alert: true });
    }
  });

  async function sendProgressButtons(botInstance, chatId, orderId, currentStatus) {
    const nextMap = { preparing: 'courier', courier: 'delivered' };
    const labelMap = { courier: 'Передал курьеру', delivered: 'Доставлен' };
    const next = nextMap[currentStatus];
    if (!next) return;
    await botInstance.sendMessage(chatId, `Заказ ${orderId}: когда будет готово, нажмите ниже.`, {
      reply_markup: { inline_keyboard: [[{ text: labelMap[next], callback_data: `advance:${next}:${orderId}` }]] },
    });
  }

  bot.on('polling_error', (err) => console.error('[bot] polling error:', err.message));

  console.log('[bot] запущен (long polling)');
  return bot;
}

module.exports = { startBot };
