'use strict';

// YAAM HQ Stage 14 — юридические данные самой YAAM (ИП).
//
// ЗАЧЕМ ОТДЕЛЬНО от yaamBankDetailsService: там платёжные реквизиты (счёт,
// БИК, банк), здесь — сведения о лице. Смена банка не должна выглядеть как
// смена юридического лица, и наоборот.
//
// Форма бизнеса — ИП. Полей ООО здесь нет намеренно: поддерживать то, чего
// не существует, значит выдумывать требования. КПП у ИП не бывает.
//
// ЧТО НЕ ОБЯЗАТЕЛЬНО И ПОЧЕМУ (PENDING LEGAL). Правовая необходимость
// contact_email, contact_phone и registration_date в отчёте агента не
// подтверждена. Они принимаются и сохраняются, но пустыми быть могут: делать
// поле обязательным без основания — то же самое, что придумать закон.
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const { logAuditEvent } = require('./auditLog');
const {
  normalizeDigits, normalizeRuPhone, isValidEmail, isValidInn, isValidOgrnip,
} = require('./ruRequisites');

const MAX_TEXT = 255;
const MAX_ADDRESS = 500;

// Поля, правовая необходимость которых НЕ подтверждена. Помечены здесь, а не
// только в отчёте, чтобы следующий разработчик не сделал их обязательными,
// решив, что про них просто забыли.
const PENDING_LEGAL_FIELDS = ['contactEmail', 'contactPhone', 'registrationDate'];

function trimmed(value, max) {
  return String(value === null || value === undefined ? '' : value).trim().slice(0, max);
}

// Валидация форматов — но НЕ выдумывание юридических правил. Проверяется
// только то, что проверяемо арифметически (контрольные суммы ИНН/ОГРНИП) и
// синтаксически (email, телефон).
function validate(input) {
  const legalName = trimmed(input.legalName, MAX_TEXT);
  const entrepreneurName = trimmed(input.entrepreneurName, MAX_TEXT);
  const inn = normalizeDigits(input.inn);
  const ogrnip = normalizeDigits(input.ogrnip);
  const registrationAddress = trimmed(input.registrationAddress, MAX_ADDRESS);
  const contactEmail = trimmed(input.contactEmail, MAX_TEXT);
  const contactPhoneRaw = trimmed(input.contactPhone, MAX_TEXT);
  const registrationDate = trimmed(input.registrationDate, 10);

  if (!legalName) throw new ValidationError('Укажите наименование ИП.');
  if (!entrepreneurName) throw new ValidationError('Укажите ФИО предпринимателя.');
  // ИП — всегда 12-значный ИНН физического лица.
  if (!isValidInn(inn, 'ip')) throw new ValidationError('ИНН должен состоять из 12 цифр и проходить проверку контрольных разрядов.');
  if (!isValidOgrnip(ogrnip)) throw new ValidationError('ОГРНИП должен состоять из 15 цифр и проходить проверку контрольного разряда.');
  if (!registrationAddress) throw new ValidationError('Укажите адрес регистрации.');

  // PENDING LEGAL: пустое значение допустимо. Если значение ЕСТЬ — оно обязано
  // быть корректным: сохранять заведомо неверный email бессмысленно.
  if (contactEmail && !isValidEmail(contactEmail)) {
    throw new ValidationError('Проверьте формат рабочего email.');
  }
  const contactPhone = contactPhoneRaw ? normalizeRuPhone(contactPhoneRaw) : '';
  if (contactPhoneRaw && !contactPhone) {
    throw new ValidationError('Проверьте формат рабочего телефона.');
  }
  if (registrationDate && !/^\d{4}-\d{2}-\d{2}$/.test(registrationDate)) {
    throw new ValidationError('Дата регистрации указывается в формате ГГГГ-ММ-ДД.');
  }

  return {
    legalName, entrepreneurName, inn, ogrnip, registrationAddress,
    contactEmail, contactPhone,
    registrationDate: registrationDate || null,
  };
}

async function getYaamLegalDetails() {
  const rows = await db.query('SELECT * FROM yaam_legal_details WHERE id = 1');
  return rows[0] || null;
}

// Singleton: одна строка, id=1. Upsert, а не «создать/обновить» двумя путями —
// второй путь рано или поздно разойдётся с первым.
//
// В АУДИТ НЕ ПИШУТСЯ САМИ ЗНАЧЕНИЯ. ИНН и ОГРНИП — идентифицирующие данные;
// в событие идёт только факт изменения и список изменённых полей.
async function saveYaamLegalDetails(input, { ip = null } = {}) {
  const v = validate(input);
  const before = await getYaamLegalDetails();

  const rows = await db.execute(
    `INSERT INTO yaam_legal_details
       (id, legal_name, entrepreneur_name, inn, ogrnip, registration_address,
        contact_email, contact_phone, registration_date)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       legal_name = EXCLUDED.legal_name,
       entrepreneur_name = EXCLUDED.entrepreneur_name,
       inn = EXCLUDED.inn,
       ogrnip = EXCLUDED.ogrnip,
       registration_address = EXCLUDED.registration_address,
       contact_email = EXCLUDED.contact_email,
       contact_phone = EXCLUDED.contact_phone,
       registration_date = EXCLUDED.registration_date,
       updated_at = NOW()
     RETURNING *`,
    [v.legalName, v.entrepreneurName, v.inn, v.ogrnip, v.registrationAddress,
      v.contactEmail, v.contactPhone, v.registrationDate],
  );

  const changed = before ? changedFieldLabels(before, rows.rows[0]) : ['первичное заполнение'];
  await logAuditEvent({
    action: 'yaam_legal_details_updated', restaurantId: null,
    details: `юридические данные YAAM изменены: ${changed.join(', ') || 'без изменений'}`,
    ip,
  });

  return rows.rows[0];
}

const FIELD_LABELS = {
  legal_name: 'наименование',
  entrepreneur_name: 'ФИО предпринимателя',
  inn: 'ИНН',
  ogrnip: 'ОГРНИП',
  registration_address: 'адрес регистрации',
  contact_email: 'рабочий email',
  contact_phone: 'рабочий телефон',
  registration_date: 'дата регистрации',
};

// Только НАЗВАНИЯ изменённых полей — не старые и не новые значения.
function changedFieldLabels(before, after) {
  const labels = [];
  for (const [column, label] of Object.entries(FIELD_LABELS)) {
    const a = before[column] instanceof Date ? before[column].toISOString().slice(0, 10) : before[column];
    const b = after[column] instanceof Date ? after[column].toISOString().slice(0, 10) : after[column];
    if (String(a ?? '') !== String(b ?? '')) labels.push(label);
  }
  return labels;
}

module.exports = {
  PENDING_LEGAL_FIELDS,
  validate,
  getYaamLegalDetails,
  saveYaamLegalDetails,
};
