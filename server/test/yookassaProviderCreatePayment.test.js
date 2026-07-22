// YookassaProvider.createPayment() — юнит-тесты. НЕТ реальных сетевых
// вызовов: global.fetch подменяется на мок в каждом тесте и восстанавливается
// в конце файла. Реальные shopId/secretKey не используются нигде — только
// заведомо фейковые тестовые строки, не похожие на настоящий формат ключей.
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = {
  YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY,
  YOOKASSA_ENV: process.env.YOOKASSA_ENV,
  YOOKASSA_RETURN_URL: process.env.YOOKASSA_RETURN_URL,
  PAYMENT_CREATE_TIMEOUT_MS: process.env.PAYMENT_CREATE_TIMEOUT_MS,
};
const ORIGINAL_FETCH = global.fetch;

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

after(() => {
  restoreEnv();
  global.fetch = ORIGINAL_FETCH;
  delete require.cache[require.resolve('../services/paymentProviders/yookassaProvider')];
});

function freshProviderClass() {
  delete require.cache[require.resolve('../services/paymentProviders/yookassaProvider')];
  // eslint-disable-next-line global-require
  return require('../services/paymentProviders/yookassaProvider');
}

function setFakeTestCredentials() {
  // Заведомо фейковые, явно тестовые строки — не похожи на реальный формат
  // (у настоящих ключей ЮKassa другой префикс/длина), только для юнит-теста.
  process.env.YOOKASSA_SHOP_ID = '999999';
  process.env.YOOKASSA_SECRET_KEY = 'test_secret_fake_value_never_real';
  process.env.YOOKASSA_ENV = 'sandbox';
  process.env.YOOKASSA_RETURN_URL = 'https://yaam.su/return-test';
}

beforeEach(() => {
  restoreEnv();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function sandboxPaymentBody({ id = 'x', amount = '300.00', status = 'pending', confirmationUrl = 'https://yookassa.ru/checkout/redirect/test' } = {}) {
  return {
    id,
    status,
    test: true,
    amount: { value: amount, currency: 'RUB' },
    confirmation: { type: 'redirect', confirmation_url: confirmationUrl },
  };
}

test('конструктор бросает без YOOKASSA_SHOP_ID/SECRET_KEY (fail-closed, поведение не изменилось)', () => {
  delete process.env.YOOKASSA_SHOP_ID;
  delete process.env.YOOKASSA_SECRET_KEY;
  const YookassaProvider = freshProviderClass();
  assert.throws(() => new YookassaProvider(), /YOOKASSA_SHOP_ID.*SECRET_KEY/);
});

test('конструктор успешно создаёт экземпляр с заданными (фейковыми тестовыми) ключами', () => {
  setFakeTestCredentials();
  const YookassaProvider = freshProviderClass();
  assert.doesNotThrow(() => new YookassaProvider());
});

test('Sandbox guard: без YOOKASSA_ENV=sandbox провайдер fail-closed', () => {
  setFakeTestCredentials();
  delete process.env.YOOKASSA_ENV;
  const YookassaProvider = freshProviderClass();
  assert.throws(() => new YookassaProvider(), /YOOKASSA_ENV=sandbox/);
});

test('Sandbox guard: live Secret Key отклоняется до любого сетевого вызова', () => {
  setFakeTestCredentials();
  process.env.YOOKASSA_SECRET_KEY = 'live_fake_never_real';
  const YookassaProvider = freshProviderClass();
  assert.throws(() => new YookassaProvider(), /тестовый Secret Key/);
});

// Production Switch — Stage 8: verifyWebhook() реализована (канонический
// lookup у ЮKassa через уже существующий getStatus(), см. server/docs/
// postgresql-payment-safety.md) — больше не "not implemented" и больше не
// синхронна (реальная проверка требует сетевого вызова). `{}` — валидный
// JSON, но без обязательных полей уведомления (`type`/`event`/`object.id`)
// — корректно fail-closed возвращает null, не бросает. Исчерпывающие тесты
// самой верификации (структура/каноническая сверка/суммы) — в
// server/test/postgresql/paymentSafetyStage8.test.js.
test('verifyWebhook() реализована (Stage 8) — на пустом объекте без обязательных полей fail-closed возвращает null, не бросает', async () => {
  setFakeTestCredentials();
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.verifyWebhook('{}', {});
  assert.equal(result, null);
});

test('createPayment() без YOOKASSA_RETURN_URL — fail-closed, не отправляет запрос', async () => {
  setFakeTestCredentials();
  delete process.env.YOOKASSA_RETURN_URL;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch не должен вызываться'); };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'Заказ YAAM-00001', idempotencyKey: 'k1' }),
    /YOOKASSA_RETURN_URL/,
  );
  assert.equal(fetchCalled, false);
});

test('createPayment() строит корректный HTTP-запрос: URL, Basic Auth, Idempotence-Key, Content-Type, тело', async () => {
  setFakeTestCredentials();
  let capturedUrl, capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => sandboxPaymentBody({ id: 'yk_payment_123', amount: '1500.00', confirmationUrl: 'https://yookassa.ru/checkout/redirect/abc' }),
    };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.createPayment({ orderId: 42, amount: 1500, description: 'Заказ YAAM-00042', idempotencyKey: 'idem-key-1' });

  assert.equal(capturedUrl, 'https://api.yookassa.ru/v3/payments');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Idempotence-Key'], 'idem-key-1');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  const expectedAuth = 'Basic ' + Buffer.from('999999:test_secret_fake_value_never_real').toString('base64');
  assert.equal(capturedOptions.headers.Authorization, expectedAuth);

  const body = JSON.parse(capturedOptions.body);
  assert.deepEqual(body.amount, { value: '1500.00', currency: 'RUB' });
  assert.equal(body.capture, true, 'MVP-решение (ADR): capture=true всегда, явно');
  assert.deepEqual(body.confirmation, { type: 'redirect', return_url: 'https://yaam.su/return-test' });
  assert.equal(body.description, 'Заказ YAAM-00042');
  assert.deepEqual(body.metadata, { orderId: '42' });
});

