// Фича «Поделиться заказом» (Web Share API) — клиентская часть.
// Тот же vm-sandbox harness, что и остальные test/*.test.js (см.
// helpers/loadApp.js): реальный client/js/app.js в изолированном контексте.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

function freshApp(opts) {
  const { sandbox } = createSandbox(opts);
  loadAppInSandbox(sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// parseSharedHash()
// ---------------------------------------------------------------------------

test('parseSharedHash: корректный хэш разбирается на code+token', () => {
  const sandbox = freshApp();
  const token = `yaam_shr_v1_${Buffer.alloc(32, 1).toString('base64url')}`;
  sandbox.location.hash = `#shared=YAAM-00042:${token}`;
  const result = evalInContext(sandbox, 'parseSharedHash()');
  // Объект создан внутри vm-контекста — сравниваем через JSON.stringify,
  // не assert.deepEqual (тот же приём, что и в orderAccessToken.test.js,
  // избегает cross-realm "same structure but not reference-equal").
  assert.equal(JSON.stringify(result), JSON.stringify({ code: 'YAAM-00042', token }));
  teardown(sandbox);
});

test('parseSharedHash: отсутствие хэша даёт null', () => {
  const sandbox = freshApp();
  sandbox.location.hash = '';
  assert.equal(evalInContext(sandbox, 'parseSharedHash()'), null);
  teardown(sandbox);
});

test('parseSharedHash: некорректный формат кода отклоняется', () => {
  const sandbox = freshApp();
  const token = `yaam_shr_v1_${Buffer.alloc(32, 2).toString('base64url')}`;
  sandbox.location.hash = `#shared=not-a-code:${token}`;
  assert.equal(evalInContext(sandbox, 'parseSharedHash()'), null);
  teardown(sandbox);
});

test('parseSharedHash: некорректный токен (не share-capability) отклоняется', () => {
  const sandbox = freshApp();
  sandbox.location.hash = '#shared=YAAM-00042:yaam_ord_v1_notavalidtoken';
  assert.equal(evalInContext(sandbox, 'parseSharedHash()'), null);
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// ensureShareToken() / shareOrder() — минт и кэш share-токена
// ---------------------------------------------------------------------------

test('ensureShareToken: минтит новый токен и регистрирует его через POST /orders/:code/share заголовком', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  let captured;
  sandbox.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 204, async json() { return {}; } };
  };
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 3).toString('base64url')}`;
  const token = await evalInContext(sandbox, `ensureShareToken('YAAM-00001', ${JSON.stringify(accessToken)})`);
  assert.match(token, /^yaam_shr_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(captured.url, 'https://api.example.invalid/api/orders/YAAM-00001/share');
  assert.equal(captured.options.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(captured.options.headers['X-Share-Token'], token);
  // Токен не должен попадать ни в URL, ни в тело запроса — тот же принцип,
  // что и у остальных секретов в api.js.
  assert.equal(captured.url.includes(token), false);
  assert.equal(captured.options.body, undefined);
  teardown(sandbox);
});

test('ensureShareToken: повторный вызов переиспользует закэшированный токен без нового запроса', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  let calls = 0;
  sandbox.fetch = async () => { calls += 1; return { ok: true, status: 204, async json() { return {}; } }; };
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 4).toString('base64url')}`;
  const first = await evalInContext(sandbox, `ensureShareToken('YAAM-00002', ${JSON.stringify(accessToken)})`);
  const second = await evalInContext(sandbox, `ensureShareToken('YAAM-00002', ${JSON.stringify(accessToken)})`);
  assert.equal(first, second);
  assert.equal(calls, 1);
  teardown(sandbox);
});

test('shareOrder(): без USE_API показывает объясняющий toast и не создаёт ссылку', async () => {
  const sandbox = freshApp(); // demo — apiBaseUrl не задан
  await evalInContext(sandbox, `currentOrderCode='YAAM-00003';shareOrder()`);
  assert.match(sandbox.document.getElementById('toast').textContent, /только для заказов, оформленных через сервер/);
  teardown(sandbox);
});

