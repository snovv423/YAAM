'use strict';

// YAAM Stage 22 — реестр отвергнутых webhook (закрытие MEDIUM-4).
//
// ЗАЧЕМ. Отвергнутое уведомление раньше оставляло только строку в
// console.error. Ошибка конфигурации — например, устаревший IP-allowlist —
// молча отвергала бы КАЖДЫЙ платёж, и единственным следом были бы строки в
// журнале, которые никто не читает. Это прямой путь к потере денег.
//
// ЧТО ХРАНИТСЯ. Ровно то, что нужно для разбора: провайдер, тип события,
// причина отказа, отпечаток тела, идентификатор объекта у провайдера (если он
// безопасно разобрался), HTTP-код, время, счётчик повторов, request id и
// состояние разбора.
//
// ЧТО НЕ ХРАНИТСЯ НИКОГДА: заголовок Authorization, секретные ключи, cookies,
// полные персональные данные, capability-токены, URL формы оплаты и сырое
// тело уведомления целиком. Вместо тела — sha256-отпечаток: он позволяет
// узнать повтор того же уведомления, но ничего не раскрывает.
const db = require('../../db/postgresql');
const { logAuditEvent } = require('../hq/auditLog');

// Причины, которые означают «деньги могли потеряться» и обязаны попасть в
// Центр событий HQ, а не только в реестр.
const CRITICAL_REASONS = new Set([
  'unknown_payment',
  'unknown_refund',
  'amount_mismatch',
  'currency_mismatch',
  'refund_identity_mismatch',
  'untrusted_source',
  'unverifiable',
  'succeeded_for_inactive_attempt',
]);

// Первые сколько-то повторов одной и той же проблемы стоит показать; дальше
// счётчик растёт молча. Одинаковая неизменившаяся ошибка не должна
// превращаться в поток одинаковых событий.
const EVENT_ON_OCCURRENCE = 1;

function safeDetail(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/yaam_[a-z_]*v1_[A-Za-z0-9_-]+/g, '<token>')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

// Регистрирует факт отказа. Повтор того же уведомления с той же причиной не
// создаёт вторую строку — увеличивает счётчик и обновляет время.
async function record({
  provider = 'unknown',
  eventType = 'unknown',
  reason,
  payloadFingerprint,
  providerObjectId = null,
  httpStatus,
  detailSafe = '',
  requestId = null,
}) {
  if (!reason || !payloadFingerprint || !httpStatus) {
    // Наблюдаемость не имеет права ронять обработку webhook.
    console.error('[webhookRejections] неполные данные для регистрации отказа');
    return { recorded: false, reason: 'invalid_input' };
  }

  try {
    const rows = await db.execute(
      `INSERT INTO webhook_rejections
         (provider, event_type, reason, payload_fingerprint, provider_object_id,
          http_status, detail_safe, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider, reason, payload_fingerprint) DO UPDATE
         SET occurrence_count = webhook_rejections.occurrence_count + 1,
             last_seen_at = NOW(),
             request_id = EXCLUDED.request_id
       RETURNING *`,
      [provider, eventType, reason, payloadFingerprint, providerObjectId,
        httpStatus, safeDetail(detailSafe), requestId],
    );
    const row = rows.rows[0];

    if (row.occurrence_count === EVENT_ON_OCCURRENCE) {
      await logAuditEvent({
        action: 'webhook_rejected', restaurantId: null,
        details: `${provider}/${eventType}: ${reason} (HTTP ${httpStatus})`, ip: null,
      });
      if (CRITICAL_REASONS.has(reason)) await reportCriticalEvent(row);
    }
    return { recorded: true, rejection: row };
  } catch (err) {
    console.error('[webhookRejections] не удалось зарегистрировать отказ:', err.message);
    return { recorded: false, reason: 'write_failed' };
  }
}

const REASON_LABELS = {
  untrusted_source: 'уведомление пришло с недоверенного адреса',
  unverifiable: 'уведомление не подтверждено каноническим запросом к провайдеру',
  unsupported_event: 'тип события не поддерживается',
  unknown_payment: 'платёж провайдера неизвестен нашей базе',
  unknown_refund: 'возврат провайдера неизвестен нашей базе',
  amount_mismatch: 'сумма уведомления не совпала с нашей записью',
  currency_mismatch: 'валюта уведомления не совпала',
  refund_identity_mismatch: 'возврат не соответствует платежу',
  succeeded_for_inactive_attempt: 'подтверждён успех по неактивной попытке оплаты',
  internal_error: 'внутренняя ошибка обработки уведомления',
};

async function reportCriticalEvent(row) {
  try {
    const eventLogService = require('../hq/eventLogService');
    await eventLogService.createEvent({
      category: 'payment_issue',
      message: `Платёжное уведомление отклонено: ${REASON_LABELS[row.reason] || row.reason}. `
        + 'Требуется разбор — деньги могли быть списаны без учёта.',
    });
  } catch (err) {
    console.error('[webhookRejections] не удалось записать событие:', err.message);
  }
}

async function listNeedsReview({ limit = 50 } = {}) {
  return db.query(
    `SELECT * FROM webhook_rejections WHERE state = 'needs_review'
      ORDER BY last_seen_at DESC LIMIT $1`,
    [limit],
  );
}

async function resolve(id, note) {
  const rows = await db.execute(
    `UPDATE webhook_rejections
        SET state = 'resolved', resolved_at = NOW(), resolution_note = $2
      WHERE id = $1 AND state = 'needs_review' RETURNING *`,
    [id, safeDetail(note)],
  );
  return rows.rows[0] || null;
}

module.exports = {
  CRITICAL_REASONS,
  REASON_LABELS,
  safeDetail,
  record,
  listNeedsReview,
  resolve,
};
