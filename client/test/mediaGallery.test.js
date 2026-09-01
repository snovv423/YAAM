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
  const js = fs.readFileSync(path.join(clientDir, 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /class="gnav|id="[md]-g(?:prev|next)"/);
  assert.doesNotMatch(css, /\.gnav/);
  const dishHeroRule = css.match(/\.dhero\{[^}]*\}/)?.[0] || '';
  assert.match(dishHeroRule, /touch-action:pan-y pinch-zoom/);
  assert.doesNotMatch(dishHeroRule, /touch-action\s*:\s*none/);
  assert.match(css, /\.dhero-track\.snapping\{transition:transform 260ms cubic-bezier\(\.22,1,\.36,1\)\}/);
  assert.match(css, /\.dhero-slide\{[^}]*flex:0 0 100%/);
  const dragSource = js.slice(js.indexOf('function bindGalleryDrag'), js.indexOf('function destroyGallery'));
  assert.match(dragSource, /pointerdown/);
  assert.match(dragSource, /pointermove/);
  assert.match(dragSource, /pointerup/);
  assert.match(dragSource, /preventDefault/);
  assert.match(dragSource, /\{passive:false\}/);
  assert.match(dragSource, /setPointerCapture/);
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

function finishDishSnap(sandbox) {
  evalInContext(sandbox, `(()=>{const track=galleryState.d.track;track.dispatchEvent({type:'transitionend',target:track})})()`);
}

test('gallerySet/galleryStep: track snaps before counter/thumbnail commit and never wraps at boundaries', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const hero = sandbox.document.getElementById('d-hero');
  hero.getBoundingClientRect = () => ({ width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300 });
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral([apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')])})`);
  const thumbs = [sandbox.document.createElement('button'), sandbox.document.createElement('button'), sandbox.document.createElement('button')];
  sandbox.document.getElementById('d-gallery').querySelectorAll = selector => selector === '.thumb' ? thumbs : [];
  evalInContext(sandbox, "updateGalleryChrome('d',0)");
  assert.equal(evalInContext(sandbox, 'galleryState.d.track.children.length'), 3, 'в track одновременно присутствуют текущий и соседние кадры');
  assert.equal(evalInContext(sandbox, 'galleryState.d.track.children[1].children[0].src'), 'https://cdn.test/b-full.webp');
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3');
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3', 'chrome не меняется до окончания snap');
  assert.equal(evalInContext(sandbox, 'galleryState.d.track.style.transform'), 'translate3d(-300px,0,0)');
  finishDishSnap(sandbox);
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '2 / 3');
  assert.equal(thumbs[1].classList.contains('on'), true);
  assert.equal(thumbs[0].classList.contains('on'), false);
  evalInContext(sandbox, "galleryStep('d', 1)");
  finishDishSnap(sandbox);
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  evalInContext(sandbox, "galleryStep('d', 1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  evalInContext(sandbox, "gallerySet('d', 0)");
  finishDishSnap(sandbox);
  evalInContext(sandbox, "galleryStep('d', -1)");
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '1 / 3');
  evalInContext(sandbox, "gallerySet('d', 2)");
  finishDishSnap(sandbox);
  assert.equal(sandbox.document.getElementById('d-gcount').textContent, '3 / 3');
  assert.equal(thumbs[2].classList.contains('on'), true);
  teardown(sandbox);
});

test('dish drag follows pointer live, reveals neighbour, snaps after release, and keeps vertical gesture native', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const photos = [apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')];
  const hero = sandbox.document.getElementById('d-hero');
  hero.getBoundingClientRect = () => ({ width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300 });
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  // Повторный render обязан снять старые listeners, иначе один drag мог бы
  // перескочить сразу через два кадра.
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  const count = sandbox.document.getElementById('d-gcount');
  const thumbs = [sandbox.document.createElement('button'), sandbox.document.createElement('button'), sandbox.document.createElement('button')];
  sandbox.document.getElementById('d-gallery').querySelectorAll = selector => selector === '.thumb' ? thumbs : [];
  evalInContext(sandbox, "updateGalleryChrome('d',0)");
  const track = evalInContext(sandbox, 'galleryState.d.track');
  hero.dispatchEvent({ type: 'pointerdown', pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 280, clientY: 180, timeStamp: 0 });
  hero.dispatchEvent({ type: 'pointermove', pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 184, timeStamp: 100 });
  assert.equal(track.style.transform, 'translate3d(-150px,0,0)', 'трек удерживается ровно на половине между кадрами');
  assert.equal(count.textContent, '1 / 3', 'counter остаётся прежним во время drag');
  assert.equal(thumbs[0].classList.contains('on'), true, 'thumbnail остаётся прежним во время drag');
  hero.dispatchEvent({ type: 'pointerup', pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 184, timeStamp: 110 });
  assert.equal(track.style.transform, 'translate3d(-300px,0,0)', 'после отпускания начинается snap к соседу');
  assert.equal(count.textContent, '1 / 3', 'counter меняется только после transitionend');
  finishDishSnap(sandbox);
  assert.equal(count.textContent, '2 / 3', 'после snap фиксируется ровно один следующий кадр');
  assert.equal(thumbs[1].classList.contains('on'), true);

  const beforeVertical = track.style.transform;
  hero.dispatchEvent({ type: 'pointerdown', pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 180, clientY: 160, timeStamp: 200 });
  hero.dispatchEvent({ type: 'pointermove', pointerId: 2, pointerType: 'touch', clientX: 188, clientY: 300, timeStamp: 260 });
  hero.dispatchEvent({ type: 'pointerup', pointerId: 2, pointerType: 'touch', clientX: 188, clientY: 300, timeStamp: 270 });
  assert.equal(track.style.transform, beforeVertical, 'вертикальный жест не двигает track');
  assert.equal(count.textContent, '2 / 3');

  hero.dispatchEvent({ type: 'pointerdown', pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: 180, clientY: 160, timeStamp: 300 });
  hero.dispatchEvent({ type: 'pointermove', pointerId: 3, pointerType: 'touch', clientX: 160, clientY: 162, timeStamp: 400 });
  hero.dispatchEvent({ type: 'pointerup', pointerId: 3, pointerType: 'touch', clientX: 160, clientY: 162, timeStamp: 410 });
  finishDishSnap(sandbox);
  assert.equal(count.textContent, '2 / 3', 'короткий медленный drag плавно возвращается');
  teardown(sandbox);
});

test('mobile axis-lock is permanent: diagonal horizontal drag captures and prevents, vertical drag stays native', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const photos = [apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')];
  const hero = sandbox.document.getElementById('d-hero');
  hero.getBoundingClientRect = () => ({ width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300 });
  const captured = [];
  const released = [];
  hero.setPointerCapture = pointerId => captured.push(pointerId);
  hero.releasePointerCapture = pointerId => released.push(pointerId);
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  const track = evalInContext(sandbox, 'galleryState.d.track');
  const event = (type, pointerId, x, y, timeStamp) => ({
    type, pointerId, pointerType: 'touch', isPrimary: true,
    clientX: x, clientY: y, timeStamp, cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });

  hero.dispatchEvent(event('pointerdown', 11, 250, 150, 0));
  // Меньше порога активации (6px) — жест ещё ничей.
  const belowThreshold = event('pointermove', 11, 246, 147, 20);
  hero.dispatchEvent(belowThreshold);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), null);
  assert.equal(belowThreshold.defaultPrevented, false);
  assert.deepEqual(captured, []);

  const horizontalLock = event('pointermove', 11, 238, 142, 40);
  hero.dispatchEvent(horizontalLock);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'horizontal');
  assert.equal(horizontalLock.defaultPrevented, true, 'horizontal lock должен остановить native Y-scroll');
  assert.deepEqual(captured, [11]);
  assert.equal(track.style.transform, 'translate3d(-12px,0,0)');

  const diagonalAfterLock = event('pointermove', 11, 150, 290, 140);
  hero.dispatchEvent(diagonalAfterLock);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'horizontal', 'ось нельзя переопределить внутри жеста');
  assert.equal(diagonalAfterLock.defaultPrevented, true);
  assert.equal(track.style.transform, 'translate3d(-100px,0,0)', 'после lock трек следует только за X пальца');
  const horizontalUp = event('pointerup', 11, 150, 290, 150);
  hero.dispatchEvent(horizontalUp);
  assert.equal(horizontalUp.defaultPrevented, true);
  assert.deepEqual(released, [11]);
  finishDishSnap(sandbox);
  assert.equal(evalInContext(sandbox, 'galleryState.d.index'), 1);

  const settledTransform = track.style.transform;
  hero.dispatchEvent(event('pointerdown', 12, 180, 150, 200));
  const verticalLock = event('pointermove', 12, 175, 161, 225);
  hero.dispatchEvent(verticalLock);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'vertical');
  assert.equal(verticalLock.defaultPrevented, false, 'vertical lock должен остаться полностью нативным');
  assert.deepEqual(captured, [11], 'vertical жест не захватывает pointer');

  const horizontalLater = event('pointermove', 12, 30, 166, 260);
  hero.dispatchEvent(horizontalLater);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'vertical', 'vertical lock нельзя сменить на horizontal');
  assert.equal(horizontalLater.defaultPrevented, false);
  assert.equal(track.style.transform, settledTransform, 'vertical жест никогда не двигает gallery track');
  const verticalUp = event('pointerup', 12, 30, 166, 270);
  hero.dispatchEvent(verticalUp);
  assert.equal(verticalUp.defaultPrevented, false);
  assert.equal(evalInContext(sandbox, 'galleryState.d.index'), 1);
  assert.deepEqual(released, [11], 'vertical жест не пытается освободить несуществующий capture');
  teardown(sandbox);
});

