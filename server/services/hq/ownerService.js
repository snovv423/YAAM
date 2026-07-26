'use strict';

// YAAM HQ Stage 3 — единственный владелец HQ хранится в PostgreSQL
// (таблица hq_owner, db/postgresql/schema.sql), а не в .env. Этот модуль —
// единственное место в кодовой базе, которое читает/пишет эту таблицу.
//
// Ровно одна строка гарантирована самой схемой (PRIMARY KEY id + CHECK
// id=1) — bootstrapOwnerFromEnv() полагается именно на это ограничение
// (ON CONFLICT (id) DO NOTHING), а не на отдельную проверку "уже есть
// строка?" перед INSERT — так надёжнее при гипотетическом параллельном
// старте нескольких процессов (не бывает в текущей топологии "один Nginx —
// один backend", но принцип тот же, что и у финансовых инвариантов в
// orderService.js: полагаться на СУБД, а не на порядок вызовов в JS).
const db = require('../../db/postgresql');

async function getOwner() {
  const rows = await db.query('SELECT id, login, password_hash, credentials_version FROM hq_owner WHERE id = 1');
  return rows[0] || null;
}

async function getCredentialsVersion() {
  const rows = await db.query('SELECT credentials_version FROM hq_owner WHERE id = 1');
  return rows[0] ? rows[0].credentials_version : null;
}

// Единственный способ создать владельца. Идемпотентна: если строка уже
// существует (владелец уже был инициализирован — при первом запуске в
// прошлом, или через reset-hq-owner.js), НИЧЕГО не меняет — ни логин, ни
// пароль, ни credentials_version существующего владельца НЕ перезаписываются
// повторным запуском с другими значениями в .env. Это и есть буквальное
// "после первой инициализации .env больше не используется для входа":
// .env способен только ОДИН раз заполнить пустую таблицу.
// Возвращает {created: boolean} — вызывающий код (services/postgresql/app.js)
// использует это только для лога, не для логики.
async function bootstrapOwnerFromEnv({ login, passwordHash }) {
  const rows = await db.query(
    `INSERT INTO hq_owner (id, login, password_hash, credentials_version)
     VALUES (1, $1, $2, 1)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [login, passwordHash],
  );
  return { created: rows.length > 0 };
}

// Возвращает новый credentials_version. WHERE id=1 — не строго обязательно
// (строка всего одна и всегда id=1), но явное условие защищает от
// случайного UPDATE без WHERE, если сюда когда-нибудь скопируют этот запрос
// без внимания.
async function changeOwnerLogin(newLogin) {
  const rows = await db.query(
    `UPDATE hq_owner SET login = $1, credentials_version = credentials_version + 1, updated_at = NOW()
     WHERE id = 1
     RETURNING credentials_version`,
    [newLogin],
  );
  if (!rows[0]) throw new Error('hq_owner: смена логина невозможна — владелец ещё не инициализирован');
  return rows[0].credentials_version;
}

async function changeOwnerPassword(newPasswordHash) {
  const rows = await db.query(
    `UPDATE hq_owner SET password_hash = $1, credentials_version = credentials_version + 1, updated_at = NOW()
     WHERE id = 1
     RETURNING credentials_version`,
    [newPasswordHash],
  );
  if (!rows[0]) throw new Error('hq_owner: смена пароля невозможна — владелец ещё не инициализирован');
  return rows[0].credentials_version;
}

// Используется только server/scripts/reset-hq-owner.js (аварийное
// восстановление с VPS) — в отличие от bootstrapOwnerFromEnv, ЗАМЕНЯЕТ
// существующего владельца (или создаёт, если его почему-то ещё нет), и
// всегда увеличивает credentials_version (значит — всегда разлогинивает
// все существующие сессии, даже если по случайности новый логин/пароль
// совпали со старыми).
async function resetOwner({ login, passwordHash }) {
  const rows = await db.query(
    `INSERT INTO hq_owner (id, login, password_hash, credentials_version)
     VALUES (1, $1, $2, 1)
     ON CONFLICT (id) DO UPDATE SET
       login = EXCLUDED.login,
       password_hash = EXCLUDED.password_hash,
       credentials_version = hq_owner.credentials_version + 1,
       updated_at = NOW()
     RETURNING credentials_version`,
    [login, passwordHash],
  );
  return rows[0].credentials_version;
}

module.exports = {
  getOwner,
  getCredentialsVersion,
  bootstrapOwnerFromEnv,
  changeOwnerLogin,
  changeOwnerPassword,
  resetOwner,
};
