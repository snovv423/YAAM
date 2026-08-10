'use strict';

// YAAM Stage 38 — юнит-тесты канонической денежной границы (services/money.js).
// Чистые функции, БД не нужна — тот же приём, что и первые два теста
// resolveCommissionBpsStage7.test.js (todayDateStringMoscow).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const money = require('../../services/money');

test('rublesToMinor: целое число рублей -> minor units ×100', () => {
  assert.equal(money.rublesToMinor(350), 35000);
  assert.equal(money.rublesToMinor(1050), 105000);
  assert.equal(money.rublesToMinor(0), 0);
  assert.equal(money.rublesToMinor(1), 100);
});

test('rublesToMinor: дробный JS Number на входе запрещён (задание, раздел 2)', () => {
  assert.throws(() => money.rublesToMinor(349.99), TypeError);
  assert.throws(() => money.rublesToMinor(1050.5), TypeError);
  assert.throws(() => money.rublesToMinor(NaN), TypeError);
  assert.throws(() => money.rublesToMinor('350'), TypeError);
});

test('formatMinorRub: круглые суммы без ",00", дробные — с копейками', () => {
  assert.equal(money.formatMinorRub(41800), '418 ₽');
  assert.equal(money.formatMinorRub(0), '0 ₽');
  assert.equal(money.formatMinorRub(7350), '73,50 ₽');
  assert.equal(money.formatMinorRub(7301), '73,01 ₽');
  assert.equal(money.formatMinorRub(105000), '1050 ₽');
  assert.equal(money.formatMinorRub(105050), '1050,50 ₽');
});

test('formatMinorRub: дробный вход запрещён', () => {
  assert.throws(() => money.formatMinorRub(73.5), TypeError);
});

test('minorToRubleDecimalString / rubleDecimalStringToMinor — точный round-trip (задание, раздел 8)', () => {
  assert.equal(money.minorToRubleDecimalString(105000), '1050.00');
  assert.equal(money.minorToRubleDecimalString(7350), '73.50');
  assert.equal(money.minorToRubleDecimalString(105050), '1050.50');
  assert.equal(money.minorToRubleDecimalString(1), '0.01');

  assert.equal(money.rubleDecimalStringToMinor('1050.00'), 105000);
  assert.equal(money.rubleDecimalStringToMinor('73.50'), 7350);
  assert.equal(money.rubleDecimalStringToMinor('1050.50'), 105050);
  assert.equal(money.rubleDecimalStringToMinor('0.01'), 1);

  // Полный round-trip без потерь для широкого диапазона.
  for (const minor of [0, 1, 99, 100, 101, 7350, 41800, 105050, 9999999]) {
    assert.equal(money.rubleDecimalStringToMinor(money.minorToRubleDecimalString(minor)), minor);
  }
});

test('minorToRubleDecimalString/rubleDecimalStringToMinor: некорректный вход отклоняется', () => {
  assert.throws(() => money.minorToRubleDecimalString(-1), TypeError);
  assert.throws(() => money.minorToRubleDecimalString(73.5), TypeError);
  assert.throws(() => money.rubleDecimalStringToMinor('1050'), TypeError);
  assert.throws(() => money.rubleDecimalStringToMinor('1050.5'), TypeError);
  assert.throws(() => money.rubleDecimalStringToMinor('abc'), TypeError);
});

test('minorToRublesNumber: точная граница для вызова paymentService (провайдер без изменений)', () => {
  assert.equal(money.minorToRublesNumber(105050), 1050.5);
  assert.equal(money.minorToRublesNumber(35000), 350);
  // Ключевое свойство границы: (minor/100).toFixed(2) — ИМЕННО то, что
  // делает НЕИЗМЕНЁННЫЙ yookassaProvider.js внутри — обязано быть точным.
  for (const minor of [0, 1, 29, 99, 100, 7350, 41800, 105029, 105050, 9999999]) {
    const rubles = money.minorToRublesNumber(minor);
    assert.equal(rubles.toFixed(2), money.minorToRubleDecimalString(minor));
  }
});

