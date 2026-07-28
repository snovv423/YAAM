'use strict';

// YAAM HQ Stage 9 — рендеринг раздела «Выплаты» (read-only: список + карточка).
// Stage 9.5 добавляет read-only историю попыток на карточке (задание,
// раздел 10) — БЕЗ каких-либо кнопок управления попытками ("Выплатить" /
// "Отправить в банк" / "Повторить" / фейковый банк — задание, дословно:
// "Do NOT add any button that triggers a real or fake payout").
// Тот же общий стиль панелей/таблиц, что и hq/settlementViews.js (Stage 8).
const { esc } = require('./layout');
const { STATUS_LABELS, ATTEMPT_STATUS_LABELS } = require('../services/hq/payoutService');

function money(n) {
  return `${Number(n) || 0} ₽`;
}

function formatDateOnly(date) {
  if (!date) return '';
  if (typeof date === 'string') return date; // уже 'YYYY-MM-DD' (DATE-парсер db/postgresql/index.js)
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

// Статусы ОБЯЗАТЕЛЬСТВА (Stage 9.5, задание раздел 6): prepared/processing/
// unknown/succeeded/blocked. succeeded — единственный успешный terminal;
// blocked — деньги всё ещё должны, но нужна попытка/решение оператора.
function statusBadgeClass(status) {
  if (status === 'succeeded') return 'open';
  if (status === 'blocked') return 'closed';
  if (status === 'unknown') return 'closed';
  return 'paused'; // prepared/processing — промежуточные
}

// Статусы ПОПЫТКИ — своя, независимая от статуса обязательства раскраска.
function attemptStatusBadgeClass(status) {
  if (status === 'succeeded') return 'open';
  if (status === 'failed') return 'closed';
  if (status === 'unknown') return 'closed';
  return 'paused'; // created/submitting/processing
}

// Дата завершения обязательства — completed_at (оплачено) ИЛИ failed_at
// (кэш последнего провала — задание: обязательство хранит "cache" последней
// релевантной попытки, см. итоговый отчёт Stage 9.5); для prepared/
// processing/unknown без истории — «—».
function completionDate(payout) {
  if (payout.completed_at) return formatDateTime(payout.completed_at);
  if (payout.failed_at) return formatDateTime(payout.failed_at);
  return '—';
}

// Может ли оператор в принципе ожидать новую попытку (только для отображения
// — задание, раздел 10: "whether retry is allowed"; НЕ кнопка, просто факт).
function retryAllowedLabel(attempt) {
  if (!['succeeded', 'failed'].includes(attempt.status)) return '—';
  if (attempt.status === 'succeeded') return '—';
  return attempt.retryable ? 'Да' : 'Нет — требуется решение оператора';
}

// ---------------------------------------------------------------------------
// Список (задание: "Таблица: Ресторан / Период / Сумма / Статус / Дата
// создания / Дата завершения / Открыть. Без кнопки «Выплатить».")
// ---------------------------------------------------------------------------
function renderPayoutsListPage({ payouts, linkBasePath }) {
  const rows = payouts.length
    ? payouts.map((p) => `
      <tr>
        <td data-label="Ресторан">${esc(p.restaurant_name)}</td>
        <td data-label="Период">${esc(formatDateOnly(p.period_from))} — ${esc(formatDateOnly(p.period_to))}</td>
        <td data-label="Сумма" style="text-align:right">${money(p.amount)}</td>
        <td data-label="Статус"><span class="badge ${statusBadgeClass(p.status)}">${esc(STATUS_LABELS[p.status] || p.status)}</span></td>
        <td data-label="Создана">${esc(formatDateTime(p.created_at))}</td>
        <td data-label="Завершена">${esc(completionDate(p))}</td>
        <td data-label=""><a href="${linkBasePath}/payouts/${p.id}">Открыть</a></td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="empty-state">Выплат пока нет.</td></tr>`;

  return `
    <h1>Выплаты</h1>
    <div class="empty-state" style="margin-bottom:14px">Только просмотр. Банковская интеграция и реальные переводы денег появятся на отдельном следующем этапе.</div>
    <div class="panel">
      <table class="responsive">
        <thead><tr>
          <th>Ресторан</th><th>Период</th><th style="text-align:right">Сумма</th><th>Статус</th>
          <th>Дата создания</th><th>Дата завершения</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Карточка выплаты (задание: "ресторан, период, сумму, статус, все даты,
// заметки, внешний id (если появится)")
// ---------------------------------------------------------------------------
function renderPayoutDetail({ payout, attempts = [], linkBasePath }) {
  const attemptRows = attempts.length
    ? attempts.map((a) => `
      <tr>
        <td data-label="#">${a.attempt_number}</td>
        <td data-label="payment_id"><code>${esc(a.payment_id)}</code></td>
        <td data-label="Статус"><span class="badge ${attemptStatusBadgeClass(a.status)}">${esc(ATTEMPT_STATUS_LABELS[a.status] || a.status)}</span></td>
        <td data-label="Статус банка">${a.bank_status ? esc(a.bank_status) : '—'}</td>
        <td data-label="Создана">${esc(formatDateTime(a.created_at))}</td>
        <td data-label="Отправлена">${a.request_started_at ? esc(formatDateTime(a.request_started_at)) : '—'}</td>
        <td data-label="Завершена">${a.completed_at ? esc(formatDateTime(a.completed_at)) : (a.failed_at ? esc(formatDateTime(a.failed_at)) : '—')}</td>
        <td data-label="Причина ошибки">${a.error_message ? esc(a.error_message) : '—'}</td>
        <td data-label="Повтор допустим">${esc(retryAllowedLabel(a))}</td>
      </tr>`).join('')
    : `<tr><td colspan="9" class="empty-state">Попыток обращения к банку ещё не было.</td></tr>`;

  return `
    <h1>Выплата #${payout.id}</h1>
    <div class="panel">
      <table>
        <tr><td>Ресторан</td><td style="text-align:right"><a href="${linkBasePath}/restaurants/${payout.restaurant_id}">${esc(payout.restaurant_name)}</a></td></tr>
        <tr><td>Период</td><td style="text-align:right"><a href="${linkBasePath}/finance/settlements/${payout.settlement_period_id}">${esc(formatDateOnly(payout.period_from))} — ${esc(formatDateOnly(payout.period_to))}</a></td></tr>
        <tr><td>Сумма</td><td style="text-align:right">${money(payout.amount)}</td></tr>
        <tr><td>Статус</td><td style="text-align:right"><span class="badge ${statusBadgeClass(payout.status)}">${esc(STATUS_LABELS[payout.status] || payout.status)}</span></td></tr>
        <tr><td>Создана</td><td style="text-align:right">${esc(formatDateTime(payout.created_at))}${payout.created_by ? ` · ${esc(payout.created_by)}` : ''}</td></tr>
        <tr><td>Дата подготовки</td><td style="text-align:right">${esc(formatDateTime(payout.prepared_at))}</td></tr>
        <tr><td>В обработке с</td><td style="text-align:right">${payout.processing_at ? esc(formatDateTime(payout.processing_at)) : '—'}</td></tr>
        <tr><td>Завершена успешно</td><td style="text-align:right">${payout.completed_at ? esc(formatDateTime(payout.completed_at)) : '—'}</td></tr>
        ${payout.failure_reason ? `<tr><td>Причина последнего провала</td><td style="text-align:right">${esc(payout.failure_reason)}</td></tr>` : ''}
        <tr><td>Внешний ID (банк/провайдер)</td><td style="text-align:right">${payout.external_payout_id ? esc(payout.external_payout_id) : '—'}</td></tr>
        ${payout.notes ? `<tr><td>Заметки</td><td style="text-align:right">${esc(payout.notes)}</td></tr>` : ''}
      </table>
    </div>
    <h2>История попыток</h2>
    <div class="empty-state" style="margin-bottom:14px">Только просмотр. Банковская интеграция появится на отдельном следующем этапе — здесь нет и не может быть кнопок отправки в банк.</div>
    <div class="panel">
      <table class="responsive">
        <thead><tr>
          <th>#</th><th>payment_id</th><th>Статус</th><th>Статус банка</th>
          <th>Создана</th><th>Отправлена</th><th>Завершена</th><th>Причина ошибки</th><th>Повтор допустим</th>
        </tr></thead>
        <tbody>${attemptRows}</tbody>
      </table>
    </div>
    <a class="btn ghost" href="${linkBasePath}/payouts">← К выплатам</a>
  `;
}

module.exports = {
  renderPayoutsListPage,
  renderPayoutDetail,
};
