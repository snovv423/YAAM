// Production Switch Stage 9 HIGH-фикс — concurrent cancel HTTP 500
// (независимый Codex-аудит, YAAM-Stage-9-Closure-and-Full-Staging-
// Acceptance-Report.pdf). Корневая причина и фикс — на PostgreSQL-стороне
// (server/services/postgresql/orderService.js, см. соответствующий тест в
// server/test/postgresql/). Этот файл доказывает, ПОЧЕМУ на SQLite-стороне
// изменений НЕ требуется, а не просто заявляет это.
//
// Архитектурная причина: server/db/index.js использует node:sqlite
// DatabaseSync (полностью синхронный API), а services/orderService.js's
// cancelByCustomer() не содержит НИ ОДНОГО await внутри своего тела —
// db.immediateTransaction(() => {...})() выполняется целиком синхронно, в
// один тик event loop'а. Поскольку Node однопоточен, ДВА "конкурентных" HTTP-
// запроса на cancel физически не могут интерлевиться внутри этой функции:
// пока выполняется её синхронное тело для запроса A, обработчик запроса B
// не может начать выполняться вообще. К моменту, когда B реально стартует,
// A уже полностью закоммичен — B видит уже 'cancelled' статус на своём
// собственном первом чтении и корректно получает штатную бизнес-ошибку
// (400-класс), НЕ RefundInvariantError/500. Race-окно, которое существует
// под PostgreSQL (async pg-driver, реальные конкурентные транзакции),
// структурно не существует здесь — тот же принцип, что уже задокументирован
// для restaurantAccept/restaurantDecline в Stage 2 (server/docs/
// postgresql-migration-status.md).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');

let restaurantId;
let menuItemId;

before(() => {
  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
});

after(() => {
  cleanupDbFile(dbPath);
});

test('SQLite: N "конкурентных" (Promise.all) cancelByCustomer на один заказ — НИ ОДИН не даёт 500-класс ошибку', async () => {
  for (let iter = 0; iter < 10; iter += 1) {
    const { order } = await orderService.createOrder(
      basicOrderPayload(restaurantId, menuItemId, { customerPhone: `+7928777${2000 + iter}` }),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => orderService.cancelByCustomer(order.id))
    );

    const serverErrors = results.filter((r) => r.status === 'rejected' && Number.isInteger(r.reason.statusCode) && r.reason.statusCode >= 500);
    assert.equal(serverErrors.length, 0, `итерация ${iter}: ни один "конкурентный" cancel не должен давать 500-класс ошибку`);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, `итерация ${iter}: ровно один запрос должен реально выиграть переход (синхронная сериализация)`);

    const rejected = results.filter((r) => r.status === 'rejected');
    for (const r of rejected) {
      // Проигравшие получают штатную бизнес-ошибку ("уже готовится...") —
      // НЕ RefundInvariantError, statusCode отсутствует -> 400 через
      // errorStatus() в routes/api.js (дефолт для не-целочисленного statusCode).
      assert.equal(r.reason.name, 'Error');
      assert.equal(r.reason.statusCode, undefined);
    }

    const final = orderService.getOrder(order.id);
    assert.equal(final.status, 'cancelled');
  }
});
