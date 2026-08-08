'use strict';

// YAAM HQ Stage 25 — «замыкание операционного цикла HQ»: ручное подтверждение
// выплаты (закрытие Stage 24 HIGH-1), ручная выдача ссылок на документы
// (закрытие Stage 24 HIGH-2), симметричное восстановление категории вместе с
// блюдами (закрытие Stage 24 MEDIUM-1), Cache-Control на публичном API
// (закрытие Stage 24 MEDIUM-2). Интеграционные тесты против настоящего
// embedded PostgreSQL — тот же harness, что и test/postgresql/hqPayoutStage9.
// test.js и test/postgresql/hqSettlementClosureStage13.test.js, поэтому
// фикстуры (createRestaurant/order/seedYaam/seedLegal/msk) переиспользуют их
// доказанный набор реквизитов, а не изобретают новый.
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
  require.resolve('../../services/hq/menuAdminService.js'),
  require.resolve('../../services/hq/auditLog.js'),
  require.resolve('../../services/hq/eventLogService.js'),
  require.resolve('../../services/hq/dashboardMetrics.js'),
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../services/postgresql/orderService.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/settlements.js'),
  require.resolve('../../routes/hq/payouts.js'),
  require.resolve('../../routes/hq/restaurants.js'),
  require.resolve('../../routes/postgresql/api.js'),
  require.resolve('../../routes/postgresql/settlementDocuments.js'),
];

const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616', INN10: '7709123453', KPP: '770101001', OGRNIP: '312770012345008',
};

// Все тесты файла делят один процесс и один IP (127.0.0.1), поэтому их
// логины суммарно упираются в общий login-лимит (8 за 15 минут) — тот же
// случай, что и в test/postgresql/hqSettingsStage14.test.js, и для него уже
// существует штатный override в routes/hq/middleware.js, а не ослабление
// самого лимита.
process.env.HQ_LOGIN_RATE_LIMIT_MAX = '200';

// Этот файл поднимает заметно больше отдельных app-инстансов подряд, чем
// соседние файлы (каждый payout/document/category/API-сценарий — свой пул).
// Дефолтный PG_POOL_MAX=10 на инстанс при 24 тестах подряд и небольшой
// задержке освобождения соединений embedded-кластером под конец файла
// временно упирался в общий max_connections=100 ("too many clients already"
// на последних тестах). Меньший пул на инстанс снижает пиковую нагрузку, не
// трогая общий embedded-кластер (test/postgresql/helpers/embeddedPg.js) и не
// ослабляя ничего в самом приложении.
process.env.PG_POOL_MAX = '4';

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('hq-op-cycle-stage25'); });
after(async () => {
  await cluster.stop();
  delete process.env.HQ_LOGIN_RATE_LIMIT_MAX;
  delete process.env.PG_POOL_MAX;
});

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
    accessService: require('../../services/hq/settlementDocumentAccessService'),
    payoutService: require('../../services/hq/payoutService'),
    menuAdminService: require('../../services/hq/menuAdminService'),
  };
}

function msk(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 180 * 60 * 1000);
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
  const code = `YAAM-S25-${String(counter).padStart(4, '0')}`;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // эта фикстура всегда создаёт 'delivered' напрямую SQL, поэтому earned_at
  // безусловно равен тому же deliveredAt, что и status_updated_at (тот же
  // принцип, что и backfill в миграции 0013).
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Иса Тестов',$3,'ул. Тестовая, 5','',$4,$5,'delivered',$6,$6) RETURNING id`,
    [code, restaurantId, `+7903${String(counter).padStart(7, '0')}`, itemsTotal, commissionAmount, deliveredAt],
  );
  await db.execute(`INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded')`, [o.rows[0].id, itemsTotal]);
  return o.rows[0].id;
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

// ---------------------------------------------------------------------------
// HTTP-приложение (для CSRF/сессия/маршруты) — та же схема, что и в
// hqPayoutStage9.test.js.
// ---------------------------------------------------------------------------
const TEST_SESSION_SECRET = 'k'.repeat(48);
const TEST_HQ_USER = 'owner';
const TEST_HQ_PASSWORD = 'Str0ng!HqPassw0rd#Stage25Cycle';
let TEST_HQ_PASSWORD_HASH;

