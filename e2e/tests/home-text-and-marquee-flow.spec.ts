import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, webkit, devices, type Page, type Browser } from '@playwright/test';
import { pointFrontendAtLocalBackend as installTestApiHook } from '../fixtures/test-api-hook';

// Текст на главной правится в HQ и сразу виден на сайте; бегущая строка
// собирается из реальных опубликованных ресторанов. Проверяется полный путь в
// настоящем браузере: сохранение в HQ -> reload HQ -> reload yaam.su, плюс
// поведение ленты при одном и нескольких ресторанах.

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

async function loginHq(page: Page) {
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
}

// Названия из ленты, в порядке появления.
async function marqueeNames(page: Page): Promise<string[]> {
  return page.$$eval('#ptrack .pname', (els) => els.map((e) => (e.textContent || '').trim()));
}

async function publishedNames(): Promise<string[]> {
  const rows = await db.query(
    `SELECT name FROM restaurants WHERE archived_at IS NULL AND published_at IS NOT NULL ORDER BY id`,
  );
  return rows.map((r: { name: string }) => r.name);
}

test('HQ: блок «Текст на главной» под Центром событий — сохранение, спокойное подтверждение, reload', async ({ page }) => {
  await loginHq(page);

  const block = page.locator('.panel.home-text');
  await expect(block).toBeVisible();
  // Стоит НИЖЕ Центра событий.
  const eventBox = (await page.locator('#hq-event-center').boundingBox())!;
  const blockBox = (await block.boundingBox())!;
  expect(blockBox.y).toBeGreaterThan(eventBox.y + eventBox.height - 1);

  const neon = page.locator('#hc-neon');
  const subtext = page.locator('#hc-subtext');
  await expect(neon).toBeVisible();
  await expect(subtext).toBeVisible();
  await expect(block.getByRole('button', { name: 'Сохранить' })).toHaveCount(1);

  // Поля растут по содержимому, а не прокручиваются внутри себя.
  const short = (await neon.boundingBox())!.height;
  await subtext.fill('строка\nстрока\nстрока\nстрока\nстрока');
  const grown = (await subtext.boundingBox())!.height;
  await subtext.fill('одна строка');
  const shrunk = (await subtext.boundingBox())!.height;
  expect(grown, 'многострочный текст увеличивает поле').toBeGreaterThan(shrunk);
  expect(short).toBeGreaterThan(0);
  expect(await subtext.evaluate((el) => el.scrollHeight - (el as HTMLElement).clientHeight))
    .toBeLessThanOrEqual(1);

  const marker = crypto.randomBytes(3).toString('hex');
  await neon.fill(`Неон ${marker}`);
  await subtext.fill(`Подтекст ${marker}, довольно длинный, чтобы блок на сайте вырос по высоте.`);
  await block.getByRole('button', { name: 'Сохранить' }).click();

  // Спокойное подтверждение: короткая строка рядом с заголовком, без диалогов.
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/?saved=1`);
  await expect(page.locator('.home-text-saved')).toHaveText('Сохранено');

  // Reload HQ — сохранённое на месте, подтверждение больше не мозолит глаза.
  await page.goto(`${API_BASE_URL}/hq/`);
  await expect(page.locator('#hc-neon')).toHaveValue(`Неон ${marker}`);
  await expect(page.locator('.home-text-saved')).toHaveCount(0);
});

test('Публичная главная: текст приходит из HQ и переживает reload; блок растёт по содержимому', async ({ page, browser }) => {
  // Правим текст в HQ.
  const hq = await (await browser.newContext()).newPage();
  const marker = crypto.randomBytes(3).toString('hex');
  const longSubtext = `Подтекст ${marker}. ` + 'Достаточно длинная строка, чтобы блок на главной вырос по высоте и ничего при этом не обрезал. '.repeat(2);
  try {
    await loginHq(hq);
    await hq.locator('#hc-neon').fill(`Неон ${marker}`);
    await hq.locator('#hc-subtext').fill(longSubtext);
    await hq.locator('.panel.home-text').getByRole('button', { name: 'Сохранить' }).click();
    await expect(hq).toHaveURL(`${API_BASE_URL}/hq/?saved=1`);
  } finally {
    await hq.context().close();
  }

  await installTestApiHook(page, API_BASE_URL!);
  await page.goto(CLIENT_BASE_URL!);
  const title = page.locator('#intro-title');
  const text = page.locator('#intro-text');
  await expect(title).toHaveText(`Неон ${marker}`);
  await expect(text).toHaveText(longSubtext.trim());

  // Блок вырос под длинный текст и ничего не обрезал.
  const intro = page.locator('#intro');
  const tall = (await intro.boundingBox())!.height;
  const overflow = await intro.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, 'ничего не должно быть обрезано').toBeLessThanOrEqual(1);
  // Текст помещается внутри padding, не выпирая за кромку.
  const introBox = (await intro.boundingBox())!;
  const textBox = (await text.boundingBox())!;
  expect(textBox.x).toBeGreaterThanOrEqual(introBox.x);
  expect(textBox.x + textBox.width).toBeLessThanOrEqual(introBox.x + introBox.width + 1);
  expect(textBox.y + textBox.height).toBeLessThanOrEqual(introBox.y + introBox.height);

  // Короткий текст делает блок компактнее.
  const hq2 = await (await browser.newContext()).newPage();
  try {
    await loginHq(hq2);
    await hq2.locator('#hc-neon').fill('Коротко');
    await hq2.locator('#hc-subtext').fill('И всё.');
    await hq2.locator('.panel.home-text').getByRole('button', { name: 'Сохранить' }).click();
    await expect(hq2).toHaveURL(`${API_BASE_URL}/hq/?saved=1`);
  } finally {
    await hq2.context().close();
  }
  await page.reload();
  await expect(title).toHaveText('Коротко');
  const shortHeight = (await intro.boundingBox())!.height;
  expect(shortHeight, 'короткий текст делает блок ниже').toBeLessThan(tall);
  expect(shortHeight, 'padding остаётся — блок не схлопывается в линию').toBeGreaterThan(40);
});

test('Бегущая строка: реальные рестораны, один и несколько, бесшовный цикл', async ({ page }) => {
  await installTestApiHook(page, API_BASE_URL!);
  await page.goto(CLIENT_BASE_URL!);
  await expect(page.locator('#partners')).toBeVisible();

  const seeded = await publishedNames();
  expect(seeded.length, 'в эфемерной базе есть seed-ресторан').toBeGreaterThan(0);

  // Один ресторан — он и повторяется по всей ленте.
  let names = await marqueeNames(page);
  expect([...new Set(names)].sort()).toEqual([...new Set(seeded)].sort());
  expect(names.length, 'лента длиннее экрана').toBeGreaterThan(seeded.length);
  // Две одинаковые половины — на них держится бесшовный translateX(-50%).
  expect(names.length % 2).toBe(0);
  expect(names.slice(0, names.length / 2)).toEqual(names.slice(names.length / 2));
  const halfWidth = await page.locator('#ptrack').evaluate((el) => el.scrollWidth / 2);
  const screenWidth = await page.locator('#partners').evaluate((el) => el.clientWidth);
  expect(halfWidth, 'половина трека перекрывает экран — просвета не будет').toBeGreaterThanOrEqual(screenWidth);

  // Разделитель с воздухом: точка есть и она отбита с обеих сторон.
  const sep = await page.locator('#ptrack .pname').first().evaluate((el) => {
    const style = getComputedStyle(el, '::after');
    return { content: style.content, left: style.marginLeft, right: style.marginRight };
  });
  expect(sep.content.replace(/"/g, '')).toBe('·');
  expect(parseFloat(sep.left)).toBeGreaterThanOrEqual(8);
  expect(parseFloat(sep.right)).toBeGreaterThanOrEqual(8);

  // Публикуем второй ресторан — он появляется в ленте сам.
  const added = `E2E MARQUEE ${crypto.randomBytes(3).toString('hex')}`;
  const inserted = await db.execute(
    `INSERT INTO restaurants (name, cities, connect_code, published_at, is_open)
     VALUES ($1, '["Грозный","Аргун","Гудермес","Шали"]', $2, NOW(), 1) RETURNING id`,
    [added, `marquee-${crypto.randomBytes(4).toString('hex')}`],
  );
  const addedId = inserted.rows[0].id;
  try {
    await page.reload();
    await expect.poll(async () => (await marqueeNames(page)).includes(added), { timeout: 10000 }).toBe(true);
    names = await marqueeNames(page);
    expect(names.slice(0, names.length / 2)).toEqual(names.slice(names.length / 2), 'половины остаются одинаковыми');

    // Снимаем с публикации — исчезает.
    await db.execute('UPDATE restaurants SET published_at = NULL WHERE id = $1', [addedId]);
    await page.reload();
    await expect.poll(async () => (await marqueeNames(page)).includes(added), { timeout: 10000 }).toBe(false);

    // Архивирование убирает так же. is_open=0 обязателен: схема не допускает
    // архивированный, но «открытый» ресторан (chk_restaurants_archived_closed).
    await db.execute(
      'UPDATE restaurants SET published_at = NOW(), archived_at = NOW(), is_open = 0 WHERE id = $1',
      [addedId],
    );
    await page.reload();
    expect((await marqueeNames(page)).includes(added)).toBe(false);
  } finally {
    await db.execute('DELETE FROM restaurants WHERE id = $1', [addedId]);
  }
});

test('mobile Safari (WebKit/iPhone): текст, блок и лента ведут себя так же', async () => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await installTestApiHook(page, API_BASE_URL!);
    await page.goto(CLIENT_BASE_URL!);

    await expect(page.locator('#intro-title')).not.toBeEmpty();
    await expect(page.locator('#intro-text')).not.toBeEmpty();

    // На узком экране текст не выпирает за кромку блока.
    const intro = page.locator('#intro');
    const introBox = (await intro.boundingBox())!;
    const textBox = (await page.locator('#intro-text').boundingBox())!;
    expect(textBox.x).toBeGreaterThanOrEqual(introBox.x);
    expect(textBox.x + textBox.width).toBeLessThanOrEqual(introBox.x + introBox.width + 1);
    expect(await intro.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    // И сам блок помещается в экран по ширине.
    expect(introBox.x + introBox.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

    const names = await marqueeNames(page);
    expect(names.length).toBeGreaterThan(0);
    expect(names.slice(0, names.length / 2)).toEqual(names.slice(names.length / 2));
    const halfWidth = await page.locator('#ptrack').evaluate((el) => el.scrollWidth / 2);
    expect(halfWidth).toBeGreaterThanOrEqual(await page.locator('#partners').evaluate((el) => el.clientWidth));
  } finally {
    if (browser) await browser.close();
  }
});
