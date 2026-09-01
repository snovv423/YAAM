'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderPhotoManager } = require('../hq/photosViews');

test('HQ photo manager keeps explicit primary/delete actions and file upload', () => {
  const html = renderPhotoManager({
    title: 'Фотографии блюда',
    photos: [{
      id: 7,
      is_primary: 0,
      alt_text: 'Старое техническое описание',
      urls: { card: '/media/card.jpg' },
    }],
    uploadAction: '/hq/items/1/photos',
    actionBase: '/hq/items/1/photos',
    csrfToken: 'token',
    maxPhotos: 20,
    mediaConfigured: true,
  });

  assert.match(html, /name="photo"/);
  assert.match(html, />Загрузить</);
  assert.match(html, />Сделать основным</);
  assert.match(html, />Удалить</);
  assert.doesNotMatch(html, /name="alt_text"/);
  assert.doesNotMatch(html, /Описание фото|Описание \(необязательно\)|>Сохранить</);
  assert.doesNotMatch(html, /Старое техническое описание/);
});

test('dish photo manager renders one selected primary and a safe radio-style action for the rest', () => {
  const html = renderPhotoManager({
    title: 'Фотографии блюда',
    photos: [
      { id: 7, is_primary: 1, urls: { full: '/media/one.jpg' }, menu_card_crop: null, dish_detail_crop: null },
      { id: 8, is_primary: 0, urls: { full: '/media/two.jpg' }, menu_card_crop: null, dish_detail_crop: null },
    ],
    uploadAction: '/hq/items/1/photos', actionBase: '/hq/items/1/photos', csrfToken: 'token',
    maxPhotos: 20, mediaConfigured: true, dishCrops: true,
  });

  assert.equal((html.match(/✓ Основное/g) || []).length, 1);
  assert.equal((html.match(/✓ Выбрано основным/g) || []).length, 1);
  assert.equal((html.match(/Сделать основным/g) || []).length, 1);
  assert.match(html, /photo-card is-primary/);
  assert.match(html, /\/photos\/8\/primary/);
});

test('dish editor exposes only YAAM presets, independent values, reset/save and both live previews', () => {
  const html = renderPhotoManager({
    title: 'Фотографии блюда',
    photos: [{
      id: 7, is_primary: 1, urls: { full: '/media/one.jpg' },
      rotation_degrees: 270,
      menu_card_crop: { x: 0, y: 0.2, width: 0.7, height: 0.3 },
      dish_detail_crop: { x: 0.1, y: 0, width: 0.9, height: 0.9 },
    }],
    uploadAction: '/hq/items/1/photos', actionBase: '/hq/items/1/photos', csrfToken: 'token',
    maxPhotos: 20, mediaConfigured: true, dishCrops: true,
  });

  assert.match(html, /data-crop-tab="menu_card"[^>]*>Карточка меню <span>7:3/);
  assert.match(html, /data-crop-tab="dish_detail"[^>]*>Экран блюда <span>1:1/);
  assert.equal((html.match(/name="crop"/g) || []).length, 2);
  assert.equal((html.match(/data-crop-reset/g) || []).length, 2);
  assert.equal((html.match(/data-busy-text="Сохранение…"/g) || []).length, 2);
  assert.equal((html.match(/data-crop-preview=/g) || []).length, 2);
  assert.equal((html.match(/name="rotation" value="270"/g) || []).length, 2);
  assert.match(html, /data-rotate="-90"[^>]*aria-label="Повернуть влево"/);
  assert.match(html, /data-rotate="90"[^>]*aria-label="Повернуть вправо"/);
  assert.match(html, /&quot;x&quot;:0,&quot;y&quot;:0\.2,&quot;width&quot;:0\.7,&quot;height&quot;:0\.3/);
  assert.match(html, /&quot;x&quot;:0\.1,&quot;y&quot;:0,&quot;width&quot;:0\.9,&quot;height&quot;:0\.9/);
  assert.doesNotMatch(html, /name="aspect|произвольн/i);
});

test('crop interaction supports pointer/touch, live preview, reset and narrow HQ layout', () => {
  const script = fs.readFileSync(path.join(__dirname, '../hq/static/hq.js'), 'utf8');
  const layout = fs.readFileSync(path.join(__dirname, '../hq/layout.js'), 'utf8');

  assert.match(script, /pointerdown/);
  assert.match(script, /setPointerCapture/);
  assert.match(script, /data-crop-preview/);
  assert.match(script, /reset\.addEventListener/);
  assert.match(script, /rotationchange/);
  assert.match(script, /% 360/);
  assert.match(script, /Math\.max\(frame\.width \/ \(crop\.width \* orientedWidth\), frame\.height \/ \(crop\.height \* orientedHeight\)\)/);
  assert.match(script, /Math\.min\(1 - width/);
  assert.match(layout, /touch-action:none/);
  assert.match(layout, /@media\(max-width:620px\)/);
  assert.match(layout, /\.photo-grid-dish\{grid-template-columns:1fr 1fr/);
  assert.doesNotMatch(layout, /overflow-x:\s*(?:scroll|auto).*photo-editor/);
});