before(async () => {
  const { hashPassword } = require('../../services/hq/passwordHash');
  TEST_HQ_PASSWORD_HASH = await hashPassword(TEST_HQ_PASSWORD);
});

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице');
  return m[1];
}
async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer никогда не начал слушать');
}
async function startApp(databaseUrl, { publicBackendUrl = 'https://hqtest.example.invalid' } = {}) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  delete process.env.MEDIA_PROVIDER;
  process.env.APP_ENV = 'local';
  if (publicBackendUrl) process.env.PUBLIC_BACKEND_URL = publicBackendUrl;
  else delete process.env.PUBLIC_BACKEND_URL;
  // TELEGRAM_BOT_TOKEN намеренно НЕ задаётся — сценарии этого файла как раз
  // проверяют, что ручные действия владельца работают и БЕЗ Telegram.
  delete process.env.TELEGRAM_BOT_TOKEN;
  for (const p of MODULE_PATHS) delete require.cache[p];
  const appModule = require('../../services/postgresql/app.js');
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000,
    hqAdminUser: TEST_HQ_USER, hqAdminPasswordHash: TEST_HQ_PASSWORD_HASH, hqSessionSecret: TEST_SESSION_SECRET,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  return { instance, port, base: `http://127.0.0.1:${port}` };
}
async function stopApp(instance) {
  await instance.stop();
  delete process.env.DATABASE_URL;
  delete process.env.PUBLIC_BACKEND_URL;
  // Этот файл создаёт заметно больше отдельных app-инстансов подряд, чем
  // соседние файлы (каждый payout/document/category-сценарий поднимает свой
  // собственный embedded-кластер + пул) — без короткой паузы после
  // instance.stop() PostgreSQL иногда не успевает полностью освободить
  // предыдущие backend-соединения до того, как СЛЕДУЮЩИЙ тест откроет новый
  // пул, и это выливалось в отдельных прогонах в транзиентные "terminating
  // connection due to administrator command"/connection-timeout ошибки у
  // НЕСВЯЗАННЫХ последующих тестов. Пауза даёт кластеру полностью
  // рассинхронизированно закрыть соединения перед следующим циклом.
  await new Promise((r) => setTimeout(r, 200));
}
async function loginHq(base) {
  const loginRes = await fetch(`${base}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const postRes = await fetch(`${base}/hq/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf, username: TEST_HQ_USER, password: TEST_HQ_PASSWORD }).toString(),
  });
  return cookieHeaderFrom(postRes) || cookie;
}

// Готовит закрытый период с одним заработанным заказом на ресторан плюс
// сформированные документы — общая фикстура для payout- и document-сценариев
// этого файла.
async function closedPeriodWithDocs(db, weekly, restaurantId, { itemsTotal = 1000, commissionAmount = 70 } = {}) {
  await order(db, restaurantId, { itemsTotal, commissionAmount, deliveredAt: msk(2026, 7, 29, 12, 0) });
  await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
  const periods = await db.query('SELECT * FROM settlement_periods ORDER BY period_from DESC LIMIT 1');
  return periods[0];
}

// ===========================================================================
// 1. Ручное подтверждение выплаты (закрытие Stage 24 HIGH-1)
// ===========================================================================

test('P1: подготовленную выплату можно подтвердить вручную — статус succeeded, метод manual, номер операции сохранён', async () => {
  const databaseUrl = await freshDatabase('op25_p1');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе П1');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);

    const detailRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await detailRes.text());

    const confirmRes = await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrf, paid_at: '2026-08-01T10:00', operation_reference: 'OP-P1-001', comment: 'тест',
      }).toString(),
    });
    assert.equal(confirmRes.status, 302, 'успешное подтверждение — редирект обратно на карточку');
    const confirmLocation = confirmRes.headers.get('location') || '';
    assert.ok(!confirmLocation.includes('error='), `редирект не должен содержать ошибку: ${confirmLocation}`);

    const attempts = await payoutService.listAttemptsForPayout(payout.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].method, 'manual');
    assert.equal(attempts[0].payment_id, 'OP-P1-001');
    assert.equal(attempts[0].status, 'succeeded');
    assert.equal(attempts[0].confirmed_by, TEST_HQ_USER);

    const updatedPayout = await payoutService.getPayoutDetail(payout.id);
    assert.equal(updatedPayout.status, 'succeeded');
    assert.ok(updatedPayout.completed_at, 'completed_at должен быть заполнен фактом завершения');
  } finally {
    await stopApp(instance);
  }
});

test('P2: неподготовленную выплату (только что созданную обычную запись без prepare) подтвердить нельзя', async () => {
  const databaseUrl = await freshDatabase('op25_p2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе П2');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    // createPayoutAttempt САМ ПО СЕБЕ ещё не переводит обязательство в
    // processing (это делает только markAttemptSubmitting, задание — "первый
    // момент, когда обязательство вообще меняется") — поэтому для честного
    // "выплата больше не prepared" нужны оба шага.
    const attempt = await payoutService.createPayoutAttempt(payout.id);
    await payoutService.markAttemptSubmitting(attempt.id);

    await assert.rejects(
      () => payoutService.confirmManualBankTransfer(payout.id, {
        operationReference: 'OP-BLOCKED', paidAt: '2026-08-01T10:00',
      }),
      /Подготовлена/i,
    );
  } finally {
    await db.close();
  }
});

