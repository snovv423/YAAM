'use strict';

// Три изменения главной и карточки блюда, каждое со своей регрессией:
//
// A — «Кого ждём» уехала под список ресторанов, а её штора стала нижней
//     (поднимается снизу, закрывается свайпом вниз).
// B — стартовый город считается из данных: тот, где сейчас больше всего
//     опубликованных ресторанов. Осознанный выбор человека главнее.
// C — системный pinch-to-zoom страницы на карточке блюда: ни viewport, ни
//     обработчики галереи не должны его перехватывать.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const CLIENT = path.join(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(CLIENT, 'css', 'style.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(CLIENT, 'js', 'app.js'), 'utf8');
const CITIES = ['Грозный', 'Аргун', 'Гудермес', 'Шали'];

function freshApp(opts = {}) {
  const { sandbox, store } = createSandbox({ cityChips: CITIES, ...opts });
  loadAppInSandbox(sandbox);
  return { sandbox, store };
}

// ---------------------------------------------------------------------------
// A. «Кого ждём»
// ---------------------------------------------------------------------------

test('A1: кнопка «кого ждём» стоит после списка ресторанов и до footer', () => {
  const list = INDEX_HTML.indexOf('<div class="list" id="list">');
  const chip = INDEX_HTML.indexOf('id="vote-chip"');
  const footer = INDEX_HTML.indexOf('<footer class="site-footer">');
  const intro = INDEX_HTML.indexOf('<div class="intro" id="intro"');
  assert.ok(list > -1 && chip > -1 && footer > -1 && intro > -1);
  assert.ok(chip > list, 'кнопка обязана быть НИЖЕ списка ресторанов');
  assert.ok(chip < footer, 'кнопка обязана быть выше footer');
  assert.ok(chip > intro, 'кнопка больше не висит между intro и списком');
});

test('A2: штора голосования — нижняя: поднимается снизу и закрывается вниз', () => {
  // Закрытое состояние — увод ВНИЗ за нижний край, открытое — на месте.
  assert.match(STYLE_CSS, /\.vote-sheet\{position:fixed;bottom:0;top:auto;[^}]*translateY\(calc\(100% \+ 60px\)\)/,
    'закрытая штора должна стоять ниже экрана, а не выше');
  assert.match(STYLE_CSS, /\.vote-sheet\.on\{transform:translateX\(-50%\) translateY\(0\)\}/);
  assert.match(STYLE_CSS, /\.vote-sheet\{[^}]*border-radius:30px 30px 0 0/, 'скругление сверху, как у нижней шторы');
  assert.match(STYLE_CSS, /\.vote-sheet\{[^}]*transition:transform \.42s/,
    'анимируется только transform — раскладка не пересчитывается, дёрганья нет');

  // Хват — сверху шторы, до заголовка и списка: закрывающий свайп идёт вниз.
  const handle = INDEX_HTML.indexOf('vs-draghandle');
  const head = INDEX_HTML.indexOf('class="vs-head"');
  const list = INDEX_HTML.indexOf('id="vote-list"');
  assert.ok(handle < head && head < list, 'хват обязан быть верхним элементом шторы');
});

test('A3: перетаскивание закрывает штору вниз и никогда не поднимает её выше открытого положения', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const drag = (dy) => evalInContext(sandbox, `(()=>{
    const sheet=document.getElementById('vote-sheet');
    sheet.classList.add('on');
    voteTouchStart({touches:[{clientY:400}]});
    voteTouchMove({touches:[{clientY:${400 + dy}}],preventDefault(){}});
    const moved=sheet.style.transform;
    voteTouchEnd();
    return {moved,open:sheet.classList.contains('on'),after:sheet.style.transform};
  })()`);

  const down = drag(120);
  assert.equal(down.moved, 'translateX(-50%) translateY(120px)', 'штора едет за пальцем вниз');
  assert.equal(down.open, false, 'достаточный свайп вниз закрывает штору');
  assert.equal(down.after, '', 'инлайновый transform снят — доводит анимация, а не JS');

  const up = drag(-120);
  assert.equal(up.moved, 'translateX(-50%) translateY(0px)', 'вверх штора не уезжает — над ней нет ни экрана, ни содержимого');
  assert.equal(up.open, true, 'свайп вверх ничего не закрывает');

  const small = drag(20);
  assert.equal(small.open, true, 'короткое движение возвращает штору на место');
});

