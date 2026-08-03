#!/usr/bin/env node
'use strict';

// YAAM — применение миграций PostgreSQL отдельной командой (Stage 16, шаг 15
// плана деплоя).
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ ЗАПУСКА ПРИЛОЖЕНИЯ. Приложение и так применяет миграции
// при старте, но во время деплоя порядок другой: сначала миграции, потом
// установка systemd-юнита, потом запуск. Если миграция падает под systemd,
// юнит уходит в цикл перезапусков, а причина тонет в journal. Отдельная
// команда даёт результат немедленно и с понятным кодом возврата.
//
// Никаких «force» и «reset» здесь нет намеренно: единственное действие —
// применить недостающие миграции. Откат разрушающих изменений выполняется
// восстановлением из backup, а не флагом.
require('dotenv').config();

const migrator = require('../services/postgresql/migrator');
const db = require('../db/postgresql');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  try {
    if (dryRun) {
      // Ничего не применяет: только показывает, что было бы сделано.
      const status = await migrator.getMigrationStatus();
      console.log(`[migrate] применено: ${status.applied} из ${status.total}`);
      if (status.pending.length) {
        console.log(`[migrate] будут применены версии: ${status.pending.join(', ')}`);
      } else {
        console.log('[migrate] непринятых миграций нет');
      }
      return 0;
    }

    const result = await migrator.migrate({ logger: console });
    if (result.applied.length === 0) {
      console.log('[migrate] нечего применять — база уже актуальна');
    } else {
      for (const a of result.applied) {
        console.log(`[migrate] ${a.adopted ? 'отмечена' : 'применена'} ${a.version}_${a.name}`);
      }
    }
    return 0;
  } catch (err) {
    // Сообщение миграторa уже объясняет, что именно не так и что данные не
    // изменены. Стек наружу не выводим: он ничего не добавляет оператору.
    console.error(err.message);
    return 1;
  } finally {
    await db.close().catch(() => {});
  }
}

main().then((code) => process.exit(code));
