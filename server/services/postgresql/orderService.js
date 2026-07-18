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
//   Wave 3: sweepTimeouts, finalizeRefundSucceeded, finalizeRefundFailed
//   Wave 4: reserveRetryAttempt, finalizeInitialAttempt, finalizeRetryAttempt
//   Wave 5: createOrder
//
// Wave 2 переносит ровно ту "связанную группу", для которой Wave 1 нашёл
// скрытую зависимость (все три вызывающие функции создают refund-строку через
// reserveRefundRow() на части веток) — теперь reserveRefundRow реализован, и
// вместе с ним становятся переносимы markPaid/restaurantDecline/
// cancelByCustomer.
//
// Wave 3 закрывает ВСЁ, что осталось от refund-жизненного-цикла и НЕ требует
// сетевого вызова провайдера, SERIALIZABLE или SELECT...FOR UPDATE:
//   - sweepTimeouts — та же claim-схема, что restaurantDecline/
//     cancelByCustomer (последняя из этого семейства функций, явно
//     рекомендована предыдущим отчётом волны как приоритет №1);
//   - finalizeRefundSucceeded/finalizeRefundFailed — терминальные переходы
//     refund-строки (processing -> succeeded|failed), симметричный "финализ"-
//     аналог finalizeInitialAttempt/finalizeRetryAttempt из аудита, тот же
//     низкорисковый класс, что и вся Wave 1.
//
// Wave 4 переносит payment-attempt lifecycle (claim → finalize, без самого
// сетевого вызова провайдера — как и во всех предыдущих волнах):
//   - reserveRetryAttempt — claim-резервация повторной попытки оплаты после
//     payment_failed, аналог reserveRefundRow (Wave 2) для payments; тот же
//     принцип "INSERT + partial UNIQUE index как последняя линия защиты",
//     но с ДВУМЯ независимыми точками конфликта (payments и
//     payment_retry_keys) — см. комментарий над функцией.
//   - finalizeInitialAttempt/finalizeRetryAttempt — симметричная пара
//     finalize-шагов (creating -> pending), тот же низкорисковый CU-класс,
//     что и вся Wave 1/3, вызываются ПОСЛЕ ответа провайдера, сами сеть не
//     трогают.
//
// Wave 5 переносит createOrder — единственную функцию во всей матрице,
// требующую serializableTransaction() (SERIALIZABLE + retry на 40001/40P01):
// инвариант "не более одного awaiting_payment заказа на телефон+ресторан в
// TTL-окне" — классический write-skew, не выразимый через partial UNIQUE
// index. Точный replay/secretsAlreadyUsed по-прежнему защищены обычными
// UNIQUE-индексами на order_access_credentials + SAVEPOINT/catch 23505, тем
// же принципом, что reserveRefundRow (Wave 2) / reserveRetryAttempt (Wave 4).
// Как и во всех предыдущих волнах, createOrder() здесь — ТОЛЬКО claim-шаг
// (создание order/order_items/payments/payment_initial_attempts строк);
// сетевой вызов провайдера (оригинальный resolveCreationOrder ->
// ensureInitialAttemptReady) не переносится — уже перенесённый в Wave 4
// finalizeInitialAttempt покрывает finalize-половину того же жизненного
// цикла, оставляя непортированным только сам сетевой хоп к YooKassa.
//
// Ещё не перенесено (сознательно, вне scope Wave 5): ensureRefundReady
// claim-шаг (известный баг WHERE-guard — не эта волна), rateOrder
// (FOR UPDATE), реальные сетевые вызовы YooKassa.
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

// Дословная копия RESTAURANT_RESPONSE_WINDOW_SEC из orderService.js — окно
// ожидания ответа ресторана (секунды), после которого sweepTimeouts()
// просрочивает заказ. Нужен только sweepTimeouts() (Wave 3).
const RESTAURANT_RESPONSE_WINDOW_SEC = 180;

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

// ---------------------------------------------------------------------------
// Wave 4 — payment-attempt lifecycle: ошибки, чистые helper'ы, provider name
// ---------------------------------------------------------------------------
//
// Дословные копии классов ошибок из orderService.js (SQLite) — тот же
// паттерн, что RefundInvariantError выше: PaymentRetryInvariantError/
// PaymentInitialInvariantError имеют ФИКСИРОВАННЫЙ публичный .message,
// диагностика — только в console.error/.internalMessage.
class PaymentRetryConflictError extends Error {
  constructor(message = 'Повторная попытка оплаты уже завершена или недоступна') {
    super(message);
    this.name = 'PaymentRetryConflictError';
    this.statusCode = 409;
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

class PaymentInitialInvariantError extends Error {
  constructor(internalMessage) {
    super('Не удалось безопасно завершить создание платежа');
    this.name = 'PaymentInitialInvariantError';
    this.statusCode = 500;
    this.internalMessage = internalMessage;
  }
}

function paymentInvariant(message) {
  console.error(`[services/postgresql/orderService] payment retry invariant: ${message}`);
  return new PaymentRetryInvariantError(message);
}

function initialPaymentInvariant(message) {
  console.error(`[services/postgresql/orderService] initial payment invariant: ${message}`);
  return new PaymentInitialInvariantError(message);
}

// ---------------------------------------------------------------------------
// НАХОДКА АУДИТА (Wave 4): reserveRetryAttempt в SQLite-версии использует
// server/services/orderAccessService.js.isValidRetryKey()/hashSecret() и
// server/services/paymentService.js.providerName — оба модуля НЕЛЬЗЯ
// импортировать сюда напрямую:
//   - orderAccessService.js делает `const db = require('../db')` на верхнем
//     уровне файла — просто require() этого модуля уже открыл бы SQLite-
//     соединение внутри изолированного PostgreSQL-модуля (прямое нарушение
//     границы "не смешивать SQLite и PostgreSQL");
//   - paymentService.js на верхнем уровне конструирует ЖИВОЙ экземпляр
//     провайдера (MockProvider/YookassaProvider) — не нужен для чистой
//     claim-операции и не должен создаваться как побочный эффект require().
// Обе используемые функции (isValidRetryKey/hashSecret) и класс
// OrderAccessInputError — чистые (regex-проверка, SHA-256, никакого I/O), а
// providerName — тривиальная деривация из ENV. Продублированы здесь ровно
// тем же паттерном, что ADVANCE_MAP/RESTAURANT_RESPONSE_WINDOW_SEC в
// предыдущих волнах — не новая абстракция, а сохранение уже установленной
// границы изоляции модуля.
class OrderAccessInputError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'OrderAccessInputError';
    this.statusCode = statusCode;
  }
}

