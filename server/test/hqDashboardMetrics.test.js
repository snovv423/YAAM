'use strict';

// HQ Stage 2 — юнит-тесты формул экрана "Обзор" (server/services/hq/
// dashboardMetrics.js): расчёт границ "сегодня" по Europe/Moscow и
// агрегирующие/трансформирующие функции с ПОДМЕНЁННЫМ db (без реального
// PostgreSQL — здесь проверяется только сама логика модуля, а не SQL против
// живой базы; end-to-end проверка тех же формул на реальных данных — в
// test/postgresql/hqAuthStage2.test.js, категория B задания).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  todayRangeUtc,
  getActiveOrdersBreakdown,
  getRestaurantsStatus,
  getFinanceSummary,
  getAttentionItems,
  getAttentionCount,
  getTopSummary,
  PROJECT_TIMEZONE_OFFSET_MINUTES,
} = require('../services/hq/dashboardMetrics');

// Fake db — сопоставляет запрос по уникальному фрагменту SQL-текста с
// заранее заданными строками результата, в точности как реальный
// db.query() из server/db/postgresql/index.js (возвращает массив строк
// напрямую, не {rows: [...]}).
function makeFakeDb(responses) {
  return {
    calls: [],
    query(sql, params) {
      this.calls.push({ sql, params });
      const matched = responses.find((r) => sql.includes(r.match));
      if (!matched) throw new Error(`Неожиданный запрос в тесте: ${sql}`);
      return Promise.resolve(matched.rows);
    },
  };
}

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

test('getActiveOrdersBreakdown: считает по статусам, недостающие статусы — 0, needsAttention — из отдельного overdue-запроса', async () => {
  const db = makeFakeDb([
    { match: 'GROUP BY status', rows: [{ status: 'accepted', c: 2 }, { status: 'courier', c: 1 }] },
    { match: "status = 'awaiting_restaurant'", rows: [{ c: 3 }] },
  ]);
  const result = await getActiveOrdersBreakdown(db);
  assert.deepEqual(result, {
    awaitingPayment: 0,
    awaitingRestaurant: 0,
    accepted: 2,
    preparing: 0,
    courier: 1,
    needsAttention: 3,
  });
});

test('getActiveOrdersBreakdown: все нули, если очередь пуста', async () => {
  const db = makeFakeDb([
    { match: 'GROUP BY status', rows: [] },
    { match: "status = 'awaiting_restaurant'", rows: [{ c: 0 }] },
  ]);
  const result = await getActiveOrdersBreakdown(db);
  assert.deepEqual(result, {
    awaitingPayment: 0, awaitingRestaurant: 0, accepted: 0, preparing: 0, courier: 0, needsAttention: 0,
  });
});

test('getRestaurantsStatus: маппинг в camelCase, boolean-коэрсия telegram/is_open, приватные поля не запрашиваются', async () => {
  const db = makeFakeDb([
    {
      match: 'FROM restaurants r',
      rows: [
        { id: 1, name: 'Тест', is_open: 1, paused_until: null, telegram_connected: true, active_orders: 4 },
        { id: 2, name: 'Пауза', is_open: 0, paused_until: '2026-08-01T00:00:00Z', telegram_connected: false, active_orders: 0 },
      ],
    },
  ]);
  const result = await getRestaurantsStatus(db);
  assert.deepEqual(result, [
    { id: 1, name: 'Тест', isOpen: true, pausedUntil: null, telegramConnected: true, activeOrders: 4 },
    { id: 2, name: 'Пауза', isOpen: false, pausedUntil: '2026-08-01T00:00:00Z', telegramConnected: false, activeOrders: 0 },
  ]);
  // Явная защита от регрессии: connect_code вообще не имеет причин
  // встречаться в этом запросе; telegram_chat_id допустим только внутри
  // "IS NOT NULL" (вычисляем boolean, не отдаём само значение) — сырое имя
  // столбца как отдельный SELECT-элемент недопустимо.
  const sql = db.calls[0].sql;
  assert.ok(!sql.includes('connect_code'));
  assert.ok(!/telegram_chat_id\s*,/.test(sql), 'telegram_chat_id не должен выбираться как отдельное поле');
  assert.ok(sql.includes('telegram_chat_id IS NOT NULL'), 'telegram_connected должен вычисляться как boolean, а не отдавать сырое значение');
});

test('getFinanceSummary: restaurantsShare = turnover - commission, суммы возвратов из отдельного join-запроса', async () => {
  const db = makeFakeDb([
    { match: 'AS turnover', rows: [{ turnover: 1000, commission: 70 }] },
    { match: 'AS refunded_orders', rows: [{ refunded_orders: 2, refunded_amount: 500 }] },
  ]);
  const result = await getFinanceSummary(db);
  assert.deepEqual(result, {
    turnover: 1000,
    commission: 70,
    restaurantsShare: 930,
    refundedOrders: 2,
    refundedAmount: 500,
  });
});

test('getFinanceSummary: нулевой оборот — restaurantsShare тоже 0, без NaN/отрицательных значений', async () => {
  const db = makeFakeDb([
    { match: 'AS turnover', rows: [{ turnover: 0, commission: 0 }] },
    { match: 'AS refunded_orders', rows: [{ refunded_orders: 0, refunded_amount: 0 }] },
  ]);
  const result = await getFinanceSummary(db);
  assert.equal(result.restaurantsShare, 0);
});

test('getAttentionItems: пусто, если нет ни просроченных awaiting_restaurant, ни failed-возвратов', async () => {
  const db = makeFakeDb([
    { match: "status = 'awaiting_restaurant'", rows: [{ c: 0 }] },
    { match: "FROM refunds WHERE status = 'failed'", rows: [{ c: 0 }] },
  ]);
  const items = await getAttentionItems(db);
  assert.deepEqual(items, []);
});

test('getAttentionItems: два реальных сигнала — оба попадают в список с человекочитаемым текстом', async () => {
  const db = makeFakeDb([
    { match: "status = 'awaiting_restaurant'", rows: [{ c: 5 }] },
    { match: "FROM refunds WHERE status = 'failed'", rows: [{ c: 2 }] },
  ]);
  const items = await getAttentionItems(db);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'overdue_awaiting_restaurant');
  assert.equal(items[0].count, 5);
  assert.equal(items[1].kind, 'failed_refund');
  assert.equal(items[1].count, 2);
});

test('getAttentionCount: сумма обоих сигналов (не просто наличие/отсутствие)', async () => {
  const db = makeFakeDb([
    { match: "status = 'awaiting_restaurant'", rows: [{ c: 5 }] },
    { match: "FROM refunds WHERE status = 'failed'", rows: [{ c: 2 }] },
  ]);
  const count = await getAttentionCount(db);
  assert.equal(count, 7);
});

test('getTopSummary: агрегирует заказы/оборот/комиссию/активные рестораны/внимание за один вызов', async () => {
  const db = makeFakeDb([
    { match: 'AS orders_today', rows: [{ orders_today: 12, turnover_today: 3400, commission_today: 238 }] },
    { match: "FROM restaurants WHERE is_open = 1", rows: [{ c: 4 }] },
    { match: "status = 'awaiting_restaurant'", rows: [{ c: 0 }] },
    { match: "FROM refunds WHERE status = 'failed'", rows: [{ c: 1 }] },
  ]);
  const result = await getTopSummary(db);
  assert.deepEqual(result, {
    ordersToday: 12,
    turnoverToday: 3400,
    commissionToday: 238,
    activeRestaurants: 4,
    attentionCount: 1,
  });
});
