import path from 'node:path';
import { test, expect, webkit, devices, type Page, type Browser } from '@playwright/test';
import { pointFrontendAtLocalBackend as installTestApiHook } from '../fixtures/test-api-hook';
import { recordFramesFromStart, capturedFrames } from '../fixtures/frame-recorder';

// Обновление страницы на открытой карточке блюда выбрасывало посетителя на
// главную: экран жил только в памяти вкладки, адрес оставался голым "/".
//
// Сценарий проверяется в НАСТОЯЩЕМ браузере, потому что проверять тут нечего,
// кроме реального поведения браузера: перезагрузка, кнопка «назад» после неё,
// прямое открытие адреса в новой вкладке. Отдельно — WebKit (движок Safari)
// на профиле iPhone: у iOS Safari своя работа с bfcache и восстановлением
// прокрутки, и именно там подобные регрессии обычно и живут.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const CLIENT_BASE_URL = process.env.YAAM_E2E_CLIENT_BASE_URL;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !CLIENT_BASE_URL || !DATABASE_URL) {
  throw new Error('YAAM_E2E_* не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));

async function seeded() {
  const rest = await db.query(`SELECT id, name FROM restaurants WHERE connect_code = 'stage11b-test-seed-v1'`);
  if (!rest[0]) throw new Error('Stage 11B seed-ресторан не найден — global-setup.ts не отработал?');
  const items = await db.query(
    `SELECT mi.id, mi.name FROM menu_items mi
      JOIN categories c ON c.id = mi.category_id
     WHERE mi.restaurant_id = $1 AND mi.archived_at IS NULL AND c.archived_at IS NULL
     ORDER BY mi.sort_order, mi.id`,
    [rest[0].id],
  );
  if (!items.length) throw new Error('у seed-ресторана нет блюд');
  return { restaurantId: rest[0].id as number, restaurantName: rest[0].name as string, dish: items[0] };
}

// Открыть блюдо так, как это делает посетитель: главная -> ресторан -> блюдо.
async function openDishByTapping(page: Page, restaurantName: string, dishName: string) {
  await page.goto(CLIENT_BASE_URL!);
  // Именно карточка в списке, а не любой текст с этим названием: то же
  // название теперь ездит в бегущей строке, и клик по ней и не сработал бы,
  // и не дождался бы «стабильности» — лента анимируется непрерывно.
  await page.locator('#list .card', { hasText: restaurantName }).first().click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  await page.getByText(dishName, { exact: false }).first().click();
  await expect(page.locator('#dish')).toHaveClass(/active/);
}

function dishRouteRe(restaurantId: number, dishId: number) {
  return new RegExp(`#/r/${restaurantId}/d/${dishId}$`);
}

test('desktop: refresh на карточке блюда оставляет на этом же блюде, «назад» после refresh не ломается', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  const { restaurantId, restaurantName, dish } = await seeded();

  await openDishByTapping(page, restaurantName, dish.name);
  await expect(page).toHaveURL(dishRouteRe(restaurantId, dish.id));
  const nameBefore = await page.locator('#d-name').textContent();

  // 1. Обычный refresh — то самое действие, которое выбрасывало на главную.
  await page.reload();
  await expect(page.locator('#dish')).toHaveClass(/active/);
  await expect(page.locator('#home')).not.toHaveClass(/active/);
  await expect(page.locator('#d-name')).toHaveText(nameBefore!.trim());
  await expect(page).toHaveURL(dishRouteRe(restaurantId, dish.id));
  // Ресторан восстановлен вместе с блюдом, а не «просто карточка»: экран меню
  // под карточкой заполнен тем же рестораном (внутренние let-переменные app.js
  // наружу не видны, и проверять надо всё равно наблюдаемое состояние).
  await expect(page.locator('#m-name')).toHaveText(restaurantName);

  // 2. «Назад» после refresh: блюдо -> меню -> главная, без застревания.
  await page.goBack();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  await expect(page).toHaveURL(new RegExp(`#/r/${restaurantId}$`));
  await page.goBack();
  await expect(page.locator('#home')).toHaveClass(/active/);
  await expect(page).not.toHaveURL(/#\/r\//);

  // 3. «Вперёд» возвращает туда же — история не порвана.
  await page.goForward();
  await expect(page.locator('#menu')).toHaveClass(/active/);
});

test('desktop: прямое открытие адреса блюда (новая вкладка, ссылка) работает без предыстории', async ({ browser }) => {
  const { restaurantId, restaurantName, dish } = await seeded();
  const context = await browser.newContext();
  // Каждый адрес открывается ОТДЕЛЬНОЙ вкладкой: это и есть проверяемый
  // сценарий («открыть ссылку»), и только так документ загружается заново —
  // goto на тот же документ с другим хэшем перезагрузки не делает.
  const openFresh = async (url: string) => {
    const page = await context.newPage();
    await installTestApiHook(page, API_BASE_URL!);
    await page.goto(url);
    return page;
  };
  try {
    const dishPage = await openFresh(`${CLIENT_BASE_URL}#/r/${restaurantId}/d/${dish.id}`);
    await expect(dishPage.locator('#dish')).toHaveClass(/active/);
    await expect(dishPage.locator('#d-name')).toHaveText(dish.name);
    await expect(dishPage.locator('#m-name')).toHaveText(restaurantName);

    // Адрес несуществующего блюда не выбрасывает на главную и не ломается:
    // остаётся меню ресторана.
    const gonePage = await openFresh(`${CLIENT_BASE_URL}#/r/${restaurantId}/d/99999999`);
    await expect(gonePage.locator('#menu')).toHaveClass(/active/);
    await expect(gonePage.locator('#dish')).not.toHaveClass(/active/);

    // Мусор в адресе — обычная главная, без ошибок.
    const junkPage = await openFresh(`${CLIENT_BASE_URL}#/r/not-a-number`);
    await expect(junkPage.locator('#home')).toHaveClass(/active/);
    await expect(junkPage.locator('#menu')).not.toHaveClass(/active/);
  } finally {
    await context.close();
  }
});

test('desktop: refresh не сбрасывает выбранный город', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  const { restaurantId, restaurantName, dish } = await seeded();

  await page.goto(CLIENT_BASE_URL!);
  await page.locator('#cities .citychip', { hasText: 'Гудермес' }).click();
  await expect(page.locator('#cities .citychip.sel')).toHaveText('Гудермес');

  // Возвращаемся в город с seed-рестораном, открываем блюдо и обновляем.
  await page.locator('#cities .citychip', { hasText: 'Грозный' }).click();
  await openDishByTapping(page, restaurantName, dish.name);
  await page.reload();
  await expect(page.locator('#dish')).toHaveClass(/active/);
  await expect(page.locator('#cities .citychip.sel')).toHaveText('Грозный');
  expect(await page.evaluate(() => localStorage.getItem('yaam_selected_city'))).toBe('Грозный');

  // И город, выбранный без всякой корзины, тоже переживает перезагрузку.
  await page.goto(CLIENT_BASE_URL!);
  await page.locator('#cities .citychip', { hasText: 'Аргун' }).click();
  await page.reload();
  await expect(page.locator('#cities .citychip.sel')).toHaveText('Аргун');
  expect(await page.evaluate(() => localStorage.getItem('yaam_selected_city'))).toBe('Аргун');
});

