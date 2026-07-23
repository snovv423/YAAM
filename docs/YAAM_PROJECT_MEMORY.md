# YAAM — Authoritative Project Memory

Единственный источник истины о том, какие Stage/этапы проекта реально
завершены. При расхождении с более старыми промежуточными отчётами
(`docs/reports/`, исторические PDF/MD) — этот файл и актуальный Git history
имеют приоритет; старые отчёты фиксируют состояние на момент своего
написания, не текущее.

Обновлено: 2026-07-24 (создан в рамках Stage 11A; дополнено Stage 11A
Follow-up — Payment Deadline Contract Fix).

## Stage status ledger

| Stage | Статус | Ключевые commits | Evidence |
|---|---|---|---|
| Stage 1–7 (PostgreSQL Waves + Production Switch application assembly) | **COMPLETE** | `16990d5`…`cfb9acd` | Код изолирован (`server/services/postgresql/*`, `server/db/postgresql/*`), тесты зелёные (538/540 `npm run test:postgresql`, 2 skip задокументированы) |
| Stage 8 (YooKassa payment/refund production safety) | **COMPLETE** | `0714553` | `verifyWebhook()` (canonical lookup), refund orchestration (`ensureRefundReady`/`sweepStuckRefunds`), 37 тестов в `paymentSafetyStage8.test.js` |
| Stage 9 (Timeweb VPS, PostgreSQL, systemd, Nginx, DNS, TLS, backup, monitoring) | **COMPLETE** | `18b3580`, `4d4dd39` | `https://api-pg.yaam.su/health/live` и `/health/ready` отвечают HTTP 200 (database.ok:true, 3 scheduler'а активны — подтверждено read-only проверками в нескольких сессиях). Прямой SSH-доступ к серверу из окружения агента отсутствует — server-side конфигурация подтверждена внешним HTTPS-observability и записями в `server/docs/postgresql-deployment-runbook.md`/`server/docs/postgresql-operational-readiness.md`, не личной SSH-сессией агента. |
| Stage 10 staging: YooKassa Sandbox integration + controlled live payment/webhook/refund acceptance | **COMPLETE** | `c9355173344b581f5958da120626bf62d4622b6f` | Ранее реально пройдены на staging: создание Sandbox Payment, `test=true`, hosted payment form, успешная тестовая карта, `payment.succeeded` webhook, customer cancellation, Sandbox refund, duplicate webhook/replay protection, restart survival, insufficient_funds card-attempt сценарий, cleanup acceptance fixtures. Это зафиксировано как подтверждённый факт задания Stage 11A; в текущей сессии агента этот live-flow не переповторялся напрямую (нет SSH/sandbox credentials в этом окружении) — статус: **PREVIOUSLY COMPLETED AND EVIDENCED**, не "not performed" в глобальном смысле. |
| Concurrent cancel idempotency (HIGH-дефект из независимого аудита) | **COMPLETE** | `a874571` | Полный отчёт с regression-тестами, задеплоено на staging |
| Cross-device frontend compatibility (Android glow, safe-area) | **COMPLETE** | `1ed37ca`, `b440ad6` | Real Android verification: PASS (ручная проверка владельцем проекта). Real iPhone/Safari — отдельный открытый пункт. |
| No-emoji remediation | **COMPLETE** | `c2c4131` | 0 forbidden findings, regression scanner + mutation proof |

## Что остаётся явно НЕ включённым (production guardrails)

- **Public frontend (`https://yaam.su`) остаётся demo** — `USE_API=false`,
  работает на `data.js`/localStorage, НЕ подключён к staging API.
- **Production traffic: OFF.**
- **Live YooKassa credentials: OFF** — только Sandbox (`YOOKASSA_ENV=sandbox`,
  `test_...` Secret Key, fail-closed проверено в коде провайдера).
- **Реальные платежи: OFF.**
- **54-ФЗ / production legal gates: НЕ завершены** — оферта/ПДн/фискализация
  не проверены профильным юристом, СБП для production не подтверждён.
- Production YooKassa onboarding (договор, live shop) — не начат.
- Реальные рестораны и restaurant Telegram bot — не подключены.

## Правило для будущих задач

Не повторять без новой технической причины: VPS setup, PostgreSQL setup,
DNS, TLS, backup/restore drill, monitoring setup, полный YooKassa Sandbox
payment/webhook/refund acceptance — всё это уже пройдено и задокументировано
выше. Новые задачи должны опираться на эту таблицу, не переоткрывать её с
нуля, и обновлять только те строки, для которых появилось новое,
проверяемое доказательство обратного.

## Ledger — записи по задачам

### Stage 9 Preflight/Deployment audit (Claude Code, до Stage 11A)

- Base commit: различные точки Stage 1–9 работы.
- Итог: инфраструктура подготовлена и код-проверена; фактический SSH-доступ
  к VPS агенту недоступен на протяжении всей работы над проектом.

### Stage 10 Staging Deployment Preflight (Claude Code)

- Base/final commit: `1ed37ca` → `7a6d626` (только документация).
- Полный код-аудит Stage 10 (PostgreSQL/YooKassa) пройден на уровне кода и
  локальных тестов; server-side verification (SSH) осталась BLOCKED для
  агента. Задокументировано в `docs/STAGE_10_STAGING_DEPLOYMENT.md`.

### Stage 11A — Safe Frontend → PostgreSQL Staging API Integration (Claude Code)

- **Агент:** Claude Code.
- **Base commit:** `7a6d626ec4da598b535b753d375e9eedbab7d3c0`.
- **Final commit (frontend integration):** `7670e1ea91cd4a504a49b5073934d3bd762549a4`
  (`feat(frontend): safe staging API mode for Stage 11A`).
- **Project memory commit:** `c728179` (`docs: create authoritative Stage 1-10
  project memory`).
- **Фактические изменения:** `client/js/api.js` — `resolveApiBaseUrl()`,
  явный staging-режим (`?yaam_staging_api=1`, sessionStorage-персистентность,
  жёстко зашитый `https://api-pg.yaam.su`, `?yaam_staging_api=0` — rollback);
  `client/index.html`/`client/css/style.css` — `#stgBadge` индикатор (не
  emoji, скрыт вне staging); `client/test/helpers/loadApp.js` — расширен
  `location.search`/`sessionStorage`/`URL` для тестов. **Backend (`server/`)
  — 0 изменений**, contract audit не нашёл расхождений между
  `client/js/app.js` и `server/services/postgresql/orderService.js`/
  `server/routes/postgresql/api.js` (endpoints, DTO-поля, refund_status,
  cancel-allowed statuses — всё уже совпадало до этой задачи).
- **Тесты:** `client/test/stagingApiMode.test.js` — 8 новых кейсов (demo
  default, активация, защита от произвольного query-значения,
  sessionStorage-persistence через симулированный reload, `=0` rollback,
  приоритет `window.YAAM_API_BASE_URL`, видимость бейджа). Полный frontend
  suite: 123/123 PASS (115 существовавших без регрессии + 8 новых). SQLite
  backend: 342/342 PASS. PostgreSQL backend: 538/540 PASS, 2 skip
  (задокументированные структурные, не связаны с этой задачей).
- **Deployment: NOT PERFORMED IN THIS TASK.** Публичный `yaam.su` не
  обновлялся, VPS/Nginx/PostgreSQL/DNS не менялись, SSH-попыток не было.
- **Что уже было пройдено ранее и не повторялось:** VPS setup, PostgreSQL
  setup, DNS/TLS, backup/restore drill, monitoring setup (Stage 9); полный
  live YooKassa Sandbox payment/webhook/refund acceptance (Stage 10) —
  **PREVIOUSLY COMPLETED AND EVIDENCED**, не переповторялся. В этой задаче
  выполнена только read-only controlled verification (health, CORS
  preflight против `Origin: https://yaam.su` и `http://localhost` — оба
  подтверждены curl'ом напрямую против живого `api-pg.yaam.su`; локальный
  браузер против живого staging — активация staging-режима подтверждена,
  сам cross-origin запрос корректно заблокирован CORS с `localhost`-origin,
  что и является ожидаемым/безопасным поведением, не дефектом).
- **Exact next action:** Stage 11B — controlled browser E2E acceptance by
  Codex через реально задеплоенный `https://yaam.su` (с `?yaam_staging_api=1`)
  + staging PostgreSQL + YooKassa Sandbox: create order → payment →
  webhook → status → cancellation/refund. Требует отдельного, явно
  утверждённого шага деплоя текущих frontend-изменений на `yaam.su`
  (публикация main через GitHub Pages) — сама эта публикация тоже не
  входила в scope Stage 11A.
- **ВАЖНО (обновлено follow-up-задачей ниже):** Stage 11A audit нашёл один
  LOW-дефект — `payment_expires_at` отсутствовал в API-контракте, срок
  оплаты вычислялся только клиентом. Пользователь переклассифицировал это в
  HIGH payment-state blocker и потребовал отдельный follow-up до начала
  Stage 11B. См. запись ниже — **Stage 11B остаётся BLOCKED** до
  независимой проверки этого изменения, не только до деплоя frontend.

### Stage 11A Follow-up — Payment Deadline Contract Fix (Claude Code)

- **Агент:** Claude Code.
- **Триггер:** пользователь явно переклассифицировал LOW-находку Stage 11A
  (`payment_expires_at` отсутствует в контракте, дедлайн — чисто клиентский
  `QR_TIMER_SEC=600`) в HIGH payment-state blocker и потребовал независимую
  проверку кода (не полагаться на прошлый отчёт) и утверждённое правило:
  ровно 15 минут, серверный, неизменяемый.
- **Base commit:** `de0c1e05f822097e61049c868192f5ba708f9b03` (подтверждено
  `git merge-base --is-ancestor` — это же и есть текущий HEAD, новых commits
  между base и началом этой задачи не было).
- **Независимая переверификация:** код перечитан заново (не по прошлому
  отчёту) — подтверждено grep'ом: `QR_TIMER_SEC=600` в `client/js/app.js:7`,
  ни одного упоминания `payment_expires_at`/`paymentExpiresAt` нигде в
  backend до этой задачи.
- **Новое серверное правило:** `PAYMENT_DEADLINE_MINUTES=15`, дедлайн
  ставится РОВНО один раз при финализации платёжной попытки (INSERT в
  `payment_presentations.expires_at`, anchored на `payments.created_at` —
  момент СОЗДАНИЯ попытки, до сетевого вызова провайдера, не момент ответа),
  исключён из `ON CONFLICT ... DO UPDATE SET` — физически не может быть
  переписан повторным replay/finalize. `retryPayment()` создаёт НОВУЮ строку
  `payments`, получающую собственный независимый дедлайн (явно утверждённая
  новая попытка); `LATEST_PAYMENT_EXPIRES_AT_SUBQUERY` в `getOrder()` берёт
  дедлайн именно последней попытки заказа.
- **Schema/API изменения:** `payment_presentations.expires_at`
  (PostgreSQL `TIMESTAMPTZ`, SQLite `TEXT`); публичный order DTO —
  `payment_expires_at` (snake_case, ISO8601 UTC, `null` если нет активной
  попытки/legacy-строка); публичный payment DTO — `paymentExpiresAt`
  (camelCase). Оба поля добавлены в оба backend'а (SQLite и PostgreSQL)
  параллельно, поведенчески идентично.
- **Миграция:** PostgreSQL — **первый в проекте настоящий `ALTER TABLE`**
  (`ALTER TABLE payment_presentations ADD COLUMN IF NOT EXISTS expires_at
  TIMESTAMPTZ;`, идемпотентно) — потребовался, потому что staging
  (`api-pg.yaam.su`) уже реально живёт со старой схемой (предыдущие
  изменения были чисто `CREATE TABLE IF NOT EXISTS`, этого хватало, пока
  живой БД не существовало). **`schema.sql` НЕ применяется автоматически при
  старте backend** (подтверждено — только вручную через
  `docs/postgresql-deployment-runbook.md`, `psql --file=db/postgresql/schema.sql`)
  — эта ALTER-миграция существует в файле, но **НЕ была выполнена против
  живого `api-pg.yaam.su`** в рамках этой задачи (SSH недоступен агенту, как
  и во всех предыдущих Stage). SQLite — миграция не нужна, живой SQLite
  production-БД не существует.
- **Тесты:** SQLite backend 352/352 PASS (было 342 — +10 новых dedicated в
  `server/test/paymentDeadline.test.js`, 4 существующих файла с DTO
  allowlist-проверками обновлены под новое поле). PostgreSQL backend 548/550
  PASS + 2 skip (задокументированные структурные, не связаны с задачей) —
  было 538/540; исправлены 2 реальных теста в `orderServiceWave4.test.js`
  (ожидали старую форму `finalizeInitialAttempt`/`finalizeRetryAttempt` без
  нового поля) + 10 новых dedicated в `server/test/postgresql/paymentDeadline.test.js`;
  один встреченный сбой (`createOrder: write-skew через реальный API`,
  `orderServiceWave5.test.js`) подтверждён как pre-existing флейк, НЕ
  связанный с этой задачей (файл не менялся, тест зелёный в изоляции,
  таймингово чувствителен под полной параллельной нагрузкой сьюта). Frontend
  130/130 PASS (было 123 — +7 новых dedicated в
  `client/test/paymentDeadlineFrontend.test.js`).
- **Frontend:** `client/js/app.js` — `qrDeadline` теперь берётся из
  серверного `payment.paymentExpiresAt`/`order.payment_expires_at` в
  API-режиме (`applyRecoveredOrder()` для create/recover/replay,
  `retryPaymentFlow()`/`recoverRetryPaymentPresentation()` для retry,
  `renderAwaitingPayment()` для sync на каждом polling-тике); `showRecoveredOrder()`
  больше не вызывает `startNewQRTimer()` безусловно (это и было причиной
  сброса дедлайна на refresh/reopen) — использует `startQRTimer()` (resume
  уже установленного значения). Fallback на клиентский `QR_TIMER_SEC=600`
  сохранён только для отсутствующего серверного значения (backward compat).
  **Demo-режим (`USE_API=false`) не тронут** — 123 ранее существовавших
  demo-теста прошли без единой правки.
- **Backward compatibility:** `expires_at`/`payment_expires_at` — `NULL`
  легитимен для строк, вставленных до миграции (frontend откатывается на
  клиентский таймер). Никакие уже утверждённые payment/refund semantics не
  менялись — только добавление поля, без auto-cancel-on-expiry (сервер не
  создаёт новую попытку и не отменяет заказ автоматически по истечении —
  вне scope этой задачи, явно запрещено условием задачи).
- **Rollback:** `git revert` затрагивающих commit'ов; колонка
  `expires_at` — аддитивная и nullable, безопасно оставить в схеме даже при
  откате кода (не ломает старый код, который её просто не читает). Если
  ALTER TABLE был выполнен против живого staging до отката — откатывать
  саму колонку не требуется.
- **Deployment: NOT PERFORMED.** Ни один VPS/PostgreSQL/staging компонент не
  менялся. Публичный frontend не деплоился.
- **Exact next action:** независимая проверка этого изменения (по прямому
  условию задачи) — затем, при необходимости деплоя на staging: (1)
  применить ALTER TABLE миграцию к живому `api-pg.yaam.su` ДО деплоя нового
  backend-кода (иначе INSERT в `payment_presentations` с новым полем
  `expires_at` упадёт против старой схемы), (2) задеплоить backend, (3) уже
  затем — Stage 11B. **Stage 11B остаётся BLOCKED** до выполнения этой
  проверки (прямое условие задачи).
