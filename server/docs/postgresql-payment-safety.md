# PostgreSQL YooKassa payment/refund production safety — Production Switch Stage 8

Закрывает единственный оставшийся Stage 7 блокер (`YookassaProvider.
verifyWebhook()` — `"not implemented"`) и достраивает недостающую
PostgreSQL-сторону оркестрации возвратов, которая до этой задачи была
представлена только claim-половиной (Wave 7). Ничего из этого не подключено
к production — `server.js` (SQLite) не изменён ни строкой, за одним
точечным исключением (см. раздел "Единственная правка на SQLite-стороне").

## Официальная документация ЮKassa, использованная при реализации

- `yookassa.ru/developers/using-api/webhooks` — модель подлинности
  уведомлений, список IP-диапазонов, ожидаемый HTTP-ответ (200),
  поведение повторной доставки (retry до 24 часов).
- Официальные контракты `POST /v3/payments`, `GET /v3/payments/{id}`,
  `POST /v3/refunds`, `GET /v3/refunds/{id}` и Sandbox testing — источник
  истины для request/response, `test=true`, статусов и test payment method.

**Ключевой факт, подтверждённый документацией**: у ЮKassa **нет** HMAC/
подписи тела уведомления. Единственные официально рекомендованные способы
установить подлинность — (а) IP-адрес отправителя из документированного
списка, (б) переспросить канонический объект напрямую через тот же
авторизованный API. Ничего похожего на подпись здесь **не изобретено**.

## Webhook authenticity — точный поток верификации

`YookassaProvider.verifyWebhook(rawBody, headers)` (`services/
paymentProviders/yookassaProvider.js`), теперь `async`:

1. Размер тела ≤ 64KB (defense-in-depth поверх Express-лимита, см. ниже).
2. `JSON.parse` — некорректный JSON → `null`.
3. `payload.type === 'notification'` и `payload.event` — один из
   `payment.succeeded`/`payment.canceled`/`refund.succeeded`; что-либо ещё
   (включая `payment.waiting_for_capture`, который не используется при
   `capture=true`) → `null` без сетевого вызова.
4. `object.id` — непустая строка, иначе `null`.
5. **Каноническая проверка** — `this.getStatus(object.id, {amount,currency})`
   и протестирован в предыдущих задачах HTTP-клиент/Basic
   Auth/AbortController/классификация ошибок — переиспользован без
   изменений). Сетевая ошибка/таймаут/404 → `null` (fail closed).
6. Канонический статус ОБЯЗАН совпадать с ожидаемым для заявленного event
   (`payment.succeeded` → `'succeeded'`, `payment.canceled` → `'failed'`) —
   несовпадение → `null`.
7. Для payment возвращает `{type:'payment', providerPaymentId, status,
   amount, currency}`. Для refund выполняет канонический `getRefund()` с
   проверкой `payment_id`/amount и возвращает типизированное refund-событие.

**IP-allowlist** (`isTrustedYookassaIp()`, экспортирован как статическое
свойство класса) — официальные диапазоны (`185.71.76.0/27`, `185.71.77.0/27`,
`77.75.153.0/25`, `77.75.156.11`, `77.75.156.35`, `77.75.154.128/25`,
`2a02:5180::/32`). Применяется **опционально**, в
`routes/postgresql/api.js`, ДО вызова `verifyWebhook()`, только если явно
включено `YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST=true`. **Не включено по
умолчанию** — корректность `req.ip` зависит от правильно настроенного
доверия к reverse-прокси, которого ещё нет (реальный VPS/NGINX — Stage 9).
До Stage 9 канонический lookup (шаг 5-6 выше) остаётся ЕДИНСТВЕННЫМ
обязательным механизмом подлинности — он самодостаточен (см. раздел
"Почему канонический lookup достаточен" ниже) и не зависит от прокси.

### Почему канонический lookup достаточен сам по себе

