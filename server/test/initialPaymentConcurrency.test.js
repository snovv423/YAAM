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

let phoneSeq = 4000;
function freshPayload(overrides = {}) {
  phoneSeq += 1;
  return basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: `+7928000${String(phoneSeq).padStart(4, '0')}`,
    ...overrides,
  });
}

function deferredInitialProvider() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const keys = [];
  paymentService.createPayment = async ({ orderId, idempotencyKey }) => {
    calls += 1;
    keys.push(idempotencyKey);
    await gate;
    return {
      providerPaymentId: `initial_${orderId}_${idempotencyKey.slice(0, 8)}`,
      paymentUrl: `https://pay.example/initial/${orderId}`,
      qrPayload: `initial:${orderId}`,
    };
  };
  return { release, calls: () => calls, keys };
}

test('первоначальный платёж получает durable provider key до внешнего вызова', async () => {
  const payload = freshPayload();
  const seenKeys = [];
  paymentService.createPayment = async ({ orderId, idempotencyKey }) => {
    seenKeys.push(idempotencyKey);
    const reserved = db.prepare(`
      SELECT p.status, a.state, a.provider_idempotency_key
      FROM payments p JOIN payment_initial_attempts a ON a.payment_id = p.id
      WHERE p.order_id = ?
    `).get(orderId);
    assert.equal(reserved.status, 'creating');
    assert.equal(reserved.state, 'creating');
    assert.equal(reserved.provider_idempotency_key, idempotencyKey);
    return { providerPaymentId: `durable_${orderId}`, paymentUrl: null, qrPayload: `durable:${orderId}` };
  };

  const created = await orderService.createOrder(payload);
  assert.equal(seenKeys.length, 1);
  assert.match(seenKeys[0], /^[0-9a-f-]{36}$/);
  assert.ok(seenKeys[0].length <= 64);
  const ready = db.prepare(`
    SELECT p.status, a.state FROM payments p
    JOIN payment_initial_attempts a ON a.payment_id = p.id WHERE p.order_id = ?
  `).get(created.order.id);
  assert.equal(ready.status, 'pending');
  assert.equal(ready.state, 'ready');
});

test('десять одновременных createOrder схлопываются в один order/payment/provider-вызов', async () => {
  const payload = freshPayload();
  const provider = deferredInitialProvider();
  const first = orderService.createOrder(payload);
  await new Promise((resolve) => setImmediate(resolve));
  const rest = Array.from({ length: 9 }, () => orderService.createOrder(payload));
  provider.release();
  const results = await Promise.all([first, ...rest]);

  for (const result of results.slice(1)) {
    assert.equal(result.order.id, results[0].order.id);
    assert.deepEqual(result.payment, results[0].payment);
  }
  assert.equal(provider.calls(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders WHERE customer_phone = ?').get(payload.customerPhone).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments WHERE order_id = ?').get(results[0].order.id).count, 1);
});