test('P3: повторное подтверждение уже succeeded-выплаты отклоняется и НЕ создаёт вторую попытку', async () => {
  const databaseUrl = await freshDatabase('op25_p3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе П3');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    await payoutService.confirmManualBankTransfer(payout.id, { operationReference: 'OP-P3-FIRST', paidAt: '2026-08-01T10:00' });

    await assert.rejects(
      () => payoutService.confirmManualBankTransfer(payout.id, { operationReference: 'OP-P3-SECOND', paidAt: '2026-08-01T11:00' }),
      /Подготовлена/i,
    );
    const attempts = await payoutService.listAttemptsForPayout(payout.id);
    assert.equal(attempts.length, 1, 'вторая попытка не должна была создаться');
  } finally {
    await db.close();
  }
});

test('P4: один и тот же номер операции нельзя использовать дважды для разных выплат', async () => {
  const databaseUrl = await freshDatabase('op25_p4');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutService } = requireFresh();
  try {
    const restA = await createRestaurant(db, 'Кафе П4-А');
    const restB = await createRestaurant(db, 'Кафе П4-Б');
    await seedYaam(db);
    await seedLegal(db, restA, 'ИП Первый');
    await seedLegal(db, restB, 'ИП Второй');
    // Оба заказа — ДО единственного прогона job: расчётный период закрывается
    // один раз для всей недели сразу для всех ресторанов, у которых была
    // активность (в отличие от P1-P3, где period нужен только одному ресторану).
    await order(db, restA, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
    await order(db, restB, { itemsTotal: 500, commissionAmount: 35, deliveredAt: msk(2026, 7, 29, 13, 0) });
    await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
    const periodA = (await db.query('SELECT * FROM settlement_periods ORDER BY period_from DESC LIMIT 1'))[0];

    const payoutA = await payoutService.prepareRestaurantPayout(periodA.id, restA);
    const payoutB = await payoutService.prepareRestaurantPayout(periodA.id, restB);

    await payoutService.confirmManualBankTransfer(payoutA.id, { operationReference: 'OP-DUP-001', paidAt: '2026-08-01T10:00' });
    await assert.rejects(
      () => payoutService.confirmManualBankTransfer(payoutB.id, { operationReference: 'OP-DUP-001', paidAt: '2026-08-01T10:05' }),
      /уже использован/i,
    );
    const attemptsB = await payoutService.listAttemptsForPayout(payoutB.id);
    assert.equal(attemptsB.length, 0, 'у payoutB не должно остаться попытки после отклонённого дубликата');
  } finally {
    await db.close();
  }
});

test('P5: подтверждение одной выплаты не влияет на выплату другого ресторана', async () => {
  const databaseUrl = await freshDatabase('op25_p5');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutService } = requireFresh();
  try {
    const restA = await createRestaurant(db, 'Кафе П5-А');
    const restB = await createRestaurant(db, 'Кафе П5-Б');
    await seedYaam(db);
    await seedLegal(db, restA, 'ИП А');
    await seedLegal(db, restB, 'ИП Б');
    await order(db, restA, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
    await order(db, restB, { itemsTotal: 800, commissionAmount: 56, deliveredAt: msk(2026, 7, 29, 13, 0) });
    await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
    const periodA = (await db.query('SELECT * FROM settlement_periods ORDER BY period_from DESC LIMIT 1'))[0];

    const payoutA = await payoutService.prepareRestaurantPayout(periodA.id, restA);
    const payoutB = await payoutService.prepareRestaurantPayout(periodA.id, restB);

    await payoutService.confirmManualBankTransfer(payoutA.id, { operationReference: 'OP-P5-A', paidAt: '2026-08-01T10:00' });

    const refreshedB = await payoutService.getPayoutDetail(payoutB.id);
    assert.equal(refreshedB.status, 'prepared', 'выплата ресторана Б не должна была измениться');
  } finally {
    await db.close();
  }
});

