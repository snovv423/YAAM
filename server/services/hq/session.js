'use strict';

// Серверная сессия HQ — express-session (Context7: /expressjs/session,
// официальный, поддерживаемый Express-организацией пакет; выбран вместо
// собственной реализации именно потому, что fixation/rotation/expiry —
// зона, где рукописный код особенно легко сделать тонко небезопасным).
//
// Store — Stage 15: PostgreSQL (services/hq/pgSessionStore.js). Дефолтный
// MemoryStore, использовавшийся до этого, был production-блокером: он не
// переживал перезапуск процесса (деплой разлогинивал владельца), не удалял
// истёкшие записи и не годился для нескольких инстансов. Стор передаётся
// параметром, а не создаётся здесь: тестам и SQLite-контуру он не нужен, и
// принудительное подключение к PostgreSQL из этого модуля сломало бы их.
const session = require('express-session');

const SESSION_COOKIE_NAME = 'yaam.hq.sid';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 часов, продлевается активностью (rolling)

// cookiePath — Stage 2.1: '/hq' локально (не отправляется на /api, /admin,
// публичный сайт), '/' за отдельным поддоменом hq.yaam.su в clean-root
// режиме (там HQ и есть весь сайт этого хоста — сузить путь дальше уже
// некуда, а host-only природа cookie и так не даёт ей уйти на другой домен).
// Значение ДОЛЖНО совпадать с тем, что рендерят routes/hq/auth.js
// (logout clearCookie) и services/hq/basePath.js (hqRootPath) — иначе
// logout не сможет корректно стереть cookie, выставленную при логине.
function createHqSessionMiddleware({ secret, isProduction, cookiePath, store = null }) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('HQ_SESSION_SECRET обязателен и должен быть длиной не меньше 32 символов');
  }
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/')) {
    throw new Error('createHqSessionMiddleware требует валидный cookiePath (например, "/hq" или "/")');
  }
  return session({
    name: SESSION_COOKIE_NAME,
    secret,
    // store не задан -> express-session берёт MemoryStore. Это допустимо
    // только вне production; production-запуск обязан передать стор (см.
    // services/postgresql/app.js и проверку в services/config/env.js).
    ...(store ? { store } : {}),
    resave: false,
    // saveUninitialized:false — сессия не создаётся (и cookie не отправляется)
    // для простого GET-визита, пока в неё реально не записали значение
    // (например, CSRF-токен на странице логина) — меньше пустых записей в
    // сторе от ботов/сканеров, ничего не теряя в безопасности.
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_MS,
      path: cookiePath,
    },
  });
}

module.exports = { createHqSessionMiddleware, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS };
