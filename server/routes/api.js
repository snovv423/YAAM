const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const orderService = require('../services/orderService');
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

const rateOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('Слишком много запросов — попробуйте чуть позже'),
});

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

router.post('/orders', orderCreateLimiter, async (req, res) => {
  try {
    const { order, payment } = await orderService.createOrder(req.body);
    res.status(201).json({ order, payment });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Публичный эндпоинт (без авторизации) — отдаёт только toPublicOrderDTO(),
// НЕ полный объект заказа. public_code последовательный и перебираемый, поэтому
// customer_name/phone/address и прочие внутренние поля здесь недопустимы (см.
// orderService.toPublicOrderDTO). Бот/админка используют orderService.getOrder()
// напрямую в процессе, этот эндпоинт их не затрагивает.
router.get('/orders/:code', (req, res) => {
  const order = orderService.getOrder(req.params.code);
  if (!order) return res.status(404).json({ error: 'заказ не найден' });
  res.json(orderService.toPublicOrderDTO(order));
});

router.post('/orders/:code/cancel', async (req, res) => {
  try {
    const order = orderService.getOrder(req.params.code);
    if (!order) return res.status(404).json({ error: 'заказ не найден' });
    const updated = await orderService.cancelByCustomer(order.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:code/retry-payment', async (req, res) => {
  try {
    const order = orderService.getOrder(req.params.code);
    if (!order) return res.status(404).json({ error: 'заказ не найден' });
    const payment = await orderService.retryPayment(order.id);
    res.json({ payment });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:code/rate', rateOrderLimiter, (req, res) => {
  try {
    const order = orderService.getOrder(req.params.code);
    if (!order) return res.status(404).json({ error: 'заказ не найден' });
    const updated = orderService.rateOrder(order.id, Number(req.body.rating));
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    const event = paymentService.verifyWebhook(req.body.toString('utf8'), req.headers);
    if (!event) return res.status(400).json({ error: 'invalid webhook signature' });

    const payment = db.prepare('SELECT * FROM payments WHERE provider_payment_id = ?').get(event.providerPaymentId);
    if (!payment) return res.status(404).json({ error: 'payment not found' });

    if (event.status === 'succeeded') await orderService.markPaid(payment.order_id);
    else if (event.status === 'failed') orderService.markPaymentFailed(payment.order_id);

    res.json({ ok: true });
  });
}

// --- DEV-ONLY: имитация оплаты без реального провайдера (замена "Демо: оплата прошла") ---
if (process.env.PAYMENT_PROVIDER !== 'yookassa') {
  router.post('/dev/pay/:providerPaymentId', async (req, res) => {
    const payment = db.prepare('SELECT * FROM payments WHERE provider_payment_id = ?').get(req.params.providerPaymentId);
    if (!payment) return res.status(404).json({ error: 'payment not found' });
    paymentService.devMarkPaid(req.params.providerPaymentId, 'succeeded');
    const order = await orderService.markPaid(payment.order_id);
    res.json(order);
  });
  router.post('/dev/pay-fail/:providerPaymentId', (req, res) => {
    const payment = db.prepare('SELECT * FROM payments WHERE provider_payment_id = ?').get(req.params.providerPaymentId);
    if (!payment) return res.status(404).json({ error: 'payment not found' });
    paymentService.devMarkPaid(req.params.providerPaymentId, 'failed');
    const order = orderService.markPaymentFailed(payment.order_id);
    res.json(order);
  });
}

module.exports = router;
