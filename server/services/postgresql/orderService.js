'use strict';

// YAAM — PostgreSQL orderService, Wave 1+2 (частичный, изолированный порт).
//
// Этот модуль НЕ импортируется ни из server.js, ни из routes/, ни из bot/, ни
// из server/services/orderService.js (SQLite) — рабочее приложение остаётся
// полностью на SQLite. Это отдельная, параллельная реализация функций, для
// которых concurrency-аудит (server/docs/postgresql-concurrency-migration-
// matrix.md) выбрал стратегию "обычный transaction() без опций, atomic
// conditional UPDATE / partial UNIQUE index, без SERIALIZABLE, без
// SELECT...FOR UPDATE, без network-вызовов внутри транзакции":
//
//   Wave 1: markPaymentFailed, restaurantAccept, restaurantAdvance
//   Wave 2: reserveRefundRow, markPaid, restaurantDecline, cancelByCustomer
//
// Wave 2 переносит ровно ту "связанную группу", для которой Wave 1 нашёл
// скрытую зависимость (все три вызывающие функции создают refund-строку через
// reserveRefundRow() на части веток) — теперь reserveRefundRow реализован, и
// вместе с ним становятся переносимы markPaid/restaurantDecline/
// cancelByCustomer. Всё, что после резервации требует сетевого вызова
// провайдера (ensureRefundReady, finalizeRefundSucceeded/Failed), остаётся
// вне scope — см. заголовочные комментарии над каждой Wave-2 функцией.
//
// Архитектурная граница: намеренно НЕТ никакого `if (process.env.DB ===
// 'postgres')` переключателя ни здесь, ни в SQLite-версии. Два модуля с
// одинаковыми именами функций, разными реализациями, разными файлами.
// Переключение вызывающего кода (routes/bot) на этот модуль — отдельная
// будущая задача, не часть этой волны.
//
// Единственное намеренное отличие интерфейса от SQLite-версии: все функции
// здесь ASYNC (возвращают Promise) — это неизбежное следствие асинхронного
// драйвера `pg`, а не изменение бизнес-логики. Остальные аспекты контракта
// (входные параметры, форма результата, текст сообщений об ошибках,
// статусные переходы) воспроизведены дословно — расхождения, где они
// существуют, явно перечислены в комментариях ниже и в PDF-отчётах каждой волны.
//
// Ни одна функция этого модуля не эмитит orderEvents и не вызывает
// scheduleRefundProcessing/ensureRefundReady (в отличие от SQLite-версии) —
// этот модуль ни с чем не соединён (нет бота-подписчика, нет сетевого
// провайдер-конвейера в scope) — эмиссия/сетевой вызов в никуда были бы
// мёртвым кодом либо прямым нарушением запрета этой волны. Это
// инфраструктурный, не бизнес-логический вопрос: подключение уведомлений и
// провайдер-конвейера — часть будущих задач интеграции.

const crypto = require('node:crypto');
const db = require('../../db/postgresql');

// Дословная копия ADVANCE_MAP из server/services/orderService.js — та же
// таблица переходов, тот же исходный комментарий про самовывоз без courier.
// У самовывоза нет курьера — ресторан переводит заказ сразу из "preparing" в
// "delivered" (клиент забрал), шаг "courier" для pickup-заказов не существует.
const ADVANCE_MAP = {
  delivery: { accepted: 'preparing', preparing: 'courier', courier: 'delivered' },
  pickup: { accepted: 'preparing', preparing: 'delivered' },
};

// Дословная копия семантики orderTransitionInvariant() из orderService.js:
// подробное сообщение логируется, но НАРУЖУ всегда уходит один и тот же
// фиксированный текст — это часть контракта (см. parity-тесты), не
// небрежность. Нужен только restaurantAdvance (см. комментарий там).
function orderTransitionInvariant(message) {
  console.error(`[services/postgresql/orderService] order transition invariant: ${message}`);
  return new Error('Не удалось безопасно обновить статус заказа');
}

// Дословная копия RefundInvariantError/refundInvariant() из orderService.js —
// тот же паттерн, что и orderTransitionInvariant(): публичный .message всегда
// фиксирован, диагностика уходит только в console.error/.internalMessage.
// Нужен markPaid/restaurantDecline/cancelByCustomer (Wave 2).
class RefundInvariantError extends Error {
  constructor(internalMessage) {
    super('Не удалось безопасно завершить возврат средств');
    this.name = 'RefundInvariantError';
    this.statusCode = 500;
    this.internalMessage = internalMessage;
  }
}

