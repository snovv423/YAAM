import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// Плитка «+ Добавить фото» в HQ. Дефект: на desktop клик по плитке не
// открывал системный выбор файла. Плитка была <label for=id>, а сам
// <input type="file"> — её соседом, обрезанным до 1×1 (.visually-hidden):
// весь путь «клик → выбор файла» держался на активации label и на том, что
// невидимый контрол остаётся кликабельным. Теперь input лежит внутри плитки
// и сам является её поверхностью.
//
// Второй закреплённый здесь дефект: «Загрузить» до выбора файла выглядела
// рабочей, но нажатие не делало НИЧЕГО — браузер блокировал отправку из-за
// required у невидимого input и не показывал подсказку.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD не заданы — globalSetup не выполнился?');
}

const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateTestJpeg } = require(path.join(SERVER_DIR, 'test/fixtures/generateTestJpeg.js'));

async function login(page: Page) {
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER!);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
}

test('YAAM HQ: клик по плитке «+ Добавить фото» открывает системный выбор файла и на странице блюда, и в настройках ресторана', async ({ page }) => {
  const suffix = crypto.randomBytes(3).toString('hex');
  page.on('dialog', (dialog) => dialog.accept());
  await login(page);

  await page.getByRole('link', { name: 'Рестораны' }).click();
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(`E2E Upload ${suffix}`);
  await page.locator('#rf-city-0').check();
  await page.locator('#rf-submit').click();
  await page.waitForURL(/\/hq\/restaurants\/\d+$/);
  const restaurantUrl = page.url();

  await page.goto(`${restaurantUrl}/menu`);
  await page.locator('details.add-cat > summary').click();
  await page.getByLabel('Название категории').fill('Фото');
  await page.locator('.add-cat-form button[type=submit]').click();
  const categoryId = await page.locator('[data-reorder="categories"] > .cat-block').first().getAttribute('data-category-id');
  await page.goto(`${restaurantUrl}/menu/items/new?category=${categoryId}`);
  await page.locator('#if-name').fill('Блюдо с фото');
  await page.locator('#if-price').fill('500');
  await page.getByRole('button', { name: 'Добавить блюдо' }).click();
  await page.waitForURL(/\/menu$/);
  const itemId = await page.locator('[data-reorder="items"] > .dish-row').first().getAttribute('data-item-id');
  const dishUrl = `${restaurantUrl}/menu/items/${itemId}`;

  for (const url of [dishUrl, `${restaurantUrl}/settings`]) {
    await page.goto(url);
    const tile = page.locator('[data-upload-tile]');
    await expect(tile).toBeVisible();

    // Кликабельная поверхность — сам контрол внутри плитки, а не label[for].
    await expect(tile.locator('input[type=file]')).toHaveCount(1);
    await expect(tile).not.toHaveAttribute('for', /.*/);

    // До выбора файла «Загрузить» выключена — раньше она молча ничего не делала.
    await expect(page.locator('[data-upload-submit]')).toBeDisabled();

    // Настоящий клик обязан открыть системный выбор файла.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      tile.click(),
    ]);
    expect(chooser.isMultiple()).toBe(false);
  }

  // Выбранный файл включает кнопку, показывает превью и доходит до пайплайна.
  await page.goto(dishUrl);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-e2e-upload-tile-'));
  const filePath = path.join(tmpDir, 'photo.jpg');
  await generateTestJpeg(filePath, { color: { r: 40, g: 120, b: 200 } });
  await page.setInputFiles('[data-upload-input]', filePath);
  await expect(page.locator('[data-upload-submit]')).toBeEnabled();
  await expect(page.locator('[data-upload-selected]')).toBeVisible();
  await page.locator('.upload-submit').click();
  await expect(page.locator('[data-photo-card]')).toHaveCount(1);
});
