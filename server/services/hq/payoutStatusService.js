'use strict';

// YAAM HQ — «Статус выплат» на экране «Финансы» (docs/HQ-PRODUCT-SPEC.md,
// раздел «Финансы»).
//
// Этот файл НИЧЕГО не считает сам и не создаёт второй источник финансовой
// истины. Он только собирает уже существующие источники в одно рабочее
// состояние на ресторан:
//   - сумма к выплате — settlement_restaurant_lines.payable_amount
//     (immutable snapshot закрытого периода, settlementService);
//   - готовность реквизитов — restaurantPayoutService.computeReadiness()
//     (тот же расчёт, что и на карточке ресторана);
//   - состояние выплаты — restaurant_payouts (payoutService).
//
// Отличие от restaurantPayoutStateService.js (блок «Выплаты» на обзоре ОДНОГО
// ресторана): тот отвечает на вопрос «что показать владельцу на карточке
// ресторана», этот — «дай список всех ресторанов для рабочего экрана
// выплат» одним набором запросов, без N+1. Оба используют одни и те же
// нижележащие сервисы, поэтому не могут разойтись в цифрах.
const db = require('../../db/postgresql');
const payoutService = require('./payoutService');
const restaurantPayoutService = require('./restaurantPayoutService');
const { logAuditEvent } = require('./auditLog');

// Фирменные статусы YAAM (спецификация, раздел 5) — только реально
// достижимые состояния, без эмодзи и технических текстов.
//   tone: 'ok' | 'warn' | 'danger' | 'muted' — цвет бейджа, решает сервер,
//   чтобы шаблон не содержал бизнес-семантику статусов.
const PAYOUT_STATUS = {
  ready: { label: 'Готов к выплате', tone: 'ok' },
  waiting_period: { label: 'Ожидает закрытия периода', tone: 'muted' },
  no_requisites: { label: 'Нет реквизитов', tone: 'warn' },
  no_contract: { label: 'Нет договора', tone: 'warn' },
  no_contact: { label: 'Нет ответственного', tone: 'warn' },
  invalid_requisites: { label: 'Реквизиты требуют проверки', tone: 'warn' },
  prepared: { label: 'Подготовлено', tone: 'muted' },
  processing: { label: 'В обработке', tone: 'muted' },
  paid: { label: 'Выплачено', tone: 'ok' },
  failed: { label: 'Ошибка выплаты', tone: 'danger' },
  blocked: { label: 'Заблокировано', tone: 'danger' },
};

// readiness (restaurantPayoutService) -> статус этого экрана. Один источник
// правды о готовности реквизитов, здесь только перевод в термины UI.
const READINESS_TO_STATUS = {
  missing_legal_details: 'no_requisites',
  missing_bank_details: 'no_requisites',
  contract_not_signed: 'no_contract',
  invalid_details: 'invalid_requisites',
};

// Ответственный контакт (спецификация, раздел 6: «есть ответственный
// контакт»). В схеме это restaurant_legal_details.director_name +
// contact_phone — оба NOT NULL, но могут быть пустыми строками, если запись
// создавалась в обход сервисного слоя. Проверяется явно, а не предполагается.
function hasResponsibleContact(legal) {
  if (!legal) return false;
  const name = String(legal.director_name || '').trim();
  const phone = String(legal.contact_phone || '').trim();
  return name.length > 0 && phone.length > 0;
}

// Полная серверная проверка готовности к выплате (спецификация, раздел 6).
// ЕДИНСТВЕННЫЙ источник истины — frontend только отражает её результат.
// Возвращает { ok, status, reason } где reason — код для UI/логов.
function computePayoutReadiness({ legal, bank, contract, payableAmount, hasClosedPeriod, existingPayout }) {
  if (existingPayout && existingPayout.status === 'succeeded') {
    return { ok: false, status: 'paid', reason: 'already_paid' };
  }
  if (existingPayout && existingPayout.status === 'blocked') {
    return { ok: false, status: 'blocked', reason: 'payout_blocked' };
  }
  if (existingPayout && ['processing', 'unknown'].includes(existingPayout.status)) {
    return { ok: false, status: 'processing', reason: 'payout_in_progress' };
  }
  if (existingPayout && existingPayout.status === 'prepared') {
    return { ok: false, status: 'prepared', reason: 'payout_prepared' };
  }

  const readiness = restaurantPayoutService.computeReadiness({ legal, bank, contract });
  if (readiness !== 'ready') {
    return { ok: false, status: READINESS_TO_STATUS[readiness] || 'no_requisites', reason: readiness };
  }
  if (!hasResponsibleContact(legal)) {
    return { ok: false, status: 'no_contact', reason: 'missing_responsible_contact' };
  }
  if (!hasClosedPeriod) {
    return { ok: false, status: 'waiting_period', reason: 'no_closed_period' };
  }
  if (!(payableAmount > 0)) {
    return { ok: false, status: 'waiting_period', reason: 'nothing_to_pay' };
  }
  return { ok: true, status: 'ready', reason: 'ready' };
}

