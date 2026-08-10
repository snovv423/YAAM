'use strict';

// YAAM HQ — RENDERER расчётных документов: payload -> HTML (docs/HQ-PRODUCT-SPEC.md).
//
// Слой намеренно отделён от модели данных (services/hq/settlementDocumentService.js):
// renderer НЕ обращается к БД и не считает деньги — он только оформляет уже
// готовый immutable payload. Повторный рендер того же payload обязан давать
// тот же документ (проверено тестом).
//
// Документ — самостоятельная печатная страница (не внутри layout HQ): его
// печатают и сохраняют в PDF средствами браузера. Кириллица корректна,
// потому что это обычный HTML в UTF-8, а не генерация шрифтовых глифов.
// Полноценный серверный PDF-renderer — PENDING (см. итоговый отчёт).
const { esc } = require('./layout');
const { DOCUMENT_KIND_LABELS } = require('../services/hq/settlementDocumentService');
const { toMskDate, MSK_SUFFIX } = require('./dateFormat');
const moneyLib = require('../services/money');

// Stage 38 — payload-суммы теперь integer minor units, money() делегирует
// канонической moneyLib.formatMinorRub(), не считает деньги сама (тот же
// принцип "renderer не обращается к БД и не считает деньги", описанный выше
// в этом файле — форматирование не является расчётом).
function money(n) {
  return moneyLib.formatMinorRub(Number(n) || 0);
}

// Уже был корректно сдвинут на московское время (был единственным из четырёх
// formatDateTime в HQ, где так) — Stage 27 переводит сдвиг на общий
// toMskDate (та же константа, не вторая копия "180") и добавляет суффикс
// "МСК", которого не хватало здесь так же, как и везде остальным.
function formatDateTime(iso) {
  const local = toMskDate(iso);
  if (!local) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}${MSK_SUFFIX}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = String(dateStr).split('-');
  return `${d}.${m}.${y}`;
}

function commissionRate(bps) {
  if (bps === null || bps === undefined) return 'по договору';
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)} %`;
}

function value(v, fallback = 'не указано') {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}

const DOC_STYLE = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f4;color:#14201a;margin:0;padding:24px 16px}
  .doc{max-width:820px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 28px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  h1{font-size:20px;margin:0 0 4px}
  .doc-sub{color:#5b6b62;font-size:13px;margin-bottom:22px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:22px}
  .party-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5b6b62;margin-bottom:6px}
  .party div{font-size:13px;line-height:1.5}
  table{width:100%;border-collapse:collapse;margin-bottom:18px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e2e6e3;font-size:13px}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#5b6b62;font-weight:600}
  td.num,th.num{text-align:right;white-space:nowrap}
  .totals td{font-size:14px}
  .totals tr.grand td{font-weight:700;border-bottom:none;border-top:2px solid #14201a}
  .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:18px}
  .table-scroll table{margin-bottom:0;min-width:520px}
  .note{font-size:12px;color:#5b6b62;margin-top:18px;line-height:1.5}
  .pending{font-size:12px;color:#8a5a10;background:#fdf3e2;border-radius:8px;padding:10px 12px;margin-top:18px;line-height:1.5}
  .correction{font-size:12px;color:#8a2f22;background:#fdecea;border-radius:8px;padding:10px 12px;margin-bottom:18px;line-height:1.5}
  @media (max-width:560px){ .parties{grid-template-columns:1fr} .doc{padding:22px 16px} }
  @media print{ body{background:#fff;padding:0} .doc{box-shadow:none;border-radius:0;max-width:none} }
`;

