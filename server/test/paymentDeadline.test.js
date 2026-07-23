// Stage 11A follow-up: неизменяемый серверный срок оплаты
// (payment_expires_at / paymentExpiresAt). Проверяет ровно 8 пунктов,
// явно перечисленных в задаче:
//   1. ровно 15 минут от момента создания попытки оплаты;
//   2. deadline сохраняется после GET order (orderService.getOrder());
//   3. deadline не сбрасывается после refresh/reopen (recoverOrder());
//   4. повторный create/replay не продлевает срок;
//   5. истёкший срок корректно отображается (не обнуляется, не скрывается);
//   6. успешная оплата до истечения проходит штатно, deadline не мешает;
//   7. payment retry получает СВОЙ новый срок (явно утверждённая новая
//      attempt), но простое повторное чтение уже существующей попытки — нет;
//   8. некорректные часы клиента не могут повлиять на серверное значение.
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

// 1. -------------------------------------------------------------------
test('paymentExpiresAt — ровно PAYMENT_DEADLINE_MINUTES (15) минут от создания платежа', async () => {
  const before1 = new Date();
  const { payment } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000001' }),
  );
  const after1 = new Date();
  assert.ok(payment.paymentExpiresAt, 'создание заказа должно вернуть paymentExpiresAt');

  const deadline = new Date(payment.paymentExpiresAt).getTime();
  const minExpected = before1.getTime() + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000;
  const maxExpected = after1.getTime() + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000;
  assert.ok(
    deadline >= minExpected - 1000 && deadline <= maxExpected + 1000,
    `paymentExpiresAt (${payment.paymentExpiresAt}) должен быть ровно ${orderService.PAYMENT_DEADLINE_MINUTES} минут после created_at, окно [${new Date(minExpected).toISOString()}, ${new Date(maxExpected).toISOString()}]`,
  );
});

// 2. -------------------------------------------------------------------
test('payment_expires_at сохраняется в orderService.getOrder() и в toPublicOrderDTO()', async () => {
  const { order, payment } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000002' }),
  );
  const fetched = orderService.getOrder(order.id);
  assert.ok(fetched.payment_expires_at, 'getOrder() должен вернуть payment_expires_at');
  const dto = orderService.toPublicOrderDTO(fetched);
  assert.equal(dto.payment_expires_at, payment.paymentExpiresAt, 'DTO должен отдавать тот же дедлайн, что вернуло createOrder()');
});

// 3. -------------------------------------------------------------------
test('payment_expires_at не сбрасывается при повторном GET (симуляция refresh/reopen)', async () => {
  const { order } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000003' }),
  );
  const first = orderService.toPublicOrderDTO(orderService.getOrder(order.id)).payment_expires_at;
  const second = orderService.toPublicOrderDTO(orderService.getOrder(order.id)).payment_expires_at;
  const third = orderService.toPublicOrderDTO(orderService.getOrder(order.id)).payment_expires_at;
  assert.equal(second, first);
  assert.equal(third, first);
});

// 4. -------------------------------------------------------------------
test('повторный create (exact replay теми же credentials) не продлевает срок', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000004' });
  const first = await orderService.createOrder(payload);
  const replay = await orderService.createOrder(payload);
  assert.equal(replay.order.id, first.order.id, 'replay должен вернуть тот же заказ');
  assert.equal(replay.payment.paymentExpiresAt, first.payment.paymentExpiresAt, 'replay не должен создавать новый дедлайн');
});

test('recoverOrder() (body-less восстановление) тоже не продлевает срок', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000005' });
  const first = await orderService.createOrder(payload);
  const recovered = await orderService.recoverOrder({
    orderAccessToken: payload.orderAccessToken,
    createIdempotencyKey: payload.createIdempotencyKey,
  });
  assert.equal(recovered.order.id, first.order.id);
  assert.equal(recovered.payment.paymentExpiresAt, first.payment.paymentExpiresAt);
});

// 5. -------------------------------------------------------------------
test('истёкший дедлайн отображается как есть (в прошлом), сервер его не скрывает и не обнуляет', async () => {
  const { order, payment } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000006' }),
  );
  // Симулируем истечение — сдвигаем presentation.expires_at в прошлое напрямую в БД
  // (эквивалент реального прохождения 15 минут, без реального ожидания в тесте).
  db.prepare(`UPDATE payment_presentations SET expires_at = datetime('now', '-1 minutes') WHERE payment_id = (
    SELECT id FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1
  )`).run(order.id);

  const dto = orderService.toPublicOrderDTO(orderService.getOrder(order.id));
  assert.ok(dto.payment_expires_at, 'истёкший дедлайн всё ещё должен присутствовать в DTO (клиент решает, как отрисовать)');
  assert.ok(new Date(dto.payment_expires_at).getTime() < Date.now(), 'дедлайн должен быть в прошлом');
  assert.notEqual(dto.payment_expires_at, payment.paymentExpiresAt, 'значение в БД после сдвига должно реально измениться (проверка самого теста)');
});

