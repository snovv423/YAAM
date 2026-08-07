'use strict';

// YAAM — persistent outbox для критичных Telegram-уведомлений, Stage 31,
// раздел 1.2.
//
// ЗАЧЕМ. Живой Stage 30 дважды поймал "EFATAL: fetch failed" при отправке
// order:new — прямой bot.sendMessage() внутри обработчика события не имел
// ни одного повтора: один неудачный fetch навсегда хоронил единственную
// попытку уведомить ресторан. Диагностика (STAGE31 отчёт, раздел 1.1)
// показала правдоподобный, но НЕ железно доказанный механизм (нестабильный
// IPv6-маршрут VPS, полученный через router advertisement с истечением, на
// фоне статичного IPv4-маршрута) — задание прямо запрещает "чинить" сеть
// вслепую; вместо этого чинится САМ КЛАСС проблемы: доставка обязана уметь
// пережить единичный сетевой сбой, а её состояние — рестарт процесса.
//
// АРХИТЕКТУРА — таблица bot_notifications (миграция 0010), НЕ in-memory
// retry: тот же принцип, что уже применён для bot_order_messages (0008,
// Stage 29.1) — критичное состояние обязано пережить рестарт backend.
// Каждая строка — одно логическое уведомление с устойчивым dedup_key
// ('order:<id>:new' — задание, раздел 1.2), ON CONFLICT DO NOTHING не даёт
// повторному emit'у того же события создать вторую строку/второе
// сообщение. Диспетчер (dispatchPending, вызывается отдельным scheduler-
// тиком, см. services/postgresql/scheduler.js) видит незавершённые
// pending-строки НЕЗАВИСИМО от того, в каком процессе они были созданы.
//
// ОСТАТОЧНЫЙ РИСК (задание прямо требует не скрывать) — "неопределённый
// результат внешнего API": если транспортная ошибка произошла ПОСЛЕ того,
// как Telegram уже принял и обработал запрос, но ДО того как мы прочитали
// ответ (оборванное соединение на этапе чтения тела ответа), повторная
// попытка технически может создать дублирующее сообщение в Telegram-чате.
// Это НЕ отличимо от "запрос не дошёл вовсе" на уровне fetch-ошибки — сам
// Telegram Bot API не поддерживает idempotency-ключ для sendMessage.
// Дубль в этом редком случае — единственная цена за гарантию "хотя бы одна
// попытка обязательно случится", а не "заказ молча остаётся без
// уведомления навсегда". Exactly-once НЕ обещается и не может быть здесь
// технически доказан — обещается at-least-once с ограниченным числом
// попыток и наблюдаемым терминальным состоянием.
//
// Stage 31.1 — ДВА разрыва, найденные преддеплойной проверкой ДО первого
// реального применения этой таблицы:
//
//   1. Concurrent claim (см. claimNotification). UNIQUE(dedup_key)
//      защищает только от ВТОРОЙ СТРОКИ на одно логическое событие — она
//      НЕ мешала immediate dispatch (enqueueAndDispatch, вызывается сразу
//      после успешной вставки) и scheduler-тику (dispatchPending, каждые
//      ~5с) обоим увидеть ОДНУ И ТУ ЖЕ 'pending'-строку и обоим вызвать
//      bot.sendMessage() для неё, если тик успевал попасть в окно между
//      INSERT и записью финального статуса immediate-попытки. Оба пути
//      теперь идут через один и тот же atomic claim
//      (UPDATE ... WHERE status IN ('pending'|просроченный lease
//      'processing') ... RETURNING) — либо ОДИН worker выигрывает claim и
//      шлёт, либо (при абсолютно синхронном старте двух claim-запросов)
//      побеждает ровно один — проигравший получает rowCount=0 и просто
//      ничего не делает с этой строкой на этом тике.
//   2. Stale order:new (см. проверку внутри dispatchOne). Между попытками
//      (транзиентный Telegram-сбой + backoff) заказ мог покинуть
//      awaiting_restaurant — клиент отменил, sweepTimeouts успел
//      просрочить. Присылать "Новый заказ" с рабочими кнопками
//      "Принять"/"Отклонить" для уже решённого заказа нельзя. Guard
//      применяется ТОЛЬКО к order:new-уведомлениям (dedup_key вида
//      'order:<id>:new') — единственному типу, который сегодня реально
//      проходит через этот outbox.
const db = require('../../db/postgresql');
const { trackOrderMessage } = require('./botOrderMessageTracker');

