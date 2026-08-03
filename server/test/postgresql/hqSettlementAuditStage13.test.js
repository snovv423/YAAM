'use strict';

// YAAM HQ — узкий блокирующий аудит Stage 13.
//
// Файл отделён от hqSettlementStage13.test.js намеренно: там проверяется
// заявленное поведение, здесь — конкретные подозрения аудита, каждое из
// которых сначала было воспроизведено как дефект, а затем закрыто.
//
// A — граница недели: заказ вс 06:59 / вс 07:00 / вс 20:00 / пн 00:00.
// B — поздний полный возврат (заказ в периоде A, возврат в периоде B).
// C — доступ ресторана к документам из Telegram-сообщения.
// D — advisory lock: одно физическое соединение, освобождение после ошибки.
// E — прочие инварианты: >12 недель простоя, цепочка корректировок.
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
  require.resolve('../../services/hq/restaurantBalanceService.js'),
  require.resolve('../../services/hq/payoutService.js'),
  require.resolve('../../services/hq/restaurantPayoutService.js'),
  require.resolve('../../services/hq/restaurantFinanceService.js'),
  require.resolve('../../services/hq/yaamBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantBankDetailsService.js'),
  require.resolve('../../services/hq/restaurantContractService.js'),
  require.resolve('../../services/hq/restaurantLegalDetailsService.js'),
  require.resolve('../../services/hq/auditLog.js'),
];

const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616', INN10: '7709123453', KPP: '770101001', OGRNIP: '312770012345008',
};

let cluster;

before(async () => { cluster = await startEmbeddedPostgres('hq-settle-audit'); });
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
  // settlementAdjustmentService появляется в ходе аудита — резолвим мягко,
  // чтобы файл грузился и до его создания (тесты тогда честно падают на
  // сути дефекта, а не на отсутствии модуля).
  try { delete require.cache[require.resolve('../../services/hq/settlementAdjustmentService.js')]; } catch { /* нет модуля */ }
  for (const p of MODULE_PATHS) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    weekly: require('../../services/hq/weeklySettlementService'),
    settlementService: require('../../services/hq/settlementService'),
    documentService: require('../../services/hq/settlementDocumentService'),
    notificationService: require('../../services/hq/settlementNotificationService'),
  };
}

// DATE-колонки pg отдаёт строкой либо Date в зависимости от парсера —
// нормализуем к 'YYYY-MM-DD', чтобы тест не зависел от этого.
function dstr(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// UTC-момент по календарным компонентам московского времени.
function msk(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 180 * 60 * 1000);
}

async function createRestaurant(db, name) {
  const r = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [name],
  );
  return r.rows[0].id;
}

let counter = 0;
async function createEarnedOrder(db, restaurantId, { itemsTotal = 1000, commissionAmount = 70, deliveredAt }) {
  counter += 1;
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at)
     VALUES ($1,$2,'Грозный','Иса Магомадов',$3,'ул. Тестовая, 5','',$4,$5,'delivered',$6) RETURNING id`,
    [`YAAM-A${String(counter).padStart(4, '0')}`, restaurantId, `+7901${String(counter).padStart(7, '0')}`,
      itemsTotal, commissionAmount, deliveredAt],
  );
  const p = await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded') RETURNING id`,
    [o.rows[0].id, itemsTotal],
  );
  return { orderId: o.rows[0].id, paymentId: p.rows[0].id, code: `YAAM-A${String(counter).padStart(4, '0')}` };
}

