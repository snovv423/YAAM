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
| 16 | Production Switch — Stage 1 (`server/routes/postgresql/api.js`) | `16990d5aa4294fb4cbc504c87a17315d3e02b302` |
| 17 | Production Switch — Stage 2 (PostgreSQL Event Layer, `orderEvents`) | `2db22c75bf11d5ad9f05a3f55e1069696a35ca79` |
| 18 | Production Switch — Stage 3 (PostgreSQL bot, `server/bot/postgresql/index.js`) | `017bf6955356e2dd5c2e34fa8884bb31b210ce4f` |
| 19 | Production Switch — Stage 4 (PostgreSQL admin, `server/routes/postgresql/admin.js`) | `6ad973c22259893a985126f5f951efda09e1c355` |
| 20 | Production Switch — Stage 5 (PostgreSQL restaurant-pause scheduler, `server/services/postgresql/scheduler.js`) | `2806788abca7f14122c33a5da77b2a72e12f3d0e` |
| 21 | Production Switch — Stage 6 (PostgreSQL operational infrastructure: bootstrap/health/lifecycle) | `fe0056213b6af2e5bfbdd2839ffc8b1ed539867d` |
| 22 | Production Switch — Stage 7 (PostgreSQL application assembly: `server/services/postgresql/app.js`) | `cfb9acd43d7012973bccd6ccfd9f9ad76d9de353` |
| 23 | Production Switch — Stage 8 (YooKassa payment/refund production safety) | этот же коммит — точный hash самоссылочен и не фиксируется здесь (см. `git log -1` или последний коммит на ветке) |

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

## Production Switch — Stage 2 (PostgreSQL Event Layer, `orderEvents`)

Вторая задача Production Switch — событийная модель. `server/services/
postgresql/orderService.js` получил собственный, структурно независимый
`EventEmitter` (`orderEvents`, экспортирован из модуля) — та же архитектурная
граница, что у всех предыдущих волн/этапов: модуль не может `require('../
orderService')` (SQLite), поэтому reuse исходного инстанса невозможен, новый
инстанс совместим по именам событий и форме payload, но не связан физически.

**Полный аудит SQLite-оригинала** (обязательное условие задачи, выполнен до
кода): ровно 2 имени события (`order:status`, `order:new`), ровно 8 точек
эмиссии, ровно 1 внешний подписчик (`bot/index.js`, ТОЛЬКО на `order:new`, из
`markPaid`). `order:status` эмитится 7 раз и не имеет ни одного подписчика в
текущей кодовой базе — существующий факт SQLite-оригинала (вероятно задел на
будущий SSE/push), не то, что нужно "исправлять" в Stage 2.

**Перенесённые точки эмиссии** (все 8, каждая уже была полностью
реализована и протестирована в Wave 1-4 — Stage 2 добавил ТОЛЬКО emit-вызовы,
не менял ни одной строки бизнес-логики):

| Функция | Событие(я) | Гвард-паттерн |
|---|---|---|
| `markPaid` | `order:status`, затем `order:new` | явный boolean (`changed`) |
| `markPaymentFailed` | `order:status` | явный boolean (`changed`) |
| `restaurantAccept` | `order:status` | явный boolean (`changed`) |
| `restaurantDecline` | `order:status` | явный boolean (`changed`) — **отличается от SQLite**, см. ниже |
| `restaurantAdvance` | `order:status` | throw-based (все no-op ветки бросают) |
| `cancelByCustomer` | `order:status` | throw-based |
| `finalizeRetryAttempt` | `order:status` | closure-переменная (`orderTransitioned`) |
| `sweepTimeouts` (на заказ) | `order:status` | явный boolean (`changed`) — **отличается от SQLite**, см. ниже |

`createOrder`, `rateOrder`, `finalizeRefundSucceeded`, `finalizeRefundFailed`,
`pauseRestaurant`, `resumeRestaurant`, `sweepPauseExpiry` подтверждены (grep +
построчное чтение) НЕ эмитящими ничего в SQLite-оригинале — соответствующие
функции PostgreSQL-модуля тоже не получили emit-вызовов.

**Найденное и исправленное расхождение с буквальным SQLite-гвардом**
(`restaurantDecline`, `sweepTimeouts`): SQLite-оригинал использует post-hoc
сравнение итогового `order.status` с ожидаемым значением (no-op ветка
транзакции возвращает `getOrder()` без явного boolean) — под однопоточным
синхронным SQLite это безопасно, но под настоящей PostgreSQL MVCC-
конкуренцией НЕТ: проигравшая гонку транзакция получает `rowCount=0`, но её
собственный последующий `getOrder()` (та же транзакция, READ COMMITTED —
свежий снимок на каждый оператор) уже видит ЧУЖОЙ закоммиченный целевой
статус — post-hoc проверка проходит и у проигравшего тоже, эмитируя событие
ДВАЖДЫ на один реальный переход. Живо воспроизведено concurrency-тестом при
проектировании Stage 2 (не гипотетика — два конкурентных `restaurantDecline`/
`sweepTimeouts` на один заказ достижимы в норме: повторный webhook/повторный
клик в боте, пересекающиеся прогоны свипа). Исправлено переходом на явный
`rowCount`-based boolean (тот же механизм, что `markPaid`/`restaurantAccept`)
— наблюдаемый результат для отдельного вызова не изменился, изменился только
внутренний триггер эмиссии. Подробное обоснование — комментарии над обеими
функциями в `services/postgresql/orderService.js`.

**Момент эмиссии — строго после commit**, тем же принципом, что и SQLite-
оригинал (там — после возврата синхронной IIFE `db.immediateTransaction()`,
здесь — после `await db.transaction(...)`, которая резолвит свой Promise
только после `COMMIT` + освобождения клиента, см. `server/db/postgresql/
index.js`). Между commit и emit нет ни одной операции, способной пронаблюдать
"недописанное" состояние — никакой новой гонки эмиссия сама по себе не
вводит.

