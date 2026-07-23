-- YAAM MVP schema. SQLite. Держим плоско и просто — без лишних абстракций под масштаб, которого ещё нет.

CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cuisine TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  cities TEXT NOT NULL DEFAULT '[]',       -- JSON-массив строк, напр. ["Грозный","Аргун"]
  address TEXT NOT NULL DEFAULT '',        -- точка самовывоза, показывается клиенту при выборе "Самовывоз"
  hours TEXT NOT NULL DEFAULT '',          -- "10:00–23:00"
  delivery_price INTEGER NOT NULL DEFAULT 0,
  min_order INTEGER NOT NULL DEFAULT 0,
  is_open INTEGER NOT NULL DEFAULT 1,      -- ручной тумблер "Перерыв" (плюс часы работы влияют отдельно)
  paused_until TEXT,                        -- если задано — перерыв снимается сам по истечении (см. orderService.sweepPauseExpiry)
  is_new INTEGER NOT NULL DEFAULT 1,
  rating REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  phone TEXT NOT NULL DEFAULT '',           -- показывается клиенту только на экране статуса ПОСЛЕ оформления заказа
  default_cook_minutes INTEGER NOT NULL DEFAULT 40, -- своё для каждого ресторана; от него бот предлагает 3 варианта на шаге "Готовится"
  telegram_chat_id TEXT,                    -- заполняется, когда ресторан подключил бота по коду
  connect_code TEXT UNIQUE,                 -- одноразовый код для привязки бота
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  photo_url TEXT NOT NULL DEFAULT '',
  weight_g INTEGER,
  kcal INTEGER, protein_g INTEGER, fat_g INTEGER, carbs_g INTEGER,
  composition TEXT NOT NULL DEFAULT '',
  is_popular INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,  -- стоп-лист переключает это
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_code TEXT NOT NULL UNIQUE,          -- "YAAM-00001" (id с отступом минимум до 5 цифр), отдаём клиенту
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  city TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address TEXT NOT NULL,
  fulfillment_type TEXT NOT NULL DEFAULT 'delivery', -- 'delivery' | 'pickup' — выбор клиента при оформлении
  comment TEXT NOT NULL DEFAULT '',
  items_total INTEGER NOT NULL,              -- сумма блюд, руб. Комиссия YAAM считается от неё.
  commission_amount INTEGER NOT NULL,        -- 7% на момент создания заказа (фиксируем, а не пересчитываем задним числом)
  -- Ровно 10 допустимых значений — тот же список, что и в комментарии ниже,
  -- продублирован в CHECK намеренно (см. server/db/index.js —
  -- ORDERS_STATUS_CHECK_VALUES обязана оставаться идентичной этому списку,
  -- используется миграцией для legacy-БД, у которых это ограничение ещё не
  -- добавлено). Раньше orders.status был единственной статусной колонкой во
  -- всей схеме без CHECK (payments/refunds/payment_initial_attempts/
  -- payment_retry_attempts его всегда имели) — независимый аудит подтвердил,
  -- что БД принимает произвольную строку без единой проверки.
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK(status IN (
      'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier',
      'delivered', 'payment_failed', 'declined', 'timed_out', 'cancelled'
    )),
  -- статусы: awaiting_payment -> paid(=awaiting_restaurant) -> accepted -> preparing
  --          -> courier -> delivered
  --          | payment_failed | declined | timed_out | cancelled
  status_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rating INTEGER,                             -- 1..5, ставится один раз после delivered
  estimated_ready_minutes INTEGER             -- ресторан выбирает в боте на шаге "Готовится" (см. bot/index.js)
);

-- Секрет доступа к заказу хранится отдельно от отображаемого public_code.
-- Клиент генерирует 256-битный bearer-токен и отдельный ключ идемпотентности;
-- в БД попадают только SHA-256 digest (32 байта), исходные секреты сервер не
-- сохраняет и не может повторно раскрыть. request_hash связывает ключ с точным
-- нормализованным содержимым заказа: изменённый replay не получит старый заказ.
-- Старые заказы без строки в этой таблице намеренно недоступны через публичный
-- API — legacy fallback по одному public_code вернул бы исходную уязвимость.
CREATE TABLE IF NOT EXISTS order_access_credentials (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash) = 32),
  create_key_hash BLOB NOT NULL UNIQUE CHECK(length(create_key_hash) = 32),
  request_hash BLOB NOT NULL CHECK(length(request_hash) = 32),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id),
  name TEXT NOT NULL,   -- снимок названия на момент заказа (меню может измениться позже)
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

