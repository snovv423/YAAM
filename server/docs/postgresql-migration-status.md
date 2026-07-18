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
| 14 | Order Service Migration — Wave 7 (финальная, claimRefundForProcessing) | этот же коммит — точный hash самоссылочен и не фиксируется здесь (см. `git log -1` или последний коммит на ветке) |

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

## Последние подтверждённые результаты (после Wave 7)

| Набор | Результат |
|---|---|
| PostgreSQL (`npm run test:postgresql`) | 257/259 passed, 2 skipped (явно, с причиной) |
| SQLite (`npm test`) | 333/333 |
| SQLite `refundConcurrency.test.js` (не менялся, подтверждён) | 16/16 |
| **Итого** | **606/608** (2 skipped, 0 failed) |

Все наборы — минимум два чистых прогона подряд, без флапанья на повторах
(Wave 7 test-файл — 18/18, проверен на 10 повторных прогонах, требуемых для
concurrency-sensitive финальной волны; отдельный стресс-прогон 5
concurrency-тестов claim — 20/20 без единого падения/дедлока;
concurrency-suite — 14/14 стабильно). При одном из прогонов полного
`npm run test:postgresql` под совокупной нагрузкой всех volumes зафиксирован
единичный флап в НЕ относящемся к Wave 7 тесте (`orderServiceWave5.test.js`,
write-skew retry на `createOrder`, код которого в этой волне не менялся) —
изолированный повторный прогон этого файла 5/5 раз подтвердил его
самостоятельную стабильность; отнесено к тайминг-чувствительности
совокупной нагрузки embedded PostgreSQL при последовательном запуске всех
test-файлов, не к изменениям Wave 7.

## Итоговый статус SQL-side PostgreSQL-миграции

**Завершена.** Все 15 строк 15-пунктовой concurrency-матрицы, не требующие
реального сетевого вызова провайдера, перенесены и живо протестированы
против настоящего embedded PostgreSQL 16.14 (Wave 1: 3, Wave 2: 4, Wave 3: 3,
Wave 4: 3, Wave 5: 1, Wave 6: 1, Wave 7: 1 = 16 функций суммарно по волновому
учёту).

## Что осталось вне PostgreSQL-миграции (не следующий "wave", а другой этап)

Следующих SQL-side волн переноса `orderService.js` больше нет. Оставшееся —
качественно другой класс задач:

1. **Production switch** — реальное переключение работающего приложения
   (`server.js`/`routes/`/`bot/`) на PostgreSQL-модуль. Не начато, не
   запланировано ни в одной волне — весь перенос по сей день строго
   изолирован и не импортируется рабочим кодом.
2. **PostgreSQL deployment / VPS** — managed PostgreSQL инстанс, миграция
   реальных данных, backup/restore под PostgreSQL. Не начато.
3. **YooKassa production validation** — `createPayment()`/`getStatus()`/
   `refund()`/`getRefund()` реализованы (не переносились в этой волне,
   принадлежат SQLite-стороне, задокументированы в `refund-architecture-
   review.md`), но не валидированы вживую против настоящего боевого
   аккаунта ЮKassa.
4. **`YookassaProvider.verifyWebhook()`** — единственный метод провайдера,
   реально бросающий `not implemented` (не устаревшая формулировка — актуальный
   факт кода на момент этой записи). Блокирует реальный
   production payment-webhook независимо от темы возвратов.
5. **Реальный сетевой оркестратор `ensureRefundReady()` и
   `sweepStuckRefunds()`** — claim-половина перенесена (Wave 7), но сама
   оркестрация (вызов `paymentService.refundPayment()`/провайдера, решение
   succeeded/failed по результату) осталась только в SQLite-версии — по
   архитектурному принципу, применённому во ВСЕХ волнах: реальный сетевой
   вызов провайдера никогда не переносится в изолированный PostgreSQL-модуль.
6. **Reconciliation improvements** (опционально, не требуется для
   корректности) — подключение уже реализованного, но нигде не вызываемого
   `YookassaProvider.getRefund()` для сверки статуса возврата напрямую у
   провайдера; refund-webhook (сегодня не существует вообще, sweep уже
   самодостаточен).

## Правило обновления

**После каждой PostgreSQL migration wave этот файл обновляется ТЕМ ЖЕ
коммитом, что и код волны.** Не отдельным последующим коммитом — одним и тем
же, чтобы `git log` никогда не показывал волну без синхронно обновлённого
статуса.
