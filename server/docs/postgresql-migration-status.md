# PostgreSQL migration — статус

Компактный, постоянно обновляемый operational source of truth. Не пересказывает
PDF-отчёты — только текущее состояние и ссылки. Обновляется тем же коммитом,
что и код каждой новой волны (правило см. в конце файла).

## Текущий статус

- Production-приложение сейчас работает **только на SQLite** — ничего не переключено.
- PostgreSQL-реализация существует **отдельно**, изолированным набором файлов,
  ни один из которых не импортируется рабочим приложением (`server.js`,
  `routes/`, `bot/`).
- Переключение приложения на PostgreSQL **ещё не выполнено** и не запланировано
  как часть текущих волн — это отдельный будущий этап.

## Выполненные этапы

| # | Этап | Commit |
|---|---|---|
| 1 | Migration Analysis (аудит SQLite-схемы, план переноса) | анализ, без кода |
| 2 | PostgreSQL DDL (`server/db/postgresql/schema.sql`) | `921bd6bcb12e913bd815d03267517c3df93e4a21` |
| 3 | PostgreSQL DB Layer (`server/db/postgresql/index.js`) | `0566b4655a817fa912857592fcab8e263e04cf85` |
| 4 | Embedded Live Validation (schema/triggers/db-layer против настоящего PostgreSQL 16.14) | `7b3d298d989ade4b82d446388346b878b455240d` |
| 5 | Concurrency Strategy (`transaction()`/`serializableTransaction()` API + 12 live-сценариев) | `3d671ff155e4d27fa3d0ef4295c9434ec60c0298` |
| 6 | Order Service Migration — Wave 1 | `4b18a6488179bd15a570afe66f33e3265d169d11` |
| 7 | Order Service Migration — Wave 2 | `a221991bf99cff53f5b4001e536aecf96a84ac9f` |
| 8 | Documentation Sync (живой трекер, CLAUDE.md, PROJECT_STATUS/BACKLOG) | `1ebb5c33869a3e61fce13df9141989752dc2647f` |
| 9 | Order Service Migration — Wave 3 | `84b0266ccbc12c92c427e704cadd87985b3b6cc5` |
| 10 | Order Service Migration — Wave 4 | `a014346c6ce9db0825c06561613f88ba5b153b00` |
| 11 | Order Service Migration — Wave 5 | `59160e3a69ea6859ed15938929d9dcd5fb9cfc48` |
| 12 | Order Service Migration — Wave 6 | `5d7168f951272b98cf11ae538ad2dfbed6a708c9` |
| 13 | ensureRefundReady Architecture Review (Вариант D, без кода) | анализ, без кода |
| 14 | Order Service Migration — Wave 7 (финальная, claimRefundForProcessing) | `44bd2a564e43d0c5cc652e49bcc615fa71680b65` |
| 15 | Production Switch Design Review (аудит готовности, без кода) | анализ, без кода |
| 16 | Production Switch — Stage 1 (`server/routes/postgresql/api.js`) | этот же коммит — точный hash самоссылочен и не фиксируется здесь (см. `git log -1` или последний коммит на ветке) |

## Какие функции уже перенесены (`server/services/postgresql/orderService.js`)

**Wave 1** (`4b18a648`) — чистый conditional UPDATE, без refund creation:
- `markPaymentFailed`
- `restaurantAccept`
- `restaurantAdvance`

**Wave 2** (`a221991`) — связанная группа, отложенная Wave 1 (зависела от
`reserveRefundRow`):
- `reserveRefundRow` (новая claim-операция, INSERT + partial UNIQUE index)
- `markPaid`
- `restaurantDecline`
- `cancelByCustomer`

**Wave 3** (`84b0266`) — закрывает refund-жизненный-цикл в части, не
требующей сети/SERIALIZABLE/FOR UPDATE:
- `sweepTimeouts` (per-order claim, та же схема, что Wave 2)
- `finalizeRefundSucceeded`
- `finalizeRefundFailed`

