'use strict';

// Регрессия на production-багфикс фоторедактора HQ.
//
// Каждый кейс здесь закрывает дефект, реально воспроизведённый на странице
// /hq/restaurants/:id/menu/items/:itemId. Живая браузерная проверка (открытие
// редактора, циклы поворота, strict cover, выбор файла) выполнена отдельно и
// описана в отчёте; здесь фиксируются те инварианты разметки/стилей/скрипта,
// потеря которых немедленно вернула бы дефект.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderPhotoManager, MAX_SOURCE_BYTES } = require('../hq/photosViews');
const { renderBackLink } = require('../hq/layout');
const { MAX_SOURCE_BYTES: PIPELINE_MAX_SOURCE_BYTES } = require('../services/hq/media/imagePipeline');

const layout = fs.readFileSync(path.join(__dirname, '../hq/layout.js'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../hq/static/hq.js'), 'utf8');

function dishHtml(overrides = {}) {
  return renderPhotoManager({
    title: 'Фотографии блюда',
    photos: [
      { id: 7, is_primary: 1, urls: { full: '/media/one.jpg' }, rotation_degrees: 0, menu_card_crop: null, dish_detail_crop: null },
      { id: 8, is_primary: 0, urls: { full: '/media/two.jpg' }, rotation_degrees: 0, menu_card_crop: null, dish_detail_crop: null },
    ],
    uploadAction: '/hq/items/1/photos',
    actionBase: '/hq/items/1/photos',
    csrfToken: 'token',
    maxPhotos: 20,
    mediaConfigured: true,
    dishCrops: true,
    ...overrides,
  });
}

// ─────────────────────────── редактор ───────────────────────────

test('редактор кадрирования закрыт при отрисовке страницы, включая основное фото', () => {
  const html = dishHtml();
  // Раньше основное фото получало is-open прямо в разметке, поэтому редактор
  // был раскрыт сразу после любого перехода на страницу, reload и смены
  // основного фото — сервер не должен открывать его никогда.
  assert.doesNotMatch(html, /class="photo-editor[^"]*is-open/);
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 0);
  assert.match(html, /class="photo-editor" data-photo-editor/);
});

