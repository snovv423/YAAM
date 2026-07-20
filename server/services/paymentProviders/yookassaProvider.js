const PaymentProviderInterface = require('./providerInterface');
const {
  classifyProviderError,
  CATEGORIES,
  CATEGORY_RULES,
  ProviderResultUnknownError,
  assertMatchingProviderObject,
} = require('./providerErrorTaxonomy');

// ЮKassa, MVP-scope: только СБП, только capture=true (см. YAAM-payment-
// capture-model-ADR.pdf — official-подтверждённый факт: СБП не поддерживает
// двухстадийную оплату, поэтому capture=false здесь сознательно не
// рассматривается — не "пока не сделали", а архитектурно не нужно для этого
// способа оплаты). Historical note: изначально (более ранняя задача) только
// createPayment() был реализован, getStatus/refund/verifyWebhook каждый
// бросал явный 'not implemented'. К Production Switch Stage 8 все методы
// провайдера реализованы (createPayment, getStatus, refund, getRefund,
// verifyWebhook) — провайдер больше не является намеренно нерабочим целым.
//
// Reuse first (см. YAAM-Comparative-Architecture-Research.pdf):
// - HTTP-клиент — встроенный fetch (Node >= 22.5.0, см. server/package.json
//   engines), без SDK/зависимостей — уже обоснованное решение build vs reuse
//   из YAAM-Yookassa-Provider-Error-Taxonomy-Research.pdf (Этап 7): нет
//   официального Node.js SDK у ЮKassa, community-варианты не заслуживают
//   доверия (низкая активность, ЮKassa сама не проверяет их код).
// - Таймаут через AbortController — паттерн Stripe (внутренний HTTP-клиент
//   сам обрывает зависшее соединение, независимо от того, что вызывающий код
//   уже мог перестать ждать через свой собственный Promise.race — см.
//   createPaymentWithTimeout() в orderService.js, который остаётся
//   НЕТРОНУТЫМ и продолжает работать как внешний, provider-агностичный слой
//   защиты; это не дублирование, а defense-in-depth на разных уровнях).
// - Basic Auth + Idempotence-Key — точная official-спецификация ЮKassa
//   (YAAM-Yookassa-Architecture-Audit.pdf, разделы A/B).
// - Классификация ЛЮБОЙ неудачи — через уже реализованный и отдельно
//   протестированный providerErrorTaxonomy.js (ветка
//   claude/provider-error-taxonomy), не изобретается заново здесь.
// - provider возвращает данные/бросает классифицированную ошибку, НЕ трогает
//   orders/payments напрямую — тот же принцип, что уже используется в
//   verifyWebhook()/mockProvider.js и подтверждён паттерном Medusa.js
//   (getWebhookActionAndData возвращает action, не мутирует состояние сам).
//
// ВАЖНОЕ ИСПРАВЛЕНИЕ существовавшего до этой задачи комментария-заготовки:
// ниже было написано confirmation.type='qr' — это неверно конкретно для СБП.
// Официальная страница интеграции СБП прямо указывает confirmation
// type = 'redirect' (пользователь либо сканирует QR на десктопе, либо
// выбирает банк на мобильном — то и другое отображается на СТОРОНЕ ЮKassa
// после редиректа, не строится нами). Используется здесь.
//
// fix(payments): enforce SBP create payment contract — исправления по
// результатам независимого pre-push review commit 333c951 (см.
// YAAM-yookassa-createpayment-pre-push-review.pdf):
// - HIGH: request body не форсировал СБП (payment_method_data отсутствовал) —
//   добавлено ниже, точный формат подтверждён повторным fetch официальной
//   страницы интеграции СБП: { "type": "sbp" }, без дополнительных вложенных
//   полей ("В request можно передавать любые другие параметры, кроме
//   payment_method_id, payment_token, airline").
// - MEDIUM: amount/idempotencyKey не валидировались локально до сетевого
//   вызова — validateAmount()/validateIdempotencyKey() ниже, fail-closed до
//   fetch, категория FATAL_REQUEST (payload-проблема на нашей стороне,
//   retryable:false, sameIdempotencyKey:false — см. providerErrorTaxonomy.js).
// - MEDIUM: response.status валидировался только как typeof==='string', не
//   как конкретное ожидаемое значение — официальная документация жизненного
//   цикла платежа подтверждает: 'pending' — единственный корректный статус
//   в ответе на POST /v3/payments, независимо от способа оплаты. Любой
//   другой статус (включая валидные для других этапов жизненного цикла —
//   succeeded/canceled/waiting_for_capture) на ЭТОМ конкретном вызове —
//   fail-safe UNKNOWN_RESULT, не успех.
//
// getStatus(): comparative architecture research перед кодом (не изобретаем
// заново) — официальная документация ЮKassa (GET /v3/payments/{id}, статусы
// pending/waiting_for_capture/succeeded/canceled, HTTP 404 code='not_found'
// "объект создан в другом магазине или содержится опечатка в идентификаторе",
// cancellation_details.party/reason — 23 документированные причины отмены) +
// архитектурные паттерны трёх зрелых систем (только как примеры, не как
// источник истины):
// - Stripe (PaymentIntent.retrieve): нормализует provider-специфичный статус
//   в собственный enum, а не пробрасывает "сырую" строку провайдера наружу;
//   resource_missing (аналог 404) — отдельная, явно отличимая от обычного
//   декоративного ответа категория ошибки, не молчаливое "не найдено = плохо".
// - Adyen: чёткое разделение технической ошибки транспорта (нет ответа) и
//   бизнес-исхода (платёж отклонён) — те же две принципиально разные ветки,
//   что уже closed в providerErrorTaxonomy.js через isMutatingOperation.
// - Medusa.js (PaymentProviderService.getStatus): маппит provider-специфичный
//   статус в общий внутренний словарь (authorized/pending/captured/canceled/
//   error); НЕИЗВЕСТНЫЙ/непредвиденный provider-статус — не молчаливо
//   игнорируется и не угадывается, а требует явной обработки (fail-safe,
//   тот же принцип, что уже применён в createPayment() для status='pending').
//
// Вывод из research, применённый ниже: GET — операция ЧТЕНИЯ, не мутирует
// состояние на стороне провайдера — поэтому classifyProviderError() вызывается
// с isMutatingOperation:false (см. JSDoc в providerErrorTaxonomy.js: для
// операции чтения транспортная неопределённость — RETRYABLE, не
// UNKNOWN_RESULT, т.к. нечего сверять, можно просто повторить запрос).
// HTTP 404 — по официальной семантике ("не найден/чужой магазин") — НЕ
// приравнивается молча к нормализованному статусу 'failed': если у нас уже
// есть providerPaymentId от собственного ранее успешного createPayment(),
// повторный 404 на НЕГО — это красный флаг (рассинхронизация credentials/
// окружения или повреждение данных), а не бизнес-факт "платёж не удался".
// В отличие от mockProvider.getStatus() (который для демо-простоты трактует
// отсутствие записи как 'failed') — реальный провайдер, работающий с
// настоящими деньгами, обязан здесь fail-loud, а не угадывать: 404
// классифицируется через существующую taxonomy (NOT_FOUND,
// needsReconciliation:true) и бросается как ошибка, не возвращается как
// нормализованный статус.
const YOOKASSA_API_BASE_URL = 'https://api.yookassa.ru/v3';

