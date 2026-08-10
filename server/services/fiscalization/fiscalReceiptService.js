'use strict';

// YAAM — фискальные чеки (54-ФЗ): формирование, хранение, повтор.
//
// СТАТУС. Это техническая основа, а НЕ работающая фискализация. Реальная
// касса не подключена, ни один чек никуда не отправляется. Кто в агентской
// модели YAAM обязан пробивать чек и какие реквизиты поставщика в нём
// обязательны — вопрос юридический и не решён (BLOCKED LEGAL, отчёт Stage 14).
// Здесь построена безопасная граница: приложение умеет собрать неизменяемый
// payload, зафиксировать его, повторить попытку и не пробить чек дважды.
//
// ПОЧЕМУ PAYLOAD СОБИРАЕТСЯ ИЗ СНИМКА ЗАКАЗА, А НЕ ИЗ МЕНЮ. Чек обязан
// отражать то, что человек купил в момент оплаты. order_items уже хранит имя
// и цену НА МОМЕНТ ЗАКАЗА (см. db/postgresql/schema.sql) — читаем их, а не
// menu_items: переименование блюда или смена цены завтра не должны менять
// вчерашний чек.
//
// ПЕРСОНАЛЬНЫЕ ДАННЫЕ. В payload не попадают имя, адрес и комментарий
// покупателя. Телефон — единственный контакт, по которому чек вообще может
// быть отправлен, и он включается отдельным полем `customerContact`, а не
// растворяется среди позиций.
const crypto = require('node:crypto');
const db = require('../../db/postgresql');
const { logAuditEvent } = require('../hq/auditLog');
const { FiscalProviderError } = require('./fiscalProviderInterface');
const money = require('../money');

// Максимум попыток до перевода чека в failed. Бесконечный повтор скрыл бы
// системную проблему, а один шанс не переживёт обычного сетевого сбоя.
const MAX_ATTEMPTS = 5;

// Ключ идемпотентности выводится ИЗ ДАННЫХ, а не из случайности: повторный
// вызов после падения процесса обязан дать тот же ключ, иначе провайдер
// пробьёт второй чек за тот же платёж.
function paymentIdempotencyKey(paymentId) {
  return `yaam-receipt-payment-${paymentId}`;
}
function refundIdempotencyKey(refundId) {
  return `yaam-receipt-refund-${refundId}`;
}

// Стабильный отпечаток payload — для тестов детерминированности и для
// быстрого сравнения «тот же ли это чек».
function payloadFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

// Позиции заказа из неизменяемого снимка.
async function loadOrderContext(orderId, client = null) {
  const orders = await db.query(
    `SELECT o.*, r.name AS restaurant_name
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.id = $1`,
    [orderId], client,
  );
  const order = orders[0];
  if (!order) return null;

  const items = await db.query(
    'SELECT name, price, qty FROM order_items WHERE order_id = $1 ORDER BY id',
    [orderId], client,
  );
  const supplier = await db.query(
    `SELECT legal_form, legal_name, inn, ogrn, legal_address
       FROM restaurant_legal_details WHERE restaurant_id = $1`,
    [order.restaurant_id], client,
  );
  return { order, items, supplier: supplier[0] || null };
}

// Данные YAAM как агента. Best-effort: отсутствие не должно ронять сборку
// payload — оно честно отражается как отсутствующее поле.
async function loadAgent(client = null) {
  try {
    const rows = await db.query('SELECT * FROM yaam_legal_details WHERE id = 1', [], client);
    if (!rows[0]) return null;
    return {
      legalName: rows[0].legal_name,
      inn: rows[0].inn,
      ogrnip: rows[0].ogrnip,
    };
  } catch (err) {
    console.error('[fiscalReceipt] юридические данные YAAM недоступны:', err.message);
    return null;
  }
}

