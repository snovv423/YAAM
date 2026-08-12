'use strict';

// YAAM HQ Stage 13 — точечное завершение: расписание, перенос долга,
// capability-доступ к документам, пакетный catch-up.
//
// S — расписание: понедельник 07:00 МСК сразу после недели.
// L — перенос отрицательного остатка (ledger, carry-forward).
// T — capability-токены документов.
// K — catch-up пакетами после длительного простоя.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/hq/settlementService.js'),
  require.resolve('../../services/hq/weeklySettlementService.js'),
  require.resolve('../../services/hq/settlementDocumentService.js'),
  require.resolve('../../services/hq/settlementNotificationService.js'),
  require.resolve('../../services/hq/settlementDocumentAccessService.js'),
  require.resolve('../../services/hq/settlementAdjustmentService.js'),
  require.resolve('../../services/hq/restaurantBalanceService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/postgresql/settlementDocuments.js'),
];

const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616', INN10: '7709123453', KPP: '770101001', OGRNIP: '312770012345008',
};

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('hq-settle-closure'); });
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}

function requireFresh() {
  for (const p of MODULE_PATHS) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    weekly: require('../../services/hq/weeklySettlementService'),
    settlementService: require('../../services/hq/settlementService'),
    documentService: require('../../services/hq/settlementDocumentService'),
    notificationService: require('../../services/hq/settlementNotificationService'),
    accessService: require('../../services/hq/settlementDocumentAccessService'),
    balanceService: require('../../services/hq/restaurantBalanceService'),
  };
}

function msk(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 180 * 60 * 1000);
}
function dstr(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

async function createRestaurant(db, name) {
  const r = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return r.rows[0].id;
}

let counter = 0;
async function order(db, restaurantId, { itemsTotal, commissionAmount, deliveredAt }) {
  counter += 1;
  const code = `YAAM-C${String(counter).padStart(4, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // эта фикстура всегда создаёт 'delivered' напрямую SQL, поэтому earned_at
  // безусловно равен тому же deliveredAt, что и status_updated_at (тот же
  // принцип, что и backfill в миграции 0013).
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Иса Магомадов',$3,'ул. Тестовая, 5','',$4,$5,'delivered',$6,$6) RETURNING id`,
    [code, restaurantId, `+7902${String(counter).padStart(7, '0')}`, itemsTotal, commissionAmount, deliveredAt],
  );
  const p = await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`,
    [o.rows[0].id, itemsTotal],
  );
  return { orderId: o.rows[0].id, paymentId: p.rows[0].id, code };
}

async function refund(db, paymentId, amount, completedAt) {
  const r = await db.execute(
    `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,'mock',$2,'succeeded','customer_cancel',$3,$4) RETURNING id`,
    [paymentId, amount, `ck-${paymentId}-${Math.random().toString(36).slice(2)}`, completedAt],
  );
  return r.rows[0].id;
}

async function seedYaam(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО ЯАМ Платформа',$1,$2,$3,$4,'ТЕСТБАНК',$5) ON CONFLICT (id) DO NOTHING`,
    [FICT.INN10, FICT.KPP, FICT.RS, FICT.BIK, FICT.KS],
  );
}
async function seedLegal(db, restaurantId, legalName = 'ИП Закрытов З. З.') {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip',$2,$3,$4,'г. Грозный, ул. Тестовая, 1','Закрытов З. З.','+79280000003')`,
    [restaurantId, legalName, FICT.INN12, FICT.OGRNIP],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik, bank_name,
        correspondent_account, default_payment_purpose)
     VALUES ($1,$2,$3,'',$4,$5,'ТЕСТБАНК',$6,'Оплата услуг')`,
    [restaurantId, legalName, FICT.INN12, FICT.RS, FICT.BIK, FICT.KS],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1,$2,'2026-01-01','signed')`,
    [restaurantId, `ДЗ-${restaurantId}`],
  );
}

// ===========================================================================
// S — расписание закрытия
// ===========================================================================

test('S1: неделя закрывается в понедельник 07:00 МСК сразу после неё, а не через 7 суток', async () => {
  const { weekly } = requireFresh();
  assert.equal(weekly.SETTLEMENT_WEEKDAY, 1, 'понедельник');
  assert.equal(weekly.SETTLEMENT_HOUR, 7);

  // Неделя 27.07(пн) — 02.08(вс) закрывается 03.08(пн) 07:00 МСК.
  const closeAt = weekly.scheduledCloseAt('2026-08-02');
  assert.equal(closeAt.toISOString(), msk(2026, 8, 3, 7, 0).toISOString());

  // Разрыв между концом недели и закрытием — ровно 7 часов, не неделя.
  const weekEnd = msk(2026, 8, 3, 0, 0); // начало пн = конец вс
  assert.equal(closeAt.getTime() - weekEnd.getTime(), 7 * 60 * 60 * 1000);
});

test('S2: воскресные моменты принадлежат заканчивающейся неделе, понедельник 00:00 — новой', async () => {
  const { weekly } = requireFresh();
  // Все воскресные моменты 02.08 — внутри недели 27.07..02.08, значит
  // «последняя завершившаяся» для них ещё предыдущая неделя.
  for (const t of [
    msk(2026, 8, 2, 6, 59), msk(2026, 8, 2, 7, 0),
    msk(2026, 8, 2, 20, 0), msk(2026, 8, 2, 23, 59, 59, 999),
  ]) {
    assert.deepEqual(
      weekly.lastCompletedWeek(t),
      { periodFrom: '2026-07-20', periodTo: '2026-07-26' },
      `вс ${t.toISOString()} ещё внутри своей недели`,
    );
  }
  // Понедельник 00:00 — новая неделя, предыдущая завершилась.
  assert.deepEqual(
    weekly.lastCompletedWeek(msk(2026, 8, 3, 0, 0)),
    { periodFrom: '2026-07-27', periodTo: '2026-08-02' },
  );
});