Подделать успешную каноническую проверку может только тот, кто уже знает
секретный ключ магазина (`YOOKASSA_SECRET_KEY`, используется в Basic Auth
запроса `getStatus()`) — а такой атакующий и без поддельного webhook мог бы
напрямую вызвать `createPayment`/`refund` через реальный API. Тело САМОГО
уведомления, таким образом, перестаёт быть источником истины — это только
триггер "пойди проверь объект с этим id своими credentials".

## Сверка суммы/валюты — где именно происходит

Webhook-проверка сначала сопоставляет amount/currency тела с каноническим
Payment/Refund YooKassa, затем `routes/postgresql/api.js` независимо
сравнивает канонически подтверждённую сумму с локальным `payments.amount`,
`event.currency` — с жёстко зашитым `'RUB'` (вся система однозначно
рублёвая — валютной колонки в схеме сознательно нет, добавлять её ради
Stage 8 было бы избыточным изменением схемы под то, что и так везде
константа). Несовпадение → `400`, `markPaid`/`markPaymentFailed` НЕ
вызываются.

## Middleware/HTTP защита webhook-маршрута

`routes/postgresql/api.js`: `express.raw({ type: 'application/json', limit: '64kb' })` —
явный лимит размера тела на HTTP-уровне (сверх уже существующего
дефолтного лимита `express.json()` для остальных маршрутов), 413 для
превышения. Middleware-порядок (Stage 7, не изменён) сохраняет raw-body
carve-out изолированным от глобального JSON-парсера. Логи — только метод/
путь/статус/id/provider-payment-id/reason — НИКОГДА тело запроса,
`Authorization`, секретный ключ, полный webhook payload.

## Refund network orchestration — недостающая PostgreSQL-сторона (главное изменение Stage 8)

**Найденный при архитектурном анализе (не в изначальном задании) критический
пробел**: Wave 7 перенесла ТОЛЬКО `claimRefundForProcessing()` — claim-
половину SQLite `ensureRefundReady()`. Сетевой вызов провайдера и
финализация (`ensureRefundReady`/`scheduleRefundProcessing`/
`sweepStuckRefunds` целиком) на PostgreSQL-стороне до Stage 8 **не
существовали вообще**. Практическое следствие: `reserveRefundRow()`
(вызывается из `cancelByCustomer`/`restaurantDecline`/`sweepTimeouts`/
`markPaid`'s поздней-отмены-ветки) резервировала строку возврата в
`refunds.status='requested'` — и на этом всё заканчивалось НАВСЕГДА. Деньги
клиенту физически никогда не возвращались бы на PostgreSQL-стороне. Это
более серьёзный, менее очевидный блокер, чем изначально названный
`verifyWebhook()` — обнаружен и закрыт в рамках этой же задачи.

### Добавлено (`services/postgresql/orderService.js`)

- `providerRefundTimeoutMs()`/`refundPaymentWithTimeout()` — дословный порт
  `Promise.race`-обёртки SQLite-оригинала.
- `processClaimedRefund(claimedRefund)` — общая "пост-claim" половина:
  сетевой вызов провайдера + финализация, СТРОГО вне какой-либо открытой
  транзакции (тот же принцип, что и everywhere else в модуле). Сетевая
  ошибка/таймаут → строка остаётся `processing` с уже выставленным (при
  claim, ДО await) `next_attempt_at` — не бросается наружу, ловится и
  логируется.
- `ensureRefundReady(refundId)` — построена НА ТОП уже существующего
  `claimRefundForProcessing` (Wave 7, не изменён): claim → (если выигран)
  `processClaimedRefund`. Собственная in-flight `Map`
  (`refundOrchestrationInFlight`), намеренно ОТДЕЛЬНАЯ от
  `claimRefundForProcessing`'s собственной `refundAttemptInFlight` — та
  охватывает только claim-шаг (Wave 7 тесты полагаются на эту узкую роль),
  эта — весь оркестратор целиком (тот же периметр, что у SQLite-оригинала).
  Обе — чисто внутрипроцессные fast-path оптимизации; основная защита в
  обоих случаях — SQL WHERE-guard внутри `claimRefundForProcessing`.
- `scheduleRefundProcessing(refundId)` — fire-and-forget обёртка
  (`ensureRefundReady(...).catch(log)`), вызывается СТРОГО после `COMMIT`
  бизнес-транзакции, никогда изнутри неё.
- `sweepStuckRefunds({limit})` — периодическая сверка, см. ниже.

### Точки подключения (все четыре места, где `reserveRefundRow` уже вызывался)

`cancelByCustomer`, `restaurantDecline`, `sweepTimeouts` (per-order внутри
свипа), `markPaid`'s ветка "поздняя оплата уже отменённого заказа" — каждая
теперь захватывает возвращённую `reserveRefundRow()` строку в
транзакционной области видимости и, СТРОГО после успешного `commit`
(`await db.transaction(...)` уже вернул управление), вызывает
`scheduleRefundProcessing(refundRow.id)` без `await` — тот же принцип, что
и у SQLite-оригинала: бизнес-переход не блокируется на сетевой round-trip к
провайдеру, клиент узнаёт результат при следующем `poll` через
`order.refund_status`.

## Reconciliation — sweepStuckRefunds()

Периодическая сверка "зависших" возвратов — `requested`-строк, чей
провайдер-вызов вообще не успел стартовать (падение процесса между commit и
`scheduleRefundProcessing`), и `processing`-строк с истёкшим
`next_attempt_at` (предыдущая попытка закончилась неоднозначно, либо
падение процесса во время сетевого вызова).

**Bounded batch + `FOR UPDATE SKIP LOCKED`** — один атомарный SQL-запрос
(`WITH candidates AS (SELECT ... FOR UPDATE SKIP LOCKED) UPDATE ... FROM
candidates RETURNING *`): выбирает до `limit` (default 50) кандидатов,
СРАЗУ ЖЕ атомарно claim'ит их (та же backoff-формула, что у
`claimRefundForProcessing`, выраженная в SQL — `LEAST(base*2^(attempt_count
+1), cap)`), возвращает уже захваченные строки одним round-trip'ом. Новый
частичный индекс `ix_refunds_pending_sweep` (см. "Миграции" ниже)
обеспечивает, что запрос не сканирует всю таблицу.

