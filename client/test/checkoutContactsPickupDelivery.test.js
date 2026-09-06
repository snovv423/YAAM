'use strict';

// PRE-YOOKASSA CLEANUP, пп. 2/4/5 — три находки публичного аудита чекаута.
//
// 2. Поля адреса и телефона приходили в production с ЗАПОЛНЕННЫМИ value:
//    «ул. Маяковского, 18, кв. 7» и «+7 928 000-00-00». Это выглядело как уже
//    введённые данные пользователя и уходило в реальный заказ, если их не
//    заметить. Хуже: openCart() возвращал выдуманный адрес обратно каждый раз,
//    когда поле оказывалось пустым, — очистить его было невозможно.
//
// 4. Самовывоз предлагался и тогда, когда у ресторана нет адреса: экран
//    показывал «Адрес уточняется» и кнопку оплаты. То есть клиенту предлагали
//    заплатить, не сказав, куда идти за заказом.
//
// 5. delivery_price существовала в данных, но не показывалась нигде и не
//    входила в итог — ненулевая стоимость доставки молча игнорировалась.
//    Существующая модель (подпись поля в server/routes/postgresql/admin.js:
//    «справочно для клиента, в онлайн-оплату не входит») здесь не меняется —
//    величина просто становится видимой и явно помеченной.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const CLIENT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');

function freshApp() {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.example.invalid' });
  loadAppInSandbox(sandbox);
  return sandbox;
}

function openCheckout(sandbox, rest) {
  evalInContext(sandbox, `
    selectedCity='Аргун';
    curRest=${JSON.stringify(rest)};
    cart={'0_0':{n:'Блюдо',p:500,q:1,menuItemId:7}};
    renderLegalConsent=()=>{};
    openCart();
  `);
}

const REST_WITH_ADDRESS = { id: 1, name: 'Ресторан', address: 'г. Аргун, ул. Ресторанная, 1', phone: '', deliv: 0, min: 0 };
const REST_NO_ADDRESS = { id: 2, name: 'Без адреса', address: '', phone: '', deliv: 0, min: 0 };

// --- п.2: фиктивные контакты ------------------------------------------------

test('2.1 в разметке нет захардкоженных адреса и телефона', () => {
  assert.ok(!indexHtml.includes('Маяковского'),
    'выдуманный адрес не должен приезжать в production-разметку');
  assert.ok(!indexHtml.includes('+7 928 000-00-00'),
    'выдуманный телефон не должен приезжать в production-разметку');
});

test('2.2 поля адреса и телефона объявлены пустыми (пример — только placeholder)', () => {
  const addr = indexHtml.match(/<input id="c-addr"[^>]*>/)[0];
  const phone = indexHtml.match(/<input id="c-phone"[^>]*>/)[0];
  for (const [field, html] of [['c-addr', addr], ['c-phone', phone]]) {
    assert.ok(!/\svalue=/.test(html), `${field}: value= означает предзаполненные данные пользователя`);
    assert.match(html, /placeholder="/, `${field}: пример допустим только как placeholder`);
  }
});

test('2.3 openCart() не подставляет адрес в пустое поле', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_WITH_ADDRESS);
  assert.equal(sandbox.document.getElementById('c-addr').value, '',
    'пустое поле обязано остаться пустым');
  teardown(sandbox);
});

test('2.4 очищенный пользователем адрес не возвращается при повторном открытии', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_WITH_ADDRESS);
  evalInContext(sandbox, "document.getElementById('c-addr').value='ул. Настоящая, 5';");
  evalInContext(sandbox, "document.getElementById('c-addr').value='';");
  evalInContext(sandbox, 'openCart();');
  assert.equal(sandbox.document.getElementById('c-addr').value, '',
    'ровно тот дефект, который чинится: адрес возвращался сам');
  teardown(sandbox);
});