**Outbox Pattern — сознательно НЕ внедрён.** SQLite-оригинал сам не даёт
durability-гарантии (голый in-process `EventEmitter`, событие безвозвратно
теряется при падении процесса между commit и emit, либо при отсутствии
подписчика в момент эмиссии — уже наблюдаемый факт для `order:status`, 7 из 7
эмиссий сегодня улетают в никуда). Задача требует воспроизвести это поведение,
не улучшать его сверх требуемого, и явно запрещает вводить outbox "без
доказанной необходимости". Необходимость появилась бы только в сценарии,
которого сегодня нет ни в SQLite, ни здесь — несколько процессов/инстансов
приложения, которым нужна гарантированная доставка каждого события (будущий
переход на несколько реплик API за балансировщиком). Это открытый вопрос для
будущего масштабирования, не блокер Stage 3 (bot) — Stage 3 будет опираться
на тот же best-effort in-process контракт, что уже принят SQLite-ботом
сегодня.

**Payload** — тот же объект, что возвращает `getOrder()` модуля (полная
внутренняя форма заказа с `items[]`, не `toPublicOrderDTO`) — идентичная
форма SQLite-оригинала. Parity-тест сравнивает поля, которые реально читает
`bot/index.js` в обработчике `order:new`
(`fulfillment_type`/`address`/`items_total`/`customer_phone`/`comment`/
`status`/`items[].{name,price,qty}`/наличие `id`/`restaurant_id`).

**Тесты** — новый файл `server/test/postgresql/eventLayerStage2.test.js`, 31
тест: по каждой из 8 точек эмиссии — успешный переход эмитит ожидаемое
событие/payload, no-op не эмитит ничего, throw/rollback не эмитит ничего;
порядок событий `markPaid` (`order:status` строго до `order:new`); отсутствие
дублей на повторном/конкурентном вызове (включая прямую регрессию на race,
описанный выше — `restaurantDecline`: последовательный повтор на уже
declined-заказе); parity SQLite↔PostgreSQL payload'а; отсутствие висящих
слушателей (`listenerCount()===0` после всех тестов файла); пул PostgreSQL
корректно возвращён.

## Production Switch — Stage 3 (PostgreSQL bot, `server/bot/postgresql/index.js`)

Третья задача Production Switch — изолированный порт `bot/index.js` на
PostgreSQL. Полная детализация (карта команд/callback, SQL-запросы
до/после, все новые helper'ы, обоснование двух намеренных адаптаций,
известные унаследованные ограничения) — в отдельном
[`server/docs/postgresql-bot-port.md`](./postgresql-bot-port.md), эта
секция — компактная сводка.

`server/bot/index.js` (SQLite) **не изменён**. Новый модуль нигде не
импортируется (`server.js`, `routes/`, старый `bot/index.js`) — та же
архитектурная граница, что у Stage 1/2.

Перенесены **все команды/callback оригинала без исключений**: `/start`,
`/pause`, `/open`, `/stoplist`, `order:new`-уведомление, `accept`/`decline`/
`cook_time`/`advance`/`pause:`/`toggle_item` кнопки. Тексты, эмодзи,
`callback_data` — дословная копия. Потребовались две новые PostgreSQL-функции
в `services/postgresql/orderService.js` — `pauseRestaurant`/
`resumeRestaurant` (не входили ни в одну волну и не в Stage 1/2, были
названы будущим "Stage 5", но объективно нужны боту для `/pause`/`/open`) —
минимальный точечный перенос, `sweepPauseExpiry` (вызывается из
`server.js` `setInterval`, не из бота) не переносился.

Единственные два намеренных отклонения от буквального SQLite-поведения
(обе — документированы подробно в `postgresql-bot-port.md`): (1) async-путь
вместо синхронного (неизбежное следствие `pg`), (2) `accept`/`decline`
получили pre-check текущего статуса заказа перед мутацией, чтобы повторный
клик на уже обработанном заказе не отправлял дублирующее "выберите время
готовки" уведомление — сама мутация в любом случае остаётся атомарной и
безопасной независимо от этой проверки (доказано concurrency-тестами и
отдельным 20-итерационным стресс-прогоном, 0 повреждений данных).

Bot подписывается на `pgOrderService.orderEvents.on('order:new', ...)` —
payload Stage 2, без изменений. Обработчик обёрнут в `.catch()`, чтобы
ошибка Telegram-отправки не мешала обработке следующих событий (SQLite-
оригинал этой защиты не имеет). `createBotHandlers(bot)` возвращает
`{ bot, stop(), waitForIdle() }` — `stop()` снимает listener (подтверждено
тестами на отсутствие накопления при повторной инициализации),
`waitForIdle()` — тестовый хук для детерминированного ожидания async-
обработки события без polling/sleep.

Тестируемость: `createBotHandlers(bot)` принимает УЖЕ созданный bot-клиент
(реальный `TelegramBot` или тестовый `FakeTelegramBot`,
`server/test/postgresql/helpers/fakeTelegramBot.js`) — не создаёт его сам,
поэтому тесты никогда не касаются реального Telegram token/сети.
`startBot(token)` — обычная production-точка входа, тот же внешний
контракт, что и SQLite `startBot(token)`.

Два известных, УНАСЛЕДОВАННЫХ от SQLite-оригинала ограничения (не
устранены, не входили в мандат Stage 3, требуют отдельного продуктового
решения) — нет проверки принадлежности ресторана на мутирующих callback,
`telegram_chat_id` не `UNIQUE` — подробности и тесты, документирующие
реальное (а не гипотетическое) поведение, см. `postgresql-bot-port.md`.

**Тесты** — новый файл `server/test/postgresql/botStage3.test.js`, 36
тестов (инициализация/no-SQLite-side-effect, привязка ресторана, `order:new`
уведомление + payload/текст-parity с SQLite, все кнопки статусов включая
повторные/конкурентные клики, стоп-лист, `/pause`/`/open`, cleanup) + новый
helper `helpers/fakeTelegramBot.js`.

