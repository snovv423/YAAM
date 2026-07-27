'use strict';

// YAAM HQ Stage 5A — server-rendered HTML для вкладки «Меню» внутри
// конкретного ресторана. Тот же принцип, что и hq/restaurantsViews.js:
// шаблонные функции без движка/фреймворка, esc() на каждое значение из БД.
const { esc } = require('./layout');
const { money } = require('./restaurantsViews');
const { renderPhotoManager } = require('./photosViews');

const ITEM_FILTERS = ['active', 'unavailable', 'archived', 'all'];

function categoryBadge(c) {
  return c.archived_at
    ? '<span class="badge closed">Архивирована</span>'
    : '<span class="badge open">Активна</span>';
}

function itemBadge(item) {
  if (item.archived_at) return '<span class="badge closed">Архивировано</span>';
  return item.is_available
    ? '<span class="badge open">Доступно</span>'
    : '<span class="badge paused">Временно недоступно</span>';
}

function nutritionSummary(item) {
  const parts = [];
  if (item.weight_g != null) parts.push(`${item.weight_g} г`);
  if (item.kcal != null) parts.push(`${item.kcal} ккал`);
  return parts.length ? parts.join(' · ') : '';
}

function filterItems(items, filter) {
  switch (filter) {
    case 'active': return items.filter((i) => !i.archived_at && i.is_available);
    case 'unavailable': return items.filter((i) => !i.archived_at && !i.is_available);
    case 'archived': return items.filter((i) => i.archived_at);
    case 'all': return items;
    default: return items.filter((i) => !i.archived_at); // по умолчанию — всё не архивное
  }
}

