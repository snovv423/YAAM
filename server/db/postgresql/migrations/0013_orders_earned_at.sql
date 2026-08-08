-- 0013_orders_earned_at — Stage 33.1.
--
-- ПРОБЛЕМА (найдена при приёмке Stage 33, до commit/push/deploy): финансовый
-- расчёт ресторана (services/hq/restaurantFinanceService.js,
-- EARNED_ORDER_FILTER_SQL + pushRangeConditions) использовал
-- orders.status_updated_at как якорь расчётного периода для 'delivered'
-- заказов. До Stage 33 это было корректно — 'delivered' был исключительно
-- ресторанным действием (одна кнопка в Telegram). Stage 33 разделила
-- ready -> courier (ресторан) и courier -> delivered (КЛИЕНТ, кнопка «Заказ
-- получен», либо auto-complete через 6 часов) — после чего status_updated_at
-- заказа в 'delivered' стал зависеть от того, когда (и нажал ли вообще)
-- клиент кнопку. Один и тот же заказ, переданный курьеру в 23:58 воскресенья,
-- мог попасть в РАЗНЫЕ расчётные недели в зависимости от момента клика —
-- нарушение принятого в Stage 33 правила финансовой независимости клиента.
--
-- РЕШЕНИЕ: новая неизменяемая колонка orders.earned_at — момент, когда
-- РЕСТОРАН физически завершил свою операционную работу по заказу:
--   - delivery: ready -> courier («Передал курьеру»);
--   - pickup:   preparing -> delivered («Клиент забрал») — тот же принцип,
--     курьера у pickup нет, это стопроцентно ресторанное действие.
-- Устанавливается АТОМАРНО внутри orderService.restaurantAdvance() тем же
-- UPDATE, что двигает status, и после этого НИКОГДА не переписывается —
-- ни confirmReceiptByCustomer(), ни autoCompleteCourierOrders() её не
-- трогают (см. services/postgresql/orderService.js).
--
-- Существующей подходящей колонки нет (проверено — orders хранит только
-- status_updated_at/created_at/preparation_deadline, ни одна не подходит
-- как стабильный якорь), поэтому это генуинно новая колонка, не дубликат.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS earned_at TIMESTAMPTZ;

-- Backfill для уже существующих delivered-заказов (созданных ДО Stage 33.1,
-- в том числе созданных ДО Stage 33): для них status_updated_at на момент
-- 'delivered' ГАРАНТИРОВАННО было установлено ресторанным действием — либо
-- старым restaurantAdvance(courier->delivered) для delivery (до Stage 33),
-- либо restaurantAdvance(preparing->delivered) для pickup (не менялось), —
-- то есть тем же самым событием, которое теперь означает earned_at. Значит
-- status_updated_at этих строк — семантически корректный earned_at, а не
-- приближение. WHERE earned_at IS NULL — идемпотентно на повторном запуске
-- миграции (adopt-путь на уже существующей базе).
UPDATE orders SET earned_at = status_updated_at
  WHERE status = 'delivered' AND earned_at IS NULL;

-- Backfill для уже существующих delivery-заказов в статусе 'courier',
-- созданных ДО Stage 33.1 (найдено при pre-deploy проверке этой же
-- миграции). Ресторан у такого заказа УЖЕ передал его курьеру — то есть уже
-- выполнил ту самую операционную работу, которую earned_at обязан отмечать
-- (см. комментарий в начале файла). Без этого backfill такой заказ:
--   1) сразу после миграции исчезает из EARNED_ORDER_FILTER_SQL
--      (services/hq/restaurantFinanceService.js: earned_at IS NOT NULL) —
--      ресторан временно "теряет" уже переданный курьеру заказ из расчёта;
--   2) НАВСЕГДА остаётся без earned_at даже после courier -> delivered,
--      потому что ни confirmReceiptByCustomer(), ни
--      autoCompleteCourierOrders() (services/postgresql/orderService.js)
--      earned_at не устанавливают — к моменту их вызова это уже сделано
--      восходящим переходом ready -> courier, который для таких старых
--      заказов уже прошёл ДО миграции.
--
-- Источник значения — status_updated_at, тем же принципом, что и для
-- 'delivered' выше: ADVANCE_MAP.delivery (orderService.js) даёт РОВНО один
-- переход, ведущий В статус 'courier' — restaurantAdvance(ready->courier),
-- который атомарно устанавливает status_updated_at = NOW() тем же UPDATE.
-- Единственные операции, читающие status='courier' (confirmReceiptByCustomer,
-- autoCompleteCourierOrders, sweep-таймеры) переводят заказ ДАЛЬШЕ, в
-- 'delivered', и никогда не обновляют status_updated_at, оставляя его
-- статус 'courier'. Значит для любой строки, застигнутой миграцией в
-- status='courier', status_updated_at гарантированно равен моменту
-- ready->courier — корректный earned_at, а не приближение. WHERE earned_at
-- IS NULL — идемпотентно на повторном запуске.
UPDATE orders SET earned_at = status_updated_at
  WHERE status = 'courier' AND earned_at IS NULL;
