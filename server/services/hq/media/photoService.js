'use strict';

// YAAM HQ Stage 5B — CRUD фотографий ресторанов и блюд (задание, разделы
// 3-4, 6-7, 11). Единственное место в кодовой базе, которое пишет в таблицы
// restaurant_photos/menu_item_photos И одновременно вызывает media provider
// (upload()/delete()) — тот же принцип "один сервис = единственный источник
// SQL для своего раздела", что и menuAdminService.js/restaurantAdminService.js.
//
// provider (LocalMediaProvider | S3MediaProvider) передаётся явным
// параметром в каждую функцию, которая реально трогает хранилище — не
// импортируется здесь как singleton, чтобы:
//   1) unit/integration-тесты могли передать LocalMediaProvider с временным
//      каталогом, не трогая ничего внешнего (задание, раздел 17);
//   2) app-слой (server.postgresql.js) сам решал, монтировать ли медиа-
//      функциональность вовсе (fail-closed при неполном S3-конфиге —
//      см. services/hq/media/provider.js).
//
// Архивирование/восстановление — как и restaurants.archived_at/
// menu_items.archived_at — НИКОГДА не удаляет строку физически (задание,
// раздел 3: "archiving instead of physical row deletion") и НЕ трогает
// объект в хранилище: восстановление обязано мгновенно вернуть точно ту же
// фотографию, без повторной загрузки. Единственное место, где эта служба
// реально удаляет объекты из хранилища — компенсация при неудачной
// транзакции ПОСЛЕ уже успешной загрузки (задание, раздел 11: "no orphan
// objects"), не пользовательское действие.
const crypto = require('node:crypto');
const db = require('../../../db/postgresql');
const { ValidationError } = require('../restaurantLifecycle');
const menuSvc = require('../menuAdminService');
const { processImage, VARIANTS } = require('./imagePipeline');

const ALT_TEXT_MAX = 200;
// Разумный верхний предел количества АКТИВНЫХ фотографий на одного владельца
// (задание, раздел 5: "a cap on photo count per restaurant/dish") — защита
// от абсурдного объёма, не бизнес-ограничение; архивированные фотографии в
// счётчик не входят.
const MAX_PHOTOS_PER_OWNER = 20;

const VARIANT_NAMES = Object.keys(VARIANTS); // ['thumb', 'card', 'full']

function variantObjectKey(storageKeyBase, variant) {
  return `${storageKeyBase}-${variant}.webp`;
}

