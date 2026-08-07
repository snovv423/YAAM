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
//
// Stage 31 (надёжность доставки и финальная UX-доводка, после живого
// Stage 30, дважды поймавшего "EFATAL: fetch failed") — пять дополнительных
// изменений:
//   5. order:new больше НЕ отправляется прямым bot.sendMessage() изнутри
//      обработчика события — идёт через botOutboxService (persistent
//      outbox, таблица bot_notifications, миграция 0010): переживает
//      рестарт backend, ограниченный retry с backoff на транзиентных
//      сетевых сбоях, диагностируемый hq_events-алерт после исчерпания
//      попыток. См. header-комментарий botOutboxService.js для полного
//      обоснования и классификации ошибок.
//   6. Сообщение заказа переструктурировано по заданию (заголовок "Заказ:"
//      вместо "Состав:", позиции без цены, единая сумма "Оплачено: N ₽"
//      внизу, опциональная строка "Чек оплаты" — см. renderOrderNewText) и
//      окно ответа увеличено с 5 до 7 минут — единственный источник
//      значения теперь RESTAURANT_RESPONSE_WINDOW_SEC из orderService.js
//      (импортируется, не дублируется).
//   7. Шаг «Принять» стал ОДНИМ вызовом editMessageText (текст + кнопки
//      выбора времени сразу в одном reply_markup) вместо двух раздельных
//      вызовов (editMessageText без кнопок + отдельный sendMessage с
//      кнопками) — раньше сбой второго вызова оставлял ресторан без единой
//      кликабельной кнопки по заказу. Один вызов физически не может
//      завершиться "наполовину".
//   8. Таймаут (`timed_out`) теперь редактирует ИСХОДНОЕ сообщение заказа
//      сразу в финальный текст «Вы пропустили заказ...» вместо двух
//      артефактов (отредактированное "не принят вовремя" + отдельное новое
//      "вы пропустили") — ровно один итоговый артефакт на одно событие.
//   9. Постоянная reply-клавиатура (не inline) с одной кнопкой "Статус
//      ресторана" — отправляется один раз при подключении (и разово при
//      следующем bare /start уже подключённого ресторана, если он видит
//      панель впервые после этого обновления); остаётся в интерфейсе
//      Telegram-клиента независимо от рестартов backend (это свойство
//      самого Telegram, не требует ничего от сервера) — решает
//      "сотрудник не должен помнить /start" без создания второй модели
//      состояния (нажатие ведёт в тот же sendRestaurantStatusPanel).

const { TelegramBot } = require('node-telegram-bot-api');
const db = require('../../db/postgresql');
const pgOrderService = require('../../services/postgresql/orderService');
const botOutboxService = require('../../services/postgresql/botOutboxService');
const {
  trackOrderMessage, untrackOrderMessage, getTrackedOrderMessage,
} = require('../../services/postgresql/botOrderMessageTracker');

const PAUSE_LABELS = { short: '33 мин', medium: '3 часа', long: '11 часов' };

// Единственный источник истины для окна ответа ресторана — orderService.js
// (Stage 31, раздел 4). Минуты вычисляются отсюда, а не хардкодятся, чтобы
// текст сообщения не мог разойтись с фактическим sweepTimeouts().
const RESPONSE_WINDOW_MINUTES = Math.round(pgOrderService.RESTAURANT_RESPONSE_WINDOW_SEC / 60);

