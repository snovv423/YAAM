'use strict';

// YAAM HQ Stage 9.6 — T-Bank Integration Readiness: юнит-тесты чистых
// функций (задание, раздел 13 "Unit"). Требует только модулей, чьи async-
// функции с обращением к БД здесь НЕ вызываются (payoutAttemptsUnit.test.js
// уже установил этот принцип для payoutService.js — тот же самый: db/
// postgresql/index.js создаёт Pool лениво, require() безопасен без живого
// PostgreSQL, пока не вызван query/execute/transaction).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mapper = require('../services/hq/tbankRequestMapper');
const readiness = require('../services/hq/tbankPayoutReadiness');
const yaamBankDetailsService = require('../services/hq/yaamBankDetailsService');
const restaurantBankDetailsService = require('../services/hq/restaurantBankDetailsService');

// ---------------------------------------------------------------------------
// normalizeKppForTBank / buildTBankRubleTransferRequest (задание, раздел 6)
// ---------------------------------------------------------------------------

test('normalizeKppForTBank: пустая строка -> "0" (ИП без КПП)', () => {
  assert.equal(mapper.normalizeKppForTBank(''), '0');
  assert.equal(mapper.normalizeKppForTBank('   '), '0');
  assert.equal(mapper.normalizeKppForTBank(null), '0');
  assert.equal(mapper.normalizeKppForTBank(undefined), '0');
});

test('normalizeKppForTBank: непустой КПП (ООО) сохраняется как есть', () => {
  assert.equal(mapper.normalizeKppForTBank('770101001'), '770101001');
});

function validSnapshot(overrides = {}) {
  return {
    recipient_name: 'ИП Тестов Тест Тестович',
    recipient_inn: '770912345616',
    recipient_kpp: '0',
    account_number: '40802810900000000000',
    bik: '044525225',
    bank_name: 'ПАО СБЕРБАНК',
    correspondent_account: '30101810400000000225',
    payment_purpose: 'Оплата по договору №Д-1 за расчётный период 2026-01-01 — 2026-01-31, выплата №42',
    amount: 18600,
    payer_account_number: '40702810900000000000',
    payer_kpp: '770101001',
    ...overrides,
  };
}
function validAttempt(overrides = {}) {
  return { payment_id: 'yaam-po-42-a1-9f1c2b7a', ...overrides };
}

test('buildTBankRubleTransferRequest: корректный snapshot даёт ожидаемую структуру T-API', () => {
  const req = mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot());
  assert.deepEqual(req, {
    id: 'yaam-po-42-a1-9f1c2b7a',
    from: { accountNumber: '40702810900000000000', kpp: '770101001' },
    to: {
      name: 'ИП Тестов Тест Тестович',
      inn: '770912345616',
      kpp: '0',
      bik: '044525225',
      bankName: 'ПАО СБЕРБАНК',
      corrAccountNumber: '30101810400000000225',
      accountNumber: '40802810900000000000',
    },
    purpose: 'Оплата по договору №Д-1 за расчётный период 2026-01-01 — 2026-01-31, выплата №42',
    amount: 18600,
  });
});

test('buildTBankRubleTransferRequest: детерминированность — одинаковый вход даёт идентичный результат', () => {
  const req1 = mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot());
  const req2 = mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot());
  assert.deepEqual(req1, req2);
});

test('buildTBankRubleTransferRequest: recipient_kpp="" в snapshot тоже нормализуется в "0" (defense-in-depth)', () => {
  const req = mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ recipient_kpp: '' }));
  assert.equal(req.to.kpp, '0');
});

test('buildTBankRubleTransferRequest: отклоняет отсутствующий attempt/snapshot', () => {
  assert.throws(() => mapper.buildTBankRubleTransferRequest(null, validSnapshot()), /attempt обязателен/);
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt(), null), /snapshot обязателен/);
});

test('buildTBankRubleTransferRequest: отклоняет пустой payment_id', () => {
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt({ payment_id: '' }), validSnapshot()), /payment_id/);
});

test('buildTBankRubleTransferRequest: отклоняет payment_id длиннее 64 символов', () => {
  const longId = 'x'.repeat(65);
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt({ payment_id: longId }), validSnapshot()), /64/);
});

test('buildTBankRubleTransferRequest: отклоняет отсутствие каждого обязательного поля snapshot по отдельности', () => {
  // recipient_kpp намеренно ОТСУТСТВУЕТ в этом списке — пустая строка для
  // ИП без КПП законна и нормализуется в "0" (см. отдельный тест ниже), а не
  // отклоняется как отсутствующее поле.
  const requiredFields = [
    'payer_account_number', 'payer_kpp', 'recipient_name', 'recipient_inn',
    'bik', 'bank_name', 'correspondent_account', 'account_number', 'payment_purpose',
  ];
  for (const field of requiredFields) {
    assert.throws(
      () => mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ [field]: '' })),
      new RegExp(field),
      `должно отклонить пустое поле "${field}"`,
    );
  }
});

