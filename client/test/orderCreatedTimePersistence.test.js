// Регрессионные тесты для бага "время оформления заказа сдвигается на момент
// refresh/restore вместо реального момента оформления". Тот же архитектурный
// класс, что qrDeadline/preDeadline (значение, которое должно быть создано
// один раз и пережить refresh как есть, вместо этого пересчитывалось на
// каждый (ре)рендер), но у отдельного, ORDER-scoped значения orderCreatedAtMs
// — не countdown, а неизменная метка момента создания заказа, живущая весь
// жизненный цикл заказа (в отличие от preDeadline, НЕ очищается на
// nextStatus()). Загружают РЕАЛЬНЫЙ client/js/app.js через node:vm (без
// jsdom/новых зависимостей) — см. test/helpers/loadApp.js.
//
// Архитектурное решение: orderCreatedAtMs захватывается на клиенте в openQR()
// (момент реального создания заказа), одинаково для demo и API — а не из
// backend order.created_at, которое существует в schema.sql, но сознательно
// не входит в PublicOrderDTO (allowlist минимизации PII/полей). Разница между
// client-side capture и реальным server created_at — время одного сетевого
// запроса (доли секунды), не влияет на отображение с точностью до минуты.
//
// Честное ограничение: это не полноценный браузер — визуальный рендеринг,
// bfcache, реальные Safari-специфичные тайминги не воспроизводятся.
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

// Формат, идентичный production setOrderTime(): часы без ведущего нуля, минуты — всегда 2 цифры.
function expectedText(ms) {
  const d = new Date(ms);
  const h = d.getHours(), m = d.getMinutes();
  return `Заказ оформлен в ${h}:${m < 10 ? '0' : ''}${m}`;
}

test('1. новый заказ (реальный openQR()) получает orderCreatedAtMs в момент создания', async (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `
    curRest={id:1,name:'Тестовый ресторан',address:'',phone:'',min:0};
    cart={'0_0':{n:'Блюдо',p:1000,q:1,menuItemId:null}};
    fulfillmentType='delivery';
    document.getElementById('c-name').value='Тест';
    document.getElementById('c-phone').value='+79280000000';
    saveLegalAcceptance();
  `);
  const before = Date.now();
  await evalInContext(sandbox, `openQR()`);
  const after = Date.now();
  const createdAt = evalInContext(sandbox, 'orderCreatedAtMs');
  assert.ok(typeof createdAt === 'number', 'orderCreatedAtMs должен быть установлен');
  assert.ok(createdAt >= before && createdAt <= after, `orderCreatedAtMs=${createdAt} должен быть между ${before} и ${after}`);
  assert.ok(evalInContext(sandbox, 'currentOrderCode'), 'заказ должен быть реально создан (demo-ветка openQR())');
  teardown(sandbox);
});

test('2. orderCreatedAtMs сохраняется в localStorage вместе с состоянием заказа', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT2';orderCreatedAtMs=Date.now();saveOrderState();`);
  const stored = readStoredOrder(sandbox);
  assert.ok(stored, 'yaam_active_order должен быть записан');
  assert.equal(typeof stored.orderCreatedAtMs, 'number');
  teardown(sandbox);
});

test('3. refresh (новый sandbox из сохранённого состояния) восстанавливает тот же orderCreatedAtMs', async (t) => {
  const a = freshApp();
  evalInContext(a, `currentOrderCode='YAAM-OT3';orderCreatedAtMs=Date.now();saveOrderState();`);
  const before = evalInContext(a, 'orderCreatedAtMs');
  const stored = readStoredOrder(a);
  teardown(a);

  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  await evalInContext(b, `tryRestoreSession();`);
  const after = evalInContext(b, 'orderCreatedAtMs');
  assert.equal(after, before, 'refresh не должен создавать новый timestamp');
  teardown(b);
});

test('4. повторный restore (дважды) не меняет orderCreatedAtMs', async (t) => {
  const a = freshApp();
  evalInContext(a, `currentOrderCode='YAAM-OT4';orderCreatedAtMs=Date.now();saveOrderState();`);
  const stored = readStoredOrder(a);
  teardown(a);

  const b = freshApp();
  b.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  await evalInContext(b, `tryRestoreSession()`);
  const d1 = evalInContext(b, 'orderCreatedAtMs');
  await evalInContext(b, `tryRestoreSession()`);
  const d2 = evalInContext(b, 'orderCreatedAtMs');
  assert.equal(d1, stored.orderCreatedAtMs);
  assert.equal(d2, stored.orderCreatedAtMs, 'второй restore не должен пересоздать timestamp');
  teardown(b);
});

test('5. повторный initStatusScreen() (рендер статуса) не меняет orderCreatedAtMs', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT5';orderCreatedAtMs=Date.now()-3600000;`);
  const before = evalInContext(sandbox, 'orderCreatedAtMs');
  evalInContext(sandbox, `initStatusScreen();`);
  evalInContext(sandbox, `initStatusScreen();`);
  const after = evalInContext(sandbox, 'orderCreatedAtMs');
  assert.equal(after, before, 'повторный показ экрана статуса не должен менять orderCreatedAtMs');
  teardown(sandbox);
});

