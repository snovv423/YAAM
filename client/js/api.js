// Мост между статикой (GitHub Pages) и реальным бэкендом (server/).
// Пока API_BASE_URL не задан — сайт работает как раньше, на демо-данных
// из data.js и локальной имитации оплаты/статусов. Как только бэкенд
// задеплоен, впишите его адрес сюда (или через window.YAAM_API_BASE_URL
// до подключения этого файла) — сайт сам переключится на реальные данные,
// правки в остальном коде не нужны.
const API_BASE_URL = window.YAAM_API_BASE_URL || null;
const USE_API = !!API_BASE_URL;

async function apiRequest(path, options) {
  const res = await fetch(API_BASE_URL + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка запроса: ${res.status}`);
  return data;
}

const api = {
  getRestaurants: (city) => apiRequest(`/api/restaurants?city=${encodeURIComponent(city)}`),
  getRestaurant: (id) => apiRequest(`/api/restaurants/${id}`),
  createOrder: (payload) => apiRequest('/api/orders', { method: 'POST', body: JSON.stringify(payload) }),
  getOrder: (code) => apiRequest(`/api/orders/${code}`),
  cancelOrder: (code) => apiRequest(`/api/orders/${code}/cancel`, { method: 'POST' }),
  retryPayment: (code) => apiRequest(`/api/orders/${code}/retry-payment`, { method: 'POST' }),
  rateOrder: (code, rating) => apiRequest(`/api/orders/${code}/rate`, { method: 'POST', body: JSON.stringify({ rating }) }),
  devMarkPaid: (providerPaymentId) => apiRequest(`/api/dev/pay/${providerPaymentId}`, { method: 'POST' }),
};
