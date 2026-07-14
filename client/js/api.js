// Мост между статикой (GitHub Pages) и реальным бэкендом (server/).
// Пока API_BASE_URL не задан — сайт работает как раньше, на демо-данных
// из data.js и локальной имитации оплаты/статусов. Как только бэкенд
// задеплоен, впишите его адрес сюда (или через window.YAAM_API_BASE_URL
// до подключения этого файла) — сайт сам переключится на реальные данные,
// правки в остальном коде не нужны.
const API_BASE_URL = window.YAAM_API_BASE_URL || null;
const USE_API = !!API_BASE_URL;
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
