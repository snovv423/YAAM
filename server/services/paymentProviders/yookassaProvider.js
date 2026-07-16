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
const YOOKASSA_API_BASE_URL = 'https://api.yookassa.ru/v3';

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
    // idempotencyKey уже гарантированно непустая строка — проверено на
    // уровне paymentService.createPayment() до вызова любого провайдера
    // (см. server/services/paymentService.js); повторная проверка здесь была
    // бы избыточной защитой поверх уже существующей.
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

    const requestBody = {
      amount: { value: Number(amount).toFixed(2), currency: 'RUB' },
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
      const hasExpectedShape = typeof parsedBody?.id === 'string'
        && typeof parsedBody?.status === 'string'
        && typeof parsedBody?.confirmation === 'object'
        && parsedBody.confirmation !== null;
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

  _toError(category, context) {
    if (category === CATEGORIES.UNKNOWN_RESULT) return new ProviderResultUnknownError(context);
    return new YookassaCreatePaymentError(category, context);
  }

  async getStatus(_providerPaymentId) { throw new Error('not implemented'); }
  async refund(_providerPaymentId, _amount, _idempotencyKey) { throw new Error('not implemented'); }
  verifyWebhook(_rawBody, _headers) { throw new Error('not implemented'); }
}

module.exports = YookassaProvider;
