'use strict';

// YAAM HQ Stage 4 — юнит-тесты чистой логики раздела «Рестораны»: safe
// sort/status/page allowlist-функции, валидация формы, формулы дат
// (Europe/Moscow), заполнение пропусков в дневном графике, безопасный diff
// для audit log. Ни один из этих тестов не обращается к PostgreSQL —
// проверяются только чистые функции (парсинг/валидация/арифметика дат), тем
// же принципом, что и test/hqDashboardMetrics.test.js (Stage 2). End-to-end
// проверка тех же формул на реальных данных — в
// test/postgresql/hqRestaurantAdminStage4.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSort,
  resolveStatusFilter,
  parsePage,
  parseRestaurantInput,
  ValidationError,
} = require('../services/hq/restaurantAdminService');
const {
  dateOnlyToUtcStart,
  lastNDaysRangeUtc,
  resolvePeriodRange,
  buildDailySeries,
} = require('../services/hq/restaurantStatsService');
const { summarizeRestaurantDiff } = require('../services/hq/auditLog');

// ---------------------------------------------------------------------------
// Safe allowlist — задание, раздел 3: "не позволять произвольный SQL
// sort-column из query string".
// ---------------------------------------------------------------------------

test('resolveSort: известные значения проходят как есть, неизвестное -> default "name"', () => {
  assert.equal(resolveSort('name'), 'name');
  assert.equal(resolveSort('orders'), 'orders');
  assert.equal(resolveSort('rating'), 'rating');
  assert.equal(resolveSort('created'), 'created');
  assert.equal(resolveSort('DROP TABLE restaurants; --'), 'name');
  assert.equal(resolveSort(undefined), 'name');
  assert.equal(resolveSort(''), 'name');
});

test('resolveStatusFilter: только 4 известных значения, иначе null (значит "без фильтра")', () => {
  assert.equal(resolveStatusFilter('open'), 'open');
  assert.equal(resolveStatusFilter('closed'), 'closed');
  assert.equal(resolveStatusFilter('paused'), 'paused');
  assert.equal(resolveStatusFilter('archived'), 'archived');
  assert.equal(resolveStatusFilter('deleted'), null);
  assert.equal(resolveStatusFilter(undefined), null);
});

test('parsePage: валидные положительные целые проходят, всё остальное -> 1', () => {
  assert.equal(parsePage('1'), 1);
  assert.equal(parsePage('42'), 42);
  assert.equal(parsePage('0'), 1);
  assert.equal(parsePage('-5'), 1);
  assert.equal(parsePage('abc'), 1);
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage('1.5'), 1); // Number.parseInt('1.5') === 1, но нужно явно проверить
});

// ---------------------------------------------------------------------------
// Валидация формы ресторана
// ---------------------------------------------------------------------------

test('parseRestaurantInput: пустое название отклоняется', () => {
  assert.throws(() => parseRestaurantInput({ name: '  ', cities: 'Грозный' }), ValidationError);
});

test('parseRestaurantInput: без городов отклоняется', () => {
  assert.throws(() => parseRestaurantInput({ name: 'Кафе', cities: '' }), ValidationError);
  assert.throws(() => parseRestaurantInput({ name: 'Кафе', cities: ' , , ' }), ValidationError);
});

test('parseRestaurantInput: отрицательная минимальная сумма заказа отклоняется', () => {
  assert.throws(() => parseRestaurantInput({ name: 'Кафе', cities: 'Грозный', min_order: '-100' }), ValidationError);
});

test('parseRestaurantInput: нечисловая минимальная сумма заказа отклоняется', () => {
  assert.throws(() => parseRestaurantInput({ name: 'Кафе', cities: 'Грозный', min_order: 'много' }), ValidationError);
});

test('parseRestaurantInput: валидный ввод нормализуется (trim, города -> JSON-массив, пустой min_order -> 0)', () => {
  const result = parseRestaurantInput({
    name: '  Тест Кафе  ', cities: ' Грозный , Аргун ,, ', cuisine: '  кавказская ', description: '', address: '', hours: '', phone: '',
  });
  assert.equal(result.name, 'Тест Кафе');
  assert.deepEqual(JSON.parse(result.cities), ['Грозный', 'Аргун']);
  assert.equal(result.cuisine, 'кавказская');
  assert.equal(result.minOrder, 0);
});

// ---------------------------------------------------------------------------
// Даты — Europe/Moscow, фиксированный +180 (см. services/hq/
// dashboardMetrics.js, откуда переиспользуется PROJECT_TIMEZONE_OFFSET_MINUTES).
// ---------------------------------------------------------------------------

test('dateOnlyToUtcStart: "2026-07-24" -> начало суток по Москве в UTC (2026-07-23T21:00:00Z)', () => {
  const result = dateOnlyToUtcStart('2026-07-24');
  assert.equal(result.toISOString(), '2026-07-23T21:00:00.000Z');
});

test('dateOnlyToUtcStart: некорректный формат -> null, не бросает', () => {
  assert.equal(dateOnlyToUtcStart('24.07.2026'), null);
  assert.equal(dateOnlyToUtcStart(''), null);
  assert.equal(dateOnlyToUtcStart(undefined), null);
  assert.equal(dateOnlyToUtcStart('not-a-date'), null);
});