// Официальные лимиты ЮKassa для СБП (перепроверено на странице интеграции
// СБП): минимум 1 рубль, максимум 700 000 рублей (порог можно увеличить
// только через менеджера ЮKassa — здесь фиксируем стандартный документированный
// диапазон, не пытаемся угадывать индивидуальные лимиты конкретного магазина).
const SBP_MIN_AMOUNT_RUB = 1;
const SBP_MAX_AMOUNT_RUB = 700000;

// Официальный лимит Idempotence-Key (см. "Формат взаимодействия" в
// документации ЮKassa): "Длина не больше 64 символов". Минимальная длина и
// допустимый набор символов официально не оговорены — единственное
// дополнительное ограничение ниже (запрет управляющих символов) добавлено не
// как требование ЮKassa, а как defense-in-depth против HTTP header injection
// через сырое значение, которое напрямую становится значением заголовка.
const IDEMPOTENCE_KEY_MAX_LENGTH = 64;

// Production Switch — Stage 8: MVP-scope события вебхука (только СБП,
// capture=true — см. YAAM-payment-capture-model-ADR.pdf) — значение это
// ожидаемый нормализованный статус, который канонический getStatus() ОБЯЗАН
// вернуть, чтобы уведомление считалось подтверждённым (см. verifyWebhook()).
const SUPPORTED_WEBHOOK_EVENTS = Object.freeze({
  'payment.succeeded': 'succeeded',
  'payment.canceled': 'failed',
});

// Реальные уведомления ЮKassa компактны (id/event/object с суммой/статусом)
// — 64KB даёт большой запас, не ограничивая ничего документированного, но
// не позволяя тратить ресурсы на разбор заведомо аномального тела.
const WEBHOOK_BODY_MAX_BYTES = 65536;

