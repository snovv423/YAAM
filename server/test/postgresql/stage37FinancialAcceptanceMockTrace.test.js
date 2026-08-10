'use strict';

// YAAM Stage 37 — финансовая приёмка на mock, раздел 4-5: канонический
// набор mock-заказов + сквозная ручная проводка одного успешного заказа
// "от заказа до выплаты".
//
// ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ (и чего НЕ дублирует):
//   - Сценарии C (customer_cancel), D (restaurant_decline), E (timeout) уже
//     доказаны РЕАЛЬНЫМ продуктовым путём в
//     hqRestaurantRefundReportingStage71.test.js (тесты A/B/C) — не
//     дублируются здесь.
//   - Границы недели/непопадание заказа в два периода уже доказаны в
//     hqSettlementClosureStage13.test.js (S4). Перенос долга через
//     несколько периодов — там же (L1-L8). Не дублируются здесь.
//   - Этот файл добавляет то, чего не было: ОДНУ сквозную проводку через
//     РЕАЛЬНЫЙ жизненный цикл заказа (createOrderAndResolve -> markPaid ->
//     restaurantAccept -> restaurantAdvance x N -> confirmReceiptByCustomer,
//     БЕЗ SQL-обхода состояний) до РЕАЛЬНОГО закрытия периода и РЕАЛЬНОГО
//     подтверждения выплаты, с ручной сверкой сумм на каждом шаге
//     (задание Stage 37, раздел 5).
//   - Сценарий B (pickup) — earned_at на preparing->delivered, отдельная
//     дуга ADVANCE_MAP, ранее не была сведена с финансовым расчётом в одном
//     тесте.
//   - Сценарий F (payment_failed) — заказ никогда не должен появиться ни в
//     обороте, ни в комиссии, ни в earned_at.
//   - Сценарий G (earned-заказ с succeeded-возвратом) эмпирически доказан
//     НЕДОСТИЖИМЫМ в текущей архитектуре: cancelByCustomer/restaurantDecline/
//     sweepTimeouts — единственные пути к refund — все требуют
//     status IN ('awaiting_payment','awaiting_restaurant'), оба СТРОГО ДО
//     earned_at (earned_at ставится только на ready->courier/
//     preparing->delivered, Stage 33.1). Ниже это не только читается в коде,
//     но и проверяется вызовом cancelByCustomer() на уже доставленном
//     заказе — должен упасть.
//   - Сценарий H (settlement adjustment) — единственный существующий
//     механизм ("late_refund") уже покрыт L1-L8 в hqSettlementClosureStage13
//     .test.js; не дублируется здесь.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616',
};

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('stage37-financial-acceptance-mock');
});

after(async () => {
  await cluster.stop();
});

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const setupClient = cluster.getClient(name);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
  return cluster.connectionString(name);
}

function loadServices(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  const modulePaths = [
    require.resolve('../../db/postgresql'),
    require.resolve('../../services/postgresql/orderService.js'),
    require.resolve('../../services/hq/menuAdminService'),
    require.resolve('../../services/hq/restaurantFinanceService'),
    require.resolve('../../services/hq/settlementService'),
    require.resolve('../../services/hq/settlementAdjustmentService'),
    require.resolve('../../services/hq/restaurantBalanceService'),
    require.resolve('../../services/hq/payoutService'),
    require.resolve('../../services/hq/payoutStatusService'),
    require.resolve('../../services/hq/restaurantPayoutService'),
  ];
  for (const p of modulePaths) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    orderService: require('../../services/postgresql/orderService.js'),
    menuAdminService: require('../../services/hq/menuAdminService'),
    financeService: require('../../services/hq/restaurantFinanceService'),
    settlementService: require('../../services/hq/settlementService'),
    payoutService: require('../../services/hq/payoutService'),
    payoutStatusService: require('../../services/hq/payoutStatusService'),
  };
}

async function createRestaurant(db, name) {
  const rows = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}

async function seedMenuItem(menuAdminService, restaurantId, price) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Блюдо', category_id: String(category.id), price: String(price) });
}

