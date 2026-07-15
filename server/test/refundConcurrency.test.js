// Refund state machine (Вариант A, см. server/docs/refund-architecture-review.md):
// requested -> processing -> succeeded (терминально) | processing -> failed
// (терминально для строки, новая строка автоматически не создаётся).
// Мокаем paymentService.refundPayment/createPayment напрямую — тот же
// established-паттерн, что и initialPaymentConcurrency.test.js/
// retryPaymentConcurrency.test.js, а не behavior-флаги внутри mockProvider.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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

let phoneSeq = 5000;
function freshPayload(overrides = {}) {
  phoneSeq += 1;
  return basicOrderPayload(restaurantId, menuItemId, {
    customerPhone: `+7928500${String(phoneSeq).padStart(4, '0')}`,
    ...overrides,
  });
}

// Проводит заказ до awaiting_restaurant (оплачен, ждёт ответа ресторана) —
// единственное состояние, из которого cancelByCustomer/restaurantDecline/
// sweepTimeouts вообще резервируют возврат.
async function createPaidOrder(overrides = {}) {
  const created = await orderService.createOrder(freshPayload(overrides));
  const payment = db.prepare(
    "SELECT * FROM payments WHERE order_id = ? AND status = 'pending'",
  ).get(created.order.id);
  const paid = await orderService.markPaid(created.order.id, payment.id);
  return { orderId: created.order.id, paymentId: payment.id, order: paid };
}

function refundRowsForPayment(paymentId) {
  return db.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY id').all(paymentId);
}

test('cancelByCustomer() для оплаченного заказа резервирует ровно одну requested-строку синхронно, до сетевого вызова', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  let sawDuringReserve = null;
  paymentService.refundPayment = async (providerPaymentId, amount, idempotencyKey) => {
    sawDuringReserve = refundRowsForPayment(paymentId)[0];
    return { refundId: `refund_${paymentId}`, status: 'succeeded' };
  };
  const updated = await orderService.cancelByCustomer(orderId);
  assert.equal(updated.status, 'cancelled', 'заказ отменяется сразу, не дожидаясь ответа провайдера');

  await new Promise((resolve) => setImmediate(resolve));
  const rows = refundRowsForPayment(paymentId);
  assert.equal(rows.length, 1, 'должна быть создана ровно одна строка возврата');
  assert.equal(rows[0].reason, 'customer_cancel');
  assert.equal(rows[0].status, 'succeeded');
  assert.ok(sawDuringReserve, 'к моменту сетевого вызова строка возврата уже должна существовать (durable-резервация до провайдера)');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'refunded');
});

test('явный provider status=failed переводит строку в терминальный failed БЕЗ авто-порождения новой строки (регрессия исходного бага)', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  let calls = 0;
  paymentService.refundPayment = async () => {
    calls += 1;
    return { refundId: null, status: 'failed' };
  };
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));

  const rows = refundRowsForPayment(paymentId);
  assert.equal(rows.length, 1, 'после явного failed НЕ должна автоматически появляться вторая строка (Вариант A)');
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].last_error_code, 'provider_failed');
  assert.equal(calls, 1);
  assert.equal(
    db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status,
    'succeeded',
    'явный provider failed НИКОГДА не должен помечать деньги как реально возвращённые — это и есть исходный баг',
  );
});

test('неоднозначная ошибка (throw) оставляет строку processing с тем же ключом; следующая попытка finalизирует succeeded', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  const seenKeys = [];
  let logicalCalls = 0;
  paymentService.refundPayment = async (providerPaymentId, amount, idempotencyKey) => {
    seenKeys.push(idempotencyKey);
    logicalCalls += 1;
    throw new Error('response lost after provider accepted refund request');
  };
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));

  const ambiguous = refundRowsForPayment(paymentId)[0];
  assert.equal(ambiguous.status, 'processing');
  assert.equal(ambiguous.attempt_count, 1);
  assert.ok(ambiguous.next_attempt_at, 'next_attempt_at должен быть выставлен ДО сетевого вызова, а не постфактум');
  assert.match(ambiguous.provider_idempotency_key, /^[0-9a-f-]{36}$/);

  // Бэкдейтим дедлайн — иначе пришлось бы реально ждать 20+ секунд backoff.
  db.prepare("UPDATE refunds SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?").run(ambiguous.id);
  paymentService.refundPayment = async (providerPaymentId, amount, idempotencyKey) => {
    seenKeys.push(idempotencyKey);
    return { refundId: `refund_${paymentId}_recovered`, status: 'succeeded' };
  };
  await orderService.sweepStuckRefunds();

  const finalRow = refundRowsForPayment(paymentId)[0];
  assert.equal(finalRow.status, 'succeeded');
  assert.equal(finalRow.attempt_count, 2);
  assert.equal(seenKeys.length, 2);
  assert.equal(seenKeys[0], seenKeys[1], 'повтор после ambiguous обязан переиспользовать тот же idempotency key');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'refunded');
});

