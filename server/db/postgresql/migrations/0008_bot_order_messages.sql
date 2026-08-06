-- 0008_bot_order_messages — Stage 29.1, п.2.
--
-- Проблема, найденная при проверке устойчивости к рестарту (Stage 28
-- MEDIUM-2, доисправлено в Stage 29): orderMessages в bot/postgresql/index.js
-- жил ТОЛЬКО в памяти процесса (Map orderId -> {chatId, messageId}) —
-- "текущее кликабельное сообщение" заказа, которое таймаут/отмена клиентом
-- редактируют, чтобы убрать устаревшие кнопки. После рестарта backend Map
-- пуст: если заказ получил уведомление ДО рестарта, а истёк/был отменён
-- ПОСЛЕ — новый процесс не знает messageId и не может убрать кнопки со
-- старого сообщения, хотя видит сам факт timed_out/cancelled.
--
-- Решение — тот же принцип, что уже используется по всему проекту для
-- "текущего состояния, которое обязано пережить рестарт" (см. orders,
-- restaurants.paused_until и т.п.): маленькая отдельная таблица вместо
-- in-memory Map. Ровно одна строка на заказ (PRIMARY KEY = order_id),
-- перезаписывается на каждом шаге (accept -> выбор времени), удаляется при
-- терминальном действии — тот же lifecycle, что был у Map-записи, только
-- переживает рестарт процесса.
CREATE TABLE IF NOT EXISTS bot_order_messages (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
