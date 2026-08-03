-- 0005_financial_runtime_safety — закрытие финансовых блокеров Stage 21.
--
-- Миграция АДДИТИВНА: ни одна существующая колонка не удаляется и не меняет
-- тип, ни одна строка не переписывается. Старый код продолжает работать с
-- этой схемой — новые колонки либо nullable, либо имеют DEFAULT.
--
-- Содержание:
--   1. сверка платежей с провайдером (CRITICAL-1) — состояние попыток;
--   2. дубль успешного платежа (HIGH-1) — модель + защита на уровне БД;
--   3. полный возврат (HIGH-2) — инвариант «возврат = сумма платежа»;
--   4. реестр отвергнутых webhook (MEDIUM-4);
--   5. конкурентно безопасная нумерация документов (MEDIUM-1);
--   6. новые действия аудита.

-- =========================================================================
-- 1. СВЕРКА ПЛАТЕЖЕЙ С ПРОВАЙДЕРОМ
-- =========================================================================
--
-- Потерянный webhook раньше не обнаруживался ничем: платёж навсегда оставался
-- 'pending', заказ — 'awaiting_payment', деньги покупателя выпадали из учёта.
-- Эти колонки — состояние периодической сверки, тот же приём, что уже
-- работает для возвратов (refunds.attempt_count/next_attempt_at).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reconcile_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (reconcile_attempt_count >= 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
-- Момент следующей допустимой проверки. NULL = «проверять как только платёж
-- станет старше порога»; заполняется при временной ошибке провайдера, чтобы
-- не долбить недоступный API каждые несколько секунд.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_reconcile_error_code TEXT
  CHECK (last_reconcile_error_code IS NULL OR last_reconcile_error_code IN
    ('retryable', 'not_found', 'unknown_result', 'terminal', 'invariant_violation'));
-- Обезличенное сообщение: ни ключей, ни URL оплаты, ни ПДн.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_reconcile_error_safe TEXT;

-- Выборка «что сверять» без полного скана: только незавершённые платежи.
CREATE INDEX IF NOT EXISTS ix_payments_reconcile_due
  ON payments (next_check_at, created_at)
  WHERE status IN ('creating', 'pending');

-- =========================================================================
-- 2. ДУБЛЬ УСПЕШНОГО ПЛАТЕЖА
-- =========================================================================
--
-- Раньше поздний succeeded по неактивной попытке молча игнорировался
-- (markPaid выходил через `if (!payment) return`). Покупатель мог заплатить
-- дважды, а в системе оставался один платёж — без следа и без алерта.
--
-- МОДЕЛЬ. Каноническая правда провайдера сохраняется целиком: дубль
-- записывается как настоящий успешный платёж, но ПОМЕЧАЕТСЯ ссылкой на тот
-- платёж, который он дублирует. Обе операции остаются прослеживаемыми.
--
-- Почему не «уникальный индекс, который просто бросает ошибку»: тогда факт
-- денег у провайдера снова терялся бы — ровно тот дефект, который чинится.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS duplicate_of_payment_id INTEGER
  REFERENCES payments(id);
-- Платёж не может дублировать сам себя.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_duplicate_not_self;
ALTER TABLE payments ADD CONSTRAINT chk_payments_duplicate_not_self
  CHECK (duplicate_of_payment_id IS NULL OR duplicate_of_payment_id <> id);

-- ГЛАВНЫЙ ИНВАРИАНТ: у заказа не более ОДНОГО учитываемого расчётного
-- платежа. 'refunded' входит в список намеренно — возвращённый платёж всё
-- равно занимает место канонического, иначе после возврата можно было бы
-- завести второй «нормальный» платёж на тот же заказ.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_one_counted_per_order
  ON payments (order_id)
  WHERE duplicate_of_payment_id IS NULL AND status IN ('succeeded', 'refunded');

CREATE INDEX IF NOT EXISTS ix_payments_duplicate_of
  ON payments (duplicate_of_payment_id) WHERE duplicate_of_payment_id IS NOT NULL;

-- Возврат лишнего списания — своя причина. Без неё дубль возвращался бы под
-- чужим предлогом и был бы неотличим в отчётах от отмены покупателем.
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_reason_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_reason_check
  CHECK (reason IN ('customer_cancel', 'restaurant_decline', 'timeout', 'duplicate_payment'));

-- =========================================================================
-- 3. ПОЛНЫЙ ВОЗВРАТ — УЖЕ ЗАКРЫТ, ИЗМЕНЕНИЙ НЕТ
-- =========================================================================
--
-- Аудит Stage 21 (HIGH-2) утверждал, что инвариант «возврат равен сумме
-- платежа» нигде не закреплён. ЭТО БЫЛО НЕВЕРНО: аудит смотрел только на
-- CHECK у колонки refunds.amount и не заметил два существующих с baseline
-- триггера, которые вместе закрывают все пути:
--
--   trg_refunds_amount_matches_payment (BEFORE INSERT) — частичную строку
--     нельзя создать вообще, ни в каком статусе;
--   trg_refunds_immutable_fields (BEFORE UPDATE) — amount, payment_id,
--     provider, reason и ключ идемпотентности неизменяемы, поэтому уже
--     созданную полную строку нельзя превратить в частичную;
--   ux_refunds_one_succeeded_per_payment — второй успешный возврат
--     невозможен.
--
-- Добавлять сюда третий триггер значило бы продублировать защиту и заодно
-- подменить существующие сообщения об ошибках. Поэтому в этой миграции по
-- пункту 3 НЕТ НИ ОДНОГО ИЗМЕНЕНИЯ — только зафиксированное объяснение.

-- =========================================================================
-- 4. РЕЕСТР ОТВЕРГНУТЫХ WEBHOOK
-- =========================================================================
--
-- Раньше отвергнутое уведомление оставляло только строку в console.error.
-- Ошибка конфигурации (устаревший IP-allowlist) молча отвергала бы все
-- платежи, и единственным следом был бы журнал, который никто не читает.
--
-- ЧТО НЕ ХРАНИТСЯ: Authorization, ключи, cookies, полные ПДн,
-- capability-токены, URL оплаты, сырой payload целиком. Только то, что нужно
-- для разбора.
CREATE TABLE IF NOT EXISTS webhook_rejections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  -- 'payment' | 'refund' | 'unknown' — тип события, если он вообще разобрался.
  event_type TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT NOT NULL CHECK (reason IN (
    'untrusted_source',        -- IP вне allowlist
    'unverifiable',            -- канонический lookup не подтвердил уведомление
    'unsupported_event',       -- тип события не поддерживается
    'unknown_payment',         -- provider_payment_id неизвестен
    'unknown_refund',          -- provider_refund_id неизвестен
    'amount_mismatch',
    'currency_mismatch',
    'refund_identity_mismatch',
    'succeeded_for_inactive_attempt',  -- успех по неактивной попытке
    'internal_error'
  )),
  -- Отпечаток тела: позволяет узнать повтор того же уведомления, не храня
  -- само тело. sha256 в hex.
  payload_fingerprint TEXT NOT NULL CHECK (char_length(payload_fingerprint) = 64),
  -- Идентификатор объекта у провайдера — только если он безопасно разобрался.
  provider_object_id TEXT,
  http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  -- Обезличенное пояснение. Секретов не содержит.
  detail_safe TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  -- Повторы одного и того же уведомления не плодят строки, а увеличивают счётчик.
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 'needs_review' | 'resolved'
  state TEXT NOT NULL DEFAULT 'needs_review' CHECK (state IN ('needs_review', 'resolved')),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  CHECK ((state = 'resolved' AND resolved_at IS NOT NULL) OR (state = 'needs_review' AND resolved_at IS NULL))
);

