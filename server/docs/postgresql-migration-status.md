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
| 19 | Production Switch — Stage 4 (PostgreSQL admin, `server/routes/postgresql/admin.js`) | этот же коммит — точный hash самоссылочен и не фиксируется здесь (см. `git log -1` или последний коммит на ветке) |

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

## Известные обязательные риски (не устранены, зафиксированы для будущих волн)

Ничего не осталось из этой категории после Stage 4 — унаследованные от бота
(Stage 3) два пункта (отсутствие ownership-проверки, `telegram_chat_id` не
`UNIQUE`) и новый найденный маршрутный баг (Stage 4, выше) — все три
являются УЖЕ СУЩЕСТВУЮЩИМИ продуктовыми/архитектурными решениями SQLite-
оригинала, зафиксированными для будущего явного product/security-решения,
не багами переноса.

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

## Последние подтверждённые результаты (после Production Switch Stage 4)

| Набор | Результат |
|---|---|
| PostgreSQL (`npm run test:postgresql`, включая новый `adminStage4.test.js`) | 394/396 passed, 2 skipped (явно, с причиной) |
| PostgreSQL `concurrency.test.js` отдельно | 14/14 |
| SQLite (`npm test`, включая существующий HTTP integration suite) | 333/333 |
| **Итого** | **741/743** (2 skipped, 0 failed) |

Полный агрегатный прогон (`test/postgresql/*.test.js`) — минимум два чистых
прогона подряд, без флапанья на повторах (394/396 + 2 skip оба раза). Stage 4
suite (`adminStage4.test.js`) — 44/44, запущен 5 раз подряд, стабильно
зелёный на всех прогонах. Отдельно — 20-итерационный стресс-прогон
конкурентных созданий категорий + конкурентных toggle-available: 0
повреждений данных на всех итерациях. Один прогон агрегата дал уже известный
несвязанный flake в `orderServiceWave5.test.js` (тайминг-чувствительный
SERIALIZABLE-retry сценарий под нагрузкой параллельных test-файлов, не
касается admin-кода) — подтверждён стабильно зелёным при изолированном
запуске; повторный полный прогон агрегата — чистый, без флапанья.

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
Stage 4). Production-приложение по-прежнему полностью на SQLite —
переключение (Stage 8 будущей последовательности) не выполнено и не
запланировано как часть Stage 1/2/3/4.

## Что осталось до Production Switch

1. **Stage 5 — restaurant pause, оставшаяся часть** — `pauseRestaurant`/
   `resumeRestaurant` перенесены Stage 3 (нужны боту и админке);
   `sweepPauseExpiry` (периодический свип, вызывается из `server.js`
   `setInterval`) — не перенесён, вне scope изолированных wave/stage-модулей.
2. **Stage 6 — операционная обвязка** — скрипт применения схемы к реальной
   PostgreSQL БД, backup-стратегия, PostgreSQL-осведомлённый health-check,
   ENV-документация, адаптация systemd-юнита, graceful shutdown
   (`await db.close()`). Ничего из этого не создавалось ни в одной волне.
3. **Stage 7 — staging-прогон** и **Stage 8 — сам Production Switch**
   (инфраструктурный, DNS/reverse proxy) — не выполнялись.
4. **YooKassa production validation** — `createPayment()`/`getStatus()`/
   `refund()`/`getRefund()` реализованы (SQLite-сторона, независимо от этой
   миграции), но не валидированы вживую против боевого аккаунта ЮKassa.
5. **`YookassaProvider.verifyWebhook()`** — единственный метод провайдера,
   реально бросающий `not implemented`. Блокирует реальный production
   payment-webhook независимо от БД-движка.
6. **Продуктовое решение по найденному маршрутному багу admin.js**
   (`/restaurants/:id/` перехватывает `/restaurants/:id`) — затрагивает
   ЖИВОЙ SQLite-admin, не блокер Stage 5+, но требует отдельного явного
   решения перед реальным использованием формы редактирования ресторана
   (см. `postgresql-admin-port.md`).
7. **Реальный сетевой оркестратор `ensureRefundReady()` (refund) и
   `sweepStuckRefunds()`** — claim-половина перенесена (Wave 7); сама
   refund-оркестрация осталась только в SQLite-версии, сознательно не
   переносилась ни в одном из этапов (тот же принцип, что и всех волн:
   реальный сетевой вызов провайдера для refund не переносится в
   изолированный PostgreSQL-модуль без отдельного согласования).
   Payment-оркестрация (create/retry) — уже перенесена Stage 1.
8. **Reconciliation improvements** (опционально) — подключение дормантного
   `getRefund()`, опциональный refund-webhook.
9. **Продуктовое решение по двум унаследованным от SQLite-оригинала
   ограничениям bot'а** (не блокер Stage 5+, но требует отдельного явного
   решения перед реальным production-использованием бота): отсутствие
   ownership-проверки на мутирующих callback, отсутствие `UNIQUE` на
   `telegram_chat_id` — см. `postgresql-bot-port.md`.

## Правило обновления

**После каждой PostgreSQL migration wave этот файл обновляется ТЕМ ЖЕ
коммитом, что и код волны.** Не отдельным последующим коммитом — одним и тем
же, чтобы `git log` никогда не показывал волну без синхронно обновлённого
статуса.
