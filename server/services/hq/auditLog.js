'use strict';

// YAAM HQ Stage 4 — журнал административных изменений (hq_audit_log,
// db/postgresql/schema.sql). Единственное место, которое пишет в эту
// таблицу — как и services/hq/securityLog.js (Stage 3), ошибка записи в лог
// НИКОГДА не должна ронять реальное действие (создание/правку/паузу/
// архивирование ресторана) — поэтому эта функция сама ловит свои ошибки.
const db = require('../../db/postgresql');
const { maskAccountForAudit } = require('./ruRequisites');
const { formatCommissionBpsAsPercent } = require('./restaurantContractService');

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
  // Stage 5B.1 — медиа-система, упрощённый набор (задание, раздел 0: у
  // фотографий нет reorder/archive/restore) — ровно 6 событий: upload/
  // primary/delete на ресторан и на блюдо. Stage 5B изначально вводил 10
  // событий (с moved/archived/restored) — они убраны вместе с самой
  // функциональностью, а не просто перестали вызываться.
  'restaurant_photo_uploaded',
  'restaurant_photo_primary_changed',
  'restaurant_photo_deleted',
  'menu_item_photo_uploaded',
  'menu_item_photo_primary_changed',
  'menu_item_photo_deleted',
  // Stage 6 — юридические данные/банковские реквизиты/договор (задание,
  // раздел 10). Ровно 7 событий.
  'restaurant_legal_details_created',
  'restaurant_legal_details_updated',
  'restaurant_bank_details_created',
  'restaurant_bank_details_updated',
  'restaurant_contract_created',
  'restaurant_contract_updated',
  'restaurant_contract_status_changed',
  // Stage 8 — расчётные периоды (задание, раздел 13). restaurantId для этих
  // событий всегда null — событие уровня периода в целом, не одного ресторана.
  'settlement_period_created',
  'settlement_period_closed',
  'settlement_period_draft_deleted',
  // Stage 9 — payout entity (задание, раздел "Audit"). В отличие от
  // settlement-событий выше, restaurantId ЗАДАН — выплата всегда привязана
  // к одному конкретному ресторану.
  'payout_created',
  'payout_processing',
  'payout_succeeded',
  'payout_failed',
  // Stage 9.5 — попытки обращения к банку (payout_attempts). ВСЕ ПЯТЬ здесь
  // RESERVED, не EMITTED (задание, раздел 12: "if service methods have no
  // real route/bank caller yet, do not fabricate fake audit events" — тот же
  // принцип, что уже применён выше к payout_processing/succeeded/failed в
  // Stage 9: createPayoutAttempt/markAttemptSubmitting/Processing/Unknown/
  // Succeeded/Failed реальны и полностью протестированы в payoutService.js,
  // но ни один HQ-маршрут их не вызывает — реальный вызывающий код появится
  // только вместе с банковским адаптером на Stage 10). Добавлены сюда
  // заранее, синхронно со schema.sql hq_audit_log_action_check, чтобы Stage
  // 10 мог начать логировать сразу, без отдельной миграции allowlist'а.
  'payout_attempt_created',
  'payout_attempt_processing',
  'payout_attempt_unknown',
  'payout_attempt_succeeded',
  'payout_attempt_failed',
  // Stage 9.6 — реквизиты YAAM как плательщика (yaam_bank_details, HQ
  // Settings). В отличие от payout_attempt_*, ЭТИ ДВА реально EMITTED —
  // единственный write-маршрут этого этапа (POST /hq/settings/
  // yaam-bank-details) пишет их сразу, restaurantId всегда null (событие не
  // привязано ни к одному конкретному ресторану — это реквизиты самого
  // YAAM, не ресторана).
  'yaam_bank_details_created',
  'yaam_bank_details_updated',
  // Индивидуальная выплата с обзора ресторана (Finance Stage 12).
  'restaurant_payout_prepared',
  // Еженедельное автозакрытие расчётных периодов (docs/HQ-PRODUCT-SPEC.md):
  // запуск job, успешное закрытие, безопасный повтор, catch-up, ошибка.
  'settlement_job_started',
  'settlement_job_finished',
  'settlement_job_failed',
  'settlement_period_catch_up',
  'settlement_period_close_skipped',
  // Документы периода и их корректирующие версии.
  'settlement_document_created',
  'settlement_document_failed',
  'settlement_document_corrected',
  // Уведомление ресторана о завершённом расчёте (Telegram).
  'yaam_legal_details_updated',
  'yaam_bank_details_updated',
  'owner_password_changed',
  'owner_password_change_rejected',
  'fiscal_receipt_created',
  'fiscal_receipt_succeeded',
  'fiscal_receipt_failed',
  'fiscal_receipt_retried',
  'settlement_backlog_queued',
  'settlement_backlog_deferred',
  // Stage 19.1: неделю нельзя закрыть, потому что её диапазон пересекается с
  // уже существующим периодом. Это состояние, требующее решения владельца, а
  // не сбой выполнения; пишется один раз на изменение состава блокировок.
  'settlement_week_blocked',
  'settlement_carry_forward_applied',
  'settlement_carry_forward_accrued',
  'settlement_document_token_issued',
  'settlement_document_token_used',
  'settlement_document_token_revoked',
  'settlement_document_token_rejected',
  'settlement_adjustment_created',
  'settlement_notification_sent',
  'settlement_notification_failed',
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

