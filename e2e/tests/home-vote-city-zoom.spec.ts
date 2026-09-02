import path from 'node:path';
import { test, expect, webkit, devices, type Page, type Browser } from '@playwright/test';
import { pointFrontendAtLocalBackend as installTestApiHook } from '../fixtures/test-api-hook';

// Три изменения одного захода, каждое проверяется в настоящем браузере:
//   A — «Кого ждём»: кнопка под списком ресторанов, штора поднимается снизу.
//   B — стартовый город выбирается по числу опубликованных ресторанов.
//   C — системный pinch-to-zoom страницы на карточке блюда.
//
// C проверяется НАСТОЯЩИМ щипком: Chromium умеет synthesizePinchGesture через
// CDP, то есть браузер реально масштабирует страницу, а не мы имитируем
// состояние. В WebKit такого канала нет, поэтому там проверяется то, что
// физически и ломало zoom, — что обработчики галереи не забирают
// двухпальцевый жест себе и не отменяют событие.

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

// Свайп галереи существует только у блюда с НЕСКОЛЬКИМИ фотографиями
// (bindGalleryDrag вешается лишь тогда). У seed-блюда их нет, поэтому
// добавляем строки напрямую: сами файлы для проверки жеста не нужны — важны
// количество кадров и обработчики над ними.
async function seedDishGallery(menuItemId: number, count: number) {
  await db.execute('DELETE FROM menu_item_photos WHERE menu_item_id = $1', [menuItemId]);
  for (let i = 0; i < count; i += 1) {
    await db.execute(
      `INSERT INTO menu_item_photos (menu_item_id, storage_key, width, height, alt_text, sort_order, is_primary)
       VALUES ($1, $2, 1200, 1200, '', $3, $4)`,
      [menuItemId, `menu-items/${menuItemId}/e2e-zoom-${i}-${Date.now()}`, i + 1, i === 0 ? 1 : 0],
    );
  }
}

async function seeded() {
  const rest = await db.query(`SELECT id, name, cities FROM restaurants WHERE connect_code = 'stage11b-test-seed-v1'`);
  if (!rest[0]) throw new Error('Stage 11B seed-ресторан не найден');
  const items = await db.query(
    `SELECT mi.id, mi.name FROM menu_items mi
      JOIN categories c ON c.id = mi.category_id
     WHERE mi.restaurant_id = $1 AND mi.archived_at IS NULL AND c.archived_at IS NULL
     ORDER BY mi.sort_order, mi.id`,
    [rest[0].id],
  );
  return { restaurantId: rest[0].id as number, restaurantName: rest[0].name as string, dish: items[0] };
}

// ---------------------------------------------------------------------------
// A. «Кого ждём»
// ---------------------------------------------------------------------------

test('A: кнопка «кого ждём» стоит под списком ресторанов, перед footer', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  await page.goto(CLIENT_BASE_URL!);
  await expect(page.locator('#home')).toHaveClass(/active/);
  await page.locator('#list .card').first().waitFor();

  const listBox = (await page.locator('#list').boundingBox())!;
  const chipBox = (await page.locator('#vote-chip').boundingBox())!;
  const footerBox = (await page.locator('footer.site-footer').boundingBox())!;
  expect(chipBox.y, 'кнопка ниже списка ресторанов').toBeGreaterThan(listBox.y + listBox.height - 1);
  expect(chipBox.y, 'кнопка выше footer').toBeLessThan(footerBox.y);
});

