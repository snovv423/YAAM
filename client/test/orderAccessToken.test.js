const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

function makeSharedStorage() {
  const store = {};
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { for (const key of Object.keys(store)) delete store[key]; },
  };
}

function makeSharedLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, task) {
      const run = tail.then(task);
      tail = run.catch(() => {});
      return run;
    },
  };
}

function appWithSharedStorage(storage, opts, locks) {
  const { sandbox } = createSandbox(opts);
  sandbox.localStorage = storage;
  if (locks) sandbox.navigator.locks = locks;
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

test('pending-снимок после отправки хранит только capability и метаданные без ПДн', () => {
  const sandbox = freshApp();
  evalInContext(sandbox, `markPendingOrderSubmitted(pendingOrderCredentials())`);
  const stored = JSON.parse(sandbox.localStorage.getItem('yaam_pending_order_credentials'));
  assert.deepEqual(Object.keys(stored).sort(), [
    'createIdempotencyKey', 'createdAt', 'orderAccessToken', 'submittedAt',
  ]);
  const serialized = JSON.stringify(stored);
  for (const forbidden of ['requestPayload', 'customerName', 'customerPhone', 'address', 'comment', 'items']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.ok(stored.submittedAt > 0);
  teardown(sandbox);
});

test('legacy pending payload мигрируется без ПДн и считается уже отправленным', () => {
  const sandbox = freshApp();
  const token = `yaam_ord_v1_${Buffer.alloc(32, 14).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 15).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: token,
    createIdempotencyKey: key,
    createdAt: Date.now() - 60_000,
    requestPayload: {
      customerName: 'Клиент', customerPhone: '+79281234567', address: 'Адрес', items: [{ name: 'A' }],
    },
  }));
  // Production выполняет persistSanitized=true только внутри Web Lock.
  const migrated = evalInContext(sandbox, `readPendingOrderCredentials({persistSanitized:true})`);
  assert.equal(migrated.orderAccessToken, token);
  assert.ok(migrated.submittedAt > 0);
  const persisted = sandbox.localStorage.getItem('yaam_pending_order_credentials');
  assert.equal(persisted.includes('Клиент'), false);
  assert.equal(persisted.includes('+79281234567'), false);
  assert.equal(persisted.includes('requestPayload'), false);
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

test('resetAll удаляет active snapshot, но не трогает незавершённую capability-пару', () => {
  const sandbox = freshApp();
  evalInContext(sandbox, `
    const c=pendingOrderCredentials();
    currentOrderCode='YAAM-00992';
    currentOrderAccessToken=c.orderAccessToken;
    currentCreateIdempotencyKey=c.createIdempotencyKey;
    currentRetryIdempotencyKey=randomCapability(RETRY_KEY_PREFIX);
    saveOrderState();
    resetAll();
  `);
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  assert.ok(sandbox.localStorage.getItem('yaam_pending_order_credentials'));
  assert.equal(evalInContext(sandbox, `currentOrderAccessToken`), null);
  assert.equal(evalInContext(sandbox, `currentRetryIdempotencyKey`), null);
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

test('recover endpoint получает ту же capability-пару без JSON-body', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  let captured;
  sandbox.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() { return { order: { public_code: 'YAAM-00078' }, payment: {}, context: {} }; },
    };
  };
  const token = `yaam_ord_v1_${Buffer.alloc(32, 16).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 17).toString('base64url')}`;
  await evalInContext(sandbox, `api.recoverOrder(${JSON.stringify(token)},${JSON.stringify(key)})`);
  assert.equal(captured.url, 'https://api.example.invalid/api/orders/recover');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.body, undefined);
  assert.equal(captured.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(captured.options.headers['Idempotency-Key'], key);
  teardown(sandbox);
});

test('refresh после потерянного POST делает recover, не второй POST /orders', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 18).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 19).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: token,
    createIdempotencyKey: key,
    createdAt: Date.now() - 1000,
    submittedAt: Date.now() - 900,
  }));
  evalInContext(sandbox, `
    let initialRecoverCalls=0;
    let initialCreateCalls=0;
    api.recoverOrder=async()=>{
      initialRecoverCalls+=1;
      return{
        order:{public_code:'YAAM-00201',status:'awaiting_payment',items_total:450},
        payment:{paymentUrl:'https://pay.example/recovered'},
        context:{restaurantId:1,createdAt:'2026-07-14 09:00:00',items:[{name:'Хинкали',price:450,qty:1}]},
      };
    };
    api.createOrder=async()=>{initialCreateCalls+=1;throw new Error('POST не должен повторяться');};
    api.getRestaurant=async()=>({id:1,name:'Ресторан A',menu:[],cities:[]});
  `);

  const restored = await evalInContext(sandbox, `tryRestoreSession()`);
  assert.equal(restored, true);
  assert.equal(evalInContext(sandbox, `initialRecoverCalls`), 1);
  assert.equal(evalInContext(sandbox, `initialCreateCalls`), 0);
  assert.equal(evalInContext(sandbox, `currentOrderCode`), 'YAAM-00201');
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  const active = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(active.orderCode, 'YAAM-00201');
  assert.equal(active.restId, 1);
  assert.deepEqual(active.orderItems, [{ n: 'Хинкали', p: 450, q: 1 }]);
  teardown(sandbox);
});

test('временная ошибка recovery блокирует корзину B и сохраняет capability A', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  // Дожидаемся фонового tryRestoreSession(), который app.js запускает при
  // загрузке, чтобы этот тест проверял только явно подготовленный сценарий.
  await new Promise((resolve) => setImmediate(resolve));
  const token = `yaam_ord_v1_${Buffer.alloc(32, 28).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 29).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: token, createIdempotencyKey: key,
    createdAt: Date.now() - 1000, submittedAt: Date.now() - 900,
  }));
  sandbox.localStorage.setItem('yaam_cart_state', JSON.stringify({
    restId: 2, savedAt: Date.now(), cart: { b: { n: 'Блюдо B', p: 900, q: 1 } },
  }));
  evalInContext(sandbox, `
    cart={};curRest=null;
    let recoveryRestaurantLoads=0;
    api.recoverOrder=async()=>{const err=new Error('temporary');err.status=503;throw err;};
    api.getRestaurant=async()=>{recoveryRestaurantLoads+=1;return{id:2,name:'B',menu:[],cities:[]};};
  `);

  const restored = await evalInContext(sandbox, `tryRestoreSession()`);
  assert.equal(restored, true);
  assert.equal(evalInContext(sandbox, `initialRecoveryBlocked`), true);
  assert.equal(evalInContext(sandbox, `JSON.stringify(cart)`), '{}');
  assert.equal(evalInContext(sandbox, `recoveryRestaurantLoads`), 0);
  assert.equal(JSON.parse(sandbox.localStorage.getItem('yaam_pending_order_credentials')).orderAccessToken, token);
  assert.equal(sandbox.document.getElementById('rej-title').textContent, 'Проверяем созданный заказ');
  teardown(sandbox);
});

