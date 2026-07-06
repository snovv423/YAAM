const express = require('express');
const db = require('../db');
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');

const router = express.Router();

function restaurantWithMenu(restaurant) {
  const categories = db.prepare('SELECT * FROM categories WHERE restaurant_id = ? ORDER BY sort_order').all(restaurant.id);
  const items = db.prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY sort_order').all(restaurant.id);
  return {
    ...restaurant,
    cities: JSON.parse(restaurant.cities || '[]'),
    menu: categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: items.filter((i) => i.category_id === c.id),
    })),
  };
}

router.get('/restaurants', (req, res) => {
  const city = req.query.city;
  const all = db.prepare('SELECT * FROM restaurants').all()
    .map((r) => ({ ...r, cities: JSON.parse(r.cities || '[]') }))
    .filter((r) => !city || r.cities.includes(city));
  res.json(all);
});

router.get('/restaurants/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'ресторан не найден' });
  res.json(restaurantWithMenu(r));
});

router.post('/orders', async (req, res) => {
  try {
    const { order, payment } = await orderService.createOrder(req.body);
    res.status(201).json({ order, payment });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/orders/:code', (req, res) => {
  const order = orderService.getOrder(req.params.code);
  if (!order) return res.status(404).json({ error: 'заказ не найден' });
  res.json(order);
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

router.post('/orders/:code/rate', (req, res) => {
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
router.post('/webhooks/payment', express.raw({ type: '*/*' }), async (req, res) => {
  const event = paymentService.verifyWebhook(req.body.toString('utf8'), req.headers);
  if (!event) return res.status(400).json({ error: 'invalid webhook signature' });

  const payment = db.prepare('SELECT * FROM payments WHERE provider_payment_id = ?').get(event.providerPaymentId);
  if (!payment) return res.status(404).json({ error: 'payment not found' });

  if (event.status === 'succeeded') await orderService.markPaid(payment.order_id);
  else if (event.status === 'failed') orderService.markPaymentFailed(payment.order_id);

  res.json({ ok: true });
});

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
