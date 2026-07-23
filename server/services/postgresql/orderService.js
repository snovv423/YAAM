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
//   Wave 6: rateOrder
//   Wave 7: claimRefundForProcessing (claim-половина ensureRefundReady)
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
// Wave 6 переносит rateOrder — единственную функцию во всей матрице,
// требующую SELECT ... FOR UPDATE: restaurants.rating/rating_count — classic
// read-modify-write агрегат без conditional-UPDATE-эквивалента. Порядок
// блокировок (orders-строка первой, restaurants-строка второй) сохранён
// дословно из оригинала и исключает deadlock конструктивно (см. комментарий
// над функцией). Живой механизм FOR UPDATE уже был доказан заранее в
// concurrency.test.js #5/6/7 (написаны именно на этой паре колонок при
// проектировании Concurrency Strategy) — Wave 6 тестирует саму функцию
// rateOrder(), не переоткрывает общий механизм.
//
// Wave 7 переносит claimRefundForProcessing — исправленную (lease-guarded,
// Вариант D) claim-половину ensureRefundReady. Это ЗАКРЫВАЕТ последнюю
// строку 15-пунктовой concurrency-матрицы: вся SQL-side бизнес-логика
// orderService.js, не требующая реального сетевого вызова провайдера,
// теперь перенесена и живо протестирована.
//
// Ещё НЕ перенесено на конец Wave 7 (SQL-side миграция): сам сетевой
// оркестратор ensureRefundReady() (вызов paymentService.refundPayment()/
// провайдера), sweepStuckRefunds() (поиск кандидатов для повтора — SQL
// несложен, но вызывает оркестратор, который не переносится), реальное
// производственное переключение на PostgreSQL.
//
// Архитектурная граница: намеренно НЕТ никакого `if (process.env.DB ===
// 'postgres')` переключателя ни здесь, ни в SQLite-версии. Два модуля с
// одинаковыми именами функций, разными реализациями, разными файлами.
//
// Единственное намеренное отличие интерфейса от SQLite-версии: все функции
// здесь ASYNC (возвращают Promise) — это неизбежное следствие асинхронного
// драйвера `pg`, а не изменение бизнес-логики. Остальные аспекты контракта
// (входные параметры, форма результата, текст сообщений об ошибках,
// статусные переходы) воспроизведены дословно — расхождения, где они
// существуют, явно перечислены в комментариях ниже и в PDF-отчётах каждой волны.
//
// ---------------------------------------------------------------------------
// Production Switch — Stage 1 (routes/api.js): создание/восстановление заказа
// ---------------------------------------------------------------------------
//
// Wave 1-7 (SQL-side миграция) сознательно НЕ вызывали paymentService и НЕ
// эмитили события — весь модуль был "ни с чем не соединён", claim/finalize
// без сети. Stage 1 Production Switch (см. YAAM-production-switch-design-
// review.pdf) — первая задача, которой ДЕЙСТВИТЕЛЬНО нужен реальный сетевой
// вызов провайдера: server/routes/postgresql/api.js (новый, изолированный,
// НЕ подключённый к server.js — та же граница, что у этого файла) не может
// вернуть клиенту QR/paymentUrl для НОВОГО заказа, не создав платёж у
// провайдера. Поэтому здесь добавлены ensureInitialAttemptReady/
// ensureRetryAttemptReady/resolveCreationOrder/createOrderAndResolve/
// recoverOrder/retryPayment — дословные асинхронные аналоги одноимённых
// функций SQLite-orderService.js, которые ВЫЗЫВАЮТ (а не изменяют)
// paymentService.createPayment() между уже перенесёнными claim (Wave 4/5) и
// finalize (Wave 4) шагами — тот же принцип claim → network → finalize, что
// уже установлен ВСЕМИ волнами, просто впервые здесь СОБРАННЫЙ в одну
// вызываемую цепочку, а не оставленный "на будущее". Сам provider layer
// (paymentService.js, mockProvider.js, yookassaProvider.js) НЕ менялся ни на
// строку — только вызывается его существующий, непроверенный публичный
// контракт (createPayment), в точности как это делает SQLite-оригинал.
//
// orderEvents в Stage 1 ещё не эмитился (см. Stage 2 ниже — теперь эмитится).

// ---------------------------------------------------------------------------
// Production Switch — Stage 2 (orderEvents): PostgreSQL event layer
// ---------------------------------------------------------------------------
//
// Полный аудит SQLite-оригинала (server/services/orderService.js) перед этой
// задачей показал: событийная модель — ровно ОДИН module-level EventEmitter
// (`orderEvents`), ровно ДВА имени события ('order:status', 'order:new'),
// ровно 8 точек эмиссии (markPaid, markPaymentFailed, finalizeRetryAttempt,
// cancelByCustomer, restaurantAccept, restaurantDecline, restaurantAdvance,
// sweepTimeouts), ровно ОДИН внешний подписчик (bot/index.js, ТОЛЬКО на
// 'order:new', из markPaid — "сюда подписан бот, уйдёт уведомление
// ресторану"). 'order:status' эмитится 7 раз, но не имеет ни одного
// подписчика в текущей кодовой базе — это существующий, задокументированный
// факт SQLite-оригинала (вероятно задел на будущий SSE/websocket push), а
// НЕ то, что нужно "исправлять" здесь: задача Stage 2 — воспроизвести
// публикующее поведение SQLite один в один, а не добавлять новых
// подписчиков.
//
// Ни createOrder, ни rateOrder, ни finalizeRefundSucceeded/
// finalizeRefundFailed, ни pauseRestaurant/resumeRestaurant/
// sweepPauseExpiry НЕ эмитят ничего в оригинале — подтверждено построчным
// grep по orderService.js — соответствующие функции этого модуля тоже НЕ
// получают emit-вызовов.
//
// Момент эмиссии (до или после commit) — SQLite-оригинал синхронен:
// db.immediateTransaction(fn)() — это немедленно вызываемая функция, и к
// моменту, когда она возвращает управление, транзакция УЖЕ закоммичена (или
// брошено исключение и откачена). Все 8 точек эмиссии в оригинале лежат
// СТРОГО ПОСЛЕ этого возврата — постоянный, безысключений паттерн "emit
// после commit". Асинхронный аналог здесь: `db.transaction(fn)`
// (server/db/postgresql/index.js) резолвит свой Promise только после
// `await commitTransaction(client)` (COMMIT + release клиента) — см. код
// transaction() там же. Поэтому `await db.transaction(...)`, ЗАТЕМ emit —
// структурно та же гарантия, что и у SQLite: к моменту emit изменения уже
// физически зафиксированы в БД. Никакой новой гонки это не вводит: между
// commit и emit нет ничего, что могло бы наблюдать "недописанное" состояние
// (единственный слушатель на сегодня, bot, и сам ещё не подключён к этому
// модулю — Stage 3).
//
// Durability / Outbox Pattern: СОЗНАТЕЛЬНО НЕ внедрён. SQLite-оригинал сам
// не даёт никакой durability-гарантии — `orderEvents` там тоже голый
// in-process EventEmitter без персистентности: событие безвозвратно теряется,
// если процесс упадёт между commit и синхронным emit, или если в момент
// эмиссии не было подписчика (уже наблюдаемый факт для 'order:status' — 7 из
// 7 эмиссий сегодня улетают в никуда). Задача явно требует "воспроизвести
// поведение SQLite" и явно запрещает внедрять outbox "без доказанной
// необходимости" — здесь такой необходимости нет: мы не меняем контракт,
// только переносим его на новый драйвер. Outbox стал бы оправдан только в
// сценарии, которого сегодня нет ни в SQLite, ни здесь — множественные
// процессы/инстансы приложения, которым нужна ГАРАНТИРОВАННАЯ доставка
// каждого события (например, будущий переход на несколько реплик API за
// балансировщиком). Это явно вне рамок Stage 2 — задокументировано как
// открытый вопрос для будущего масштабирования, не для Stage 3 (bot),
// которому, как и текущему боту на SQLite, достаточно того же
// best-effort in-process контракта.
//
// Гвард-паттерн эмиссии повторяет SQLite функция-в-функцию там, где это
// БЕЗОПАСНО под реальной PostgreSQL-конкуренцией (не унифицирован в один
// общий механизм — это было бы отступлением от установленного в этой задаче
// принципа "не устранять асимметрии оригинала"):
//   1. Явный boolean, возвращаемый/устанавливаемый внутри транзакции —
//      markPaid (`changed`), markPaymentFailed (`changed`),
//      restaurantAccept (`changed`), И (см. п.4 ниже) restaurantDecline,
//      sweepTimeouts.
//   2. Closure-переменная, мутируемая внутри транзакции, проверяемая после —
//      finalizeRetryAttempt (`orderTransitioned`).
//   3. Throw-based неявный гвард — все no-op ветки бросают, а не возвращают
//      falsy, поэтому сам факт "транзакция не бросила" уже сигнал успеха —
//      cancelByCustomer, restaurantAdvance.
//   4. НАМЕРЕННОЕ ОТКЛОНЕНИЕ от буквального SQLite-паттерна: SQLite-оригинал
//      использует post-hoc проверку итогового status на уже полученном
//      объекте заказа для restaurantDecline/sweepTimeouts (no-op ветка
//      возвращает getOrder() без явного boolean). Под SQLite это безопасно
//      (однопоточный синхронный движок — "конкурентных" вызовов физически
//      не существует), НО под настоящей PostgreSQL MVCC-конкуренцией это
//      небезопасно: проигравшая гонку транзакция получает rowCount=0, но её
//      СОБСТВЕННЫЙ последующий getOrder() (та же транзакция, READ COMMITTED
//      — свежий снимок на каждый оператор) уже видит ЧУЖОЙ закоммиченный
//      целевой статус — post-hoc проверка проходит и у проигравшего тоже,
//      что эмитировало бы событие ДВАЖДЫ на один реальный переход, прямо
//      нарушая требование задания "никогда не публиковать событие дважды".
//      Обнаружено и живо доказано concurrency-тестами при написании Stage 2
//      (см. server/test/postgresql/eventLayerStage2.test.js) — НЕ
//      гипотетический край, а реально воспроизводимый race при двух
//      конкурентных restaurantDecline/sweepTimeouts на один заказ. Поэтому
//      restaurantDecline и sweepTimeouts здесь используют явный
//      rowCount-based boolean (тот же механизм, что и п.1) — единственный
//      способ узнать "я РЕАЛЬНО применил переход", не зависящий от того, что
//      видно постфактум. Наблюдаемый результат ДЛЯ ОТДЕЛЬНОГО вызова не
//      меняется (result.status по-прежнему корректен на обеих ветках) —
//      меняется только внутренний триггер эмиссии.
//
// Payload — тот же объект, что возвращает getOrder() этого модуля (полная
// внутренняя форма заказа с items[], НЕ toPublicOrderDTO) — идентичная форма
// SQLite-оригинала, это то, что реально использует bot/index.js
// ('order:new' handler читает order.restaurant_id/public_code/items/
// fulfillment_type/address/items_total/customer_phone/comment/id — все эти
// поля есть в форме getOrder() без изменений).
//
// Новый EventEmitter (НЕ импорт SQLite orderEvents — модуль не может
// require('../orderService'), та же граница изоляции, что уже применена ко
// всем прочим SQLite-зависимостям этого файла) — структурно независимый
// инстанс, совместимый по именам событий и форме payload, экспортируется
// для будущего Stage 3 (bot), который на этом этапе НЕ подключается.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const db = require('../../db/postgresql');
// Provider layer — НЕ содержит SQLite-зависимости (paymentService.js не
// делает require('../db')), поэтому её импорт сюда НЕ нарушает границу
// изоляции "не смешивать SQLite и PostgreSQL", установленную Wave 4/5 для
// orderAccessService.js. Нужна начиная со Stage 1 (Production Switch) —
// см. комментарий у ensureInitialAttemptReady/ensureRetryAttemptReady ниже:
// эти функции вызывают, но НЕ изменяют provider layer, тем же принципом,
// что SQLite-оригинал.
const payments = require('../paymentService');

