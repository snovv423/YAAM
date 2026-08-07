# hqtest — инкрементальный деплой (releases/&lt;sha&gt; + current) — runbook

**Статус: ПОДГОТОВЛЕНО по итогам Stage 30 (живой контролируемый деплой),
формализовано в Stage 31.** До этого документа формального runbook для
ФАКТИЧЕСКИ используемой на hqtest схемы деплоя не существовало —
`postgresql-deployment-runbook.md` описывает только первичный bring-up VPS
(Stage 9), не повторные релизы. Процедура ниже получена прямым осмотром
живой инфраструктуры (`ls -la /opt/yaam-hqtest/`, `readlink`, `systemctl cat`
для `WorkingDirectory`/`EnvironmentFile`) во время Stage 30, а не
придумана — каждый шаг уже был выполнен вручную минимум один раз
(деплой коммита `0f8b8944` на hqtest).

Область действия — **только hqtest**. api-pg (production-oriented staging)
использует отдельный юнит (`yaam-backend-postgresql.service`), отдельный
top-level checkout, отдельный env-файл — эта процедура его не касается и не
должна применяться к нему без отдельного, явно утверждённого решения
(CLAUDE.md, "Production guardrails").

## Топология (как есть)

```
/opt/yaam-hqtest/
├── releases/
│   └── <short-git-sha>/        # полностью независимый git checkout
│       ├── .git/               # свой собственный, не shared
│       ├── node_modules/       # npm ci --omit=dev, свой на релиз
│       └── server/...
├── current -> releases/<short-git-sha>/   # symlink на активный релиз
└── server/.env.hqtest          # ОБЩИЙ для всех релизов, НЕ per-release
```

systemd-юнит `yaam-backend-hqtest.service`:
- `WorkingDirectory=/opt/yaam-hqtest/current/server`
- `EnvironmentFile=/opt/yaam-hqtest/server/.env.hqtest`

Владелец файлов — `yaam:yaam`. Пользователь `deploy` подключается по SSH и
имеет passwordless sudo (см. `reference_yaam_vps_ssh_access` — доступ уже
подтверждён рабочим).

## 0. Preflight

```bash
ssh -i ~/.ssh/yaam_vps_ed25519 deploy@<hqtest-host>

# Текущий активный релиз и его коммит
readlink /opt/yaam-hqtest/current
sudo -u yaam git -C /opt/yaam-hqtest/current rev-parse HEAD

# Текущее состояние миграций (сравнить с ожидаемым до/после)
curl -s http://127.0.0.1:3002/health/ready | python3 -m json.tool | grep -A3 migrations

# Сервис жив, без ошибок в последних записях
sudo systemctl status yaam-backend-hqtest.service --no-pager
sudo journalctl -u yaam-backend-hqtest.service --no-pager -n 50

# api-pg НЕ должен быть затронут никакими последующими шагами — снять
# контрольные точки ДО начала (сверить ПОСЛЕ, в шаге 8).
sudo systemctl show yaam-backend-postgresql.service -p ActiveEnterTimestamp
sudo stat -c '%Y %n' /opt/yaam/server/.env.postgresql
```

## 1. Backup

```bash
sudo systemctl start yaam-pg-backup.service   # дамп yaam_hqtest (и двух других БД, тот же таймер)
# Дождаться завершения, проверить свежий файл:
ls -la /var/backups/yaam/ | grep yaam_hqtest | tail -3
```

## 2. Создание нового релиза

```bash
NEW_SHA=<полный или короткий SHA коммита, который деплоим>
RELEASE_DIR="/opt/yaam-hqtest/releases/${NEW_SHA:0:7}"

sudo -u yaam git clone --branch claude/yookassa-get-refund --single-branch \
  https://github.com/<org>/<repo>.git "$RELEASE_DIR"
sudo -u yaam git -C "$RELEASE_DIR" checkout "$NEW_SHA"

# Убедиться, что checkout действительно на ожидаемом коммите ПЕРЕД npm ci —
# дешевле остановиться здесь, чем после установки зависимостей.
sudo -u yaam git -C "$RELEASE_DIR" rev-parse HEAD
```

## 3. npm ci

```bash
cd "$RELEASE_DIR/server"
sudo -u yaam npm ci --omit=dev
```

## 4. migrate:status (ДО переключения current)

```bash
# Ещё на СТАРОМ активном релизе (current пока не тронут) — просто
# показывает, сколько миграций РЕАЛЬНО применено к БД hqtest сейчас.
cd /opt/yaam-hqtest/current/server
sudo -u yaam env $(cat /opt/yaam-hqtest/server/.env.hqtest | xargs) \
  node scripts/migration-status.js
```

Зафиксировать вывод (`применено: X из Y`) — сверить с ожидаемым числом
новых миграций в диффе, который деплоится.

## 5. Применение миграций

Миграции применяются САМИМ приложением при старте (`runMigrations=true` по
умолчанию для production entry point, `server/services/postgresql/app.js`)
— отдельной ручной команды на "накатить миграции" нет. Это происходит
автоматически на шаге 7 (restart), НЕ до него — поэтому "применение
миграций" в этом runbook не отдельный шаг, а прямое следствие рестарта на
новом релизе.

