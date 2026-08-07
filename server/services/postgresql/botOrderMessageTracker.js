'use strict';

// YAAM — "текущее кликабельное сообщение" заказа (bot_order_messages,
// миграция 0008), вынесено из bot/postgresql/index.js в отдельный модуль
// Stage 31 — botOutboxService.js (раздел 1.2) тоже должен уметь записать
// messageId после успешной отправки order:new, не создавая циклическую
// зависимость botOutboxService <-> bot/postgresql/index.js. Поведение не
// изменилось ни на строку — та же таблица, та же семантика "одна запись
// на заказ, перезаписывается на каждом шаге, удаляется терминально"
// (Stage 29.1, п.2).
const db = require('../../db/postgresql');

async function trackOrderMessage(orderId, chatId, messageId) {
  await db.execute(
    `INSERT INTO bot_order_messages (order_id, chat_id, message_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (order_id) DO UPDATE
       SET chat_id = EXCLUDED.chat_id, message_id = EXCLUDED.message_id, updated_at = NOW()`,
    [orderId, String(chatId), messageId],
  );
}

async function untrackOrderMessage(orderId) {
  await db.execute('DELETE FROM bot_order_messages WHERE order_id = $1', [orderId]);
}

async function getTrackedOrderMessage(orderId) {
  const rows = await db.query('SELECT chat_id, message_id FROM bot_order_messages WHERE order_id = $1', [orderId]);
  if (!rows[0]) return null;
  return { chatId: rows[0].chat_id, messageId: Number(rows[0].message_id) };
}

module.exports = { trackOrderMessage, untrackOrderMessage, getTrackedOrderMessage };