test('lastNDaysRangeUtc(7): диапазон ровно 7×24 часа, заканчивается началом следующих суток', () => {
  const now = new Date('2026-07-24T10:00:00Z');
  const { startUtc, endUtc } = lastNDaysRangeUtc(7, now);
  assert.equal(endUtc.getTime() - startUtc.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.equal(endUtc.toISOString(), '2026-07-24T21:00:00.000Z');
});

test('resolvePeriodRange: "today"/"7d"/"30d" делегируют на todayRangeUtc/lastNDaysRangeUtc', () => {
  const now = new Date('2026-07-24T10:00:00Z');
  const today = resolvePeriodRange({ period: 'today' }, now);
  assert.equal(today.period, 'today');
  assert.equal(today.endUtc.getTime() - today.startUtc.getTime(), 24 * 60 * 60 * 1000);

  const sevenDays = resolvePeriodRange({ period: '7d' }, now);
  assert.equal(sevenDays.endUtc.getTime() - sevenDays.startUtc.getTime(), 7 * 24 * 60 * 60 * 1000);

  const thirtyDays = resolvePeriodRange({ period: '30d' }, now);
  assert.equal(thirtyDays.endUtc.getTime() - thirtyDays.startUtc.getTime(), 30 * 24 * 60 * 60 * 1000);
});

test('resolvePeriodRange: "custom" с валидным from/to — "to" включительно', () => {
  const range = resolvePeriodRange({ period: 'custom', from: '2026-01-01', to: '2026-01-05' });
  assert.equal(range.period, 'custom');
  const spanDays = (range.endUtc.getTime() - range.startUtc.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(spanDays, 5); // 01,02,03,04,05 — пять полных суток
});

test('resolvePeriodRange: "custom" без from/to бросает ValidationError, не подставляет тихий дефолт', () => {
  assert.throws(() => resolvePeriodRange({ period: 'custom' }), ValidationError);
  assert.throws(() => resolvePeriodRange({ period: 'custom', from: '2026-01-01' }), ValidationError);
});

test('resolvePeriodRange: "custom" где "с даты" позже "по дату" — отклоняется', () => {
  assert.throws(() => resolvePeriodRange({ period: 'custom', from: '2026-05-05', to: '2026-01-01' }), ValidationError);
});

test('resolvePeriodRange: неизвестный period -> тихий, безопасный fallback на "today" (не бросает)', () => {
  const range = resolvePeriodRange({ period: 'whatever-unexpected' });
  assert.equal(range.period, 'today');
});

// ---------------------------------------------------------------------------
// Дневной график — заполнение пропусков нулями (задание, раздел 9: "пустой
// период должен показывать честное пустое состояние", не молчаливо
// пропущенные дни).
// ---------------------------------------------------------------------------

test('buildDailySeries: заполняет ВСЕ дни периода, включая те, где заказов не было', () => {
  // row.day — ПЛОСКАЯ СТРОКА "YYYY-MM-DD" (to_char в SQL), НЕ Date —
  // намеренно: `pg` парсит SQL DATE в JS Date через ЛОКАЛЬНЫЙ часовой пояс
  // процесса Node (не UTC!), из-за чего .toISOString() на такой Date мог
  // тихо сдвинуть дату на сутки на сервере с TZ, отличным от UTC (найдено и
  // воспроизведено вживую через Chrome DevTools — см. финальный отчёт Stage 4,
  // раздел про находки). Явная строка полностью исключает эту двусмысленность.
  const startUtc = new Date('2026-07-20T21:00:00.000Z'); // 2026-07-21 00:00 MSK
  const endUtc = new Date('2026-07-23T21:00:00.000Z'); // 2026-07-24 00:00 MSK (3 суток: 21,22,23)
  const rows = [{ day: '2026-07-22', c: 5 }];
  const series = buildDailySeries(rows, startUtc, endUtc);
  assert.deepEqual(series, [
    { date: '2026-07-21', count: 0 },
    { date: '2026-07-22', count: 5 },
    { date: '2026-07-23', count: 0 },
  ]);
});

test('buildDailySeries: пустой набор строк -> все дни с count=0 (честное пустое состояние, не отсутствие точек)', () => {
  const startUtc = new Date('2026-07-20T21:00:00.000Z');
  const endUtc = new Date('2026-07-21T21:00:00.000Z');
  const series = buildDailySeries([], startUtc, endUtc);
  assert.deepEqual(series, [{ date: '2026-07-21', count: 0 }]);
});

// ---------------------------------------------------------------------------
// Audit log diff — только safe-поля, только реально изменившиеся.
// ---------------------------------------------------------------------------

test('summarizeRestaurantDiff: null, если ничего не изменилось', () => {
  const before = { name: 'А', cuisine: 'x', is_open: 1 };
  const after = { name: 'А', cuisine: 'x', is_open: 1 };
  assert.equal(summarizeRestaurantDiff(before, after), null);
});

test('summarizeRestaurantDiff: показывает только изменившиеся safe-поля', () => {
  const before = { name: 'Старое имя', cuisine: 'кавказская', address: 'ул.1', is_open: 1 };
  const after = { name: 'Новое имя', cuisine: 'кавказская', address: 'ул.2', is_open: 1 };
  const diff = summarizeRestaurantDiff(before, after);
  assert.match(diff, /name: "Старое имя" -> "Новое имя"/);
  assert.match(diff, /address: "ул\.1" -> "ул\.2"/);
  assert.doesNotMatch(diff, /cuisine/);
});

test('summarizeRestaurantDiff: connect_code/telegram_chat_id никогда не попадают в diff, даже если переданы', () => {
  const before = { name: 'А', connect_code: 'OLD123', telegram_chat_id: '111' };
  const after = { name: 'А', connect_code: 'NEW456', telegram_chat_id: '222' };
  const diff = summarizeRestaurantDiff(before, after);
  assert.equal(diff, null, 'единственное реально изменившееся поле (connect_code/telegram_chat_id) не входит в allowlist');
});
