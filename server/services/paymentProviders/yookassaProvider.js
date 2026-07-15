const PaymentProviderInterface = require('./providerInterface');

/**
 * ЮKassa, маркетплейс-схема со сплитом (7% YAAM / 93% ресторан).
 * НЕ РЕАЛИЗОВАНО — заготовка контракта. Когда будете готовы подключать:
 *
 * 1. Зарегистрировать ресторан как sub-merchant в ЮKassa (нужен ИНН, реквизиты).
 *    Хранить его merchant_id в restaurants.provider_merchant_id (добавить колонку).
 * 2. createPayment: POST https://api.yookassa.ru/v3/payments с
 *    payment_method_data, confirmation.type='qr' (для СБП), и полем
 *    transfers: [{ account_id: restaurantMerchantId, amount: {value: 93%} }]
 *    — сплит настраивается прямо в запросе создания платежа.
 * 3. verifyWebhook: ЮKassa шлёт уведомления на ваш URL; проверяется по
 *    IP-списку ЮKassa либо по Basic Auth, который вы задаёте в личном кабинете
 *    (см. docs ЮKassa "Уведомления"). Здесь просто message заглушки.
 * 4. refund: POST /v3/refunds с amount и payment_id.
 *
 * Ключи (Shop ID + Secret Key) — через переменные окружения
 * YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY, никогда не в коде.
 */
class YookassaProvider extends PaymentProviderInterface {
  constructor() {
    super();
    if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
      throw new Error(
        'YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не заданы. ' +
        'ЮKassa-провайдер ещё не реализован — см. комментарий в начале файла.'
      );
    }
    throw new Error('YookassaProvider не реализован. Используйте PAYMENT_PROVIDER=mock.');
  }

  async createPayment(_params) { throw new Error('not implemented'); }
  async getStatus(_providerPaymentId) { throw new Error('not implemented'); }
  async refund(_providerPaymentId, _amount, _idempotencyKey) { throw new Error('not implemented'); }
  verifyWebhook(_rawBody, _headers) { throw new Error('not implemented'); }
}

module.exports = YookassaProvider;