test('неопределённая ошибка провайдера оставляет creating, replay использует тот же внешний ключ', async () => {
  const payload = freshPayload();
  const providerResults = new Map();
  const seenKeys = [];
  let logicalCreates = 0;
  paymentService.createPayment = async ({ orderId, idempotencyKey }) => {
    seenKeys.push(idempotencyKey);
    if (!providerResults.has(idempotencyKey)) {
      logicalCreates += 1;
      providerResults.set(idempotencyKey, {
        providerPaymentId: `lost_initial_${orderId}`,
        paymentUrl: `https://pay.example/lost/${orderId}`,
        qrPayload: `lost:${orderId}`,
      });
      throw new Error('response lost after provider accepted request');
    }
    return providerResults.get(idempotencyKey);
  };

  await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 503);
  const ambiguous = db.prepare(`
    SELECT o.id AS order_id, p.id AS payment_id, p.status, p.provider_payment_id,
      a.state, a.provider_idempotency_key
    FROM orders o JOIN payments p ON p.order_id = o.id
    JOIN payment_initial_attempts a ON a.payment_id = p.id
    WHERE o.customer_phone = ?
  `).get(payload.customerPhone);
  assert.equal(ambiguous.status, 'creating');
  assert.equal(ambiguous.provider_payment_id, null);
  assert.equal(ambiguous.state, 'creating');

  const recovered = await orderService.createOrder(payload);
  assert.equal(recovered.order.id, ambiguous.order_id);
  assert.equal(recovered.payment.providerPaymentId, `lost_initial_${ambiguous.order_id}`);
  assert.equal(logicalCreates, 1);
  assert.equal(seenKeys.length, 2);
  assert.equal(seenKeys[0], seenKeys[1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments WHERE order_id = ?').get(ambiguous.order_id).count, 1);
});

test('body-less recover продолжает initial creating тем же provider key', async () => {
  const payload = freshPayload();
  let firstKey;
  paymentService.createPayment = async ({ idempotencyKey }) => {
    firstKey = idempotencyKey;
    throw new Error('lost response');
  };
  await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 503);

  let recoveryKey;
  paymentService.createPayment = async ({ orderId, idempotencyKey }) => {
    recoveryKey = idempotencyKey;
    return {
      providerPaymentId: `recover_${orderId}`,
      paymentUrl: `https://pay.example/recover/${orderId}`,
      qrPayload: null,
    };
  };
  const recovered = await orderService.recoverOrder({
    orderAccessToken: payload.orderAccessToken,
    createIdempotencyKey: payload.createIdempotencyKey,
  });
  assert.equal(recoveryKey, firstKey);
  assert.equal(recovered.order.status, 'awaiting_payment');
  assert.match(recovered.payment.paymentUrl, /\/recover\//);
  assert.deepEqual(Object.keys(recovered.context).sort(), ['createdAt', 'items', 'restaurantId']);
});

test('точный replay восстанавливается даже если ресторан закрылся и меню изменилось после первого POST', async () => {
  const payload = freshPayload();
  let key;
  paymentService.createPayment = async ({ idempotencyKey }) => {
    key = idempotencyKey;
    throw new Error('ambiguous provider response');
  };
  await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 503);

  db.prepare('UPDATE restaurants SET is_open = 0 WHERE id = ?').run(restaurantId);
  db.prepare('UPDATE menu_items SET is_available = 0, price = price + 100 WHERE id = ?').run(menuItemId);
  paymentService.createPayment = async ({ orderId, idempotencyKey }) => {
    assert.equal(idempotencyKey, key);
    return { providerPaymentId: `mutable_${orderId}`, paymentUrl: null, qrPayload: null };
  };
  try {
    const recovered = await orderService.createOrder(payload);
    assert.equal(recovered.order.customer_phone, payload.customerPhone);
    assert.equal(recovered.order.items_total, 300, 'должен сохраниться исходный снимок цены');
  } finally {
    db.prepare('UPDATE restaurants SET is_open = 1 WHERE id = ?').run(restaurantId);
    db.prepare('UPDATE menu_items SET is_available = 1, price = 300 WHERE id = ?').run(menuItemId);
  }
});

test('timeout не оставляет HTTP висеть и replay продолжает ту же строку после паузы', async () => {
  const payload = freshPayload();
  const previousTimeout = process.env.PAYMENT_CREATE_TIMEOUT_MS;
  process.env.PAYMENT_CREATE_TIMEOUT_MS = '20';
  let firstKey;
  paymentService.createPayment = async ({ idempotencyKey }) => {
    firstKey = idempotencyKey;
    return new Promise(() => {});
  };
  const startedAt = Date.now();
  try {
    await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 503);
  } finally {
    if (previousTimeout === undefined) delete process.env.PAYMENT_CREATE_TIMEOUT_MS;
    else process.env.PAYMENT_CREATE_TIMEOUT_MS = previousTimeout;
  }
  assert.ok(Date.now() - startedAt < 500);
  const creating = db.prepare(`
    SELECT p.*, a.provider_idempotency_key FROM payments p
    JOIN payment_initial_attempts a ON a.payment_id = p.id
    JOIN orders o ON o.id = p.order_id WHERE o.customer_phone = ?
  `).get(payload.customerPhone);
  assert.equal(creating.status, 'creating');
  assert.equal(creating.provider_idempotency_key, firstKey);

  let replayKey;
  paymentService.createPayment = async ({ orderId, idempotencyKey }) => {
    replayKey = idempotencyKey;
    return { providerPaymentId: `after_timeout_${orderId}`, paymentUrl: null, qrPayload: null };
  };
  const recovered = await orderService.createOrder(payload);
  assert.equal(recovered.order.id, creating.order_id);
  assert.equal(replayKey, firstKey);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(creating.id).status, 'pending');
});