test('swipe decision combines distance and velocity; first/last edges rubber-band instead of wrapping', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  assert.equal(evalInContext(sandbox, 'gallerySwipeTarget(1,3,-20,-.8,300)'), 2, 'быстрый короткий flick идёт вперёд');
  assert.equal(evalInContext(sandbox, 'gallerySwipeTarget(1,3,20,.8,300)'), 0, 'быстрый короткий flick идёт назад');
  assert.equal(evalInContext(sandbox, 'gallerySwipeTarget(1,3,-20,-.1,300)'), 1, 'короткий медленный drag возвращается');
  assert.equal(evalInContext(sandbox, 'gallerySwipeTarget(0,3,120,.9,300)'), 0, 'первая фотография не зацикливается');
  assert.equal(evalInContext(sandbox, 'gallerySwipeTarget(2,3,-120,-.9,300)'), 2, 'последняя фотография не зацикливается');
  const resistedStart = evalInContext(sandbox, 'galleryRubberBand(120,300,0,3)');
  const resistedEnd = evalInContext(sandbox, 'galleryRubberBand(-120,300,2,3)');
  assert.ok(resistedStart > 0 && resistedStart < 120);
  assert.ok(resistedEnd < 0 && resistedEnd > -120);
  assert.equal(evalInContext(sandbox, 'galleryRubberBand(-120,300,1,3)'), -120, 'между кадрами сопротивления нет');
  teardown(sandbox);
});

