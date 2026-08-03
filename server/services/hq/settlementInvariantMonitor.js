'use strict';

// YAAM Stage 22 — runtime-контроль расчётных инвариантов (закрытие HIGH-3).
//
// ЗАЧЕМ. checkSettlementInvariants() был написан и покрыт тестами, но
// вызывался ТОЛЬКО из тестов. Ни один работающий путь его не выполнял, значит
// нарушение — заказ в двух периодах, расхождение сумм строки со снимками —
// не было бы обнаружено до жалобы ресторана.
//
// ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ. Запускает существующую проверку и превращает её
// результат в наблюдаемое состояние: аудит, событие в Центре событий HQ,
// structured log и признак финансовой готовности для readiness.
//
// ЧЕГО НЕ ДЕЛАЕТ. Не чинит данные. Закрытый период неизменяем, и
// автоматическая «починка» финансовых снимков была бы хуже самой проблемы:
// расхождение нужно разобрать, а не затереть.
const db = require('../../db/postgresql');
const settlementService = require('./settlementService');
const { logAuditEvent } = require('./auditLog');

// Человеческие названия — событие в HQ читает владелец, а не разработчик.
const VIOLATION_LABELS = {
  closed_period_without_restaurant_lines: 'закрытый период без строк расчёта',
  draft_period_with_committed_lines: 'черновик периода с зафиксированными строками',
  order_counted_in_multiple_periods: 'заказ учтён в нескольких периодах',
  refund_counted_in_multiple_periods: 'возврат учтён в нескольких периодах',
  restaurant_line_totals_mismatch: 'суммы строки расходятся со снимками заказов',
};

// Последнее состояние держим в базе, а не в памяти процесса: иначе каждый
// рестарт начинал бы сообщать об одном и том же заново.
//
// Подпись — устойчивое представление состава нарушений. Одинаковая подпись
// означает «ничего не изменилось» и не порождает нового события.
function buildSignature(violations) {
  if (!violations.length) return 'ok';
  return violations
    .map((v) => `${v.kind}:${v.count ?? 0}`)
    .sort()
    .join('|');
}

function describe(violations) {
  return violations
    .map((v) => `${VIOLATION_LABELS[v.kind] || v.kind} (${v.count ?? 0})`)
    .join('; ');
}

async function lastSignature() {
  const rows = await db.query(
    `SELECT action, details FROM hq_audit_log
      WHERE action IN ('settlement_invariant_violated', 'settlement_invariant_recovered')
      ORDER BY id DESC LIMIT 1`,
  );
  if (!rows[0]) return null;
  if (rows[0].action === 'settlement_invariant_recovered') return 'ok';
  const m = /\[signature:([^\]]*)\]/.exec(rows[0].details || '');
  return m ? m[1] : null;
}

// Текущее состояние финансовой готовности. Читается readiness'ом.
// 'ok' | 'degraded' | 'unknown' — 'unknown' до первого прогона.
let financialHealth = { state: 'unknown', violations: 0, checkedAt: null, summary: '' };

function getFinancialHealth() {
  return { ...financialHealth };
}

// Один прогон проверки.
//
// Возвращает { ok, violations, reported } — reported показывает, было ли
// записано новое событие (то есть изменилось ли состояние).
async function runInvariantCheck({ now = new Date() } = {}) {
  let result;
  try {
    result = await settlementService.checkSettlementInvariants();
  } catch (err) {
    // Сбой самой проверки — это не «инвариантов нет», а «мы не знаем».
    // Врать в сторону «всё хорошо» здесь недопустимо.
    console.error('[settlementInvariants] проверка не выполнена:', err.message);
    financialHealth = {
      state: 'unknown', violations: 0, checkedAt: now.toISOString(),
      summary: `проверка не выполнена: ${err.message}`,
    };
    return { ok: false, violations: [], reported: false, error: err.message };
  }

  const violations = result.violations || [];
  const signature = buildSignature(violations);
  const previous = await lastSignature();
  // Первый прогон на системе без истории и без нарушений — это не
  // «восстановление»: объявлять о починке того, что не ломалось, значит
  // приучать владельца пропускать такие сообщения.
  if (previous === null && violations.length === 0) {
    financialHealth = {
      state: 'ok', violations: 0, checkedAt: now.toISOString(), summary: '',
    };
    return { ok: true, violations, reported: false };
  }
  const changed = previous !== signature;

  financialHealth = {
    state: violations.length ? 'degraded' : 'ok',
    violations: violations.length,
    checkedAt: now.toISOString(),
    summary: violations.length ? describe(violations) : '',
  };

  if (!changed) return { ok: violations.length === 0, violations, reported: false };

  if (violations.length === 0) {
    // Восстановление — самостоятельное событие: владелец обязан узнать не
    // только о поломке, но и о том, что она закрыта.
    await logAuditEvent({
      action: 'settlement_invariant_recovered', restaurantId: null,
      details: 'нарушений расчётных инвариантов больше нет', ip: null,
    });
    console.log('[settlementInvariants] нарушений нет — состояние восстановлено');
    await safeEvent('Расчётные инварианты в порядке: ранее обнаруженное расхождение больше не воспроизводится.');
    return { ok: true, violations, reported: true, recovered: true };
  }

  const summary = describe(violations);
  // Подпись хранится прямо в тексте: дедупликация переживает рестарт.
  await logAuditEvent({
    action: 'settlement_invariant_violated', restaurantId: null,
    details: `${summary} [signature:${signature}]`, ip: null,
  });
  console.error(
    `[settlementInvariants] НАРУШЕНИЕ: ${summary}. Финансовые данные не изменялись — требуется разбор.`,
  );
  await safeEvent(
    `Обнаружено расхождение в расчётах: ${summary}. Данные автоматически не исправлялись — требуется разбор.`,
  );
  return { ok: false, violations, reported: true };
}

async function safeEvent(message) {
  try {
    const eventLogService = require('./eventLogService');
    await eventLogService.createEvent({ category: 'backend_issue', message });
  } catch (err) {
    console.error('[settlementInvariants] не удалось записать событие:', err.message);
  }
}

module.exports = {
  VIOLATION_LABELS,
  buildSignature,
  describe,
  runInvariantCheck,
  getFinancialHealth,
};
