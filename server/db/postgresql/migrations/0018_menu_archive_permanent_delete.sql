-- 0018_menu_archive_permanent_delete — окончательное удаление из архива меню.
--
-- Миграция затрагивает ТОЛЬКО allowlist hq_audit_log.action: экран «Архив
-- меню» получает необратимое удаление блюда/категории, и это действие обязано
-- оставлять след в аудите. Ни одна таблица данных не меняется — вся механика
-- удаления опирается на уже существующие внешние ключи:
--   menu_item_photos.menu_item_id        -> menu_items  ON DELETE CASCADE
--   order_items.menu_item_id             -> menu_items  nullable, БЕЗ ON DELETE
--   menu_items.category_id               -> categories  ON DELETE CASCADE
--   menu_items.archived_with_category_id -> categories  БЕЗ ON DELETE
-- Сервисный слой (services/hq/menuAdminService.js) снимает две последние
-- ссылки явно, в одной транзакции, поэтому ни осиротевших строк, ни падения
-- на FK не остаётся. История заказов не теряется: order_items хранит
-- собственный снимок name/price/qty, обнуляется только ссылка на удалённое
-- блюдо (колонка изначально объявлена nullable именно под этот случай).
--
-- Список ниже — ПОЛНЫЙ действующий allowlist из миграции 0005 (последней,
-- которая его переопределяла) плюс два новых значения. Именно полный, а не
-- «только новые»: CHECK нельзя дополнить, его можно только заменить целиком,
-- и любое выпавшее из списка значение немедленно сломало бы применение
-- миграции на базе, где такие строки аудита уже есть.
--
-- Rollback: значения можно убрать обратно тем же DROP+ADD только после
-- удаления соответствующих строк аудита — иначе новый CHECK не пройдёт
-- валидацию существующих данных.
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
