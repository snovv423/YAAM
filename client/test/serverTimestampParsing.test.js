// Stage 27 — регрессионные тесты для Stage 26 H-1: "Ответ ресторана в
// течение NaN:NaN". Корень бага — client/js/app.js безусловно дописывал 'Z'
// к order.status_updated_at, а PostgreSQL уже отдаёт полный ISO8601 со СВОИМ
// 'Z' на конце ("...715Z" + дописанный 'Z' = "...715ZZ", Date.parse() -> NaN).
// Fix — единственный общий parseServerTimestamp(value), переиспользованный
// везде, где клиент разбирает timestamp с backend (applyPreparationDeadline,
// parseServerDeadline, parseServerCreatedAt, pollOrderOnce#awaiting_restaurant).
//
// Загружают РЕАЛЬНЫЙ client/js/app.js через node:vm (см. test/helpers/
// loadApp.js) — не переписанную копию логики.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// 1-4: parseServerTimestamp — прямые проверки хелпера на всех форматах,
// которые реально может прислать backend (или уже создать сам клиент).
// ---------------------------------------------------------------------------

test('1. parseServerTimestamp: PostgreSQL ISO8601 с Z разбирается корректно (не NaN, не двойной Z)', (t) => {
  const sandbox = freshApp();
  const ms = evalInContext(sandbox, `parseServerTimestamp('2026-08-03T23:36:50.715Z')`);
  assert.equal(ms, Date.parse('2026-08-03T23:36:50.715Z'));
  assert.ok(Number.isFinite(ms));
  teardown(sandbox);
});

test('2. parseServerTimestamp: ISO8601 с числовым offset разбирается корректно', (t) => {
  const sandbox = freshApp();
  const ms = evalInContext(sandbox, `parseServerTimestamp('2026-08-03T23:36:50+03:00')`);
  assert.equal(ms, Date.parse('2026-08-03T23:36:50+03:00'));
  assert.ok(Number.isFinite(ms));
  teardown(sandbox);
});

test('3. parseServerTimestamp: SQLite-строка "YYYY-MM-DD HH:mm:ss" (легаси, без пояса, всегда UTC) разбирается как UTC', (t) => {
  const sandbox = freshApp();
  const ms = evalInContext(sandbox, `parseServerTimestamp('2026-08-03 23:36:50')`);
  assert.equal(ms, Date.parse('2026-08-03T23:36:50Z'));
  assert.ok(Number.isFinite(ms));
  teardown(sandbox);
});

test('3b. parseServerTimestamp: ISO без миллисекунд и уже готовый Date/число — тоже без NaN', (t) => {
  const sandbox = freshApp();
  const msNoMs = evalInContext(sandbox, `parseServerTimestamp('2026-08-03T23:36:50Z')`);
  assert.ok(Number.isFinite(msNoMs));
  const msFromDate = evalInContext(sandbox, `parseServerTimestamp(new Date('2026-08-03T23:36:50Z'))`);
  assert.equal(msFromDate, msNoMs);
  const msFromNumber = evalInContext(sandbox, `parseServerTimestamp(1785000000000)`);
  assert.equal(msFromNumber, 1785000000000);
  teardown(sandbox);
});

