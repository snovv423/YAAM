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
const { normalizeHqLinkBasePath, hqRootPath } = require('../../services/hq/basePath');
const { createAuthRouter } = require('./auth');
const { createPagesRouter } = require('./pages');
const { createRequireHqAuth } = require('./middleware');

// linkBasePath — Stage 2.1 clean-root routing (см. services/hq/basePath.js):
// '/hq' по умолчанию (локальный доступ, как в Stage 2, БЕЗ единой правки
// вызывающего кода), '' за reverse-proxy на отдельном поддомене hq.yaam.su.
// Внутренний mount point роутера в services/postgresql/app.js ВСЕГДА '/hq' —
// linkBasePath меняет только то, что сам роутер ПИШЕТ в свои же ответы
// (redirect/href/form action/cookie path), не то, где Express его слушает.
function createHqRouter({ adminUser, adminPasswordHash, sessionSecret, isProduction, linkBasePath }) {
  if (!adminUser || !adminPasswordHash || !sessionSecret) {
    throw new Error('createHqRouter требует adminUser, adminPasswordHash и sessionSecret');
  }
  const resolvedLinkBasePath = normalizeHqLinkBasePath(linkBasePath);

  const router = express.Router();

  router.use(hqSecurityHeaders);

  // Единственный статический ресурс HQ (server/hq/static/hq.js —
  // double-submit-защита формы логина) — вынесен из инлайн <script>, потому
  // что CSP этой панели строгий self-only script-src без 'unsafe-inline'
  // (см. services/hq/securityHeaders.js). Не требует сессии — страница
  // логина без авторизации тоже должна суметь его загрузить. Путь монтирования
  // фиксирован ('/static' от внутреннего '/hq') независимо от linkBasePath —
  // сгенерированная ссылка на этот файл (routes/hq/auth.js) уже учитывает
  // linkBasePath сама, здесь ничего дополнительно решать не нужно.
  router.use('/static', express.static(path.join(__dirname, '../../hq/static'), {
    maxAge: '1h',
    etag: true,
  }));

  router.use(createHqSessionMiddleware({
    secret: sessionSecret,
    isProduction: Boolean(isProduction),
    cookiePath: hqRootPath(resolvedLinkBasePath),
  }));

  router.use('/', createAuthRouter({ adminUser, adminPasswordHash, linkBasePath: resolvedLinkBasePath }));
  router.use('/', createRequireHqAuth(resolvedLinkBasePath), createPagesRouter({ linkBasePath: resolvedLinkBasePath }));

  return router;
}

module.exports = { createHqRouter };
