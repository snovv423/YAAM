'use strict';

// server/db/postgresql/seed-hqtest.js
//
// Идемпотентный, ТОЛЬКО-аддитивный seed для тестового окружения
// hqtest.yaam.su. НИКОГДА не выполняет DELETE/TRUNCATE/DROP и не трогает
// ни одну существующую строку — только INSERT (и, где нужно для реальных
// переходов состояний, UPDATE через штатные сервисы, никогда напрямую по
// таблицам, которые эти сервисы защищают).
//
// Двойной fail-closed гейт (см. assertSafeEnvironment() ниже), выполняется
// ДО require() любого db/сервисного модуля:
//   1. HQTEST_SEED_CONFIRM=YES — явное подтверждение оператора.
//   2. DATABASE_URL должен указывать на базу с именем РОВНО "yaam_hqtest" —
//      единственная техническая защита от случайного запуска на staging/
//      production базе, даже если оператор случайно забыл переключить
//      переменную окружения в терминале.
//
// Данные создаются, где только возможно, через штатные сервисы
// (orderService/settlementService/payoutService/tbankPayoutStatusMapper) —
// не прямым SQL — чтобы все DB-триггеры/инварианты (state machine,
// immutability) соблюдались автоматически, а не имитировались. Единственное
// намеренное исключение — см. раздел "FAILED REFUND" ниже, честно
// задокументированное, а не скрытое.
//
// Идемпотентность — не построчная, а поблочная: каждый блок (рестораны,
// заказы, выплата) сначала проверяет, был ли он уже создан этим же скриптом
// (по стабильному, детерминированному идентификатору — connect_code для
// ресторанов, public_code для заказов, наличие payout для расчёта), и
// пропускает создание целиком, если да. Повторный запуск — безопасный no-op.