// Payload чека прихода.
//
// РАЗДЕЛЕНИЕ РОЛЕЙ. Позиции принадлежат ПОСТАВЩИКУ (ресторану) — он продаёт
// еду. Комиссия YAAM указана отдельным полем `agentCommission` и НЕ является
// позицией чека: клиент не покупает комиссию, она удерживается из расчётов с
// рестораном. Конкретный признак предмета расчёта и признак агента для
// каждой позиции — BLOCKED LEGAL, поэтому не проставляются вымышленными
// значениями, а помечены как несогласованные.
async function buildPaymentReceiptPayload(orderId, { client = null } = {}) {
  const ctx = await loadOrderContext(orderId, client);
  if (!ctx) return null;
  const agent = await loadAgent(client);
  const { order, items, supplier } = ctx;

  return {
    kind: 'payment',
    order: {
      id: order.id,
      publicCode: order.public_code,
      // Stage 38 — orders.items_total хранится в integer minor units, но
      // items[].amount ниже построен из order_items.price/qty (продуктовый
      // слой, ОСТАЁТСЯ целыми рублями — граница минора не затрагивает
      // order_items). Единственный способ не смешать две единицы в ОДНОМ
      // payload — привести ВЕСЬ документ к рублям здесь, на границе сборки
      // (заодно совпадает с фактическим требованием 54-ФЗ: фискальный чек
      // денежно исчисляется в рублях с копейками, не в "сырых" minor units).
      itemsTotal: money.minorToRublesNumber(order.items_total),
      // Доставка на старте выполняется рестораном и через YAAM не
      // оплачивается (CLAUDE.md), поэтому строки доставки в чеке нет.
      // Появится оплата доставки — появится и позиция.
      deliveryAmount: 0,
      fulfillmentType: order.fulfillment_type,
    },
    // Поставщик товара — ресторан. null означает «юридические данные не
    // заполнены», а не «поставщика нет».
    supplier: supplier ? {
      legalForm: supplier.legal_form,
      legalName: supplier.legal_name,
      inn: supplier.inn,
      ogrn: supplier.ogrn,
      address: supplier.legal_address,
    } : null,
    agent,
    // Только телефон: имя, адрес и комментарий покупателя в чек не идут.
    customerContact: order.customer_phone,
    items: items.map((i) => ({
      name: i.name,
      price: i.price,
      quantity: i.qty,
      amount: i.price * i.qty,
    })),
    // Stage 38 — та же граница рублей, что и itemsTotal выше.
    agentCommission: money.minorToRublesNumber(order.commission_amount),
    total: money.minorToRublesNumber(order.items_total),
    // Явно фиксируем, что признаки 54-ФЗ не проставлены и почему.
    pendingLegal: {
      paymentSubjectSign: 'не согласован',
      agentSign: 'не согласован',
      vatRate: 'не согласована',
      note: 'Признаки предмета расчёта, признак агента и ставка НДС требуют юридического подтверждения.',
    },
  };
}

// Payload чека возврата. Строится из ТОГО ЖЕ снимка заказа: возврат обязан
// зеркалить приход, а не пересобираться из текущих данных.
async function buildRefundReceiptPayload(refundId, { client = null } = {}) {
  const rows = await db.query(
    `SELECT rf.id AS refund_id, rf.amount, rf.completed_at, p.order_id, p.amount AS payment_amount
       FROM refunds rf JOIN payments p ON p.id = rf.payment_id
      WHERE rf.id = $1`,
    [refundId], client,
  );
  const refund = rows[0];
  if (!refund) return null;

  const base = await buildPaymentReceiptPayload(refund.order_id, { client });
  if (!base) return null;

  // Полный возврат зеркалит все позиции. Частичный возврат сейчас невозможен
  // (fn_refunds_amount_matches_payment требует полной суммы), поэтому позиции
  // частичного возврата НЕ выдумываются: если сумма меньше платежа, чек
  // помечается как требующий разбора, а не собирается наугад.
  const isFull = refund.amount === refund.payment_amount;

  return {
    ...base,
    kind: 'refund',
    refund: {
      id: refund.refund_id,
      // Stage 38 — та же граница рублей, что и в buildPaymentReceiptPayload:
      // refunds.amount хранится в minor units, весь остальной payload (base)
      // уже приведён к рублям выше по стеку.
      amount: money.minorToRublesNumber(refund.amount),
      isFull,
    },
    items: isFull ? base.items : [],
    total: money.minorToRublesNumber(refund.amount),
    pendingLegal: {
      ...base.pendingLegal,
      ...(isFull ? {} : {
        partialRefundItems: 'не определены',
        note: 'Частичный возврат: состав позиций возвратного чека требует отдельного решения.',
      }),
    },
  };
}

// Создаёт чек в очереди. Идемпотентно: повторный вызов для того же
// платежа/возврата возвращает уже существующий чек, а не создаёт второй.
// Гарантия структурная — частичные UNIQUE-индексы в схеме, не проверка в коде.
async function enqueueReceipt({ kind, orderId, paymentId = null, refundId = null, provider = 'mock' }, { ip = null } = {}) {
  const idempotencyKey = kind === 'payment'
    ? paymentIdempotencyKey(paymentId)
    : refundIdempotencyKey(refundId);

  const existing = await db.query(
    'SELECT * FROM fiscal_receipts WHERE idempotency_key = $1', [idempotencyKey],
  );
  if (existing[0]) return { receipt: existing[0], created: false };

  const payload = kind === 'payment'
    ? await buildPaymentReceiptPayload(orderId)
    : await buildRefundReceiptPayload(refundId);
  if (!payload) return { receipt: null, created: false, reason: 'source_not_found' };

  try {
    const inserted = await db.execute(
      `INSERT INTO fiscal_receipts (kind, order_id, payment_id, refund_id, provider, idempotency_key, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [kind, orderId, paymentId, refundId, provider, idempotencyKey, JSON.stringify(payload)],
    );
    await logAuditEvent({
      action: 'fiscal_receipt_created', restaurantId: null,
      details: `чек #${inserted.rows[0].id} (${kind}) для заказа #${orderId}`, ip,
    });
    return { receipt: inserted.rows[0], created: true };
  } catch (err) {
    // Гонка: параллельный вызов успел вставить тот же чек. Это не ошибка.
    if (err.code === '23505') {
      const raced = await db.query(
        'SELECT * FROM fiscal_receipts WHERE idempotency_key = $1', [idempotencyKey],
      );
      if (raced[0]) return { receipt: raced[0], created: false };
    }
    throw err;
  }
}