test('A: штора голосования выезжает снизу вверх и уходит вниз, без скачков', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  await page.goto(CLIENT_BASE_URL!);
  const sheet = page.locator('#vote-sheet');
  const viewport = page.viewportSize()!;

  // Закрытая штора стоит НИЖЕ экрана — значит появится она снизу.
  const closedBox = (await sheet.boundingBox())!;
  expect(closedBox.y, 'в покое штора спрятана под нижним краем').toBeGreaterThanOrEqual(viewport.height - 1);

  // Смещение измеряется по самому transform: bounding box у выехавшего за
  // экран элемента упирается в границу окна и промежуточных значений не
  // показывает.
  const translateY = () => sheet.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return Math.round(m.m42);
  });
  const closedShift = await translateY();
  expect(closedShift, 'закрытая штора смещена вниз').toBeGreaterThan(0);

  // Снимаем смещение каждый кадр, начиная с самого клика: движение обязано
  // быть постепенным, а не одним скачком из закрытого в открытое.
  const track = sheet.evaluate((el) => new Promise<number[]>((resolve) => {
    const seen: number[] = [];
    const started = performance.now();
    const tick = () => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      seen.push(Math.round(m.m42));
      if (performance.now() - started < 700) requestAnimationFrame(tick);
      else resolve(seen);
    };
    requestAnimationFrame(tick);
  }));
  await page.locator('#vote-chip').click();
  await expect(page.locator('#vote-overlay')).toHaveClass(/on/);
  await expect(sheet).toHaveClass(/on/);
  const shifts = await track;

  expect(shifts.length, 'кадры должны сниматься').toBeGreaterThan(4);
  expect(shifts[shifts.length - 1], 'в конце штора на месте').toBe(0);
  const intermediate = shifts.filter((v) => v > 0 && v < closedShift);
  expect(intermediate.length, 'штора должна ехать снизу вверх через промежуточные положения, а не появляться скачком')
    .toBeGreaterThan(2);
  // Движение строго в одну сторону — никаких рывков назад.
  for (let i = 1; i < shifts.length; i += 1) {
    expect(shifts[i], 'смещение только уменьшается — обратных дёрганий нет').toBeLessThanOrEqual(shifts[i - 1]);
  }

  const openBox = (await sheet.boundingBox())!;
  expect(Math.round(openBox.y + openBox.height), 'открытая штора прижата к нижнему краю')
    .toBeGreaterThanOrEqual(viewport.height - 2);
  expect(openBox.y, 'штора не занимает весь экран — это нижняя шторка').toBeGreaterThan(0);

  // Единственное, что анимируется, — transform: раскладка не пересчитывается.
  expect(await sheet.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('transform');

  // Кликать надо по видимой части затемнения — центр оверлея закрыт самой
  // шторой, занимающей нижние 70% экрана.
  await page.locator('#vote-overlay').click({ position: { x: 20, y: 20 } });
  await expect(sheet).not.toHaveClass(/on/);
  await expect.poll(async () => Math.round((await sheet.boundingBox())!.y))
    .toBeGreaterThanOrEqual(viewport.height - 1);
});

test('A (mobile Safari): та же штора снизу на iPhone', async () => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await installTestApiHook(page, API_BASE_URL!);
    await page.goto(CLIENT_BASE_URL!);
    const sheet = page.locator('#vote-sheet');
    const viewport = page.viewportSize()!;

    await page.locator('#vote-chip').tap();
    await expect(sheet).toHaveClass(/on/);
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height))
      .toBeLessThanOrEqual(viewport.height + 1);
    const openBox = (await sheet.boundingBox())!;
    expect(Math.round(openBox.y + openBox.height)).toBeGreaterThanOrEqual(viewport.height - 2);
    // Хват — сверху шторы, значит закрывающий свайп идёт вниз.
    const handleBox = (await page.locator('.vs-draghandle').boundingBox())!;
    expect(handleBox.y).toBeLessThan(openBox.y + openBox.height / 2);
  } finally {
    if (browser) await browser.close();
  }
});

// ---------------------------------------------------------------------------
// B. Стартовый город
// ---------------------------------------------------------------------------

