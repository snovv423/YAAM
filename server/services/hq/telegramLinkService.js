'use strict';

// YAAM HQ — привязка рабочей Telegram-группы ресторана
// (docs/HQ-PRODUCT-SPEC.md, раздел «Telegram-подключение»).
//
// Роли строго разделены: HQ (владелец YAAM) ВЫДАЁТ одноразовый код, сама
// привязка происходит в Telegram-группе ресторана командой /start КОД
// (bot/postgresql/index.js) — HQ никогда не привязывает чат напрямую,
// потому что chat_id физически известен только Telegram-стороне.
//
// Что этот сервис гарантирует:
//   1. код одноразовый — consumeConnectCode() очищает connect_code той же
//      транзакцией, что и записывает telegram_chat_id, поэтому повторный
//      /start тем же кодом уже не найдёт ресторан;
//   2. один чат не может обслуживать два ресторана — привязка отклоняется,
//      если этот chat_id уже закреплён за другим рестораном (частичный
//      UNIQUE-индекс в схеме — последняя линия защиты, здесь же понятная
//      ошибка вместо сырой 23505);
//   3. после подключения код нигде не показывается (в HQ его просто нет в
//      данных — он очищен).
const crypto = require('node:crypto');
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');

// Формат кода: YAAM-XXXXXX из алфавита без похожих символов (0/O, 1/I/L) —
// код диктуют голосом и набирают руками в Telegram.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return `YAAM-${out}`;
}

// Новый код подключения. Если ресторан уже подключён — сначала нужно явно
// «Переподключить»/«Отключить» (см. ниже): молча выпускать код для уже
// подключённого ресторана значило бы держать одновременно два рабочих пути
// привязки.
async function issueConnectCode(restaurantId) {
  const rows = await db.query('SELECT id, telegram_chat_id FROM restaurants WHERE id = $1', [restaurantId]);
  const restaurant = rows[0];
  if (!restaurant) throw new ValidationError('Ресторан не найден.');
  if (restaurant.telegram_chat_id) {
    throw new ValidationError('Ресторан уже подключён — сначала переподключите или отключите текущую группу.');
  }
  // UNIQUE(connect_code) в схеме: на коллизию (вероятность ничтожна, но она
  // не ноль) просто пробуем ещё раз, а не падаем на пользователя.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    try {
      // eslint-disable-next-line no-await-in-loop
      const updated = await db.execute(
        'UPDATE restaurants SET connect_code = $1 WHERE id = $2 RETURNING connect_code',
        [code, restaurantId],
      );
      return updated.rows[0].connect_code;
    } catch (err) {
      if (err && err.code === '23505') continue;
      throw err;
    }
  }
  throw new ValidationError('Не удалось выпустить код подключения — попробуйте ещё раз.');
}

// Вызывается ботом при /start КОД. Возвращает подключённый ресторан либо
// null, если код не найден/уже использован. chatTitle — название группы,
// показывается владельцу в HQ вместо технического chat_id.
async function consumeConnectCode(code, chatId, chatTitle = null) {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!normalized) return null;
  return db.transaction(async (client) => {
    const rows = await db.query(
      'SELECT * FROM restaurants WHERE connect_code = $1 FOR UPDATE',
      [normalized],
      client,
    );
    const restaurant = rows[0];
    if (!restaurant) return null;

    const takenRows = await db.query(
      'SELECT id, name FROM restaurants WHERE telegram_chat_id = $1 AND id <> $2',
      [String(chatId), restaurant.id],
      client,
    );
    if (takenRows[0]) {
      throw new ValidationError('Эта группа уже привязана к другому ресторану.');
    }

    // Код гасится ТОЙ ЖЕ транзакцией, что и привязка — состояние «чат
    // привязан, а код всё ещё рабочий» структурно недостижимо.
    const updated = await db.execute(
      `UPDATE restaurants
          SET telegram_chat_id = $1, telegram_chat_title = $2, connect_code = NULL
        WHERE id = $3 RETURNING *`,
      [String(chatId), chatTitle, restaurant.id],
      client,
    );
    return updated.rows[0];
  });
}

// «Отключить» — снимает привязку, код не выпускается (владелец выпустит его
// отдельной кнопкой, когда группа будет готова).
async function disconnect(restaurantId) {
  const updated = await db.execute(
    `UPDATE restaurants SET telegram_chat_id = NULL, telegram_chat_title = NULL, connect_code = NULL
      WHERE id = $1 RETURNING *`,
    [restaurantId],
  );
  return updated.rows[0] || null;
}

// «Переподключить» — отвязать и сразу выпустить новый код (одно действие
// владельца, а не два).
async function reconnect(restaurantId) {
  await disconnect(restaurantId);
  return issueConnectCode(restaurantId);
}

async function getLinkState(restaurantId) {
  const rows = await db.query(
    'SELECT telegram_chat_id, telegram_chat_title, connect_code FROM restaurants WHERE id = $1',
    [restaurantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    connected: Boolean(row.telegram_chat_id),
    chatTitle: row.telegram_chat_title || null,
    // Код отдаётся наружу ТОЛЬКО пока ресторан не подключён — после привязки
    // он в БД уже NULL (см. consumeConnectCode).
    connectCode: row.telegram_chat_id ? null : (row.connect_code || null),
    chatId: row.telegram_chat_id || null,
  };
}

module.exports = {
  CODE_LENGTH,
  generateCode,
  issueConnectCode,
  consumeConnectCode,
  disconnect,
  reconnect,
  getLinkState,
};
