'use strict';

// YAAM HQ Stage 8 — Settlement Periods and Restaurant Payable Obligations
// (задание, раздел 1).
//
// АУДИТ ПЕРЕД РАЗРАБОТКОЙ (задание, раздел 2) — что уже существует и что
// именно этот файл НЕ дублирует:
//   - services/hq/restaurantFinanceService.js (Stage 7/7.1) остаётся
//     ЕДИНСТВЕННЫМ источником LIVE-финансовой позиции (турникет "сколько
//     заработал ресторан ПРЯМО СЕЙЧАС за произвольный период"). Этот файл
//     его формулы НЕ переопределяет — EARNED_ORDER_FILTER_SQL импортируется
//     оттуда буквально тем же экспортированным константным SQL-фрагментом,
//     не копируется параллельным текстом.
//   - Период заработка — orders.status_updated_at (Stage 7, доказательство:
//     restaurantFinanceService.js, раздел "Якорь времени"). Период возврата —
//     refunds.completed_at (Stage 7.1). Обе даты ЗДЕСЬ не переизобретаются.
//   - Stage 6 payout readiness (services/hq/restaurantPayoutService.js) —
//     переиспользуется как есть для snapshot готовности на момент закрытия.
//   - /hq/finance (routes/hq/pages.js) остаётся live-экраном Stage 7 —
//     этот файл лишь добавляет туда ОТДЕЛЬНУЮ секцию "Расчётные периоды",
//     не подменяя существующую сводку.
//
// Разделение (задание, раздел 2, дословно):
//   1. LIVE financial position — Stage 7, читает orders/payments/refunds
//      заново при каждом запросе, никогда не сохраняется.
//   2. CLOSED settlement snapshot — Stage 8 (этот файл), читает
//      orders/payments/refunds ТОЛЬКО один раз, в момент closeSettlementPeriod(),
//      сохраняет результат в settlement_restaurant_lines/settlement_order_lines/
//      settlement_refunds и НИКОГДА не пересчитывает их заново после этого
//      момента (см. getSettlementPeriodDetail() ниже: closed-ветка не делает
//      ни одного запроса к orders/payments/refunds).
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const { resolvePeriodRange } = require('./restaurantStatsService');
const financeService = require('./restaurantFinanceService');
const payoutService = require('./restaurantPayoutService');
const contractService = require('./restaurantContractService');
const { FALLBACK_COMMISSION_BPS } = require('../postgresql/orderService');

const MAX_NOTES_LENGTH = 500;

