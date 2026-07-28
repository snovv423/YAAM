'use strict';

// YAAM HQ Stage 8 — расчётные периоды. Смонтирован в routes/hq/index.js под
// '/finance/settlements' (внутри уже защищённой /hq зоны — requireHqAuth
// применяется в точке монтирования, тот же принцип, что и /restaurants,
// см. index.js).
const express = require('express');
const settlementService = require('../../services/hq/settlementService');
const { ValidationError } = require('../../services/hq/restaurantLifecycle');
const { logAuditEvent } = require('../../services/hq/auditLog');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { layout } = require('../../hq/layout');
const views = require('../../hq/settlementViews');

function notFoundBody(linkBasePath) {
  return `<h1>Расчётный период не найден</h1><div class="panel"><div class="empty-state">Проверьте адрес или вернитесь к списку.</div></div><a class="btn ghost" href="${linkBasePath}/finance">← К финансам</a>`;
}

// Короткий, человекочитаемый summary для hq_audit_log.details (задание,
// раздел 13: "period id; диапазон; количество ресторанов; общие суммы") —
// без банковских реквизитов (задание: "не логировать банковские реквизиты"),
// без per-restaurant детализации — тот же allowlist-принцип, что и
// services/hq/auditLog.js SAFE_DIFF_FIELDS, применённый к другой форме данных.
function summarizeSettlementPeriod(period, lines) {
  const totals = lines.reduce((acc, l) => ({
    turnover: acc.turnover + Number(l.turnover),
    commission: acc.commission + Number(l.yaam_commission),
    earnings: acc.earnings + Number(l.restaurant_earnings),
  }), { turnover: 0, commission: 0, earnings: 0 });
  return `period_id=${period.id}; диапазон ${period.period_from}..${period.period_to}; `
    + `ресторанов=${lines.length}; оборот=${totals.turnover}; комиссия=${totals.commission}; сумма_ресторанов=${totals.earnings}`;
}

function createSettlementsRouter({ linkBasePath }) {
  const router = express.Router();

  router.param('id', async (req, res, next, id) => {
    try {
      const period = await settlementService.getSettlementPeriodById(id);
      if (!period) {
        const csrfToken = ensureCsrfToken(req);
        return res.status(404).send(layout({
          title: 'Не найдено', active: 'finance', csrfToken, linkBasePath, body: notFoundBody(linkBasePath),
        }));
      }
      req.settlementPeriod = period;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get('/new', (req, res) => {
    const csrfToken = ensureCsrfToken(req);
    const body = views.renderSettlementPeriodCreateForm({ linkBasePath, csrfToken });
    res.send(layout({ title: 'Новый расчётный период', active: 'finance', csrfToken, linkBasePath, body }));
  });

  router.post('/', requireCsrf, async (req, res, next) => {
    try {
      const createdBy = (req.session && req.session.hqUser) || '';
      const period = await settlementService.createDraftSettlementPeriod({
        periodFrom: req.body.period_from,
        periodTo: req.body.period_to,
        notes: req.body.notes,
        createdBy,
      });
      await logAuditEvent({
        action: 'settlement_period_created', restaurantId: null,
        details: `period_id=${period.id}; диапазон ${period.period_from}..${period.period_to}`,
        ip: req.ip,
      });
      res.redirect(`${linkBasePath}/finance/settlements/${period.id}`);
    } catch (err) {
      if (err instanceof ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const body = views.renderSettlementPeriodCreateForm({ linkBasePath, csrfToken, error: err.message, values: req.body });
        return res.status(400).send(layout({ title: 'Новый расчётный период', active: 'finance', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const detail = await settlementService.getSettlementPeriodDetail(req.settlementPeriod.id);
      const csrfToken = ensureCsrfToken(req);
      const body = views.renderSettlementPeriodDetail({
        period: detail.period, lines: detail.lines, preview: detail.preview, linkBasePath, csrfToken,
      });
      res.send(layout({ title: 'Расчётный период', active: 'finance', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/close', requireCsrf, async (req, res, next) => {
    try {
      const result = await settlementService.closeSettlementPeriod(req.settlementPeriod.id);
      if (!result.alreadyClosed) {
        await logAuditEvent({
          action: 'settlement_period_closed', restaurantId: null,
          details: summarizeSettlementPeriod(result.period, result.lines),
          ip: req.ip,
        });
      }
      res.redirect(`${linkBasePath}/finance/settlements/${req.settlementPeriod.id}`);
    } catch (err) {
      if (err instanceof ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const detail = await settlementService.getSettlementPeriodDetail(req.settlementPeriod.id);
        const body = views.renderSettlementPeriodDetail({
          period: detail.period, lines: detail.lines, preview: detail.preview, linkBasePath, csrfToken,
        });
        return res.status(400).send(layout({ title: 'Расчётный период', active: 'finance', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  router.post('/:id/delete', requireCsrf, async (req, res, next) => {
    try {
      const deleted = await settlementService.deleteDraftSettlementPeriod(req.settlementPeriod.id);
      await logAuditEvent({
        action: 'settlement_period_draft_deleted', restaurantId: null,
        details: `period_id=${deleted.id}; диапазон ${deleted.period_from}..${deleted.period_to}`,
        ip: req.ip,
      });
      res.redirect(`${linkBasePath}/finance`);
    } catch (err) {
      if (err instanceof ValidationError) {
        const csrfToken = ensureCsrfToken(req);
        const detail = await settlementService.getSettlementPeriodDetail(req.settlementPeriod.id);
        const body = views.renderSettlementPeriodDetail({
          period: detail.period, lines: detail.lines, preview: detail.preview, linkBasePath, csrfToken,
        });
        return res.status(400).send(layout({ title: 'Расчётный период', active: 'finance', csrfToken, linkBasePath, body }));
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createSettlementsRouter };