test('A4: двухпальцевый жест не перетаскивает штору', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const res = evalInContext(sandbox, `(()=>{
    const sheet=document.getElementById('vote-sheet');
    sheet.classList.add('on');
    voteTouchStart({touches:[{clientY:400},{clientY:420}]});
    return {dragging:voteDragging,open:sheet.classList.contains('on')};
  })()`);
  assert.equal(res.dragging, false);
  assert.equal(res.open, true);
});

// ---------------------------------------------------------------------------
// B. Стартовый город
// ---------------------------------------------------------------------------

test('B1: по умолчанию выбирается город с наибольшим числом опубликованных ресторанов', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const pick = (list) => evalInContext(sandbox,
    `pickDefaultCity(${JSON.stringify(list)},${JSON.stringify(CITIES)})`);

  assert.equal(pick([
    { cities: ['Аргун'] }, { cities: ['Аргун'] }, { cities: ['Грозный'] },
  ]), 'Аргун');

  // Ровно тот же набор, но перевес сместился — результат обязан смениться сам,
  // без правки кода: сегодня Аргун, завтра Грозный.
  assert.equal(pick([
    { cities: ['Аргун'] }, { cities: ['Грозный'] }, { cities: ['Грозный'] },
  ]), 'Грозный');

  // Ресторан работает в двух городах — считается в обоих.
  assert.equal(pick([
    { cities: ['Шали', 'Гудермес'] }, { cities: ['Гудермес'] }, { cities: ['Грозный'] },
  ]), 'Гудермес');
});

test('B2: при равенстве выбор устойчив, а без ресторанов автоматика молчит', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const pick = (list) => evalInContext(sandbox,
    `pickDefaultCity(${JSON.stringify(list)},${JSON.stringify(CITIES)})`);

  // Одинаковое число — всегда первый по разметке, иначе город «прыгал» бы
  // между загрузками.
  const tie = [{ cities: ['Аргун'] }, { cities: ['Грозный'] }];
  assert.equal(pick(tie), 'Грозный');
  assert.equal(pick(tie), 'Грозный');

  assert.equal(pick([]), null, 'пусто — навязывать нечего');
  assert.equal(pick([{ cities: ['Москва'] }]), null, 'города вне списка не считаются');
  assert.equal(evalInContext(sandbox, 'pickDefaultCity(null,[])'), null);
  assert.equal(evalInContext(sandbox, `pickDefaultCity([{cities:null},{}],${JSON.stringify(CITIES)})`), null);
});

test('B3: осознанный выбор человека главнее автоматики и не перезаписывается ею', async (t) => {
  const { sandbox, store } = createSandbox({ cityChips: CITIES });
  store.yaam_selected_city = 'Шали';
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));

  assert.equal(evalInContext(sandbox, 'selectedCity'), 'Шали', 'сохранённый выбор применён');
  // Даже если данные говорят про другой город — выбор человека остаётся.
  await evalInContext(sandbox, 'applyDefaultCityFromData()');
  assert.equal(evalInContext(sandbox, 'restoreSelectedCity()'), true);
  assert.equal(evalInContext(sandbox, 'selectedCity'), 'Шали');
});

test('B4: автовыбор не записывается в хранилище — иначе он застыл бы навсегда', async (t) => {
  const { sandbox, store } = freshApp();
  t.after(() => teardown(sandbox));
  assert.equal(store.yaam_selected_city, undefined, 'до нажатия на чип сохранённого выбора нет');
  await evalInContext(sandbox, 'applyDefaultCityFromData()');
  assert.equal(store.yaam_selected_city, undefined, 'автовыбор остаётся автовыбором');
  // А нажатие на чип — сохраняется.
  evalInContext(sandbox, "persistSelectedCity('Гудермес')");
  assert.equal(store.yaam_selected_city, 'Гудермес');
});

