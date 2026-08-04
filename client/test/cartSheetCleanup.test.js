// Stage 27 — регрессионные тесты для Stage 26 L-1: после подтверждения
// отмены неоплаченного заказа диалог обещает "Корзина будет очищена" —
// состояние (cart={}) действительно сбрасывалось и до фикса, но открытая
// штора корзины (#sheet/#sheet-overlay) — независимый оверлей, а не .screen,
// и go('home') внутри resetAll() её не трогал: старые позиции, старая сумма
// и активная кнопка «Оформить заказ» оставались видны до следующего
// открытия. Фикс — resetAll() теперь явно закрывает штору и чистит её DOM.
//
// Загружают РЕАЛЬНЫЙ client/js/app.js через node:vm (см. test/helpers/
// loadApp.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

// Наполняет корзину одной позицией и реально открывает штору (как если бы
// пользователь только что был на экране "Корзина" перед оформлением) — то
// самое состояние, в котором был найден дефект в Stage 26.
function openSheetWithOneItem(sandbox) {
  evalInContext(sandbox, `
    curRest={id:1,name:'ZZZ_STAGE27_Кафе',min:0};
    cart={'1':{n:'ZZZ_STAGE27_Блюдо',p:400,q:1}};
    openSheet();
  `);
}

test('1. resetAll() закрывает штору корзины (снимает класс "on")', (t) => {
  const sandbox = freshApp();
  openSheetWithOneItem(sandbox);
  assert.ok(evalInContext(sandbox, `document.getElementById('sheet').classList.contains('on')`), 'штора должна быть открыта до отмены — иначе сценарий не воспроизведён');
  evalInContext(sandbox, `resetAll();`);
  assert.ok(!evalInContext(sandbox, `document.getElementById('sheet').classList.contains('on')`), 'resetAll() должен закрыть штору корзины');
  assert.ok(!evalInContext(sandbox, `document.getElementById('sheet-overlay').classList.contains('on')`));
  teardown(sandbox);
});

test('2. resetAll() очищает DOM списка позиций и суммы в шторе — не только состояние cart', (t) => {
  const sandbox = freshApp();
  openSheetWithOneItem(sandbox);
  const before = evalInContext(sandbox, `document.getElementById('sheet-items').innerHTML`);
  assert.ok(before.includes('ZZZ_STAGE27_Блюдо'), 'до отмены штора должна реально содержать позицию — иначе сценарий не воспроизведён');
  evalInContext(sandbox, `resetAll();`);
  const itemsAfter = evalInContext(sandbox, `document.getElementById('sheet-items').innerHTML`);
  const totalAfter = evalInContext(sandbox, `document.getElementById('sheet-total-wrap').innerHTML`);
  assert.equal(itemsAfter, '', 'старые позиции не должны оставаться в DOM после отмены');
  assert.equal(totalAfter, '', 'старая сумма не должна оставаться в DOM после отмены');
  assert.ok(!itemsAfter.includes('ZZZ_STAGE27_Блюдо'));
  teardown(sandbox);
});

test('3. cancelOrderFlow(true) (реальная отмена неоплаченного заказа) очищает штору так же, как прямой resetAll()', async (t) => {
  const sandbox = freshApp();
  openSheetWithOneItem(sandbox);
  evalInContext(sandbox, `currentOrderCode='YAAM-CART1';`);
  // cancelOrderFlow показывает свой confirm-оверлей и вызывает resetAll()
  // только по нажатию "Да" — здесь напрямую дёргаем onYes-коллбэк через
  // yaamConfirm-эмуляцию: демо-режим (USE_API=false) в cancelOrderFlow идёт
  // по ветке "нечего отменять на сервере, просто сбрасываем локально",
  // вызывающей resetAll() синхронно.
  evalInContext(sandbox, `cancelOrderFlow(true);`);
  evalInContext(sandbox, `document.getElementById('confirm-yes').onclick();`);
  assert.ok(!evalInContext(sandbox, `document.getElementById('sheet').classList.contains('on')`));
  assert.equal(evalInContext(sandbox, `document.getElementById('sheet-items').innerHTML`), '');
  teardown(sandbox);
});

test('4. после отмены нет активной кнопки "Оформить заказ" со старыми данными (bar скрыт, cnt=0)', (t) => {
  const sandbox = freshApp();
  openSheetWithOneItem(sandbox);
  evalInContext(sandbox, `resetAll();`);
  const cnt = evalInContext(sandbox, `totals().cnt`);
  assert.equal(cnt, 0, 'после отмены в корзине не должно остаться позиций');
  const barDisplay = evalInContext(sandbox, `document.getElementById('cartbar').style.display`);
  assert.equal(barDisplay, 'none', 'нижняя сумма-кнопка корзины должна быть скрыта после отмены');
  teardown(sandbox);
});

test('5. повторная отмена (resetAll дважды подряд) не падает', (t) => {
  const sandbox = freshApp();
  openSheetWithOneItem(sandbox);
  evalInContext(sandbox, `resetAll();`);
  assert.doesNotThrow(() => evalInContext(sandbox, `resetAll();`));
  teardown(sandbox);
});

test('6. refresh (новый sandbox без сохранённого заказа) не воскрешает старую штору', (t) => {
  const a = freshApp();
  openSheetWithOneItem(a);
  evalInContext(a, `resetAll();`);
  teardown(a);

  // resetAll() уже стирает localStorage-запись активного заказа — "refresh"
  // здесь означает загрузку app.js с нуля без какого-либо сохранённого
  // состояния (нечего восстанавливать, штора должна начинаться закрытой).
  const b = freshApp();
  assert.ok(!evalInContext(b, `document.getElementById('sheet').classList.contains('on')`));
  assert.equal(evalInContext(b, `document.getElementById('sheet-items').innerHTML`), '');
  teardown(b);
});

test('7. создание нового заказа сразу после отмены получает собственную, не унаследованную корзину/штору', (t) => {
  const sandbox = freshApp();
  openSheetWithOneItem(sandbox);
  evalInContext(sandbox, `resetAll();`);
  // Пользователь тут же начинает новый сценарий — открывает тот же/другой
  // ресторан и кладёт НОВОЕ блюдо.
  evalInContext(sandbox, `
    curRest={id:2,name:'ZZZ_STAGE27_КафеВторое',min:0};
    cart={'2':{n:'ZZZ_STAGE27_Пельмени',p:250,q:1}};
    openSheet();
  `);
  const items = evalInContext(sandbox, `document.getElementById('sheet-items').innerHTML`);
  assert.ok(items.includes('ZZZ_STAGE27_Пельмени'), 'новая позиция должна отобразиться');
  assert.ok(!items.includes('ZZZ_STAGE27_Блюдо'), 'старая (отменённая) позиция не должна просочиться в новую корзину');
  teardown(sandbox);
});
