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
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  -- статусы: awaiting_payment -> paid -> awaiting_restaurant -> accepted -> preparing
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
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | succeeded | failed | refunded
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Безопасные данные, необходимые клиенту для продолжения уже созданной
-- платёжной попытки после потерянного HTTP-ответа. Внутренний id провайдера
-- остаётся только в payments; наружу после bearer-проверки возвращаются лишь
-- payment_url/qr_payload. Отдельная таблица делает изменение аддитивным для
-- существующей SQLite-БД и не требует ALTER TABLE.
CREATE TABLE IF NOT EXISTS payment_presentations (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  payment_url TEXT,
  qr_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
