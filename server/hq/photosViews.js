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
  return photo.is_primary === 1 ? '<span class="photo-badge">Основная</span>' : '';
}

function photoCard({ photo, actionBase, csrfToken }) {
  return `
    <div class="photo-card">
      ${photoBadge(photo)}
      <img src="${esc(photo.urls.card)}" alt="" loading="lazy" width="400" height="300">
      <div class="photo-body">
        <div class="photo-actions">
          ${photo.is_primary === 1 ? '' : `
            <form method="post" action="${actionBase}/${photo.id}/primary">
              <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
              <button type="submit">Сделать основной</button>
            </form>`}
          <form method="post" action="${actionBase}/${photo.id}/delete" onsubmit="return confirm('Удалить фотографию? Это действие необратимо.')">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
            <button type="submit" class="danger">Удалить</button>
          </form>
        </div>
      </div>
    </div>`;
}

// mediaConfigured=false — MEDIA_PROVIDER не задан (см. services/hq/media/
// provider.js) — раздел показывает честное объяснение вместо формы загрузки,
// НЕ падает и не притворяется рабочим (fail-closed, но без крэша остального HQ).
function renderPhotoManager({
  title, photos, uploadAction, actionBase, csrfToken,
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
    ? `<div class="photo-grid">${photos.map((photo) => photoCard({ photo, actionBase, csrfToken })).join('')}</div>`
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
