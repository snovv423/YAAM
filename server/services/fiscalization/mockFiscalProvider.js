'use strict';

// Mock-адаптер фискализации — ТОЛЬКО для тестов и локальной разработки.
//
// Реальная касса не подключена и в этой ветке не подключается. Адаптер не
// делает никаких сетевых вызовов: он лишь подтверждает, что модель чеков
// (создание, идемпотентность, повтор, терминальные статусы) работает.
//
// Поведение управляется конструктором, чтобы тест мог воспроизвести отказ и
// восстановление, не подменяя внутренности сервиса.
const crypto = require('node:crypto');
const { FiscalProviderError } = require('./fiscalProviderInterface');

class MockFiscalProvider {
  // failTimes — сколько первых вызовов упадут (проверка retry);
  // retryable — считать ли эти отказы временными;
  // asyncMode — возвращать 'processing' вместо 'succeeded' (проверка опроса).
  constructor({ failTimes = 0, retryable = true, asyncMode = false } = {}) {
    this.name = 'mock';
    this.failTimes = failTimes;
    this.retryable = retryable;
    this.asyncMode = asyncMode;
    this.calls = [];
    // Идемпотентность на стороне «провайдера»: повторный вызов с тем же
    // ключом обязан вернуть ТОТ ЖЕ чек, а не создать второй. Настоящие
    // фискальные API ведут себя так же, и тест должен это видеть.
    this.byIdempotencyKey = new Map();
  }

  async send({ idempotencyKey, kind, payload }) {
    this.calls.push({ idempotencyKey, kind, payload });

    if (this.byIdempotencyKey.has(idempotencyKey)) {
      return this.byIdempotencyKey.get(idempotencyKey);
    }
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new FiscalProviderError('mock: временный отказ фискализации', {
        retryable: this.retryable, providerCode: 'mock_failure',
      });
    }

    const result = {
      providerReceiptId: `mock-rcpt-${crypto.randomBytes(8).toString('hex')}`,
      status: this.asyncMode ? 'processing' : 'succeeded',
    };
    this.byIdempotencyKey.set(idempotencyKey, result);
    return result;
  }

  async getStatus(providerReceiptId) {
    return { providerReceiptId, status: 'succeeded' };
  }
}

module.exports = MockFiscalProvider;