## Production Switch — Stage 4 (PostgreSQL admin, `server/routes/postgresql/admin.js`)

Четвёртая задача Production Switch — изолированный порт `routes/admin.js`.
Полная детализация (карта всех 14 маршрутов, что реально есть vs. что
задание ожидало но в коде не существует, все dialect differences, найденный
маршрутный баг) — в отдельном
[`server/docs/postgresql-admin-port.md`](./postgresql-admin-port.md), эта
секция — компактная сводка.

`server/routes/admin.js` (SQLite) **не изменён**. Basic Auth НЕ реализован
внутри роутера ни в оригинале, ни в порте — он живёт исключительно в
`server.js`, в точке монтирования; порт авторизацию-агностичен по
конструкции, тесты воспроизводят ТУ ЖЕ схему монтирования в собственном
Express-приложении.

Полный построчный аудит (281 строка SQLite-оригинала, 14 маршрутов, 17 мест
прямого SQL) показал, что часть сценариев из задания Stage 4 **в реальном
коде не существует**: ручной смены статуса заказа, платёжных/refund-
экшенов, страницы деталей заказа, фильтров списка заказов, block/unblock,
edit/delete категорий и блюд, отдельного редактирования цены и
"hit"-переключателя в `routes/admin.js` НЕТ — ни один из них не добавлен в
порт (задание прямо требует не изобретать новый функционал; каждое
отсутствие подтверждено отдельным тестом, не просто не упомянуто).

**Всё, что реально есть, перенесено полностью**: dashboard, список/создание
ресторанов, редактирование (код перенесён корректно, см. находку ниже),
open/pause/resume, создание категорий/блюд, toggle-available, read-only
списки заказов и оценок.

**Найденный, серьёзный, унаследованный от SQLite баг (не Stage-4-регрессия):**
`router.post('/restaurants/:id/', ...)` (307-редирект-заглушка)
зарегистрирован ПЕРЕД `router.post('/restaurants/:id', ...)` (реальный
UPDATE). Под Express `strict: false` (default, не переопределён нигде) оба
паттерна компилируются в идентичный регэксп — первый зарегистрированный
маршрут побеждает независимо от наличия trailing slash в запросе. Реальный
UPDATE-обработчик — недостижимый мёртвый код; форма редактирования ресторана
(`action` без trailing slash) в реальном браузере попала бы в бесконечный
307-редирект-цикл на саму себя. Подтверждено живым мини-репродуктом на
чистом Express и тестами `C3`/`C3b` в `adminStage4.test.js`. Это баг
SQLite-оригинала — порт воспроизводит регистрацию маршрутов буквально,
построчной копией, поэтому баг унаследован, а не привнесён. Однострочный
фикс (поменять порядок регистрации) НЕ применён — вне мандата "сохранить
текущее поведение максимально точно", требует отдельного явного
product-решения (см. `postgresql-admin-port.md` для рекомендации).

**Dialect differences**: `COUNT`/`SUM` требуют явного `::int` (bigint-as-
string), `MAX` — нет; `TIMESTAMPTZ`-колонки (`created_at`/`paused_until`)
возвращаются `pg`-драйвером как нативные `Date`, не строки — добавлен
`formatDateTime()` для сохранения визуального `"YYYY-MM-DD HH:MM:SS"`-
контракта; `date('now')`-сравнение дашборда переписано через `AT TIME ZONE
'UTC'` для явной timezone-независимости; `lastInsertRowid` → `RETURNING id`.

**Concurrency**: read-modify-write гонка на `sort_order` (`SELECT MAX` +
`INSERT` двумя раздельными вызовами) — новая под PostgreSQL async-моделью
(не существовала под однопоточным синхронным SQLite) — сужена (не устранена
полностью, задание прямо просит не вводить `SERIALIZABLE` автоматически)
объединением в один атомарный `INSERT ... (SELECT MAX...)`. Цена проигрыша
узкой гонки — чисто косметическая (дублирующийся `sort_order`, без потери
данных). `toggle-available` переиспользует уже доказанный безопасным
атомарный UPDATE-паттерн из Stage 3.

**Тесты** — новый файл `server/test/postgresql/adminStage4.test.js`, 44
теста (авторизация, dashboard с числовыми типами, restaurants/categories/
menu-items CRUD как реально реализовано, toggle-available с конкурентностью,
orders/ratings, SQLite↔PostgreSQL parity по маршрутам/HTML-маркерам/error-
текстам, статические изоляционные проверки, cleanup).

## Production Switch — Stage 5 (PostgreSQL restaurant-pause scheduler, `server/services/postgresql/scheduler.js`)

Пятая задача Production Switch — автоматическое снятие истёкшей паузы
ресторана (`sweepPauseExpiry`) и обёртка для его периодического запуска.

**Важное отличие от Stage 1-4**: SQLite-оригинал НЕ имеет отдельного
scheduler-модуля вообще — в `server.js` это три голых `setInterval(() =>
orderService.sweepXxx(), N)` без единой lifecycle-обёртки (нет
`clearInterval`, нет программного способа их остановить). Задание Stage 5
прямо требует явную `start()`/`stop()` модель — это НОВАЯ абстракция,
добавленная только для изолированной PostgreSQL-стороны, не перенос
существующего SQLite-модуля (которого не существует). `server.js` и три его
`setInterval`-вызова (включая SQLite `sweepPauseExpiry`) не изменены.

**`sweepPauseExpiry()`** (`services/postgresql/orderService.js`) — дословный
асинхронный аналог: один безусловный `UPDATE restaurants SET is_open=1,
paused_until=NULL WHERE is_open=0 AND paused_until IS NOT NULL AND
paused_until <= NOW()`. Не эмитит ничего в `orderEvents` (подтверждено ещё
при аудите Stage 2, сохранено без изменений — живой тест `K1` доказывает
ноль эмиссий на реальном sweep). SQLite-версия сравнивает TEXT-строки
лексикографически, из-за чего `pauseRestaurant()` там обязана вычислять
`paused_until` средствами самого SQLite, а не `new Date()`, чтобы формат
совпал — под PostgreSQL `paused_until` уже TIMESTAMPTZ (настоящий
хронологический тип), поэтому эта проблема формата структурно не
существует.

