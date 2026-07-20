# PostgreSQL operational readiness — Production Switch Stage 6

Подробности, для которых не хватило места в `postgresql-migration-status.md`.
Компактная сводка там же, ссылка сюда.

## Архитектурная граница

Ничего из этого файла не подключено к production. `server.js` (SQLite) не
изменён ни строкой. `server/server.postgresql.js` — изолированная точка
входа, никем не требуемая (`require`), никогда не запускаемая автоматически;
единственный способ её запустить — вручную (`node server.postgresql.js` /
`npm run start:postgresql`). Не упомянута ни в `deploy/yaam-backend.service`
(systemd-юнит SQLite-стороны), ни в `npm start`.

## Startup

`server/server.postgresql.js` → `createApp()` → `start()`:

1. `app.listen(port, host)` — HTTP-сервер начинает слушать (health-эндпоинты
   доступны сразу, до готовности БД — так readiness-проба честно отражает
   реальное состояние во время подключения, вместо "сервер вообще не
   отвечает").
2. `lifecycle.start()`:
   a. `bootstrap()` (`db/postgresql/bootstrap.js`): `validateEnv()` — fail
      fast с понятной ошибкой ДО первой попытки сети, если конфигурация
      заведомо некорректна; затем `waitForDatabase({retries, delayMs})` —
      реальный `SELECT 1` с retry/backoff (default 5 попыток по 1с).
   b. Запуск всех переданных `schedulers` (сейчас — один,
      `createPauseExpiryScheduler` из Stage 5).
   c. Регистрация `SIGTERM`/`SIGINT`-обработчиков.
3. Если bootstrap упал (БД недостижима после всех retries) — HTTP-сервер
   закрывается, ошибка пробрасывается наверх, `main()` логирует и
   `process.exit(1)` — процесс не остаётся в "наполовину живом" состоянии
   (слушает порт, но никогда не будет готов).

Сравнение с SQLite-оригиналом: `server.js` не имеет ни валидации конфигурации
(ENV читается напрямую, с молчаливыми дефолтами через `process.env.X ||
default`), ни retry-логики подключения (SQLite — локальный файл, ей нечего
ждать), ни явной bootstrap-фазы вообще — просто последовательность top-level
вызовов.

## Shutdown

`lifecycle.stop()` (вызывается либо через `onSignal`-путь при
`SIGTERM`/`SIGINT`, либо напрямую программно):

1. Снимает signal listeners (не оставляет висящих подписчиков на `process`).
2. Останавливает все `schedulers` (`clearInterval` внутри каждого).
3. Закрывает HTTP-сервер (`httpServer.close()`, дожидается завершения
   in-flight запросов).
4. Вызывает `onShutdown`-хук, если передан.
5. Закрывает пул PostgreSQL (`db.close()`).

Идемпотентно — повторный `stop()` безопасен, `stop()` до `start()` — no-op.
`main()` (реальная точка входа) — единственное место, где вызывается
`process.exit()`; сам `lifecycle.js` этого не делает нигде (важно для
тестируемости и для чистоты границы ответственности).

**Сравнение с SQLite-оригиналом**: `server.js`'s `shutdown()` — ОДНА строка
(`releaseLock(lockPath); process.exit(0);`) — не закрывает HTTP-сервер, не
гасит три `setInterval`, не закрывает БД-соединение. Это осознанно НЕ
исправлено в SQLite-стороне (вне мандата Stage 6 — "не менять продуктовую
логику"), но задокументировано здесь как известный контраст.

## Health checks

`GET /health`, `GET /health/ready` — readiness (503, если не готов):
```json
{
  "ok": true,
  "uptimeSec": 42,
  "database": { "ok": true },
  "pool": { "totalCount": 1, "idleCount": 1, "waitingCount": 0 },
  "schedulers": [{ "index": 0, "running": true }]
}
```

`GET /health/live` — liveness (всегда 200, если процесс отвечает вообще;
НЕ проверяет БД — временный сбой PostgreSQL не должен провоцировать
перезапуск живого процесса оркестратором):
```json
{ "ok": true, "uptimeSec": 42 }
```

Сравнение с SQLite-оригиналом: `GET /health` в `server.js` — статический
`{ok: true}`, не проверяющий вообще ничего (ни БД, ни таймеры).

## Lifecycle

| Компонент | Управляется | Идемпотентность |
|---|---|---|
| PostgreSQL pool | `db/postgresql/index.js` (`getPool()`/`close()`, Stage 1) | `close()` безопасен повторно, следующий `getPool()` лениво пересоздаёт |
| Restaurant-pause scheduler | `services/postgresql/scheduler.js` (Stage 5) | `start()`/`stop()` идемпотентны |
| Signal handlers | `services/postgresql/lifecycle.js` (Stage 6) | регистрируются один раз на `start()`, снимаются на `stop()` |
| HTTP-сервер | `server.postgresql.js` (Stage 6) | закрывается через `lifecycle.stop()` |

## Environment

| Переменная | Обязательность | Валидация |
|---|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | Одно из двух, ИЛИ полный набор ниже | `validateEnv()` бросает понятную ошибку, если ни то ни другое |
| `PGHOST`/`PGDATABASE`/`PGUSER` | Обязательны вместе, если нет connection string | — |
| `PGPORT` | Опционально (default 5432) | Должно быть целым числом, если задано |
| `PGPASSWORD` | Опционально | — |
| `PG_SSL` | Опционально (default выкл.) | Только `"true"`/`"false"`, если задано |
| `PG_SSL_REJECT_UNAUTHORIZED` | Опционально (default вкл.) | — |
| `PG_POOL_MAX` | Опционально (default 10) | Должно быть положительным числом, если задано |
| `PG_POOL_IDLE_TIMEOUT_MS` | Опционально (default 30000) | — |
| `PG_POOL_CONNECT_TIMEOUT_MS` | Опционально (default 5000) | — |
| `PG_HEALTH_PORT` | Опционально (default 3001) | — |
| `PG_HEALTH_HOST` | Опционально (default 127.0.0.1) | — |

`validateEnv()` вызывается ПЕРЕД первой попыткой сети (`bootstrap()`) — ни
одна из этих переменных не имеет "тихого" фолбэка на уровне валидации:
отсутствие обязательной конфигурации — явная, понятная ошибка при старте, не
позднее необъяснимое `ECONNREFUSED`/`password authentication failed` при
первом запросе. `db/postgresql/index.js` (Stage 1) сам по себе НЕ изменён —
эта валидация чисто аддитивна, вызывается явно новым Stage 6 кодом.

## Backup — рекомендации (не реализовано как скрипт)

Реальной production PostgreSQL БД пока не существует (переключение не
выполнено) — писать конкретный backup-скрипт против несуществующей БД
преждевременно (тот же принцип "не переносить лишнее", что и во всех
предыдущих этапах). Рекомендации для будущего Stage 7/8:

- **`pg_dump --format=custom`** — логический бэкап, восстанавливаемый
  `pg_restore`, не требует остановки процесса (MVCC даёт консистентный
  снепшот на момент старта дампа).
- **`pg_basebackup`** + WAL-архивирование (`archive_mode=on`) — для
  point-in-time recovery, если потребуется RPO меньше, чем интервал между
  логическими дампами.
- Ротация/retention — тот же принцип, что уже реализован для SQLite
  (`scripts/backup-db.js`, `BACKUP_RETENTION_COUNT`) — переносим ПОДХОД, не
  код (движки принципиально разные: файловая копия vs. `pg_dump`/WAL).
- **Restore** — как и у SQLite (`docs/backup-restore.md`), требует
  остановленного или явно управляемого доступа записи на время восстановления
  — `pg_restore` в чистую БД, либо `pg_basebackup`-based point-in-time
  recovery по официальной документации PostgreSQL.

## Recovery после недоступности БД

`waitForDatabase({retries, delayMs})` — retry с фиксированной паузой между
попытками (не exponential backoff — намеренно просто для стартовой фазы,
где важна предсказуемость времени до fail-fast, а не долгое ожидание).
После исчерпания попыток — явный `process.exit(1)`, не бесконечный retry
(предполагается внешний supervisor — systemd `Restart=on-failure`, аналогично
`deploy/yaam-backend.service`, — который перезапустит процесс). Runtime-сбой
БД ПОСЛЕ успешного старта (не при bootstrap) — `pg.Pool` сам переподключается
к новым соединениям по мере необходимости (стандартное поведение `pg`);
readiness-проба (`/health/ready`) отразит текущее состояние на каждый запрос
через живой `SELECT 1`, без необходимости в отдельном reconnect-механизме.

## Известные ограничения этого этапа

- `server.postgresql.js` не монтировал `routes/postgresql/api.js`/`admin.js`/
  bot — было сознательно, вне мандата Stage 6. **Обновление Stage 7**: эта
  сборка теперь выполнена — см. `server/docs/postgresql-application-assembly.md`.
  `server.postgresql.js` стал тонкой точкой входа над новым
  `services/postgresql/app.js`; bootstrap/health/lifecycle-механика,
  описанная в этом файле, не изменена, только переиспользована. **Обновление
  Stage 8**: `getSchedulers()` в `health.js`'s readiness-ответе теперь
  сообщает о трёх schedulers (pause-expiry, order-timeout,
  refund-reconciliation — последние два добавлены Stage 8), не одном — см.
  `server/docs/postgresql-payment-safety.md`.
- Single-instance ограничение SQLite-стороны (`singleInstanceLock.js`,
  `docs/single-instance.md`) НЕ перенесено и НЕ нужно — оно существовало
  из-за ограничений именно SQLite (единственный писатель, in-process
  `createOrder()`-атомарность, дублирующиеся `setInterval`-свипы двух
  процессов). PostgreSQL — клиент-серверная СУБД с нормальной
  многопользовательской конкурентностью (см. Wave 1-7, Stage 5 тест L2 — два
  конкурентных scheduler-инстанса безопасны).
