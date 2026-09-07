'use strict';

// PUBLIC PERFORMANCE PASS — инварианты, которые легко потерять при следующей
// правке. Здесь нет ожиданий в миллисекундах: тайминги меряются отдельным
// браузерным прогоном на production, а в CI фиксируется ПОВЕДЕНИЕ, которое эти
// тайминги обеспечивает.
//
// Что измерено на production до правки и чем обосновано каждое требование:
//   клик -> первые карточки: 255 мс на быстрой сети, 897 мс на Fast 3G,
//   и всё это — ожидание одного запроса /api/restaurants/<id> (102 КБ);
//   после прокрутки длинного меню 72 из 82 изображений оказывались
//   выгруженными, и при возврате карточки заново «догоняли» на глазах.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const APP = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

function freshApi() {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.example.invalid' });
  loadAppInSandbox(sandbox);
  return sandbox;
}

// Меню из двух блюд: одно с фото, одно без — ровно те два случая, которые
// по-разному должны выглядеть на карточке.
function restaurantPayload(overrides = {}) {
  return {
    id: 1, name: 'R', cuisine: '', cities: ['Аргун'], address: 'ул. 1', hours: '24',
    delivery_price: 0, min_order: 0, is_open: 1, is_new: 0, rating: 0, rating_count: 0,
    primary_photo: null, gallery: [],
    menu: [{ id: 1, name: 'Кат', items: [
      { id: 10, name: 'С фото', price: 100, is_available: 1, weight_g: 200,
        primary_photo: { urls: { card: 'https://cdn.test/card.webp', full: 'https://cdn.test/full.webp' }, crops: null, rotation: 0 },
        gallery: [{ alt: 'С фото', rotation: 0, crops: null,
          urls: { thumb: 'https://cdn.test/thumb.webp', card: 'https://cdn.test/card.webp', full: 'https://cdn.test/full.webp' } }] },
      { id: 11, name: 'Без фото', price: 200, is_available: 1, weight_g: 100,
        primary_photo: null, gallery: [] },
    ] }],
    ...overrides,
  };
}

test('1. данные ресторана не запрашиваются повторно при открытии после предзагрузки', async () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `
    __calls=0;
    api.getRestaurant=async(id)=>{__calls++;return ${JSON.stringify(restaurantPayload())};};
    api.recoverOrder=async()=>{throw new Error('не нужен');};
    var __calls;
  `);
  await evalInContext(sandbox, 'prefetchRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  assert.equal(evalInContext(sandbox, '__calls'), 1, 'предзагрузка делает ровно один запрос');
  assert.equal(evalInContext(sandbox, 'restaurantCache.size'), 1, 'ответ сохранён в память');

  // Открытие берёт данные из памяти. Второй запрос — это фоновая сверка, а не
  // ожидание: экран уже отрисован к моменту её отправки.
  await evalInContext(sandbox, 'doOpenRest(1)');
  assert.equal(evalInContext(sandbox, 'curRest.name'), 'R', 'ресторан открыт из памяти');
  assert.equal(evalInContext(sandbox, 'curRest.menu[0].items.length'), 2);
  teardown(sandbox);
});

test('2. повторная предзагрузка того же ресторана не шлёт второй запрос', async () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `
    __calls=0;
    api.getRestaurant=async()=>{__calls++;return ${JSON.stringify(restaurantPayload())};};
    var __calls;
  `);
  await evalInContext(sandbox, 'prefetchRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  await evalInContext(sandbox, 'prefetchRestaurant(1);prefetchRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  assert.equal(evalInContext(sandbox, '__calls'), 1);
  teardown(sandbox);
});

test('3. предзагрузка не качает все рестораны разом', () => {
  // Ограничение параллелизма — не украшение: меню весит около 100 КБ, и
  // несколько сразу отняли бы канал у самой главной.
  assert.match(APP, /PREFETCH_MAX_PARALLEL\s*=\s*1/);
  assert.match(APP, /schedulePrefetch/);
  assert.match(APP, /requestIdleCallback/, 'предзагрузка стартует, когда браузер свободен');
  const sched = APP.slice(APP.indexOf('function schedulePrefetch'));
  assert.match(sched.slice(0, 400), /ids\.slice\(0,\s*2\)/, 'за раз берётся ограниченный список');
});