test('S3: в понедельник 06:59 неделя ещё не подлежит закрытию, в 07:00 — подлежит', async () => {
  const databaseUrl = await freshDatabase('closure_s3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Расписание');
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });

  const early = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 6, 59), generateDocuments: false });
  assert.equal(early.closed.length, 0, 'в пн 06:59 закрывать нечего');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM settlement_periods'))[0].n, 0);

  const onTime = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  assert.equal(onTime.closed.length, 1, 'в пн 07:00 неделя закрывается');
  assert.equal(onTime.closed[0].periodFrom, '2026-07-27');
  assert.equal(onTime.closed[0].periodTo, '2026-08-02');
  await db.close();
});

test('S4: заказы на границах недели не теряются и не попадают в два периода', async () => {
  const databaseUrl = await freshDatabase('closure_s4');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Границы');
  await seedYaam(db);
  await seedLegal(db, restId);

  await order(db, restId, { itemsTotal: 100, commissionAmount: 7, deliveredAt: msk(2026, 8, 2, 6, 59) });
  await order(db, restId, { itemsTotal: 200, commissionAmount: 14, deliveredAt: msk(2026, 8, 2, 7, 0) });
  await order(db, restId, { itemsTotal: 400, commissionAmount: 28, deliveredAt: msk(2026, 8, 2, 20, 0) });
  await order(db, restId, { itemsTotal: 800, commissionAmount: 56, deliveredAt: msk(2026, 8, 2, 23, 59, 59, 999) });
  await order(db, restId, { itemsTotal: 1600, commissionAmount: 112, deliveredAt: msk(2026, 8, 3, 0, 0) });

  // Понедельник 10.08 07:00 — обе недели уже закрыты по расписанию.
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const w1 = periods.find((p) => dstr(p.period_from) === '2026-07-27');
  const w2 = periods.find((p) => dstr(p.period_from) === '2026-08-03');
  assert.ok(w1 && w2);

  const l1 = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [w1.id]))[0];
  const l2 = (await db.query('SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [w2.id]))[0];
  // 100 + 200 + 400 + 800 = 1500 — все четыре воскресных заказа.
  assert.equal(l1.turnover, 1500);
  assert.equal(l1.delivered_paid_orders, 4);
  assert.equal(l2.turnover, 1600);
  assert.equal(l2.delivered_paid_orders, 1);

  // Ни один заказ не потерян и ни один не учтён дважды.
  const total = await db.query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT order_id)::int AS d FROM settlement_order_lines');
  assert.equal(total[0].n, 5);
  assert.equal(total[0].d, 5);
  await db.close();
});

// ===========================================================================
// L — перенос отрицательного остатка
// ===========================================================================

test('L1: арифметика переноса — чистая функция, разобранная по случаям', async () => {
  const { balanceService } = requireFresh();
  const f = balanceService.computeCarryForward;

  // Долга нет, обычный период.
  assert.deepEqual(f({ netEarnings: 1000, openingDebt: 0 }),
    { debtSettled: 0, debtAccrued: 0, payable: 1000, closingDebt: 0 });
  // Период ушёл в минус — появился долг, платить нечего.
  assert.deepEqual(f({ netEarnings: -930, openingDebt: 0 }),
    { debtSettled: 0, debtAccrued: 930, payable: 0, closingDebt: 930 });
  // Пример задания, шаг 1: долг 930, начислено 500.
  assert.deepEqual(f({ netEarnings: 500, openingDebt: 930 }),
    { debtSettled: 500, debtAccrued: 0, payable: 0, closingDebt: 430 });
  // Пример задания, шаг 2: долг 430, начислено 1000.
  assert.deepEqual(f({ netEarnings: 1000, openingDebt: 430 }),
    { debtSettled: 430, debtAccrued: 0, payable: 570, closingDebt: 0 });
  // Долг есть И период снова в минусе — долг растёт.
  assert.deepEqual(f({ netEarnings: -200, openingDebt: 430 }),
    { debtSettled: 0, debtAccrued: 200, payable: 0, closingDebt: 630 });
  // Ровное погашение.
  assert.deepEqual(f({ netEarnings: 430, openingDebt: 430 }),
    { debtSettled: 430, debtAccrued: 0, payable: 0, closingDebt: 0 });
});