// Одна попытка отправки. Никогда не бросает наружу ошибку провайдера:
// неудачная фискализация — это состояние чека, а не падение вызывающего
// кода (оплата уже прошла, откатывать её нельзя).
async function processReceipt(receiptId, provider, { now = new Date(), ip = null } = {}) {
  // Забираем чек только если он ещё не терминальный и не в работе —
  // условный переход, а не «прочитать и потом записать»: два процесса не
  // должны отправить один чек дважды.
  const claimed = await db.execute(
    `UPDATE fiscal_receipts
        SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1 AND status IN ('queued', 'failed') AND attempts < $2
      RETURNING *`,
    [receiptId, MAX_ATTEMPTS],
  );
  const receipt = claimed.rows[0];
  if (!receipt) return { processed: false, reason: 'not_claimable' };

  const payload = typeof receipt.payload === 'string' ? JSON.parse(receipt.payload) : receipt.payload;

  try {
    const result = await provider.send({
      idempotencyKey: receipt.idempotency_key,
      kind: receipt.kind,
      payload,
    });

    if (result.status === 'processing') {
      // Провайдер принял, но ещё не подтвердил. Терминальным чек не
      // становится, completed_at не выставляется.
      await db.execute(
        `UPDATE fiscal_receipts SET provider_receipt_id = $2, updated_at = NOW() WHERE id = $1`,
        [receiptId, result.providerReceiptId || null],
      );
      return { processed: true, status: 'processing' };
    }

    await db.execute(
      `UPDATE fiscal_receipts
          SET status = 'succeeded', provider_receipt_id = $2, last_error = NULL,
              completed_at = $3, updated_at = NOW()
        WHERE id = $1`,
      [receiptId, result.providerReceiptId || null, now],
    );
    await logAuditEvent({
      action: 'fiscal_receipt_succeeded', restaurantId: null,
      details: `чек #${receiptId} пробит провайдером ${receipt.provider}`, ip,
    });
    return { processed: true, status: 'succeeded' };
  } catch (err) {
    const retryable = err instanceof FiscalProviderError ? err.retryable : true;
    const attemptsLeft = retryable && receipt.attempts + 1 < MAX_ATTEMPTS;

    // Повторяемая ошибка с оставшимися попытками возвращает чек в очередь;
    // иначе он становится терминально failed и требует разбора.
    await db.execute(
      `UPDATE fiscal_receipts
          SET status = $2, last_error = $3, completed_at = $4, updated_at = NOW()
        WHERE id = $1`,
      [receiptId, attemptsLeft ? 'queued' : 'failed', String(err.message).slice(0, 500),
        attemptsLeft ? null : now],
    );
    await logAuditEvent({
      action: attemptsLeft ? 'fiscal_receipt_retried' : 'fiscal_receipt_failed',
      restaurantId: null,
      details: `чек #${receiptId}: ${String(err.message).slice(0, 200)}`,
      ip,
    });
    return { processed: false, status: attemptsLeft ? 'queued' : 'failed', error: err.message };
  }
}

async function getReceipt(receiptId) {
  const rows = await db.query('SELECT * FROM fiscal_receipts WHERE id = $1', [receiptId]);
  return rows[0] || null;
}

async function listPendingReceipts(limit = 50) {
  return db.query(
    `SELECT * FROM fiscal_receipts
      WHERE status = 'queued' AND attempts < $1
      ORDER BY id LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
}

// Сводка для экрана «Платежи и касса»: сколько чеков в каком состоянии.
async function getReceiptSummary() {
  const rows = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM fiscal_receipts GROUP BY status`,
  );
  const summary = { queued: 0, processing: 0, succeeded: 0, failed: 0 };
  for (const r of rows) summary[r.status] = r.n;
  return summary;
}

module.exports = {
  MAX_ATTEMPTS,
  paymentIdempotencyKey,
  refundIdempotencyKey,
  payloadFingerprint,
  buildPaymentReceiptPayload,
  buildRefundReceiptPayload,
  enqueueReceipt,
  processReceipt,
  getReceipt,
  listPendingReceipts,
  getReceiptSummary,
};
