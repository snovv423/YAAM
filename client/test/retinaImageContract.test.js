'use strict';

// RETINA / HIDPI PASS.
//
// Измерено на production до правки: карточка меню занимает 362 CSS px на
// iPhone при DPR 3 (нужно 1086 физических px) и 541 CSS px на Retina-десктопе
// при DPR 2 (нужно 1082), а отдавался card шириной 800 — то есть браузер
// растягивал растр в 1.35-1.36 раза. При DPR 1 запас был двукратным, поэтому
// более тяжёлый вариант там не нужен.
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

// Первое блюдо — с полным набором вариантов, второе — media старого образца,
// у которого HiDPI-варианта ещё нет (состояние во время выкатки).
function payload() {
  const urls = (n) => ({
    thumb: `https://cdn.test/${n}/thumb.webp`,
    card: `https://cdn.test/${n}/card.webp`,
    card2x: `https://cdn.test/${n}/card2x.webp`,
    full: `https://cdn.test/${n}/full.webp`,
  });
  const legacy = { thumb: 'https://cdn.test/old/thumb.webp', card: 'https://cdn.test/old/card.webp', full: 'https://cdn.test/old/full.webp' };
  return {
    id: 1, name: 'R', cuisine: '', cities: ['Аргун'], address: 'ул. 1', hours: '24',
    delivery_price: 0, min_order: 0, is_open: 1, is_new: 0, rating: 0, rating_count: 0,
    primary_photo: null, gallery: [],
    menu: [{ id: 1, name: 'Кат', items: [
      { id: 10, name: 'Новое медиа', price: 100, is_available: 1, weight_g: 200,
        primary_photo: { urls: urls('a'), crops: null, rotation: 0 },
        gallery: [{ alt: '', rotation: 0, crops: null, urls: urls('a') }] },
      { id: 11, name: 'Старое медиа', price: 200, is_available: 1, weight_g: 100,
        primary_photo: { urls: legacy, crops: null, rotation: 0 },
        gallery: [{ alt: '', rotation: 0, crops: null, urls: legacy }] },
    ] }],
  };
}

function cards(sandbox) {
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(payload())});`);
  return {
    modern: evalInContext(sandbox, 'dishCard(curRest.menu[0].items[0],0,0)'),
    legacy: evalInContext(sandbox, 'dishCard(curRest.menu[0].items[1],0,1)'),
  };
}

test('1. карточка предлагает два кандидата — 800w и HiDPI 1200w', () => {
  const sandbox = freshApi();
  const { modern } = cards(sandbox);
  assert.match(modern, /data-srcset="[^"]*card\.webp 800w[^"]*card2x\.webp 1200w"/,
    'браузер должен выбирать между обычным и HiDPI вариантом сам');
  assert.match(modern, /data-src="https:\/\/cdn\.test\/a\/card\.webp"/,
    'src остаётся 800-м вариантом — он же фолбэк для движков без srcset');
  teardown(sandbox);
});

test('2. sizes описывает реальную ширину карточки на всех брейкпоинтах', () => {
  const sandbox = freshApi();
  const { modern } = cards(sandbox);
  const sizes = (modern.match(/sizes="([^"]+)"/) || [])[1];
  assert.ok(sizes, 'без sizes браузер считает картинку во всю ширину окна и берёт лишнее');
  // Измеренные CSS-ширины: 362@390, 352@768, 541@1440, 468@1920.
  assert.match(sizes, /\(max-width:719px\) calc\(100vw - 28px\)/);
  assert.match(sizes, /\(min-width:1600px\) 470px/);
  assert.match(sizes, /\(min-width:1100px\) 545px/);
  teardown(sandbox);
});

test('3. фотография без HiDPI-варианта не получает srcset и не ломается', () => {
  // Во время выкатки старые медиа ещё без card2x. Ссылка на несуществующий
  // файл внутри srcset дала бы 404 и «Фото недоступно» вместо фотографии.
  const sandbox = freshApi();
  const { legacy } = cards(sandbox);
  assert.ok(!/srcset/.test(legacy), 'нет варианта — нет и кандидата');
  assert.match(legacy, /data-src="https:\/\/cdn\.test\/old\/card\.webp"/,
    'фотография продолжает показываться прежним вариантом');
  assert.ok(!/class="dphoto nophoto/.test(legacy));
  teardown(sandbox);
});

test('4. srcset назначается вместе с src, а не после него', () => {
  // Если сначала поставить src, загрузка 800-го варианта уже стартует, и
  // появившийся следом srcset приводит ко второй загрузке того же фото.
  const apply = APP.slice(APP.indexOf('function applyPhotoSources'), APP.indexOf('function clearPhotoSources'));
  const setIdx = apply.indexOf("setAttribute('srcset'");
  const srcIdx = apply.indexOf('img.src=');
  assert.ok(setIdx > -1 && srcIdx > -1 && setIdx < srcIdx,
    'srcset обязан выставляться раньше src');
  assert.match(APP, /applyPhotoSources\(img\)/);
});

test('5. выгрузка снимает оба источника', () => {
  // Оставленный srcset продолжал бы удерживать изображение, и защита памяти на
  // длинном меню перестала бы работать.
  const clear = APP.slice(APP.indexOf('function clearPhotoSources'));
  assert.match(clear.slice(0, 300), /removeAttribute\('srcset'\)/);
  assert.match(clear.slice(0, 300), /removeAttribute\('src'\)/);
});

test('6. деталь блюда по-прежнему берёт full, а не HiDPI-карточку', () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(payload())});`);
  const gallery = JSON.parse(evalInContext(sandbox, 'JSON.stringify(curRest.menu[0].items[0].gallery)'));
  assert.equal(gallery[0].full, 'https://cdn.test/a/full.webp',
    'на детали фотография крупная — карточный вариант там был бы мыльным');
  assert.equal(gallery[0].card, 'https://cdn.test/a/card.webp');
  teardown(sandbox);
});

test('7. HiDPI-вариант не превратился в повод грузить всё сразу', () => {
  // Более тяжёлый вариант делает дисциплину загрузки важнее, а не наоборот:
  // на iPhone при DPR 3 каждая карточка тянет 144 КБ вместо 69.
  assert.match(APP, /const IMG_MAX_INFLIGHT=\d+;/);
  assert.match(APP, /const IMG_NEAR_AHEAD=\d+;/);
  assert.match(APP, /const RESTAURANT_CACHE_TTL_MS\s*=\s*90000/);
  assert.match(APP, /PREFETCH_MAX_PARALLEL\s*=\s*1/);
  assert.match(APP, /fetchpriority/);
  assert.match(APP, /saveData/, 'при экономии трафика упреждение обязано сжиматься');
});

test('8. HiDPI-вариант доезжает из ответа API до модели карточки', () => {
  const sandbox = freshApi();
  evalInContext(sandbox, `curRest=normalizeRestaurant(${JSON.stringify(payload())});`);
  assert.equal(evalInContext(sandbox, 'curRest.menu[0].items[0].photoUrl2x'), 'https://cdn.test/a/card2x.webp');
  assert.equal(evalInContext(sandbox, 'curRest.menu[0].items[1].photoUrl2x'), '',
    'у старого медиа поле пустое, а не undefined — на нём построен фолбэк');
  teardown(sandbox);
});
