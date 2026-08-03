'use strict';

// YAAM HQ Stage 4 — Обзор/Заказы/Оценки/Статистика конкретного ресторана.
// Только чтение (единственная запись, которую этот файл делает — фикс
// изменил бы модель, здесь такого нет ни строки). Использует тот же якорь
// времени (Europe/Moscow, фиксированный +180 минут), что и
// services/hq/dashboardMetrics.js (Stage 2) — переиспользован напрямую, не
// продублирован вторым, потенциально рассинхронизированным расчётом.
const db = require('../../db/postgresql');
const { todayRangeUtc, PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./dashboardMetrics');
const { ValidationError, ACTIVE_STATUSES, PAGE_SIZE, parsePage } = require('./restaurantAdminService');

const VALID_ORDER_STATUSES = [
  'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier',
  'delivered', 'payment_failed', 'declined', 'timed_out', 'cancelled',
];

// Заказы, реально дошедшие дальше "ожидания оплаты" — тот же критерий, что
// уже используется для "хитов меню" на публичном сайте (routes/postgresql/
// api.js: hitMenuItemIds) — переиспользован для "популярных блюд" здесь,
// не изобретён заново.
const PROGRESSED_STATUSES_SQL = `o.status NOT IN ('cancelled','declined','timed_out','payment_failed','awaiting_payment')`;

// ---------------------------------------------------------------------------
// Даты: YYYY-MM-DD (введено владельцем как локальная дата Europe/Moscow) ->
// UTC-момент начала этих суток. Та же арифметика, что и todayRangeUtc(), но
// для ПРОИЗВОЛЬНОЙ даты, не только "сегодня".
// ---------------------------------------------------------------------------
function dateOnlyToUtcStart(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const localMidnightAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  return new Date(localMidnightAsUtc - offsetMs);
}

function lastNDaysRangeUtc(days, now = new Date()) {
  const { startUtc: todayStart, endUtc } = todayRangeUtc(now);
  const startUtc = new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

const MAX_CUSTOM_RANGE_DAYS = 366;

function resolvePeriodRange({ period, from, to }, now = new Date()) {
  if (period === '7d') return { period: '7d', ...lastNDaysRangeUtc(7, now) };
  if (period === '30d') return { period: '30d', ...lastNDaysRangeUtc(30, now) };
  if (period === 'custom') {
    const startUtc = dateOnlyToUtcStart(from);
    if (!startUtc) throw new ValidationError('Некорректная дата начала периода.');
    const toStart = dateOnlyToUtcStart(to);
    if (!toStart) throw new ValidationError('Некорректная дата конца периода.');
    const endUtc = new Date(toStart.getTime() + 24 * 60 * 60 * 1000); // "до" включительно
    if (endUtc <= startUtc) throw new ValidationError('Дата начала должна быть раньше даты конца.');
    const spanDays = (endUtc.getTime() - startUtc.getTime()) / (24 * 60 * 60 * 1000);
    if (spanDays > MAX_CUSTOM_RANGE_DAYS) throw new ValidationError(`Период не может быть длиннее ${MAX_CUSTOM_RANGE_DAYS} дней.`);
    return { period: 'custom', startUtc, endUtc };
  }
  return { period: 'today', ...todayRangeUtc(now) };
}

// ---------------------------------------------------------------------------
// Обзор ресторана (docs/HQ-PRODUCT-SPEC.md, раздел «Обзор ресторана»)
// ---------------------------------------------------------------------------
//
// Ровно четыре числа — «Заказы: сегодня / за всё время» + «Оборот сегодня» +
// «Доход YAAM сегодня». Слово «доставлено» в управленческих показателях НЕ
// используется (YAAM не курьерская служба, спецификация) — то же множество
// заказов теперь называется «заказы» и считается ЕДИНЫМ существующим
// источником финансовой истины (restaurantFinanceService.
// computeEarningsAggregate: EARNED_ORDER_FILTER_SQL — учтённый заказ =
// выполнен + успешно оплачен + без успешного возврата), а НЕ отдельным
// приблизительным запросом по status='delivered', как было раньше. Оборот и
// доход YAAM берутся из ТОГО ЖЕ агрегата — три числа гарантированно
// согласованы между собой и с вкладкой «Финансы».
//
// Активные заказы и средний чек убраны намеренно (спецификация: HQ — не
// диспетчерская; дублирование между вкладками запрещено).
async function getOverview(restaurantId, now = new Date()) {
  const financeService = require('./restaurantFinanceService'); // ленивый require — тот же приём, что в dashboardMetrics.js (исключает цикл)
  const todayRange = todayRangeUtc(now);

  const [todayRows, allTimeRows] = await Promise.all([
    financeService.computeEarningsAggregate({ restaurantId, range: todayRange }),
    financeService.computeEarningsAggregate({ restaurantId, range: null }),
  ]);

  const today = todayRows[0] || { delivered_paid_orders: 0, turnover: 0, commission: 0 };
  const allTime = allTimeRows[0] || { delivered_paid_orders: 0 };

  return {
    ordersToday: today.delivered_paid_orders,
    ordersAllTime: allTime.delivered_paid_orders,
    turnoverToday: today.turnover,
    commissionToday: today.commission,
  };
}

// ---------------------------------------------------------------------------
// Заказы — список с фильтрами и пагинацией
// ---------------------------------------------------------------------------

// docs/HQ-PRODUCT-SPEC.md, раздел «Заказы ресторана»: на вкладке остался
// ТОЛЬКО фильтр по датам — быстрый фильтр, фильтр по статусу и поиск по
// номеру удалены. Ветки status/filter/code ниже сохранены в самой функции
// (её продолжают вызывать существующие тесты Stage 4 напрямую), но HTTP-
// поверхности у них больше нет: роут передаёт только from/to.
function buildOrderFilter(restaurantId, { filter, status, code, from, to }, now = new Date()) {
  const conditions = ['o.restaurant_id = $1'];
  const params = [restaurantId];

  if (status && VALID_ORDER_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  } else if (filter === 'active') {
    params.push(ACTIVE_STATUSES);
    conditions.push(`o.status = ANY($${params.length})`);
  } else if (filter === 'delivered') {
    conditions.push(`o.status = 'delivered'`);
  } else if (filter === 'cancelled') {
    conditions.push(`o.status IN ('cancelled','declined','timed_out')`);
  } else if (filter === 'today') {
    const { startUtc, endUtc } = todayRangeUtc(now);
    params.push(startUtc, endUtc);
    conditions.push(`o.created_at >= $${params.length - 1} AND o.created_at < $${params.length}`);
  }

  const trimmedCode = typeof code === 'string' ? code.trim() : '';
  if (trimmedCode) {
    params.push(`%${trimmedCode}%`);
    conditions.push(`o.public_code ILIKE $${params.length}`);
  }

  if (from) {
    const fromUtc = dateOnlyToUtcStart(from);
    if (fromUtc) {
      params.push(fromUtc);
      conditions.push(`o.created_at >= $${params.length}`);
    }
  }
  if (to) {
    const toStart = dateOnlyToUtcStart(to);
    if (toStart) {
      params.push(new Date(toStart.getTime() + 24 * 60 * 60 * 1000));
      conditions.push(`o.created_at < $${params.length}`);
    }
  }

  return { whereClause: `WHERE ${conditions.join(' AND ')}`, params };
}

async function listRestaurantOrders(restaurantId, options = {}) {
  const { whereClause, params } = buildOrderFilter(restaurantId, options);
  const resolvedPage = parsePage(options.page);

  const countRows = await db.query(`SELECT COUNT(*)::int AS total FROM orders o ${whereClause}`, params);
  const total = countRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(resolvedPage, totalPages);

  const rows = await db.query(`
    SELECT o.id, o.public_code, o.created_at, o.items_total, o.status, o.rating,
      (SELECT array_agg(oi.name ORDER BY oi.id) FROM order_items oi WHERE oi.order_id = o.id) AS item_names,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int AS item_count,
      (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
      (SELECT rf.status FROM refunds rf JOIN payments p2 ON p2.id = rf.payment_id WHERE p2.order_id = o.id ORDER BY rf.id DESC LIMIT 1) AS refund_status
    FROM orders o
    ${whereClause}
    ORDER BY o.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, PAGE_SIZE, (safePage - 1) * PAGE_SIZE]);

  return { orders: rows, page: safePage, totalPages, total };
}

// Минимальная HQ-detail страница заказа (задание, раздел 7) — PII (имя,
// телефон, адрес, комментарий) читается ТОЛЬКО здесь, никогда в списке.
async function getOrderDetail(restaurantId, orderId) {
  const rows = await db.query(
    `SELECT o.* FROM orders o WHERE o.id = $1 AND o.restaurant_id = $2`,
    [orderId, restaurantId],
  );
  const order = rows[0];
  if (!order) return null;
  const items = await db.query(
    'SELECT name, price, qty FROM order_items WHERE order_id = $1 ORDER BY id',
    [order.id],
  );
  const payments = await db.query(
    'SELECT id, status, amount, created_at FROM payments WHERE order_id = $1 ORDER BY id',
    [order.id],
  );
  const refunds = await db.query(
    `SELECT rf.id, rf.status, rf.amount, rf.created_at FROM refunds rf
     JOIN payments p ON p.id = rf.payment_id WHERE p.order_id = $1 ORDER BY rf.id`,
    [order.id],
  );
  return { order, items, payments, refunds };
}

// ---------------------------------------------------------------------------
// Оценки
// ---------------------------------------------------------------------------
//
// Только чтение orders.rating — единственный источник, поддерживаемый
// orderService.rateOrder() (см. его комментарии: одна оценка на заказ,
// UPDATE ... WHERE rating IS NULL исключает повторную оценку, доступна
// только для delivered+оплаченных заказов). Эта функция НЕ пересчитывает и
// НЕ создаёт rating-логику заново — только читает уже существующий
// агрегат.
async function getRatingsDistribution(restaurantId) {
  const rows = await db.query(
    `SELECT rating, COUNT(*)::int AS c FROM orders WHERE restaurant_id = $1 AND rating IS NOT NULL GROUP BY rating`,
    [restaurantId],
  );
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const row of rows) distribution[row.rating] = row.c;
  return distribution;
}

// ПРИМЕЧАНИЕ (найденное ограничение схемы, не скрыто): orders не хранит
// отдельный "момент, когда поставлена оценка" — только created_at (создание
// заказа) и status_updated_at (последний переход СТАТУСА, не связан с
// rating). rateOrder() делает голый UPDATE orders SET rating=... без
// собственной временной метки. Показывать здесь status_updated_at как "дата
// оценки" было бы введением в заблуждение (это дата последнего перехода
// статуса, обычно — момента доставки, а не момента, когда клиент поставил
// звёзды, который может случиться значительно позже). Поэтому список ниже
// сознательно подписан "Дата заказа", не "Дата оценки" — честное отражение
// того, что реально можно узнать из текущей схемы.
async function listRestaurantRatings(restaurantId, options = {}) {
  const resolvedPage = parsePage(options.page);
  const countRows = await db.query(
    `SELECT COUNT(*)::int AS total FROM orders WHERE restaurant_id = $1 AND rating IS NOT NULL`,
    [restaurantId],
  );
  const total = countRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(resolvedPage, totalPages);
  const rows = await db.query(
    `SELECT id, public_code, rating, created_at FROM orders
     WHERE restaurant_id = $1 AND rating IS NOT NULL
     ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [restaurantId, PAGE_SIZE, (safePage - 1) * PAGE_SIZE],
  );
  return { ratings: rows, page: safePage, totalPages, total };
}

// ---------------------------------------------------------------------------
// Статистика
// ---------------------------------------------------------------------------

// PROJECT_TIMEZONE_OFFSET_MINUTES интерполируется в текст SQL НАПРЯМУЮ (не
// параметром) — безопасно ИМЕННО потому, что это фиксированная константа
// модуля (всегда 180), а не значение, производное от запроса пользователя;
// то же рассуждение, что уже применено к HIT_MIN_QTY/HIT_TOP_N в routes/
// postgresql/api.js.
//
// НАЙДЕННЫЙ И ИСПРАВЛЕННЫЙ БАГ (воспроизведён вживую через Chrome DevTools —
// см. финальный отчёт Stage 4): `pg` парсит SQL-тип DATE в JS Date,
// используя ЛОКАЛЬНЫЙ часовой пояс ПРОЦЕССА Node (не UTC!) — на машине с
// системным TZ, отличным от UTC (например, Europe/Moscow — ровно то, что
// произошло при разработке), `row.day.toISOString().slice(0,10)` тихо
// сдвигал дату на сутки назад, и вся серия "заказы по дням" показывала 0
// там, где реально были заказы. Чтобы это НИКОГДА не зависело от того,
// в каком TZ настроен конкретный сервер (VPS может быть UTC, может быть
// любым другим — рассчитывать на совпадение нельзя), SQL ниже возвращает
// день уже КАК ТЕКСТ ("YYYY-MM-DD", to_char) — простую строку, а не Date,
// исключая любую двусмысленность парсинга на стороне JS.
function buildDailySeries(rows, startUtc, endUtc) {
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const countsByDay = new Map();
  for (const row of rows) {
    countsByDay.set(row.day, row.c);
  }
  const series = [];
  let cursor = new Date(startUtc.getTime() + offsetMs);
  const localEnd = new Date(endUtc.getTime() + offsetMs);
  while (cursor < localEnd) {
    const key = cursor.toISOString().slice(0, 10);
    series.push({ date: key, count: countsByDay.get(key) || 0 });
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return series;
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Статистика»: «сегодня — по часам».
// Тот же приём защиты от локального TZ процесса, что и buildDailySeries
// выше: час считается прямо в SQL уже со сдвигом на часовой пояс проекта и
// возвращается ЧИСЛОМ 0..23, а не датой, которую драйвер мог бы разобрать в
// произвольной таймзоне. Возвращаются все 24 часа (в том числе нулевые) —
// иначе график «сегодня» менял бы форму в течение дня.
function buildHourlySeries(rows) {
  const byHour = new Map(rows.map((r) => [Number(r.hour), r.c]));
  const series = [];
  for (let hour = 0; hour < 24; hour += 1) {
    series.push({ hour, count: byHour.get(hour) || 0 });
  }
  return series;
}

const POPULAR_DISHES_LIMIT = 5;

async function getStatistics(restaurantId, periodOptions, now = new Date()) {
  const range = resolvePeriodRange(periodOptions, now);
  const { startUtc, endUtc } = range;

  const [row] = await db.query(`
    SELECT
      COUNT(*)::int AS created,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded'))::int AS paid,
      COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
      COALESCE(SUM(o.items_total) FILTER (WHERE o.status = 'delivered'), 0)::int AS turnover,
      COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS customer_cancels,
      COUNT(*) FILTER (WHERE o.status = 'declined')::int AS restaurant_declines,
      COUNT(*) FILTER (WHERE o.status = 'timed_out')::int AS timed_out,
      COUNT(*) FILTER (WHERE o.status = 'payment_failed')::int AS payment_failed,
      COUNT(*) FILTER (WHERE o.rating IS NOT NULL)::int AS rating_count,
      AVG(o.rating) FILTER (WHERE o.rating IS NOT NULL) AS avg_rating
    FROM orders o
    WHERE o.restaurant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
  `, [restaurantId, startUtc, endUtc]);

  const popularByQty = await db.query(`
    SELECT oi.name, SUM(oi.qty)::int AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.restaurant_id = $1 AND o.created_at >= $2 AND o.created_at < $3 AND ${PROGRESSED_STATUSES_SQL}
    GROUP BY oi.name ORDER BY qty DESC LIMIT ${POPULAR_DISHES_LIMIT}
  `, [restaurantId, startUtc, endUtc]);

  const popularByRevenue = await db.query(`
    SELECT oi.name, SUM(oi.qty * oi.price)::int AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.restaurant_id = $1 AND o.created_at >= $2 AND o.created_at < $3 AND ${PROGRESSED_STATUSES_SQL}
    GROUP BY oi.name ORDER BY revenue DESC LIMIT ${POPULAR_DISHES_LIMIT}
  `, [restaurantId, startUtc, endUtc]);

  const dailyRows = await db.query(`
    SELECT to_char(date_trunc('day', (o.created_at AT TIME ZONE 'UTC') + interval '${PROJECT_TIMEZONE_OFFSET_MINUTES} minutes'), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS c
    FROM orders o
    WHERE o.restaurant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
    GROUP BY day ORDER BY day
  `, [restaurantId, startUtc, endUtc]);

  // Почасовой срез нужен только периоду «сегодня» — на 7/30 днях он
  // смешал бы разные сутки в один столбец и вводил бы в заблуждение.
  const hourlyRows = range.period === 'today'
    ? await db.query(`
        SELECT EXTRACT(HOUR FROM ((o.created_at AT TIME ZONE 'UTC') + interval '${PROJECT_TIMEZONE_OFFSET_MINUTES} minutes'))::int AS hour,
               COUNT(*)::int AS c
        FROM orders o
        WHERE o.restaurant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
        GROUP BY hour ORDER BY hour
      `, [restaurantId, startUtc, endUtc])
    : [];

  return {
    hourlySeries: range.period === 'today' ? buildHourlySeries(hourlyRows) : null,
    period: range.period,
    startUtc,
    endUtc,
    created: row.created,
    paid: row.paid,
    delivered: row.delivered,
    turnover: row.turnover,
    avgCheck: row.delivered > 0 ? Math.round(row.turnover / row.delivered) : null,
    avgRating: row.avg_rating !== null ? Math.round(Number(row.avg_rating) * 10) / 10 : null,
    ratingCount: row.rating_count,
    customerCancels: row.customer_cancels,
    restaurantDeclines: row.restaurant_declines,
    timedOut: row.timed_out,
    paymentFailed: row.payment_failed,
    // "создано -> доставлено" за ВЫБРАННЫЙ период — заказы, ещё не
    // завершившиеся к концу периода (в процессе), не считаются ни
    // доставленными, ни отменёнными: конверсия за "сегодня"/незакрытый
        // период всегда занижена относительно итоговой судьбы этих заказов —
    // явно подписывается в UI, не выдаётся как окончательное число.
    conversionPercent: row.created > 0 ? Math.round((row.delivered / row.created) * 1000) / 10 : null,
    popularByQty,
    popularByRevenue,
    dailySeries: buildDailySeries(dailyRows, startUtc, endUtc),
  };
}

module.exports = {
  dateOnlyToUtcStart,
  lastNDaysRangeUtc,
  resolvePeriodRange,
  getOverview,
  listRestaurantOrders,
  getOrderDetail,
  getRatingsDistribution,
  listRestaurantRatings,
  getStatistics,
  buildDailySeries,
  buildHourlySeries,
  VALID_ORDER_STATUSES,
  MAX_CUSTOM_RANGE_DAYS,
};