test('L2: долг переносится через несколько периодов и гасится частями (сценарий задания)', async () => {
  const databaseUrl = await freshDatabase('closure_l2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, balanceService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Долг');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Неделя 1 (27.07–02.08): заказ 1000/70 -> ресторану 930. Закрыта 03.08.
  const first = await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });

  // Неделя 2 (03.08–09.08): продаж нет, приходит полный возврат по заказу
  // недели 1 -> долг 930.
  await refund(db, first.paymentId, 1000, msk(2026, 8, 5, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });
  assert.equal(await balanceService.getDebt(restId), 930, 'долг зафиксирован');

  // Неделя 3 (10.08–16.08): начислено 500 (заказ 538/38 -> 500).
  await order(db, restId, { itemsTotal: 538, commissionAmount: 38, deliveredAt: msk(2026, 8, 12, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: false });
  assert.equal(await balanceService.getDebt(restId), 430, 'остаток долга 430');

  // Неделя 4 (17.08–23.08): начислено 1000 (заказ 1075/75 -> 1000).
  await order(db, restId, { itemsTotal: 1075, commissionAmount: 75, deliveredAt: msk(2026, 8, 19, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 24, 7, 0), generateDocuments: false });
  assert.equal(await balanceService.getDebt(restId), 0, 'долг погашен');

  const lines = await db.query(
    `SELECT sp.period_from, l.restaurant_earnings, l.refund_adjustment_restaurant_amount,
            l.carry_forward_applied, l.carry_forward_remaining, l.payable_amount, l.payout_blocked_reason
       FROM settlement_restaurant_lines l
       JOIN settlement_periods sp ON sp.id = l.settlement_period_id
      ORDER BY sp.period_from`,
  );

  const byWeek = Object.fromEntries(lines.map((l) => [dstr(l.period_from), l]));

  // Неделя 2: долг начислен, платить нечего.
  assert.equal(byWeek['2026-08-03'].carry_forward_remaining, 930);
  assert.equal(byWeek['2026-08-03'].payable_amount, 0);
  assert.equal(byWeek['2026-08-03'].payout_blocked_reason, 'outstanding_debt');

  // Неделя 3: начислено 500, удержано 500, к выплате 0, остаток 430.
  assert.equal(byWeek['2026-08-10'].restaurant_earnings, 500);
  assert.equal(byWeek['2026-08-10'].carry_forward_applied, 500);
  assert.equal(byWeek['2026-08-10'].payable_amount, 0);
  assert.equal(byWeek['2026-08-10'].carry_forward_remaining, 430);
  assert.equal(byWeek['2026-08-10'].payout_blocked_reason, 'outstanding_debt');

  // Неделя 4: начислено 1000, удержано 430, к выплате 570, долга нет.
  assert.equal(byWeek['2026-08-17'].restaurant_earnings, 1000);
  assert.equal(byWeek['2026-08-17'].carry_forward_applied, 430);
  assert.equal(byWeek['2026-08-17'].payable_amount, 570);
  assert.equal(byWeek['2026-08-17'].carry_forward_remaining, 0);
  assert.equal(byWeek['2026-08-17'].payout_blocked_reason, null);
  const carryAudit = await db.query(
    `SELECT action, details FROM hq_audit_log
      WHERE action IN ('settlement_carry_forward_applied','settlement_carry_forward_accrued')
      ORDER BY id`,
  );
  assert.ok(carryAudit.some((r) => r.action === 'settlement_carry_forward_accrued'
    && /начислен долг 9,30 ₽, итого долг 9,30 ₽/.test(r.details)));
  assert.ok(carryAudit.some((r) => r.action === 'settlement_carry_forward_applied'
    && /удержано 5 ₽ долга прошлых периодов, остаток долга 4,30 ₽/.test(r.details)));
  await db.close();
});

test('L3: ledger хранит каждую проводку и один долг нельзя удержать дважды', async () => {
  const databaseUrl = await freshDatabase('closure_l3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, balanceService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Проводки');
  await seedYaam(db);
  await seedLegal(db, restId);

  const first = await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  await refund(db, first.paymentId, 1000, msk(2026, 8, 5, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });
  await order(db, restId, { itemsTotal: 538, commissionAmount: 38, deliveredAt: msk(2026, 8, 12, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: false });

  const entries = await balanceService.listEntries(restId);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'debt_accrued');
  assert.equal(entries[0].amount, 930);
  assert.equal(entries[0].balance_after, 930);
  assert.equal(entries[1].kind, 'debt_settled');
  assert.equal(entries[1].amount, 500);
  assert.equal(entries[1].balance_after, 430);

  // Проводка неизменяема.
  await assert.rejects(
    () => db.execute('UPDATE restaurant_balance_entries SET amount = 1 WHERE id = $1', [entries[0].id]),
    /immutable/i,
  );
  // Один и тот же период не может повторно удержать долг.
  await assert.rejects(
    () => db.execute(
      `INSERT INTO restaurant_balance_entries (restaurant_id, settlement_period_id, kind, amount, balance_after)
       VALUES ($1,$2,'debt_settled',500,430)`,
      [restId, entries[1].settlement_period_id],
    ),
    /duplicate key|unique/i,
  );
  await db.close();
});

test('L4: повторное закрытие периода идемпотентно и не удерживает долг второй раз', async () => {
  const databaseUrl = await freshDatabase('closure_l4');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, balanceService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Идемпотентность');
  await seedYaam(db);
  await seedLegal(db, restId);

  const first = await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  await refund(db, first.paymentId, 1000, msk(2026, 8, 5, 12, 0));
  await order(db, restId, { itemsTotal: 538, commissionAmount: 38, deliveredAt: msk(2026, 8, 6, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });

  const debtAfterFirst = await balanceService.getDebt(restId);
  const entriesAfterFirst = (await balanceService.listEntries(restId)).length;

  // Тот же job ещё дважды: периоды уже закрыты, работы быть не должно.
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 5), generateDocuments: false });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 8, 0), generateDocuments: false });

  assert.equal(await balanceService.getDebt(restId), debtAfterFirst, 'долг не изменился');
  assert.equal((await balanceService.listEntries(restId)).length, entriesAfterFirst, 'новых проводок нет');
  await db.close();
});

test('L5: конкурентные запуски job не создают дублей периодов и не удваивают удержание', async () => {
  const databaseUrl = await freshDatabase('closure_l5');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, balanceService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Гонка');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Сначала последовательно доводим ресторан до состояния «есть долг 930»:
  // именно ПОГАШЕНИЕ долга — та операция, которую конкурентность могла бы
  // применить дважды, поэтому гонку устраиваем ровно на ней.
  const first = await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  await refund(db, first.paymentId, 1000, msk(2026, 8, 5, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });
  assert.equal(await balanceService.getDebt(restId), 930);

  // Неделя с начислением 500 закрывается тремя одновременными запусками.
  await order(db, restId, { itemsTotal: 538, commissionAmount: 38, deliveredAt: msk(2026, 8, 12, 12, 0) });
  const now = msk(2026, 8, 17, 7, 0);
  await Promise.all([
    weekly.runWeeklySettlementJob({ now, generateDocuments: false }),
    weekly.runWeeklySettlementJob({ now, generateDocuments: false }),
    weekly.runWeeklySettlementJob({ now, generateDocuments: false }),
  ]);

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  assert.equal(periods.length, 3, 'ровно три периода, без дублей');
  const entries = await balanceService.listEntries(restId);
  const settled = entries.filter((e) => e.kind === 'debt_settled');
  assert.equal(settled.length, 1, 'удержание применено ровно один раз');
  assert.equal(settled[0].amount, 500);
  assert.equal(await balanceService.getDebt(restId), 430, 'долг уменьшен ровно на 500, не на 1000');
  await db.close();
});