test('диагональ достаётся вертикальному скроллу, пока горизонталь не преобладает явно', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const axis = (dx, dy) => evalInContext(sandbox, `resolveGalleryAxis(${dx},${dy})`);

  // Ниже порога активации решения нет вовсе.
  assert.equal(axis(4, 3), null);
  assert.equal(axis(-5, 1), null);

  // Ровно 45° и всё, что круче, — это скролл страницы, а не галерея. Раньше
  // такой жест решался дрожанием в один пиксель и «прилипал» то туда, то сюда.
  assert.equal(axis(20, 20), 'vertical', '45° не должен воровать жест у скролла');
  assert.equal(axis(-20, 20), 'vertical');
  assert.equal(axis(22, 20), 'vertical', 'слабое преобладание горизонтали ещё не галерея');
  assert.equal(axis(30, 20), 'horizontal', 'явная горизонталь забирает жест');
  assert.equal(axis(-40, 8), 'horizontal');

  // Почти чистая вертикаль всегда остаётся нативной.
  assert.equal(axis(3, 40), 'vertical');
  teardown(sandbox);
});

test('non-passive touchmove гасит нативный скролл только для горизонтального жеста', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const photos = [apiPhotoNormalized('a', ''), apiPhotoNormalized('b', ''), apiPhotoNormalized('c', '')];
  const hero = sandbox.document.getElementById('d-hero');
  hero.getBoundingClientRect = () => ({ width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300 });
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);

  const touch = (type, x, y, timeStamp) => ({
    type, timeStamp, cancelable: true, defaultPrevented: false,
    touches: [{ clientX: x, clientY: y }],
    preventDefault() { this.defaultPrevented = true; },
  });
  const pointer = (type, x, y, timeStamp) => ({
    type, pointerId: 1, pointerType: 'touch', isPrimary: true,
    clientX: x, clientY: y, timeStamp, cancelable: true, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });

  // Горизонталь: touchmove обязан отменить скролл — на iOS это единственный
  // способ удержать страницу, preventDefault на pointermove там не работает.
  hero.dispatchEvent(pointer('pointerdown', 250, 150, 0));
  const horizontalTouch = touch('touchmove', 220, 154, 30);
  hero.dispatchEvent(horizontalTouch);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'horizontal');
  assert.equal(horizontalTouch.defaultPrevented, true, 'горизонтальный жест обязан остановить скролл страницы');
  hero.dispatchEvent(pointer('pointerup', 220, 154, 40));
  finishDishSnap(sandbox);

  // Вертикаль: touchmove не трогается, страница скроллится нативно.
  hero.dispatchEvent(pointer('pointerdown', 180, 150, 100));
  const verticalTouch = touch('touchmove', 176, 190, 130);
  hero.dispatchEvent(verticalTouch);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'vertical');
  assert.equal(verticalTouch.defaultPrevented, false, 'вертикальный жест обязан остаться нативным');

  // Ось не переигрывается: последующий резко горизонтальный touchmove внутри
  // того же жеста скролл уже не отменяет.
  const laterHorizontal = touch('touchmove', 40, 196, 170);
  hero.dispatchEvent(laterHorizontal);
  assert.equal(evalInContext(sandbox, 'galleryState.d.drag.axis'), 'vertical');
  assert.equal(laterHorizontal.defaultPrevented, false);
  hero.dispatchEvent(pointer('pointerup', 40, 196, 180));
  teardown(sandbox);
});

