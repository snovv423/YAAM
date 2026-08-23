'use strict';

// Регрессия на installable-PWA-обвязку YAAM (manifest + iOS meta + иконки +
// service worker). Всё это статические артефакты, которые легко потерять при
// правке index.html или при чистке assets, а сломанное проявляется не в
// браузере разработчика, а только на домашнем экране телефона пользователя —
// худший вид дефекта для обнаружения вручную.
//
// Отдельно и жёстко проверяются инварианты безопасности service worker'а:
// он не имеет права кэшировать API заказов, оплату и не-GET запросы, и
// обязан переживать деплой без показа старого app.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CLIENT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(CLIENT, 'css', 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(CLIENT, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(CLIENT, 'manifest.webmanifest'), 'utf8'));

// Минимальный разбор размеров PNG из IHDR: ширина/высота — big-endian uint32
// по смещениям 16 и 20. Достаточно, чтобы поймать подмену файла или иконку
// не того размера, и не тянет зависимостей в тестовое дерево клиента.
function pngSize(relPath) {
  const buf = fs.readFileSync(path.join(CLIENT, relPath));
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${relPath} не PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('manifest объявляет установленное приложение YAAM в portrait/standalone с фирменными цветами', () => {
  assert.equal(manifest.name, 'YAAM');
  assert.equal(manifest.short_name, 'YAAM');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  // start_url/scope — корень сайта: приложение всегда открывается на главной,
  // активный заказ восстанавливает уже сам клиент (tryRestoreSession).
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  // Тот же тёмно-зелёный, что у html/body и meta[theme-color] — иначе при
  // запуске будет видна вспышка чужого фона.
  assert.equal(manifest.theme_color, '#0A2417');
  assert.equal(manifest.background_color, '#0A2417');
  assert.match(html, /<meta name="theme-color" content="#0A2417">/);
  assert.match(css, /\bhtml\{[^}]*background-color:#0A2417/);
});

test('manifest подключён из index.html и содержит и any, и maskable иконки 192/512', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);

  const byPurpose = (purpose) => manifest.icons
    .filter((i) => i.purpose === purpose)
    .map((i) => i.sizes)
    .sort();
  assert.deepEqual(byPurpose('any'), ['192x192', '512x512']);
  assert.deepEqual(byPurpose('maskable'), ['192x192', '512x512']);

  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    const [w, h] = icon.sizes.split('x').map(Number);
    const real = pngSize(icon.src);
    assert.deepEqual(real, { width: w, height: h }, `${icon.src}: размер файла не совпадает с sizes`);
  }
});

test('iOS-обвязка: standalone-запуск, заголовок YAAM, прозрачный статус-бар и viewport-fit=cover', () => {
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="YAAM">/);
  // Только black-translucent отдаёт странице область под статус-баром — на
  // нём построены safe-area-правила ниже. default/black их обнулят.
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /viewport-fit=cover/);
});

test('apple-touch-icon и favicon указывают на существующие PNG утверждённого брендинга', () => {
  const links = [...html.matchAll(/<link rel="(?:apple-touch-icon|icon)"[^>]*href="([^"]+)"[^>]*>/g)]
    .map((m) => m[1]);
  assert.ok(links.length >= 5, 'ожидались apple-touch-icon 180/167/152/120 и favicon 32/16');

  assert.ok(html.includes('sizes="180x180" href="assets/icons/apple-touch-icon.png"'),
    'нет apple-touch-icon 180x180');
  // Старый favicon был инлайновой SVG-буквой "Y" из Georgia — не тот бренд.
  assert.ok(!/rel="icon" href="data:image\/svg\+xml/.test(html),
    'остался старый data:URI favicon вместо иконки YAAM');

  for (const href of links) {
    const size = pngSize(href);
    assert.equal(size.width, size.height, `${href}: иконка не квадратная (пропорции искажены)`);
  }
  assert.deepEqual(pngSize('assets/icons/apple-touch-icon.png'), { width: 180, height: 180 });
});

test('service worker никогда не перехватывает не-GET и чужой origin (API заказов, оплата)', () => {
  // Порядок в fetch-обработчике важен: отсечки должны стоять ДО любого
  // respondWith, иначе создание заказа или редирект на оплату могут уйти
  // через кэш.
  const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
  const guardNonGet = fetchHandler.indexOf("request.method !== 'GET'");
  const guardOrigin = fetchHandler.indexOf('url.origin !== self.location.origin');
  const firstRespond = fetchHandler.indexOf('event.respondWith');

  assert.ok(guardNonGet > -1, 'нет отсечки по методу запроса');
  assert.ok(guardOrigin > -1, 'нет отсечки по origin');
  assert.ok(guardNonGet < firstRespond, 'не-GET должен отсекаться до respondWith');
  assert.ok(guardOrigin < firstRespond, 'чужой origin должен отсекаться до respondWith');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)\)\s*return/);
});

test('service worker переживает деплой: имя кэша завязано на версию, старые кэши удаляются', () => {
  // Тот же плейсхолдер, что и в index.html; CI подставляет в оба файла
  // commit SHA (см. .github/workflows/pages.yml).
  assert.match(sw, /const VERSION = '__CACHE_BUST__'/);
  assert.match(sw, /CACHE_NAME = `yaam-static-\$\{VERSION\}`/);
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /n !== CACHE_NAME/);

  const workflow = fs.readFileSync(
    path.join(CLIENT, '..', '.github', 'workflows', 'pages.yml'), 'utf8'
  );
  assert.match(workflow, /sed -i "s\/__CACHE_BUST__\/\$\{\{ github\.sha \}\}\/g" client\/index\.html client\/sw\.js/);
});

test('навигации идут network-first — свежий index.html всегда важнее кэша', () => {
  assert.match(sw, /async function networkFirst/);
  // Единственный способ попасть в кэш для навигации — сеть недоступна.
  const networkFirstBody = sw.slice(sw.indexOf('async function networkFirst'));
  const tryIdx = networkFirstBody.indexOf('try {');
  const catchIdx = networkFirstBody.indexOf('} catch');
  assert.ok(networkFirstBody.slice(tryIdx, catchIdx).includes('await fetch(request)'));
  assert.ok(networkFirstBody.slice(catchIdx).includes('caches.match(request)'));
});

test('регистрация SW не подавляет штатный install flow браузера и имеет аварийный выключатель', () => {
  const pwa = fs.readFileSync(path.join(CLIENT, 'js', 'pwa.js'), 'utf8');
  assert.match(html, /<script defer src="js\/pwa\.js\?v=__CACHE_BUST__"><\/script>/);
  // Перехват beforeinstallprompt без своего UI просто отменил бы установку
  // на Android; кастомной кнопки "Установить" в задаче нет намеренно.
  assert.ok(!/addEventListener\(\s*['"]beforeinstallprompt/.test(pwa),
    'beforeinstallprompt не должен перехватываться');
  assert.ok(!/addEventListener\(\s*['"]beforeinstallprompt/.test(html),
    'beforeinstallprompt не должен перехватываться');
  assert.match(pwa, /updateViaCache: 'none'/);
  assert.match(pwa, /nosw=1/);
});