test('B: при первом открытии выбирается город с наибольшим числом ресторанов, а сохранённый выбор не трогается', async ({ browser }) => {
  const { restaurantName } = await seeded();
  const seedCities: string[] = JSON.parse(
    (await db.query(`SELECT cities FROM restaurants WHERE connect_code = 'stage11b-test-seed-v1'`))[0].cities,
  );

  // Считаем ожидаемый город тем же правилом, что и приложение, но по данным
  // боевой выборки — сам список ресторанов тест не подменяет.
  const published = await db.query(
    `SELECT cities FROM restaurants WHERE archived_at IS NULL AND published_at IS NOT NULL`,
  );
  const chipOrder = ['Грозный', 'Аргун', 'Гудермес', 'Шали'];
  const counts = new Map(chipOrder.map((c) => [c, 0]));
  for (const row of published) {
    for (const city of JSON.parse(row.cities || '[]')) {
      if (counts.has(city)) counts.set(city, counts.get(city)! + 1);
    }
  }
  let expectedCity = chipOrder[0];
  let best = -1;
  for (const city of chipOrder) {
    if (counts.get(city)! > best) { best = counts.get(city)!; expectedCity = city; }
  }

  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  try {
    await installTestApiHook(page, API_BASE_URL!);
    await page.goto(CLIENT_BASE_URL!);
    await expect(page.locator('#cities .citychip.sel')).toHaveText(expectedCity);
    // Ресторан из seed действительно виден в выбранном городе.
    if (seedCities.includes(expectedCity)) {
      await expect(page.locator('#list')).toContainText(restaurantName);
    }
    // Автовыбор не притворяется решением человека.
    expect(await page.evaluate(() => localStorage.getItem('yaam_selected_city'))).toBeNull();
  } finally {
    await fresh.close();
  }

  // Осознанный выбор переживает перезагрузку и не переопределяется автоматикой.
  const chosen = chipOrder.find((c) => c !== expectedCity)!;
  const second = await browser.newContext();
  const page2 = await second.newPage();
  try {
    await installTestApiHook(page2, API_BASE_URL!);
    await page2.goto(CLIENT_BASE_URL!);
    await page2.locator('#cities .citychip', { hasText: chosen }).click();
    await expect(page2.locator('#cities .citychip.sel')).toHaveText(chosen);
    await page2.reload();
    await expect(page2.locator('#cities .citychip.sel')).toHaveText(chosen);
    expect(await page2.evaluate(() => localStorage.getItem('yaam_selected_city'))).toBe(chosen);
  } finally {
    await second.close();
  }
});

// ---------------------------------------------------------------------------
// C. Системный pinch-to-zoom страницы
// ---------------------------------------------------------------------------

async function openDish(page: Page, restaurantName: string, dishName: string) {
  await page.goto(CLIENT_BASE_URL!);
  // Именно карточка в списке, а не любой текст с этим названием: то же
  // название теперь ездит в бегущей строке, и клик по ней и не сработал бы,
  // и не дождался бы «стабильности» — лента анимируется непрерывно.
  await page.locator('#list .card', { hasText: restaurantName }).first().click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  await page.getByText(dishName, { exact: false }).first().click();
  await expect(page.locator('#dish')).toHaveClass(/active/);
}

