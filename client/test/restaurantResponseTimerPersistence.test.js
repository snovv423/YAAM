// Регрессионные тесты для бага "таймер ожидания ответа ресторана сбрасывается
// почти на 3:00 при refresh/повторном входе". Тот же класс бага, что был у
// платёжного qrDeadline (см. qrTimerPersistence.test.js), но у отдельной,
// независимой переменной preDeadline (client/js/app.js) — фикс qrDeadline её
// не затрагивал. Загружают РЕАЛЬНЫЙ client/js/app.js через node:vm (без
// jsdom/новых зависимостей) — см. test/helpers/loadApp.js.
//
// Честное ограничение: это не полноценный браузер — визуальный рендеринг,
// bfcache, реальные Safari-специфичные тайминги не воспроизводятся. Логика
// сохранения/восстановления/очистки preDeadline тестируется детерминированно
// и точно; финальное подтверждение — живой прогон в браузере (см. PDF-отчёт).
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

test('1. новый pre-status получает один дедлайн (~180 секунд)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT1';renderWaitForRestaurant();`);
  const deadline = evalInContext(sandbox, 'preDeadline');
  const remaining = Math.round((deadline - Date.now()) / 1000);
  assert.ok(remaining >= 178 && remaining <= 180, `remaining=${remaining}, ожидали ~180`);
  teardown(sandbox);
});

test('2. preDeadline сохраняется в localStorage вместе с состоянием заказа', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT2';renderWaitForRestaurant();`);
  const stored = readStoredOrder(sandbox);
  assert.ok(stored, 'yaam_active_order должен быть записан');
  assert.equal(typeof stored.preDeadline, 'number');
  teardown(sandbox);
});

test('3. refresh (новый sandbox из сохранённого состояния) восстанавливает тот же preDeadline', async (t) => {
  const a = freshApp();
  evalInContext(a, `currentOrderCode='YAAM-RT3';renderWaitForRestaurant();`);
  const deadlineBefore = evalInContext(a, 'preDeadline');
  const stored = readStoredOrder(a);
  teardown(a);

  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  await evalInContext(b, `tryRestoreSession();`);
  const deadlineAfter = evalInContext(b, 'preDeadline');
  assert.equal(deadlineAfter, deadlineBefore, 'refresh не должен создавать новый дедлайн');
  teardown(b);
});

test('4. повторный restore (дважды) не меняет preDeadline', async (t) => {
  const a = freshApp();
  evalInContext(a, `currentOrderCode='YAAM-RT4';renderWaitForRestaurant();`);
  const stored = readStoredOrder(a);
  teardown(a);

  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  await evalInContext(b, `tryRestoreSession()`);
  const d1 = evalInContext(b, 'preDeadline');
  await evalInContext(b, `tryRestoreSession()`);
  const d2 = evalInContext(b, 'preDeadline');
  assert.equal(d1, stored.preDeadline);
  assert.equal(d2, stored.preDeadline, 'второй restore не должен пересоздать дедлайн');
  teardown(b);
});

test('5. повторный renderWaitForRestaurant() не продлевает дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT5';renderWaitForRestaurant();`);
  const before = evalInContext(sandbox, 'preDeadline');
  evalInContext(sandbox, `renderWaitForRestaurant();`);
  const after = evalInContext(sandbox, 'preDeadline');
  assert.equal(after, before, 'повторный показ экрана ожидания не должен создавать новый дедлайн');
  teardown(sandbox);
});

test('6. повторный startResponseTimer() не продлевает дедлайн', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT6';startResponseTimer();`);
  const before = evalInContext(sandbox, 'preDeadline');
  evalInContext(sandbox, `startResponseTimer();`);
  const after = evalInContext(sandbox, 'preDeadline');
  assert.equal(after, before, 'startResponseTimer() должен переиспользовать существующий дедлайн (guard)');
  teardown(sandbox);
});

