'use strict';

// Stage 35 — живая находка владельца: главная (yaam.su) вела на
// t.me/yaam_help вместо t.me/YAAMHELP. Причина не в этом коде — main
// (откуда GitHub Pages раздаёт публичный yaam.su) не содержал более раннего
// фикса, применённого в этой ветке (см. STAGE35 отчёт). Тест здесь защищает
// именно ЭТУ ветку/будущий merge от повторного появления старого username —
// единственный источник правды для support-ссылки: https://t.me/YAAMHELP.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { listUserFacingSources } = require('../scripts/check-no-emoji');

const REQUIRED_SUPPORT_URL = 'https://t.me/YAAMHELP';
// Регистронезависимо — https://t.me/yaam_help и https://t.me/YAAMHELP
// формально разные Telegram-username (наличие "_"), но обе формы регистра
// старого username запрещены источникам клиента.
const LEGACY_USERNAME_PATTERN = /t\.me\/yaam_help/i;

test('главная HELP-кнопка ведёт ровно на https://t.me/YAAMHELP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/<a class="help-link" href="([^"]+)"/);
  assert.ok(match, 'HELP-ссылка на главной не найдена');
  assert.equal(match[1], REQUIRED_SUPPORT_URL);
});

test('«Написать в поддержку» (карточка отмены заказа) ведёт на https://t.me/YAAMHELP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/<a class="ghost" href="([^"]+)" target="_blank" rel="noopener">Написать в поддержку<\/a>/);
  assert.ok(match, 'ссылка "Написать в поддержку" не найдена');
  assert.equal(match[1], REQUIRED_SUPPORT_URL);
});

test('устаревший support-username (t.me/yaam_help) отсутствует во всех пользовательских client-источниках (включая legal/)', () => {
  const offenders = [];
  for (const file of listUserFacingSources(path.resolve(__dirname, '..'))) {
    const source = fs.readFileSync(file, 'utf8');
    if (LEGACY_USERNAME_PATTERN.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'найден устаревший t.me/yaam_help — единственный support-username: https://t.me/YAAMHELP');
});
