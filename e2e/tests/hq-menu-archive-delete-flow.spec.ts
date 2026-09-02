import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ — окончательное удаление из архива меню в НАСТОЯЩЕМ браузере.
//
// Именно браузерный прогон здесь не формальность: подтверждение удаления
// живёт в hq/static/hq.js под строгим CSP страницы (script-src 'self'), и
// проверить, что оно реально показывается, реально отменяется и реально
// доводит удаление до конца, можно только с исполняемым JS. Заодно
// фиксируется, что диалог — СВОЙ, а не window.confirm: любой нативный
// dialog-эвент в этом сценарии считается провалом.
//
// Проверяется desktop и мобильный viewport (390x844) — на узком экране
// кнопки архива переносятся, и «Удалить навсегда» должна оставаться
// доступной и кликабельной, а не уезжать за край.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD / YAAM_E2E_DATABASE_URL не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));

test('YAAM HQ: архив меню — восстановление и необратимое удаление блюда и категории (desktop + mobile)', async ({ page }) => {
  const restaurantName = `E2E ArchDel ${crypto.randomBytes(4).toString('hex')}`;
  const dishName = 'Блюдо на удаление';

  // Нативный confirm() под этим CSP не сработал бы вовсе — если он вдруг
  // появится, тест обязан упасть, а не тихо принять диалог.
  const nativeDialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const cspViolations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text());
  });

  // 1. Логин.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Ресторан + категория + блюдо.
  await page.goto(`${API_BASE_URL}/hq/restaurants/new`);
  await page.locator('#rf-name').fill(restaurantName);
  await page.locator('#rf-city-0').check();
  await page.locator('#rf-submit').click();
  await page.waitForURL(/\/hq\/restaurants\/\d+$/);
  const restaurantUrl = page.url();
  const restaurantId = Number(restaurantUrl.split('/').pop());
  const menuUrl = `${restaurantUrl}/menu`;
  const restaurantPath = restaurantUrl.replace(API_BASE_URL!, '');

  // Две категории: одна с блюдом (его архивируем), одна пустая (её архивируем
  // целиком) — чтобы в архиве одновременно были обе сущности.
  await page.goto(menuUrl);
  for (const name of ['Горячее', 'Пустая']) {
    await page.locator('details.add-cat > summary').click();
    await page.getByLabel('Название категории').fill(name);
    await page.locator('.add-cat-form button[type=submit]').click();
    await expect(page.locator('.cat-name', { hasText: name })).toBeVisible();
  }

  const categoryRows = await db.query(
    'SELECT id, name FROM categories WHERE restaurant_id = $1 ORDER BY id', [restaurantId],
  );
  const hotCategoryId = categoryRows.find((c: { name: string }) => c.name === 'Горячее').id;
  const emptyCategoryId = categoryRows.find((c: { name: string }) => c.name === 'Пустая').id;

  await page.goto(`${menuUrl}/items/new?category=${hotCategoryId}`);
  await page.locator('#if-name').fill(dishName);
  await page.locator('#if-price').fill('420');
  await page.getByRole('button', { name: 'Добавить блюдо' }).click();
  await expect(page).toHaveURL(menuUrl);

  const itemRows = await db.query('SELECT id FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
  const itemId = itemRows[0].id;

  // 3. Отправить блюдо и пустую категорию в архив.
  // Архивирование тоже проходит через тот же CSP-safe диалог — раньше здесь
  // стоял инлайновый onsubmit="return confirm(...)", который под
  // script-src 'self' браузер молча выбрасывал (подтверждения не было вовсе).
  const sheet = page.locator('.confirm-sheet');
  await page.goto(`${menuUrl}/items/${itemId}`);
  await page.locator(`form[action="${restaurantPath}/menu/items/${itemId}/archive"]`).getByRole('button').click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Архивировать' }).click();
  await expect(page).toHaveURL(menuUrl);

  // Пустую категорию архивирует форма внутри её собственного аккордеона.
  await page.locator(`details.cat-block[data-category-id="${emptyCategoryId}"]`)
    .evaluate((el: HTMLDetailsElement) => { el.open = true; });
  await page.locator(`form[action="${restaurantPath}/menu/categories/${emptyCategoryId}/archive"]`)
    .getByRole('button', { name: 'Архивировать' }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Архивировать' }).click();
  await expect(page).toHaveURL(menuUrl);

  // 4. В архиве видны ОБЕ сущности, у каждой «Восстановить» и «Удалить навсегда».
  await page.goto(`${menuUrl}/archive`);
  await expect(page.getByText('Блюда', { exact: true })).toBeVisible();
  await expect(page.getByText('Категории', { exact: true })).toBeVisible();
  // Имена ищутся строго в строках архива (.dish-name): тот же текст живёт
  // и внутри диалога подтверждения, и без этого уточнения локатор был бы
  // неоднозначным после первого же открытия диалога.
  await expect(page.locator('.dish-name', { hasText: dishName })).toBeVisible();
  await expect(page.locator('.dish-name', { hasText: 'Пустая' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Восстановить', exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Удалить навсегда' })).toHaveCount(2);

  const itemDeleteForm = page.locator(`form[action="${restaurantPath}/menu/items/${itemId}/delete"]`);
  const catDeleteForm = page.locator(`form[action="${restaurantPath}/menu/categories/${emptyCategoryId}/delete"]`);

  // 5. DESKTOP: подтверждение показывается, «Отмена» ничего не удаляет.
  await itemDeleteForm.getByRole('button').click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(dishName);
  await expect(sheet).toContainText('Отменить это нельзя');
  await sheet.getByRole('button', { name: 'Отмена' }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(`${menuUrl}/archive`);
  await expect(page.locator('.dish-name', { hasText: dishName })).toBeVisible();
  expect(await db.query('SELECT id FROM menu_items WHERE id = $1', [itemId])).toHaveLength(1);

  // 6. DESKTOP: подтверждение доводит удаление до конца.
  await itemDeleteForm.getByRole('button').click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Удалить навсегда' }).click();
  await expect(page).toHaveURL(/\/menu\/archive\?notice=/);
  await expect(page.locator('.notice')).toContainText('удалено навсегда');
  await expect(page.locator('.dish-name', { hasText: dishName })).toHaveCount(0);
  expect(await db.query('SELECT id FROM menu_items WHERE id = $1', [itemId])).toHaveLength(0);

  // 7. Reload не возвращает удалённое блюдо.
  await page.goto(`${menuUrl}/archive`);
  await expect(page.locator('.dish-name', { hasText: dishName })).toHaveCount(0);

  // 8. MOBILE: тот же путь для категории на узком экране.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${menuUrl}/archive`);
  const mobileDeleteButton = catDeleteForm.getByRole('button');
  await expect(mobileDeleteButton).toBeVisible();
  const box = await mobileDeleteButton.boundingBox();
  expect(box, 'кнопка удаления должна иметь геометрию на мобильном').toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.height).toBeGreaterThanOrEqual(36);

  await mobileDeleteButton.click();
  await expect(sheet).toBeVisible();
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox!.width).toBeLessThanOrEqual(390);
  await sheet.getByRole('button', { name: 'Отмена' }).click();
  await expect(sheet).toBeHidden();
  expect(await db.query('SELECT id FROM categories WHERE id = $1', [emptyCategoryId])).toHaveLength(1);

  await mobileDeleteButton.click();
  await sheet.getByRole('button', { name: 'Удалить навсегда' }).click();
  await expect(page).toHaveURL(/\/menu\/archive\?notice=/);
  await expect(page.getByText('Архив пуст')).toBeVisible();
  expect(await db.query('SELECT id FROM categories WHERE id = $1', [emptyCategoryId])).toHaveLength(0);

  await page.goto(`${menuUrl}/archive`);
  await expect(page.getByText('Архив пуст')).toBeVisible();

  // 9. Рабочее меню не сломано: оставшаяся категория на месте.
  await page.goto(menuUrl);
  await expect(page.locator('.cat-name', { hasText: 'Горячее' })).toBeVisible();

  // 10. Ни нативных диалогов, ни нарушений CSP.
  expect(nativeDialogs, 'подтверждение должно быть собственным диалогом, а не window.confirm').toEqual([]);
  expect(cspViolations, 'страница архива не должна нарушать CSP').toEqual([]);

  // 11. Аудит зафиксировал оба необратимых действия.
  const auditRows = await db.query(
    'SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id', [restaurantId],
  );
  const actions = auditRows.map((r: { action: string }) => r.action);
  expect(actions).toContain('menu_item_deleted');
  expect(actions).toContain('category_deleted');
});