test('редактор раскрывается только явным кликом и корректно закрывается', () => {
  const html = dishHtml();
  assert.match(html, /data-photo-open aria-expanded="false" aria-controls="photo-editor-7"/);
  assert.match(html, /data-photo-close/);
  assert.match(script, /open\.addEventListener\('click', function \(\) \{ setOpen\(!editor\.classList\.contains\('is-open'\)\); \}\)/);
  assert.match(script, /if \(close\) close\.addEventListener\('click', function \(\) \{ setOpen\(false\)/);
});

test('открытие редактора и смена пресета заново перерисовывают кадр', () => {
  // Скрытая панель имеет нулевой кадр, paint() из неё выходит сразу. Без
  // повторной отрисовки после показа пользователь увидел бы пустой кадр —
  // это стало обязательным ровно потому, что редактор теперь стартует закрытым.
  assert.match(script, /croprerender/);
  assert.match(script, /if \(value\) rerender\(\)/);
  assert.match(script, /requestAnimationFrame/);
});

// ─────────────────────────── пресеты ───────────────────────────

test('переключатель пресета один, предпросмотр показывается только для активного', () => {
  const html = dishHtml();
  const perPhotoTabs = (html.match(/data-crop-tab="menu_card"/g) || []).length;
  assert.equal(perPhotoTabs, 2, 'по одному переключателю на каждую из двух фотографий');
  // Обе карточки предпросмотра остаются в DOM (иначе терялись бы crop-данные
  // второго пресета), но активна ровно одна.
  const firstEditor = html.slice(html.indexOf('id="photo-editor-7"'), html.indexOf('id="photo-editor-8"'));
  assert.equal((firstEditor.match(/data-crop-preview-card="/g) || []).length, 2);
  assert.equal((firstEditor.match(/crop-preview-card is-active/g) || []).length, 1);
  assert.match(layout, /\.crop-preview-card\{display:none\}\.crop-preview-card\.is-active\{display:block\}/);
  assert.match(script, /data-crop-preview-card/);
  // Дублирующие подписи «Карточка меню 7:3» справа убраны — формат называет
  // только верхний переключатель.
  assert.doesNotMatch(html, /crop-preview-label/);
});

test('пресеты сохраняют заявленные пропорции кадра', () => {
  assert.match(layout, /\.crop-menu_card\{aspect-ratio:7\/3\}/);
  assert.match(layout, /\.crop-dish_detail\{aspect-ratio:1\/1/);
  // max-height обрезал высоту квадратного кадра до 440px, и «1:1» на деле
  // имел пропорции 1.2 — предел теперь по ширине, высоту диктует aspect-ratio.
  assert.doesNotMatch(layout, /\.crop-viewport\{[^}]*max-height/);
});

// ─────────────────── затемнение страницы и поворот ───────────────────

test('редактор не затемняет страницу: ни backdrop, ни тень во всю вёрстку', () => {
  // Проверяются только объявления внутри правил: в комментариях рядом
  // причина дефекта описана словами, и они не должны ронять тест.
  assert.doesNotMatch(layout, /\.crop-viewport\{[^}]*box-shadow/);
  assert.doesNotMatch(layout, /\{[^}]*box-shadow:0 0 0 999px/);
  const editorRule = /\.photo-editor\{([^}]*)\}/.exec(layout);
  assert.ok(editorRule, 'правило .photo-editor не найдено');
  assert.doesNotMatch(editorRule[1], /position:fixed/);
  assert.match(editorRule[1], /display:none/);
});

test('поворот не гасит изображение: transform-origin совпадает с матрицей paint()', () => {
  // paint() строит matrix() от левого верхнего угла. При transform-origin
  // center 0° работал случайно (чистая трансляция), а 90/180/270 уводили
  // картинку за пределы overflow:hidden — кадр становился чёрным.
  assert.match(layout, /\.crop-viewport img\{[^}]*transform-origin:0 0/);
  assert.match(layout, /\.crop-preview img\{[^}]*transform-origin:0 0/);
  assert.doesNotMatch(layout, /\{[^}]*transform-origin:center/);
});

test('поворот пересчитывает кадр целиком и остаётся в пределах 0/90/180/270', () => {
  assert.match(script, /rotationchange/);
  assert.match(script, /% 360/);
  // На каждый поворот кадр пересобирается заново по strict cover, а не
  // подгоняется от предыдущего состояния.
  assert.match(script, /editor\.addEventListener\('rotationchange', function \(event\) \{\s*\n\s*rotation = event\.detail\.rotation;\s*\n\s*state = defaultCrop\(\);/);
  assert.match(script, /var orientedWidth = quarterTurn \? currentImg\.naturalHeight : currentImg\.naturalWidth/);
});

test('strict cover сохранён: кадр всегда покрыт, масштаб не уходит ниже минимума', () => {
  assert.match(script, /Math\.max\(frame\.width \/ \(crop\.width \* orientedWidth\), frame\.height \/ \(crop\.height \* orientedHeight\)\)/);
  assert.match(script, /Math\.min\(1 - width/);
  assert.match(script, /Math\.max\(0, Math\.min\(1 - state\.width/);
  assert.doesNotMatch(layout, /background-size:contain|letterbox/);
});

// ─────────────────────────── загрузка ───────────────────────────

test('старый длинный native file input не отображается, но остаётся доступным', () => {
  const html = dishHtml();
  assert.doesNotMatch(html, /Новая фотография/);
  assert.match(html, /id="photo-file-hq-items-1-photos" type="file" name="photo"/);
  assert.doesNotMatch(html, /type="file"[^>]*disabled/);
});

test('плитка загрузки — это сам input: системный диалог открывается trusted-жестом', () => {
  const html = dishHtml();
  // Input лежит ВНУТРИ плитки и занимает её целиком. Прежняя схема (input —
  // сосед плитки, обрезанный до 1×1 классом .visually-hidden, клик доходил
  // до него только через label[for=id]) держалась на активации label и на
  // том, что невидимый контрол остаётся кликабельным; на production desktop
  // выбор файла так и не открывался. Теперь посредника между кликом и
  // контролом нет.
  const tile = /<label class="upload-tile"([^>]*)>([\s\S]*?)<\/label>/.exec(html);
  assert.ok(tile, 'плитка должна быть label');
  assert.doesNotMatch(tile[1], /\bfor=/, 'плитке больше не нужен label[for]');
  assert.match(tile[2], /<input id="photo-file-hq-items-1-photos" type="file"/);
  assert.doesNotMatch(html, /<input class="visually-hidden"[^>]*type="file"/);
  assert.match(html, /Добавить фото/);
  // Кликабельная поверхность — сам контрол, растянутый на всю плитку.
  assert.match(layout, /\.upload-tile input\[type=file\]\{[^}]*position:absolute[^}]*opacity:0/);
  assert.match(layout, /\.upload-tile\{position:relative\}/);
  // Синтетический .click() по input браузер вправе заблокировать — его быть
  // не должно.
  assert.doesNotMatch(script, /uploadInput\.click\(\)|input\.click\(\)/);
});

test('«Загрузить» до выбора файла выключена скриптом, но в разметке остаётся рабочей без JS', () => {
  const html = dishHtml();
  // В HTML кнопка НЕ disabled: без JS форма обязана оставаться обычной
  // рабочей multipart-формой.
  assert.match(html, /<button type="submit" class="upload-submit" data-upload-submit[^>]*>Загрузить<\/button>/);
  assert.doesNotMatch(html, /class="upload-submit"[^>]*disabled/);
  // Скрипт выключает её на старте и включает только на принятом файле —
  // иначе нажатие на «Загрузить» с пустым input не делало ровно ничего:
  // браузер блокировал отправку из-за required и не показывал подсказку.
  assert.match(script, /setSubmitEnabled\(false\)/);
  assert.match(script, /setSubmitEnabled\(accept\(file\)\)/);
});

test('после выбора файла показывается миниатюра, а не имя файла', () => {
  const html = dishHtml();
  assert.match(html, /data-upload-selected hidden/);
  assert.match(html, /data-upload-thumb/);
  assert.match(html, /data-upload-clear/);
  assert.match(html, /data-upload-busy hidden/);
  assert.match(script, /URL\.createObjectURL/);
  assert.match(script, /URL\.revokeObjectURL/);
  // hidden обязан побеждать авторский display:flex, иначе плитка и превью
  // видны одновременно, а «Загрузка…» висит постоянно.
  assert.match(layout, /\[hidden\]\{display:none!important\}/);
});

test('ошибка загрузки локальная, рядом с плиткой, и не стирает выбранный файл', () => {
  const html = renderPhotoManager({
    title: 'Фотографии блюда',
    photos: [],
    uploadAction: '/hq/items/1/photos',
    actionBase: '/hq/items/1/photos',
    csrfToken: 'token',
    maxPhotos: 20,
    mediaConfigured: true,
    dishCrops: true,
    error: 'Формат не поддерживается.',
  });
  assert.match(html, /<p class="upload-error is-visible" data-upload-error role="alert">Формат не поддерживается\.<\/p>/);
  // Ошибка живёт внутри формы загрузки, а не отдельным баннером панели.
  const form = html.slice(html.indexOf('<form class="photo-upload'));
  assert.match(form, /upload-error/);
  assert.match(script, /showError/);
  assert.match(script, /event\.preventDefault\(\)/);
});

test('клиентская проверка файла совпадает с серверным пределом и списком форматов', () => {
  assert.equal(MAX_SOURCE_BYTES, PIPELINE_MAX_SOURCE_BYTES);
  const html = dishHtml();
  assert.match(html, new RegExp(`data-max-bytes="${MAX_SOURCE_BYTES}"`));
  assert.match(html, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(script, /\['image\/jpeg', 'image\/png', 'image\/webp'\]/);
});

// ─────────────────────── карточка и primary ───────────────────────

test('основное фото ровно одно, остальным доступен явный выбор, без multi-select', () => {
  const html = dishHtml();
  assert.equal((html.match(/✓ Основное/g) || []).length, 1);
  assert.equal((html.match(/✓ Выбрано основным/g) || []).length, 1);
  assert.equal((html.match(/Сделать основным/g) || []).length, 1);
  assert.match(html, /photo-card is-primary/);
  // Никаких checkbox — выбор основного делается отдельной формой на фото.
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /\/photos\/8\/primary/);
});

// ─────────────────────────── назад ───────────────────────────

test('кнопка «Назад» ведёт на меню ресторана явным адресом, а не через history', () => {
  const back = renderBackLink({ href: '/hq/restaurants/12/menu' });
  assert.match(back, /<a class="detail-back" href="\/hq\/restaurants\/12\/menu">/);
  assert.match(back, /Назад/);
  assert.doesNotMatch(script, /history\.back\(\)/);

  const menuViews = fs.readFileSync(path.join(__dirname, '../hq/menuViews.js'), 'utf8');
  // На detail-странице блюда ссылка стоит ДО заголовка, поэтому видна сразу.
  const form = menuViews.slice(menuViews.indexOf('function renderMenuItemForm'));
  const backIdx = form.indexOf('renderBackLink({ href:');
  const headingIdx = form.indexOf('<h2>${esc(title)}</h2>');
  assert.ok(backIdx > -1 && headingIdx > -1 && backIdx < headingIdx,
    'renderBackLink должен идти перед заголовком блюда');
});

// Адрес возврата перестал быть голым `base`: он несёт состояние навигации
// (?item=N#dish-N), по которому сервер раскрывает нужную категорию, а hq.js
// возвращает прокрутку. Инвариант прежний и здесь же и проверяется — это
// по-прежнему ЯВНЫЙ адрес, а не history.back().
test('«Назад» с карточки блюда возвращает в то же место меню явным адресом', () => {
  const { renderMenuItemForm } = require('../hq/menuViews');
  const categories = [{ id: 4, name: 'Салаты', archived_at: null }];
  const restaurant = { id: 12, name: 'R' };

  const existing = renderMenuItemForm({
    restaurant, item: { id: 5, name: 'Цезарь', price: 300, category_id: 4, is_available: 1 },
    categories, csrfToken: 't', linkBasePath: '/hq', isNew: false,
  });
  assert.match(existing, /<a class="detail-back" href="\/hq\/restaurants\/12\/menu\?item=5#dish-5">/);

  // У ещё не созданного блюда id нет — возврат ведёт просто в меню.
  const fresh = renderMenuItemForm({
    restaurant, item: null, categories, csrfToken: 't', linkBasePath: '/hq', isNew: true,
  });
  assert.match(fresh, /<a class="detail-back" href="\/hq\/restaurants\/12\/menu">/);

  // Возврат по-прежнему не полагается на историю браузера.
  assert.doesNotMatch(script, /history\.back\(\)/);
});

// Фотографии блюда стоят ВЫШЕ формы: карточку блюда открывают прежде всего
// ради фотографий, и они не должны быть под полутора десятками полей.
// Строка статуса под заголовком осталась только у архивированного блюда:
// наличие у активного показывает переключатель, и вторая, текстовая копия
// того же состояния рядом делала экран двусмысленным.
test('на карточке блюда «Фотографии блюда» идут между заголовком и формой', () => {
  const { renderMenuItemForm } = require('../hq/menuViews');
  const render = (item) => renderMenuItemForm({
    restaurant: { id: 12, name: 'R' },
    item,
    categories: [{ id: 4, name: 'Салаты', archived_at: null }],
    csrfToken: 't', linkBasePath: '/hq', isNew: false,
    photos: [], mediaConfigured: true, maxPhotos: 20,
  });

  const html = render({ id: 5, name: 'Цезарь', price: 300, category_id: 4, is_available: 1 });
  const heading = html.indexOf('<h2>');
  const photos = html.indexOf('Фотографии блюда');
  const name = html.indexOf('id="if-name"');
  const save = html.indexOf('>Сохранить<');
  assert.ok(heading > -1 && photos > -1 && name > -1 && save > -1);
  assert.ok(heading < photos, 'фотографии идут сразу после заголовка блюда');
  assert.ok(photos < name, 'поля формы — ниже фотографий');
  assert.ok(name < save, 'форма осталась целой');
  assert.equal(html.indexOf('class="item-status"'), -1,
    'у активного блюда состояние показывает переключатель, а не вторая подпись');

  // У архивированного строка статуса на месте и по-прежнему выше фотографий.
  const archived = render({ id: 5, name: 'Цезарь', price: 300, category_id: 4, is_available: 0, archived_at: new Date() });
  const archivedStatus = archived.indexOf('class="item-status"');
  assert.ok(archivedStatus > -1 && archivedStatus < archived.indexOf('Фотографии блюда'));
});

// ─────────────────────────── отступы ───────────────────────────

test('вертикальный ритм формы задан общей системой, а не отступами у каждого поля', () => {
  assert.match(layout, /label\{[^}]*margin:20px 0 8px/);
  assert.match(layout, /\.row\{[^}]*margin-top:20px/);
  assert.match(layout, /\.row label\{margin-top:0\}/);
  assert.match(layout, /\.panel>form>button\[type=submit\]\{margin-top:24px\}/);
});

test('блок фотографий разделён аккуратными интервалами', () => {
  assert.match(layout, /\.photo-section-title\{[^}]*margin-bottom:6px/);
  assert.match(layout, /\.photo-meta\{[^}]*margin-bottom:16px/);
  assert.match(layout, /\.photo-upload\{margin-top:22px\}/);
  assert.match(layout, /\.upload-row\{[^}]*gap:16px/);
});

// ─────────────────────────── mobile ───────────────────────────

test('на узком экране редактор и загрузка остаются пригодными для пальца', () => {
  const mobile = /@media\(max-width:620px\)\{([\s\S]*?)\}\s*$/m.exec(layout);
  assert.ok(mobile, 'мобильный media-блок не найден');
  assert.match(mobile[1], /\.rotation-controls button\{flex:1;min-height:44px/);
  assert.match(mobile[1], /\.crop-controls button\{flex:1 1 auto;min-height:44px\}/);
  assert.match(mobile[1], /\.upload-submit\{min-height:44px\}/);
  assert.match(mobile[1], /\.upload-tile,\.upload-thumb\{width:112px;height:112px\}/);
});
