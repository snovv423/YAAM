import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

// YAAM HQ Stage 4 — полный браузерный сценарий управления рестораном
// (задание, раздел 15C, все 17 пунктов): вход -> добавить ресторан -> найти
// поиском -> открыть -> реальные заказы (awaiting_payment/delivered+оценка/
// cancelled) через существующий orderService -> обновление данных ->
// Заказы/Оценки/Статистика с точными значениями -> правка настроек -> пауза
// -> возобновление -> audit log в БД -> публичный API без приватных полей.
//
// Использует тот же общий эфемерный стек (embedded PostgreSQL +
// createPostgresqlApp(), HQ на /hq), что и hq-login-flow.spec.ts — ТУ ЖЕ
// самую запущенную app-instance и её единственную БД. Тестовый ресторан
// создаётся с уникальным случайным именем — не пересекается с сидовым
// рестораном (server/db/postgresql/seed.js) и с ресторанами, которые могли
// создать другие spec-файлы этого прогона.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const HQ_ADMIN_USER = process.env.YAAM_E2E_HQ_ADMIN_USER;
const HQ_ADMIN_PASSWORD = process.env.YAAM_E2E_HQ_ADMIN_PASSWORD;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !HQ_ADMIN_USER || !HQ_ADMIN_PASSWORD || !DATABASE_URL) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_HQ_ADMIN_USER / YAAM_E2E_HQ_ADMIN_PASSWORD / YAAM_E2E_DATABASE_URL не заданы — globalSetup не выполнился?');
}

