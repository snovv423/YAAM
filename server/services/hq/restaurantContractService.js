'use strict';

// YAAM HQ Stage 6 — договор ресторана с YAAM (задание, раздел 5). Ровно
// одна актуальная запись на ресторан (restaurant_id — PK, см.
// db/postgresql/schema.sql:restaurant_contracts). История версий договора
// сознательно НЕ строится отдельной таблицей — её хранит hq_audit_log
// (задание, раздел 6).
//
// commission_bps — basis points (700 = 7%, задание, раздел 5), целое число,
// НЕ float. Форма принимает комиссию как процент (например "7" или "7.5")
// и переводит в basis points строковым разбором (без деления/умножения
// float), чтобы избежать погрешности округления даже теоретически.
//
// ВАЖНО (задание, раздел 5): это ДОГОВОРНОЕ значение для будущего
// финансового модуля. Фактический расчёт commission_amount на заказе
// остаётся 0.07-константой в services/postgresql/orderService.js — этот
// файл её НЕ читает и НЕ трогает. См. итоговый отчёт Stage 6, раздел 6, за
// планом безопасного переключения в будущем этапе.
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');

const CONTRACT_STATUSES = ['not_signed', 'prepared', 'signed', 'suspended', 'terminated'];

const CONTRACT_STATUS_LABELS = {
  not_signed: 'Не оформлен',
  prepared: 'Подготовлен',
  signed: 'Подписан',
  suspended: 'Приостановлен',
  terminated: 'Расторгнут',
};

const DEFAULT_COMMISSION_BPS = 700; // 7% — текущая базовая модель YAAM

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseOptionalDate(raw, label) {
  const str = trim(raw);
  if (!str) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw new ValidationError(`${label}: укажите дату в формате ГГГГ-ММ-ДД.`);
  }
  const ms = Date.parse(`${str}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new ValidationError(`${label}: некорректная дата.`);
  }
  return str; // DATE-колонка принимает строку 'YYYY-MM-DD' как есть
}

// Строковый разбор процента в basis points — без float-арифметики (задание,
// раздел 5: "не использовать float"). Допускает до 2 знаков после запятой
// (0.01% — минимальный шаг), запятую или точку как разделитель.
function parseCommissionPercentToBps(raw) {
  const str = trim(raw).replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(str)) {
    throw new ValidationError('Комиссия должна быть числом от 0 до 100 (не более 2 знаков после запятой).');
  }
  const [intPartRaw, fracPartRaw = ''] = str.split('.');
  const fracPart = `${fracPartRaw}00`.slice(0, 2);
  const bps = Number(intPartRaw) * 100 + Number(fracPart);
  if (bps > 10000) {
    throw new ValidationError('Комиссия не может превышать 100%.');
  }
  return bps;
}

// Обратное преобразование — только для отображения (задание: "UI показывает
// «7%»"). Простое деление на 100 для вывода не несёт риска накопления
// ошибки (используется только для показа строки, не для дальнейших
// вычислений/сохранения).
function formatCommissionBpsAsPercent(bps) {
  const str = (Number(bps) / 100).toFixed(2);
  return str.replace(/\.?0+$/, '') || '0';
}

function parseContractInput(body) {
  const status = body.status;
  if (!CONTRACT_STATUSES.includes(status)) {
    throw new ValidationError('Некорректный статус договора.');
  }

  const contractNumber = trim(body.contract_number);
  const signedAt = parseOptionalDate(body.signed_at, 'Дата заключения');
  const startsAt = parseOptionalDate(body.starts_at, 'Дата начала действия');
  const endsAt = parseOptionalDate(body.ends_at, 'Дата окончания');

  if (startsAt && endsAt && endsAt < startsAt) {
    throw new ValidationError('Дата окончания не может быть раньше даты начала действия.');
  }

  // Подписанный договор требует номер и дату (задание, раздел 9) —
  // приостановленный/расторгнутый статус НЕ обязан их иметь заново (данные
  // уже сохранены, их не нужно перезаполнять, чтобы просто сменить статус).
  if (status === 'signed' && (!contractNumber || !signedAt)) {
    throw new ValidationError('Для статуса «Подписан» обязательны номер договора и дата заключения.');
  }

  const commissionBps = body.commission_percent === undefined
    ? DEFAULT_COMMISSION_BPS
    : parseCommissionPercentToBps(body.commission_percent);

  const internalNote = trim(body.internal_note);

  return { contractNumber, signedAt, startsAt, endsAt, status, commissionBps, internalNote };
}

async function getContract(restaurantId) {
  const rows = await db.query('SELECT * FROM restaurant_contracts WHERE restaurant_id = $1', [restaurantId]);
  return rows[0] || null;
}

async function saveContract(restaurantId, body) {
  const input = parseContractInput(body);
  const existing = await getContract(restaurantId);

  if (existing) {
    const updated = await db.execute(
      `UPDATE restaurant_contracts SET
         contract_number=$1, signed_at=$2, starts_at=$3, ends_at=$4, status=$5,
         commission_bps=$6, internal_note=$7, updated_at=NOW()
       WHERE restaurant_id=$8 RETURNING *`,
      [
        input.contractNumber, input.signedAt, input.startsAt, input.endsAt, input.status,
        input.commissionBps, input.internalNote, restaurantId,
      ],
    );
    return { record: updated.rows[0], created: false, before: existing };
  }

  const inserted = await db.execute(
    `INSERT INTO restaurant_contracts
       (restaurant_id, contract_number, signed_at, starts_at, ends_at, status, commission_bps, internal_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      restaurantId, input.contractNumber, input.signedAt, input.startsAt, input.endsAt, input.status,
      input.commissionBps, input.internalNote,
    ],
  );
  return { record: inserted.rows[0], created: true, before: null };
}

module.exports = {
  ValidationError,
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  DEFAULT_COMMISSION_BPS,
  parseContractInput,
  parseCommissionPercentToBps,
  formatCommissionBpsAsPercent,
  getContract,
  saveContract,
};
