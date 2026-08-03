'use strict';

// YAAM — PostgreSQL routes/api.js, Production Switch Stage 1.
//
// Изолированный, параллельный порт server/routes/api.js на PostgreSQL —
// НЕ импортируется из server.js (та же граница, что у всех волн
// server/services/postgresql/orderService.js). Никакое реальное приложение
// сегодня этот файл не обслуживает; подключение к server.js — Stage 8
// (Production Switch, инфраструктурный этап), не часть этой задачи.
//
// Единственный источник данных — server/db/postgresql (через
// server/services/postgresql/orderService.js для всего, что касается
// заказов/платежей/возвратов/рейтинга, и напрямую через db.query() для
// простых read-only запросов по ресторанам/меню — тот же архитектурный
// принцип, что и в SQLite-оригинале, где routes/api.js тоже делает часть
// запросов напрямую, а часть — через orderService). НИ ОДИН обработчик
// здесь не требует '../../db' (SQLite) и не вызывает orderAccessService.js
// (SQLite) — их чистые функции продублированы в orderService.js
// (см. Wave 4/5/Stage 1 комментарии там).
//
// Что перенесено полностью: GET /restaurants, GET /restaurants/:id,
// POST /orders, POST /orders/recover, GET /orders/:code,
// POST /orders/:code/cancel, POST /orders/:code/retry-payment,
// POST /orders/:code/rate, POST /webhooks/payment,
// POST /orders/:code/dev-confirm-payment — все 9 маршрутов SQLite-оригинала,
// без исключений (см. PDF-отчёт Stage 1 за обоснованием retry-payment: он
// стал переносим только благодаря добавленному в этой же задаче
// ensureRetryAttemptReady()).
//
// provider layer (paymentService.js, mockProvider.js, yookassaProvider.js)
// НЕ менялся ни на строку — только вызывается его существующий контракт.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../../db/postgresql');
const orderService = require('../../services/postgresql/orderService');
const webhookRejectionService = require('../../services/postgresql/webhookRejectionService');
const { payloadFingerprint } = require('../../services/postgresql/paymentReconciliationService');
const orderShareService = require('../../services/postgresql/orderShareService');
const paymentService = require('../../services/paymentService');
// YAAM HQ Stage 5B — тот же module-level singleton принцип, что и db.js
// выше (читает process.env напрямую, не получает конфигурацию через
// factory/DI — routes/postgresql/api.js исторически изолированный модуль,
// см. комментарий в начале файла). getPublicUrl() — чистая функция без
// сети, поэтому дублирование инстанса с services/postgresql/app.js
// (который создаёт СВОЙ mediaProvider для HQ) безопасно: оба выводят
// идентичные URL из одной и той же конфигурации окружения.
const { createMediaProviderFromEnv } = require('../../services/hq/media/provider');
const { attachPhotoFields } = require('../../services/hq/media/publicPhotoDTO');
const mediaProvider = createMediaProviderFromEnv(process.env);

const router = express.Router();

// Дословная копия rate-limit конфигурации из SQLite-оригинала — не
// бизнес-логика заказов, не зависит от движка БД, дублируется тем же
// приёмом, что и все чистые helper'ы предыдущих волн (не импортируется из
// routes/api.js, чтобы этот файл оставался полностью самодостаточным и
// изолированным, как того требует архитектурная граница всей миграции).
function rateLimitHandler(message) {
  return (req, res) => {
    console.warn(
      `[api-postgresql] rate-limit ip=${req.ip} endpoint=${req.method} ${req.originalUrl} `
      + `time=${new Date().toISOString()} ua="${req.get('user-agent') || ''}"`,
    );
    res.status(429).json({ error: message });
  };
}

const orderCreateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('Слишком много попыток оформить заказ — попробуйте через несколько минут'),
});

const orderReadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('Слишком много запросов статуса — попробуйте чуть позже'),
});

const orderMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('Слишком много запросов — попробуйте чуть позже'),
});

function bearerToken(req) {
  return orderService.parseBearerAuthorization(req.get('authorization'));
}

// Синхронна (как и в оригинале) — не делает SQL, только парсинг заголовков.
function requireBearerForCreate(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const token = bearerToken(req);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Требуется защищённый доступ к заказу' });
  }
  if (!orderService.isValidCreateKey(req.get('idempotency-key'))) {
    return res.status(400).json({ error: 'Некорректный ключ создания заказа' });
  }
  req.orderAccessToken = token;
  req.createIdempotencyKey = req.get('idempotency-key');
  return next();
}

