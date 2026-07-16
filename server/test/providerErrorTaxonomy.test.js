// Provider Error Taxonomy — юнит-тесты чистого классификатора (без сети, без
// БД, без orderService). Не подключено к runtime заказов/платежей/возвратов
// в этой задаче — см. комментарий в начале providerErrorTaxonomy.js.
//
// Сценарии пронумерованы как в Этапе 5 YAAM-Yookassa-Provider-Error-Taxonomy-
// Research.pdf, где это применимо к чистой HTTP-классификации (сценарии,
// требующие БД/orderService/двух процессов — 6, 7, 18-22 — сознательно не
// дублируются здесь, они уже покрыты существующими тестами конкурентности).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CATEGORIES,
  CATEGORY_RULES,
  classifyProviderError,
  ProviderResultUnknownError,
  assertMatchingProviderObject,
} = require('../services/paymentProviders/providerErrorTaxonomy');

test('CATEGORIES: ровно 9 значений, каждое имеет запись в CATEGORY_RULES', () => {
  const values = Object.values(CATEGORIES);
  assert.equal(values.length, 9);
  assert.equal(new Set(values).size, 9, 'значения не должны повторяться');
  for (const category of values) {
    assert.ok(CATEGORY_RULES[category], `нет правил для категории ${category}`);
  }
});

test('CATEGORIES и CATEGORY_RULES заморожены (Object.freeze)', () => {
  assert.equal(Object.isFrozen(CATEGORIES), true);
  assert.equal(Object.isFrozen(CATEGORY_RULES), true);
  assert.equal(Object.isFrozen(CATEGORY_RULES[CATEGORIES.RETRYABLE]), true);
  // CommonJS-модуль не в strict mode — присвоение свойству замороженного
  // объекта молча не выполняется (а не бросает TypeError); проверяем именно
  // это фактическое поведение, а не строгий режим, которого здесь нет.
  CATEGORIES.NEW = 'x';
  assert.equal('NEW' in CATEGORIES, false);
  CATEGORY_RULES[CATEGORIES.RETRYABLE].retryable = false;
  assert.equal(CATEGORY_RULES[CATEGORIES.RETRYABLE].retryable, true);
});

// --- Сценарий 1: createPayment timeout ---
test('сценарий 1: createPayment timeout -> UNKNOWN_RESULT (мутирующая операция, исход неизвестен)', () => {
  const category = classifyProviderError({ isTimeout: true, isMutatingOperation: true });
  assert.equal(category, CATEGORIES.UNKNOWN_RESULT);
  assert.equal(CATEGORY_RULES[category].needsGetBeforeRetry, true);
  assert.equal(CATEGORY_RULES[category].sameIdempotencyKey, true);
});

// --- Сценарий 2: createPayment 500 ---
test('сценарий 2: createPayment 500 -> UNKNOWN_RESULT', () => {
  const category = classifyProviderError({ httpStatus: 500, isMutatingOperation: true });
  assert.equal(category, CATEGORIES.UNKNOWN_RESULT);
});

// --- Сценарий 3: createPayment 400 ---
test('сценарий 3: createPayment 400 (наш payload) -> FATAL_REQUEST, новый ключ при повторе', () => {
  const category = classifyProviderError({ httpStatus: 400, isMutatingOperation: true });
  assert.equal(category, CATEGORIES.FATAL_REQUEST);
  assert.equal(CATEGORY_RULES[category].retryable, false);
  assert.equal(CATEGORY_RULES[category].sameIdempotencyKey, false, 'FATAL_REQUEST требует НОВЫЙ ключ при повторе (см. Stripe idempotency_error)');
});

// --- Сценарий 4: createPayment 401 ---
test('сценарий 4: createPayment 401 (ключ) -> FATAL_CONFIGURATION, требует manual review', () => {
  const category = classifyProviderError({ httpStatus: 401, isMutatingOperation: true });
  assert.equal(category, CATEGORIES.FATAL_CONFIGURATION);
  assert.equal(CATEGORY_RULES[category].needsManualReview, true);
  assert.equal(CATEGORY_RULES[category].retryable, false);
});

