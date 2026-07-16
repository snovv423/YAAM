const PaymentProviderInterface = require('./providerInterface');
const {
  classifyProviderError,
  CATEGORIES,
  CATEGORY_RULES,
  ProviderResultUnknownError,
} = require('./providerErrorTaxonomy');

// ЮKassa, MVP-scope: только createPayment(), только СБП, только capture=true
// (см. YAAM-payment-capture-model-ADR.pdf — official-подтверждённый факт:
// СБП не поддерживает двухстадийную оплату, поэтому capture=false здесь
// сознательно не рассматривается — не "пока не сделали", а архитектурно не
// нужно для этого способа оплаты). getStatus/refund/verifyWebhook — всё ещё
// НЕ реализованы (отдельные задачи), каждый бросает свой explicit
// 'not implemented' — тем самым провайдер остаётся безопасно нерабочим как
// ЦЕЛОЕ (webhook/refund-путь сломается сразу и явно), даже когда createPayment
// уже реально работает с настоящими ключами.
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

// amount приходит от вызывающего кода (paymentService.js) как число рублей.
// Проверяем ДО сетевого вызова — провайдер не должен полагаться на то, что
// выше по стеку это уже сделали (defense-in-depth, тот же принцип, что и
// fail-closed проверка ключей/return_url в конструкторе/createPayment).
function validateAmount(amount, orderId) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw localValidationError('createPayment', { orderId }, 'amount должен быть конечным числом');
  }
  if (amount <= 0) {
    throw localValidationError('createPayment', { orderId }, 'amount должен быть строго больше нуля');
  }
  if (amount < SBP_MIN_AMOUNT_RUB || amount > SBP_MAX_AMOUNT_RUB) {
    throw localValidationError(
      'createPayment', { orderId },
      `amount вне поддерживаемого диапазона ЮKassa для СБП (${SBP_MIN_AMOUNT_RUB}..${SBP_MAX_AMOUNT_RUB} руб.)`,
    );
  }
  // Ровно два знака после запятой — без скрытого округления. Строковое
  // представление числа (не умножение на 100) специально выбрано, чтобы не
  // зависеть от погрешности плавающей точки при умножении/делении.
  if (!/^\d+(\.\d{1,2})?$/.test(String(amount))) {
    throw localValidationError('createPayment', { orderId }, 'amount не может иметь больше двух знаков после запятой');
  }
}

// idempotencyKey уже проверяется в paymentService.js выше по стеку, но
// провайдер, вызванный напрямую (в обход paymentService.js — например, из
// теста или будущего кода), не должен молча доверять этому и не должен молча
// нормализовать/обрезать значение перед отправкой в заголовке.
function validateIdempotencyKey(idempotencyKey, orderId) {
  if (typeof idempotencyKey !== 'string') {
    throw localValidationError('createPayment', { orderId }, 'idempotencyKey должен быть строкой');
  }
  if (idempotencyKey.trim().length === 0) {
    throw localValidationError('createPayment', { orderId }, 'idempotencyKey не может быть пустым');
  }
  if (idempotencyKey.length > IDEMPOTENCE_KEY_MAX_LENGTH) {
    throw localValidationError(
      'createPayment', { orderId },
      `idempotencyKey длиннее ${IDEMPOTENCE_KEY_MAX_LENGTH} символов (официальный лимит ЮKassa)`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(idempotencyKey)) {
    throw localValidationError('createPayment', { orderId }, 'idempotencyKey содержит недопустимые управляющие символы');
  }
}

// providerPaymentId уже гарантированно непустая строка на уровне
// paymentService.js (хранится как payments.provider_payment_id из
// собственного успешного createPayment()), но provider, вызванный напрямую,
// не должен молча доверять этому — тот же defense-in-depth принцип, что и у
// validateAmount()/validateIdempotencyKey().
function validateProviderPaymentId(providerPaymentId) {
  if (typeof providerPaymentId !== 'string' || providerPaymentId.trim().length === 0) {
    throw localValidationError(
      'getStatus', { providerPaymentId }, 'providerPaymentId должен быть непустой строкой', YookassaGetStatusError,
    );
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
    validateAmount(amount, orderId);
    validateIdempotencyKey(idempotencyKey, orderId);

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
      // Тот же fail-loud принцип, что и в createPayment(): успешный HTTP-статус
      // ещё не значит, что телу можно доверять. id — непустая строка (не просто
      // typeof==='string' — извлечённый вывод из предыдущего review createPayment,
      // применённый здесь сразу, а не как отложенный технический долг).
      const hasExpectedShape = typeof parsedBody?.id === 'string' && parsedBody.id.length > 0
        && typeof parsedBody?.status === 'string';
      if (!hasExpectedShape) isMalformed = true;
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

  async refund(_providerPaymentId, _amount, _idempotencyKey) { throw new Error('not implemented'); }
  verifyWebhook(_rawBody, _headers) { throw new Error('not implemented'); }
}

module.exports = YookassaProvider;
