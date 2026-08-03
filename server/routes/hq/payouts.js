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
const { getTBankPayoutReadiness } = require('../../services/hq/tbankPayoutReadiness');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { logAuditEvent } = require('../../services/hq/auditLog');
const restaurantBankDetailsService = require('../../services/hq/restaurantBankDetailsService');
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
      const requisitesByAttemptId = new Map();
      for (const attempt of attempts) {
        const requisites = await payoutService.getAttemptRequisites(attempt.id);
        if (requisites) requisitesByAttemptId.set(attempt.id, requisites);
      }
      const readiness = await getTBankPayoutReadiness(payout.id);
      // Предпросмотр реквизитов ресторана ДЛЯ ФОРМЫ подтверждения — только
      // пока попытки ещё нет (иначе на карточке уже есть неизменяемый снимок
      // конкретной попытки, показанный выше). Тот же сервис и та же
      // маскировка, что и на странице настроек ресторана — второй реализации
      // маскирования здесь нет.
      const pendingRequisitesPreview = payout.status === 'prepared'
        ? await restaurantBankDetailsService.getBankDetails(payout.restaurant_id)
        : null;
      const csrfToken = ensureCsrfToken(req);
      const body = views.renderPayoutDetail({
        payout, attempts, requisitesByAttemptId, readiness, linkBasePath,
        error: req.query.error, csrfToken, pendingRequisitesPreview,
      });
      res.send(layout({ title: `Выплата #${payout.id}`, active: 'payouts', csrfToken, linkBasePath, body }));
    } catch (err) {
      next(err);
    }
  });

  // Stage 25 — закрытие Stage 24 HIGH-1: T-Bank ещё не подключён (задание,
  // раздел «Не подключать Т-Банк»), поэтому это ЕДИНСТВЕННОЕ write-действие
  // на карточке выплаты — подтверждение уже совершённого владельцем перевода,
  // а не отправка денег. confirmManualBankTransfer сама проверяет статус
  // 'prepared', неизменяемость после succeeded защищена триггером БД
  // (fn_restaurant_payouts_immutable_after_terminal/
  // fn_payout_attempts_immutable_after_terminal) — эта ветка не пытается
  // обойти их прямым UPDATE.
  router.post('/:id/confirm-manual', requireCsrf, async (req, res, next) => {
    try {
      const hqUser = (req.session && req.session.hqUser) || '';
      // Необязательный комментарий — только в аудит, ограниченной длины
      // (тот же принцип, что и sanitizeErrorMessage: свободный текст в лог
      // попадает обрезанным, а не как есть).
      const comment = String(req.body.comment || '').trim().slice(0, 300);
      const { payout, attempt } = await payoutService.confirmManualBankTransfer(req.params.id, {
        operationReference: req.body.operation_reference,
        paidAt: req.body.paid_at,
        confirmedBy: hqUser,
      });
      // Ни токена, ни реквизитов — только идентификаторы и сумма (тот же
      // allowlist-принцип, что и у остальных финансовых событий проекта).
      await logAuditEvent({
        action: 'payout_attempt_succeeded', restaurantId: payout.restaurant_id,
        details: `выплата #${payout.id}: попытка #${attempt.attempt_number} подтверждена вручную владельцем `
          + `(${hqUser || 'без логина'}), операция №${attempt.payment_id}, сумма ${payout.amount} ₽`
          + `${comment ? `; комментарий: ${comment}` : ''}`,
        ip: req.ip,
      });
      await logAuditEvent({
        action: 'payout_succeeded', restaurantId: payout.restaurant_id,
        details: `выплата #${payout.id}: обязательство завершено (ручное подтверждение)`,
        ip: req.ip,
      });
      // Информационное событие для Центра событий HQ (задание: "записать
      // audit и событие HQ") — не 'payout_issue': это не проблема, а рядовое
      // завершение работы. Отдельной категории под это заводить не стали —
      // 'other' уже существует именно для событий вне остальных бакетов.
      try {
        const eventLogService = require('../../services/hq/eventLogService');
        const [row] = await require('../../db/postgresql').query(
          'SELECT name FROM restaurants WHERE id = $1', [payout.restaurant_id],
        );
        await eventLogService.createEvent({
          category: 'other',
          restaurantId: payout.restaurant_id,
          restaurantName: row ? row.name : null,
          message: `Выплата #${payout.id} на сумму ${payout.amount} ₽ подтверждена вручную владельцем — банк не задействован.`,
        });
      } catch (eventErr) {
        console.error('[hq/payouts] не удалось записать событие о ручном подтверждении:', eventErr.message);
      }
      res.redirect(`${linkBasePath}/payouts/${payout.id}`);
    } catch (err) {
      if (err instanceof payoutService.ValidationError) {
        return res.redirect(`${linkBasePath}/payouts/${req.params.id}?error=${encodeURIComponent(err.message)}`);
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createPayoutsRouter };