async function addRefund(db, paymentId, amount, completedAt) {
  const r = await db.execute(
    `INSERT INTO refunds (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
     VALUES ($1,'mock',$2,'succeeded','customer_cancel',$3,$4) RETURNING id`,
    [paymentId, amount, `ak-${paymentId}-${Math.random().toString(36).slice(2)}`, completedAt],
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

async function seedLegal(db, restaurantId, legalName = 'ИП Аудитов А. А.') {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip',$2,$3,$4,'г. Грозный, ул. Тестовая, 1','Аудитов А. А.','+79280000002')`,
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
    [restaurantId, `ДА-${restaurantId}`],
  );
}

// ===========================================================================
// A — граница расчётной недели
// ===========================================================================

// Ключевой вопрос аудита: не закрывается ли неделя ДО её фактического конца.
// Неделя 2026-07-27(пн)..2026-08-02(вс). Закрытие — 2026-08-03 (пн) 07:00 МСК,
// то есть через 7 часов после конца недели.
test('A1: неделя не закрывается ни в одну из точек до её фактического окончания', async () => {
  const { weekly } = requireFresh();
  const closeAt = weekly.scheduledCloseAt('2026-08-02');

  // Все моменты ВНУТРИ недели и сразу после неё — закрытие ещё не наступило.
  const before = [
    msk(2026, 8, 2, 6, 59),  // вс 06:59 — неделя ещё идёт
    msk(2026, 8, 2, 7, 0),   // вс 07:00 — неделя ещё идёт
    msk(2026, 8, 2, 20, 0),  // вс 20:00 — неделя ещё идёт
    msk(2026, 8, 2, 23, 59), // вс 23:59 — последняя минута недели
    msk(2026, 8, 3, 0, 0),   // пн 00:00 — неделя кончилась, закрытие в 07:00
    msk(2026, 8, 3, 6, 59),  // пн 06:59 — за минуту до закрытия
  ];
  for (const t of before) {
    assert.ok(closeAt.getTime() > t.getTime(), `неделя не должна закрываться в ${t.toISOString()}`);
  }
  assert.equal(closeAt.getTime(), msk(2026, 8, 3, 7, 0).getTime());
});

// Четыре обязательных сценария задания: заказ каждого из этих моментов должен
// попасть в ПРАВИЛЬНУЮ неделю и не потеряться при закрытии.
test('A2: заказы вс 06:59 / вс 07:00 / вс 20:00 / пн 00:00 попадают ровно в свою неделю', async () => {
  const databaseUrl = await freshDatabase('audit_week_edges');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Граница');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Неделя 1: 27.07(пн)..02.08(вс). Неделя 2: 03.08(пн)..09.08(вс).
  await createEarnedOrder(db, restId, { itemsTotal: 100, commissionAmount: 7, deliveredAt: msk(2026, 8, 2, 6, 59) });
  await createEarnedOrder(db, restId, { itemsTotal: 200, commissionAmount: 14, deliveredAt: msk(2026, 8, 2, 7, 0) });
  await createEarnedOrder(db, restId, { itemsTotal: 400, commissionAmount: 28, deliveredAt: msk(2026, 8, 2, 20, 0) });
  await createEarnedOrder(db, restId, { itemsTotal: 800, commissionAmount: 56, deliveredAt: msk(2026, 8, 3, 0, 0) });

  // Прогон в момент, когда ОБЕ недели уже подлежат закрытию (пн 10.08 07:00).
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 10, 7, 0), generateDocuments: false });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const week1 = periods.find((p) => dstr(p.period_from) === '2026-07-27');
  const week2 = periods.find((p) => dstr(p.period_from) === '2026-08-03');
  assert.ok(week1 && week2, 'обе недели должны быть закрыты');

  const line1 = (await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [week1.id]))[0];
  const line2 = (await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [week2.id]))[0];

  // Все три воскресных заказа — в неделе 1, включая 20:00 (после 07:00).
  assert.equal(line1.turnover, 700, 'вс 06:59 + вс 07:00 + вс 20:00 = 700');
  assert.equal(line1.delivered_paid_orders, 3);
  // Понедельник 00:00 — уже следующая неделя.
  assert.equal(line2.turnover, 800);
  assert.equal(line2.delivered_paid_orders, 1);

  // Ни один заказ не потерян и ни один не посчитан дважды.
  const allLines = await db.query('SELECT COUNT(*)::int AS n FROM settlement_order_lines');
  assert.equal(allLines[0].n, 4);
  await db.close();
});

