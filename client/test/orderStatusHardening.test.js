// FINAL ORDER STATE MACHINE HARDENING — Findings 3–5 (frontend часть).
// Загружает реальный client/js/app.js через node:vm (см. test/helpers/loadApp.js),
// тот же established-паттерн, что и остальные frontend-тесты этого проекта —
// мокаются api.createOrder/api.getOrder напрямую, а не сырой fetch.
//
// Ограничения тестового fake DOM (см. test/helpers/loadApp.js), важные для
// чтения этого файла: classList.contains() всегда возвращает false (нельзя
// проверить активность экрана через cur('id') — вместо этого монки-патчим
// go() и смотрим, с каким id его вызвали), а style — write-only Proxy (запись
// принимается, но чтение всегда возвращает '' — вместо style.display
// проверяем содержимое .innerHTML, которое ведёт себя как обычное свойство).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

function trackGoCalls(sandbox) {
  evalInContext(sandbox, `
    let __goCalls=[];
    const _origGo=go;
    go=function(id){__goCalls.push(id);return _origGo(id);};
  `);
  // evalInContext возвращает объект из ДРУГОГО vm-реалма — у него другой Array
  // (другой [[Prototype]]), поэтому assert.deepEqual/strict считает его "не
  // reference-equal" даже при совпадении значений. Array.from() в НАШЕМ
  // (внешнем) реалме создаёт обычный нативный массив с теми же примитивами.
  return () => Array.from(evalInContext(sandbox, `__goCalls`));
}

function setupCheckoutForm(sandbox, code) {
  evalInContext(sandbox, `
    validateCheckout=()=>true;
    validateLegalConsent=()=>true;
    curRest={id:1,name:'Ресторан',address:'Адрес'};
    cart={'0_0':{n:'Блюдо',p:300,q:1,menuItemId:7}};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='Адрес клиента';
    document.getElementById('c-comment').value='';
    api.createOrder=async()=>({
      order:{public_code:${JSON.stringify(code)},status:'awaiting_payment',items_total:300,refund_status:'none'},
      payment:{paymentUrl:null,qrPayload:'demo'},
    });
  `);
}

// ---------- FIX 5: polling нового заказа на QR-экране ----------

test('FIX5: polling стартует сразу после создания нового заказа — заказ не остаётся немым на #qr', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const goCalls = trackGoCalls(sandbox);
  setupCheckoutForm(sandbox, 'YAAM-05001');
  evalInContext(sandbox, `
    let getOrderCalls=0;
    api.getOrder=async()=>{getOrderCalls+=1;return{public_code:'YAAM-05001',status:'awaiting_payment',items_total:300,refund_status:'none'};};
  `);
  await evalInContext(sandbox, `openQR()`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(evalInContext(sandbox, `orderPollTimer`), null, 'orderPollTimer должен быть установлен сразу после создания заказа');
  assert.ok(evalInContext(sandbox, `getOrderCalls`) >= 1, 'первый poll обязан уйти немедленно, не дожидаясь POLL_INTERVAL_MS');
  assert.deepEqual(goCalls(), ['qr'], 'пока статус ещё awaiting_payment, навигация не должна была уйти дальше QR-экрана');
  teardown(sandbox);
});

test('FIX5: demo-режим (нет backend) не запускает polling на QR-экране', async () => {
  const sandbox = freshApp(); // без apiBaseUrl — USE_API=false
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
  await evalInContext(sandbox, `openQR()`);
  assert.equal(evalInContext(sandbox, `orderPollTimer`), null, 'demo-режим не должен стучаться в несуществующий backend');
  teardown(sandbox);
});

