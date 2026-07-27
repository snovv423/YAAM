'use strict';

// YAAM HQ Stage 6 — банковские реквизиты ресторана для будущих выплат
// (задание, раздел 4). Ровно одна актуальная запись на ресторан
// (restaurant_id — PK, см. db/postgresql/schema.sql:restaurant_bank_details).
// Полные значения account_number/correspondent_account никогда не
// покидают этот и смежные HQ-модули открытым текстом за пределы формы
// редактирования (задание, раздел 7) — маскировка для read-only обзора
// живёт в hq/restaurantFinanceViews.js, маскировка для audit log — в
// services/hq/auditLog.js; сама эта таблица хранит значения как есть,
// осознанное решение НЕ шифровать их на уровне приложения — см. раздел 8
// итогового отчёта Stage 6 (обоснование в server/services/hq/README не
// заводилось: см. Markdown-отчёт этапа).
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const { normalizeDigits, isValidInn, isValidBik, isValidAccountNumber, isValidCorrespondentAccount } = require('./ruRequisites');

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBankDetailsInput(body) {
  const recipientName = trim(body.recipient_name);
  if (!recipientName) throw new ValidationError('Наименование получателя обязательно.');

  const recipientInn = normalizeDigits(body.recipient_inn);
  if (!isValidInn(recipientInn)) {
    throw new ValidationError('ИНН получателя должен состоять из 10 (ООО) или 12 (ИП) цифр с верной контрольной суммой.');
  }

  const recipientKpp = normalizeDigits(body.recipient_kpp);
  if (recipientKpp && !/^\d{9}$/.test(recipientKpp)) {
    throw new ValidationError('КПП получателя должен состоять из 9 цифр.');
  }

  const bik = normalizeDigits(body.bik);
  if (!isValidBik(bik)) throw new ValidationError('БИК должен состоять из 9 цифр и быть корректным.');

  const accountNumber = normalizeDigits(body.account_number);
  if (!isValidAccountNumber(accountNumber, bik)) {
    throw new ValidationError('Расчётный счёт должен состоять из 20 цифр и соответствовать указанному БИК.');
  }

  const bankName = trim(body.bank_name);
  if (!bankName) throw new ValidationError('Название банка обязательно.');

  const correspondentAccount = normalizeDigits(body.correspondent_account);
  if (!isValidCorrespondentAccount(correspondentAccount, bik)) {
    throw new ValidationError('Корреспондентский счёт должен состоять из 20 цифр и соответствовать указанному БИК.');
  }

  const defaultPaymentPurpose = trim(body.default_payment_purpose);
  const internalNote = trim(body.internal_note);

  return {
    recipientName, recipientInn, recipientKpp, accountNumber, bik, bankName,
    correspondentAccount, defaultPaymentPurpose, internalNote,
  };
}

async function getBankDetails(restaurantId) {
  const rows = await db.query('SELECT * FROM restaurant_bank_details WHERE restaurant_id = $1', [restaurantId]);
  return rows[0] || null;
}

async function saveBankDetails(restaurantId, body) {
  const input = parseBankDetailsInput(body);
  const existing = await getBankDetails(restaurantId);

  if (existing) {
    const updated = await db.execute(
      `UPDATE restaurant_bank_details SET
         recipient_name=$1, recipient_inn=$2, recipient_kpp=$3, account_number=$4, bik=$5,
         bank_name=$6, correspondent_account=$7, default_payment_purpose=$8, internal_note=$9,
         updated_at=NOW()
       WHERE restaurant_id=$10 RETURNING *`,
      [
        input.recipientName, input.recipientInn, input.recipientKpp, input.accountNumber, input.bik,
        input.bankName, input.correspondentAccount, input.defaultPaymentPurpose, input.internalNote,
        restaurantId,
      ],
    );
    return { record: updated.rows[0], created: false, before: existing };
  }

  const inserted = await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik,
        bank_name, correspondent_account, default_payment_purpose, internal_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      restaurantId, input.recipientName, input.recipientInn, input.recipientKpp, input.accountNumber, input.bik,
      input.bankName, input.correspondentAccount, input.defaultPaymentPurpose, input.internalNote,
    ],
  );
  return { record: inserted.rows[0], created: true, before: null };
}

module.exports = {
  ValidationError,
  parseBankDetailsInput,
  getBankDetails,
  saveBankDetails,
};
