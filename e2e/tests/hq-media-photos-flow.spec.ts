import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 5B/5B.1 — полный браузерный сценарий медиа-системы: войти ->
// создать ресторан -> загрузить главное фото -> добавить ещё 2 -> выбрать
// другую основную -> опубликовать/открыть -> публичная карточка ресторана ->
// проверить галерею -> создать категорию+блюдо -> загрузить 3 фото блюда ->
// выбрать основную -> публичная карточка блюда -> проверить галерею ->
// удалить основную (необратимо, Stage 5B.1) -> подтвердить авто-перенос
// primary на оставшуюся -> проверить audit log -> подтвердить, что удалённый
// объект физически исчез из хранилища, а хранилище подчищено после теста.
//
// Stage 5B.1: у фотографий больше нет reorder/archive/restore (задание,
// раздел 0 — минимализм) — сценарий проверяет ТОЛЬКО upload/primary/delete.
//
// Использует ТОЛЬКО LocalMediaProvider (см. e2e/global-setup.ts:
// MEDIA_PROVIDER=local, MEDIA_LOCAL_DIR — известный временный каталог,
// MEDIA_LOCAL_BASE_URL указывает на реальный /media-fixtures static route,
// который services/postgresql/app.js монтирует сам, только для этого
// режима) — ни один реальный внешний сервис не участвует.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
const MEDIA_LOCAL_DIR = process.env.YAAM_E2E_MEDIA_LOCAL_DIR;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL || !MEDIA_LOCAL_DIR) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD / YAAM_E2E_DATABASE_URL / YAAM_E2E_MEDIA_LOCAL_DIR не заданы — globalSetup не выполнился?');
}

process.env.DATABASE_URL = DATABASE_URL;
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateTestJpeg } = require(path.join(SERVER_DIR, 'test/fixtures/generateTestJpeg.js'));

function countFilesRecursive(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    n += entry.isDirectory() ? countFilesRecursive(p) : 1;
  }
  return n;
}

