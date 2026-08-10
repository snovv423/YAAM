'use strict';

// YAAM HQ Stage 8 — рендеринг расчётных периодов (задание, раздел 9-10):
// секция на /hq/finance, форма создания, страница конкретного периода. Тот
// же общий стиль панелей/таблиц, что и hq/restaurantFinanceViews.js (Stage 6)
// и routes/hq/pages.js renderFinancePage (Stage 7) — не изобретён заново.
const { esc } = require('./layout');
const { READINESS_LABELS } = require('../services/hq/restaurantPayoutService');
const { STATUS_LABELS: PAYOUT_STATUS_LABELS } = require('../services/hq/payoutService');
const { toMskDate, MSK_SUFFIX } = require('./dateFormat');

const STATUS_LABELS = { draft: 'Черновик', closed: 'Закрыт' };
const { PERIOD_PAYOUT_STATUS_LABELS } = require('../services/hq/settlementService');
const moneyLib = require('../services/money');

// Stage 38 — денежные суммы из БД теперь integer minor units (копейки), не
// рубли. money() остаётся единственной точкой форматирования для owner-
// facing HTML этого файла (все существующие вызовы money(n) — без
// изменений), но теперь делегирует канонической moneyLib.formatMinorRub()
// вместо наивного "${n} ₽" — та же граница, что и everywhere else (services/
// money.js), не второе параллельное форматирование.
function money(n) {
  return moneyLib.formatMinorRub(Number(n) || 0);
}