test('B5: демо-режим считает город по локальному справочнику, без запроса', async (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  // fetch в песочнице бросает — если бы код пошёл в сеть, тест упал бы.
  const data = await evalInContext(sandbox, 'applyDefaultCityFromData()');
  const expected = evalInContext(sandbox,
    `pickDefaultCity(restaurants,${JSON.stringify(CITIES)})`);
  assert.equal(evalInContext(sandbox, 'selectedCity'), expected || 'Грозный');
  assert.equal(data.failed, false, 'демо-режим не ходит в сеть и не может «не загрузиться»');
  assert.ok(Array.isArray(data.list) && data.list.length > 0, 'список берётся из локального справочника');
});

test('B6: главная рисуется из того же ответа — второго запроса за теми же данными нет', async (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  let calls = 0;
  evalInContext(sandbox, 'globalThis.__apiCalls=0;const orig=api.getRestaurants;api.getRestaurants=async(c)=>{globalThis.__apiCalls++;return [];};');
  const data = await evalInContext(sandbox, 'applyDefaultCityFromData()');
  await evalInContext(sandbox, `renderList(false,selectedCity,null,${JSON.stringify(data)})`);
  calls = evalInContext(sandbox, 'globalThis.__apiCalls');
  assert.equal(calls, 0, 'в demo-режиме сеть не трогается вовсе');

  // Сбой загрузки не должен приводить к повторному запросу «на всякий случай».
  await evalInContext(sandbox, "renderList(false,selectedCity,null,{list:[],failed:true})");
  assert.equal(evalInContext(sandbox, 'globalThis.__apiCalls'), 0,
    'при уже случившемся сбое renderList не ходит в сеть повторно');
  assert.equal(evalInContext(sandbox, "document.getElementById('toast').textContent"),
    'Не удалось загрузить рестораны — проверьте соединение',
    'но честно показывает ту же ошибку');
});

// ---------------------------------------------------------------------------
// C. Системный pinch-to-zoom страницы
// ---------------------------------------------------------------------------

test('C1: viewport не запрещает масштабирование', () => {
  const meta = /<meta name="viewport" content="([^"]+)">/.exec(INDEX_HTML);
  assert.ok(meta, 'meta viewport должен существовать');
  const content = meta[1];
  assert.doesNotMatch(content, /user-scalable\s*=\s*(no|0)/i, 'user-scalable=no запрещает системный zoom');
  assert.doesNotMatch(content, /maximum-scale/i, 'maximum-scale ограничивает системный zoom');
  assert.doesNotMatch(content, /minimum-scale/i);
  assert.match(content, /initial-scale=1/);
  // И нигде больше в документе нет второго viewport, который бы это переопределил.
  assert.equal((INDEX_HTML.match(/name="viewport"/g) || []).length, 1);
});

test('C2: фото блюда разрешает браузеру и вертикальный скролл, и щипок', () => {
  assert.match(STYLE_CSS, /\.dhero\{[^}]*touch-action:pan-y pinch-zoom/,
    'без pinch-zoom в touch-action браузер не начнёт масштабирование над фото');
  assert.doesNotMatch(STYLE_CSS, /\.dhero\{[^}]*touch-action:none/);
});