// Stage 6 (задание, раздел 10) — "Можно: перечень изменённых полей...
// Нельзя: полный расчётный счёт; полный корреспондентский счёт; полные
// банковские реквизиты; внутренние примечания целиком; длинные адреса
// целиком." Три категории полей на каждую сущность:
//   *_SAFE_DIFF_FIELDS   — короткие небанковские значения, полный diff "было -> стало";
//   *_MASKED_FIELDS      — только account_number/correspondent_account, маскированный diff;
//   *_NAME_ONLY_FIELDS   — длинные адреса/примечания/назначение платежа — только факт
//                          изменения ("field: изменено"), без самого значения.
const LEGAL_DETAILS_SAFE_DIFF_FIELDS = [
  'legal_form', 'legal_name', 'short_legal_name', 'inn', 'ogrn', 'kpp',
  'director_name', 'contact_phone', 'contact_email',
];
const LEGAL_DETAILS_NAME_ONLY_FIELDS = ['legal_address', 'actual_address', 'authority_basis'];

const BANK_DETAILS_SAFE_DIFF_FIELDS = ['recipient_name', 'recipient_inn', 'recipient_kpp', 'bik', 'bank_name'];
const BANK_DETAILS_MASKED_FIELDS = ['account_number', 'correspondent_account'];
const BANK_DETAILS_NAME_ONLY_FIELDS = ['default_payment_purpose', 'internal_note'];

// Stage 9.6 — реквизиты YAAM как плательщика (задание, раздел 11: "Можно:
// факт изменения; маскированный счёт; изменившиеся безопасные поля. Нельзя:
// полный счёт; корреспондентский счёт полностью; token; certificate path;
// private key"). Тот же трёхкатегорийный принцип, что и BANK_DETAILS_* выше
// — never в этом списке нет ни одного секрета (yaam_bank_details вообще не
// хранит токены/сертификаты — см. db/postgresql/schema.sql).
const YAAM_BANK_DETAILS_SAFE_DIFF_FIELDS = ['legal_name', 'inn', 'kpp', 'bik', 'bank_name'];
const YAAM_BANK_DETAILS_MASKED_FIELDS = ['account_number', 'correspondent_account'];

// commission_bps сознательно ВНЕ этого списка — логируется отдельно, в
// процентах (человекочитаемо), не сырыми basis points. status — тоже вне
// списка: логируется отдельным событием restaurant_contract_status_changed
// (см. routes/hq/restaurants.js), не дублируется здесь.
const CONTRACT_SAFE_DIFF_FIELDS = ['contract_number', 'signed_at', 'starts_at', 'ends_at'];
const CONTRACT_NAME_ONLY_FIELDS = ['internal_note'];

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

// Общий helper для "только факт изменения, без значения" (адреса/примечания/
// назначение платежа — задание, раздел 10: "нельзя ... длинные адреса
// целиком", "нельзя ... внутренние примечания целиком").
function summarizeChangedFieldNames(before, after, fields) {
  const parts = [];
  for (const field of fields) {
    if (String(before[field] ?? '') !== String(after[field] ?? '')) {
      parts.push(`${field}: изменено`);
    }
  }
  return parts;
}

function summarizeLegalDetailsDiff(before, after) {
  const parts = [
    ...(summarizeDiff(before, after, LEGAL_DETAILS_SAFE_DIFF_FIELDS)?.split('; ') ?? []),
    ...summarizeChangedFieldNames(before, after, LEGAL_DETAILS_NAME_ONLY_FIELDS),
  ];
  return parts.length ? parts.join('; ') : null;
}