test('возврат из background повторно восстанавливает submitted initial order', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 30).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 31).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: token, createIdempotencyKey: key,
    createdAt: Date.now() - 1000, submittedAt: Date.now() - 900,
  }));
  evalInContext(sandbox, `
    let visibleRecoveryCalls=0;
    api.recoverOrder=async()=>{
      visibleRecoveryCalls+=1;
      return{
        order:{public_code:'YAAM-00209',status:'awaiting_payment',items_total:310},
        payment:{paymentUrl:null},
        context:{restaurantId:1,createdAt:'2026-07-14 09:10:00',items:[{name:'A',price:310,qty:1}]},
      };
    };
    api.getRestaurant=async()=>({id:1,name:'A',menu:[],cities:[]});
  `);

  await evalInContext(sandbox, `refreshPendingInitialOrderIfVisible()`);
  assert.equal(evalInContext(sandbox, `visibleRecoveryCalls`), 1);
  assert.equal(evalInContext(sandbox, `currentOrderCode`), 'YAAM-00209');
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  teardown(sandbox);
});

test('recover A после изменения формы на B показывает серверный ресторан и состав A', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 20).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 21).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: token,
    createIdempotencyKey: key,
    createdAt: Date.now() - 1000,
    submittedAt: Date.now() - 900,
  }));
  evalInContext(sandbox, `
    curRest={id:2,name:'Ресторан B',menu:[],cities:[]};
    cart={'b':{n:'Блюдо B',p:900,q:2,menuItemId:22}};
    api.recoverOrder=async()=>({
      order:{public_code:'YAAM-00202',status:'awaiting_payment',items_total:300},
      payment:{paymentUrl:null},
      context:{restaurantId:1,createdAt:'2026-07-14 09:05:00',items:[{name:'Блюдо A',price:300,qty:1}]},
    });
    api.getRestaurant=async(id)=>({id,name:'Ресторан A',menu:[],cities:[]});
  `);

  const outcome = await evalInContext(sandbox, `resolveInitialOrder()`);
  assert.equal(outcome.kind, 'resolved');
  assert.equal(evalInContext(sandbox, `currentOrderRestaurantId`), 1);
  assert.equal(evalInContext(sandbox, `curRest.name`), 'Ресторан A');
  assert.equal(evalInContext(sandbox, `JSON.stringify(currentOrderItems)`), JSON.stringify([
    { n: 'Блюдо A', p: 300, q: 1 },
  ]));
  const html = evalInContext(sandbox, `orderItemsHTML()`);
  assert.match(html, /Блюдо A/);
  assert.doesNotMatch(html, /Блюдо B/);
  const active = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(active.restId, 1);
  assert.deepEqual(active.orderItems, [{ n: 'Блюдо A', p: 300, q: 1 }]);
  teardown(sandbox);
});