// ===========================================================================
// B — поздний полный возврат
// ===========================================================================

// ГЛАВНАЯ проверка аудита. Заказ доставлен и оплачен в неделе A, обязательство
// перед рестораном зафиксировано. Полный возврат покупателю приходит в неделе B.
// Деньги покупателю уже вернули — значит обязательство ресторана должно
// уменьшиться, а начисленная комиссия YAAM восстановиться.
test('B1: поздний полный возврат уменьшает обязательство ресторана и сторнирует комиссию YAAM', async () => {
  const databaseUrl = await freshDatabase('audit_late_refund');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Поздний Возврат');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Неделя A: 27.07..02.08 — заказ 1000 ₽, комиссия 70 ₽, ресторану 930 ₽.
  // ЗАКРЫВАЕТСЯ ДО ВОЗВРАТА — это и есть реальная последовательность:
  // если бы возврат уже существовал, заказ вообще не попал бы в период.
  const order = await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0),
  });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });

  // Неделя B: 10.08..16.08 — обычный заказ 2000 ₽ / 140 ₽ и ПОЗДНИЙ полный
  // возврат по заказу уже закрытой недели A.
  await createEarnedOrder(db, restId, {
    itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 8, 11, 12, 0),
  });
  await addRefund(db, order.paymentId, 1000, msk(2026, 8, 12, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: true });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const weekA = periods.find((p) => dstr(p.period_from) === '2026-07-27');
  const weekB = periods.find((p) => dstr(p.period_from) === '2026-08-10');
  assert.ok(weekA && weekB);

  const lineA = (await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [weekA.id]))[0];
  const lineB = (await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [weekB.id]))[0];

  // Период A неизменяем: он был закрыт до возврата и переписываться не должен.
  assert.equal(lineA.turnover, 1000);
  assert.equal(lineA.yaam_commission, 70);
  assert.equal(lineA.payable_amount, 930);

  // Период B: продажи 2000, комиссия 140 — и СТОРНО по заказу недели A.
  assert.equal(lineB.turnover, 2000, 'продажи периода B не включают возвращённый заказ периода A');
  assert.equal(lineB.successful_refunds_amount, 1000);

  // Обязательство ресторана уменьшено на сумму, которую ресторан получил
  // за возвращённый заказ (930 ₽), а не на всю сумму возврата.
  assert.equal(lineB.refund_adjustment_restaurant_amount, 930,
    'ресторан обязан вернуть ровно то, что ему было начислено по возвращённому заказу');
  // Комиссия YAAM по возвращённому заказу восстановлена (сторнирована).
  assert.equal(lineB.refund_adjustment_commission, 70,
    'YAAM возвращает удержанную комиссию по возвращённому заказу');

  // Итог: ресторану к выплате 2000 - 140 - 930 = 930.
  assert.equal(lineB.payable_amount, 930);
  // Комиссия YAAM за период B нетто: 140 - 70 = 70.
  assert.equal(lineB.yaam_commission_net, 70);

  // Сумма денег сходится по обоим периодам: покупателю вернули 1000,
  // ресторан суммарно получает 930 + 930 = 1860 при продажах 3000,
  // из которых 1000 возвращено -> база 2000, комиссия 140, ресторану 1860.
  assert.equal(lineA.payable_amount + lineB.payable_amount, 1860);
  await db.close();
});