test('shareOrder(): при наличии navigator.share вызывает его с корректным url', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({ ok: true, status: 204, async json() { return {}; } });
  sandbox.location.origin = 'https://yaam.su';
  sandbox.location.pathname = '/';
  let sharedWith = null;
  sandbox.navigator.share = async (data) => { sharedWith = data; };
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 5).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00004';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
  `);
  await evalInContext(sandbox, 'shareOrder()');
  assert.ok(sharedWith, 'navigator.share должен был быть вызван');
  assert.match(sharedWith.url, /^https:\/\/yaam\.su\/#shared=YAAM-00004:yaam_shr_v1_/);
  teardown(sandbox);
});

test('shareOrder(): без navigator.share копирует ссылку в буфер обмена', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({ ok: true, status: 204, async json() { return {}; } });
  sandbox.location.origin = 'https://yaam.su';
  sandbox.location.pathname = '/';
  let copied = null;
  sandbox.navigator.clipboard = { writeText: async (text) => { copied = text; } };
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 6).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00005';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
  `);
  await evalInContext(sandbox, 'shareOrder()');
  assert.match(copied, /^https:\/\/yaam\.su\/#shared=YAAM-00005:yaam_shr_v1_/);
  assert.match(sandbox.document.getElementById('toast').textContent, /Ссылка скопирована/);
  teardown(sandbox);
});

test('shareOrder(): AbortError от navigator.share — ничего не копирует и не показывает ошибку', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({ ok: true, status: 204, async json() { return {}; } });
  sandbox.location.origin = 'https://yaam.su';
  sandbox.location.pathname = '/';
  let clipboardCalled = false;
  sandbox.navigator.clipboard = { writeText: async () => { clipboardCalled = true; } };
  sandbox.navigator.share = async () => {
    const err = new Error('пользователь закрыл системный лист «Поделиться»');
    err.name = 'AbortError';
    throw err;
  };
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 12).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00009';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
  `);
  await evalInContext(sandbox, 'shareOrder()');
  // Единственные наблюдаемые действия shareOrder() при AbortError — их и
  // проверяем; toast здесь не годится как сигнал (независимый от этой
  // функции фоновый renderList() на этой же загрузке тоже пишет в тот же
  // #toast, что сделало бы проверку недетерминированной).
  assert.equal(clipboardCalled, false, 'AbortError не должен запускать clipboard fallback');
  assert.equal(sandbox.document.getElementById('confirm-overlay').classList.contains('on'), false, 'AbortError не должен показывать диалог с ошибкой');
  teardown(sandbox);
});

test('shareOrder(): реальная техническая ошибка navigator.share предлагает явное действие «Скопировать ссылку», не копирует молча', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({ ok: true, status: 204, async json() { return {}; } });
  sandbox.location.origin = 'https://yaam.su';
  sandbox.location.pathname = '/';
  let clipboardCalled = false;
  sandbox.navigator.clipboard = { writeText: async () => { clipboardCalled = true; } };
  sandbox.navigator.share = async () => {
    throw new Error('NotAllowedError: Web Share недоступен на этой платформе');
  };
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 13).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00010';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
  `);
  await evalInContext(sandbox, 'shareOrder()');
  // Молчаливого копирования быть не должно — только явный запрос действия.
  assert.equal(clipboardCalled, false, 'техническая ошибка не должна копировать молча');
  assert.equal(sandbox.document.getElementById('confirm-overlay').classList.contains('on'), true, 'должен показаться диалог с явным действием');
  assert.match(sandbox.document.getElementById('confirm-yes').textContent, /Скопировать ссылку/);
  // Пользователь подтверждает явное действие — только теперь копируем.
  await evalInContext(sandbox, `document.getElementById('confirm-yes').onclick()`);
  assert.equal(clipboardCalled, true, 'копирование должно произойти только после явного подтверждения пользователя');
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// Кнопка «Поделиться» видна ТОЛЬКО после подтверждённой оплаты (см.
// setShareButtonVisible() в pollOrderOnce()) — до этого заказ мог висеть
// на экране #status в статусе awaiting_payment (см. renderAwaitingPayment(),
// сценарий "вернулся назад с QR/обновил страницу"), и кнопка не должна
// быть доступна в этот момент.
// ---------------------------------------------------------------------------