test('amount форматируется как строка с ровно двумя знаками после запятой (официальный формат ЮKassa)', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => sandboxPaymentBody({ confirmationUrl: 'https://x' }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' });
  assert.equal(JSON.parse(capturedOptions.body).amount.value, '300.00');
});

test('успешный sandbox-ответ (redirect confirmation): paymentUrl заполнен, qrPayload=null', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sandboxPaymentBody({ id: 'yk_payment_456', amount: '500.00', confirmationUrl: 'https://yookassa.ru/checkout/redirect/xyz' }),
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.createPayment({ orderId: 7, amount: 500, description: 'd', idempotencyKey: 'k' });
  assert.deepEqual(result, {
    providerPaymentId: 'yk_payment_456',
    qrPayload: null,
    paymentUrl: 'https://yookassa.ru/checkout/redirect/xyz',
  });
});

test('malformed JSON-ответ -> ProviderResultUnknownError (никогда не считается успехом)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('200 OK, но тело без ожидаемых полей (нет confirmation) -> ProviderResultUnknownError, не считается успехом', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x', status: 'pending' /* confirmation отсутствует */ }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('Sandbox guard: createPayment отклоняет Payment с test=false', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...sandboxPaymentBody(), test: false }),
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.name === 'ProviderResultUnknownError',
  );
});

test('createPayment отклоняет канонический ответ с другой суммой', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => sandboxPaymentBody({ amount: '299.00' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.name === 'ProviderResultUnknownError',
  );
});

test('HTTP 400 -> YookassaCreatePaymentError с категорией fatal_request', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ type: 'error', code: 'invalid_request' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.name === 'YookassaCreatePaymentError' && err.category === CATEGORIES.FATAL_REQUEST,
  );
});

test('HTTP 401 -> категория fatal_configuration', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ type: 'error', code: 'invalid_credentials' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.category === CATEGORIES.FATAL_CONFIGURATION,
  );
});

test('HTTP 429 -> категория rate_limited', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ type: 'error', code: 'too_many_requests' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.category === CATEGORIES.RATE_LIMITED,
  );
});

