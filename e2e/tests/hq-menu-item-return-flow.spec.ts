import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// YAAM HQ — сценарий из задания, целиком в настоящем браузере:
// раскрыть категорию -> прокрутить -> открыть блюдо -> посмотреть/изменить ->
// «← Назад» -> оказаться на том же месте у ТОГО ЖЕ блюда.
//
// Проверяется на desktop и на мобильном viewport (390x844), потому что
// восстановление позиции — целиком про геометрию окна, и именно на узком
// экране фиксированная шапка и длинный список дают самый заметный промах.
//
// Отдельно фиксируется, ЧТО ИМЕННО удерживает состояние: адрес
// (?item=N#dish-N + <details open> с сервера) и sessionStorage, а не
// отложенные таймеры — тест ждёт только реальных состояний DOM.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('YAAM_E2E_* не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));

const DISHES_PER_CATEGORY = 8;

async function login(page: Page) {
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
}

// Меню строится прямо в БД: сценарий про навигацию, а не про формы создания,
// а список должен быть заведомо длиннее экрана, чтобы прокрутка была настоящей.
async function seedMenu(name: string) {
  const r = await db.execute(`INSERT INTO restaurants (name, cities) VALUES ($1, '[]') RETURNING id`, [name]);
  const restaurantId = r.rows[0].id;
  const categories: number[] = [];
  for (const [index, label] of ['Завтраки', 'Горячее', 'Салаты', 'Десерты'].entries()) {
    const c = await db.execute(
      'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id',
      [restaurantId, label, index + 1],
    );
    categories.push(c.rows[0].id);
  }
  const items: Record<number, number[]> = {};
  for (const categoryId of categories) {
    items[categoryId] = [];
    for (let n = 1; n <= DISHES_PER_CATEGORY; n += 1) {
      const i = await db.execute(
        'INSERT INTO menu_items (restaurant_id, category_id, name, price, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [restaurantId, categoryId, `Блюдо ${categoryId}-${n}`, 100 * n, n],
      );
      items[categoryId].push(i.rows[0].id);
    }
  }
  return { restaurantId, categories, items };
}

// Категория могла остаться раскрытой сама — состояние ведь и восстанавливается.
// Слепой клик по summary в этом случае СВЕРНУЛ бы её, поэтому раскрываем
// только реально закрытую.
async function ensureOpen(page: Page, categoryId: number) {
  const category = page.locator(`details.cat-block[data-category-id="${categoryId}"]`);
  if ((await category.getAttribute('open')) === null) {
    await category.locator('summary.cat-summary').click();
  }
  await expect(category).toHaveAttribute('open', '');
  return category;
}

// Прокрутить к строке так, чтобы её положение было заведомо нетривиальным
// (не «верх списка» и не «низ экрана»), и вернуть измеренную геометрию.
async function scrollToRow(page: Page, itemId: number) {
  const row = page.locator(`#dish-${itemId}`);
  await row.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(row).toBeVisible();
  return { row, box: (await row.boundingBox())! };
}