test('Поделиться: кнопка ОСТАЁТСЯ скрытой, пока заказ awaiting_payment (неоплачен)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00011', status: 'awaiting_payment', items_total: 500,
        fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
        status_updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      };
    },
  });
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 14).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00011';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
    initStatusScreen();
  `);
  assert.equal(sandbox.document.getElementById('st-share-btn').style.display, 'none', 'до первого poll кнопка скрыта по умолчанию');
  await evalInContext(sandbox, 'pollOrderOnce()');
  assert.equal(sandbox.document.getElementById('st-share-btn').style.display, 'none', 'awaiting_payment — оплата НЕ подтверждена, кнопка обязана остаться скрытой');
  teardown(sandbox);
});

test('Поделиться: кнопка появляется после подтверждённого перехода в awaiting_restaurant (оплата подтверждена)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00012', status: 'awaiting_restaurant', items_total: 500,
        fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
        status_updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      };
    },
  });
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 15).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00012';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
    initStatusScreen();
  `);
  await evalInContext(sandbox, 'pollOrderOnce()');
  assert.equal(sandbox.document.getElementById('st-share-btn').style.display, 'inline-flex', 'awaiting_restaurant означает подтверждённую оплату — кнопка обязана появиться');
  teardown(sandbox);
});

test('Поделиться: кнопка видна на статусах прогресса после оплаты (preparing)', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00013', status: 'preparing', items_total: 500,
        fulfillment_type: 'delivery', restaurant_phone: null, rating: null,
      };
    },
  });
  const accessToken = `yaam_ord_v1_${Buffer.alloc(32, 16).toString('base64url')}`;
  await evalInContext(sandbox, `
    currentOrderCode='YAAM-00013';
    currentOrderAccessToken=${JSON.stringify(accessToken)};
    initStatusScreen();
  `);
  await evalInContext(sandbox, 'pollOrderOnce()');
  assert.equal(sandbox.document.getElementById('st-share-btn').style.display, 'inline-flex');
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// is_paid на read-only странице — понятное «Заказ оплачен»
// ---------------------------------------------------------------------------

test('openSharedOrder(): is_paid=true показывает «Заказ оплачен» на read-only странице', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00014', status: 'preparing', items_total: 500,
        fulfillment_type: 'delivery', restaurant_phone: null, is_paid: true,
        items: [{ name: 'Хинкали', price: 500, qty: 1 }],
      };
    },
  });
  const token = `yaam_shr_v1_${Buffer.alloc(32, 17).toString('base64url')}`;
  await evalInContext(sandbox, `openSharedOrder('YAAM-00014', ${JSON.stringify(token)})`);
  assert.equal(sandbox.document.getElementById('st-time').textContent, 'Заказ оплачен');
  teardown(sandbox);
});

test('openSharedOrder(): is_paid=false (заказ ещё не оплачен) НЕ показывает «Заказ оплачен»', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00015', status: 'awaiting_payment', items_total: 500,
        fulfillment_type: 'delivery', restaurant_phone: null, is_paid: false,
        items: [{ name: 'Хинкали', price: 500, qty: 1 }],
      };
    },
  });
  const token = `yaam_shr_v1_${Buffer.alloc(32, 18).toString('base64url')}`;
  await evalInContext(sandbox, `openSharedOrder('YAAM-00015', ${JSON.stringify(token)})`);
  assert.equal(sandbox.document.getElementById('st-time').textContent, '');
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// openSharedOrder() / applySharedOrderToDom() — read-only просмотр
// ---------------------------------------------------------------------------

