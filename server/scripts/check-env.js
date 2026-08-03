#!/usr/bin/env node
'use strict';

// YAAM — предварительная проверка конфигурации окружения (Stage 16, шаг 12
// плана деплоя).
//
// ЗАЧЕМ ОТДЕЛЬНОЙ КОМАНДОЙ. Приложение и так падает на некорректной
// конфигурации, но во время деплоя это происходит уже под systemd: юнит
// начинает перезапускаться, а причина видна только в journal. Отдельная
// команда даёт тот же ответ ДО установки юнита, за секунду и с понятным
// текстом.
//
// Ничего не меняет и никуда не подключается — только читает переменные.
// Значения секретов не печатает: в выводе только имена и суть проблемы.
require('dotenv').config();

const { inspectEnv } = require('../services/config/env');

function main() {
  let result;
  try {
    result = inspectEnv(process.env);
  } catch (err) {
    console.error(`[check-env] ${err.message}`);
    process.exit(1);
  }

  const { mode, errors, warnings } = result;
  console.log(`[check-env] режим: ${mode}`);

  for (const w of warnings) console.warn(`[check-env] предупреждение: ${w}`);

  if (errors.length > 0) {
    console.error(`[check-env] запуск невозможен, проблем: ${errors.length}`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log('[check-env] конфигурация допускает запуск'
    + (warnings.length ? ` (предупреждений: ${warnings.length})` : ''));
  process.exit(0);
}

main();
