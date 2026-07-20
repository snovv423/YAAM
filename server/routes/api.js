const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const orderService = require('../services/orderService');
const orderAccess = require('../services/orderAccessService');
const paymentService = require('../services/paymentService');

const router = express.Router();

// При срабатывании лимита логируем IP/endpoint/время/user-agent — пригодится
// для мониторинга попыток спама (см. запрос на эту фичу). Лимиты щедрые
// специально, чтобы не мешать обычному клиенту и demo/локальной разработке —
// это защита от злоупотребления, а не троттлинг нормального использования.
function rateLimitHandler(message) {
  return (req, res) => {
    console.warn(
      `[rate-limit] ip=${req.ip} endpoint=${req.method} ${req.originalUrl} `
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

// Нормальный polling идёт раз в 4 секунды (~75 запросов за 5 минут). Лимит
// оставляет запас на refresh/pageshow, но режет дешёвый перебор кодов.
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
  return orderAccess.parseBearerAuthorization(req.get('authorization'));
}

function requireBearerForCreate(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const token = bearerToken(req);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Требуется защищённый доступ к заказу' });
  }
  if (!orderAccess.isValidCreateKey(req.get('idempotency-key'))) {
    return res.status(400).json({ error: 'Некорректный ключ создания заказа' });
  }
  req.orderAccessToken = token;
  req.createIdempotencyKey = req.get('idempotency-key');
  return next();
}

// И код, и токен проверяются одной выборкой. Для неверной пары возвращаем тот
// же 404, что и для несуществующего заказа — API не подтверждает перебирающему,
// какие последовательные public_code реально существуют.
function requireOrderAccess(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const token = bearerToken(req);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Требуется защищённый доступ к заказу' });
  }
  const orderId = orderAccess.findAuthorizedOrderId(req.params.code, token);
  if (!orderId) return res.status(404).json({ error: 'заказ не найден' });
  req.orderAccessToken = token;
  req.order = orderService.getOrder(orderId);
  return next();
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
  console.error(`[api] ${operation} failed type=${err?.name || 'Error'}`);
  return res.status(500).json({ error: 'Не удалось безопасно оформить заказ' });
}

// "Хит" — не ручной флаг, а автоматический расчёт по реальным продажам:
// топ-3 блюда ресторана по сумме qty за оплаченные и успешно завершённые
// заказы (отменённые/отклонённые/просроченные/неудавшаяся оплата не считаются),
// с порогом минимум 8 проданных порций. Если блюдо перестаёт проходить условия —
// бейдж на следующий же запрос пропадает сам, отдельного "снятия" не нужно.
const HIT_TOP_N = 3;
const HIT_MIN_QTY = 8;
function hitMenuItemIds(restaurantId) {
  const rows = db.prepare(`
    SELECT oi.menu_item_id AS id, SUM(oi.qty) AS sold
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.restaurant_id = ?
      AND oi.menu_item_id IS NOT NULL
      AND o.status NOT IN ('cancelled','declined','timed_out','payment_failed','awaiting_payment')
      AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
    GROUP BY oi.menu_item_id
    HAVING sold >= ?
    ORDER BY sold DESC
    LIMIT ?
  `).all(restaurantId, HIT_MIN_QTY, HIT_TOP_N);
  return new Set(rows.map((r) => r.id));
}