test('FIX5: повторный вызов startOrderPollingQuiet() не оставляет второй параллельный interval', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const realClearInterval = sandbox.clearInterval;
  const clearedIds = [];
  sandbox.clearInterval = (id) => { clearedIds.push(id); return realClearInterval(id); };
  evalInContext(sandbox, `
    currentOrderCode='YAAM-05002';
    currentOrderAccessToken='yaam_ord_v1_${'a'.repeat(43)}';
    api.getOrder=async()=>({public_code:'YAAM-05002',status:'awaiting_payment',items_total:300,refund_status:'none'});
  `);
  evalInContext(sandbox, `startOrderPollingQuiet()`);
  const firstTimer = evalInContext(sandbox, `orderPollTimer`);
  evalInContext(sandbox, `startOrderPollingQuiet()`);
  const secondTimer = evalInContext(sandbox, `orderPollTimer`);
  assert.notEqual(firstTimer, secondTimer, 'второй вызов обязан завести новый interval взамен, а не вдобавок');
  assert.ok(clearedIds.includes(firstTimer), 'первый interval обязан быть явно очищен до создания второго — иначе оба тикали бы параллельно');
  teardown(sandbox);
});

test('FIX5: оплата, обнаруженная поллингом (второе устройство/будущий webhook), переводит экран с #qr на #status без refresh', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const goCalls = trackGoCalls(sandbox);
  setupCheckoutForm(sandbox, 'YAAM-05003');
  evalInContext(sandbox, `
    let serverStatus='awaiting_payment';
    api.getOrder=async()=>({public_code:'YAAM-05003',status:serverStatus,items_total:300,restaurant_phone:'',status_updated_at:new Date().toISOString(),refund_status:'none'});
  `);
  await evalInContext(sandbox, `openQR()`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(goCalls(), ['qr']);

  // "Оплата с другого устройства" — сервер меняет статус независимо от этой вкладки.
  evalInContext(sandbox, `serverStatus='awaiting_restaurant';`);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.deepEqual(goCalls(), ['qr', 'status'], 'обнаружив оплату поллингом, клиент обязан показать актуальный экран без ручного refresh');
  // Review 2 (Frontend polling/UX), MEDIUM: тихий переход раньше вызывал
  // только go('status') без initStatusScreen() — #st-items оставался пустым
  // до ручного refresh. initStatusScreen() — единственное место, которое
  // заполняет #st-items.innerHTML строками заказа.
  assert.notEqual(
    sandbox.document.getElementById('st-items').innerHTML, '',
    'тихий переход #qr -> #status обязан вызвать initStatusScreen() и заполнить строки заказа, а не оставлять экран пустым до refresh',
  );
  teardown(sandbox);
});

test('FIX5: resetAll() останавливает polling', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-05004';
    currentOrderAccessToken='yaam_ord_v1_${'b'.repeat(43)}';
    api.getOrder=async()=>({public_code:'YAAM-05004',status:'awaiting_payment',items_total:300,refund_status:'none'});
    startOrderPollingQuiet();
  `);
  assert.notEqual(evalInContext(sandbox, `orderPollTimer`), null);
  evalInContext(sandbox, `resetAll()`);
  assert.equal(evalInContext(sandbox, `orderPollTimer`), null);
  teardown(sandbox);
});

test('FIX5: restore после refresh (tryRestoreSession) не создаёт второй interval поверх уже идущего', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${'c'.repeat(43)}`;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-05005', orderAccessToken: token, orderCreatedAtMs: Date.now(),
  }));
  const realClearInterval = sandbox.clearInterval;
  const clearedIds = [];
  sandbox.clearInterval = (id) => { clearedIds.push(id); return realClearInterval(id); };
  evalInContext(sandbox, `
    api.getRestaurant=async()=>({id:1,name:'R',menu:[],cities:[]});
    api.getOrder=async()=>({public_code:'YAAM-05005',status:'awaiting_restaurant',items_total:300,refund_status:'none',status_updated_at:new Date().toISOString()});
  `);
  await evalInContext(sandbox, `tryRestoreSession()`);
  const afterRestore = evalInContext(sandbox, `orderPollTimer`);
  assert.notEqual(afterRestore, null);
  // Повторный restore (двойной вызов, второй refresh подряд) обязан заменить
  // interval, а не запустить второй тикающий рядом со старым.
  await evalInContext(sandbox, `tryRestoreSession()`);
  const afterSecondRestore = evalInContext(sandbox, `orderPollTimer`);
  assert.ok(clearedIds.includes(afterRestore), 'повторный restore обязан очистить предыдущий interval');
  assert.notEqual(afterSecondRestore, afterRestore);
  teardown(sandbox);
});