async function seedYaamBankDetails(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО ЯАМ Платформа','7709123453','770101001',$1,$2,'ТЕСТБАНК',$3) ON CONFLICT (id) DO NOTHING`,
    [FICT.RS, FICT.BIK, FICT.KS],
  );
}

// Реквизиты + подписанный договор — обязательны для prepareRestaurantPayout/
// confirmManualBankTransfer (buildAndInsertAttemptRequisites требует все
// три). commissionBps передаётся явно (не 700-fallback), чтобы проводка
// доказывала именно ЖИВОЕ подключение resolveCommissionBps() к договору, а
// не только fallback-путь (тот отдельно доказан в
// resolveCommissionBpsStage7.test.js).
async function seedPayoutReadiness(db, restaurantId, commissionBps) {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip','ИП Тестов Т. Т.',$2,'312770012345008','г. Грозный, ул. Т, 1','Тестов Т. Т.','+79280000001')`,
    [restaurantId, FICT.INN12],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, default_payment_purpose)
     VALUES ($1,'ИП Тестов Т. Т.',$2,'',$3,$4,'ТЕСТБАНК',$5,'Оплата услуг доставки')`,
    [restaurantId, FICT.INN12, FICT.RS, FICT.BIK, FICT.KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status, commission_bps)
     VALUES ($1,'ДЗ-STAGE37','2026-01-01','signed',$2)`,
    [restaurantId, commissionBps],
  );
}

function uniquePhone() {
  return `+7901${String(crypto.randomInt(1000000, 9999999))}`;
}

// Широкое, но однозначное окно — вчера..послезавтра — не завязано на точное
// "сегодня", чтобы тест не был хрупким к границе суток по UTC/Москве (earned_at
// пишется NOW() в момент выполнения теста).
function widePeriodBounds() {
  const pad = (n) => String(n).padStart(2, '0');
  const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return { periodFrom: toDateStr(from), periodTo: toDateStr(to) };
}

