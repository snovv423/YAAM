# YAAM Project Backlog

Обновлено: 2026-07-13.

Это внутренний living-документ команды — roadmap, архитектурная память и production checklist. Он не заменяет `README.md` (там — как запустить проект) и не заменяет `docs/PROJECT_STATUS.md` (там — снимок последних коммитов на конкретную дату). Этот файл — единственное место, где фиксируются задачи, решения, риски и правила между этапами разработки, чтобы ничего не терялось между сессиями.

## Current phase

**Phase:** Production infrastructure preparation *(рабочее название этапа — в проекте пока нет утверждённой сквозной нумерации фаз, номер не присваивается)*

**Status:** Ready to start — payment timer persistence fix закрыт (закоммичен `7adbdf4`), restaurant response timer persistence fix закрыт (закоммичен `10e1ae2`) и order creation time persistence fix закрыт (закоммичен `e13e52d`), все три запушены в `origin/main`, все три подтверждены на production через Chromium Playwright; read-only аудит готовности к Timeweb VPS проведён (`yaam-timeweb-vps-readiness-audit.pdf`), все три найденных Critical-риска (C1 — незащищённый webhook, C2 — нет бэкапов, C3 — нет защиты от нескольких процессов) закрыты и запушены (`26067fb`); backend по-прежнему работает только локально, VPS не выбран. PostgreSQL-миграция **уже начата** параллельно, изолированно от рабочего приложения (схема, db-layer, concurrency-стратегия, Wave 1+2 переноса orderService.js — см. подраздел ниже и `server/docs/postgresql-migration-status.md`), но production-приложение всё ещё полностью на SQLite — переключение и деплой на VPS ещё не выполнены.

**Current approved task:** Развернуть backend на Timeweb VPS.

**Then:** Перейти на PostgreSQL.

**After that:** Проверить production deployment.

**Next integration:** Тестовая среда ЮKassa.

## 1. Project status

**Frontend:**
- Статический HTML/CSS/JS без сборщиков, деплой на GitHub Pages
- Домен `yaam.su`
- То, что реально сейчас видно на `yaam.su` — чистый demo-режим (`USE_API=false`, данные из `client/js/data.js`), оплата имитируется в браузере

**Backend:**
- Node.js + Express, полностью реализован и протестирован локально
- Развёрнут только локально — ни на одном реальном сервере ещё нет
- 30 автоматических backend-тестов (`node:test`, без внешних зависимостей), `cd server && npm test`

**Database:**
- SQLite (`node:sqlite`, `server/db/yaam.db`) — **всё ещё единственная БД рабочего приложения**
- Backup/restore механизм реализован и протестирован (`npm run backup`/`npm run restore`, `server/scripts/backup-db.js`/`restore-db.js`, round-trip покрыт тестами) — на реальном сервере по расписанию ещё не запускался, потому что VPS ещё не выбран

**PostgreSQL migration** (параллельно, изолированно от рабочего приложения — подробный статус в `server/docs/postgresql-migration-status.md`):

Выполнено:
- DDL (целевая PostgreSQL-схема, `server/db/postgresql/schema.sql`)
- Async db-layer (`server/db/postgresql/index.js`)
- Embedded live validation против настоящего PostgreSQL 16.14
- Concurrency strategy (`transaction()`/`serializableTransaction()` API, 12 live-доказанных сценариев)
- Order Service Migration Wave 1 (`markPaymentFailed`, `restaurantAccept`, `restaurantAdvance`)
- Order Service Migration Wave 2 (`reserveRefundRow`, `markPaid`, `restaurantDecline`, `cancelByCustomer`)

Осталось:
- Следующие orderService waves (refund-сетевой конвейер, `createOrder`, `rateOrder`, sweeper)
- Полное подключение рабочего приложения к PostgreSQL (сейчас 100% на SQLite)
- Перенос реальных данных, production backup/restore под PostgreSQL
- VPS deployment
- Production validation

**Production:**
- Ещё не развёрнут (нет VPS, нет production ENV, нет мониторинга/логирования)

**Payments:**
- Только mock-провайдер; `YookassaProvider` — контракт-заглушка, бросает `not implemented`

**Telegram:**
- Бот написан и покрывает весь жизненный цикл заказа со стороны ресторана, но ни разу не подключался к реальному ресторану/боту

## Decisions