// Единственное структурное отличие от SQLite-оригинала: middleware стала
// async (findAuthorizedOrderId/getOrder — асинхронные PostgreSQL-запросы).
// Ошибки БД перехватываются явно и отвечают 500 — Express 4 не подхватывает
// отклонённые promise из middleware сам по себе, поэтому try/catch
// обязателен здесь и во всех async-обработчиках ниже.
async function requireOrderAccess(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    const token = bearerToken(req);
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Требуется защищённый доступ к заказу' });
    }
    const orderId = await orderService.findAuthorizedOrderId(req.params.code, token);
    if (!orderId) return res.status(404).json({ error: 'заказ не найден' });
    req.orderAccessToken = token;
    req.order = await orderService.getOrder(orderId);
    return next();
  } catch (err) {
    console.error('[api-postgresql] requireOrderAccess failed:', err.message);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}

// Фича «Поделиться заказом» (Web Share API): read-only аналог
// requireOrderAccess, но принимает ТОЛЬКО share-токен (order_share_tokens,
// см. orderShareService.js) — намеренно не даёт доступа к cancel/
// retry-payment/rate роутам ниже, только к GET /orders/:code/shared.
async function requireOrderShareAccess(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    const token = orderShareService.parseBearerShareToken(req.get('authorization'));
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Требуется ссылка «Поделиться»' });
    }
    const orderId = await orderShareService.findAuthorizedOrderIdByShareToken(req.params.code, token);
    if (!orderId) return res.status(404).json({ error: 'заказ не найден' });
    req.order = await orderService.getOrder(orderId);
    return next();
  } catch (err) {
    console.error('[api-postgresql] requireOrderShareAccess failed:', err.message);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}

function errorStatus(err) {
  return Number.isInteger(err.statusCode) ? err.statusCode : 400;
}

function publicCreationResponse({ order, payment, context }) {
  return {
    order: orderService.toPublicOrderDTO(order),
    payment: orderService.toPublicPaymentDTO(payment),
    context,
  };
}

function sendCreationError(res, err, operation) {
  if (Number.isInteger(err.statusCode)) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error(`[api-postgresql] ${operation} failed type=${err?.name || 'Error'}`);
  return res.status(500).json({ error: 'Не удалось безопасно оформить заказ' });
}

// --- Рестораны/меню — дословный порт inline SQL SQLite-оригинала (там —
// синхронный prepared statement) на db.query() (PostgreSQL, асинхронный),
// $-плейсхолдеры вместо ?, датой/JSON-логика не менялась (cities по-прежнему
// хранится TEXT/JSON, парсится так же). COUNT(...)::int — обязательный
// PostgreSQL-специфичный каст: driver `pg` по умолчанию возвращает BIGINT
// как JS-строку (защита от потери точности за пределами Number.
// MAX_SAFE_INTEGER), SQLite всегда отдавал обычное число — без ::int
// orders_count пришёл бы клиенту строкой, а не числом (расхождение DTO,
// не просто стиль). Эти запросы никогда не проходили через orderService.js
// даже в SQLite-версии (справочник ресторанов/меню — не часть
// order/payment/refund/rating state machine) — тот же архитектурный контур
// сохранён здесь.

const HIT_TOP_N = 3;
const HIT_MIN_QTY = 8;

async function hitMenuItemIds(restaurantId) {
  const rows = await db.query(
    `SELECT oi.menu_item_id AS id, SUM(oi.qty) AS sold
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1
       AND oi.menu_item_id IS NOT NULL
       AND o.status NOT IN ('cancelled','declined','timed_out','payment_failed','awaiting_payment')
       AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
     GROUP BY oi.menu_item_id
     HAVING SUM(oi.qty) >= $2
     ORDER BY sold DESC
     LIMIT $3`,
    [restaurantId, HIT_MIN_QTY, HIT_TOP_N],
  );
  return new Set(rows.map((r) => r.id));
}

