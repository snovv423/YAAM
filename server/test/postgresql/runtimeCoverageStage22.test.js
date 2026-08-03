'use strict';

// YAAM Stage 22 — защита от повторения найденного паттерна.
//
// Трижды в проекте повторялась одна и та же ошибка: сервис написан, покрыт
// тестами, выглядит готовым — и не вызывается ниоткуда, кроме тестов.
// Так были не подключены capability-ссылки на документы (Stage 19.2),
// контроль расчётных инвариантов и фискализация (Stage 21, CRITICAL-2).
//
// Наивный grep доказательством не считается: он находит и строку в
// комментарии, и мёртвый импорт. Поэтому проверка идёт двумя способами:
//   1) СБОРКА ПРИЛОЖЕНИЯ — реально создаём app и смотрим, что планировщики
//      существуют и запускаются;
//   2) РЕАЛЬНЫЙ ВЫЗОВ — дергаем runtime-обёртку и убеждаемся, что она ведёт
//      в нужный сервис (через подмену модуля в require.cache).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

let cluster;
before(async () => { cluster = await startEmbeddedPostgres('runtime-coverage'); });
after(async () => { await cluster.stop(); });

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const c = cluster.getClient(name);
  await c.connect();
  await c.query(SCHEMA_SQL);
  await c.end();
  return cluster.connectionString(name);
}

// Модули, которые обязаны быть достижимы из работающего приложения.
const CRITICAL_MODULES = [
  '../../services/postgresql/paymentReconciliationService.js',
  '../../services/postgresql/webhookRejectionService.js',
  '../../services/hq/settlementInvariantMonitor.js',
  '../../services/hq/settlementDocumentService.js',
  '../../services/hq/settlementNotificationService.js',
  '../../services/fiscalization/fiscalReceiptService.js',
  '../../services/hq/weeklySettlementService.js',
];

function freshApp() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}server${path.sep}services${path.sep}`)
      || key.includes(`${path.sep}server${path.sep}routes${path.sep}`)
      || key.includes(`${path.sep}server${path.sep}db${path.sep}`)) {
      delete require.cache[key];
    }
  }
  return require('../../services/postgresql/app');
}

test('RC1: сборка приложения поднимает ВСЕ финансовые планировщики', async () => {
  process.env.DATABASE_URL = await freshDatabase('rc_app');
  const appModule = freshApp();
  const instance = appModule.createPostgresqlApp({
    port: 0, host: '127.0.0.1',
    schedulerIntervalMs: 1_000_000,
    orderTimeoutIntervalMs: 1_000_000,
    refundReconciliationIntervalMs: 1_000_000,
    weeklySettlementIntervalMs: 1_000_000, weeklySettlementRunOnStart: false,
    paymentReconciliationIntervalMs: 1_000_000, paymentReconciliationRunOnStart: false,
    financialHealthIntervalMs: 1_000_000, financialHealthRunOnStart: false,
  });
  try {
    await instance.start();
    const deadline = Date.now() + 3000;
    while (!instance.address() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    const readiness = await instance.health.readiness();

    // Шесть планировщиков: пауза, таймаут заказа, сверка возвратов,
    // еженедельный расчёт, сверка ПЛАТЕЖЕЙ, финансовое здоровье.
    assert.equal(readiness.schedulers.length, 6, 'должно быть шесть планировщиков');
    assert.ok(readiness.schedulers.every((s) => s.running === true),
      'все планировщики обязаны быть запущены');

    // Финансовая готовность — отдельное наблюдаемое поле.
    assert.ok(readiness.financial, 'readiness обязан показывать финансовую готовность');
    assert.ok(['ok', 'degraded', 'unknown'].includes(readiness.financial.state));
  } finally {
    await instance.stop();
    delete process.env.DATABASE_URL;
  }
});

test('RC2: каждый критический сервис реально вызывается из runtime, а не только из тестов', async () => {
  // Метод: подменяем экспорт модуля счётчиком и дёргаем runtime-обёртку.
  // Если обёртка ведёт не туда, счётчик останется нулевым — grep такого не
  // покажет.
  process.env.DATABASE_URL = await freshDatabase('rc_calls');
  freshApp();

  const calls = { reconcile: 0, invariants: 0, docRetry: 0, receipt: 0, rejection: 0 };

  const reconcilePath = require.resolve('../../services/postgresql/paymentReconciliationService');
  require(reconcilePath);
  require.cache[reconcilePath].exports.runPaymentReconciliation = async () => { calls.reconcile += 1; return {}; };

  const monitorPath = require.resolve('../../services/hq/settlementInvariantMonitor');
  require(monitorPath);
  require.cache[monitorPath].exports.runInvariantCheck = async () => { calls.invariants += 1; return { ok: true }; };

  const docPath = require.resolve('../../services/hq/settlementDocumentService');
  require(docPath);
  require.cache[docPath].exports.retryMissingDocuments = async () => { calls.docRetry += 1; return {}; };

  const fiscalPath = require.resolve('../../services/fiscalization/fiscalReceiptService');
  require(fiscalPath);
  require.cache[fiscalPath].exports.enqueueReceipt = async () => { calls.receipt += 1; return { receipt: null }; };

  const rejectionPath = require.resolve('../../services/postgresql/webhookRejectionService');
  require(rejectionPath);
  require.cache[rejectionPath].exports.record = async () => { calls.rejection += 1; return { recorded: true }; };

  const scheduler = require('../../services/postgresql/scheduler');

  // Планировщик сверки платежей ведёт в runPaymentReconciliation.
  await scheduler.createPaymentReconciliationScheduler({ intervalMs: 1_000_000 }).tick();
  assert.equal(calls.reconcile, 1, 'планировщик обязан вызывать сверку платежей');

  // Планировщик финансового здоровья ведёт в обе проверки.
  await scheduler.createFinancialHealthScheduler({ intervalMs: 1_000_000, runOnStart: false }).tick();
  assert.equal(calls.invariants, 1, 'планировщик обязан вызывать проверку инвариантов');
  assert.equal(calls.docRetry, 1, 'планировщик обязан вызывать достройку документов');

  delete process.env.DATABASE_URL;
});

test('RC3: ни один критический сервис не остаётся без вызова вне тестов', () => {
  // Статическая часть — вторая линия, а не единственная: она ловит случай,
  // когда модуль вообще ни в одном runtime-файле не упомянут.
  const roots = [
    path.join(__dirname, '../../services'),
    path.join(__dirname, '../../routes'),
    path.join(__dirname, '../../server.postgresql.js'),
  ];

  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isFile()) { if (p.endsWith('.js')) files.push(p); return; }
    for (const entry of fs.readdirSync(p)) {
      if (entry === 'node_modules') continue;
      walk(path.join(p, entry));
    }
  };
  for (const r of roots) walk(r);

  for (const rel of CRITICAL_MODULES) {
    const target = require.resolve(rel);
    const base = path.basename(target, '.js');
    const referencedFrom = files.filter((f) => {
      if (f === target) return false;
      const src = fs.readFileSync(f, 'utf8');
      // Ищем именно require, а не любое упоминание имени в комментарии.
      return new RegExp(`require\\([\`'"][^\`'"]*${base}[\`'"]\\)`).test(src);
    });
    assert.ok(referencedFrom.length > 0,
      `${base} не подключён ни одним runtime-модулем — повторение паттерна Stage 21`);
  }
});
