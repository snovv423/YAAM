'use strict';

// YAAM Stage 35.1 — Stage 35 добавила на статус-экране блок «Доставка»
// (адрес/комментарий), но источником были ТОЛЬКО client-side
// fallbackContext/yaam_active_order — при потере localStorage (очищенный
// браузер) или открытии заказа на другом устройстве по тому же
// orderAccessToken блок исчезал. Фикс: server/services/postgresql/
// orderService.js toPublicOrderDTO() (owner-protected, requireOrderAccess)
// теперь тоже возвращает address/comment; client/js/app.js
// (pollOrderOnce/applyRecoveredOrder) делает серверные значения
// авторитетными, localStorage — только переходный fallback до первого
// ответа сервера.
//
// Приватность (toSharedOrderDTO) проверяется отдельно на PostgreSQL-уровне
// (server/test/postgresql/ownerDeliveryDetailsStage351.test.js) — здесь
// только клиентская часть: pollOrderOnce()/applyRecoveredOrder() обязаны
// ПРЕДПОЧЕСТЬ серверные address/comment, даже когда localStorage их не
// знает вообще.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

test('pollOrderOnce(): блок «Доставка» восстанавливается ИСКЛЮЧИТЕЛЬНО из API-ответа, без localStorage/checkout-контекста вообще', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  // Симулируем "другое устройство"/"очищенный браузер": известны только
  // code+orderAccessToken (как если бы владелец получил их извне), никакого
  // currentOrderAddress/currentOrderItems/localStorage snapshot вообще.
  evalInContext(sandbox, `
    currentOrderCode='YAAM-35101';
    currentOrderAccessToken='yaam_ord_v1_${'a'.repeat(43)}';
    api.getOrder=async()=>({
      public_code:'YAAM-35101',status:'awaiting_restaurant',items_total:500,
      restaurant_phone:'',fulfillment_type:'delivery',
      address:'ул. Полученная только с сервера, 42',
      comment:'Комментарий только с сервера',
      status_updated_at:new Date().toISOString(),refund_status:'none',
    });
  `);
  assert.equal(evalInContext(sandbox, `currentOrderAddress`), null, 'до poll адрес неизвестен клиенту вообще');
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.equal(evalInContext(sandbox, `currentOrderAddress`), 'ул. Полученная только с сервера, 42');
  assert.equal(evalInContext(sandbox, `currentOrderComment`), 'Комментарий только с сервера');
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(html, /<div class="order-delivery">/);
  assert.match(html, /ул\. Полученная только с сервера, 42/);
  assert.match(html, /Комментарий только с сервера/);
  teardown(sandbox);
});

test('pollOrderOnce(): устаревший/пустой localStorage-адрес перезаписывается свежим серверным значением', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  // hydrateStoredOrder() из snapshot БЕЗ address/comment (сохранён до Stage
  // 35.1, или checkout вообще не заполнял их) — hard reload без
  // checkout-контекста.
  evalInContext(sandbox, `
    currentOrderCode='YAAM-35102';
    currentOrderAccessToken='yaam_ord_v1_${'b'.repeat(43)}';
    currentOrderAddress='';
    currentOrderComment='';
    api.getOrder=async()=>({
      public_code:'YAAM-35102',status:'preparing',items_total:700,
      restaurant_phone:'',fulfillment_type:'delivery',
      address:'ул. Свежая с сервера, 7',comment:'',
      status_updated_at:new Date().toISOString(),refund_status:'none',
    });
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.equal(evalInContext(sandbox, `currentOrderAddress`), 'ул. Свежая с сервера, 7');
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(html, /ул\. Свежая с сервера, 7/);
  teardown(sandbox);
});

test('pollOrderOnce(): pickup НЕ показывает блок «Доставка», даже если сервер прислал непустой address (адрес ресторана)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderCode='YAAM-35103';
    currentOrderAccessToken='yaam_ord_v1_${'c'.repeat(43)}';
    api.getOrder=async()=>({
      public_code:'YAAM-35103',status:'preparing',items_total:400,
      restaurant_phone:'',fulfillment_type:'pickup',
      address:'г. Грозный, адрес ресторана самовывоза',comment:'',
      status_updated_at:new Date().toISOString(),refund_status:'none',
    });
  `);
  await evalInContext(sandbox, `pollOrderOnce()`);
  assert.equal(evalInContext(sandbox, `currentFulfillment`), 'pickup');
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.doesNotMatch(html, /order-delivery/, 'pickup обязан скрывать блок «Доставка» независимо от того, что прислал сервер в address');
  teardown(sandbox);
});

test('applyRecoveredOrder(): свежесозданный заказ получает address/comment СРАЗУ из ответа createOrder (не только на первом poll)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    validateCheckout=()=>true;
    validateLegalConsent=()=>true;
    curRest={id:1,name:'Ресторан',address:'Адрес ресторана',phone:'+79280000000'};
    fulfillmentType='delivery';
    cart={'0_0':{n:'Блюдо',p:500,q:1,menuItemId:1}};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='ул. Введённая в чекауте, 9';
    document.getElementById('c-comment').value='Позвоните заранее';
    api.createOrder=async()=>({
      order:{
        public_code:'YAAM-35104',status:'awaiting_payment',items_total:500,
        fulfillment_type:'delivery',address:'ул. Введённая в чекауте, 9',
        comment:'Позвоните заранее',refund_status:'none',
      },
      payment:{paymentUrl:null,qrPayload:'demo'},
    });
    api.getOrder=async()=>({public_code:'YAAM-35104',status:'awaiting_payment',items_total:500,refund_status:'none'});
  `);
  await evalInContext(sandbox, `openQR()`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evalInContext(sandbox, `currentOrderAddress`), 'ул. Введённая в чекауте, 9');
  assert.equal(evalInContext(sandbox, `currentOrderComment`), 'Позвоните заранее');
  teardown(sandbox);
});