test('C: настоящий двухпальцевый щипок увеличивает всю страницу, по ней можно двигаться, и после возврата к 1x свайп фотографий снова работает', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  const { restaurantName, dish } = await seeded();
  await seedDishGallery(dish.id, 3);
  await openDish(page, restaurantName, dish.name);

  const hero = page.locator('#d-hero');
  await expect(page.locator('#d-gcount')).toHaveText('1 / 3');
  const box = (await hero.boundingBox())!;
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);

  // Браузер обязан сам разрешать масштабирование над фото.
  expect(await hero.evaluate((el) => getComputedStyle(el).touchAction)).toContain('pinch-zoom');
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBeCloseTo(1, 1);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', { x: cx, y: cy, scaleFactor: 2.5 });

  await expect.poll(() => page.evaluate(() => window.visualViewport!.scale), { timeout: 10000 })
    .toBeGreaterThan(1.2);

  // В увеличенном виде по странице можно двигаться: сдвиг визуального
  // окна — это и есть «свободно передвигаться и разглядывать фото».
  const before = await page.evaluate(() => ({ x: window.visualViewport!.offsetLeft, y: window.visualViewport!.offsetTop }));
  // Точка жеста берётся в координатах ВИДИМОГО окна: после увеличения прежний
  // css-центр фото может оказаться за его пределами.
  // Точка берётся заведомо внутри уменьшившегося визуального окна: после
  // увеличения его размеры делятся на масштаб, и прежний css-центр фото
  // оказывается за границей, которую проверяет протокол.
  await cdp.send('Input.synthesizeScrollGesture', { x: 40, y: 90, xDistance: -70, yDistance: -50 });
  await expect.poll(async () => {
    const now = await page.evaluate(() => ({ x: window.visualViewport!.offsetLeft, y: window.visualViewport!.offsetTop }));
    return Math.abs(now.x - before.x) + Math.abs(now.y - before.y);
  }, { timeout: 10000 }).toBeGreaterThan(0);

  // Возвращаемся к 1x.
  await cdp.send('Input.synthesizePinchGesture', { x: 40, y: 90, scaleFactor: 0.2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport!.scale), { timeout: 10000 })
    .toBeLessThan(1.2);

  // И обычный свайп фотографий снова работает.
  const countBefore = await page.locator('#d-gcount').textContent();
  const fresh = (await hero.boundingBox())!;
  await page.mouse.move(fresh.x + fresh.width * 0.8, fresh.y + fresh.height / 2);
  await page.mouse.down();
  await page.mouse.move(fresh.x + fresh.width * 0.2, fresh.y + fresh.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => page.locator('#d-gcount').textContent(), { timeout: 5000 })
    .not.toBe(countBefore);
});

test('C (mobile Safari): обработчики галереи не забирают двухпальцевый жест и не отменяют его', async () => {
  const { restaurantName, dish } = await seeded();
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await installTestApiHook(page, API_BASE_URL!);
    await seedDishGallery(dish.id, 3);
    await openDish(page, restaurantName, dish.name);

    const hero = page.locator('#d-hero');
    await expect(page.locator('#d-gcount')).toHaveText('1 / 3');
    expect(await hero.evaluate((el) => getComputedStyle(el).touchAction)).toContain('pinch-zoom');

    // Конструктор Touch в WebKit недоступен, поэтому события собираются
    // вручную: обработчику галереи важно только touches.length и координаты —
    // ровно это он и читает. Пара «один палец / два пальца» проверяется
    // подряд, иначе «не отменили» ничего не доказывало бы: обработчик мог бы
    // просто спать.
    const result = await hero.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const touchEvent = (type: string, points: { clientX: number; clientY: number }[]) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: points });
        Object.defineProperty(ev, 'changedTouches', { value: points });
        return ev;
      };
      const down = new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, isPrimary: true, pointerId: 1,
        pointerType: 'touch', clientX: cx, clientY: cy,
      });

      // 1. Один палец: жест принадлежит галерее, событие обязано отменяться.
      el.dispatchEvent(down);
      const single = touchEvent('touchmove', [{ clientX: cx - 90, clientY: cy }]);
      el.dispatchEvent(single);

      // 2. Два пальца: жест обязан целиком уйти браузеру.
      el.dispatchEvent(down);
      el.dispatchEvent(touchEvent('touchstart', [
        { clientX: cx - 20, clientY: cy }, { clientX: cx + 20, clientY: cy },
      ]));
      const pinch = touchEvent('touchmove', [
        { clientX: cx - 90, clientY: cy }, { clientX: cx + 90, clientY: cy },
      ]);
      el.dispatchEvent(pinch);
      return { singlePrevented: single.defaultPrevented, pinchPrevented: pinch.defaultPrevented };
    });
    expect(result.singlePrevented, 'одним пальцем листание галереи по-прежнему перехватывает жест').toBe(true);
    expect(result.pinchPrevented, 'двухпальцевый жест обязан оставаться за браузером').toBe(false);

    // И обычное листание пальцем на этой же странице продолжает работать.
    await page.reload();
    await expect(page.locator('#dish')).toHaveClass(/active/);
    const countBefore = await page.locator('#d-gcount').textContent();
    const box = (await page.locator('#d-hero').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => page.locator('#d-gcount').textContent(), { timeout: 5000 })
      .not.toBe(countBefore);
  } finally {
    if (browser) await browser.close();
  }
});