Утверждённые продуктовые и архитектурные решения — не список задач и не Ideas. Каждое решение обязательно к исполнению, пока не отменено отдельным явным решением CTO.

### 2026-07-12 — Awaiting payment dedup TTL

**Status:** Approved

**Decision:** `awaiting_payment` участвует в дедупликации 15 минут.

**Behavior:**
- < 15 минут — возвращается существующий заказ
- = 15 минут — ещё дедуплицируется (граница включительно)
- > 15 минут — разрешён новый заказ
- явная отмена переводит заказ в `cancelled` и сразу освобождает дедуп, независимо от TTL

### 2026-07-12 — Cancel unpaid order UX

**Status:** Approved

**Decision:** при отмене `awaiting_payment`:
- заказ становится `cancelled`
- refund не вызывается
- корзина очищается
- пользователь возвращается на главный экран
- можно сразу создать новый заказ
- UI не сообщает о возврате денег

### 2026-07-12 — No emoji in UI

**Status:** Approved

**Decision:** в интерфейсе YAAM не использовать emoji и декоративные Unicode-символы вместо текста.

**Applies to:** buttons, toast, confirm, ошибки, статусы, empty states, placeholder, loading messages.

### 2026-07-12 — Payment/refund architecture

**Status:** Approved

**Decision:** полноценную refund state machine не реализовывать на mock-провайдере.

**Implement only after:**
- Timeweb VPS
- PostgreSQL
- Тестовая ЮKassa
- Аудит реального поведения webhook/провайдера

### 2026-07-12 — Payment timer persistence model

**Status:** Approved

**Decision:** платёжный таймер (`qrDeadline`) — один абсолютный дедлайн, persisted в `localStorage` вместе с состоянием заказа.

**Behavior:**
- refresh, restore сессии, уход/возврат на экран оплаты и pageshow/bfcache-ресинк переиспользуют существующий дедлайн, никогда не продлевают и не пересоздают его
- новый дедлайн создаётся только для новой попытки оплаты — новый заказ (`openQR()`) или новый `providerPaymentId` после `payment_failed` (`retryPaymentFlow()`)
- истёкший дедлайн остаётся в прошлом — повторный restore не создаёт новые 10 минут
- явная отмена и успешная оплата обнуляют дедлайн (`resetAll()`, `afterPay()`)
- модель одинакова для demo и API-режима — сохраняется вне `if(!USE_API)`

### 2026-07-12 — Restaurant response timer persistence model

**Status:** Approved

**Decision:** таймер ожидания ответа ресторана (`preDeadline`, demo-режим) — тот же принцип, что и `qrDeadline`: один абсолютный дедлайн, persisted в `localStorage` вместе с состоянием заказа.

**Behavior:**
- refresh, restore сессии, back-навигация (popstate) и bfcache/pageshow/visibilitychange-ресинк переиспользуют существующий дедлайн, никогда не продлевают и не пересоздают его
- новый дедлайн создаётся только для по-настоящему нового ожидания (`openStatus()` → `renderWaitForRestaurant()` после свежей оплаты)
- явный переход дальше (`nextStatus()`), отказ/таймаут (`openRejected()`) и отмена (`resetAll()`) обнуляют дедлайн — следующий заказ в той же вкладке не наследует чужой/истёкший
- API-режим не затронут: `pollOrderOnce()` считает остаток от серверного `order.status_updated_at`, отдельная, не тронутая этим фиксом ветка

### 2026-07-12 — Order creation time persistence model

**Status:** Approved

**Decision:** отображаемое время «Заказ оформлен в HH:MM» вычисляется из одного неизменяемого persisted timestamp (`orderCreatedAtMs`), а не из `new Date()` в момент рендера.

**Behavior:**
- захватывается client-side ровно один раз — в `openQR()`, в момент реального создания заказа (не оплаты), одинаково для demo и API-режима, до любого сетевого вызова
- refresh, restore, back-навигация, повторный рендер статуса и polling переиспользуют существующий timestamp, никогда не пересчитывают его из текущего времени
- `nextStatus()` НЕ очищает timestamp — в отличие от `preDeadline`, это ORDER-scoped значение, живёт весь жизненный цикл заказа, а не только одну фазу
- явная отмена, отказ ресторана/таймаут и "заказ не найден" обнуляют timestamp — следующий заказ в той же вкладке не наследует чужое время
- backend `orders.created_at` существует в schema.sql, но сознательно не добавлялся в `PublicOrderDTO` — client-side capture в момент создания заказа даёт эквивалентную точность (разница — время одного сетевого запроса) без расширения публичного API