`SKIP LOCKED` — НЕ основной механизм безопасности (им остаётся тот же
WHERE-guard внутри самого claim, работающий межпроцессно/межинстансно
независимо ни от чего) — снижает бесполезную конкуренцию между несколькими
одновременно тикающими sweep'ами (в одном процессе или в разных инстансах
приложения), не является единственной линией защиты от двойной обработки.
Живо доказано тестом (несколько конкурентных `sweepStuckRefunds()`/
`ensureRefundReady()` на одну строку — ровно один финальный переход).

После bounded-claim'а — для каждой захваченной строки `processClaimedRefund`
выполняется вне транзакции (сетевой вызов, тот же принцип).

### Scheduler wiring

`services/postgresql/scheduler.js` — два новых фабричных `start()`/`stop()`/
`isRunning()`/`runOnce()`-обёртки (тот же паттерн, что уже был у Stage 5
`createPauseExpiryScheduler`): `createOrderTimeoutScheduler` (обёртывает
`sweepTimeouts` — до Stage 8 НЕ был вообще подключён ни к чему на
PostgreSQL-стороне, заказы никогда не истекали бы по SLA), 
`createRefundReconciliationScheduler` (обёртывает `sweepStuckRefunds`).
Оба подключены в `services/postgresql/app.js` — добавлены в
`lifecycle.js`'s `schedulers`-массив (сам `lifecycle.js`, Stage 6, НЕ
изменён — интерфейс уже подходил) и в `health.js`'s `getSchedulers()`
(наблюдаемое поле `/health/ready`). Провайдер-outage (временная
недоступность ЮKassa при sweep) НЕ делает сервис "неготовым" — заказы
физически принимаются/оплачиваются независимо от того, успевает ли в этот
момент завершиться отложенный возврат.

## Late-payment policy (уже существовала, задокументирована здесь)

