'use strict';

// YAAM — PostgreSQL admin router, Production Switch Stage 4 (изолированный порт).
//
// Этот модуль НЕ импортируется ни из server.js, ни из server/routes/admin.js
// (SQLite) — та же архитектурная граница, что у routes/postgresql/api.js
// (Stage 1) и bot/postgresql/index.js (Stage 3). SQLite-admin остаётся
// полностью нетронутым и единственным, реально подключённым к server.js.
// Этот модуль не открывает SQLite DatabaseSync ни прямо, ни как побочный
// эффект require() — не импортирует server/db/index.js,
// server/services/orderService.js (SQLite).
//
// Basic Auth здесь НЕ реализован — в SQLite-оригинале Basic Auth ТОЖЕ не
// внутри routes/admin.js, а исключительно в server.js в точке монтирования
// (`app.use('/admin', basicAuth({...}), adminRoutes)`, см. server.js). Этот
// роутер, как и оригинал, авторизацию-агностичен по конструкции — она
// применяется снаружи, на уровне server.js, который в этой задаче не
// меняется и не подключает этот файл. Тесты Stage 4 воспроизводят ТУ ЖЕ
// схему монтирования в собственном тестовом Express-приложении (см.
// server/test/postgresql/adminStage4.test.js), не трогая production server.js.
//
// Доступ к данным — только PostgreSQL: db.query()/db.execute()
// (server/db/postgresql/index.js) для restaurants/categories/menu_items/
// orders (тот же архитектурный контур, что и в SQLite-оригинале — прямые
// запросы, не через orderService.js, кроме pause/resume) и уже перенесённые
// функции server/services/postgresql/orderService.js (pauseRestaurant/
// resumeRestaurant — добавлены Stage 3, здесь используются, не изменяются).
//
// server/admin/layout.js переиспользуется НАПРЯМУЮ (не дублируется) — это
// чистая, безсайд-эффектная HTML-шаблонная функция без единой зависимости
// от БД (ни SQLite, ни PostgreSQL), поэтому её импорт сюда НЕ нарушает
// границу изоляции "не смешивать SQLite и PostgreSQL в одном модуле",
// установленную с Wave 4/5 — тот же принцип, каким Stage 3 переиспользовал
// класс TelegramBot напрямую.
//
// Полный аудит SQLite-оригинала (281 строка, 14 route-регистраций, 17 мест
// прямого SQLite-запроса) показал, что часть сценариев, ожидаемых заданием
// Stage 4 ("ручная смена статуса заказа", "платёжный статус", "возвраты",
// "block/unblock", "детали заказа", "hit", редактирование/удаление
// категорий и блюд, редактирование цены отдельным экшеном), В РЕАЛЬНОМ КОДЕ
// НЕ СУЩЕСТВУЕТ — admin.js сегодня умеет только: dashboard, CRUD-CREATE (не
// edit/delete) ресторанов/категорий/блюд, open/pause ресторана,
// toggle-available блюда, read-only списки заказов и оценок. Ни одна из
// перечисленных отсутствующих функций не добавлена здесь — задание прямо
// требует "не добавлять новые функции админки", источником истины считается
// фактический код, не ожидаемый список. Подробности — см.
// server/docs/postgresql-admin-port.md.

const express = require('express');
const crypto = require('node:crypto');
const db = require('../../db/postgresql');
const { layout } = require('../../admin/layout');
const pgOrderService = require('../../services/postgresql/orderService');

const router = express.Router();

const PAUSE_LABELS = { short: '33 мин', medium: '3 часа', long: '11 часов' };

