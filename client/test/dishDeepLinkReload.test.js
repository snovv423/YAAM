'use strict';

// Refresh на открытой карточке блюда возвращал на главную: экран жил только
// в памяти вкладки (go() клал в историю {screen:'dish'}, адрес оставался
// голым "/"), поэтому после перезагрузки состояние было неоткуда взять.
//
// Здесь проверяется РЕАЛЬНЫЙ client/js/app.js в vm-песочнице (см.
// test/helpers/loadApp.js): что приложение пишет в адрес, что оно из адреса
// восстанавливает и чего при этом НЕ ломает (город, корзину, активный заказ).
// Живой браузерный прогон (Safari/iPhone и desktop refresh, back после
// refresh) — отдельным Playwright-сценарием, здесь его не подменяем.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const CITIES = ['Грозный', 'Аргун', 'Гудермес', 'Шали'];

function freshApp(opts = {}) {
  const { sandbox, store } = createSandbox({ cityChips: CITIES, ...opts });
  loadAppInSandbox(sandbox);
  return { sandbox, store };
}

// Объекты, созданные внутри vm-контекста, принадлежат другому realm — их
// прототипы не совпадают с внешними, и assert.deepEqual сравнивает их как
// разные. Возвращаем через JSON, тогда сравнивается именно значение.
function evalJson(sandbox, code) {
  const raw = evalInContext(sandbox, `JSON.stringify(${code})`);
  return raw === undefined ? undefined : JSON.parse(raw);
}

// Загрузка страницы восстанавливает маршрут асинхронно (сначала
// tryRestoreSession, затем адрес) — ждём фактического состояния, а не
// фиксированной паузы.
async function settle(sandbox, condition, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (evalInContext(sandbox, condition)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

// Демо-ресторан из data.js: id=1 «Кавказ», меню M_KAVKAZ.
function openDemoDish(sandbox) {
  return evalInContext(sandbox, `
    (async () => {
      await doOpenRest(1);
      openDish('0_0');
      return {hash: location.hash, dish: curDishKey, rest: curRest && curRest.id};
    })()
  `);
}

// ---------------------------------------------------------------------------
// Адрес открытого экрана
// ---------------------------------------------------------------------------

test('открытые ресторан и блюдо попадают в адрес, главная его очищает', async (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));

  const opened = await openDemoDish(sandbox);
  assert.equal(opened.rest, 1);
  assert.equal(opened.dish, '0_0');
  assert.match(opened.hash, /^#\/r\/1\/d\//, 'адрес блюда должен содержать и ресторан, и блюдо');

  // Возврат в меню оставляет адрес ресторана.
  evalInContext(sandbox, "go('menu')");
  assert.equal(evalInContext(sandbox, 'location.hash'), '#/r/1');

  // Главная — чистый адрес: её нечего восстанавливать.
  evalInContext(sandbox, "go('home')");
  assert.equal(evalInContext(sandbox, 'location.hash'), '');
});

test('экраны корзины/оплаты/статуса своего адреса не получают', async (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  await openDemoDish(sandbox);
  for (const screen of ['cart', 'qr', 'status']) {
    evalInContext(sandbox, `go('${screen}')`);
    assert.equal(evalInContext(sandbox, 'location.hash'), '',
      `экран ${screen} не должен оставлять в адресе ссылку на блюдо`);
  }
});

// ---------------------------------------------------------------------------
// Разбор адреса
// ---------------------------------------------------------------------------

test('parseRouteHash принимает только собственный формат маршрута', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const parse = (hash) => evalJson(sandbox, `(()=>{location.hash=${JSON.stringify(hash)};return parseRouteHash();})()`);

  assert.deepEqual(parse('#/r/12'), { rest: 12, dish: null });
  assert.deepEqual(parse('#/r/12/d/34'), { rest: 12, dish: '34' });
  assert.deepEqual(parse('#/r/12/d/c0i3'), { rest: 12, dish: 'c0i3' }, 'demo-режим адресует блюдо позицией');

  for (const bad of ['', '#', '#/r/', '#/r/abc', '#/r/0', '#/r/-1', '#/r/1/d/', '#/r/1/x/2',
    '#shared=YAAM-1:tok', '#/r/1/d/<script>', '#/r/1/d/' + 'x'.repeat(41)]) {
    assert.equal(parse(bad), null, `мусорный адрес «${bad}» не должен разбираться`);
  }
});