test('изменённый body с той же парой секретов получает 409 и не вызывает провайдера повторно', async () => {
  const payload = freshPayload();
  let calls = 0;
  paymentService.createPayment = async ({ orderId }) => {
    calls += 1;
    return { providerPaymentId: `body_${orderId}`, paymentUrl: null, qrPayload: null };
  };
  await orderService.createOrder(payload);
  await assert.rejects(
    orderService.createOrder({ ...payload, address: 'изменённый адрес' }),
    (err) => err.statusCode === 409,
  );
  assert.equal(calls, 1);
});

test('другая пара секретов во время медленного create получает 409 без второго заказа', async () => {
  const payload = freshPayload();
  const provider = deferredInitialProvider();
  const first = orderService.createOrder(payload);
  await new Promise((resolve) => setImmediate(resolve));
  const competing = basicOrderPayload(restaurantId, menuItemId, { customerPhone: payload.customerPhone });
  await assert.rejects(orderService.createOrder(competing), (err) => err.statusCode === 409);
  provider.release();
  const created = await first;
  assert.equal(provider.calls(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders WHERE customer_phone = ?').get(payload.customerPhone).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments WHERE order_id = ?').get(created.order.id).count, 1);
});

test('ошибка DB-finalize откатывает provider id, presentation и ledger state атомарно', async () => {
  const firstPayload = freshPayload();
  paymentService.createPayment = async ({ orderId }) => ({
    providerPaymentId: 'duplicate-initial-provider-id', paymentUrl: null, qrPayload: null,
  });
  await orderService.createOrder(firstPayload);

  const secondPayload = freshPayload();
  await assert.rejects(orderService.createOrder(secondPayload));
  const second = db.prepare(`
    SELECT p.id, p.status, p.provider_payment_id, a.state
    FROM orders o JOIN payments p ON p.order_id = o.id
    JOIN payment_initial_attempts a ON a.payment_id = p.id
    WHERE o.customer_phone = ?
  `).get(secondPayload.customerPhone);
  assert.deepEqual(
    { status: second.status, providerPaymentId: second.provider_payment_id, state: second.state },
    { status: 'creating', providerPaymentId: null, state: 'creating' },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_presentations WHERE payment_id = ?').get(second.id).count, 0);
});

test('exact replay после retry возвращает текущую retry-presentation, а не failed initial', async () => {
  const payload = freshPayload();
  let calls = 0;
  paymentService.createPayment = async ({ orderId }) => {
    calls += 1;
    return {
      providerPaymentId: `active_${orderId}_${calls}`,
      paymentUrl: `https://pay.example/${orderId}/${calls}`,
      qrPayload: `active:${orderId}:${calls}`,
    };
  };

  const initial = await orderService.createOrder(payload);
  const initialRow = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'pending'")
    .get(initial.order.id);
  orderService.markPaymentFailed(initial.order.id, initialRow.id);
  const retry = await orderService.retryPayment(
    initial.order.id,
    `yaam_retry_v1_${crypto.randomBytes(32).toString('base64url')}`,
  );
  const callsBeforeReplay = calls;

  const replay = await orderService.createOrder(payload);
  assert.equal(replay.order.status, 'awaiting_payment');
  assert.deepEqual(replay.payment, retry);
  assert.notDeepEqual(replay.payment, initial.payment);
  assert.equal(calls, callsBeforeReplay, 'ready retry не должен повторно звать provider');
});

test('exact replay paid-заказа возвращает payment:null и не зовёт provider', async () => {
  const payload = freshPayload();
  paymentService.createPayment = async ({ orderId }) => ({
    providerPaymentId: `paid_replay_${orderId}`, paymentUrl: null, qrPayload: null,
  });
  const created = await orderService.createOrder(payload);
  const paymentRow = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'pending'")
    .get(created.order.id);
  orderService.markPaid(created.order.id, paymentRow.id);

  let replayProviderCalls = 0;
  paymentService.createPayment = async () => {
    replayProviderCalls += 1;
    throw new Error('provider не должен вызываться');
  };
  const replay = await orderService.createOrder(payload);
  assert.equal(replay.order.status, 'awaiting_restaurant');
  assert.equal(replay.payment, null);
  assert.equal(replayProviderCalls, 0);
});

test('cancelled-before-replay возвращает current order без provider call', async () => {
  const payload = freshPayload();
  paymentService.createPayment = async () => { throw new Error('lost response'); };
  await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 503);
  const reserved = db.prepare(`
    SELECT o.id AS order_id FROM orders o
    JOIN order_access_credentials c ON c.order_id = o.id
    WHERE o.customer_phone = ?
  `).get(payload.customerPhone);
  await orderService.cancelByCustomer(reserved.order_id);

  let replayProviderCalls = 0;
  paymentService.createPayment = async () => {
    replayProviderCalls += 1;
    throw new Error('provider не должен вызываться');
  };
  const replay = await orderService.recoverOrder({
    orderAccessToken: payload.orderAccessToken,
    createIdempotencyKey: payload.createIdempotencyKey,
  });
  assert.equal(replay.order.status, 'cancelled');
  assert.equal(replay.payment, null);
  assert.equal(replayProviderCalls, 0);
});

