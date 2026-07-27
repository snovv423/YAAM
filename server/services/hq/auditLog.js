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
  // Stage 4.1
  'restaurant_published',
  'restaurant_unpublished',
  // Stage 5A — меню
  'category_created',
  'category_updated',
  'category_archived',
  'category_restored',
  'category_moved',
  'menu_item_created',
  'menu_item_updated',
  'menu_item_available',
  'menu_item_unavailable',
  'menu_item_archived',
  'menu_item_restored',
  'menu_item_moved',
  // Stage 5B — медиа-система (задание, раздел 12: ровно 10 новых событий).
  'restaurant_photo_uploaded',
  'restaurant_photo_primary_changed',
  'restaurant_photo_moved',
  'restaurant_photo_archived',
  'restaurant_photo_restored',
  'menu_item_photo_uploaded',
  'menu_item_photo_primary_changed',
  'menu_item_photo_moved',
  'menu_item_photo_archived',
  'menu_item_photo_restored',
];

// Единственные поля ресторана, которые вообще могут попасть в текст лога —
// тот же allowlist-принцип, что и PUBLIC_RESTAURANT_FIELDS в routes/
// postgresql/api.js: connect_code/telegram_chat_id физически не могут сюда
// попасть, даже если вызывающий код по ошибке передаст весь объект.
const SAFE_DIFF_FIELDS = [
  'name', 'cuisine', 'description', 'cities', 'address', 'hours',
  'min_order', 'phone', 'is_open',
];

// Stage 5A — тот же allowlist-принцип для блюда. Намеренно БЕЗ composition
// (может быть длинным свободным текстом — задание, раздел 15: "без
// огромного полного состава объекта") и БЕЗ photo_url (задание: "без
// photo_path, если он может раскрыть внутреннее устройство хранилища" —
// консервативно применено и к простой URL-строке этого этапа).
const MENU_ITEM_SAFE_DIFF_FIELDS = [
  'name', 'price', 'description', 'weight_g', 'kcal', 'protein_g', 'fat_g',
  'carbs_g', 'category_id', 'is_available',
];

const CATEGORY_SAFE_DIFF_FIELDS = ['name'];

// Разумный лимит на длину одного значения внутри diff-строки (задание,
// раздел 15/6: "название может журналироваться безопасно с разумным
// лимитом") — обрезает даже allowlist-поля, если значение неожиданно
// длинное (например description, если её когда-нибудь добавят в список).
const DIFF_VALUE_MAX_LEN = 80;

function truncateForLog(value) {
  const str = String(value ?? '');
  return str.length > DIFF_VALUE_MAX_LEN ? `${str.slice(0, DIFF_VALUE_MAX_LEN)}…` : str;
}

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
// переданного allowlist'а, только реально изменившиеся значения,
// каждое значение обрезано truncateForLog(). before/after — обычные строки
// из БД (snake_case), не DTO.
function summarizeDiff(before, after, fields) {
  const parts = [];
  for (const field of fields) {
    const oldValue = before[field];
    const newValue = after[field];
    if (String(oldValue ?? '') === String(newValue ?? '')) continue;
    parts.push(`${field}: "${truncateForLog(oldValue)}" -> "${truncateForLog(newValue)}"`);
  }
  return parts.length ? parts.join('; ') : null;
}

function summarizeRestaurantDiff(before, after) {
  return summarizeDiff(before, after, SAFE_DIFF_FIELDS);
}

function summarizeMenuItemDiff(before, after) {
  return summarizeDiff(before, after, MENU_ITEM_SAFE_DIFF_FIELDS);
}

function summarizeCategoryDiff(before, after) {
  return summarizeDiff(before, after, CATEGORY_SAFE_DIFF_FIELDS);
}

// Stage 5B — фотографии (задание, раздел 12: "Never log: secret keys; full
// signed URLs; internal storage endpoint; binary data"). storage_key
// сознательно НЕ включён — он однозначно определяет объект в реальном
// хранилище, тот же консервативный принцип, что уже применён к photo_url в
// MENU_ITEM_SAFE_DIFF_FIELDS выше. Только id фотографии и безопасный
// alt_text (обычный текст, задаваемый владельцем).
function summarizePhotoDetails(photo) {
  const parts = [`photo_id: ${photo.id}`];
  if (photo.alt_text) parts.push(`alt: "${truncateForLog(photo.alt_text)}"`);
  return parts.join('; ');
}

module.exports = {
  logAuditEvent,
  summarizeRestaurantDiff,
  summarizeMenuItemDiff,
  summarizeCategoryDiff,
  summarizePhotoDetails,
  ACTIONS,
  SAFE_DIFF_FIELDS,
  MENU_ITEM_SAFE_DIFF_FIELDS,
  CATEGORY_SAFE_DIFF_FIELDS,
};
