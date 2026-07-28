'use strict';

// Сборка HQ-роутера: security headers → сессия → публичный login/logout →
// защищённые страницы. Монтируется в services/postgresql/app.js целиком под
// '/hq' — тот же fail-closed принцип точки монтирования, что и у /admin.
//
// Stage 3: владелец больше НЕ передаётся сюда параметрами (adminUser/
// adminPasswordHash исчезли из сигнатуры) — routes/hq/auth.js и
// routes/hq/pages.js сами обращаются к services/hq/ownerService.js
// (PostgreSQL, таблица hq_owner). Единственное, что здесь остаётся
// обязательным для монтирования — HQ_SESSION_SECRET (без него сессии в
// принципе невозможны, независимо от того, где хранится владелец): без
// него роутер вообще не подключается (см. services/postgresql/app.js) —
// HQ либо полностью недоступен, либо полностью защищён, промежуточного
// "наполовину" состояния нет.
const express = require('express');
const path = require('node:path');
const { createHqSessionMiddleware } = require('../../services/hq/session');
const { createHqSecurityHeaders } = require('../../services/hq/securityHeaders');
const { normalizeHqLinkBasePath, hqRootPath } = require('../../services/hq/basePath');
const { createAuthRouter } = require('./auth');
const { createPagesRouter } = require('./pages');
const { createRestaurantsRouter } = require('./restaurants');
const { createSettlementsRouter } = require('./settlements');
const { createRequireHqAuth } = require('./middleware');

// linkBasePath — Stage 2.1 clean-root routing (см. services/hq/basePath.js):
// '/hq' по умолчанию (локальный доступ, как в Stage 2, БЕЗ единой правки
// вызывающего кода), '' за reverse-proxy на отдельном поддомене hq.yaam.su.
// Внутренний mount point роутера в services/postgresql/app.js ВСЕГДА '/hq' —
// linkBasePath меняет только то, что сам роутер ПИШЕТ в свои же ответы
// (redirect/href/form action/cookie path), не то, где Express его слушает.
function createHqRouter({ sessionSecret, isProduction, linkBasePath, mediaProvider = null }) {
  if (!sessionSecret) {
    throw new Error('createHqRouter требует sessionSecret');
  }
  const resolvedLinkBasePath = normalizeHqLinkBasePath(linkBasePath);

  const router = express.Router();

  // Stage 5B: если медиа реально настроено, CSP img-src должен разрешать
  // origin, на котором физически лежат фотографии — иначе браузер молча
  // блокирует все <img> в HQ. getPublicUrl() — чистая функция без сети (см.
  // services/hq/media/provider.js), безопасно вызвать один раз при сборке
  // роутера. Stage 5B.2: getPublicUrl() теперь отказывается строить URL для
  // чего угодно вне префикса `public/` — пробный ключ должен ему
  // соответствовать, иначе этот вызов сам бы бросал исключение.
  let mediaImgOrigin = null;
  if (mediaProvider) {
    try {
      mediaImgOrigin = new URL(mediaProvider.getPublicUrl('public/csp-probe')).origin;
    } catch {
      mediaImgOrigin = null;
    }
  }
  router.use(createHqSecurityHeaders({ extraImgSrc: mediaImgOrigin }));

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

  router.use('/', createAuthRouter({ linkBasePath: resolvedLinkBasePath }));
  // Stage 4: /restaurants — отдельный роутер (server/routes/hq/restaurants.js),
  // смонтирован ДО общего pagesRouter (тот ниже больше не содержит заглушки
  // "Рестораны" — заменена этим полноценным разделом целиком).
  router.use('/restaurants', createRequireHqAuth(resolvedLinkBasePath), createRestaurantsRouter({ linkBasePath: resolvedLinkBasePath, mediaProvider }));
  // YAAM HQ Stage 8: /finance/settlements — смонтирован ДО общего
  // pagesRouter (тот же принцип, что и /restaurants выше), '/finance' САМ
  // ПО СЕБЕ (без /settlements) по-прежнему обрабатывается pagesRouter'ом
  // (существующий Stage 7 live-экран, только дополненный секцией периодов).
  router.use('/finance/settlements', createRequireHqAuth(resolvedLinkBasePath), createSettlementsRouter({ linkBasePath: resolvedLinkBasePath }));
  router.use('/', createRequireHqAuth(resolvedLinkBasePath), createPagesRouter({ linkBasePath: resolvedLinkBasePath, mediaProvider }));

  return router;
}

module.exports = { createHqRouter };
