import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 3 — браузерный E2E для «Настройки → Безопасность»: войти ->
// сменить пароль -> принудительный logout -> старый пароль больше не
// работает -> новый пароль работает. Использует тот же общий эфемерный стек
// (embedded PostgreSQL + createPostgresqlApp(), HQ смонтирован на /hq), что
// и hq-login-flow.spec.ts — ту же самую запущенную app-instance, поэтому в
// конце теста пароль ВОЗВРАЩАЕТСЯ на исходный: владелец HQ — синглтон (одна
// строка hq_owner на всю БД), и другие spec-файлы в этом же прогоне
// (в частности hq-login-flow.spec.ts) полагаются на исходные
// YAAM_E2E_HQ_ADMIN_USER/YAAM_E2E_HQ_ADMIN_PASSWORD оставаясь рабочими
// независимо от порядка запуска файлов.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD не заданы — globalSetup не выполнился?');
}

async function loginHq(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(username);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

test('YAAM HQ: смена пароля через Настройки → Безопасность принудительно завершает сессию, старый пароль перестаёт работать', async ({ page }) => {
  const newPassword = `Changed-${crypto.randomBytes(9).toString('base64url')}`;

  try {
    // 1-2. Войти исходными данными, перейти в Настройки.
    await loginHq(page, HQ_ADMIN_USER, HQ_ADMIN_PASSWORD);
    await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
    await page.getByRole('link', { name: 'Настройки' }).click();
    await expect(page).toHaveURL(`${API_BASE_URL}/hq/settings`);

    // 3. Заполнить форму «Смена пароля» (два поля «Текущий пароль» на
    // странице — в форме логина и в форме пароля — используем уникальные id,
    // не getByLabel, чтобы не столкнуться с неоднозначным совпадением).
    await page.locator('#change-password-current-password').fill(HQ_ADMIN_PASSWORD);
    await page.locator('#change-password-new-password').fill(newPassword);
    await page.locator('#change-password-confirm-password').fill(newPassword);
    await page.getByRole('button', { name: 'Сменить пароль' }).click();

    // 4. Принудительный logout — редирект на логин с уведомлением.
    await expect(page).toHaveURL(`${API_BASE_URL}/hq/login?changed=password`);
    await expect(page.getByText('Пароль изменён. Войдите с новым паролем.')).toBeVisible();

    // 5. Старый пароль больше не работает.
    await loginHq(page, HQ_ADMIN_USER, HQ_ADMIN_PASSWORD);
    await expect(page).toHaveURL(`${API_BASE_URL}/hq/login`);
    await expect(page.getByText('Неверный логин или пароль.')).toBeVisible();

    // 6. Новый пароль работает.
    await loginHq(page, HQ_ADMIN_USER, newPassword);
    await expect(page).toHaveURL(`${API_BASE_URL}/hq`);
    await expect(page.locator('h1')).toHaveText('Обзор');
  } finally {
    // Возвращаем исходный пароль, чтобы не оставлять общего владельца HQ в
    // изменённом состоянии для остальных spec-файлов этого прогона —
    // best-effort, выполняется даже если какой-то assert выше упал.
    await page.goto(`${API_BASE_URL}/hq/login`);
    const stillOnLogin = await page.locator('h1').filter({ hasText: 'YAAM HQ' }).count();
    if (stillOnLogin > 0) {
      await loginHq(page, HQ_ADMIN_USER!, newPassword);
    }
    if (page.url() === `${API_BASE_URL}/hq`) {
      await page.getByRole('link', { name: 'Настройки' }).click();
      await page.locator('#change-password-current-password').fill(newPassword);
      await page.locator('#change-password-new-password').fill(HQ_ADMIN_PASSWORD!);
      await page.locator('#change-password-confirm-password').fill(HQ_ADMIN_PASSWORD!);
      await page.getByRole('button', { name: 'Сменить пароль' }).click();
    }
  }
});
