'use strict';

// YAAM HQ Stage 6 — юнит-тесты проверки российских юридических/банковских
// реквизитов (задание, раздел 14A). Все фикстуры ниже — заведомо
// вымышленные (не принадлежат ни одному реальному юрлицу/ИП/банку), но
// проходят настоящую математическую проверку контрольных цифр — построены
// тем же официальным алгоритмом, что и сама проверка (см. server/services/
// hq/ruRequisites.js). Задание, раздел 16, прямо запрещает реальные
// банковские данные даже в тестах — здесь их нет.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../services/hq/ruRequisites');

// ---------------------------------------------------------------------------
// ИНН
// ---------------------------------------------------------------------------

test('isValidInn: корректный ИНН ООО (10 цифр)', () => {
  assert.equal(r.isValidInn('7709123453', 'ooo'), true);
});

test('isValidInn: корректный ИНН ИП (12 цифр)', () => {
  assert.equal(r.isValidInn('770912345616', 'ip'), true);
});

test('isValidInn: неверная контрольная цифра — 10 знаков', () => {
  assert.equal(r.isValidInn('7709123450', 'ooo'), false);
  assert.equal(r.isValidInn('7709123459', 'ooo'), false);
});

test('isValidInn: неверная контрольная цифра — 12 знаков (первая, вторая, обе)', () => {
  assert.equal(r.isValidInn('770912345600', 'ip'), false); // обе цифры неверны
  assert.equal(r.isValidInn('770912345606', 'ip'), false); // вторая неверна
});

test('isValidInn: длина не соответствует правовой форме — отклоняется', () => {
  assert.equal(r.isValidInn('7709123453', 'ip'), false); // 10 цифр, но ИП требует 12
  assert.equal(r.isValidInn('770912345616', 'ooo'), false); // 12 цифр, но ООО требует 10
});

test('isValidInn: неверная длина в принципе', () => {
  for (const bad of ['', '123', '12345678901', String('7'.repeat(20))]) {
    assert.equal(r.isValidInn(bad, 'ooo'), false, `ожидали отказ для "${bad}"`);
  }
});

test('isValidInn: нормализация пробелов/дефисов перед проверкой', () => {
  assert.equal(r.isValidInn('77-09 12 3453', 'ooo'), true);
});

test('isValidInn: без legalForm принимает обе корректные длины', () => {
  assert.equal(r.isValidInn('7709123453', undefined), true);
  assert.equal(r.isValidInn('770912345616', undefined), true);
});

// ---------------------------------------------------------------------------
// ОГРН / ОГРНИП
// ---------------------------------------------------------------------------

test('isValidOgrn: корректный ОГРН (13 цифр)', () => {
  assert.equal(r.isValidOgrn('1027700123450'), true);
});

test('isValidOgrn: неверная контрольная цифра', () => {
  assert.equal(r.isValidOgrn('1027700123451'), false);
});

test('isValidOgrn: неверная длина', () => {
  assert.equal(r.isValidOgrn('102770012345'), false);
  assert.equal(r.isValidOgrn('10277001234500'), false);
});

test('isValidOgrnip: корректный ОГРНИП (15 цифр)', () => {
  assert.equal(r.isValidOgrnip('312770012345008'), true);
});

test('isValidOgrnip: неверная контрольная цифра', () => {
  assert.equal(r.isValidOgrnip('312770012345009'), false);
});

test('isValidOgrnForLegalForm: маршрутизирует на ОГРН/ОГРНИП по правовой форме', () => {
  assert.equal(r.isValidOgrnForLegalForm('1027700123450', 'ooo'), true);
  assert.equal(r.isValidOgrnForLegalForm('312770012345008', 'ip'), true);
  assert.equal(r.isValidOgrnForLegalForm('1027700123450', 'ip'), false); // 13 цифр не ОГРНИП
  assert.equal(r.isValidOgrnForLegalForm('312770012345008', 'ooo'), false); // 15 цифр не ОГРН
});

// ---------------------------------------------------------------------------
// БИК
// ---------------------------------------------------------------------------

test('isValidBik: корректный формат (9 цифр, правдоподобный номер подразделения)', () => {
  assert.equal(r.isValidBik('044999225'), true);
});

test('isValidBik: спецзначения 000-002 допустимы', () => {
  assert.equal(r.isValidBik('044000000'), true);
  assert.equal(r.isValidBik('044000001'), true);
  assert.equal(r.isValidBik('044000002'), true);
});

test('isValidBik: неправдоподобный номер подразделения (003-049) отклоняется', () => {
  assert.equal(r.isValidBik('044000003'), false);
  assert.equal(r.isValidBik('044000049'), false);
});

test('isValidBik: неверная длина', () => {
  assert.equal(r.isValidBik('12345678'), false);
  assert.equal(r.isValidBik('1234567890'), false);
  assert.equal(r.isValidBik(''), false);
});

// ---------------------------------------------------------------------------
// Расчётный счёт / корреспондентский счёт против БИК
// ---------------------------------------------------------------------------

const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';

