'use strict';

// YAAM HQ Stage 5B — построение публичного DTO фотографии (задание, раздел
// 8). Вынесено из routes/postgresql/api.js в отдельный чистый модуль без
// побочных эффектов (никакого db/network), чтобы unit-тесты могли проверить
// форму DTO напрямую, без embedded PostgreSQL — то же архитектурное
// разделение, что services/hq/restaurantLifecycle.js даёт
// test/hqRestaurantLifecycle.test.js.
//
// mediaProvider передаётся явным параметром (не читается как module-level
// singleton) — этот модуль не должен знать, S3 это или LocalMediaProvider
// или тестовая заглушка с одним методом getPublicUrl().
const { photoVariantUrls, resolvePrimaryPhoto } = require('./photoService');

// Только то, что реально нужно клиенту: описание и уже готовые URL трёх
// вариантов. НЕ включены: id строки, storage_key/bucket/endpoint по
// отдельности, archived_at, оригинальное имя файла, EXIF — этих полей
// физически нет на входном объекте после прохода через эту функцию
// (allowlist "by construction", тот же принцип, что PUBLIC_RESTAURANT_FIELDS
// в routes/postgresql/api.js).
function toPublicPhotoDTO(mediaProvider, photo) {
  return {
    alt: photo.alt_text || '',
    urls: photoVariantUrls(mediaProvider, photo),
    crops: {
      menu_card: photo.menu_card_crop || null,
      dish_detail: photo.dish_detail_crop || null,
    },
    rotation: Number(photo.rotation_degrees) || 0,
  };
}

// Legacy photo_url (задание, раздел 13) — если у владельца ещё нет ни одной
// загруженной фотографии в новой галерее, DTO продолжает отдавать
// primary_photo/gallery, собранные ИЗ legacy-поля, чтобы клиенту не
// требовалось два разных пути отображения.
function buildPhotoFields(mediaProvider, activePhotos, legacyUrl) {
  if (activePhotos && activePhotos.length) {
    const primary = resolvePrimaryPhoto(activePhotos);
    return {
      primary_photo: toPublicPhotoDTO(mediaProvider, primary),
      gallery: activePhotos.map((p) => toPublicPhotoDTO(mediaProvider, p)),
    };
  }
  if (legacyUrl) {
    const legacy = { alt: '', urls: { thumb: legacyUrl, card: legacyUrl, full: legacyUrl }, crops: { menu_card: null, dish_detail: null }, rotation: 0 };
    return { primary_photo: legacy, gallery: [legacy] };
  }
  return { primary_photo: null, gallery: [] };
}

function attachPhotoFields(mediaProvider, dto, activePhotos, legacyUrl) {
  return Object.assign(dto, buildPhotoFields(mediaProvider, activePhotos, legacyUrl));
}

module.exports = { toPublicPhotoDTO, buildPhotoFields, attachPhotoFields };