// Публичный контракт ресторана — явный allowlist, а не SELECT *-спред.
// restaurants хранит и внутренние поля (connect_code — одноразовый код
// привязки Telegram-бота, telegram_chat_id — внутренний chat id бота), у
// которых нет причин когда-либо попадать неавторизованному клиенту; phone
// сюда намеренно НЕ входит — он раскрывается клиенту только через order DTO
// ПОСЛЕ оформления заказа (см. orderService.js: restaurant_phone в
// getOrder()/toPublicOrderDTO), не на карточке/странице ресторана заранее
// (см. client/js/app.js, комментарий над showRestaurantPhone()). Список
// сверен с normalizeRestaurant() в client/js/app.js — все поля ниже реально
// потребляются фронтендом (кроме default_cook_minutes, который клиенту пока
// не нужен, но безвреден и явно допущен продуктовым решением этой задачи).
// Allowlist специально предпочтён подходу "удалить одно поле после SELECT *"
// — так любая новая внутренняя колонка в будущем по умолчанию НЕ уходит
// наружу, пока её явно не добавят в этот список.
const PUBLIC_RESTAURANT_FIELDS = [
  'id', 'name', 'cuisine', 'photo_url', 'cities', 'address', 'hours',
  'delivery_price', 'min_order', 'is_open', 'is_new', 'rating',
  'rating_count', 'default_cook_minutes', 'orders_count',
];

function toPublicRestaurantDTO(row) {
  const dto = {};
  for (const field of PUBLIC_RESTAURANT_FIELDS) {
    dto[field] = field === 'cities' ? JSON.parse(row.cities || '[]') : row[field];
  }
  return dto;
}

// YAAM HQ Stage 5A — тот же allowlist-принцип, что и PUBLIC_RESTAURANT_FIELDS
// выше: явный список полей блюда, которые уходят клиенту, а не "весь ряд
// минус пара полей". `archived_at` не может утечь, даже если завтра в
// menu_items добавят ещё одну внутреннюю колонку — она просто не попадёт в
// DTO, пока её явно сюда не добавят. `category_id`/`restaurant_id`/
// `sort_order` намеренно не включены — внутренняя структура БД, клиенту
// не нужна (порядок уже выражен порядком элементов массива `items`).
const PUBLIC_MENU_ITEM_FIELDS = [
  'id', 'name', 'description', 'composition', 'price', 'photo_url',
  'weight_g', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'is_available',
  'is_popular',
];

function toPublicMenuItemDTO(row) {
  const dto = {};
  for (const field of PUBLIC_MENU_ITEM_FIELDS) {
    dto[field] = row[field];
  }
  return dto;
}

// Батч-запросы (не N+1) — один SELECT ... WHERE owner_id = ANY($1) на весь
// список ресторанов/блюд одного ответа, независимо от того, сколько их.
// mediaProvider === null (MEDIA_PROVIDER не задан) -> пустая карта, публичный
// API продолжает работать через legacy photo_url (см. buildPhotoFields).
// Stage 5B.1 — у фотографий больше нет archived_at (удаление необратимо,
// см. services/hq/media/photoService.js) — все строки в этих таблицах уже
// "активны" по определению.
async function fetchActiveRestaurantPhotos(restaurantIds) {
  const map = new Map();
  if (!mediaProvider || !restaurantIds.length) return map;
  const rows = await db.query(
    'SELECT * FROM restaurant_photos WHERE restaurant_id = ANY($1::int[]) ORDER BY restaurant_id, sort_order, id',
    [restaurantIds],
  );
  for (const row of rows) {
    if (!map.has(row.restaurant_id)) map.set(row.restaurant_id, []);
    map.get(row.restaurant_id).push(row);
  }
  return map;
}

async function fetchActiveMenuItemPhotos(menuItemIds) {
  const map = new Map();
  if (!mediaProvider || !menuItemIds.length) return map;
  const rows = await db.query(
    'SELECT * FROM menu_item_photos WHERE menu_item_id = ANY($1::int[]) ORDER BY menu_item_id, sort_order, id',
    [menuItemIds],
  );
  for (const row of rows) {
    if (!map.has(row.menu_item_id)) map.set(row.menu_item_id, []);
    map.get(row.menu_item_id).push(row);
  }
  return map;
}

