const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { layout } = require('../admin/layout');
const orderService = require('../services/orderService');

const router = express.Router();

const PAUSE_LABELS = { short: '33 мин', medium: '3 часа', long: '11 часов' };

function statusBadge(r) {
  if (r.is_open) return '<span class="badge open">Открыт</span>';
  if (r.paused_until) {
    // paused_until хранится в формате SQLite datetime('now', ...) — UTC, "YYYY-MM-DD HH:MM:SS" —
    // явно указываем, что это UTC, добавляя T/Z, иначе New Date() может интерпретировать как локальное время.
    const until = new Date(r.paused_until.replace(' ', 'T') + 'Z');
    const hh = String(until.getHours()).padStart(2, '0');
    const mm = String(until.getMinutes()).padStart(2, '0');
    return `<span class="badge paused">Перерыв до ${hh}:${mm}</span>`;
  }
  return '<span class="badge closed">Закрыт</span>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Дашборд "Сегодня" ---
router.get('/', (req, res) => {
  const today = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(items_total),0) AS revenue, COALESCE(SUM(commission_amount),0) AS commission
    FROM orders WHERE date(created_at) = date('now') AND status NOT IN ('cancelled','declined','timed_out','payment_failed')
  `).get();
  const perRestaurant = db.prepare(`
    SELECT r.name,
           COUNT(o.id) AS orders_cnt,
           SUM(CASE WHEN o.status IN ('cancelled','declined','timed_out') THEN 1 ELSE 0 END) AS cancelled_cnt,
           r.rating, r.rating_count
    FROM restaurants r LEFT JOIN orders o ON o.restaurant_id = r.id
    GROUP BY r.id ORDER BY orders_cnt DESC
  `).all();

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
});

// --- Рестораны: список ---
router.get('/restaurants', (req, res) => {
  const list = db.prepare('SELECT * FROM restaurants ORDER BY id DESC').all();
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

router.post('/restaurants', (req, res) => {
  const { name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes } = req.body;
  const connectCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  const citiesJson = JSON.stringify(String(cities || '').split(',').map((c) => c.trim()).filter(Boolean));
  const info = db.prepare(`
    INSERT INTO restaurants (name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes, connect_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, cuisine || '', photo_url || '', citiesJson, address || '', hours || '', phone || '', Number(delivery_price) || 0, Number(min_order) || 0, Number(default_cook_minutes) || 40, connectCode);
  res.redirect(`/admin/restaurants/${info.lastInsertRowid}/edit`);
});

router.get('/restaurants/:id/edit', (req, res) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).send('Не найдено');
  const categories = db.prepare('SELECT * FROM categories WHERE restaurant_id = ? ORDER BY sort_order').all(r.id);
  const items = db.prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY sort_order').all(r.id);

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
});

router.post('/restaurants/:id/', (req, res) => res.redirect(307, `/admin/restaurants/${req.params.id}`));
router.post('/restaurants/:id', (req, res) => {
  const { name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes } = req.body;
  const citiesJson = JSON.stringify(String(cities || '').split(',').map((c) => c.trim()).filter(Boolean));
  db.prepare(`
    UPDATE restaurants SET name=?, cuisine=?, photo_url=?, cities=?, address=?, hours=?, phone=?, delivery_price=?, min_order=?, default_cook_minutes=? WHERE id=?
  `).run(name, cuisine || '', photo_url || '', citiesJson, address || '', hours || '', phone || '', Number(delivery_price) || 0, Number(min_order) || 0, Number(default_cook_minutes) || 40, req.params.id);
  res.redirect(`/admin/restaurants/${req.params.id}/edit`);
});

router.post('/restaurants/:id/pause', (req, res) => {
  orderService.pauseRestaurant(req.params.id, req.body.preset);
  res.redirect(`/admin/restaurants/${req.params.id}/edit`);
});
router.post('/restaurants/:id/resume', (req, res) => {
  orderService.resumeRestaurant(req.params.id);
  res.redirect(`/admin/restaurants/${req.params.id}/edit`);
});

router.post('/restaurants/:id/categories', (req, res) => {
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM categories WHERE restaurant_id = ?').get(req.params.id).m;
  db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)').run(req.params.id, req.body.name, maxOrder + 1);
  res.redirect(`/admin/restaurants/${req.params.id}/edit`);
});

router.post('/restaurants/:id/menu-items', (req, res) => {
  const { name, category_id, price, photo_url, description, composition } = req.body;
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM menu_items WHERE restaurant_id = ?').get(req.params.id).m;
  db.prepare(`
    INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, composition, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, category_id, name, description || '', Number(price) || 0, photo_url || '', composition || '', maxOrder + 1);
  res.redirect(`/admin/restaurants/${req.params.id}/edit`);
});

router.post('/menu-items/:id/toggle-available', (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).send('Не найдено');
  db.prepare('UPDATE menu_items SET is_available = 1 - is_available WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/restaurants/${item.restaurant_id}/edit`);
});

// --- Заказы ---
router.get('/orders', (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, r.name AS restaurant_name FROM orders o
    JOIN restaurants r ON r.id = o.restaurant_id
    ORDER BY o.id DESC LIMIT 100
  `).all();
  res.send(layout('Заказы', `
    <h1>Заказы (последние 100)</h1>
    <table>
      <tr><th>Код</th><th>Ресторан</th><th>Сумма</th><th>Комиссия</th><th>Тип</th><th>Статус</th><th>Создан</th></tr>
      ${orders.map((o) => `<tr>
        <td><span class="order-code">${esc(o.public_code)}</span></td><td>${esc(o.restaurant_name)}</td><td>${o.items_total} ₽</td><td>${o.commission_amount} ₽</td>
        <td>${o.fulfillment_type === 'pickup' ? 'Самовывоз' : 'Доставка'}</td>
        <td>${esc(o.status)}</td><td>${esc(o.created_at)}</td>
      </tr>`).join('') || '<tr><td colspan="7" style="color:var(--txt2)">Заказов пока нет</td></tr>'}
    </table>
  `));
});

// --- Оценки ---
router.get('/ratings', (req, res) => {
  const rated = db.prepare(`
    SELECT o.public_code, o.rating, o.created_at, r.name AS restaurant_name
    FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
    WHERE o.rating IS NOT NULL
    ORDER BY o.id DESC LIMIT 200
  `).all();
  const perRestaurant = db.prepare('SELECT name, rating, rating_count FROM restaurants ORDER BY rating_count DESC').all();

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
        ${rated.map((o) => `<tr><td><span class="order-code">${esc(o.public_code)}</span></td><td>${esc(o.restaurant_name)}</td><td>★ ${o.rating}</td><td>${esc(o.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" style="color:var(--txt2)">Оценок пока нет</td></tr>'}
      </table>
    </div>
  `));
});

module.exports = router;
