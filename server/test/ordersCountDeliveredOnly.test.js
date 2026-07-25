// YAAM HQ Stage 1: публичный счётчик заказов (orders_count) на карточке
// ресторана должен считать только реально завершённые заказы —
// status='delivered' с оплатой, ещё succeeded на момент запроса. Заказ,
// который просто оплачен, принят рестораном или готовится, не должен
// увеличивать публичный счётчик — раньше (см. git-историю ORDERS_COUNT_JOIN
// в routes/api.js) это было не так: считался любой статус, кроме явно
// "плохого" списка. Тест доказывает исправленное поведение реальным HTTP-
// запросом к неизменённому production-роуту, а не вызовом SQL напрямую.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');

let server;
let baseUrl;
let restaurantId;
let menuItemId;

before(async () => {
  const express = require('express');
  const apiRoutes = require('../routes/api');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDbFile(dbPath);
});

async function fetchOrdersCount() {
  const res = await fetch(`${baseUrl}/api/restaurants/${restaurantId}`);
  const body = await res.json();
  return body.orders_count;
}

async function createOrderUpTo(status, phoneSuffix) {
  const { order, payment } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: `+7928777${phoneSuffix}` }),
  );
  const paymentRow = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'pending'").get(order.id);
  await orderService.markPaid(order.id, paymentRow.id);
  if (status === 'awaiting_restaurant') return order;
  orderService.restaurantAccept(order.id);
  if (status === 'accepted') return order;
  orderService.restaurantAdvance(order.id, 'preparing');
  if (status === 'preparing') return order;
  orderService.restaurantAdvance(order.id, 'courier');
  if (status === 'courier') return order;
  orderService.restaurantAdvance(order.id, 'delivered');
  return order;
}

test('оплаченный, но ещё не принятый рестораном заказ не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('awaiting_restaurant', '0001');
  assert.equal(await fetchOrdersCount(), before1);
});

test('принятый рестораном заказ (accepted) не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('accepted', '0002');
  assert.equal(await fetchOrdersCount(), before1);
});

test('заказ в статусе preparing не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('preparing', '0003');
  assert.equal(await fetchOrdersCount(), before1);
});

test('заказ в статусе courier не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('courier', '0004');
  assert.equal(await fetchOrdersCount(), before1);
});

test('заказ, дошедший до delivered, увеличивает публичный счётчик ровно на 1', async () => {
  const before1 = await fetchOrdersCount();
  await createOrderUpTo('delivered', '0005');
  assert.equal(await fetchOrdersCount(), before1 + 1);
});

test('отменённый заказ никогда не увеличивает публичный счётчик', async () => {
  const before1 = await fetchOrdersCount();
  const { order } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79287770006' }),
  );
  orderService.cancelByCustomer(order.id);
  assert.equal(await fetchOrdersCount(), before1);
});
