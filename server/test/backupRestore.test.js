// C2 (аудит готовности к VPS): backup/restore для SQLite.
// Проверяем весь цикл целиком: бэкап живой базы -> база "портится" -> restore
// -> данные снова такие же, как на момент бэкапа. Плюс: safety-копия перед
// перезаписью и ротация старых бэкапов (retention).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload,
} = require('./helpers/testDb');
const { backupDatabase, pruneOldBackups } = require('../scripts/backup-db');
const { restoreDatabase, findLatestBackup } = require('../scripts/restore-db');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-backup-test-'));

after(() => {
  cleanupDbFile(dbPath);
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test('backupDatabase() создаёт файл бэкапа с текущими данными базы', async () => {
  const { restaurantId, menuItemId } = seedMinimalRestaurant(db, { name: 'Ресторан до бэкапа' });
  const protectedOrder = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79280002001' }),
  );

  const destPath = await backupDatabase({ dbPath, backupDir });
  assert.equal(fs.existsSync(destPath), true);

  const { DatabaseSync } = require('node:sqlite');
  const backupDb = new DatabaseSync(destPath, { readOnly: true });
  const row = backupDb.prepare('SELECT name FROM restaurants WHERE name = ?').get('Ресторан до бэкапа');
  const credential = backupDb.prepare(`
    SELECT a.token_hash, a.create_key_hash, a.request_hash
    FROM order_access_credentials a WHERE a.order_id = ?
  `).get(protectedOrder.order.id);
  const presentation = backupDb.prepare(`
    SELECT pp.qr_payload FROM payment_presentations pp
    JOIN payments p ON p.id = pp.payment_id WHERE p.order_id = ?
  `).get(protectedOrder.order.id);
  backupDb.close();
  assert.ok(row, 'бэкап должен содержать ресторан, добавленный до backupDatabase()');
  assert.equal(credential.token_hash.length, 32, 'бэкап должен сохранять hash доступа к заказу');
  assert.equal(credential.create_key_hash.length, 32, 'бэкап должен сохранять idempotency hash');
  assert.equal(credential.request_hash.length, 32, 'бэкап должен сохранять привязку ключа к запросу');
  assert.match(presentation.qr_payload, /^yaam-demo:\/\/pay\//, 'бэкап должен сохранять данные продолжения оплаты');
});

test('restoreDatabase() возвращает базу к состоянию бэкапа после порчи данных', async () => {
  seedMinimalRestaurant(db, { name: 'Ресторан для restore-теста' });
  const backupPath = await backupDatabase({ dbPath, backupDir });

  db.exec("DELETE FROM restaurants WHERE name = 'Ресторан для restore-теста'");
  const goneCheck = db.prepare('SELECT * FROM restaurants WHERE name = ?').get('Ресторан для restore-теста');
  assert.equal(goneCheck, undefined, 'подготовка теста: запись должна быть удалена перед restore');

  const result = restoreDatabase(backupPath, { dbPath, backupDir });
  assert.equal(result.restoredFrom, backupPath);
  assert.ok(result.safetyCopyPath, 'restore должен был создать safety-копию текущей (испорченной) базы перед перезаписью');
  assert.equal(fs.existsSync(result.safetyCopyPath), true);

  const { DatabaseSync } = require('node:sqlite');
  const restoredDb = new DatabaseSync(dbPath, { readOnly: true });
  const row = restoredDb.prepare('SELECT name FROM restaurants WHERE name = ?').get('Ресторан для restore-теста');
  restoredDb.close();
  assert.ok(row, 'после restore запись, существовавшая на момент бэкапа, должна вернуться');

  fs.unlinkSync(result.safetyCopyPath);
});

test('restoreDatabase() без аргумента берёт самый свежий файл из backupDir', async () => {
  const olderBackup = await backupDatabase({ dbPath, backupDir });
  await new Promise((resolve) => setTimeout(resolve, 10));
  seedMinimalRestaurant(db, { name: 'Ресторан в самом свежем бэкапе' });
  const newerBackup = await backupDatabase({ dbPath, backupDir });

  assert.equal(findLatestBackup(backupDir), newerBackup);
  assert.notEqual(olderBackup, newerBackup);

  const result = restoreDatabase(undefined, { dbPath, backupDir });
  assert.equal(result.restoredFrom, newerBackup);
  if (result.safetyCopyPath) fs.unlinkSync(result.safetyCopyPath);
});

test('pruneOldBackups() оставляет только retentionCount самых свежих файлов', async () => {
  const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-backup-prune-test-'));
  try {
    for (let i = 0; i < 5; i += 1) {
      await backupDatabase({ dbPath, backupDir: pruneDir, retentionCount: 999 });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let files = fs.readdirSync(pruneDir).filter((n) => /^yaam-.*\.db$/.test(n));
    assert.equal(files.length, 5);

    pruneOldBackups(pruneDir, 2);
    files = fs.readdirSync(pruneDir).filter((n) => /^yaam-.*\.db$/.test(n));
    assert.equal(files.length, 2, 'после pruneOldBackups(dir, 2) должно остаться ровно 2 файла');
  } finally {
    fs.rmSync(pruneDir, { recursive: true, force: true });
  }
});

test('restoreDatabase() без бэкапов в пустой директории и без явного пути бросает понятную ошибку', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-backup-empty-test-'));
  try {
    assert.throws(() => restoreDatabase(undefined, { dbPath, backupDir: emptyDir }), /Не найдено ни одного файла|Не передан путь/);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});