test('buildTBankRubleTransferRequest: отклоняет bank_name длиннее 255 символов', () => {
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ bank_name: 'Б'.repeat(256) })), /255/);
});

test('buildTBankRubleTransferRequest: отклоняет payment_purpose длиннее 210 символов', () => {
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ payment_purpose: 'П'.repeat(211) })), /210/);
});

test('buildTBankRubleTransferRequest: отклоняет неположительную/нечисловую сумму', () => {
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ amount: 0 })), /положительным числом/);
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ amount: -100 })), /положительным числом/);
  assert.throws(() => mapper.buildTBankRubleTransferRequest(validAttempt(), validSnapshot({ amount: NaN })), /положительным числом/);
});

// ---------------------------------------------------------------------------
// buildPaymentPurpose (задание, раздел 7)
// ---------------------------------------------------------------------------

test('buildPaymentPurpose: использует default_payment_purpose как есть, если заполнен', () => {
  const purpose = readiness.buildPaymentPurpose({
    defaultPurpose: '  Оплата за услуги доставки  ', contractNumber: 'Д-1', periodFrom: '2026-01-01', periodTo: '2026-01-31', payoutId: 1,
  });
  assert.equal(purpose, 'Оплата за услуги доставки');
});

test('buildPaymentPurpose: НИКОГДА не добавляет формулировку про НДС автоматически', () => {
  const purpose = readiness.buildPaymentPurpose({
    defaultPurpose: '', contractNumber: 'Д-1', periodFrom: '2026-01-01', periodTo: '2026-01-31', payoutId: 42,
  });
  assert.ok(purpose, 'генерация должна была сработать (есть номер договора)');
  assert.ok(!/ндс/i.test(purpose), `сгенерированная строка не должна упоминать НДС: "${purpose}"`);
});

test('buildPaymentPurpose: генерирует безопасную структурную строку из договора/периода/номера выплаты', () => {
  const purpose = readiness.buildPaymentPurpose({
    defaultPurpose: '', contractNumber: 'Д-42', periodFrom: '2026-01-01', periodTo: '2026-01-31', payoutId: 7,
  });
  assert.match(purpose, /Д-42/);
  assert.match(purpose, /2026-01-01/);
  assert.match(purpose, /2026-01-31/);
  assert.match(purpose, /7/);
});

test('buildPaymentPurpose: без default И без номера договора -> null (missing_payment_purpose)', () => {
  const purpose = readiness.buildPaymentPurpose({
    defaultPurpose: '', contractNumber: null, periodFrom: '2026-01-01', periodTo: '2026-01-31', payoutId: 7,
  });
  assert.equal(purpose, null);
});

test('buildPaymentPurpose: default длиннее 210 символов -> null, а не обрезанная строка', () => {
  const purpose = readiness.buildPaymentPurpose({
    defaultPurpose: 'П'.repeat(211), contractNumber: 'Д-1', periodFrom: '2026-01-01', periodTo: '2026-01-31', payoutId: 1,
  });
  assert.equal(purpose, null);
});

test('buildPaymentPurpose: сгенерированная строка длиннее 210 символов -> null, а не обрезанная строка', () => {
  const purpose = readiness.buildPaymentPurpose({
    defaultPurpose: '', contractNumber: 'Д'.repeat(250), periodFrom: '2026-01-01', periodTo: '2026-01-31', payoutId: 1,
  });
  assert.equal(purpose, null);
});

test('READINESS_REASONS: содержит все 9 причин неготовности + "ready", без дублей', () => {
  const expected = [
    'missing_yaam_bank_details', 'invalid_yaam_bank_details', 'missing_restaurant_bank_details',
    'invalid_restaurant_bank_details', 'contract_not_signed', 'missing_payment_purpose',
    'active_attempt_exists', 'payout_already_succeeded', 'legacy_state_requires_review', 'ready',
  ];
  assert.deepEqual([...readiness.READINESS_REASONS].sort(), [...expected].sort());
  assert.equal(new Set(readiness.READINESS_REASONS).size, readiness.READINESS_REASONS.length, 'без дублей');
});

// ---------------------------------------------------------------------------
// yaamBankDetailsService — валидация (задание, раздел 3)
// ---------------------------------------------------------------------------

function validYaamBody(overrides = {}) {
  return {
    legal_name: 'ООО YAAM Платформа', inn: '7709123453', kpp: '770101001',
    account_number: '40702810900000000000', bik: '044525225',
    bank_name: 'ПАО СБЕРБАНК', correspondent_account: '30101810400000000225',
    ...overrides,
  };
}

test('yaamBankDetailsService.parseYaamBankDetailsInput: корректные данные проходят', () => {
  const parsed = yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody());
  assert.equal(parsed.legalName, 'ООО YAAM Платформа');
  assert.equal(parsed.inn, '7709123453');
  assert.equal(parsed.kpp, '770101001');
});

