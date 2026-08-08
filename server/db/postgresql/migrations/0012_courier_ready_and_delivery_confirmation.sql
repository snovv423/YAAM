-- 0012_courier_ready_and_delivery_confirmation — Stage 33.
--
-- Задание: разделить два разных события, которые раньше были одним шагом
-- «Готовится -> Передал курьеру» — момент, когда еда физически готова
-- (кухня закончила), и момент, когда курьер её физически забрал. Плюс:
-- ресторан больше не имеет права сам отмечать заказ "доставлен" (см.
-- orderService.js restaurantAdvance/confirmReceiptByCustomer) — это решает
-- либо клиент нажатием «Заказ получен», либо серверный auto-complete по
-- истечении COURIER_AUTO_COMPLETE_SEC (6 часов), если клиент забыл нажать.
--
-- Изменение 1 — новый статус 'ready' ("Заказ готов, ожидает курьера") в
-- уже существующем CHECK orders.status (см. schema.sql: "Ровно 10
-- допустимых значений — идентично CHECK в SQLite-версии" — здесь 11-е,
-- сознательное расхождение, задание прямо требует новый статус ТОЛЬКО на
-- PostgreSQL-стороне, SQLite legacy-путь не трогаем). Constraint без явного
-- имени в CREATE TABLE получает от PostgreSQL имя по умолчанию
-- "orders_status_check" — тот же приём, что уже использован в 0006 для
-- payout_attempts_method_check (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT
-- с тем же именем). DROP CONSTRAINT не входит в DESTRUCTIVE_PATTERNS
-- migrator.js (только DROP TABLE/COLUMN/DATABASE/SCHEMA) — маркер
-- yaam:allow-destructive не требуется, тем же самым уже доказано 0006.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'ready', 'courier',
    'delivered', 'payment_failed', 'declined', 'timed_out', 'cancelled'
  ));

-- Изменение 2 — минимальное поле для наблюдаемости (задание, раздел 7):
-- "если архитектура требует минимальный способ зафиксировать источник
-- завершения — используй существующий event-слой или минимальное
-- поле/метаданные". Публичный API/клиент это поле НИКОГДА не читает
-- (toPublicOrderDTO его не включает — см. orderService.js) — статус
-- заказа для клиента остаётся ровно 'delivered' в обоих случаях, только
-- HQ (server/hq/restaurantsViews.js) показывает его для внутреннего
-- наблюдения "клиент подтвердил / система закрыла по таймауту". NULL —
-- законное значение для заказов, доставленных до этой миграции, и для
-- pickup-заказов (там ресторан по-прежнему сам отмечает "Клиент забрал"
-- напрямую — см. STAGE33 отчёт, раздел про pickup).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_via TEXT
  CHECK (delivered_via IS NULL OR delivered_via IN ('customer_confirmed', 'auto_timeout'));
