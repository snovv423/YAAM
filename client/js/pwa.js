/* PWA-обвязка YAAM: регистрация service worker и признак standalone-режима.
 *
 * Держится отдельно от app.js намеренно: к бизнес-логике заказов отношения
 * не имеет, а при откате достаточно убрать один <script>.
 *
 * Никакой кастомной кнопки «Установить» здесь нет и не должно быть: на iOS
 * программная установка невозможна в принципе, а на Android установку
 * предлагает сам браузер. beforeinstallprompt не перехватывается — иначе
 * штатный install flow Chromium был бы подавлен.
 */
(function () {
  'use strict';

  var root = document.documentElement;

  // Установленный запуск (Home Screen / Android standalone) отличается от
  // обычной вкладки: iOS Safari до сих пор сообщает об этом только через
  // нестандартный navigator.standalone, Chromium — через display-mode.
  function standalone() {
    return window.navigator.standalone === true
      || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function applyDisplayMode() {
    root.classList.toggle('standalone', standalone());
  }

  applyDisplayMode();
  if (window.matchMedia) {
    var mq = window.matchMedia('(display-mode: standalone)');
    // addEventListener у MediaQueryList появился позже addListener — Safari
    // старых версий понимает только второй.
    if (mq.addEventListener) mq.addEventListener('change', applyDisplayMode);
    else if (mq.addListener) mq.addListener(applyDisplayMode);
  }

  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  // Аварийный выключатель: yaam.su/?nosw=1 снимает регистрацию и чистит кэши
  // без выката нового клиента.
  //
  // Само выключение — это unregister(): после него ни один запрос страницы
  // больше не проходит через воркер. Уборка CacheStorage — вторична и
  // делается best-effort с задержкой: страница, открытая с ?nosw=1, ещё
  // остаётся управляемой прежним воркером до своей выгрузки, и его фоновые
  // revalidate-записи успевают заново создать только что удалённый кэш.
  // Если кэш всё же переживёт эту попытку, он безвреден (перехватывать
  // запросы больше некому) и будет удалён на activate следующего воркера.
  if (/(?:^|[?&])nosw=1(?:&|$)/.test(location.search)) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
    }).then(function () {
      return new Promise(function (done) { setTimeout(done, 2000); });
    }).then(function () {
      return window.caches ? caches.keys() : [];
    }).then(function (names) {
      return Promise.all(names.filter(function (n) {
        return n.indexOf('yaam-') === 0;
      }).map(function (n) { return caches.delete(n); }));
    }).catch(function () { /* выключатель не обязан быть транзакционным */ });
    return;
  }

  window.addEventListener('load', function () {
    // updateViaCache:'none' — тело самого sw.js всегда проверяется по сети,
    // иначе HTTP-кэш мог бы придержать старый обработчик после деплоя.
    navigator.serviceWorker.register('sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(function () { /* без SW приложение работает как обычный сайт */ });
  });
})();
