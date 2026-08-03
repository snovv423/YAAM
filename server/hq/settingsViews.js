'use strict';

// YAAM HQ Stage 14 — экран «Настройки».
//
// Четыре блока, ровно в этом порядке: аккаунт владельца, данные YAAM,
// банковские реквизиты, платежи и касса.
//
// HQ существует ТОЛЬКО для владельца YAAM. Поэтому здесь нет смены логина
// (менять его не у кого и незачем), нет регистрации, восстановления по email
// и управления несколькими владельцами. Логин показан как факт, а не как поле.
//
// Секретные значения не выводятся: счета маскируются, ключи платёжного
// провайдера не показываются вовсе — ни целиком, ни частично, ни в виде поля
// ввода. Ключи задаются только в защищённом окружении сервера.
const { esc } = require('./layout');
const { maskAccountForUi } = require('../services/hq/ruRequisites');

function row(label, value) {
  return `<tr><td>${esc(label)}</td><td style="text-align:right">${esc(value)}</td></tr>`;
}

function statusBadge(tone, text) {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

// --- 1. Аккаунт владельца ---------------------------------------------------
//
// Блока «Статус сессии: Активна» здесь намеренно нет: он не сообщал ничего,
// кроме того, что страница открылась, и не давал никакого действия.
function renderAccountSection({ hqUser, linkBasePath }) {
  return `
    <section class="panel">
      <div class="panel-title">Аккаунт владельца</div>
      <table>
        ${row('Логин', hqUser || '—')}
      </table>
      <div class="hint">Логин изменить нельзя. Доступ к HQ есть только у владельца YAAM.</div>
      <button type="button" class="btn ghost" data-open-sheet="change-password" style="margin-top:14px">Изменить пароль</button>
    </section>`;
}

// Компактный sheet смены пароля. Форма обычная POST — она обязана работать и
// без JavaScript; скрипт лишь показывает/прячет её и защищает от повторной
// отправки.
function renderPasswordSheet({ linkBasePath, csrfToken, minPasswordLength, error }) {
  const action = `${linkBasePath}/settings/change-password`;
  return `
    <div class="sheet-backdrop${error ? ' open' : ''}" id="sheet-change-password" data-sheet="change-password">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-change-password-title">
        <div class="sheet-head">
          <div class="panel-title" id="sheet-change-password-title">Изменить пароль</div>
          <button type="button" class="sheet-close" data-close-sheet aria-label="Закрыть">×</button>
        </div>
        <form method="post" action="${esc(action)}" data-single-submit>
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <label for="cp-current">Текущий пароль</label>
          <div class="pw-field">
            <input id="cp-current" name="currentPassword" type="password" autocomplete="current-password" required>
            <button type="button" class="pw-toggle" data-toggle-password="cp-current" aria-label="Показать пароль">Показать</button>
          </div>
          <label for="cp-new">Новый пароль</label>
          <div class="pw-field">
            <input id="cp-new" name="newPassword" type="password" autocomplete="new-password" required minlength="${minPasswordLength}">
            <button type="button" class="pw-toggle" data-toggle-password="cp-new" aria-label="Показать пароль">Показать</button>
          </div>
          <label for="cp-confirm">Повторите новый пароль</label>
          <div class="pw-field">
            <input id="cp-confirm" name="confirmPassword" type="password" autocomplete="new-password" required minlength="${minPasswordLength}">
            <button type="button" class="pw-toggle" data-toggle-password="cp-confirm" aria-label="Показать пароль">Показать</button>
          </div>
          <div class="hint">Не короче ${minPasswordLength} символов.</div>
          ${error ? `<div class="error">${esc(error)}</div>` : ''}
          <button type="submit" style="margin-top:14px">Сохранить</button>
        </form>
      </div>
    </div>`;
}

// --- 2. Данные YAAM ---------------------------------------------------------
function renderYaamLegalSection({ legal, linkBasePath }) {
  const editUrl = `${linkBasePath}/settings/yaam-legal/edit`;
  if (!legal) {
    return `
      <section class="panel">
        <div class="panel-title">Данные YAAM</div>
        <div class="empty-state" style="margin-bottom:14px">Не заполнены. Без них отчёт агента печатается без сведений об агенте.</div>
        <a class="btn ghost" href="${esc(editUrl)}">Заполнить</a>
      </section>`;
  }
  const registrationDate = legal.registration_date
    ? new Date(legal.registration_date).toISOString().slice(0, 10).split('-').reverse().join('.')
    : '';
  return `
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Данные YAAM</div>
        ${statusBadge('open', 'Заполнены')}
      </div>
      <table>
        ${row('Наименование', legal.legal_name)}
        ${row('Предприниматель', legal.entrepreneur_name)}
        ${row('ИНН', legal.inn)}
        ${row('ОГРНИП', legal.ogrnip)}
        ${row('Адрес регистрации', legal.registration_address)}
        ${legal.contact_email ? row('Рабочий email', legal.contact_email) : ''}
        ${legal.contact_phone ? row('Рабочий телефон', legal.contact_phone) : ''}
        ${registrationDate ? row('Дата регистрации', registrationDate) : ''}
      </table>
      <a class="btn ghost" style="margin-top:14px;display:inline-block" href="${esc(editUrl)}">Редактировать</a>
    </section>`;
}

function renderYaamLegalEditForm({ legal, linkBasePath, csrfToken, error }) {
  const v = legal || {};
  const action = `${linkBasePath}/settings/yaam-legal`;
  const backUrl = `${linkBasePath}/settings`;
  const regDate = v.registration_date
    ? new Date(v.registration_date).toISOString().slice(0, 10) : '';
  return `
    <h1>Данные YAAM</h1>
    <section class="panel">
      <form method="post" action="${esc(action)}" data-single-submit>
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="yl-legal-name">Наименование ИП</label>
        <input id="yl-legal-name" name="legalName" type="text" value="${esc(v.legal_name || '')}" required autocomplete="off" placeholder="ИП Иванов Иван Иванович">
        <label for="yl-entrepreneur">ФИО предпринимателя</label>
        <input id="yl-entrepreneur" name="entrepreneurName" type="text" value="${esc(v.entrepreneur_name || '')}" required autocomplete="off">
        <label for="yl-inn">ИНН (12 цифр)</label>
        <input id="yl-inn" name="inn" type="text" value="${esc(v.inn || '')}" inputmode="numeric" required autocomplete="off">
        <label for="yl-ogrnip">ОГРНИП (15 цифр)</label>
        <input id="yl-ogrnip" name="ogrnip" type="text" value="${esc(v.ogrnip || '')}" inputmode="numeric" required autocomplete="off">
        <label for="yl-address">Адрес регистрации</label>
        <input id="yl-address" name="registrationAddress" type="text" value="${esc(v.registration_address || '')}" required autocomplete="off">
        <label for="yl-email">Рабочий email</label>
        <input id="yl-email" name="contactEmail" type="email" value="${esc(v.contact_email || '')}" autocomplete="off">
        <label for="yl-phone">Рабочий телефон</label>
        <input id="yl-phone" name="contactPhone" type="tel" value="${esc(v.contact_phone || '')}" autocomplete="off">
        <label for="yl-reg-date">Дата регистрации</label>
        <input id="yl-reg-date" name="registrationDate" type="date" value="${esc(regDate)}">
        <div class="hint">Email, телефон и дата регистрации необязательны: их обязательность в документах пока не подтверждена юридически.</div>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
        <button type="submit" style="margin-top:14px">Сохранить</button>
      </form>
    </section>
    <a class="btn ghost" href="${esc(backUrl)}">← К настройкам</a>
  `;
}

// --- 3. Банковские реквизиты ------------------------------------------------
function renderYaamBankSection({ details, linkBasePath }) {
  const editUrl = `${linkBasePath}/settings/yaam-bank-details/edit`;
  if (!details) {
    return `
      <section class="panel">
        <div class="panel-title">Банковские реквизиты</div>
        <div class="empty-state" style="margin-bottom:14px">Не заполнены. Без них выплату ресторану подготовить нельзя.</div>
        <a class="btn ghost" href="${esc(editUrl)}">Заполнить</a>
      </section>`;
  }
  return `
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Банковские реквизиты</div>
        ${statusBadge('open', 'Заполнены')}
      </div>
      <table>
        ${row('Получатель', details.legal_name)}
        ${row('ИНН получателя', details.inn)}
        ${details.kpp ? row('КПП', details.kpp) : ''}
        ${row('Банк', details.bank_name)}
        ${row('БИК', details.bik)}
        ${row('Расчётный счёт', maskAccountForUi(details.account_number))}
        ${row('Корр. счёт', maskAccountForUi(details.correspondent_account))}
      </table>
      <div class="hint">Счета показаны частично. Полные значения — только на форме редактирования.</div>
      <a class="btn ghost" style="margin-top:14px;display:inline-block" href="${esc(editUrl)}">Редактировать</a>
    </section>`;
}

// --- 4. Платежи и касса -----------------------------------------------------
//
// Честные статусы, без обещаний. Ключи не показываются: ни целиком, ни
// частично, и поля для их ввода здесь нет — вставленный в HTML-форму
// production-secret прошёл бы через браузер, логи прокси и историю, поэтому
// такой формы не существует по замыслу.
function renderPaymentsSection({ payments, receipts }) {
  const providerLabel = {
    mock: 'Тестовый режим (mock)',
    yookassa: 'YooKassa',
  }[payments.provider] || 'Не настроен';

  const modeTone = payments.mode === 'live' ? 'closed' : 'muted';
  const modeText = {
    sandbox: 'Песочница',
    live: 'Боевой режим',
    mock: 'Без провайдера',
  }[payments.mode] || 'Не настроен';

  const receiptsLine = receipts.total === 0
    ? 'Чеки не формировались'
    : `Готовы ${receipts.succeeded} · В очереди ${receipts.queued} · Ошибки ${receipts.failed}`;

  return `
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Платежи и касса</div>
        ${statusBadge(modeTone, modeText)}
      </div>
      <table>
        ${row('Провайдер', providerLabel)}
        ${row('Приём оплат', payments.provider === 'mock' ? 'Тестовый' : 'Песочница YooKassa')}
        ${row('Боевой режим', 'Не подключён')}
        ${row('Webhook', payments.webhookConfigured ? 'Настроен' : 'Не настроен')}
        ${row('Возвраты', payments.refundsSupported ? 'Полный возврат' : 'Недоступны')}
        ${row('Частичный возврат', 'Не поддерживается')}
        ${row('Онлайн-касса', 'Не подключена')}
        ${row('Фискальные чеки', receiptsLine)}
      </table>
      <div class="hint">
        Ключи платёжного провайдера задаются только в защищённом окружении сервера
        и в HQ не отображаются и не вводятся.
      </div>
      ${payments.blockers.length ? `
      <div class="empty-state" style="margin-top:14px">
        <div style="font-weight:600;margin-bottom:6px">Что мешает боевому режиму</div>
        <ul style="margin:0;padding-left:18px">
          ${payments.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}
        </ul>
      </div>` : ''}
    </section>`;
}

// --- Экран целиком ----------------------------------------------------------
function renderSettings({
  hqUser, linkBasePath, csrfToken, minPasswordLength,
  yaamLegal, yaamBankDetails, payments, receipts,
  passwordError = null, notice = null,
}) {
  return `
    <h1>Настройки</h1>
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    ${renderAccountSection({ hqUser, linkBasePath })}
    ${renderYaamLegalSection({ legal: yaamLegal, linkBasePath })}
    ${renderYaamBankSection({ details: yaamBankDetails, linkBasePath })}
    ${renderPaymentsSection({ payments, receipts })}
    ${renderPasswordSheet({ linkBasePath, csrfToken, minPasswordLength, error: passwordError })}
  `;
}

module.exports = {
  renderSettings,
  renderAccountSection,
  renderPasswordSheet,
  renderYaamLegalSection,
  renderYaamLegalEditForm,
  renderYaamBankSection,
  renderPaymentsSection,
};
