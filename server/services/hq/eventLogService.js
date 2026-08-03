'use strict';

// YAAM HQ «Обзор» — Центр событий (docs/HQ-PRODUCT-SPEC.md).
//
// Единственное место, которое пишет/читает hq_events и курсор очистки
// (hq_owner.events_cleared_before). Источники проблем (orderService.js,
// payoutService.js, bot/postgresql/index.js, server.postgresql.js) вызывают
// только createEvent() — сами не знают о таблице/курсоре.
const db = require('../../db/postgresql');
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./dashboardMetrics');

const CATEGORIES = [
  'order_missed', 'payment_issue', 'refund_issue', 'payout_issue',
  'backend_issue', 'telegram_issue',
  // Важное управленческое событие (не проблема) — ресторан взял/снял
  // перерыв сам через Telegram, docs/HQ-PRODUCT-SPEC.md.
  'restaurant_pause',
  'other',
];

const MAIN_FEED_LIMIT = 200; // см. docs/HQ-PRODUCT-SPEC.md — единая деловая история, не бесконечный поток
const HISTORY_PAGE_SIZE = 50;

function mapRow(row) {
  return {
    id: row.id,
    category: row.category,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    orderId: row.order_id,
    orderPublicCode: row.order_public_code,
    message: row.message,
    occurredAt: row.occurred_at,
  };
}

// Вызывается ТОЛЬКО из мест, где проблема реально произошла (см. список
// подключённых источников в отчёте) — задание, раздел 8: "нельзя изображать
// backend-функциональность без реального хранения". Ошибка самой записи
// события НИКОГДА не должна ронять вызывающий код (создание события — это
// side-effect диагностики, не часть основной транзакции) — каждый источник
// сам оборачивает вызов в try/catch и логирует сбой в console.error, эта
// функция намеренно не глотает исключения молча сама (вызывающий код должен
// решать, критично ли это в его контексте).
async function createEvent({ category, restaurantId = null, restaurantName = null, orderId = null, orderPublicCode = null, message }) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`hq_events: неизвестная категория "${category}"`);
  }
  if (!message || !String(message).trim()) {
    throw new Error('hq_events: message обязателен');
  }
  const rows = await db.query(
    `INSERT INTO hq_events (category, restaurant_id, restaurant_name, order_id, order_public_code, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [category, restaurantId, restaurantName, orderId, orderPublicCode, message],
  );
  return mapRow(rows[0]);
}

async function getClearedBefore() {
  const rows = await db.query(`SELECT events_cleared_before FROM hq_owner WHERE id = 1`);
  return rows[0] ? rows[0].events_cleared_before : null;
}

// Основная лента (задание, раздел 3/6) — только события ПОСЛЕ последней
// очистки, по возрастанию времени (старые сверху, новые снизу — "как в
// терминале"). MAIN_FEED_LIMIT — верхняя граница одного запроса (масштаб
// YAAM, см. server/CLAUDE.md, делает более длинную ленту сценарием для
// «Истории», не основной ленты).
async function listActiveEvents({ limit = MAIN_FEED_LIMIT } = {}) {
  const clearedBefore = await getClearedBefore();
  const rows = clearedBefore
    ? await db.query(
        `SELECT * FROM hq_events WHERE occurred_at > $1 ORDER BY id DESC LIMIT $2`,
        [clearedBefore, limit],
      )
    : await db.query(`SELECT * FROM hq_events ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(mapRow).reverse(); // reverse -> хронологический порядок (старые сверху)
}

// Только события строго ПОСЛЕ afterId (задание, раздел 7 — фоновое
// обновление ленты для уже открытой страницы) — курсор очистки здесь
// намеренно НЕ применяется повторно: если событие уже попало в текущую
// открытую ленту (клиент передаёт последний увиденный id), повторная очистка
// в другой вкладке не должна ретроактивно скрыть уже показанное в этой.
async function listActiveEventsAfter(afterId, { limit = MAIN_FEED_LIMIT } = {}) {
  const rows = await db.query(
    `SELECT * FROM hq_events WHERE id > $1 ORDER BY id ASC LIMIT $2`,
    [afterId, limit],
  );
  return rows.map(mapRow);
}

// «Очистить» (задание, раздел 6) — двигает курсор на текущий момент БД (не
// Node-процесса — тот же принцип согласованности времени, что и остальная
// схема). НЕ удаляет ни одной строки hq_events.
async function clearActiveFeed() {
  const rows = await db.query(
    `UPDATE hq_owner SET events_cleared_before = NOW() WHERE id = 1 RETURNING events_cleared_before`,
  );
  if (!rows[0]) throw new Error('hq_events: не удалось очистить ленту — hq_owner отсутствует');
  return rows[0].events_cleared_before;
}

// «История» (задание, раздел 6) — полный архив, игнорирует курсор очистки.
// Пагинация тем же простым page/PAGE_SIZE стилем, что и остальной HQ
// (restaurantAdminService.parsePage) — не бесконечный скролл с курсорами,
// чтобы не вводить новый паттерн ради одной страницы.
async function listArchive({ page = 1 } = {}) {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const countRows = await db.query(`SELECT COUNT(*)::int AS total FROM hq_events`);
  const total = countRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const safePageClamped = Math.min(safePage, totalPages);
  const rows = await db.query(
    `SELECT * FROM hq_events ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [HISTORY_PAGE_SIZE, (safePageClamped - 1) * HISTORY_PAGE_SIZE],
  );
  return {
    events: rows.map(mapRow).reverse(), // хронологический порядок внутри страницы, как в основной ленте
    page: safePageClamped,
    totalPages,
    total,
  };
}

// ---------------------------------------------------------------------------
// Формат времени (задание, раздел 5) — та же фиксированная смещённая
// арифметика Europe/Moscow, что и todayRangeUtc() (dashboardMetrics.js), НЕ
// зависящая от системного TZ процесса (см. недавний фикс timezone-стабильности
// settlement-дат) — сравнение "тот же день" и сами часы/минуты/секунды
// вычисляются через UTC-геттеры сдвинутой копии Date, никогда не через
// локальный TZ окружения, где выполняется код.
function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatEventTimestamp(occurredAt, now = new Date()) {
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const local = new Date(new Date(occurredAt).getTime() + offsetMs);
  const localNow = new Date(now.getTime() + offsetMs);
  const sameDay = local.getUTCFullYear() === localNow.getUTCFullYear()
    && local.getUTCMonth() === localNow.getUTCMonth()
    && local.getUTCDate() === localNow.getUTCDate();
  const time = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
  if (sameDay) return time;
  const date = `${pad2(local.getUTCDate())}.${pad2(local.getUTCMonth() + 1)}.${local.getUTCFullYear()}`;
  return `${date} · ${time}`;
}

module.exports = {
  CATEGORIES,
  MAIN_FEED_LIMIT,
  HISTORY_PAGE_SIZE,
  createEvent,
  getClearedBefore,
  listActiveEvents,
  listActiveEventsAfter,
  clearActiveFeed,
  listArchive,
  formatEventTimestamp,
};