test('Safari/iPhone (WebKit): refresh и «назад» на карточке блюда ведут себя так же', async () => {
  const { restaurantId, restaurantName, dish } = await seeded();
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await installTestApiHook(page, API_BASE_URL!);

    await openDishByTapping(page, restaurantName, dish.name);
    await expect(page).toHaveURL(dishRouteRe(restaurantId, dish.id));

    await page.reload();
    await expect(page.locator('#dish')).toHaveClass(/active/);
    await expect(page.locator('#d-name')).toHaveText(dish.name);
    await expect(page).toHaveURL(dishRouteRe(restaurantId, dish.id));

    // На iOS «назад» — основной способ навигации; после refresh он обязан
    // вести в меню ресторана, а не в пустоту и не на главную сразу.
    await page.goBack();
    await expect(page.locator('#menu')).toHaveClass(/active/);
    await expect(page).toHaveURL(new RegExp(`#/r/${restaurantId}$`));

    // Прямое открытие адреса в новой вкладке Safari.
    const fresh = await context.newPage();
    await installTestApiHook(fresh, API_BASE_URL!);
    await fresh.goto(`${CLIENT_BASE_URL}#/r/${restaurantId}/d/${dish.id}`);
    await expect(fresh.locator('#dish')).toHaveClass(/active/);
    await expect(fresh.locator('#d-name')).toHaveText(dish.name);
  } finally {
    if (browser) await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Вспышка главной при восстановлении маршрута
// ---------------------------------------------------------------------------

test('desktop: при reload карточки блюда главная не показывается ни одним кадром', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  const { restaurantId, restaurantName, dish } = await seeded();

  await openDishByTapping(page, restaurantName, dish.name);
  await expect(page).toHaveURL(dishRouteRe(restaurantId, dish.id));

  // Запись кадров включается ДО документа, поэтому перезагрузка снимается с
  // самого первого кадра, а не с момента, когда тест успел подключиться.
  await recordFramesFromStart(page);
  await page.reload();
  await expect(page.locator('#dish')).toHaveClass(/active/);
  await expect(page.locator('html')).not.toHaveClass(/route-boot/);

  const captured = await capturedFrames(page);
  expect(captured.length, 'кадры должны сниматься').toBeGreaterThan(1);
  const homeFrames = captured.filter((f) => f.home);
  expect(homeFrames, `главная не должна быть видна ни одним кадром, а была ${homeFrames.length}`).toEqual([]);

  // Первый кадр — либо ещё под заставкой, либо уже с готовым блюдом (на
  // быстром восстановлении маршрут успевает встать до первого кадра, и это
  // лучший из возможных исходов). Главной там нет ни в одном случае.
  expect(captured[0].guard || captured[0].dish,
    'первый кадр обязан быть либо под заставкой, либо уже с блюдом').toBe(true);
  expect(captured[captured.length - 1].dish, 'в конце на экране блюдо').toBe(true);
  expect(captured[captured.length - 1].guard, 'заставка снята').toBe(false);
});

test('desktop: пока блюдо ещё грузится, виден тёмный экран заставки, а не главная', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  const { restaurantId, restaurantName, dish } = await seeded();
  await openDishByTapping(page, restaurantName, dish.name);

  // Медленный ответ — единственный способ проверить механику детерминированно:
  // иначе на локальном backend'е маршрут встаёт раньше первого кадра и «под
  // заставкой» просто нечего наблюдать.
  await page.route('**/api/restaurants/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });

  await recordFramesFromStart(page);
  await page.reload({ waitUntil: 'commit' });

  // Пока данные не пришли: экран тёмный, заставка на месте, главной нет.
  await expect(page.locator('#route-boot')).toBeVisible();
  await expect(page.locator('#home')).toBeHidden();
  await expect(page.locator('html')).toHaveClass(/route-boot/);
  // Фон заставки совпадает с фоном документа — первый кадр не меняет цвет.
  expect(await page.locator('#route-boot').evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe('rgb(10, 36, 23)');

  await expect(page.locator('#dish')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('html')).not.toHaveClass(/route-boot/);
  await expect(page.locator('#route-boot')).toBeHidden();

  const captured = await capturedFrames(page);
  expect(captured.filter((f) => f.home), 'главная не показывается даже пока данные грузятся').toEqual([]);
  expect(captured.some((f) => f.guard), 'заставка должна была реально поработать').toBe(true);
});

test('desktop: прямое открытие адреса блюда тоже не показывает главную', async ({ browser }) => {
  const { restaurantId, dish } = await seeded();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await installTestApiHook(page, API_BASE_URL!);
    await recordFramesFromStart(page);
    await page.goto(`${CLIENT_BASE_URL}#/r/${restaurantId}/d/${dish.id}`);
    await expect(page.locator('#dish')).toHaveClass(/active/);

    const captured = await capturedFrames(page);
    expect(captured.filter((f) => f.home)).toEqual([]);
    // Промежуточный экран меню тоже не должен мелькать: восстановление идёт
    // ресторан -> блюдо, и оба шага проходят под заставкой.
    expect(captured.filter((f) => f.menu)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('desktop: обычный заход на главную заставку не включает и рисует главную сразу', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  await recordFramesFromStart(page);
  await page.goto(CLIENT_BASE_URL!);
  await expect(page.locator('#home')).toHaveClass(/active/);
  const captured = await capturedFrames(page);
  expect(captured.some((f) => f.guard), 'на главной заставки быть не должно').toBe(false);
  expect(captured.some((f) => f.home), 'главная показывается сразу').toBe(true);
});

test('desktop: адрес несуществующего блюда не оставляет тёмный экран', async ({ browser }) => {
  const { restaurantId } = await seeded();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await installTestApiHook(page, API_BASE_URL!);
    await page.goto(`${CLIENT_BASE_URL}#/r/${restaurantId}/d/99999999`);
    await expect(page.locator('#menu')).toHaveClass(/active/);
    await expect(page.locator('html')).not.toHaveClass(/route-boot/);
    await expect(page.locator('#route-boot')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('Safari/iPhone (WebKit): reload карточки блюда не показывает главную, включая жёсткую перезагрузку без service worker', async () => {
  const { restaurantId, restaurantName, dish } = await seeded();
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    // serviceWorkers:'block' — приближение hard refresh: ни один ответ не
    // приходит из кэша воркера, весь документ и скрипты берутся из сети.
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await context.newPage();
    await installTestApiHook(page, API_BASE_URL!);

    await openDishByTapping(page, restaurantName, dish.name);
    await recordFramesFromStart(page);
    await page.reload();
    await expect(page.locator('#dish')).toHaveClass(/active/);
    await expect(page.locator('#d-name')).toHaveText(dish.name);

    const captured = await capturedFrames(page);
    expect(captured.filter((f) => f.home), 'на iPhone главная тоже не должна мелькать').toEqual([]);
    expect(captured[0].guard || captured[0].dish,
      'первый кадр — либо заставка, либо уже блюдо').toBe(true);
    await expect(page.locator('html')).not.toHaveClass(/route-boot/);

    // Прямое открытие в новой вкладке Safari — та же картина.
    const fresh = await context.newPage();
    await installTestApiHook(fresh, API_BASE_URL!);
    await recordFramesFromStart(fresh);
    await fresh.goto(`${CLIENT_BASE_URL}#/r/${restaurantId}/d/${dish.id}`);
    await expect(fresh.locator('#dish')).toHaveClass(/active/);
    expect((await capturedFrames(fresh)).filter((f) => f.home)).toEqual([]);
  } finally {
    if (browser) await browser.close();
  }
});
