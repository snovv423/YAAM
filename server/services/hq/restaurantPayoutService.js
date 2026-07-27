'use strict';

// YAAM HQ Stage 6 — готовность ресторана к будущим выплатам (задание,
// раздел 11). Это ТОЛЬКО проверка полноты и внутренней непротиворечивости
// данных — не подтверждение банком, не перевод денег, не кнопка «Выплатить»
// (задание прямо запрещает всё это на этом этапе).
const legalService = require('./restaurantLegalDetailsService');
const bankService = require('./restaurantBankDetailsService');
const contractService = require('./restaurantContractService');
const db = require('../../db/postgresql');
const {
  isValidInn, isValidOgrnForLegalForm, isValidBik, isValidAccountNumber, isValidCorrespondentAccount,
} = require('./ruRequisites');

const READINESS_VALUES = ['ready', 'missing_legal_details', 'missing_bank_details', 'contract_not_signed', 'invalid_details'];

// Краткая причина для UI (задание, раздел 11: "с краткой причиной").
const READINESS_LABELS = {
  ready: 'Готов',
  missing_legal_details: 'Не заполнены юридические данные',
  missing_bank_details: 'Не заполнены банковские реквизиты',
  contract_not_signed: 'Договор не подписан',
  invalid_details: 'Реквизиты требуют проверки',
};

// legal/bank — либо null (записи нет), либо объект с полями, достаточными
// для defensive re-check контрольных сумм (задание: не выдумывать статус
// "Проверено банком", но и не доверять слепо однажды сохранённым данным —
// если запись была создана в обход сервисного слоя, скажем, ручной правкой
// БД или будущей миграцией, readiness честно вернёт invalid_details, а не
// ready).
function computeReadiness({ legal, bank, contract }) {
  if (!legal) return 'missing_legal_details';
  if (!bank) return 'missing_bank_details';
  if (!contract || contract.status !== 'signed') return 'contract_not_signed';

  const legalOk = isValidInn(legal.inn, legal.legal_form) && isValidOgrnForLegalForm(legal.ogrn, legal.legal_form);
  const bankOk = isValidBik(bank.bik)
    && isValidAccountNumber(bank.account_number, bank.bik)
    && isValidCorrespondentAccount(bank.correspondent_account, bank.bik);
  if (!legalOk || !bankOk) return 'invalid_details';

  return 'ready';
}

// Чистая серверная функция готовности к выплате (задание, раздел 11,
// дословно этот пример имени). НЕ выполняет перевод, не создаёт payout
// status — только собирает уже сохранённые данные в один DTO.
async function getRestaurantPayoutDetails(restaurantId) {
  const [legal, bank, contract] = await Promise.all([
    legalService.getLegalDetails(restaurantId),
    bankService.getBankDetails(restaurantId),
    contractService.getContract(restaurantId),
  ]);

  return {
    restaurantId,
    recipientName: bank ? bank.recipient_name : null,
    inn: bank ? bank.recipient_inn : null,
    kpp: bank ? bank.recipient_kpp : null,
    accountNumber: bank ? bank.account_number : null,
    bik: bank ? bank.bik : null,
    bankName: bank ? bank.bank_name : null,
    correspondentAccount: bank ? bank.correspondent_account : null,
    contractNumber: contract ? contract.contract_number : null,
    commissionBps: contract ? contract.commission_bps : null,
    readiness: computeReadiness({ legal, bank, contract }),
  };
}

// Список для раздела «Финансы» (задание, раздел 12) — один запрос с LEFT
// JOIN вместо N+1 (масштаб YAAM небольшой, но нет причин писать N+1, когда
// один запрос настолько же прост). Архивированные рестораны не показываются
// — они не участвуют в операционной деятельности.
async function listRestaurantsPayoutSummary() {
  const rows = await db.query(`
    SELECT
      r.id, r.name,
      ld.restaurant_id AS legal_exists, ld.legal_form AS legal_form, ld.inn AS legal_inn, ld.ogrn AS legal_ogrn,
      bd.restaurant_id AS bank_exists, bd.bik AS bik, bd.account_number AS account_number,
      bd.correspondent_account AS correspondent_account,
      c.restaurant_id AS contract_exists, c.status AS contract_status, c.commission_bps AS commission_bps
    FROM restaurants r
    LEFT JOIN restaurant_legal_details ld ON ld.restaurant_id = r.id
    LEFT JOIN restaurant_bank_details bd ON bd.restaurant_id = r.id
    LEFT JOIN restaurant_contracts c ON c.restaurant_id = r.id
    WHERE r.archived_at IS NULL
    ORDER BY r.name
  `);

  return rows.map((row) => {
    const legal = row.legal_exists ? { inn: row.legal_inn, legal_form: row.legal_form, ogrn: row.legal_ogrn } : null;
    const bank = row.bank_exists ? { bik: row.bik, account_number: row.account_number, correspondent_account: row.correspondent_account } : null;
    const contract = row.contract_exists ? { status: row.contract_status, commissionBps: row.commission_bps } : null;
    return {
      restaurantId: row.id,
      name: row.name,
      contractStatus: contract ? contract.status : null,
      readiness: computeReadiness({ legal, bank, contract }),
    };
  });
}

module.exports = {
  READINESS_VALUES,
  READINESS_LABELS,
  computeReadiness,
  getRestaurantPayoutDetails,
  listRestaurantsPayoutSummary,
};
