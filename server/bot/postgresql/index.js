'use strict';

// YAAM — PostgreSQL bot, Production Switch Stage 3 (изолированный порт).
//
// Этот модуль НЕ импортируется ни из server.js, ни из bot/index.js (SQLite) —
// та же архитектурная граница, что у routes/postgresql/api.js (Stage 1) и
// services/postgresql/orderService.js (Wave 1-7 + Stage 1/2). SQLite-бот
// (server/bot/index.js) остаётся полностью нетронутым и единственным,
// реально подключённым к server.js. Этот модуль не открывает SQLite
// DatabaseSync ни прямо, ни как побочный эффект require() — не импортирует
// server/db/index.js, server/services/orderService.js (SQLite) и
// server/services/orderAccessService.js.
//
// Разрешённый доступ к данным — только PostgreSQL: db.query()/db.execute()
// (server/db/postgresql/index.js) для ресторанов/меню (тот же архитектурный
// контур, что и в SQLite-оригинале — эти запросы никогда не проходили через
// orderService.js даже там, см. Stage 1 doc) и уже перенесённые функции
// server/services/postgresql/orderService.js (restaurantAccept/
// restaurantDecline/restaurantAdvance/getOrder/pauseRestaurant/
// resumeRestaurant — последние две добавлены этим же коммитом, см. комментарий
// "Production Switch — Stage 3" в orderService.js).
//
// Изначально (Production Switch — Stage 3) тексты, callback_data, порядок
// операций были дословной копией SQLite-оригинала (server/bot/index.js).
// Начиная с UX fix-stage после Stage 28 (см. отдельный раздел ниже) тексты и
// эмодзи сознательно РАСХОДЯТСЯ — callback_data и общая структура операций
// по-прежнему совпадают. Из исходных Stage 3 адаптаций (не про тексты) две
// сохраняют силу:
//   1. Все SQLite-синхронные вызовы заменены на await db.query()/
//      db.execute()/orderService-функции (неизбежное следствие асинхронного
//      pg-драйвера, не изменение бизнес-логики).
//   2. accept/decline получили pre-check текущего статуса заказа ПЕРЕД
//      мутацией — SQLite-оригинал этого не делает (слепо вызывает
//      restaurantAccept/restaurantDecline и всегда показывает "успех",
//      даже если это был тихий no-op) — сохранение этого поведения означало
//      бы дублирующее уведомление "выберите время готовки" на повторный
//      клик, что задание явно просит предотвратить ("защита от повторного
//      клика", "обработка уже изменённого статуса"). advance/cook_time
//      такой правки не требуют — restaurantAdvance() уже бросает на
//      недопустимом переходе, что и так предотвращает повторное
//      уведомление через существующий catch-блок, тем же принципом, что и
//      SQLite-оригинал.
//
// Тестируемость (тестовое окружение НЕ должно требовать реального Telegram
// token/сети): createBotHandlers(bot) принимает УЖЕ созданный bot-подобный
// клиент (реальный TelegramBot ИЛИ тестовый fake-double с тем же
// подмножеством API — onText/on/sendMessage/editMessageText/
// answerCallbackQuery) и только навешивает обработчики — не создаёт клиент
// сам. startBot(token) — обычная production-точка входа, создаёт настоящий
// TelegramBot с long polling и делегирует в createBotHandlers(), сохраняя
// тот же внешний контракт, что и SQLite startBot(token).
//
// UX fix-stage (после Stage 28, живого Telegram-прогона на hqtest) — четыре
// намеренных, задокументированных отличия от исходного Stage 3-переноса:
//
//   1. Текст order:new/decline/toggle_item и label кнопок ПЕРЕСТАЛ быть
//      дословной копией SQLite-оригинала: убраны цветные emoji (CLAUDE.md,
//      «без emoji в UI» — 🆕/✅/❌/🏃/🛵/🚫 заменены на текст или допустимый
//      символ ✓), текст заказа переструктурирован по секциям (номер / состав
//      / сумма / клиент / телефон / адрес / комментарий) и включает имя
//      клиента (Stage 28, находка MEDIUM-1 — раньше ресторан видел только
//      телефон). bot/index.js (SQLite) сознательно НЕ трогается — это
//      единственный путь в проекте, специально проверявшийся на byte-for-byte
//      парность с ним (test/postgresql/botStage3.test.js), и с этого fix-
//      stage тексты двух ботов намеренно расходятся: SQLite — legacy/local
//      путь (CLAUDE.md), PostgreSQL — единственный, что реально общается с
//      живыми ресторанами.
//   2. Устаревшие inline-кнопки больше не остаются кликабельными после
//      финального события заказа. Ручные accept/decline/cook_time уже
//      убирали их (editMessageText без reply_markup — так себя ведёт этот
//      Telegram-клиент, проверено живым тестом Stage 28); добавлены
//      недостающие случаи: (a) автоматическая отмена по таймауту
//      (sweepTimeouts, Stage 28 живая находка MEDIUM-2 — раньше слался
//      только НОВЫЙ текст «Вы пропустили заказ», а исходные кнопки
//      оставались активными) и отмена самим клиентом — bot_order_messages
//      (PostgreSQL, устойчиво к рестарту, Stage 29.1) отслеживает "текущее
//      кликабельное сообщение" на заказ и чистится в обоих случаях;
//      (b) advance (Передал курьеру/Доставлен/Клиент забрал)
//      получил тот же pre-check, что уже был у accept/decline, вместо
//      голого catch-alert, оставлявшего кнопку живой.
//   3. /pause и /open остаются рабочими (технический fallback), но
//      перестали быть ЕДИНСТВЕННЫМ путём: bare /start у уже подключённого
//      ресторана теперь показывает панель статуса с одной кнопкой
//      («Закрыть ресторан» / «Открыть ресторан») — заменяет ручной ввод
//      команд как основной UX, без изменения самой модели паузы
//      (PAUSE_LABELS/pauseRestaurant/resumeRestaurant не менялись).

