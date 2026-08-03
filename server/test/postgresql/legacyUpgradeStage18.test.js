'use strict';

// YAAM Stage 18 — безопасное обновление существующих staging-баз.
//
// Проверяется путь для реальной базы HQ уровня Stage 12: распознавание
// известного состояния, применение 0002 и 0003, сохранность данных и отказ
// на всём, что этому состоянию не соответствует.
//
// Схема Stage 12 берётся из НАСТОЯЩЕГО schema-only dump, снятого в Stage 17,
// а не воссоздаётся по памяти. Если dump недоступен, тесты честно
// пропускаются с указанием причины, а не подменяют его выдумкой.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const MIGRATIONS_DIR = path.join(__dirname, '../../db/postgresql/migrations');

// Dump НЕ коммитится: в нём структура реальной базы. Путь задаётся
// переменной YAAM_STAGE12_DUMP либо файлом в server/tmp/ (каталог в
// .gitignore). Машинно-специфичных абсолютных путей здесь нет намеренно —
// они превратили бы тест в работающий только на одном компьютере.
//
// Как получить dump (read-only, с сервера):
//   sudo -u postgres pg_dump -s yaam_hqtest > yaam_hqtest.schema.sql
// затем убрать psql-мета-команды, SET-преамбулу и ALTER ... OWNER TO /
// GRANT — они относятся к ролям конкретного сервера, а не к структуре.
const DUMP_PATH = process.env.YAAM_STAGE12_DUMP
  || path.join(__dirname, '../../tmp/yaam_hqtest.clean.sql');
const DUMP_AVAILABLE = fs.existsSync(DUMP_PATH);
const SKIP = DUMP_AVAILABLE ? undefined : {
  skip: `schema-only dump Stage 12 недоступен по пути ${DUMP_PATH}. `
    + 'Тесты legacy-обновления не выполнялись — восстанавливать схему по памяти нельзя.',
};

const MODULE_PATHS = [
  require.resolve('../../db/postgresql'),
  require.resolve('../../services/postgresql/migrator.js'),
];

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('legacy-stage18'); });
after(async () => { await cluster.stop(); });

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
function collectingLogger() {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)), warn: () => {}, error: () => {} };
}

function requireFresh() {
  for (const p of MODULE_PATHS) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    migrator: require('../../services/postgresql/migrator'),
  };
}

function migrationSql(file) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
}

// Поднимает базу в состоянии Stage 12 из настоящего dump.
async function legacyDatabase(name, { mutate = null } = {}) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(fs.readFileSync(DUMP_PATH, 'utf8'));
  if (mutate) await mutate(c);
  await c.end();
  return cluster.connectionString(name);
}