### 2026-07-16 — SBP-only capture=true for MVP

**Status:** Approved

**Decision:** первый production launch YAAM использует только СБП, модель оплаты `capture=true` (деньги списываются сразу; отказ ресторана/таймаут/допустимая отмена клиентом — через уже реализованный refund state machine). Обоснование — `YAAM-payment-capture-model-ADR.pdf`: СБП официально не поддерживает двухстадийную оплату («нельзя платить в две стадии», официальная документация ЮKassa).

**FUTURE / NOT IN MVP:** `capture=false` и двухстадийные банковские карты — не реализуются сейчас. Рассматриваются только позже, отдельным ADR, и только если карты станут самостоятельным (не заменяющим СБП) способом оплаты.

### 2026-07-12 — Infrastructure order

**Status:** Approved

**Order:**
1. Timeweb VPS
2. PostgreSQL
3. Production deployment validation
4. YooKassa test integration
5. Refund/payment state machine

## 2. Completed

- PublicOrderDTO — публичный `GET /api/orders/:code` больше не отдаёт PII (customer_name/phone/address) и внутренние поля (commission_amount, id, restaurant_id и др.)
- HTTP-level regression test для публичного order route (реальный Express-роут на эфемерном порту, без supertest/новых зависимостей)
- Atomic rating — `rateOrder()` использует conditional `UPDATE ... WHERE rating IS NULL` внутри транзакции, защищён от двойного счёта
- Awaiting payment dedup TTL = 15 минут (продуктовое решение, уточнено с изначальных 30 — см. Decisions)
- Cancel unpaid order UX — текст отмены неоплаченного заказа больше не обещает несуществующий возврат денег
- Тесты отмены, дедупа, regression — 30 backend-тестов всего (публичный DTO, TTL-границы, atomic rating, отмена awaiting_payment, HTTP-роут, общий regression)
- UI без emoji — убраны последние emoji из toast/кнопок, зафиксировано как постоянное правило в `CLAUDE.md` и в Decisions
- Confirm dialog cleanup — `yaamConfirm()` поддерживает кастомные подписи кнопок для конкретных сценариев
- Lifecycle/bfcache hardening — deadline-based таймеры QR/ожидания ресторана, `pollInFlight`-защита от гонки поллинга, корректная остановка QR-таймера при уходе с экрана
- Security hardening (предыдущий этап) — валидация телефона, CORS allowlist, rate limiting
- Server-side валидация заказа — `menuItemId`/цена/qty только из БД, не доверяются клиенту
- Точечный commit `77154e9` создан и **запушен в `origin/main`** — объединяет всё перечисленное выше из этого этапа
- Payment timer persistence fix — `qrDeadline` теперь переживает refresh/restore/уход-возврат (см. Decisions → Payment timer persistence model)
- 13 детерминированных frontend-regression-тестов на таймер (`client/test/qrTimerPersistence.test.js`, реальный `app.js` через `node:vm`, без новых зависимостей) — 13/13 PASS, 5 последовательных прогонов + parallel run
- Production Chromium Playwright check (A–D) на `https://yaam.su` — refresh, уход/возврат, 3×reload, отмена+новый заказ — все PASS после подтверждённого деплоя
- Точечный commit `7adbdf4` создан и **запушен в `origin/main`** — payment timer persistence fix + regression-тесты
- Restaurant response timer persistence fix — `preDeadline` (экран «ждём ответа ресторана», demo-режим) теперь переживает refresh/restore/back-навигацию/переход к следующему статусу, тот же класс бага, что был у `qrDeadline`, но в отдельной, ранее не тронутой переменной (см. Decisions → Restaurant response timer persistence model)
- 18 детерминированных frontend-regression-тестов на этот таймер (`client/test/restaurantResponseTimerPersistence.test.js`, реальный `app.js` через `node:vm`, без новых зависимостей) — 31/31 (18 новых + 13 существующих qrDeadline) PASS, 5 последовательных прогонов + parallel run
- Production Chromium Playwright check A–F на `https://yaam.su` — refresh, back-навигация/возврат, 3×reload, переход дальше (nextStatus), demo decline, отмена+новый заказ — все PASS после подтверждённого деплоя
- Точечный commit `10e1ae2` создан и **запушен в `origin/main`** — restaurant response timer persistence fix + regression-тесты
- Order creation time persistence fix — текст «Заказ оформлен в HH:MM» (экран статуса заказа) теперь переживает refresh/restore/back-навигацию/переход статусов/polling, тот же архитектурный класс бага, что у qrDeadline/preDeadline, но у ORDER-scoped значения `orderCreatedAtMs` (не countdown, не очищается на nextStatus — см. Decisions → Order creation time persistence model)
- 20 детерминированных frontend-regression-тестов на это значение (`client/test/orderCreatedTimePersistence.test.js`, реальный `app.js` через `node:vm`, включая реальный прогон `openQR()`, минимальное расширение helper — `closest()` в fake DOM-элементе) — 51/51 (20 новых + 31 существующих) PASS, 5 последовательных прогонов + parallel run
- Production Chromium Playwright check A–F на `https://yaam.su` — refresh через границу часа, back-навигация, 3×reload, переход через все статусы до "Доставлен", demo decline, отмена+новый заказ — все PASS после подтверждённого деплоя
- Точечный commit `e13e52d` создан и **запушен в `origin/main`** — order creation time persistence fix + regression-тесты
- Read-only аудит готовности backend к деплою на Timeweb VPS (`yaam-timeweb-vps-readiness-audit.pdf`) — 30 вопросов, риски разбиты на Critical/High/Can-do-during-deploy/Can-postpone/Demo-only/Production-required, рекомендованная архитектура (GitHub Pages → `api.yaam.su` → Nginx/TLS → Node systemd single-instance → SQLite → PostgreSQL позже)
- C1 — webhook-роут (`/api/webhooks/payment`) теперь регистрируется только при `PAYMENT_PROVIDER=yookassa`; в demo/mock-режиме (текущее состояние проекта) недоступен извне — `mockProvider.verifyWebhook()` не проверял подпись
- C2 — production-ready backup/restore для SQLite через встроенный `node:sqlite` (`backup()` + `readOnly`), без внешних зависимостей — `server/scripts/backup-db.js`/`restore-db.js`, ротация (14 последних), safety-копия перед restore, `server/docs/backup-restore.md`
- C3 — гарантия единственного экземпляра backend через PID-lock (`server/singleInstanceLock.js`) — второй процесс отказывается стартовать, если первый жив; `SIGTERM`/`SIGINT` освобождают lock; systemd unit-заготовка `server/deploy/yaam-backend.service`; `server/docs/single-instance.md`
- 19 новых backend-тестов на C1–C3 (4 + 5 + 10), полный набор — 49/49 PASS
- Живая проверка C3 на реальных процессах Node (не только юнит-тесты): второй процесс отказывается стартовать с понятной ошибкой, `SIGTERM` освобождает lock в пределах секунды, третий процесс после этого стартует нормально
- Точечный commit `26067fb` создан и **запушен в `origin/main`** — C1–C3 fixes + 19 тестов; ничего не задеплоено на Timeweb, DNS не менялся, VPS не создавался

