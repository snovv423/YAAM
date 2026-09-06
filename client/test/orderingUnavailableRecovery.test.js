'use strict';

// PRE-YOOKASSA CLEANUP, п.1 — детерминированный отказ сервера больше не
// притворяется неизвестным исходом.
//
// Что было на production. PAYMENT_PROVIDER=disabled, POST /api/orders отдаёт
// 503 {"error":"Оформление заказов временно недоступно"}. Клиент считал любой
// 5xx «неизвестным исходом»: pending-capability оставалась помеченной
// submitted, и пользователь попадал на экран «Проверяем созданный заказ» с
// единственной кнопкой «Проверить снова». Кнопка била в /api/orders/recover —
// закрытый ТЕМ ЖЕ гейтом и отвечающий ТЕМ ЖЕ 503. Состояние лежало в
// localStorage и переживало reload: сайт открывался на экране ошибки и
// становился недоступен целиком, пока пользователь не очистит данные сайта
// вручную.
//
// Различает эти два случая только машиночитаемый код: гейт
// requirePaymentProviderEnabled (server/routes/postgresql/api.js) стоит ДО
// любой записи orderService, поэтому заказа заведомо нет. 503 от
// промежуточного слоя такого кода не несёт и по-прежнему уходит в recovery.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const PENDING_KEY = 'yaam_pending_order_credentials';

function freshApp() {
  const { sandbox, store } = createSandbox({ apiBaseUrl: 'https://api.example.invalid' });
  loadAppInSandbox(sandbox);
  return { sandbox, store };
}

// Готовит реальный чекаут: корзина, поля, ресторан. Дальше тест подменяет
// только сетевой слой (api.createOrder / api.recoverOrder), а весь путь идёт
// через настоящий openQR().
function primeCheckout(sandbox) {
  evalInContext(sandbox, `
    validateLegalConsent=()=>true;
    curRest={id:1,name:'Ресторан',address:'ул. Ресторанная, 1',phone:'+79280000000',deliv:0,min:0};
    selectedCity='Аргун';
    fulfillmentType='delivery';
    cart={'0_0':{n:'Блюдо',p:500,q:1,menuItemId:7}};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='ул. Тестовая, 1';
    document.getElementById('c-comment').value='';
  `);
}

function orderingUnavailableError(sandbox) {
  return evalInContext(sandbox, `
    api.createOrder=async()=>{
      const err=new Error('Оформление заказов временно недоступно');
      err.status=503; err.code='ORDERING_UNAVAILABLE';
      throw err;
    };
    api.recoverOrder=async()=>{
      const err=new Error('Оформление заказов временно недоступно');
      err.status=503; err.code='ORDERING_UNAVAILABLE';
      throw err;
    };
  `);
}

// Куда приложение реально ушло. Читаем историю, а не класс .active: go() снимает
// класс через document.querySelectorAll('.screen'), которого фейковый DOM не
// поддерживает, поэтому старые экраны остались бы «активными» навсегда.
// history.pushState/replaceState в этом стабе записываются честно (см.
// helpers/loadApp.js), и последняя запись — это и есть текущий экран.
function currentScreen(sandbox) {
  const entries = sandbox.history.entries;
  if (!entries.length) return null;
  return entries[entries.length - 1].state.screen;
}

test('1. ORDERING_UNAVAILABLE не создаёт pending recovery state', async () => {
  const { sandbox, store } = freshApp();
  primeCheckout(sandbox);
  orderingUnavailableError(sandbox);

  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store[PENDING_KEY], undefined,
    'ложные pending-credentials не должны оставаться: заказа заведомо нет');
  teardown(sandbox);
});

test('2. ORDERING_UNAVAILABLE не уводит на экран восстановления — пользователь остаётся в чекауте', async () => {
  const { sandbox } = freshApp();
  primeCheckout(sandbox);
  evalInContext(sandbox, "go('cart');");
  orderingUnavailableError(sandbox);

  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(currentScreen(sandbox), 'cart',
    'экран не должен меняться: отказ однозначен, проверять нечего');
  assert.notEqual(sandbox.document.getElementById('rej-title').textContent, 'Проверяем созданный заказ');
  teardown(sandbox);
});

test('3. пользователь видит нормальное сообщение об ошибке', async () => {
  const { sandbox } = freshApp();
  primeCheckout(sandbox);
  orderingUnavailableError(sandbox);

  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  const toast = sandbox.document.getElementById('toast');
  assert.match(toast.textContent, /Оформление заказов временно недоступно/);
  teardown(sandbox);
});

test('4. после отказа можно вернуться к меню и повторить попытку позже', async () => {
  const { sandbox, store } = freshApp();
  primeCheckout(sandbox);
  evalInContext(sandbox, "go('cart');");
  orderingUnavailableError(sandbox);

  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  // Навигация жива: корзина/меню доступны, приложение не заперто.
  evalInContext(sandbox, 'backToMenu()');
  assert.equal(currentScreen(sandbox), 'menu');
  evalInContext(sandbox, 'openCart()');
  assert.equal(currentScreen(sandbox), 'cart');

  // Повторная попытка, когда приём заказов включили обратно, проходит как
  // обычное создание — не как восстановление несуществующей предыдущей.
  const seen = [];
  evalInContext(sandbox, `
    api.createOrder=async(payload,token,key)=>{
      __seenCreate=true;
      return {order:{public_code:'YAAM-00042',status:'awaiting_payment',items_total:500,refund_status:'none'},
              payment:{paymentUrl:null,qrPayload:'x',paymentExpiresAt:new Date(Date.now()+600000).toISOString()}};
    };
    api.recoverOrder=async()=>{ __seenRecover=true; throw new Error('recover не должен вызываться'); };
    var __seenCreate=false, __seenRecover=false;
  `);
  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(evalInContext(sandbox, '__seenRecover'), false,
    'recover не нужен: предыдущая попытка была однозначно отклонена');
  assert.equal(evalInContext(sandbox, 'currentOrderCode'), 'YAAM-00042');
  seen.push(store[PENDING_KEY]);
  teardown(sandbox);
});

