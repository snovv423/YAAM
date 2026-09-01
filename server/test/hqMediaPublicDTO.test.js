'use strict';

// YAAM HQ Stage 5B — юнит-тесты публичного DTO фотографий (задание, раздел
// 14A: "safe public DTO", "primary resolver", "ordering") и alt-валидации
// (services/hq/media/photoService.js). Полностью без БД — тестовая
// заглушка provider'а (getPublicUrl — чистая функция), тот же принцип, что
// и services/hq/media/publicPhotoDTO.js сам явно требует (mediaProvider —
// параметр, не singleton).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toPublicPhotoDTO, buildPhotoFields, attachPhotoFields } = require('../services/hq/media/publicPhotoDTO');
const { resolvePrimaryPhoto, ALT_TEXT_MAX, normalizeAltText, normalizeCrop, normalizeRotation } = require('../services/hq/media/photoService');
const { ValidationError } = require('../services/hq/restaurantLifecycle');

const stubProvider = { getPublicUrl: (key) => `https://cdn.test/${key}` };

function photoRow(overrides) {
  return {
    id: 1, restaurant_id: 1, storage_key: 'restaurants/1/abc',
    width: 800, height: 600, alt_text: '', sort_order: 0, is_primary: 0,
    archived_at: null, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

test('toPublicPhotoDTO: содержит только публичные alt/urls/crops — ничего внутреннего', () => {
  const dto = toPublicPhotoDTO(stubProvider, photoRow({ alt_text: 'Зал ресторана' }));
  assert.deepEqual(Object.keys(dto).sort(), ['alt', 'crops', 'rotation', 'urls']);
  assert.deepEqual(Object.keys(dto.urls).sort(), ['card', 'full', 'thumb']);
  assert.equal(dto.alt, 'Зал ресторана');
  assert.equal(dto.rotation, 0);
});

test('toPublicPhotoDTO: отдаёт независимые crops карточки и экрана блюда', () => {
  const menuCard = { x: 0.1, y: 0.2, width: 0.7, height: 0.3 };
  const detail = { x: 0.2, y: 0, width: 0.8, height: 0.8 };
  const dto = toPublicPhotoDTO(stubProvider, photoRow({ menu_card_crop: menuCard, dish_detail_crop: detail }));
  assert.deepEqual(dto.crops, { menu_card: menuCard, dish_detail: detail });
});

test('rotation metadata is normalized for 0/90/180/270/360 and isolated per photo DTO', () => {
  assert.deepEqual([0, 90, 180, 270, 360].map(normalizeRotation), [0, 90, 180, 270, 0]);
  assert.throws(() => normalizeRotation(45), ValidationError);
  const first = toPublicPhotoDTO(stubProvider, photoRow({ id: 1, rotation_degrees: 90 }));
  const second = toPublicPhotoDTO(stubProvider, photoRow({ id: 2, rotation_degrees: 270 }));
  assert.equal(first.rotation, 90);
  assert.equal(second.rotation, 270);
});

test('toPublicPhotoDTO: НЕ содержит storage_key/id/archived_at/admin-метаданные даже как значения дочерних полей', () => {
  const dto = toPublicPhotoDTO(stubProvider, photoRow({
    id: 999, storage_key: 'SECRET/internal/path', archived_at: new Date(), sort_order: 5, is_primary: 1,
  }));
  const serialized = JSON.stringify(dto);
  // storage_key ЛЕГИТИМНО входит как ЧАСТЬ производного URL (это и есть его
  // назначение — задание, раздел 8, не "утечка"), но сырые внутренние поля
  // (id/archived_at/sort_order/is_primary) не должны появляться отдельными
  // именованными ключами вовсе.
  assert.equal(dto.id, undefined);
  assert.equal(dto.archived_at, undefined);
  assert.equal(dto.sort_order, undefined);
  assert.equal(dto.is_primary, undefined);
  assert.ok(!serialized.includes('"id"'));
  assert.ok(!serialized.includes('archived_at'));
});

test('resolvePrimaryPhoto: выбирает фото с is_primary=1 среди активных', () => {
  const photos = [photoRow({ id: 1, sort_order: 0 }), photoRow({ id: 2, sort_order: 1, is_primary: 1 }), photoRow({ id: 3, sort_order: 2 })];
  assert.equal(resolvePrimaryPhoto(photos).id, 2);
});

test('resolvePrimaryPhoto: без primary — первая по sort_order (fallback, задание раздел 6/8)', () => {
  const photos = [photoRow({ id: 5, sort_order: 0 }), photoRow({ id: 6, sort_order: 1 })];
  assert.equal(resolvePrimaryPhoto(photos).id, 5);
});

test('resolvePrimaryPhoto: пустой список -> null', () => {
  assert.equal(resolvePrimaryPhoto([]), null);
});

test('buildPhotoFields: реальные фотографии — primary_photo + gallery в порядке sort_order', () => {
  const photos = [
    photoRow({ id: 1, sort_order: 0, alt_text: 'Первое' }),
    photoRow({ id: 2, sort_order: 1, alt_text: 'Второе', is_primary: 1 }),
  ];
  const fields = buildPhotoFields(stubProvider, photos, '');
  assert.equal(fields.primary_photo.alt, 'Второе');
  assert.equal(fields.gallery.length, 2);
  assert.equal(fields.gallery[0].alt, 'Первое');
  assert.equal(fields.gallery[1].alt, 'Второе');
});

test('buildPhotoFields: нет реальных фото, есть legacy photo_url -> оборачивается в primary_photo/gallery из 1 элемента', () => {
  const fields = buildPhotoFields(stubProvider, [], 'https://legacy.example.com/old.jpg');
  assert.ok(fields.primary_photo);
  assert.equal(fields.primary_photo.urls.card, 'https://legacy.example.com/old.jpg');
  assert.equal(fields.primary_photo.urls.thumb, fields.primary_photo.urls.full);
  assert.equal(fields.primary_photo.rotation, 0);
  assert.equal(fields.gallery.length, 1);
});

test('buildPhotoFields: ни реальных фото, ни legacy photo_url -> primary_photo=null, gallery=[]', () => {
  const fields = buildPhotoFields(stubProvider, [], '');
  assert.equal(fields.primary_photo, null);
  assert.deepEqual(fields.gallery, []);
});

test('buildPhotoFields: реальные фото ИМЕЮТ приоритет над legacy photo_url, даже если оба присутствуют', () => {
  const photos = [photoRow({ id: 1, alt_text: 'Настоящее фото', is_primary: 1 })];
  const fields = buildPhotoFields(stubProvider, photos, 'https://legacy.example.com/old.jpg');
  assert.equal(fields.primary_photo.alt, 'Настоящее фото');
  assert.equal(fields.gallery.length, 1);
});

test('attachPhotoFields: не портит остальные поля DTO ресторана/блюда', () => {
  const dto = { id: 1, name: 'Тест' };
  const result = attachPhotoFields(stubProvider, dto, [], '');
  assert.equal(result.id, 1);
  assert.equal(result.name, 'Тест');
  assert.equal(result.primary_photo, null);
});

// --- alt-валидация (задание, раздел 14A: "alt validation") ---
test('ALT_TEXT_MAX ограничивает длину описания разумным пределом', () => {
  assert.ok(ALT_TEXT_MAX > 0 && ALT_TEXT_MAX <= 500);
});

test('normalizeAltText: пустое/undefined -> пустая строка (не обязательное поле)', () => {
  assert.equal(normalizeAltText(undefined), '');
  assert.equal(normalizeAltText(null), '');
  assert.equal(normalizeAltText(''), '');
});

test('normalizeAltText: обрезает пробелы по краям', () => {
  assert.equal(normalizeAltText('  Хачапури с сыром  '), 'Хачапури с сыром');
});

test('normalizeAltText: превышение ALT_TEXT_MAX бросает ValidationError', () => {
  assert.throws(() => normalizeAltText('a'.repeat(ALT_TEXT_MAX + 1)), ValidationError);
});

test('normalizeAltText: ровно ALT_TEXT_MAX символов — валидно (граница включительно)', () => {
  const exact = 'a'.repeat(ALT_TEXT_MAX);
  assert.equal(normalizeAltText(exact), exact);
});

test('normalizeCrop: принимает bounded 7:3 и 1:1 crop', () => {
  assert.deepEqual(normalizeCrop({ x: 0, y: 0.2, width: 0.7, height: 0.3 }, 'menu_card'), { x: 0, y: 0.2, width: 0.7, height: 0.3 });
  assert.deepEqual(normalizeCrop('{"x":0.2,"y":0,"width":0.8,"height":0.8}', 'dish_detail'), { x: 0.2, y: 0, width: 0.8, height: 0.8 });
});

test('normalizeCrop: отклоняет выход за master и неверный aspect ratio', () => {
  assert.throws(() => normalizeCrop({ x: 0.5, y: 0, width: 0.6, height: 0.6 }, 'dish_detail'), ValidationError);
  assert.throws(() => normalizeCrop({ x: 0, y: 0, width: 1, height: 1 }, 'menu_card'), ValidationError);
});

// Регрессия: crop хранится в НОРМАЛИЗОВАННЫХ координатах исходника, поэтому
// сравнивать width/height напрямую с целевым aspect можно только для
// квадратной фотографии. Для 1600x900 корректная область 7:3 — это 1 x 0.762,
// и прежняя проверка отклоняла её: «Сохранить» в редакторе не работало ни для
// одной неквадратной фотографии.
test('normalizeCrop: aspect считается в пикселях исходника, а не в нормализованных долях', () => {
  const landscape = { width: 1600, height: 900, rotation: 0 };
  // 1600 x (0.7619 * 900 = 686) -> 2.333 = 7:3
  assert.deepEqual(
    normalizeCrop({ x: 0, y: 0.119048, width: 1, height: 0.761905 }, 'menu_card', landscape),
    { x: 0, y: 0.119048, width: 1, height: 0.761905 },
  );
  // Те же доли, что проходили при «квадратном» допущении, для 16:9 неверны.
  assert.throws(
    () => normalizeCrop({ x: 0, y: 0.2, width: 0.7, height: 0.3 }, 'menu_card', landscape),
    ValidationError,
  );
  // 1:1 для того же исходника: 900 x 900 -> width 0.5625, height 1.
  assert.deepEqual(
    normalizeCrop({ x: 0.2, y: 0, width: 0.5625, height: 1 }, 'dish_detail', landscape),
    { x: 0.2, y: 0, width: 0.5625, height: 1 },
  );
});

test('normalizeCrop: поворот на 90/270 меняет ориентацию исходника при проверке', () => {
  const portrait = { width: 900, height: 1600, rotation: 90 }; // ориентированный 1600x900
  assert.deepEqual(
    normalizeCrop({ x: 0, y: 0.2, width: 0.39375, height: 0.3 }, 'menu_card', portrait),
    { x: 0, y: 0.2, width: 0.39375, height: 0.3 },
  );
  // Без поворота тот же crop у 900x1600 даёт совсем другое соотношение.
  assert.throws(
    () => normalizeCrop({ x: 0, y: 0.2, width: 0.39375, height: 0.3 }, 'menu_card', { width: 900, height: 1600, rotation: 0 }),
    ValidationError,
  );
});
