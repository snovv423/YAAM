# YAAM Project Backlog

Обновлено: 2026-07-24.

Этот документ содержит только открытые работы и действующие решения. Текущее
состояние находится в `docs/PROJECT_STATUS.md`. Старый snapshot сохранён без
потери данных в `docs/PROJECT_BACKLOG_HISTORY_2026-07-13.md`.

## Current phase

**Stage 9 CLOSED. READY for controlled next-stage planning, not for production
traffic.**

PostgreSQL staging и YooKassa Sandbox технически работают. `yaam.su` остаётся
demo. Stage 10, production onboarding и реальные платежи не начаты.

## Critical / High before production

### 1. YooKassa production onboarding

- Завершить только отдельным утверждённым этапом.
- Договор, production shop, live Secret Key и реальные платежи сейчас
  запрещены.
- Повторить security/rollback/acceptance с production-safe планом.

### 2. СБП и 54-ФЗ

- Подтвердить фактическую доступность и flow СБП для production магазина.
- Спроектировать и проверить fiscalization/чеки по требованиям 54-ФЗ.
- Не считать sandbox card acceptance доказательством СБП или фискализации.

### 3. Legal readiness

- Профессиональная проверка оферты, ПДн, cookies, оплаты/возврата и доставки.
- Утвердить реквизиты и процедуру обработки обращений до реальных денег.

### 4. Frontend and production traffic switch

- Отдельно утвердить API base, CORS, rollout и rollback.
- Проверить mobile Safari/WebKit, cache propagation и active-order recovery.
- До этого `https://yaam.su` остаётся demo и не использует staging backend
  для обычных посетителей.
- **Stage 11A закрыт**: staging-режим (`?yaam_staging_api=1`, sessionStorage,
  публичный default не изменён) готов в `client/js/api.js`, backend contract
  audit не нашёл расхождений. См. `docs/YAAM_PROJECT_MEMORY.md`.
- **Stage 11B — открыт, следующая задача**: controlled browser E2E acceptance
  (Codex) через staging + YooKassa Sandbox — create order → payment →
  webhook → status → cancellation/refund. Не выполнено этой задачей.

### 5. First restaurant operations

- Подключить один реальный ресторан только после production readiness.
- Подготовить отдельную state-machine/UX specification для restaurant order
  Telegram bot.
- HELP/support Telegram и restaurant bot — разные будущие эпики.

## Medium / quality gates

### Repository reproducibility for live ops

- Добавить sanitized templates для offsite backup и host-health scripts/units.
- Не переносить S3 credentials, heartbeat URLs, IP allowlists или server state.
- Добавить install/rollback tests.

### Browser quality

- Полный WebKit/iOS Safari прогон checkout, redirect/return, refresh/back,
  bfcache, polling и restore active order.
- Не считать Chromium-only acceptance достаточным production gate.
- Реальное Android-подтверждение логотипа (glow-фикс, `text-shadow` вместо
  `filter:blur()`) — закрыто, REAL ANDROID USER VERIFICATION: PASS (ручная
  проверка владельцем проекта после публикации фикса — точная календарная
  дата проверки не задокументирована), см.
  `docs/CROSS_DEVICE_COMPATIBILITY.md`. Real iPhone/Safari прогон остаётся
  открытым.

### Operational drills

- Продолжать периодические offsite restore drills.
- Проверить alert escalation/ownership перед production.
- Подтвердить capacity/disk retention после появления реальной нагрузки.

## Действующие решения

- Production traffic остаётся OFF до отдельного решения.
- YooKassa только Sandbox на staging; live credentials запрещены.
- Webhook: `POST /api/webhooks/payment`, canonical provider verification
  обязательна.
- Payment/refund/create idempotency и payment-attempt binding обязательны.
- Public code не является авторизацией; нужен `access_token`.
- SQLite compatibility path не удалять без утверждённой миграции/rollback.
- No emoji в UI; допустимы типографические `← → ✓ ★ +`.
- Payment/refund/schema/deploy changes требуют отдельного review, тестов и
  rollback.
- Каждый commit focused; никакого `git add -A`, force или скрытия dirty work.
- PDF — local workspace artifacts, не Git.

## Resolved / history

Завершённые PostgreSQL Waves 1–7, Production Switch Stages 1–9, access-token,
concurrency/idempotency/refund hardening, offsite backup/restore/monitoring,
age-key escrow и YooKassa Sandbox acceptance описаны в:

- `docs/PROJECT_STATUS.md`;
- `server/docs/postgresql-migration-status.md` — implementation history;
- `server/docs/postgresql-deployment-runbook.md`;
- `server/docs/postgresql-payment-safety.md`;
- Git history от Waves/Stages до application baseline `c935517`.

No-emoji remediation закрыт 2026-07-23: user-facing client source содержит
0 forbidden findings, regression scanner и mutation proof добавлены, desktop
и mobile Chromium acceptance пройдены. Полная трассировка:
`docs/NO_EMOJI_REMEDIATION.md`.

Исторические незакрытые на 2026-07-13 формулировки сохранены в
`docs/PROJECT_BACKLOG_HISTORY_2026-07-13.md` и не являются текущим backlog.
