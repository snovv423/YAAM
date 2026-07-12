// Регрессионные тесты для бага "платёжный таймер сбрасывается на 10:00 при
// refresh/повторном входе". Загружают РЕАЛЬНЫЙ client/js/app.js через
// node:vm (без jsdom/новых зависимостей) — см. test/helpers/loadApp.js.
//
// Честное ограничение: это не полноценный браузер — визуальный рендеринг,
// bfcache, реальные Safari-специфичные тайминги не воспроизводятся. Логика
// сохранения/восстановления qrDeadline тестируется детерминированно и точно;
// финальное подтверждение — ручной прогон в Safari (см. PDF-отчёт).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

function readStoredOrder(sandbox) {
  const raw = sandbox.localStorage.getItem('yaam_active_order');
  return raw ? JSON.parse(raw) : null;
}

test('1. новый заказ получает один дедлайн (~600 секунд)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-T1';startNewQRTimer();`);
  const deadline = evalInContext(sandbox, 'qrDeadline');
  const remaining = Math.round((deadline - Date.now()) / 1000);
  assert.ok(remaining >= 598 && remaining <= 600, `remaining=${remaining}, ожидали ~600`);
  teardown(sandbox);
});

test('2. refresh (новый sandbox из сохранённого состояния) не меняет дедлайн', (t) => {
  const a = freshApp();
  evalInContext(a, `currentOrderCode='YAAM-T2';startNewQRTimer();`);
  const deadlineBefore = evalInContext(a, 'qrDeadline');
  const stored = readStoredOrder(a);
  teardown(a);

  // Симулируем hard refresh: совершенно новый JS-heap (новый sandbox),
  // localStorage — общий "диск", переносим то же самое сохранённое состояние.
  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  evalInContext(b, `tryRestoreSession();`);
  const deadlineAfter = evalInContext(b, 'qrDeadline');
  assert.equal(deadlineAfter, deadlineBefore, 'refresh не должен создавать новый дедлайн');
  teardown(b);
});

test('3. повторный restore (дважды) не меняет дедлайн', async (t) => {
  const a = freshApp();
  evalInContext(a, `currentOrderCode='YAAM-T3';startNewQRTimer();`);
  const stored = readStoredOrder(a);
  teardown(a);

  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  await evalInContext(b, `tryRestoreSession()`);
  const d1 = evalInContext(b, 'qrDeadline');
  await evalInContext(b, `tryRestoreSession()`);
  const d2 = evalInContext(b, 'qrDeadline');
  assert.equal(d1, stored.qrDeadline);
  assert.equal(d2, stored.qrDeadline, 'второй restore не должен пересоздать дедлайн');
  teardown(b);
});

test('4. выход с QR (resumeExistingOrderFlow) и возврат не меняют дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-T4';demoStage='qr';startNewQRTimer();`);
  const before = evalInContext(sandbox, 'qrDeadline');
  evalInContext(sandbox, `resumeExistingOrderFlow();`);
  const after = evalInContext(sandbox, 'qrDeadline');
  assert.equal(after, before, 'resumeExistingOrderFlow не должен создавать новый дедлайн');
  teardown(sandbox);
});

test('5. resumeExistingPayment() (аналог повторного renderAwaitingPayment) не меняет дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-T5';startNewQRTimer();`);
  const before = evalInContext(sandbox, 'qrDeadline');
  evalInContext(sandbox, `lastKnownOrder={items_total:500};resumeExistingPayment();`);
  const after = evalInContext(sandbox, 'qrDeadline');
  assert.equal(after, before, 'resumeExistingPayment не должен создавать новый дедлайн');
  teardown(sandbox);
});

test('6. при оставшихся ~6 минутах после restore показывается ~6:00, не 10:00', (t) => {
  const sandbox = freshApp();
  const sixMinLeft = Date.now() + 6 * 60 * 1000;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-T6', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: sixMinLeft, demo: true, demoStage: 'qr', statusStep: 0, inPreStatus: true,
    currentFulfillment: 'delivery', ratingSubmitted: false, curEstimatedMinutes: null, cartSnapshot: {},
  }));
  evalInContext(sandbox, `tryRestoreSession();`);
  const text = sandbox.__elementCache ? null : null; // noop, читаем через getElementById ниже
  const el = evalInContext(sandbox, `document.getElementById('qr-time').textContent`);
  assert.match(el, /^5:5[0-9]|^6:00$/, `ожидали текст около 6:00, получили "${el}"`);
  teardown(sandbox);
});

test('7. после истечения дедлайна таймер остаётся 0:00', (t) => {
  const sandbox = freshApp();
  const past = Date.now() - 5000;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-T7', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: past, demo: true, demoStage: 'qr', statusStep: 0, inPreStatus: true,
    currentFulfillment: 'delivery', ratingSubmitted: false, curEstimatedMinutes: null, cartSnapshot: {},
  }));
  evalInContext(sandbox, `tryRestoreSession();`);
  const el = evalInContext(sandbox, `document.getElementById('qr-time').textContent`);
  assert.equal(el, '0:00');
  teardown(sandbox);
});

test('8. после истечения дедлайна повторный restore не создаёт новые 10 минут', (t) => {
  const sandbox = freshApp();
  const past = Date.now() - 5000;
  const saved = {
    orderCode: 'YAAM-T8', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: past, demo: true, demoStage: 'qr', statusStep: 0, inPreStatus: true,
    currentFulfillment: 'delivery', ratingSubmitted: false, curEstimatedMinutes: null, cartSnapshot: {},
  };
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify(saved));
  evalInContext(sandbox, `tryRestoreSession();`);
  const deadlineAfterFirstRestore = evalInContext(sandbox, 'qrDeadline');
  assert.equal(deadlineAfterFirstRestore, past, 'дедлайн должен остаться в прошлом, не пересоздаться');
  const el = evalInContext(sandbox, `document.getElementById('qr-time').textContent`);
  assert.equal(el, '0:00', 'не должно снова стать 10:00');
  teardown(sandbox);
});

test('9. явная отмена (resetAll) очищает дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-T9';startNewQRTimer();`);
  assert.notEqual(evalInContext(sandbox, 'qrDeadline'), null);
  evalInContext(sandbox, `resetAll();`);
  assert.equal(evalInContext(sandbox, 'qrDeadline'), null, 'resetAll должен обнулить qrDeadline');
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null, 'заказ должен быть удалён из localStorage');
  teardown(sandbox);
});