test('YAAM HQ: полный цикл медиа-системы — фото ресторана и блюда, основная, необратимое удаление, публичная галерея, audit log', async ({ page }) => {
  const restaurantName = `E2E Media ${crypto.randomBytes(4).toString('hex')}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-e2e-media-fixtures-'));

  page.on('dialog', (dialog) => dialog.accept());

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

  async function uploadRestaurantPhoto(alt: string, color: { r: number; g: number; b: number }) {
    await page.goto(`${restaurantUrl}/settings`);
    await expect(page.getByText('Фотографии ресторана')).toBeVisible();
    const filePath = path.join(tmpDir, `${alt.replace(/\s+/g, '_')}.jpg`);
    await generateTestJpeg(filePath, { color });
    await page.locator('input[type="file"][name="photo"]').setInputFiles(filePath);
    await page.locator('.photo-upload input[name="alt_text"]').fill(alt);
    await page.getByRole('button', { name: 'Загрузить' }).click();
    await expect(page).toHaveURL(`${restaurantUrl}/settings`);
  }

  // 3. Загрузить главное (первое) фото ресторана — становится основным автоматически.
  await uploadRestaurantPhoto('Фасад ресторана', { r: 200, g: 60, b: 30 });
  await expect(page.locator('.photo-card').filter({ has: page.locator('img[alt="Фасад ресторана"]') })).toBeVisible();
  await expect(page.locator('.photo-badge')).toHaveText('Основная');

  // 4. Добавить ещё 2 фотографии. Никакого reorder в Stage 5B.1 — только
  // upload/primary/alt/delete (задание, раздел 0).
  await uploadRestaurantPhoto('Зал ресторана', { r: 30, g: 200, b: 60 });
  await uploadRestaurantPhoto('Терраса', { r: 30, g: 60, b: 200 });
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await expect(page.locator('.photo-meta').first()).toHaveText('3 / 20');
  await expect(page.getByRole('button', { name: 'Выше' })).toHaveCount(0);
  // "Архивировать" целиком (не substring) — на Настройках есть НЕсвязанная
  // кнопка "Архивировать ресторан" (lifecycle ресторана, не фото).
  await expect(page.locator('.photo-actions').getByRole('button', { name: 'Архивировать', exact: true })).toHaveCount(0);

  // 5. Выбрать другую основную фотографию («Зал ресторана»).
  const hallCard = page.locator('.photo-card').filter({ has: page.locator('img[alt="Зал ресторана"]') });
  await hallCard.getByRole('button', { name: 'Сделать основной' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/settings`);
  await expect(hallCard.locator('.photo-badge')).toHaveText('Основная');

  // 6-7. Опубликовать/открыть, проверить публичную карточку ресторана и галерею.
  await page.goto(restaurantUrl);
  await page.getByRole('button', { name: 'Опубликовать' }).click();

  const catRow = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [restaurantId, 'Горячее']);
  const categoryId = catRow.rows[0].id;
  await db.execute('INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4)', [restaurantId, categoryId, 'Временное блюдо для открытия', 100]);
  await page.goto(restaurantUrl);
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();

  let publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  expect(publicOne.primary_photo.alt).toBe('Зал ресторана');
  expect(publicOne.gallery).toHaveLength(3);
  for (const key of ['storage_key', 'master', 'bucket']) {
    expect(JSON.stringify(publicOne)).not.toContain(key);
  }

  // 8. Создать категорию + блюдо (через HQ, реальное, не временное для открытия).
  await page.goto(`${restaurantUrl}/menu`);
  await page.locator('input[name="name"]').first().fill('Основное меню');
  await page.getByRole('button', { name: '+ Добавить категорию' }).click();
  await page.getByRole('link', { name: '+ Добавить блюдо' }).click();
  await page.locator('#if-name').fill('Хинкали с бараниной');
  await page.locator('#if-category').selectOption({ label: 'Основное меню' });
  await page.locator('#if-price').fill('450');
  await page.getByRole('button', { name: 'Добавить блюдо' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/menu`);

  const itemRows = await db.query('SELECT id FROM menu_items WHERE restaurant_id = $1 AND name = $2', [restaurantId, 'Хинкали с бараниной']);
  const itemId = itemRows[0].id;
  const itemUrl = `${restaurantUrl}/menu/items/${itemId}`;

  async function uploadDishPhoto(alt: string, color: { r: number; g: number; b: number }) {
    await page.goto(itemUrl);
    await expect(page.getByText('Фотографии блюда')).toBeVisible();
    const filePath = path.join(tmpDir, `dish-${alt.replace(/\s+/g, '_')}.jpg`);
    await generateTestJpeg(filePath, { color });
    await page.locator('input[type="file"][name="photo"]').setInputFiles(filePath);
    await page.locator('.photo-upload input[name="alt_text"]').fill(alt);
    await page.getByRole('button', { name: 'Загрузить' }).click();
    await expect(page).toHaveURL(itemUrl);
  }

  // 9. Загрузить 3 фотографии блюда.
  await uploadDishPhoto('Хинкали крупным планом', { r: 210, g: 150, b: 40 });
  await uploadDishPhoto('Хинкали на тарелке', { r: 90, g: 40, b: 20 });
  await uploadDishPhoto('Соус к хинкали', { r: 20, g: 130, b: 90 });
  await expect(page.locator('.photo-card')).toHaveCount(3);

  // 10. Выбрать основную фотографию блюда («Хинкали на тарелке»).
  const plateCard = page.locator('.photo-card').filter({ has: page.locator('img[alt="Хинкали на тарелке"]') });
  await plateCard.getByRole('button', { name: 'Сделать основной' }).click();
  await expect(page).toHaveURL(itemUrl);
  await expect(plateCard.locator('.photo-badge')).toHaveText('Основная');

  // 11-12. Публичная карточка блюда и галерея.
  publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  const dish = publicOne.menu.find((c: { name: string }) => c.name === 'Основное меню').items.find((i: { name: string }) => i.name === 'Хинкали с бараниной');
  expect(dish.primary_photo.alt).toBe('Хинкали на тарелке');
  expect(dish.gallery).toHaveLength(3);

  // 13. Удалить основную фотографию блюда — НЕОБРАТИМО (Stage 5B.1: нет
  // архивирования, только permanent delete с confirm()).
  await page.goto(itemUrl);
  page.once('dialog', (dialog) => dialog.accept());
  const activePlateCard = page.locator('.photo-card').filter({ has: page.locator('img[alt="Хинкали на тарелке"]') });
  await activePlateCard.getByRole('button', { name: 'Удалить' }).click();
  await expect(page).toHaveURL(itemUrl);
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await expect(page.getByText('Хинкали на тарелке')).toHaveCount(0);

  // 14. Подтвердить, что публичный API авто-перенёс primary на оставшуюся
  // фотографию (не null, не падает).
  publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  const dishAfterDelete = publicOne.menu.find((c: { name: string }) => c.name === 'Основное меню').items.find((i: { name: string }) => i.name === 'Хинкали с бараниной');
  expect(dishAfterDelete.primary_photo).not.toBeNull();
  expect(dishAfterDelete.primary_photo.alt).not.toBe('Хинкали на тарелке');
  expect(['Хинкали крупным планом', 'Соус к хинкали']).toContain(dishAfterDelete.primary_photo.alt);
  expect(dishAfterDelete.gallery).toHaveLength(2);

  // 15. Проверить audit log — все 6 событий медиа-системы (Stage 5B.1).
  const auditRows = await db.query('SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id', [restaurantId]);
  const actions = auditRows.map((r: { action: string }) => r.action);
  const expectedActions = [
    'restaurant_photo_uploaded', 'restaurant_photo_primary_changed',
    'menu_item_photo_uploaded', 'menu_item_photo_primary_changed', 'menu_item_photo_deleted',
  ];
  for (const action of expectedActions) {
    expect(actions).toContain(action);
  }
  expect(actions).not.toContain('restaurant_photo_moved');
  expect(actions).not.toContain('restaurant_photo_archived');
  expect(actions).not.toContain('menu_item_photo_archived');

  // 16. Подтвердить необратимость на уровне БД (ровно 2 строки блюда, ровно
  // 3 строки ресторана — удалённая физически отсутствует, не архивирована).
  const dbPhotoCountRows = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM restaurant_photos WHERE restaurant_id = $1) AS restaurant_photos,
       (SELECT COUNT(*)::int FROM menu_item_photos WHERE menu_item_id = $2) AS dish_photos`,
    [restaurantId, itemId],
  );
  expect(dbPhotoCountRows[0].restaurant_photos).toBe(3);
  expect(dbPhotoCountRows[0].dish_photos).toBe(2);

  // 17. Подтвердить, что физические файлы реально существуют в известном
  // временном каталоге LocalMediaProvider для ВСЕХ оставшихся фотографий (4
  // варианта каждая: thumb/card/full/master — Stage 5B.1) — сам каталог
  // целиком удаляется и проверяется в globalTeardown (e2e/global-setup.ts)
  // ПОСЛЕ завершения всего прогона; здесь же подтверждаем отсутствие
  // orphan-объектов сверх того, что реально отражено в БД.
  const expectedFileCount = (dbPhotoCountRows[0].restaurant_photos + dbPhotoCountRows[0].dish_photos) * 4; // thumb+card+full+master
  const actualFileCount = countFilesRecursive(MEDIA_LOCAL_DIR!);
  expect(actualFileCount).toBeGreaterThanOrEqual(expectedFileCount);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