test('2.5 пустой адрес доставки не проходит валидацию', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_WITH_ADDRESS);
  evalInContext(sandbox, `
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='   ';
  `);
  assert.equal(evalInContext(sandbox, 'validateCheckout()'), false);
  assert.match(sandbox.document.getElementById('toast').textContent, /адрес доставки/i);
  teardown(sandbox);
});

test('2.6 заполненные имя/телефон/адрес валидацию проходят', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_WITH_ADDRESS);
  evalInContext(sandbox, `
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+7 928 123-45-67';
    document.getElementById('c-addr').value='ул. Настоящая, 5';
  `);
  assert.equal(evalInContext(sandbox, 'validateCheckout()'), true);
  teardown(sandbox);
});

// --- п.4: самовывоз ---------------------------------------------------------

test('4.1 у ресторана без адреса самовывоз не предлагается', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_NO_ADDRESS);
  assert.equal(sandbox.document.getElementById('fulfill-toggle').style.display, 'none',
    'выбор способа получения скрыт: самовывоза нет');
  assert.equal(evalInContext(sandbox, 'fulfillmentType'), 'delivery');
  teardown(sandbox);
});

test('4.2 «Адрес уточняется» больше не подставляется как адрес получения', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_NO_ADDRESS);
  assert.equal(sandbox.document.getElementById('c-pickup-addr').textContent, '');
  assert.ok(!indexHtml.includes('Адрес уточняется'));
  // Комментарии, объясняющие удалённую заглушку, остаются — ищем её как
  // работающий код, а не как упоминание в тексте.
  const appJsCode = fs.readFileSync(path.join(CLIENT, 'js', 'app.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!appJsCode.includes('Адрес уточняется'),
    'заглушка вместо адреса получения удалена из кода');
  teardown(sandbox);
});

test('4.3 сохранённый выбор «самовывоз» гасится, если у ресторана нет адреса', () => {
  const sandbox = freshApp();
  evalInContext(sandbox, "fulfillmentType='pickup';");
  openCheckout(sandbox, REST_NO_ADDRESS);
  assert.equal(evalInContext(sandbox, 'fulfillmentType'), 'delivery',
    'восстановление выбора после refresh не должно включать недоступный самовывоз');
  teardown(sandbox);
});

test('4.4 прямой вызов setFulfillment("pickup") без адреса тоже гасится', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_NO_ADDRESS);
  evalInContext(sandbox, "setFulfillment('pickup');");
  assert.equal(evalInContext(sandbox, 'fulfillmentType'), 'delivery');
  teardown(sandbox);
});

test('4.5 у ресторана с адресом самовывоз доступен и адрес виден ДО оплаты', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_WITH_ADDRESS);
  assert.notEqual(sandbox.document.getElementById('fulfill-toggle').style.display, 'none');
  evalInContext(sandbox, "setFulfillment('pickup');");
  assert.equal(evalInContext(sandbox, 'fulfillmentType'), 'pickup');
  assert.equal(sandbox.document.getElementById('c-pickup-addr').textContent,
    REST_WITH_ADDRESS.address);
  assert.equal(sandbox.document.getElementById('field-pickup-addr').style.display, '');
  teardown(sandbox);
});

test('4.6 при самовывозе адрес доставки не требуется', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, REST_WITH_ADDRESS);
  evalInContext(sandbox, `
    setFulfillment('pickup');
    document.getElementById('c-name').value='Клиент';
    document.getElementById('c-phone').value='+79281234567';
    document.getElementById('c-addr').value='';
  `);
  assert.equal(evalInContext(sandbox, 'validateCheckout()'), true);
  teardown(sandbox);
});

// --- п.5: стоимость доставки ------------------------------------------------

test('5.1 ненулевая стоимость доставки видна до оплаты и помечена как отдельная', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, { ...REST_WITH_ADDRESS, deliv: 200 });
  const html = sandbox.document.getElementById('c-items').innerHTML;
  assert.match(html, /200 ₽/, 'стоимость доставки обязана быть показана');
  assert.match(html, /оплачивается ресторану отдельно/,
    'модель не меняется: доставка не входит в онлайн-оплату — это должно быть сказано прямо');
  teardown(sandbox);
});