test('10-12. новый заказ после отмены получает новый (другой) дедлайн', async (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-T10a';startNewQRTimer();`);
  const oldDeadline = evalInContext(sandbox, 'qrDeadline');
  evalInContext(sandbox, `resetAll();`);
  // Небольшая реальная пауза гарантирует, что Date.now() успеет продвинуться
  // хотя бы на несколько мс — иначе на быстрой машине оба вызова startNewQRTimer()
  // могут попасть в одну и ту же миллисекунду и совпасть числом чисто случайно,
  // что не было бы реальным багом, а флейки самого теста.
  await new Promise((resolve) => setTimeout(resolve, 5));
  evalInContext(sandbox, `currentOrderCode='YAAM-T10b';startNewQRTimer();`);
  const newDeadline = evalInContext(sandbox, 'qrDeadline');
  assert.ok(newDeadline > oldDeadline, 'новый заказ должен получить собственный, более поздний дедлайн, а не унаследованный старый');
  const remaining = Math.round((newDeadline - Date.now()) / 1000);
  assert.ok(remaining >= 598 && remaining <= 600, 'новый дедлайн должен быть полными ~10 минутами, не унаследованным остатком');
  teardown(sandbox);
});

test('11. успешная оплата (afterPay, demo) очищает дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `
    currentOrderCode='YAAM-T11';
    curRest={id:1,phone:'+79280000000',min:0};
    fulfillmentType='delivery';
    startNewQRTimer();
  `);
  assert.notEqual(evalInContext(sandbox, 'qrDeadline'), null);
  evalInContext(sandbox, `afterPay();`);
  assert.equal(evalInContext(sandbox, 'qrDeadline'), null, 'после afterPay() дедлайн должен быть очищен');
  teardown(sandbox);
});

test('13. resyncVisibleTimers (аналог pageshow/bfcache) не продлевает дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-T13';startNewQRTimer();`);
  const before = evalInContext(sandbox, 'qrDeadline');
  evalInContext(sandbox, `resyncVisibleTimers();`);
  const after = evalInContext(sandbox, 'qrDeadline');
  assert.equal(after, before, 'resyncVisibleTimers (вызывается на pageshow/visibilitychange) не должен менять дедлайн');
  teardown(sandbox);
});

test('14. reuse-механизм (startQRTimer/stopQRTimer/qrDeadline) не зависит от USE_API', (t) => {
  const demo = freshApp();
  const api = freshApp({ apiBaseUrl: 'https://example.invalid' });
  evalInContext(demo, `currentOrderCode='YAAM-T14-demo';startNewQRTimer();`);
  evalInContext(api, `currentOrderCode='YAAM-T14-api';startNewQRTimer();`);
  const demoBefore = evalInContext(demo, 'qrDeadline');
  const apiBefore = evalInContext(api, 'qrDeadline');
  evalInContext(demo, `startQRTimer();`); // reuse
  evalInContext(api, `startQRTimer();`); // reuse
  assert.equal(evalInContext(demo, 'qrDeadline'), demoBefore, 'demo: startQRTimer() должен переиспользовать дедлайн');
  assert.equal(evalInContext(api, 'qrDeadline'), apiBefore, 'api: startQRTimer() должен переиспользовать дедлайн (та же функция, не завязана на USE_API)');
  teardown(demo);
  teardown(api);
});

// Пункт 15 (TTL awaiting_payment = 15 минут) не тестируется здесь намеренно —
// это backend-логика (server/services/orderService.js), не задета этой
// задачей и уже покрыта server/test/dedupTtl.test.js.