// ---------------------------------------------------------------------------
// Создание черновика периода
// ---------------------------------------------------------------------------
//
// Валидация дат/366-дневного лимита/"конец не раньше начала" ПОЛНОСТЬЮ
// переиспользует resolvePeriodRange({period:'custom', ...}) — ту же функцию,
// что уже применяется на вкладке «Статистика» ресторана и на /hq/finance
// (Stage 4/7). Задание, раздел 11, просит РОВНО эти же проверки — вторая
// параллельная реализация была бы лишним риском рассинхронизации.
// Непересекаемость периодов (задание, раздел 3) обеспечена НЕ здесь, а
// EXCLUDE-ограничением settlement_periods_no_overlap на уровне схемы
// (db/postgresql/schema.sql) — INSERT ниже либо проходит, либо PostgreSQL
// сам отклоняет его с SQLSTATE 23P01, которую эта функция превращает в
// понятную ValidationError.
async function createDraftSettlementPeriod({ periodFrom, periodTo, notes = '', createdBy = null }, now = new Date()) {
  resolvePeriodRange({ period: 'custom', from: periodFrom, to: periodTo }, now);

  const trimmedNotes = String(notes || '').trim().slice(0, MAX_NOTES_LENGTH);
  try {
    const inserted = await db.execute(
      `INSERT INTO settlement_periods (period_from, period_to, notes, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [periodFrom, periodTo, trimmedNotes, createdBy || ''],
    );
    return inserted.rows[0];
  } catch (err) {
    if (err.code === '23P01') {
      throw new ValidationError('Этот диапазон дат пересекается с уже существующим расчётным периодом.');
    }
    throw err;
  }
}

async function getSettlementPeriodById(periodId) {
  const numericId = Number.parseInt(periodId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM settlement_periods WHERE id = $1', [numericId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Общее ядро расчёта — используется И preview (draft), И closeSettlementPeriod
// (при закрытии) — ОДНА формула, не две параллельные (задание, раздел 6:
// "не менять формулы Stage 7/7.1").
// ---------------------------------------------------------------------------

// Заработанные заказы периода — построчно (не агрегатом, в отличие от
// Stage 7 computeEarningsAggregate), потому что закрытию периода нужен
// ПОЛНЫЙ список order_id для settlement_order_lines (задание, раздел 7,
// вариант B) — но фильтр "что считается заработком" читается буквально из
// EARNED_ORDER_FILTER_SQL (Stage 7), не переписывается заново.
async function fetchEarnedOrderRows(range, client = null) {
  return db.query(
    `SELECT o.id AS order_id, o.restaurant_id, o.items_total, o.commission_amount, o.status_updated_at
     FROM orders o
     WHERE ${financeService.EARNED_ORDER_FILTER_SQL}
       AND o.status_updated_at >= $1 AND o.status_updated_at < $2
     ORDER BY o.id`,
    [range.startUtc, range.endUtc],
    client,
  );
}

// Успешные возвраты периода — построчно, тот же anchor (refunds.completed_at,
// Stage 7.1), тот же принцип "не delivered-only" (Stage 7.1 отчёт).
async function fetchSucceededRefundRows(range, client = null) {
  return db.query(
    `SELECT rf.id AS refund_id, o.restaurant_id, rf.amount, rf.completed_at
     FROM refunds rf
     JOIN payments p ON p.id = rf.payment_id
     JOIN orders o ON o.id = p.order_id
     WHERE rf.status = 'succeeded'
       AND rf.completed_at >= $1 AND rf.completed_at < $2
     ORDER BY rf.id`,
    [range.startUtc, range.endUtc],
    client,
  );
}

// "Честная модель" commission_bps_summary (задание, раздел 4: "или иная
// честная модель") — orders.commission_amount НЕ хранит саму bps-ставку
// (только уже посчитанную сумму), а restaurant_contracts НЕ версионируется
// (задание Stage 6: "История версий договора сознательно НЕ строится
// отдельной таблицей"), поэтому точную историческую ставку для СТАРОГО
// заказа нельзя достоверно восстановить — только приблизительно поделить
// (с погрешностью округления). Вместо того чтобы ВЫДУМАТЬ приблизительное
// "среднее" число, эта функция возвращает конкретное значение ТОЛЬКО если
// оно ПОДТВЕРЖДЕНО: то есть КАЖДЫЙ заказ периода точно воспроизводится
// формулой Math.round(items_total*bps/10000)===commission_amount для этого
// bps. Кандидаты — единственные два значения, которые вообще мог
// использовать resolveCommissionBps() (services/postgresql/orderService.js):
// текущая ставка подписанного договора и FALLBACK_COMMISSION_BPS. Если ни
// один кандидат не подтверждается всеми заказами (ставка менялась внутри
// периода) — возвращается null ("смешанная/неопределённая"), не приблизительное число.
function inferUniformCommissionBps(orderRows, candidateBpsList) {
  if (orderRows.length === 0) return null;
  const uniqueCandidates = [...new Set(candidateBpsList.filter((v) => v !== null && v !== undefined))];
  for (const bps of uniqueCandidates) {
    const allMatch = orderRows.every((o) => Math.round(o.items_total * bps / 10000) === o.commission_amount);
    if (allMatch) return bps;
  }
  return null;
}

// Группирует построчные заказы/возвраты в обязательства по ресторану
// (задание, раздел 4) — только для ресторанов с реальной активностью
// (задание, раздел 3 схемы: см. комментарий в db/postgresql/schema.sql у
// settlement_restaurant_lines). payable_amount = restaurant_earnings
// буквально (задание, раздел 4: "пока реальных выплат не существует") — без
// вычитания какого-либо paid_out placeholder (в отличие от Stage 7
// payableBalance, задание здесь ПРЯМО запрещает "записывать paid_out=0 как
// будто это реальная финансовая операция" — эта колонка просто не создана).
async function buildRestaurantLines(orderRows, refundRows) {
  const restaurantIds = new Set([
    ...orderRows.map((o) => o.restaurant_id),
    ...refundRows.map((r) => r.restaurant_id),
  ]);

  const lines = [];
  for (const restaurantId of restaurantIds) {
    const orders = orderRows.filter((o) => o.restaurant_id === restaurantId);
    const refunds = refundRows.filter((r) => r.restaurant_id === restaurantId);
    const turnover = orders.reduce((sum, o) => sum + o.items_total, 0);
    const yaamCommission = orders.reduce((sum, o) => sum + o.commission_amount, 0);
    const restaurantEarnings = turnover - yaamCommission;

    // eslint-disable-next-line no-await-in-loop
    const [payout, contract] = await Promise.all([
      payoutService.getRestaurantPayoutDetails(restaurantId),
      contractService.getContract(restaurantId),
    ]);

    const candidateBpsList = [FALLBACK_COMMISSION_BPS];
    if (contract && contract.status === 'signed') candidateBpsList.unshift(contract.commission_bps);

    lines.push({
      restaurantId,
      deliveredPaidOrders: orders.length,
      turnover,
      yaamCommission,
      restaurantEarnings,
      successfulRefundsCount: refunds.length,
      successfulRefundsAmount: refunds.reduce((sum, r) => sum + r.amount, 0),
      payableAmount: restaurantEarnings,
      payoutReadinessSnapshot: payout.readiness,
      contractNumberSnapshot: contract ? contract.contract_number : '',
      commissionBpsSummary: inferUniformCommissionBps(orders, candidateBpsList),
      orders,
      refunds,
    });
  }
  return lines;
}

async function computeSettlementPreview(range, client = null) {
  const [orderRows, refundRows] = await Promise.all([
    fetchEarnedOrderRows(range, client),
    fetchSucceededRefundRows(range, client),
  ]);
  const restaurantLines = await buildRestaurantLines(orderRows, refundRows);
  return { restaurantLines, orderRows, refundRows };
}

// ---------------------------------------------------------------------------
// Закрытие периода (задание, раздел 5, 9 шагов дословно)
// ---------------------------------------------------------------------------
//
// Повторное закрытие (задание: "не создаёт дубликаты; возвращает понятную
// ошибку либо идемпотентный результат") — выбран ИДЕМПОТЕНТНЫЙ результат:
// повторный вызов на уже закрытом периоде просто возвращает уже сохранённый
// snapshot, без ошибки и без повторной вставки строк — тот же принцип,
// что markPaid()/restaurantAccept() в orderService.js (conditional-переход,
// не бросает на "уже применено").
//
// Если транзакция падает на любом шаге (задание: "период остаётся draft;
// частичных строк не остаётся") — это гарантируется САМОЙ структурой
// serializableTransaction(): любое исключение внутри fn -> ROLLBACK всей
// транзакции целиком (включая UPDATE периода и все INSERT'ы строк) — здесь
// нет отдельного кода для этого случая, он не нужен.
async function closeSettlementPeriod(periodId, { now = new Date() } = {}) {
  return db.serializableTransaction(async (client) => {
    // Шаги 1-2: SERIALIZABLE-транзакция (обёртка вызывающего кода) +
    // блокировка строки периода (SELECT ... FOR UPDATE) — явная защита ПОВЕРХ
    // самого SERIALIZABLE (тот же принцип "два независимых слоя", что и
    // createOrder() в orderService.js).
    const periodRows = await db.query('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE', [periodId], client);
    const period = periodRows[0];
    if (!period) throw new ValidationError('Расчётный период не найден.');

    // Шаг 3 + идемпотентность повторного закрытия.
    if (period.status === 'closed') {
      const lines = await db.query(
        'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1 ORDER BY restaurant_id',
        [periodId], client,
      );
      return { period, lines, alreadyClosed: true };
    }

    // Шаг 4: единый Stage 7 фильтр заработка + Stage 7.1 фильтр возвратов,
    // за диапазон периода (тот же resolvePeriodRange, что и создание черновика).
    const range = resolvePeriodRange({ period: 'custom', from: period.period_from, to: period.period_to }, now);
    const { restaurantLines } = await computeSettlementPreview(range, client);

    // Шаги 5-6: сформировать строки обязательств + immutable snapshot.
    const insertedLines = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const line of restaurantLines) {
      // eslint-disable-next-line no-await-in-loop
      const insertedLine = await db.execute(
        `INSERT INTO settlement_restaurant_lines
           (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
            restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
            payout_readiness_snapshot, contract_number_snapshot, commission_bps_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          periodId, line.restaurantId, line.deliveredPaidOrders, line.turnover, line.yaamCommission,
          line.restaurantEarnings, line.successfulRefundsCount, line.successfulRefundsAmount, line.payableAmount,
          line.payoutReadinessSnapshot, line.contractNumberSnapshot, line.commissionBpsSummary,
        ],
        client,
      );
      insertedLines.push(insertedLine.rows[0]);

      // settlement_order_lines: UNIQUE(order_id) — задание, раздел 7, "это
      // критично" — единственный механизм, который физически не даёт одному
      // и тому же заказу попасть в ДВА разных периода.
      // eslint-disable-next-line no-restricted-syntax
      for (const o of line.orders) {
        // eslint-disable-next-line no-await-in-loop
        await db.execute(
          `INSERT INTO settlement_order_lines
             (settlement_period_id, restaurant_id, order_id, items_total_snapshot,
              commission_amount_snapshot, restaurant_amount_snapshot, delivered_at_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [periodId, line.restaurantId, o.order_id, o.items_total, o.commission_amount,
            o.items_total - o.commission_amount, o.status_updated_at],
          client,
        );
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const r of line.refunds) {
        // eslint-disable-next-line no-await-in-loop
        await db.execute(
          `INSERT INTO settlement_refunds
             (settlement_period_id, restaurant_id, refund_id, amount_snapshot, completed_at_snapshot)
           VALUES ($1,$2,$3,$4,$5)`,
          [periodId, line.restaurantId, r.refund_id, r.amount, r.completed_at],
          client,
        );
      }
    }

    // Шаги 7-8: перевести период в closed, зафиксировать closed_at.
    await db.execute(
      `UPDATE settlement_periods SET status = 'closed', closed_at = NOW() WHERE id = $1 AND status = 'draft'`,
      [periodId], client,
    );
    const closedRows = await db.query('SELECT * FROM settlement_periods WHERE id = $1', [periodId], client);

    // Шаг 9 (commit) — выполняется вызывающим serializableTransaction() при
    // успешном возврате из этой функции.
    return { period: closedRows[0], lines: insertedLines, alreadyClosed: false };
  }, { lockTimeoutMs: 5000 });
}

// ---------------------------------------------------------------------------
// Удаление черновика (задание, раздел 3: "draft можно удалить только если по
// нему ещё не созданы зафиксированные строки"). У ЛЮБОГО настоящего
// draft-периода зафиксированных строк структурно быть не может (они
// создаются ТОЛЬКО внутри closeSettlementPeriod, в той же транзакции, что и
// переход в closed) — проверка ниже тем не менее выполняется явно, тот же
// "trust but verify" принцип, что и весь этот файл, а не молчаливое
// допущение.
// ---------------------------------------------------------------------------
async function deleteDraftSettlementPeriod(periodId) {
  return db.transaction(async (client) => {
    const periodRows = await db.query('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE', [periodId], client);
    const period = periodRows[0];
    if (!period) throw new ValidationError('Расчётный период не найден.');
    if (period.status !== 'draft') {
      throw new ValidationError('Закрытый период нельзя удалить.');
    }
    const [{ c }] = await db.query(
      'SELECT COUNT(*)::int AS c FROM settlement_restaurant_lines WHERE settlement_period_id = $1',
      [periodId], client,
    );
    if (c > 0) {
      throw new ValidationError('У этого периода уже есть зафиксированные строки — удаление невозможно.');
    }
    await db.execute('DELETE FROM settlement_periods WHERE id = $1', [periodId], client);
    return period;
  });
}

// ---------------------------------------------------------------------------
// Чтение для UI (задание, раздел 9-10)
// ---------------------------------------------------------------------------

// Список периодов для секции «Расчётные периоды» на /hq/finance (задание,
// раздел 9). Для closed — читает ТОЛЬКО сохранённый snapshot (сумма по
// settlement_restaurant_lines), НИКОГДА не трогает orders/payments/refunds
// заново (задание, раздел 10: "не пересчитывать closed-период"). Для draft —
// live preview той же формулой, что и getSettlementPeriodDetail ниже.
async function listSettlementPeriods(now = new Date()) {
  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from DESC, id DESC');
  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const period of periods) {
    if (period.status === 'closed') {
      // eslint-disable-next-line no-await-in-loop
      const [summary] = await db.query(
        `SELECT
           COUNT(DISTINCT restaurant_id)::int AS restaurant_count,
           COALESCE(SUM(turnover), 0)::int AS turnover,
           COALESCE(SUM(yaam_commission), 0)::int AS commission,
           COALESCE(SUM(restaurant_earnings), 0)::int AS restaurant_earnings
         FROM settlement_restaurant_lines WHERE settlement_period_id = $1`,
        [period.id],
      );
      results.push({
        id: period.id, periodFrom: period.period_from, periodTo: period.period_to,
        status: period.status, createdAt: period.created_at, closedAt: period.closed_at,
        restaurantCount: summary.restaurant_count, turnover: summary.turnover,
        commission: summary.commission, restaurantEarnings: summary.restaurant_earnings,
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      const range = resolvePeriodRange({ period: 'custom', from: period.period_from, to: period.period_to }, now);
      // eslint-disable-next-line no-await-in-loop
      const { restaurantLines } = await computeSettlementPreview(range);
      results.push({
        id: period.id, periodFrom: period.period_from, periodTo: period.period_to,
        status: period.status, createdAt: period.created_at, closedAt: period.closed_at,
        restaurantCount: restaurantLines.length,
        turnover: restaurantLines.reduce((s, l) => s + l.turnover, 0),
        commission: restaurantLines.reduce((s, l) => s + l.yaamCommission, 0),
        restaurantEarnings: restaurantLines.reduce((s, l) => s + l.restaurantEarnings, 0),
      });
    }
  }
  return results;
}

// Детальная страница периода (задание, раздел 10). closed — ТОЛЬКО snapshot
// (нет ни одного запроса к orders/payments/refunds); draft — live preview.
async function getSettlementPeriodDetail(periodId, now = new Date()) {
  const period = await getSettlementPeriodById(periodId);
  if (!period) return null;

  if (period.status === 'closed') {
    const lines = await db.query(
      `SELECT srl.*, r.name AS restaurant_name
       FROM settlement_restaurant_lines srl
       JOIN restaurants r ON r.id = srl.restaurant_id
       WHERE srl.settlement_period_id = $1
       ORDER BY r.name`,
      [periodId],
    );
    return { period, lines, preview: false };
  }

  const range = resolvePeriodRange({ period: 'custom', from: period.period_from, to: period.period_to }, now);
  const { restaurantLines } = await computeSettlementPreview(range);
  const restaurantIds = restaurantLines.map((l) => l.restaurantId);
  const nameRows = restaurantIds.length
    ? await db.query('SELECT id, name FROM restaurants WHERE id = ANY($1::int[])', [restaurantIds])
    : [];
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  const lines = restaurantLines
    .map((l) => ({
      restaurant_id: l.restaurantId,
      restaurant_name: nameById.get(l.restaurantId) || `#${l.restaurantId}`,
      delivered_paid_orders: l.deliveredPaidOrders,
      turnover: l.turnover,
      yaam_commission: l.yaamCommission,
      restaurant_earnings: l.restaurantEarnings,
      successful_refunds_count: l.successfulRefundsCount,
      successful_refunds_amount: l.successfulRefundsAmount,
      payable_amount: l.payableAmount,
      payout_readiness_snapshot: l.payoutReadinessSnapshot,
      contract_number_snapshot: l.contractNumberSnapshot,
      commission_bps_summary: l.commissionBpsSummary,
    }))
    .sort((a, b) => a.restaurant_name.localeCompare(b.restaurant_name));

  return { period, lines, preview: true };
}

