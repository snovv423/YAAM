'use strict';

// Формулы экрана "Обзор" HQ — каждая метрика описана явным, задокументированным
// правилом (не "как получится"), и каждое правило закреплено тестами
// (server/test/hqDashboardMetrics.test.js + server/test/postgresql/
// hqAuth.test.js). Источник данных — только PostgreSQL, только реальные
// таблицы orders/refunds/restaurants; ничего не выдумывается сверх того,
// что уже существует в схеме.
const { RESTAURANT_RESPONSE_WINDOW_SEC } = require('../postgresql/orderService');

// YAAM сейчас работает только в Грозном (Europe/Moscow). Этот часовой пояс —
// фиксированный UTC+3 БЕЗ перехода на летнее/зимнее время с 26.10.2014
// (Россия отменила сезонный перевод часов) — поэтому здесь достаточно и
// корректно простого фиксированного смещения, без полноценной IANA tz-базы
// как отдельной зависимости. Если YAAM когда-либо расширится на регион с
// реальным DST — это место придётся пересмотреть, копировать бездумно нельзя.
const PROJECT_TIMEZONE = 'Europe/Moscow';
const PROJECT_TIMEZONE_OFFSET_MINUTES = 180;

// Возвращает границы "сегодня" в часовом поясе проекта как пару UTC Date:
// [startUtc, endUtc) — начало текущих суток по Москве и начало следующих.
function todayRangeUtc(nowUtc = new Date()) {
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const localNow = new Date(nowUtc.getTime() + offsetMs);
  const localMidnightAsUtc = Date.UTC(
    localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 0, 0, 0, 0
  );
  const startUtc = new Date(localMidnightAsUtc - offsetMs);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

const ACTIVE_ORDER_STATUSES = ['awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier'];

// --- Верхний блок ------------------------------------------------------
//
// Правило (одинаково для всех "сегодня"-метрик — единый якорь времени,
// см. итоговый отчёт за обсуждение альтернативы "по дате доставки"):
//   "Заказов сегодня"  = COUNT(orders), created_at попадает в [today, tomorrow)
//                        по Europe/Moscow, ЛЮБОЙ статус.
//   "Оборот сегодня"   = SUM(items_total) по ТЕМ ЖЕ заказам, только status='delivered'.
//   "Комиссия сегодня" = SUM(commission_amount) по тем же, только status='delivered'.
//   "Активные рестораны" = COUNT(restaurants) WHERE is_open=1. YAAM пока не
//        имеет статуса публикации (черновик/опубликован/архивирован —
//        отложено с HQ Stage 1), поэтому единственное существующее сегодня
//        поле, отражающее "активен для приёма заказов" — is_open.
async function getTopSummary(db, { now = new Date() } = {}) {
  const { startUtc, endUtc } = todayRangeUtc(now);
  const [todayRow] = await db.query(
    `SELECT
       COUNT(*)::int AS orders_today,
       COALESCE(SUM(items_total) FILTER (WHERE status = 'delivered'), 0)::int AS turnover_today,
       COALESCE(SUM(commission_amount) FILTER (WHERE status = 'delivered'), 0)::int AS commission_today
     FROM orders
     WHERE created_at >= $1 AND created_at < $2`,
    [startUtc, endUtc],
  );
  const [activeRestaurantsRow] = await db.query(`SELECT COUNT(*)::int AS c FROM restaurants WHERE is_open = 1`);
  const attentionCount = await getAttentionCount(db);

  return {
    ordersToday: todayRow.orders_today,
    turnoverToday: todayRow.turnover_today,
    commissionToday: todayRow.commission_today,
    activeRestaurants: activeRestaurantsRow.c,
    attentionCount,
  };
}

// --- Активные заказы (6.1) ----------------------------------------------
//
// Текущее живое состояние очереди заказов — НЕ ограничено "сегодня": заказ,
// технически всё ещё активный со вчера, должен быть виден, а не исчезнуть
// из сводки только потому что дата сменилась.
async function getActiveOrdersBreakdown(db) {
  const rows = await db.query(
    `SELECT status, COUNT(*)::int AS c FROM orders WHERE status = ANY($1) GROUP BY status`,
    [ACTIVE_ORDER_STATUSES],
  );
  const counts = Object.fromEntries(ACTIVE_ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = row.c;
  return {
    awaitingPayment: counts.awaiting_payment,
    awaitingRestaurant: counts.awaiting_restaurant,
    accepted: counts.accepted,
    preparing: counts.preparing,
    courier: counts.courier,
    needsAttention: await getOverdueAwaitingRestaurantCount(db),
  };
}

// "Требует внимания" — ТОЛЬКО два реально существующих в модели проблемных
// состояния, ничего не придумано:
//   1. awaiting_restaurant дольше RESTAURANT_RESPONSE_WINDOW_SEC (180с) —
//      в норме sweepTimeouts() (services/postgresql/scheduler.js) переводит
//      такие заказы в timed_out каждые 10с, так что здесь почти всегда 0;
//      ненулевое значение — реальный сигнал, что что-то не так (сам
//      scheduler не работает, или обнаружена гонка).
//   2. refunds.status = 'failed' — терминальное состояние возврата (см.
//      server/docs/refund-architecture-review.md), не ретраится
//      автоматически по дизайну — требует ручного разбора по определению.
async function getOverdueAwaitingRestaurantCount(db) {
  const [row] = await db.query(
    `SELECT COUNT(*)::int AS c FROM orders
     WHERE status = 'awaiting_restaurant'
       AND status_updated_at < NOW() - make_interval(secs => $1)`,
    [RESTAURANT_RESPONSE_WINDOW_SEC],
  );
  return row.c;
}

async function getFailedRefundsCount(db) {
  const [row] = await db.query(`SELECT COUNT(*)::int AS c FROM refunds WHERE status = 'failed'`);
  return row.c;
}

async function getAttentionCount(db) {
  const [overdue, failedRefunds] = await Promise.all([
    getOverdueAwaitingRestaurantCount(db),
    getFailedRefundsCount(db),
  ]);
  return overdue + failedRefunds;
}

// Компактный список причин "требует внимания" — публичного текста
// достаточно, без раскрытия ID/сумм на уровне общей сводки (детали — в
// будущем разделе конкретного ресторана/выплаты, не в этом этапе).
async function getAttentionItems(db) {
  const items = [];
  const overdue = await getOverdueAwaitingRestaurantCount(db);
  if (overdue > 0) {
    items.push({ kind: 'overdue_awaiting_restaurant', count: overdue, label: `Заказы без ответа ресторана дольше ${Math.round(RESTAURANT_RESPONSE_WINDOW_SEC / 60)} мин: ${overdue}` });
  }
  const failedRefunds = await getFailedRefundsCount(db);
  if (failedRefunds > 0) {
    items.push({ kind: 'failed_refund', count: failedRefunds, label: `Возвраты, требующие ручного разбора: ${failedRefunds}` });
  }
  return items;
}

// --- Состояние ресторанов (6.2) -----------------------------------------
//
// Публичные/операционные поля ТОЛЬКО — connect_code/telegram_chat_id
// намеренно не выбираются этим запросом (не только "не рендерятся в
// шаблоне" — их вообще нет в результате SELECT, чтобы приватные поля не
// могли случайно утечь при будущей правке шаблона).
async function getRestaurantsStatus(db) {
  const rows = await db.query(`
    SELECT
      r.id, r.name, r.is_open, r.paused_until,
      (r.telegram_chat_id IS NOT NULL) AS telegram_connected,
      COUNT(o.id) FILTER (WHERE o.status = ANY($1))::int AS active_orders
    FROM restaurants r
    LEFT JOIN orders o ON o.restaurant_id = r.id
    GROUP BY r.id
    ORDER BY r.name
  `, [ACTIVE_ORDER_STATUSES]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isOpen: !!r.is_open,
    pausedUntil: r.paused_until,
    telegramConnected: !!r.telegram_connected,
    activeOrders: r.active_orders,
  }));
}

// --- Финансовая сводка (6.3) ---------------------------------------------
//
// YAAM HQ Stage 7 — делегирует в services/hq/restaurantFinanceService.js
// (единый источник финансовой истины по всей HQ — задание Stage 7, раздел
// 3: "не создавать второй параллельный источник финансовой истины"), а не
// считает turnover/commission независимым запросом, как раньше (Stage 2).
//
// НАЙДЕННЫЙ И ИСПРАВЛЕННЫЙ БАГ (Stage 7 отчёт, раздел 2/12): прежняя
// реализация фильтровала ТОЛЬКО по status='delivered' и НЕ исключала
// заказы с succeeded-возвратом — комиссия/оборот оставались "заработанными"
// даже после полного возврата. Также якорь времени сменился с created_at на
// status_updated_at (момент, когда заказ реально СТАЛ delivered, а не когда
// был создан — см. restaurantFinanceService.js за полным обоснованием).
// period='today' здесь сохраняет прежний внешний контракт этой функции
// (карточка "Обзор"/старая "Финансы" всегда показывали "сегодня") — общее
// понятие произвольного периода появилось в новой странице «Финансы»
// (routes/hq/pages.js), не здесь.
async function getFinanceSummary(db, { now = new Date() } = {}) {
  // Ленивый require (не наверху файла) — избегает потенциального
  // циклического require: restaurantFinanceService.js импортирует
  // restaurantStatsService.js, который сам НЕ импортирует dashboardMetrics
  // напрямую, но dashboardMetrics исторически "нижний" модуль в этом слое
  // (сам импортируется другими) — цикла на практике нет, но ленивый require
  // здесь дешёв и полностью его исключает.
  const financeService = require('./restaurantFinanceService');
  const positions = await financeService.listRestaurantsFinancialPositions({ period: 'today' }, now);
  const overall = financeService.summarizeOverall(positions);
  return {
    turnover: overall.turnover,
    commission: overall.commission,
    restaurantsShare: overall.restaurantEarnings,
    refundedOrders: overall.successfulRefundsCount,
    refundedAmount: overall.successfulRefunds,
  };
}

module.exports = {
  PROJECT_TIMEZONE,
  PROJECT_TIMEZONE_OFFSET_MINUTES,
  todayRangeUtc,
  getTopSummary,
  getActiveOrdersBreakdown,
  getRestaurantsStatus,
  getFinanceSummary,
  getAttentionItems,
  getAttentionCount,
};