// Постоянная (не inline) reply-клавиатура — Telegram-native механизм,
// который остаётся видимым в интерфейсе чата независимо от того, какое
// сообщение сейчас последнее и пережил ли backend рестарт (задание, раздел
// 6: "сотрудник не должен помнить и вводить /start"). Нажатие приходит как
// обычное текстовое сообщение с этим же текстом — обрабатывается тем же
// путём, что и bare /start у уже подключённого ресторана.
const MENU_BUTTON_LABEL = 'Статус ресторана';
const PERSISTENT_MENU_MARKUP = {
  keyboard: [[{ text: MENU_BUTTON_LABEL }]],
  resize_keyboard: true,
  is_persistent: true,
};

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
// Структура и порядок блоков — Stage 31, раздел 2 (заменяет предыдущую
// UX fix-stage структуру после Stage 28): номер заказа / заказ (без цены
// у каждой позиции) / комментарий / доставка-адрес / клиент-телефон /
// оплачено (единая сумма) / чек оплаты (опционально) / срок ответа.
// Заголовок состава — "Заказ:", НЕ "Состав:" (задание, раздел 2). Без
// цветных emoji (CLAUDE.md).
//
// receiptUrl — Stage 31, раздел 3: показывается СТРОГО когда он реально
// есть (payments.receipt_url, миграция 0011) — сейчас НИЧЕМ в коде не
// заполняется (mock-провайдер и текущая YooKassa-интеграция не выдают
// публичный URL чека, см. комментарий миграции), поэтому блок "Чек
// оплаты" сегодня не появляется НИКОГДА — это осознанно, не "пока не
// реализовано доделать". Появится сам, когда появится безопасный URL.
function renderOrderNewText(order, { receiptUrl = null } = {}) {
  const itemsList = order.items.map((i) => `${i.qty} × ${i.name}`).join('\n');
  const fulfillmentBlock = order.fulfillment_type === 'pickup'
    ? 'Самовывоз (курьер не нужен)'
    : `Доставка\nАдрес: ${order.address}`;
  const blocks = [
    `Заказ ${order.public_code}`,
    `Заказ:\n${itemsList}`,
    `Комментарий: ${order.comment || 'без комментария'}`,
    fulfillmentBlock,
    `Клиент: ${order.customer_name}\nТелефон: ${order.customer_phone}`,
    `Оплачено: ${order.items_total} ₽`,
  ];
  if (receiptUrl) blocks.push(`Чек оплаты: ${receiptUrl}`);
  blocks.push(`Ответьте в течение ${RESPONSE_WINDOW_MINUTES} минут, иначе заказ отменится автоматически.`);
  return blocks.join('\n\n');
}