## 3. Critical (обязательно до Production)

- Развернуть backend на VPS (Timeweb или аналог) — сейчас нигде не задеплоен
- Миграция SQLite → PostgreSQL
- Production ENV (секреты, `.env`, `trust proxy` под реальный reverse-proxy)
- Подключить cron/systemd-timer для регулярных бэкапов на VPS + offsite-копию — сам механизм уже реализован и протестирован (`server/scripts/backup-db.js`/`restore-db.js`, `server/docs/backup-restore.md`), осталось только включить по расписанию при появлении реального сервера
- ЮKassa — реальная интеграция вместо mock-провайдера
- Реальные webhooks ЮKassa с проверкой подписи — сам маршрут `/api/webhooks/payment` больше не доступен извне при `PAYMENT_PROVIDER=mock` (закрыто, commit `26067fb`), но полноценная интеграция (`YookassaProvider`) всё ещё не реализована (заглушка, бросает `not implemented`)
- Refund state machine — см. Known risks (Critical — Refund state machine)
- Security audit — отдельно: `public_code` последовательный и перебираемый, для продакшена нужен непереборный access token/signed link
- Production monitoring (Sentry или аналог)
- Production logging
- Юридические документы — финальная проверка юристом (оферта, ПДн, оплата/возврат)
- Подключение первого реального ресторана и его Telegram-бота живыми людьми