// ---------------------------------------------------------------------------
// A. Сценарий "успешная доставка" — от создания до "Выплачено", ручная сверка
// ---------------------------------------------------------------------------
test('A: полная сквозная проводка одного заказа доставки — заказ -> комиссия -> earned_at -> закрытие периода -> выплата', async () => {
  const databaseUrl = await freshDatabase('stage37_a_delivery');
  const { db, orderService, menuAdminService, financeService, settlementService, payoutService, payoutStatusService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'Stage37 Доставка');
    await seedYaamBankDetails(db);
    // 6.5% — намеренно НЕ дефолтный fallback (7%), чтобы доказать именно
    // живое подключение resolveCommissionBps() к подписанному договору.
    await seedPayoutReadiness(db, restaurantId, 650);
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 1247); // контрольная сумма из Task #35

    const payload = {
      restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
      address: 'ул. Проводочная, 1', comment: '', fulfillmentType: 'delivery',
      items: [{ menuItemId: menuItem.id, name: 'Блюдо', price: 0, qty: 1 }],
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    };
    const { order } = await orderService.createOrderAndResolve(payload);

    // РУЧНАЯ СВЕРКА 1 — фиксация на создании. Stage 38: items_total/
    // commission_amount теперь integer minor units — 1247 ₽ = 124700 minor,
    // комиссия 6.5% считается с точностью до копейки (тот же контрольный
    // пример, что и в итоговом отчёте Stage 38: 124700×650/10000=8105.5 ->
    // round -> 8106 minor = 81,06 ₽).
    const created = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(created.items_total, 124700);
    assert.equal(created.commission_amount, Math.round(124700 * 650 / 10000)); // 8106
    assert.equal(created.commission_amount, 8106);
    assert.equal(created.earned_at, null, 'ещё не earned — заказ даже не оплачен');

    const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]))[0];
    await orderService.markPaid(order.id, paymentRow.id);
    await orderService.restaurantAccept(order.id);
    await orderService.restaurantAdvance(order.id, 'preparing');
    await orderService.restaurantAdvance(order.id, 'ready');
    await orderService.restaurantAdvance(order.id, 'courier'); // Stage 33.1 — earned_at фиксируется ЗДЕСЬ для delivery

    const afterCourier = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(afterCourier.status, 'courier');
    assert.ok(afterCourier.earned_at, 'earned_at должен быть зафиксирован на ready->courier');

    await orderService.confirmReceiptByCustomer(order.id);
    const delivered = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.earned_at.getTime(), afterCourier.earned_at.getTime(), 'delivered не должен переписывать earned_at, зафиксированный на courier');

    // РУЧНАЯ СВЕРКА 2 — G эмпирически недостижим: попытка отменить уже
    // доставленный (earned) заказ путём клиента должна быть отвергнута тем
    // же кодом, который создаёт единственный реальный refund-путь.
    await assert.rejects(() => orderService.cancelByCustomer(order.id), /заказ уже готовится/);

    // РУЧНАЯ СВЕРКА 3 — live-позиция (restaurantFinanceService), turnover=commission+earnings.
    // 124700 − 8106 = 116594 minor (1165,94 ₽) — тот же контрольный пример,
    // что и в итоговом отчёте Stage 38.
    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.turnover, 124700);
    assert.equal(position.commission, 8106);
    assert.equal(position.restaurantEarnings, 116594);
    assert.equal(position.turnover, position.commission + position.restaurantEarnings);
    assert.equal(position.deliveredPaidOrders, 1);

    // РУЧНАЯ СВЕРКА 4 — закрытие периода, immutable snapshot.
    const { periodFrom, periodTo } = widePeriodBounds();
    const draft = await settlementService.createDraftSettlementPeriod({ periodFrom, periodTo });
    const closed = await settlementService.closeSettlementPeriod(draft.id);
    assert.equal(closed.alreadyClosed, false);
    const line = closed.lines.find((l) => l.restaurant_id === restaurantId);
    assert.equal(line.turnover, 124700);
    assert.equal(line.yaam_commission, 8106);
    assert.equal(line.restaurant_earnings, 116594);
    assert.equal(line.payable_amount, 116594, 'нет долга и нет поздних возвратов — к выплате равно заработку');
    assert.equal(line.refund_adjustment_restaurant_amount, 0);
    assert.equal(line.carry_forward_applied, 0);

    const orderLine = (await db.query(
      'SELECT * FROM settlement_order_lines WHERE settlement_period_id = $1 AND order_id = $2',
      [draft.id, order.id],
    ))[0];
    assert.equal(orderLine.items_total_snapshot, 124700);
    assert.equal(orderLine.commission_amount_snapshot, 8106);
    assert.equal(orderLine.restaurant_amount_snapshot, 116594);

    // Идемпотентность закрытия — повторный вызов не дублирует строки.
    const closedAgain = await settlementService.closeSettlementPeriod(draft.id);
    assert.equal(closedAgain.alreadyClosed, true);
    const lineCountRows = await db.query(
      'SELECT COUNT(*)::int AS c FROM settlement_restaurant_lines WHERE settlement_period_id = $1 AND restaurant_id = $2',
      [draft.id, restaurantId],
    );
    assert.equal(lineCountRows[0].c, 1, 'повторное закрытие не должно создать вторую строку обязательства');

    // РУЧНАЯ СВЕРКА 5 — выплата, до "Выплачено".
    const payout = await payoutService.prepareRestaurantPayout(draft.id, restaurantId);
    assert.equal(payout.amount, 116594);
    const confirmed = await payoutService.confirmManualBankTransfer(payout.id, {
      operationReference: 'TEST-STAGE37-A-001', paidAt: new Date(), confirmedBy: 'stage37-test',
    });
    assert.equal(confirmed.payout.status, 'succeeded');
    assert.equal(confirmed.payout.amount, 116594);

    // РУЧНАЯ СВЕРКА 6 — то, что реально видит владелец на "Финансы"
    // (payoutStatusService, НЕ мёртвый payableBalance) отражает "Выплачено".
    const statuses = await payoutStatusService.listPayoutStatuses();
    const row = statuses.find((s) => s.restaurantId === restaurantId);
    assert.equal(row.status, 'paid');
    assert.equal(row.amount, 116594);

    // Инвариант-проверки трёх слоёв не находят расхождений после полного цикла.
    const finInv = await financeService.checkFinancialInvariants();
    assert.deepEqual(finInv.violations, []);
    const setInv = await settlementService.checkSettlementInvariants();
    assert.deepEqual(setInv.violations, []);
    const payInv = await payoutService.checkPayoutInvariants();
    assert.deepEqual(payInv.violations, []);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// B. Сценарий "успешный самовывоз" — earned_at на preparing->delivered
