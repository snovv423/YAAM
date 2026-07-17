# PostgreSQL migration — статус

Компактный, постоянно обновляемый operational source of truth. Не пересказывает
PDF-отчёты — только текущее состояние и ссылки. Обновляется тем же коммитом,
что и код каждой новой volна (правило см. в конце файла).

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

Итого 7 функций перенесены и живо протестированы против настоящего embedded
PostgreSQL 16.14; 8 функций и весь refund-сетевой конвейер — ещё нет (см. ниже).

## Известные обязательные риски (не устранены, зафиксированы для будущих волн)

1. **`ensureRefundReady`** — claim-UPDATE без достаточного `WHERE`-guard (сегодня
   безопасно только благодаря синхронности SQLite; под PostgreSQL — реальная
   гонка). Не исправлялся ни разу — аудит в Wave 2 подтвердил, что это НЕ
   влияет на `reserveRefundRow` (структурно другой, уже безопасный механизм).
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

## Последние подтверждённые результаты (после Wave 2, `a221991`)

| Набор | Результат |
|---|---|
| PostgreSQL (`npm run test:postgresql`) | 124/124 |
| SQLite (`npm test`) | 333/333 |
| **Итого** | **457/457** |

Оба набора — минимум два чистых прогона подряд, без флапанья на повторах.

## Следующий рекомендуемый этап

Wave 2 завершена. Кандидаты для Wave 3 (см. `YAAM-postgresql-order-service-
wave-2.pdf`, раздел 19):
- `sweepTimeouts` per-order — та же claim-схема, что `restaurantDecline`/
  `cancelByCustomer`, плюс перенос cron-подобного паттерна свипа.
- Либо начать проектирование сетевой части refund-конвейера
  (`ensureRefundReady`) — требует решения по интеграции с YooKassa-провайдером
  в PostgreSQL-контексте; существенно более рискованный и объёмный этап.

## Правило обновления

**После каждой PostgreSQL migration wave этот файл обновляется ТЕМ ЖЕ
коммитом, что и код волны.** Не отдельным последующим коммитом — одним и тем
же, чтобы `git log` никогда не показывал волну без синхронно обновлённого
статуса.
