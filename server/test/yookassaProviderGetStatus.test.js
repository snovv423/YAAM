// YookassaProvider.getStatus() — юнит-тесты. НЕТ реальных сетевых вызовов:
// global.fetch подменяется на мок в каждом тесте и восстанавливается в конце
// файла. Реальные shopId/secretKey не используются нигде — только заведомо
// фейковые тестовые строки, не похожие на настоящий формат ключей.
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = {
  YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY,
  YOOKASSA_RETURN_URL: process.env.YOOKASSA_RETURN_URL,
  PAYMENT_STATUS_TIMEOUT_MS: process.env.PAYMENT_STATUS_TIMEOUT_MS,
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
  process.env.YOOKASSA_SHOP_ID = 'test_shop_000000';
  process.env.YOOKASSA_SECRET_KEY = 'test_secret_fake_value_never_real';
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

// --- построение запроса ------------------------------------------------------

test('getStatus() строит корректный GET-запрос: URL с id, Basic Auth, без тела/Idempotence-Key', async () => {
  setFakeTestCredentials();
  let capturedUrl, capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => ({ id: 'yk_payment_1', status: 'pending' }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.getStatus('yk_payment_1');

  assert.equal(capturedUrl, 'https://api.yookassa.ru/v3/payments/yk_payment_1');
  assert.equal(capturedOptions.method, 'GET');
  const expectedAuth = 'Basic ' + Buffer.from('test_shop_000000:test_secret_fake_value_never_real').toString('base64');
  assert.equal(capturedOptions.headers.Authorization, expectedAuth);
  assert.equal(capturedOptions.body, undefined, 'GET не должен иметь тело');
  assert.equal(capturedOptions.headers['Idempotence-Key'], undefined, 'GET не требует Idempotence-Key (только POST/DELETE)');
  assert.equal(capturedOptions.headers['Content-Type'], undefined, 'GET без тела не должен слать Content-Type');
});

test('getStatus() URL-кодирует providerPaymentId (защита от неожиданных символов в пути)', async () => {
  setFakeTestCredentials();
  let capturedUrl;
  global.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: 'x', status: 'pending' }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.getStatus('id with space/slash');
  assert.equal(capturedUrl, 'https://api.yookassa.ru/v3/payments/id%20with%20space%2Fslash');
});

// --- локальная валидация providerPaymentId -----------------------------------

const INVALID_PROVIDER_PAYMENT_IDS = [
  ['undefined', undefined],
  ['null', null],
  ['число вместо строки', 12345],
  ['пустая строка', ''],
  ['только пробелы', '   '],
];

for (const [label, id] of INVALID_PROVIDER_PAYMENT_IDS) {
  test(`getStatus(): providerPaymentId отклоняется до fetch — ${label}`, async () => {
    setFakeTestCredentials();
    global.fetch = fetchShouldNotBeCalled();
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.getStatus(id),
      (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.FATAL_REQUEST,
    );
  });
}

// --- нормализация официальных статусов ---------------------------------------

test('getStatus(): status="pending" -> "pending"', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x', status: 'pending' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getStatus('x'), 'pending');
});

test('getStatus(): status="waiting_for_capture" -> "pending" (ещё не финальный успех)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x', status: 'waiting_for_capture' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getStatus('x'), 'pending');
});

test('getStatus(): status="succeeded" -> "succeeded"', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x', status: 'succeeded' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.equal(await provider.getStatus('x'), 'succeeded');
});

const CANCELLATION_REASONS = ['fraud_suspected', 'expired_on_confirmation', 'insufficient_funds', 'canceled_by_merchant'];
for (const reason of CANCELLATION_REASONS) {
  test(`getStatus(): status="canceled" (reason=${reason}) -> "failed" (независимо от конкретной причины отмены)`, async () => {
    setFakeTestCredentials();
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', status: 'canceled', cancellation_details: { party: 'yoo_money', reason } }),
    });
    const YookassaProvider = freshProviderClass();
    const provider = new YookassaProvider();
    assert.equal(await provider.getStatus('x'), 'failed');
  });
}

// --- неизвестный/будущий статус -> fail-safe, не угадываем -------------------

test('getStatus(): неизвестный/будущий provider-статус -> ProviderResultUnknownError (не угадывается как succeeded/failed)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x', status: 'refunded_by_some_future_api_version' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getStatus('x'), (err) => err instanceof ProviderResultUnknownError);
});

// --- форма ответа --------------------------------------------------------------

test('getStatus(): 200 OK с пустым id -> ProviderResultUnknownError (не typeof==="string", а непустая строка)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: '', status: 'pending' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getStatus('x'), (err) => err instanceof ProviderResultUnknownError);
});

test('getStatus(): 200 OK без поля status -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getStatus('x'), (err) => err instanceof ProviderResultUnknownError);
});

test('getStatus(): malformed JSON-ответ -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.getStatus('x'), (err) => err instanceof ProviderResultUnknownError);
});

// --- HTTP-коды: официальная классификация -------------------------------------

test('getStatus(): HTTP 404 (code=not_found) -> категория not_found, НЕ нормализованный статус "failed" (см. research)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ type: 'error', code: 'not_found' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.NOT_FOUND,
  );
});

test('getStatus(): HTTP 401 -> категория fatal_configuration', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ type: 'error', code: 'invalid_credentials' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.FATAL_CONFIGURATION,
  );
});

test('getStatus(): HTTP 400 -> категория fatal_request', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ type: 'error', code: 'invalid_request' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.FATAL_REQUEST,
  );
});

test('getStatus(): HTTP 429 -> категория rate_limited', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ type: 'error', code: 'too_many_requests' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.RATE_LIMITED,
  );
});

// --- ключевое отличие от createPayment(): GET некритичен к транспортной неопределённости ---

test('getStatus(): HTTP 500 -> RETRYABLE (НЕ UNKNOWN_RESULT — GET не мутирует, в отличие от createPayment)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ type: 'error', code: 'internal_server_error' }) });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.RETRYABLE,
  );
});

test('getStatus(): сетевая ошибка -> RETRYABLE (НЕ UNKNOWN_RESULT)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { throw new TypeError('fetch failed: ECONNRESET'); };
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.RETRYABLE,
  );
});

test('getStatus(): таймаут (AbortController) -> RETRYABLE, не бросает сырой AbortError наружу', async () => {
  setFakeTestCredentials();
  process.env.PAYMENT_STATUS_TIMEOUT_MS = '20';
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.getStatus('x'),
    (err) => err.name === 'YookassaGetStatusError' && err.category === CATEGORIES.RETRYABLE,
  );
});

// --- redaction и безопасность context -----------------------------------------

test('getStatus(): redaction — сообщения об ошибках никогда не содержат shopId/secretKey', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ type: 'error', code: 'invalid_credentials', description: 'test_secret_fake_value_never_real leaked' }),
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.getStatus('x');
    assert.fail('должно было бросить');
  } catch (err) {
    assert.doesNotMatch(err.message, /test_secret_fake_value_never_real/);
    assert.doesNotMatch(err.message, /test_shop_000000/);
    assert.doesNotMatch(err.message, /leaked/);
  }
});

test('getStatus(): context в ошибке содержит только безопасные поля (operation/providerPaymentId/httpStatus)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ secret_looking_field: 'should not leak' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.getStatus('yk_payment_99');
    assert.fail('должно было бросить');
  } catch (err) {
    assert.deepEqual(Object.keys(err.context).sort(), ['httpStatus', 'operation', 'providerPaymentId']);
    assert.equal(err.context.providerPaymentId, 'yk_payment_99');
  }
});
