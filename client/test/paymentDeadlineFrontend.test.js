// Stage 11A follow-up: клиент должен использовать серверный
// payment_expires_at/paymentExpiresAt как единственный источник истины для
// qrDeadline в API-режиме (USE_API=true), а не заново вычислять его от
// клиентского Date.now()+QR_TIMER_SEC при каждом refresh/reopen/replay.
// Демо-режим (без backend) намеренно НЕ трогается этой задачей — его
// поведение уже покрыто qrTimerPersistence.test.js и должно остаться
// неизменным (см. client/js/app.js: startNewQRTimer() продолжает
// использовать клиентский QR_TIMER_SEC как единственный источник в demo).
//
// Загружает реальный client/js/app.js через node:vm (см. test/helpers/loadApp.js),
// мокая api.createOrder/api.recoverOrder/api.retryPayment/api.getOrder напрямую
// — тот же established-паттерн, что orderStatusHardening.test.js/orderAccessToken.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

function setupCheckoutForm(sandbox) {
  evalInContext(sandbox, `
    validateCheckout=()=>true;
    validateLegalConsent=()=>true;
    curRest={id:1,name:'Ресторан',address:'Адрес'};
    cart={'0_0':{n:'Блюдо',p:300,q:1,menuItemId:7}};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='Адрес клиента';
    document.getElementById('c-comment').value='';
  `);
}

// 1. -------------------------------------------------------------------
test('openQR() (создание нового заказа, USE_API): qrDeadline берётся из серверного payment.paymentExpiresAt, а не из клиентского QR_TIMER_SEC', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  setupCheckoutForm(sandbox);
  const serverDeadline = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 минут — реальная серверная политика, не QR_TIMER_SEC (10 минут)
  evalInContext(sandbox, `
    api.createOrder=async()=>({
      order:{public_code:'YAAM-PD001',status:'awaiting_payment',items_total:300,refund_status:'none'},
      payment:{paymentUrl:null,qrPayload:'demo',paymentExpiresAt:${JSON.stringify(serverDeadline)}},
    });
    api.getOrder=async()=>({public_code:'YAAM-PD001',status:'awaiting_payment',items_total:300,refund_status:'none'});
  `);
  await evalInContext(sandbox, `openQR()`);
  const qrDeadline = evalInContext(sandbox, `qrDeadline`);
  assert.equal(qrDeadline, new Date(serverDeadline).getTime(), 'qrDeadline должен точно совпадать с серверным paymentExpiresAt');
  const remainingMin = Math.round((qrDeadline - Date.now()) / 60000);
  assert.equal(remainingMin, 15, 'ожидали ~15 минут (серверная политика), а не 10 (клиентский QR_TIMER_SEC)');
  teardown(sandbox);
});

// 2. -------------------------------------------------------------------
test('recover (потерянный ответ, tryRestoreSession -> api.recoverOrder): qrDeadline берётся из серверного значения, не создаётся заново', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${Buffer.alloc(32, 3).toString('base64url')}`;
  const key = `yaam_create_v1_${Buffer.alloc(32, 4).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_pending_order_credentials', JSON.stringify({
    orderAccessToken: token,
    createIdempotencyKey: key,
    createdAt: Date.now() - 1000,
    submittedAt: Date.now() - 900,
  }));
  const serverDeadline = new Date(Date.now() + 12 * 60 * 1000).toISOString();
  evalInContext(sandbox, `
    api.recoverOrder=async()=>({
      order:{public_code:'YAAM-PD002',status:'awaiting_payment',items_total:450},
      payment:{paymentUrl:'https://pay.example/recovered',paymentExpiresAt:${JSON.stringify(serverDeadline)}},
      context:{restaurantId:1,createdAt:'2026-07-14 09:00:00',items:[{name:'Хинкали',price:450,qty:1}]},
    });
    api.getRestaurant=async()=>({id:1,name:'Ресторан A',menu:[],cities:[]});
    api.getOrder=async()=>({public_code:'YAAM-PD002',status:'awaiting_payment',items_total:450,refund_status:'none'});
  `);
  const restored = await evalInContext(sandbox, `tryRestoreSession()`);
  assert.equal(restored, true);
  const qrDeadline = evalInContext(sandbox, `qrDeadline`);
  assert.equal(qrDeadline, new Date(serverDeadline).getTime(), 'восстановленный дедлайн должен совпасть с серверным значением');
  const stored = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(stored.qrDeadline, qrDeadline, 'дедлайн должен быть сохранён вместе с восстановленным заказом');
  teardown(sandbox);
});