// PostgreSQL-эквивалент SQLite orderEvents (см. "Production Switch — Stage 2"
// выше) — структурно независимый инстанс, те же имена событий/форма payload.
const orderEvents = new EventEmitter();

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

// Дословная копия PAUSE_PRESETS_MIN из orderService.js — три пресета
// перерыва в минутах, показываются ботом как кнопки "33 мин"/"3 часа"/
// "11 часов". Нужен только pauseRestaurant() (Stage 3, см. ниже).
const PAUSE_PRESETS_MIN = { short: 33, medium: 3 * 60, long: 11 * 60 };

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

// Stage 11A follow-up (payment deadline HIGH blocker): утверждённый срок
// оплаты YAAM — 15 минут, серверный и неизменяемый (см.
// payment_presentations.expires_at). Anchored на payments.created_at —
// момент начала ИМЕННО ЭТОЙ попытки (до сетевого вызова провайдера), не на
// момент финализации presentation (иначе длительность сетевого round-trip
// к провайдеру незаметно "съедала" бы часть срока).
const PAYMENT_DEADLINE_MINUTES = 15;

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

// ---------------------------------------------------------------------------
// Stage 1 (routes/api.js): дословные асинхронные копии parseBearerAuthorization/
// findAuthorizedOrderId из orderAccessService.js (SQLite) — та же граница
// изоляции, что и isValidRetryKey/hashSecret выше: orderAccessService.js
// нельзя импортировать (require('../db') на верхнем уровне), обе функции —
// чистые/read-only, дублируются тем же приёмом.
// ---------------------------------------------------------------------------

function parseBearerAuthorization(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(headerValue);
  return match && isValidOrderToken(match[1]) ? match[1] : null;
}

