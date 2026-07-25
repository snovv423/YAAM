'use strict';

// Сборка HQ-роутера: security headers → сессия → публичный login/logout →
// защищённые страницы. Монтируется в services/postgresql/app.js целиком под
// '/hq' — тот же fail-closed принцип точки монтирования, что и у /admin
// (см. app.js: без обеих переменных ADMIN_USER/ADMIN_PASS роутер вообще не
// подключается). Здесь: без всех трёх HQ_ADMIN_USER/HQ_ADMIN_PASSWORD_HASH/
// HQ_SESSION_SECRET — HQ вообще не существует в приложении, а не существует
// "без защиты".
const express = require('express');
const path = require('node:path');
const { createHqSessionMiddleware } = require('../../services/hq/session');
const { hqSecurityHeaders } = require('../../services/hq/securityHeaders');
const { createAuthRouter } = require('./auth');
const { createPagesRouter } = require('./pages');
const { requireHqAuth } = require('./middleware');

function createHqRouter({ adminUser, adminPasswordHash, sessionSecret, isProduction }) {
  if (!adminUser || !adminPasswordHash || !sessionSecret) {
    throw new Error('createHqRouter требует adminUser, adminPasswordHash и sessionSecret');
  }

  const router = express.Router();

  router.use(hqSecurityHeaders);

  // Единственный статический ресурс HQ (server/hq/static/hq.js —
  // double-submit-защита формы логина) — вынесен из инлайн <script>, потому
  // что CSP этой панели строгий self-only script-src без 'unsafe-inline'
  // (см. services/hq/securityHeaders.js). Не требует сессии — страница
  // логина без авторизации тоже должна суметь его загрузить.
  router.use('/static', express.static(path.join(__dirname, '../../hq/static'), {
    maxAge: '1h',
    etag: true,
  }));

  router.use(createHqSessionMiddleware({ secret: sessionSecret, isProduction: Boolean(isProduction) }));

  router.use('/', createAuthRouter({ adminUser, adminPasswordHash }));
  router.use('/', requireHqAuth, createPagesRouter());

  return router;
}

module.exports = { createHqRouter };
