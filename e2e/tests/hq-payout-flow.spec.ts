import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 9 — полный браузерный сценарий сущности выплаты (NO bank
// integration): войти -> создать ресторан -> доставленный оплаченный заказ
// -> создать и закрыть расчётный период -> открыть период, увидеть "Не
// создана" + "Подготовить выплату" -> подготовить выплату (НЕ перевод денег,
// только внутренняя запись) -> карточка выплаты показывает статус
// "Подготовлена" и точную сумму (= settlement_restaurant_lines.payable_amount,
// без пересчёта) -> период теперь показывает "Выплата создана" со ссылкой ->
// список /hq/payouts показывает строку -> Обзор показывает статистику
// выплат -> mobile 390×844 -> нигде нет кнопки «Выплатить».
//
// Заказ продвигается напрямую через orderService (тот же приём, что и
// hq-restaurant-finance-flow.spec.ts/hq-settlement-periods-flow.spec.ts) —
// ценность браузерной проверки здесь в экранах HQ (период / список выплат /
// карточка выплаты / Обзор), не в повторной имитации чекаута.

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

function dateStr(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function seedMenuItem(restaurantId: number, price: number) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Выплатное блюдо', category_id: String(category.id), price: String(price) });
}
async function createOrder(restaurantId: number, menuItemId: number, qty: number) {
  const n = crypto.randomInt(100000000, 999999999);
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Stage9 Test', customerPhone: `+79${String(n).padStart(8, '0')}`,
    address: 'ул. Выплатная, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Выплатное блюдо', price: 0, qty }],
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
async function createDeliveredPaidOrder(restaurantId: number, menuItemId: number, qty: number) {
  const order = await createOrder(restaurantId, menuItemId, qty);
  await orderService.markPaid(order.id, await paymentIdFor(order.id));
  await orderService.restaurantAccept(order.id);
  await orderService.restaurantAdvance(order.id, 'preparing');
  await orderService.restaurantAdvance(order.id, 'courier');
  await orderService.restaurantAdvance(order.id, 'delivered');
  return order.id;
}
async function backdateOrder(orderId: number, days: number) {
  await db.execute(`UPDATE orders SET status_updated_at = NOW() - INTERVAL '${days} days' WHERE id = $1`, [orderId]);
}

// settlement_periods — ГЛОБАЛЬНЫЙ, непересекающийся диапазон дат (Stage 8,
// EXCLUDE-ограничение в db/postgresql/schema.sql) — общий для ВСЕХ spec-
// файлов этого прогона (один embedded backend/БД на весь запуск, см.
// e2e/global-setup.ts). hq-settlement-periods-flow.spec.ts уже занимает
// "сегодня" под свой период 2 (реальный, не backdated заказ) — если и этот
// файл тоже возьмёт "сегодня", тот, кто выполнится вторым, получит реальный
// конфликт EXCLUDE-ограничения (не тестовую ошибку, а настоящее пересечение
// дат). Этому тесту не важно, какая именно дата используется (в отличие от
// hq-settlement-periods-flow.spec.ts, которому нужно именно "сейчас" для
// одного из шагов) — поэтому здесь используется большой случайный сдвиг в
// прошлое, эффективно исключающий столкновение с любым другим spec-файлом.
const DAY_OFFSET = -(1000 + crypto.randomInt(0, 100000));

test('YAAM HQ: сущность выплаты — подготовка, карточка, список, dashboard-статистика, без банка', async ({ page }) => {
  const name = `E2E Payout ${crypto.randomBytes(4).toString('hex')}`;
  page.on('dialog', (dialog) => dialog.accept());

  // 1. Войти в HQ.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Создать ресторан, меню, опубликовать/открыть.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(name);
  await page.locator('#rf-cities').fill('Грозный');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/restaurants/\\d+$`));
  const restaurantId = Number(page.url().split('/').pop());
  const menuItem = await seedMenuItem(restaurantId, 1000);

  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantId}`);
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByRole('button', { name: 'Открыть' })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByText('Открыт', { exact: true })).toBeVisible();

  // 3. Доставленный оплаченный заказ на 2000 ₽, комиссия fallback 7% = 140 ₽ -> к выплате 1860 ₽.
  const orderId = await createDeliveredPaidOrder(restaurantId, menuItem.id, 2);
  await backdateOrder(orderId, -DAY_OFFSET);

  // 4. Создать и закрыть расчётный период (уникальная дата — см. DAY_OFFSET).
  await page.goto(`${API_BASE_URL}/hq/finance/settlements/new`);
  await page.locator('#sp-from').fill(dateStr(DAY_OFFSET));
  await page.locator('#sp-to').fill(dateStr(DAY_OFFSET));
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/finance/settlements/\\d+$`));
  const periodUrl = page.url();
  await page.getByRole('button', { name: 'Закрыть период' }).click();
  await expect(page).toHaveURL(periodUrl);
  await expect(page.getByText('Период закрыт, суммы зафиксированы.')).toBeVisible();

  // 5. На странице периода — «Не создана» и кнопка «Подготовить выплату».
  const restaurantRow = page.locator('tr', { hasText: name });
  await expect(restaurantRow).toContainText('Не создана');
  await expect(restaurantRow).toContainText('1860 ₽'); // К выплате

  // 6. Подготовить выплату (НЕ кнопка "Выплатить" — деньги не переводятся).
  await expect(page.getByRole('button', { name: 'Выплатить' })).toHaveCount(0);
  await restaurantRow.getByRole('button', { name: 'Подготовить выплату' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/payouts/\\d+$`));
  const payoutUrl = page.url();

  // 7. Карточка выплаты: статус «Подготовлена», точная сумма, без пересчёта.
  await expect(page.getByText('Подготовлена')).toBeVisible();
  await expect(page.locator('.panel')).toContainText('1860 ₽');
  await expect(page.getByRole('link', { name: name })).toBeVisible();

  // 8. Вернуться на период — теперь «Выплата создана» со ссылкой.
  await page.goto(periodUrl);
  const restaurantRowAfter = page.locator('tr', { hasText: name });
  await expect(restaurantRowAfter).toContainText('Выплата создана');
  await expect(restaurantRowAfter.getByRole('link', { name: 'Подготовлена' })).toBeVisible();

  // 9. Список «Выплаты» — строка ресторана, без кнопки «Выплатить».
  await page.getByRole('link', { name: 'Выплаты' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/payouts`);
  const payoutListRow = page.locator('tr', { hasText: name });
  await expect(payoutListRow).toContainText('1860 ₽');
  await expect(payoutListRow).toContainText('Подготовлена');
  await expect(page.getByRole('button', { name: 'Выплатить' })).toHaveCount(0);
  await expect(page.getByText(/Отметить выплаченным/i)).toHaveCount(0);

  // 10. Обзор — статистика выплат видна (без графиков, просто числа).
  await page.goto(`${API_BASE_URL}/hq`);
  await expect(page.getByText('Подготовлено выплат')).toBeVisible();

  // 11. Mobile 390×844 — без горизонтального overflow, на списке и карточке.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${API_BASE_URL}/hq/payouts`);
  await expect(page.getByRole('heading', { name: 'Выплаты' })).toBeVisible();
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.goto(payoutUrl);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);

  // 12. Нигде на этих экранах нет кнопки/ссылки выплаты денег.
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);
});
