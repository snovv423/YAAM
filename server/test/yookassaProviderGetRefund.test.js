// YookassaProvider.getRefund() — юнит-тесты. НЕТ реальных сетевых вызовов:
// global.fetch подменяется на мок в каждом тесте и восстанавливается в конце
// файла. Реальные shopId/secretKey не используются нигде — только заведомо
// фейковые тестовые строки.
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = {
  YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY,
  YOOKASSA_ENV: process.env.YOOKASSA_ENV,
  PAYMENT_GET_REFUND_TIMEOUT_MS: process.env.PAYMENT_GET_REFUND_TIMEOUT_MS,
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
  process.env.YOOKASSA_SHOP_ID = '999999';
  process.env.YOOKASSA_SECRET_KEY = 'test_secret_fake_value_never_real';
  process.env.YOOKASSA_ENV = 'sandbox';
}

beforeEach(() => {
  restoreEnv();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function fetchShouldNotBeCalled() {
  return async () => { throw new Error('fetch не должен вызываться — валидация должна остановить запрос раньше'); };
}

const REFUND_ID = 'yk_refund_abc123';

function validBody(overrides = {}) {
  return {
    id: REFUND_ID,
    status: 'succeeded',
    payment_id: 'yk_payment_xyz789',
    amount: { value: '300.00', currency: 'RUB' },
    ...overrides,
  };
}

// --- построение запроса ------------------------------------------------------

test('getRefund(): корректный GET-запрос — endpoint, метод, Basic Auth, без тела, без Idempotence-Key', async () => {
  setFakeTestCredentials();
  let capturedUrl, capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => validBody() };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.getRefund(REFUND_ID);

  assert.equal(capturedUrl, `https://api.yookassa.ru/v3/refunds/${REFUND_ID}`);
  assert.equal(capturedOptions.method, 'GET');
  const expectedAuth = 'Basic ' + Buffer.from('999999:test_secret_fake_value_never_real').toString('base64');
  assert.equal(capturedOptions.headers.Authorization, expectedAuth);
  assert.equal(capturedOptions.body, undefined, 'GET не должен иметь тело');
  assert.equal(capturedOptions.headers['Idempotence-Key'], undefined, 'GET не требует Idempotence-Key');
  assert.equal(capturedOptions.headers['Content-Type'], undefined, 'GET без тела не должен слать Content-Type');
});

test('getRefund(): URL-кодирует providerRefundId (защита от неожиданных символов в пути)', async () => {
  setFakeTestCredentials();
  let capturedUrl;
  global.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, json: async () => validBody({ id: 'id with space/slash' }) }; };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.getRefund('id with space/slash');
  assert.equal(capturedUrl, 'https://api.yookassa.ru/v3/refunds/id%20with%20space%2Fslash');
});

// --- локальная валидация providerRefundId ------------------------------------

const INVALID_REFUND_IDS = [
  ['undefined', undefined],
  ['null', null],
  ['пустая строка', ''],
  ['только пробелы', '   '],
];

for (const [label, id] of INVALID_REFUND_IDS) {
  test(`getRefund(): providerRefundId отклоняется до fetch — ${label}`, async () => {
    setFakeTestCredentials();
    global.fetch = fetchShouldNotBeCalled();
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.getRefund(id),
      (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES.FATAL_REQUEST,
    );
  });
}

// --- нормализация официальных статусов (включая pending — см. находку review) ---

test('getRefund(): status="pending" -> "pending" (официально подтверждено OpenAPI-спецификацией ЮKassa)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ status: 'pending' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getRefund(REFUND_ID), 'pending');
});

test('getRefund(): status="succeeded" -> "succeeded"', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ status: 'succeeded' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getRefund(REFUND_ID), 'succeeded');
});

test('getRefund(): status="canceled" -> "failed"', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ status: 'canceled' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getRefund(REFUND_ID), 'failed');
});

test('getRefund(): status="canceled" с cancellation_details.reason="insufficient_funds" -> "failed"', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ status: 'canceled', cancellation_details: { party: 'yoo_money', reason: 'insufficient_funds' } }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getRefund(REFUND_ID), 'failed');
});

test('getRefund(): неизвестный/будущий status -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ status: 'some_future_status' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

// --- response validation: форма и identity -----------------------------------

test('getRefund(): пустой объект {} -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): malformed JSON-ответ -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): null вместо тела -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => null });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): массив вместо тела -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [1, 2, 3] });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): refund.id ОТЛИЧАЕТСЯ от запрошенного providerRefundId -> ProviderResultUnknownError (identity, default idField="id")', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ id: 'yk_refund_DIFFERENT' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getRefund(REFUND_ID),
    (err) => err instanceof ProviderResultUnknownError
      && err.context.requestedId === REFUND_ID
      && err.context.receivedId === 'yk_refund_DIFFERENT',
  );
});

test('getRefund(): response без id -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ id: undefined }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): response без payment_id -> ProviderResultUnknownError (обязательное поле схемы Refund)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ payment_id: undefined }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): response с пустым payment_id -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ payment_id: '' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): response без amount -> ProviderResultUnknownError (обязательное поле схемы Refund)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ amount: undefined }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): amount.value не строка -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ amount: { value: 300, currency: 'RUB' } }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

test('getRefund(): orchestration-сверка отклоняет чужой payment_id или amount', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody() });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();

  await assert.rejects(
    () => provider.getRefund(REFUND_ID, { providerPaymentId: 'another_payment', amount: 300 }),
    (err) => err instanceof ProviderResultUnknownError
  );
  await assert.rejects(
    () => provider.getRefund(REFUND_ID, { providerPaymentId: 'yk_payment_xyz789', amount: 999 }),
    (err) => err instanceof ProviderResultUnknownError
  );
});

