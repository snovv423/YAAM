'use strict';

// YAAM HQ Stage 5B — server-rendered HTML для раздела «Фотографии».
// Один и тот же шаблон обслуживает и ресторан (Настройки), и блюдо
// (карточка блюда) — тот же принцип, что и остальной HQ: шаблонные функции
// без движка/фреймворка, esc() на каждое значение из БД. Владельцу никогда
// не показывается технический URL/storage_key (задание, раздел 10) — только
// превью и понятные действия.
const { esc } = require('./layout');

function photoBadge(photo) {
  return photo.is_primary === 1 ? '<span class="photo-badge">Основная</span>' : '';
}

function photoCard({ photo, actionBase, csrfToken, archived }) {
  const alt = esc(photo.alt_text || '');
  return `
    <div class="photo-card${archived ? ' archived' : ''}">
      ${archived ? '' : photoBadge(photo)}
      <img src="${esc(photo.urls.card)}" alt="${alt}" loading="lazy" width="400" height="300">
      <div class="photo-body">
        ${archived ? `
          <form method="post" action="${actionBase}/${photo.id}/restore">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
            <button type="submit">Восстановить</button>
          </form>
        ` : `
          <form class="photo-alt-form" method="post" action="${actionBase}/${photo.id}/alt">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
            <input type="text" name="alt_text" value="${alt}" placeholder="Описание фото" aria-label="Описание фотографии" maxlength="200">
            <button type="submit" class="ghost">Сохранить</button>
          </form>
          <div class="photo-actions">
            ${photo.is_primary === 1 ? '' : `
              <form method="post" action="${actionBase}/${photo.id}/primary">
                <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
                <button type="submit">Сделать основной</button>
              </form>`}
            <form method="post" action="${actionBase}/${photo.id}/move">
              <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
              <input type="hidden" name="direction" value="up">
              <button type="submit" class="ghost" aria-label="Переместить выше">Выше</button>
            </form>
            <form method="post" action="${actionBase}/${photo.id}/move">
              <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
              <input type="hidden" name="direction" value="down">
              <button type="submit" class="ghost" aria-label="Переместить ниже">Ниже</button>
            </form>
            <form method="post" action="${actionBase}/${photo.id}/archive" onsubmit="return confirm('Архивировать фотографию?')">
              <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
              <button type="submit" class="danger">Архивировать</button>
            </form>
          </div>
        `}
      </div>
    </div>`;
}

// mediaConfigured=false — MEDIA_PROVIDER не задан (см. services/hq/media/
// provider.js) — раздел показывает честное объяснение вместо формы загрузки,
// НЕ падает и не притворяется рабочим (задание, раздел 4: fail-closed, но
// без крэша остального HQ).
function renderPhotoManager({
  title, photos, archivedPhotos = [], uploadAction, actionBase, csrfToken,
  maxPhotos, mediaConfigured, error, notice,
}) {
  if (!mediaConfigured) {
    return `
      <div class="panel">
        <div style="font-weight:700;margin-bottom:14px">${esc(title)}</div>
        <div class="empty-state">Хранилище фотографий не настроено на этом окружении — раздел временно недоступен.</div>
      </div>`;
  }

  const grid = photos.length
    ? `<div class="photo-grid">${photos.map((photo) => photoCard({ photo, actionBase, csrfToken, archived: false })).join('')}</div>`
    : '<div class="empty-state">Пока нет фотографий.</div>';

  const archivedBlock = archivedPhotos.length
    ? `<details class="photo-archived">
         <summary>Архив (${archivedPhotos.length})</summary>
         <div class="photo-grid">${archivedPhotos.map((photo) => photoCard({ photo, actionBase, csrfToken, archived: true })).join('')}</div>
       </details>`
    : '';

  return `
    <div class="panel">
      <div style="font-weight:700;margin-bottom:4px">${esc(title)}</div>
      <div class="photo-meta">${photos.length} / ${maxPhotos}</div>
      ${grid}
      ${archivedBlock}
      <form class="photo-upload" method="post" action="${uploadAction}" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <div class="field">
          <label for="photo-file-${esc(actionBase)}">Новая фотография</label>
          <input id="photo-file-${esc(actionBase)}" type="file" name="photo" accept="image/jpeg,image/png,image/webp" required>
        </div>
        <div class="field">
          <label for="photo-alt-${esc(actionBase)}">Описание (необязательно)</label>
          <input id="photo-alt-${esc(actionBase)}" type="text" name="alt_text" maxlength="200" autocomplete="off">
        </div>
        <button type="submit" data-busy-text="Загрузка…">Загрузить</button>
      </form>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    </div>`;
}

module.exports = { renderPhotoManager };