test('таймаут провайдера не подвешивает вызывающую функцию и не удаляет резервацию', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  const previousTimeout = process.env.PAYMENT_REFUND_TIMEOUT_MS;
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '20';
  paymentService.refundPayment = async () => new Promise(() => {}); // висит вечно
  try {
    const startedAt = Date.now();
    await orderService.cancelByCustomer(orderId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(Date.now() - startedAt < 2000, 'cancelByCustomer не должен ждать сетевой таймаут возврата');
  } finally {
    if (previousTimeout === undefined) delete process.env.PAYMENT_REFUND_TIMEOUT_MS;
    else process.env.PAYMENT_REFUND_TIMEOUT_MS = previousTimeout;
  }
  const row = refundRowsForPayment(paymentId)[0];
  assert.equal(row.status, 'processing');
  assert.ok(row.provider_idempotency_key);
});

test('sweepStuckRefunds() не трогает processing-строку, чей next_attempt_at ещё не наступил (не соревнуется с ещё идущей попыткой)', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  let calls = 0;
  paymentService.refundPayment = async () => new Promise(() => {}); // навсегда "в процессе"
  const previousTimeout = process.env.PAYMENT_REFUND_TIMEOUT_MS;
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '300'; // заведомо больше, чем длится тест
  try {
    await orderService.cancelByCustomer(orderId);
    await new Promise((resolve) => setImmediate(resolve));
    paymentService.refundPayment = async () => { calls += 1; return { refundId: 'x', status: 'succeeded' }; };
    await orderService.sweepStuckRefunds();
    assert.equal(calls, 0, 'sweep не должен звонить провайдеру заново, пока next_attempt_at ещё в будущем');
    const row = refundRowsForPayment(paymentId)[0];
    assert.equal(row.status, 'processing');
  } finally {
    if (previousTimeout === undefined) delete process.env.PAYMENT_REFUND_TIMEOUT_MS;
    else process.env.PAYMENT_REFUND_TIMEOUT_MS = previousTimeout;
  }
});

test('десять конкурентных sweepStuckRefunds() на ещё не завершённую попытку не порождают повторных provider-вызовов', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  paymentService.refundPayment = async () => {
    calls += 1;
    await gate;
    return { refundId: `refund_${paymentId}_gated`, status: 'succeeded' };
  };
  // cancelByCustomer уже синхронно закоммитил claim (status=processing,
  // next_attempt_at в будущем) и запустил первый (пока зависший) provider-вызов
  // до того, как мы успеваем что-либо ещё сделать — см. ensureRefundReady:
  // claim не содержит await и выполняется целиком синхронно ДО сетевого вызова.
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'к этому моменту уже должен был стартовать ровно один provider-вызов');

  // next_attempt_at ещё не наступил — ни один из десяти конкурентных sweep не
  // должен найти строку как "зависшую" и повторно звонить провайдеру.
  const sweeps = Array.from({ length: 10 }, () => orderService.sweepStuckRefunds());
  release();
  await Promise.all(sweeps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1, 'десять конкурентных sweep-проходов не должны породить повторный provider-вызов');
  const row = refundRowsForPayment(paymentId)[0];
  assert.equal(row.status, 'succeeded', 'исходная (единственная) попытка должна была успешно финализироваться после release()');
});