test('7. при оставшихся ~2 минутах restore показывает ~2:00, не 3:00', async (t) => {
  const sandbox = freshApp();
  const twoMinLeft = Date.now() + 2 * 60 * 1000;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-RT7', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: null, preDeadline: twoMinLeft, demo: true, demoStage: 'status', statusStep: 0,
    inPreStatus: true, currentFulfillment: 'delivery', ratingSubmitted: false, curEstimatedMinutes: null,
    cartSnapshot: {},
  }));
  await evalInContext(sandbox, `tryRestoreSession();`);
  const el = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.match(el, /1:5[0-9]|2:00/, `ожидали текст около 2:00, получили "${el}"`);
  teardown(sandbox);
});

test('8. после истечения дедлайна таймер показывает 0:00 (до терминального перехода)', async (t) => {
  const sandbox = freshApp();
  const past = Date.now() - 5000;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-RT8', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: null, preDeadline: past, demo: true, demoStage: 'status', statusStep: 0,
    inPreStatus: true, currentFulfillment: 'delivery', ratingSubmitted: false, curEstimatedMinutes: null,
    cartSnapshot: {},
  }));
  await evalInContext(sandbox, `tryRestoreSession();`);
  // responseTimerTick() пишет "...0:00" в DOM синхронно ДО того, как истечение
  // запускает openRejected('timeout') — это существующее поведение (не задето
  // этим фиксом), не "зависший" таймер: заказ терминально завершается.
  const el = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.equal(el, 'Ответ ресторана в течение 0:00');
  teardown(sandbox);
});

test('9. restore после истечения не создаёт новые 3 минуты (заказ завершается, не продлевается)', async (t) => {
  const sandbox = freshApp();
  const past = Date.now() - 5000;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-RT9', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: null, preDeadline: past, demo: true, demoStage: 'status', statusStep: 0,
    inPreStatus: true, currentFulfillment: 'delivery', ratingSubmitted: false, curEstimatedMinutes: null,
    cartSnapshot: {},
  }));
  await evalInContext(sandbox, `tryRestoreSession();`);
  // Если бы дедлайн пересоздавался, здесь остался бы активный заказ с новым
  // ~180-секундным окном. Вместо этого просроченное ожидание корректно
  // завершает заказ (openRejected('timeout')), и активный заказ пропадает.
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  assert.equal(evalInContext(sandbox, 'preDeadline'), null);
  teardown(sandbox);
});

test('10. nextStatus() очищает preDeadline (ресторан принял заказ)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT10';inPreStatus=true;renderWaitForRestaurant();`);
  assert.notEqual(evalInContext(sandbox, 'preDeadline'), null);
  evalInContext(sandbox, `nextStatus();`);
  assert.equal(evalInContext(sandbox, 'preDeadline'), null, 'nextStatus() должен обнулить preDeadline при выходе из pre-status');
  teardown(sandbox);
});

test("11. openRejected('declined') очищает preDeadline", (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT11';renderWaitForRestaurant();`);
  assert.notEqual(evalInContext(sandbox, 'preDeadline'), null);
  evalInContext(sandbox, `openRejected('declined');`);
  assert.equal(evalInContext(sandbox, 'preDeadline'), null);
  teardown(sandbox);
});

test("12. openRejected('timeout') очищает preDeadline", (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT12';renderWaitForRestaurant();`);
  assert.notEqual(evalInContext(sandbox, 'preDeadline'), null);
  evalInContext(sandbox, `openRejected('timeout');`);
  assert.equal(evalInContext(sandbox, 'preDeadline'), null);
  teardown(sandbox);
});

test('13. resetAll() очищает preDeadline', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT13';renderWaitForRestaurant();`);
  assert.notEqual(evalInContext(sandbox, 'preDeadline'), null);
  evalInContext(sandbox, `resetAll();`);
  assert.equal(evalInContext(sandbox, 'preDeadline'), null, 'resetAll() должен обнулить preDeadline');
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  teardown(sandbox);
});