**`createPauseExpiryScheduler({intervalMs, onError})`**
(`services/postgresql/scheduler.js`, новый файл) — фабрика (не singleton),
возвращает `{ start(), stop(), isRunning(), runOnce() }`. Не запускается
автоматически при `require()`. `start()`/`stop()` идемпотентны (повторный
вызов безопасен, не создаёт второй таймер и не бросает). Таймер помечен
`.unref()` — не удерживает процесс живым сам по себе (подстраховка, не
замена явному `stop()`). `runOnce()` — прогон одного sweep немедленно, без
таймера (используется тестами и потенциальными ops-инструментами).

**Race conditions — проверены, ни одна не потребовала блокировок/SERIALIZABLE**:
единственный нетривиальный сценарий, явно названный заданием — "ресторан
вручную открылся ОДНОВРЕМЕННО со sweep" — структурно безопасен независимо от
порядка: `resumeRestaurant()` безусловно форсирует `is_open=1,
paused_until=NULL`, `sweepPauseExpiry()` даёт ТОТ ЖЕ результат через
guarded `WHERE` — оба перехода сходятся к одному и тому же конечному
состоянию (не конкурирующие альтернативы, а один и тот же переход с двух
триггеров), поэтому конкурентное исполнение в любом порядке даёт корректный
результат без лишнего кода. Живо доказано тестами `D1`/`D2`. Аналогично для
двух конкурентных sweep (`L1`/`L2`) и повторного sweep подряд (`E1`) —
idempotent по конструкции (`WHERE`-условие само исключает уже-обработанные
строки).

**Clock drift/timezone**: решение "истекла ли пауза" принимается ЦЕЛИКОМ на
стороне PostgreSQL (`NOW()`), Node-процесс не участвует своим `Date.now()`
— несколько экземпляров приложения (будущий multi-instance) сверяются с
ОДними и теми же часами БД, а не каждый со своими; расхождение часов между
Node-процессами структурно не может исказить это решение. Живо доказано
`M1` (paused_until вставлен с явным non-UTC offset — TIMESTAMPTZ нормализует
корректно), `M2` (реальный `pauseRestaurant()` → искусственно состаренный
`paused_until` → корректный sweep), `N1` (structural-тест: исходник
`sweepPauseExpiry` не содержит ни одного JS-вычисленного "текущего времени").

**Тесты** — новый файл `server/test/postgresql/schedulerStage5.test.js`, 21
тест (истечение паузы, неистёкшая пауза, несколько ресторанов, конкурентный
manual resume, повторный sweep, "рестарт" через новый инстанс, start→stop→start,
отсутствие timer leak, pool cleanup, статическая изоляция от SQLite,
отсутствие эмиссии событий, конкурентность (два runOnce/два таймера),
timezone, clock-drift design-проверка). 5 последовательных прогонов —
стабильно зелёные, без флапанья таймингов.

## Production Switch — Stage 6 (PostgreSQL operational infrastructure)

Шестая задача Production Switch — не перенос бизнес-логики, а операционная
инфраструктура: bootstrap, health checks, lifecycle-менеджмент, graceful
shutdown для PostgreSQL-стороны. Полная детализация — в отдельном
[`server/docs/postgresql-operational-readiness.md`](./postgresql-operational-readiness.md),
эта секция — компактная сводка.

**Важное отличие от Stage 1-5**: `server.js` (SQLite) не имеет ни одной из
этих абстракций — старт представляет собой последовательность разрозненных
top-level вызовов, а "graceful shutdown" — это ровно один
`process.on('SIGTERM'/'SIGINT', shutdown)`, где `shutdown()` только
освобождает PID-lock-файл и сразу `process.exit(0)` (не закрывает HTTP-
сервер, не гасит три `setInterval`, не закрывает БД-соединение). Нет
`unhandledRejection`/`uncaughtException`-обработчиков. `/health` — статический
`{ok:true}`, не проверяющий вообще ничего. Задание Stage 6 прямо требует
явные bootstrap/lifecycle/health-check примитивы для PostgreSQL-стороны — это
НОВАЯ инфраструктура, не перенос существующей (переносить нечего). `server.js`
не изменён ни строкой.

**Новые модули**:
- `server/db/postgresql/bootstrap.js` — `validateEnv()` (понятная ошибка,
  если не заданы ни `DATABASE_URL`/`POSTGRES_URL`, ни полный набор
  `PGHOST`/`PGDATABASE`/`PGUSER`; проверка `PGPORT`/`PG_SSL`/`PG_POOL_MAX`)
  + `waitForDatabase({retries, delayMs})` (реальный `SELECT 1` с retry/
  backoff, понятная агрегированная ошибка после исчерпания попыток) +
  `bootstrap()` (оба вместе). Чисто аддитивный — `db/postgresql/index.js`
  (Stage 1) не изменён, чтобы не рисковать уже прошедшими 400+ тестами
  Stage 1-5, полагающимися на его текущее (лениво-permissive) поведение.
- `server/services/postgresql/health.js` — `createHealthCheck({getSchedulers})`
  → `{liveness(), readiness()}`. Liveness намеренно НЕ проверяет БД
  (стандартная практика — временный сбой БД не должен валить liveness-пробу
  и провоцировать перезапуск живого процесса). Readiness проверяет ровно
  то, что требует задание: PostgreSQL connection, pool state, scheduler
  state, uptime.
