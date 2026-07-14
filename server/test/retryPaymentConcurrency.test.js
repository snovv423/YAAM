const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload,
} = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');
const originalCreatePayment = paymentService.createPayment;
const { restaurantId, menuItemId } = seedMinimalRestaurant(db);

after(() => {
  paymentService.createPayment = originalCreatePayment;
  cleanupDbFile(dbPath);
});

let phoneSeq = 3000;
function retryKey() {
  return `yaam_retry_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

async function createFailedOrder() {
  paymentService.createPayment = originalCreatePayment;
  phoneSeq += 1;
  const created = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: `+7928000${String(phoneSeq).padStart(4, '0')}`,
  }));
  const initialPayment = db.prepare(
    "SELECT id FROM payments WHERE order_id = ? AND status = 'pending'",
  ).get(created.order.id);
  orderService.markPaymentFailed(created.order.id, initialPayment.id);
  return created.order;
}

function deferredProviderResult(orderId) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  paymentService.createPayment = async ({ idempotencyKey }) => {
    calls += 1;
    await gate;
    return {
      providerPaymentId: `provider_${orderId}_${idempotencyKey.slice(-8)}`,
      paymentUrl: `https://pay.example/${orderId}`,
      qrPayload: `qr:${orderId}`,
    };
  };
  return { release, calls: () => calls };
}

test('десять одновременных retry с одним ключом создают один платёж и один provider-вызов', async () => {
  const order = await createFailedOrder();
  const key = retryKey();
  const provider = deferredProviderResult(order.id);

  const first = orderService.retryPayment(order.id, key);
  await new Promise((resolve) => setImmediate(resolve));
  const rest = Array.from({ length: 9 }, () => orderService.retryPayment(order.id, key));
  provider.release();
  const results = await Promise.all([first, ...rest]);

  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
  assert.equal(provider.calls(), 1);
  const attempts = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(order.id);
  assert.equal(attempts.length, 2, 'исходная failed + ровно одна повторная попытка');
  assert.deepEqual(attempts.map((p) => p.status), ['failed', 'pending']);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM payment_retry_attempts a
      JOIN payments p ON p.id = a.payment_id WHERE p.order_id = ?
    `).get(order.id).count,
    1,
  );
});

test('разные ключи из двух вкладок сходятся к одной активной попытке', async () => {
  const order = await createFailedOrder();
  const provider = deferredProviderResult(order.id);
  const firstKey = retryKey();
  const secondKey = retryKey();

  const first = orderService.retryPayment(order.id, firstKey);
  await new Promise((resolve) => setImmediate(resolve));
  const second = orderService.retryPayment(order.id, secondKey);
  provider.release();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(a, b);
  assert.equal(provider.calls(), 1);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM payment_retry_keys k
      JOIN payments p ON p.id = k.payment_id WHERE p.order_id = ?
    `).get(order.id).count,
    2,
    'оба принятых ключа должны быть навсегда привязаны к одной попытке',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ? AND status IN ('creating','pending')").get(order.id).count,
    1,
  );

  orderService.markPaymentFailed(order.id, db.prepare(
    "SELECT id FROM payments WHERE order_id = ? AND status = 'pending'",
  ).get(order.id).id);
  await assert.rejects(orderService.retryPayment(order.id, secondKey), (err) => err.statusCode === 409);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM payments WHERE order_id = ?').get(order.id).count,
    2,
    'принятый ранее ключ не должен создать новую попытку после terminal failure',
  );
});

test('повтор после потерянного HTTP-ответа возвращает ту же presentation без нового provider-вызова', async () => {
  const order = await createFailedOrder();
  const key = retryKey();
  let calls = 0;
  paymentService.createPayment = async () => {
    calls += 1;
    return {
      providerPaymentId: `lost_response_${order.id}`,
      paymentUrl: `https://pay.example/lost/${order.id}`,
      qrPayload: `lost:${order.id}`,
    };
  };

  const first = await orderService.retryPayment(order.id, key);
  const replay = await orderService.retryPayment(order.id, key);
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
});

