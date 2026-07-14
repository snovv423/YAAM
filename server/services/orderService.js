const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const db = require('../db');
const payments = require('./paymentService');
const orderAccess = require('./orderAccessService');

// Другие модули (бот, будущий SSE для клиента) подписываются на события заказа
// через orderEvents — orderService ничего не знает про бота напрямую, это и
// есть развязка, которая позволяет менять/добавлять получателей уведомлений
// без правок в самом сервисе заказов.
const orderEvents = new EventEmitter();

const RESTAURANT_RESPONSE_WINDOW_SEC = 180;
const RATING_ELIGIBLE_STATUS = 'delivered';
const initialAttemptInFlight = new Map();
const retryAttemptInFlight = new Map();

class OrderCreationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderCreationInputError';
    this.statusCode = 400;
  }
}

class PaymentInitialUnavailableError extends Error {
  constructor() {
    super('Платёжный сервис временно недоступен — повторите оформление заказа');
    this.name = 'PaymentInitialUnavailableError';
    this.statusCode = 503;
  }
}

class PaymentInitialInvariantError extends Error {
  constructor(internalMessage) {
    super('Не удалось безопасно завершить создание платежа');
    this.name = 'PaymentInitialInvariantError';
    this.statusCode = 500;
    this.internalMessage = internalMessage;
  }
}

class OrderCreationRecoveryNotFoundError extends Error {
  constructor() {
    super('заказ не найден');
    this.name = 'OrderCreationRecoveryNotFoundError';
    this.statusCode = 404;
  }
}

class PaymentRetryConflictError extends Error {
  constructor(message = 'Повторная попытка оплаты уже завершена или недоступна') {
    super(message);
    this.name = 'PaymentRetryConflictError';
    this.statusCode = 409;
  }
}

class PaymentRetryUnavailableError extends Error {
  constructor() {
    super('Платёжный сервис временно недоступен — повторите попытку');
    this.name = 'PaymentRetryUnavailableError';
    this.statusCode = 503;
  }
}

class PaymentRetryInvariantError extends Error {
  constructor(internalMessage) {
    super('Не удалось безопасно завершить платёжную попытку');
    this.name = 'PaymentRetryInvariantError';
    this.statusCode = 500;
    this.internalMessage = internalMessage;
  }
}