test('адрес блюда строится по id из API, а не по позиции в меню', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  // Позиция блюда меняется, как только владелец переставит меню в HQ,
  // поэтому сохранённая ссылка обязана опираться на id.
  const result = evalJson(sandbox, `(()=>{
    const rest={id:9,menu:[
      {cat:'A',items:[{id:100,n:'Первое'},{id:101,n:'Второе'}]},
      {cat:'B',items:[{id:102,n:'Третье'}]},
    ]};
    const before={id:dishRouteId(rest,'0_1'),key:dishKeyFromRouteId(rest,'101')};
    // Владелец поменял категории местами — позиция та же, блюдо другое.
    rest.menu.reverse();
    const after={id:dishRouteId(rest,'0_1'),key:dishKeyFromRouteId(rest,'101')};
    return {before,after};
  })()`);
  assert.deepEqual(result.before, { id: '101', key: '0_1' });
  assert.equal(result.after.key, '1_1', 'ссылка на блюдо 101 нашла его на новой позиции');
  assert.equal(result.after.id, null, 'на позиции 0_1 теперь другое блюдо (без id) — ссылка не подменяется');
});

test('несуществующее блюдо в адресе не выдаёт чужое', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const res = evalJson(sandbox, `(()=>{
    const rest={id:9,menu:[{cat:'A',items:[{id:100},{id:101}]}]};
    return {
      missing: dishKeyFromRouteId(rest,'999'),
      badPosition: dishKeyFromRouteId(rest,'c5i5'),
      noRest: dishKeyFromRouteId(null,'100'),
      noId: dishRouteId(rest,'0_9'),
    };
  })()`);
  assert.deepEqual(res, { missing: null, badPosition: null, noRest: null, noId: null });
});

// ---------------------------------------------------------------------------
// Восстановление по адресу
// ---------------------------------------------------------------------------

test('прямой заход по адресу блюда открывает то же блюдо того же ресторана', async (t) => {
  // Именно загрузка страницы, а не ручной вызов: это и есть refresh/direct open.
  const { sandbox } = freshApp({ locationHash: '#/r/1/d/c0i1' });
  t.after(() => teardown(sandbox));

  assert.ok(await settle(sandbox, "cur('dish')"), 'карточка блюда должна открыться сама, по адресу');
  assert.equal(evalInContext(sandbox, 'curRest && curRest.id'), 1);
  assert.equal(evalInContext(sandbox, 'curDishKey'), '0_1');
  assert.equal(evalInContext(sandbox, "cur('dish')"), true, 'на экране должна быть карточка блюда');
  assert.equal(evalInContext(sandbox, 'location.hash'), '#/r/1/d/c0i1', 'адрес после восстановления тот же');
});

test('адрес ресторана без блюда открывает меню, а не главную', async (t) => {
  const { sandbox } = freshApp({ locationHash: '#/r/2' });
  t.after(() => teardown(sandbox));
  assert.ok(await settle(sandbox, "cur('menu')"));
  assert.equal(evalInContext(sandbox, 'curRest && curRest.id'), 2);
});

test('исчезнувшее блюдо оставляет посетителя в меню ресторана, а не выбрасывает на главную', async (t) => {
  const { sandbox } = freshApp({ locationHash: '#/r/1/d/99999' });
  t.after(() => teardown(sandbox));
  assert.ok(await settle(sandbox, "cur('menu')"), 'меню ресторана — ближайшее осмысленное место');
  assert.equal(evalInContext(sandbox, 'curRest && curRest.id'), 1);
  assert.equal(evalInContext(sandbox, "cur('dish')"), false);
});

