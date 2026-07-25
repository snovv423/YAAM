import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// YAAM HQ Stage 1: реальный browser E2E для порога NEW/счётчик заказов
// (0-9 завершённых заказов -> бейдж NEW, 10+ -> компактный счётчик). Заказы
// продвигаются до 'delivered' напрямую через существующий orderService
// (server-side, в этом же Node-процессе, тот же приём, что и глобальная
// установка стека в global-setup.ts) — HTTP-эндпоинта для принудительного
// продвижения статуса нет и специально не создавался (см. отчёт, раздел про
// dev-confirm-payment — это тоже НЕ используется здесь, продвижение до
// delivered требует восстанавливать весь путь ресторана, а не только оплату).

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const CLIENT_BASE_URL = process.env.YAAM_E2E_CLIENT_BASE_URL;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !CLIENT_BASE_URL || !DATABASE_URL) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_CLIENT_BASE_URL / YAAM_E2E_DATABASE_URL не заданы — globalSetup не выполнился?');
}

const SERVER_DIR = path.resolve(__dirname, '../../server');
process.env.DATABASE_URL = DATABASE_URL;
process.env.PAYMENT_PROVIDER = 'mock';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orderService = require(path.join(SERVER_DIR, 'services/postgresql/orderService.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));

const SEEDED_RESTAURANT_TEXT = 'YAAM QA — Тестовый ресторан';

async function pointFrontendAtLocalBackend(page: Page) {
  await page.addInitScript((apiBaseUrl) => {
    // @ts-expect-error глобал браузерного рантайма
    window.YAAM_API_BASE_URL = apiBaseUrl;
  }, API_BASE_URL);
}

async function seededRestaurantId(): Promise<number> {
  const rows = await db.query(`SELECT id FROM restaurants WHERE connect_code = 'stage11b-test-seed-v1'`);
  if (!rows[0]) throw new Error('Stage 11B seed-ресторан не найден — global-setup.ts не отработал?');
  return rows[0].id;
}

async function deliveredCountFor(restaurantId: number): Promise<number> {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS c FROM orders
     WHERE restaurant_id = $1 AND status = 'delivered'
       AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'succeeded')`,
    [restaurantId],
  );
  return rows[0].c;
}

async function createDeliveredOrder(restaurantId: number, menuItemId: number) {
  const crypto = require('node:crypto');
  const n = crypto.randomInt(100000000, 999999999);
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'E2E Badge Test',
    customerPhone: `+79${String(n).padStart(8, '0')}`,
    address: 'ул. Тестовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Тестовое блюдо №1', price: 350, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  const paymentRows = await db.query(
    `SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  await orderService.markPaid(order.id, paymentRows[0].id);
  await orderService.restaurantAccept(order.id);
  await orderService.restaurantAdvance(order.id, 'preparing');
  await orderService.restaurantAdvance(order.id, 'courier');
  await orderService.restaurantAdvance(order.id, 'delivered');
}

test.describe('Публичная карточка ресторана: порог NEW / счётчик заказов', () => {
  test('0-9 завершённых заказов -> NEW, 10-й заказ -> счётчик "10 заказов"', async ({ page }) => {
    const restaurantId = await test.step('найти seed-ресторан и его блюдо, проверить чистый baseline', async () => {
      const id = await seededRestaurantId();
      const baseline = await deliveredCountFor(id);
      // Эфемерная БД создаётся заново на каждый прогон (global-setup.ts); ни
      // один другой спек в этом наборе не доводит заказ до delivered (см.
      // критический smoke — там заказы отменяются, оставаясь в
      // awaiting_payment/cancelled) — поэтому baseline=0 гарантирован
      // структурой стенда, а не удачным совпадением порядка запуска файлов.
      // Явная проверка вместо тихого допущения — чтобы будущий спек,
      // случайно доводящий заказ до delivered на этом же ресторане, дал
      // понятную ошибку здесь, а не запутывающее несовпадение чисел ниже.
      expect(baseline, 'baseline delivered-заказов должен быть 0 в чистом прогоне').toBe(0);
      return id;
    });

    const menuItemRows = await db.query(
      `SELECT id FROM menu_items WHERE restaurant_id = $1 ORDER BY id LIMIT 1`,
      [restaurantId],
    );
    const menuItemId = menuItemRows[0].id;

    await test.step('довести 9 заказов до delivered', async () => {
      for (let i = 0; i < 9; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await createDeliveredOrder(restaurantId, menuItemId);
      }
      expect(await deliveredCountFor(restaurantId)).toBe(9);
    });

    await test.step('на публичной карточке при 9 заказах виден NEW, счётчика нет', async () => {
      await pointFrontendAtLocalBackend(page);
      await page.goto(CLIENT_BASE_URL!);
      const card = page.locator('.card', { hasText: SEEDED_RESTAURANT_TEXT });
      await expect(card).toBeVisible();
      await expect(card.locator('.newtag')).toBeVisible();
      await expect(card.locator('.ordcnt')).toHaveCount(0);
    });

    await test.step('довести 10-й заказ до delivered', async () => {
      await createDeliveredOrder(restaurantId, menuItemId);
      expect(await deliveredCountFor(restaurantId)).toBe(10);
    });

    await test.step('на публичной карточке при 10 заказах NEW скрыт, виден счётчик "10 заказов"', async () => {
      await page.reload();
      const card = page.locator('.card', { hasText: SEEDED_RESTAURANT_TEXT });
      await expect(card).toBeVisible();
      await expect(card.locator('.newtag')).toHaveCount(0);
      await expect(card.locator('.ordcnt')).toHaveText('10 заказов');
    });
  });
});