function providerCreateTimeoutMs() {
  const configured = Number(process.env.PAYMENT_CREATE_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

async function createPaymentWithTimeout(params) {
  let timer;
  try {
    return await Promise.race([
      payments.createPayment(params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('payment provider timeout')), providerCreateTimeoutMs());
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function paymentInvariant(message) {
  console.error(`[orderService] payment retry invariant: ${message}`);
  return new PaymentRetryInvariantError(message);
}

function initialPaymentInvariant(message) {
  console.error(`[orderService] initial payment invariant: ${message}`);
  return new PaymentInitialInvariantError(message);
}

// UUID v4 укладывается в ограничение Idempotence-Key реальных провайдеров и
// остаётся непривязанным к публичному номеру заказа или клиентскому секрету.
function newProviderIdempotencyKey() {
  return crypto.randomUUID();
}

// Временная demo-логика: у awaiting_payment пока нет полноценного серверного
// payment_expires_at (это отдельная задача для этапа реальной ЮKassa — там же
// появится и sweep). До тех пор дедуп в createOrder() ниже не должен считать
// брошенный неоплаченный заказ бессрочно активным, иначе один и тот же телефон
// навсегда блокируется от новой попытки заказа в этом ресторане. 15 минут —
// продуктовое решение (уточнено после 30 минут), с запасом над QR_TIMER_SEC
// (10 мин, то, что реально видит покупатель на экране оплаты).
const AWAITING_PAYMENT_DEDUP_TTL_SEC = 15 * 60;

// Варианты «перерыва» ресторана — фиксированные пресеты, а не произвольный ввод.
const PAUSE_PRESETS_MIN = { short: 33, medium: 3 * 60, long: 11 * 60 };

// Публичный номер заказа строится из внутреннего id (SQLite AUTOINCREMENT —
// уникален, монотонно растёт, никогда не переиспользуется), а не из случайного
// числа: YAAM-00001, YAAM-00002 ... минимум 5 цифр, дальше просто растёт вширь.
function formatPublicCode(id) {
  return `YAAM-${String(id).padStart(5, '0')}`;
}

// Зеркало normalizeRuPhone() из client/js/app.js — общего бандлера между
// клиентом и сервером нет, поэтому логика продублирована; при правке одной
// стороны обязательно поправить и вторую. Приводит российский номер к виду
// "+7XXXXXXXXXX" (11 цифр после +, начинается на 7); null — если номер битый
// или заведомо не российский. Не доверяем фронту — сервер валидирует и
// нормализует заново, а не просто принимает то, что прислал клиент.
function normalizeRuPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  if (d.length !== 11 || d[0] !== '7') return null;
  return `+${d}`;
}

function paymentResultFromRow(paymentRow) {
  if (!paymentRow || !paymentRow.provider_payment_id) return null;
  const presentation = db.prepare(`
    SELECT payment_url, qr_payload FROM payment_presentations WHERE payment_id = ?
  `).get(paymentRow.id);
  if (!presentation) return null;
  return {
    providerPaymentId: paymentRow.provider_payment_id,
    paymentUrl: presentation.payment_url || null,
    qrPayload: presentation.qr_payload || null,
  };
}

function orderCreationContext(orderId) {
  const order = db.prepare(`
    SELECT restaurant_id, created_at FROM orders WHERE id = ?
  `).get(orderId);
  if (!order) throw initialPaymentInvariant('заказ для creation context не найден');
  const items = db.prepare(`
    SELECT name, price, qty FROM order_items WHERE order_id = ? ORDER BY id
  `).all(orderId);
  return {
    restaurantId: order.restaurant_id,
    createdAt: order.created_at,
    items,
  };
}

function initialAttemptRowByCredentials(tokenHash, createKeyHash) {
  return db.prepare(`
    SELECT p.*, p.order_id AS initial_order_id,
      a.provider_idempotency_key, a.state AS initial_state,
      c.request_hash
    FROM order_access_credentials c
    JOIN payments p ON p.order_id = c.order_id
    LEFT JOIN payment_initial_attempts a ON a.payment_id = p.id
    WHERE c.token_hash = ? AND c.create_key_hash = ?
    ORDER BY CASE WHEN a.payment_id IS NOT NULL THEN 0 ELSE 1 END, p.id ASC
    LIMIT 1
  `).get(tokenHash, createKeyHash);
}

function activePaymentRowByOrder(orderId) {
  return db.prepare(`
    SELECT p.*,
      i.provider_idempotency_key AS initial_provider_idempotency_key,
      i.state AS initial_state,
      r.provider_idempotency_key AS retry_provider_idempotency_key,
      r.state AS retry_state
    FROM payments p
    LEFT JOIN payment_initial_attempts i ON i.payment_id = p.id
    LEFT JOIN payment_retry_attempts r ON r.payment_id = p.id
    WHERE p.order_id = ? AND p.status IN ('creating', 'pending')
    ORDER BY p.id DESC LIMIT 1
  `).get(orderId);
}

function finalizeInitialAttempt(paymentRowId, payment) {
  return db.immediateTransaction(() => {
    const attempt = db.prepare(`
      SELECT p.*, a.provider_idempotency_key, a.state AS initial_state,
        o.status AS order_status
      FROM payments p JOIN payment_initial_attempts a ON a.payment_id = p.id
      JOIN orders o ON o.id = p.order_id
      WHERE p.id = ?
    `).get(paymentRowId);
    if (!attempt) throw initialPaymentInvariant('зарезервированный первоначальный платёж не найден');
    if (attempt.order_status !== 'awaiting_payment') {
      throw initialPaymentInvariant('статус заказа изменился во время создания платежа; требуется сверка');
    }
    if (attempt.initial_state === 'ready') {
      if (attempt.provider_payment_id !== payment.providerPaymentId) {
        throw initialPaymentInvariant('провайдер вернул другой первоначальный платёж для того же ключа');
      }
      const existing = paymentResultFromRow(attempt);
      if (!existing) throw initialPaymentInvariant('готовый первоначальный платёж не содержит presentation');
      return existing;
    }
    if (attempt.initial_state !== 'creating' || attempt.status !== 'creating') {
      throw initialPaymentInvariant('первоначальный платёж находится в несовместимом состоянии');
    }
    const finalized = db.prepare(`
      UPDATE payments
      SET provider_payment_id = ?, status = 'pending', updated_at = datetime('now')
      WHERE id = ? AND status = 'creating'
    `).run(payment.providerPaymentId, paymentRowId);
    if (finalized.changes !== 1) {
      throw initialPaymentInvariant('не удалось финализировать первоначальный платёж');
    }
    db.prepare(`
      INSERT INTO payment_presentations (payment_id, payment_url, qr_payload)
      VALUES (?, ?, ?)
      ON CONFLICT(payment_id) DO UPDATE SET
        payment_url = excluded.payment_url,
        qr_payload = excluded.qr_payload
    `).run(paymentRowId, payment.paymentUrl || null, payment.qrPayload || null);
    const ready = db.prepare(`
      UPDATE payment_initial_attempts
      SET state = 'ready', updated_at = datetime('now')
      WHERE payment_id = ? AND state = 'creating'
    `).run(paymentRowId);
    if (ready.changes !== 1) {
      throw initialPaymentInvariant('ledger первоначального платежа не перешёл в ready');
    }
    return paymentResultFromRow(db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentRowId));
  })();
}

async function ensureInitialAttemptReady(attempt) {
  if (!attempt) throw initialPaymentInvariant('первоначальная платёжная попытка не найдена');

  const currentOrder = getOrder(attempt.order_id);
  if (!currentOrder) throw initialPaymentInvariant('заказ первоначальной попытки не найден');
  // Exact replay терминального/уже оплаченного заказа не должен
  // повторно вызывать провайдера или возвращать старую ссылку оплаты.
  if (currentOrder.status !== 'awaiting_payment') return null;

  // Совместимость с заказами, созданными до появления initial-ledger: если
  // provider id уже надёжно сохранён, старую presentation можно вернуть без
  // повторного внешнего запроса. Неоднозначный NULL намеренно не угадываем.
  if (!attempt.initial_state) {
    const legacy = paymentResultFromRow(attempt);
    if (legacy) return legacy;
    throw initialPaymentInvariant('legacy-платёж без provider id требует ручной сверки');
  }
  if (attempt.initial_state === 'ready') {
    const existing = paymentResultFromRow(attempt);
    if (!existing) throw initialPaymentInvariant('готовый первоначальный платёж не содержит данных продолжения');
    return existing;
  }
  if (attempt.initial_state !== 'creating' || attempt.status !== 'creating'
    || !attempt.provider_idempotency_key) {
    throw initialPaymentInvariant('первоначальная платёжная попытка повреждена');
  }
  if (initialAttemptInFlight.has(attempt.id)) return initialAttemptInFlight.get(attempt.id);

  const operation = (async () => {
    const order = getOrder(attempt.order_id);
    if (!order) throw initialPaymentInvariant('заказ первоначальной попытки не найден');
    if (order.status !== 'awaiting_payment') return null;
    let payment;
    try {
      payment = await createPaymentWithTimeout({
        orderId: attempt.order_id,
        amount: attempt.amount,
        description: `Заказ ${order.public_code}`,
        idempotencyKey: attempt.provider_idempotency_key,
      });
    } catch (err) {
      // Неизвестно, успел ли провайдер создать платёж. Сохраняем creating и
      // постоянный ключ: следующий точный replay безопасно продолжит операцию.
      console.error(`[orderService] initial provider unavailable payment=${attempt.id} type=${err?.name || 'Error'}`);
      throw new PaymentInitialUnavailableError();
    }
    if (!payment || !payment.providerPaymentId) {
      throw initialPaymentInvariant('провайдер не вернул id первоначального платежа');
    }
    return finalizeInitialAttempt(attempt.id, payment);
  })();
  initialAttemptInFlight.set(attempt.id, operation);
  try {
    return await operation;
  } finally {
    if (initialAttemptInFlight.get(attempt.id) === operation) initialAttemptInFlight.delete(attempt.id);
  }
}

function getOrder(idOrCode) {
  const row = Number.isInteger(idOrCode)
    ? db.prepare(`
        SELECT o.*, r.name AS restaurant_name, r.phone AS restaurant_phone
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.id = ?
      `).get(idOrCode)
    : db.prepare(`
        SELECT o.*, r.name AS restaurant_name, r.phone AS restaurant_phone
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.public_code = ?
      `).get(idOrCode);
  if (!row) return null;
  const items = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?').all(row.id);
  return { ...row, items };
}

// Публичная проекция заказа — единственный источник для того, что уходит по
// сети клиенту после capability-проверки (см. GET /api/orders/:code).
// public_code последовательный и перебираемый (YAAM-00001, 00002...), поэтому
// здесь сознательно НЕ отдаются customer_name/customer_phone/address/comment
// (ПДн), commission_amount (внутренняя бизнес-цифра), внутренний id/restaurant_id
// и прочие поля, не используемые текущим клиентом (client/js/app.js:
// pollOrderOnce()/resumeExistingPayment()). Использовать ТОЛЬКО в публичном
// HTTP-обработчике — orderService.getOrder() для бота/админки/внутренних
// вызовов остаётся полным, им нужен полный объект (см. bot/index.js).
function toPublicOrderDTO(order) {
  if (!order) return null;
  const {
    public_code, status, status_updated_at, items_total,
    estimated_ready_minutes, restaurant_phone, fulfillment_type, rating,
  } = order;
  return {
    public_code, status, status_updated_at, items_total,
    estimated_ready_minutes, restaurant_phone, fulfillment_type, rating,
  };
}

// Платёжный DTO не раскрывает внутренний provider_payment_id. Для клиента
// нужны только данные, позволяющие открыть подтверждение оплаты. Dev/mock
// подтверждение теперь адресуется по заказу и защищается order token.
function toPublicPaymentDTO(payment) {
  if (!payment) return null;
  return {
    paymentUrl: payment.paymentUrl || null,
    qrPayload: payment.qrPayload || null,
  };
}

function creationResult(order, payment) {
  return {
    order,
    payment,
    context: orderCreationContext(order.id),
  };
}

// И exact replay POST /orders, и body-less POST /orders/recover проходят
// через одну точку. Здесь важен текущий active-платёж заказа, а не
// исторически первая попытка: после payment_failed + retry старый QR
// возвращать нельзя. Не-awaiting заказ вообще не трогает provider.
async function resolveCreationOrder(orderId) {
  let order = getOrder(orderId);
  if (!order) throw new OrderCreationRecoveryNotFoundError();
  if (order.status !== 'awaiting_payment') return creationResult(order, null);

  const active = activePaymentRowByOrder(orderId);
  if (!active) {
    // Webhook/cancel могли поменять статус между двумя SELECT.
    order = getOrder(orderId);
    if (order && order.status !== 'awaiting_payment') return creationResult(order, null);
    throw initialPaymentInvariant('awaiting_payment заказ не содержит active-платежа');
  }

  let payment;
  if (active.initial_state) {
    payment = await ensureInitialAttemptReady({
      ...active,
      provider_idempotency_key: active.initial_provider_idempotency_key,
    });
  } else if (active.retry_state) {
    payment = await ensureRetryAttemptReady({
      ...active,
      provider_idempotency_key: active.retry_provider_idempotency_key,
    });
  } else if (active.status === 'pending') {
    // Аддитивная совместимость с legacy ready-платежом, у которого ещё
    // нет ledger. Presentation-строка обязательна; её отсутствие fail-closed.
    payment = paymentResultFromRow(active);
    if (!payment) throw initialPaymentInvariant('legacy active-платёж не содержит presentation');
  } else {
    throw initialPaymentInvariant('creating active-платёж не имеет durable ledger');
  }

  order = getOrder(orderId);
  if (!order) throw new OrderCreationRecoveryNotFoundError();
  // Оплата/отмена могла завершиться, пока мы ждали provider. Текущий
  // серверный статус всегда старше уже полученной presentation.
  return creationResult(order, order.status === 'awaiting_payment' ? payment : null);
}

async function recoverOrder({ orderAccessToken, createIdempotencyKey }) {
  const { tokenHash, createKeyHash } = orderAccess.requireValidCreationSecrets(
    orderAccessToken,
    createIdempotencyKey,
  );
  const attempt = initialAttemptRowByCredentials(tokenHash, createKeyHash);
  if (!attempt) throw new OrderCreationRecoveryNotFoundError();
  return resolveCreationOrder(attempt.initial_order_id);
}

async function createOrder({
  restaurantId, city, customerName, customerPhone, address, comment, items,
  fulfillmentType, orderAccessToken, createIdempotencyKey,
}) {
  const { tokenHash, createKeyHash } = orderAccess.requireValidCreationSecrets(
    orderAccessToken,
    createIdempotencyKey,
  );
  if (!customerName || !customerName.trim()) throw new OrderCreationInputError('customerName обязателен');
  const normalizedPhone = normalizeRuPhone(customerPhone);
  if (!normalizedPhone) throw new OrderCreationInputError('укажите корректный номер телефона');
  if (!items || !items.length) throw new OrderCreationInputError('корзина пуста');

  const normalizedFulfillment = fulfillmentType === 'pickup' ? 'pickup' : 'delivery';
  const normalizedCustomerName = customerName.trim();
  const normalizedAddress = address || '';
  const normalizedComment = comment || '';
  const requestedItems = items.map((item) => {
    const menuItemId = Number(item.menuItemId);
    if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
      throw new OrderCreationInputError('в заказе есть позиция без корректного блюда из меню');
    }
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new OrderCreationInputError(`некорректное количество для «${item.name || menuItemId}»`);
    }
    return { menuItemId, qty, clientName: item.name };
  });
  const canonicalItems = requestedItems
    .map(({ menuItemId, qty }) => ({ menuItemId, qty }))
    .sort((a, b) => a.menuItemId - b.menuItemId || a.qty - b.qty);
  const requestHash = orderAccess.hashCreationRequest({
    restaurantId: Number(restaurantId),
    city: city || '',
    customerName: normalizedCustomerName,
    customerPhone: normalizedPhone,
    address: normalizedAddress,
    comment: normalizedComment,
    fulfillmentType: normalizedFulfillment,
    items: canonicalItems,
  });

  // Идемпотентный replay не должен зависеть от изменчивого меню или текущего
  // режима ресторана. После первого COMMIT сервер уже зафиксировал снимок заказа;
  // владелец с той же парой секретов и тем же request hash продолжает именно его.
  const existingAttempt = initialAttemptRowByCredentials(tokenHash, createKeyHash);
  if (existingAttempt) {
    if (!Buffer.from(existingAttempt.request_hash).equals(Buffer.from(requestHash))) {
      throw new orderAccess.ActiveOrderConflictError();
    }
    return resolveCreationOrder(existingAttempt.initial_order_id);
  }

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId);
  if (!restaurant) throw new OrderCreationInputError('ресторан не найден');
  if (!restaurant.is_open) throw new OrderCreationInputError('ресторан сейчас закрыт — заказ невозможен');

  // Клиент присылает name/price/menuItemId вместе с корзиной, но это его
  // собственные данные, а не источник истины — их нельзя доверять напрямую.
  // menuItemId обязателен для КАЖДОЙ позиции: у нас нет ни одного легитимного
  // сценария заказа без него (UI всегда знает id блюда из меню, которое само
  // получено с бэкенда). Раньше отсутствие menuItemId просто пропускало
  // проверку и позиция уходила в заказ с ценой/названием как есть от клиента —
  // прямой вызов API в обход браузера мог занизить сумму до чего угодно.
  const trustedItems = requestedItems.map(({ menuItemId, qty, clientName }) => {
    const real = db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(menuItemId, restaurantId);
    if (!real) throw new OrderCreationInputError(`блюдо не найдено: ${clientName || menuItemId}`);
    if (!real.is_available) throw new OrderCreationInputError(`блюдо «${real.name}» сейчас в стоп-листе`);
    return { menuItemId, name: real.name, price: real.price, qty };
  });

  const itemsTotal = trustedItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (itemsTotal < restaurant.min_order) {
    throw new OrderCreationInputError(`сумма заказа ${itemsTotal} меньше минимальной ${restaurant.min_order}`);
  }
  const commission = payments.calcCommission(itemsTotal);

  const insertOrder = db.prepare(`
    INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
    VALUES (:public_code, :restaurant_id, :city, :customer_name, :customer_phone, :address, :fulfillment_type, :comment, :items_total, :commission_amount, 'awaiting_payment')
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)
  `);

  // BEGIN IMMEDIATE объединяет точный replay, защиту от чужого активного заказа
  // и резервацию первоначального платежа в одну сериализованную операцию.
  // Внешний провайдер вызывается уже после COMMIT — SQLite-транзакция не держит
  // сетевой await, но durable provider key существует до первого запроса наружу.
  const { orderId } = db.immediateTransaction(() => {
    const exactReplay = initialAttemptRowByCredentials(tokenHash, createKeyHash);
    if (exactReplay) {
      const sameRequest = Buffer.from(exactReplay.request_hash).equals(Buffer.from(requestHash));
      if (!sameRequest) throw new orderAccess.ActiveOrderConflictError();
      return { orderId: exactReplay.initial_order_id };
    }

    // Другая пара секретов не получает сведения о свежем заказе этого клиента и
    // не создаёт второй заказ. Точный владелец уже обработан веткой выше.
    const conflictingOrder = db.prepare(`
      SELECT id FROM orders
      WHERE restaurant_id = ? AND customer_phone = ? AND status = 'awaiting_payment'
        AND (
          (strftime('%s','now') - strftime('%s', created_at)) <= ?
          OR EXISTS (
            SELECT 1 FROM payments p
            WHERE p.order_id = orders.id AND p.status = 'creating'
          )
        )
      ORDER BY id DESC LIMIT 1
    `).get(restaurantId, normalizedPhone, AWAITING_PAYMENT_DEDUP_TTL_SEC);
    if (conflictingOrder || orderAccess.secretsAlreadyUsed(tokenHash, createKeyHash)) {
      throw new orderAccess.ActiveOrderConflictError();
    }

    // public_code зависит от id, который SQLite присвоит только при вставке —
    // сначала пишем временный уникальный плейсхолдер (чтобы пройти NOT NULL
    // UNIQUE), затем в той же транзакции сразу заменяем его на настоящий код.
    // Гонка исключена конструктивно: node:sqlite синхронный, вся эта функция
    // выполняется одним блоком без интерливинга с другим createOrder().
    const info = insertOrder.run({
      public_code: `TMP-${process.hrtime.bigint()}`,
      restaurant_id: restaurantId,
      city,
      customer_name: normalizedCustomerName,
      customer_phone: normalizedPhone,
      address: normalizedAddress,
      fulfillment_type: normalizedFulfillment,
      comment: normalizedComment,
      items_total: itemsTotal,
      commission_amount: commission,
    });
    const newId = info.lastInsertRowid;
    db.prepare('UPDATE orders SET public_code = ? WHERE id = ?').run(formatPublicCode(newId), newId);
    orderAccess.insertCredential(newId, tokenHash, createKeyHash, requestHash);
    for (const it of trustedItems) {
      insertItem.run(newId, it.menuItemId, it.name, it.price, it.qty);
    }
    // Статус creating означает: локальная попытка зарезервирована, но результат
    // провайдера ещё неизвестен. pending ставится только атомарной финализацией.
    const payInfo = db.prepare(`
      INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
      VALUES (?, ?, NULL, ?, 'creating')
    `).run(newId, payments.providerName, itemsTotal);
    db.prepare(`
      INSERT INTO payment_initial_attempts (payment_id, provider_idempotency_key, state)
      VALUES (?, ?, 'creating')
    `).run(payInfo.lastInsertRowid, newProviderIdempotencyKey());
    return { orderId: newId };
  })();

  return resolveCreationOrder(orderId);
}