// Строка, застрявшая в 'processing' дольше этого срока, считается
// брошенной (процесс, который её claim'нул, упал/завис ДО того, как успел
// записать финальный статус) и разрешена для повторного claim другим
// worker'ом — "crash не должен навечно оставить notification
// заблокированной" (задание, раздел 1). Щедрый запас относительно
// типичного времени ответа Telegram (секунды), но всё ещё маленький
// относительно 7-минутного окна ответа ресторана.
const CLAIM_LEASE_SECONDS = 120;

// order:new — единственный тип уведомления, который сегодня реально идёт
// через этот outbox (задание, раздел 1.2, dedup_key буквально
// 'order:<id>:new'). Регулярное выражение, а не просто index of ':new' —
// не должно случайно совпасть с гипотетическим будущим dedup_key вроде
// 'order:5:newsletter'.
const ORDER_NEW_DEDUP_KEY_RE = /^order:\d+:new$/;

// Backoff — фиксированная (не экспоненциальная-с-jitter, как в db/postgresql/
// index.js transaction(): здесь нет конкурентной гонки за одну и ту же
// строку, только "сколько подождать перед следующей самостоятельной
// попыткой") последовательность, укладывающаяся с большим запасом внутрь
// 7-минутного окна ответа ресторана (RESTAURANT_RESPONSE_WINDOW_SEC,
// orderService.js) — даже при ПОЛНОМ исчерпании (5 попыток) проходит около
// 2.5 минут, честно оставляя ресторану основную часть окна на сам ответ,
// если доставка всё же удастся не с первой попытки.
const BACKOFF_SCHEDULE_MS = [5_000, 15_000, 45_000, 90_000];
const DEFAULT_MAX_ATTEMPTS = BACKOFF_SCHEDULE_MS.length + 1; // 5