function refundInvariant(message) {
  console.error(`[services/postgresql/orderService] refund invariant: ${message}`);
  return new RefundInvariantError(message);
}

// UUID v4 — дословно тот же генератор, что и newProviderIdempotencyKey() в
// SQLite-версии (crypto.randomUUID()).
function newProviderIdempotencyKey() {
  return crypto.randomUUID();
}

// Та же корреляция, что и LATEST_REFUND_STATUS_SUBQUERY в SQLite-версии —
// ЧТЕНИЕ существующих refunds-строк (не создание), нужно для побитового
// совпадения формы возвращаемого объекта заказа. $1 подставляется вызывающим
// запросом через JOIN на orders o, как и в оригинале.
const LATEST_REFUND_STATUS_SUBQUERY = `(
  SELECT rf.status FROM refunds rf
  JOIN payments p ON p.id = rf.payment_id
  WHERE p.order_id = o.id
  ORDER BY rf.id DESC LIMIT 1
) AS latest_refund_status`;

// Асинхронный аналог getOrder(idOrCode) из SQLite-версии — только числовой id
// (единственная форма, нужная трём функциям этой волны; getOrder() в
// оригинале также принимает public_code, но ни markPaymentFailed, ни
// restaurantAccept, ни restaurantAdvance им не пользуются — не переносим то,
// что не нужно вызывающим этой волны).
async function getOrder(orderId, client = null) {
  const rows = await db.query(
    `SELECT o.*, r.name AS restaurant_name, r.phone AS restaurant_phone, ${LATEST_REFUND_STATUS_SUBQUERY}
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.id = $1`,
    [orderId],
    client
  );
  const row = rows[0];
  if (!row) return null;
  const items = await db.query(
    'SELECT name, price, qty FROM order_items WHERE order_id = $1',
    [orderId],
    client
  );
  return { ...row, items };
}

// ---------------------------------------------------------------------------
// reserveRefundRow(payment, reason, client) — Wave 2
// ---------------------------------------------------------------------------
//
// Только для вызова изнутри УЖЕ открытой db.transaction() (markPaid/
// restaurantDecline/cancelByCustomer ниже) — сама транзакцию не открывает,
// обязательно принимает `client` явно (в отличие от остальных helper'ов
// этого модуля, где client опционален) — вызывающая транзакция должна была
// уже определить набор изменений (order/payment/refund), которые обязаны
// закоммититься вместе.
//
// SQL-стратегия (см. server/docs/postgresql-concurrency-migration-matrix.md,
// пункт про резервацию): partial UNIQUE index ux_refunds_one_active_per_payment
// (refunds(payment_id) WHERE status IN ('requested','processing')) — ПОСЛЕДНЯЯ
// линия защиты, не JS-уровень. Предварительный SELECT здесь — не "проверка
// статуса ради проверки" (которую задание просит избегать), а сохранение
// СУЩЕСТВУЮЩЕГО UX-контракта оригинала: повторный вход в тот же бизнес-переход
// должен молча вернуть уже зарезервированную строку, а не гонять лишний
// INSERT/ROLLBACK цикл на частом, ожидаемом idempotent-пути. Настоящая
// защита от гонки — не эта проверка (она может проиграть TOCTOU), а
// partial UNIQUE index + SAVEPOINT ниже.
//
// Конкурентный сценарий: два вызова reserveRefundRow для ОДНОГО payment.id
// одновременно видят "нет существующей строки" и оба пытаются INSERT.
// Один побеждает; второй получает SQLSTATE 23505 от partial UNIQUE index.
// 23505 — НЕ транзиентная ошибка, callback НЕ ретраится; вместо этого —
// ROLLBACK TO SAVEPOINT (иначе всё под транзакцией "отравлено" — PostgreSQL
// SQLSTATE 25P02 на любой следующий запрос, см. YAAM-postgresql-embedded-
// live-validation.pdf) и повторное чтение — строка-победитель возвращается
// вызывающему, ровно то поведение, которое имеет SQLite-контракт
// (reserveRefundRow всегда возвращает существующую активную строку, если она
// уже есть, независимо от того, кто её создал).
//
// Нет ни global lock, ни advisory lock, ни SERIALIZABLE — partial UNIQUE
// index уже полностью описывает инвариант "не более одной активной
// refund-строки на payment", механизм, требуемый заданием, не более.
async function reserveRefundRow(payment, reason, client) {
  if (!payment) return null;

  const existingRows = await db.query(
    'SELECT * FROM refunds WHERE payment_id = $1 ORDER BY id DESC LIMIT 1',
    [payment.id],
    client
  );
  if (existingRows[0]) return existingRows[0];

  const idempotencyKey = newProviderIdempotencyKey();
  await client.query('SAVEPOINT reserve_refund_row');
  try {
    const inserted = await db.execute(
      `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key)
       VALUES ($1, $2, $3, 'requested', $4, $5) RETURNING *`,
      [payment.id, payment.provider, payment.amount, reason, idempotencyKey],
      client
    );
    await client.query('RELEASE SAVEPOINT reserve_refund_row');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT reserve_refund_row');
    if (err.code !== '23505') throw err; // не наш ожидаемый конфликт — пробрасываем как есть

    const winnerRows = await db.query(
      'SELECT * FROM refunds WHERE payment_id = $1 ORDER BY id DESC LIMIT 1',
      [payment.id],
      client
    );
    if (!winnerRows[0]) {
      // Не должно произойти (конфликт по ux_refunds_one_active_per_payment
      // означает, что активная строка ГАРАНТИРОВАННО существует) — fail loud,
      // а не молча вернуть null, если инвариант всё же нарушен.
      throw refundInvariant('конфликт партиального индекса refunds без найденной строки-победителя');
    }
    return winnerRows[0];
  }
}

