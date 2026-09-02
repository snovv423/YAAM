'use strict';

// Главная перестала хранить свой текст и список ресторанов в вёрстке:
//
//   текст  — приходит из HQ (GET /api/home-content); копия в index.html
//            разошлась бы с сохранённым при первой же правке владельца;
//   лента  — собирается из реальных опубликованных ресторанов, поэтому
//            подключение нового и снятие с публикации меняют её сами.
//
// Здесь проверяется РЕАЛЬНЫЙ client/js/app.js в vm-песочнице; живой браузер —
// отдельным Playwright-сценарием.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const CLIENT = path.join(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(CLIENT, 'css', 'style.css'), 'utf8');
const CITIES = ['Грозный', 'Аргун', 'Гудермес', 'Шали'];

function freshApp(opts = {}) {
  const { sandbox, store } = createSandbox({ cityChips: CITIES, ...opts });
  loadAppInSandbox(sandbox);
  return { sandbox, store };
}

// Готовит ленту к измерениям: трек «шириной» по числу названий, экран — фикс.
function setupMarquee(sandbox, { trackWidthPerItem = 100, screenWidth = 320 } = {}) {
  evalInContext(sandbox, `
    (()=>{
      const box=document.getElementById('partners');
      const track=document.getElementById('ptrack');
      box.clientWidth=${screenWidth};
      Object.defineProperty(track,'scrollWidth',{configurable:true,get(){
        return (track.innerHTML.match(/class="pname"/g)||[]).length*${trackWidthPerItem};
      }});
    })()
  `);
}
// Через JSON: массивы из vm-контекста принадлежат другому realm, и
// assert.deepEqual сравнил бы их как разные объекты.
const namesIn = (sandbox) => JSON.parse(evalInContext(sandbox, `
  JSON.stringify((document.getElementById('ptrack').innerHTML.match(/<span class="pname">([^<]*)<\\/span>/g)||[])
    .map(s=>s.replace(/<[^>]*>/g,'')))
`));

// ---------------------------------------------------------------------------
// A. Текста и названий нет в вёрстке
// ---------------------------------------------------------------------------

test('A1: index.html не содержит ни текста главной, ни названий ресторанов', () => {
  assert.match(INDEX_HTML, /<h2 class="intro-title" id="intro-title"><\/h2>/);
  assert.match(INDEX_HTML, /<p class="intro-text" id="intro-text"><\/p>/);
  assert.match(INDEX_HTML, /<div class="ptrack" id="ptrack"><\/div>/);
  assert.doesNotMatch(INDEX_HTML, /Твой город уже в меню/, 'текст главной живёт в HQ, а не в вёрстке');
  assert.doesNotMatch(INDEX_HTML, /Рестораны подключаются/, 'подписи ленты были заглушкой — их больше нет');
  assert.doesNotMatch(INDEX_HTML, /class="pname"/, 'названия в ленту подставляет только код');
});

// ---------------------------------------------------------------------------
// B. Текст на главной
// ---------------------------------------------------------------------------

test('B1: текст из HQ подставляется в блок и кэшируется для следующего захода', async (t) => {
  const { sandbox, store } = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  t.after(() => teardown(sandbox));
  evalInContext(sandbox, `api.getHomeContent=async()=>({neon:'Неон из HQ',subtext:'Подтекст из HQ'});`);
  await evalInContext(sandbox, 'loadHomeContent()');

  assert.equal(evalInContext(sandbox, "document.getElementById('intro-title').textContent"), 'Неон из HQ');
  assert.equal(evalInContext(sandbox, "document.getElementById('intro-text').textContent"), 'Подтекст из HQ');
  assert.deepEqual(JSON.parse(store.yaam_home_content), { neon: 'Неон из HQ', subtext: 'Подтекст из HQ' });
});

