'use strict';

// В установленном на домашний экран YAAM браузерной панели нет: страница
// получает весь экран целиком (apple-mobile-web-app-status-bar-style=
// black-translucent + viewport-fit=cover), и всё, что раньше прикрывал
// Safari, теперь может уехать под Dynamic Island или под home indicator.
//
// Проверить это в headless Chromium нельзя: DevTools не эмулирует
// env(safe-area-inset-*) — в эмуляторе все четыре всегда 0, поэтому любой
// браузерный тест «проходит» независимо от того, есть правило или нет.
// Здесь фиксируется наличие самих правил; живая проверка на реальном iPhone
// в standalone-режиме остаётся обязательной (см. отчёт).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CLIENT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(CLIENT, 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`(?:^|[,\\s}])${escaped}\\{([^}]*)\\}`, 'g'))];
  assert.ok(matches.length, `правило ${selector}{...} не найдено в style.css`);
  return matches.map((m) => m[1]).join(';');
}

test('шапка главной опускается ровно на величину выреза, а не на фиксированный запас', () => {
  // calc(24px + env(...)) вместо жёстких «+59px»: в обычной вкладке Safari
  // инсет равен нулю и вёрстка сайта не меняется ни на пиксель.
  assert.match(rule('.top'), /padding-top:calc\(24px \+ env\(safe-area-inset-top\)\)/);
});

test('sticky-группа категорий меню прилипает под вырезом, а не под ним', () => {
  assert.match(rule('.menu-sticky-group'), /top:env\(safe-area-inset-top\)/);
});

test('внутренние экраны сдвинуты целиком (меню, чекаут, оплата, статус, отказ, блюдо)', () => {
  // Меню обязано сдвигаться экраном, а не только кнопкой «Назад»: hero всего
  // 190px, и опущенная кнопка наезжала бы на название ресторана в две строки.
  assert.match(css, /#menu,#cart,#qr,#status,#rejected\{[^}]*padding-top:env\(safe-area-inset-top\)/);
  // #dish получил этот отступ раньше — правило должно сохраниться.
  assert.match(css, /#dish\{[^}]*padding-top:env\(safe-area-inset-top\)/);
});

test('под статус-баром есть перекрывающая полоса, нулевой высоты в обычном браузере', () => {
  assert.match(html, /<div id="sa-top" aria-hidden="true"><\/div>/);
  const saTop = rule('#sa-top');
  assert.match(saTop, /position:fixed/);
  assert.match(saTop, /height:env\(safe-area-inset-top\)/);
  assert.match(saTop, /pointer-events:none/);
  // Выше sticky-шапки (40) и группы категорий (30), но ниже штор (60+),
  // чтобы не затемнять корзину и окно подтверждения.
  const z = /z-index:(\d+)/.exec(saTop);
  assert.ok(z && Number(z[1]) > 40 && Number(z[1]) < 60, `z-index полосы вне диапазона 41..59: ${z && z[1]}`);
});

test('низ документа и всплывающие панели учитывают home indicator', () => {
  const body = rule('body');
  assert.match(body, /padding-bottom:calc\(108px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(body, /padding-left:env\(safe-area-inset-left\)/);
  assert.match(body, /padding-right:env\(safe-area-inset-right\)/);
  assert.match(rule('.toast'), /bottom:calc\(110px \+ env\(safe-area-inset-bottom\)\)/);
  // Существующие правила нижних фиксированных панелей должны сохраниться.
  assert.match(rule('.cartbar'), /padding-bottom:calc\(22px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(rule('.dish-add'), /padding-bottom:calc\(22px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(rule('.sheet'), /padding-bottom:calc\(28px \+ env\(safe-area-inset-bottom\)\)/);
});

// Штора голосования переехала вниз (bottom sheet), поэтому и safe-area у неё
// теперь нижняя: заголовок больше не касается выреза, а вот список упирался бы
// в индикатор дома.
test('нижняя штора голосования уважает нижнюю safe-area', () => {
  assert.match(rule('.vote-sheet'), /padding-bottom:env\(safe-area-inset-bottom\)/);
  assert.match(rule('.vote-list'), /padding-bottom:calc\(4px \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(rule('.vs-head'), /safe-area-inset-top/,
    'верхняя safe-area у шторы больше не при делах — она не касается выреза');
});

test('переход между экранами короткий и без transform, ломающего fixed-панели', () => {
  const screen = /\.screen\.active\{([^}]*)\}/.exec(css);
  assert.ok(screen, 'правило .screen.active не найдено');
  const duration = /animation:scrIn ([\d.]+)s/.exec(screen[1]);
  assert.ok(duration, 'у .screen.active нет анимации scrIn');
  const ms = Number(duration[1]) * 1000;
  assert.ok(ms >= 120 && ms <= 250, `переход ${ms}мс вне диапазона 120..250мс`);

  // scrIn обязан оставаться чисто opacity: transform на .screen создал бы
  // containing block для fixed-потомков (.cartbar, .dish-add) и дёргал бы их
  // на каждом переходе, а на большом DOM меню стоил бы лишний слой.
  const keyframes = /@keyframes scrIn\{([^@]*?)\}\s*\n/.exec(css);
  assert.ok(keyframes, '@keyframes scrIn не найден');
  assert.ok(!/transform/.test(keyframes[1]), 'scrIn не должен анимировать transform');
});

test('декоративная анимация отключается при prefers-reduced-motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}/);
});

test('фон документа задан до загрузки внешнего CSS — без белой вспышки при запуске', () => {
  // Инлайновый <style> и color-scheme применяются к первому же кадру, тогда
  // как css/style.css ещё блокирует рендер сетевым запросом.
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /<style>html\{background-color:#0A2417\}<\/style>/);
  const headEnd = html.indexOf('</head>');
  assert.ok(html.indexOf('<style>html{background-color:#0A2417}</style>') < headEnd,
    'инлайновый фон должен стоять в <head>');
});