function setStatus(orderId, status) {
  db.prepare('UPDATE orders SET status = ?, status_updated_at = datetime(\'now\') WHERE id = ?').run(status, orderId);
  const order = getOrder(orderId);
  orderEvents.emit('order:status', order);
  return order;
}

// Вызывается вебхуком/dev-роутом оплаты, когда провайдер подтвердил платёж.
function markPaid(orderId, paymentId) {
  if (!Number.isInteger(paymentId)) throw new Error('paymentId обязателен для подтверждения оплаты');
  const changed = db.immediateTransaction(() => {
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!order || order.status !== 'awaiting_payment') return false;
    const payment = db.prepare(
      "SELECT id FROM payments WHERE id = ? AND order_id = ? AND status = 'pending'",
    ).get(paymentId, orderId);
    if (!payment) return false;
    const paid = db.prepare(`
      UPDATE payments SET status = 'succeeded', updated_at = datetime('now')
      WHERE id = ? AND order_id = ? AND status = 'pending'
    `).run(payment.id, orderId);
    if (paid.changes !== 1) return false;
    const advanced = db.prepare(`
      UPDATE orders SET status = 'awaiting_restaurant', status_updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_payment'
    `).run(orderId);
    if (advanced.changes !== 1) throw new Error('не удалось атомарно подтвердить оплату заказа');
    return true;
  })();
  const updated = getOrder(orderId);
  if (changed) {
    orderEvents.emit('order:status', updated);
    orderEvents.emit('order:new', updated); // сюда подписан бот — уйдёт уведомление ресторану
  }
  return updated;
}

function markPaymentFailed(orderId, paymentId) {
  if (!Number.isInteger(paymentId)) throw new Error('paymentId обязателен для ошибки оплаты');
  const changed = db.immediateTransaction(() => {
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!order || order.status !== 'awaiting_payment') return false;
    const payment = db.prepare(
      "SELECT id FROM payments WHERE id = ? AND order_id = ? AND status = 'pending'",
    ).get(paymentId, orderId);
    if (!payment) return false;
    const failed = db.prepare(`
      UPDATE payments SET status = 'failed', updated_at = datetime('now')
      WHERE id = ? AND order_id = ? AND status = 'pending'
    `).run(payment.id, orderId);
    if (failed.changes !== 1) return false;
    const updated = db.prepare(`
      UPDATE orders SET status = 'payment_failed', status_updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_payment'
    `).run(orderId);
    if (updated.changes !== 1) throw new Error('не удалось атомарно зафиксировать ошибку оплаты');
    return true;
  })();
  const updated = getOrder(orderId);
  if (changed) orderEvents.emit('order:status', updated);
  return updated;
}

function retryAttemptRowByClientKey(clientKeyHash) {
  return db.prepare(`
    SELECT p.*, p.order_id AS retry_order_id, a.provider_idempotency_key, a.state AS retry_state
    FROM payment_retry_keys k
    JOIN payment_retry_attempts a ON a.payment_id = k.payment_id
    JOIN payments p ON p.id = a.payment_id
    WHERE k.client_key_hash = ?
  `).get(clientKeyHash);
}

