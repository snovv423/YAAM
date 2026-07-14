// Мост между статикой (GitHub Pages) и реальным бэкендом (server/).
// Пока API_BASE_URL не задан — сайт работает как раньше, на демо-данных
// из data.js и локальной имитации оплаты/статусов. Как только бэкенд
// задеплоен, впишите его адрес сюда (или через window.YAAM_API_BASE_URL
// до подключения этого файла) — сайт сам переключится на реальные данные,
// правки в остальном коде не нужны.
const API_BASE_URL = window.YAAM_API_BASE_URL || null;
const USE_API = !!API_BASE_URL;

async function apiRequest(path, options = {}) {
  const { headers: optionHeaders = {}, ...requestOptions } = options;
  const res = await fetch(API_BASE_URL + path, {
    ...requestOptions,
    headers: { 'Content-Type': 'application/json', ...optionHeaders },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка запроса: ${res.status}`);
    err.status = res.status; // нужно отличать "заказ не найден" (404, не ретраить) от сетевого сбоя
    throw err;
  }
  return data;
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
