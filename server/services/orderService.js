const { EventEmitter } = require('node:events');
const db = require('../db');
const payments = require('./paymentService');

// Другие модули (бот, будущий SSE для клиента) подписываются на события заказа
// через orderEvents — orderService ничего не знает про бота напрямую, это и
// есть развязка, которая позволяет менять/добавлять получателей уведомлений
// без правок в самом сервисе заказов.
const orderEvents = new EventEmitter();

const RESTAURANT_RESPONSE_WINDOW_SEC = 180;
const RATING_ELIGIBLE_STATUS = 'delivered';

function genPublicCode() {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return `YAAM-${n}`;
}

function getOrder(idOrCode) {
  const row = Number.isInteger(idOrCode)
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(idOrCode)
    : db.prepare('SELECT * FROM orders WHERE public_code = ?').get(idOrCode);
  if (!row) return null;
  const items = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?').all(row.id);
  return { ...row, items };
}

async function createOrder({ restaurantId, city, customerName, customerPhone, address, comment, items }) {
  if (!customerName || !customerName.trim()) throw new Error('customerName обязателен');
  if (!items || !items.length) throw new Error('корзина пуста');

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId);
  if (!restaurant) throw new Error('ресторан не найден');

  const itemsTotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (itemsTotal < restaurant.min_order) {
    throw new Error(`сумма заказа ${itemsTotal} меньше минимальной ${restaurant.min_order}`);
  }
  const commission = payments.calcCommission(itemsTotal);

  const insertOrder = db.prepare(`
    INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment, items_total, commission_amount, status)
    VALUES (:public_code, :restaurant_id, :city, :customer_name, :customer_phone, :address, :comment, :items_total, :commission_amount, 'awaiting_payment')
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)
  `);

  const orderId = db.transaction(() => {
    const info = insertOrder.run({
      public_code: genPublicCode(),
      restaurant_id: restaurantId,
      city,
      customer_name: customerName.trim(),
      customer_phone: customerPhone || '',
      address: address || '',
      comment: comment || '',
      items_total: itemsTotal,
      commission_amount: commission,
    });
    for (const it of items) {
      insertItem.run(info.lastInsertRowid, it.menuItemId || null, it.name, it.price, it.qty);
    }
    return info.lastInsertRowid;
  })();

  const order = getOrder(orderId);
  const payment = await payments.createPayment({
    orderId,
    amount: itemsTotal,
    description: `Заказ ${order.public_code}`,
  });
  db.prepare(`
    INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(orderId, payments.providerName, payment.providerPaymentId, itemsTotal);

  return { order, payment };
}

function setStatus(orderId, status) {
  db.prepare('UPDATE orders SET status = ?, status_updated_at = datetime(\'now\') WHERE id = ?').run(status, orderId);
  const order = getOrder(orderId);
  orderEvents.emit('order:status', order);
  return order;
}

// Вызывается вебхуком/dev-роутом оплаты, когда провайдер подтвердил платёж.
function markPaid(orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'awaiting_payment') return order;
  db.prepare("UPDATE payments SET status='succeeded', updated_at=datetime('now') WHERE order_id = ? AND status='pending'").run(orderId);
  const updated = setStatus(orderId, 'awaiting_restaurant');
  orderEvents.emit('order:new', updated); // сюда подписан бот — уйдёт уведомление ресторану
  return updated;
}

function markPaymentFailed(orderId) {
  db.prepare("UPDATE payments SET status='failed', updated_at=datetime('now') WHERE order_id = ? AND status='pending'").run(orderId);
  return setStatus(orderId, 'payment_failed');
}

// Повторная попытка оплаты после payment_failed — новая запись в payments,
// заказ остаётся тем же (не плодим новые public_code на один и тот же выбор блюд).
async function retryPayment(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (order.status !== 'payment_failed') throw new Error('повторная оплата возможна только после ошибки оплаты');

  const payment = await payments.createPayment({
    orderId,
    amount: order.items_total,
    description: `Заказ ${order.public_code} (повторная попытка)`,
  });
  db.prepare(`
    INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(orderId, payments.providerName, payment.providerPaymentId, order.items_total);
  setStatus(orderId, 'awaiting_payment');
  return payment;
}

async function refundOrder(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  const payment = db.prepare(
    "SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1"
  ).get(orderId);
  if (payment) {
    await payments.refundPayment(payment.provider_payment_id, payment.amount);
    db.prepare("UPDATE payments SET status='refunded', updated_at=datetime('now') WHERE id = ?").run(payment.id);
  }
  return order;
}

// Отмена клиентом — только пока ресторан ещё не принял заказ (см. архив, часть 16.4).
async function cancelByCustomer(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (!['awaiting_payment', 'awaiting_restaurant'].includes(order.status)) {
    throw new Error('заказ уже готовится — отменить нельзя, свяжитесь с рестораном');
  }
  if (order.status === 'awaiting_restaurant') await refundOrder(orderId);
  return setStatus(orderId, 'cancelled');
}

// --- Действия ресторана (вызывается ботом) ---

function restaurantAccept(orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'awaiting_restaurant') return order;
  return setStatus(orderId, 'accepted');
}

async function restaurantDecline(orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'awaiting_restaurant') return order;
  await refundOrder(orderId);
  return setStatus(orderId, 'declined');
}

function restaurantAdvance(orderId, nextStatus) {
  const allowed = { accepted: 'preparing', preparing: 'courier', courier: 'delivered' };
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (allowed[order.status] !== nextStatus) {
    throw new Error(`нельзя перейти из ${order.status} в ${nextStatus}`);
  }
  return setStatus(orderId, nextStatus);
}

function rateOrder(orderId, rating) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (order.status !== RATING_ELIGIBLE_STATUS) throw new Error('оценить можно только доставленный заказ');
  if (order.rating != null) throw new Error('вы уже оценили этот заказ');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('оценка должна быть 1..5');

  db.transaction(() => {
    db.prepare('UPDATE orders SET rating = ? WHERE id = ?').run(rating, orderId);
    const r = db.prepare('SELECT rating, rating_count FROM restaurants WHERE id = ?').get(order.restaurant_id);
    const newCount = r.rating_count + 1;
    const newRating = (r.rating * r.rating_count + rating) / newCount;
    db.prepare('UPDATE restaurants SET rating = ?, rating_count = ? WHERE id = ?')
      .run(Math.round(newRating * 10) / 10, newCount, order.restaurant_id);
  })();
  return getOrder(orderId);
}

// Периодический свип вместо setTimeout на процесс — переживает рестарт сервера.
// Если ресторан не ответил за RESTAURANT_RESPONSE_WINDOW_SEC, заказ отменяется и
// деньги возвращаются автоматически (см. архив, часть 16.4).
function sweepTimeouts() {
  const stale = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'awaiting_restaurant'
      AND strftime('%s','now') - strftime('%s', status_updated_at) > ?
  `).all(RESTAURANT_RESPONSE_WINDOW_SEC);

  for (const { id } of stale) {
    refundOrder(id)
      .then(() => setStatus(id, 'timed_out'))
      .catch((err) => console.error(`[orderService] timeout-refund failed for order ${id}:`, err.message));
  }
}

module.exports = {
  orderEvents,
  createOrder,
  getOrder,
  markPaid,
  markPaymentFailed,
  retryPayment,
  refundOrder,
  cancelByCustomer,
  restaurantAccept,
  restaurantDecline,
  restaurantAdvance,
  rateOrder,
  sweepTimeouts,
  RESTAURANT_RESPONSE_WINDOW_SEC,
};
