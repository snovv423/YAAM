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
const dashboardMetrics = require('../../services/hq/dashboardMetrics');

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

function renderSettings({ hqUser, linkBasePath, csrfToken, loginError, passwordError }) {
  const changeLoginAction = `${linkBasePath}/settings/change-login`;
  const changePasswordAction = `${linkBasePath}/settings/change-password`;
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
      <div class="empty-state">Сессия защищена HttpOnly-cookie, действует ограниченное время и автоматически завершается при выходе. Смена логина или пароля ниже сразу завершает текущую сессию — потребуется войти заново.</div>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Смена логина</div>
      <form method="post" action="${esc(changeLoginAction)}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="change-login-current-password">Текущий пароль</label>
        <input id="change-login-current-password" name="currentPassword" type="password" autocomplete="current-password" required>
        <label for="change-login-new-login">Новый логин</label>
        <input id="change-login-new-login" name="newLogin" type="text" autocomplete="username" required>
        <button type="submit">Сменить логин</button>
        ${loginError ? `<div class="error">${esc(loginError)}</div>` : ''}
      </form>
    </div>

    <div class="panel">
      <div style="font-weight:700;margin-bottom:14px">Смена пароля</div>
      <form method="post" action="${esc(changePasswordAction)}">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="change-password-current-password">Текущий пароль</label>
        <input id="change-password-current-password" name="currentPassword" type="password" autocomplete="current-password" required>
        <label for="change-password-new-password">Новый пароль</label>
        <input id="change-password-new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}">
        <label for="change-password-confirm-password">Повторить пароль</label>
        <input id="change-password-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}">
        <button type="submit">Сменить пароль</button>
        ${passwordError ? `<div class="error">${esc(passwordError)}</div>` : ''}
      </form>
    </div>
  `;
}

function createPagesRouter({ linkBasePath }) {
  const router = express.Router();
  const rootPath = hqRootPath(linkBasePath);
  const loginPath = `${linkBasePath}/login`;
  const settingsPath = `${linkBasePath}/settings`;
  const cookiePath = rootPath;

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
        linkBasePath,
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
      linkBasePath,
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
        linkBasePath,
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
      linkBasePath,
      body: renderSettings({ hqUser: req.session.hqUser || '', linkBasePath, csrfToken }),
    }));
  });

  // После УСПЕШНОЙ смены логина/пароля сессия, из которой сделана смена,
  // тоже завершается (задание Stage 3, раздел 5 — "завершить ВСЕ
  // существующие сессии", без исключения для текущей) — .destroy() здесь, а
  // не просто редирект, иначе credentials_version-проверка в middleware.js
  // сработала бы только на СЛЕДУЮЩЕМ запросе, оставляя короткое окно, где
  // текущая вкладка формально ещё выглядит залогиненной.
  function endSessionAndRedirectToLogin(req, res, next, changedWhat) {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(SESSION_COOKIE_NAME, { path: cookiePath });
      res.redirect(`${loginPath}?changed=${changedWhat}`);
    });
  }

  router.post('/settings/change-login', requireCsrf, async (req, res, next) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newLogin = typeof req.body.newLogin === 'string' ? req.body.newLogin.trim() : '';
    try {
      const owner = await ownerService.getOwner();
      const currentPasswordOk = owner && await verifyPassword(currentPassword, owner.password_hash);
      if (!owner || !currentPasswordOk) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(401).send(layout({
          title: 'Настройки', active: 'settings', csrfToken, linkBasePath,
          body: renderSettings({ hqUser: req.session.hqUser || '', linkBasePath, csrfToken, loginError: 'Неверный текущий пароль.' }),
        }));
      }
      if (!newLogin) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(400).send(layout({
          title: 'Настройки', active: 'settings', csrfToken, linkBasePath,
          body: renderSettings({ hqUser: req.session.hqUser || '', linkBasePath, csrfToken, loginError: 'Новый логин не может быть пустым.' }),
        }));
      }
      await ownerService.changeOwnerLogin(newLogin);
      await logSecurityEvent({ eventType: 'login_change', ip: req.ip });
      endSessionAndRedirectToLogin(req, res, next, 'login');
    } catch (err) {
      next(err);
    }
  });

  router.post('/settings/change-password', requireCsrf, async (req, res, next) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
    try {
      const owner = await ownerService.getOwner();
      const currentPasswordOk = owner && await verifyPassword(currentPassword, owner.password_hash);
      if (!owner || !currentPasswordOk) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(401).send(layout({
          title: 'Настройки', active: 'settings', csrfToken, linkBasePath,
          body: renderSettings({ hqUser: req.session.hqUser || '', linkBasePath, csrfToken, passwordError: 'Неверный текущий пароль.' }),
        }));
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(400).send(layout({
          title: 'Настройки', active: 'settings', csrfToken, linkBasePath,
          body: renderSettings({ hqUser: req.session.hqUser || '', linkBasePath, csrfToken, passwordError: `Новый пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.` }),
        }));
      }
      if (newPassword !== confirmPassword) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(400).send(layout({
          title: 'Настройки', active: 'settings', csrfToken, linkBasePath,
          body: renderSettings({ hqUser: req.session.hqUser || '', linkBasePath, csrfToken, passwordError: 'Пароли не совпадают.' }),
        }));
      }
      const newPasswordHash = await hashPassword(newPassword);
      await ownerService.changeOwnerPassword(newPasswordHash);
      await logSecurityEvent({ eventType: 'password_change', ip: req.ip });
      endSessionAndRedirectToLogin(req, res, next, 'password');
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPagesRouter, STATUS_LABELS, renderSettings, MIN_PASSWORD_LENGTH };
