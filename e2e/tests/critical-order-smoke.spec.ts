import path from 'node:path';
import { test as base, expect, type Page, type Request } from '@playwright/test';
import { pointFrontendAtLocalBackend as installTestApiHook } from '../fixtures/test-api-hook';

// Переиспользуем уже установленный `pg` из server/node_modules — не заводим
// вторую копию той же зависимости только ради этого файла.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client: PgClient } = require(path.resolve(__dirname, '../../server/node_modules/pg'));

// Критический smoke-сценарий (первая реализация — намеренно НЕ весь
// жизненный цикл заказа, см. отчёт-анализ и текущее задание):
//   быстрый двойной клик по кнопке создания заказа не плодит два заказа ->
//   создать заказ -> код заказа виден -> активный заказ сохранён ->
//   refresh -> заказ восстановился -> дедлайн оплаты не сдвинулся.
//
// Продвижение по жизненному циклу (dev-confirm-payment), Split/СБП/54-ФЗ/
// refunds/выплаты ресторанам — вне scope этой задачи, не тестируется здесь.
//
// ВАЖНО про порядок двух test() ниже: оба используют один и тот же
// эфемерный backend/БД (общий на весь файл, см. global-setup.ts) и один и
// тот же тестовый ресторан из seed.js. YAAM намеренно дедуплицирует
// awaiting_payment-заказы на один ресторан в течение 15 минут
// (server/services/postgresql/orderService.js) — это тот же самый защитный
// механизм, что не даёт случайно оформить два параллельных неоплаченных
// заказа. Если тест "создание+refresh+restore" (который оставляет свой
// заказ в awaiting_payment) запустить ПЕРВЫМ, второй тест ("двойной клик")
// упадёт в реальный 409 от этого дедупа — не из-за бага двойного клика, а
// потому что для этого ресторана уже есть незавершённый заказ. Порядок ниже
// (двойной клик первым, создание+restore вторым) — осознанное решение, а не
// случайность; переставлять тесты местами без учёта этого не стоит.

const API_BASE_URL = process.env.YAAM_E2E_API_BASE_URL;
const CLIENT_BASE_URL = process.env.YAAM_E2E_CLIENT_BASE_URL;
const DATABASE_URL = process.env.YAAM_E2E_DATABASE_URL;
if (!API_BASE_URL || !CLIENT_BASE_URL || !DATABASE_URL) {
  throw new Error('YAAM_E2E_API_BASE_URL / YAAM_E2E_CLIENT_BASE_URL / YAAM_E2E_DATABASE_URL не заданы — globalSetup не выполнился?');
}

const SEEDED_RESTAURANT_TEXT = 'YAAM QA — Тестовый ресторан';
const SEEDED_DISH_TEXT = 'Тестовое блюдо №1';

// Прямой подсчёт строк в orders — публичный GET /api/restaurants намеренно
// считает orders_count только по оплаченным заказам (routes/postgresql/
// api.js: ORDERS_COUNT_JOIN исключает status='awaiting_payment' и требует
// payments.status='succeeded'), а этот smoke-тест намеренно не продвигает
// mock-заказ дальше awaiting_payment (см. шапку файла) — поэтому
// единственное надёжное доказательство "не создано два заказа" здесь идёт
// напрямую в БД, а не через тот эндпоинт.
async function countOrders(): Promise<number> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query('SELECT COUNT(*)::int AS c FROM orders');
    return res.rows[0].c as number;
  } finally {
    await client.end();
  }
}

// Локальная fixture — собирает console errors / network failures за время
// теста, без отдельного файла (используется только этим одним спеком).
const test = base.extend<{ hygiene: { consoleErrors: string[]; failedRequests: string[]; allRequests: Request[] } }>({
  hygiene: async ({ page }, use) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const allRequests: Request[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    });
    page.on('request', (req) => allRequests.push(req));

    await use({ consoleErrors, failedRequests, allRequests });
  },
});

async function pointFrontendAtLocalBackend(page: Page) {
  await installTestApiHook(page, API_BASE_URL);
}