-- Отдельная таблица платежей, а не поле в orders: у заказа может быть больше
-- одной попытки оплаты (повторная попытка после payment_failed).
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',      -- 'mock' | 'yookassa' (позже)
  provider_payment_id TEXT,                   -- id платежа во внешней системе
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- creating | pending | succeeded | failed | refunded
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Последовательность повторной оплаты: сначала резервируем одну попытку в БД,
-- затем (уже без открытой SQLite-транзакции) вызываем провайдера и финализируем
-- именно эту строку. Исходный клиентский ключ не сохраняется — только SHA-256.
-- Устойчивый provider_idempotency_key позволяет после сетевого сбоя/рестарта
-- безопасно повторить внешний запрос, не создавая второй платёж у провайдера.
CREATE TABLE IF NOT EXISTS payment_retry_attempts (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating' CHECK(state IN ('creating', 'ready')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Несколько вкладок могут почти одновременно создать разные client keys.
-- Каждый принятый ключ навсегда привязывается к выбранной попытке, поэтому его
-- replay и после завершения платежа не сможет неожиданно создать другую.
CREATE TABLE IF NOT EXISTS payment_retry_keys (
  client_key_hash BLOB PRIMARY KEY CHECK(length(client_key_hash) = 32),
  payment_id INTEGER NOT NULL REFERENCES payment_retry_attempts(payment_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Финансовые инварианты защищены самой БД, а не только JavaScript-проверкой:
-- у заказа не может быть двух одновременно создаваемых/ожидающих платежей,
-- а один внешний payment id нельзя прикрепить к двум нашим попыткам.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_active_per_order
  ON payments(order_id) WHERE status IN ('creating', 'pending');
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_reference
  ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payment_retry_keys_payment
  ON payment_retry_keys(payment_id);

-- Безопасные данные, необходимые клиенту для продолжения уже созданной
-- платёжной попытки после потерянного HTTP-ответа. Внутренний id провайдера
-- остаётся только в payments; наружу после bearer-проверки возвращаются лишь
-- payment_url/qr_payload. Отдельная таблица делает изменение аддитивным для
-- существующей SQLite-БД и не требует ALTER TABLE.
CREATE TABLE IF NOT EXISTS payment_presentations (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  payment_url TEXT,
  qr_payload TEXT,
  -- Stage 11A follow-up: неизменяемый серверный срок оплаты, тот же принцип,
  -- что и в PostgreSQL-схеме (см. комментарий там). Никакой ALTER TABLE
  -- здесь не нужен — нет живой SQLite production БД со старыми строками;
  -- локальная/тестовая БД пересоздаётся npm run seed.
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Первоначальный платёж создаётся после того, как заказ уже зафиксирован в БД.
-- Этот ledger хранит устойчивый серверный ключ внешней операции, чтобы после
-- сетевого сбоя или рестарта повторить createPayment с тем же ключом, а не
-- создать второй платёж у провайдера. Клиентский create-key остаётся только в
-- order_access_credentials и никогда не передаётся платёжному провайдеру.
CREATE TABLE IF NOT EXISTS payment_initial_attempts (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating' CHECK(state IN ('creating', 'ready')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Возврат — отдельная сущность, не поле payments: у одного платежа может быть
-- больше одной попытки возврата за всю историю (сначала неудачная, потом,
-- когда-нибудь в будущем, повторная — уже не автоматически в этой версии).
-- requested/processing — durable-резервация до сетевого вызова
-- провайдера (тот же принцип, что payment_initial_attempts); succeeded/failed —
-- терминальны для КОНКРЕТНОЙ строки. failed НЕ порождает новую строку
-- автоматически — это сознательное архитектурное решение этого этапа (см.
-- server/docs/refund-architecture-review.md): у нас нет реального провайдера,
-- значит нет и данных о том, какие причины отказа временные, а какие нет —
-- строить многоступенчатую auto-retry политику вслепую было бы преждевременно.
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',
  amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested', 'processing', 'succeeded', 'failed')),
  reason TEXT NOT NULL CHECK(reason IN ('customer_cancel', 'restaurant_decline', 'timeout')),
  provider_refund_id TEXT,
  provider_idempotency_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error_code TEXT CHECK(last_error_code IS NULL OR last_error_code IN
    ('provider_failed', 'provider_unavailable', 'timeout', 'invariant_violation')),
  last_error_message_safe TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Не более одной незавершённой попытки возврата на платёж одновременно.
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_one_active_per_payment
  ON refunds(payment_id) WHERE status IN ('requested', 'processing');
-- Платёж нельзя успешно вернуть дважды — навсегда блокирует будущие строки.
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_one_succeeded_per_payment
  ON refunds(payment_id) WHERE status = 'succeeded';
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_provider_reference
  ON refunds(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;

-- Партиальные возвраты запрещены для MVP: amount строго равен сумме платежа.
CREATE TRIGGER IF NOT EXISTS trg_refunds_amount_matches_payment
BEFORE INSERT ON refunds
WHEN NEW.amount <> (SELECT amount FROM payments WHERE id = NEW.payment_id)
BEGIN
  SELECT RAISE(ABORT, 'refund amount must equal payment amount (full-refund-only for MVP)');
END;

-- DB-backstop поверх reserveRefundRow(): partial-индекс сам по себе не мешает
-- вставить НОВУЮ requested-строку, если уже есть succeeded (индекс применяется
-- только к строкам со status='succeeded', не к вставляемой requested-строке).
CREATE TRIGGER IF NOT EXISTS trg_refunds_block_after_succeeded
BEFORE INSERT ON refunds
WHEN EXISTS (SELECT 1 FROM refunds WHERE payment_id = NEW.payment_id AND status = 'succeeded')
BEGIN
  SELECT RAISE(ABORT, 'refunds: payment already successfully refunded');
END;

-- payment_id/amount/provider/reason/provider_idempotency_key фиксируются один
-- раз при создании строки и не должны меняться никаким UPDATE — это финансовые
-- факты конкретной попытки, а не изменяемое состояние.
CREATE TRIGGER IF NOT EXISTS trg_refunds_immutable_fields
BEFORE UPDATE ON refunds
WHEN NEW.payment_id <> OLD.payment_id
  OR NEW.amount <> OLD.amount
  OR NEW.provider <> OLD.provider
  OR NEW.reason <> OLD.reason
  OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'refunds: payment_id/amount/provider/reason/provider_idempotency_key are immutable');
END;
