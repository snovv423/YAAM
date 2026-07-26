'use strict';

// Логин/логаут HQ. YAAM HQ Stage 3: единственный владелец больше НЕ хранится
// в .env — только в PostgreSQL (hq_owner, см. services/hq/ownerService.js).
// .env (HQ_ADMIN_USER/HQ_ADMIN_PASSWORD_HASH) используется РОВНО один раз —
// при самом первом старте, чтобы заполнить пустую таблицу (см.
// bootstrapOwnerFromEnv() в services/postgresql/app.js) — этот файл его
// больше не читает вообще. Сознательно без регистрации/восстановления
// пароля по почте/приглашений/ролей ресторанов (задание прямо запрещает их
// создавать: у ресторанов вообще нет логинов, только Telegram-бот; у HQ —
// ровно один владелец, никогда больше одного).
const express = require('express');
const crypto = require('node:crypto');
const { verifyPassword } = require('../../services/hq/passwordHash');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { SESSION_COOKIE_NAME } = require('../../services/hq/session');
const { hqRootPath } = require('../../services/hq/basePath');
const ownerService = require('../../services/hq/ownerService');
const { logSecurityEvent } = require('../../services/hq/securityLog');
const { esc } = require('../../hq/layout');
const { createRequireHqAuth, loginRateLimiter } = require('./middleware');