- `server/services/postgresql/lifecycle.js` — `createLifecycle({schedulers,
  httpServer, onShutdown, onSignal, signals})` → `{start(), stop(),
  isRunning()}`. НЕ вызывает `process.exit()` нигде внутри себя — только
  координирует, уведомляет вызывающий код через `onSignal()` — принципиально
  для тестируемости (тест эмитирует сигнал синтетически, не убивая тестовый
  процесс) и для чистоты границы ответственности (`process.exit()` —
  прерогатива конкретной точки входа, не переиспользуемого модуля). `start()`/
  `stop()` идемпотентны, `stop()` снимает signal listeners (не оставляет
  висящих), останавливает schedulers, закрывает HTTP-сервер (если передан),
  закрывает пул.
- `server/server.postgresql.js` — изолированная, НИКЕМ не требуемая,
  никогда не запускаемая автоматически точка входа (аналог `server.js` для
  PostgreSQL-стороны). Экспортирует `createApp()` (фабрика, testable) и
  `main()` (реальный запуск, выполняется только при `require.main===module`,
  не при `require()` из теста). Даёт `/health`, `/health/live`,
  `/health/ready` (503 при неготовности — стандартный контракт readiness-
  проб, не 200 с `ok:false`), scheduler (Stage 5), полный lifecycle. НЕ
  монтирует `routes/postgresql/api.js`/`admin.js`/bot — задание Stage 6
  ограничивает scope операционной инфраструктурой, не переносом бизнес-
  маршрутов в новую точку входа (решения о CORS/dev-route-gating и т.п. для
  реального PostgreSQL-приложения — предмет Stage 7/8, не этой задачи).
  Добавлен необязательный npm-скрипт `start:postgresql` для ручного/staging
  запуска (`npm start`, запускающий `server.js`, не изменён).

**Найденная особенность тестового окружения (не бага кода)**: `embedded-postgres`
(через зависимость `async-exit-hook`) сам регистрирует глобальный
`process.on('SIGTERM'/'SIGINT', ...)` для аккуратной остановки дочернего
процесса embedded-кластера — синтетический `process.emit('SIGTERM')` в тесте
задевает ЭТОТ обработчик тоже, реально останавливая тестовый PostgreSQL-
кластер. Обнаружено и обойдено использованием приватного, не-POSIX имени
сигнала в тесте (`lifecycle.js`'s `signals` — настраиваемый параметр); в
реальном использовании `server.postgresql.js` продолжает слушать настоящие
`SIGTERM`/`SIGINT`, как и требуется.

**Тесты** — новый файл `server/test/postgresql/operationalStage6.test.js`, 28
тестов (env-валидация с понятными ошибками и без silent fallback, retry-логика
подключения, полный lifecycle start/stop/idempotency/signal-handling/listener-
leak-absence, liveness/readiness против реальной БД и симулированного отказа,
HTTP-интеграция health-эндпоинтов включая 503, graceful shutdown checklist,
статическая изоляция от SQLite, cleanup). 5 последовательных прогонов —
стабильно зелёные.

## Production Switch — Stage 7 (PostgreSQL application assembly)

Седьмая задача Production Switch — сборка полного PostgreSQL-приложения
поверх Stage 6 lifecycle-скелета: публичный API, admin, event layer, бот,
CORS, dev-route gating, readiness-гейт, централизованный error handler.
Полная детализация — в отдельном
[`server/docs/postgresql-application-assembly.md`](./postgresql-application-assembly.md),
эта секция — компактная сводка.

Новый модуль `server/services/postgresql/app.js` (`createPostgresqlApp()`)
— единственное место сборки; `server/server.postgresql.js` стал тонкой
точкой входа поверх него (`main()`/`process.exit()`/сигнал-обработчики
верхнего уровня). Не дублирует бизнес-логику — монтирует уже существующие
`routes/postgresql/api.js` (Stage 1), `routes/postgresql/admin.js`
(Stage 4), `bot/postgresql` (Stage 3, обёрнутый в новый lifecycle-адаптер,
совместимый с `services/postgresql/lifecycle.js`'s `schedulers`-интерфейсом),
`services/postgresql/scheduler.js` (Stage 5), `health.js`/`lifecycle.js`/
`db/postgresql/bootstrap.js` (Stage 6) и `config/cors.js` (SQLite-сторона,
но DB-agnostic — переиспользован напрямую).

**Найденный Stage 4 маршрутный баг — исправлен**: порядок регистрации
`router.post('/restaurants/:id/', ...)` / `router.post('/restaurants/:id', ...)`
в `routes/postgresql/admin.js` поменян местами (реальный UPDATE — первым).
Задание Stage 7 явно разрешило локальный фикс, если он безопасный и не
меняет внешний контракт — воспроизведено тестом до фикса (обновлённые
`C3`/`C9` в `adminStage4.test.js` теперь документируют НОВОЕ, исправленное
поведение), исправлено, подтверждено тестом после (+ новый `E5` в
`applicationAssemblyStage7.test.js`). **SQLite-оригинал (`routes/admin.js`)
НЕ тронут** — там баг остаётся, требует отдельного явного product-решения.

**Readiness — Variant A**: HTTP-listener поднимается сразу
(`/health/live` работает немедленно), `lifecycle.start()` (bootstrap +
scheduler + bot) — асинхронно после; до его завершения все бизнес-маршруты
(включая webhook и admin mutations) отвечают 503 через дешёвый readiness-
гейт. `/health/ready` (Stage 6, не изменён) — самостоятельный сигнал живой
проверки БД, может на короткое время отличаться от business-гейта во время
старта — это намеренное разделение, не баг (подробное обоснование — в
`postgresql-application-assembly.md`).

**Bot lifecycle**: `createBotLifecycleAdapter` оборачивает `bot/postgresql`
в `{start(),stop(),isRunning()}`-контракт, управляется тем же
`lifecycle.js`, что и scheduler (без изменений в `lifecycle.js`). Состояние
бота — наблюдаемое поле `/health/ready`'s ответа (аддитивное расширение
`health.js`: опциональный `getBotState`, default `() => null`, обратно
совместимо со Stage 6), НЕ влияет на `ok` — временная недоступность
Telegram не должна делать сервис "неготовым".

**YooKassa webhook** — подключён (raw-body carve-out, тот же приём, что и
SQLite `server.js`), но `YookassaProvider.verifyWebhook()` по-прежнему
`throw`'ит `'not implemented'` (уже задокументированный, не решённый в
Stage 7 блокер) — маршрут переживает это как обычную ошибку (500, generic,
без утечки деталей), не крашится.

