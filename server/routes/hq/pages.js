'use strict';

// Защищённые HQ-страницы: Обзор (реальные метрики) и безопасные заглушки
// Рестораны/Финансы/Настройки (задание, раздел 7 — работающие пустые
// страницы с понятным empty-state, НЕ нефункциональные формы).
const express = require('express');
const db = require('../../db/postgresql');
const { layout, esc } = require('../../hq/layout');
const { ensureCsrfToken } = require('../../services/hq/csrf');
const dashboardMetrics = require('../../services/hq/dashboardMetrics');

const STATUS_LABELS = {
  awaiting_payment: 'Ожидают оплаты',
  awaiting_restaurant: 'Ожидают ресторан',
  accepted: 'Приняты',
  preparing: 'Готовятся',
  courier: 'В доставке',
};

function renderOverview({ top, active, restaurants, finance, attentionItems, csrfToken }) {
  const attentionBlock = attentionItems.length
    ? `<ul style="margin:0;padding-left:18px">${attentionItems.map((i) => `<li class="attention-item">${esc(i.label)}</li>`).join('')}</ul>`
    : `<div class="attention-ok">Всё спокойно. Действий не требуется.</div>`;

  const activeOrdersRows = [
    ['awaitingPayment', 'Ожидают оплаты'],
    ['awaitingRestaurant', 'Ожидают ресторан'],
    ['accepted', 'Приняты'],
    ['preparing', 'Готовятся'],
    ['courier', 'В доставке'],
  ].map(([key, label]) => `
    <div class="metric">
      <div class="value">${active[key]}</div>
      <div class="label">${esc(label)}</div>
    </div>`).join('');

  const restaurantsRows = restaurants.length
    ? restaurants.map((r) => {
        const statusBadge = r.pausedUntil
          ? '<span class="badge paused">На паузе</span>'
          : (r.isOpen ? '<span class="badge open">Открыт</span>' : '<span class="badge closed">Закрыт</span>');
        return `<tr>
          <td>${esc(r.name)}</td>
          <td>${statusBadge}</td>
          <td>${r.activeOrders}</td>
          <td>${r.telegramConnected ? 'Подключён' : 'Не подключён'}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="4" class="empty-state">Ресторанов пока нет.</td></tr>`;

  return `
    <h1>Обзор</h1>
    <div class="metric-grid">
      <div class="metric"><div class="value">${top.ordersToday}</div><div class="label">Заказов сегодня</div></div>
      <div class="metric"><div class="value">${top.turnoverToday} ₽</div><div class="label">Оборот сегодня</div></div>
      <div class="metric"><div class="value">${top.commissionToday} ₽</div><div class="label">Комиссия YAAM сегодня</div></div>
      <div class="metric"><div class="value">${top.activeRestaurants}</div><div class="label">Активные рестораны</div></div>
      <div class="metric"><div class="value">${top.attentionCount}</div><div class="label">Требуют внимания</div></div>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Активные заказы</div>
      <div class="metric-grid">${activeOrdersRows}</div>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Рестораны</div>
      <table>
        <thead><tr><th>Название</th><th>Статус</th><th>Активных заказов</th><th>Telegram</th></tr></thead>
        <tbody>${restaurantsRows}</tbody>
      </table>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Финансовая сводка (сегодня)</div>
      <table>
        <tr><td>Оборот доставленных заказов</td><td style="text-align:right">${finance.turnover} ₽</td></tr>
        <tr><td>Комиссия YAAM</td><td style="text-align:right">${finance.commission} ₽</td></tr>
        <tr><td>Доля ресторанов</td><td style="text-align:right">${finance.restaurantsShare} ₽</td></tr>
        <tr><td>Полные возвраты</td><td style="text-align:right">${finance.refundedOrders} шт · ${finance.refundedAmount} ₽</td></tr>
      </table>
      <div class="empty-state" style="margin-top:10px">Банковские выплаты будут доступны после подключения финансового модуля.</div>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Требует внимания</div>
      ${attentionBlock}
    </div>
  `;
}

function renderStub({ title, message }) {
  return `<h1>${esc(title)}</h1><div class="panel"><div class="empty-state">${esc(message)}</div></div>`;
}

function renderFinanceStub({ finance }) {
  return `
    <h1>Финансы</h1>
    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Сводка за сегодня (только чтение)</div>
      <table>
        <tr><td>Оборот доставленных заказов</td><td style="text-align:right">${finance.turnover} ₽</td></tr>
        <tr><td>Комиссия YAAM</td><td style="text-align:right">${finance.commission} ₽</td></tr>
        <tr><td>Доля ресторанов</td><td style="text-align:right">${finance.restaurantsShare} ₽</td></tr>
        <tr><td>Полные возвраты</td><td style="text-align:right">${finance.refundedOrders} шт · ${finance.refundedAmount} ₽</td></tr>
      </table>
      <div class="empty-state" style="margin-top:10px">Банковские выплаты будут доступны после подключения финансового модуля.</div>
    </div>
  `;
}

function renderSettings({ hqUser }) {
  return `
    <h1>Настройки</h1>
    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Текущий вход</div>
      <table>
        <tr><td>Логин</td><td style="text-align:right">${esc(hqUser)}</td></tr>
        <tr><td>Статус сессии</td><td style="text-align:right">Активна</td></tr>
      </table>
    </div>
    <div class="panel">
      <div style="font-weight:700;margin-bottom:10px">Безопасность</div>
      <div class="empty-state">Сессия защищена HttpOnly-cookie, действует ограниченное время и автоматически завершается при выходе. Смена пароля из интерфейса появится на следующем этапе.</div>
    </div>
  `;
}

function createPagesRouter() {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const [top, active, restaurants, finance, attentionItems] = await Promise.all([
        dashboardMetrics.getTopSummary(db),
        dashboardMetrics.getActiveOrdersBreakdown(db),
        dashboardMetrics.getRestaurantsStatus(db),
        dashboardMetrics.getFinanceSummary(db),
        dashboardMetrics.getAttentionItems(db),
      ]);
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Обзор',
        active: 'overview',
        csrfToken,
        body: renderOverview({ top, active, restaurants, finance, attentionItems, csrfToken }),
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/restaurants', (req, res) => {
    const csrfToken = ensureCsrfToken(req);
    res.send(layout({
      title: 'Рестораны',
      active: 'restaurants',
      csrfToken,
      body: renderStub({ title: 'Рестораны', message: 'Управление ресторанами будет реализовано на следующем этапе.' }),
    }));
  });

  router.get('/finance', async (req, res, next) => {
    try {
      const finance = await dashboardMetrics.getFinanceSummary(db);
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Финансы',
        active: 'finance',
        csrfToken,
        body: renderFinanceStub({ finance }),
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/settings', (req, res) => {
    const csrfToken = ensureCsrfToken(req);
    res.send(layout({
      title: 'Настройки',
      active: 'settings',
      csrfToken,
      body: renderSettings({ hqUser: req.session.hqUser || '' }),
    }));
  });

  return router;
}

module.exports = { createPagesRouter, STATUS_LABELS };
