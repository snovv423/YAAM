'use strict';

// YAAM Stage 22 — сверка платежей с провайдером (закрытие CRITICAL-1).
//
// ЗАЧЕМ. До этого этапа единственным источником знания об оплате был webhook.
// Если он не дошёл — сервер лежал дольше окна повторов, уведомление было
// отвергнуто нашей же валидацией, провайдер перестал повторять — платёж
// навсегда оставался 'pending', заказ навсегда 'awaiting_payment', ресторан
// заказ не видел, покупатель видел «не оплачено», а деньги были списаны.
// Автоматического возврата тоже не происходило: все пути возврата требуют
// УСПЕШНОГО платежа в нашей базе. Деньги выпадали из учёта целиком.
//
// ПРИНЦИП. Сверка не является вторым источником истины и не содержит своей
// финансовой логики. Она только СПРАШИВАЕТ провайдера и передаёт ответ в те
// же атомарные переходы, что использует webhook: markPaid() и
// markPaymentFailed(). Поэтому потерянный webhook в итоге приводит систему
// ровно в то же состояние, что и полученный.
//
// ЧЕГО СВЕРКА НЕ ДЕЛАЕТ. Не пишет произвольных UPDATE по деньгам, не
// придумывает статусы, не переводит платёж в терминальное состояние из-за
// временной недоступности API и не трогает заказы, по которым провайдер
// ничего определённого не сказал.
const crypto = require('node:crypto');
const db = require('../../db/postgresql');
const payments = require('../paymentService');
const orderService = require('./orderService');
const { logAuditEvent } = require('../hq/auditLog');
const { CATEGORIES } = require('../paymentProviders/providerErrorTaxonomy');

// Платёж моложе этого возраста не сверяется: покупатель может всё ещё стоять
// на форме оплаты, а webhook — быть в пути. Сверка нужна для ЗАБЫТЫХ
// платежей, а не для гонки с нормальным потоком.
const MIN_AGE_MS = 5 * 60 * 1000;

// Сколько платежей за один проход. Ограничение обязательно: проход не должен
// превращаться в неограниченный обход таблицы и держать соединение.
const DEFAULT_BATCH_LIMIT = 25;

// Пауза после временной ошибки провайдера — растёт с числом попыток, но не
// бесконечно. Платёж не «сдаётся»: он продолжает проверяться реже.
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

