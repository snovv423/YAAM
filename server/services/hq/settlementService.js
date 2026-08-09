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
//   - Период заработка — orders.earned_at (Stage 33.1, доказательство:
//     restaurantFinanceService.js, раздел "Якорь времени"; было
//     status_updated_at до Stage 33.1 — см. её отчёт). Период возврата —
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
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./dashboardMetrics');
const financeService = require('./restaurantFinanceService');
const payoutService = require('./restaurantPayoutService');
const contractService = require('./restaurantContractService');
const legalService = require('./restaurantLegalDetailsService');
const yaamBankDetailsService = require('./yaamBankDetailsService');
const yaamLegalDetailsService = require('./yaamLegalDetailsService');
const adjustmentService = require('./settlementAdjustmentService');
const balanceService = require('./restaurantBalanceService');
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
// STAGE33.1 — якорь диапазона earned_at, НЕ status_updated_at (см.
// restaurantFinanceService.js, комментарий над pushRangeConditions):
// status_updated_at заказа в 'delivered' теперь зависит от клиентского
// клика/auto-complete, earned_at — нет, зафиксирован атомарно на
// ready->courier (delivery) / preparing->delivered (pickup) и больше не
// переписывается. AS status_updated_at ниже — совместимость имени поля
// для остального кода этого файла (closeSettlementPeriod пишет его как
// settlement_order_lines.delivered_at_snapshot); значение теперь earned_at.
async function fetchEarnedOrderRows(range, client = null) {
  return db.query(
    `SELECT o.id AS order_id, o.restaurant_id, o.items_total, o.commission_amount, o.earned_at AS status_updated_at
     FROM orders o
     WHERE ${financeService.EARNED_ORDER_FILTER_SQL}
       AND o.earned_at >= $1 AND o.earned_at < $2
     ORDER BY o.id`,
    [range.startUtc, range.endUtc],
    client,
  );
}

