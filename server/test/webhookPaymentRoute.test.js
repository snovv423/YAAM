// C1 (аудит готовности к VPS): /api/webhooks/payment раньше регистрировался
// безусловно, а mockProvider.verifyWebhook() принимает любой JSON без проверки
// подписи — значит при PAYMENT_PROVIDER=mock (текущий production-режим,
// backend нигде не задеплоен) внешний запрос без всякой аутентификации мог бы
// пометить произвольный заказ оплаченным. Фикс: маршрут регистрируется только
// при PAYMENT_PROVIDER==='yookassa' (routes/api.js), симметрично уже
// существовавшему обратному гейту dev/pay-роутов.
//
// Честное ограничение покрытия: "позитивный" путь (маршрут зарегистрирован и
// реально принимает вебхук) сейчас непроверяем — YookassaProvider (paymentProviders/
// yookassaProvider.js) безусловно бросает исключение в конструкторе, он ещё не
// реализован. Последний тест этого файла проверяет ИМЕННО это: включить
// PAYMENT_PROVIDER=yookassa сейчас can't привести к "незащищённо включённому"
// вебхуку, потому что весь модуль не загрузится. Когда YookassaProvider будет
// реализован, этот тест естественно потребует обновления — тогда же появится
// возможность протестировать и позитивный путь.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { useIsolatedDb, cleanupDbFile, seedMinimalRestaurant, basicOrderPayload } = require('./helpers/testDb');

const { db, dbPath } = useIsolatedDb(); // useIsolatedDb() форсирует PAYMENT_PROVIDER=mock

let server;
let baseUrl;
let restaurantId;
let menuItemId;
let orderCode;
let providerPaymentId;

before(async () => {
  const express = require('express');
  const apiRoutes = require('../routes/api');
  const orderService = require('../services/orderService');

  const app = express();
  app.use((req, res, next) => {
    if (req.path === '/api/webhooks/payment') return next();
    express.json()(req, res, next);
  });
  app.use('/api', apiRoutes);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  ({ restaurantId, menuItemId } = seedMinimalRestaurant(db));
  const { order, payment } = await orderService.createOrder(
    basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79289990002' }),
  );
  orderCode = order.public_code;
  providerPaymentId = payment.provider_payment_id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDbFile(dbPath);
});

test('POST /api/webhooks/payment при PAYMENT_PROVIDER=mock недоступен извне (HTTP 404 — маршрут не зарегистрирован)', async () => {
  const res = await fetch(`${baseUrl}/api/webhooks/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerPaymentId, status: 'succeeded' }),
  });
  assert.equal(res.status, 404);
});

test('GET /api/webhooks/payment тоже 404 — маршрут отсутствует целиком, а не просто отклоняет метод POST', async () => {
  const res = await fetch(`${baseUrl}/api/webhooks/payment`);
  assert.equal(res.status, 404);
});

test('поддельный "успешный" webhook-запрос не переводит заказ в paid (заказ не меняется, потому что маршрута нет)', async () => {
  await fetch(`${baseUrl}/api/webhooks/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerPaymentId, status: 'succeeded' }),
  });
  const orderService = require('../services/orderService');
  const order = orderService.getOrder(orderCode);
  assert.equal(order.status, 'awaiting_payment', 'заказ не должен измениться от неаутентифицированного webhook-запроса');
});

test('PAYMENT_PROVIDER=yookassa не может "случайно" включить незащищённый вебхук — модуль не грузится, пока YookassaProvider не реализован', () => {
  const isolatedDbPath = path.join(os.tmpdir(), `yaam-test-${crypto.randomBytes(6).toString('hex')}.db`);
  const script = `
    process.env.PAYMENT_PROVIDER = 'yookassa';
    process.env.DB_PATH = ${JSON.stringify(isolatedDbPath)};
    require('./routes/api');
  `;
  let caught = null;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'require(routes/api.js) с PAYMENT_PROVIDER=yookassa должен завершиться ошибкой');
  const stderr = String(caught.stderr || '');
  assert.match(stderr, /YOOKASSA_SHOP_ID|не реализован/);
  cleanupDbFile(isolatedDbPath);
});
