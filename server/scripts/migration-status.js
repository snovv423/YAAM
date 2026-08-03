#!/usr/bin/env node
'use strict';

// YAAM — статус миграций (Stage 16, шаг 13 плана деплоя: «проверка
// существующей схемы БД»).
//
// Только читает. Показывает, что применено, что ждёт применения и совместима
// ли существующая схема с текущим кодом — тот же fingerprint, который
// migrator использует перед адопцией baseline. Это и есть безопасный способ
// заглянуть в незнакомую базу до первого запуска нового кода.
require('dotenv').config();

const migrator = require('../services/postgresql/migrator');
const db = require('../db/postgresql');

async function main() {
  try {
    const status = await migrator.getMigrationStatus();
    console.log(`[migrations] применено: ${status.applied} из ${status.total}`);
    console.log(`[migrations] ожидают: ${status.pending.length ? status.pending.join(', ') : 'нет'}`);

    const client = await db.getPool().connect();
    try {
      const empty = await migrator.isDatabaseEmpty(client);
      console.log(`[schema] база пуста: ${empty ? 'да' : 'нет'}`);
      if (!empty) {
        const fp = await migrator.inspectSchemaFingerprint(client);
        console.log(`[schema] таблиц: ${fp.tableCount}`);
        console.log(`[schema] совместима с текущим кодом: ${fp.compatible ? 'да' : 'НЕТ'}`);
        if (!fp.compatible) {
          console.log(`[schema] не хватает (${fp.missing.length}):`);
          for (const m of fp.missing) console.log(`  - ${m}`);
        }
      }
    } finally {
      client.release();
    }
    return 0;
  } catch (err) {
    console.error(`[migrations] не удалось получить статус: ${err.message}`);
    return 1;
  } finally {
    await db.close().catch(() => {});
  }
}

main().then((code) => process.exit(code));
