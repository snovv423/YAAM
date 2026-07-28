'use strict';

// YAAM HQ Stage 9 — Payout Entity Foundation (NO bank integration).
//
// АУДИТ ПЕРЕД РАЗРАБОТКОЙ (задание: "Работай как Principal Backend Architect
// ... сначала проведи аудит текущей архитектуры Stage 6 → Stage 8"):
//   - services/hq/restaurantPayoutService.js (Stage 6) — это НЕ эта сущность.
//     Тот файл считает READINESS (готовы ли юр.данные/банк.реквизиты/договор
//     ресторана) — чистая проверка полноты данных, ни одного денежного факта,
//     ни одной строки в базе. Имя "payout" в нём означает "готовность К
//     будущей выплате", не саму выплату. Совпадение слов в имени —
//     НАМЕРЕННО НЕ переиспользовано для этого нового файла (другое имя:
//     payoutService.js, не restaurantPayoutService.js) — во избежание
//     путаницы между "готовностью" (Stage 6) и "фактом попытки выплаты"
//     (Stage 9, эта сущность).
//   - services/hq/settlementService.js (Stage 8) — остаётся ЕДИНСТВЕННЫМ
//     источником суммы к выплате: settlement_restaurant_lines.payable_amount
//     уже immutable (Stage 8 snapshot-триггеры). Этот файл НИКОГДА не читает
//     orders/payments/refunds и не пересчитывает сумму — только копирует
//     payable_amount РОВНО ОДИН РАЗ в момент prepareRestaurantPayout().
//   - Главное правило задания: "Закрытый расчётный период фиксирует долг
//     YAAM перед рестораном. Выплата — это отдельная сущность. Расчётный
//     период никогда не означает автоматически, что деньги отправлены." —
//     ничего в этом файле не переводит деньги ни при каком статусе; статусы
//     succeeded/failed фиксируют РЕЗУЛЬТАТ будущей (в Stage 10) банковской
//     операции, не выполняют её сами.
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ (отклонение от буквальной формулировки задания,
// см. полное обоснование в db/postgresql/schema.sql, комментарий над
// restaurant_payouts): "один закрытый период — максимум одна выплата"
// реализовано как "максимум одна выплата НА ПАРУ (период, ресторан)", а не
// одна выплата на период в целом — settlement_restaurant_lines уже хранит
// ОТДЕЛЬНОЕ обязательство на каждый ресторан периода, и у каждого ресторана
// свои банковские реквизиты, так что единая "одна выплата на весь период"
// была бы архитектурно некорректна для периода с несколькими ресторанами.
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');

const STATUSES = ['prepared', 'processing', 'succeeded', 'failed'];
const TERMINAL_STATUSES = ['succeeded', 'failed'];

const STATUS_LABELS = {
  prepared: 'Подготовлена',
  processing: 'В обработке',
  succeeded: 'Успешно',
  failed: 'Ошибка',
};

// ---------------------------------------------------------------------------
// Подготовка выплаты (задание: "prepareRestaurantPayout()")
// ---------------------------------------------------------------------------
//
// Проверки (задание, дословно): период закрыт; выплаты ещё нет; сумма > 0.
// Сумма ЧИТАЕТСЯ, не пересчитывается — единственный SELECT здесь идёт в
// settlement_restaurant_lines, ни разу в orders/payments/refunds.
//
// Гонка (два одновременных вызова prepareRestaurantPayout на одну и ту же
// пару период+ресторан) закрыта на уровне схемы: UNIQUE(settlement_period_id,
// restaurant_id) на restaurant_payouts — проигравший INSERT получит SQLSTATE
// 23505, превращаемую здесь в понятную ValidationError. Отдельная
// SERIALIZABLE-транзакция для этого не нужна (тот же принцип, что и
// reserveRefundRow() в orderService.js — "INSERT + partial/обычный UNIQUE
// как последняя линия защиты" дешевле полной сериализации для простого
// insert-once сценария).
async function prepareRestaurantPayout(settlementPeriodId, restaurantId, { createdBy = null, notes = '' } = {}) {
  const lineRows = await db.query(
    `SELECT srl.*, sp.status AS period_status
     FROM settlement_restaurant_lines srl
     JOIN settlement_periods sp ON sp.id = srl.settlement_period_id
     WHERE srl.settlement_period_id = $1 AND srl.restaurant_id = $2`,
    [settlementPeriodId, restaurantId],
  );
  const line = lineRows[0];
  if (!line) {
    throw new ValidationError('Для этого ресторана нет зафиксированной строки обязательства в этом периоде.');
  }
  if (line.period_status !== 'closed') {
    throw new ValidationError('Период ещё не закрыт — подготовить выплату нельзя.');
  }
  if (line.payable_amount <= 0) {
    throw new ValidationError('Сумма к выплате не положительна — подготавливать нечего.');
  }

  const trimmedNotes = String(notes || '').trim().slice(0, 500);
  try {
    const inserted = await db.execute(
      `INSERT INTO restaurant_payouts (restaurant_id, settlement_period_id, amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [restaurantId, settlementPeriodId, line.payable_amount, trimmedNotes, createdBy || ''],
    );
    return inserted.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw new ValidationError('Для этой пары (период, ресторан) выплата уже существует.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Переходы состояний (задание: "Продумай корректную state machine")
// ---------------------------------------------------------------------------
//
// Каждая функция — явная app-level проверка ДО попытки UPDATE (понятная
// ValidationError вместо сырой ошибки триггера БД для штатного вызывающего
// кода), а conditional UPDATE ... WHERE status = ANY(...) — вторая,
// независимая линия защиты от гонки (тот же принцип, что markPaid()/
// restaurantAccept() в orderService.js). ТРЕТЬЯ линия — DB-триггеры
// fn_restaurant_payouts_valid_transition/fn_restaurant_payouts_immutable_after_terminal
// (db/postgresql/schema.sql) — отклонят даже гипотетическую ошибку в этом
// самом файле. rowCount!==1 после conditional UPDATE означает, что статус
// изменился между SELECT и UPDATE (проиграна гонка) — сообщаем об этом
// понятной ошибкой, не тихим no-op (в отличие от markPaid, где повторный
// вызов ожидаем и штатен, здесь HQ-оператор должен явно увидеть, что переход
// не применился).
async function getPayoutById(payoutId) {
  const numericId = Number.parseInt(payoutId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM restaurant_payouts WHERE id = $1', [numericId]);
  return rows[0] || null;
}

async function requirePayout(payoutId) {
  const payout = await getPayoutById(payoutId);
  if (!payout) throw new ValidationError('Выплата не найдена.');
  return payout;
}

async function markProcessing(payoutId, { externalPayoutId = null } = {}) {
  const current = await requirePayout(payoutId);
  if (current.status !== 'prepared') {
    throw new ValidationError(`Нельзя перевести в processing из статуса "${current.status}" (разрешено только из "prepared").`);
  }
  const updated = await db.execute(
    `UPDATE restaurant_payouts
       SET status = 'processing', processing_at = NOW(), updated_at = NOW(),
           external_payout_id = COALESCE($2, external_payout_id)
     WHERE id = $1 AND status = 'prepared'
     RETURNING *`,
    [payoutId, externalPayoutId],
  );
  if (updated.rowCount !== 1) {
    throw new ValidationError('Не удалось перевести выплату в processing — статус уже изменился (гонка).');
  }
  return updated.rows[0];
}

async function markSucceeded(payoutId, { externalPayoutId = null } = {}) {
  const current = await requirePayout(payoutId);
  if (current.status !== 'processing') {
    throw new ValidationError(`Нельзя перевести в succeeded из статуса "${current.status}" (разрешено только из "processing").`);
  }
  const updated = await db.execute(
    `UPDATE restaurant_payouts
       SET status = 'succeeded', completed_at = NOW(), updated_at = NOW(),
           external_payout_id = COALESCE($2, external_payout_id)
     WHERE id = $1 AND status = 'processing'
     RETURNING *`,
    [payoutId, externalPayoutId],
  );
  if (updated.rowCount !== 1) {
    throw new ValidationError('Не удалось перевести выплату в succeeded — статус уже изменился (гонка).');
  }
  return updated.rows[0];
}

// failed разрешён и из prepared (отказ на этапе валидации реквизитов, ещё до
// обращения к провайдеру), и из processing (реальный сетевой/провайдерский
// отказ) — задание запрещает ТОЛЬКО "failed -> processing" и "prepared ->
// succeeded", про "prepared -> failed" запрета нет, и оба сценария реальны
// (см. db/postgresql/schema.sql, комментарий у CHECK-ограничения).
async function markFailed(payoutId, { failureReason }) {
  if (!failureReason || !String(failureReason).trim()) {
    throw new ValidationError('failureReason обязателен для перехода в failed.');
  }
  const current = await requirePayout(payoutId);
  if (!['prepared', 'processing'].includes(current.status)) {
    throw new ValidationError(`Нельзя перевести в failed из статуса "${current.status}" (разрешено только из "prepared" или "processing").`);
  }
  const updated = await db.execute(
    `UPDATE restaurant_payouts
       SET status = 'failed', failed_at = NOW(), updated_at = NOW(), failure_reason = $2
     WHERE id = $1 AND status = ANY($3::text[])
     RETURNING *`,
    [payoutId, String(failureReason).trim().slice(0, 500), ['prepared', 'processing']],
  );
  if (updated.rowCount !== 1) {
    throw new ValidationError('Не удалось перевести выплату в failed — статус уже изменился (гонка).');
  }
  return updated.rows[0];
}

// ---------------------------------------------------------------------------
// Чтение для UI (задание: HQ "Выплаты" read-only + карточка + settlement-
// индикатор + dashboard-статистика)
// ---------------------------------------------------------------------------

async function getPayoutForSettlementLine(settlementPeriodId, restaurantId) {
  const rows = await db.query(
    'SELECT * FROM restaurant_payouts WHERE settlement_period_id = $1 AND restaurant_id = $2',
    [settlementPeriodId, restaurantId],
  );
  return rows[0] || null;
}

// Один запрос вместо N+1 по количеству строк периода (задание, раздел
// Settlement: "рядом показать «Выплата создана»/«Не создана»" для КАЖДОЙ
// строки ресторана периода).
async function listPayoutsForPeriod(settlementPeriodId) {
  const rows = await db.query('SELECT * FROM restaurant_payouts WHERE settlement_period_id = $1', [settlementPeriodId]);
  return new Map(rows.map((r) => [r.restaurant_id, r]));
}

async function listPayouts() {
  return db.query(`
    SELECT rp.*, r.name AS restaurant_name, sp.period_from, sp.period_to
    FROM restaurant_payouts rp
    JOIN restaurants r ON r.id = rp.restaurant_id
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    ORDER BY rp.created_at DESC, rp.id DESC
  `);
}

async function getPayoutDetail(payoutId) {
  const rows = await db.query(`
    SELECT rp.*, r.name AS restaurant_name, sp.period_from, sp.period_to, sp.status AS period_status
    FROM restaurant_payouts rp
    JOIN restaurants r ON r.id = rp.restaurant_id
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    WHERE rp.id = $1
  `, [payoutId]);
  return rows[0] || null;
}

// Dashboard-статистика (задание: "Количество подготовленных/успешных/ошибок;
// общая сумма подготовленных/успешных. Без графиков.") — "подготовленных"
// трактуется как ЛЮБАЯ выплата, которая была подготовлена и ЕЩЁ НЕ провалена
// (prepared+processing+succeeded — реально "в работе или доведена до
// конца"), отдельно от "успешных" (только succeeded). Одна строка агрегации,
// не 5 отдельных запросов.
async function getPayoutDashboardStats() {
  const [row] = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('prepared', 'processing', 'succeeded'))::int AS prepared_count,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('prepared', 'processing', 'succeeded')), 0)::int AS prepared_amount,
      COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0)::int AS succeeded_amount
    FROM restaurant_payouts
  `);
  return {
    preparedCount: row.prepared_count,
    succeededCount: row.succeeded_count,
    failedCount: row.failed_count,
    preparedAmount: row.prepared_amount,
    succeededAmount: row.succeeded_amount,
  };
}

// ---------------------------------------------------------------------------
// Invariant checks — тот же принцип, что checkFinancialInvariants (Stage 7)
// и checkSettlementInvariants (Stage 8): тестируемая health-функция, НЕ
// подключена ни к одному HTTP-маршруту.
// ---------------------------------------------------------------------------
async function checkPayoutInvariants() {
  const violations = [];

  // 1. amount не совпадает с settlement_restaurant_lines.payable_amount —
  //    структурно невозможно (amount копируется один раз при создании,
  //    строка после этого immutable с обеих сторон), но проверяем данные.
  const amountMismatchRows = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    JOIN settlement_restaurant_lines srl
      ON srl.settlement_period_id = rp.settlement_period_id AND srl.restaurant_id = rp.restaurant_id
    WHERE rp.amount <> srl.payable_amount
  `);
  if (amountMismatchRows.length > 0) {
    violations.push({ kind: 'payout_amount_mismatch', count: amountMismatchRows.length });
  }

  // 2. более одной выплаты на пару (период, ресторан) — UNIQUE делает это
  //    невозможным на уровне схемы, проверяем данные явно.
  const dupRows = await db.query(`
    SELECT settlement_period_id, restaurant_id FROM restaurant_payouts
    GROUP BY settlement_period_id, restaurant_id HAVING COUNT(*) > 1
  `);
  if (dupRows.length > 0) {
    violations.push({ kind: 'multiple_payouts_for_same_period_restaurant', count: dupRows.length });
  }

  // 3. succeeded без processing_at — CHECK на уровне схемы уже это
  //    запрещает, но проверяем данные (trust but verify, тот же принцип).
  const succeededWithoutProcessing = await db.query(
    "SELECT id FROM restaurant_payouts WHERE status = 'succeeded' AND processing_at IS NULL",
  );
  if (succeededWithoutProcessing.length > 0) {
    violations.push({ kind: 'succeeded_without_processing', count: succeededWithoutProcessing.length });
  }

  // 4. amount <= 0 — CHECK(amount > 0) уже это запрещает на уровне схемы.
  const nonPositiveRows = await db.query('SELECT id FROM restaurant_payouts WHERE amount <= 0');
  if (nonPositiveRows.length > 0) {
    violations.push({ kind: 'non_positive_amount', count: nonPositiveRows.length });
  }

  // 5. payout для периода, который на самом деле НЕ closed — FOREIGN KEY на
  //    settlement_restaurant_lines гарантирует существование строки, но НЕ
  //    гарантирует, что период остался closed (хотя closed периоды сами
  //    immutable — Stage 8 — так что это тоже структурно невозможно).
  const payoutForNonClosedPeriod = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    WHERE sp.status <> 'closed'
  `);
  if (payoutForNonClosedPeriod.length > 0) {
    violations.push({ kind: 'payout_for_non_closed_period', count: payoutForNonClosedPeriod.length });
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  ValidationError,
  STATUSES,
  TERMINAL_STATUSES,
  STATUS_LABELS,
  prepareRestaurantPayout,
  markProcessing,
  markSucceeded,
  markFailed,
  getPayoutById,
  getPayoutForSettlementLine,
  listPayoutsForPeriod,
  listPayouts,
  getPayoutDetail,
  getPayoutDashboardStats,
  checkPayoutInvariants,
};
