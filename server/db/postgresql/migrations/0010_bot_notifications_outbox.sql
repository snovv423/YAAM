-- 0010_bot_notifications_outbox — Stage 31, раздел 1.2.
--
-- ПРОБЛЕМА (живая находка Stage 30): order:new отправлялся ОДНИМ прямым
-- вызовом bot.sendMessage() внутри обработчика события, без повтора. Дважды
-- за один живой прогон наблюдался "EFATAL: fetch failed" (сбой транспорта
-- на уровне Node fetch/undici, см. STAGE31 отчёт, раздел 1.1) — ресторан ни
-- разу не узнавал о заказе через бота. Сам заказ не портился (sweepTimeouts
-- всё равно просрочивал его безопасно), но уведомление терялось насовсем:
-- один неудачный fetch навсегда хоронил единственную попытку.
--
-- РЕШЕНИЕ — persistent outbox, тот же принцип, что уже применён для
-- "текущего кликабельного сообщения" (bot_order_messages, миграция 0008) и
-- для fiscal_receipts/payment_retry_attempts: критичное состояние обязано
-- пережить рестарт процесса, а не жить только в памяти. Одна строка —
-- одно логическое уведомление, с устойчивым уникальным ключом
-- (dedup_key = 'order:<id>:new' — задание, раздел 1.2, "стабильный
-- уникальный ключ, например order_id + event_type") — повторный emit того
-- же события (например, дубль-подписка при рестарте в рамках одного
-- процесса) не создаёт вторую строку и не отправляет второе сообщение
-- (см. botOutboxService.enqueue — INSERT ... ON CONFLICT DO NOTHING).
--
-- ПОЧЕМУ НЕ "просто retry внутри обработчика". Retry-цикл ВНУТРИ
-- обработчика события живёт только в памяти текущего процесса — рестарт
-- backend между "заказ создан" и "все попытки исчерпаны" стирает retry-
-- состояние точно так же, как раньше стирался bot_order_messages Map
-- (Stage 28 MEDIUM-2, исправлено миграцией 0008). Строка в этой таблице
-- переживает рестарт: dispatcher (botOutboxService.dispatchPending,
-- запускается отдельным scheduler-тиком) видит незавершённые pending-
-- строки в НОВОМ процессе и продолжает попытки с того места, где они были
-- прерваны — next_attempt_at уже содержит корректное следующее время.
--
-- sent_at — источник истины для ЧЕСТНОГО окна ответа ресторана (задание,
-- раздел 1.3): sweepTimeouts() в orderService.js меряет 7 минут от
-- COALESCE(bot_notifications.sent_at, orders.status_updated_at), а не
-- слепо от status_updated_at — если доставка задержалась retry'ями,
-- ресторан всё равно получает полные обещанные 7 минут ОТ ФАКТИЧЕСКОЙ
-- доставки. Если уведомление так и не доставлено (permanent failure),
-- запасной источник — status_updated_at — не даёт заказу зависнуть
-- бесконечно (граница по-прежнему сработает, просто по факту создания
-- заказа, а не по факту недостижимой доставки).
--
-- Stage 31.1 — эта таблица ЕЩЁ НЕ БЫЛА применена ни на одном реальном
-- окружении (Stage 31 намеренно не деплоила её — только локальные тесты),
-- поэтому два найденных на преддеплойной проверке разрыва дорабатываются
-- ПРЯМО В ЭТОЙ миграции, а не отдельным патчем поверх ещё не выпущенной
-- схемы:
--
--   1. 'processing' — атомарный claim-статус (см. botOutboxService.
--      claimNotification). Без него immediate dispatch (сразу после
--      enqueue) и scheduler-тик могли оба увидеть одну и ту же 'pending'-
--      строку и оба вызвать bot.sendMessage() — UNIQUE(dedup_key) защищает
--      только от ВТОРОЙ СТРОКИ, не от двух конкурентных попыток отправить
--      ОДНУ И ТУ ЖЕ строку. updated_at служит меткой аренды (lease) —
--      отдельная колонка не нужна: строка, застрявшая в 'processing'
--      дольше CLAIM_LEASE_SECONDS (botOutboxService.js), считается
--      брошенной (упавший процесс) и разрешена для повторного claim —
--      "crash не должен навечно оставить notification заблокированной".
--   2. 'skipped' — заказ ушёл из awaiting_restaurant МЕЖДУ enqueue и
--      фактической отправкой (клиент отменил / sweepTimeouts просрочил,
--      пока order:new сидел в retry-backoff). Отправлять "Новый заказ" с
--      рабочими кнопками "Принять"/"Отклонить" для уже решённого заказа
--      нельзя — это НЕ сетевая ошибка (не 'failed', не создаёт
--      telegram_issue), а штатный, ожидаемый исход.
CREATE TABLE IF NOT EXISTS bot_notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  -- JSONB, а не отдельные колонки — это ровно то, что уходит в
  -- reply_markup Telegram-вызова как есть, без промежуточной модели.
  reply_markup JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  sent_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  -- Терминальные статусы обязаны иметь sent_at ИЛИ last_error — тот же
  -- принцип "терминал не бывает немым", что уже применён в fiscal_receipts
  -- (completed_at) этим же проектом. 'skipped' — терминальный, но не
  -- ошибка, поэтому не требует last_error (last_error всё равно пишется
  -- в коде для наблюдаемости, но CHECK не считает его отсутствие браком).
  CHECK (
    (status = 'sent' AND sent_at IS NOT NULL)
    OR (status = 'failed' AND last_error IS NOT NULL)
    OR (status = 'skipped')
    OR (status IN ('pending', 'processing'))
  )
);

-- Dispatcher-тик читает ровно это множество: "готовые попытаться прямо
-- сейчас" pending-строки. Частичный индекс — их всегда мало относительно
-- уже отправленных/провалившихся.
CREATE INDEX IF NOT EXISTS ix_bot_notifications_pending
  ON bot_notifications (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ix_bot_notifications_order
  ON bot_notifications (order_id);
