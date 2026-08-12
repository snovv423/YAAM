'use strict';

// Защищённые HQ-страницы: Обзор (реальные метрики), безопасные заглушки
// Рестораны/Финансы (задание Stage 2, раздел 7), и Настройки → Безопасность
// (задание Stage 3, раздел 3) — единственное место, где владелец может
// сменить логин/пароль, хранящиеся в PostgreSQL (hq_owner), НЕ в .env.
const express = require('express');
const db = require('../../db/postgresql');
const { layout, esc } = require('../../hq/layout');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { hashPassword, verifyPassword } = require('../../services/hq/passwordHash');
const { SESSION_COOKIE_NAME } = require('../../services/hq/session');
const { hqRootPath } = require('../../services/hq/basePath');
const ownerService = require('../../services/hq/ownerService');
const { logSecurityEvent } = require('../../services/hq/securityLog');
const rateLimit = require('express-rate-limit');
const yaamLegalDetailsService = require('../../services/hq/yaamLegalDetailsService');
const fiscalReceiptService = require('../../services/fiscalization/fiscalReceiptService');
const settingsViews = require('../../hq/settingsViews');
const dashboardMetrics = require('../../services/hq/dashboardMetrics');
const eventLogService = require('../../services/hq/eventLogService');
const payoutStatusService = require('../../services/hq/payoutStatusService');
// Сущность выплаты — ОТДЕЛЬНЫЙ сервис от payoutService выше (тот про
// готовность реквизитов); имя намеренно другое, тем же приёмом, что и в
// routes/hq/restaurants.js.
const payoutRecordService = require('../../services/hq/payoutService');
const payoutService = require('../../services/hq/restaurantPayoutService');
const financeService = require('../../services/hq/restaurantFinanceService');
const settlementService = require('../../services/hq/settlementService');
const settlementViews = require('../../hq/settlementViews');
const { CONTRACT_STATUS_LABELS } = require('../../services/hq/restaurantContractService');
const { ValidationError } = require('../../services/hq/restaurantAdminService');
// Stage 9.6 — реквизиты YAAM как плательщика (T-Bank T-API from.*), HQ-only
// (задание, раздел 3: "отсутствует в public API и Telegram").
const yaamBankDetailsService = require('../../services/hq/yaamBankDetailsService');
const { logAuditEvent, summarizeYaamBankDetailsDiff } = require('../../services/hq/auditLog');
const { maskAccountForUi } = require('../../services/hq/ruRequisites');
// Stage 38 — turnover/commission/restaurantEarnings/successfulRefunds/
// payout.amount ниже все теперь integer minor units; formatMinorRub()
// единственное место, форматирующее их владельцу.
const { formatMinorRub } = require('../../services/money');

const STATUS_LABELS = {
  awaiting_payment: 'Ожидают оплаты',
  awaiting_restaurant: 'Ожидают ресторан',
  accepted: 'Приняты',
  preparing: 'Готовятся',
  courier: 'В доставке',
};

// Минимальная, явно обоснованная защита от тривиально слабого пароля —
// задание не просит полноценный strength-meter, но полное отсутствие
// какой-либо нижней границы было бы более заметным пробелом, чем эта
// одна проверка длины.
const MIN_PASSWORD_LENGTH = 8;

// docs/HQ-PRODUCT-SPEC.md — HQ «Обзор» переработан как кабинет владельца:
// 4 показателя бизнеса за выбранный период + терминальный «Центр событий»
// (только реальные проблемы). Рестораны/Финансы/Выплаты/Настройки не
// затронуты этой правкой — их SSR-страницы ниже в этом же файле не менялись.
const OVERVIEW_PERIODS = [
  ['today', 'Сегодня'],
  ['week', 'Неделя'],
  ['month', 'Месяц'],
];

function renderPeriodSwitch(period, linkBasePath) {
  return `<div class="period-switch" role="tablist" aria-label="Период">${OVERVIEW_PERIODS.map(([key, label]) => {
    const isOn = key === period;
    return `<a href="${linkBasePath}/?period=${key}" role="tab" aria-selected="${isOn}" class="${isOn ? 'on' : ''}">${esc(label)}</a>`;
  }).join('')}</div>`;
}

function renderOverviewMetrics(metrics) {
  return `
    <div class="metric-grid compact">
      <div class="metric"><div class="value">${metrics.ordersCount}</div><div class="label">Заказы</div></div>
      <div class="metric"><div class="value">${formatMinorRub(metrics.turnover)}</div><div class="label">Оборот</div></div>
      <div class="metric"><div class="value">${formatMinorRub(metrics.commission)}</div><div class="label">Доход YAAM</div></div>
      <div class="metric"><div class="value">${metrics.restaurantsCount}</div><div class="label">Рестораны</div></div>
    </div>`;
}

