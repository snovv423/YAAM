const MockProvider = require('./paymentProviders/mockProvider');

// Единая точка входа для оплаты. orderService и routes/api.js вызывают только
// эти функции — какой провайдер сейчас активен, решает переменная окружения
// PAYMENT_PROVIDER (mock | yookassa), больше нигде в коде это не завязано.
function loadProvider() {
  const name = process.env.PAYMENT_PROVIDER || 'mock';
  if (name === 'yookassa') {
    const YookassaProvider = require('./paymentProviders/yookassaProvider');
    return new YookassaProvider();
  }
  return new MockProvider();
}

const provider = loadProvider();
const YAAM_COMMISSION_RATE = 0.07;

function calcCommission(itemsTotal) {
  return Math.round(itemsTotal * YAAM_COMMISSION_RATE);
}

async function createPayment({ orderId, amount, description, idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
    throw new Error('provider idempotency key обязателен для создания платежа');
  }
  return provider.createPayment({ orderId, amount, description, idempotencyKey });
}

async function getPaymentStatus(providerPaymentId) {
  return provider.getStatus(providerPaymentId);
}

async function refundPayment(providerPaymentId, amount, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
    throw new Error('provider idempotency key обязателен для возврата');
  }
  return provider.refund(providerPaymentId, amount, idempotencyKey);
}

// Production Switch — Stage 8: провайдер верифицирует вебхук асинхронно
// (канонический lookup у ЮKassa — сетевой вызов, см.
// paymentProviders/yookassaProvider.js) — эта обёртка теперь тоже
// асинхронна, вызывающий код (routes/api.js, routes/postgresql/api.js)
// обязан await её.
async function verifyWebhook(rawBody, headers) {
  return provider.verifyWebhook(rawBody, headers);
}

// Только для dev/mock-режима — реального аналога у ЮKassa нет,
// у неё платит настоящий банк по QR. Используется demo-роутом.
function devMarkPaid(providerPaymentId, outcome) {
  if (typeof provider._devMarkPaid !== 'function') {
    throw new Error('devMarkPaid доступен только у mock-провайдера');
  }
  return provider._devMarkPaid(providerPaymentId, outcome);
}

module.exports = {
  createPayment,
  getPaymentStatus,
  refundPayment,
  verifyWebhook,
  devMarkPaid,
  calcCommission,
  YAAM_COMMISSION_RATE,
  providerName: process.env.PAYMENT_PROVIDER || 'mock',
};
