const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Встроенный SQLite из Node (без native-компиляции — better-sqlite3 не собирался
// на этой машине из-за несовпадения версии Node и системного C++ тулчейна).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'yaam.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
try {
  db.exec(schema);
} catch (err) {
  // Partial UNIQUE-индексы намеренно не «чинят» старые финансовые дубли
  // молча. Если legacy-БД уже содержит две активные попытки или одинаковый
  // provider_payment_id, запуск останавливается: такие строки должен разобрать
  // человек, иначе автоматическое удаление могло бы скрыть реальный платёж.
  if (err && /UNIQUE constraint failed: payments\./.test(err.message)) {
    throw new Error(`Нарушен платёжный инвариант legacy-БД; требуется ручная сверка перед запуском: ${err.message}`);
  }
  throw err;
}

// Маленькая обёртка транзакции — в node:sqlite нет db.transaction(), как в better-sqlite3.
function transaction(fn, beginSql = 'BEGIN') {
  return (...args) => {
    db.exec(beginSql);
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}
db.transaction = transaction;
db.immediateTransaction = (fn) => transaction(fn, 'BEGIN IMMEDIATE');

module.exports = db;