test('openSharedOrder(): рендерит прогресс-статус и скрывает все владельческие действия', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00006', status: 'preparing', items_total: 850,
        fulfillment_type: 'delivery', restaurant_phone: '+79280000000',
        restaurant_name: 'QA Ресторан',
        items: [{ name: 'Хинкали', price: 350, qty: 2 }, { name: 'Чай', price: 150, qty: 1 }],
      };
    },
  });
  const token = `yaam_shr_v1_${Buffer.alloc(32, 7).toString('base64url')}`;
  await evalInContext(sandbox, `openSharedOrder('YAAM-00006', ${JSON.stringify(token)})`);
  assert.equal(sandbox.document.getElementById('st-num').textContent, 'YAAM-00006');
  assert.equal(sandbox.document.getElementById('st-cancel-wrap').style.display, 'none');
  assert.equal(sandbox.document.getElementById('st-next').style.display, 'none');
  assert.equal(sandbox.document.getElementById('st-demowrap').style.display, 'none');
  assert.equal(sandbox.document.getElementById('st-pending-pay-wrap').style.display, 'none');
  assert.equal(sandbox.document.getElementById('st-final').style.display, 'none');
  // Требование задания: состав заказа, количество, цены и итоговая сумма
  // видны на read-only странице.
  const itemsHtml = sandbox.document.getElementById('st-items').innerHTML;
  assert.match(itemsHtml, /2 × Хинкали/);
  assert.match(itemsHtml, /700 ₽/); // 350*2
  assert.match(itemsHtml, /1 × Чай/);
  assert.match(itemsHtml, /150 ₽/);
  assert.match(itemsHtml, /Итого/);
  assert.match(itemsHtml, /850 ₽/);
  // Телефон ресторана кликабелен через tel:.
  assert.equal(sandbox.document.getElementById('st-phone-link').href, 'tel:+79280000000');
  // Собственная сессия посетителя не затронута.
  assert.equal(evalInContext(sandbox, 'currentOrderCode'), null);
  assert.equal(evalInContext(sandbox, 'currentOrderAccessToken'), null);
  assert.equal(sandbox.localStorage.getItem('yaam_active_order'), null);
  teardown(sandbox);
});

test('openSharedOrder(): доставленный заказ показывает read-only сообщение вместо звёзд оценки', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00007', status: 'delivered', items_total: 500,
        fulfillment_type: 'delivery', rating: null, restaurant_phone: null,
      };
    },
  });
  const token = `yaam_shr_v1_${Buffer.alloc(32, 8).toString('base64url')}`;
  await evalInContext(sandbox, `openSharedOrder('YAAM-00007', ${JSON.stringify(token)})`);
  const ratingHtml = sandbox.document.getElementById('st-rating-wrap').innerHTML;
  assert.match(ratingHtml, /только просмотр статуса/);
  assert.doesNotMatch(ratingHtml, /submitRating/);
  teardown(sandbox);
});

test('openSharedOrder(): недействительный/просроченный share-токен показывает нейтральное сообщение об ошибке', async () => {
  const sandbox = freshApp({ apiBaseUrl: 'https://api.example.invalid' });
  sandbox.fetch = async () => { const err = new Error('заказ не найден'); err.status = 404; throw err; };
  const token = `yaam_shr_v1_${Buffer.alloc(32, 9).toString('base64url')}`;
  await evalInContext(sandbox, `openSharedOrder('YAAM-00008', ${JSON.stringify(token)})`);
  assert.match(sandbox.document.getElementById('st-state').textContent, /недействительна или устарела/);
  teardown(sandbox);
});

// ---------------------------------------------------------------------------
// Интеграция с загрузочной последовательностью: #shared= в хэше НЕ восстанавливает
// собственный активный заказ посетителя поверх read-only просмотра.
// ---------------------------------------------------------------------------

test('boot: #shared= хэш открывает read-only просмотр вместо восстановления собственного активного заказа', async () => {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.example.invalid' });
  const ownToken = `yaam_ord_v1_${Buffer.alloc(32, 10).toString('base64url')}`;
  sandbox.localStorage.setItem('yaam_active_order', JSON.stringify({
    orderCode: 'YAAM-OWN01', orderAccessToken: ownToken, restId: 1, orderItems: [],
  }));
  const shareToken = `yaam_shr_v1_${Buffer.alloc(32, 11).toString('base64url')}`;
  sandbox.location.hash = `#shared=YAAM-00099:${shareToken}`;
  sandbox.location.origin = 'https://yaam.su';
  sandbox.location.pathname = '/';
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_code: 'YAAM-00099', status: 'preparing', items_total: 300,
        fulfillment_type: 'pickup', rating: null, restaurant_phone: null,
      };
    },
  });
  loadAppInSandbox(sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evalInContext(sandbox, 'currentOrderCode'), null, 'собственный активный заказ не должен быть восстановлен на этом просмотре');
  assert.equal(sandbox.document.getElementById('st-num').textContent, 'YAAM-00099');
  // Собственный активный заказ в localStorage остаётся нетронутым.
  const stillOwn = JSON.parse(sandbox.localStorage.getItem('yaam_active_order'));
  assert.equal(stillOwn.orderCode, 'YAAM-OWN01');
  teardown(sandbox);
});
