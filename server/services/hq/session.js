'use strict';

// Серверная сессия HQ — express-session (Context7: /expressjs/session,
// официальный, поддерживаемый Express-организацией пакет; выбран вместо
// собственной реализации именно потому, что fixation/rotation/expiry —
// зона, где рукописный код особенно легко сделать тонко небезопасным).
//
// Store — намеренно дефолтный MemoryStore. Явное ограничение (см. финальный
// отчёт, разделы "Риски" и "Инструкция для hq.yaam.su"): не переживает
// перезапуск процесса и не годится для нескольких инстансов за балансировщиком.
// Для Stage 2 (единственный владелец, один процесс, один admin-аккаунт) это
// приемлемый компромисс; добавление стора вроде connect-pg-simple — отдельная,
// заранее обозначенная работа на будущий этап, а не тихая недоделка.
const session = require('express-session');

const SESSION_COOKIE_NAME = 'yaam.hq.sid';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 часов, продлевается активностью (rolling)

function createHqSessionMiddleware({ secret, isProduction }) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('HQ_SESSION_SECRET обязателен и должен быть длиной не меньше 32 символов');
  }
  return session({
    name: SESSION_COOKIE_NAME,
    secret,
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
      // Cookie ограничена путём /hq — браузер не отправляет её ни на
      // публичный сайт, ни на /api, ни на /admin (отдельная поверхность,
      // отдельная cookie, минимум лишних данных в каждом запросе).
      path: '/hq',
    },
  });
}

module.exports = { createHqSessionMiddleware, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS };
