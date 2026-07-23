# CLAUDE.md — YAAM

Главные проектные и исполнительские правила для Claude Code. Актуально на
2026-07-23.

## Источники истины

Перед работой читать:

1. `CLAUDE.md` — архитектурные и исполнительские правила;
2. `docs/PROJECT_STATUS.md` — фактическое состояние;
3. `docs/PROJECT_BACKLOG.md` — только незакрытые задачи;
4. профильные документы в `server/docs/`.

Исторические отчёты и PDF не заменяют эти документы. Application baseline
текущего Sandbox-этапа — commit
`c9355173344b581f5958da120626bf62d4622b6f`; последующие documentation-only
commits не меняют runtime.

## Продукт

YAAM — локальный агрегатор доставки еды для Чечни. Ресторан платит комиссию
7% с суммы блюд оплаченного заказа. Доставку выполняет ресторан; YAAM
принимает оплату только за еду.

## Текущая архитектура

### Frontend

`client/` — статический HTML/CSS/JS без сборщиков и фреймворков. GitHub Pages,
домен `https://yaam.su`.

- `window.YAAM_API_BASE_URL` не задан — demo-режим на `data.js`/localStorage.
- `window.YAAM_API_BASE_URL` задан — запросы идут в backend.
- Публичный `yaam.su` сейчас остаётся demo и не связан со staging API.

### Backend

`server/` — Node.js + Express. Существуют два изолированных application path:

- SQLite — legacy/local compatibility path;
- PostgreSQL — staging/production-oriented path:
  `server/services/postgresql/app.js` и `server/server.postgresql.js`.

PostgreSQL staging развёрнут на Timeweb VPS:
`https://api-pg.yaam.su`. Nginx/TLS, systemd, PostgreSQL, offsite backup,
restore drill и внешний monitoring проверены в рамках Stage 9. Production
traffic выключен.

### Payments

Провайдер выбирается только server-side через `PAYMENT_PROVIDER`.

- `mock` сохраняется для local/legacy regression;
- `yookassa` разрешён только на staging с `YOOKASSA_ENV=sandbox`;
- live credentials текущий код намеренно отклоняет fail-closed;
- Secret Key хранится только в защищённом staging environment и никогда не
  попадает во frontend, Git, PDF или логи.

Authoritative webhook:

```text
POST /api/webhooks/payment
https://api-pg.yaam.su/api/webhooks/payment
Content-Type: application/json
```

Webhook использует raw body только на этом route, ограничение размера и
каноническую повторную проверку объекта через API YooKassa. Payment/refund
transitions, idempotency и payment-attempt binding хранятся в PostgreSQL.
Sandbox acceptance технически пройден; реальные деньги не принимались.

СБП и требования 54-ФЗ в текущем Sandbox не проверены. Production YooKassa
onboarding, договор и live credentials не завершены.

## Ключевые правила заказов

- Публичный номер `YAAM-xxxxx` не является авторизацией; доступ к заказу
  требует capability `access_token`.
- `awaiting_payment` дедуплицируется 15 минут; явная отмена освобождает dedup.
- Повторные create/cancel/webhook/refund операции должны быть идемпотентны.
- Active order важнее корзины и восстанавливается после refresh/back/restart.
- Корзина без заказа имеет TTL 30 минут от последнего изменения.
- Rating разрешён один раз только для оплаченного и доставленного заказа.
- SQLite и PostgreSQL paths нельзя незаметно смешивать в одном сервисе.

## Правило: без emoji в UI

YAAM должен выглядеть как современный премиальный продукт:

- цветные emoji запрещены в кнопках, toast, уведомлениях, статусах,
  placeholder и системных текстах;
- иконки реализуются единым SVG-набором, CSS или допустимой типографикой;
- допустимы текстовые символы `←`, `→`, `✓`, `★`, `+`;
- новые изменения не должны добавлять emoji;
- текущий remediation ещё не завершён: полная инвентаризация находится в
  `docs/NO_EMOJI_REMEDIATION.md`.

## Git-дисциплина

- Перед любой задачей проверить branch, HEAD и `git status`.
- Не менять и не скрывать существующие пользовательские изменения.
- Нельзя `reset --hard`, `clean`, force-push или массовый `git add -A`.
- Commit и push выполняются только по прямому разрешению пользователя.
- Каждый commit focused; перед ним показать staged diff и проверить scope.
- Payment/refund, schema/migration и deployment changes требуют тестов,
  rollback и отдельного review.
- Не коммитить секреты, credentials, cookies, приватные ключи, реальные IP
  allowlists и персональные machine-local настройки.

## Отчёты и локальные артефакты

- Итоговые PDF сохранять в `output/pdf/` и не коммитить.
- `output/`, `tmp/`, `.codex/` и `.claude/settings.local.json` — local-only.
- Markdown audit history коммитится только по явному заданию.
- Перед публикацией отчёта выполнять secret/PII scan и визуальный render QA.

## Команды

```bash
# SQLite/local regression
cd server
npm test

# PostgreSQL regression
cd server
npm run test:postgresql

# Клиентские тесты
cd client
npm test

# PostgreSQL staging application локально — только с безопасным env
cd server
npm run start:postgresql
```

Для browser-проверок использовать новый локальный порт и мобильный viewport
390×844. Критичные действия проверять реальными кликами; console errors и
horizontal overflow должны отсутствовать.

## Production guardrails

- `https://yaam.su` остаётся demo до отдельного решения о переключении.
- Не включать production traffic и live YooKassa без отдельного этапа.
- Не менять DNS, frontend API base или production env заодно с иной задачей.
- Не удалять SQLite path/data до утверждённой миграции и rollback.
- Юридические документы требуют профессиональной проверки до реальных денег.
- Точные открытые блокеры перечислены только в `docs/PROJECT_BACKLOG.md`.