test('active snapshot из другой вкладки блокирует второй initial POST', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 22).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-00203', orderAccessToken: token, restId: null, orderItems: [],
  }));
  evalInContext(sandbox, `
    let secondTabCreateCalls=0;
    api.createOrder=async()=>{secondTabCreateCalls+=1;throw new Error('duplicate POST');};
  `);
  const outcome = await evalInContext(sandbox, `resolveInitialOrder({allowCreate:true,apiPayload:{restaurantId:2}})`);
  assert.equal(outcome.kind, 'active');
  assert.equal(evalInContext(sandbox, `secondTabCreateCalls`), 0);
  assert.equal(evalInContext(sandbox, `currentOrderCode`), 'YAAM-00203');
  teardown(sandbox);
});

test('Web Locks последовательно выполняет две initial-order критические секции', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const sequence = await evalInContext(sandbox, `(async()=>{
    let lockTail=Promise.resolve();
    navigator.locks={
      request(_name,_options,task){
        const run=lockTail.then(task);
        lockTail=run.catch(()=>{});
        return run;
      }
    };
    const events=[];
    const first=withCreateOrderLock(async()=>{events.push('A:start');await new Promise(resolve=>setTimeout(resolve,10));events.push('A:end');});
    const second=withCreateOrderLock(async()=>{events.push('B:start');events.push('B:end');});
    await Promise.all([first,second]);
    return JSON.stringify(events);
  })()`);
  assert.equal(sequence, JSON.stringify(['A:start', 'A:end', 'B:start', 'B:end']));
  teardown(sandbox);
});

test('без Web Locks создание fail-closed и не запускает критическую секцию', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  delete sandbox.navigator.locks;
  let taskCalls = 0;
  sandbox.__unsafeTask = async () => { taskCalls += 1; };
  await assert.rejects(
    evalInContext(sandbox, `withCreateOrderLock(__unsafeTask)`),
    /обновите браузер/,
  );
  assert.equal(taskCalls, 0);
  teardown(sandbox);
});

test('API order-state нельзя изменить низкоуровневым helper вне общего Web Lock', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const oldToken = `yaam_ord_v1_${Buffer.alloc(32, 42).toString('base64url')}`;
  const newToken = `yaam_ord_v1_${Buffer.alloc(32, 43).toString('base64url')}`;
  const existing = {
    orderCode: 'YAAM-00420', orderAccessToken: oldToken,
    orderCreatedAtMs: Date.now(), restId: 1, orderItems: [],
  };
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify(existing));
  evalInContext(sandbox, `
    currentOrderCode='YAAM-00421';
    currentOrderAccessToken=${JSON.stringify(newToken)};
    orderCreatedAtMs=${existing.orderCreatedAtMs + 1};
  `);

  assert.equal(evalInContext(sandbox, 'saveOrderState()'), false);
  assert.equal(
    evalInContext(sandbox, `clearStoredOrderState('YAAM-00420',${JSON.stringify(oldToken)})`),
    false,
  );
  assert.deepEqual(JSON.parse(sandbox.localStorage.getItem('yaam_active_order')), existing);
  teardown(sandbox);
});

