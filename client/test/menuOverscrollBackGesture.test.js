'use strict';

// Симптом: очень быстрый/неточный вертикальный fling у левого края экрана в
// мобильном Safari иногда распознаётся системой как edge-swipe-back (тот же
// жест, что открывает Safari "Назад"). Наш SPA делает history.pushState() при
// входе в меню (см. go() в app.js), поэтому такой жест валиден и стреляет
// popstate — пользователя выбрасывает из длинного меню ресторана на главную
// посреди обычного скролла, без единого клика.
//
// Реальный триггер — системный touch-жест WKWebView, а не DOM-событие: ни
// node:vm-песочница (window.addEventListener — no-op заглушка, см.
// helpers/loadApp.js), ни синтетические touch-события в headless-браузере не
// воспроизводят его достоверно. Единственная надёжная регрессионная проверка
// на уровне этого репозитория — что защитный CSS (overscroll-behavior-x:none
// на html/body, тот же приём, что уже стоит на .mtabs) не будет случайно
// удалён в будущем. Живой прогон на реальном iPhone остаётся обязательным
// подтверждением (см. отчёт).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readStyle() {
  return fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
}

test('корневой документ (html) запрещает горизонтальный overscroll, который Safari использует для edge-swipe-back', () => {
  const css = readStyle();
  const htmlRule = css.match(/\bhtml\{[^}]*\}/);
  assert.ok(htmlRule, 'правило html{...} не найдено в style.css');
  assert.match(htmlRule[0], /overscroll-behavior-x:none/);
});

test('body тоже запрещает горизонтальный overscroll (Safari по-разному выбирает scrolling element для html/body)', () => {
  const css = readStyle();
  const bodyRule = css.match(/\bbody\{[^}]*\}/);
  assert.ok(bodyRule, 'правило body{...} не найдено в style.css');
  assert.match(bodyRule[0], /overscroll-behavior-x:none/);
});

test('горизонтальные внутренние скроллеры (.mtabs) сохраняют собственную overscroll-behavior-x:contain — фикс не должен её перекрыть', () => {
  const css = readStyle();
  const mtabsRule = css.match(/\.mtabs\{[^}]*\}/);
  assert.ok(mtabsRule, 'правило .mtabs{...} не найдено в style.css');
  assert.match(mtabsRule[0], /overscroll-behavior-x:contain/);
});