// order:new — Stage 31, раздел 1.2: идёт через persistent outbox
// (botOutboxService), а не прямым bot.sendMessage(). Сам вызов дешёвый и
// НЕ бросает на сетевом сбое — botOutboxService.enqueueAndDispatch()
// пробует доставить сразу (тот же UX-latency, что и раньше в штатном
// случае), но при неудаче строка остаётся pending в bot_notifications и
// её подхватит scheduler-тик, в том числе после рестарта процесса. См.
// header-комментарий botOutboxService.js для полной архитектуры/retry/
// классификации ошибок/остаточного риска.
async function handleOrderNew(bot, order) {
  const restaurant = await restaurantById(order.restaurant_id);
  if (!restaurant || !restaurant.telegram_chat_id) {
    console.error(`[bot/postgresql] заказ ${order.public_code}: у ресторана "${restaurant?.name}" не подключён Telegram`);
    return;
  }
  // Чек оплаты (Stage 31, раздел 3) — сейчас всегда null (см. комментарий
  // renderOrderNewText выше), запрос не бьёт по перформансу штатного пути:
  // одна лёгкая выборка по индексированному order_id.
  const paymentRows = await db.query(
    `SELECT receipt_url FROM payments WHERE order_id = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  const receiptUrl = paymentRows[0] ? paymentRows[0].receipt_url : null;

  await botOutboxService.enqueueAndDispatch(bot, {
    dedupKey: `order:${order.id}:new`,
    orderId: order.id,
    chatId: restaurant.telegram_chat_id,
    text: renderOrderNewText(order, { receiptUrl }),
    replyMarkup: {
      inline_keyboard: [[
        { text: 'Принять', callback_data: `accept:${order.id}` },
        { text: 'Отклонить', callback_data: `decline:${order.id}` },
      ]],
    },
  });
}

// Небольшой, ОГРАНИЧЕННЫЙ inline-retry (не полноценный persistent outbox —
// заказ к этому моменту УЖЕ безопасно завершён в БД независимо от исхода
// этого вызова, задание требует устойчивость именно для order:new
// поимённо; см. STAGE31 отчёт, раздел "остаточные риски" за явным
// обоснованием этого выбора масштаба). Убирает кнопки с "текущего
// кликабельного сообщения" заказа и заменяет его текст — используется
// событиями, которые сами НЕ пришли как клик по кнопке (таймаут, отмена
// клиентом), поэтому не имеют messageId из query.message. Запись в
// bot_order_messages удаляется в любом случае (даже если сообщение не
// найдено/редактирование не удалось — повторно чистить нечего).
async function clearOrderButtons(bot, orderId, text) {
  const tracked = await getTrackedOrderMessage(orderId);
  await untrackOrderMessage(orderId);
  if (!tracked) return;
  const delays = [0, 2000, 6000];
  let lastErr = null;
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i] > 0) await new Promise((resolve) => setTimeout(resolve, delays[i])); // eslint-disable-line no-await-in-loop
    try {
      await bot.editMessageText(text, { chat_id: tracked.chatId, message_id: tracked.messageId }); // eslint-disable-line no-await-in-loop
      return;
    } catch (err) {
      lastErr = err;
      if (botOutboxService.classifyTelegramError(err) === 'permanent') break; // не имеет смысла повторять
    }
  }
  console.error(`[bot/postgresql] clearOrderButtons failed for order ${orderId}:`, botOutboxService.describeError(lastErr));
}

// docs/HQ-PRODUCT-SPEC.md, раздел «Выбор времени приготовления»: ровно три
// варианта — 30/45/60 минут, одинаковые для всех ресторанов (прежние
// значения выводились из restaurants.default_cook_minutes и у каждого
// ресторана были свои). Без выбора времени заказ НЕ считается принятым —
// см. двухшаговое «Принять» в handleCallbackQuery ниже.
const COOK_TIME_OPTIONS_MIN = [30, 45, 60];

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
      //
      // Stage 31, раздел 1.4 — ОДИН editMessageText с reply_markup сразу
      // (текст + кнопки выбора времени в одном вызове) вместо прежних двух
      // раздельных вызовов (editMessageText без кнопок, затем отдельный
      // sendMessage с кнопками времени). Раньше сбой ВТОРОГО вызова
      // оставлял ресторан вовсе без кликабельных кнопок по заказу —
      // диагностировано живым Stage 30. Один вызов либо целиком успевает,
      // либо целиком падает — "наполовину" не бывает физически. message_id
      // остаётся ТЕМ ЖЕ (это редактирование, не новое сообщение) —
      // повторный trackOrderMessage() здесь не нужен, запись от
      // handleOrderNew уже указывает на верное сообщение.
      const orderId = Number(parts[1]);
      const current = await pgOrderService.getOrder(orderId);
      if (!current) {
        await bot.editMessageText('Заказ не найден.', { chat_id: chatId, message_id: messageId });
      } else if (current.status !== 'awaiting_restaurant') {
        // Повторный клик по старой кнопке/replay после смены статуса другим
        // событием — см. header-комментарий модуля, адаптация п.2.
        await bot.editMessageText('Заказ уже обработан.', { chat_id: chatId, message_id: messageId });
      } else {
        await bot.editMessageText(`Заказ ${current.public_code}: за сколько приготовите?`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [COOK_TIME_OPTIONS_MIN.map((m) => ({ text: `${m} мин`, callback_data: `cook_time:${orderId}:${m}` }))],
          },
        });
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
        // Заказ покинул awaiting_restaurant окончательно — окно ответа
        // (RESTAURANT_RESPONSE_WINDOW_SEC) больше не применимо, дальше
        // следит только advance ниже (у него свой pre-check через messageId
        // из самого клика, bot_order_messages здесь больше не нужна).
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
  // дублирования нет.
  //
  // Stage 31, раздел 5 — РОВНО один итоговый артефакт на событие (живой
  // Stage 30 нашёл два: отредактированное "не принят вовремя" сообщение +
  // ОТДЕЛЬНОЕ новое "вы пропустили"). clearOrderButtons() сразу редактирует
  // исходное сообщение заказа в финальный текст — кнопки убраны и текст
  // окончателен ОДНИМ вызовом, второго sendMessage больше нет. Если
  // исходное сообщение не отслеживается (order:new так и не был доставлен
  // — см. botOutboxService), clearOrderButtons() ничего не отправляет:
  // рассылать "вы пропустили" в чат, который ни разу не видел сам заказ,
  // было бы вводящим в заблуждение, а не полезным (недоставленный
  // order:new уже получил свой собственный hq_events-алерт — см.
  // botOutboxService.raiseUndeliveredAlert).
  const onOrderStatus = (order) => {
    if (!order || (order.status !== 'timed_out' && order.status !== 'cancelled')) return;
    const text = order.status === 'timed_out'
      ? `Вы пропустили заказ ${order.public_code} — ответа не было ${RESPONSE_WINDOW_MINUTES} минут, заказ автоматически отменён.`
      : `Заказ ${order.public_code} отменён клиентом.`;
    const p = clearOrderButtons(bot, order.id, text)
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
          // Stage 31, раздел 6 — постоянная reply-клавиатура. Ресторан мог
          // быть подключён ДО этого обновления и никогда её не получал —
          // bare /start (пользовательская команда, НЕ технический рестарт
          // backend — задание прямо разрешает это отличие: "не отправлять
          // панель заново при каждом техническом рестарте, если это
          // создаёт спам") безопасный момент довыдать её. Повторная отправка
          // уже показанной reply-клавиатуры с тем же текстом кнопки
          // визуально не создаёт "нового меню" в Telegram-клиенте — та же
          // клавиатура просто остаётся на месте.
          await bot.sendMessage(msg.chat.id, 'Быстрое управление рестораном закреплено ниже.', {
            reply_markup: PERSISTENT_MENU_MARKUP,
          });
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
      // Постоянная reply-клавиатура (Stage 31, раздел 6) — прикреплена
      // сразу к первому же сообщению после подключения: единственный
      // естественный момент её завести, дальше она остаётся в интерфейсе
      // Telegram-клиента сама по себе (свойство самого Telegram, не
      // требует ничего от backend — переживает и рестарт процесса).
      await bot.sendMessage(msg.chat.id, `Готово! «${restaurant.name}» подключён. Сюда будут приходить новые заказы.`, {
        reply_markup: PERSISTENT_MENU_MARKUP,
      });
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

  // Нажатие постоянной reply-клавиатуры (Stage 31, раздел 6) приходит как
  // обычное текстовое сообщение с текстом кнопки — тот же путь, что и bare
  // /start у уже подключённого ресторана (переиспользует
  // sendRestaurantStatusPanel, никакой второй модели состояния не заводит).
  // Клавиатуру повторно не шлём — она уже закреплена в интерфейсе клиента,
  // повторная отправка на каждое нажатие была бы тем самым "спамом",
  // который задание прямо просит не создавать.
  bot.onText(new RegExp(`^${MENU_BUTTON_LABEL}$`), async (msg) => {
    try {
      const r = await restaurantByChat(msg.chat.id);
      if (!r) {
        await bot.sendMessage(msg.chat.id, 'Сначала подключите ресторан: /start КОД');
        return;
      }
      // Устаревшее нажатие (клавиатура была закреплена давно, состояние с
      // тех пор могло поменяться НЕ через это сообщение — например, из HQ
      // или другим сотрудником) отвечает АКТУАЛЬНЫМ состоянием: сам
      // sendRestaurantStatusPanel всегда перечитывает ресторан заново
      // (restaurantById fresh-запрос), а не полагается на что-то
      // запомненное на момент показа клавиатуры.
      await sendRestaurantStatusPanel(bot, msg.chat.id, r);
    } catch (err) {
      console.error('[bot/postgresql] menu button failed:', err.message);
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