async function findAuthorizedOrderId(publicCode, rawToken, client = null) {
  if (!isValidOrderToken(rawToken)) return null;
  const rows = await db.query(
    `SELECT o.id
     FROM orders o
     JOIN order_access_credentials a ON a.order_id = o.id
     WHERE o.public_code = $1 AND a.token_hash = $2`,
    [publicCode, hashSecret(rawToken)],
    client
  );
  return rows[0] ? rows[0].id : null;
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
    'SELECT payment_url, qr_payload, expires_at FROM payment_presentations WHERE payment_id = $1',
    [paymentRow.id],
    client
  );
  const presentation = rows[0];
  if (!presentation) return null;
  return {
    providerPaymentId: paymentRow.provider_payment_id,
    paymentUrl: presentation.payment_url || null,
    qrPayload: presentation.qr_payload || null,
    paymentExpiresAt: presentation.expires_at
      ? new Date(presentation.expires_at).toISOString()
      : null,
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

// Stage 11A follow-up: тот же принцип корреляции, что и у
// LATEST_REFUND_STATUS_SUBQUERY выше — читает уже вставленный (не создаёт)
// expires_at последней по id (= самой свежей) попытки оплаты заказа. Именно
// "последней", не "первой" — явно утверждённая новая attempt (retry) имеет
// собственный, отдельный immutable deadline; polling всегда должен видеть
// дедлайн ТЕКУЩЕЙ активной попытки, не более раннего исчерпанного payment_failed.
const LATEST_PAYMENT_EXPIRES_AT_SUBQUERY = `(
  SELECT pp.expires_at FROM payment_presentations pp
  JOIN payments p ON p.id = pp.payment_id
  WHERE p.order_id = o.id
  ORDER BY p.id DESC LIMIT 1
) AS payment_expires_at`;

// Асинхронный аналог getOrder(idOrCode) из SQLite-версии — только числовой id
// (единственная форма, нужная трём функциям этой волны; getOrder() в
// оригинале также принимает public_code, но ни markPaymentFailed, ни
// restaurantAccept, ни restaurantAdvance им не пользуются — не переносим то,
// что не нужно вызывающим этой волны).
async function getOrder(orderId, client = null) {
  const rows = await db.query(
    `SELECT o.*, r.name AS restaurant_name, r.phone AS restaurant_phone,
       ${LATEST_REFUND_STATUS_SUBQUERY}, ${LATEST_PAYMENT_EXPIRES_AT_SUBQUERY}
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

  let changed = false;
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
    changed = true;
  });

  // Вне транзакции — дословно как в SQLite-оригинале (getOrder() тоже
  // вызывается после db.immediateTransaction(), не внутри неё; emit —
  // после await db.transaction(), т.е. строго после commit, см. "Production
  // Switch — Stage 2" в начале файла).
  const updated = await getOrder(orderId);
  if (changed) orderEvents.emit('order:status', updated);
  return updated;
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

  let changed = false;
  let lateRefundRow = null;
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
      lateRefundRow = await reserveRefundRow(payment, 'customer_cancel', client);
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
    changed = true;
  });

  // Вне транзакции — дословно как в SQLite-оригинале. `changed` — ТОЛЬКО на
  // штатном awaiting_payment -> awaiting_restaurant пути (поздняя оплата уже
  // отменённого заказа НЕ меняет order.status и НЕ эмитит событие — заказ
  // остаётся cancelled).
  const updated = await getOrder(orderId);
  if (changed) {
    orderEvents.emit('order:status', updated);
    orderEvents.emit('order:new', updated); // сюда подпишется бот в Stage 3
  }
  // Production Switch — Stage 8: "поздняя оплата уже отменённого заказа" —
  // деньги провайдер объективно получил, но заказ не воскрешается, поэтому
  // их нужно реально вернуть, не только зарезервировать обязательство (тот
  // же fire-and-forget post-commit принцип, что и в остальных трёх местах).
  if (lateRefundRow) scheduleRefundProcessing(lateRefundRow.id);
  return updated;
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
  let changed = false;
  await db.transaction(async (client) => {
    const applied = await db.execute(
      `UPDATE orders SET status = 'accepted', status_updated_at = NOW()
       WHERE id = $1 AND status = 'awaiting_restaurant'`,
      [orderId],
      client
    );
    changed = applied.rowCount === 1;
  });
  const updated = await getOrder(orderId);
  if (changed) orderEvents.emit('order:status', updated);
  return updated;
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
  // ВНИМАНИЕ — намеренное отличие от буквального SQLite-гварда (см.
  // "Production Switch — Stage 2", п.4 в начале файла): SQLite-оригинал
  // использует post-hoc сравнение итогового order.status с 'declined' —
  // это безопасно ТОЛЬКО потому, что SQLite синхронен и однопоточен: две
  // "последовательные" (не говоря уже о "конкурентных") JS-вызова
  // restaurantDecline() никогда не перекрываются, поэтому проигравший вызов
  // видит current.status !== 'awaiting_restaurant' ЕЩЁ ДО попытки UPDATE и
  // корректно не эмитит... кроме одного случая: ПОВТОРНЫЙ вызов на уже
  // declined-заказе (current.status УЖЕ 'declined' на входе) тоже проходит
  // post-hoc проверку и эмитит СНОВА — сам SQLite-оригинал содержит эту
  // особенность (не задокументирована как намеренная, не покрыта его
  // собственными тестами на счётчик событий).
  //
  // Под PostgreSQL с РЕАЛЬНОЙ конкуренцией (не последовательные вызовы, а
  // два транзакции, пересекающиеся во времени) буквальный перенос этого
  // гварда был бы СТРОГО хуже: проигравшая транзакция блокируется на
  // UPDATE, дожидается COMMIT победителя, затем её собственный rowCount=0,
  // но её ПОСЛЕДУЮЩИЙ getOrder() (та же транзакция, READ COMMITTED — свежий
  // снимок на каждый оператор) УЖЕ видит чужой закоммиченный status='declined'
  // — post-hoc проверка проходит и у проигравшего тоже, эмитируя ДВАЖДЫ на
  // один реальный переход. Это прямо нарушает требование задания "никогда не
  // публиковать событие дважды", и это НЕ гипотетический край: два конкурентных
  // администратора/повторный webhook restaurantDecline на один заказ — штатный
  // сценарий, не экзотика.
  //
  // Поэтому здесь используется explicit rowCount-based boolean (тот же
  // принцип, что markPaid/markPaymentFailed/restaurantAccept) — единственный
  // способ узнать "я РЕАЛЬНО применил переход", независимый от того, что
  // видно постфактум. Наблюдаемый результат для КАЖДОГО ОТДЕЛЬНОГО вызова не
  // меняется (result.status по-прежнему 'declined' и в проигранной, и в
  // выигранной ветке) — меняется только внутренний триггер эмиссии.
  let changed = false;
  let refundRow = null;
  const order = await db.transaction(async (client) => {
    const updated = await db.execute(
      `UPDATE orders SET status = 'declined', status_updated_at = NOW()
       WHERE id = $1 AND status = 'awaiting_restaurant'`,
      [orderId],
      client
    );
    changed = updated.rowCount === 1;
    if (changed) {
      const paymentRows = await db.query(
        `SELECT * FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
        [orderId],
        client
      );
      refundRow = await reserveRefundRow(paymentRows[0] || null, 'restaurant_decline', client);
    }
    return getOrder(orderId, client);
  });
  if (changed) {
    orderEvents.emit('order:status', order);
  }
  // Production Switch — Stage 8: см. cancelByCustomer выше — тот же принцип
  // (fire-and-forget строго после commit, только если этот вызов реально
  // выиграл переход и зарезервировал возврат).
  if (changed && refundRow) scheduleRefundProcessing(refundRow.id);
  return order;
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
  const order = await db.transaction(async (client) => {
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
  // Throw-based гвард (как cancelByCustomer ниже) — каждая no-op/ошибочная
  // ветка выше бросает, а не тихо возвращает; сам факт, что мы дошли сюда без
  // исключения, уже сигнал успешного перехода — отдельный boolean не нужен.
  orderEvents.emit('order:status', order);
  return order;
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
//   5. race-проигрыш финального UPDATE -> см. HIGH-фикс ниже (Production
//      Switch Stage 9 closure).
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
//
// HIGH-фикс (независимый Codex-аудит, "concurrent cancel HTTP 500",
// воспроизведён детерминированным barrier-тестом на реальных row-lock'ах
// ДО этого фикса — см. commit message/PDF-отчёт за точным механизмом):
// раньше rowCount!==1 БЕЗУСЛОВНО трактовался как нарушенный инвариант
// (throw refundInvariant -> публичный 500), даже когда единственная причина
// проигрыша — конкурентный ПОБЕДИТЕЛЬ уже успешно перевёл тот же заказ в
// 'cancelled' долями секунды раньше (double-click/сетевой retry/два вкладки
// — реалистичный сценарий, не экзотика). Теперь при rowCount!==1 состояние
// перечитывается ЕЩЁ РАЗ, в ТОЙ ЖЕ транзакции (READ COMMITTED — свежий
// снимок на каждый оператор, тот же принцип, что и в markPaid/
// restaurantDecline) и различается три исхода:
//   - fresh.status === 'cancelled' -> конкурентный победитель уже завершил
//     ИМЕННО этот переход — безопасный идемпотентный успех для проигравшего
//     запроса (тот же HTTP 200, что получил победитель), НЕ ошибка. changed
//     остаётся false — событие 'order:status' уже эмитировал победитель,
//     повторно эмитить нельзя (тот же принцип, что Stage 2 закрепила для
//     restaurantDecline/sweepTimeouts).
//   - fresh.status — что-то ДРУГОЕ (не cancelled) -> настоящий бизнес-
//     конфликт (например, ресторан принял заказ ровно в этот момент) — та
//     же явная ошибка "уже готовится", что и раньше для этой ветки. Гонка
//     НЕ маскируется как успех.
//   - fresh не существует -> реальный нарушенный инвариант (см. ниже),
//     как и раньше.
async function cancelByCustomer(orderId) {
  let refundRow = null;
  let changed = false;
  const order = await db.transaction(async (client) => {
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
      refundRow = await reserveRefundRow(paymentRows[0] || null, 'customer_cancel', client);
    }

    const updated = await db.execute(
      `UPDATE orders SET status = 'cancelled', status_updated_at = NOW() WHERE id = $1 AND status = $2`,
      [orderId, current.status],
      client
    );
    if (updated.rowCount === 1) {
      changed = true;
      return getOrder(orderId, client);
    }

    const fresh = await getOrder(orderId, client);
    if (!fresh) throw refundInvariant('заказ исчез во время отмены — нарушен инвариант');
    if (fresh.status === 'cancelled') {
      return fresh; // конкурентный победитель уже отменил — идемпотентный успех
    }
    throw new Error('заказ уже готовится — отменить нельзя, свяжитесь с рестораном');
  });
  if (changed) {
    orderEvents.emit('order:status', order);
  }
  // Production Switch — Stage 8: сетевой возврат запускается СТРОГО после
  // commit (fire-and-forget, не await'ится) — см. scheduleRefundProcessing.
  // reserveRefundRow сама идемпотентна (partial UNIQUE index), поэтому
  // повторный/конкурентный вызов cancelByCustomer безопасен — либо не
  // доходит до резервации (current.status уже не в допустимом списке), либо
  // (Stage 9 HIGH-фикс, awaiting_restaurant race) оба конкурента резервируют
  // ОДНУ И ТУ ЖЕ строку (reserveRefundRow идемпотентна сама по себе), и оба
  // safely вызывают scheduleRefundProcessing на один и тот же refund id —
  // ensureRefundReady() (Stage 8) сама идемпотентна (in-flight Map + SQL
  // WHERE-guard), повторный вызов не создаёт дублирующий сетевой возврат.
  if (refundRow) scheduleRefundProcessing(refundRow.id);
  return order;
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
    // Тот же race-safe rowCount-boolean гвард, что и restaurantDecline выше
    // (см. подробное обоснование там) — post-hoc сравнение итогового status
    // здесь ТОЖЕ было бы небезопасно: два конкурентных sweepTimeouts() на
    // ОДИН и тот же просроченный заказ (штатный сценарий — интервальный
    // свип может пересечься сам с собой при долгой предыдущей итерации, либо
    // ручной вызов sweepTimeouts из ops-инструмента пересечётся с фоновым
    // таймером) дают проигравшему rowCount=0, но его собственный
    // ПОСЛЕДУЮЩИЙ getOrder() в той же транзакции уже увидел бы чужой
    // закоммиченный 'timed_out' — post-hoc проверка эмитила бы у обоих.
    let order;
    let changed = false;
    let refundRow = null;
    try {
      order = await db.transaction(async (client) => {
        const updated = await db.execute(
          `UPDATE orders SET status = 'timed_out', status_updated_at = NOW()
           WHERE id = $1 AND status = 'awaiting_restaurant'`,
          [id],
          client
        );
        changed = updated.rowCount === 1;
        if (!changed) return getOrder(id, client); // тихий skip — уже обработан другим событием

        const paymentRows = await db.query(
          `SELECT * FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
          [id],
          client
        );
        refundRow = await reserveRefundRow(paymentRows[0] || null, 'timeout', client);
        return getOrder(id, client);
      });
    } catch (err) {
      // Тот же принцип, что в оригинале: ошибка на одном заказе не должна
      // останавливать обработку остальных заказов этого же свипа.
      console.error(`[services/postgresql/orderService] sweepTimeouts failed for order ${id}:`, err.message);
      continue;
    }
    if (changed) {
      orderEvents.emit('order:status', order);
    }
    // Production Switch — Stage 8: см. cancelByCustomer выше — тот же
    // fire-and-forget post-commit принцип, per-order внутри этого свипа.
    if (changed && refundRow) scheduleRefundProcessing(refundRow.id);
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
      `INSERT INTO payment_presentations (payment_id, payment_url, qr_payload, expires_at)
       VALUES ($1, $2, $3, (
         SELECT created_at + ($4 || ' minutes')::interval FROM payments WHERE id = $1
       ))
       ON CONFLICT (payment_id) DO UPDATE SET
         payment_url = excluded.payment_url,
         qr_payload = excluded.qr_payload`,
      [paymentRowId, payment.paymentUrl || null, payment.qrPayload || null, PAYMENT_DEADLINE_MINUTES],
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
  // Closure-переменные, мутируемые внутри транзакции, проверяемые после её
  // резолва — тот же гвард-паттерн, что SQLite orderTransitioned (см.
  // "Production Switch — Stage 2" в начале файла, п.2). attempt.order_id —
  // FK, неизменяем после вставки строки payment, поэтому захват его здесь
  // эквивалентен повторному SELECT payments.order_id, который делает
  // SQLite-оригинал ПОСЛЕ commit — то же наблюдаемое значение, без лишнего
  // запроса.
  let orderTransitioned = false;
  let transitionedOrderId = null;
  const result = await db.transaction(async (client) => {
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
      `INSERT INTO payment_presentations (payment_id, payment_url, qr_payload, expires_at)
       VALUES ($1, $2, $3, (
         SELECT created_at + ($4 || ' minutes')::interval FROM payments WHERE id = $1
       ))
       ON CONFLICT (payment_id) DO UPDATE SET
         payment_url = excluded.payment_url,
         qr_payload = excluded.qr_payload`,
      [paymentRowId, payment.paymentUrl || null, payment.qrPayload || null, PAYMENT_DEADLINE_MINUTES],
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
    orderTransitioned = true;
    transitionedOrderId = attempt.order_id;

    const finalPaymentRows = await db.query('SELECT * FROM payments WHERE id = $1', [paymentRowId], client);
    return paymentResultFromRow(finalPaymentRows[0], client);
  });
  if (orderTransitioned) {
    orderEvents.emit('order:status', await getOrder(transitionedOrderId));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stage 1 (routes/api.js) — DTO, ошибки, orchestration (claim -> network ->
// finalize, собранные в одну цепочку впервые в этой задаче)
// ---------------------------------------------------------------------------

// Дословные копии соответствующих классов из orderService.js (SQLite) —
// тот же паттерн, что и все предыдущие волны (фиксированный публичный
// message/statusCode).
class PaymentInitialUnavailableError extends Error {
  constructor() {
    super('Платёжный сервис временно недоступен — повторите оформление заказа');
    this.name = 'PaymentInitialUnavailableError';
    this.statusCode = 503;
  }
}

class OrderCreationRecoveryNotFoundError extends Error {
  constructor() {
    super('заказ не найден');
    this.name = 'OrderCreationRecoveryNotFoundError';
    this.statusCode = 404;
  }
}

class PaymentRetryUnavailableError extends Error {
  constructor() {
    super('Платёжный сервис временно недоступен — повторите попытку');
    this.name = 'PaymentRetryUnavailableError';
    this.statusCode = 503;
  }
}

// Дословные копии toPublicRefundStatus/toPublicOrderDTO/toPublicPaymentDTO —
// чистые функции формы результата, ноль SQL, идентичны для обеих версий БД
// (поля берутся из уже загруженного объекта, не из новых запросов).
function toPublicRefundStatus(latestRefundStatus) {
  if (!latestRefundStatus) return 'none';
  if (latestRefundStatus === 'succeeded') return 'done';
  if (latestRefundStatus === 'failed') return 'failed';
  return 'processing'; // requested | processing
}

function toPublicOrderDTO(order) {
  if (!order) return null;
  const {
    public_code, status, status_updated_at, items_total,
    estimated_ready_minutes, restaurant_phone, fulfillment_type, rating,
    latest_refund_status, payment_expires_at,
  } = order;
  return {
    public_code, status, status_updated_at, items_total,
    estimated_ready_minutes, restaurant_phone, fulfillment_type, rating,
    refund_status: toPublicRefundStatus(latest_refund_status),
    // Stage 11A follow-up: неизменяемый серверный срок текущей попытки
    // оплаты (payment_presentations.expires_at, см. LATEST_PAYMENT_
    // EXPIRES_AT_SUBQUERY) — тот же ISO-timestamp на каждом poll/refresh,
    // frontend вычисляет обратный отсчёт от него, не создаёт свой заново.
    payment_expires_at: payment_expires_at
      ? new Date(payment_expires_at).toISOString()
      : null,
  };
}

function toPublicPaymentDTO(payment) {
  if (!payment) return null;
  return {
    paymentUrl: payment.paymentUrl || null,
    qrPayload: payment.qrPayload || null,
    // Stage 11A follow-up: тот же неизменяемый ISO-timestamp, что и order
    // DTO's payment_expires_at — присутствует уже в самом первом create/
    // recover-ответе, до первого poll.
    paymentExpiresAt: payment.paymentExpiresAt || null,
  };
}

// orderCreationContext() в SQLite-оригинале возвращает {restaurantId,
// createdAt, items} отдельным SQL-запросом и наполняет ТОЛЬКО
// creationResult().context — поле, которое НИ ОДИН обработчик
// routes/api.js фактически не читает из ответа (публичный контракт —
// {order, payment}; context передавался в теле ответа, но клиент его не
// использует, см. отсутствие ".context"/"context:" во всём client/js/*.js).
// Реализовывать здесь вхолостую повторяющий оригинал SQL-запрос без единого
// потребителя было бы добавлением того, что объективно не нужно (задание
// прямо просит переносить только действительно необходимое для работы
// routes/api.js) — context всегда null, задокументировано явно, не тихая
// потеря поведения.
function creationResult(order, payment) {
  return { order, payment, context: null };
}

// Дословная асинхронная копия activePaymentRowByOrder() — читает самый
// свежий payment заказа в статусе creating/pending вместе с ledger обеих
// разновидностей попытки (initial/retry), чтобы resolveCreationOrder() ниже
// мог определить, какую именно ветку ensureXAttemptReady вызывать.
async function activePaymentRowByOrder(orderId, client = null) {
  const rows = await db.query(
    `SELECT p.*,
       i.provider_idempotency_key AS initial_provider_idempotency_key,
       i.state AS initial_state,
       r.provider_idempotency_key AS retry_provider_idempotency_key,
       r.state AS retry_state
     FROM payments p
     LEFT JOIN payment_initial_attempts i ON i.payment_id = p.id
     LEFT JOIN payment_retry_attempts r ON r.payment_id = p.id
     WHERE p.order_id = $1 AND p.status IN ('creating', 'pending')
     ORDER BY p.id DESC LIMIT 1`,
    [orderId],
    client
  );
  return rows[0] || null;
}

// In-flight Map — дословная копия принципа refundAttemptInFlight (Wave 7):
// fast-path оптимизация в рамках процесса, НЕ основная защита. Основная
// защита от двойного платежа — уже перенесённые (Wave 4) conditional UPDATE
// в finalizeInitialAttempt/finalizeRetryAttempt (WHERE status='creating').
const initialAttemptInFlight = new Map();
const retryAttemptInFlight = new Map();

function providerCreateTimeoutMs() {
  const configured = Number(process.env.PAYMENT_CREATE_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

// Дословная копия createPaymentWithTimeout() — Promise.race вокруг
// paymentService.createPayment(), тот же таймаут-механизм, что и
// refundPaymentWithTimeout в SQLite-оригинале (не переносился — refund
// оркестрация вне scope).
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

// Дословный асинхронный аналог ensureInitialAttemptReady() — claim (Wave 5,
// createOrder) уже закоммичен ДО вызова этой функции; сеть вызывается здесь,
// ВНЕ какой-либо открытой транзакции; finalize (Wave 4, finalizeInitialAttempt)
// уже перенесён и не меняется. Сохранены все ветки контракта: order не
// awaiting_payment -> null (exact replay терминального заказа не трогает
// провайдера повторно); legacy без ledger -> попытка вернуть уже сохранённый
// provider id без сети; state==='ready' -> idempotent-возврат уже готового
// результата; иначе — claim -> network -> finalize с in-flight дедупликацией.
async function ensureInitialAttemptReady(attempt) {
  if (!attempt) throw initialPaymentInvariant('первоначальная платёжная попытка не найдена');

  const currentOrder = await getOrder(attempt.order_id);
  if (!currentOrder) throw initialPaymentInvariant('заказ первоначальной попытки не найден');
  if (currentOrder.status !== 'awaiting_payment') return null;

  if (!attempt.initial_state) {
    const legacy = await paymentResultFromRow(attempt);
    if (legacy) return legacy;
    throw initialPaymentInvariant('legacy-платёж без provider id требует ручной сверки');
  }
  if (attempt.initial_state === 'ready') {
    const existing = await paymentResultFromRow(attempt);
    if (!existing) throw initialPaymentInvariant('готовый первоначальный платёж не содержит данных продолжения');
    return existing;
  }
  if (attempt.initial_state !== 'creating' || attempt.status !== 'creating' || !attempt.provider_idempotency_key) {
    throw initialPaymentInvariant('первоначальная платёжная попытка повреждена');
  }
  if (initialAttemptInFlight.has(attempt.id)) return initialAttemptInFlight.get(attempt.id);

  const operation = (async () => {
    const order = await getOrder(attempt.order_id);
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
      console.error(`[services/postgresql/orderService] initial provider unavailable payment=${attempt.id} type=${err?.name || 'Error'}`);
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

// Дословный асинхронный аналог resolveCreationOrder() — единая точка входа
// и для createOrderAndResolve() (POST /orders), и для recoverOrder()
// (POST /orders/recover): важен ТЕКУЩИЙ active-платёж заказа, а не
// исторически первая попытка (после payment_failed + retry старый QR
// возвращать нельзя). Не-awaiting заказ вообще не трогает provider.
async function resolveCreationOrder(orderId) {
  let order = await getOrder(orderId);
  if (!order) throw new OrderCreationRecoveryNotFoundError();
  if (order.status !== 'awaiting_payment') return creationResult(order, null);

  const active = await activePaymentRowByOrder(orderId);
  if (!active) {
    // Webhook/cancel могли поменять статус между двумя SELECT.
    order = await getOrder(orderId);
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
    payment = await paymentResultFromRow(active);
    if (!payment) throw initialPaymentInvariant('legacy active-платёж не содержит presentation');
  } else {
    throw initialPaymentInvariant('creating active-платёж не имеет durable ledger');
  }

  order = await getOrder(orderId);
  if (!order) throw new OrderCreationRecoveryNotFoundError();
  return creationResult(order, order.status === 'awaiting_payment' ? payment : null);
}

// НОВАЯ (не из SQLite-оригинала как отдельная функция) тонкая обёртка:
// createOrder() (Wave 5) сознательно остаётся claim-only и возвращает
// {orderId, replay} — контракт, уже протестированный 30 живыми тестами
// Wave 5, здесь НЕ меняется. routes/postgresql/api.js нужен полный
// {order, payment, context}, поэтому композиция вынесена в отдельную
// функцию, а не встроена в createOrder() — тот же принцип, что и в
// SQLite-оригинале, где createOrder() сама заканчивается вызовом
// resolveCreationOrder(orderId), просто здесь это явная отдельная функция,
// а не хвост существующей.
async function createOrderAndResolve(params) {
  const { orderId } = await createOrder(params);
  return resolveCreationOrder(orderId);
}

// Дословный асинхронный аналог recoverOrder() — body-less восстановление по
// паре секретов (тот же AND-точный replay, что и exact-replay ветка
// createOrder()).
async function recoverOrder({ orderAccessToken, createIdempotencyKey }) {
  if (!isValidOrderToken(orderAccessToken)) {
    throw new OrderAccessInputError('Некорректный токен доступа к заказу', 401);
  }
  if (!isValidCreateKey(createIdempotencyKey)) {
    throw new OrderAccessInputError('Некорректный ключ создания заказа');
  }
  const tokenHash = hashSecret(orderAccessToken);
  const createKeyHash = hashSecret(createIdempotencyKey);

  const attempt = await initialAttemptRowByCredentials(tokenHash, createKeyHash);
  if (!attempt) throw new OrderCreationRecoveryNotFoundError();
  return resolveCreationOrder(attempt.initial_order_id);
}

// Дословный асинхронный аналог ensureRetryAttemptReady() — тот же принцип,
// что ensureInitialAttemptReady() выше, для payment_failed -> retry ветки.
// claim (Wave 4, reserveRetryAttempt) и finalize (Wave 4, finalizeRetryAttempt)
// уже перенесены и не меняются; здесь — только сетевой вызов между ними.
async function ensureRetryAttemptReady(attempt) {
  if (!attempt) throw new Error('платёжная попытка не найдена');
  if (attempt.status === 'pending') {
    const existing = await paymentResultFromRow(attempt);
    if (!existing) throw paymentInvariant('активный платёж не содержит данных продолжения');
    return existing;
  }
  if (attempt.status !== 'creating' || !attempt.provider_idempotency_key) {
    throw new PaymentRetryConflictError();
  }
  if (retryAttemptInFlight.has(attempt.id)) return retryAttemptInFlight.get(attempt.id);

  const operation = (async () => {
    const order = await getOrder(attempt.order_id);
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
      console.error(`[services/postgresql/orderService] retry provider unavailable payment=${attempt.id} type=${err?.name || 'Error'}`);
      throw new PaymentRetryUnavailableError();
    }
    if (!payment || !payment.providerPaymentId) {
      throw paymentInvariant('провайдер не вернул id платежа');
    }
    return finalizeRetryAttempt(attempt.id, payment);
  })();
  retryAttemptInFlight.set(attempt.id, operation);
  try {
    return await operation;
  } finally {
    if (retryAttemptInFlight.get(attempt.id) === operation) retryAttemptInFlight.delete(attempt.id);
  }
}

// Дословный асинхронный аналог retryPayment() — claim + ensure тем же
// принципом, что и SQLite-оригинал.
async function retryPayment(orderId, retryKey) {
  const attempt = await reserveRetryAttempt(orderId, retryKey);
  return ensureRetryAttemptReady(attempt);
}

// Точечные read-only функции для routes/postgresql/api.js — платёжный
// webhook и dev-confirm-payment читают payments по разным критериям.
// Дословные асинхронные аналоги соответствующих inline db.prepare() в
// routes/api.js (SQLite) — сами запросы идентичны по смыслу оригиналу.
async function getPaymentByProviderPaymentId(providerPaymentId, client = null) {
  const rows = await db.query(
    'SELECT * FROM payments WHERE provider_payment_id = $1',
    [providerPaymentId],
    client
  );
  return rows[0] || null;
}

async function getRefundByProviderRefundId(providerRefundId, client = null) {
  const rows = await db.query(
    `SELECT r.*, p.provider_payment_id
     FROM refunds r
     JOIN payments p ON p.id = r.payment_id
     WHERE r.provider_refund_id = $1`,
    [providerRefundId],
    client
  );
  return rows[0] || null;
}

async function getPendingPaymentForOrder(orderId, client = null) {
  const rows = await db.query(
    `SELECT * FROM payments WHERE order_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`,
    [orderId],
    client
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// rateOrder(orderId, rating) — Wave 6
// ---------------------------------------------------------------------------
//
// Дословная копия RATING_ELIGIBLE_STATUS из orderService.js (SQLite) — нужна
// только rateOrder.
const RATING_ELIGIBLE_STATUS = 'delivered';

// rateOrder — единственная функция всей concurrency-матрицы, требующая
// SELECT ... FOR UPDATE (см. postgresql-concurrency-migration-matrix.md,
// строка #14, и Finding #2 там же). Причина: restaurants.rating/rating_count
// — классический read-modify-write агрегат БЕЗ conditional-UPDATE-
// эквивалента (новое значение вычисляется из старого в JS, затем
// записывается безусловно) — под READ COMMITTED это lost update (два
// конкурентных клиента читают один и тот же rating_count, оба вычисляют
// "+1" от одного и того же числа, второй UPDATE молча затирает первый).
// SQLite безопасен здесь только благодаря однопоточности (см. оригинальный
// комментарий у rateOrder — "быстрый, но не единственный барьер").
//
// Порядок блокировок (сохранён дословно из SQLite-версии, где он же
// исключает deadlock конструктивно, не только "случайно"):
//   1. conditional UPDATE orders (WHERE rating IS NULL) — ПЕРВЫМ.
//   2. SELECT ... FOR UPDATE restaurants — ВТОРЫМ, только если (1) победил.
// Каждый вызов rateOrder всегда блокирует РОВНО одну orders-строку (свою
// собственную — разные заказы никогда не делят одну строку orders) и РОВНО
// одну restaurants-строку, и всегда в этом порядке. Двух транзакций,
// которые блокировали бы одни и те же ДВЕ строки в обратном порядке, здесь
// быть не может (каждый вызов трогает свой уникальный orders.id, общий
// ресурс только restaurants.id, и он всегда берётся вторым) — deadlock
// исключён конструктивно, не требует ни retry на 40P01, ни
// детерминированного упорядочивания вручную (в отличие от классического
// double-row-lock сценария из concurrency.test.js #8a/8b).
//
// FOR UPDATE блокирует (заставляет конкурента физически ждать), а не
// конфликтует (не бросает ошибку и не требует retry) — поэтому здесь
// НЕТ retry-опций у transaction(), в отличие от createOrder (Wave 5).
// Живое доказательство самого механизма (два конкурента, FOR UPDATE,
// rollback/commit-видимость) уже покрыто concurrency.test.js #5/6/7,
// написанными именно на restaurants.rating/rating_count заранее, при
// проектировании Concurrency Strategy — Wave 6 добавляет тесты САМОЙ
// функции rateOrder(), не переоткрывает общий механизм.
//
// Асимметрия, сохранённая дословно из оригинала (НЕ исправляется в этой
// волне): rateOrder бросает только голые `Error(...)` без `.statusCode` —
// единственная функция orderService.js с такой формой ошибок (все прочие
// используют кастомные классы с `.statusCode`). Сохранено бит-в-бит,
// включая тексты сообщений.
async function rateOrder(orderId, rating) {
  const order = await getOrder(orderId);
  if (!order) throw new Error('заказ не найден');
  if (order.status !== RATING_ELIGIBLE_STATUS) throw new Error('оценить можно только доставленный заказ');

  // Явная перепроверка оплаты по таблице payments — defense-in-depth поверх
  // state machine, дословно из оригинала (см. комментарий там же).
  const paidRows = await db.query(
    "SELECT id FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1",
    [orderId]
  );
  if (!paidRows[0]) throw new Error('заказ не оплачен');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('оценка должна быть 1..5');

  // Быстрый, но не единственный барьер (см. оригинальный комментарий) —
  // настоящая защита ниже, conditional UPDATE внутри транзакции.
  if (order.rating != null) throw new Error('вы уже оценили этот заказ');

  const rated = await db.transaction(async (client) => {
    const updated = await db.execute(
      'UPDATE orders SET rating = $1 WHERE id = $2 AND rating IS NULL',
      [rating, orderId],
      client
    );
    if (updated.rowCount === 0) return false; // проиграли гонку — кто-то уже оценил этот заказ

    const restaurantRows = await db.query(
      'SELECT rating, rating_count FROM restaurants WHERE id = $1 FOR UPDATE',
      [order.restaurant_id],
      client
    );
    const r = restaurantRows[0];
    const newCount = r.rating_count + 1;
    const newRating = (Number(r.rating) * r.rating_count + rating) / newCount;
    await db.execute(
      'UPDATE restaurants SET rating = $1, rating_count = $2 WHERE id = $3',
      [Math.round(newRating * 10) / 10, newCount, order.restaurant_id],
      client
    );
    return true;
  });
  if (!rated) throw new Error('вы уже оценили этот заказ');
  return getOrder(orderId);
}

// ---------------------------------------------------------------------------
// claimRefundForProcessing(refundId) — Wave 7 (финальная волна SQL-side
// переноса orderService.js)
// ---------------------------------------------------------------------------
//
// Переносит ТОЛЬКО claim-шаг ensureRefundReady() из SQLite-версии — атомарный
// переход requested/processing -> processing непосредственно ПЕРЕД сетевым
// вызовом провайдера. Сам сетевой вызов (paymentService.refundPayment()) и
// решение succeeded/failed по его результату НЕ переносятся — это работа
// оркестратора ensureRefundReady(), который остаётся исключительно в SQLite-
// версии (см. server/docs/postgresql-migration-status.md, раздел "что
// осталось вне PostgreSQL-миграции", и YAAM-ensure-refund-ready-
// architecture-review.pdf, раздел 12: "provider integration" уже сделана
// независимо от этой миграции и явно запрещена к правке в этой волне).
// finalizeRefundSucceeded/finalizeRefundFailed уже перенесены (Wave 3) и не
// меняются — эта функция закрывает недостающую claim-половину того же
// жизненного цикла.
//
// ВЫБРАННЫЙ ВАРИАНТ (согласовано отдельно, см. YAAM-ensure-refund-ready-
// architecture-review.pdf, раздел 11): Вариант D — "lease-guarded conditional
// UPDATE". next_attempt_at трактуется как lease-поле и проверяется АТОМАРНО
// внутри WHERE самого claim-UPDATE, а не только в отдельном предварительном
// SELECT (как делает sweepStuckRefunds() в SQLite-версии сегодня).
//
// Почему НЕ буквальный "WHERE status IN ('requested','processing')": строго
// опровергнуто в architecture review — 'processing' самопетлевое (retryable)
// состояние по дизайну (см. refund-architecture-review.md), поэтому WHERE,
// разрешающее его как исходное БЕЗ временного условия, разрешает СКОЛЬКО
// УГОДНО последовательных re-claim'ов той же строки, каждый из которых
// запускает СВОЙ сетевой вызов — доказано двумя полностью корректными,
// строго сериализованными PostgreSQL-транзакциями (T1 claims 'requested'
// -> 'processing'; T2, придя следом, снова матчит 'processing' as-is и тоже
// "выигрывает" claim). Это не гонка на уровне отдельной SQL-инструкции
// (каждый UPDATE атомарен) — это недостаточно ограничительное WHERE-условие.
//
// Почему это безопасно и достаточно (без FOR UPDATE/SERIALIZABLE/retry):
// next_attempt_at IS NULL (никогда не claimался) ИЛИ next_attempt_at <= NOW()
// (предыдущая lease истекла) — оба случая законно позволяют повторный claim;
// живая (ещё не истёкшая) lease — НЕТ. PostgreSQL стандартно сериализует
// конкурентные UPDATE одной строки через row-level lock + EvalPlanQual
// (переоценка WHERE после снятия блокировки под READ COMMITTED) — второй
// конкурент, чья lease-проверка после переоценки не проходит, детерминированно
// получает rowCount=0, независимо от порядка исполнения. Retry не нужен: это
// не serialization failure (40001/40P01), а штатный, ожидаемый "не выиграл
// claim" исход conditional UPDATE — тот же принцип, что у ВСЕХ остальных
// claim-функций матрицы (Wave 1-6).
//
// rowCount=0 доменно классифицируется (НЕ пробрасывается как сырая ошибка):
// перечитываем строку и различаем terminal (succeeded/failed — идемпотентный
// no-op) / leased (processing с ещё живой lease — chужой claim ещё идёт) /
// not_found (строка исчезла — структурно недостижимо через FK ON DELETE
// CASCADE в штатном потоке, но обрабатывается явно, fail-safe) — тот же
// fail-loud принцип, что refundInvariant() у finalizeRefundSucceeded/Failed.
//
// refundAttemptInFlight — дословная копия одноимённой Map из SQLite-версии,
// но переиспользуется здесь ТОЛЬКО как fast-path оптимизация в рамках
// процесса (избегает лишнего DB round-trip, если тот же refundId уже
// claim'ится в этом процессе прямо сейчас) — НЕ основная защита. Основная
// защита — SQL WHERE-guard выше, единственный механизм, работающий и
// межпроцессно/межинстансно, и при чисто внутрипроцессном async-интерливинге
// (см. architecture review, раздел 5, находка R5: сам факт перехода на
// асинхронный pg-driver делает гонку возможной ДАЖЕ в одном процессе).
//
// Не переносится и не меняется: sweepStuckRefunds() (SQL для поиска
// кандидатов на повтор) — вне scope этой волны; тестирование claim-функции
// не требует полного sweep-обвязки, только прямых вызовов claim.
const REFUND_BACKOFF_BASE_SEC = 10;
const REFUND_BACKOFF_CAP_SEC = 300;
const refundAttemptInFlight = new Map();
// Бounded batch size для sweepStuckRefunds() (см. ниже) — задание Stage 8
// прямо требует "no uncontrolled full-table scan; process bounded batches".
const REFUND_SWEEP_BATCH_LIMIT = 50;

async function claimRefundForProcessing(refundId) {
  if (refundAttemptInFlight.has(refundId)) return refundAttemptInFlight.get(refundId);

  const operation = db.transaction(async (client) => {
    const currentRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
    const current = currentRows[0];
    if (!current) return { claimed: false, reason: 'not_found', refund: null };
    if (current.status === 'succeeded' || current.status === 'failed') {
      return { claimed: false, reason: 'terminal', refund: current };
    }
    if (current.status !== 'requested' && current.status !== 'processing') {
      throw refundInvariant('строка возврата в неизвестном состоянии');
    }

    const nextAttemptCount = current.attempt_count + 1;
    const delaySec = Math.min(REFUND_BACKOFF_BASE_SEC * (2 ** nextAttemptCount), REFUND_BACKOFF_CAP_SEC);
    const updated = await db.execute(
      `UPDATE refunds SET
         status = 'processing',
         attempt_count = $1,
         last_attempt_at = NOW(),
         next_attempt_at = NOW() + ($2 || ' seconds')::interval,
         updated_at = NOW()
       WHERE id = $3
         AND (
           status = 'requested'
           OR (
             status = 'processing'
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           )
         )`,
      [nextAttemptCount, delaySec, refundId],
      client
    );
    if (updated.rowCount === 1) {
      const claimedRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
      return { claimed: true, refund: claimedRows[0] };
    }

    // rowCount===0 — не выиграли claim. Перечитываем актуальное состояние в
    // ЭТОЙ ЖЕ транзакции, чтобы доменно объяснить причину, а не вернуть
    // безликий null.
    const freshRows = await db.query('SELECT * FROM refunds WHERE id = $1', [refundId], client);
    const fresh = freshRows[0];
    if (!fresh) return { claimed: false, reason: 'not_found', refund: null };
    if (fresh.status === 'succeeded' || fresh.status === 'failed') {
      return { claimed: false, reason: 'terminal', refund: fresh };
    }
    if (fresh.status === 'processing') {
      return { claimed: false, reason: 'leased', refund: fresh };
    }
    // fresh.status === 'requested' здесь означало бы, что наш собственный
    // UPDATE не матчнул строку, которая по прочтении СЕЙЧАС всё ещё
    // 'requested' — WHERE безусловно разрешает 'requested', это не должно
    // быть достижимо. Fail-loud, а не молчаливое несоответствие.
    throw refundInvariant('claim-конфликт без объяснимой причины (rowCount=0 для requested-строки)');
  });

  refundAttemptInFlight.set(refundId, operation);
  try {
    return await operation;
  } finally {
    if (refundAttemptInFlight.get(refundId) === operation) refundAttemptInFlight.delete(refundId);
  }
}

// ---------------------------------------------------------------------------
// Production Switch — Stage 8: refund network orchestration
// ---------------------------------------------------------------------------
//
// Закрывает пробел, оставленный Wave 7 (claimRefundForProcessing — только
// claim-половина): до этой задачи резервированная (reserveRefundRow) строка
// возврата НИКОГДА фактически не отправлялась провайдеру на PostgreSQL-
// стороне — claim переводил её в 'requested', и на этом всё заканчивалось
// навсегда. Деньги клиенту не возвращались бы. Ниже — дословный по духу (не
// по формулировкам, т.к. Wave 7 уже дал доменно-классифицированный
// claimRefundForProcessing взамен буквального SQLite-style raw-row-возврата)
// перенос ensureRefundReady()/scheduleRefundProcessing()/sweepStuckRefunds()
// из SQLite-оригинала, построенный НА ТОП уже существующего Wave 7 claim.
//
// providerRefundTimeoutMs()/refundPaymentWithTimeout() — дословная копия
// SQLite-оригинала (Promise.race вокруг payments.refundPayment()) — чистая
// функция, не трогает БД, порт без изменений логики.
function providerRefundTimeoutMs() {
  const configured = Number(process.env.PAYMENT_REFUND_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured >= 10 && configured <= 120000
    ? configured
    : 10000;
}

async function refundPaymentWithTimeout(params) {
  let timer;
  try {
    return await Promise.race([
      payments.refundPayment(params.providerPaymentId, params.amount, params.idempotencyKey),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('payment refund provider timeout')), providerRefundTimeoutMs());
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Общая "пост-claim" половина для ensureRefundReady() (единичный refund,
// вызывается из scheduleRefundProcessing после commit бизнес-транзакции) и
// sweepStuckRefunds() (bounded batch, см. ниже) — сетевой вызов провайдера +
// финализация СТРОГО вне какой-либо открытой транзакции, тот же принцип,
// что и everywhere else в этом модуле (ensureInitialAttemptReady и т.д.).
// claimedRefund — уже атомарно переведённая в 'processing' строка (лизинг
// next_attempt_at уже выставлен ДО этого вызова, как того требует
// architecture review: падение процесса прямо во время await ниже всё равно
// будет безопасно подхвачено следующим sweepStuckRefunds() по истечении
// лизинга — отдельного "зависшего" состояния не нужно).
async function processClaimedRefund(claimedRefund) {
  const paymentRows = await db.query('SELECT * FROM payments WHERE id = $1', [claimedRefund.payment_id]);
  const payment = paymentRows[0];
  if (!payment || !payment.provider_payment_id) {
    throw refundInvariant('платёж для возврата не найден или не содержит provider id');
  }

  let result;
  try {
    if (claimedRefund.provider_refund_id) {
      result = {
        refundId: claimedRefund.provider_refund_id,
        status: await payments.getRefundStatus(claimedRefund.provider_refund_id, {
          providerPaymentId: payment.provider_payment_id,
          amount: claimedRefund.amount,
        }),
      };
    } else {
      result = await refundPaymentWithTimeout({
        providerPaymentId: payment.provider_payment_id,
        amount: claimedRefund.amount,
        idempotencyKey: claimedRefund.provider_idempotency_key,
      });
    }
  } catch (err) {
    // Неизвестно, успел ли провайдер выполнить возврат. Строка остаётся
    // 'processing' с уже выставленным next_attempt_at — следующий sweep
    // безопасно повторит тот же idempotency key (тот же принцип, что и
    // ensureInitialAttemptReady/SQLite-оригинал). Ничего не бросаем наружу —
    // у этой функции нет синхронного HTTP-вызывающего, ожидающего статус-код.
    console.error(`[services/postgresql/orderService] refund provider unavailable refund=${claimedRefund.id} type=${err?.name || 'Error'}`);
    const rows = await db.query('SELECT * FROM refunds WHERE id = $1', [claimedRefund.id]);
    return rows[0];
  }
  if (!result || !['pending', 'succeeded', 'failed'].includes(result.status)) {
    throw refundInvariant(`провайдер вернул неизвестный статус возврата: ${result && result.status}`);
  }
  if (result.status === 'pending') {
    if (!result.refundId) throw refundInvariant('pending-возврат не содержит provider refund id');
    const pending = await db.execute(
      `UPDATE refunds SET provider_refund_id = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'processing'
         AND (provider_refund_id IS NULL OR provider_refund_id = $1)
       RETURNING *`,
      [result.refundId, claimedRefund.id]
    );
    if (pending.rowCount !== 1) {
      throw refundInvariant('не удалось сохранить provider refund id для pending-возврата');
    }
    return pending.rows[0];
  }
  if (result.status === 'succeeded') return finalizeRefundSucceeded(claimedRefund.id, result.refundId || null);
  return finalizeRefundFailed(claimedRefund.id, 'provider_failed');
}

// Отдельная in-flight Map — НЕ переиспользует refundAttemptInFlight
// claimRefundForProcessing() (Wave 7) намеренно: та охватывает только claim-
// шаг (уже протестирована в этой узкой роли отдельными Wave 7 тестами), эта
// охватывает ВЕСЬ оркестратор (claim + сеть + finalize), тот же периметр,
// что refundAttemptInFlight в SQLite-оригинале. Обе Map — чисто
// внутрипроцессные fast-path оптимизации; основная защита в обоих случаях —
// SQL WHERE-guard внутри claimRefundForProcessing.
const refundOrchestrationInFlight = new Map();

async function ensureRefundReady(refundId) {
  if (refundOrchestrationInFlight.has(refundId)) return refundOrchestrationInFlight.get(refundId);

  const operation = (async () => {
    const claim = await claimRefundForProcessing(refundId);
    if (!claim.claimed) return claim.refund; // terminal (succeeded/failed) | leased (чужой claim ещё идёт) | not_found (null)
    return processClaimedRefund(claim.refund);
  })();

  refundOrchestrationInFlight.set(refundId, operation);
  try {
    return await operation;
  } finally {
    if (refundOrchestrationInFlight.get(refundId) === operation) refundOrchestrationInFlight.delete(refundId);
  }
}

// Запуск строго ПОСЛЕ COMMIT транзакции, создавшей/нашедшей строку возврата
// (cancelByCustomer/restaurantDecline/sweepTimeouts/markPaid — см. их
// вызовы ниже) — сетевой вызов провайдера никогда не выполняется внутри
// db.transaction(). Возвращает Promise (удобно для тестов); вызывающая
// бизнес-функция сознательно НЕ ждёт его — клиент узнаёт результат через
// order.refund_status при следующем poll. Ошибка уже залогирована и
// проглочена здесь же — fire-and-forget безопасен, не создаёт unhandled
// rejection.
function scheduleRefundProcessing(refundId) {
  return ensureRefundReady(refundId).catch((err) => {
    console.error(`[services/postgresql/orderService] refund processing failed refund=${refundId}:`, err.message);
  });
}

// Периодическая сверка (см. services/postgresql/scheduler.js,
// createRefundReconciliationScheduler) — переживает рестарт процесса,
// подхватывает: (1) 'requested'-строки, чей провайдер-вызов вообще не успел
// стартовать (процесс упал между COMMIT бизнес-транзакции и вызовом
// scheduleRefundProcessing); (2) 'processing'-строки с истёкшим
// next_attempt_at (предыдущая попытка закончилась неоднозначно, либо
// процесс упал во время сетевого вызова).
//
// Bounded batch + FOR UPDATE SKIP LOCKED (задание Stage 8, раздел
// "Reconciliation" — "no uncontrolled full-table scan", "bounded batches",
// "indexed queries", "avoid multiple workers processing the same row
// concurrently"): один атомарный round-trip — CTE выбирает до `limit`
// кандидатов (см. ix_refunds_pending_sweep в schema.sql), ПРОПУСКАЯ строки,
// уже залоченные другой конкурентной транзакцией (SKIP LOCKED — не блокирует
// и не ждёт, попробует их на следующем тике), затем СРАЗУ ЖЕ claim'ит их
// (тот же backoff-формула, что и claimRefundForProcessing, выраженная в SQL)
// одним UPDATE. Это НЕ основной механизм безопасности (им остаётся
// WHERE-guard внутри самого claim — тот же принцип, что и у единичного
// ensureRefundReady/claimRefundForProcessing выше) — SKIP LOCKED здесь
// снижает бесполезную конкуренцию между несколькими одновременно тикающими
// sweep'ами (в этом же процессе или в другом инстансе приложения), а не
// является единственной линией защиты от двойной обработки.
async function sweepStuckRefunds({ limit = REFUND_SWEEP_BATCH_LIMIT } = {}) {
  const claimedRows = await db.transaction((client) => db.query(
    `WITH candidates AS (
       SELECT id FROM refunds
       WHERE status IN ('requested', 'processing')
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY next_attempt_at NULLS FIRST, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE refunds r SET
       status = 'processing',
       attempt_count = r.attempt_count + 1,
       last_attempt_at = NOW(),
       next_attempt_at = NOW() + (LEAST($2 * POWER(2, r.attempt_count + 1), $3) || ' seconds')::interval,
       updated_at = NOW()
     FROM candidates c
     WHERE r.id = c.id
     RETURNING r.*`,
    [limit, REFUND_BACKOFF_BASE_SEC, REFUND_BACKOFF_CAP_SEC],
    client
  ));

  await Promise.all(claimedRows.map((row) => processClaimedRefund(row).catch((err) => {
    console.error(`[services/postgresql/orderService] sweep refund retry failed refund=${row.id}:`, err.message);
  })));

  return claimedRows.length;
}

// ---------------------------------------------------------------------------
// Production Switch — Stage 3 (bot/postgresql/index.js): restaurant pause
// ---------------------------------------------------------------------------
//
// pauseRestaurant/resumeRestaurant НЕ входили ни в одну SQL-side волну и не в
// Stage 1/2 (не требовались для routes/api.js или orderEvents) — миграция
// изначально называла их отдельным будущим "Stage 5" (см. postgresql-
// migration-status.md). Но server/bot/postgresql/index.js (этот Stage 3)
// объективно не может воспроизвести команды /pause и /open без них — это
// ровно тот случай "минимального нового PostgreSQL helper'а, объективно
// нужного боту", который задание Stage 3 прямо разрешает, без общего
// рефакторинга и без переноса лишнего (sweepPauseExpiry — периодический
// свип, вызываемый из server.js setInterval, а не из бота — НЕ переносится
// здесь, вне scope изолированного bot-модуля).
//
// Дословные асинхронные аналоги SQLite-оригинала — обе функции однострочные
// conditional/безусловные UPDATE, не требуют db.transaction() (нет
// многошаговой атомарности, которую нужно защищать — тот же вывод, что и для
// остальных "класса 1" операций в concurrency-матрице).
async function pauseRestaurant(restaurantId, presetKey) {
  const minutes = PAUSE_PRESETS_MIN[presetKey];
  if (!minutes) throw new Error(`неизвестный пресет перерыва: ${presetKey}`);
  const rows = await db.query(`SELECT NOW() + ($1 || ' minutes')::interval AS until`, [minutes]);
  const until = rows[0].until;
  await db.execute('UPDATE restaurants SET is_open = 0, paused_until = $1 WHERE id = $2', [until, restaurantId]);
  return until;
}

async function resumeRestaurant(restaurantId) {
  await db.execute('UPDATE restaurants SET is_open = 1, paused_until = NULL WHERE id = $1', [restaurantId]);
}

// ---------------------------------------------------------------------------
// Production Switch — Stage 5 (server/services/postgresql/scheduler.js):
// automatic pause expiry
// ---------------------------------------------------------------------------
//
// Дословный асинхронный аналог SQLite-оригинала — один безусловный UPDATE,
// без db.transaction() (нет многошаговой атомарности, которую нужно
// защищать — тот же класс операции, что и pauseRestaurant/resumeRestaurant
// выше). Не эмитит ничего в orderEvents — подтверждено построчным чтением
// SQLite-оригинала (см. "Production Switch — Stage 2" в начале файла,
// список функций, НЕ эмитящих события) и сохранено здесь без изменений.
//
// SQLite-версия сравнивает TEXT-строки лексикографически (`paused_until <=
// datetime('now')`), поэтому pauseRestaurant() там ОБЯЗАН вычислять
// paused_until средствами самого SQLite (не new Date()), чтобы формат совпал
// — иначе сравнение молча давало бы неверный результат. Под PostgreSQL
// paused_until — TIMESTAMPTZ (уже настоящий хронологический тип, не текст),
// поэтому `paused_until <= NOW()` — обычное типизированное сравнение
// моментов времени, а не строк; проблема формата структурно не существует.
// Сравнение выполняется ЦЕЛИКОМ на стороне PostgreSQL (`NOW()` — часы
// сервера БД) — вызывающий Node-процесс не участвует в решении "истекла ли
// пауза" вычислением собственного `Date.now()`, поэтому расхождение часов
// между несколькими экземплярами приложения (clock drift) структурно не
// может исказить это решение — все экземпляры сверяются с ОДними и теми же
// часами БД, а не каждый со своими.
async function sweepPauseExpiry() {
  await db.execute(`
    UPDATE restaurants SET is_open = 1, paused_until = NULL
    WHERE is_open = 0 AND paused_until IS NOT NULL AND paused_until <= NOW()
  `);
}

module.exports = {
  orderEvents,
  getOrder,
  createOrder,
  rateOrder,
  RATING_ELIGIBLE_STATUS,
  claimRefundForProcessing,
  REFUND_BACKOFF_BASE_SEC,
  REFUND_BACKOFF_CAP_SEC,
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
  PAYMENT_DEADLINE_MINUTES,
  ActiveOrderConflictError,
  OrderCreationInputError,
  // Stage 1 (routes/postgresql/api.js)
  parseBearerAuthorization,
  findAuthorizedOrderId,
  toPublicOrderDTO,
  toPublicPaymentDTO,
  createOrderAndResolve,
  recoverOrder,
  retryPayment,
  getPaymentByProviderPaymentId,
  getRefundByProviderRefundId,
  getPendingPaymentForOrder,
  OrderAccessInputError,
  OrderCreationRecoveryNotFoundError,
  PaymentInitialUnavailableError,
  PaymentRetryUnavailableError,
  PaymentRetryConflictError,
  isValidOrderToken,
  isValidCreateKey,
  isValidRetryKey,
  // Stage 3 (bot/postgresql/index.js)
  pauseRestaurant,
  resumeRestaurant,
  PAUSE_PRESETS_MIN,
  // Stage 5 (services/postgresql/scheduler.js)
  sweepPauseExpiry,
  // Stage 8 (refund network orchestration + reconciliation)
  ensureRefundReady,
  scheduleRefundProcessing,
  sweepStuckRefunds,
  REFUND_SWEEP_BATCH_LIMIT,
};
