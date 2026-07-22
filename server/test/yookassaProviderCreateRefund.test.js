// YookassaProvider.refund() ("createRefund" в терминологии задачи — фактический
// метод интерфейса называется refund(), см. providerInterface.js) —
// юнит-тесты. НЕТ реальных сетевых вызовов: global.fetch подменяется на мок в
// каждом тесте и восстанавливается в конце файла. Реальные shopId/secretKey
// не используются нигде — только заведомо фейковые тестовые строки.
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = {
  YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY,
  YOOKASSA_ENV: process.env.YOOKASSA_ENV,
  YOOKASSA_RETURN_URL: process.env.YOOKASSA_RETURN_URL,
  PAYMENT_REFUND_TIMEOUT_MS: process.env.PAYMENT_REFUND_TIMEOUT_MS,
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

function mockOk(body, status = 200) {
  return async () => ({ ok: true, status, json: async () => body });
}

const PAY_ID = 'yk_payment_abc123';

function validRefundBody(overrides = {}) {
  return {
    id: 'yk_refund_xyz789',
    status: 'succeeded',
    payment_id: PAY_ID,
    amount: { value: '300.00', currency: 'RUB' },
    ...overrides,
  };
}

// --- построение запроса ------------------------------------------------------

test('refund(): правильный endpoint, POST, Basic Auth, Content-Type, Idempotence-Key', async () => {
  setFakeTestCredentials();
  let capturedUrl, capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => validRefundBody() };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.refund(PAY_ID, 300, 'refund-idem-key-1');

  assert.equal(capturedUrl, 'https://api.yookassa.ru/v3/refunds');
  assert.equal(capturedOptions.method, 'POST');
  const expectedAuth = 'Basic ' + Buffer.from('999999:test_secret_fake_value_never_real').toString('base64');
  assert.equal(capturedOptions.headers.Authorization, expectedAuth);
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.equal(capturedOptions.headers['Idempotence-Key'], 'refund-idem-key-1');
});

test('refund(): фактическое JSON-тело содержит ТОЛЬКО payment_id и amount (никаких неподтверждённых полей)', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => validRefundBody() };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.refund(PAY_ID, 300, 'k');

  const body = JSON.parse(capturedOptions.body);
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'payment_id']);
  assert.equal(body.payment_id, PAY_ID);
  assert.deepEqual(body.amount, { value: '300.00', currency: 'RUB' });
});

test('refund(): amount.value форматируется ровно с двумя знаками после запятой', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => validRefundBody({ amount: { value: '199.90', currency: 'RUB' } }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.refund(PAY_ID, 199.9, 'k');
  assert.equal(JSON.parse(capturedOptions.body).amount.value, '199.90');
});

// --- валидные ответы: succeeded / canceled / (не)валидный pending -----------

test('refund(): status="succeeded" -> {refundId, status:"succeeded"}', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ status: 'succeeded' }));
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.refund(PAY_ID, 300, 'k');
  assert.deepEqual(result, { refundId: 'yk_refund_xyz789', status: 'succeeded' });
});

test('refund(): status="canceled" -> {refundId, status:"failed"} (маппинг терминального статуса)', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ status: 'canceled' }));
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.refund(PAY_ID, 300, 'k');
  assert.deepEqual(result, { refundId: 'yk_refund_xyz789', status: 'failed' });
});

test('refund(): status="canceled" с cancellation_details.reason="insufficient_funds" -> "failed" (не HTTP-ошибка, обычный canceled-исход)', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ status: 'canceled', cancellation_details: { party: 'yoo_money', reason: 'insufficient_funds' } }));
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.refund(PAY_ID, 300, 'k');
  assert.equal(result.status, 'failed');
});

test('refund(): status="pending" сохраняет refundId для последующей GET-сверки', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ status: 'pending' }));
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  assert.deepEqual(
    await provider.refund(PAY_ID, 300, 'k'),
    { refundId: 'yk_refund_xyz789', status: 'pending' }
  );
});

