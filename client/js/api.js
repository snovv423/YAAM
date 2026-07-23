// Мост между статикой (GitHub Pages) и реальным бэкендом (server/).
// Пока API_BASE_URL не задан — сайт работает как раньше, на демо-данных
// из data.js и локальной имитации оплаты/статусов. Ручной override —
// window.YAAM_API_BASE_URL, заданный ДО подключения этого файла (так уже
// пользуются существующие тесты, см. client/test/helpers/loadApp.js) —
// всегда в приоритете и этим кодом не трогается.
//
// Stage 11A: явный, обратимый staging-режим для controlled browser E2E
// (не для обычных посетителей yaam.su). Единственный способ его включить —
// query-параметр ?yaam_staging_api=1 на первой загрузке страницы; адрес
// backend — жёстко зашитая константа ниже, а НЕ значение из query-строки
// (принимать URL из query было бы open-redirect-подобной дырой). Активный
// staging переживает возврат с оплаты через sessionStorage (НЕ localStorage
// — теряется при закрытии вкладки, не может "залипнуть" навсегда в браузере
// случайного посетителя): YOOKASSA_RETURN_URL=https://yaam.su/ у ЮKassa
// редиректит обратно БЕЗ исходного query-параметра, только sessionStorage
// удерживает режим через этот redirect. ?yaam_staging_api=0 выключает и
// чистит sessionStorage — это и есть весь rollback, без backend/VPS правок.
const STAGING_API_BASE_URL = 'https://api-pg.yaam.su';
const STAGING_QUERY_PARAM = 'yaam_staging_api';
const STAGING_SESSION_KEY = 'yaam_staging_api_active';

function resolveApiBaseUrl() {
  if (window.YAAM_API_BASE_URL) return window.YAAM_API_BASE_URL;

  let queryValue = null;
  try {
    const search = (window.location && window.location.search) || '';
    queryValue = new URLSearchParams(search).get(STAGING_QUERY_PARAM);
  } catch (e) { queryValue = null; }

  if (queryValue === '0') {
    try { window.sessionStorage && window.sessionStorage.removeItem(STAGING_SESSION_KEY); } catch (e) { /* ignore */ }
    return null;
  }

  let sessionActive = false;
  try { sessionActive = window.sessionStorage && window.sessionStorage.getItem(STAGING_SESSION_KEY) === '1'; } catch (e) { sessionActive = false; }

  if (queryValue === '1' || sessionActive) {
    try { window.sessionStorage && window.sessionStorage.setItem(STAGING_SESSION_KEY, '1'); } catch (e) { /* ignore */ }
    // Гигиена: не оставлять staging-маркер видимым в адресной строке/истории.
    if (queryValue !== null && window.history && typeof window.history.replaceState === 'function') {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete(STAGING_QUERY_PARAM);
        window.history.replaceState(window.history.state || {}, '', url.toString());
      } catch (e) { /* ignore — не критично */ }
    }
    return STAGING_API_BASE_URL;
  }
  return null;
}

const API_BASE_URL = resolveApiBaseUrl();
const USE_API = !!API_BASE_URL;
const IS_STAGING_MODE = API_BASE_URL === STAGING_API_BASE_URL;
const CREATE_ORDER_TIMEOUT_MS = 15000;

async function apiRequest(path, options = {}) {
  const {
    headers: optionHeaders = {}, timeoutMs = 0, signal: externalSignal, ...requestOptions
  } = options;
  const controller = timeoutMs > 0 && !externalSignal ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetch(API_BASE_URL + path, {
      ...requestOptions,
      signal: externalSignal || controller?.signal,
      headers: { 'Content-Type': 'application/json', ...optionHeaders },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка запроса: ${res.status}`);
      err.status = res.status; // нужно отличать однозначный 4xx от неизвестного сетевого результата
      throw err;
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error('Сервис отвечает слишком долго — повторите оформление заказа');
      timeoutError.isNetworkError = true;
      throw timeoutError;
    }
    throw err;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function orderAccessHeaders(orderAccessToken, createIdempotencyKey) {
  const headers = { Authorization: `Bearer ${orderAccessToken}` };
  if (createIdempotencyKey) headers['Idempotency-Key'] = createIdempotencyKey;
  return headers;
}

const api = {
  getRestaurants: (city) => apiRequest(`/api/restaurants?city=${encodeURIComponent(city)}`),
  getRestaurant: (id) => apiRequest(`/api/restaurants/${id}`),
  createOrder: (payload, orderAccessToken, createIdempotencyKey) => apiRequest('/api/orders', {
    method: 'POST',
    headers: orderAccessHeaders(orderAccessToken, createIdempotencyKey),
    body: JSON.stringify(payload),
    timeoutMs: CREATE_ORDER_TIMEOUT_MS,
  }),
  recoverOrder: (orderAccessToken, createIdempotencyKey) => apiRequest('/api/orders/recover', {
    method: 'POST',
    headers: orderAccessHeaders(orderAccessToken, createIdempotencyKey),
    timeoutMs: CREATE_ORDER_TIMEOUT_MS,
  }),
  getOrder: (code, token) => apiRequest(`/api/orders/${code}`, { headers: orderAccessHeaders(token) }),
  cancelOrder: (code, token) => apiRequest(`/api/orders/${code}/cancel`, {
    method: 'POST', headers: orderAccessHeaders(token),
  }),
  retryPayment: (code, token, retryIdempotencyKey) => apiRequest(`/api/orders/${code}/retry-payment`, {
    method: 'POST', headers: orderAccessHeaders(token, retryIdempotencyKey),
  }),
  rateOrder: (code, token, rating) => apiRequest(`/api/orders/${code}/rate`, {
    method: 'POST', headers: orderAccessHeaders(token), body: JSON.stringify({ rating }),
  }),
  devMarkPaid: (code, token) => apiRequest(`/api/orders/${code}/dev-confirm-payment`, {
    method: 'POST', headers: orderAccessHeaders(token),
  }),
};