**Wave 4** (этот коммит) — payment-attempt lifecycle (claim → finalize, тот
же принцип, что refund-жизненный-цикл в Wave 2/3, без самого сетевого
вызова провайдера):
- `reserveRetryAttempt` — claim-резервация повторной попытки оплаты после
  `payment_failed`; структурный аналог `reserveRefundRow` (Wave 2), но с
  ДВУМЯ независимыми точками конфликта вместо одной: гонка на
  `ux_payments_one_active_per_order` (payments) и гонка на PRIMARY KEY
  `payment_retry_keys.client_key_hash` — обе закрыты SAVEPOINT-based
  recovery (перехват `23505`, откат к SAVEPOINT, повторное чтение
  строки-победителя вместо retry, поскольку `23505` не транзиентна).
- `finalizeInitialAttempt` / `finalizeRetryAttempt` — симметричная пара
  finalize-шагов (`creating -> pending`), обычный CU-класс без гонок; вызываются
  ПОСЛЕ ответа провайдера, сами сеть не трогают. Асимметрия оригинальной
  SQLite-логики (разные источники idempotent-repeat: `state='ready'` у
  initial, `payments.status='pending'` у retry; разное поведение проверки
  статуса заказа на idempotent-пути) сохранена намеренно, без унификации.

При аудите подтверждено (см. `postgresql-concurrency-migration-matrix.md`,
строки #1/#5/#6): все три функции не требуют `SERIALIZABLE`/`FOR UPDATE`/
сетевых вызовов внутри транзакции, ни одна не касается известного бага
`ensureRefundReady` — группа перенесена одной волной без архитектурных
блокеров.

Известная граница изоляции, найденная и задокументированная при аудите:
`orderAccessService.js` и `paymentService.js` открывают SQLite/провайдер как
побочный эффект `require()` на верхнем уровне модуля и не могут быть
импортированы в PostgreSQL-модуль. Решение — не импортировать их: чистые,
без побочных эффектов функции (`isValidRetryKey`, `hashSecret`,
`OrderAccessInputError`, деривация `PROVIDER_NAME`) продублированы напрямую
в `server/services/postgresql/orderService.js`, тем же приёмом, что уже
использовался для `ADVANCE_MAP`/`RESTAURANT_RESPONSE_WINDOW_SEC` в
предыдущих волнах.

**Wave 5** (этот коммит) — `createOrder`, единственная функция всей матрицы,
требующая `serializableTransaction()`:
- инвариант "не более одного `awaiting_payment` заказа на телефон+ресторан в
  TTL-окне" — классический write-skew (два конкурентных SELECT видят
  "конфликтов нет", оба вставляют новый заказ), не выразим через partial
  UNIQUE index; закрыт `serializableTransaction()` (SERIALIZABLE + retry на
  `40001`/`40P01`) — при конфликте проигравшая попытка автоматически
  перезапускается и на повторном чтении корректно видит уже зафиксированную
  строку победителя, превращая сырую `40001` в штатный `ActiveOrderConflictError`;
- точный replay и `secretsAlreadyUsed` по-прежнему защищены обычными UNIQUE-
  индексами на `order_access_credentials` (`token_hash`, `create_key_hash`) —
  тот же принцип SAVEPOINT + catch `23505` + повторное чтение
  строки-победителя, что и `reserveRefundRow` (Wave 2) / `reserveRetryAttempt`
  (Wave 4); найден и живо протестирован реально достижимый только под
  PostgreSQL edge-case частичного совпадения секретов (см. код и PDF Wave 5);
- как и во всех предыдущих волнах, перенесён ТОЛЬКО claim-шаг (создание
  `orders`/`order_items`/`payments`/`payment_initial_attempts` строк) —
  сетевой вызов провайдера (`resolveCreationOrder` -> `ensureInitialAttemptReady`)
  не переносится; уже перенесённый в Wave 4 `finalizeInitialAttempt` покрывает
  finalize-половину того же жизненного цикла.

