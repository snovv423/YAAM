'use strict';

// YAAM HQ — capability-доступ ресторана к ОДНОМУ расчётному документу
// (docs/HQ-PRODUCT-SPEC.md, раздел «Доступ ресторана к документам»).
//
// ЗАЧЕМ. Документы живут за HQ-сессией владельца, которой у ресторана нет и
// быть не должно. Делать документ публичным нельзя: там юридические реквизиты
// и полная финансовая разбивка периода. Решение — тот же приём, что уже
// используется в order_share_tokens и order_access_credentials: непредсказуемый
// токен, дающий ровно одно право — прочитать ровно один документ.
//
// ЧЕГО ТОКЕН НЕ ДАЁТ. Ни HQ-сессии, ни доступа к другим документам, ни к
// другим периодам, ни к другим ресторанам, ни к каким-либо изменениям. Только
// чтение/скачивание одного document_id.
//
// В БАЗЕ ТОЛЬКО ХЭШ. sha256 от токена; сам токен существует ровно один раз —
// в момент выдачи, чтобы попасть в Telegram-сообщение. Утечка дампа БД не
// даёт рабочих ссылок. Токен НИКОГДА не пишется в логи и в аудит: в события
// попадает только id токена и id документа.
const crypto = require('node:crypto');
const db = require('../../db/postgresql');
const { logAuditEvent } = require('./auditLog');

const TOKEN_PREFIX = 'yaam_doc_v1_';
// 32 случайных байта -> 43 символа base64url. Тот же размер и алфавит, что у
// уже существующих share-токенов проекта.
const TOKEN_RE = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

// 30 суток: документ нужен ресторану для бухгалтерии, но бессрочная ссылка —
// это бессрочный риск. По истечении владелец выдаёт новую из HQ.
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Сколько ДЕЙСТВУЮЩИХ токенов может существовать у одного документа.
//
// ЗАЧЕМ ОГРАНИЧЕНИЕ. Открытый токен существует ровно один раз — в момент
// выдачи. Значит «отправить ссылку ещё раз» физически означает «выпустить
// новый токен», и без верхней границы любой повторяющийся вызов (повторный
// запуск job, повторная отправка уведомления, ретрай) наращивал бы число
// действующих ключей к одному и тому же документу неограниченно. Каждый из
// них — самостоятельный доступ, который переживёт и рассылку, и переписку.
//
// Три — чтобы законный повтор (сообщение не дошло, ресторан просит ещё раз)
// работал, но счёт не рос. При выпуске сверх лимита самая старая действующая
// ссылка отзывается: у документа всегда не более трёх живых ключей, и
// последняя выданная ссылка всегда рабочая.
const MAX_ACTIVE_TOKENS_PER_DOCUMENT = 3;

function generateToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function isValidTokenFormat(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

// Выдаёт токен на конкретный документ. Проверяет, что документ действительно
// принадлежит указанному ресторану — иначе токен связал бы ресторан с чужим
// документом.
async function issueToken(documentId, {
  ttlMs = DEFAULT_TTL_MS, now = new Date(), ip = null,
  maxActive = MAX_ACTIVE_TOKENS_PER_DOCUMENT,
} = {}) {
  const rows = await db.query(
    'SELECT id, restaurant_id, kind, status FROM settlement_documents WHERE id = $1',
    [documentId],
  );
  const document = rows[0];
  if (!document) return null;
  // Незавершённый документ отдавать ресторану нечего.
  if (document.status !== 'generated') return null;

  // Верхняя граница числа живых ключей (см. MAX_ACTIVE_TOKENS_PER_DOCUMENT).
  // Отзыв идёт ДО вставки: иначе в момент между вставкой и отзывом у
  // документа оказалось бы на один действующий токен больше лимита.
  const revokedForLimit = await enforceActiveTokenLimit(document, { now, ip, maxActive });

  const token = generateToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const inserted = await db.execute(
    `INSERT INTO settlement_document_access_tokens
       (token_hash, document_id, restaurant_id, expires_at)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [hashToken(token), document.id, document.restaurant_id, expiresAt],
  );

  await logAuditEvent({
    action: 'settlement_document_token_issued', restaurantId: document.restaurant_id,
    // Ни токена, ни его хэша — только идентификаторы.
    details: `токен #${inserted.rows[0].id} на документ #${document.id}, действует до ${expiresAt.toISOString()}`,
    ip,
  });

  return {
    token, tokenId: inserted.rows[0].id, documentId: document.id, expiresAt,
    revokedForLimit,
  };
}

// Считает ДЕЙСТВУЮЩИЕ токены документа: не отозванные и не просроченные.
// Просроченные не отзываются и не удаляются — они уже не работают, а история
// выдач нужна аудиту.
async function countActiveTokens(documentId, { now = new Date() } = {}) {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens
      WHERE document_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [documentId, now],
  );
  return rows[0].n;
}

// Освобождает место под новый токен: если действующих уже maxActive и больше,
// отзывает самые СТАРЫЕ, оставляя ровно maxActive-1. Возвращает число
// отозванных.
//
// Почему отзыв старых, а не отказ в выдаче: открытый токен существует лишь в
// момент создания, поэтому «повторно отдать ту же ссылку» невозможно в
// принципе. Отказ означал бы, что законный повтор уведомления уходит без
// рабочей ссылки. Отзыв старых сохраняет и границу, и работоспособность
// последней выданной ссылки.
async function enforceActiveTokenLimit(document, { now = new Date(), ip = null, maxActive }) {
  if (!Number.isInteger(maxActive) || maxActive < 1) return 0;

  const stale = await db.query(
    `SELECT id FROM settlement_document_access_tokens
      WHERE document_id = $1 AND revoked_at IS NULL AND expires_at > $2
      ORDER BY id ASC`,
    [document.id, now],
  );
  const excess = stale.length - (maxActive - 1);
  if (excess <= 0) return 0;

  const ids = stale.slice(0, excess).map((r) => r.id);
  await db.execute(
    `UPDATE settlement_document_access_tokens
        SET revoked_at = NOW()
      WHERE id = ANY($1) AND revoked_at IS NULL`,
    [ids],
  );
  await logAuditEvent({
    action: 'settlement_document_token_revoked', restaurantId: document.restaurant_id,
    // Идентификаторы, не токены.
    details: `отозвано ${ids.length} старых ссылок документа #${document.id}: `
      + `достигнут предел действующих ссылок (${maxActive})`,
    ip,
  });
  return ids.length;
}

