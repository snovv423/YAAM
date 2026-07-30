'use strict';

// Точечные тесты на test/postgresql/helpers/projectDate.js — единственный
// источник "сегодня" (Europe/Moscow, +180 минут) для тестов, использующих
// settlement_periods.period_from/period_to. Существуют, чтобы дефект,
// найденный в задаче hqtest-prep (пять тестовых файлов независимо считали
// "сегодня" по чистому UTC и падали рядом с границей 21:00-24:00 UTC /
// 00:00-03:00 МСК), не мог вернуться незамеченным и не зависел от того, в
// какое время суток реально запущен CI — все проверки ниже используют явный
// nowUtc, не полагаются на Date.now().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectTodayStr, PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./helpers/projectDate');
const { todayRangeUtc } = require('../../services/hq/dashboardMetrics');
const { dateOnlyToUtcStart } = require('../../services/hq/restaurantStatsService');

test('PROJECT_TIMEZONE_OFFSET_MINUTES = 180 (Europe/Moscow, без DST) — тот же источник, что и production-код', () => {
  assert.equal(PROJECT_TIMEZONE_OFFSET_MINUTES, 180);
});

test('Граница 20:59 UTC — календарная дата МСК ещё совпадает с UTC-датой', () => {
  assert.equal(projectTodayStr(0, new Date('2026-03-10T20:59:00.000Z')), '2026-03-10');
});

test('Граница 21:00 UTC — МСК-полночь наступает, календарная дата уже "завтра" по UTC', () => {
  assert.equal(projectTodayStr(0, new Date('2026-03-10T21:00:00.000Z')), '2026-03-11');
});

test('Граница 23:59 UTC — по-прежнему "завтрашняя" МСК-дата', () => {
  assert.equal(projectTodayStr(0, new Date('2026-03-10T23:59:00.000Z')), '2026-03-11');
});

test('Граница 00:00 UTC — новые UTC-сутки, МСК-дата совпадает с UTC-датой', () => {
  assert.equal(projectTodayStr(0, new Date('2026-03-11T00:00:00.000Z')), '2026-03-11');
});

test('offsetDays корректно сдвигает дату по обе стороны от 21:00 UTC', () => {
  const nowUtc = new Date('2026-03-10T21:30:00.000Z'); // МСК-дата "сегодня" = 2026-03-11
  assert.equal(projectTodayStr(0, nowUtc), '2026-03-11');
  assert.equal(projectTodayStr(-1, nowUtc), '2026-03-10');
  assert.equal(projectTodayStr(1, nowUtc), '2026-03-12');
});

test('Смена месяца/года через границу 21:00 UTC (31 декабря -> 1 января МСК)', () => {
  assert.equal(projectTodayStr(0, new Date('2025-12-31T20:59:00.000Z')), '2025-12-31');
  assert.equal(projectTodayStr(0, new Date('2025-12-31T21:00:00.000Z')), '2026-01-01');
});

// Перекрёстная проверка с production-кодом: дата, которую вернул
// projectTodayStr() для конкретного nowUtc, при обратном разборе РЕАЛЬНОЙ
// production-функцией dateOnlyToUtcStart() обязана давать ТОТ ЖЕ момент
// начала суток, что и todayRangeUtc(nowUtc).startUtc — иначе тестовый
// helper и production-логика расчётных периодов снова могли бы разойтись
// незаметно.
test('projectTodayStr согласован с todayRangeUtc()/dateOnlyToUtcStart() на всех 4 граничных точках', () => {
  const points = [
    '2026-03-10T20:59:00.000Z',
    '2026-03-10T21:00:00.000Z',
    '2026-03-10T23:59:00.000Z',
    '2026-03-11T00:00:00.000Z',
  ];
  for (const iso of points) {
    const nowUtc = new Date(iso);
    const todayStr = projectTodayStr(0, nowUtc);
    const { startUtc } = todayRangeUtc(nowUtc);
    const reconstructedStart = dateOnlyToUtcStart(todayStr);
    assert.equal(
      reconstructedStart.getTime(),
      startUtc.getTime(),
      `nowUtc=${iso}: projectTodayStr()="${todayStr}" должен реконструировать тот же startUtc, что и todayRangeUtc()`,
    );
  }
});
