'use strict';

// YAAM HQ Stage 9.6 — готовность выплаты к реальной отправке через T-Bank
// (задание, раздел 8). ВАЖНО: этот модуль НИЧЕГО не отправляет в банк — он
// только читает уже сохранённые данные и отвечает на вопрос "можно ли БЫЛО
// БЫ создать попытку прямо сейчас, и если нет — почему". Не путать с
// restaurantPayoutService.js (Stage 6 — "payout readiness" в смысле
// "заполнены ли реквизиты ресторана вообще", более старое и общее понятие).
//
// Единственный источник для назначения платежа (задание, раздел 7) и для
// причин неготовности (раздел 8) — оба нужны и здесь, и в
// services/hq/payoutService.js (createPayoutAttempt должен отказаться
// создавать попытку/snapshot без готового payment_purpose точно так же, как
// readiness должен её показывать неготовой) — buildPaymentPurpose живёт
// здесь, чтобы payoutService.js мог его требовать БЕЗ цикличного require
// (этот файл НЕ требует payoutService.js обратно).
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const yaamBankDetailsService = require('./yaamBankDetailsService');
const restaurantBankDetailsService = require('./restaurantBankDetailsService');
const restaurantContractService = require('./restaurantContractService');

// Дублирует ровно тот же список статусов, что и
// payoutService.ATTEMPT_ACTIVE_STATUSES — НЕ импортируется оттуда напрямую,
// чтобы избежать циклического require (payoutService.js импортирует ЭТОТ
// файл для buildPaymentPurpose). Если когда-либо изменится состав активных
// статусов попытки в payoutService.js, эту константу нужно обновить
// синхронно — оба места явно комментируют друг друга.
const ATTEMPT_ACTIVE_STATUSES = ['created', 'submitting', 'processing', 'unknown'];

const READINESS_REASONS = [
  'missing_yaam_bank_details',
  'invalid_yaam_bank_details',
  'missing_restaurant_bank_details',
  'invalid_restaurant_bank_details',
  'contract_not_signed',
  'missing_payment_purpose',
  'active_attempt_exists',
  'payout_already_succeeded',
  'legacy_state_requires_review',
  'ready',
];

// ---------------------------------------------------------------------------
// Назначение платежа (задание, раздел 7)
// ---------------------------------------------------------------------------
//
// Политика (в порядке приоритета):
//   1. Если restaurant_bank_details.default_payment_purpose заполнен —
//      используется КАК ЕСТЬ (это осознанный выбор оператора для конкретного
//      ресторана — не наша догадка о его налоговом режиме).
//   2. Иначе — генерируется БЕЗОПАСНАЯ структурная строка ТОЛЬКО из уже
//      достоверно известных фактов (номер договора, даты периода, номер
//      выплаты) — задание: "договора YAAM; расчётного периода; номера
//      выплаты".
//   3. НИКОГДА не добавляется формулировка про НДС/налоговый режим
//      автоматически (задание, дословно: "не придумывать налоговый режим
//      ресторана"; "Если автоматическая генерация «без НДС» юридически не
//      подтверждена — не добавлять её автоматически") — сгенерированная
//      строка ниже физически не содержит слова "НДС" ни в каком виде.
//   4. Если даже структурную строку сгенерировать не из чего (нет номера
//      договора) — возвращается null, значит `missing_payment_purpose`
//      (задание: "требовать явное назначение платежа в HQ").
//   5. Результат длиннее 210 символов НИКОГДА не обрезается молча —
//      возвращается null (== не готово), а не усечённая строка, отправленная
//      в банк с потерянным смыслом.
const PAYMENT_PURPOSE_MAX_LENGTH = 210;

function buildPaymentPurpose({ defaultPurpose, contractNumber, periodFrom, periodTo, payoutId }) {
  const trimmedDefault = String(defaultPurpose ?? '').trim();
  if (trimmedDefault) {
    return trimmedDefault.length <= PAYMENT_PURPOSE_MAX_LENGTH ? trimmedDefault : null;
  }
  if (!contractNumber) return null;
  const generated = `Оплата по договору №${contractNumber} за расчётный период ${periodFrom} — ${periodTo}, выплата №${payoutId}`;
  return generated.length <= PAYMENT_PURPOSE_MAX_LENGTH ? generated : null;
}