Если требуется применить миграции ДО переключения трафика на новый код
(например, долгая миграция) — вне объёма этого документа, готовить
отдельно.

## 6. Переключение current

```bash
sudo ln -sfn "$RELEASE_DIR" /opt/yaam-hqtest/current
readlink /opt/yaam-hqtest/current   # подтвердить
```

## 7. Автоматическая фиксация GIT_COMMIT_SHA + restart

**Известный, реально найденный на Stage 30 разрыв**: `GIT_COMMIT_SHA` в
`.env.hqtest` — ручное значение (см. `services/postgresql/health.js`,
`getCommitSha: () => env.GIT_COMMIT_SHA`), НЕ выводится из git
автоматически. Забытое обновление даёт `/health/ready.commitSha`,
показывающий предыдущий коммит уже после реального деплоя — именно это
произошло на Stage 30 и было поймано только благодаря ручной сверке.

`server/scripts/hqtest-set-commit-sha.sh` (добавлен этой же стадией)
автоматизирует шаг — читает реальный HEAD `current`-релиза и подставляет
его в env-файл, вместо копирования человеком вручную:

```bash
sudo /opt/yaam-hqtest/server/hqtest-set-commit-sha.sh   # см. текст скрипта ниже
sudo systemctl restart yaam-backend-hqtest.service
```

Скрипт (см. `server/scripts/hqtest-set-commit-sha.sh` в репозитории — этот
файл переносится на VPS вручную/через релиз, т.к. `server/scripts/`
попадает в каждый релиз-checkout, поэтому актуальная копия уже есть в
`$RELEASE_DIR/server/scripts/`; ниже — что он делает):

1. Резервирует `.env.hqtest` (`cp -p ... .env.hqtest.<timestamp>.pre-commitsha.bak`, `chmod 600`).
2. `SHA=$(git -C /opt/yaam-hqtest/current rev-parse HEAD)`.
3. `sed`-подстановка строки `GIT_COMMIT_SHA=` на актуальное значение (создаёт строку, если её нет).
4. Печатает старое и новое значение — оператор видит diff, а не молчаливую замену.

## 8. Readiness + подтверждение

```bash
curl -s http://127.0.0.1:3002/health/ready | python3 -m json.tool
```

Проверить:
- `commitSha` == `$NEW_SHA` (полный, не короткий — сверить префикс);
- `migrations.ok == true`, `migrations.applied == migrations.total`, и
  `total` совпадает с ожидаемым (число файлов в `db/postgresql/migrations/`
  задеплоенного коммита);
- `bot.state == "running"` (или `"disabled"`, если бот намеренно выключен —
  не должно быть `"failed"`);
- `schedulers[].running == true` для всех;
- `database.ok == true`.

```bash
sudo journalctl -u yaam-backend-hqtest.service --no-pager -n 50
# Ошибок сверх уже известных/объяснённых быть не должно.
```

api-pg (контрольная точка из шага 0, сверить, что НЕ изменилась):

```bash
sudo systemctl show yaam-backend-postgresql.service -p ActiveEnterTimestamp
sudo stat -c '%Y %n' /opt/yaam/server/.env.postgresql
```

## 9. Rollback

Если readiness не прошла или найдена регрессия:

```bash
# Симлинк — единственное, что нужно откатить: старый релиз-каталог
# физически никуда не делся.
PREV_RELEASE="/opt/yaam-hqtest/releases/<предыдущий-sha>"
sudo ln -sfn "$PREV_RELEASE" /opt/yaam-hqtest/current
sudo /opt/yaam-hqtest/server/hqtest-set-commit-sha.sh   # вернуть commitSha на старый
sudo systemctl restart yaam-backend-hqtest.service
curl -s http://127.0.0.1:3002/health/ready | python3 -m json.tool
```

**Миграции откатывать НЕЛЬЗЯ автоматически** — миграции проекта аддитивные
(см. `server/services/postgresql/migrator.js`, `assertNotSilentlyDestructive`)
и не имеют down-скриптов по замыслу (задание проекта прямо это
устанавливает). Если новый релиз уже успел применить новую миграцию и
откат кода нужен — старый код должен оставаться совместимым с новой
схемой (аддитивные миграции это гарантируют структурно: новые
таблицы/колонки не мешают старому коду, который их не знает). Если
миграция оказалась ошибочной по существу — это отдельная, вручную
готовящаяся compensating-миграция, не откат.

Старые (более не активные) release-каталоги не удаляются автоматически —
ручная очистка, отдельная задача, не входит в этот runbook.

## 10. Проверка изоляции api-pg (после любого шага 1-9)

```bash
sudo systemctl show yaam-backend-postgresql.service -p ActiveEnterTimestamp,MainPID
sudo stat -c '%Y %n' /opt/yaam/server/.env.postgresql
# Оба значения обязаны БЫТЬ ИДЕНТИЧНЫ значениям, снятым в шаге 0 — любое
# расхождение означает, что деплой hqtest каким-то образом задел api-pg, и
# требует немедленного разбора ДО продолжения.
```
