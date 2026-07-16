// Provider Error Taxonomy — единая внутренняя классификация ответов/ошибок
// платёжного провайдера (HTTP-транспортный уровень), подготовленная ДО
// написания реального YookassaProvider (MVP: только СБП, capture=true).
//
// Reuse first (см. YAAM-Comparative-Architecture-Research.pdf): не изобретена
// с нуля — форма (небольшой enum retryable/fatal/unknown + правила на
// категорию) независимо подтверждена четырьмя источниками: Stripe (7 типов
// ошибок в проде на большом масштабе), Adyen, Medusa.js (provider возвращает
// action/классификацию, а не сам меняет состояние — тот же принцип, что и
// verifyWebhook() в providerInterface.js) и обобщающей статьёй "Designing a
// Payment System" (retry vs dead-letter). Существующий в YAAM паттерн —
// refunds.last_error_code CHECK-enum (server/db/schema.sql) — НЕ расширяется
// и не заменяется этим модулем: last_error_code фиксирует ПРИЧИНУ уже
// случившегося неуспеха конкретной попытки возврата (бизнес-факт в БД), а
// этот модуль — чистая классификация СЕЙЧАС происходящего HTTP-ответа/сбоя,
// нужная ДО того, как решение о повторе/reconciliation вообще принято. Разные
// уровни абстракции, поэтому отдельный модуль, а не миграция существующего.
//
// Модуль сознательно НЕ содержит сетевого кода и не знает про конкретного
// провайдера — принимает уже нормализованные признаки ответа (см. JSDoc
// classifyProviderError ниже), поэтому пригоден и для mock, и для будущего
// реального YookassaProvider без изменений.
//
// Пока НЕ используется ни в orderService.js, ни где-либо ещё в runtime —
// это подготовительная инфраструктура (Phase 1 из дорожной карты
// YAAM-Yookassa-Architecture-Audit.pdf), намеренно не подключённая к
// действующей бизнес-логике заказов/платежей/возвратов в этой задаче.

const CATEGORIES = Object.freeze({
  RETRYABLE: 'retryable',
  RATE_LIMITED: 'rate_limited',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  FATAL_REQUEST: 'fatal_request',
  FATAL_CONFIGURATION: 'fatal_configuration',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  UNKNOWN_RESULT: 'unknown_result',
  MANUAL_REVIEW: 'manual_review',
});

// Правила на категорию — прямое отражение таблицы из Этапа 4
// YAAM-Yookassa-Provider-Error-Taxonomy-Research.pdf. Формат данных (объект
// вместо отдельных функций-хелперов на каждое свойство) — сознательно
// минимальный: одна таблица соответствий, без лишней инфраструктуры.
//
//   retryable            — можно ли вообще повторять операцию
//   sameIdempotencyKey    — при повторе использовать тот же ключ (true) или
//                           обязательно новый (false, только после
//                           исправления payload — см. FATAL_REQUEST и вывод
//                           из Stripe error-low-level: тот же ключ у
//                           провайдера, скорее всего, просто вернёт тот же
//                           закэшированный ответ повторно)
//   needsGetBeforeRetry   — нужна ли сверка текущего состояния объекта у
//                           провайдера (GET) ПЕРЕД повтором, а не вслепую
//   needsReconciliation   — должна ли запись попасть в reconciliation-цикл
//   needsManualReview     — требует ли категория остановки автоматики и
//                           передачи человеку
const CATEGORY_RULES = Object.freeze({
  [CATEGORIES.RETRYABLE]: Object.freeze({
    retryable: true, sameIdempotencyKey: true, needsGetBeforeRetry: false,
    needsReconciliation: false, needsManualReview: false,
  }),
  [CATEGORIES.RATE_LIMITED]: Object.freeze({
    retryable: true, sameIdempotencyKey: true, needsGetBeforeRetry: false,
    needsReconciliation: false, needsManualReview: false,
  }),
  [CATEGORIES.PROVIDER_UNAVAILABLE]: Object.freeze({
    retryable: true, sameIdempotencyKey: true, needsGetBeforeRetry: true,
    needsReconciliation: true, needsManualReview: false,
  }),
  [CATEGORIES.FATAL_REQUEST]: Object.freeze({
    retryable: false, sameIdempotencyKey: false, needsGetBeforeRetry: false,
    needsReconciliation: false, needsManualReview: false,
  }),
  [CATEGORIES.FATAL_CONFIGURATION]: Object.freeze({
    retryable: false, sameIdempotencyKey: false, needsGetBeforeRetry: false,
    needsReconciliation: false, needsManualReview: true,
  }),
  [CATEGORIES.NOT_FOUND]: Object.freeze({
    retryable: true, sameIdempotencyKey: true, needsGetBeforeRetry: false,
    needsReconciliation: true, needsManualReview: false,
  }),
  [CATEGORIES.CONFLICT]: Object.freeze({
    retryable: false, sameIdempotencyKey: true, needsGetBeforeRetry: false,
    needsReconciliation: false, needsManualReview: false,
  }),
  [CATEGORIES.UNKNOWN_RESULT]: Object.freeze({
    retryable: true, sameIdempotencyKey: true, needsGetBeforeRetry: true,
    needsReconciliation: true, needsManualReview: false,
  }),
  [CATEGORIES.MANUAL_REVIEW]: Object.freeze({
    retryable: false, sameIdempotencyKey: false, needsGetBeforeRetry: false,
    needsReconciliation: false, needsManualReview: true,
  }),
});