async function goToCheckoutWithOneDish(page: Page) {
  await page.goto(CLIENT_BASE_URL!);

  // Каталог: тестовый ресторан из существующего seed.js.
  const restaurantCard = page.locator('.card', { hasText: SEEDED_RESTAURANT_TEXT });
  await expect(restaurantCard).toBeVisible();
  await restaurantCard.click();

  // Меню: добавляем одно тестовое блюдо. Существующий стабильный DOM — .dish
  // (карточка блюда) + button.add (кнопка "+"), см. client/js/app.js
  // dishCard()/addItem() — новых атрибутов не потребовалось.
  const dish = page.locator('.dish', { hasText: SEEDED_DISH_TEXT });
  await expect(dish).toBeVisible();
  await dish.locator('button.add').click();

  // Нижняя панель корзины -> шторка -> "Оформить заказ".
  const cartBarButton = page.locator('#cartbar .cartbtn');
  await expect(cartBarButton).toBeVisible();
  await cartBarButton.click();

  const sheetCheckoutButton = page.locator('#sheet-checkout');
  await expect(sheetCheckoutButton).toBeVisible();
  await sheetCheckoutButton.click();

  // Экран оформления: обязательное имя + согласие на обработку ПДн.
  const nameField = page.locator('#c-name');
  await expect(nameField).toBeVisible();
  await nameField.fill('QA Smoke Test');

  const pdnCheckbox = page.locator('#chk-pdn');
  if (await pdnCheckbox.count()) {
    await pdnCheckbox.check();
  }
}

async function readActiveOrderState(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('yaam_active_order');
    return raw ? JSON.parse(raw) : null;
  });
}