**Тесты** — новый файл `server/test/postgresql/applicationAssemblyStage7.test.js`,
39 тестов (assembly, middleware ordering, readiness gate, public API, admin
+ route-conflict repro/fix, webhook, CORS, dev-route gating, bot lifecycle,
shutdown). `adminStage4.test.js`'s `C3`/`C9` обновлены под новое,
исправленное поведение (не удалены — развитие покрытия вслед за намеренным
изменением). 4 прогона Stage 7 suite подряд стабильно зелёные; полный
`npm run test:postgresql` — 482/482, 2 прогона подряд чисто.

## Production Switch — Stage 8 (YooKassa payment/refund production safety)

Восьмая задача Production Switch — закрывает единственный оставшийся
Stage 7 блокер (`YookassaProvider.verifyWebhook()`, `"not implemented"`) и
найденный при архитектурном анализе, более серьёзный, ранее незамеченный
пробел: **сетевая оркестрация возвратов на PostgreSQL-стороне не
существовала вообще** — Wave 7 перенесла только claim-половину, реальный
вызов провайдера и финализация оставались только в SQLite-версии. До этой
задачи `reserveRefundRow()` резервировала возврат в `refunds.status=
'requested'` и на этом всё заканчивалось навсегда — деньги клиенту
физически никогда не возвращались бы на PostgreSQL-стороне. Полная
детализация — в отдельном
[`server/docs/postgresql-payment-safety.md`](./postgresql-payment-safety.md),
эта секция — компактная сводка.

**Webhook authenticity** — `YookassaProvider.verifyWebhook()` реализована
(асинхронно): официальная документация ЮKassa подтверждает отсутствие
HMAC/подписи у уведомлений — единственный реально существующий механизм
подлинности реализован (канонический lookup через уже существующий
`getStatus()`, той же авторизацией, что и остальные вызовы провайдера) +
опциональный (выключен по умолчанию до Stage 9/reverse-прокси)
IP-allowlist. Маршрут (`routes/postgresql/api.js`) дополнительно сверяет
amount/currency уведомления с сохранённым платежом до применения события.

**Refund network orchestration** (главное изменение) — `services/
postgresql/orderService.js` получил `ensureRefundReady`/
`scheduleRefundProcessing`/`sweepStuckRefunds`/`processClaimedRefund`,
построенные на топ уже существующего `claimRefundForProcessing` (Wave 7,
не изменён). Подключены fire-and-forget пост-commit вызовы во всех
четырёх местах, где уже вызывался `reserveRefundRow`: `cancelByCustomer`,
`restaurantDecline`, `sweepTimeouts`, `markPaid`'s ветка поздней оплаты
отменённого заказа.

**Reconciliation** — `sweepStuckRefunds({limit})`: один атомарный SQL-запрос
с `FOR UPDATE SKIP LOCKED` + bounded batch (default 50) + новый партиальный
индекс `ix_refunds_pending_sweep` (`db/postgresql/schema.sql`, чисто
аддитивно). Подключено двумя новыми scheduler-обёртками
(`createOrderTimeoutScheduler`/`createRefundReconciliationScheduler`,
`services/postgresql/scheduler.js`) в `services/postgresql/app.js` — до
Stage 8 `sweepTimeouts` тоже не был подключён ни к чему на PostgreSQL-
стороне (заказы никогда не истекали бы по SLA).

**Авторизация/IDOR** — подтверждено (не новая работа): `order_access_
credentials` (256-битный bearer-токен, SHA-256, Wave 5/Stage 1) уже
защищает все чувствительные маршруты, публичный код заказа сам по себе
доступа не даёт.

**Тесты** — новый файл `server/test/postgresql/paymentSafetyStage8.test.js`,
30 тестов (webhook authenticity против реального `YookassaProvider` +
управляемого fake HTTP-транспорта, refund orchestration включая
5-итерационную конкурентную гонку, reconciliation, authorization
regression). Три существовавших теста обновлены под теперь исправленное
поведение (`orderServiceWave2.test.js`, `applicationAssemblyStage7.test.js`
F2/F3, `yookassaProviderCreatePayment.test.js`) — не удалены, а развиты
вслед за намеренным изменением, тот же принцип, что Stage 7's `C3`/`C9`.
5 прогонов Stage 8 suite подряд стабильно зелёные; полный
`npm run test:postgresql` — 512/512, 2 прогона подряд чисто.

## Production Switch — Stage 9 (production infrastructure — PARTIALLY COMPLETED)

Девятая задача Production Switch — подготовка production-инфраструктуры
(VPS/PostgreSQL-сервер/Nginx/SSL/деплой), НЕ сам Production Switch.
**Статус: PARTIALLY COMPLETED, честно, не скрыто.** В окружении, где
готовился этот этап, физически нет доступа ни к какому VPS/хостинг-
аккаунту (подтверждено: `docs/PROJECT_BACKLOG.md` прямо гласит "VPS ещё не
выбран", нет записей в `~/.ssh/known_hosts`/`config`, никакого IP/hostname
нигде в репозитории) и нет реальных YooKassa test credentials (`.env.example`
содержит только пустые плейсхолдеры). Полная детализация — в отдельном
[`server/docs/postgresql-deployment-runbook.md`](./postgresql-deployment-runbook.md).

