# PostgreSQL backend deployment runbook — Production Switch Stage 9

**Статус: ПОДГОТОВЛЕНО, НЕ ВЫПОЛНЕНО.** Ни одна команда в этом документе не
была запущена против реального сервера — в окружении, где готовился Stage 9,
физически нет доступа ни к какому VPS, ни к хостинг-аккаунту, ни к реальным
YooKassa test credentials (проверено: нет записей в `~/.ssh/known_hosts`/
`~/.ssh/config`, `docs/PROJECT_BACKLOG.md` прямо подтверждает "VPS ещё не
выбран", `.env.example`/окружение не содержат реальных `YOOKASSA_SHOP_ID`/
`SECRET_KEY`). Это пошаговый чеклист для человека (или будущего запуска),
который реальным доступом располагает. Каждый шаг — команда + что именно
проверить, чтобы результат был фактом, а не предположением.

Это НЕ Stage 10 (Production Switch) — ни один шаг здесь не подключает
реальных пользователей и не принимает реальные деньги. Цель Stage 9 —
подготовить инфраструктуру, на которой Stage 10 сможет быть выполнен
безопасно, отдельным, явно утверждённым шагом.

## 0. Предварительные требования

- VPS (рекомендация из более раннего аудита — `yaam-timeweb-vps-readiness-audit.pdf`
  — Timeweb, но подходит любой провайдер с полным root-доступом и Ubuntu/
  Debian).
- Домен/поддомен для PostgreSQL-стороны, НЕ основной `api.yaam.su`
  (зарезервирован для будущего Stage 10) — например, `api-pg.yaam.su`, с
  DNS A-записью на IP VPS.
- SSH-доступ (в репозитории уже подготовлен ключ `~/.ssh/yaam_vps_ed25519` —
  добавить публичную часть в `authorized_keys` VPS при создании).
- YooKassa **тестовый** (не боевой) аккаунт — `YOOKASSA_SHOP_ID`/
  `SECRET_KEY` из тестового режима личного кабинета ЮKassa.

## 1. VPS preparation

```bash
# Обновление системы
sudo apt-get update && sudo apt-get upgrade -y

# Node.js (LTS, соответствует "engines": ">=22.5.0" в server/package.json)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node --version   # ожидается >= 22.5.0
npm --version

# systemd — уже часть Debian/Ubuntu, проверить версию/доступность
systemctl --version

# Firewall (ufw) — открыть ТОЛЬКО SSH/HTTP/HTTPS, ничего внутреннего наружу
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
# ВАЖНО: PG_HEALTH_PORT (3001) и PostgreSQL (5432) НЕ открывать наружу —
# оба слушают только 127.0.0.1 (см. .env.postgresql.example/PostgreSQL setup
# ниже), доступны исключительно через loopback + Nginx reverse-proxy.

# Swap — минимум для VPS с < 2GB RAM (типичный младший тариф)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # подтвердить Swap: 2.0Gi

# Timezone — UTC на сервере (все TIMESTAMPTZ в схеме уже подразумевают UTC-
# независимость, см. db/postgresql/schema.sql — сравнение времени идёт
# средствами самого PostgreSQL, NOW(), а не Node Date.now())
sudo timedatectl set-timezone UTC
timedatectl status   # подтвердить "Time zone: UTC"

# Locale
sudo locale-gen ru_RU.UTF-8 en_US.UTF-8
sudo update-locale LANG=en_US.UTF-8
```

**Проверить после этого шага**: `node -e "console.log(process.version)"` ≥
v22.5.0; `sudo ufw status` показывает ровно 3 разрешённых порта (22/80/443);
`free -h` показывает swap; `timedatectl` — UTC.

## 2. Production PostgreSQL

```bash
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo systemctl status postgresql   # active (running)

# Отдельная production БД + отдельный пользователь с МИНИМАЛЬНЫМИ правами
# (не суперпользователь, не владелец кластера) — от имени системного
# пользователя postgres:
sudo -u postgres psql <<'SQL'
CREATE USER yaam_app;
CREATE DATABASE yaam_production OWNER yaam_app;
-- Минимальные права: владелец БД уже получает CREATE/CONNECT на неё,
-- отдельно REVOKE публичного доступа к CREATE на уровне кластера:
\connect yaam_production
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO yaam_app;
SQL

# Задать пароль интерактивно: секрет не попадёт ни в history, ни в argv.
sudo -u postgres psql -c '\password yaam_app'

# PostgreSQL слушает только loopback (не открыт наружу, см. firewall выше) —
# проверить postgresql.conf:
sudo grep "^listen_addresses" /etc/postgresql/*/main/postgresql.conf
# ожидается: listen_addresses = 'localhost' (дефолт Debian/Ubuntu-пакета,
# обычно не требует правки)

# Схема применяется после размещения репозитория в разделе 3. На этом шаге
# файла server/db/postgresql/schema.sql на свежем VPS ещё может не быть.
```