// Публичное меню отдаёт только неархивированные категории и блюда
// неархивированного ресторана (задание Stage 5A, раздел 11) — тот же
// принцип фильтрации, что уже применён к самому ресторану (Stage 4:
// archived_at, Stage 4.1: published_at) в GET /restaurants ниже.
async function restaurantWithMenu(restaurant) {
  const categories = await db.query(
    'SELECT * FROM categories WHERE restaurant_id = $1 AND archived_at IS NULL ORDER BY sort_order',
    [restaurant.id],
  );
  const items = await db.query(
    'SELECT * FROM menu_items WHERE restaurant_id = $1 AND archived_at IS NULL ORDER BY sort_order',
    [restaurant.id],
  );
  const hits = await hitMenuItemIds(restaurant.id);
  const [restaurantPhotos, itemPhotos] = await Promise.all([
    fetchActiveRestaurantPhotos([restaurant.id]),
    fetchActiveMenuItemPhotos(items.map((i) => i.id)),
  ]);
  return {
    ...attachPhotoFields(mediaProvider, toPublicRestaurantDTO(restaurant), restaurantPhotos.get(restaurant.id) || [], restaurant.photo_url),
    menu: categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => attachPhotoFields(
          mediaProvider,
          toPublicMenuItemDTO({ ...i, is_popular: hits.has(i.id) ? 1 : 0 }),
          itemPhotos.get(i.id) || [],
          i.photo_url,
        )),
    })),
  };
}

// YAAM HQ Stage 1: публичный счётчик "N заказов" на карточке ресторана считает
// только реально завершённые заказы — status='delivered' с оплатой, всё ещё
// succeeded на момент запроса (payments.status переходит в 'refunded' при
// полном возврате — см. orderService.js finalizeRefundSucceeded — поэтому
// доставленный, но затем полностью возвращённый заказ уже не проходит этот
// EXISTS сам по себе, отдельного исключения не требуется).
// Раньше здесь стоял NOT IN(...) — считал и ещё не доставленные, но уже
// оплаченные заказы (awaiting_restaurant/accepted/preparing/courier). Это
// было осознанным более ранним решением (см. историю), но конфликтует с
// требованием "не увеличивать счётчик на этапе принятия/приготовления" —
// изменено на строгое status='delivered' по этому требованию.
const ORDERS_COUNT_JOIN = `
  LEFT JOIN orders o ON o.restaurant_id = r.id
    AND o.status = 'delivered'
    AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
`;

// Stage 25 — закрытие Stage 24 MEDIUM-2: список/карточка ресторана уже
// получают слабый ETag (Express res.json() по умолчанию), но без единого
// явного Cache-Control браузер решает сам, сколько держать ответ в кэше —
// на практике это давало задержку между сохранением в HQ и появлением
// изменения у клиента. no-cache (НЕ no-store) означает «кэшируй, но всегда
// сверься с сервером» — условный запрос с ETag по-прежнему может вернуть 304
// и не тратить трафик, просто клиент больше не имеет права показать старый
// ответ БЕЗ этой сверки. Фильтрация видимости (archived_at/published_at/
// is_available) этим не затрагивается вообще.
function setNoCacheHeader(req, res, next) {
  res.set('Cache-Control', 'no-cache');
  next();
}

