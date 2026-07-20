'use strict';

// YAAM — PostgreSQL app lifecycle manager, Production Switch Stage 6
// (operational infrastructure). Изолированный, не подключённый к production
// модуль.
//
// SQLite-оригинал (server.js) НЕ имеет lifecycle-абстракции вообще: старт —
// последовательность разрозненных top-level вызовов, "graceful shutdown" —
// один `process.on('SIGTERM'/'SIGINT', shutdown)`, где `shutdown()` только
// освобождает PID-lock-файл (`singleInstanceLock.js`) и сразу
// `process.exit(0)` — НЕ закрывает HTTP-сервер, НЕ гасит три `setInterval`,
// НЕ закрывает БД-соединение. Задание Stage 6 прямо требует явную
// lifecycle-модель для PostgreSQL-стороны — это НОВАЯ инфраструктура, не
// перенос существующей (переносить нечего).
//
// НЕ вызывает process.exit() нигде внутри себя — только координирует
// start/stop конкретных подсистем и уведомляет вызывающий код через
// onSignal()/onShutdown(). Это принципиально для тестируемости: тест может
// синтетически эмитировать SIGTERM (`process.emit('SIGTERM')`) и проверить,
// что lifecycle корректно остановился, не убивая сам процесс тестового
// раннера. Настоящий `process.exit()` — ответственность конкретной точки
// входа (server/server.postgresql.js), не переиспользуемого модуля.
//
// singleInstanceLock.js (SQLite-специфичный PID-lock) сюда сознательно НЕ
// перенесён и не имеет PostgreSQL-аналога: он существовал из-за ограничений
// именно SQLite (единственный писатель, in-process createOrder()-атомарность,
// дублирующиеся setInterval-свипы двух процессов — см.
// server/docs/single-instance.md) — PostgreSQL клиент-серверная СУБД с
// нормальной многопользовательской конкурентностью, что и было целью всей
// Concurrency Strategy (Wave 1-7): два живых PostgreSQL-процесса с
// собственными schedulers БЕЗОПАСНЫ (см. Stage 5, тест L2 — два конкурентных
// scheduler-инстанса не мешают друг другу, идемпотентно). Реинтродукция
// single-instance ограничения для PostgreSQL была бы избыточным переносом
// SQLite-специфичного воркэраунда в архитектуру, где он не нужен.

const dbBootstrap = require('../../db/postgresql/bootstrap');
const db = require('../../db/postgresql');

function createLifecycle({
  schedulers = [],
  httpServer = null,
  onShutdown,
  onSignal,
  signals = ['SIGTERM', 'SIGINT'],
} = {}) {
  let started = false;
  let stopping = false;
  const signalHandlers = new Map();

  async function start(options = {}) {
    if (started) return; // идемпотентно — повторный start() на уже запущенном lifecycle безопасен
    await dbBootstrap.bootstrap(options.bootstrap);
    for (const scheduler of schedulers) scheduler.start();

    for (const signal of signals) {
      const handler = () => {
        stop()
          .then(() => {
            if (onSignal) onSignal(signal, null);
          })
          .catch((err) => {
            if (onSignal) onSignal(signal, err);
          });
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    started = true;
  }

  async function stop() {
    if (stopping) return; // идемпотентно — не запускает второй параллельный shutdown
    if (!started) return; // stop() до start() — безопасный no-op
    stopping = true;
    try {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.clear();

      await Promise.all(schedulers.map((scheduler) => scheduler.stop()));

      if (httpServer) {
        await new Promise((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }

      if (onShutdown) await onShutdown();

      await db.close();
      started = false;
    } finally {
      stopping = false;
    }
  }

  function isRunning() {
    return started;
  }

  return { start, stop, isRunning };
}

module.exports = { createLifecycle };
