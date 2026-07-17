'use strict';

// Общие примитивы для concurrency-тестов (YAAM-postgresql-concurrency-
// strategy.pdf, Задача 2). Ключевое требование задания: "не принимать за
// concurrency-тест обычный Promise.all без доказательства пересечения
// критической секции" — waitForBackendLock() даёт именно это доказательство:
// опрашивает pg_stat_activity С ОТДЕЛЬНОГО клиента-наблюдателя, пока целевой
// backend (по его pg_backend_pid()) не окажется в состоянии ожидания
// блокировки. Пока этот вызов не вернулся успешно, тест не имеет права
// утверждать, что вторая транзакция "должна была" пересечься с первой —
// только после него это доказанный факт, а не предположение о планировщике.

if (process.env.NODE_ENV !== 'test') {
  throw new Error('server/test/postgresql/helpers/concurrency.js requires NODE_ENV=test');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Опрашивает pg_stat_activity, пока backend с данным pid не покажет
// wait_event_type='Lock' (то есть реально блокируется на чужой блокировке
// прямо сейчас), либо не истечёт timeoutMs — тогда бросает с диагностикой.
async function waitForBackendLock(monitorClient, pid, { timeoutMs = 5000, pollMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { rows } = await monitorClient.query(
      `SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1`,
      [pid]
    );
    last = rows[0] || null;
    if (last && last.wait_event_type === 'Lock') return last;
    await sleep(pollMs);
  }
  throw new Error(
    `backend pid=${pid} не перешёл в ожидание блокировки за ${timeoutMs}мс ` +
      `(последнее наблюдаемое состояние: ${JSON.stringify(last)})`
  );
}

// pg.Client не даёт .processID синхронно до подключения — тонкий враппер для
// читаемости в тестах: подключает клиент и возвращает его вместе с pid.
async function connectWithPid(client) {
  await client.connect();
  return client.processID;
}

module.exports = { sleep, waitForBackendLock, connectWithPid };
