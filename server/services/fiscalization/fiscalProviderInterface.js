'use strict';

// YAAM — интерфейс провайдера фискализации (54-ФЗ).
//
// ЗАЧЕМ ИНТЕРФЕЙС, А НЕ СРАЗУ ИНТЕГРАЦИЯ. Кто именно обязан пробивать чек в
// агентской модели YAAM (агент или поставщик-ресторан) и какие реквизиты
// поставщика обязаны быть в чеке — вопрос юридический, и он НЕ решён
// (BLOCKED LEGAL, см. отчёт Stage 14). Пока ответа нет, единственное честное
// техническое решение — граница: приложение умеет формировать, хранить и
// повторять чек, но конкретный провайдер за этой границей не выбран.
//
// Реальная касса НЕ подключается. В проекте есть только mock-адаптер.
//
// Контракт (все методы асинхронные):
//   send({ idempotencyKey, kind, payload }) -> { providerReceiptId, status }
//     status: 'succeeded' | 'processing' | 'failed'
//   getStatus(providerReceiptId) -> { status, providerReceiptId }
//
// Ошибки провайдера обязаны выбрасываться как FiscalProviderError с полем
// `retryable`: временный сбой (сеть, 5xx, лимит) отличается от отказа по
// существу (неверный payload) — повторять второе бессмысленно.

class FiscalProviderError extends Error {
  constructor(message, { retryable = false, providerCode = null } = {}) {
    super(message);
    this.name = 'FiscalProviderError';
    this.retryable = retryable;
    this.providerCode = providerCode;
  }
}

// Проверка, что объект действительно реализует контракт. Вызывается при
// регистрации адаптера: молча получить undefined из send() хуже, чем упасть
// на старте.
function assertFiscalProvider(provider) {
  if (!provider || typeof provider.send !== 'function' || typeof provider.getStatus !== 'function') {
    throw new Error('Fiscal provider must implement send() and getStatus()');
  }
  return provider;
}

module.exports = { FiscalProviderError, assertFiscalProvider };