// Единственный ряд ленты — переиспользуется полной страницей «Обзор»,
// страницей «История» и JSON-фрагментом живого обновления (routes ниже),
// чтобы разметка одного события не могла разойтись между тремя местами.
function renderEventRow(event, now) {
  const timeLabel = eventLogService.formatEventTimestamp(event.occurredAt, now);
  const restaurantLine = event.restaurantName
    ? `<div class="event-restaurant">${esc(event.restaurantName)}</div>` : '';
  return `<div class="event-row" data-event-id="${event.id}">
    <div class="event-time">${esc(timeLabel)}</div>
    ${restaurantLine}
    <div class="event-message">${esc(event.message)}</div>
  </div>`;
}

// «Центр событий» (задание, раздел 3-4) — терминальная лента, тёмно-серый
// фон (НЕ --panel — тот зелёный, тон панелей всего остального HQ; здесь
// намеренно другой, нейтральный «терминальный» цвет, см. layout.js). Пустое
// состояние — короткая спокойная фраза, без декоративных нулей (задание,
// раздел 7).
function renderEventCenter({ events, now, linkBasePath, csrfToken }) {
  const rows = events.length
    ? events.map((e) => renderEventRow(e, now)).join('')
    : `<div class="event-empty">Проблем нет.</div>`;
  const lastId = events.length ? events[events.length - 1].id : 0;
  return `
    <div class="event-center" id="hq-event-center" data-endpoint="${linkBasePath}/events/feed" data-last-id="${lastId}">
      <div class="event-center-head">
        <span>Центр событий</span>
        <button type="button" class="event-expand-btn" aria-expanded="false">Раскрыть</button>
      </div>
      <div class="event-center-scroll">${rows}</div>
      <div class="event-center-footer">
        <a href="${linkBasePath}/events/history">История</a>
        <form method="post" action="${linkBasePath}/events/clear" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <button type="submit" class="event-clear-btn">Очистить</button>
        </form>
      </div>
    </div>`;
}

function renderOverview({ period, metrics, events, now, csrfToken, linkBasePath }) {
  return `
    <h1>Обзор</h1>
    ${renderPeriodSwitch(period, linkBasePath)}
    ${renderOverviewMetrics(metrics)}
    ${renderEventCenter({ events, now, linkBasePath, csrfToken })}
  `;
}

// «История» (задание, раздел 6) — полный архив, курсор очистки не
// применяется. Тот же терминальный стиль/renderEventRow, что и основная
// лента — простая постраничная навигация (тот же PAGE_SIZE-паттерн, что и
// остальной HQ), не бесконечный скролл.
function renderEventHistory({ archive, now, linkBasePath }) {
  const rows = archive.events.length
    ? archive.events.map((e) => renderEventRow(e, now)).join('')
    : `<div class="event-empty">История пуста.</div>`;
  const pager = archive.totalPages > 1 ? `
    <div class="pagination">
      ${archive.page > 1 ? `<a href="${linkBasePath}/events/history?page=${archive.page - 1}">← Раньше</a>` : ''}
      <span class="current">${archive.page} / ${archive.totalPages}</span>
      ${archive.page < archive.totalPages ? `<a href="${linkBasePath}/events/history?page=${archive.page + 1}">Позже →</a>` : ''}
    </div>` : '';
  return `
    <h1>История событий</h1>
    <a class="btn ghost" style="margin-bottom:16px;display:inline-block" href="${linkBasePath}/">← К обзору</a>
    <div class="event-center event-center-full">
      <div class="event-center-scroll">${rows}</div>
    </div>
    ${pager}
  `;
}

// YAAM HQ Stage 7 — «Финансы» стала реально рабочим read-only экраном
// (задание, раздел 7), заменив Stage 6-заглушку без реальных сумм.
// Период — тот же селектор today/7d/30d/custom, что уже используется на
// вкладке «Статистика» ресторана (services/hq/restaurantStatsService.js:
// resolvePeriodRange) — переиспользован, не продублирован. payableBalance —
// ВСЕГДА за всё время (не зависит от выбранного периода отчёта — это
// остаток задолженности, а не поток за период, см. services/hq/
// restaurantFinanceService.js за полным обоснованием) — подписано явно.
// docs/HQ-PRODUCT-SPEC.md, раздел «Финансы»: единственный главный денежный
// раздел HQ. Владелец за несколько секунд видит: сколько прошло денег,
// сколько заработал YAAM, сколько принадлежит ресторанам, какие выплаты
// готовы, какие периоды закрыты.
//
// Что убрано по спецификации: таблица ресторанов с оборотом/комиссией/
// заказами (дублировала «Обзор» и карточку ресторана), длинные служебные
// пояснения, «Остаток к будущим выплатам» (та же сумма другими словами).
const FINANCE_PERIODS = [
  ['today', 'Сегодня'],
  ['7d', 'Неделя'],
  ['30d', 'Месяц'],
  ['custom', 'Свой период'],
];