test('restaurantDecline() резервирует и выполняет возврат тем же атомарным принципом, что и cancelByCustomer', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  paymentService.refundPayment = async () => ({ refundId: `refund_${paymentId}_declined`, status: 'succeeded' });
  const declined = await orderService.restaurantDecline(orderId);
  assert.equal(declined.status, 'declined');
  await new Promise((resolve) => setImmediate(resolve));
  const row = refundRowsForPayment(paymentId)[0];
  assert.equal(row.reason, 'restaurant_decline');
  assert.equal(row.status, 'succeeded');
});

test('sweepTimeouts() переводит просроченный awaiting_restaurant в timed_out и резервирует возврат атомарно с переходом статуса', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  db.prepare("UPDATE orders SET status_updated_at = datetime('now', '-4 minutes') WHERE id = ?").run(orderId);
  paymentService.refundPayment = async () => ({ refundId: `refund_${paymentId}_timeout`, status: 'succeeded' });

  await orderService.sweepTimeouts();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(orderService.getOrder(orderId).status, 'timed_out');
  const row = refundRowsForPayment(paymentId)[0];
  assert.equal(row.reason, 'timeout');
  assert.equal(row.status, 'succeeded');
});

test('cancelByCustomer() для awaiting_payment (не оплачен) НЕ создаёт строку возврата и не зовёт провайдера', async () => {
  const payload = freshPayload();
  const created = await orderService.createOrder(payload);
  let calls = 0;
  paymentService.refundPayment = async () => { calls += 1; return { refundId: 'x', status: 'succeeded' }; };
  const updated = await orderService.cancelByCustomer(created.order.id);
  assert.equal(updated.status, 'cancelled');
  const paymentRow = db.prepare('SELECT id FROM payments WHERE order_id = ?').get(created.order.id);
  assert.equal(refundRowsForPayment(paymentRow.id).length, 0);
  assert.equal(calls, 0);
});

test('успешно финализированную (succeeded) строку повторный ensureRefundReady-путь не перезаписывает', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  paymentService.refundPayment = async () => ({ refundId: `refund_${paymentId}_first`, status: 'succeeded' });
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));
  const succeeded = refundRowsForPayment(paymentId)[0];
  assert.equal(succeeded.status, 'succeeded');

  let calledAgain = false;
  paymentService.refundPayment = async () => {
    calledAgain = true;
    return { refundId: `refund_${paymentId}_second`, status: 'succeeded' };
  };
  // Повторный sweep поверх уже терминальной строки не должен звонить провайдеру снова.
  await orderService.sweepStuckRefunds();
  assert.equal(calledAgain, false, 'терминальная succeeded-строка не попадает под критерий sweep (status не in requested/processing)');
  const stillSame = refundRowsForPayment(paymentId)[0];
  assert.equal(stillSame.provider_refund_id, `refund_${paymentId}_first`);
});

test('иммутабельные финансовые поля refunds защищены триггером не только на INSERT, но и на UPDATE', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  paymentService.refundPayment = async () => new Promise(() => {});
  const previousTimeout = process.env.PAYMENT_REFUND_TIMEOUT_MS;
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '300';
  try {
    await orderService.cancelByCustomer(orderId);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (previousTimeout === undefined) delete process.env.PAYMENT_REFUND_TIMEOUT_MS;
    else process.env.PAYMENT_REFUND_TIMEOUT_MS = previousTimeout;
  }
  const row = db.prepare('SELECT * FROM refunds WHERE payment_id = ?').get(paymentId);
  assert.equal(row.status, 'processing');
  assert.throws(() => db.prepare('UPDATE refunds SET amount = amount + 1 WHERE id = ?').run(row.id), /immutable/);
  assert.throws(() => db.prepare('UPDATE refunds SET payment_id = payment_id + 1 WHERE id = ?').run(row.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE refunds SET provider = 'yookassa' WHERE id = ?").run(row.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE refunds SET reason = 'timeout' WHERE id = ?").run(row.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE refunds SET provider_idempotency_key = 'x' WHERE id = ?").run(row.id), /immutable/);
  // Мутируемое поле (не в списке защищённых) обновляется штатно — триггер не
  // замораживает строку целиком, только финансово значимые/идентифицирующие поля.
  db.prepare("UPDATE refunds SET last_error_code = 'timeout' WHERE id = ?").run(row.id);
  assert.equal(db.prepare('SELECT last_error_code FROM refunds WHERE id = ?').get(row.id).last_error_code, 'timeout');
});

test('amount возврата обязан совпадать с amount платежа (частичные возвраты запрещены для MVP)', async () => {
  const { paymentId } = await createPaidOrder();
  assert.throws(
    () => db.prepare(`
      INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
      VALUES (?, 'mock', 1, 'requested', 'customer_cancel', ?)
    `).run(paymentId, crypto.randomUUID()),
    /amount must equal payment amount/,
  );
});

test('после succeeded вставка второй строки возврата для того же payment запрещена на уровне БД', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  paymentService.refundPayment = async () => ({ refundId: `refund_${paymentId}_dup`, status: 'succeeded' });
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refundRowsForPayment(paymentId)[0].status, 'succeeded');

  assert.throws(
    () => db.prepare(`
      INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
      VALUES (?, 'mock', (SELECT amount FROM payments WHERE id = ?), 'requested', 'customer_cancel', ?)
    `).run(paymentId, paymentId, crypto.randomUUID()),
    /already successfully refunded/,
  );
});