## 4. High priority

- Playwright E2E — сейчас проверка фронтенда только ручная, по запросу
- Mobile UX verification — регулярная проверка на viewport 390×844
- Performance testing
- Load testing
- Accessibility review
- Расширение HTTP-level тестового покрытия — сейчас HTTP-тест есть только для `GET /orders/:code`, остальные эндпоинты (`POST /orders`, `/cancel`, `/rate`) проверены только на уровне `orderService`, не на уровне реального HTTP-роута

## 5. Medium

- `docs/PROJECT_STATUS.md` устарел относительно текущего состояния (например, всё ещё говорит «нет автотестов») — стоит согласовать с этим backlog при следующем обновлении
- Небольшие улучшения из прошлых code review (не блокеры, см. Technical debt)
- Общий рефакторинг — не запланирован целенаправленно, делать только вместе с содержательными задачами, не отдельно

## Незавершённое adversarial-покрытие перед тестовой ЮKassa

Зафиксировано по итогам `YAAM-final-payment-security-audit-report.pdf` (2026-07-15). Четыре независимых read-only adversarial-агента (Payment attacks, Refund attacks, Order/DB concurrency+migration, Public API+client recovery) зависли в фоне и были остановлены; частично восстановленные результаты двух из них и один точечный ручной тест не выявили новых Critical/High сверх уже исправленного (см. Completed ниже), но следующие пункты остаются реально непроверенными новым динамическим прогоном в той сессии — только чтением кода/существующими тестами, не независимым adversarial-подтверждением. Не дублирует уже закрытые задачи.

1. **Массовые конкурентные запросы (20+) payment/refund**
   Зачем нужен: существующие тесты подтверждают конкуренцию на масштабе ~10 вызовов (`initialPaymentConcurrency.test.js`, `retryPaymentConcurrency.test.js`); поведение `partial UNIQUE INDEX`/`db.immediateTransaction` на большем масштабе не подтверждено эмпирически.
   До какого этапа обязателен: до тестовой ЮKassa.
   Статус: OPEN.
   Production blocker: нет (для локального коммита) / да (для production под реальной нагрузкой).

2. **Гонка restaurantDecline против timeout/другого терминального перехода**
   Зачем нужен: защищено тем же паттерном (`db.immediateTransaction` + conditional UPDATE), что и весь остальной код заказов, но не воспроизведено отдельным динамическим тестом — подтверждено только чтением кода.
   До какого этапа обязателен: до тестовой ЮKassa.
   Статус: OPEN.
   Production blocker: нет.

3. **Динамический тест rate limiting публичных order/payment endpoints**
   Зачем нужен: `orderCreateLimiter`/`orderReadLimiter`/`orderMutationLimiter` проверены только чтением конфигурации, не реальным прогоном серии HTTP-запросов до срабатывания лимита.
   До какого этапа обязателен: до production.
   Статус: OPEN.
   Production blocker: да.

4. **Динамический тест CORS и trust proxy в staging-конфигурации**
   Зачем нужен: `buildCorsOptions()`/`TRUST_PROXY`-логика проверена только чтением `server.js`/`config/cors.js`, не реальным HTTP-запросом с поддельным Origin/X-Forwarded-For за настоящим reverse-proxy.
   До какого этапа обязателен: до деплоя на Timeweb VPS (там появляется реальный reverse-proxy).
   Статус: OPEN.
   Production blocker: да.

5. **Отдельный новый adversarial-прогон Public API и client recovery**
   Зачем нужен: агент этого направления завис до выдачи хотя бы одного результата; текущая уверенность базируется на построчном чтении `routes/api.js`/`orderAccessService.js`/`client/js/app.js` и существующих тестах, не на независимом adversarial-прогоне.
   До какого этапа обязателен: до тестовой ЮKassa.
   Статус: OPEN.
   Production blocker: нет (для локального коммита) / да (для полноценного pre-production review).

6. **Webhook-события возврата (`refund.succeeded`, `refund.canceled`)**
   Зачем нужен: `routes/api.js` обрабатывает только webhook-события платежа; ветки для refund-событий нет вообще — `finalizeRefundSucceeded`/`finalizeRefundFailed` сегодня достижимы только из синхронного ответа mock-провайдера, что не соответствует документированному поведению ЮKassa (отдельные webhook и для платежа, и для возврата).
   До какого этапа обязателен: обязательно до подключения тестовой ЮKassa.
   Статус: OPEN.
   Production blocker: да.

