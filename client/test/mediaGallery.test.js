// YAAM HQ Stage 5B — клиентские тесты медиа-галереи (задание, раздел 14C):
// primary/gallery ресторана и блюда, fallback (нет фото вовсе), XSS-
// безопасность alt-текста, одна фотография vs несколько, клавиатурная
// доступность миниатюр (реальные <button>, не <div onclick>).
//
// Тот же established-паттерн, что и client/test/menuRendering.test.js:
// загружает РЕАЛЬНЫЙ client/js/app.js через test/helpers/loadApp.js
// (node:vm), не переписанную копию.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

// Передаёт JS-объект в vm-контекст безопасно независимо от содержимого
// (кавычки/HTML/бэктики в alt-тексте XSS-теста) — двойной JSON.stringify
// производит корректный JS-строковый литерал, который парсится обратно
// внутри контекста.
function toContextLiteral(value) {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function apiPhoto(suffix, alt) {
  return {
    alt: alt || '',
    urls: { thumb: `https://cdn.test/${suffix}-thumb.webp`, card: `https://cdn.test/${suffix}-card.webp`, full: `https://cdn.test/${suffix}-full.webp` },
    crops: { menu_card: null, dish_detail: null },
  };
}

// --- normalizeRestaurant: primary_photo/gallery -> photoUrl/gallery ---

test('normalizeRestaurant: ресторан с primary_photo и gallery — корректный маппинг thumb/card/full/alt', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const apiRestaurant = {
    id: 1, name: 'Кафе', menu: [],
    primary_photo: apiPhoto('a', 'Фасад'),
    gallery: [apiPhoto('a', 'Фасад'), apiPhoto('b', 'Зал')],
  };
  const normalized = evalInContext(sandbox, `JSON.stringify(normalizeRestaurant(${toContextLiteral(apiRestaurant)}))`);
  const r = JSON.parse(normalized);
  assert.equal(r.photoUrl, 'https://cdn.test/a-card.webp');
  assert.equal(r.gallery.length, 2);
  assert.equal(r.gallery[0].full, 'https://cdn.test/a-full.webp');
  assert.equal(r.gallery[1].alt, 'Зал');
  teardown(sandbox);
});

test('normalizeRestaurant: сохраняет независимые crop-параметры блюда', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const photo = apiPhoto('dish', '');
  photo.crops = { menu_card: { x: 0, y: 0.2, width: 0.7, height: 0.3 }, dish_detail: { x: 0.1, y: 0, width: 0.9, height: 0.9 } };
  photo.rotation = 90;
  const value = { id: 1, name: 'Кафе', menu: [{ name: 'Кат', items: [{ id: 2, name: 'Блюдо', price: 100, primary_photo: photo, gallery: [photo] }] }] };
  const normalized = JSON.parse(evalInContext(sandbox, `JSON.stringify(normalizeRestaurant(${toContextLiteral(value)}))`));
  assert.deepEqual(normalized.menu[0].items[0].photoCrop, photo.crops.menu_card);
  assert.deepEqual(normalized.menu[0].items[0].gallery[0].crops.dish_detail, photo.crops.dish_detail);
  assert.equal(normalized.menu[0].items[0].photoRotation, 90);
  assert.equal(normalized.menu[0].items[0].gallery[0].rotation, 90);
  teardown(sandbox);
});

test('filled crop painter keeps persisted rotation and uses cover geometry for crop and fallback', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const result = JSON.parse(evalInContext(sandbox, `(()=>{const parent={getBoundingClientRect:()=>({width:700,height:300})};const img={naturalWidth:900,naturalHeight:1600,parentElement:parent,style:{},complete:true};applyFilledCrop(img,{x:0,y:0.35,width:1,height:3/7},90);return JSON.stringify(img.style)})()`));
  assert.match(result.transform, /^matrix\(0,1,-1,0,/);
  assert.ok(parseFloat(result.width) >= 700);
  assert.ok(parseFloat(result.height) >= 300);
  const fallback = JSON.parse(evalInContext(sandbox, `(()=>{const parent={getBoundingClientRect:()=>({width:300,height:300})};const img={naturalWidth:1600,naturalHeight:900,parentElement:parent,style:{},complete:true};applyFilledCrop(img,null,0);return JSON.stringify(img.style)})()`));
  assert.equal(parseFloat(fallback.height), 300);
  assert.ok(parseFloat(fallback.width) > 300);
  teardown(sandbox);
});

test('normalizeRestaurant: primary_photo=null, gallery=[] (нет фото вовсе) -> photoUrl="", gallery=[]', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const apiRestaurant = { id: 2, name: 'Без фото', menu: [], primary_photo: null, gallery: [] };
  const normalized = evalInContext(sandbox, `JSON.stringify(normalizeRestaurant(${toContextLiteral(apiRestaurant)}))`);
  const r = JSON.parse(normalized);
  assert.equal(r.photoUrl, '');
  assert.deepEqual(r.gallery, []);
  teardown(sandbox);
});

test('normalizeRestaurant: блюдо внутри меню тоже получает photoUrl/gallery из primary_photo/gallery', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const apiRestaurant = {
    id: 3, name: 'Кафе', menu: [{
      name: 'Кат', items: [{
        id: 10, name: 'Блюдо', price: 100,
        primary_photo: apiPhoto('dish', 'Блюдо крупным планом'),
        gallery: [apiPhoto('dish', 'Блюдо крупным планом')],
      }],
    }],
  };
  const normalized = evalInContext(sandbox, `JSON.stringify(normalizeRestaurant(${toContextLiteral(apiRestaurant)}))`);
  const r = JSON.parse(normalized);
  const item = r.menu[0].items[0];
  assert.equal(item.photoUrl, 'https://cdn.test/dish-card.webp');
  assert.equal(item.gallery[0].thumb, 'https://cdn.test/dish-thumb.webp');
  teardown(sandbox);
});

// --- renderGallery / gallerySet / galleryStep ---

function setDishWithGallery(sandbox, photos) {
  const restaurant = {
    name: 'Тестовый ресторан', hours: '', votes: 0, rate: 0,
    menu: [{ cat: 'Кат', items: [{ id: 1, n: 'Блюдо', d: '', p: 100, available: true, gallery: photos }] }],
  };
  evalInContext(sandbox, `curRest = ${JSON.stringify(restaurant)}`);
}

test('renderGallery: несколько фото — тумб-стрип из настоящих <button> с aria-label, первый активен, XSS-alt экранирован', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  setDishWithGallery(sandbox, [
    apiPhotoNormalized('a', '"><script>alert(1)</script>'),
    apiPhotoNormalized('b', 'Второе фото'),
  ]);
  evalInContext(sandbox, "openDish('0_0')");
  const html = sandbox.document.getElementById('d-gallery').innerHTML;
  assert.match(html, /<button type="button" class="thumb on"/, 'первая миниатюра должна быть реальным <button> с классом on');
  assert.match(html, /aria-label="Фото 1 из 2"/);
  assert.match(html, /aria-label="Фото 2 из 2"/);
  // Клавиатурная доступность (задание, раздел 10): реальные <button>, не <div onclick>.
  assert.doesNotMatch(html, /<div class="thumb"/);
  // XSS: сырой <script> не должен появиться в innerHTML — esc() должен были
  // превратить его в текстовые сущности внутри atribute alt="...".
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  teardown(sandbox);
});

test('public markup and CSS remove circular gallery arrows and keep vertical touch scrolling', () => {
  const clientDir = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(clientDir, 'css', 'style.css'), 'utf8');
  assert.doesNotMatch(html, /class="gnav|id="[md]-g(?:prev|next)"/);
  assert.doesNotMatch(css, /\.gnav/);
  const dishHeroRule = css.match(/\.dhero\{[^}]*\}/)?.[0] || '';
  assert.match(dishHeroRule, /touch-action:pan-y pinch-zoom/);
  assert.doesNotMatch(dishHeroRule, /touch-action\s*:\s*none/);
});

test('renderGallery: одна фотография — тумб-стрип и счётчик скрыты', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  setDishWithGallery(sandbox, [apiPhotoNormalized('solo', 'Единственное фото')]);
  evalInContext(sandbox, "openDish('0_0')");
  assert.equal(sandbox.document.getElementById('d-gallery').innerHTML, '');
  assert.equal(sandbox.document.getElementById('d-gcount').style.display, 'none');
  teardown(sandbox);
});

