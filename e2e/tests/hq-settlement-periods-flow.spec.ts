import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// YAAM HQ Stage 8 — полный браузерный сценарий расчётных периодов (задание,
// раздел 16, все 18 пунктов): вход -> создать 2 ресторана -> договор/меню ->
// заказы разных статусов (доставлен+оплачен, не оплачен, оплачен-не-
// доставлен, отменён с реальным возвратом) -> «Финансы» -> создать расчётный
// период -> preview -> точные суммы -> закрыть -> «Период закрыт, суммы
// зафиксированы» -> сменить комиссию по договору -> новый заказ -> закрытый
// период НЕ изменился -> создать следующий период -> старые заказы не
// попали туда повторно -> readiness ресторана виден -> mobile 390×844 -> нет
// кнопок выплаты.
//
// Заказы продвигаются напрямую через orderService (тот же приём, что и
// hq-restaurant-finance-flow.spec.ts, Stage 7) — ценность браузерной
// проверки здесь в экранах HQ (Финансы / период / детальная страница
// периода), не в повторной имитации чекаута.
//
// Период 1 намеренно "вчера" (backdated status_updated_at напрямую через
// SQL после доставки/возврата — тот же приём, что и
// server/test/postgresql/hqSettlementPeriodsStage8.test.js, тест N) — это
// оставляет "сегодня" свободным для периода 2 (шаги 14-15), без нарушения
// EXCLUDE-ограничения непересекающихся периодов (db/postgresql/schema.sql).

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD / YAAM_E2E_DATABASE_URL не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orderService = require(path.join(SERVER_DIR, 'services/postgresql/orderService.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const menuAdminService = require(path.join(SERVER_DIR, 'services/hq/menuAdminService.js'));

function sleep(ms: number) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function dateStr(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function seedMenuItem(restaurantId: number, price: number) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Расчётное блюдо', category_id: String(category.id), price: String(price) });
}

async function createOrder(restaurantId: number, menuItemId: number, qty: number) {
  const n = crypto.randomInt(100000000, 999999999);
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Stage8 Test', customerPhone: `+79${String(n).padStart(8, '0')}`,
    address: 'ул. Расчётная, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Расчётное блюдо', price: 0, qty }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  return order;
}
async function paymentIdFor(orderId: number) {
  const rows = await db.query('SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId]);
  return rows[0].id;
}
async function backdateOrder(orderId: number, days: number) {
  await db.execute(`UPDATE orders SET status_updated_at = NOW() - INTERVAL '${days} days' WHERE id = $1`, [orderId]);
}

async function createDeliveredPaidOrder(restaurantId: number, menuItemId: number, qty: number, backdateDays = 0) {
  const order = await createOrder(restaurantId, menuItemId, qty);
  await orderService.markPaid(order.id, await paymentIdFor(order.id));
  await orderService.restaurantAccept(order.id);
  await orderService.restaurantAdvance(order.id, 'preparing');
  await orderService.restaurantAdvance(order.id, 'courier');
  await orderService.restaurantAdvance(order.id, 'delivered');
  if (backdateDays > 0) await backdateOrder(order.id, backdateDays);
  return order.id;
}
async function createPaidNotDeliveredOrder(restaurantId: number, menuItemId: number, qty: number) {
  const order = await createOrder(restaurantId, menuItemId, qty);
  await orderService.markPaid(order.id, await paymentIdFor(order.id));
  await orderService.restaurantAccept(order.id);
  return order.id;
}
async function createUnpaidOrder(restaurantId: number, menuItemId: number, qty: number) {
  const order = await createOrder(restaurantId, menuItemId, qty);
  return order.id;
}
async function createCancelledWithRealRefundOrder(restaurantId: number, menuItemId: number, qty: number, backdateDays = 0) {
  const order = await createOrder(restaurantId, menuItemId, qty);
  await orderService.markPaid(order.id, await paymentIdFor(order.id));
  await orderService.cancelByCustomer(order.id);
  await sleep(250); // fire-and-forget scheduleRefundProcessing (mock-провайдер)
  if (backdateDays > 0) {
    await backdateOrder(order.id, backdateDays);
    await db.execute(`UPDATE refunds SET completed_at = NOW() - INTERVAL '${backdateDays} days' WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)`, [order.id]);
  }
  return order.id;
}
async function commissionAmountFor(orderId: number) {
  const rows = await db.query('SELECT commission_amount FROM orders WHERE id = $1', [orderId]);
  return rows[0].commission_amount;
}

test('YAAM HQ: расчётные периоды — preview, закрытие, immutable snapshot, изоляция между периодами', async ({ page }) => {
  const nameA = `E2E Settlement A ${crypto.randomBytes(4).toString('hex')}`;
  const nameB = `E2E Settlement B ${crypto.randomBytes(4).toString('hex')}`;
  page.on('dialog', (dialog) => dialog.accept());

  // 1. Войти в HQ.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Создать 2 ресторана.
  async function createRestaurantViaUi(name: string): Promise<number> {
    await page.getByRole('link', { name: 'Рестораны' }).click();
    await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
    await page.locator('#rf-name').fill(name);
    await page.locator('#rf-cities').fill('Грозный');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/restaurants/\\d+$`));
    return Number(page.url().split('/').pop());
  }
  const restaurantAId = await createRestaurantViaUi(nameA);
  const restaurantBId = await createRestaurantViaUi(nameB);

  // 3. Подготовить договор ресторана A (10%) и меню обоих ресторанов.
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantAId}/contract/edit`);
  await page.getByLabel('Номер договора').fill('Д-SET-1');
  await page.getByLabel('Статус').selectOption('signed');
  await page.getByLabel('Дата заключения').fill('2026-01-15');
  await page.getByLabel('Комиссия YAAM, %').fill('10');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${API_BASE_URL}/hq/restaurants/${restaurantAId}/settings`));

  const menuItemA = await seedMenuItem(restaurantAId, 1000);
  const menuItemB = await seedMenuItem(restaurantBId, 1000);

  async function publishAndOpen(restaurantId: number) {
    await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantId}`);
    await page.getByRole('button', { name: 'Опубликовать' }).click();
    await expect(page.getByRole('button', { name: 'Открыть' })).toBeVisible();
    await page.getByRole('button', { name: 'Открыть' }).click();
    await expect(page.getByText('Открыт', { exact: true })).toBeVisible();
  }
  await publishAndOpen(restaurantAId);
  await publishAndOpen(restaurantBId);

  // 4. Заказы разных статусов — всё датировано "вчера" (период 1).
  const orderA1 = await createDeliveredPaidOrder(restaurantAId, menuItemA.id, 1, 1); // 1000 ₽
  const orderA2 = await createDeliveredPaidOrder(restaurantAId, menuItemA.id, 2, 1); // 2000 ₽
  await createUnpaidOrder(restaurantAId, menuItemA.id, 1);
  await createPaidNotDeliveredOrder(restaurantAId, menuItemA.id, 1);
  await createCancelledWithRealRefundOrder(restaurantAId, menuItemA.id, 1, 1); // 1000 ₽ реальный возврат, вчера
  const orderB1 = await createDeliveredPaidOrder(restaurantBId, menuItemB.id, 1, 1); // 1000 ₽, fallback 7%

  // 5. Открыть «Финансы».
  await page.goto(`${API_BASE_URL}/hq/finance`);
  await expect(page.getByRole('heading', { name: 'Финансы' })).toBeVisible();
  await expect(page.getByText('Расчётные периоды')).toBeVisible();

  // 6. Создать расчётный период (период 1 — "вчера").
  await page.getByRole('link', { name: '+ Новый период' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/finance/settlements/new`);
  await page.locator('#sp-from').fill(dateStr(-1));
  await page.locator('#sp-to').fill(dateStr(-1));
  await page.locator('#sp-notes').fill('E2E период 1');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/finance/settlements/\\d+$`));
  const period1Url = page.url();

  // 7. Увидеть preview (draft).
  await expect(page.getByText('Предварительный расчёт, суммы ещё могут измениться.')).toBeVisible();

  // 8. Проверить точные суммы.
  const rowA = page.locator('tr', { hasText: nameA });
  await expect(rowA).toContainText('3000 ₽'); // оборот 1000+2000
  await expect(rowA).toContainText('300 ₽'); // комиссия 10%
  await expect(rowA).toContainText('2700 ₽'); // сумма ресторана
  await expect(rowA).toContainText('1 шт · 1000 ₽'); // возвращено клиентам (A5)
  const rowB = page.locator('tr', { hasText: nameB });
  await expect(rowB).toContainText('1000 ₽');
  await expect(rowB).toContainText('70 ₽');
  await expect(rowB).toContainText('930 ₽');

  // 9. Закрыть период.
  await page.getByRole('button', { name: 'Закрыть период' }).click();
  await expect(page).toHaveURL(period1Url);

  // 10. Увидеть «Период закрыт, суммы зафиксированы».
  await expect(page.getByText('Период закрыт, суммы зафиксированы.')).toBeVisible();
  await expect(page.getByText('Предварительный расчёт')).toHaveCount(0);
  // После закрытия форма закрытия/удаления черновика больше не показывается.
  await expect(page.getByRole('button', { name: 'Закрыть период' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Удалить черновик' })).toHaveCount(0);

  // 11. Изменить договорную комиссию ресторана A на 5%.
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantAId}/contract/edit`);
  await page.getByLabel('Комиссия YAAM, %').fill('5');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${API_BASE_URL}/hq/restaurants/${restaurantAId}/settings`));

  // 12. Создать новый заказ (сегодня, новая ставка).
  const orderA6 = await createDeliveredPaidOrder(restaurantAId, menuItemA.id, 1, 0); // 1000 ₽, ожидаем комиссию 5%=50
  expect(await commissionAmountFor(orderA1)).toBe(100); // старый снимок — не тронут
  expect(await commissionAmountFor(orderA2)).toBe(200);
  expect(await commissionAmountFor(orderA6)).toBe(50);

  // 13. Убедиться, что закрытый период 1 НЕ изменился.
  await page.goto(period1Url);
  await expect(page.getByText('Период закрыт, суммы зафиксированы.')).toBeVisible();
  const rowAClosed = page.locator('tr', { hasText: nameA });
  await expect(rowAClosed).toContainText('3000 ₽'); // всё ещё 1000+2000, БЕЗ orderA6
  await expect(rowAClosed).toContainText('300 ₽'); // всё ещё старая комиссия 10%, БЕЗ новой ставки 5%

  // 14. Создать следующий период (период 2 — "сегодня", захватывает только orderA6).
  await page.goto(`${API_BASE_URL}/hq/finance/settlements/new`);
  await page.locator('#sp-from').fill(dateStr(0));
  await page.locator('#sp-to').fill(dateStr(0));
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/finance/settlements/\\d+$`));
  const period2Url = page.url();
  expect(period2Url).not.toBe(period1Url);

  // 15. Проверить, что старые заказы (A1/A2, вчера) НЕ попали в период 2 повторно.
  const rowAPeriod2 = page.locator('tr', { hasText: nameA });
  await expect(rowAPeriod2).toContainText('1000 ₽'); // только orderA6, НЕ 4000
  await expect(rowAPeriod2).toContainText('50 ₽'); // новая ставка 5%
  await page.getByRole('button', { name: 'Закрыть период' }).click();
  await expect(page).toHaveURL(period2Url);
  await expect(page.getByText('Период закрыт, суммы зафиксированы.')).toBeVisible();

  // 16. Проверить restaurant readiness (юр./банк. данные не заполнены — виден
  // статус неготовности). Скоуп строго строкой ресторана A этого периода —
  // общий backend/БД делится со всеми spec-файлами прогона (global-setup.ts),
  // поэтому непривязанный page-wide текстовый поиск того же лейбла может
  // задеть строки других рестораны из других спеков.
  await expect(rowAPeriod2).toContainText('Не заполнены юридические данные');

  // 17. Mobile 390×844 — без горизонтального overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${API_BASE_URL}/hq/finance`);
  await expect(page.getByText('Расчётные периоды')).toBeVisible();
  let hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasOverflow).toBe(false);
  await page.goto(period1Url);
  await expect(page.getByText('Период закрыт, суммы зафиксированы.')).toBeVisible();
  hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasOverflow).toBe(false);

  // 18. Нет ни одной кнопки/ссылки выплаты нигде.
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);
  await expect(page.getByText(/Отметить выплаченным/i)).toHaveCount(0);
  await page.goto(`${API_BASE_URL}/hq/finance`);
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);
  void orderB1;
});
