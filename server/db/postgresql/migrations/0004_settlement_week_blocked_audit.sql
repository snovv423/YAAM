-- 0004_settlement_week_blocked_audit — новое событие аудита
-- 'settlement_week_blocked' (Stage 19.1, пункт 4).
--
-- ЗАЧЕМ. Детектор недель в weeklySettlementService сравнивал недели с уже
-- существующими периодами по РАВЕНСТВУ period_from, а ограничение базы
-- settlement_periods_no_overlap считает по ПЕРЕСЕЧЕНИЮ диапазонов
-- (EXCLUDE USING gist (daterange(period_from, period_to, '[]') WITH &&)).
-- Из-за этого расхождения неделя, внутри которой лежит период с другой
-- границей (например, однодневный период, созданный вручную), считалась
-- «не существующей», ставилась в очередь, отвергалась ограничением — и job
-- писал одну и ту же ошибку при каждом запуске, то есть каждые 15 минут.
--
-- Теперь такая неделя не ставится в очередь, а фиксируется как состояние,
-- требующее решения владельца. Событию нужно место в CHECK-ограничении
-- hq_audit_log: список действий задан явным перечислением.
--
-- ЧТО ЭТА МИГРАЦИЯ НЕ ДЕЛАЕТ. Не создаёт, не удаляет и не изменяет ни одного
-- расчётного периода, ни одной строки расчёта и ни одной выплаты. Финансовая
-- логика не затрагивается: меняется только допустимый набор значений в
-- журнале аудита.
--
-- ОБРАТИМОСТЬ. Откат — вернуть предыдущий список действий; строки с новым
-- значением при этом придётся удалить, потому что старое ограничение их не
-- допускает. Иных зависимостей у миграции нет.

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
  -- Новое значение этой миграции.
  'settlement_week_blocked',
  'settlement_carry_forward_applied',
  'settlement_carry_forward_accrued',
  'settlement_document_token_issued',
  'settlement_document_token_used',
  'settlement_document_token_revoked',
  'settlement_document_token_rejected',
  'settlement_adjustment_created',
  'settlement_notification_sent', 'settlement_notification_failed'
));
