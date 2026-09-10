'use strict';

// ГОТОВНОСТЬ ФОТОГРАФИЙ МЕНЮ.
//
// Тесты написаны на причины, доказанные замером на production (LTE 10 Мбит/с,
// 70 мс, меню 109 блюд / 82 фотографии), а не на догадки:
//
//  1. Уже загруженная фотография выгружалась при обычной прокрутке: за один
//     проход вниз и обратно src снимался у 117 полностью загруженных
//     изображений при 82 уникальных, и назначений было 182 вместо 82. Сеть
//     этого не показывала (immutable-кэш), но каждое повторное назначение —
//     повторный декод, и на это время карточка снова пуста.
//  2. Прыжок по вкладке не готовил ничего: сразу после нажатия не готовы были
//     все видимые карточки (6 из 6, 4 из 4, 5 из 5).
//  3. Упреждение в 1.5 экрана давало ~0.6 с форы там, где фотография приезжает
//     за 1.3-2.2 с: из 82 карточек к моменту появления в кадре были готовы 22.
//
// Здесь проверяются решения всех трёх, а не «пороги как в задании».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const APP = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const VIEWPORT = 900;

// Песочница беднее браузера: в ней нет performance и innerHeight, без которых
// очередь не может измерить ни скорость, ни окно. Подставляем ровно их.
function menuSandbox() {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.performance = { now: () => Date.now() };
  loadAppInSandbox(sandbox);
  evalInContext(sandbox, `
    window.innerHeight=${VIEWPORT};
    document.getElementById('menu').classList.add('active');
  `);
  return sandbox;
}

// Синтетические карточки: geometry задаём напрямую, чтобы не зависеть от
// раскладки, которой в песочнице нет.
function seedPhotos(sandbox, spec) {
  evalInContext(sandbox, `
    globalThis.__mk=(i,top,state,head)=>{
      const img={dataset:{src:'https://cdn.test/'+i+'.webp',srcset:'',photoCrop:'null',photoRotation:'0'},
        attrs:{},listeners:{},complete:false,naturalWidth:0,
        getAttribute(n){return n==='src'?(this._src||null):(this.attrs[n]??null);},
        setAttribute(n,v){this.attrs[n]=String(v);},
        removeAttribute(n){if(n==='src')this._src=null;else delete this.attrs[n];},
        addEventListener(t,f){(this.listeners[t]=this.listeners[t]||[]).push(f);},
        get src(){return this._src||'';},
        set src(v){this._src=v;globalThis.__assigned.push(i);},
        style:new Proxy({},{get:(t,k)=>k==='setProperty'?(()=>{}):(t[k]??''),set:(t,k,v)=>{t[k]=v;return true;}})};
      if(state==='done'){img._src=img.dataset.src;img.complete=true;img.naturalWidth=1200;}
      return {el:{dataset:{}},img,top,bottom:top+300,head:!!head,order:i,state:state||'idle'};
    };
    globalThis.__assigned=[];
    menuPhotos=${JSON.stringify(spec)}.map((s,i)=>globalThis.__mk(i,s.top,s.state,s.head));
    menuPhotoMeasured=true;menuPhotoInflight=0;menuPhotoLastT=0;menuPhotoSpeed=0;
    menuPhotoFocusY=-1;menuPhotoFocusUntil=0;
  `);
}

const loadedCount = (s) => evalInContext(s, "menuPhotos.filter(p=>p.img&&p.img.getAttribute('src')).length");
const assigned = (s) => JSON.parse(evalInContext(s, 'JSON.stringify(globalThis.__assigned)'));

test('1. уже загруженная фотография не выгружается при обычной прокрутке', () => {
  // Главная причина «фото проявляются при возврате»: раньше отход на шесть
  // экранов снимал src, и возврат стоил повторного декода.
  const sandbox = menuSandbox();
  seedPhotos(sandbox, Array.from({ length: 40 }, (_, i) => ({ top: i * 400, state: 'done' })));
  const before = loadedCount(sandbox);
  evalInContext(sandbox, 'window.scrollY=15000;pumpPhotoQueue();');
  assert.equal(loadedCount(sandbox), before,
    'ни одна готовая фотография не должна потерять src при уходе далеко вниз');
  evalInContext(sandbox, 'window.scrollY=0;pumpPhotoQueue();');
  assert.equal(loadedCount(sandbox), before, 'и при возврате наверх — тоже');
  assert.deepEqual(assigned(sandbox), [], 'повторных назначений src нет');
  teardown(sandbox);
});

