'use strict';

// Refresh на карточке блюда уже возвращал на то же блюдо, но перед ним на
// мгновение показывалась главная: её разметка помечена active прямо в
// документе, поэтому она успевала стать первым кадром, пока app.js
// асинхронно поднимал ресторан и блюдо.
//
// Здесь закрепляется механика предпаинтовой заставки: маршрут распознаётся
// инлайновым скриптом в <head> (то есть ДО разбора <body> и до первого
// кадра), на время восстановления не показывается ни один экран, и класс
// обязательно снимается. Отдельно — что формат маршрута в <head> и в
// parseRouteHash() из app.js не разъехались: разойдясь, они дадут либо
// вернувшуюся вспышку главной, либо тёмный экран без причины.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Инлайновый скрипт-страж — единственный <script> без src в документе.
function bootGuardSource() {
  const scripts = [...INDEX_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const guard = scripts.filter((code) => code.includes('route-boot'));
  assert.equal(guard.length, 1, 'страж маршрута должен быть ровно один инлайновый скрипт');
  return guard[0];
}

// Исполняет страж так же, как браузер: до <body>, с данным адресом.
function runGuard(hash) {
  const classes = new Set();
  const context = {
    window: null,
    document: {
      documentElement: {
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
        },
      },
    },
  };
  context.window = {
    location: { hash },
    addEventListener() {},
  };
  context.location = context.window.location;
  vm.runInNewContext(bootGuardSource(), context);
  return classes.has('route-boot');
}

// ---------------------------------------------------------------------------
// Страж стоит до <body> и действительно прячет экраны
// ---------------------------------------------------------------------------

test('страж маршрута выполняется до разбора разметки — иначе главная успевает стать первым кадром', () => {
  const guardAt = INDEX_HTML.indexOf('route-boot');
  const headEndAt = INDEX_HTML.indexOf('</head>');
  const bodyAt = INDEX_HTML.indexOf('<body>', headEndAt);
  const homeAt = INDEX_HTML.indexOf('id="home" class="screen active"');
  assert.ok(guardAt > -1 && bodyAt > -1 && homeAt > -1);
  assert.ok(guardAt < headEndAt, 'страж обязан находиться внутри <head>');
  assert.ok(guardAt < bodyAt, 'страж обязан стоять до открытия документа');
  assert.ok(guardAt < homeAt, 'страж обязан стоять до разметки главной, которая помечена active');

  // Скрипт стража — синхронный: defer/async отложили бы его за разбор
  // документа, и смысл потерялся бы полностью.
  const guardTag = /<script>[\s\S]*?route-boot[\s\S]*?<\/script>/.exec(INDEX_HTML);
  assert.ok(guardTag, 'страж должен быть инлайновым <script> без src/defer/async');
});

test('пока идёт восстановление маршрута, не показывается ни один экран и холст остаётся тёмным', () => {
  assert.match(INDEX_HTML, /html\.route-boot \.screen\{display:none!important\}/,
    'ни один .screen (включая главную) не должен показываться под route-boot');
  assert.match(INDEX_HTML, /#route-boot\{display:none;position:fixed;inset:0/,
    'заставка перекрывает весь экран');
  assert.match(INDEX_HTML, /#route-boot\{[^}]*background:#0A2417/,
    'фон заставки — тот же тёмный, что и у html/body: первый кадр не меняет цвет');
  assert.match(INDEX_HTML, /<div id="route-boot" aria-hidden="true"><\/div>/,
    'элемент заставки должен существовать в разметке');
  // Индикатор проявляется с задержкой — на быстром восстановлении его не видно.
  assert.match(INDEX_HTML, /animation:route-boot-spin[^;}]*,route-boot-in [^;}]*\.45s forwards/);
});

// ---------------------------------------------------------------------------
// Формат маршрута в <head> и в app.js — один и тот же
// ---------------------------------------------------------------------------

test('страж срабатывает ровно на тех адресах, которые app.js считает маршрутом', (t) => {
  const { sandbox } = createSandbox({ cityChips: ['Грозный'] });
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));

  const hashes = [
    '#/r/1', '#/r/12/d/34', '#/r/7/d/c0i2', '#/r/999999',
    '', '#', '#/r/', '#/r/0', '#/r/abc', '#/r/-1', '#/r/1/d/', '#/r/1/x/2',
    '#/r/1/d/' + 'x'.repeat(41), '#shared=YAAM-1:yaam_shr_v1_x', '#/r/1/d/a b',
    '#/r/1?x=1', '#/R/1', '#/r/1/d/34/extra',
  ];
  for (const hash of hashes) {
    const guard = runGuard(hash);
    const app = evalInContext(sandbox, `(()=>{location.hash=${JSON.stringify(hash)};return parseRouteHash()!==null;})()`);
    assert.equal(guard, app,
      `«${hash}»: страж в <head> и parseRouteHash() должны согласиться (страж=${guard}, app=${app})`);
  }
});

test('на обычном заходе на главную заставка не включается вовсе', () => {
  assert.equal(runGuard(''), false);
  assert.equal(runGuard('#shared=YAAM-00042:yaam_shr_v1_abc'), false);
});

// ---------------------------------------------------------------------------
// Заставка всегда снимается
// ---------------------------------------------------------------------------

test('страж сам снимает заставку, если скрипт приложения не загрузился или упал', () => {
  const source = bootGuardSource();
  assert.match(source, /addEventListener\('error'[\s\S]*?true\)/,
    'слушатель error обязан быть в capture-фазе — иначе ошибки загрузки ресурсов до него не дойдут');
  assert.match(source, /classList\.remove\('route-boot'\)/);
  assert.doesNotMatch(source, /setTimeout|setInterval/,
    'снятие заставки не должно зависеть от таймера');
});

test('после восстановления маршрута заставка снята', async (t) => {
  const { sandbox } = createSandbox({ cityChips: ['Грозный'], locationHash: '#/r/1/d/c0i0' });
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));
  // Имитируем страж: класс стоял бы к этому моменту в реальном браузере.
  evalInContext(sandbox, "document.documentElement.classList.add('route-boot')");

  for (let i = 0; i < 100; i += 1) {
    if (evalInContext(sandbox, "cur('dish')")) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(evalInContext(sandbox, "cur('dish')"), true, 'блюдо должно открыться');
  assert.equal(evalInContext(sandbox, "document.documentElement.classList.contains('route-boot')"), false,
    'после восстановления маршрута заставка обязана быть снята');
});

test('заставка снимается и когда экран занял активный заказ, и когда маршрута нет вовсе', async (t) => {
  const { sandbox } = createSandbox({ cityChips: ['Грозный'] });
  loadAppInSandbox(sandbox);
  t.after(() => teardown(sandbox));
  evalInContext(sandbox, "document.documentElement.classList.add('route-boot');finishRouteBoot();");
  assert.equal(evalInContext(sandbox, "document.documentElement.classList.contains('route-boot')"), false);
  // Идемпотентность: повторный вызов не бросает.
  evalInContext(sandbox, 'finishRouteBoot();finishRouteBoot();');
});