// Одна строка на ресторан для экрана «Статус выплат». Намеренно НЕ содержит
// оборот/комиссию/количество заказов — спецификация запрещает дублировать
// здесь аналитику, она уже есть в сводке и на карточке ресторана.
//
// Запросы: один по ресторанам с LEFT JOIN реквизитов/договора, один по
// «выплачиваемым» строкам закрытых периодов, один по активным выплатам.
// N+1 нет.
async function listPayoutStatuses() {
  const restaurants = await db.query(`
    SELECT
      r.id, r.name,
      ld.restaurant_id AS legal_exists, ld.legal_form, ld.inn AS legal_inn, ld.ogrn AS legal_ogrn,
      ld.director_name, ld.contact_phone,
      bd.restaurant_id AS bank_exists, bd.bik, bd.account_number, bd.correspondent_account,
      c.restaurant_id AS contract_exists, c.status AS contract_status
    FROM restaurants r
    LEFT JOIN restaurant_legal_details ld ON ld.restaurant_id = r.id
    LEFT JOIN restaurant_bank_details bd ON bd.restaurant_id = r.id
    LEFT JOIN restaurant_contracts c ON c.restaurant_id = r.id
    WHERE r.archived_at IS NULL
    ORDER BY r.name, r.id
  `);

  // Самая свежая закрытая строка расчёта БЕЗ созданной выплаты — ровно то,
  // что можно выплатить прямо сейчас. DISTINCT ON — один ряд на ресторан.
  const payableRows = await db.query(`
    SELECT DISTINCT ON (srl.restaurant_id)
      srl.restaurant_id, srl.settlement_period_id, srl.payable_amount,
      sp.period_from, sp.period_to
    FROM settlement_restaurant_lines srl
    JOIN settlement_periods sp ON sp.id = srl.settlement_period_id
    WHERE sp.status = 'closed'
      AND srl.payable_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM restaurant_payouts rp
         WHERE rp.settlement_period_id = srl.settlement_period_id
           AND rp.restaurant_id = srl.restaurant_id
      )
    ORDER BY srl.restaurant_id, sp.period_to DESC, sp.id DESC
  `);

  // Незавершённая выплата важнее уже выплаченной: владельцу нужно видеть то,
  // что требует внимания сейчас.
  const activeRows = await db.query(`
    SELECT DISTINCT ON (rp.restaurant_id)
      rp.*, sp.period_from, sp.period_to
    FROM restaurant_payouts rp
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    WHERE rp.status <> 'succeeded'
    ORDER BY rp.restaurant_id, rp.id DESC
  `);

  const lastPaidRows = await db.query(`
    SELECT DISTINCT ON (rp.restaurant_id)
      rp.*, sp.period_from, sp.period_to
    FROM restaurant_payouts rp
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    WHERE rp.status = 'succeeded'
    ORDER BY rp.restaurant_id, rp.completed_at DESC NULLS LAST, rp.id DESC
  `);

  const payableByRestaurant = new Map(payableRows.map((r) => [r.restaurant_id, r]));
  const activeByRestaurant = new Map(activeRows.map((r) => [r.restaurant_id, r]));
  const paidByRestaurant = new Map(lastPaidRows.map((r) => [r.restaurant_id, r]));

  return restaurants.map((row) => {
    const legal = row.legal_exists
      ? {
          inn: row.legal_inn, legal_form: row.legal_form, ogrn: row.legal_ogrn,
          director_name: row.director_name, contact_phone: row.contact_phone,
        }
      : null;
    const bank = row.bank_exists
      ? { bik: row.bik, account_number: row.account_number, correspondent_account: row.correspondent_account }
      : null;
    const contract = row.contract_exists ? { status: row.contract_status } : null;

    const payable = payableByRestaurant.get(row.id) || null;
    const activePayout = activeByRestaurant.get(row.id) || null;
    const lastPaid = paidByRestaurant.get(row.id) || null;

    const readiness = computePayoutReadiness({
      legal, bank, contract,
      payableAmount: payable ? payable.payable_amount : 0,
      hasClosedPeriod: Boolean(payable),
      existingPayout: activePayout,
    });

    // Сумма, которую видит владелец: то, что можно выплатить сейчас, либо
    // сумма уже запущенной/последней выплаты — чтобы строка никогда не была
    // пустой без причины.
    let amount = 0;
    let periodFrom = null;
    let periodTo = null;
    if (payable) {
      amount = payable.payable_amount;
      periodFrom = payable.period_from;
      periodTo = payable.period_to;
    } else if (activePayout) {
      amount = activePayout.amount;
      periodFrom = activePayout.period_from;
      periodTo = activePayout.period_to;
    } else if (lastPaid && readiness.status !== 'waiting_period') {
      amount = lastPaid.amount;
      periodFrom = lastPaid.period_from;
      periodTo = lastPaid.period_to;
    }

    // Ресторан без активной выплаты и без выплачиваемой строки, но с уже
    // успешной выплатой — «Выплачено» (последнее известное состояние).
    let status = readiness.status;
    if (!payable && !activePayout && lastPaid) status = 'paid';

    return {
      restaurantId: row.id,
      name: row.name,
      status,
      statusLabel: PAYOUT_STATUS[status].label,
      statusTone: PAYOUT_STATUS[status].tone,
      canPay: readiness.ok,
      reason: readiness.reason,
      amount,
      periodFrom,
      periodTo,
      settlementPeriodId: payable ? payable.settlement_period_id : null,
      payoutId: activePayout ? activePayout.id : (lastPaid ? lastPaid.id : null),
    };
  });
}

