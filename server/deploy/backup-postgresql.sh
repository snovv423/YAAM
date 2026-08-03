#!/usr/bin/env bash
# =============================================================================
# АРХИВНЫЙ ШАБЛОН — НЕ АКТИВНЫЙ МЕХАНИЗМ (Stage 25).
#
# Этот файл описывает более ранний, ниоткуда не установленный cron-план и
# никогда не запускался ни против одной реальной базы (см. комментарий ниже).
# Реальный работающий backup на api-pg/hqtest — это `yaam-pg-backup` /
# `yaam-pg-offsite-backup` (Stage 19.2, см. docs/postgresql-deployment-
# runbook.md и deploy/RESTORE-POSTGRESQL.md) — они и есть источник истины для
# восстановления. Файл НЕ удалён: test/postgresql/infraStage15.test.js (D5)
# по-прежнему проверяет его наличие и конкретное содержимое (gpg-шифрование,
# RETENTION_DAYS, отсутствие пароля в открытом виде) как исторический шаблон
# практик шифрования/ретеншена — эти свойства остаются верными, просто сам
# скрипт не смонтирован ни в один реальный cron.
# =============================================================================
# YAAM — ежедневный backup PostgreSQL (Stage 15). ШАБЛОН, не запускался ни
# против одной реальной базы.
#
# СЕКРЕТЫ НЕ ЗАШИТЫ В СКРИПТ. Пароль берётся из ~/.pgpass или переменной
# окружения PGPASSFILE — файла с правами 600, принадлежащего пользователю
# приложения. Строка подключения с паролем в командной строке была бы видна
# в `ps` любому пользователю системы.
#
# Установка (cron пользователя yaam, ежедневно в 03:30):
#   30 3 * * * /opt/yaam/server/deploy/backup-postgresql.sh >> /var/log/yaam/backup.log 2>&1
set -euo pipefail

: "${YAAM_DB_NAME:?YAAM_DB_NAME обязателен}"
: "${YAAM_DB_USER:?YAAM_DB_USER обязателен}"
BACKUP_DIR="${YAAM_BACKUP_DIR:-/var/backups/yaam}"
RETENTION_DAYS="${YAAM_BACKUP_RETENTION_DAYS:-14}"
# Публичный ключ age/gpg получателя. Без него backup не шифруется — и это
# осознанный отказ, а не молчаливое ослабление: скрипт остановится.
RECIPIENT="${YAAM_BACKUP_GPG_RECIPIENT:?YAAM_BACKUP_GPG_RECIPIENT обязателен — незашифрованный дамп с ПДн хранить нельзя}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/yaam-${STAMP}.dump.gpg"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# -Fc — custom format: позволяет частичное восстановление и параллельный
# restore, в отличие от простого SQL-дампа.
# Поток сразу шифруется: незашифрованный файл не появляется на диске даже
# на секунду.
pg_dump -Fc -U "$YAAM_DB_USER" -d "$YAAM_DB_NAME" \
  | gpg --encrypt --recipient "$RECIPIENT" --trust-model always --output "$TARGET"

chmod 600 "$TARGET"

# ПРОВЕРКА УСПЕШНОСТИ. Пустой или подозрительно маленький файл — это
# провалившийся backup, который выглядит как успешный. Порог намеренно
# грубый: настоящий дамп YAAM заведомо больше 10 КБ.
SIZE="$(stat -c%s "$TARGET" 2>/dev/null || stat -f%z "$TARGET")"
if [ "$SIZE" -lt 10240 ]; then
  echo "[backup] ОШИБКА: файл ${TARGET} слишком мал (${SIZE} байт) — backup считается неудачным" >&2
  rm -f "$TARGET"
  exit 1
fi

echo "[backup] ok ${TARGET} (${SIZE} байт)"

# Очистка старых копий — ПОСЛЕ успешной проверки текущей. Обратный порядок
# означал бы риск удалить последнюю рабочую копию перед неудачным backup.
find "$BACKUP_DIR" -name 'yaam-*.dump.gpg' -type f -mtime "+${RETENTION_DAYS}" -print -delete

echo "[backup] хранение: ${RETENTION_DAYS} дней"
