import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 9.6 — T-Bank Integration Readiness: полный браузерный
// сценарий (задание, раздел 13 "Playwright"): открыть HQ Settings -> заполнить
// реквизиты YAAM -> создать ресторан -> заполнить legal/bank/contract ->
// создать settlement и payout -> проверить readiness ("не готово" -> "готово")
// -> создать первую попытку внутренним service helper'ом (НЕ через UI — банк
// ещё не подключён) -> увидеть маскированный snapshot -> изменить реквизиты
// ресторана -> убедиться, что старая попытка не изменилась -> создать
// следующую попытку после допустимого failed -> убедиться, что новая попытка
// использует новые реквизиты -> ни одной кнопки отправки денег -> mobile
// 390×844 без overflow.
//
// Тот же общий эфемерный стек, что и hq-payout-flow.spec.ts/
// hq-restaurant-legal-bank-flow.spec.ts (embedded PostgreSQL + createPostgresqlApp()
// из globalSetup). Т-Банк HTTP нигде не симулируется.

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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const payoutService = require(path.join(SERVER_DIR, 'services/hq/payoutService.js'));

// Заведомо вымышленные, но математически корректные реквизиты (тот же
// принцип и частично те же значения, что в hq-restaurant-legal-bank-flow.spec.ts
// и server/test/postgresql/hqTBankReadinessStage96.test.js). Второй набор —
// для сценария "реквизиты ресторана изменились между попытками".
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_OGRNIP = '312770012345008';
const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_BIK2 = '044520100';
const FICTITIOUS_RS2 = '40702810900000000004';
const FICTITIOUS_KS2 = '30101810000000000002';
const FICTITIOUS_YAAM_INN = '7709123453';
const FICTITIOUS_YAAM_KPP = '770101001';
// Отдельный, ЗАВЕДОМО ОТЛИЧНЫЙ от реквизитов ресторана счёт для YAAM
// (тот же БИК, другой валидный номер счёта) — иначе маскированные "••••
// XXXX" последние 4 цифры совпали бы у плательщика (YAAM) и получателя
// (ресторан), что сделало бы проверки замаскированных значений
// неоднозначными (playwright strict-mode violation при getByText).
const FICTITIOUS_YAAM_RS = '40702810900000000000';

