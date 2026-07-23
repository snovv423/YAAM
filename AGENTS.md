# AGENTS.md — YAAM

Официальные инструкции Codex для этого репозитория. Актуально на 2026-07-23.

## Перед началом

1. Проверить branch, HEAD и полный `git status`.
2. Прочитать `CLAUDE.md`, `docs/PROJECT_STATUS.md` и
   `docs/PROJECT_BACKLOG.md`.
3. Профильные детали брать из `server/docs/` и реального кода, не из старых
   PDF или переписки.
4. Существующие dirty/untracked файлы принадлежат пользователю, пока не
   доказано обратное.

`CLAUDE.md` — главный источник архитектурных и исполнительских правил.
`AGENTS.md` не дублирует всю архитектуру, а задаёт правила независимой работы
Codex.

## Роль Codex

Codex используется как независимый архитектор, security/QA/DevOps reviewer и
финальный критический проверяющий. Обычную реализацию ведёт Claude Code, если
пользователь не дал Codex прямое задание. Не изменять параллельно те же файлы.

## Подтверждённый контекст

- Frontend `https://yaam.su` — GitHub Pages demo, без staging API.
- PostgreSQL staging — `https://api-pg.yaam.su`.
- Stage 9 закрыт; production traffic выключен.
- Application baseline Sandbox-интеграции:
  `c9355173344b581f5958da120626bf62d4622b6f`.
- YooKassa разрешена только в staging Sandbox.
- Webhook: `POST /api/webhooks/payment`.
- СБП, 54-ФЗ и production onboarding не проверены/не завершены.

## Git и scope

- Не удалять, не reset/restore/checkout/stash пользовательские изменения без
  отдельного разрешения.
- Не использовать `git add -A`, `commit -a`, force-push или rewrite history.
- Commit/push только по прямому разрешению; каждый commit focused.
- Перед commit показать staged name-only, stat, diff и `diff --cached --check`.
- После push проверить remote HEAD и финальный status.
- Не менять runtime, VPS, staging, DNS, YooKassa и production при
  documentation-only задаче.

## Security

- Никогда не показывать или коммитить passwords, tokens, cookies, private
  keys, YooKassa/S3 credentials, heartbeat URLs и access tokens заказов.
- Секреты — только root-owned server environment/systemd credentials.
- Публичный `YAAM-xxxxx` не является авторизацией; нужен `access_token`.
- Webhook payload не является источником истины без canonical provider lookup.
- Payment/refund changes обязаны сохранять idempotency и attempt binding.

## QA

- Тестировать пропорционально риску; runtime change требует релевантных и
  полных regression suites.
- Documentation-only change минимум проверяется link/consistency/secret scan
  и быстрым smoke suite.
- Не считать SKIPPED за PASS и не скрывать flake/UNKNOWN.
- Не заявлять живую инфраструктурную проверку без фактического VPS evidence.

## UI

Цветные emoji запрещены в пользовательском интерфейсе. Использовать SVG, CSS
или допустимые типографические символы `← → ✓ ★ +`. Текущий inventory и
remediation plan: `docs/NO_EMOJI_REMEDIATION.md`; UI в рамках документационных
задач не менять.

## Отчёты

- Итоговые артефакты сохранять только внутри workspace: `output/pdf/` или
  `reports/`.
- PDF не коммитить; перед публикацией выполнить render QA и secret/PII scan.
- `.codex/`, `output/`, `tmp/` и `.claude/settings.local.json` local-only.
- Не включать в отчёты секреты, cookies, private URLs или персональные данные.
