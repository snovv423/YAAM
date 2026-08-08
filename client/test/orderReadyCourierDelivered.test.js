// Stage 33 — «чистая логика заказа: Готово -> ждём курьера -> передан ->
// получен клиентом» (клиентская часть). Тот же vm-sandbox harness, что и
// остальные test/*.test.js (см. helpers/loadApp.js): реальный
// client/js/app.js в изолированном контексте, api.getOrder/api.
// confirmOrderReceipt мокаются напрямую (тот же приём, что и в
// orderStatusHardening.test.js/orderShareLink.test.js), не сырой fetch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

function accessToken(byte) {
  return `yaam_ord_v1_${Buffer.alloc(32, byte).toString('base64url')}`;
}

async function pollWithOrder(sandbox, code, token, order) {
  evalInContext(sandbox, `
    currentOrderCode=${JSON.stringify(code)};
    currentOrderAccessToken=${JSON.stringify(token)};
    initStatusScreen();
    api.getOrder=async()=>(${JSON.stringify(order)});
  `);
  await evalInContext(sandbox, 'pollOrderOnce()');
}

// ---------------------------------------------------------------------------
// 1-3. Рендер шага "ready" — раздел 4.2
// ---------------------------------------------------------------------------

test('ready: статус-текст "Готов", подтекст "Ожидаем курьера.", кнопка «Заказ получен» скрыта', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await pollWithOrder(sandbox, 'YAAM-33001', accessToken(1), {
    public_code: 'YAAM-33001', status: 'ready', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-state').textContent, 'Готов');
  assert.equal(sandbox.document.getElementById('st-substate').textContent, 'Ожидаем курьера.');
  assert.equal(sandbox.document.getElementById('st-substate').style.display, 'block');
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'none');
  assert.notEqual(sandbox.document.getElementById('st-state').textContent, 'В пути', 'ready — НЕ "заказ в пути" (задание, раздел 4.2)');
  teardown(sandbox);
});

test('ready: НЕ показывает кнопку подтверждения получения (ещё рано — курьер не забрал)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await pollWithOrder(sandbox, 'YAAM-33002', accessToken(2), {
    public_code: 'YAAM-33002', status: 'ready', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'none');
  teardown(sandbox);
});

test('ready: заказ остаётся "оплачен и в работе" (точка статуса включена)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await pollWithOrder(sandbox, 'YAAM-33003', accessToken(3), {
    public_code: 'YAAM-33003', status: 'ready', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('orderdot').classList.contains('on'), true);
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// 4-6. Рендер шага "courier" — раздел 4.3
// ---------------------------------------------------------------------------

test('courier: статус-текст "В пути", подтекст "Курьер забрал заказ из ресторана.", кнопка «Заказ получен» видна', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await pollWithOrder(sandbox, 'YAAM-33004', accessToken(4), {
    public_code: 'YAAM-33004', status: 'courier', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-state').textContent, 'В пути');
  assert.equal(sandbox.document.getElementById('st-substate').textContent, 'Курьер забрал заказ из ресторана.');
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'block');
  teardown(sandbox);
});