// Тот же env var и та же защитная логика диапазона, что уже использует
// providerCreateTimeoutMs() в orderService.js (10 baseline, [10, 120000] мс) —
// значение намеренно совпадает для предсказуемости конфигурации, но функция
// не переиспользуется напрямую как импорт: providers/ не должны зависеть от
// orderService.js (обратное направление зависимости уже есть и не должно
// инвертироваться) — 5-строчный локальный дубликат безопаснее нового общего
// модуля ради одной короткой функции.
function resolveCreateTimeoutMs() {
  const configured = Number(process.env.PAYMENT_CREATE_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

// Тот же паттерн, что и у providerCreateTimeoutMs()/providerRefundTimeoutMs()
// в orderService.js (PAYMENT_<OPERATION>_TIMEOUT_MS, диапазон [10, 120000] мс,
// baseline 10000) — переиспользуем существующую конвенцию именования, не
// вводим новую. getStatus() пока не вызывается из orderService.js (вне scope
// этой задачи — только получение и нормализация статуса, без reconciliation/
// подключения к polling-логике), поэтому здесь только provider-уровневый
// AbortController-таймаут, без внешнего orderService-уровневого Promise.race.
function resolveStatusTimeoutMs() {
  const configured = Number(process.env.PAYMENT_STATUS_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

// PAYMENT_REFUND_TIMEOUT_MS — та же env-переменная, что УЖЕ существует и
// используется в orderService.js (providerRefundTimeoutMs()) для внешнего
// Promise.race-таймаута вокруг payments.refundPayment(). Здесь — provider-
// уровневый AbortController-таймаут (defense-in-depth на другом уровне, тот
// же принцип, что и у createPayment()/getStatus()). Совпадение имени
// намеренное — единая точка конфигурации таймаута возврата для всего стека.
function resolveRefundTimeoutMs() {
  const configured = Number(process.env.PAYMENT_REFUND_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

// Отдельная env-переменная от PAYMENT_REFUND_TIMEOUT_MS (та настраивает
// таймаут POST-создания возврата) — тот же принцип "один таймаут на операцию",
// что уже применён для PAYMENT_STATUS_TIMEOUT_MS отдельно от
// PAYMENT_CREATE_TIMEOUT_MS. getRefund() — независимая GET-операция чтения,
// не вызывается из orderService.js (нет там ещё аналога providerGetRefundTimeoutMs()
// — вне scope этой задачи), поэтому здесь только provider-уровневый
// AbortController-таймаут; PostgreSQL refund reconciliation вызывает этот
// метод через paymentService после сохранения provider_refund_id.
function resolveGetRefundTimeoutMs() {
  const configured = Number(process.env.PAYMENT_GET_REFUND_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

// Официальная OpenAPI-схема RefundStatus ЮKassa содержит три статуса:
// pending/succeeded/canceled. POST /v3/refunds может вернуть pending, поэтому
// этот неокончательный исход нельзя превращать в UNKNOWN_RESULT и терять
// provider refund id: orchestration сохранит id и продолжит канонической
// GET-сверкой через getRefund().
const YOOKASSA_REFUND_STATUS_TO_NORMALIZED = Object.freeze({
  pending: 'pending',
  succeeded: 'succeeded',
  canceled: 'failed',
});

// Неизвестный статус (включая гипотетический 'pending', которого сегодня нет
// в документации Refund, и 'waiting_for_capture'/'pending', которые
// документированы только для Payment, не для Refund) — не угадываем, тот же
// fail-safe принцип, что и normalizeStatus() для getStatus().
function normalizeRefundStatus(rawStatus) {
  return Object.prototype.hasOwnProperty.call(YOOKASSA_REFUND_STATUS_TO_NORMALIZED, rawStatus)
    ? YOOKASSA_REFUND_STATUS_TO_NORMALIZED[rawStatus]
    : null;
}

// getRefund() — полная 3-значная нормализация (pending/succeeded/
// canceled -> pending/succeeded/failed). getRefund() архитектурно ближе к
// getStatus() (чтение уже существующего объекта по его
// собственному id), поэтому использует ТОТ ЖЕ 3-значный enum, что и
// normalizeStatus() для платежа — 'pending' здесь не теряется молча.
const YOOKASSA_GET_REFUND_STATUS_TO_NORMALIZED = Object.freeze({
  pending: 'pending',
  succeeded: 'succeeded',
  canceled: 'failed',
});

// Неизвестный/будущий статус — не угадываем, тот же fail-safe принцип, что и
// у normalizeStatus()/normalizeRefundStatus().
function normalizeGetRefundStatus(rawStatus) {
  return Object.prototype.hasOwnProperty.call(YOOKASSA_GET_REFUND_STATUS_TO_NORMALIZED, rawStatus)
    ? YOOKASSA_GET_REFUND_STATUS_TO_NORMALIZED[rawStatus]
    : null;
}

// Официальные статусы платежа ЮKassa (см. жизненный цикл платежа) и их
// маппинг в нормализованный 3-значный enum контракта интерфейса
// (providerInterface.js: 'pending' | 'succeeded' | 'failed'). 'succeeded' —
// терминальный успех. 'canceled' — терминальный провал (включает ЛЮБУЮ
// причину из cancellation_details.reason — 23 документированные причины,
// от 3d_secure_failed до fraud_suspected — интерфейс не поддерживает передачу
// конкретной причины дальше, только сам факт отмены; для СБП без
// payment_method_data ограничений это по-прежнему безопасно, т.к. 'canceled'
// у ЮKassa всегда терминален и однозначен независимо от причины). 'pending' и
// 'waiting_for_capture' — оба ещё НЕ финальны (waiting_for_capture возможен
// только теоретически при capture=true, если списание почему-то ещё не
// произошло атомарно вместе с подтверждением — MVP всегда шлёт capture=true,
// но провайдер не должен полагаться на то, что сам гарантировал, поэтому этот
// статус явно обработан, а не проигнорирован) — оба маппятся в 'pending', не
// в 'succeeded': до 'succeeded' деньги ещё не считаются окончательно списанными.
const YOOKASSA_STATUS_TO_NORMALIZED = Object.freeze({
  pending: 'pending',
  waiting_for_capture: 'pending',
  succeeded: 'succeeded',
  canceled: 'failed',
});

// Неизвестный/будущий статус (ЮKassa может добавить новый статус, которого
// нет в документации на момент написания) — НЕ угадываем ни 'succeeded', ни
// 'failed': оба варианта потенциально опасны (первый рискует деньгами
// ресторана, второй — необоснованной отменой реально идущего заказа).
// Тот же fail-safe принцип, что уже применён к response.status в
// createPayment() и подтверждён паттерном Medusa.js (getPaymentStatus не
// угадывает неизвестный provider-статус, а требует явной обработки).
function normalizeStatus(rawStatus) {
  return Object.prototype.hasOwnProperty.call(YOOKASSA_STATUS_TO_NORMALIZED, rawStatus)
    ? YOOKASSA_STATUS_TO_NORMALIZED[rawStatus]
    : null;
}

// Ошибка конфигурации — недостижима с валидными ENV, fail-closed по тому же
// принципу, что и отсутствующий YOOKASSA_SHOP_ID/SECRET_KEY в конструкторе.
class YookassaConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YookassaConfigurationError';
  }
}

// Категоризированная ошибка запроса createPayment (кроме UNKNOWN_RESULT —
// для него уже есть отдельный, ранее реализованный ProviderResultUnknownError,
// семантически точно подходящий). Публичное сообщение никогда не содержит
// деталей провайдера/секретов — только безопасный context для внутреннего лога.
class YookassaCreatePaymentError extends Error {
  constructor(category, context) {
    super('Платёжный сервис вернул ошибку при создании платежа');
    this.name = 'YookassaCreatePaymentError';
    this.category = category;
    this.rules = CATEGORY_RULES[category];
    this.context = context;
  }
}

// Аналог YookassaCreatePaymentError, но для getStatus(). Отдельный класс, а
// не переименование существующего в operation-agnostic: YookassaCreatePaymentError
// уже прошла независимое review и опубликована (claude/yookassa-create-payment),
// 47 существующих тестов проверяют err.name==='YookassaCreatePaymentError' —
// трогать её ради одного слова в сообщении означало бы риск регресса уже
// проверенного и опубликованного кода без необходимости. Три похожих строки
// дешевле преждевременной общей абстракции (см. CLAUDE.md).
class YookassaGetStatusError extends Error {
  constructor(category, context) {
    super('Платёжный сервис вернул ошибку при получении статуса платежа');
    this.name = 'YookassaGetStatusError';
    this.category = category;
    this.rules = CATEGORY_RULES[category];
    this.context = context;
  }
}

// Аналог для refund() (createRefund в терминологии задачи — фактический
// метод интерфейса называется refund(), см. providerInterface.js). Тот же
// принцип, что и у YookassaGetStatusError: отдельный класс, не переименование
// существующих — ноль риска для уже опубликованных createPayment/getStatus.
class YookassaRefundError extends Error {
  constructor(category, context) {
    super('Платёжный сервис вернул ошибку при создании возврата');
    this.name = 'YookassaRefundError';
    this.category = category;
    this.rules = CATEGORY_RULES[category];
    this.context = context;
  }
}

// Аналог для getRefund() — четвёртый по счёту отдельный класс операции
// (тот же принцип, что и у YookassaGetStatusError/YookassaRefundError): ноль
// риска для уже опубликованных createPayment/getStatus/refund.
class YookassaGetRefundError extends Error {
  constructor(category, context) {
    super('Платёжный сервис вернул ошибку при получении информации о возврате');
    this.name = 'YookassaGetRefundError';
    this.category = category;
    this.rules = CATEGORY_RULES[category];
    this.context = context;
  }
}

// Локальная (до-сетевая) payload-ошибка — на нашей стороне, провайдер не
// вызывался вообще. Категория FATAL_REQUEST точно отражает семантику из
// providerErrorTaxonomy.js: retryable:false, sameIdempotencyKey:false (после
// исправления payload нужен НОВЫЙ ключ/значение, а не повтор со старым).
// Не заводим отдельный класс/категорию ради локальной проверки — переиспользуем
// существующую таксономию. ErrorClass параметризована (не хардкожен
// YookassaCreatePaymentError): getStatus()'s providerPaymentId-валидация
// использует тот же helper, но должна бросать YookassaGetStatusError, чтобы
// имя ошибки было консистентно предсказуемым для конкретной операции.
function localValidationError(operation, context, reason, ErrorClass = YookassaCreatePaymentError) {
  return new ErrorClass(CATEGORIES.FATAL_REQUEST, { operation, ...context, reason });
}

// amount приходит от вызывающего кода (paymentService.js) как число рублей —
// та же семантика для createPayment (сумма платежа) и refund() (сумма
// возврата): официальный минимум для СБП — 1 руб. для обеих операций,
// максимум для refund официально не задан отдельно, а ограничен размером
// исходного платежа (сам provider этого не знает и не обязан — это уже
// проверено выше по стеку при создании платежа; локально проверяем те же
// структурные правила, что уже применялись бы к любой валидной СБП-сумме).
// Проверяем ДО сетевого вызова — провайдер не должен полагаться на то, что
// выше по стеку это уже сделали (defense-in-depth, тот же принцип, что и
// fail-closed проверка ключей/return_url в конструкторе/createPayment).
// context/operation/ErrorClass параметризованы (backward-compatible default
// = createPayment) — второй вызывающий (refund()) передаёт свой context
// ({providerPaymentId}, не {orderId} — у refund() нет orderId) и свой класс.
function validateAmount(amount, context = {}, operation = 'createPayment', ErrorClass = YookassaCreatePaymentError) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw localValidationError(operation, context, 'amount должен быть конечным числом', ErrorClass);
  }
  if (amount <= 0) {
    throw localValidationError(operation, context, 'amount должен быть строго больше нуля', ErrorClass);
  }
  if (amount < SBP_MIN_AMOUNT_RUB || amount > SBP_MAX_AMOUNT_RUB) {
    throw localValidationError(
      operation, context,
      `amount вне поддерживаемого диапазона ЮKassa для СБП (${SBP_MIN_AMOUNT_RUB}..${SBP_MAX_AMOUNT_RUB} руб.)`,
      ErrorClass,
    );
  }
  // Ровно два знака после запятой — без скрытого округления. Строковое
  // представление числа (не умножение на 100) специально выбрано, чтобы не
  // зависеть от погрешности плавающей точки при умножении/делении.
  if (!/^\d+(\.\d{1,2})?$/.test(String(amount))) {
    throw localValidationError(operation, context, 'amount не может иметь больше двух знаков после запятой', ErrorClass);
  }
}

// idempotencyKey уже проверяется в paymentService.js выше по стеку (и для
// createPayment, и для refund() — см. paymentService.refundPayment()), но
// провайдер, вызванный напрямую (в обход paymentService.js — например, из
// теста или будущего кода), не должен молча доверять этому и не должен молча
// нормализовать/обрезать значение перед отправкой в заголовке. Официальные
// правила Idempotence-Key (макс. 64 символа) одинаковы для любой операции —
// не переоткрываем их отдельно для refund.
function validateIdempotencyKey(idempotencyKey, context = {}, operation = 'createPayment', ErrorClass = YookassaCreatePaymentError) {
  if (typeof idempotencyKey !== 'string') {
    throw localValidationError(operation, context, 'idempotencyKey должен быть строкой', ErrorClass);
  }
  if (idempotencyKey.trim().length === 0) {
    throw localValidationError(operation, context, 'idempotencyKey не может быть пустым', ErrorClass);
  }
  if (idempotencyKey.length > IDEMPOTENCE_KEY_MAX_LENGTH) {
    throw localValidationError(
      operation, context,
      `idempotencyKey длиннее ${IDEMPOTENCE_KEY_MAX_LENGTH} символов (официальный лимит ЮKassa)`,
      ErrorClass,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(idempotencyKey)) {
    throw localValidationError(operation, context, 'idempotencyKey содержит недопустимые управляющие символы', ErrorClass);
  }
}

// providerPaymentId уже гарантированно непустая строка на уровне
// paymentService.js (хранится как payments.provider_payment_id из
// собственного успешного createPayment()), но provider, вызванный напрямую,
// не должен молча доверять этому — тот же defense-in-depth принцип, что и у
// validateAmount()/validateIdempotencyKey(). operation/ErrorClass
// параметризованы (backward-compatible default = getStatus, единственный
// вызывающий на момент введения этой функции) — refund() передаёт свои.
function validateProviderPaymentId(providerPaymentId, operation = 'getStatus', ErrorClass = YookassaGetStatusError) {
  if (typeof providerPaymentId !== 'string' || providerPaymentId.trim().length === 0) {
    throw localValidationError(operation, { providerPaymentId }, 'providerPaymentId должен быть непустой строкой', ErrorClass);
  }
}

// Та же проверка, что validateProviderPaymentId(), но для refund id — не
// переиспользуем ту функцию напрямую: её context-ключ ("providerPaymentId")
// захардкожен внутри и маркировал бы refund id как payment id, вводя в
// заблуждение диагностику/логи. Обобщать уже опубликованную и независимо
// проверенную validateProviderPaymentId() (используется в getStatus()/
// refund(), оба уже прошли review) ради этого было бы риском для чужого
// уже одобренного кода без нужды — три похожие строки дешевле (тот же
// принцип, что и у YookassaGetRefundError выше).
function validateProviderRefundId(providerRefundId, operation = 'getRefund', ErrorClass = YookassaGetRefundError) {
  if (typeof providerRefundId !== 'string' || providerRefundId.trim().length === 0) {
    throw localValidationError(operation, { providerRefundId }, 'providerRefundId должен быть непустой строкой', ErrorClass);
  }
}

// LOW-усиление: YOOKASSA_RETURN_URL — операторская конфигурация, не ввод
// пользователя, но всё равно должна быть валидным URL; в production —
// обязательно https (redirect с реальными деньгами не должен идти на http).
function validateReturnUrl(returnUrl) {
  let parsed;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new YookassaConfigurationError('YOOKASSA_RETURN_URL не является валидным URL');
  }
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && parsed.protocol !== 'https:') {
    throw new YookassaConfigurationError('YOOKASSA_RETURN_URL должен использовать https в production');
  }
  if (!isProduction && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new YookassaConfigurationError('YOOKASSA_RETURN_URL должен использовать http или https');
  }
}

// LOW-усиление: confirmation_url приходит от провайдера, но мы не должны
// вслепую доверять протоколу перед тем, как передать его клиенту для
// редиректа (window.location.href на стороне client/js/app.js). Проверяем
// только протокол (https) — сознательно НЕ вводим allowlist конкретных
// доменов ЮKassa: их набор официально не зафиксирован как исчерпывающий и
// может измениться, а хрупкий allowlist сломается тише, чем отсутствие
// проверки протокола решает реальную угрозу (javascript:/data:/file:).
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

class YookassaProvider extends PaymentProviderInterface {
  constructor() {
    super();
    if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
      throw new Error(
        'YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не заданы. ' +
        'ЮKassa-провайдер ещё не полностью реализован — см. комментарий в начале файла.'
      );
    }
    this.shopId = process.env.YOOKASSA_SHOP_ID;
    this.secretKey = process.env.YOOKASSA_SECRET_KEY;
  }

  _authHeader() {
    return 'Basic ' + Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64');
  }

  async createPayment({ orderId, amount, description, idempotencyKey }) {
    // idempotencyKey и amount УЖЕ проверяются на уровне
    // paymentService.createPayment() до вызова любого провайдера (см.
    // server/services/paymentService.js) — но provider, вызванный напрямую
    // (в обход paymentService.js), не должен молча доверять этому: локальная
    // fail-closed проверка ниже — defense-in-depth, не дублирование бизнес-
    // логики (см. комментарий к localValidationError выше).
    validateAmount(amount, { orderId });
    validateIdempotencyKey(idempotencyKey, { orderId });

    const returnUrl = process.env.YOOKASSA_RETURN_URL;
    if (!returnUrl) {
      // Fail-closed, тот же принцип, что и отсутствующие ключи в конструкторе —
      // без return_url ЮKassa отклонит запрос (confirmation.type='redirect'
      // требует его обязательно), лучше остановиться заранее с понятной
      // причиной, чем отправить заведомо невалидный запрос.
      throw new YookassaConfigurationError(
        'YOOKASSA_RETURN_URL не задан — обязателен для confirmation.type=redirect (СБП)'
      );
    }
    validateReturnUrl(returnUrl);

    const requestBody = {
      amount: { value: amount.toFixed(2), currency: 'RUB' },
      // HIGH-исправление (pre-push review commit 333c951): без этого поля
      // ЮKassa показывает пользователю ПОЛНЫЙ выбор способов оплаты (карта,
      // кошелёк и т.д.), а не только СБП — прямое нарушение MVP-решения
      // "только СБП" (см. ADR). Формат подтверждён официальной документацией
      // интеграции СБП: единственное поле type='sbp', без вложенных полей.
      payment_method_data: { type: 'sbp' },
      // MVP-решение зафиксировано ADR (YAAM-payment-capture-model-ADR.pdf) —
      // capture=true всегда, явно (не полагаемся на дефолт ЮKassa).
      capture: true,
      confirmation: { type: 'redirect', return_url: returnUrl },
      description,
      // Явная привязка к внутреннему заказу — не бизнес-логика оплаты, чисто
      // диагностическое поле запроса к провайдеру, безопасно добавлять здесь,
      // не трогая orderService.js (сравнимо с практикой Stripe/"Designing a
      // Payment System" — метаданные для будущей сверки/поддержки).
      metadata: { orderId: String(orderId) },
    };

    const controller = new AbortController();
    const timeoutMs = resolveCreateTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(`${YOOKASSA_API_BASE_URL}/payments`, {
        method: 'POST',
        headers: {
          Authorization: this._authHeader(),
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err?.name === 'AbortError';
      const category = classifyProviderError({
        isTimeout,
        isNetworkError: !isTimeout,
        isMutatingOperation: true,
      });
      throw this._toError(category, { operation: 'createPayment', orderId, cause: err?.name || 'Error' });
    }
    clearTimeout(timer);

    let parsedBody;
    let isMalformed = false;
    try {
      parsedBody = await response.json();
    } catch {
      isMalformed = true;
    }

    if (!isMalformed && response.ok) {
      // Успешный HTTP-статус ещё не значит, что тело содержит ожидаемые поля —
      // не доверяем "200 значит успех", проверяем реальную форму ответа (тот
      // же принцип, что уже применяется в mockProvider/ensureRefundReady:
      // fail-loud на неожиданную форму, не молчаливое приведение к успеху).
      //
      // MEDIUM-исправление (pre-push review commit 333c951): status
      // проверялся только как typeof==='string' — любой статус (в т.ч.
      // succeeded/canceled на СОЗДАНИИ платежа, что официально
      // недокументировано для этого запроса) молча считался успехом.
      // Официальная документация жизненного цикла платежа подтверждает:
      // 'pending' — единственный корректный статус в ответе именно на
      // POST /v3/payments, независимо от способа оплаты. Любой другой статус
      // здесь — не "другой валидный случай", а fail-safe UNKNOWN_RESULT.
      const hasExpectedShape = typeof parsedBody?.id === 'string'
        && parsedBody?.status === 'pending'
        && parsedBody?.confirmation?.type === 'redirect'
        && isHttpsUrl(parsedBody?.confirmation?.confirmation_url);
      if (!hasExpectedShape) isMalformed = true;
    }

    if (isMalformed) {
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: true });
      throw this._toError(category, { operation: 'createPayment', orderId, httpStatus: response.status });
    }

    if (!response.ok) {
      const category = classifyProviderError({ httpStatus: response.status, isMutatingOperation: true });
      throw this._toError(category, { operation: 'createPayment', orderId, httpStatus: response.status });
    }

    return {
      providerPaymentId: parsedBody.id,
      qrPayload: parsedBody.confirmation.confirmation_data || null,
      paymentUrl: parsedBody.confirmation.confirmation_url || null,
    };
  }

  // ErrorClass параметризована (backward-compatible default = createPayment'а
  // класс) — существующие вызовы из createPayment() не меняются ни поведением,
  // ни сигнатурой вызова.
  _toError(category, context, ErrorClass = YookassaCreatePaymentError) {
    if (category === CATEGORIES.UNKNOWN_RESULT) return new ProviderResultUnknownError(context);
    return new ErrorClass(category, context);
  }

  async getStatus(providerPaymentId) {
    validateProviderPaymentId(providerPaymentId);

    const controller = new AbortController();
    const timeoutMs = resolveStatusTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(`${YOOKASSA_API_BASE_URL}/payments/${encodeURIComponent(providerPaymentId)}`, {
        method: 'GET',
        headers: { Authorization: this._authHeader() },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err?.name === 'AbortError';
      // GET — операция чтения: isMutatingOperation:false (см. комментарий в
      // начале файла — вывод comparative research). Транспортная
      // неопределённость здесь RETRYABLE, не UNKNOWN_RESULT: нечего сверять,
      // можно просто повторить запрос на чтение.
      const category = classifyProviderError({
        isTimeout,
        isNetworkError: !isTimeout,
        isMutatingOperation: false,
      });
      throw this._toError(
        category, { operation: 'getStatus', providerPaymentId, cause: err?.name || 'Error' }, YookassaGetStatusError,
      );
    }
    clearTimeout(timer);

    let parsedBody;
    let isMalformed = false;
    try {
      parsedBody = await response.json();
    } catch {
      isMalformed = true;
    }

    if (!isMalformed && response.ok) {
      // M1-исправление (pre-push review getStatus(), см.
      // YAAM-yookassa-getstatus-final-review-and-push-report.pdf): раньше id
      // проверялся только как "непустая строка", но НЕ сверялся с тем id,
      // который мы запросили — ответ провайдера про ЧУЖОЙ платёж молча
      // принимался бы за ответ про наш. assertMatchingProviderObject() —
      // общий, provider-агностичный helper (providerErrorTaxonomy.js),
      // спроектированный для переиспользования в createRefund/getRefund/
      // webhook verification/reconciliation (см. комментарий там же); здесь
      // подключён первым. Бросает ProviderResultUnknownError сам, если
      // response не объект либо response.id отсутствует/пустой/не совпадает —
      // поэтому дальнейшая проверка ниже гарантированно видит id, совпавший
      // с providerPaymentId.
      assertMatchingProviderObject(providerPaymentId, parsedBody, { operation: 'getStatus', httpStatus: response.status });

      // Тот же fail-loud принцип, что и в createPayment(): успешный HTTP-статус
      // ещё не значит, что телу можно доверять — status тоже должен быть
      // ожидаемого вида (сам helper выше не знает про status — это уже
      // getStatus-специфичная, не переиспользуемая проверка).
      if (typeof parsedBody?.status !== 'string') isMalformed = true;
    }

    if (isMalformed) {
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: false });
      throw this._toError(
        category, { operation: 'getStatus', providerPaymentId, httpStatus: response.status }, YookassaGetStatusError,
      );
    }

    if (!response.ok) {
      // HTTP 404 (официально: code='not_found', "объект создан в другом
      // магазине или содержится опечатка в идентификаторе") тоже проходит
      // здесь — classifyProviderError уже классифицирует его как NOT_FOUND.
      // Осознанно НЕ трактуем это как нормализованный статус 'failed' — см.
      // обоснование в комментарии в начале файла (comparative research).
      const category = classifyProviderError({ httpStatus: response.status, isMutatingOperation: false });
      throw this._toError(
        category, { operation: 'getStatus', providerPaymentId, httpStatus: response.status }, YookassaGetStatusError,
      );
    }

    const normalized = normalizeStatus(parsedBody.status);
    if (normalized === null) {
      // Неизвестный/будущий provider-статус — не угадываем (см. normalizeStatus).
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: false });
      throw this._toError(
        category, { operation: 'getStatus', providerPaymentId, httpStatus: response.status }, YookassaGetStatusError,
      );
    }
    return normalized;
  }

  // "createRefund" в терминологии задачи — фактический метод существующего
  // provider interface называется refund() (providerInterface.js), позиционные
  // аргументы (providerPaymentId, amount, idempotencyKey), возврат
  // {refundId, status: 'succeeded'|'failed'}. Не переименован и не изменена
  // сигнатура — уже вызывается из paymentService.refundPayment(), которая (как
  // и создание платежа) сама уже проверяет idempotencyKey до вызова провайдера;
  // локальная валидация ниже — defense-in-depth, тот же принцип, что и в
  // createPayment()/getStatus().
  async refund(providerPaymentId, amount, idempotencyKey) {
    validateProviderPaymentId(providerPaymentId, 'refund', YookassaRefundError);
    validateAmount(amount, { providerPaymentId }, 'refund', YookassaRefundError);
    validateIdempotencyKey(idempotencyKey, { providerPaymentId }, 'refund', YookassaRefundError);

    const requestBody = {
      payment_id: providerPaymentId,
      amount: { value: amount.toFixed(2), currency: 'RUB' },
    };
    // Официальный минимальный пример тела запроса POST /v3/refunds
    // (перепроверено точечно перед реализацией): только payment_id и amount —
    // description НЕ подтверждён документацией для возврата (в отличие от
    // createPayment, где он есть), поэтому не добавляется. metadata тоже не
    // добавлена: существующий interface не передаёт в refund() никакого
    // внутреннего id попытки возврата (только providerPaymentId/amount/
    // idempotencyKey) — добавлять здесь нечего, придумывать новый id внутри
    // provider для metadata было бы созданием identity, которого durable
    // refund idempotency key (см. orderService.newProviderIdempotencyKey())
    // уже и так безопасно решает на уровне вызывающего кода.

    const controller = new AbortController();
    const timeoutMs = resolveRefundTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(`${YOOKASSA_API_BASE_URL}/refunds`, {
        method: 'POST',
        headers: {
          Authorization: this._authHeader(),
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err?.name === 'AbortError';
      // refund() — мутирующая операция (создаёт реальный возврат денег),
      // ровно как createPayment(): isMutatingOperation:true — транспортная
      // неопределённость здесь ВСЕГДА UNKNOWN_RESULT (провайдер мог успеть
      // создать возврат несмотря на неудачный ответ), не RETRYABLE, в отличие
      // от getStatus() (чтение, нечего сверять).
      const category = classifyProviderError({
        isTimeout,
        isNetworkError: !isTimeout,
        isMutatingOperation: true,
      });
      throw this._toError(
        category, { operation: 'refund', providerPaymentId, cause: err?.name || 'Error' }, YookassaRefundError,
      );
    }
    clearTimeout(timer);

    let parsedBody;
    let isMalformed = false;
    try {
      parsedBody = await response.json();
    } catch {
      isMalformed = true;
    }

    if (!isMalformed && response.ok) {
      // refund.id — СОБСТВЕННАЯ identity нового объекта, назначенная ЮKassa —
      // мы её не запрашивали заранее, поэтому здесь только проверка формы
      // (непустая строка), не identity-сверка (assertMatchingProviderObject
      // сравнивает с requestedId, а тут просто нечего сравнивать).
      const hasRefundId = typeof parsedBody?.id === 'string' && parsedBody.id.length > 0;
      if (!hasRefundId) {
        isMalformed = true;
      } else {
        // refund.payment_id — ССЫЛКА на исходный платёж, который мы как раз
        // запрашивали (providerPaymentId) — это именно тот случай, для
        // которого assertMatchingProviderObject() спроектирован, просто под
        // другим именем поля (idField:'payment_id', не 'id' по умолчанию).
        // Бросает ProviderResultUnknownError сам при отсутствии/несовпадении.
        assertMatchingProviderObject(
          providerPaymentId, parsedBody, { operation: 'refund', httpStatus: response.status }, { idField: 'payment_id' },
        );
        // amount/currency — best-effort defense-in-depth: официальная
        // документация НЕ гарантирует явно эхо запрошенной суммы в ответе
        // (в отличие от подтверждённого статус-контракта createPayment), но
        // ответ с суммой/валютой, не совпадающей с запрошенной, — та же
        // степень недоверия, что и id-несовпадение.
        const responseAmountValue = parsedBody?.amount?.value;
        const responseCurrency = parsedBody?.amount?.currency;
        if (responseAmountValue !== amount.toFixed(2) || responseCurrency !== 'RUB') {
          isMalformed = true;
        }
      }
    }

    if (isMalformed) {
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: true });
      throw this._toError(
        category, { operation: 'refund', providerPaymentId, httpStatus: response.status }, YookassaRefundError,
      );
    }

    if (!response.ok) {
      // HTTP 404/409/429/401/403/400/415/5xx классифицируются существующей
      // taxonomy без специального маппинга под refund — официальные коды
      // ошибок ЮKassa (invalid_request/invalid_credentials/forbidden/
      // not_found/too_many_requests/internal_server_error) идентичны для
      // POST /v3/payments и POST /v3/refunds (общий HTTP-уровень API).
      // Недостаток средств для возврата и превышение доступного остатка —
      // согласно документации НЕ отдельные HTTP-коды, а обычный canceled-исход
      // внутри успешного 2xx-ответа (см. normalizeRefundStatus выше) —
      // отдельного маппинга для них здесь намеренно нет, они уже безопасно
      // проходят через 'canceled' -> 'failed'.
      const category = classifyProviderError({ httpStatus: response.status, isMutatingOperation: true });
      throw this._toError(
        category, { operation: 'refund', providerPaymentId, httpStatus: response.status }, YookassaRefundError,
      );
    }

    const normalized = normalizeRefundStatus(parsedBody.status);
    if (normalized === null) {
      // Неизвестный/будущий refund-статус (в т.ч. гипотетический 'pending',
      // не документированный сегодня для Refund) — не угадываем.
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: true });
      throw this._toError(
        category, { operation: 'refund', providerPaymentId, httpStatus: response.status }, YookassaRefundError,
      );
    }

    // Нормализованный контракт — строго по существующему providerInterface.js
    // (refundId, не providerRefundId: уже вызывается из
    // orderService.ensureRefundReady(), которая читает именно result.refundId).
    // Никакого сырого provider body, credentials, idempotency key наружу.
    return { refundId: parsedBody.id, status: normalized };
  }

  // getRefund() — каноническая GET-сверка уже созданного возврата.
  // Архитектурно ближе к getStatus(), чем к refund():
  // читает уже существующий объект по ЕГО СОБСТВЕННОМУ id (GET
  // /v3/refunds/{refund_id}), а не создаёт новый — поэтому:
  // - GET, без тела, без Idempotence-Key (официально не требуется для GET);
  // - isMutatingOperation:false (не мутирует, транспортная неопределённость
  //   здесь RETRYABLE, не UNKNOWN_RESULT — нечего сверять, читать можно
  //   просто повторно, тот же принцип, что и у getStatus());
  // - возвращает нормализованный 3-значный статус ('pending'|'succeeded'|
  //   'failed'), а не {refundId, status} — вызывающий уже знает id (это его
  //   собственный входной параметр), эхо не нужно (тот же паттерн, что и
  //   getStatus(), которая тоже возвращает голую строку, не объект).
  async getRefund(providerRefundId, { providerPaymentId, amount } = {}) {
    validateProviderRefundId(providerRefundId);

    const controller = new AbortController();
    const timeoutMs = resolveGetRefundTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(`${YOOKASSA_API_BASE_URL}/refunds/${encodeURIComponent(providerRefundId)}`, {
        method: 'GET',
        headers: { Authorization: this._authHeader() },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err?.name === 'AbortError';
      const category = classifyProviderError({
        isTimeout,
        isNetworkError: !isTimeout,
        isMutatingOperation: false,
      });
      throw this._toError(
        category, { operation: 'getRefund', providerRefundId, cause: err?.name || 'Error' }, YookassaGetRefundError,
      );
    }
    clearTimeout(timer);

    let parsedBody;
    let isMalformed = false;
    try {
      parsedBody = await response.json();
    } catch {
      isMalformed = true;
    }

    if (!isMalformed && response.ok) {
      // refund.id — СОБСТВЕННАЯ identity запрошенного объекта (мы запросили
      // именно этот providerRefundId по GET) — в отличие от refund()'s
      // проверки refund.payment_id (там ССЫЛКА на другой объект), здесь
      // используется default idField='id' — тот же вызов, что и в
      // getStatus(), ничего нового не изобретается.
      assertMatchingProviderObject(providerRefundId, parsedBody, { operation: 'getRefund', httpStatus: response.status });

      // payment_id/amount — обязательные поля по официальной схеме Refund
      // (OpenAPI: required: [id, payment_id, amount, status, created_at|]) —
      // проверяются на форму всегда; если orchestration передал ожидаемые
      // payment_id/amount, они также обязаны совпасть. Отсутствие любого поля
      // — та же степень недоверия, что и отсутствие/пустой id.
      const hasPaymentId = typeof parsedBody?.payment_id === 'string' && parsedBody.payment_id.length > 0;
      const hasAmount = parsedBody?.amount !== null && typeof parsedBody?.amount === 'object'
        && typeof parsedBody.amount.value === 'string' && typeof parsedBody.amount.currency === 'string';
      if (!hasPaymentId || !hasAmount || typeof parsedBody?.status !== 'string') {
        isMalformed = true;
      }
      if (providerPaymentId !== undefined && parsedBody?.payment_id !== providerPaymentId) {
        isMalformed = true;
      }
      if (amount !== undefined && (
        parsedBody?.amount?.value !== Number(amount).toFixed(2)
        || parsedBody?.amount?.currency !== 'RUB'
      )) {
        isMalformed = true;
      }
    }

    if (isMalformed) {
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: false });
      throw this._toError(
        category, { operation: 'getRefund', providerRefundId, httpStatus: response.status }, YookassaGetRefundError,
      );
    }

    if (!response.ok) {
      // HTTP 400/401/403/404/500 официально документированы для этого
      // конкретного GET-эндпоинта (OpenAPI); 429/409/415 явно не
      // перечислены для GET (ожидаемо — нет idempotency-конфликта и body у
      // чтения), но общая классификация ниже корректно обработает и их,
      // если ЮKassa всё же их вернёт — без специального маппинга под
      // getRefund(), тот же принцип, что и у refund()/getStatus().
      const category = classifyProviderError({ httpStatus: response.status, isMutatingOperation: false });
      throw this._toError(
        category, { operation: 'getRefund', providerRefundId, httpStatus: response.status }, YookassaGetRefundError,
      );
    }

    const normalized = normalizeGetRefundStatus(parsedBody.status);
    if (normalized === null) {
      // Неизвестный/будущий refund-статус — не угадываем.
      const category = classifyProviderError({ isMalformed: true, isMutatingOperation: false });
      throw this._toError(
        category, { operation: 'getRefund', providerRefundId, httpStatus: response.status }, YookassaGetRefundError,
      );
    }
    return normalized;
  }

  // Production Switch — Stage 8. Официальная документация ЮKassa
  // (yookassa.ru/developers/using-api/webhooks, сверено перед реализацией)
  // НЕ описывает ни HMAC, ни какой-либо другой механизм подписи тела
  // уведомления — единственные официально рекомендованные способы убедиться
  // в подлинности: (а) IP-адрес отправителя из документированного списка
  // (см. isTrustedYookassaIp() ниже — используется маршрутом ДО вызова этого
  // метода, т.к. подключение/remote address не входит в контракт
  // verifyWebhook(rawBody, headers), см. providerInterface.js), (б)
  // переспросить канонический объект напрямую у ЮKassa по его id, СВОИМИ
  // собственными credentials, вместо того чтобы доверять полям тела
  // уведомления как таковым. Ниже реализован именно способ (б) — сильный,
  // самодостаточный механизм: подделать его может только тот, кто уже знает
  // секретный ключ магазина (тогда он и так мог бы напрямую вызвать
  // createPayment/refund) — тело САМОГО уведомления перестаёт быть
  // источником истины, оно только триггер "пойди проверь объект с этим id".
  // НЕ изобретается никакая подпись/HMAC, которых ЮKassa не предоставляет.
  async verifyWebhook(rawBody, _headers) {
    // Размер — defense-in-depth. Основной лимит — на уровне Express
    // (express.raw({limit}) в routes/postgresql/api.js) — эта проверка не
    // дублирует его бессмысленно: provider не должен неявно полагаться на
    // то, что вызывающий код всегда настроил лимит корректно.
    const bodyLength = typeof rawBody === 'string'
      ? Buffer.byteLength(rawBody, 'utf8')
      : (rawBody && typeof rawBody.length === 'number' ? rawBody.length : 0);
    if (bodyLength === 0 || bodyLength > WEBHOOK_BODY_MAX_BYTES) return null;

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null; // не JSON — не обрабатываем
    }
    if (!payload || typeof payload !== 'object') return null;
    if (payload.type !== 'notification') return null;

    // MVP-scope (см. YAAM-payment-capture-model-ADR.pdf: только СБП,
    // capture=true) — единственные два события, на которые реально
    // подписан магазин и которые реально обрабатываются
    // (routes/postgresql/api.js): payment.succeeded, payment.canceled.
    // Любой другой event (включая корректные, но не подписанные в этом MVP,
    // например refund.succeeded) — не наш случай, fail closed, НЕ угадываем.
    const expectedCanonicalStatus = SUPPORTED_WEBHOOK_EVENTS[payload.event];
    if (!expectedCanonicalStatus) return null;

    const object = payload.object;
    if (!object || typeof object.id !== 'string' || !object.id) return null;

    let canonicalStatus;
    try {
      // Переиспользует уже реализованный, отдельно протестированный
      // getStatus() — тот же HTTP-клиент/таймаут/классификация ошибок, что
      // и everywhere else в этом провайдере (reuse first).
      canonicalStatus = await this.getStatus(object.id);
    } catch (err) {
      console.error(`[yookassa] webhook canonical lookup failed for ${object.id}:`, err?.message || err);
      return null; // не удалось подтвердить — fail closed
    }

    if (canonicalStatus !== expectedCanonicalStatus) {
      // Уведомление утверждает одно, актуальное состояние на стороне
      // ЮKassa — другое (устаревшее/out-of-order сообщение либо подделка).
      // Безопасно отклонить именно ЭТО уведомление — если реальный статус
      // действительно succeeded/failed, следующее подлинное уведомление
      // (или сверочный sweep, см. orderService) даст верный результат.
      console.error(
        `[yookassa] webhook status mismatch for ${object.id}: notification claims ${payload.event}, canonical=${canonicalStatus}`
      );
      return null;
    }

    // amount/currency — то, что заявляет ТЕЛО уведомления (уже прошедшее
    // каноническую проверку id/статуса выше) — вызывающий код (webhook
    // route) обязан ДОПОЛНИТЕЛЬНО сверить их с суммой сохранённого платежа
    // из своей БД: getStatus() возвращает только нормализованную строку
    // статуса, не сумму, поэтому сверка суммы структурно не может произойти
    // здесь, в provider-слое, который ничего не знает о нашей БД.
    const amount = object.amount && typeof object.amount === 'object' ? object.amount.value : undefined;
    const currency = object.amount && typeof object.amount === 'object' ? object.amount.currency : undefined;

    return { providerPaymentId: object.id, status: canonicalStatus, amount, currency };
  }
}

