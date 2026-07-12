// C3 (аудит готовности к VPS): гарантия единственного экземпляра backend.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { acquireLock, releaseLock, isProcessAlive } = require('../singleInstanceLock');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-lock-test-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

function freshLockPath() {
  return path.join(workDir, `lock-${Math.random().toString(36).slice(2)}.pid`);
}

test('isProcessAlive(process.pid) для текущего процесса — true', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('isProcessAlive() для заведомо несуществующего pid — false', () => {
  assert.equal(isProcessAlive(999999999), false);
});

test('isProcessAlive() для некорректного значения (0, отрицательное, NaN) — false, без исключений', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(NaN), false);
});

test('acquireLock() без существующего lock-файла создаёт файл с текущим PID', () => {
  const lockPath = freshLockPath();
  const returned = acquireLock(lockPath);
  assert.equal(returned, lockPath);
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
});

test('acquireLock() бросает исключение, если lock уже держит живой процесс (симуляция: свой же PID)', () => {
  const lockPath = freshLockPath();
  fs.writeFileSync(lockPath, String(process.pid)); // "другой" процесс — но заведомо живой (это мы сами)
  assert.throws(() => acquireLock(lockPath), /уже запущенный процесс backend/);
});

test('acquireLock() подхватывает устаревший (stale) lock от мёртвого процесса, не бросая исключение', () => {
  const lockPath = freshLockPath();
  fs.writeFileSync(lockPath, '999999999'); // заведомо мёртвый pid
  const returned = acquireLock(lockPath);
  assert.equal(returned, lockPath);
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid), 'lock должен быть перезаписан текущим PID');
});

test('acquireLock() создаёт директорию для lock-файла, если её ещё нет', () => {
  const lockPath = path.join(workDir, 'nested', 'dir', 'yaam-backend.pid');
  const returned = acquireLock(lockPath);
  assert.equal(returned, lockPath);
  assert.equal(fs.existsSync(lockPath), true);
});

test('releaseLock() удаляет lock-файл, если он принадлежит текущему процессу', () => {
  const lockPath = freshLockPath();
  acquireLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true);
  releaseLock(lockPath);
  assert.equal(fs.existsSync(lockPath), false);
});

test('releaseLock() НЕ удаляет lock-файл, если он принадлежит другому PID (нельзя чужой лок случайно снять)', () => {
  const lockPath = freshLockPath();
  fs.writeFileSync(lockPath, '424242'); // чужой (не наш) PID
  releaseLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true, 'releaseLock не должен трогать лок другого владельца');
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), '424242');
});

test('releaseLock() на несуществующем lock-файле не бросает исключение', () => {
  const lockPath = freshLockPath();
  assert.doesNotThrow(() => releaseLock(lockPath));
});