// 3. -------------------------------------------------------------------
test('повторный refresh (новый sandbox, тот же localStorage snapshot) не меняет уже сохранённый серверный qrDeadline', async () => {
  const a = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  setupCheckoutForm(a);
  const serverDeadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  evalInContext(a, `
    api.createOrder=async()=>({
      order:{public_code:'YAAM-PD003',status:'awaiting_payment',items_total:300,refund_status:'none'},
      payment:{paymentUrl:null,qrPayload:'demo',paymentExpiresAt:${JSON.stringify(serverDeadline)}},
    });
    api.getOrder=async()=>({public_code:'YAAM-PD003',status:'awaiting_payment',items_total:300,refund_status:'none'});
  `);
  await evalInContext(a, `openQR()`);
  const deadlineBefore = evalInContext(a, `qrDeadline`);
  const stored = JSON.parse(a.localStorage.getItem('yaam_active_order'));
  teardown(a);

  // Симулируем hard refresh: новый JS-heap, тот же localStorage.
  const b = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  evalInContext(b, `api.getRestaurant=async()=>({id:1,name:'Ресторан',menu:[],cities:[]});`);
  await evalInContext(b, `tryRestoreSession()`);
  const deadlineAfter = evalInContext(b, `qrDeadline`);
  assert.equal(deadlineAfter, deadlineBefore, 'refresh не должен пересоздавать серверный дедлайн');
  teardown(b);
});

// 4. -------------------------------------------------------------------
test('retryPaymentFlow(): новая явная попытка получает СВОЙ новый серверный дедлайн (отличный от истёкшего)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const oldDeadline = Date.now() - 5000; // истёкший дедлайн предыдущей (payment_failed) попытки
  evalInContext(sandbox, `
    currentOrderCode='YAAM-PD004';
    currentOrderAccessToken='yaam_ord_v1_${'d'.repeat(43)}';
    qrDeadline=${oldDeadline};
  `);
  const newDeadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  evalInContext(sandbox, `
    api.retryPayment=async()=>({payment:{paymentUrl:null,qrPayload:'retry-qr',paymentExpiresAt:${JSON.stringify(newDeadline)}}});
  `);
  await evalInContext(sandbox, `retryPaymentFlow()`);
  const qrDeadline = evalInContext(sandbox, `qrDeadline`);
  assert.equal(qrDeadline, new Date(newDeadline).getTime(), 'retry должен получить новый серверный дедлайн');
  assert.notEqual(qrDeadline, oldDeadline, 'новый дедлайн должен отличаться от дедлайна истёкшей попытки');
  teardown(sandbox);
});

// 5. -------------------------------------------------------------------
test('pollOrderOnce()/renderAwaitingPayment: синхронизирует qrDeadline из order.payment_expires_at на каждом тике', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const serverDeadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  evalInContext(sandbox, `
    currentOrderCode='YAAM-PD005';
    currentOrderAccessToken='yaam_ord_v1_${'e'.repeat(43)}';
    api.getOrder=async()=>({
      public_code:'YAAM-PD005',status:'awaiting_payment',items_total:300,refund_status:'none',
      payment_expires_at:${JSON.stringify(serverDeadline)},
    });
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  const qrDeadline = evalInContext(sandbox, `qrDeadline`);
  assert.equal(qrDeadline, new Date(serverDeadline).getTime());
  teardown(sandbox);
});

// 6. -------------------------------------------------------------------
test('backward-compat: старый backend без paymentExpiresAt — клиент откатывается на QR_TIMER_SEC, не падает', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  setupCheckoutForm(sandbox);
  evalInContext(sandbox, `
    api.createOrder=async()=>({
      order:{public_code:'YAAM-PD006',status:'awaiting_payment',items_total:300,refund_status:'none'},
      payment:{paymentUrl:null,qrPayload:'demo'},
    });
    api.getOrder=async()=>({public_code:'YAAM-PD006',status:'awaiting_payment',items_total:300,refund_status:'none'});
  `);
  await evalInContext(sandbox, `openQR()`);
  const qrDeadline = evalInContext(sandbox, `qrDeadline`);
  const remaining = Math.round((qrDeadline - Date.now()) / 1000);
  assert.ok(remaining >= 598 && remaining <= 600, `без серверного значения ожидали fallback ~600с (QR_TIMER_SEC), получили remaining=${remaining}`);
  teardown(sandbox);
});

// 7. -------------------------------------------------------------------
test('испорченные часы клиента не влияют на распознанный серверный дедлайн', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  setupCheckoutForm(sandbox);
  const serverDeadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  evalInContext(sandbox, `
    api.createOrder=async()=>({
      order:{public_code:'YAAM-PD007',status:'awaiting_payment',items_total:300,refund_status:'none'},
      payment:{paymentUrl:null,qrPayload:'demo',paymentExpiresAt:${JSON.stringify(serverDeadline)}},
    });
    api.getOrder=async()=>({public_code:'YAAM-PD007',status:'awaiting_payment',items_total:300,refund_status:'none'});
  `);
  // Ломаем клиентские часы ПОСЛЕ мока (Date.parse внутри parseServerDeadline
  // не зависит от Date.now() вообще — он парсит абсолютную ISO-строку).
  evalInContext(sandbox, `
    const _RealDateNow=Date.now;
    Date.now=()=>1000; // 1970 год — заведомо испорченные "часы клиента"
  `);
  await evalInContext(sandbox, `openQR()`);
  const qrDeadline = evalInContext(sandbox, `qrDeadline`);
  assert.equal(qrDeadline, new Date(serverDeadline).getTime(), 'серверный дедлайн должен остаться точным даже при испорченных клиентских часах');
  evalInContext(sandbox, `Date.now=_RealDateNow;`);
  teardown(sandbox);
});