test('14-15. новый заказ после отмены получает новый (более поздний, полный) дедлайн — старый не переносится', async (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT14a';renderWaitForRestaurant();`);
  const oldDeadline = evalInContext(sandbox, 'preDeadline');
  evalInContext(sandbox, `resetAll();`);
  // Небольшая реальная пауза — гарантирует продвижение Date.now() хотя бы на
  // несколько мс, чтобы совпадение чисел не было случайным (см. тот же приём
  // в qrTimerPersistence.test.js, тест 10-12).
  await new Promise((resolve) => setTimeout(resolve, 5));
  evalInContext(sandbox, `currentOrderCode='YAAM-RT14b';renderWaitForRestaurant();`);
  const newDeadline = evalInContext(sandbox, 'preDeadline');
  assert.ok(newDeadline > oldDeadline, 'новый заказ должен получить собственный, более поздний дедлайн, а не унаследованный старый');
  const remaining = Math.round((newDeadline - Date.now()) / 1000);
  assert.ok(remaining >= 178 && remaining <= 180, 'новый дедлайн должен быть полными ~180 секундами, не унаследованным остатком');
  teardown(sandbox);
});

test('16. resyncVisibleTimers (аналог pageshow/bfcache) не продлевает preDeadline', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT16';renderWaitForRestaurant();`);
  const before = evalInContext(sandbox, 'preDeadline');
  evalInContext(sandbox, `resyncVisibleTimers();`);
  const after = evalInContext(sandbox, 'preDeadline');
  assert.equal(after, before, 'resyncVisibleTimers (вызывается на pageshow/visibilitychange) не должен менять дедлайн');
  teardown(sandbox);
});

test('17. qrDeadline и preDeadline не конфликтуют в одном saveOrderState() (нет регрессии платёжного таймера)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-RT17';startNewQRTimer();`);
  const qrBefore = evalInContext(sandbox, 'qrDeadline');
  evalInContext(sandbox, `renderWaitForRestaurant();`); // отдельный вызов, как если бы оба поля когда-то оказались в состоянии разом
  const preAfter = evalInContext(sandbox, 'preDeadline');
  const qrAfter = evalInContext(sandbox, 'qrDeadline');
  assert.equal(qrAfter, qrBefore, 'создание preDeadline не должно менять qrDeadline');
  assert.notEqual(preAfter, null);
  const stored = readStoredOrder(sandbox);
  assert.equal(stored.qrDeadline, qrBefore);
  assert.equal(stored.preDeadline, preAfter);
  teardown(sandbox);
});

test('18. persist preDeadline не зависит от USE_API — но реальная API-ветка (pollOrderOnce) им не пользуется', async (t) => {
  const sandbox = freshApp({ apiBaseUrl: 'https://example.invalid' });
  // saveOrderState() сохраняет preDeadline безусловно (вне if(!USE_API)) —
  // структурно консистентно с qrDeadline. Реальный awaiting_restaurant в
  // API-режиме считает остаток от order.status_updated_at в pollOrderOnce()
  // (отдельная, не тронутая этим фиксом ветка) и никогда не вызывает
  // renderWaitForRestaurant()/startResponseTimer() — здесь подтверждается
  // только то, что persist-механизм сам по себе не ломается флагом USE_API.
  // saveOrderState() в API-режиме — no-op вне общего Web Lock (см. initial-payment
  // idempotency), поэтому сам вызов оборачиваем в withCreateOrderLock, как и
  // остальные мутации order-state в API-режиме.
  await evalInContext(sandbox, `withCreateOrderLock(()=>{currentOrderCode='YAAM-RT18-api';renderWaitForRestaurant();})`);
  const stored = readStoredOrder(sandbox);
  assert.equal(typeof stored.preDeadline, 'number');
  teardown(sandbox);
});

test('19-20. длительности таймеров не изменены (RESTAURANT_RESPONSE_WINDOW_SEC=180, QR_TIMER_SEC=600)', (t) => {
  const sandbox = freshApp();
  assert.equal(evalInContext(sandbox, 'RESTAURANT_RESPONSE_WINDOW_SEC'), 180);
  assert.equal(evalInContext(sandbox, 'QR_TIMER_SEC'), 600);
  teardown(sandbox);
});

// Пункт 21 (backend TTL awaiting_payment = 15 минут / 900 секунд) не
// тестируется здесь намеренно — это backend-логика (server/services/
// orderService.js), не задета этой задачей, server/ не менялся (см. git diff)
// и уже покрыта server/test/dedupTtl.test.js — подтверждается отдельным
// прогоном `cd server && npm test` в рамках этой же сессии, а не клиентским
// unit-тестом.
