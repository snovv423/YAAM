'use strict';

// Логин/логаут HQ. Единственный admin-аккаунт из ENV (HQ_ADMIN_USER +
// HQ_ADMIN_PASSWORD_HASH) — сознательно без регистрации/восстановления
// пароля/приглашений/ролей ресторанов (задание прямо запрещает их создавать
// на этом этапе: у ресторанов вообще нет логинов, только Telegram-бот).
const express = require('express');
const crypto = require('node:crypto');
const { verifyPassword } = require('../../services/hq/passwordHash');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { SESSION_COOKIE_NAME } = require('../../services/hq/session');
const { hqRootPath } = require('../../services/hq/basePath');
const { esc } = require('../../hq/layout');
const { createRequireHqAuth, loginRateLimiter } = require('./middleware');

// Сравнение логина в постоянное время — не потому что логин секретный сам
// по себе, а чтобы код ответа/тайминг никогда не давали два разных сигнала
// "неверный логин" vs "неверный пароль" (задание, раздел 3).
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Сравниваем буфер сам с собой той же длины, чтобы не возвращаться
    // раньше времени и не давать тайминговый сигнал о том, что длины не совпали.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function renderLoginPage({ csrfToken, error, linkBasePath }) {
  const loginAction = `${linkBasePath}/login`;
  const staticScriptSrc = `${linkBasePath}/static/hq.js`;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>Вход — YAAM HQ</title>
<style>
  :root{--bg:#0A2417;--panel:#123322;--txt:#F1F7F2;--txt2:rgba(241,247,242,.62);--amber:#FF9A2E;--bord:rgba(255,255,255,.14);--danger:#FF7059}
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
  <button type="submit" id="hq-login-submit">Войти</button>
  ${error ? `<div class="error">${esc(error)}</div>` : ''}
</form>
<script src="${staticScriptSrc}" defer></script>
</body>
</html>`;
}

function createAuthRouter({ adminUser, adminPasswordHash, linkBasePath }) {
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
    res.send(renderLoginPage({ csrfToken, linkBasePath }));
  });

  router.post('/login', loginRateLimiter, requireCsrf, async (req, res, next) => {
    const username = typeof req.body.username === 'string' ? req.body.username : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    try {
      // verifyPassword всегда выполняется по-настоящему (не пропускается при
      // заведомо неверном логине) — иначе неверный логин отвечал бы быстрее
      // неверного пароля, и по времени ответа можно было бы угадывать логин.
      const passwordOk = await verifyPassword(password, adminPasswordHash);
      const usernameOk = timingSafeStringEqual(username, adminUser);
      if (!passwordOk || !usernameOk) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(401).send(renderLoginPage({ csrfToken, error: 'Неверный логин или пароль.', linkBasePath }));
      }
      // Ротация session ID при успешном входе — защита от session fixation
      // (атакующий не может подсунуть жертве заранее известный ID сессии,
      // который "станет" авторизованным после логина).
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.hqAuthenticated = true;
        req.session.hqUser = username;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.redirect(rootPath);
        });
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireHqAuth, requireCsrf, (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(SESSION_COOKIE_NAME, { path: cookiePath });
      res.redirect(loginPath);
    });
  });

  return router;
}

module.exports = { createAuthRouter, renderLoginPage, timingSafeStringEqual };