function backoffDelayMs(attemptJustMade) {
  const idx = Math.min(attemptJustMade - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[Math.max(idx, 0)];
}

// --- Классификация ошибок -------------------------------------------------
//
// node-telegram-bot-api (см. node_modules/node-telegram-bot-api/dist/http.js
// и errors.js — актуальная версия v1.1.2, нативный fetch/undici, без
// внешних HTTP-зависимостей) уже САМА повторяет HTTP 429 (Too Many
// Requests) дважды внутри одного вызова, соблюдая Telegram-овский
// retry_after — до нашего слоя долетает УЖЕ финальный результат. Нашей
// классификации подлежат три класса ошибок библиотеки:
//   EFATAL   — сбой транспорта (fetch/undici) ДО получения ответа. В
//              подавляющем большинстве случаев запрос не дошёл вовсе
//              (обрыв соединения/DNS/маршрут/таймаут) — безопасно
//              повторить.
//   EPARSE   — ответ пришёл, но не распарсился как JSON (обычно
//              инфраструктурная прослойка — прокси/gateway-страница
//              ошибки, не сам Telegram) — тоже временная, повторяем.
//   ETELEGRAM — Telegram содержательно ответил "не ок". error_code >= 500 —
//              сбой на стороне Telegram (временный, повторяем). Всё
//              остальное (400/401/403/404 — некорректный запрос, бот
//              заблокирован, чат не найден и т.п.) — ПОСТОЯННАЯ ошибка,
//              повтор не поможет и не должен маскировать проблему.
function classifyTelegramError(err) {
  if (!err) return 'permanent';
  if (err.code === 'EFATAL') return 'retry';
  if (err.code === 'EPARSE') return 'retry';
  if (err.code === 'ETELEGRAM') {
    const httpLikeCode = Number(err.response?.body?.error_code ?? err.response?.status);
    if (Number.isFinite(httpLikeCode) && httpLikeCode >= 500) return 'retry';
    if (httpLikeCode === 429) return 'retry';
    return 'permanent';
  }
  // Неизвестный класс ошибки (не из этой библиотеки) — консервативно
  // считаем временной, но max_attempts всё равно ограничивает риск
  // бесконечного повтора программной ошибки.
  return 'retry';
}

// Безопасное (без токена/секретов — задание, раздел 1.2) текстовое
// описание ошибки для last_error/логов. err.message самого FatalError —
// это message ИСХОДНОЙ fetch-ошибки ("fetch failed" и т.п.), она не
// содержит URL с токеном (Node/undici формируют такие сообщения на уровне
// TCP/DNS, до того как строится HTTP-путь). Но вложенный err.cause (сырая
// undici-ошибка) МОЖЕТ в редких вариантах содержать message с деталями
// соединения — оттуда сознательно берутся ТОЛЬКО структурные поля
// (code/errno/syscall/address/port), никогда message/stack — та же
// осторожность, что уже проявлена в db/postgresql/index.js safeErrorFields()
// для ошибок PostgreSQL.
function safeCauseChain(err, depth = 3) {
  const chain = [];
  let cur = err;
  for (let i = 0; i < depth && cur; i += 1) {
    chain.push({
      name: cur.name,
      code: cur.code,
      errno: cur.errno,
      syscall: cur.syscall,
      address: cur.address,
      port: cur.port,
    });
    cur = cur.cause;
  }
  return chain;
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.code === 'ETELEGRAM') {
    const code = err.response?.body?.error_code ?? err.response?.status ?? '?';
    const description = err.response?.body?.description ?? '';
    return `ETELEGRAM ${code} ${description}`.trim();
  }
  const top = err.message || err.code || 'unknown error';
  const chain = err.code === 'EFATAL' ? safeCauseChain(err.cause, 3) : [];
  return chain.length ? `${top} | cause=${JSON.stringify(chain)}` : top;
}

// --- Outbox-примитивы ------------------------------------------------------