**Wave 6** (этот коммит) — `rateOrder`, единственная функция всей матрицы,
требующая `SELECT ... FOR UPDATE`:
- `restaurants.rating`/`rating_count` — read-modify-write агрегат без
  conditional-UPDATE-эквивалента (новое значение вычисляется из старого в
  JS, затем пишется безусловно) — классический lost update под READ
  COMMITTED; закрыт `SELECT rating, rating_count FROM restaurants WHERE
  id=$1 FOR UPDATE` внутри обычного `transaction()` (без retry — FOR UPDATE
  блокирует конкурента, а не конфликтует с ним);
- порядок блокировок сохранён дословно из оригинала: conditional UPDATE
  `orders SET rating=? WHERE id=? AND rating IS NULL` — ПЕРВЫМ, `SELECT ...
  FOR UPDATE restaurants` — ВТОРЫМ, только если первый шаг победил гонку за
  оценку конкретного заказа. Поскольку каждый вызов блокирует ровно одну
  свою orders-строку и ровно одну (всегда вторую по счёту) restaurants-
  строку, deadlock исключён конструктивно — не требует ни retry на `40P01`,
  ни ручного упорядочивания нескольких общих ресурсов;
- терминология уточнена: в схеме нет колонки `rating_sum` — сумма
  реконструируется каждый раз как `rating * rating_count` (дословно из
  SQLite), схема не менялась;
- механизм FOR UPDATE был заранее живо доказан в `concurrency.test.js`
  #5/6/7 (написаны именно на паре `restaurants.rating`/`rating_count` при
  проектировании Concurrency Strategy) — Wave 6 добавляет тесты самой
  функции `rateOrder()`, не переоткрывает общий механизм;
- намеренная асимметрия оригинала сохранена без изменений: `rateOrder`
  бросает голые `Error(...)` без `.statusCode` (единственная функция
  `orderService.js` с такой формой ошибок) — не унифицировано с остальными
  кастомными классами ошибок.

**Wave 7** (этот коммит, финальная SQL-side волна) — `claimRefundForProcessing`,
claim-половина `ensureRefundReady`:
- Реализован **Вариант D** ("lease-guarded conditional UPDATE"), согласованный
  отдельным продуктовым решением после архитектурного разбора (см.
  `YAAM-ensure-refund-ready-architecture-review.pdf`): claim разрешён из
  `status='requested'` ИЛИ из `status='processing'` с истёкшим/отсутствующим
  `next_attempt_at` (поле трактуется как lease, проверяется атомарно внутри
  WHERE самого claim-UPDATE, не только в отдельном предварительном SELECT).
- Буквальный `WHERE status IN ('requested','processing')` (то, что
  рекомендовал сам этот файл до архитектурного разбора) **НЕ использован** —
  строго доказано (двумя полностью корректными, последовательно
  сериализованными PostgreSQL-транзакциями), что такое условие допускает
  повторный claim ЖИВОЙ `processing`-попытки и, соответственно, два
  параллельных сетевых запроса возврата с одним и тем же
  `provider_idempotency_key`.
- Схема НЕ менялась — `attempt_count`, `last_attempt_at`, `next_attempt_at`,
  `provider_refund_id`, `provider_idempotency_key` уже существовали и
  оказались полностью достаточны.
- rowCount=0 доменно классифицируется (`terminal` / `leased` / `not_found`),
  не пробрасывается как сырая ошибка БД.
- `refundAttemptInFlight` — дословная копия in-process Map из SQLite-версии,
  fast-path оптимизация в рамках процесса; основная защита — SQL WHERE-guard,
  подтверждено отдельным живым тестом на ДВУХ независимых "процессах"
  (раздельные копии модуля), не полагающимся на эту Map.
- Сетевой оркестратор `ensureRefundReady()` (реальный вызов провайдера) и
  `sweepStuckRefunds()` (SQL для поиска кандидатов на повтор) сознательно НЕ
  переносятся — вне scope PostgreSQL-миграции вообще, не только этой волны
  (см. "Что осталось вне PostgreSQL-миграции" ниже).

