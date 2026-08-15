'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPhotoManager } = require('../hq/photosViews');

test('HQ photo manager keeps only primary/delete actions and file upload', () => {
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
  assert.match(html, />Сделать основной</);
  assert.match(html, />Удалить</);
  assert.doesNotMatch(html, /name="alt_text"/);
  assert.doesNotMatch(html, /Описание фото|Описание \(необязательно\)|>Сохранить</);
  assert.doesNotMatch(html, /Старое техническое описание/);
});
