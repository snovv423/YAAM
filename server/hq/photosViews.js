'use strict';

// YAAM HQ Stage 5B/5B.1 — server-rendered HTML для раздела «Фотографии».
// Один и тот же шаблон обслуживает и ресторан (Настройки), и блюдо
// (карточка блюда) — тот же принцип, что и остальной HQ: шаблонные функции
// без движка/фреймворка, esc() на каждое значение из БД. Владельцу никогда
// не показывается технический URL/storage_key — только превью и понятные
// действия.
//
// Stage 5B.1 — минимализм (задание, раздел 0): фотографиям не нужен
// lifecycle ресторана/блюда. Убраны ручной reorder («Выше»/«Ниже»),
// архивирование, восстановление, раздел «Архив». Ровно 2 действия на
// карточку: сделать основной / удалить — плюс форма
// загрузки. «Удалить» — необратимо, поэтому единственная кнопка с
// confirm() в этом разделе.
const { esc } = require('./layout');

function photoBadge(photo) {
  return photo.is_primary === 1 ? '<span class="photo-badge">✓ Основное</span>' : '';
}

function cropEditor({ photo, actionBase, csrfToken, target, title, ratio, active }) {
  const crop = photo[target === 'menu_card' ? 'menu_card_crop' : 'dish_detail_crop'];
  return `
    <form class="crop-form${active ? ' is-active' : ''}" method="post" action="${actionBase}/${photo.id}/crop" data-crop-panel="${target}">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <input type="hidden" name="target" value="${target}">
      <input type="hidden" name="crop" value="${esc(crop ? JSON.stringify(crop) : '')}">
      <input type="hidden" name="rotation" value="${Number(photo.rotation_degrees) || 0}" data-crop-rotation>
      <div class="crop-title"><strong>${esc(title)}</strong><span>Фиксированный формат ${esc(ratio)}</span></div>
      <div class="crop-stage">
        <div class="crop-viewport crop-${esc(target)}" data-cropper data-aspect="${target === 'menu_card' ? '2.3333333333' : '1'}">
          <img src="${esc(photo.urls.full)}" alt="" draggable="false">
          <span class="crop-guide" aria-hidden="true"></span>
        </div>
      </div>
      <div class="crop-controls">
        <label class="crop-zoom"><span>Масштаб</span><input type="range" min="0" max="100" value="0" step="1" data-crop-zoom aria-label="Масштаб фотографии"></label>
        <button type="button" class="ghost compact" data-crop-reset>Сбросить</button>
        <button type="submit" class="compact" data-busy-text="Сохранение…">Сохранить</button>
      </div>
    </form>`;
}

function cropPreview(photo, target, title, ratio) {
  const crop = photo[target === 'menu_card' ? 'menu_card_crop' : 'dish_detail_crop'];
  return `<div class="crop-preview-card">
    <div class="crop-preview-label"><strong>${esc(title)}</strong><span>${esc(ratio)}</span></div>
    <div class="crop-preview crop-${esc(target)}" data-crop-preview="${target}" data-initial-crop="${esc(crop ? JSON.stringify(crop) : '')}">
      <img src="${esc(photo.urls.full)}" alt="">
    </div>
  </div>`;
}

