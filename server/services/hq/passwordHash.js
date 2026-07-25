'use strict';

// Хеширование пароля администратора HQ — только встроенный node:crypto
// (scrypt), без новой зависимости и без собственной криптографии: scrypt —
// стандартный, рекомендованный OWASP Password Storage Cheat Sheet KDF,
// когда bcrypt/argon2 не установлены; мы вызываем готовую реализацию из
// стандартной библиотеки Node, а не изобретаем алгоритм.
//
// Формат хранимого значения: `scrypt$N$r$p$<saltHex>$<hashHex>`
// (параметры зашиты в саму строку — позволяет менять cost-параметры в
// будущем, не теряя обратной совместимости со старыми хешами).
const crypto = require('node:crypto');

const SCRYPT_N = 16384; // cost — рекомендованный OWASP минимум для interactive login (2^14)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function scryptAsync(password, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  if (typeof password !== 'string' || !password) {
    throw new Error('password обязателен для hashPassword');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// Возвращает true/false — никогда не бросает на "неверный пароль" (только на
// действительно повреждённый/чужого формата stored-хеш, что означает
// конфигурационную ошибку HQ_ADMIN_PASSWORD_HASH, а не попытку логина).
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('HQ_ADMIN_PASSWORD_HASH имеет неизвестный формат — ожидается scrypt$N$r$p$salt$hash');
  }
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr), r = Number(rStr), p = Number(pStr);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptAsync(password, salt, expected.length, { N, r, p });
  // timingSafeEqual требует одинаковую длину буферов — несовпадение длины
  // означает заведомо неверный пароль, а не ошибку сравнения.
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
