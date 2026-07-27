'use strict';

// YAAM HQ Stage 5A — рабочее управление меню (категории + блюда) для
// конкретного ресторана. Тот же архитектурный принцип, что и services/hq/
// restaurantAdminService.js (Stage 4): единственное новое место для SQL
// этого раздела, переиспользует существующие таблицы categories/menu_items
// (server/db/postgresql/schema.sql) как есть — они уже поддерживали ровно
// нужные поля (name/price/description/composition/weight_g/kcal/protein_g/
// fat_g/carbs_g/photo_url/is_available/sort_order), Stage 5A добавил только
// additive `archived_at` на обе таблицы.
//
// ValidationError переиспользуется из restaurantLifecycle.js (Stage 4.1) —
// тот же класс, что и весь остальной HQ, не третья копия.
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');

// ---------------------------------------------------------------------------
// Валидация
// ---------------------------------------------------------------------------

const CATEGORY_NAME_MAX = 100;
const ITEM_NAME_MAX = 200;
const DESCRIPTION_MAX = 500;
const COMPOSITION_MAX = 1000;
const PHOTO_URL_MAX = 2000;
// Верхние границы — разумная защита от опечаток/абсурдных значений
// (задание, раздел 6: "разумный верхний лимит"), не бизнес-требование —
// ни одно из них никогда не должно реально ограничивать настоящий ресторан.
const PRICE_MAX = 1_000_000; // ₽, целые рубли — та же денежная модель, что и min_order/delivery_price (INTEGER, не float/копейки)
const WEIGHT_MAX = 20_000; // граммов (20 кг)
const KCAL_MAX = 20_000;
const MACRO_MAX = 2_000; // граммов белков/жиров/углеводов

function normalizeName(value, max, fieldLabel) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new ValidationError(`${fieldLabel} обязательно.`);
  if (trimmed.length > max) throw new ValidationError(`${fieldLabel} слишком длинное (максимум ${max} символов).`);
  return trimmed;
}

function normalizeOptionalText(value, max, fieldLabel) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > max) throw new ValidationError(`${fieldLabel} слишком длинное (максимум ${max} символов).`);
  return trimmed;
}

// Пустая строка/undefined -> null ("данных нет"), НЕ 0 (задание, раздел 6:
// "пустое поле = данных нет, а не 0") — отличается от normalizePrice именно
// этим: цена обязательна и не может быть "неизвестна", БЖУ/вес — могут.
function normalizeOptionalNonNegativeInt(value, max, fieldLabel) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${fieldLabel} должно быть неотрицательным целым числом.`);
  }
  if (n > max) throw new ValidationError(`${fieldLabel} превышает допустимый предел.`);
  return n;
}

function normalizePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new ValidationError('Цена должна быть неотрицательным целым числом рублей.');
  }
  if (n > PRICE_MAX) throw new ValidationError(`Цена превышает допустимый предел (${PRICE_MAX} ₽).`);
  return n;
}

// Легаси-поле photo_url остаётся обычной текстовой URL-строкой (задание,
// раздел 1: "не создавать иллюзию полноценной загрузки файлов") — валидация
// только формата, не загрузка/хранение файла. javascript:/data: и другие
// не-http(s) схемы отклоняются явно (XSS/security, не только "невалидный
// URL") — задание, раздел 17.
function normalizePhotoUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.length > PHOTO_URL_MAX) throw new ValidationError(`Ссылка на фото слишком длинная (максимум ${PHOTO_URL_MAX} символов).`);
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError('Ссылка на фото должна быть корректным URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Ссылка на фото должна начинаться с http:// или https://.');
  }
  // `parsed.href`, НЕ исходная строка — WHATWG URL-парсер percent-encode'ит
  // символы вроде `"`/`<`/`>` внутри пути (задание, раздел 17: XSS-проверка
  // пользовательского текста) — эта нормализация закрывает атрибутный
  // breakout ("><script>...) на источнике, а не на каждой точке рендера
  // (публичный API/клиент/HQ-формы) по отдельности.
  return parsed.href;
}

function parseCategoryInput(body) {
  return { name: normalizeName(body.name, CATEGORY_NAME_MAX, 'Название категории') };
}