// ---------------------------------------------------------------------------
// getTBankPayoutReadiness(payoutId) (задание, раздел 8)
// ---------------------------------------------------------------------------
//
// Порядок проверок: сначала три взаимоисключающих состояния САМОГО
// обязательства (succeeded/legacy-рассогласование/активная попытка — по
// построению не могут произойти одновременно, поэтому безопасно вернуть
// раньше остальных проверок), затем — независимые друг от друга проверки
// готовности реквизитов/договора/назначения, которые собираются ВМЕСТЕ (не
// early-return), чтобы оператор увидел сразу все причины, а не чинил их по
// одной за раз.
async function getTBankPayoutReadiness(payoutId) {
  const numericId = Number.parseInt(payoutId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw new ValidationError('Некорректный идентификатор выплаты.');
  }
  const payoutRows = await db.query('SELECT * FROM restaurant_payouts WHERE id = $1', [numericId]);
  const payout = payoutRows[0];
  if (!payout) throw new ValidationError('Выплата не найдена.');

  if (payout.status === 'succeeded') {
    return { ready: false, reasons: ['payout_already_succeeded'] };
  }

  const activeAttempts = await db.query(
    'SELECT id FROM payout_attempts WHERE payout_id = $1 AND status = ANY($2::text[])',
    [numericId, ATTEMPT_ACTIVE_STATUSES],
  );

  // Аудит Stage 9.6, раздел 2 ("Legacy consistency"): обязательство в
  // processing/unknown ОБЯЗАНО иметь ровно одну активную попытку — если её
  // нет, это рассогласование данных (например, ручная правка в обход
  // сервисного слоя), а НЕ повод молча создать новую попытку поверх
  // непонятного состояния. Fail closed, требует ручного разбора.
  if (['processing', 'unknown'].includes(payout.status) && activeAttempts.length === 0) {
    return { ready: false, reasons: ['legacy_state_requires_review'] };
  }
  if (activeAttempts.length > 0) {
    return { ready: false, reasons: ['active_attempt_exists'] };
  }

  const reasons = [];

  const yaamDetails = await yaamBankDetailsService.getYaamBankDetails();
  if (!yaamDetails) {
    reasons.push('missing_yaam_bank_details');
  } else if (!yaamBankDetailsService.isStoredRecordValid(yaamDetails)) {
    reasons.push('invalid_yaam_bank_details');
  }

  const restaurantDetails = await restaurantBankDetailsService.getBankDetails(payout.restaurant_id);
  if (!restaurantDetails) {
    reasons.push('missing_restaurant_bank_details');
  } else if (!restaurantBankDetailsService.isStoredRecordValid(restaurantDetails)) {
    reasons.push('invalid_restaurant_bank_details');
  }

  const contract = await restaurantContractService.getContract(payout.restaurant_id);
  if (!contract || contract.status !== 'signed') {
    reasons.push('contract_not_signed');
  }

  // Назначение платежа зависит от restaurantDetails (default_payment_purpose)
  // — если реквизиты ресторана вообще не заполнены, missing_payment_purpose
  // было бы избыточным дублированием missing_restaurant_bank_details выше.
  if (restaurantDetails) {
    const periodRows = await db.query(
      'SELECT period_from, period_to FROM settlement_periods WHERE id = $1',
      [payout.settlement_period_id],
    );
    const period = periodRows[0] || {};
    const purpose = buildPaymentPurpose({
      defaultPurpose: restaurantDetails.default_payment_purpose,
      contractNumber: contract ? contract.contract_number : null,
      periodFrom: period.period_from,
      periodTo: period.period_to,
      payoutId: numericId,
    });
    if (!purpose) reasons.push('missing_payment_purpose');
  }

  if (reasons.length === 0) return { ready: true, reasons: ['ready'] };
  return { ready: false, reasons };
}

module.exports = {
  READINESS_REASONS,
  PAYMENT_PURPOSE_MAX_LENGTH,
  buildPaymentPurpose,
  getTBankPayoutReadiness,
};
