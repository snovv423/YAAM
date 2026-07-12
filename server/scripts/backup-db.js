// Production-ready backup стратегия для SQLite (C2, аудит готовности к VPS).
//
// Почему так: node:sqlite сам предоставляет hot-backup через DatabaseSync
// { readOnly: true } + backup() — снимок консистентен даже пока сервер пишет
// в базу (WAL допускает параллельных читателей и одного писателя), без
// внешней зависимости (sqlite3 CLI не нужен, дополнительный npm-пакет тоже).
//
// Запуск: `npm run backup` (см. package.json) или напрямую `node scripts/backup-db.js`.
// На VPS предполагается ежедневный cron/systemd-таймер — см. server/docs/backup-restore.md.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync, backup } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'yaam.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'db', 'backups');
// Сколько последних бэкапов хранить — старше отбрасываем, чтобы диск VPS не
// забился за месяцы работы. 14 — по умолчанию под ежедневный cron (2 недели).
const BACKUP_RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT || 14);

// Точность до миллисекунд — иначе два бэкапа, запущенных вручную в пределах
// одной секунды, получат одинаковое имя файла и второй молча перезапишет первый.
function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

async function backupDatabase({ dbPath = DB_PATH, backupDir = BACKUP_DIR, retentionCount = BACKUP_RETENTION_COUNT } = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Файл базы данных не найден: ${dbPath}`);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const destPath = path.join(backupDir, `yaam-${timestampForFilename()}.db`);
  const sourceDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(sourceDb, destPath);
  } finally {
    sourceDb.close();
  }

  // Источник в WAL-режиме — backup() копирует и это в заголовок destPath, но
  // без companion -wal/-shm файлов. Открыть такой файл иначе (особенно
  // readOnly, особенно на другой машине при restore) можно не всегда надёжно.
  // Переводим бэкап в DELETE-режим сразу после снятия — получаем гарантированно
  // самодостаточный однофайловый снимок, без сайдкар-файлов.
  const destDb = new DatabaseSync(destPath);
  destDb.exec('PRAGMA journal_mode = DELETE;');
  destDb.close();

  pruneOldBackups(backupDir, retentionCount);
  return destPath;
}

// Хранит только retentionCount самых свежих файлов вида yaam-*.db в backupDir.
function pruneOldBackups(backupDir, retentionCount) {
  const files = fs.readdirSync(backupDir)
    .filter((name) => /^yaam-.*\.db$/.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of files.slice(retentionCount)) {
    fs.unlinkSync(path.join(backupDir, stale.name));
  }
}

if (require.main === module) {
  backupDatabase()
    .then((destPath) => {
      console.log(`OK: бэкап создан — ${destPath}`);
    })
    .catch((err) => {
      console.error(`ОШИБКА бэкапа: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { backupDatabase, pruneOldBackups };
