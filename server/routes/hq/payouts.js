'use strict';

// YAAM HQ Stage 9 — раздел «Выплаты» (задание: "Пока Read Only"). Смонтирован
// в routes/hq/index.js под '/payouts' (внутри уже защищённой /hq зоны — тот
// же принцип, что и /restaurants и /finance/settlements).
//
// НАМЕРЕННО без единого POST-маршрута здесь: подготовка выплаты
// (prepareRestaurantPayout) вызывается со страницы КОНКРЕТНОГО расчётного
// периода (routes/hq/settlements.js), где естественно доступны и
// settlementPeriodId, и restaurantId одновременно — единственное write-
// действие Stage 9 во всём HQ (см. итоговый отчёт, раздел про UI-решения).
// createPayoutAttempt/markAttemptSubmitting/Processing/Unknown/Succeeded/
// Failed (Stage 9.5) НЕ подключены ни к одному HQ-маршруту вообще — они
// реальны и полностью протестированы, но появятся в UI только вместе с
// настоящей банковской интеграцией на следующем этапе (задание: "чтобы в
// следующем этапе осталось только подключить API банка"). GET /:id ниже —
// read-only, только читает уже существующие попытки через
// listAttemptsForPayout, ничего не создаёт и не меняет.
const express = require('express');
const payoutService = require('../../services/hq/payoutService');
const { ensureCsrfToken } = require('../../services/hq/csrf');
const { layout } = require('../../hq/layout');
const views = require('../../hq/payoutViews');

function notFoundBody(linkBasePath) {
  return `<h1>Выплата не найдена</h1><div class="panel"><div class="empty-state">Проверьте адрес или вернитесь к списку.</div></div><a class="btn ghost" href="${linkBasePath}/payouts">← К выплатам</a>`;
}

function createPayoutsRouter({ linkBasePath }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const payouts = await payoutService.listPayouts();
      const csrfToken = ensureCsrfToken(req);
      const body = views.renderPayoutsListPage({ payouts, linkBasePath });
      res.send(layout({ title: 'Выплаты', active: 'payouts', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const payout = await payoutService.getPayoutDetail(req.params.id);
      if (!payout) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'payouts', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      const attempts = await payoutService.listAttemptsForPayout(payout.id);
      const csrfToken = ensureCsrfToken(req);
      const body = views.renderPayoutDetail({ payout, attempts, linkBasePath });
      res.send(layout({ title: `Выплата #${payout.id}`, active: 'payouts', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPayoutsRouter };
