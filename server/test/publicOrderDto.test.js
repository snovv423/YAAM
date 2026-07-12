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

const PUBLIC_ALLOWLIST = [
  'public_code', 'status', 'status_updated_at', 'items_total',
  'estimated_ready_minutes', 'restaurant_phone', 'fulfillment_type', 'rating',
];
const FORBIDDEN_FIELDS = [
  'id', 'restaurant_id', 'city', 'customer_name', 'customer_phone', 'address',
  'comment', 'commission_amount', 'created_at', 'restaurant_name', 'items',
];

test('toPublicOrderDTO не содержит PII и внутренних полей', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79281111111' }));
  const dto = orderService.toPublicOrderDTO(order);
  for (const field of FORBIDDEN_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(dto, field), false, `DTO не должен содержать поле "${field}"`);
  }
});

test('toPublicOrderDTO содержит все поля, реально используемые frontend', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79282222222' }));
  const dto = orderService.toPublicOrderDTO(order);
  for (const field of PUBLIC_ALLOWLIST) {
    assert.equal(Object.prototype.hasOwnProperty.call(dto, field), true, `DTO должен содержать поле "${field}"`);
  }
  assert.equal(Object.keys(dto).length, PUBLIC_ALLOWLIST.length, 'DTO не должен содержать полей сверх allowlist');
});

test('toPublicOrderDTO(null) не бросает и возвращает null', () => {
  assert.equal(orderService.toPublicOrderDTO(null), null);
});

test('orderService.getOrder() (внутренний) по-прежнему возвращает полный объект для бота/админки', async () => {
  const { order } = await orderService.createOrder(basicOrderPayload(restaurantId, menuItemId, { customerPhone: '+79283333333' }));
  const full = orderService.getOrder(order.id);
  assert.equal(full.customer_name, 'Тест Тестов');
  assert.equal(full.customer_phone, '+79283333333');
  assert.equal(full.address, 'ул. Тестовая, 1');
  assert.ok(Array.isArray(full.items));
});

test('неизвестный public_code обрабатывается корректно (getOrder возвращает null)', () => {
  assert.equal(orderService.getOrder('YAAM-99999'), null);
});
