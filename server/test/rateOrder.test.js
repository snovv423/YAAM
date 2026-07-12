const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb();
const orderService = require('../services/orderService');

let restaurantId;
let menuItemId;

before(() => {
  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db, { rating: 4.0, rating_count: 10 }));
});

after(() => {
  cleanupDbFile(dbPath);
});

// Заказ проходит весь путь до delivered+paid, чтобы rateOrder() было что оценивать.
async function createDeliveredPaidOrder(phone) {
  const { order, payment } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: phone }));
  await orderService.markPaid(order.id);
  orderService.restaurantAccept(order.id);
  orderService.restaurantAdvance(order.id, 'preparing');
  orderService.restaurantAdvance(order.id, 'courier');
  orderService.restaurantAdvance(order.id, 'delivered');
  return { order, payment };
}

test('первая оценка delivered+paid заказа успешна', async () => {
  const { order } = await createDeliveredPaidOrder('+79286660001');
  const rated = orderService.rateOrder(order.id, 5);
  assert.equal(rated.rating, 5);
});

test('повторная оценка того же заказа отклоняется', async () => {
  const { order } = await createDeliveredPaidOrder('+79286660002');
  orderService.rateOrder(order.id, 4);
  assert.throws(() => orderService.rateOrder(order.id, 2), /уже оценили/);
});

test('rating_count увеличивается ровно один раз', async () => {
  const before_ = db.prepare('SELECT rating_count FROM restaurants WHERE id = ?').get(restaurantId);
  const { order } = await createDeliveredPaidOrder('+79286660003');
  orderService.rateOrder(order.id, 5);
  const after_ = db.prepare('SELECT rating_count FROM restaurants WHERE id = ?').get(restaurantId);
  assert.equal(after_.rating_count, before_.rating_count + 1);
});

test('средний рейтинг пересчитывается корректно', async () => {
  const { restaurantId: rid, menuItemId: mid } = seedMinimalRestaurant(db, { name: 'Рейтинг-ресторан', rating: 5, rating_count: 1 });
  const { order } = await orderService.createOrder(basicOrderPayload(rid, mid, { customerPhone: '+79286660004' }))
    .then(async (res) => {
      await orderService.markPaid(res.order.id);
      orderService.restaurantAccept(res.order.id);
      orderService.restaurantAdvance(res.order.id, 'preparing');
      orderService.restaurantAdvance(res.order.id, 'courier');
      orderService.restaurantAdvance(res.order.id, 'delivered');
      return res;
    });
  orderService.rateOrder(order.id, 3); // (5*1 + 3) / 2 = 4.0
  const r = db.prepare('SELECT rating FROM restaurants WHERE id = ?').get(rid);
  assert.equal(r.rating, 4.0);
});

test('при проигранной гонке (changes===0) агрегат ресторана не меняется', async () => {
  const { order } = await createDeliveredPaidOrder('+79286660005');
  const restBefore = db.prepare('SELECT rating, rating_count FROM restaurants WHERE id = ?').get(restaurantId);
  // Симулируем "конкурент уже поставил оценку между чтением и записью":
  // напрямую проставляем rating в обход rateOrder(), затем вызываем rateOrder()
  // с уже занятым rating IS NULL — conditional UPDATE не найдёт строк.
  db.prepare('UPDATE orders SET rating = 5 WHERE id = ?').run(order.id);
  assert.throws(() => orderService.rateOrder(order.id, 1), /уже оценили/);
  const restAfter = db.prepare('SELECT rating, rating_count FROM restaurants WHERE id = ?').get(restaurantId);
  assert.deepEqual(restAfter, restBefore, 'агрегат ресторана не должен измениться при проигранной гонке');
});

test('падение при обновлении агрегата ресторана откатывает orders.rating (rollback)', async (t) => {
  const { order } = await createDeliveredPaidOrder('+79286660006');
  const realPrepare = db.prepare.bind(db);
  // Мок ограничен этим тестом (node:test автоматически восстанавливает после
  // теста) — подменяем только конкретный запрос агрегата ресторана, всё
  // остальное идёт через настоящий db.prepare.
  t.mock.method(db, 'prepare', (sql, ...rest) => {
    if (sql.includes('UPDATE restaurants SET rating')) {
      return { run() { throw new Error('искусственный сбой обновления агрегата'); } };
    }
    return realPrepare(sql, ...rest);
  });
  assert.throws(() => orderService.rateOrder(order.id, 5), /искусственный сбой/);
  t.mock.reset();
  const stillNull = orderService.getOrder(order.id);
  assert.equal(stillNull.rating, null, 'orders.rating должен откатиться при падении обновления агрегата');
});

test('неоплаченный заказ нельзя оценить', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79286660007' }));
  assert.throws(() => orderService.rateOrder(order.id, 5), /не оплачен|доставленный/);
});

test('недоставленный заказ нельзя оценить', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79286660008' }));
  await orderService.markPaid(order.id);
  assert.throws(() => orderService.rateOrder(order.id, 5), /доставленный/);
});

test('некорректное значение рейтинга отклоняется', async () => {
  const { order } = await createDeliveredPaidOrder('+79286660009');
  assert.throws(() => orderService.rateOrder(order.id, 0), /1\.\.5/);
  assert.throws(() => orderService.rateOrder(order.id, 6), /1\.\.5/);
});
