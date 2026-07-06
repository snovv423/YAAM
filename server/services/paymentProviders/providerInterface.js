/**
 * Контракт платёжного провайдера. Любой провайдер (mock, ЮKassa, любой другой)
 * обязан реализовать ровно эти четыре метода с такими сигнатурами.
 * orderService и routes/api.js работают только через этот контракт и никогда
 * не знают, какой провайдер сейчас подключён — подключение нового провайдера
 * не требует правок ни в orderService, ни в API, ни в клиенте.
 *
 * createPayment({orderId, amount, description})
 *   -> { providerPaymentId, qrPayload?, redirectUrl? }
 *   Создаёт платёж во внешней системе. qrPayload — то, что рисуем как QR
 *   (для СБП), redirectUrl — если провайдер вместо QR даёt ссылку на оплату.
 *
 * getStatus(providerPaymentId)
 *   -> 'pending' | 'succeeded' | 'failed'
 *   Опрос статуса (используется как запасной путь, если webhook не пришёл).
 *
 * refund(providerPaymentId, amount)
 *   -> { refundId, status: 'succeeded' | 'failed' }
 *   Частичный или полный возврат.
 *
 * verifyWebhook(rawBody, headers)
 *   -> { providerPaymentId, status } | null
 *   Проверяет подпись/подлинность вебхука и возвращает нормализованное событие.
 *   Возвращает null, если подпись невалидна — вызывающий код обязан ответить 400.
 */
class PaymentProviderInterface {
  async createPayment(_params) { throw new Error('not implemented'); }
  async getStatus(_providerPaymentId) { throw new Error('not implemented'); }
  async refund(_providerPaymentId, _amount) { throw new Error('not implemented'); }
  verifyWebhook(_rawBody, _headers) { throw new Error('not implemented'); }
}

module.exports = PaymentProviderInterface;