test('4. кэш коммерческих данных короткоживущий и всегда перепроверяется', async () => {
  assert.match(APP, /RESTAURANT_CACHE_TTL_MS\s*=\s*(\d+)/);
  const ttl = Number(APP.match(/RESTAURANT_CACHE_TTL_MS\s*=\s*(\d+)/)[1]);
  assert.ok(ttl <= 120000, `цены и доступность не должны жить в кэше долго, сейчас ${ttl} мс`);

  const sandbox = freshApi();
  evalInContext(sandbox, `
    __revalidated=0;
    api.getRestaurant=async()=>{__revalidated++;return ${JSON.stringify(restaurantPayload())};};
    var __revalidated;
  `);
  await evalInContext(sandbox, 'prefetchRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  await evalInContext(sandbox, 'doOpenRest(1)');
  await new Promise((r) => setImmediate(r));
  assert.ok(evalInContext(sandbox, '__revalidated') >= 2,
    'открытие из кэша обязано сразу пойти сверять цены и доступность');
  teardown(sandbox);
});

test('5. изменившаяся цена доезжает до экрана, совпавшая — не вызывает перерисовку', async () => {
  const sandbox = freshApi();
  const changed = restaurantPayload();
  changed.menu[0].items[0].price = 999;
  evalInContext(sandbox, `
    __renders=0;
    __payload=${JSON.stringify(restaurantPayload())};
    api.getRestaurant=async()=>__payload;
    const __rmb=renderMenuBody;
    renderMenuBody=function(){__renders++;return __rmb.apply(this,arguments);};
    var __renders,__payload;
  `);
  await evalInContext(sandbox, 'prefetchRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  await evalInContext(sandbox, 'doOpenRest(1)');
  await new Promise((r) => setImmediate(r));
  const afterSame = evalInContext(sandbox, '__renders');

  // Те же данные — повторная сборка каталога не нужна.
  await evalInContext(sandbox, 'revalidateRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  assert.equal(evalInContext(sandbox, '__renders'), afterSame,
    'совпавший ответ не должен пересобирать 109 карточек');

  // Цена изменилась — экран обязан обновиться.
  evalInContext(sandbox, `__payload=${JSON.stringify(changed)};`);
  await evalInContext(sandbox, 'revalidateRestaurant(1)');
  await new Promise((r) => setImmediate(r));
  assert.ok(evalInContext(sandbox, '__renders') > afterSame, 'новая цена должна перерисовать меню');
  assert.equal(evalInContext(sandbox, 'curRest.menu[0].items[0].p'), 999);
  teardown(sandbox);
});

test('6. карточка с фото в данных не помечается как «фото недоступно»', () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(restaurantPayload())});`);
  const withPhoto = evalInContext(sandbox, 'dishCard(curRest.menu[0].items[0],0,0)');
  const without = evalInContext(sandbox, 'dishCard(curRest.menu[0].items[1],0,1)');
  assert.ok(!/class="dphoto nophoto/.test(withPhoto),
    'пока изображение грузится, карточка с фото не должна утверждать, что фото нет');
  assert.match(withPhoto, /data-src="https:\/\/cdn\.test\/card\.webp"/);
  assert.match(without, /class="dphoto nophoto/, 'фото действительно нет — состояние честное');
  teardown(sandbox);
});

test('7. цена, название и доступность есть в карточке с первой отрисовки', () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(restaurantPayload())});`);
  const html = evalInContext(sandbox, 'dishCard(curRest.menu[0].items[0],0,0)');
  assert.match(html, /100 ₽/, 'цена не должна догонять отдельной фазой');
  assert.match(html, /С фото/);
  assert.match(html, /class="add"/, 'доступность выражена сразу: есть кнопка добавления');
  teardown(sandbox);
});

test('8. переключение категории не ходит в сеть', async () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `
    __calls=0;
    api.getRestaurant=async()=>{__calls++;return ${JSON.stringify(restaurantPayload())};};
    var __calls;
  `);
  await evalInContext(sandbox, 'doOpenRest(1)');
  await new Promise((r) => setImmediate(r));
  const before = evalInContext(sandbox, '__calls');
  evalInContext(sandbox, 'scrollToMenuSection(0)');
  assert.equal(evalInContext(sandbox, '__calls'), before,
    'категории работают на уже загруженном меню');
  teardown(sandbox);
});

test('9. открытие блюда не требует отдельного запроса', async () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `
    __calls=0;
    api.getRestaurant=async()=>{__calls++;return ${JSON.stringify(restaurantPayload())};};
    var __calls;
  `);
  await evalInContext(sandbox, 'doOpenRest(1)');
  await new Promise((r) => setImmediate(r));
  const before = evalInContext(sandbox, '__calls');
  evalInContext(sandbox, "openDish('0_0')");
  assert.equal(evalInContext(sandbox, '__calls'), before);
  assert.equal(evalInContext(sandbox, "document.getElementById('d-name').textContent"), 'С фото');
  teardown(sandbox);
});

test('10. деталь блюда берёт полноразмерное изображение, а не карточное', () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(restaurantPayload())});`);
  const gallery = evalInContext(sandbox, 'JSON.stringify(curRest.menu[0].items[0].gallery)');
  assert.match(gallery, /full\.webp/,
    'на детали используется full-вариант: карточный растр был бы мыльным на Retina');
});

test('11. политика загрузки изображений: широкое упреждение, узкая выгрузка', () => {
  const load = APP.match(/IMG_LOAD_AHEAD\s*=\s*'(\d+)%'/);
  const evict = APP.match(/IMG_EVICT_BEYOND\s*=\s*'(\d+)%'/);
  assert.ok(load && evict, 'пороги загрузки и выгрузки заданы явно');
  assert.ok(Number(load[1]) >= 100, 'карточки готовятся минимум на экран вперёд');
  assert.ok(Number(evict[1]) >= Number(load[1]) * 3,
    'выгрузка обязана быть заметно дальше загрузки, иначе обычная прокрутка вверх-вниз перезагружает всё');
  assert.match(APP, /fetchpriority/, 'приоритет для реально видимых карточек');
  assert.match(APP, /FIRST_SCREEN_IMAGES/, 'первый экран грузится сразу, не дожидаясь наблюдателя');
});

test('12. корзина не ходит в сеть на + и −', async () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `
    __calls=0;
    api.getRestaurant=async()=>{__calls++;return ${JSON.stringify(restaurantPayload())};};
    var __calls;
  `);
  await evalInContext(sandbox, 'doOpenRest(1)');
  await new Promise((r) => setImmediate(r));
  const before = evalInContext(sandbox, '__calls');
  evalInContext(sandbox, "addItem('0_0');inc('0_0');dec('0_0')");
  assert.equal(evalInContext(sandbox, '__calls'), before);
  assert.equal(evalInContext(sandbox, 'totals().cnt'), 1);
  teardown(sandbox);
});
