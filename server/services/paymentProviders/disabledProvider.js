'use strict';

class PaymentProviderDisabledError extends Error {
  constructor() {
    super('Платёжный провайдер отключён');
    this.name = 'PaymentProviderDisabledError';
    this.code = 'PAYMENT_PROVIDER_DISABLED';
    this.statusCode = 503;
  }
}

// Fail-closed provider for the production foundation. It never performs
// network I/O and never fabricates provider identifiers or success states.
class DisabledProvider {
  async createPayment() { throw new PaymentProviderDisabledError(); }
  async getStatus() { throw new PaymentProviderDisabledError(); }
  async refund() { throw new PaymentProviderDisabledError(); }
  async getRefund() { throw new PaymentProviderDisabledError(); }
  async verifyWebhook() { throw new PaymentProviderDisabledError(); }
}

module.exports = DisabledProvider;
module.exports.PaymentProviderDisabledError = PaymentProviderDisabledError;