test.describe('YAAM critical order smoke', () => {
  test('быстрый двойной клик по кнопке создания заказа не создаёт два заказа', async ({ page, hygiene }) => {
    await pointFrontendAtLocalBackend(page);

    const ordersCountBefore = await test.step('зафиксировать количество строк orders в БД до заказа', async () => {
      return countOrders();
    });

    await test.step('дойти до чекаута', async () => {
      await goToCheckoutWithOneDish(page);
    });

    const createOrderRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/orders') {
        createOrderRequests.push(req.url());
      }
    });

    await test.step('быстрый двойной клик — нативный dispatch в одном JS-тике, не page.click() дважды', async () => {
      // page.click() дважды подряд не годится для этой проверки: Playwright
      // ждёт "actionable" (в т.ч. enabled) состояние перед каждым кликом, а
      // именно disabled-состояние кнопки (см. openQR() в client/js/app.js —
      // payBtn.disabled=true синхронно, первым действием обработчика после
      // guard'а checkoutInFlight) и есть часть проверяемой защиты. Два
      // btn.click() подряд в одном page.evaluate() — это два настоящих
      // браузерных click-события в одном JS-тике, наиболее близкая имитация
      // быстрого двойного тапа реальным пользователем, без вмешательства
      // авто-ожидания Playwright.
      await page.evaluate(() => {
        const btn = document.querySelector('#cart button.pay') as HTMLButtonElement;
        btn.click();
        btn.click();
      });

      await expect(page.locator('#qr.screen.active')).toBeVisible();
      await expect(page.locator('#qr-order-code')).toHaveText(/^YAAM-\d+$/);
    });

    await test.step('доказательство через реальную сеть: ровно один POST /api/orders', async () => {
      expect(createOrderRequests.length, `POST /api/orders запросов: ${createOrderRequests.join(', ')}`).toBe(1);
    });

    await test.step('доказательство напрямую по БД: строк orders стало ровно на 1 больше', async () => {
      const ordersCountAfter = await countOrders();
      expect(ordersCountAfter).toBe(ordersCountBefore + 1);
    });

    await test.step('гигиена: без console errors и без failed network requests', async () => {
      expect(hygiene.consoleErrors, hygiene.consoleErrors.join('\n')).toEqual([]);
      expect(hygiene.failedRequests, hygiene.failedRequests.join('\n')).toEqual([]);
    });

    await test.step('очистка: отменить заказ (освобождает 15-минутный awaiting_payment dedup для этого ресторана)', async () => {
      // Явная отмена освобождает dedup — задокументированное поведение
      // (CLAUDE.md: "awaiting_payment дедуплицируется 15 минут; явная отмена
      // освобождает dedup"). Оба теста в этом файле используют один и тот же
      // общий backend/БД и один и тот же тестовый ресторан (см. шапку файла),
      // поэтому каждый тест обязан за собой убирать свой awaiting_payment
      // заказ — иначе следующий тест столкнётся с реальным 409 от этого же
      // dedup, а не с багом. Существующая UI-кнопка на экране QR
      // (cancelOrderFlow(true)) — ничего нового, тот же путь, что доступен
      // реальному пользователю.
      await page.locator('#qr .ghost').click();
      await page.locator('#confirm-yes').click();
      await expect(page.locator('#home.screen.active')).toBeVisible();
    });
  });

  test('создание заказа, отображение кода, восстановление после refresh, дедлайн оплаты не сдвигается', async ({ page, hygiene }) => {
    await pointFrontendAtLocalBackend(page);

    await test.step('открыть каталог, выбрать ресторан, добавить блюдо, дойти до чекаута', async () => {
      await goToCheckoutWithOneDish(page);
    });

    await test.step('создать заказ и увидеть код заказа', async () => {
      const payButton = page.locator('#cart button.pay');
      await expect(payButton).toBeVisible();
      await payButton.click();

      await expect(page.locator('#qr.screen.active')).toBeVisible();
      await expect(page.locator('#qr-order-code')).toHaveText(/^YAAM-\d+$/);
    });

    const orderCode = await page.locator('#qr-order-code').textContent();

    const stateBeforeReload = await test.step('убедиться, что активный заказ сохранён в localStorage', async () => {
      const state = await readActiveOrderState(page);
      expect(state, 'yaam_active_order должен существовать сразу после создания заказа').not.toBeNull();
      expect(state.orderCode).toBe(orderCode);
      expect(typeof state.orderAccessToken).toBe('string');
      expect(state.orderAccessToken.length).toBeGreaterThan(0);
      expect(typeof state.qrDeadline).toBe('number');
      return state;
    });

    await test.step('access token нигде не утекает в публичные запросы/ответы', async () => {
      const token: string = stateBeforeReload.orderAccessToken;
      for (const req of hygiene.allRequests) {
        expect(req.url().includes(token), `token найден в URL запроса: ${req.url()}`).toBe(false);
      }
      const publicListResponse = await page.request.get(`${API_BASE_URL}/api/restaurants?city=Грозный`);
      const publicListBody = await publicListResponse.text();
      expect(publicListBody.includes(token)).toBe(false);
    });

    await test.step('обновить страницу и убедиться, что заказ восстановился', async () => {
      await page.reload();
      // Восстановление активного заказа после refresh — уже существующая
      // клиентская логика (tryRestoreSession -> startOrderPolling): для
      // заказа в статусе awaiting_payment она ведёт на #status с баннером
      // "Оплата пока не завершена" (renderAwaitingPayment), а не обратно на
      // #qr — это НЕ то же самое, что путь "внутри уже открытой вкладки"
      // (resumeExistingOrderFlow), поэтому проверяем именно тот экран, на
      // который реально попадает пользователь после настоящего refresh.
      // Ждём конкретного состояния (тот же код заказа виден), а не паузы.
      await expect(page.locator('#status.screen.active')).toBeVisible();
      await expect(page.locator('#st-num')).toHaveText(orderCode!);
    });

    await test.step('дедлайн 15-минутного окна оплаты не сдвинулся после refresh', async () => {
      const stateAfterReload = await readActiveOrderState(page);
      expect(stateAfterReload).not.toBeNull();
      expect(stateAfterReload.qrDeadline).toBe(stateBeforeReload.qrDeadline);
      expect(stateAfterReload.orderAccessToken).toBe(stateBeforeReload.orderAccessToken);
    });

    await test.step('гигиена: без console errors и без failed network requests', async () => {
      expect(hygiene.consoleErrors, hygiene.consoleErrors.join('\n')).toEqual([]);
      expect(hygiene.failedRequests, hygiene.failedRequests.join('\n')).toEqual([]);
    });

    await test.step('очистка: отменить заказ (освобождает 15-минутный awaiting_payment dedup для этого ресторана)', async () => {
      // См. аналогичный шаг и комментарий в первом test(). После restore
      // заказ в статусе awaiting_payment показывает #st-pending-pay-wrap
      // (renderAwaitingPayment скрывает #st-cancel-wrap и показывает именно
      // этот блок — "Вернуться к оплате" + "Отменить заказ"), а не
      // #st-cancel-wrap — используем существующую кнопку из фактически
      // видимого блока, а не первую попавшуюся с тем же текстом.
      await page.locator('#st-pending-pay-wrap button.ghost').click();
      await page.locator('#confirm-yes').click();
      await expect(page.locator('#home.screen.active')).toBeVisible();
    });
  });

  // Два сценария ниже перечислены в приёмке как обязательные, но автоматом
  // не проверялись никогда: пока обвязка уводила клиент на production API,
  // писать их было не на чем. Ставятся последними — оба теста выше уже
  // отменили свои заказы и освободили 15-минутный awaiting_payment dedup.

  test('меню -> блюдо -> назад возвращает ту же позицию прокрутки меню', async ({ page, hygiene }) => {
    // Мобильный вьюпорт нужен по существу: на 1280x720 меню seed-ресторана
    // из трёх блюд помещается целиком и прокручивать нечего — тест был бы
    // зелёным, ничего не проверяя.
    await page.setViewportSize({ width: 393, height: 852 });
    await pointFrontendAtLocalBackend(page);

    // Насколько именно прокрутится меню, зависит от содержимого seed'а, а не
    // от проверяемого поведения: у тестового ресторана нет фотографий, и
    // запас прокрутки невелик. Поэтому целимся в конец страницы и дальше
    // сравниваем с фактически достигнутой позицией, а не с константой.
    const scrolledTo = await test.step('открыть ресторан и прокрутить меню', async () => {
      await page.goto(CLIENT_BASE_URL!);
      const restaurantCard = page.locator('.card', { hasText: SEEDED_RESTAURANT_TEXT });
      await expect(restaurantCard).toBeVisible();
      await restaurantCard.click();
      await expect(page.locator('#menu.screen.active')).toBeVisible();
      const reached = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        return window.scrollY;
      });
      expect(reached, 'меню обязано быть прокручиваемым, иначе тест ничего не проверяет')
        .toBeGreaterThan(0);
      return reached;
    });

    await test.step('открыть блюдо', async () => {
      await page.locator('.dish', { hasText: SEEDED_DISH_TEXT }).click();
      await expect(page.locator('#dish.screen.active')).toBeVisible();
    });

    await test.step('назад: тот же ресторан и та же позиция прокрутки', async () => {
      await page.locator('#dish .back').click();
      await expect(page.locator('#menu.screen.active')).toBeVisible();
      // SEEDED_RESTAURANT_TEXT — подстрока: полное имя из seed'а несёт ещё и
      // суффикс стадии, привязываться к нему целиком незачем.
      await expect(page.locator('#m-name')).toContainText(SEEDED_RESTAURANT_TEXT);
      // Восстановление позиции идёт через history.back() -> popstate ->
      // restoreMenuPosition() с контрольным кадром в requestAnimationFrame,
      // поэтому ждём значение опросом, а не фиксированной паузой.
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolledTo);
    });

    await test.step('гигиена: без console errors и без failed network requests', async () => {
      expect(hygiene.consoleErrors, hygiene.consoleErrors.join('\n')).toEqual([]);
      expect(hygiene.failedRequests, hygiene.failedRequests.join('\n')).toEqual([]);
    });
  });

  test('ссылка «Поделиться» открывает статус заказа по access_token, публичный код без токена не пускает', async ({ page, hygiene }) => {
    await pointFrontendAtLocalBackend(page);

    await test.step('создать заказ', async () => {
      await goToCheckoutWithOneDish(page);
      await page.locator('#cart button.pay').click();
      await expect(page.locator('#qr.screen.active')).toBeVisible();
      await expect(page.locator('#qr-order-code')).toHaveText(/^YAAM-\d+$/);
    });

    const orderCode = (await page.locator('#qr-order-code').textContent())!;
    const state = await readActiveOrderState(page);
    const token: string = state.orderAccessToken;

    await test.step('публичный код заказа сам по себе не является авторизацией', async () => {
      // Тот же инвариант, что и в CLAUDE.md: YAAM-xxxxx не даёт доступа,
      // нужен access_token. Проверяем напрямую по API, без UI.
      const withoutToken = await page.request.get(`${API_BASE_URL}/api/orders/${orderCode}`);
      expect(withoutToken.ok(), `GET без токена вернул ${withoutToken.status()}`).toBe(false);
    });

    await test.step('ссылка с токеном во фрагменте открывает статус заказа', async () => {
      await page.goto(`${CLIENT_BASE_URL}/#shared=${orderCode}:${token}`);
      await expect(page.locator('#status.screen.active')).toBeVisible();
      await expect(page.locator('#st-num')).toHaveText(orderCode);
    });

    await test.step('токен остаётся во фрагменте и не уходит на сервер', async () => {
      // Фрагмент URL браузер не передаёт в запросе, но клиент мог бы
      // случайно прокинуть токен в query — этого быть не должно.
      for (const req of hygiene.allRequests) {
        expect(req.url().includes(token), `token найден в URL запроса: ${req.url()}`).toBe(false);
      }
    });

    await test.step('очистка: отменить заказ', async () => {
      await page.goto(CLIENT_BASE_URL!);
      await expect(page.locator('#status.screen.active')).toBeVisible();
      await page.locator('#st-pending-pay-wrap button.ghost').click();
      await page.locator('#confirm-yes').click();
      await expect(page.locator('#home.screen.active')).toBeVisible();
    });
  });

  test('service worker действительно активен в этом прогоне и не кэширует API заказов', async ({ page }) => {
    // Без этой проверки контрольный прогон с YAAM_E2E_BLOCK_SW=1 ничего не
    // доказывал бы: «с воркером и без воркера одинаково» имеет смысл только
    // если в обычном режиме воркер и правда регистрируется.
    test.skip(process.env.YAAM_E2E_BLOCK_SW === '1', 'контрольный прогон без service worker');
    await pointFrontendAtLocalBackend(page);

    await page.goto(CLIENT_BASE_URL!);
    await expect(page.locator('.card', { hasText: SEEDED_RESTAURANT_TEXT })).toBeVisible();

    const registered = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active;
    });
    expect(registered, 'client/js/pwa.js обязан зарегистрировать sw.js на 127.0.0.1 (secure context)').toBe(true);

    // Повторная навигация — уже под управлением воркера; каталог обязан
    // грузиться так же, а ответы API не имеют права осесть в CacheStorage.
    await page.reload();
    await expect(page.locator('.card', { hasText: SEEDED_RESTAURANT_TEXT })).toBeVisible();

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) urls.push(req.url);
      }
      return { controlled: !!navigator.serviceWorker.controller, urls };
    });
    expect(cached.controlled, 'после reload страница обязана быть под управлением воркера').toBe(true);
    const apiUrls = cached.urls.filter((u) => u.includes('/api/'));
    expect(apiUrls, `ответы API попали в кэш: ${apiUrls.join(', ')}`).toEqual([]);
    expect(cached.urls.some((u) => u.includes('/js/app.js')), 'app shell должен кэшироваться').toBe(true);
  });
});