test('renderGallery: без фото вовсе — nophoto-заглушка, галерея не рендерится, без исключений', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  setDishWithGallery(sandbox, []);
  assert.doesNotThrow(() => evalInContext(sandbox, "openDish('0_0')"));
  const hero = sandbox.document.getElementById('d-hero');
  assert.ok(hero.classList.contains('nophoto'));
  assert.equal(sandbox.document.getElementById('d-gallery').innerHTML, '');
  teardown(sandbox);
});

test('renderGallery: prefix "m" (ресторан) — счётчик и thumbnails остаются', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  evalInContext(sandbox, `renderGallery('m', ${toContextLiteral([apiPhotoNormalized('x', 'X'), apiPhotoNormalized('y', 'Y')])})`);
  assert.equal(sandbox.document.getElementById('m-gcount').style.display, 'block');
  assert.match(sandbox.document.getElementById('m-gallery').innerHTML, /Фото 2 из 2/);
  teardown(sandbox);
});

test('gallerySet/galleryStep: hero, счётчик и active thumbnail синхронны, края не зацикливаются', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const heroImg = sandbox.document.createElement('img');
  sandbox.document.querySelector = selector => selector === '#d-hero img' ? heroImg : sandbox.document.createElement('div');
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral([apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')])})`);
  const thumbs = [sandbox.document.createElement('button'), sandbox.document.createElement('button'), sandbox.document.createElement('button')];
  sandbox.document.getElementById('d-gallery').querySelectorAll = selector => selector === '.thumb' ? thumbs : [];
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3');
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '2 / 3');
  assert.equal(heroImg.src, 'https://cdn.test/b-full.webp');
  assert.equal(thumbs[1].classList.contains('on'), true);
  assert.equal(thumbs[0].classList.contains('on'), false);
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  evalInContext(sandbox, "gallerySet('d', 0)");
  evalInContext(sandbox, "galleryStep('d', -1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3');
  evalInContext(sandbox, "gallerySet('d', 2)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  assert.equal(thumbs[2].classList.contains('on'), true);
  assert.equal(heroImg.src, 'https://cdn.test/c-full.webp');
  teardown(sandbox);
});

test('dish hero swipe changes photo horizontally, ignores vertical scroll gesture, and does not duplicate listeners', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const photos = [apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')];
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  const hero = sandbox.document.getElementById('d-hero');
  const count = sandbox.document.getElementById('d-gcount');
  hero.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 300, clientY: 200 }] });
  hero.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 120, clientY: 208 }] });
  assert.equal(count.textContent, '2 / 3', 'swipe left advances exactly once');
  hero.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 120, clientY: 200 }] });
  hero.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 300, clientY: 205 }] });
  assert.equal(count.textContent, '1 / 3', 'swipe right returns to previous photo');
  hero.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 180, clientY: 200 }] });
  hero.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 190, clientY: 360 }] });
  assert.equal(count.textContent, '1 / 3', 'vertical gesture does not change the gallery');
  hero.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 300, clientY: 200 }] });
  hero.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 120, clientY: 205 }] });
  hero.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 300, clientY: 200 }] });
  hero.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 120, clientY: 205 }] });
  hero.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 300, clientY: 200 }] });
  hero.dispatchEvent({ type: 'touchend', changedTouches: [{ clientX: 120, clientY: 205 }] });
  assert.equal(count.textContent, '3 / 3', 'last photo is a hard boundary');
  teardown(sandbox);
});

// normalizeRestaurant уже приводит к форме {thumb,card,full,alt} — эта
// вспомогательная функция строит фотографию СРАЗУ в этой пост-нормализованной
// форме (тесты выше на renderGallery работают с уже нормализованным curRest,
// тем же приёмом, что setMenu() в menuRendering.test.js).
function apiPhotoNormalized(suffix, alt) {
  return { thumb: `https://cdn.test/${suffix}-thumb.webp`, card: `https://cdn.test/${suffix}-card.webp`, full: `https://cdn.test/${suffix}-full.webp`, alt: alt || '' };
}