test('yaamBankDetailsService.parseYaamBankDetailsInput: отклоняет пустое юридическое название', () => {
  assert.throws(() => yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody({ legal_name: '  ' })), /Юридическое название/);
});

test('yaamBankDetailsService.parseYaamBankDetailsInput: отклоняет невалидный ИНН', () => {
  assert.throws(() => yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody({ inn: '1234567890' })), /ИНН/);
});

test('yaamBankDetailsService.parseYaamBankDetailsInput: отклоняет КПП не из 9 цифр', () => {
  assert.throws(() => yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody({ kpp: '123' })), /КПП/);
});

test('yaamBankDetailsService.parseYaamBankDetailsInput: отклоняет счёт, не соответствующий БИК', () => {
  assert.throws(() => yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody({ account_number: '40702810900000000001' })), /Расчётный счёт/);
});

test('yaamBankDetailsService.parseYaamBankDetailsInput: отклоняет bank_name длиннее 255 символов', () => {
  assert.throws(() => yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody({ bank_name: 'Б'.repeat(256) })), /255/);
});

test('yaamBankDetailsService.isStoredRecordValid: валидная сохранённая запись -> true', () => {
  const parsed = yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody());
  assert.equal(yaamBankDetailsService.isStoredRecordValid({
    legal_name: parsed.legalName, inn: parsed.inn, kpp: parsed.kpp, account_number: parsed.accountNumber,
    bik: parsed.bik, bank_name: parsed.bankName, correspondent_account: parsed.correspondentAccount,
  }), true);
});

test('yaamBankDetailsService.isStoredRecordValid: null/отсутствующая запись -> false', () => {
  assert.equal(yaamBankDetailsService.isStoredRecordValid(null), false);
});

test('yaamBankDetailsService.isStoredRecordValid: испорченный БИК (в обход парсера) -> false', () => {
  const parsed = yaamBankDetailsService.parseYaamBankDetailsInput(validYaamBody());
  assert.equal(yaamBankDetailsService.isStoredRecordValid({
    legal_name: parsed.legalName, inn: parsed.inn, kpp: parsed.kpp, account_number: parsed.accountNumber,
    bik: '000000000', bank_name: parsed.bankName, correspondent_account: parsed.correspondentAccount,
  }), false);
});

// ---------------------------------------------------------------------------
// restaurantBankDetailsService — новые ограничения длины (Stage 9.6,
// T-Bank audit раздел 13: bank_name ≤255, purpose ≤210)
// ---------------------------------------------------------------------------

function validRestaurantBankBody(overrides = {}) {
  return {
    recipient_name: 'ИП Тестов Тест Тестович', recipient_inn: '770912345616', recipient_kpp: '',
    account_number: '40702810938050001238', bik: '044999225', bank_name: 'ТЕСТБАНК',
    correspondent_account: '30101810400000004565', default_payment_purpose: '',
    ...overrides,
  };
}

test('restaurantBankDetailsService.parseBankDetailsInput: отклоняет bank_name длиннее 255 символов (Stage 9.6 gap-fix)', () => {
  assert.throws(
    () => restaurantBankDetailsService.parseBankDetailsInput(validRestaurantBankBody({ bank_name: 'Б'.repeat(256) })),
    /255/,
  );
});

test('restaurantBankDetailsService.parseBankDetailsInput: отклоняет default_payment_purpose длиннее 210 символов (Stage 9.6 gap-fix)', () => {
  assert.throws(
    () => restaurantBankDetailsService.parseBankDetailsInput(validRestaurantBankBody({ default_payment_purpose: 'П'.repeat(211) })),
    /210/,
  );
});

test('restaurantBankDetailsService.parseBankDetailsInput: bank_name/purpose ровно на границе (255/210) проходят', () => {
  const parsed = restaurantBankDetailsService.parseBankDetailsInput(validRestaurantBankBody({
    bank_name: 'Б'.repeat(255), default_payment_purpose: 'П'.repeat(210),
  }));
  assert.equal(parsed.bankName.length, 255);
  assert.equal(parsed.defaultPaymentPurpose.length, 210);
});

test('restaurantBankDetailsService.isStoredRecordValid: валидная запись -> true, испорченная -> false', () => {
  const parsed = restaurantBankDetailsService.parseBankDetailsInput(validRestaurantBankBody());
  const validRecord = {
    recipient_name: parsed.recipientName, recipient_inn: parsed.recipientInn, recipient_kpp: parsed.recipientKpp,
    account_number: parsed.accountNumber, bik: parsed.bik, bank_name: parsed.bankName,
    correspondent_account: parsed.correspondentAccount, default_payment_purpose: parsed.defaultPaymentPurpose,
  };
  assert.equal(restaurantBankDetailsService.isStoredRecordValid(validRecord), true);
  assert.equal(restaurantBankDetailsService.isStoredRecordValid({ ...validRecord, bik: '000000000' }), false);
  assert.equal(restaurantBankDetailsService.isStoredRecordValid(null), false);
});
