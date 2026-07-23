# YAAM — Authoritative Project Memory

Единственный источник истины о том, какие Stage/этапы проекта реально
завершены. При расхождении с более старыми промежуточными отчётами
(`docs/reports/`, исторические PDF/MD) — этот файл и актуальный Git history
имеют приоритет; старые отчёты фиксируют состояние на момент своего
написания, не текущее.

Обновлено: 2026-07-24 (создан в рамках Stage 11A).

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
