'use strict';

// YAAM Stage 35, раздел 3 — живая находка владельца: карточка состава заказа
// на status screen превращала "1 × Длинное название блюда 350 ₽" в одну
// текстовую строку без структуры — при переносе непонятно, где количество,
// где название, где цена. Фикс (client/js/app.js): orderItemRowHTML()
// рендерит quantity/name/price раздельными span-элементами
// (.oi-qty/.oi-name/.oi-price), плюс на статус-экране впервые появляются
// «Итого» (orderTotalHTML(), уже авторитетный order.items_total) и
// «Доставка»/адрес (orderDeliveryHTML(), только delivery, только
// собственный экран — НЕ read-only share-ссылка).
//
// Тот же паттерн (node:vm sandbox), что и orderStatusHardening.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

// Полный реальный флоу: чекаут -> awaiting_payment (QR) -> poll обнаруживает
// awaiting_restaurant -> initStatusScreen() заполняет #st-items. Тот же
// приём, что и "FIX5: оплата, обнаруженная поллингом" в
// orderStatusHardening.test.js — не подделываем рендер напрямую, идём через
// реальный openQR()/pollOrderOnce(), чтобы проверять именно то, что реально
// увидит пользователь.
async function checkoutToStatusScreen(sandbox, { code, items, address, comment, fulfillmentType = 'delivery', itemsTotal }) {
  evalInContext(sandbox, `
    validateCheckout=()=>true;
    validateLegalConsent=()=>true;
    curRest={id:1,name:'Ресторан',address:'Адрес ресторана',phone:'+79280000000'};
    fulfillmentType=${JSON.stringify(fulfillmentType)};
    cart=${JSON.stringify(items)};
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value=${JSON.stringify(address || '')};
    document.getElementById('c-comment').value=${JSON.stringify(comment || '')};
    let __srvStatus='awaiting_payment';
    api.createOrder=async()=>({
      order:{public_code:${JSON.stringify(code)},status:'awaiting_payment',items_total:${itemsTotal},refund_status:'none'},
      payment:{paymentUrl:null,qrPayload:'demo'},
    });
    api.getOrder=async()=>({public_code:${JSON.stringify(code)},status:__srvStatus,items_total:${itemsTotal},restaurant_phone:'',fulfillment_type:${JSON.stringify(fulfillmentType)},status_updated_at:new Date().toISOString(),refund_status:'none'});
  `);
  await evalInContext(sandbox, `openQR()`);
  await new Promise((resolve) => setImmediate(resolve));
  evalInContext(sandbox, `__srvStatus='awaiting_restaurant';`);
  await evalInContext(sandbox, `pollOrderOnce()`);
}

test('Позиция заказа рендерится раздельными DOM-элементами qty/name/price, не одной строкой', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  const longName = 'Хинкали с бараниной и особым соусом — тестовое блюдо для проверки переноса длинного названия';
  await checkoutToStatusScreen(sandbox, {
    code: 'YAAM-35001',
    items: { '0_0': { n: longName, p: 350, q: 1, menuItemId: 7 } },
    address: 'ул. Тестовая, 1',
    itemsTotal: 350,
  });
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(html, /<div class="order-item">/, 'позиция обязана использовать новую структурированную разметку');
  assert.match(html, /<span class="oi-qty">1×<\/span>/);
  assert.match(html, new RegExp(`<span class="oi-name">${longName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`), 'длинное название не обрезается');
  assert.match(html, /<span class="oi-price">350 ₽<\/span>/, 'цена — отдельный элемент, ₽ приклеен к сумме');
  teardown(sandbox);
});

test('Несколько позиций с разным qty — каждая своя строка, ни одна не теряется', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await checkoutToStatusScreen(sandbox, {
    code: 'YAAM-35002',
    items: {
      '0_0': { n: 'Хинкали', p: 350, q: 1, menuItemId: 1 },
      '0_1': { n: 'Лимонад', p: 300, q: 2, menuItemId: 2 },
    },
    itemsTotal: 950,
  });
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(html, /<span class="oi-qty">1×<\/span><span class="oi-name">Хинкали<\/span><span class="oi-price">350 ₽<\/span>/);
  assert.match(html, /<span class="oi-qty">2×<\/span><span class="oi-name">Лимонад<\/span><span class="oi-price">600 ₽<\/span>/, 'цена позиции — price*qty, не price');
  teardown(sandbox);
});