// Сторно должно быть ЯВНОЙ записью, а не «вычислиться где-то в отчёте»:
// иначе его нельзя ни проверить, ни оспорить, ни показать ресторану.
test('B2: сторно фиксируется отдельной строкой корректировки со ссылкой на исходный период и заказ', async () => {
  const databaseUrl = await freshDatabase('audit_adjustment_row');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Сторно');
  await seedYaam(db);
  await seedLegal(db, restId);

  const order = await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0),
  });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  await createEarnedOrder(db, restId, {
    itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 8, 11, 12, 0),
  });
  await addRefund(db, order.paymentId, 1000, msk(2026, 8, 12, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: false });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const weekA = periods[0];
  const weekB = periods[1];

  const adj = await db.query('SELECT * FROM settlement_adjustments ORDER BY id');
  assert.equal(adj.length, 1, 'ровно одна корректировка');
  assert.equal(adj[0].settlement_period_id, weekB.id, 'корректировка учтена в периоде возврата');
  assert.equal(adj[0].origin_period_id, weekA.id, 'ссылка на период, где заказ был начислен');
  assert.equal(adj[0].order_id, order.orderId);
  assert.equal(adj[0].restaurant_amount, 930);
  assert.equal(adj[0].commission_amount, 70);
  assert.equal(adj[0].kind, 'late_refund');

  // Корректировка неизменяема — это финансовая запись.
  await assert.rejects(
    () => db.execute('UPDATE settlement_adjustments SET restaurant_amount = 1 WHERE id = $1', [adj[0].id]),
    /immutable/i,
  );
  // Один возврат не может быть сторнирован дважды.
  await assert.rejects(
    () => db.execute(
      `INSERT INTO settlement_adjustments
         (settlement_period_id, restaurant_id, kind, refund_id, order_id, origin_period_id,
          restaurant_amount, commission_amount)
       VALUES ($1,$2,'late_refund',$3,$4,$5,930,70)`,
      [weekB.id, restId, adj[0].refund_id, order.orderId, weekA.id],
    ),
    /duplicate key|unique/i,
  );
  await db.close();
});

// Возврат может превысить продажи периода — тогда ресторан ДОЛЖЕН YAAM.
// Это отрицательное обязательство, и его нельзя молча обнулять: обнуление
// означало бы подарить ресторану деньги, уже возвращённые покупателю.
test('B3: возврат больше продаж периода превращается в долг, а не в отрицательную выплату', async () => {
  const databaseUrl = await freshDatabase('audit_negative_payable');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, settlementService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Долг');
  await seedYaam(db);
  await seedLegal(db, restId);

  const big = await createEarnedOrder(db, restId, {
    itemsTotal: 5000, commissionAmount: 350, deliveredAt: msk(2026, 7, 29, 12, 0),
  });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  // В неделе B продаж почти нет, а возврат приходит на 5000 ₽.
  await createEarnedOrder(db, restId, {
    itemsTotal: 100, commissionAmount: 7, deliveredAt: msk(2026, 8, 11, 12, 0),
  });
  await addRefund(db, big.paymentId, 5000, msk(2026, 8, 12, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: false });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const lineB = (await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1', [periods[1].id]))[0];

  // Начислено 93 (100 − 7), сторно 4650 -> минус 4557 превращается в долг.
  // ОБНОВЛЕНО: раньше это оставалось отрицательным payable_amount; теперь
  // минус уходит в ledger и переносится (hqSettlementClosureStage13).
  assert.equal(lineB.refund_adjustment_restaurant_amount, 4650);
  assert.equal(lineB.payable_amount, 0, 'выплатить отрицательную сумму невозможно');
  assert.equal(lineB.carry_forward_remaining, 4557, 'минус стал явным долгом');
  assert.equal(lineB.payout_blocked_reason, 'outstanding_debt');
  const balanceService = require('../../services/hq/restaurantBalanceService');
  assert.equal(await balanceService.getDebt(restId), 4557, 'долг не потерян');

  // Инварианты обязаны считать это КОРРЕКТНЫМ состоянием, а не нарушением:
  // отрицательный остаток объяснён корректировками.
  const { violations } = await settlementService.checkSettlementInvariants();
  const negative = violations.find((v) => v.kind === 'negative_payable_amount');
  assert.equal(negative, undefined, 'долг, объяснённый сторно и перенесённый, не является нарушением');

  await db.close();
});


// Документ обязан СХОДИТЬСЯ арифметически: читатель считает столбец сверху
// вниз и должен получить ровно «К перечислению». Сторно комиссии YAAM в этот
// столбец не входит (её удерживают не с ресторана) — если бы оно там стояло
// со знаком минус, документ выглядел бы ошибочным на 70 ₽.
test('B4: отчёт агента с поздним возвратом сходится по столбцу и не удерживает комиссию с ресторана', async () => {
  const databaseUrl = await freshDatabase('audit_doc_arithmetic');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, documentService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Арифметика');
  await seedYaam(db);
  await seedLegal(db, restId);

  const order = await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0),
  });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  await createEarnedOrder(db, restId, {
    itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 8, 11, 12, 0),
  });
  await addRefund(db, order.paymentId, 1000, msk(2026, 8, 12, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: true });

  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from');
  const docs = await documentService.listDocumentsForPeriod(periods[1].id);
  const report = docs.find((d) => d.kind === 'agent_report');
  const t = report.payload.totals;
  await db.close();

  // Столбец: продажи 2000 − комиссия 140 − удержание 930 = 930.
  assert.equal(t.sales, 2000);
  assert.equal(t.commissionAmount, 140);
  assert.equal(t.adjustmentRestaurantAmount, 930);
  assert.equal(t.sales - t.commissionAmount - t.adjustmentRestaurantAmount, t.payableAmount);
  assert.equal(t.payableAmount, 930);
  // Сторно комиссии существует, но НЕ участвует в удержании с ресторана.
  assert.equal(t.adjustmentCommissionAmount, 70);
  assert.equal(t.commissionAmountNet, 70);
  assert.equal(report.payload.adjustments.length, 1);
  assert.equal(report.payload.adjustments[0].orderCode, order.code);
  // Даты в payload нормализованы, форматирует их renderer — как и все
  // остальные даты документа (иначе в отчёте соседствовали бы два формата).
  assert.equal(report.payload.adjustments[0].originPeriodFrom, '2026-07-27');

  const { renderDocument } = require('../../hq/settlementDocumentViews');
  const html = renderDocument(report);
  assert.match(html, /27\.07\.2026 — 02\.08\.2026/);
  assert.match(html, /Удержано за возвраты по заказам прошлых периодов/);
  assert.match(html, /−930 ₽/);
  // Комиссия НЕ должна стоять минусом в столбце к перечислению.
  assert.doesNotMatch(html, /<td>Возвращено вознаграждение агента[^<]*<\/td><td class="num">−/);
});