test('getRefund(): response без status -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ status: undefined }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getRefund(REFUND_ID), (err) => err instanceof ProviderResultUnknownError);
});

// --- HTTP-коды: официальная классификация (read-only операция) --------------

const HTTP_CODE_CASES = [
  [401, 'FATAL_CONFIGURATION'],
  [403, 'FATAL_CONFIGURATION'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [429, 'RATE_LIMITED'],
];

for (const [status, categoryName] of HTTP_CODE_CASES) {
  test(`getRefund(): HTTP ${status} -> категория ${categoryName}`, async () => {
    setFakeTestCredentials();
    global.fetch = async () => ({ ok: false, status, json: async () => ({ type: 'error', code: 'x' }) });
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.getRefund(REFUND_ID),
      (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES[categoryName],
    );
  });
}

test('getRefund(): HTTP 500 (read-only операция) -> RETRYABLE, НЕ UNKNOWN_RESULT (в отличие от refund()/createPayment())', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ type: 'error', code: 'internal_server_error' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getRefund(REFUND_ID),
    (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES.RETRYABLE,
  );
});

// --- транспортные сбои: RETRYABLE (read-only операция) -----------------------

test('getRefund(): таймаут (AbortController) -> RETRYABLE, не бросает сырой AbortError', async () => {
  setFakeTestCredentials();
  process.env.PAYMENT_GET_REFUND_TIMEOUT_MS = '20';
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const err = new Error('aborted'); err.name = 'AbortError'; reject(err); });
  });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getRefund(REFUND_ID),
    (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES.RETRYABLE,
  );
});

test('getRefund(): ECONNRESET -> RETRYABLE', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { const e = new Error('connect ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getRefund(REFUND_ID),
    (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES.RETRYABLE,
  );
});

test('getRefund(): DNS failure (ENOTFOUND) -> RETRYABLE', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getRefund(REFUND_ID),
    (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES.RETRYABLE,
  );
});

test('getRefund(): TLS failure (CERT_HAS_EXPIRED) -> RETRYABLE', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'CERT_HAS_EXPIRED' }; throw e; };
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getRefund(REFUND_ID),
    (err) => err.name === 'YookassaGetRefundError' && err.category === CATEGORIES.RETRYABLE,
  );
});

// --- security/redaction --------------------------------------------------------

test('getRefund(): redaction — секреты не текут в Error.message', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ type: 'error', code: 'invalid_credentials', description: 'test_secret_fake_value_never_real leaked' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.getRefund(REFUND_ID);
    assert.fail('должно было бросить');
  } catch (err) {
    assert.doesNotMatch(err.message, /test_secret_fake_value_never_real/);
    assert.doesNotMatch(err.message, /test_shop_000000/);
    assert.doesNotMatch(err.message, /leaked/);
  }
});

test('getRefund(): context в ошибке содержит только безопасные поля (operation/providerRefundId/httpStatus)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ secret_looking_field: 'should not leak' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.getRefund(REFUND_ID);
    assert.fail('должно было бросить');
  } catch (err) {
    assert.deepEqual(Object.keys(err.context).sort(), ['httpStatus', 'operation', 'providerRefundId']);
    assert.equal(err.context.providerRefundId, REFUND_ID);
  }
});

test('getRefund(): лишние ПДн-подобные поля (metadata) не пробрасываются — нормализованный результат bare-строка', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => validBody({ metadata: { customer_email: 'someone@example.com' } }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.getRefund(REFUND_ID);
  assert.equal(typeof result, 'string');
  assert.equal(result, 'succeeded');
});

// --- unhandled rejection --------------------------------------------------------

test('getRefund(): после timeout нет unhandledRejection', async () => {
  setFakeTestCredentials();
  process.env.PAYMENT_GET_REFUND_TIMEOUT_MS = '20';
  let unhandled = false;
  const handler = () => { unhandled = true; };
  process.on('unhandledRejection', handler);
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const err = new Error('aborted'); err.name = 'AbortError'; reject(err); });
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try { await provider.getRefund(REFUND_ID); } catch { /* expected */ }
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', handler);
  assert.equal(unhandled, false);
  delete process.env.PAYMENT_GET_REFUND_TIMEOUT_MS;
});

// --- regression sanity: createPayment/getStatus/refund не сломаны ------------

test('regression sanity: createPayment/getStatus/refund продолжают работать корректно рядом с getRefund()', async () => {
  setFakeTestCredentials();
  process.env.YOOKASSA_RETURN_URL = 'https://yaam.su/return-test';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/refunds/')) return { ok: true, status: 200, json: async () => validBody() };
    if (u.endsWith('/refunds')) return { ok: true, status: 200, json: async () => ({ id: 'r_new', status: 'succeeded', payment_id: 'p1', amount: { value: '300.00', currency: 'RUB' } }) };
    if (u.includes('/payments/')) return { ok: true, status: 200, json: async () => ({ id: 'p1', status: 'pending', test: true, amount: { value: '10.00', currency: 'RUB' } }) };
    return { ok: true, status: 200, json: async () => ({ id: 'p2', status: 'pending', test: true, amount: { value: '300.00', currency: 'RUB' }, confirmation: { type: 'redirect', confirmation_url: 'https://y/x' } }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const created = await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k1' });
  assert.equal(created.providerPaymentId, 'p2');
  assert.equal(await provider.getStatus('p1'), 'pending');
  const refundResult = await provider.refund('p1', 300, 'k2');
  assert.equal(refundResult.status, 'succeeded');
  assert.equal(await provider.getRefund(REFUND_ID), 'succeeded');
});
