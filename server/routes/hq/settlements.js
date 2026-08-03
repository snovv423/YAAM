'use strict';

// YAAM HQ Stage 8 — расчётные периоды. Смонтирован в routes/hq/index.js под
// '/finance/settlements' (внутри уже защищённой /hq зоны — requireHqAuth
// применяется в точке монтирования, тот же принцип, что и /restaurants,
// см. index.js).
const express = require('express');
const settlementService = require('../../services/hq/settlementService');
const payoutService = require('../../services/hq/payoutService');
const { ValidationError } = require('../../services/hq/restaurantLifecycle');
const { logAuditEvent } = require('../../services/hq/auditLog');
const { ensureCsrfToken, requireCsrf } = require('../../services/hq/csrf');
const { layout } = require('../../hq/layout');
const views = require('../../hq/settlementViews');
const documentService = require('../../services/hq/settlementDocumentService');
const documentViews = require('../../hq/settlementDocumentViews');
const { esc: escapeHtml } = require('../../hq/layout');
const settlementNotificationService = require('../../services/hq/settlementNotificationService');
const db = require('../../db/postgresql');

function notFoundBody(linkBasePath) {
  return `<h1>Расчётный период не найден</h1><div class="panel"><div class="empty-state">Проверьте адрес или вернитесь к списку.</div></div><a class="btn ghost" href="${linkBasePath}/finance">← К финансам</a>`;
}


