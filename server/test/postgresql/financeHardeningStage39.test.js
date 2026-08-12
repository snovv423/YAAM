'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const MODULES = [
  '../../db/postgresql',
  '../../services/postgresql/orderService',
  '../../services/hq/settlementService',
  '../../services/hq/settlementDocumentService',
  '../../services/hq/payoutStatusService',
  '../../services/hq/restaurantPayoutStateService',
  '../../services/hq/restaurantPayoutService',
  '../../services/hq/restaurantLegalDetailsService',
  '../../services/hq/restaurantBankDetailsService',
  '../../services/hq/restaurantContractService',
  '../../services/hq/payoutService',
  '../../services/hq/settlementNotificationService',
].map(require.resolve);

let cluster;
let sequence = 0;

before(async () => { cluster = await startEmbeddedPostgres('finance-hardening-39'); });
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const client = cluster.getClient(name);
  await client.connect();
  await client.query(SCHEMA_SQL);
  await client.end();
  return cluster.connectionString(name);
}

function requireFresh() {
  for (const modulePath of MODULES) delete require.cache[modulePath];
  return {
    db: require('../../db/postgresql'),
    orderService: require('../../services/postgresql/orderService'),
    settlementService: require('../../services/hq/settlementService'),
    documents: require('../../services/hq/settlementDocumentService'),
    payoutStatus: require('../../services/hq/payoutStatusService'),
    payoutState: require('../../services/hq/restaurantPayoutStateService'),
    payoutService: require('../../services/hq/payoutService'),
    notifications: require('../../services/hq/settlementNotificationService'),
  };
}

async function createRestaurant(db, name = 'Finance hardening') {
  sequence += 1;
  const result = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at)
     VALUES ($1,'["Грозный"]',1,NOW()) RETURNING id`,
    [`${name} ${sequence}`],
  );
  return result.rows[0].id;
}

async function createOrder(db, restaurantId, {
  status = 'awaiting_payment', fulfillmentType = 'delivery', earnedAt = null, amount = 30000,
} = {}) {
  sequence += 1;
  const result = await db.execute(
    `INSERT INTO orders
       (public_code, restaurant_id, city, customer_name, customer_phone, address,
        items_total, commission_amount, status, fulfillment_type, earned_at)
     VALUES ($1,$2,'Грозный','Тест','+79000000000','Тестовый адрес',$3,0,$4,$5,$6)
     RETURNING *`,
    [`YAAM-FH-${sequence}`, restaurantId, amount, status, fulfillmentType, earnedAt],
  );
  return result.rows[0];
}

async function seedReadiness(db, restaurantId) {
  await db.execute(
    `INSERT INTO yaam_bank_details
       (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО YAAM Платформа','7709123453','770101001','40702810938050001238',
             '044999225','ТЕСТБАНК','30101810400000004565')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip',$2,$3,$4,'Тестовый адрес','Ответственный','+79280000001')`,
    [restaurantId, `ИП Тест ${restaurantId}`, '770912345616', '312770012345008'],
  );
  await db.execute(
    `INSERT INTO restaurant_bank_details
       (restaurant_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik,
        bank_name, correspondent_account, default_payment_purpose)
     VALUES ($1,$2,$3,'',$4,'044999225','ТЕСТБАНК','30101810400000004565','Выплата')`,
    [restaurantId, `ИП Тест ${restaurantId}`, '770912345616', '40702810938050001238'],
  );
  await db.execute(
    `INSERT INTO restaurant_contracts (restaurant_id, contract_number, signed_at, status)
     VALUES ($1,$2,'2026-01-01','signed')`,
    [restaurantId, `FH-${restaurantId}`],
  );
}

async function createClosedLine(db, restaurantId, periodFrom, periodTo, amount) {
  const period = await db.execute(
    `INSERT INTO settlement_periods (period_from, period_to, status, closed_at)
     VALUES ($1,$2,'closed',NOW()) RETURNING id`,
    [periodFrom, periodTo],
  );
  await db.execute(
    `INSERT INTO settlement_restaurant_lines
       (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
        restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
        payout_readiness_snapshot, contract_number_snapshot, restaurant_name_snapshot)
     VALUES ($1,$2,1,$3,0,$3,0,0,$3,'{}','FH','Finance hardening')`,
    [period.rows[0].id, restaurantId, amount],
  );
  return period.rows[0].id;
}

