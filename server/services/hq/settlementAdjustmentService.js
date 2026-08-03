'use strict';

// YAAM HQ — сторно позднего возврата (docs/HQ-PRODUCT-SPEC.md, раздел
// «Расчётные периоды», подраздел «Поздние возвраты»).
//
// ЗАДАЧА. Заказ попадает в период по моменту доставки. Возврат покупателю
// может прийти позже — когда период с этим заказом уже закрыт и обязательство
// перед рестораном начислено. Закрытый период неизменяем и переписываться не
// должен: выпущенный отчёт агента не может меняться задним числом. Поэтому
// возврат отражается в ТЕКУЩЕМ закрываемом периоде отдельной корректировкой.
//
// ЧТО ИМЕННО СТОРНИРУЕТСЯ. Ровно те суммы, что были начислены по этому заказу
// в его исходном периоде — из его же снимка settlement_order_lines:
//   restaurant_amount_snapshot  -> ресторан возвращает начисленное ему;
//   commission_amount_snapshot  -> YAAM возвращает удержанную комиссию.
// Не пересчёт по текущей ставке: ставка могла измениться, а вернуть нужно
// именно то, что было взято.
//
// ЧЕГО СТОРНО НЕ ДЕЛАЕТ. Оно не трогает исходный период: ни суммы, ни
// документы. Исходный отчёт остаётся верным на момент своего выпуска, а
// исправление видно в периоде, когда деньги фактически вернулись.
const db = require('../../db/postgresql');

// Возвраты периода, по которым нужно сторно: заказ возврата уже учтён в
// settlement_order_lines ДРУГОГО (более раннего) периода.
//
// Возврат по заказу текущего периода сюда не попадает и не должен: такой
// заказ вообще не входит в turnover (EARNED_ORDER_FILTER_SQL исключает заказы
// с успешным возвратом), сторнировать нечего.
//
// Возврат по заказу, который вообще ни в один период не попал, тоже не
// сторнируется — начисления не было.
async function findLateRefundAdjustments(periodId, refundRows, client = null) {
  if (!refundRows.length) return [];
  const refundIds = refundRows.map((r) => r.refund_id);

  const rows = await db.query(
    `SELECT rf.id AS refund_id,
            sol.order_id,
            sol.restaurant_id,
            sol.settlement_period_id AS origin_period_id,
            sol.restaurant_amount_snapshot,
            sol.commission_amount_snapshot
       FROM refunds rf
       JOIN payments p ON p.id = rf.payment_id
       JOIN settlement_order_lines sol ON sol.order_id = p.order_id
      WHERE rf.id = ANY($1::int[])
        AND sol.settlement_period_id <> $2
      ORDER BY rf.id`,
    [refundIds, periodId],
    client,
  );

  return rows.map((r) => ({
    refundId: r.refund_id,
    orderId: r.order_id,
    restaurantId: r.restaurant_id,
    originPeriodId: r.origin_period_id,
    restaurantAmount: r.restaurant_amount_snapshot,
    commissionAmount: r.commission_amount_snapshot,
  }));
}

// Сумма сторно по ресторанам: { [restaurantId]: { restaurantAmount, commissionAmount } }.
function summarizeByRestaurant(adjustments) {
  const map = new Map();
  for (const a of adjustments) {
    const acc = map.get(a.restaurantId) || { restaurantAmount: 0, commissionAmount: 0, count: 0 };
    acc.restaurantAmount += a.restaurantAmount;
    acc.commissionAmount += a.commissionAmount;
    acc.count += 1;
    map.set(a.restaurantId, acc);
  }
  return map;
}

// Запись корректировок. Вызывается ВНУТРИ той же транзакции, что и вставка
// строк периода — сторно и суммы, которые оно уменьшает, появляются вместе
// либо не появляются вовсе.
async function insertAdjustments(periodId, adjustments, client = null) {
  for (const a of adjustments) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute(
      `INSERT INTO settlement_adjustments
         (settlement_period_id, restaurant_id, kind, refund_id, order_id, origin_period_id,
          restaurant_amount, commission_amount)
       VALUES ($1,$2,'late_refund',$3,$4,$5,$6,$7)`,
      [periodId, a.restaurantId, a.refundId, a.orderId, a.originPeriodId,
        a.restaurantAmount, a.commissionAmount],
      client,
    );
  }
  return adjustments.length;
}

// Корректировки периода — для документов и UI.
async function listAdjustmentsForPeriod(periodId, restaurantId = null) {
  const params = [periodId];
  let where = 'sa.settlement_period_id = $1';
  if (restaurantId !== null) {
    params.push(restaurantId);
    where += ' AND sa.restaurant_id = $2';
  }
  return db.query(
    `SELECT sa.*, o.public_code, sp.period_from AS origin_period_from, sp.period_to AS origin_period_to
       FROM settlement_adjustments sa
       JOIN orders o ON o.id = sa.order_id
       JOIN settlement_periods sp ON sp.id = sa.origin_period_id
      WHERE ${where}
      ORDER BY sa.id`,
    params,
  );
}

module.exports = {
  findLateRefundAdjustments,
  summarizeByRestaurant,
  insertAdjustments,
  listAdjustmentsForPeriod,
};
