'use strict';

// YAAM HQ Stage 4 — server-rendered HTML для раздела «Рестораны». Тот же
// принцип, что и весь остальной HQ (server/hq/layout.js, routes/hq/*):
// шаблонные функции без движка/фреймворка, esc() на каждое значение из БД.
const { esc } = require('./layout');
const lifecycle = require('../services/hq/restaurantLifecycle');
const { renderPhotoManager } = require('./photosViews');
const financeViews = require('./restaurantFinanceViews');
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('../services/hq/dashboardMetrics');
const { READINESS_LABELS: PAYOUT_READINESS_LABELS } = require('../services/hq/restaurantPayoutService');
const { SUPPORTED_CITIES } = require('../services/hq/restaurantAdminService');

const ORDER_STATUS_LABELS = {
  awaiting_payment: 'Ожидает оплаты',
  awaiting_restaurant: 'Ожидает ресторан',
  accepted: 'Принят',
  preparing: 'Готовится',
  courier: 'В доставке',
  delivered: 'Доставлен',
  payment_failed: 'Оплата не прошла',
  declined: 'Отклонён рестораном',
  timed_out: 'Истёк по времени',
  cancelled: 'Отменён',
};

const PAYMENT_STATUS_LABELS = {
  creating: 'Создаётся', pending: 'Ожидает', succeeded: 'Оплачен', failed: 'Ошибка оплаты', refunded: 'Возвращён',
};

const REFUND_STATUS_LABELS = {
  requested: 'Запрошен', processing: 'В обработке', succeeded: 'Выполнен', failed: 'Не выполнен',
};

// Единая компактная метка статуса (docs/HQ-PRODUCT-SPEC.md). Источник
// истины — resolveLifecycleStatus (services/hq/restaurantLifecycle.js), не
// повторный inline-расчёт здесь. Названия приведены к продуктовым терминам
// спецификации (раздел «Управление рестораном»): скрытый черновик = «Скрыт»,
// ручное закрытие владельцем = «Приостановлен»; «Перерыв до HH:MM» —
// отдельное состояние, которое ресторан берёт САМ через Telegram, и его
// нельзя путать с админской приостановкой.
function statusBadge(r) {
  const status = lifecycle.resolveLifecycleStatus(r);
  if (status === 'draft') return '<span class="badge paused">Скрыт</span>';
  if (status === 'archived') return '<span class="badge closed">В архиве</span>';
  if (status === 'open') return '<span class="badge open">Открыт</span>';
  if (status === 'paused') {
    const until = r.paused_until instanceof Date ? r.paused_until : new Date(r.paused_until);
    const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
    const local = new Date(until.getTime() + offsetMs);
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    return `<span class="badge paused">Перерыв до ${hh}:${mm}</span>`;
  }
  return '<span class="badge closed">Приостановлен</span>';
}

function formatDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatDateOnly(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function money(n) {
  return `${Number(n) || 0} ₽`;
}

function stars(rating) {
  return `★ ${rating}`;
}

function parseCities(citiesJson) {
  try {
    return JSON.parse(citiesJson || '[]');
  } catch {
    return [];
  }
}

// Сохраняет search/city/status/sort при переходе между страницами
// пагинации (задание, раздел 3) — явный allowlist ключей, не "весь query
// целиком", чтобы посторонний параметр не мог случайно просочиться в href.
function buildQuery(params, overrides = {}) {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

function renderPagination({ page, totalPages, baseUrl, query }) {
  if (totalPages <= 1) return '';
  const items = [];
  const addLink = (p, label) => {
    if (p === page) items.push(`<span class="current">${esc(label)}</span>`);
    else items.push(`<a href="${baseUrl}${buildQuery(query, { page: p })}">${esc(label)}</a>`);
  };
  if (page > 1) addLink(page - 1, '←');
  addLink(1, '1');
  if (page > 3) items.push('<span>…</span>');
  for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p += 1) addLink(p, String(p));
  if (page < totalPages - 2) items.push('<span>…</span>');
  if (totalPages > 1) addLink(totalPages, String(totalPages));
  if (page < totalPages) addLink(page + 1, '→');
  return `<div class="pagination">${items.join('')}</div>`;
}

// ===========================================================================
// Список ресторанов
// ===========================================================================

// docs/HQ-PRODUCT-SPEC.md, раздел «Список ресторанов»: без поиска, фильтров,
// сортировки и пагинации (10-20 ресторанов — искать нечего), без Telegram/
// выплат/юридических данных на карточке. Только то, по чему владелец
// узнаёт ресторан: название, города, кухня, статус, рейтинг, «Открыть».
function renderRestaurantCard(r, linkBasePath) {
  const cities = parseCities(r.cities);
  const cityChips = cities.length
    ? cities.map((c) => `<span class="city-chip">${esc(c)}</span>`).join('')
    : '<span class="city-chip muted">Город не указан</span>';
  const rating = r.rating_count > 0
    ? `${stars(Number(r.rating).toFixed(1))} · ${r.rating_count}`
    : 'Оценок нет';
  return `
    <div class="rest-card">
      <div class="rest-card-main">
        <div class="rest-card-title">${esc(r.name)}</div>
        <div class="rest-card-cities">${cityChips}</div>
        <div class="rest-card-meta">${esc(r.cuisine || 'Кухня не указана')} · ${statusBadge(r)} · ${esc(rating)}</div>
      </div>
      <a class="btn ghost compact" href="${linkBasePath}/restaurants/${r.id}">Открыть</a>
    </div>`;
}

function renderRestaurantsList({ restaurants, linkBasePath }) {
  return `
    <h1>Рестораны</h1>
    <div class="add-restaurant-row">
      <a class="btn compact" href="${linkBasePath}/restaurants/new">+ Добавить ресторан</a>
    </div>
    ${restaurants.length
      ? `<div class="rest-list">${restaurants.map((r) => renderRestaurantCard(r, linkBasePath)).join('')}</div>`
      : '<div class="panel"><div class="empty-state">Ресторанов пока нет.</div></div>'}
  `;
}

// ===========================================================================
// Форма создания
// ===========================================================================

function renderCreateForm({ values, error, linkBasePath, csrfToken }) {
  const v = values || {};
  return `
    <h1>Добавить ресторан</h1>
    <div class="panel">
      <form method="post" action="${linkBasePath}/restaurants">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="rf-name">Название</label>
        <input id="rf-name" name="name" type="text" value="${esc(v.name)}" required autofocus autocomplete="off">
        <label>Города</label>
        <div class="city-checks">${SUPPORTED_CITIES.map((city, index) => {
          const selected = Array.isArray(v.cities) ? v.cities.includes(city) : false;
          return `<label class="city-check"><input type="checkbox" name="cities" value="${esc(city)}" ${selected ? 'checked' : ''} id="rf-city-${index}"><span>${esc(city)}</span></label>`;
        }).join('')}</div>
        <label for="rf-cuisine">Кухня</label>
        <input id="rf-cuisine" name="cuisine" type="text" value="${esc(v.cuisine)}" placeholder="Кавказская" autocomplete="off">
        <label for="rf-description">Краткое описание</label>
        <textarea id="rf-description" name="description" autocomplete="off">${esc(v.description)}</textarea>
        <label for="rf-address">Адрес</label>
        <input id="rf-address" name="address" type="text" value="${esc(v.address)}" placeholder="г. Грозный, ул. ..., д. ..." autocomplete="off">
        <label for="rf-phone">Телефон</label>
        <input id="rf-phone" name="phone" type="text" value="${esc(v.phone)}" placeholder="+7 928 000-00-00" autocomplete="off">
        <label for="rf-hours">Часы работы</label>
        <input id="rf-hours" name="hours" type="text" value="${esc(v.hours)}" placeholder="10:00–23:00" autocomplete="off">
        <label for="rf-min-order">Минимальная сумма заказа, ₽</label>
        <input id="rf-min-order" name="min_order" type="number" min="0" value="${esc(v.min_order ?? '0')}" autocomplete="off">
        <button type="submit" id="rf-submit">Создать</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
      </form>
      <div class="empty-state" style="margin-top:14px">Ресторан будет создан как черновик — клиентам не виден. Опубликуйте его на странице ресторана, когда данные будут готовы, затем откройте вручную для приёма заказов (управление меню появится на следующем этапе).</div>
    </div>
  `;
}

// ===========================================================================
// Шапка страницы ресторана + вкладки
// ===========================================================================

function simpleActionForm({ action, csrfToken, label, cls, confirm: confirmMsg }) {
  const onsubmit = confirmMsg ? ` onsubmit="return confirm('${esc(confirmMsg)}')"` : '';
  return `<form method="post" action="${action}"${onsubmit} style="display:inline">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <button type="submit"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button>
    </form>`;
}

// Stage 5A.1 — HQ минимализм (задание: "HQ — инструмент владельца YAAM.
// Telegram-бот — инструмент ресторана. Не смешивать эти две роли"):
// временная пауза (33 мин/3 часа/11 часов + возврат) — ИСКЛЮЧИТЕЛЬНО функция
// ресторана через Telegram (server/bot/postgresql/index.js: /pause, /open) —
// в HQ для нeё нет ни кнопок, ни форм, ни действий, только статус
// (statusBadge ниже уже показывает "Пауза до HH:MM" — это осталось
// нетронутым, меняется только то, что HQ теперь НЕ управляет паузой).
// Открыть/Закрыть (ручной, бессрочный toggle is_open, ОТДЕЛЬНЫЙ от паузы,
// Stage 4.1) сознательно ОСТАЮТСЯ в HQ — их отдельно защищает Stage 5A
// серверная проверка "нельзя открыть без доступного блюда"
// (services/hq/restaurantAdminService.js:openRestaurant), у Telegram-бота
// аналогичной проверки нет вовсе (его /open вызывает resumeRestaurant()
// безусловно) — уводить открытие/закрытие из HQ означало бы тихо потерять
// единственное место, где эта защита реально работает.
//
// Итоговый набор действий строго зависит от lifecycle-статуса: у
// черновика — только "Опубликовать"; у опубликованного — "Скрыть" (раньше
// называлось "Снять с публикации" — только переименование, поведение то же)
// плюс "Открыть" ИЛИ "Закрыть" (ровно одно актуальное, только когда
// реально открыт/закрыт, не во время паузы); у архивированного — ничего
// здесь (восстановление живёт на вкладке «Настройки», как и было).
// menuItemsCount — только для текста предупреждения при публикации ресторана
// без единого блюда (задание Stage 5A, раздел 12) — предупреждение целиком в
// client-side confirm(), тем же паттерном, что уже использует архив в этом
// же файле (никакого отдельного server-rendered экрана подтверждения).
// docs/HQ-PRODUCT-SPEC.md, раздел «Заголовок ресторана»: только название,
// города, статус и рейтинг. Telegram, готовность к выплатам, юридические и
// банковские данные — на своих внутренних экранах, не в общей шапке.
// Действия приостановить/скрыть/архивировать переехали в «Настройки» →
// «Управление рестораном» и больше не торчат над каждой вкладкой.
function renderRestaurantHeader({ restaurant: r }) {
  const cities = parseCities(r.cities);
  const rating = r.rating_count > 0 ? `${stars(Number(r.rating).toFixed(1))} (${r.rating_count})` : 'Оценок нет';
  return `
    <div class="rest-header">
      <h1>${esc(r.name)}</h1>
      <div class="rest-header-meta">${esc(cities.join(' · ') || 'Город не указан')} · ${statusBadge(r)} · ${esc(rating)}</div>
    </div>
  `;
}

// Баннер ошибок/уведомлений после lifecycle-действий (публикация/открытие/
// закрытие/пауза/возобновление) — те же CSS-классы .error/.notice, что и в
// формах настроек, отображается на самой странице ресторана после
// PRG-редиректа (задание, раздел 7: "понятный success/error state").
function renderActionBanner({ error, notice }) {
  if (error) return `<div class="error" style="margin-bottom:14px">${esc(error)}</div>`;
  if (notice) return `<div class="notice" style="margin-bottom:14px">${esc(notice)}</div>`;
  return '';
}

function renderTabs({ restaurantId, active, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${restaurantId}`;
  const tabs = [
    { key: 'overview', href: base, label: 'Обзор' },
    { key: 'menu', href: `${base}/menu`, label: 'Меню' },
    { key: 'orders', href: `${base}/orders`, label: 'Заказы' },
    { key: 'ratings', href: `${base}/ratings`, label: 'Оценки' },
    { key: 'statistics', href: `${base}/statistics`, label: 'Статистика' },
    { key: 'settings', href: `${base}/settings`, label: 'Настройки' },
  ];
  return `<div class="tabs">${tabs.map((t) => `<a href="${t.href}" class="${t.key === active ? 'on' : ''}"${t.key === active ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}</div>`;
}

// ===========================================================================
// Обзор
// ===========================================================================

// Дата расчётного периода в человеческом виде: "21.07.2026–27.07.2026".
// period_from/period_to хранятся как DATE — драйвер pg отдаёт их JS-датой в
// ЛОКАЛЬНОЙ таймзоне процесса, поэтому читаем именно локальные компоненты
// (тот же приём, что уже применён к settlement-датам после фикса
// timezone-стабильности), а не toISOString(), который сдвинул бы дату.
function formatSettlementDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatSettlementRange(from, to) {
  return `${formatSettlementDate(from)}–${formatSettlementDate(to)}`;
}

const WEEKDAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'дня';
  return 'дней';
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Обзор ресторана → Выплаты». Одно
// человеческое состояние, которое ВЫБРАЛ СЕРВЕР (services/hq/
// restaurantPayoutStateService.js) — шаблон только оформляет, не решает.
function renderPayoutStateBlock({ restaurant, state, csrfToken, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${restaurant.id}`;
  let body;

  if (state.kind === 'scheduled') {
    const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
    const local = new Date(state.at.getTime() + offsetMs);
    const weekday = WEEKDAY_NAMES[local.getUTCDay()];
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const when = state.daysLeft === 0 ? 'Сегодня' : `Через ${state.daysLeft} ${pluralDays(state.daysLeft)}`;
    body = `
      <div class="payout-line">${esc(when)}</div>
      <div class="payout-sub">${esc(weekday)} · ${hh}:00</div>`;
  } else if (state.kind === 'ready') {
    const confirmText = `Подготовить выплату «${restaurant.name}» на ${state.amount} ₽ за период ${formatSettlementRange(state.periodFrom, state.periodTo)}?`;
    body = `
      <div class="payout-line">Готово к выплате</div>
      <div class="payout-amount">${money(state.amount)}</div>
      <div class="payout-sub">Период: ${esc(formatSettlementRange(state.periodFrom, state.periodTo))}</div>
      <form method="post" action="${base}/payout" onsubmit="return confirm('${esc(confirmText)}')" style="margin-top:12px">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="compact">Подготовить выплату</button>
      </form>`;
  } else if (state.kind === 'not_ready') {
    const reason = PAYOUT_READINESS_LABELS[state.readiness] || 'Реквизиты требуют проверки';
    body = `
      <div class="payout-line">Не готово к выплате</div>
      <div class="payout-sub">${esc(reason)}</div>`;
  } else if (state.kind === 'processing') {
    body = `
      <div class="payout-line">Выплата обрабатывается</div>
      <div class="payout-amount">${money(state.amount)}</div>
      <div class="payout-sub">Период: ${esc(formatSettlementRange(state.periodFrom, state.periodTo))}</div>`;
  } else if (state.kind === 'blocked') {
    body = `
      <div class="payout-line">Выплата не прошла</div>
      <div class="payout-amount">${money(state.amount)}</div>
      <div class="payout-sub">${esc(state.reason || 'Требует решения')}</div>`;
  } else {
    body = `
      <div class="payout-line">Выплачено</div>
      <div class="payout-amount">${money(state.amount)}</div>
      <div class="payout-sub">Период: ${esc(formatSettlementRange(state.periodFrom, state.periodTo))}</div>`;
  }

  return `
    <div class="panel payout-block">
      <div class="panel-title">Выплаты</div>
      ${body}
    </div>`;
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Обзор ресторана». Один широкий блок
// «Заказы» (сегодня / за всё время, цифры под подписями, без внутренних
// рамок), два компактных финансовых показателя, блок «Выплаты». Рейтинг
// отдельной карточкой не дублируется — он уже в шапке.
function renderOverviewTab({ restaurant, overview, payoutState, csrfToken, linkBasePath }) {
  return `
    <div class="panel orders-block">
      <div class="panel-title">Заказы</div>
      <div class="orders-split">
        <div class="orders-part">
          <div class="orders-label">Сегодня</div>
          <div class="orders-value">${overview.ordersToday}</div>
        </div>
        <div class="orders-part">
          <div class="orders-label">За всё время</div>
          <div class="orders-value">${overview.ordersAllTime}</div>
        </div>
      </div>
    </div>

    <div class="metric-grid compact">
      <div class="metric"><div class="value">${money(overview.turnoverToday)}</div><div class="label">Оборот сегодня</div></div>
      <div class="metric"><div class="value">${money(overview.commissionToday)}</div><div class="label">Доход YAAM сегодня</div></div>
    </div>

    ${renderPayoutStateBlock({ restaurant, state: payoutState, csrfToken, linkBasePath })}
  `;
}

// ===========================================================================
// Заказы
// ===========================================================================

// Точное локальное время (Europe/Moscow) — спецификация требует «дата и
// точное время создания». Читаем UTC-компоненты сдвинутой копии, а не
// локальные геттеры процесса: сервер может стоять в любом TZ.
function formatMoscowDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const local = new Date(d.getTime() + PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} · ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Заказы ресторана»: сверху ТОЛЬКО фильтр
// по датам (быстрый фильтр, фильтр по статусу и поиск по номеру удалены).
// Поля и кнопка выровнены в одну сетку, на мобильном кнопка уходит на свою
// строку и не накладывается на поля дат (см. .date-filter в layout.js).
function renderOrdersTab({ restaurant, orders, page, totalPages, total, filters, linkBasePath }) {
  const query = { from: filters.from, to: filters.to };
  const baseUrl = `${linkBasePath}/restaurants/${restaurant.id}/orders`;

  const rows = orders.map((o) => {
    const items = (o.item_names || []).slice(0, 2).join(', ') + (o.item_count > 2 ? ` +${o.item_count - 2}` : '');
    return `
      <li class="dish-row">
        <a class="dish-link" href="${baseUrl}/${o.id}">
          <span class="dish-main">
            <span class="dish-name">${esc(o.public_code)} · ${money(o.items_total)}</span>
            <span class="dish-meta">${esc(formatMoscowDateTime(o.created_at))}</span>
            <span class="dish-meta">${esc(items)} · ${esc(ORDER_STATUS_LABELS[o.status] || o.status)}${o.rating ? ` · ${stars(o.rating)}` : ''}</span>
          </span>
          <span class="dish-chevron" aria-hidden="true"></span>
        </a>
      </li>`;
  }).join('');

  return `
    <form class="date-filter panel" method="get" action="${baseUrl}">
      <div class="field"><label for="of-from">С даты</label><input id="of-from" type="date" name="from" value="${esc(filters.from || '')}"></div>
      <div class="field"><label for="of-to">По дату</label><input id="of-to" type="date" name="to" value="${esc(filters.to || '')}"></div>
      <button type="submit" class="compact">Показать</button>
    </form>

    ${total === 0 ? '<div class="panel"><div class="empty-state">За выбранный период заказов нет.</div></div>' : `
    <div class="panel">
      <ul class="dish-list">${rows}</ul>
    </div>
    ${renderPagination({ page, totalPages, baseUrl, query })}
    `}
  `;
}

// Полная карточка заказа (спецификация, раздел «Заказы ресторана»). Пустые
// строки не выводятся: комментарий — только если он был; возврат — только
// если он существует. Персональные данные (имя/телефон/адрес) видны здесь и
// только здесь — этот экран доступен исключительно авторизованному владельцу
// HQ, в публичные ссылки и в «Центр событий» они не попадают.
function renderOrderDetail({ restaurant, detail, linkBasePath }) {
  const { order: o, items, payments, refunds } = detail;
  const itemsRows = items.map((i) => `
    <tr>
      <td>${esc(i.name)}</td>
      <td style="text-align:right">${i.qty}</td>
      <td style="text-align:right">${money(i.price)}</td>
      <td style="text-align:right">${money(i.price * i.qty)}</td>
    </tr>`).join('');

  const lastPayment = payments.length ? payments[payments.length - 1] : null;
  const succeededRefund = refunds.find((r) => r.status === 'succeeded') || null;
  const otherRefund = !succeededRefund && refunds.length ? refunds[refunds.length - 1] : null;

  return `
    <h1>Заказ ${esc(o.public_code)}</h1>
    <div class="panel">
      <table>
        <tr><td>Создан</td><td style="text-align:right">${esc(formatMoscowDateTime(o.created_at))}</td></tr>
        <tr><td>Статус заказа</td><td style="text-align:right">${esc(ORDER_STATUS_LABELS[o.status] || o.status)}</td></tr>
        <tr><td>Тип получения</td><td style="text-align:right">${o.fulfillment_type === 'pickup' ? 'Самовывоз' : 'Доставка'}</td></tr>
        <tr><td>Статус оплаты</td><td style="text-align:right">${esc(lastPayment ? (PAYMENT_STATUS_LABELS[lastPayment.status] || lastPayment.status) : 'Платежей нет')}</td></tr>
        ${succeededRefund ? `<tr><td>Возврат</td><td style="text-align:right">${esc(REFUND_STATUS_LABELS[succeededRefund.status])} · ${money(succeededRefund.amount)}</td></tr>` : ''}
        ${otherRefund ? `<tr><td>Возврат</td><td style="text-align:right">${esc(REFUND_STATUS_LABELS[otherRefund.status] || otherRefund.status)}</td></tr>` : ''}
        ${o.rating ? `<tr><td>Оценка клиента</td><td style="text-align:right">${stars(o.rating)}</td></tr>` : ''}
      </table>
    </div>

    <div class="panel">
      <div class="panel-title">Состав заказа</div>
      <table>
        <thead><tr><th>Блюдо</th><th style="text-align:right">Кол-во</th><th style="text-align:right">Цена</th><th style="text-align:right">Сумма</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <table style="margin-top:10px">
        <tr><td>Сумма блюд</td><td style="text-align:right">${money(o.items_total)}</td></tr>
        <tr><td>Итого к оплате</td><td style="text-align:right"><strong>${money(o.items_total)}</strong></td></tr>
      </table>
    </div>

    <div class="panel">
      <div class="panel-title">Клиент</div>
      <table>
        <tr><td>Имя</td><td style="text-align:right">${esc(o.customer_name)}</td></tr>
        <tr><td>Телефон</td><td style="text-align:right">${esc(o.customer_phone)}</td></tr>
        <tr><td>Адрес</td><td style="text-align:right">${esc(o.address)}</td></tr>
        ${o.comment ? `<tr><td>Комментарий</td><td style="text-align:right">${esc(o.comment)}</td></tr>` : ''}
      </table>
    </div>

    <a class="btn ghost compact" href="${linkBasePath}/restaurants/${restaurant.id}/orders">← К списку заказов</a>
  `;
}

// ===========================================================================
// Оценки
// ===========================================================================

function renderRatingsTab({ restaurant: r, distribution, ratings, page, totalPages, linkBasePath }) {
  const maxCount = Math.max(1, ...Object.values(distribution));
  const distRows = [5, 4, 3, 2, 1].map((star) => {
    const count = distribution[star];
    const pct = Math.round((count / maxCount) * 100);
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:34px;font-size:13px">${star} ★</div>
        <div style="flex:1;background:rgba(255,255,255,.06);border-radius:6px;height:14px;overflow:hidden"><div style="width:${pct}%;background:var(--amber);height:100%"></div></div>
        <div style="width:34px;text-align:right;font-size:13px;color:var(--txt2)">${count}</div>
      </div>`;
  }).join('');

  // «Дата заказа», а не «дата оценки» — схема не хранит момент выставления
  // оценки (rateOrder() обновляет только колонку rating). Спецификация прямо
  // запрещает выдумывать это время, поэтому подписано честно; отдельного
  // пояснительного блока внизу больше нет (спецификация его удаляет).
  const rows = ratings.map((o) => `
      <li class="dish-row">
        <a class="dish-link" href="${linkBasePath}/restaurants/${r.id}/orders/${o.id}">
          <span class="dish-main">
            <span class="dish-name">${esc(o.public_code)} · ${stars(o.rating)}</span>
            <span class="dish-meta">Дата заказа: ${esc(formatMoscowDateTime(o.created_at))}</span>
          </span>
          <span class="dish-chevron" aria-hidden="true"></span>
        </a>
      </li>`).join('');

  return `
    <div class="metric-grid compact">
      <div class="metric"><div class="value">${r.rating_count > 0 ? Number(r.rating).toFixed(1) : '—'}</div><div class="label">Средний рейтинг</div></div>
      <div class="metric"><div class="value">${r.rating_count}</div><div class="label">Всего оценок</div></div>
    </div>

    <div class="panel">
      <div class="panel-title">Распределение</div>
      ${r.rating_count === 0 ? '<div class="empty-state">Оценок пока нет.</div>' : distRows}
    </div>

    ${r.rating_count === 0 ? '' : `
    <div class="panel">
      <div class="panel-title">Оценённые заказы</div>
      <ul class="dish-list">${rows}</ul>
    </div>
    ${renderPagination({ page, totalPages, baseUrl: `${linkBasePath}/restaurants/${r.id}/ratings`, query: {} })}
    `}
  `;
}

// ===========================================================================
// Статистика
// ===========================================================================

function renderDailyChart(dailySeries) {
  if (!dailySeries.length) return '<div class="empty-state">Нет данных за период.</div>';
  const max = Math.max(1, ...dailySeries.map((d) => d.count));
  const showLabels = dailySeries.length <= 31;
  return `<div class="chart">${dailySeries.map((d) => {
    const heightPct = Math.max(2, Math.round((d.count / max) * 100));
    const shortLabel = d.date.slice(5); // MM-DD
    return `<div class="chart-bar${d.count === 0 ? ' zero' : ''}" style="height:${heightPct}%">
      <div class="chart-value">${d.count || ''}</div>
      ${showLabels ? `<div class="chart-label">${esc(shortLabel)}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function renderHourlyChart(hourlySeries) {
  const max = Math.max(1, ...hourlySeries.map((h) => h.count));
  return `<div class="chart">${hourlySeries.map((h) => {
    const heightPct = Math.max(2, Math.round((h.count / max) * 100));
    // Подписи каждые 3 часа — 24 подписи подряд не читаются на телефоне.
    const showLabel = h.hour % 3 === 0;
    return `<div class="chart-bar${h.count === 0 ? ' zero' : ''}" style="height:${heightPct}%">
      <div class="chart-value">${h.count || ''}</div>
      ${showLabel ? `<div class="chart-label">${String(h.hour).padStart(2, '0')}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Статистика»: вкладка отвечает только на
// два вопроса — как меняется спрос и какие блюда продаются лучше. Все
// финансовые блоки (оборот, комиссия, сумма ресторана, возвраты, готовность
// к выплатам) и повторные карточки создано/оплачено/выполнено удалены — они
// уже есть на «Обзоре» и «Финансах», дублирование запрещено.
function renderStatisticsTab({ restaurant, statistics: s, periodOptions, linkBasePath, error }) {
  const baseUrl = `${linkBasePath}/restaurants/${restaurant.id}/statistics`;
  const period = periodOptions.period || 'today';
  const periodTabs = [['today', 'Сегодня'], ['7d', 'Неделя'], ['30d', 'Месяц'], ['custom', 'Свой период']];

  const popularQtyRows = s.popularByQty.length
    ? s.popularByQty.map((d) => `<tr><td>${esc(d.name)}</td><td style="text-align:right">${d.qty}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty-state">Нет данных за период</td></tr>';
  const popularRevenueRows = s.popularByRevenue.length
    ? s.popularByRevenue.map((d) => `<tr><td>${esc(d.name)}</td><td style="text-align:right">${money(d.revenue)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty-state">Нет данных за период</td></tr>';

  const chartTitle = period === 'today' ? 'Заказы по часам' : 'Заказы по дням';
  const chart = period === 'today' && s.hourlySeries
    ? renderHourlyChart(s.hourlySeries)
    : renderDailyChart(s.dailySeries);

  return `
    <div class="period-switch">
      ${periodTabs.map(([key, label]) => `<a href="${baseUrl}?period=${key}" class="${period === key ? 'on' : ''}">${esc(label)}</a>`).join('')}
    </div>

    ${period === 'custom' ? `
    <form class="date-filter panel" method="get" action="${baseUrl}">
      <input type="hidden" name="period" value="custom">
      <div class="field"><label for="pf-from">С даты</label><input id="pf-from" type="date" name="from" value="${esc(periodOptions.from || '')}"></div>
      <div class="field"><label for="pf-to">По дату</label><input id="pf-to" type="date" name="to" value="${esc(periodOptions.to || '')}"></div>
      <button type="submit" class="compact">Показать</button>
    </form>` : ''}
    ${error ? `<div class="panel"><div class="error" style="margin-top:0">${esc(error)} Показан период «Сегодня».</div></div>` : ''}

    <div class="panel">
      <div class="panel-title">${esc(chartTitle)}</div>
      ${chart}
    </div>

    <div class="row">
      <div class="panel">
        <div class="panel-title">Популярные блюда — по количеству</div>
        <table><thead><tr><th>Блюдо</th><th style="text-align:right">Кол-во</th></tr></thead><tbody>${popularQtyRows}</tbody></table>
      </div>
      <div class="panel">
        <div class="panel-title">Популярные блюда — по выручке</div>
        <table><thead><tr><th>Блюдо</th><th style="text-align:right">Выручка</th></tr></thead><tbody>${popularRevenueRows}</tbody></table>
      </div>
    </div>
  `;
}

// ===========================================================================
// Настройки ресторана
// ===========================================================================

// docs/HQ-PRODUCT-SPEC.md, раздел «Управление рестораном»: три действия
// владельца YAAM, каждое с коротким подтверждением, собраны в один блок
// внизу настроек — на остальных вкладках их больше нет.
//   Приостановить = закрыть приём заказов, ресторан остаётся на сайте
//                   (is_open=0; НЕ путать с паузой, которую ресторан берёт
//                   сам через Telegram);
//   Скрыть        = убрать с публичного сайта (published_at=NULL);
//   Архивировать  = убрать из рабочего списка HQ, сохранив всю историю.
function renderManagementBlock({ restaurant: r, csrfToken, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${r.id}`;
  const status = lifecycle.resolveLifecycleStatus(r);

  if (r.archived_at) {
    return `
      <div class="panel">
        <div class="panel-title">Управление рестораном</div>
        <div class="empty-state" style="margin-bottom:14px">Ресторан в архиве с ${esc(formatDateTime(r.archived_at))}. История заказов, оценок и выплат сохранена полностью.</div>
        ${simpleActionForm({ action: `${base}/restore`, csrfToken, label: 'Вернуть из архива', cls: 'compact', confirm: `Вернуть «${r.name}» из архива?` })}
      </div>`;
  }

  const actions = [];
  if (status === 'draft') {
    actions.push(simpleActionForm({
      action: `${base}/publish`, csrfToken, label: 'Показать на сайте', cls: 'compact',
      confirm: `Показать «${r.name}» на сайте?`,
    }));
  } else {
    if (status === 'open') {
      actions.push(simpleActionForm({
        action: `${base}/close`, csrfToken, label: 'Приостановить', cls: 'ghost compact',
        confirm: `Приостановить приём заказов у «${r.name}»? Ресторан останется на сайте.`,
      }));
    } else if (status === 'closed') {
      actions.push(simpleActionForm({ action: `${base}/open`, csrfToken, label: 'Возобновить приём заказов', cls: 'compact' }));
    }
    // status === 'paused' — ресторан сам взял перерыв через Telegram;
    // открыть/закрыть в это время структурно отклоняется guard'ами
    // (assertCanOpen/assertCanClose), поэтому кнопки не показываются.
    actions.push(simpleActionForm({
      action: `${base}/unpublish`, csrfToken, label: 'Скрыть с сайта', cls: 'ghost compact',
      confirm: `Скрыть «${r.name}» с сайта? Ресторан исчезнет из публичного каталога, данные сохранятся.`,
    }));
  }
  actions.push(simpleActionForm({
    action: `${base}/archive`, csrfToken, label: 'Архивировать', cls: 'ghost compact',
    confirm: `Архивировать «${r.name}»? Ресторан исчезнет из рабочего списка HQ, вся история сохранится.`,
  }));

  return `
    <div class="panel">
      <div class="panel-title">Управление рестораном</div>
      <div class="manage-actions">${actions.join('')}</div>
    </div>`;
}

// Telegram-блок (docs/HQ-PRODUCT-SPEC.md, раздел «Telegram-подключение»).
// После подключения код НЕ показывается — только состояние и действия.
function renderTelegramBlock({ restaurant: r, telegram, csrfToken, linkBasePath }) {
  const base = `${linkBasePath}/restaurants/${r.id}/telegram`;
  if (!r.telegram_chat_id) {
    return `
      <div class="panel">
        <div class="panel-title">Telegram</div>
        <div class="payout-line">Не подключён</div>
        <div class="empty-state" style="margin:6px 0 14px">Создайте рабочую группу ресторана, добавьте в неё бота YAAM и отправьте в группе код подключения. Код одноразовый и перестаёт работать сразу после привязки.</div>
        ${telegram && telegram.connectCode
          ? `<div class="connect-code">${esc(telegram.connectCode)}</div>`
          : ''}
        ${simpleActionForm({ action: `${base}/new-code`, csrfToken, label: telegram && telegram.connectCode ? 'Выпустить новый код' : 'Создать код подключения', cls: 'compact' })}
      </div>`;
  }
  return `
    <div class="panel">
      <div class="panel-title">Telegram</div>
      <div class="payout-line">Подключён</div>
      <div class="payout-sub">${esc(r.telegram_chat_title || 'Рабочая группа ресторана')}</div>
      <div class="manage-actions" style="margin-top:12px">
        ${simpleActionForm({ action: `${base}/test`, csrfToken, label: 'Отправить тест', cls: 'ghost compact' })}
        ${simpleActionForm({ action: `${base}/reconnect`, csrfToken, label: 'Переподключить', cls: 'ghost compact', confirm: 'Отвязать текущую группу и выпустить новый код подключения?' })}
        ${simpleActionForm({ action: `${base}/disconnect`, csrfToken, label: 'Отключить', cls: 'ghost compact', confirm: 'Отключить Telegram? Ресторан перестанет получать заказы, пока не подключится снова.' })}
      </div>
    </div>`;
}

function renderRestaurantSettingsTab({
  restaurant: r, linkBasePath, csrfToken, error, notice,
  photos = [], mediaConfigured = false, maxPhotos = 0,
  legal = null, bank = null, contract = null, telegram = null,
}) {
  const selectedCities = parseCities(r.cities);
  const cityCheckboxes = SUPPORTED_CITIES.map((city, index) => `
    <label class="city-check">
      <input type="checkbox" name="cities" value="${esc(city)}" ${selectedCities.includes(city) ? 'checked' : ''} id="sf-city-${index}">
      <span>${esc(city)}</span>
    </label>`).join('');

  return `
    ${renderPhotoManager({
      title: 'Фотографии ресторана',
      photos, mediaConfigured, maxPhotos,
      uploadAction: `${linkBasePath}/restaurants/${r.id}/photos`,
      actionBase: `${linkBasePath}/restaurants/${r.id}/photos`,
      csrfToken,
    })}

    <div class="panel">
      <div class="panel-title">Основные данные</div>
      <form method="post" action="${linkBasePath}/restaurants/${r.id}/settings">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="sf-name">Название</label>
        <input id="sf-name" name="name" type="text" value="${esc(r.name)}" required autocomplete="off">
        <label>Города</label>
        <div class="city-checks">${cityCheckboxes}</div>
        <label for="sf-cuisine">Кухня</label>
        <input id="sf-cuisine" name="cuisine" type="text" value="${esc(r.cuisine)}" autocomplete="off">
        <label for="sf-description">Краткое описание</label>
        <textarea id="sf-description" name="description" autocomplete="off">${esc(r.description)}</textarea>
        <label for="sf-address">Адрес</label>
        <input id="sf-address" name="address" type="text" value="${esc(r.address)}" autocomplete="off">
        <label for="sf-phone">Телефон</label>
        <input id="sf-phone" name="phone" type="text" value="${esc(r.phone)}" autocomplete="off">
        <label for="sf-hours">Часы работы</label>
        <input id="sf-hours" name="hours" type="text" value="${esc(r.hours)}" autocomplete="off">
        <label for="sf-min-order">Минимальная сумма заказа, ₽</label>
        <input id="sf-min-order" name="min_order" type="number" min="0" value="${r.min_order}" autocomplete="off">
        <div class="save-row"><button type="submit" class="compact">Сохранить</button></div>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
        ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
      </form>
    </div>

    ${financeViews.renderLegalDetailsSection({ restaurant: r, legal, linkBasePath })}
    ${financeViews.renderBankDetailsSection({ restaurant: r, bank, linkBasePath })}
    ${financeViews.renderContractSection({ restaurant: r, contract, linkBasePath })}
    ${renderTelegramBlock({ restaurant: r, telegram, csrfToken, linkBasePath })}
    ${renderManagementBlock({ restaurant: r, csrfToken, linkBasePath })}
  `;
}

module.exports = {
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  REFUND_STATUS_LABELS,
  statusBadge,
  formatDateTime,
  formatDateOnly,
  money,
  parseCities,
  buildQuery,
  renderPagination,
  renderRestaurantsList,
  renderCreateForm,
  renderRestaurantHeader,
  renderActionBanner,
  renderTabs,
  renderOverviewTab,
  renderOrdersTab,
  renderOrderDetail,
  renderRatingsTab,
  renderStatisticsTab,
  renderRestaurantSettingsTab,
};
