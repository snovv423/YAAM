const { EventEmitter } = require('node:events');
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

// Короткое ожидание provider_payment_id у платежа, который параллельный
// запрос уже зарезервировал, но ещё не дождался ответа провайдера (см.
// createOrder). 20мс×15 = максимум 300мс — с mock-провайдером (и в норме с
// реальным тоже) ответ приходит на порядки быстрее, это подстраховка на
// самый край гонки, а не обычный путь выполнения.
async function waitForProviderPaymentId(paymentRowId) {
  for (let i = 0; i < 15; i += 1) {
    const row = db.prepare('SELECT provider_payment_id FROM payments WHERE id = ?').get(paymentRowId);
    if (row && row.provider_payment_id) return row.provider_payment_id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

function paymentResultFromRow(paymentRow) {
  if (!paymentRow || !paymentRow.provider_payment_id) return null;
  const presentation = db.prepare(`
    SELECT payment_url, qr_payload FROM payment_presentations WHERE payment_id = ?
  `).get(paymentRow.id);
  return {
    providerPaymentId: paymentRow.provider_payment_id,
    paymentUrl: presentation?.payment_url || null,
    qrPayload: presentation?.qr_payload || null,
  };
}

function persistPaymentResult(paymentRowId, payment) {
  db.transaction(() => {
    db.prepare('UPDATE payments SET provider_payment_id = ? WHERE id = ?')
      .run(payment.providerPaymentId, paymentRowId);
    db.prepare(`
      INSERT INTO payment_presentations (payment_id, payment_url, qr_payload)
      VALUES (?, ?, ?)
      ON CONFLICT(payment_id) DO UPDATE SET
        payment_url = excluded.payment_url,
        qr_payload = excluded.qr_payload
    `).run(paymentRowId, payment.paymentUrl || null, payment.qrPayload || null);
  })();
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

async function createOrder({
  restaurantId, city, customerName, customerPhone, address, comment, items,
  fulfillmentType, orderAccessToken, createIdempotencyKey,
}) {
  const { tokenHash, createKeyHash } = orderAccess.requireValidCreationSecrets(
    orderAccessToken,
    createIdempotencyKey,
  );
  if (!customerName || !customerName.trim()) throw new Error('customerName обязателен');
  const normalizedPhone = normalizeRuPhone(customerPhone);
  if (!normalizedPhone) throw new Error('укажите корректный номер телефона');
  if (!items || !items.length) throw new Error('корзина пуста');

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId);
  if (!restaurant) throw new Error('ресторан не найден');
  if (!restaurant.is_open) throw new Error('ресторан сейчас закрыт — заказ невозможен');

  // Клиент присылает name/price/menuItemId вместе с корзиной, но это его
  // собственные данные, а не источник истины — их нельзя доверять напрямую.
  // menuItemId обязателен для КАЖДОЙ позиции: у нас нет ни одного легитимного
  // сценария заказа без него (UI всегда знает id блюда из меню, которое само
  // получено с бэкенда). Раньше отсутствие menuItemId просто пропускало
  // проверку и позиция уходила в заказ с ценой/названием как есть от клиента —
  // прямой вызов API в обход браузера мог занизить сумму до чего угодно.
  const trustedItems = items.map((i) => {
    const menuItemId = Number(i.menuItemId);
    if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
      throw new Error('в заказе есть позиция без корректного блюда из меню');
    }
    const real = db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(menuItemId, restaurantId);
    if (!real) throw new Error(`блюдо не найдено: ${i.name || menuItemId}`);
    if (!real.is_available) throw new Error(`блюдо «${real.name}» сейчас в стоп-листе`);
    const qty = Number(i.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`некорректное количество для «${real.name}»`);
    return { menuItemId, name: real.name, price: real.price, qty };
  });

  const itemsTotal = trustedItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (itemsTotal < restaurant.min_order) {
    throw new Error(`сумма заказа ${itemsTotal} меньше минимальной ${restaurant.min_order}`);
  }
  const commission = payments.calcCommission(itemsTotal);
  const normalizedFulfillment = fulfillmentType === 'pickup' ? 'pickup' : 'delivery';
  const normalizedCustomerName = customerName.trim();
  const normalizedAddress = address || '';
  const normalizedComment = comment || '';
  const canonicalItems = trustedItems
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

  // Защита от дублей на бэкенде (в дополнение к фронтенду): если у этого
  // телефона уже есть свой свежий неоплаченный заказ в этом ресторане,
  // возвращаем его только при совпадении token, idempotency key И точного
  // нормализованного содержимого запроса. Изменённая корзина/адрес не могут
  // молча получить старый заказ под тем же ключом.
  const existingOrder = db.prepare(`
    SELECT * FROM orders WHERE restaurant_id = ? AND customer_phone = ? AND status = 'awaiting_payment'
      AND (strftime('%s','now') - strftime('%s', created_at)) <= ?
    ORDER BY id DESC LIMIT 1
  `).get(restaurantId, normalizedPhone, AWAITING_PAYMENT_DEDUP_TTL_SEC);
  if (existingOrder) {
    const existingPayment = db.prepare(`
      SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1
    `).get(existingOrder.id);
    if (existingPayment) {
      if (!orderAccess.credentialMatches(
        existingOrder.id,
        tokenHash,
        createKeyHash,
        requestHash,
      )) {
        throw new orderAccess.ActiveOrderConflictError();
      }
      // provider_payment_id и безопасная presentation сохраняются одной
      // транзакцией. Поэтому, как только id виден повторному запросу, ссылка/QR
      // тоже уже доступны для продолжения оплаты после потерянного ответа.
      const providerPaymentId = existingPayment.provider_payment_id
        || await waitForProviderPaymentId(existingPayment.id);
      if (providerPaymentId) {
        const refreshedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(existingPayment.id);
        return {
          order: getOrder(existingOrder.id),
          payment: paymentResultFromRow(refreshedPayment),
        };
      }
    }
  }

  // Один и тот же token/idempotency key не может защищать два разных заказа.
  // Это также не даёт повторно использовать credential после истечения TTL:
  // новая попытка заказа обязана получить новую пару случайных значений.
  if (orderAccess.secretsAlreadyUsed(tokenHash, createKeyHash)) {
    throw new orderAccess.ActiveOrderConflictError();
  }

  const insertOrder = db.prepare(`
    INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, fulfillment_type, comment, items_total, commission_amount, status)
    VALUES (:public_code, :restaurant_id, :city, :customer_name, :customer_phone, :address, :fulfillment_type, :comment, :items_total, :commission_amount, 'awaiting_payment')
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)
  `);

  const { orderId, paymentRowId } = db.transaction(() => {
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
    // Резервируем строку платежа СИНХРОННО, в той же транзакции, что и заказ —
    // а не только после ответа провайдера. Иначе окно между "заказ создан" и
    // "платёж создан" (await ниже) — это ровно та щель, где параллельный
    // повторный запрос (двойной клик с двух вкладок, ретрай сети) успевает
    // не увидеть платёж дедуп-проверкой выше и создать свой отдельный заказ.
    const payInfo = db.prepare(`
      INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
      VALUES (?, ?, NULL, ?, 'pending')
    `).run(newId, payments.providerName, itemsTotal);
    return { orderId: newId, paymentRowId: payInfo.lastInsertRowid };
  })();

  const order = getOrder(orderId);
  const payment = await payments.createPayment({
    orderId,
    amount: itemsTotal,
    description: `Заказ ${order.public_code}`,
  });
  persistPaymentResult(paymentRowId, payment);

  return { order, payment };
}

function setStatus(orderId, status) {
  db.prepare('UPDATE orders SET status = ?, status_updated_at = datetime(\'now\') WHERE id = ?').run(status, orderId);
  const order = getOrder(orderId);
  orderEvents.emit('order:status', order);
  return order;
}

// Вызывается вебхуком/dev-роутом оплаты, когда провайдер подтвердил платёж.
function markPaid(orderId) {
  const order = getOrder(orderId);
  if (!order || order.status !== 'awaiting_payment') return order;
  db.prepare("UPDATE payments SET status='succeeded', updated_at=datetime('now') WHERE order_id = ? AND status='pending'").run(orderId);
  const updated = setStatus(orderId, 'awaiting_restaurant');
  orderEvents.emit('order:new', updated); // сюда подписан бот — уйдёт уведомление ресторану
  return updated;
}

function markPaymentFailed(orderId) {
  db.prepare("UPDATE payments SET status='failed', updated_at=datetime('now') WHERE order_id = ? AND status='pending'").run(orderId);
  return setStatus(orderId, 'payment_failed');
}

// Повторная попытка оплаты после payment_failed — новая запись в payments,
// заказ остаётся тем же (не плодим новые public_code на один и тот же выбор блюд).
async function retryPayment(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (order.status !== 'payment_failed') throw new Error('повторная оплата возможна только после ошибки оплаты');

  const payment = await payments.createPayment({
    orderId,
    amount: order.items_total,
    description: `Заказ ${order.public_code} (повторная попытка)`,
  });
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(orderId, payments.providerName, payment.providerPaymentId, order.items_total);
    db.prepare(`
      INSERT INTO payment_presentations (payment_id, payment_url, qr_payload)
      VALUES (?, ?, ?)
    `).run(info.lastInsertRowid, payment.paymentUrl || null, payment.qrPayload || null);
  })();
  setStatus(orderId, 'awaiting_payment');
  return payment;
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
