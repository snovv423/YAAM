'use strict';

// YAAM HQ Stage 5B/5B.1 — CRUD фотографий ресторанов и блюд. Единственное
// место в кодовой базе, которое пишет в таблицы restaurant_photos/
// menu_item_photos И одновременно вызывает media provider (upload()/
// delete()) — тот же принцип "один сервис = единственный источник SQL для
// своего раздела", что и menuAdminService.js/restaurantAdminService.js.
//
// provider (LocalMediaProvider) передаётся явным
// параметром в каждую функцию, которая реально трогает хранилище — не
// импортируется здесь как singleton, чтобы:
//   1) unit/integration-тесты могли передать LocalMediaProvider с временным
//      каталогом, не трогая ничего внешнего;
//   2) app-слой (server.postgresql.js) сам решал, монтировать ли медиа-
//      функциональность вовсе (fail-closed при неполном S3-конфиге —
//      см. services/hq/media/provider.js).
//
// Stage 5B.1 — фотографиям не нужен lifecycle ресторана/блюда (задание,
// раздел 0): убраны ручной reorder, архивирование, восстановление. Удаление
// фотографии — РЕАЛЬНОЕ: строка физически удаляется из БД, а все варианты
// (включая непубличный master) — из хранилища. Это сознательное отличие от
// restaurants.archived_at/menu_items.archived_at (там DELETE запрещён
// навсегда из-за order_items/audit-истории) — у фотографии такой
// зависимости нет.
const crypto = require('node:crypto');
const db = require('../../../db/postgresql');
const { ValidationError } = require('../restaurantLifecycle');
const menuSvc = require('../menuAdminService');
const { processImage, VARIANTS, PUBLIC_VARIANT_NAMES } = require('./imagePipeline');
const { MIN_FREE_BYTES_FOR_UPLOAD, LOW_SPACE_WARNING_BYTES } = require('./diskUsage');

const ALT_TEXT_MAX = 200;
// Разумный верхний предел количества фотографий на одного владельца —
// защита от абсурдного объёма, не бизнес-ограничение.
const MAX_PHOTOS_PER_OWNER = 20;

const ALL_VARIANT_NAMES = Object.keys(VARIANTS); // ['thumb', 'card', 'full', 'master']

// Stage 5B.2 (задание, раздел 3) — единый storageKeyBase (например
// `restaurants/12/<uuid>`) остаётся ОДНОЙ колонкой в БД (без изменения
// схемы — задание, раздел 13: "предпочесть сохранить текущую схему"), но
// физический путь на диске разный для публичных вариантов и приватного
// master: `public/...` отдаётся наружу (Nginx/Express static), `private/
// masters/...` — никогда. Master не должен быть доступен по URL даже при
// угадывании пути (задание, раздел 3) — здесь достигается тем, что мастер
// физически лежит в отдельном поддереве, которое ни Nginx, ни Express
// static в принципе не монтируют (см. services/postgresql/app.js).
function variantObjectKey(storageKeyBase, variant) {
  if (variant === 'master') {
    return `private/masters/${storageKeyBase}/master.webp`;
  }
  return `public/${storageKeyBase}/${variant}.webp`;
}

// Публичные URL фотографии — всегда ВЫВОДЯТСЯ из storage_key через активный
// провайдер, никогда не хранятся в БД. Только публичные варианты (thumb/
// card/full) — master никогда не покидает сервер (задание: "master/original
// for possible future re-generation", не для показа клиенту).
function photoVariantUrls(provider, photo) {
  const urls = {};
  for (const variant of PUBLIC_VARIANT_NAMES) {
    urls[variant] = provider.getPublicUrl(variantObjectKey(photo.storage_key, variant));
  }
  return urls;
}

function normalizeAltText(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > ALT_TEXT_MAX) {
    throw new ValidationError(`Альтернативный текст слишком длинный (максимум ${ALT_TEXT_MAX} символов).`);
  }
  return trimmed;
}

const CROP_TARGETS = Object.freeze({ menu_card: 7 / 3, dish_detail: 1 });

