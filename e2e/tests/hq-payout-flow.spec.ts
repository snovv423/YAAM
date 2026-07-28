import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 9 / 9.5 — полный браузерный сценарий сущности выплаты + её
// попыток (NO bank integration): войти -> создать ресторан -> доставленный
// оплаченный заказ -> создать и закрыть расчётный период -> открыть период,
// увидеть "Не создана" + "Подготовить выплату" -> подготовить выплату (НЕ
// перевод денег, только внутренняя запись) -> карточка выплаты показывает
// статус "Подготовлена" и точную сумму (= settlement_restaurant_lines.
// payable_amount, без пересчёта) -> период теперь показывает "Выплата
// создана" со ссылкой -> список /hq/payouts показывает строку -> Обзор
// показывает статистику выплат -> [Stage 9.5] создать первую попытку через
// внутренний сервис (НЕ через UI — банковской интеграции ещё нет), увидеть
// "В обработке" -> "Неопределённый результат" -> убедиться, что вторую
// активную попытку создать нельзя -> первая попытка проваливается с
// retryable=true (обязательство возвращается в "Подготовлена") -> создать
// вторую попытку с ДРУГИМ payment_id -> вторая попытка завершается успехом
// (обязательство -> "Успешно" с реальной датой) -> обе попытки остаются
// видны в истории на карточке -> mobile 390×844 -> нигде нет кнопок
// «Выплатить» / «Отправить в банк» / «Повторить» / фейкового банка.
//
// Заказ продвигается напрямую через orderService (тот же приём, что и
// hq-restaurant-finance-flow.spec.ts/hq-settlement-periods-flow.spec.ts).
// Попытки выплаты продвигаются напрямую через payoutService (задание, раздел
// 16, дословно: "create the first attempt via the internal service or a test
// helper, NOT a fake bank UI") — ценность браузерной проверки здесь в
// экранах HQ (период / список выплат / карточка выплаты с историей попыток /
// Обзор), не в имитации реального банковского API.

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
// Stage 9.6 — createPayoutAttempt теперь требует immutable snapshot
// реквизитов (реквизиты YAAM + ресторана + подписанный договор); этот
// Stage 9/9.5 сценарий сам про попытки не про реквизиты, поэтому они
// сидируются напрямую сервисами (не через UI — это отдельный, уже
// протестированный flow, см. hq-restaurant-legal-bank-flow.spec.ts и
// hq-tbank-readiness-flow.spec.ts), а не дублируются здесь по шагам.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaamBankDetailsService = require(path.join(SERVER_DIR, 'services/hq/yaamBankDetailsService.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const restaurantBankDetailsService = require(path.join(SERVER_DIR, 'services/hq/restaurantBankDetailsService.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const restaurantContractService = require(path.join(SERVER_DIR, 'services/hq/restaurantContractService.js'));

const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS = '40702810938050001238';
const FICTITIOUS_KS = '30101810400000004565';
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_INN10 = '7709123453';
const FICTITIOUS_KPP = '770101001';

