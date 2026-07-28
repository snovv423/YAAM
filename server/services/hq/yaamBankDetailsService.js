'use strict';

// YAAM HQ Stage 9.6 — реквизиты САМОГО YAAM как плательщика (T-Bank T-API
// раздел "from": `from.accountNumber`/`from.kpp` — задание, раздел 3).
// Singleton: ровно одна активная запись, физически гарантировано
// db/postgresql/schema.sql (`yaam_bank_details.id INTEGER PRIMARY KEY
// DEFAULT 1 CHECK (id = 1)`) — вторую строку невозможно вставить, не только
// "сервис так задуман".
//
// Тот же общий стиль/принцип валидации, что и services/hq/
// restaurantBankDetailsService.js (Stage 6) — переиспользует те же
// проверочные функции ruRequisites.js (БИК/счёт/корр.счёт/ИНН), не
// дублирует алгоритм. ИНН здесь проверяется БЕЗ legalForm (задание, раздел
// 3 не просит хранить правовую форму YAAM отдельно — isValidInn(value) без
// второго аргумента принимает любую из двух корректных длин, см.
// ruRequisites.js).
//
// HQ-only (задание, раздел 3: "отсутствует в public API и Telegram") —
// этот файл не импортируется НИ ИЗ routes/postgresql/api.js, НИ из
// telegram-бота; единственные вызывающие — routes/hq/pages.js (Settings) и
// payoutService.js (снимок реквизитов на попытку).
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const { normalizeDigits, isValidInn, isValidBik, isValidAccountNumber, isValidCorrespondentAccount } = require('./ruRequisites');

const BANK_NAME_MAX_LENGTH = 255; // T-Bank audit, раздел 13: to.bankName ≤255
const MAX_LEGAL_NAME_LENGTH = 300; // разумный предел, не документирован T-API отдельно — только защита от опечаток/вставки чужого текста

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseYaamBankDetailsInput(body) {
  const legalName = trim(body.legal_name);
  if (!legalName) throw new ValidationError('Юридическое название YAAM обязательно.');
  if (legalName.length > MAX_LEGAL_NAME_LENGTH) {
    throw new ValidationError(`Юридическое название не может быть длиннее ${MAX_LEGAL_NAME_LENGTH} символов.`);
  }

  const inn = normalizeDigits(body.inn);
  if (!isValidInn(inn)) {
    throw new ValidationError('ИНН YAAM должен состоять из 10 или 12 цифр с верной контрольной суммой.');
  }

  const kpp = normalizeDigits(body.kpp);
  if (!/^\d{9}$/.test(kpp)) {
    throw new ValidationError('КПП YAAM должен состоять из 9 цифр.');
  }

  const bik = normalizeDigits(body.bik);
  if (!isValidBik(bik)) throw new ValidationError('БИК должен состоять из 9 цифр и быть корректным.');

  const accountNumber = normalizeDigits(body.account_number);
  if (!isValidAccountNumber(accountNumber, bik)) {
    throw new ValidationError('Расчётный счёт YAAM должен состоять из 20 цифр и соответствовать указанному БИК.');
  }

  const bankName = trim(body.bank_name);
  if (!bankName) throw new ValidationError('Название банка обязательно.');
  if (bankName.length > BANK_NAME_MAX_LENGTH) {
    throw new ValidationError(`Название банка не может быть длиннее ${BANK_NAME_MAX_LENGTH} символов.`);
  }

  const correspondentAccount = normalizeDigits(body.correspondent_account);
  if (!isValidCorrespondentAccount(correspondentAccount, bik)) {
    throw new ValidationError('Корреспондентский счёт YAAM должен состоять из 20 цифр и соответствовать указанному БИК.');
  }

  return { legalName, inn, kpp, accountNumber, bik, bankName, correspondentAccount };
}

// Singleton read — всегда id=1 либо ничего (задание: "заполнено/не заполнено").
async function getYaamBankDetails() {
  const rows = await db.query('SELECT * FROM yaam_bank_details WHERE id = 1');
  return rows[0] || null;
}

// UPSERT на фиксированный id=1 — ON CONFLICT работает благодаря PRIMARY KEY
// (id), не отдельному UNIQUE-ограничению (тот же принцип, что hq_owner —
// singleton-строка с фиксированным id, см. services/hq/ownerService.js).
async function saveYaamBankDetails(body) {
  const input = parseYaamBankDetailsInput(body);
  const existing = await getYaamBankDetails();

  const saved = await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       legal_name = EXCLUDED.legal_name, inn = EXCLUDED.inn, kpp = EXCLUDED.kpp,
       account_number = EXCLUDED.account_number, bik = EXCLUDED.bik,
       bank_name = EXCLUDED.bank_name, correspondent_account = EXCLUDED.correspondent_account,
       updated_at = NOW()
     RETURNING *`,
    [input.legalName, input.inn, input.kpp, input.accountNumber, input.bik, input.bankName, input.correspondentAccount],
  );
  return { record: saved.rows[0], created: !existing, before: existing };
}

// Повторная проверка УЖЕ СОХРАНЁННЫХ значений (задание, раздел 8:
// invalid_yaam_bank_details) — тот же принцип "не доверять только факту
// прохождения валидации при сохранении", что и checkPayoutInvariants()/
// checkSettlementInvariants() в предыдущих этапах: данные могли быть
// вставлены в обход сервисного слоя (прямой SQL, ручное вмешательство).
function isStoredRecordValid(record) {
  if (!record) return false;
  return (
    !!record.legal_name
    && isValidInn(record.inn)
    && /^\d{9}$/.test(record.kpp)
    && isValidBik(record.bik)
    && isValidAccountNumber(record.account_number, record.bik)
    && !!record.bank_name && record.bank_name.length <= BANK_NAME_MAX_LENGTH
    && isValidCorrespondentAccount(record.correspondent_account, record.bik)
  );
}

module.exports = {
  ValidationError,
  BANK_NAME_MAX_LENGTH,
  parseYaamBankDetailsInput,
  getYaamBankDetails,
  saveYaamBankDetails,
  isStoredRecordValid,
};
