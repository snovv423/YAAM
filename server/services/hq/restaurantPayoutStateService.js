'use strict';

// YAAM HQ — блок «Выплаты» на обзоре конкретного ресторана
// (docs/HQ-PRODUCT-SPEC.md, раздел «Обзор ресторана → Выплаты»).
//
// ЭТОТ ФАЙЛ НИЧЕГО НЕ СЧИТАЕТ САМ. Он только собирает уже существующие
// источники истины в одно человеческое состояние для UI:
//   - сумма к выплате — settlement_restaurant_lines.payable_amount
//     (immutable snapshot закрытого расчётного периода, services/hq/
//     settlementService.js) — НЕ пересчёт по orders;
//   - готовность реквизитов — restaurantPayoutService.computeReadiness()
//     (тот же, что и на общей вкладке «Финансы»);
//   - состояние самой выплаты — restaurant_payouts (services/hq/
//     payoutService.js).
// Второй параллельный расчёт долга ресторану не создаётся (спецификация:
// единый источник финансовой истины).
const db = require('../../db/postgresql');
const payoutService = require('./payoutService');
const restaurantPayoutService = require('./restaurantPayoutService');
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./dashboardMetrics');

// Еженедельный расчёт: ПОНЕДЕЛЬНИК 07:00 по времени проекта (Europe/Moscow).
// Это отображаемая проекция расписания — сам расчёт выполняет
// weeklySettlementService (автоматическое закрытие недели пн..вс). Значения
// продублированы намеренно: импорт оттуда создал бы цикл, а расхождение
// ловится тестом, сверяющим обе константы.
const SETTLEMENT_WEEKDAY = 1; // понедельник
const SETTLEMENT_HOUR = 7;

function nextSettlementAt(now = new Date()) {
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  const localDay = local.getUTCDay();
  let daysAhead = (SETTLEMENT_WEEKDAY - localDay + 7) % 7;
  const localHour = local.getUTCHours();
  const localMinute = local.getUTCMinutes();
  // Уже понедельник, но час расчёта прошёл — значит ближайший расчёт через неделю.
  if (daysAhead === 0 && (localHour > SETTLEMENT_HOUR || (localHour === SETTLEMENT_HOUR && localMinute > 0))) {
    daysAhead = 7;
  }
  const target = new Date(Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead,
    SETTLEMENT_HOUR, 0, 0, 0,
  ));
  const targetUtc = new Date(target.getTime() - offsetMs);
  // Календарных суток до расчёта — считается по локальным датам (не по
  // разнице в миллисекундах): «через 1 день» должно означать «завтра», а не
  // «через 24 часа».
  const localMidnightToday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const localMidnightTarget = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead);
  const daysLeft = Math.round((localMidnightTarget - localMidnightToday) / (24 * 60 * 60 * 1000));
  return { at: targetUtc, daysLeft, hour: SETTLEMENT_HOUR };
}

// Самая старая невыплаченная закрытая строка расчёта по ресторану с положительной суммой,
// у которой ЕЩЁ НЕТ обязательства выплаты (restaurant_payouts). Именно она —
// то, что можно выплатить прямо сейчас.
async function findPayableLine(restaurantId) {
  const rows = await db.query(
    `SELECT srl.settlement_period_id, srl.payable_amount, sp.period_from, sp.period_to
       FROM settlement_restaurant_lines srl
       JOIN settlement_periods sp ON sp.id = srl.settlement_period_id
      WHERE srl.restaurant_id = $1
        AND sp.status = 'closed'
        AND srl.payable_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM restaurant_payouts rp
           WHERE rp.settlement_period_id = srl.settlement_period_id
             AND rp.restaurant_id = srl.restaurant_id
        )
      ORDER BY sp.period_to ASC, sp.id ASC
      LIMIT 1`,
    [restaurantId],
  );
  return rows[0] || null;
}

// Самое свежее НЕзавершённое обязательство (prepared/processing/unknown/
// blocked) — оно важнее уже выплаченного: владельцу нужно видеть то, что
// требует внимания сейчас.
async function findActivePayout(restaurantId) {
  const rows = await db.query(
    `SELECT rp.*, sp.period_from, sp.period_to
       FROM restaurant_payouts rp
       JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
      WHERE rp.restaurant_id = $1 AND rp.status <> 'succeeded'
      ORDER BY rp.id DESC LIMIT 1`,
    [restaurantId],
  );
  return rows[0] || null;
}

