import crypto from 'node:crypto';
import { test, expect, type Page, type Locator } from '@playwright/test';

// Перестановка категорий и блюд в HQ-меню настоящим жестом: мышью на desktop
// и пальцем на мобильном экране. Дефект, ради которого написан сценарий:
// handle'ы были видны, но сортировка не работала — pointerdown с handle блюда
// всплывал ОБОИМ вложенным спискам (ul[data-reorder=items] лежит внутри
// details.cat-block, строки списка категорий), строка выбиралась как
// `closest('.cat-block') || closest('.dish-row')`, и на один жест уходили два
// POST-а с неизменным порядком.
//
// Проверяется именно наблюдаемый результат: порядок меняется на экране,
// уходит на сервер и ПЕРЕЖИВАЕТ reload (то есть записан в БД).

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD не заданы — globalSetup не выполнился?');
}

async function login(page: Page) {
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
}

// Настоящий жест указателем: mouse.down -> серия move -> up. Playwright
// синтезирует полноценные pointer-события, поэтому проверяется тот же путь,
// что и у владельца с мышью или пальцем.
async function dragHandleTo(page: Page, handle: Locator, targetY: number) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle не виден');
  const x = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(x, y0 + ((targetY - y0) * i) / 16);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

function catNames(page: Page) {
  return page.locator('[data-reorder="categories"] > .cat-block .cat-name').allTextContents();
}

function dishNames(page: Page, categoryId: string) {
  return page.locator(`[data-reorder="items"][data-category-id="${categoryId}"] > .dish-row .dish-name`).allTextContents();
}

test('YAAM HQ: категории и блюда переставляются перетаскиванием, порядок переживает reload', async ({ page }) => {
  const suffix = crypto.randomBytes(3).toString('hex');
  const restaurantName = `E2E Reorder ${suffix}`;
  page.on('dialog', (dialog) => dialog.accept());

  await login(page);

  // Ресторан с двумя категориями и тремя блюдами в первой.
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(restaurantName);
  await page.locator('#rf-city-0').check();
  await page.locator('#rf-submit').click();
  await page.waitForURL(/\/hq\/restaurants\/\d+$/);
  const menuUrl = `${page.url()}/menu`;
  await page.goto(menuUrl);

  for (const name of ['Первая', 'Вторая']) {
    await page.locator('details.add-cat > summary').click();
    await page.getByLabel('Название категории').fill(name);
    await page.locator('.add-cat-form button[type=submit]').click();
  }
  expect(await catNames(page)).toEqual(['Первая', 'Вторая']);

  const firstCategoryId = await page.locator('[data-reorder="categories"] > .cat-block').first().getAttribute('data-category-id');
  for (const [name, price] of [['Блюдо A', '100'], ['Блюдо B', '200'], ['Блюдо C', '300']]) {
    await page.goto(`${menuUrl}/items/new?category=${firstCategoryId}`);
    await page.locator('#if-name').fill(name);
    await page.locator('#if-price').fill(price);
    await page.getByRole('button', { name: 'Добавить блюдо' }).click();
  }

  await page.goto(menuUrl);
  await page.locator('details.cat-block').first().evaluate((el: HTMLDetailsElement) => { el.open = true; });
  expect(await dishNames(page, firstCategoryId!)).toEqual(['Блюдо A', 'Блюдо B', 'Блюдо C']);

  // 1. Блюдо: A уезжает под B. Ровно этот жест раньше таскал всю категорию.
  const dishRows = page.locator(`[data-reorder="items"][data-category-id="${firstCategoryId}"] > .dish-row`);
  const secondDishBox = await dishRows.nth(1).boundingBox();
  await dragHandleTo(page, dishRows.nth(0).locator('.drag-handle'), secondDishBox!.y + secondDishBox!.height * 0.75);
  await expect.poll(() => dishNames(page, firstCategoryId!)).toEqual(['Блюдо B', 'Блюдо A', 'Блюдо C']);

  // 2. Категория: «Первая» уезжает под «Вторую» (владелец переставляет их
  //    свёрнутыми — раскрытая категория выше экрана).
  await page.locator('details.cat-block').first().evaluate((el: HTMLDetailsElement) => { el.open = false; });
  const catBlocks = page.locator('[data-reorder="categories"] > .cat-block');
  const secondCatBox = await catBlocks.nth(1).boundingBox();
  await dragHandleTo(page, catBlocks.nth(0).locator('.cat-handle'), secondCatBox!.y + secondCatBox!.height * 0.75);
  await expect.poll(() => catNames(page)).toEqual(['Вторая', 'Первая']);

  // 3. Порядок записан в БД: он должен пережить перезагрузку страницы.
  await page.reload();
  expect(await catNames(page)).toEqual(['Вторая', 'Первая']);
  await page.locator(`details.cat-block[data-category-id="${firstCategoryId}"]`).evaluate((el: HTMLDetailsElement) => { el.open = true; });
  expect(await dishNames(page, firstCategoryId!)).toEqual(['Блюдо B', 'Блюдо A', 'Блюдо C']);
});

