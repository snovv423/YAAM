'use strict';

// CSRF-защита изменяющих HQ-запросов — синхронизирующий токен (synchronizer
// token pattern), привязанный к серверной сессии (express-session), а не
// пакет `csurf` — тот официально помечен deprecated/unmaintained мейнтейнерами
// (перестал получать обновления), поэтому НЕ используется, несмотря на то,
// что название могло бы напрашиваться первым. Сам паттерн — не собственная
// криптография: только crypto.randomBytes (CSPRNG из стандартной библиотеки)
// для генерации токена и crypto.timingSafeEqual для сравнения без утечки по
// таймингу — те же самые примитивы, что YAAM уже использует для
// access_token заказов (см. server/services/postgresql/orderService.js).
const crypto = require('node:crypto');

const CSRF_TOKEN_BYTES = 32;
const CSRF_FIELD_NAME = '_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

// Токен генерируется один раз на сессию (не на каждый рендер формы) — так
// он переживает несколько открытых вкладок с формами одной и той же сессии,
// без слома "открыл форму в одной вкладке, отправил из другой".
function ensureCsrfToken(req) {
  if (!req.session) throw new Error('ensureCsrfToken требует активную сессию');
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
  }
  return req.session.csrfToken;
}

function verifyCsrfToken(req) {
  const expected = req.session && req.session.csrfToken;
  const provided = (req.body && req.body[CSRF_FIELD_NAME]) || req.get(CSRF_HEADER_NAME);
  if (!expected || !provided || typeof provided !== 'string') return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Middleware для всех изменяющих HQ-запросов (POST/PUT/PATCH/DELETE) — GET
// никогда не проверяется (безопасные методы по определению не должны иметь
// побочных эффектов, поэтому CSRF на них не применим по смыслу самого паттерна).
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (verifyCsrfToken(req)) return next();
  res.status(403);
  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ error: 'Недействительный CSRF-токен. Обновите страницу и повторите.' });
  }
  return res.send('Недействительный CSRF-токен. Обновите страницу и повторите попытку.');
}

module.exports = { ensureCsrfToken, verifyCsrfToken, requireCsrf, CSRF_FIELD_NAME };