const RETRY_KEY_RE = /^yaam_retry_v1_[A-Za-z0-9_-]{43}$/;

function isValidRetryKey(key) {
  return typeof key === 'string' && RETRY_KEY_RE.test(key);
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

const PROVIDER_NAME = process.env.PAYMENT_PROVIDER || 'mock';

// ---------------------------------------------------------------------------
// Wave 5 (createOrder) — та же граница изоляции, что описана выше для Wave 4:
// orderAccessService.js/paymentService.js нельзя импортировать (SQLite/
// провайдер как побочный эффект require()), поэтому дублируются только
// реально нужные createOrder чистые части: валидация/хэширование секретов
// создания заказа (isValidOrderToken/isValidCreateKey/hashCreationRequest),
// класс ActiveOrderConflictError, нормализация телефона, форматирование
// public_code и TTL-константа дедупа — дословные копии соответствующих
// функций/констант из orderAccessService.js и orderService.js (SQLite).
// ---------------------------------------------------------------------------

class OrderCreationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderCreationInputError';
    this.statusCode = 400;
  }
}

class ActiveOrderConflictError extends Error {
  constructor() {
    super('Для этого ресторана уже есть незавершённый заказ');
    this.name = 'ActiveOrderConflictError';
    this.statusCode = 409;
  }
}

const ORDER_TOKEN_RE = /^yaam_ord_v1_[A-Za-z0-9_-]{43}$/;
const CREATE_KEY_RE = /^yaam_create_v1_[A-Za-z0-9_-]{43}$/;

function isValidOrderToken(token) {
  return typeof token === 'string' && ORDER_TOKEN_RE.test(token);
}

function isValidCreateKey(key) {
  return typeof key === 'string' && CREATE_KEY_RE.test(key);
}

function hashCreationRequest(canonicalRequest) {
  return hashSecret(JSON.stringify(canonicalRequest));
}

// Дословная копия normalizeRuPhone() из orderService.js (SQLite) — сервер не
// доверяет фронту, нормализует номер заново, а не просто принимает то, что
// прислал клиент.
function normalizeRuPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  if (d.length !== 11 || d[0] !== '7') return null;
  return `+${d}`;
}

// Дословная копия formatPublicCode() — публичный номер строится из
// внутреннего id (IDENTITY, уникален и монотонно растёт), не случайного числа.
function formatPublicCode(id) {
  return `YAAM-${String(id).padStart(5, '0')}`;
}

// Дословная копия AWAITING_PAYMENT_DEDUP_TTL_SEC (см. комментарий в
// orderService.js) — временная demo-логика дедупа брошенных неоплаченных
// заказов, продуктовое решение, не часть этой волны.
const AWAITING_PAYMENT_DEDUP_TTL_SEC = 15 * 60;

// Асинхронный аналог initialAttemptRowByCredentials() из SQLite-версии —
// точный replay по паре секретов создания заказа (BOTH token_hash И
// create_key_hash должны совпасть — в отличие от secretsAlreadyUsed ниже,
// которая проверяет OR). LEFT JOIN на payment_initial_attempts сохранён
// дословно, хотя для строк, созданных самим createOrder(), ledger всегда
// существует — защитный случай сохранён для побитового соответствия оригиналу.
async function initialAttemptRowByCredentials(tokenHash, createKeyHash, client = null) {
  const rows = await db.query(
    `SELECT p.*, p.order_id AS initial_order_id,
       a.provider_idempotency_key, a.state AS initial_state,
       c.request_hash
     FROM order_access_credentials c
     JOIN payments p ON p.order_id = c.order_id
     LEFT JOIN payment_initial_attempts a ON a.payment_id = p.id
     WHERE c.token_hash = $1 AND c.create_key_hash = $2
     ORDER BY CASE WHEN a.payment_id IS NOT NULL THEN 0 ELSE 1 END, p.id ASC
     LIMIT 1`,
    [tokenHash, createKeyHash],
    client
  );
  return rows[0] || null;
}

