'use strict';

// Production-дефект: «Онигири» (RAZRYAD, id 49) в БД и в публичном API имел
// is_available = 1, HQ показывал его в наличии, а на сайте карточка была
// серой с надписью «Нет в наличии» — и ни HQ, ни Telegram это не чинили.
//
// Причина: в app.js жила демо-заглушка SOLD_OUT={'2_0':true}, адресованная
// ПОЗИЦИЕЙ в меню (третья категория, первое блюдо). На реальных данных эта
// позиция попадала в живое блюдо и перекрывала его настоящее is_available.
//
// Здесь закрепляется единственный источник истины о наличии: поле из API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const CLIENT = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(CLIENT, 'js', 'app.js'), 'utf8');
const CITIES = ['Грозный', 'Аргун', 'Гудермес', 'Шали'];

function freshApp(opts = {}) {
  const { sandbox } = createSandbox({ cityChips: CITIES, ...opts });
  loadAppInSandbox(sandbox);
  return sandbox;
}

// Рисует меню ресторана и возвращает разметку карточек.
function renderMenu(sandbox, menu) {
  return evalInContext(sandbox, `(()=>{
    curRest=${JSON.stringify({ id: 1, name: 'RAZRYAD', menu })};
    renderMenuBody();
    return document.getElementById('m-body').innerHTML;
  })()`);
}

const CATEGORY = (name, items) => ({ cat: name, items });
const DISH = (n, extra = {}) => Object.assign({ n, d: '', p: 300, g: '', im: null }, extra);

// Комментарии из проверки исключаются: удалённая заглушка по-прежнему
// упоминается в объяснении, почему её нет, — это документация, а не код.
const APP_CODE = APP_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('позиция блюда в меню больше не может пометить его недоступным', () => {
  assert.ok(!/SOLD_OUT/.test(APP_CODE), 'SOLD_OUT — заглушка по позиции, её быть не должно в коде');
  assert.ok(!/['"]\d+_\d+['"]\s*:\s*true/.test(APP_CODE),
    'жёстко заданных «позиция -> недоступно» быть не должно');
  // Единственный источник недоступности — поле из API.
  assert.match(APP_CODE, /const so=d\.available===false;/);
});

test('карточка серая ровно тогда, когда is_available=0, независимо от позиции', (t) => {
  const sandbox = freshApp();
  t.after(() => teardown(sandbox));

  // Воспроизводим боевую раскладку RAZRYAD: «Онигири» — первое блюдо третьей
  // категории, то есть ровно та позиция, которую гасила заглушка.
  const html = renderMenu(sandbox, [
    CATEGORY('Горячее и мангал', [DISH('Рибай стейк', { available: true })]),
    CATEGORY('Пицца и фастфуд', [DISH('Сырные палочки', { available: true })]),
    CATEGORY('Роллы и сеты', [
      DISH('Онигири', { available: true }),
      DISH('Филадельфия', { available: false }),
    ]),
  ]);

  const cards = html.split('<div class="dish').slice(1);
  const cardOf = (name) => cards.find((c) => c.includes(`>${name}<`));

  const onigiri = cardOf('Онигири');
  assert.ok(onigiri, 'карточка «Онигири» должна отрисоваться');
  assert.ok(!onigiri.includes('dis'), 'доступное блюдо на «проклятой» позиции 2_0 больше не гасится');
  assert.ok(!onigiri.includes('Нет в наличии'), 'и не подписывается как отсутствующее');
  assert.ok(onigiri.includes('class="add"'), 'у него есть «+»');
  assert.ok(onigiri.includes('onclick="openDish('), 'карточка открывается');

  const philadelphia = cardOf('Филадельфия');
  assert.ok(philadelphia.includes('dis'), 'недоступное блюдо становится серым');
  assert.ok(philadelphia.includes('Нет в наличии'));
  assert.ok(!philadelphia.includes('class="add"'), 'заказать его нельзя — «+» нет');
  assert.ok(!philadelphia.includes('onclick="openDish('), 'и карточка не открывается');
});

test('ON/OFF из API переключает вид карточки в обе стороны', (t) => {
  const sandbox = freshApp();
  t.after(() => teardown(sandbox));
  const menu = (available) => [CATEGORY('Роллы', [DISH('Онигири', { available })])];

  const on = renderMenu(sandbox, menu(true));
  assert.ok(on.includes('class="add"') && !on.includes('Нет в наличии'));

  const off = renderMenu(sandbox, menu(false));
  assert.ok(off.includes('Нет в наличии') && !off.includes('class="add"'));

  // И обратно — без перезагрузки и без остаточного состояния.
  const backOn = renderMenu(sandbox, menu(true));
  assert.ok(backOn.includes('class="add"') && !backOn.includes('Нет в наличии'));
});

test('нормализация API: is_available 0/1 превращается в available false/true', (t) => {
  const sandbox = freshApp();
  t.after(() => teardown(sandbox));
  const flags = JSON.parse(evalInContext(sandbox, `JSON.stringify(
    normalizeRestaurant({id:1,name:'R',cities:['Грозный'],menu:[{name:'C',items:[
      {id:49,name:'Онигири',price:300,is_available:1},
      {id:50,name:'Филадельфия',price:400,is_available:0},
      {id:51,name:'Без поля',price:100}
    ]}]}).menu[0].items.map(i=>({n:i.n,available:i.available}))
  )`));
  assert.deepEqual(flags, [
    { n: 'Онигири', available: true },
    { n: 'Филадельфия', available: false },
    // Отсутствие поля не должно гасить блюдо: недоступность — это явный 0.
    { n: 'Без поля', available: true },
  ]);
});

test('demo-режим показывает свой пример недоступного блюда тем же полем', () => {
  const dataJs = fs.readFileSync(path.join(CLIENT, 'js', 'data.js'), 'utf8');
  assert.match(dataJs, /available:false/, 'пример задаётся данными, а не позицией');
});