test('FIX1: Telegram settlement output форматирует integer minor units канонически', () => {
  const { buildPayoutMessage, buildDocumentsMessage } = require('../../services/hq/settlementNotificationService');
  const line = {
    turnover: 41800,
    successful_refunds_amount: 7350,
    yaam_commission: 7350,
    carry_forward_applied: 7350,
    carry_forward_remaining: 7350,
    payable_amount: 41800,
  };
  const period = { period_from: '2026-08-03', period_to: '2026-08-09' };
  const payout = { amount: 41800 };
  const payoutText = buildPayoutMessage({ line, period, payout }).text;
  const documentsText = buildDocumentsMessage({ line, period }).text;
  for (const text of [payoutText, documentsText]) {
    assert.match(text, /418 ₽/);
    assert.match(text, /73,50 ₽/);
    assert.doesNotMatch(text, /41800 ₽|7350 ₽/);
  }
});

test('FIX3: earned_at допускает первую установку/no-op и запрещает изменение/обнуление', async () => {
  process.env.DATABASE_URL = await freshDatabase('fh39_earned_immutability');
  const { db, orderService } = requireFresh();
  try {
    const restaurantId = await createRestaurant(db);
    const direct = await createOrder(db, restaurantId, { status: 'ready' });
    const first = new Date('2026-08-03T09:00:00.000Z');
    await db.execute('UPDATE orders SET earned_at = $1 WHERE id = $2', [first, direct.id]);
    await db.execute('UPDATE orders SET earned_at = earned_at WHERE id = $1', [direct.id]);
    await assert.rejects(
      () => db.execute('UPDATE orders SET earned_at = $1 WHERE id = $2', [new Date('2026-08-03T10:00:00.000Z'), direct.id]),
      /earned_at is immutable/,
    );
    await assert.rejects(
      () => db.execute('UPDATE orders SET earned_at = NULL WHERE id = $1', [direct.id]),
      /earned_at is immutable/,
    );

    const delivery = await createOrder(db, restaurantId, { status: 'ready', fulfillmentType: 'delivery' });
    await orderService.restaurantAdvance(delivery.id, 'courier');
    const deliveryRow = (await db.query('SELECT status, earned_at FROM orders WHERE id = $1', [delivery.id]))[0];
    assert.equal(deliveryRow.status, 'courier');
    assert.ok(deliveryRow.earned_at);

    const pickup = await createOrder(db, restaurantId, { status: 'preparing', fulfillmentType: 'pickup' });
    await orderService.restaurantAdvance(pickup.id, 'delivered');
    const pickupRow = (await db.query('SELECT status, earned_at FROM orders WHERE id = $1', [pickup.id]))[0];
    assert.equal(pickupRow.status, 'delivered');
    assert.ok(pickupRow.earned_at);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('FIX4: duplicate_payment refund сам по себе не создаёт active settlement week', async () => {
  process.env.DATABASE_URL = await freshDatabase('fh39_activity_weeks');
  const { db, settlementService } = requireFresh();
  try {
    const restaurantId = await createRestaurant(db);
    const duplicateOrder = await createOrder(db, restaurantId);
    const duplicatePayment = await db.execute(
      `INSERT INTO payments (order_id, provider, amount, status) VALUES ($1,'mock',30000,'succeeded') RETURNING id`,
      [duplicateOrder.id],
    );
    await db.execute(
      `INSERT INTO refunds
         (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
       VALUES ($1,'mock',30000,'succeeded','duplicate_payment','fh-dup', '2026-08-05T09:00:00Z')`,
      [duplicatePayment.rows[0].id],
    );
    assert.deepEqual(await settlementService.listWeeksWithFinancialActivity(), []);

    const reversingOrder = await createOrder(db, restaurantId);
    const reversingPayment = await db.execute(
      `INSERT INTO payments (order_id, provider, amount, status) VALUES ($1,'mock',30000,'succeeded') RETURNING id`,
      [reversingOrder.id],
    );
    await db.execute(
      `INSERT INTO refunds
         (payment_id, provider, amount, status, reason, provider_idempotency_key, completed_at)
       VALUES ($1,'mock',30000,'succeeded','customer_cancel','fh-reversing', '2026-08-05T09:00:00Z')`,
      [reversingPayment.rows[0].id],
    );
    assert.deepEqual(await settlementService.listWeeksWithFinancialActivity(), ['2026-08-03']);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('FIX5: document failures durable, bounded at five, manual recovery preserves immutable documents', async () => {
  process.env.DATABASE_URL = await freshDatabase('fh39_document_retry');
  const { db, documents } = requireFresh();
  try {
    const restaurantId = await createRestaurant(db);
    const periodId = await createClosedLine(db, restaurantId, '2026-08-03', '2026-08-09', 41800);
    const registry = await documents.ensureDocument(periodId, restaurantId, 'order_registry');
    assert.equal(registry.created, true);

    await db.execute('DROP TABLE document_number_counters');
    for (let attempt = 1; attempt <= documents.MAX_GENERATION_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const retry = await documents.retryMissingDocuments();
      assert.deepEqual(retry, { checked: 1, created: 0, failed: 1 });
      // eslint-disable-next-line no-await-in-loop
      const current = await db.query(
        `SELECT failure_count FROM settlement_document_generation_failures
          WHERE settlement_period_id=$1 AND restaurant_id=$2 AND kind='agent_report'`,
        [periodId, restaurantId],
      );
      assert.equal(current[0].failure_count, attempt);
    }
    const stored = await db.query(
      `SELECT failure_count FROM settlement_document_generation_failures
        WHERE settlement_period_id=$1 AND restaurant_id=$2 AND kind='agent_report'`,
      [periodId, restaurantId],
    );
    assert.equal(stored[0].failure_count, documents.MAX_GENERATION_ATTEMPTS);
    const automatic = await documents.retryMissingDocuments();
    assert.equal(automatic.checked, 0, 'после лимита automatic retry прекращается');

    await db.execute(
      `CREATE TABLE document_number_counters (
         kind TEXT NOT NULL, year INTEGER NOT NULL, last_number INTEGER NOT NULL DEFAULT 0,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(kind, year))`,
    );
    const recovered = await documents.ensureDocument(periodId, restaurantId, 'agent_report');
    assert.equal(recovered.created, true, 'явный допустимый recovery после устранения причины работает');
    const docs = await db.query(
      `SELECT kind, status, version FROM settlement_documents
        WHERE settlement_period_id=$1 AND restaurant_id=$2 ORDER BY kind`,
      [periodId, restaurantId],
    );
    assert.deepEqual(docs.map((d) => [d.kind, d.status, d.version]), [
      ['agent_report', 'generated', 1],
      ['order_registry', 'generated', 1],
    ]);
    await assert.rejects(
      () => db.execute('UPDATE settlement_documents SET status=$1 WHERE id=$2', ['failed', recovered.document.id]),
      /immutable/,
    );
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('FIX7: три unpaid periods предлагаются и подготавливаются строго FIFO', async () => {
  process.env.DATABASE_URL = await freshDatabase('fh39_payout_fifo');
  const { db, payoutStatus, payoutState, payoutService } = requireFresh();
  try {
    const restaurantId = await createRestaurant(db);
    await seedReadiness(db, restaurantId);
    const periodIds = [
      await createClosedLine(db, restaurantId, '2026-07-13', '2026-07-19', 41800),
      await createClosedLine(db, restaurantId, '2026-07-20', '2026-07-26', 41900),
      await createClosedLine(db, restaurantId, '2026-07-27', '2026-08-02', 42000),
    ];

    for (let index = 0; index < periodIds.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const status = (await payoutStatus.listPayoutStatuses()).find((row) => row.restaurantId === restaurantId);
      assert.equal(status.settlementPeriodId, periodIds[index]);
      // eslint-disable-next-line no-await-in-loop
      const card = await payoutState.getRestaurantPayoutState(restaurantId);
      assert.equal(card.kind, 'ready', JSON.stringify(card));
      assert.equal(card.settlementPeriodId, periodIds[index]);
      // eslint-disable-next-line no-await-in-loop
      const payout = await payoutStatus.payRestaurant(restaurantId);
      assert.equal(payout.settlement_period_id, periodIds[index]);
      // eslint-disable-next-line no-await-in-loop
      await payoutService.confirmManualBankTransfer(payout.id, {
        operationReference: `FH-FIFO-${index + 1}`,
        paidAt: new Date('2026-08-01T09:00:00.000Z'),
        confirmedBy: 'test',
      });
    }
    const payouts = await db.query('SELECT settlement_period_id FROM restaurant_payouts ORDER BY id');
    assert.deepEqual(payouts.map((p) => p.settlement_period_id), periodIds);
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