test('5.2 итог онлайн-оплаты — только еда, доставка в него не добавляется', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, { ...REST_WITH_ADDRESS, deliv: 200 });
  const html = sandbox.document.getElementById('c-items').innerHTML;
  assert.match(html, /за еду[^<]*<\/span><span>500 ₽/,
    'к оплате — 500 ₽ за еду, а не 700 ₽');
  assert.equal(sandbox.document.getElementById('c-total').textContent, '500 ₽');
  teardown(sandbox);
});

test('5.3 нулевая стоимость доставки не рисует пустую строку', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, { ...REST_WITH_ADDRESS, deliv: 0 });
  assert.ok(!/оплачивается ресторану отдельно/.test(sandbox.document.getElementById('c-items').innerHTML));
  teardown(sandbox);
});

test('5.4 при самовывозе строки доставки нет', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, { ...REST_WITH_ADDRESS, deliv: 200 });
  evalInContext(sandbox, "setFulfillment('pickup');");
  assert.ok(!/оплачивается ресторану отдельно/.test(sandbox.document.getElementById('c-items').innerHTML),
    'самовывоз — доставки нет вовсе');
  teardown(sandbox);
});

test('5.5 переключение способа получения пересобирает итог, а не оставляет устаревший', () => {
  const sandbox = freshApp();
  openCheckout(sandbox, { ...REST_WITH_ADDRESS, deliv: 200 });
  evalInContext(sandbox, "setFulfillment('pickup');");
  assert.ok(!/200 ₽/.test(sandbox.document.getElementById('c-items').innerHTML));
  evalInContext(sandbox, "setFulfillment('delivery');");
  assert.match(sandbox.document.getElementById('c-items').innerHTML, /200 ₽/);
  teardown(sandbox);
});

// --- п.3: реальные контакты -------------------------------------------------

test('3.1 официальные контакты YAAM опубликованы на главной и в реквизитах', () => {
  const contacts = fs.readFileSync(path.join(CLIENT, 'legal', 'contacts.html'), 'utf8');
  for (const source of [indexHtml, contacts]) {
    assert.match(source, /mailto:supportyaam@gmail\.com/);
    assert.match(source, /tel:\+79635820571/);
    assert.match(source, /t\.me\/YAAMHELP/);
  }
});

test('3.2 юридические страницы дают email и телефон, а не только Telegram', () => {
  for (const page of ['offer.html', 'privacy.html', 'personal-data-consent.html',
    'payment-refund.html', 'delivery.html']) {
    const source = fs.readFileSync(path.join(CLIENT, 'legal', page), 'utf8');
    assert.match(source, /supportyaam@gmail\.com/, `${page}: нет email`);
    assert.match(source, /\+7 963 582-05-71/, `${page}: нет телефона`);
  }
});

test('3.3 реквизиты ИП не изменены', () => {
  const contacts = fs.readFileSync(path.join(CLIENT, 'legal', 'contacts.html'), 'utf8');
  assert.match(contacts, /Гелаев Расул Тамерланович/);
  assert.match(contacts, /200100951887/);
  assert.match(contacts, /325200000027577/);
});

// --- п.6: демо-контролы -----------------------------------------------------

test('6.1 production-разметка не содержит демо-контролов', () => {
  for (const marker of ['Следующий статус', 'Демо:', 'st-demowrap', 'st-next',
    'demobar', 'demolink', 'data.js']) {
    assert.ok(!indexHtml.includes(marker), `index.html не должен содержать «${marker}»`);
  }
});

test('6.2 в разметке нет имён демо-ресторанов и демо-номера заказа', () => {
  for (const marker of ['«Кавказ»', 'ASCOFFEE', 'Бургер Хаус', 'YAAM-00001']) {
    assert.ok(!indexHtml.includes(marker), `index.html не должен содержать «${marker}»`);
  }
});
