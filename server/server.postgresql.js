'use strict';

// YAAM — PostgreSQL server entry point, Production Switch Stage 6
// (operational infrastructure).
//
// Изолированный аналог server.js для PostgreSQL-стороны — НИКЕМ не
// требуется (`require`), НИКОГДА не запускается автоматически, не
// упоминается ни в systemd-юните (`deploy/yaam-backend.service`), ни в
// `npm start`. Запуск — только вручную (`node server.postgresql.js` или
// `npm run start:postgresql`), для staging-валидации будущих этапов
// (Stage 7+). server.js не изменён ни строкой.
//
// НАМЕРЕННО не монтирует routes/postgresql/api.js / routes/postgresql/
// admin.js / bot/postgresql — задание Stage 6 явно ограничивает scope
// операционной инфраструктурой (bootstrap/lifecycle/health/graceful
// shutdown), не переносом бизнес-маршрутов в новую точку входа: решения о
// CORS/dev-route-gating/webhook raw-body и т.п. для реального
// PostgreSQL-приложения — предмет отдельной, будущей задачи (Stage 7/8), не
// этой. Этот файл даёт полный, живой, протестированный СКЕЛЕТ (bootstrap →
// scheduler → health-эндпоинты → graceful shutdown), в который такое
// монтирование позже добавляется без переписывания lifecycle-механики.
//
// Использует только PostgreSQL-слой (db/postgresql, services/postgresql) —
// не импортирует ../db (SQLite) и не требует server/services/orderService.js.

require('dotenv').config();

const express = require('express');
const { createPauseExpiryScheduler } = require('./services/postgresql/scheduler');
const { createHealthCheck } = require('./services/postgresql/health');
const { createLifecycle } = require('./services/postgresql/lifecycle');

const DEFAULT_PORT = 3001; // намеренно ОТЛИЧАЕТСЯ от server.js (3000) — оба
// процесса на одной машине не должны конфликтовать за порт, если когда-либо
// запущены одновременно (staging-эксперимент рядом с рабочим SQLite-сервером).
const DEFAULT_HOST = '127.0.0.1';

// createApp(options) — фабрика, не auto-start: возвращает управляемый
// инстанс { app, start(), stop(), isRunning() }, ничего не запускает сама.
// options.port/host — для тестов (эфемерный порт); options.schedulerIntervalMs
// — для тестов (короткий интервал вместо реальных 30с).
function createApp({
  port = Number(process.env.PG_HEALTH_PORT || DEFAULT_PORT),
  host = process.env.PG_HEALTH_HOST || DEFAULT_HOST,
  schedulerIntervalMs,
  bootstrapOptions,
} = {}) {
  const scheduler = createPauseExpiryScheduler(
    schedulerIntervalMs ? { intervalMs: schedulerIntervalMs } : undefined
  );
  const health = createHealthCheck({ getSchedulers: () => [scheduler] });

  const app = express();

  // Liveness — процесс жив, event loop отвечает; НЕ проверяет БД (см.
  // health.js header-комментарий) — не должен падать во время временного
  // сбоя PostgreSQL.
  app.get('/health/live', async (req, res) => {
    const result = await health.liveness();
    res.status(200).json(result);
  });

  // Readiness — реальная проверка БД/пула/scheduler'а. 503, если что-то не
  // готово — стандартный контракт для readiness-проб (не 200 с ok:false).
  app.get('/health/ready', async (req, res) => {
    const result = await health.readiness();
    res.status(result.ok ? 200 : 503).json(result);
  });

  // GET /health — тот же readiness-контракт, что и /health/ready: для этого
  // изолированного скелета "готовность" и есть содержательный смысл
  // "здоров ли сервис" (в отличие от SQLite server.js, где /health сегодня —
  // безусловный {ok:true} без проверки зависимостей).
  app.get('/health', async (req, res) => {
    const result = await health.readiness();
    res.status(result.ok ? 200 : 503).json(result);
  });

  let httpServer = null;
  let lifecycle = null;

  async function start() {
    httpServer = await new Promise((resolve, reject) => {
      const srv = app.listen(port, host, () => resolve(srv));
      srv.on('error', reject);
    });

    lifecycle = createLifecycle({
      schedulers: [scheduler],
      httpServer,
      onSignal: (signal) => {
        console.log(`[server.postgresql] получен ${signal}, завершение...`);
        process.exit(0);
      },
    });

    try {
      await lifecycle.start({ bootstrap: bootstrapOptions });
    } catch (err) {
      // Fail fast: HTTP-сервер уже слушает (liveness отвечал бы), но БД
      // недостижима — закрываем всё и пробрасываем понятную причину наверх,
      // не оставляя процесс в полуживом состоянии.
      await new Promise((resolve) => httpServer.close(resolve));
      throw err;
    }

    console.log(`[server.postgresql] слушает на ${host}:${port} (health-эндпоинты, scheduler запущен)`);
  }

  async function stop() {
    if (lifecycle) await lifecycle.stop();
  }

  function isRunning() {
    return Boolean(lifecycle && lifecycle.isRunning());
  }

  // Реальный слушаемый адрес — нужен тестам, использующим port:0
  // (эфемерный порт, назначаемый ОС), чтобы узнать, куда фактически слать
  // запросы.
  function address() {
    return httpServer ? httpServer.address() : null;
  }

  return { app, start, stop, isRunning, address, scheduler, health };
}

// Реальная точка входа — выполняется ТОЛЬКО при прямом запуске
// (`node server.postgresql.js`), не при require() из теста/другого модуля.
async function main() {
  const instance = createApp();

  process.on('unhandledRejection', (reason) => {
    console.error('[server.postgresql] unhandledRejection:', reason instanceof Error ? reason.message : reason);
    instance.stop().finally(() => process.exit(1));
  });
  process.on('uncaughtException', (err) => {
    console.error('[server.postgresql] uncaughtException:', err.message);
    instance.stop().finally(() => process.exit(1));
  });

  try {
    await instance.start();
  } catch (err) {
    console.error('[server.postgresql] фатальная ошибка старта:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { createApp, main };