// Сравнение логина в постоянное время — не потому что логин секретный сам
// по себе, а чтобы код ответа/тайминг никогда не давали два разных сигнала
// "неверный логин" vs "неверный пароль" (задание Stage 2, раздел 3 — не
// ослаблено этим этапом, см. задание Stage 3, раздел 9).
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Если владельца в hq_owner ещё нет (до первого bootstrap, или таблица
// пуста по любой другой причине) — verifyPassword просто нечего вызывать
// (нет password_hash для сравнения). Чтобы ответ "владельца нет вовсе" не
// отвечал ЗАМЕТНО быстрее, чем "владелец есть, пароль неверный" (тот же
// принцип timing-safety, что и для логина выше — задание Stage 3, раздел 9:
// "сохранить всю существующую безопасность Stage 2"), здесь всё равно
// выполняется настоящее scrypt-сравнение против валидного по формату, но
// заведомо ни для чего не используемого хеша. Значение — не секрет (пароль,
// которому оно соответствует, нигде не используется и никому не известен
// как значимый) — только нормализатор стоимости вычисления.
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$c6409a0a56b98a6b722c676ac63ce706$a9d50b2ce49225f959a51356531092fd736d6bb16dd13a6c274beff8fe8ec55dcc5ae9d9e8352db3b1c35b2523ca149be102058539056bc4764e8e38b3478386';

// Фиксированный, не отражающий пользовательский ввод набор уведомлений —
// query-параметр `changed` только ВЫБИРАЕТ один из двух заранее заданных
// текстов (строгое сравнение по allowlist ниже), никогда не рендерится сам
// по себе — исключает reflected-содержимое в адресной строке.
const CHANGE_NOTICES = {
  login: 'Логин изменён. Войдите с новым логином.',
  password: 'Пароль изменён. Войдите с новым паролем.',
};

function renderLoginPage({ csrfToken, error, linkBasePath, changed }) {
  const loginAction = `${linkBasePath}/login`;
  const staticScriptSrc = `${linkBasePath}/static/hq.js`;
  const notice = Object.prototype.hasOwnProperty.call(CHANGE_NOTICES, changed) ? CHANGE_NOTICES[changed] : null;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>Вход — YAAM HQ</title>
<style>
  :root{--bg:#0A2417;--panel:#123322;--txt:#F1F7F2;--txt2:rgba(241,247,242,.62);--amber:#FF9A2E;--bord:rgba(255,255,255,.14);--danger:#FF7059;--ok:#34D38C}
  *{box-sizing:border-box}
  body{font-family:-apple-system,Manrope,sans-serif;background:var(--bg);color:var(--txt);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--bord);border-radius:16px;padding:32px 28px}
  h1{font-size:19px;margin:0 0 24px;text-align:center;font-weight:800}
  label{display:block;font-size:12px;color:var(--txt2);font-weight:700;margin:14px 0 6px;text-transform:uppercase}
  input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--bord);background:rgba(255,255,255,.05);color:var(--txt);font-size:15px;font-family:inherit}
  input:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
  button{width:100%;margin-top:22px;background:var(--amber);color:#3a1c00;border:none;border-radius:10px;padding:12px;font-weight:800;cursor:pointer;font-size:15px}
  button:disabled{opacity:.6;cursor:default}
  .error{margin-top:16px;color:var(--danger);font-size:13px;text-align:center}
  .notice{margin-top:16px;color:var(--ok);font-size:13px;text-align:center}
</style>
</head>
<body>
<form class="card" method="post" action="${loginAction}" id="hq-login-form">
  <h1>YAAM HQ</h1>
  <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
  <label for="username">Логин</label>
  <input id="username" name="username" type="text" autocomplete="username" required autofocus>
  <label for="password">Пароль</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit" id="hq-login-submit" data-busy-text="Вход…">Войти</button>
  ${error ? `<div class="error">${esc(error)}</div>` : ''}
  ${!error && notice ? `<div class="notice">${esc(notice)}</div>` : ''}
</form>
<script src="${staticScriptSrc}" defer></script>
</body>
</html>`;
}

function createAuthRouter({ linkBasePath }) {
  const router = express.Router();
  const requireHqAuth = createRequireHqAuth(linkBasePath);
  const rootPath = hqRootPath(linkBasePath);
  const loginPath = `${linkBasePath}/login`;
  // ДОЛЖЕН побайтово совпадать с cookie.path в services/hq/session.js
  // (там тот же hqRootPath(linkBasePath)) — иначе clearCookie ниже не
  // сотрёт cookie, выставленную при логине, и logout не будет настоящим.
  const cookiePath = rootPath;

  router.get('/login', (req, res) => {
    if (req.session && req.session.hqAuthenticated === true) {
      return res.redirect(rootPath);
    }
    const csrfToken = ensureCsrfToken(req);
    const changed = typeof req.query.changed === 'string' ? req.query.changed : undefined;
    res.send(renderLoginPage({ csrfToken, linkBasePath, changed }));
  });

  router.post('/login', loginRateLimiter, requireCsrf, async (req, res, next) => {
    const username = typeof req.body.username === 'string' ? req.body.username : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    try {
      const owner = await ownerService.getOwner();
      // verifyPassword всегда выполняется по-настоящему (не пропускается ни
      // при заведомо неверном логине, ни при отсутствующем владельце) —
      // иначе более "быстрый" код пути отвечал бы заметно быстрее, и по
      // времени ответа можно было бы различать эти случаи снаружи.
      const passwordOk = await verifyPassword(password, owner ? owner.password_hash : DUMMY_PASSWORD_HASH);
      const usernameOk = owner ? timingSafeStringEqual(username, owner.login) : false;
      if (!owner || !passwordOk || !usernameOk) {
        await logSecurityEvent({ eventType: 'login_failed', ip: req.ip });
        const csrfToken = ensureCsrfToken(req);
        return res.status(401).send(renderLoginPage({ csrfToken, error: 'Неверный логин или пароль.', linkBasePath }));
      }
      // Ротация session ID при успешном входе — защита от session fixation
      // (атакующий не может подсунуть жертве заранее известный ID сессии,
      // который "станет" авторизованным после логина).
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.hqAuthenticated = true;
        req.session.hqUser = owner.login;
        // Stage 3: захватывается на момент логина, сверяется на каждый
        // защищённый запрос requireHqAuth — единственный механизм
        // "разлогинить эту сессию", если владелец сменил логин/пароль ПОСЛЕ
        // того, как эта сессия была создана (см. services/hq/ownerService.js
        // и routes/hq/middleware.js).
        req.session.hqCredentialsVersion = owner.credentials_version;
        req.session.save(async (saveErr) => {
          if (saveErr) return next(saveErr);
          await logSecurityEvent({ eventType: 'login_success', ip: req.ip });
          res.redirect(rootPath);
        });
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireHqAuth, requireCsrf, (req, res, next) => {
    req.session.destroy(async (err) => {
      if (err) return next(err);
      res.clearCookie(SESSION_COOKIE_NAME, { path: cookiePath });
      await logSecurityEvent({ eventType: 'logout', ip: req.ip });
      res.redirect(loginPath);
    });
  });

  return router;
}

module.exports = { createAuthRouter, renderLoginPage, timingSafeStringEqual, DUMMY_PASSWORD_HASH };
