'use strict';

// YAAM HQ Stage 6 — юридические данные ресторана (задание, раздел 3).
// Ровно одна актуальная запись на ресторан (restaurant_id — PK, см.
// db/postgresql/schema.sql:restaurant_legal_details). Публично видимое имя
// ресторана (restaurants.name) и юридическое название получателя выплаты —
// сознательно разные поля разных таблиц (задание: "Башня" публично, "ИП
// Иванов Иван Иванович" юридически — это две разные сущности).
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const { normalizeDigits, isValidInn, isValidOgrnForLegalForm, normalizeRuPhone, isValidEmail } = require('./ruRequisites');

const LEGAL_FORMS = ['ip', 'ooo'];

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseLegalDetailsInput(body) {
  const legalForm = body.legal_form;
  if (!LEGAL_FORMS.includes(legalForm)) {
    throw new ValidationError('Укажите правовую форму: ИП или ООО.');
  }

  const legalName = trim(body.legal_name);
  if (!legalName) throw new ValidationError('Юридическое название обязательно.');

  const shortLegalName = trim(body.short_legal_name);

  const inn = normalizeDigits(body.inn);
  if (!isValidInn(inn, legalForm)) {
    throw new ValidationError(
      legalForm === 'ooo'
        ? 'ИНН должен состоять из 10 цифр с верной контрольной суммой (для ООО).'
        : 'ИНН должен состоять из 12 цифр с верной контрольной суммой (для ИП).',
    );
  }

  const ogrn = normalizeDigits(body.ogrn);
  if (!isValidOgrnForLegalForm(ogrn, legalForm)) {
    throw new ValidationError(
      legalForm === 'ooo'
        ? 'ОГРН должен состоять из 13 цифр с верной контрольной суммой.'
        : 'ОГРНИП должен состоять из 15 цифр с верной контрольной суммой.',
    );
  }

  // КПП — только для ООО (задание, раздел 3); у ИП его в принципе не бывает.
  const kpp = normalizeDigits(body.kpp);
  if (legalForm === 'ip' && kpp) {
    throw new ValidationError('КПП указывается только для ООО.');
  }
  if (kpp && !/^\d{9}$/.test(kpp)) {
    throw new ValidationError('КПП должен состоять из 9 цифр.');
  }

  const legalAddress = trim(body.legal_address);
  if (!legalAddress) throw new ValidationError('Юридический адрес обязателен.');

  const actualAddress = trim(body.actual_address);

  const directorName = trim(body.director_name);
  if (!directorName) {
    throw new ValidationError(legalForm === 'ip' ? 'ФИО индивидуального предпринимателя обязательно.' : 'ФИО руководителя обязательно.');
  }

  const authorityBasis = trim(body.authority_basis);

  const contactPhone = normalizeRuPhone(body.contact_phone);
  if (!contactPhone) throw new ValidationError('Контактный телефон обязателен и должен быть в российском формате.');

  const contactEmail = trim(body.contact_email);
  if (contactEmail && !isValidEmail(contactEmail)) {
    throw new ValidationError('Контактный email указан в неверном формате.');
  }

  return {
    legalForm, legalName, shortLegalName, inn, ogrn, kpp,
    legalAddress, actualAddress, directorName, authorityBasis,
    contactPhone, contactEmail,
  };
}

async function getLegalDetails(restaurantId) {
  const rows = await db.query('SELECT * FROM restaurant_legal_details WHERE restaurant_id = $1', [restaurantId]);
  return rows[0] || null;
}

// Возвращает { record, created, before } — before=null при первом создании,
// created=true/false для того, чтобы вызывающий код (routes/hq/
// restaurants.js) знал, какое audit-событие писать (*_created vs *_updated),
// не заново выполняя ту же проверку "существует ли уже запись".
async function saveLegalDetails(restaurantId, body) {
  const input = parseLegalDetailsInput(body);
  const existing = await getLegalDetails(restaurantId);

  if (existing) {
    const updated = await db.execute(
      `UPDATE restaurant_legal_details SET
         legal_form=$1, legal_name=$2, short_legal_name=$3, inn=$4, ogrn=$5, kpp=$6,
         legal_address=$7, actual_address=$8, director_name=$9, authority_basis=$10,
         contact_phone=$11, contact_email=$12, updated_at=NOW()
       WHERE restaurant_id=$13 RETURNING *`,
      [
        input.legalForm, input.legalName, input.shortLegalName, input.inn, input.ogrn, input.kpp,
        input.legalAddress, input.actualAddress, input.directorName, input.authorityBasis,
        input.contactPhone, input.contactEmail, restaurantId,
      ],
    );
    return { record: updated.rows[0], created: false, before: existing };
  }

  const inserted = await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, short_legal_name, inn, ogrn, kpp,
        legal_address, actual_address, director_name, authority_basis, contact_phone, contact_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      restaurantId, input.legalForm, input.legalName, input.shortLegalName, input.inn, input.ogrn, input.kpp,
      input.legalAddress, input.actualAddress, input.directorName, input.authorityBasis,
      input.contactPhone, input.contactEmail,
    ],
  );
  return { record: inserted.rows[0], created: true, before: null };
}

module.exports = {
  ValidationError,
  LEGAL_FORMS,
  parseLegalDetailsInput,
  getLegalDetails,
  saveLegalDetails,
};