async function runReturnScenario(page: Page, label: string) {
  const seeded = await seedMenu(`E2E Return ${label} ${crypto.randomBytes(3).toString('hex')}`);
  const menuUrl = `${API_BASE_URL}/hq/restaurants/${seeded.restaurantId}/menu`;
  // Вторая категория и предпоследнее блюдо в ней: и категория, и строка
  // заведомо не первые — цель «вернулись наверх списка» такой проверки не пройдёт.
  const categoryId = seeded.categories[1];
  const itemId = seeded.items[categoryId][DISHES_PER_CATEGORY - 2];

  // 1. Свежее меню — всё свёрнуто.
  await page.goto(menuUrl);
  await expect(page.locator('details.cat-block[open]')).toHaveCount(0);

  // 2. Раскрыть категорию и проскроллить до нужной строки.
  const category = await ensureOpen(page, categoryId);
  await scrollToRow(page, itemId);

  // 3. Открыть блюдо.
  await page.locator(`#dish-${itemId} .dish-link`).click();
  await expect(page).toHaveURL(`${menuUrl}/items/${itemId}`);

  // Пункт 1 задания: фотографии на карточке стоят ВЫШЕ формы.
  const photosBox = await page.locator('.panel', { hasText: 'Фотографии блюда' }).first().boundingBox();
  const nameBox = await page.locator('#if-name').boundingBox();
  expect(photosBox!.y, `${label}: «Фотографии блюда» должны быть выше поля названия`).toBeLessThan(nameBox!.y);

  // 4. Изменить цену и сохранить.
  await page.locator('#if-price').fill('777');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(menuUrl);

  // Сохранение тоже не выбрасывает в свёрнутый список: та же категория
  // раскрыта, та же строка на виду.
  await expect(category).toHaveAttribute('open', '');
  await expect(page.locator(`#dish-${itemId}`)).toBeVisible();

  // 5. Ещё раз войти в блюдо — теперь измеряем положение строки перед уходом.
  const { box: before } = await scrollToRow(page, itemId);
  await page.locator(`#dish-${itemId} .dish-link`).click();
  await expect(page).toHaveURL(`${menuUrl}/items/${itemId}`);

  // 6. «← Назад».
  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page).toHaveURL(`${menuUrl}?item=${itemId}#dish-${itemId}`);

  // Категория осталась раскрытой, список НЕ схлопнулся.
  await expect(category).toHaveAttribute('open', '');
  const row = page.locator(`#dish-${itemId}`);
  await expect(row).toBeVisible();

  // Строка того же блюда вернулась ровно на то же место в окне. Замер делается
  // ПОСЛЕ полной загрузки: адрес возврата несёт якорь #dish-N, браузер доводит
  // прокрутку к нему сам и уже после defer-скрипта — на боевой странице это
  // ставило строку на scroll-margin-top якоря вместо сохранённого места.
  await page.waitForLoadState('load');
  await expect.poll(async () => {
    const box = await row.boundingBox();
    return Math.round(Math.abs(box!.y - before.y));
  }, { timeout: 5000 }).toBeLessThanOrEqual(4);
  const after = (await row.boundingBox())!;
  expect(Math.abs(after.y - before.y), `${label}: строка блюда должна вернуться на то же место`).toBeLessThanOrEqual(4);

  // Прокрутка не сброшена в начало.
  const scrollAfter = await page.evaluate(() => window.scrollY);
  expect(scrollAfter, `${label}: прокрутка не должна сбрасываться в начало списка`).toBeGreaterThan(0);

  // Правка действительно сохранилась — вернулись к обновлённой строке.
  await expect(row).toContainText('777');

  return { menuUrl, categoryId, itemId };
}

test('YAAM HQ (desktop): категория → прокрутка → блюдо → Назад возвращает к той же строке', async ({ page }) => {
  await login(page);
  const { menuUrl, categoryId, itemId } = await runReturnScenario(page, 'desktop');

  // Кнопка «назад» самого браузера ведёт себя так же: экран меню не
  // схлопывается в список закрытых категорий.
  await page.locator(`#dish-${itemId} .dish-link`).click();
  await expect(page).toHaveURL(`${menuUrl}/items/${itemId}`);
  await page.goBack();
  await expect(page.locator(`details.cat-block[data-category-id="${categoryId}"]`)).toHaveAttribute('open', '');
  await expect(page.locator(`#dish-${itemId}`)).toBeVisible();
});

test('YAAM HQ (mobile 390x844): тот же возврат к строке блюда на узком экране', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await runReturnScenario(page, 'mobile');
});

test('YAAM HQ: без JavaScript возврат всё равно раскрывает категорию блюда', async ({ browser }) => {
  // Раскрытие категории обеспечивает СЕРВЕР (?item=N -> <details open>), а не
  // скрипт: с выключенным JS точная прокрутка недоступна, но экран обязан
  // открыться на нужной категории, а не на списке свёрнутых.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${API_BASE_URL}/hq/login`);
    await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
    await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
    await page.getByRole('button', { name: 'Войти' }).click();

    const seeded = await seedMenu(`E2E NoJS ${crypto.randomBytes(3).toString('hex')}`);
    const menuUrl = `${API_BASE_URL}/hq/restaurants/${seeded.restaurantId}/menu`;
    const categoryId = seeded.categories[2];
    const itemId = seeded.items[categoryId][3];

    await page.goto(`${menuUrl}?item=${itemId}#dish-${itemId}`);
    await expect(page.locator(`details.cat-block[data-category-id="${categoryId}"]`)).toHaveAttribute('open', '');
    await expect(page.locator(`#dish-${itemId}`)).toBeVisible();
  } finally {
    await context.close();
  }
});