function documentShell({ title, body }) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<style>${DOC_STYLE}</style>
</head>
<body><div class="doc">${body}</div></body>
</html>`;
}

// Шапка корректирующей версии — владелец и ресторан должны сразу видеть, что
// это исправление, какого документа и почему.
function correctionBanner(document) {
  if (!document || document.version <= 1) return '';
  return `<div class="correction">Корректирующая версия № ${document.version}. Причина: ${esc(document.correction_reason || '')}. Исходный документ сохранён и не изменён.</div>`;
}

function renderAgentReport({ payload, document }) {
  const t = payload.totals;
  const title = `${DOCUMENT_KIND_LABELS.agent_report} ${document.document_number}`;
  const body = `
    <h1>${esc(DOCUMENT_KIND_LABELS.agent_report)} № ${esc(document.document_number)}</h1>
    <div class="doc-sub">Сформирован ${esc(formatDateTime(payload.generatedAt))} · Период ${esc(formatDate(payload.period.from))} — ${esc(formatDate(payload.period.to))}</div>
    ${correctionBanner(document)}

    <div class="parties">
      <div class="party">
        <div class="party-title">Агент</div>
        <div>${esc(value(payload.agent.legalName))}</div>
        <div>ИНН ${esc(value(payload.agent.inn, '—'))}${payload.agent.ogrnip ? ` · ОГРНИП ${esc(payload.agent.ogrnip)}` : ''}${payload.agent.kpp ? ` · КПП ${esc(payload.agent.kpp)}` : ''}</div>
        ${payload.agent.address ? `<div>${esc(payload.agent.address)}</div>` : ''}
      </div>
      <div class="party">
        <div class="party-title">Принципал</div>
        <div>${esc(value(payload.principal.legalName || payload.principal.displayName))}</div>
        <div>ИНН ${esc(value(payload.principal.inn, '—'))}${payload.principal.ogrn ? ` · ОГРН ${esc(payload.principal.ogrn)}` : ''}</div>
        ${payload.principal.legalAddress ? `<div>${esc(payload.principal.legalAddress)}</div>` : ''}
      </div>
    </div>

    <table>
      <tr><td>Агентский договор</td><td class="num">${payload.contract.number ? `№ ${esc(payload.contract.number)}${payload.contract.signedAt ? ` от ${esc(formatDate(payload.contract.signedAt))}` : ''}` : 'не оформлен'}</td></tr>
      <tr><td>Расчётный период</td><td class="num">${esc(formatDate(payload.period.from))} — ${esc(formatDate(payload.period.to))}</td></tr>
    </table>

    <table class="totals">
      <tr><td>Количество заказов</td><td class="num">${t.ordersCount}</td></tr>
      <tr><td>Сумма продаж через YAAM</td><td class="num">${esc(money(t.sales))}</td></tr>
      <tr><td>Возвраты покупателям${t.refundsCount ? ` (${t.refundsCount})` : ''}</td><td class="num">${esc(money(t.refunds))}</td></tr>
      <tr><td>База вознаграждения</td><td class="num">${esc(money(t.commissionBase))}</td></tr>
      <tr><td>Ставка вознаграждения агента</td><td class="num">${esc(commissionRate(t.commissionBps))}</td></tr>
      <tr><td>Вознаграждение агента (YAAM)</td><td class="num">${esc(money(t.commissionAmount))}</td></tr>
      ${t.adjustmentRestaurantAmount
        ? `<tr><td>Удержано за возвраты по заказам прошлых периодов</td><td class="num">−${esc(money(t.adjustmentRestaurantAmount))}</td></tr>`
        : ''}
      ${t.carryForwardApplied
        ? `<tr><td>Удержано в счёт долга прошлых периодов</td><td class="num">−${esc(money(t.carryForwardApplied))}</td></tr>`
        : ''}
      <tr class="grand"><td>К перечислению принципалу</td><td class="num">${esc(money(t.payableAmount))}</td></tr>
      ${t.carryForwardRemaining
        ? `<tr><td>Остаток долга, переносится на следующий период</td><td class="num">${esc(money(t.carryForwardRemaining))}</td></tr>`
        : ''}
    </table>

    ${(payload.adjustments && payload.adjustments.length) ? `
    <div class="table-scroll">
      <table>
        <thead><tr><th>Заказ</th><th>Период начисления</th><th class="num">Удержано</th><th class="num">Возвращена комиссия</th></tr></thead>
        <tbody>${payload.adjustments.map((a) => `
          <tr><td>${esc(a.orderCode)}</td><td>${esc(formatDate(a.originPeriodFrom))} — ${esc(formatDate(a.originPeriodTo))}</td>
              <td class="num">${esc(money(a.restaurantAmount))}</td>
              <td class="num">${esc(money(a.commissionAmount))}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="note">Возвраты по заказам прошлых периодов. Заказ был учтён в отчёте за более
      ранний период и оплачен; после возврата денег покупателю начисленная за этот заказ сумма
      удерживается из текущего расчёта. Вознаграждение агента по тем же заказам
      (${esc(money(t.adjustmentCommissionAmount))}) YAAM также не удерживает — эта сумма не входит
      в удержание с принципала и показана отдельной колонкой выше.</div>` : ''}
    <div class="note">База вознаграждения равна сумме продаж по заказам, вошедшим в расчёт.
      Полностью возвращённый заказ в расчёт не включается и в сумме продаж не отражается,
      поэтому возвраты из базы повторно не вычитаются.</div>
    <div class="note">Приложение: «${esc(DOCUMENT_KIND_LABELS.order_registry)}» за тот же период — построчный перечень операций, вошедших в расчёт.</div>
    ${payload.acceptanceTermsPending
      ? '<div class="pending">Срок принятия отчёта и порядок направления возражений не заполнены: соответствующее условие агентского договора ещё не согласовано. Формулировка будет добавлена после утверждения договора.</div>'
      : `<div class="note">${esc(payload.acceptanceTerms)}</div>`}
  `;
  return documentShell({ title, body });
}