// ---------------------------------------------------------------------------
// isTrustedYookassaIp(ip) — Production Switch Stage 8
// ---------------------------------------------------------------------------
//
// Официальный список диапазонов, из которых ЮKassa отправляет вебхуки (см.
// yookassa.ru/developers/using-api/webhooks, сверено перед реализацией).
// Используется ОПЦИОНАЛЬНО маршрутом (routes/postgresql/api.js) ДО вызова
// verifyWebhook() — не встроено внутрь самого verifyWebhook(), поскольку
// remote address запроса не входит в контракт providerInterface.js
// (rawBody, headers) и является HTTP-транспортным, а не платёжным понятием.
//
// ВАЖНОЕ ОГРАНИЧЕНИЕ (задокументировано, не скрыто): корректность этой
// проверки зависит от того, что req.ip реально отражает адрес клиента, а не
// адрес локального reverse-прокси — то есть от правильно настроенного
// доверия к прокси (тот же принцип, что TRUST_PROXY в SQLite server.js).
// Ни один реальный VPS/NGINX ещё не развёрнут (это Stage 9) — поэтому
// маршрут применяет эту проверку только если явно включена через ENV,
// оставляя канонический lookup выше ЕДИНСТВЕННЫМ обязательным механизмом
// подлинности до тех пор, пока Stage 9 не подтвердит корректность
// прокси-цепочки. Не является общей IPv6 CIDR-реализацией — только точечная
// проверка префикса для единственного официального IPv6-диапазона.
const YOOKASSA_IPV4_CIDR_RANGES = ['185.71.76.0/27', '185.71.77.0/27', '77.75.153.0/25', '77.75.154.128/25'];
const YOOKASSA_IPV4_EXACT = new Set(['77.75.156.11', '77.75.156.35']);
const YOOKASSA_IPV6_PREFIX = '2a02:5180:';

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [rangeIp, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(rangeIp);
  if (ipInt === null || rangeInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function isTrustedYookassaIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return false;
  // Некоторые прокси отдают IPv4 в IPv4-mapped IPv6 форме (::ffff:x.x.x.x).
  const ip = rawIp.replace(/^::ffff:/i, '');
  if (YOOKASSA_IPV4_EXACT.has(ip)) return true;
  if (YOOKASSA_IPV4_CIDR_RANGES.some((cidr) => ipv4InCidr(ip, cidr))) return true;
  if (ip.toLowerCase().startsWith(YOOKASSA_IPV6_PREFIX)) return true;
  return false;
}

module.exports = YookassaProvider;
module.exports.isTrustedYookassaIp = isTrustedYookassaIp;