function restaurantWithMenu(restaurant) {
  const categories = db.prepare('SELECT * FROM categories WHERE restaurant_id = ? ORDER BY sort_order').all(restaurant.id);
  const items = db.prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY sort_order').all(restaurant.id);
  const hits = hitMenuItemIds(restaurant.id);
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

// orders_count — источник истины для "уже заказали N раз" на карточке ресторана
// (см. .ordcnt в client/js/app.js). Считаются только заказы с реально успешной
// оплатой (payments.status='succeeded') и статусом не из терминального "плохого"
// списка — т.е. paid/awaiting_restaurant/accepted/preparing/courier/delivered.
// Корзина и awaiting_payment сюда никогда не попадают: это агрегат по таблице
// orders, а не что-то, что клиент может увеличить сам.
const ORDERS_COUNT_JOIN = `
  LEFT JOIN orders o ON o.restaurant_id = r.id
    AND o.status NOT IN ('cancelled','declined','timed_out','payment_failed','awaiting_payment')
    AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
`;

router.get('/restaurants', (req, res) => {
  const city = req.query.city;
  const all = db.prepare(`
    SELECT r.*, COUNT(o.id) AS orders_count
    FROM restaurants r
    ${ORDERS_COUNT_JOIN}
    GROUP BY r.id
  `).all()
    .map((r) => ({ ...r, cities: JSON.parse(r.cities || '[]') }))
    .filter((r) => !city || r.cities.includes(city));
  res.json(all);
});

router.get('/restaurants/:id', (req, res) => {
  const r = db.prepare(`
    SELECT r.*, COUNT(o.id) AS orders_count
    FROM restaurants r
    ${ORDERS_COUNT_JOIN}
    WHERE r.id = ? GROUP BY r.id
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'ресторан не найден' });
  res.json(restaurantWithMenu(r));
});

router.post('/orders', orderCreateLimiter, requireBearerForCreate, async (req, res) => {
  try {
    // Секреты принимаются только из заголовков. Одноимённые поля JSON-body
    // игнорируются, чтобы API-контракт не приучал клиентов класть capability в
    // тела, которые инфраструктура часто логирует целиком.
    const result = await orderService.createOrder({
      ...req.body,
      orderAccessToken: req.orderAccessToken,
      createIdempotencyKey: req.createIdempotencyKey,
    });
    return res.status(201).json(publicCreationResponse(result));
  } catch (err) {
    return sendCreationError(res, err, 'create-order');
  }
});

// Body-less recovery не хранит ПДн заказа в localStorage. Два исходных
// capability однозначно находят уже зафиксированный снимок заказа; тело
// не нужно и не может изменить первичный request hash.
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

// Клиентский эндпоинт требует bearer capability и отдаёт только
// toPublicOrderDTO(), НЕ полный объект заказа. public_code последовательный и
// перебираемый, поэтому одного кода недостаточно, а customer_name/phone/address
// и прочие внутренние поля в ответе недопустимы. Бот/админка используют
// orderService.getOrder() напрямую в процессе, этот эндпоинт их не затрагивает.
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
    if (!orderAccess.isValidRetryKey(retryKey)) {
      return res.status(400).json({ error: 'Некорректный ключ повторной оплаты' });
    }
    const payment = await orderService.retryPayment(req.order.id, retryKey);
    res.json({ payment: orderService.toPublicPaymentDTO(payment) });
  } catch (err) {
    if (Number.isInteger(err.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error(`[api] retry-payment failed order=${req.order.id}:`, err.message);
    return res.status(500).json({ error: 'Не удалось безопасно создать повторный платёж' });
  }
});

router.post('/orders/:code/rate', orderMutationLimiter, requireOrderAccess, (req, res) => {
  try {
    const updated = orderService.rateOrder(req.order.id, Number(req.body.rating));
    res.json(orderService.toPublicOrderDTO(updated));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message });
  }
});

// Реальный вебхук платёжного провайдера (ЮKassa и т.п.). Подпись проверяется
// внутри paymentService.verifyWebhook — если невалидна, 400 и ничего не меняем.
// Роут существует только при реальном провайдере: mockProvider.verifyWebhook()
// не проверяет подпись (доверяет любому JSON), поэтому при PAYMENT_PROVIDER=mock
// маршрут вообще не регистрируется — иначе внешний запрос мог бы менять статус
// оплаты произвольного заказа без всякой аутентификации.
if (process.env.PAYMENT_PROVIDER === 'yookassa') {
  router.post('/webhooks/payment', express.raw({ type: '*/*' }), async (req, res) => {
    // Production Switch — Stage 8: verifyWebhook() провайдера теперь реальна
    // и асинхронна (канонический lookup у ЮKassa — сетевой вызов, см.
    // server/services/paymentProviders/yookassaProvider.js) — await
    // обязателен. Это единственная правка в этом файле для Stage 8:
    // paymentService.js — общий (не PostgreSQL-специфичный) модуль, без
    // этого await здесь остался бы тихий баг (Promise трактовался бы как
    // truthy событие), если PAYMENT_PROVIDER=yookassa когда-либо будет
    // включён на SQLite-стороне. Остальная логика этого маршрута не менялась.
    const event = await paymentService.verifyWebhook(req.body.toString('utf8'), req.headers);
    if (!event) return res.status(400).json({ error: 'invalid webhook signature' });

    const payment = db.prepare('SELECT * FROM payments WHERE provider_payment_id = ?').get(event.providerPaymentId);
    if (!payment) return res.status(404).json({ error: 'payment not found' });

    if (event.status === 'succeeded') await orderService.markPaid(payment.order_id, payment.id);
    else if (event.status === 'failed') orderService.markPaymentFailed(payment.order_id, payment.id);

    res.json({ ok: true });
  });
}

// --- DEV-ONLY: имитация оплаты в закрытом mock-staging ---
// По умолчанию маршрута нет. В production его нельзя включить даже ошибочной
// переменной окружения. Provider payment id больше не торчит в публичном URL:
// сервер сам выбирает pending-попытку только после проверки владельца заказа.
const devPaymentEnabled = process.env.ENABLE_DEV_PAYMENT_ROUTES === 'true'
  && process.env.PAYMENT_PROVIDER === 'mock'
  && ['local', 'staging'].includes(process.env.APP_ENV);
if (devPaymentEnabled) {
  router.post('/orders/:code/dev-confirm-payment', orderMutationLimiter, requireOrderAccess, async (req, res) => {
    const payment = db.prepare(
      "SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    ).get(req.order.id);
    if (!payment || !payment.provider_payment_id) {
      return res.status(404).json({ error: 'payment not found' });
    }
    if (!paymentService.devMarkPaid(payment.provider_payment_id, 'succeeded')) {
      return res.status(409).json({ error: 'payment provider state mismatch' });
    }
    const updated = await orderService.markPaid(req.order.id, payment.id);
    return res.json(orderService.toPublicOrderDTO(updated));
  });
}

module.exports = router;
