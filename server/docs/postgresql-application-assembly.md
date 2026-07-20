# PostgreSQL application assembly — Production Switch Stage 7

Собирает воедино компоненты Stage 1-6 (публичный API, admin, event layer,
бот, scheduler, bootstrap/health/lifecycle) в один управляемый Express-app —
`server/services/postgresql/app.js` (`createPostgresqlApp()`), с
`server/server.postgresql.js` в роли тонкой точки входа поверх него.

Ничего из этого файла не подключено к production — `server.js` (SQLite) не
изменён ни строкой, `server.postgresql.js` по-прежнему НЕ импортируется
рабочим приложением, не упоминается в systemd-юните/`npm start`, запускается
только вручную (`node server.postgresql.js` / `npm run start:postgresql`).

## Архитектурная граница

`services/postgresql/app.js` — единственное новое место сборки. Не
дублирует бизнес-логику: монтирует уже существующие `routes/postgresql/
api.js` (Stage 1), `routes/postgresql/admin.js` (Stage 4, с локальным
Stage-7-фиксом маршрутного бага, см. ниже), `bot/postgresql` (Stage 3,
обёрнутый в новый lifecycle-адаптер), переиспользует `services/postgresql/
scheduler.js` (Stage 5), `health.js`/`lifecycle.js`/`db/postgresql/
bootstrap.js` (Stage 6, `health.js` получил аддитивное расширение — см.
ниже) и `config/cors.js` (SQLite-сторона, но полностью DB-agnostic/pure —
переиспользован напрямую, тот же приём, что и с `admin/layout.js` в Stage 4).

`server.postgresql.js` стал тонким: `createApp(options)` — обёртка над
`createPostgresqlApp()`; `main()` — единственное место реального
`process.exit()`, сигнал-обработчики верхнего уровня
(`unhandledRejection`/`uncaughtException`). `require()` не запускает
`main()` (гейт `if (require.main === module)`), не открывает порт, не
трогает БД — тестируется без реального `process.exit()`/`listen()`.

## Маршрутная карта

| Путь | Источник | Готовность требуется |
|---|---|---|
| `GET /health/live` | `app.js` (health.liveness()) | нет |
| `GET /health/ready`, `GET /health` | `app.js` (health.readiness()) | нет (сама И ЕСТЬ проверка готовности) |
| `/api/*` | `routes/postgresql/api.js` (Stage 1, не изменён) | да (readiness-гейт) |
| `/admin/*` | `routes/postgresql/admin.js` (Stage 4, локальный фикс маршрутного бага) | да, + Basic Auth |

`/api` включает `POST /webhooks/payment` (только если `PAYMENT_PROVIDER=yookassa`
на момент require) и `POST /orders/:code/dev-confirm-payment` (только если
`ENABLE_DEV_PAYMENT_ROUTES=true && PAYMENT_PROVIDER=mock && APP_ENV in
[local,staging]`) — оба гейта не изменены, унаследованы буквально из Stage 1.

## Middleware-порядок

1. `requestIdMiddleware` — `req.id` из `X-Request-Id` или `crypto.randomUUID()`, эхо в ответе.
2. `accessLogMiddleware` — метод/путь/статус/длительность/id; НИКОГДА тело/заголовки (никаких Bearer-токенов, платёжных payload, PII).
3. `securityHeadersMiddleware` — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` (штатными средствами, без новой зависимости — helmet не добавлен, задание прямо просило обосновывать новые пакеты).
4. CORS — `cors(buildCorsOptions())`, `config/cors.js` переиспользован как есть.
5. `GET /health/*` — регистрируются здесь, ДО readiness-гейта и ДО JSON-парсинга (не нуждаются в body, не должны сами зависеть от гейта, который они же и репортуют).
6. Webhook raw-body carve-out + `express.json()`/`express.urlencoded()` для остального — тот же приём, что и SQLite `server.js` (глобальный JSON-парсер явно пропускает `/api/webhooks/payment`, роутер сам применяет `express.raw({type:'*/*'})` точечно на этом одном маршруте).
7. Readiness-гейт — 503 для всего, что не `/health*`, пока `!ready`.
8. `/api` (public API).
9. `/admin` (Basic Auth на точке монтирования, если заданы `ADMIN_USER`/`ADMIN_PASS`; иначе не монтируется вовсе).
10. dev/test-маршруты — не отдельный слой; уже гейтятся внутри `routes/postgresql/api.js` (см. "Dev-route gating" ниже).
11. `corsErrorHandler` — CORS-отказ → JSON 403 (тот же паттерн, что SQLite).
12. 404-обработчик.
13. Централизованный error handler — последний.

