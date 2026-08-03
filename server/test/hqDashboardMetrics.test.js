'use strict';

// HQ «Обзор» — юнит-тесты чистых функций server/services/hq/
// dashboardMetrics.js (расчёт границ "сегодня" по Europe/Moscow). С
// переработкой «Обзора» (docs/HQ-PRODUCT-SPEC.md) getOverviewMetrics()
// целиком делегирует в restaurantFinanceService.computeEarningsAggregate()
// (реальный db/postgresql, без подменяемого db-параметра) — те же формулы
// проверяются live-DB тестами, см. server/test/postgresql/
// hqOverviewStage10.test.js ("O: getOverviewMetrics согласован с
// restaurantFinanceService"), тем же принципом, что уже применён к
// getFinanceSummary (см. комментарий ниже).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  todayRangeUtc,
  PROJECT_TIMEZONE_OFFSET_MINUTES,
} = require('../services/hq/dashboardMetrics');

test('PROJECT_TIMEZONE_OFFSET_MINUTES — фиксированные +3 часа (Europe/Moscow без сезонного перевода)', () => {
  assert.equal(PROJECT_TIMEZONE_OFFSET_MINUTES, 180);
});

test('todayRangeUtc: середина дня по Москве — граница в 21:00 UTC предыдущих суток', () => {
  const { startUtc, endUtc } = todayRangeUtc(new Date('2026-07-24T00:30:00Z'));
  assert.equal(startUtc.toISOString(), '2026-07-23T21:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-07-24T21:00:00.000Z');
});

test('todayRangeUtc: за минуту до полуночи по Москве — ещё предыдущие сутки', () => {
  const { startUtc, endUtc } = todayRangeUtc(new Date('2026-07-23T20:59:00Z'));
  assert.equal(startUtc.toISOString(), '2026-07-22T21:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-07-23T21:00:00.000Z');
});

test('todayRangeUtc: ровно в момент полуночи по Москве — уже следующие сутки (без off-by-one)', () => {
  const { startUtc, endUtc } = todayRangeUtc(new Date('2026-07-23T21:00:00Z'));
  assert.equal(startUtc.toISOString(), '2026-07-23T21:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-07-24T21:00:00.000Z');
});

test('todayRangeUtc: диапазон всегда ровно 24 часа', () => {
  const { startUtc, endUtc } = todayRangeUtc(new Date());
  assert.equal(endUtc.getTime() - startUtc.getTime(), 24 * 60 * 60 * 1000);
});

// getFinanceSummary: с Stage 7 делегирует в services/hq/
// restaurantFinanceService.js (единый источник финансовой истины) и больше
// НЕ использует переданный db-параметр для собственных запросов — fake-db
// SQL-текст-мэтчинг здесь перестал бы что-либо реально проверять (запросы
// теперь идут через restaurantFinanceService.js напрямую к реальному
// db/postgresql). Формулы (restaurantsShare = turnover - commission,
// нулевой оборот, эксклюзия возвратов) теперь проверяются live-DB тестами —
// см. server/test/postgresql/hqRestaurantFinanceStage7.test.js
// ("dashboardMetrics.getFinanceSummary согласован с restaurantFinanceService").
