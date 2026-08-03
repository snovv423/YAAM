'use strict';

// YAAM HQ — вкладка «Меню» внутри ресторана (docs/HQ-PRODUCT-SPEC.md,
// раздел «Меню»). Тот же принцип, что и hq/restaurantsViews.js: шаблонные
// функции без движка/фреймворка, esc() на каждое значение из БД.
//
// Экран полностью переработан: вместо технической таблицы с постоянными
// кнопками «Выше»/«Ниже»/«Переименовать»/«Архивировать» у каждой строки —
// категории-аккордеоны с компактными строками блюд. Управление категорией
// спрятано в её собственное маленькое меню, порядок меняется перетаскиванием
// (hq/static/hq.js), архив вынесен на отдельный экран.
const { esc } = require('./layout');
const { money } = require('./restaurantsViews');
const { renderPhotoManager } = require('./photosViews');

// «На витрине» / «Снято с витрины» — продуктовые формулировки спецификации.
// «Сделать недоступным»/«Временно недоступно» больше не используются нигде.
function itemStatusLabel(item) {
  if (item.archived_at) return 'В архиве';
  return item.is_available ? 'На витрине' : 'Снято с витрины';
}

function pluralDishes(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'блюдо';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'блюда';
  return 'блюд';
}

function formatArchivedAt(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Компактная строка блюда (спецификация, раздел «Компактные карточки блюд»):
// маленькое квадратное фото, название, цена, спокойный статус. Вся строка —
// одна ссылка на редактирование; отдельных действий в строке нет.
// dragHandle — маленький отдельный handle, а НЕ вся строка: на мобильном
// перетаскивание всей строки конфликтовало бы с обычной прокруткой.
function renderDishRow({ item, linkBasePath, restaurantId }) {
  const href = `${linkBasePath}/restaurants/${restaurantId}/menu/items/${item.id}`;
  const thumb = item.thumb_url
    ? `<img class="dish-thumb" src="${esc(item.thumb_url)}" alt="" loading="lazy" width="48" height="48">`
    : '<div class="dish-thumb placeholder" aria-hidden="true"></div>';
  return `
    <li class="dish-row" data-item-id="${item.id}">
      <span class="drag-handle" aria-hidden="true" title="Перетащить"></span>
      <a class="dish-link" href="${href}">
        ${thumb}
        <span class="dish-main">
          <span class="dish-name">${esc(item.name)}</span>
          <span class="dish-meta">${money(item.price)} · ${esc(itemStatusLabel(item))}</span>
        </span>
        <span class="dish-chevron" aria-hidden="true"></span>
      </a>
    </li>`;
}

// Категория-аккордеон: <details>/<summary> — раскрытие на той же странице
// без единой строки JS (спецификация: «раскрывается на той же странице как
// шторка»), работает и при отключённом JS.
function renderCategoryBlock({ restaurant, category, csrfToken, linkBasePath, allCategories }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;
  const items = category.items.filter((i) => !i.archived_at);
  const otherCategories = allCategories.filter((c) => !c.archived_at && c.id !== category.id);

  const archiveForm = items.length === 0
    ? `<form method="post" action="${base}/categories/${category.id}/archive" onsubmit="return confirm('Архивировать пустую категорию «${esc(category.name)}»?')">
         <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
         <button type="submit" class="ghost compact">Архивировать</button>
       </form>`
    : `<a class="btn ghost compact" href="${base}/categories/${category.id}/archive-options">Архивировать</a>`;

  return `
    <details class="cat-block" data-category-id="${category.id}">
      <summary class="cat-summary">
        <span class="drag-handle cat-handle" aria-hidden="true" title="Перетащить"></span>
        <span class="cat-titles">
          <span class="cat-name">${esc(category.name)}</span>
          <span class="cat-count">${items.length} ${esc(pluralDishes(items.length))}</span>
        </span>
      </summary>
      <div class="cat-body">
        <div class="cat-actions">
          <a class="btn compact" href="${base}/items/new?category=${category.id}">+ Добавить блюдо</a>
          <a class="btn ghost compact" href="${base}/categories/${category.id}/edit">Переименовать</a>
          ${archiveForm}
        </div>
        ${items.length
          ? `<ul class="dish-list" data-reorder="items" data-category-id="${category.id}" data-endpoint="${base}/categories/${category.id}/reorder-items">${items.map((item) => renderDishRow({ item, linkBasePath, restaurantId: restaurant.id })).join('')}</ul>`
          : '<div class="empty-state">В категории пока нет блюд.</div>'}
      </div>
    </details>`;
}

function renderMenuTab({ restaurant, menu, csrfToken, linkBasePath, error, notice }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;
  const activeCategories = menu.filter((c) => !c.archived_at);

  return `
    ${error ? `<div class="error" style="margin-bottom:14px">${esc(error)}</div>` : ''}
    ${notice ? `<div class="notice" style="margin-bottom:14px">${esc(notice)}</div>` : ''}

    <div class="menu-toolbar">
      <details class="add-cat">
        <summary class="btn compact">+ Добавить категорию</summary>
        <form class="add-cat-form" method="post" action="${base}/categories">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <input name="name" type="text" placeholder="Например: Горячее" maxlength="100" required autocomplete="off" aria-label="Название категории">
          <button type="submit" class="compact">Сохранить</button>
        </form>
      </details>
      <a class="btn ghost compact" href="${base}/archive">Архив</a>
    </div>

    ${activeCategories.length
      ? `<div class="cat-list" data-reorder="categories" data-endpoint="${base}/reorder-categories">${activeCategories.map((category) => renderCategoryBlock({ restaurant, category, csrfToken, linkBasePath, allCategories: menu })).join('')}</div>`
      : '<div class="panel"><div class="empty-state">Категорий пока нет. Начните с добавления категории — блюда создаются внутри неё.</div></div>'}
  `;
}

// ===========================================================================
// Архивирование непустой категории — два варианта (спецификация, раздел
// «Категории»): перенести блюда либо архивировать вместе с блюдами.
// ===========================================================================

function renderCategoryArchiveOptions({ restaurant, category, otherCategories, itemsCount, csrfToken, linkBasePath, error }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;
  return `
    <h2>Архивировать «${esc(category.name)}»</h2>
    <div class="panel">
      <div class="empty-state" style="margin-bottom:14px">В категории ${itemsCount} ${esc(pluralDishes(itemsCount))}. Выберите, что с ними сделать — блюда не удаляются ни в одном из вариантов, история заказов сохраняется.</div>
      ${error ? `<div class="error" style="margin-bottom:14px">${esc(error)}</div>` : ''}

      ${otherCategories.length ? `
      <form method="post" action="${base}/categories/${category.id}/move-items-archive" style="margin-bottom:22px">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="ca-target">Перенести блюда в категорию</label>
        <select id="ca-target" name="target_category_id" required>
          ${otherCategories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
        <button type="submit" class="compact" style="margin-top:12px">Перенести и архивировать</button>
      </form>` : '<div class="empty-state" style="margin-bottom:22px">Других активных категорий нет — перенести блюда некуда.</div>'}

      <form method="post" action="${base}/categories/${category.id}/archive-with-items" onsubmit="return confirm('Архивировать категорию вместе с ${itemsCount} ${esc(pluralDishes(itemsCount))}?')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="ghost compact">Архивировать вместе с блюдами</button>
      </form>
    </div>
    <a class="btn ghost compact" href="${base}">← К меню</a>
  `;
}

// ===========================================================================
// Архив меню (спецификация, раздел «Архив меню»)
// ===========================================================================

function renderMenuArchive({ restaurant, archive, activeCategories, csrfToken, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;

  const itemRows = archive.items.map((item) => {
    const thumb = item.thumb_url
      ? `<img class="dish-thumb" src="${esc(item.thumb_url)}" alt="" loading="lazy" width="48" height="48">`
      : '<div class="dish-thumb placeholder" aria-hidden="true"></div>';
    const archivedAt = formatArchivedAt(item.archived_at);
    // Прежней категории нет в рабочем меню — восстановить «как было» нельзя,
    // владелец обязан выбрать категорию (спецификация).
    const needsCategory = item.category_archived || !item.category_name;
    const categorySelect = needsCategory && activeCategories.length
      ? `<select name="target_category_id" required aria-label="Категория для восстановления">
           ${activeCategories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
         </select>`
      : '';
    const canRestore = !needsCategory || activeCategories.length > 0;
    return `
      <li class="dish-row archive-row">
        <div class="dish-link static">
          ${thumb}
          <span class="dish-main">
            <span class="dish-name">${esc(item.name)}</span>
            <span class="dish-meta">${esc(item.category_name || 'Категория удалена')}${archivedAt ? ` · ${esc(archivedAt)}` : ''}</span>
          </span>
        </div>
        ${canRestore ? `
        <form class="restore-form" method="post" action="${base}/items/${item.id}/restore">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          ${categorySelect}
          <button type="submit" class="ghost compact">Восстановить</button>
        </form>` : '<span class="dish-meta">Нет активных категорий</span>'}
      </li>`;
  }).join('');

  const categoryRows = archive.categories.map((c) => `
    <li class="dish-row archive-row">
      <div class="dish-link static">
        <span class="dish-main">
          <span class="dish-name">${esc(c.name)}</span>
          <span class="dish-meta">Категория${c.archived_at ? ` · ${esc(formatArchivedAt(c.archived_at))}` : ''}</span>
        </span>
      </div>
      <form class="restore-form" method="post" action="${base}/categories/${c.id}/restore">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="ghost compact">Восстановить</button>
      </form>
    </li>`).join('');

  return `
    <h2>Архив меню</h2>
    ${archive.items.length === 0 && archive.categories.length === 0
      ? '<div class="panel"><div class="empty-state">Архив пуст.</div></div>'
      : `
      ${archive.items.length ? `<div class="panel"><div class="panel-title">Блюда</div><ul class="dish-list">${itemRows}</ul></div>` : ''}
      ${archive.categories.length ? `<div class="panel"><div class="panel-title">Категории</div><ul class="dish-list">${categoryRows}</ul></div>` : ''}
      `}
    <a class="btn ghost compact" href="${base}">← К меню</a>
  `;
}

// ===========================================================================
// Форма категории (переименование)
// ===========================================================================

function renderCategoryEditForm({ restaurant, category, error, csrfToken, linkBasePath }) {
  return `
    <h2>Переименовать категорию</h2>
    <div class="panel">
      <form method="post" action="${linkBasePath}/restaurants/${restaurant.id}/menu/categories/${category.id}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="cf-name">Название</label>
        <input id="cf-name" name="name" type="text" value="${esc(category.name)}" maxlength="100" required autocomplete="off">
        <button type="submit" class="compact">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost compact" href="${linkBasePath}/restaurants/${restaurant.id}/menu">← К меню</a>
  `;
}

// ===========================================================================
// Форма блюда (создание и редактирование — общая разметка)
// ===========================================================================
//
// Внизу — Сохранить / Снять с витрины (или Вернуть на витрину) /
// Архивировать (спецификация, раздел «Редактирование блюда»). Формулировка
// «Сделать недоступным» не используется. Физического удаления нет: блюдо,
// участвовавшее в заказах, только архивируется.
function renderMenuItemForm({
  restaurant, item, categories, error, csrfToken, linkBasePath, isNew,
  photos = [], mediaConfigured = false, maxPhotos = 0, presetCategoryId = null,
}) {
  const v = item || {};
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;
  const action = isNew ? `${base}/items` : `${base}/items/${v.id}`;
  const activeCategories = categories.filter((c) => !c.archived_at || c.id === v.category_id);
  const selectedCategoryId = v.category_id || (presetCategoryId ? Number(presetCategoryId) : null);
  const title = isNew ? 'Добавить блюдо' : (v.name || 'Блюдо');

  const bottomActions = isNew ? '' : `
    <div class="item-actions">
      ${v.archived_at ? '' : `
      <form method="post" action="${base}/items/${v.id}/available">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="available" value="${v.is_available ? '0' : '1'}">
        <button type="submit" class="ghost compact">${v.is_available ? 'Снять с витрины' : 'Вернуть на витрину'}</button>
      </form>
      <form method="post" action="${base}/items/${v.id}/archive" onsubmit="return confirm('Архивировать «${esc(v.name || '')}»? Блюдо исчезнет из меню и с витрины, история заказов сохранится.')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="ghost compact">Архивировать</button>
      </form>`}
    </div>`;

  return `
    <h2>${esc(title)}</h2>
    ${!isNew ? `<div class="item-status">${esc(itemStatusLabel(v))}</div>` : ''}
    <div class="panel">
      <form method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="if-name">Название</label>
        <input id="if-name" name="name" type="text" value="${esc(v.name || '')}" maxlength="200" required autocomplete="off">
        <label for="if-category">Категория</label>
        <select id="if-category" name="category_id" required>
          ${activeCategories.map((c) => `<option value="${c.id}" ${c.id === selectedCategoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <label for="if-price">Цена, ₽</label>
        <input id="if-price" name="price" type="number" min="0" max="1000000" value="${v.price ?? ''}" required autocomplete="off">
        <label for="if-description">Краткое описание</label>
        <textarea id="if-description" name="description" maxlength="500" autocomplete="off">${esc(v.description || '')}</textarea>
        <label for="if-composition">Состав</label>
        <textarea id="if-composition" name="composition" maxlength="1000" autocomplete="off">${esc(v.composition || '')}</textarea>
        <div class="row">
          <div>
            <label for="if-weight">Вес, г</label>
            <input id="if-weight" name="weight_g" type="number" min="0" max="20000" value="${v.weight_g ?? ''}" placeholder="не указан" autocomplete="off">
          </div>
          <div>
            <label for="if-kcal">Калории, ккал</label>
            <input id="if-kcal" name="kcal" type="number" min="0" max="20000" value="${v.kcal ?? ''}" placeholder="не указаны" autocomplete="off">
          </div>
        </div>
        <div class="row">
          <div>
            <label for="if-protein">Белки, г</label>
            <input id="if-protein" name="protein_g" type="number" min="0" max="2000" value="${v.protein_g ?? ''}" placeholder="не указаны" autocomplete="off">
          </div>
          <div>
            <label for="if-fat">Жиры, г</label>
            <input id="if-fat" name="fat_g" type="number" min="0" max="2000" value="${v.fat_g ?? ''}" placeholder="не указаны" autocomplete="off">
          </div>
          <div>
            <label for="if-carbs">Углеводы, г</label>
            <input id="if-carbs" name="carbs_g" type="number" min="0" max="2000" value="${v.carbs_g ?? ''}" placeholder="не указаны" autocomplete="off">
          </div>
        </div>
        <label for="if-photo">Ссылка на фото (необязательно)</label>
        <input id="if-photo" name="photo_url" type="text" value="${esc(v.photo_url || '')}" placeholder="https://..." autocomplete="off">
        ${photos.length ? '<div class="photo-meta">Используется, только если ниже нет ни одной загруженной фотографии.</div>' : ''}
        <button type="submit" class="compact">${isNew ? 'Добавить блюдо' : 'Сохранить'}</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
      ${bottomActions}
    </div>
    ${!isNew ? renderPhotoManager({
      title: 'Фотографии блюда',
      photos, mediaConfigured, maxPhotos,
      uploadAction: `${base}/items/${v.id}/photos`,
      actionBase: `${base}/items/${v.id}/photos`,
      csrfToken,
    }) : ''}
    <a class="btn ghost compact" href="${base}">← К меню</a>
  `;
}

module.exports = {
  itemStatusLabel,
  pluralDishes,
  renderMenuTab,
  renderCategoryEditForm,
  renderCategoryArchiveOptions,
  renderMenuArchive,
  renderMenuItemForm,
};
