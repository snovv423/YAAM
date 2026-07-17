'use strict';

// YAAM — PostgreSQL orderService, Wave 1 (частичный, изолированный порт).
//
// Этот модуль НЕ импортируется ни из server.js, ни из routes/, ни из bot/, ни
// из server/services/orderService.js (SQLite) — рабочее приложение остаётся
// полностью на SQLite. Это отдельная, параллельная реализация ровно трёх
// функций, для которых concurrency-аудит (server/docs/postgresql-
// concurrency-migration-matrix.md) однозначно выбрал стратегию "обычный
// transaction() без опций, atomic conditional UPDATE, без SERIALIZABLE, без
// SELECT...FOR UPDATE, без network-вызовов внутри транзакции":
//
//   - markPaymentFailed
//   - restaurantAccept
//   - restaurantAdvance
//
// Почему НЕ markPaid / restaurantDecline / cancelByCustomer (несмотря на то,
// что они значились в предпочтительном списке задания): все три на
// определённых ветках вызывают reserveRefundRow() — то есть СОЗДАЮТ refund-
// строку. Создание refund прямо запрещено на этом этапе ("не переносить...
// refund creation"). Это не отсутствие времени — это найденная аудитом
// СКРЫТАЯ ЗАВИСИМОСТЬ, из-за которой эти три функции откладываются на
// будущую волну (вместе с самим refund-конвейером).
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
// существуют, явно перечислены в комментариях ниже и в
// YAAM-postgresql-order-service-wave-1.pdf, раздел 12.
//
// Ни одна из трёх функций не эмитит orderEvents (в отличие от SQLite-
// версии) — этот модуль ни с чем не соединён (нет бота-подписчика на его
// шину), эмиссия в никуда была бы мёртвым кодом. Это инфраструктурный, не
// бизнес-логический вопрос: подключение уведомлений — часть будущей задачи
// интеграции, не этой волны.

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

module.exports = {
  getOrder,
  markPaymentFailed,
  restaurantAccept,
  restaurantAdvance,
  ADVANCE_MAP,
};
