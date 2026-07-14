const crypto = require('node:crypto');
const db = require('../db');

const ORDER_TOKEN_PREFIX = 'yaam_ord_v1_';
const CREATE_KEY_PREFIX = 'yaam_create_v1_';
const RETRY_KEY_PREFIX = 'yaam_retry_v1_';
const BASE64URL_256_RE = '[A-Za-z0-9_-]{43}';
const ORDER_TOKEN_RE = new RegExp(`^${ORDER_TOKEN_PREFIX}${BASE64URL_256_RE}$`);
const CREATE_KEY_RE = new RegExp(`^${CREATE_KEY_PREFIX}${BASE64URL_256_RE}$`);
const RETRY_KEY_RE = new RegExp(`^${RETRY_KEY_PREFIX}${BASE64URL_256_RE}$`);

class OrderAccessInputError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'OrderAccessInputError';
    this.statusCode = statusCode;
  }
}

class ActiveOrderConflictError extends Error {
  constructor() {
    super('Для этого ресторана уже есть незавершённый заказ');
    this.name = 'ActiveOrderConflictError';
    this.statusCode = 409;
  }
}

function isValidOrderToken(token) {
  return typeof token === 'string' && ORDER_TOKEN_RE.test(token);
}

function isValidCreateKey(key) {
  return typeof key === 'string' && CREATE_KEY_RE.test(key);
}

function isValidRetryKey(key) {
  return typeof key === 'string' && RETRY_KEY_RE.test(key);
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function hashCreationRequest(canonicalRequest) {
  return hashSecret(JSON.stringify(canonicalRequest));
}

function requireValidCreationSecrets(orderAccessToken, createIdempotencyKey) {
  if (!isValidOrderToken(orderAccessToken)) {
    throw new OrderAccessInputError('Некорректный токен доступа к заказу', 401);
  }
  if (!isValidCreateKey(createIdempotencyKey)) {
    throw new OrderAccessInputError('Некорректный ключ создания заказа');
  }
  return {
    tokenHash: hashSecret(orderAccessToken),
    createKeyHash: hashSecret(createIdempotencyKey),
  };
}

function parseBearerAuthorization(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(headerValue);
  return match && isValidOrderToken(match[1]) ? match[1] : null;
}

function insertCredential(orderId, tokenHash, createKeyHash, requestHash) {
  db.prepare(`
    INSERT INTO order_access_credentials (order_id, token_hash, create_key_hash, request_hash)
    VALUES (?, ?, ?, ?)
  `).run(orderId, tokenHash, createKeyHash, requestHash);
}

function secretsAlreadyUsed(tokenHash, createKeyHash) {
  return !!db.prepare(`
    SELECT 1 FROM order_access_credentials
    WHERE token_hash = ? OR create_key_hash = ?
  `).get(tokenHash, createKeyHash);
}

function findAuthorizedOrderId(publicCode, rawToken) {
  if (!isValidOrderToken(rawToken)) return null;
  const row = db.prepare(`
    SELECT o.id
    FROM orders o
    JOIN order_access_credentials a ON a.order_id = o.id
    WHERE o.public_code = ? AND a.token_hash = ?
  `).get(publicCode, hashSecret(rawToken));
  return row ? row.id : null;
}

module.exports = {
  ORDER_TOKEN_PREFIX,
  CREATE_KEY_PREFIX,
  RETRY_KEY_PREFIX,
  OrderAccessInputError,
  ActiveOrderConflictError,
  isValidOrderToken,
  isValidCreateKey,
  isValidRetryKey,
  hashSecret,
  hashCreationRequest,
  requireValidCreationSecrets,
  parseBearerAuthorization,
  insertCredential,
  secretsAlreadyUsed,
  findAuthorizedOrderId,
};
