-- YAAM — PostgreSQL DDL (target schema for the future PostgreSQL backend).
--
-- Это НЕЗАВИСИМЫЙ, отдельный вариант схемы. Он не подключён ни к какому коду,
-- не исполняется приложением и не заменяет server/db/schema.sql (SQLite,
-- остаётся источником истины для текущего рабочего backend'а).
--
-- Транслирован 1:1 с server/db/schema.sql по состоянию на коммит
-- 74c37917bd486b9f268833fbcffa0fb0450d8e2c, по правилам, зафиксированным в
-- YAAM-postgresql-migration-analysis.pdf (разделы 2, 5, 6):
--   - INTEGER PRIMARY KEY AUTOINCREMENT -> GENERATED ALWAYS AS IDENTITY
--   - TEXT-хранимые даты + datetime('now')          -> TIMESTAMPTZ + NOW()
--   - BLOB                                           -> BYTEA
--   - partial UNIQUE INDEX (CREATE UNIQUE INDEX ... WHERE ...) -> без изменений
--     (нативно поддерживается PostgreSQL)
--   - inline SQLite TRIGGER ... RAISE(ABORT, ...)     -> отдельная PL/pgSQL
--     функция + CREATE TRIGGER ... EXECUTE FUNCTION, RAISE EXCEPTION
--
-- Единственное осознанное отклонение от чистой 1:1 трансляции — CHECK на
-- payments.status (см. ниже, у таблицы payments): в SQLite-схеме он
-- отсутствовал (уже отмечено как находка в предыдущих аудитах); раз таблица
-- переписывается заново для PostgreSQL, отсутствие CHECK было бы упущенной
-- возможностью, а не нейтральным переносом.
--
-- Boolean-подобные колонки (restaurants.is_open/is_new, menu_items.is_popular/
-- is_available) сознательно ОСТАВЛЕНЫ как INTEGER 0/1, а не переведены на
-- нативный BOOLEAN — задача прямо запрещает менять бизнес-логику и
-- orderService.js, а этот код читает и пишет их как числа 0/1. Переход на
-- BOOLEAN — отдельный, явно помеченный "можно сделать позже" шаг (см. PDF).
--
-- restaurants.cities оставлено TEXT (JSON-массив строкой) по той же причине:
-- ни один SQL-запрос в коде не читает его через JSON-операторы, вся работа с
-- ним — на стороне JS (JSON.parse/JSON.stringify). Переход на JSONB — тоже
-- "можно сделать позже", не блокирует функциональный паритет.
--
-- Этот файл не создаёт расширений, не подключается ни к какой БД и не
-- исполнялся ни разу против реального PostgreSQL на момент коммита. Синтаксис
-- проверен через `psql --single-transaction -f schema.sql` на временной базе
-- (см. YAAM-postgresql-ddl-implementation.pdf, раздел "Проверка").

BEGIN;

-- =========================================================================
-- restaurants
-- =========================================================================
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  cuisine TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  cities TEXT NOT NULL DEFAULT '[]',        -- JSON-массив строк, напр. ["Грозный","Аргун"]; чистый JS-side JSON, без JSONB
  address TEXT NOT NULL DEFAULT '',         -- точка самовывоза, показывается клиенту при выборе "Самовывоз"
  hours TEXT NOT NULL DEFAULT '',           -- "10:00–23:00"
  delivery_price INTEGER NOT NULL DEFAULT 0,
  min_order INTEGER NOT NULL DEFAULT 0,
  is_open INTEGER NOT NULL DEFAULT 1,       -- 0/1, как в SQLite-версии — ручной тумблер "Перерыв"
  paused_until TIMESTAMPTZ,                 -- если задано — перерыв снимается сам по истечении (см. orderService.sweepPauseExpiry)
  is_new INTEGER NOT NULL DEFAULT 1,        -- 0/1
  rating REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  phone TEXT NOT NULL DEFAULT '',           -- показывается клиенту только на экране статуса ПОСЛЕ оформления заказа
  default_cook_minutes INTEGER NOT NULL DEFAULT 40, -- своё для каждого ресторана; от него бот предлагает 3 варианта на шаге "Готовится"
  telegram_chat_id TEXT,                    -- заполняется, когда ресторан подключил бота по коду
  connect_code TEXT UNIQUE,                 -- одноразовый код для привязки бота
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- YAAM HQ Stage 4 — аддитивные колонки для рабочего раздела «Рестораны»
-- (server/routes/hq/restaurants.js). ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS — тот же приём, что уже применялся для payment_presentations.
-- expires_at (Stage 11A): безопасен и на свежей базе (CREATE TABLE выше уже
-- их не содержит только в самой первой миграции, здесь применяется сразу),
-- и на уже существующей staging-БД без потери данных/истории.
--
-- description — краткое описание карточки ресторана, обоснованно добавлено
-- (задание Stage 4, раздел 4: "если поле уже есть или обоснованно
-- добавляется"). Пустая строка по умолчанию — не NULL, тот же стиль, что и
-- у cuisine/address/hours выше.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

-- archived_at — единственный механизм архивирования (задание, раздел 11):
-- NULL = активен, не-NULL = архивирован (когда именно). Сознательно НЕ
-- отдельная колонка status с перечислением состояний — nullable timestamp
-- одновременно даёт и boolean-флаг ("архивирован ли"), и "когда" бесплатно,
-- без второй колонки. Архивирование ВСЕГДА переводит is_open=0 (см.
-- restaurantAdminService.archiveRestaurant) — публичная формула "активные
-- рестораны" (server/services/hq/dashboardMetrics.js, Stage 2, is_open=1)
-- поэтому автоматически исключает архивированные без единой правки той
-- формулы. DELETE ресторана по-прежнему запрещён (задание, раздел 11) — эта
-- колонка существует именно чтобы не понадобился DELETE.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Партиальный индекс — только по архивированным (их всегда меньшинство),
-- ускоряет фильтр "Архивированные" в HQ, не раздувается на общий случай.
CREATE INDEX IF NOT EXISTS ix_restaurants_archived_at ON restaurants (archived_at) WHERE archived_at IS NOT NULL;

-- YAAM HQ Stage 4.1 — публикация как понятие, ОТДЕЛЬНОЕ от is_open
-- (задание, раздел 0): is_open отвечает только на вопрос "принимает ли
-- ресторан заказы ПРЯМО СЕЙЧАС", published_at — виден ли он вообще клиентам.
-- NULL = черновик (виден только в HQ), не-NULL = опубликован (когда).
--
-- Backfill — намеренно НЕ отдельный `UPDATE ... WHERE published_at IS NULL`
-- (это было бы НЕидемпотентно в опасную сторону: schema.sql применяется
-- псql'ом на каждом деплое поверх уже существующей БД — см.
-- server/docs/postgresql-deployment-runbook.md, `--file=db/postgresql/
-- schema.sql` — безусловный UPDATE тихо "публиковал" бы КАЖДЫЙ новый
-- черновик, созданный между деплоями). Вместо этого — ADD COLUMN ... DEFAULT
-- NOW(), затем немедленный DROP DEFAULT: `ADD COLUMN IF NOT EXISTS`
-- выполняется РОВНО ОДИН РАЗ за всю историю базы (на всех последующих
-- прогонах schema.sql колонка уже существует, и вся конструкция — no-op,
-- включая DROP DEFAULT на колонке без default — это тоже безопасный no-op в
-- PostgreSQL). В тот единственный момент, когда колонка реально создаётся,
-- DEFAULT NOW() заполняет published_at ВСЕМ уже существующим на тот момент
-- строкам (включая уже архивированные — их видимость и так независимо
-- закрыта archived_at, отдельно очищать им published_at смысла не имеет, см.
-- раздел 10 отчёта). Любой ресторан, созданный ПОСЛЕ этого момента, получает
-- published_at исключительно через явный INSERT/UPDATE прикладного кода
-- (services/hq/restaurantAdminService.js: createRestaurant — не указывает
-- эту колонку вовсе, значит NULL, то есть черновик), а не через отвалившийся
-- default. На свежей базе (тесты) таблица в момент ADD COLUMN всегда пуста —
-- backfill затрагивает 0 строк, поведение то же самое.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE restaurants ALTER COLUMN published_at DROP DEFAULT;

-- Защитная нормализация ПЕРЕД добавлением CHECK ниже — на случай, если на
-- какой-то БД архивирование когда-либо было выполнено в обход
-- archiveRestaurant() (сама функция всегда пишет is_open=0/paused_until=NULL
-- атомарно с archived_at, так что в норме это no-op). Идемпотентна за счёт
-- WHERE.
UPDATE restaurants SET is_open = 0, paused_until = NULL
  WHERE archived_at IS NOT NULL AND (is_open = 1 OR paused_until IS NOT NULL);

-- Только ДВА CHECK'а — "архивирован -> закрыт" и "архивирован -> не на
-- паузе". Симметричные "черновик -> закрыт"/"черновик -> не на паузе" НЕ
-- добавлены как DB CHECK: is_open по умолчанию = 1 (см. CREATE TABLE выше),
-- и порядка 20 существующих тестов/бот/seed.js вставляют строки в
-- restaurants напрямую через SQL для сценариев, вообще не связанных с
-- публикацией (заказы, платежи, concurrency) — они не заполняют published_at
-- и НЕ ДОЛЖНЫ ломаться из-за понятия, которое для них не существует. Правило
-- "черновик всегда закрыт" вместо этого закреплено сервисным слоем
-- (services/hq/restaurantLifecycle.js: assertCanOpen/assertCanPause,
-- createRestaurant всегда пишет is_open=0) и тестами — задание (раздел 4)
-- прямо разрешает это: "DB CHECK допустим только если не ломает upgrade
-- существующих данных". archived_at, наоборot, — понятие, введённое ЦЕЛИКОМ
-- в Stage 4 и нигде, кроме archiveRestaurant()/тестов этого раздела, не
-- используемое напрямую — для него DB CHECK безопасен и добавлен как
-- дополнительный барьер (defense-in-depth), не только сервисная проверка.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_archived_closed') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_archived_closed
      CHECK (archived_at IS NULL OR is_open = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurants_archived_not_paused') THEN
    ALTER TABLE restaurants ADD CONSTRAINT chk_restaurants_archived_not_paused
      CHECK (archived_at IS NULL OR paused_until IS NULL);
  END IF;
END $$;

-- =========================================================================
-- categories
-- =========================================================================
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- YAAM HQ Stage 5A — архивирование категории (задание, раздел 9/5): NULL =
-- активна, не-NULL = архивирована. Тот же приём, что и restaurants.
-- archived_at (Stage 4) — тем же resolveLifecycleStatus-стилем.
-- category_id REFERENCES ... ON DELETE CASCADE у menu_items (см. ниже)
-- физически не даёт архивировать категорию удалением — только этим полем.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_categories_archived_at ON categories (archived_at) WHERE archived_at IS NOT NULL;

-- =========================================================================
-- menu_items
-- =========================================================================
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  photo_url TEXT NOT NULL DEFAULT '',
  weight_g INTEGER,
  kcal INTEGER,
  protein_g INTEGER,
  fat_g INTEGER,
  carbs_g INTEGER,
  composition TEXT NOT NULL DEFAULT '',
  is_popular INTEGER NOT NULL DEFAULT 0,    -- 0/1
  is_available INTEGER NOT NULL DEFAULT 1,  -- 0/1, стоп-лист переключает это
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- YAAM HQ Stage 5A — архивирование блюда (задание, раздел 9): NULL =
-- активно, не-NULL = архивировано. `order_items.menu_item_id` ссылается на
-- эту таблицу БЕЗ ON DELETE (см. ниже) — архивирование, а не DELETE, именно
-- поэтому и обязательно: физический DELETE строки с существующими
-- order_items либо упал бы на FK, либо (для блюда без единого заказа) тихо
-- уничтожил бы саму возможность увидеть его в истории HQ.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_menu_items_archived_at ON menu_items (archived_at) WHERE archived_at IS NOT NULL;

-- =========================================================================
-- restaurant_photos / menu_item_photos
-- =========================================================================
-- YAAM HQ Stage 5B — производственная медиа-система (задание, разделы 3-4).
-- Бинарные данные никогда не попадают в PostgreSQL: здесь хранятся только
-- метаданные, storage_key — единственный указатель на реальный объект во
-- внешнем S3-совместимом хранилище (или во временном каталоге
-- LocalMediaProvider в тестах). Публичный URL никогда не хранится колонкой —
-- он всегда выводится на чтении из storage_key через активный провайдер
-- (getPublicUrl), чтобы смена домена/провайдера в будущем не требовала
-- миграции данных. storage_key — базовый ключ одной загруженной фотографии;
-- четыре обработанных варианта (thumb/card/full/master) адресуются
-- детерминированными суффиксами поверх этого же базового ключа
-- (imagePipeline.js), поэтому отдельная колонка/JSON под варианты не нужна.
--
-- Stage 5B.1 — фотографиям не нужен lifecycle ресторана/блюда: раздел
-- «Фотографии» упрощён до upload/primary/alt/delete, поэтому здесь,
-- в отличие от restaurants.archived_at/menu_items.archived_at, УДАЛЕНИЕ
-- СТРОКИ РЕАЛЬНОЕ (services/hq/media/photoService.js: deletePhoto) — нет
-- ни order_items, ни какой-либо другой истории, которая ссылалась бы на
-- фотографию и требовала бы её сохранения после удаления. archived_at
-- Stage 5B здесь сознательно НЕ используется (см. ниже DROP COLUMN).
--
-- is_primary — не BOOLEAN, а тот же INTEGER 0/1 в стиле остальных булевых
-- колонок этой схемы (is_popular, is_available и т.д.). Ровно одна
-- primary-фотография на владельца обеспечивается partial unique индексом
-- ниже на уровне БД, а не только проверкой в JavaScript.
--
-- updated_at: как и в payments/refunds выше, в этой схеме нет триггера
-- автообновления — колонка выставляется вручную в UPDATE-запросах
-- сервисного слоя (photoService.js), тот же установившийся паттерн.
CREATE TABLE IF NOT EXISTS restaurant_photos (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,    -- 0/1
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurant_photos_one_primary
  ON restaurant_photos (restaurant_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS ix_restaurant_photos_owner
  ON restaurant_photos (restaurant_id, sort_order);

CREATE TABLE IF NOT EXISTS menu_item_photos (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,    -- 0/1
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_item_photos_one_primary
  ON menu_item_photos (menu_item_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS ix_menu_item_photos_owner
  ON menu_item_photos (menu_item_id, sort_order);

-- Stage 5B.1 — идемпотентный upgrade для любой локальной БД, где уже
-- применялся исходный Stage 5B schema.sql (archived_at существовал,
-- partial-индексы фильтровали по нему). На свежей базе всё это — no-op:
-- колонки уже нет (CREATE TABLE выше её не создаёт), а DROP INDEX + CREATE
-- пересоздают идентичные индексы под тем же именем.
ALTER TABLE restaurant_photos DROP COLUMN IF EXISTS archived_at;
ALTER TABLE menu_item_photos DROP COLUMN IF EXISTS archived_at;
DROP INDEX IF EXISTS ux_restaurant_photos_one_primary;
CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurant_photos_one_primary
  ON restaurant_photos (restaurant_id) WHERE is_primary = 1;
DROP INDEX IF EXISTS ux_menu_item_photos_one_primary;
CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_item_photos_one_primary
  ON menu_item_photos (menu_item_id) WHERE is_primary = 1;
DROP INDEX IF EXISTS ix_restaurant_photos_active;
DROP INDEX IF EXISTS ix_menu_item_photos_active;

-- =========================================================================
-- restaurant_legal_details / restaurant_bank_details / restaurant_contracts
-- =========================================================================
-- YAAM HQ Stage 6 — юридические данные, банковские реквизиты и договор
-- ресторана с YAAM (задание, разделы 3-6). Это закрытые операционные
-- данные, доступные только владельцу YAAM через HQ — рестораны не имеют
-- сюда доступа вовсе (задание, раздел 0).
--
-- restaurant_id — сам PRIMARY KEY, НЕ отдельная IDENTITY-колонка id (как у
-- restaurant_photos/menu_item_photos выше): там у одного владельца МНОГО
-- фотографий (1:N), здесь у одного ресторана РОВНО ОДНА актуальная запись
-- каждого типа (1:1, задание, раздел 6: "одна актуальная запись каждого
-- типа на один ресторан") — restaurant_id-как-PK одновременно и проще, и
-- строже гарантирует это, чем IDENTITY id + отдельный UNIQUE(restaurant_id).
-- История версий договора сознательно НЕ строится отдельной таблицей
-- (задание, раздел 6) — историю изменений хранит hq_audit_log, как и для
-- остальных разделов HQ.
--
-- Отдельные таблицы, не колонки restaurants — по трём причинам: (1) это
-- принципиально другой класс данных (закрытые финансовые/юридические, не
-- публичная карточка ресторана); (2) публичный API/routes/postgresql/api.js
-- строит DTO через явный allowlist полей (PUBLIC_RESTAURANT_FIELDS) — как
-- отдельные таблицы, эти колонки физически не могут утечь туда даже по
-- ошибке будущего кода, который сделает `SELECT *` по restaurants; (3) как
-- юридическое лицо получателя выплаты (см. restaurant_legal_details), так и
-- публичное имя ресторана (restaurants.name) — разные сущности (задание,
-- раздел 3: "Башня" публично, "ИП Иванов Иван Иванович" юридически) —
-- смешивание их в одной таблице стирало бы эту границу на уровне схемы.
--
-- restaurant_id БЕЗ ON DELETE — тот же принцип, что и везде в этой схеме:
-- DELETE ресторана запрещён продуктовым правилом (archived_at — единственный
-- механизм "убрать"), поэтому реального ON DELETE CASCADE здесь никогда не
-- потребуется.
CREATE TABLE IF NOT EXISTS restaurant_legal_details (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id),
  legal_form TEXT NOT NULL CHECK (legal_form IN ('ip', 'ooo')),
  legal_name TEXT NOT NULL,
  short_legal_name TEXT NOT NULL DEFAULT '',
  inn TEXT NOT NULL,
  ogrn TEXT NOT NULL,
  kpp TEXT NOT NULL DEFAULT '',              -- только для ООО (задание, раздел 3), у ИП всегда ''
  legal_address TEXT NOT NULL,
  actual_address TEXT NOT NULL DEFAULT '',
  director_name TEXT NOT NULL,
  authority_basis TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL,
  contact_email TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Банковские реквизиты для будущих выплат (задание, раздел 4). Полные
-- значения account_number/correspondent_account НИКОГДА не покидают HQ:
-- read-only обзор маскирует их (services/hq/restaurantBankDetailsService.js),
-- audit log хранит максимум последние 4 цифры (services/hq/auditLog.js).
CREATE TABLE IF NOT EXISTS restaurant_bank_details (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id),
  recipient_name TEXT NOT NULL,
  recipient_inn TEXT NOT NULL,
  recipient_kpp TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL,              -- 20 цифр, проверено относительно bik
  bik TEXT NOT NULL,                         -- 9 цифр
  bank_name TEXT NOT NULL,
  correspondent_account TEXT NOT NULL,       -- 20 цифр, проверено относительно bik
  default_payment_purpose TEXT NOT NULL DEFAULT '',
  internal_note TEXT NOT NULL DEFAULT '',    -- только для владельца YAAM, никогда не покидает HQ
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Договор ресторана с YAAM (задание, раздел 5). commission_bps — basis
-- points (700 = 7%, текущая базовая модель YAAM), НЕ float — то же
-- целочисленное представление денег/долей, что уже используется во всей
-- остальной схеме (items_total/commission_amount на orders — целые рубли,
-- не float). Это ДОГОВОРНОЕ значение для БУДУЩЕГО финансового модуля — оно
-- НЕ подключено к фактическому расчёту комиссии заказа (тот остаётся
-- 0.07-константой в services/postgresql/orderService.js, задание, раздел 5:
-- "не ломать расчёты", "не делать скрытое изменение расчёта уже
-- существующих заказов").
CREATE TABLE IF NOT EXISTS restaurant_contracts (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id),
  contract_number TEXT NOT NULL DEFAULT '',
  signed_at DATE,
  starts_at DATE,
  ends_at DATE,
  status TEXT NOT NULL DEFAULT 'not_signed'
    CHECK (status IN ('not_signed', 'prepared', 'signed', 'suspended', 'terminated')),
  commission_bps INTEGER NOT NULL DEFAULT 700 CHECK (commission_bps >= 0 AND commission_bps <= 10000),
  internal_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- orders
-- =========================================================================
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,          -- "YAAM-00001" (id с отступом минимум до 5 цифр), отдаём клиенту
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id), -- намеренно без ON DELETE, как в исходной схеме
  city TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address TEXT NOT NULL,
  fulfillment_type TEXT NOT NULL DEFAULT 'delivery', -- 'delivery' | 'pickup' — выбор клиента при оформлении
  comment TEXT NOT NULL DEFAULT '',
  items_total INTEGER NOT NULL,              -- сумма блюд, руб. Комиссия YAAM считается от неё.
  commission_amount INTEGER NOT NULL,        -- 7% на момент создания заказа (фиксируем, а не пересчитываем задним числом)
  -- Ровно 10 допустимых значений — идентично CHECK в SQLite-версии.
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN (
      'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier',
      'delivered', 'payment_failed', 'declined', 'timed_out', 'cancelled'
    )),
  -- статусы: awaiting_payment -> paid(=awaiting_restaurant) -> accepted -> preparing
  --          -> courier -> delivered
  --          | payment_failed | declined | timed_out | cancelled
  status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rating INTEGER,                             -- 1..5, ставится один раз после delivered
  estimated_ready_minutes INTEGER             -- ресторан выбирает в боте на шаге "Готовится" (см. bot/index.js)
);

-- =========================================================================
-- order_access_credentials
-- =========================================================================
-- Секрет доступа к заказу хранится отдельно от отображаемого public_code.
-- Клиент генерирует 256-битный bearer-токен и отдельный ключ идемпотентности;
-- в БД попадают только SHA-256 digest (32 байта), исходные секреты сервер не
-- сохраняет и не может повторно раскрыть. request_hash связывает ключ с точным
-- нормализованным содержимым заказа: изменённый replay не получит старый заказ.
CREATE TABLE IF NOT EXISTS order_access_credentials (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  create_key_hash BYTEA NOT NULL UNIQUE CHECK (length(create_key_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (length(request_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- order_items
-- =========================================================================
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id), -- nullable, намеренно без ON DELETE, как в исходной схеме
  name TEXT NOT NULL,    -- снимок названия на момент заказа (меню может измениться позже)
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

-- =========================================================================
-- payments
-- =========================================================================
-- Отдельная таблица платежей, а не поле в orders: у заказа может быть больше
-- одной попытки оплаты (повторная попытка после payment_failed).
--
-- Отличие от SQLite-версии: добавлен CHECK на status. В исходной схеме его не
-- было (единственная статусная колонка без CHECK во всей БД, уже отмечено как
-- находка в предыдущих аудитах) — раз таблица переписывается заново под
-- PostgreSQL, это попутное улучшение, а не изменение бизнес-логики.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',      -- 'mock' | 'yookassa' (позже)
  provider_payment_id TEXT,                   -- id платежа во внешней системе
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('creating', 'pending', 'succeeded', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- payment_retry_attempts
-- =========================================================================
-- Последовательность повторной оплаты: сначала резервируем одну попытку в БД,
-- затем вызываем провайдера и финализируем именно эту строку. Исходный
-- клиентский ключ не сохраняется — только SHA-256. Устойчивый
-- provider_idempotency_key позволяет после сетевого сбоя/рестарта безопасно
-- повторить внешний запрос, не создавая второй платёж у провайдера.
CREATE TABLE IF NOT EXISTS payment_retry_attempts (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- payment_retry_keys
-- =========================================================================
-- Несколько вкладок могут почти одновременно создать разные client keys.
-- Каждый принятый ключ навсегда привязывается к выбранной попытке, поэтому его
-- replay и после завершения платежа не сможет неожиданно создать другую.
CREATE TABLE IF NOT EXISTS payment_retry_keys (
  client_key_hash BYTEA PRIMARY KEY CHECK (length(client_key_hash) = 32),
  payment_id INTEGER NOT NULL REFERENCES payment_retry_attempts(payment_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Финансовые инварианты защищены самой БД, а не только JavaScript-проверкой:
-- у заказа не может быть двух одновременно создаваемых/ожидающих платежей,
-- а один внешний payment id нельзя прикрепить к двум нашим попыткам.
-- Partial unique index — нативно поддерживается PostgreSQL, без изменений.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_active_per_order
  ON payments (order_id) WHERE status IN ('creating', 'pending');
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_reference
  ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payment_retry_keys_payment
  ON payment_retry_keys (payment_id);

-- =========================================================================
-- payment_presentations
-- =========================================================================
-- Безопасные данные, необходимые клиенту для продолжения уже созданной
-- платёжной попытки после потерянного HTTP-ответа. Внутренний id провайдера
-- остаётся только в payments; наружу после bearer-проверки возвращаются лишь
-- payment_url/qr_payload.
CREATE TABLE IF NOT EXISTS payment_presentations (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  payment_url TEXT,
  qr_payload TEXT,
  -- Stage 11A follow-up: неизменяемый серверный срок оплаты. Ставится РОВНО
  -- один раз, в момент INSERT (anchored на payments.created_at — момент
  -- начала ИМЕННО ЭТОЙ попытки, до сетевого вызова провайдера, не момент
  -- получения ответа), и никогда не обновляется (см. ON CONFLICT в
  -- orderService.js — expires_at сознательно исключён из DO UPDATE SET).
  -- NULL — легитимное значение для строк, вставленных до этого изменения
  -- (backward-compatible; frontend откатывается на клиентский таймер).
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Идемпотентно применяется и к уже существующей (staging) БД, и к свежей —
-- на свежей это no-op (колонка уже в CREATE TABLE выше), на уже
-- задеплоенной staging-БД реально добавляет колонку. Настоящих ALTER TABLE
-- в этом проекте раньше не было (не требовались — миграции применялись до
-- существования живой БД); здесь она нужна впервые именно потому, что
-- staging уже реально развёрнут (Stage 9/10) и живёт с прежней схемой.
ALTER TABLE payment_presentations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- =========================================================================
-- payment_initial_attempts
-- =========================================================================
-- Первоначальный платёж создаётся после того, как заказ уже зафиксирован в БД.
-- Этот ledger хранит устойчивый серверный ключ внешней операции, чтобы после
-- сетевого сбоя или рестарта повторить createPayment с тем же ключом, а не
-- создать второй платёж у провайдера. Клиентский create-key остаётся только в
-- order_access_credentials и никогда не передаётся платёжному провайдеру.
CREATE TABLE IF NOT EXISTS payment_initial_attempts (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- refunds
-- =========================================================================
-- Возврат — отдельная сущность, не поле payments: у одного платежа может быть
-- больше одной попытки возврата за всю историю (сначала неудачная, потом,
-- когда-нибудь в будущем, повторная — уже не автоматически в этой версии).
-- requested/processing — durable-резервация до сетевого вызова провайдера
-- (тот же принцип, что payment_initial_attempts); succeeded/failed —
-- терминальны для КОНКРЕТНОЙ строки. failed НЕ порождает новую строку
-- автоматически — сознательное архитектурное решение этого этапа.
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'succeeded', 'failed')),
  reason TEXT NOT NULL CHECK (reason IN ('customer_cancel', 'restaurant_decline', 'timeout')),
  provider_refund_id TEXT,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN
    ('provider_failed', 'provider_unavailable', 'timeout', 'invariant_violation')),
  last_error_message_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Не более одной незавершённой попытки возврата на платёж одновременно.
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_one_active_per_payment
  ON refunds (payment_id) WHERE status IN ('requested', 'processing');
-- Платёж нельзя успешно вернуть дважды — навсегда блокирует будущие строки.
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_one_succeeded_per_payment
  ON refunds (payment_id) WHERE status = 'succeeded';
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_provider_reference
  ON refunds (provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;

-- Production Switch — Stage 8: поддерживает bounded-batch запрос
-- sweepStuckRefunds() (services/postgresql/orderService.js) — "найти
-- requested/processing строки с истёкшим/отсутствующим next_attempt_at" без
-- полного скана таблицы. Партиальный (только незавершённые статусы) —
-- индекс не растёт с накоплением succeeded/failed строк. Чисто аддитивная,
-- идемпотентная правка (CREATE INDEX IF NOT EXISTS) — безопасна и на свежей,
-- и на уже существующей Stage 7 базе (реальной production PostgreSQL БД
-- ещё не существует, отдельная система миграций не требуется).
CREATE INDEX IF NOT EXISTS ix_refunds_pending_sweep
  ON refunds (next_attempt_at) WHERE status IN ('requested', 'processing');

-- =========================================================================
-- refunds — финансовые триггеры (PL/pgSQL)
-- =========================================================================
-- PostgreSQL требует отдельную функцию на каждый триггер (в отличие от
-- инлайн-синтаксиса SQLite) — см. YAAM-postgresql-migration-analysis.pdf,
-- раздел 5. Логика каждого триггера сохранена дословно, включая точный текст
-- сообщений об ошибке.

-- Партиальные возвраты запрещены для MVP: amount строго равен сумме платежа.
CREATE OR REPLACE FUNCTION fn_refunds_amount_matches_payment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount <> (SELECT amount FROM payments WHERE id = NEW.payment_id) THEN
    RAISE EXCEPTION 'refund amount must equal payment amount (full-refund-only for MVP)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refunds_amount_matches_payment ON refunds;
CREATE TRIGGER trg_refunds_amount_matches_payment
BEFORE INSERT ON refunds
FOR EACH ROW
EXECUTE FUNCTION fn_refunds_amount_matches_payment();

-- DB-backstop поверх reserveRefundRow(): partial-индекс сам по себе не мешает
-- вставить НОВУЮ requested-строку, если уже есть succeeded (индекс применяется
-- только к строкам со status='succeeded', не к вставляемой requested-строке).
CREATE OR REPLACE FUNCTION fn_refunds_block_after_succeeded()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM refunds WHERE payment_id = NEW.payment_id AND status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'refunds: payment already successfully refunded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refunds_block_after_succeeded ON refunds;
CREATE TRIGGER trg_refunds_block_after_succeeded
BEFORE INSERT ON refunds
FOR EACH ROW
EXECUTE FUNCTION fn_refunds_block_after_succeeded();

-- payment_id/amount/provider/reason/provider_idempotency_key фиксируются один
-- раз при создании строки и не должны меняться никаким UPDATE — это финансовые
-- факты конкретной попытки, а не изменяемое состояние.
CREATE OR REPLACE FUNCTION fn_refunds_immutable_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payment_id <> OLD.payment_id
     OR NEW.amount <> OLD.amount
     OR NEW.provider <> OLD.provider
     OR NEW.reason <> OLD.reason
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key
  THEN
    RAISE EXCEPTION 'refunds: payment_id/amount/provider/reason/provider_idempotency_key are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refunds_immutable_fields ON refunds;
CREATE TRIGGER trg_refunds_immutable_fields
BEFORE UPDATE ON refunds
FOR EACH ROW
EXECUTE FUNCTION fn_refunds_immutable_fields();

-- =========================================================================
-- hq_owner
-- =========================================================================
-- YAAM HQ Stage 3: единственный владелец закрытой панели HQ, хранится в
-- PostgreSQL вместо .env. `id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1)` —
-- тот же db-backstop принцип, что и триггеры refunds выше (см. заголовок
-- файла): единственная строка гарантирована самой БД (PRIMARY KEY не даст
-- вставить вторую строку с id=1; CHECK не даст обойти это, вставив строку с
-- ЛЮБЫМ другим id) — не только "приложение не создаёт второго владельца",
-- а невозможность этого на уровне схемы. Никаких email/role/recovery-полей —
-- HQ намеренно остаётся панелью ровно одного владельца без ролей и
-- восстановления по почте (задание, раздел "Запретить").
--
-- Если строка отсутствует — HQ работает fail-closed: логин отвечает
-- "неверный логин или пароль" для любых введённых данных (некого сравнивать),
-- а не тихо разрешает вход/не откатывается на .env. Заполняется один раз, при
-- первом старте, из HQ_ADMIN_USER/HQ_ADMIN_PASSWORD_HASH (см.
-- server/services/hq/ownerService.js bootstrapOwnerFromEnv — INSERT ... ON
-- CONFLICT (id) DO NOTHING, идемпотентно: повторный bootstrap на уже
-- заполненную таблицу — гарантированный no-op, не перезаписывает и не
-- сбрасывает существующего владельца).
--
-- credentials_version — единственный механизм "разлогинить все сессии" в
-- этой архитектуре (сессии хранятся в process-memory MemoryStore, см.
-- server/services/hq/session.js — ни отдельного стора, ни возможности
-- перечислить/удалить чужие сессии по ID нет и не требуется): при логине
-- текущее значение записывается в саму сессию, а на каждый защищённый запрос
-- requireHqAuth сверяет его с актуальным значением из этой таблицы — смена
-- логина/пароля увеличивает счётчик, и ЛЮБАЯ сессия с более старым
-- credentials_version (включая ту, из которой сделана сама смена) на
-- следующий же запрос считается недействительной и принудительно
-- разлогинивается — без необходимости знать, сколько было открыто сессий
-- и где именно они хранятся.
CREATE TABLE IF NOT EXISTS hq_owner (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  login TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  credentials_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- hq_security_log
-- =========================================================================
-- Журнал событий безопасности HQ (задание, раздел 6). Намеренно НЕ хранит
-- пароли/хеши/токены/содержимое сессии — только тип события, время, IP.
-- event_type — закрытый список (CHECK), не свободный текст: тот же принцип,
-- что и у orders.status/payments.status выше — набор реально
-- различаемых кодом событий, а не произвольная строка из вызывающего места.
CREATE TABLE IF NOT EXISTS hq_security_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'login_success', 'login_failed', 'login_rate_limited',
    'login_change', 'password_change', 'emergency_reset', 'logout'
  )),
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_hq_security_log_created_at ON hq_security_log (created_at);

-- =========================================================================
-- hq_audit_log
-- =========================================================================
-- YAAM HQ Stage 4 — журнал административных изменений (задание, раздел 10),
-- отдельный от hq_security_log (Stage 3, раздел 6 того задания): тот
-- посвящён исключительно событиям аутентификации/сессии (вход/выход/смена
-- логина или пароля) с закрытым узким enum'ом ровно под них.
-- Административные изменения бизнес-данных (создание/правка/пауза/
-- архивирование ресторана) — другой по природе класс событий: у них есть
-- предметная ссылка (restaurant_id) и осмысленно короткое текстовое
-- описание ИЗМЕНЕНИЯ, а не просто факта входа. Смешивать оба класса в одном
-- узком CHECK-enum'е означало бы либо раздувать его совсем разнородными
-- значениями, либо терять structure (restaurant_id) — отдельная таблица тем
-- же db-backstop принципом (закрытый список action) яснее и безопаснее.
--
-- restaurant_id БЕЗ ON DELETE (как и orders.restaurant_id выше) — то же
-- самое намерение, усиленное фактом, что DELETE ресторана вообще запрещён
-- продуктовым правилом этого этапа (см. restaurants.archived_at выше):
-- FOREIGN KEY здесь дополнительно физически не даёт снести ресторан, пока
-- на него ссылается хотя бя одна запись аудита, то есть всегда.
--
-- details — короткий человекочитаемый summary ТОЛЬКО из allowlist безопасных
-- полей (см. services/hq/auditLog.js SAFE_DIFF_FIELDS) — никогда не
-- connect_code/telegram_chat_id/пароль/токен. Nullable — не для всех
-- событий (пауза/пуск/архивирование) есть что добавить сверх самого факта.
CREATE TABLE IF NOT EXISTS hq_audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN (
    'restaurant_created', 'restaurant_updated', 'restaurant_paused',
    'restaurant_resumed', 'restaurant_archived', 'restaurant_restored',
    'restaurant_published', 'restaurant_unpublished',
    'category_created', 'category_updated', 'category_archived',
    'category_restored', 'category_moved',
    'menu_item_created', 'menu_item_updated', 'menu_item_available',
    'menu_item_unavailable', 'menu_item_archived', 'menu_item_restored',
    'menu_item_moved',
    -- Stage 5B.1 — медиа-система, упрощённый набор (6 событий): у фотографий
    -- нет reorder/archive/restore, только upload/primary/delete (задание
    -- Stage 5B.1, раздел 0). Исходные Stage 5B moved/archived/restored
    -- значения намеренно убраны из allowlist — эта функциональность
    -- перестала существовать в коде, а не просто скрыта в UI.
    'restaurant_photo_uploaded', 'restaurant_photo_primary_changed', 'restaurant_photo_deleted',
    'menu_item_photo_uploaded', 'menu_item_photo_primary_changed', 'menu_item_photo_deleted',
    -- Stage 6 — юридические данные/банковские реквизиты/договор (задание,
    -- раздел 10). Ровно 7 событий, как и требует задание.
    'restaurant_legal_details_created', 'restaurant_legal_details_updated',
    'restaurant_bank_details_created', 'restaurant_bank_details_updated',
    'restaurant_contract_created', 'restaurant_contract_updated', 'restaurant_contract_status_changed'
  )),
  restaurant_id INTEGER REFERENCES restaurants(id),
  details TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_hq_audit_log_restaurant_id ON hq_audit_log (restaurant_id);
CREATE INDEX IF NOT EXISTS ix_hq_audit_log_created_at ON hq_audit_log (created_at);

-- YAAM HQ Stage 4.1/5A/5B/5B.1 — расширения allowlist выше
-- ('restaurant_published'/'restaurant_unpublished', затем 12 событий раздела
-- «Меню», затем упрощённый набор из 6 событий медиа-системы, Stage 5B.1).
-- Таблица уже существует на любой БД, где применялся
-- Stage 4 (`CREATE TABLE IF NOT EXISTS` тогда — no-op), поэтому CHECK нужно
-- расширить отдельно, идемпотентно: DROP старого constraint'а (стандартное
-- имя Postgres для inline column CHECK — "<таблица>_<колонка>_check") и ADD
-- нового с уже расширенным списком. DROP CONSTRAINT IF EXISTS безопасен и на
-- СВЕЖЕЙ базе, где CREATE TABLE выше уже создал constraint сразу с полным
-- списком под тем же именем — в этом случае DROP+ADD просто пересоздают
-- идентичный constraint, без потери данных (это DDL, не удаляет строки).
ALTER TABLE hq_audit_log DROP CONSTRAINT IF EXISTS hq_audit_log_action_check;
ALTER TABLE hq_audit_log ADD CONSTRAINT hq_audit_log_action_check CHECK (action IN (
  'restaurant_created', 'restaurant_updated', 'restaurant_paused',
  'restaurant_resumed', 'restaurant_archived', 'restaurant_restored',
  'restaurant_published', 'restaurant_unpublished',
  'category_created', 'category_updated', 'category_archived',
  'category_restored', 'category_moved',
  'menu_item_created', 'menu_item_updated', 'menu_item_available',
  'menu_item_unavailable', 'menu_item_archived', 'menu_item_restored',
  'menu_item_moved',
  'restaurant_photo_uploaded', 'restaurant_photo_primary_changed', 'restaurant_photo_deleted',
  'menu_item_photo_uploaded', 'menu_item_photo_primary_changed', 'menu_item_photo_deleted',
  'restaurant_legal_details_created', 'restaurant_legal_details_updated',
  'restaurant_bank_details_created', 'restaurant_bank_details_updated',
  'restaurant_contract_created', 'restaurant_contract_updated', 'restaurant_contract_status_changed'
));

-- =========================================================================
-- YAAM HQ Stage 8 — settlement_periods / settlement_restaurant_lines /
-- settlement_order_lines / settlement_refunds
-- =========================================================================
--
-- Аудит перед разработкой (см. итоговый отчёт Stage 8, раздел 2): Stage 7/7.1
-- (services/hq/restaurantFinanceService.js) остаётся ЕДИНСТВЕННЫМ источником
-- LIVE-финансовой позиции — ничего здесь его не переопределяет и не дублирует
-- его формулы. Эти четыре таблицы хранят ВТОРОЙ, принципиально другой по
-- природе класс данных — CLOSED SETTLEMENT SNAPSHOT: то, что было официально
-- зафиксировано волевым действием владельца YAAM ("закрыть период"), и после
-- этого момента НИКОГДА не пересчитывается заново, даже если позже изменится
-- меню, договор, комиссия или найдётся более новый заказ. Разделение "live
-- position" (Stage 7, читает orders/payments/refunds заново при каждом
-- запросе) vs "closed snapshot" (Stage 8, читает только то, что здесь
-- сохранено, никогда не смотрит в orders/payments/refunds заново) — это и
-- есть архитектурное решение этого этапа (задание, раздел 2).
--
-- settlement_order_lines.order_id и settlement_refunds.refund_id — оба с
-- голым UNIQUE (не составным) — это ЕДИНСТВЕННЫЙ и решающий механизм защиты
-- от двойного учёта (задание, раздел 7: "это критично"): один и тот же заказ
-- или один и тот же возврат физически не может быть вставлен в ДВА разных
-- settlement_period_id, потому что тогда потребовались бы ДВЕ строки с
-- одинаковым order_id/refund_id, а UNIQUE это запрещает на уровне PostgreSQL,
-- а не только проверкой в JS. При этом (см. итоговый отчёт, раздел 8) при
-- корректно работающей системе непересекающихся периодов
-- (EXCLUDE-constraint ниже) один и тот же заказ структурно не может попасть
-- в диапазон дат ДВУХ разных периодов — то есть это ограничение, как и
-- EARNED_ORDER_FILTER_SQL "delivered И succeeded refund" в Stage 7, защищает
-- от состояния, которое НЕ должно быть достижимо при исправно работающем
-- коде, но проверяется на уровне данных, а не только предполагается.

CREATE TABLE IF NOT EXISTS settlement_periods (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'closed')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  CHECK (period_to >= period_from),
  -- closed_at заполнен ТОГДА И ТОЛЬКО ТОГДА, когда status='closed' (задание,
  -- раздел 14: "closed period без closed_at" / "draft period с closed_at" —
  -- оба симметричных нарушения инварианта запрещены здесь на уровне схемы,
  -- не только проверяются health-функцией ниже).
  CHECK ((status = 'closed' AND closed_at IS NOT NULL) OR (status = 'draft' AND closed_at IS NULL))
);

-- "Периоды не должны пересекаться" И "один календарный диапазон нельзя
-- создать дважды" (задание, раздел 3) — ОДНО ограничение покрывает оба
-- правила: идентичный диапазон — частный случай пересечения самого с собой.
-- daterange(..., '[]') — обе границы включительно, ровно "московский
-- календарь включительно" из задания. GiST-поддержка range-типов встроена в
-- ядро PostgreSQL — CREATE EXTENSION НЕ требуется (в отличие от смешивания
-- range с обычной scalar-колонкой в одном EXCLUDE, что потребовало бы
-- btree_gist — здесь такой колонки нет, ограничение только по диапазону дат).
-- Действует для ЛЮБЫХ двух периодов независимо от статуса (draft и closed
-- тоже не могут пересекаться друг с другом) — задание не делает исключения.
ALTER TABLE settlement_periods DROP CONSTRAINT IF EXISTS settlement_periods_no_overlap;
ALTER TABLE settlement_periods ADD CONSTRAINT settlement_periods_no_overlap
  EXCLUDE USING gist (daterange(period_from, period_to, '[]') WITH &&);

-- Закрытый период — immutable (задание, раздел 8/17: "закрытый период нельзя
-- редактировать"/"нельзя удалять"). DB-backstop поверх сервисного слоя — тот
-- же принцип, что и fn_refunds_immutable_fields выше: приложение просто не
-- должно этого делать, но если бы попыталось (баг, ручной SQL), PostgreSQL
-- сам откажет, а не молча тихо испортит зафиксированный snapshot.
CREATE OR REPLACE FUNCTION fn_settlement_period_immutable_after_close()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'settlement_periods: closed period is immutable (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_period_block_update_after_close ON settlement_periods;
CREATE TRIGGER trg_settlement_period_block_update_after_close
BEFORE UPDATE ON settlement_periods
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_period_immutable_after_close();

CREATE OR REPLACE FUNCTION fn_settlement_period_block_delete_after_close()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'settlement_periods: closed period cannot be deleted (id=%)', OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_period_block_delete_after_close ON settlement_periods;
CREATE TRIGGER trg_settlement_period_block_delete_after_close
BEFORE DELETE ON settlement_periods
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_period_block_delete_after_close();

-- Одна строка обязательства на ресторан в одном периоде (задание, раздел 4).
-- Создаётся ТОЛЬКО restaurant'ам с реальной активностью в периоде (хотя бы
-- один заработанный заказ ИЛИ хотя бы один успешный возврат) — ресторан без
-- какой-либо активности просто не упоминается в закрытом периоде, что само
-- по себе честно отражает "ноль активности", без раздувания таблицы пустыми
-- строками на каждый когда-либо созданный ресторан.
CREATE TABLE IF NOT EXISTS settlement_restaurant_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  delivered_paid_orders INTEGER NOT NULL DEFAULT 0,
  turnover INTEGER NOT NULL DEFAULT 0,
  yaam_commission INTEGER NOT NULL DEFAULT 0,
  restaurant_earnings INTEGER NOT NULL DEFAULT 0,
  successful_refunds_count INTEGER NOT NULL DEFAULT 0,
  successful_refunds_amount INTEGER NOT NULL DEFAULT 0,
  payable_amount INTEGER NOT NULL DEFAULT 0,
  payout_readiness_snapshot TEXT NOT NULL,
  contract_number_snapshot TEXT NOT NULL DEFAULT '',
  -- NULL = комиссия по заказам периода не была однородной ЛИБО не может быть
  -- достоверно восстановлена (orders.commission_amount не хранит саму bps-
  -- ставку, а restaurant_contracts не версионируется — см. итоговый отчёт,
  -- раздел "Формулы", за полным обоснованием честной, а не выдуманной модели).
  commission_bps_summary INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (settlement_period_id, restaurant_id)
);
CREATE INDEX IF NOT EXISTS ix_settlement_restaurant_lines_period ON settlement_restaurant_lines (settlement_period_id);

-- Строки этой и следующих двух таблиц НИКОГДА не обновляются и не удаляются
-- после вставки — это и есть "immutable snapshot" (задание, раздел 9).
-- Единственный код-путь, который сюда пишет — closeSettlementPeriod()
-- (services/hq/settlementService.js), один раз, внутри одной SERIALIZABLE-
-- транзакции вместе с переводом периода в 'closed'.
CREATE OR REPLACE FUNCTION fn_settlement_snapshot_row_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'settlement snapshot rows are immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_restaurant_lines_immutable ON settlement_restaurant_lines;
CREATE TRIGGER trg_settlement_restaurant_lines_immutable
BEFORE UPDATE OR DELETE ON settlement_restaurant_lines
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Snapshot-связь "какие именно заработанные заказы вошли в этот период" —
-- задание, раздел 7, вариант B ("хранить restaurant lines + список
-- включённых order/refund IDs"), выбран явно вместо варианта A
-- (только агрегаты): только вариант B реально ДОКАЗЫВАЕТ отсутствие
-- двойного учёта голым UNIQUE(order_id) ниже — агрегатов самих по себе для
-- этого недостаточно (два периода могли бы оба насчитать один и тот же
-- заказ в свои суммы, и ни один агрегат этого бы не показал).
CREATE TABLE IF NOT EXISTS settlement_order_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  items_total_snapshot INTEGER NOT NULL,
  commission_amount_snapshot INTEGER NOT NULL,
  restaurant_amount_snapshot INTEGER NOT NULL,
  delivered_at_snapshot TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_settlement_order_lines_period ON settlement_order_lines (settlement_period_id);

DROP TRIGGER IF EXISTS trg_settlement_order_lines_immutable ON settlement_order_lines;
CREATE TRIGGER trg_settlement_order_lines_immutable
BEFORE UPDATE OR DELETE ON settlement_order_lines
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Symmetric snapshot-связь для возвратов (задание, раздел 7).
CREATE TABLE IF NOT EXISTS settlement_refunds (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  refund_id INTEGER NOT NULL UNIQUE REFERENCES refunds(id),
  amount_snapshot INTEGER NOT NULL,
  completed_at_snapshot TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_settlement_refunds_period ON settlement_refunds (settlement_period_id);

DROP TRIGGER IF EXISTS trg_settlement_refunds_immutable ON settlement_refunds;
CREATE TRIGGER trg_settlement_refunds_immutable
BEFORE UPDATE OR DELETE ON settlement_refunds
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Аудит-события этого этапа (задание, раздел 13) — тот же allowlist-принцип,
-- что и остальной hq_audit_log.action. restaurant_id для settlement-событий
-- всегда NULL (событие уровня периода в целом, не привязано к одному
-- ресторану) — колонка это уже поддерживает (nullable).
ALTER TABLE hq_audit_log DROP CONSTRAINT IF EXISTS hq_audit_log_action_check;
ALTER TABLE hq_audit_log ADD CONSTRAINT hq_audit_log_action_check CHECK (action IN (
  'restaurant_created', 'restaurant_updated', 'restaurant_paused',
  'restaurant_resumed', 'restaurant_archived', 'restaurant_restored',
  'restaurant_published', 'restaurant_unpublished',
  'category_created', 'category_updated', 'category_archived',
  'category_restored', 'category_moved',
  'menu_item_created', 'menu_item_updated', 'menu_item_available',
  'menu_item_unavailable', 'menu_item_archived', 'menu_item_restored',
  'menu_item_moved',
  'restaurant_photo_uploaded', 'restaurant_photo_primary_changed', 'restaurant_photo_deleted',
  'menu_item_photo_uploaded', 'menu_item_photo_primary_changed', 'menu_item_photo_deleted',
  'restaurant_legal_details_created', 'restaurant_legal_details_updated',
  'restaurant_bank_details_created', 'restaurant_bank_details_updated',
  'restaurant_contract_created', 'restaurant_contract_updated', 'restaurant_contract_status_changed',
  'settlement_period_created', 'settlement_period_closed', 'settlement_period_draft_deleted'
));

COMMIT;
