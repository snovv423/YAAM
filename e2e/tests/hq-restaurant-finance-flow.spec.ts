import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// YAAM HQ Stage 7 — полный браузерный сценарий финансового учёта (задание,
// раздел 14C, все 15 пунктов): вход -> создать 2 ресторана -> у одного
// подписанный договор с нестандартной комиссией (10%), у другого без
// договора (fallback 7%) -> создать заказы разных статусов (доставлен+
// оплачен, оплачен-не-доставлен, не оплачен вовсе, отменён с реальным
// возвратом) -> открыть «Финансы» и сверить точные суммы -> открыть
// конкретный ресторан и сверить его цифры -> сменить комиссию по договору ->
// создать новый заказ -> убедиться, что старые заказы сохранили снимок
// комиссии, а новый использует новую ставку -> mobile 390×844 -> нет ни
// одной кнопки/ссылки выплаты.
//
// Заказы продвигаются напрямую через orderService (server-side, в этом же
// Node-процессе) — тот же приём, что и orders-count-badge.spec.ts
// (комментарий там же объясняет, почему: HTTP-эндпоинта для принудительного
// продвижения статуса нет и не создавался). Ценность браузерной проверки
// здесь — в экранах HQ (Финансы / Статистика ресторана), а не в повторной
// имитации чекаута, который уже покрыт critical-order-smoke.spec.ts.

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

async function seedMenuItem(restaurantId: number, price: number) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Финансовое тестовое блюдо', category_id: String(category.id), price: String(price) });
}

async function createOrder(restaurantId: number, menuItemId: number, qty: number) {
  const n = crypto.randomInt(100000000, 999999999);
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'E2E Finance Test',
    customerPhone: `+79${String(n).padStart(8, '0')}`,
    address: 'ул. Финансовая, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Финансовое тестовое блюдо', price: 0, qty }],
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

async function createCancelledWithRealRefundOrder(restaurantId: number, menuItemId: number, qty: number) {
  const order = await createOrder(restaurantId, menuItemId, qty);
  // cancelByCustomer() разрешён только для awaiting_payment/awaiting_restaurant
  // (services/postgresql/orderService.js:1337) — restaurantAccept() здесь
  // намеренно НЕ вызывается, иначе отмена упадёт с "заказ уже готовится".
  await orderService.markPaid(order.id, await paymentIdFor(order.id));
  await orderService.cancelByCustomer(order.id);
  await sleep(200); // fire-and-forget scheduleRefundProcessing (mock-провайдер) — см. paymentSafetyStage8.test.js B1
  return order.id;
}

async function commissionAmountFor(orderId: number) {
  const rows = await db.query('SELECT commission_amount FROM orders WHERE id = $1', [orderId]);
  return rows[0].commission_amount;
}

async function financeRow(page: Page, restaurantName: string) {
  return page.locator('tr', { hasText: restaurantName });
}