test('без маршрута в адресе ничего не открывается', async (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  assert.equal(await evalInContext(sandbox, 'openRouteFromLocation()'), false);
  assert.equal(evalInContext(sandbox, 'curRest'), null);
});

test('запись истории приводится к главной до восстановления — «назад» после refresh идёт блюдо -> меню -> главная', async (t) => {
  const { sandbox } = freshApp({ locationHash: '#/r/1/d/c0i0' });
  t.after(() => teardown(sandbox));
  assert.ok(await settle(sandbox, "cur('dish')"));

  const entries = evalJson(sandbox, 'history.entries.map(e=>({type:e.type,screen:e.state&&e.state.screen,url:e.url}))');
  assert.equal(entries[0].type, 'replace');
  assert.equal(entries[0].screen, 'home');
  assert.ok(!entries[0].url.includes('#'), 'запись, на которой человек оказался после refresh, становится чистой главной');

  const pushed = entries.filter((e) => e.type === 'push').map((e) => e.screen);
  assert.deepEqual(pushed, ['menu', 'dish'], 'поверх главной ложатся ровно меню и блюдо');
});

// ---------------------------------------------------------------------------
// Что маршрут НЕ должен ломать
// ---------------------------------------------------------------------------

test('выбранный город переживает перезагрузку сам по себе, без корзины', (t) => {
  const { sandbox, store } = freshApp();
  t.after(() => teardown(sandbox));
  evalInContext(sandbox, "persistSelectedCity('Гудермес')");
  assert.equal(store.yaam_selected_city, 'Гудермес');

  const restarted = createSandbox({ cityChips: CITIES });
  restarted.store.yaam_selected_city = 'Гудермес';
  loadAppInSandbox(restarted.sandbox);
  t.after(() => teardown(restarted.sandbox));
  assert.equal(evalInContext(restarted.sandbox, 'selectedCity'), 'Гудермес',
    'после перезагрузки город остаётся выбранным');
});

test('чужой город из хранилища игнорируется', (t) => {
  const { sandbox } = createSandbox({ cityChips: CITIES });
  sandbox.localStorage.setItem('yaam_selected_city', 'Москва');
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));
  assert.equal(evalInContext(sandbox, 'selectedCity'), 'Грозный', 'город вне списка не применяется');
});

test('корзина того же ресторана переживает переход по адресу блюда', async (t) => {
  const { sandbox } = freshApp({ locationHash: '#/r/1/d/c0i1' });
  t.after(() => teardown(sandbox));
  assert.ok(await settle(sandbox, "cur('dish')"));
  evalInContext(sandbox, "cart={'0_0':{n:'Шашлык',p:520,q:2}};");
  await evalInContext(sandbox, 'openRouteFromLocation()');
  assert.equal(evalInContext(sandbox, 'Object.keys(cart).length'), 1, 'корзина того же ресторана не сбрасывается');
  assert.equal(evalInContext(sandbox, "cur('dish')"), true);
});

test('корзина ДРУГОГО ресторана не стирается молча — спрашиваем тем же вопросом, что и обычный переход', async (t) => {
  const { sandbox } = freshApp({ locationHash: '#/r/2' });
  t.after(() => teardown(sandbox));
  await settle(sandbox, "cur('menu')");
  evalInContext(sandbox, "curRest=restaurants.find(r=>r.id===1);cart={'0_0':{n:'Шашлык',p:520,q:2}};");
  await evalInContext(sandbox, 'openRouteFromLocation()');
  // Подтверждение показано, ресторан ещё не подменён, корзина цела.
  assert.equal(evalInContext(sandbox, "document.getElementById('confirm-overlay').classList.contains('on')"), true,
    'должен быть показан обычный вопрос о смене ресторана');
  assert.equal(evalInContext(sandbox, 'curRest.id'), 1);
  assert.equal(evalInContext(sandbox, 'Object.keys(cart).length'), 1);
});
