'use strict';

// Гейт доступа для всех защищённых /hq/**-маршрутов. HTML-запрос без сессии —
// редирект на логин (обычное поведение браузерной панели); JSON/API-запрос —
// 401 без деталей (никогда не сообщаем, что именно не так — см. csrf.js/auth.js
// про одинаковую внешнюю ошибку и для входа).
const rateLimit = require('express-rate-limit');

function requireHqAuth(req, res, next) {
  if (req.session && req.session.hqAuthenticated === true) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'Требуется вход в YAAM HQ' });
  }
  return res.redirect('/hq/login');
}

function hqLoginRateLimitHandler(req, res) {
  console.warn(
    `[hq] rate-limit ip=${req.ip} endpoint=${req.method} ${req.originalUrl} time=${new Date().toISOString()}`
  );
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

module.exports = { requireHqAuth, loginRateLimiter };