test('P6: реквизиты и сумма выплаты не меняются после подтверждения (снимок остаётся snapshot)', async () => {
  const databaseUrl = await freshDatabase('op25_p6');
  process.env.DATABASE_URL = databaseUrl;
  const { db, weekly, payoutService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе П6');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    const amountBefore = payout.amount;

    const { attempt } = await payoutService.confirmManualBankTransfer(payout.id, {
      operationReference: 'OP-P6', paidAt: '2026-08-01T10:00',
    });
    const requisites = await payoutService.getAttemptRequisites(attempt.id);
    assert.ok(requisites, 'снимок реквизитов должен существовать для попытки');
    assert.equal(requisites.recipient_inn, FICT.INN12);

    const after = await payoutService.getPayoutDetail(payout.id);
    assert.equal(after.amount, amountBefore, 'сумма выплаты не должна измениться после подтверждения');

    // Изменение банковских реквизитов ресторана ПОСЛЕ подтверждения не должно
    // задним числом менять уже сохранённый снимок попытки.
    await db.execute(`UPDATE restaurant_bank_details SET account_number = '99999999999999999999' WHERE restaurant_id = $1`, [restId]);
    const requisitesAfterChange = await payoutService.getAttemptRequisites(attempt.id);
    assert.equal(requisitesAfterChange.account_number, requisites.account_number, 'снимок попытки неизменен даже после правки текущих реквизитов ресторана');
  } finally {
    await db.close();
  }
});

test('P7: аудит и событие HQ о ручном подтверждении не содержат банковских реквизитов', async () => {
  // Аудит ('payout_attempt_succeeded'/'payout_succeeded') и событие HQ
  // пишутся в HTTP-роуте (routes/hq/payouts.js), а не в самом сервисе — тест
  // обязан идти через настоящий POST, иначе прямой вызов
  // confirmManualBankTransfer() ничего не запишет и проверка была бы пустой.
  const databaseUrl = await freshDatabase('op25_p7');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе П7');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);

    const pageRes = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, paid_at: '2026-08-01T10:00', operation_reference: 'OP-P7' }).toString(),
    });

    const auditRows = await db.query(
      `SELECT * FROM hq_audit_log WHERE action IN ('payout_attempt_succeeded','payout_succeeded') ORDER BY id`,
    );
    assert.ok(auditRows.length >= 2, 'должны быть записи И об успехе попытки, И о завершении обязательства');
    const auditBlob = JSON.stringify(auditRows);
    assert.ok(!auditBlob.includes(FICT.RS), 'аудит не должен содержать номер счёта');
    assert.ok(!auditBlob.includes(FICT.BIK), 'аудит не должен содержать БИК');

    const eventRows = await db.query(`SELECT * FROM hq_events WHERE restaurant_id = $1`, [restId]);
    assert.ok(eventRows.length >= 1, 'должно быть записано хотя бы одно событие HQ');
    const eventBlob = JSON.stringify(eventRows);
    assert.ok(!eventBlob.includes(FICT.RS), 'событие HQ не должно содержать номер счёта');
    assert.ok(!eventBlob.includes(FICT.BIK), 'событие HQ не должно содержать БИК');
  } finally {
    await stopApp(instance);
  }
});

test('P8: карточка выплаты нигде не утверждает, что YAAM сам отправил деньги через банк', async () => {
  const databaseUrl = await freshDatabase('op25_p8');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе П8');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);
    await payoutService.confirmManualBankTransfer(payout.id, { operationReference: 'OP-P8', paidAt: '2026-08-01T10:00' });

    const res = await fetch(`${base}/hq/payouts/${payout.id}`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.ok(html.includes('банк не задействован'), 'карточка обязана честно раскрывать, что банк не участвовал');
    for (const forbidden of ['YAAM перевёл', 'YAAM отправил деньги', 'банк выполнил перевод']) {
      assert.ok(!html.includes(forbidden), `карточка не должна содержать "${forbidden}"`);
    }
  } finally {
    await stopApp(instance);
  }
});