// Банковские реквизиты (задание, раздел 10, пример дословно):
// "account_number: ****1234 -> ****5678" — маскировка через
// ruRequisites.maskAccountForAudit, полные значения никогда не попадают в лог.
function summarizeBankDetailsDiff(before, after) {
  const maskedParts = [];
  for (const field of BANK_DETAILS_MASKED_FIELDS) {
    if (String(before[field] ?? '') === String(after[field] ?? '')) continue;
    maskedParts.push(`${field}: ${maskAccountForAudit(before[field])} -> ${maskAccountForAudit(after[field])}`);
  }
  const parts = [
    ...(summarizeDiff(before, after, BANK_DETAILS_SAFE_DIFF_FIELDS)?.split('; ') ?? []),
    ...maskedParts,
    ...summarizeChangedFieldNames(before, after, BANK_DETAILS_NAME_ONLY_FIELDS),
  ];
  return parts.length ? parts.join('; ') : null;
}

// Реквизиты YAAM как плательщика (Stage 9.6) — тот же маскированный принцип,
// что и summarizeBankDetailsDiff выше, применённый к yaam_bank_details
// (задание, раздел 11). before=null при первом создании (created=true) —
// вызывающий код (routes/hq/pages.js) не должен вызывать эту функцию в
// этом случае вообще (нечего сравнивать при первом создании), тот же
// паттерн, что и все остальные *_created/updated события этого файла.
function summarizeYaamBankDetailsDiff(before, after) {
  const maskedParts = [];
  for (const field of YAAM_BANK_DETAILS_MASKED_FIELDS) {
    if (String(before[field] ?? '') === String(after[field] ?? '')) continue;
    maskedParts.push(`${field}: ${maskAccountForAudit(before[field])} -> ${maskAccountForAudit(after[field])}`);
  }
  const parts = [
    ...(summarizeDiff(before, after, YAAM_BANK_DETAILS_SAFE_DIFF_FIELDS)?.split('; ') ?? []),
    ...maskedParts,
  ];
  return parts.length ? parts.join('; ') : null;
}

// Договор — БЕЗ status (см. summarizeContractStatusChange ниже) и БЕЗ
// сырых commission_bps (показывается в процентах, человекочитаемо).
function summarizeContractDiff(before, after) {
  const commissionPart = before.commission_bps !== after.commission_bps
    ? [`commission: "${formatCommissionBpsAsPercent(before.commission_bps)}%" -> "${formatCommissionBpsAsPercent(after.commission_bps)}%"`]
    : [];
  const parts = [
    ...(summarizeDiff(before, after, CONTRACT_SAFE_DIFF_FIELDS)?.split('; ') ?? []),
    ...commissionPart,
    ...summarizeChangedFieldNames(before, after, CONTRACT_NAME_ONLY_FIELDS),
  ];
  return parts.length ? parts.join('; ') : null;
}

// Отдельное событие restaurant_contract_status_changed (задание, раздел 10:
// "можно: старый/новый статус договора") — не смешивается с
// summarizeContractDiff выше, чтобы смена статуса всегда была видна как
// самостоятельное, легко находимое событие в логе.
function summarizeContractStatusChange(before, after) {
  return `status: "${before.status}" -> "${after.status}"`;
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
  summarizeLegalDetailsDiff,
  summarizeBankDetailsDiff,
  summarizeYaamBankDetailsDiff,
  summarizeContractDiff,
  summarizeContractStatusChange,
  ACTIONS,
  SAFE_DIFF_FIELDS,
  MENU_ITEM_SAFE_DIFF_FIELDS,
  CATEGORY_SAFE_DIFF_FIELDS,
  LEGAL_DETAILS_SAFE_DIFF_FIELDS,
  LEGAL_DETAILS_NAME_ONLY_FIELDS,
  BANK_DETAILS_SAFE_DIFF_FIELDS,
  BANK_DETAILS_MASKED_FIELDS,
  BANK_DETAILS_NAME_ONLY_FIELDS,
  YAAM_BANK_DETAILS_SAFE_DIFF_FIELDS,
  YAAM_BANK_DETAILS_MASKED_FIELDS,
  CONTRACT_SAFE_DIFF_FIELDS,
  CONTRACT_NAME_ONLY_FIELDS,
};