**Backup/restore** — механизм для реальной production PostgreSQL БД НЕ
реализован отдельным npm-скриптом (сознательно — реальной БД не
существовало до этого шага, см. `postgresql-operational-readiness.md`).
Рекомендация (не изобретается заново — стандартные PostgreSQL-инструменты):

```bash
# После создания /opt/yaam/.pgpass в разделе 3 (пароль не попадает в argv,
# shell history и process list):
sudo install -d -o yaam -g yaam -m 0700 /var/backups/yaam
sudo -u yaam env PGPASSFILE=/opt/yaam/.pgpass pg_dump --format=custom \
  --host=127.0.0.1 --port=5432 --username=yaam_app --dbname=yaam_production \
  --file="/var/backups/yaam/yaam_production_$(date +%Y%m%d_%H%M%S).dump"

# Проверочный restore-round-trip выполняется в ОТДЕЛЬНУЮ БД, не поверх рабочей:
sudo -u postgres dropdb --if-exists yaam_restore_test
sudo -u postgres createdb --owner=yaam_app yaam_restore_test
sudo -u yaam env PGPASSFILE=/opt/yaam/.pgpass pg_restore --no-owner \
  --host=127.0.0.1 --port=5432 --username=yaam_app --dbname=yaam_restore_test \
  /var/backups/yaam/yaam_production_ФАЙЛ.dump
sudo -u yaam env PGPASSFILE=/opt/yaam/.pgpass psql \
  --host=127.0.0.1 --port=5432 --username=yaam_app --dbname=yaam_restore_test \
  -c 'SELECT count(*) FROM orders;'
sudo -u postgres dropdb yaam_restore_test
```

Никогда не выполнять `pg_restore --clean` поверх БД, пока backend пишет в неё.
Аварийное восстановление выполняется с остановленным
`yaam-backend-postgresql`, в новую БД; после проверки целостности меняется
`DATABASE_URL` и только затем запускается unit. Старую БД не удалять до
подтверждения `/health/ready` и бизнес-smoke-test — это rollback-точка.

Расписание (systemd timer, тот же принцип, что и уже реализованный SQLite
`npm run backup`/`server/scripts/backup-db.js`, см. `backup-restore.md` —
подход переносится, не код, движки принципиально разные) — подготовить
`/etc/systemd/system/yaam-pg-backup.timer` + `.service` при реальном
деплое; offsite-копия (не тот же диск VPS) обязательна.

**Проверить**: `sudo -u postgres psql -c '\l'` показывает `yaam_production`
с владельцем `yaam_app`; `psql ... -c '\dt'` показывает все таблицы схемы
(`orders`, `payments`, `refunds`, ...); тестовый `pg_dump`/`pg_restore`
round-trip выполнен хотя бы раз вручную до реального продакшен-использования.

## 3. Backend deployment

```bash
sudo useradd --system --home /opt/yaam --shell /usr/sbin/nologin yaam
sudo mkdir -p /opt/yaam
sudo chown yaam:yaam /opt/yaam
# Скопировать репозиторий (git clone или rsync) в /opt/yaam, ветка
# claude/yookassa-get-refund (или main, после мержа)
cd /opt/yaam/server
sudo -u yaam npm ci --omit=dev

# libpq credentials для psql/pg_dump/pg_restore. Создать через редактор,
# формат: 127.0.0.1:5432:*:yaam_app:РЕАЛЬНЫЙ_ПАРОЛЬ
sudo -u yaam nano /opt/yaam/.pgpass
sudo chmod 600 /opt/yaam/.pgpass

# Применить свежую схему после того, как файл реально размещён на VPS:
sudo -u yaam env PGPASSFILE=/opt/yaam/.pgpass psql \
  --host=127.0.0.1 --port=5432 --username=yaam_app --dbname=yaam_production \
  --set=ON_ERROR_STOP=1 --file=db/postgresql/schema.sql

# Production ENV — на основе server/.env.postgresql.example (Stage 9),
# заполнить реальными значениями:
sudo cp .env.postgresql.example /opt/yaam/server/.env.postgresql
sudo chown yaam:yaam /opt/yaam/server/.env.postgresql
sudo chmod 600 /opt/yaam/server/.env.postgresql
sudo -u yaam nano /opt/yaam/server/.env.postgresql   # заполнить DATABASE_URL/YOOKASSA_*/ADMIN_*/...

sudo cp deploy/yaam-backend-postgresql.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yaam-backend-postgresql
sudo systemctl status yaam-backend-postgresql   # active (running)
```