7. **Reconciliation платежей/возвратов при потерянном webhook**
   Зачем нужен: `paymentService.getPaymentStatus()`/`provider.getStatus()` определены в контракте провайдера, но нигде не вызываются в продакшен-коде — нет sweep/polling fallback на случай, если webhook потерян полностью (у ЮKassa окно повторов 24 часа, не бесконечное).
   До какого этапа обязателен: обязательно до подключения тестовой ЮKassa.
   Статус: OPEN.
   Production blocker: да.

8. **Проверка с официальным тестовым магазином ЮKassa**
   Зачем нужен: вся текущая архитектура (idempotency-ключи, conditional UPDATE, durable-резервация до сетевого вызова) проверена только логически и на детерминированном mock-провайдере — ни разу не воспроизведена против настоящего внешнего HTTP-провайдера.
   До какого этапа обязателен: следующий этап после закрытия пп. 6–7.
   Статус: OPEN.
   Production blocker: да.

9. **Поведение под реальными сетевыми условиями провайдера**
   Зачем нужен: то, что принципиально не может доказать mock (реальные задержки доставки webhook, повторная доставка, из-строя-порядка события, формат ошибок живого HTTP/5xx/таймаутов) — см. раздел 8 `YAAM-final-payment-security-audit-report.pdf`.
   До какого этапа обязателен: до production launch.
   Статус: OPEN.
   Production blocker: да.

## Known risks

Объясняет, **почему** пункты Critical/High остаются открытыми и какой у них реальный эффект — не дублирует список задач, только раскрывает риск.

### Critical — Refund state machine

**Current impact:** mock/demo flow нельзя считать готовым для реальных денег.

**Why open:** безопасное решение требует промежуточного состояния и idempotency key, спроектированных вместе с реальным API ЮKassa — не вслепую на mock-провайдере.

**Risks:**
- cancel vs payment webhook
- cancel/decline vs accept
- двойной refund
- потерянный refund
- provider success с потерянным ответом
- crash между provider и DB
- отсутствие idempotency/retry/reconciliation

**Resolution:** проектировать после подключения тестовой ЮKassa.

**Production blocker:** Yes.

### High — SQLite in production

**Current impact:** подходит для локальной разработки, но не утверждён для production marketplace.

**Why open:** не выдерживает многопользовательскую нагрузку и не даёт нормальных бэкапов на масштабе.

**Resolution:** миграция на PostgreSQL.

**Production blocker:** Yes.

### High — Backend not deployed

**Current impact:** backend работает только локально.

**Why open:** VPS ещё не выбран, production ENV не настроен.

**Resolution:** Timeweb VPS, production ENV, HTTPS, process manager, reverse proxy.

**Production blocker:** Yes.

### Medium — Backup mechanism ready, not yet scheduled on a real server

**Current impact:** backup/restore реализованы и протестированы локально (round-trip: бэкап → порча данных → restore → проверка; ротация; safety-копия перед перезаписью) — `server/scripts/backup-db.js`/`restore-db.js`, 5 автотестов. Ни разу не запускались по расписанию на реальном сервере, потому что реального сервера ещё нет.

**Why open:** VPS ещё не выбран — сам механизм больше не блокер, осталось подключить cron/systemd-timer и offsite-копию при деплое (см. `server/docs/backup-restore.md`).

**Resolution:** cron/systemd-timer на VPS при деплое.

**Production blocker:** До первого деплоя — нет (механизм готов и проверен). До полноценного production launch — да, расписание должно реально работать, не только существовать в коде.

### Medium — Sequential public_code

**Current impact:** PII уже скрыта через PublicOrderDTO, но коды можно перебирать.

**Why open:** требует нового механизма (access token/signed link) — сознательно отложено отдельной задачей, не расширяющей текущий узкий scope.

**Resolution:** signed link, access token или авторизация.

**Production blocker:** Before real production, yes.

### Medium — E2E coverage incomplete

**Current impact:** backend tests 30/30, но ключевые browser-flow сценарии не покрыты Playwright.

**Why open:** Playwright MCP был недоступен в части сессий этого этапа; там, где возможно, проводилась ручная/headless-проверка.

**Resolution:** Playwright E2E до полноценного production launch.

**Production blocker:** Для demo — нет. Для production — желательно обязательный quality gate.

