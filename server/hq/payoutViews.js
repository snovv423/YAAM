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
const { STATUS_LABELS, ATTEMPT_STATUS_LABELS, ATTEMPT_METHOD_LABELS } = require('../services/hq/payoutService');
const { READINESS_REASONS } = require('../services/hq/tbankPayoutReadiness');
const { maskAccountForUi } = require('../services/hq/ruRequisites');
const { toMskDate, MSK_SUFFIX } = require('./dateFormat');

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

// Stage 27 — закрытие возможного дефекта часового пояса (Stage 26, раздел
// 2): раньше здесь были сырые getUTCHours() без какого-либо сдвига —
// формально верно преобразованная дата платежа (20:00 МСК владельца)
// показывалась как 17:00 без единой пометки, что это уже другой пояс.
function formatDateTime(date) {
  const local = toMskDate(date);
  if (!local) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}${MSK_SUFFIX}`;
}

// Статусы ПОПЫТКИ — своя, независимая от статуса обязательства раскраска.
function attemptTone(status) {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'unknown') return 'danger';
  return 'muted'; // created/submitting/processing
}

// ---------------------------------------------------------------------------
// Реестр выплат (docs/HQ-PRODUCT-SPEC.md, раздел «Финансы → Реестр выплат»).
// Дочерний экран «Финансов», не отдельная главная вкладка. Разделы:
// К отправке / В обработке / Выплаченные / Ошибка. Компактные строки, не
// техническая таблица.
// ---------------------------------------------------------------------------

// Фирменный тон статуса обязательства — тот же словарь тонов, что и на
// экране «Статус выплат» (services/hq/payoutStatusService.js), чтобы один и
// тот же статус нигде не выглядел по-разному.
function statusTone(status) {
  if (status === 'succeeded') return 'ok';
  if (status === 'blocked') return 'danger';
  if (status === 'unknown') return 'danger';
  return 'muted'; // prepared/processing
}

// Раздел реестра, в который попадает обязательство. Один статус — ровно один
// раздел (спецификация: четыре раздела, без пересечений).
function registrySection(status) {
  if (status === 'succeeded') return 'paid';
  if (status === 'blocked' || status === 'unknown') return 'failed';
  if (status === 'processing') return 'processing';
  return 'outbox'; // prepared
}

const REGISTRY_SECTIONS = [
  ['outbox', 'К отправке'],
  ['processing', 'В обработке'],
  ['paid', 'Выплаченные'],
  ['failed', 'Ошибка'],
];

function payoutRow(p, linkBasePath) {
  return `
    <li class="payout-row">
      <div class="payout-row-main">
        <div class="payout-row-name">${esc(p.restaurant_name)} · ${money(p.amount)}</div>
        <div class="payout-row-meta">
          <span class="status-badge ${statusTone(p.status)}">${esc(STATUS_LABELS[p.status] || p.status)}</span>
          <span class="payout-row-sub">${esc(formatDateOnly(p.period_from))} — ${esc(formatDateOnly(p.period_to))}</span>
        </div>
        <div class="payout-row-sub">Подготовлена: ${esc(formatDateTime(p.prepared_at || p.created_at))} · Выплачена: ${esc(p.completed_at ? formatDateTime(p.completed_at) : '—')}</div>
      </div>
      <div class="payout-row-actions">
        <a class="btn ghost compact" href="${linkBasePath}/payouts/${p.id}">Открыть</a>
      </div>
    </li>`;
}

function renderPayoutsListPage({ payouts, linkBasePath }) {
  const grouped = new Map(REGISTRY_SECTIONS.map(([key]) => [key, []]));
  for (const p of payouts) grouped.get(registrySection(p.status)).push(p);

  const sections = REGISTRY_SECTIONS
    .filter(([key]) => grouped.get(key).length > 0)
    .map(([key, label]) => `
      <div class="panel">
        <div class="panel-title">${esc(label)}</div>
        <ul class="payout-list">${grouped.get(key).map((p) => payoutRow(p, linkBasePath)).join('')}</ul>
      </div>`).join('');

  return `
    <h1>Все выплаты</h1>
    ${sections || '<div class="panel"><div class="empty-state">Выплат пока нет.</div></div>'}
    <a class="btn ghost compact" href="${linkBasePath}/finance">← К финансам</a>
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