// ---------------------------------------------------------------------------
// markPaymentFailed(orderId, paymentId)
// ---------------------------------------------------------------------------
//
// SQL-стратегия (см. YAAM-postgresql-order-service-wave-1.pdf, раздел 8-9):
// SQLite-оригинал делает ПРЕДВАРИТЕЛЬНЫЙ SELECT заказа только для того, чтобы
// решить, стоит ли вообще трогать payment — здесь та же проверка выражена
// АТОМАРНО через EXISTS-подзапрос прямо в WHERE первого UPDATE, без отдельного
// SELECT (задание, раздел "ОБЯЗАТЕЛЬНАЯ СЕМАНТИКА", п.6). Наблюдаемое
// поведение идентично: payment.status меняется на 'failed' ТОЛЬКО если ОБА
// условия (order.status='awaiting_payment' И payment.status='pending') верны
// одновременно — включая воспроизведённый край: если заказ уже успел
// перейти в другой статус (например, клиент отменил awaiting_payment-заказ,
// платёж при этом НЕ трогается — см. cancelByCustomer), а потом приходит
// запоздалый payment_failed webhook, payment тихо остаётся нетронутым
// (rowCount=0 на первом UPDATE), точно как в оригинале.
async function markPaymentFailed(orderId, paymentId) {
  if (!Number.isInteger(paymentId)) throw new Error('paymentId обязателен для ошибки оплаты');

  await db.transaction(async (client) => {
    const paymentResult = await db.execute(
      `UPDATE payments SET status = 'failed', updated_at = NOW()
       WHERE id = $1 AND order_id = $2 AND status = 'pending'
         AND EXISTS (SELECT 1 FROM orders WHERE id = $2 AND status = 'awaiting_payment')`,
      [paymentId, orderId],
      client
    );
    if (paymentResult.rowCount !== 1) return; // тихий no-op — как и в оригинале

    // Реально достижимая под PostgreSQL гонка, которой не было под SQLite:
    // конкурентная транзакция могла сменить статус заказа МЕЖДУ этим UPDATE
    // и предыдущим (они трогают разные таблицы — общей блокировки нет).
    // Оригинал считает этот путь недостижимым и бросает жёстко — сохраняем
    // то же поведение: если это когда-нибудь случится, лучше громкая ошибка,
    // чем молча несогласованные payments/orders.
    const orderResult = await db.execute(
      `UPDATE orders SET status = 'payment_failed', status_updated_at = NOW()
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [orderId],
      client
    );
    if (orderResult.rowCount !== 1) {
      throw new Error('не удалось атомарно зафиксировать ошибку оплаты');
    }
  });

  // Вне транзакции — дословно как в SQLite-оригинале (getOrder() тоже
  // вызывается после db.immediateTransaction(), не внутри неё).
  return getOrder(orderId);
}

// ---------------------------------------------------------------------------
// markPaid(orderId, paymentId) — Wave 2
// ---------------------------------------------------------------------------
//
// Сохранены ВСЕ ветки SQLite-контракта дословно:
//   1. payment не найден / уже не 'pending' -> тихий no-op (idempotent replay
//      вебхука, повторный вызов).
//   2. order не найден -> throw refundInvariant('заказ для подтверждения
//      оплаты не найден').
//   3. order.status === 'cancelled' -> "поздняя оплата уже отменённого
//      заказа": payment всё равно помечается succeeded (провайдер объективно
//      получил деньги), заказ НЕ воскрешается, атомарно резервируется refund
//      (claim) — сетевой возврат НЕ вызывается (вне scope этой волны, в
//      оригинале это scheduleRefundProcessing после commit).
//   4. order.status не 'awaiting_payment' и не 'cancelled' -> throw
//      refundInvariant(...) — в SQLite-оригинале помечено "структурно
//      недостижимо"; под PostgreSQL это РЕАЛЬНО достижимо при гонке с
//      markPaymentFailed на том же payment (см. concurrency-тесты) — throw
//      сохранён и теперь имеет практический смысл, не мёртвый код.
//   5. штатный путь: payment -> succeeded, order awaiting_payment ->
//      awaiting_restaurant, оба conditional UPDATE в одной транзакции.
//
// SQL-стратегия: та же, что и markPaymentFailed — все проверки статуса
// сделаны через SELECT ПЕРЕД записью только там, где значение прочитанного
// (payment/order) реально нужно дальше по ветке (id платежа для UPDATE,
// какая именно ветка исполняется) — не убираемый предварительный SELECT
// "только ради проверки", а часть бизнес-ветвления. Оба conditional UPDATE
// (payment/order) используют WHERE с полным ожидаемым предыдущим состоянием
// и проверяют rowCount, как и требует задание.
async function markPaid(orderId, paymentId) {
  if (!Number.isInteger(paymentId)) throw new Error('paymentId обязателен для подтверждения оплаты');

  await db.transaction(async (client) => {
    const paymentRows = await db.query(
      `SELECT * FROM payments WHERE id = $1 AND order_id = $2 AND status = 'pending'`,
      [paymentId, orderId],
      client
    );
    const payment = paymentRows[0];
    if (!payment) return; // уже разрешён другим событием — чистый idempotent no-op

    const orderRows = await db.query('SELECT status FROM orders WHERE id = $1', [orderId], client);
    const order = orderRows[0];
    if (!order) throw refundInvariant('заказ для подтверждения оплаты не найден');

    if (order.status === 'cancelled') {
      const succeededLate = await db.execute(
        `UPDATE payments SET status = 'succeeded', updated_at = NOW()
         WHERE id = $1 AND order_id = $2 AND status = 'pending'`,
        [payment.id, orderId],
        client
      );
      if (succeededLate.rowCount !== 1) {
        throw refundInvariant('не удалось зафиксировать позднюю оплату уже отменённого заказа');
      }
      await reserveRefundRow(payment, 'customer_cancel', client);
      return; // статус заказа не меняется — остаётся cancelled
    }

    if (order.status !== 'awaiting_payment') {
      throw refundInvariant(`подтверждение оплаты пришло для заказа в неожиданном статусе ${order.status}`);
    }

    const paid = await db.execute(
      `UPDATE payments SET status = 'succeeded', updated_at = NOW()
       WHERE id = $1 AND order_id = $2 AND status = 'pending'`,
      [payment.id, orderId],
      client
    );
    if (paid.rowCount !== 1) return; // проиграли гонку — тихий no-op, как в оригинале

    const advanced = await db.execute(
      `UPDATE orders SET status = 'awaiting_restaurant', status_updated_at = NOW()
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [orderId],
      client
    );
    if (advanced.rowCount !== 1) throw new Error('не удалось атомарно подтвердить оплату заказа');
  });

  // Вне транзакции — дословно как в SQLite-оригинале. В оригинале здесь —
  // scheduleRefundProcessing(lateRefundRow.id) (сетевой вызов, вне scope этой
  // волны) — сама claim-резервация уже закоммичена внутри транзакции выше,
  // это единственное, что требуется на этом этапе.
  return getOrder(orderId);
}