Тело запроса и `Authorization`/платёжные заголовки никогда не логируются ни
на одном шаге. `express.json()`/`express.urlencoded()` используют дефолтный
100kb-лимит Express — уже достаточен для "body size limits" из задания,
отдельно не менялся.

## Readiness-контракт (Variant A)

Выбран **Variant A**: HTTP-listener поднимается сразу (`app.listen()` в
`start()`), `/health/live` отвечает 200 немедленно; `lifecycle.start()`
(bootstrap PostgreSQL + `scheduler.start()` + `bot.start()`, если бот
включён) выполняется ПОСЛЕ этого, асинхронно. До его завершения:

- бизнес-маршруты (`/api/*`, включая webhook, `/admin/*`) отвечают 503 через
  readiness-гейт (дешёвый boolean-флаг `ready`, не живой запрос к БД на
  каждый запрос — сама readiness к БД уже проверяется `/health/ready`
  отдельно, дублировать эту проверку на каждый бизнес-запрос означало бы
  лишнюю задержку без дополнительной пользы: каждый маршрут и так
  обрабатывает свои собственные ошибки БД через try/catch);
- `/health/live` остаётся 200 (не зависит от готовности БД — временный сбой
  PostgreSQL не должен провоцировать перезапуск живого процесса);
- `/health/ready` продолжает делать СВОЙ прямой живой `SELECT 1`
  (Stage 6 `health.js`, не изменён) — отражает "доступна ли БД ПРЯМО
  СЕЙЧАС", НЕ "завершилась ли стартовая последовательность приложения".

**Важное разделение сигналов**: `/health/ready`'s `ok` и business-гейта
`ready` — НЕ одно и то же и могут ненадолго разойтись во время старта. Если
БД реально доступна, но `lifecycle.start()` ещё не успел вызвать
`scheduler.start()`/`bot.start()`, `/health/ready` уже покажет `ok:true`
(БД доступна), а business-гейт всё ещё будет 503 (полный старт ещё не
завершён) — это НАМЕРЕННО, не баг: `/health/ready` — самостоятельный,
Stage-6-унаследованный сигнал "жива ли БД прямо сейчас", а business-гейт —
Stage-7 сигнал "завершился ли полный старт приложения". Смешивать их было
бы либо (а) изменением Stage 6 семантики `/health/ready` без веской причины,
либо (б) добавлением дорогого per-request живого запроса к БД. Авторитетный
сигнал для внешнего оркестратора/staging-мониторинга по вопросу "готов ли
процесс принимать бизнес-трафик" — именно `/health/ready` в связке с
фактическими 503 от бизнес-маршрутов, а не только один из двух по
отдельности.