**Проверить** (readiness-контракт Stage 7, Variant A — см.
`postgresql-application-assembly.md`):

```bash
curl -s http://127.0.0.1:3001/health/live | python3 -m json.tool
# ожидается: {"ok": true, "uptimeSec": ...}

curl -s -w '\n%{http_code}\n' http://127.0.0.1:3001/health/ready
# ожидается: 200, {"ok": true, "database": {"ok": true}, "pool": {...},
#   "schedulers": [3 записи], "bot": {...}}
```

**Graceful shutdown** (проверить перед реальным трафиком):

```bash
sudo systemctl stop yaam-backend-postgresql
sudo journalctl -u yaam-backend-postgresql -n 20 --no-pager
# ожидается в логе: получен SIGTERM, scheduler'ы остановлены, HTTP закрыт,
# пул PostgreSQL закрыт — без "hanging" / без force-kill таймаута
```

**Reboot survival**:

```bash
sudo reboot
# после переподключения:
sudo systemctl is-enabled yaam-backend-postgresql   # enabled
sudo systemctl is-enabled postgresql                # enabled
curl -s http://127.0.0.1:3001/health/ready           # 200 без ручного вмешательства
```

## 4. Nginx

```bash
sudo apt-get install -y nginx
sudo mkdir -p /var/www/certbot
sudo cp /opt/yaam/server/deploy/nginx-yaam-postgresql-bootstrap.conf /etc/nginx/sites-available/yaam-postgresql
# Заменить ${DOMAIN} на реальный поддомен (например, api-pg.yaam.su)
sudo sed -i 's/\${DOMAIN}/api-pg.yaam.su/g' /etc/nginx/sites-available/yaam-postgresql
sudo ln -s /etc/nginx/sites-available/yaam-postgresql /etc/nginx/sites-enabled/
sudo nginx -t   # ОБЯЗАТЕЛЬНО перед reload — синтаксическая проверка
sudo systemctl reload nginx
```

**Проверить**: `curl -I http://api-pg.yaam.su/health/live` (до SSL — см.
раздел 5) отвечает через Nginx, не напрямую. Gzip проверяется после включения
финального TLS-конфига, где он настроен.

## 5. SSL

```bash
cd /opt/yaam
DOMAIN=api-pg.yaam.su EMAIL=admin@yaam.su bash server/deploy/setup-ssl.sh

# Только ПОСЛЕ успешного certbot заменить временный HTTP-only конфиг на
# финальный TLS-конфиг. До выпуска сертификата этот файл включать нельзя:
# nginx -t завершится ошибкой на отсутствующих fullchain.pem/privkey.pem.
sudo cp server/deploy/nginx-yaam-postgresql.conf /etc/nginx/sites-available/yaam-postgresql
sudo sed -i 's/\${DOMAIN}/api-pg.yaam.su/g' /etc/nginx/sites-available/yaam-postgresql
sudo nginx -t
sudo systemctl reload nginx
```