### Medium — Safari/WebKit quality gate not closed

**Current impact:** payment timer fix (A–D), restaurant response timer fix (A–F) и order creation time fix (A–F) production-check пройдены только в Chromium (Playwright MCP по умолчанию запускает Chromium, не Safari/WebKit) — движок явно зафиксирован во всех трёх PDF-отчётах, не выдавался за Safari.

**Why open:** реальный Safari/WebKit прогон этой сессией не выполнялся ни для одного из трёх фиксов; iOS Safari — основной браузер целевой аудитории (мобильный трафик), специфичные тайминги (bfcache, throttling фоновых вкладок) в Chromium не воспроизводятся один в один.

**Resolution:** отдельный ручной или Playwright-WebKit прогон сценариев всех трёх фиксов перед объявлением их полностью закрытыми для всех браузеров.

**Production blocker:** Для текущего этапа (Timeweb VPS) — нет. Перед полным production launch — да.

### Low — order.created_at сознательно не добавлен в PublicOrderDTO

**Current impact:** нет — client-side capture `orderCreatedAtMs` (момент `openQR()`) даёт точность до долей секунды от реального backend `created_at`, неотличимую при отображении с точностью до минуты.

**Why open:** это не открытый гэп, а осознанное решение при анализе order creation time fix — расширение `PublicOrderDTO` явно входило в scope, требующий подтверждения CTO (см. Production rules), но оказалось не нужно: frontend-only решение полностью покрывает и demo, и API режим без изменения backend.

**Resolution:** не требуется, если только в будущем не понадобится реальный серверный `created_at` для иной цели (аналитика, поддержка) — тогда отдельной задачей.

**Production blocker:** Нет.

### Low — Separate qrDeadline/preDeadline models (не объединены намеренно)

**Current impact:** нет — оба таймера (`qrDeadline`, `preDeadline`) реализуют один и тот же принцип абсолютного persisted deadline независимыми парами функций (`startQRTimer`/`startNewQRTimer` и guarded `startResponseTimer`), с небольшим дублированием паттерна.

**Why open:** сознательное решение при restaurant response timer fix — широкое объединение в общий deadline-менеджер прямо исключено из scope этой задачи, чтобы не расширять blast radius точечного бага-фикса непроверенным рефакторингом.

**Resolution:** возможный будущий рефакторинг в общий deadline-менеджер — только отдельной задачей с собственным анализом/тестами, не заодно с багфиксом.

**Production blocker:** Нет.

## 6. Ideas

Непроверенные идеи, без обязательств по реализации — переезжают в план только через явное решение CTO:
- SSE для живого обновления статуса заказа на клиенте вместо/вместе с поллингом (уже упомянуто как направление в комментариях `orderService.js`)
- Outbox/reconciliation-модель для refund-flow на масштабе (Вариант D из анализа refund state machine)
- Непоследовательный access token или подписанная ссылка вместо `public_code` для статуса заказа

## 7. Technical debt

Не пусто — зафиксированы конкретные принятые мелкие компромиссы (не блокеры, приоритет Low в последнем code review; Critical-риски описаны отдельно в Known risks, здесь их нет):
- `toPublicOrderDTO(null)` возвращает `null`, а не сигнализирует ошибку — безопасно в текущем единственном месте вызова, но не защищено от неверного будущего использования
- В `rateOrder()` порядок двух validation-проверок изменился при рефакторинге — влияет только на то, какое из двух сообщений увидит пользователь в недостижимом на практике комбинированном edge case
- Нет отдельного теста на `rating_count === 0` (первая оценка совсем нового ресторана) — формула проверена чтением кода, не закреплена тестом
- TTL-дедуп теоретически не истечёт, если `created_at` окажется в будущем (гипотетический сдвиг системных часов) — маловероятно при нормальной работе, future-hardening

## 8. Production rules

Постоянные правила проекта, не пересматриваются без явного решения CTO:
- Не использовать emoji в UI (кнопки, toast, уведомления, статусы, системные тексты) — только SVG/типографика
- Все крупные изменения проходят через: Анализ → План → Подтверждение → Изменение → Тесты → PDF-отчёт → Commit
- Не делать push/deploy без явного подтверждения
- Production-quality важнее скорости разработки
- Все новые функции сопровождаются тестами
- Новые API учитывают безопасность и PII с самого начала, а не постфактум
- Коммиты — точечные по конкретным файлам, никогда `git add -A`/`git commit -a`
- Изменения payment/refund-логики требуют отдельного архитектурного анализа до реализации, не патчатся на скорую руку
- Backend-изменения проверяются полным прогоном `npm test` до коммита