test('YAAM HQ: финансовый учёт по ресторанам — суммы, комиссия по договору, fallback, реальный возврат, снимок при смене ставки', async ({ page }) => {
  const nameA = `E2E Finance A ${crypto.randomBytes(4).toString('hex')}`;
  const nameB = `E2E Finance B ${crypto.randomBytes(4).toString('hex')}`;

  // Публикация ресторана требует подтверждения через нативный confirm() —
  // тот же приём, что и hq-restaurant-management-flow.spec.ts.
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

  // 3. Подготовить договор ресторана A с нестандартной комиссией 10%
  // (ресторан B намеренно остаётся БЕЗ договора — проверка fallback-ставки
  // 7%, задание раздел 8).
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantAId}/contract/edit`);
  await page.getByLabel('Номер договора').fill('Д-FIN-1');
  await page.getByLabel('Статус').selectOption('signed');
  await page.getByLabel('Дата заключения').fill('2026-01-15');
  await page.getByLabel('Комиссия YAAM, %').fill('10');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${API_BASE_URL}/hq/restaurants/${restaurantAId}/settings`));

  // Меню (минимально необходимое для создания заказов) — цена 1000 ₽,
  // qty используется ниже, чтобы получить нужные items_total без плавающей
  // арифметики.
  const menuItemA = await seedMenuItem(restaurantAId, 1000);
  const menuItemB = await seedMenuItem(restaurantBId, 1000);

  // Опубликовать и открыть оба ресторана — createOrderAndResolve отклоняет
  // заказы для черновика/закрытого ресторана (см. orderService.js:660-661);
  // это не относится к финансовой логике Stage 7 самой по себе, но является
  // обязательной предпосылкой для «реальных» заказов, которые запрашивает
  // задание.
  async function publishAndOpen(restaurantId: number) {
    await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantId}`);
    await page.getByRole('button', { name: 'Опубликовать' }).click();
    await expect(page.getByRole('button', { name: 'Открыть' })).toBeVisible();
    await page.getByRole('button', { name: 'Открыть' }).click();
    await expect(page.getByText('Открыт', { exact: true })).toBeVisible();
  }
  await publishAndOpen(restaurantAId);
  await publishAndOpen(restaurantBId);

  // 4-5. Создать заказы разных статусов, часть доставить.
  const orderA1 = await createDeliveredPaidOrder(restaurantAId, menuItemA.id, 1); // 1000 ₽ -> earned
  const orderA2 = await createDeliveredPaidOrder(restaurantAId, menuItemA.id, 2); // 2000 ₽ -> earned
  await createUnpaidOrder(restaurantAId, menuItemA.id, 1); // awaiting_payment -> не учитывается
  await createPaidNotDeliveredOrder(restaurantAId, menuItemA.id, 1); // оплачен, но не доставлен -> не учитывается

  // 6. Тестовый полный возврат — реальный, реальный жизненный цикл заказа
  // (оплачен -> принят -> отменён клиентом): деньги реально возвращаются
  // через mock-провайдер. Заказ никогда не был delivered, поэтому НЕ входит
  // в заработок ресторана (turnover/commission/restaurantEarnings) — но
  // Stage 7.1 ("Correct Successful Refund Reporting") ИСПРАВИЛ Stage 7-баг,
  // из-за которого такой (единственный реально достижимый) возврат вообще
  // не показывался в «Возвращено клиентам»; теперь он корректно виден там,
  // не будучи повторно вычтенным из заработка — см. server/test/postgresql/
  // hqRestaurantRefundReportingStage71.test.js за полным разбором.
  await createCancelledWithRealRefundOrder(restaurantAId, menuItemA.id, 1);

  const orderB1 = await createDeliveredPaidOrder(restaurantBId, menuItemB.id, 1); // 1000 ₽ -> earned, fallback 7%

  // 7. Открыть «Финансы» и сверить точные суммы.
  await page.goto(`${API_BASE_URL}/hq/finance?period=today`);
  await expect(page.getByRole('heading', { name: 'Финансы' })).toBeVisible();

  const rowA = await financeRow(page, nameA);
  await expect(rowA).toContainText('3000 ₽'); // оборот: 1000+2000
  await expect(rowA).toContainText('300 ₽'); // комиссия 10%: 100+200
  await expect(rowA).toContainText('2700 ₽'); // сумма ресторана

  const rowB = await financeRow(page, nameB);
  await expect(rowB).toContainText('1000 ₽');
  await expect(rowB).toContainText('70 ₽'); // комиссия fallback 7%
  await expect(rowB).toContainText('930 ₽');

  // Stage 8/9: другие spec-файлы этого прогона делят один и тот же backend/
  // БД (e2e/global-setup.ts) и тоже могут создавать "сегодня"-датированные
  // заказы для СВОИХ тестовых ресторанов — общий агрегат "Сводка за период"
  // суммирует ПО ВСЕМ ресторанам, поэтому может включать чужой вклад. Точные
  // построчные суммы A/B выше уже доказывают корректность рендера; здесь
  // проверяем, что общий агрегат КОРРЕКТНО ВКЛЮЧАЕТ вклад A/B (>=), а не
  // требуем точного равенства глобальному числу, которое зависит от порядка
  // выполнения остальных spec-файлов.
  const summaryPanel = page.locator('.panel', { hasText: 'Сводка за период' });
  async function readPanelAmount(label: string): Promise<number> {
    const text = await summaryPanel.innerText();
    const match = text.match(new RegExp(`${label}\\s*([\\d\\s]+)\\s*₽`));
    if (!match) throw new Error(`не найдено значение "${label}" в панели: ${text}`);
    return Number(match[1].replace(/\s/g, ''));
  }
  expect(await readPanelAmount('Оборот')).toBeGreaterThanOrEqual(4000); // общий оборот >= 3000+1000
  expect(await readPanelAmount('Комиссия YAAM')).toBeGreaterThanOrEqual(370); // общая комиссия >= 300+70
  // Stage 7.1: реальный возврат отменённого заказа A5 (1000 ₽) корректно
  // виден в «Возвращено клиентам», НЕ влияя на оборот/комиссию/сумму
  // ресторанов выше (заказ никогда не входил в заработок).
  const summaryText = await summaryPanel.innerText();
  const refundMatch = summaryText.match(/(\d+)\s*шт\s*·\s*([\d\s]+)\s*₽/);
  if (!refundMatch) throw new Error(`не найдена строка возвратов в панели: ${summaryText}`);
  expect(Number(refundMatch[1])).toBeGreaterThanOrEqual(1);
  expect(Number(refundMatch[2].replace(/\s/g, ''))).toBeGreaterThanOrEqual(1000);

  // «Остаток к будущим выплатам» явно подписан как временная формула.
  await expect(page.getByText('временная формула')).toBeVisible();

  // 13. Ни одной кнопки/ссылки выплаты нигде на экране «Финансы».
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Выплат/i })).toHaveCount(0);

  // 8. Открыть конкретный ресторан (A) и сверить его цифры на вкладке
  // «Статистика» (финансовый блок Stage 7).
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantAId}/statistics?period=today`);
  const financePanel = page.locator('.panel', { hasText: 'Финансы за период' });
  await expect(financePanel).toContainText('3000 ₽');
  await expect(financePanel).toContainText('300 ₽');
  await expect(financePanel).toContainText('2700 ₽');
  await expect(financePanel).toContainText('2 '); // доставленных оплаченных заказов
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);

  // 9. Сменить комиссию по договору ресторана A на 5%.
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantAId}/contract/edit`);
  await page.getByLabel('Комиссия YAAM, %').fill('5');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${API_BASE_URL}/hq/restaurants/${restaurantAId}/settings`));

  // 10. Создать новый заказ (после смены ставки).
  const orderA6 = await createDeliveredPaidOrder(restaurantAId, menuItemA.id, 1); // 1000 ₽ -> ожидается комиссия 5% = 50 ₽

  // 11. Старые заказы сохраняют снимок прежней комиссии (10%), новый
  // заказ использует новую ставку (5%) — проверка напрямую по БД (точнее
  // текстового совпадения на экране).
  expect(await commissionAmountFor(orderA1)).toBe(100);
  expect(await commissionAmountFor(orderA2)).toBe(200);
  expect(await commissionAmountFor(orderA6)).toBe(50);

  await page.goto(`${API_BASE_URL}/hq/finance?period=today`);
  const rowAAfter = await financeRow(page, nameA);
  await expect(rowAAfter).toContainText('4000 ₽'); // оборот 3000+1000
  await expect(rowAAfter).toContainText('350 ₽'); // комиссия 300 (старая ставка) + 50 (новая)
  await expect(rowAAfter).toContainText('3650 ₽');

  // 12. Mobile 390×844 — без горизонтального overflow, экран читаем.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${API_BASE_URL}/hq/finance?period=today`);
  await expect(page.getByRole('heading', { name: 'Финансы' })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);

  // 13 (повтор на мобильном viewport). Ни одной кнопки выплаты.
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);
  void orderB1;
});
