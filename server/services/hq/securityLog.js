'use strict';

// YAAM HQ Stage 3 — журнал безопасности (hq_security_log, задание, раздел 6).
// Единственное место, которое пишет в эту таблицу — так проще гарантировать,
// что в неё никогда случайно не попадёт пароль/хеш/содержимое сессии (сам
// SQL-запрос принимает только event_type/ip, физически нечему больше туда
// попасть).
//
// Ошибка записи лога НИКОГДА не должна ронять реальный логин/логаут/смену
// пароля — поэтому эта функция сама ловит свои ошибки, а не пробрасывает их
// вызывающему коду. Потерянная запись лога — не так плохо, как сломанный вход
// в HQ из-за временной проблемы с БД в момент именно INSERT в лог.
const db = require('../../db/postgresql');

const EVENT_TYPES = [
  'login_success',
  'login_failed',
  'login_rate_limited',
  'login_change',
  'password_change',
  'emergency_reset',
  'logout',
];

async function logSecurityEvent({ eventType, ip }) {
  if (!EVENT_TYPES.includes(eventType)) {
    // Программная ошибка вызывающего кода (опечатка в имени события) —
    // не должна тихо создать невалидную строку и не должна уронить логин;
    // просто громко предупреждаем в консоль, ровно как ниже для сбоя записи.
    console.error(`[hq-security-log] неизвестный eventType: "${eventType}"`);
    return;
  }
  try {
    await db.query('INSERT INTO hq_security_log (event_type, ip) VALUES ($1, $2)', [eventType, ip || null]);
  } catch (err) {
    console.error(`[hq-security-log] не удалось записать событие "${eventType}":`, err.message);
  }
}

module.exports = { logSecurityEvent, EVENT_TYPES };