function parseMenuItemInput(body) {
  const name = normalizeName(body.name, ITEM_NAME_MAX, 'Название блюда');
  const categoryId = Number.parseInt(body.category_id, 10);
  if (!Number.isInteger(categoryId) || categoryId < 1) {
    throw new ValidationError('Выберите категорию.');
  }
  return {
    name,
    categoryId,
    price: normalizePrice(body.price),
    description: normalizeOptionalText(body.description, DESCRIPTION_MAX, 'Краткое описание'),
    composition: normalizeOptionalText(body.composition, COMPOSITION_MAX, 'Состав'),
    photoUrl: normalizePhotoUrl(body.photo_url),
    weightG: normalizeOptionalNonNegativeInt(body.weight_g, WEIGHT_MAX, 'Вес'),
    kcal: normalizeOptionalNonNegativeInt(body.kcal, KCAL_MAX, 'Калорийность'),
    proteinG: normalizeOptionalNonNegativeInt(body.protein_g, MACRO_MAX, 'Белки'),
    fatG: normalizeOptionalNonNegativeInt(body.fat_g, MACRO_MAX, 'Жиры'),
    carbsG: normalizeOptionalNonNegativeInt(body.carbs_g, MACRO_MAX, 'Углеводы'),
  };
}

// ---------------------------------------------------------------------------
// Категории
// ---------------------------------------------------------------------------

