'use strict';

// YAAM HQ Stage 4 — журнал административных изменений (hq_audit_log,
// db/postgresql/schema.sql). Единственное место, которое пишет в эту
// таблицу — как и services/hq/securityLog.js (Stage 3), ошибка записи в лог
// НИКОГДА не должна ронять реальное действие (создание/правку/паузу/
// архивирование ресторана) — поэтому эта функция сама ловит свои ошибки.
const db = require('../../db/postgresql');

const ACTIONS = [
  'restaurant_created',
  'restaurant_updated',
  'restaurant_paused',
  'restaurant_resumed',
  'restaurant_archived',
  'restaurant_restored',
];

// Единственные поля ресторана, которые вообще могут попасть в текст лога —
// тот же allowlist-принцип, что и PUBLIC_RESTAURANT_FIELDS в routes/
// postgresql/api.js: connect_code/telegram_chat_id физически не могут сюда
// попасть, даже если вызывающий код по ошибке передаст весь объект.
const SAFE_DIFF_FIELDS = [
  'name', 'cuisine', 'description', 'cities', 'address', 'hours',
  'min_order', 'phone', 'is_open',
];

async function logAuditEvent({ action, restaurantId, details, ip }) {
  if (!ACTIONS.includes(action)) {
    console.error(`[hq-audit-log] неизвестный action: "${action}"`);
    return;
  }
  try {
    await db.query(
      'INSERT INTO hq_audit_log (action, restaurant_id, details, ip) VALUES ($1, $2, $3, $4)',
      [action, restaurantId ?? null, details ?? null, ip || null],
    );
  } catch (err) {
    console.error(`[hq-audit-log] не удалось записать событие "${action}":`, err.message);
  }
}

// Короткий человекочитаемый summary изменённых полей — только из
// SAFE_DIFF_FIELDS, только реально изменившиеся значения. Используется для
// details у restaurant_updated. before/after — обычные строки ресторана из
// БД (snake_case), не DTO.
function summarizeRestaurantDiff(before, after) {
  const parts = [];
  for (const field of SAFE_DIFF_FIELDS) {
    const oldValue = before[field];
    const newValue = after[field];
    if (String(oldValue ?? '') === String(newValue ?? '')) continue;
    parts.push(`${field}: "${oldValue ?? ''}" -> "${newValue ?? ''}"`);
  }
  return parts.length ? parts.join('; ') : null;
}

module.exports = { logAuditEvent, summarizeRestaurantDiff, ACTIONS, SAFE_DIFF_FIELDS };