**Реально выполнено и живо протестировано** (не требует реального
сервера): найден и закрыт реальный, ранее не описанный пробел —
`services/postgresql/app.js` не имел НИКАКОЙ `trust proxy` конфигурации.
Без неё, даже за реальным Nginx, `req.ip` не отражал бы
`X-Forwarded-For` — делая `isTrustedYookassaIp()` (Stage 8) бессмысленной
проверкой. Добавлен дословный аналог SQLite `server.js`'s
`TRUST_PROXY=loopback`-паттерна (fail-closed на любое другое значение,
обязателен при `APP_ENV=production`) — подтверждено 7 живыми тестами
(`server/test/postgresql/trustProxyStage9.test.js`), включая сквозную
проверку через реальный webhook-маршрут (подделанный `X-Forwarded-For` не
обманывает IP-гейт без `TRUST_PROXY=loopback`, корректно распознаётся с
ним).

**Подготовлено, но НЕ проверено вживую** (артефакты для будущего реального
деплоя): `server/deploy/yaam-backend-postgresql.service` (systemd),
`server/deploy/nginx-yaam-postgresql.conf` (reverse proxy + security
headers + trust proxy контракт), `server/deploy/setup-ssl.sh`
(Let's Encrypt bootstrap), `server/.env.postgresql.example` (production ENV
шаблон на основе фактически читаемых приложением переменных).

**Явно НЕ выполнено, честно задокументировано** (задание прямо требует не
выдумывать): реальный VPS не создан, реальный production PostgreSQL-сервер
не поднят, реальный Nginx/SSL не настроены, реальный YooKassa test-аккаунт
не подключён (credentials отсутствуют) — раздел 7 `postgresql-payment-safety.md`'s
чеклиста (create payment/webhook/refund/duplicate/timeout/cancellation/
reconciliation против настоящего API ЮKassa) не выполнен.

**IP-allowlist** — решение зафиксировано явно (задание требовало решения,
не уклонения): остаётся выключенным
(`YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST=false`) до тех пор, пока Trust
Proxy validation (раздел 6 runbook) не будет выполнена вручную на реальном
сервере — корректность X-Forwarded-For сегодня невозможно гарантировать
без реального Nginx. Это не блокер безопасности — канонический lookup
(Stage 8) остаётся единственным обязательным механизмом подлинности webhook.

`server.js` (SQLite) не изменён. Никакой Production Switch не выполнен —
пользователи не переведены, боевые credentials не подключены.

## Известные обязательные риски (не устранены, зафиксированы для будущих волн)

Унаследованные от бота (Stage 3) два пункта (отсутствие ownership-проверки,
`telegram_chat_id` не `UNIQUE`) — уже существующие продуктовые/архитектурные
решения SQLite-оригинала, зафиксированы для будущего явного product/
security-решения, не баги переноса. Маршрутный баг admin.js (Stage 4) —
**исправлен на PostgreSQL-стороне в Stage 7** (см. выше), но **остаётся
непочатым на SQLite-стороне** (`routes/admin.js`, живой production-путь) —
требует отдельного явного product-решения вне мандата PostgreSQL-миграции.
Ни Stage 5, ни Stage 6 не добавили новых рисков этой категории — все
проверенные race conditions (Stage 5) оказались безопасны по конструкции, а
Stage 6 — чисто инфраструктурная задача, не затрагивающая бизнес-логику.

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

## Последние подтверждённые результаты (после Production Switch Stage 8)

| Набор | Результат |
|---|---|
| PostgreSQL (`npm run test:postgresql`, включая новый `paymentSafetyStage8.test.js`) | 512/512 |
| PostgreSQL `concurrency.test.js` отдельно | 14/14 |
| SQLite (`npm test`, включая существующий HTTP integration suite) | 333/333 |
| **Итого** | **859/859** (0 failed) |

Полный агрегатный прогон (`test/postgresql/*.test.js`) — два чистых прогона
подряд, без флапанья (512/512 оба раза). Stage 8 suite
(`paymentSafetyStage8.test.js`) — 30/30, запущен 5 раз подряд, стабильно
зелёный на всех прогонах. На первом (до правок трёх обновлённых тестов)
прогоне агрегата встретился уже известный, несвязанный со Stage 8 flake
(`orderServiceWave5.test.js` — SERIALIZABLE-retry timing под нагрузкой
параллельных test-файлов, тот же класс, что документирован в Stage 6/7) —
подтверждён стабильно зелёным (3/3) при изолированном перезапуске.

## Итоговый статус SQL-side PostgreSQL-миграции + Production Switch

**SQL-side миграция завершена** (Wave 1-7): все 15 строк 15-пунктовой
concurrency-матрицы, не требующие реального сетевого вызова провайдера,
перенесены и живо протестированы против настоящего embedded PostgreSQL
16.14 (Wave 1: 3, Wave 2: 4, Wave 3: 3, Wave 4: 3, Wave 5: 1, Wave 6: 1,
Wave 7: 1 = 16 функций суммарно по волновому учёту).

**Production Switch Stage 1 завершён**: `server/routes/api.js` полностью
портирован на PostgreSQL (`server/routes/postgresql/api.js`, изолирован, не
подключён к `server.js`).

**Production Switch Stage 2 завершён**: `services/postgresql/orderService.js`
получил собственный `orderEvents` (`EventEmitter`), все 8 SQLite-точек
эмиссии перенесены с идентичными именами/payload, один гвард-паттерн
намеренно изменён на более безопасный под реальной конкуренцией.

**Production Switch Stage 3 завершён**: изолированный PostgreSQL-порт
`server/bot/postgresql/index.js` — все команды/callback SQLite-оригинала
перенесены, подписан на `orderEvents`, с fake-Telegram-клиентом для тестов
(без реального token/сети).

