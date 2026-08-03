# Восстановление PostgreSQL из backup

Актуально на 2026-08-03 (Stage 19.2).

На VPS **три** базы, и восстанавливаются они по-разному. Перепутать их —
самый дорогой из возможных операционных промахов, поэтому база всегда
называется явно, а цель восстановления по умолчанию — **временная**.

| База | Роль-владелец | Кто её использует | Приложение |
|---|---|---|---|
| `yaam_staging_v2` | `yaam_app` | `api-pg.yaam.su` — **рабочая с Stage 20** | `yaam-backend-postgresql`, порт 3001 |
| `yaam_production` | `yaam_app` | никем; оставлена как точка отката | — |
| `yaam_hqtest` | `yaam_hqtest_app` | `hqtest.yaam.su` | `yaam-backend-hqtest`, порт 3002 |

Схемы у них **разные**: `yaam_production` осталась на старой цепочке (12
таблиц), `yaam_staging_v2` и `yaam_hqtest` — на актуальной (39 таблиц, версии
1–4). Дамп одной базы нельзя восстанавливать поверх другой ни при каких
обстоятельствах.

**Код и база связаны.** Актуальный код отказывается стартовать против старой
схемы: проверка совместимости останавливает запуск и **не меняет данные**.
Поэтому возврат на `yaam_production` требует отката И базы, И кода — одной
правкой `DATABASE_URL` не обойтись. См. раздел «Откат приложения и базы».

## Что где лежит

| Артефакт | Путь / ключ |
|---|---|
| Локальные копии (обе базы) | `/var/backups/yaam/<база>_<UTC>.dump` |
| Контрольная сумма | `/var/backups/yaam/<база>_<UTC>.dump.sha256` |
| Ручные копии перед деплоем hqtest | `/var/backups/yaam-hqtest/` |
| Offsite (шифрованные) | `s3://<bucket>/daily/<ГГГГ>/<ММ>/<ДД>/<база>/<имя>_offsite_<UTC>.dump.age` |
| Ключ расшифровки | `/etc/yaam/offsite-backup.agekey` (только root) |

Локальные копии — `600`, каталог `700`. Хранение — 14 дней, отдельно для
каждой базы: ротация ищет строго по префиксу имени базы, поэтому копии разных
баз не могут удалить друг друга.

## Откат приложения и базы

| Что откатываем | Как |
|---|---|
| Только код | `ln -sfn /opt/yaam/releases/<sha> /opt/yaam/current.new && mv -Tf …` + restart |
| Код и база вместе | то же плюс восстановление прежнего `.env.postgresql` из `/root/yaam-backups-s192/` |
| Только база | **невозможно** для пары «новый код + старая схема»: запуск будет остановлен проверкой совместимости |

Полный откат api-pg на состояние до Stage 20 проверен и занимает ~6 секунд:
симлинк `current` → `releases/ca00f39`, прежний env, `systemctl restart
yaam-backend-postgresql`.

## 1. Проверить целостность локальной копии

```bash
cd /var/backups/yaam
sudo sha256sum -c yaam_hqtest_20260803T113223Z.dump.sha256
sudo pg_restore --list yaam_hqtest_20260803T113223Z.dump | head
```

`pg_restore --list` уже выполняется при создании копии — повреждённый архив
обнаруживается в день создания, а не в день аварии.

## 2. Восстановить во ВРЕМЕННУЮ базу (обычный случай)

Так проверяют пригодность копии. Рабочая база не затрагивается.

```bash
TMPDB=yaam_hqtest_restore_check          # имя обязано отличаться от рабочего
sudo -u postgres createdb "$TMPDB"
sudo -u postgres pg_restore -d "$TMPDB" \
     /var/backups/yaam/yaam_hqtest_20260803T113223Z.dump

# Сверка: таблицы и ключевые счётчики
sudo -u postgres psql -d "$TMPDB" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
sudo -u postgres psql -d "$TMPDB" -c \
  "SELECT (SELECT count(*) FROM restaurants) AS рестораны,
          (SELECT count(*) FROM orders) AS заказы,
          (SELECT count(*) FROM settlement_periods) AS периоды,
          (SELECT count(*) FROM restaurant_payouts) AS выплаты;"

sudo -u postgres dropdb "$TMPDB"
```

Для `yaam_production` — то же самое, но с её дампом и своим именем временной
базы.

## 3. Восстановить из offsite-копии

```bash
sudo aws --endpoint-url "$S3_ENDPOINT_URL" s3 cp \
  "s3://$S3_BUCKET/daily/2026/08/03/yaam_hqtest/<объект>.dump.age" /tmp/
sudo aws --endpoint-url "$S3_ENDPOINT_URL" s3 cp \
  "s3://$S3_BUCKET/daily/2026/08/03/yaam_hqtest/<объект>.dump.age.sha256" /tmp/
cd /tmp && sudo sha256sum -c "<объект>.dump.age.sha256"
sudo age --decrypt -i /etc/yaam/offsite-backup.agekey \
     -o /tmp/restore.dump "/tmp/<объект>.dump.age"
```

Дальше — как в разделе 2. Ключ путей содержит имя базы, поэтому объект
нельзя перепутать, не заметив этого.

## 4. Восстановление ПОВЕРХ рабочей базы

Крайняя мера. Выполняется только по явному решению владельца.

```bash
sudo systemctl stop yaam-backend-hqtest        # или yaam-backend-postgresql
sudo -u postgres pg_dump -Fc -d yaam_hqtest \
     -f /var/backups/yaam-hqtest/pre_restore_$(date -u +%Y%m%dT%H%M%SZ).dump
sudo -u postgres pg_restore -d yaam_hqtest --clean --if-exists --no-owner \
     /var/backups/yaam/yaam_hqtest_<UTC>.dump
sudo systemctl start yaam-backend-hqtest
curl -s https://hqtest.yaam.su/health/ready
```

Копия «перед восстановлением» снимается **всегда**: без неё неудачное
восстановление не откатить.

## Чего восстановление НЕ делает

- не возвращает данные, появившиеся **после** снятия копии;
- не откатывает версию приложения — это отдельная операция (переключение
  симлинка `current` на прошлый release и restart сервиса);
- не переносит схему между базами: у `yaam_production` и `yaam_hqtest` разные
  цепочки миграций.

Откат приложения и восстановление базы — разные операции с разной ценой.
Первая занимает секунды и ничего не теряет; вторая занимает минуты и теряет
всё, что произошло после снятия копии.

## Расписание и мониторинг

| Что | Когда |
|---|---|
| `yaam-pg-backup.timer` | ежедневно 04:15 UTC, разброс до 15 мин |
| `yaam-pg-offsite-backup.timer` | ежедневно 04:45 UTC, разброс до 15 мин |
| Better Stack heartbeat | отправляется **только** после успешной выгрузки **обеих** баз |

Сбой любой из баз даёт ненулевой код возврата unit'а и `/fail` на heartbeat.
Частичный успех успехом не считается.
