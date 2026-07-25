#!/usr/bin/env node
'use strict';

// Удобная команда для владельца YAAM: печатает готовое значение
// HQ_ADMIN_PASSWORD_HASH для вставки в .env/.env.postgresql. Ничего не
// пишет на диск и никуда не отправляет пароль — только hashPassword()
// (server/services/hq/passwordHash.js) и вывод в stdout.
//
// Использование:
//   node scripts/hash-hq-password.js "мой-пароль"
// или интерактивно (пароль не останется в истории shell):
//   node scripts/hash-hq-password.js
//   > пароль: ******

const { hashPassword } = require('../services/hq/passwordHash');

async function readPasswordFromStdin() {
  process.stdout.write('Пароль для HQ_ADMIN_PASSWORD_HASH: ');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.resume();
  });
}

async function main() {
  const argPassword = process.argv[2];
  const password = argPassword || (await readPasswordFromStdin());
  if (!password) {
    console.error('Пароль не может быть пустым.');
    process.exitCode = 1;
    return;
  }
  const hash = await hashPassword(password);
  console.log('\nHQ_ADMIN_PASSWORD_HASH=' + hash);
}

main().catch((err) => {
  console.error('Не удалось создать хеш:', err.message);
  process.exitCode = 1;
});
