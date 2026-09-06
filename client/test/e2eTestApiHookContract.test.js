'use strict';

// Дефект, который этот файл не даёт повторить.
//
// Тестовая обвязка и client/js/api.js живут в разных деревьях, и рассинхрон
// между ними максимально коварен: тесты не падают с «hook not found», они молча
// уводят браузер на https://api.yaam.su, получают «Не удалось загрузить
// рестораны» и падают на первом же ожидании карточки ресторана — то есть
// заявленные сценарии (заказ, оплата, restore) не проверяются вообще, а красный
// прогон выглядит как проблема продукта, а не обвязки.
//
// Второй, более важный инвариант этого файла: механика подстановки адреса не
// должна возвращаться в публичный бандл. Раньше api.js читал пару
// window.__YAAM_TEST_MODE__/__YAAM_TEST_API_BASE_URL — рантайм-переключатель
// endpoint'а, существовавший исключительно ради тестов и уезжавший на yaam.su.
// Теперь адрес — обычная константа, а подменяют её при ЗАГРУЗКЕ файла:
//   client/test/helpers/loadApp.js  — node:vm unit-тесты;
//   e2e/fixtures/test-api-hook.ts   — Playwright, через статический сервер.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO = path.join(__dirname, '..', '..');
const apiJs = fs.readFileSync(path.join(REPO, 'client', 'js', 'api.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(REPO, 'client', 'index.html'), 'utf8');
const hookFixture = fs.readFileSync(
  path.join(REPO, 'e2e', 'fixtures', 'test-api-hook.ts'), 'utf8'
);
const vmLoader = fs.readFileSync(
  path.join(REPO, 'client', 'test', 'helpers', 'loadApp.js'), 'utf8'
);
const E2E_TESTS_DIR = path.join(REPO, 'e2e', 'tests');
const specs = fs.readdirSync(E2E_TESTS_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => ({ name: f, source: fs.readFileSync(path.join(E2E_TESTS_DIR, f), 'utf8') }));

// Ровно та форма объявления, которую ищут обе подстановки. Если её изменить,
// упадёт этот тест — до того, как обвязка начнёт молча ходить в production.
const DECLARATION = /^const API_BASE_URL = '[^']*';$/m;

test('api.js объявляет адрес одной константой в форме, которую ищет обвязка', () => {
  assert.match(apiJs, DECLARATION);
  assert.equal(apiJs.match(/^const API_BASE_URL = /gm).length, 1,
    'объявление должно быть ровно одно — иначе подстановка неоднозначна');
  assert.match(apiJs, /^const API_BASE_URL = 'https:\/\/api\.yaam\.su';$/m,
    'в репозитории обязан лежать production-адрес, а не адрес из тестового прогона');
});

test('в публичном рантайме нет переключателя API endpoint через window', () => {
  // Ни одного имени, которое можно выставить со страницы и увести запросы.
  for (const forbidden of ['__YAAM_TEST_MODE__', '__YAAM_TEST_API_BASE_URL', 'YAAM_API_BASE_URL']) {
    assert.ok(!apiJs.includes(forbidden),
      `api.js не должен читать ${forbidden}: это рантайм-переключатель endpoint'а в публичном бандле`);
    assert.ok(!indexHtml.includes(forbidden),
      `index.html не должен выставлять ${forbidden}`);
  }
  assert.ok(!/resolveApiBaseUrl/.test(apiJs),
    'выбор адреса в рантайме удалён — адрес известен на этапе сборки файла');
  assert.ok(!/\bwindow\./.test(apiJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')),
    'api.js не должен читать window вовсе');
});

test('обе подстановки ищут ровно то объявление, которое есть в api.js', () => {
  const substituted = apiJs.replace(DECLARATION, "const API_BASE_URL = \"http://127.0.0.1:1234\";");
  assert.match(substituted, /^const API_BASE_URL = "http:\/\/127\.0\.0\.1:1234";$/m);

  // node:vm-загрузчик и e2e-фикстура обязаны использовать одинаковый паттерн:
  // разошедшиеся регулярки — это ровно тот рассинхрон, ради которого файл есть.
  const pattern = "/^const API_BASE_URL = '[^']*';$/m";
  assert.ok(vmLoader.includes(pattern),
    'client/test/helpers/loadApp.js должен искать то же объявление');
  assert.ok(hookFixture.includes(pattern),
    'e2e/fixtures/test-api-hook.ts должен искать то же объявление');
});

test('обе подстановки fail-closed: ненайденное объявление — ошибка, а не тихий production', () => {
  assert.match(vmLoader, /throw new Error\(/);
  assert.match(hookFixture, /throw new Error\(/);
  assert.match(hookFixture, /API_JS_PATH = 'js\/api\.js'/);
});

test('e2e включает подстановку только против локального backend', () => {
  assert.match(hookFixture, /LOCAL_HOSTS/);
  assert.match(hookFixture, /'127\.0\.0\.1'/);
  const install = hookFixture.slice(hookFixture.indexOf('export function createApiBaseUrlTransform'));
  assert.ok(install.indexOf('assertLocalBackend') < install.indexOf('return (relativePath'),
    'проверка адреса обязана идти до создания подстановки');
});

test('ни один e2e-spec не подменяет адрес в обход общей фикстуры', () => {
  for (const spec of specs) {
    assert.ok(
      !/addInitScript/.test(spec.source),
      `${spec.name}: подмена адреса делается только в fixtures/test-api-hook.ts`
    );
    assert.ok(
      !/window\.YAAM_API_BASE_URL|__YAAM_TEST_MODE__/.test(spec.source),
      `${spec.name}: window-переключателей адреса больше не существует`
    );
  }
});

test('демо-датасет не является production-ассетом', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'client', 'js', 'data.js')),
    'client/js/data.js публиковался на yaam.su — демо-датасет должен лежать в тестовых фикстурах');
  assert.ok(fs.existsSync(path.join(REPO, 'client', 'test', 'fixtures', 'data.js')),
    'фикстура демо-датасета должна остаться доступной тестам');
  assert.ok(!/data\.js/.test(indexHtml),
    'index.html не должен подключать демо-датасет');
  assert.match(vmLoader, /fixtures['"],\s*['"]data\.js/,
    'node:vm-загрузчик должен брать демо-датасет из фикстур');
});
