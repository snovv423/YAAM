// C3 (аудит готовности к VPS): гарантия единственного экземпляра backend.
//
// orderService.createOrder() полагается на то, что node:sqlite синхронен и вся
// транзакция выполняется одним блоком без интерливинга с другим createOrder() —
// это верно ТОЛЬКО внутри одного процесса. sweepTimeouts()/sweepPauseExpiry()
// в server.js — тоже in-process setInterval; при двух живых процессах оба
// сразу начнут дублировать один и тот же autoswip. Systemd сам по себе не
// исключает двух живых процессов (например, случайный повторный `npm start`
// в соседнем терминале, пока systemd-юнит уже запущен) — нужна runtime-проверка.
//
// Механизм: PID-файл + process.kill(pid, 0) (не шлёт сигнал, просто проверяет,
// жив ли процесс). Если файл есть и PID в нём жив — второй процесс отказывается
// стартовать. Если PID в файле мёртв (процесс упал, не успев освободить lock) —
// это considered "stale lock", он подхватывается новым процессом.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCK_PATH = process.env.SINGLE_INSTANCE_LOCK_PATH
  || path.join(__dirname, 'db', 'yaam-backend.pid');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false; // процесса с таким pid нет
    if (err.code === 'EPERM') return true; // процесс жив, но принадлежит другому пользователю
    throw err;
  }
}

// Бросает исключение, если другой живой процесс уже держит лок. Иначе
// записывает свой PID в lock-файл (перезаписывая устаревший/мёртвый лок) и
// возвращает использованный путь — его нужно передать в releaseLock().
function acquireLock(lockPath = DEFAULT_LOCK_PATH) {
  if (fs.existsSync(lockPath)) {
    const existingPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (isProcessAlive(existingPid)) {
      throw new Error(
        `Обнаружен уже запущенный процесс backend (pid=${existingPid}, lock-файл: ${lockPath}). `
        + 'Одновременный запуск нескольких экземпляров запрещён (см. server/docs/single-instance.md). '
        + 'Остановите его перед повторным запуском.',
      );
    }
    console.warn(`[single-instance-lock] найден устаревший lock от неживого процесса (pid=${existingPid}) — забираю`);
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

// Снимает лок, только если он всё ещё принадлежит текущему процессу — на
// случай, если lockPath уже был перехвачен кем-то другим (не должно
// происходить при нормальной работе, но чужой лок точно не должен удаляться).
function releaseLock(lockPath = DEFAULT_LOCK_PATH) {
  try {
    const owner = fs.readFileSync(lockPath, 'utf8').trim();
    if (owner === String(process.pid)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // лока уже нет — ничего освобождать не нужно
  }
}

module.exports = { acquireLock, releaseLock, isProcessAlive, DEFAULT_LOCK_PATH };