test('5. регрессия: неизвестный исход (сеть/5xx без кода) по-прежнему идёт через recovery', async () => {
  const { sandbox, store } = freshApp();
  primeCheckout(sandbox);
  evalInContext(sandbox, `
    api.createOrder=async()=>{ const err=new Error('Сервис недоступен'); err.status=502; throw err; };
  `);

  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(store[PENDING_KEY], 'capability обязана сохраниться: судьба POST неизвестна');
  assert.ok(JSON.parse(store[PENDING_KEY]).submittedAt, 'попытка помечена как отправленная');
  assert.equal(sandbox.document.getElementById('rej-title').textContent, 'Проверяем созданный заказ');
  assert.equal(currentScreen(sandbox), 'rejected');
  teardown(sandbox);
});

test('6. регрессия: 4xx по-прежнему закрывает capability и не открывает recovery', async () => {
  const { sandbox, store } = freshApp();
  primeCheckout(sandbox);
  evalInContext(sandbox, `
    api.createOrder=async()=>{ const err=new Error('ресторан сейчас закрыт — заказ невозможен'); err.status=400; throw err; };
  `);

  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store[PENDING_KEY], undefined);
  assert.notEqual(sandbox.document.getElementById('rej-title').textContent, 'Проверяем созданный заказ');
  teardown(sandbox);
});

test('7. экран восстановления перестал быть тупиком: с него есть выход', async () => {
  const { sandbox, store } = freshApp();
  primeCheckout(sandbox);
  evalInContext(sandbox, `
    api.createOrder=async()=>{ const err=new Error('Сервис недоступен'); err.status=502; throw err; };
  `);
  await evalInContext(sandbox, 'openQR()');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(currentScreen(sandbox), 'rejected');
  assert.equal(sandbox.document.getElementById('rej-leave-wrap').style.display, 'block',
    'после неудачной проверки выход обязан быть виден');

  evalInContext(sandbox, 'leaveInitialOrderRecovery()');
  assert.equal(currentScreen(sandbox), 'home', 'пользователь возвращается на рабочий сайт');
  assert.ok(store[PENDING_KEY],
    'capability при этом сохраняется — заказ мог быть создан, следующая попытка начнётся с recover');
  teardown(sandbox);
});

test('8. пока проверка идёт, выхода нет — уходить некуда, результат вот-вот придёт', () => {
  const { sandbox } = freshApp();
  evalInContext(sandbox, 'showInitialOrderRecoveryPending(true)');
  assert.equal(sandbox.document.getElementById('rej-leave-wrap').style.display, 'none');
  evalInContext(sandbox, 'showInitialOrderRecoveryPending(false)');
  assert.equal(sandbox.document.getElementById('rej-leave-wrap').style.display, 'block');
  teardown(sandbox);
});

test('9. восстановление при закрытом гейте отдаёт рабочий сайт, а не вечный экран проверки', async () => {
  const { sandbox, store } = freshApp();
  // Capability, оставшаяся от прошлой попытки (например, до отключения приёма).
  evalInContext(sandbox, `
    api.recoverOrder=async()=>{
      const err=new Error('Оформление заказов временно недоступно');
      err.status=503; err.code='ORDERING_UNAVAILABLE';
      throw err;
    };
    createOrderLockDepth=1;
    savePendingOrderCredentials(pendingOrderCredentials());
    markPendingOrderSubmitted(readPendingOrderCredentials());
    createOrderLockDepth=0;
  `);
  evalInContext(sandbox, `
    createOrderLockDepth=1;
    savePendingOrderCredentials({...readPendingOrderCredentials(),submittedAt:Date.now()});
    createOrderLockDepth=0;
  `);

  const handled = await evalInContext(sandbox, 'recoverPendingInitialOrder({showFailure:true})');

  assert.equal(handled, false, 'приложение обязано отдать управление обычному сайту');
  assert.notEqual(currentScreen(sandbox), 'rejected');
  assert.ok(store[PENDING_KEY],
    'capability сохраняется: гейт не доказывает отсутствие заказа, он лишь не даёт проверить');
  assert.match(sandbox.document.getElementById('toast').textContent,
    /Оформление заказов временно недоступно/);
  teardown(sandbox);
});

test('10. код отказа доезжает из тела ответа в err.code (контракт api.js)', async () => {
  const { sandbox } = freshApp();
  sandbox.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'Оформление заказов временно недоступно', code: 'ORDERING_UNAVAILABLE' }),
  });
  const err = await evalInContext(sandbox, `
    (async()=>{ try{ await api.getRestaurants('Аргун'); }catch(e){ return {status:e.status,code:e.code,message:e.message}; } })()
  `);
  assert.equal(err.status, 503);
  assert.equal(err.code, 'ORDERING_UNAVAILABLE');
  assert.equal(err.message, 'Оформление заказов временно недоступно');
  teardown(sandbox);
});