test('HTTP 500 (мутирующая операция) -> UNKNOWN_RESULT, не RETRYABLE напрямую', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ type: 'error', code: 'internal_server_error' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('сетевая ошибка (fetch reject, не AbortError) -> классифицируется как network error -> UNKNOWN_RESULT (мутирующая операция)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { throw new TypeError('fetch failed: ECONNRESET'); };
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('таймаут (AbortController сработал) -> UNKNOWN_RESULT, не бросает сырой AbortError наружу', async () => {
  setFakeTestCredentials();
  process.env.PAYMENT_CREATE_TIMEOUT_MS = '20';
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('redaction: сообщения об ошибках никогда не содержат shopId/secretKey/сырое тело ответа', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ type: 'error', code: 'invalid_credentials', description: 'test_secret_fake_value_never_real leaked in body' }),
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' });
    assert.fail('должно было бросить');
  } catch (err) {
    assert.doesNotMatch(err.message, /test_secret_fake_value_never_real/);
    assert.doesNotMatch(err.message, /test_shop_000000/);
    assert.doesNotMatch(err.message, /leaked in body/);
  }
});

test('context в ошибке содержит только безопасные поля (operation/orderId/httpStatus), не сырой ответ провайдера', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ secret_looking_field: 'should not leak' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.createPayment({ orderId: 99, amount: 300, description: 'd', idempotencyKey: 'k' });
    assert.fail('должно было бросить');
  } catch (err) {
    assert.deepEqual(Object.keys(err.context).sort(), ['httpStatus', 'operation', 'orderId']);
    assert.equal(err.context.orderId, 99);
  }
});

// ===========================================================================
// fix(payments): enforce SBP create payment contract — тесты по находкам
// независимого pre-push review commit 333c951
// ===========================================================================

function fetchShouldNotBeCalled() {
  return async () => { throw new Error('fetch не должен вызываться — валидация должна остановить запрос раньше'); };
}

// --- HIGH: payment_method_data ---------------------------------------------

test('Sandbox: requestBody содержит payment_method_data: { type: "bank_card" } и не пытается использовать СБП', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => sandboxPaymentBody({ id: 'yk_payment_card' }),
    };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' });

  const body = JSON.parse(capturedOptions.body);
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'payment_method_data'), 'payment_method_data должен присутствовать в теле запроса');
  assert.deepEqual(body.payment_method_data, { type: 'bank_card' });
});

// --- MEDIUM: валидация amount -----------------------------------------------

const INVALID_AMOUNTS = [
  ['undefined', undefined],
  ['null', null],
  ['строка вместо числа', '300'],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['ноль', 0],
  ['отрицательное', -100],
  ['дробные копейки (3 знака)', 100.001],
  ['чрезмерно большая сумма (> 700000)', 5000000],
];

for (const [label, amount] of INVALID_AMOUNTS) {
  test(`MEDIUM-исправление: amount отклоняется до fetch — ${label}`, async () => {
    setFakeTestCredentials();
    global.fetch = fetchShouldNotBeCalled();
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.createPayment({ orderId: 1, amount, description: 'd', idempotencyKey: 'k' }),
      (err) => err.name === 'YookassaCreatePaymentError' && err.category === CATEGORIES.FATAL_REQUEST,
    );
  });
}

test('MEDIUM-исправление: корректный amount с двумя знаками (например, 199.99) проходит валидацию и уходит как есть', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => sandboxPaymentBody({ amount: '199.99' }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.createPayment({ orderId: 1, amount: 199.99, description: 'd', idempotencyKey: 'k' });
  assert.equal(JSON.parse(capturedOptions.body).amount.value, '199.99');
});

// --- MEDIUM: валидация idempotencyKey ---------------------------------------

const INVALID_IDEMPOTENCY_KEYS = [
  ['пустая строка', ''],
  ['только пробелы', '   '],
  ['длиннее 64 символов', 'k'.repeat(65)],
  ['управляющий символ (перевод строки — риск header injection)', 'valid-key\nX-Injected: evil'],
  ['управляющий символ NUL', 'valid-key\x00'],
];

for (const [label, key] of INVALID_IDEMPOTENCY_KEYS) {
  test(`MEDIUM-исправление: idempotencyKey отклоняется до fetch — ${label}`, async () => {
    setFakeTestCredentials();
    global.fetch = fetchShouldNotBeCalled();
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: key }),
      (err) => err.name === 'YookassaCreatePaymentError' && err.category === CATEGORIES.FATAL_REQUEST,
    );
  });
}