function activeRetryAttemptRow(orderId) {
  return db.prepare(`
    SELECT p.*, p.order_id AS retry_order_id, a.provider_idempotency_key, a.state AS retry_state
    FROM payments p
    LEFT JOIN payment_retry_attempts a ON a.payment_id = p.id
    WHERE p.order_id = ? AND p.status IN ('creating', 'pending')
    ORDER BY p.id DESC LIMIT 1
  `).get(orderId);
}

// Резервация выполняется целиком до первого await и под BEGIN IMMEDIATE.
// Поэтому два параллельных retry не успеют оба увидеть «пусто» и вставить две
// попытки; partial UNIQUE-индекс остаётся последним барьером на уровне БД.
function reserveRetryAttempt(orderId, retryKey) {
  if (!orderAccess.isValidRetryKey(retryKey)) {
    throw new orderAccess.OrderAccessInputError('Некорректный ключ повторной оплаты');
  }
  const clientKeyHash = orderAccess.hashSecret(retryKey);
  return db.immediateTransaction(() => {
    const sameKey = retryAttemptRowByClientKey(clientKeyHash);
    if (sameKey) {
      if (sameKey.retry_order_id !== orderId) throw new PaymentRetryConflictError();
      if (['creating', 'pending'].includes(sameKey.status)) return sameKey;
      throw new PaymentRetryConflictError('Предыдущая попытка оплаты завершена — начните новую');
    }

    // Другой ключ из второй вкладки/устройства не создаёт второй платёж: при
    // наличии bearer-доступа оба запроса сходятся к уже активной попытке.
    const active = activeRetryAttemptRow(orderId);
    if (active) {
      if (!active.provider_idempotency_key) throw new PaymentRetryConflictError();
      db.prepare(`
        INSERT INTO payment_retry_keys (client_key_hash, payment_id) VALUES (?, ?)
      `).run(clientKeyHash, active.id);
      return active;
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('заказ не найден');
    if (order.status !== 'payment_failed') {
      throw new PaymentRetryConflictError('Повторная оплата возможна только после ошибки оплаты');
    }

    const paymentInfo = db.prepare(`
      INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
      VALUES (?, ?, NULL, ?, 'creating')
    `).run(orderId, payments.providerName, order.items_total);
    const providerIdempotencyKey = newProviderIdempotencyKey();
    db.prepare(`
      INSERT INTO payment_retry_attempts (payment_id, provider_idempotency_key, state)
      VALUES (?, ?, 'creating')
    `).run(paymentInfo.lastInsertRowid, providerIdempotencyKey);
    db.prepare(`
      INSERT INTO payment_retry_keys (client_key_hash, payment_id) VALUES (?, ?)
    `).run(clientKeyHash, paymentInfo.lastInsertRowid);
    return activeRetryAttemptRow(orderId);
  })();
}

function finalizeRetryAttempt(paymentRowId, payment) {
  let orderTransitioned = false;
  const result = db.immediateTransaction(() => {
    const attempt = db.prepare(`
      SELECT p.*, r.provider_idempotency_key
      FROM payments p JOIN payment_retry_attempts r ON r.payment_id = p.id
      WHERE p.id = ?
    `).get(paymentRowId);
    if (!attempt) throw paymentInvariant('зарезервированная попытка оплаты не найдена');
    if (attempt.status === 'pending') {
      if (attempt.provider_payment_id !== payment.providerPaymentId) {
        throw paymentInvariant('провайдер вернул другой платёж для того же ключа идемпотентности');
      }
      return paymentResultFromRow(attempt);
    }
    if (attempt.status !== 'creating') throw new PaymentRetryConflictError();
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(attempt.order_id);
    if (!order || order.status !== 'payment_failed') {
      throw paymentInvariant('состояние заказа изменилось во время создания платежа; требуется сверка');
    }
    const finalized = db.prepare(`
      UPDATE payments
      SET provider_payment_id = ?, status = 'pending', updated_at = datetime('now')
      WHERE id = ? AND status = 'creating'
    `).run(payment.providerPaymentId, paymentRowId);
    if (finalized.changes !== 1) throw paymentInvariant('не удалось финализировать платёжную попытку');
    db.prepare(`
      INSERT INTO payment_presentations (payment_id, payment_url, qr_payload)
      VALUES (?, ?, ?)
      ON CONFLICT(payment_id) DO UPDATE SET
        payment_url = excluded.payment_url,
        qr_payload = excluded.qr_payload
    `).run(paymentRowId, payment.paymentUrl || null, payment.qrPayload || null);
    const retryReady = db.prepare(`
      UPDATE payment_retry_attempts
      SET state = 'ready', updated_at = datetime('now')
      WHERE payment_id = ? AND state = 'creating'
    `).run(paymentRowId);
    if (retryReady.changes !== 1) throw paymentInvariant('ledger повторной оплаты не перешёл в ready');
    const updatedOrder = db.prepare(`
      UPDATE orders SET status = 'awaiting_payment', status_updated_at = datetime('now')
      WHERE id = ? AND status = 'payment_failed'
    `).run(attempt.order_id);
    if (updatedOrder.changes !== 1) throw paymentInvariant('не удалось активировать повторную оплату');
    orderTransitioned = true;
    return paymentResultFromRow(db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentRowId));
  })();
  if (orderTransitioned) orderEvents.emit('order:status', getOrder(db.prepare('SELECT order_id FROM payments WHERE id = ?').get(paymentRowId).order_id));
  return result;
}