test('L6: выплата запрещена при непогашенном долге и при нулевой сумме', async () => {
  const databaseUrl = await freshDatabase('closure_l6');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Запрет');
  await seedYaam(db);
  await seedLegal(db, restId);

  const first = await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  await refund(db, first.paymentId, 1000, msk(2026, 8, 5, 12, 0));
  await order(db, restId, { itemsTotal: 538, commissionAmount: 38, deliveredAt: msk(2026, 8, 6, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });

  const lines = await db.query(
    `SELECT l.*, sp.period_from FROM settlement_restaurant_lines l
       JOIN settlement_periods sp ON sp.id = l.settlement_period_id ORDER BY sp.period_from`,
  );
  // Период с непогашенным долгом.
  const blocked = lines.find((l) => l.carry_forward_remaining > 0);
  assert.ok(blocked);
  assert.equal(blocked.payout_blocked_reason, 'outstanding_debt');
  assert.equal(blocked.payable_amount, 0);
  // Ни одна строка с долгом не имеет положительной суммы к выплате.
  for (const l of lines) {
    if (l.carry_forward_remaining > 0) assert.equal(l.payable_amount, 0);
    if (l.payable_amount <= 0) assert.ok(l.payout_blocked_reason);
  }
  await db.close();
});

test('L7: перенос виден в документе и в UI отдельными строками', async () => {
  const databaseUrl = await freshDatabase('closure_l7');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Документ');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Stage 38 — эта фикстура пишет orders.items_total/commission_amount и
  // refunds.amount НАПРЯМУЮ SQL (в обход createOrder(), которая одна умеет
  // переводить рубли в minor units) — поэтому сама передаёт уже integer
  // minor units: 1000 ₽ = 100000, 70 ₽ = 7000, 1075 ₽ = 107500, 75 ₽ = 7500.
  const first = await order(db, restId, { itemsTotal: 100000, commissionAmount: 7000, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  await refund(db, first.paymentId, 100000, msk(2026, 8, 5, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: true });
  await order(db, restId, { itemsTotal: 107500, commissionAmount: 7500, deliveredAt: msk(2026, 8, 12, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: true });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const week3 = periods.find((p) => dstr(p.period_from) === '2026-08-10');
  const docs = await documentService.listDocumentsForPeriod(week3.id);
  const report = docs.find((d) => d.kind === 'agent_report');
  const t = report.payload.totals;
  await db.close();

  // Начислено 1000 ₽ (100000 minor), удержано 930 ₽ (93000 minor) в счёт
  // долга, к выплате 70 ₽ (7000 minor).
  assert.equal(t.carryForwardApplied, 93000);
  assert.equal(t.carryForwardRemaining, 0);
  assert.equal(t.payableAmount, 7000);
  // Столбец документа сходится: 107500 − 7500 − 93000 = 7000.
  assert.equal(t.sales - t.commissionAmount - t.adjustmentRestaurantAmount - t.carryForwardApplied, t.payableAmount);

  const { renderDocument } = require('../../hq/settlementDocumentViews');
  const html = renderDocument(report);
  assert.match(html, /Удержано в счёт долга прошлых периодов/);
  assert.match(html, /−930 ₽/);
});

test('L8: старые snapshot-строки не переписываются при переносе долга', async () => {
  const databaseUrl = await freshDatabase('closure_l8');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Неизменность');
  await seedYaam(db);
  await seedLegal(db, restId);

  const first = await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });

  const before = (await db.query(
    'SELECT * FROM settlement_restaurant_lines ORDER BY id'))[0];

  await refund(db, first.paymentId, 1000, msk(2026, 8, 5, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });

  const after = (await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE id = $1', [before.id]))[0];
  assert.deepEqual(after, before, 'строка закрытого периода не изменилась ни в одном поле');
  await db.close();
});

// ===========================================================================
// T — capability-доступ к документам
// ===========================================================================

test('T1: валидный токен открывает свой документ; чужой документ через него недоступен', async () => {
  const databaseUrl = await freshDatabase('closure_t1');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, accessService, documentService } = requireFresh();
  const r1 = await createRestaurant(db, 'Кафе Один');
  const r2 = await createRestaurant(db, 'Кафе Два');
  await seedYaam(db);
  await seedLegal(db, r1, 'ИП Один');
  await seedLegal(db, r2, 'ИП Два');
  await order(db, r1, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await order(db, r2, { itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 7, 30, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });

  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const docs = await documentService.listDocumentsForPeriod(periodId);
  const doc1 = docs.find((d) => d.restaurant_id === r1 && d.kind === 'agent_report');
  const doc2 = docs.find((d) => d.restaurant_id === r2 && d.kind === 'agent_report');

  const issued = await accessService.issueToken(doc1.id);
  assert.ok(issued.token.startsWith(accessService.TOKEN_PREFIX));

  const resolved = await accessService.resolveToken(issued.token);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.document.id, doc1.id);
  // Токен даёт ровно один документ — второй через него не открыть.
  assert.notEqual(resolved.document.id, doc2.id);
  assert.equal(resolved.restaurantId, r1);
  await db.close();
});

test('T2: invalid / expired / revoked отвечают различимо и не открывают документ', async () => {
  const databaseUrl = await freshDatabase('closure_t2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, accessService, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Токен');
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const doc = (await documentService.listDocumentsForPeriod(periodId))[0];

  // Неверный формат.
  assert.deepEqual(await accessService.resolveToken('мусор'), { ok: false, reason: 'invalid_format' });
  // Формально валидный, но несуществующий.
  const fake = accessService.generateToken();
  assert.deepEqual(await accessService.resolveToken(fake), { ok: false, reason: 'not_found' });

  // Просроченный.
  const shortLived = await accessService.issueToken(doc.id, { ttlMs: 1000 });
  const later = new Date(Date.now() + 5000);
  const expired = await accessService.resolveToken(shortLived.token, { now: later });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');

  // Отозванный.
  const revocable = await accessService.issueToken(doc.id);
  assert.deepEqual(await accessService.revokeToken(revocable.tokenId), { revoked: true });
  const revoked = await accessService.resolveToken(revocable.token);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'revoked');
  // Повторный отзыв идемпотентен.
  assert.deepEqual(await accessService.revokeToken(revocable.tokenId), { revoked: false });
  await db.close();
});

test('T3: в БД лежит только hash — plaintext токена нигде не хранится', async () => {
  const databaseUrl = await freshDatabase('closure_t3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, accessService, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Хэш');
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const doc = (await documentService.listDocumentsForPeriod(periodId))[0];

  const issued = await accessService.issueToken(doc.id);
  const rows = await db.query('SELECT * FROM settlement_document_access_tokens WHERE id = $1', [issued.tokenId]);
  const stored = rows[0];

  assert.equal(stored.token_hash.length, 32, 'хранится sha256, а не текст');
  assert.deepEqual(stored.token_hash, accessService.hashToken(issued.token));
  // Ни одна текстовая колонка строки не содержит сам токен.
  for (const [key, v] of Object.entries(stored)) {
    if (typeof v === 'string') {
      assert.ok(!v.includes(issued.token), `колонка ${key} не должна содержать plaintext-токен`);
    }
  }
  // И аудит тоже: события ссылаются на id, не на секрет.
  const audit = await db.query("SELECT details FROM hq_audit_log WHERE action LIKE 'settlement_document_token%'");
  for (const a of audit) {
    assert.ok(!String(a.details).includes(issued.token), 'токен не должен попадать в аудит');
  }
  await db.close();
});

test('T4: создание, использование и отзыв токена попадают в аудит', async () => {
  const databaseUrl = await freshDatabase('closure_t4');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, accessService, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Аудит');
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const doc = (await documentService.listDocumentsForPeriod(periodId))[0];

  const issued = await accessService.issueToken(doc.id);
  await accessService.resolveToken(issued.token);
  await accessService.revokeToken(issued.tokenId);
  await accessService.resolveToken(issued.token); // отклонён

  const actions = (await db.query(
    "SELECT action FROM hq_audit_log WHERE action LIKE 'settlement_document_token%' ORDER BY id"))
    .map((r) => r.action);
  assert.deepEqual(actions, [
    'settlement_document_token_issued',
    'settlement_document_token_used',
    'settlement_document_token_revoked',
    'settlement_document_token_rejected',
  ]);
  await db.close();
});

test('T5: Telegram отправляет только capability-ссылки и не обещает выплату при prepared', async () => {
  const databaseUrl = await freshDatabase('closure_t5');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, notificationService, accessService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Телеграм');
  await seedYaam(db);
  await seedLegal(db, restId);
  await db.execute('UPDATE restaurants SET telegram_chat_id = $1 WHERE id = $2', ['-1003333333', restId]);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;

  const sent = [];
  const bot = { sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } };

  // 1. Уведомление о документах — БЕЗ обещания выплаты.
  const docsResult = await notificationService.notifyRestaurantAboutDocuments(periodId, restId, {
    bot, publicBaseUrl: 'https://api-pg.yaam.su',
  });
  assert.equal(docsResult.sent, true);
  assert.doesNotMatch(sent[0].text, /Перечислено|перечислен/i, 'до выплаты о ней не сообщается');
  const urls = sent[0].opts.reply_markup.inline_keyboard[0].map((b) => b.url);
  for (const u of urls) {
    assert.match(u, /\/d\/yaam_doc_v1_/, 'только capability-ссылка');
    assert.doesNotMatch(u, /\/hq\//, 'HQ-ссылок быть не может');
  }
  // Ссылка действительно рабочая и ведёт на документ этого ресторана.
  const token = urls[0].split('/d/')[1];
  const resolved = await accessService.resolveToken(token);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.restaurantId, restId);

  // 2. Выплата в статусе prepared — сообщения о перечислении быть не должно.
  const prepared = await db.execute(
    `INSERT INTO restaurant_payouts (settlement_period_id, restaurant_id, amount, status)
     VALUES ($1,$2,930,'prepared') RETURNING id`,
    [periodId, restId],
  );
  const before = sent.length;
  const preparedResult = await notificationService.notifyRestaurantAboutPayout(prepared.rows[0].id, {
    bot, publicBaseUrl: 'https://api-pg.yaam.su',
  });
  assert.equal(preparedResult.sent, false);
  assert.equal(preparedResult.reason, 'payout_not_succeeded');
  assert.equal(sent.length, before, 'при prepared ничего не отправлено');
  await db.close();
});