**Перед началом любой новой задачи/сессии:**
1. Прочитать `docs/PROJECT_BACKLOG.md`.
2. Проверить Current phase.
3. Проверить Decisions.
4. Проверить Known risks.
5. Проверить Next milestone.
6. Убедиться, что предлагаемая задача не дублирует уже сделанное и не нарушает утверждённое решение.

**После каждого завершённого крупного этапа:**
- обновить Project status;
- перенести завершённые пункты в Completed;
- обновить Current phase;
- обновить Known risks;
- добавить запись в Changelog;
- обновить Next milestone;
- создать/обновить PDF-отчёт;
- не оставлять отложенную работу только в чате.

## Changelog

Короткий человеческий журнал завершённых этапов — не замена `git log`, обновляется только после реально завершённых и подтверждённых CTO этапов.

### 2026-07-12

**Completed:**
- PublicOrderDTO
- HTTP regression test for public order route
- awaiting_payment TTL changed to 15 minutes
- atomic rateOrder
- unpaid order cancellation UX
- backend cancellation tests
- 30 backend tests
- commit `77154e9` created and pushed to `origin/main`
- payment timer persistence fix (`qrDeadline` survives refresh/restore/back)
- 13 frontend timer regression tests (5× sequential + parallel run, all PASS)
- commit `7adbdf4` created and pushed to `origin/main` at 2026-07-12T10:11:57Z
- GitHub Pages deploy confirmed at 2026-07-12T10:13:07Z (`last-modified` header, `startNewQRTimer`/`qrDeadline` present in production `app.js`)
- production Chromium Playwright check A–D: all PASS (refresh, back/return, 3×reload, cancel+new order)
- restaurant response timer persistence fix (`preDeadline` survives refresh/restore/back/nextStatus)
- 18 frontend restaurant-timer regression tests (31/31 total with existing qrDeadline tests, 5× sequential + parallel run, all PASS)
- commit `10e1ae2` created and pushed to `origin/main` at 2026-07-12T11:22:19Z
- GitHub Pages deploy confirmed at 2026-07-12T11:22:34Z (`last-modified` header, `savedOrder.preDeadline`/guard/clear-points present in production `app.js`)
- production Chromium Playwright check A–F: all PASS (refresh, back-navigation/return, 3×reload, nextStatus clears deadline, demo decline clears deadline, cancel+new order gets fresh deadline)
- order creation time persistence fix (`orderCreatedAtMs` survives refresh/restore/back/all status transitions)
- 20 frontend order-time regression tests (51/51 total with existing qrDeadline+preDeadline tests, 5× sequential + parallel run, all PASS)
- commit `e13e52d` created and pushed to `origin/main` at 2026-07-12T14:49:39Z
- GitHub Pages deploy confirmed at 2026-07-12T14:49:51Z (`last-modified` header, `orderCreatedAtMs` capture/persist/restore/clear-points present in production `app.js`)
- production Chromium Playwright check A–F: all PASS (refresh across hour boundary, back-navigation, 3×reload, full status walk to delivered, demo decline, cancel+new order gets fresh timestamp)

### 2026-07-13

**Completed:**
- Read-only аудит готовности backend к деплою на Timeweb VPS (`yaam-timeweb-vps-readiness-audit.pdf`)
- C1: webhook-роут гейтится по `PAYMENT_PROVIDER=yookassa`, недоступен извне в mock-режиме
- C2: backup/restore для SQLite (`node:sqlite backup()`, без внешних зависимостей), round-trip проверен тестами
- C3: PID-lock guard единственного экземпляра backend, `SIGTERM`/`SIGINT` graceful shutdown, systemd unit-заготовка
- 19 новых backend-тестов (49/49 всего)
- Живая проверка C3 на реальных процессах (не только юнит-тесты)
- commit `26067fb` создан и **запушен в `origin/main`** at 2026-07-13; Timeweb/DNS/VPS не затронуты

## 9. Next milestone

1. Развернуть backend на Timeweb VPS.
2. Перейти на PostgreSQL.
3. Проверить production deployment.
4. Подключить тестовую ЮKassa.