test('4. parseServerTimestamp: невалидная/пустая строка -> null, не NaN', (t) => {
  const sandbox = freshApp();
  assert.equal(evalInContext(sandbox, `parseServerTimestamp('не дата')`), null);
  assert.equal(evalInContext(sandbox, `parseServerTimestamp('')`), null);
  assert.equal(evalInContext(sandbox, `parseServerTimestamp(null)`), null);
  assert.equal(evalInContext(sandbox, `parseServerTimestamp(undefined)`), null);
  // Специально: старый баг руками — двойной Z должен остаться null, а не
  // тихо превратиться в какую-то дату.
  assert.equal(evalInContext(sandbox, `parseServerTimestamp('2026-08-03T23:36:50.715ZZ')`), null);
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// Вспомогательное: реальный pollOrderOnce() через сеть (API-режим), с полным
// стабом fetch/api.getOrder — тестируем интеграцию, а не только сам парсер.
// ---------------------------------------------------------------------------
function apiSandbox(orderResponses) {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://example.invalid' });
  let call = 0;
  sandbox.fetch = async (url) => {
    // app.js на верхнем уровне безусловно вызывает renderList() при загрузке
    // (см. хвост app.js), которая сама делает GET /api/restaurants ДО того,
    // как тест успевает выставить currentOrderCode и вызвать pollOrderOnce()
    // явно — без этой развилки по пути тот самый первый вызов молча съедал
    // orderResponses[0], и все дальнейшие вызовы получали данные не того
    // заказа (найдено этим же тестовым файлом при первом прогоне).
    if (String(url).includes('/api/orders/')) {
      const order = orderResponses[Math.min(call, orderResponses.length - 1)];
      call += 1;
      return { ok: true, status: 200, json: async () => order };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  loadAppInSandbox(sandbox);
  return sandbox;
}

function baseOrder(overrides) {
  return {
    status: 'awaiting_restaurant',
    status_updated_at: '2026-08-03T23:36:50.715Z',
    items_total: 400,
    rating: null,
    fulfillment_type: 'delivery',
    public_code: 'YAAM-SRV1',
    restaurant_phone: null,
    preparation_deadline: null,
    refund_status: 'none',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 5-9: pollOrderOnce()#awaiting_restaurant — интеграционные сценарии.
// ---------------------------------------------------------------------------

test('5. pollOrderOnce: PostgreSQL-дата даёт настоящий обратный отсчёт, не NaN:NaN', async (t) => {
  const recentIso = new Date(Date.now() - 10_000).toISOString(); // 10 секунд назад
  const sandbox = apiSandbox([baseOrder({ status_updated_at: recentIso })]);
  await evalInContext(sandbox, `(async()=>{currentOrderCode='YAAM-SRV1';currentOrderAccessToken='tkn';await pollOrderOnce();})()`);
  const text = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.ok(!text.includes('NaN'), `не должно быть NaN нигде в тексте, получили "${text}"`);
  assert.match(text, /Ответ ресторана в течение \d+:\d{2}/, `ожидали реальный обратный отсчёт, получили "${text}"`);
  teardown(sandbox);
});

test('6. pollOrderOnce: истёкшее окно (10 минут назад) даёт 0:00, не отрицательное значение', async (t) => {
  const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sandbox = apiSandbox([baseOrder({ status_updated_at: oldIso })]);
  await evalInContext(sandbox, `(async()=>{currentOrderCode='YAAM-SRV2';currentOrderAccessToken='tkn';await pollOrderOnce();})()`);
  const text = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.equal(text, 'Ответ ресторана в течение 0:00');
  teardown(sandbox);
});

test('7. pollOrderOnce: невалидная/отсутствующая дата с backend -> честное состояние без выдуманного таймера, не NaN:NaN', async (t) => {
  const sandbox = apiSandbox([baseOrder({ status_updated_at: null })]);
  await evalInContext(sandbox, `(async()=>{currentOrderCode='YAAM-SRV3';currentOrderAccessToken='tkn';await pollOrderOnce();})()`);
  const text = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.ok(!text.includes('NaN'), `не должно быть NaN, получили "${text}"`);
  assert.equal(text, 'Ждём ответа ресторана');
  teardown(sandbox);
});

test('8. pollOrderOnce: повторный вызов для того же заказа (аналог "не перезапускает таймер при refresh") пересчитывает из той же серверной даты, не откатывается назад', async (t) => {
  const iso = new Date(Date.now() - 30_000).toISOString(); // 30 секунд назад
  const sandbox = apiSandbox([baseOrder({ status_updated_at: iso }), baseOrder({ status_updated_at: iso })]);
  await evalInContext(sandbox, `(async()=>{currentOrderCode='YAAM-SRV4';currentOrderAccessToken='tkn';await pollOrderOnce();})()`);
  const first = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  await evalInContext(sandbox, `(async()=>{await pollOrderOnce();})()`);
  const second = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  const parse = (s) => { const m = /(\d+):(\d{2})/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  assert.ok(parse(first) !== null && parse(second) !== null);
  assert.ok(parse(second) <= parse(first), `второй вызов не должен показывать БОЛЬШЕ оставшегося времени, чем первый (first="${first}", second="${second}")`);
  teardown(sandbox);
});

test('9. pollOrderOnce: awaiting_restaurant останавливает устаревший pre-status таймер (preTimer/preDeadline) — второй interval не остаётся', async (t) => {
  const iso = new Date(Date.now() - 5_000).toISOString();
  const sandbox = apiSandbox([baseOrder({ status_updated_at: iso })]);
  // Имитируем состояние ДО фикса: pre-status таймер уже был запущен (как
  // делает restoreDemoOrder()/renderWaitForRestaurant() при восстановлении
  // после refresh), и только потом приходит реальный ответ сервера.
  evalInContext(sandbox, `currentOrderCode='YAAM-SRV5';inPreStatus=true;startResponseTimer();`);
  assert.notEqual(evalInContext(sandbox, 'preTimer'), null, 'preTimer должен быть запущен до poll — иначе сценарий не воспроизведён');
  await evalInContext(sandbox, `(async()=>{currentOrderAccessToken='tkn';await pollOrderOnce();})()`);
  assert.equal(evalInContext(sandbox, 'preTimer'), null, 'pollOrderOnce() должен остановить устаревший pre-status interval при подтверждённом awaiting_restaurant');
  assert.equal(evalInContext(sandbox, 'preDeadline'), null);
  assert.equal(evalInContext(sandbox, 'inPreStatus'), false);
  const text = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.ok(!text.includes('NaN'));
  teardown(sandbox);
});

test('9b. pollOrderOnce: переход на другой заказ не оставляет текст от предыдущего NaN-сценария', async (t) => {
  const sandbox = apiSandbox([
    baseOrder({ status_updated_at: null, public_code: 'YAAM-SRV6A' }),
    baseOrder({ status_updated_at: new Date().toISOString(), public_code: 'YAAM-SRV6B' }),
  ]);
  await evalInContext(sandbox, `(async()=>{currentOrderCode='YAAM-SRV6A';currentOrderAccessToken='tkn';await pollOrderOnce();})()`);
  assert.equal(evalInContext(sandbox, `document.getElementById('st-substate').textContent`), 'Ждём ответа ресторана');
  evalInContext(sandbox, `currentOrderCode='YAAM-SRV6B';`);
  await evalInContext(sandbox, `(async()=>{await pollOrderOnce();})()`);
  const text = evalInContext(sandbox, `document.getElementById('st-substate').textContent`);
  assert.ok(!text.includes('NaN'));
  assert.match(text, /Ответ ресторана в течение \d+:\d{2}/);
  teardown(sandbox);
});