// Дословная копия esc() из SQLite-оригинала — чистая функция, ноль
// DB-зависимости, поведение идентично независимо от движка.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// НОВОЕ (диалектное различие, документировано в postgresql-admin-port.md,
// раздел "Форматирование дат"): SQLite хранит created_at/paused_until как
// TEXT в формате "YYYY-MM-DD HH:MM:SS" (UTC) — оригинал просто
// интерполирует эту строку напрямую (esc(o.created_at)). PostgreSQL-схема
// использует TIMESTAMPTZ, и `pg`-драйвер возвращает такие колонки как
// нативные JS Date, а не строки — String(date) дал бы совершенно другой,
// длинный локализованный формат, ломая визуальный контракт админки. Эта
// функция воспроизводит ТОТ ЖЕ "YYYY-MM-DD HH:MM:SS"-формат (в UTC, как и
// исходная SQLite-строка) из полученного Date.
function formatDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Дословная копия ЛОГИКИ statusBadge() из SQLite-оригинала — единственное
// отличие: paused_until здесь УЖЕ настоящий UTC Date (pg-драйвер), не строка
// в SQLite-формате, которую оригинал парсит вручную (`.replace(' ','T')+'Z'`)
// перед тем же самым .getHours()/.getMinutes() (локальное время сервера —
// то же самое НАМЕРЕНИЕ, что и в оригинале, просто без промежуточного
// строкового парсинга, которое здесь не нужно).
function statusBadge(r) {
  if (r.is_open) return '<span class="badge open">Открыт</span>';
  if (r.paused_until) {
    const until = r.paused_until instanceof Date ? r.paused_until : new Date(r.paused_until);
    const hh = String(until.getHours()).padStart(2, '0');
    const mm = String(until.getMinutes()).padStart(2, '0');
    return `<span class="badge paused">Перерыв до ${hh}:${mm}</span>`;
  }
  return '<span class="badge closed">Закрыт</span>';
}