const { TelegramBot } = require('node-telegram-bot-api');
const db = require('../../db/postgresql');
const pgOrderService = require('../../services/postgresql/orderService');

const PAUSE_LABELS = { short: '33 мин', medium: '3 часа', long: '11 часов' };

// ---------------------------------------------------------------------------
// Прямые PostgreSQL-запросы ресторанов/меню — тот же архитектурный контур,
// что и routes/postgresql/api.js: не проходят через orderService.js.
// ---------------------------------------------------------------------------

async function restaurantByChat(chatId) {
  const rows = await db.query('SELECT * FROM restaurants WHERE telegram_chat_id = $1', [String(chatId)]);
  return rows[0] || null;
}

async function restaurantByConnectCode(code) {
  const rows = await db.query('SELECT * FROM restaurants WHERE connect_code = $1', [code]);
  return rows[0] || null;
}

async function restaurantById(id) {
  const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  return rows[0] || null;
}

async function menuItemsByRestaurant(restaurantId) {
  return db.query('SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order', [restaurantId]);
}

async function menuItemById(id) {
  const rows = await db.query('SELECT * FROM menu_items WHERE id = $1', [id]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// order:new — уведомление ресторана о новом оплаченном заказе
// ---------------------------------------------------------------------------
//
// Payload — форма Stage 2 (services/postgresql/orderService.js getOrder()),
// дословно совместимая с SQLite (см. eventLayerStage2.test.js parity-тест).
// Обёрнут вызывающей стороной (createBotHandlers) в .catch(), чтобы ошибка
// Telegram-отправки ОДНОГО уведомления не превращалась в необработанное
// отклонение промиса и не мешала обработке СЛЕДУЮЩИХ событий — то же самое
// требование, что и явно сформулировано в задании Stage 3 ("ошибка одного
// уведомления не ломает event emitter и последующие события"). SQLite-
// оригинал этой защиты не имеет (голый bot.sendMessage(...) без await/catch
// внутри синхронного listener'а) — минимальная, документированная адаптация
// под более сетевой (более failure-prone) PostgreSQL/async-путь, продуктовая
// семантика (текст, кнопки, условия) не меняется.
// Структура по секциям (номер / состав / сумма / клиент / телефон / адрес /
// комментарий), без цветных emoji — UX fix-stage после Stage 28 (раздел 1.2
// задания: "сообщение должно быстро читаться сотрудником ресторана"; имя
// клиента добавлено тем же изменением — Stage 28, находка MEDIUM-1).
function renderOrderNewText(order) {
  const itemsList = order.items.map((i) => `${i.qty} × ${i.name} — ${i.price * i.qty} ₽`).join('\n');
  const fulfillmentBlock = order.fulfillment_type === 'pickup'
    ? 'Самовывоз (курьер не нужен)'
    : `Доставка\nАдрес: ${order.address}`;
  return [
    `Новый заказ ${order.public_code}`,
    `Состав:\n${itemsList}`,
    `Сумма: ${order.items_total} ₽`,
    `Клиент: ${order.customer_name}\nТелефон: ${order.customer_phone}`,
    fulfillmentBlock,
    `Комментарий: ${order.comment || '—'}`,
    'Ответьте в течение 5 минут, иначе заказ отменится автоматически.',
  ].join('\n\n');
}

// bot_order_messages (db/postgresql/migrations/0008) — "текущее кликабельное
// сообщение" по заказу, пока он ждёт ресторан (awaiting_restaurant). Нужен
// ТОЛЬКО для того, чтобы onOrderStatus(timed_out)/customer-cancel ниже могли
// убрать кнопки с сообщения, на которое сам ресторан не кликал (иначе
// событие извне — таймаут, отмена клиентом — не знает messageId вовсе).
// Ручные accept/decline/cook_time сами убирают кнопки синхронно, в рамках
// того же callback_query (messageId уже есть в query.message), и сами же
// чистят свою запись — никакого пересечения путей нет.
//
// Stage 29.1, п.2 — БД, а НЕ in-memory Map (как было изначально): таймаут
// может сработать в ДРУГОМ процессе, чем тот, что отправил уведомление
// (рестарт backend между "заказ пришёл" и "заказ просрочен/отменён") — Map
// нового процесса пуст, кнопки остались бы кликабельными навсегда.
async function trackOrderMessage(orderId, chatId, messageId) {
  await db.execute(
    `INSERT INTO bot_order_messages (order_id, chat_id, message_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (order_id) DO UPDATE
       SET chat_id = EXCLUDED.chat_id, message_id = EXCLUDED.message_id, updated_at = NOW()`,
    [orderId, String(chatId), messageId],
  );
}

async function untrackOrderMessage(orderId) {
  await db.execute('DELETE FROM bot_order_messages WHERE order_id = $1', [orderId]);
}

async function getTrackedOrderMessage(orderId) {
  const rows = await db.query('SELECT chat_id, message_id FROM bot_order_messages WHERE order_id = $1', [orderId]);
  if (!rows[0]) return null;
  return { chatId: rows[0].chat_id, messageId: Number(rows[0].message_id) };
}

async function handleOrderNew(bot, order) {
  const restaurant = await restaurantById(order.restaurant_id);
  if (!restaurant || !restaurant.telegram_chat_id) {
    console.error(`[bot/postgresql] заказ ${order.public_code}: у ресторана "${restaurant?.name}" не подключён Telegram`);
    return;
  }
  const sent = await bot.sendMessage(restaurant.telegram_chat_id, renderOrderNewText(order), {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Принять', callback_data: `accept:${order.id}` },
        { text: 'Отклонить', callback_data: `decline:${order.id}` },
      ]],
    },
  });
  if (sent && sent.message_id != null) {
    try {
      await trackOrderMessage(order.id, restaurant.telegram_chat_id, sent.message_id);
    } catch (err) {
      // Уведомление УЖЕ доставлено рестораном — сбой здесь означает только
      // ухудшённую (best-effort) будущую очистку кнопок по таймауту, а не
      // "уведомление не отправлено" (см. onOrderNew выше: он бы иначе создал
      // ложное hq_events "не удалось отправить уведомление о заказе").
      console.error(`[bot/postgresql] trackOrderMessage failed for order ${order.id}:`, err.message);
    }
  }
}