test('«Итого» — отдельный блок, равный авторитетному order.items_total (не пересчитан на клиенте)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await checkoutToStatusScreen(sandbox, {
    code: 'YAAM-35003',
    items: { '0_0': { n: 'Блюдо', p: 999, q: 1, menuItemId: 1 } },
    itemsTotal: 999,
  });
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(html, /<div class="sumrow total"><span>Итого<\/span><span>999 ₽<\/span><\/div>/);
  teardown(sandbox);
});

test('Delivery: адрес и комментарий — отдельный структурированный блок «Доставка», значения экранированы', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await checkoutToStatusScreen(sandbox, {
    code: 'YAAM-35004',
    items: { '0_0': { n: 'Блюдо', p: 300, q: 1, menuItemId: 1 } },
    address: 'ул. Маяковского, 18, кв. 7',
    comment: '<script>alert(1)</script> позвоните заранее',
    itemsTotal: 300,
  });
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(html, /<div class="order-delivery">/);
  assert.match(html, /<div class="order-delivery-title">Доставка<\/div>/);
  assert.match(html, /<div class="order-delivery-addr">ул\. Маяковского, 18, кв\. 7<\/div>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'комментарий обязан быть экранирован (esc()), не вставлен как сырой HTML');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  teardown(sandbox);
});

test('Pickup: блок «Доставка» не рендерится вовсе (адрес — это адрес ресторана, уже показан на чекауте)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await checkoutToStatusScreen(sandbox, {
    code: 'YAAM-35005',
    items: { '0_0': { n: 'Блюдо', p: 300, q: 1, menuItemId: 1 } },
    fulfillmentType: 'pickup',
    itemsTotal: 300,
  });
  const html = sandbox.document.getElementById('st-items').innerHTML;
  assert.doesNotMatch(html, /order-delivery/, 'pickup не должен показывать блок «Доставка»');
  teardown(sandbox);
});

test('Адрес/комментарий переживают hard reload (persist через saveOrderState/hydrateStoredOrder, тот же принцип, что orderItems)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  await checkoutToStatusScreen(sandbox, {
    code: 'YAAM-35006',
    items: { '0_0': { n: 'Блюдо', p: 300, q: 1, menuItemId: 1 } },
    address: 'ул. Ленина, 10',
    comment: 'Домофон не работает',
    itemsTotal: 300,
  });
  const stored = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(stored.address, 'ул. Ленина, 10');
  assert.equal(stored.comment, 'Домофон не работает');

  // Новый sandbox = новая вкладка/hard reload с тем же localStorage.
  const sandbox2 = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox2.localStorage.setItem('yaam_active_order', JSON.stringify(stored));
  evalInContext(sandbox2, `
    api.getRestaurant=async()=>({id:1,name:'Ресторан',menu:[],cities:[]});
    api.getOrder=async()=>({public_code:${JSON.stringify('YAAM-35006')},status:'awaiting_restaurant',items_total:300,restaurant_phone:'',fulfillment_type:'delivery',status_updated_at:new Date().toISOString(),refund_status:'none'});
  `);
  await evalInContext(sandbox2, `resolveInitialOrder({allowCreate:false})`);
  assert.equal(evalInContext(sandbox2, `currentOrderAddress`), 'ул. Ленина, 10');
  assert.equal(evalInContext(sandbox2, `currentOrderComment`), 'Домофон не работает');
  teardown(sandbox);
  teardown(sandbox2);
});

test('Read-only share-ссылка НИКОГДА не показывает адрес/комментарий (sharedOrderItemsHTML не читает currentOrderAddress)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  evalInContext(sandbox, `
    currentOrderAddress='секретный домашний адрес клиента';
    currentOrderComment='секретный комментарий';
  `);
  const html = evalInContext(sandbox, `sharedOrderItemsHTML({items:[{name:'Блюдо',price:300,qty:1}],items_total:300})`);
  assert.doesNotMatch(html, /секретный/, 'read-only share-ссылка не должна раскрывать домашний адрес постороннему');
  assert.doesNotMatch(html, /order-delivery/);
  teardown(sandbox);
});
