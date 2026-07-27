'use strict';

// YAAM HQ Stage 6 — юридические данные, банковские реквизиты и договор
// (задание, раздел 2): три компактные секции-карточки внутри вкладки
// «Настройки» + отдельная форма редактирования на каждую (тот же паттерн,
// что уже используется для категорий меню — hq/menuViews.js:
// renderCategoryEditForm — отдельная страница, не инлайн-переключение).
//
// Read-only обзор МАСКИРУЕТ счета (задание, раздел 7); полные значения
// видны только на форме редактирования, куда владелец YAAM попадает
// осознанным кликом «Редактировать».
const { esc } = require('./layout');
const { LEGAL_FORMS } = require('../services/hq/restaurantLegalDetailsService');
const { CONTRACT_STATUSES, CONTRACT_STATUS_LABELS, formatCommissionBpsAsPercent } = require('../services/hq/restaurantContractService');
const { maskAccountForUi } = require('../services/hq/ruRequisites');
const { READINESS_LABELS } = require('../services/hq/restaurantPayoutService');

// Дословно та же логика, что и formatDateOnly() в hq/restaurantsViews.js —
// небольшая функция, отдельная копия ради отсутствия циклического require
// между этими двумя view-модулями (тот же принцип "дословная копия" уже
// применяется в этой кодовой базе, например normalizeRuPhone между SQLite/
// PostgreSQL-версиями orderService.js).
function formatDateOnly(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const LEGAL_FORM_LABELS = { ip: 'ИП', ooo: 'ООО' };

// ---------------------------------------------------------------------------
// Готовность к выплатам — компактная строка в шапке ресторана (задание,
// раздел 11: "можно показать компактно... с краткой причиной").
// ---------------------------------------------------------------------------

function renderPayoutReadinessInline(readiness) {
  const label = READINESS_LABELS[readiness] || readiness;
  return `Готовность к выплатам: ${esc(label)}`;
}

// ---------------------------------------------------------------------------
// Юридические данные — read-only карточка
// ---------------------------------------------------------------------------

function renderLegalDetailsSection({ restaurant, legal, linkBasePath }) {
  const editUrl = `${linkBasePath}/restaurants/${restaurant.id}/legal-details/edit`;
  if (!legal) {
    return `
      <div class="panel">
        <div style="font-weight:700;margin-bottom:10px">Юридические данные</div>
        <div class="empty-state" style="margin-bottom:14px">Не заполнено.</div>
        <a class="btn ghost" href="${editUrl}">Заполнить</a>
      </div>`;
  }
  const formLabel = LEGAL_FORM_LABELS[legal.legal_form] || legal.legal_form;
  const ogrnLabel = legal.legal_form === 'ip' ? 'ОГРНИП' : 'ОГРН';
  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700">Юридические данные</div>
        <span class="badge open">Заполнено</span>
      </div>
      <table>
        <tr><td>Правовая форма</td><td style="text-align:right">${esc(formLabel)}</td></tr>
        <tr><td>Юридическое название</td><td style="text-align:right">${esc(legal.legal_name)}</td></tr>
        <tr><td>ИНН</td><td style="text-align:right">${esc(legal.inn)}</td></tr>
        <tr><td>${esc(ogrnLabel)}</td><td style="text-align:right">${esc(legal.ogrn)}</td></tr>
        <tr><td>Руководитель / ИП</td><td style="text-align:right">${esc(legal.director_name)}</td></tr>
      </table>
      <a class="btn ghost" style="margin-top:14px;display:inline-block" href="${editUrl}">Редактировать</a>
    </div>`;
}

function renderLegalDetailsEditForm({ restaurant, legal, linkBasePath, csrfToken, error }) {
  const v = legal || {};
  const action = `${linkBasePath}/restaurants/${restaurant.id}/legal-details`;
  const backUrl = `${linkBasePath}/restaurants/${restaurant.id}/settings`;
  return `
    <h2>Юридические данные — ${esc(restaurant.name)}</h2>
    <div class="panel">
      <form method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="ld-form">Правовая форма</label>
        <select id="ld-form" name="legal_form" required autocomplete="off">
          <option value="ip" ${v.legal_form === 'ip' ? 'selected' : ''}>ИП</option>
          <option value="ooo" ${v.legal_form === 'ooo' ? 'selected' : ''}>ООО</option>
        </select>
        <label for="ld-name">Полное юридическое название</label>
        <input id="ld-name" name="legal_name" type="text" value="${esc(v.legal_name)}" required autocomplete="off">
        <label for="ld-short-name">Краткое юридическое название</label>
        <input id="ld-short-name" name="short_legal_name" type="text" value="${esc(v.short_legal_name)}" autocomplete="off">
        <label for="ld-inn">ИНН</label>
        <input id="ld-inn" name="inn" type="text" value="${esc(v.inn)}" inputmode="numeric" required autocomplete="off">
        <label for="ld-ogrn">ОГРН (ООО) / ОГРНИП (ИП)</label>
        <input id="ld-ogrn" name="ogrn" type="text" value="${esc(v.ogrn)}" inputmode="numeric" required autocomplete="off">
        <label for="ld-kpp">КПП (только для ООО)</label>
        <input id="ld-kpp" name="kpp" type="text" value="${esc(v.kpp)}" inputmode="numeric" autocomplete="off">
        <label for="ld-legal-address">Юридический адрес</label>
        <input id="ld-legal-address" name="legal_address" type="text" value="${esc(v.legal_address)}" required autocomplete="off">
        <label for="ld-actual-address">Фактический адрес</label>
        <input id="ld-actual-address" name="actual_address" type="text" value="${esc(v.actual_address)}" autocomplete="off">
        <label for="ld-director">ФИО руководителя / ИП</label>
        <input id="ld-director" name="director_name" type="text" value="${esc(v.director_name)}" required autocomplete="off">
        <label for="ld-authority">Основание полномочий</label>
        <input id="ld-authority" name="authority_basis" type="text" value="${esc(v.authority_basis)}" autocomplete="off" placeholder="Устав / доверенность №...">
        <label for="ld-phone">Контактный телефон</label>
        <input id="ld-phone" name="contact_phone" type="text" value="${esc(v.contact_phone)}" required autocomplete="off">
        <label for="ld-email">Контактный email</label>
        <input id="ld-email" name="contact_email" type="text" value="${esc(v.contact_email)}" autocomplete="off">
        <button type="submit">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost" href="${backUrl}">← К настройкам</a>
  `;
}

// ---------------------------------------------------------------------------
// Банковские реквизиты — read-only карточка (маскированные счета)
// ---------------------------------------------------------------------------

function renderBankDetailsSection({ restaurant, bank, linkBasePath }) {
  const editUrl = `${linkBasePath}/restaurants/${restaurant.id}/bank-details/edit`;
  if (!bank) {
    return `
      <div class="panel">
        <div style="font-weight:700;margin-bottom:10px">Банковские реквизиты</div>
        <div class="empty-state" style="margin-bottom:14px">Не заполнено.</div>
        <a class="btn ghost" href="${editUrl}">Заполнить</a>
      </div>`;
  }
  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700">Банковские реквизиты</div>
        <span class="badge open">Заполнено</span>
      </div>
      <table>
        <tr><td>Получатель</td><td style="text-align:right">${esc(bank.recipient_name)}</td></tr>
        <tr><td>Банк</td><td style="text-align:right">${esc(bank.bank_name)}</td></tr>
        <tr><td>БИК</td><td style="text-align:right">${esc(bank.bik)}</td></tr>
        <tr><td>Расчётный счёт</td><td style="text-align:right">${esc(maskAccountForUi(bank.account_number))}</td></tr>
        <tr><td>Корр. счёт</td><td style="text-align:right">${esc(maskAccountForUi(bank.correspondent_account))}</td></tr>
      </table>
      <a class="btn ghost" style="margin-top:14px;display:inline-block" href="${editUrl}">Редактировать</a>
    </div>`;
}

function renderBankDetailsEditForm({ restaurant, bank, linkBasePath, csrfToken, error }) {
  const v = bank || {};
  const action = `${linkBasePath}/restaurants/${restaurant.id}/bank-details`;
  const backUrl = `${linkBasePath}/restaurants/${restaurant.id}/settings`;
  return `
    <h2>Банковские реквизиты — ${esc(restaurant.name)}</h2>
    <div class="panel">
      <form method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="bd-recipient">Наименование получателя</label>
        <input id="bd-recipient" name="recipient_name" type="text" value="${esc(v.recipient_name)}" required autocomplete="off">
        <label for="bd-recipient-inn">ИНН получателя</label>
        <input id="bd-recipient-inn" name="recipient_inn" type="text" value="${esc(v.recipient_inn)}" inputmode="numeric" required autocomplete="off">
        <label for="bd-recipient-kpp">КПП получателя (при наличии)</label>
        <input id="bd-recipient-kpp" name="recipient_kpp" type="text" value="${esc(v.recipient_kpp)}" inputmode="numeric" autocomplete="off">
        <label for="bd-bik">БИК банка</label>
        <input id="bd-bik" name="bik" type="text" value="${esc(v.bik)}" inputmode="numeric" required autocomplete="off">
        <label for="bd-bank-name">Название банка</label>
        <input id="bd-bank-name" name="bank_name" type="text" value="${esc(v.bank_name)}" required autocomplete="off">
        <label for="bd-account">Расчётный счёт (20 цифр)</label>
        <input id="bd-account" name="account_number" type="text" value="${esc(v.account_number)}" inputmode="numeric" required autocomplete="off">
        <label for="bd-correspondent">Корреспондентский счёт (20 цифр)</label>
        <input id="bd-correspondent" name="correspondent_account" type="text" value="${esc(v.correspondent_account)}" inputmode="numeric" required autocomplete="off">
        <label for="bd-purpose">Назначение платежа по умолчанию</label>
        <input id="bd-purpose" name="default_payment_purpose" type="text" value="${esc(v.default_payment_purpose)}" autocomplete="off">
        <label for="bd-note">Комментарий владельца YAAM (внутренний, не покидает HQ)</label>
        <textarea id="bd-note" name="internal_note" autocomplete="off">${esc(v.internal_note)}</textarea>
        <button type="submit">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost" href="${backUrl}">← К настройкам</a>
  `;
}

// ---------------------------------------------------------------------------
// Договор с YAAM
// ---------------------------------------------------------------------------

function contractStatusBadgeClass(status) {
  if (status === 'signed') return 'open';
  if (status === 'suspended') return 'paused';
  return 'closed'; // not_signed, prepared, terminated
}

function renderContractSection({ restaurant, contract, linkBasePath }) {
  const editUrl = `${linkBasePath}/restaurants/${restaurant.id}/contract/edit`;
  if (!contract) {
    return `
      <div class="panel">
        <div style="font-weight:700;margin-bottom:10px">Договор с YAAM</div>
        <div class="empty-state" style="margin-bottom:14px">Не оформлен.</div>
        <a class="btn ghost" href="${editUrl}">Оформить</a>
      </div>`;
  }
  const statusLabel = CONTRACT_STATUS_LABELS[contract.status] || contract.status;
  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700">Договор с YAAM</div>
        <span class="badge ${contractStatusBadgeClass(contract.status)}">${esc(statusLabel)}</span>
      </div>
      <table>
        <tr><td>Номер договора</td><td style="text-align:right">${contract.contract_number ? esc(contract.contract_number) : '—'}</td></tr>
        <tr><td>Дата заключения</td><td style="text-align:right">${contract.signed_at ? esc(formatDateOnly(contract.signed_at)) : '—'}</td></tr>
        <tr><td>Комиссия YAAM</td><td style="text-align:right">${esc(formatCommissionBpsAsPercent(contract.commission_bps))}%</td></tr>
      </table>
      <a class="btn ghost" style="margin-top:14px;display:inline-block" href="${editUrl}">Редактировать</a>
    </div>`;
}

function renderContractEditForm({ restaurant, contract, linkBasePath, csrfToken, error }) {
  const v = contract || {};
  const action = `${linkBasePath}/restaurants/${restaurant.id}/contract`;
  const backUrl = `${linkBasePath}/restaurants/${restaurant.id}/settings`;
  // v — либо запись из БД (есть commission_bps, нет commission_percent),
  // либо req.body после отклонённой попытки сохранения (есть
  // commission_percent — ровно то, что ввёл владелец, показываем как есть,
  // не переформатируя из несуществующего commission_bps — задание, раздел
  // 9: "введённые данные сохраняются после ошибки").
  const commissionPercent = v.commission_percent !== undefined
    ? v.commission_percent
    : (v.commission_bps !== undefined ? formatCommissionBpsAsPercent(v.commission_bps) : '7');
  const statusOptions = CONTRACT_STATUSES.map((s) => `<option value="${s}" ${v.status === s ? 'selected' : ''}>${esc(CONTRACT_STATUS_LABELS[s])}</option>`).join('');
  return `
    <h2>Договор с YAAM — ${esc(restaurant.name)}</h2>
    <div class="panel">
      <form method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="ct-number">Номер договора</label>
        <input id="ct-number" name="contract_number" type="text" value="${esc(v.contract_number)}" autocomplete="off">
        <label for="ct-status">Статус</label>
        <select id="ct-status" name="status" required autocomplete="off">${statusOptions}</select>
        <label for="ct-signed">Дата заключения</label>
        <input id="ct-signed" name="signed_at" type="date" value="${v.signed_at ? esc(formatDateOnly(v.signed_at)) : ''}" autocomplete="off">
        <label for="ct-starts">Дата начала действия</label>
        <input id="ct-starts" name="starts_at" type="date" value="${v.starts_at ? esc(formatDateOnly(v.starts_at)) : ''}" autocomplete="off">
        <label for="ct-ends">Дата окончания</label>
        <input id="ct-ends" name="ends_at" type="date" value="${v.ends_at ? esc(formatDateOnly(v.ends_at)) : ''}" autocomplete="off">
        <label for="ct-commission">Комиссия YAAM, %</label>
        <input id="ct-commission" name="commission_percent" type="text" value="${esc(commissionPercent)}" inputmode="decimal" required autocomplete="off">
        <label for="ct-note">Примечание владельца YAAM</label>
        <textarea id="ct-note" name="internal_note" autocomplete="off">${esc(v.internal_note)}</textarea>
        <button type="submit">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost" href="${backUrl}">← К настройкам</a>
  `;
}

module.exports = {
  renderPayoutReadinessInline,
  renderLegalDetailsSection,
  renderLegalDetailsEditForm,
  renderBankDetailsSection,
  renderBankDetailsEditForm,
  renderContractSection,
  renderContractEditForm,
};