// Сводка периода на карточке «Финансы» обязана показывать то, что РЕАЛЬНО
// причитается ресторанам (payable со сторно), а не начисленное до удержаний:
// иначе владелец видит обещание большей суммы, чем будет выплачено.
test('B5: карточка периода показывает сумму к выплате с учётом сторно', async () => {
  const databaseUrl = await freshDatabase('audit_period_card');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, settlementService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Карточка');
  await seedYaam(db);
  await seedLegal(db, restId);

  const order = await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0),
  });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  await createEarnedOrder(db, restId, {
    itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 8, 11, 12, 0),
  });
  await addRefund(db, order.paymentId, 1000, msk(2026, 8, 12, 12, 0));
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 17, 7, 0), generateDocuments: false });

  const periods = await settlementService.listSettlementPeriods();
  const weekB = periods.find((p) => dstr(p.periodFrom) === '2026-08-10');
  await db.close();

  assert.equal(weekB.turnover, 2000);
  assert.equal(weekB.commission, 140);
  assert.equal(weekB.adjustmentAmount, 930);
  // 1860 начислено, но к выплате 930.
  assert.equal(weekB.restaurantEarnings, 930, 'карточка обязана показывать сумму со сторно');
});

// ===========================================================================
// C — доступ ресторана к документам
// ===========================================================================