test('общий Web Lock атомарно защищает новый active snapshot от очистки старой вкладкой', async () => {
  const storage = makeSharedStorage();
  const locks = makeSharedLocks();
  const opts = { apiBaseUrl: 'https://api.example.invalid' };
  const writer = appWithSharedStorage(storage, opts, locks);
  const stale = appWithSharedStorage(storage, opts, locks);
  await new Promise((resolve) => setImmediate(resolve));

  const oldToken = `yaam_ord_v1_${Buffer.alloc(32, 44).toString('base64url')}`;
  const newToken = `yaam_ord_v1_${Buffer.alloc(32, 45).toString('base64url')}`;
  const oldCreatedAt = Date.now() - 60_000;
  storage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-00430', orderAccessToken: oldToken,
    orderCreatedAtMs: oldCreatedAt, restId: 1, orderItems: [],
  }));

  let releaseWriter;
  writer.__writerGate = new Promise((resolve) => { releaseWriter = resolve; });
  let markWriterEntered;
  const writerEntered = new Promise((resolve) => { markWriterEntered = resolve; });
  writer.__markWriterEntered = markWriterEntered;

  const writeNew = evalInContext(writer, `withCreateOrderLock(async()=>{
    __markWriterEntered();
    await __writerGate;
    currentOrderCode='YAAM-00431';
    currentOrderAccessToken=${JSON.stringify(newToken)};
    currentOrderRestaurantId=2;
    currentOrderItems=[];
    orderCreatedAtMs=${oldCreatedAt + 120_000};
    return saveOrderState();
  })`);
  await writerEntered;

  const staleClear = evalInContext(
    stale,
    `clearStoredOrderStateSafely('YAAM-00430',${JSON.stringify(oldToken)})`,
  );
  assert.equal(JSON.parse(storage.getItem('yaam_active_order')).orderCode, 'YAAM-00430');

  releaseWriter();
  assert.equal(await writeNew, true);
  assert.equal(await staleClear, false);
  const finalState = JSON.parse(storage.getItem('yaam_active_order'));
  assert.equal(finalState.orderCode, 'YAAM-00431');
  assert.equal(finalState.orderAccessToken, newToken);

  teardown(writer);teardown(stale);
});

test('reset старой вкладки не удаляет submitted capability другой вкладки', () => {
  const storage = makeSharedStorage();
  const a = appWithSharedStorage(storage);
  const credentials = evalInContext(a, `markPendingOrderSubmitted(pendingOrderCredentials())`);
  const before = storage.getItem('yaam_pending_order_credentials');
  const b = appWithSharedStorage(storage);

  evalInContext(b, `resetAll()`);

  assert.equal(storage.getItem('yaam_pending_order_credentials'), before);
  assert.equal(JSON.parse(before).orderAccessToken, credentials.orderAccessToken);
  teardown(a);teardown(b);
});

test('старая вкладка не затирает и не удаляет active snapshot нового заказа', () => {
  const storage = makeSharedStorage();
  const newToken = `yaam_ord_v1_${Buffer.alloc(32, 40).toString('base64url')}`;
  const oldToken = `yaam_ord_v1_${Buffer.alloc(32, 41).toString('base64url')}`;
  const newState = {
    orderCode: 'YAAM-00999', orderAccessToken: newToken,
    orderCreatedAtMs: Date.now(), restId: 1, orderItems: [],
  };
  storage.setItem('yaam_active_order', JSON.stringify(newState));
  const stale = appWithSharedStorage(storage);
  evalInContext(stale, `
    currentOrderCode='YAAM-00010';
    currentOrderAccessToken=${JSON.stringify(oldToken)};
    orderCreatedAtMs=${newState.orderCreatedAtMs - 60_000};
  `);

  assert.equal(evalInContext(stale, `saveOrderState()`), false);
  assert.deepEqual(JSON.parse(storage.getItem('yaam_active_order')), newState);
  evalInContext(stale, `resetAll()`);
  assert.deepEqual(JSON.parse(storage.getItem('yaam_active_order')), newState);
  assert.equal(
    evalInContext(stale, `clearStoredOrderState('YAAM-00999',${JSON.stringify(oldToken)})`),
    false,
  );
  assert.deepEqual(JSON.parse(storage.getItem('yaam_active_order')), newState);
  assert.equal(
    evalInContext(stale, `clearStoredOrderState('YAAM-00999',${JSON.stringify(newToken)})`),
    true,
  );
  assert.equal(storage.getItem('yaam_active_order'), null);
  teardown(stale);
});