**Почему Variant A, а не Variant B** (listener только после bootstrap): (а)
уже реализовано и протестировано в Stage 6, переделка рискует сломать
проверенный контракт без необходимости; (б) для Timeweb/VPS staging слушающий
порт с самого начала даёт внешнему наблюдателю (systemd/curl/monitoring)
чёткий сигнал "процесс жив, просто ещё не готов" вместо неотличимого от
краша "порт не отвечает вообще" — полезно для диагностики медленного
старта/повторных попыток подключения к БД; (в) safety-гарантия ("никакой
бизнес-обработки до готовности") реализована readiness-гейтом одинаково
надёжно в обоих вариантах — выбор варианта её не ослабляет.

Критические сбои старта (bootstrap упал после исчерпания retry) — `start()`
закрывает уже поднятый `httpServer` и пробрасывает ошибку наверх; `main()`
логирует и `process.exit(1)` — процесс не остаётся "наполовину живым".

## Bot lifecycle

`createBotLifecycleAdapter({token, botClient})` (`app.js`) оборачивает
`bot/postgresql` (`startBot()`/`createBotHandlers()`, Stage 3) в тот же
`{start(), stop(), isRunning()}`-контракт, что и `scheduler` — необходимо,
т.к. для бота "конструирование = запуск" (не отдельный двухфазный API), а
`services/postgresql/lifecycle.js` (Stage 6, НЕ изменён) ожидает именно этот
интерфейс от каждого элемента своего `schedulers`-массива. Бот включается,
только если задан `TELEGRAM_BOT_TOKEN` (или, в тестах, инжектирован
`botClient`) — тот же conditional-гейт, что и SQLite `server.js`.

- **Единственный инстанс**: `start()` идемпотентен (`if (handle) return;`) —
  повторный вызов не создаёт второй `TelegramBot`/второй набор слушателей.
- **Управляемый lifecycle**: адаптер добавлен в `lifecycle.js`'s
  `schedulers`-массив — `stop()` (снятие `order:new`-listener) вызывается
  автоматически при graceful shutdown, тем же кодом, что уже проверен для
  scheduler'а в Stage 6.
- **Изоляция сбоев Telegram API**: `bot/postgresql/index.js` (Stage 3, не
  изменён) уже оборачивает `order:new`-обработчик и `callback_query`-
  обработчик в `.catch()` — ошибка отправки одного сообщения не роняет HTTP-
  приложение и не мешает обработке следующих событий. Адаптер ДОПОЛНИТЕЛЬНО
  оборачивает саму КОНСТРУКЦИЮ бота в try/catch (гипотетический синхронный
  сбой — например, сломанный `botClient` в тесте) — состояние `failed`,
  ошибка логируется, HTTP-приложение не затрагивается.
- **Readiness-политика**: состояние бота НЕ входит в `ok` `/health/ready`
  (временный сбой/недоступность Telegram не должна флипать readiness в
  false — рекомендованная заданием политика) — но ЯВНО наблюдаемо отдельным
  полем `bot` в ответе `/health/ready` (`{state: 'running'|'stopped'|'failed'|'disabled', lastError}`),
  через аддитивное расширение `services/postgresql/health.js`
  (`getBotState` callback, опциональный, default `() => null` —
  обратно совместим со Stage 6, которая этот параметр не передавала и не
  знает о существовании бота). Обоснование: заказы физически принимаются и
  оплачиваются независимо от бота (бот только уведомляет ресторан) — делать
  весь сервис "неготовым" из-за временной недоступности Telegram было бы
  избыточно строгим и без пользы для бизнес-логики.

## CORS

Переиспользован `config/cors.js`'s `buildCorsOptions()` без изменений —
уже полностью удовлетворяет требованиям задания: allowlist через
`CORS_ALLOWED_ORIGINS` (запятая-разделённый список, env), без origin —
пропускается (server-to-server/webhook-стиль), localhost разрешён только
при `NODE_ENV !== 'production'`, origin — функция-валидатор (никогда
буквальный wildcard `'*'`), CORS-отказ передаётся через `next(err)` →
`corsErrorHandler` → JSON 403 (не Express-дефолтная HTML-страница ошибки).
`credentials` не используется (аутентификация — Bearer-токен/Basic Auth в
заголовке, не cookies) — соответствует "credentials только если реально
используются". Пул подключений Stage 1 (`db/postgresql/index.js`) не тронут.

## Dev-route gating

Единственный существующий dev/test-маршрут — `POST /orders/:code/
dev-confirm-payment` (`routes/postgresql/api.js`, Stage 1, не изменён) —
уже гейтится тройным условием на момент `require()`:
`ENABLE_DEV_PAYMENT_ROUTES === 'true' && PAYMENT_PROVIDER === 'mock' &&
APP_ENV in ['local', 'staging']`. Default disabled (отсутствие переменной
трактуется как "выключено"), fail-closed (production исключён явным
списком, а не "не production"), требует явного флага. Отдельного
app-уровневого gate не добавлено — задваивало бы уже корректный механизм.

Дополнительно, на уровне сборки (`app.js`, `validateAppEnv()`) — fail-fast
валидация значения самой переменной: `ENABLE_DEV_PAYMENT_ROUTES` должна
быть `'true'`/`'false'`/не задана, ЛЮБОЕ другое значение (например,
опечатка `'yes'`) бросает понятную ошибку СИНХРОННО при `createPostgresqlApp()`
— не даёт опечатке молча трактоваться как "выключено" без предупреждения.
Аналогично для `APP_ENV` (только `local`/`staging`/`production`) и парности
`ADMIN_USER`/`ADMIN_PASS` (оба или ни одного).

## YooKassa webhook — реализовано в Stage 8

**Обновление Stage 8**: `YookassaProvider.verifyWebhook()` реализована —
канонический lookup через уже существующий `getStatus()` (официально
подтверждённая модель подлинности ЮKassa — HMAC/подписи не существует).
Маршрут дополнительно сверяет amount/currency уведомления с сохранённым
платежом. Полная детализация —
[`server/docs/postgresql-payment-safety.md`](./postgresql-payment-safety.md).
Раздел ниже оставлен как исторический контекст для того, что было верно на
момент Stage 7.

Идемпотентность повторной доставки webhook (duplicate delivery) в Stage 7
проверялась через тестовый monkey-patch `paymentService.verifyWebhook`
(тогда — единственный возможный способ, т.к. реальная верификация была не
реализована); Stage 8 добавила исчерпывающее покрытие против настоящего
кода верификации (управляемый fake HTTP-транспорт вместо реальной сети
ЮKassa, но реальный `yookassaProvider.js` код) — см. `server/test/
postgresql/paymentSafetyStage8.test.js`.

## Admin route-conflict — исправлено в Stage 7

Stage 4 нашла и задокументировала: `router.post('/restaurants/:id/', ...)`
(307-редирект-заглушка) зарегистрирован ПЕРЕД `router.post('/restaurants/:id', ...)`
(реальный UPDATE) в `routes/postgresql/admin.js` — под Express `strict:
false` (default) оба паттерна компилируются в идентичный регэксп, первый
зарегистрированный маршрут побеждает независимо от trailing slash в
запросе, реальный UPDATE был недостижимым мёртвым кодом, форма
редактирования (`action` без trailing slash) попадала бы в бесконечный
307-redirect-цикл.

Задание Stage 7 явно разрешило локальный фикс, если он "локальный,
безопасный, не меняет внешний контракт": реализован — порядок двух
`router.post()` в `routes/postgresql/admin.js` поменян местами (реальный
UPDATE — первым). Воспроизведено тестом ДО фикса (Stage 4's `C3`/`C3b`/`C9`,
буквально документировали старое, багованное поведение), исправлено,
подтверждено тестом ПОСЛЕ (обновлённые `C3`/`C9` в `adminStage4.test.js` +
новый `E5` в `applicationAssemblyStage7.test.js`). Редирект-заглушка
осталась в коде как есть (не удалена — минимальный, локальный диф), но
теперь сама стала недостижимым кодом (по той же причине наоборот — та же
`strict:false`-коллизия регэкспов). **SQLite-оригинал (`routes/admin.js`)
НЕ тронут** — там баг остаётся ровно таким, каким его нашла Stage 4;
затрагивает живой production-путь, требует отдельного явного
product-решения вне мандата Stage 7.

## Graceful shutdown

`instance.stop()` делегирует в `lifecycle.stop()` (Stage 6, не изменён) —
идемпотентно, безопасно при повторном вызове, безопасно как no-op до
`start()`. Порядок: снять signal-listeners → остановить все `schedulers`
(pause-expiry, order-timeout и refund-reconciliation schedulers — последние
два добавлены Stage 8, см. `postgresql-payment-safety.md` — И bot-адаптер,
если бот включён) → закрыть
`httpServer` (дожидается in-flight запросов) → `onShutdown`-хук (Stage 7:
сбрасывает `ready = false`) → закрыть пул PostgreSQL. Ни один
переиспользуемый модуль (`lifecycle.js`, `app.js`) не вызывает
`process.exit()` — только `server.postgresql.js`'s `main()`. Повторный
`stop()` (в т.ч. от повторного SIGTERM/SIGINT) — безопасный no-op.

## Тесты

`server/test/postgresql/applicationAssemblyStage7.test.js` — 39 тестов,
разделы A-J (assembly, middleware ordering, readiness gate, public API,
admin + route-conflict repro/fix, webhook, CORS, dev-route gating, bot
lifecycle, shutdown). Реальный embedded PostgreSQL 16.14, `FakeTelegramBot`
для инъекции в bot-тестах, monkey-patch-and-restore для webhook/bootstrap
таймингов — те же established-приёмы, что и во всех предыдущих Stage/Wave
тестах.

**Побочный эффект фикса admin route-conflict**: `adminStage4.test.js`'s
`C3`/`C9` были написаны, чтобы ЗАДОКУМЕНТИРОВАТЬ старое, багованное
поведение (307-self-redirect) — после Stage 7 фикса они закономерно стали
наблюдать НОВОЕ, исправленное поведение (302 → /edit, реальный UPDATE
применяется). Оба теста ОБНОВЛЕНЫ (не удалены) под новое поведение, с
явным указанием в названии/комментарии "исправлено в Stage 7" и ссылкой на
историю бага — не потеря покрытия, а его развитие вслед за намеренным
изменением поведения.

## Результаты регрессии (после Stage 7)

| Набор | Результат |
|---|---|
| `applicationAssemblyStage7.test.js` (новый) | 39/39, 4 прогона подряд стабильно зелёные |
| `adminStage4.test.js` (после обновления C3/C9) | 44/44 |
| Полный `npm run test:postgresql` (все файлы) | 482/482, 2 прогона подряд чисто |
| `concurrency.test.js` отдельно | 14/14 |
| SQLite (`npm test`) | 333/333 |

**Один известный, unrelated flake встретился при первом (до фикса) прогоне
агрегата**: `orderServiceWave5.test.js` (SERIALIZABLE-retry timing под
нагрузкой параллельно запущенных файлов) — тот же класс flake, что уже
документирован в Stage 6 PDF. Изолированный прогон этого файла — 3/3
стабильно зелёный, подтверждает: НЕ связан со Stage 7 кодом.

## Что осталось вне Stage 7 (готовит Stage 8)

- Реальный VPS/staging деплой, DNS/SSL/NGINX — не выполнялись.
- Создание реальной production PostgreSQL БД, `pg_dump`-автоматизация.
- Реальная валидация ЮKassa против боевого аккаунта; `verifyWebhook()` —
  всё ещё "not implemented" (независимый от этого этапа блокер).
- Продуктовое решение по такому же маршрутному багу в SQLite `routes/
  admin.js` — не тронут, требует отдельного явного решения.
- Собственно Production Switch (переключение `server.js` на PostgreSQL) —
  не выполнялся и не планировался как часть Stage 7.