async function ensureRetryAttemptReady(attempt) {
  if (!attempt) throw new Error('платёжная попытка не найдена');
  if (attempt.status === 'pending') {
    const existing = paymentResultFromRow(attempt);
    if (!existing) throw paymentInvariant('активный платёж не содержит данных продолжения');
    return existing;
  }
  if (attempt.status !== 'creating' || !attempt.provider_idempotency_key) {
    throw new PaymentRetryConflictError();
  }
  if (retryAttemptInFlight.has(attempt.id)) return retryAttemptInFlight.get(attempt.id);

  const operation = (async () => {
    const order = getOrder(attempt.order_id);
    if (!order) throw paymentInvariant('заказ зарезервированной попытки не найден');
    let payment;
    try {
      payment = await createPaymentWithTimeout({
        orderId: attempt.order_id,
        amount: attempt.amount,
        description: `Заказ ${order.public_code} (повторная попытка)`,
        idempotencyKey: attempt.provider_idempotency_key,
      });
    } catch (err) {
      // Не знаем, успел ли внешний провайдер создать платёж до сетевой ошибки.
      // Поэтому строку creating не удаляем и не создаём новую: следующий запрос
      // повторит тот же provider idempotency key и безопасно продолжит попытку.
      console.error(`[orderService] retry provider unavailable payment=${attempt.id} type=${err?.name || 'Error'}`);
      throw new PaymentRetryUnavailableError();
    }
    if (!payment || !payment.providerPaymentId) {
      throw paymentInvariant('провайдер не вернул id платежа');
    }
    // Ошибки БД/инвариантов не маскируем под сетевой 503: они должны выйти как
    // серверная ошибка и остаться видимыми в журнале для ручной сверки.
    return finalizeRetryAttempt(attempt.id, payment);
  })();
  retryAttemptInFlight.set(attempt.id, operation);
  try {
    return await operation;
  } finally {
    if (retryAttemptInFlight.get(attempt.id) === operation) retryAttemptInFlight.delete(attempt.id);
  }
}

