'use strict';

// YAAM HQ Stage 4 — рабочий раздел «Рестораны». Единственное новое место
// для SQL-логики этого раздела; переиспользует, а не дублирует, уже
// существующее там, где это безопасно:
//   - pauseRestaurant/resumeRestaurant — services/postgresql/orderService.js
//     (Stage 3, уже живо используется routes/postgresql/admin.js) — НЕ
//     переписаны здесь заново, вызываются напрямую;
//   - todayRangeUtc/PROJECT_TIMEZONE_OFFSET_MINUTES — services/hq/
//     dashboardMetrics.js (Stage 2) — тот же якорь времени Europe/Moscow,
//     не второй, потенциально рассинхронизированный расчёт;
//   - ORDERS_COUNT_JOIN-эквивалент (delivered + оплачен) — та же формула,
//     что и в routes/postgresql/api.js (публичный счётчик "N заказов" на
//     карточке), не другая.
const db = require('../../db/postgresql');
const crypto = require('node:crypto');
const orderService = require('../postgresql/orderService');
const { todayRangeUtc, PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./dashboardMetrics');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

const PAGE_SIZE = 20;
const ACTIVE_STATUSES = ['awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier'];

// ---------------------------------------------------------------------------
// Список ресторанов — search/filter/sort/pagination
// ---------------------------------------------------------------------------

// Allowlist — ЕДИНСТВЕННЫЙ способ, которым query-параметр `sort` может
// повлиять на SQL: маппинг на заранее написанное ORDER BY выражение, никогда
// не строковая интерполяция самого параметра (задание, раздел 3 — "не
// позволять произвольный SQL sort-column из query string").
const SORT_COLUMNS = {
  name: 'r.name ASC',
  orders: 'delivered_count DESC, r.name ASC',
  rating: 'r.rating DESC, r.rating_count DESC',
  created: 'r.created_at DESC',
};
const DEFAULT_SORT = 'name';
const STATUS_FILTERS = ['open', 'closed', 'paused', 'archived'];

function resolveSort(value) {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, value) ? value : DEFAULT_SORT;
}

function resolveStatusFilter(value) {
  return STATUS_FILTERS.includes(value) ? value : null;
}

function parsePage(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

// Внутренний helper — единые условия WHERE + параметры, переиспользуются и
// счётчиком total, и самой выборкой страницы (одна и та же логика фильтров,
// не два места, которые могут разойтись).
function buildListFilter({ search, city, status }) {
  const conditions = [];
  const params = [];
  const resolvedStatus = resolveStatusFilter(status);

  if (resolvedStatus === 'archived') {
    conditions.push('r.archived_at IS NOT NULL');
  } else {
    conditions.push('r.archived_at IS NULL');
    if (resolvedStatus === 'open') conditions.push('r.is_open = 1');
    else if (resolvedStatus === 'paused') conditions.push('r.is_open = 0 AND r.paused_until IS NOT NULL');
    else if (resolvedStatus === 'closed') conditions.push('r.is_open = 0 AND r.paused_until IS NULL');
  }

  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    params.push(`%${trimmedSearch}%`);
    conditions.push(`r.name ILIKE $${params.length}`);
  }

  const trimmedCity = typeof city === 'string' ? city.trim() : '';
  if (trimmedCity) {
    // `?` — оператор jsonb "существует ли строка как элемент верхнего уровня
    // массива" — cities хранится как TEXT-JSON-массив (см. schema.sql),
    // безопасно параметризован (не строковая склейка LIKE по сырому JSON).
    params.push(trimmedCity);
    conditions.push(`r.cities::jsonb ? $${params.length}`);
  }

  return { whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params, resolvedStatus };
}

// delivered_count — тем же критерием, что и публичный счётчик на карточке
// ресторана (routes/postgresql/api.js: ORDERS_COUNT_JOIN) — delivered И
// платёж succeeded, не просто status='delivered' в отрыве от оплаты.
const DELIVERED_COUNT_SUBQUERY = `(
  SELECT COUNT(*) FROM orders o
  WHERE o.restaurant_id = r.id AND o.status = 'delivered'
    AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
)::int`;

