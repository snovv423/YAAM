// Публичный yaam.su всегда работает с production API. В браузере нет
// fallback на demo/staging: пустой ответ и ошибка API отображаются честно.
//
// Адрес — обычная константа, а НЕ переключатель, читающий window. Раньше здесь
// жила пара тестовых window-глобалов (флаг режима + адрес): механика,
// существовавшая исключительно ради тестов, но уезжавшая в публичный бандл и
// позволявшая переназначить endpoint прямо из рантайма страницы. Теперь адрес
// подменяет тестовая обвязка, переписывая строку ниже при ЗАГРУЗКЕ файла, и
// живёт она вне production-артефакта:
//   client/test/helpers/loadApp.js   — node:vm unit-тесты;
//   e2e/fixtures/test-api-hook.ts    — Playwright (через static-сервер).
// Обе подстановки fail-closed: если этот литерал переименуют, обвязка упадёт,
// а не начнёт молча гонять тесты против production (см. e2eTestApiHookContract).
const API_BASE_URL = 'https://api.yaam.su';
const USE_API = !!API_BASE_URL;
const IS_STAGING_MODE = false;
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
      // Машиночитаемый код отказа. Нужен там, где одного HTTP-статуса мало:
      // 503 от приложения (гейт, стоящий ДО любой записи) и 503 от
      // промежуточного слоя после отправки запроса — разные ситуации, а
      // статус у них один. См. isDeterministicRefusal() в app.js.
      if (typeof data.code === 'string') err.code = data.code;
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
  // "Кого ждём" — список кандидатов для голосования, управляемый из HQ
  // (после Stage 28, раздел 2). В demo-режиме (USE_API=false) не
  // вызывается вовсе — см. renderVote() в app.js, fallback на
  // CANDIDATE_RESTAURANTS из data.js.
  getRestaurantCandidates: () => apiRequest('/api/restaurant-candidates'),
  // Текст на главной — редактируется владельцем в HQ, в клиенте не хранится.
  getHomeContent: () => apiRequest('/api/home-content'),
  // Stage 29.1, п.3 — реальный приём голоса. deviceId — анонимный
  // localStorage-идентификатор устройства (см. getVoterDeviceId() в
  // app.js), НЕ персональные данные.
  voteRestaurantCandidate: (candidateId, deviceId) => apiRequest(`/api/restaurant-candidates/${candidateId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  }),
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
  // Stage 33 — «Заказ получен»: подтверждение физического получения заказа
  // клиентом (courier -> delivered). Тот же order access token, что и у
  // cancel/rate выше, никакого нового способа авторизации.
  confirmOrderReceipt: (code, token) => apiRequest(`/api/orders/${code}/confirm-receipt`, {
    method: 'POST', headers: orderAccessHeaders(token),
  }),
  devMarkPaid: (code, token) => apiRequest(`/api/orders/${code}/dev-confirm-payment`, {
    method: 'POST', headers: orderAccessHeaders(token),
  }),
  // Фича «Поделиться заказом»: shareToken передаётся заголовком (не телом),
  // тем же принципом, что и остальные секреты в этом файле — сервер
  // регистрирует его read-only capability для заказа (см. orderShareService.js).
  createShareLink: (code, orderAccessToken, newShareToken) => apiRequest(`/api/orders/${code}/share`, {
    method: 'POST',
    headers: { ...orderAccessHeaders(orderAccessToken), 'X-Share-Token': newShareToken },
  }),
  getSharedOrder: (code, shareToken) => apiRequest(`/api/orders/${code}/shared`, {
    headers: { Authorization: `Bearer ${shareToken}` },
  }),
};