test('T6: без подключённой группы документы остаются в HQ, расчёт не ломается', async () => {
  const databaseUrl = await freshDatabase('closure_t6');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, notificationService, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Без Группы');
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;

  const bot = { sendMessage: async () => { throw new Error('не должен вызываться'); } };
  const result = await notificationService.notifyRestaurantAboutDocuments(periodId, restId, {
    bot, publicBaseUrl: 'https://api-pg.yaam.su',
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'telegram_not_connected');

  // Документы на месте, период закрыт.
  const docs = await documentService.listDocumentsForPeriod(periodId);
  assert.equal(docs.length, 2);
  assert.equal(docs.every((d) => d.status === 'generated'), true);
  // Токенов при этом не выдано — незачем.
  const tokens = await db.query('SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens');
  assert.equal(tokens[0].n, 0);
  await db.close();
});

// ===========================================================================
// K — пакетный catch-up
// ===========================================================================

test('K1: простой 20 недель — backlog доходит до конца пакетами, ни один заказ не потерян', async () => {
  const databaseUrl = await freshDatabase('closure_k1');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Простой20');
  await seedYaam(db);
  await seedLegal(db, restId);

  // 20 недель подряд с одним заказом в каждой. Понедельник 2026-03-16 —
  // начало первой недели.
  const WEEKS = 20;
  for (let i = 0; i < WEEKS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await order(db, restId, {
      itemsTotal: 1000, commissionAmount: 70,
      deliveredAt: new Date(msk(2026, 3, 18, 12, 0).getTime() + i * 7 * 24 * 3600 * 1000),
    });
  }

  // Момент после всех недель: понедельник 2026-08-10 07:00.
  const now = msk(2026, 8, 10, 7, 0);
  let guard = 0;
  let last;
  do {
    // eslint-disable-next-line no-await-in-loop
    last = await weekly.runWeeklySettlementJob({ now, generateDocuments: false });
    guard += 1;
  } while (last.remaining > 0 && guard < 20);

  assert.ok(guard > 1, 'backlog обязан обрабатываться несколькими пакетами');
  assert.equal(last.remaining, 0, 'очередь исчерпана');

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  assert.equal(periods.length, WEEKS, 'закрыты все недели с активностью');
  assert.equal(periods.every((p) => p.status === 'closed'), true);

  // Ни один заказ не потерян и ни один не учтён дважды.
  const lines = await db.query(
    'SELECT COUNT(*)::int AS n, COUNT(DISTINCT order_id)::int AS d FROM settlement_order_lines');
  assert.equal(lines[0].n, WEEKS);
  assert.equal(lines[0].d, WEEKS);

  // Периоды не пересекаются.
  const overlap = await db.query(`
    SELECT COUNT(*)::int AS n FROM settlement_periods a JOIN settlement_periods b
      ON a.id < b.id AND daterange(a.period_from, a.period_to, '[]') && daterange(b.period_from, b.period_to, '[]')`);
  assert.equal(overlap[0].n, 0);
  await db.close();
});

test('K2: простой 45 недель — все активные недели доходят до закрытия', async () => {
  const databaseUrl = await freshDatabase('closure_k2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Простой45');
  await seedYaam(db);
  await seedLegal(db, restId);

  const WEEKS = 45;
  // Первая неделя начинается 2025-09-29 (пн).
  const firstDelivery = msk(2025, 10, 1, 12, 0);
  for (let i = 0; i < WEEKS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await order(db, restId, {
      itemsTotal: 1000, commissionAmount: 70,
      deliveredAt: new Date(firstDelivery.getTime() + i * 7 * 24 * 3600 * 1000),
    });
  }

  const now = msk(2026, 8, 17, 7, 0);
  let guard = 0;
  let last;
  do {
    // eslint-disable-next-line no-await-in-loop
    last = await weekly.runWeeklySettlementJob({ now, generateDocuments: false });
    guard += 1;
  } while (last.remaining > 0 && guard < 40);

  assert.equal(last.remaining, 0, 'очередь исчерпана и за пределами старого окна в 12 недель');
  const periods = await db.query('SELECT COUNT(*)::int AS n FROM settlement_periods');
  assert.equal(periods[0].n, WEEKS, 'ни одна неделя не потеряна');
  const lines = await db.query('SELECT COUNT(DISTINCT order_id)::int AS d FROM settlement_order_lines');
  assert.equal(lines[0].d, WEEKS);
  await db.close();
});

test('K3: размер очереди, обработанные и оставшиеся недели попадают в аудит', async () => {
  const databaseUrl = await freshDatabase('closure_k3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Очередь');
  await seedYaam(db);
  await seedLegal(db, restId);

  const WEEKS = 12;
  for (let i = 0; i < WEEKS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await order(db, restId, {
      itemsTotal: 1000, commissionAmount: 70,
      deliveredAt: new Date(msk(2026, 5, 13, 12, 0).getTime() + i * 7 * 24 * 3600 * 1000),
    });
  }

  const now = msk(2026, 8, 10, 7, 0);
  const first = await weekly.runWeeklySettlementJob({ now, generateDocuments: false });
  assert.equal(first.queued, WEEKS);
  assert.equal(first.processed, weekly.CATCH_UP_BATCH_SIZE);
  assert.equal(first.remaining, WEEKS - weekly.CATCH_UP_BATCH_SIZE);

  const queued = await db.query(
    "SELECT details FROM hq_audit_log WHERE action = 'settlement_backlog_queued' ORDER BY id");
  assert.match(queued[0].details, new RegExp(`очередь недель: ${WEEKS}`));
  const deferred = await db.query(
    "SELECT details FROM hq_audit_log WHERE action = 'settlement_backlog_deferred' ORDER BY id");
  assert.match(deferred[0].details, new RegExp(`осталось недель в очереди: ${WEEKS - weekly.CATCH_UP_BATCH_SIZE}`));

  // Самая старая неделя обработана первой — порядок обязателен для carry-forward.
  const periods = await db.query('SELECT period_from FROM settlement_periods ORDER BY period_from');
  assert.equal(dstr(periods[0].period_from), '2026-05-11');
  await db.close();
});

test('K4: ошибка одной недели не скрывается и не блокирует остальные', async () => {
  const databaseUrl = await freshDatabase('closure_k4');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Сбой');
  await seedYaam(db);
  await seedLegal(db, restId);
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await order(db, restId, {
      itemsTotal: 1000, commissionAmount: 70,
      deliveredAt: new Date(msk(2026, 7, 15, 12, 0).getTime() + i * 7 * 24 * 3600 * 1000),
    });
  }

  const settlementService = require('../../services/hq/settlementService');
  const original = settlementService.closeSettlementPeriod;
  let call = 0;
  settlementService.closeSettlementPeriod = async (...args) => {
    call += 1;
    if (call === 2) throw new Error('искусственный сбой второй недели');
    return original(...args);
  };
  let result;
  try {
    result = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });
  } finally {
    settlementService.closeSettlementPeriod = original;
  }

  assert.equal(result.failed.length, 1, 'ошибка зафиксирована, а не проглочена');
  assert.equal(result.closed.length, 2, 'остальные недели закрыты');
  const failedAudit = await db.query(
    "SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_job_failed'");
  assert.equal(failedAudit[0].n, 1);

  // Следующий запуск подхватывает упавшую неделю.
  const retry = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 8, 0), generateDocuments: false });
  assert.equal(retry.closed.length, 1);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM settlement_periods'))[0].n, 3);
  await db.close();
});