test('P9: без CSRF-токена подтверждение отклоняется', async () => {
  const databaseUrl = await freshDatabase('op25_p9');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const payoutService = require('../../services/hq/payoutService');
    const restId = await createRestaurant(db, 'Кафе П9');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const payout = await payoutService.prepareRestaurantPayout(period.id, restId);

    const res = await fetch(`${base}/hq/payouts/${payout.id}/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ paid_at: '2026-08-01T10:00', operation_reference: 'OP-NOCSRF' }).toString(),
    });
    assert.ok([403, 400].includes(res.status), `ожидали отказ без CSRF, получили ${res.status}`);
    const attempts = await payoutService.listAttemptsForPayout(payout.id);
    assert.equal(attempts.length, 0);
  } finally {
    await stopApp(instance);
  }
});

test('P10: без активной HQ-сессии подтверждение недоступно', async () => {
  const databaseUrl = await freshDatabase('op25_p10');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const res = await fetch(`${base}/hq/payouts/1/confirm-manual`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ paid_at: '2026-08-01T10:00', operation_reference: 'OP-NOSESSION' }).toString(),
    });
    assert.ok([302, 401, 403].includes(res.status), `ожидали редирект на логин/отказ, получили ${res.status}`);
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// 2. Ручная выдача ссылок на документы (закрытие Stage 24 HIGH-2)
// ===========================================================================

test('D1: владелец выпускает ссылки на оба документа ресторана без Telegram', async () => {
  const databaseUrl = await freshDatabase('op25_d1');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const documentService = require('../../services/hq/settlementDocumentService');
    const restId = await createRestaurant(db, 'Кафе Д1');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const docs = await documentService.listDocumentsForPeriod(period.id);
    assert.equal(docs.length, 2, 'agent_report + order_registry должны существовать');

    const pageRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());

    const issueRes = await fetch(`${base}/hq/finance/settlements/${period.id}/documents/${restId}/issue-links`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(issueRes.status, 200, 'выдача рендерит страницу периода напрямую, без редиректа');
    const html = await issueRes.text();
    assert.ok(html.includes('показаны один раз'));
    const urlMatches = [...html.matchAll(/https?:\/\/[^\s"<]+\/d\/[A-Za-z0-9_-]+/g)].map((m) => m[0]);
    assert.equal(urlMatches.length, 2, 'должны быть выданы ровно 2 ссылки — на оба документа');
  } finally {
    await stopApp(instance);
  }
});

test('D2: обновление страницы периода НЕ показывает повторно уже выданные ссылки', async () => {
  const databaseUrl = await freshDatabase('op25_d2');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const restId = await createRestaurant(db, 'Кафе Д2');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const pageRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    await fetch(`${base}/hq/finance/settlements/${period.id}/documents/${restId}/issue-links`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });

    const refreshRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const refreshHtml = await refreshRes.text();
    // ВАЖНО: сам confirm()-диалог кнопки выдачи легитимно упоминает "показаны
    // один раз" на КАЖДОЙ загрузке страницы (это подсказка ПЕРЕД действием,
    // а не панель после него) — проверяем конкретно панель одноразового
    // показа (её заголовок содержит "panel-title"), а не эту общую фразу.
    assert.ok(!refreshHtml.includes('panel-title">Ссылки для'), 'обычный GET не должен снова показывать панель выдачи');
    assert.ok(!/https?:\/\/[^\s"<]+\/d\/[A-Za-z0-9_-]+/.test(refreshHtml), 'обычный GET не должен содержать сырую ссылку — это и есть главное доказательство одноразовости');
  } finally {
    await stopApp(instance);
  }
});

test('D3: сырой токен не попадает ни в таблицу токенов, ни в аудит-лог', async () => {
  const databaseUrl = await freshDatabase('op25_d3');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const restId = await createRestaurant(db, 'Кафе Д3');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const pageRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    const issueRes = await fetch(`${base}/hq/finance/settlements/${period.id}/documents/${restId}/issue-links`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const html = await issueRes.text();
    const [rawUrl] = [...html.matchAll(/https?:\/\/[^\s"<]+\/d\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    assert.ok(rawUrl, 'должен быть найден хотя бы один сырой токен в ответе');

    const tokenRows = await db.query('SELECT * FROM settlement_document_access_tokens');
    const tokenBlob = JSON.stringify(tokenRows);
    assert.ok(!tokenBlob.includes(rawUrl), 'таблица токенов не должна содержать сырой токен — только хэш');

    const auditRows = await db.query(`SELECT * FROM hq_audit_log WHERE action = 'settlement_document_token_issued'`);
    const auditBlob = JSON.stringify(auditRows);
    assert.ok(!auditBlob.includes(rawUrl), 'аудит-лог не должен содержать сырой токен');

    const eventRows = await db.query(`SELECT * FROM hq_events`);
    const eventBlob = JSON.stringify(eventRows);
    assert.ok(!eventBlob.includes(rawUrl), 'события HQ не должны содержать сырой токен');
  } finally {
    await stopApp(instance);
  }
});

test('D4: выпущенная ссылка открывает документ ТОЛЬКО своего ресторана', async () => {
  const databaseUrl = await freshDatabase('op25_d4');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const restA = await createRestaurant(db, 'Кафе Д4-А');
    const restB = await createRestaurant(db, 'Кафе Д4-Б');
    await seedYaam(db);
    await seedLegal(db, restA, 'ИП А4');
    await seedLegal(db, restB, 'ИП Б4');
    await order(db, restA, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
    await order(db, restB, { itemsTotal: 2000, commissionAmount: 140, deliveredAt: msk(2026, 7, 29, 13, 0) });
    await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 0), generateDocuments: true });
    const period = (await db.query('SELECT * FROM settlement_periods ORDER BY period_from DESC LIMIT 1'))[0];

    const pageRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    const issueRes = await fetch(`${base}/hq/finance/settlements/${period.id}/documents/${restA}/issue-links`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const html = await issueRes.text();
    // Ресторан Б неизбежно упоминается ГДЕ-ТО на странице (у него своя строка
    // в общем списке документов периода) — это ожидаемо и не проверяется.
    // Единственное, что имеет значение для безопасности: панель
    // одноразового показа СВЕЖИХ ссылок должна существовать РОВНО ОДНА и
    // называть именно ресторан А, а свежевыпущенных ссылок должно быть
    // ровно 2 (документы А), без единой ссылки на документы Б.
    const freshPanelCount = (html.match(/panel-title">Ссылки для/g) || []).length;
    assert.equal(freshPanelCount, 1, 'должна быть выпущена ровно одна панель свежих ссылок');
    // Панель называет ресторан по имени из СНИМКА документа (юридическое имя
    // на момент закрытия периода, restaurantNameFromDocs), а не по текущему
    // названию из таблицы restaurants — поэтому здесь ожидается 'ИП А4', а
    // не 'Кафе Д4-А'.
    // "ИП Б4" ожидаемо встречается на странице В ЦЕЛОМ (у ресторана Б своя
    // строка в общем списке документов периода) — это не проверяется здесь.
    // Доказательство изоляции — три факта вместе: панель свежих ссылок ровно
    // одна, эта единственная панель называет именно ресторан А, и выпущено
    // ровно 2 ссылки (а не 4, что означало бы утечку и на документы Б).
    assert.ok(html.includes('panel-title">Ссылки для ИП А4'), 'панель свежих ссылок должна называть именно ресторан А');
    const rawUrls = [...html.matchAll(/https?:\/\/[^\s"<]+(\/d\/[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    assert.equal(rawUrls.length, 2, 'должно быть выдано ровно 2 свежих ссылки — только на документы ресторана А (не 4х, что означало бы утечку на ресторан Б тоже)');
    const [rawUrl] = rawUrls;

    const openRes = await fetch(`${base}${rawUrl}`);
    assert.equal(openRes.status, 200);
    const docHtml = await openRes.text();
    assert.ok(docHtml.includes('ИП А4') || docHtml.includes('Кафе Д4-А'), 'документ должен относиться к ресторану А');
    assert.ok(!docHtml.includes('ИП Б4'), 'документ не должен содержать данные ресторана Б');
  } finally {
    await stopApp(instance);
  }
});

test('D5: подделанный токен безопасно получает 404, отозванный/просроченный — 410', async () => {
  const databaseUrl = await freshDatabase('op25_d5');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const documentService = require('../../services/hq/settlementDocumentService');
    const accessService = require('../../services/hq/settlementDocumentAccessService');
    const restId = await createRestaurant(db, 'Кафе Д5');
    await seedYaam(db);
    await seedLegal(db, restId);
    const period = await closedPeriodWithDocs(db, weekly, restId);
    const docs = await documentService.listDocumentsForPeriod(period.id);
    const doc = docs[0];

    const tampered = await fetch(`${base}/d/${accessService.generateToken()}`);
    assert.equal(tampered.status, 404);

    const revocable = await accessService.issueToken(doc.id);
    await accessService.revokeToken(revocable.tokenId);
    const revokedRes = await fetch(`${base}/d/${revocable.token}`);
    assert.equal(revokedRes.status, 410);

    // ttlMs слишком маленьким (например, 1) быть не может: CHECK (expires_at
    // > created_at) в БД сравнивает с created_at = NOW() САМОЙ БАЗЫ, который
    // фиксируется чуть ПОЗЖЕ переданного сюда JS-`now` — при экстремально
    // малом ttlMs эта сетевая задержка сама может превысить ttl и упереться
    // в constraint ещё до истечения срока. 100ms — реалистично малый TTL,
    // который безопасно проходит вставку и всё равно истекает быстро.
    const shortLived = await accessService.issueToken(doc.id, { ttlMs: 100 });
    await new Promise((r) => setTimeout(r, 200));
    const expiredRes = await fetch(`${base}/d/${shortLived.token}`);
    assert.equal(expiredRes.status, 410);
  } finally {
    await stopApp(instance);
  }
});

test('D6: без документов у ресторана выдача даёт понятную ошибку, а не пустую/битую ссылку', async () => {
  const databaseUrl = await freshDatabase('op25_d6');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const weekly = require('../../services/hq/weeklySettlementService');
    const restWithDocs = await createRestaurant(db, 'Кафе Д6 с документами');
    const restWithoutDocs = await createRestaurant(db, 'Кафе Д6 без документов');
    await seedYaam(db);
    await seedLegal(db, restWithDocs);
    const period = await closedPeriodWithDocs(db, weekly, restWithDocs);

    const pageRes = await fetch(`${base}/hq/finance/settlements/${period.id}`, { headers: { Cookie: cookie } });
    const csrf = extractCsrf(await pageRes.text());
    const issueRes = await fetch(`${base}/hq/finance/settlements/${period.id}/documents/${restWithoutDocs}/issue-links`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(issueRes.status, 200);
    const html = await issueRes.text();
    assert.ok(html.includes('нет сформированных документов') || html.includes('нечего'), 'должно быть понятное сообщение, а не тишина');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// 3. Симметричное восстановление категории вместе с блюдами (Stage 24 MEDIUM-1)
// ===========================================================================

test('C1: "восстановить только категорию" не возвращает связанные блюда', async () => {
  const databaseUrl = await freshDatabase('op25_c1');
  process.env.DATABASE_URL = databaseUrl;
  const { db, menuAdminService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе К1');
    const category = await menuAdminService.createCategory(restId, { name: 'Супы' });
    await menuAdminService.createMenuItem(restId, { name: 'Борщ', category_id: category.id, price: 300 });
    await menuAdminService.createMenuItem(restId, { name: 'Харчо', category_id: category.id, price: 320 });
    await menuAdminService.archiveCategoryWithItems(restId, category.id);

    const result = await menuAdminService.restoreCategory(restId, category.id, { restoreLinkedItems: false });
    assert.ok(result.category);
    assert.equal(result.restoredItemsCount, 0);
    const items = await db.query('SELECT * FROM menu_items WHERE category_id = $1', [category.id]);
    assert.ok(items.every((i) => i.archived_at !== null), 'блюда должны остаться архивированными');
  } finally {
    await db.close();
  }
});

test('C2: "восстановить категорию и блюда" возвращает именно связанные блюда, недоступными по умолчанию', async () => {
  const databaseUrl = await freshDatabase('op25_c2');
  process.env.DATABASE_URL = databaseUrl;
  const { db, menuAdminService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе К2');
    const category = await menuAdminService.createCategory(restId, { name: 'Супы' });
    const soup1 = await menuAdminService.createMenuItem(restId, { name: 'Борщ', category_id: category.id, price: 300 });
    const soup2 = await menuAdminService.createMenuItem(restId, { name: 'Харчо', category_id: category.id, price: 320 });
    await menuAdminService.archiveCategoryWithItems(restId, category.id);

    const result = await menuAdminService.restoreCategory(restId, category.id, { restoreLinkedItems: true });
    assert.equal(result.restoredItemsCount, 2);
    const items = await db.query('SELECT * FROM menu_items WHERE id = ANY($1)', [[soup1.id, soup2.id]]);
    for (const item of items) {
      assert.equal(item.archived_at, null, 'блюдо должно быть восстановлено');
      assert.equal(item.is_available, 0, 'восстановленное блюдо не должно становиться доступным автоматически');
      assert.equal(item.archived_with_category_id, null, 'связь должна быть снята после восстановления');
    }
  } finally {
    await db.close();
  }
});

test('C3: блюдо, заархивированное НЕЗАВИСИМО до архивирования категории, не воскрешается вместе с ней', async () => {
  const databaseUrl = await freshDatabase('op25_c3');
  process.env.DATABASE_URL = databaseUrl;
  const { db, menuAdminService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе К3');
    const category = await menuAdminService.createCategory(restId, { name: 'Супы' });
    const independentlyArchived = await menuAdminService.createMenuItem(restId, { name: 'Уха (снята заранее)', category_id: category.id, price: 350 });
    // Заранее, независимо — ДО архивирования категории.
    await menuAdminService.archiveMenuItem(restId, independentlyArchived.id);
    // Категория теперь пуста (её единственное блюдо уже архивировано) —
    // архивируем её обычным archiveCategory (не archiveCategoryWithItems), это
    // легитимный путь для пустой категории.
    await menuAdminService.archiveCategory(restId, category.id);

    const result = await menuAdminService.restoreCategory(restId, category.id, { restoreLinkedItems: true });
    assert.equal(result.restoredItemsCount, 0, 'у категории нет блюд, архивированных ВМЕСТЕ с ней');
    const item = await menuAdminService.getMenuItemById(restId, independentlyArchived.id);
    assert.ok(item.archived_at, 'независимо архивированное блюдо не должно было воскреснуть');
  } finally {
    await db.close();
  }
});

test('C4: восстановление категории через HQ-форму — выбор владельца (restore_items=1) уважается', async () => {
  const databaseUrl = await freshDatabase('op25_c4');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const cookie = await loginHq(base);
    const db = require('../../db/postgresql');
    const menuAdminService = require('../../services/hq/menuAdminService');
    const restId = await createRestaurant(db, 'Кафе К4');
    const category = await menuAdminService.createCategory(restId, { name: 'Салаты' });
    await menuAdminService.createMenuItem(restId, { name: 'Цезарь', category_id: category.id, price: 400 });
    await menuAdminService.archiveCategoryWithItems(restId, category.id);

    const archivePageRes = await fetch(`${base}/hq/restaurants/${restId}/menu/archive`, { headers: { Cookie: cookie } });
    const archiveHtml = await archivePageRes.text();
    assert.ok(archiveHtml.includes('Восстановить категорию и'), 'страница архива должна предлагать выбор при наличии связанных блюд');
    const csrf = extractCsrf(archiveHtml);

    const restoreRes = await fetch(`${base}/hq/restaurants/${restId}/menu/categories/${category.id}/restore`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrf, restore_items: '1' }).toString(),
    });
    assert.equal(restoreRes.status, 302);
    const items = await db.query('SELECT * FROM menu_items WHERE category_id = $1', [category.id]);
    assert.ok(items.every((i) => i.archived_at === null), 'блюда должны быть восстановлены вместе с категорией');
  } finally {
    await stopApp(instance);
  }
});

// ===========================================================================
// 4. Cache-Control на публичном API (закрытие Stage 24 MEDIUM-2)
// ===========================================================================

test('A1: GET /api/restaurants отдаёт Cache-Control: no-cache и сохраняет ETag', async () => {
  const databaseUrl = await freshDatabase('op25_a1');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const db = require('../../db/postgresql');
    await db.execute(`INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('Кафе А1','["Грозный"]',1,NOW())`);
    const res = await fetch(`${base}/api/restaurants`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.ok(res.headers.get('etag'), 'ETag должен по-прежнему присутствовать');
  } finally {
    await stopApp(instance);
  }
});

test('A2: GET /api/restaurants/:id тоже отдаёт Cache-Control: no-cache', async () => {
  const databaseUrl = await freshDatabase('op25_a2');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const db = require('../../db/postgresql');
    const r = await db.execute(`INSERT INTO restaurants (name, cities, is_open, published_at) VALUES ('Кафе А2','["Грозный"]',1,NOW()) RETURNING id`);
    const res = await fetch(`${base}/api/restaurants/${r.rows[0].id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  } finally {
    await stopApp(instance);
  }
});

test('A3: временно недоступное (стоп-лист) блюдо остаётся видимым клиенту со статусом недоступности, заказ его отклоняется', async () => {
  const databaseUrl = await freshDatabase('op25_a3');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const db = require('../../db/postgresql');
    const menuAdminService = require('../../services/hq/menuAdminService');
    const restId = await createRestaurant(db, 'Кафе А3');
    const category = await menuAdminService.createCategory(restId, { name: 'Основное' });
    const item = await menuAdminService.createMenuItem(restId, { name: 'Плов', category_id: category.id, price: 350 });
    await menuAdminService.setMenuItemAvailability(restId, item.id, false);

    const res = await fetch(`${base}/api/restaurants/${restId}`);
    const dto = await res.json();
    const found = (dto.menu || []).flatMap((c) => c.items || []).find((i) => i.id === item.id) || (dto.items || []).find((i) => i.id === item.id);
    assert.ok(found, 'стоп-листнутое блюдо должно оставаться в ответе API (видимо клиенту)');
    assert.equal(found.is_available, 0);
  } finally {
    await stopApp(instance);
  }
});