/**
 * Классифицирует один наблюдаемый HTTP-ответ/сбой провайдера в одну из
 * категорий taxonomy. Чистая функция — не делает сетевых вызовов, не знает
 * про orderService/БД.
 *
 * @param {object} params
 * @param {number|null} [params.httpStatus] — HTTP-код ответа провайдера,
 *   если он вообще был получен (null/undefined, если запрос не дошёл).
 * @param {boolean} [params.isNetworkError] — сбой на транспортном уровне
 *   (connection reset, DNS failure, TLS failure) — ответа не было вообще.
 * @param {boolean} [params.isTimeout] — наш собственный таймаут ожидания
 *   ответа (см. createPaymentWithTimeout/refundPaymentWithTimeout в
 *   orderService.js) — провайдер мог успеть обработать запрос, мы не знаем.
 * @param {boolean} [params.isMalformed] — ответ получен, но не парсится или
 *   не содержит ожидаемых полей.
 * @param {boolean} [params.isMutatingOperation] — true для createPayment/
 *   createRefund (операция МОГЛА изменить состояние на стороне провайдера
 *   несмотря на неудачный ответ); false для getPayment/getRefund (чтение —
 *   неудача не создаёт двусмысленности вокруг мутации состояния).
 *   Это уточнение относительно черновой матрицы из Этапа 5
 *   YAAM-Yookassa-Provider-Error-Taxonomy-Research.pdf: там timeout на
 *   createPayment (сценарий 1) был отдельно помечен RETRYABLE, а 500 на
 *   createPayment (сценарий 2) — UNKNOWN_RESULT, хотя оба структурно
 *   одинаково неоднозначны (провайдер мог успеть создать платёж). Здесь это
 *   сведено к единому, более строгому правилу: ЛЮБАЯ транспортная
 *   неопределённость (timeout, network error, 5xx) на МУТИРУЮЩЕЙ операции —
 *   всегда UNKNOWN_RESULT (обязательна GET-сверка перед повтором); та же
 *   неопределённость на операции чтения — RETRYABLE (нечего сверять, просто
 *   повторить запрос на чтение).
 * @returns {string} одно из значений CATEGORIES
 */
function classifyProviderError({
  httpStatus = null,
  isNetworkError = false,
  isTimeout = false,
  isMalformed = false,
  isMutatingOperation = false,
} = {}) {
  // Malformed — провайдер ответил, но доверять содержимому нельзя вообще,
  // независимо от того, была ли это мутирующая операция или чтение.
  if (isMalformed) return CATEGORIES.UNKNOWN_RESULT;

  const isAmbiguousTransportFailure = isNetworkError || isTimeout
    || (Number.isInteger(httpStatus) && httpStatus >= 500);
  if (isAmbiguousTransportFailure) {
    return isMutatingOperation ? CATEGORIES.UNKNOWN_RESULT : CATEGORIES.RETRYABLE;
  }

  if (httpStatus === 429) return CATEGORIES.RATE_LIMITED;
  if (httpStatus === 401 || httpStatus === 403) return CATEGORIES.FATAL_CONFIGURATION;
  if (httpStatus === 400 || httpStatus === 415) return CATEGORIES.FATAL_REQUEST;
  if (httpStatus === 404) return CATEGORIES.NOT_FOUND;
  if (httpStatus === 409) return CATEGORIES.CONFLICT;

  // Неизвестный/недокументированный HTTP-код (провайдер прислал что-то, чего
  // нет в официальной документации) — fail-safe default, НЕ считать успехом
  // и не пытаться угадать; тот же принцип, что уже используется в
  // ensureRefundReady() (orderService.js) для неизвестного provider-статуса.
  return CATEGORIES.UNKNOWN_RESULT;
}

// Единственная реальная НОВАЯ error-class этой задачи (остальные категории
// естественно укладываются в уже существующие 503/500/409-паттерны
// orderService.js — см. YAAM-Yookassa-Provider-Error-Taxonomy-Research.pdf,
// Этап 6). Публичное сообщение сознательно не содержит деталей провайдера.
class ProviderResultUnknownError extends Error {
  constructor(context) {
    super('Не удалось безопасно определить результат операции провайдера');
    this.name = 'ProviderResultUnknownError';
    this.category = CATEGORIES.UNKNOWN_RESULT;
    // context — только безопасные для лога поля (имя операции, id попытки и
    // т.п.), НИКОГДА не сырой ответ провайдера и не секреты. Вызывающий код
    // отвечает за то, что сюда попадает — этот класс сам ничего не логирует.
    this.context = context;
  }
}

