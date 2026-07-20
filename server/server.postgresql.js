'use strict';

// YAAM — PostgreSQL server entry point.
//
// Изолированный аналог server.js для PostgreSQL-стороны — НИКЕМ не
// требуется (`require`), НИКОГДА не запускается автоматически, не
// упоминается ни в systemd-юните (`deploy/yaam-backend.service`), ни в
// `npm start`. Запуск — только вручную (`node server.postgresql.js` или
// `npm run start:postgresql`), для staging-валидации (Stage 7+). server.js
// не изменён ни строкой.
//
// Production Switch — Stage 7: этот файл теперь ТОЛЬКО точка входа —
// создание процесса, сигнал-обработчики верхнего уровня, единственное
// место, где вызывается настоящий process.exit(). Вся сборка приложения
// (middleware, маршруты, CORS, readiness-гейт, bot lifecycle) переехала в
// server/services/postgresql/app.js (createPostgresqlApp()) — переиспользуемый,
// require()-безопасный модуль, тестируемый без реального listen()/exit().
// До Stage 7 этот файл САМ содержал createApp() и монтировал только
// health-эндпоинты (операционный скелет Stage 6, без бизнес-маршрутов) — см.
// server/docs/postgresql-application-assembly.md за полной картой того, что
// добавилось.
//
// Использует только PostgreSQL-слой (db/postgresql, services/postgresql,
// routes/postgresql, bot/postgresql) — не импортирует ../db (SQLite) и не
// требует server/services/orderService.js.

require('dotenv').config();

const { createPostgresqlApp } = require('./services/postgresql/app');

// createApp(options) — тонкая обёртка над createPostgresqlApp(), сохраняет
// имя/форму экспорта, установленную Stage 6 (`{app, start(), stop(),
// isRunning(), address(), scheduler, health}`), чтобы существующие Stage 6
// тесты (`operationalStage6.test.js`) продолжали работать без изменений —
// createPostgresqlApp() возвращает надмножество той же формы.
function createApp(options = {}) {
  return createPostgresqlApp(options);
}

// Реальная точка входа — выполняется ТОЛЬКО при прямом запуске
// (`node server.postgresql.js`), не при require() из теста/другого модуля.
async function main() {
  const instance = createApp({
    onSignal: (signal) => {
      console.log(`[server.postgresql] получен ${signal}, завершение...`);
      process.exit(0);
    },
  });

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
    const { port, address: host } = instance.address();
    console.log(`[server.postgresql] слушает на ${host}:${port}`);
  } catch (err) {
    console.error('[server.postgresql] фатальная ошибка старта:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { createApp, main };
