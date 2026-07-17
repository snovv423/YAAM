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
| 10 | Order Service Migration — Wave 4 | этот же коммит — точный hash самоссылочен и не фиксируется здесь (см. `git log -1` или последний коммит на ветке) |

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

Итого 13 функций перенесены и живо протестированы против настоящего embedded
PostgreSQL 16.14; 3 функции и весь refund-сетевой конвейер (`ensureRefundReady`
claim-шаг) — ещё нет (см. ниже).

## Известные обязательные риски (не устранены, зафиксированы для будущих волн)

1. **`ensureRefundReady`** — claim-UPDATE без достаточного `WHERE`-guard (сегодня
   безопасно только благодаря синхронности SQLite; под PostgreSQL — реальная
   гонка). Не исправлялся ни разу — аудит в Wave 2 подтвердил, что это НЕ
   влияет на `reserveRefundRow` (структурно другой, уже безопасный механизм).
   Wave 3/4 сознательно НЕ переносили этот claim-шаг — только его "выходные"
   finalize-функции, которые сами по себе этим багом не затронуты (обычный
   CU-паттерн).
2. **`rateOrder`** — read-modify-write агрегата рейтинга ресторана требует
   `SELECT ... FOR UPDATE` при переносе — единственное место во всём аудите,
   где это реально нужно.
3. **`createOrder`** — TTL-дедуп по телефону+ресторану не выражается через
   UNIQUE index, требует `serializableTransaction()` с ограниченным retry.
4. **Event emission** (`orderEvents`) ещё не подключена к PostgreSQL-версии —
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

## Последние подтверждённые результаты (после Wave 4)

| Набор | Результат |
|---|---|
| PostgreSQL (`npm run test:postgresql`) | 178/180 passed, 2 skipped (явно, с причиной) |
| SQLite (`npm test`) | 333/333 |
| **Итого** | **511/513** (2 skipped, 0 failed) |

Оба набора — минимум два чистых прогона подряд, без флапанья на повторах
(Wave 4 test-файл дополнительно проверен на 5 повторных прогонах;
concurrency-suite — 14/14 стабильно).

## Следующий рекомендуемый этап

Wave 4 завершена. Оставшиеся 3 функции из 15-пунктовой матрицы — все
архитектурно сложнее чисто-CU класса, использованного в Wave 1-4:
- `ensureRefundReady` claim-шаг — требует ЛИБО принятия решения по известному
  WHERE-guard багу (исправлять при переносе, не переносить "как есть"), ЛИБО
  решения по интеграции с YooKassa-провайдером в PostgreSQL-контексте —
  существенно более рискованный этап, отдельно от чисто-CU волн.
- `createOrder`, `rateOrder` — единственные два места, требующие
  `serializableTransaction()`/`FOR UPDATE` соответственно.

Рекомендация: следующая волна — `createOrder` или `rateOrder` (оба
самодостаточны, не зависят друг от друга и не требуют решения по
YooKassa-интеграции), оставляя `ensureRefundReady` на отдельный, отдельно
согласованный этап ввиду известного бага и провайдер-интеграции.

## Правило обновления

**После каждой PostgreSQL migration wave этот файл обновляется ТЕМ ЖЕ
коммитом, что и код волны.** Не отдельным последующим коммитом — одним и тем
же, чтобы `git log` никогда не показывал волну без синхронно обновлённого
статуса.
