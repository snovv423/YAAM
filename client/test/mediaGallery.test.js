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

test('renderGallery: одна фотография — тумб-стрип пуст, стрелки и счётчик скрыты (задание: "no unnecessary arrows")', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  setDishWithGallery(sandbox, [apiPhotoNormalized('solo', 'Единственное фото')]);
  evalInContext(sandbox, "openDish('0_0')");
  assert.equal(sandbox.document.getElementById('d-gallery').innerHTML, '');
  assert.equal(sandbox.document.getElementById('d-gprev').style.display, 'none');
  assert.equal(sandbox.document.getElementById('d-gnext').style.display, 'none');
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

test('renderGallery: prefix "m" (ресторан) — стрелки принудительно скрыты даже при нескольких фото, счётчик остаётся', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  evalInContext(sandbox, `renderGallery('m', ${toContextLiteral([apiPhotoNormalized('x', 'X'), apiPhotoNormalized('y', 'Y')])}, false)`);
  assert.equal(sandbox.document.getElementById('m-gprev').style.display, 'none');
  assert.equal(sandbox.document.getElementById('m-gnext').style.display, 'none');
  assert.equal(sandbox.document.getElementById('m-gcount').style.display, 'block');
  teardown(sandbox);
});

test('gallerySet/galleryStep: счётчик обновляется и индекс оборачивается по модулю (нет выхода за границы)', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral([apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')])}, true)`);
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3');
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '2 / 3');
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  // Следующий шаг должен обернуться на первую фотографию, не бросить и не
  // застрять на "4 / 3".
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3');
  // Шаг назад с первой фотографии — на последнюю (модуль, не отрицательный индекс).
  evalInContext(sandbox, "galleryStep('d', -1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  teardown(sandbox);
});

// normalizeRestaurant уже приводит к форме {thumb,card,full,alt} — эта
// вспомогательная функция строит фотографию СРАЗУ в этой пост-нормализованной
// форме (тесты выше на renderGallery работают с уже нормализованным curRest,
// тем же приёмом, что setMenu() в menuRendering.test.js).
function apiPhotoNormalized(suffix, alt) {
  return { thumb: `https://cdn.test/${suffix}-thumb.webp`, card: `https://cdn.test/${suffix}-card.webp`, full: `https://cdn.test/${suffix}-full.webp`, alt: alt || '' };
}
