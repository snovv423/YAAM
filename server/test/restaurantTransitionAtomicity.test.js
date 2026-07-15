// FINAL ORDER STATE MACHINE HARDENING — Finding 1: restaurantAccept()/
// restaurantAdvance() раньше были read-then-write БЕЗ транзакции и БЕЗ
// conditional UPDATE — единственные две функции orderService.js, писавшие
// orders.status таким образом (см. server/docs/refund-architecture-review.md
// и предыдущий независимый аудит State Machine). Безопасность держалась
// только на том, что между чтением и записью нет await — независимый аудит
// это подтвердил эмпирически, но также показал, что unconditional UPDATE мог
// бы "воскресить" уже cancelled/declined/timed_out+refunded заказ, если бы
// когда-либо появился await между чтением и записью. Этот файл закрепляет
// обе гарантии: (1) обычные легитимные переходы по-прежнему работают,
// (2) сама атомарность/guard теперь реальны на уровне SQL, а не только
// "случайно безопасны" из-за отсутствия await.
//
// Честное ограничение покрытия (отмечено независимым ревьюером): тесты ниже
// с пометкой "гонка"/"race" — это ПОСЛЕДОВАТЕЛЬНЫЕ regression-тесты (сначала
// один вызов до конца, потом другой), а не воспроизведение настоящего
// interleaving. При однопоточной синхронной архитектуре node:sqlite (см.
// db/index.js) реальное чередование двух вызовов ВНУТРИ одного процесса
// физически невозможно без await между чтением и записью — именно это и
// делает исправление безопасным, а не тестовый трюк. Эти тесты доказывают,
// что SQL-guard (WHERE status=?) корректно защищает бизнес-логику при
// последовательных вызовах в правильном порядке; они НЕ являются
// доказательством атомарности как таковой — атомарность здесь доказывается
// чтением кода (чтение и запись в одной db.immediateTransaction без await
// между ними), а не прогоном теста.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload,
} = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');
const { restaurantId, menuItemId } = seedMinimalRestaurant(db);

after(() => cleanupDbFile(dbPath));

let phoneSeq = 6000;
function freshPayload(overrides = {}) {
  phoneSeq += 1;
  return basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: `+7928600${String(phoneSeq).padStart(4, '0')}`,
    ...overrides,
  });
}

async function createPaidOrder(overrides = {}) {
  const created = await orderService.createOrder(freshPayload(overrides));
  const payment = db.prepare(
    "SELECT * FROM payments WHERE order_id = ? AND status = 'pending'",
  ).get(created.order.id);
  const paid = await orderService.markPaid(created.order.id, payment.id);
  return { orderId: created.order.id, paymentId: payment.id, order: paid };
}

test('restaurantAccept() переводит заказ в accepted только из awaiting_restaurant', async () => {
  const { orderId } = await createPaidOrder();
  const accepted = orderService.restaurantAccept(orderId);
  assert.equal(accepted.status, 'accepted');
});

test('restaurantAccept() после cancelled не меняет заказ (не "воскрешает" его)', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  paymentService.refundPayment = async () => ({ refundId: 'r-accept-cancel', status: 'succeeded' });
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));

  const untouched = orderService.restaurantAccept(orderId);
  assert.equal(untouched.status, 'cancelled', 'restaurantAccept не должен перезаписывать уже отменённый заказ');
  assert.equal(orderService.getOrder(orderId).status, 'cancelled');
  assert.equal(
    orderService.toPublicOrderDTO(orderService.getOrder(orderId)).refund_status,
    'done',
    'возврат остаётся done — restaurantAccept не должен был его тронуть',
  );
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'refunded');
});

test('restaurantAccept() после declined/timed_out/delivered — тихий no-op, не ошибка и не запись', async () => {
  for (const setup of [
    async () => {
      const { orderId } = await createPaidOrder();
      paymentService.refundPayment = async () => ({ refundId: 'r-declined', status: 'succeeded' });
      await orderService.restaurantDecline(orderId);
      await new Promise((resolve) => setImmediate(resolve));
      return orderId;
    },
    async () => {
      const { orderId } = await createPaidOrder();
      db.prepare("UPDATE orders SET status_updated_at = datetime('now', '-4 minutes') WHERE id = ?").run(orderId);
      paymentService.refundPayment = async () => ({ refundId: 'r-timeout', status: 'succeeded' });
      await orderService.sweepTimeouts();
      await new Promise((resolve) => setImmediate(resolve));
      return orderId;
    },
    async () => {
      const { orderId } = await createPaidOrder();
      orderService.restaurantAccept(orderId);
      orderService.restaurantAdvance(orderId, 'preparing');
      orderService.restaurantAdvance(orderId, 'courier');
      orderService.restaurantAdvance(orderId, 'delivered');
      return orderId;
    },
  ]) {
    const orderId = await setup();
    const before = orderService.getOrder(orderId).status;
    const result = orderService.restaurantAccept(orderId);
    assert.equal(result.status, before, `restaurantAccept не должен менять терминальный статус ${before}`);
    assert.equal(orderService.getOrder(orderId).status, before);
  }
});