test('recover 404 очищает pending и следующая locked-попытка получает новую capability-пару', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const oldToken = `yaam_ord_v1_${Buffer.alloc(32, 23).toString('base64url')}`;
  const oldKey = `yaam_create_v1_${Buffer.alloc(32, 24).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: oldToken,
    createIdempotencyKey: oldKey,
    createdAt: Date.now() - 1000,
    submittedAt: Date.now() - 900,
  }));
  evalInContext(sandbox, `api.recoverOrder=async()=>{const err=new Error('Не найдено');err.status=404;throw err;};`);
  const outcome = await evalInContext(sandbox, `resolveInitialOrder()`);
  assert.equal(outcome.kind, 'none');
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  const next = await evalInContext(sandbox, `withCreateOrderLock(()=>pendingOrderCredentials())`);
  assert.notEqual(next.orderAccessToken, oldToken);
  assert.notEqual(next.createIdempotencyKey, oldKey);
  teardown(sandbox);
});

test('fresh create 409 очищает capability и не оставляет ложный pending', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `api.createOrder=async()=>{const err=new Error('Конфликт');err.status=409;throw err;};`);
  await assert.rejects(
    evalInContext(sandbox, `resolveInitialOrder({allowCreate:true,apiPayload:{restaurantId:1,items:[]}})`),
    (err) => err.status === 409,
  );
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  assert.equal(evalInContext(sandbox, `currentOrderAccessToken`), null);
  assert.equal(evalInContext(sandbox, `currentCreateIdempotencyKey`), null);
  teardown(sandbox);
});

test('неизвестный результат create сохраняет capability и следующая попытка идёт только через recover', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    let unknownCreateCalls=0;
    let unknownRecoverCalls=0;
    api.createOrder=async()=>{unknownCreateCalls+=1;const err=new Error('connection lost');err.isNetworkError=true;throw err;};
    api.recoverOrder=async()=>{
      unknownRecoverCalls+=1;
      return{
        order:{public_code:'YAAM-00204',status:'awaiting_payment',items_total:250},
        payment:{paymentUrl:null},
        context:{restaurantId:null,createdAt:'2026-07-14 09:10:00',items:[{name:'Блюдо A',price:250,qty:1}]},
      };
    };
  `);
  await assert.rejects(
    evalInContext(sandbox, `resolveInitialOrder({allowCreate:true,apiPayload:{restaurantId:1,items:[]}})`),
    /connection lost/,
  );
  const pending = JSON.parse(sandbox.localStorage.getItem('yaam_pending_order_credentials'));
  assert.ok(pending.submittedAt > 0);
  assert.equal(evalInContext(sandbox, `unknownCreateCalls`), 1);

  const recovered = await evalInContext(sandbox, `resolveInitialOrder({allowCreate:true,apiPayload:{restaurantId:2,items:[]}})`);
  assert.equal(recovered.kind, 'resolved');
  assert.equal(recovered.source, 'recover');
  assert.equal(evalInContext(sandbox, `unknownCreateCalls`), 1);
  assert.equal(evalInContext(sandbox, `unknownRecoverCalls`), 1);
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  teardown(sandbox);
});

test('таймаут create-order прерывает ожидание, но остаётся неизвестной сетевой ошибкой без HTTP-статуса', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  await assert.rejects(
    evalInContext(sandbox, `apiRequest('/api/orders',{method:'POST',timeoutMs:5})`),
    (err) => err.isNetworkError === true && err.status === undefined,
  );
  teardown(sandbox);
});

