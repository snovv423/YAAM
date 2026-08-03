'use strict';

// YAAM HQ — расчётные документы периода: «Отчёт агента» и «Реестр заказов»
// (docs/HQ-PRODUCT-SPEC.md, раздел «Расчётные периоды и документы»).
//
// АРХИТЕКТУРНАЯ ГРАНИЦА (задание, раздел 10) — намеренно разделены:
//   1. МОДЕЛЬ ДАННЫХ  — этот файл: строит payload документа ТОЛЬКО из
//      immutable snapshot периода (settlement_restaurant_lines /
//      settlement_order_lines / settlement_refunds), никогда не читая
//      текущие orders/payments/restaurants заново;
//   2. RENDERER       — hq/settlementDocumentViews.js: payload -> HTML;
//   3. STORAGE        — сама таблица settlement_documents (payload JSONB);
//      файловое хранилище не вводится, потому что документ детерминированно
//      воспроизводится из payload в любой момент;
//   4. ВЫДАЧА         — routes/hq/settlements.js, только внутри HQ-сессии,
//      с проверкой принадлежности документа паре (период, ресторан).
//
// Деньги — целые рубли (INTEGER), как и во всей остальной схеме. Ни одного
// float в расчётах документа: суммы берутся из snapshot как есть.
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');
const { logAuditEvent } = require('./auditLog');

const DOCUMENT_KINDS = ['agent_report', 'order_registry'];

const DOCUMENT_KIND_LABELS = {
  agent_report: 'Отчёт агента',
  order_registry: 'Реестр заказов',
};

// ЮРИДИЧЕСКИ НЕПОДТВЕРЖДЁННЫЙ ТЕКСТ СЮДА НЕ ПИШЕТСЯ (задание, раздел 7).
// Срок принятия отчёта и порядок возражений — предмет агентского договора,
// который на текущем этапе не утверждён. Формулировка берётся ТОЛЬКО из
// конфигурации; если её нет — документ честно показывает, что условие ещё
// не согласовано, вместо выдуманной фразы.
const ACCEPTANCE_TERMS_ENV = 'YAAM_AGENT_REPORT_ACCEPTANCE_TERMS';

function resolveAcceptanceTerms(env = process.env) {
  const configured = String(env[ACCEPTANCE_TERMS_ENV] || '').trim();
  if (configured) return { text: configured, pending: false };
  return { text: null, pending: true };
}

// Номер документа: YAAM-АО-2026-0001 / YAAM-РЗ-2026-0001 (+ «-и2» у
// корректирующей версии). Уникальность гарантирует UNIQUE(document_number) —
// счётчик ниже только предлагает следующий свободный номер.
const KIND_CODE = { agent_report: 'АО', order_registry: 'РЗ' };