async function seedPayoutAttemptReadiness(restaurantId: number) {
  await yaamBankDetailsService.saveYaamBankDetails({
    legal_name: 'ООО YAAM Платформа', inn: FICTITIOUS_INN10, kpp: FICTITIOUS_KPP,
    account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК', correspondent_account: FICTITIOUS_KS,
  });
  await restaurantBankDetailsService.saveBankDetails(restaurantId, {
    recipient_name: 'ИП Тестов Тест Тестович', recipient_inn: FICTITIOUS_INN12, recipient_kpp: '',
    account_number: FICTITIOUS_RS, bik: FICTITIOUS_BIK, bank_name: 'ТЕСТБАНК', correspondent_account: FICTITIOUS_KS,
    default_payment_purpose: 'Оплата услуг доставки по договору',
  });
  await restaurantContractService.saveContract(restaurantId, {
    contract_number: `Д-${restaurantId}`, status: 'signed', signed_at: '2026-01-01', commission_percent: '7',
  });
}

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
  await seedPayoutAttemptReadiness(restaurantId);

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
  // .first() — на карточке уже два .panel (детали обязательства + история
  // попыток, добавлена в Stage 9.5), поэтому обращаемся именно к первой.
  // obligationBadge — сам <span class="badge">, а не текстовый поиск по всей
  // панели: несколько строк панели содержат текст статуса как ПОДСТРОКУ
  // (например "В обработке с", "Завершена успешно"), из-за чего обычный
  // getByText(...) ловит более одного элемента (strict-mode violation).
  const obligationBadge = page.locator('.panel').first().locator('.badge');
  await expect(obligationBadge).toHaveText('Подготовлена');
  await expect(page.locator('.panel').first()).toContainText('1860 ₽');
  await expect(page.getByRole('link', { name: name })).toBeVisible();
  await expect(page.getByText('Попыток обращения к банку ещё не было.')).toBeVisible();
  const payoutId = Number(payoutUrl.split('/').pop());

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

  // 10. [Stage 9.5] Первая попытка через внутренний сервис (НЕ через UI —
  // задание, раздел 16: "create the first attempt via the internal service
  // or a test helper, NOT a fake bank UI"). created -> submitting ->
  // processing -> unknown.
  const attempt1 = await payoutService.createPayoutAttempt(payoutId);
  await payoutService.markAttemptSubmitting(attempt1.id);
  await page.goto(payoutUrl);
  await expect(obligationBadge).toHaveText('В обработке');
  await expect(page.getByRole('button', { name: 'Выплатить' })).toHaveCount(0);
  await expect(page.getByText(/Отправить в банк/i)).toHaveCount(0);
  await expect(page.getByText(/Повторить попытку/i)).toHaveCount(0);

  await payoutService.markAttemptProcessing(attempt1.id, 'IN_PROGRESS');
  await payoutService.markAttemptUnknown(attempt1.id, 'нет ответа от банка в отведённое время');
  await page.goto(payoutUrl);
  await expect(obligationBadge).toHaveText('Неопределённый результат');

  // 11. Пока попытка активна (unknown ещё не разрешён) — вторую создать
  // нельзя, ни через сервис (партиальный UNIQUE-индекс делает это физически
  // невозможным на уровне БД — см. server/test/postgresql/hqPayoutStage9.test.js).
  await expect(payoutService.createPayoutAttempt(payoutId)).rejects.toThrow(/Нельзя создать попытку|активная попытка/i);

  // 12. Первая попытка провалилась, retryable=true — обязательство
  // возвращается в "Подготовлена" (деньги ещё не выплачены, но это НЕ
  // тупиковый статус — задание, раздел 12).
  await payoutService.markAttemptFailed(attempt1.id, {
    errorMessage: 'Недостаточно средств на счёте банка-отправителя', retryable: true,
  });
  await page.goto(payoutUrl);
  await expect(obligationBadge).toHaveText('Подготовлена');
  const attempt1Row = page.locator('table.responsive tbody tr', { hasText: attempt1.payment_id });
  await expect(attempt1Row).toContainText('Ошибка');
  await expect(attempt1Row).toContainText('Недостаточно средств на счёте банка-отправителя');

  // 13. Вторая попытка — ДРУГОЙ payment_id, доходит до успеха.
  const attempt2 = await payoutService.createPayoutAttempt(payoutId);
  expect(attempt2.payment_id).not.toBe(attempt1.payment_id);
  await payoutService.markAttemptSubmitting(attempt2.id);
  await payoutService.markAttemptProcessing(attempt2.id, 'COMPLETED');
  await payoutService.markAttemptSucceeded(attempt2.id, 'COMPLETED');

  // 14. Карточка: обязательство «Успешно» с реальной датой, ОБЕ попытки
  // остаются видны в истории (провалившаяся первая не стирается второй).
  await page.goto(payoutUrl);
  await expect(obligationBadge).toHaveText('Успешно');
  await expect(page.locator('.panel').first()).toContainText('Завершена успешно');
  await expect(page.locator('table.responsive tbody tr', { hasText: attempt1.payment_id })).toContainText('Ошибка');
  const attempt2Row = page.locator('table.responsive tbody tr', { hasText: attempt2.payment_id });
  await expect(attempt2Row).toContainText('Успешно');
  await expect(page.getByRole('button', { name: 'Выплатить' })).toHaveCount(0);
  await expect(page.getByText(/Отправить в банк/i)).toHaveCount(0);
  await expect(page.getByText(/Повторить попытку/i)).toHaveCount(0);

  // 15. Список «Выплаты» тоже отражает финальный статус «Успешно».
  await page.goto(`${API_BASE_URL}/hq/payouts`);
  await expect(page.locator('tr', { hasText: name })).toContainText('Успешно');

  // 16. Обзор — статистика выплат видна (без графиков, просто числа).
  await page.goto(`${API_BASE_URL}/hq`);
  await expect(page.getByText('Успешных выплат')).toBeVisible();
  await expect(page.getByText('Сумма к выплате (ещё не оплачено)')).toBeVisible();

  // 17. Mobile 390×844 — без горизонтального overflow, на списке и карточке
  // (карточка теперь содержит таблицу истории попыток — проверяем именно её).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${API_BASE_URL}/hq/payouts`);
  await expect(page.getByRole('heading', { name: 'Выплаты' })).toBeVisible();
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.goto(payoutUrl);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);

  // 18. Нигде на этих экранах нет кнопки/ссылки выплаты денег/фейкового банка.
  await expect(page.getByText(/Выплатить/i)).toHaveCount(0);
  await expect(page.getByText(/Отправить в банк/i)).toHaveCount(0);
  await expect(page.getByText(/Повторить попытку/i)).toHaveCount(0);
});