// Проверяет токен и возвращает документ. Различает причины отказа, но НАРУЖУ
// они отдаются одинаково нейтрально (см. роут): подсказывать, существует ли
// токен, значит помогать перебору.
//
// reason: 'invalid_format' | 'not_found' | 'revoked' | 'expired' |
//         'document_missing' | 'restaurant_mismatch'
async function resolveToken(rawToken, { now = new Date(), ip = null } = {}) {
  if (!isValidTokenFormat(rawToken)) {
    return { ok: false, reason: 'invalid_format' };
  }

  const rows = await db.query(
    `SELECT t.*, d.restaurant_id AS document_restaurant_id
       FROM settlement_document_access_tokens t
       JOIN settlement_documents d ON d.id = t.document_id
      WHERE t.token_hash = $1`,
    [hashToken(rawToken)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  if (row.revoked_at) {
    await logRejected(row, 'revoked', ip);
    return { ok: false, reason: 'revoked' };
  }
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    await logRejected(row, 'expired', ip);
    return { ok: false, reason: 'expired' };
  }
  // Токен и документ обязаны указывать на один ресторан. Расхождение может
  // возникнуть только при повреждении данных — доступ в этом случае закрыт.
  if (row.restaurant_id !== row.document_restaurant_id) {
    await logRejected(row, 'restaurant_mismatch', ip);
    return { ok: false, reason: 'restaurant_mismatch' };
  }

  const documents = await db.query('SELECT * FROM settlement_documents WHERE id = $1', [row.document_id]);
  if (!documents[0]) return { ok: false, reason: 'document_missing' };

  await db.execute(
    `UPDATE settlement_document_access_tokens
        SET last_used_at = NOW(), use_count = use_count + 1
      WHERE id = $1`,
    [row.id],
  );
  await logAuditEvent({
    action: 'settlement_document_token_used', restaurantId: row.restaurant_id,
    details: `токен #${row.id}: открыт документ #${row.document_id}`, ip,
  });

  return { ok: true, document: documents[0], tokenId: row.id, restaurantId: row.restaurant_id };
}

async function logRejected(row, reason, ip) {
  await logAuditEvent({
    action: 'settlement_document_token_rejected', restaurantId: row.restaurant_id,
    details: `токен #${row.id} отклонён: ${reason}`, ip,
  });
}

// Отзыв. Идемпотентен: повторный отзыв не меняет момент первого.
async function revokeToken(tokenId, { ip = null } = {}) {
  const updated = await db.execute(
    `UPDATE settlement_document_access_tokens
        SET revoked_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, restaurant_id, document_id`,
    [tokenId],
  );
  if (!updated.rows[0]) return { revoked: false };
  await logAuditEvent({
    action: 'settlement_document_token_revoked', restaurantId: updated.rows[0].restaurant_id,
    details: `токен #${tokenId} на документ #${updated.rows[0].document_id} отозван`, ip,
  });
  return { revoked: true };
}

// Отзыв всех действующих токенов документа — нужен, когда документ заменён
// корректирующей версией: старая ссылка не должна продолжать работать.
async function revokeTokensForDocument(documentId, { ip = null } = {}) {
  const updated = await db.execute(
    `UPDATE settlement_document_access_tokens
        SET revoked_at = NOW()
      WHERE document_id = $1 AND revoked_at IS NULL
      RETURNING id, restaurant_id`,
    [documentId],
  );
  for (const row of updated.rows) {
    // eslint-disable-next-line no-await-in-loop
    await logAuditEvent({
      action: 'settlement_document_token_revoked', restaurantId: row.restaurant_id,
      details: `токен #${row.id} отозван: документ #${documentId} заменён корректирующей версией`, ip,
    });
  }
  return updated.rows.length;
}

// База обязана быть АБСОЛЮТНЫМ http(s)-адресом. Пустое, относительное или
// испорченное значение переменной окружения не должно превращаться в ссылку
// вида "undefined/d/<token>" или "/d/<token>": такая ссылка не откроется, но
// токен в ней уже выпущен и уже ушёл в сообщение. Лучше не дать ссылки вовсе
// (документы остаются доступны владельцу в HQ), чем выдать нерабочую.
function normalizePublicBaseUrl(publicBaseUrl) {
  if (!publicBaseUrl) return null;
  let parsed;
  try {
    parsed = new URL(String(publicBaseUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function buildDocumentUrl(publicBaseUrl, token) {
  const base = normalizePublicBaseUrl(publicBaseUrl);
  if (!base || !isValidTokenFormat(token)) return null;
  return `${base}/d/${token}`;
}

module.exports = {
  TOKEN_PREFIX,
  DEFAULT_TTL_MS,
  MAX_ACTIVE_TOKENS_PER_DOCUMENT,
  generateToken,
  isValidTokenFormat,
  hashToken,
  issueToken,
  countActiveTokens,
  resolveToken,
  revokeToken,
  revokeTokensForDocument,
  normalizePublicBaseUrl,
  buildDocumentUrl,
};
