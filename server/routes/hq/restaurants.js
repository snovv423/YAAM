'use strict';

// YAAM HQ Stage 4 — рабочий раздел «Рестораны». Смонтирован в routes/hq/
// index.js под '/restaurants' (внутри уже защищённой /hq зоны — requireHqAuth
// применяется в точке монтирования, не здесь, тем же принципом, что и
// createPagesRouter).
const express = require('express');
const multer = require('multer');
const svc = require('../../services/hq/restaurantAdminService');
const statsService = require('../../services/hq/restaurantStatsService');
const menuSvc = require('../../services/hq/menuAdminService');
const photoService = require('../../services/hq/media/photoService');
const { MAX_SOURCE_BYTES } = require('../../services/hq/media/imagePipeline');
const legalService = require('../../services/hq/restaurantLegalDetailsService');
const bankService = require('../../services/hq/restaurantBankDetailsService');
const contractService = require('../../services/hq/restaurantContractService');
const payoutService = require('../../services/hq/restaurantPayoutService');
// Сущность выплаты (обязательство/попытки) — ОТДЕЛЬНЫЙ сервис от
// payoutService выше (тот про готовность реквизитов); имя намеренно другое,
// тем же приёмом, что и в routes/hq/pages.js.
const payoutRecordService = require('../../services/hq/payoutService');
const payoutStateService = require('../../services/hq/restaurantPayoutStateService');
const telegramLinkService = require('../../services/hq/telegramLinkService');
const financeService = require('../../services/hq/restaurantFinanceService');
const candidateService = require('../../services/hq/restaurantCandidateService');
const candidatesViews = require('../../hq/restaurantCandidatesViews');
const {
  logAuditEvent, summarizeRestaurantDiff, summarizeMenuItemDiff, summarizeCategoryDiff, summarizePhotoDetails,
  summarizeLegalDetailsDiff, summarizeBankDetailsDiff, summarizeContractDiff, summarizeContractStatusChange,
} = require('../../services/hq/auditLog');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { layout } = require('../../hq/layout');
const views = require('../../hq/restaurantsViews');
const menuViews = require('../../hq/menuViews');
const financeViews = require('../../hq/restaurantFinanceViews');
const { formatMinorRub } = require('../../services/money');

function notFoundBody(linkBasePath) {
  return `<h1>Ресторан не найден</h1><div class="panel"><div class="empty-state">Проверьте адрес или вернитесь к списку.</div></div><a class="btn ghost" href="${linkBasePath}/restaurants">← К списку ресторанов</a>`;
}

// multer.memoryStorage() — файл буферизуется в память и полностью
// валидируется/обрабатывается (services/hq/media/imagePipeline.js) ДО того,
// как коснётся хранилища (задание, раздел 4: "buffered so uploaded files
// can be validated... before ever touching the storage provider"). Лимит
// размера здесь — первая линия защиты (обрывает соединение раньше, чем файл
// целиком попадёт в память); imagePipeline.validateSourceImage() повторяет
// ту же проверку размера самостоятельно (defense in depth, не полагается
// только на middleware).
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOURCE_BYTES, files: 1 },
});