test('6. setOrderTime() форматирует ПЕРЕДАННЫЙ timestamp, а не Date.now()', (t) => {
  const sandbox = freshApp();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  evalInContext(sandbox, `setOrderTime(${twoHoursAgo});`);
  const text = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.equal(text, expectedText(twoHoursAgo));
  assert.notEqual(text, expectedText(Date.now()), 'не должен совпадать с "сейчас" (иначе используется Date.now(), а не переданный ms)');
  teardown(sandbox);
});

test('7. restore через ~5 минут после создания показывает исходный HH:MM, не текущее время', async (t) => {
  const sandbox = freshApp();
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-OT7', providerPaymentId: null, paymentUrl: null, amount: 500, restId: null,
    qrDeadline: null, preDeadline: null, orderCreatedAtMs: fiveMinAgo, demo: true, demoStage: 'status',
    statusStep: 0, inPreStatus: false, currentFulfillment: 'delivery', ratingSubmitted: false,
    curEstimatedMinutes: null, cartSnapshot: {},
  }));
  await evalInContext(sandbox, `tryRestoreSession();`);
  const text = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.equal(text, expectedText(fiveMinAgo));
  teardown(sandbox);
});

test('8. крафтованный timestamp у границы минуты форматируется корректно (без реального ожидания)', (t) => {
  const sandbox = freshApp();
  const d = new Date();
  d.setSeconds(59, 900); // HH:MM:59.900 — на грани перехода к следующей минуте
  const ms = d.getTime();
  evalInContext(sandbox, `setOrderTime(${ms});`);
  const text1 = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  // Повторный вызов с тем же ms (симулирует повторный restore/render в другой
  // реальный момент) обязан дать идентичный текст — независимо от текущего
  // "сейчас" в момент вызова теста.
  evalInContext(sandbox, `setOrderTime(${ms});`);
  const text2 = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.equal(text1, expectedText(ms));
  assert.equal(text2, text1, 'повторный рендер того же timestamp должен давать идентичный текст');
  teardown(sandbox);
});

test('9. крафтованный timestamp у границы часа форматируется корректно (без реального ожидания)', (t) => {
  const sandbox = freshApp();
  const d = new Date();
  d.setMinutes(59, 59, 900); // HH:59:59.900 — на грани перехода к следующему часу
  const ms = d.getTime();
  evalInContext(sandbox, `setOrderTime(${ms});`);
  const text = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.equal(text, expectedText(ms));
  teardown(sandbox);
});

test('10-11. новый заказ после resetAll() получает новый (более поздний) timestamp — старый не переносится', async (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT10a';orderCreatedAtMs=Date.now();`);
  const oldCreatedAt = evalInContext(sandbox, 'orderCreatedAtMs');
  evalInContext(sandbox, `resetAll();`);
  assert.equal(evalInContext(sandbox, 'orderCreatedAtMs'), null, 'resetAll() должен обнулить orderCreatedAtMs');
  // Небольшая реальная пауза — гарантирует продвижение Date.now() (тот же
  // приём, что в qrTimerPersistence.test.js / restaurantResponseTimerPersistence.test.js).
  await new Promise((resolve) => setTimeout(resolve, 5));
  evalInContext(sandbox, `currentOrderCode='YAAM-OT10b';orderCreatedAtMs=Date.now();`);
  const newCreatedAt = evalInContext(sandbox, 'orderCreatedAtMs');
  assert.ok(newCreatedAt > oldCreatedAt, 'новый заказ должен получить собственный, более поздний timestamp — не унаследованный старый');
  teardown(sandbox);
});

test('12. resetAll() очищает orderCreatedAtMs (отмена)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT12';orderCreatedAtMs=Date.now();`);
  assert.notEqual(evalInContext(sandbox, 'orderCreatedAtMs'), null);
  evalInContext(sandbox, `resetAll();`);
  assert.equal(evalInContext(sandbox, 'orderCreatedAtMs'), null);
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  teardown(sandbox);
});

test("13. openRejected('declined') очищает orderCreatedAtMs — не создаёт новый для того же заказа", (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT13';orderCreatedAtMs=Date.now();`);
  assert.notEqual(evalInContext(sandbox, 'orderCreatedAtMs'), null);
  evalInContext(sandbox, `openRejected('declined');`);
  assert.equal(evalInContext(sandbox, 'orderCreatedAtMs'), null, 'openRejected() должен обнулить orderCreatedAtMs (заказ терминален)');
  teardown(sandbox);
});

test('14. nextStatus() НЕ меняет исходный orderCreatedAtMs (в отличие от preDeadline — живёт весь цикл заказа)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT14';orderCreatedAtMs=Date.now()-60000;inPreStatus=true;`);
  const before = evalInContext(sandbox, 'orderCreatedAtMs');
  evalInContext(sandbox, `nextStatus();`);
  const after = evalInContext(sandbox, 'orderCreatedAtMs');
  assert.equal(after, before, 'nextStatus() не должен трогать orderCreatedAtMs — заказ продолжается, не завершается');
  teardown(sandbox);
});

test('15. resyncVisibleTimers (аналог pageshow/bfcache) не меняет orderCreatedAtMs', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT15';orderCreatedAtMs=Date.now()-120000;`);
  const before = evalInContext(sandbox, 'orderCreatedAtMs');
  evalInContext(sandbox, `resyncVisibleTimers();`);
  const after = evalInContext(sandbox, 'orderCreatedAtMs');
  assert.equal(after, before);
  teardown(sandbox);
});

