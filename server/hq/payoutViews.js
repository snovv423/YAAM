'use strict';

// YAAM HQ Stage 9 — рендеринг раздела «Выплаты» (read-only: список + карточка).
// Stage 9.5 добавляет read-only историю попыток на карточке (задание,
// раздел 10) — БЕЗ каких-либо кнопок управления попытками ("Выплатить" /
// "Отправить в банк" / "Повторить" / фейковый банк — задание, дословно:
// "Do NOT add any button that triggers a real or fake payout"). Stage 9.6
// добавляет блок готовности к Т-Банку и МАСКИРОВАННЫЙ снимок реквизитов
// каждой попытки (задание, раздел 10) — по-прежнему без единой кнопки
// отправки/повтора.
// Тот же общий стиль панелей/таблиц, что и hq/settlementViews.js (Stage 8).
const { esc } = require('./layout');
const { STATUS_LABELS, ATTEMPT_STATUS_LABELS } = require('../services/hq/payoutService');
const { READINESS_REASONS } = require('../services/hq/tbankPayoutReadiness');
const { maskAccountForUi } = require('../services/hq/ruRequisites');

// Человекочитаемые причины неготовности (задание, раздел 8: "Возвращать
// понятные machine-readable причины") — machine-readable коды остаются в
// tbankPayoutReadiness.js; здесь только их представление для оператора.
const READINESS_REASON_LABELS = {
  missing_yaam_bank_details: 'Не заполнены реквизиты YAAM (Настройки → Реквизиты YAAM для выплат)',
  invalid_yaam_bank_details: 'Реквизиты YAAM некорректны — проверьте БИК/счета/ИНН',
  missing_restaurant_bank_details: 'У ресторана не заполнены банковские реквизиты',
  invalid_restaurant_bank_details: 'Банковские реквизиты ресторана некорректны — проверьте БИК/счета',
  contract_not_signed: 'Договор с рестораном не подписан',
  missing_payment_purpose: 'Не определено назначение платежа — заполните его в реквизитах ресторана',
  active_attempt_exists: 'У выплаты уже есть активная попытка',
  payout_already_succeeded: 'Выплата уже успешно завершена',
  legacy_state_requires_review: 'Обнаружено рассогласование состояния — требуется ручной разбор',
  ready: 'Готова к отправке',
};
void READINESS_REASONS; // импортирован для документируемой связи с источником enum, не используется напрямую в рендере

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

// Stage 9.6 — блок готовности к Т-Банку (задание, раздел 10: "«Готовность к
// отправке через Т-Банк»; причина, если не готово"). readiness — результат
// tbankPayoutReadiness.getTBankPayoutReadiness(payoutId), { ready, reasons }.
function renderReadinessSection({ readiness }) {
  if (!readiness) return '';
  const badgeClass = readiness.ready ? 'open' : 'closed';
  const badgeLabel = readiness.ready ? 'Готова к отправке' : 'Не готова';
  const reasonsList = readiness.ready
    ? ''
    : `<ul style="margin:10px 0 0;padding-left:18px">${readiness.reasons.map((r) => `<li>${esc(READINESS_REASON_LABELS[r] || r)}</li>`).join('')}</ul>`;
  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:700">Готовность к отправке через Т-Банк</div>
        <span class="badge ${badgeClass}">${esc(badgeLabel)}</span>
      </div>
      ${reasonsList}
      <div class="empty-state" style="margin-top:10px">Это только предпросмотр готовности — банк ещё не подключён, ничего не отправляется.</div>
    </div>`;
}

// Маскированный снимок реквизитов конкретной попытки (задание, раздел 5/10:
// "snapshot реквизитов попытки в маскированном виде"; раздел 3: "read-only
// overview показывает маскированные значения"). requisites — строка
// payout_attempt_requisites либо null (снимка нет — например, историческая
// Stage 9.5 попытка, созданная до Stage 9.6).
function renderAttemptRequisites(requisites) {
  if (!requisites) return '<div class="empty-state">Снимок реквизитов недоступен (попытка создана до Stage 9.6).</div>';
  return `
    <table>
      <tr><td>Получатель</td><td style="text-align:right">${esc(requisites.recipient_name)}</td></tr>
      <tr><td>Банк получателя</td><td style="text-align:right">${esc(requisites.bank_name)}</td></tr>
      <tr><td>Счёт получателя</td><td style="text-align:right">${esc(maskAccountForUi(requisites.account_number))}</td></tr>
      <tr><td>Счёт YAAM (плательщик)</td><td style="text-align:right">${esc(maskAccountForUi(requisites.payer_account_number))}</td></tr>
      <tr><td>Назначение платежа</td><td style="text-align:right">${esc(requisites.payment_purpose)}</td></tr>
      <tr><td>Сумма снимка</td><td style="text-align:right">${money(requisites.amount)}</td></tr>
    </table>`;
}

// ---------------------------------------------------------------------------
// Карточка выплаты (задание: "ресторан, период, сумму, статус, все даты,
// заметки, внешний id (если появится)")
// ---------------------------------------------------------------------------
function renderPayoutDetail({ payout, attempts = [], requisitesByAttemptId = new Map(), readiness = null, linkBasePath }) {
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

  const requisitesBlocks = attempts.length
    ? attempts.map((a) => `
      <div style="margin-bottom:14px">
        <div style="font-weight:600;margin-bottom:6px">Попытка #${a.attempt_number} (${esc(a.payment_id)})</div>
        ${renderAttemptRequisites(requisitesByAttemptId.get(a.id))}
      </div>`).join('')
    : `<div class="empty-state">Снимков реквизитов ещё нет — попыток не было.</div>`;

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
    ${renderReadinessSection({ readiness })}
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
    <h2>Снимки реквизитов (маскировано)</h2>
    <div class="panel">
      ${requisitesBlocks}
    </div>
    <a class="btn ghost" href="${linkBasePath}/payouts">← К выплатам</a>
  `;
}

module.exports = {
  renderPayoutsListPage,
  renderPayoutDetail,
};