test('отмена во время provider call fail-closed: cancelled не получает pending payment', async () => {
  const payload = freshPayload();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  paymentService.createPayment = async ({ orderId }) => {
    await gate;
    return {
      providerPaymentId: `cancel_race_${orderId}`,
      paymentUrl: `https://pay.example/cancel-race/${orderId}`,
      qrPayload: null,
    };
  };

  const creating = orderService.createOrder(payload);
  await new Promise((resolve) => setImmediate(resolve));
  const reserved = db.prepare(`
    SELECT o.id AS order_id, p.id AS payment_id
    FROM orders o JOIN payments p ON p.order_id = o.id
    WHERE o.customer_phone = ?
  `).get(payload.customerPhone);
  await orderService.cancelByCustomer(reserved.order_id);
  release();
  await assert.rejects(creating, (err) => err.statusCode === 500);

  const after = db.prepare(`
    SELECT o.status AS order_status, p.status AS payment_status, p.provider_payment_id
    FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = ?
  `).get(reserved.order_id);
  assert.equal(after.order_status, 'cancelled');
  assert.equal(after.payment_status, 'creating');
  assert.equal(after.provider_payment_id, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM payment_presentations WHERE payment_id = ?')
      .get(reserved.payment_id).count,
    0,
  );
});

test('ambiguous creating блокирует другую credential pair и после 15-минутного TTL', async () => {
  const payload = freshPayload();
  let calls = 0;
  paymentService.createPayment = async () => {
    calls += 1;
    throw new Error('ambiguous provider response');
  };
  await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 503);
  db.prepare("UPDATE orders SET created_at = datetime('now', '-16 minutes') WHERE customer_phone = ?")
    .run(payload.customerPhone);

  const competing = basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: payload.customerPhone,
  });
  await assert.rejects(orderService.createOrder(competing), (err) => err.statusCode === 409);
  assert.equal(calls, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM orders WHERE customer_phone = ?')
      .get(payload.customerPhone).count,
    1,
  );
});

test('missing presentation у ready initial payment fail-closed', async () => {
  const payload = freshPayload();
  paymentService.createPayment = async ({ orderId }) => ({
    providerPaymentId: `missing_presentation_${orderId}`,
    paymentUrl: null,
    qrPayload: null,
  });
  const created = await orderService.createOrder(payload);
  const row = db.prepare('SELECT id FROM payments WHERE order_id = ?').get(created.order.id);
  db.prepare('DELETE FROM payment_presentations WHERE payment_id = ?').run(row.id);

  await assert.rejects(orderService.createOrder(payload), (err) => err.statusCode === 500);
});