**Production Switch Stage 4 завершён**: изолированный PostgreSQL-порт
`server/routes/postgresql/admin.js` — все реально существующие маршруты
(14 из 14) перенесены; часть сценариев, ожидаемых заданием, но отсутствующих
в фактическом коде, честно НЕ изобретена. Найден и задокументирован
серьёзный, унаследованный от SQLite-оригинала маршрутный баг (редактирование
ресторана недостижимо из-за порядка регистрации `/restaurants/:id/` vs
`/restaurants/:id`) — воспроизведён один в один, не исправлен (вне мандата
Stage 4).

**Production Switch Stage 5 завершён**: изолированный
`server/services/postgresql/scheduler.js` с явной `start()`/`stop()` моделью
оборачивает новую `sweepPauseExpiry()` (`services/postgresql/orderService.js`)
— PostgreSQL теперь имеет полный аналог `pauseRestaurant()`/
`resumeRestaurant()`/автоматического снятия паузы. Все явно проверенные race
conditions (manual resume vs. sweep, повторный sweep, два конкурентных
scheduler'а, "рестарт" через новый инстанс) оказались безопасны по
конструкции — ни SERIALIZABLE, ни блокировки не потребовались.

**Production Switch Stage 6 завершён**: операционная инфраструктура для
PostgreSQL-стороны — `db/postgresql/bootstrap.js` (env-валидация + retry
подключения), `services/postgresql/health.js` (liveness/readiness),
`services/postgresql/lifecycle.js` (start/stop-координация без
`process.exit()` внутри), `server/server.postgresql.js` (изолированная,
никогда не запускаемая автоматически точка входа с health-эндпоинтами,
scheduler'ом и полным graceful shutdown). `server.js` не изменён ни строкой.
Production-приложение по-прежнему полностью на SQLite — переключение
(Stage 8 будущей последовательности) не выполнено и не запланировано как
часть Stage 1-6.

**Production Switch Stage 7 завершён**: полная сборка PostgreSQL-приложения
поверх Stage 6 lifecycle-скелета — `server/services/postgresql/app.js`
(`createPostgresqlApp()`) монтирует публичный API, admin (с локальным
фиксом найденного Stage 4 маршрутного бага), YooKassa webhook (raw-body,
верификация по-прежнему блокирована), бот (новый lifecycle-адаптер),
readiness-гейт (Variant A), CORS (переиспользован `config/cors.js`),
dev-route gating (уже существовавший тройной гейт Stage 1, подтверждён
тестом на уровне сборки), централизованный error handler, graceful
shutdown. `server.postgresql.js` стал тонкой точкой входа.
`server.js`/`routes/admin.js` (SQLite) не изменены ни строкой.
Production-приложение по-прежнему полностью на SQLite.

**Production Switch Stage 8 завершён**: `YookassaProvider.verifyWebhook()`
реализована (канонический lookup, официально подтверждённая модель
подлинности ЮKassa — HMAC/подписи в API не существует). Найден и закрыт
более серьёзный, ранее не названный пробел: сетевая оркестрация возвратов
на PostgreSQL-стороне не существовала вообще (Wave 7 перенесла только
claim) — добавлены `ensureRefundReady`/`scheduleRefundProcessing`/
`sweepStuckRefunds`, подключены во всех четырёх местах, резервирующих
возврат. Reconciliation — bounded batch + `FOR UPDATE SKIP LOCKED` + новый
частичный индекс. Авторизация подтверждена уже существующей (Wave 5).
`server.js` не тронут за исключением одной строки (`await` в общем
webhook-модуле, необходимо для корректности при реальном провайдере).
Production-приложение по-прежнему полностью на SQLite.

## Что осталось до Production Switch

1. **Stage 9 — сам Production Switch** (инфраструктурный: реальный
   VPS/staging деплой, DNS/reverse proxy, создание реальной production
   PostgreSQL БД) — не выполнялся. Stage 7-8 подготовили полностью
   собранное, протестированное, платёжно-безопасное PostgreSQL-приложение,
   готовое для staging-прогона.
2. **Backup/restore для реального PostgreSQL** — только рекомендации
   (`pg_dump`/`pg_basebackup`/WAL-архивирование), не отдельные npm-скрипты —
   реальной production PostgreSQL БД ещё не существует, писать скрипт
   резервного копирования не для чего (в отличие от SQLite, где `npm run
   backup` уже работает против реального `yaam.db`).
3. **YooKassa production validation против боевого аккаунта** —
   `createPayment()`/`getStatus()`/`refund()`/`getRefund()`/`verifyWebhook()`
   реализованы и живо протестированы против управляемого fake-транспорта
   (Stage 8), но НЕ против реальной сети ЮKassa/боевых credentials — это
   Stage 9/10.
4. **IP-allowlist enforcement для webhook** — код готов
   (`isTrustedYookassaIp()`, Stage 8), не включён по умолчанию — зависит от
   корректной настройки `TRUST_PROXY`/reverse-прокси, которых ещё нет.
5. **Продуктовое решение по такому же маршрутному багу в SQLite
   `routes/admin.js`** (`/restaurants/:id/` перехватывает `/restaurants/:id`)
   — на PostgreSQL-стороне исправлено в Stage 7; SQLite-оригинал не тронут
   (затрагивает ЖИВОЙ production-путь), требует отдельного явного решения.
6. **Reconciliation improvements** (опционально) — подключение дормантного
   `getRefund()` к периодической сверке (сегодня `sweepStuckRefunds`
   полагается на синхронный ответ `refund()`), опциональная подписка на
   `refund.succeeded` webhook.
7. **Продуктовое решение по двум унаследованным от SQLite-оригинала
   ограничениям bot'а** (не блокер, но требует отдельного явного решения
   перед реальным production-использованием бота): отсутствие
   ownership-проверки на мутирующих callback, отсутствие `UNIQUE` на
   `telegram_chat_id` — см. `postgresql-bot-port.md`.

## Правило обновления

**После каждой PostgreSQL migration wave этот файл обновляется ТЕМ ЖЕ
коммитом, что и код волны.** Не отдельным последующим коммитом — одним и тем
же, чтобы `git log` никогда не показывал волну без синхронно обновлённого
статуса.