router.get('/restaurants', setNoCacheHeader, async (req, res) => {
  try {
    const city = req.query.city;
    // YAAM HQ Stage 4: архивированный ресторан не должен появляться на
    // публичном сайте (задание, раздел 11) — archived_at IS NOT NULL
    // фильтруется здесь же, на уровне единственного публичного списка, а не
    // где-то ещё. История заказов/оценок архивированного ресторана не
    // затронута — фильтр только скрывает его из ЭТОГО списка.
    //
    // Stage 4.1: published_at IS NOT NULL — второе, независимое условие
    // (задание, раздел 11): черновик (никогда не публиковался) и ресторан,
    // снятый с публикации, скрыты точно так же, как архивированный, хотя
    // archived_at у них остаётся NULL. is_open здесь НЕ участвует в фильтре
    // вовсе — открытый и закрытый (но опубликованный) ресторан оба видны
    // клиенту, is_open только меняет то, что видит клиент (может ли сейчас
    // заказать), а не видит ли он ресторан вообще (задание, раздел 0).
    const rows = await db.query(`
      SELECT r.*, COUNT(o.id)::int AS orders_count
      FROM restaurants r
      ${ORDERS_COUNT_JOIN}
      WHERE r.archived_at IS NULL AND r.published_at IS NOT NULL
      GROUP BY r.id
    `);
    const filtered = rows.filter((r) => !city || JSON.parse(r.cities || '[]').includes(city));
    const photosByRestaurant = await fetchActiveRestaurantPhotos(filtered.map((r) => r.id));
    const all = filtered.map((r) => attachPhotoFields(mediaProvider, toPublicRestaurantDTO(r), photosByRestaurant.get(r.id) || [], r.photo_url));
    res.json(all);
  } catch (err) {
    console.error('[api-postgresql] GET /restaurants failed:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/restaurants/:id', setNoCacheHeader, async (req, res) => {
  try {
    // Тот же фильтр, что и в списке выше (включая published_at IS NOT NULL,
    // Stage 4.1) — прямой запрос черновика/снятого с публикации/
    // архивированного ресторана по id тоже должен вести себя как "не
    // найден", а не тихо отдавать данные ресторана, скрытого владельцем.
    const rows = await db.query(`
      SELECT r.*, COUNT(o.id)::int AS orders_count
      FROM restaurants r
      ${ORDERS_COUNT_JOIN}
      WHERE r.id = $1 AND r.archived_at IS NULL AND r.published_at IS NOT NULL GROUP BY r.id
    `, [req.params.id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'ресторан не найден' });
    res.json(await restaurantWithMenu(r));
  } catch (err) {
    console.error('[api-postgresql] GET /restaurants/:id failed:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/orders', orderCreateLimiter, requireBearerForCreate, async (req, res) => {
  try {
    const result = await orderService.createOrderAndResolve({
      ...req.body,
      orderAccessToken: req.orderAccessToken,
      createIdempotencyKey: req.createIdempotencyKey,
    });
    return res.status(201).json(publicCreationResponse(result));
  } catch (err) {
    return sendCreationError(res, err, 'create-order');
  }
});

router.post('/orders/recover', orderCreateLimiter, requireBearerForCreate, async (req, res) => {
  try {
    const result = await orderService.recoverOrder({
      orderAccessToken: req.orderAccessToken,
      createIdempotencyKey: req.createIdempotencyKey,
    });
    return res.json(publicCreationResponse(result));
  } catch (err) {
    return sendCreationError(res, err, 'recover-order');
  }
});

router.get('/orders/:code', orderReadLimiter, requireOrderAccess, (req, res) => {
  res.json(orderService.toPublicOrderDTO(req.order));
});

// Владелец (полный access_token) регистрирует read-only share-токен для
// своей же ссылки «Поделиться» — сам shareToken передаётся заголовком
// (X-Share-Token), не в теле, тем же принципом, что и остальные секреты
// в этом файле (см. orderAccessHeaders() на клиенте).
router.post('/orders/:code/share', orderMutationLimiter, requireOrderAccess, async (req, res) => {
  try {
    const shareToken = req.get('x-share-token');
    await orderShareService.createOrReplaceShareToken(req.order.id, shareToken);
    res.status(204).end();
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// Публичный read-only статус по ссылке «Поделиться» — доступен без
// авторизации владельца, только по share-токену (см. requireOrderShareAccess
// выше). НАМЕРЕННО не toPublicOrderDTO (тот собран для владельца, не для
// независимо проверяемого allowlist'а на утечку ПДн) — отдельный строгий
// allowlist toSharedOrderDTO (см. orderService.js), явно перечисляющий
// каждое разрешённое поле.
router.get('/orders/:code/shared', orderReadLimiter, requireOrderShareAccess, (req, res) => {
  res.json(orderService.toSharedOrderDTO(req.order));
});

router.post('/orders/:code/cancel', orderMutationLimiter, requireOrderAccess, async (req, res) => {
  try {
    const updated = await orderService.cancelByCustomer(req.order.id);
    res.json(orderService.toPublicOrderDTO(updated));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

router.post('/orders/:code/retry-payment', orderMutationLimiter, requireOrderAccess, async (req, res) => {
  try {
    const retryKey = req.get('idempotency-key');
    if (!orderService.isValidRetryKey(retryKey)) {
      return res.status(400).json({ error: 'Некорректный ключ повторной оплаты' });
    }
    const payment = await orderService.retryPayment(req.order.id, retryKey);
    res.json({ payment: orderService.toPublicPaymentDTO(payment) });
  } catch (err) {
    if (Number.isInteger(err.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error(`[api-postgresql] retry-payment failed order=${req.order.id}:`, err.message);
    return res.status(500).json({ error: 'Не удалось безопасно создать повторный платёж' });
  }
});

router.post('/orders/:code/rate', orderMutationLimiter, requireOrderAccess, async (req, res) => {
  try {
    const updated = await orderService.rateOrder(req.order.id, Number(req.body.rating));
    res.json(orderService.toPublicOrderDTO(updated));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// Тот же ENV-гейт (PAYMENT_PROVIDER=yookassa), что и в SQLite-оригинале —
// маршрут не регистрируется при mock-провайдере, чтобы не открывать
// неаутентифицированный вход в markPaid/markPaymentFailed.
//
// Production Switch — Stage 8: verifyWebhook() теперь реальна (канонический
// lookup у ЮKassa, см. yookassaProvider.js) и асинхронна — await обязателен
// (раньше был синхронный вызов, всегда truthy Promise, что было бы тихим
// багом, если бы этот путь когда-либо исполнился с реальным провайдером).
// Добавлены: опциональная IP-allowlist проверка (см. комментарий ниже),
// сверка amount/currency с суммой СОХРАНЁННОГО платежа (provider не знает
// нашу БД — эта сверка структурно может произойти только здесь), безопасное
// (без секретов/сырого тела) структурное логирование каждого исхода.
if (process.env.PAYMENT_PROVIDER === 'yookassa') {
  const { isTrustedYookassaIp } = require('../../services/paymentProviders/yookassaProvider');
  // Выключено по умолчанию — корректность req.ip зависит от правильно
  // настроенного доверия к reverse-прокси (TRUST_PROXY), которого ещё нет
  // (Stage 9, реальный VPS/NGINX не развёрнуты). Включать явным флагом
  // ТОЛЬКО после того, как Stage 9 подтвердит корректную проксицепочку —
  // до этого канонический lookup в verifyWebhook() остаётся единственным
  // обязательным механизмом подлинности.
  const enforceIpAllowlist = process.env.YOOKASSA_WEBHOOK_ENFORCE_IP_ALLOWLIST === 'true';

  router.post('/webhooks/payment', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
    const logId = req.id || 'n/a';
    // Отпечаток тела считается ДО любых проверок: он нужен и для отказа, и
    // для дедупликации повторов. Само тело нигде не сохраняется.
    const fingerprint = payloadFingerprint(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
    const reject = (reason, httpStatus, detail, providerObjectId = null, eventType = 'unknown') =>
      webhookRejectionService.record({
        provider: 'yookassa', eventType, reason, payloadFingerprint: fingerprint,
        providerObjectId, httpStatus, detailSafe: detail, requestId: logId,
      });
    try {
      if (enforceIpAllowlist && !isTrustedYookassaIp(req.ip)) {
        console.error(`[api-postgresql] webhook rejected: untrusted source IP id=${logId}`);
        await reject('untrusted_source', 403, 'источник вне списка доверенных адресов');
        return res.status(403).json({ error: 'forbidden' });
      }

      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: 'application/json required' });
      }
      const event = await paymentService.verifyWebhook(req.body.toString('utf8'), req.headers);
      if (!event) {
        console.error(`[api-postgresql] webhook rejected: unverifiable notification id=${logId}`);
        await reject('unverifiable', 400, 'канонический запрос не подтвердил уведомление');
        return res.status(400).json({ error: 'invalid webhook notification' });
      }

      if (event.type === 'refund') {
        const refund = await orderService.getRefundByProviderRefundId(event.providerRefundId);
        if (!refund) {
          console.error(`[api-postgresql] refund webhook rejected: unknown provider_refund_id id=${logId}`);
          await reject('unknown_refund', 404, 'возврат провайдера отсутствует в базе', event.providerRefundId, 'refund');
          return res.status(404).json({ error: 'refund not found' });
        }
        const amountOk = event.amount === Number(refund.amount).toFixed(2);
        const paymentOk = event.providerPaymentId === refund.provider_payment_id;
        if (!amountOk || event.currency !== 'RUB' || !paymentOk) {
          console.error(`[api-postgresql] refund webhook rejected: identity/amount mismatch id=${logId} refund=${refund.id}`);
          const why = !amountOk ? 'amount_mismatch' : (event.currency !== 'RUB' ? 'currency_mismatch' : 'refund_identity_mismatch');
          await reject(why, 400, `возврат #${refund.id}: расхождение уведомления с записью`, event.providerRefundId, 'refund');
          return res.status(400).json({ error: 'refund mismatch' });
        }
        await orderService.finalizeRefundSucceeded(refund.id, event.providerRefundId);
        console.log(`[api-postgresql] refund webhook applied: refund=${refund.id} status=${event.status} id=${logId}`);
        return res.json({ ok: true });
      }

      if (event.type !== 'payment') {
        await reject('unsupported_event', 400, `тип события: ${String(event.type).slice(0, 40)}`);
        return res.status(400).json({ error: 'unsupported webhook event' });
      }

      const payment = await orderService.getPaymentByProviderPaymentId(event.providerPaymentId);
      if (!payment) {
        console.error(`[api-postgresql] webhook rejected: unknown provider_payment_id id=${logId}`);
        await reject('unknown_payment', 404, 'платёж провайдера отсутствует в базе', event.providerPaymentId, 'payment');
        return res.status(404).json({ error: 'payment not found' });
      }

      // Provider уже сверил amount/currency уведомления с каноническим
      // объектом YooKassa. Здесь второй независимый инвариант: каноническая
      // сумма должна совпасть с локальной записью payment.
      const amountOk = event.amount === Number(payment.amount).toFixed(2);
      const currencyOk = event.currency === 'RUB';
      if (!amountOk || !currencyOk) {
        console.error(
          `[api-postgresql] webhook rejected: amount/currency mismatch id=${logId} payment=${payment.id}`
        );
        await reject(amountOk ? 'currency_mismatch' : 'amount_mismatch', 400,
          `платёж #${payment.id}: расхождение суммы или валюты`, event.providerPaymentId, 'payment');
        return res.status(400).json({ error: 'amount or currency mismatch' });
      }

      // Stage 22: подтверждение успеха идёт через applyConfirmedPaymentSuccess,
      // а не напрямую в markPaid. Разница видна только в одном случае — когда
      // провайдер подтверждает успех платежа, который у нас числится failed:
      // раньше это молча игнорировалось, теперь фиксируется как дубль и
      // отправляется в возврат (Stage 21, HIGH-1).
      if (event.status === 'succeeded') {
        const applied = await orderService.applyConfirmedPaymentSuccess(payment.order_id, payment.id, {
          source: 'webhook',
        });
        if (applied.outcome === 'duplicate') {
          await webhookRejectionService.record({
            provider: 'yookassa',
            eventType: 'payment',
            reason: 'succeeded_for_inactive_attempt',
            payloadFingerprint: fingerprint,
            providerObjectId: event.providerPaymentId,
            httpStatus: 200,
            detailSafe: `подтверждён лишний платёж, учитываемый платёж #${applied.canonicalPaymentId}`,
            requestId: logId,
          });
        }
      } else if (event.status === 'failed') {
        await orderService.markPaymentFailed(payment.order_id, payment.id);
      }

      console.log(`[api-postgresql] webhook applied: payment=${payment.id} status=${event.status} id=${logId}`);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[api-postgresql] webhook processing failed id=${logId}:`, err.message);
      await reject('internal_error', 500, err.message);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });
}

// Дословный порт dev-only маршрута — тот же тройной ENV-гейт, что и в
// SQLite-оригинале.
const devPaymentEnabled = process.env.ENABLE_DEV_PAYMENT_ROUTES === 'true'
  && process.env.PAYMENT_PROVIDER === 'mock'
  && ['local', 'staging'].includes(process.env.APP_ENV);
if (devPaymentEnabled) {
  router.post('/orders/:code/dev-confirm-payment', orderMutationLimiter, requireOrderAccess, async (req, res) => {
    try {
      const payment = await orderService.getPendingPaymentForOrder(req.order.id);
      if (!payment || !payment.provider_payment_id) {
        return res.status(404).json({ error: 'payment not found' });
      }
      if (!paymentService.devMarkPaid(payment.provider_payment_id, 'succeeded')) {
        return res.status(409).json({ error: 'payment provider state mismatch' });
      }
      const updated = await orderService.markPaid(req.order.id, payment.id);
      return res.json(orderService.toPublicOrderDTO(updated));
    } catch (err) {
      console.error('[api-postgresql] dev-confirm-payment failed:', err.message);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });
}

module.exports = router;
