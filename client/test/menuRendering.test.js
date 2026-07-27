// YAAM HQ Stage 5A — клиентские тесты рендеринга меню/блюд: порядок
// категорий/блюд, недоступное блюдо не даёт добавить в корзину, состав/БЖУ
// в деталях блюда, пустые опциональные поля не показывают выдуманные данные
// и не показывают "0" вместо "нет данных", XSS-безопасность имени/описания/
// категории, архивированное блюдо просто отсутствует в присланном массиве
// (сервер уже отфильтровал — задание, раздел 11), актуальная цена берётся
// из API-ответа, а не из захардкоженного значения.
//
// Тот же established-паттерн, что и остальные frontend-тесты: загружает
// РЕАЛЬНЫЙ client/js/app.js через test/helpers/loadApp.js (node:vm), не
// переписанную копию.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

// Форма элемента ПОСЛЕ normalizeRestaurant() (client/js/app.js) — та же,
// что реально приходит из API и маппится клиентом; тесты собирают curRest
// напрямую в этой уже нормализованной форме, чтобы не зависеть от deep
// прохождения normalizeRestaurant отдельно (она не тестируется здесь).
// curRest объявлен через `let` на верхнем уровне app.js — в vm-контексте это
// лексическая глобальная привязка, НЕ свойство объекта контекста, поэтому
// присвоение через sandbox.curRest=... извне не видно функциям внутри
// контекста. Установка обязана идти через evalInContext (тот же реалм).
function setMenu(sandbox, menu) {
  const restaurant = { name: 'Тестовый ресторан', hours: '10:00-22:00', votes: 0, rate: 0, menu };
  evalInContext(sandbox, `curRest = ${JSON.stringify(restaurant)}`);
}

test('renderMenuBody: категории и блюда рендерятся в том порядке, в котором пришли от API', () => {
  const sandbox = freshApp({});
  setMenu(sandbox, [
    { cat: 'Первая', items: [{ id: 1, n: 'Блюдо A', d: '', p: 100, available: true }, { id: 2, n: 'Блюдо B', d: '', p: 200, available: true }] },
    { cat: 'Вторая', items: [{ id: 3, n: 'Блюдо C', d: '', p: 300, available: true }] },
  ]);
  evalInContext(sandbox, 'renderMenuBody()');
  const html = sandbox.document.getElementById('m-body').innerHTML;
  const posFirst = html.indexOf('Первая');
  const posA = html.indexOf('Блюдо A');
  const posB = html.indexOf('Блюдо B');
  const posSecond = html.indexOf('Вторая');
  const posC = html.indexOf('Блюдо C');
  assert.ok(posFirst < posA && posA < posB && posB < posSecond && posSecond < posC, 'порядок в HTML должен совпадать с порядком массивов');
  teardown(sandbox);
});

test('dishCard: недоступное блюдо показывает "Нет в наличии", без кнопки добавления и без открытия карточки', () => {
  const sandbox = freshApp({});
  setMenu(sandbox, [{ cat: 'Кат', items: [{ id: 1, n: 'Стоп-лист блюдо', d: '', p: 100, available: false }] }]);
  evalInContext(sandbox, 'renderMenuBody()');
  const html = sandbox.document.getElementById('m-body').innerHTML;
  assert.match(html, /Нет в наличии/);
  assert.doesNotMatch(html, /onclick="addItem/, 'у недоступного блюда не должно быть кнопки добавления в корзину');
  assert.doesNotMatch(html, /onclick="openDish/, 'недоступное блюдо не должно открывать карточку по клику');
});

test('dishCard: доступное блюдо даёт добавить в корзину и открыть карточку', () => {
  const sandbox = freshApp({});
  setMenu(sandbox, [{ cat: 'Кат', items: [{ id: 1, n: 'Доступное блюдо', d: '', p: 150, available: true }] }]);
  evalInContext(sandbox, 'renderMenuBody()');
  const html = sandbox.document.getElementById('m-body').innerHTML;
  assert.match(html, /onclick="addItem\('0_0',event\)"/);
  assert.match(html, /onclick="openDish\('0_0'\)"/);
});

test('addItem: не добавляет заново проверку доступности (гарантия — на уровне рендера/сервера), но цена/название берутся из текущего меню', () => {
  const sandbox = freshApp({});
  setMenu(sandbox, [{ cat: 'Кат', items: [{ id: 42, n: 'Шашлык', d: '', p: 650, available: true }] }]);
  evalInContext(sandbox, "addItem('0_0')");
  const cart = evalInContext(sandbox, 'JSON.stringify(cart)');
  const parsed = JSON.parse(cart);
  assert.equal(parsed['0_0'].p, 650);
  assert.equal(parsed['0_0'].menuItemId, 42);
});

test('openDish: BJU из API — реальные значения, "—" для отсутствующих, БЕЗ подмены фальшивыми demo-цифрами', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' }); // USE_API=true
  setMenu(sandbox, [{
    cat: 'Кат',
    items: [{ id: 1, n: 'Блюдо с частичным БЖУ', d: '', p: 500, available: true, w: 300, kcal: 400, prot: null, fat: null, carb: null, s: '' }],
  }]);
  evalInContext(sandbox, "openDish('0_0')");
  const kbju = sandbox.document.getElementById('d-kbju').innerHTML;
  assert.match(kbju, /400/, 'заполненная калорийность должна показаться реальным значением');
  assert.match(kbju, /—\s*г<\/b><span>белки/, 'пустой белок должен показать "—", не 0 и не выдуманное число');
  const sub = sandbox.document.getElementById('d-sub')._text;
  assert.match(sub, /300 г/);
});

test('openDish: полностью пустое БЖУ у реального API-блюда — честное "Состав не указан", НЕ демо-заглушка с придуманными цифрами', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  setMenu(sandbox, [{
    cat: 'Кат',
    items: [{ id: 1, n: 'Совсем без БЖУ', d: '', p: 80, available: true, w: null, kcal: null, prot: null, fat: null, carb: null, s: '' }],
  }]);
  evalInContext(sandbox, "openDish('0_0')");
  const kbju = sandbox.document.getElementById('d-kbju').innerHTML;
  assert.doesNotMatch(kbju, />450</, 'НЕ должна показаться фальшивая demo-калорийность 450 для реального пустого блюда');
  assert.match(kbju, /—/, 'должно быть честное "—", раз данных нет');
  const sostav = sandbox.document.getElementById('d-sostav')._text;
  assert.equal(sostav, 'Состав не указан');
});

