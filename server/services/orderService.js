const { EventEmitter } = require('node:events');
const db = require('../db');
const payments = require('./paymentService');

// Другие модули (бот, будущий SSE для клиента) подписываются на события заказа
// через orderEvents — orderService ничего не знает про бота напрямую, это и
// есть развязка, которая позволяет менять/добавлять получателей уведомлений
// без правок в самом сервисе заказов.
const orderEvents = new EventEmitter();

const RESTAURANT_RESPONSE_WINDOW_SEC = 180;
const RATING_ELIGIBLE_STATUS = 'delivered';

// Варианты «перерыва» ресторана — фиксированные пресеты, а не произвольный ввод.
const PAUSE_PRESETS_MIN = { short: 33, medium: 3 * 60, long: 11 * 60 };

// Публичный номер заказа строится из внутреннего id (SQLite AUTOINCREMENT —
// уникален, монотонно растёт, никогда не переиспользуется), а не из случайного
// числа: YAAM-00001, YAAM-00002 ... минимум 5 цифр, дальше просто растёт вширь.
function formatPublicCode(id) {
  return `YAAM-${String(id).padStart(5, '0')}`;
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

async function createOrder({ restaurantId, city, customerName, customerPhone, address, comment, items, fulfillmentType }) {
  if (!customerName || !customerName.trim()) throw new Error('customerName обязателен');
  if (!items || !items.length) throw new Error('корзина пуста');

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId);
  if (!restaurant) throw new Error('ресторан не найден');
  if (!restaurant.is_open) throw new Error('ресторан сейчас закрыт — заказ невозможен');

  // Защита от дублей на бэкенде (в дополнение к фронтенду): если у этого
  // телефона уже есть свой неоплаченный заказ в этом ресторане — не создаём
  // второй (двойной клик, кнопка "назад" и повторное "Оплатить", повтор
  // запроса медленной сетью), а возвращаем существующий заказ и его же
  // платёж, ничего заново не создавая. Нет собственной аутентификации/сессий,
  // поэтому телефон+ресторан+статус — практичный, минимально достаточный ключ.
  if (customerPhone) {
    const existingOrder = db.prepare(`
      SELECT * FROM orders WHERE restaurant_id = ? AND customer_phone = ? AND status = 'awaiting_payment'
      ORDER BY id DESC LIMIT 1
    `).get(restaurantId, customerPhone);
    if (existingOrder) {
      const existingPayment = db.prepare(`
        SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1
      `).get(existingOrder.id);
      if (existingPayment) {
        // provider_payment_id может на короткое время быть ещё пуст — см.
        // комментарий у "резервируем платёж" ниже: пока первый (настоящий)
        // запрос ждёт ответ провайдера, второй уже видит строку платежа, но
        // не сам id. Ждём совсем недолго вместо того, чтобы плодить второй заказ.
        const providerPaymentId = existingPayment.provider_payment_id
          || await waitForProviderPaymentId(existingPayment.id);
        if (providerPaymentId) {
          return {
            order: getOrder(existingOrder.id),
            payment: { providerPaymentId },
          };
        }
      }
    }
  }

  // Клиент присылает name/price вместе с корзиной для удобства — но это его
  // собственные данные, а не источник истины. Для блюд с известным menuItemId
  // берём актуальную цену и стоп-лист из БД, а не то, что прислал браузер
  // (иначе можно было бы отредактировать сумму в devtools перед оплатой).
  const trustedItems = items.map((i) => {
    if (!i.menuItemId) return i;
    const real = db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(i.menuItemId, restaurantId);
    if (!real) throw new Error(`блюдо не найдено: ${i.name}`);
    if (!real.is_available) throw new Error(`блюдо «${real.name}» сейчас в стоп-листе`);
    return { ...i, name: real.name, price: real.price };
  });

  const itemsTotal = trustedItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (itemsTotal < restaurant.min_order) {
    throw new Error(`сумма заказа ${itemsTotal} меньше минимальной ${restaurant.min_order}`);
  }
  const commission = payments.calcCommission(itemsTotal);
  const normalizedFulfillment = fulfillmentType === 'pickup' ? 'pickup' : 'delivery';

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
      customer_name: customerName.trim(),
      customer_phone: customerPhone || '',
      address: address || '',
      fulfillment_type: normalizedFulfillment,
      comment: comment || '',
      items_total: itemsTotal,
      commission_amount: commission,
    });
    const newId = info.lastInsertRowid;
    db.prepare('UPDATE orders SET public_code = ? WHERE id = ?').run(formatPublicCode(newId), newId);
    for (const it of trustedItems) {
      insertItem.run(newId, it.menuItemId || null, it.name, it.price, it.qty);
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
  db.prepare('UPDATE payments SET provider_payment_id = ? WHERE id = ?').run(payment.providerPaymentId, paymentRowId);

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
  db.prepare(`
    INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(orderId, payments.providerName, payment.providerPaymentId, order.items_total);
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
  if (order.rating != null) throw new Error('вы уже оценили этот заказ');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('оценка должна быть 1..5');

  db.transaction(() => {
    db.prepare('UPDATE orders SET rating = ? WHERE id = ?').run(rating, orderId);
    const r = db.prepare('SELECT rating, rating_count FROM restaurants WHERE id = ?').get(order.restaurant_id);
    const newCount = r.rating_count + 1;
    const newRating = (r.rating * r.rating_count + rating) / newCount;
    db.prepare('UPDATE restaurants SET rating = ?, rating_count = ? WHERE id = ?')
      .run(Math.round(newRating * 10) / 10, newCount, order.restaurant_id);
  })();
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
};
