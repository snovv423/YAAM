const crypto = require('node:crypto');
const PaymentProviderInterface = require('./providerInterface');

// Провайдер для демо/разработки, пока не подключена ЮKassa.
// Платёж "оплачивается" вручную через POST /api/dev/pay/:providerPaymentId
// (см. routes/api.js) — это прямой аналог кнопки "Демо: оплата прошла" в клиенте,
// просто теперь решение принимает сервер, а не браузер.
class MockProvider extends PaymentProviderInterface {
  constructor() {
    super();
    this.payments = new Map(); // providerPaymentId -> {status, amount}
  }

  async createPayment({ orderId, amount }) {
    const providerPaymentId = `mock_${orderId}_${crypto.randomBytes(4).toString('hex')}`;
    this.payments.set(providerPaymentId, { status: 'pending', amount });
    return {
      providerPaymentId,
      qrPayload: `yaam-demo://pay/${providerPaymentId}/${amount}`,
    };
  }

  async getStatus(providerPaymentId) {
    const p = this.payments.get(providerPaymentId);
    return p ? p.status : 'failed';
  }

  async refund(providerPaymentId, amount) {
    const p = this.payments.get(providerPaymentId);
    if (!p) return { refundId: null, status: 'failed' };
    p.status = 'refunded';
    return { refundId: `refund_${providerPaymentId}`, status: 'succeeded' };
  }

  // Мок не получает настоящие webhook'и по HTTP — вызывается напрямую из dev-роута.
  verifyWebhook(rawBody) {
    try {
      const event = JSON.parse(rawBody);
      return { providerPaymentId: event.providerPaymentId, status: event.status };
    } catch {
      return null;
    }
  }

  // Только для dev-роута — не часть интерфейса, реальные провайдеры этого метода не имеют.
  _devMarkPaid(providerPaymentId, outcome = 'succeeded') {
    const p = this.payments.get(providerPaymentId);
    if (!p) return false;
    p.status = outcome;
    return true;
  }
}

module.exports = MockProvider;