test('C3: второй палец на фото снимает начатое листание и не отменяет событие', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const res = evalInContext(sandbox, `(()=>{
    const hero=document.getElementById('d-hero');
    const handlers={};
    hero.addEventListener=(type,fn)=>{handlers[type]=fn;};
    hero.removeEventListener=()=>{};
    galleryState.d={hero,track:document.getElementById('d-track'),index:0,photos:[{},{},{}],drag:null,snapping:false};
    bindGalleryDrag('d',true);

    handlers.pointerdown({isPrimary:true,pointerId:1,clientX:100,clientY:100,pointerType:'touch',target:hero});
    const dragStarted=!!galleryState.d.drag;

    // Появился второй палец.
    let prevented=false;
    handlers.touchstart({touches:[{clientX:100,clientY:100},{clientX:200,clientY:200}]});
    const dragAfterSecondFinger=!!galleryState.d.drag;

    // И даже если touchmove с двумя пальцами всё-таки придёт — не отменяем.
    galleryState.d.drag={pointerId:1,startX:100,startY:100,lastX:100,lastTime:0,velocityX:0,axis:'horizontal'};
    handlers.touchmove({touches:[{clientX:40,clientY:100},{clientX:260,clientY:100}],cancelable:true,preventDefault(){prevented=true;}});
    return {dragStarted,dragAfterSecondFinger,prevented,dragAfterMove:!!galleryState.d.drag};
  })()`);
  assert.equal(res.dragStarted, true, 'одним пальцем листание начинается как прежде');
  assert.equal(res.dragAfterSecondFinger, false, 'второй палец сворачивает жест галереи');
  assert.equal(res.prevented, false, 'двухпальцевый touchmove НЕ отменяется — иначе Safari не начнёт zoom');
  assert.equal(res.dragAfterMove, false);
});

test('C4: пока страница увеличена, галерея не листается; вернулись к 1x — листается снова', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  const res = evalInContext(sandbox, `(()=>{
    const hero=document.getElementById('d-hero');
    const handlers={};
    hero.addEventListener=(type,fn)=>{handlers[type]=fn;};
    hero.removeEventListener=()=>{};
    galleryState.d={hero,track:document.getElementById('d-track'),index:0,photos:[{},{},{}],drag:null,snapping:false};
    bindGalleryDrag('d',true);
    const down=()=>handlers.pointerdown({isPrimary:true,pointerId:1,clientX:100,clientY:100,pointerType:'touch',target:hero});

    window.visualViewport={scale:2.4};
    down();
    const whileZoomed=!!galleryState.d.drag;

    // Жест, начатый до щипка, тоже обязан сворачиваться.
    galleryState.d.drag={pointerId:1,startX:100,startY:100,lastX:100,lastTime:0,velocityX:0,axis:'horizontal'};
    handlers.pointermove({pointerId:1,clientX:40,clientY:100,cancelable:true,preventDefault(){}});
    const afterZoomedMove=!!galleryState.d.drag;

    window.visualViewport={scale:1};
    down();
    const backToOne=!!galleryState.d.drag;
    return {whileZoomed,afterZoomedMove,backToOne};
  })()`);
  assert.equal(res.whileZoomed, false, 'в увеличенном виде свайп принадлежит странице, а не галерее');
  assert.equal(res.afterZoomedMove, false, 'начатое до щипка листание сворачивается');
  assert.equal(res.backToOne, true, 'вернулись к 1x — обычный свайп фотографий снова работает');
});

test('C5: pull-to-refresh не срабатывает во время щипка', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  // Обработчики висят на document — проверяем сам исходник: два пальца
  // обязаны отсекаться до того, как индикатор что-то покажет.
  assert.match(APP_JS, /touchstart',e=>\{if\(e\.touches\.length>1\)\{ptrActive=false;return;\}/);
  assert.match(APP_JS, /touchmove',e=>\{if\(e\.touches\.length>1\)\{ptrActive=false;return;\}/);
});

test('C6: во всём интерфейсе нет ни одного места, глушащего zoom вне крошечного хвата шторы', () => {
  // touch-action:none — единственная запись, которая полностью отбирает
  // масштабирование у браузера. Допустима она ровно на хвате шторы (46x5 px),
  // которому вертикальное перетаскивание нужно целиком.
  const noneRules = (STYLE_CSS.match(/[^\n]*touch-action:\s*none[^\n]*/g) || []);
  assert.deepEqual(noneRules.map((r) => r.trim().split('{')[0]), ['.vs-draghandle'],
    'touch-action:none допустим только на хвате шторы');
  // manipulation и pan-* сохраняют pinch-zoom, а pan-y без pinch-zoom на фото
  // блюда его бы отобрал — этот случай закрыт в C2. Сам viewport проверяется
  // в C1: в CSS директивы user-scalable не существует вовсе.
});
