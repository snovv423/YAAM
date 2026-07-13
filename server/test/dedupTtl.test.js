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

// Прямая правка created_at имитирует "прошло N секунд" без реального ожидания.
function ageOrder(orderId, secondsAgo) {
  db.prepare(`UPDATE orders SET created_at = datetime('now', '-' || ? || ' seconds') WHERE id = ?`)
    .run(secondsAgo, orderId);
}

test('свежий awaiting_payment (моложе 15 минут) продолжает дедуплицироваться', async () => {
  const phone = '+79285550001';
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone });
  const first = await orderService.createOrder(payload);
  const second = await orderService.createOrder(payload);
  assert.equal(second.order.id, first.order.id, 'второй вызов должен вернуть тот же заказ');
});

test('возраст ровно 15 минут (AWAITING_PAYMENT_DEDUP_TTL_SEC) — граница включительно, ещё дедуплицируется', async () => {
  const phone = '+79285550002';
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone });
  const first = await orderService.createOrder(payload);
  ageOrder(first.order.id, orderService.AWAITING_PAYMENT_DEDUP_TTL_SEC);
  const second = await orderService.createOrder(payload);
  assert.equal(second.order.id, first.order.id, 'возраст === TTL (15 минут) должен всё ещё считаться свежим (граница включительно)');
});

test('возраст 15 минут + 1 секунда — старый awaiting_payment не блокирует новый заказ', async () => {
  const phone = '+79285550003';
  const first = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  ageOrder(first.order.id, orderService.AWAITING_PAYMENT_DEDUP_TTL_SEC + 1);
  const second = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  assert.notEqual(second.order.id, first.order.id, 'после TTL (15 минут) должен создаться новый заказ');
  // Старый заказ не удаляется и не меняет статус этой задачей.
  const stale = orderService.getOrder(first.order.id);
  assert.equal(stale.status, 'awaiting_payment', 'старый заказ остаётся как есть, без автоматической смены статуса');
});

test('после 15-минутного TTL создаётся новый order и новое резервирование платежа', async () => {
  const phone = '+79285550004';
  const first = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  ageOrder(first.order.id, orderService.AWAITING_PAYMENT_DEDUP_TTL_SEC + 100);
  const second = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  assert.notEqual(second.payment.providerPaymentId, first.payment.providerPaymentId, 'новый заказ должен иметь собственный платёж');
});

test('повторный быстрый createOrder по-прежнему не создаёт дубль (не сломано TTL-условием)', async () => {
  const phone = '+79285550005';
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone });
  const [a, b] = await Promise.all([
    orderService.createOrder(payload),
    orderService.createOrder(payload),
  ]);
  assert.equal(a.order.id, b.order.id, 'параллельный повтор должен схлопнуться в один заказ');
});

test('тот же телефон+ресторан с другими credentials не получает существующий заказ', async () => {
  const phone = '+79285550009';
  await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  await assert.rejects(
    orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone })),
    /незавершённый заказ/,
  );
});

test('разные рестораны для одного телефона не схлопываются', async () => {
  const { restaurantId: otherRestaurantId, menuItemId: otherMenuItemId } = seedMinimalRestaurant(db, { name: 'Другой ресторан' });
  const phone = '+79285550006';
  const a = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  const b = await orderService.createOrder(basicOrderPayload(otherRestaurantId, otherMenuItemId, { customerPhone: phone }));
  assert.notEqual(a.order.id, b.order.id);
});

test('одни credentials нельзя повторно использовать для другого ресторана', async () => {
  const { restaurantId: otherRestaurantId, menuItemId: otherMenuItemId } = seedMinimalRestaurant(db, { name: 'Третий ресторан' });
  const original = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79285550010' });
  await orderService.createOrder(original);
  await assert.rejects(
    orderService.createOrder(basicOrderPayload(otherRestaurantId, otherMenuItemId, {
      customerPhone: '+79285550010',
      orderAccessToken: original.orderAccessToken,
      createIdempotencyKey: original.createIdempotencyKey,
    })),
    /незавершённый заказ/,
  );
});

test('разные телефоны для одного ресторана не схлопываются', async () => {
  const a = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79285550007' }));
  const b = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79285550008' }));
  assert.notEqual(a.order.id, b.order.id);
});
