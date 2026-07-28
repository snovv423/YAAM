'use strict';

// YAAM HQ Stage 8 — юнит-тесты для чистых функций services/hq/
// settlementService.js. Требует PostgreSQL-подключение при require() (файл
// делает `const db = require('../../db/postgresql')` на верхнем уровне),
// поэтому запускается как часть test:postgresql-набора (та же ситуация, что
// и у server/test/resolveCommissionBps.test.js для Stage 7 — но здесь
// тестируется ТОЛЬКО inferUniformCommissionBps(), чистая функция без единого
// SQL-запроса, реального подключения к БД для этих проверок не требуется).
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/does-not-need-to-exist-for-these-tests';
const { inferUniformCommissionBps } = require('../services/hq/settlementService');

test('inferUniformCommissionBps: пустой список заказов -> null', () => {
  assert.equal(inferUniformCommissionBps([], [700]), null);
});

test('inferUniformCommissionBps: один заказ, точное совпадение с кандидатом -> этот bps', () => {
  const orders = [{ items_total: 1000, commission_amount: 70 }];
  assert.equal(inferUniformCommissionBps(orders, [700]), 700);
});

test('inferUniformCommissionBps: несколько заказов, все совпадают с одним и тем же кандидатом -> этот bps', () => {
  const orders = [
    { items_total: 1000, commission_amount: 70 },
    { items_total: 2000, commission_amount: 140 },
    { items_total: 333, commission_amount: 23 }, // round(333*0.07)=23.31->23
  ];
  assert.equal(inferUniformCommissionBps(orders, [700]), 700);
});

test('inferUniformCommissionBps: заказы соответствуют разным ставкам (комиссия менялась внутри периода) -> null, не выдуманное среднее', () => {
  const orders = [
    { items_total: 1000, commission_amount: 100 }, // 10%
    { items_total: 1000, commission_amount: 50 },  // 5%
  ];
  assert.equal(inferUniformCommissionBps(orders, [1000, 700]), null);
});

test('inferUniformCommissionBps: первый кандидат не подходит, второй (fallback) подходит -> возвращает подходящий, не первый по списку', () => {
  const orders = [{ items_total: 1000, commission_amount: 70 }]; // 7%, НЕ 10%
  assert.equal(inferUniformCommissionBps(orders, [1000, 700]), 700);
});

test('inferUniformCommissionBps: округление — 0% комиссии тоже честно распознаётся', () => {
  const orders = [{ items_total: 1000, commission_amount: 0 }];
  assert.equal(inferUniformCommissionBps(orders, [0]), 0);
});

test('inferUniformCommissionBps: дублирующиеся кандидаты не влияют на результат', () => {
  const orders = [{ items_total: 1000, commission_amount: 70 }];
  assert.equal(inferUniformCommissionBps(orders, [700, 700, 700]), 700);
});