test('неизвестный результат первого openQR сразу открывает блокирующий recovery-экран', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    validateCheckout=()=>true;
    validateLegalConsent=()=>true;
    curRest={id:1,name:'Ресторан A',address:'Адрес',min:0};
    cart={'0_0':{n:'Блюдо A',p:300,q:1,menuItemId:7}};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='Адрес клиента';
    document.getElementById('c-comment').value='';
    api.createOrder=async()=>{const err=new Error('connection lost');err.isNetworkError=true;throw err;};
  `);

  await evalInContext(sandbox, `openQR()`);
  const pending = JSON.parse(sandbox.localStorage.getItem('yaam_pending_order_credentials'));
  assert.ok(pending.submittedAt > 0);
  assert.equal(evalInContext(sandbox, `initialRecoveryBlocked`), true);
  assert.equal(evalInContext(sandbox, `currentOrderCode`), null);
  assert.equal(sandbox.document.getElementById('rej-title').textContent, 'Проверяем созданный заказ');
  assert.equal(sandbox.document.getElementById('rej-action-btn').textContent, 'Проверить снова');
  teardown(sandbox);
});

test('точный replay уже оплаченного заказа не открывает устаревший QR, а запускает polling', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    validateCheckout=()=>true;
    validateLegalConsent=()=>true;
    let replayPollingStarts=0;
    startOrderPolling=()=>{replayPollingStarts+=1;};
    curRest={id:1,name:'Ресторан',address:'Адрес'};
    cart={'0_0':{n:'Блюдо',p:300,q:1,menuItemId:7}};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='Адрес клиента';
    document.getElementById('c-comment').value='';
    api.createOrder=async()=>({
      order:{public_code:'YAAM-00123',status:'awaiting_restaurant',items_total:300},
      payment:{paymentUrl:'https://pay.example/old'}
    });
  `);

  await evalInContext(sandbox, 'openQR()');
  assert.equal(evalInContext(sandbox, 'currentOrderCode'), 'YAAM-00123');
  assert.equal(evalInContext(sandbox, 'replayPollingStarts'), 1);
  assert.equal(sandbox.localStorage.getItem('yaam_pending_order_credentials'), null);
  teardown(sandbox);
});

test('retry-payment передаёт отдельный retry-key только в Idempotency-Key', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  let captured;
  sandbox.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, async json() { return { payment: { paymentUrl: null } }; } };
  };
  const token = `yaam_ord_v1_${Buffer.alloc(32, 5).toString('base64url')}`;
  const retryKey = `yaam_retry_v1_${Buffer.alloc(32, 6).toString('base64url')}`;
  await evalInContext(
    sandbox,
    `api.retryPayment('YAAM-00077',${JSON.stringify(token)},${JSON.stringify(retryKey)})`,
  );
  assert.equal(captured.url.includes(token), false);
  assert.equal(captured.url.includes(retryKey), false);
  assert.equal(captured.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(captured.options.headers['Idempotency-Key'], retryKey);
  teardown(sandbox);
});

test('двойной тап retryPaymentFlow отправляет один запрос и очищает ключ только после успеха', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  let release;
  const responseGate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let capturedKey;
  sandbox.fetch = async (_url, options) => {
    calls += 1;
    capturedKey = options.headers['Idempotency-Key'];
    await responseGate;
    return { ok: true, status: 200, async json() { return { payment: { paymentUrl: 'https://pay.example/1' } }; } };
  };
  const token = `yaam_ord_v1_${Buffer.alloc(32, 7).toString('base64url')}`;
  evalInContext(sandbox, `
    currentOrderCode='YAAM-00088';
    currentOrderAccessToken=${JSON.stringify(token)};
    currentOrderAmount=300;
  `);
  await evalInContext(sandbox, 'saveOrderStateSafely()');
  const first = evalInContext(sandbox, 'retryPaymentFlow()');
  const second = evalInContext(sandbox, 'retryPaymentFlow()');
  await second;
  for (let i = 0; calls === 0 && i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.match(capturedKey, /^yaam_retry_v1_[A-Za-z0-9_-]{43}$/);
  const whilePending = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(whilePending.retryIdempotencyKey, capturedKey);

  release();
  await first;
  const afterSuccess = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(afterSuccess.retryIdempotencyKey, null);
  assert.equal(afterSuccess.paymentUrl, 'https://pay.example/1');
  assert.equal(evalInContext(sandbox, 'retryPaymentInFlight'), false);
  teardown(sandbox);
});

