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
-- order_share_tokens (фича «Поделиться заказом», Web Share API)
-- =========================================================================
-- Read-only capability для публичной ссылки на статус заказа — НЕ путать с
-- order_access_credentials.token_hash (полный владелец, может cancel/
-- retry-payment/rate): этот токен принимается ТОЛЬКО GET-роутом статуса
-- (см. requireOrderShareAccess в routes/postgresql/api.js), чтобы
-- пересланная в мессенджере ссылка не давала постороннему управлять чужим
-- заказом. Один активный share-токен на заказ (PK по order_id): повторная
-- генерация (POST /orders/:code/share) заменяет предыдущий — старые
-- розданные ссылки перестают работать. Это осознанный минимальный
-- компромисс: клиент сначала переиспользует уже закэшированный локально
-- токен и обращается сюда только при его отсутствии.
CREATE TABLE IF NOT EXISTS order_share_tokens (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE CHECK (length(token_hash) = 32),
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

-- =========================================================================
-- YAAM HQ Stage 9 — restaurant_payouts (Payout Entity Foundation, NO bank
-- integration)
-- =========================================================================
--
-- Аудит перед разработкой (см. итоговый отчёт Stage 9, раздел 2): эта
-- таблица — НЕ services/hq/restaurantPayoutService.js (Stage 6, "готовность
-- ресторана к выплате" — legal/bank/contract completeness, ни одного
-- денежного факта). Совпадение слова "payout" в имени намеренно НЕ
-- переиспользовано для новой сущности — см. новый, отдельный
-- services/hq/payoutService.js за полным разделением ответственности.
--
-- Главное правило задания: "Закрытый расчётный период фиксирует долг YAAM
-- перед рестораном. Выплата — это отдельная сущность." — restaurant_payouts
-- НЕ пересчитывает суммы: amount копируется РОВНО ОДИН РАЗ, в момент
-- подготовки, из settlement_restaurant_lines.payable_amount (Stage 8,
-- уже immutable snapshot) — settlement остаётся единственным источником
-- истины, эта таблица лишь ОТСЛЕЖИВАЕТ судьбу уже зафиксированной суммы.
--
-- АРХИТЕКТУРНОЕ РЕШЕНИЕ, отклоняющееся от буквальной формулировки задания
-- (задокументировано явно, не молча): задание говорит "один закрытый период
-- — максимум одна выплата". Буквально это не может быть верно — один период
-- (Stage 8) содержит СТРОКИ ОБЯЗАТЕЛЬСТВ ПО КАЖДОМУ РЕСТОРАНУ
-- (settlement_restaurant_lines: UNIQUE(settlement_period_id, restaurant_id),
-- не один агрегат на период), и каждый ресторан должен получить СВОЮ
-- собственную выплату на СВОИ банковские реквизиты. Верная интерпретация
-- инварианта — "максимум одна выплата НА ПАРУ (период, ресторан)": именно
-- она реализована ниже как UNIQUE(settlement_period_id, restaurant_id) —
-- тот же режим, что и на самой settlement_restaurant_lines. Дополнительно
-- составной FOREIGN KEY на settlement_restaurant_lines(settlement_period_id,
-- restaurant_id) физически не даёт создать выплату для пары, у которой
-- вообще нет зафиксированной строки обязательства (период не закрыт, или
-- ресторан не имел активности в этом периоде) — сильнее, чем просто
-- проверка в коде.
CREATE TABLE IF NOT EXISTS restaurant_payouts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'processing', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Каждый переход — своя собственная дата (задание, раздел "Время": "Никаких
  -- универсальных timestamp"). prepared_at заполняется атомарно с INSERT
  -- (момент создания ВСЕГДА равен моменту входа в 'prepared' — это
  -- единственный статус, доступный при создании строки).
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  external_payout_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  UNIQUE (settlement_period_id, restaurant_id),
  FOREIGN KEY (settlement_period_id, restaurant_id)
    REFERENCES settlement_restaurant_lines (settlement_period_id, restaurant_id),
  -- Консистентность timestamp'ов ПО СТАТУСУ — DB-уровневая, не только
  -- проверка в сервисном коде: succeeded СТРУКТУРНО НЕВОЗМОЖЕН без
  -- processing_at (задание: "нельзя prepared -> succeeded без processing" —
  -- это буквально СХЕМА, а не просто код). failed допускает processing_at
  -- и NULL, и NOT NULL — provider/pre-flight отказ может произойти либо ДО
  -- захода в processing (валидация реквизитов), либо ВО ВРЕМЯ него
  -- (реальный сетевой отказ провайдера) — оба случая реальны и не должны
  -- считаться нарушением.
  CHECK (
    (status = 'prepared'   AND processing_at IS NULL     AND completed_at IS NULL     AND failed_at IS NULL     AND failure_reason IS NULL) OR
    (status = 'processing' AND processing_at IS NOT NULL AND completed_at IS NULL     AND failed_at IS NULL     AND failure_reason IS NULL) OR
    (status = 'succeeded'  AND processing_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL     AND failure_reason IS NULL) OR
    (status = 'failed'     AND completed_at IS NULL      AND failed_at IS NOT NULL    AND failure_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS ix_restaurant_payouts_restaurant ON restaurant_payouts (restaurant_id);
CREATE INDEX IF NOT EXISTS ix_restaurant_payouts_status ON restaurant_payouts (status);

-- Полный граф переходов состояний (задание: "Продумай корректную state
-- machine") — DB-уровневая проверка КАЖДОГО перехода, а не только "нельзя
-- редактировать после terminal" (тот отдельный триггер ниже). Разрешено:
-- prepared->processing, prepared->failed, processing->succeeded,
-- processing->failed, и "no-op" UPDATE того же статуса (например, правка
-- notes/external_payout_id без смены статуса). ВСЁ остальное — включая
-- prepared->succeeded (задание: "нельзя prepared -> succeeded без
-- processing", дословно) и failed->processing (задание: "нельзя failed ->
-- processing", дословно) — отклоняется здесь, на уровне PostgreSQL, даже
-- если бы сервисный код почему-то допустил такую попытку.
CREATE OR REPLACE FUNCTION fn_restaurant_payouts_valid_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'prepared' AND NEW.status IN ('processing', 'failed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'restaurant_payouts: invalid status transition % -> % (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_restaurant_payouts_valid_transition ON restaurant_payouts;
CREATE TRIGGER trg_restaurant_payouts_valid_transition
BEFORE UPDATE ON restaurant_payouts
FOR EACH ROW
EXECUTE FUNCTION fn_restaurant_payouts_valid_transition();

-- Immutable после terminal (задание: "После succeeded или failed выплата
-- становится неизменяемой. Это должно защищаться не только кодом, но и
-- PostgreSQL") — блокирует АБСОЛЮТНО любой UPDATE/DELETE, если OLD.status
-- уже terminal, включая правку notes/external_payout_id "заодно" — тот же
-- принцип, что и fn_settlement_snapshot_row_immutable (Stage 8).
CREATE OR REPLACE FUNCTION fn_restaurant_payouts_immutable_after_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'restaurant_payouts: payout in terminal status % is immutable (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_restaurant_payouts_block_update_after_terminal ON restaurant_payouts;
CREATE TRIGGER trg_restaurant_payouts_block_update_after_terminal
BEFORE UPDATE ON restaurant_payouts
FOR EACH ROW
EXECUTE FUNCTION fn_restaurant_payouts_immutable_after_terminal();

CREATE OR REPLACE FUNCTION fn_restaurant_payouts_block_delete_after_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'restaurant_payouts: payout in terminal status % cannot be deleted (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_restaurant_payouts_block_delete_after_terminal ON restaurant_payouts;
CREATE TRIGGER trg_restaurant_payouts_block_delete_after_terminal
BEFORE DELETE ON restaurant_payouts
FOR EACH ROW
EXECUTE FUNCTION fn_restaurant_payouts_block_delete_after_terminal();

-- Аудит-события этого этапа (задание, раздел "Audit"). restaurant_id ЗАДАН
-- (в отличие от settlement-событий выше) — payout всегда привязан к одному
-- конкретному ресторану.
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
  'settlement_period_created', 'settlement_period_closed', 'settlement_period_draft_deleted',
  'payout_created', 'payout_processing', 'payout_succeeded', 'payout_failed',
  'payout_attempt_created', 'payout_attempt_processing', 'payout_attempt_unknown',
  'payout_attempt_succeeded', 'payout_attempt_failed'
));

-- =========================================================================
-- YAAM HQ Stage 9.5 — Payout Attempts Foundation for Russian T-Bank
-- Integration (аддитивно поверх Stage 9, без банка)
-- =========================================================================
--
-- Аудит перед изменением (см. итоговый отчёт Stage 9.5, разделы 2-3):
-- Т-Банк T-API документация (YAAM-TBank-API-Documentation-Audit.md) и
-- независимое индустриальное исследование (Stripe/Adyen/Wise/PayPal/
-- Razorpay/Open Banking/Shopify/Kill Bill — YAAM-Payout-Architecture-
-- Industry-Research.md) независимо пришли к одному выводу: Stage 9 смешивал
-- "долг перед рестораном" (обязательство, должно жить долго, без потери
-- истории) и "одна попытка отправить деньги банку" (может провалиться,
-- зависнуть, требовать повтора) в ОДНОЙ строке restaurant_payouts. Это делает
-- невозможным безопасный retry после failed без стирания истории первой
-- попытки — Stage 9's failed был terminal И immutable ОДНОВременно на
-- уровне обязательства, что архитектурно исключает повторную попытку.
--
-- Решение (задание, раздел "Preserve the obligation model" +
-- "Add payout_attempts"): restaurant_payouts ОСТАЁТСЯ единственным
-- обязательством на пару (settlement_period_id, restaurant_id) — НИ ОДНА
-- существующая гарантия (UNIQUE, FOREIGN KEY на settlement_restaurant_lines,
-- amount копируется один раз) не меняется. payout_attempts — НОВАЯ,
-- дополнительная таблица: каждая РЕАЛЬНАЯ попытка обращения к банку — своя
-- строка, свой payment_id, своя неизменяемая история. failed теперь СТАТУС
-- ПОПЫТКИ, а не обязательства — обязательство получает succeeded (оплачено,
-- terminal, immutable — БЕЗ ИЗМЕНЕНИЙ по сравнению с Stage 9) или blocked
-- (последняя попытка провалилась, деньги всё ещё должны, но требуется
-- решение оператора/исправление реквизитов перед новой попыткой).

-- -------------------------------------------------------------------------
-- payout_attempts
-- -------------------------------------------------------------------------
-- payment_id — ГЕНЕРИРУЕТСЯ YAAM (не банком — см. T-Bank audit, раздел 6:
-- "paymentId" в запросе создания платежа — это ВСЕГДА поле запроса, которое
-- заполняет вызывающая сторона, и оно же одновременно служит ключом
-- идемпотентности Т-Банка). UNIQUE — предотвращает повторное использование
-- одного и того же payment_id для двух разных попыток (задание, раздел 3:
-- "payment_id is unique... never reused across different attempts").
-- bank_status — СЫРОЙ будущий статус Т-Банка, может быть NULL до реальной
-- интеграции (задание: "may be NULL before integration") — намеренно НЕ
-- CHECK-ограничен списком значений, потому что точный enum Т-Банка для
-- прямого H2H-платежа не подтверждён официальной документацией (см.
-- T-Bank audit, раздел 7b, UNKNOWN) — выдумывать список значений для
-- CHECK-ограничения было бы тем самым "guessing", который запрещён заданием.
CREATE TABLE IF NOT EXISTS payout_attempts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id INTEGER NOT NULL REFERENCES restaurant_payouts(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  payment_id TEXT NOT NULL UNIQUE CHECK (char_length(payment_id) <= 64),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'submitting', 'processing', 'unknown', 'succeeded', 'failed')),
  bank_status TEXT,
  request_started_at TIMESTAMPTZ,
  response_received_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_code TEXT,
  -- error_message — санитизированное, ограниченное поле (задание: "must be
  -- safe and bounded, not raw response storage") — длина ограничена здесь,
  -- НА УРОВНЕ СХЕМЫ, а не только надеждой на дисциплину вызывающего кода
  -- (services/hq/payoutService.js: sanitizeErrorMessage()).
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payout_id, attempt_number),
  -- Единственные два СТРОГИХ инварианта, которые остаются верными для ЛЮБОГО
  -- реального пути (created/submitting/processing/unknown допускают много
  -- разных реальных последовательностей timestamp'ов — см. итоговый отчёт,
  -- раздел 6 — поэтому НЕ ограничены жёстко, в отличие от двух terminal-
  -- статусов ниже, для которых ровно один факт всегда обязателен).
  CHECK (status <> 'succeeded' OR completed_at IS NOT NULL),
  CHECK (status <> 'failed' OR failed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_payout_attempts_payout ON payout_attempts (payout_id);
CREATE INDEX IF NOT EXISTS ix_payout_attempts_status ON payout_attempts (status);

-- Active-attempt invariant (задание, раздел 5: "There must be no more than
-- one active attempt per payout... A second active attempt for the same
-- payout must be physically impossible"). Партиальный UNIQUE-индекс — ТОТ ЖЕ
-- принцип, что и ux_refunds_one_active_per_payment (Stage 1) — единственный
-- надёжный способ гарантировать это на уровне PostgreSQL, а не только
-- проверкой в JS до INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payout_attempts_one_active_per_payout
  ON payout_attempts (payout_id) WHERE status IN ('created', 'submitting', 'processing', 'unknown');

-- Полный граф переходов attempt (задание, раздел 4). created->submitting
-- (обычный путь) ; submitting->processing (банк принял/промежуточный
-- ответ); submitting->unknown (timeout/нет ответа ДО получения любого
-- статуса); submitting->failed (мгновенный синхронный отказ банка ДО
-- postановки в обработку — тот же принцип, что prepared->failed на уровне
-- обязательства в Stage 9: отказ возможен и БЕЗ захода в processing);
-- processing->{succeeded,failed,unknown}; unknown->{processing,succeeded,
-- failed} (reconciliation в будущем Stage 10 разрешает неопределённость).
-- ВАЖНО (задание, раздел 4, дословно): "timeout / exception / HTTP 500 alone
-- must never cause failed" — граф НЕ содержит ни submitting->failed-по-
-- timeout, ни processing->failed-по-timeout как ОТДЕЛЬНОГО случая: любой
-- переход в failed требует explicit вызова markAttemptFailed() с конкретной
-- error_message/errorCode (services/hq/payoutService.js) — граф лишь
-- разрешает ЧТО МОЖНО, а не решает, когда это уместно.
CREATE OR REPLACE FUNCTION fn_payout_attempts_valid_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'created' AND NEW.status = 'submitting' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'submitting' AND NEW.status IN ('processing', 'unknown', 'failed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed', 'unknown') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'unknown' AND NEW.status IN ('processing', 'succeeded', 'failed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payout_attempts: invalid status transition % -> % (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_attempts_valid_transition ON payout_attempts;
CREATE TRIGGER trg_payout_attempts_valid_transition
BEFORE UPDATE ON payout_attempts
FOR EACH ROW
EXECUTE FUNCTION fn_payout_attempts_valid_transition();

-- Immutable после terminal (succeeded/failed) — тот же принцип, что
-- fn_restaurant_payouts_immutable_after_terminal (Stage 9), применённый к
-- попытке: история ПОЧЕМУ конкретная попытка провалилась не должна
-- переписываться при создании следующей попытки.
CREATE OR REPLACE FUNCTION fn_payout_attempts_immutable_after_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'payout_attempts: attempt in terminal status % is immutable (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_attempts_block_update_after_terminal ON payout_attempts;
CREATE TRIGGER trg_payout_attempts_block_update_after_terminal
BEFORE UPDATE ON payout_attempts
FOR EACH ROW
EXECUTE FUNCTION fn_payout_attempts_immutable_after_terminal();

CREATE OR REPLACE FUNCTION fn_payout_attempts_block_delete_after_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'payout_attempts: attempt in terminal status % cannot be deleted (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_attempts_block_delete_after_terminal ON payout_attempts;
CREATE TRIGGER trg_payout_attempts_block_delete_after_terminal
BEFORE DELETE ON payout_attempts
FOR EACH ROW
EXECUTE FUNCTION fn_payout_attempts_block_delete_after_terminal();

-- -------------------------------------------------------------------------
-- Rework restaurant_payouts: новый набор статусов обязательства (задание,
-- раздел 6) — prepared/processing/unknown/succeeded/blocked. failed БОЛЬШЕ
-- НЕ является статусом обязательства.
--
-- ВАЖНО про порядок (реальный баг, найденный при проверке миграции на живой
-- embedded PostgreSQL с уже существующими Stage 9 'failed'-строками — см.
-- итоговый отчёт Stage 9.5, раздел "Bugs found and fixed"): функции/
-- ограничения ниже ОБЯЗАНЫ замениться НА НОВУЮ версию ДО backfill-UPDATE
-- дальше по файлу, а не после. Если сначала выполнить UPDATE ... SET
-- status='blocked', а версии триггеров/CHECK заменить только потом, UPDATE
-- падает сразу по трём независимым причинам: (1) старый
-- fn_restaurant_payouts_immutable_after_terminal ещё считает 'failed'
-- terminal и блокирует любой UPDATE такой строки; (2) старый
-- fn_restaurant_payouts_valid_transition не знает перехода "-> blocked"
-- вообще; (3) старый CHECK(status IN (...)) не допускает значения 'blocked'
-- как таковое. Все три должны стать НОВОЙ версией первыми — тогда backfill
-- ниже проходит уже по новым, разрешающим правилам.
-- -------------------------------------------------------------------------
ALTER TABLE restaurant_payouts DROP CONSTRAINT IF EXISTS restaurant_payouts_status_check;
ALTER TABLE restaurant_payouts ADD CONSTRAINT restaurant_payouts_status_check
  CHECK (status IN ('prepared', 'processing', 'unknown', 'succeeded', 'blocked', 'failed'));
-- 'failed' временно ОСТАЁТСЯ разрешённым значением здесь — исключительно
-- чтобы существующие Stage 9 'failed'-строки продолжали физически
-- существовать между этим ALTER и backfill-UPDATE ниже по файлу by the same
-- transaction. Финальный, УЖЕ БЕЗ 'failed', CHECK добавляется отдельным
-- ALTER после backfill (см. ниже "Финальное сужение").

-- Старое строгое table-level CHECK (Stage 9) требовало ТОЧНОГО набора
-- timestamp'ов на КАЖДЫЙ статус — это моделировало чистый линейный
-- 4-статусный автомат. С появлением unknown/blocked как "агрегированной
-- сводки по последней попытке" (а не собственного строгого жизненного
-- цикла обязательства) строгая версия перестаёт быть корректной: например,
-- blocked ПОСЛЕ unknown может не иметь processing_at, если попытка
-- провалилась ещё на submitting. Единственный инвариант, который остаётся
-- ВСЕГДА верным и достаточным для защиты от "выплата отмечена оплаченной
-- без факта оплаты" — succeeded требует completed_at.
-- Обе DROP-строки нужны: первая снимает старое Stage 9 авто-имя (первый
-- прогон миграции на уже существующей базе), вторая делает саму эту ALTER-
-- пару идемпотентной при повторном прогоне schema.sql (задание, раздел 13:
-- "All migration logic must be idempotent") — иначе второй прогон упал бы на
-- "constraint already exists".
ALTER TABLE restaurant_payouts DROP CONSTRAINT IF EXISTS restaurant_payouts_check;
ALTER TABLE restaurant_payouts DROP CONSTRAINT IF EXISTS restaurant_payouts_status_completed_at_check;
ALTER TABLE restaurant_payouts ADD CONSTRAINT restaurant_payouts_status_completed_at_check
  CHECK (status <> 'succeeded' OR completed_at IS NOT NULL);

-- Полный граф переходов ОБЯЗАТЕЛЬСТВА (задание, раздел 6-7): prepared/
-- blocked -> processing (создана и отправляется первая/новая попытка);
-- processing -> succeeded (попытка подтверждена успешной); processing ->
-- unknown (активная попытка стала неопределённой); processing -> prepared
-- (попытка провалилась, retryable=true — можно создать новую попытку сразу);
-- processing -> blocked (попытка провалилась, retryable=false — нужно
-- решение оператора/исправление реквизитов); unknown -> {processing,
-- succeeded, prepared, blocked} (симметрично, после того как неопределённая
-- попытка наконец разрешилась). succeeded — единственный terminal статус
-- обязательства (задание: "Do not retain obligation-level failed as a
-- permanent dead end... succeeded: confirmed paid; terminal and immutable").
--
-- 'failed' -> 'blocked' — ЕДИНСТВЕННЫЙ переход, существующий ТОЛЬКО ради
-- одноразового backfill ниже по файлу: реальный сервисный код Stage 9.5
-- никогда не пишет status='failed' в restaurant_payouts (это значение
-- полностью исключено из финального CHECK — см. "Финальное сужение" ниже),
-- поэтому эта ветка не может сработать ни разу после первой миграции.
CREATE OR REPLACE FUNCTION fn_restaurant_payouts_valid_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'failed' AND NEW.status = 'blocked' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('prepared', 'blocked') AND NEW.status = 'processing' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'processing' AND NEW.status IN ('succeeded', 'unknown', 'prepared', 'blocked') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'unknown' AND NEW.status IN ('processing', 'succeeded', 'prepared', 'blocked') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'restaurant_payouts: invalid status transition % -> % (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

-- Immutable после terminal — ТОЛЬКО succeeded теперь terminal (задание,
-- раздел 6, дословно) — blocked/unknown/prepared/processing (и временно,
-- только для backfill, failed) все остаются редактируемыми.
CREATE OR REPLACE FUNCTION fn_restaurant_payouts_immutable_after_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'restaurant_payouts: payout in terminal status % is immutable (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_restaurant_payouts_block_delete_after_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'restaurant_payouts: payout in terminal status % cannot be deleted (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------------------
-- Backfill существующих Stage 9 строк (задание, раздел 13: "Existing Stage 9
-- rows must survive the additive migration... A safe likely policy for
-- existing failed rows"). Выполняется ПОСЛЕ замены функций/CHECK выше —
-- теперь и триггеры, и ограничение допускают переход 'failed' -> 'blocked'.
-- Идемпотентно: WHERE status = 'failed' делает повторный прогон на уже
-- смигрированной базе no-op (после первого прогона таких строк не остаётся).
--
-- Один синтетический historical attempt на каждую существующую 'failed'
-- строку, СОБРАННЫЙ ТОЛЬКО из уже существующих полей (задание: "Do not
-- invent provider status" — bank_status оставлен NULL, а не выдуман).
-- retryable = false (задание: "unless the original data explicitly proves
-- otherwise" — Stage 9 никогда не записывал признак retryable, поэтому
-- честная позиция — считать историческую попытку НЕ доказанно retryable,
-- требующей решения оператора, а не автоматического повтора).
INSERT INTO payout_attempts
  (payout_id, attempt_number, payment_id, status, bank_status,
   request_started_at, response_received_at, completed_at, failed_at,
   error_code, error_message, retryable, created_at, updated_at)
SELECT
  rp.id, 1, 'legacy-payout-' || rp.id, 'failed', NULL,
  COALESCE(rp.processing_at, rp.prepared_at), NULL, NULL, rp.failed_at,
  NULL, rp.failure_reason, FALSE, COALESCE(rp.failed_at, rp.updated_at), NOW()
FROM restaurant_payouts rp
WHERE rp.status = 'failed'
  AND NOT EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa.payout_id = rp.id);

-- Сама обязанность переходит в blocked (задание: "move parent obligation to
-- blocked; preserve failure_reason and timestamps") — failure_reason/
-- failed_at/processing_at СОЗНАТЕЛЬНО не очищаются этим UPDATE: они остаются
-- честным "почему сейчас blocked" кэшем на уровне обязательства, зеркалящим
-- только что созданную историческую попытку.
UPDATE restaurant_payouts SET status = 'blocked', updated_at = NOW() WHERE status = 'failed';

-- Финальное сужение: теперь, когда ни одной строки со status='failed' не
-- осталось, 'failed' убирается из допустимых значений НАВСЕГДА — реальный
-- сервисный код Stage 9.5 никогда не пишет его в эту таблицу (задание,
-- раздел 6: failed принадлежит попытке, не обязательству).
ALTER TABLE restaurant_payouts DROP CONSTRAINT IF EXISTS restaurant_payouts_status_check;
ALTER TABLE restaurant_payouts ADD CONSTRAINT restaurant_payouts_status_check
  CHECK (status IN ('prepared', 'processing', 'unknown', 'succeeded', 'blocked'));

-- =========================================================================
-- YAAM HQ Stage 9.6 — T-Bank Integration Readiness (аддитивно поверх
-- Stage 9.5, ПО-ПРЕЖНЕМУ без банка: нет HTTP-клиента, нет токенов, нет
-- webhook/polling worker'ов, нет реальных денег — задание, раздел "Hard
-- restrictions").
-- =========================================================================
--
-- Аудит перед изменением (см. итоговый отчёт Stage 9.6, разделы 2-5):
-- T-Bank T-API требует `from.accountNumber`/`from.kpp` (собственные
-- реквизиты ПЛАТЕЛЬЩИКА, то есть YAAM) — этого понятия не существовало НИ В
-- ОДНОЙ таблице до этого этапа (Stages 6-9.5 моделировали только реквизиты
-- ПОЛУЧАТЕЛЯ — ресторана). Также T-API требует нерушимый снимок того, куда и
-- с какими реквизитами собирались отправить деньги на момент КАЖДОЙ
-- конкретной попытки — если реквизиты ресторана изменятся между попыткой №1
-- и попыткой №2 (исправление ошибки в реквизитах после провала), попытка №1
-- должна НАВСЕГДА остаться со СВОИМИ, уже отправленными/подготовленными
-- значениями, а не "текущими" (задание, раздел 5).

-- -------------------------------------------------------------------------
-- yaam_bank_details — реквизиты САМОГО YAAM как плательщика (T-API
-- `from.accountNumber`/`from.kpp`). Singleton (классический PostgreSQL-
-- паттерн: PRIMARY KEY с CHECK (id = 1) — физически не даёт вставить вторую
-- строку, а не только "мы обещаем этого не делать" в сервисном коде).
-- HQ-only: не участвует ни в одном public API запросе, ни в Telegram-боте
-- (задание, раздел 3: "отсутствует в public API и Telegram").
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS yaam_bank_details (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name TEXT NOT NULL,
  inn TEXT NOT NULL,
  kpp TEXT NOT NULL,
  account_number TEXT NOT NULL,          -- 20 цифр, проверено относительно bik (services/hq/ruRequisites.js)
  bik TEXT NOT NULL,                     -- 9 цифр
  bank_name TEXT NOT NULL CHECK (char_length(bank_name) <= 255), -- T-API to.bankName/from-эквивалент ≤255 (T-Bank audit, раздел 13)
  correspondent_account TEXT NOT NULL,   -- 20 цифр, проверено относительно bik
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Устраняет два реальных пробела Stage 6, найденных T-Bank audit (раздел
-- 13): "bank_name должен быть ≤255 символов (T-API to.bankName)" и "purpose
-- должен быть ≤210 символов (T-API purpose)" — раньше НИ ОДНОЙ длины не было
-- ограничено в схеме (только в services/hq/restaurantBankDetailsService.js,
-- который вообще не проверял длину). Добавлено НА УРОВНЕ СХЕМЫ, чтобы
-- невозможно было обойти проверку случайной правкой сервисного кода.
--
-- ВАЖНО про безопасность этой миграции (задание, раздел 2: "не исправлять
-- молча"): если в существующих данных реально есть bank_name длиннее 255
-- символов или default_payment_purpose длиннее 210 — этот ALTER упадёт с
-- ошибкой (constraint violation) на существующих строках. Это НАМЕРЕННО
-- fail-closed поведение, а не молчаливая обрезка/исправление данных — если
-- когда-либо случится в реальной базе, миграция должна остановиться и
-- потребовать ручного разбора, а не тихо укоротить платёжные реквизиты.
ALTER TABLE restaurant_bank_details DROP CONSTRAINT IF EXISTS restaurant_bank_details_bank_name_check;
ALTER TABLE restaurant_bank_details ADD CONSTRAINT restaurant_bank_details_bank_name_check
  CHECK (char_length(bank_name) <= 255);
ALTER TABLE restaurant_bank_details DROP CONSTRAINT IF EXISTS restaurant_bank_details_purpose_check;
ALTER TABLE restaurant_bank_details ADD CONSTRAINT restaurant_bank_details_purpose_check
  CHECK (char_length(default_payment_purpose) <= 210);

-- -------------------------------------------------------------------------
-- payout_attempt_requisites — НЕИЗМЕНЯЕМЫЙ снимок реквизитов на момент
-- конкретной попытки (задание, раздел 5: "Вариант B"). 1:1 с payout_attempts
-- (attempt_id — сам PK, не отдельная identity-колонка — ровно одна строка на
-- попытку, не больше и не меньше, физически гарантировано самим PK).
--
-- ВЫБОР "Вариант B" вместо "Вариант A" (хранить поля прямо в payout_attempts)
-- обоснование: payout_attempts УЖЕ имеет условную immutability-логику
-- (immutable только после succeeded/failed — задание Stage 9.5, раздел 4) —
-- добавление туда ещё и БЕЗУСЛОВНО неизменяемых с момента INSERT колонок
-- потребовало бы либо ослабить существующий триггер до per-column
-- исключений (усложнение уже работающей и протестированной логики), либо
-- полагаться только на дисциплину сервисного кода "просто никогда не
-- обновлять эти колонки" (более слабая гарантия). Отдельная таблица с
-- БЕЗУСЛОВНЫМ (не завязанным на статус) запретом UPDATE/DELETE — более
-- простой для проверки, более безопасный инвариант: "эта строка не может
-- измениться НИКОГДА, с момента создания", без каких-либо условий вообще.
--
-- recipient_kpp хранится УЖЕ В T-BANK ПРЕДСТАВЛЕНИИ (задание, раздел 5:
-- "recipient_kpp в T-Bank representation") — то есть трансформация
-- '' -> '0' (T-Bank audit, раздел 13: "ИП без КПП... T-API требует
-- литеральную строку '0'") происходит ОДИН РАЗ, здесь, в момент создания
-- снимка (services/hq/payoutService.js: createPayoutAttempt), а НЕ в
-- будущем mapper'е (services/hq/tbankRequestMapper.js) — mapper читает уже
-- готовое значение и ничего не трансформирует (задание, раздел 6: "данные
-- берутся только из immutable attempt snapshot", "mapper должен быть
-- детерминированным" — трансформация внутри mapper'а сделала бы его
-- зависимым от бизнес-правила "как выглядит КПП ИП", а не только от формы
-- снимка).
--
-- payer_account_number/payer_kpp — КОПИЯ (не ссылка/FK) реквизитов YAAM НА
-- МОМЕНТ создания попытки: yaam_bank_details — synglton, который можно
-- редактировать; FK-ссылка на него означала бы, что снимок "поплывёт" вслед
-- за будущим редактированием реквизитов YAAM — то же самое нарушение
-- immutability, которое задание явно запрещает для реквизитов РЕСТОРАНА
-- (раздел 5: "изменение restaurant_bank_details после создания attempt не
-- меняет snapshot"); тот же принцип применён и к реквизитам самого YAAM.
CREATE TABLE IF NOT EXISTS payout_attempt_requisites (
  attempt_id INTEGER PRIMARY KEY REFERENCES payout_attempts(id),
  recipient_name TEXT NOT NULL,
  recipient_inn TEXT NOT NULL,
  recipient_kpp TEXT NOT NULL,           -- T-Bank representation: '0' или 9 цифр, никогда ''
  account_number TEXT NOT NULL,
  bik TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  correspondent_account TEXT NOT NULL,
  payment_purpose TEXT NOT NULL CHECK (char_length(payment_purpose) <= 210),
  amount INTEGER NOT NULL CHECK (amount > 0),
  payer_account_number TEXT NOT NULL,
  payer_kpp TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_payout_attempt_requisites_attempt ON payout_attempt_requisites (attempt_id);

-- БЕЗУСЛОВНАЯ immutability (не только "после terminal", как у самой
-- payout_attempts, — здесь ЛЮБОЕ изменение запрещено с момента создания,
-- см. обоснование "Варианта B" выше).
CREATE OR REPLACE FUNCTION fn_payout_attempt_requisites_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payout_attempt_requisites: row is immutable (attempt_id=%)', OLD.attempt_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_attempt_requisites_block_update ON payout_attempt_requisites;
CREATE TRIGGER trg_payout_attempt_requisites_block_update
BEFORE UPDATE ON payout_attempt_requisites
FOR EACH ROW EXECUTE FUNCTION fn_payout_attempt_requisites_immutable();

DROP TRIGGER IF EXISTS trg_payout_attempt_requisites_block_delete ON payout_attempt_requisites;
CREATE TRIGGER trg_payout_attempt_requisites_block_delete
BEFORE DELETE ON payout_attempt_requisites
FOR EACH ROW EXECUTE FUNCTION fn_payout_attempt_requisites_immutable();

-- hq_audit_log allowlist — 2 новых RESERVED-события (задание, раздел 11):
-- yaam_bank_details_created/updated. Тот же принцип, что и весь остальной
-- Stage 9/9.5 payout-allowlist: emitted реальным HQ-маршрутом (в отличие от
-- payout_attempt_*, которые остаются reserved) — см. итоговый отчёт,
-- раздел "Audit log".
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
  'settlement_period_created', 'settlement_period_closed', 'settlement_period_draft_deleted',
  'payout_created', 'payout_processing', 'payout_succeeded', 'payout_failed',
  'payout_attempt_created', 'payout_attempt_processing', 'payout_attempt_unknown',
  'payout_attempt_succeeded', 'payout_attempt_failed',
  'yaam_bank_details_created', 'yaam_bank_details_updated',
  -- Индивидуальная выплата с обзора ресторана (docs/HQ-PRODUCT-SPEC.md):
  -- само обязательство создаётся тем же payoutService.prepareRestaurantPayout(),
  -- что и на общей вкладке «Выплаты» — здесь фиксируется, что запуск
  -- произошёл именно с карточки конкретного ресторана.
  'restaurant_payout_prepared'
));

-- =========================================================================
-- YAAM HQ Stage 9.8 — Final Payout Architecture Audit fixes (Stage 9.7
-- нашёл эти пробелы; здесь ТОЛЬКО их точечное исправление — архитектура,
-- сущности и UI не менялись, T-Bank по-прежнему не подключён).
-- =========================================================================

-- -------------------------------------------------------------------------
-- Находка F2 (аудит Stage 9.7): restaurant_payouts.amount не был защищён НИ
-- ОДНИМ триггером до достижения 'succeeded' — существующий
-- fn_restaurant_payouts_immutable_after_terminal защищает ВСЮ строку
-- целиком, но только ПОСЛЕ terminal-статуса; до этого момента прямой SQL
-- (в обход сервисного слоя, который сам никогда не пишет amount после
-- INSERT) мог тихо изменить сумму prepared/processing/unknown/blocked
-- обязательства без единой ошибки. Задание: "Закрытый расчётный период
-- фиксирует долг YAAM перед рестораном" — эта сумма должна быть
-- неизменяемой С МОМЕНТА СОЗДАНИЯ строки, а не только после оплаты.
--
-- Реализовано ОТДЕЛЬНЫМ, самостоятельным триггером (не встроено в уже
-- протестированный fn_restaurant_payouts_valid_transition), тот же принцип
-- "один триггер — одна ответственность", что уже применён к трём
-- существующим триггерам restaurant_payouts/payout_attempts — минимизирует
-- риск случайно задеть уже работающую логику переходов статуса.
CREATE OR REPLACE FUNCTION fn_restaurant_payouts_amount_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount <> OLD.amount THEN
    RAISE EXCEPTION 'restaurant_payouts: amount is immutable after creation (id=%, old=%, new=%)', OLD.id, OLD.amount, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_restaurant_payouts_amount_immutable ON restaurant_payouts;
CREATE TRIGGER trg_restaurant_payouts_amount_immutable
BEFORE UPDATE ON restaurant_payouts
FOR EACH ROW
EXECUTE FUNCTION fn_restaurant_payouts_amount_immutable();

-- -------------------------------------------------------------------------
-- Находка F3 (аудит Stage 9.7): payout_attempts требовал failed_at NOT
-- NULL при status='failed' (существующий CHECK), но НЕ требовал того же
-- для error_message/retryable — прямой SQL мог создать "failed" попытку
-- без единой причины и без признака retryable, оставляя историю операции
-- неполной (не влияет на факт оплаты/сумму, но противоречит собственному
-- правилу сервисного слоя: markAttemptFailed() ВСЕГДА требует оба поля).
--
-- Безопасно добавлять напрямую (не NOT VALID): markAttemptFailed() уже
-- гарантирует оба поля для каждой строки, созданной сервисным слоем
-- (errorMessage.trim() проверяется до записи, см. валидацию в начале
-- markAttemptFailed()), и sanitizeErrorMessage() никогда не возвращает
-- пустую/пробельную строку; единственная историческая 'failed'-попытка,
-- синтезированная Stage 9.5 backfill'ом (см. секцию Stage 9.5 выше), тоже
-- всегда получает непустой error_message (из failure_reason, который
-- Stage 9's CHECK уже требовал NOT NULL для failed-строк, а сервисный код
-- Stage 9, задававший его, никогда не писал туда пустую строку) и
-- retryable=FALSE — обе схемы данных уже соответствуют этому ограничению
-- до его добавления.
--
-- Усилено (доп. правка после первой версии): помимо failed_at/error_message/
-- retryable NOT NULL, теперь дополнительно требуется btrim(error_message) <> ''
-- и явное failed_at IS NOT NULL в самом CHECK (ранее полагались только на
-- существующий соседний CHECK payout_attempts_status_dates_check) — прямой
-- SQL больше не может создать "failed" попытку с error_message из одних
-- пробелов.
ALTER TABLE payout_attempts DROP CONSTRAINT IF EXISTS payout_attempts_failed_requires_reason_check;
ALTER TABLE payout_attempts ADD CONSTRAINT payout_attempts_failed_requires_reason_check
  CHECK (
    status <> 'failed'
    OR (
      failed_at IS NOT NULL
      AND error_message IS NOT NULL
      AND btrim(error_message) <> ''
      AND retryable IS NOT NULL
    )
  );

-- =========================================================================
-- hq_events — «Центр событий» HQ «Обзор» (docs/HQ-PRODUCT-SPEC.md)
-- =========================================================================
-- Терминальная лента реальных проблем владельца — НЕ операционный лог (тот
-- есть у hq_security_log/hq_audit_log, другого назначения). category —
-- закрытый список (тот же принцип db-backstop, что и orders.status/
-- payments.status выше): только классы проблем, для которых в коде
-- РЕАЛЬНО существует источник или явно спроектирована точка подключения —
-- ничего не добавляется "про запас" без источника.
--
-- restaurant_name/order_public_code — СНИМКИ на момент события (тот же
-- принцип, что order_items.name — "снимок названия на момент заказа"): имя
-- ресторана могло измениться после события, участвовавший в тексте события
-- код заказа не должен зависеть от текущего состояния этих таблиц.
-- restaurant_id/order_id — обычные ссылки БЕЗ ON DELETE (тот же принцип, что
-- orders.restaurant_id/hq_audit_log.restaurant_id) — ссылочная информация
-- для будущей навигации "к этому ресторану/заказу", не обязательна для
-- отображения самой ленты (снимки выше уже самодостаточны).
--
-- message — уже полностью сформированный человекочитаемый текст (условие
-- задания: "не обязательно искусственно делить сообщение на причину и
-- действие") — история не пересчитывается заново при показе, значит текст
-- события не меняется, даже если формулировки в коде позже изменятся.
CREATE TABLE IF NOT EXISTS hq_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'order_missed', 'payment_issue', 'refund_issue', 'payout_issue',
    'backend_issue', 'telegram_issue',
    -- Важное управленческое событие, а не проблема: ресторан сам взял/снял
    -- перерыв через Telegram (docs/HQ-PRODUCT-SPEC.md, раздел «Пауза
    -- ресторана через Telegram»).
    'restaurant_pause',
    'other'
  )),
  restaurant_id INTEGER REFERENCES restaurants(id),
  restaurant_name TEXT,
  order_id INTEGER REFERENCES orders(id),
  order_public_code TEXT,
  message TEXT NOT NULL CHECK (btrim(message) <> '' AND char_length(message) <= 1000),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_hq_events_occurred_at ON hq_events (occurred_at);

-- Серверный срок готовности заказа (docs/HQ-PRODUCT-SPEC.md, раздел
-- «Таймер приготовления»). Заполняется РОВНО ОДИН РАЗ, в момент перехода в
-- 'preparing' с выбранным рестораном временем (services/postgresql/
-- orderService.js: restaurantAdvance), значением самой БД (NOW() + interval)
-- — клиент считает обратный отсчёт ОТ НЕГО и не может его сбросить
-- обновлением страницы. Обнуляется при переходе в courier/delivered: готовка
-- закончилась, таймер клиенту больше не показывается.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparation_deadline TIMESTAMPTZ;

-- Название рабочей Telegram-группы ресторана (docs/HQ-PRODUCT-SPEC.md,
-- раздел «Telegram-подключение»): владельцу в HQ показывается человеческое
-- название группы, а не технический chat_id. Заполняется в момент привязки
-- (services/hq/telegramLinkService.js: consumeConnectCode).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS telegram_chat_title TEXT;

-- Одна Telegram-группа не может обслуживать два ресторана: заказы одного
-- ресторана иначе попадали бы в чужую группу вместе с телефоном и адресом
-- клиента. Частичный UNIQUE — DB-уровневая гарантия поверх явной проверки в
-- consumeConnectCode() (тот же принцип defense-in-depth, что и у
-- ux_payments_one_active_per_order).
CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurants_telegram_chat
  ON restaurants (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- «Очистить» (задание, раздел 6) — НЕ удаляет строки, только двигает курсор
-- "очищено до" на единственной строке hq_owner (одна HQ-сессия владельца на
-- весь продукт — тот же singleton, что password_hash/login). Основная лента
-- = hq_events.occurred_at > events_cleared_before; «История» игнорирует эту
-- колонку и читает всю таблицу.
ALTER TABLE hq_owner ADD COLUMN IF NOT EXISTS events_cleared_before TIMESTAMPTZ;

-- =========================================================================
-- YAAM HQ — расчётные документы (docs/HQ-PRODUCT-SPEC.md, «Расчётные периоды
-- и документы»)
-- =========================================================================

-- Снимки юридических данных на момент ЗАКРЫТИЯ периода. Строки
-- settlement_restaurant_lines уже immutable (trg_settlement_restaurant_lines_
-- immutable), поэтому эти колонки автоматически неизменяемы вместе с ними:
-- последующая правка названия/ИНН/договора/комиссии ресторана или реквизитов
-- YAAM НЕ меняет уже закрытый период и его документы (задание, раздел 4).
--
-- Все колонки nullable/с дефолтом: на уже существующих закрытых периодах
-- (созданных до этой правки) снимка нет, и это честно отражается в документе
-- как отсутствующие данные, а не как выдуманные значения.
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS restaurant_name_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS legal_name_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS legal_form_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS inn_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS ogrn_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS legal_address_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS contract_signed_at_snapshot DATE;
-- Реквизиты YAAM как агента — тоже снимок на момент закрытия.
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_legal_name_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_inn_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_kpp_snapshot TEXT;

-- -------------------------------------------------------------------------
-- settlement_adjustments — сторно позднего возврата
-- -------------------------------------------------------------------------
--
-- ЗАЧЕМ. Заказ учитывается в периоде по моменту доставки. Возврат покупателю
-- может прийти ПОЗЖЕ — когда период с этим заказом уже закрыт, снимок
-- зафиксирован, а обязательство перед рестораном начислено. Период неизменяем
-- и переписать его нельзя (и не нужно: выпущенный отчёт агента не должен
-- меняться задним числом). Поэтому возврат отражается в ТЕКУЩЕМ периоде
-- отдельной корректировочной записью — сторно.
--
-- Что сторнируется. Ровно те суммы, которые были начислены по этому заказу в
-- его исходном периоде, взятые из его же снимка settlement_order_lines:
--   restaurant_amount  — ресторан возвращает то, что ему было начислено;
--   commission_amount  — YAAM возвращает удержанную комиссию.
-- Не пересчёт по текущей ставке, а именно снимок: ставка могла измениться.
--
-- Без этой таблицы возврат попадал бы только в successful_refunds_amount и
-- НИКАК не влиял на payable_amount — ресторан получал бы деньги за заказ,
-- который покупателю уже вернули (подтверждено тестом B1 аудита Stage 13).
--
-- UNIQUE(refund_id) — один возврат сторнируется ровно один раз, структурно.
CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('late_refund')),
  refund_id INTEGER NOT NULL UNIQUE REFERENCES refunds(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  origin_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_amount INTEGER NOT NULL CHECK (restaurant_amount >= 0),
  commission_amount INTEGER NOT NULL CHECK (commission_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Сторно всегда относится к ДРУГОМУ, более раннему периоду: возврат по
  -- заказу текущего периода не нуждается в сторно — такой заказ вообще не
  -- попадает в turnover (EARNED_ORDER_FILTER_SQL).
  CHECK (origin_period_id <> settlement_period_id)
);
CREATE INDEX IF NOT EXISTS ix_settlement_adjustments_period ON settlement_adjustments (settlement_period_id);
CREATE INDEX IF NOT EXISTS ix_settlement_adjustments_origin ON settlement_adjustments (origin_period_id);

-- Корректировка — финансовая запись того же класса, что и снимок периода.
DROP TRIGGER IF EXISTS trg_settlement_adjustments_immutable ON settlement_adjustments;
CREATE TRIGGER trg_settlement_adjustments_immutable
BEFORE UPDATE OR DELETE ON settlement_adjustments
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Итоги сторно в строке ресторана. Хранятся рядом с суммами периода, чтобы
-- документ и выплата строились из ОДНОЙ строки, без повторного агрегирования.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS refund_adjustment_restaurant_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS refund_adjustment_commission INTEGER NOT NULL DEFAULT 0;

-- Комиссия YAAM за период НЕТТО: начислено минус сторнировано. Вычисляемая
-- колонка, а не второе место для ручной арифметики — разойтись не может.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS yaam_commission_net INTEGER
  GENERATED ALWAYS AS (yaam_commission - refund_adjustment_commission) STORED;

-- Отрицательный payable_amount — это НЕ ошибка, а долг ресторана перед YAAM
-- (возвраты превысили продажи периода). Обнулять его нельзя: это подарило бы
-- ресторану деньги, уже возвращённые покупателю. Но и выплатить отрицательную
-- сумму невозможно — состояние помечается явно и вычисляемо.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS payout_blocked_reason TEXT
  GENERATED ALWAYS AS (CASE WHEN payable_amount < 0 THEN 'negative_balance' ELSE NULL END) STORED;

-- Структурная гарантия против расхождения: payable_amount не может быть
-- посчитан «как-нибудь иначе» в обход сторно. Существующие строки условию
-- удовлетворяют (сторно = 0, payable = restaurant_earnings).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_srl_payable_matches_adjustments') THEN
    ALTER TABLE settlement_restaurant_lines
      ADD CONSTRAINT chk_srl_payable_matches_adjustments
      CHECK (payable_amount = restaurant_earnings - refund_adjustment_restaurant_amount);
  END IF;
END $$;

-- -------------------------------------------------------------------------
-- settlement_documents — «Отчёт агента» и «Реестр заказов»
-- -------------------------------------------------------------------------
--
-- Документ строится ТОЛЬКО из immutable snapshot периода и сам является
-- неизменяемым после создания (триггер ниже). Исправление ошибки — не
-- перезапись, а НОВАЯ ВЕРСИЯ со ссылкой на исходный документ и причиной
-- (задание, раздел 11).
--
-- payload JSONB — полная модель данных документа (то, из чего renderer
-- строит HTML/PDF). Хранится отдельно от рендера намеренно: renderer можно
-- заменить, не трогая уже выпущенные документы, и наоборот — повторный
-- рендер того же payload обязан давать тот же документ.
--
-- document_number — человекочитаемый уникальный номер, выдаётся один раз при
-- создании и НИКОГДА не переиспользуется (UNIQUE ниже).
CREATE TABLE IF NOT EXISTS settlement_documents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('agent_report', 'order_registry')),
  document_number TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Ссылка на документ, который эта версия исправляет (NULL у первой версии).
  supersedes_document_id INTEGER REFERENCES settlement_documents(id),
  correction_reason TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Корректирующая версия ОБЯЗАНА нести причину и ссылку на исходник —
  -- «молча перевыпустить документ» структурно невозможно.
  CHECK (
    (version = 1 AND supersedes_document_id IS NULL AND correction_reason IS NULL)
    OR (version > 1 AND supersedes_document_id IS NOT NULL AND btrim(correction_reason) <> '')
  )
);
CREATE INDEX IF NOT EXISTS ix_settlement_documents_period
  ON settlement_documents (settlement_period_id, restaurant_id);

-- Ровно одна ДЕЙСТВУЮЩАЯ версия каждого вида документа на пару
-- (период, ресторан): действующей считается та, которую никто не исправляет.
-- Реализовано как partial UNIQUE по (период, ресторан, вид) среди строк, на
-- которые не ссылается более новая версия — проверить это индексом нельзя,
-- поэтому уникальность держится на паре (период, ресторан, вид, версия).
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_documents_version
  ON settlement_documents (settlement_period_id, restaurant_id, kind, version);

-- Документ неизменяем после создания — тот же принцип и та же функция-стиль,
-- что и у settlement_restaurant_lines/settlement_order_lines (Stage 8).
CREATE OR REPLACE FUNCTION fn_settlement_documents_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'settlement documents are immutable: issue a correcting version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_documents_immutable ON settlement_documents;
CREATE TRIGGER trg_settlement_documents_immutable
BEFORE UPDATE OR DELETE ON settlement_documents
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_documents_immutable();

-- Корректирующая версия исправляет КОНКРЕТНЫЙ документ. Ссылка на документ
-- другого периода, ресторана или вида означала бы подмену документа, а не его
-- исправление — и в цепочке оказались бы данные, которых там быть не должно.
-- Приложение и так копирует эти поля из оригинала, но документ финансовый:
-- гарантия должна быть в БД, а не только в одной ветке кода.
CREATE OR REPLACE FUNCTION fn_settlement_document_chain_consistent()
RETURNS TRIGGER AS $$
DECLARE
  parent settlement_documents%ROWTYPE;
BEGIN
  IF NEW.supersedes_document_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM settlement_documents WHERE id = NEW.supersedes_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correcting document references a missing document';
  END IF;
  IF parent.settlement_period_id <> NEW.settlement_period_id
     OR parent.restaurant_id <> NEW.restaurant_id
     OR parent.kind <> NEW.kind THEN
    RAISE EXCEPTION 'correcting document must stay in the same chain: same period, restaurant and kind';
  END IF;
  IF NEW.version <> parent.version + 1 THEN
    RAISE EXCEPTION 'correcting document must increment version by exactly one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_document_chain ON settlement_documents;
CREATE TRIGGER trg_settlement_document_chain
BEFORE INSERT ON settlement_documents
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_document_chain_consistent();

-- Один документ может быть исправлен ровно один раз: иначе появились бы две
-- конкурирующие «актуальные» версии одной цепочки и было бы неизвестно, какая
-- из них действует. Цепочка остаётся линейной структурно.
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_documents_supersedes
  ON settlement_documents (supersedes_document_id)
  WHERE supersedes_document_id IS NOT NULL;

-- -------------------------------------------------------------------------
-- Перенос отрицательного остатка (carry-forward долга ресторана)
-- -------------------------------------------------------------------------
--
-- ЗАЧЕМ. Поздний возврат может превысить продажи периода — тогда ресторан
-- должен YAAM. Обнулить долг нельзя (деньги покупателю уже вернули), но и
-- выплатить отрицательную сумму невозможно. Долг переносится на следующие
-- периоды и гасится из будущих начислений, сколько бы периодов на это ни
-- ушло.
--
-- ДВЕ ТАБЛИЦЫ, а не одна, намеренно:
--   restaurant_settlement_balances — ТЕКУЩИЙ остаток. Одна строка на
--     ресторан, блокируется SELECT ... FOR UPDATE внутри той же транзакции,
--     что и закрытие периода: это и есть точка сериализации, без которой два
--     одновременных закрытия удержали бы один долг дважды.
--   restaurant_balance_entries — ПРОВОДКИ, append-only. Восстанавливают всю
--     историю долга и делают её проверяемой. UNIQUE(restaurant_id,
--     settlement_period_id, kind) структурно запрещает повторное удержание
--     того же долга тем же периодом.
CREATE TABLE IF NOT EXISTS restaurant_settlement_balances (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id),
  -- Всегда НЕОТРИЦАТЕЛЬНОЕ число: это размер долга ресторана перед YAAM.
  -- Ноль означает «долга нет», а не «баланс нулевой».
  debt_amount INTEGER NOT NULL DEFAULT 0 CHECK (debt_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_balance_entries (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  -- debt_accrued  — период ушёл в минус, долг вырос;
  -- debt_settled  — начисления периода погасили часть/весь долг.
  kind TEXT NOT NULL CHECK (kind IN ('debt_accrued', 'debt_settled')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Один и тот же период не может дважды начислить или дважды погасить долг.
  UNIQUE (restaurant_id, settlement_period_id, kind)
);
CREATE INDEX IF NOT EXISTS ix_restaurant_balance_entries_restaurant
  ON restaurant_balance_entries (restaurant_id, id);

-- Проводка — финансовая запись: не переписывается и не удаляется.
DROP TRIGGER IF EXISTS trg_restaurant_balance_entries_immutable ON restaurant_balance_entries;
CREATE TRIGGER trg_restaurant_balance_entries_immutable
BEFORE UPDATE OR DELETE ON restaurant_balance_entries
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Итоги переноса в строке периода — чтобы документ, UI и выплата читались из
-- ОДНОЙ строки и не пересчитывали ledger заново.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS carry_forward_applied INTEGER NOT NULL DEFAULT 0
  CHECK (carry_forward_applied >= 0);
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS carry_forward_remaining INTEGER NOT NULL DEFAULT 0
  CHECK (carry_forward_remaining >= 0);

-- payable_amount теперь НИКОГДА не отрицателен: минус превращается в долг и
-- уезжает в ledger, а не остаётся в строке периода отрицательным числом,
-- которое всё равно нельзя выплатить.
--
--   начислено   = restaurant_earnings
--   сторно      = refund_adjustment_restaurant_amount
--   удержание   = carry_forward_applied
--   к выплате   = GREATEST(0, начислено − сторно − удержание)
--
-- Старое ограничение (без carry-forward) снимается: оно требовало точного
-- равенства и запрещало бы перенос.
ALTER TABLE settlement_restaurant_lines
  DROP CONSTRAINT IF EXISTS chk_srl_payable_matches_adjustments;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_srl_payable_matches_carry_forward') THEN
    ALTER TABLE settlement_restaurant_lines
      ADD CONSTRAINT chk_srl_payable_matches_carry_forward
      CHECK (payable_amount = GREATEST(
        0,
        restaurant_earnings - refund_adjustment_restaurant_amount - carry_forward_applied
      ));
  END IF;
END $$;

-- payout_blocked_reason пересобирается: выплата запрещена и при нулевой сумме
-- (платить нечего), и при непогашенном долге.
ALTER TABLE settlement_restaurant_lines DROP COLUMN IF EXISTS payout_blocked_reason;
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS payout_blocked_reason TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN carry_forward_remaining > 0 THEN 'outstanding_debt'
      WHEN payable_amount <= 0 THEN 'nothing_payable'
      ELSE NULL
    END
  ) STORED;

-- -------------------------------------------------------------------------
-- settlement_document_access_tokens — capability-доступ ресторана к ОДНОМУ документу
-- -------------------------------------------------------------------------
--
-- Ресторан не имеет и не должен иметь HQ-сессии. Документ при этом содержит
-- юридические реквизиты и полную финансовую разбивку — публичным он быть не
-- может. Решение: capability-токен ровно на ОДИН документ, тот же принцип,
-- что уже применён в order_share_tokens и order_access_credentials.
--
-- В БД лежит ТОЛЬКО sha256-хэш: утечка дампа не даёт рабочих ссылок.
-- Токен привязан и к document_id, и к restaurant_id — расхождение между ними
-- (документ другого ресторана) делает токен нерабочим, даже если он валиден.
CREATE TABLE IF NOT EXISTS settlement_document_access_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash BYTEA NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  document_id INTEGER NOT NULL REFERENCES settlement_documents(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS ix_settlement_document_access_tokens_document
  ON settlement_document_access_tokens (document_id);

-- =========================================================================
-- YAAM HQ Stage 14 — юридические данные YAAM и фискальные чеки
-- =========================================================================

-- -------------------------------------------------------------------------
-- yaam_legal_details — юридические данные самой YAAM (singleton)
-- -------------------------------------------------------------------------
--
-- ЗАЧЕМ ОТДЕЛЬНО ОТ yaam_bank_details. Там лежат ПЛАТЁЖНЫЕ реквизиты (счёт,
-- БИК, банк) — они меняются при смене банка и не имеют отношения к тому, кто
-- такое YAAM юридически. Здесь — сведения о лице: ИП, его ФИО, ИНН, ОГРНИП,
-- адрес. Смешивать их в одной таблице значило бы, что смена банка выглядит
-- как смена юридического лица.
--
-- Форма бизнеса — ИП (подтверждено пользователем). Полей для ООО тут нет
-- намеренно: их незачем поддерживать, пока их не существует. КПП у ИП не
-- бывает вовсе — он остался только в yaam_bank_details, где нужен банку.
--
-- PENDING LEGAL. Правовая необходимость части полей в отчёте агента НЕ
-- подтверждена юристом (см. итоговый отчёт Stage 14):
--   registration_date  — дата регистрации ИП;
--   contact_email / contact_phone — рабочие контакты.
-- Поэтому они NULLABLE и НЕ обязательны в форме: делать поле обязательным
-- без правового основания — значит выдумать требование. Как только основание
-- появится, ограничение добавляется отдельной задачей.
CREATE TABLE IF NOT EXISTS yaam_legal_details (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- «ИП Иванов Иван Иванович» — то, что печатается в документах.
  legal_name TEXT NOT NULL CHECK (btrim(legal_name) <> ''),
  -- ФИО предпринимателя отдельно: в некоторых формулировках нужно именно оно.
  entrepreneur_name TEXT NOT NULL CHECK (btrim(entrepreneur_name) <> ''),
  inn TEXT NOT NULL,                      -- 12 цифр для ИП (services/hq/ruRequisites.js)
  ogrnip TEXT NOT NULL,                   -- 15 цифр
  registration_address TEXT NOT NULL CHECK (btrim(registration_address) <> ''),
  -- PENDING LEGAL, см. выше.
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  registration_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Снимок юридических данных YAAM в строке расчётного периода. Stage 13 уже
-- снимал legal_name/inn/kpp из yaam_bank_details; теперь появился настоящий
-- источник, и снимок дополняется недостающими полями.
--
-- Колонки NULLABLE: у периодов, закрытых до этой правки, снимка нет, и
-- документ честно покажет отсутствие данных, а не подставит сегодняшние.
-- Старые периоды НЕ пересчитываются.
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_ogrnip_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_address_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_entrepreneur_name_snapshot TEXT;

-- -------------------------------------------------------------------------
-- fiscal_receipts — фискальные чеки (54-ФЗ)
-- -------------------------------------------------------------------------
--
-- СТАТУС: техническая основа, НЕ подключённая ни к какой реальной кассе.
-- Кто именно обязан пробивать чек в агентской модели YAAM и какие реквизиты
-- поставщика в нём обязательны — вопрос юридический и НЕ решён (BLOCKED
-- LEGAL, см. итоговый отчёт). Эта таблица не утверждает ответ: она даёт
-- безопасную границу, за которой конкретный провайдер подключается позже.
--
-- ПОЧЕМУ PAYLOAD — СНИМОК. Чек обязан отражать то, что человек купил В МОМЕНТ
-- ОПЛАТЫ. Если строить позиции из текущего меню, то переименование блюда или
-- смена цены задним числом изменили бы уже пробитый чек. Поэтому payload
-- собирается из order_items/orders/поставщика и фиксируется здесь навсегда.
--
-- IDEMPOTENCY. Один платёж — один чек прихода, один возврат — один чек
-- возврата. Это выражено частичными UNIQUE-индексами ниже, а не проверкой в
-- коде: повторный вызов при гонке обязан упереться в базу.
CREATE TABLE IF NOT EXISTS fiscal_receipts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  payment_id INTEGER REFERENCES payments(id),
  refund_id INTEGER REFERENCES refunds(id),
  provider TEXT NOT NULL,
  provider_receipt_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  -- Чек прихода привязан к платежу, чек возврата — к возврату. Смешение
  -- означало бы, что мы не знаем, за что пробит чек.
  CHECK (
    (kind = 'payment' AND payment_id IS NOT NULL AND refund_id IS NULL)
    OR (kind = 'refund' AND refund_id IS NOT NULL)
  ),
  -- Терминальные статусы обязаны иметь момент завершения, нетерминальные — нет.
  CHECK (
    (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'processing') AND completed_at IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fiscal_receipts_payment
  ON fiscal_receipts (payment_id) WHERE kind = 'payment';
CREATE UNIQUE INDEX IF NOT EXISTS ux_fiscal_receipts_refund
  ON fiscal_receipts (refund_id) WHERE kind = 'refund';
CREATE INDEX IF NOT EXISTS ix_fiscal_receipts_status ON fiscal_receipts (status, id);
CREATE INDEX IF NOT EXISTS ix_fiscal_receipts_order ON fiscal_receipts (order_id);

-- payload и связи чека неизменяемы: меняться могут только статус, попытки,
-- ошибка, идентификатор провайдера и временные метки. Иначе «пробитый чек»
-- можно было бы переписать задним числом.
CREATE OR REPLACE FUNCTION fn_fiscal_receipts_payload_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'fiscal receipt payload and links are immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiscal_receipts_payload_immutable ON fiscal_receipts;
CREATE TRIGGER trg_fiscal_receipts_payload_immutable
BEFORE UPDATE ON fiscal_receipts
FOR EACH ROW
EXECUTE FUNCTION fn_fiscal_receipts_payload_immutable();

-- -------------------------------------------------------------------------
-- Аудит: события еженедельного закрытия и документов
-- -------------------------------------------------------------------------
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
  'settlement_period_created', 'settlement_period_closed', 'settlement_period_draft_deleted',
  'payout_created', 'payout_processing', 'payout_succeeded', 'payout_failed',
  'payout_attempt_created', 'payout_attempt_processing', 'payout_attempt_unknown',
  'payout_attempt_succeeded', 'payout_attempt_failed',
  'yaam_bank_details_created', 'yaam_bank_details_updated',
  'restaurant_payout_prepared',
  -- Еженедельное автозакрытие (задание, раздел 13).
  'settlement_job_started', 'settlement_job_finished', 'settlement_job_failed',
  'settlement_period_catch_up', 'settlement_period_close_skipped',
  -- Документы периода.
  'settlement_document_created', 'settlement_document_failed',
  'settlement_document_corrected',
  -- Уведомление ресторана в Telegram.
  'yaam_legal_details_updated',
  'yaam_bank_details_updated',
  'owner_password_changed',
  'owner_password_change_rejected',
  'fiscal_receipt_created',
  'fiscal_receipt_succeeded',
  'fiscal_receipt_failed',
  'fiscal_receipt_retried',
  'settlement_backlog_queued',
  'settlement_backlog_deferred',
  'settlement_carry_forward_applied',
  'settlement_carry_forward_accrued',
  'settlement_document_token_issued',
  'settlement_document_token_used',
  'settlement_document_token_revoked',
  'settlement_document_token_rejected',
  'settlement_adjustment_created',
  'settlement_notification_sent', 'settlement_notification_failed'
));

COMMIT;

-- -------------------------------------------------------------------------
-- hq_sessions — хранилище сессий HQ (Stage 15)
-- -------------------------------------------------------------------------
--
-- Заменяет MemoryStore express-session: тот жил в памяти процесса, поэтому
-- перезапуск разлогинивал владельца, истёкшие записи не удалялись, а два
-- процесса не видели сессии друг друга.
--
-- Пароля здесь нет: в сессии хранятся hqUser, credentials_version и
-- CSRF-токен. Обслуживается services/hq/pgSessionStore.js.
CREATE TABLE IF NOT EXISTS hq_sessions (
  sid TEXT PRIMARY KEY,
  sess JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_hq_sessions_expires ON hq_sessions (expires_at);
