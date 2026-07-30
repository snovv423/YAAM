'use strict';

// Закрытие официального блокера по статусам H2H-выплат Т-Банка: поддержка
// Т-Банка подтвердила, что API выплат возвращает РОВНО 4 статуса —
// IN_PROGRESS, EXECUTED, FAILED, CANCELLED. Ни HTTP-клиента к Т-Банку, ни
// webhook/polling-обработчика в этом модуле НЕТ и не появляется — это
// сознательно оставлено вне рамок задачи (см. Stage 9.6: "не подключаем
// T-Bank... не делаем polling... не делаем webhook"). Единственная
// ответственность этого модуля — чистое, идемпотентное ПРИМЕНЕНИЕ уже
// полученного откуда-то (будущий адаптер/оператор) статуса к
// payout_attempts через существующий payoutService.js, ничего не выдумывая
// сверх подтверждённых 4 значений.

const payoutService = require('./payoutService');

const EXTERNAL_STATUS_IN_PROGRESS = 'IN_PROGRESS';
const EXTERNAL_STATUS_EXECUTED = 'EXECUTED';
const EXTERNAL_STATUS_FAILED = 'FAILED';
const EXTERNAL_STATUS_CANCELLED = 'CANCELLED';

// Официально подтверждённый набор — ровно эти 4 строки, ничего больше.
const KNOWN_EXTERNAL_STATUSES = new Set([
  EXTERNAL_STATUS_IN_PROGRESS,
  EXTERNAL_STATUS_EXECUTED,
  EXTERNAL_STATUS_FAILED,
  EXTERNAL_STATUS_CANCELLED,
]);

// Требуемая проектом строгая раскладка (см. задание):
//   IN_PROGRESS -> processing
//   EXECUTED    -> succeeded
//   FAILED      -> failed
//   CANCELLED   -> cancelled
//
// В payout_attempts.status НЕТ отдельного значения 'cancelled' — единственный
// нетерминальный "не успех" исход в существующей схеме — 'failed', и это
// осознанно НЕ мигрируется под новое значение: FAILED и CANCELLED требуют
// АБСОЛЮТНО одинакового поведения (задание, п.5 — "не считать успешными,
// повтор только через существующий безопасный операторский сценарий"), а
// не просто мигрируется под новое значение: FAILED и CANCELLED требуют
// различие сохраняется без потери информации через payout_attempts.bank_status
// (сырое исходное значение, см. schema.sql) и error_code — оба всегда равны
// точному внешнему статусу ('FAILED' или 'CANCELLED'), так что "CANCELLED
// -> cancelled" остаётся полностью восстановимым из данных, просто без
// отдельного значения в CHECK-ограничении, для которого потребовалась бы
// новая миграция (см. п.9 задания: "не создавай новую миграцию, если
// текущая модель уже поддерживает эти состояния" — поддерживает).
function internalActionForExternalStatus(externalStatus) {
  if (externalStatus === EXTERNAL_STATUS_IN_PROGRESS) return 'processing';
  if (externalStatus === EXTERNAL_STATUS_EXECUTED) return 'succeeded';
  if (externalStatus === EXTERNAL_STATUS_FAILED || externalStatus === EXTERNAL_STATUS_CANCELLED) return 'failed';
  return null;
}

class UnknownAttemptError extends Error {
  constructor(attemptId) {
    super(`payout_attempts: попытка id=${attemptId} не найдена`);
    this.name = 'UnknownAttemptError';
    this.statusCode = 404;
  }
}