// 6. -------------------------------------------------------------------
test('успешная оплата ДО истечения дедлайна проходит штатно (deadline не блокирует markPaid)', async () => {
  const { order, payment: paymentResult } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000007' }),
  );
  assert.ok(new Date(paymentResult.paymentExpiresAt).getTime() > Date.now(), 'дедлайн ещё не истёк на момент оплаты');
  const paymentRow = db.prepare(`SELECT id FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(order.id);
  const paid = orderService.markPaid(order.id, paymentRow.id);
  assert.equal(paid.status, 'awaiting_restaurant', 'оплата должна пройти штатно независимо от наличия дедлайна');
});

// 7. -------------------------------------------------------------------
test('payment retry: явная повторная попытка получает СВОЙ новый дедлайн (независимо посчитанный от собственного payments.created_at)', async () => {
  const { order } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000008' }),
  );
  const firstPaymentRow = db.prepare(`SELECT id FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(order.id);
  orderService.markPaymentFailed(order.id, firstPaymentRow.id);

  const retryKey = `yaam_retry_v1_${require('node:crypto').randomBytes(32).toString('base64url')}`;
  const retried = await orderService.retryPayment(order.id, retryKey);
  assert.ok(retried.paymentExpiresAt, 'retry должен получить свой дедлайн');

  // retry обязан завести НОВУЮ строку payments (не переиспользовать первую) —
  // и её дедлайн обязан быть анонсирован от её СОБСТВЕННОГО created_at, а не
  // унаследован от первой попытки. Сравнение по значению (notEqual) ненадёжно:
  // SQLite datetime('now') имеет разрешение в 1 секунду, и при быстром тесте
  // обе попытки МОГУТ законно получить одинаковый created_at и, соответственно,
  // одинаковый дедлайн — это не баг. Поэтому здесь проверяется независимость
  // самого вычисления, а не просто разница значений.
  const retryPaymentRow = db.prepare(`SELECT id, created_at FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(order.id);
  assert.notEqual(retryPaymentRow.id, firstPaymentRow.id, 'retry должен создать новую строку payments, а не переиспользовать первую');
  const expectedRetryDeadline = new Date(`${retryPaymentRow.created_at.replace(' ', 'T')}Z`);
  expectedRetryDeadline.setMinutes(expectedRetryDeadline.getMinutes() + orderService.PAYMENT_DEADLINE_MINUTES);
  assert.equal(retried.paymentExpiresAt, expectedRetryDeadline.toISOString(), 'дедлайн retry должен считаться от created_at именно retry-платежа');

  // Повторное чтение ЭТОЙ ЖЕ (уже готовой) retry-попытки не должно менять её собственный дедлайн.
  const rereadOrder = orderService.toPublicOrderDTO(orderService.getOrder(order.id));
  assert.equal(rereadOrder.payment_expires_at, retried.paymentExpiresAt, 'повторное GET не должно менять уже выданный retry-дедлайн');
});

test('payment retry: повторный вызов с ТЕМ ЖЕ retryKey — идемпотентен, дедлайн не меняется', async () => {
  const { order } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000009' }),
  );
  const paymentRow = db.prepare(`SELECT id FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(order.id);
  orderService.markPaymentFailed(order.id, paymentRow.id);

  const retryKey = `yaam_retry_v1_${require('node:crypto').randomBytes(32).toString('base64url')}`;
  const firstRetry = await orderService.retryPayment(order.id, retryKey);
  const secondRetry = await orderService.retryPayment(order.id, retryKey);
  assert.equal(secondRetry.paymentExpiresAt, firstRetry.paymentExpiresAt, 'повтор с тем же ключом должен быть идемпотентным, включая дедлайн');
});

// 8. -------------------------------------------------------------------
test('некорректные/произвольные поля от клиента (в т.ч. попытка передать свой expiresAt) не влияют на серверное значение', async () => {
  const payload = basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79290000010' });
  // createOrder() деструктурирует только известные поля из входного объекта —
  // любые посторонние клиентские поля (в т.ч. попытка подсунуть свой
  // "paymentExpiresAt"/"now"/испорченные часы клиента) структурно
  // игнорируются: сервер вычисляет дедлайн исключительно от собственного
  // payments.created_at (datetime('now') СУБД), клиент не передаёт и не
  // может передать время создания или дедлайн ни в одном поле контракта.
  const tampered = {
    ...payload,
    paymentExpiresAt: '1999-01-01T00:00:00.000Z',
    now: '1999-01-01T00:00:00.000Z',
    clientClock: 0,
  };
  const before1 = Date.now();
  const { payment } = await orderService.createOrder(tampered);
  const deadline = new Date(payment.paymentExpiresAt).getTime();
  assert.ok(
    deadline > before1,
    'дедлайн должен вычисляться от реального серверного времени, а не от любых посторонних клиентских полей',
  );
  assert.ok(
    Math.abs(deadline - (before1 + orderService.PAYMENT_DEADLINE_MINUTES * 60 * 1000)) < 5000,
    'дедлайн должен остаться равным ровно PAYMENT_DEADLINE_MINUTES от серверного now(), независимо от переданных клиентом полей',
  );
});