test('isValidAccountNumber: корректный расчётный счёт против БИК', () => {
  assert.equal(r.isValidAccountNumber(FICTITIOUS_RS, FICTITIOUS_BIK), true);
});

test('isValidAccountNumber: изменение одной цифры счёта ломает контрольную сумму', () => {
  const broken = `${FICTITIOUS_RS.slice(0, -1)}${(Number(FICTITIOUS_RS.slice(-1)) + 1) % 10}`;
  assert.equal(r.isValidAccountNumber(broken, FICTITIOUS_BIK), false);
});

test('isValidAccountNumber: неверная длина счёта отклоняется', () => {
  assert.equal(r.isValidAccountNumber('407028109380500012', FICTITIOUS_BIK), false); // 18 цифр
  assert.equal(r.isValidAccountNumber(`${FICTITIOUS_RS}00`, FICTITIOUS_BIK), false); // 22 цифры
});

test('isValidAccountNumber: невалидный БИК отклоняет проверку счёта целиком', () => {
  assert.equal(r.isValidAccountNumber(FICTITIOUS_RS, '123'), false);
});

test('isValidCorrespondentAccount: корректный корр. счёт против БИК', () => {
  assert.equal(r.isValidCorrespondentAccount(FICTITIOUS_KS, FICTITIOUS_BIK), true);
});

test('isValidCorrespondentAccount: изменение одной цифры ломает контрольную сумму', () => {
  const broken = `${FICTITIOUS_KS.slice(0, -1)}${(Number(FICTITIOUS_KS.slice(-1)) + 1) % 10}`;
  assert.equal(r.isValidCorrespondentAccount(broken, FICTITIOUS_BIK), false);
});

test('isValidAccountNumber/isValidCorrespondentAccount: расчётный счёт не проходит как корреспондентский и наоборот (разные префиксы)', () => {
  // Корректный РС для этого БИК почти наверняка не является корректным КС
  // для того же БИК (разные префиксы контрольной суммы) — проверяет, что
  // два алгоритма реально независимы, а не совпадают случайно.
  assert.equal(r.isValidCorrespondentAccount(FICTITIOUS_RS, FICTITIOUS_BIK), false);
  assert.equal(r.isValidAccountNumber(FICTITIOUS_KS, FICTITIOUS_BIK), false);
});

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

test('normalizeDigits: убирает всё, кроме цифр', () => {
  assert.equal(r.normalizeDigits('40702 8109-3805 0001238'), FICTITIOUS_RS);
  assert.equal(r.normalizeDigits(''), '');
  assert.equal(r.normalizeDigits(null), '');
  assert.equal(r.normalizeDigits(undefined), '');
});

test('normalizeRuPhone: разные форматы ввода нормализуются к +7XXXXXXXXXX', () => {
  assert.equal(r.normalizeRuPhone('89001234567'), '+79001234567');
  assert.equal(r.normalizeRuPhone('79001234567'), '+79001234567');
  assert.equal(r.normalizeRuPhone('9001234567'), '+79001234567');
  assert.equal(r.normalizeRuPhone('+7 (900) 123-45-67'), '+79001234567');
  assert.equal(r.normalizeRuPhone('8 900 123 45 67'), '+79001234567');
});

test('normalizeRuPhone: неверный формат -> null', () => {
  assert.equal(r.normalizeRuPhone('12345'), null);
  assert.equal(r.normalizeRuPhone(''), null);
  assert.equal(r.normalizeRuPhone('+1 900 123 4567'), null); // не российский код
});

test('isValidEmail: корректные и некорректные значения', () => {
  assert.equal(r.isValidEmail('owner@example.com'), true);
  assert.equal(r.isValidEmail('a.b+tag@sub.example.co'), true);
  assert.equal(r.isValidEmail('not-an-email'), false);
  assert.equal(r.isValidEmail('missing-domain@'), false);
  assert.equal(r.isValidEmail('@missing-local.com'), false);
  assert.equal(r.isValidEmail(''), false);
});

// ---------------------------------------------------------------------------
// Маскировка
// ---------------------------------------------------------------------------

test('maskAccountForUi: формат "•••• 1234" (задание, раздел 7)', () => {
  assert.equal(r.maskAccountForUi(FICTITIOUS_RS), `•••• ${FICTITIOUS_RS.slice(-4)}`);
  assert.equal(r.maskAccountForUi('123'), '••••'); // короче 4 цифр — без хвоста
});

test('maskAccountForAudit: формат "****1234" (задание, раздел 10)', () => {
  assert.equal(r.maskAccountForAudit(FICTITIOUS_RS), `****${FICTITIOUS_RS.slice(-4)}`);
  assert.equal(r.maskAccountForAudit('12'), '****');
});

test('маскировка никогда не содержит полный номер счёта', () => {
  assert.ok(!r.maskAccountForUi(FICTITIOUS_RS).includes(FICTITIOUS_RS));
  assert.ok(!r.maskAccountForAudit(FICTITIOUS_RS).includes(FICTITIOUS_RS));
});
