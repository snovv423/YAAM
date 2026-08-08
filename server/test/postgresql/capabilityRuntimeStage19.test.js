'use strict';

// YAAM Stage 19.2 — capability-ссылки на расчётные документы в RUNTIME.
//
// До этого этапа механизм существовал и был покрыт тестами, но ни один
// работающий путь приложения его не вызывал: publicBaseUrl никто не передавал,
// поэтому ссылки не выдавались никогда. Здесь проверяется именно РАБОТАЮЩИЙ
// путь: закрытие периода еженедельным job -> документы -> ссылка -> открытие.
//
// C — runtime-выдача и её границы.
// R — повторные запуски и предел числа действующих ссылок.
// L — отсутствие токена в логах и аудите.
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
  require.resolve('../../services/postgresql/scheduler.js'),
  require.resolve('../../routes/postgresql/settlementDocuments.js'),
];

const FICT = {
  BIK: '044999225', RS: '40702810938050001238', KS: '30101810400000004565',
  INN12: '770912345616', INN10: '7709123453', KPP: '770101001', OGRNIP: '312770012345008',
};

const BASE_URL = 'https://hqtest.example.test';

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('capability-runtime'); });
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
    documentService: require('../../services/hq/settlementDocumentService'),
    accessService: require('../../services/hq/settlementDocumentAccessService'),
    notificationService: require('../../services/hq/settlementNotificationService'),
    createPostgresqlApp: require('../../services/postgresql/app').createPostgresqlApp,
  };
}

function msk(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0) - 180 * 60 * 1000);
}

// Бот, который НИЧЕГО не отправляет наружу: запоминает вызовы, чтобы тест мог
// доказать и что отправка была бы, и что реального сообщения не ушло.
function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendMessage(chatId, text, extra) {
      calls.push({ chatId, text, extra });
      return { message_id: calls.length };
    },
  };
}

let counter = 0;
async function createRestaurant(db, name, chatId = null) {
  const r = await db.execute(
    `INSERT INTO restaurants (name, cities, is_open, published_at, telegram_chat_id)
     VALUES ($1,'["Грозный"]',1,NOW(),$2) RETURNING id`,
    [name, chatId],
  );
  return r.rows[0].id;
}

