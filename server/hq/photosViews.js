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

// Лимит берётся из общего services/hq/media/limits.js — того же модуля, что
// читают multer в роутах и проверка свободного места. Раньше здесь стоял
// литерал (чтобы не тянуть в шаблон sharp вместе с imagePipeline), и это
// был единственный шанс разъехаться с сервером; limits.js зависимостей не
// имеет, поэтому копия больше не нужна.
const { MAX_SOURCE_BYTES, TOO_LARGE_MESSAGE } = require('../services/hq/media/limits');

const ACCEPT_MIME = 'image/jpeg,image/png,image/webp';

// id должен быть пригоден и для label[for], и для querySelector: actionBase —
// это путь вида /hq/restaurants/1/menu/items/5/photos, и слэши в id пришлось
// бы экранировать в каждом селекторе.
function domId(prefix, actionBase) {
  return `${prefix}-${String(actionBase).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function photoBadge(photo) {
  return photo.is_primary === 1 ? '<span class="photo-badge">✓ Основное</span>' : '';
}

function cropEditor({ photo, actionBase, csrfToken, target, ratio, active }) {
  const crop = photo[target === 'menu_card' ? 'menu_card_crop' : 'dish_detail_crop'];
  return `
    <form class="crop-form${active ? ' is-active' : ''}" method="post" action="${actionBase}/${photo.id}/crop" data-crop-panel="${target}">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <input type="hidden" name="target" value="${target}">
      <input type="hidden" name="crop" value="${esc(crop ? JSON.stringify(crop) : '')}">
      <input type="hidden" name="rotation" value="${Number(photo.rotation_degrees) || 0}" data-crop-rotation>
      <div class="crop-stage">
        <div class="crop-viewport crop-${esc(target)}" data-cropper data-aspect="${target === 'menu_card' ? '2.3333333333' : '1'}">
          <img src="${esc(photo.urls.full)}" alt="" draggable="false">
          <span class="crop-guide" aria-hidden="true"></span>
        </div>
      </div>
      <div class="crop-hint">Формат ${esc(ratio)} зафиксирован. Двигайте фотографию мышью или пальцем.</div>
      <label class="crop-zoom"><span>Масштаб</span><input type="range" min="0" max="100" value="0" step="1" data-crop-zoom aria-label="Масштаб фотографии"></label>
      <div class="crop-controls">
        <button type="button" class="ghost compact" data-crop-reset>Сбросить</button>
        <button type="submit" class="compact" data-busy-text="Сохранение…">Сохранить</button>
      </div>
    </form>`;
}

// Раньше сюда рендерились ОБА пресета сразу, дублируя верхний переключатель.
// Теперь карточка предпросмотра одна на пресет, но видима только активная —
// разметка обоих остаётся в DOM, чтобы при переключении вкладки не терялись
// уже загруженные crop-метаданные второго пресета.
function cropPreview(photo, target, active) {
  const crop = photo[target === 'menu_card' ? 'menu_card_crop' : 'dish_detail_crop'];
  return `<div class="crop-preview-card${active ? ' is-active' : ''}" data-crop-preview-card="${target}">
    <div class="crop-preview crop-${esc(target)}" data-crop-preview="${target}" data-initial-crop="${esc(crop ? JSON.stringify(crop) : '')}">
      <img src="${esc(photo.urls.full)}" alt="">
    </div>
  </div>`;
}

function photoCard({ photo, actionBase, csrfToken, dishCrops, index }) {
  const editorId = `photo-editor-${photo.id}`;
  return `
    <article class="photo-card${photo.is_primary === 1 ? ' is-primary' : ''}" data-photo-card>
      ${photoBadge(photo)}
      <div class="photo-open"><img class="photo-master-preview" src="${esc(photo.urls.full)}" alt="Фотография ${index + 1}" loading="lazy"></div>
      <div class="photo-body">
        <div class="photo-actions">
          ${photo.is_primary === 1 ? '<span class="primary-selected" aria-label="Выбрано основным">✓ Выбрано основным</span>' : `
            <form method="post" action="${actionBase}/${photo.id}/primary">
              <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
              <button type="submit" class="primary-choice compact">Сделать основным</button>
            </form>`}
          ${dishCrops ? `<button type="button" class="ghost compact photo-edit-btn" data-photo-open aria-expanded="false" aria-controls="${editorId}">Настроить кадрирование</button>` : ''}
          <form method="post" action="${actionBase}/${photo.id}/delete" onsubmit="return confirm('Удалить фотографию? Это действие необратимо.')">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
            <button type="submit" class="danger compact">Удалить</button>
          </form>
        </div>
      </div>
      ${dishCrops ? `<section id="${editorId}" class="photo-editor" data-photo-editor>
        <div class="photo-editor-heading">
          <div><strong>Кадрирование фото</strong><span>Пропорции зафиксированы, оригинал не изменяется.</span></div>
          <button type="button" class="ghost compact" data-photo-close aria-label="Закрыть редактор">Закрыть</button>
        </div>
        <div class="crop-preset-tabs" role="tablist" aria-label="Формат кадрирования">
          <button type="button" class="is-active" role="tab" aria-selected="true" data-crop-tab="menu_card">Карточка меню <span>7:3</span></button>
          <button type="button" role="tab" aria-selected="false" data-crop-tab="dish_detail">Экран блюда <span>1:1</span></button>
        </div>
        <div class="rotation-controls" aria-label="Поворот фотографии">
          <button type="button" class="ghost compact" data-rotate="-90" aria-label="Повернуть влево" title="Повернуть влево"><span aria-hidden="true">↶</span> Влево</button>
          <button type="button" class="ghost compact" data-rotate="90" aria-label="Повернуть вправо" title="Повернуть вправо"><span aria-hidden="true">↷</span> Вправо</button>
          <span>Поворот <strong data-rotation-label>${Number(photo.rotation_degrees) || 0}°</strong></span>
        </div>
        <div class="crop-workspace">
          <div class="crop-editors">
            ${cropEditor({ photo, actionBase, csrfToken, target: 'menu_card', ratio: '7:3', active: true })}
            ${cropEditor({ photo, actionBase, csrfToken, target: 'dish_detail', ratio: '1:1', active: false })}
          </div>
          <aside class="crop-live-previews" aria-label="Предпросмотр на сайте">
            <div class="crop-preview-heading">Так будет выглядеть на сайте</div>
            ${cropPreview(photo, 'menu_card', true)}
            ${cropPreview(photo, 'dish_detail', false)}
          </aside>
        </div>
      </section>` : ''}
    </article>`;
}

// Современная загрузка вместо стандартного «Выберите файл | Файл не выбран».
// Настоящий <input type="file"> сохранён — он лишь визуально скрыт классом
// .visually-hidden (не display:none и не hidden: такой input недоступен с
// клавиатуры) и связан с плиткой через label[for]. Никакого синтетического
// .click() — открытие системного выбора файла остаётся trusted-действием
// пользователя, поэтому на iOS появляется штатный chooser «Фото/Файлы».
function uploadControl({ uploadAction, csrfToken, actionBase, error }) {
  const inputId = domId('photo-file', actionBase);
  return `
    <form class="photo-upload" method="post" action="${uploadAction}" enctype="multipart/form-data" data-photo-upload data-max-bytes="${MAX_SOURCE_BYTES}">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <input class="visually-hidden" id="${inputId}" type="file" name="photo" accept="${ACCEPT_MIME}" required data-upload-input>
      <div class="upload-row">
        <label class="upload-tile" for="${inputId}" data-upload-tile>
          <span class="upload-plus" aria-hidden="true">+</span>
          <span class="upload-tile-text">Добавить фото</span>
        </label>
        <div class="upload-selected" data-upload-selected hidden>
          <div class="upload-thumb">
            <img alt="Выбранная фотография" data-upload-thumb>
            <button type="button" class="upload-clear" data-upload-clear aria-label="Убрать выбранный файл">×</button>
            <span class="upload-busy" data-upload-busy hidden>Загрузка…</span>
          </div>
          <span class="upload-filename" data-upload-name></span>
        </div>
        <button type="submit" class="upload-submit" data-busy-text="Загрузка…">Загрузить</button>
      </div>
      <p class="upload-error${error ? ' is-visible' : ''}" data-upload-error role="alert">${error ? esc(error) : ''}</p>
    </form>`;
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
        <div class="photo-section-title">${esc(title)}</div>
        <div class="empty-state">Хранилище фотографий не настроено на этом окружении — раздел временно недоступен.</div>
      </div>`;
  }

  const grid = photos.length
    ? `<div class="photo-grid${dishCrops ? ' photo-grid-dish' : ''}">${photos.map((photo, index) => photoCard({ photo, actionBase, csrfToken, dishCrops, index })).join('')}</div>`
    : '<div class="empty-state">Пока нет фотографий.</div>';

  return `
    <div class="panel photo-panel">
      <div class="photo-section-title">${esc(title)}</div>
      <div class="photo-meta">${photos.length} / ${maxPhotos}</div>
      ${grid}
      ${uploadControl({ uploadAction, csrfToken, actionBase, error })}
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    </div>`;
}

module.exports = { renderPhotoManager, MAX_SOURCE_BYTES, TOO_LARGE_MESSAGE, ACCEPT_MIME };