// Убирает кнопки с "текущего кликабельного сообщения" заказа (если оно
// отслеживается) и заменяет его текст — используется событиями, которые
// сами НЕ пришли как клик по кнопке (таймаут, отмена клиентом), поэтому не
// имеют messageId из query.message. Запись в bot_order_messages удаляется в
// любом случае (даже если сообщение не найдено/редактирование не удалось —
// повторно чистить нечего).
async function clearOrderButtons(bot, orderId, text) {
  const tracked = await getTrackedOrderMessage(orderId);
  await untrackOrderMessage(orderId);
  if (!tracked) return;
  try {
    await bot.editMessageText(text, { chat_id: tracked.chatId, message_id: tracked.messageId });
  } catch (err) {
    console.error(`[bot/postgresql] clearOrderButtons failed for order ${orderId}:`, err.message);
  }
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Выбор времени приготовления»: ровно три
// варианта — 30/45/60 минут, одинаковые для всех ресторанов (прежние
// значения выводились из restaurants.default_cook_minutes и у каждого
// ресторана были свои). Без выбора времени заказ НЕ считается принятым —
// см. двухшаговое «Принять» в handleCallbackQuery ниже.
const COOK_TIME_OPTIONS_MIN = [30, 45, 60];

async function sendCookTimeButtons(bot, chatId, orderId, publicCode) {
  return bot.sendMessage(chatId, `Заказ ${publicCode}: за сколько приготовите?`, {
    reply_markup: {
      inline_keyboard: [COOK_TIME_OPTIONS_MIN.map((m) => ({ text: `${m} мин`, callback_data: `cook_time:${orderId}:${m}` }))],
    },
  });
}

// Панель статуса ресторана — основной путь управления паузой (задание,
// раздел 1.3): показывается на bare /start у уже подключённого ресторана.
// Одна кнопка, ведущая либо в существующий выбор длительности (то же
// PAUSE_LABELS/callback_data, что и у /pause — модель паузы не дублируется),
// либо сразу снимающая паузу (то же действие, что и /open).
async function sendRestaurantStatusPanel(bot, chatId, restaurant) {
  const fresh = await restaurantById(restaurant.id);
  if (!fresh) return;
  if (fresh.is_open) {
    await bot.sendMessage(chatId, `«${fresh.name}» открыт и принимает заказы.`, {
      reply_markup: { inline_keyboard: [[{ text: 'Закрыть ресторан', callback_data: 'close_menu' }]] },
    });
  } else {
    await bot.sendMessage(chatId, `«${fresh.name}» сейчас закрыт.`, {
      reply_markup: { inline_keyboard: [[{ text: 'Открыть ресторан', callback_data: 'reopen_now' }]] },
    });
  }
}

async function sendProgressButton(bot, chatId, orderId, currentStatus) {
  const order = await pgOrderService.getOrder(orderId);
  const isPickup = order.fulfillment_type === 'pickup';
  const nextMap = isPickup ? { preparing: 'delivered' } : { preparing: 'courier', courier: 'delivered' };
  const labelMap = isPickup ? { delivered: 'Клиент забрал' } : { courier: 'Передал курьеру', delivered: 'Доставлен' };
  const next = nextMap[currentStatus];
  if (!next) return;
  await bot.sendMessage(chatId, `Заказ ${order.public_code}: когда будет готово, нажмите ниже.`, {
    reply_markup: { inline_keyboard: [[{ text: labelMap[next], callback_data: `advance:${next}:${orderId}` }]] },
  });
}

// ---------------------------------------------------------------------------
// Кнопки (callback_query)
// ---------------------------------------------------------------------------
async function handleCallbackQuery(bot, query) {
  const parts = query.data.split(':');
  const action = parts[0];
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  try {
    if (action === 'accept') {
      // ШАГ 1 из двух (docs/HQ-PRODUCT-SPEC.md, раздел «Выбор времени
      // приготовления»): «Принять» САМО ПО СЕБЕ заказ не принимает — оно
      // только показывает выбор 30/45/60. Заказ переходит в accepted лишь
      // на шаге cook_time ниже, поэтому «без выбора времени заказ нельзя
      // принять» выполняется структурно, а не проверкой постфактум.
      const orderId = Number(parts[1]);
      const current = await pgOrderService.getOrder(orderId);
      if (!current) {
        await bot.editMessageText('Заказ не найден.', { chat_id: chatId, message_id: messageId });
      } else if (current.status !== 'awaiting_restaurant') {
        // Повторный клик по старой кнопке/replay после смены статуса другим
        // событием — см. header-комментарий модуля, адаптация п.2.
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
      } else {
        await bot.editMessageText(`Заказ ${current.public_code}: выберите время приготовления.`, { chat_id: chatId, message_id: messageId });
        const cookTimeMsg = await sendCookTimeButtons(bot, chatId, orderId, current.public_code);
        // Кнопки времени — теперь ТЕКУЩЕЕ кликабельное сообщение заказа:
        // именно его, а не уже отредактированное выше, должен чистить
        // таймаут/отмена клиентом, если время так и не выберут (задание,
        // раздел 1.1).
        if (cookTimeMsg && cookTimeMsg.message_id != null) {
          try {
            await trackOrderMessage(orderId, chatId, cookTimeMsg.message_id);
          } catch (err) {
            // Кнопки выбора времени УЖЕ отправлены — та же логика, что и в
            // handleOrderNew: сбой здесь не должен превратиться в "Ошибка: ..."
            // ресторану, который на самом деле успешно нажал «Принять».
            console.error(`[bot/postgresql] trackOrderMessage(accept) failed for order ${orderId}:`, err.message);
          }
        }
      }
    } else if (action === 'decline') {
      const orderId = Number(parts[1]);
      const current = await pgOrderService.getOrder(orderId);
      if (!current) {
        await bot.editMessageText('Заказ не найден.', { chat_id: chatId, message_id: messageId });
      } else if (current.status !== 'awaiting_restaurant') {
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
      } else {
        await pgOrderService.restaurantDecline(orderId);
        await bot.editMessageText('Заказ отклонён, деньги клиенту возвращены.', { chat_id: chatId, message_id: messageId });
        await untrackOrderMessage(orderId); // терминально — таймауту больше нечего чистить
      }
    } else if (action === 'cook_time') {
      // ШАГ 2 из двух: именно здесь заказ реально принимается
      // (awaiting_restaurant -> accepted -> preparing) вместе с выбранным
      // временем. Идемпотентность: если заказ уже не ждёт ресторан (второй
      // клик по той же кнопке, replay, параллельный клик другого сотрудника
      // группы) — ничего не делаем и честно об этом сообщаем; сами переходы
      // дополнительно защищены atomic conditional UPDATE в orderService.
      const orderId = Number(parts[1]);
      const minutes = Number(parts[2]);
      if (!COOK_TIME_OPTIONS_MIN.includes(minutes)) {
        await bot.answerCallbackQuery(query.id, { text: 'Недопустимое время приготовления.', show_alert: true });
        return;
      }
      const current = await pgOrderService.getOrder(orderId);
      if (!current) {
        await bot.editMessageText('Заказ не найден.', { chat_id: chatId, message_id: messageId });
      } else if (current.status !== 'awaiting_restaurant') {
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
      } else {
        await pgOrderService.restaurantAccept(orderId);
        await pgOrderService.restaurantAdvance(orderId, 'preparing', { estimatedMinutes: minutes });
        await bot.editMessageText(`Заказ ${current.public_code} принят. Готовится — клиенту показано «${minutes} мин».`, { chat_id: chatId, message_id: messageId });
        await sendProgressButton(bot, chatId, orderId, 'preparing');
        // Заказ покинул awaiting_restaurant окончательно — таймаут 5 минут
        // больше не применим, дальше следит только advance ниже (у него свой
        // pre-check через messageId из самого клика, bot_order_messages
        // здесь больше не нужна).
        await untrackOrderMessage(orderId);
      }
    } else if (action === 'advance') {
      // advance:nextStatus:orderId (courier -> delivered, или preparing -> delivered напрямую для самовывоза)
      const nextStatus = parts[1];
      const orderId = Number(parts[2]);
      let updated;
      try {
        updated = await pgOrderService.restaurantAdvance(orderId, nextStatus);
      } catch (err) {
        // Устаревшая/повторная кнопка (заказ уже продвинут этим же кликом с
        // другого устройства, или статус изменён из HQ) — тот же принцип
        // "не оставлять кликабельную кнопку", что и у accept/decline выше,
        // вместо голого алерта, после которого кнопка оставалась живой
        // (задание, раздел 1.1 "проверить все callback-сценарии").
        console.error(`[bot/postgresql] advance failed for order ${orderId}:`, err.message);
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
        await bot.answerCallbackQuery(query.id);
        return;
      }
      const labels = updated.fulfillment_type === 'pickup'
        ? { delivered: 'Клиент забрал' }
        : { courier: 'Передал курьеру', delivered: 'Доставлен' };
      await bot.editMessageText(`Статус обновлён: ${labels[nextStatus]}`, { chat_id: chatId, message_id: messageId });
      if (nextStatus !== 'delivered') await sendProgressButton(bot, chatId, orderId, nextStatus);
    } else if (action === 'pause' || action === 'close_menu') {
      // close_menu — та же длительность-панель, что и /pause, вызванная из
      // кнопки "Закрыть ресторан" панели статуса (раздел 1.3); pause:key —
      // сам выбор длительности (общий шаг для обоих путей входа).
      if (action === 'close_menu') {
        const r = await restaurantByChat(chatId);
        if (r) {
          await bot.editMessageText('На сколько закрыть ресторан?', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [Object.keys(PAUSE_LABELS).map((key) => ({
                text: PAUSE_LABELS[key], callback_data: `pause:${key}`,
              }))],
            },
          });
        }
      } else {
        const r = await restaurantByChat(chatId);
        if (r) {
          await pgOrderService.pauseRestaurant(r.id, parts[1]);
          // Кнопка "Открыть ресторан" сразу в подтверждении — задание,
          // раздел 4: "обновлять панель после закрытия/открытия", без
          // необходимости снова вспоминать /start или /open (fallback,
          // остаётся рабочим, но больше не единственный путь назад).
          await bot.editMessageText(`Перерыв: ${PAUSE_LABELS[parts[1]]}. Вернуться раньше срока — кнопкой ниже (или /open).`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: 'Открыть ресторан', callback_data: 'reopen_now' }]] },
          });
        }
      }
    } else if (action === 'reopen_now') {
      // Кнопка "Открыть ресторан" панели статуса — то же действие, что /open.
      const r = await restaurantByChat(chatId);
      if (r) {
        await pgOrderService.resumeRestaurant(r.id);
        await bot.editMessageText(`«${r.name}» снова открыт.`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: 'Закрыть ресторан', callback_data: 'close_menu' }]] },
        });
      }
    } else if (action === 'toggle_item') {
      const id = Number(parts[1]);
      const item = await menuItemById(id);
      if (item) await db.execute('UPDATE menu_items SET is_available = 1 - is_available WHERE id = $1', [id]);
    }
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    await bot.answerCallbackQuery(query.id, { text: `Ошибка: ${err.message}`, show_alert: true });
  }
}

