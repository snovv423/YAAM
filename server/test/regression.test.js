const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');

let restaurantId;
let menuItemId;

before(() => {
  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
});

after(() => {
  cleanupDbFile(dbPath);
});

test('незаконные ADVANCE_MAP-переходы по-прежнему отклоняются (не задето правками этой задачи)', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79287770001' }));
  // awaiting_payment -> preparing, минуя оплату и принятие рестораном
  assert.throws(() => orderService.restaurantAdvance(order.id, 'preparing'), /нельзя перейти/);
});

test('markPaid остаётся идемпотентным при повторном вызове', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79287770002' }));
  const first = await orderService.markPaid(order.id);
  const second = await orderService.markPaid(order.id);
  assert.equal(first.status, 'awaiting_restaurant');
  assert.equal(second.status, 'awaiting_restaurant');
});

test('обычный путь заказа delivery целиком проходит без ошибок (regression sanity)', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79287770003' }));
  await orderService.markPaid(order.id);
  orderService.restaurantAccept(order.id);
  orderService.restaurantAdvance(order.id, 'preparing');
  orderService.restaurantAdvance(order.id, 'courier');
  const delivered = orderService.restaurantAdvance(order.id, 'delivered');
  assert.equal(delivered.status, 'delivered');
});