function photoCard({ photo, actionBase, csrfToken, dishCrops, index }) {
  return `
    <article class="photo-card${photo.is_primary === 1 ? ' is-primary' : ''}" data-photo-card>
      ${photoBadge(photo)}
      ${dishCrops ? `<button type="button" class="photo-open" data-photo-open aria-expanded="${photo.is_primary === 1 ? 'true' : 'false'}" aria-controls="photo-editor-${photo.id}">
        <img class="photo-master-preview" src="${esc(photo.urls.full)}" alt="Фотография ${index + 1}" loading="lazy">
        <span class="photo-edit-label">Настроить кадрирование</span>
      </button>` : `<div class="photo-open"><img class="photo-master-preview" src="${esc(photo.urls.full)}" alt="Фотография ${index + 1}" loading="lazy"></div>`}
      <div class="photo-body">
        <div class="photo-actions">
          ${photo.is_primary === 1 ? '<span class="primary-selected" aria-label="Выбрано основным">✓ Выбрано основным</span>' : `
            <form method="post" action="${actionBase}/${photo.id}/primary">
              <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
              <button type="submit" class="primary-choice">Сделать основным</button>
            </form>`}
          <form method="post" action="${actionBase}/${photo.id}/delete" onsubmit="return confirm('Удалить фотографию? Это действие необратимо.')">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
            <button type="submit" class="danger">Удалить</button>
          </form>
        </div>
      </div>
      ${dishCrops ? `<section id="photo-editor-${photo.id}" class="photo-editor${photo.is_primary === 1 ? ' is-open' : ''}" data-photo-editor>
        <div class="photo-editor-heading">
          <div><strong>Кадрирование фото</strong><span>Двигайте фотографию мышью или пальцем. Пропорции зафиксированы.</span></div>
          <button type="button" class="ghost compact" data-photo-close aria-label="Закрыть редактор">Закрыть</button>
        </div>
        <div class="crop-preset-tabs" role="tablist" aria-label="Формат кадрирования">
          <button type="button" class="is-active" role="tab" aria-selected="true" data-crop-tab="menu_card">Карточка меню <span>7:3</span></button>
          <button type="button" role="tab" aria-selected="false" data-crop-tab="dish_detail">Экран блюда <span>1:1</span></button>
        </div>
        <div class="rotation-controls" aria-label="Поворот фотографии">
          <span>Поворот <strong data-rotation-label>${Number(photo.rotation_degrees) || 0}°</strong></span>
          <button type="button" class="ghost compact" data-rotate="-90" aria-label="Повернуть влево">← Повернуть влево</button>
          <button type="button" class="ghost compact" data-rotate="90" aria-label="Повернуть вправо">Повернуть вправо →</button>
        </div>
        <div class="crop-workspace">
          <div class="crop-editors">
            ${cropEditor({ photo, actionBase, csrfToken, target: 'menu_card', title: 'Карточка меню', ratio: '7:3', active: true })}
            ${cropEditor({ photo, actionBase, csrfToken, target: 'dish_detail', title: 'Экран блюда', ratio: '1:1', active: false })}
          </div>
          <aside class="crop-live-previews" aria-label="Предпросмотр на сайте">
            <div class="crop-preview-heading">Так фото выглядит на сайте</div>
            ${cropPreview(photo, 'menu_card', 'Карточка меню', '7:3')}
            ${cropPreview(photo, 'dish_detail', 'Экран блюда', '1:1')}
          </aside>
        </div>
      </section>` : ''}
    </article>`;
}

// mediaConfigured=false — MEDIA_PROVIDER не задан (см. services/hq/media/
// provider.js) — раздел показывает честное объяснение вместо формы загрузки,
// НЕ падает и не притворяется рабочим (fail-closed, но без крэша остального HQ).
function renderPhotoManager({
  title, photos, uploadAction, actionBase, csrfToken,
  maxPhotos, mediaConfigured, error, notice, dishCrops = false,
}) {
  if (!mediaConfigured) {
    return `
      <div class="panel">
        <div style="font-weight:700;margin-bottom:14px">${esc(title)}</div>
        <div class="empty-state">Хранилище фотографий не настроено на этом окружении — раздел временно недоступен.</div>
      </div>`;
  }

  const grid = photos.length
    ? `<div class="photo-grid${dishCrops ? ' photo-grid-dish' : ''}">${photos.map((photo, index) => photoCard({ photo, actionBase, csrfToken, dishCrops, index })).join('')}</div>`
    : '<div class="empty-state">Пока нет фотографий.</div>';

  return `
    <div class="panel">
      <div style="font-weight:700;margin-bottom:4px">${esc(title)}</div>
      <div class="photo-meta">${photos.length} / ${maxPhotos}</div>
      ${grid}
      <form class="photo-upload" method="post" action="${uploadAction}" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <div class="field">
          <label for="photo-file-${esc(actionBase)}">Новая фотография</label>
          <input id="photo-file-${esc(actionBase)}" type="file" name="photo" accept="image/jpeg,image/png,image/webp" required>
        </div>
        <button type="submit" data-busy-text="Загрузка…">Загрузить</button>
      </form>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    </div>`;
}

module.exports = { renderPhotoManager };