test('сетевой сбой сохраняет retry-key, следующий вызов повторяет тот же ключ', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const sentKeys = [];
  let fail = true;
  sandbox.fetch = async (_url, options) => {
    sentKeys.push(options.headers['Idempotency-Key']);
    if (fail) throw new Error('network lost');
    return { ok: true, status: 200, async json() { return { payment: { paymentUrl: null } }; } };
  };
  const token = `yaam_ord_v1_${Buffer.alloc(32, 8).toString('base64url')}`;
  evalInContext(sandbox, `
    currentOrderCode='YAAM-00089';
    currentOrderAccessToken=${JSON.stringify(token)};
    currentOrderAmount=300;
  `);
  await evalInContext(sandbox, 'saveOrderStateSafely()');
  await evalInContext(sandbox, 'retryPaymentFlow()');
  const savedAfterFailure = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.match(savedAfterFailure.retryIdempotencyKey, /^yaam_retry_v1_/);

  fail = false;
  await evalInContext(sandbox, 'retryPaymentFlow()');
  assert.equal(sentKeys.length, 2);
  assert.equal(sentKeys[1], sentKeys[0]);
  teardown(sandbox);
});

test('refresh после потерянного успешного ответа автоматически восстанавливает новую payment presentation', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 10).toString('base64url')}`;
  const retryKey = `yaam_retry_v1_${Buffer.alloc(32, 11).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-00091',
    orderAccessToken: token,
    retryIdempotencyKey: retryKey,
    paymentUrl: 'https://pay.example/old-failed-attempt',
    amount: 300,
    restId: null,
  }));
  const calls = [];
  sandbox.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/retry-payment')) {
      return {
        ok: true,
        status: 200,
        async json() { return { payment: { paymentUrl: 'https://pay.example/recovered' } }; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          public_code: 'YAAM-00091', status: 'awaiting_payment', items_total: 300,
          fulfillment_type: 'delivery', rating: null, restaurant_phone: null,
        };
      },
    };
  };

  await evalInContext(sandbox, 'tryRestoreSession()');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const saved = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(calls.filter((call) => call.url.endsWith('/retry-payment')).length, 1);
  assert.equal(calls.find((call) => call.url.endsWith('/retry-payment')).options.headers['Idempotency-Key'], retryKey);
  assert.equal(saved.retryIdempotencyKey, null);
  assert.equal(saved.paymentUrl, 'https://pay.example/recovered');
  assert.ok(saved.qrDeadline > Date.now());
  teardown(sandbox);
});

test('вторая вкладка подхватывает уже сохранённый retry-key перед генерацией нового', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const sharedKey = `yaam_retry_v1_${Buffer.alloc(32, 13).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-00092', retryIdempotencyKey: sharedKey,
  }));
  evalInContext(sandbox, `currentOrderCode='YAAM-00092';currentRetryIdempotencyKey=null;syncRetryKeyFromStoredOrder();`);
  assert.equal(evalInContext(sandbox, 'currentRetryIdempotencyKey'), sharedKey);
  teardown(sandbox);
});

test('однозначный HTTP 409 очищает старый retry-key для новой ручной попытки', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: false,
    status: 409,
    async json() { return { error: 'Предыдущая попытка завершена' }; },
  });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 9).toString('base64url')}`;
  evalInContext(sandbox, `
    currentOrderCode='YAAM-00090';
    currentOrderAccessToken=${JSON.stringify(token)};
    currentOrderAmount=300;
  `);
  await evalInContext(sandbox, 'saveOrderStateSafely()');
  await evalInContext(sandbox, 'retryPaymentFlow()');
  const saved = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(saved.retryIdempotencyKey, null);
  teardown(sandbox);
});
