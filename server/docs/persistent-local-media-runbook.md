# Persistent Local Media — VPS Runbook (Stage 5B.2)

Этот документ описывает, как включить постоянное хранилище фотографий
(`MEDIA_LOCAL_ROOT`) на реальном Timeweb VPS. **Ничего из этого не выполнено
в рамках Stage 5B.2** — ни каталоги, ни Nginx, ни DNS/SSL на реальном
сервере не менялись. Документ подготовлен для владельца YAAM, чтобы
выполнить эти шаги самому (или попросить это сделать) при реальном
подключении, отдельно от кода.

## Почему не S3

YAAM работает в масштабе одного региона (Чечня): один VPS, фотографии
загружает только владелец через HQ, ресторанов — не тысячи, видео нет.
Отдельное S3-совместимое object storage на этом масштабе — инфраструктура
«на вырост», которая усложняет деплой (лишние credentials, лишний сетевой
переход при каждой загрузке/удалении) без реальной пользы. Постоянная
директория на том же VPS, где уже работает backend, проще, дешевле и
достаточно надёжна при условии, что она включена в backup (раздел 5 ниже).

## 1. Создать директорию

```bash
sudo install -d -o yaam -g yaam -m 0750 /var/lib/yaam/media
sudo install -d -o yaam -g yaam -m 0750 /var/lib/yaam/media/public
sudo install -d -o yaam -g yaam -m 0750 /var/lib/yaam/media/private
sudo install -d -o yaam -g yaam -m 0750 /var/lib/yaam/media/private/masters
```

`yaam` — тот же системный пользователь, от которого уже работает
`yaam-backend-postgresql.service` (см. `deploy/yaam-backend-postgresql.service`).
Права `0750` — читает/пишет только владелец (backend-процесс) и группа,
никакого доступа "остальным" — Nginx должен читать `public/` через тот же
пользователя/группу (добавить `www-data`/`nginx` в группу `yaam` либо
запускать worker-процессы Nginx от группы `yaam` — выбрать по факту
дистрибутива на реальном VPS).

Приложение само создаёт `public/`/`private/masters/` идемпотентно при старте
(`LocalMediaProvider.validateConfig()`, `services/hq/media/provider.js`) —
шаги выше нужны только для того, чтобы задать владельца/права ДО первого
запуска, а не полагаться на то, что процесс создаст их с правильными правами
автоматически (создаст с правами процесса-владельца, что обычно и есть
`yaam`, но права каталога стоит проверить явно один раз).

## 2. Переменные окружения

Добавить в `/opt/yaam/server/.env.postgresql` (реальный production `.env`,
не в Git):

```bash
MEDIA_PROVIDER=local
MEDIA_LOCAL_ROOT=/var/lib/yaam/media
MEDIA_LOCAL_BASE_URL=https://api-pg.yaam.su/media
```

Не заводить отдельный поддомен `media.yaam.su`, если в этом нет отдельной
причины (CDN в будущем, например) — путь `/media` на уже существующем
backend-хосте (`api-pg.yaam.su`) требует нуля новых DNS-записей/сертификатов.

## 3. Nginx

Раскомментировать блок `location /media/` в
`server/deploy/nginx-yaam-postgresql.conf` (см. комментарий в самом файле —
он уже подготовлен, просто закомментирован до этого шага) и применить:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Проверить, что публичное фото открывается напрямую (без Node в цепочке —
можно временно остановить backend и убедиться, что фото всё равно
открывается):
```bash
curl -I https://api-pg.yaam.su/media/restaurants/1/<uuid>/card.webp
# ожидается: 200, Content-Type: image/webp, Cache-Control: public, max-age=31536000, immutable
```

Проверить, что приватный master НЕ доступен ни при каком пути (у него нет
`location`, поэтому запрос уйдёт в общий `location /` и попадёт в Node,
который тоже его не отдаёт — двойная защита):
```bash
curl -I https://api-pg.yaam.su/media/private/masters/restaurants/1/<uuid>/master.webp
# ожидается: 404 (не 200, не directory listing)
```

## 4. Перезапустить backend

```bash
sudo systemctl restart yaam-backend-postgresql
sudo journalctl -u yaam-backend-postgresql -n 50 --no-pager
```

Ожидается: приложение стартует без ошибок конфигурации (fail-closed
`validateAppEnv()`/`LocalMediaProvider.validateConfig()` бросили бы понятную
ошибку при неправильных правах/пути — их отсутствие в логе означает, что
директория настроена корректно).

## 5. Backup

Добавить `/var/lib/yaam/media` в то же расписание, что и `pg_dump` (см.
`postgresql-deployment-runbook.md`, раздел Backup — команда `tar` уже там).
Не создавать отдельный backup-механизм — это тот же systemd timer/cron, что
и для PostgreSQL, просто одной командой больше.

## 6. Загрузить первые реальные фотографии

Через HQ (владелец YAAM), не тестовыми/скачанными изображениями — реальные
фотографии ресторанов/блюд, которые будут использоваться в проде. Проверить
визуально card/full на мобильном viewport (390×844) — качество, отсутствие
искажений, letterbox для вертикальных фото в галерее блюда.

## 7. Проверить удаление

Удалить одну тестовую фотографию через HQ, убедиться:
- она исчезла с публичного сайта немедленно;
- файлы (`thumb`/`card`/`full`/`master`) физически удалены с диска
  (`find /var/lib/yaam/media -name '<известный uuid>*'` — пусто);
- HQ не показал ошибку, следующая фотография (если была) стала главной
  автоматически (если удалённая была главной).

## 8. Restore-drill (на ОТДЕЛЬНОМ тестовом пути, не поверх рабочего)

```bash
sudo -u yaam mkdir -p /tmp/yaam-media-restore-test
sudo -u yaam tar -xzf /var/backups/yaam/yaam_media_ФАЙЛ.tar.gz \
  -C /tmp/yaam-media-restore-test
diff -rq /tmp/yaam-media-restore-test /var/lib/yaam/media | head -20
sudo rm -rf /tmp/yaam-media-restore-test
```

Не восстанавливать поверх `/var/lib/yaam/media` без крайней необходимости —
только для реального аварийного восстановления, с остановленным backend, тем
же принципом, что и restore PostgreSQL (см. `backup-restore.md`).

## 9. Rollback

Если что-то пошло не так после включения persistent-режима:

1. `sudo systemctl stop yaam-backend-postgresql`.
2. Закомментировать `MEDIA_PROVIDER=local`/`MEDIA_LOCAL_ROOT`/
   `MEDIA_LOCAL_BASE_URL` обратно в `.env.postgresql` (медиа-раздел HQ станет
   недоступен, остальной YAAM продолжит работать — это уже проверено
   тестами, fail-closed без крэша).
3. Закомментировать `location /media/` обратно в Nginx-конфиге, `nginx -t &&
   systemctl reload nginx`.
4. `sudo systemctl start yaam-backend-postgresql`.

Каталог `/var/lib/yaam/media` при этом НЕ удаляется — он остаётся на диске
до отдельного явного решения, тем же принципом, что и остальные откаты в
проекте (не удалять данные без утверждённого шага).