// ---------------------------------------------------------------------------
// Invariant checks (задание, раздел 14) — тестируемая health-функция, НЕ
// подключена ни к одному HTTP-маршруту (тот же принцип, что и
// restaurantFinanceService.checkFinancialInvariants в Stage 7).
// ---------------------------------------------------------------------------
async function checkSettlementInvariants() {
  const violations = [];

  // 1. closed период без единой строки обязательств — структурно может быть
  //    легитимным (реально пустой период), но заслуживает проверки владельцем
  //    YAAM, поэтому репортится как finding, а не молчаливо игнорируется.
  const emptyClosedRows = await db.query(`
    SELECT sp.id FROM settlement_periods sp
    WHERE sp.status = 'closed'
      AND NOT EXISTS (SELECT 1 FROM settlement_restaurant_lines srl WHERE srl.settlement_period_id = sp.id)
  `);
  if (emptyClosedRows.length > 0) {
    violations.push({ kind: 'closed_period_without_restaurant_lines', count: emptyClosedRows.length, periodIds: emptyClosedRows.map((r) => r.id) });
  }

  // 2. draft период с зафиксированными immutable-строками — структурно
  //    невозможно (см. комментарий у closeSettlementPeriod), проверяем данные.
  const draftWithLinesRows = await db.query(`
    SELECT sp.id FROM settlement_periods sp
    WHERE sp.status = 'draft'
      AND EXISTS (SELECT 1 FROM settlement_restaurant_lines srl WHERE srl.settlement_period_id = sp.id)
  `);
  if (draftWithLinesRows.length > 0) {
    violations.push({ kind: 'draft_period_with_committed_lines', count: draftWithLinesRows.length, periodIds: draftWithLinesRows.map((r) => r.id) });
  }

  // 3-4. один order_id / один refund_id в нескольких периодах — UNIQUE-
  //    ограничения делают это невозможным на уровне схемы; проверяем данные.
  const dupOrderRows = await db.query('SELECT order_id FROM settlement_order_lines GROUP BY order_id HAVING COUNT(*) > 1');
  if (dupOrderRows.length > 0) {
    violations.push({ kind: 'order_counted_in_multiple_periods', count: dupOrderRows.length });
  }
  const dupRefundRows = await db.query('SELECT refund_id FROM settlement_refunds GROUP BY refund_id HAVING COUNT(*) > 1');
  if (dupRefundRows.length > 0) {
    violations.push({ kind: 'refund_counted_in_multiple_periods', count: dupRefundRows.length });
  }

  // 5. сумма restaurant_lines расходится с независимым пересчётом по
  //    settlement_order_lines/settlement_refunds (те же snapshot-строки, из
  //    которых restaurant_lines изначально агрегировались).
  const mismatchRows = await db.query(`
    SELECT srl.id FROM settlement_restaurant_lines srl
    WHERE srl.turnover <> COALESCE((
      SELECT SUM(sol.items_total_snapshot)::int FROM settlement_order_lines sol
      WHERE sol.settlement_period_id = srl.settlement_period_id AND sol.restaurant_id = srl.restaurant_id
    ), 0)
    OR srl.successful_refunds_amount <> COALESCE((
      SELECT SUM(sr.amount_snapshot)::int FROM settlement_refunds sr
      WHERE sr.settlement_period_id = srl.settlement_period_id AND sr.restaurant_id = srl.restaurant_id
    ), 0)
  `);
  if (mismatchRows.length > 0) {
    violations.push({ kind: 'restaurant_line_sum_mismatch', count: mismatchRows.length });
  }

  // 6. payable_amount < 0.
  const negativeRows = await db.query('SELECT id FROM settlement_restaurant_lines WHERE payable_amount < 0');
  if (negativeRows.length > 0) {
    violations.push({ kind: 'negative_payable_amount', count: negativeRows.length });
  }

  // 7. turnover != commission + restaurant_earnings.
  const formulaMismatchRows = await db.query(
    'SELECT id FROM settlement_restaurant_lines WHERE turnover <> yaam_commission + restaurant_earnings',
  );
  if (formulaMismatchRows.length > 0) {
    violations.push({ kind: 'turnover_commission_earnings_mismatch', count: formulaMismatchRows.length });
  }

  // 8-9. closed без closed_at / draft с closed_at — уже CHECK на уровне
  //    схемы, проверяем данные явно.
  const closedWithoutClosedAt = await db.query("SELECT id FROM settlement_periods WHERE status = 'closed' AND closed_at IS NULL");
  if (closedWithoutClosedAt.length > 0) {
    violations.push({ kind: 'closed_period_without_closed_at', count: closedWithoutClosedAt.length });
  }
  const draftWithClosedAt = await db.query("SELECT id FROM settlement_periods WHERE status = 'draft' AND closed_at IS NOT NULL");
  if (draftWithClosedAt.length > 0) {
    violations.push({ kind: 'draft_period_with_closed_at', count: draftWithClosedAt.length });
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  ValidationError,
  MAX_NOTES_LENGTH,
  createDraftSettlementPeriod,
  getSettlementPeriodById,
  closeSettlementPeriod,
  deleteDraftSettlementPeriod,
  listSettlementPeriods,
  getSettlementPeriodDetail,
  checkSettlementInvariants,
  // экспортировано для тестов (unit-проверка "честной модели" bps без
  // поднятия БД).
  inferUniformCommissionBps,
};
