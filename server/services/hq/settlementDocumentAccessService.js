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
async function issueToken(documentId, { ttlMs = DEFAULT_TTL_MS, now = new Date(), ip = null } = {}) {
  const rows = await db.query(
    'SELECT id, restaurant_id, kind, status FROM settlement_documents WHERE id = $1',
    [documentId],
  );
  const document = rows[0];
  if (!document) return null;
  // Незавершённый документ отдавать ресторану нечего.
  if (document.status !== 'generated') return null;

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

  return { token, tokenId: inserted.rows[0].id, documentId: document.id, expiresAt };
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

function buildDocumentUrl(publicBaseUrl, token) {
  if (!publicBaseUrl) return null;
  return `${String(publicBaseUrl).replace(/\/$/, '')}/d/${token}`;
}

module.exports = {
  TOKEN_PREFIX,
  DEFAULT_TTL_MS,
  generateToken,
  isValidTokenFormat,
  hashToken,
  issueToken,
  resolveToken,
  revokeToken,
  revokeTokensForDocument,
  buildDocumentUrl,
};
