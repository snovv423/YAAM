// Наполняет базу теми же demo-ресторанами, что раньше были захардкожены в
// client/js/data.js — чтобы можно было проверить весь путь через API/бота/админку
// без реальных ресторанов. Запуск: npm run seed (перезаписывает текущие данные).
const db = require('./index');

db.exec('DELETE FROM menu_items; DELETE FROM categories; DELETE FROM restaurants; DELETE FROM orders; DELETE FROM order_items; DELETE FROM payments;');

const insertRestaurant = db.prepare(`
  INSERT INTO restaurants (name, cuisine, photo_url, cities, address, hours, phone, delivery_price, min_order, default_cook_minutes, is_open, is_new, rating, rating_count)
  VALUES (:name, :cuisine, :photo_url, :cities, :address, :hours, :phone, :delivery_price, :min_order, :default_cook_minutes, :is_open, :is_new, :rating, :rating_count)
`);
const insertCategory = db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)');
const insertItem = db.prepare(`
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, photo_url, weight_g, kcal, protein_g, fat_g, carbs_g, composition, is_popular, sort_order)
  VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
`);

function seedRestaurant(data) {
  const info = insertRestaurant.run({
    name: data.name, cuisine: data.cuisine, photo_url: '',
    cities: JSON.stringify(data.cities), address: data.address || '', hours: data.hours, phone: data.phone || '',
    delivery_price: data.deliv, min_order: data.min, default_cook_minutes: data.cookMinutes || 40,
    is_open: data.open ? 1 : 0, is_new: data.isNew ? 1 : 0,
    rating: data.rate, rating_count: data.votes,
  });
  const restaurantId = info.lastInsertRowid;
  data.menu.forEach((cat, ci) => {
    const catInfo = insertCategory.run(restaurantId, cat.cat, ci);
    cat.items.forEach((item, ii) => {
      insertItem.run(
        restaurantId, catInfo.lastInsertRowid, item.n, item.d, item.p,
        item.w || 300, item.kcal || 400, item.prot || 15, item.fat || 15, item.carb || 40,
        item.s || 'Натуральные ингредиенты', item.pop ? 1 : 0, ii
      );
    });
  });
}

seedRestaurant({
  name: 'Кавказ', cuisine: 'Шашлык · Чеченская кухня', cities: ['Грозный', 'Аргун'],
  address: 'г. Грозный, пр. В.В. Путина, 1', hours: '10:00–23:00', phone: '+7 928 100-00-01', deliv: 150, min: 600, cookMinutes: 45, open: true, isNew: false, rate: 4.8, votes: 215,
  menu: [
    { cat: 'Шашлык и мангал', items: [
      { n: 'Шашлык из баранины', d: 'Мясо на углях, 250 г', p: 520, pop: true, w: 250, kcal: 540, prot: 38, fat: 42, carb: 2, s: 'Баранина, лук, специи, соль, уксусный маринад' },
      { n: 'Люля-кебаб', d: 'Рубленая баранина с зеленью', p: 380, w: 200, kcal: 480, prot: 30, fat: 38, carb: 3, s: 'Рубленая баранина, лук, зелень, специи' },
    ]},
    { cat: 'Чеченская кухня', items: [
      { n: 'Жижиг-галныш', d: 'Хинкал с мясом и чесночным соусом', p: 450, pop: true, w: 400, kcal: 620, prot: 35, fat: 28, carb: 55, s: 'Говядина, мука, чеснок, бульон, соль' },
    ]},
  ],
});

seedRestaurant({
  name: 'ASCOFFEE', cuisine: 'Кофе · Десерты · Сэндвичи', cities: ['Грозный', 'Гудермес'],
  address: 'г. Грозный, ул. Тухачева, 14', hours: '08:00–23:00', phone: '+7 928 100-00-02', deliv: 120, min: 400, cookMinutes: 15, open: true, isNew: true, rate: 4.7, votes: 73,
  menu: [
    { cat: 'Кофе', items: [
      { n: 'Капучино', d: 'Эспрессо и молочная пенка', p: 190, pop: true, w: 250, kcal: 120, prot: 6, fat: 6, carb: 10, s: 'Эспрессо, молоко' },
      { n: 'Раф', d: 'Сливочный, с ванилью', p: 240, pop: true, w: 300, kcal: 220, prot: 5, fat: 11, carb: 24, s: 'Эспрессо, сливки, ваниль, сахар' },
    ]},
    { cat: 'Десерты', items: [
      { n: 'Чизкейк', d: 'Нью-Йорк, кусок', p: 260, pop: true, w: 140, kcal: 380, prot: 7, fat: 24, carb: 32, s: 'Сыр, сливки, основа, сахар' },
    ]},
  ],
});

console.log('Готово: 2 demo-ресторана загружены.');