test('openDish: демо-режим (USE_API=false) по-прежнему использует локальный справочник DETAILS — регрессия не задета', () => {
  const sandbox = freshApp({}); // без apiBaseUrl -> USE_API=false
  setMenu(sandbox, [{
    cat: 'Кат',
    items: [{ id: 1, n: 'Шашлык из баранины', d: '', p: 650, available: true, w: null, kcal: null, prot: null, fat: null, carb: null, s: '' }],
  }]);
  evalInContext(sandbox, "openDish('0_0')");
  const kbju = sandbox.document.getElementById('d-kbju').innerHTML;
  assert.doesNotMatch(kbju, />—</, 'в demo-режиме по-прежнему должны использоваться локальные значения DETAILS, не "—"');
});

test('XSS: название/описание блюда и название категории экранируются перед innerHTML', () => {
  const sandbox = freshApp({});
  const payload = '<img src=x onerror=alert(1)>';
  setMenu(sandbox, [{ cat: payload, items: [{ id: 1, n: payload, d: payload, p: 100, available: true }] }]);
  evalInContext(sandbox, 'renderMenuBody()');
  const html = sandbox.document.getElementById('m-body').innerHTML;
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/, 'сырой HTML-payload не должен попасть в innerHTML буквально');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'payload должен быть экранирован');
});

test('XSS: esc() корректно экранирует базовый набор спецсимволов', () => {
  const sandbox = freshApp({});
  const result = evalInContext(sandbox, `esc('<script>&"\\'</script>')`);
  assert.equal(result, '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});

test('renderMenuBody: пустой массив items у категории не роняет рендер (честное пустое состояние на уровне категории)', () => {
  const sandbox = freshApp({});
  setMenu(sandbox, [{ cat: 'Пустая категория', items: [] }]);
  assert.doesNotThrow(() => evalInContext(sandbox, 'renderMenuBody()'));
  const html = sandbox.document.getElementById('m-body').innerHTML;
  assert.match(html, /Пустая категория/);
});

test('архивированное блюдо просто отсутствует в присланном массиве — клиент не делает никакой отдельной фильтрации сам', () => {
  // Сервер (routes/postgresql/api.js) уже не присылает archived_at IS NOT
  // NULL блюда вовсе — клиент рендерит ровно то, что получил, без
  // собственной логики "скрыть архивное". Этот тест фиксирует контракт:
  // если бы архивное блюдо как-то попало в menu[].items, оно отрендерилось
  // бы как обычное — значит вся защита реально на сервере, что и требуется.
  const sandbox = freshApp({});
  setMenu(sandbox, [{ cat: 'Кат', items: [{ id: 1, n: 'Только активное блюдо', d: '', p: 100, available: true }] }]);
  evalInContext(sandbox, 'renderMenuBody()');
  const html = sandbox.document.getElementById('m-body').innerHTML;
  assert.match(html, /Только активное блюдо/);
  assert.equal((html.match(/class="dish/g) || []).length, 1, 'должно быть ровно одно блюдо — то, что реально прислал сервер');
});
