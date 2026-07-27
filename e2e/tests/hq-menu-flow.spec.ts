import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// YAAM HQ Stage 5A — полный браузерный сценарий управления меню (задание,
// раздел 19D, все 26 пунктов): создать ресторан -> опубликовать -> открыть
// без меню отклонено -> категория -> блюдо (полные данные) -> открыть
// ресторан -> публичный сайт/API -> карточка блюда -> корзина -> заказ ->
// правка цены/названия -> публично изменилось, старый заказ сохранил
// снимок -> недоступность -> авто-закрытие -> нельзя заказать -> вернуть
// доступность -> снова открыть -> архив -> исчез публично -> восстановить
// (остаётся недоступным) -> audit log.
//
// Тот же общий эфемерный стек, что и остальные HQ e2e-сценарии
// (createPostgresqlApp() + embedded PostgreSQL), ПЛЮС статический
// клиентский сервер (CLIENT_BASE_URL, см. orders-count-badge.spec.ts) —
// нужен реальный публичный сайт для шагов 11-13/16/24.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const CLIENT_BASE_URL = process.env.YAAM_E2E_CLIENT_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !CLIENT_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_CLIENT_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD / YAAM_E2E_DATABASE_URL не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orderService = require(path.join(SERVER_DIR, 'services/postgresql/orderService.js'));

async function pointFrontendAtLocalBackend(page: Page) {
  await page.addInitScript((apiBaseUrl) => {
    // @ts-expect-error глобал браузерного рантайма
    window.YAAM_API_BASE_URL = apiBaseUrl;
  }, API_BASE_URL);
}

function uniquePhone(): string {
  return '+79' + String(crypto.randomInt(100000000, 999999999)).padStart(9, '0');
}