async function order(db, restaurantId, { itemsTotal, commissionAmount, deliveredAt }) {
  counter += 1;
  // Stage 33.1 — earned_at теперь единственный якорь финансового времени;
  // эта фикстура всегда создаёт 'delivered' напрямую SQL, поэтому earned_at
  // безусловно равен тому же deliveredAt, что и status_updated_at (тот же
  // принцип, что и backfill в миграции 0013).
  const o = await db.execute(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone, address, comment,
                         items_total, commission_amount, status, status_updated_at, earned_at)
     VALUES ($1,$2,'Грозный','Иса Магомадов',$3,'ул. Тестовая, 5','',$4,$5,'delivered',$6,$6) RETURNING id`,
    [`YAAM-R${String(counter).padStart(4, '0')}`, restaurantId,
      `+7903${String(counter).padStart(7, '0')}`, itemsTotal, commissionAmount, deliveredAt],
  );
  await db.execute(
    `INSERT INTO payments (order_id, amount, status) VALUES ($1,$2,'succeeded')`,
    [o.rows[0].id, itemsTotal],
  );
  return o.rows[0].id;
}

async function seedYaam(db) {
  await db.execute(
    `INSERT INTO yaam_bank_details (id, legal_name, inn, kpp, account_number, bik, bank_name, correspondent_account)
     VALUES (1,'ООО ЯАМ Платформа',$1,$2,$3,$4,'ТЕСТБАНК',$5) ON CONFLICT (id) DO NOTHING`,
    [FICT.INN10, FICT.KPP, FICT.RS, FICT.BIK, FICT.KS],
  );
}

async function seedLegal(db, restaurantId, legalName = 'ИП Рантаймов Р. Р.') {
  await db.execute(
    `INSERT INTO restaurant_legal_details
       (restaurant_id, legal_form, legal_name, inn, ogrn, legal_address, director_name, contact_phone)
     VALUES ($1,'ip',$2,$3,$4,'г. Грозный, ул. Тестовая, 1','Рантаймов Р. Р.','+79280000003')`,
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

// Перехват console: доказать, что полный токен не попал ни в один вывод.
function captureConsole() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => { lines.push(args.map(String).join(' ')); };
  }
  return {
    lines,
    restore() {
      console.log = original.log; console.warn = original.warn; console.error = original.error;
    },
  };
}

// Общая подготовка: ресторан с подключённой группой, оплаченный доставленный
// заказ в неделе 27.07–02.08, закрытие job после планового момента.
async function seedClosedPeriod(dbName, { chatId = 'chat-runtime', publicBaseUrl = BASE_URL } = {}) {
  const url = await freshDatabase(dbName);
  process.env.DATABASE_URL = url;
  const mods = requireFresh();
  const { db, weekly } = mods;
  const restId = await createRestaurant(db, 'Кафе Рантайм', chatId);
  await seedYaam(db);
  await seedLegal(db, restId);
  await order(db, restId, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });

  const bot = fakeBot();
  const result = await weekly.runWeeklySettlementJob({
    now: msk(2026, 8, 3, 7, 5), bot, publicBaseUrl,
  });
  return { ...mods, restId, bot, result };
}

// Достаёт ссылки из inline-клавиатуры отправленного сообщения — ровно то, что
// увидел бы ресторан.
function linksFrom(botCall) {
  const kb = botCall && botCall.extra && botCall.extra.reply_markup
    ? botCall.extra.reply_markup.inline_keyboard : null;
  return kb ? kb.flat() : [];
}

// ===========================================================================
// C — runtime-выдача
// ===========================================================================

test('C1: закрытие периода планировщиком создаёт документы и выдаёт рабочие ссылки', async () => {
  const { db, restId, bot, result, documentService } = await seedClosedPeriod('cap_c1');
  try {
    assert.equal(result.closed.length, 1, 'период закрыт');
    const periodId = result.closed[0].periodId;

    // 1. Документы созданы.
    const docs = await documentService.listDocumentsForPeriod(periodId);
    assert.equal(docs.length, 2, 'акт и реестр');
    assert.ok(docs.every((d) => d.status === 'generated'));

    // 2. Runtime-путь получил publicBaseUrl и дошёл до отправки.
    assert.equal(result.notified.length, 1);
    assert.equal(result.notified[0].sent, true, `уведомление не ушло: ${result.notified[0].reason}`);
    assert.equal(bot.calls.length, 1);

    // 3. Для документов выпущены ссылки вида /d/<token>.
    const links = linksFrom(bot.calls[0]);
    assert.equal(links.length, 2, 'по ссылке на каждый документ');
    for (const l of links) {
      assert.match(l.url, new RegExp(`^${BASE_URL}/d/yaam_doc_v1_[A-Za-z0-9_-]{43}$`));
    }

    // 4. В базе только хэш: открытого токена нет ни в одной колонке.
    const tokens = await db.query('SELECT * FROM settlement_document_access_tokens ORDER BY id');
    assert.equal(tokens.length, 2);
    const rawTokens = links.map((l) => l.url.split('/d/')[1]);
    const dump = JSON.stringify(tokens);
    for (const raw of rawTokens) {
      assert.ok(!dump.includes(raw), 'открытый токен не должен храниться в базе');
    }
    const crypto = require('node:crypto');
    for (const raw of rawTokens) {
      const expected = crypto.createHash('sha256').update(raw, 'utf8').digest();
      assert.ok(tokens.some((t) => Buffer.compare(t.token_hash, expected) === 0),
        'в базе обязан лежать sha256 выданного токена');
    }
    assert.equal(tokens[0].token_hash.length, 32, 'sha256 = 32 байта');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C2: ссылка открывает РОВНО свой документ, чужой и испорченный токен — 404', async () => {
  const { db, bot, result, accessService, createPostgresqlApp } = await seedClosedPeriod('cap_c2');
  let instance = null;
  try {
    const links = linksFrom(bot.calls[0]);
    const rawTokens = links.map((l) => l.url.split('/d/')[1]);

    const app = createPostgresqlApp({
      port: 0, host: '127.0.0.1',
      schedulerIntervalMs: 1_000_000,
      weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
    });
    await app.start();
    instance = app;
    const deadline = Date.now() + 3000;
    while (!app.address() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    const base = `http://127.0.0.1:${app.address().port}`;

    // Своя ссылка открывает свой документ.
    const ok = await fetch(`${base}/d/${rawTokens[0]}`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.ok(!html.includes(rawTokens[0]), 'токен не возвращается в теле страницы');
    assert.equal(ok.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');

    // Две ссылки ведут на РАЗНЫЕ документы, а не на один и тот же.
    const second = await fetch(`${base}/d/${rawTokens[1]}`);
    assert.equal(second.status, 200);
    assert.notEqual(await second.text(), html, 'разные документы обязаны отличаться');

    // Изменённый токен: тот же префикс и длина, но другое содержимое.
    const tampered = rawTokens[0].slice(0, -1) + (rawTokens[0].endsWith('A') ? 'B' : 'A');
    assert.equal((await fetch(`${base}/d/${tampered}`)).status, 404);

    // Формально валидный, но никем не выданный.
    assert.equal((await fetch(`${base}/d/${accessService.generateToken()}`)).status, 404);

    // Мусор.
    assert.equal((await fetch(`${base}/d/не-токен`)).status, 404);
  } finally {
    if (instance) await instance.stop();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C3: истёкшая ссылка — 410, отозванная — 410', async () => {
  const { db, bot, accessService, createPostgresqlApp } = await seedClosedPeriod('cap_c3');
  let instance = null;
  try {
    const links = linksFrom(bot.calls[0]);
    const rawTokens = links.map((l) => l.url.split('/d/')[1]);

    const app = createPostgresqlApp({
      port: 0, host: '127.0.0.1',
      schedulerIntervalMs: 1_000_000,
      weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
    });
    await app.start();
    instance = app;
    const deadline = Date.now() + 3000;
    while (!app.address() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    const base = `http://127.0.0.1:${app.address().port}`;

    // Истечение имитируем сдвигом ОБЕИХ отметок в прошлое: ограничение схемы
    // требует expires_at > created_at, поэтому «просроченный» токен — это
    // выданный раньше и уже отживший срок, а не выданный задним числом.
    const hash = require('node:crypto').createHash('sha256').update(rawTokens[0], 'utf8').digest();
    await db.execute(
      `UPDATE settlement_document_access_tokens
          SET created_at = NOW() - INTERVAL '40 days',
              expires_at = NOW() - INTERVAL '10 days'
        WHERE token_hash = $1`,
      [hash],
    );
    assert.equal((await fetch(`${base}/d/${rawTokens[0]}`)).status, 410, 'истёкшая ссылка');

    // Отзыв второй.
    const rows = await db.query(
      'SELECT id FROM settlement_document_access_tokens WHERE token_hash = $1',
      [require('node:crypto').createHash('sha256').update(rawTokens[1], 'utf8').digest()],
    );
    await accessService.revokeToken(rows[0].id);
    assert.equal((await fetch(`${base}/d/${rawTokens[1]}`)).status, 410, 'отозванная ссылка');
  } finally {
    if (instance) await instance.stop();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C4: без PUBLIC_BACKEND_URL ссылка не выдаётся и токены не тратятся', async () => {
  // Пустая база, испорченное и относительное значение — ни одно не должно
  // превратиться в ссылку и ни одно не должно выпустить токен.
  for (const [name, badBase] of [
    ['cap_c4_empty', null],
    ['cap_c4_relative', '/api'],
    ['cap_c4_garbage', 'не-адрес'],
    ['cap_c4_scheme', 'ftp://files.example.test'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const { db, bot, result } = await seedClosedPeriod(name, { publicBaseUrl: badBase });
    try {
      assert.equal(result.closed.length, 1, `${name}: период всё равно закрывается`);
      // Сообщение уходит — документы готовы, — но без ссылок.
      assert.equal(bot.calls.length, 1, `${name}: уведомление отправлено`);
      assert.equal(linksFrom(bot.calls[0]).length, 0, `${name}: ссылок быть не должно`);
      // eslint-disable-next-line no-await-in-loop
      const tokens = await db.query('SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens');
      assert.equal(tokens[0].n, 0, `${name}: ни одного выпущенного токена`);
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await db.close();
      delete process.env.DATABASE_URL;
    }
  }
});

test('C5: Telegram выключен — реальной отправки нет, токены не выпускаются, период цел', async () => {
  const url = await freshDatabase('cap_c5');
  process.env.DATABASE_URL = url;
  const { db, weekly, documentService } = requireFresh();
  try {
    const restId = await createRestaurant(db, 'Кафе Без Бота', 'chat-c5');
    await seedYaam(db);
    await seedLegal(db, restId);
    await order(db, restId, { itemsTotal: 800, commissionAmount: 56, deliveredAt: msk(2026, 7, 29, 12, 0) });

    // bot = null — ровно то состояние, в котором работает hqtest.
    const result = await weekly.runWeeklySettlementJob({
      now: msk(2026, 8, 3, 7, 5), bot: null, publicBaseUrl: BASE_URL,
    });

    // Финансовая часть выполнена полностью.
    assert.equal(result.closed.length, 1);
    const periodId = result.closed[0].periodId;
    const period = await db.query('SELECT status FROM settlement_periods WHERE id = $1', [periodId]);
    assert.equal(period[0].status, 'closed');
    assert.equal((await documentService.listDocumentsForPeriod(periodId)).length, 2);

    // Runtime честно сообщил, почему не отправил.
    assert.equal(result.notified.length, 1);
    assert.equal(result.notified[0].sent, false);
    assert.equal(result.notified[0].reason, 'bot_unavailable');

    // Токены не выпускались: отдавать ссылку некуда.
    const tokens = await db.query('SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens');
    assert.equal(tokens[0].n, 0, 'без канала доставки токен выпускать незачем');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('C6: ссылка не выдаётся другому ресторану', async () => {
  const url = await freshDatabase('cap_c6');
  process.env.DATABASE_URL = url;
  const { db, weekly, documentService } = requireFresh();
  try {
    const a = await createRestaurant(db, 'Кафе А', 'chat-a');
    const b = await createRestaurant(db, 'Кафе Б', 'chat-b');
    await seedYaam(db);
    await seedLegal(db, a, 'ИП Первый П. П.');
    await seedLegal(db, b, 'ИП Второй В. В.');
    await order(db, a, { itemsTotal: 1000, commissionAmount: 70, deliveredAt: msk(2026, 7, 29, 12, 0) });
    await order(db, b, { itemsTotal: 500, commissionAmount: 35, deliveredAt: msk(2026, 7, 30, 12, 0) });

    const bot = fakeBot();
    const result = await weekly.runWeeklySettlementJob({
      now: msk(2026, 8, 3, 7, 5), bot, publicBaseUrl: BASE_URL,
    });
    assert.equal(result.closed.length, 1);
    assert.equal(bot.calls.length, 2, 'по сообщению каждому ресторану');

    // Каждое сообщение ушло в свой чат и содержит ссылки ТОЛЬКО на свои документы.
    const periodId = result.closed[0].periodId;
    const docs = await documentService.listDocumentsForPeriod(periodId);
    const crypto = require('node:crypto');

    for (const [chatId, restaurantId] of [['chat-a', a], ['chat-b', b]]) {
      const call = bot.calls.find((c) => c.chatId === chatId);
      assert.ok(call, `сообщение для ${chatId}`);
      const links = linksFrom(call);
      assert.equal(links.length, 2);
      const mine = new Set(docs.filter((d) => d.restaurant_id === restaurantId).map((d) => d.id));
      for (const l of links) {
        const raw = l.url.split('/d/')[1];
        // eslint-disable-next-line no-await-in-loop
        const rows = await db.query(
          'SELECT document_id, restaurant_id FROM settlement_document_access_tokens WHERE token_hash = $1',
          [crypto.createHash('sha256').update(raw, 'utf8').digest()],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].restaurant_id, restaurantId, 'токен привязан к своему ресторану');
        assert.ok(mine.has(rows[0].document_id), 'ссылка ведёт только на свой документ');
      }
    }
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// R — повторные запуски и предел действующих ссылок
// ===========================================================================

test('R1: повторный запуск job не выпускает новых токенов', async () => {
  const { db, weekly, bot } = await seedClosedPeriod('cap_r1');
  try {
    const after1 = await db.query('SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens');
    assert.equal(after1[0].n, 2, 'первое закрытие выпустило по токену на документ');
    assert.equal(bot.calls.length, 1);

    // Ещё три прогона на том же состоянии.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const again = await weekly.runWeeklySettlementJob({
        now: msk(2026, 8, 3, 8, 0), bot, publicBaseUrl: BASE_URL,
      });
      assert.equal(again.closed.length, 0, 'закрывать нечего');
      assert.equal(again.notified.length, 0, 'уведомлять повторно не о чем');
    }

    const after4 = await db.query('SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens');
    assert.equal(after4[0].n, 2, 'число токенов не изменилось');
    assert.equal(bot.calls.length, 1, 'повторных сообщений не было');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('R2: у документа не может накопиться больше предела действующих ссылок', async () => {
  const { db, accessService, documentService, result } = await seedClosedPeriod('cap_r2');
  try {
    const periodId = result.closed[0].periodId;
    const doc = (await documentService.listDocumentsForPeriod(periodId))[0];
    const limit = accessService.MAX_ACTIVE_TOKENS_PER_DOCUMENT;
    assert.ok(Number.isInteger(limit) && limit >= 1);

    // Многократная повторная выдача — как если бы уведомление слали снова и снова.
    const issued = [];
    for (let i = 0; i < limit + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      issued.push(await accessService.issueToken(doc.id));
    }
    assert.ok(issued.every((x) => x && x.token), 'выдача не отказывает');

    // Действующих — ровно предел, не больше.
    const active = await accessService.countActiveTokens(doc.id);
    assert.equal(active, limit, `действующих ссылок должно быть ${limit}`);

    // Последняя выданная обязана работать, самая первая — нет.
    const resolvedLast = await accessService.resolveToken(issued[issued.length - 1].token);
    assert.equal(resolvedLast.ok, true, 'последняя ссылка рабочая');
    const resolvedFirst = await accessService.resolveToken(issued[0].token);
    assert.equal(resolvedFirst.ok, false);
    assert.equal(resolvedFirst.reason, 'revoked', 'самая старая отозвана, а не удалена');

    // История выдач сохранена целиком — аудиту есть что показать.
    const all = await db.query(
      'SELECT COUNT(*)::int AS n FROM settlement_document_access_tokens WHERE document_id = $1', [doc.id],
    );
    assert.equal(all[0].n, 1 + limit + 5, 'строки не удаляются, только отзываются');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('R3: сбой уведомления не откатывает закрытый период и фиксируется без токена', async () => {
  const url = await freshDatabase('cap_r3');
  process.env.DATABASE_URL = url;
  const { db, weekly, documentService } = requireFresh();
  const cap = captureConsole();
  try {
    const restId = await createRestaurant(db, 'Кафе Сбой', 'chat-r3');
    await seedYaam(db);
    await seedLegal(db, restId);
    await order(db, restId, { itemsTotal: 1200, commissionAmount: 84, deliveredAt: msk(2026, 7, 29, 12, 0) });

    // Бот, который всегда падает.
    const failing = { sendMessage: async () => { throw new Error('network down'); } };
    const result = await weekly.runWeeklySettlementJob({
      now: msk(2026, 8, 3, 7, 5), bot: failing, publicBaseUrl: BASE_URL,
    });

    // Период закрыт и остался закрытым.
    assert.equal(result.closed.length, 1);
    const periodId = result.closed[0].periodId;
    const period = await db.query('SELECT status, closed_at FROM settlement_periods WHERE id = $1', [periodId]);
    assert.equal(period[0].status, 'closed');
    assert.ok(period[0].closed_at, 'closed_at зафиксирован');

    // Финансовые строки на месте и не пострадали.
    const lines = await db.query(
      'SELECT turnover, yaam_commission, payable_amount FROM settlement_restaurant_lines WHERE settlement_period_id = $1',
      [periodId],
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].turnover, 1200);
    assert.equal(lines[0].payable_amount, 1200 - 84);

    // Документы существуют.
    assert.equal((await documentService.listDocumentsForPeriod(periodId)).length, 2);

    // Сбой честно зафиксирован.
    assert.equal(result.notified[0].sent, false);
    assert.equal(result.notified[0].reason, 'send_failed');
    const audit = await db.query(
      "SELECT details FROM hq_audit_log WHERE action = 'settlement_notification_failed'",
    );
    assert.equal(audit.length, 1);
    assert.match(audit[0].details, /network down/);

    // И ни в аудите, ни в консоли нет токена.
    const tokens = await db.query('SELECT id FROM settlement_document_access_tokens');
    assert.ok(tokens.length > 0, 'токены были выпущены до попытки отправки');
    assert.ok(!audit.some((r) => /yaam_doc_v1_/.test(r.details)), 'токена в аудите быть не должно');
    assert.ok(!cap.lines.some((l) => /yaam_doc_v1_/.test(l)), 'токена в логах быть не должно');
  } finally {
    cap.restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// L — токен не попадает в вывод
// ===========================================================================

test('L1: полный токен отсутствует во всех перехваченных логах и в аудите', async () => {
  const url = await freshDatabase('cap_l1');
  process.env.DATABASE_URL = url;
  const { db, weekly, createPostgresqlApp } = requireFresh();
  const cap = captureConsole();
  let instance = null;
  let rawTokens = [];
  try {
    const restId = await createRestaurant(db, 'Кафе Логи', 'chat-l1');
    await seedYaam(db);
    await seedLegal(db, restId);
    await order(db, restId, { itemsTotal: 900, commissionAmount: 63, deliveredAt: msk(2026, 7, 29, 12, 0) });

    const bot = fakeBot();
    await weekly.runWeeklySettlementJob({ now: msk(2026, 8, 3, 7, 5), bot, publicBaseUrl: BASE_URL });
    rawTokens = linksFrom(bot.calls[0]).map((l) => l.url.split('/d/')[1]);
    assert.equal(rawTokens.length, 2);

    // HTTP-обращения по ссылке — именно они раньше и печатали токен в
    // access-лог приложения (дефект, найденный на живом staging).
    const app = createPostgresqlApp({
      port: 0, host: '127.0.0.1',
      schedulerIntervalMs: 1_000_000,
      weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
    });
    await app.start();
    instance = app;
    const deadline = Date.now() + 3000;
    while (!app.address() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    const base = `http://127.0.0.1:${app.address().port}`;
    await fetch(`${base}/d/${rawTokens[0]}`);
    await fetch(`${base}/d/${rawTokens[1]}`);
    await fetch(`${base}/d/${rawTokens[0]}x`);

    const joined = cap.lines.join('\n');
    for (const raw of rawTokens) {
      assert.ok(!joined.includes(raw), 'полный токен не должен попадать в вывод приложения');
    }
    // Маршрут при этом виден — наблюдаемость не потеряна.
    assert.ok(/\/d\/:token/.test(joined), 'в логе обязан остаться обезличенный маршрут');

    const audit = await db.query('SELECT details FROM hq_audit_log WHERE details IS NOT NULL');
    for (const raw of rawTokens) {
      assert.ok(!audit.some((r) => r.details.includes(raw)), 'полный токен не должен попадать в аудит');
    }
  } finally {
    if (instance) await instance.stop();
    cap.restore();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
