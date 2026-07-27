import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 6 — полный браузерный сценарий юридических данных/
// банковских реквизитов/договора (задание, раздел 14D, все 16 пунктов):
// вход -> создать ресторан -> Настройки показывают "не заполнено" -> ИП ->
// сохранить -> банковские реквизиты -> отклонение неверного счёта ->
// исправить -> договор "Подписан" -> "Готовность к выплатам: Готов" ->
// смена статуса на "Приостановлен" -> readiness не готов -> публичный API
// без реквизитов -> audit log -> mobile 390×844.
//
// Тот же общий эфемерный стек, что и hq-restaurant-management-flow.spec.ts
// (embedded PostgreSQL + createPostgresqlApp() из globalSetup, тот же
// процесс, своя копия db-singleton).

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

// Заведомо вымышленные, но математически корректные реквизиты (см.
// server/test/ruRequisites.test.js за перекрёстной сверкой алгоритма на
// реальном публичном примере БИК Сбербанка — здесь используются только
// синтетические значения).
const FICTITIOUS_INN12 = '770912345616';
const FICTITIOUS_OGRNIP = '312770012345008';
const FICTITIOUS_BIK = '044999225';
const FICTITIOUS_RS_VALID = '40702810938050001238';
const FICTITIOUS_RS_BROKEN = '40702810938050001239'; // испорчена последняя цифра
const FICTITIOUS_KS = '30101810400000004565';

test('YAAM HQ: юридические данные, банковские реквизиты, договор — заполнение, валидация, готовность к выплатам, audit log', async ({ page }) => {
  const restaurantName = `E2E Legal ${crypto.randomBytes(4).toString('hex')}`;

  // 1. Войти в HQ.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Создать ресторан.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(restaurantName);
  await page.locator('#rf-cities').fill('Грозный');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/restaurants/\\d+$`));
  const restaurantUrl = page.url();
  const restaurantId = Number(restaurantUrl.split('/').pop());

  // 3. Открыть Настройки.
  await page.goto(`${restaurantUrl}/settings`);
  // exact:true — иначе строка готовности "Не заполнены юридические данные"
  // в шапке (регистронезависимое совпадение подстроки) тоже попадает в
  // выборку наравне с заголовком самой секции.
  await expect(page.getByText('Юридические данные', { exact: true })).toBeVisible();

  // 4. Увидеть «не заполнено» (юр. данные и банковские реквизиты).
  await expect(page.getByText('Не заполнено.')).toHaveCount(2);
  await expect(page.getByText('Готовность к выплатам:')).toContainText('Не заполнены юридические данные');

  // 5-6. Заполнить ИП и сохранить.
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
  await expect(page.getByText('Заполнено').first()).toBeVisible();

  // 7. Заполнить банковские реквизиты.
  await page.getByRole('link', { name: 'Заполнить' }).click(); // теперь единственная оставшаяся секция без данных — банковские реквизиты
  await expect(page).toHaveURL(`${restaurantUrl}/bank-details/edit`);
  await page.getByLabel('Наименование получателя').fill('ИП Тестов Тест Тестович');
  await page.getByLabel('ИНН получателя').fill(FICTITIOUS_INN12);
  await page.getByLabel('БИК банка').fill(FICTITIOUS_BIK);
  await page.getByLabel('Название банка').fill('ТЕСТБАНК');
  await page.getByLabel('Расчётный счёт (20 цифр)').fill(FICTITIOUS_RS_BROKEN);
  await page.getByLabel('Корреспондентский счёт (20 цифр)').fill(FICTITIOUS_KS);

  // 8. Проверить отклонение неверного счёта.
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/bank-details`);
  await expect(page.locator('.error')).toBeVisible();
  await expect(page.locator('.error')).toContainText('Расчётный счёт');
  // Введённые данные должны сохраниться после ошибки (задание, раздел 9).
  await expect(page.getByLabel('Название банка')).toHaveValue('ТЕСТБАНК');

  // 9. Исправить и сохранить.
  await page.getByLabel('Расчётный счёт (20 цифр)').fill(FICTITIOUS_RS_VALID);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));
  await expect(page.getByText('•••• 1238')).toBeVisible(); // маскированный счёт в read-only обзоре
  await expect(page.getByText(FICTITIOUS_RS_VALID)).toHaveCount(0); // полный счёт НЕ виден вне формы редактирования

  // 10. Создать договор со статусом «Подписан».
  await page.getByRole('link', { name: 'Оформить' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/contract/edit`);
  await page.getByLabel('Номер договора').fill('Д-1');
  await page.getByLabel('Статус').selectOption('signed');
  await page.getByLabel('Дата заключения').fill('2026-01-15');
  await page.getByLabel('Комиссия YAAM, %').fill('7');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));

  // 11. Увидеть «Готовность к выплатам: Готов».
  await expect(page.getByText('Готовность к выплатам:')).toContainText('Готов');

  // 12. Изменить статус договора на «Приостановлен».
  await page.getByRole('link', { name: 'Редактировать' }).last().click();
  await expect(page).toHaveURL(`${restaurantUrl}/contract/edit`);
  await page.getByLabel('Статус').selectOption('suspended');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(new RegExp(`^${restaurantUrl}/settings`));

  // 13. Readiness становится не готов.
  await expect(page.getByText('Готовность к выплатам:')).toContainText('Договор не подписан');

  // 14. Публичный API не содержит реквизитов.
  const publicList = await (await page.request.get(`${API_BASE_URL}/api/restaurants`)).text();
  const publicDetail = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).text();
  for (const secret of [FICTITIOUS_INN12, FICTITIOUS_OGRNIP, FICTITIOUS_RS_VALID, FICTITIOUS_KS, FICTITIOUS_BIK, 'Д-1', 'Тестов Тест Тестович']) {
    expect(publicList).not.toContain(secret);
    expect(publicDetail).not.toContain(secret);
  }

  // 15. Audit log.
  const auditRows = await db.query('SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id', [restaurantId]);
  const actions = auditRows.map((r: { action: string }) => r.action);
  for (const expected of [
    // Банковские реквизиты успешно сохраняются РОВНО ОДИН раз в этом сценарии
    // (шаг 8 с неверным счётом отклоняется до записи в БД — событие не
    // создаётся; см. server/test/postgresql/hqRestaurantLegalBankStage6.test.js
    // за отдельным тестом F1, где реальный update тоже проверяется).
    'restaurant_legal_details_created', 'restaurant_bank_details_created',
    'restaurant_contract_created', 'restaurant_contract_status_changed',
  ]) {
    expect(actions).toContain(expected);
  }
  const detailsRows = await db.query('SELECT details FROM hq_audit_log WHERE restaurant_id = $1 AND details IS NOT NULL', [restaurantId]);
  const allDetails = detailsRows.map((r: { details: string }) => r.details).join(' | ');
  expect(allDetails).not.toContain(FICTITIOUS_RS_VALID);
  expect(allDetails).not.toContain(FICTITIOUS_KS);

  // 16. Mobile 390×844 — без горизонтального overflow, форма/секции читаемы.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${restaurantUrl}/settings`);
  await expect(page.getByText('Юридические данные', { exact: true })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