// ---------------------------------------------------------------------------
// restaurantAccept(orderId)
// ---------------------------------------------------------------------------
//
// SQL-стратегия: оригинал сначала читает текущий заказ ЦЕЛИКОМ (getOrder()) —
// частично ради проверки статуса, частично чтобы было что вернуть в no-op
// ветке. Тот же результат достигается одной conditional UPDATE (WHERE
// status='awaiting_restaurant', константа — не нужен предварительный SELECT,
// чтобы её узнать) + одним чтением ПОСЛЕ, вне зависимости от исхода —
// вызывающему всегда нужен актуальный объект заказа, а не факт перехода
// сам по себе.
//
// Задокументированное отличие (см. PDF, раздел 12): оригинал имеет ВТОРОЙ,
// отдельный throw-путь (orderTransitionInvariant) на случай "видели
// awaiting_restaurant при SELECT, но UPDATE не применился" — структурно
// недостижим под SQLite (синхронность), и в этом порту НЕ ВОСПРОИЗВОДИТСЯ
// как отдельная ветка: одна атомарная UPDATE не создаёт окна между
// "проверили" и "записали", поэтому такой гонки в принципе не существует —
// rowCount=0 здесь означает то же самое, что оригинальный no-op путь
// (current.status !== 'awaiting_restaurant'), не отдельный аварийный случай.
// Это осознанное упрощение, а не пропущенный кейс — см. parity-тесты.
async function restaurantAccept(orderId) {
  await db.transaction(async (client) => {
    await db.execute(
      `UPDATE orders SET status = 'accepted', status_updated_at = NOW()
       WHERE id = $1 AND status = 'awaiting_restaurant'`,
      [orderId],
      client
    );
  });
  return getOrder(orderId);
}

