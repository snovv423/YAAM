'use strict';

// Публичный capability-роут расчётного документа: GET /d/:token
// (router смонтирован на префикс '/d' в services/postgresql/app.js).
//
// Единственный способ для ресторана открыть свой «Отчёт агента» или «Реестр
// заказов» без HQ-сессии. Токен даёт доступ ровно к ОДНОМУ документу — см.
// services/hq/settlementDocumentAccessService.js.
//
// Роут смонтирован ВНЕ /hq и намеренно не имеет ничего общего с HQ-сессией:
// он не читает и не выставляет её cookie, не даёт никаких прав, кроме чтения
// этого документа, и не принимает никаких мутаций (только GET).
const express = require('express');
const rateLimit = require('express-rate-limit');

const accessService = require('../../services/hq/settlementDocumentAccessService');
const { renderDocument } = require('../../hq/settlementDocumentViews');

const router = express.Router();

// Токен непредсказуем (32 случайных байта), но лимит всё равно нужен: он
// превращает перебор из «медленного» в «бессмысленный» и заодно ограничивает
// нагрузку на рендер документа.
const documentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // В лог идут ip и путь БЕЗ токена: originalUrl содержал бы секрет.
    console.warn(`[documents] rate-limit ip=${req.ip} time=${new Date().toISOString()}`);
    res.status(429).type('text/plain; charset=utf-8')
      .send('Слишком много запросов — попробуйте чуть позже.');
  },
});

// Ответы намеренно НЕ различают «токена не существует» и «токен неверного
// формата»: любая разница помогала бы перебору. Отозванный и просроченный
// разделены — это состояния, о которых честно сообщить полезно самому
// ресторану, и знание о них ничего не даёт постороннему.
const MESSAGES = {
  invalid_format: ['Ссылка недействительна.', 404],
  not_found: ['Ссылка недействительна.', 404],
  document_missing: ['Ссылка недействительна.', 404],
  restaurant_mismatch: ['Ссылка недействительна.', 404],
  revoked: ['Срок действия ссылки отозван. Запросите новую ссылку у YAAM.', 410],
  expired: ['Срок действия ссылки истёк. Запросите новую ссылку у YAAM.', 410],
};

router.get('/:token', documentLimiter, async (req, res, next) => {
  try {
    const result = await accessService.resolveToken(req.params.token, { ip: req.ip });
    if (!result.ok) {
      const [message, status] = MESSAGES[result.reason] || MESSAGES.not_found;
      return res.status(status).type('text/html; charset=utf-8').send(
        `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">`
        + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
        + `<link rel="icon" href="data:,"><title>Документ недоступен</title>`
        + `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;`
        + `background:#f4f5f4;color:#14201a;margin:0;padding:48px 20px;text-align:center}`
        + `p{max-width:420px;margin:0 auto;line-height:1.6}</style></head>`
        + `<body><p>${message}</p></body></html>`,
      );
    }

    // Токен не даёт кэшировать документ у посредников: он персональный.
    res.set('Cache-Control', 'no-store, private');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.type('text/html; charset=utf-8').send(renderDocument(result.document));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