Итого 16 функций перенесены и живо протестированы против настоящего embedded
PostgreSQL 16.14. **Это закрывает последнюю строку 15-пунктовой
concurrency-матрицы** — вся SQL-side бизнес-логика `orderService.js`, не
требующая реального сетевого вызова провайдера, теперь перенесена.

## Production Switch — Stage 1 (`server/routes/postgresql/api.js`)

Первая задача **Production Switch** (см. `YAAM-production-switch-design-
review.pdf`) — изолированный, НЕ подключённый к `server.js` порт
`server/routes/api.js` на PostgreSQL. Та же архитектурная граница, что у
всех волн 1-7: новый файл нигде не импортируется работающим приложением.

Перенесены **все 9 маршрутов** SQLite-оригинала без исключений: `GET
/restaurants`, `GET /restaurants/:id`, `POST /orders`, `POST
/orders/recover`, `GET /orders/:code`, `POST /orders/:code/cancel`, `POST
/orders/:code/retry-payment`, `POST /orders/:code/rate`, `POST
/webhooks/payment`, `POST /orders/:code/dev-confirm-payment`.

Потребовалось значительно больше нового кода, чем в любой из Wave 1-7,
потому что `POST /orders`/`POST /orders/recover`/`retry-payment`
принципиально не могут вернуть клиенту `paymentUrl`/`qrPayload` без
реального сетевого вызова провайдера — Wave 1-7 сознательно никогда этого
не делали (claim/finalize без сети). В `services/postgresql/orderService.js`
добавлены асинхронные аналоги orchestration-функций SQLite-оригинала:
`ensureInitialAttemptReady`, `ensureRetryAttemptReady`,
`resolveCreationOrder`, `recoverOrder`, `retryPayment`, плюс новая тонкая
обёртка `createOrderAndResolve` (композиция уже перенесённого `createOrder`
Wave 5 + `resolveCreationOrder`, сам `createOrder` не менялся). Эти функции
ВЫЗЫВАЮТ `paymentService.createPayment()` (существующий, НЕ изменённый
provider layer) между уже перенесёнными claim (Wave 4/5) и finalize (Wave 4)
шагами — тот же принцип claim → network → finalize, что установлен всеми
предыдущими волнами, здесь впервые собранный в вызываемую цепочку. Также
добавлены: DTO-функции (`toPublicOrderDTO`/`toPublicPaymentDTO`), чистые
order-access хелперы (`parseBearerAuthorization`/`findAuthorizedOrderId`),
точечные read-only функции для webhook/dev-confirm
(`getPaymentByProviderPaymentId`/`getPendingPaymentForOrder`), классы ошибок
(`PaymentInitialUnavailableError`/`PaymentRetryUnavailableError`/
`OrderCreationRecoveryNotFoundError`).

`orderCreationContext()`/`.context` сознательно НЕ реализован полноценно —
поле нигде не читается клиентским кодом (`client/js/*.js`), всегда `null`,
задокументировано как осознанное решение не переносить неиспользуемое.

`server/routes/postgresql/api.js` НЕ содержит ни одного `require('../db')`
или `db.prepare()` — подтверждено отдельным тестом, статически читающим
исходник файла. Рестораны/меню читаются напрямую через `db.query()`
(PostgreSQL) тем же архитектурным контуром, что и в SQLite-оригинале (эти
запросы никогда не проходили через orderService.js даже там).

## Известные обязательные риски (не устранены, зафиксированы для будущих волн)

1. **Event emission** (`orderEvents`) ещё не подключена к PostgreSQL-версии —
   ни одна перенесённая функция не эмитит события (нет подписчика в этом
   изолированном модуле сегодня; подключение — вопрос будущей интеграции, не
   бизнес-логики).

## Concurrency-матрица

Полная карта стратегии по всем 15 местам `db.immediateTransaction()`/
`db.transaction()` в SQLite-версии — см.
[`server/docs/postgresql-concurrency-migration-matrix.md`](./postgresql-concurrency-migration-matrix.md).

## Команды проверки

```bash
cd server
npm run test:postgresql   # live-тесты против embedded PostgreSQL 16.14
npm test                  # существующий SQLite-набор
```

