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
const paymentService = require('../../services/paymentService');

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

async function restaurantWithMenu(restaurant) {
  const categories = await db.query(
    'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order',
    [restaurant.id],
  );
  const items = await db.query(
    'SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order',
    [restaurant.id],
  );
  const hits = await hitMenuItemIds(restaurant.id);
  return {
    ...restaurant,
    cities: JSON.parse(restaurant.cities || '[]'),
    menu: categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: items.filter((i) => i.category_id === c.id).map((i) => ({ ...i, is_popular: hits.has(i.id) ? 1 : 0 })),
    })),
  };
}

const ORDERS_COUNT_JOIN = `
  LEFT JOIN orders o ON o.restaurant_id = r.id
    AND o.status NOT IN ('cancelled','declined','timed_out','payment_failed','awaiting_payment')
    AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
`;

router.get('/restaurants', async (req, res) => {
  try {
    const city = req.query.city;
    const rows = await db.query(`
      SELECT r.*, COUNT(o.id)::int AS orders_count
      FROM restaurants r
      ${ORDERS_COUNT_JOIN}
      GROUP BY r.id
    `);
    const all = rows
      .map((r) => ({ ...r, cities: JSON.parse(r.cities || '[]') }))
      .filter((r) => !city || r.cities.includes(city));
    res.json(all);
  } catch (err) {
    console.error('[api-postgresql] GET /restaurants failed:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/restaurants/:id', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT r.*, COUNT(o.id)::int AS orders_count
      FROM restaurants r
      ${ORDERS_COUNT_JOIN}
      WHERE r.id = $1 GROUP BY r.id
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
    try {
      if (enforceIpAllowlist && !isTrustedYookassaIp(req.ip)) {
        console.error(`[api-postgresql] webhook rejected: untrusted source IP id=${logId}`);
        return res.status(403).json({ error: 'forbidden' });
      }

      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: 'application/json required' });
      }
      const event = await paymentService.verifyWebhook(req.body.toString('utf8'), req.headers);
      if (!event) {
        console.error(`[api-postgresql] webhook rejected: unverifiable notification id=${logId}`);
        return res.status(400).json({ error: 'invalid webhook notification' });
      }

      if (event.type === 'refund') {
        const refund = await orderService.getRefundByProviderRefundId(event.providerRefundId);
        if (!refund) {
          console.error(`[api-postgresql] refund webhook rejected: unknown provider_refund_id id=${logId}`);
          return res.status(404).json({ error: 'refund not found' });
        }
        const amountOk = event.amount === Number(refund.amount).toFixed(2);
        const paymentOk = event.providerPaymentId === refund.provider_payment_id;
        if (!amountOk || event.currency !== 'RUB' || !paymentOk) {
          console.error(`[api-postgresql] refund webhook rejected: identity/amount mismatch id=${logId} refund=${refund.id}`);
          return res.status(400).json({ error: 'refund mismatch' });
        }
        await orderService.finalizeRefundSucceeded(refund.id, event.providerRefundId);
        console.log(`[api-postgresql] refund webhook applied: refund=${refund.id} status=${event.status} id=${logId}`);
        return res.json({ ok: true });
      }

      if (event.type !== 'payment') {
        return res.status(400).json({ error: 'unsupported webhook event' });
      }

      const payment = await orderService.getPaymentByProviderPaymentId(event.providerPaymentId);
      if (!payment) {
        console.error(`[api-postgresql] webhook rejected: unknown provider_payment_id id=${logId}`);
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
        return res.status(400).json({ error: 'amount or currency mismatch' });
      }

      if (event.status === 'succeeded') await orderService.markPaid(payment.order_id, payment.id);
      else if (event.status === 'failed') await orderService.markPaymentFailed(payment.order_id, payment.id);

      console.log(`[api-postgresql] webhook applied: payment=${payment.id} status=${event.status} id=${logId}`);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[api-postgresql] webhook processing failed id=${logId}:`, err.message);
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