function createRestaurantsRouter({ linkBasePath, mediaProvider = null }) {
  const router = express.Router();

  // ---------------------------------------------------------------------
  // Список + создание
  // ---------------------------------------------------------------------

  // docs/HQ-PRODUCT-SPEC.md: без поиска/фильтров/сортировки/пагинации —
  // простой список всех неархивированных ресторанов по алфавиту.
  router.get('/', async (req, res, next) => {
    try {
      const restaurants = await svc.listRestaurantsForHq();
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Рестораны',
        active: 'restaurants',
        csrfToken,
        linkBasePath,
        body: views.renderRestaurantsList({ restaurants, linkBasePath }),
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/new', (req, res) => {
    const csrfToken = ensureCsrfToken(req);
    res.send(layout({
      title: 'Новый ресторан',
      active: 'restaurants',
      csrfToken,
      linkBasePath,
      body: views.renderCreateForm({ values: {}, linkBasePath, csrfToken }),
    }));
  });

  router.post('/', requireCsrf, async (req, res, next) => {
    try {
      const restaurant = await svc.createRestaurant(req.body);
      await logAuditEvent({
        action: 'restaurant_created',
        restaurantId: restaurant.id,
        details: `name: "${restaurant.name}"`,
        ip: req.ip,
      });
      // PRG — редирект на GET страницу нового ресторана, повторная отправка
      // той же формы (F5/двойной клик) больше не может создать вторую
      // запись, потому что браузер её просто не переотправит без явного
      // подтверждения (задание, раздел 4).
      res.redirect(`${linkBasePath}/restaurants/${restaurant.id}`);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(400).send(layout({
          title: 'Новый ресторан',
          active: 'restaurants',
          csrfToken,
          linkBasePath,
          body: views.renderCreateForm({ values: req.body, error: err.message, linkBasePath, csrfToken }),
        }));
      }
      next(err);
    }
  });

  // ---------------------------------------------------------------------
  // «Кого ждём» — отдельный список кандидатов для клиентского голосования
  // (задание, раздел 2). ДО router.param('id', ...) / '/:id' ниже: иначе
  // GET/POST '/candidates' совпали бы с шаблоном '/:id' (id='candidates')
  // и упали бы на несуществующем ресторане вместо этой страницы.
  // ---------------------------------------------------------------------

  router.get('/candidates', async (req, res, next) => {
    try {
      const candidates = await candidateService.listCandidates();
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Кого ждём',
        active: 'restaurants',
        csrfToken,
        linkBasePath,
        body: candidatesViews.renderCandidatesPage({
          candidates, error: req.query.error, notice: req.query.notice, linkBasePath, csrfToken,
        }),
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/candidates', requireCsrf, async (req, res, next) => {
    try {
      await candidateService.createCandidate(req.body);
      res.redirect(`${linkBasePath}/restaurants/candidates`);
    } catch (err) {
      if (err instanceof candidateService.ValidationError) {
        return res.redirect(`${linkBasePath}/restaurants/candidates?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  router.post('/candidates/:candidateId/delete', requireCsrf, async (req, res, next) => {
    try {
      await candidateService.deleteCandidate(req.params.candidateId);
      res.redirect(`${linkBasePath}/restaurants/candidates`);
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------
  // Загрузка ресторана по :id — единая точка честного 404 (задание, раздел 5:
  // "без stack trace, без утечки SQL/внутренних деталей").
  // ---------------------------------------------------------------------

  router.param('id', async (req, res, next, id) => {
    try {
      const restaurant = await svc.getRestaurantById(id);
      if (!restaurant) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'restaurants', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      req.restaurant = restaurant;
      next();
    } catch (err) {
      next(err);
    }
  });

  // YAAM HQ Stage 5B/5B.1 — данные для панели «Фотографии ресторана» (вкладка
  // «Настройки»). mediaConfigured=false, если MEDIA_PROVIDER не задан на
  // этом окружении — сама вкладка Настроек продолжает работать, просто без
  // раздела фотографий. Stage 5B.1: нет архивированных фотографий вовсе
  // (удаление необратимо) — список всегда один, без раздельного active/archived.
  // maxPhotos — RESTAURANT_MAX_PHOTOS (3, docs/HQ-PRODUCT-SPEC.md), не общий
  // MAX_PHOTOS_PER_OWNER: галерея ресторана ограничена тремя фотографиями и
  // на уровне сервиса (photoService.uploadPhoto), и в подписи формы.
  async function restaurantPhotoViewData(restaurantId) {
    if (!mediaProvider) return { photos: [], mediaConfigured: false, maxPhotos: photoService.RESTAURANT_MAX_PHOTOS };
    const all = await photoService.listRestaurantPhotos(restaurantId);
    return {
      photos: all.map((p) => ({ ...p, urls: photoService.photoVariantUrls(mediaProvider, p) })),
      mediaConfigured: true,
      maxPhotos: photoService.RESTAURANT_MAX_PHOTOS,
    };
  }

  // YAAM HQ Stage 6 — юридические данные/банковские реквизиты/договор для
  // вкладки «Настройки» — один параллельный fetch, ровно тот же принцип,
  // что и restaurantPhotoViewData выше.
  async function restaurantFinanceViewData(restaurantId) {
    const [legal, bank, contract] = await Promise.all([
      legalService.getLegalDetails(restaurantId),
      bankService.getBankDetails(restaurantId),
      contractService.getContract(restaurantId),
    ]);
    return { legal, bank, contract };
  }

  async function pageShell({ restaurant, active, csrfToken, tabBody, req }) {
    // docs/HQ-PRODUCT-SPEC.md, «Заголовок ресторана»: шапка содержит только
    // название/города/статус/рейтинг — готовность к выплатам и Telegram
    // больше не рендерятся на КАЖДОЙ вкладке (они на своих экранах), поэтому
    // здесь исчезли и соответствующие запросы.
    const banner = views.renderActionBanner({ error: req?.query?.error, notice: req?.query?.notice });
    return banner
      + views.renderRestaurantHeader({ restaurant })
      + views.renderTabs({ restaurantId: restaurant.id, active, linkBasePath })
      + tabBody;
  }

  // Lifecycle-действия (публикация/открытие/закрытие/пауза/возобновление)
  // возвращают ValidationError на ожидаемых, не исключительных отказах
  // (например: "Сначала опубликуйте ресторан.", двойной клик по уже
  // обработанному действию) — это не 500 и не молчаливый редирект, а
  // понятный error-баннер на той же странице (задание, раздел 7: "понятный
  // success/error state"), тем же PRG-паттерном, что и вся остальная форма.
  function handleLifecycleAction(action) {
    return async (req, res, next) => {
      try {
        await action(req);
        res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}`);
      } catch (err) {
        if (err instanceof svc.ValidationError) {
          return res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}?error=${encodeURIComponent(err.message)}`);
        }
        next(err);
      }
    };
  }

  // --- Обзор ---
  router.get('/:id', async (req, res, next) => {
    try {
      const [overview, payoutState] = await Promise.all([
        statsService.getOverview(req.restaurant.id),
        payoutStateService.getRestaurantPayoutState(req.restaurant.id),
      ]);
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'overview', csrfToken, req,
        tabBody: views.renderOverviewTab({ restaurant: req.restaurant, overview, payoutState, csrfToken, linkBasePath }),
      });
      res.send(layout({ title: req.restaurant.name, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // Индивидуальная выплата ОДНОМУ ресторану (docs/HQ-PRODUCT-SPEC.md).
  // Проходит через тот же payoutService.prepareRestaurantPayout(), что и
  // общая вкладка «Выплаты» — отдельного приблизительного расчёта нет.
  // Общая вкладка «Выплаты» этой задачей не переписывалась.
  router.post('/:id/payout', requireCsrf, async (req, res, next) => {
    const base = `${linkBasePath}/restaurants/${req.restaurant.id}`;
    try {
      const payout = await payoutStateService.payRestaurantNow(req.restaurant.id);
      await logAuditEvent({
        action: 'restaurant_payout_prepared', restaurantId: req.restaurant.id,
        details: `выплата #${payout.id}: ${formatMinorRub(payout.amount)}`, ip: req.ip,
      });
      res.redirect(`${base}?notice=${encodeURIComponent('Выплата подготовлена. Переведите деньги вручную в банковском клиенте, затем отметьте выплату выполненной.')}`);
    } catch (err) {
      if (err instanceof payoutRecordService.ValidationError) {
        return res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  // --- Меню (Stage 5A) ---

  // Если после отключения/архивирования блюда у ОТКРЫТОГО ресторана не
  // осталось ни одного доступного блюда — ресторан автоматически
  // закрывается (задание, раздел 13, рекомендованный вариант: "остаётся
  // опубликованным и видимым... HQ показывает причину"). closeRestaurant()
  // уже гарантированно проходит все свои guard'ы в этой точке (ресторан был
  // published+open, чтобы вообще принимать заказы), поэтому вызывается
  // напрямую, без обхода lifecycle-проверок.
  async function autoCloseIfNoAvailableDishes(restaurant, ip) {
    if (!restaurant.is_open) return false;
    const available = await menuSvc.countAvailableMenuItems(restaurant.id);
    if (available > 0) return false;
    await svc.closeRestaurant(restaurant.id);
    await logAuditEvent({
      action: 'restaurant_updated', restaurantId: restaurant.id,
      details: 'is_open: 1 -> 0 (auto: нет доступных блюд)', ip,
    });
    return true;
  }

  router.param('categoryId', async (req, res, next, categoryId) => {
    try {
      const category = await menuSvc.getCategoryById(req.restaurant.id, categoryId);
      if (!category) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'restaurants', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      req.category = category;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.param('itemId', async (req, res, next, itemId) => {
    try {
      const item = await menuSvc.getMenuItemById(req.restaurant.id, itemId);
      if (!item) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'restaurants', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      req.menuItem = item;
      next();
    } catch (err) {
      next(err);
    }
  });

  function menuActionRedirect(res, restaurantId, extra) {
    const qs = extra ? `?${new URLSearchParams(extra).toString()}` : '';
    res.redirect(`${linkBasePath}/restaurants/${restaurantId}/menu${qs}`);
  }

  // YAAM HQ Stage 5B/5B.1 — данные для панели «Фотографии блюда» (карточка
  // блюда). Тот же принцип, что и restaurantPhotoViewData выше.
  async function menuItemPhotoViewData(restaurantId, itemId) {
    if (!mediaProvider) return { photos: [], mediaConfigured: false, maxPhotos: photoService.MAX_PHOTOS_PER_OWNER };
    const all = await photoService.listMenuItemPhotos(restaurantId, itemId);
    return {
      photos: all.map((p) => ({ ...p, urls: photoService.photoVariantUrls(mediaProvider, p) })),
      mediaConfigured: true,
      maxPhotos: photoService.MAX_PHOTOS_PER_OWNER,
    };
  }

  // Превью блюда в компактной строке меню — первая (основная) загруженная
  // фотография, если медиа настроено; иначе внешний photo_url, если он
  // заполнен. Один запрос на всё меню, не N+1 по блюдам.
  async function attachDishThumbs(restaurantId, menu) {
    const byItem = new Map();
    if (mediaProvider) {
      const photos = await photoService.listMenuItemPhotosForRestaurant(restaurantId);
      for (const p of photos) {
        if (byItem.has(p.menu_item_id)) continue;
        byItem.set(p.menu_item_id, photoService.photoVariantUrls(mediaProvider, p).thumb);
      }
    }
    return menu.map((category) => ({
      ...category,
      items: category.items.map((item) => ({
        ...item,
        thumb_url: byItem.get(item.id) || item.photo_url || null,
      })),
    }));
  }

  router.get('/:id/menu', async (req, res, next) => {
    try {
      const rawMenu = await menuSvc.listMenu(req.restaurant.id);
      const menu = await attachDishThumbs(req.restaurant.id, rawMenu);
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'menu', csrfToken, req,
        tabBody: menuViews.renderMenuTab({
          restaurant: req.restaurant, menu, csrfToken, linkBasePath,
          error: req.query.error, notice: req.query.notice,
        }),
      });
      res.send(layout({ title: `Меню — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // --- Архив меню (docs/HQ-PRODUCT-SPEC.md, раздел «Архив меню») ---
  router.get('/:id/menu/archive', async (req, res, next) => {
    try {
      const [archive, menu] = await Promise.all([
        menuSvc.listMenuArchive(req.restaurant.id),
        menuSvc.listMenu(req.restaurant.id),
      ]);
      const itemsWithThumbs = mediaProvider
        ? await (async () => {
            const photos = await photoService.listMenuItemPhotosForRestaurant(req.restaurant.id);
            const byItem = new Map();
            for (const p of photos) {
              if (!byItem.has(p.menu_item_id)) byItem.set(p.menu_item_id, photoService.photoVariantUrls(mediaProvider, p).thumb);
            }
            return archive.items.map((i) => ({ ...i, thumb_url: byItem.get(i.id) || i.photo_url || null }));
          })()
        : archive.items.map((i) => ({ ...i, thumb_url: i.photo_url || null }));
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'menu', csrfToken, req,
        tabBody: menuViews.renderMenuArchive({
          restaurant: req.restaurant,
          archive: { items: itemsWithThumbs, categories: archive.categories },
          activeCategories: menu.filter((c) => !c.archived_at),
          csrfToken, linkBasePath,
        }),
      });
      res.send(layout({ title: `Архив меню — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // --- Порядок перетаскиванием (спецификация: без кнопок «Выше»/«Ниже») ---
  // JSON-эндпоинты: клиент присылает полный новый порядок id, сервер
  // применяет его целиком (см. menuAdminService.reorderCategories).
  router.post('/:id/menu/reorder-categories', requireCsrf, async (req, res, next) => {
    try {
      const applied = await menuSvc.reorderCategories(req.restaurant.id, req.body.order);
      if (applied > 0) {
        await logAuditEvent({
          action: 'category_moved', restaurantId: req.restaurant.id,
          details: `новый порядок категорий (${applied})`, ip: req.ip,
        });
      }
      res.json({ ok: true, applied });
    } catch (err) {
      if (err instanceof svc.ValidationError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  router.post('/:id/menu/categories/:categoryId/reorder-items', requireCsrf, async (req, res, next) => {
    try {
      const applied = await menuSvc.reorderMenuItems(req.restaurant.id, req.category.id, req.body.order);
      if (applied > 0) {
        await logAuditEvent({
          action: 'menu_item_moved', restaurantId: req.restaurant.id,
          details: `новый порядок блюд в «${req.category.name}» (${applied})`, ip: req.ip,
        });
      }
      res.json({ ok: true, applied });
    } catch (err) {
      if (err instanceof svc.ValidationError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // --- Архивирование НЕПУСТОЙ категории: два варианта ---
  router.get('/:id/menu/categories/:categoryId/archive-options', async (req, res, next) => {
    try {
      const menu = await menuSvc.listMenu(req.restaurant.id);
      const current = menu.find((c) => c.id === req.category.id);
      const itemsCount = current ? current.items.filter((i) => !i.archived_at).length : 0;
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'menu', csrfToken, req,
        tabBody: menuViews.renderCategoryArchiveOptions({
          restaurant: req.restaurant, category: req.category, itemsCount,
          otherCategories: menu.filter((c) => !c.archived_at && c.id !== req.category.id),
          csrfToken, linkBasePath, error: req.query.error,
        }),
      });
      res.send(layout({ title: `Архивирование категории — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/menu/categories/:categoryId/archive-with-items', requireCsrf, async (req, res, next) => {
    try {
      const archived = await menuSvc.archiveCategoryWithItems(req.restaurant.id, req.category.id);
      if (archived) {
        await logAuditEvent({
          action: 'category_archived', restaurantId: req.restaurant.id,
          details: `name: "${archived.name}" (вместе с блюдами)`, ip: req.ip,
        });
        await autoCloseIfNoAvailableDishes(req.restaurant, req.ip);
      }
      menuActionRedirect(res, req.restaurant.id, { notice: 'Категория архивирована вместе с блюдами.' });
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/menu/categories/${req.category.id}/archive-options?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  router.post('/:id/menu/categories/:categoryId/move-items-archive', requireCsrf, async (req, res, next) => {
    try {
      const result = await menuSvc.moveItemsAndArchiveCategory(
        req.restaurant.id, req.category.id, req.body.target_category_id,
      );
      if (result) {
        await logAuditEvent({
          action: 'category_archived', restaurantId: req.restaurant.id,
          details: `name: "${req.category.name}" (блюда перенесены в "${result.targetCategory.name}": ${result.movedCount})`,
          ip: req.ip,
        });
      }
      menuActionRedirect(res, req.restaurant.id, { notice: `Блюда перенесены (${result ? result.movedCount : 0}), категория архивирована.` });
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/menu/categories/${req.category.id}/archive-options?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  router.post('/:id/menu/categories', requireCsrf, async (req, res, next) => {
    try {
      const category = await menuSvc.createCategory(req.restaurant.id, req.body);
      await logAuditEvent({
        action: 'category_created', restaurantId: req.restaurant.id,
        details: `name: "${category.name}"`, ip: req.ip,
      });
      menuActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
      }
      next(err);
    }
  });

  router.get('/:id/menu/categories/:categoryId/edit', (req, res) => {
    const csrfToken = ensureCsrfToken(req);
    const body = menuViews.renderCategoryEditForm({
      restaurant: req.restaurant, category: req.category, csrfToken, linkBasePath,
    });
    res.send(layout({ title: `Категория — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
  });

  router.post('/:id/menu/categories/:categoryId', requireCsrf, async (req, res, next) => {
    try {
      const before = req.category;
      const updated = await menuSvc.updateCategory(req.restaurant.id, req.category.id, req.body);
      const details = summarizeCategoryDiff(before, updated);
      await logAuditEvent({ action: 'category_updated', restaurantId: req.restaurant.id, details, ip: req.ip });
      menuActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const body = menuViews.renderCategoryEditForm({
          restaurant: req.restaurant, category: { ...req.category, name: req.body.name }, error: err.message, csrfToken, linkBasePath,
        });
        return res.status(400).send(layout({ title: `Категория — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  router.post('/:id/menu/categories/:categoryId/archive', requireCsrf, async (req, res, next) => {
    try {
      const archived = await menuSvc.archiveCategory(req.restaurant.id, req.category.id);
      if (archived) {
        await logAuditEvent({
          action: 'category_archived', restaurantId: req.restaurant.id,
          details: `name: "${archived.name}"`, ip: req.ip,
        });
      }
      menuActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
      }
      next(err);
    }
  });

  // Stage 25 — закрытие Stage 24 MEDIUM-1: владелец явно выбирает
  // restore_items=1 ("восстановить категорию и блюда") или ничего
  // ("только категория") на странице архива (menuViews.renderMenuArchive
  // рисует ДВЕ отдельные кнопки, когда есть связанные архивированные блюда).
  // Блюда, заархивированные независимо ДО архивирования категории, этой
  // опцией не восстанавливаются никогда — см. комментарий в restoreCategory.
  router.post('/:id/menu/categories/:categoryId/restore', requireCsrf, async (req, res, next) => {
    try {
      const restoreLinkedItems = req.body.restore_items === '1';
      const result = await menuSvc.restoreCategory(req.restaurant.id, req.category.id, { restoreLinkedItems });
      if (result && result.category) {
        await logAuditEvent({
          action: 'category_restored', restaurantId: req.restaurant.id,
          details: `name: "${result.category.name}"${result.restoredItemsCount ? `, блюд восстановлено вместе с категорией: ${result.restoredItemsCount}` : ''}`,
          ip: req.ip,
        });
      }
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/menu/archive`);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/menu/archive?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  // moveCategory/moveMenuItem (кнопки «Выше»/«Ниже») удалены —
  // docs/HQ-PRODUCT-SPEC.md запрещает их, порядок меняется перетаскиванием
  // через /reorder-categories и /reorder-items выше. Сами сервисные функции
  // moveCategory()/moveMenuItem() оставлены нетронутыми: они по-прежнему
  // покрыты тестами Stage 5A и не мешают, но HTTP-поверхности у них больше
  // нет.

  // ?category=N — блюдо создаётся ВНУТРИ выбранной категории (спецификация:
  // глобальной кнопки «Добавить блюдо» в меню больше нет), поэтому нужная
  // категория уже выбрана в форме.
  router.get('/:id/menu/items/new', async (req, res, next) => {
    try {
      const menu = await menuSvc.listMenu(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = menuViews.renderMenuItemForm({
        restaurant: req.restaurant, item: null, categories: menu, csrfToken, linkBasePath, isNew: true,
        presetCategoryId: req.query.category || null,
      });
      res.send(layout({ title: `Новое блюдо — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/menu/items', requireCsrf, async (req, res, next) => {
    try {
      const item = await menuSvc.createMenuItem(req.restaurant.id, req.body);
      await logAuditEvent({
        action: 'menu_item_created', restaurantId: req.restaurant.id,
        details: `name: "${item.name}", price: ${item.price}`, ip: req.ip,
      });
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/menu`);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        const menu = await menuSvc.listMenu(req.restaurant.id);
        const csrfToken = ensureCsrfToken(req);
        const body = menuViews.renderMenuItemForm({
          restaurant: req.restaurant,
          item: { ...req.body, category_id: Number.parseInt(req.body.category_id, 10) || null },
          categories: menu, error: err.message, csrfToken, linkBasePath, isNew: true,
        });
        return res.status(400).send(layout({ title: `Новое блюдо — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  router.get('/:id/menu/items/:itemId', async (req, res, next) => {
    try {
      const menu = await menuSvc.listMenu(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const photoData = await menuItemPhotoViewData(req.restaurant.id, req.menuItem.id);
      const body = menuViews.renderMenuItemForm({
        restaurant: req.restaurant, item: req.menuItem, categories: menu, csrfToken, linkBasePath, isNew: false,
        error: req.query.error, ...photoData,
      });
      res.send(layout({ title: `${req.menuItem.name} — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/menu/items/:itemId', requireCsrf, async (req, res, next) => {
    try {
      const before = req.menuItem;
      const updated = await menuSvc.updateMenuItem(req.restaurant.id, req.menuItem.id, req.body);
      const details = summarizeMenuItemDiff(before, updated);
      await logAuditEvent({ action: 'menu_item_updated', restaurantId: req.restaurant.id, details, ip: req.ip });
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/menu`);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        const menu = await menuSvc.listMenu(req.restaurant.id);
        const csrfToken = ensureCsrfToken(req);
        const photoData = await menuItemPhotoViewData(req.restaurant.id, req.menuItem.id);
        const body = menuViews.renderMenuItemForm({
          restaurant: req.restaurant,
          item: { ...req.menuItem, ...req.body, id: req.menuItem.id, category_id: Number.parseInt(req.body.category_id, 10) || req.menuItem.category_id },
          categories: menu, error: err.message, csrfToken, linkBasePath, isNew: false, ...photoData,
        });
        return res.status(400).send(layout({ title: `${req.menuItem.name} — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  // --- Фотографии блюда (Stage 5B) ---

  router.param('dishPhotoId', async (req, res, next, dishPhotoId) => {
    try {
      const photo = await photoService.getMenuItemPhotoById(req.restaurant.id, req.menuItem.id, dishPhotoId);
      if (!photo) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'restaurants', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      req.dishPhoto = photo;
      next();
    } catch (err) {
      next(err);
    }
  });

  function dishPhotoActionRedirect(res, restaurantId, itemId, extra) {
    const qs = extra ? `?${new URLSearchParams(extra).toString()}` : '';
    res.redirect(`${linkBasePath}/restaurants/${restaurantId}/menu/items/${itemId}${qs}`);
  }

  router.post(
    '/:id/menu/items/:itemId/photos',
    photoUpload.single('photo'),
    (err, req, res, next) => {
      if (!err) return next();
      dishPhotoActionRedirect(res, req.params.id, req.params.itemId, { error: 'Не удалось загрузить файл — слишком большой или повреждён.' });
    },
    requireCsrf,
    async (req, res, next) => {
      try {
        if (!mediaProvider) throw new svc.ValidationError('Хранилище фотографий не настроено.');
        if (!req.file) throw new svc.ValidationError('Выберите файл фотографии.');
        const photo = await photoService.uploadMenuItemPhoto(mediaProvider, req.restaurant.id, req.menuItem.id, req.file.buffer, req.body.alt_text);
        await logAuditEvent({
          action: 'menu_item_photo_uploaded', restaurantId: req.restaurant.id,
          details: summarizePhotoDetails(photo), ip: req.ip,
        });
        dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id);
      } catch (err) {
        if (err instanceof svc.ValidationError) {
          return dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id, { error: err.message });
        }
        next(err);
      }
    },
  );

  router.post('/:id/menu/items/:itemId/photos/:dishPhotoId/primary', requireCsrf, async (req, res, next) => {
    try {
      const updated = await photoService.setMenuItemPhotoPrimary(req.restaurant.id, req.menuItem.id, req.dishPhoto.id);
      if (updated) {
        await logAuditEvent({
          action: 'menu_item_photo_primary_changed', restaurantId: req.restaurant.id,
          details: summarizePhotoDetails(updated), ip: req.ip,
        });
      }
      dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) return dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id, { error: err.message });
      next(err);
    }
  });

  router.post('/:id/menu/items/:itemId/photos/:dishPhotoId/alt', requireCsrf, async (req, res, next) => {
    try {
      await photoService.updateMenuItemPhotoAlt(req.restaurant.id, req.menuItem.id, req.dishPhoto.id, req.body.alt_text);
      dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) return dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id, { error: err.message });
      next(err);
    }
  });

  // Удаление — необратимо (Stage 5B.1), поэтому клиентская форма
  // (hq/photosViews.js) обязательно подтверждает через confirm().
  router.post('/:id/menu/items/:itemId/photos/:dishPhotoId/delete', requireCsrf, async (req, res, next) => {
    try {
      if (!mediaProvider) throw new svc.ValidationError('Хранилище фотографий не настроено.');
      const deleted = await photoService.deleteMenuItemPhoto(req.restaurant.id, req.menuItem.id, req.dishPhoto.id, mediaProvider);
      if (deleted) {
        await logAuditEvent({
          action: 'menu_item_photo_deleted', restaurantId: req.restaurant.id,
          details: summarizePhotoDetails(deleted), ip: req.ip,
        });
      }
      dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) return dishPhotoActionRedirect(res, req.restaurant.id, req.menuItem.id, { error: err.message });
      next(err);
    }
  });

  router.post('/:id/menu/items/:itemId/available', requireCsrf, async (req, res, next) => {
    try {
      const available = req.body.available === '1';
      const updated = await menuSvc.setMenuItemAvailability(req.restaurant.id, req.menuItem.id, available);
      if (updated) {
        await logAuditEvent({
          action: available ? 'menu_item_available' : 'menu_item_unavailable',
          restaurantId: req.restaurant.id, details: `name: "${updated.name}"`, ip: req.ip,
        });
      }
      let notice;
      if (!available) {
        const autoClosed = await autoCloseIfNoAvailableDishes(req.restaurant, req.ip);
        if (autoClosed) notice = 'Ресторан закрыт: в меню нет доступных блюд.';
      }
      menuActionRedirect(res, req.restaurant.id, notice ? { notice } : undefined);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
      }
      next(err);
    }
  });

  router.post('/:id/menu/items/:itemId/archive', requireCsrf, async (req, res, next) => {
    try {
      const archived = await menuSvc.archiveMenuItem(req.restaurant.id, req.menuItem.id);
      let notice;
      if (archived) {
        await logAuditEvent({
          action: 'menu_item_archived', restaurantId: req.restaurant.id,
          details: `name: "${archived.name}"`, ip: req.ip,
        });
        const autoClosed = await autoCloseIfNoAvailableDishes(req.restaurant, req.ip);
        if (autoClosed) notice = 'Ресторан закрыт: в меню нет доступных блюд.';
      }
      menuActionRedirect(res, req.restaurant.id, notice ? { notice } : undefined);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
      }
      next(err);
    }
  });

  // Восстановление из архива (спецификация: «возвращать блюдо в прежнюю
  // категорию; если прежней категории больше нет, предложить выбрать
  // другую») — target_category_id приходит из селектора на экране архива
  // только когда прежняя категория архивирована.
  router.post('/:id/menu/items/:itemId/restore', requireCsrf, async (req, res, next) => {
    const archiveUrl = `${linkBasePath}/restaurants/${req.restaurant.id}/menu/archive`;
    try {
      const restored = await menuSvc.restoreMenuItemToCategory(
        req.restaurant.id, req.menuItem.id, req.body.target_category_id || null,
      );
      if (restored) {
        await logAuditEvent({
          action: 'menu_item_restored', restaurantId: req.restaurant.id,
          details: `name: "${restored.name}"`, ip: req.ip,
        });
      }
      res.redirect(archiveUrl);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return res.redirect(`${archiveUrl}?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  router.post('/:id/menu/items/:itemId/move-category', requireCsrf, async (req, res, next) => {
    try {
      await menuSvc.moveMenuItemToCategory(req.restaurant.id, req.menuItem.id, req.body.category_id);
      await logAuditEvent({
        action: 'menu_item_moved', restaurantId: req.restaurant.id,
        details: `name: "${req.menuItem.name}", moved to category_id: ${req.body.category_id}`, ip: req.ip,
      });
      menuActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
      }
      next(err);
    }
  });

  // --- Заказы ---
  router.get('/:id/orders', async (req, res, next) => {
    try {
      // docs/HQ-PRODUCT-SPEC.md: на вкладке остался только фильтр по датам —
      // status/filter/code больше не читаются из query.
      const filters = { from: req.query.from, to: req.query.to };
      const result = await statsService.listRestaurantOrders(req.restaurant.id, { ...filters, page: req.query.page });
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'orders', csrfToken, req,
        tabBody: views.renderOrdersTab({ restaurant: req.restaurant, ...result, filters, linkBasePath }),
      });
      res.send(layout({ title: `Заказы — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/orders/:orderId', async (req, res, next) => {
    try {
      const detail = await statsService.getOrderDetail(req.restaurant.id, req.params.orderId);
      const csrfToken = ensureCsrfToken(req);
      if (!detail) {
        return res.status(404).send(layout({
          title: 'Заказ не найден', active: 'restaurants', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      // no-store уже глобален (hqSecurityHeaders), но эта страница
      // единственная во всём HQ, где реально показываются PII клиента
      // (имя/телефон/адрес/комментарий) — напоминание явно продублировано в
      // заголовке ответа, не полагается только на общий middleware молча.
      res.set('Cache-Control', 'no-store');
      const body = views.renderOrderDetail({ restaurant: req.restaurant, detail, linkBasePath });
      res.send(layout({ title: `Заказ ${detail.order.public_code}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // --- Оценки ---
  router.get('/:id/ratings', async (req, res, next) => {
    try {
      const distribution = await statsService.getRatingsDistribution(req.restaurant.id);
      const ratingsResult = await statsService.listRestaurantRatings(req.restaurant.id, { page: req.query.page });
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'ratings', csrfToken, req,
        tabBody: views.renderRatingsTab({ restaurant: req.restaurant, distribution, ...ratingsResult, linkBasePath }),
      });
      res.send(layout({ title: `Оценки — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // --- Статистика ---
  router.get('/:id/statistics', async (req, res, next) => {
    const periodOptions = { period: req.query.period, from: req.query.from, to: req.query.to };
    try {
      let statistics;
      let periodError = null;
      try {
        statistics = await statsService.getStatistics(req.restaurant.id, periodOptions);
      } catch (err) {
        if (!(err instanceof svc.ValidationError)) throw err;
        periodError = err.message;
        periodOptions.period = 'today';
        statistics = await statsService.getStatistics(req.restaurant.id, { period: 'today' });
      }
      // Финансовый блок со «Статистики» удалён (docs/HQ-PRODUCT-SPEC.md:
      // дублирование «Обзора» и «Финансов» запрещено) — вместе с ним исчез и
      // запрос getRestaurantFinancialPosition() на этой странице.
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'statistics', csrfToken, req,
        tabBody: views.renderStatisticsTab({ restaurant: req.restaurant, statistics, periodOptions, linkBasePath, error: periodError }),
      });
      res.send(layout({ title: `Статистика — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // --- Настройки ---
  router.get('/:id/settings', async (req, res, next) => {
    try {
      const csrfToken = ensureCsrfToken(req);
      const photoData = await restaurantPhotoViewData(req.restaurant.id);
      const financeData = await restaurantFinanceViewData(req.restaurant.id);
      const telegram = await telegramLinkService.getLinkState(req.restaurant.id);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'settings', csrfToken, req,
        tabBody: views.renderRestaurantSettingsTab({
          restaurant: req.restaurant, linkBasePath, csrfToken, telegram,
          error: req.query.error, notice: req.query.notice, ...photoData, ...financeData,
        }),
      });
      res.send(layout({ title: `Настройки — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/settings', requireCsrf, async (req, res, next) => {
    try {
      const before = req.restaurant;
      const updated = await svc.updateRestaurant(req.restaurant.id, req.body);
      const details = summarizeRestaurantDiff(before, updated);
      await logAuditEvent({ action: 'restaurant_updated', restaurantId: updated.id, details, ip: req.ip });
      const csrfToken = ensureCsrfToken(req);
      const photoData = await restaurantPhotoViewData(updated.id);
      const financeData = await restaurantFinanceViewData(updated.id);
      const telegram = await telegramLinkService.getLinkState(updated.id);
      const body = await pageShell({
        restaurant: updated, active: 'settings', csrfToken, req,
        tabBody: views.renderRestaurantSettingsTab({ restaurant: updated, linkBasePath, csrfToken, telegram, notice: 'Изменения сохранены.', ...photoData, ...financeData }),
      });
      res.send(layout({ title: `Настройки — ${updated.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        // Не меняет данные (updateRestaurant валидирует ДО UPDATE) —
        // показывает то, что владелец реально ввёл, а не то, что осталось в
        // БД, чтобы правки не терялись при ошибке (задание, раздел 4/10).
        const attempted = {
          ...req.restaurant,
          name: req.body.name,
          cuisine: req.body.cuisine,
          description: req.body.description,
          cities: JSON.stringify(String(req.body.cities || '').split(',').map((c) => c.trim()).filter(Boolean)),
          address: req.body.address,
          hours: req.body.hours,
          phone: req.body.phone,
          min_order: req.body.min_order,
        };
        const csrfToken = ensureCsrfToken(req);
        const photoData = await restaurantPhotoViewData(req.restaurant.id);
        const financeData = await restaurantFinanceViewData(req.restaurant.id);
        const body = await pageShell({
          restaurant: attempted, active: 'settings', csrfToken, req,
          tabBody: views.renderRestaurantSettingsTab({ restaurant: attempted, linkBasePath, csrfToken, error: err.message, ...photoData, ...financeData }),
        });
        return res.status(400).send(layout({ title: `Настройки — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  // --- Юридические данные (Stage 6) ---

  // --- Telegram-подключение (docs/HQ-PRODUCT-SPEC.md) ---
  // HQ только ВЫДАЁТ/гасит одноразовый код; сама привязка чата происходит в
  // Telegram-группе (bot/postgresql/index.js: /start КОД) — chat_id известен
  // только Telegram-стороне.
  function telegramRedirect(res, restaurantId, extra) {
    const qs = extra ? `?${new URLSearchParams(extra).toString()}` : '';
    res.redirect(`${linkBasePath}/restaurants/${restaurantId}/settings${qs}`);
  }

  router.post('/:id/telegram/new-code', requireCsrf, async (req, res, next) => {
    try {
      await telegramLinkService.issueConnectCode(req.restaurant.id);
      telegramRedirect(res, req.restaurant.id, { notice: 'Код подключения выпущен. Отправьте его в рабочей группе ресторана.' });
    } catch (err) {
      if (err instanceof svc.ValidationError) return telegramRedirect(res, req.restaurant.id, { error: err.message });
      next(err);
    }
  });

  router.post('/:id/telegram/reconnect', requireCsrf, async (req, res, next) => {
    try {
      await telegramLinkService.reconnect(req.restaurant.id);
      telegramRedirect(res, req.restaurant.id, { notice: 'Группа отвязана, выпущен новый код подключения.' });
    } catch (err) {
      if (err instanceof svc.ValidationError) return telegramRedirect(res, req.restaurant.id, { error: err.message });
      next(err);
    }
  });

  router.post('/:id/telegram/disconnect', requireCsrf, async (req, res, next) => {
    try {
      await telegramLinkService.disconnect(req.restaurant.id);
      telegramRedirect(res, req.restaurant.id, { notice: 'Telegram отключён. Ресторан не будет получать заказы, пока не подключится снова.' });
    } catch (err) {
      next(err);
    }
  });

  // «Отправить тест» — реальная отправка сообщения в привязанную группу
  // через уже работающего бота. Бот доступен HQ только если он запущен на
  // этом процессе (botHandlers прокидывается из services/postgresql/app.js);
  // если нет — владельцу честно сообщается, что тест недоступен, а не
  // рисуется ложный успех.
  router.post('/:id/telegram/test', requireCsrf, async (req, res, next) => {
    try {
      const state = await telegramLinkService.getLinkState(req.restaurant.id);
      if (!state || !state.connected) {
        return telegramRedirect(res, req.restaurant.id, { error: 'Telegram не подключён.' });
      }
      const bot = req.app.get('yaamTelegramBot');
      if (!bot || typeof bot.sendMessage !== 'function') {
        return telegramRedirect(res, req.restaurant.id, { error: 'Telegram-бот сейчас не запущен на этом сервере — тест отправить нельзя.' });
      }
      await bot.sendMessage(state.chatId, 'Проверка связи YAAM. Эта группа подключена и получает заказы.');
      telegramRedirect(res, req.restaurant.id, { notice: 'Тестовое сообщение отправлено в группу.' });
    } catch (err) {
      return telegramRedirect(res, req.restaurant.id, { error: `Не удалось отправить сообщение: ${err.message}` });
    }
  });

  router.get('/:id/legal-details/edit', async (req, res, next) => {
    try {
      const legal = await legalService.getLegalDetails(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = financeViews.renderLegalDetailsEditForm({ restaurant: req.restaurant, legal, linkBasePath, csrfToken });
      res.send(layout({ title: `Юридические данные — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/legal-details', requireCsrf, async (req, res, next) => {
    try {
      const { record, created, before } = await legalService.saveLegalDetails(req.restaurant.id, req.body);
      const action = created ? 'restaurant_legal_details_created' : 'restaurant_legal_details_updated';
      const details = created ? null : summarizeLegalDetailsDiff(before, record);
      await logAuditEvent({ action, restaurantId: req.restaurant.id, details, ip: req.ip });
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings?notice=${encodeURIComponent('Юридические данные сохранены.')}`);
    } catch (err) {
      if (err instanceof legalService.ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const body = financeViews.renderLegalDetailsEditForm({ restaurant: req.restaurant, legal: req.body, linkBasePath, csrfToken, error: err.message });
        return res.status(400).send(layout({ title: `Юридические данные — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  // --- Банковские реквизиты (Stage 6) ---

  router.get('/:id/bank-details/edit', async (req, res, next) => {
    try {
      const bank = await bankService.getBankDetails(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = financeViews.renderBankDetailsEditForm({ restaurant: req.restaurant, bank, linkBasePath, csrfToken });
      res.send(layout({ title: `Банковские реквизиты — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/bank-details', requireCsrf, async (req, res, next) => {
    try {
      const { record, created, before } = await bankService.saveBankDetails(req.restaurant.id, req.body);
      const action = created ? 'restaurant_bank_details_created' : 'restaurant_bank_details_updated';
      const details = created ? null : summarizeBankDetailsDiff(before, record);
      await logAuditEvent({ action, restaurantId: req.restaurant.id, details, ip: req.ip });
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings?notice=${encodeURIComponent('Банковские реквизиты сохранены.')}`);
    } catch (err) {
      if (err instanceof bankService.ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const body = financeViews.renderBankDetailsEditForm({ restaurant: req.restaurant, bank: req.body, linkBasePath, csrfToken, error: err.message });
        return res.status(400).send(layout({ title: `Банковские реквизиты — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  // --- Договор с YAAM (Stage 6) ---

  router.get('/:id/contract/edit', async (req, res, next) => {
    try {
      const contract = await contractService.getContract(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = financeViews.renderContractEditForm({ restaurant: req.restaurant, contract, linkBasePath, csrfToken });
      res.send(layout({ title: `Договор с YAAM — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/contract', requireCsrf, async (req, res, next) => {
    try {
      const { record, created, before } = await contractService.saveContract(req.restaurant.id, req.body);
      if (created) {
        await logAuditEvent({ action: 'restaurant_contract_created', restaurantId: req.restaurant.id, details: null, ip: req.ip });
      } else {
        // Смена статуса — ВСЕГДА отдельное событие (задание, раздел 10:
        // "можно: старый/новый статус договора"), даже если в том же
        // сохранении поменялись и другие поля — оба события пишутся,
        // ничего не теряется и не смешивается в одной строке лога.
        if (before.status !== record.status) {
          await logAuditEvent({
            action: 'restaurant_contract_status_changed', restaurantId: req.restaurant.id,
            details: summarizeContractStatusChange(before, record), ip: req.ip,
          });
        }
        const otherFieldsDetails = summarizeContractDiff(before, record);
        if (otherFieldsDetails) {
          await logAuditEvent({ action: 'restaurant_contract_updated', restaurantId: req.restaurant.id, details: otherFieldsDetails, ip: req.ip });
        }
      }
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings?notice=${encodeURIComponent('Договор сохранён.')}`);
    } catch (err) {
      if (err instanceof contractService.ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const body = financeViews.renderContractEditForm({ restaurant: req.restaurant, contract: req.body, linkBasePath, csrfToken, error: err.message });
        return res.status(400).send(layout({ title: `Договор с YAAM — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  // --- Фотографии ресторана (Stage 5B) ---

  router.param('photoId', async (req, res, next, photoId) => {
    try {
      const photo = await photoService.getRestaurantPhotoById(req.restaurant.id, photoId);
      if (!photo) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'restaurants', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      req.photo = photo;
      next();
    } catch (err) {
      next(err);
    }
  });

  function photoActionRedirect(res, restaurantId, extra) {
    const qs = extra ? `?${new URLSearchParams(extra).toString()}` : '';
    res.redirect(`${linkBasePath}/restaurants/${restaurantId}/settings${qs}`);
  }

  router.post(
    '/:id/photos',
    photoUpload.single('photo'),
    // Multer сигнализирует об ошибке (файл больше лимита, лишнее поле и
    // т.п.) через next(err) — Express находит следующий error-handling
    // middleware (arity 4) в ЭТОЙ ЖЕ цепочке роута, до requireCsrf/основного
    // обработчика (задание, раздел 5/11: понятная ошибка, не сырой 500).
    (err, req, res, next) => {
      if (!err) return next();
      photoActionRedirect(res, req.params.id, { error: 'Не удалось загрузить файл — слишком большой или повреждён.' });
    },
    requireCsrf,
    async (req, res, next) => {
      try {
        if (!mediaProvider) throw new svc.ValidationError('Хранилище фотографий не настроено.');
        if (!req.file) throw new svc.ValidationError('Выберите файл фотографии.');
        const photo = await photoService.uploadRestaurantPhoto(mediaProvider, req.restaurant.id, req.file.buffer, req.body.alt_text);
        await logAuditEvent({
          action: 'restaurant_photo_uploaded', restaurantId: req.restaurant.id,
          details: summarizePhotoDetails(photo), ip: req.ip,
        });
        photoActionRedirect(res, req.restaurant.id);
      } catch (err) {
        if (err instanceof svc.ValidationError) {
          return photoActionRedirect(res, req.restaurant.id, { error: err.message });
        }
        next(err);
      }
    },
  );

  router.post('/:id/photos/:photoId/primary', requireCsrf, async (req, res, next) => {
    try {
      const updated = await photoService.setRestaurantPhotoPrimary(req.restaurant.id, req.photo.id);
      if (updated) {
        await logAuditEvent({
          action: 'restaurant_photo_primary_changed', restaurantId: req.restaurant.id,
          details: summarizePhotoDetails(updated), ip: req.ip,
        });
      }
      photoActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) return photoActionRedirect(res, req.restaurant.id, { error: err.message });
      next(err);
    }
  });

  router.post('/:id/photos/:photoId/alt', requireCsrf, async (req, res, next) => {
    try {
      // Правка описания — не входит в закрытый список audit-событий,
      // поэтому не логируется.
      await photoService.updateRestaurantPhotoAlt(req.restaurant.id, req.photo.id, req.body.alt_text);
      photoActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) return photoActionRedirect(res, req.restaurant.id, { error: err.message });
      next(err);
    }
  });

  // Удаление — необратимо (Stage 5B.1), поэтому клиентская форма
  // (hq/photosViews.js) обязательно подтверждает через confirm().
  router.post('/:id/photos/:photoId/delete', requireCsrf, async (req, res, next) => {
    try {
      if (!mediaProvider) throw new svc.ValidationError('Хранилище фотографий не настроено.');
      const deleted = await photoService.deleteRestaurantPhoto(req.restaurant.id, req.photo.id, mediaProvider);
      if (deleted) {
        await logAuditEvent({
          action: 'restaurant_photo_deleted', restaurantId: req.restaurant.id,
          details: summarizePhotoDetails(deleted), ip: req.ip,
        });
      }
      photoActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) return photoActionRedirect(res, req.restaurant.id, { error: err.message });
      next(err);
    }
  });

  // --- Публикация / снятие с публикации (Stage 4.1) ---
  router.post('/:id/publish', requireCsrf, handleLifecycleAction(async (req) => {
    await svc.publishRestaurant(req.restaurant.id);
    await logAuditEvent({
      action: 'restaurant_published', restaurantId: req.restaurant.id,
      details: 'publication: draft -> published', ip: req.ip,
    });
  }));

  router.post('/:id/unpublish', requireCsrf, handleLifecycleAction(async (req) => {
    await svc.unpublishRestaurant(req.restaurant.id);
    await logAuditEvent({
      action: 'restaurant_unpublished', restaurantId: req.restaurant.id,
      details: 'publication: published -> draft', ip: req.ip,
    });
  }));

  // --- Открытие / закрытие — вручную, отдельно от паузы (Stage 4.1) ---
  router.post('/:id/open', requireCsrf, handleLifecycleAction(async (req) => {
    await svc.openRestaurant(req.restaurant.id);
    await logAuditEvent({ action: 'restaurant_updated', restaurantId: req.restaurant.id, details: 'is_open: 0 -> 1', ip: req.ip });
  }));

  router.post('/:id/close', requireCsrf, handleLifecycleAction(async (req) => {
    await svc.closeRestaurant(req.restaurant.id);
    await logAuditEvent({ action: 'restaurant_updated', restaurantId: req.restaurant.id, details: 'is_open: 1 -> 0', ip: req.ip });
  }));

  // --- Пауза (Stage 5A.1) ---
  // Временная пауза (33 мин/3 часа/11 часов) НЕ управляется из HQ — это
  // исключительно функция ресторана через Telegram (server/bot/postgresql/
  // index.js: /pause, /open, оба вызывают services/postgresql/orderService.js
  // напрямую, минуя HQ вовсе). HQ только ЧИТАЕТ и показывает статус
  // ("Пауза до HH:MM" — hq/restaurantsViews.js:statusBadge, не тронуто) —
  // здесь намеренно нет ни /pause, ни /resume маршрутов: HQ — инструмент
  // владельца YAAM, Telegram-бот — инструмент ресторана, роли не смешиваются.
  // services/hq/restaurantAdminService.js:pauseRestaurant/resumeRestaurant
  // (guarded-обёртки над orderService для HQ) намеренно ОСТАВЛЕНЫ в коде,
  // хотя теперь не вызываются ни отсюда, ни ботом — бизнес-логика/lifecycle
  // этим этапом не менялась, удалены только HQ-действия.

  router.post('/:id/archive', requireCsrf, async (req, res, next) => {
    try {
      const archived = await svc.archiveRestaurant(req.restaurant.id);
      if (archived) {
        await logAuditEvent({ action: 'restaurant_archived', restaurantId: req.restaurant.id, ip: req.ip });
      }
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings`);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  router.post('/:id/restore', requireCsrf, async (req, res, next) => {
    try {
      const restored = await svc.restoreRestaurant(req.restaurant.id);
      if (restored) {
        await logAuditEvent({ action: 'restaurant_restored', restaurantId: req.restaurant.id, ip: req.ip });
      }
      res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings`);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return res.redirect(`${linkBasePath}/restaurants/${req.restaurant.id}/settings?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createRestaurantsRouter };