test('A4: архивированное блюдо и неопубликованный черновик ресторана скрыты из публичного API', async () => {
  const databaseUrl = await freshDatabase('op25_a4');
  const { instance, base } = await startApp(databaseUrl);
  try {
    const db = require('../../db/postgresql');
    const menuAdminService = require('../../services/hq/menuAdminService');
    const restId = await createRestaurant(db, 'Кафе А4');
    const category = await menuAdminService.createCategory(restId, { name: 'Основное' });
    const item = await menuAdminService.createMenuItem(restId, { name: 'Шашлык', category_id: category.id, price: 500 });
    await menuAdminService.archiveMenuItem(restId, item.id);
    const draftRestId = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ('Кафе-черновик','["Грозный"]') RETURNING id`);

    const res = await fetch(`${base}/api/restaurants/${restId}`);
    const dto = await res.json();
    const found = (dto.menu || []).flatMap((c) => c.items || []).find((i) => i.id === item.id) || (dto.items || []).find((i) => i.id === item.id);
    assert.ok(!found, 'архивированное блюдо не должно присутствовать в публичном API вовсе');

    const draftRes = await fetch(`${base}/api/restaurants/${draftRestId.rows[0].id}`);
    assert.equal(draftRes.status, 404, 'неопубликованный черновик должен вести себя как "не найден"');
  } finally {
    await stopApp(instance);
  }
});