test('неопределённая ошибка провайдера оставляет creating и replay продолжает ту же строку/ключ', async () => {
  const order = await createFailedOrder();
  const key = retryKey();
  const providerKeys = [];
  paymentService.createPayment = async ({ idempotencyKey }) => {
    providerKeys.push(idempotencyKey);
    if (providerKeys.length === 1) throw new Error('network timeout');
    return {
      providerPaymentId: `resumed_${order.id}`,
      paymentUrl: null,
      qrPayload: `resumed:${order.id}`,
    };
  };

  await assert.rejects(orderService.retryPayment(order.id, key), (err) => err.statusCode === 503);
  const creating = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'creating'").get(order.id);
  assert.ok(creating);
  assert.equal(orderService.getOrder(order.id).status, 'payment_failed');

  const resumed = await orderService.retryPayment(order.id, key);
  assert.equal(resumed.providerPaymentId, `resumed_${order.id}`);
  assert.equal(providerKeys.length, 2);
  assert.equal(providerKeys[0], providerKeys[1], 'внешний idempotency key обязан пережить retry');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments WHERE order_id = ?').get(order.id).count, 2);
});

test('зависший provider-вызов ограничен таймаутом и не удаляет зарезервированную попытку', async () => {
  const order = await createFailedOrder();
  const previousTimeout = process.env.PAYMENT_CREATE_TIMEOUT_MS;
  process.env.PAYMENT_CREATE_TIMEOUT_MS = '20';
  paymentService.createPayment = async () => new Promise(() => {});
  const startedAt = Date.now();
  try {
    await assert.rejects(orderService.retryPayment(order.id, retryKey()), (err) => err.statusCode === 503);
  } finally {
    if (previousTimeout === undefined) delete process.env.PAYMENT_CREATE_TIMEOUT_MS;
    else process.env.PAYMENT_CREATE_TIMEOUT_MS = previousTimeout;
  }
  assert.ok(Date.now() - startedAt < 500, 'таймаут не должен оставлять HTTP-запрос висеть бесконечно');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ? AND status = 'creating'").get(order.id).count,
    1,
  );
  assert.equal(orderService.getOrder(order.id).status, 'payment_failed');
});

test('тот же retry-key нельзя использовать для другого заказа', async () => {
  const firstOrder = await createFailedOrder();
  const secondOrder = await createFailedOrder();
  const key = retryKey();
  paymentService.createPayment = async ({ orderId }) => ({
    providerPaymentId: `key_scope_${orderId}`,
    paymentUrl: null,
    qrPayload: `key-scope:${orderId}`,
  });

  await orderService.retryPayment(firstOrder.id, key);
  await assert.rejects(
    orderService.retryPayment(secondOrder.id, key),
    (err) => err.statusCode === 409,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ? AND status IN ('creating','pending')").get(secondOrder.id).count,
    0,
  );
});

test('БД запрещает второй active-платёж и повтор provider id; markPaid меняет точную попытку', async () => {
  const order = await createFailedOrder();
  paymentService.createPayment = async () => ({
    providerPaymentId: `unique_provider_${order.id}`,
    paymentUrl: null,
    qrPayload: `unique:${order.id}`,
  });
  await orderService.retryPayment(order.id, retryKey());
  const pending = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending'").get(order.id);

  assert.throws(() => db.prepare(`
    INSERT INTO payments (order_id, provider, amount, status) VALUES (?, 'mock', 300, 'creating')
  `).run(order.id), /UNIQUE constraint failed/);
  const otherFailedOrder = await createFailedOrder();
  assert.throws(() => db.prepare(`
    INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
    VALUES (?, 'mock', ?, 300, 'failed')
  `).run(otherFailedOrder.id, pending.provider_payment_id), /UNIQUE constraint failed/);

  const oldFailed = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'failed'").get(order.id);
  orderService.markPaymentFailed(order.id, oldFailed.id);
  assert.equal(orderService.getOrder(order.id).status, 'awaiting_payment', 'старая ошибка не должна погасить новую попытку');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(pending.id).status, 'pending');

  orderService.markPaid(order.id, oldFailed.id);
  assert.equal(orderService.getOrder(order.id).status, 'awaiting_payment', 'старый webhook не должен оплатить новую попытку');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(pending.id).status, 'pending');

  orderService.markPaid(order.id, pending.id);
  const rows = db.prepare('SELECT status FROM payments WHERE order_id = ? ORDER BY id').all(order.id);
  assert.deepEqual(rows.map((row) => row.status), ['failed', 'succeeded']);
  assert.equal(orderService.getOrder(order.id).status, 'awaiting_restaurant');
});