Скрипт (см. полный текст и комментарии в `server/deploy/setup-ssl.sh`)
устанавливает certbot, запрашивает подтверждение DNS вручную (защита от
rate-limit Let's Encrypt при преждевременном запуске), выпускает
сертификат через `certbot certonly --webroot`, проверяет автопродление через
`--dry-run`, подтверждает наличие systemd-таймера автопродления (certbot
сам его создаёт при установке через apt — не изобретается свой cron).

**Проверить**:
```bash
curl -I https://api-pg.yaam.su/health/live
# ожидается: HTTP/2 200, Strict-Transport-Security: max-age=...

curl -I http://api-pg.yaam.su/health/live
# ожидается: 301 редирект на https://
```

## 6. Trust Proxy validation (ОБЯЗАТЕЛЬНО перед включением IP-allowlist)

Приложение (Stage 9, `services/postgresql/app.js`) требует явный
`TRUST_PROXY=loopback` в `.env.postgresql` — без него, даже за реальным
Nginx, `req.ip` НЕ отражает `X-Forwarded-For` (безопасный дефолт). Логика
уже проверена живыми тестами на уровне приложения
(`server/test/postgresql/trustProxyStage9.test.js`, 7/7 — см. PDF-отчёт),
но САМА физическая прокси-цепочка (Nginx → Node) не может быть проверена
без реального сервера — этот шаг закрывает именно её.

```bash
# Выполнить с ВНЕШНЕЙ машины с известным публичным IP TEST_CLIENT_IP.
# Сначала обычный запрос, затем попытку подделать клиентский XFF:
curl -s https://api-pg.yaam.su/api/restaurants >/dev/null
curl -s https://api-pg.yaam.su/api/restaurants \
  -H "X-Forwarded-For: 185.71.76.1" >/dev/null
# На staging временно добавить ТОЛЬКО логирование req.ip в access log и сразу
# удалить после проверки. В ОБОИХ запросах req.ip обязан быть TEST_CLIENT_IP.
# Он НЕ должен стать 185.71.76.1: это означало бы spoofing через входящий XFF.
# Затем выполнить прямой loopback-запрос, передав тестовый XFF, и подтвердить,
# что приложение доверяет заголовку только когда peer действительно loopback.
# После проверки удалить временный лог и перезапустить unit.
```

**Решение по IP-allowlist (задание Stage 9, п.6 — явное требование)**:

> НЕ включать IP allowlist, если невозможно гарантировать корректный
> X-Forwarded-For. Если всё корректно — включить. Если нет — оставить
> выключенным и подробно описать почему.

**Решение, зафиксированное этим документом: IP-allowlist ОСТАЁТСЯ
ВЫКЛЮЧЕННЫМ** (`YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST=false`, дефолт в
`.env.postgresql.example`) **до тех пор, пока описанная выше проверка не
будет выполнена вручную на реальном сервере** — в текущем окружении
подготовки Stage 9 реального Nginx/VPS не существует, поэтому гарантировать
корректность X-Forwarded-For невозможно, значит включать нельзя. Это НЕ
блокер безопасности: канонический lookup (Stage 8, `verifyWebhook()`)
остаётся ЕДИНСТВЕННЫМ ОБЯЗАТЕЛЬНЫМ механизмом подлинности webhook,
самодостаточным и не зависящим от корректности прокси-цепочки (см.
`postgresql-payment-safety.md`). IP-allowlist — дополнительный, опциональный
слой defense-in-depth, включаемый ТОЛЬКО после подтверждения этого шага на
реальном сервере.

## 7. YooKassa TEST account validation

**Статус: код и fail-closed конфигурация подготовлены; реальный Sandbox
acceptance выполняется отдельным контролируемым шагом.** Секретный ключ
никогда не помещается в этот runbook, Git или shell argv.

Когда тестовые `YOOKASSA_SHOP_ID`/`SECRET_KEY` будут получены (личный
кабинет ЮKassa, тестовый режим):

```bash
# В .env.postgresql:
#   PAYMENT_PROVIDER=yookassa
#   YOOKASSA_ENV=sandbox
#   YOOKASSA_SHOP_ID=<тестовый shop id>
#   YOOKASSA_SECRET_KEY=<тестовый ключ test_...>
#   YOOKASSA_RETURN_URL=https://yaam.su/
#   YOOKASSA_WEBHOOK_URL=https://api-pg.yaam.su/api/webhooks/payment
#   ENABLE_DEV_PAYMENT_ROUTES=false
sudo systemctl restart yaam-backend-postgresql
```

Чеклист проверки (соответствует Stage 8's `paymentSafetyStage8.test.js`,
но против НАСТОЯЩЕГО API ЮKassa вместо fake-транспорта):

1. **create payment** — реальный `POST /v3/payments` через
   `YookassaProvider.createPayment()`; подтвердить `confirmation.confirmation_url`
   реально открывается и ведёт на sandbox-страницу оплаты банковской картой.
2. **payment succeeded** — оплатить тестовый платёж (тестовые реквизиты
   ЮKassa для sandbox), подтвердить `getStatus()` возвращает `'succeeded'`.
3. **webhook** — подтвердить, что ЮKassa реально присылает
   `payment.succeeded` уведомление на `https://api-pg.yaam.su/api/webhooks/payment`,
   и что `verifyWebhook()` (Stage 8, канонический lookup) реально его
   подтверждает — заказ переходит в `awaiting_restaurant`.
4. **refund** — отменить оплаченный/принятый тестовый заказ, подтвердить,
   что `ensureRefundReady()`/`sweepStuckRefunds()` (Stage 8) реально
   отправляют `POST /v3/refunds` и возврат завершается `succeeded`.
5. **duplicate webhook** — вручную повторно доставить то же уведомление
   (или дождаться повтора от ЮKassa) — подтвердить отсутствие повторного
   эффекта (тот же заказ не переходит в awaiting_restaurant дважды).
6. **timeout** — временно заблокировать исходящий трафик к
   `api.yookassa.ru` (например, `iptables` на VPS), подтвердить, что
   `createPaymentWithTimeout`/`refundPaymentWithTimeout` (10с дефолт)
   корректно завершаются ошибкой, не зависают бесконечно.
7. **cancellation** — отменить заказ до оплаты, подтвердить корректный
   переход `cancelled`, без обращения к провайдеру (нет платежа — нечего
   возвращать).
8. **reconciliation** — искусственно создать "зависший" возврат (как в
   `paymentSafetyStage8.test.js`'s C1) на реальной БД, подтвердить, что
   `sweepStuckRefunds()` реально подхватывает его и доводит до провайдера.

Фактические результаты этой проверки должны фиксироваться в отдельном
acceptance-отчёте; наличие конфигурации в runbook не является доказательством
живого Sandbox-теста.

## 8. Production logging

Приложение пишет структурные логи в stdout/stderr (Stage 7-8, `console.log`/
`console.error`, без секретов/сырых webhook-тел/`Authorization`-заголовков —
см. security review в `production-switch-stage-8.pdf`). systemd/journald
УЖЕ управляет ротацией автоматически для `Type=simple`-юнитов — отдельный
logrotate НЕ требуется (переиспользование существующего механизма, не
изобретение нового):

```bash
# Ограничить размер журнала (опционально, в /etc/systemd/journald.conf):
#   SystemMaxUse=500M
sudo journalctl -u yaam-backend-postgresql --disk-usage
sudo journalctl -u yaam-backend-postgresql -f   # live-просмотр для проверки
```

**Log levels** — приложение не имеет отдельных уровней (info/debug/warn) —
`console.log` (успешные операции) / `console.error` (ошибки/отклонения) —
уже соответствует минимально необходимой гранулярности для production;
вводить структурированный логгер (winston/pino) — отдельное, не требуемое
Stage 9 решение (не добавлено — избыточная зависимость без доказанной
необходимости).

**Secrets masking** — подтверждено статически (Stage 8 security review):
`YOOKASSA_SECRET_KEY`/`Authorization`-заголовки/order access token/полное
тело webhook нигде не логируются. Динамическая проверка на реальном
сервере: `sudo journalctl -u yaam-backend-postgresql | grep -i "secret\|authorization\|bearer"`
— ожидается пусто.

## 9. Health monitoring

**PostgreSQL** — `sudo systemctl status postgresql`; `/health/ready`
(приложение) уже делает живой `SELECT 1` на каждый вызов (Stage 6).

**Disk/memory** — минимальный пример (systemd timer + скрипт, не полноценный
Prometheus/Grafana стек — избыточно для текущего масштаба одного VPS):

```bash
# /opt/yaam/scripts/health-check.sh (подготовить при реальном деплое):
#!/usr/bin/env bash
df -h / | awk 'NR==2 {if ($5+0 > 85) print "DISK WARNING: " $5 " used"}'
free -m | awk '/Mem:/ {if ($3/$2*100 > 90) print "MEMORY WARNING: " $3"/"$2"MB"}'
curl -sf http://127.0.0.1:3001/health/ready >/dev/null || echo "BACKEND NOT READY"
```

**Process** — `systemctl status yaam-backend-postgresql`/`postgresql`
(`Restart=on-failure` уже настроен в systemd unit — автовосстановление при
падении).

**Scheduler** — уже отражено в `/health/ready`'s `schedulers` (3 записи:
pause-expiry, order-timeout, refund-reconciliation — Stage 5/8), каждая с
`running: true/false`.

## 10. Что НЕ делать на Stage 9

- НЕ переключать `server.js` (SQLite) — production-приложение остаётся на
  SQLite.
- НЕ переводить пользователей на PostgreSQL-backend.
- НЕ подключать боевые (не тестовые) YooKassa credentials.
- НЕ направлять реальный внешний трафик (DNS `api.yaam.su`, не тестовый
  поддомен) на этот backend.
- НЕ отключать существующий SQLite production.

## Что осталось только для Stage 10

- Реальное переключение `server.js` → PostgreSQL-backend (или замена точки
  входа) — отдельный, явно утверждённый шаг.
- Подключение боевых YooKassa credentials.
- Перенос/миграция реальных production-данных (заказы/платежи) с SQLite на
  PostgreSQL, если требуется сохранить историю.
- Обновление DNS на реальный, постоянный поддомен/домен.
- Включение `YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST=true` (после
  подтверждения раздела 6 на реальном сервере).
- Отключение/архивация SQLite production-пути.
