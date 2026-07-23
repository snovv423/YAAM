# YAAM Stage 10 — Staging Deployment Status

Обновлено: 2026-07-23. Дополняет `docs/PROJECT_STATUS.md`/`docs/PROJECT_BACKLOG.md`
и `server/docs/postgresql-deployment-runbook.md`, не дублирует их.

## Статус: STAGE 10 PREFLIGHT PASSED — EXISTING STAGING DEPLOYMENT REQUIRES SERVER-SIDE VERIFICATION

Полный аудит кода, тестов и архитектуры для Stage 10 (controlled staging
deployment: PostgreSQL + YooKassa Sandbox на VPS) выполнен и пройден.
Staging deployment на `api-pg.yaam.su` уже существует (выполнен отдельным,
независимым треком, не этой задачей) и внешне доступен по HTTPS. Серверная
конфигурация, точный задеплоенный commit и YooKassa Sandbox live-flow из
этого окружения **не подтверждены** — доступный здесь SSH-ключ не прошёл
аутентификацию для проверенных имён пользователя; подтверждённое имя
пользователя VPS и соответствующий рабочий ключ в этом окружении
недоступны. Это не означает, что SSH-доступа к серверу не существует
вообще — независимый deployment-трек им явно располагает.

Полный отчёт: `output/md/YAAM-Stage-10-Staging-Deployment-Preflight-Report.md`.

## Известный факт: staging VPS уже существует и жив

`https://api-pg.yaam.su/health/live` и `/health/ready` отвечают 200,
`database.ok: true`, 3 scheduler'а активны (проверено read-only HTTP-запросом
в момент аудита). Это подтверждает только внешнюю HTTPS-доступность — НЕ
commit/config/process ownership. PostgreSQL staging **развёрнут кем-то
ранее** (отдельный, независимый deployment-трек с реальным VPS-доступом —
см. `CLAUDE.md`), но:

- Точный commit, реально запущенный на VPS, из этого окружения **не
  проверяем** — нет подтверждённых SSH-credentials.
- YooKassa Sandbox live-smoke-flow (create payment → webhook → refund) из
  этого окружения **не проверяем** — нет sandbox credentials и SSH.

Не путать "VPS существует и отвечает на health-check" с "серверная
конфигурация проверена" или "Stage 10 выполнен этой задачей" — это разные
утверждения.

## Что требуется от пользователя для server-side verification

1. Выполнить (или делегировать тому, у кого уже есть подтверждённый
   SSH-доступ) server-side verification `api-pg.yaam.su` — см. полный
   отчёт, §17, за точным списком проверок (commit, systemd, Nginx, .env,
   credentials без вывода значений, health, логи, backup).
2. Подтверждение, что на VPS сейчас `YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY`
   заданы как sandbox-тестовые (`test_...`), не боевые — без раскрытия самих
   значений в чат.
3. Явное решение: выполнять ли Stage 10 smoke-flow (create/webhook/refund)
   против уже живого VPS, или это отдельная задача независимого трека.

## Статусная матрица (см. полный отчёт за деталями/доказательствами)

| Component | Status |
|---|---|
| Cross-device frontend deployment | PASS |
| Real Android verification | PASS |
| Stage 10 code readiness | PASS |
| PostgreSQL local readiness | PASS |
| Staging HTTPS reachability | PASS |
| Server-side deployment verification | BLOCKED |
| Deployed commit verification | BLOCKED |
| YooKassa sandbox code readiness | PASS |
| YooKassa sandbox live smoke test | NOT PERFORMED |
| Frontend staging API switch | NOT PERFORMED |
| Production traffic | OFF |

Краткая форма для статусных таблиц: **STAGING REACHABLE — SERVER-SIDE
VERIFICATION PENDING**.
