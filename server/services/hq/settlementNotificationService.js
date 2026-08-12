'use strict';

// YAAM HQ — уведомление ресторана о завершённом расчёте
// (docs/HQ-PRODUCT-SPEC.md, раздел «Передача ресторану»).
//
// ГЛАВНОЕ ПРАВИЛО: сообщение «Выплата перечислена» отправляется ТОЛЬКО когда
// банковский провайдер подтвердил перевод, то есть restaurant_payouts.status
// = 'succeeded'. Пока обязательство в статусе prepared/processing/unknown/
// blocked — такое сообщение не отправляется вовсе: обещать ресторану деньги,
// которых банк ещё не отправил, недопустимо (реального банковского
// провайдера в проекте пока нет — см. PENDING в отчёте).
//
// Отправка идёт через УЖЕ существующую привязку Telegram-группы
// (restaurants.telegram_chat_id, telegramLinkService) и через тот же
// bot-клиент, что и остальные уведомления. Полные банковские реквизиты и
// большой бухгалтерский текст в чат не уходят — только итоговые суммы и
// ссылки на документы в HQ.
const db = require('../../db/postgresql');
const { formatMinorRub } = require('../money');
const { logAuditEvent } = require('./auditLog');
const documentService = require('./settlementDocumentService');
const accessService = require('./settlementDocumentAccessService');

