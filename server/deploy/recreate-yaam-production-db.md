# Пересоздание базы `yaam_production` (staging `api-pg.yaam.su`)

**Статус:** подготовлено локально, на сервере НЕ выполнялось.
Все команды проверены на эфемерных PostgreSQL-базах.

## Почему пересоздание, а не миграция

База отстала на всю историю HQ: 12 таблиц против 38, отсутствуют все
таблицы HQ, расчётов, выплат и документов. Писать миграцию через всю историю
ради базы, в которой **ноль заказов, ноль платежей и ноль возвратов**, —
работа без пользы и с риском.

Ценного содержимого ровно три таблицы: `restaurants` (1 строка),
`categories`, `menu_items` (3 строки). Их перенос — прямое копирование.

## Проверенный маппинг

Таблицы `dishes` **не существует** — ни в старой схеме, ни в новой, ни в коде.
Меню называется `menu_items` везде. Никакого переименования не требуется.

Сверка колонок старой и новой схемы (выполнена на эфемерных базах):

- колонок, которые есть в старой и отсутствуют в новой — **нет**;
- новых обязательных колонок без `DEFAULT` — **нет**;
- переносятся полностью: `restaurants` (19 колонок), `categories` (4),
  `menu_items` (16).

Поэтому `COPY` без преобразований безопасен, а `id` сохраняются — связи
`categories.restaurant_id` и `menu_items.category_id` остаются валидными.

## Порядок

Переменные подставляет оператор. Пароли в командной строке не передаются —
используется `~/.pgpass`.

### 1. Полный backup

```bash
sudo systemctl start yaam-pg-backup.service
sudo systemctl status yaam-pg-backup.service      # ожидается Result=success
ls -lh /var/backups/yaam*/ | tail -3
```

Критерий: свежий файл разумного размера. **Без него дальше не идти.**

### 2. Экспорт справочных данных

```bash
sudo -u postgres pg_dump -a \
  -t restaurants -t categories -t menu_items \
  yaam_production > /var/tmp/yaam_reference_data.sql
grep -c "^INSERT\|^COPY" /var/tmp/yaam_reference_data.sql
```

### 3. Пересчёт строк до

```bash
for t in restaurants categories menu_items orders payments refunds; do
  printf '%-14s ' "$t"
  sudo -u postgres psql -d yaam_production -tAc "SELECT count(*) FROM $t"
done
```

Критерий: `orders`, `payments`, `refunds` равны нулю. **Если нет —
остановиться:** появились данные, и решение о пересоздании нужно принимать
заново.

### 4. Новая база под ВРЕМЕННЫМ именем

Старая база не трогается — она остаётся рабочей до самого переключения.

```bash
sudo -u postgres createdb -O yaam_app yaam_production_v2
```

### 5. Миграции на новой базе

```bash
cd /opt/yaam/server
DATABASE_URL='postgres://yaam_app@127.0.0.1:5432/yaam_production_v2' npm run migrate
DATABASE_URL='postgres://yaam_app@127.0.0.1:5432/yaam_production_v2' npm run migrate:status
```

Критерий: «применено 3 из 3», «совместима с текущим кодом: да».

### 6. Импорт справочных данных

> **Важно про `id`.** Во всех таблицах `id` объявлен как
> `GENERATED ALWAYS AS IDENTITY`. Обычный `INSERT` с явным значением `id`
> такая колонка **отклоняет** («cannot insert a non-DEFAULT value into column
> id»). `pg_dump -a` формирует `COPY`, который это ограничение обходит, —
> поэтому команда ниже работает. Если по какой-то причине используется
> `pg_dump --inserts`, каждому `INSERT` потребуется `OVERRIDING SYSTEM VALUE`.
> Проверено на эфемерных базах: без этого импорт падает на первой же строке.

```bash
sudo -u postgres psql -d yaam_production_v2 -f /var/tmp/yaam_reference_data.sql
sudo -u postgres psql -d yaam_production_v2 -c \
  "SELECT setval(pg_get_serial_sequence('restaurants','id'), COALESCE((SELECT MAX(id) FROM restaurants),1));"
sudo -u postgres psql -d yaam_production_v2 -c \
  "SELECT setval(pg_get_serial_sequence('categories','id'), COALESCE((SELECT MAX(id) FROM categories),1));"
sudo -u postgres psql -d yaam_production_v2 -c \
  "SELECT setval(pg_get_serial_sequence('menu_items','id'), COALESCE((SELECT MAX(id) FROM menu_items),1));"
```

Сдвиг последовательностей обязателен: после `COPY` с явными `id` счётчик
остаётся на единице, и первая же вставка упала бы на конфликте ключа.

### 7. Проверка связей

```bash
sudo -u postgres psql -d yaam_production_v2 -tAc \
  "SELECT count(*) FROM menu_items m JOIN categories c ON c.id=m.category_id
    JOIN restaurants r ON r.id=m.restaurant_id"
```

Критерий: совпадает с числом позиций меню из шага 3.

### 8. Проверка приложения на новой базе

Не переключая сервис: временный процесс на свободном порту.

```bash
cd /opt/yaam/server
DATABASE_URL='postgres://yaam_app@127.0.0.1:5432/yaam_production_v2' \
PG_HEALTH_PORT=3009 PUBLIC_BACKEND_URL=https://api-pg.yaam.su \
  node server.postgresql.js &
sleep 3
curl -s http://127.0.0.1:3009/health/ready | head -c 400
curl -s http://127.0.0.1:3009/api/restaurants | head -c 200
kill %1
```

Критерий: `ok:true`, `migrations.ok:true`, ресторан отдаётся.

### 9. Переключение

```bash
sudo cp /opt/yaam/server/.env.postgresql /opt/yaam/server/.env.postgresql.bak
sudo sed -i 's#/yaam_production#/yaam_production_v2#' /opt/yaam/server/.env.postgresql
sudo grep -c 'yaam_production_v2' /opt/yaam/server/.env.postgresql
sudo systemctl restart yaam-backend-postgresql
sleep 3
curl -s https://api-pg.yaam.su/health/ready | head -c 400
```

### 10. Rollback

Возврат — одна команда, старая база на месте и не изменялась:

```bash
sudo cp /opt/yaam/server/.env.postgresql.bak /opt/yaam/server/.env.postgresql
sudo systemctl restart yaam-backend-postgresql
curl -s https://api-pg.yaam.su/health/ready | head -c 200
```

Старую базу удалять **не раньше**, чем новая отработает несколько дней.

## Что уже проверено локально

Весь сценарий (шаги 2, 5, 6, 7 и проверка последовательностей) прогнан на
эфемерных PostgreSQL-базах: старая схема из настоящего dump, три справочные
таблицы с данными, миграции `0001 → 0003`, импорт с сохранением `id`.

Результат: ресторан и все позиции меню на месте, все связи
`menu_items → categories → restaurants` целы, следующий вставленный `id`
получился больше максимального импортированного (последовательность сдвинута
корректно), fingerprint схемы — совместима.

## Чего этот план НЕ делает

Не удаляет `yaam_production`, не переименовывает базы, не трогает
`yaam_hqtest`, Nginx, DNS и сертификаты.