async function listRestaurants({ search, city, status, sort, page } = {}) {
  const { whereClause, params } = buildListFilter({ search, city, status });
  const resolvedSort = resolveSort(sort);
  const resolvedPage = parsePage(page);

  const countRows = await db.query(
    `SELECT COUNT(*)::int AS total FROM restaurants r ${whereClause}`,
    params,
  );
  const total = countRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(resolvedPage, totalPages);

  const listParams = [...params, PAGE_SIZE, (safePage - 1) * PAGE_SIZE];
  const rows = await db.query(`
    SELECT r.*,
      ${DELIVERED_COUNT_SUBQUERY} AS delivered_count,
      (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.status = ANY($${params.length + 3}))::int AS active_count
    FROM restaurants r
    ${whereClause}
    ORDER BY ${SORT_COLUMNS[resolvedSort]}, r.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...listParams, ACTIVE_STATUSES]);

  return {
    restaurants: rows,
    page: safePage,
    totalPages,
    total,
    pageSize: PAGE_SIZE,
    sort: resolvedSort,
  };
}

// ---------------------------------------------------------------------------
// Одна запись
// ---------------------------------------------------------------------------

async function getRestaurantById(id) {
  const numericId = Number.parseInt(id, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [numericId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Создание/правка
// ---------------------------------------------------------------------------

// Ровно то, что реально поддерживает текущая схема и запрошено заданием
// (раздел 4) — БЕЗ delivery_price ("YAAM не управляет доставкой", явный
// запрет задания добавлять поля доставки в ЭТУ форму, хотя сама колонка в
// схеме остаётся нетронутой для уже существующего server/routes/postgresql/
// admin.js, который её продолжает использовать как раньше).
function parseRestaurantInput(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new ValidationError('Название обязательно.');

  const citiesRaw = typeof body.cities === 'string' ? body.cities : '';
  const cities = citiesRaw.split(',').map((c) => c.trim()).filter(Boolean);
  if (!cities.length) throw new ValidationError('Укажите хотя бы один город.');

  const minOrder = body.min_order === '' || body.min_order === undefined ? 0 : Number(body.min_order);
  if (!Number.isFinite(minOrder) || minOrder < 0) throw new ValidationError('Минимальная сумма заказа должна быть неотрицательным числом.');

  return {
    name,
    cuisine: typeof body.cuisine === 'string' ? body.cuisine.trim() : '',
    description: typeof body.description === 'string' ? body.description.trim() : '',
    cities: JSON.stringify(cities),
    address: typeof body.address === 'string' ? body.address.trim() : '',
    hours: typeof body.hours === 'string' ? body.hours.trim() : '',
    phone: typeof body.phone === 'string' ? body.phone.trim() : '',
    minOrder,
  };
}

// Новый ресторан создаётся ЗАКРЫТЫМ (is_open=0) — намеренно, не оплошность:
// на Stage 4 меню/блюда ещё не реализованы (Stage 5), у только что
// созданного ресторана физически не может быть карточек блюд — открывать
// его для публичных заказов раньше готового меню означало бы показать
// клиенту пустой ресторан. Владелец открывает вручную (кнопка "Открыть"),
// когда ресторан реально готов принимать заказы.
async function createRestaurant(body) {
  const input = parseRestaurantInput(body);
  const connectCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  const inserted = await db.execute(
    `INSERT INTO restaurants (name, cuisine, description, cities, address, hours, phone, min_order, is_open, connect_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9) RETURNING *`,
    [input.name, input.cuisine, input.description, input.cities, input.address, input.hours, input.phone, input.minOrder, connectCode],
  );
  return inserted.rows[0];
}

async function updateRestaurant(id, body) {
  const input = parseRestaurantInput(body);
  const updated = await db.execute(
    `UPDATE restaurants SET name=$1, cuisine=$2, description=$3, cities=$4, address=$5, hours=$6, phone=$7, min_order=$8
     WHERE id=$9 RETURNING *`,
    [input.name, input.cuisine, input.description, input.cities, input.address, input.hours, input.phone, input.minOrder, id],
  );
  return updated.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Пауза / возобновление — переиспользует orderService напрямую, не
// переопределяет его логику.
// ---------------------------------------------------------------------------

async function pauseRestaurant(id, presetKey) {
  return orderService.pauseRestaurant(id, presetKey);
}

async function resumeRestaurant(id) {
  return orderService.resumeRestaurant(id);
}

// ---------------------------------------------------------------------------
// Архивирование / восстановление
// ---------------------------------------------------------------------------

// Архивирование ВСЕГДА закрывает ресторан (is_open=0, снимает паузу) — не
// оставляет архивированный ресторан формально "открытым": публичный API
// (routes/postgresql/api.js) отдельно фильтрует archived_at IS NOT NULL, но
// is_open=0 здесь — дополнительный, не единственный барьер, тот же
// defense-in-depth принцип, что уже используется в этой кодовой базе (см.
// orderService.rateOrder, комментарий "быстрый, но не единственный барьер").
async function archiveRestaurant(id) {
  const updated = await db.execute(
    `UPDATE restaurants SET archived_at = NOW(), is_open = 0, paused_until = NULL WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id],
  );
  return updated.rows[0] || null;
}

async function restoreRestaurant(id) {
  // Восстановленный ресторан возвращается ЗАКРЫТЫМ (is_open остаётся 0,
  // как и было выставлено при архивировании) — владелец открывает вручную,
  // тот же принцип, что и у только что созданного ресторана.
  const updated = await db.execute(
    `UPDATE restaurants SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL RETURNING *`,
    [id],
  );
  return updated.rows[0] || null;
}

module.exports = {
  ValidationError,
  PAGE_SIZE,
  ACTIVE_STATUSES,
  listRestaurants,
  getRestaurantById,
  createRestaurant,
  updateRestaurant,
  pauseRestaurant,
  resumeRestaurant,
  archiveRestaurant,
  restoreRestaurant,
  resolveSort,
  resolveStatusFilter,
  parsePage,
  parseRestaurantInput,
};
