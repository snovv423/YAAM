#!/usr/bin/env bash
# Let's Encrypt bootstrap для YAAM PostgreSQL backend — ШАБЛОН.
#
# Production Switch — Stage 9. ЭТОТ СКРИПТ НИКОГДА НЕ ЗАПУСКАЛСЯ на
# реальном сервере — подготовлен без доступа к реальной инфраструктуре.
# Прочитайте целиком и адаптируйте ${DOMAIN}/${EMAIL} перед запуском на
# реальном VPS. См. server/docs/postgresql-deployment-runbook.md.
#
# Автопродление — НЕ реализовано отдельным cron/скриптом здесь: пакет
# certbot на Debian/Ubuntu САМ устанавливает systemd timer
# (certbot.timer/certbot-renew.timer) при установке через apt — изобретать
# свой планировщик поверх уже существующего было бы дублированием
# (см. `systemctl list-timers | grep certbot` для проверки после установки).

set -euo pipefail

DOMAIN="${DOMAIN:?Укажите DOMAIN=api-pg.yaam.su (или реальный поддомен) перед запуском}"
EMAIL="${EMAIL:?Укажите EMAIL=admin@yaam.su (для уведомлений об истечении сертификата) перед запуском}"

echo "== YAAM PostgreSQL backend — SSL bootstrap для ${DOMAIN} =="
echo "Этот скрипт предполагает Debian/Ubuntu с уже установленным Nginx"
echo "(server/deploy/nginx-yaam-postgresql-bootstrap.conf уже размещён в"
echo "/etc/nginx/sites-available/ и включён в sites-enabled)."
echo

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot не найден — устанавливаю (apt, Debian/Ubuntu)..."
  sudo apt-get update
  sudo apt-get install -y certbot python3-certbot-nginx
fi

echo "== Проверка DNS: ${DOMAIN} должен указывать на IP этого сервера =="
echo "(Stage 9 этого не проверяла — реального VPS/домена нет. Проверьте"
echo "вручную: dig +short ${DOMAIN} должен совпасть с IP этого VPS.)"
read -r -p "DNS подтверждён вручную? [y/N] " dns_confirmed
if [[ "${dns_confirmed}" != "y" && "${dns_confirmed}" != "Y" ]]; then
  echo "Остановлено — подтвердите DNS перед выпуском сертификата (Let's"
  echo "Encrypt имеет rate-limit на неудачные попытки для одного домена)."
  exit 1
fi

echo "== Выпуск сертификата (HTTP-01 webroot; TLS-конфиг включается после выпуска) =="
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot \
  --webroot-path /var/www/certbot \
  -d "${DOMAIN}" \
  --email "${EMAIL}" \
  --agree-tos \
  --no-eff-email

echo "== Проверка автопродления (dry-run, не расходует rate-limit) =="
sudo certbot renew --dry-run

echo "== Проверка systemd-таймера автопродления =="
systemctl list-timers | grep -i certbot || {
  echo "ВНИМАНИЕ: certbot-таймер не найден в systemd — проверьте установку"
  echo "вручную (некоторые дистрибутивы используют cron вместо systemd timer)."
}

echo
echo "Готово. Следующие шаги вручную (не автоматизированы этим скриптом):"
echo "1. Заменить bootstrap-конфиг на nginx-yaam-postgresql.conf"
echo "2. Выполнить nginx -t и только затем reload"
echo "3. Проверить HTTPS/HSTS и HTTP -> HTTPS по deployment runbook"