// createOrder — единственное место во всей матрице, где обязателен
// serializableTransaction() (см. server/docs/postgresql-concurrency-
// migration-matrix.md, строка #2). Причина: инвариант "не более одного
// awaiting_payment заказа на телефон+ресторан в TTL-окне" — это классический
// write-skew (два конкурентных SELECT видят "конфликтов нет", оба вставляют
// новый заказ) и НЕ выражается через partial UNIQUE index (условие зависит от
// времени и множества строк, а не от одного уникального ключа). Обычная
// SERIALIZABLE-изоляция (SSI, predicate locks) обнаруживает эту аномалию и
// абортирует одну из транзакций с 40001 — retry-обёртка автоматически
// перезапускает её с нуля, и на повторной попытке conflictingOrder-SELECT
// уже видит зафиксированную строку победителя, поэтому корректно бросает
// ActiveOrderConflictError вместо "утечки" сырой 40001 наружу.
//
// Точный replay (та же пара секретов) и secretsAlreadyUsed, напротив, УЖЕ
// защищены partial/обычными UNIQUE-индексами на order_access_credentials
// (token_hash, create_key_hash) — это последняя линия защиты для этой ветки,
// тот же принцип SAVEPOINT + catch 23505 + повторное чтение
// строки-победителя, что и в reserveRefundRow (Wave 2) / reserveRetryAttempt
// (Wave 4). 23505 здесь НЕ ретраится (не транзиентна) — только сам факт
// serialization failure (40001/40P01) ретраится обёрткой serializableTransaction().
//
// Реально достижимый ТОЛЬКО под PostgreSQL edge-case (структурно невозможен
// под однопоточным SQLite): два конкурентных запроса с ЧАСТИЧНО совпадающими
// секретами (совпадает только token ИЛИ только createKey, не оба сразу — это
// не легитимный клиентский сценарий, а либо баг клиента, либо злонамеренный
// повтор одного секрета из другой сессии) могут пройти pre-insert
// secretsAlreadyUsed-проверку одновременно (оба видят "не занято"), и тогда
// один из двух получит 23505 от отдельного UNIQUE-индекса (token_hash ИЛИ
// create_key_hash), для которого точный AND-replay (initialAttemptRowByCredentials)
// не находит строку-победителя (у неё другая вторая половина пары). В этом
// случае бросается тот же ActiveOrderConflictError, что бросил бы
// синхронный pre-insert secretsAlreadyUsed-путь, если бы успел увидеть
// конфликт первым — семантически идентичный исход, не новая ветка ошибки.
async function createOrder({
  restaurantId, city, customerName, customerPhone, address, comment, items,
  fulfillmentType, orderAccessToken, createIdempotencyKey,
}) {
  if (!isValidOrderToken(orderAccessToken)) {
    throw new OrderAccessInputError('Некорректный токен доступа к заказу', 401);
  }
  if (!isValidCreateKey(createIdempotencyKey)) {
    throw new OrderAccessInputError('Некорректный ключ создания заказа');
  }
  const tokenHash = hashSecret(orderAccessToken);
  const createKeyHash = hashSecret(createIdempotencyKey);

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
  const requestHash = hashCreationRequest({
    restaurantId: Number(restaurantId),
    city: city || '',
    customerName: normalizedCustomerName,
    customerPhone: normalizedPhone,
    address: normalizedAddress,
    comment: normalizedComment,
    fulfillmentType: normalizedFulfillment,
    items: canonicalItems,
  });

  // Тот же fast-path, что в SQLite: идемпотентный replay не должен зависеть
  // от изменчивого меню/режима ресторана — снимок уже зафиксирован COMMIT'ом
  // первой попытки.
  const existingAttempt = await initialAttemptRowByCredentials(tokenHash, createKeyHash);
  if (existingAttempt) {
    if (!Buffer.from(existingAttempt.request_hash).equals(requestHash)) {
      throw new ActiveOrderConflictError();
    }
    return { orderId: existingAttempt.initial_order_id, replay: true };
  }

  const restaurantRows = await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new OrderCreationInputError('ресторан не найден');
  if (!restaurant.is_open) throw new OrderCreationInputError('ресторан сейчас закрыт — заказ невозможен');

  // Клиентские name/price — не источник истины, только menuItemId проверяется
  // и цена/название берутся из БД. Прямой вызов API в обход браузера не может
  // занизить сумму.
  const trustedItems = [];
  for (const { menuItemId, qty, clientName } of requestedItems) {
    const rows = await db.query(
      'SELECT * FROM menu_items WHERE id = $1 AND restaurant_id = $2',
      [menuItemId, restaurantId]
    );
    const real = rows[0];
    if (!real) throw new OrderCreationInputError(`блюдо не найдено: ${clientName || menuItemId}`);
    if (!real.is_available) throw new OrderCreationInputError(`блюдо «${real.name}» сейчас в стоп-листе`);
    trustedItems.push({ menuItemId, name: real.name, price: real.price, qty });
  }

  const itemsTotal = trustedItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (itemsTotal < restaurant.min_order) {
    throw new OrderCreationInputError(`сумма заказа ${itemsTotal} меньше минимальной ${restaurant.min_order}`);
  }
  const commission = Math.round(itemsTotal * 0.07); // YAAM_COMMISSION_RATE, дословно из paymentService.calcCommission

  return db.serializableTransaction(async (client) => {
    const exactReplay = await initialAttemptRowByCredentials(tokenHash, createKeyHash, client);
    if (exactReplay) {
      if (!Buffer.from(exactReplay.request_hash).equals(requestHash)) {
        throw new ActiveOrderConflictError();
      }
      return { orderId: exactReplay.initial_order_id, replay: true };
    }

    const conflictRows = await db.query(
      `SELECT id FROM orders
       WHERE restaurant_id = $1 AND customer_phone = $2 AND status = 'awaiting_payment'
         AND (
           NOW() - created_at <= ($3 || ' seconds')::interval
           OR EXISTS (
             SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'creating'
           )
         )
       ORDER BY id DESC LIMIT 1`,
      [restaurantId, normalizedPhone, AWAITING_PAYMENT_DEDUP_TTL_SEC],
      client
    );
    const usedRows = await db.query(
      'SELECT 1 FROM order_access_credentials WHERE token_hash = $1 OR create_key_hash = $2 LIMIT 1',
      [tokenHash, createKeyHash],
      client
    );
    if (conflictRows[0] || usedRows[0]) {
      throw new ActiveOrderConflictError();
    }

    await client.query('SAVEPOINT create_order_claim');
    try {
      const orderRows = await db.execute(
        `INSERT INTO orders (
           public_code, restaurant_id, city, customer_name, customer_phone, address,
           fulfillment_type, comment, items_total, commission_amount, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_payment') RETURNING id`,
        [
          `TMP-${process.hrtime.bigint()}`, restaurantId, city, normalizedCustomerName, normalizedPhone,
          normalizedAddress, normalizedFulfillment, normalizedComment, itemsTotal, commission,
        ],
        client
      );
      const newId = orderRows.rows[0].id;
      await db.execute('UPDATE orders SET public_code = $1 WHERE id = $2', [formatPublicCode(newId), newId], client);
      await db.execute(
        'INSERT INTO order_access_credentials (order_id, token_hash, create_key_hash, request_hash) VALUES ($1,$2,$3,$4)',
        [newId, tokenHash, createKeyHash, requestHash],
        client
      );
      for (const it of trustedItems) {
        await db.execute(
          'INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES ($1,$2,$3,$4,$5)',
          [newId, it.menuItemId, it.name, it.price, it.qty],
          client
        );
      }
      const payRows = await db.execute(
        `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
         VALUES ($1, $2, NULL, $3, 'creating') RETURNING id`,
        [newId, PROVIDER_NAME, itemsTotal],
        client
      );
      const paymentId = payRows.rows[0].id;
      await db.execute(
        `INSERT INTO payment_initial_attempts (payment_id, provider_idempotency_key, state)
         VALUES ($1, $2, 'creating')`,
        [paymentId, newProviderIdempotencyKey()],
        client
      );
      await client.query('RELEASE SAVEPOINT create_order_claim');
      return { orderId: newId, replay: false };
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT create_order_claim');
      if (err.code !== '23505') throw err;

      const winner = await initialAttemptRowByCredentials(tokenHash, createKeyHash, client);
      if (!winner) {
        // Реально достижимо только частичным совпадением секретов — см.
        // комментарий над функцией. Тот же публичный исход, что и у
        // синхронного pre-insert secretsAlreadyUsed-пути.
        throw new ActiveOrderConflictError();
      }
      if (!Buffer.from(winner.request_hash).equals(requestHash)) {
        throw new ActiveOrderConflictError();
      }
      return { orderId: winner.initial_order_id, replay: true };
    }
  });
}

