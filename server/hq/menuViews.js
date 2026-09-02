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
const { esc, renderBackLink } = require('./layout');
const { money } = require('./restaurantsViews');
const { renderPhotoManager } = require('./photosViews');

// Наличие и архив — две РАЗНЫЕ вещи, и подписи это должны показывать.
// «Нет в наличии» — то же самое is_available, которым ресторан управляет из
// Telegram (/stoplist): блюдо остаётся на сайте, но серым и незаказываемым.
// «В архиве» — блюдо ушло и с сайта, и из рабочего меню. Прежние формулировки
// про витрину смешивали одно с другим: «снято с витрины» звучало как «убрано
// с сайта», хотя блюдо там оставалось.
function itemStatusLabel(item) {
  if (item.archived_at) return 'В архиве';
  return item.is_available ? 'В наличии' : 'Нет в наличии';
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
// id="dish-<id>" — стабильный якорь строки: по нему и «← Назад» (фрагмент
// в адресе, работает даже без JS), и восстановление позиции в hq.js находят
// именно то блюдо, из которого владелец ушёл редактировать.
function renderDishRow({ item, linkBasePath, restaurantId }) {
  const href = `${linkBasePath}/restaurants/${restaurantId}/menu/items/${item.id}`;
  const thumb = item.thumb_url
    ? `<img class="dish-thumb" src="${esc(item.thumb_url)}" alt="" loading="lazy" width="48" height="48">`
    : '<div class="dish-thumb placeholder" aria-hidden="true"></div>';
  return `
    <li class="dish-row" id="dish-${item.id}" data-item-id="${item.id}">
      <span class="drag-handle" aria-hidden="true" title="Перетащить"></span>
      <a class="dish-link" href="${href}">
        ${thumb}
        <span class="dish-main">
          <span class="dish-name">${esc(item.name)}</span>
          <span class="dish-meta">${money(item.price)} · ${esc(itemStatusLabel(item))}</span>
        </span>
        <span class="dish-photo-count">${Number(item.photo_count) || 0} фото</span>
        <span class="dish-chevron" aria-hidden="true"></span>
      </a>
    </li>`;
}

// Категория-аккордеон: <details>/<summary> — раскрытие на той же странице
// без единой строки JS (спецификация: «раскрывается на той же странице как
// шторка»), работает и при отключённом JS.
function renderCategoryBlock({ restaurant, category, csrfToken, linkBasePath, allCategories, open = false }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;
  const items = category.items.filter((i) => !i.archived_at);
  const otherCategories = allCategories.filter((c) => !c.archived_at && c.id !== category.id);

  const archiveForm = items.length === 0
    ? `<form method="post" action="${base}/categories/${category.id}/archive"
             data-confirm="Архивировать пустую категорию «${esc(category.name)}»? Она исчезнет из рабочего меню и останется в архиве."
             data-confirm-title="Архивировать категорию"
             data-confirm-ok="Архивировать">
         <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
         <button type="submit" class="ghost compact">Архивировать</button>
       </form>`
    : `<a class="btn ghost compact" href="${base}/categories/${category.id}/archive-options">Архивировать</a>`;

  return `
    <details class="cat-block" data-category-id="${category.id}"${open ? ' open' : ''}>
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

// focusItemId — блюдо, из карточки которого владелец только что вернулся
// («← Назад» ведёт на /menu?item=N#dish-N). Его категория раскрывается САМИМ
// СЕРВЕРОМ, атрибутом open: возврат не должен зависеть от того, успел ли
// выполниться клиентский скрипт, и уж тем более не должен «схлопывать» меню
// обратно в список закрытых категорий. hq.js добавляет к этому точную
// позицию прокрутки и раскрытие остальных категорий, которые были открыты.
function renderMenuTab({ restaurant, menu, csrfToken, linkBasePath, error, notice, focusItemId = null }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;
  const activeCategories = menu.filter((c) => !c.archived_at);
  const focusCategoryId = focusItemId
    ? (menu.find((c) => c.items.some((i) => i.id === focusItemId && !i.archived_at)) || {}).id ?? null
    : null;

  return `
    ${error ? `<div class="error" style="margin-bottom:14px">${esc(error)}</div>` : ''}
    ${notice ? `<div class="notice" style="margin-bottom:14px">${esc(notice)}</div>` : ''}

    <div class="menu-toolbar" data-menu-screen="${restaurant.id}">
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
      ? `<div class="cat-list" data-reorder="categories" data-endpoint="${base}/reorder-categories">${activeCategories.map((category) => renderCategoryBlock({ restaurant, category, csrfToken, linkBasePath, allCategories: menu, open: category.id === focusCategoryId })).join('')}</div>`
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

      <form method="post" action="${base}/categories/${category.id}/archive-with-items"
            data-confirm="Архивировать категорию «${esc(category.name)}» вместе с ${itemsCount} ${esc(pluralDishes(itemsCount))}? Блюда не удаляются, история заказов сохраняется."
            data-confirm-title="Архивировать вместе с блюдами"
            data-confirm-ok="Архивировать">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="ghost compact">Архивировать вместе с блюдами</button>
      </form>
    </div>
  `;
}

// ===========================================================================
// Архив меню (спецификация, раздел «Архив меню»)
// ===========================================================================

function renderMenuArchive({ restaurant, archive, activeCategories, csrfToken, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}/menu`;

  // Окончательное удаление — единственное необратимое действие раздела
  // «Меню», поэтому оно и выглядит иначе (красная кнопка), и требует
  // подтверждения. Подтверждение — data-confirm, который читает
  // hq/static/hq.js: инлайновый onsubmit="return confirm(...)" под CSP
  // страницы (script-src 'self') браузер выбрасывает молча, то есть его
  // «защита» на этом экране была бы фикцией.
  const deleteForm = ({ action, title, message, okLabel }) => `
    <form method="post" action="${action}"
          data-confirm="${esc(message)}"
          data-confirm-title="${esc(title)}"
          data-confirm-ok="${esc(okLabel)}">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <button type="submit" class="danger compact">Удалить навсегда</button>
    </form>`;

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
        <div class="archive-actions">
          ${canRestore ? `
          <form class="restore-form" method="post" action="${base}/items/${item.id}/restore">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
            ${categorySelect}
            <button type="submit" class="ghost compact">Восстановить</button>
          </form>` : '<span class="dish-meta">Нет активных категорий</span>'}
          ${deleteForm({
            action: `${base}/items/${item.id}/delete`,
            title: 'Удалить блюдо навсегда',
            message: `Блюдо «${item.name}» будет удалено из базы вместе со всеми его фотографиями. Отменить это нельзя. История заказов сохранится: в заказах остаются название, цена и количество на момент покупки.`,
            okLabel: 'Удалить навсегда',
          })}
        </div>
      </li>`;
  }).join('');

  // Stage 25 — закрытие Stage 24 MEDIUM-1: если с категорией архивированы
  // связанные блюда (linked_items_count > 0 из listMenuArchive, провязка —
  // archived_with_category_id), владельцу нужен явный выбор, а не тихое
  // «восстановили категорию — блюда пропали» или «восстановили категорию —
  // и заодно что-то ещё чужое». Блюда, заархивированные независимо раньше,
  // в это число не входят и второй кнопкой не восстанавливаются никогда.
  const categoryRows = archive.categories.map((c) => {
    const linkedCount = Number(c.linked_items_count) || 0;
    // items_count — ВСЕ блюда, физически привязанные к категории (см.
    // listMenuArchive). Именно они исчезнут при окончательном удалении, и
    // это число, а не linkedCount, обязано стоять в тексте подтверждения.
    const itemsCount = Number(c.items_count) || 0;
    const restoreButtons = linkedCount > 0
      ? `
        <form class="restore-form" method="post" action="${base}/categories/${c.id}/restore">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <input type="hidden" name="restore_items" value="1">
          <button type="submit" class="ghost compact">Восстановить категорию и ${linkedCount} ${pluralDishes(linkedCount)}</button>
        </form>
        <form class="restore-form" method="post" action="${base}/categories/${c.id}/restore">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <button type="submit" class="ghost compact">Восстановить только категорию</button>
        </form>`
      : `
        <form class="restore-form" method="post" action="${base}/categories/${c.id}/restore">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <button type="submit" class="ghost compact">Восстановить</button>
        </form>`;
    return `
    <li class="dish-row archive-row">
      <div class="dish-link static">
        <span class="dish-main">
          <span class="dish-name">${esc(c.name)}</span>
          <span class="dish-meta">Категория${c.archived_at ? ` · ${esc(formatArchivedAt(c.archived_at))}` : ''}${linkedCount > 0 ? ` · вместе с ней архивировано блюд: ${linkedCount}` : ''}</span>
        </span>
      </div>
      <div class="archive-actions">
        ${restoreButtons}
        ${deleteForm({
          action: `${base}/categories/${c.id}/delete`,
          title: 'Удалить категорию навсегда',
          message: itemsCount > 0
            ? `Категория «${c.name}» будет удалена вместе с ${itemsCount} ${pluralDishes(itemsCount)} из архива и всеми их фотографиями. Отменить это нельзя. История заказов сохранится.`
            : `Категория «${c.name}» будет удалена из базы. Отменить это нельзя.`,
          okLabel: 'Удалить навсегда',
        })}
      </div>
    </li>`;
  }).join('');

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
// Внизу — Сохранить / Нет в наличии (или Вернуть в наличие) / Архивировать.
// Первая кнопка переключает is_available — ровно то же поле, что и
// Telegram /stoplist, поэтому состояние у HQ и у бота всегда одно.
// Архивирование — отдельная операция: оно убирает блюдо и с сайта, и из
// рабочего меню. Физического удаления здесь нет: блюдо, участвовавшее в
// заказах, только архивируется (окончательное удаление живёт в архиве).
function renderMenuItemForm({
  restaurant, item, categories, error, notice, csrfToken, linkBasePath, isNew,
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
        <button type="submit" class="ghost compact">${v.is_available ? 'Нет в наличии' : 'Вернуть в наличие'}</button>
      </form>
      <form method="post" action="${base}/items/${v.id}/archive"
            data-confirm="Архивировать «${esc(v.name || '')}»? Блюдо исчезнет и с сайта, и из рабочего меню — останется в архиве. История заказов сохранится."
            data-confirm-title="Архивировать блюдо"
            data-confirm-ok="Архивировать">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="ghost compact">Архивировать</button>
      </form>`}
    </div>`;

  // «← Назад» ведёт не просто «в меню», а в ТО ЖЕ место меню: ?item=N
  // раскрывает нужную категорию на сервере, #dish-N даёт браузеру нативный
  // якорь (работает и без JS), а hq.js поверх этого возвращает точную
  // прокрутку. У нового блюда id ещё нет — возвращаемся в меню как раньше.
  const backHref = isNew ? base : `${base}?item=${v.id}#dish-${v.id}`;

  // Панель фотографий стоит ВЫШЕ формы: владелец открывает блюдо прежде
  // всего чтобы посмотреть и поменять фотографии, и не должен ради этого
  // пролистывать полтора десятка полей (название, цена, состав, КБЖУ).
  const photoManager = isNew ? '' : renderPhotoManager({
    title: 'Фотографии блюда',
    photos, mediaConfigured, maxPhotos,
    uploadAction: `${base}/items/${v.id}/photos`,
    actionBase: `${base}/items/${v.id}/photos`,
    csrfToken, dishCrops: true, notice,
  });

  return `
    ${renderBackLink({ href: backHref })}
    <h2>${esc(title)}</h2>
    ${!isNew ? `<div class="item-status">${esc(itemStatusLabel(v))}</div>` : ''}
    ${photoManager}
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
        <!-- Stage 35 — legacy-поле ручного ввода URL убрано из обычного
             HQ-интерфейса (задание, раздел 2.2: администратор не должен
             искать/вставлять ссылку на фото). Backend/модель по-прежнему
             поддерживают photo_url как fallback для блюд, у которых он уже
             был заполнен старым способом ДО этой стадии (см.
             routes/hq/restaurants.js: thumb_url = загруженное фото ||
             item.photo_url) — hidden-поле молча переносит текущее значение
             при каждом сохранении формы, ничего не обнуляя и не показывая
             владельцу. Новые блюда получают фото через renderPhotoManager
             ниже (загрузка файла), не через эту ссылку. -->
        <input id="if-photo" name="photo_url" type="hidden" value="${esc(v.photo_url || '')}">
        <button type="submit" class="compact">${isNew ? 'Добавить блюдо' : 'Сохранить'}</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
      ${bottomActions}
    </div>
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