test('refund(): неизвестный/будущий status ("waiting_for_capture", payment-специфичный) -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ status: 'waiting_for_capture' }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

// --- response validation: форма и identity -----------------------------------

test('refund(): отсутствующий refund.id -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ id: undefined }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): пустой refund.id -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ id: '' }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): отсутствующий payment_id -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ payment_id: undefined }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): payment_id MISMATCH (ответ про чужой платёж) -> ProviderResultUnknownError, requestedId/receivedId в context', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ payment_id: 'yk_payment_DIFFERENT' }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.refund(PAY_ID, 300, 'k'),
    (err) => err instanceof ProviderResultUnknownError
      && err.context.requestedId === PAY_ID
      && err.context.receivedId === 'yk_payment_DIFFERENT',
  );
});

test('refund(): отсутствующий amount в ответе -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ amount: undefined }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): amount MISMATCH (ответ про другую сумму) -> ProviderResultUnknownError (best-effort defense-in-depth)', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ amount: { value: '999.00', currency: 'RUB' } }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): неправильная currency (USD вместо RUB) -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({ amount: { value: '300.00', currency: 'USD' } }));
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): malformed JSON-ответ -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): пустое тело {} -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk({});
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): null вместо тела -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(null);
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): массив вместо тела -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk([1, 2, 3]);
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

// --- HTTP-коды: официальная классификация (мутирующая операция) --------------

const HTTP_CODE_CASES = [
  [400, 'FATAL_REQUEST'],
  [401, 'FATAL_CONFIGURATION'],
  [403, 'FATAL_CONFIGURATION'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [415, 'FATAL_REQUEST'],
  [429, 'RATE_LIMITED'],
];

for (const [status, categoryName] of HTTP_CODE_CASES) {
  test(`refund(): HTTP ${status} -> категория ${categoryName}`, async () => {
    setFakeTestCredentials();
    global.fetch = async () => ({ ok: false, status, json: async () => ({ type: 'error', code: 'x' }) });
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.refund(PAY_ID, 300, 'k'),
      (err) => err.name === 'YookassaRefundError' && err.category === CATEGORIES[categoryName],
    );
  });
}

test('refund(): HTTP 500 (мутирующая операция) -> UNKNOWN_RESULT, НЕ RETRYABLE напрямую (в отличие от getStatus)', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ type: 'error', code: 'internal_server_error' }) });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): HTTP 502 с HTML-телом (не JSON) -> ProviderResultUnknownError', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

// --- транспортные сбои: всегда UNKNOWN_RESULT (мутирующая операция) ----------

test('refund(): timeout (AbortController) -> UNKNOWN_RESULT, не бросает сырой AbortError', async () => {
  setFakeTestCredentials();
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '20';
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  });
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): ECONNRESET -> UNKNOWN_RESULT', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { const e = new Error('connect ECONNRESET'); e.code = 'ECONNRESET'; throw e; };
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): DNS failure (ENOTFOUND) -> UNKNOWN_RESULT', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

test('refund(): TLS failure (CERT_HAS_EXPIRED) -> UNKNOWN_RESULT', async () => {
  setFakeTestCredentials();
  global.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'CERT_HAS_EXPIRED' }; throw e; };
  const YookassaProvider = freshProviderClass();
  const { ProviderResultUnknownError } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, 300, 'k'), (err) => err instanceof ProviderResultUnknownError);
});

// --- локальная валидация providerPaymentId -----------------------------------

const INVALID_PROVIDER_PAYMENT_IDS = [
  ['undefined', undefined],
  ['null', null],
  ['пустая строка', ''],
  ['только пробелы', '   '],
];

for (const [label, id] of INVALID_PROVIDER_PAYMENT_IDS) {
  test(`refund(): providerPaymentId отклоняется до fetch — ${label}`, async () => {
    setFakeTestCredentials();
    global.fetch = fetchShouldNotBeCalled();
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.refund(id, 300, 'k'),
      (err) => err.name === 'YookassaRefundError' && err.category === CATEGORIES.FATAL_REQUEST,
    );
  });
}

// --- локальная валидация amount -----------------------------------------------