// HTTP-уровень: сам endpoint, а не только сервис. Проверяются коды ответов,
// отсутствие утечки токена в заголовки/тело и невозможность добраться до HQ.
test('T7: GET /d/:token — 200 на валидном, 404 на мусорном, 410 на отозванном', async () => {
  const databaseUrl = await freshDatabase('closure_t7');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  const { db, weekly, accessService, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе HTTP');
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periodId = (await db.query('SELECT id FROM settlement_periods'))[0].id;
  const doc = (await documentService.listDocumentsForPeriod(periodId))
    .find((d) => d.kind === 'agent_report');

  const appModule = require('../../services/postgresql/app.js');
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1',
    schedulerIntervalMs: 1_000_000,
    weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
  });
  await instance.start();
  const deadline = Date.now() + 2000;
  while (!instance.address() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
  const base = `http://127.0.0.1:${instance.address().port}`;

  try {
    const issued = await accessService.issueToken(doc.id);

    const ok = await fetch(`${base}/d/${issued.token}`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /Отчёт агента/);
    // Документ отдан, но токен в тело страницы не попадает.
    assert.ok(!html.includes(issued.token), 'токен не должен возвращаться в теле');
    assert.equal(ok.headers.get('cache-control'), 'no-store, private');
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
    // noarchive обязателен: без него поисковик, которому URL всё же достался,
    // сохранит копию документа и после отзыва токена (Stage 19.1, пункт 3).
    assert.equal(ok.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

    // Мусорный токен.
    const bad = await fetch(`${base}/d/не-токен`);
    assert.equal(bad.status, 404);
    // Страница отказа живёт по тому же URL с тем же секретом внутри, поэтому
    // защитные заголовки нужны и на ней, а не только на успешном ответе.
    assert.equal(bad.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(bad.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(bad.headers.get('cache-control'), 'no-store, private');

    // Формально валидный, но несуществующий — тот же ответ, что и мусорный:
    // разница помогала бы перебору.
    const unknown = await fetch(`${base}/d/${accessService.generateToken()}`);
    assert.equal(unknown.status, 404);

    // Отозванный.
    await accessService.revokeToken(issued.tokenId);
    const revoked = await fetch(`${base}/d/${issued.token}`);
    assert.equal(revoked.status, 410);

    // Через этот роут нельзя добраться до HQ.
    const hq = await fetch(`${base}/d/${issued.token}/../hq/finance`, { redirect: 'manual' });
    assert.notEqual(hq.status, 200);
  } finally {
    await instance.stop();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// Отображаемое владельцу расписание («Выплаты» на карточке ресторана) и
// фактическое расписание job — два разных модуля с продублированными
// константами (импорт создал бы цикл). Расхождение означало бы, что владельцу
// показывают одну дату, а расчёт происходит в другую.
test('S5: отображаемое расписание совпадает с фактическим', async () => {
  const { weekly } = requireFresh();
  delete require.cache[require.resolve('../../services/hq/restaurantPayoutStateService.js')];
  const stateService = require('../../services/hq/restaurantPayoutStateService');

  // Среда 05.08 12:00 МСК -> ближайший расчёт пн 10.08 07:00 МСК.
  const next = stateService.nextSettlementAt(msk(2026, 8, 5, 12, 0));
  assert.equal(next.at.toISOString(), msk(2026, 8, 10, 7, 0).toISOString());
  assert.equal(next.hour, weekly.SETTLEMENT_HOUR);

  // Та же дата, что и плановое закрытие недели 03.08–09.08.
  assert.equal(weekly.scheduledCloseAt('2026-08-09').toISOString(), next.at.toISOString());
});

// Прежний абсолютный предел глубины (MAX_BACKLOG_WEEKS = 120) означал, что
// активная неделя старше него молча выпадала из очереди. Предел снят: нижняя
// граница берётся из фактических данных, поэтому возраст недели больше ничего
// не решает.
test('K5: активная неделя старше 120 недель обнаруживается и закрывается', async () => {
  const databaseUrl = await freshDatabase('closure_k5');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Древность');
  await seedYaam(db);
  await seedLegal(db, restId);

  // 2023-03-15 (ср) — примерно 176 недель до 2026-08-10, заведомо за прежним
  // пределом в 120 недель.
  const ancient = msk(2023, 3, 15, 12, 0);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: ancient });
  // И одна свежая неделя, чтобы очередь была не только из древней.
  await order(db, restId, { itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 8, 5, 12, 0) });

  const now = msk(2026, 8, 10, 7, 0);
  let last;
  let guard = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    last = await weekly.runWeeklySettlementJob({ now, generateDocuments: false });
    guard += 1;
  } while (last.remaining > 0 && guard < 10);

  assert.equal(last.remaining, 0, 'очередь исчерпана');

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  // РОВНО две недели: древняя и свежая. Пустые недели между ними не создаются.
  assert.equal(periods.length, 2, 'создаются только недели с активностью, без пустых');
  assert.equal(dstr(periods[0].period_from), '2023-03-13', 'древняя неделя закрыта');
  assert.equal(dstr(periods[1].period_from), '2026-08-03');
  assert.equal(periods.every((p) => p.status === 'closed'), true);

  // Оба заказа учтены, каждый ровно один раз.
  const lines = await db.query(
    'SELECT COUNT(*)::int AS n, COUNT(DISTINCT order_id)::int AS d FROM settlement_order_lines');
  assert.equal(lines[0].n, 2);
  assert.equal(lines[0].d, 2);

  // Пересечений нет.
  const overlap = await db.query(`
    SELECT COUNT(*)::int AS n FROM settlement_periods a JOIN settlement_periods b
      ON a.id < b.id AND daterange(a.period_from, a.period_to, '[]') && daterange(b.period_from, b.period_to, '[]')`);
  assert.equal(overlap[0].n, 0);
  await db.close();
});

// Пустая история не должна порождать ни одного периода и ни одного запроса
// «а вдруг там что-то было»: очередь строится из данных, а данных нет.
test('K6: пустая база не создаёт периодов и не сканирует историю', async () => {
  const databaseUrl = await freshDatabase('closure_k6');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  await createRestaurant(db, 'Кафе Пустота');
  await seedYaam(db);

  const result = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });
  assert.equal(result.queued, 0);
  assert.equal(result.closed.length, 0);
  assert.equal(result.remaining, 0);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM settlement_periods'))[0].n, 0);
  await db.close();
});

