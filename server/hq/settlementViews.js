'use strict';

// YAAM HQ Stage 8 — рендеринг расчётных периодов (задание, раздел 9-10):
// секция на /hq/finance, форма создания, страница конкретного периода. Тот
// же общий стиль панелей/таблиц, что и hq/restaurantFinanceViews.js (Stage 6)
// и routes/hq/pages.js renderFinancePage (Stage 7) — не изобретён заново.
const { esc } = require('./layout');
const { READINESS_LABELS } = require('../services/hq/restaurantPayoutService');

const STATUS_LABELS = { draft: 'Черновик', closed: 'Закрыт' };

function money(n) {
  return `${Number(n) || 0} ₽`;
}

function formatDateOnly(date) {
  if (!date) return '';
  if (typeof date === 'string') return date; // уже 'YYYY-MM-DD' (см. db/postgresql/index.js DATE-парсер)
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatDateTime(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// Секция «Расчётные периоды» на /hq/finance (задание, раздел 9).
// ---------------------------------------------------------------------------
function renderSettlementPeriodsSection({ periods, linkBasePath }) {
  const rows = periods.length
    ? periods.map((p) => `
      <tr>
        <td data-label="Период">${esc(formatDateOnly(p.periodFrom))} — ${esc(formatDateOnly(p.periodTo))}</td>
        <td data-label="Статус"><span class="badge ${p.status === 'closed' ? 'open' : 'closed'}">${esc(STATUS_LABELS[p.status] || p.status)}</span></td>
        <td data-label="Создан">${esc(formatDateTime(p.createdAt))}</td>
        <td data-label="Закрыт">${p.closedAt ? esc(formatDateTime(p.closedAt)) : '—'}</td>
        <td data-label="Ресторанов" style="text-align:right">${p.restaurantCount}</td>
        <td data-label="Оборот" style="text-align:right">${money(p.turnover)}</td>
        <td data-label="Комиссия" style="text-align:right">${money(p.commission)}</td>
        <td data-label="Сумма ресторанов" style="text-align:right">${money(p.restaurantEarnings)}</td>
        <td data-label=""><a href="${linkBasePath}/finance/settlements/${p.id}">Открыть</a></td>
      </tr>`).join('')
    : `<tr><td colspan="9" class="empty-state">Расчётных периодов пока нет.</td></tr>`;

  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-weight:700">Расчётные периоды</div>
        <a class="btn ghost" href="${linkBasePath}/finance/settlements/new">+ Новый период</a>
      </div>
      <table class="responsive">
        <thead><tr>
          <th>Период</th><th>Статус</th><th>Создан</th><th>Закрыт</th><th>Ресторанов</th>
          <th style="text-align:right">Оборот</th><th style="text-align:right">Комиссия</th>
          <th style="text-align:right">Сумма ресторанов</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Форма создания периода (задание, раздел 11).
// ---------------------------------------------------------------------------
function renderSettlementPeriodCreateForm({ linkBasePath, csrfToken, error, values = {} }) {
  const backUrl = `${linkBasePath}/finance`;
  return `
    <h1>Новый расчётный период</h1>
    <div class="panel">
      <form method="post" action="${linkBasePath}/finance/settlements">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="sp-from">Дата начала</label>
        <input id="sp-from" name="period_from" type="date" value="${esc(values.period_from || '')}" required autocomplete="off">
        <label for="sp-to">Дата окончания</label>
        <input id="sp-to" name="period_to" type="date" value="${esc(values.period_to || '')}" required autocomplete="off">
        <label for="sp-notes">Примечание (необязательно)</label>
        <textarea id="sp-notes" name="notes" autocomplete="off">${esc(values.notes || '')}</textarea>
        <button type="submit">Создать</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost" href="${backUrl}">← К финансам</a>
  `;
}

// ---------------------------------------------------------------------------
// Страница периода (задание, раздел 10).
// ---------------------------------------------------------------------------
function renderSettlementPeriodDetail({ period, lines, preview, linkBasePath, csrfToken }) {
  const totals = lines.reduce((acc, l) => ({
    orders: acc.orders + Number(l.delivered_paid_orders),
    turnover: acc.turnover + Number(l.turnover),
    commission: acc.commission + Number(l.yaam_commission),
    earnings: acc.earnings + Number(l.restaurant_earnings),
    refundsCount: acc.refundsCount + Number(l.successful_refunds_count),
    refundsAmount: acc.refundsAmount + Number(l.successful_refunds_amount),
    payable: acc.payable + Number(l.payable_amount),
  }), { orders: 0, turnover: 0, commission: 0, earnings: 0, refundsCount: 0, refundsAmount: 0, payable: 0 });

  const rows = lines.length
    ? lines.map((l) => {
        const readinessLabel = READINESS_LABELS[l.payout_readiness_snapshot] || l.payout_readiness_snapshot;
        const readinessBadgeClass = l.payout_readiness_snapshot === 'ready' ? 'open' : 'closed';
        const bpsLabel = l.commission_bps_summary === null || l.commission_bps_summary === undefined
          ? '—'
          : `${(Number(l.commission_bps_summary) / 100).toFixed(2).replace(/\.?0+$/, '') || '0'}%`;
        return `<tr>
          <td data-label="Ресторан"><a href="${linkBasePath}/restaurants/${l.restaurant_id}">${esc(l.restaurant_name)}</a></td>
          <td data-label="Договор">${l.contract_number_snapshot ? esc(l.contract_number_snapshot) : '—'}</td>
          <td data-label="Комиссия, %">${esc(bpsLabel)}</td>
          <td data-label="Готовность"><span class="badge ${readinessBadgeClass}">${esc(readinessLabel)}</span></td>
          <td data-label="Заказов" style="text-align:right">${l.delivered_paid_orders}</td>
          <td data-label="Оборот" style="text-align:right">${money(l.turnover)}</td>
          <td data-label="Комиссия YAAM" style="text-align:right">${money(l.yaam_commission)}</td>
          <td data-label="Сумма ресторана" style="text-align:right">${money(l.restaurant_earnings)}</td>
          <td data-label="Возвращено клиентам" style="text-align:right">${l.successful_refunds_count} шт · ${money(l.successful_refunds_amount)}</td>
          <td data-label="К выплате" style="text-align:right">${money(l.payable_amount)}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="10" class="empty-state">Активности в этом периоде нет.</td></tr>`;

  const statusNotice = preview
    ? `<div class="panel"><div class="empty-state" style="margin-top:0">Предварительный расчёт, суммы ещё могут измениться.</div></div>`
    : `<div class="panel"><div class="notice" style="margin-top:0">Период закрыт, суммы зафиксированы.</div></div>`;

  const closeAction = preview
    ? `<form method="post" action="${linkBasePath}/finance/settlements/${period.id}/close" style="display:inline" onsubmit="return confirm('Закрыть период ${esc(formatDateOnly(period.period_from))} — ${esc(formatDateOnly(period.period_to))}? Суммы будут зафиксированы навсегда.')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit">Закрыть период</button>
      </form>
      <form method="post" action="${linkBasePath}/finance/settlements/${period.id}/delete" style="display:inline;margin-left:8px" onsubmit="return confirm('Удалить черновик периода? Действие необратимо.')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="ghost">Удалить черновик</button>
      </form>`
    : '';

  return `
    <h1>Расчётный период: ${esc(formatDateOnly(period.period_from))} — ${esc(formatDateOnly(period.period_to))}</h1>
    <div class="panel">
      <table>
        <tr><td>Статус</td><td style="text-align:right"><span class="badge ${period.status === 'closed' ? 'open' : 'closed'}">${esc(STATUS_LABELS[period.status] || period.status)}</span></td></tr>
        <tr><td>Создан</td><td style="text-align:right">${esc(formatDateTime(period.created_at))}${period.created_by ? ` · ${esc(period.created_by)}` : ''}</td></tr>
        <tr><td>Закрыт</td><td style="text-align:right">${period.closed_at ? esc(formatDateTime(period.closed_at)) : '—'}</td></tr>
        ${period.notes ? `<tr><td>Примечание</td><td style="text-align:right">${esc(period.notes)}</td></tr>` : ''}
        <tr><td>Доставленных оплаченных заказов</td><td style="text-align:right">${totals.orders}</td></tr>
        <tr><td>Оборот</td><td style="text-align:right">${money(totals.turnover)}</td></tr>
        <tr><td>Комиссия YAAM</td><td style="text-align:right">${money(totals.commission)}</td></tr>
        <tr><td>Сумма ресторанов</td><td style="text-align:right">${money(totals.earnings)}</td></tr>
        <tr><td>Возвращено клиентам</td><td style="text-align:right">${totals.refundsCount} шт · ${money(totals.refundsAmount)}</td></tr>
        <tr><td>К выплате (всего по периоду)</td><td style="text-align:right">${money(totals.payable)}</td></tr>
      </table>
    </div>
    ${statusNotice}
    ${closeAction ? `<div class="panel">${closeAction}</div>` : ''}
    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Рестораны</div>
      <table class="responsive">
        <thead><tr>
          <th>Ресторан</th><th>Договор</th><th>Комиссия, %</th><th>Готовность</th><th>Заказов</th>
          <th style="text-align:right">Оборот</th><th style="text-align:right">Комиссия YAAM</th>
          <th style="text-align:right">Сумма ресторана</th><th style="text-align:right">Возвращено клиентам</th>
          <th style="text-align:right">К выплате</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <a class="btn ghost" href="${linkBasePath}/finance">← К финансам</a>
  `;
}

module.exports = {
  STATUS_LABELS,
  renderSettlementPeriodsSection,
  renderSettlementPeriodCreateForm,
  renderSettlementPeriodDetail,
};
