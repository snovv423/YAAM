const crypto = require('node:crypto');
const PaymentProviderInterface = require('./providerInterface');

// Провайдер для демо/разработки, пока не подключена ЮKassa.
// Платёж "оплачивается" вручную через защищённый маршрут заказа
// POST /api/orders/:code/dev-confirm-payment (см. routes/api.js). Внутренний
// providerPaymentId наружу не публикуется; сервер выбирает попытку сам после
// проверки bearer-токена заказа.
class MockProvider extends PaymentProviderInterface {
  constructor() {
    super();
    this.payments = new Map(); // providerPaymentId -> {status, amount}
    // Демо-провайдер дедуплицирует параллельные/повторные вызовы в рамках
    // процесса. После рестарта mock может забыть эту карту — реальных денег
    // здесь нет; production-провайдер обязан хранить idempotency у себя.
    this.idempotentPayments = new Map(); // idempotencyKey -> {orderId, amount, result}
    this.idempotentRefunds = new Map(); // idempotencyKey -> {providerPaymentId, amount, result}
  }

  async createPayment({ orderId, amount, idempotencyKey }) {
    if (idempotencyKey) {
      const existing = this.idempotentPayments.get(idempotencyKey);
      if (existing) {
        if (existing.orderId !== orderId || existing.amount !== amount) {
          throw new Error('ключ идемпотентности уже использован для другого платежа');
        }
        return { ...existing.result };
      }
    }
    const providerPaymentId = `mock_${orderId}_${crypto.randomBytes(4).toString('hex')}`;
    this.payments.set(providerPaymentId, { status: 'pending', amount });
    const result = {
      providerPaymentId,
      qrPayload: `yaam-demo://pay/${providerPaymentId}/${amount}`,
      // Явно null, а не просто отсутствует — mock не умеет открывать банк
      // напрямую, у него нет настоящей платёжной страницы. Клиент (см.
      // currentPaymentUrl/payFromThisPhone в client/js/app.js) по этому null
      // заставляет кнопку "Оплата с этого устройства" выполнять demo-оплату,
      // а не фейковую ссылку, которая выглядела бы как реальная оплата.
      paymentUrl: null,
    };
    if (idempotencyKey) this.idempotentPayments.set(idempotencyKey, { orderId, amount, result });
    return { ...result };
  }

  async getStatus(providerPaymentId) {
    const p = this.payments.get(providerPaymentId);
    return p ? p.status : 'failed';
  }

  async refund(providerPaymentId, amount, idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      throw new Error('idempotencyKey обязателен для возврата (mock-провайдер)');
    }
    const existing = this.idempotentRefunds.get(idempotencyKey);
    if (existing) {
      if (existing.providerPaymentId !== providerPaymentId || existing.amount !== amount) {
        throw new Error('ключ идемпотентности уже использован для другого возврата');
      }
      return { ...existing.result };
    }
    const p = this.payments.get(providerPaymentId);
    const result = p
      ? { refundId: `refund_${providerPaymentId}_${crypto.randomBytes(4).toString('hex')}`, status: 'succeeded' }
      : { refundId: null, status: 'failed' };
    if (p) p.status = 'refunded';
    this.idempotentRefunds.set(idempotencyKey, { providerPaymentId, amount, result });
    return { ...result };
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