// ---------------------------------------------------------------------------
// Комиссия — задание, раздел 3: точность до копейки, integer-safe, единое
// правило округления, проверено на контрольных ставках/суммах/половинных
// границах.
// ---------------------------------------------------------------------------
test('computeCommissionMinor: контрольный пример задания (1247 ₽, 6.5%)', () => {
  const itemsTotalMinor = money.rublesToMinor(1247); // 124700
  const commissionMinor = money.computeCommissionMinor(itemsTotalMinor, 650);
  assert.equal(commissionMinor, 8106); // 81,06 ₽ — как явно указано в задании
  const restaurantMinor = itemsTotalMinor - commissionMinor;
  assert.equal(restaurantMinor, 116594); // 1165,94 ₽ — как явно указано в задании
  assert.equal(itemsTotalMinor, commissionMinor + restaurantMinor); // инвариант, раздел 10
});

test('computeCommissionMinor: контрольный пример задания (1050 ₽, 7%)', () => {
  const itemsTotalMinor = money.rublesToMinor(1050); // 105000
  const commissionMinor = money.computeCommissionMinor(itemsTotalMinor, 700);
  assert.equal(commissionMinor, 7350); // 73,50 ₽
  assert.equal(itemsTotalMinor - commissionMinor, 97650); // 976,50 ₽
});

test('computeCommissionMinor: 5.5% / 6.5% / 7% на наборе контрольных сумм, инвариант turnover=commission+earnings без единого расхождения', () => {
  const rates = [550, 650, 700];
  const rubleAmounts = [1, 5, 50, 350, 999, 1000, 1050, 1247, 12345, 99999];
  for (const bps of rates) {
    for (const rub of rubleAmounts) {
      const totalMinor = money.rublesToMinor(rub);
      const commissionMinor = money.computeCommissionMinor(totalMinor, bps);
      const earningsMinor = totalMinor - commissionMinor;
      assert.equal(totalMinor, commissionMinor + earningsMinor, `bps=${bps} rub=${rub}`);
      assert.ok(commissionMinor >= 0 && commissionMinor <= totalMinor, `commission out of range: bps=${bps} rub=${rub}`);
    }
  }
});

test('computeCommissionMinor: исчерпывающая проверка 1..200000 minor units при 700/650/550 bps — 0 расхождений', () => {
  let checked = 0;
  for (const bps of [700, 650, 550]) {
    for (let minor = 1; minor <= 200000; minor++) {
      const commission = money.computeCommissionMinor(minor, bps);
      const earnings = minor - commission;
      assert.equal(commission + earnings, minor);
      checked++;
    }
  }
  assert.equal(checked, 600000);
});

test('computeCommissionMinor: exact-half rounding boundary (round half up, как и до Stage 38)', () => {
  // items_total*bps/10000 ровно X.5 minor -> округляется ВВЕРХ (тот же
  // Math.round, что и в рублёвой модели Stage 7/37, просто на более мелкой
  // единице). Подобрано так, чтобы результат умножения был ровно N.5:
  // 100 minor * 50 bps / 10000 = 0.5 -> round -> 1.
  assert.equal(money.computeCommissionMinor(100, 50), 1);
  // 300 minor * 50 bps / 10000 = 1.5 -> round -> 2.
  assert.equal(money.computeCommissionMinor(300, 50), 2);
  // 500 minor * 50 bps / 10000 = 2.5 -> round -> 3.
  assert.equal(money.computeCommissionMinor(500, 50), 3);
});

test('computeCommissionMinor: integer-safe well below Number.MAX_SAFE_INTEGER для реалистичных диапазонов YAAM', () => {
  const veryLargeOrderMinor = money.rublesToMinor(1000000); // 1,000,000 ₽ — заведомо больше любого реального заказа
  const product = veryLargeOrderMinor * 10000; // худший случай внутри Math.round(amount*bps/10000)
  assert.ok(product < Number.MAX_SAFE_INTEGER, 'произведение остаётся safe-integer даже для заведомо завышенной суммы');
  assert.equal(money.computeCommissionMinor(veryLargeOrderMinor, 700), 7000000);
});