// Применяет уже полученный (откуда — не забота этого модуля) внешний
// статус Т-Банка к конкретной попытке выплаты. Идемпотентна: повторная
// доставка ОДНОГО И ТОГО ЖЕ финального статуса (webhook retry, повторный
// poll) — безопасный no-op, а не ошибка "гонка" (см. markAttemptSucceeded/
// markAttemptFailed в payoutService.js — они рассчитаны на РЕАЛЬНЫЙ переход
// и намеренно бросают ValidationError при повторном вызове на терминальной
// строке; этот модуль перехватывает такой повтор ДО похода в payoutService,
// чтобы не путать "уже применено" с настоящей гонкой).
//
// retryableOnFailure — единственный необязательный параметр вызывающего
// кода, по умолчанию false: FAILED/CANCELLED НИКОГДА не считаются успехом
// и НИКОГДА не планируют автоматический повтор сами по себе (задание, п.5) —
// это лишь решает, вернётся ли родительское обязательство в 'prepared'
// (доступно для НОВОЙ ручной попытки оператора) или в 'blocked' (требует
// явного решения оператора) — ни то, ни другое не запускает списание само.
async function applyTBankPayoutStatus(attemptId, externalStatus, { retryableOnFailure = false } = {}) {
  const attempt = await payoutService.getAttemptById(attemptId);
  if (!attempt) throw new UnknownAttemptError(attemptId);

  if (!KNOWN_EXTERNAL_STATUSES.has(externalStatus)) {
    // Fail-safe для нераспознанного статуса (задание, п.6): не считаем
    // успешной, не создаём автоматический повтор, сохраняем исходное
    // значение, помечаем для ручной проверки, пишем структурированный лог.
    console.error('[tbankPayoutStatusMapper] неизвестный внешний статус Т-Банка — попытка помечена для ручной проверки', {
      attemptId, externalStatus, currentAttemptStatus: attempt.status,
    });
    if (payoutService.ATTEMPT_TERMINAL_STATUSES.includes(attempt.status)) {
      // Терминальная попытка неизменяема по дизайну БД (см. schema.sql,
      // fn_payout_attempts_immutable_after_terminal) — нераспознанный
      // статус после terminal ничего не может и не должен менять.
      return { action: 'ignored_unknown_status_on_terminal_attempt', attempt };
    }
    const result = await payoutService.markAttemptUnknown(
      attemptId,
      `Неизвестный статус Т-Банка: ${String(externalStatus)}`,
      String(externalStatus),
    );
    return { action: 'flagged_for_manual_review', ...result };
  }

  const idempotentTarget = internalActionForExternalStatus(externalStatus);

  // Повторная доставка уже применённого финального статуса — тихий no-op.
  if (idempotentTarget === attempt.status) {
    return { action: 'idempotent_noop', attempt };
  }

  // Терминальная попытка (succeeded/failed) сообщает статус, ПРОТИВОРЕЧАЩИЙ
  // уже зафиксированному исходу, — это не идемпотентный повтор, а
  // рассинхронизация с банком. Строка физически неизменяема (та же
  // причина, что и выше) — только громкий лог, никакого похода в БД.
  if (payoutService.ATTEMPT_TERMINAL_STATUSES.includes(attempt.status)) {
    console.error('[tbankPayoutStatusMapper] конфликт: терминальная попытка сообщает статус, отличный от уже зафиксированного', {
      attemptId, currentAttemptStatus: attempt.status, externalStatus,
    });
    return { action: 'conflict_terminal_status_mismatch', attempt };
  }

  if (externalStatus === EXTERNAL_STATUS_IN_PROGRESS) {
    // Повторное подтверждение уже processing уходит через общий
    // idempotentTarget-check выше ('processing' === attempt.status) — сюда
    // мы попадаем только когда попытка ЕЩЁ не в processing (submitting/unknown),
    // markAttemptProcessing() разрешает переход именно из этих статусов.
    const result = await payoutService.markAttemptProcessing(attemptId, externalStatus);
    return { action: 'processing', ...result };
  }

  if (externalStatus === EXTERNAL_STATUS_EXECUTED) {
    // EXECUTED — единственный статус, означающий успешное завершение
    // выплаты (задание, п.3). Ничего, кроме EXECUTED, сюда не ведёт.
    const result = await payoutService.markAttemptSucceeded(attemptId, externalStatus);
    return { action: 'succeeded', ...result };
  }

  // FAILED / CANCELLED — намеренно одинаковая обработка (см. комментарий
  // у internalActionForExternalStatus выше); errorCode/bank_status хранят
  // ТОЧНОЕ исходное значение, различие не теряется.
  const result = await payoutService.markAttemptFailed(attemptId, {
    bankStatus: externalStatus,
    errorCode: externalStatus,
    errorMessage: externalStatus === EXTERNAL_STATUS_CANCELLED
      ? 'Выплата отменена Т-Банком (CANCELLED)'
      : 'Выплата не исполнена Т-Банком (FAILED)',
    retryable: retryableOnFailure,
  });
  return { action: 'failed', ...result };
}

module.exports = {
  EXTERNAL_STATUS_IN_PROGRESS,
  EXTERNAL_STATUS_EXECUTED,
  EXTERNAL_STATUS_FAILED,
  EXTERNAL_STATUS_CANCELLED,
  KNOWN_EXTERNAL_STATUSES,
  UnknownAttemptError,
  internalActionForExternalStatus,
  applyTBankPayoutStatus,
};