function renderPeriodTabs(period, baseUrl) {
  return `<div class="period-switch">${FINANCE_PERIODS.map(([key, label]) => {
    const isOn = key === period;
    return `<a href="${baseUrl}?period=${key}" class="${isOn ? 'on' : ''}">${esc(label)}</a>`;
  }).join('')}</div>`;
}

// Календарь: значения дат применяются ТОЛЬКО после явной отправки формы
// (кнопка «Применить»). Ни одного onchange="submit()" — открыть и закрыть
// системный date-picker без подтверждения безопасно, выбранная дата не
// применяется сама (спецификация, раздел 2).
function renderCustomPeriodForm({ periodOptions, baseUrl }) {
  return `
    <form class="date-filter panel" method="get" action="${baseUrl}">
      <input type="hidden" name="period" value="custom">
      <div class="field"><label for="ff-from">С даты</label><input id="ff-from" type="date" name="from" value="${esc(periodOptions.from || '')}"></div>
      <div class="field"><label for="ff-to">По дату</label><input id="ff-to" type="date" name="to" value="${esc(periodOptions.to || '')}"></div>
      <button type="submit" class="compact">Применить</button>
    </form>`;
}

// Сводка (спецификация, раздел 3): только нужные показатели, без технических
// пояснений. Возвраты — строка появляется, только если они были.
function renderFinanceSummary(overall) {
  const cards = [
    [`${overall.deliveredPaidOrders}`, 'Выполненные заказы'],
    [formatMinorRub(overall.turnover), 'Оборот'],
    [formatMinorRub(overall.commission), 'Доход YAAM'],
    [formatMinorRub(overall.restaurantEarnings), 'Сумма ресторанов'],
  ];
  if (overall.successfulRefundsCount > 0) {
    cards.push([formatMinorRub(overall.successfulRefunds), `Возвраты · ${overall.successfulRefundsCount} шт`]);
  }
  return `<div class="metric-grid compact">${cards.map(([value, label]) => `
    <div class="metric"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`).join('')}</div>`;
}

// «Статус выплат» (спецификация, раздел 4) — главный рабочий экран владельца.
// Только название, сумма, статус и кнопка подробностей; аналитика намеренно
// не дублируется. Кнопка «Подготовить выплату» рендерится ТОЛЬКО когда backend сказал
// canPay — сам факт её отсутствия не является защитой, backend проверяет
// повторно (services/hq/payoutStatusService.js: payRestaurant).
function renderPayoutStatusSection({ statuses, csrfToken, linkBasePath }) {
  const readyCount = statuses.filter((s) => s.canPay).length;
  const rows = statuses.length
    ? statuses.map((s) => {
        const detailHref = s.payoutId
          ? `${linkBasePath}/payouts/${s.payoutId}`
          : `${linkBasePath}/restaurants/${s.restaurantId}`;
        const payButton = s.canPay
          ? `<form method="post" action="${linkBasePath}/finance/payouts/${s.restaurantId}/pay" onsubmit="return confirm('${esc(`Подготовить выплату «${s.name}» на ${formatMinorRub(s.amount)}?`)}')" style="margin:0">
               <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
               <button type="submit" class="compact">Подготовить выплату</button>
             </form>`
          : '';
        return `
          <li class="payout-row">
            <div class="payout-row-main">
              <div class="payout-row-name">${esc(s.name)}</div>
              <div class="payout-row-meta">
                <span class="status-badge ${s.statusTone}">${esc(s.statusLabel)}</span>
                ${s.amount > 0 ? `<span class="payout-row-amount">${formatMinorRub(s.amount)}</span>` : ''}
              </div>
            </div>
            <div class="payout-row-actions">
              ${payButton}
              <a class="btn ghost compact" href="${detailHref}">Открыть</a>
            </div>
          </li>`;
      }).join('')
    : '<li class="empty-state">Ресторанов пока нет.</li>';

  const payAllForm = readyCount > 0
    ? `<form method="post" action="${linkBasePath}/finance/payouts/pay-all" onsubmit="return confirm('${esc(`Подготовить выплаты всем готовым ресторанам (${readyCount})?`)}')" style="margin:0">
         <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
         <button type="submit" class="compact">Подготовить все</button>
       </form>`
    : '';

  return `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title" style="margin:0">Статус выплат</div>
        <div class="panel-head-actions">
          ${payAllForm}
          <a class="btn ghost compact" href="${linkBasePath}/payouts">Все выплаты</a>
        </div>
      </div>
      <ul class="payout-list">${rows}</ul>
    </div>`;
}

function renderFinancePage({
  overall, periodOptions, linkBasePath, error, notice, settlementPeriods, payoutStatuses, csrfToken,
}) {
  const baseUrl = `${linkBasePath}/finance`;
  const period = periodOptions.period || 'today';

  return `
    <h1>Финансы</h1>
    ${renderPeriodTabs(period, baseUrl)}
    ${period === 'custom' ? renderCustomPeriodForm({ periodOptions, baseUrl }) : ''}
    ${error ? `<div class="error" style="margin-bottom:14px">${esc(error)}</div>` : ''}
    ${notice ? `<div class="notice" style="margin-bottom:14px">${esc(notice)}</div>` : ''}

    ${renderFinanceSummary(overall)}
    ${renderPayoutStatusSection({ statuses: payoutStatuses, csrfToken, linkBasePath })}
    ${settlementViews.renderSettlementPeriodsSection({ periods: settlementPeriods, linkBasePath })}
  `;
}

// Stage 5B.2 (задание, раздел 11) — компактная read-only строка о занятом
// медиа-хранилищем месте, только если данные получены надёжно (statfs +
// обход каталога прошли без ошибки) — иначе панель просто не рендерится,
// без сообщения об ошибке (задание: "без лишнего шума", "не строить
// отдельный dashboard").
function formatBytesMb(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} МБ`;
}
function formatBytesGb(bytes) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
}

// Stage 9.6 — «Реквизиты YAAM для выплат» (задание, раздел 10): показывает
// заполнено/не заполнено, маскированный счёт, ИНН, КПП, банк, кнопку
// редактирования. Полные значения — только на форме редактирования
// (задание, раздел 3: "read-only overview показывает маскированные
// значения; полные значения доступны только на edit form").
function renderYaamBankDetailsSection({ details, linkBasePath }) {
  const editUrl = `${linkBasePath}/settings/yaam-bank-details/edit`;
  if (!details) {
    return `
      <div class="panel">
        <div style="font-weight:700;margin-bottom:10px">Реквизиты YAAM для выплат</div>
        <div class="empty-state" style="margin-bottom:14px">Не заполнено. Без них ни одна попытка выплаты через Т-Банк не может быть создана.</div>
        <a class="btn ghost" href="${editUrl}">Заполнить</a>
      </div>`;
  }
  return `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700">Реквизиты YAAM для выплат</div>
        <span class="badge open">Заполнено</span>
      </div>
      <table>
        <tr><td>Юридическое название</td><td style="text-align:right">${esc(details.legal_name)}</td></tr>
        <tr><td>ИНН</td><td style="text-align:right">${esc(details.inn)}</td></tr>
        <tr><td>КПП</td><td style="text-align:right">${esc(details.kpp)}</td></tr>
        <tr><td>Банк</td><td style="text-align:right">${esc(details.bank_name)}</td></tr>
        <tr><td>БИК</td><td style="text-align:right">${esc(details.bik)}</td></tr>
        <tr><td>Расчётный счёт</td><td style="text-align:right">${esc(maskAccountForUi(details.account_number))}</td></tr>
        <tr><td>Корр. счёт</td><td style="text-align:right">${esc(maskAccountForUi(details.correspondent_account))}</td></tr>
      </table>
      <a class="btn ghost" style="margin-top:14px;display:inline-block" href="${editUrl}">Редактировать</a>
    </div>`;
}

function renderYaamBankDetailsEditForm({ details, linkBasePath, csrfToken, error }) {
  const v = details || {};
  const action = `${linkBasePath}/settings/yaam-bank-details`;
  const backUrl = `${linkBasePath}/settings`;
  return `
    <h1>Реквизиты YAAM для выплат</h1>
    <div class="panel">
      <form method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="ybd-legal-name">Юридическое название YAAM</label>
        <input id="ybd-legal-name" name="legal_name" type="text" value="${esc(v.legal_name)}" required autocomplete="off">
        <label for="ybd-inn">ИНН</label>
        <input id="ybd-inn" name="inn" type="text" value="${esc(v.inn)}" inputmode="numeric" required autocomplete="off">
        <label for="ybd-kpp">КПП</label>
        <input id="ybd-kpp" name="kpp" type="text" value="${esc(v.kpp)}" inputmode="numeric" required autocomplete="off">
        <label for="ybd-bik">БИК банка</label>
        <input id="ybd-bik" name="bik" type="text" value="${esc(v.bik)}" inputmode="numeric" required autocomplete="off">
        <label for="ybd-bank-name">Название банка</label>
        <input id="ybd-bank-name" name="bank_name" type="text" value="${esc(v.bank_name)}" required autocomplete="off">
        <label for="ybd-account">Расчётный счёт (20 цифр)</label>
        <input id="ybd-account" name="account_number" type="text" value="${esc(v.account_number)}" inputmode="numeric" required autocomplete="off">
        <label for="ybd-correspondent">Корреспондентский счёт (20 цифр)</label>
        <input id="ybd-correspondent" name="correspondent_account" type="text" value="${esc(v.correspondent_account)}" inputmode="numeric" required autocomplete="off">
        <button type="submit">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
    </div>
    <a class="btn ghost" href="${backUrl}">← К настройкам</a>
  `;
}

function createPagesRouter({ linkBasePath, mediaProvider = null }) {
  const router = express.Router();
  const rootPath = hqRootPath(linkBasePath);
  const loginPath = `${linkBasePath}/login`;
  const settingsPath = `${linkBasePath}/settings`;
  const cookiePath = rootPath;

  router.get('/', async (req, res, next) => {
    try {
      const period = OVERVIEW_PERIODS.some(([key]) => key === req.query.period) ? req.query.period : 'today';
      const now = new Date();
      const [metrics, events] = await Promise.all([
        dashboardMetrics.getOverviewMetrics({ period, now }),
        eventLogService.listActiveEvents(),
      ]);
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Обзор',
        active: 'overview',
        csrfToken,
        linkBasePath,
        body: renderOverview({ period, metrics, events, now, csrfToken, linkBasePath }),
      }));
    } catch (err) {
      next(err);
    }
  });

  // «Центр событий» — живое дополнение уже открытой ленты (задание, раздел
  // 7: новое событие не должно резко перебрасывать читающего вниз — клиент
  // сам решает, добавлять ли автоскролл, см. hq/static/hq.js) — тот же
  // JSON-poll паттерн, что уже используется для «Обзора» ресторана
  // (hq-live-overview), но здесь возвращается уже отрендеренный HTML КАЖДОГО
  // нового события (renderEventRow) — не сырой JSON для клиентского
  // шаблонизатора, которого в этом проекте нет и не должно появиться ради
  // одного списка (задание CLAUDE.md: "статический HTML/CSS/JS без
  // сборщиков").
  router.get('/events/feed', async (req, res, next) => {
    try {
      const afterId = Number.parseInt(req.query.afterId, 10);
      if (!Number.isInteger(afterId) || afterId < 0) {
        return res.status(400).json({ error: 'afterId обязателен и должен быть целым числом' });
      }
      const now = new Date();
      const events = await eventLogService.listActiveEventsAfter(afterId);
      res.json({
        items: events.map((e) => ({ id: e.id, html: renderEventRow(e, now) })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events/history', async (req, res, next) => {
    try {
      const page = Number.parseInt(req.query.page, 10) || 1;
      const now = new Date();
      const archive = await eventLogService.listArchive({ page });
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'История событий',
        active: 'overview',
        csrfToken,
        linkBasePath,
        body: renderEventHistory({ archive, now, linkBasePath }),
      }));
    } catch (err) {
      next(err);
    }
  });

  // «Очистить» (задание, раздел 6) — двигает курсор, ничего не удаляет (см.
  // eventLogService.clearActiveFeed). Обычный form POST + redirect, тем же
  // стилем, что и остальные мутации HQ (settings/change-password и т.д.) —
  // не AJAX, страница просто перезагружается с уже пустой основной лентой.
  router.post('/events/clear', requireCsrf, async (req, res, next) => {
    try {
      await eventLogService.clearActiveFeed();
      res.redirect(`${linkBasePath}/`);
    } catch (err) {
      next(err);
    }
  });

  // Stage 4: заглушка "Рестораны" заменена полноценным разделом —
  // server/routes/hq/restaurants.js, смонтирован ОТДЕЛЬНО в routes/hq/
  // index.js под /restaurants (раньше /hq/restaurants).

  router.get('/finance', async (req, res, next) => {
    const periodOptions = { period: req.query.period, from: req.query.from, to: req.query.to };
    try {
      let positions;
      let periodError = null;
      // «Свой период» БЕЗ выбранных дат — это не ошибка ввода, а первый шаг:
      // владелец только что открыл вкладку и ещё ничего не подтвердил. Форма
      // дат показывается, а цифры под ней — за «сегодня», без красной ошибки
      // (спецификация, раздел 2: дата применяется только после явного
      // подтверждения).
      const customWithoutDates = periodOptions.period === 'custom'
        && (!periodOptions.from || !periodOptions.to);
      try {
        positions = customWithoutDates
          ? await financeService.listRestaurantsFinancialPositions({ period: 'today' })
          : await financeService.listRestaurantsFinancialPositions(periodOptions);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        periodError = err.message;
        periodOptions.period = 'today';
        positions = await financeService.listRestaurantsFinancialPositions({ period: 'today' });
      }
      const overall = financeService.summarizeOverall(positions);
      const [settlementPeriods, payoutStatuses] = await Promise.all([
        settlementService.listSettlementPeriods(),
        payoutStatusService.listPayoutStatuses(),
      ]);
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Финансы',
        active: 'finance',
        csrfToken,
        linkBasePath,
        body: renderFinancePage({
          overall, periodOptions, linkBasePath,
          error: periodError || req.query.error, notice: req.query.notice,
          settlementPeriods, payoutStatuses, csrfToken,
        }),
      }));
    } catch (err) {
      next(err);
    }
  });

  // Выплата одному ресторану (спецификация, раздел 10). ВСЕ проверки готовности
  // выполняет backend (payoutStatusService.payRestaurant) — отсутствие кнопки
  // в UI не является защитой.
  router.post('/finance/payouts/:restaurantId/pay', requireCsrf, async (req, res, next) => {
    const base = `${linkBasePath}/finance`;
    try {
      const restaurantId = Number.parseInt(req.params.restaurantId, 10);
      if (!Number.isInteger(restaurantId)) {
        return res.redirect(`${base}?error=${encodeURIComponent('Некорректный ресторан.')}`);
      }
      const payout = await payoutStatusService.payRestaurant(restaurantId, { ip: req.ip });
      res.redirect(`${base}?notice=${encodeURIComponent(`Выплата подготовлена: ${formatMinorRub(payout.amount)}. Переведите деньги вручную в банковском клиенте, затем отметьте выплату выполненной.`)}`);
    } catch (err) {
      if (err instanceof payoutRecordService.ValidationError) {
        return res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  // Массовая выплата (спецификация, раздел 11): не готовые пропускаются,
  // ошибка одного ресторана не отменяет остальных, операция идемпотентна
  // (UNIQUE(settlement_period_id, restaurant_id) на уровне схемы).
  router.post('/finance/payouts/pay-all', requireCsrf, async (req, res, next) => {
    const base = `${linkBasePath}/finance`;
    try {
      const result = await payoutStatusService.payAllReady({ ip: req.ip });
      const parts = [`Подготовлено: ${result.paid.length}`];
      if (result.skipped > 0) parts.push(`пропущено: ${result.skipped}`);
      if (result.failed.length > 0) parts.push(`с ошибкой: ${result.failed.length}`);
      const message = `${parts.join(', ')}.`;
      const key = result.failed.length > 0 ? 'error' : 'notice';
      res.redirect(`${base}?${key}=${encodeURIComponent(message)}`);
    } catch (err) {
      next(err);
    }
  });

  // Сводка платежей и кассы. Честные статусы, без обещаний: боевой режим
  // намеренно недоступен (см. services/postgresql/app.js — YOOKASSA_ENV
  // обязан быть sandbox), онлайн-касса не подключена.
  //
  // Секретов здесь нет и быть не может: ни ключа, ни его части, ни поля для
  // ввода. Ключи задаются только в защищённом окружении сервера.
  function buildPaymentsSummary() {
    const provider = process.env.PAYMENT_PROVIDER === 'yookassa' ? 'yookassa' : 'mock';
    const mode = provider === 'yookassa'
      ? (process.env.YOOKASSA_ENV === 'sandbox' ? 'sandbox' : 'live')
      : 'mock';

    const blockers = [];
    if (provider !== 'yookassa') {
      blockers.push('Провайдер оплаты работает в тестовом режиме');
    }
    blockers.push('Боевые ключи YooKassa не подключены — код принимает только песочницу');
    blockers.push('Онлайн-касса не подключена, фискальные чеки не отправляются');
    blockers.push('Частичный возврат не поддерживается');

    return {
      provider,
      mode,
      webhookConfigured: true,
      refundsSupported: true,
      blockers,
    };
  }

  router.get('/settings', async (req, res, next) => {
    try {
      const csrfToken = ensureCsrfToken(req);
      const [yaamBankDetails, yaamLegal, receiptSummary] = await Promise.all([
        yaamBankDetailsService.getYaamBankDetails(),
        // Юр.данные и сводка чеков — best-effort: раздел настроек не должен
        // падать целиком из-за одной недоступной таблицы на legacy-БД.
        safeCall(() => yaamLegalDetailsService.getYaamLegalDetails(), null),
        safeCall(() => fiscalReceiptService.getReceiptSummary(),
          { queued: 0, processing: 0, succeeded: 0, failed: 0 }),
      ]);
      const receipts = {
        ...receiptSummary,
        total: receiptSummary.queued + receiptSummary.processing
          + receiptSummary.succeeded + receiptSummary.failed,
      };

      const notice = req.query.changed === 'password' ? 'Пароль изменён.' : null;

      res.send(layout({
        title: 'Настройки',
        active: 'settings',
        csrfToken,
        linkBasePath,
        body: settingsViews.renderSettings({
          hqUser: req.session.hqUser || '',
          linkBasePath,
          csrfToken,
          minPasswordLength: MIN_PASSWORD_LENGTH,
          yaamLegal,
          yaamBankDetails,
          payments: buildPaymentsSummary(),
          receipts,
          notice,
        }),
      }));
    } catch (err) {
      next(err);
    }
  });

  async function safeCall(fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      console.error('[hq/settings] раздел недоступен:', err.message);
      return fallback;
    }
  }

  // --- Данные YAAM ---------------------------------------------------------
  router.get('/settings/yaam-legal/edit', async (req, res, next) => {
    try {
      const legal = await yaamLegalDetailsService.getYaamLegalDetails();
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Данные YAAM', active: 'settings', csrfToken, linkBasePath,
        body: settingsViews.renderYaamLegalEditForm({ legal, linkBasePath, csrfToken }),
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/settings/yaam-legal', requireCsrf, async (req, res, next) => {
    try {
      // Явный whitelist полей: req.body целиком в сервис не передаётся, иначе
      // лишний ключ из формы мог бы попасть в запрос (mass assignment).
      await yaamLegalDetailsService.saveYaamLegalDetails({
        legalName: req.body.legalName,
        entrepreneurName: req.body.entrepreneurName,
        inn: req.body.inn,
        ogrnip: req.body.ogrnip,
        registrationAddress: req.body.registrationAddress,
        contactEmail: req.body.contactEmail,
        contactPhone: req.body.contactPhone,
        registrationDate: req.body.registrationDate,
      }, { ip: req.ip });
      res.redirect(`${linkBasePath}/settings`);
    } catch (err) {
      const csrfToken = ensureCsrfToken(req);
      // Форма перерисовывается с ВВЕДЁННЫМИ значениями, чтобы не заставлять
      // заполнять всё заново из-за одной опечатки.
      return res.status(400).send(layout({
        title: 'Данные YAAM', active: 'settings', csrfToken, linkBasePath,
        body: settingsViews.renderYaamLegalEditForm({
          legal: {
            legal_name: req.body.legalName, entrepreneur_name: req.body.entrepreneurName,
            inn: req.body.inn, ogrnip: req.body.ogrnip,
            registration_address: req.body.registrationAddress,
            contact_email: req.body.contactEmail, contact_phone: req.body.contactPhone,
            registration_date: req.body.registrationDate,
          },
          linkBasePath, csrfToken, error: err.message,
        }),
      }));
    }
  });

  router.get('/settings/yaam-bank-details/edit', async (req, res, next) => {
    try {
      const details = await yaamBankDetailsService.getYaamBankDetails();
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Реквизиты YAAM для выплат', active: 'settings', csrfToken, linkBasePath,
        body: renderYaamBankDetailsEditForm({ details, linkBasePath, csrfToken }),
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/settings/yaam-bank-details', requireCsrf, async (req, res, next) => {
    try {
      const { record, created, before } = await yaamBankDetailsService.saveYaamBankDetails(req.body);
      const action = created ? 'yaam_bank_details_created' : 'yaam_bank_details_updated';
      const details = created ? null : summarizeYaamBankDetailsDiff(before, record);
      await logAuditEvent({ action, restaurantId: null, details, ip: req.ip });
      res.redirect(`${linkBasePath}/settings`);
    } catch (err) {
      if (err instanceof yaamBankDetailsService.ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(400).send(layout({
          title: 'Реквизиты YAAM для выплат', active: 'settings', csrfToken, linkBasePath,
          body: renderYaamBankDetailsEditForm({ details: req.body, linkBasePath, csrfToken, error: err.message }),
        }));
      }
      next(err);
    }
  });

  // ПОВЕДЕНИЕ СЕССИИ ПОСЛЕ СМЕНЫ ПАРОЛЯ — определено явно.
  //
  // Раньше смена завершала ВСЕ сессии, включая текущую, и владельца
  // выбрасывало на форму входа. Это безопасно, но противоречит компактному
  // sheet'у: закрыть форму и показать подтверждение невозможно, если
  // страница тут же превращается в логин.
  //
  // Теперь: credentials_version увеличивается (все ОСТАЛЬНЫЕ сессии, включая
  // вторую вкладку и чужое устройство, признают себя недействительными на
  // ближайшем же запросе — см. routes/hq/middleware.js), а ТЕКУЩАЯ сессия
  // получает новую версию и продолжает работать. Это стандартное поведение
  // «сменил пароль — разлогинило везде, кроме здесь», и оно строго не слабее
  // прежнего: злоумышленник со старой сессией теряет доступ в обоих вариантах.
  function adoptNewCredentialsVersion(req, newVersion) {
    req.session.hqCredentialsVersion = newVersion;
  }

  // Отдельный лимит на смену пароля: это операция с проверкой текущего
  // пароля, то есть точка, где перебор имеет смысл. Общий login-лимитер сюда
  // не применяется — маршрут другой.
  const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number.isInteger(Number(process.env.HQ_PASSWORD_RATE_LIMIT_MAX))
      && Number(process.env.HQ_PASSWORD_RATE_LIMIT_MAX) > 0
      ? Number(process.env.HQ_PASSWORD_RATE_LIMIT_MAX)
      : 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      // Ни пароля, ни его длины в логе — только факт и IP.
      console.warn(`[hq] password-change rate-limit ip=${req.ip} time=${new Date().toISOString()}`);
      logSecurityEvent({ eventType: 'login_rate_limited', ip: req.ip });
      res.status(429).send('Слишком много попыток смены пароля — попробуйте позже.');
    },
  });

  // Перерисовка настроек с открытым sheet'ом и текстом ошибки.
  async function renderSettingsWithPasswordError(req, res, status, message) {
    const csrfToken = ensureCsrfToken(req);
    const [yaamBankDetails, yaamLegal, receiptSummary] = await Promise.all([
      safeCall(() => yaamBankDetailsService.getYaamBankDetails(), null),
      safeCall(() => yaamLegalDetailsService.getYaamLegalDetails(), null),
      safeCall(() => fiscalReceiptService.getReceiptSummary(),
        { queued: 0, processing: 0, succeeded: 0, failed: 0 }),
    ]);
    const receipts = {
      ...receiptSummary,
      total: receiptSummary.queued + receiptSummary.processing
        + receiptSummary.succeeded + receiptSummary.failed,
    };
    return res.status(status).send(layout({
      title: 'Настройки', active: 'settings', csrfToken, linkBasePath,
      body: settingsViews.renderSettings({
        hqUser: req.session.hqUser || '',
        linkBasePath, csrfToken, minPasswordLength: MIN_PASSWORD_LENGTH,
        yaamLegal, yaamBankDetails,
        payments: buildPaymentsSummary(), receipts,
        passwordError: message,
      }),
    }));
  }

  // Смена логина УДАЛЕНА (Stage 14): HQ существует только для владельца
  // YAAM, менять логин не у кого и незачем. Маршрут не скрыт, а удалён —
  // тест проверяет, что POST на него отдаёт 404.
  router.post('/settings/change-password', changePasswordLimiter, requireCsrf, async (req, res, next) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    try {
      const owner = await ownerService.getOwner();
      const currentPasswordOk = owner && await verifyPassword(currentPassword, owner.password_hash);

      // Аудит-события НИКОГДА не содержат пароль, его длину или фрагмент.
      if (!owner || !currentPasswordOk) {
        await logAuditEvent({
          action: 'owner_password_change_rejected', restaurantId: null,
          details: 'неверный текущий пароль', ip: req.ip,
        });
        return renderSettingsWithPasswordError(req, res, 401, 'Неверный текущий пароль.');
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return renderSettingsWithPasswordError(
          req, res, 400, `Новый пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`,
        );
      }
      if (newPassword !== confirmPassword) {
        return renderSettingsWithPasswordError(req, res, 400, 'Пароли не совпадают.');
      }
      // Смысла менять пароль на тот же самый нет, а владелец решит, что
      // операция прошла, и успокоится.
      if (newPassword === currentPassword) {
        return renderSettingsWithPasswordError(req, res, 400, 'Новый пароль совпадает с текущим.');
      }

      const newPasswordHash = await hashPassword(newPassword);
      const newVersion = await ownerService.changeOwnerPassword(newPasswordHash);
      adoptNewCredentialsVersion(req, newVersion);

      await logSecurityEvent({ eventType: 'password_change', ip: req.ip });
      await logAuditEvent({
        action: 'owner_password_changed', restaurantId: null,
        details: 'пароль владельца изменён; остальные сессии завершены', ip: req.ip,
      });

      // PRG: перезагрузка страницы не отправит форму повторно.
      return res.redirect(`${linkBasePath}/settings?changed=password`);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createPagesRouter, STATUS_LABELS, MIN_PASSWORD_LENGTH };
