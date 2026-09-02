-- 0019_app_settings — постоянное хранилище редактируемых настроек приложения.
--
-- ЗАЧЕМ ОБЩАЯ ТАБЛИЦА, А НЕ ЕЩЁ ОДНА ИМЕННАЯ. yaam_legal_details и
-- yaam_bank_details — таблицы с настоящей структурой: у каждого поля свой тип,
-- свои проверки, своя история использования в документах. Текст на главной —
-- другое по природе: несколько коротких строк, которые владелец правит из HQ и
-- которые больше нигде не участвуют. Заводить под них таблицу с двумя
-- колонками значило бы повторять это упражнение при каждой следующей такой
-- строке; общий key/value закрывает весь класс сразу.
--
-- Значение хранится текстом и без DEFAULT: отсутствие строки означает «владелец
-- ничего не менял», и приложение берёт свой встроенный текст (см.
-- services/hq/homeContentService.js). Так пустая база и база с настройками
-- ведут себя одинаково предсказуемо.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rollback: таблица самостоятельна, ни одна другая на неё не ссылается —
-- DROP TABLE app_settings; вернёт встроенные тексты, ничего больше не задев.

-- =========================================================================
-- Новое событие аудита: правка текста главной
-- =========================================================================
-- Список ниже — ПОЛНЫЙ действующий allowlist из миграции 0018 плюс одно новое
-- значение: CHECK нельзя дополнить, его можно только заменить целиком.
ALTER TABLE hq_audit_log DROP CONSTRAINT IF EXISTS hq_audit_log_action_check;
ALTER TABLE hq_audit_log ADD CONSTRAINT hq_audit_log_action_check CHECK (action IN (
  'restaurant_created', 'restaurant_updated', 'restaurant_paused',
  'restaurant_resumed', 'restaurant_archived', 'restaurant_restored',
  'restaurant_published', 'restaurant_unpublished',
  'category_created', 'category_updated', 'category_archived',
  'category_restored', 'category_moved', 'category_deleted',
  'menu_item_created', 'menu_item_updated', 'menu_item_available',
  'menu_item_unavailable', 'menu_item_archived', 'menu_item_restored',
  'menu_item_moved', 'menu_item_deleted',
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
  'home_content_updated',
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
