'use strict';

// YAAM HQ Stage 9.6 — T-Bank request mapper (задание, раздел 6). ЧИСТАЯ
// функция: НЕ делает HTTP-запросов, НЕ читает БД, НЕ знает про токены или
// заголовки авторизации — только детерминированное преобразование уже
// готового immutable snapshot (payout_attempt_requisites) в форму,
// документированную T-Bank T-API (output/md/
// YAAM-TBank-API-Documentation-Audit.md, раздел 4: POST
// https://secured-openapi.tbank.ru/api/v1/payment/ruble-transfer/pay).
//
// Данные берутся ИСКЛЮЧИТЕЛЬНО из snapshot (задание: "никаких чтений
// «текущих» реквизитов ресторана при отправке") — это буквально сигнатура
// функции: она принимает уже готовый снимок, а не restaurantId/payoutId, у
// неё физически нет возможности сходить в БД за "текущими" значениями.
//
// KPP-трансформация ('' -> '0' для ИП без КПП, T-Bank audit, раздел 13)
// ГЛАВНЫМ ОБРАЗОM происходит РАНЬШЕ, при создании самого snapshot
// (services/hq/payoutService.js: createPayoutAttempt — см. комментарий в
// db/postgresql/schema.sql у payout_attempt_requisites.recipient_kpp,
// "recipient_kpp в T-Bank representation") — mapper здесь ПОВТОРНО
// применяет ту же нормализацию как defense-in-depth (тот же принцип
// двойной защиты, что и везде в этой кодовой базе), а не как единственное
// место, где это делается.
const MAX_ID_LENGTH = 64; // T-Bank audit, раздел 4: id ≤ 64 символов
const MAX_PURPOSE_LENGTH = 210;
const MAX_BANK_NAME_LENGTH = 255;

function normalizeKppForTBank(kpp) {
  const trimmed = String(kpp ?? '').trim();
  return trimmed === '' ? '0' : trimmed;
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`buildTBankRubleTransferRequest: обязательное поле "${fieldName}" отсутствует или пусто в snapshot`);
  }
  return value;
}

// buildTBankRubleTransferRequest(attempt, snapshot) — задание: "id =
// payout_attempt.payment_id" (не отдельно генерируемое здесь значение —
// payment_id уже создан generatePaymentId() при создании попытки, задание
// Stage 9.5/9.6, раздел 8). snapshot — строка payout_attempt_requisites
// (или эквивалентный по форме простой объект, для юнит-тестов).
//
// "запрещать создание body, если отсутствуют реквизиты YAAM или ресторана" —
// каждое обязательное T-API поле проверяется на непустоту ЯВНО, до сборки
// объекта; функция бросает Error (не ValidationError — это не
// пользовательский HQ-ввод, а внутренний контракт между payoutService и
// mapper'ом, ошибка здесь означает баг вызывающего кода, а не невалидный
// ввод оператора).
function buildTBankRubleTransferRequest(attempt, snapshot) {
  if (!attempt) throw new Error('buildTBankRubleTransferRequest: attempt обязателен');
  if (!snapshot) throw new Error('buildTBankRubleTransferRequest: snapshot обязателен — mapper не читает "текущие" реквизиты');

  const paymentId = requireNonEmptyString(attempt.payment_id, 'attempt.payment_id');
  if (paymentId.length > MAX_ID_LENGTH) {
    throw new Error(`buildTBankRubleTransferRequest: payment_id длиннее ${MAX_ID_LENGTH} символов`);
  }

  const payerAccountNumber = requireNonEmptyString(snapshot.payer_account_number, 'snapshot.payer_account_number');
  const payerKpp = requireNonEmptyString(snapshot.payer_kpp, 'snapshot.payer_kpp');

  const recipientName = requireNonEmptyString(snapshot.recipient_name, 'snapshot.recipient_name');
  const recipientInn = requireNonEmptyString(snapshot.recipient_inn, 'snapshot.recipient_inn');
  // normalizeKppForTBank СНАЧАЛА (не requireNonEmptyString) — recipient_kpp
  // ЗАКОННО пуст в исходных данных для ИП без КПП; normalizeKppForTBank сам
  // превращает '' в '0' (валидное T-Bank значение), поэтому "пусто" здесь —
  // не ошибка, а нормальный случай, требующий нормализации, а не отказа.
  const recipientKpp = normalizeKppForTBank(snapshot.recipient_kpp);
  const bik = requireNonEmptyString(snapshot.bik, 'snapshot.bik');
  const bankName = requireNonEmptyString(snapshot.bank_name, 'snapshot.bank_name');
  if (bankName.length > MAX_BANK_NAME_LENGTH) {
    throw new Error(`buildTBankRubleTransferRequest: bank_name длиннее ${MAX_BANK_NAME_LENGTH} символов`);
  }
  const correspondentAccount = requireNonEmptyString(snapshot.correspondent_account, 'snapshot.correspondent_account');
  const accountNumber = requireNonEmptyString(snapshot.account_number, 'snapshot.account_number');

  const purpose = requireNonEmptyString(snapshot.payment_purpose, 'snapshot.payment_purpose');
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new Error(`buildTBankRubleTransferRequest: payment_purpose длиннее ${MAX_PURPOSE_LENGTH} символов`);
  }

  const amount = Number(snapshot.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('buildTBankRubleTransferRequest: snapshot.amount должен быть положительным числом');
  }

  // Детерминированная, стабильная форма объекта (одно и то же снимок ->
  // один и тот же request body — задание, раздел 6) — ключи в фиксированном
  // порядке, никаких Date.now()/Math.random() внутри mapper'а.
  return {
    id: paymentId,
    from: {
      accountNumber: payerAccountNumber,
      kpp: payerKpp,
    },
    to: {
      name: recipientName,
      inn: recipientInn,
      kpp: recipientKpp,
      bik,
      bankName,
      corrAccountNumber: correspondentAccount,
      accountNumber,
    },
    purpose,
    amount,
  };
}

module.exports = {
  MAX_ID_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_BANK_NAME_LENGTH,
  normalizeKppForTBank,
  buildTBankRubleTransferRequest,
};