// Ресторан не имеет HQ-сессии. Ссылка на HQ-документ для него — мёртвая:
// она ведёт на форму входа. Обещать документ ссылкой, которая не открывается,
// хуже, чем не давать ссылку.
test('C1: Telegram-сообщение содержит только capability-ссылки, без HQ', async () => {
  const databaseUrl = await freshDatabase('audit_tg_links');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, notificationService } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Телеграм');
  await seedYaam(db);
  await seedLegal(db, restId);
  await db.execute('UPDATE restaurants SET telegram_chat_id = $1 WHERE id = $2', ['-1002222222', restId]);
  await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0),
  });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });

  const period = (await db.query('SELECT * FROM settlement_periods'))[0];
  const payout = await db.execute(
    `INSERT INTO restaurant_payouts (settlement_period_id, restaurant_id, amount, status, completed_at)
     VALUES ($1,$2,930,'succeeded',NOW()) RETURNING id`,
    [period.id, restId],
  );

  const sent = [];
  const bot = { sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } };
  const result = await notificationService.notifyRestaurantAboutPayout(payout.rows[0].id, {
    bot, publicBaseUrl: 'https://api-pg.yaam.su',
  });

  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  const markup = JSON.stringify(sent[0].opts || {});
  assert.doesNotMatch(markup, /\/hq\//, 'HQ-ссылки ресторану недоступны и не должны отправляться');
  assert.match(markup, /\/d\/yaam_doc_v1_/, 'только capability-ссылки');
  assert.doesNotMatch(sent[0].text, /\/hq\//);
  // Суммы при этом остаются — сообщение не должно стать бессмысленным.
  assert.match(sent[0].text, /930/);
  await db.close();
});

// ===========================================================================
// D — advisory lock
// ===========================================================================

// Лока и разлока обязаны идти по ОДНОМУ физическому соединению: session-level
// advisory lock принадлежит сессии, и unlock из другой сессии молча не сработает.
test('D1: lock и unlock выполняются на одном соединении, лока освобождается после ошибки', async () => {
  const databaseUrl = await freshDatabase('audit_advisory_lock');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Лока');
  await seedYaam(db);
  await seedLegal(db, restId);
  await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0),
  });

  const heldBefore = await db.query(
    `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1`,
    [weekly.ADVISORY_LOCK_KEY],
  );
  assert.equal(heldBefore[0].n, 0);

  // Падение ВНУТРИ job: генерация документов не при чём, ломаем сам расчёт.
  const settlementService = require('../../services/hq/settlementService');
  const original = settlementService.closeSettlementPeriod;
  settlementService.closeSettlementPeriod = async () => { throw new Error('искусственный сбой закрытия'); };
  try {
    const res = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
    assert.equal(res.failed.length, 1, 'ошибка должна быть зафиксирована, а не проглочена');
  } finally {
    settlementService.closeSettlementPeriod = original;
  }

  // Лока обязана быть отпущена, несмотря на ошибку.
  const heldAfter = await db.query(
    `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1`,
    [weekly.ADVISORY_LOCK_KEY],
  );
  assert.equal(heldAfter[0].n, 0, 'advisory lock не освобождена после ошибки');

  // Повторный запуск после ошибки не блокируется и доводит работу до конца.
  const retry = await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: false });
  assert.equal(retry.skipped, false, 'повторный запуск после ошибки не должен считаться "уже идёт"');
  assert.equal(retry.closed.length, 1);
  await db.close();
});

// ===========================================================================
// E — прочие инварианты
// ===========================================================================

