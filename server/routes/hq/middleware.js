'use strict';

// Гейт доступа для всех защищённых /hq/**-маршрутов. HTML-запрос без сессии —
// редирект на логин (обычное поведение браузерной панели); JSON/API-запрос —
// 401 без деталей (никогда не сообщаем, что именно не так — см. csrf.js/auth.js
// про одинаковую внешнюю ошибку и для входа).
const rateLimit = require('express-rate-limit');
const { SESSION_COOKIE_NAME } = require('../../services/hq/session');
const { hqRootPath } = require('../../services/hq/basePath');
const ownerService = require('../../services/hq/ownerService');
const { logSecurityEvent } = require('../../services/hq/securityLog');

// Stage 2.1: редирект-таргет зависит от linkBasePath ('/hq/login' локально,
// '/login' за clean-root reverse-proxy) — см. services/hq/basePath.js.
//
// Stage 3: помимо req.session.hqAuthenticated, на КАЖДЫЙ защищённый запрос
// сверяется req.session.hqCredentialsVersion (записан при логине, см.
// routes/hq/auth.js) с актуальным credentials_version из hq_owner. Это
// единственный механизм "разлогинить все существующие сессии" после смены
// логина/пароля (см. db/postgresql/schema.sql, комментарий у hq_owner) —
// сессии живут в process-memory MemoryStore без возможности перечислить их
// по ID, поэтому вместо "найти и удалить все чужие сессии" каждая сессия
// сама себя признаёт недействительной, как только видит несовпадающую
// версию. Расхождение (в т.ч. полное отсутствие владельца — id=1 не
// существует, currentVersion===null) трактуется одинаково: сессия
// уничтожается, cookie стирается тем же path, что при обычном logout.
function createRequireHqAuth(linkBasePath) {
  const loginPath = `${linkBasePath}/login`;
  const cookiePath = hqRootPath(linkBasePath);

  function redirectToLogin(req, res) {
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(401).json({ error: 'Требуется вход в YAAM HQ' });
    }
    return res.redirect(loginPath);
  }

  return async function requireHqAuth(req, res, next) {
    if (!req.session || req.session.hqAuthenticated !== true) {
      return redirectToLogin(req, res);
    }
    try {
      const currentVersion = await ownerService.getCredentialsVersion();
      if (currentVersion === null || req.session.hqCredentialsVersion !== currentVersion) {
        return req.session.destroy((err) => {
          if (err) return next(err);
          res.clearCookie(SESSION_COOKIE_NAME, { path: cookiePath });
          return redirectToLogin(req, res);
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function hqLoginRateLimitHandler(req, res) {
  console.warn(
    `[hq] rate-limit ip=${req.ip} endpoint=${req.method} ${req.originalUrl} time=${new Date().toISOString()}`
  );
  logSecurityEvent({ eventType: 'login_rate_limited', ip: req.ip });
  res.status(429);
  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ error: 'Слишком много попыток входа — попробуйте позже.' });
  }
  res.send('Слишком много попыток входа — попробуйте позже.');
}

// Дословно тот же паттерн rate-limit, что и в routes/postgresql/api.js
// (orderCreateLimiter и т.д.) — по IP, скользящее окно. 8 попыток / 15 минут —
// достаточно для человека, ошибившегося пару раз, но останавливает
// перебор пароля.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: hqLoginRateLimitHandler,
});

module.exports = { createRequireHqAuth, loginRateLimiter };