function itemActionButtons({ restaurant, category, item, csrfToken, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu/items/${item.id}`;
  const buttons = [`<a class="btn ghost" href="${base}">Открыть</a>`];
  if (!item.archived_at) {
    const toggleLabel = item.is_available ? 'Сделать недоступным' : 'Сделать доступным';
    buttons.push(`
      <form method="post" action="${base}/available" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="available" value="${item.is_available ? '0' : '1'}">
        <button type="submit" class="ghost">${esc(toggleLabel)}</button>
      </form>`);
    buttons.push(`
      <form method="post" action="${base}/move" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="direction" value="up">
        <button type="submit" class="ghost">Выше</button>
      </form>`);
    buttons.push(`
      <form method="post" action="${base}/move" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="direction" value="down">
        <button type="submit" class="ghost">Ниже</button>
      </form>`);
    buttons.push(`
      <form method="post" action="${base}/archive" onsubmit="return confirm('Архивировать «${esc(item.name)}»? Блюдо исчезнет из публичного меню, история заказов сохранится.')" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="danger">Архивировать</button>
      </form>`);
  } else {
    buttons.push(`
      <form method="post" action="${base}/restore" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit">Восстановить</button>
      </form>`);
  }
  return buttons.join(' ');
}

function renderItemRow({ restaurant, category, item, csrfToken, linkBasePath }) {
  const nutrition = nutritionSummary(item);
  return `
    <div style="padding:12px 0;border-top:1px solid var(--bord)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-weight:700">${esc(item.name)}</div>
          <div style="color:var(--txt2);font-size:13px;margin-top:2px">${money(item.price)}${nutrition ? ` · ${esc(nutrition)}` : ''}</div>
        </div>
        <div>${itemBadge(item)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${itemActionButtons({ restaurant, category, item, csrfToken, linkBasePath })}</div>
    </div>`;
}

function categoryActionButtons({ restaurant, category, csrfToken, linkBasePath, activeCount }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu/categories/${category.id}`;
  const buttons = [`<a class="btn ghost" href="${base}/edit">Переименовать</a>`];
  if (!category.archived_at) {
    buttons.push(`
      <form method="post" action="${base}/move" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="direction" value="up">
        <button type="submit" class="ghost">Выше</button>
      </form>`);
    buttons.push(`
      <form method="post" action="${base}/move" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="direction" value="down">
        <button type="submit" class="ghost">Ниже</button>
      </form>`);
    if (activeCount === 0) {
      buttons.push(`
        <form method="post" action="${base}/archive" onsubmit="return confirm('Архивировать пустую категорию «${esc(category.name)}»?')" style="display:inline">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <button type="submit" class="danger">Архивировать</button>
        </form>`);
    }
  } else {
    buttons.push(`
      <form method="post" action="${base}/restore" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit">Восстановить</button>
      </form>`);
  }
  return buttons.join(' ');
}

function renderCategoryBlock({ restaurant, category, filter, csrfToken, linkBasePath }) {
  const allItems = category.items;
  const activeCount = allItems.filter((i) => !i.archived_at && i.is_available).length;
  const unavailableCount = allItems.filter((i) => !i.archived_at && !i.is_available).length;
  const shown = filterItems(allItems, filter);

  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-weight:700;font-size:16px">${esc(category.name)} ${categoryBadge(category)}</div>
          <div style="color:var(--txt2);font-size:13px;margin-top:4px">${activeCount} доступно · ${unavailableCount} недоступно</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${categoryActionButtons({ restaurant, category, csrfToken, linkBasePath, activeCount })}</div>
      </div>
      ${shown.length ? shown.map((item) => renderItemRow({ restaurant, category, item, csrfToken, linkBasePath })).join('') : '<div class="empty-state" style="margin-top:10px">Нет блюд по текущему фильтру.</div>'}
    </div>`;
}

function renderMenuTab({ restaurant, menu, filter, csrfToken, linkBasePath, error, notice }) {
  const resolvedFilter = ITEM_FILTERS.includes(filter) ? filter : '';
  const activeCategories = menu.filter((c) => !c.archived_at);
  const totalItems = menu.reduce((sum, c) => sum + c.items.length, 0);

  const filterForm = `
    <form class="filters panel" method="get" action="${linkBasePath}/restaurants/${restaurant.id}/menu">
      <div class="field">
        <label for="mf-filter">Показывать блюда</label>
        <select id="mf-filter" name="filter">
          <option value="">Активные и недоступные</option>
          <option value="active" ${filter === 'active' ? 'selected' : ''}>Только доступные</option>
          <option value="unavailable" ${filter === 'unavailable' ? 'selected' : ''}>Только недоступные</option>
          <option value="archived" ${filter === 'archived' ? 'selected' : ''}>Только архивированные</option>
          <option value="all" ${filter === 'all' ? 'selected' : ''}>Все, включая архив</option>
        </select>
      </div>
      <button type="submit">Показать</button>
    </form>`;

  const newCategoryForm = `
    <div class="panel">
      <div style="font-weight:700;margin-bottom:10px">Новая категория</div>
      <form method="post" action="${linkBasePath}/restaurants/${restaurant.id}/menu/categories" class="row">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <div style="flex:2">
          <input name="name" type="text" placeholder="Например: Горячее" maxlength="100" required autocomplete="off">
        </div>
        <div style="flex:0 0 auto"><button type="submit">+ Добавить категорию</button></div>
      </form>
    </div>`;

  const visibleCategories = resolvedFilter === 'archived' || resolvedFilter === 'all'
    ? menu
    : activeCategories;

  const isEmpty = totalItems === 0 && activeCategories.length === 0;
  const body = isEmpty
    ? `<div class="panel"><div class="empty-state">В меню пока нет блюд.</div><a class="btn" style="margin-top:10px;display:inline-block" href="${linkBasePath}/restaurants/${restaurant.id}/menu/items/new">Добавить первое блюдо</a></div>`
    : visibleCategories.map((category) => renderCategoryBlock({ restaurant, category, filter: resolvedFilter, csrfToken, linkBasePath })).join('');

  return `
    ${error ? `<div class="error" style="margin-bottom:14px">${esc(error)}</div>` : ''}
    ${notice ? `<div class="notice" style="margin-bottom:14px">${esc(notice)}</div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px">
      <h2 style="margin:0">Меню</h2>
      <a class="btn" href="${linkBasePath}/restaurants/${restaurant.id}/menu/items/new">+ Добавить блюдо</a>
    </div>
    ${newCategoryForm}
    ${activeCategories.length ? filterForm : ''}
    ${body}
  `;
}

// ===========================================================================
// Форма категории (создание использует инлайн-форму на самой вкладке —
// см. renderMenuTab; эта — только для редактирования названия).
// ===========================================================================

function renderCategoryEditForm({ restaurant, category, error, csrfToken, linkBasePath }) {
  return `
    <h2>Переименовать категорию</h2>
    <div class="panel">
      <form method="post" action="${linkBasePath}/restaurants/${restaurant.id}/menu/categories/${category.id}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="cf-name">Название</label>
        <input id="cf-name" name="name" type="text" value="${esc(category.name)}" maxlength="100" required autocomplete="off">
        <button type="submit">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost" href="${linkBasePath}/restaurants/${restaurant.id}/menu">← К меню</a>
  `;
}

// ===========================================================================
// Форма блюда (создание и редактирование — общая разметка)
// ===========================================================================

function renderMenuItemForm({
  restaurant, item, categories, error, csrfToken, linkBasePath, isNew,
  photos = [], mediaConfigured = false, maxPhotos = 0,
}) {
  const v = item || {};
  const action = isNew
    ? `${linkBasePath}/restaurants/${restaurant.id}/menu/items`
    : `${linkBasePath}/restaurants/${restaurant.id}/menu/items/${v.id}`;
  const activeCategories = categories.filter((c) => !c.archived_at || c.id === v.category_id);
  const title = isNew ? 'Добавить блюдо' : `Редактировать: ${v.name || ''}`;

  return `
    <h2>${esc(title)}</h2>
    ${!isNew ? `<div style="color:var(--txt2);font-size:13px;margin-bottom:14px">${itemBadge(v)}</div>` : ''}
    <div class="panel">
      <form method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="if-name">Название</label>
        <input id="if-name" name="name" type="text" value="${esc(v.name || '')}" placeholder="Например: Шашлык из баранины, Компот, Хлеб" maxlength="200" required autocomplete="off">
        <label for="if-category">Категория</label>
        <select id="if-category" name="category_id" required>
          ${activeCategories.map((c) => `<option value="${c.id}" ${c.id === v.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
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
        <button type="submit">${isNew ? 'Добавить блюдо' : 'Сохранить'}</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    ${!isNew ? renderPhotoManager({
      title: 'Фотографии блюда',
      photos, mediaConfigured, maxPhotos,
      uploadAction: `${linkBasePath}/restaurants/${restaurant.id}/menu/items/${v.id}/photos`,
      actionBase: `${linkBasePath}/restaurants/${restaurant.id}/menu/items/${v.id}/photos`,
      csrfToken,
    }) : ''}
    <a class="btn ghost" href="${linkBasePath}/restaurants/${restaurant.id}/menu">← К меню</a>
  `;
}

module.exports = {
  ITEM_FILTERS,
  categoryBadge,
  itemBadge,
  renderMenuTab,
  renderCategoryEditForm,
  renderMenuItemForm,
};