// ---------- FIX 3: fallback для неизвестного order.status ----------

test('FIX3: неизвестный order.status не отменяет заказ и не чистит credentials', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${'d'.repeat(43)}`;
  evalInContext(sandbox, `
    currentOrderCode='YAAM-03001';
    currentOrderAccessToken=${JSON.stringify(token)};
    currentOrderAmount=300;
    api.getOrder=async()=>({public_code:'YAAM-03001',status:'totally_unknown_future_status',items_total:300,refund_status:'none'});
    api.cancelOrder=async()=>{throw new Error('cancelOrder НЕ должен вызываться сам по себе на неизвестном статусе');};
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);

  assert.equal(evalInContext(sandbox, `currentOrderCode`), 'YAAM-03001', 'credentials не должны быть очищены');
  assert.equal(evalInContext(sandbox, `currentOrderAccessToken`), token);
  teardown(sandbox);
});

test('FIX3: неизвестный статус не останавливает polling', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-03002b';
    currentOrderAccessToken='yaam_ord_v1_${'e'.repeat(43)}';
    api.getOrder=async()=>({public_code:'YAAM-03002b',status:'still_unknown',items_total:300,refund_status:'none'});
    startOrderPollingQuiet();
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.notEqual(evalInContext(sandbox, `orderPollTimer`), null, 'неизвестный статус не должен прерывать polling — сервер может исправиться на следующем тике');
  teardown(sandbox);
});

test('FIX3: тост про неизвестный статус не спамится на каждом тике, пока статус не изменится', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-03002';
    currentOrderAccessToken='yaam_ord_v1_${'e'.repeat(43)}';
    api.getOrder=async()=>({public_code:'YAAM-03002',status:'still_unknown',items_total:300,refund_status:'none'});
    let unknownStatusToasts=0;
    const _origShowToast=showToast;
    // Считаем ТОЛЬКО наше собственное сообщение о неизвестном статусе — сама
    // sandbox-среда не мокает api.getRestaurants(), и фоновая renderList()
    // из другого места приложения может независимо показать свой toast; это
    // не должно засорять счётчик именно этого сценария.
    showToast=function(msg){if(msg.includes('Статус заказа временно недоступен'))unknownStatusToasts+=1;return _origShowToast(msg);};
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  await evalInContext(sandbox, `pollOrderOnce()`);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.equal(evalInContext(sandbox, `unknownStatusToasts`), 1, 'тост не должен спамиться на каждом тике, пока статус остаётся тем же нераспознанным значением');
  teardown(sandbox);
});

test('FIX3: неизвестный статус не показывает пользователю сырое значение', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-03003';
    currentOrderAccessToken='yaam_ord_v1_${'f'.repeat(43)}';
    api.getOrder=async()=>({public_code:'YAAM-03003',status:'super_secret_internal_code_zzz',items_total:300,refund_status:'none'});
    let shownMessages=[];
    const _origShowToast=showToast;
    showToast=function(msg){shownMessages.push(msg);return _origShowToast(msg);};
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  const shown = evalInContext(sandbox, `shownMessages`);
  assert.ok(shown.length >= 1);
  for (const msg of shown) assert.equal(msg.includes('super_secret_internal_code_zzz'), false, 'внутреннее значение статуса не должно попасть в текст, видимый пользователю');
  assert.ok(shown.some((msg) => /Статус заказа временно недоступен/.test(msg)));
  teardown(sandbox);
});

// ---------- FIX 4: реальный refund_status в UI ----------

test('FIX4: refundStatusMessage — все четыре публичных состояния', () => {
  const sandbox = freshApp();
  assert.equal(evalInContext(sandbox, `refundStatusMessage('none', 300)`), null);
  assert.match(evalInContext(sandbox, `refundStatusMessage('processing', 300)`), /обрабатывается/);
  assert.match(evalInContext(sandbox, `refundStatusMessage('done', 300)`), /подтверждён/);
  assert.match(evalInContext(sandbox, `refundStatusMessage('failed', 300)`), /Обратитесь в поддержку YAAM/);
  teardown(sandbox);
});

