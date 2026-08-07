#!/usr/bin/env bash
# hqtest-set-commit-sha.sh — Stage 31, раздел 8.
#
# ЗАЧЕМ. GIT_COMMIT_SHA в .env.hqtest — ручное значение (server/services/
# postgresql/health.js читает его как есть, не выводит из git). Забытое
# обновление после деплоя даёт /health/ready.commitSha, показывающий
# ПРЕДЫДУЩИЙ коммит — реально произошло на Stage 30, поймано только
# ручной сверкой. Этот скрипт убирает человеческий шаг "скопировать SHA
# вручную": читает реальный HEAD активного релиза (симлинк `current`) и
# подставляет его в env-файл автоматически.
#
# НЕ выполняется автоматически ни при каком деплое сам по себе — это
# отдельный явный шаг runbook'а (server/docs/hqtest-incremental-deploy-
# runbook.md, раздел 7), запускается оператором вручную ПОСЛЕ переключения
# симлинка `current`, ДО restart сервиса.
#
# Область действия — ТОЛЬКО hqtest. Никогда не трогает api-pg (другой
# env-файл, другой юнит, здесь даже не упоминается по пути).
#
# Не деплоит, не мигрирует, не рестартует сервис сам — только один точечный
# safe edit одного файла, с обязательным бэкапом до правки.
set -euo pipefail

CURRENT_LINK="${HQTEST_CURRENT_LINK:-/opt/yaam-hqtest/current}"
ENV_FILE="${HQTEST_ENV_FILE:-/opt/yaam-hqtest/server/.env.hqtest}"
BACKUP_DIR="${HQTEST_ENV_BACKUP_DIR:-/opt/yaam-hqtest/backups/env}"

if [[ ! -L "$CURRENT_LINK" && ! -d "$CURRENT_LINK" ]]; then
  echo "ОШИБКА: $CURRENT_LINK не найден (ожидался симлинк на активный релиз)." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ОШИБКА: $ENV_FILE не найден." >&2
  exit 1
fi

NEW_SHA="$(git -C "$CURRENT_LINK" rev-parse HEAD)"
if [[ -z "$NEW_SHA" ]]; then
  echo "ОШИБКА: не удалось прочитать HEAD из $CURRENT_LINK." >&2
  exit 1
fi

OLD_SHA="$(grep -E '^GIT_COMMIT_SHA=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  echo "GIT_COMMIT_SHA уже актуален ($NEW_SHA) — изменений не требуется."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/.env.hqtest.${TIMESTAMP}.pre-commitsha.bak"
cp -p "$ENV_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

if grep -qE '^GIT_COMMIT_SHA=' "$ENV_FILE"; then
  sed -i "s/^GIT_COMMIT_SHA=.*/GIT_COMMIT_SHA=${NEW_SHA}/" "$ENV_FILE"
else
  printf '\nGIT_COMMIT_SHA=%s\n' "$NEW_SHA" >> "$ENV_FILE"
fi

echo "GIT_COMMIT_SHA: ${OLD_SHA:-<не задан>} -> ${NEW_SHA}"
echo "Бэкап: $BACKUP_FILE"
echo "Далее: sudo systemctl restart yaam-backend-hqtest.service"