// assertMatchingProviderObject — найдено по результатам независимого
// pre-push review getStatus() (YAAM-yookassa-getstatus-final-review-and-push-report.pdf,
// находка M1): getStatus() проверял форму ответа (id — непустая строка,
// status — строка), но НЕ проверял, что ответ вообще относится к
// ЗАПРОШЕННОМУ объекту (response.id === requestedId). Реальный сценарий: если
// провайдер/сеть/инфраструктура когда-либо вернут данные ДРУГОГО платежа —
// код молча принял бы чужой статус за статус своего.
//
// Research перед кодом (см. отчёт): ни ЮKassa, ни Stripe, ни Adyen НЕ
// документируют это как формальное требование контракта API — это не
// vendor-специфичная фича, а общий defensive engineering принцип, применяемый
// именно потому, что ни один из них не даёт message-level подписи для
// обычных REST-ответов (только TLS-транспорт + Basic Auth на исходящий
// запрос — сам ответ ничем не подписан и не привязан к конкретному
// запрошенному id на уровне протокола). Ближайшая параллель — принцип
// "не доверяй объекту, не подтвердив его идентичность" (confused deputy
// defense) и уже применённый в этом проекте паттерн Medusa.js: оркестрирующий
// слой сам обязан сопоставить любой provider-ответ/событие с ожидаемой
// сущностью ПЕРЕД тем, как на него полагаться — не провайдер это гарантирует.
//
// Спроектирован как ОБЩИЙ, provider- и operation-агностичный helper (не
// бизнес-логика, не работа с БД — чистая функция) специально для
// переиспользования везде, где провайдер возвращает объект с полем id по
// конкретному запрошенному идентификатору: getStatus(), createRefund(),
// getRefund(), webhook verification, reconciliation. Сегодня подключён
// ТОЛЬКО в getStatus() (см. yookassaProvider.js) — остальные вызывающие
// места не реализованы в этой задаче, но контракт уже пригоден для них:
// context — открытый объект (a не хардкоженные operation/httpStatus),
// потому что, например, webhook verification не имеет HTTP-статуса ответа
// вообще (проверяет уже готовое тело), а reconciliation может сравнивать
// два самостоятельно полученных объекта, а не HTTP-ответ напрямую.
//
// idField (найдено при реализации createRefund(), YAAM-yookassa-create-refund-
// implementation-report.pdf): изначально helper всегда сравнивал requestedId
// с response.id — верно для getStatus (response.id — СОБСТВЕННАЯ identity
// запрошенного платежа). Но у Refund два разных id: refund.id — собственная
// identity НОВОГО объекта (мы её не запрашивали, ЮKassa сама назначает — этой
// проверке не подлежит), и refund.payment_id — ССЫЛКА на исходный платёж,
// который мы как раз и запрашивали. Простой if внутри createRefund() уже
// покрыл бы этот случай, но семантика идентична — "проверить, что поле
// ответа с заданным именем совпадает с ожидаемым id", просто под другим
// именем поля — поэтому здесь не новый helper, а обратно-совместимый
// параметр у уже существующего: opts.idField по умолчанию 'id' (поведение
// для getStatus не меняется ни на бит), явно 'payment_id' для createRefund.
// Пригодится так же для getRefund() (сверка response.id как у getStatus) и
// для webhook verification (сверка object.id/object.payment_id с локально
// известным id ДО того, как событие будет принято) — тот же класс риска.
//
// @param {string} requestedId — id, который был запрошен/ожидается.
// @param {unknown} response — уже распарсенное тело ответа провайдера.
// @param {object} [context] — дополнительные безопасные для лога поля
//   (operation/httpStatus и т.п.) — сливаются в context брошенной ошибки как
//   есть; helper их не задаёт сам, чтобы не привязываться к HTTP-специфике.
// @param {object} [opts]
// @param {string} [opts.idField='id'] — имя поля в response, которое должно
//   совпасть с requestedId (например, 'payment_id' для Refund).
// @throws {ProviderResultUnknownError} если response — не объект (в т.ч.
//   null/массив), response[idField] отсутствует/пустой/не строка, или
//   response[idField] !== requestedId.
function assertMatchingProviderObject(requestedId, response, context = {}, opts = {}) {
  const idField = opts.idField || 'id';
  const isPlainObject = response !== null && typeof response === 'object' && !Array.isArray(response);
  const receivedId = isPlainObject ? response[idField] : undefined;
  const matches = typeof receivedId === 'string' && receivedId.length > 0 && receivedId === requestedId;
  if (matches) return;
  // Несовпадение/отсутствие id — тот же уровень недоверия к ответу, что и
  // malformed body (classifyProviderError: isMalformed всегда -> UNKNOWN_RESULT,
  // см. выше) — получили ответ, но не можем безопасно доверять, что он
  // относится к запрошенному объекту. context остаётся requestedId/receivedId
  // (без idField) — сохраняет уже проверенную, стабильную форму ошибки для
  // getStatus; вызывающий код может сам добавить уточнение в свой context,
  // если нужно (см. createRefund()).
  throw new ProviderResultUnknownError({ ...context, requestedId, receivedId });
}

module.exports = {
  CATEGORIES,
  CATEGORY_RULES,
  classifyProviderError,
  ProviderResultUnknownError,
  assertMatchingProviderObject,
};