// Простой дольше прежнего окна catch-up не должен терять недели.
// ОБНОВЛЕНО: раньше такие недели только СООБЩАЛИСЬ событием
// settlement_backlog_beyond_window и не закрывались вовсе. Теперь backlog
// обрабатывается пакетами до полного исчерпания, поэтому и состояние
// «непокрытая неделя», и событие о нём удалены. Сценарии простоя на 20 и 45
// недель разобраны подробно в hqSettlementClosureStage13.
test('E1: неделя вне прежнего окна в 12 недель всё равно доходит до закрытия', async () => {
  const databaseUrl = await freshDatabase('audit_long_downtime');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const restId = await createRestaurant(db, 'Кафе Простой');
  await seedYaam(db);
  await seedLegal(db, restId);

  // Заказ 20 недель назад — далеко за пределами прежнего окна в 12 недель.
  await createEarnedOrder(db, restId, {
    itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 3, 18, 12, 0),
  });

  const now = msk(2026, 8, 10, 7, 0);
  let last;
  let guard = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    last = await weekly.runWeeklySettlementJob({ now, generateDocuments: false });
    guard += 1;
  } while (last.remaining > 0 && guard < 20);

  assert.equal(last.remaining, 0, 'очередь исчерпана');
  const periods = await db.query('SELECT * FROM settlement_periods');
  assert.equal(periods.length, 1, 'неделя 20-недельной давности закрыта');
  assert.equal(dstr(periods[0].period_from), '2026-03-16');

  // Прежнего «сообщили и забыли» состояния больше не существует.
  const stale = await db.query(
    "SELECT COUNT(*)::int AS n FROM hq_audit_log WHERE action = 'settlement_backlog_beyond_window'");
  assert.equal(stale[0].n, 0);
  await db.close();
});

// Корректирующая версия — это исправление КОНКРЕТНОГО документа. Ссылка на
// документ другого периода/ресторана/вида означала бы подмену документа.
test('E2: корректирующая версия не может ссылаться на документ другого периода, ресторана или вида', async () => {
  const databaseUrl = await freshDatabase('audit_correction_chain');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly } = requireFresh();
  const r1 = await createRestaurant(db, 'Кафе Один');
  const r2 = await createRestaurant(db, 'Кафе Два');
  await seedYaam(db);
  await seedLegal(db, r1, 'ИП Один');
  await seedLegal(db, r2, 'ИП Два');
  await createEarnedOrder(db, r1, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await createEarnedOrder(db, r2, { itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 7, 30, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });

  const period = (await db.query('SELECT * FROM settlement_periods'))[0];
  const docs = await db.query('SELECT * FROM settlement_documents ORDER BY id');
  const r1Report = docs.find((d) => d.restaurant_id === r1 && d.kind === 'agent_report');
  const r2Report = docs.find((d) => d.restaurant_id === r2 && d.kind === 'agent_report');
  const r1Registry = docs.find((d) => d.restaurant_id === r1 && d.kind === 'order_registry');

  // Другой ресторан.
  await assert.rejects(
    () => db.execute(
      `INSERT INTO settlement_documents
         (settlement_period_id, restaurant_id, kind, document_number, version,
          supersedes_document_id, correction_reason, payload)
       VALUES ($1,$2,'agent_report','ПОДМЕНА-1',2,$3,'подмена ресторана','{}'::jsonb)`,
      [period.id, r1, r2Report.id],
    ),
    /correcting document|цепочк|same/i,
  );
  // Другой вид документа.
  await assert.rejects(
    () => db.execute(
      `INSERT INTO settlement_documents
         (settlement_period_id, restaurant_id, kind, document_number, version,
          supersedes_document_id, correction_reason, payload)
       VALUES ($1,$2,'agent_report','ПОДМЕНА-2',2,$3,'подмена вида','{}'::jsonb)`,
      [period.id, r1, r1Registry.id],
    ),
    /correcting document|цепочк|same/i,
  );
  // Две конкурирующие актуальные версии одной цепочки.
  await db.execute(
    `INSERT INTO settlement_documents
       (settlement_period_id, restaurant_id, kind, document_number, version,
        supersedes_document_id, correction_reason, payload)
     VALUES ($1,$2,'agent_report','ЦЕПЬ-и2',2,$3,'первая корректировка','{}'::jsonb)`,
    [period.id, r1, r1Report.id],
  );
  await assert.rejects(
    () => db.execute(
      `INSERT INTO settlement_documents
         (settlement_period_id, restaurant_id, kind, document_number, version,
          supersedes_document_id, correction_reason, payload)
       VALUES ($1,$2,'agent_report','ЦЕПЬ-и2-дубль',2,$3,'вторая корректировка того же документа','{}'::jsonb)`,
      [period.id, r1, r1Report.id],
    ),
    /duplicate key|unique/i,
  );
  await db.close();
});