// Асинхронный аналог paymentResultFromRow() из SQLite-версии — читает
// payment_presentations (существующая строка, не создание) для сборки
// публичного результата finalize-функций.
async function paymentResultFromRow(paymentRow, client = null) {
  if (!paymentRow || !paymentRow.provider_payment_id) return null;
  const rows = await db.query(
    'SELECT payment_url, qr_payload FROM payment_presentations WHERE payment_id = $1',
    [paymentRow.id],
    client
  );
  const presentation = rows[0];
  if (!presentation) return null;
  return {
    providerPaymentId: paymentRow.provider_payment_id,
    paymentUrl: presentation.payment_url || null,
    qrPayload: presentation.qr_payload || null,
  };
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

// ---------------------------------------------------------------------------
// finalizeRefundSucceeded(refundId, providerRefundId) — Wave 3
// ---------------------------------------------------------------------------
//
// Сохранены все ветки SQLite-контракта:
//   1. refund не найден -> throw refundInvariant('строка возврата для
//      финализации не найдена').
//   2. уже 'succeeded' -> тихий idempotent no-op, возвращает текущую строку
//      (повторный вызов — уже финализирован).
//   3. статус не 'processing' (и не 'succeeded') -> throw refundInvariant(...).
//   4. штатный путь: refund -> succeeded (+ provider_refund_id/completed_at),
//      payment succeeded -> refunded, одной транзакцией.
//   5. race-проигрыш финального UPDATE -> throw refundInvariant('не удалось
//      атомарно зафиксировать успешный возврат').
//
// Предварительный SELECT здесь НЕОБХОДИМ (задание, п.6, исключение) — нужно
// различить "уже succeeded" (no-op, НЕ ошибка) от "неверный статус" (throw) —
// эта развилка не выражается одним WHERE без потери информации о том, какая
// ветка сработала. Как следствие (та же природа, что у restaurantAdvance в
// Wave 1 и markPaid/cancelByCustomer в Wave 2): окно между чтением и финальным
// UPDATE реально существует и достижимо под PostgreSQL — например, два
// конкурентных вызова finalizeRefundSucceeded (дублированный webhook) на один
// refund — проверено живым concurrency-тестом.
async function finalizeRefundSucceeded(refundId, providerRefundId) {
  return db.transaction(async (client) => {
    const currentRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
    const current = currentRows[0];
    if (!current) throw refundInvariant('строка возврата для финализации не найдена');
    if (current.status === 'succeeded') return current; // повторный вызов — уже финализирован, безопасный no-op
    if (current.status !== 'processing') {
      throw refundInvariant(`финализация succeeded невозможна из состояния ${current.status}`);
    }

    const updated = await db.execute(
      `UPDATE refunds SET status = 'succeeded', provider_refund_id = $1,
         next_attempt_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'processing'`,
      [providerRefundId, refundId],
      client
    );
    if (updated.rowCount !== 1) throw refundInvariant('не удалось атомарно зафиксировать успешный возврат');

    await db.execute(
      `UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE id = $1 AND status = 'succeeded'`,
      [current.payment_id],
      client
    );

    const finalRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
    return finalRows[0];
  });
}

// ---------------------------------------------------------------------------
// finalizeRefundFailed(refundId, errorCode) — Wave 3
// ---------------------------------------------------------------------------
//
// Тот же паттерн, что finalizeRefundSucceeded — ветки:
//   1. refund не найден -> throw refundInvariant(...).
//   2. уже 'failed' -> тихий idempotent no-op.
//   3. статус не 'processing' -> throw refundInvariant(...).
//   4. штатный путь: refund -> failed (+ last_error_code/completed_at),
//      payment НЕ трогается (в отличие от succeeded — платёж остаётся
//      succeeded, деньги ещё у нас, возврат не удался).
//   5. race-проигрыш -> throw refundInvariant('не удалось атомарно
//      зафиксировать неуспешный возврат').
async function finalizeRefundFailed(refundId, errorCode) {
  return db.transaction(async (client) => {
    const currentRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
    const current = currentRows[0];
    if (!current) throw refundInvariant('строка возврата для финализации не найдена');
    if (current.status === 'failed') return current;
    if (current.status !== 'processing') {
      throw refundInvariant(`финализация failed невозможна из состояния ${current.status}`);
    }

    const updated = await db.execute(
      `UPDATE refunds SET status = 'failed', last_error_code = $1,
         next_attempt_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'processing'`,
      [errorCode, refundId],
      client
    );
    if (updated.rowCount !== 1) throw refundInvariant('не удалось атомарно зафиксировать неуспешный возврат');

    const finalRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
    return finalRows[0];
  });
}

// ---------------------------------------------------------------------------
// sweepTimeouts() — Wave 3
// ---------------------------------------------------------------------------
//
// Периодический свип (см. server.js в оригинале — setInterval). Каждый
// просроченный заказ — своя ОТДЕЛЬНАЯ транзакция (не общая на весь батч):
// падение/исключение на одном заказе не должно останавливать обработку
// остальных — сохранено через try/catch на каждой итерации, как в оригинале.
//
// SQL-стратегия: `strftime('%s','now') - strftime('%s', status_updated_at) >
// ?` (SQLite epoch-diff) заменяется на `NOW() - status_updated_at > (? ||
// ' seconds')::interval` (см. YAAM-postgresql-migration-analysis.pdf,
// раздел про даты) — семантически идентично, дата хранится как TIMESTAMPTZ,
// не TEXT.
//
// Как и restaurantDecline/cancelByCustomer в Wave 2: conditional UPDATE
// заказа выполняется ПЕРВЫМ (WHERE status='awaiting_restaurant', константа),
// reserveRefundRow вызывается ТОЛЬКО если переход реально применился —
// проигравшая гонка (заказ уже обработан другим событием между SELECT
// кандидатов и этой транзакцией) даёт тихий skip, не лишний вызов
// reserveRefundRow и не ошибку. Тем же следствием, что и у restaurantAccept
// в Wave 1 (нет предварительного getOrder-чтения внутри транзакции), здесь
// нет отдельного "race после подтверждённой проверки" throw-пути, который
// был у оригинала (тот путь SQLite тоже никогда не должен был исполняться).
async function sweepTimeouts() {
  const stale = await db.query(
    `SELECT id FROM orders
     WHERE status = 'awaiting_restaurant'
       AND NOW() - status_updated_at > ($1 || ' seconds')::interval`,
    [RESTAURANT_RESPONSE_WINDOW_SEC]
  );

  for (const { id } of stale) {
    try {
      await db.transaction(async (client) => {
        const updated = await db.execute(
          `UPDATE orders SET status = 'timed_out', status_updated_at = NOW()
           WHERE id = $1 AND status = 'awaiting_restaurant'`,
          [id],
          client
        );
        if (updated.rowCount !== 1) return; // уже обработан другим событием — тихий skip

        const paymentRows = await db.query(
          `SELECT * FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
          [id],
          client
        );
        await reserveRefundRow(paymentRows[0] || null, 'timeout', client);
      });
    } catch (err) {
      // Тот же принцип, что в оригинале: ошибка на одном заказе не должна
      // останавливать обработку остальных заказов этого же свипа.
      console.error(`[services/postgresql/orderService] sweepTimeouts failed for order ${id}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// reserveRetryAttempt(orderId, retryKey) — Wave 4
// ---------------------------------------------------------------------------
//
// Сохранены все ветки SQLite-контракта:
//   1. невалидный retryKey -> throw new OrderAccessInputError('Некорректный
//      ключ повторной оплаты') — ДО открытия транзакции, как и в оригинале.
//   2. тот же client key уже использован:
//      - для ДРУГОГО заказа -> throw new PaymentRetryConflictError() (дефолтное сообщение);
//      - для этого заказа, попытка ещё активна (creating/pending) -> вернуть
//        её (idempotent — повторный клик/replay тем же ключом);
//      - для этого заказа, попытка уже терминальна -> throw
//        PaymentRetryConflictError('Предыдущая попытка оплаты завершена — начните новую').
//   3. другой (новый) client key, но для заказа УЖЕ есть активная попытка
//      (creating/pending) -> привязать новый ключ к ней и вернуть её (сходимость
//      нескольких вкладок/устройств к одной попытке).
//   4. активной попытки нет:
//      - заказ не найден -> throw new Error('заказ не найден') (обычный Error, не custom-класс);
//      - order.status !== 'payment_failed' -> throw PaymentRetryConflictError('Повторная оплата возможна только после ошибки оплаты');
//      - иначе: создать payments(creating)+payment_retry_attempts(creating)+payment_retry_keys, вернуть.
//
// SQL-стратегия и НАЙДЕННЫЙ concurrency-риск (задание явно просило проверить
// "может ли retry получить одинаковый attempt number" / "что при двух
// одновременных reserveRetryAttempt"): SQLite-комментарий над оригиналом прямо
// признаёт, что partial UNIQUE index — ПОСЛЕДНЯЯ линия защиты, JS-проверки
// выше — только UX-слой. Под PostgreSQL это РЕАЛЬНАЯ гонка с ДВУМЯ разными
// точками конфликта:
//   (a) ux_payments_one_active_per_order — два конкурентных вызова с РАЗНЫМИ
//       client key, оба видят "активной попытки нет", оба пытаются INSERT в
//       payments;
//   (b) payment_retry_keys.client_key_hash (PRIMARY KEY) — два конкурентных
//       вызова с ОДНИМ И ТЕМ ЖЕ client key (двойной клик/повтор запроса).
// Оба случая закрыты SAVEPOINT + catch 23505 + повторное чтение
// строки-победителя (тот же принцип, что reserveRefundRow в Wave 2) — НЕ
// ретраится как транзиентная ошибка, конфликт разрешается чтением, а не
// повтором callback'а. Живо доказано concurrency-тестами ниже.
const RETRY_ATTEMPT_BY_CLIENT_KEY_SQL = `
  SELECT p.*, p.order_id AS retry_order_id, a.provider_idempotency_key, a.state AS retry_state
  FROM payment_retry_keys k
  JOIN payment_retry_attempts a ON a.payment_id = k.payment_id
  JOIN payments p ON p.id = a.payment_id
  WHERE k.client_key_hash = $1`;

const ACTIVE_RETRY_ATTEMPT_SQL = `
  SELECT p.*, p.order_id AS retry_order_id, a.provider_idempotency_key, a.state AS retry_state
  FROM payments p
  LEFT JOIN payment_retry_attempts a ON a.payment_id = p.id
  WHERE p.order_id = $1 AND p.status IN ('creating', 'pending')
  ORDER BY p.id DESC LIMIT 1`;

// Привязывает client key к уже существующей активной попытке. Отдельная
// SAVEPOINT-защита: тот же client key мог конкурентно привязываться дважды
// (двойной клик/повтор сетевого запроса тем же ключом) — PRIMARY KEY на
// client_key_hash тогда даёт 23505, что здесь трактуется как идемпотентный
// успех (строка с нужным содержимым уже существует), а не ошибка.
async function linkRetryClientKey(client, clientKeyHash, paymentId) {
  await client.query('SAVEPOINT link_retry_key');
  try {
    await db.execute(
      'INSERT INTO payment_retry_keys (client_key_hash, payment_id) VALUES ($1, $2)',
      [clientKeyHash, paymentId],
      client
    );
    await client.query('RELEASE SAVEPOINT link_retry_key');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT link_retry_key');
    if (err.code !== '23505') throw err;
    // Уже привязан конкурентно — идемпотентно, ничего делать не нужно.
  }
}

async function reserveRetryAttempt(orderId, retryKey) {
  if (!isValidRetryKey(retryKey)) {
    throw new OrderAccessInputError('Некорректный ключ повторной оплаты');
  }
  const clientKeyHash = hashSecret(retryKey);

  return db.transaction(async (client) => {
    const sameKeyRows = await db.query(RETRY_ATTEMPT_BY_CLIENT_KEY_SQL, [clientKeyHash], client);
    const sameKey = sameKeyRows[0];
    if (sameKey) {
      if (sameKey.retry_order_id !== orderId) throw new PaymentRetryConflictError();
      if (['creating', 'pending'].includes(sameKey.status)) return sameKey;
      throw new PaymentRetryConflictError('Предыдущая попытка оплаты завершена — начните новую');
    }

    const activeRows = await db.query(ACTIVE_RETRY_ATTEMPT_SQL, [orderId], client);
    const active = activeRows[0];
    if (active) {
      if (!active.provider_idempotency_key) throw new PaymentRetryConflictError();
      await linkRetryClientKey(client, clientKeyHash, active.id);
      return active;
    }

    const orderRows = await db.query('SELECT * FROM orders WHERE id = $1', [orderId], client);
    const order = orderRows[0];
    if (!order) throw new Error('заказ не найден');
    if (order.status !== 'payment_failed') {
      throw new PaymentRetryConflictError('Повторная оплата возможна только после ошибки оплаты');
    }

    await client.query('SAVEPOINT reserve_retry_attempt');
    try {
      const paymentRows = await db.execute(
        `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
         VALUES ($1, $2, NULL, $3, 'creating') RETURNING id`,
        [orderId, PROVIDER_NAME, order.items_total],
        client
      );
      const paymentId = paymentRows.rows[0].id;
      const providerIdempotencyKey = newProviderIdempotencyKey();
      await db.execute(
        `INSERT INTO payment_retry_attempts (payment_id, provider_idempotency_key, state)
         VALUES ($1, $2, 'creating')`,
        [paymentId, providerIdempotencyKey],
        client
      );
      await db.execute(
        'INSERT INTO payment_retry_keys (client_key_hash, payment_id) VALUES ($1, $2)',
        [clientKeyHash, paymentId],
        client
      );
      await client.query('RELEASE SAVEPOINT reserve_retry_attempt');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT reserve_retry_attempt');
      if (err.code !== '23505') throw err;

      // Проиграли гонку — кто-то другой уже зарезервировал активную попытку
      // для этого заказа (либо уже использовал этот же client key) между
      // нашей проверкой выше и этим INSERT. Не ретраим callback — читаем
      // актуальное состояние и сходимся к нему, как и в штатных ветках 1-3.
      const winnerSameKeyRows = await db.query(RETRY_ATTEMPT_BY_CLIENT_KEY_SQL, [clientKeyHash], client);
      if (winnerSameKeyRows[0]) return winnerSameKeyRows[0];

      const winnerActiveRows = await db.query(ACTIVE_RETRY_ATTEMPT_SQL, [orderId], client);
      const winnerActive = winnerActiveRows[0];
      if (!winnerActive) {
        throw paymentInvariant('конфликт резервации retry-попытки без найденной строки-победителя');
      }
      if (!winnerActive.provider_idempotency_key) throw new PaymentRetryConflictError();
      await linkRetryClientKey(client, clientKeyHash, winnerActive.id);
      return winnerActive;
    }

    const finalRows = await db.query(ACTIVE_RETRY_ATTEMPT_SQL, [orderId], client);
    return finalRows[0];
  });
}

// ---------------------------------------------------------------------------
// finalizeInitialAttempt(paymentRowId, payment) — Wave 4
// ---------------------------------------------------------------------------
//
// Сохранены все ветки SQLite-контракта:
//   1. попытка не найдена -> throw initialPaymentInvariant('зарезервированный
//      первоначальный платёж не найден').
//   2. order.status !== 'awaiting_payment' -> throw initialPaymentInvariant(...)
//      — ПРОВЕРЯЕТСЯ ВСЕГДА, даже на idempotent-ветке ниже (дословно как в
//      оригинале — намеренно не "оптимизировано").
//   3. initial_state === 'ready' (idempotent-повтор):
//      - provider_payment_id не совпадает с payment.providerPaymentId ->
//        throw initialPaymentInvariant('провайдер вернул другой первоначальный
//        платёж для того же ключа') — это НЕ idempotent-успех, а конфликт;
//      - иначе вернуть уже готовый результат (без записи).
//   4. НЕ (initial_state==='creating' И payments.status==='creating') ->
//      throw initialPaymentInvariant('первоначальный платёж находится в
//      несовместимом состоянии').
//   5. штатный путь: payments creating->pending, upsert presentation,
//      payment_initial_attempts creating->ready, одной транзакцией.
//
// Реально достижимая под PostgreSQL гонка (два конкурентных
// finalizeInitialAttempt на один paymentRowId — недостижимо под SQLite):
// один выигрывает conditional UPDATE, другой получает rowCount=0 и throw
// initialPaymentInvariant('не удалось финализировать первоначальный платёж')
// — сохранено, не "исправлено" молча, проверено живым тестом.
async function finalizeInitialAttempt(paymentRowId, payment) {
  return db.transaction(async (client) => {
    const attemptRows = await db.query(
      `SELECT p.*, a.provider_idempotency_key, a.state AS initial_state,
         o.status AS order_status
       FROM payments p JOIN payment_initial_attempts a ON a.payment_id = p.id
       JOIN orders o ON o.id = p.order_id
       WHERE p.id = $1`,
      [paymentRowId],
      client
    );
    const attempt = attemptRows[0];
    if (!attempt) throw initialPaymentInvariant('зарезервированный первоначальный платёж не найден');
    if (attempt.order_status !== 'awaiting_payment') {
      throw initialPaymentInvariant('статус заказа изменился во время создания платежа; требуется сверка');
    }
    if (attempt.initial_state === 'ready') {
      if (attempt.provider_payment_id !== payment.providerPaymentId) {
        throw initialPaymentInvariant('провайдер вернул другой первоначальный платёж для того же ключа');
      }
      const existing = await paymentResultFromRow(attempt, client);
      if (!existing) throw initialPaymentInvariant('готовый первоначальный платёж не содержит presentation');
      return existing;
    }
    if (attempt.initial_state !== 'creating' || attempt.status !== 'creating') {
      throw initialPaymentInvariant('первоначальный платёж находится в несовместимом состоянии');
    }

    const finalized = await db.execute(
      `UPDATE payments SET provider_payment_id = $1, status = 'pending', updated_at = NOW()
       WHERE id = $2 AND status = 'creating'`,
      [payment.providerPaymentId, paymentRowId],
      client
    );
    if (finalized.rowCount !== 1) {
      throw initialPaymentInvariant('не удалось финализировать первоначальный платёж');
    }
    await db.execute(
      `INSERT INTO payment_presentations (payment_id, payment_url, qr_payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (payment_id) DO UPDATE SET
         payment_url = excluded.payment_url,
         qr_payload = excluded.qr_payload`,
      [paymentRowId, payment.paymentUrl || null, payment.qrPayload || null],
      client
    );
    const ready = await db.execute(
      `UPDATE payment_initial_attempts SET state = 'ready', updated_at = NOW()
       WHERE payment_id = $1 AND state = 'creating'`,
      [paymentRowId],
      client
    );
    if (ready.rowCount !== 1) {
      throw initialPaymentInvariant('ledger первоначального платежа не перешёл в ready');
    }

    const finalPaymentRows = await db.query('SELECT * FROM payments WHERE id = $1', [paymentRowId], client);
    return paymentResultFromRow(finalPaymentRows[0], client);
  });
}

// ---------------------------------------------------------------------------
// finalizeRetryAttempt(paymentRowId, payment) — Wave 4
// ---------------------------------------------------------------------------
//
// Сохранены все ветки SQLite-контракта (намеренно АСИММЕТРИЧНЫЕ относительно
// finalizeInitialAttempt — это свойство оригинала, не унифицировано здесь):
//   1. попытка не найдена -> throw paymentInvariant('зарезервированная
//      попытка оплаты не найдена').
//   2. payments.status === 'pending' (idempotent-повтор, определяется по
//      payments.status, НЕ по payment_retry_attempts.state — в отличие от
//      finalizeInitialAttempt):
//      - provider_payment_id не совпадает -> throw paymentInvariant('провайдер
//        вернул другой платёж для того же ключа идемпотентности');
//      - иначе вернуть готовый результат (без записи, БЕЗ проверки статуса
//        заказа — эта проверка здесь не выполняется на idempotent-ветке,
//        в отличие от finalizeInitialAttempt).
//   3. payments.status !== 'creating' (и не 'pending') -> throw new
//      PaymentRetryConflictError() (дефолтное сообщение, НЕ paymentInvariant).
//   4. штатный путь: проверить order.status==='payment_failed', затем
//      payments creating->pending, upsert presentation, payment_retry_attempts
//      creating->ready, orders payment_failed->awaiting_payment — одной
//      транзакцией.
//
// Реально достижимая под PostgreSQL гонка (два конкурентных
// finalizeRetryAttempt на один paymentRowId): один выигрывает финальный
// conditional UPDATE payments, другой — rowCount=0 -> throw
// paymentInvariant('не удалось финализировать платёжную попытку') —
// проверено живым тестом.
async function finalizeRetryAttempt(paymentRowId, payment) {
  return db.transaction(async (client) => {
    const attemptRows = await db.query(
      `SELECT p.*, r.provider_idempotency_key
       FROM payments p JOIN payment_retry_attempts r ON r.payment_id = p.id
       WHERE p.id = $1`,
      [paymentRowId],
      client
    );
    const attempt = attemptRows[0];
    if (!attempt) throw paymentInvariant('зарезервированная попытка оплаты не найдена');
    if (attempt.status === 'pending') {
      if (attempt.provider_payment_id !== payment.providerPaymentId) {
        throw paymentInvariant('провайдер вернул другой платёж для того же ключа идемпотентности');
      }
      return paymentResultFromRow(attempt, client);
    }
    if (attempt.status !== 'creating') throw new PaymentRetryConflictError();

    const orderRows = await db.query('SELECT status FROM orders WHERE id = $1', [attempt.order_id], client);
    const order = orderRows[0];
    if (!order || order.status !== 'payment_failed') {
      throw paymentInvariant('состояние заказа изменилось во время создания платежа; требуется сверка');
    }

    const finalized = await db.execute(
      `UPDATE payments SET provider_payment_id = $1, status = 'pending', updated_at = NOW()
       WHERE id = $2 AND status = 'creating'`,
      [payment.providerPaymentId, paymentRowId],
      client
    );
    if (finalized.rowCount !== 1) throw paymentInvariant('не удалось финализировать платёжную попытку');

    await db.execute(
      `INSERT INTO payment_presentations (payment_id, payment_url, qr_payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (payment_id) DO UPDATE SET
         payment_url = excluded.payment_url,
         qr_payload = excluded.qr_payload`,
      [paymentRowId, payment.paymentUrl || null, payment.qrPayload || null],
      client
    );
    const retryReady = await db.execute(
      `UPDATE payment_retry_attempts SET state = 'ready', updated_at = NOW()
       WHERE payment_id = $1 AND state = 'creating'`,
      [paymentRowId],
      client
    );
    if (retryReady.rowCount !== 1) throw paymentInvariant('ledger повторной оплаты не перешёл в ready');

    const updatedOrder = await db.execute(
      `UPDATE orders SET status = 'awaiting_payment', status_updated_at = NOW()
       WHERE id = $1 AND status = 'payment_failed'`,
      [attempt.order_id],
      client
    );
    if (updatedOrder.rowCount !== 1) throw paymentInvariant('не удалось активировать повторную оплату');

    const finalPaymentRows = await db.query('SELECT * FROM payments WHERE id = $1', [paymentRowId], client);
    return paymentResultFromRow(finalPaymentRows[0], client);
  });
}

module.exports = {
  getOrder,
  createOrder,
  reserveRefundRow,
  markPaymentFailed,
  markPaid,
  restaurantAccept,
  restaurantDecline,
  restaurantAdvance,
  cancelByCustomer,
  finalizeRefundSucceeded,
  finalizeRefundFailed,
  sweepTimeouts,
  reserveRetryAttempt,
  finalizeInitialAttempt,
  finalizeRetryAttempt,
  ADVANCE_MAP,
  RESTAURANT_RESPONSE_WINDOW_SEC,
  AWAITING_PAYMENT_DEDUP_TTL_SEC,
  ActiveOrderConflictError,
  OrderCreationInputError,
};