test('B2: при следующем заходе текст виден сразу, до ответа сети, и обновляется когда ответ придёт', async (t) => {
  const { sandbox, store } = createSandbox({ cityChips: CITIES, apiBaseUrl: 'https://api.example.invalid' });
  store.yaam_home_content = JSON.stringify({ neon: 'Старый неон', subtext: 'Старый подтекст' });
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));

  let resolveLater;
  evalInContext(sandbox, `
    globalThis.__release=null;
    api.getHomeContent=()=>new Promise(res=>{globalThis.__release=()=>res({neon:'Свежий неон',subtext:'Свежий подтекст'});});
  `);
  const pending = evalInContext(sandbox, 'loadHomeContent()');
  // Ответа ещё нет — на экране уже прошлый текст, а не пустота.
  assert.equal(evalInContext(sandbox, "document.getElementById('intro-title').textContent"), 'Старый неон');
  evalInContext(sandbox, 'globalThis.__release()');
  await pending;
  assert.equal(evalInContext(sandbox, "document.getElementById('intro-title').textContent"), 'Свежий неон');
  assert.equal(JSON.parse(store.yaam_home_content).neon, 'Свежий неон');
});

test('B3: сбой загрузки текста не стирает то, что уже показано', async (t) => {
  const { sandbox, store } = createSandbox({ cityChips: CITIES, apiBaseUrl: 'https://api.example.invalid' });
  store.yaam_home_content = JSON.stringify({ neon: 'Есть текст', subtext: 'И подтекст' });
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));
  evalInContext(sandbox, `api.getHomeContent=async()=>{throw new Error('нет сети');};`);
  assert.equal(await evalInContext(sandbox, 'loadHomeContent()'), null);
  assert.equal(evalInContext(sandbox, "document.getElementById('intro-title').textContent"), 'Есть текст');
});

test('B4: блок главной растёт по содержимому и ничего не обрезает', () => {
  const introRule = /\.intro\{([\s\S]*?)\}/.exec(STYLE_CSS)[1];
  assert.match(introRule, /height:auto/);
  assert.match(introRule, /min-height:0/);
  assert.ok(!/max-height/.test(introRule), 'ограничение высоты обрезало бы длинный текст');
  assert.ok(!/overflow:hidden/.test(introRule), 'скрытие переполнения обрезало бы длинный текст');
  assert.match(introRule, /padding:14px 20px 15px/, 'padding сохраняется');
  assert.match(introRule, /overflow-wrap:anywhere/, 'длинное слово не должно выпирать за кромку');
  // Перенос строк, сделанный владельцем в HQ, обязан сохраняться.
  assert.match(STYLE_CSS, /\.intro-title\{[^}]*white-space:pre-wrap/);
  assert.match(STYLE_CSS, /\.intro-text\{[^}]*white-space:pre-wrap/);
  // Пустые узлы до загрузки не оставляют полосы.
  assert.match(STYLE_CSS, /\.intro-title:empty,\.intro-text:empty\{display:none\}/);
});

// ---------------------------------------------------------------------------
// C. Бегущая строка
// ---------------------------------------------------------------------------

test('C1: один ресторан повторяется по всей ленте', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  setupMarquee(sandbox);
  evalInContext(sandbox, "renderMarquee([{name:'RAZRYAD'}])");
  const names = namesIn(sandbox);
  assert.ok(names.length >= 8, `лента должна быть длиннее экрана, получено ${names.length}`);
  assert.deepEqual([...new Set(names)], ['RAZRYAD']);
  assert.equal(evalInContext(sandbox, "document.getElementById('partners').hidden"), false);
});

test('C2: несколько ресторанов чередуются в порядке списка', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  setupMarquee(sandbox);
  evalInContext(sandbox, "renderMarquee([{name:'RAZRYAD'},{name:'RESTAURANT 2'}])");
  const names = namesIn(sandbox);
  assert.deepEqual(names.slice(0, 4), ['RAZRYAD', 'RESTAURANT 2', 'RAZRYAD', 'RESTAURANT 2']);
  assert.equal(names.length % 2, 0);
});