// Дыра в истории: неделя упала с ошибкой, следующая закрылась. Правило
// «начинать со следующей недели после ПОСЛЕДНЕГО закрытого» потеряло бы
// упавшую навсегда — очередь обязана находить самую раннюю НЕПОКРЫТУЮ неделю.
test('K7: дыра между закрытыми периодами подхватывается, а не теряется', async () => {
  const databaseUrl = await freshDatabase('closure_k7');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Дыра');
  await seedYaam(db);
  await seedLegal(db, restId);
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await order(db, restId, {
      itemsTotal: 1000, commissionAmount: 70,
      deliveredAt: new Date(msk(2026, 7, 15, 12, 0).getTime() + i * 7 * 86400000),
    });
  }

  // Ломаем ВТОРУЮ неделю — между двумя успешными.
  const settlementService = require('../../services/hq/settlementService');
  const original = settlementService.closeSettlementPeriod;
  let call = 0;
  settlementService.closeSettlementPeriod = async (...args) => {
    call += 1;
    if (call === 2) throw new Error('искусственный сбой средней недели');
    return original(...args);
  };
  try {
    const first = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });
    assert.equal(first.failed.length, 1);
    assert.equal(first.closed.length, 2);
  } finally {
    settlementService.closeSettlementPeriod = original;
  }

  // Последний закрытый период — ТРЕТЬЯ неделя, но дыра во второй обязана
  // быть найдена следующим запуском.
  const retry = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 8, 0), generateDocuments: false });
  assert.equal(retry.closed.length, 1, 'дыра закрыта');
  assert.equal(dstr(retry.closed[0].periodFrom), '2026-07-20');

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  assert.equal(periods.length, 3);
  assert.equal(periods.every((p) => p.status === 'closed'), true);
  await db.close();
});

