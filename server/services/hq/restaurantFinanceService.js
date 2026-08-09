'use strict';

// YAAM HQ Stage 7 — финансовый учёт по ресторану (задание, раздел 1).
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ (задание, раздел 5: "сравнить два подхода, выбрать
// минимальное, но надёжное решение") — выбран подход A: расчёт агрегатами
// напрямую из orders/payments/refunds, БЕЗ отдельной ledger-таблицы
// (`restaurant_financial_entries` НЕ создана). Обоснование:
//   1. orders.commission_amount УЖЕ является неизменным финансовым снимком
//      на каждом заказе (Stage 1) — источник истины для комиссии уже
//      существует, повторно вводить его в отдельной таблице значило бы
//      держать два места, которые могут разойтись.
//   2. refunds УЖЕ ограничены на уровне БД (Stage 8, db/postgresql/
//      schema.sql): full-refund-only (fn_refunds_amount_matches_payment —
//      refund.amount ВСЕГДА равен payment.amount), не более ОДНОГО
//      succeeded-возврата на платёж НАВСЕГДА (ux_refunds_one_succeeded_per_payment
//      partial unique index) — то есть двойной учёт одного возврата уже
//      структурно невозможен без единой строки нового кода.
//   3. Главные риски, ради которых обычно строят ledger (двойное начисление
//      при повторном webhook, "return создаёт обратную запись, а не
//      переписывает историю", отсутствующий reversal) — уже закрыты пунктами
//      1-2 на уровне существующей схемы. Параллельный ledger добавил бы
//      только риск рассинхронизации (кто-то создал заказ в обход учёта
//      начислений) без дополнительной гарантии корректности.
//   4. Масштаб YAAM (один регион, ограниченное число ресторанов/заказов —
//      см. server/CLAUDE.md) делает живой агрегирующий запрос по orders
//      дешёвым; здесь нет объёма, который оправдывал бы предрасчёт.
//
// Итог: этот файл — ЕДИНСТВЕННОЕ место, которое умеет считать "сколько
// заработал ресторан" — как для сводки "Финансы", так и (через
// dashboardMetrics.getFinanceSummary, см. Stage 7 отчёт) для карточки
// "Обзор". Второй параллельный источник истины не создавался (задание,
// раздел 3).
const db = require('../../db/postgresql');
const { resolvePeriodRange } = require('./restaurantStatsService');
const payoutService = require('./restaurantPayoutService');

// ---------------------------------------------------------------------------
// Какие заказы считаются "заработанными" (задание, раздел 4)
// ---------------------------------------------------------------------------
//
// STAGE33.2 — earned_at IS NOT NULL, НЕ status = 'delivered' (задание Stage
// 33.2, разделы 1-4). Stage 33.1 добавила orders.earned_at как отдельный
// неизменяемый финансовый якорь, но ОСТАВИЛА status='delivered' обязательным
// булевым условием "заказ вообще заработан" — и этим НЕЗАМЕТНО сохранила
// прежнюю зависимость: delivery-заказ сразу после ready->courier УЖЕ имеет
// earned_at (ресторан физически закончил свою часть), но ещё НЕ status=
// 'delivered' (тот наступает только после customer confirm/auto-complete) —
// значит он всё ещё НЕ попадал ни в live-финансы, ни в settlement preview,
// ни в закрываемый период, пока клиент не нажмёт кнопку или не истекут 6
// часов. Кнопка клиента по-прежнему управляла ELIGIBILITY заказа для
// расчёта, даже перестав управлять его ВРЕМЕННЫМ ЯКОРЕМ (Stage 33.1
// закрыла только половину проблемы) — это и есть найденное противоречие
// Stage 33.2.
//
// Решение: earned_at IS NOT NULL — сам по себе достаточный и корректный
// gate, без status='delivered' вообще. earned_at устанавливается АТОМАРНО
// ОДИН РАЗ, в restaurantAdvance(), РОВНО в момент, когда ресторан физически
// завершил свою операционную работу:
//   - delivery: ready -> courier (restaurantAdvance, «Передал курьеру»);
//   - pickup:   preparing -> delivered (restaurantAdvance, «Клиент забрал»).
// НИ confirmReceiptByCustomer(), НИ autoCompleteCourierOrders() earned_at не
// трогают (проверено тестами Stage 33.1/33.2) — значит уже с момента
// ready->courier заказ финансово eligible, и дальнейший courier->delivered
// (клиентом или auto-complete) эту eligibility никак не меняет.
//
// Почему НЕ нужен дополнительный status-guard поверх earned_at IS NOT NULL:
// earned_at устанавливается ИСКЛЮЧИТЕЛЬНО в двух точках ADVANCE_MAP
// (services/postgresql/orderService.js) — 'courier' (delivery) и 'delivered'
// (pickup). После входа в 'courier' заказ СТРУКТУРНО не может попасть ни в
// один другой статус, кроме 'delivered' (courier не встречается как ключ ни
// в одном допустимом переходе cancelByCustomer/restaurantDecline/
// sweepTimeouts — эти функции принимают только awaiting_payment/
// awaiting_restaurant, см. их собственные гварды) — значит "earned_at IS NOT
// NULL" структурно эквивалентно "status IN ('courier', 'delivered')", без
// need отдельно перечислять статусы и без риска снова завязаться на
// status='delivered'.
//
// EXISTS succeeded payment — defense-in-depth поверх state machine
//   (оплата структурно предшествует earned_at, но проверка не полагается
//   только на это допущение молча — тот же принцип, что уже применён в
//   orderService.rateOrder()).
// NOT EXISTS succeeded refund — задание, раздел 4/10: "не имеет успешного
//   полного возврата". Возвраты в этой схеме ТОЛЬКО полные (DB-триггер
//   fn_refunds_amount_matches_payment, "full-refund-only for MVP").
//
// НАЙДЕННЫЙ ФАКТ (Stage 7, раздел 2, актуален и после Stage 33.2):
// reserveRefundRow() (services/postgresql/orderService.js) вызывается с
// причинами customer_cancel/restaurant_decline/timeout — ни один из этих
// ТРЁХ путей не достижим ПОСЛЕ того, как earned_at уже установлен (courier
// нельзя отменить — см. выше). Условие ниже тем не менее защищает от этой
// комбинации на случай будущего изменения бизнес-правил (пост-доставочные
// споры/возвраты). Проверено тестом (см.
// server/test/postgresql/hqRestaurantFinanceStage7.test.js и
// server/test/postgresql/financialEligibilityStage332.test.js).
//
// Stage 37.1/37.2 — НАЙДЕН и закрыт четвёртый путь: reason='duplicate_payment'
// (recordDuplicatePaymentSuccess(), см. orderService.js) НЕ гейтится статусом
// заказа — поздняя/повторная webhook-нотификация о лишнем списании может
// прийти в любой момент, включая уже earned/settled заказ. Экономически это
// НЕ сторно продажи ресторана (сумма ресторана этим списанием никогда не
// затрагивалась — оно просто лишнее и honestly возвращается клиенту), а
// provider/payment reconciliation. SALE_REVERSING_REFUND_REASONS — ОДНО
// каноническое место, которое решает «этот succeeded-возврат отменяет
// заработок ресторана или нет» — используется здесь, в
// computeRefundsAggregate() ниже и (через fetchSucceededRefundRows,
// settlementService.js) в механизме late_refund adjustment. Один список,
// три места чтения — физически не может разойтись по SQL/service слоям.
const SALE_REVERSING_REFUND_REASONS = ['customer_cancel', 'restaurant_decline', 'timeout'];
// SQL-литерал того же списка, а не второй параллельный список — единственный
// generation-point, JS- и SQL-сторона гарантированно не расходятся.
const SALE_REVERSING_REFUND_REASONS_SQL = SALE_REVERSING_REFUND_REASONS.map((r) => `'${r}'`).join(', ');

const EARNED_ORDER_FILTER_SQL = `
  o.earned_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
  AND NOT EXISTS (
    SELECT 1 FROM payments p2
    JOIN refunds rf ON rf.payment_id = p2.id
    WHERE p2.order_id = o.id AND rf.status = 'succeeded'
      AND rf.reason IN (${SALE_REVERSING_REFUND_REASONS_SQL})
  )
`;

// ---------------------------------------------------------------------------
// Якорь времени (Stage 33.1): earned_at, НЕ status_updated_at, НЕ created_at.
// ---------------------------------------------------------------------------
//
// До Stage 33.1 использовался status_updated_at заказа в статусе 'delivered'
// — это было корректно ДО Stage 33 (тогда 'delivered' был единственным,
// сугубо ресторанным действием), но перестало быть корректным, когда Stage 33
// отдала переход courier->delivered клиенту/auto-complete. earned_at решает
// это: устанавливается ОДИН РАЗ, в restaurantAdvance(), атомарно с тем же
// UPDATE, что двигает статус на 'courier' (delivery) или 'delivered'
// (pickup) — см. services/postgresql/orderService.js. После этого момента
// НИ ОДИН код-путь earned_at не переписывает (confirmReceiptByCustomer/
// autoCompleteCourierOrders/rateOrder её не касаются) — значение застывает
// раз и навсегда, тем же принципом, что уже применён к status_updated_at до
// Stage 33.1, только теперь корректно для обеих ветвей делегирования.

// Добавляет (если range задан) РОВНО ДВА самостоятельных условия в conditions
// — не строку с собственным ведущим "AND" (та версия этой функции ошибочно
// joinилась ЕЩЁ РАЗ через conditions.join(' AND ') на уровне вызова,
// порождая невалидный SQL "... AND  AND o.status_updated_at..." всякий раз,
// когда range был непустым — поймано смоук-тестом dashboardMetrics.
// getFinanceSummary({period:'today'}) до того, как это попало в тесты).
function pushRangeConditions(conditions, params, range) {
  if (!range) return;
  params.push(range.startUtc);
  conditions.push(`o.earned_at >= $${params.length}`);
  params.push(range.endUtc);
  conditions.push(`o.earned_at < $${params.length}`);
}

// YAAM HQ Stage 7.1 — anchor времени возврата (задание, раздел 4):
// refunds.completed_at, НЕ дата заказа. Аудит перед разработкой (Stage 7.1
// отчёт, раздел «Аудит timestamp'ов») установил, что эта колонка уже
// существует в схеме (db/postgresql/schema.sql) и заполняется АТОМАРНО
// внутри finalizeRefundSucceeded() (services/postgresql/orderService.js)
// РОВНО в момент `UPDATE refunds SET status = 'succeeded', ...,
// completed_at = NOW() WHERE id = $2 AND status = 'processing'` — это
// ЕДИНСТВЕННЫЙ код-путь во всём orderService.js, который устанавливает
// refunds.status = 'succeeded' (проверено полным grep по файлу). Значит
// completed_at достоверно и однозначно отражает момент, когда возврат
// РЕАЛЬНО завершился успехом — никакого пробела схемы здесь нет (в отличие
// от Stage 7 delivered_at), новая колонка не добавлялась, использована уже
// существующая и уже надёжная.
function pushRefundCompletionRangeConditions(conditions, params, range) {
  if (!range) return;
  params.push(range.startUtc);
  conditions.push(`rf.completed_at >= $${params.length}`);
  params.push(range.endUtc);
  conditions.push(`rf.completed_at < $${params.length}`);
}

// Возвращает по одной строке на restaurant_id, у которого есть хотя бы один
// заработанный заказ в диапазоне (restaurantId=null -> все рестораны сразу,
// один GROUP BY запрос вместо N+1).
async function computeEarningsAggregate({ restaurantId = null, range = null } = {}) {
  const params = [];
  const conditions = [EARNED_ORDER_FILTER_SQL];
  if (restaurantId !== null) {
    params.push(restaurantId);
    conditions.push(`o.restaurant_id = $${params.length}`);
  }
  pushRangeConditions(conditions, params, range);

  const rows = await db.query(
    `SELECT
       o.restaurant_id,
       COUNT(*)::int AS delivered_paid_orders,
       COALESCE(SUM(o.items_total), 0)::int AS turnover,
       COALESCE(SUM(o.commission_amount), 0)::int AS commission
     FROM orders o
     WHERE ${conditions.join(' AND ')}
     GROUP BY o.restaurant_id`,
    params,
  );
  return rows;
}

// YAAM HQ Stage 7.1 — «Возвращено клиентам» (задание, раздел 1-3). ИСПРАВЛЕН
// смысловой дефект Stage 7: прежняя версия этого запроса требовала
// `o.status = 'delivered'`, то есть показывала успешные возвраты ТОЛЬКО для
// заказов, у которых "delivered И succeeded refund" — а это состояние
// СТРУКТУРНО НЕДОСТИЖИМО через сегодняшний жизненный цикл заказа (см.
// комментарий над EARNED_ORDER_FILTER_SQL выше). Единственные РЕАЛЬНО
// достижимые сегодня возвраты — customer_cancel/restaurant_decline/timeout —
// происходят исключительно на заказах, которые НИКОГДА не становятся
// delivered. То есть прежний запрос показывал «0 возвратов» для КАЖДОГО
// возврата, который когда-либо реально происходил в системе, хотя деньги
// клиенту были фактически возвращены. Полный разбор — Stage 7.1 отчёт,
// раздел «Прежняя ошибка».
//
// Новая версия считает КАЖДЫЙ succeeded refund НЕЗАВИСИМО от финального
// статуса заказа — «сколько денег реально вернулось клиентам» (задание,
// раздел 2), а НЕ «сколько из заработка ресторана было аннулировано». Это
// два разных числа, посчитанных из двух независимых запросов:
// EARNED_ORDER_FILTER_SQL (заработок, требует delivered, НЕ читает эту
// функцию) и эта функция (возвраты, читает ТОЛЬКО refunds.status). Заказ,
// который никогда не входил в заработок (не delivered), не может быть из
// него вычтен второй раз этой функцией — она в принципе не трогает
// restaurantEarnings (задание, раздел 3; доказательство — Stage 7.1 отчёт,
// раздел «Формулы»).
//
// Stage 37.2 — ограничена SALE_REVERSING_REFUND_REASONS: «Возвращено
// клиентам» на экране ресторана — это витрина «сколько денег вернулось ИЗ
// ПРОДАЖ ресторана», не общий payment-ledger. duplicate_payment (лишнее
// списание, возвращённое клиенту) сюда физически другой природы — заказ не
// возвращали, ресторан ничего не отменял; показывать его здесь выглядело бы
// как «ресторан вернул заказ», хотя заказ остаётся доставленным и оплаченным
// нормально. Сам факт двойного списания и его возврат никуда не исчезают —
// они остаются в hq_events/hq_audit_log (category='payment_issue',
// action='payment_duplicate_detected') и в самих таблицах payments/refunds,
// просто не смешиваются с «ресторан вернул заказ клиенту».
async function computeRefundsAggregate({ restaurantId = null, range = null } = {}) {
  const params = [];
  const conditions = [`rf.status = 'succeeded'`, `rf.reason IN (${SALE_REVERSING_REFUND_REASONS_SQL})`];
  if (restaurantId !== null) {
    params.push(restaurantId);
    conditions.push(`o.restaurant_id = $${params.length}`);
  }
  pushRefundCompletionRangeConditions(conditions, params, range);

  const rows = await db.query(
    `SELECT
       o.restaurant_id,
       COUNT(*)::int AS refunded_orders,
       COALESCE(SUM(rf.amount), 0)::int AS refunded_amount
     FROM refunds rf
     JOIN payments p ON p.id = rf.payment_id
     JOIN orders o ON o.id = p.order_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY o.restaurant_id`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// DTO — задание, раздел 11, дословный список полей.
// ---------------------------------------------------------------------------
//
// paidOut ВСЕГДА 0 (задание: "paidOut = 0, только если сущности выплат
// реально ещё нет; не сохранять фиктивный ноль в БД") — константа в коде, не
// колонка/таблица. payableBalance — задание, раздел 7: "если выплаты пока
// отсутствуют как сущность: остаток к выплате = сумма ресторана" — ВСЕГДА
// ЗА ВСЁ ВРЕМЯ (all-time), НЕЗАВИСИМО от выбранного периода отчёта: это
// остаток задолженности ("сколько сейчас должны ресторану"), а не поток за
// период — те же экономические понятия, что "P&L за период" и "баланс на
// сегодня" в любой бухгалтерии, их нельзя было бы честно смешать в одно
// число, посчитанное только "за сегодня".
const PAID_OUT_PLACEHOLDER = 0; // задел под будущий Stage выплат — см. итоговый отчёт, раздел 11

async function getRestaurantFinancialPosition(restaurantId, periodOptions = null, now = new Date()) {
  const range = periodOptions ? resolvePeriodRange(periodOptions, now) : null;

  const [periodEarningsRows, refundRows, allTimeEarningsRows, payout] = await Promise.all([
    computeEarningsAggregate({ restaurantId, range }),
    computeRefundsAggregate({ restaurantId, range }),
    computeEarningsAggregate({ restaurantId, range: null }),
    payoutService.getRestaurantPayoutDetails(restaurantId),
  ]);

  const period = periodEarningsRows[0] || { delivered_paid_orders: 0, turnover: 0, commission: 0 };
  const refund = refundRows[0] || { refunded_orders: 0, refunded_amount: 0 };
  const allTime = allTimeEarningsRows[0] || { turnover: 0, commission: 0 };

  const allTimeRestaurantEarnings = allTime.turnover - allTime.commission;

  return {
    restaurantId,
    turnover: period.turnover,
    commission: period.commission,
    restaurantEarnings: period.turnover - period.commission,
    successfulRefunds: refund.refunded_amount,
    // Доп. поле сверх минимального списка задания, раздел 11 (не запрещено —
    // только дополняет) — сохраняет уже существовавший в HQ формат "N шт ·
    // M ₽" (Stage 2), не более.
    successfulRefundsCount: refund.refunded_orders,
    deliveredPaidOrders: period.delivered_paid_orders,
    paidOut: PAID_OUT_PLACEHOLDER,
    payableBalance: allTimeRestaurantEarnings - PAID_OUT_PLACEHOLDER,
    payoutReadiness: payout.readiness,
  };
}

// ---------------------------------------------------------------------------
// Список ВСЕХ (не архивированных) ресторанов для таблицы «Финансы» (задание,
// раздел 7). Один period-запрос + один all-time-запрос вместо N+1 по
// количеству ресторанов, плюс переиспользование Stage 6
// listRestaurantsPayoutSummary() для статуса договора/готовности.
// ---------------------------------------------------------------------------
async function listRestaurantsFinancialPositions(periodOptions = null, now = new Date()) {
  const range = periodOptions ? resolvePeriodRange(periodOptions, now) : null;

  const [restaurantRows, periodEarningsRows, refundRows, allTimeEarningsRows, payoutSummary] = await Promise.all([
    db.query(`SELECT id, name FROM restaurants WHERE archived_at IS NULL ORDER BY name`),
    computeEarningsAggregate({ range }),
    computeRefundsAggregate({ range }),
    computeEarningsAggregate({ range: null }),
    payoutService.listRestaurantsPayoutSummary(),
  ]);

  const periodMap = new Map(periodEarningsRows.map((r) => [r.restaurant_id, r]));
  const refundMap = new Map(refundRows.map((r) => [r.restaurant_id, r]));
  const allTimeMap = new Map(allTimeEarningsRows.map((r) => [r.restaurant_id, r]));
  const payoutMap = new Map(payoutSummary.map((p) => [p.restaurantId, p]));

  return restaurantRows.map((r) => {
    const period = periodMap.get(r.id) || { delivered_paid_orders: 0, turnover: 0, commission: 0 };
    const refund = refundMap.get(r.id) || { refunded_orders: 0, refunded_amount: 0 };
    const allTime = allTimeMap.get(r.id) || { turnover: 0, commission: 0 };
    const payout = payoutMap.get(r.id) || { contractStatus: null, readiness: 'missing_legal_details' };
    const allTimeRestaurantEarnings = allTime.turnover - allTime.commission;

    return {
      restaurantId: r.id,
      name: r.name,
      contractStatus: payout.contractStatus,
      payoutReadiness: payout.readiness,
      deliveredPaidOrders: period.delivered_paid_orders,
      turnover: period.turnover,
      commission: period.commission,
      restaurantEarnings: period.turnover - period.commission,
      successfulRefunds: refund.refunded_amount,
      successfulRefundsCount: refund.refunded_orders,
      paidOut: PAID_OUT_PLACEHOLDER,
      payableBalance: allTimeRestaurantEarnings - PAID_OUT_PLACEHOLDER,
    };
  });
}

// Общая сводка (задание, раздел 7: "оборот; комиссия YAAM; сумма
// ресторанов; успешные возвраты; остаток к будущим выплатам") — сумма по
// той же таблице позиций, что и рендерится ниже неё, никогда не расходится
// с суммой видимых в таблице строк (задание, раздел 3: единый источник).
function summarizeOverall(positions) {
  return positions.reduce(
    (acc, p) => ({
      turnover: acc.turnover + p.turnover,
      commission: acc.commission + p.commission,
      restaurantEarnings: acc.restaurantEarnings + p.restaurantEarnings,
      successfulRefunds: acc.successfulRefunds + p.successfulRefunds,
      successfulRefundsCount: acc.successfulRefundsCount + (p.successfulRefundsCount || 0),
      deliveredPaidOrders: acc.deliveredPaidOrders + p.deliveredPaidOrders,
      paidOut: acc.paidOut + p.paidOut,
      payableBalance: acc.payableBalance + p.payableBalance,
    }),
    { turnover: 0, commission: 0, restaurantEarnings: 0, successfulRefunds: 0, successfulRefundsCount: 0, deliveredPaidOrders: 0, paidOut: 0, payableBalance: 0 },
  );
}

// ---------------------------------------------------------------------------
// Invariant checks (задание, раздел 13) — тестируемая health/audit функция,
// НЕ подключена ни к одному HTTP-маршруту в этом этапе (задание: "никаких
// ручных mutation endpoints" — это тем более относится к новой публичной
// read-поверхности без явной необходимости; вызывается только тестами/
// будущим ops-скриптом).
// ---------------------------------------------------------------------------
async function checkFinancialInvariants() {
  const violations = [];

  // 1. "заказ физически заработан, но финансово не учтён" — courier/delivered
  //    без ни одного succeeded-платежа вообще НЕ должен существовать
  //    структурно (state machine это гарантирует — accepted, а значит и
  //    courier/delivered, достижимы только из awaiting_restaurant, куда
  //    заказ попадает исключительно через markPaid()), но проверяем реальные
  //    данные, не только код. Stage 33.2 — courier добавлен к delivered:
  //    с earned_at IS NOT NULL как gate'ом заказ в 'courier' уже финансово
  //    учтён (см. EARNED_ORDER_FILTER_SQL выше), поэтому и он обязан иметь
  //    succeeded-платёж.
  const [missingPaymentRow] = await db.query(`
    SELECT COUNT(*)::int AS c FROM orders o
    WHERE o.status IN ('courier', 'delivered')
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
  `);
  if (missingPaymentRow.c > 0) {
    violations.push({ kind: 'earned_without_succeeded_payment', count: missingPaymentRow.c });
  }

  // 2. "один заказ учтён дважды" — с агрегатным подходом невозможно на
  //    уровне ЭТОГО запроса (GROUP BY restaurant_id по строкам orders,
  //    каждый заказ — ровно одна строка), но если у ОДНОГО заказа
  //    оказалось больше одного succeeded-платежа, это сигнал более
  //    глубокой проблемы (сам факт был бы неожиданным).
  const [duplicatePaymentsRow] = await db.query(`
    SELECT COUNT(*)::int AS c FROM (
      SELECT order_id FROM payments WHERE status = 'succeeded' GROUP BY order_id HAVING COUNT(*) > 1
    ) dup
  `);
  if (duplicatePaymentsRow.c > 0) {
    violations.push({ kind: 'order_with_multiple_succeeded_payments', count: duplicatePaymentsRow.c });
  }

  // 3. "refund выполнен, но reversal отсутствует" — при агрегатном подходе
  //    исключение возврата — часть ТОГО ЖЕ запроса, что и подсчёт заработка
  //    (EARNED_ORDER_FILTER_SQL), поэтому "забытый reversal" структурно
  //    невозможен — но явно проверяем, что множество "заработанных" и
  //    множество "delivered+succeeded-refund" не пересекаются.
  const [overlapRow] = await db.query(`
    SELECT COUNT(*)::int AS c FROM orders o
    WHERE ${EARNED_ORDER_FILTER_SQL}
      AND EXISTS (
        SELECT 1 FROM payments p JOIN refunds rf ON rf.payment_id = p.id
        WHERE p.order_id = o.id AND rf.status = 'succeeded'
      )
  `);
  if (overlapRow.c > 0) {
    violations.push({ kind: 'earned_order_with_succeeded_refund', count: overlapRow.c });
  }

  // 4. "отрицательный payable balance" — структурно исключено (commission_bps
  //    в [0, 10000], commission_amount = round(items_total * bps/10000) <=
  //    items_total), но проверяем реальные данные на случай будущей
  //    ручной правки БД в обход сервисного слоя.
  const negativeRows = await db.query(`
    SELECT o.restaurant_id, SUM(o.items_total - o.commission_amount)::int AS earnings
    FROM orders o
    WHERE ${EARNED_ORDER_FILTER_SQL}
    GROUP BY o.restaurant_id
    HAVING SUM(o.items_total - o.commission_amount) < 0
  `);
  if (negativeRows.length > 0) {
    violations.push({ kind: 'negative_restaurant_earnings', count: negativeRows.length, restaurantIds: negativeRows.map((r) => r.restaurant_id) });
  }

  // 5. STAGE33.2 — с переходом gate'а на earned_at IS NOT NULL, проверка
  //    "заработанный заказ без earned_at" стала тавтологией (сам фильтр уже
  //    требует earned_at IS NOT NULL — count всегда 0). Осмысленная
  //    инвертированная проверка: заказ, СТРУКТУРНО обязанный иметь earned_at
  //    (courier или delivered — единственные статусы, достижимые ПОСЛЕ
  //    restaurantAdvance-перехода, который его устанавливает, см. комментарий
  //    над EARNED_ORDER_FILTER_SQL), но earned_at всё же NULL — это и есть
  //    реальный сигнал "ручная правка БД в обход сервисного слоя сломала
  //    финансовый якорь", ровно тот случай, ради которого нужен defense-in-
  //    depth (счёт по коду гарантирует обратное, но данные проверяем всё
  //    равно).
  const [missingEarnedAtRow] = await db.query(`
    SELECT COUNT(*)::int AS c FROM orders o
    WHERE o.status IN ('courier', 'delivered') AND o.earned_at IS NULL
  `);
  if (missingEarnedAtRow.c > 0) {
    violations.push({ kind: 'courier_or_delivered_without_earned_at', count: missingEarnedAtRow.c });
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  EARNED_ORDER_FILTER_SQL,
  SALE_REVERSING_REFUND_REASONS,
  SALE_REVERSING_REFUND_REASONS_SQL,
  computeEarningsAggregate,
  computeRefundsAggregate,
  getRestaurantFinancialPosition,
  listRestaurantsFinancialPositions,
  summarizeOverall,
  checkFinancialInvariants,
};
