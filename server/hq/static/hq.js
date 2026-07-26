'use strict';
// Единственный клиентский скрипт HQ — универсальная защита от повторной
// отправки ЛЮБОЙ формы (не только логина — Stage 4 добавляет создание/
// правку ресторана, паузу, архивирование) + polling «Обзора» ресторана.
// Вынесен в отдельный статический файл (не инлайн <script>) намеренно: CSP
// страницы (server/services/hq/securityHeaders.js) — строгий self-only
// `script-src 'self'` без 'unsafe-inline', поэтому инлайн-скрипт браузер бы
// просто заблокировал.
(function () {
  // Double-submit guard — делегированный слушатель на document, работает для
  // любой формы HQ без необходимости давать каждой свой уникальный id/script.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    if (btn.dataset.busyText) btn.textContent = btn.dataset.busyText;
  });
})();

(function () {
  // Живое обновление «Обзора» ресторана — раз в 20 секунд, останавливается,
  // когда вкладка скрыта (задание Stage 4, раздел 12). Один защищённый
  // JSON-эндпоинт (GET .../overview.json, auth уже проверен на уровне
  // роутера, no-store уже выставлен глобально hqSecurityHeaders) — без
  // WebSocket-инфраструктуры и без перезагрузки всей страницы.
  var root = document.getElementById('hq-live-overview');
  if (!root) return;
  var endpoint = root.getAttribute('data-endpoint');
  if (!endpoint) return;
  var timer = null;

  function setValue(key, value) {
    var el = root.querySelector('[data-metric="' + key + '"]');
    if (el) el.textContent = value;
  }

  function money(n) {
    return n + ' ₽';
  }

  function refresh() {
    fetch(endpoint, { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        setValue('ordersToday', data.ordersToday);
        setValue('deliveredToday', data.deliveredToday);
        setValue('turnoverToday', money(data.turnoverToday));
        setValue('avgCheckToday', data.avgCheckToday === null ? '—' : money(data.avgCheckToday));
        setValue('totalDelivered', data.totalDelivered);
        setValue('active.awaitingPayment', data.active.awaitingPayment);
        setValue('active.awaitingRestaurant', data.active.awaitingRestaurant);
        setValue('active.accepted', data.active.accepted);
        setValue('active.preparing', data.active.preparing);
        setValue('active.courier', data.active.courier);
      })
      .catch(function () { /* тихо игнорируем сетевой сбой — следующий тик попробует снова */ });
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, 20000);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });
  if (!document.hidden) start();
})();
