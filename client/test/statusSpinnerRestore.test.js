// Stage 29.1, п.1 — регрессия для Stage 28 HIGH-1: "зависший спиннер при
// восстановлении заказа со статусом accepted/preparing/courier/delivered".
//
// Корень бага: initStatusScreen() (вызывается из startOrderPolling(), в том
// числе при restore на refresh/переоткрытии вкладки) всегда включает
// спиннер заново (showStatusSpinner(true)) — комментарий в самом коде
// объяснял это тем, что "реальный статус неизвестен до ответа сервера". Но
// showStatusSpinner(false) вызывался ТОЛЬКО в ветке awaiting_restaurant
// pollOrderOnce() — ветка для accepted/preparing/courier/delivered вызывала
// renderStatus() (которая сама спиннер не трогает) и ничего не снимала.
// В обычном непрерывном сеансе это было незаметно (спиннер уже снят на
// awaiting_restaurant и остаётся снятым для всех дальнейших статусов того
// же заказа) — баг проявлялся только когда ПЕРВЫЙ poll после restore уже
// приходил с более поздним статусом, что и происходит при закрытии/
// переоткрытии вкладки, пока заказ готовится или уже доставлен.
//
// Загружает РЕАЛЬНЫЙ client/js/app.js через node:vm (см. test/helpers/
// loadApp.js), тот же паттерн apiSandbox/baseOrder, что и
// serverTimestampParsing.test.js (Stage 27).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function apiSandbox(orderResponses) {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://example.invalid' });
  let call = 0;
  sandbox.fetch = async (url) => {
    // Тот же обходной манёвр, что и в serverTimestampParsing.test.js: app.js
    // на верхнем уровне безусловно вызывает renderList() (GET /api/restaurants)
    // до того, как тест успевает выставить currentOrderCode.
    if (String(url).includes('/api/orders/')) {
      const order = orderResponses[Math.min(call, orderResponses.length - 1)];
      call += 1;
      return { ok: true, status: 200, json: async () => order };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  loadAppInSandbox(sandbox);
  return sandbox;
}

function baseOrder(overrides) {
  return {
    status: 'awaiting_restaurant',
    status_updated_at: new Date().toISOString(),
    items_total: 400,
    rating: null,
    fulfillment_type: 'delivery',
    public_code: 'YAAM-SPIN1',
    restaurant_phone: null,
    preparation_deadline: null,
    refund_status: 'none',
    ...overrides,
  };
}

// Отслеживает аргументы каждого вызова showStatusSpinner — тот же приём,
// что и trackGoCalls() в orderStatusHardening.test.js (монки-патч вместо
// чтения classList/style, которые в этом fake DOM либо всегда false, либо
// write-only, см. helpers/loadApp.js).
function trackSpinnerCalls(sandbox) {
  evalInContext(sandbox, `
    let __spinnerCalls=[];
    const _origShowStatusSpinner=showStatusSpinner;
    showStatusSpinner=function(on){__spinnerCalls.push(on);return _origShowStatusSpinner(on);};
  `);
  return () => Array.from(evalInContext(sandbox, `__spinnerCalls`));
}

async function pollRestoredOrder(sandbox, code) {
  await evalInContext(sandbox, `(async()=>{
    currentOrderCode=${JSON.stringify(code)};
    currentOrderAccessToken='tkn';
    await pollOrderOnce();
  })()`);
}

for (const status of ['accepted', 'preparing', 'courier', 'delivered']) {
  test(`restore: первый poll после восстановления возвращает "${status}" — спиннер обязан скрыться`, async () => {
    const sandbox = apiSandbox([baseOrder({ status, public_code: `YAAM-SPIN-${status}` })]);
    const spinnerCalls = trackSpinnerCalls(sandbox);
    // initStatusScreen() (обычно вызывается из startOrderPolling() при
    // restore) — эмулируем именно её эффект: спиннер включён ДО первого
    // ответа сервера, тем же кодом, что и в реальном restore-пути.
    evalInContext(sandbox, `showStatusSpinner(true);`);
    await pollRestoredOrder(sandbox, `YAAM-SPIN-${status}`);

    const calls = spinnerCalls();
    assert.ok(calls.includes(false), `showStatusSpinner(false) обязан был вызваться для статуса "${status}" (получены вызовы: ${JSON.stringify(calls)})`);
    // Последний вызов должен быть false — контент обязан остаться видимым,
    // не перезаписан обратно на "on" каким-то более поздним кодом того же тика.
    assert.equal(calls[calls.length - 1], false);
    teardown(sandbox);
  });
}

test('restore: delivered без ранее выставленной оценки показывает форму рейтинга (не завис на спиннере)', async () => {
  const sandbox = apiSandbox([baseOrder({ status: 'delivered', rating: null })]);
  evalInContext(sandbox, `showStatusSpinner(true);`);
  await pollRestoredOrder(sandbox, 'YAAM-SPIN1');
  const ratingHtml = evalInContext(sandbox, `document.getElementById('st-rating-wrap').innerHTML`);
  assert.match(ratingHtml, /rating-star|rating-wrap/, 'ожидали виджет оценки в #st-rating-wrap после восстановления доставленного заказа');
  teardown(sandbox);
});

test('regression: awaiting_payment и awaiting_restaurant по-прежнему корректно скрывают спиннер (не сломано этим фиксом)', async () => {
  const awaitingPayment = apiSandbox([baseOrder({ status: 'awaiting_payment' })]);
  const spinnerCallsAP = trackSpinnerCalls(awaitingPayment);
  evalInContext(awaitingPayment, `showStatusSpinner(true);`);
  await pollRestoredOrder(awaitingPayment, 'YAAM-SPIN1');
  assert.ok(spinnerCallsAP().includes(false), 'awaiting_payment: спиннер тоже обязан скрыться (renderAwaitingPayment)');
  teardown(awaitingPayment);

  const awaitingRestaurant = apiSandbox([baseOrder({ status: 'awaiting_restaurant' })]);
  const spinnerCallsAR = trackSpinnerCalls(awaitingRestaurant);
  evalInContext(awaitingRestaurant, `showStatusSpinner(true);`);
  await pollRestoredOrder(awaitingRestaurant, 'YAAM-SPIN1');
  assert.ok(spinnerCallsAR().includes(false), 'awaiting_restaurant: уже работало до фикса — не должно было сломаться');
  teardown(awaitingRestaurant);
});
