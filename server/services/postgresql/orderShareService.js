'use strict';

// Read-only capability для публичной ссылки «Поделиться заказом» —
// см. комментарий у order_share_tokens в db/postgresql/schema.sql. Отдельно
// от orderService.js (владельческий access_token, cancel/retry-payment/
// rate): этот токен даёт ТОЛЬКО чтение статуса, поэтому намеренно живёт в
// собственном маленьком модуле, а не смешивается с владельческой логикой.

const crypto = require('node:crypto');
const db = require('../../db/postgresql');

const SHARE_TOKEN_PREFIX = 'yaam_shr_v1_';
const SHARE_TOKEN_RE = new RegExp(`^${SHARE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

function isValidShareToken(token) {
  return typeof token === 'string' && SHARE_TOKEN_RE.test(token);
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function parseBearerShareToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(headerValue);
  return match && isValidShareToken(match[1]) ? match[1] : null;
}

// Владелец (уже прошедший владельческий requireOrderAccess) регистрирует
// read-only share-токен для своего заказа. Upsert по order_id — один
// активный share-токен на заказ, повторная генерация тихо заменяет
// предыдущий (см. schema.sql).
async function createOrReplaceShareToken(orderId, rawToken, client = null) {
  if (!isValidShareToken(rawToken)) {
    const err = new Error('Некорректный share-токен');
    err.statusCode = 400;
    throw err;
  }
  await db.execute(
    `INSERT INTO order_share_tokens (order_id, token_hash, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (order_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = NOW()`,
    [orderId, hashSecret(rawToken)],
    client,
  );
}

async function findAuthorizedOrderIdByShareToken(publicCode, rawToken, client = null) {
  if (!isValidShareToken(rawToken)) return null;
  const rows = await db.query(
    `SELECT o.id
     FROM orders o
     JOIN order_share_tokens s ON s.order_id = o.id
     WHERE o.public_code = $1 AND s.token_hash = $2`,
    [publicCode, hashSecret(rawToken)],
    client,
  );
  return rows[0] ? rows[0].id : null;
}

module.exports = {
  SHARE_TOKEN_PREFIX,
  isValidShareToken,
  parseBearerShareToken,
  createOrReplaceShareToken,
  findAuthorizedOrderIdByShareToken,
};
