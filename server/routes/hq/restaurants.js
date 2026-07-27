'use strict';

// YAAM HQ Stage 4 — рабочий раздел «Рестораны». Смонтирован в routes/hq/
// index.js под '/restaurants' (внутри уже защищённой /hq зоны — requireHqAuth
// применяется в точке монтирования, не здесь, тем же принципом, что и
// createPagesRouter).
const express = require('express');
const svc = require('../../services/hq/restaurantAdminService');
const statsService = require('../../services/hq/restaurantStatsService');
const menuSvc = require('../../services/hq/menuAdminService');
const {
  logAuditEvent, summarizeRestaurantDiff, summarizeMenuItemDiff, summarizeCategoryDiff,
} = require('../../services/hq/auditLog');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { layout } = require('../../hq/layout');
const views = require('../../hq/restaurantsViews');
const menuViews = require('../../hq/menuViews');

function notFoundBody(linkBasePath) {
  return `<h1>Ресторан не найден</h1><div class="panel"><div class="empty-state">Проверьте адрес или вернитесь к списку.</div></div><a class="btn ghost" href="${linkBasePath}/restaurants">← К списку ресторанов</a>`;
}

function createRestaurantsRouter({ linkBasePath }) {
  const router = express.Router();

  // ---------------------------------------------------------------------
  // Список + создание
  // ---------------------------------------------------------------------

  router.get('/', async (req, res, next) => {
    try {
      const filters = { search: req.query.search, city: req.query.city, status: req.query.status, sort: req.query.sort };
      const result = await svc.listRestaurants({ ...filters, page: req.query.page });
      const csrfToken = ensureCsrfToken(req);
      res.send(layout({
        title: 'Рестораны',
        active: 'restaurants',
        csrfToken,
        linkBasePath,
        body: views.renderRestaurantsList({ ...result, filters, linkBasePath }),
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

  async function pageShell({ restaurant, active, csrfToken, tabBody, req }) {
    const menuItemsCount = active === 'overview' || active === 'settings' ? await svc.countMenuItems(restaurant.id) : 0;
    const banner = views.renderActionBanner({ error: req?.query?.error, notice: req?.query?.notice });
    return banner
      + views.renderRestaurantHeader({ restaurant, csrfToken, linkBasePath, menuItemsCount })
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
      const overview = await statsService.getOverview(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'overview', csrfToken, req,
        tabBody: views.renderOverviewTab({ restaurant: req.restaurant, overview, linkBasePath }),
      });
      res.send(layout({ title: req.restaurant.name, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // Polling JSON — тот же auth-периметр (requireHqAuth на точке монтирования
  // всего роутера), no-store уже выставлен глобально hqSecurityHeaders, CSRF
  // не требуется для GET (задание, раздел 12).
  router.get('/:id/overview.json', async (req, res, next) => {
    try {
      const overview = await statsService.getOverview(req.restaurant.id);
      res.json(overview);
    } catch (err) {
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

  router.get('/:id/menu', async (req, res, next) => {
    try {
      const menu = await menuSvc.listMenu(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = await pageShell({
        restaurant: req.restaurant, active: 'menu', csrfToken, req,
        tabBody: menuViews.renderMenuTab({
          restaurant: req.restaurant, menu, filter: req.query.filter, csrfToken, linkBasePath,
          error: req.query.error, notice: req.query.notice,
        }),
      });
      res.send(layout({ title: `Меню — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
    } catch (err) {
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

  router.post('/:id/menu/categories/:categoryId/restore', requireCsrf, async (req, res, next) => {
    try {
      const restored = await menuSvc.restoreCategory(req.restaurant.id, req.category.id);
      if (restored) {
        await logAuditEvent({
          action: 'category_restored', restaurantId: req.restaurant.id,
          details: `name: "${restored.name}"`, ip: req.ip,
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

  router.post('/:id/menu/categories/:categoryId/move', requireCsrf, async (req, res, next) => {
    try {
      await menuSvc.moveCategory(req.restaurant.id, req.category.id, req.body.direction === 'up' ? 'up' : 'down');
      await logAuditEvent({
        action: 'category_moved', restaurantId: req.restaurant.id,
        details: `name: "${req.category.name}", direction: ${req.body.direction}`, ip: req.ip,
      });
      menuActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
      }
      next(err);
    }
  });

  router.get('/:id/menu/items/new', async (req, res, next) => {
    try {
      const menu = await menuSvc.listMenu(req.restaurant.id);
      const csrfToken = ensureCsrfToken(req);
      const body = menuViews.renderMenuItemForm({
        restaurant: req.restaurant, item: null, categories: menu, csrfToken, linkBasePath, isNew: true,
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
      const body = menuViews.renderMenuItemForm({
        restaurant: req.restaurant, item: req.menuItem, categories: menu, csrfToken, linkBasePath, isNew: false,
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
        const body = menuViews.renderMenuItemForm({
          restaurant: req.restaurant,
          item: { ...req.menuItem, ...req.body, id: req.menuItem.id, category_id: Number.parseInt(req.body.category_id, 10) || req.menuItem.category_id },
          categories: menu, error: err.message, csrfToken, linkBasePath, isNew: false,
        });
        return res.status(400).send(layout({ title: `${req.menuItem.name} — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
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

  router.post('/:id/menu/items/:itemId/restore', requireCsrf, async (req, res, next) => {
    try {
      const restored = await menuSvc.restoreMenuItem(req.restaurant.id, req.menuItem.id);
      if (restored) {
        await logAuditEvent({
          action: 'menu_item_restored', restaurantId: req.restaurant.id,
          details: `name: "${restored.name}"`, ip: req.ip,
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

  router.post('/:id/menu/items/:itemId/move', requireCsrf, async (req, res, next) => {
    try {
      await menuSvc.moveMenuItem(req.restaurant.id, req.menuItem.id, req.body.direction === 'up' ? 'up' : 'down');
      await logAuditEvent({
        action: 'menu_item_moved', restaurantId: req.restaurant.id,
        details: `name: "${req.menuItem.name}", direction: ${req.body.direction}`, ip: req.ip,
      });
      menuActionRedirect(res, req.restaurant.id);
    } catch (err) {
      if (err instanceof svc.ValidationError) {
        return menuActionRedirect(res, req.restaurant.id, { error: err.message });
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
      const filters = {
        filter: req.query.filter, status: req.query.status, code: req.query.code,
        from: req.query.from, to: req.query.to,
      };
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
      const body = await pageShell({
        restaurant: req.restaurant, active: 'settings', csrfToken, req,
        tabBody: views.renderRestaurantSettingsTab({ restaurant: req.restaurant, linkBasePath, csrfToken }),
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
      const body = await pageShell({
        restaurant: updated, active: 'settings', csrfToken, req,
        tabBody: views.renderRestaurantSettingsTab({ restaurant: updated, linkBasePath, csrfToken, notice: 'Изменения сохранены.' }),
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
        const body = await pageShell({
          restaurant: attempted, active: 'settings', csrfToken, req,
          tabBody: views.renderRestaurantSettingsTab({ restaurant: attempted, linkBasePath, csrfToken, error: err.message }),
        });
        return res.status(400).send(layout({ title: `Настройки — ${req.restaurant.name}`, active: 'restaurants', csrfToken, linkBasePath, body }));
      }
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
