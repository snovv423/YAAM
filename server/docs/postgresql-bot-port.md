# PostgreSQL bot port — server/bot/postgresql/index.js (Production Switch Stage 3)

Подробности, для которых не хватило места в `postgresql-migration-status.md`.
Компактная сводка там же, ссылка сюда.

## Архитектурная граница

Модуль **не импортируется** ни из `server.js`, ни из `bot/index.js` (SQLite).
`bot/index.js` (SQLite) не изменён ни на строку. Не открывает SQLite
`DatabaseSync`, не импортирует `server/db/index.js`, `services/orderService.js`
(SQLite), `services/orderAccessService.js` — подтверждено статическим тестом
(`A2` в `botStage3.test.js`), тем же приёмом, что уже применён к
`routes/postgresql/api.js` в Stage 1.

Доступ к данным — только `db.query()`/`db.execute()` (`server/db/postgresql`)
для ресторанов/меню (тот же контур, что и в SQLite-оригинале: эти запросы
никогда не проходили через `orderService.js`) и уже перенесённые функции
`services/postgresql/orderService.js` (`restaurantAccept`/`restaurantDecline`/
`restaurantAdvance`/`getOrder`) плюс две НОВЫЕ функции, добавленные этим же
коммитом: `pauseRestaurant`/`resumeRestaurant`.

## Карта команд/callback SQLite-оригинала и что перенесено

| Update | SQL/orderService | Перенесено |
|---|---|---|
| `/start [код]` | `SELECT restaurants WHERE connect_code=?`, `UPDATE restaurants SET telegram_chat_id=?` | Да, дословно |
| `/pause` | `SELECT restaurants WHERE telegram_chat_id=?` | Да |
| `/open` | `orderService.resumeRestaurant(r.id)` | Да (новая PG-функция) |
| `/stoplist` | `SELECT menu_items WHERE restaurant_id=? ORDER BY sort_order` | Да |
| `order:new` (событие) | `SELECT restaurants WHERE id=?`, `bot.sendMessage` | Да, payload Stage 2 |
| `accept:<id>` | `orderService.restaurantAccept` | Да + pre-check (см. ниже) |
| `decline:<id>` | `orderService.restaurantDecline` | Да + pre-check (см. ниже) |
| `cook_time:<id>:<min>` | `orderService.restaurantAdvance(id,'preparing',{estimatedMinutes})` | Да |
| `advance:<status>:<id>` | `orderService.restaurantAdvance(id,status)` | Да |
| `pause:<key>` | `orderService.pauseRestaurant(r.id,key)` | Да (новая PG-функция) |
| `toggle_item:<id>` | `SELECT menu_items WHERE id=?`, `UPDATE ... is_available=1-is_available` | Да |

Все тексты, callback_data, эмодзи — дословная копия. Ни одна команда/UX не
придуманы заново.

## Прямые SQL-запросы: было (SQLite) → стало (PostgreSQL)

8 мест прямого доступа к данным в оригинале (все — `db.prepare()`), все
заменены на параметризованные `$1,$2...` PostgreSQL-запросы:

1. `restaurantByChat` (SELECT restaurants WHERE telegram_chat_id)
2. `/start`: SELECT restaurants WHERE connect_code
3. `/start`: UPDATE restaurants SET telegram_chat_id
4. `/stoplist`: SELECT menu_items WHERE restaurant_id
5. `order:new`: SELECT restaurants WHERE id
6. `toggle_item`: SELECT menu_items WHERE id
7. `toggle_item`: UPDATE menu_items SET is_available
8. `sendCookTimeButtons`/`sendProgressButton`: SELECT restaurants WHERE id (переиспользует restaurantById)

Плюс два новых SQL-помещения в `services/postgresql/orderService.js`
(`pauseRestaurant`/`resumeRestaurant`), которых не было в перечне SQLite-бота
напрямую (в SQLite они лежат в `orderService.js`, не в `bot/index.js`) —
сохранена та же архитектурная раскладка.

## Новые PostgreSQL helpers, добавленные этим коммитом

- `services/postgresql/orderService.js`: `pauseRestaurant(restaurantId, presetKey)`,
  `resumeRestaurant(restaurantId)`, `PAUSE_PRESETS_MIN` — дословные асинхронные
  аналоги SQLite-версии, однострочные conditional/безусловные UPDATE, без
  `db.transaction()` (нет многошаговой атомарности для защиты). Не входили ни
  в одну волну и не в Stage 1/2 — были явно названы будущим "Stage 5" в
  прежней последовательности, но объективно нужны боту уже в Stage 3
  (`/pause`, `/open`) — минимальный, точечный перенос, не общий рефакторинг.
  `sweepPauseExpiry` НЕ перенесён — это периодический свип, вызываемый из
  `server.js` `setInterval`, а не из бота; вне scope изолированного
  bot-модуля.