test('C3: трек состоит РОВНО из двух одинаковых половин — иначе цикл дёрнется', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  setupMarquee(sandbox);
  for (const list of [
    [{ name: 'A' }],
    [{ name: 'A' }, { name: 'B' }],
    [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
  ]) {
    evalInContext(sandbox, `renderMarquee(${JSON.stringify(list)})`);
    const names = namesIn(sandbox);
    const half = names.length / 2;
    assert.equal(names.length % 2, 0, 'нечётное число элементов не даёт двух одинаковых половин');
    assert.deepEqual(names.slice(0, half), names.slice(half),
      'вторая половина обязана повторять первую — на ней и держится бесшовный -50%');
  }
  // Анимация действительно сдвигает ровно на половину.
  assert.match(STYLE_CSS, /@keyframes scrollx\{from\{transform:translate3d\(0,0,0\)\}to\{transform:translate3d\(-50%,0,0\)\}\}/);
});

test('C4: половина трека всегда перекрывает экран — просвета в ленте не бывает', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  // Узкие названия и широкий экран — худший случай для одного ресторана.
  setupMarquee(sandbox, { trackWidthPerItem: 30, screenWidth: 1200 });
  evalInContext(sandbox, "renderMarquee([{name:'A'}])");
  const names = namesIn(sandbox);
  const halfWidth = (names.length / 2) * 30;
  assert.ok(halfWidth >= 1200, `половина трека (${halfWidth}px) должна перекрывать экран 1200px`);
});

test('C5: список ленты идёт от данных — новый ресторан появляется, снятый исчезает', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  setupMarquee(sandbox);

  evalInContext(sandbox, "renderMarquee([{name:'RAZRYAD'}])");
  assert.deepEqual([...new Set(namesIn(sandbox))], ['RAZRYAD']);

  // Подключили второй — он появляется сам, без правки вёрстки.
  evalInContext(sandbox, "renderMarquee([{name:'RAZRYAD'},{name:'NEW PLACE'}])");
  assert.deepEqual([...new Set(namesIn(sandbox))].sort(), ['NEW PLACE', 'RAZRYAD']);

  // Сняли с публикации — исчезает.
  evalInContext(sandbox, "renderMarquee([{name:'RAZRYAD'}])");
  assert.deepEqual([...new Set(namesIn(sandbox))], ['RAZRYAD']);

  // Не осталось ни одного — ленты нет вовсе, а не пустая полоса.
  evalInContext(sandbox, 'renderMarquee([])');
  assert.equal(namesIn(sandbox).length, 0);
  assert.equal(evalInContext(sandbox, "document.getElementById('partners').hidden"), true);
});

test('C6: названия экранируются и не слипаются — разделитель с воздухом', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  setupMarquee(sandbox);
  evalInContext(sandbox, `renderMarquee([{name:'<script>alert(1)</script>'},{name:'  Кафе  '}])`);
  const html = evalInContext(sandbox, "document.getElementById('ptrack').innerHTML");
  assert.ok(!html.includes('<script>'), 'название из БД не должно попадать в разметку как код');
  assert.ok(namesIn(sandbox).includes('Кафе'), 'края названия обрезаются');

  // Точка — ::after у каждого названия: она стоит и на шве между половинами,
  // поэтому при зацикливании два названия не оказываются вплотную.
  assert.match(STYLE_CSS, /\.pname::after\{content:"·"[^}]*margin:0 11px/);
  assert.match(STYLE_CSS, /\.pname\{[^}]*white-space:nowrap/);
});

test('C7: лента переживает отсутствие данных и мусор в них', (t) => {
  const { sandbox } = freshApp();
  t.after(() => teardown(sandbox));
  setupMarquee(sandbox);
  for (const bad of ['null', 'undefined', '[]', '[{},{name:null},{name:"   "}]', '"строка"']) {
    evalInContext(sandbox, `renderMarquee(${bad})`);
    assert.equal(namesIn(sandbox).length, 0, `renderMarquee(${bad}) не должна ничего рисовать`);
    assert.equal(evalInContext(sandbox, "document.getElementById('partners').hidden"), true);
  }
});