test('FIX4: refundStatusMessage никогда не содержит внутренние поля/технические данные', () => {
  const sandbox = freshApp();
  for (const status of ['processing', 'done', 'failed']) {
    const msg = evalInContext(sandbox, `refundStatusMessage(${JSON.stringify(status)}, 1430)`);
    assert.equal(msg.includes('provider_refund_id'), false);
    assert.equal(msg.includes('provider_idempotency_key'), false);
  }
  teardown(sandbox);
});

test('FIX4: order.refund_status="processing" — экран открыт, но polling и credentials остаются активными', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const goCalls = trackGoCalls(sandbox);
  const token = `yaam_ord_v1_${'1'.repeat(43)}`;
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04001';
    currentOrderAccessToken=${JSON.stringify(token)};
    currentOrderAmount=1430;
    api.getOrder=async()=>({public_code:'YAAM-04001',status:'cancelled',items_total:1430,refund_status:'processing'});
    // В реальном сценарии polling уже идёт (заказ был awaiting_restaurant,
    // потом стал cancelled) — симулируем уже активный interval, не запуская
    // отдельный реальный pollOrderOnce() (гонка с тем, что тестируем ниже).
    orderPollTimer=setInterval(()=>{},60000);
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.deepEqual(goCalls(), ['rejected']);
  assert.match(sandbox.document.getElementById('rej-refund-line').innerHTML, /обрабатывается/);
  assert.notEqual(evalInContext(sandbox, `currentOrderCode`), null, 'пока возврат не done/failed, credentials не должны быть очищены — нужны для дальнейшего polling');
  assert.notEqual(evalInContext(sandbox, `orderPollTimer`), null, 'polling должен продолжаться, пока refund_status не станет терминальным');
  teardown(sandbox);
});

test('FIX4/Review2-Critical: клик по единственной кнопке экрана #rejected во время refund_status="processing" не глушит polling и не стирает credentials', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const token = `yaam_ord_v1_${'9'.repeat(43)}`;
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04006';
    currentOrderAccessToken=${JSON.stringify(token)};
    currentOrderAmount=1430;
    api.getOrder=async()=>({public_code:'YAAM-04006',status:'cancelled',items_total:1430,refund_status:'processing'});
    orderPollTimer=setInterval(()=>{},60000);
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);

  // Кнопка обязана быть отключена и лишена обработчика, пока возврат не
  // терминален — это и есть сама защита от Critical-дефекта (раньше кнопка
  // была безусловно привязана к resetAll()). btn.onclick===null означает,
  // что реальный тап пользователя физически не может ничего вызвать.
  const btnState = evalInContext(sandbox, `({
    disabled: document.getElementById('rej-action-btn').disabled,
    hasHandler: document.getElementById('rej-action-btn').onclick !== null,
    text: document.getElementById('rej-action-btn').textContent,
  })`);
  assert.equal(btnState.disabled, true, 'кнопка должна быть отключена, пока возврат ещё processing');
  assert.equal(btnState.hasHandler, false, 'у кнопки не должно быть onclick, пока возврат ещё processing — иначе тап может вызвать resetAll()');
  assert.match(btnState.text, /обрабатывается/);

  // Явная попытка вызвать resetAll() напрямую (симулирует то, что раньше
  // происходило по тапу) — если бы кнопка была неверно сконфигурирована,
  // это стёрло бы credentials/остановило polling; здесь проверяем, что сам
  // код кнопки (onclick=null) не мог инициировать этот вызов.
  assert.equal(evalInContext(sandbox, `document.getElementById('rej-action-btn').onclick`), null);
  assert.notEqual(evalInContext(sandbox, `currentOrderCode`), null, 'credentials обязаны остаться нетронутыми');
  assert.notEqual(evalInContext(sandbox, `currentOrderAccessToken`), null);
  assert.notEqual(evalInContext(sandbox, `orderPollTimer`), null, 'polling обязан продолжаться');
  teardown(sandbox);
});

