import { test, expect } from '@playwright/test';

// YAAM HQ Stage 2 — браузерный E2E-сценарий входа/навигации/выхода (задание,
// раздел 10, категория C, все 10 пунктов): открыть HQ без сессии -> оказаться
// на логине -> ввести тестовые данные -> войти -> увидеть «Обзор» -> увидеть
// реальные тестовые метрики -> перейти по Рестораны/Финансы/Настройки ->
// выйти -> кнопка "назад" не открывает защищённую страницу повторно ->
// повторный доступ снова ведёт на логин. Использует тот же эфемерный стек
// (embedded PostgreSQL + createPostgresqlApp()), что и
// critical-order-smoke.spec.ts — HQ отдаётся напрямую backend'ом
// (API_BASE_URL/hq/...), НЕ через client static-server (HQ не является
// частью публичного client/).

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD не заданы — globalSetup не выполнился?');
}

test('YAAM HQ: вход, «Обзор» с реальными метриками, навигация, выход, защита от back-button', async ({ page }) => {
  // 1-2. Открыть HQ без сессии -> оказаться на экране логина.
  await page.goto(`${API_BASE_URL}/hq`);
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/login`);
  await expect(page.locator('h1')).toHaveText('YAAM HQ');

  // 3-4. Ввести тестовые данные и войти.
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();

  // 5. Оказаться на «Обзор».
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
  await expect(page.locator('h1')).toHaveText('Обзор');

  // 6. Реальные (не выдуманные) тестовые метрики — сид создаёт как минимум
  // один открытый ресторан (server/db/postgresql/seed.js), поэтому
  // "Активные рестораны" >= 1 — не проверяем точное число заказов/оборота
  // (зависит от порядка прогонов других spec-файлов в этом же общем
  // backend'е), а проверяем, что блок метрик реально отрендерился числами,
  // не заглушками/NaN/пустой строкой.
  const metricValues = page.locator('.metric-grid .metric .value').first();
  await expect(metricValues).toBeVisible();
  const activeRestaurantsCard = page.locator('.metric', { hasText: 'Активные рестораны' });
  await expect(activeRestaurantsCard).toBeVisible();
  const activeRestaurantsValue = await activeRestaurantsCard.locator('.value').innerText();
  expect(Number.isInteger(Number(activeRestaurantsValue))).toBe(true);
  expect(Number(activeRestaurantsValue)).toBeGreaterThanOrEqual(1);
  await expect(page.getByText('Банковские выплаты будут доступны после подключения финансового модуля.')).toBeVisible();

  // 7. Переходы по Рестораны / Финансы / Настройки — общий layout, рабочие
  // состояния (не 404, не пустая страница). Раздел «Рестораны» — Stage 4,
  // полноценный рабочий раздел (не заглушка, см. hq-restaurant-management-
  // flow.spec.ts за полным сценарием) — здесь достаточно подтвердить, что
  // список открывается и показывает честное пустое состояние или
  // добавленные другими тестами рестораны, не конкретный текст-заглушку.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/restaurants`);
  await expect(page.getByRole('link', { name: '+ Добавить ресторан' })).toBeVisible();

  await page.getByRole('link', { name: 'Финансы' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/finance`);
  // Stage 7: страница «Финансы» стала реально рабочим read-only экраном с
  // периодным фильтром (см. hq-restaurant-finance-flow.spec.ts за полным
  // сценарием) — заголовок панели сводки сменился с фиксированного
  // "за сегодня" на "за период" (период по умолчанию всё ещё «сегодня»).
  await expect(page.getByText('Сводка за период (только чтение)')).toBeVisible();

  await page.getByRole('link', { name: 'Настройки' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/settings`);
  await expect(page.getByText(HQ_ADMIN_USER, { exact: true })).toBeVisible();

  // 8. Выход.
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/login`);

  // 9. Кнопка "назад" не должна повторно открыть защищённую страницу из
  // bfcache — сервер уничтожил сессию, поэтому любой возврат к /hq/settings
  // должен снова привести на логин, а не показать закэшированный контент.
  await page.goBack();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/login`);

  // 10. Повторный прямой заход на защищённый раздел — снова логин.
  await page.goto(`${API_BASE_URL}/hq/restaurants`);
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/login`);
});
