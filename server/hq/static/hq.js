'use strict';
// Единственный клиентский скрипт HQ — защита от повторной отправки формы
// логина. Вынесен в отдельный статический файл (не инлайн <script>)
// намеренно: CSP страницы (server/services/hq/securityHeaders.js) — строгий
// self-only `script-src 'self'` без 'unsafe-inline', поэтому инлайн-скрипт
// браузер бы просто заблокировал.
(function () {
  var form = document.getElementById('hq-login-form');
  if (!form) return;
  form.addEventListener('submit', function () {
    var btn = document.getElementById('hq-login-submit');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Вход…';
  });
})();
