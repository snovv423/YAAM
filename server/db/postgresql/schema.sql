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

-- =========================================================================
-- categories
-- =========================================================================
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

COMMIT;