// Вставляет строку, если dedup_key ещё не занят. Возвращает саму строку при
// успешной вставке или null, если такое уведомление уже существует
// (повторный emit того же логического события — задание требует "не
// создавать повторный заказ или повторный переход статуса" и "минимизировать
// дубли Telegram-сообщений").
async function enqueue({
  dedupKey, orderId = null, chatId, text, replyMarkup = null, maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const rows = await db.query(
    `INSERT INTO bot_notifications (dedup_key, order_id, chat_id, message_text, reply_markup, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING *`,
    [dedupKey, orderId, String(chatId), text, replyMarkup ? JSON.stringify(replyMarkup) : null, maxAttempts],
  );
  return rows[0] || null;
}

function parseReplyMarkup(value) {
  if (!value) return undefined;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Диагностируемый алерт для YAAM (задание, раздел 1.2: "после исчерпания
// попыток должно создаваться диагностируемое событие/алерт") — тот же
// hq_events/'telegram_issue', которым уже пользуется order:new-обработчик
// в bot/postgresql/index.js для случая, когда у ресторана вовсе не
// подключён Telegram. Ошибка самой записи события не должна ронять
// dispatch — событие уже и так зафиксировано в bot_notifications.status
// ('failed'), это лишь удобство для владельца, не источник истины.
async function raiseUndeliveredAlert(row, safeMessage) {
  try {
    const eventLogService = require('../hq/eventLogService');
    let orderPublicCode = null;
    let restaurantId = null;
    let restaurantName = null;
    if (row.order_id != null) {
      const orderRows = await db.query('SELECT public_code, restaurant_id FROM orders WHERE id = $1', [row.order_id]);
      if (orderRows[0]) {
        orderPublicCode = orderRows[0].public_code;
        restaurantId = orderRows[0].restaurant_id;
        const restRows = await db.query('SELECT name FROM restaurants WHERE id = $1', [restaurantId]);
        restaurantName = restRows[0] ? restRows[0].name : null;
      }
    }
    await eventLogService.createEvent({
      category: 'telegram_issue',
      restaurantId,
      restaurantName,
      orderId: row.order_id,
      orderPublicCode,
      message: `Telegram-уведомление (${row.dedup_key}) не доставлено после ${row.attempts} `
        + `попыт${row.attempts === 1 ? 'ки' : 'ок'}: ${safeMessage}`,
    });
  } catch (logErr) {
    console.error('[bot-outbox] hq_events log failed:', logErr.message);
  }
}

// Атомарный claim (Stage 31.1, Issue 1) — единственный путь, которым
// строка переходит в 'processing'. UPDATE ... WHERE ... RETURNING —
// PostgreSQL сам гарантирует, что при двух конкурентных вызовах с одним и
// тем же id ровно один увидит rowCount=1 (WHERE-условие переоценивается
// после снятия блокировки строки, EvalPlanQual — тот же механизм, на
// который уже полагается весь остальной проект, см. db/postgresql/
// index.js header-комментарий про conditional UPDATE), проигравший получает
// rowCount=0 и null отсюда — без SELECT ... FOR UPDATE, без advisory lock,
// без отдельного isolation level.
//
// WHERE-условие разрешает claim в ДВУХ случаях:
//   - строка честно 'pending' и её время пришло (next_attempt_at <= NOW());
//   - строка застряла в 'processing' дольше CLAIM_LEASE_SECONDS — прошлый
//     claim'нувший её процесс, видимо, упал ДО того, как записал финальный
//     статус ("crash не должен навечно оставить notification
//     заблокированной").
async function claimNotification(id) {
  const rows = await db.query(
    `UPDATE bot_notifications
       SET status = 'processing', updated_at = NOW()
     WHERE id = $1
       AND (
         (status = 'pending' AND next_attempt_at <= NOW())
         OR (status = 'processing' AND updated_at < NOW() - ($2 || ' seconds')::interval)
       )
     RETURNING *`,
    [id, CLAIM_LEASE_SECONDS],
  );
  return rows[0] || null;
}

// Stage 31.1, Issue 2 — order:new разрешено ФАКТИЧЕСКИ отправлять только
// пока заказ ещё действительно ждёт ответа ресторана. Guard применяется
// строго к order:new-уведомлениям (см. ORDER_NEW_DEDUP_KEY_RE) — не
// придумывает новых статусов заказа, читает существующую state machine
// (orders.status) как есть.
async function isOrderStillAwaitingRestaurant(orderId) {
  const rows = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  return { exists: Boolean(rows[0]), status: rows[0] ? rows[0].status : null };
}

// Одна попытка доставки УЖЕ ЗАКЛЕЙМЛЕННОЙ (status='processing', см.
// claimNotification выше) строки outbox. Общая для немедленной попытки
// сразу после enqueue (низкая задержка в штатном случае — ресторан видит
// заказ так же быстро, как и раньше) и для scheduler-тика (подбирает то,
// что не удалось отправить сразу или осталось pending после рестарта
// процесса) — ОБА пути проходят через один и тот же claimNotification()
// перед тем, как сюда попасть.
async function dispatchOne(bot, row, logger = console) {
  const attempt = row.attempts + 1;

  // Freshness guard — ДО сетевого вызова, чтобы устаревшее сообщение не
  // ушло вовсе, а не "ушло, но мы сожалеем постфактум".
  if (row.order_id != null && ORDER_NEW_DEDUP_KEY_RE.test(row.dedup_key)) {
    const { exists, status } = await isOrderStillAwaitingRestaurant(row.order_id);
    if (!exists || status !== 'awaiting_restaurant') {
      const reason = exists
        ? `заказ уже в статусе "${status}"`
        : 'заказ не найден (удалён?)';
      await db.execute(
        `UPDATE bot_notifications
           SET status = 'skipped', attempts = $2, updated_at = NOW(), last_error = $3
         WHERE id = $1`,
        [row.id, attempt, `не отправлено: ${reason}`],
      );
      logger.log(`[bot-outbox] пропущено (устарело) dedup_key=${row.dedup_key}: ${reason}`);
      // Штатный, ожидаемый исход — НЕ сетевая ошибка, НЕ создаёт
      // telegram_issue (задание, раздел 2, буквально это запрещает) и НЕ
      // меняет статус самого заказа (уже изменён кем-то другим раньше).
      return { outcome: 'skipped', reason };
    }
  }

  try {
    const replyMarkup = parseReplyMarkup(row.reply_markup);
    const sent = await bot.sendMessage(row.chat_id, row.message_text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
    const sentMessageId = sent && sent.message_id != null ? sent.message_id : null;
    await db.execute(
      `UPDATE bot_notifications
         SET status = 'sent', attempts = $2, sent_at = NOW(), sent_message_id = $3,
             updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [row.id, attempt, sentMessageId],
    );
    // Трек "текущего кликабельного сообщения" — тот же контракт, что раньше
    // выполнялся прямо в handleOrderNew (bot/postgresql/index.js), нужен
    // таймауту/отмене клиентом, чтобы убрать кнопки (Stage 29.1, п.2).
    if (row.order_id != null && sentMessageId != null) {
      try {
        await trackOrderMessage(row.order_id, row.chat_id, sentMessageId);
      } catch (err) {
        // Уведомление УЖЕ доставлено — сбой здесь означает только
        // ухудшённую (best-effort) будущую очистку кнопок, не "не
        // доставлено" (тот же принцип, что уже задокументирован в
        // handleOrderNew/accept до этого рефакторинга).
        logger.error(`[bot-outbox] trackOrderMessage failed for order ${row.order_id}:`, err.message);
      }
    }
    logger.log(`[bot-outbox] отправлено dedup_key=${row.dedup_key} attempt=${attempt}/${row.max_attempts}`);
    return { outcome: 'sent' };
  } catch (err) {
    const classification = classifyTelegramError(err);
    const safeMessage = describeError(err);
    const exhausted = attempt >= row.max_attempts;
    if (classification === 'permanent' || exhausted) {
      await db.execute(
        `UPDATE bot_notifications SET status = 'failed', attempts = $2, last_error = $3, updated_at = NOW() WHERE id = $1`,
        [row.id, attempt, safeMessage],
      );
      logger.error(
        `[bot-outbox] ОКОНЧАТЕЛЬНЫЙ сбой dedup_key=${row.dedup_key} attempt=${attempt}/${row.max_attempts} `
        + `(${classification}${exhausted ? ', попытки исчерпаны' : ''}): ${safeMessage}`,
      );
      await raiseUndeliveredAlert({ ...row, attempts: attempt }, safeMessage);
      return { outcome: 'failed', classification };
    }
    const delayMs = backoffDelayMs(attempt);
    await db.execute(
      // status возвращается в 'pending' явно (было 'processing' — claim
      // выше) — иначе строка простаивала бы до истечения
      // CLAIM_LEASE_SECONDS вместо того, чтобы стать доступной для
      // claim'а СРАЗУ по истечении honest next_attempt_at backoff'а.
      `UPDATE bot_notifications
         SET status = 'pending', attempts = $2, last_error = $3,
             next_attempt_at = NOW() + ($4 || ' milliseconds')::interval,
             updated_at = NOW()
       WHERE id = $1`,
      [row.id, attempt, safeMessage, delayMs],
    );
    logger.error(
      `[bot-outbox] временный сбой dedup_key=${row.dedup_key} attempt=${attempt}/${row.max_attempts}, `
      + `повтор через ${delayMs}мс: ${safeMessage}`,
    );
    return { outcome: 'retry-scheduled', delayMs };
  }
}

// Ставит уведомление в очередь и сразу (best-effort) пробует один раз
// доставить — в штатном случае (сеть работает) задержка ресторана не
// увеличивается ни на миллисекунду по сравнению с прежним прямым
// sendMessage(); при сбое строка остаётся pending с уже выставленным
// next_attempt_at, и её подберёт dispatchPending() на следующем тике
// scheduler'а (services/postgresql/scheduler.js) — в том числе после
// рестарта процесса, независимо от того, в каком именно процессе
// произошёл enqueue.
//
// Если dedup_key уже существует (повторный emit того же события) —
// ничего не отправляется повторно, функция тихо завершается.
//
// Stage 31.1, Issue 1 — claimNotification() ПЕРЕД dispatchOne(): тот же
// единственный claim-механизм, которым пользуется и dispatchPending()
// ниже. Практически claim здесь почти всегда выигрывает (строка только
// что вставлена этим же вызовом, ещё никто о ней не знает) — но если
// scheduler-тик каким-то образом успел вмешаться в этот же миллиметр
// времени, проигравший путь просто ничего не отправляет, оставляя строку
// победителю.
async function enqueueAndDispatch(bot, params) {
  const inserted = await enqueue(params);
  if (!inserted) return { outcome: 'duplicate' };
  if (!bot) return { outcome: 'queued-no-bot' }; // отправит следующий scheduler-тик, когда бот появится
  const claimed = await claimNotification(inserted.id);
  if (!claimed) return { outcome: 'claimed-elsewhere' }; // крайне маловероятно, но корректно: другой worker уже забрал
  return dispatchOne(bot, claimed);
}

// scheduler-тик (Stage 31, раздел 1.2/9) — подбирает всё, что готово
// попробовать снова ПРЯМО СЕЙЧАС (next_attempt_at <= NOW()), включая
// строки, оставшиеся pending после рестарта backend, а также строки,
// брошенные упавшим процессом в 'processing' дольше CLAIM_LEASE_SECONDS
// (Stage 31.1, Issue 1). SELECT здесь — только СПИСОК КАНДИДАТОВ, не сам
// claim: claimNotification() на каждый id — единственное место, которое
// реально решает "кто именно будет отправлять" (тот же принцип, что и в
// enqueueAndDispatch выше, оба пути используют одну функцию).
async function dispatchPending(bot, { logger = console, batchLimit = 20 } = {}) {
  if (!bot) return { dispatched: 0 };
  const candidates = await db.query(
    `SELECT id FROM bot_notifications
      WHERE (
        (status = 'pending' AND next_attempt_at <= NOW())
        OR (status = 'processing' AND updated_at < NOW() - ($2 || ' seconds')::interval)
      )
      ORDER BY id
      LIMIT $1`,
    [batchLimit, CLAIM_LEASE_SECONDS],
  );
  let dispatched = 0;
  for (const { id } of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const claimed = await claimNotification(id);
    if (!claimed) continue; // другой worker уже забрал (или строка уже стала терминальной) между SELECT и claim
    dispatched += 1;
    // eslint-disable-next-line no-await-in-loop
    await dispatchOne(bot, claimed, logger);
  }
  return { dispatched };
}

// Для sweepTimeouts() (orderService.js, раздел 1.3) — момент фактической
// успешной доставки order:new, если она случилась. null, если ещё не
// доставлено (retry в процессе) или уведомления вовсе не было для этого
// заказа (например, у ресторана не подключён Telegram — handleOrderNew
// тогда даже не вызывает enqueue).
async function getOrderNewSentAt(orderId) {
  const rows = await db.query(
    `SELECT sent_at FROM bot_notifications WHERE dedup_key = $1`,
    [`order:${orderId}:new`],
  );
  return rows[0] ? rows[0].sent_at : null;
}

module.exports = {
  enqueue,
  enqueueAndDispatch,
  claimNotification,
  dispatchOne,
  dispatchPending,
  getOrderNewSentAt,
  classifyTelegramError,
  describeError,
  BACKOFF_SCHEDULE_MS,
  DEFAULT_MAX_ATTEMPTS,
  CLAIM_LEASE_SECONDS,
};