async function findLastSucceededPayout(restaurantId) {
  const rows = await db.query(
    `SELECT rp.*, sp.period_from, sp.period_to
       FROM restaurant_payouts rp
       JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
      WHERE rp.restaurant_id = $1 AND rp.status = 'succeeded'
      ORDER BY rp.completed_at DESC NULLS LAST, rp.id DESC LIMIT 1`,
    [restaurantId],
  );
  return rows[0] || null;
}

// Единственная функция, которую зовёт роут. Возвращает ОДНО состояние —
// какое именно показывать решает здесь сервер, а не шаблон (шаблон не
// должен содержать бизнес-приоритеты состояний).
//
// Приоритет (сверху вниз):
//   1. blocked-обязательство — требует решения владельца прямо сейчас;
//   2. активное обязательство (prepared/processing/unknown) — уже запущено;
//   3. есть закрытая строка расчёта без выплаты:
//        - реквизиты не готовы -> not_ready (кнопки нет);
//        - реквизиты готовы    -> ready (кнопка «Выплатить»);
//   4. выплачивать нечего:
//        - была успешная выплата -> paid (последняя);
//        - не было              -> scheduled (следующий расчёт).
async function getRestaurantPayoutState(restaurantId, now = new Date()) {
  const [payable, activePayout, readinessDetails] = await Promise.all([
    findPayableLine(restaurantId),
    findActivePayout(restaurantId),
    restaurantPayoutService.getRestaurantPayoutDetails(restaurantId),
  ]);
  const readiness = readinessDetails.readiness;

  if (activePayout && activePayout.status === 'blocked') {
    return {
      kind: 'blocked',
      amount: activePayout.amount,
      periodFrom: activePayout.period_from,
      periodTo: activePayout.period_to,
      reason: activePayout.failure_reason || null,
      payoutId: activePayout.id,
    };
  }
  if (activePayout) {
    return {
      kind: 'processing',
      amount: activePayout.amount,
      periodFrom: activePayout.period_from,
      periodTo: activePayout.period_to,
      payoutId: activePayout.id,
    };
  }
  if (payable) {
    if (readiness !== 'ready') {
      return {
        kind: 'not_ready',
        amount: payable.payable_amount,
        periodFrom: payable.period_from,
        periodTo: payable.period_to,
        readiness,
      };
    }
    return {
      kind: 'ready',
      amount: payable.payable_amount,
      periodFrom: payable.period_from,
      periodTo: payable.period_to,
      settlementPeriodId: payable.settlement_period_id,
    };
  }

  const lastPaid = await findLastSucceededPayout(restaurantId);
  if (lastPaid) {
    return {
      kind: 'paid',
      amount: lastPaid.amount,
      periodFrom: lastPaid.period_from,
      periodTo: lastPaid.period_to,
      payoutId: lastPaid.id,
    };
  }
  const next = nextSettlementAt(now);
  return { kind: 'scheduled', daysLeft: next.daysLeft, at: next.at, readiness };
}

// Индивидуальная выплата ОДНОМУ ресторану (спецификация, раздел «Обзор
// ресторана»). Создаёт обязательство ровно тем же путём, что и общая вкладка
// «Выплаты» — payoutService.prepareRestaurantPayout() — со всеми его
// проверками (период закрыт, строка расчёта существует, сумма из snapshot,
// повторная выплата того же периода структурно невозможна из-за UNIQUE
// (settlement_period_id, restaurant_id)). Никакой отдельной «быстрой»
// финансовой логики здесь нет.
//
// Фактическая отправка денег в банк НЕ выполняется — интеграция с Т-Банком
// в проекте существует только как readiness/маппинг статусов, реального
// перевода нет (см. PENDING в отчёте). Обязательство создаётся в статусе
// prepared и ждёт отдельного этапа отправки — UI это честно и называет
// «ожидает отправки в банк», не «выплачено».
async function payRestaurantNow(restaurantId, now = new Date()) {
  const state = await getRestaurantPayoutState(restaurantId, now);
  if (state.kind !== 'ready') {
    throw new payoutService.ValidationError('Выплата сейчас недоступна — состояние расчёта изменилось. Обновите страницу.');
  }
  return payoutService.prepareRestaurantPayout(state.settlementPeriodId, restaurantId);
}

module.exports = {
  SETTLEMENT_WEEKDAY,
  SETTLEMENT_HOUR,
  nextSettlementAt,
  getRestaurantPayoutState,
  payRestaurantNow,
};