// Повторная попытка оплаты после payment_failed остаётся тем же заказом. Один
// и тот же или параллельный запрос всегда возвращает одну presentation.
async function retryPayment(orderId, retryKey) {
  const attempt = reserveRetryAttempt(orderId, retryKey);
  return ensureRetryAttemptReady(attempt);
}

async function refundOrder(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  const payment = db.prepare(
    "SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1"
  ).get(orderId);
  if (payment) {
    await payments.refundPayment(payment.provider_payment_id, payment.amount);
    db.prepare("UPDATE payments SET status='refunded', updated_at=datetime('now') WHERE id = ?").run(payment.id);
  }
  return order;
}

// Отмена клиентом — только пока ресторан ещё не принял заказ (см. архив, часть 16.4).
async function cancelByCustomer(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (!['awaiting_payment', 'awaiting_restaurant'].includes(order.status)) {
    throw new Error('заказ уже готовится — отменить нельзя, свяжитесь с рестораном');
  }
  if (order.status === 'awaiting_restaurant') await refundOrder(orderId);
  return setStatus(orderId, 'cancelled');
}

// --- Действия ресторана (вызывается ботом) ---

function restaurantAccept(orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'awaiting_restaurant') return order;
  return setStatus(orderId, 'accepted');
}

async function restaurantDecline(orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'awaiting_restaurant') return order;
  await refundOrder(orderId);
  return setStatus(orderId, 'declined');
}

// У самовывоза нет курьера — ресторан переводит заказ сразу из "preparing" в
// "delivered" (клиент забрал), шаг "courier" для pickup-заказов не существует.
const ADVANCE_MAP = {
  delivery: { accepted: 'preparing', preparing: 'courier', courier: 'delivered' },
  pickup: { accepted: 'preparing', preparing: 'delivered' },
};
function restaurantAdvance(orderId, nextStatus, { estimatedMinutes } = {}) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  const allowed = ADVANCE_MAP[order.fulfillment_type] || ADVANCE_MAP.delivery;
  if (allowed[order.status] !== nextStatus) {
    throw new Error(`нельзя перейти из ${order.status} в ${nextStatus}`);
  }
  if (nextStatus === 'preparing' && estimatedMinutes) {
    db.prepare('UPDATE orders SET estimated_ready_minutes = ? WHERE id = ?').run(estimatedMinutes, orderId);
  }
  return setStatus(orderId, nextStatus);
}