test('courier: кнопка «Заказ получен» корректно восстанавливается после hard reload/нового poll (источник истины — сервер)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const code = 'YAAM-33006';
  const token = accessToken(6);
  // Первый "холодный" рендер — как будто вкладка только что открыта заново
  // (initStatusScreen сбрасывает локальное состояние), сервер сразу отдаёт
  // courier — тот же сценарий, что hard reload на другом устройстве.
  await pollWithOrder(sandbox, code, token, {
    public_code: code, status: 'courier', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'block');
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// 7. Переход courier -> delivered прячет кнопку и открывает рейтинг
// ---------------------------------------------------------------------------

test('delivered (после courier): кнопка «Заказ получен» скрывается, появляется форма оценки', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const code = 'YAAM-33007';
  const token = accessToken(7);
  await pollWithOrder(sandbox, code, token, {
    public_code: code, status: 'courier', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'block');

  await pollWithOrder(sandbox, code, token, {
    public_code: code, status: 'delivered', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'none');
  assert.equal(sandbox.document.getElementById('st-final').style.display, 'block');
  assert.match(sandbox.document.getElementById('st-rating-wrap').innerHTML, /rating-stars/);
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// 8-10. confirmOrderReceipt()
// ---------------------------------------------------------------------------

test('confirmOrderReceipt(): вызывает api.confirmOrderReceipt с текущим кодом/токеном', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const code = 'YAAM-33008';
  const token = accessToken(8);
  await pollWithOrder(sandbox, code, token, {
    public_code: code, status: 'courier', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  evalInContext(sandbox, `
    let __confirmCalls=[];
    api.confirmOrderReceipt=async(c,t)=>{__confirmCalls.push([c,t]);return {};};
    api.getOrder=async()=>({public_code:${JSON.stringify(code)},status:'delivered',items_total:500,fulfillment_type:'delivery',restaurant_phone:null,rating:null});
  `);
  await evalInContext(sandbox, 'confirmOrderReceipt()');
  const calls = evalInContext(sandbox, 'JSON.stringify(__confirmCalls)');
  assert.equal(calls, JSON.stringify([[code, token]]));
  teardown(sandbox);
});

test('confirmOrderReceipt(): успешный вызов показывает toast "Заказ получен." и сразу подтягивает новый статус', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const code = 'YAAM-33009';
  const token = accessToken(9);
  await pollWithOrder(sandbox, code, token, {
    public_code: code, status: 'courier', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  evalInContext(sandbox, `
    api.confirmOrderReceipt=async()=>({});
    api.getOrder=async()=>({public_code:${JSON.stringify(code)},status:'delivered',items_total:500,fulfillment_type:'delivery',restaurant_phone:null,rating:null});
  `);
  await evalInContext(sandbox, 'confirmOrderReceipt()');
  assert.equal(sandbox.document.getElementById('toast').textContent, 'Заказ получен.');
  // Немедленный ре-опрос уже применил delivered — форма оценки должна появиться
  // без ожидания следующего тика setInterval.
  assert.equal(sandbox.document.getElementById('st-final').style.display, 'block');
  teardown(sandbox);
});

test('confirmOrderReceipt(): ошибка API показывает сообщение об ошибке, не роняет клиента', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const code = 'YAAM-33010';
  const token = accessToken(10);
  await pollWithOrder(sandbox, code, token, {
    public_code: code, status: 'courier', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  evalInContext(sandbox, `
    api.confirmOrderReceipt=async()=>{throw new Error('заказ ещё не передан курьеру — подтвердить получение нельзя');};
  `);
  await evalInContext(sandbox, 'confirmOrderReceipt()');
  assert.equal(
    sandbox.document.getElementById('toast').textContent,
    'заказ ещё не передан курьеру — подтвердить получение нельзя',
  );
  teardown(sandbox);
});

test('confirmOrderReceipt(): демо-режим (нет USE_API/currentOrderCode) не падает и не делает сетевых вызовов', async () => {
  const sandbox = freshApp(); // demo — apiBaseUrl не задан, USE_API=false
  evalInContext(sandbox, `
    let __confirmCallCount=0;
    api.confirmOrderReceipt=async()=>{__confirmCallCount++;return {};};
  `);
  await evalInContext(sandbox, 'confirmOrderReceipt()');
  assert.equal(evalInContext(sandbox, '__confirmCallCount'), 0, 'USE_API=false — api.confirmOrderReceipt не должен вызываться вообще');
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// KNOWN_ORDER_STATUSES — 'ready' не должен считаться неизвестным статусом
// ---------------------------------------------------------------------------

test('KNOWN_ORDER_STATUSES включает ready — без "неизвестный статус" toast', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await pollWithOrder(sandbox, 'YAAM-33011', accessToken(11), {
    public_code: 'YAAM-33011', status: 'ready', items_total: 500,
    fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
  });
  assert.doesNotMatch(sandbox.document.getElementById('toast').textContent || '', /неизвестн/i);
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// Read-only «Поделиться» — владельческая кнопка не должна утекать
// ---------------------------------------------------------------------------

test('openSharedOrder(): «Заказ получен» скрыта даже для courier — это владельческое действие, не read-only', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-33012', status: 'courier', items_total: 500,
        fulfillment_type: 'delivery', restaurant_phone: null,
        items: [{ name: 'Хинкали', price: 500, qty: 1 }],
      };
    },
  });
  const token = `yaam_shr_v1_${Buffer.alloc(32, 12).toString('base64url')}`;
  await evalInContext(sandbox, `openSharedOrder('YAAM-33012', ${JSON.stringify(token)})`);
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'none');
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// pickup — не затронут Stage 33 (нет ready/courier шага вообще)
// ---------------------------------------------------------------------------

test('pickup: delivered (последний шаг) не показывает "Заказ получен" — pickup не имеет своего confirm-receipt', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await pollWithOrder(sandbox, 'YAAM-33013', accessToken(13), {
    public_code: 'YAAM-33013', status: 'delivered', items_total: 500,
    fulfillment_type: 'pickup', restaurant_phone: null, rating: null,
  });
  assert.equal(sandbox.document.getElementById('st-confirm-wrap').style.display, 'none');
  assert.equal(sandbox.document.getElementById('st-final').style.display, 'block');
  teardown(sandbox);
});