- `bot/postgresql/index.js`: `restaurantByChat`/`restaurantByConnectCode`/
  `restaurantById`/`menuItemsByRestaurant`/`menuItemById` — прямые
  PostgreSQL-запросы, живущие в самом bot-модуле (тот же архитектурный
  контур, что и `routes/postgresql/api.js` для ресторанов/меню).

## Две намеренные, документированные адаптации (не изменение продукта)

1. **Async-переход.** Все SQLite-синхронные вызовы → `await db.query()`/
   `db.execute()`/orderService-функции — неизбежное следствие `pg`-драйвера.
2. **Pre-check статуса перед `accept`/`decline`.** SQLite-оригинал слепо
   вызывает `restaurantAccept`/`restaurantDecline` и ВСЕГДА показывает
   "успех" (даже если это был тихий no-op — обе функции не бросают на
   недопустимом статусе). Буквальный перенос означал бы: повторный клик на
   уже принятом заказе повторно отправляет "выберите время готовки"
   ресторану — дублирующее уведомление, которое задание Stage 3 явно просит
   предотвратить ("защита от повторного клика", "обработка уже изменённого
   статуса", "никакой двойной эмиссии/двойного уведомления"). Решение: перед
   мутацией читается текущий статус (`getOrder`); если он уже не
   `awaiting_restaurant` — короткий ответ "Заказ уже обработан." вместо
   полного success-flow. `advance`/`cook_time` такой правки не потребовали —
   `restaurantAdvance()` уже бросает на недопустимом переходе, что
   ГАРАНТИРОВАННО (через уже существующий `catch`-блок) предотвращает
   повторное уведомление тем же способом, что и SQLite-оригинал.

   Эта проверка снижает, но НЕ устраняет теоретически полностью гонку под
   истинно одновременными (не последовательными) кликами — окно между
   pre-check чтением и мутацией физически существует. Данные при этом
   ВСЕГДА безопасны независимо от этого окна (сама мутация — атомарный
   conditional UPDATE, уже доказанный exactly-once в Wave 1/2) — риск
   ограничен исключительно возможным редким лишним Telegram-сообщением, не
   потерей/порчей данных. Живо доказано `D7`/`D8` (конкурентные клики) и
   отдельным 20-итерационным стресс-прогоном — 0 повреждений данных на всех
   прогонах.

## Событийный слой

Bot подписывается на `pgOrderService.orderEvents.on('order:new', ...)`.
Обработчик обёрнут в `.catch()` — ошибка Telegram-отправки ОДНОГО
уведомления не становится необработанным отклонением промиса и не мешает
обработке следующих событий (SQLite-оригинал такой защиты не имеет — голый
`bot.sendMessage(...)` без `await`/`catch` внутри синхронного listener'а;
минимальная, документированная адаптация под более network-failure-prone
асинхронный путь, продуктовая семантика не меняется).

`createBotHandlers(bot)` возвращает `{ bot, stop(), waitForIdle() }`:
- `stop()` — снимает `order:new` listener (`removeListener`), тестами
  подтверждено отсутствие накопления при повторной инициализации.
- `waitForIdle()` — тестовый (только тестовый, в production никем не
  вызывается) хук: `EventEmitter.emit()` не ждёт async-слушателей — без
  этого хука тесты не могли бы детерминированно дождаться завершения
  асинхронной обработки `order:new` без polling/sleep.

## Известные, УНАСЛЕДОВАННЫЕ от SQLite-оригинала ограничения (НЕ устранены в Stage 3)

Оба этих пробела существуют идентично в `bot/index.js` (SQLite) — Stage 3
переносит их дословно, не вводит и не устраняет, в соответствии с явным
требованием задания "не менять продуктовую семантику" и "не принимать
самостоятельно новое продуктовое решение":

1. **Нет проверки принадлежности ресторана.** `accept`/`decline`/`cook_time`/
   `advance`/`toggle_item` не проверяют, что вызывающий Telegram-чат
   действительно управляет данным `orderId`/`menuItemId` — orderId/itemId
   берутся из `callback_data` напрямую. В реальном использовании
   `callback_data` виден только чату, которому реально отправлено
   уведомление, поэтому практическая эксплуатируемость низкая, но
   инвариант не выражен явно ни в коде, ни в схеме. Живо задокументировано
   тестами `D10`/`E4` (демонстрируют РЕАЛЬНОЕ, не гипотетическое поведение).
2. **`telegram_chat_id` не `UNIQUE`.** Ни в SQLite, ни в PostgreSQL схеме нет
   ограничения, предотвращающего повторную привязку одного чата к другому
   ресторану без отвязки первого — `/start` просто перезаписывает
   `telegram_chat_id` для ресторана, соответствующего коду, никак не
   проверяя предыдущие привязки того же чата. Задокументировано тестом `B5`.

Оба пункта — существующие продуктовые решения (или их отсутствие),
требующие отдельного явного продуктового/security-решения для исправления
(вероятная схема: добавить `UNIQUE` на `telegram_chat_id` + FK-based
ownership check на мутирующих callback) — вне мандата Stage 3.