function createSettlementsRouter({ linkBasePath, publicBaseUrl = null }) {
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

  // Ручное создание расчётного периода УДАЛЕНО из интерфейса владельца
  // (docs/HQ-PRODUCT-SPEC.md): периоды закрываются автоматически каждое
  // воскресенье в 07:00 МСК — services/hq/weeklySettlementService.js.
  // Аварийный запуск job остаётся только как серверная функция
  // (runWeeklySettlementJob), не как повседневная кнопка HQ.


  // Общий рендер страницы периода — используется и обычным GET, и POST
  // выдачи ссылок на документы (см. ниже): последний рендерит эту же
  // страницу НАПРЯМУЮ (без redirect), потому что свежевыпущенные токены
  // существуют только в одном HTTP-ответе и нигде не сохраняются — редирект
  // потребовал бы протащить их через сессию/query, а строгое требование
  // задания («сырой токен никогда не должен попасть ни в одну таблицу БД»)
  // распространяется и на любое промежуточное хранилище, включая
  // session-flash.
  async function renderPeriodDetail(req, res, { error = null, freshLinksByRestaurant = null } = {}) {
    const detail = await settlementService.getSettlementPeriodDetail(req.settlementPeriod.id);
    const documents = detail.period.status === 'closed'
      ? await documentService.listDocumentsForPeriod(detail.period.id)
      : [];
    const totals = detail.lines.reduce((acc, l) => ({
      orders: acc.orders + Number(l.delivered_paid_orders),
      turnover: acc.turnover + Number(l.turnover),
      commission: acc.commission + Number(l.yaam_commission),
      payable: acc.payable + Number(l.payable_amount),
      refundsCount: acc.refundsCount + Number(l.successful_refunds_count),
      refundsAmount: acc.refundsAmount + Number(l.successful_refunds_amount),
    }), { orders: 0, turnover: 0, commission: 0, payable: 0, refundsCount: 0, refundsAmount: 0 });
    const csrfToken = ensureCsrfToken(req);
    const body = views.renderSettlementPeriodDetail({
      period: detail.period, lines: detail.lines, preview: detail.preview,
      totals, documents, linkBasePath, csrfToken, error,
      freshLinksByRestaurant, canIssueDocumentLinks: Boolean(publicBaseUrl),
    });
    res.send(layout({ title: 'Расчётный период', active: 'finance', csrfToken, linkBasePath, body }));
  }

  router.get('/:id', async (req, res, next) => {
    try {
      await renderPeriodDetail(req, res, { error: req.query.error });
    } catch (err) {
      next(err);
    }
  });

  // Единственное write-действие Stage 9 внутри /finance/settlements
  // (задание: "Settlement... но никаких кнопок оплаты" — это НЕ оплата,
  // деньги никуда не переводятся, только создаётся внутренняя запись со
  // статусом 'prepared'; см. services/hq/payoutService.js и итоговый отчёт
  // за полным обоснованием, почему это разрешённое действие, а не "кнопка
  // Выплатить").
  router.post('/:id/payouts/:restaurantId/prepare', requireCsrf, async (req, res, next) => {
    try {
      const createdBy = (req.session && req.session.hqUser) || '';
      const payout = await payoutService.prepareRestaurantPayout(
        req.settlementPeriod.id, req.params.restaurantId, { createdBy, notes: req.body.notes },
      );
      await logAuditEvent({
        action: 'payout_created', restaurantId: payout.restaurant_id,
        details: `payout_id=${payout.id}; period_id=${payout.settlement_period_id}; amount=${payout.amount}`,
        ip: req.ip,
      });
      res.redirect(`${linkBasePath}/payouts/${payout.id}`);
    } catch (err) {
      // payoutService.ValidationError — та же самая, буквально реэкспортированная
      // ссылка на restaurantLifecycle.ValidationError (см. payoutService.js) —
      // одна проверка instanceof покрывает оба случая.
      if (err instanceof ValidationError) {
        // PRG вместо повторного рендера: детальная страница теперь собирает
        // статусы выплат и документы сама, дублировать эту сборку в
        // error-ветке значило бы держать два места, которые разойдутся.
        return res.redirect(
          `${linkBasePath}/finance/settlements/${req.settlementPeriod.id}?error=${encodeURIComponent(err.message)}`,
        );
      }
      next(err);
    }
  });

  // Ручное закрытие периода и удаление черновика УДАЛЕНЫ из интерфейса:
  // закрытие выполняет сервер (weeklySettlementService), а закрытый период
  // immutable по определению. Сами сервисные функции closeSettlementPeriod()/
  // deleteDraftSettlementPeriod() сохранены и покрыты тестами — они нужны
  // job'у и аварийным операторским сценариям.

  // --- Документы периода (docs/HQ-PRODUCT-SPEC.md, раздел «Документы») ---
  //
  // БЕЗОПАСНОСТЬ: документ выдаётся только внутри HQ-сессии (requireHqAuth на
  // точке монтирования роутера) И только если он действительно принадлежит
  // ЭТОМУ периоду. Подмена id в URL не может отдать документ другого
  // периода/ресторана — проверка ниже явная, а не «доверие к id».
  router.get('/:id/documents/:documentId', async (req, res, next) => {
    try {
      const document = await documentService.getDocumentById(req.params.documentId);
      const csrfToken = ensureCsrfToken(req);
      if (!document || document.settlement_period_id !== req.settlementPeriod.id) {
        return res.status(404).send(layout({
          title: 'Документ не найден', active: 'finance', csrfToken, linkBasePath,
          body: `<h1>Документ не найден</h1><div class="panel"><div class="empty-state">Проверьте адрес или вернитесь к периоду.</div></div><a class="btn ghost compact" href="${linkBasePath}/finance/settlements/${req.settlementPeriod.id}">← К периоду</a>`,
        }));
      }
      if (document.status !== 'generated') {
        return res.status(409).send(layout({
          title: 'Документ не сформирован', active: 'finance', csrfToken, linkBasePath,
          body: `<h1>Документ не сформирован</h1><div class="panel"><div class="empty-state">${escapeHtml(document.error_message || 'Формирование документа завершилось ошибкой.')}</div></div><a class="btn ghost compact" href="${linkBasePath}/finance/settlements/${req.settlementPeriod.id}">← К периоду</a>`,
        }));
      }

      const html = documentViews.renderDocument(document);
      // ?download=1 — тот же самый HTML, но браузер сохраняет его файлом.
      // Отдельного «скачиваемого» представления нет намеренно: документ
      // детерминированно воспроизводится из payload, дублировать его во
      // втором формате значило бы завести второй источник истины.
      if (req.query.download) {
        // Номер документа содержит кириллицу (YAAM-АО-...), а HTTP-заголовок
        // допускает только ASCII: без кодирования Node бросает
        // ERR_INVALID_CHAR. Даём ASCII-fallback + RFC 5987 filename* с
        // читаемым именем — так корректно и в старых, и в современных
        // браузерах.
        const asciiName = `${document.kind}-${document.id}.html`;
        const utf8Name = encodeURIComponent(`${document.document_number}.html`);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
        );
      }
      res.type('html').send(html);
    } catch (err) {
      next(err);
    }
  });

  // Stage 25 — закрытие Stage 24 HIGH-2: без Telegram ресторан раньше НИКОГДА
  // не получал доступ к своим документам. Никакого нового capability-
  // механизма здесь нет — issueDocumentLinks (settlementNotificationService)
  // это уже готовая функция поверх settlementDocumentAccessService.issueToken,
  // просто вызванная напрямую владельцем, а не автоматическим уведомлением.
  //
  // ПОЧЕМУ БЕЗ REDIRECT. Обычный POST-Redirect-GET оставил бы сырые токены
  // либо в query (утечка в браузерную историю/Referrer/access-лог), либо в
  // сессии (задание прямо запрещает: токен не должен попадать НИ В ОДНУ
  // таблицу БД, а HQ-сессии — это тоже таблица, hq_sessions). Поэтому эта
  // страница периода рендерится СРАЗУ в ответе на POST — токены существуют
  // только внутри тела этого одного HTTP-ответа и нигде не сохраняются;
  // обновление страницы (GET) их повторно не покажет никогда.
  router.post('/:id/documents/:restaurantId/issue-links', requireCsrf, async (req, res, next) => {
    try {
      const restaurantId = Number.parseInt(req.params.restaurantId, 10);
      if (!Number.isInteger(restaurantId) || restaurantId < 1) {
        return await renderPeriodDetail(req, res, { error: 'Некорректный идентификатор ресторана.' });
      }
      if (!publicBaseUrl) {
        return await renderPeriodDetail(req, res, {
          error: 'Публичный адрес сервера не настроен (PUBLIC_BACKEND_URL) — ссылки выдать нельзя.',
        });
      }
      const links = await settlementNotificationService.issueDocumentLinks(
        req.settlementPeriod.id, restaurantId, publicBaseUrl,
      );
      if (!links.length) {
        return await renderPeriodDetail(req, res, {
          error: `У ресторана #${restaurantId} нет сформированных документов за этот период — выдавать нечего.`,
        });
      }
      // Аудит по каждому токену уже записан ВНУТРИ issueToken (см.
      // settlementDocumentAccessService.js) — здесь только событие для
      // Центра событий HQ, тоже без единого символа токена.
      try {
        const [row] = await db.query('SELECT name FROM restaurants WHERE id = $1', [restaurantId]);
        const eventLogService = require('../../services/hq/eventLogService');
        await eventLogService.createEvent({
          category: 'other',
          restaurantId,
          restaurantName: row ? row.name : null,
          message: `Владелец вручную выпустил ссылки на документы периода #${req.settlementPeriod.id} `
            + `для ресторана${row ? ` «${row.name}»` : ` #${restaurantId}`} (${links.length} шт.) — Telegram не задействован.`,
        });
      } catch (eventErr) {
        console.error('[hq/settlements] не удалось записать событие о выдаче ссылок:', eventErr.message);
      }
      await renderPeriodDetail(req, res, { freshLinksByRestaurant: new Map([[restaurantId, links]]) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSettlementsRouter };
