'use strict';

// Формулы экрана "Обзор" HQ — каждая метрика описана явным, задокументированным
// правилом (не "как получится"), и каждое правило закреплено тестами
// (server/test/hqDashboardMetrics.test.js + server/test/postgresql/
// hqAuth.test.js). Источник данных — только PostgreSQL, только реальные
// таблицы orders/refunds/restaurants; ничего не выдумывается сверх того,
// что уже существует в схеме.

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

// --- «Обзор» — 4 показателя верхнего блока (docs/HQ-PRODUCT-SPEC.md) -----
//
// Период "Сегодня|Неделя|Месяц" переиспользует УЖЕ существующие определения
// периода (restaurantStatsService.resolvePeriodRange: 'today'/'7d'/'30d') —
// те же, что уже показаны владельцу на «Финансы»/«Статистика ресторана» —
// не изобретает календарную неделю/месяц заново.
//
// Все четыре числа считаются ОДНИМ вызовом restaurantFinanceService (Stage
// 7, единственный источник финансовой истины — задание Обзора, раздел 10:
// "не подменять существующие определения финансов приблизительными
// формулами") — не второй параллельный SQL-расчёт:
//   "Заказы"    = COUNT заработанных заказов за период (delivered + успешно
//                 оплачен + без успешного возврата — EARNED_ORDER_FILTER_SQL,
//                 restaurantFinanceService.js). Отменённые/неоплаченные/
//                 возвращённые НЕ считаются — задание, раздел 2, дословно.
//   "Оборот"    = SUM(items_total) по тем же заказам.
//   "Доход YAAM"= SUM(commission_amount) по тем же заказам.
//   "Рестораны" = количество РАЗНЫХ ресторанов среди этих же заказов —
//                 "сколько ресторанов реально вели бизнес в этом периоде",
//                 а не текущий is_open-тумблер (операционный, не бизнес-
//                 показатель — задание прямо исключает "распределение
//                 заказов по оперативным статусам") и не статический список
//                 published/архивных (задание требует, чтобы переключатель
//                 периода менял ВСЕ четыре числа сразу — счётчик, не
//                 зависящий от периода, этому требованию не отвечает).
//                 Архивированный ресторан, заработавший в периоде ДО
//                 архивирования, всё ещё корректно входит в счёт этого
//                 периода — исторический факт периода не переписывается
//                 задним числом.
const PERIOD_TO_RANGE_KEY = { today: 'today', week: '7d', month: '30d' };

async function getOverviewMetrics({ period = 'today', now = new Date() } = {}) {
  const resolvedPeriod = period === 'week' || period === 'month' ? period : 'today';
  const rangeKey = PERIOD_TO_RANGE_KEY[resolvedPeriod];
  const financeService = require('./restaurantFinanceService'); // ленивый require — см. getFinanceSummary ниже
  const { resolvePeriodRange } = require('./restaurantStatsService');
  const range = resolvePeriodRange({ period: rangeKey }, now);
  const rows = await financeService.computeEarningsAggregate({ range });
  return {
    period: resolvedPeriod,
    ordersCount: rows.reduce((sum, r) => sum + r.delivered_paid_orders, 0),
    turnover: rows.reduce((sum, r) => sum + r.turnover, 0),
    commission: rows.reduce((sum, r) => sum + r.commission, 0),
    restaurantsCount: rows.length,
  };
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
  getOverviewMetrics,
  getFinanceSummary,
};