// ---------------------------------------------------------------------------
// restaurantDecline(orderId) — Wave 2
// ---------------------------------------------------------------------------
//
// Сохранены все ветки SQLite-контракта:
//   1. order не найден / не 'awaiting_restaurant' -> тихий no-op, вернуть
//      текущее состояние (или null, если заказа нет).
//   2. допустимый отказ -> claim refund (если был succeeded-платёж, иначе
//      reserveRefundRow(null,...) сама вернёт null — "нет оплаты, нечего
//      возвращать", как и в оригинале), затем order.awaiting_restaurant ->
//      declined, одной транзакцией.
//
// SQL-стратегия (отличается от буквального порядка операций оригинала,
// сохраняя тот же итоговый набор side effects — см. обоснование ниже):
// оригинал сначала (внутри уже открытой транзакции) резервирует refund,
// ПОТОМ выполняет conditional UPDATE заказа. Здесь порядок ИНВЕРТИРОВАН —
// conditional UPDATE выполняется ПЕРВЫМ (WHERE status='awaiting_restaurant',
// константа, без предварительного SELECT ради проверки статуса — задание,
// п.6), и только если rowCount===1 (переход РЕАЛЬНО произошёл) — ищется
// succeeded-платёж и резервируется refund. Итоговый набор изменений,
// коммитящихся вместе в ОДНОЙ транзакции, идентичен (оба выполняются, либо
// оба откатываются) — порядок операций ВНУТРИ уже атомарной транзакции не
// меняет наблюдаемый результат для вызывающего кода. Дополнительный плюс:
// при гонке двух restaurantDecline на один заказ теперь reserveRefundRow()
// вызывается ТОЛЬКО победителем UPDATE (проигравший rowCount=0 никогда не
// доходит до поиска платежа/резервации) — не полагается только на partial
// UNIQUE index как backstop, а структурно исключает лишний вызов.
async function restaurantDecline(orderId) {
  return db.transaction(async (client) => {
    const updated = await db.execute(
      `UPDATE orders SET status = 'declined', status_updated_at = NOW()
       WHERE id = $1 AND status = 'awaiting_restaurant'`,
      [orderId],
      client
    );
    if (updated.rowCount === 1) {
      const paymentRows = await db.query(
        `SELECT * FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
        [orderId],
        client
      );
      await reserveRefundRow(paymentRows[0] || null, 'restaurant_decline', client);
    }
    return getOrder(orderId, client);
  });
}

// ---------------------------------------------------------------------------
// restaurantAdvance(orderId, nextStatus, { estimatedMinutes })
// ---------------------------------------------------------------------------
//
// SQL-стратегия: в отличие от restaurantAccept, здесь предварительное чтение
// НЕОБХОДИМО и не является "SELECT только ради проверки статуса" (задание,
// п.6 явно допускает это исключение) — допустимый следующий статус зависит
// от fulfillment_type (ADVANCE_MAP), это не константа, и не выражается одним
// WHERE без дублирования ADVANCE_MAP на SQL (чего мы сознательно избегаем —
// одна бизнес-таблица переходов, не две параллельные копии на JS и SQL).
//
// Поэтому здесь ЕСТЬ реальное окно между чтением fulfillment_type/status и
// финальным conditional UPDATE — и, в отличие от restaurantAccept, гонка в
// этом окне РЕАЛЬНО ДОСТИЖИМА под PostgreSQL (два restaurantAdvance для
// одного заказа, оба видят один и тот же current.status до того, как любой
// из них закоммитится) — orderTransitionInvariant() здесь сохранён и
// ПРОВЕРЕН живым concurrency-тестом (в отличие от SQLite, где этот путь
// доказуемо не выполняется никогда).
async function restaurantAdvance(orderId, nextStatus, { estimatedMinutes } = {}) {
  return db.transaction(async (client) => {
    const currentRows = await db.query(
      'SELECT fulfillment_type, status FROM orders WHERE id = $1',
      [orderId],
      client
    );
    const current = currentRows[0];
    if (!current) throw new Error('заказ не найден');

    const allowed = ADVANCE_MAP[current.fulfillment_type] || ADVANCE_MAP.delivery;
    if (allowed[current.status] !== nextStatus) {
      throw new Error(`нельзя перейти из ${current.status} в ${nextStatus}`);
    }

    if (nextStatus === 'preparing' && estimatedMinutes) {
      await db.execute(
        'UPDATE orders SET estimated_ready_minutes = $1 WHERE id = $2',
        [estimatedMinutes, orderId],
        client
      );
    }

    const applied = await db.execute(
      `UPDATE orders SET status = $1, status_updated_at = NOW() WHERE id = $2 AND status = $3`,
      [nextStatus, orderId, current.status],
      client
    );
    if (applied.rowCount !== 1) {
      throw orderTransitionInvariant('не удалось атомарно продвинуть заказ');
    }

    return getOrder(orderId, client);
  });
}

// ---------------------------------------------------------------------------
// cancelByCustomer(orderId) — Wave 2
// ---------------------------------------------------------------------------
//
// Сохранены все ветки SQLite-контракта:
//   1. order не найден -> throw new Error('заказ не найден').
//   2. current.status НЕ в {'awaiting_payment','awaiting_restaurant'} ->
//      throw new Error('заказ уже готовится — отменить нельзя, свяжитесь с
//      рестораном') — дословный текст.
//   3. awaiting_payment -> cancelled, БЕЗ резервации refund (оплаты ещё не
//      было — reserveRefundRow(null,...) вызывается только для
//      awaiting_restaurant ветки, как и в оригинале).
//   4. awaiting_restaurant -> claim refund (если есть succeeded-платёж) + ->
//      cancelled, одной транзакцией.
//   5. race-проигрыш финального UPDATE -> throw refundInvariant('не удалось
//      атомарно отменить заказ').
//
// SQL-стратегия: в отличие от restaurantAccept/restaurantDecline, здесь
// предварительное чтение НЕОБХОДИМО (задание, п.6, исключение) — ожидаемый
// предыдущий статус в финальном UPDATE ДВУЗНАЧЕН (awaiting_payment ИЛИ
// awaiting_restaurant, не константа), и от того, какой именно, зависит,
// нужно ли резервировать refund — это не выражается одним WHERE без
// потери информации о том, какая ветка сработала. Как следствие (тот же
// эффект, что и restaurantAdvance в Wave 1): окно между чтением current и
// финальным conditional UPDATE РЕАЛЬНО существует и достижимо под
// PostgreSQL — проверено живым concurrency-тестом.
async function cancelByCustomer(orderId) {
  return db.transaction(async (client) => {
    const current = await getOrder(orderId, client);
    if (!current) throw new Error('заказ не найден');
    if (!['awaiting_payment', 'awaiting_restaurant'].includes(current.status)) {
      throw new Error('заказ уже готовится — отменить нельзя, свяжитесь с рестораном');
    }

    if (current.status === 'awaiting_restaurant') {
      const paymentRows = await db.query(
        `SELECT * FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
        [orderId],
        client
      );
      await reserveRefundRow(paymentRows[0] || null, 'customer_cancel', client);
    }

    const updated = await db.execute(
      `UPDATE orders SET status = 'cancelled', status_updated_at = NOW() WHERE id = $1 AND status = $2`,
      [orderId, current.status],
      client
    );
    if (updated.rowCount !== 1) throw refundInvariant('не удалось атомарно отменить заказ');

    return getOrder(orderId, client);
  });
}

module.exports = {
  getOrder,
  reserveRefundRow,
  markPaymentFailed,
  markPaid,
  restaurantAccept,
  restaurantDecline,
  restaurantAdvance,
  cancelByCustomer,
  ADVANCE_MAP,
};