function normalizeCrop(value, target) {
  const aspect = CROP_TARGETS[target];
  if (!aspect) throw new ValidationError('Неизвестный тип кадрирования.');
  let crop = value;
  if (typeof crop === 'string') {
    try { crop = JSON.parse(crop); } catch { throw new ValidationError('Некорректные параметры кадрирования.'); }
  }
  if (!crop || typeof crop !== 'object') throw new ValidationError('Выберите область фотографии.');
  const normalized = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = Number(crop[key]);
    if (!Number.isFinite(n)) throw new ValidationError('Некорректные параметры кадрирования.');
    normalized[key] = Math.round(n * 1000000) / 1000000;
  }
  const { x, y, width, height } = normalized;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw new ValidationError('Область кадрирования выходит за границы фотографии.');
  }
  if (Math.abs((width / height) - aspect) > 0.01) {
    throw new ValidationError('Соотношение сторон кадрирования не соответствует выбранному экрану.');
  }
  return normalized;
}

function normalizeRotation(value) {
  const rotation = ((Number(value) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) throw new ValidationError('Поворот доступен только шагами по 90°.');
  return rotation;
}

async function updateCrop(config, ownerId, photoId, target, value, rotationValue = 0) {
  if (config !== MENU_ITEM_CONFIG) throw new ValidationError('Кадрирование доступно только для фотографий блюд.');
  const crop = normalizeCrop(value, target);
  const rotation = normalizeRotation(rotationValue);
  const column = target === 'menu_card' ? 'menu_card_crop' : 'dish_detail_crop';
  return db.transaction(async (client) => {
    const currentResult = await db.execute(
      `SELECT * FROM menu_item_photos WHERE id = $1 AND menu_item_id = $2 FOR UPDATE`,
      [photoId, ownerId], client,
    );
    const current = currentResult.rows[0];
    if (!current) return null;
    const rotationChanged = normalizeRotation(current.rotation_degrees || 0) !== rotation;
    const updated = await db.execute(
      `UPDATE menu_item_photos SET ${column} = $1::jsonb, rotation_degrees = $2,
         ${rotationChanged ? `${target === 'menu_card' ? 'dish_detail_crop' : 'menu_card_crop'} = NULL,` : ''}
         updated_at = NOW()
       WHERE id = $3 AND menu_item_id = $4 RETURNING *`,
      [JSON.stringify(crop), rotation, photoId, ownerId], client,
    );
    return updated.rows[0] || null;
  });
}

async function deleteAllVariants(provider, storageKeyBase) {
  for (const variant of ALL_VARIANT_NAMES) {
    try {
      await provider.delete(variantObjectKey(storageKeyBase, variant));
    } catch (err) {
      // Best-effort. Если удаление одного варианта не удалось, продолжаем
      // удалять остальные и логируем, а не бросаем — вызывающий код уже
      // либо в error-path (загрузка/транзакция упала), либо это финальный
      // шаг уже успешного удаления строки из БД (падать здесь означало бы
      // либо потерять исходную причину ошибки, либо оставить пользователя
      // с "удалено, но 500" при том, что данные уже честно удалены).
      console.error(`[photoService] не удалось удалить объект ${variant} (${storageKeyBase}):`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Конфигурация владельца: restaurant_photos (restaurant_id) или
// menu_item_photos (menu_item_id). Вся остальная логика ниже — общая.
// ---------------------------------------------------------------------------

// maxPhotos — предел НА ВЛАДЕЛЬЦА конкретного типа. Галерея ресторана
// ограничена тремя фотографиями (docs/HQ-PRODUCT-SPEC.md, раздел
// «Настройки — фотографии»: «поддержать до 3 фотографий»; все три листаются
// в шапке страницы ресторана на публичном сайте). У блюда предел остаётся
// прежним общим (MAX_PHOTOS_PER_OWNER) — спецификация его не меняет.
const RESTAURANT_MAX_PHOTOS = 3;
const RESTAURANT_CONFIG = { table: 'restaurant_photos', ownerColumn: 'restaurant_id', keyPrefix: 'restaurants', maxPhotos: RESTAURANT_MAX_PHOTOS };
const MENU_ITEM_CONFIG = { table: 'menu_item_photos', ownerColumn: 'menu_item_id', keyPrefix: 'menu-items' };

async function listPhotos(config, ownerId) {
  return db.query(
    `SELECT * FROM ${config.table} WHERE ${config.ownerColumn} = $1 ORDER BY sort_order, id`,
    [ownerId],
  );
}

async function getPhotoById(config, ownerId, photoId) {
  const numericId = Number.parseInt(photoId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query(
    `SELECT * FROM ${config.table} WHERE id = $1 AND ${config.ownerColumn} = $2`,
    [numericId, ownerId],
  );
  return rows[0] || null;
}

// Выбирает primary среди фотографий владельца; если ни одна не помечена
// (не должно происходить в норме — deletePhoto ниже сразу переназначает
// primary при удалении текущей — оставлено как defense-in-depth для
// публичного DTO) — первую по sort_order.
function resolvePrimaryPhoto(photos) {
  if (!photos.length) return null;
  return photos.find((p) => p.is_primary === 1) || photos[0];
}

async function uploadPhoto(config, provider, ownerId, buffer, altTextRaw) {
  const altText = normalizeAltText(altTextRaw);

  const countRows = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${config.table} WHERE ${config.ownerColumn} = $1`,
    [ownerId],
  );
  const maxForOwner = config.maxPhotos || MAX_PHOTOS_PER_OWNER;
  if (countRows[0].n >= maxForOwner) {
    throw new ValidationError(`Достигнут предел ${maxForOwner} фотографий — сначала удалите лишние.`);
  }

  // Операционная проверка места на диске (задание, раздел 11) — duck-typed:
  // не каждый провайдер обязан её поддерживать (только LocalMediaProvider,
  // единственный существующий, её реализует). Fail-closed только при реально
  // опасном остатке (недостаточно места даже для одной загрузки со всеми
  // вариантами), иначе — просто предупреждение в лог, загрузка не
  // блокируется раньше необходимого.
  if (typeof provider.getDiskUsage === 'function') {
    try {
      const usage = await provider.getDiskUsage();
      if (usage.freeBytes < MIN_FREE_BYTES_FOR_UPLOAD) {
        console.error(`[photoService] Недостаточно места на диске для загрузки: свободно ${usage.freeBytes} байт.`);
        throw new ValidationError('Недостаточно свободного места на сервере для загрузки фотографии — обратитесь к администратору YAAM.');
      }
      if (usage.freeBytes < LOW_SPACE_WARNING_BYTES) {
        console.warn(`[photoService] Мало свободного места на медиа-хранилище: ${(usage.freeBytes / 1024 / 1024 / 1024).toFixed(1)} ГБ свободно.`);
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // Сама проверка не удалась (например, statfs временно недоступен) —
      // не должна блокировать загрузку сама по себе (задание: "без лишнего
      // шума", "не блокировать загрузку слишком рано").
      console.error('[photoService] Не удалось проверить свободное место на диске:', err.message);
    }
  }

  // Валидация/обработка (сигнатура, размер, decompression bomb, EXIF,
  // ресайз в WebP-варианты, включая непубличный master) — ПОЛНОСТЬЮ до
  // того, как хранилище или БД вообще узнают о загрузке.
  const processed = await processImage(buffer);

  const storageKeyBase = `${config.keyPrefix}/${ownerId}/${crypto.randomUUID()}`;

  const uploaded = [];
  try {
    for (const variant of ALL_VARIANT_NAMES) {
      const key = variantObjectKey(storageKeyBase, variant);
      await provider.upload(key, processed.variants[variant].buffer, 'image/webp');
      uploaded.push(key);
    }
  } catch (err) {
    // Загрузка хотя бы одного варианта не удалась — подчищаем уже
    // загруженные, чтобы не оставить частично загруженный "фантомный"
    // объект без записи в БД.
    for (const key of uploaded) {
      try {
        await provider.delete(key);
      } catch (cleanupErr) {
        console.error(`[photoService] не удалось откатить частичную загрузку ${key}:`, cleanupErr.message);
      }
    }
    throw err;
  }

  try {
    return await db.transaction(async (client) => {
      const existingPrimary = await db.query(
        `SELECT COUNT(*)::int AS n FROM ${config.table} WHERE ${config.ownerColumn} = $1 AND is_primary = 1`,
        [ownerId],
        client,
      );
      const isPrimary = existingPrimary[0].n === 0 ? 1 : 0;
      const { full } = processed.variants;
      const inserted = await db.execute(
        `INSERT INTO ${config.table}
           (${config.ownerColumn}, storage_key, width, height, alt_text, sort_order, is_primary)
         VALUES ($1, $2, $3, $4, $5,
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ${config.table} WHERE ${config.ownerColumn} = $1),
           $6)
         RETURNING *`,
        [ownerId, storageKeyBase, full.width, full.height, altText, isPrimary],
        client,
      );
      return inserted.rows[0];
    });
  } catch (err) {
    // DB-транзакция не удалась ПОСЛЕ успешной загрузки в хранилище —
    // компенсирующее удаление всех вариантов (no orphan objects).
    await deleteAllVariants(provider, storageKeyBase);
    throw err;
  }
}

async function setPrimary(config, ownerId, photoId) {
  const photo = await getPhotoById(config, ownerId, photoId);
  if (!photo) return null;
  if (photo.is_primary === 1) return photo; // уже основная — не ошибка

  return db.transaction(async (client) => {
    await db.execute(
      `UPDATE ${config.table} SET is_primary = 0, updated_at = NOW()
       WHERE ${config.ownerColumn} = $1 AND is_primary = 1`,
      [ownerId],
      client,
    );
    const updated = await db.execute(
      `UPDATE ${config.table} SET is_primary = 1, updated_at = NOW()
       WHERE id = $1 AND ${config.ownerColumn} = $2 RETURNING *`,
      [photo.id, ownerId],
      client,
    );
    return updated.rows[0];
  });
}

async function updateAltText(config, ownerId, photoId, altTextRaw) {
  const altText = normalizeAltText(altTextRaw);
  const updated = await db.execute(
    `UPDATE ${config.table} SET alt_text = $1, updated_at = NOW() WHERE id = $2 AND ${config.ownerColumn} = $3 RETURNING *`,
    [altText, photoId, ownerId],
  );
  return updated.rows[0] || null;
}

// Удаление — необратимо (задание Stage 5B.1: "Permanent Photo Deletion").
// Порядок: сначала DELETE строки в транзакции (с авто-переносом primary на
// следующую по sort_order фотографию, если удалялась именно основная —
// владельцу не нужно вручную выбирать новую основную после удаления), и
// только ПОСЛЕ успешного commit — удаление объектов из хранилища. Такой
// порядок гарантирует: если удаление из хранилища не удастся, в системе
// останется max нежелательный orphan-объект в хранилище (безопасно,
// логируется), а не БД-строка, указывающая на уже несуществующий файл.
async function deletePhoto(config, ownerId, photoId, provider) {
  const photo = await getPhotoById(config, ownerId, photoId);
  if (!photo) return null;

  const deleted = await db.transaction(async (client) => {
    const result = await db.execute(
      `DELETE FROM ${config.table} WHERE id = $1 AND ${config.ownerColumn} = $2 RETURNING *`,
      [photo.id, ownerId],
      client,
    );
    const row = result.rows[0];
    if (row && row.is_primary === 1) {
      await db.execute(
        `UPDATE ${config.table} SET is_primary = 1, updated_at = NOW()
         WHERE id = (SELECT id FROM ${config.table} WHERE ${config.ownerColumn} = $1 ORDER BY sort_order, id LIMIT 1)`,
        [ownerId],
        client,
      );
    }
    return row;
  });

  if (deleted) {
    await deleteAllVariants(provider, deleted.storage_key);
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Публичные обёртки — рестораны
// ---------------------------------------------------------------------------

const listRestaurantPhotos = (restaurantId) => listPhotos(RESTAURANT_CONFIG, restaurantId);
const getRestaurantPhotoById = (restaurantId, photoId) => getPhotoById(RESTAURANT_CONFIG, restaurantId, photoId);
const uploadRestaurantPhoto = (provider, restaurantId, buffer, altText) =>
  uploadPhoto(RESTAURANT_CONFIG, provider, restaurantId, buffer, altText);
const setRestaurantPhotoPrimary = (restaurantId, photoId) => setPrimary(RESTAURANT_CONFIG, restaurantId, photoId);
const updateRestaurantPhotoAlt = (restaurantId, photoId, altText) => updateAltText(RESTAURANT_CONFIG, restaurantId, photoId, altText);
const deleteRestaurantPhoto = (restaurantId, photoId, provider) => deletePhoto(RESTAURANT_CONFIG, restaurantId, photoId, provider);

// ---------------------------------------------------------------------------
// Публичные обёртки — блюда. menuItemId ДОЛЖЕН реально принадлежать
// restaurantId — тот же принцип, что assertCategoryBelongsToRestaurant в
// menuAdminService.js (ownership checks), поэтому все обёртки блюда
// принимают restaurantId первым аргументом и проверяют его через
// menuSvc.getMenuItemById (уже фильтрует по restaurant_id).
// ---------------------------------------------------------------------------

async function assertMenuItemOwnership(restaurantId, menuItemId) {
  const item = await menuSvc.getMenuItemById(restaurantId, menuItemId);
  if (!item) throw new ValidationError('Блюдо не найдено или принадлежит другому ресторану.');
  return item;
}

async function listMenuItemPhotos(restaurantId, menuItemId) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return listPhotos(MENU_ITEM_CONFIG, menuItemId);
}

// Все фотографии блюд ОДНОГО ресторана одним запросом — для компактных
// строк меню (docs/HQ-PRODUCT-SPEC.md, раздел «Компактные карточки блюд»),
// где превью нужно сразу для десятков блюд: N+1 по listMenuItemPhotos() был
// бы десятками запросов на открытие вкладки. Ownership обеспечен самим
// JOIN'ом по menu_items.restaurant_id, а не отдельной проверкой на каждое
// блюдо. Порядок (sort_order, id) тот же, что и в listPhotos — первая строка
// на блюдо и есть его основная фотография.
async function listMenuItemPhotosForRestaurant(restaurantId) {
  return db.query(
    `SELECT p.* FROM ${MENU_ITEM_CONFIG.table} p
       JOIN menu_items mi ON mi.id = p.menu_item_id
      WHERE mi.restaurant_id = $1
      ORDER BY p.menu_item_id, p.sort_order, p.id`,
    [restaurantId],
  );
}

async function getMenuItemPhotoById(restaurantId, menuItemId, photoId) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return getPhotoById(MENU_ITEM_CONFIG, menuItemId, photoId);
}

async function uploadMenuItemPhoto(provider, restaurantId, menuItemId, buffer, altText) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return uploadPhoto(MENU_ITEM_CONFIG, provider, menuItemId, buffer, altText);
}

async function setMenuItemPhotoPrimary(restaurantId, menuItemId, photoId) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return setPrimary(MENU_ITEM_CONFIG, menuItemId, photoId);
}

async function updateMenuItemPhotoAlt(restaurantId, menuItemId, photoId, altText) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return updateAltText(MENU_ITEM_CONFIG, menuItemId, photoId, altText);
}

async function deleteMenuItemPhoto(restaurantId, menuItemId, photoId, provider) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return deletePhoto(MENU_ITEM_CONFIG, menuItemId, photoId, provider);
}

async function updateMenuItemPhotoCrop(restaurantId, menuItemId, photoId, target, crop, rotation) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return updateCrop(MENU_ITEM_CONFIG, menuItemId, photoId, target, crop, rotation);
}

module.exports = {
  ALT_TEXT_MAX,
  MAX_PHOTOS_PER_OWNER,
  RESTAURANT_MAX_PHOTOS,
  photoVariantUrls,
  CROP_TARGETS,
  normalizeCrop,
  normalizeRotation,
  resolvePrimaryPhoto,
  variantObjectKey,
  normalizeAltText,
  // рестораны
  listRestaurantPhotos,
  getRestaurantPhotoById,
  uploadRestaurantPhoto,
  setRestaurantPhotoPrimary,
  updateRestaurantPhotoAlt,
  deleteRestaurantPhoto,
  // блюда
  listMenuItemPhotos,
  listMenuItemPhotosForRestaurant,
  getMenuItemPhotoById,
  uploadMenuItemPhoto,
  setMenuItemPhotoPrimary,
  updateMenuItemPhotoAlt,
  deleteMenuItemPhoto,
  updateMenuItemPhotoCrop,
};