// Публичные URL фотографии — всегда ВЫВОДЯТСЯ из storage_key через активный
// провайдер, никогда не хранятся в БД (задание, раздел 3/4 — устойчивость к
// смене домена/провайдера в будущем без миграции данных).
function photoVariantUrls(provider, photo) {
  const urls = {};
  for (const variant of VARIANT_NAMES) {
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

async function deleteAllVariants(provider, storageKeyBase) {
  for (const variant of VARIANT_NAMES) {
    try {
      await provider.delete(variantObjectKey(storageKeyBase, variant));
    } catch (err) {
      // Компенсация — best-effort. Если удаление одного варианта не
      // удалось, продолжаем удалять остальные и логируем, а не бросаем:
      // вызывающий код уже находится в error-path (либо DB-транзакция
      // упала, либо это ручная архивация), падать вторично здесь означало
      // бы потерять исходную причину ошибки.
      console.error(`[photoService] не удалось удалить объект ${variant} (${storageKeyBase}):`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Конфигурация владельца: restaurant_photos (restaurant_id) или
// menu_item_photos (menu_item_id). Вся остальная логика ниже — общая.
// ---------------------------------------------------------------------------

const RESTAURANT_CONFIG = { table: 'restaurant_photos', ownerColumn: 'restaurant_id', keyPrefix: 'restaurants' };
const MENU_ITEM_CONFIG = { table: 'menu_item_photos', ownerColumn: 'menu_item_id', keyPrefix: 'menu-items' };

async function listPhotos(config, ownerId, { includeArchived = false } = {}) {
  const where = includeArchived
    ? `${config.ownerColumn} = $1`
    : `${config.ownerColumn} = $1 AND archived_at IS NULL`;
  return db.query(
    `SELECT * FROM ${config.table} WHERE ${where} ORDER BY archived_at NULLS FIRST, sort_order, id`,
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

// Из активных фотографий владельца выбирает primary; если primary нет (была
// архивирована) — первую активную по sort_order (задание, раздел 6: "if no
// primary, use the first active photo"). Работает как на живых строках из
// БД, так и на уже отфильтрованном active-списке — принимает ТОЛЬКО активные
// фотографии (archived_at IS NULL), сортированные по sort_order.
function resolvePrimaryPhoto(activePhotos) {
  if (!activePhotos.length) return null;
  return activePhotos.find((p) => p.is_primary === 1) || activePhotos[0];
}

async function uploadPhoto(config, provider, ownerId, buffer, altTextRaw) {
  const altText = normalizeAltText(altTextRaw);

  const activeCountRows = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${config.table} WHERE ${config.ownerColumn} = $1 AND archived_at IS NULL`,
    [ownerId],
  );
  if (activeCountRows[0].n >= MAX_PHOTOS_PER_OWNER) {
    throw new ValidationError(`Достигнут предел ${MAX_PHOTOS_PER_OWNER} фотографий — сначала архивируйте лишние.`);
  }

  // Валидация/обработка (сигнатура, размер, decompression bomb, EXIF,
  // ресайз в WebP-варианты) — ПОЛНОСТЬЮ до того, как хранилище или БД вообще
  // узнают о загрузке (задание, раздел 5/11).
  const processed = await processImage(buffer);

  const storageKeyBase = `${config.keyPrefix}/${ownerId}/${crypto.randomUUID()}`;

  const uploaded = [];
  try {
    for (const variant of VARIANT_NAMES) {
      const key = variantObjectKey(storageKeyBase, variant);
      await provider.upload(key, processed.variants[variant].buffer, 'image/webp');
      uploaded.push(key);
    }
  } catch (err) {
    // Загрузка хотя бы одного варианта не удалась — подчищаем уже
    // загруженные, чтобы не оставить частично загруженный "фантомный"
    // объект без записи в БД (задание, раздел 11: "interrupted upload").
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
        `SELECT COUNT(*)::int AS n FROM ${config.table}
         WHERE ${config.ownerColumn} = $1 AND is_primary = 1 AND archived_at IS NULL`,
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
    // компенсирующее удаление всех трёх вариантов (задание, раздел 11:
    // "storage upload succeeds but the DB insert fails -> the object must
    // be deleted as a compensating action").
    await deleteAllVariants(provider, storageKeyBase);
    throw err;
  }
}

async function setPrimary(config, ownerId, photoId) {
  const photo = await getPhotoById(config, ownerId, photoId);
  if (!photo) return null;
  if (photo.archived_at) throw new ValidationError('Архивированную фотографию нельзя сделать основной.');
  if (photo.is_primary === 1) return photo; // уже основная — не ошибка

  return db.transaction(async (client) => {
    await db.execute(
      `UPDATE ${config.table} SET is_primary = 0, updated_at = NOW()
       WHERE ${config.ownerColumn} = $1 AND is_primary = 1 AND archived_at IS NULL`,
      [ownerId],
      client,
    );
    const updated = await db.execute(
      `UPDATE ${config.table} SET is_primary = 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [photo.id],
      client,
    );
    return updated.rows[0];
  });
}

// Атомарный SWAP sort_order с соседней активной фотографией — тот же
// принцип, что moveCategory/moveMenuItem (menuAdminService.js).
async function movePhoto(config, ownerId, photoId, direction) {
  const photo = await getPhotoById(config, ownerId, photoId);
  if (!photo) return null;
  if (photo.archived_at) throw new ValidationError('Архивированную фотографию нельзя перемещать.');
  const comparator = direction === 'up' ? '<' : '>';
  const order = direction === 'up' ? 'DESC' : 'ASC';
  return db.transaction(async (client) => {
    const neighborRows = await db.query(
      `SELECT * FROM ${config.table}
       WHERE ${config.ownerColumn} = $1 AND archived_at IS NULL AND id != $2
         AND sort_order ${comparator} $3
       ORDER BY sort_order ${order}, id ${order}
       LIMIT 1`,
      [ownerId, photoId, photo.sort_order],
      client,
    );
    const neighbor = neighborRows[0];
    if (!neighbor) return photo; // уже крайняя — нечего делать, не ошибка
    await db.execute(`UPDATE ${config.table} SET sort_order = $1, updated_at = NOW() WHERE id = $2`, [neighbor.sort_order, photo.id], client);
    await db.execute(`UPDATE ${config.table} SET sort_order = $1, updated_at = NOW() WHERE id = $2`, [photo.sort_order, neighbor.id], client);
    return { ...photo, sort_order: neighbor.sort_order };
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

async function archivePhoto(config, ownerId, photoId) {
  const photo = await getPhotoById(config, ownerId, photoId);
  if (!photo) return null;
  if (photo.archived_at) throw new ValidationError('Фотография уже архивирована.');
  const updated = await db.execute(
    `UPDATE ${config.table} SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [photo.id],
  );
  return updated.rows[0] || null;
}

// Восстановление обязано мгновенно вернуть фотографию БЕЗ повторной
// загрузки (storage не трогается). is_primary у архивированной строки мог
// сохраниться с момента архивации — если к моменту восстановления у
// владельца уже есть ДРУГАЯ активная primary-фотография, восстановленная
// строка не может стать второй primary (partial unique index это бы и не
// позволил) — снимаем флаг явно, владелец при необходимости выберет
// primary заново одним кликом.
async function restorePhoto(config, ownerId, photoId) {
  const photo = await getPhotoById(config, ownerId, photoId);
  if (!photo) return null;
  if (!photo.archived_at) throw new ValidationError('Фотография не архивирована.');

  return db.transaction(async (client) => {
    let becomesPrimary = photo.is_primary === 1;
    if (becomesPrimary) {
      const existingPrimary = await db.query(
        `SELECT COUNT(*)::int AS n FROM ${config.table}
         WHERE ${config.ownerColumn} = $1 AND is_primary = 1 AND archived_at IS NULL`,
        [ownerId],
        client,
      );
      if (existingPrimary[0].n > 0) becomesPrimary = false;
    }
    const updated = await db.execute(
      `UPDATE ${config.table} SET archived_at = NULL, is_primary = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [becomesPrimary ? 1 : 0, photo.id],
      client,
    );
    return updated.rows[0];
  });
}

// ---------------------------------------------------------------------------
// Публичные обёртки — рестораны
// ---------------------------------------------------------------------------

const listRestaurantPhotos = (restaurantId, opts) => listPhotos(RESTAURANT_CONFIG, restaurantId, opts);
const getRestaurantPhotoById = (restaurantId, photoId) => getPhotoById(RESTAURANT_CONFIG, restaurantId, photoId);
const uploadRestaurantPhoto = (provider, restaurantId, buffer, altText) =>
  uploadPhoto(RESTAURANT_CONFIG, provider, restaurantId, buffer, altText);
const setRestaurantPhotoPrimary = (restaurantId, photoId) => setPrimary(RESTAURANT_CONFIG, restaurantId, photoId);
const moveRestaurantPhoto = (restaurantId, photoId, direction) => movePhoto(RESTAURANT_CONFIG, restaurantId, photoId, direction);
const updateRestaurantPhotoAlt = (restaurantId, photoId, altText) => updateAltText(RESTAURANT_CONFIG, restaurantId, photoId, altText);
const archiveRestaurantPhoto = (restaurantId, photoId) => archivePhoto(RESTAURANT_CONFIG, restaurantId, photoId);
const restoreRestaurantPhoto = (restaurantId, photoId) => restorePhoto(RESTAURANT_CONFIG, restaurantId, photoId);

// ---------------------------------------------------------------------------
// Публичные обёртки — блюда. menuItemId ДОЛЖЕН реально принадлежать
// restaurantId — тот же принцип, что assertCategoryBelongsToRestaurant в
// menuAdminService.js (задание, раздел 11: ownership checks), поэтому все
// обёртки блюда принимают restaurantId первым аргументом и проверяют его
// через menuSvc.getMenuItemById (уже фильтрует по restaurant_id).
// ---------------------------------------------------------------------------

async function assertMenuItemOwnership(restaurantId, menuItemId) {
  const item = await menuSvc.getMenuItemById(restaurantId, menuItemId);
  if (!item) throw new ValidationError('Блюдо не найдено или принадлежит другому ресторану.');
  return item;
}

async function listMenuItemPhotos(restaurantId, menuItemId, opts) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return listPhotos(MENU_ITEM_CONFIG, menuItemId, opts);
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

async function moveMenuItemPhoto(restaurantId, menuItemId, photoId, direction) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return movePhoto(MENU_ITEM_CONFIG, menuItemId, photoId, direction);
}

async function updateMenuItemPhotoAlt(restaurantId, menuItemId, photoId, altText) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return updateAltText(MENU_ITEM_CONFIG, menuItemId, photoId, altText);
}

async function archiveMenuItemPhoto(restaurantId, menuItemId, photoId) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return archivePhoto(MENU_ITEM_CONFIG, menuItemId, photoId);
}

async function restoreMenuItemPhoto(restaurantId, menuItemId, photoId) {
  await assertMenuItemOwnership(restaurantId, menuItemId);
  return restorePhoto(MENU_ITEM_CONFIG, menuItemId, photoId);
}

module.exports = {
  ALT_TEXT_MAX,
  MAX_PHOTOS_PER_OWNER,
  photoVariantUrls,
  resolvePrimaryPhoto,
  variantObjectKey,
  normalizeAltText,
  // рестораны
  listRestaurantPhotos,
  getRestaurantPhotoById,
  uploadRestaurantPhoto,
  setRestaurantPhotoPrimary,
  moveRestaurantPhoto,
  updateRestaurantPhotoAlt,
  archiveRestaurantPhoto,
  restoreRestaurantPhoto,
  // блюда
  listMenuItemPhotos,
  getMenuItemPhotoById,
  uploadMenuItemPhoto,
  setMenuItemPhotoPrimary,
  moveMenuItemPhoto,
  updateMenuItemPhotoAlt,
  archiveMenuItemPhoto,
  restoreMenuItemPhoto,
};