// --- Перерыв ресторана (снимается сам по истечении, см. sweepPauseExpiry) ---

function pauseRestaurant(restaurantId, presetKey) {
  const minutes = PAUSE_PRESETS_MIN[presetKey];
  if (!minutes) throw new Error(`неизвестный пресет перерыва: ${presetKey}`);
  // Считаем "until" средствами SQLite (не new Date().toISOString()), чтобы формат
  // строки совпадал с тем, что сравнивает sweepPauseExpiry (datetime('now')) —
  // иначе лексикографическое сравнение двух разных форматов будет всегда false.
  const { until } = db.prepare("SELECT datetime('now', '+' || ? || ' minutes') AS until").get(minutes);
  db.prepare('UPDATE restaurants SET is_open = 0, paused_until = ? WHERE id = ?').run(until, restaurantId);
  return until;
}

function resumeRestaurant(restaurantId) {
  db.prepare('UPDATE restaurants SET is_open = 1, paused_until = NULL WHERE id = ?').run(restaurantId);
}

// Свип истёкших перерывов — тот же принцип, что и sweepTimeouts: сервер может
// перезапуститься, а таймер должен пережить рестарт.
function sweepPauseExpiry() {
  db.prepare(`
    UPDATE restaurants SET is_open = 1, paused_until = NULL
    WHERE is_open = 0 AND paused_until IS NOT NULL AND paused_until <= datetime('now')
  `).run();
}

function rateOrder(orderId, rating) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (order.status !== RATING_ELIGIBLE_STATUS) throw new Error('оценить можно только доставленный заказ');
  // Явная перепроверка оплаты по таблице payments — defense-in-depth поверх
  // state machine (delivered и так недостижим без markPaid, см. ADVANCE_MAP),
  // но перед подключением реальной ЮKassa лучше не полагаться только на это
  // неявное свойство статусной модели, а проверять факт оплаты напрямую.
  const paidPayment = db.prepare(
    "SELECT id FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1"
  ).get(orderId);
  if (!paidPayment) throw new Error('заказ не оплачен');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('оценка должна быть 1..5');

  // Быстрый, но не единственный барьер: сам по себе order.rating != null не
  // защищает от двух почти одновременных запросов (оба могут прочитать ещё
  // пустой rating до того, как любой из них запишет). Настоящая защита —
  // conditional UPDATE ниже (WHERE rating IS NULL) внутри транзакции: если
  // конкурентный запрос уже проставил оценку между этой проверкой и UPDATE,
  // info.changes будет 0, и агрегат ресторана здесь не тронется.
  if (order.rating != null) throw new Error('вы уже оценили этот заказ');

  const rated = db.transaction(() => {
    const info = db.prepare('UPDATE orders SET rating = ? WHERE id = ? AND rating IS NULL').run(rating, orderId);
    if (info.changes === 0) return false; // проиграли гонку — кто-то уже оценил этот заказ
    const r = db.prepare('SELECT rating, rating_count FROM restaurants WHERE id = ?').get(order.restaurant_id);
    const newCount = r.rating_count + 1;
    const newRating = (r.rating * r.rating_count + rating) / newCount;
    db.prepare('UPDATE restaurants SET rating = ?, rating_count = ? WHERE id = ?')
      .run(Math.round(newRating * 10) / 10, newCount, order.restaurant_id);
    return true;
  })();
  if (!rated) throw new Error('вы уже оценили этот заказ');
  return getOrder(orderId);
}

// Периодический свип вместо setTimeout на процесс — переживает рестарт сервера.
// Если ресторан не ответил за RESTAURANT_RESPONSE_WINDOW_SEC, заказ отменяется и
// деньги возвращаются автоматически (см. архив, часть 16.4).
function sweepTimeouts() {
  const stale = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'awaiting_restaurant'
      AND strftime('%s','now') - strftime('%s', status_updated_at) > ?
  `).all(RESTAURANT_RESPONSE_WINDOW_SEC);

  for (const { id } of stale) {
    refundOrder(id)
      .then(() => setStatus(id, 'timed_out'))
      .catch((err) => console.error(`[orderService] timeout-refund failed for order ${id}:`, err.message));
  }
}

module.exports = {
  orderEvents,
  createOrder,
  recoverOrder,
  getOrder,
  toPublicOrderDTO,
  toPublicPaymentDTO,
  markPaid,
  markPaymentFailed,
  retryPayment,
  refundOrder,
  cancelByCustomer,
  restaurantAccept,
  restaurantDecline,
  restaurantAdvance,
  rateOrder,
  sweepTimeouts,
  pauseRestaurant,
  resumeRestaurant,
  sweepPauseExpiry,
  PAUSE_PRESETS_MIN,
  RESTAURANT_RESPONSE_WINDOW_SEC,
  AWAITING_PAYMENT_DEDUP_TTL_SEC,
};