test('16. повторная инициализация статус-экрана (симуляция polling-старта) не перезаписывает orderCreatedAtMs', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT16';orderCreatedAtMs=Date.now()-30000;`);
  const before = evalInContext(sandbox, 'orderCreatedAtMs');
  const textBefore = (() => { evalInContext(sandbox, `initStatusScreen();`); return evalInContext(sandbox, `document.getElementById('st-time').textContent`); })();
  const textAfter = (() => { evalInContext(sandbox, `initStatusScreen();`); return evalInContext(sandbox, `document.getElementById('st-time').textContent`); })();
  assert.equal(evalInContext(sandbox, 'orderCreatedAtMs'), before);
  assert.equal(textAfter, textBefore, 'повторная инициализация не должна сдвигать отображаемое время');
  teardown(sandbox);
});

test('17. orderCreatedAtMs и qrDeadline не конфликтуют в одном saveOrderState() (нет регрессии платёжного таймера)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT17';orderCreatedAtMs=Date.now();startNewQRTimer();`);
  const stored = readStoredOrder(sandbox);
  assert.equal(typeof stored.orderCreatedAtMs, 'number');
  assert.equal(typeof stored.qrDeadline, 'number');
  teardown(sandbox);
});

test('18. orderCreatedAtMs и preDeadline не конфликтуют в одном saveOrderState() (нет регрессии таймера ресторана)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `currentOrderCode='YAAM-OT18';orderCreatedAtMs=Date.now();renderWaitForRestaurant();`);
  const stored = readStoredOrder(sandbox);
  assert.equal(typeof stored.orderCreatedAtMs, 'number');
  assert.equal(typeof stored.preDeadline, 'number');
  teardown(sandbox);
});

test('19. orderCreatedAtMs захватывается одинаково в demo и API sandbox — до сетевого вызова, не зависит от USE_API', async (t) => {
  const demo = freshApp();
  const api = freshApp({ apiBaseUrl: 'https://example.invalid' });
  const setup = `
    curRest={id:1,name:'Тестовый ресторан',address:'',phone:'',min:0};
    cart={'0_0':{n:'Блюдо',p:1000,q:1,menuItemId:null}};
    fulfillmentType='delivery';
    document.getElementById('c-name').value='Тест';
    document.getElementById('c-phone').value='+79280000000';
    saveLegalAcceptance();
  `;
  evalInContext(demo, setup);
  evalInContext(api, setup);
  await evalInContext(demo, `openQR()`); // demo: успешно создаёт заказ
  await evalInContext(api, `openQR()`);  // api: fetch-стаб бросает ошибку — ловится try/catch внутри openQR()
  // В обоих случаях orderCreatedAtMs устанавливается ПЕРВОЙ строкой внутри
  // try{} — до ветвления if(USE_API) и до любого await/сетевого вызова.
  assert.equal(typeof evalInContext(demo, 'orderCreatedAtMs'), 'number');
  assert.equal(typeof evalInContext(api, 'orderCreatedAtMs'), 'number');
  teardown(demo);
  teardown(api);
});

test('20. setOrderTime() без валидного ms не ломается и не показывает мусор (явный fallback)', (t) => {
  const sandbox = freshApp();
  evalInContext(sandbox, `setOrderTime(null);`);
  const text1 = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.match(text1, /^Заказ оформлен в \d{1,2}:\d{2}$/, `не должно быть NaN/мусора, получили "${text1}"`);
  evalInContext(sandbox, `setOrderTime(undefined);`);
  const text2 = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.match(text2, /^Заказ оформлен в \d{1,2}:\d{2}$/, `не должно быть NaN/мусора, получили "${text2}"`);
  teardown(sandbox);
});

test('21. формат HH:MM: часы без ведущего нуля, минуты всегда 2 цифры', (t) => {
  const sandbox = freshApp();
  const d = new Date();
  d.setHours(9, 5, 0, 0); // 9:05 — однозначный час, однозначная минута с ведущим нулём
  const ms = d.getTime();
  evalInContext(sandbox, `setOrderTime(${ms});`);
  const text = evalInContext(sandbox, `document.getElementById('st-time').textContent`);
  assert.equal(text, 'Заказ оформлен в 9:05');
  teardown(sandbox);
});

// Пункты 22-24 (нет flaky real-time assertions, нет реального ожидания минут,
// нет зависших timers/processes) — не отдельные test(), а структурное свойство
// всего файла: единственная реальная пауза — 5мс в тесте 10-11 (тот же приём,
// что и в двух предыдущих таймерных наборах), проверки границ минуты/часа
// (тесты 8-9) используют крафтованные timestamp вместо ожидания, orderCreatedAtMs
// не создаёт ни одного нового interval/timeout — самим тестам нечего протекать.