const INVALID_AMOUNTS = [
  ['undefined', undefined],
  ['null', null],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['ноль', 0],
  ['отрицательное', -100],
  ['дробные копейки (3 знака)', 100.001],
  ['сумма выше локального YAAM-лимита (> 700000)', 5000000],
];

for (const [label, amount] of INVALID_AMOUNTS) {
  test(`refund(): amount отклоняется до fetch — ${label}`, async () => {
    setFakeTestCredentials();
    global.fetch = fetchShouldNotBeCalled();
    const YookassaProvider = freshProviderClass();
    const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
    const provider = new YookassaProvider();
    await assert.rejects(
      () => provider.refund(PAY_ID, amount, 'k'),
      (err) => err.name === 'YookassaRefundError' && err.category === CATEGORIES.FATAL_REQUEST,
    );
  });
}

// --- локальная валидация idempotencyKey ---------------------------------------

test('refund(): пустой idempotencyKey отклоняется до fetch', async () => {
  setFakeTestCredentials();
  global.fetch = fetchShouldNotBeCalled();
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.refund(PAY_ID, 300, ''),
    (err) => err.name === 'YookassaRefundError' && err.category === CATEGORIES.FATAL_REQUEST,
  );
});

test('refund(): idempotencyKey длиной ровно 64 символа проходит', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  const KEY64 = 'k'.repeat(64);
  global.fetch = async (url, options) => { capturedOptions = options; return { ok: true, status: 200, json: async () => validRefundBody() }; };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.refund(PAY_ID, 300, KEY64);
  assert.equal(capturedOptions.headers['Idempotence-Key'], KEY64);
});

test('refund(): idempotencyKey длиной 65 символов отклоняется до fetch', async () => {
  setFakeTestCredentials();
  global.fetch = fetchShouldNotBeCalled();
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.refund(PAY_ID, 300, 'k'.repeat(65)),
    (err) => err.name === 'YookassaRefundError' && err.category === CATEGORIES.FATAL_REQUEST,
  );
});

test('refund(): idempotencyKey с CRLF/NUL отклоняется до fetch', async () => {
  setFakeTestCredentials();
  global.fetch = fetchShouldNotBeCalled();
  const YookassaProvider = freshProviderClass();
  const { CATEGORIES } = require('../services/paymentProviders/providerErrorTaxonomy');
  const provider = new YookassaProvider();
  await assert.rejects(
    () => provider.refund(PAY_ID, 300, 'valid\r\nX-Injected: evil\x00'),
    (err) => err.name === 'YookassaRefundError' && err.category === CATEGORIES.FATAL_REQUEST,
  );
});

test('refund(): валидный idempotencyKey передаётся в заголовке побайтово, без изменений', async () => {
  setFakeTestCredentials();
  let capturedOptions;
  const KEY = '  refund-key-with-spaces-1  ';
  global.fetch = async (url, options) => { capturedOptions = options; return { ok: true, status: 200, json: async () => validRefundBody() }; };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.refund(PAY_ID, 300, KEY);
  assert.equal(capturedOptions.headers['Idempotence-Key'], KEY);
});

// --- security/redaction --------------------------------------------------------

test('refund(): redaction — секреты/идентификаторы не текут в Error.message', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({
    ok: false, status: 401,
    json: async () => ({ type: 'error', code: 'invalid_credentials', description: 'test_secret_fake_value_never_real leaked' }),
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.refund(PAY_ID, 300, 'k');
    assert.fail('должно было бросить');
  } catch (err) {
    assert.doesNotMatch(err.message, /test_secret_fake_value_never_real/);
    assert.doesNotMatch(err.message, /test_shop_000000/);
    assert.doesNotMatch(err.message, /leaked/);
  }
});

test('refund(): context в ошибке содержит только безопасные поля (operation/providerPaymentId/httpStatus), не сырой response', async () => {
  setFakeTestCredentials();
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ secret_looking_field: 'should not leak' }) });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try {
    await provider.refund(PAY_ID, 300, 'k');
    assert.fail('должно было бросить');
  } catch (err) {
    assert.deepEqual(Object.keys(err.context).sort(), ['httpStatus', 'operation', 'providerPaymentId']);
    assert.equal(err.context.providerPaymentId, PAY_ID);
  }
});