// Данные, которые обязаны пережить обновление. Значения намеренно
// узнаваемые: если что-то потеряется или перезапишется, это будет видно.
async function seedLegacyData(c) {
  await c.query(`INSERT INTO restaurants (name, cities, is_open, published_at)
                 VALUES ('Кафе До Обновления', '["Грозный"]', 1, NOW())`);
  const r = await c.query("SELECT id FROM restaurants WHERE name = 'Кафе До Обновления'");
  const rid = r.rows[0].id;
  await c.query(
    `INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, 'Горячее', 1)`, [rid],
  );
  const cat = await c.query('SELECT id FROM categories WHERE restaurant_id = $1', [rid]);
  await c.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available)
     VALUES ($1, $2, 'Шашлык до обновления', 600, 1)`, [rid, cat.rows[0].id],
  );
  await c.query(
    `INSERT INTO orders (public_code, restaurant_id, city, customer_name, customer_phone,
                         address, comment, items_total, commission_amount, status, status_updated_at)
     VALUES ('YAAM-L0001', $1, 'Грозный', 'Иса', '+79010000001', 'ул. Тестовая, 1', '',
             1000, 70, 'delivered', NOW())`, [rid],
  );
  const o = await c.query("SELECT id FROM orders WHERE public_code = 'YAAM-L0001'");
  await c.query(`INSERT INTO payments (order_id, amount, status) VALUES ($1, 1000, 'succeeded')`, [o.rows[0].id]);
  // Закрытый расчётный период Stage 8 — самая чувствительная к миграции часть.
  await c.query(`INSERT INTO settlement_periods (period_from, period_to, status, notes, created_by, closed_at)
                 VALUES ('2026-07-20', '2026-07-26', 'closed', 'до обновления', 'test', NOW())`);
  const p = await c.query('SELECT id FROM settlement_periods LIMIT 1');
  await c.query(
    `INSERT INTO settlement_restaurant_lines
       (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
        restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
        payout_readiness_snapshot, contract_number_snapshot)
     VALUES ($1, $2, 1, 1000, 70, 930, 0, 0, 930, 'ready', 'Д-1')`,
    [p.rows[0].id, rid],
  );
  return { restaurantId: rid, periodId: p.rows[0].id };
}

async function snapshotData(db) {
  const one = async (q) => (await db.query(q))[0];
  return {
    restaurants: (await one('SELECT count(*)::int n FROM restaurants')).n,
    menuItems: (await one('SELECT count(*)::int n FROM menu_items')).n,
    orders: (await one('SELECT count(*)::int n FROM orders')).n,
    payments: (await one('SELECT count(*)::int n FROM payments')).n,
    periods: (await one('SELECT count(*)::int n FROM settlement_periods')).n,
    lines: (await one('SELECT count(*)::int n FROM settlement_restaurant_lines')).n,
    restaurantName: (await one("SELECT name FROM restaurants WHERE name = 'Кафе До Обновления'") || {}).name,
    orderCode: (await one("SELECT public_code FROM orders WHERE public_code = 'YAAM-L0001'") || {}).public_code,
    payable: (await one('SELECT payable_amount FROM settlement_restaurant_lines LIMIT 1') || {}).payable_amount,
  };
}

// ===========================================================================
// 1-6. Основной путь обновления
// ===========================================================================

test('L1: схема Stage 12 распознаётся профилем hqtest_stage12', SKIP, async () => {
  const url = await legacyDatabase('lg_detect');
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();
  const client = await db.getPool().connect();
  try {
    // Текущему коду она НЕ соответствует — и это ожидаемо.
    const fp = await migrator.inspectSchemaFingerprint(client);
    assert.equal(fp.compatible, false, 'Stage 12 не должна выглядеть совместимой с текущим кодом');

    const { profile, report } = await migrator.detectLegacyProfile(client);
    assert.ok(profile, `профиль не распознан: ${JSON.stringify(report)}`);
    assert.equal(profile.name, 'hqtest_stage12');
    // Отмечается ТОЛЬКО baseline: hq_sessions в Stage 12 нет, поэтому 0002
    // обязана выполниться, а не быть отмеченной.
    assert.deepEqual(profile.adoptVersions, [migrator.BASELINE_VERSION]);
  } finally {
    client.release();
    await db.close();
  }
});

test('L2-L6: обновление применяет 0002 и 0003, схема становится зелёной, данные целы', SKIP, async () => {
  const url = await legacyDatabase('lg_upgrade', { mutate: seedLegacyData });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();

  // L2 — данные существуют ДО обновления.
  const before = await snapshotData(db);
  assert.equal(before.restaurants, 1);
  assert.equal(before.orders, 1);
  assert.equal(before.lines, 1);
  assert.equal(before.payable, 930);

  const logger = collectingLogger();
  const result = await migrator.migrate({ logger });

  // L3 — отмечена только доказанная миграция, остальные выполнены.
  const baseline = result.applied.find((a) => a.version === 1);
  assert.equal(baseline.adopted, true, 'baseline отмечается, а не выполняется');
  const m0002 = result.applied.find((a) => a.version === 2);
  const m0003 = result.applied.find((a) => a.version === 3);
  assert.equal(m0002.adopted, false, '0002 обязана быть ВЫПОЛНЕНА: hq_sessions в Stage 12 нет');
  assert.equal(m0003.adopted, false, '0003 обязана быть выполнена');

  // Решение об adoption залогировано и не содержит секретов.
  const log = logger.lines.join('\n');
  assert.match(log, /hqtest_stage12/);
  assert.match(log, /отмечаются как уже применённые: 1/);
  assert.ok(!/password|secret|token|postgres:\/\//i.test(log), 'в логе не должно быть секретов');

  // L4 — 0002 действительно создала hq_sessions.
  const sessions = await db.query("SELECT to_regclass('public.hq_sessions') IS NOT NULL AS has");
  assert.equal(sessions[0].has, true);

  // L5 — fingerprint полностью зелёный.
  const client = await db.getPool().connect();
  const fp = await migrator.inspectSchemaFingerprint(client);
  client.release();
  assert.equal(fp.compatible, true, `после обновления схема обязана быть совместимой: ${fp.missing}`);

  // L6 — все исходные данные сохранены.
  const after = await snapshotData(db);
  assert.deepEqual(after, before, 'обновление не должно изменять данные');

  // Новые колонки получили корректные значения на СУЩЕСТВУЮЩЕЙ строке.
  const line = (await db.query('SELECT * FROM settlement_restaurant_lines LIMIT 1'))[0];
  assert.equal(line.carry_forward_applied, 0);
  assert.equal(line.carry_forward_remaining, 0);
  assert.equal(line.refund_adjustment_restaurant_amount, 0);
  assert.equal(line.yaam_commission_net, 70, 'вычисляемая колонка посчитана на старой строке');
  assert.equal(line.payout_blocked_reason, null, 'payable_amount>0 и долга нет');

  // Новые audit-действия теперь принимаются базой (раньше CHECK их отвергал).
  await db.execute(
    `INSERT INTO hq_audit_log (action, restaurant_id, details, ip)
     VALUES ('fiscal_receipt_created', NULL, 'проверка после миграции', NULL)`,
  );
  await db.close();
});

test('L7: повторный запуск ничего не применяет', SKIP, async () => {
  const url = await legacyDatabase('lg_repeat', { mutate: seedLegacyData });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();
  const first = await migrator.migrate({ logger: quiet });
  assert.equal(first.applied.length, 4);
  const second = await migrator.migrate({ logger: quiet });
  assert.deepEqual(second.applied, []);
  const rows = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4]);
  await db.close();
});

test('L8: изменение 0003 после применения ловится контрольной суммой', SKIP, async () => {
  const url = await legacyDatabase('lg_checksum', { mutate: seedLegacyData });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();
  await migrator.migrate({ logger: quiet });
  await db.execute("UPDATE schema_migrations SET checksum = 'подменённая' WHERE version = 3");
  await assert.rejects(() => migrator.migrate({ logger: quiet }), /изменена после применения/);
  await db.close();
});

// ===========================================================================
// 9-11. Негативные сценарии: профиль обязан ОТКАЗЫВАТЬ
// ===========================================================================

test('L9: частично похожая схема профилю не соответствует и обновление останавливается', SKIP, async () => {
  // Убираем таблицу выплат — база перестаёт быть полноценной Stage 12.
  const url = await legacyDatabase('lg_partial', {
    mutate: async (c) => { await c.query('DROP TABLE payout_attempt_requisites, payout_attempts CASCADE'); },
  });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();

  const client = await db.getPool().connect();
  const { profile } = await migrator.detectLegacyProfile(client);
  client.release();
  assert.equal(profile, null, 'частично созданная база не должна распознаваться');

  await assert.rejects(
    () => migrator.migrate({ logger: quiet }),
    (err) => {
      assert.match(err.message, /не соответствует[\s\S]*известному прошлому состоянию/);
      assert.match(err.message, /Данные не изменены/);
      return true;
    },
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_name='schema_migrations'"))[0].n,
    1, 'таблица учёта создаётся, но записей в ней быть не должно',
  );
  assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations'))[0].n, 0);
  await db.close();
});

test('L10: неверный тип критической колонки отклоняется', SKIP, async () => {
  const url = await legacyDatabase('lg_type', {
    mutate: async (c) => {
      // items_total как TEXT вместо INTEGER: имя то же, смысл другой.
      await c.query('ALTER TABLE orders ALTER COLUMN items_total TYPE TEXT');
    },
  });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();
  const client = await db.getPool().connect();
  const { profile, report } = await migrator.detectLegacyProfile(client);
  client.release();
  assert.equal(profile, null, 'схема с неверным типом не должна распознаваться');
  const problems = report.find((r) => r.name === 'hqtest_stage12').problems.join('; ');
  assert.match(problems, /orders\.items_total имеет тип text/);
  await db.close();
});

test('L11: отсутствие критического триггера или ограничения отклоняется', SKIP, async () => {
  const noTrigger = await legacyDatabase('lg_notrigger', {
    mutate: async (c) => {
      await c.query('DROP TRIGGER trg_settlement_restaurant_lines_immutable ON settlement_restaurant_lines');
    },
  });
  process.env.DATABASE_URL = noTrigger;
  let ctx = requireFresh();
  let client = await ctx.db.getPool().connect();
  let res = await ctx.migrator.detectLegacyProfile(client);
  client.release();
  assert.equal(res.profile, null, 'без триггера неизменяемости профиль не должен совпадать');
  assert.match(
    res.report.find((r) => r.name === 'hqtest_stage12').problems.join('; '),
    /нет триггера trg_settlement_restaurant_lines_immutable/,
  );
  await ctx.db.close();

  const noConstraint = await legacyDatabase('lg_noconstraint', {
    mutate: async (c) => {
      await c.query('ALTER TABLE settlement_periods DROP CONSTRAINT settlement_periods_no_overlap');
    },
  });
  process.env.DATABASE_URL = noConstraint;
  ctx = requireFresh();
  client = await ctx.db.getPool().connect();
  res = await ctx.migrator.detectLegacyProfile(client);
  client.release();
  assert.equal(res.profile, null, 'без запрета пересечения периодов профиль не должен совпадать');
  assert.match(
    res.report.find((r) => r.name === 'hqtest_stage12').problems.join('; '),
    /нет ограничения settlement_periods_no_overlap/,
  );
  await ctx.db.close();
});

test('L11b: база, уже содержащая объекты Stage 13, профилю не соответствует', SKIP, async () => {
  // Профиль описывает ОДНО состояние. База «между» состояниями обязана
  // отвергаться, а не усыновляться наугад.
  const url = await legacyDatabase('lg_partial13', {
    mutate: async (c) => { await c.query('CREATE TABLE yaam_legal_details (id INTEGER PRIMARY KEY)'); },
  });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();
  const client = await db.getPool().connect();
  const { profile, report } = await migrator.detectLegacyProfile(client);
  client.release();
  assert.equal(profile, null);
  assert.match(
    report.find((r) => r.name === 'hqtest_stage12').problems.join('; '),
    /присутствует таблица yaam_legal_details/,
  );
  await db.close();
});

test('L11c: посторонняя таблица распознаванию не мешает', SKIP, async () => {
  const url = await legacyDatabase('lg_extra', {
    mutate: async (c) => { await c.query('CREATE TABLE ops_manual_notes (id INTEGER PRIMARY KEY, note TEXT)'); },
  });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();
  const client = await db.getPool().connect();
  const { profile } = await migrator.detectLegacyProfile(client);
  client.release();
  assert.ok(profile, 'лишний неопасный объект не должен ломать распознавание');
  assert.equal(profile.name, 'hqtest_stage12');
  await db.close();
});

// ===========================================================================
// 12-13. Атомарность и конкурентность
// ===========================================================================

test('L12: ошибка в середине 0003 откатывает миграцию полностью', SKIP, async () => {
  // Ломаем инвариант, который 0003 проверяет ЯВНО перед добавлением
  // CHECK-ограничения: строка, где payable_amount не равен restaurant_earnings.
  // Так проверяется сразу две вещи — что предохранитель срабатывает и что при
  // его срабатывании миграция откатывается целиком.
  const url = await legacyDatabase('lg_rollback', {
    mutate: async (c) => {
      await seedLegacyData(c);
      // Строки settlement_restaurant_lines неизменяемы триггером, поэтому
      // «испорченную» строку добавляем отдельной вставкой, а не UPDATE.
      const p = await c.query('SELECT id FROM settlement_periods LIMIT 1');
      const r = await c.query('SELECT id FROM restaurants LIMIT 1');
      await c.query(
        `INSERT INTO settlement_periods (period_from, period_to, status, notes, created_by, closed_at)
         VALUES ('2026-07-13','2026-07-19','closed','вторая','test',NOW())`,
      );
      const p2 = await c.query("SELECT id FROM settlement_periods WHERE period_from='2026-07-13'");
      await c.query(
        `INSERT INTO settlement_restaurant_lines
           (settlement_period_id, restaurant_id, delivered_paid_orders, turnover, yaam_commission,
            restaurant_earnings, successful_refunds_count, successful_refunds_amount, payable_amount,
            payout_readiness_snapshot, contract_number_snapshot)
         VALUES ($1, $2, 1, 1000, 70, 930, 0, 0, 555, 'ready', 'Д-2')`,
        [p2.rows[0].id, r.rows[0].id],
      );
      void p;
    },
  });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();

  await assert.rejects(
    () => migrator.migrate({ logger: quiet }),
    (err) => {
      assert.match(err.message, /не применена/);
      assert.match(err.message, /payable_amount/);
      assert.match(err.message, /Данные не изменены/);
      return true;
    },
  );

  // 0003 не отмечена. 0002 прошла до неё и отмечена — у каждой миграции своя
  // транзакция, и это правильное поведение: откатывается ровно упавшая.
  const versions = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
  assert.ok(!versions.includes(3), '0003 не должна считаться применённой');
  assert.deepEqual(versions, [1, 2]);

  // Ни одного объекта из 0003 не осталось: транзакция откатилась целиком.
  for (const t of ['settlement_adjustments', 'settlement_documents', 'yaam_legal_details', 'fiscal_receipts']) {
    const r = await db.query(`SELECT to_regclass('public.${t}') IS NOT NULL AS has`);
    assert.equal(r[0].has, false, `частично созданная таблица ${t}`);
  }
  // Данные целы.
  assert.equal((await db.query('SELECT count(*)::int n FROM orders'))[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM settlement_restaurant_lines'))[0].n, 2);
  await db.close();
});

test('L13: конкурентный запуск применяет каждую миграцию один раз', SKIP, async () => {
  const url = await legacyDatabase('lg_concurrent', { mutate: seedLegacyData });
  process.env.DATABASE_URL = url;
  const { db, migrator } = requireFresh();

  const results = await Promise.all([
    migrator.migrate({ logger: quiet }),
    migrator.migrate({ logger: quiet }),
    migrator.migrate({ logger: quiet }),
  ]);
  const total = results.reduce((n, r) => n + r.applied.length, 0);

  const rows = await db.query('SELECT version, count(*)::int n FROM schema_migrations GROUP BY version ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4]);
  assert.ok(rows.every((r) => r.n === 1), 'каждая версия записана ровно один раз');
  assert.equal(total, 4, 'суммарно применено ровно четыре миграции');
  await db.close();
});

// ===========================================================================
// 14-15. Пустая база и согласованность справочника
// ===========================================================================

test('L14: пустая база проходит строго 0001 -> 0002 -> 0003 -> 0004', async () => {
  await cluster.createDatabase('lg_empty');
  process.env.DATABASE_URL = cluster.connectionString('lg_empty');
  const { db, migrator } = requireFresh();

  const result = await migrator.migrate({ logger: quiet });
  assert.deepEqual(result.applied.map((a) => a.version), [1, 2, 3, 4]);
  // На пустой базе НИЧЕГО не отмечается — всё выполняется.
  assert.ok(result.applied.every((a) => a.adopted === false));

  const client = await db.getPool().connect();
  const fp = await migrator.inspectSchemaFingerprint(client);
  client.release();
  assert.equal(fp.compatible, true, `после цепочки схема обязана быть совместимой: ${fp.missing}`);
  await db.close();
});

test('L15: schema.sql соответствует итоговой цепочке миграций', async () => {
  // Справочник и цепочка обязаны описывать одну схему. Расхождение означает,
  // что человек принимает решения по устаревшей картине.
  await cluster.createDatabase('lg_ref_schema');
  await cluster.createDatabase('lg_ref_chain');

  const schemaClient = cluster.getClient('lg_ref_schema');
  await schemaClient.connect();
  await schemaClient.query(fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8'));

  const chainClient = cluster.getClient('lg_ref_chain');
  await chainClient.connect();
  for (const f of ['0001_baseline.sql', '0002_hq_sessions.sql', '0003_stage13_stage14_upgrade.sql']) {
    await chainClient.query(migrationSql(f));
  }

  const objects = async (c) => {
    const q = async (sql) => (await c.query(sql)).rows.map((r) => Object.values(r)[0]);
    return {
      tables: await q(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY 1`),
      columns: await q(`SELECT table_name||'.'||column_name||':'||data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY 1`),
      functions: await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`),
      triggers: await q('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1'),
    };
  };
  const fromSchema = await objects(schemaClient);
  const fromChain = await objects(chainClient);
  await schemaClient.end();
  await chainClient.end();

  for (const key of Object.keys(fromSchema)) {
    assert.deepEqual(fromChain[key], fromSchema[key], `${key}: цепочка миграций разошлась со schema.sql`);
  }
});

test('L16: 0003 не содержит разрушающих операций и не трогает hq_sessions', () => {
  const sql = migrationSql('0003_stage13_stage14_upgrade.sql');
  // Комментарии из проверки исключаем: речь про исполняемый SQL.
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  assert.ok(!/\bDROP\s+TABLE\b/i.test(code), 'DROP TABLE недопустим');
  assert.ok(!/\bDROP\s+COLUMN\b/i.test(code), 'DROP COLUMN недопустим');
  assert.ok(!/\bTRUNCATE\b/i.test(code), 'TRUNCATE недопустим');
  assert.ok(!/\bDELETE\s+FROM\b/i.test(code), 'DELETE FROM недопустим');
  // hq_sessions создаёт 0002; дубль в 0003 прятался бы за IF NOT EXISTS.
  assert.ok(!/hq_sessions/.test(code), '0003 не должна создавать hq_sessions');
  // Собственных BEGIN/COMMIT нет: транзакцию даёт runner.
  assert.ok(!/^BEGIN;/m.test(code));
  assert.ok(!/^COMMIT;/m.test(code));

  const { migrator } = requireFresh();
  const files = migrator.listMigrationFiles();
  assert.deepEqual(files.map((f) => f.version), [1, 2, 3, 4]);
  const m3 = files.find((f) => f.version === 3);
  assert.doesNotThrow(() => migrator.assertNotSilentlyDestructive(m3));
  // 0004 (Stage 19.1) — только расширение CHECK-списка аудита: ни одной
  // разрушающей операции и ни одного касания финансовых таблиц.
  const m4 = files.find((f) => f.version === 4);
  assert.doesNotThrow(() => migrator.assertNotSilentlyDestructive(m4));
  const sql4 = migrationSql('0004_settlement_week_blocked_audit.sql');
  const code4 = sql4.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/settlement_periods|settlement_restaurant_lines|restaurant_payouts/.test(code4),
    '0004 не должна касаться финансовых таблиц');
  assert.match(code4, /'settlement_week_blocked'/);
});