test('2. бюджет памяти срабатывает только при переполнении и жертвует дальними', () => {
  // Защита от патологически длинного меню обязана существовать, но не должна
  // трогать то, что рядом с человеком.
  const sandbox = menuSandbox();
  const budget = evalInContext(sandbox, 'IMG_LOADED_BUDGET');
  const n = budget + 40;
  seedPhotos(sandbox, Array.from({ length: n }, (_, i) => ({ top: i * 400, state: 'done' })));
  evalInContext(sandbox, 'window.scrollY=0;pumpPhotoQueue();');
  assert.equal(loadedCount(sandbox), budget, 'сверх бюджета удерживать нечего');
  const nearKept = evalInContext(sandbox,
    "menuPhotos.slice(0,6).every(p=>p.img.getAttribute('src'))");
  assert.equal(nearKept, true, 'ближайшие к экрану остаются загруженными');
  const farDropped = evalInContext(sandbox,
    "menuPhotos.slice(-20).every(p=>!p.img.getAttribute('src'))");
  assert.equal(farDropped, true, 'выгружаются самые дальние');
  teardown(sandbox);
});

test('3. одновременных загрузок не больше заданного числа', () => {
  // Замер показал монотонную зависимость: чем шире очередь, тем меньше канала
  // достаётся ближайшей фотографии и тем позже она готова.
  const sandbox = menuSandbox();
  seedPhotos(sandbox, Array.from({ length: 30 }, (_, i) => ({ top: i * 100 })));
  evalInContext(sandbox, 'window.scrollY=0;pumpPhotoQueue();');
  const max = evalInContext(sandbox, 'IMG_MAX_INFLIGHT');
  assert.equal(assigned(sandbox).length, max);
  evalInContext(sandbox, 'pumpPhotoQueue();');
  assert.equal(assigned(sandbox).length, max, 'повторный вызов не расширяет очередь');
  teardown(sandbox);
});

test('4. порядок загрузки — по расстоянию до человека, а не по порядку в разметке', () => {
  // Прежний наблюдатель не упорядочивал ничего: карточка у самого экрана могла
  // ждать в очереди за десятком тех, что ниже.
  // Карточки лежат в разметке от дальней к ближней: порядок обхода DOM и
  // порядок по расстоянию здесь противоположны, и перепутать их нельзя.
  const sandbox = menuSandbox();
  // Расстояния попарно различны, чтобы ничья не решалась порядком разметки:
  // при равном расстоянии он как раз и есть законный тайбрейк.
  seedPhotos(sandbox, [{ top: 4000 }, { top: 3000 }, { top: 2000 }, { top: 1000 }, { top: 0 }]);
  evalInContext(sandbox, 'window.scrollY=0;pumpPhotoQueue();');
  assert.deepEqual(assigned(sandbox), [4, 3, 2],
    'первыми уходят ближайшие к окну, а не первые в разметке');
  teardown(sandbox);
});

test('5. прыжок по категории готовит цель до окончания долистывания', () => {
  // Причина №2: раньше фотографии целевой категории запрашивались только по
  // прибытии, и вкладка открывалась пустой.
  const sandbox = menuSandbox();
  seedPhotos(sandbox, [{ top: 200 }, { top: 9000 }, { top: 9400 }, { top: 9800 }]);
  evalInContext(sandbox, 'window.scrollY=0;focusPhotoQueue(9000);pumpPhotoQueue();');
  const got = assigned(sandbox);
  assert.ok(got.includes(1) && got.includes(2),
    'фотографии у цели прыжка запрашиваются сразу, хотя прокрутка ещё наверху');
  teardown(sandbox);
});

test('6. прыжок сообщается очереди раньше самой прокрутки', () => {
  const jump = APP.slice(APP.indexOf('function scrollToMenuSection'));
  const body = jump.slice(0, jump.indexOf('\n}'));
  assert.ok(body.indexOf('focusPhotoQueue(target)') > -1, 'цель передаётся очереди');
  assert.ok(body.indexOf('focusPhotoQueue(target)') < body.indexOf('window.scrollTo'),
    'иначе подготовка начнётся уже после долистывания и смысл теряется');
});