// Успешные возвраты периода — построчно, тот же anchor (refunds.completed_at,
// Stage 7.1), тот же принцип "не delivered-only" (Stage 7.1 отчёт).
//
// Stage 37.2 — ограничена financeService.SALE_REVERSING_REFUND_REASONS (тот
// же единственный список, что и EARNED_ORDER_FILTER_SQL/
// computeRefundsAggregate). Эта функция кормит ОБА последующих места: (1)
// buildRestaurantLines() — «Возвраты» строки периода, тот же принцип «это не
// сторно продажи ресторана», что и у computeRefundsAggregate; (2)
// findLateRefundAdjustments() ниже — duplicate_payment refund не должен
// порождать late_refund adjustment/долг ресторана (задание Stage 37.2,
// раздел 7). Один choke point на оба места — не нужно чинить их порознь.
async function fetchSucceededRefundRows(range, client = null) {
  return db.query(
    `SELECT rf.id AS refund_id, o.restaurant_id, rf.amount, rf.completed_at
     FROM refunds rf
     JOIN payments p ON p.id = rf.payment_id
     JOIN orders o ON o.id = p.order_id
     WHERE rf.status = 'succeeded'
       AND rf.reason IN (${financeService.SALE_REVERSING_REFUND_REASONS_SQL})
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
// Best-effort чтение юридических данных YAAM. Та же причина, что и у
// safeReadYaamDetails: это метаданные ДЛЯ ДОКУМЕНТА, а не часть финансового
// расчёта — их отсутствие (в том числе отсутствие самой таблицы на legacy-БД)
// не должно блокировать бухгалтерское закрытие периода.
async function safeReadYaamLegal() {
  try {
    return await yaamLegalDetailsService.getYaamLegalDetails();
  } catch (err) {
    console.error('[settlementService] юридические данные YAAM недоступны для снимка периода:', err.message);
    return null;
  }
}

// Best-effort чтение реквизитов YAAM — см. вызов в buildRestaurantLines.
async function safeReadYaamDetails() {
  try {
    return await yaamBankDetailsService.getYaamBankDetails();
  } catch (err) {
    console.error('[settlementService] реквизиты YAAM недоступны для снимка периода:', err.message);
    return null;
  }
}

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
    const [payout, contract, legal, restaurantRow, yaamDetails, yaamLegal] = await Promise.all([
      payoutService.getRestaurantPayoutDetails(restaurantId),
      contractService.getContract(restaurantId),
      legalService.getLegalDetails(restaurantId),
      db.query('SELECT name FROM restaurants WHERE id = $1', [restaurantId]),
      // Реквизиты YAAM — метаданные ДЛЯ ДОКУМЕНТА, а не часть финансового
      // расчёта: их отсутствие не должно блокировать бухгалтерское закрытие
      // периода. Сюда же попадает случай legacy-БД, где таблицы
      // yaam_bank_details ещё нет вовсе (миграция со Stage 9) — тогда снимок
      // просто пустой, и документ честно покажет «не указано».
      safeReadYaamDetails(),
      safeReadYaamLegal(),
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
      // Снимки юридических данных на момент ЗАКРЫТИЯ (docs/HQ-PRODUCT-SPEC.md,
      // раздел «Immutable snapshot периода»): документ строится только из
      // них, поэтому последующая правка названия/ИНН/договора/реквизитов
      // YAAM не может изменить уже выпущенный отчёт. null там, где данных
      // нет — честное отсутствие, не выдуманное значение.
      restaurantNameSnapshot: restaurantRow[0] ? restaurantRow[0].name : null,
      legalNameSnapshot: legal ? legal.legal_name : null,
      legalFormSnapshot: legal ? legal.legal_form : null,
      innSnapshot: legal ? legal.inn : null,
      ogrnSnapshot: legal ? legal.ogrn : null,
      legalAddressSnapshot: legal ? legal.legal_address : null,
      contractSignedAtSnapshot: contract ? contract.signed_at : null,
      // Юридические данные YAAM — из yaam_legal_details (Stage 14), это их
      // настоящий источник. Fallback на yaam_bank_details сохранён для баз,
      // где юр.данные ещё не заполнены: там раньше лежали legal_name/inn, и
      // терять их при закрытии периода нельзя.
      yaamLegalNameSnapshot: (yaamLegal && yaamLegal.legal_name)
        || (yaamDetails ? yaamDetails.legal_name : null),
      yaamInnSnapshot: (yaamLegal && yaamLegal.inn) || (yaamDetails ? yaamDetails.inn : null),
      // КПП у ИП не бывает — остаётся только из банковских реквизитов, если
      // там что-то заполнено (актуально для формы ООО в будущем).
      yaamKppSnapshot: yaamDetails ? yaamDetails.kpp : null,
      yaamOgrnipSnapshot: yaamLegal ? yaamLegal.ogrnip : null,
      yaamAddressSnapshot: yaamLegal ? yaamLegal.registration_address : null,
      yaamEntrepreneurNameSnapshot: yaamLegal ? yaamLegal.entrepreneur_name : null,
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

// Недели (по времени проекта), в которых ЕСТЬ хоть одна финансово значимая
// операция: заработанный заказ либо успешный возврат.
//
// ЗАЧЕМ ИМЕННО ЗАПРОСОМ. Автоматическому закрытию нужно знать, с какой недели
// начинается непокрытый backlog. Перебирать недели назад «на всякий случай»
// нельзя: без предела это бесконечное сканирование пустой истории, а с
// пределом (раньше здесь стояло 120 недель) активная неделя старше предела
// молча выпадала бы из очереди. Правильная нижняя граница берётся из самих
// данных — эта функция и есть её источник.
//
// Оба anchor'а те же, что и во всём расчёте: orders.earned_at для заказов
// (Stage 33.1 — было status_updated_at до неё, см. её отчёт) и
// refunds.completed_at для возвратов (Stage 7.1). date_trunc('week') в
// PostgreSQL даёт понедельник — ровно ту границу недели, которой пользуется
// weeklySettlementService.
//
// Смещение времени проекта применяется до date_trunc: иначе воскресный вечер
// по Москве попал бы в предыдущую неделю по UTC.
async function listWeeksWithFinancialActivity(client = null) {
  const rows = await db.query(
    `WITH activity AS (
       SELECT date_trunc(
                'week',
                (o.earned_at AT TIME ZONE 'UTC') + make_interval(mins => $1)
              )::date AS week_start
         FROM orders o
        WHERE ${financeService.EARNED_ORDER_FILTER_SQL}
          AND o.earned_at IS NOT NULL
       UNION
       SELECT date_trunc(
                'week',
                (rf.completed_at AT TIME ZONE 'UTC') + make_interval(mins => $1)
              )::date
         FROM refunds rf
         JOIN payments p ON p.id = rf.payment_id
         JOIN orders o2 ON o2.id = p.order_id
        WHERE rf.status = 'succeeded' AND rf.completed_at IS NOT NULL
     )
     SELECT week_start FROM activity ORDER BY week_start`,
    [PROJECT_TIMEZONE_OFFSET_MINUTES],
    client,
  );
  return rows.map((r) => (r.week_start instanceof Date
    ? r.week_start.toISOString().slice(0, 10)
    : String(r.week_start).slice(0, 10)));
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
    const { restaurantLines, refundRows } = await computeSettlementPreview(range, client);

    // Шаг 4a: СТОРНО ПОЗДНИХ ВОЗВРАТОВ. Возврат, чей заказ был начислен в уже
    // закрытом ПРЕДЫДУЩЕМ периоде, уменьшает обязательство этого периода —
    // иначе ресторан получил бы деньги за заказ, возвращённый покупателю
    // (services/hq/settlementAdjustmentService.js объясняет модель целиком).
    // Считается до вставки строк: суммы строки уже должны учитывать сторно.
    const lateAdjustments = await adjustmentService.findLateRefundAdjustments(periodId, refundRows, client);
    const adjustmentsByRestaurant = adjustmentService.summarizeByRestaurant(lateAdjustments);

    // Шаги 5-6: сформировать строки обязательств + immutable snapshot.
    const insertedLines = [];
    // Аудит переноса долга пишется ПОСЛЕ коммита: событие о непроизошедшей
    // (откатившейся) операции хуже отсутствия события.
    const carryEvents = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const line of restaurantLines) {
      // eslint-disable-next-line no-await-in-loop
      // Сторно уменьшает именно payable_amount: turnover/yaam_commission
      // остаются «начислено за период», а не переписываются — иначе нельзя
      // было бы отличить «продали меньше» от «вернули за прошлый период».
      const adj = adjustmentsByRestaurant.get(line.restaurantId)
        || { restaurantAmount: 0, commissionAmount: 0 };
      const netEarnings = line.payableAmount - adj.restaurantAmount;

      // ПЕРЕНОС ДОЛГА. Блокирует строку баланса ресторана до конца этой
      // транзакции — именно здесь два одновременных закрытия сериализуются и
      // не могут удержать один долг дважды.
      // eslint-disable-next-line no-await-in-loop
      const carry = await balanceService.applyCarryForward(
        { restaurantId: line.restaurantId, periodId, netEarnings },
        client,
      );
      carryEvents.push({ restaurantId: line.restaurantId, ...carry });

      const insertedLine = await db.execute(
        `INSERT INTO settlement_restaurant_lines
           (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
            restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
            payout_readiness_snapshot, contract_number_snapshot, commission_bps_summary,
            restaurant_name_snapshot, legal_name_snapshot, legal_form_snapshot, inn_snapshot,
            ogrn_snapshot, legal_address_snapshot, contract_signed_at_snapshot,
            yaam_legal_name_snapshot, yaam_inn_snapshot, yaam_kpp_snapshot,
            refund_adjustment_restaurant_amount, refund_adjustment_commission,
            carry_forward_applied, carry_forward_remaining,
            yaam_ogrnip_snapshot, yaam_address_snapshot, yaam_entrepreneur_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
        [
          periodId, line.restaurantId, line.deliveredPaidOrders, line.turnover, line.yaamCommission,
          line.restaurantEarnings, line.successfulRefundsCount, line.successfulRefundsAmount,
          carry.payable,
          line.payoutReadinessSnapshot, line.contractNumberSnapshot, line.commissionBpsSummary,
          line.restaurantNameSnapshot, line.legalNameSnapshot, line.legalFormSnapshot, line.innSnapshot,
          line.ogrnSnapshot, line.legalAddressSnapshot, line.contractSignedAtSnapshot,
          line.yaamLegalNameSnapshot, line.yaamInnSnapshot, line.yaamKppSnapshot,
          adj.restaurantAmount, adj.commissionAmount,
          carry.debtSettled, carry.closingDebt,
          line.yaamOgrnipSnapshot, line.yaamAddressSnapshot, line.yaamEntrepreneurNameSnapshot,
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

    // Шаг 6a: записать сами корректировки — в той же транзакции, что и строки,
    // которые они уменьшают. Порознь появиться не могут.
    await adjustmentService.insertAdjustments(periodId, lateAdjustments, client);

    // Шаги 7-8: перевести период в closed, зафиксировать closed_at.
    await db.execute(
      `UPDATE settlement_periods SET status = 'closed', closed_at = NOW() WHERE id = $1 AND status = 'draft'`,
      [periodId], client,
    );
    const closedRows = await db.query('SELECT * FROM settlement_periods WHERE id = $1', [periodId], client);

    // Шаг 9 (commit) — выполняется вызывающим serializableTransaction() при
    // успешном возврате из этой функции.
    return { period: closedRows[0], lines: insertedLines, alreadyClosed: false, carryEvents };
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
// Пользовательский статус ЗАКРЫТОГО периода (docs/HQ-PRODUCT-SPEC.md,
// раздел «Статусы расчётного периода»). Одно слово «Закрыт» намеренно НЕ
// используется как единственный статус: период может быть бухгалтерски
// закрыт, а выплаты по нему ещё не завершены.
//
//   awaiting_payouts — ни одна выплата периода не завершена успешно;
//   partially_paid   — часть ресторанов с положительной суммой выплачена;
//   paid             — выплачены все, кому причиталось.
// Период без единой строки с payable_amount > 0 (например, только возвраты)
// считается закрытым и полностью рассчитанным — платить некому.
function resolvePeriodPayoutStatus({ payableLines, payoutsSucceeded }) {
  if (payableLines === 0) return 'paid';
  if (payoutsSucceeded === 0) return 'awaiting_payouts';
  if (payoutsSucceeded >= payableLines) return 'paid';
  return 'partially_paid';
}

const PERIOD_PAYOUT_STATUS_LABELS = {
  awaiting_payouts: 'Ожидает выплат',
  partially_paid: 'Выплачен частично',
  paid: 'Выплачен',
};

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
           -- «Ресторанам» на карточке — это то, что РЕАЛЬНО причитается за
           -- период, то есть payable_amount со сторно, а не начисленное до
           -- удержаний. Иначе сводка обещала бы больше, чем будет выплачено.
           COALESCE(SUM(payable_amount), 0)::int AS restaurant_earnings,
           COALESCE(SUM(refund_adjustment_restaurant_amount), 0)::int AS adjustment_amount,
           COALESCE(SUM(successful_refunds_amount), 0)::int AS refunds_amount,
           COALESCE(SUM(successful_refunds_count), 0)::int AS refunds_count,
           COUNT(*) FILTER (WHERE payable_amount > 0)::int AS payable_lines
         FROM settlement_restaurant_lines WHERE settlement_period_id = $1`,
        [period.id],
      );
      // eslint-disable-next-line no-await-in-loop
      const [payoutSummary] = await db.query(
        `SELECT
           COUNT(*)::int AS payouts_total,
           COUNT(*) FILTER (WHERE status = 'succeeded')::int AS payouts_succeeded
         FROM restaurant_payouts WHERE settlement_period_id = $1`,
        [period.id],
      );
      results.push({
        id: period.id, periodFrom: period.period_from, periodTo: period.period_to,
        status: period.status, createdAt: period.created_at, closedAt: period.closed_at,
        restaurantCount: summary.restaurant_count, turnover: summary.turnover,
        commission: summary.commission, restaurantEarnings: summary.restaurant_earnings,
        refundsAmount: summary.refunds_amount, refundsCount: summary.refunds_count,
        adjustmentAmount: summary.adjustment_amount,
        payoutStatus: resolvePeriodPayoutStatus({
          payableLines: summary.payable_lines,
          payoutsSucceeded: payoutSummary.payouts_succeeded,
        }),
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
    // Состояние выплаты подтягивается СРАЗУ (LEFT JOIN), чтобы детальная
    // страница не делала N+1 запросов и не собирала статус в шаблоне.
    // restaurant_name — из snapshot закрытого периода, а не из текущей
    // таблицы: переименование ресторана не должно менять закрытый период.
    const lines = await db.query(
      `SELECT srl.*,
              COALESCE(srl.restaurant_name_snapshot, r.name) AS restaurant_name,
              rp.id AS payout_id, rp.status AS payout_status,
              rp.completed_at AS payout_completed_at, rp.failure_reason AS payout_failure_reason
       FROM settlement_restaurant_lines srl
       JOIN restaurants r ON r.id = srl.restaurant_id
       LEFT JOIN restaurant_payouts rp
              ON rp.settlement_period_id = srl.settlement_period_id
             AND rp.restaurant_id = srl.restaurant_id
       WHERE srl.settlement_period_id = $1
       ORDER BY COALESCE(srl.restaurant_name_snapshot, r.name)`,
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

  // 6. payable_amount < 0 БЕЗ объяснения корректировкой.
  //
  // Отрицательный остаток сам по себе — законное состояние: поздний возврат
  // может превысить продажи периода, и тогда ресторан должен YAAM. Обнулять
  // такой остаток нельзя (это подарило бы ресторану деньги, уже возвращённые
  // покупателю), выплатить его тоже нельзя — он помечен payout_blocked_reason
  // и переносится в следующий период. Нарушение — только отрицательная сумма,
  // не покрытая сторно: она означала бы ошибку расчёта, а не долг.
  const negativeRows = await db.query(
    `SELECT id FROM settlement_restaurant_lines
      WHERE payable_amount < 0 AND refund_adjustment_restaurant_amount = 0`,
  );
  if (negativeRows.length > 0) {
    violations.push({ kind: 'negative_payable_amount', count: negativeRows.length });
  }

  // 6a. Сумма сторно в строке обязана совпадать с суммой её корректировок.
  const adjustmentMismatch = await db.query(`
    SELECT srl.id FROM settlement_restaurant_lines srl
    WHERE srl.refund_adjustment_restaurant_amount <> COALESCE((
      SELECT SUM(sa.restaurant_amount)::int FROM settlement_adjustments sa
      WHERE sa.settlement_period_id = srl.settlement_period_id AND sa.restaurant_id = srl.restaurant_id
    ), 0)
    OR srl.refund_adjustment_commission <> COALESCE((
      SELECT SUM(sa.commission_amount)::int FROM settlement_adjustments sa
      WHERE sa.settlement_period_id = srl.settlement_period_id AND sa.restaurant_id = srl.restaurant_id
    ), 0)
  `);
  if (adjustmentMismatch.length > 0) {
    violations.push({ kind: 'adjustment_sum_mismatch', count: adjustmentMismatch.length });
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

// Диапазон недели по её DATE-границам — ЕДИНСТВЕННОЕ место, где даты
// периода превращаются в UTC-интервал расчёта. Экспортировано, чтобы
// weeklySettlementService не заводил второе, потенциально расходящееся
// определение границ (задание, раздел 2: заказ не может попасть в два
// периода).
function resolvePeriodRangeForPeriod(periodFrom, periodTo, now = new Date()) {
  return resolvePeriodRange({ period: 'custom', from: periodFrom, to: periodTo }, now);
}

module.exports = {
  ValidationError,
  MAX_NOTES_LENGTH,
  computeSettlementPreview,
  listWeeksWithFinancialActivity,
  resolvePeriodRangeForPeriod,
  resolvePeriodPayoutStatus,
  PERIOD_PAYOUT_STATUS_LABELS,
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