function backoffFor(attemptCount) {
  const idx = Math.min(attemptCount, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[idx];
}

// Наружу никогда не уходит текст провайдера целиком: в нём могут оказаться
// идентификаторы, ссылки на форму оплаты и служебные данные. Храним только
// короткую обезличенную выжимку.
function safeErrorText(err) {
  const raw = String((err && err.message) || 'неизвестная ошибка');
  return raw.replace(/https?:\/\/\S+/g, '<url>').replace(/\s+/g, ' ').slice(0, 200);
}

function errorCategory(err) {
  const c = err && err.category;
  if (c === CATEGORIES.RETRYABLE) return 'retryable';
  if (c === CATEGORIES.NOT_FOUND) return 'not_found';
  if (c === CATEGORIES.UNKNOWN_RESULT) return 'unknown_result';
  if (c) return 'terminal';
  return 'unknown_result';
}

// Провайдер обязан уметь спросить статус. У mock-провайдера getStatus есть,
// поэтому сверка работает и в тестовом режиме — иначе её нельзя было бы
// проверить без реальных денег.
function providerSupportsLookup() {
  return typeof payments.getPaymentStatus === 'function';
}

// Кандидаты на сверку. Условия читаются буквально из задания: незавершённый
// статус, возраст выше порога, наличие provider_payment_id.
async function findDuePayments({ now = new Date(), limit = DEFAULT_BATCH_LIMIT, minAgeMs = MIN_AGE_MS } = {}) {
  const threshold = new Date(now.getTime() - minAgeMs);
  return db.query(
    `SELECT id, order_id, provider, provider_payment_id, amount, status, reconcile_attempt_count
       FROM payments
      WHERE status IN ('creating', 'pending')
        AND provider_payment_id IS NOT NULL
        AND created_at <= $1
        AND (next_check_at IS NULL OR next_check_at <= $2)
      ORDER BY created_at ASC
      LIMIT $3`,
    [threshold, now, limit],
  );
}

// Отметка попытки. Пишется ВСЕГДА, независимо от исхода: без неё «сверка идёт»
// и «сверка застряла» выглядели бы одинаково.
async function recordAttempt(paymentId, { nextCheckAt = null, errorCode = null, errorSafe = null }) {
  await db.execute(
    `UPDATE payments
        SET reconcile_attempt_count = reconcile_attempt_count + 1,
            last_checked_at = NOW(),
            next_check_at = $2,
            last_reconcile_error_code = $3,
            last_reconcile_error_safe = $4,
            updated_at = NOW()
      WHERE id = $1`,
    [paymentId, nextCheckAt, errorCode, errorSafe],
  );
}

// Одна попытка сверки одного платежа.
//
// Возвращает { outcome, ... }, где outcome:
//   'confirmed_paid'      — провайдер подтвердил успех, переход применён;
//   'confirmed_failed'    — провайдер подтвердил отказ, переход применён;
//   'still_pending'       — провайдер ещё не знает итога;
//   'provider_unavailable'— временная ошибка, повтор позже;
//   'unknown'             — неопределённый или противоречивый ответ;
//   'duplicate'           — успех подтверждён, но у заказа уже есть
//                           учитываемый платёж (см. handleConfirmedSuccess);
//   'skipped'             — платёж уже разрешён кем-то другим.
async function reconcileOne(payment, { now = new Date() } = {}) {
  let providerStatus;
  try {
    providerStatus = await payments.getPaymentStatus(payment.provider_payment_id);
  } catch (err) {
    const code = errorCategory(err);
    const safe = safeErrorText(err);
    // Временная недоступность НЕ переводит платёж в терминальный статус.
    // Ошибиться в сторону «не знаем» здесь безопаснее, чем в сторону
    // «отказ»: отказ закрыл бы заказ, по которому деньги уже списаны.
    const nextCheckAt = new Date(now.getTime() + backoffFor(payment.reconcile_attempt_count));
    await recordAttempt(payment.id, { nextCheckAt, errorCode: code, errorSafe: safe });
    await logAuditEvent({
      action: 'payment_reconcile_failed', restaurantId: null,
      details: `платёж #${payment.id}: ${code} — ${safe}`, ip: null,
    });
    return { outcome: code === 'retryable' ? 'provider_unavailable' : 'unknown', code };
  }

  if (providerStatus === 'pending') {
    await recordAttempt(payment.id, {
      nextCheckAt: new Date(now.getTime() + backoffFor(payment.reconcile_attempt_count)),
    });
    return { outcome: 'still_pending' };
  }

  if (providerStatus === 'succeeded') {
    return handleConfirmedSuccess(payment, { now });
  }

  if (providerStatus === 'failed') {
    await orderService.markPaymentFailed(payment.order_id, payment.id);
    await recordAttempt(payment.id, { nextCheckAt: null });
    await logAuditEvent({
      action: 'payment_reconciled', restaurantId: null,
      details: `платёж #${payment.id}: провайдер подтвердил отказ, статус приведён к failed`, ip: null,
    });
    return { outcome: 'confirmed_failed' };
  }

  // Провайдер вернул значение, которого мы не понимаем. Не угадываем.
  await recordAttempt(payment.id, {
    nextCheckAt: new Date(now.getTime() + backoffFor(payment.reconcile_attempt_count)),
    errorCode: 'unknown_result',
    errorSafe: 'провайдер вернул нераспознанный статус',
  });
  return { outcome: 'unknown' };
}

// Провайдер подтвердил успех. Дальше решает orderService — тем же кодом, что
// обрабатывает webhook, включая поздний успех по уже отменённому заказу
// (существующий безопасный возвратный сценарий внутри markPaid).
async function handleConfirmedSuccess(payment, { now = new Date() } = {}) {
  const result = await orderService.applyConfirmedPaymentSuccess(payment.order_id, payment.id, {
    source: 'reconciliation',
  });
  await recordAttempt(payment.id, { nextCheckAt: null });

  if (result.outcome === 'duplicate') {
    return { outcome: 'duplicate', duplicate: result };
  }
  if (result.outcome === 'noop') {
    return { outcome: 'skipped', reason: result.reason };
  }
  await logAuditEvent({
    action: 'payment_reconciled', restaurantId: null,
    details: `платёж #${payment.id}: провайдер подтвердил успех, статус приведён к succeeded`, ip: null,
  });
  return { outcome: 'confirmed_paid' };
}

// Полный проход. Идемпотентен: повторный запуск на том же состоянии не меняет
// ничего сверх уже сделанного, потому что все переходы условны по статусу.
//
// Два процесса не обрабатывают один платёж одновременно: проход берёт
// НЕблокирующую advisory-локу, как и еженедельный расчёт. Второй запуск тихо
// выходит, а не ждёт и не дублирует запросы к провайдеру.
const ADVISORY_LOCK_KEY = 22_000_001;

async function runPaymentReconciliation({ now = new Date(), limit = DEFAULT_BATCH_LIMIT, minAgeMs = MIN_AGE_MS } = {}) {
  const empty = {
    skipped: false, checked: 0, confirmedPaid: 0, confirmedFailed: 0,
    stillPending: 0, unavailable: 0, unknown: 0, duplicates: 0,
  };
  if (!providerSupportsLookup()) {
    return { ...empty, skipped: true, reason: 'provider_lookup_unsupported' };
  }

  const lockClient = await db.getPool().connect();
  let locked = false;
  try {
    const lockRes = await lockClient.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
    locked = lockRes.rows[0].acquired === true;
    if (!locked) return { ...empty, skipped: true, reason: 'already_running' };

    const due = await findDuePayments({ now, limit, minAgeMs });
    const stats = { ...empty };
    for (const payment of due) {
      stats.checked += 1;
      // eslint-disable-next-line no-await-in-loop
      const res = await reconcileOne(payment, { now });
      if (res.outcome === 'confirmed_paid') stats.confirmedPaid += 1;
      else if (res.outcome === 'confirmed_failed') stats.confirmedFailed += 1;
      else if (res.outcome === 'still_pending') stats.stillPending += 1;
      else if (res.outcome === 'provider_unavailable') stats.unavailable += 1;
      else if (res.outcome === 'duplicate') stats.duplicates += 1;
      else if (res.outcome === 'unknown') stats.unknown += 1;
    }
    return stats;
  } finally {
    if (locked) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      } catch (err) {
        console.error('[paymentReconciliation] не удалось освободить advisory-локу:', err.message);
      }
    }
    lockClient.release();
  }
}

// Отпечаток тела webhook — используется реестром отвергнутых уведомлений.
// Живёт здесь, потому что это та же граница «безопасное представление
// платёжных данных», что и safeErrorText выше.
function payloadFingerprint(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

module.exports = {
  MIN_AGE_MS,
  DEFAULT_BATCH_LIMIT,
  ADVISORY_LOCK_KEY,
  backoffFor,
  safeErrorText,
  errorCategory,
  findDuePayments,
  reconcileOne,
  runPaymentReconciliation,
  payloadFingerprint,
};
