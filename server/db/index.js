const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Встроенный SQLite из Node (без native-компиляции — better-sqlite3 не собирался
// на этой машине из-за несовпадения версии Node и системного C++ тулчейна).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'yaam.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Маленькая обёртка транзакции — в node:sqlite нет db.transaction(), как в better-sqlite3.
function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
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

module.exports = db;