`markPaid()`/`markPaymentFailed()` уже реализуют корректную политику для
всех сценариев "поздний исход после того, как локальное состояние
изменилось иначе" — не новая работа Stage 8, а уже существовавшая с Wave 2
защита, которую Stage 8 наконец довела до реального денежного эффекта:

- **Поздняя успешная оплата уже отменённого заказа** (`order.status ===
  'cancelled'`): `payment` помечается `succeeded` (провайдер объективно
  получил деньги — фиксируется честно, не скрывается), заказ НЕ
  воскрешается, атомарно (в той же транзакции) резервируется возврат;
  теперь (Stage 8) он реально доходит до провайдера.
- **Обычный путь**: `awaiting_payment → awaiting_restaurant`, идемпотентно
  (повторный webhook — no-op через `WHERE status='pending'`).
- **Неожиданный статус заказа** (ни `awaiting_payment`, ни `cancelled`) —
  `throw` (fail-loud) — не молчаливое рассогласование.
- Аналогичная защита — в `restaurantDecline`/`sweepTimeouts`/
  `cancelByCustomer`: возврат резервируется атомарно вместе с бизнес-
  переходом, СТРОГО в той же транзакции (никогда отдельным шагом).

## Идемпотентность — сводка существующих и новых механизмов

| Граница | Механизм |
|---|---|
| Создание платежа (провайдер) | `provider_idempotency_key`, UNIQUE (уже было) |
| Подтверждение оплаты (`markPaid`/`markPaymentFailed`) | `WHERE status='pending'` conditional UPDATE (уже было) |
| Создание возврата (`reserveRefundRow`) | `ux_refunds_one_active_per_payment` partial UNIQUE (уже было) |
| Успешный возврат применяется один раз | `ux_refunds_one_succeeded_per_payment` partial UNIQUE (уже было) |
| Claim возврата на обработку | lease-guarded conditional UPDATE, Wave 7 (уже было) |
| **Полный оркестратор возврата** (claim+сеть+finalize) | **новое**: process-local `refundOrchestrationInFlight` Map + межпроцессный SQL WHERE-guard |
| **Bounded reconciliation batch** | **новое**: `FOR UPDATE SKIP LOCKED` |
| Webhook-подлинность | **новое**: канонический lookup (см. выше) |
| Order access (не связано с платежами напрямую, но та же категория) | 256-бит bearer-токен, SHA-256 хеш, уже было (см. "Авторизация" ниже) |

Идемпотентность возврата переживает: рестарт процесса (SQL-guard не
завязан на память), retry со стороны sweep (та же lease-семантика), гонку
двух инстансов приложения (тот же SQL-guard, PostgreSQL — клиент-серверная
СУБД с нормальной многопользовательской конкурентностью, см. Stage 5/6).

## Авторизация / IDOR — уже реализовано, только подтверждено тестами

**Не новая работа Stage 8** — при архитектурном аудите подтверждено, что
`order_access_credentials` (256-битный bearer-токен, SHA-256 хеш,
`request_hash`, привязка 1:1 к заказу через `PRIMARY KEY(order_id)`)
УЖЕ существует с более раннего этапа (Wave 5/Stage 1) и УЖЕ защищает все
чувствительные маршруты (`GET /orders/:code`, `cancel`, `retry-payment`,
`rate`, `dev-confirm-payment`) через `requireOrderAccess` middleware —
публичный код заказа (`YAAM-00001`) сам по себе НЕ даёт доступа. Токен
никогда не логируется (только парсится, не выводится в `console.error`).
Сравнение — через индексированный SQL `WHERE token_hash = $2` (SHA-256 от
256-битного случайного секрета) — не timing-attack-уязвимая ручная
построчная сверка низкоэнтропийного значения, стандартный, безопасный
паттерн (тот же, что у Stripe/GitHub API-токенов). Тесты (раздел D,
`paymentSafetyStage8.test.js`) подтверждают: без токена — 401; неверный
токен — 401/404; токен одного заказа не даёт доступа к другому.