// Stage 25 — единственное write-действие на карточке выплаты: подтверждение
// уже совершённого владельцем перевода. Показывается ТОЛЬКО когда
// status === 'prepared' (задание: "нельзя подтвердить заблокированную или
// неподготовленную выплату" — на любом другом статусе кнопки нет вовсе,
// сервер проверяет это же условие независимо).
function renderManualConfirmSection({ payout, pendingRequisitesPreview, linkBasePath, csrfToken, error }) {
  if (payout.status !== 'prepared') return '';
  const base = `${linkBasePath}/payouts/${payout.id}`;

  const requisitesRows = pendingRequisitesPreview
    ? `
      <tr><td>Получатель</td><td style="text-align:right">${esc(pendingRequisitesPreview.recipient_name)}</td></tr>
      <tr><td>Банк получателя</td><td style="text-align:right">${esc(pendingRequisitesPreview.bank_name)}</td></tr>
      <tr><td>Счёт получателя</td><td style="text-align:right">${esc(maskAccountForUi(pendingRequisitesPreview.account_number))}</td></tr>`
    : `<tr><td colspan="2">Банковские реквизиты ресторана не заполнены — подтвердить нельзя, пока их не внесут в карточку ресторана.</td></tr>`;

  return `
    <div class="panel">
      <div class="panel-title">Отметить выплаченной</div>
      ${error ? `<div class="error" style="margin-bottom:12px">${esc(error)}</div>` : ''}
      <div class="empty-state" style="margin-bottom:12px">
        Это действие подтверждает УЖЕ СОВЕРШЁННЫЙ вами перевод через банк-клиент —
        YAAM деньги не отправляет и банк не задействован. Проверьте реквизиты ниже
        перед подтверждением: ${money(payout.amount)} ресторану «${esc(payout.restaurant_name)}»
        за период ${esc(formatDateOnly(payout.period_from))} — ${esc(formatDateOnly(payout.period_to))}.
      </div>
      <table style="margin-bottom:14px">${requisitesRows}</table>
      ${pendingRequisitesPreview ? `
      <form method="post" action="${base}/confirm-manual"
            onsubmit="return confirm('Подтвердить, что перевод ${money(payout.amount)} ресторану «${esc(payout.restaurant_name)}» уже выполнен?')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label>Дата и время платежа (по московскому времени)
          <input type="datetime-local" name="paid_at" required>
        </label>
        <label>Номер платёжного поручения / банковской операции
          <input type="text" name="operation_reference" maxlength="64" required placeholder="Например, 000123">
        </label>
        <label>Комментарий (необязательно)
          <textarea name="comment" maxlength="300" rows="2"></textarea>
        </label>
        <button type="submit">Отметить выплаченной</button>
      </form>` : ''}
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
function renderPayoutDetail({
  payout, attempts = [], requisitesByAttemptId = new Map(), readiness = null, linkBasePath,
  csrfToken = '', error = null, pendingRequisitesPreview = null,
}) {
  const attemptBlocks = attempts.length
    ? attempts.map((a) => `
      <li class="attempt-row">
        <div class="attempt-head">
          <span class="attempt-number">Попытка ${a.attempt_number}</span>
          <span class="status-badge ${attemptTone(a.status)}">${esc(ATTEMPT_STATUS_LABELS[a.status] || a.status)}</span>
        </div>
        <div class="payout-row-sub">Способ: ${esc(ATTEMPT_METHOD_LABELS[a.method] || a.method)}${a.confirmed_by ? ` · Подтвердил: ${esc(a.confirmed_by)}` : ''}</div>
        <div class="payout-row-sub">Создана: ${esc(formatDateTime(a.created_at))}${a.request_started_at ? ` · Отправлена: ${esc(formatDateTime(a.request_started_at))}` : ''}${a.completed_at ? ` · Завершена: ${esc(formatDateTime(a.completed_at))}` : (a.failed_at ? ` · Ошибка: ${esc(formatDateTime(a.failed_at))}` : '')}</div>
        <div class="payout-row-sub">Номер операции: <code>${esc(a.payment_id)}</code></div>
        ${a.method === 'manual' ? '<div class="empty-state">Подтверждено вручную владельцем HQ — банк не задействован, YAAM деньги не пересылал.</div>' : ''}
        ${a.bank_status ? `<div class="payout-row-sub">Статус банка: ${esc(a.bank_status)}</div>` : ''}
        ${a.error_message ? `<div class="attempt-error">${esc(a.error_message)}${a.status === 'failed' ? ` · Повтор ${a.retryable ? 'допустим' : 'требует решения оператора'}` : ''}</div>` : ''}
        <details class="attempt-requisites">
          <summary>Реквизиты этой попытки</summary>
          ${renderAttemptRequisites(requisitesByAttemptId.get(a.id))}
        </details>
      </li>`).join('')
    : '<li class="empty-state">Попыток обращения к банку ещё не было.</li>';

  return `
    <h1>Выплата #${payout.id}</h1>
    <div class="panel">
      <table>
        <tr><td>Ресторан</td><td style="text-align:right"><a href="${linkBasePath}/restaurants/${payout.restaurant_id}">${esc(payout.restaurant_name)}</a></td></tr>
        <tr><td>Период</td><td style="text-align:right"><a href="${linkBasePath}/finance/settlements/${payout.settlement_period_id}">${esc(formatDateOnly(payout.period_from))} — ${esc(formatDateOnly(payout.period_to))}</a></td></tr>
        <tr><td>Сумма</td><td style="text-align:right">${money(payout.amount)}</td></tr>
        <tr><td>Статус</td><td style="text-align:right"><span class="status-badge ${statusTone(payout.status)}">${esc(STATUS_LABELS[payout.status] || payout.status)}</span></td></tr>
        <tr><td>Дата подготовки</td><td style="text-align:right">${esc(formatDateTime(payout.prepared_at || payout.created_at))}</td></tr>
        <tr><td>Дата выплаты</td><td style="text-align:right">${payout.completed_at ? esc(formatDateTime(payout.completed_at)) : '—'}</td></tr>
        ${payout.failure_reason ? `<tr><td>Причина ошибки</td><td style="text-align:right">${esc(payout.failure_reason)}</td></tr>` : ''}
        ${payout.external_payout_id ? `<tr><td>Внешний ID</td><td style="text-align:right">${esc(payout.external_payout_id)}</td></tr>` : ''}
      </table>
    </div>
    ${renderManualConfirmSection({ payout, pendingRequisitesPreview, linkBasePath, csrfToken, error })}
    ${renderReadinessSection({ readiness })}

    <div class="panel">
      <div class="panel-title">История попыток</div>
      <ul class="attempt-list">${attemptBlocks}</ul>
      <div class="empty-state" style="margin-top:10px">Реквизиты каждой попытки — неизменяемый снимок на момент отправки: последующая правка реквизитов ресторана не меняет уже созданную выплату.</div>
    </div>

    <a class="btn ghost compact" href="${linkBasePath}/payouts">← Ко всем выплатам</a>
  `;
}

module.exports = {
  renderPayoutsListPage,
  renderPayoutDetail,
};