// Stage 22 (закрытие MEDIUM-1). Раньше номер читался запросом «последний
// номер» и увеличивался на единицу БЕЗ блокировки: два одновременных
// формирования получали ОДИН номер, один INSERT проходил, второй падал на
// UNIQUE — и документ не создавался вовсе.
//
// Теперь номер выдаёт счётчик: INSERT ... ON CONFLICT DO UPDATE RETURNING —
// одна атомарная операция, которая сама сериализует конкурентов на строке
// счётчика внутри той же транзакции. UNIQUE на document_number остаётся, но
// как последняя защита, а не как основной алгоритм.
async function nextDocumentNumber(kind, year, client = null) {
  const prefix = `YAAM-${KIND_CODE[kind]}-${year}-`;
  const numericYear = Number(year);
  const rows = await db.execute(
    `INSERT INTO document_number_counters (kind, year, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (kind, year) DO UPDATE
       SET last_number = document_number_counters.last_number + 1,
           updated_at = NOW()
     RETURNING last_number`,
    [kind, numericYear],
    client,
  );
  return `${prefix}${String(rows.rows[0].last_number).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Модель данных документа — строится ИСКЛЮЧИТЕЛЬНО из snapshot.
// ---------------------------------------------------------------------------

async function loadSnapshot(periodId, restaurantId, client = null) {
  const periodRows = await db.query('SELECT * FROM settlement_periods WHERE id = $1', [periodId], client);
  const period = periodRows[0];
  if (!period) throw new ValidationError('Расчётный период не найден.');
  if (period.status !== 'closed') {
    throw new ValidationError('Документы формируются только для закрытого расчётного периода.');
  }

  const lineRows = await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1 AND restaurant_id = $2',
    [periodId, restaurantId],
    client,
  );
  const line = lineRows[0];
  if (!line) throw new ValidationError('В этом периоде нет расчёта по указанному ресторану.');

  const orderLines = await db.query(
    `SELECT sol.*, o.public_code
       FROM settlement_order_lines sol
       JOIN orders o ON o.id = sol.order_id
      WHERE sol.settlement_period_id = $1 AND sol.restaurant_id = $2
      ORDER BY sol.delivered_at_snapshot, sol.order_id`,
    [periodId, restaurantId],
    client,
  );
  const refundLines = await db.query(
    `SELECT sr.*, o.public_code
       FROM settlement_refunds sr
       JOIN refunds rf ON rf.id = sr.refund_id
       JOIN payments p ON p.id = rf.payment_id
       JOIN orders o ON o.id = p.order_id
      WHERE sr.settlement_period_id = $1 AND sr.restaurant_id = $2
      ORDER BY sr.completed_at_snapshot, sr.refund_id`,
    [periodId, restaurantId],
    client,
  );

  // Сторно поздних возвратов этого периода — без него payableAmount в
  // документе не сходился бы с арифметикой самого документа.
  const adjustments = await db.query(
    `SELECT sa.*, o.public_code, sp.period_from AS origin_period_from, sp.period_to AS origin_period_to
       FROM settlement_adjustments sa
       JOIN orders o ON o.id = sa.order_id
       JOIN settlement_periods sp ON sp.id = sa.origin_period_id
      WHERE sa.settlement_period_id = $1 AND sa.restaurant_id = $2
      ORDER BY sa.id`,
    [periodId, restaurantId],
    client,
  );

  return { period, line, orderLines, refundLines, adjustments };
}

function formatDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ФОРМУЛЫ (единственное место, где они записаны для документа; все входные
// числа — из snapshot, ничего не пересчитывается из живых таблиц):
//   продажи (sales)        = SUM(items_total_snapshot) по вошедшим заказам
//   возвраты (refunds)     = SUM(amount_snapshot) по вошедшим возвратам
//   база (commissionBase)  = sales
//   комиссия YAAM          = SUM(commission_amount_snapshot)  [зафиксирована
//                            на каждом заказе в момент его создания]
//   сумма ресторану        = line.payable_amount              [та же сумма,
//                            что и обязательство выплаты — не пересчитывается
//                            заново, иначе документ и выплата могли бы
//                            разойтись]
//
// ПОЧЕМУ БАЗА НЕ РАВНА sales - refunds (важно, это не упрощение):
// «Учтённый заказ» в YAAM — это delivered + успешно оплачен + БЕЗ успешного
// возврата (EARNED_ORDER_FILTER_SQL, services/hq/restaurantFinanceService.js).
// Полностью возвращённый заказ ВООБЩЕ НЕ ПОПАДАЕТ в sales — он исключён из
// settlement_order_lines. Значит множества «продажи» и «возвраты» не
// пересекаются, и вычитание возвратов из базы было бы ДВОЙНЫМ УЧЁТОМ: сумма
// уменьшилась бы дважды. Возвраты показываются отдельной строкой как
// информация о деньгах, вернувшихся покупателям в этом периоде, — ровно тот
// же принцип, что уже зафиксирован в Stage 7.1 («возвраты показаны отдельно и
// не вычитаются повторно»).
//
// Частичных возвратов в модели не существует: DB-триггер
// fn_refunds_amount_matches_payment требует refund.amount = payment.amount
// (full-refund-only). Если частичные возвраты появятся, эта формула должна
// быть пересмотрена вместе с EARNED_ORDER_FILTER_SQL — см. PENDING в отчёте.
function buildAgentReportPayload({ period, line, orderLines, refundLines, adjustments = [] }, { now = new Date(), env = process.env } = {}) {
  const sales = orderLines.reduce((sum, o) => sum + o.items_total_snapshot, 0);
  const refunds = refundLines.reduce((sum, r) => sum + r.amount_snapshot, 0);
  const commission = orderLines.reduce((sum, o) => sum + o.commission_amount_snapshot, 0);
  const acceptance = resolveAcceptanceTerms(env);

  return {
    kind: 'agent_report',
    generatedAt: now.toISOString(),
    period: { from: formatDate(period.period_from), to: formatDate(period.period_to) },
    agent: {
      // Данные YAAM как агента — снимок на момент закрытия. Правка настроек
      // после закрытия периода уже выпущенный отчёт не меняет.
      legalName: line.yaam_legal_name_snapshot,
      inn: line.yaam_inn_snapshot,
      kpp: line.yaam_kpp_snapshot,
      ogrnip: line.yaam_ogrnip_snapshot || null,
      address: line.yaam_address_snapshot || null,
    },
    principal: {
      // Данные ресторана как принципала — снимок на момент закрытия.
      restaurantId: line.restaurant_id,
      displayName: line.restaurant_name_snapshot,
      legalName: line.legal_name_snapshot,
      legalForm: line.legal_form_snapshot,
      inn: line.inn_snapshot,
      ogrn: line.ogrn_snapshot,
      legalAddress: line.legal_address_snapshot,
    },
    contract: {
      number: line.contract_number_snapshot || null,
      signedAt: formatDate(line.contract_signed_at_snapshot),
    },
    totals: {
      ordersCount: orderLines.length,
      sales,
      refunds,
      refundsCount: refundLines.length,
      commissionBase: sales,
      // null означает «ставка не была однородной по заказам периода либо не
      // может быть достоверно восстановлена» — так уже устроен
      // commission_bps_summary (settlementService), выдумывать её нельзя.
      commissionBps: line.commission_bps_summary,
      commissionAmount: commission,
      // Сторно по заказам ПРОШЛЫХ периодов, возвращённым покупателю в этом
      // периоде: ресторан возвращает начисленное, YAAM — удержанную комиссию.
      // Без этих строк «К перечислению» в документе выглядел бы ошибкой.
      adjustmentRestaurantAmount: line.refund_adjustment_restaurant_amount || 0,
      adjustmentCommissionAmount: line.refund_adjustment_commission || 0,
      commissionAmountNet: commission - (line.refund_adjustment_commission || 0),
      // Перенос долга прошлых периодов — отдельными величинами, чтобы
      // «начислено», «удержано» и «к выплате» читались раздельно.
      carryForwardApplied: line.carry_forward_applied || 0,
      carryForwardRemaining: line.carry_forward_remaining || 0,
      payableAmount: line.payable_amount,
    },
    // Построчная расшифровка сторно — чтобы его можно было проверить и оспорить.
    adjustments: adjustments.map((a) => ({
      orderCode: a.public_code,
      originPeriodFrom: formatDate(a.origin_period_from),
      originPeriodTo: formatDate(a.origin_period_to),
      restaurantAmount: a.restaurant_amount,
      commissionAmount: a.commission_amount,
    })),
    // Юридическая формулировка — только из конфигурации (см. выше).
    acceptanceTerms: acceptance.text,
    acceptanceTermsPending: acceptance.pending,
  };
}

// Реестр заказов. ПДн клиента (адрес, телефон, комментарий, имя) сюда НЕ
// попадают — только номер заказа, время и деньги (задание, раздел 8).
// Возврат сопоставляется заказу по public_code: снимок возврата хранит
// refund_id, а его заказ восстанавливается тем же JOIN, что и в loadSnapshot.
function buildOrderRegistryPayload({ period, line, orderLines, refundLines, adjustments = [] }, { now = new Date() } = {}) {
  const refundByCode = new Map();
  for (const r of refundLines) {
    refundByCode.set(r.public_code, (refundByCode.get(r.public_code) || 0) + r.amount_snapshot);
  }

  const rows = orderLines.map((o) => {
    const refundAmount = refundByCode.get(o.public_code) || 0;
    return {
      orderCode: o.public_code,
      occurredAt: o.delivered_at_snapshot instanceof Date
        ? o.delivered_at_snapshot.toISOString()
        : new Date(o.delivered_at_snapshot).toISOString(),
      sales: o.items_total_snapshot,
      refund: refundAmount,
      commissionBase: o.items_total_snapshot,
      commission: o.commission_amount_snapshot,
      restaurantAmount: o.restaurant_amount_snapshot,
      // Финансовый статус операции человеческим языком, без внутренних кодов.
      status: refundAmount > 0 ? 'Возврат' : 'Учтён',
    };
  });

  // Возвраты, которым не соответствует ни одна строка продаж этого периода —
  // отдельными строками, иначе итог реестра не сошёлся бы с отчётом агента.
  //
  // Сюда попадают ДВА разных случая, и различить их здесь нечем:
  //   1) заказ учтён в прошлом периоде, а возврат пришёл на этой неделе;
  //   2) заказ этой недели возвращён полностью — тогда EARNED_ORDER_FILTER_SQL
  //      исключает его из settlement_order_lines целиком.
  // Поэтому ярлык не утверждает, из какого периода заказ: он говорит ровно то,
  // что верно в обоих случаях — продажа этого заказа в базу периода не вошла.
  const orderCodes = new Set(orderLines.map((o) => o.public_code));
  for (const r of refundLines) {
    if (orderCodes.has(r.public_code)) continue;
    rows.push({
      orderCode: r.public_code,
      occurredAt: r.completed_at_snapshot instanceof Date
        ? r.completed_at_snapshot.toISOString()
        : new Date(r.completed_at_snapshot).toISOString(),
      sales: 0,
      refund: r.amount_snapshot,
      commissionBase: 0,
      commission: 0,
      restaurantAmount: 0,
      status: 'Возврат · продажа в базу периода не включена',
    });
  }

  const sales = orderLines.reduce((sum, o) => sum + o.items_total_snapshot, 0);
  const refunds = refundLines.reduce((sum, r) => sum + r.amount_snapshot, 0);
  const commission = orderLines.reduce((sum, o) => sum + o.commission_amount_snapshot, 0);

  return {
    kind: 'order_registry',
    generatedAt: now.toISOString(),
    period: { from: formatDate(period.period_from), to: formatDate(period.period_to) },
    principal: {
      restaurantId: line.restaurant_id,
      displayName: line.restaurant_name_snapshot,
      legalName: line.legal_name_snapshot,
      inn: line.inn_snapshot,
    },
    rows,
    // Итоги ОБЯЗАНЫ совпадать с отчётом агента и snapshot — считаются из тех
    // же snapshot-строк теми же формулами (проверено тестом).
    totals: {
      ordersCount: orderLines.length,
      sales,
      refunds,
      // Та же формула, что и в отчёте агента (см. подробное обоснование
      // выше): возвраты не вычитаются из базы повторно.
      commissionBase: sales,
      commission,
      adjustmentRestaurantAmount: line.refund_adjustment_restaurant_amount || 0,
      adjustmentCommissionAmount: line.refund_adjustment_commission || 0,
      carryForwardApplied: line.carry_forward_applied || 0,
      carryForwardRemaining: line.carry_forward_remaining || 0,
      payableAmount: line.payable_amount,
    },
    adjustments: adjustments.map((a) => ({
      orderCode: a.public_code,
      originPeriodFrom: formatDate(a.origin_period_from),
      originPeriodTo: formatDate(a.origin_period_to),
      restaurantAmount: a.restaurant_amount,
      commissionAmount: a.commission_amount,
    })),
  };
}

function buildPayload(kind, snapshot, options) {
  if (kind === 'agent_report') return buildAgentReportPayload(snapshot, options);
  if (kind === 'order_registry') return buildOrderRegistryPayload(snapshot, options);
  throw new ValidationError(`Неизвестный вид документа: ${kind}`);
}

// ---------------------------------------------------------------------------
// Создание документов
// ---------------------------------------------------------------------------

// Идемпотентно: если действующая версия документа уже есть — возвращает её,
// не создавая дубль и не перезаписывая (документ immutable).
async function ensureDocument(periodId, restaurantId, kind, { now = new Date(), env = process.env } = {}) {
  if (!DOCUMENT_KINDS.includes(kind)) throw new ValidationError(`Неизвестный вид документа: ${kind}`);

  const existing = await db.query(
    `SELECT * FROM settlement_documents
      WHERE settlement_period_id = $1 AND restaurant_id = $2 AND kind = $3
      ORDER BY version DESC LIMIT 1`,
    [periodId, restaurantId, kind],
  );
  if (existing[0] && existing[0].status === 'generated') return { document: existing[0], created: false };

  try {
    const snapshot = await loadSnapshot(periodId, restaurantId);
    const payload = buildPayload(kind, snapshot, { now, env });
    const year = String(payload.period.to || '').slice(0, 4) || String(now.getUTCFullYear());
    const number = await nextDocumentNumber(kind, year);

    const inserted = await db.execute(
      `INSERT INTO settlement_documents
         (settlement_period_id, restaurant_id, kind, document_number, version, payload, status)
       VALUES ($1,$2,$3,$4,1,$5,'generated') RETURNING *`,
      [periodId, restaurantId, kind, number, JSON.stringify(payload)],
    );
    await logAuditEvent({
      action: 'settlement_document_created', restaurantId,
      details: `${DOCUMENT_KIND_LABELS[kind]} ${number} за период ${payload.period.from}–${payload.period.to}`,
      ip: null,
    });
    return { document: inserted.rows[0], created: true };
  } catch (err) {
    // Ошибка документа НЕ откатывает уже закрытый период (задание, раздел 9):
    // фиксируем failed-строку, чтобы владелец видел статус «Ошибка».
    console.error(`[settlementDocuments] ${kind} для периода ${periodId}/ресторана ${restaurantId}:`, err.message);
    await logAuditEvent({
      action: 'settlement_document_failed', restaurantId,
      details: `${DOCUMENT_KIND_LABELS[kind]}: ${err.message}`, ip: null,
    });
    return { document: null, created: false, error: err.message };
  }
}

// Все документы всех ресторанов закрытого периода. Ошибка одного ресторана
// не мешает остальным.
async function generateDocumentsForPeriod(periodId, { now = new Date(), env = process.env } = {}) {
  const lines = await db.query(
    'SELECT restaurant_id FROM settlement_restaurant_lines WHERE settlement_period_id = $1 ORDER BY restaurant_id',
    [periodId],
  );
  const results = [];
  for (const line of lines) {
    for (const kind of DOCUMENT_KINDS) {
      // eslint-disable-next-line no-await-in-loop
      const res = await ensureDocument(periodId, line.restaurant_id, kind, { now, env });
      results.push({ restaurantId: line.restaurant_id, kind, ...res });
    }
  }
  return results;
}

// Корректирующая версия (задание, раздел 11). Исходная версия сохраняется,
// новая получает version+1, ссылку на исходник и обязательную причину.
// Пересчёт идёт из ТОГО ЖЕ snapshot — то есть исправляется представление
// документа, а не бухгалтерские цифры: свободного редактирования сумм в
// системе нет вовсе.
async function createCorrectingVersion(documentId, { reason, now = new Date(), env = process.env, ip = null } = {}) {
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) throw new ValidationError('Причина корректировки обязательна.');

  const rows = await db.query('SELECT * FROM settlement_documents WHERE id = $1', [documentId]);
  const original = rows[0];
  if (!original) throw new ValidationError('Документ не найден.');

  const snapshot = await loadSnapshot(original.settlement_period_id, original.restaurant_id);
  const payload = buildPayload(original.kind, snapshot, { now, env });
  const baseNumber = original.document_number.replace(/-и\d+$/, '');
  const newVersion = original.version + 1;

  const inserted = await db.execute(
    `INSERT INTO settlement_documents
       (settlement_period_id, restaurant_id, kind, document_number, version,
        supersedes_document_id, correction_reason, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'generated') RETURNING *`,
    [
      original.settlement_period_id, original.restaurant_id, original.kind,
      `${baseNumber}-и${newVersion}`, newVersion, original.id, trimmedReason,
      JSON.stringify(payload),
    ],
  );
  await logAuditEvent({
    action: 'settlement_document_corrected', restaurantId: original.restaurant_id,
    details: `${DOCUMENT_KIND_LABELS[original.kind]} ${inserted.rows[0].document_number}: ${trimmedReason}`,
    ip,
  });
  return inserted.rows[0];
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

// Действующие (последние) версии документов периода — для блока «Документы».
async function listDocumentsForPeriod(periodId) {
  return db.query(
    `SELECT DISTINCT ON (restaurant_id, kind) *
       FROM settlement_documents
      WHERE settlement_period_id = $1
      ORDER BY restaurant_id, kind, version DESC`,
    [periodId],
  );
}

// Документ по id. Возвращает строку целиком — вызывающий роут ОБЯЗАН
// проверить принадлежность (период/ресторан) перед выдачей: подмена id в
// URL не должна отдать чужой документ.
async function getDocumentById(documentId) {
  const numericId = Number.parseInt(documentId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM settlement_documents WHERE id = $1', [numericId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Повтор формирования отсутствующих документов (Stage 22, закрытие MEDIUM-2)
// ---------------------------------------------------------------------------
//
// Документы формировались ОДИН раз — при закрытии периода. Ошибка была
// изолирована правильно (период не откатывается), но повтора не существовало:
// упавшая генерация означала, что документов у ресторана просто нет, пока
// владелец не заметит и не запустит формирование вручную.
//
// Эта функция проходит закрытые периоды и достраивает недостающее.

// Больше попыток не делаем: если документ не собрался столько раз, проблема
// не в удаче, и повторять её бесконечно — только шуметь.
const MAX_GENERATION_ATTEMPTS = 5;

async function retryMissingDocuments({ limit = 20, now = new Date(), env = process.env } = {}) {
  // Строки закрытых периодов, у которых нет ГОТОВОГО документа нужного вида.
  //
  // Корректирующие версии не мешают: у них тот же period/restaurant/kind и
  // status='generated', поэтому строка с корректировкой не считается
  // «недостающей». Отсутствующий исходный документ и наличие корректировки —
  // разные вещи, и здесь мы ищем именно первое.
  const missing = await db.query(
    `SELECT srl.settlement_period_id AS period_id, srl.restaurant_id, k.kind
       FROM settlement_restaurant_lines srl
       JOIN settlement_periods sp ON sp.id = srl.settlement_period_id
       CROSS JOIN (SELECT unnest($1::text[]) AS kind) k
      WHERE sp.status = 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM settlement_documents d
           WHERE d.settlement_period_id = srl.settlement_period_id
             AND d.restaurant_id = srl.restaurant_id
             AND d.kind = k.kind
             AND d.status = 'generated'
        )
        AND COALESCE((
          SELECT MAX(d2.generation_attempts) FROM settlement_documents d2
           WHERE d2.settlement_period_id = srl.settlement_period_id
             AND d2.restaurant_id = srl.restaurant_id
             AND d2.kind = k.kind
        ), 0) < $2
      ORDER BY srl.settlement_period_id, srl.restaurant_id
      LIMIT $3`,
    [DOCUMENT_KINDS, MAX_GENERATION_ATTEMPTS, limit],
  );

  const results = { checked: missing.length, created: 0, failed: 0 };
  for (const row of missing) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ensureDocument(row.period_id, row.restaurant_id, row.kind, { now, env });
    if (res.created) {
      results.created += 1;
      // eslint-disable-next-line no-await-in-loop
      await logAuditEvent({
        action: 'settlement_document_regenerated', restaurantId: row.restaurant_id,
        details: `${DOCUMENT_KIND_LABELS[row.kind]} для периода #${row.period_id} создан повторной попыткой`,
        ip: null,
      });
    } else if (!res.document) {
      results.failed += 1;
      // Счётчик попыток — на строке-неудаче, если она есть; иначе создаём
      // маркерную запись невозможно (нет номера), поэтому просто считаем.
      // eslint-disable-next-line no-await-in-loop
      await db.execute(
        `UPDATE settlement_documents SET generation_attempts = generation_attempts + 1
          WHERE settlement_period_id = $1 AND restaurant_id = $2 AND kind = $3`,
        [row.period_id, row.restaurant_id, row.kind],
      );
    }
  }
  return results;
}

module.exports = {
  MAX_GENERATION_ATTEMPTS,
  retryMissingDocuments,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  ACCEPTANCE_TERMS_ENV,
  resolveAcceptanceTerms,
  nextDocumentNumber,
  loadSnapshot,
  buildAgentReportPayload,
  buildOrderRegistryPayload,
  buildPayload,
  ensureDocument,
  generateDocumentsForPeriod,
  createCorrectingVersion,
  listDocumentsForPeriod,
  getDocumentById,
};
