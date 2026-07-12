// Закрепляет уже существующее (не новое) корректное поведение отмены
// неоплаченного заказа: cancelByCustomer() для awaiting_payment переводит
// заказ в cancelled БЕЗ обращения к платёжному провайдеру (деньги ещё не
// списаны — возвращать нечего), а сам отменённый заказ сразу перестаёт
// участвовать в дедупе createOrder() независимо от TTL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');

let restaurantId;
let menuItemId;

before(() => {
  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
});

after(() => {
  cleanupDbFile(dbPath);
});

test('cancelByCustomer() для awaiting_payment: статус -> cancelled, refund provider НЕ вызывается', async (t) => {
  const { order } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79287771001' }),
  );
  const paymentBefore = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  assert.equal(paymentBefore.status, 'pending');

  // Спай на реальном методе провайдера (не приватная refundOrder() — она не
  // экспортируется из orderService, и это осознанно: тест проверяет наблюдаемый
  // эффект на границе с провайдером, а не внутреннюю функцию модуля).
  // t.mock — встроенный в node:test, автоматически восстанавливается после теста.
  const refundSpy = t.mock.method(paymentService, 'refundPayment', () => {
    throw new Error('refundPayment НЕ должен вызываться для awaiting_payment');
  });

  const updated = await orderService.cancelByCustomer(order.id);

  assert.equal(updated.status, 'cancelled');
  assert.equal(refundSpy.mock.callCount(), 0, 'refund provider не должен вызываться для ещё не оплаченного заказа');

  const paymentAfter = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  assert.equal(paymentAfter.status, 'pending', 'payment.status не должен меняться — возврата не было и не должно быть');

  // Несвязанные поля не тронуты отменой.
  assert.equal(updated.public_code, order.public_code);
  assert.equal(updated.items_total, order.items_total);
  assert.equal(updated.customer_phone, order.customer_phone);
});

test('после отмены awaiting_payment новый заказ создаётся сразу — TTL 15 минут не блокирует', async () => {
  const phone = '+79287771002';
  const { order: first } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  const cancelled = await orderService.cancelByCustomer(first.id);
  assert.equal(cancelled.status, 'cancelled');

  // Без искусственного старения created_at — возраст практически 0, глубоко
  // внутри TTL=15 минут. Дедуп всё равно не должен вернуть отменённый заказ.
  const { order: second, payment: secondPayment } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }),
  );

  assert.notEqual(second.id, first.id, 'должен создаться НОВЫЙ заказ, а не возврат к отменённому');
  assert.equal(second.status, 'awaiting_payment');
  assert.ok(secondPayment.providerPaymentId, 'у нового заказа должно быть собственное резервирование платежа');

  const stale = orderService.getOrder(first.id);
  assert.equal(stale.status, 'cancelled', 'старый (отменённый) заказ остаётся cancelled, не меняется повторно');
});