// --- Дашборд "Сегодня" ---
router.get('/', async (req, res) => {
  try {
    // date(created_at) = date('now') в SQLite всегда сравнивает UTC-даты
    // (SQLite не имеет понятия часового пояса, `now` — всегда UTC).
    // PostgreSQL-эквивалент явно приводит обе стороны к UTC через
    // AT TIME ZONE 'UTC', не полагаясь на session timezone пула — иначе
    // сравнение оказалось бы зависимым от конфигурации подключения.
    const todayRows = await db.query(`
      SELECT COUNT(*)::int AS cnt,
             COALESCE(SUM(items_total),0)::int AS revenue,
             COALESCE(SUM(commission_amount),0)::int AS commission
      FROM orders
      WHERE (created_at AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date
        AND status NOT IN ('cancelled','declined','timed_out','payment_failed')
    `);
    const today = todayRows[0];
    // COUNT/SUM в PostgreSQL продвигаются до bigint, который `pg` по
    // умолчанию отдаёт строкой (защита от потери точности) — явный ::int
    // здесь обязателен, иначе today.cnt/orders_cnt/cancelled_cnt пришли бы
    // строками, а не числами (задание, раздел "SQL и DTO-совместимость",
    // п.1). GROUP BY r.id (без перечисления остальных r.* колонок) — валиден
    // в PostgreSQL по функциональной зависимости через PRIMARY KEY, тот же
    // паттерн уже живо проверен в routes/postgresql/api.js (Stage 1).
    const perRestaurant = await db.query(`
      SELECT r.name,
             COUNT(o.id)::int AS orders_cnt,
             SUM(CASE WHEN o.status IN ('cancelled','declined','timed_out') THEN 1 ELSE 0 END)::int AS cancelled_cnt,
             r.rating, r.rating_count
      FROM restaurants r LEFT JOIN orders o ON o.restaurant_id = r.id
      GROUP BY r.id ORDER BY orders_cnt DESC
    `);

    res.send(layout('Сегодня', `
      <h1>Сегодня</h1>
      <div class="row">
        <div class="panel"><div style="color:var(--txt2);font-size:12px">Заказов</div><div style="font-size:28px;font-weight:800">${today.cnt}</div></div>
        <div class="panel"><div style="color:var(--txt2);font-size:12px">Оборот</div><div style="font-size:28px;font-weight:800">${today.revenue} ₽</div></div>
        <div class="panel"><div style="color:var(--txt2);font-size:12px">Комиссия YAAM</div><div style="font-size:28px;font-weight:800">${today.commission} ₽</div></div>
      </div>
      <div class="panel">
        <h2 style="font-size:15px;margin-top:0">Контроль качества по ресторанам</h2>
        <table>
          <tr><th>Ресторан</th><th>Заказов всего</th><th>Отмен</th><th>Рейтинг</th></tr>
          ${perRestaurant.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.orders_cnt}</td><td>${r.cancelled_cnt || 0}</td><td>★ ${r.rating?.toFixed(1) ?? '—'} · ${r.rating_count}</td></tr>`).join('')}
        </table>
      </div>
    `));
  } catch (err) {
    console.error('[admin-postgresql] GET / failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// --- Рестораны: список ---
router.get('/restaurants', async (req, res) => {
  try {
    const list = await db.query('SELECT * FROM restaurants ORDER BY id DESC');
    res.send(layout('Рестораны', `
      <h1>Рестораны</h1>
      <p><a class="btn" href="/admin/restaurants/new">+ Добавить ресторан</a></p>
      <table>
        <tr><th>Название</th><th>Города</th><th>Статус</th><th>Код подключения бота</th><th></th></tr>
        ${list.map((r) => `<tr>
          <td>${esc(r.name)}</td>
          <td>${esc(JSON.parse(r.cities || '[]').join(', '))}</td>
          <td>${statusBadge(r)}</td>
          <td>${r.telegram_chat_id ? '✅ подключён' : `<code>${esc(r.connect_code || '—')}</code>`}</td>
          <td><a class="btn" href="/admin/restaurants/${r.id}/edit">Редактировать</a></td>
        </tr>`).join('')}
      </table>
    `));
  } catch (err) {
    console.error('[admin-postgresql] GET /restaurants failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

router.get('/restaurants/new', (req, res) => {
  res.send(layout('Новый ресторан', `
    <h1>Добавить ресторан</h1>
    <form method="post" action="/admin/restaurants" class="panel">
      <label>Название</label><input name="name" required>
      <label>Кухня (для карточки)</label><input name="cuisine" placeholder="Шашлык · Чеченская кухня">
      <label>Фото (URL)</label><input name="photo_url" placeholder="https://...">
      <label>Города (через запятую)</label><input name="cities" placeholder="Грозный, Аргун" required>
      <label>Адрес точки (виден клиенту при выборе "Самовывоз")</label><input name="address" placeholder="г. Грозный, ул. ..., д. ...">
      <label>Часы работы</label><input name="hours" placeholder="10:00–23:00">
      <label>Телефон (виден клиенту после оформления заказа)</label><input name="phone" placeholder="+7 928 000-00-00">
      <div class="row">
        <div><label>Доставка, ₽ (справочно для клиента, в онлайн-оплату не входит)</label><input name="delivery_price" type="number" value="150"></div>
        <div><label>Мин. заказ, ₽</label><input name="min_order" type="number" value="500"></div>
      </div>
      <label>Время готовки по умолчанию, мин (бот предложит его и ±10/+15 на выбор)</label><input name="default_cook_minutes" type="number" value="40">
      <button type="submit">Создать</button>
    </form>
  `));
});

router.post('/restaurants', async (req, res) => {
  try {
    const { name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes } = req.body;
    // connect_code имеет UNIQUE-ограничение в обеих схемах; SQLite-оригинал
    // не обрабатывает коллизию отдельно (крайне маловероятна — 16^6
    // комбинаций), сырое исключение дошло бы до default Express error
    // handler. Здесь та же вероятность коллизии не изменена (не добавлен
    // retry — задание не просит новую бизнес-логику), но исключение (23505
    // или любое другое) перехватывается общим catch и не протекает наружу
    // сырым текстом (задание, раздел "Безопасность", п.5) — то же наблюдаемое
    // "создание не удалось", только чистое сообщение вместо трассировки.
    const citiesJson = JSON.stringify(String(cities || '').split(',').map((c) => c.trim()).filter(Boolean));
    const connectCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    const inserted = await db.execute(
      `INSERT INTO restaurants (name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes, connect_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [name, cuisine || '', photo_url || '', citiesJson, address || '', hours || '', phone || '',
        Number(delivery_price) || 0, Number(min_order) || 0, Number(default_cook_minutes) || 40, connectCode]
    );
    res.redirect(`/admin/restaurants/${inserted.rows[0].id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /restaurants failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

router.get('/restaurants/:id/edit', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM restaurants WHERE id = $1', [req.params.id]);
    const r = rows[0];
    if (!r) return res.status(404).send('Не найдено');
    const categories = await db.query('SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order', [r.id]);
    const items = await db.query('SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order', [r.id]);

    res.send(layout(r.name, `
      <h1>${esc(r.name)} ${r.telegram_chat_id ? '' : `<span class="badge closed" title="Ресторан ещё не написал боту код подключения">код: ${esc(r.connect_code)}</span>`}</h1>

      <form method="post" action="/admin/restaurants/${r.id}" class="panel">
        <label>Название</label><input name="name" value="${esc(r.name)}" required>
        <label>Кухня</label><input name="cuisine" value="${esc(r.cuisine)}">
        <label>Фото (URL)</label><input name="photo_url" value="${esc(r.photo_url)}">
        <label>Города (через запятую)</label><input name="cities" value="${esc(JSON.parse(r.cities || '[]').join(', '))}">
        <label>Адрес точки (виден клиенту при выборе "Самовывоз")</label><input name="address" value="${esc(r.address)}" placeholder="г. Грозный, ул. ..., д. ...">
        <label>Часы работы</label><input name="hours" value="${esc(r.hours)}">
        <label>Телефон (виден клиенту после оформления заказа)</label><input name="phone" value="${esc(r.phone)}" placeholder="+7 928 000-00-00">
        <div class="row">
          <div><label>Доставка, ₽ (справочно для клиента, в онлайн-оплату не входит)</label><input name="delivery_price" type="number" value="${r.delivery_price}"></div>
          <div><label>Мин. заказ, ₽</label><input name="min_order" type="number" value="${r.min_order}"></div>
        </div>
        <label>Время готовки по умолчанию, мин</label><input name="default_cook_minutes" type="number" value="${r.default_cook_minutes}">
        <button type="submit">Сохранить</button>
      </form>

      <div class="panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${r.is_open ? '0' : '14px'}">
          <span>Статус: ${statusBadge(r)}</span>
          ${r.is_open ? '' : `<form method="post" action="/admin/restaurants/${r.id}/resume" style="margin:0"><button type="submit">Открыть сейчас</button></form>`}
        </div>
        ${r.is_open ? `
        <label style="margin-top:0">Уйти на перерыв</label>
        <div class="row">
          ${Object.keys(PAUSE_LABELS).map((key) => `<form method="post" action="/admin/restaurants/${r.id}/pause"><input type="hidden" name="preset" value="${key}"><button class="ghost" type="submit" style="width:100%">${PAUSE_LABELS[key]}</button></form>`).join('')}
        </div>` : ''}
      </div>

      <div class="panel">
        <h2 style="font-size:15px;margin-top:0">Категории меню</h2>
        <table>
          ${categories.map((c) => `<tr><td>${esc(c.name)}</td></tr>`).join('') || '<tr><td style="color:var(--txt2)">Категорий пока нет</td></tr>'}
        </table>
        <form method="post" action="/admin/restaurants/${r.id}/categories" class="row">
          <input name="name" placeholder="Название категории" required>
          <button type="submit" style="flex:0 0 auto">+ Добавить</button>
        </form>
      </div>

      <div class="panel">
        <h2 style="font-size:15px;margin-top:0">Блюда</h2>
        <table>
          <tr><th>Название</th><th>Категория</th><th>Цена</th><th>В наличии</th><th></th></tr>
          ${items.map((i) => {
            const cat = categories.find((c) => c.id === i.category_id);
            return `<tr>
              <td>${esc(i.name)}</td><td>${esc(cat ? cat.name : '—')}</td><td>${i.price} ₽</td>
              <td><span class="badge ${i.is_available ? 'open' : 'closed'}">${i.is_available ? 'да' : 'стоп-лист'}</span></td>
              <td><form method="post" action="/admin/menu-items/${i.id}/toggle-available" style="margin:0"><button class="ghost" type="submit" style="margin:0;padding:6px 10px;font-size:12px">${i.is_available ? 'В стоп-лист' : 'Вернуть'}</button></form></td>
            </tr>`;
          }).join('') || '<tr><td colspan="5" style="color:var(--txt2)">Блюд пока нет</td></tr>'}
        </table>
        ${categories.length ? `
        <form method="post" action="/admin/restaurants/${r.id}/menu-items">
          <div class="row">
            <div><label>Название блюда</label><input name="name" required></div>
            <div><label>Категория</label><select name="category_id">${categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          </div>
          <div class="row">
            <div><label>Цена, ₽</label><input name="price" type="number" required></div>
            <div><label>Фото (URL)</label><input name="photo_url"></div>
          </div>
          <label>Описание</label><input name="description">
          <label>Состав</label><input name="composition">
          <button type="submit">+ Добавить блюдо</button>
        </form>` : '<p style="color:var(--txt2);font-size:13px">Сначала добавьте хотя бы одну категорию.</p>'}
      </div>
    `));
  } catch (err) {
    console.error('[admin-postgresql] GET /restaurants/:id/edit failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// Production Switch — Stage 7: порядок регистрации этих двух маршрутов
// намеренно ПОМЕНЯН МЕСТАМИ относительно буквального SQLite-порядка (найден
// и задокументирован как баг в Stage 4, см. postgresql-admin-port.md/
// postgresql-migration-status.md). Под Express `strict: false` (default, не
// переопределён нигде) оба паттерна компилируются в идентичный регэксп —
// побеждает ПЕРВЫЙ зарегистрированный, независимо от наличия trailing slash
// в реальном запросе. В унаследованном порядке (редирект-заглушка первой)
// реальный UPDATE-обработчик ниже был недостижимым мёртвым кодом, а форма
// редактирования ресторана (её `action` — без trailing slash) реально
// попадала бы в бесконечный 307-redirect-цикл на саму себя. Фикс — локальный
// (только порядок двух router.post() в этом файле), не меняет внешний
// контракт (тело/статусы обоих обработчиков не тронуты), восстанавливает
// поведение, уже очевидное из самого кода — форма ведёт на путь без
// trailing slash, значит реальный UPDATE и должен на него отвечать.
// Воспроизведено тестом ДО фикса и подтверждено тестом ПОСЛЕ (см.
// applicationAssemblyStage7.test.js, раздел E). SQLite-оригинал
// (routes/admin.js) НЕ тронут — там баг остаётся, требует отдельного
// product-решения (вне мандата Stage 7, затрагивает живой production-путь).
router.post('/restaurants/:id', async (req, res) => {
  try {
    const { name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes } = req.body;
    const citiesJson = JSON.stringify(String(cities || '').split(',').map((c) => c.trim()).filter(Boolean));
    // Как и оригинал, не проверяет rowCount/существование заказа этим самым
    // запросом — если id не существует, WHERE просто не матчит ни одной
    // строки (безопасный no-op), и редирект ведёт на GET-страницу
    // редактирования, которая САМА уже проверяет `if (!r) 404` — тот же
    // сквозной эффект, что и в SQLite-оригинале, только проверка происходит
    // на следующем шаге навигации, не здесь. Не добавлена отдельная
    // существование-проверка в этот handler — она была бы избыточна.
    await db.execute(
      `UPDATE restaurants SET name=$1, cuisine=$2, photo_url=$3, cities=$4, address=$5, hours=$6, phone=$7, delivery_price=$8, min_order=$9, default_cook_minutes=$10 WHERE id=$11`,
      [name, cuisine || '', photo_url || '', citiesJson, address || '', hours || '', phone || '',
        Number(delivery_price) || 0, Number(min_order) || 0, Number(default_cook_minutes) || 40, req.params.id]
    );
    res.redirect(`/admin/restaurants/${req.params.id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /restaurants/:id failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// После фикса выше — недостижимый код (та же причина, по которой раньше
// недостижимым был реальный UPDATE-обработчик: strict:false компилирует
// '/restaurants/:id' и '/restaurants/:id/' в идентичный регэксп, поэтому
// маршрут, зарегистрированный первым, перехватывает ОБА варианта запроса,
// с trailing slash и без). Оставлен как есть (не удалён) — минимальный,
// локальный диф; удаление отдельного маршрута — уже другое, более широкое
// решение, не входящее в мандат "поменять порядок регистрации".
router.post('/restaurants/:id/', (req, res) => res.redirect(307, `/admin/restaurants/${req.params.id}`));

router.post('/restaurants/:id/pause', async (req, res) => {
  try {
    await pgOrderService.pauseRestaurant(req.params.id, req.body.preset);
    res.redirect(`/admin/restaurants/${req.params.id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /restaurants/:id/pause failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

router.post('/restaurants/:id/resume', async (req, res) => {
  try {
    await pgOrderService.resumeRestaurant(req.params.id);
    res.redirect(`/admin/restaurants/${req.params.id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /restaurants/:id/resume failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// НАЙДЕННОЕ, ДОКУМЕНТИРОВАННОЕ ОТЛИЧИЕ (concurrency): SQLite-оригинал
// выполняет "SELECT MAX(sort_order)" и "INSERT" двумя ОТДЕЛЬНЫМИ
// синхронными вызовами — под однопоточным SQLite это НЕ создаёт гонки:
// Node не может переключиться на другой запрос между этими двумя
// синхронными операциями. Под PostgreSQL (асинхронный драйвер) наивный
// буквальный перенос ("await SELECT MAX", затем "await INSERT") создал бы
// РЕАЛЬНОЕ окно — два конкурентных добавления категории для ОДНОГО
// ресторана могли бы прочитать одно и то же MAX и получить ОДИНАКОВЫЙ
// sort_order. Смягчение: MAX+1 вычисляется ВНУТРИ того же INSERT одним SQL-
// выражением (один round-trip вместо двух) — это СУЖАЕТ окно гонки
// практически до нуля для реалистичного admin-использования, но
// теоретически не устраняет его полностью без SERIALIZABLE/блокировки,
// которые задание прямо просит не вводить автоматически. Цена проигрыша
// этой узкой гонки — исключительно косметическая (два элемента с
// одинаковым sort_order, порядок между ними произволен, дальше сортируются
// по id как естественному tie-break) — НЕ нарушение данных, НЕ ошибка
// пользователю. Подробный live concurrency-тест — см.
// adminStage4.test.js. Тот же приём применён ниже для menu-items.
router.post('/restaurants/:id/categories', async (req, res) => {
  try {
    await db.execute(
      `INSERT INTO categories (restaurant_id, name, sort_order)
       VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order),0) + 1 FROM categories WHERE restaurant_id = $1))`,
      [req.params.id, req.body.name]
    );
    res.redirect(`/admin/restaurants/${req.params.id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /restaurants/:id/categories failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

router.post('/restaurants/:id/menu-items', async (req, res) => {
  try {
    const { name, category_id, price, photo_url, description, composition } = req.body;
    await db.execute(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, composition, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(sort_order),0) + 1 FROM menu_items WHERE restaurant_id = $1))`,
      [req.params.id, category_id, name, description || '', Number(price) || 0, photo_url || '', composition || '']
    );
    res.redirect(`/admin/restaurants/${req.params.id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /restaurants/:id/menu-items failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// Атомарная арифметика внутри самого UPDATE (`1 - is_available`) — та же,
// уже живо доказанная под конкурентным доступом схема, что и toggle_item в
// bot/postgresql/index.js (Stage 3, тест E5): построчная блокировка
// PostgreSQL сериализует конкурентные UPDATE на одну строку, чётное число
// конкурентных toggle детерминированно возвращает исходное состояние — без
// lost update, без read-modify-write в JS.
router.post('/menu-items/:id/toggle-available', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM menu_items WHERE id = $1', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).send('Не найдено');
    await db.execute('UPDATE menu_items SET is_available = 1 - is_available WHERE id = $1', [req.params.id]);
    res.redirect(`/admin/restaurants/${item.restaurant_id}/edit`);
  } catch (err) {
    console.error('[admin-postgresql] POST /menu-items/:id/toggle-available failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// --- Заказы ---
router.get('/orders', async (req, res) => {
  try {
    const orders = await db.query(`
      SELECT o.*, r.name AS restaurant_name FROM orders o
      JOIN restaurants r ON r.id = o.restaurant_id
      ORDER BY o.id DESC LIMIT 100
    `);
    res.send(layout('Заказы', `
      <h1>Заказы (последние 100)</h1>
      <table>
        <tr><th>Код</th><th>Ресторан</th><th>Сумма</th><th>Комиссия</th><th>Тип</th><th>Статус</th><th>Создан</th></tr>
        ${orders.map((o) => `<tr>
          <td><span class="order-code">${esc(o.public_code)}</span></td><td>${esc(o.restaurant_name)}</td><td>${o.items_total} ₽</td><td>${o.commission_amount} ₽</td>
          <td>${o.fulfillment_type === 'pickup' ? 'Самовывоз' : 'Доставка'}</td>
          <td>${esc(o.status)}</td><td>${esc(formatDateTime(o.created_at))}</td>
        </tr>`).join('') || '<tr><td colspan="7" style="color:var(--txt2)">Заказов пока нет</td></tr>'}
      </table>
    `));
  } catch (err) {
    console.error('[admin-postgresql] GET /orders failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// --- Оценки ---
router.get('/ratings', async (req, res) => {
  try {
    const rated = await db.query(`
      SELECT o.public_code, o.rating, o.created_at, r.name AS restaurant_name
      FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.rating IS NOT NULL
      ORDER BY o.id DESC LIMIT 200
    `);
    const perRestaurant = await db.query('SELECT name, rating, rating_count FROM restaurants ORDER BY rating_count DESC');

    res.send(layout('Оценки', `
      <h1>Оценки</h1>
      <div class="panel">
        <h2 style="font-size:15px;margin-top:0">Средний балл по ресторанам</h2>
        <table>
          <tr><th>Ресторан</th><th>Средний балл</th><th>Оценок</th></tr>
          ${perRestaurant.map((r) => `<tr><td>${esc(r.name)}</td><td>★ ${r.rating?.toFixed(1) ?? '—'}</td><td>${r.rating_count}</td></tr>`).join('')}
        </table>
      </div>
      <div class="panel">
        <h2 style="font-size:15px;margin-top:0">Последние оценённые заказы</h2>
        <table>
          <tr><th>Заказ</th><th>Ресторан</th><th>Оценка</th><th>Дата</th></tr>
          ${rated.map((o) => `<tr><td><span class="order-code">${esc(o.public_code)}</span></td><td>${esc(o.restaurant_name)}</td><td>★ ${o.rating}</td><td>${esc(formatDateTime(o.created_at))}</td></tr>`).join('') || '<tr><td colspan="4" style="color:var(--txt2)">Оценок пока нет</td></tr>'}
        </table>
      </div>
    `));
  } catch (err) {
    console.error('[admin-postgresql] GET /ratings failed:', err.message);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

module.exports = router;
