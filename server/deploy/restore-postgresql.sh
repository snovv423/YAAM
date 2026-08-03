#!/usr/bin/env bash
# YAAM — восстановление PostgreSQL из backup (Stage 15). ШАБЛОН, не
# запускался ни против одной реальной базы.
#
# ПО УМОЛЧАНИЮ ВОССТАНАВЛИВАЕТ В ОТДЕЛЬНУЮ БАЗУ. Восстановление поверх
# рабочей базы требует явного YAAM_RESTORE_CONFIRM=I-UNDERSTAND-THIS-DESTROYS-DATA.
# Без этого скрипт откажется: «восстановил не туда» — самый дорогой из
# возможных операционных промахов.
set -euo pipefail

: "${YAAM_BACKUP_FILE:?YAAM_BACKUP_FILE обязателен (путь к .dump.gpg)}"
: "${YAAM_DB_USER:?YAAM_DB_USER обязателен}"
TARGET_DB="${YAAM_RESTORE_DB:-yaam_restore_test}"
PRODUCTION_DB="${YAAM_DB_NAME:-}"

if [ -n "$PRODUCTION_DB" ] && [ "$TARGET_DB" = "$PRODUCTION_DB" ]; then
  if [ "${YAAM_RESTORE_CONFIRM:-}" != "I-UNDERSTAND-THIS-DESTROYS-DATA" ]; then
    echo "[restore] ОТКАЗ: цель совпадает с рабочей базой (${TARGET_DB})." >&2
    echo "[restore] Установите YAAM_RESTORE_CONFIRM=I-UNDERSTAND-THIS-DESTROYS-DATA, если это осознанное решение." >&2
    exit 1
  fi
  echo "[restore] ВНИМАНИЕ: восстановление ПОВЕРХ рабочей базы ${TARGET_DB}"
fi

echo "[restore] цель: ${TARGET_DB}"
createdb -U "$YAAM_DB_USER" "$TARGET_DB" 2>/dev/null || echo "[restore] база уже существует, продолжаем"

# --clean --if-exists: повторный прогон в ту же тестовую базу не падает на
# существующих объектах.
gpg --decrypt "$YAAM_BACKUP_FILE" \
  | pg_restore -U "$YAAM_DB_USER" -d "$TARGET_DB" --clean --if-exists --no-owner

# ПРОВЕРКА, ЧТО ВОССТАНОВИЛОСЬ ЧТО-ТО ОСМЫСЛЕННОЕ. Успешный exit code
# pg_restore ещё не означает, что данные на месте.
ORDERS="$(psql -U "$YAAM_DB_USER" -d "$TARGET_DB" -tAc 'SELECT count(*) FROM orders' 2>/dev/null || echo 'ERR')"
if [ "$ORDERS" = "ERR" ]; then
  echo "[restore] ОШИБКА: таблица orders недоступна после восстановления" >&2
  exit 1
fi
echo "[restore] ok: заказов в восстановленной базе — ${ORDERS}"
echo "[restore] ЭТО ТЕСТОВАЯ КОПИЯ. Приложение на неё не переключено."