## Последние подтверждённые результаты (после Production Switch Stage 1)

| Набор | Результат |
|---|---|
| PostgreSQL (`npm run test:postgresql`) | 283/285 passed, 2 skipped (явно, с причиной) |
| SQLite (`npm test`, включая существующий HTTP integration suite) | 333/333 |
| **Итого** | **616/618** (2 skipped, 0 failed) |

Оба набора — минимум два чистых прогона подряд, без флапанья на повторах
(Stage 1 test-файл `routesApiStage1.test.js` — 26/26, проверен на 4
повторных прогонах; regression Wave 1-7 — 184/186 passed, 2 skip;
concurrency-suite — 14/14 стабильно).

## Итоговый статус SQL-side PostgreSQL-миграции + Production Switch

**SQL-side миграция завершена** (Wave 1-7): все 15 строк 15-пунктовой
concurrency-матрицы, не требующие реального сетевого вызова провайдера,
перенесены и живо протестированы против настоящего embedded PostgreSQL
16.14 (Wave 1: 3, Wave 2: 4, Wave 3: 3, Wave 4: 3, Wave 5: 1, Wave 6: 1,
Wave 7: 1 = 16 функций суммарно по волновому учёту).

**Production Switch Stage 1 завершён**: `server/routes/api.js` полностью
портирован на PostgreSQL (`server/routes/postgresql/api.js`, изолирован, не
подключён к `server.js`). Production-приложение по-прежнему полностью на
SQLite — переключение (Stage 8 будущей последовательности) не выполнено и
не запланировано как часть Stage 1.

## Что осталось до Production Switch

1. **Stage 2 — событийная модель (`orderEvents`)** — PostgreSQL-модуль
   по-прежнему не эмитит события; следующий по рекомендованной
   последовательности этап (см. Production Switch Design Review).
2. **Stage 3 — `bot/index.js`** — не портирован, требует Stage 2.
3. **Stage 4 — `routes/admin.js`** — не портирован.
4. **Stage 5 — restaurant pause** (`pauseRestaurant`/`resumeRestaurant`/
   `sweepPauseExpiry`) — не портированы, не входили ни в одну волну и не в
   Stage 1 (не нужны для `routes/api.js`).
5. **Stage 6 — операционная обвязка** — скрипт применения схемы к реальной
   PostgreSQL БД, backup-стратегия, PostgreSQL-осведомлённый health-check,
   ENV-документация, адаптация systemd-юнита, graceful shutdown
   (`await db.close()`). Ничего из этого не создавалось ни в одной волне.
6. **Stage 7 — staging-прогон** и **Stage 8 — сам Production Switch**
   (инфраструктурный, DNS/reverse proxy) — не выполнялись.
7. **YooKassa production validation** — `createPayment()`/`getStatus()`/
   `refund()`/`getRefund()` реализованы (SQLite-сторона, независимо от этой
   миграции), но не валидированы вживую против боевого аккаунта ЮKassa.
8. **`YookassaProvider.verifyWebhook()`** — единственный метод провайдера,
   реально бросающий `not implemented`. Блокирует реальный production
   payment-webhook независимо от БД-движка.
9. **Реальный сетевой оркестратор `ensureRefundReady()` (refund) и
   `sweepStuckRefunds()`** — claim-половина перенесена (Wave 7); сама
   refund-оркестрация осталась только в SQLite-версии, сознательно не
   переносилась и в Stage 1 (тот же принцип, что и всех волн: реальный
   сетевой вызов провайдера для refund не переносится в изолированный
   PostgreSQL-модуль без отдельного согласования). Payment-оркестрация
   (create/retry) — уже перенесена Stage 1.
10. **Reconciliation improvements** (опционально) — подключение дормантного
    `getRefund()`, опциональный refund-webhook.

## Правило обновления

**После каждой PostgreSQL migration wave этот файл обновляется ТЕМ ЖЕ
коммитом, что и код волны.** Не отдельным последующим коммитом — одним и тем
же, чтобы `git log` никогда не показывал волну без синхронно обновлённого
статуса.