// Stage 19.1, пункт 4. Воспроизводит РЕАЛЬНОЕ состояние hqtest: внутри недели
// лежат однодневные периоды, созданные вручную на раннем этапе. Детектор
// сравнивал недели по равенству period_from и такие периоды не видел, поэтому
// job каждые 15 минут пытался вставить неделю и каждый раз получал отказ от
// EXCLUDE-ограничения. Неделя обязана уходить в blocked, а не в failed, и
// диагностика — писаться один раз, а не на каждый запуск.
test('K8: неделя, пересечённая однодневными периодами, блокируется без повторяющейся ошибки', async () => {
  const databaseUrl = await freshDatabase('closure_k8');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Пересечение');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Активность внутри недели 27.07–02.08.
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 30, 12, 0) });

  // Однодневные периоды ВНУТРИ этой недели — как на hqtest.
  await db.execute(
    `INSERT INTO settlement_periods (period_from, period_to, status, closed_at)
     VALUES ('2026-07-30','2026-07-30','closed',NOW()),
            ('2026-07-31','2026-07-31','closed',NOW())`,
  );

  const first = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 30), generateDocuments: false });
  assert.equal(first.failed.length, 0, 'блокировка не должна выглядеть как сбой выполнения');
  assert.equal(first.queued, 0, 'заблокированная неделя не ставится в очередь');
  assert.equal(first.blocked.length, 1);
  assert.equal(dstr(first.blocked[0].periodFrom), '2026-07-27');
  assert.equal(dstr(first.blocked[0].periodTo), '2026-08-02');
  assert.equal(first.blocked[0].overlaps.length, 2);

  // Существующие периоды не тронуты.
  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  assert.equal(periods.length, 2, 'job не создал и не удалил ни одного периода');

  // Диагностика записана ровно один раз, а повтор запуска её НЕ дублирует.
  const afterFirst = await db.query(
    "SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_week_blocked'",
  );
  assert.equal(afterFirst[0].n, 1);

  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 45), generateDocuments: false });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 8, 0), generateDocuments: false });
  const afterRepeat = await db.query(
    "SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_week_blocked'",
  );
  assert.equal(afterRepeat[0].n, 1, 'повторные запуски не должны множить одну и ту же диагностику');

  // И ни одного settlement_job_failed — прежнее поведение писало его каждый раз.
  const failures = await db.query(
    "SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_job_failed'",
  );
  assert.equal(failures[0].n, 0);
  await db.close();
});