test('403 (forbidden) тоже классифицируется как FATAL_CONFIGURATION', () => {
  assert.equal(classifyProviderError({ httpStatus: 403 }), CATEGORIES.FATAL_CONFIGURATION);
});

// --- Сценарий 5: createPayment 429 ---
test('сценарий 5: createPayment 429 -> RATE_LIMITED', () => {
  const category = classifyProviderError({ httpStatus: 429, isMutatingOperation: true });
  assert.equal(category, CATEGORIES.RATE_LIMITED);
  assert.equal(CATEGORY_RULES[category].retryable, true);
});

// --- Сценарий 8: getPayment 404 сразу после потерянного ответа ---
test('сценарий 8: getPayment 404 -> NOT_FOUND, требует reconciliation', () => {
  const category = classifyProviderError({ httpStatus: 404, isMutatingOperation: false });
  assert.equal(category, CATEGORIES.NOT_FOUND);
  assert.equal(CATEGORY_RULES[category].needsReconciliation, true);
});

// --- Сценарий 9: getPayment 500 ---
test('сценарий 9: getPayment 500 -> RETRYABLE (операция чтения, нечего сверять)', () => {
  const category = classifyProviderError({ httpStatus: 500, isMutatingOperation: false });
  assert.equal(category, CATEGORIES.RETRYABLE);
  assert.equal(CATEGORY_RULES[category].needsGetBeforeRetry, false);
});

// --- Сценарий 10: createRefund timeout ---
test('сценарий 10: createRefund timeout -> UNKNOWN_RESULT', () => {
  assert.equal(classifyProviderError({ isTimeout: true, isMutatingOperation: true }), CATEGORIES.UNKNOWN_RESULT);
});

// --- Сценарий 11: createRefund 500 ---
test('сценарий 11: createRefund 500 -> UNKNOWN_RESULT', () => {
  assert.equal(classifyProviderError({ httpStatus: 500, isMutatingOperation: true }), CATEGORIES.UNKNOWN_RESULT);
});

// --- Сценарий 12: createRefund 400 (превышена сумма) ---
test('сценарий 12: createRefund 400 -> FATAL_REQUEST', () => {
  assert.equal(classifyProviderError({ httpStatus: 400, isMutatingOperation: true }), CATEGORIES.FATAL_REQUEST);
});

test('409 -> CONFLICT, тот же idempotency-key (не новый)', () => {
  const category = classifyProviderError({ httpStatus: 409 });
  assert.equal(category, CATEGORIES.CONFLICT);
  assert.equal(CATEGORY_RULES[category].sameIdempotencyKey, true);
  assert.equal(CATEGORY_RULES[category].retryable, false);
});

test('415 (неверный content-type) -> FATAL_REQUEST, как и 400', () => {
  assert.equal(classifyProviderError({ httpStatus: 415 }), CATEGORIES.FATAL_REQUEST);
});

// --- Сценарий 17: malformed provider response ---
test('сценарий 17: malformed response -> UNKNOWN_RESULT независимо от типа операции', () => {
  assert.equal(classifyProviderError({ isMalformed: true, isMutatingOperation: true }), CATEGORIES.UNKNOWN_RESULT);
  assert.equal(classifyProviderError({ isMalformed: true, isMutatingOperation: false }), CATEGORIES.UNKNOWN_RESULT);
});

test('network error (connection reset/DNS/TLS) на мутирующей операции -> UNKNOWN_RESULT', () => {
  assert.equal(classifyProviderError({ isNetworkError: true, isMutatingOperation: true }), CATEGORIES.UNKNOWN_RESULT);
});

test('network error на операции чтения -> RETRYABLE', () => {
  assert.equal(classifyProviderError({ isNetworkError: true, isMutatingOperation: false }), CATEGORIES.RETRYABLE);
});

test('неизвестный/недокументированный HTTP-код -> UNKNOWN_RESULT (fail-safe default, не считать успехом)', () => {
  assert.equal(classifyProviderError({ httpStatus: 418 }), CATEGORIES.UNKNOWN_RESULT);
  assert.equal(classifyProviderError({}), CATEGORIES.UNKNOWN_RESULT, 'полностью пустой вход тоже должен быть safe-default, не выбрасывать исключение');
});