// ---------------------------------------------------------------------------
test('B: заказ самовывоза — earned_at фиксируется на preparing->delivered (не на courier — курьера нет)', async () => {
  const databaseUrl = await freshDatabase('stage37_b_pickup');
  const { db, orderService, menuAdminService, financeService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'Stage37 Самовывоз');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 999); // контрольная сумма из Task #35

    const payload = {
      restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
      address: 'самовывоз', comment: '', fulfillmentType: 'pickup',
      items: [{ menuItemId: menuItem.id, name: 'Блюдо', price: 0, qty: 1 }],
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    };
    const { order } = await orderService.createOrderAndResolve(payload);
    // Нет подписанного договора — fallback 700 bps (7%). Stage 38: 999 ₽ =
    // 99900 minor, комиссия с точностью до копейки: round(99900*700/10000)
    // = round(6993) = 6993 minor (точно 69,93 ₽, без остатка округления).
    const created = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(created.commission_amount, Math.round(99900 * 700 / 10000)); // 6993
    assert.equal(created.commission_amount, 6993);

    const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]))[0];
    await orderService.markPaid(order.id, paymentRow.id);
    await orderService.restaurantAccept(order.id);
    await orderService.restaurantAdvance(order.id, 'preparing');

    const beforeDelivered = (await db.query('SELECT earned_at, status FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(beforeDelivered.status, 'preparing');
    assert.equal(beforeDelivered.earned_at, null, 'pickup: earned_at не должен появляться раньше preparing->delivered');

    await orderService.restaurantAdvance(order.id, 'delivered'); // pickup: preparing -> delivered напрямую (ADVANCE_MAP)
    const after = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(after.status, 'delivered');
    assert.ok(after.earned_at, 'pickup: earned_at должен зафиксироваться на preparing->delivered');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.turnover, 99900);
    assert.equal(position.commission, 6993);
    assert.equal(position.restaurantEarnings, 92907);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ---------------------------------------------------------------------------
// F. Сценарий "оплата не прошла" — заказ никогда не входит в финансы
// ---------------------------------------------------------------------------
test('F: payment_failed — заказ не получает earned_at и не входит ни в оборот, ни в комиссию', async () => {
  const databaseUrl = await freshDatabase('stage37_f_payment_failed');
  const { db, orderService, menuAdminService, financeService } = loadServices(databaseUrl);
  try {
    const restaurantId = await createRestaurant(db, 'Stage37 ОтказОплаты');
    const menuItem = await seedMenuItem(menuAdminService, restaurantId, 500);

    const payload = {
      restaurantId, city: 'Грозный', customerName: 'Клиент', customerPhone: uniquePhone(),
      address: 'ул. Т, 1', comment: '', fulfillmentType: 'delivery',
      items: [{ menuItemId: menuItem.id, name: 'Блюдо', price: 0, qty: 1 }],
      orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
      createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
    };
    const { order } = await orderService.createOrderAndResolve(payload);
    const paymentRow = (await db.query(`SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [order.id]))[0];

    await orderService.markPaymentFailed(order.id, paymentRow.id);

    const after = (await db.query('SELECT * FROM orders WHERE id = $1', [order.id]))[0];
    assert.equal(after.status, 'payment_failed');
    assert.equal(after.earned_at, null);
    const paymentAfter = (await db.query('SELECT status FROM payments WHERE id = $1', [paymentRow.id]))[0];
    assert.equal(paymentAfter.status, 'failed');

    const position = await financeService.getRestaurantFinancialPosition(restaurantId);
    assert.equal(position.turnover, 0);
    assert.equal(position.commission, 0);
    assert.equal(position.restaurantEarnings, 0);
    assert.equal(position.deliveredPaidOrders, 0);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
