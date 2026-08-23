/* YAAM service worker.
 *
 * Назначение ровно одно: быстрый повторный запуск установленного приложения
 * за счёт кэша app shell. Для installability он НЕ нужен — актуальные
 * критерии Chromium это HTTPS + манифест с иконками 192/512, start_url и
 * display; требование "SW с fetch-обработчиком" из них убрано. Здесь SW живёт
 * только ради того, чтобы запуск с домашнего экрана не ждал сеть ради CSS,
 * app.js и шрифтов. Никакой офлайн-логики заказов здесь нет и быть не должно.
 *
 * ЖЁСТКИЕ ГРАНИЦЫ (нарушение любой из них ломает деньги или актуальность):
 *   - перехватывается ТОЛЬКО GET; POST/PUT/PATCH/DELETE уходят в сеть as-is;
 *   - перехватывается ТОЛЬКО свой origin + шрифты Google; API заказов
 *     (api.yaam.su, см. client/js/api.js), payment/confirmation URL провайдера
 *     и любой другой сторонний origin проходят мимо SW полностью;
 *   - ответы API/статусов/оплаты не кэшируются никогда;
 *   - навигации всегда идут network-first: кэш — только офлайн-fallback,
 *     свежий index.html с сервера всегда побеждает;
 *   - имена кэшей содержат VERSION (commit SHA, подставляется при деплое),
 *     activate удаляет все кэши прошлых версий -> старый app.js физически
 *     не может пережить деплой.
 *
 * VERSION подставляется в CI (.github/workflows/pages.yml) тем же sed, что
 * и в index.html, поэтому тело файла меняется каждый деплой — браузер видит
 * побайтовое отличие и обновляет SW.
 */
'use strict';

const VERSION = '__CACHE_BUST__';
const CACHE_NAME = `yaam-static-${VERSION}`;

// В деплое sed заменяет плейсхолдер на commit SHA. Если замены не было —
// это локальный запуск из рабочей копии, и `?v=` больше не иммутабелен:
// URL не меняется, а файл под ним правится каждую минуту. В этом режиме
// versioned-статика обслуживается network-first, иначе разработчик получал
// бы вечный старый app.js.
const VERSIONED_IS_IMMUTABLE = VERSION !== '__CACHE' + '_BUST__';

// Шрифты интерфейса. Стили и файлы шрифтов иммутабельны и не содержат ничего
// персонального; кэш убирает сетевую паузу перед первым кадром при запуске
// установленного приложения.
const FONT_ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);

self.addEventListener('install', () => {
  // Ничего не пре-кэшируем: install не должен тянуть трафик, которого
  // страница не запрашивала, а всё нужное осядет в кэше при первом же показе.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('yaam-') && n !== CACHE_NAME).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

function cacheable(response) {
  return !!response
    && response.status === 200
    && response.type !== 'opaque'
    && response.type !== 'opaqueredirect';
}

async function putSafely(request, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (e) {
    /* квота/недопустимый ответ — кэш не критичен, молча пропускаем */
  }
}

// Иммутабельный за деплой ресурс (URL несёт ?v=<commit sha>): отдаём из кэша
// сразу, в сеть не ходим вовсе. При новом деплое меняется и URL, и имя кэша.
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response)) putSafely(request, response.clone());
  return response;
}

// Статика без версии в URL (иконки, манифест, шрифты): показываем кэш
// мгновенно, параллельно обновляем на будущее.
async function staleWhileRevalidate(request) {
  const hit = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      if (cacheable(response)) putSafely(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (hit) return hit;
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('offline and not cached');
}

// Всё остальное своего origin, включая навигации: сеть — источник истины,
// кэш трогаем только когда сети нет.
async function networkFirst(request, { store }) {
  try {
    const response = await fetch(request);
    if (store && cacheable(response)) putSafely(request, response.clone());
    return response;
  } catch (e) {
    const hit = await caches.match(request);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 1. Только GET. Создание заказа, оплата, отмена, рейтинг — мимо SW.
  if (request.method !== 'GET') return;
  // Range-запросы (медиа) кэшировать нельзя — отдаём сети целиком.
  if (request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // 2. Чужой origin: API заказов, payment/confirmation URL, аналитика,
  // фото ресторанов с внешних хостов. Единственное исключение — шрифты.
  if (url.origin !== self.location.origin) {
    if (FONT_ORIGINS.has(url.origin)) {
      event.respondWith(staleWhileRevalidate(request));
    }
    return;
  }

  // 3. Защита на будущее: если API когда-нибудь переедет на свой origin,
  // он всё равно не должен попасть в кэш.
  if (url.pathname.startsWith('/api/')) return;

  // 4. Иммутабельная за деплой статика (?v=<sha>).
  if (url.searchParams.has('v')) {
    event.respondWith(
      VERSIONED_IS_IMMUTABLE ? cacheFirst(request) : networkFirst(request, { store: true })
    );
    return;
  }

  // 5. Иконки и манифест — статика без версии в URL.
  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 6. Навигации и остальная своя статика: сеть впереди кэша.
  // Кэшируем только «чистые» URL без query — чтобы в кэш не попал адрес
  // с возвратными параметрами платёжного провайдера или чем-то личным.
  event.respondWith(networkFirst(request, { store: url.search === '' }));
});