// Этот worker-процесс отдельный от процесса globalSetup (см. комментарий в
// hq-clean-root-flow.spec.ts) — db/postgresql singleton здесь СВОЙ, требует
// собственного DATABASE_URL, что безопасно (та же реальная embedded
// PostgreSQL, обычное множественное подключение к одной базе).
process.env.DATABASE_URL = DATABASE_URL;
process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';
const SERVER_DIR = path.resolve(__dirname, '../../server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(SERVER_DIR, 'db/postgresql/index.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orderService = require(path.join(SERVER_DIR, 'services/postgresql/orderService.js'));

function uniquePhone(): string {
  return '+79' + String(crypto.randomInt(100000000, 999999999)).padStart(9, '0');
}

async function createOrderForRestaurant(restaurantId: number, menuItemId: number) {
  const payload = {
    restaurantId,
    city: 'Грозный',
    customerName: 'E2E Клиент',
    customerPhone: uniquePhone(),
    address: 'ул. E2E, 1',
    comment: '',
    fulfillmentType: 'delivery',
    items: [{ menuItemId, name: 'E2E Блюдо', qty: 1 }],
    orderAccessToken: `yaam_ord_v1_${crypto.randomBytes(32).toString('base64url')}`,
    createIdempotencyKey: `yaam_create_v1_${crypto.randomBytes(32).toString('base64url')}`,
  };
  const { order } = await orderService.createOrderAndResolve(payload);
  return order;
}

test('YAAM HQ: полный цикл управления рестораном — создание, реальные заказы/оценки/статистика, пауза, audit log', async ({ page }) => {
  const restaurantName = `E2E Ресторан ${crypto.randomBytes(4).toString('hex')}`;

  // Принимаем confirm() у форм паузы/архивирования — иначе Playwright по
  // умолчанию отклоняет системные диалоги, и форма не отправится.
  page.on('dialog', (dialog) => dialog.accept());

  // 1. Войти в HQ.
  await page.goto(`${API_BASE_URL}/hq/login`);
  await page.getByLabel('Логин').fill(HQ_ADMIN_USER);
  await page.getByLabel('Пароль').fill(HQ_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq`);

  // 2. Открыть «Рестораны».
  await page.getByRole('link', { name: 'Рестораны' }).click();
  await expect(page).toHaveURL(`${API_BASE_URL}/hq/restaurants`);

  // 3. Добавить тестовый ресторан.
  await page.getByRole('link', { name: '+ Добавить ресторан' }).click();
  await page.locator('#rf-name').fill(restaurantName);
  await page.locator('#rf-cities').fill('Грозный');
  await page.locator('#rf-cuisine').fill('E2E кухня');
  await page.locator('#rf-min-order').fill('300');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(new RegExp(`${API_BASE_URL}/hq/restaurants/\\d+$`));
  const restaurantUrl = page.url();
  const restaurantId = Number(restaurantUrl.split('/').pop());

  // 4. Найти его поиском.
  await page.goto(`${API_BASE_URL}/hq/restaurants`);
  await page.locator('input[name="search"]').fill(restaurantName);
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.getByRole('link', { name: restaurantName })).toBeVisible();

  // 5. Открыть.
  await page.getByRole('link', { name: restaurantName }).click();
  await expect(page).toHaveURL(restaurantUrl);

  // 6. Обзор — изначально всё по нулям.
  await expect(page.locator('[data-metric="ordersToday"]')).toHaveText('0');
  await expect(page.getByText('Активных заказов нет.')).toBeVisible();

  // 7. Реальные заказы через orderService — ресторан нужно опубликовать и
  // открыть, дать ему меню (управление меню — Stage 5, здесь напрямую через
  // SQL, как и в server/test/postgresql/hqRestaurantAdminStage4.test.js).
  // published_at обязателен (Stage 4.1) — новый ресторан создаётся
  // черновиком, а schema.sql (chk_restaurants_archived_*) хоть и не
  // блокирует черновик+is_open=1 на уровне БД, публичный API всё равно не
  // покажет его без публикации (см. шаг 17 ниже).
  await db.execute('UPDATE restaurants SET is_open = 1, published_at = NOW() WHERE id = $1', [restaurantId]);
  const catRows = await db.query('INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [restaurantId, 'Cat']);
  const itemRows = await db.query(
    'INSERT INTO menu_items (restaurant_id, category_id, name, price, is_available) VALUES ($1,$2,$3,$4,1) RETURNING id',
    [restaurantId, catRows[0].id, 'E2E Блюдо', 600],
  );
  const menuItemId = itemRows[0].id;

  const orderAwaiting = await createOrderForRestaurant(restaurantId, menuItemId);

  const orderDelivered = await createOrderForRestaurant(restaurantId, menuItemId);
  await db.execute("UPDATE payments SET status = 'succeeded' WHERE order_id = $1", [orderDelivered.id]);
  await db.execute("UPDATE orders SET status = 'delivered' WHERE id = $1", [orderDelivered.id]);
  await orderService.rateOrder(orderDelivered.id, 5);

  const orderCancelled = await createOrderForRestaurant(restaurantId, menuItemId);
  await db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderCancelled.id]);

  // 8-9. Обновить страницу — реальные цифры должны появиться.
  await page.reload();
  await expect(page.locator('[data-metric="ordersToday"]')).toHaveText('3');
  await expect(page.locator('[data-metric="deliveredToday"]')).toHaveText('1');
  await expect(page.locator('[data-metric="turnoverToday"]')).toHaveText('600 ₽');
  await expect(page.locator('[data-metric="active.awaitingPayment"]')).toHaveText('1');

  // Polling-эндпоинт (тот же источник данных, которым пользуется
  // auto-refresh) — подтверждаем, что он тоже видит свежие данные, не
  // дожидаясь реального 20-секундного интервала в браузере.
  const overviewJsonRes = await page.request.get(`${restaurantUrl}/overview.json`);
  const overviewJson = await overviewJsonRes.json();
  expect(overviewJson.ordersToday).toBe(3);
  expect(overviewJson.deliveredToday).toBe(1);

  // 10. Заказы — все три видны с верными статусами.
  await page.locator('.tabs').getByRole('link', { name: 'Заказы' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/orders`);
  await expect(page.getByText(orderAwaiting.public_code)).toBeVisible();
  await expect(page.getByText(orderDelivered.public_code)).toBeVisible();
  await expect(page.getByText(orderCancelled.public_code)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Ожидает оплаты' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Доставлен', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Отменён', exact: true })).toBeVisible();

  // 11. Оценки — реальная оценка видна.
  await page.locator('.tabs').getByRole('link', { name: 'Оценки' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/ratings`);
  await expect(page.getByRole('cell', { name: '★ 5', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: orderDelivered.public_code })).toBeVisible();

  // 12. Статистика — точные значения (оборот = 600, средний чек = 600).
  await page.locator('.tabs').getByRole('link', { name: 'Статистика' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/statistics`);
  await expect(page.getByText('600 ₽').first()).toBeVisible();

  // 13. Изменить базовые настройки.
  await page.locator('.tabs').getByRole('link', { name: 'Настройки' }).click();
  await expect(page).toHaveURL(`${restaurantUrl}/settings`);
  await page.locator('#sf-address').fill('ул. Изменённая, 42');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Изменения сохранены.')).toBeVisible();

  // 14. Поставить на паузу — Stage 5A.1: временная пауза исключительно
  // функция ресторана через Telegram (server/bot/postgresql/index.js:
  // /pause), в HQ для этого нет ни кнопки, ни маршрута. Пауза ставится
  // тем же вызовом, что использует реальная команда бота, HQ должен только
  // честно ПОКАЗАТЬ статус, без единой кнопки управления.
  await orderService.pauseRestaurant(restaurantId, 'short');
  await page.goto(restaurantUrl);
  await expect(page.getByText(/Пауза до/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Пауза:/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Возобновить' })).toHaveCount(0);

  // 15. Вернуть из паузы — тоже через Telegram-эквивалент, не HQ.
  await orderService.resumeRestaurant(restaurantId);
  await page.reload();
  await expect(page.getByText('Открыт', { exact: true })).toBeVisible();

  // 16. Проверить audit log в БД. restaurant_paused/restaurant_resumed НЕ
  // ожидаются — Stage 5A.1 убрал управление паузой из HQ, а orderService
  // (Telegram-эквивалент) не пишет в hq_audit_log (этот журнал — только
  // административные действия HQ, не операционные действия ресторана).
  const auditRows = await db.query(
    'SELECT action FROM hq_audit_log WHERE restaurant_id = $1 ORDER BY id',
    [restaurantId],
  );
  const actions = auditRows.map((r: { action: string }) => r.action);
  expect(actions).toContain('restaurant_created');
  expect(actions).toContain('restaurant_updated');
  expect(actions).not.toContain('restaurant_paused');
  expect(actions).not.toContain('restaurant_resumed');

  // 17. Публичный API не содержит приватных полей.
  const publicRes = await page.request.get(`${API_BASE_URL}/api/restaurants/${restaurantId}`);
  const publicBody = await publicRes.json();
  expect(publicBody).not.toHaveProperty('connect_code');
  expect(publicBody).not.toHaveProperty('telegram_chat_id');
});
