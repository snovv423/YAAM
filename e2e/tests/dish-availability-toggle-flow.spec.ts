import path from 'node:path';
import { test, expect, webkit, devices, type Page, type Browser } from '@playwright/test';
import { pointFrontendAtLocalBackend as installTestApiHook } from '../fixtures/test-api-hook';

// Полный цикл наличия блюда в настоящем браузере:
//   HQ OFF -> reload сайта: карточка серая, «Нет в наличии», без «+»
//   HQ ON  -> reload сайта: карточка активная, с «+», открывается
// плюс поведение самого переключателя: он показывает только то, что реально
// сохранилось, и не притворяется успешным при ошибке backend'а.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const CLIENT_BASE_URL = process.env.YAAM_E2E_CLIENT_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !CLIENT_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('YAAM_E2E_* не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));

async function seeded() {
  const rest = await db.query(`SELECT id, name FROM restaurants WHERE connect_code = 'stage11b-test-seed-v1'`);
  const items = await db.query(
    `SELECT mi.id, mi.name FROM menu_items mi
       JOIN categories c ON c.id = mi.category_id
      WHERE mi.restaurant_id = $1 AND mi.archived_at IS NULL AND c.archived_at IS NULL
      ORDER BY mi.sort_order, mi.id`,
    [rest[0].id],
  );
  return { restaurantId: rest[0].id as number, restaurantName: rest[0].name as string, dish: items[0] };
}

async function loginHq(page: Page) {
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
}

const dbAvailability = async (id: number) =>
  (await db.query('SELECT is_available FROM menu_items WHERE id = $1', [id]))[0].is_available;

// Карточка блюда на публичной главной ресторана.
function publicCard(page: Page, dishName: string) {
  return page.locator('#m-body .dish', { hasText: dishName }).first();
}
// Именно classList, а не toHaveClass(/dis/): подстрока «dis» есть в самом
// «dish», и такая проверка была бы истинной всегда.
const isGreyed = (card: ReturnType<typeof publicCard>) =>
  card.evaluate((el) => el.classList.contains('dis'));
async function openRestaurant(page: Page, restaurantName: string) {
  await page.goto(CLIENT_BASE_URL!);
  await page.locator('#list .card', { hasText: restaurantName }).first().click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
}

test('HQ toggle: ON зелёный, OFF красный, состояние берётся только из БД', async ({ page }) => {
  const { restaurantId, dish } = await seeded();
  await db.execute('UPDATE menu_items SET is_available = 1 WHERE id = $1', [dish.id]);
  await loginHq(page);
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantId}/menu/items/${dish.id}`);

  const form = page.locator('form[data-stock-toggle]');
  const toggle = form.locator('.stock-toggle');
  await expect(form).toHaveAttribute('data-state', 'on');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // ON — зелёный, OFF — красный; отдельной текстовой подписи рядом нет.
  const green = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(form).not.toContainText(/наличи/i);

  // Переключение плавное: у ползунка есть переход, а не мгновенный скачок.
  const knobTransition = await form.locator('.stock-knob').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(knobTransition)).toBeGreaterThan(0);

  await toggle.click();
  await expect(form).toHaveAttribute('data-state', 'off');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // Цвет читается после того, как переход доиграл: сразу после смены
  // состояния getComputedStyle вернул бы промежуточное значение анимации.
  await expect.poll(() => toggle.evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: 3000 })
    .not.toBe(green);
  // Положение ползунка действительно разное.
  const offX = await form.locator('.stock-knob').evaluate((el) => getComputedStyle(el).transform);
  expect(await dbAvailability(dish.id)).toBe(0);

  await toggle.click();
  await expect(form).toHaveAttribute('data-state', 'on');
  expect(await dbAvailability(dish.id)).toBe(1);
  const onX = await form.locator('.stock-knob').evaluate((el) => getComputedStyle(el).transform);
  expect(onX).not.toBe(offX);

  // Перезагрузка HQ показывает ровно состояние БД, а не то, что было на экране.
  await db.execute('UPDATE menu_items SET is_available = 0 WHERE id = $1', [dish.id]);
  await page.reload();
  await expect(page.locator('form[data-stock-toggle]')).toHaveAttribute('data-state', 'off');
});

test('HQ toggle: ошибка backend не показывает успешное состояние', async ({ page }) => {
  const { restaurantId, dish } = await seeded();
  await db.execute('UPDATE menu_items SET is_available = 1 WHERE id = $1', [dish.id]);
  await loginHq(page);
  await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantId}/menu/items/${dish.id}`);
  const form = page.locator('form[data-stock-toggle]');
  await expect(form).toHaveAttribute('data-state', 'on');

  // Сервер отвечает отказом — переключатель обязан остаться на месте.
  await page.route('**/available', (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Нельзя прямо сейчас.' }) }));
  await form.locator('.stock-toggle').click();
  await expect(form.locator('.stock-error')).toHaveText('Нельзя прямо сейчас.');
  await expect(form, 'положение не меняется, пока backend не сохранил').toHaveAttribute('data-state', 'on');
  expect(await dbAvailability(dish.id)).toBe(1);

  // Сеть упала — то же самое: прежнее состояние и честное сообщение.
  await page.unroute('**/available');
  await page.route('**/available', (route) => route.abort());
  await form.locator('.stock-toggle').click();
  await expect(form.locator('.stock-error')).not.toBeEmpty();
  await expect(form).toHaveAttribute('data-state', 'on');
  await page.unroute('**/available');
});

test('Цикл как в production: OFF -> серое на сайте -> ON -> активное с «+» -> OFF -> снова серое', async ({ page, browser }) => {
  const { restaurantId, restaurantName, dish } = await seeded();
  const hqContext = await browser.newContext();
  const hq = await hqContext.newPage();
  await loginHq(hq);
  const itemUrl = `${API_BASE_URL}/hq/restaurants/${restaurantId}/menu/items/${dish.id}`;
  const setStock = async (want: 'on' | 'off') => {
    await hq.goto(itemUrl);
    const form = hq.locator('form[data-stock-toggle]');
    if ((await form.getAttribute('data-state')) !== want) {
      await form.locator('.stock-toggle').click();
      await expect(form).toHaveAttribute('data-state', want);
    }
    expect(await dbAvailability(dish.id)).toBe(want === 'on' ? 1 : 0);
  };

  try {
    await installTestApiHook(page, API_BASE_URL!);

    // OFF -> публичная карточка серая, «Нет в наличии», заказать нельзя.
    await setStock('off');
    await openRestaurant(page, restaurantName);
    let card = publicCard(page, dish.name);
    await expect(card).toBeVisible();
    await expect(card, 'карточка остаётся на сайте').toContainText(dish.name);
    expect(await isGreyed(card), 'карточка становится серой').toBe(true);
    await expect(card).toContainText('Нет в наличии');
    await expect(card.locator('.add')).toHaveCount(0);
    expect(await card.evaluate((el) => getComputedStyle(el).filter)).toContain('grayscale');
    // Клик по серой карточке никуда не ведёт.
    await card.click();
    await expect(page.locator('#dish')).not.toHaveClass(/active/);

    // ON -> reload сайта -> карточка активна, есть «+», блюдо открывается.
    await setStock('on');
    await page.reload();
    await openRestaurant(page, restaurantName);
    card = publicCard(page, dish.name);
    expect(await isGreyed(card), 'доступное блюдо не гасится').toBe(false);
    await expect(card).not.toContainText('Нет в наличии');
    await expect(card.locator('.add')).toHaveCount(1);
    await card.click();
    await expect(page.locator('#dish')).toHaveClass(/active/);

    // OFF -> reload -> снова серое.
    await setStock('off');
    await openRestaurant(page, restaurantName);
    card = publicCard(page, dish.name);
    expect(await isGreyed(card)).toBe(true);
    await expect(card).toContainText('Нет в наличии');
    await expect(card.locator('.add')).toHaveCount(0);
  } finally {
    await db.execute('UPDATE menu_items SET is_available = 1 WHERE id = $1', [dish.id]);
    await hqContext.close();
  }
});

test('mobile (iPhone/WebKit): переключатель удобен пальцем и работает так же', async () => {
  const { restaurantId, dish } = await seeded();
  await db.execute('UPDATE menu_items SET is_available = 1 WHERE id = $1', [dish.id]);
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await loginHq(page);
    await page.goto(`${API_BASE_URL}/hq/restaurants/${restaurantId}/menu/items/${dish.id}`);

    const form = page.locator('form[data-stock-toggle]');
    const toggle = form.locator('.stock-toggle');
    const box = (await toggle.boundingBox())!;
    // Комфортная площадь нажатия и целиком в экране.
    expect(box.height).toBeGreaterThanOrEqual(30);
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

    await expect(form).toHaveAttribute('data-state', 'on');
    await toggle.tap();
    await expect(form).toHaveAttribute('data-state', 'off');
    expect(await dbAvailability(dish.id)).toBe(0);
    await toggle.tap();
    await expect(form).toHaveAttribute('data-state', 'on');
    expect(await dbAvailability(dish.id)).toBe(1);
  } finally {
    if (browser) await browser.close();
  }
});