function renderOrderRegistry({ payload, document }) {
  const t = payload.totals;
  const title = `${DOCUMENT_KIND_LABELS.order_registry} ${document.document_number}`;
  const rows = payload.rows.length
    ? payload.rows.map((r) => `
      <tr>
        <td>${esc(r.orderCode)}</td>
        <td>${esc(formatDateTime(r.occurredAt))}</td>
        <td class="num">${esc(money(r.sales))}</td>
        <td class="num">${r.refund ? esc(money(r.refund)) : '—'}</td>
        <td class="num">${esc(money(r.commissionBase))}</td>
        <td class="num">${esc(money(r.commission))}</td>
        <td class="num">${esc(money(r.restaurantAmount))}</td>
        <td>${esc(r.status)}</td>
      </tr>`).join('')
    : '<tr><td colspan="8">За период операций нет.</td></tr>';

  const body = `
    <h1>${esc(DOCUMENT_KIND_LABELS.order_registry)} № ${esc(document.document_number)}</h1>
    <div class="doc-sub">Приложение к отчёту агента · Период ${esc(formatDate(payload.period.from))} — ${esc(formatDate(payload.period.to))} · ${esc(value(payload.principal.legalName || payload.principal.displayName))}</div>
    ${correctionBanner(document)}

    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Заказ</th><th>Дата и время</th><th class="num">Продажи</th><th class="num">Возврат</th>
          <th class="num">База</th><th class="num">Комиссия</th><th class="num">Ресторану</th><th>Статус</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <table class="totals">
      <tr><td>Заказов</td><td class="num">${t.ordersCount}</td></tr>
      <tr><td>Продажи</td><td class="num">${esc(money(t.sales))}</td></tr>
      <tr><td>Возвраты</td><td class="num">${esc(money(t.refunds))}</td></tr>
      <tr><td>База вознаграждения</td><td class="num">${esc(money(t.commissionBase))}</td></tr>
      <tr><td>Комиссия YAAM</td><td class="num">${esc(money(t.commission))}</td></tr>
      ${t.adjustmentRestaurantAmount
        ? `<tr><td>Удержано за возвраты прошлых периодов</td><td class="num">−${esc(money(t.adjustmentRestaurantAmount))}</td></tr>`
        : ''}
      ${t.carryForwardApplied
        ? `<tr><td>Удержано в счёт долга прошлых периодов</td><td class="num">−${esc(money(t.carryForwardApplied))}</td></tr>`
        : ''}
      <tr class="grand"><td>К перечислению</td><td class="num">${esc(money(t.payableAmount))}</td></tr>
      ${t.carryForwardRemaining
        ? `<tr><td>Остаток долга</td><td class="num">${esc(money(t.carryForwardRemaining))}</td></tr>`
        : ''}
    </table>

    <div class="note">Реестр содержит только финансовые данные операций. Персональные данные покупателей (имя, телефон, адрес, комментарии) в документ не включаются.</div>
  `;
  return documentShell({ title, body });
}

// Единая точка рендера — роут не должен знать про виды документов.
function renderDocument(document) {
  const payload = typeof document.payload === 'string' ? JSON.parse(document.payload) : document.payload;
  if (document.kind === 'agent_report') return renderAgentReport({ payload, document });
  if (document.kind === 'order_registry') return renderOrderRegistry({ payload, document });
  throw new Error(`Неизвестный вид документа: ${document.kind}`);
}

module.exports = {
  renderDocument,
  renderAgentReport,
  renderOrderRegistry,
  documentShell,
};