function formatDateOnly(date) {
  if (!date) return '';
  if (typeof date === 'string') return date; // уже 'YYYY-MM-DD' (см. db/postgresql/index.js DATE-парсер)
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Stage 27 — то же закрытие дефекта часового пояса, что и в
// hq/payoutViews.js: раньше сырые getUTCHours() без сдвига, теперь — сдвиг
// на московское время и явный суффикс "МСК".
function formatDateTime(date) {
  const local = toMskDate(date);
  if (!local) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}${MSK_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Секция «Расчётные периоды» на /hq/finance (задание, раздел 9).
// ---------------------------------------------------------------------------
// docs/HQ-PRODUCT-SPEC.md, раздел «Статусы расчётного периода»: компактные
// карточки вместо технической таблицы, пользовательский статус выплат вместо
// одного слова «Закрыт». Кнопки ручного создания периода нет — периоды
// закрываются автоматически (services/hq/weeklySettlementService.js).
function periodStatusBadge(p) {
  if (p.status !== 'closed') {
    return '<span class="status-badge muted">Идёт неделя</span>';
  }
  const tone = p.payoutStatus === 'paid' ? 'ok' : (p.payoutStatus === 'partially_paid' ? 'warn' : 'muted');
  const label = PERIOD_PAYOUT_STATUS_LABELS[p.payoutStatus] || 'Ожидает выплат';
  return `<span class="status-badge ${tone}">${esc(label)}</span>`;
}

function pluralRestaurants(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ресторан';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'ресторана';
  return 'ресторанов';
}

function renderSettlementPeriodsSection({ periods, linkBasePath }) {
  const rows = periods.length
    ? periods.map((p) => `
      <li class="payout-row">
        <div class="payout-row-main">
          <div class="payout-row-name">${esc(formatDateOnly(p.periodFrom))} — ${esc(formatDateOnly(p.periodTo))}</div>
          <div class="payout-row-meta">
            ${periodStatusBadge(p)}
            <span class="payout-row-sub">${p.restaurantCount} ${esc(pluralRestaurants(p.restaurantCount))}</span>
          </div>
          <div class="payout-row-sub">Оборот ${money(p.turnover)} · Доход YAAM ${money(p.commission)} · Ресторанам ${money(p.restaurantEarnings)}${p.refundsAmount ? ` · Возвраты ${money(p.refundsAmount)}` : ''}${p.adjustmentAmount ? ` · Удержано ${money(p.adjustmentAmount)}` : ''}</div>
        </div>
        <div class="payout-row-actions">
          <a class="btn ghost compact" href="${linkBasePath}/finance/settlements/${p.id}">Открыть</a>
        </div>
      </li>`).join('')
    : '<li class="empty-state">Расчётных периодов пока нет. Первый период закроется автоматически в понедельник в 07:00.</li>';

  return `
    <div class="panel">
      <div class="panel-title">Расчётные периоды</div>
      <ul class="payout-list">${rows}</ul>
      <div class="empty-state" style="margin-top:10px">Периоды закрываются автоматически каждый понедельник в 07:00 по московскому времени — сразу после завершения недели.</div>
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
// docs/HQ-PRODUCT-SPEC.md, раздел «Детальная страница периода»: по каждому
// ресторану — человекочитаемые данные без внутренних кодов и технических
// статусов, плюс компактный блок документов. Кнопки ручного закрытия и
// удаления периода удалены: закрытие автоматическое.
function payoutCellLabel(l) {
  if (!l.payout_id) return { label: 'Не подготовлена', tone: 'muted', date: null, reason: null };
  if (l.payout_status === 'succeeded') {
    return { label: 'Выплачено', tone: 'ok', date: l.payout_completed_at, reason: null };
  }
  if (l.payout_status === 'blocked') {
    return { label: 'Ошибка выплаты', tone: 'danger', date: null, reason: l.payout_failure_reason };
  }
  if (l.payout_status === 'prepared') return { label: 'Подготовлено', tone: 'muted', date: null, reason: null };
  return { label: 'В обработке', tone: 'muted', date: null, reason: null };
}

// Stage 25 — панель одноразового показа СВЕЖЕВЫПУЩЕННЫХ ссылок (закрытие
// Stage 24 HIGH-2). Рендерится ТОЛЬКО в теле того самого POST-ответа, что
// выпустил токены (routes/hq/settlements.js: renderPeriodDetail вызывается
// напрямую, без redirect) — обновление страницы эту панель больше никогда не
// покажет, потому что freshLinksByRestaurant не переживает сам HTTP-ответ.
function renderFreshLinksPanel(restaurantId, restaurantName, links) {
  const rows = links.map((l) => `
    <li class="payout-row">
      <div class="payout-row-main">
        <div class="payout-row-name">${esc(l.text)}</div>
        <div class="payout-row-sub"><code style="word-break:break-all">${esc(l.url)}</code></div>
      </div>
    </li>`).join('');
  return `
    <div class="panel">
      <div class="panel-title">Ссылки для ${esc(restaurantName || `ресторана #${restaurantId}`)} — показаны один раз</div>
      <div class="empty-state" style="margin-bottom:10px">
        Скопируйте и передайте эти ссылки ресторану сейчас. Страница их больше не покажет —
        при необходимости выпустите новые. Сама ссылка — это ключ доступа: передавайте её
        так же аккуратно, как пароль, и только тому ресторану, которому она предназначена.
      </div>
      <ul class="payout-list">${rows}</ul>
    </div>`;
}

function renderDocumentsBlock({
  documents, period, linkBasePath, csrfToken = '', canIssueDocumentLinks = false,
  freshLinksByRestaurant = null,
}) {
  if (period.status !== 'closed') return '';
  const byRestaurant = new Map();
  for (const d of documents) {
    if (!byRestaurant.has(d.restaurant_id)) byRestaurant.set(d.restaurant_id, {});
    byRestaurant.get(d.restaurant_id)[d.kind] = d;
  }

  const freshPanels = freshLinksByRestaurant
    ? [...freshLinksByRestaurant.entries()].map(([restaurantId, links]) => {
        const docs = byRestaurant.get(restaurantId) || {};
        return renderFreshLinksPanel(restaurantId, restaurantNameFromDocs(docs), links);
      }).join('')
    : '';

  const rows = [...byRestaurant.entries()].map(([restaurantId, docs]) => {
    const cell = (kind, label) => {
      const doc = docs[kind];
      if (!doc || doc.status !== 'generated') {
        return `<span class="status-badge danger">${esc(label)}: ошибка</span>`;
      }
      const base = `${linkBasePath}/finance/settlements/${period.id}/documents/${doc.id}`;
      return `<span class="doc-cell"><span class="status-badge ok">${esc(label)}</span>
        <a class="btn ghost compact" href="${base}">Открыть</a>
        <a class="btn ghost compact" href="${base}?download=1">Скачать</a></span>`;
    };
    // Кнопка выдачи ссылок доступна только когда есть хотя бы один реально
    // сформированный документ — иначе POST сходил бы впустую и владелец
    // получил бы только сообщение об ошибке вместо результата.
    const hasGeneratedDoc = Object.values(docs).some((d) => d && d.status === 'generated');
    const issueForm = canIssueDocumentLinks && hasGeneratedDoc
      ? `
        <form method="post" action="${linkBasePath}/finance/settlements/${period.id}/documents/${restaurantId}/issue-links"
              onsubmit="return confirm('Выпустить новые защищённые ссылки на документы для этого ресторана? Ссылки будут показаны один раз.')">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <button type="submit" class="ghost compact">Создать ссылки для ресторана</button>
        </form>`
      : '';
    return `
      <li class="payout-row">
        <div class="payout-row-main">
          <div class="payout-row-name">${esc(restaurantNameFromDocs(docs) || `Ресторан #${restaurantId}`)}</div>
          <div class="doc-actions">${cell('agent_report', 'Отчёт агента')}${cell('order_registry', 'Реестр заказов')}</div>
        </div>
        ${issueForm}
      </li>`;
  }).join('');

  return `
    ${freshPanels}
    <div class="panel">
      <div class="panel-title">Документы</div>
      <ul class="payout-list">${rows || '<li class="empty-state">Документы ещё не сформированы.</li>'}</ul>
    </div>`;
}

// Имя ресторана берётся из snapshot внутри payload документа — не из текущей
// таблицы restaurants: документ обязан показывать состояние на момент
// закрытия периода.
function restaurantNameFromDocs(docs) {
  const doc = docs.agent_report || docs.order_registry;
  if (!doc) return null;
  const payload = typeof doc.payload === 'string' ? JSON.parse(doc.payload) : doc.payload;
  return payload && payload.principal
    ? (payload.principal.legalName || payload.principal.displayName)
    : null;
}

function renderSettlementPeriodDetail({
  period, lines, preview, totals, csrfToken, linkBasePath, error, documents = [],
  canIssueDocumentLinks = false, freshLinksByRestaurant = null,
}) {
  const rows = lines.length
    ? lines.map((l) => {
        const payout = payoutCellLabel(l);
        return `
        <li class="payout-row">
          <div class="payout-row-main">
            <div class="payout-row-name"><a href="${linkBasePath}/restaurants/${l.restaurant_id}">${esc(l.restaurant_name)}</a></div>
            <div class="payout-row-meta">
              <span class="status-badge ${payout.tone}">${esc(payout.label)}</span>
              ${payout.date ? `<span class="payout-row-sub">${esc(formatDateTime(payout.date))}</span>` : ''}
            </div>
            <div class="payout-row-sub">${l.delivered_paid_orders} зак. · Продажи ${money(l.turnover)}${l.successful_refunds_amount ? ` · Возвраты ${money(l.successful_refunds_amount)}` : ''}</div>
            <!-- База комиссии = turnover, БЕЗ вычитания возвратов: полностью
                 возвращённый заказ вообще не попадает в turnover (см.
                 EARNED_ORDER_FILTER_SQL), поэтому вычитание было бы двойным
                 учётом и расходилось бы с yaam_commission и с отчётом агента.
                 Подробное обоснование — settlementDocumentService.js. -->
            <div class="payout-row-sub">База ${money(l.turnover)} · Комиссия YAAM ${money(l.yaam_commission)} · Ресторану ${money(l.payable_amount)}</div>
            ${l.refund_adjustment_restaurant_amount
              ? `<div class="payout-row-sub">Удержано за возвраты прошлых периодов ${money(l.refund_adjustment_restaurant_amount)}</div>`
              : ''}
            ${l.carry_forward_applied
              ? `<div class="payout-row-sub">Удержано в счёт долга прошлых периодов ${money(l.carry_forward_applied)}</div>`
              : ''}
            ${l.carry_forward_remaining
              ? `<div class="payout-row-sub">Остаток долга ${money(l.carry_forward_remaining)} — переносится на следующий период</div>`
              : ''}
            ${payout.reason ? `<div class="payout-row-sub">${esc(payout.reason)}</div>` : ''}
          </div>
        </li>`;
      }).join('')
    : '<li class="empty-state">Активности в этом периоде нет.</li>';

  return `
    <h1>Период ${esc(formatDateOnly(period.period_from))} — ${esc(formatDateOnly(period.period_to))}</h1>
    ${error ? `<div class="error" style="margin-bottom:14px">${esc(error)}</div>` : ''}
    ${preview
      ? '<div class="empty-state" style="margin-bottom:14px">Неделя ещё идёт — предварительный расчёт, суммы могут измениться.</div>'
      : `<div class="empty-state" style="margin-bottom:14px">Период закрыт ${esc(formatDateTime(period.closed_at))}, суммы зафиксированы.</div>`}

    <div class="metric-grid compact">
      <div class="metric"><div class="value">${totals.orders}</div><div class="label">Заказы</div></div>
      <div class="metric"><div class="value">${money(totals.turnover)}</div><div class="label">Оборот</div></div>
      <div class="metric"><div class="value">${money(totals.commission)}</div><div class="label">Доход YAAM</div></div>
      <div class="metric"><div class="value">${money(totals.payable)}</div><div class="label">К выплате</div></div>
      ${totals.refundsCount ? `<div class="metric"><div class="value">${money(totals.refundsAmount)}</div><div class="label">Возвраты · ${totals.refundsCount} шт</div></div>` : ''}
    </div>

    <div class="panel">
      <div class="panel-title">Рестораны</div>
      <ul class="payout-list">${rows}</ul>
    </div>

    ${renderDocumentsBlock({
      documents, period, linkBasePath, csrfToken, canIssueDocumentLinks, freshLinksByRestaurant,
    })}
    <a class="btn ghost compact" href="${linkBasePath}/finance">← К финансам</a>
  `;
}

module.exports = {
  STATUS_LABELS,
  renderSettlementPeriodsSection,
  renderSettlementPeriodDetail,
};
