// Восстановление SQLite из бэкапа, созданного backup-db.js (C2, аудит готовности к VPS).
//
// Запуск: `npm run restore -- /path/to/backup.db` — восстановить конкретный файл.
//         `npm run restore` (без аргумента) — восстановить самый свежий файл из BACKUP_DIR.
//
// ВАЖНО: перед восстановлением на VPS backend должен быть остановлен (см.
// server/docs/single-instance.md/backup-restore.md) — иначе живой процесс
// продолжит писать в старые WAL/SHM файлы поверх подменённой базы.
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'yaam.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'db', 'backups');

function findLatestBackup(backupDir) {
  const files = fs.readdirSync(backupDir)
    .filter((name) => /^yaam-.*\.db$/.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  return path.join(backupDir, files[0].name);
}

function removeSidecarFiles(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* могло не быть — не проблема */ }
  }
}

// Возвращает путь safety-копии текущей базы (снятой ДО перезаписи) — на случай,
// если восстанавливаемый бэкап окажется повреждён или не тем, что нужно.
function restoreDatabase(backupPath, { dbPath = DB_PATH, backupDir = BACKUP_DIR } = {}) {
  const sourceBackup = backupPath || findLatestBackup(backupDir);
  if (!sourceBackup) {
    throw new Error(`Не передан путь к бэкапу и не найдено ни одного файла в ${backupDir}`);
  }
  if (!fs.existsSync(sourceBackup)) {
    throw new Error(`Файл бэкапа не найден: ${sourceBackup}`);
  }

  let safetyCopyPath = null;
  if (fs.existsSync(dbPath)) {
    safetyCopyPath = path.join(path.dirname(dbPath), `pre-restore-${Date.now()}.db`);
    fs.copyFileSync(dbPath, safetyCopyPath);
  }

  removeSidecarFiles(dbPath);
  fs.copyFileSync(sourceBackup, dbPath);

  return { restoredFrom: sourceBackup, dbPath, safetyCopyPath };
}

if (require.main === module) {
  const arg = process.argv[2];
  try {
    const result = restoreDatabase(arg);
    console.log(`OK: восстановлено из ${result.restoredFrom} -> ${result.dbPath}`);
    if (result.safetyCopyPath) {
      console.log(`Safety-копия предыдущей базы сохранена: ${result.safetyCopyPath}`);
    }
  } catch (err) {
    console.error(`ОШИБКА восстановления: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { restoreDatabase, findLatestBackup };
