/**
 * Контракт платёжного провайдера. Любой провайдер (mock, ЮKassa, любой другой)
 * обязан реализовать ровно эти четыре метода с такими сигнатурами.
 * orderService и routes/api.js работают только через этот контракт и никогда
 * не знают, какой провайдер сейчас подключён — подключение нового провайдера
 * не требует правок ни в orderService, ни в API, ни в клиенте.
 *
 * Текущий provider contract предназначен для MVP: СБП + capture=true
 * (см. YAAM-payment-capture-model-ADR.pdf). При добавлении банковских карт
 * возможен отдельный ADR и расширение интерфейса.
 *
 * createPayment({orderId, amount, description, idempotencyKey})
 *   -> { providerPaymentId, qrPayload?, paymentUrl? }
 *   Создаёт платёж во внешней системе. qrPayload — то, что рисуем как QR
 *   (для СБП). paymentUrl (у ЮKassa это confirmation.confirmation_url) —
 *   единая ссылка на оплату: клиент использует ОДНУ и ту же ссылку и для
 *   кнопки "Оплата с этого устройства" (window.location.href=paymentUrl),
 *   и для QR — оплата с текущего телефона и с другого телефона по QR ведут
 *   на одну и ту же платёжную сессию. null/отсутствует, если у провайдера
 *   нет прямой ссылки (сейчас — mock). idempotencyKey обязателен: это устойчивый
 *   серверный ключ конкретной попытки, который реальный провайдер обязан передать
 *   в свой idempotency-заголовок, чтобы повтор не создавал второй внешний платёж.
 *
 * getStatus(providerPaymentId)
 *   -> 'pending' | 'succeeded' | 'failed'
 *   Опрос статуса (используется как запасной путь, если webhook не пришёл).
 *
 * refund(providerPaymentId, amount, idempotencyKey)
 *   -> { refundId, status: 'pending' | 'succeeded' | 'failed' }
 *   Полный возврат (частичные возвраты вне MVP). idempotencyKey обязателен —
 *   тот же принцип, что у createPayment: устойчивый серверный ключ конкретной
 *   попытки возврата, реальный провайдер обязан передать его в свой
 *   idempotency-заголовок, чтобы повтор (после таймаута/обрыва связи) не создал
 *   второй реальный возврат денег.
 *
 * getRefund(providerRefundId, expected?)
 *   -> 'pending' | 'succeeded' | 'failed'
 *   Читает канонический статус уже созданного возврата. expected может
 *   содержать providerPaymentId/amount для defense-in-depth сверки ответа.
 *
 * verifyWebhook(rawBody, headers)
 *   -> Promise<{ providerPaymentId, status, amount?, currency? } | null>
 *   Устанавливает подлинность вебхука и возвращает нормализованное событие.
 *   Возвращает null, если подлинность/структуру подтвердить не удалось —
 *   вызывающий код обязан ответить 400 (fail closed, не обрабатывать).
 *   Production Switch — Stage 8: у ЮKassa нет HMAC/подписи вебхука (см.
 *   официальную документацию, YookassaProvider.verifyWebhook()) — реальная
 *   проверка подлинности требует сетевого запроса (канонический lookup
 *   объекта по его id через тот же авторизованный API), поэтому метод
 *   асинхронный. amount/currency в возвращаемом событии — то, что заявляет
 *   САМО тело уведомления (уже прошедшее структурную/каноническую проверку
 *   status'а внутри provider'а) — вызывающий код (webhook route) обязан
 *   дополнительно сверить их с суммой сохранённого платежа ПЕРЕД тем, как
 *   доверять событию (provider не знает про нашу БД).
 */
class PaymentProviderInterface {
  async createPayment(_params) { throw new Error('not implemented'); }
  async getStatus(_providerPaymentId) { throw new Error('not implemented'); }
  async refund(_providerPaymentId, _amount, _idempotencyKey) { throw new Error('not implemented'); }
  async getRefund(_providerRefundId, _expected) { throw new Error('not implemented'); }
  async verifyWebhook(_rawBody, _headers) { throw new Error('not implemented'); }
}

module.exports = PaymentProviderInterface;