test('два подряд restaurantAccept() дают ровно один реальный переход, второй — no-op с актуальным статусом', async () => {
  const { orderId } = await createPaidOrder();
  const first = orderService.restaurantAccept(orderId);
  const second = orderService.restaurantAccept(orderId);
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted', 'второй вызов не должен падать и не должен пытаться перезаписать');
  assert.equal(orderService.getOrder(orderId).status, 'accepted');
});

test('cancelByCustomer, выигравший гонку до restaurantAccept, не бывает переписан задним числом', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  paymentService.refundPayment = async () => ({ refundId: 'r-race', status: 'succeeded' });
  // cancelByCustomer уже атомарно закоммитил cancelled+refund до того, как
  // "бот" вообще успевает вызвать restaurantAccept — воспроизводит порядок
  // событий из независимого аудита (Finding 1), где resurrection был
  // структурно возможен при устаревшем чтении.
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));

  const afterAccept = orderService.restaurantAccept(orderId);
  assert.equal(afterAccept.status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'refunded');
});

test('restaurantAdvance() допускает только строго следующий шаг ADVANCE_MAP', async () => {
  const { orderId } = await createPaidOrder();
  orderService.restaurantAccept(orderId);
  const preparing = orderService.restaurantAdvance(orderId, 'preparing');
  assert.equal(preparing.status, 'preparing');
});

test('restaurantAdvance() запрещает перепрыгнуть accepted -> courier и accepted -> delivered', async () => {
  const { orderId } = await createPaidOrder();
  orderService.restaurantAccept(orderId);
  assert.throws(() => orderService.restaurantAdvance(orderId, 'courier'), /нельзя перейти/);
  assert.throws(() => orderService.restaurantAdvance(orderId, 'delivered'), /нельзя перейти/);
  assert.equal(orderService.getOrder(orderId).status, 'accepted', 'неудачная попытка не должна была ничего изменить');
});

test('restaurantAdvance() запрещает откат preparing -> accepted', async () => {
  const { orderId } = await createPaidOrder();
  orderService.restaurantAccept(orderId);
  orderService.restaurantAdvance(orderId, 'preparing');
  assert.throws(() => orderService.restaurantAdvance(orderId, 'accepted'), /нельзя перейти/);
  assert.equal(orderService.getOrder(orderId).status, 'preparing');
});

test('restaurantAdvance() не продвигает терминальный (delivered) заказ дальше', async () => {
  const { orderId } = await createPaidOrder();
  orderService.restaurantAccept(orderId);
  orderService.restaurantAdvance(orderId, 'preparing');
  orderService.restaurantAdvance(orderId, 'courier');
  orderService.restaurantAdvance(orderId, 'delivered');
  assert.throws(() => orderService.restaurantAdvance(orderId, 'delivered'), /нельзя перейти/);
});

test('pickup-заказ пропускает courier: preparing -> delivered напрямую, но delivery-заказ так не может', async () => {
  const { orderId: pickupId } = await createPaidOrder({ fulfillmentType: 'pickup' });
  orderService.restaurantAccept(pickupId);
  orderService.restaurantAdvance(pickupId, 'preparing');
  const delivered = orderService.restaurantAdvance(pickupId, 'delivered');
  assert.equal(delivered.status, 'delivered');

  const { orderId: deliveryId } = await createPaidOrder();
  orderService.restaurantAccept(deliveryId);
  orderService.restaurantAdvance(deliveryId, 'preparing');
  assert.throws(() => orderService.restaurantAdvance(deliveryId, 'delivered'), /нельзя перейти/);
});

test('restaurantAdvance() атомарно пишет estimated_ready_minutes и status в одной транзакции', async () => {
  const { orderId } = await createPaidOrder();
  orderService.restaurantAccept(orderId);
  const updated = orderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: 27 });
  assert.equal(updated.status, 'preparing');
  assert.equal(updated.estimated_ready_minutes, 27);
});

test('order/payment/refund остаются согласованными после гонки cancel vs accept: ровно один provider-вызов', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  let calls = 0;
  paymentService.refundPayment = async () => { calls += 1; return { refundId: 'r-consistency', status: 'succeeded' }; };
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));
  orderService.restaurantAccept(orderId); // не должен спровоцировать повторный возврат/повторную запись

  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM refunds WHERE payment_id = ?').get(paymentId).c, 1);
  const order = orderService.getOrder(orderId);
  assert.equal(order.status, 'cancelled');
  assert.equal(orderService.toPublicOrderDTO(order).refund_status, 'done');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'refunded');
});
