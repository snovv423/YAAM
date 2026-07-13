const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

test('Web Crypto создаёт две разные 256-битные capability правильного формата', () => {
  const sandbox = freshApp();
  const result = evalInContext(sandbox, `pendingOrderCredentials()`);
  assert.match(result.orderAccessToken, /^yaam_ord_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(result.createIdempotencyKey, /^yaam_create_v1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(result.orderAccessToken.slice(-43), result.createIdempotencyKey.slice(-43));
  teardown(sandbox);
});

test('повтор до истечения окна использует ту же пару — потерянный ответ не создаст новый credential', () => {
  const sandbox = freshApp();
  const first = evalInContext(sandbox, `pendingOrderCredentials()`);
  const second = evalInContext(sandbox, `pendingOrderCredentials()`);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  teardown(sandbox);
});

test('просроченная pending-пара не переиспользуется', () => {
  const sandbox = freshApp();
  const oldToken = `yaam_ord_v1_${Buffer.alloc(32, 3).toString('base64url')}`;
  const oldKey = `yaam_create_v1_${Buffer.alloc(32, 4).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: oldToken,
    createIdempotencyKey: oldKey,
    createdAt: 0,
  }));
  const fresh = evalInContext(sandbox, `pendingOrderCredentials()`);
  assert.notEqual(fresh.orderAccessToken, oldToken);
  assert.notEqual(fresh.createIdempotencyKey, oldKey);
  teardown(sandbox);
});

test('повреждённая pending-пара заменяется новой валидной парой', () => {
  const sandbox = freshApp();
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: 'YAAM-00001',
    createIdempotencyKey: 'predictable',
    createdAt: Date.now(),
  }));
  const fresh = evalInContext(sandbox, `pendingOrderCredentials()`);
  assert.match(fresh.orderAccessToken, /^yaam_ord_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(fresh.createIdempotencyKey, /^yaam_create_v1_[A-Za-z0-9_-]{43}$/);
  teardown(sandbox);
});

test('access token сохраняется с активным заказом и переживает refresh', async () => {
  const a = freshApp();
  const token = evalInContext(a, `pendingOrderCredentials().orderAccessToken`);
  evalInContext(a, `
    currentOrderCode='YAAM-00991';
    currentOrderAccessToken=${JSON.stringify(token)};
    saveOrderState();
  `);
  const saved = a.localStorage.getItem('yaam_active_order');
  teardown(a);

  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', saved);
  // Не запускаем API-polling: проверяем сам persisted contract напрямую.
  const parsed = JSON.parse(b.localStorage.getItem('yaam_active_order'));
  assert.equal(parsed.orderAccessToken, token);
  assert.equal(parsed.orderCode, 'YAAM-00991');
  teardown(b);
});

test('legacy API-заказ без токена не восстанавливается по одному public_code', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({ orderCode: 'YAAM-00001' }));
  await evalInContext(sandbox, `tryRestoreSession()`);
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  assert.equal(evalInContext(sandbox, `currentOrderCode`), null);
  teardown(sandbox);
});

test('resetAll удаляет токен активного и незавершённого запроса', () => {
  const sandbox = freshApp();
  evalInContext(sandbox, `
    const c=pendingOrderCredentials();
    currentOrderCode='YAAM-00992';
    currentOrderAccessToken=c.orderAccessToken;
    saveOrderState();
    resetAll();
  `);
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  assert.equal(evalInContext(sandbox, `currentOrderAccessToken`), null);
  teardown(sandbox);
});

test('api.js передаёт секреты только в заголовках, не в URL или JSON-body', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  let captured;
  sandbox.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 201,
      async json() { return { order: { public_code: 'YAAM-00077' }, payment: {} }; },
    };
  };
  const token = `yaam_ord_v1_${Buffer.alloc(32, 1).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 2).toString('base64url')}`;
  await evalInContext(sandbox, `api.createOrder({restaurantId:1},${JSON.stringify(token)},${JSON.stringify(key)})`);
  assert.equal(captured.url.includes(token), false);
  assert.equal(captured.url.includes(key), false);
  assert.equal(captured.options.body.includes(token), false);
  assert.equal(captured.options.body.includes(key), false);
  assert.equal(captured.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(captured.options.headers['Idempotency-Key'], key);
  teardown(sandbox);
});
