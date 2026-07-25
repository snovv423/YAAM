// YAAM HQ Stage 1: форматирование публичного счётчика заказов и порог
// NEW-бейджа (0-9 завершённых заказов -> NEW, 10+ -> счётчик). Тестирует
// реальный client/js/app.js (pluralOrders/formatOrdersCount/cardHTML) в vm-
// песочнице — тот же приём, что и остальные client/test/*.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext } = require('./helpers/loadApp');

function freshApp() {
  const { sandbox } = createSandbox();
  loadAppInSandbox(sandbox);
  return sandbox;
}

test('pluralOrders — русское склонение по всем контрольным значениям', () => {
  const sandbox = freshApp();
  const cases = {
    0: 'заказов', 1: 'заказ', 2: 'заказа', 4: 'заказа', 5: 'заказов',
    9: 'заказов', 10: 'заказов', 11: 'заказов', 12: 'заказов', 13: 'заказов',
    14: 'заказов', 21: 'заказ', 22: 'заказа', 24: 'заказа', 25: 'заказов',
    111: 'заказов', 112: 'заказов', 121: 'заказ',
  };
  for (const [n, expected] of Object.entries(cases)) {
    assert.equal(evalInContext(sandbox, `pluralOrders(${n})`), expected, `n=${n}`);
  }
});

test('formatOrdersCount — граничные значения из задания', () => {
  const sandbox = freshApp();
  const cases = {
    0: '0 заказов',
    1: '1 заказ',
    9: '9 заказов',
    10: '10 заказов',
    11: '11 заказов',
    21: '21 заказ',
    999: '999 заказов',
    1000: '1 тыс. заказов',
    12400: '12,4 тыс. заказов',
    100000: '100 тыс. заказов',
  };
  for (const [n, expected] of Object.entries(cases)) {
    assert.equal(evalInContext(sandbox, `formatOrdersCount(${n})`), expected, `n=${n}`);
  }
});

test('formatOrdersCount не показывает бессмысленную точность (округление до 1 знака)', () => {
  const sandbox = freshApp();
  // 12 430 -> 12,4 тыс. (не 12,43 тыс.)
  assert.equal(evalInContext(sandbox, 'formatOrdersCount(12430)'), '12,4 тыс. заказов');
  // 105 000 -> 105 тыс. (целое, без ",0")
  assert.equal(evalInContext(sandbox, 'formatOrdersCount(105000)'), '105 тыс. заказов');
});

function cardFixture(overrides) {
  return {
    id: 1, name: 'Кавказ', photoUrl: '', im: null, g: '#000',
    open: true, votes: 0, rate: 0, ordersCount: 0, cui: 'Тест',
    min: 300, hours: '10:00-22:00',
    ...overrides,
  };
}

test('карточка ресторана: 9 завершённых заказов — показан NEW, счётчик не показан', () => {
  const sandbox = freshApp();
  const html = evalInContext(sandbox, `cardHTML(${JSON.stringify(cardFixture({ ordersCount: 9 }))})`);
  assert.match(html, /newtag">NEW</);
  assert.doesNotMatch(html, /class="ordcnt"/);
});

test('карточка ресторана: 10 завершённых заказов — NEW скрыт, показан счётчик "10 заказов"', () => {
  const sandbox = freshApp();
  const html = evalInContext(sandbox, `cardHTML(${JSON.stringify(cardFixture({ ordersCount: 10 }))})`);
  assert.doesNotMatch(html, /newtag">NEW</);
  assert.match(html, /class="ordcnt">10 заказов</);
});

test('карточка ресторана: 0 заказов у открытого ресторана — показан NEW', () => {
  const sandbox = freshApp();
  const html = evalInContext(sandbox, `cardHTML(${JSON.stringify(cardFixture({ ordersCount: 0 }))})`);
  assert.match(html, /newtag">NEW</);
});

test('карточка ресторана: закрытый ресторан с 0 заказов — NEW не показывается (существующее правило "только open")', () => {
  const sandbox = freshApp();
  const html = evalInContext(sandbox, `cardHTML(${JSON.stringify(cardFixture({ ordersCount: 0, open: false }))})`);
  assert.doesNotMatch(html, /newtag">NEW</);
});

test('карточка ресторана: закрытый ресторан с 12400 заказами всё равно показывает компактный счётчик', () => {
  const sandbox = freshApp();
  const html = evalInContext(sandbox, `cardHTML(${JSON.stringify(cardFixture({ ordersCount: 12400, open: false }))})`);
  assert.match(html, /class="ordcnt">12,4 тыс\. заказов</);
});

test('старый текст "уже заказали N раз" больше нигде не используется', () => {
  const sandbox = freshApp();
  const html = evalInContext(sandbox, `cardHTML(${JSON.stringify(cardFixture({ ordersCount: 50 }))})`);
  assert.doesNotMatch(html, /уже заказали/);
});
