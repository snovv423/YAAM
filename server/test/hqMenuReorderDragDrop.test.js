'use strict';

// Регрессия на production-баг перестановки категорий и блюд в HQ-меню
// (/hq/restaurants/:id/menu). Handle'ы были видны, но сортировка не работала:
// в production access-логе на один жест приходили СРАЗУ ДВА POST-а —
// /menu/reorder-categories и /menu/categories/:id/reorder-items, — и порядок
// не менялся ни в одном из списков.
//
// Причина в разметке: ul[data-reorder="items"] лежит ВНУТРИ
// details.cat-block, который сам является строкой .cat-list[data-reorder=
// "categories"]. Старый скрипт брал строку как
// `closest('.cat-block') || closest('.dish-row')` — для handle блюда первый
// селектор попадал в родительскую категорию, — а pointerdown всплывал обоим
// спискам, и оба начинали тащить свою строку.
//
// Живая проверка (мышь на 1440×900 и палец на 390×844: порядок меняется,
// уходит в БД одним POST-ом и переживает reload; прокрутка пальцем по строке
// ничего не переставляет) выполнена в браузере отдельно; здесь закреплены те
// инварианты разметки/скрипта, потеря которых немедленно вернула бы дефект.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderMenuTab } = require('../hq/menuViews');

const layout = fs.readFileSync(path.join(__dirname, '../hq/layout.js'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../hq/static/hq.js'), 'utf8');

function menuHtml() {
  return renderMenuTab({
    restaurant: { id: 1, name: 'Тестовый' },
    menu: [
      {
        id: 10,
        name: 'Первая',
        items: [
          { id: 100, name: 'Блюдо A', price: 100, photo_count: 0, is_available: 1 },
          { id: 101, name: 'Блюдо B', price: 200, photo_count: 0, is_available: 1 },
        ],
      },
      {
        id: 11,
        name: 'Вторая',
        items: [{ id: 102, name: 'Блюдо C', price: 300, photo_count: 0, is_available: 1 }],
      },
    ],
    csrfToken: 'token',
    linkBasePath: '/hq',
  });
}

test('списки перестановки вложены друг в друга — это и есть источник дефекта', () => {
  const html = menuHtml();
  assert.match(html, /<div class="cat-list" data-reorder="categories" data-endpoint="\/hq\/restaurants\/1\/menu\/reorder-categories">/);
  assert.match(html, /<ul class="dish-list" data-reorder="items" data-category-id="10" data-endpoint="\/hq\/restaurants\/1\/menu\/categories\/10\/reorder-items">/);
  // Список блюд действительно находится внутри строки списка категорий.
  const catBlock = /<details class="cat-block" data-category-id="10">([\s\S]*?)<\/details>/.exec(html);
  assert.ok(catBlock, 'категория рендерится как строка .cat-block');
  assert.match(catBlock[1], /data-reorder="items"/);
});

test('строка ищется по виду списка, а не «категория, иначе блюдо»', () => {
  // Ровно этот `||` и таскал всю категорию вместо блюда (регулярка нарочно
  // привязана к присваиванию, иначе она находила бы и объясняющий комментарий).
  assert.doesNotMatch(script, /var row = handle\.closest\('\.cat-block'\)/);
  assert.match(script, /var ROW_SELECTOR = \{ categories: '\.cat-block', items: '\.dish-row' \}/);
  assert.match(script, /var row = handle\.closest\(selector\);/);
  assert.match(script, /if \(!row \|\| row\.parentNode !== list\) return;/);
});

test('событие обрабатывает только ближайший к handle список — двойного POST быть не может', () => {
  assert.match(script, /if \(handle\.closest\('\[data-reorder\]'\) !== list\) return;/);
  assert.match(script, /event\.stopPropagation\(\)/);
});

test('порядок уходит на сервер только когда он реально изменился', () => {
  assert.match(script, /var orderBefore = orderOf\(list\);/);
  assert.match(script, /if \(moved && orderOf\(list\) !== orderBefore\) persist\(list\);/);
});

test('позиция вставки считается по геометрии соседей, а не elementFromPoint', () => {
  // Приподнятая строка сама находится под указателем и перекрывала бы цель.
  assert.doesNotMatch(script, /elementFromPoint\(moveEvent/);
  assert.match(script, /function placeBy\(list, row, clientY\)/);
  assert.match(script, /clientY < rect\.top \+ rect\.height \/ 2/);
});

test('захват указателя стоит на списке, а не на handle внутри переставляемой строки', () => {
  // insertBefore на мгновение вынимает строку из документа: захват,
  // висевший внутри неё, браузер сбросил бы посреди жеста.
  assert.match(script, /list\.setPointerCapture\(pointerId\)/);
  assert.doesNotMatch(script, /handle\.setPointerCapture/);
  assert.match(script, /window\.addEventListener\('pointermove', onMove, true\)/);
});

test('после перетаскивания категории её <summary> не срабатывает', () => {
  assert.match(script, /clickEvent\.preventDefault\(\)/);
  assert.match(script, /window\.setTimeout\(release, 350\)/);
});

test('прокрутка пальцем не ломается: touch-action:none только на handle', () => {
  assert.match(layout, /\.drag-handle\{[^}]*touch-action:none/);
  assert.doesNotMatch(layout, /\.dish-row\{[^}]*touch-action:none/);
  assert.doesNotMatch(layout, /\.cat-summary\{[^}]*touch-action:none/);
  // Тапабельная площадь handle доведена до 32×44 без изменения вёрстки строки.
  assert.match(layout, /\.drag-handle\{[^}]*box-sizing:content-box[^}]*padding:12px 8px;margin:-12px -8px/);
});

test('у перетаскиваемой строки есть видимое состояние и она не «залипает» под анимацией', () => {
  assert.match(layout, /\.dragging\{[^}]*z-index:5/);
  assert.match(layout, /\.dragging\{(?:(?!transition)[^}])*\}/);
  assert.match(layout, /html\.is-reordering\{user-select:none/);
});

test('неудачное сохранение порядка видно владельцу, а не проглатывается', () => {
  assert.match(script, /list\.classList\.add\('reorder-failed'\)/);
  assert.match(layout, /\.reorder-failed\{/);
});