async function getCategoryById(restaurantId, categoryId) {
  const numericId = Number.parseInt(categoryId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM categories WHERE id = $1 AND restaurant_id = $2', [numericId, restaurantId]);
  return rows[0] || null;
}

async function createCategory(restaurantId, body) {
  const input = parseCategoryInput(body);
  const inserted = await db.execute(
    `INSERT INTO categories (restaurant_id, name, sort_order)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE restaurant_id = $1))
     RETURNING *`,
    [restaurantId, input.name],
  );
  return inserted.rows[0];
}

async function updateCategory(restaurantId, categoryId, body) {
  const input = parseCategoryInput(body);
  const updated = await db.execute(
    'UPDATE categories SET name = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *',
    [input.name, categoryId, restaurantId],
  );
  return updated.rows[0] || null;
}

// Пустую категорию можно архивировать; непустую (есть хотя бы одно НЕ
// архивированное блюдо) — нет, владелец должен сначала переместить или
// архивировать блюда (задание, раздел 5: "предпочтительный минимальный
// вариант"). Уже архивированные блюда категорию не блокируют — они и так не
// видны публично, архивирование категории поверх них ничего не защищает
// дополнительно.
async function archiveCategory(restaurantId, categoryId) {
  const category = await getCategoryById(restaurantId, categoryId);
  if (!category) return null;
  if (category.archived_at) throw new ValidationError('Категория уже архивирована.');
  const activeItems = await db.query(
    'SELECT COUNT(*)::int AS n FROM menu_items WHERE category_id = $1 AND archived_at IS NULL',
    [categoryId],
  );
  if (activeItems[0].n > 0) {
    throw new ValidationError('В категории есть активные блюда — сначала переместите или архивируйте их.');
  }
  const updated = await db.execute(
    'UPDATE categories SET archived_at = NOW() WHERE id = $1 AND restaurant_id = $2 RETURNING *',
    [categoryId, restaurantId],
  );
  return updated.rows[0] || null;
}

async function restoreCategory(restaurantId, categoryId) {
  const category = await getCategoryById(restaurantId, categoryId);
  if (!category) return null;
  if (!category.archived_at) throw new ValidationError('Категория не архивирована.');
  const updated = await db.execute(
    'UPDATE categories SET archived_at = NULL WHERE id = $1 AND restaurant_id = $2 RETURNING *',
    [categoryId, restaurantId],
  );
  return updated.rows[0] || null;
}

// Перемещение — атомарный SWAP sort_order с соседней активной категорией
// (задание, раздел 10: "перемещение атомарно; два элемента не должны
// получать хаотичный одинаковый порядок; параллельные запросы не должны
// разрушать последовательность"). Архивированные категории исключены из
// соседства — перемещение никогда не "перепрыгивает" через них молча, они
// просто не считаются кандидатами.
async function moveCategory(restaurantId, categoryId, direction) {
  const category = await getCategoryById(restaurantId, categoryId);
  if (!category) return null;
  if (category.archived_at) throw new ValidationError('Архивированную категорию нельзя перемещать.');
  const comparator = direction === 'up' ? '<' : '>';
  const order = direction === 'up' ? 'DESC' : 'ASC';
  return db.transaction(async (client) => {
    const neighborRows = await db.query(
      `SELECT * FROM categories
       WHERE restaurant_id = $1 AND archived_at IS NULL AND id != $2
         AND sort_order ${comparator} $3
       ORDER BY sort_order ${order}, id ${order}
       LIMIT 1`,
      [restaurantId, categoryId, category.sort_order],
      client,
    );
    const neighbor = neighborRows[0];
    if (!neighbor) return category; // уже крайняя — нечего делать, не ошибка
    await db.execute('UPDATE categories SET sort_order = $1 WHERE id = $2', [neighbor.sort_order, category.id], client);
    await db.execute('UPDATE categories SET sort_order = $1 WHERE id = $2', [category.sort_order, neighbor.id], client);
    return { ...category, sort_order: neighbor.sort_order };
  });
}

// ---------------------------------------------------------------------------
// Блюда
// ---------------------------------------------------------------------------

async function getMenuItemById(restaurantId, itemId) {
  const numericId = Number.parseInt(itemId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM menu_items WHERE id = $1 AND restaurant_id = $2', [numericId, restaurantId]);
  return rows[0] || null;
}

// Категория должна реально принадлежать ЭТОМУ ресторану — не доверяем
// category_id из формы без проверки (задание, раздел 6/17: "category
// ownership checks"), даже если он пришёл из выпадающего списка,
// сгенерированного самим HQ (защита от подмены запроса напрямую).
async function assertCategoryBelongsToRestaurant(restaurantId, categoryId) {
  const category = await getCategoryById(restaurantId, categoryId);
  if (!category) throw new ValidationError('Категория не найдена или принадлежит другому ресторану.');
  if (category.archived_at) throw new ValidationError('Категория архивирована — выберите другую.');
  return category;
}

async function createMenuItem(restaurantId, body) {
  const input = parseMenuItemInput(body);
  await assertCategoryBelongsToRestaurant(restaurantId, input.categoryId);
  const inserted = await db.execute(
    `INSERT INTO menu_items (
       restaurant_id, category_id, name, description, price, photo_url,
       weight_g, kcal, protein_g, fat_g, carbs_g, composition, sort_order
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_items WHERE category_id = $2))
     RETURNING *`,
    [
      restaurantId, input.categoryId, input.name, input.description, input.price, input.photoUrl,
      input.weightG, input.kcal, input.proteinG, input.fatG, input.carbsG, input.composition,
    ],
  );
  return inserted.rows[0];
}

// Редактирование НЕ трогает order_items — те хранят собственный snapshot
// name/price на момент заказа (server/db/postgresql/schema.sql: комментарий
// "снимок названия на момент заказа") — задание, раздел 7/14, уже
// гарантировано существующей схемой, этот UPDATE её не касается вовсе.
async function updateMenuItem(restaurantId, itemId, body) {
  const input = parseMenuItemInput(body);
  await assertCategoryBelongsToRestaurant(restaurantId, input.categoryId);
  const updated = await db.execute(
    `UPDATE menu_items SET
       name = $1, category_id = $2, price = $3, description = $4, photo_url = $5,
       weight_g = $6, kcal = $7, protein_g = $8, fat_g = $9, carbs_g = $10, composition = $11
     WHERE id = $12 AND restaurant_id = $13
     RETURNING *`,
    [
      input.name, input.categoryId, input.price, input.description, input.photoUrl,
      input.weightG, input.kcal, input.proteinG, input.fatG, input.carbsG, input.composition,
      itemId, restaurantId,
    ],
  );
  return updated.rows[0] || null;
}

async function setMenuItemAvailability(restaurantId, itemId, available) {
  const item = await getMenuItemById(restaurantId, itemId);
  if (!item) return null;
  if (item.archived_at) throw new ValidationError('Архивированное блюдо нельзя сделать доступным напрямую — сначала восстановите его.');
  const updated = await db.execute(
    'UPDATE menu_items SET is_available = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *',
    [available ? 1 : 0, itemId, restaurantId],
  );
  return updated.rows[0] || null;
}

// Архивирование ВСЕГДА снимает доступность (тот же defense-in-depth
// принцип, что archiveRestaurant делает с is_open — Stage 4) — архивированное
// блюдо никогда не должно формально числиться "доступным".
async function archiveMenuItem(restaurantId, itemId) {
  const item = await getMenuItemById(restaurantId, itemId);
  if (!item) return null;
  if (item.archived_at) throw new ValidationError('Блюдо уже архивировано.');
  const updated = await db.execute(
    'UPDATE menu_items SET archived_at = NOW(), is_available = 0 WHERE id = $1 AND restaurant_id = $2 RETURNING *',
    [itemId, restaurantId],
  );
  return updated.rows[0] || null;
}

// Восстановленное блюдо остаётся НЕДОСТУПНЫМ (задание, раздел 9: "не делает
// его автоматически доступным клиентам") — владелец отдельно включает
// доступность через setMenuItemAvailability после проверки данных.
async function restoreMenuItem(restaurantId, itemId) {
  const item = await getMenuItemById(restaurantId, itemId);
  if (!item) return null;
  if (!item.archived_at) throw new ValidationError('Блюдо не архивировано.');
  const updated = await db.execute(
    'UPDATE menu_items SET archived_at = NULL WHERE id = $1 AND restaurant_id = $2 RETURNING *',
    [itemId, restaurantId],
  );
  return updated.rows[0] || null;
}

// Перемещение внутри своей категории — тот же атомарный SWAP, что и у
// категорий.
async function moveMenuItem(restaurantId, itemId, direction) {
  const item = await getMenuItemById(restaurantId, itemId);
  if (!item) return null;
  if (item.archived_at) throw new ValidationError('Архивированное блюдо нельзя перемещать.');
  const comparator = direction === 'up' ? '<' : '>';
  const order = direction === 'up' ? 'DESC' : 'ASC';
  return db.transaction(async (client) => {
    const neighborRows = await db.query(
      `SELECT * FROM menu_items
       WHERE category_id = $1 AND archived_at IS NULL AND id != $2
         AND sort_order ${comparator} $3
       ORDER BY sort_order ${order}, id ${order}
       LIMIT 1`,
      [item.category_id, itemId, item.sort_order],
      client,
    );
    const neighbor = neighborRows[0];
    if (!neighbor) return item;
    await db.execute('UPDATE menu_items SET sort_order = $1 WHERE id = $2', [neighbor.sort_order, item.id], client);
    await db.execute('UPDATE menu_items SET sort_order = $1 WHERE id = $2', [item.sort_order, neighbor.id], client);
    return { ...item, sort_order: neighbor.sort_order };
  });
}

// Перенос блюда в другую категорию того же ресторана — получает понятную
// позицию "последним" в новой категории (задание, раздел 10), не сохраняет
// старый числовой sort_order (тот был осмыслен только в контексте старой
// категории).
async function moveMenuItemToCategory(restaurantId, itemId, newCategoryId) {
  const item = await getMenuItemById(restaurantId, itemId);
  if (!item) return null;
  if (item.archived_at) throw new ValidationError('Архивированное блюдо нельзя перемещать.');
  await assertCategoryBelongsToRestaurant(restaurantId, newCategoryId);
  const updated = await db.execute(
    `UPDATE menu_items SET category_id = $1,
       sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_items WHERE category_id = $1)
     WHERE id = $2 AND restaurant_id = $3
     RETURNING *`,
    [newCategoryId, itemId, restaurantId],
  );
  return updated.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Чтение меню целиком (для вкладки «Меню» в HQ)
// ---------------------------------------------------------------------------

async function listMenu(restaurantId) {
  const categories = await db.query(
    'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY archived_at NULLS FIRST, sort_order, id',
    [restaurantId],
  );
  const items = await db.query(
    'SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order, id',
    [restaurantId],
  );
  return categories.map((category) => ({
    ...category,
    items: items.filter((item) => item.category_id === category.id),
  }));
}

// Используется и guard'ом openRestaurant (services/hq/
// restaurantAdminService.js), и авто-закрытием при отключении последнего
// блюда (routes/hq/restaurants.js) — единственное место, знающее точное
// определение "доступное блюдо" (задание, раздел 13: не архивировано,
// доступно, в активной категории).
async function countAvailableMenuItems(restaurantId) {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM menu_items mi
     JOIN categories c ON c.id = mi.category_id
     WHERE mi.restaurant_id = $1 AND mi.archived_at IS NULL AND mi.is_available = 1
       AND c.archived_at IS NULL`,
    [restaurantId],
  );
  return rows[0].n;
}

module.exports = {
  CATEGORY_NAME_MAX,
  ITEM_NAME_MAX,
  DESCRIPTION_MAX,
  COMPOSITION_MAX,
  PRICE_MAX,
  parseCategoryInput,
  parseMenuItemInput,
  normalizePrice,
  normalizeOptionalNonNegativeInt,
  normalizePhotoUrl,
  getCategoryById,
  createCategory,
  updateCategory,
  archiveCategory,
  restoreCategory,
  moveCategory,
  getMenuItemById,
  createMenuItem,
  updateMenuItem,
  setMenuItemAvailability,
  archiveMenuItem,
  restoreMenuItem,
  moveMenuItem,
  moveMenuItemToCategory,
  listMenu,
  countAvailableMenuItems,
};
