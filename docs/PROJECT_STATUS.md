# YAAM — статус проекта

Обновлено: 2026-07-24. Authoritative ledger — `docs/YAAM_PROJECT_MEMORY.md`.

## Версии и окружения

- Ветка: `claude/yookassa-get-refund`.
- Application baseline: `c9355173344b581f5958da120626bf62d4622b6f`
  (`feat(payments): enable safe YooKassa sandbox flow`).
- Последующие documentation commits не меняют runtime.
- Frontend: `https://yaam.su` — GitHub Pages demo, `USE_API=false` по
  умолчанию для всех обычных посетителей без изменений.
- Staging backend: `https://api-pg.yaam.su`.
- Production traffic: **OFF**.
- Stage 9 (VPS/PostgreSQL/Nginx/DNS/TLS/backup/monitoring) и Stage 10
  staging (YooKassa Sandbox controlled acceptance) — **COMPLETE**, см.
  `docs/YAAM_PROJECT_MEMORY.md` за полной evidence-таблицей. Server-side
  SSH-verification конкретно ИЗ ЭТОГО окружения агента остаётся
  отдельным, не блокирующим общий статус пунктом (`docs/
  STAGE_10_STAGING_DEPLOYMENT.md`).
- **Stage 11A (safe frontend → PostgreSQL staging API integration):
  COMPLETE.** Явный, обратимый staging-режим (`?yaam_staging_api=1`,
  подробности — `docs/YAAM_PROJECT_MEMORY.md`) добавлен в
  `client/js/api.js`; публичный demo-default не изменён. Backend
  contract audit не нашёл расхождений, требующих правок backend.
  Read-only verification против живого `api-pg.yaam.su` подтвердила
  корректный CORS. Полный браузерный E2E через staging + YooKassa
  Sandbox — **Stage 11B, отдельная задача Codex, ещё не выполнена.**

## Что фактически завершено

### PostgreSQL и application assembly

- PostgreSQL Migration Waves 1–7.
- Production Switch Stages 1–8.
- Stage 9 infrastructure и controlled staging acceptance.
- Nginx/TLS, systemd lifecycle, health/readiness/liveness, trust proxy,
  firewall, fail2ban и reboot survival.
- PostgreSQL и backend слушают только loopback; наружу доступны HTTP/HTTPS.
- Encrypted Timeweb S3 Cold offsite backup, restore drill и внешний monitoring.
- Age recovery key имеет проверенный escrow вне VPS.
- Rollback описан в `server/docs/postgresql-deployment-runbook.md`.

### Orders and security

- Capability `access_token` вместо доступа по одному public code.
- Durable payment attempts и idempotency create/webhook/refund.
- Concurrent customer cancel исправлен и проверен после staging deploy.
- Amount/currency validation, canonical provider lookup и повторная доставка
  webhook без duplicate side effects.
- Refund states `requested → processing → succeeded | failed`.
- Active order/cart restore, timers, rating и SQLite compatibility regression.

### YooKassa Sandbox

- Создан отдельный тестовый магазин.
- Sandbox credentials хранятся только в защищённом staging environment.
- `PAYMENT_PROVIDER=yookassa` включён только на staging.
- `YOOKASSA_ENV=sandbox` и `test_` Secret Key проверяются fail-closed.
- Authoritative webhook:
  `POST https://api-pg.yaam.su/api/webhooks/payment`.
- Sandbox API, card confirmation, webhook, idempotency и refund flow прошли
  controlled technical acceptance.
- Объекты провайдера проверяются как `test=true`.
- Production магазин, договор, live credentials и реальные платежи не
  использовались.

### Frontend cross-device compatibility

- Логотип: glow переведён с `filter:blur()` на `text-shadow` (устойчивее к
  реальным мобильным GPU) по репорту пользователя об отсутствии свечения на
  Android; visual parity подтверждён на Chromium/WebKit/Firefox
  desktop+mobile-viewport.
- **REAL ANDROID USER VERIFICATION: PASS.** Ручная проверка опубликованного
  `https://yaam.su` владельцем проекта на реальном Android-устройстве —
  glow, layout и работа сайта подтверждены без регрессий. Трассировка:
  `docs/CROSS_DEVICE_COMPATIBILITY.md`.

## Что остаётся demo или не проверено

- `https://yaam.su` не настроен на staging API; пользователи видят demo.
- Production traffic не включён.
- СБП в Sandbox не проверен и не должен считаться подтверждённым.
- Требования 54-ФЗ, чеки и production fiscalization не проверены.
- Production YooKassa onboarding/договор/live credentials не завершены.
- Реальные рестораны и restaurant Telegram bot не подключены.
- Юридические документы не проверены профильным юристом.
- Safari/WebKit quality gate для полного production flow не закрыт.
- UI no-emoji remediation завершён; user-facing source scan и mutation proof
  защищают правило от регрессии. Трассировка:
  `docs/NO_EMOJI_REMEDIATION.md`.
- Real iPhone/Safari verification (не через WebKit-движок desktop) —
  отдельный открытый пункт, логотип на Android этим не затронут (см.
  `docs/CROSS_DEVICE_COMPATIBILITY.md`).
- **Stage 11B — controlled browser E2E acceptance (Codex):** frontend
  staging mode готов на уровне кода и покрыт тестами, но полный
  браузерный сценарий frontend → staging → PostgreSQL → YooKassa Sandbox
  → webhook → order status → cancellation/refund ещё не пройден целиком
  через реальный браузер. Read-only verification (CORS, health) сделана
  в Stage 11A; создание заказа/оплата — не выполнялись.

## Тестирование

В репозитории есть отдельные SQLite, PostgreSQL, concurrency, payment/provider,
application assembly и frontend regression suites. Точные команды:

```bash
cd server
npm test
npm run test:postgresql

cd ../client
npm test
```

Stage 9 и Sandbox acceptance подтверждают только staging, а не production.

## Следующий безопасный этап

Закрыть открытые пункты в `docs/PROJECT_BACKLOG.md`: production
onboarding/СБП/54-ФЗ/legal readiness, первый реальный ресторан и отдельное
решение о подключении frontend/production traffic. До такого решения `yaam.su`
остаётся demo, а staging — изолированным.
