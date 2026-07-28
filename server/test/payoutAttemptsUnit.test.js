'use strict';

// YAAM HQ Stage 9.5 — юнит-тесты чистых функций payoutService.js (задание,
// раздел 15: "payment_id generation; status transition guards; safe error
// normalization/truncation"). Требует именно PURE-функций модуля —
// generatePaymentId/sanitizeErrorMessage не обращаются к БД, поэтому require
// этого модуля безопасен даже без живого PostgreSQL (Pool в
// db/postgresql/index.js создаётся лениво — см. getPool()); тесты в этом
// файле НЕ вызывают ни query/execute/transaction, ни любую функцию, которая
// их вызывает.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const payoutService = require('../services/hq/payoutService');

const { generatePaymentId, sanitizeErrorMessage, MAX_ERROR_MESSAGE_LENGTH } = payoutService;

// ---------------------------------------------------------------------------
// generatePaymentId (задание, раздел 8: "max 64 chars; unique; deterministic
// association to attempt or random UUID; safe for T-Bank field id; never
// reused; no PII")
// ---------------------------------------------------------------------------

test('generatePaymentId: возвращает строку не длиннее 64 символов', () => {
  const id = generatePaymentId(1, 1);
  assert.equal(typeof id, 'string');
  assert.ok(id.length <= 64, `длина ${id.length} превышает лимит T-Bank`);
});

test('generatePaymentId: содержит payoutId и attemptNumber детерминированно', () => {
  const id = generatePaymentId(42, 3);
  assert.match(id, /^yaam-po-42-a3-[0-9a-f]{8}$/);
});

test('generatePaymentId: два вызова с одинаковыми аргументами дают РАЗНЫЕ id (случайный суффикс)', () => {
  const a = generatePaymentId(1, 1);
  const b = generatePaymentId(1, 1);
  assert.notEqual(a, b);
});

test('generatePaymentId: не содержит ПДн (имя ресторана/счёт/ИНН не передаются как аргументы вообще)', () => {
  const id = generatePaymentId(7, 2);
  // Единственные "данные" внутри id — числовые payoutId/attemptNumber и hex —
  // сам факт, что функция принимает только числа, структурно исключает ПДн.
  assert.match(id, /^yaam-po-\d+-a\d+-[0-9a-f]{8}$/);
});

test('generatePaymentId: отклоняет payoutId <= 0 или нецелый', () => {
  assert.throws(() => generatePaymentId(0, 1));
  assert.throws(() => generatePaymentId(-1, 1));
  assert.throws(() => generatePaymentId(1.5, 1));
});

test('generatePaymentId: отклоняет attemptNumber <= 0 или нецелый', () => {
  assert.throws(() => generatePaymentId(1, 0));
  assert.throws(() => generatePaymentId(1, -1));
  assert.throws(() => generatePaymentId(1, 1.5));
});

test('generatePaymentId: остаётся в пределах 64 символов даже для больших ID', () => {
  const id = generatePaymentId(999999999, 999999999);
  assert.ok(id.length <= 64, `длина ${id.length} превышает лимит T-Bank`);
});

// ---------------------------------------------------------------------------
// sanitizeErrorMessage (задание, раздел 3: "must be safe and bounded, not
// raw response storage")
// ---------------------------------------------------------------------------

test('sanitizeErrorMessage: null/undefined -> null', () => {
  assert.equal(sanitizeErrorMessage(null), null);
  assert.equal(sanitizeErrorMessage(undefined), null);
});

test('sanitizeErrorMessage: пустая строка/строка из пробелов -> null', () => {
  assert.equal(sanitizeErrorMessage(''), null);
  assert.equal(sanitizeErrorMessage('   '), null);
});

test('sanitizeErrorMessage: обрезает пробелы по краям', () => {
  assert.equal(sanitizeErrorMessage('  недостаточно средств  '), 'недостаточно средств');
});

test('sanitizeErrorMessage: обрезает до maxLen по умолчанию (500 символов)', () => {
  const long = 'a'.repeat(1000);
  const result = sanitizeErrorMessage(long);
  assert.equal(result.length, MAX_ERROR_MESSAGE_LENGTH);
});

test('sanitizeErrorMessage: обрезает до кастомного maxLen', () => {
  const result = sanitizeErrorMessage('0123456789', 5);
  assert.equal(result, '01234');
});

test('sanitizeErrorMessage: короткая строка возвращается без изменений', () => {
  assert.equal(sanitizeErrorMessage('bank timeout'), 'bank timeout');
});

test('sanitizeErrorMessage: приводит нестроковые значения к строке', () => {
  assert.equal(sanitizeErrorMessage(12345), '12345');
});

// ---------------------------------------------------------------------------
// Экспортируемые константы статусов — форма, на которую полагаются другие
// модули (payoutViews.js, checkPayoutInvariants, будущий Stage 10)
// ---------------------------------------------------------------------------

test('OBLIGATION_STATUSES: ровно 5 статусов обязательства, failed отсутствует', () => {
  assert.deepEqual(
    [...payoutService.OBLIGATION_STATUSES].sort(),
    ['blocked', 'prepared', 'processing', 'succeeded', 'unknown'].sort(),
  );
  assert.ok(!payoutService.OBLIGATION_STATUSES.includes('failed'));
});

test('OBLIGATION_TERMINAL_STATUSES: единственный terminal — succeeded', () => {
  assert.deepEqual(payoutService.OBLIGATION_TERMINAL_STATUSES, ['succeeded']);
});

test('ATTEMPT_STATUSES: ровно 6 статусов попытки', () => {
  assert.deepEqual(
    [...payoutService.ATTEMPT_STATUSES].sort(),
    ['created', 'failed', 'processing', 'submitting', 'succeeded', 'unknown'].sort(),
  );
});

test('ATTEMPT_ACTIVE_STATUSES: created/submitting/processing/unknown — НЕ succeeded/failed', () => {
  assert.deepEqual(
    [...payoutService.ATTEMPT_ACTIVE_STATUSES].sort(),
    ['created', 'processing', 'submitting', 'unknown'].sort(),
  );
  assert.ok(!payoutService.ATTEMPT_ACTIVE_STATUSES.includes('succeeded'));
  assert.ok(!payoutService.ATTEMPT_ACTIVE_STATUSES.includes('failed'));
});

test('ATTEMPT_TERMINAL_STATUSES: ровно succeeded и failed', () => {
  assert.deepEqual([...payoutService.ATTEMPT_TERMINAL_STATUSES].sort(), ['failed', 'succeeded']);
});

test('каждый STATUS_LABELS/ATTEMPT_STATUS_LABELS покрывает все статусы человекочитаемым текстом', () => {
  for (const s of payoutService.OBLIGATION_STATUSES) {
    assert.ok(payoutService.STATUS_LABELS[s], `нет метки для обязательства "${s}"`);
  }
  for (const s of payoutService.ATTEMPT_STATUSES) {
    assert.ok(payoutService.ATTEMPT_STATUS_LABELS[s], `нет метки для попытки "${s}"`);
  }
});