## Миграции / ограничения БД

Единственное изменение схемы — чисто аддитивное, идемпотентное:

```sql
CREATE INDEX IF NOT EXISTS ix_refunds_pending_sweep
  ON refunds (next_attempt_at) WHERE status IN ('requested', 'processing');
```

Партиальный (не растёт с накоплением `succeeded`/`failed` строк), безопасен
и на свежей, и на уже существующей Stage 7 базе (реальной production
PostgreSQL БД ещё не существует — отдельная система миграций/rollback не
требуется на этом этапе, тот же принцип, что и во всех предыдущих этапах).
Никаких других изменений схемы — существующие ограничения (`ux_refunds_
one_active_per_payment`, `ux_refunds_one_succeeded_per_payment`, `ux_
refunds_provider_reference`, `provider_idempotency_key UNIQUE`) уже
production-safe, ничего добавлять не потребовалось.

## Единственная правка на SQLite-стороне

`routes/api.js` — ОДНА строка: `paymentService.verifyWebhook(...)` теперь
`await`-ится. Необходимо: `paymentService.js`/`providerInterface.js`/
`mockProvider.js`/`yookassaProvider.js` — общие (не PostgreSQL-специфичные)
модули; без этого await здесь остался бы тихий баг (Promise трактовался бы
как truthy событие), если `PAYMENT_PROVIDER=yookassa` когда-либо будет
включён на SQLite-стороне. Никакая другая логика этого файла не менялась —
амount/currency-сверка, IP-allowlist и т.п. НЕ добавлены на SQLite-сторону
(вне мандата — SQLite production сегодня работает только на `mock`).

## Тесты

`server/test/postgresql/paymentSafetyStage8.test.js` — 37 тестов, разделы
A (webhook authenticity/payment/refund/restart, 17 тестов — реальный `YookassaProvider` против
управляемого fake HTTP-транспорта, не заглушка бизнес-логики), B (refund
orchestration, 8 тестов — реальный сквозной путь через mock-провайдер,
включая 5-итерационную конкурентную гонку `cancelByCustomer`), C
(reconciliation, 5 тестов), D (authorization regression, 4 теста), E
(structural sanity, 2 теста). Плюс обновлены три существовавших теста,
чьи ассерты документировали ТЕПЕРЬ ИСПРАВЛЕННОЕ, неполное поведение (не
удалены — развитие покрытия вслед за намеренным изменением, тот же принцип,
что и Stage 7's `adminStage4.test.js` C3/C9):
`orderServiceWave2.test.js`'s `markPaid: поздняя оплата...` (раньше
проверял, что возврат застревает в `requested` — теперь проверяет, что он
реально доходит до провайдера), `applicationAssemblyStage7.test.js`'s F2
(раньше проверял блокер "not implemented" — теперь проверяет, что маршрут
не падает на пустом теле) и F3 (монки-патч события теперь включает
amount/currency, требуемые новой сверкой), `yookassaProviderCreatePayment.
test.js`'s verifyWebhook-тест (раньше `assert.throws` синхронно — теперь
`await` + `assert.equal(result, null)`).

## Что осталось за рамками Stage 8

- **Реальная сетевая Sandbox-проверка** выполняется отдельным acceptance-
  шагом; unit/integration-тесты используют управляемый fake transport.
- **IP-allowlist enforcement по умолчанию** — код готов
  (`isTrustedYookassaIp`), но не включён по умолчанию до тех пор, пока
  Stage 9 не подтвердит корректную настройку `TRUST_PROXY`/reverse-прокси.
- **`refund.succeeded` webhook** — поддержан и канонически перепроверяется;
  дублирующая доставка идемпотентна.
- **Партиальные возвраты** — вне MVP (как и раньше, схема физически не
  меняется — тот же triggers-инвариант `amount = payment.amount`).
- **Реальный production PostgreSQL/VPS/деплой** — Stage 9.
- Собственно Production Switch (переключение `server.js` на PostgreSQL) —
  Stage 10, не начат.