test('7. голова каждой категории помечена — по фотографиям, а не по блюдам', () => {
  // Категория, у которой первые позиции без фото, иначе «прогревалась» бы
  // пустыми карточками.
  const sandbox = menuSandbox();
  const urls = (n) => ({ thumb: `t${n}`, card: `c${n}`, card2x: `c2${n}`, full: `f${n}` });
  const item = (id, withPhoto) => ({ id, name: 'Б' + id, price: 100, is_available: 1, weight_g: 1,
    primary_photo: withPhoto ? { urls: urls(id), crops: null, rotation: 0 } : null, gallery: [] });
  const payload = { id: 1, name: 'R', cuisine: '', cities: ['Аргун'], address: 'ул. 1', hours: '24',
    delivery_price: 0, min_order: 0, is_open: 1, is_new: 0, rating: 0, rating_count: 0,
    primary_photo: null, gallery: [],
    menu: [{ name: 'K', items: [item(1, false), item(2, false), ...Array.from({ length: 8 }, (_, i) => item(10 + i, true))] }] };
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(payload)});`);
  const warm = evalInContext(sandbox, 'IMG_CATEGORY_WARM');
  const cards = evalInContext(sandbox, `
    curRest.menu[0].items.map((d,ii)=>{
      if(!globalThis.__seen)globalThis.__seen=0;
      const head=!!(d.photoUrl||d.im)&&globalThis.__seen++<IMG_CATEGORY_WARM;
      return dishCard(d,0,ii,head);
    }).join('|||')
  `).split('|||');
  assert.equal(cards.slice(0, 2).some(c => c.includes('data-head')), false,
    'блюда без фото головой не считаются');
  assert.equal(cards.filter(c => c.includes('data-head="1"')).length, warm);
  teardown(sandbox);
});

test('8. момент загрузки решает очередь, а не lazy-эвристика браузера', () => {
  // При упреждении в несколько экранов loading="lazy" мог бы отложить загрузку,
  // которую очередь считает уже начатой, и слот завис бы занятым.
  const sandbox = menuSandbox();
  const urls = { thumb: 't', card: 'c', card2x: 'c2', full: 'f' };
  const payload = { id: 1, name: 'R', cuisine: '', cities: ['Аргун'], address: 'ул. 1', hours: '24',
    delivery_price: 0, min_order: 0, is_open: 1, is_new: 0, rating: 0, rating_count: 0,
    primary_photo: null, gallery: [],
    menu: [{ name: 'K', items: [{ id: 1, name: 'Б', price: 1, is_available: 1, weight_g: 1,
      primary_photo: { urls, crops: null, rotation: 0 }, gallery: [] }] }] };
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(payload)});`);
  const card = evalInContext(sandbox, 'dishCard(curRest.menu[0].items[0],0,0,true)');
  assert.ok(!/loading="lazy"/.test(card), 'lazy убран — момент загрузки принадлежит очереди');
  assert.match(APP.slice(APP.indexOf('function startPhotoLoad')), /setAttribute\('loading','eager'\)/);
  teardown(sandbox);
});

test('9. экономия трафика сужает упреждение до ближайшего экрана', () => {
  const sandbox = menuSandbox();
  evalInContext(sandbox, 'navigator.connection={saveData:true,effectiveType:"4g"};');
  assert.equal(evalInContext(sandbox, 'nearAheadScreens()'), 1);
  evalInContext(sandbox, 'navigator.connection={saveData:false,effectiveType:"2g"};');
  assert.equal(evalInContext(sandbox, 'nearAheadScreens()'), 1, 'на медленной сети мегабайт дороже мгновенности');
  evalInContext(sandbox, 'navigator.connection=undefined;');
  assert.ok(evalInContext(sandbox, 'nearAheadScreens()') >= evalInContext(sandbox, 'IMG_REST_AHEAD'));
  teardown(sandbox);
});

test('10. упреждение растёт от скорости прокрутки и не превышает потолок', () => {
  // Постоянное упреждение в пять экранов стоило 3.34 МБ на «открыл и не листает»
  // против 2.73 МБ у переменного при той же нулевой доле пустых кадров.
  const sandbox = menuSandbox();
  seedPhotos(sandbox, [{ top: 0 }]);
  const rest = evalInContext(sandbox, 'IMG_REST_AHEAD');
  const cap = evalInContext(sandbox, 'IMG_NEAR_AHEAD');
  evalInContext(sandbox, 'window.scrollY=0;updateScrollSpeed();');
  assert.equal(evalInContext(sandbox, 'nearAheadScreens()'), rest, 'стоящему хватает ближних экранов');
  evalInContext(sandbox, 'menuPhotoSpeed=4000;');
  assert.equal(evalInContext(sandbox, 'nearAheadScreens()'), cap, 'летящему — весь потолок');
  assert.ok(rest < cap);
  teardown(sandbox);
});

test('11. загруженная фотография не запрашивается повторно', () => {
  const sandbox = menuSandbox();
  seedPhotos(sandbox, [{ top: 0, state: 'done' }, { top: 300 }]);
  evalInContext(sandbox, 'window.scrollY=0;pumpPhotoQueue();');
  assert.deepEqual(assigned(sandbox), [1], 'запрашивается только та, у которой src ещё нет');
  teardown(sandbox);
});
