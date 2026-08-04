'use strict';

// Stage 27 — юнит-тесты server/hq/dateFormat.js (toMskDate), закрывающие
// возможный дефект часового пояса из Stage 26, раздел 2: владелец вводил
// "20:00" по Москве и на карточке выплаты видел "17:00" без единого
// объяснения (сырые getUTCHours() без сдвига в hq/payoutViews.js и др.).
// Хранение остаётся UTC (миграции/БД не менялись) — меняется только то, как
// PostgreSQL-значение превращается в строку для владельца.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toMskDate, MSK_SUFFIX, PROJECT_TIMEZONE_OFFSET_MINUTES } = require('../hq/dateFormat');

test('PROJECT_TIMEZONE_OFFSET_MINUTES переиспользован из dashboardMetrics, не задан заново (+180, Europe/Moscow без DST)', () => {
  assert.equal(PROJECT_TIMEZONE_OFFSET_MINUTES, 180);
});

test('MSK_SUFFIX — явный маркер часового пояса, не пустая строка', () => {
  assert.equal(MSK_SUFFIX, ' МСК');
});

test('toMskDate: 17:00 UTC (то, что владелец видел бы без фикса) даёт 20:00 по Москве', () => {
  const local = toMskDate('2026-08-03T17:00:00.000Z');
  assert.equal(local.getUTCHours(), 20);
  assert.equal(local.getUTCMinutes(), 0);
});

test('toMskDate: PostgreSQL ISO8601 с миллисекундами и Z разбирается корректно', () => {
  const local = toMskDate('2026-08-03T23:36:50.715Z');
  // 23:36 UTC + 3ч = 02:36 следующих суток.
  assert.equal(local.getUTCHours(), 2);
  assert.equal(local.getUTCMinutes(), 36);
  assert.equal(local.getUTCDate(), 4);
});

test('toMskDate: переход даты через полночь по Москве (21:00 UTC -> 00:00 МСК следующих суток)', () => {
  const local = toMskDate('2026-08-03T21:00:00.000Z');
  assert.equal(local.getUTCDate(), 4, 'календарная дата должна сдвинуться на следующий день по Москве');
  assert.equal(local.getUTCHours(), 0);
  assert.equal(local.getUTCMinutes(), 0);
});

test('toMskDate: 20:59 UTC — ещё предыдущие московские сутки (граница ровно в 21:00 UTC, не раньше)', () => {
  const local = toMskDate('2026-08-03T20:59:00.000Z');
  assert.equal(local.getUTCDate(), 3, 'без одной минуты до полуночи по Москве — ещё те же сутки');
  assert.equal(local.getUTCHours(), 23);
  assert.equal(local.getUTCMinutes(), 59);
});

test('toMskDate: принимает уже готовый Date-объект', () => {
  const local = toMskDate(new Date('2026-08-03T17:00:00.000Z'));
  assert.equal(local.getUTCHours(), 20);
});

test('toMskDate: null/undefined/невалидная строка -> null, не выдуманная дата', () => {
  assert.equal(toMskDate(null), null);
  assert.equal(toMskDate(undefined), null);
  assert.equal(toMskDate(''), null);
  assert.equal(toMskDate('не дата'), null);
});