// Индивидуальная выплата (спецификация, раздел 10: «последнее действие
// всегда остаётся за владельцем»). Все проверки — здесь, на backend;
// frontend только скрывает кнопку, но не является источником истины.
//
// Идемпотентность обеспечена самой схемой: UNIQUE (settlement_period_id,
// restaurant_id) на restaurant_payouts — повторный вызов для того же периода
// физически не создаст вторую выплату, даже при гонке двух вкладок.
async function payRestaurant(restaurantId, { ip = null } = {}) {
  const statuses = await listPayoutStatuses();
  const row = statuses.find((s) => s.restaurantId === restaurantId);
  if (!row) throw new payoutService.ValidationError('Ресторан не найден.');
  if (!row.canPay) {
    throw new payoutService.ValidationError(`Выплата недоступна: ${row.statusLabel}.`);
  }
  const payout = await payoutService.prepareRestaurantPayout(row.settlementPeriodId, restaurantId);
  await logAuditEvent({
    action: 'payout_created',
    restaurantId,
    details: `выплата #${payout.id}: ${payout.amount} ₽ (период ${row.periodFrom}–${row.periodTo})`,
    ip,
  });
  return payout;
}

// Массовая выплата (спецификация, раздел 11): не готовые пропускаются, ошибка
// одного ресторана не отменяет остальных, операция идемпотентна.
//
// Последовательный, а не Promise.all цикл — намеренно: каждая выплата
// открывает свою транзакцию, а параллельный запуск на пуле соединений даёт
// только конкуренцию за пул без выигрыша на масштабе YAAM (10-20 ресторанов).
async function payAllReady({ ip = null } = {}) {
  const statuses = await listPayoutStatuses();
  const ready = statuses.filter((s) => s.canPay);

  const result = { attempted: ready.length, paid: [], skipped: statuses.length - ready.length, failed: [] };
  for (const row of ready) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const payout = await payoutService.prepareRestaurantPayout(row.settlementPeriodId, row.restaurantId);
      // eslint-disable-next-line no-await-in-loop
      await logAuditEvent({
        action: 'payout_created',
        restaurantId: row.restaurantId,
        details: `массовая выплата #${payout.id}: ${payout.amount} ₽ (период ${row.periodFrom}–${row.periodTo})`,
        ip,
      });
      result.paid.push({ restaurantId: row.restaurantId, name: row.name, payoutId: payout.id, amount: payout.amount });
    } catch (err) {
      // Ошибка одного ресторана НЕ прерывает цикл (спецификация, раздел 11).
      // Сюда же попадает гонка «выплата уже создана другой вкладкой» —
      // UNIQUE-нарушение из prepareRestaurantPayout: это не потеря денег, а
      // подтверждение идемпотентности.
      console.error(`[payoutStatusService] массовая выплата не удалась для ресторана ${row.restaurantId}:`, err.message);
      result.failed.push({ restaurantId: row.restaurantId, name: row.name, error: err.message });
    }
  }
  return result;
}

module.exports = {
  PAYOUT_STATUS,
  hasResponsibleContact,
  computePayoutReadiness,
  listPayoutStatuses,
  payRestaurant,
  payAllReady,
};