function formatDate(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const [y, m, d] = value.split('-');
    return `${d}.${m}.${y}`;
  }
  const dt = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(dt.getUTCDate())}.${pad(dt.getUTCMonth() + 1)}.${dt.getUTCFullYear()}`;
}

// Короткое сообщение (задание: «не отправлять огромный бухгалтерский текст»).
// Ссылки ведут в HQ и требуют авторизации владельца — сами по себе они не
// раскрывают документ постороннему, кто получил бы текст сообщения.
function buildPayoutMessage({ line, period, payout, documentLinks = [] }) {
  const sales = line.turnover;
  const refunds = line.successful_refunds_amount;
  const commission = line.yaam_commission;
  const paid = payout.amount;

  const lines = [
    `Выплата за ${formatDate(period.period_from)} — ${formatDate(period.period_to)}`,
    '',
    `Продажи: ${formatMinorRub(sales)}`,
  ];
  if (refunds > 0) lines.push(`Возвраты: ${formatMinorRub(refunds)}`);
  lines.push(`Комиссия YAAM: ${formatMinorRub(commission)}`);
  // Удержание долга прошлых периодов — ресторан обязан понимать, почему
  // перечислено меньше, чем начислено, без звонка в поддержку.
  if (line.carry_forward_applied > 0) {
    lines.push(`Удержано за прошлые периоды: ${formatMinorRub(line.carry_forward_applied)}`);
  }
  lines.push(`Перечислено: ${formatMinorRub(paid)}`);
  if (line.carry_forward_remaining > 0) {
    lines.push(`Остаток долга: ${formatMinorRub(line.carry_forward_remaining)}`);
  }
  if (payout.completed_at) lines.push(`Дата выплаты: ${formatDate(payout.completed_at)}`);

  return { text: lines.join('\n'), links: documentLinks };
}

// Сообщение о ГОТОВНОСТИ документов — отдельно от выплаты и намеренно.
// Документы формируются при закрытии периода, а выплата может произойти
// значительно позже (или не произойти вовсе). Здесь НЕ говорится ничего о
// перечислении денег: обещать выплату, которой ещё не было, недопустимо.
function buildDocumentsMessage({ line, period, documentLinks = [] }) {
  const lines = [
    `Расчёт за ${formatDate(period.period_from)} — ${formatDate(period.period_to)}`,
    '',
    `Продажи: ${formatMinorRub(line.turnover)}`,
  ];
  if (line.successful_refunds_amount > 0) lines.push(`Возвраты: ${formatMinorRub(line.successful_refunds_amount)}`);
  lines.push(`Комиссия YAAM: ${formatMinorRub(line.yaam_commission)}`);
  if (line.carry_forward_applied > 0) {
    lines.push(`Удержано за прошлые периоды: ${formatMinorRub(line.carry_forward_applied)}`);
  }
  lines.push(`К выплате: ${formatMinorRub(line.payable_amount)}`);
  if (line.carry_forward_remaining > 0) {
    lines.push(`Остаток долга: ${formatMinorRub(line.carry_forward_remaining)}`);
  }
  lines.push('');
  lines.push('Документы за период сформированы. Выплата будет подтверждена отдельным сообщением.');
  return { text: lines.join('\n'), links: documentLinks };
}

// Выдаёт capability-ссылки на документы ресторана за период. Ссылка ведёт на
// /d/<token> и открывает РОВНО ОДИН документ — ни HQ, ни другие периоды, ни
// документы других ресторанов через неё недоступны.
async function issueDocumentLinks(periodId, restaurantId, publicBaseUrl) {
  // База проверяется ДО выпуска: токен, для которого невозможно собрать
  // адрес, был бы выпущен впустую — он занял бы место в лимите действующих
  // ссылок документа и остался бы жить в базе, никому не пригодившись.
  const base = accessService.normalizePublicBaseUrl(publicBaseUrl);
  if (!base) return [];

  const all = await documentService.listDocumentsForPeriod(periodId);
  // Фильтр по restaurant_id — первая граница: чужой документ сюда не попадёт.
  // Вторая — внутри issueToken, который сам сверяет владельца документа.
  const mine = all.filter((d) => d.restaurant_id === restaurantId && d.status === 'generated');

  const links = [];
  for (const doc of mine) {
    // eslint-disable-next-line no-await-in-loop
    const issued = await accessService.issueToken(doc.id);
    if (!issued) continue;
    const url = accessService.buildDocumentUrl(base, issued.token);
    // Собрать адрес не удалось уже после выпуска — ссылку не отдаём и токен
    // сразу отзываем, чтобы он не остался действующим ключом без применения.
    if (!url) {
      // eslint-disable-next-line no-await-in-loop
      await accessService.revokeToken(issued.tokenId);
      continue;
    }
    links.push({ text: DOCUMENT_LINK_LABELS[doc.kind] || 'Документ', url });
  }
  return links;
}

const DOCUMENT_LINK_LABELS = {
  agent_report: 'Отчёт агента',
  order_registry: 'Реестр заказов',
};

// Уведомление о готовности документов периода. Отправляется ПОСЛЕ закрытия
// периода и генерации документов, независимо от выплаты.
async function notifyRestaurantAboutDocuments(periodId, restaurantId, { bot = null, publicBaseUrl = null } = {}) {
  const periods = await db.query('SELECT * FROM settlement_periods WHERE id = $1', [periodId]);
  const period = periods[0];
  if (!period) return { sent: false, reason: 'period_not_found' };

  const lineRows = await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1 AND restaurant_id = $2',
    [periodId, restaurantId],
  );
  const line = lineRows[0];
  if (!line) return { sent: false, reason: 'settlement_line_not_found' };

  const restaurants = await db.query('SELECT telegram_chat_id FROM restaurants WHERE id = $1', [restaurantId]);
  const chatId = restaurants[0] ? restaurants[0].telegram_chat_id : null;
  // Группы нет — документы остаются в HQ, это не ошибка расчёта.
  if (!chatId) {
    await logAuditEvent({
      action: 'settlement_notification_failed', restaurantId,
      details: `период #${periodId}: Telegram-группа ресторана не подключена`, ip: null,
    });
    return { sent: false, reason: 'telegram_not_connected' };
  }
  if (!bot || typeof bot.sendMessage !== 'function') {
    await logAuditEvent({
      action: 'settlement_notification_failed', restaurantId,
      details: `период #${periodId}: Telegram-бот не запущен на этом процессе`, ip: null,
    });
    return { sent: false, reason: 'bot_unavailable' };
  }

  const documentLinks = await issueDocumentLinks(periodId, restaurantId, publicBaseUrl);
  const { text, links } = buildDocumentsMessage({ line, period, documentLinks });

  try {
    const replyMarkup = links.length
      ? { reply_markup: { inline_keyboard: [links.map((l) => ({ text: l.text, url: l.url }))] } }
      : undefined;
    await bot.sendMessage(chatId, text, replyMarkup);
    await logAuditEvent({
      action: 'settlement_notification_sent', restaurantId,
      details: `документы периода #${periodId} отправлены`, ip: null,
    });
    return { sent: true, reason: null };
  } catch (err) {
    await logAuditEvent({
      action: 'settlement_notification_failed', restaurantId,
      details: `период #${periodId}: ${err.message}`, ip: null,
    });
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

// Отправляет уведомление о ПОДТВЕРЖДЁННОЙ выплате.
//
// Возвращает { sent, reason } — доставка НИКОГДА не считается успешной по
// умолчанию: отсутствие группы, отсутствие бота и ошибка adapter'а дают
// sent=false с честной причиной и audit-событием, но НЕ ломают расчётный
// период и не мешают документам существовать в HQ.
async function notifyRestaurantAboutPayout(payoutId, { bot = null, publicBaseUrl = null } = {}) {
  const rows = await db.query(
    `SELECT rp.*, sp.period_from, sp.period_to, sp.id AS period_id,
            r.telegram_chat_id, r.name AS restaurant_name
       FROM restaurant_payouts rp
       JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
       JOIN restaurants r ON r.id = rp.restaurant_id
      WHERE rp.id = $1`,
    [payoutId],
  );
  const payout = rows[0];
  if (!payout) return { sent: false, reason: 'payout_not_found' };

  // Единственное условие, при котором вообще уместно слово «перечислено».
  if (payout.status !== 'succeeded') {
    return { sent: false, reason: 'payout_not_succeeded' };
  }

  const lineRows = await db.query(
    'SELECT * FROM settlement_restaurant_lines WHERE settlement_period_id = $1 AND restaurant_id = $2',
    [payout.settlement_period_id, payout.restaurant_id],
  );
  const line = lineRows[0];
  if (!line) return { sent: false, reason: 'settlement_line_not_found' };

  // Группа не подключена — период и документы остаются доступными в HQ,
  // просто уведомление не ушло (задание, раздел 12).
  if (!payout.telegram_chat_id) {
    await logAuditEvent({
      action: 'settlement_notification_failed', restaurantId: payout.restaurant_id,
      details: `выплата #${payout.id}: Telegram-группа ресторана не подключена`, ip: null,
    });
    return { sent: false, reason: 'telegram_not_connected' };
  }

  if (!bot || typeof bot.sendMessage !== 'function') {
    await logAuditEvent({
      action: 'settlement_notification_failed', restaurantId: payout.restaurant_id,
      details: `выплата #${payout.id}: Telegram-бот не запущен на этом процессе`, ip: null,
    });
    return { sent: false, reason: 'bot_unavailable' };
  }

  // Capability-ссылки на СВОИ документы — единственный вид ссылок, который
  // здесь допустим (HQ-ссылки ресторану недоступны, публичный доступ запрещён).
  const documentLinks = await issueDocumentLinks(
    payout.settlement_period_id, payout.restaurant_id, publicBaseUrl,
  );

  const { text, links } = buildPayoutMessage({
    line,
    period: { id: payout.period_id, period_from: payout.period_from, period_to: payout.period_to },
    payout,
    documentLinks,
  });

  try {
    // Документ другого ресторана сюда попасть не может: documents отфильтрованы
    // по restaurant_id этой же выплаты, а chat_id взят из строки того же
    // ресторана (частичный UNIQUE ux_restaurants_telegram_chat гарантирует,
    // что одна группа обслуживает ровно один ресторан).
    const replyMarkup = links.length
      ? { reply_markup: { inline_keyboard: [links.map((l) => ({ text: l.text, url: l.url }))] } }
      : undefined;
    await bot.sendMessage(payout.telegram_chat_id, text, replyMarkup);
    await logAuditEvent({
      action: 'settlement_notification_sent', restaurantId: payout.restaurant_id,
      details: `выплата #${payout.id} за период ${payout.period_from}–${payout.period_to}`, ip: null,
    });
    return { sent: true, reason: null };
  } catch (err) {
    await logAuditEvent({
      action: 'settlement_notification_failed', restaurantId: payout.restaurant_id,
      details: `выплата #${payout.id}: ${err.message}`, ip: null,
    });
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = {
  buildPayoutMessage,
  buildDocumentsMessage,
  issueDocumentLinks,
  notifyRestaurantAboutPayout,
  notifyRestaurantAboutDocuments,
};
