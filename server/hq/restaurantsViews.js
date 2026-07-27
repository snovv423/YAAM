'use strict';

// YAAM HQ Stage 4 — server-rendered HTML для раздела «Рестораны». Тот же
// принцип, что и весь остальной HQ (server/hq/layout.js, routes/hq/*):
// шаблонные функции без движка/фреймворка, esc() на каждое значение из БД.
const { esc } = require('./layout');
const lifecycle = require('../services/hq/restaurantLifecycle');
const { renderPhotoManager } = require('./photosViews');

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

// Stage 4.1 — единая компактная метка lifecycle-статуса (задание, раздел 6,
// вариант "компактная итоговая метка" — выбран вместо двух раздельных строк
// "Публикация: X / Приём заказов: Y", чтобы не перегружать интерфейс, тот же
// минимализм, что и остальной HQ). Источник истины — resolveLifecycleStatus
// (services/hq/restaurantLifecycle.js), не повторный inline-расчёт здесь.
function statusBadge(r) {
  const status = lifecycle.resolveLifecycleStatus(r);
  if (status === 'draft') return '<span class="badge paused">Черновик</span>';
  if (status === 'archived') return '<span class="badge closed">В архиве</span>';
  if (status === 'open') return '<span class="badge open">Открыт</span>';
  if (status === 'paused') {
    const until = r.paused_until instanceof Date ? r.paused_until : new Date(r.paused_until);
    const hh = String(until.getHours()).padStart(2, '0');
    const mm = String(until.getMinutes()).padStart(2, '0');
    return `<span class="badge paused">Пауза до ${hh}:${mm}</span>`;
  }
  return '<span class="badge closed">Закрыт</span>';
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

function renderRestaurantsList({ restaurants, page, totalPages, total, filters, linkBasePath }) {
  const query = { search: filters.search, city: filters.city, status: filters.status, sort: filters.sort };
  const rows = restaurants.map((r) => `
    <tr>
      <td data-label="Название"><a href="${linkBasePath}/restaurants/${r.id}">${esc(r.name)}</a></td>
      <td data-label="Город">${esc(parseCities(r.cities).join(', '))}</td>
      <td data-label="Кухня">${esc(r.cuisine || '—')}</td>
      <td data-label="Статус">${statusBadge(r)}</td>
      <td data-label="Рейтинг">${r.rating_count > 0 ? `${stars(Number(r.rating).toFixed(1))} · ${r.rating_count}` : '—'}</td>
      <td data-label="Доставлено">${r.delivered_count}</td>
      <td data-label="Активных">${r.active_count}</td>
      <td data-label="Telegram">${r.telegram_chat_id ? 'Подключён' : 'Не подключён'}</td>
      <td data-label=""><a class="btn ghost" href="${linkBasePath}/restaurants/${r.id}">Открыть</a></td>
    </tr>`).join('');

  const emptyMessage = total === 0 && !filters.search && !filters.city && !filters.status
    ? 'Ресторанов пока нет.'
    : 'По заданным фильтрам ничего не найдено.';

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Рестораны</h1>
      <a class="btn" href="${linkBasePath}/restaurants/new">+ Добавить ресторан</a>
    </div>

    <form class="filters panel" method="get" action="${linkBasePath}/restaurants">
      <div class="field"><label for="lf-search">Поиск по названию</label><input id="lf-search" type="text" name="search" value="${esc(filters.search || '')}" placeholder="Название..."></div>
      <div class="field"><label for="lf-city">Город</label><input id="lf-city" type="text" name="city" value="${esc(filters.city || '')}" placeholder="Грозный"></div>
      <div class="field">
        <label for="lf-status">Статус</label>
        <select id="lf-status" name="status">
          <option value="">Все</option>
          <option value="draft" ${filters.status === 'draft' ? 'selected' : ''}>Черновики</option>
          <option value="published" ${filters.status === 'published' ? 'selected' : ''}>Опубликованные</option>
          <option value="open" ${filters.status === 'open' ? 'selected' : ''}>Открыт</option>
          <option value="closed" ${filters.status === 'closed' ? 'selected' : ''}>Закрыт</option>
          <option value="paused" ${filters.status === 'paused' ? 'selected' : ''}>Пауза</option>
          <option value="archived" ${filters.status === 'archived' ? 'selected' : ''}>Архивированные</option>
        </select>
      </div>
      <div class="field">
        <label for="lf-sort">Сортировка</label>
        <select id="lf-sort" name="sort">
          <option value="name" ${filters.sort === 'name' ? 'selected' : ''}>По названию</option>
          <option value="orders" ${filters.sort === 'orders' ? 'selected' : ''}>По доставленным заказам</option>
          <option value="rating" ${filters.sort === 'rating' ? 'selected' : ''}>По рейтингу</option>
          <option value="created" ${filters.sort === 'created' ? 'selected' : ''}>По дате добавления</option>
        </select>
      </div>
      <button type="submit">Применить</button>
    </form>

    ${total === 0 ? `<div class="panel"><div class="empty-state">${esc(emptyMessage)}</div></div>` : `
    <div class="panel">
      <table class="responsive">
        <thead><tr><th>Название</th><th>Город</th><th>Кухня</th><th>Статус</th><th>Рейтинг</th><th>Доставлено</th><th>Активных</th><th>Telegram</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination({ page, totalPages, baseUrl: `${linkBasePath}/restaurants`, query })}
    `}
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
        <label for="rf-cities">Города (через запятую)</label>
        <input id="rf-cities" name="cities" type="text" value="${esc(v.cities)}" placeholder="Грозный, Аргун" required autocomplete="off">
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
function renderRestaurantHeader({ restaurant: r, csrfToken, linkBasePath, menuItemsCount = 0 }) {
  const status = lifecycle.resolveLifecycleStatus(r);
  const base = `${linkBasePath}/restaurants/${r.id}`;
  const actions = [];

  if (status === 'draft') {
    const publishConfirm = menuItemsCount === 0
      ? `У ресторана «${r.name}» пока нет блюд. Опубликовать всё равно?`
      : `Опубликовать «${r.name}»? Ресторан станет виден клиентам.`;
    actions.push(simpleActionForm({ action: `${base}/publish`, csrfToken, label: 'Опубликовать', confirm: publishConfirm }));
  } else if (status !== 'archived') {
    if (status === 'closed') {
      actions.push(simpleActionForm({ action: `${base}/open`, csrfToken, label: 'Открыть' }));
    } else if (status === 'open') {
      actions.push(simpleActionForm({ action: `${base}/close`, csrfToken, label: 'Закрыть', cls: 'ghost', confirm: `Закрыть «${r.name}» для новых заказов?` }));
    }
    // status === 'paused' — намеренно без Открыть/Закрыть: пока ресторан на
    // паузе через Telegram, оба действия структурно отклонены guard'ами
    // (assertCanOpen/assertCanClose требуют "не на паузе") — показывать их
    // здесь означало бы кнопку, которая всегда ошибается; статус "Пауза до
    // HH:MM" уже виден в statusBadge выше.
    actions.push(simpleActionForm({ action: `${base}/unpublish`, csrfToken, label: 'Скрыть', cls: 'ghost', confirm: `Скрыть «${r.name}»? Ресторан исчезнет из публичного каталога.` }));
  }

  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;margin-bottom:16px">
      <div>
        <h1 style="margin-bottom:6px">${esc(r.name)}</h1>
        <div style="color:var(--txt2);font-size:13px">${esc(parseCities(r.cities).join(', '))} · ${statusBadge(r)} · ${r.rating_count > 0 ? `${stars(Number(r.rating).toFixed(1))} (${r.rating_count})` : 'Оценок нет'} · Telegram: ${r.telegram_chat_id ? 'подключён' : 'не подключён'}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${actions.join(' ')}</div>
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

function renderOverviewTab({ restaurant, overview, linkBasePath }) {
  const activeRows = [
    ['awaiting_payment', 'Ожидают оплаты', overview.active.awaitingPayment],
    ['awaiting_restaurant', 'Ожидают ресторан', overview.active.awaitingRestaurant],
    ['accepted', 'Приняты', overview.active.accepted],
    ['preparing', 'Готовятся', overview.active.preparing],
    ['courier', 'В доставке', overview.active.courier],
  ];
  const totalActive = activeRows.reduce((sum, [, , v]) => sum + v, 0);

  return `
    <div id="hq-live-overview" data-endpoint="${linkBasePath}/restaurants/${restaurant.id}/overview.json">
      <div class="metric-grid">
        <div class="metric"><div class="value" data-metric="ordersToday">${overview.ordersToday}</div><div class="label">Заказов сегодня</div></div>
        <div class="metric"><div class="value" data-metric="deliveredToday">${overview.deliveredToday}</div><div class="label">Доставлено сегодня</div></div>
        <div class="metric"><div class="value" data-metric="turnoverToday">${money(overview.turnoverToday)}</div><div class="label">Оборот сегодня</div></div>
        <div class="metric"><div class="value" data-metric="avgCheckToday">${overview.avgCheckToday === null ? '—' : money(overview.avgCheckToday)}</div><div class="label">Средний чек сегодня</div></div>
        <div class="metric"><div class="value" data-metric="totalDelivered">${overview.totalDelivered}</div><div class="label">Всего доставлено</div></div>
      </div>

      <div class="panel">
        <div style="font-weight:700;margin-bottom:14px">Активные заказы</div>
        ${totalActive === 0 ? '<div class="empty-state">Активных заказов нет.</div>' : `
        <div class="metric-grid">
          ${activeRows.map(([key, label, value]) => `
            <div class="metric">
              <div class="value" data-metric="active.${key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}">${value}</div>
              <div class="label">${esc(label)}</div>
            </div>`).join('')}
        </div>`}
      </div>
    </div>
  `;
}

// ===========================================================================
// Заказы
// ===========================================================================

function renderOrdersTab({ restaurant, orders, page, totalPages, total, filters, linkBasePath }) {
  const query = { filter: filters.filter, status: filters.status, code: filters.code, from: filters.from, to: filters.to };
  const baseUrl = `${linkBasePath}/restaurants/${restaurant.id}/orders`;

  const rows = orders.map((o) => {
    const items = (o.item_names || []).slice(0, 2).join(', ') + (o.item_count > 2 ? ` +${o.item_count - 2}` : '');
    const refund = o.refund_status ? `<div style="font-size:11px;color:var(--txt2)">Возврат: ${esc(REFUND_STATUS_LABELS[o.refund_status] || o.refund_status)}</div>` : '';
    return `
    <tr>
      <td data-label="Заказ"><a class="order-code" href="${baseUrl}/${o.id}">${esc(o.public_code)}</a></td>
      <td data-label="Создан">${formatDateTime(o.created_at)}</td>
      <td data-label="Состав">${esc(items)} (${o.item_count})</td>
      <td data-label="Сумма">${money(o.items_total)}</td>
      <td data-label="Статус заказа">${esc(ORDER_STATUS_LABELS[o.status] || o.status)}</td>
      <td data-label="Оплата">${esc(PAYMENT_STATUS_LABELS[o.payment_status] || o.payment_status || '—')}${refund}</td>
      <td data-label="Оценка">${o.rating ? stars(o.rating) : '—'}</td>
    </tr>`;
  }).join('');

  return `
    <form class="filters panel" method="get" action="${baseUrl}">
      <div class="field">
        <label for="of-filter">Быстрый фильтр</label>
        <select id="of-filter" name="filter">
          <option value="">Все</option>
          <option value="active" ${filters.filter === 'active' ? 'selected' : ''}>Активные</option>
          <option value="today" ${filters.filter === 'today' ? 'selected' : ''}>Сегодня</option>
          <option value="delivered" ${filters.filter === 'delivered' ? 'selected' : ''}>Доставленные</option>
          <option value="cancelled" ${filters.filter === 'cancelled' ? 'selected' : ''}>Отменённые/отклонённые/просроченные</option>
        </select>
      </div>
      <div class="field">
        <label for="of-status">Статус</label>
        <select id="of-status" name="status">
          <option value="">Любой</option>
          ${Object.entries(ORDER_STATUS_LABELS).map(([key, label]) => `<option value="${key}" ${filters.status === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="of-code">Номер YAAM</label><input id="of-code" type="text" name="code" value="${esc(filters.code || '')}" placeholder="YAAM-00001"></div>
      <div class="field"><label for="of-from">С даты</label><input id="of-from" type="date" name="from" value="${esc(filters.from || '')}"></div>
      <div class="field"><label for="of-to">По дату</label><input id="of-to" type="date" name="to" value="${esc(filters.to || '')}"></div>
      <button type="submit">Применить</button>
    </form>

    ${total === 0 ? '<div class="panel"><div class="empty-state">По заданным фильтрам заказов нет.</div></div>' : `
    <div class="panel">
      <table class="responsive">
        <thead><tr><th>Заказ</th><th>Создан</th><th>Состав</th><th>Сумма</th><th>Статус заказа</th><th>Оплата</th><th>Оценка</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination({ page, totalPages, baseUrl, query })}
    `}
  `;
}

function renderOrderDetail({ restaurant, detail, linkBasePath }) {
  const { order: o, items, payments, refunds } = detail;
  const itemsRows = items.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${money(i.price)}</td><td>${money(i.price * i.qty)}</td></tr>`).join('');
  const paymentsRows = payments.map((p) => `<tr><td>${esc(PAYMENT_STATUS_LABELS[p.status] || p.status)}</td><td>${money(p.amount)}</td><td>${formatDateTime(p.created_at)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty-state">Платежей нет</td></tr>';
  const refundsRows = refunds.map((r) => `<tr><td>${esc(REFUND_STATUS_LABELS[r.status] || r.status)}</td><td>${money(r.amount)}</td><td>${formatDateTime(r.created_at)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty-state">Возвратов нет</td></tr>';

  return `
    <h1>Заказ ${esc(o.public_code)}</h1>
    <div class="panel">
      <table>
        <tr><td>Статус</td><td style="text-align:right">${esc(ORDER_STATUS_LABELS[o.status] || o.status)}</td></tr>
        <tr><td>Создан</td><td style="text-align:right">${formatDateTime(o.created_at)}</td></tr>
        <tr><td>Тип получения</td><td style="text-align:right">${o.fulfillment_type === 'pickup' ? 'Самовывоз' : 'Доставка'}</td></tr>
        <tr><td>Сумма блюд</td><td style="text-align:right">${money(o.items_total)}</td></tr>
        <tr><td>Комиссия YAAM</td><td style="text-align:right">${money(o.commission_amount)}</td></tr>
        <tr><td>Оценка</td><td style="text-align:right">${o.rating ? stars(o.rating) : '—'}</td></tr>
      </table>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Состав заказа</div>
      <table><thead><tr><th>Блюдо</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${itemsRows}</tbody></table>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Контакт клиента</div>
      <table>
        <tr><td>Имя</td><td style="text-align:right">${esc(o.customer_name)}</td></tr>
        <tr><td>Телефон</td><td style="text-align:right">${esc(o.customer_phone)}</td></tr>
        <tr><td>Адрес</td><td style="text-align:right">${esc(o.address)}</td></tr>
        ${o.comment ? `<tr><td>Комментарий</td><td style="text-align:right">${esc(o.comment)}</td></tr>` : ''}
      </table>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Платежи</div>
      <table><thead><tr><th>Статус</th><th>Сумма</th><th>Создан</th></tr></thead><tbody>${paymentsRows}</tbody></table>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Возвраты</div>
      <table><thead><tr><th>Статус</th><th>Сумма</th><th>Создан</th></tr></thead><tbody>${refundsRows}</tbody></table>
    </div>

    <a class="btn ghost" href="${linkBasePath}/restaurants/${restaurant.id}/orders">← К списку заказов</a>
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

  const rows = ratings.map((o) => `
    <tr>
      <td data-label="Заказ"><a class="order-code" href="${linkBasePath}/restaurants/${r.id}/orders/${o.id}">${esc(o.public_code)}</a></td>
      <td data-label="Оценка">${stars(o.rating)}</td>
      <td data-label="Дата заказа">${formatDateTime(o.created_at)}</td>
    </tr>`).join('');

  return `
    <div class="metric-grid">
      <div class="metric"><div class="value">${r.rating_count > 0 ? Number(r.rating).toFixed(1) : '—'}</div><div class="label">Средний рейтинг</div></div>
      <div class="metric"><div class="value">${r.rating_count}</div><div class="label">Оценок</div></div>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Распределение</div>
      ${r.rating_count === 0 ? '<div class="empty-state">Оценок пока нет.</div>' : distRows}
    </div>

    ${r.rating_count === 0 ? '' : `
    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Оценённые заказы</div>
      <div class="empty-state" style="margin-bottom:12px">В YAAM нет текстовых отзывов — только оценка звёздами. «Дата заказа» — момент оформления заказа: схема не хранит отдельно момент, когда клиент поставил оценку.</div>
      <table class="responsive">
        <thead><tr><th>Заказ</th><th>Оценка</th><th>Дата заказа</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
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

function renderStatisticsTab({ restaurant, statistics: s, periodOptions, linkBasePath, error }) {
  const baseUrl = `${linkBasePath}/restaurants/${restaurant.id}/statistics`;
  const period = periodOptions.period || 'today';

  const popularQtyRows = s.popularByQty.length
    ? s.popularByQty.map((d) => `<tr><td>${esc(d.name)}</td><td style="text-align:right">${d.qty}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty-state">Нет данных за период</td></tr>';
  const popularRevenueRows = s.popularByRevenue.length
    ? s.popularByRevenue.map((d) => `<tr><td>${esc(d.name)}</td><td style="text-align:right">${money(d.revenue)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty-state">Нет данных за период</td></tr>';

  return `
    <form class="filters panel" method="get" action="${baseUrl}">
      <div class="field">
        <label for="pf-period">Период</label>
        <select id="pf-period" name="period" onchange="this.form.submit()">
          <option value="today" ${period === 'today' ? 'selected' : ''}>Сегодня</option>
          <option value="7d" ${period === '7d' ? 'selected' : ''}>7 дней</option>
          <option value="30d" ${period === '30d' ? 'selected' : ''}>30 дней</option>
          <option value="custom" ${period === 'custom' ? 'selected' : ''}>Произвольный период</option>
        </select>
      </div>
      ${period === 'custom' ? `
      <div class="field"><label for="pf-from">С даты</label><input id="pf-from" type="date" name="from" value="${esc(periodOptions.from || '')}"></div>
      <div class="field"><label for="pf-to">По дату</label><input id="pf-to" type="date" name="to" value="${esc(periodOptions.to || '')}"></div>
      ` : ''}
      <button type="submit">Показать</button>
    </form>
    ${error ? `<div class="panel"><div class="error" style="margin-top:0">${esc(error)} Показан период «Сегодня».</div></div>` : ''}

    <div class="metric-grid">
      <div class="metric"><div class="value">${s.created}</div><div class="label">Создано заказов</div></div>
      <div class="metric"><div class="value">${s.paid}</div><div class="label">Оплачено</div></div>
      <div class="metric"><div class="value">${s.delivered}</div><div class="label">Доставлено</div></div>
      <div class="metric"><div class="value">${money(s.turnover)}</div><div class="label">Оборот (delivered)</div></div>
      <div class="metric"><div class="value">${s.avgCheck === null ? '—' : money(s.avgCheck)}</div><div class="label">Средний чек</div></div>
      <div class="metric"><div class="value">${s.avgRating === null ? '—' : s.avgRating}</div><div class="label">Средняя оценка (${s.ratingCount})</div></div>
      <div class="metric"><div class="value">${s.customerCancels}</div><div class="label">Отмены клиента</div></div>
      <div class="metric"><div class="value">${s.restaurantDeclines}</div><div class="label">Отказы ресторана</div></div>
      <div class="metric"><div class="value">${s.timedOut}</div><div class="label">Истекли по времени</div></div>
      <div class="metric"><div class="value">${s.paymentFailed}</div><div class="label">Ошибки оплаты</div></div>
      <div class="metric"><div class="value">${s.conversionPercent === null ? '—' : `${s.conversionPercent}%`}</div><div class="label">Конверсия создано → доставлено</div></div>
    </div>
    <div class="empty-state" style="margin-top:-10px;margin-bottom:20px">Конверсия — доля заказов периода, дошедших до статуса «доставлен» на СЕЙЧАС. Заказы, ещё не завершившиеся к моменту просмотра (в пути/готовятся), не считаются ни доставленными, ни отменёнными — для незакрытых периодов (например «сегодня») конверсия занижена относительно итоговой судьбы этих заказов.</div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:6px">Заказы по дням</div>
      ${renderDailyChart(s.dailySeries)}
    </div>

    <div class="row">
      <div class="panel">
        <div style="font-weight:700;margin-bottom:14px">Популярные блюда — по количеству</div>
        <table><thead><tr><th>Блюдо</th><th style="text-align:right">Кол-во</th></tr></thead><tbody>${popularQtyRows}</tbody></table>
      </div>
      <div class="panel">
        <div style="font-weight:700;margin-bottom:14px">Популярные блюда — по выручке</div>
        <table><thead><tr><th>Блюдо</th><th style="text-align:right">Выручка</th></tr></thead><tbody>${popularRevenueRows}</tbody></table>
      </div>
    </div>
  `;
}

// ===========================================================================
// Настройки ресторана
// ===========================================================================

function renderRestaurantSettingsTab({
  restaurant: r, linkBasePath, csrfToken, error, notice,
  photos = [], archivedPhotos = [], mediaConfigured = false, maxPhotos = 0,
}) {
  const archiveAction = r.archived_at
    ? `<form method="post" action="${linkBasePath}/restaurants/${r.id}/restore" onsubmit="return confirm('Восстановить «${esc(r.name)}» из архива?')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit">Восстановить из архива</button>
      </form>`
    : `<form method="post" action="${linkBasePath}/restaurants/${r.id}/archive" onsubmit="return confirm('Архивировать «${esc(r.name)}»? Ресторан будет скрыт с публичного сайта, история заказов и оценок сохранится.')">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <button type="submit" class="danger">Архивировать ресторан</button>
      </form>`;

  return `
    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Основные данные</div>
      <form method="post" action="${linkBasePath}/restaurants/${r.id}/settings">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="sf-name">Название</label>
        <input id="sf-name" name="name" type="text" value="${esc(r.name)}" required autocomplete="off">
        <label for="sf-cities">Города (через запятую)</label>
        <input id="sf-cities" name="cities" type="text" value="${esc(parseCities(r.cities).join(', '))}" required autocomplete="off">
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
        <button type="submit">Сохранить</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
        ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
      </form>
    </div>

    ${renderPhotoManager({
      title: 'Фотографии ресторана',
      photos, archivedPhotos, mediaConfigured, maxPhotos,
      uploadAction: `${linkBasePath}/restaurants/${r.id}/photos`,
      actionBase: `${linkBasePath}/restaurants/${r.id}/photos`,
      csrfToken,
    })}

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Telegram</div>
      <table>
        <tr><td>Статус</td><td style="text-align:right">${r.telegram_chat_id ? 'Подключён' : 'Не подключён'}</td></tr>
      </table>
      <div class="empty-state" style="margin-top:10px">Переподключение бота выполняется самим рестораном по коду в Telegram — код показывается только внутри защищённого HQ и не публикуется.</div>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">${r.archived_at ? 'В архиве' : 'Архивирование'}</div>
      ${r.archived_at ? `<div class="empty-state" style="margin-bottom:14px">Ресторан архивирован ${formatDateTime(r.archived_at)}. Он скрыт с публичного сайта, история заказов и оценок сохранена.</div>` : `<div class="empty-state" style="margin-bottom:14px">Архивирование скрывает ресторан с публичного сайта. История заказов и оценок сохраняется полностью — это не удаление.</div>`}
      ${archiveAction}
    </div>
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