test('успешные статусы (200/201) этой функцией не классифицируются как ошибка-категория провайдера', () => {
  // classifyProviderError вызывается только для НЕуспешных ответов —
  // документируем через unknown_result как безопасный fallback, если вызвана
  // ошибочно на успешном статусе (не должна интерпретироваться как успех).
  assert.equal(classifyProviderError({ httpStatus: 200 }), CATEGORIES.UNKNOWN_RESULT);
});

test('MANUAL_REVIEW не возвращается напрямую из чистой HTTP-классификации (только эскалация выше по стеку)', () => {
  const allPossibleOutputs = new Set();
  for (const httpStatus of [200, 400, 401, 403, 404, 409, 415, 429, 500, 502, 999, null]) {
    for (const isMutatingOperation of [true, false]) {
      allPossibleOutputs.add(classifyProviderError({ httpStatus, isMutatingOperation }));
    }
  }
  assert.equal(allPossibleOutputs.has(CATEGORIES.MANUAL_REVIEW), false);
});

test('ProviderResultUnknownError: безопасное сообщение, категория, context не теряется, не течёт наружу по умолчанию', () => {
  const err = new ProviderResultUnknownError({ operation: 'createPayment', attemptId: 42 });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ProviderResultUnknownError');
  assert.equal(err.category, CATEGORIES.UNKNOWN_RESULT);
  assert.deepEqual(err.context, { operation: 'createPayment', attemptId: 42 });
  assert.equal(err.message, 'Не удалось безопасно определить результат операции провайдера');
  assert.doesNotMatch(err.message, /secret|key|password|token/i, 'публичное сообщение не должно содержать намёков на секреты провайдера');
});

// ===========================================================================
// assertMatchingProviderObject — найдено по результатам независимого
// pre-push review getStatus() (находка M1, YAAM-yookassa-getstatus-final-
// review-and-push-report.pdf). Общий, provider-агностичный helper, пригодный
// для getStatus/createRefund/getRefund/webhook verification/reconciliation —
// сегодня подключён только в getStatus() (см. yookassaProviderGetStatus.test.js
// для интеграционного теста через сам провайдер).
// ===========================================================================

test('assertMatchingProviderObject: 1. response.id совпадает с requestedId -> PASS (не бросает)', () => {
  assert.doesNotThrow(() => assertMatchingProviderObject('pay_123', { id: 'pay_123', status: 'pending' }));
});

test('assertMatchingProviderObject: 2. response.id отличается от requestedId -> UNKNOWN_RESULT', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', { id: 'pay_OTHER', status: 'pending' }),
    (err) => err instanceof ProviderResultUnknownError && err.category === CATEGORIES.UNKNOWN_RESULT,
  );
});

test('assertMatchingProviderObject: 3. response.id отсутствует -> UNKNOWN_RESULT', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', { status: 'pending' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('assertMatchingProviderObject: 4. response.id пустой -> UNKNOWN_RESULT', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', { id: '', status: 'pending' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('assertMatchingProviderObject: 5. response=null -> UNKNOWN_RESULT', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', null),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('assertMatchingProviderObject: 6. response=[] (массив) -> UNKNOWN_RESULT', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', []),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('assertMatchingProviderObject: 7. response.id не string (число) -> UNKNOWN_RESULT', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', { id: 12345, status: 'pending' }),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('assertMatchingProviderObject: response=undefined -> UNKNOWN_RESULT (дополнительный edge case)', () => {
  assert.throws(
    () => assertMatchingProviderObject('pay_123', undefined),
    (err) => err instanceof ProviderResultUnknownError,
  );
});

test('assertMatchingProviderObject: context сливается с requestedId/receivedId, не теряется и не содержит сырой response', () => {
  try {
    assertMatchingProviderObject('pay_123', { id: 'pay_OTHER' }, { operation: 'getStatus', httpStatus: 200 });
    assert.fail('должно было бросить');
  } catch (err) {
    assert.deepEqual(err.context, {
      operation: 'getStatus', httpStatus: 200, requestedId: 'pay_123', receivedId: 'pay_OTHER',
    });
  }
});
