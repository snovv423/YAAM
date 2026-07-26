#!/usr/bin/env node
'use strict';

// YAAM HQ Stage 3 — аварийное восстановление доступа владельца.
//
// Работает ТОЛЬКО локально, руками, на самом VPS (прямой доступ к процессу
// и к DATABASE_URL) — не публичный endpoint, не часть HTTP-приложения,
// никакого сетевого API. Требует DATABASE_URL в окружении — тот же способ
// подключения, что и у db/postgresql/seed.js/scripts/backup-db.js.
//
// Алгоритм (задание, раздел 7): спросить новый логин, спросить новый
// пароль, сгенерировать hash, ЗАМЕНИТЬ запись владельца (или создать, если
// её почему-то ещё нет), увеличить credentials_version, вывести
// "HQ owner reset completed." — без единого вывода пароля ни на одном шаге.
//
// "Завершает все активные сессии" — не отдельное действие: увеличение
// credentials_version уже И ЕСТЬ этот механизм (см. db/postgresql/schema.sql,
// комментарий у hq_owner, и routes/hq/middleware.js) — любая существующая
// сессия на следующий же запрос увидит несовпадающую версию и будет
// принудительно разлогинена, включая случай "владелец забыл пароль и
// параллельно где-то ещё осталась чужая залогиненная сессия".
//
// Пароль вводится открытым текстом (без маскировки ввода в терминале) — тот
// же, уже принятый в этом проекте компромисс, что и в
// scripts/hash-hq-password.js (см. его же заголовок): не тянуть отдельную
// зависимость ради маскировки stdin в CLI-инструменте, запускаемом руками
// один раз при инциденте.
const readline = require('node:readline');
const { stdin, stdout } = require('node:process');
const { hashPassword } = require('../services/hq/passwordHash');
const ownerService = require('../services/hq/ownerService');
const { logSecurityEvent } = require('../services/hq/securityLog');
const db = require('../db/postgresql');

// ВАЖНО, проверено эмпирически: await между двумя последовательными
// rl.question() (в т.ч. через readline/promises) при НЕ-TTY (piped) stdin
// гонится с тем, что readline закрывает интерфейс по EOF входного потока —
// второй question() в части случаев просто никогда не вызывает свой
// callback. Оба question() здесь поэтому ВЛОЖЕНЫ синхронно друг в друга
// (без await между ними) внутри одного Promise — эта же самая функция
// проверена и на реальном piped вводе (см. тест reset-hq-owner CLI),
// не только в интерактивном терминале.
function askLoginAndPassword(rl) {
  return new Promise((resolve) => {
    rl.question('Новый логин HQ: ', (loginAnswer) => {
      rl.question('Новый пароль HQ: ', (passwordAnswer) => {
        resolve({ login: loginAnswer.trim(), password: passwordAnswer });
      });
    });
  });
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let login;
  let password;
  try {
    ({ login, password } = await askLoginAndPassword(rl));
  } finally {
    rl.close();
  }

  if (!login) {
    throw new Error('Логин не может быть пустым.');
  }
  if (!password) {
    throw new Error('Пароль не может быть пустым.');
  }

  const passwordHash = await hashPassword(password);
  await ownerService.resetOwner({ login, passwordHash });
  await logSecurityEvent({ eventType: 'emergency_reset', ip: 'cli' });

  console.log('HQ owner reset completed.');
}

main()
  .catch((err) => {
    console.error('Не удалось выполнить сброс:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
