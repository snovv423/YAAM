// FINAL PAYMENT SECURITY AUDIT (adversarial, pre-commit) — регрессионные тесты
// на находки, подтверждённые независимым read-only аудитом заказов/платежей/
// возвратов перед локальным коммитом ветки codex/refund-state-machine.
//
// Critical: markPaid() читал status ЗАКАЗА раньше платежа и на любом статусе
// кроме awaiting_payment (в первую очередь cancelled) молча возвращал false —
// платёж оставался pending навсегда. Реалистичный сценарий: клиент отменяет
// awaiting_payment-заказ кнопкой «Отменить заказ», пока провайдер уже
// обрабатывает более раннее платёжное намерение; cancelByCustomer() из
// awaiting_payment сознательно НЕ трогает pending-платёж (ожидается, что
// оплаты не будет — см. Decisions → Cancel unpaid order UX в
// docs/PROJECT_BACKLOG.md), поэтому поздний succeeded webhook/dev-confirm для
// ТОГО ЖЕ платежа приходил уже после отмены. Раньше это означало реальную
// потерю денег: провайдер объективно получил оплату, а в БД не оставалось ни
// одной строки, фиксирующей, что их нужно вернуть — ни лога, ни исключения.
// Воспроизведено эмпирически throwaway-скриптом до фикса (payment.status
// оставался 'pending' вечно, refund-строк — 0). См. server/services/
// orderService.js:markPaid() — теперь читает именно pending-платёж первым и
// явно резервирует возврат для cancelled-ветки тем же атомарным принципом,
// что и cancelByCustomer/restaurantDecline/sweepTimeouts.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload,
} = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');
const originalRefundPayment = paymentService.refundPayment;
const { restaurantId, menuItemId } = seedMinimalRestaurant(db);

after(() => {
  paymentService.refundPayment = originalRefundPayment;
  cleanupDbFile(dbPath);
});

let phoneSeq = 7000;
function freshPayload(overrides = {}) {
  phoneSeq += 1;
  return basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: `+7928700${String(phoneSeq).padStart(4, '0')}`,
    ...overrides,
  });
}

test('CRITICAL FIX: поздний succeeded после отмены awaiting_payment-заказа фиксирует оплату и резервирует возврат вместо потери денег', async () => {
  const created = await orderService.createOrder(freshPayload());
  const orderId = created.order.id;
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending'").get(orderId);

  const cancelled = await orderService.cancelByCustomer(orderId);
  assert.equal(cancelled.status, 'cancelled');
  // cancelByCustomer() из awaiting_payment не трогает pending-платёж —
  // sanity-проверка того самого разрыва, который делает гонку возможной.
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'pending');

  let refundCalls = 0;
  paymentService.refundPayment = async () => { refundCalls += 1; return { refundId: 'r-late', status: 'succeeded' }; };

  const afterLatePay = await orderService.markPaid(orderId, payment.id);
  assert.equal(afterLatePay.status, 'cancelled', 'заказ НЕ воскрешается — клиент уже явно от него отказался');

  await new Promise((resolve) => setImmediate(resolve));
  const paymentAfter = db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id);
  assert.equal(paymentAfter.status, 'refunded', 'оплата зафиксирована как succeeded и сразу же успешно возвращена, не потеряна как pending навсегда');
  const refunds = db.prepare('SELECT * FROM refunds WHERE payment_id = ?').all(payment.id);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].reason, 'customer_cancel');
  assert.equal(refunds[0].status, 'succeeded');
  assert.equal(refundCalls, 1);
});

test('CRITICAL FIX: повторный markPaid() тем же поздним платежом после уже обработанной гонки — чистый idempotent no-op, не второй возврат', async () => {
  const created = await orderService.createOrder(freshPayload());
  const orderId = created.order.id;
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending'").get(orderId);
  await orderService.cancelByCustomer(orderId);

  let refundCalls = 0;
  paymentService.refundPayment = async () => { refundCalls += 1; return { refundId: 'r-late2', status: 'succeeded' }; };
  await orderService.markPaid(orderId, payment.id);
  await new Promise((resolve) => setImmediate(resolve));

  // Дублирующий/повторный webhook с тем же providerPaymentId для уже
  // разрешённого платежа — payment.status теперь 'refunded', не 'pending',
  // поэтому markPaid должен вернуться идемпотентным no-op на самом первом
  // SELECT ... WHERE status = 'pending', не создавая вторую строку возврата.
  const second = await orderService.markPaid(orderId, payment.id);
  assert.equal(second.status, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));

  const refunds = db.prepare('SELECT * FROM refunds WHERE payment_id = ?').all(payment.id);
  assert.equal(refunds.length, 1, 'повторный markPaid не должен создать вторую строку возврата');
  assert.equal(refundCalls, 1, 'провайдер не должен быть вызван повторно для уже возвращённого платежа');
});

test('markPaid() на заказе в структурно недостижимом статусе с ещё pending-платежом падает fail-loud, а не молча теряет событие', async () => {
  const created = await orderService.createOrder(freshPayload());
  const orderId = created.order.id;
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending'").get(orderId);

  // Прямая порча статуса в обход бизнес-логики — имитирует состояние, которое
  // ни один легитимный переход сегодня произвести не может (см. комментарий в
  // markPaid()), но которое migrateOrdersStatusCheck()/CHECK-ограничение всё
  // равно допускает как валидное перечислимое значение. Проверяем, что защита
  // fail-loud, а не тихий return false, если такое всё же где-то возникнет.
  db.prepare("UPDATE orders SET status = 'declined' WHERE id = ?").run(orderId);

  // markPaid() синхронна (не async) — throw происходит синхронно, не через
  // отклонённый Promise, поэтому assert.throws(), а не assert.rejects().
  assert.throws(
    () => orderService.markPaid(orderId, payment.id),
    (err) => err.statusCode === 500 && /неожиданном статусе declined/.test(err.internalMessage),
  );
  // Платёж не должен быть тронут при fail-loud отказе.
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM refunds WHERE payment_id = ?').get(payment.id).c, 0);
});

test('обычный (не гоночный) путь markPaid — без изменений в поведении: awaiting_payment -> awaiting_restaurant, без лишнего refund', async () => {
  const created = await orderService.createOrder(freshPayload());
  const orderId = created.order.id;
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending'").get(orderId);
  let refundCalls = 0;
  paymentService.refundPayment = async () => { refundCalls += 1; return { refundId: 'unexpected', status: 'succeeded' }; };

  const paid = await orderService.markPaid(orderId, payment.id);
  assert.equal(paid.status, 'awaiting_restaurant');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'succeeded');
  assert.equal(refundCalls, 0, 'нормальная успешная оплата не должна вызывать возврат');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM refunds WHERE payment_id = ?').get(payment.id).c, 0);
});