test('provider_idempotency_key возврата никогда не попадает в публичный DTO заказа', async () => {
  const { orderId } = await createPaidOrder();
  paymentService.refundPayment = async () => new Promise(() => {});
  const previousTimeout = process.env.PAYMENT_REFUND_TIMEOUT_MS;
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '300';
  try {
    await orderService.cancelByCustomer(orderId);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (previousTimeout === undefined) delete process.env.PAYMENT_REFUND_TIMEOUT_MS;
    else process.env.PAYMENT_REFUND_TIMEOUT_MS = previousTimeout;
  }
  const dto = orderService.toPublicOrderDTO(orderService.getOrder(orderId));
  assert.equal(dto.refund_status, 'processing');
  assert.equal(JSON.stringify(dto).includes('provider_idempotency_key'), false);
  assert.deepEqual(Object.keys(dto).sort(), [
    'estimated_ready_minutes', 'fulfillment_type', 'items_total', 'public_code',
    'rating', 'refund_status', 'restaurant_phone', 'status', 'status_updated_at',
  ]);
});

test('refund_status публичного DTO: none -> processing -> done', async () => {
  const { orderId, paymentId } = await createPaidOrder();
  assert.equal(orderService.toPublicOrderDTO(orderService.getOrder(orderId)).refund_status, 'none');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  paymentService.refundPayment = async () => {
    await gate;
    return { refundId: `refund_${paymentId}_dto`, status: 'succeeded' };
  };
  await orderService.cancelByCustomer(orderId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(orderService.toPublicOrderDTO(orderService.getOrder(orderId)).refund_status, 'processing');

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(orderService.toPublicOrderDTO(orderService.getOrder(orderId)).refund_status, 'done');
});

// Настоящий двух-процессный тест restart-safety: первый процесс резервирует
// возврат и обрывается ДО того, как узнаёт результат сетевого вызова —
// process.exit() сразу после того, как claim (переход в processing +
// next_attempt_at) уже успел синхронно закоммититься (сам claim не содержит
// await, см. ensureRefundReady). in-memory refundAttemptInFlight Map первого
// процесса при этом безвозвратно теряется. Второй (этот) процесс открывает
// тот же файл БД с нуля и обязан сам найти и довести строку до терминального
// состояния через sweepStuckRefunds() — без этого возврат завис бы навсегда.
test('restart-safety: второй процесс продолжает возврат, зарезервированный и прерванный первым', async () => {
  const twoProcDbPath = path.join(os.tmpdir(), `yaam-refund-restart-${crypto.randomBytes(6).toString('hex')}.db`);
  const script = `
    process.env.DB_PATH = ${JSON.stringify(twoProcDbPath)};
    process.env.PAYMENT_PROVIDER = 'mock';
    (async () => {
      const db = require('./db');
      const orderService = require('./services/orderService');
      const info = db.prepare(\`
        INSERT INTO restaurants (name, cuisine, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes, is_open, rating, rating_count)
        VALUES ('Restart restaurant', 'Test', '[]', '', '', '+79280000099', 0, 0, 20, 1, 4.5, 10)
      \`).run();
      const restaurantId = info.lastInsertRowid;
      const catInfo = db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?, ?, 0)').run(restaurantId, 'Cat');
      const itemInfo = db.prepare(\`
        INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, weight_g, kcal, protein_g, fat_g, carbs_g, composition, is_popular, sort_order)
        VALUES (?, ?, 'Dish', '', 300, '', 200, 0, 0, 0, 0, '', 0, 0)
      \`).run(restaurantId, catInfo.lastInsertRowid);
      const crypto = require('node:crypto');
      const created = await orderService.createOrder({
        restaurantId, city: 'Грозный', customerName: 'Restart Test', customerPhone: '+79280009999',
        address: 'addr', comment: '', fulfillmentType: 'delivery',
        items: [{ menuItemId: itemInfo.lastInsertRowid, qty: 1 }],
        orderAccessToken: 'yaam_ord_v1_' + crypto.randomBytes(32).toString('base64url'),
        createIdempotencyKey: 'yaam_create_v1_' + crypto.randomBytes(32).toString('base64url'),
      });
      const paymentRow = db.prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'pending'").get(created.order.id);
      await orderService.markPaid(created.order.id, paymentRow.id);
      // refundPayment реального mock-провайдера этого процесса никогда не
      // резолвится — process.exit() ниже симулирует падение ровно во время
      // сетевого вызова, после того как claim уже закоммитился синхронно.
      const paymentService = require('./services/paymentService');
      paymentService.refundPayment = () => new Promise(() => {});
      await orderService.cancelByCustomer(created.order.id);
      process.stdout.write(JSON.stringify({ orderId: created.order.id, paymentId: paymentRow.id }));
      process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe',
  }).toString('utf8');
  const { orderId, paymentId } = JSON.parse(output);

  const { DatabaseSync } = require('node:sqlite');
  const restartDb = new DatabaseSync(twoProcDbPath);
  try {
    const beforeSweep = restartDb.prepare('SELECT * FROM refunds WHERE payment_id = ?').get(paymentId);
    assert.equal(beforeSweep.status, 'processing', 'первый процесс должен был успеть закоммитить claim до "падения"');
    const keyBeforeRestart = beforeSweep.provider_idempotency_key;

    // Второй процесс (этот) ничего не знает про refundAttemptInFlight первого —
    // единственный сигнал, что попытку нужно продолжить, это next_attempt_at в БД.
    restartDb.prepare("UPDATE refunds SET next_attempt_at = datetime('now', '-1 second') WHERE payment_id = ?").run(paymentId);
    restartDb.close();

    process.env.DB_PATH = twoProcDbPath;
    delete require.cache[require.resolve('../db')];
    delete require.cache[require.resolve('../services/orderService')];
    delete require.cache[require.resolve('../services/paymentService')];
    delete require.cache[require.resolve('../services/paymentProviders/mockProvider')];
    // eslint-disable-next-line global-require
    const restartedDb = require('../db');
    // eslint-disable-next-line global-require
    const restartedOrderService = require('../services/orderService');
    // eslint-disable-next-line global-require
    const restartedPaymentService = require('../services/paymentService');
    restartedPaymentService.refundPayment = async () => ({ refundId: 'restart-recovered', status: 'succeeded' });

    await restartedOrderService.sweepStuckRefunds();

    const after = restartedDb.prepare('SELECT * FROM refunds WHERE payment_id = ?').get(paymentId);
    assert.equal(after.status, 'succeeded', 'второй процесс обязан довести зависший возврат до терминального состояния');
    assert.equal(after.provider_idempotency_key, keyBeforeRestart, 'restart не должен породить новый idempotency key');
    assert.equal(restartedDb.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'refunded');
    assert.equal(restartedOrderService.getOrder(orderId).status, 'cancelled', 'бизнес-статус заказа не менялся вторым процессом');
  } finally {
    try { restartDb.close(); } catch { /* уже закрыт */ }
    cleanupDbFile(twoProcDbPath);
  }
});