test('MEDIUM-исправление: валидный idempotencyKey передаётся в заголовке побайтово, без trim/нормализации', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  const KEY = '  idem-key-with-spaces-1  ';
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => sandboxPaymentBody() };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: KEY });
  assert.equal(capturedOptions.headers['Idempotence-Key'], KEY, 'ключ не должен быть изменён/обрезан перед отправкой');
});

// --- MEDIUM: валидация response.status --------------------------------------

const UNEXPECTED_STATUS_RESPONSES = [
  ['canceled', { id: 'x', status: 'canceled', confirmation: { type: 'redirect', confirmation_url: 'https://yookassa.ru/x' } }],
  ['succeeded', { id: 'x', status: 'succeeded', confirmation: { type: 'redirect', confirmation_url: 'https://yookassa.ru/x' } }],
  ['неизвестная строка', { id: 'x', status: 'some_unknown_status', confirmation: { type: 'redirect', confirmation_url: 'https://yookassa.ru/x' } }],
  ['status отсутствует', { id: 'x', confirmation: { type: 'redirect', confirmation_url: 'https://yookassa.ru/x' } }],
];

for (const [label, body] of UNEXPECTED_STATUS_RESPONSES) {
  test(`MEDIUM-исправление: 200 OK с status="${label}" -> ProviderResultUnknownError, не считается успехом`, async () => {
    setFakeTestCredentials();
    global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
    const YookassaProvider = freshProviderClass();
    const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
      (err) => err instanceof ProviderResultUnknownError,
    );
  });
}

test('MEDIUM-исправление: 200 OK со status="pending" (нормальный путь) по-прежнему считается успехом', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sandboxPaymentBody({ id: 'yk_ok', confirmationUrl: 'https://yookassa.ru/checkout/redirect/ok' }),
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' });
  assert.equal(result.providerPaymentId, 'yk_ok');
  assert.equal(result.paymentUrl, 'https://yookassa.ru/checkout/redirect/ok');
});

// --- LOW: confirmation_url протокол ------------------------------------------

test('LOW-усиление: confirmation_url с протоколом javascript: -> ProviderResultUnknownError, не возвращается клиенту', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'x', status: 'pending', confirmation: { type: 'redirect', confirmation_url: 'javascript:alert(1)' } }),
  });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('LOW-усиление: confirmation_url с протоколом http: (не https) -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'x', status: 'pending', confirmation: { type: 'redirect', confirmation_url: 'http://yookassa.ru/checkout/redirect/insecure' } }),
  });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

// --- LOW: YOOKASSA_RETURN_URL валидация --------------------------------------

test('LOW-усиление: YOOKASSA_RETURN_URL невалидный URL -> YookassaConfigurationError, fetch не вызывается', async () => {
  setFakeTestCredentials();
  process.env.YOOKASSA_RETURN_URL = 'не-url-совсем';
  global.fetch = fetchShouldNotBeCalled();
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    /YOOKASSA_RETURN_URL/,
  );
});

test('LOW-усиление: YOOKASSA_RETURN_URL на http запрещён при NODE_ENV=production', async () => {
  setFakeTestCredentials();
  process.env.YOOKASSA_RETURN_URL = 'http://yaam.su/return-test';
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  global.fetch = fetchShouldNotBeCalled();
  try {
    const YookassaProvider = freshProviderClass();
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
      /https/,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

// --- LOW: провайдер-уровневые тесты HTTP 403/409/415 -------------------------

test('LOW-усиление: HTTP 403 -> категория fatal_configuration (провайдер-уровневый regression)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ type: 'error', code: 'forbidden' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.category === CATEGORIES.FATAL_CONFIGURATION,
  );
});

test('LOW-усиление: HTTP 409 -> категория conflict (провайдер-уровневый regression)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ type: 'error', code: 'idempotence_key_duplicate' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.category === CATEGORIES.CONFLICT,
  );
});

test('LOW-усиление: HTTP 415 -> категория fatal_request (провайдер-уровневый regression)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 415, json: async () => ({ type: 'error', code: 'unsupported_media_type' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k' }),
    (err) => err.category === CATEGORIES.FATAL_REQUEST,
  );
});