test('YAAM HQ: полный цикл меню — категория, блюдо, публикация, заказ, правка, недоступность, архив', async ({ page }) => {
  const restaurantName = `E2E Menu ${crypto.randomBytes(4).toString('hex')}`;
  const dishName = 'Шашлык из баранины';

  page.on('dialog', (dialog) => dialog.accept());

  // 1. Войти в HQ.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Создать новый ресторан.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(restaurantName);
  await page.locator('#rf-cities').fill('Грозный');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/restaurants/\\d+$`));
  const restaurantUrl = page.url();
  const restaurantId = Number(restaurantUrl.split('/').pop());
  // Форма пишет action относительным путём (linkBasePath, не origin) —
  // CSS-селектор по [action="..."] должен сравнивать с тем же относительным
  // путём, иначе строкового совпадения не будет никогда.
  const restaurantPath = restaurantUrl.replace(API_BASE_URL!, '');

  // 3. Опубликовать.
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.locator('span.badge').filter({ hasText: 'Закрыт' })).toBeVisible();

  // 4. Попытаться открыть без меню — кнопка «Открыть» видна (ресторан уже
  // опубликован и закрыт), но сервер отклоняет само действие, а не просто
  // прячет кнопку (задание, раздел 13: "серверная проверка, а не только
  // disabled-кнопка").
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await expect(page.getByText('Добавьте хотя бы одно доступное блюдо')).toBeVisible();
  await expect(page.locator('span.badge').filter({ hasText: 'Закрыт' })).toBeVisible();

  // 5. Открыть вкладку «Меню».
  await page.locator('.tabs').getByRole('link', { name: 'Меню' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/menu`);
  await expect(page.getByText('В меню пока нет блюд.')).toBeVisible();

  // 6. Создать категорию «Горячее».
  await page.locator('input[name="name"]').first().fill('Горячее');
  await page.getByRole('button', { name: '+ Добавить категорию' }).click();
  await expect(page.getByText('Горячее')).toBeVisible();

  // 7-8. Добавить блюдо вручную — название/цена/состав/вес/калории/БЖУ.
  await page.getByRole('link', { name: '+ Добавить блюдо' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/menu/items/new`);
  await expect(page.getByRole('button', { name: 'Выбрать блюдо' })).toHaveCount(0);
  await page.locator('#if-name').fill(dishName);
  await page.locator('#if-price').fill('650');
  await page.locator('#if-description').fill('Сочный шашлык на углях');
  await page.locator('#if-composition').fill('баранина, лук, специи');
  await page.locator('#if-weight').fill('300');
  await page.locator('#if-kcal').fill('540');
  await page.locator('#if-protein').fill('25');
  await page.locator('#if-fat').fill('40');
  await page.locator('#if-carbs').fill('5');
  await page.getByRole('button', { name: 'Добавить блюдо' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/menu`);

  // 9. Проверить его в HQ.
  await expect(page.getByText(dishName)).toBeVisible();
  await expect(page.getByText('650 ₽')).toBeVisible();

  const itemRows = await db.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
  const itemId = itemRows[0].id;

  // 10. Открыть ресторан.
  await page.goto(restaurantUrl);
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await expect(page.getByText('Открыт', { exact: true })).toBeVisible();

  // 11. Проверить публичный API.
  let publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  expect(publicOne.is_open).toBe(1);
  const publicDish = publicOne.menu[0].items.find((i: { name: string }) => i.name === dishName);
  expect(publicDish).toBeTruthy();
  expect(publicDish.price).toBe(650);
  expect(publicDish.weight_g).toBe(300);
  expect(publicDish.kcal).toBe(540);
  expect(publicDish).not.toHaveProperty('archived_at');

  // 11-13. Публичный сайт — карточка блюда, корзина.
  await pointFrontendAtLocalBackend(page);
  await page.goto(CLIENT_BASE_URL!);
  await page.locator('.card', { hasText: restaurantName }).click();
  await expect(page.getByText(dishName).first()).toBeVisible();
  await expect(page.getByText('650 ₽').first()).toBeVisible();
  await page.getByText(dishName).first().click(); // открыть карточку блюда
  await expect(page.locator('#d-name')).toHaveText(dishName);
  await expect(page.locator('#d-sostav')).toHaveText('баранина, лук, специи');
  await expect(page.locator('#d-kbju')).toContainText('540');
  await page.locator('#d-add').click(); // добавить в корзину

  // 14. Создать тестовый заказ (напрямую через orderService — тот же приём,
  // что и в остальных HQ e2e-сценариях, полный браузерный checkout — вне
  // scope этого теста, который проверяет именно меню).
  const orderPayload = {
    restaurantId, city: 'Грозный', customerName: 'E2E Клиент', customerPhone: uniquePhone(),
    address: 'ул. E2E, 1', comment: '', fulfillmentType: 'delivery',
    items: [{ menuItemId: itemId, name: dishName, qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(orderPayload);
  expect(order.items_total).toBe(650);

  // 15. Изменить цену/название в HQ.
  await page.goto(`${restaurantUrl}/menu/items/${itemId}`);
  await page.locator('#if-name').fill(`${dishName} (новый рецепт)`);
  await page.locator('#if-price').fill('800');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/menu`);

  // 16. Публично новые данные изменились.
  publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  const updatedPublicDish = publicOne.menu[0].items.find((i: { id: number }) => i.id === itemId);
  expect(updatedPublicDish.name).toBe(`${dishName} (новый рецепт)`);
  expect(updatedPublicDish.price).toBe(800);

  // 17. Старый заказ сохранил прежнее название/цену.
  const oldOrderItems = await db.query('SELECT name, price FROM order_items WHERE order_id = $1', [order.id]);
  expect(oldOrderItems[0].name).toBe(dishName);
  expect(oldOrderItems[0].price).toBe(650);

  // 18. Сделать блюдо недоступным.
  await page.goto(`${restaurantUrl}/menu`);
  const unavailableForm = page.locator(`form[action="${restaurantPath}/menu/items/${itemId}/available"]`);
  await unavailableForm.getByRole('button').click();

  // 19. Убедиться, что ресторан закрылся (это единственное доступное блюдо).
  await page.goto(restaurantUrl);
  await expect(page.locator('span.badge').filter({ hasText: 'Закрыт' })).toBeVisible();
  const restaurantRow = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [restaurantId]);
  expect(restaurantRow[0].is_open).toBe(0);

  // 20. Убедиться, что добавить блюдо в новый заказ нельзя.
  await expect(orderService.createOrderAndResolve({
    ...orderPayload,
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  })).rejects.toThrow(/закрыт/);

  // 21. Вернуть доступность.
  await page.goto(`${restaurantUrl}/menu`);
  const availableForm = page.locator(`form[action="${restaurantPath}/menu/items/${itemId}/available"]`);
  await availableForm.getByRole('button').click();

  // 22. Снова открыть ресторан.
  await page.goto(restaurantUrl);
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await expect(page.getByText('Открыт', { exact: true })).toBeVisible();

  // 23. Архивировать блюдо.
  await page.goto(`${restaurantUrl}/menu`);
  const archiveForm = page.locator(`form[action="${restaurantPath}/menu/items/${itemId}/archive"]`);
  await archiveForm.getByRole('button').click();

  // 24. Убедиться, что оно исчезло публично.
  publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  const namesAfterArchive = (publicOne.menu[0]?.items || []).map((i: { name: string }) => i.name);
  expect(namesAfterArchive).not.toContain(`${dishName} (новый рецепт)`);

  // 25. Восстановить — остаётся недоступным.
  await page.goto(`${restaurantUrl}/menu?filter=archived`);
  const restoreForm = page.locator(`form[action="${restaurantPath}/menu/items/${itemId}/restore"]`);
  await restoreForm.getByRole('button').click();
  await page.goto(`${restaurantUrl}/menu`);
  await expect(page.getByText('Временно недоступно')).toBeVisible();

  // 26. Проверить audit log.
  const auditRows = await db.query(
    'SELECT action, details FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id',
    [restaurantId],
  );
  const actions = auditRows.map((r: { action: string }) => r.action);
  expect(actions).toContain('restaurant_created');
  expect(actions).toContain('restaurant_published');
  expect(actions).toContain('category_created');
  expect(actions).toContain('menu_item_created');
  expect(actions).toContain('menu_item_updated');
  expect(actions).toContain('menu_item_unavailable');
  expect(actions).toContain('menu_item_available');
  expect(actions).toContain('menu_item_archived');
  expect(actions).toContain('menu_item_restored');
  const autoCloseRow = auditRows.find((r: { details: string | null }) => (r.details || '').includes('auto'));
  expect(autoCloseRow, 'авто-закрытие ресторана при отключении последнего доступного блюда должно быть в audit log').toBeTruthy();
});
