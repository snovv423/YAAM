# PostgreSQL concurrency migration matrix

Точная карта для будущего поэтапного переноса `orderService.js` на PostgreSQL —
результат аудита всех текущих SQLite `db.immediateTransaction()`/`db.transaction()`
вызовов (см. `YAAM-postgresql-concurrency-strategy.pdf`). Это НЕ перенос кода —
только зафиксированное архитектурное решение по каждому месту, чтобы при
реальном переносе стратегия не выбиралась заново на каждом участке.

API упоминаемый ниже — `server/db/postgresql/index.js`: `transaction(fn, options)`,
`serializableTransaction(fn, options)`. `options.retry` по умолчанию отсутствует
(нет повторов); включается явно там, где отмечено.

Legend локов/constraints: **CU** = conditional UPDATE (`WHERE id=? AND status=X`,
проверка `rowCount`), **PUI** = partial UNIQUE index (последняя линия защиты),
**FOR UPDATE** = `SELECT ... FOR UPDATE` перед read-modify-write.

| # | Функция (orderService.js) | Защищаемый инвариант | PostgreSQL-стратегия | Locks/constraints | Retry policy | Provider network call внутри? | claim → network → finalize |
|---|---|---|---|---|---|---|---|
| 1 | `finalizeInitialAttempt` (:262) | Ровно один переход `payments.creating→pending` + presentation + ledger `creating→ready` на попытку | `transaction()` без опций | CU (`WHERE status='creating'`) | нет | **Нет** — это finalize-шаг, вызывается ПОСЛЕ ответа провайдера | finalize |
| 2 | `createOrder` (:593) | (a) точный replay по idempotency-паре — не создаёт второй заказ; (b) не более одного awaiting_payment заказа на телефон+ресторан в TTL-окне; (c) один активный payment на order | (a)+(c) — `transaction()` + catch `23505` (PUI ловит); (b) — **`serializableTransaction()`** с retry, т.к. TTL-окно не выражается через UNIQUE index | PUI `ux_payments_one_active_per_order`; UNIQUE на `token_hash`/`create_key_hash` | retry ТОЛЬКО для ветки (b): `{maxAttempts:3}` на `40001`/`40P01`; ветка (a)/(c) — без retry (23505 не транзиентна) | **Нет** — чистая резервация | claim |
| 3 | `markPaid` (:678) | Ровно один переход `payment.pending→succeeded` + `order.awaiting_payment→awaiting_restaurant` (или late-cancel ветка с резервацией refund) | `transaction()` без опций | CU (`WHERE status='pending'`/`'awaiting_payment'`) | нет | **Нет** — webhook-обработчик; refund-резервация (если есть) не звонит провайдеру, это отдельный claim | finalize (+ вложенный claim для late-refund) |
| 4 | `markPaymentFailed` (:735) | Ровно один переход `payment.pending→failed` + `order.awaiting_payment→payment_failed` | `transaction()` без опций | CU | нет | Нет | finalize |
| 5 | `reserveRetryAttempt` (:787) | Один активный payment на order при retry; один retry attempt на client key | `transaction()` + catch `23505` → повторное чтение строки-победителя (НЕ retry callback'а) | PUI `ux_payments_one_active_per_order`; UNIQUE на `provider_idempotency_key`/`client_key_hash` | нет (23505 не транзиентна) | Нет | claim |
| 6 | `finalizeRetryAttempt` (:830) | Ровно один переход `payment.creating→pending` + ledger→ready + `order.payment_failed→awaiting_payment` | `transaction()` без опций | CU (`WHERE status='creating'`) | нет | Нет — finalize-шаг | finalize |
| 7 | `ensureRefundReady` claim-шаг (:1028) | Ровно один переход `refund.{requested,processing}→processing` (резервация попытки перед сетевым вызовом) | `transaction()` без опций, **НО**: текущий SQLite `UPDATE` не имеет `WHERE status IN (...)` — держится только на синхронности SQLite. **Требуемое изменение при переносе**: добавить `AND status IN ('requested','processing')` в WHERE и проверять `rowCount===1` (либо `SELECT...FOR UPDATE` перед UPDATE) | CU (после исправления) | нет | Нет — claim-шаг | claim |
| 8 | `finalizeRefundSucceeded` (:967) | Ровно один переход `refund.processing→succeeded` + `payment.succeeded→refunded` | `transaction()` без опций | CU (`WHERE status='processing'`); backstop — PUI `ux_refunds_one_succeeded_per_payment` + `trg_refunds_block_after_succeeded` | нет | Нет — finalize-шаг | finalize |
| 9 | `finalizeRefundFailed` (:989) | Ровно один переход `refund.processing→failed` | `transaction()` без опций | CU | нет | Нет | finalize |
| 10 | `cancelByCustomer` (:1124) | `order.{awaiting_payment,awaiting_restaurant}→cancelled` + (если оплачен) claim refund — одной транзакцией | `transaction()` без опций | CU (`WHERE status=current.status`); PUI `ux_refunds_one_active_per_payment` для вложенного claim | нет | Нет — refund-резервация не звонит провайдеру (см. `scheduleRefundProcessing`, вызывается ПОСЛЕ commit) | order-transition + вложенный claim |
| 11 | `restaurantAccept` (:1160) | `order.awaiting_restaurant→accepted` | `transaction()` без опций | CU | нет | Нет | finalize |
| 12 | `restaurantDecline` (:1180) | `order.awaiting_restaurant→declined` + claim refund одной транзакцией | `transaction()` без опций | CU; PUI для вложенного claim | нет | Нет | order-transition + вложенный claim |
| 13 | `restaurantAdvance` (:1214) | `order.status→ADVANCE_MAP[fulfillment_type][status]` (единственный разрешённый следующий шаг) | `transaction()` без опций | CU | нет | Нет | finalize |
| 14 | `rateOrder` (:1283, `db.transaction()`) | Рейтинг ставится один раз (`rating IS NULL`) + агрегат `restaurants.rating/rating_count` пересчитывается атомарно | `transaction()` **с обязательным `SELECT rating, rating_count FROM restaurants WHERE id=? FOR UPDATE`** перед пересчётом — read-modify-write без CU-эквивалента (см. Finding ниже) | CU для `orders.rating`; **FOR UPDATE обязателен** для `restaurants` (единственное место в списке, где это реально нужно — подтверждено concurrency-тестом #5/6/7) | нет (FOR UPDATE блокирует, а не конфликтует — retry не нужен) | Нет | finalize |
| 15 | `sweepTimeouts` per-order (:1315) | `order.awaiting_restaurant→timed_out` + claim refund, отдельная транзакция НА КАЖДЫЙ заказ свипа | `transaction()` без опций | CU; PUI для вложенного claim | нет | Нет | order-transition + вложенный claim |

## Находки аудита, требующие изменения кода при переносе (не сделаны на этом этапе)

1. **`ensureRefundReady` claim-UPDATE (:1033-1039, строка 7 таблицы)** — сегодня
   `UPDATE refunds SET status='processing', ... WHERE id = ?` БЕЗ проверки
   текущего статуса в WHERE. Безопасно только потому, что SQLite синхронен и
   ничего не может вклиниться между предшествующим `SELECT` и этим `UPDATE` в
   той же `immediateTransaction()`. Под PostgreSQL при реальной многопроцессной
   эксплуатации это открытый race (два конкурентных claim одного и того же
   refund). Требуется добавить `AND status IN ('requested','processing')` в
   WHERE и проверять `rowCount===1` — тривиальное исправление, тот же паттерн,
   что уже используется во ВСЕХ остальных 14 местах этой таблицы.
2. **`rateOrder`'s restaurant rating aggregate (:1286-1290, строка 14 таблицы)** —
   `SELECT rating, rating_count ...` затем безусловный `UPDATE restaurants SET
   rating=?, rating_count=?...` — классический lost-update паттерн без
   conditional UPDATE. Безопасно сегодня только благодаря синхронности SQLite.
   Единственное место во всём аудите, где реально нужен `SELECT ... FOR
   UPDATE` (не просто "было бы неплохо") — подтверждено живыми
   concurrency-тестами #5/6/7 против настоящего PostgreSQL.

## Итоговое распределение по классам (см. PDF, разделы 4-9)

- **12 из 15** мест — простой conditional UPDATE (`transaction()` без опций,
  без retry, без блокировок сверх той, что даёт сам `UPDATE`).
- **1 из 15** (`createOrder`, ветка time-window дедупа) — единственное место,
  где оправдан `serializableTransaction()` с retry.
- **1 из 15** (`rateOrder`) — единственное место, где нужен `SELECT ... FOR
  UPDATE`.
- **Ни одно** место не требует advisory lock — все инварианты выражаются через
  partial UNIQUE indexes, conditional UPDATE или (в одном случае) FOR UPDATE /
  SERIALIZABLE.
- Ни одно место не вызывает provider (YooKassa) внутри транзакции — во всех
  15 сохраняется claim → COMMIT → network → finalize (отдельная транзакция).