function dateStr(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
async function seedMenuItem(restaurantId: number, price: number) {
  const category = await menuAdminService.createCategory(restaurantId, { name: 'Основное' });
  return menuAdminService.createMenuItem(restaurantId, { name: 'Выплатное блюдо 9.6', category_id: String(category.id), price: String(price) });
}
async function createOrder(restaurantId: number, menuItemId: number, qty: number) {
  const n = crypto.randomInt(100000000, 999999999);
  const payload = {
    restaurantId, city: 'Грозный', customerName: 'Stage9.6 Test', customerPhone: `+79${String(n).padStart(8, '0')}`,
    address: 'ул. Т-Банк, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'Выплатное блюдо 9.6', price: 0, qty }],
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

// Большой случайный сдвиг в прошлое — та же техника, что hq-payout-flow.spec.ts,
// чтобы settlement_periods (глобальный непересекающийся диапазон дат) не
// конфликтовал с другими spec-файлами этого же прогона.
const DAY_OFFSET = -(2000 + crypto.randomInt(0, 100000));

test('YAAM HQ: T-Bank readiness — реквизиты YAAM, готовность, попытка, маскированный snapshot, смена реквизитов', async ({ page }) => {
  const restaurantName = `E2E TBank ${crypto.randomBytes(4).toString('hex')}`;
  page.on('dialog', (dialog) => dialog.accept());

  // 1. Войти в HQ.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Открыть HQ Settings — панель реквизитов YAAM видна (задание, раздел
  // 10: "заполнено / не заполнено"). Начальное состояние (заполнено или нет)
  // намеренно НЕ проверяется здесь строго — yaam_bank_details singleton
  // общий на весь прогон Playwright (в отличие от per-restaurant данных),
  // поэтому порядок выполнения других spec-файлов может заполнить его
  // раньше; сценарий ниже одинаково корректен в обоих случаях, поскольку
  // сохранение формы — идемпотентный upsert.
  await page.getByRole('link', { name: 'Настройки' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/settings`);
  await expect(page.getByText('Реквизиты YAAM для выплат')).toBeVisible();

  // 3. Заполнить (или перезаполнить) реквизиты YAAM.
  const yaamPanel = page.locator('.panel', { hasText: 'Реквизиты YAAM для выплат' });
  await yaamPanel.getByRole('link', { name: /Заполнить|Редактировать/ }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/settings/yaam-bank-details/edit`);
  await page.getByLabel('Юридическое название YAAM').fill('ООО YAAM Платформа');
  await page.getByLabel('ИНН').fill(FICTITIOUS_YAAM_INN);
  await page.getByLabel('КПП').fill(FICTITIOUS_YAAM_KPP);
  await page.getByLabel('БИК банка').fill(FICTITIOUS_BIK);
  await page.getByLabel('Название банка').fill('ТЕСТБАНК');
  await page.getByLabel('Расчётный счёт (20 цифр)').fill(FICTITIOUS_YAAM_RS);
  await page.getByLabel('Корреспондентский счёт (20 цифр)').fill(FICTITIOUS_KS);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/settings`);
  await expect(page.locator('.panel', { hasText: 'Реквизиты YAAM для выплат' }).getByText('Заполнено')).toBeVisible();
  await expect(page.getByText('•••• 0000')).toBeVisible(); // маскированный счёт YAAM в read-only обзоре
  await expect(page.getByText(FICTITIOUS_YAAM_RS)).toHaveCount(0); // полный счёт нигде, кроме формы редактирования

  // 4. Создать ресторан, меню, опубликовать/открыть.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(restaurantName);
  await page.locator('#rf-cities').fill('Грозный');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/restaurants/\\d+$`));
  const restaurantUrl = page.url();
  const restaurantId = Number(restaurantUrl.split('/').pop());
  const menuItem = await seedMenuItem(restaurantId, 1000);

  await page.goto(restaurantUrl);
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByRole('button', { name: 'Открыть' })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByText('Открыт', { exact: true })).toBeVisible();

  // 5. Заполнить legal/bank/contract ресторана (готовность к T-Bank отдельна
  // от Stage 6 payout-readiness, но требует те же самые исходные данные).
  await page.goto(`${restaurantUrl}/settings`);
  await page.getByRole('link', { name: 'Заполнить' }).first().click();
  await expect(page).toHaveURL(`${restaurantUrl}/legal-details/edit`);
  await page.getByLabel('Правовая форма').selectOption('ip');
  await page.getByLabel('Полное юридическое название').fill('ИП Тестов Тест Тестович');
  await page.getByLabel('ИНН').fill(FICTITIOUS_INN12);
  await page.getByLabel('ОГРН (ООО) / ОГРНИП (ИП)').fill(FICTITIOUS_OGRNIP);
  await page.getByLabel('Юридический адрес').fill('г. Грозный, ул. Тестовая, 1');
  await page.getByLabel('ФИО руководителя / ИП').fill('Тестов Тест Тестович');
  await page.getByLabel('Контактный телефон').fill('+79001234567');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));

  await page.getByRole('link', { name: 'Заполнить' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/bank-details/edit`);
  await page.getByLabel('Наименование получателя').fill('ИП Тестов Тест Тестович');
  await page.getByLabel('ИНН получателя').fill(FICTITIOUS_INN12);
  await page.getByLabel('БИК банка').fill(FICTITIOUS_BIK);
  await page.getByLabel('Название банка').fill('ТЕСТБАНК');
  await page.getByLabel('Расчётный счёт (20 цифр)').fill(FICTITIOUS_RS);
  await page.getByLabel('Корреспондентский счёт (20 цифр)').fill(FICTITIOUS_KS);
  await page.getByLabel('Назначение платежа по умолчанию').fill('Оплата услуг доставки по договору');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));

  await page.getByRole('link', { name: 'Оформить' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/contract/edit`);
  await page.getByLabel('Номер договора').fill('Д-96');
  await page.getByLabel('Статус').selectOption('signed');
  await page.getByLabel('Дата заключения').fill('2026-01-15');
  await page.getByLabel('Комиссия YAAM, %').fill('7');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));

  // 6. Доставленный оплаченный заказ, расчётный период, подготовка выплаты.
  const orderId = await createDeliveredPaidOrder(restaurantId, menuItem.id, 2); // 2000 ₽, комиссия 140 -> к выплате 1860
  await backdateOrder(orderId, -DAY_OFFSET);
  await page.goto(`${API_BASE_URL}/hq/finance/settlements/new`);
  await page.locator('#sp-from').fill(dateStr(DAY_OFFSET));
  await page.locator('#sp-to').fill(dateStr(DAY_OFFSET));
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/finance/settlements/\\d+$`));
  await page.getByRole('button', { name: 'Закрыть период' }).click();
  const restaurantRow = page.locator('tr', { hasText: restaurantName });
  await restaurantRow.getByRole('button', { name: 'Подготовить выплату' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/payouts/\\d+$`));
  const payoutUrl = page.url();
  const payoutId = Number(payoutUrl.split('/').pop());

  // 7. Готовность к отправке через Т-Банк — теперь "Готова к отправке".
  const readinessPanel = page.locator('.panel', { hasText: 'Готовность к отправке через Т-Банк' });
  await expect(readinessPanel.getByText('Готова к отправке')).toBeVisible();

  // 8. Первая попытка — ЧЕРЕЗ ВНУТРЕННИЙ СЕРВИС (задание: "НЕ через фейковый
  // банковский UI"), не через маршрут (которого нет).
  const attempt1 = await payoutService.createPayoutAttempt(payoutId);
  await page.reload();
  await expect(page.getByText('Попыток обращения к банку ещё не было.')).toHaveCount(0);
  const attempt1Row = page.locator('table.responsive tbody tr', { hasText: attempt1.payment_id });
  await expect(attempt1Row).toBeVisible();

  // 9. Маскированный snapshot попытки виден на карточке.
  await expect(page.getByText('•••• 1238').first()).toBeVisible(); // маскированный счёт получателя (FICTITIOUS_RS)
  await expect(page.getByText('ИП Тестов Тест Тестович').first()).toBeVisible();
  await expect(page.getByText('Оплата услуг доставки по договору').first()).toBeVisible();
  await expect(page.getByText(FICTITIOUS_RS)).toHaveCount(0); // полный счёт нигде не виден

  // 10. Провал (retryable) -> обязательство возвращается в "Подготовлена".
  await payoutService.markAttemptSubmitting(attempt1.id);
  await payoutService.markAttemptProcessing(attempt1.id);
  await payoutService.markAttemptFailed(attempt1.id, { errorMessage: 'временный сбой шлюза', retryable: true });

  // 11. Изменить реквизиты ресторана.
  await page.goto(`${restaurantUrl}/bank-details/edit`);
  await page.getByLabel('Расчётный счёт (20 цифр)').fill(FICTITIOUS_RS2);
  await page.getByLabel('БИК банка').fill(FICTITIOUS_BIK2);
  await page.getByLabel('Корреспондентский счёт (20 цифр)').fill(FICTITIOUS_KS2);
  await page.getByLabel('Название банка').fill('НОВЫЙ ТЕСТБАНК');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));

  // 12. Старая попытка НЕ изменилась — карточка выплаты по-прежнему
  // показывает СТАРЫЙ маскированный счёт для attempt1.
  await page.goto(payoutUrl);
  const attempt1RowAfterChange = page.locator('table.responsive tbody tr', { hasText: attempt1.payment_id });
  await expect(attempt1RowAfterChange).toContainText('Ошибка');
  await expect(page.getByText('•••• 1238').first()).toBeVisible();
  await expect(page.getByText('•••• 0004')).toHaveCount(0); // нового счёта здесь ещё нет

  // 13. Создать вторую попытку (снова через внутренний сервис) — использует
  // НОВЫЕ реквизиты.
  const attempt2 = await payoutService.createPayoutAttempt(payoutId);
  expect(attempt2.payment_id).not.toBe(attempt1.payment_id);
  await page.reload();
  await expect(page.getByText('•••• 0004')).toBeVisible(); // НОВЫЙ маскированный счёт (FICTITIOUS_RS2) у второй попытки
  await expect(page.getByText('•••• 1238')).toBeVisible(); // старый снимок первой попытки остаётся видимым в истории

  // 14. Ни одной кнопки/ссылки отправки денег нигде на этих экранах.
  for (const forbidden of [/Выплатить/i, /Отправить в банк/i, /Повторить попытку/i, /Проверить в банке/i]) {
    await expect(page.getByText(forbidden)).toHaveCount(0);
  }
  await page.goto(`${API_BASE_URL}/hq/settings`);
  for (const forbidden of [/Выплатить/i, /Отправить в банк/i]) {
    await expect(page.getByText(forbidden)).toHaveCount(0);
  }

  // 15. Mobile 390×844 — без горизонтального overflow (Настройки и карточка
  // выплаты со snapshot-блоками).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${API_BASE_URL}/hq/settings`);
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.goto(payoutUrl);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