test('FIX4/Review2-Critical: после того как refund_status становится терминальным, кнопка снова включается и ведёт на resetAll()', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04007';
    currentOrderAccessToken='yaam_ord_v1_${'8'.repeat(43)}';
    currentOrderAmount=1430;
    let serverRefundStatus='processing';
    api.getOrder=async()=>({public_code:'YAAM-04007',status:'cancelled',items_total:1430,refund_status:serverRefundStatus});
    orderPollTimer=setInterval(()=>{},60000);
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.equal(evalInContext(sandbox, `document.getElementById('rej-action-btn').disabled`), true);

  // Тот же самый открытый экран, тот же заказ — возврат наконец завершился.
  evalInContext(sandbox, `serverRefundStatus='done';`);
  await evalInContext(sandbox, `pollOrderOnce()`);
  const btnState = evalInContext(sandbox, `({
    disabled: document.getElementById('rej-action-btn').disabled,
    hasHandler: document.getElementById('rej-action-btn').onclick === resetAll,
    text: document.getElementById('rej-action-btn').textContent,
  })`);
  assert.equal(btnState.disabled, false, 'после done кнопка обязана снова стать активной');
  assert.equal(btnState.hasHandler, true, 'после done кнопка обязана вести на resetAll() — выбрать другой ресторан');
  assert.equal(btnState.text, 'Выбрать другой ресторан');
  teardown(sandbox);
});

test('FIX4: order.refund_status="done" — экран открыт, polling и credentials корректно останавливаются', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const goCalls = trackGoCalls(sandbox);
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04002';
    currentOrderAccessToken='yaam_ord_v1_${'2'.repeat(43)}';
    currentOrderAmount=1430;
    api.getOrder=async()=>({public_code:'YAAM-04002',status:'declined',items_total:1430,refund_status:'done'});
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.deepEqual(goCalls(), ['rejected']);
  assert.match(sandbox.document.getElementById('rej-refund-line').innerHTML, /подтверждён/);
  assert.equal(evalInContext(sandbox, `currentOrderCode`), null, 'возврат подтверждён — терминально, возвращаться некуда, credentials можно очищать');
  assert.equal(evalInContext(sandbox, `orderPollTimer`), null);
  teardown(sandbox);
});

test('FIX4: order.refund_status="failed" — явно сообщаем об обращении в поддержку, а не "деньги уже отправлены"', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04003';
    currentOrderAccessToken='yaam_ord_v1_${'3'.repeat(43)}';
    currentOrderAmount=1430;
    api.getOrder=async()=>({public_code:'YAAM-04003',status:'timed_out',items_total:1430,refund_status:'failed'});
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  const html = sandbox.document.getElementById('rej-refund-line').innerHTML;
  assert.match(html, /Обратитесь в поддержку YAAM/);
  assert.equal(html.includes('уже отправлена'), false, 'при failed нельзя утверждать, что деньги уже отправлены');
  assert.equal(evalInContext(sandbox, `orderPollTimer`), null, 'failed — терминальное состояние возврата, polling останавливается');
  teardown(sandbox);
});

test('FIX4: order.refund_status="none" (неоплаченный заказ) — без утверждения о возврате, как и раньше', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04004';
    currentOrderAccessToken='yaam_ord_v1_${'4'.repeat(43)}';
    currentOrderAmount=null;
    api.getOrder=async()=>({public_code:'YAAM-04004',status:'declined',items_total:0,refund_status:'none'});
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.equal(sandbox.document.getElementById('rej-refund-line').innerHTML, '', 'refund_status=none — строка возврата не должна получить никакого текста');
  teardown(sandbox);
});

test('FIX4: клиент не может сам поменять order.status через refund_status — статус берётся только с сервера', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-04005';
    currentOrderAccessToken='yaam_ord_v1_${'5'.repeat(43)}';
    currentOrderAmount=300;
    api.getOrder=async()=>({public_code:'YAAM-04005',status:'awaiting_restaurant',items_total:300,refund_status:'processing',status_updated_at:new Date().toISOString()});
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  // refund_status тут "processing" (гипотетически некорректная от сервера
  // комбинация), но клиент обязан рендерить именно order.status как есть —
  // никакой ветки, где refund_status сам по себе меняет статус заказа, нет.
  assert.equal(evalInContext(sandbox, `lastKnownOrder.status`), 'awaiting_restaurant');
  teardown(sandbox);
});