function assertSafeEnvironment() {
  if (process.env.HQTEST_SEED_CONFIRM !== 'YES') {
    throw new Error(
      'Отказано: HQTEST_SEED_CONFIRM=YES обязателен для запуска этого скрипта '
      + '(защита от случайного запуска на staging/production).',
    );
  }
  const databaseUrl = process.env.DATABASE_URL || '';
  let dbName = null;
  try {
    // new URL() ленив к формату "postgres://user:pass@host:port/dbname" —
    // pathname содержит "/dbname", убираем ведущий слэш.
    dbName = new URL(databaseUrl).pathname.replace(/^\//, '') || null;
  } catch {
    dbName = null;
  }
  if (dbName !== 'yaam_hqtest') {
    throw new Error(
      'Отказано: DATABASE_URL должен указывать на базу с именем РОВНО '
      + `"yaam_hqtest" (сейчас: ${dbName ? `"${dbName}"` : 'не удалось разобрать DATABASE_URL'}). `
      + 'Это единственная техническая защита от случайного запуска на staging/'
      + 'production базе — не ослаблять и не обходить.',
    );
  }
}

assertSafeEnvironment();

// require() — строго ПОСЛЕ проверки выше, не раньше (иначе db/postgresql/
// index.js уже создал бы пул на непроверенный DATABASE_URL до того, как мы
// успели бы отказать).
const crypto = require('node:crypto');
const db = require('./index');
const orderService = require('../../services/postgresql/orderService');
const settlementService = require('../../services/hq/settlementService');
const payoutService = require('../../services/hq/payoutService');
const yaamBankDetailsService = require('../../services/hq/yaamBankDetailsService');
const restaurantBankDetailsService = require('../../services/hq/restaurantBankDetailsService');
const restaurantContractService = require('../../services/hq/restaurantContractService');
const tbankPayoutStatusMapper = require('../../services/hq/tbankPayoutStatusMapper');
const eventLogService = require('../../services/hq/eventLogService');

// Те же вымышленные, но математически корректные (проходят реальные
// checksum-проверки БИК/р/с) реквизиты, что уже используются во всех
// PostgreSQL-тестах этой кодовой базы (server/test/postgresql/
// hqPayoutStage98.test.js, tbankPayoutStatusMapper.test.js) — не изобретены
// заново для этого скрипта.
const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_INN10 = '7709123453';
const FICTITIOUS_KPP = '770101001';

function log(msg) {
  console.log(`[seed-hqtest] ${msg}`);
}

// "Сегодня" — В ТОМ ЖЕ часовом поясе (Europe/Moscow, фиксированный +180
// минут), что и services/hq/restaurantStatsService.js:dateOnlyToUtcStart(),
// которую использует closeSettlementPeriod() для сопоставления заказов
// периоду. Пропустить эту поправку и посчитать "сегодня" по чистому UTC-
// календарю — реальный, воспроизведённый в этой же задаче баг: заказы,
// созданные между 21:00 и 24:00 UTC (00:00-03:00 по Москве), попадали бы в
// "завтрашний" период по мнению closeSettlementPeriod(), и подготовка
// выплаты падала бы с "нет зафиксированной строки обязательства в этом
// периоде". PROJECT_TIMEZONE_OFFSET_MINUTES импортирован из
// dashboardMetrics.js, не задан заново — при изменении там этот скрипт не
// рассинхронизируется молча.
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('../../services/hq/dashboardMetrics');
function todayStr(offsetDays = 0) {
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(Date.now() + offsetMs + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function orderToken() {
  return `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`;
}
function createKey() {
  return `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

async function findRestaurantByConnectCode(connectCode) {
  const rows = await db.query('SELECT id FROM restaurants WHERE connect_code = $1', [connectCode]);
  return rows[0] ? rows[0].id : null;
}

// Ресторан помечен как тестовый явно и заметно: "(hqtest)" в названии,
// фиксированный, узнаваемый connect_code (никогда не совпадёт со случайным
// одноразовым кодом реального будущего ресторана — тот генерируется
// случайно при каждом реальном подключении бота, см. connectCodeService.js).
async function ensureRestaurant({ connectCode, name, cuisine }) {
  const existingId = await findRestaurantByConnectCode(connectCode);
  if (existingId) {
    log(`ресторан "${name}" уже существует (id=${existingId}, connect_code=${connectCode}) — пропуск`);
    return { id: existingId, created: false };
  }
  const rows = await db.execute(
    `INSERT INTO restaurants
       (name, cuisine, cities, phone, is_open, min_order, rating, rating_count, connect_code, published_at)
     VALUES ($1, $2, $3, '+70000000000', 1, 300, 4.5, 10, $4, NOW())
     RETURNING id`,
    [name, cuisine, JSON.stringify(['Грозный']), connectCode],
  );
  const id = rows.rows[0].id;
  log(`ресторан "${name}" создан (id=${id})`);
  return { id, created: true };
}

async function ensureCategory(restaurantId, name) {
  const existing = await db.query(
    'SELECT id FROM categories WHERE restaurant_id = $1 AND name = $2',
    [restaurantId, name],
  );
  if (existing[0]) return existing[0].id;
  const rows = await db.execute(
    'INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id',
    [restaurantId, name],
  );
  return rows.rows[0].id;
}

async function ensureMenuItem(restaurantId, categoryId, { name, price, isAvailable }) {
  const existing = await db.query(
    'SELECT id FROM menu_items WHERE restaurant_id = $1 AND category_id = $2 AND name = $3',
    [restaurantId, categoryId, name],
  );
  if (existing[0]) return existing[0].id;
  const rows = await db.execute(
    'INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [restaurantId, categoryId, name, price, isAvailable ? 1 : 0],
  );
  return rows.rows[0].id;
}

async function findOrderIdByPublicCode(publicCode) {
  const rows = await db.query('SELECT id FROM orders WHERE public_code = $1', [publicCode]);
  return rows[0] ? rows[0].id : null;
}

// Создаёт заказ ТОЛЬКО через реальный orderService.createOrderAndResolve()
// (тот же путь, что и настоящий POST /api/orders) — фиксированный public_code
// используется исключительно как идемпотентный ключ ЭТОГО скрипта (сама
// БД генерирует свой собственный public_code при создании; мы затем
// перезаписываем его на предсказуемое тестовое значение одним точечным
// UPDATE поля public_code — единственное поле, не бизнес-логика/статус).
async function createSeedOrder({ restaurantId, menuItemId, publicCode, customerPhone }) {
  const existingId = await findOrderIdByPublicCode(publicCode);
  if (existingId) {
    log(`заказ ${publicCode} уже существует (id=${existingId}) — пропуск`);
    return { id: existingId, created: false };
  }
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'HQTEST Тестовый Клиент',
    customerPhone,
    address: 'ул. Тестовая, 1 (hqtest seed)',
    comment: 'hqtest seed — не реальный заказ',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'HQTEST блюдо', qty: 1 }],
    orderAccessToken: orderToken(),
    createIdempotencyKey: createKey(),
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  await db.execute('UPDATE orders SET public_code = $1 WHERE id = $2', [publicCode, order.id]);
  log(`заказ ${publicCode} создан (id=${order.id})`);
  return { id: order.id, created: true };
}

async function getPendingPaymentId(orderId) {
  const rows = await db.query(
    `SELECT id FROM payments WHERE order_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`,
    [orderId],
  );
  return rows[0] ? rows[0].id : null;
}

async function getPaymentAmount(paymentId) {
  const rows = await db.query('SELECT amount FROM payments WHERE id = $1', [paymentId]);
  if (!rows[0]) throw new Error(`payments: id=${paymentId} не найден`);
  return rows[0].amount;
}

async function seedFullReadiness(restaurantId) {
  const existingYaam = await yaamBankDetailsService.getYaamBankDetails();
  if (!existingYaam) {
    await yaamBankDetailsService.saveYaamBankDetails({
      legal_name: 'ООО YAAM Платформа (hqtest)', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
      account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК (hqtest)',
      correspondent_account: FICTITIOUS_KS,
    });
    log('реквизиты YAAM как плательщика заполнены (hqtest)');
  }
  const existingBank = await restaurantBankDetailsService.getBankDetails(restaurantId);
  if (!existingBank) {
    await restaurantBankDetailsService.saveBankDetails(restaurantId, {
      recipient_name: 'ИП Тестов Тест Тестович (hqtest)', recipient_inn: FICTITIOUS_INN12, recipient_kpp: '',
      account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК (hqtest)',
      correspondent_account: FICTITIOUS_KS, default_payment_purpose: 'Оплата услуг по договору (hqtest)',
    });
  }
  const existingContract = await restaurantContractService.getContract(restaurantId);
  if (!existingContract) {
    await restaurantContractService.saveContract(restaurantId, {
      contract_number: `HQTEST-Д-${restaurantId}`, signed_at: '2026-01-01', status: 'signed',
    });
  }
}

// Поллинг завершения асинхронного (fire-and-forget) возврата через реальный
// mock-провайдер — обычно near-instant, но НЕ синхронно внутри вызова
// cancelByCustomer() (см. orderService.js: scheduleRefundProcessing после
// commit, не await'ится). Таймаут — защита от зависания скрипта, не бизнес-
// требование.
async function waitForRefundStatus(orderId, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.query(
      `SELECT r.status FROM refunds r
         JOIN payments p ON p.id = r.payment_id
        WHERE p.order_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [orderId],
    );
    if (rows[0] && rows[0].status !== 'requested' && rows[0].status !== 'processing') return rows[0].status;
    if (Date.now() > deadline) return rows[0] ? rows[0].status : null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  log('старт (DATABASE_URL проверен — база yaam_hqtest)');

  // -------------------------------------------------------------------
  // 1. Два тестовых ресторана
  // -------------------------------------------------------------------
  const restA = await ensureRestaurant({
    connectCode: 'HQTEST-CONNECT-A', name: 'HQTEST Хачапурная (тест)', cuisine: 'Грузинская',
  });
  const restB = await ensureRestaurant({
    connectCode: 'HQTEST-CONNECT-B', name: 'HQTEST Пустой ресторан (тест)', cuisine: 'test',
  });

  // -------------------------------------------------------------------
  // 2. Категории и блюда (включая недоступное) — только на ресторане A,
  //    ресторан B намеренно остаётся почти пустым (проверка пустых
  //    состояний в HQ — тоже часть полезного тестового набора).
  // -------------------------------------------------------------------
  const catMain = await ensureCategory(restA.id, 'HQTEST Хачапури');
  await ensureCategory(restA.id, 'HQTEST Напитки');
  const dish1 = await ensureMenuItem(restA.id, catMain, { name: 'HQTEST Хачапури по-аджарски', price: 450, isAvailable: true });
  await ensureMenuItem(restA.id, catMain, { name: 'HQTEST Хачапури имеретинский', price: 400, isAvailable: true });
  await ensureMenuItem(restA.id, catMain, { name: 'HQTEST Хачапури (недоступно)', price: 500, isAvailable: false });

  // -------------------------------------------------------------------
  // 3. Заказы в основных статусах (через реальные сервисные переходы)
  // -------------------------------------------------------------------
  const phone = (n) => `+7900${String(n).padStart(7, '0')}`;

  // 3a. awaiting_payment — просто создан, оплата не завершена.
  await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT001', customerPhone: phone(1) });

  // 3b. payment_failed — создан, платёж явно провален через markPaymentFailed.
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT002', customerPhone: phone(2) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaymentFailed(orderId, paymentId);
    }
  }

  // 3c. awaiting_restaurant — оплачен (markPaid), ресторан ещё не ответил.
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT003', customerPhone: phone(3) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
    }
  }

  // 3d. accepted — оплачен + принят рестораном.
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT004', customerPhone: phone(4) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
      await orderService.restaurantAccept(orderId);
    }
  }

  // 3e. preparing.
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT005', customerPhone: phone(5) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
      await orderService.restaurantAccept(orderId);
      await orderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: 30 });
    }
  }

  // 3f. courier (в пути).
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT006', customerPhone: phone(6) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
      await orderService.restaurantAccept(orderId);
      await orderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: 30 });
      // Stage 33 — новый обязательный шаг между preparing и courier.
      await orderService.restaurantAdvance(orderId, 'ready');
      await orderService.restaurantAdvance(orderId, 'courier');
    }
  }

  // 3g. delivered — полный жизненный цикл, попадает в расчётный период ниже.
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT007', customerPhone: phone(7) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
      await orderService.restaurantAccept(orderId);
      await orderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: 30 });
      await orderService.restaurantAdvance(orderId, 'ready');
      await orderService.restaurantAdvance(orderId, 'courier');
      // Stage 33 — ресторан больше не доводит delivery-заказ до delivered
      // сам; здесь это симулирует клиентское подтверждение получения.
      await orderService.confirmReceiptByCustomer(orderId);
    }
  }

  // 3h. declined — оплачен, ресторан отклонил (реальный refund, reason=restaurant_decline).
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT008', customerPhone: phone(8) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
      await orderService.restaurantDecline(orderId);
      await waitForRefundStatus(orderId);
    }
  }

  // 3i. timed_out — реальный orderService.sweepTimeouts(), не имитация статуса
  // напрямую: backdate'им ТОЛЬКО status_updated_at (не сам статус) в прошлое,
  // чтобы настоящая функция sweepTimeouts() сама, по своей же бизнес-логике,
  // сочла заказ просроченным — тот же принцип "правильный переход, ускоренное
  // время", не подмена состояния.
  {
    const { id: orderId, created } = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT009', customerPhone: phone(9) });
    if (created) {
      const paymentId = await getPendingPaymentId(orderId);
      await orderService.markPaid(orderId, paymentId);
      await db.execute(
        `UPDATE orders SET status_updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [orderId],
      );
      await orderService.sweepTimeouts();
    }
  }

  // 3j. cancelled — оплачен, клиент отменил ДО ответа ресторана (реальный
  // succeeded refund, см. блок 4 ниже — тот же заказ используется для
  // "успешного возврата").
  const cancelledOrder = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT010', customerPhone: phone(10) });
  if (cancelledOrder.created) {
    const paymentId = await getPendingPaymentId(cancelledOrder.id);
    await orderService.markPaid(cancelledOrder.id, paymentId);
    await orderService.cancelByCustomer(cancelledOrder.id);
    const finalStatus = await waitForRefundStatus(cancelledOrder.id);
    log(`YAAM-HQT010: успешный возврат через реальный mock-провайдер, итоговый статус: ${finalStatus}`);
  }

  // -------------------------------------------------------------------
  // 4. FAILED REFUND — единственное намеренное исключение из "только через
  //    сервисы". mockProvider.refund() (server/services/paymentProviders/
  //    mockProvider.js) возвращает status:'failed' ТОЛЬКО когда переданный
  //    providerPaymentId не найден в его собственной in-memory карте — это
  //    не бизнес-сценарий, достижимый через реальный сервисный вызов (любой
  //    платёж, реально созданный через orderService.createOrderAndResolve(),
  //    провайдер всегда "узнаёт"), а внутренняя деталь реализации демо-
  //    провайдера. Таблица `refunds` НЕ имеет trigger-based state machine
  //    (в отличие от payout_attempts/restaurant_payouts — см. schema.sql,
  //    только два partial UNIQUE index, ни одного триггера), поэтому прямой
  //    INSERT здесь безопасен и не обходит ни один инвариант. Честно
  //    зафиксировано здесь и в итоговом отчёте, не скрыто как "как будто
  //    сервисный путь".
  // -------------------------------------------------------------------
  {
    const failedRefundOrder = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT011', customerPhone: phone(11) });
    if (failedRefundOrder.created) {
      const paymentId = await getPendingPaymentId(failedRefundOrder.id);
      await orderService.markPaid(failedRefundOrder.id, paymentId);
      await orderService.restaurantDecline(failedRefundOrder.id); // создаёт РЕАЛЬНЫЙ succeeded refund через reserveRefundRow+scheduleRefundProcessing
      await waitForRefundStatus(failedRefundOrder.id);
      // Намеренное исключение (см. комментарий блока выше): второй,
      // самостоятельный "проблемный" refund НЕ существует как естественный
      // повторный сценарий для одного и того же payment (ux_refunds_one_
      // succeeded_per_payment уже блокирует повторный succeeded, а провайдер
      // не даёт легитимного способа получить настоящий failed) — вставляется
      // отдельной demo-строкой на СВОЙ собственный дополнительный заказ ниже,
      // явно помеченной как demo/seed, не как реальный провалившийся возврат
      // этого заказа.
    }
  }
  {
    const problemRefundOrder = await createSeedOrder({ restaurantId: restA.id, menuItemId: dish1, publicCode: 'YAAM-HQT012', customerPhone: phone(12) });
    if (problemRefundOrder.created) {
      const paymentId = await getPendingPaymentId(problemRefundOrder.id);
      await orderService.markPaid(problemRefundOrder.id, paymentId);
      // markPaymentFailed требует статус 'awaiting_payment' — здесь заказ уже
      // awaiting_restaurant, поэтому для ДЕМОНСТРАЦИИ "проблемного возврата"
      // (last_error_code) вставляем строку refunds напрямую (см. обоснование
      // выше) поверх succeeded-платежа этого заказа — единственное место в
      // этом скрипте с прямым INSERT в таблицу возвратов.
      // amount ОБЯЗАН побайтово совпадать с payments.amount — БД-инвариант
      // "full-refund-only" (fn_refunds_amount_matches_payment, см.
      // server/docs/postgresql-payment-safety.md), даже для этой
      // демонстрационной прямой вставки: инвариант не отключается ради
      // seed-данных, наоборот — он ОБЯЗАН выполняться, поэтому сумма
      // читается из реальной строки платежа, а не захардкожена.
      const paymentAmount = await getPaymentAmount(paymentId);
      await db.execute(
        `INSERT INTO refunds
           (payment_id, provider, amount, status, reason, provider_refund_id,
            provider_idempotency_key, attempt_count, last_attempt_at, last_error_code, last_error_message_safe)
         VALUES ($1, 'mock', $2, 'failed', 'restaurant_decline', NULL, $3, 3, NOW(), 'provider_unavailable',
                 'hqtest seed: демонстрационный неуспешный возврат (mock-провайдер не поддерживает реальный failed-сценарий)')`,
        [paymentId, paymentAmount, `hqtest-seed-refund-${problemRefundOrder.id}`],
      );
      log(`YAAM-HQT012: демонстрационный НЕУСПЕШНЫЙ возврат создан напрямую (см. комментарий в коде) — единственное исключение из "только сервисы"`);
      // HQ «Центр событий» — реальный код (orderService.finalizeRefundFailed)
      // не выполняется на этом пути (см. комментарий блока выше — прямой
      // INSERT в refunds, не сервисный вызов), поэтому событие для demo
      // категории "ошибка возврата" создаётся здесь явно тем же текстом,
      // что произвёл бы реальный хук.
      await eventLogService.createEvent({
        category: 'refund_issue',
        restaurantId: restA.id,
        restaurantName: 'HQTEST Хачапурная (тест)',
        orderId: problemRefundOrder.id,
        orderPublicCode: 'YAAM-HQT012',
        message: 'Возврат по заказу YAAM-HQT012 не удался: платёжный провайдер был недоступен. Требует ручной проверки.',
      });
    }
  }

  // -------------------------------------------------------------------
  // 5. Закрытый расчётный период + выплаты (успешная и проблемная) —
  //    гейт идемпотентности: если у ресторана A уже есть хотя бы одна
  //    выплата, весь блок пропускается целиком.
  // -------------------------------------------------------------------
  const existingPayout = await db.query('SELECT id FROM restaurant_payouts WHERE restaurant_id = $1 LIMIT 1', [restA.id]);
  if (existingPayout[0]) {
    log(`у ресторана A уже есть выплата (id=${existingPayout[0].id}) — блок расчётного периода/выплат пропущен`);
  } else {
    await seedFullReadiness(restA.id);

    const today = todayStr();
    const existingPeriod = await db.query(
      'SELECT id FROM settlement_periods WHERE period_from = $1 AND period_to = $1',
      [today],
    );
    let periodId;
    if (existingPeriod[0]) {
      periodId = existingPeriod[0].id;
    } else {
      const period = await settlementService.createDraftSettlementPeriod({ periodFrom: today, periodTo: today });
      await settlementService.closeSettlementPeriod(period.id);
      periodId = period.id;
      log(`расчётный период ${today} создан и закрыт (id=${periodId})`);
    }

    const payout = await payoutService.prepareRestaurantPayout(periodId, restA.id);
    log(`выплата подготовлена (id=${payout.id}, сумма=${payout.amount})`);

    // 5a. Успешная выплата — реальный маппер T-Bank статусов (IN_PROGRESS -> EXECUTED).
    const attempt1 = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt1.id);
    await tbankPayoutStatusMapper.applyTBankPayoutStatus(attempt1.id, tbankPayoutStatusMapper.EXTERNAL_STATUS_IN_PROGRESS);
    await tbankPayoutStatusMapper.applyTBankPayoutStatus(attempt1.id, tbankPayoutStatusMapper.EXTERNAL_STATUS_EXECUTED);
    log(`выплата ${payout.id}: успешная попытка ${attempt1.id} (EXECUTED)`);

    // 5b. Проблемная выплата — второй ресторан + свой период, попытка со
    // статусом CANCELLED от Т-Банка (retryable=false -> обязательство уходит
    // в 'blocked', требует решения оператора — реалистичный "проблемный" кейс).
    await seedFullReadiness(restB.id);
    const existingPeriodB = await db.query(
      'SELECT id FROM settlement_periods WHERE period_from = $1 AND period_to = $1',
      [todayStr(-1)],
    );
    let periodBId;
    if (existingPeriodB[0]) {
      periodBId = existingPeriodB[0].id;
    } else {
      const orderIdForB = (await createSeedOrder({
        restaurantId: restB.id,
        menuItemId: await ensureMenuItem(restB.id, await ensureCategory(restB.id, 'HQTEST B меню'), { name: 'HQTEST B блюдо', price: 300, isAvailable: true }),
        publicCode: 'YAAM-HQT013',
        customerPhone: phone(13),
      })).id;
      const paymentIdB = await getPendingPaymentId(orderIdForB);
      if (paymentIdB) {
        await orderService.markPaid(orderIdForB, paymentIdB);
        await orderService.restaurantAccept(orderIdForB);
        await orderService.restaurantAdvance(orderIdForB, 'preparing', { estimatedMinutes: 20 });
        await orderService.restaurantAdvance(orderIdForB, 'ready');
        // Historical seed fixture: first and only earned_at assignment is
        // made atomically with ready->courier. Migration 0015 deliberately
        // forbids rewriting that financial fact afterwards.
        const earnedAtB = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const earned = await db.execute(
          `UPDATE orders
              SET status = 'courier', status_updated_at = $2, earned_at = $2
            WHERE id = $1 AND status = 'ready' AND earned_at IS NULL`,
          [orderIdForB, earnedAtB],
        );
        if (earned.rowCount !== 1) throw new Error('YAAM-HQT013: initial earned_at assignment failed');
        await orderService.confirmReceiptByCustomer(orderIdForB);
      }
      const periodB = await settlementService.createDraftSettlementPeriod({ periodFrom: todayStr(-1), periodTo: todayStr(-1) });
      await settlementService.closeSettlementPeriod(periodB.id);
      periodBId = periodB.id;
    }
    const payoutB = await payoutService.prepareRestaurantPayout(periodBId, restB.id);
    const attemptB = await payoutService.createPayoutAttempt(payoutB.id);
    await payoutService.markAttemptSubmitting(attemptB.id);
    await tbankPayoutStatusMapper.applyTBankPayoutStatus(attemptB.id, tbankPayoutStatusMapper.EXTERNAL_STATUS_CANCELLED, { retryableOnFailure: false });
    log(`выплата ${payoutB.id}: проблемная попытка ${attemptB.id} (CANCELLED от Т-Банка, обязательство -> blocked)`);
  }

  // -------------------------------------------------------------------
  // 6. Демонстрационные события категорий БЕЗ подключённого production-
  //    источника (docs/HQ-PRODUCT-SPEC.md, раздел "Источники событий") —
  //    "payment_issue" (нет надёжного отличия от штатного отклонения карты
  //    клиентом — см. итоговый отчёт), "backend_issue"/"telegram_issue" в
  //    их процессно-уровневой форме (сбой всего процесса/бота, а не одного
  //    уведомления — ту форму уже покрывает реальный хук в bot/postgresql/
  //    index.js, см. блок 3i выше для order_missed). Идемпотентность — по
  //    наличию хотя бы одного payment_issue-события: production-код никогда
  //    его не создаёт, значит только этот блок могло его создать раньше.
  // -------------------------------------------------------------------
  const existingDemoEvent = await db.query(`SELECT id FROM hq_events WHERE category = 'payment_issue' LIMIT 1`);
  if (existingDemoEvent[0]) {
    log('демонстрационные события категорий без источника уже созданы — пропуск');
  } else {
    await eventLogService.createEvent({
      category: 'payment_issue',
      message: 'hqtest seed: демонстрационное событие категории «ошибка оплаты» — источник ещё не подключён в production (см. отчёт).',
    });
    await eventLogService.createEvent({
      category: 'backend_issue',
      message: 'hqtest seed: демонстрационное событие категории «сбой backend».',
    });
    await eventLogService.createEvent({
      category: 'telegram_issue',
      message: 'hqtest seed: демонстрационное событие категории «сбой Telegram-бота».',
    });
    log('демонстрационные события созданы (payment_issue/backend_issue/telegram_issue)');
  }

  log('готово.');
  await db.close();
}

main().catch(async (err) => {
  console.error('[seed-hqtest] ОШИБКА:', err.message);
  try { await db.close(); } catch { /* ignore */ }
  process.exitCode = 1;
});
