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
  }

  async createPayment({ orderId, amount }) {
    const providerPaymentId = `mock_${orderId}_${crypto.randomBytes(4).toString('hex')}`;
    this.payments.set(providerPaymentId, { status: 'pending', amount });
    return {
      providerPaymentId,
      qrPayload: `yaam-demo://pay/${providerPaymentId}/${amount}`,
      // Явно null, а не просто отсутствует — mock не умеет открывать банк
      // напрямую, у него нет настоящей платёжной страницы. Клиент (см.
      // currentPaymentUrl/payFromThisPhone в client/js/app.js) по этому null
      // заставляет кнопку "Оплата с этого устройства" выполнять demo-оплату,
      // а не фейковую ссылку, которая выглядела бы как реальная оплата.
      paymentUrl: null,
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