test('touchmove снимается вместе с остальными listeners при повторном render', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const photos = [apiPhotoNormalized('a', ''), apiPhotoNormalized('b', '')];
  const hero = sandbox.document.getElementById('d-hero');
  hero.getBoundingClientRect = () => ({ width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300 });
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  const afterFirst = (hero.listeners && hero.listeners.touchmove ? hero.listeners.touchmove.length : 0);
  assert.equal(afterFirst, 1, 'должен быть ровно один touchmove listener');
  evalInContext(sandbox, `renderGallery('d', ${toContextLiteral(photos)})`);
  const afterSecond = (hero.listeners && hero.listeners.touchmove ? hero.listeners.touchmove.length : 0);
  assert.equal(afterSecond, 1, 'повторный render не должен накапливать listeners');
  teardown(sandbox);
});

test('длительность snap зависит от остатка пути и скорости отпускания', () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api-pg.yaam.su' });
  const dur = (remaining, width, velocity) => evalInContext(sandbox, `gallerySnapDuration(${remaining},${width},${velocity})`);

  const far = dur(280, 300, 0);
  const near = dur(20, 300, 0);
  assert.ok(far > near, 'дальше идти — дольше анимация');

  // Резкий flick завершается быстрее, чем такое же расстояние после медленного
  // отпускания: иначе после броска картинка «доезжает» вязко.
  assert.ok(dur(280, 300, 2) < dur(280, 300, 0), 'быстрый flick должен доводиться быстрее');

  // Границы диапазона соблюдаются в любом случае.
  for (const [r, w, v] of [[0, 300, 0], [900, 300, 0], [300, 300, 9], [-300, 300, -9]]) {
    const d = dur(r, w, v);
    assert.ok(d >= 170 && d <= 340, `длительность ${d} вне диапазона 170..340`);
  }
  teardown(sandbox);
});

// normalizeRestaurant уже приводит к форме {thumb,card,full,alt} — эта
// вспомогательная функция строит фотографию СРАЗУ в этой пост-нормализованной
// форме (тесты выше на renderGallery работают с уже нормализованным curRest,
// тем же приёмом, что setMenu() в menuRendering.test.js).
function apiPhotoNormalized(suffix, alt) {
  return { thumb: `https://cdn.test/${suffix}-thumb.webp`, card: `https://cdn.test/${suffix}-card.webp`, full: `https://cdn.test/${suffix}-full.webp`, alt: alt || '' };
}