test('refund(): raw provider response (например metadata с ПДн-подобными полями) не пробрасывается в нормализованный результат', async () => {
  setFakeTestCredentials();
  global.fetch = mockOk(validRefundBody({
    metadata: { customer_email: 'someone@example.com', customer_phone: '+79990000000' },
    refund_authorization_details: { rrn: '603668680243' },
  }));
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const result = await provider.refund(PAY_ID, 300, 'k');
  assert.deepEqual(Object.keys(result).sort(), ['refundId', 'status']);
});

// --- fetch не вызывается для локально невалидных входов -----------------------

test('refund(): комбинация невалидного amount и невалидного idempotencyKey — fetch всё равно не вызывается', async () => {
  setFakeTestCredentials();
  global.fetch = fetchShouldNotBeCalled();
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await assert.rejects(() => provider.refund(PAY_ID, -1, ''));
});

// --- unhandled rejection после timeout -----------------------------------------

test('refund(): после timeout нет unhandledRejection', async () => {
  setFakeTestCredentials();
  process.env.PAYMENT_REFUND_TIMEOUT_MS = '20';
  let unhandled = false;
  const handler = () => { unhandled = true; };
  process.on('unhandledRejection', handler);
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  });
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  try { await provider.refund(PAY_ID, 300, 'k'); } catch { /* expected */ }
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', handler);
  assert.equal(unhandled, false);
  delete process.env.PAYMENT_REFUND_TIMEOUT_MS;
});

// --- детерминизм повторного вызова с тем же key --------------------------------

test('refund(): повторный вызов с тем же providerPaymentId/amount/idempotencyKey формирует идентичный запрос (детерминизм на стороне provider; дедупликация — ответственность вызывающего кода/ЮKassa, не provider)', async () => {
  setFakeTestCredentials();
  const capturedRequests = [];
  global.fetch = async (url, options) => {
    capturedRequests.push({ url, body: options.body, idem: options.headers['Idempotence-Key'] });
    return { ok: true, status: 200, json: async () => validRefundBody() };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  await provider.refund(PAY_ID, 300, 'stable-key');
  await provider.refund(PAY_ID, 300, 'stable-key');
  assert.equal(capturedRequests.length, 2, 'provider не дедуплицирует сам — это уже сделано на уровне durable idempotency key выше по стеку/на стороне ЮKassa');
  assert.deepEqual(capturedRequests[0], capturedRequests[1]);
});

// --- regression sanity: createPayment/getStatus/identity-helper не сломаны ----
// (полное подтверждение — отдельным прогоном соответствующих test-файлов и
// providerErrorTaxonomy.test.js в рамках Этапа 11 регрессии; здесь только
// быстрая проверка, что модуль в целом грузится и старые методы по-прежнему
// доступны и корректно ведут себя рядом с новым refund()).
test('regression sanity: createPayment/getStatus продолжают работать корректно в одном модуле с refund()', async () => {
  setFakeTestCredentials();
  process.env.YOOKASSA_RETURN_URL = 'https://yaam.su/return-test';
  global.fetch = async (url) => {
    if (String(url).includes('/refunds')) return { ok: true, status: 200, json: async () => validRefundBody() };
    if (String(url).includes('/payments/')) return { ok: true, status: 200, json: async () => ({ id: 'p1', status: 'pending', test: true, amount: { value: '10.00', currency: 'RUB' } }) };
    return { ok: true, status: 200, json: async () => ({ id: 'p2', status: 'pending', test: true, amount: { value: '300.00', currency: 'RUB' }, confirmation: { type: 'redirect', confirmation_url: 'https://y/x' } }) };
  };
  const YookassaProvider = freshProviderClass();
  const provider = new YookassaProvider();
  const created = await provider.createPayment({ orderId: 1, amount: 300, description: 'd', idempotencyKey: 'k1' });
  assert.equal(created.providerPaymentId, 'p2');
  const status = await provider.getStatus('p1');
  assert.equal(status, 'pending');
  const refund = await provider.refund(PAY_ID, 300, 'k2');
  assert.equal(refund.status, 'succeeded');
});