test('YAAM HQ (мобильный экран): перетаскивание пальцем работает, обычная прокрутка ничего не переставляет', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const suffix = crypto.randomBytes(3).toString('hex');
  page.on('dialog', (dialog) => dialog.accept());

  await login(page);
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(`E2E Reorder Mobile ${suffix}`);
  await page.locator('#rf-city-0').check();
  await page.locator('#rf-submit').click();
  await page.waitForURL(/\/hq\/restaurants\/\d+$/);
  const menuUrl = `${page.url()}/menu`;
  await page.goto(menuUrl);

  await page.locator('details.add-cat > summary').click();
  await page.getByLabel('Название категории').fill('Мобильная');
  await page.locator('.add-cat-form button[type=submit]').click();
  const categoryId = await page.locator('[data-reorder="categories"] > .cat-block').first().getAttribute('data-category-id');
  for (const [name, price] of [['Мобильное A', '100'], ['Мобильное B', '200'], ['Мобильное C', '300']]) {
    await page.goto(`${menuUrl}/items/new?category=${categoryId}`);
    await page.locator('#if-name').fill(name);
    await page.locator('#if-price').fill(price);
    await page.getByRole('button', { name: 'Добавить блюдо' }).click();
  }
  await page.goto(menuUrl);
  await page.locator('details.cat-block').first().evaluate((el: HTMLDetailsElement) => { el.open = true; });

  const rows = page.locator(`[data-reorder="items"][data-category-id="${categoryId}"] > .dish-row`);
  await rows.nth(1).scrollIntoViewIfNeeded();
  const handleBox = await rows.nth(0).locator('.drag-handle').boundingBox();
  const targetBox = await rows.nth(1).boundingBox();

  // Настоящий тач-жест по handle.
  const cdp = await context.newCDPSession(page);
  const x = handleBox!.x + handleBox!.width / 2;
  const y0 = handleBox!.y + handleBox!.height / 2;
  const y1 = targetBox!.y + targetBox!.height * 0.75;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 16; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 16 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => dishNames(page, categoryId!)).toEqual(['Мобильное B', 'Мобильное A', 'Мобильное C']);

  await page.reload();
  await page.locator('details.cat-block').first().evaluate((el: HTMLDetailsElement) => { el.open = true; });
  expect(await dishNames(page, categoryId!)).toEqual(['Мобильное B', 'Мобильное A', 'Мобильное C']);

  // Вертикальный свайп по самой строке (не по handle) обязан прокручивать
  // страницу и НЕ переставлять блюда — иначе меню нельзя было бы листать.
  const linkBox = await page.locator(`[data-reorder="items"][data-category-id="${categoryId}"] .dish-link`).first().boundingBox();
  const sx = linkBox!.x + linkBox!.width / 2;
  const sy = linkBox!.y + linkBox!.height / 2;
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 16 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  // Прокрутка проверяется только если странице есть куда прокручиваться:
  // в этой фикстуре меню короткое, и на длину страницы тест опираться не должен.
  if (scrollable) expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);
  expect(await dishNames(page, categoryId!)).toEqual(['Мобильное B', 'Мобильное A', 'Мобильное C']);

  await context.close();
});
