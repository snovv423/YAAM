import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 4.1 — полный браузерный сценарий publication lifecycle
// (задание, раздел 15C, все 18 пунктов): создать -> черновик, скрыт
// публично -> открыть нельзя до публикации -> опубликовать -> виден
// публично закрытым -> открыть -> публично открыт -> снять с публикации ->
// скрыт и закрыт -> опубликовать снова -> пауза -> архивировать -> скрыт ->
// восстановить -> снова черновик, скрыт -> audit log.
//
// Использует тот же общий эфемерный стек (embedded PostgreSQL +
// createPostgresqlApp(), HQ на /hq), что и hq-login-flow.spec.ts и
// hq-restaurant-management-flow.spec.ts — ТУ ЖЕ самую запущенную
// app-instance и её единственную БД. Тестовый ресторан создаётся с
// уникальным случайным именем.

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

test('YAAM HQ: publication lifecycle — черновик, публикация, открытие, снятие с публикации, архив, восстановление', async ({ page }) => {
  const restaurantName = `E2E Lifecycle ${crypto.randomBytes(4).toString('hex')}`;

  // Подтверждаем системные confirm()-диалоги (публикация без меню/архив и т.п.).
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

  // 3. Убедиться, что он «Черновик».
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Опубликовать' })).toBeVisible();

  // 4. Убедиться через публичный API, что его нет.
  let publicRes = await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`);
  expect(publicRes.status()).toBe(404);
  let publicList = await (await page.request.get(`${API_BASE_URL}/api/restaurants`)).json();
  expect(publicList.some((r: { id: number }) => r.id === restaurantId)).toBe(false);

  // 5. Открыть попытаться нельзя до публикации — кнопки «Открыть» нет вовсе
  // (черновик не открывается напрямую), а прямой POST на /open сервер
  // отклоняет с понятным сообщением.
  await expect(page.getByRole('button', { name: 'Открыть', exact: true })).toHaveCount(0);
  const csrfToken = await page.locator('input[name="_csrf"]').first().getAttribute('value');
  const openAttempt = await page.request.post(`${restaurantUrl}/open`, {
    form: { _csrf: csrfToken || '' },
    maxRedirects: 0,
  });
  expect(openAttempt.status()).toBe(302);
  expect(openAttempt.headers()['location']).toContain('error=');

  // 6. Опубликовать.
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('Закрыт', { exact: true })).toBeVisible();

  // 7. Убедиться, что появился публично как закрытый.
  let publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  expect(publicOne.id).toBe(restaurantId);
  expect(publicOne.is_open).toBe(0);

  // 8. Открыть. Открытие требует доступное блюдо (Stage 5A) — этот сценарий
  // про publication lifecycle, а не про меню, поэтому минимальное блюдо
  // дано напрямую через SQL.
  const catRow = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1, $2) RETURNING id', [restaurantId, 'Cat']);
  await db.execute('INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4)', [restaurantId, catRow.rows[0].id, 'Dish', 100]);
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await expect(page.getByText('Открыт', { exact: true })).toBeVisible();

  // 9. Убедиться, что public API показывает открытый статус.
  publicOne = await (await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`)).json();
  expect(publicOne.is_open).toBe(1);
  expect(publicOne).not.toHaveProperty('published_at');
  expect(publicOne).not.toHaveProperty('archived_at');

  // 10. Снять с публикации.
  await page.getByRole('button', { name: 'Снять с публикации' }).click();

  // 11. Убедиться, что исчез публично и стал закрыт. Снятие с публикации
  // возвращает ровно в состояние "Черновик" (задание, раздел 0 — 5 состояний
  // без отдельного 6-го "снят с публикации") — is_open=0, published_at=NULL,
  // та же самая метка, что и у только что созданного ресторана.
  publicRes = await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`);
  expect(publicRes.status()).toBe(404);
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Опубликовать' })).toBeVisible();

  // 12. Снова опубликовать.
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('Закрыт', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();

  // 13. Поставить на паузу.
  await page.getByRole('button', { name: /Пауза: 33 мин/ }).click();
  await expect(page.getByText(/Пауза до/)).toBeVisible();

  // 14. Архивировать (архивирование живёт на вкладке «Настройки»).
  await page.locator('.tabs').getByRole('link', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Архивировать ресторан' }).click();
  await expect(page.locator('span.badge').filter({ hasText: 'В архиве' })).toBeVisible();

  // 15. Убедиться, что исчез публично.
  publicRes = await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`);
  expect(publicRes.status()).toBe(404);

  // 16. Восстановить.
  await page.getByRole('button', { name: 'Восстановить из архива' }).click();

  // 17. Убедиться, что он черновик и не виден публично.
  await page.goto(restaurantUrl);
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();
  publicRes = await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`);
  expect(publicRes.status()).toBe(404);

  // 18. Проверить audit log.
  const auditRows = await db.query(
    'SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id',
    [restaurantId],
  );
  const actions = auditRows.map((r: { action: string }) => r.action);
  expect(actions).toContain('restaurant_created');
  expect(actions).toContain('restaurant_published');
  expect(actions).toContain('restaurant_unpublished');
  expect(actions).toContain('restaurant_paused');
  expect(actions).toContain('restaurant_archived');
  expect(actions).toContain('restaurant_restored');
  // published дважды (шаг 6 и шаг 12), unpublished один раз (шаг 10).
  expect(actions.filter((a: string) => a === 'restaurant_published').length).toBe(2);
  expect(actions.filter((a: string) => a === 'restaurant_unpublished').length).toBe(1);
});
