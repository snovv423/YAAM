/**
 * Контракт платёжного провайдера. Любой провайдер (mock, ЮKassa, любой другой)
 * обязан реализовать ровно эти четыре метода с такими сигнатурами.
 * orderService и routes/api.js работают только через этот контракт и никогда
 * не знают, какой провайдер сейчас подключён — подключение нового провайдера
 * не требует правок ни в orderService, ни в API, ни в клиенте.
 *
 * createPayment({orderId, amount, description, idempotencyKey?})
 *   -> { providerPaymentId, qrPayload?, paymentUrl? }
 *   Создаёт платёж во внешней системе. qrPayload — то, что рисуем как QR
 *   (для СБП). paymentUrl (у ЮKassa это confirmation.confirmation_url) —
 *   единая ссылка на оплату: клиент использует ОДНУ и ту же ссылку и для
 *   кнопки "Оплата с этого устройства" (window.location.href=paymentUrl),
 *   и для QR — оплата с текущего телефона и с другого телефона по QR ведут
 *   на одну и ту же платёжную сессию. null/отсутствует, если у провайдера
 *   нет прямой ссылки (сейчас — mock). idempotencyKey — устойчивый серверный
 *   ключ конкретной попытки: реальный провайдер обязан передать его в свой
 *   idempotency-заголовок, чтобы повтор не создавал второй внешний платёж.
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