-- Дедупликация: один и тот же payload с той же причиной — одна строка.
CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_rejections_dedup
  ON webhook_rejections (provider, reason, payload_fingerprint);
CREATE INDEX IF NOT EXISTS ix_webhook_rejections_state
  ON webhook_rejections (state, last_seen_at DESC);

-- =========================================================================
-- 5. КОНКУРЕНТНО БЕЗОПАСНАЯ НУМЕРАЦИЯ ДОКУМЕНТОВ
-- =========================================================================
--
-- nextDocumentNumber() читал последний номер и прибавлял единицу без
-- блокировки. Два одновременных формирования получали ОДИН номер: один
-- INSERT проходил, второй падал на UNIQUE, и документ не создавался вовсе.
--
-- Счётчик с атомарным INSERT ... ON CONFLICT DO UPDATE RETURNING выдаёт
-- номер в той же транзакции и сериализует конкурентов на строке счётчика.
-- UNIQUE на document_number остаётся последней защитой, но перестаёт быть
-- основным алгоритмом.
CREATE TABLE IF NOT EXISTS document_number_counters (
  kind TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, year)
);

-- Перенос уже выданных номеров: счётчик обязан продолжать существующую
-- нумерацию, а не начинать её заново.
INSERT INTO document_number_counters (kind, year, last_number)
SELECT d.kind,
       CAST(split_part(d.document_number, '-', 3) AS INTEGER) AS year,
       MAX(CAST(split_part(split_part(d.document_number, '-', 4), '-', 1) AS INTEGER))
  FROM settlement_documents d
 WHERE d.document_number ~ '^YAAM-[^-]+-[0-9]{4}-[0-9]+'
 GROUP BY 1, 2
ON CONFLICT (kind, year) DO UPDATE
  SET last_number = GREATEST(document_number_counters.last_number, EXCLUDED.last_number);

-- Счётчик попыток формирования документа: повтор нужен, но не бесконечный.
ALTER TABLE settlement_documents ADD COLUMN IF NOT EXISTS generation_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (generation_attempts >= 0);

-- =========================================================================
-- 6. НОВЫЕ ДЕЙСТВИЯ АУДИТА
-- =========================================================================
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
  'settlement_job_started', 'settlement_job_finished', 'settlement_job_failed',
  'settlement_period_catch_up', 'settlement_period_close_skipped',
  'settlement_document_created', 'settlement_document_failed',
  'settlement_document_corrected',
  'yaam_legal_details_updated',
  'owner_password_changed',
  'owner_password_change_rejected',
  'fiscal_receipt_created',
  'fiscal_receipt_succeeded',
  'fiscal_receipt_failed',
  'fiscal_receipt_retried',
  'settlement_backlog_queued',
  'settlement_backlog_deferred',
  'settlement_week_blocked',
  'settlement_carry_forward_applied',
  'settlement_carry_forward_accrued',
  'settlement_document_token_issued',
  'settlement_document_token_used',
  'settlement_document_token_revoked',
  'settlement_document_token_rejected',
  'settlement_adjustment_created',
  'settlement_notification_sent', 'settlement_notification_failed',
  -- Stage 22.
  'payment_reconciled',            -- сверка привела платёж к каноническому статусу
  'payment_reconcile_failed',      -- сверка не удалась (временно или окончательно)
  'payment_duplicate_detected',    -- провайдер подтвердил лишнее списание
  'payment_duplicate_refund_blocked', -- лишнее списание нельзя вернуть автоматически
  'settlement_invariant_violated',
  'settlement_invariant_recovered',
  'webhook_rejected',
  'settlement_document_regenerated'
));