// ---------------------------------------------------------------------------
// createBotHandlers(bot) — навешивает обработчики на УЖЕ созданный
// bot-подобный клиент (реальный TelegramBot или тестовый fake-double).
// Не создаёт клиент сам — см. header-комментарий модуля про тестируемость.
// ---------------------------------------------------------------------------
function createBotHandlers(bot) {
  // Node EventEmitter.emit() не ждёт async-слушателей (ни настоящий
  // node-telegram-bot-api, ни pgOrderService.orderEvents тут не исключение)
  // — вызывающий markPaid()/etc. код резолвится, как только emit() вернул
  // управление, а не когда фактическая отправка в Telegram завершилась.
  // inFlight/waitForIdle() — тестовый (и только тестовый) хук, позволяющий
  // детерминированно дождаться завершения асинхронной обработки конкретного
  // order:new вместо polling/sleep в тестах; в production никем не
  // вызывается и не меняет поведение.
  const inFlight = new Set();
  const onOrderNew = (order) => {
    const p = handleOrderNew(bot, order)
      .catch((err) => {
        console.error(`[bot/postgresql] order:new handler failed for order ${order && order.public_code}:`, err.message);
        // HQ «Центр событий» — "серьёзный сбой Telegram-бота или доставки
        // Telegram-сообщения" (docs/HQ-PRODUCT-SPEC.md): ресторан не узнает
        // о заказе через бота — реальная проблема, требующая владельца,
        // независимо от sweepTimeouts (тот лишь отменит заказ через 3
        // минуты, но не объяснит ПОЧЕМУ ресторан не ответил).
        const eventLogService = require('../../services/hq/eventLogService');
        eventLogService.createEvent({
          category: 'telegram_issue',
          restaurantId: order ? order.restaurant_id : null,
          restaurantName: order ? order.restaurant_name : null,
          orderId: order ? order.id : null,
          orderPublicCode: order ? order.public_code : null,
          message: `Не удалось отправить уведомление о заказе ${order ? order.public_code : '?'} ресторану в Telegram: ${err.message}`,
        }).catch((logErr) => {
          console.error('[bot/postgresql] hq_events log failed (order:new):', logErr.message);
        });
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  };
  pgOrderService.orderEvents.on('order:new', onOrderNew);

  // «Вы пропустили заказ» (docs/HQ-PRODUCT-SPEC.md, раздел «Получение
  // нового заказа в Telegram»). Слушаем существующий order:status и
  // реагируем на timed_out (ресторан не ответил вовремя — отклонение
  // рестораном даёт declined и группе уже показано её собственным
  // сообщением) и на cancelled (клиент сам отменил заказ, пока ресторан ещё
  // не ответил). Отдельное событие в «Центре событий» HQ создаёт
  // sweepTimeouts() в orderService — здесь только уведомление самой группы,
  // дублирования нет. Оба случая ДОПОЛНИТЕЛЬНО чистят кнопки на исходном
  // сообщении заказа через bot_order_messages (Stage 28, живая находка
  // MEDIUM-2: раньше слался только новый текст, а старые "Принять"/
  // "Отклонить" оставались кликабельными — задание, раздел 1.1; Stage 29.1
  // п.2 — устойчиво к рестарту backend между отправкой и таймаутом/отменой).
  const onOrderStatus = (order) => {
    if (!order || (order.status !== 'timed_out' && order.status !== 'cancelled')) return;
    const p = (async () => {
      if (order.status === 'timed_out') {
        await clearOrderButtons(bot, order.id, `Заказ ${order.public_code} не принят вовремя — автоматически отменён.`);
      } else {
        await clearOrderButtons(bot, order.id, `Заказ ${order.public_code} отменён клиентом.`);
      }
      if (order.status !== 'timed_out') return; // "пропустили заказ" — только для реального таймаута, не для отмены клиентом
      const restaurant = await restaurantById(order.restaurant_id);
      if (!restaurant || !restaurant.telegram_chat_id) return;
      await bot.sendMessage(
        restaurant.telegram_chat_id,
        `Вы пропустили заказ ${order.public_code} — ответа не было 5 минут, заказ автоматически отменён.`,
      );
    })()
      .catch((err) => {
        console.error(`[bot/postgresql] order:status ${order.status} notify failed for ${order && order.public_code}:`, err.message);
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  };
  pgOrderService.orderEvents.on('order:status', onOrderStatus);

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    try {
      const code = (match[1] || '').trim().toUpperCase();
      if (!code) {
        // Уже подключённый ресторан — bare /start теперь основной путь к
        // управлению паузой (задание, раздел 1.3), а не повтор инструкции
        // по коду, которая для уже подключённого чата бессмысленна.
        const existing = await restaurantByChat(msg.chat.id);
        if (existing) {
          await sendRestaurantStatusPanel(bot, msg.chat.id, existing);
          return;
        }
        await bot.sendMessage(msg.chat.id,
          'Здравствуйте! Это бот YAAM для ресторанов.\n' +
          'Код подключения выдаёт команда YAAM при добавлении вашего ресторана в админке — пришлите его командой:\n/start ВАШКОД');
        return;
      }
      // Привязка идёт ЧЕРЕЗ telegramLinkService (docs/HQ-PRODUCT-SPEC.md):
      // код одноразовый (гасится той же транзакцией) и один чат не может
      // обслуживать два ресторана — оба правила живут в сервисе, а не здесь.
      const telegramLinkService = require('../../services/hq/telegramLinkService');
      let restaurant;
      try {
        restaurant = await telegramLinkService.consumeConnectCode(code, msg.chat.id, msg.chat.title || null);
      } catch (err) {
        await bot.sendMessage(msg.chat.id, err.message);
        return;
      }
      if (!restaurant) {
        await bot.sendMessage(msg.chat.id, 'Код не найден или уже использован. Запросите новый код у YAAM.');
        return;
      }
      await bot.sendMessage(msg.chat.id, `Готово! «${restaurant.name}» подключён. Сюда будут приходить новые заказы.`);
      // Панель статуса сразу после подключения — задание, раздел 4:
      // "показывать панель после подключения", чтобы сотруднику не нужно
      // было заранее знать, что для управления паузой нужно отправить
      // bare /start ещё раз.
      await sendRestaurantStatusPanel(bot, msg.chat.id, restaurant);
    } catch (err) {
      console.error('[bot/postgresql] /start failed:', err.message);
    }
  });

  // Перерыв — не мгновенное выключение, а выбор одного из трёх пресетов;
  // снимается сам по истечении (server.js setInterval -> sweepPauseExpiry,
  // вне scope этого изолированного bot-модуля).
  bot.onText(/\/pause/, async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      await bot.sendMessage(msg.chat.id, 'На сколько уйти на перерыв?', {
        reply_markup: {
          inline_keyboard: [Object.keys(PAUSE_LABELS).map((key) => ({
            text: PAUSE_LABELS[key], callback_data: `pause:${key}`,
          }))],
        },
      });
    } catch (err) {
      console.error('[bot/postgresql] /pause failed:', err.message);
    }
  });

  bot.onText(/\/open/, async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      await pgOrderService.resumeRestaurant(r.id);
      await bot.sendMessage(msg.chat.id, `«${r.name}» снова открыт.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Закрыть ресторан', callback_data: 'close_menu' }]] },
      });
    } catch (err) {
      console.error('[bot/postgresql] /open failed:', err.message);
    }
  });

  bot.onText(/\/stoplist/, async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      const items = await menuItemsByRestaurant(r.id);
      if (!items.length) {
        await bot.sendMessage(msg.chat.id, 'В меню пока нет блюд.');
        return;
      }
      await bot.sendMessage(msg.chat.id, 'Нажмите на блюдо, чтобы поставить/снять со стоп-листа:', {
        reply_markup: {
          inline_keyboard: items.map((i) => [{
            // CLAUDE.md, "без emoji в UI" — допустимый текстовый символ ✓
            // вместо цветных ✅/🚫 (Stage 28, находка MEDIUM-3).
            text: `${i.is_available ? '✓' : '—'} ${i.name}`,
            callback_data: `toggle_item:${i.id}`,
          }]),
        },
      });
    } catch (err) {
      console.error('[bot/postgresql] /stoplist failed:', err.message);
    }
  });

  // Возвращает промис (не { }-блок) — нужно тестам, вызывающим этот
  // listener напрямую (см. FakeTelegramBot.triggerCallbackQuery), чтобы
  // детерминированно дождаться завершения обработки без polling/sleep;
  // реальный node-telegram-bot-api это значение просто игнорирует (тот же
  // fire-and-forget, что и everywhere else в этом модуле/оригинале).
  bot.on('callback_query', (query) =>
    handleCallbackQuery(bot, query).catch((err) => {
      console.error('[bot/postgresql] callback_query handler failed:', err.message);
    })
  );

  bot.on('polling_error', (err) => {
    console.error('[bot/postgresql] polling error:', err.message);
    // HQ «Центр событий» — весь бот потерял связь с Telegram (не одно
    // сообщение, а вся доставка ресторанам), задание, раздел 3.
    const eventLogService = require('../../services/hq/eventLogService');
    eventLogService.createEvent({
      category: 'telegram_issue',
      message: `Telegram-бот потерял соединение с сервером Telegram: ${err.message}`,
    }).catch((logErr) => {
      console.error('[bot/postgresql] hq_events log failed (polling_error):', logErr.message);
    });
  });

  console.log('[bot/postgresql] запущен (long polling)');

  return {
    bot,
    async stop() {
      pgOrderService.orderEvents.removeListener('order:new', onOrderNew);
      pgOrderService.orderEvents.removeListener('order:status', onOrderStatus);
      if (typeof bot.stopPolling === 'function') {
        await bot.stopPolling({ cancel: true, reason: 'YAAM graceful shutdown' });
      }
    },
    // Тестовый хук — см. комментарий у объявления inFlight выше.
    async waitForIdle() {
      await Promise.all([...inFlight]);
    },
  };
}

// Production-точка входа — тот же внешний контракт, что и SQLite startBot(token).
// options.bot — только для тестов (см. header-комментарий); production-вызов
// всегда передаёт только token.
function startBot(token, options = {}) {
  const bot = options.bot || new TelegramBot(token, { polling: true });
  return createBotHandlers(bot);
}

module.exports = { startBot, createBotHandlers };
