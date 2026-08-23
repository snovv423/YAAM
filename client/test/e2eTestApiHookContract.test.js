'use strict';

// Дефект, который этот файл больше не даст повторить.
//
// После production-cutover client/js/api.js перестал читать
// window.YAAM_API_BASE_URL и перешёл на пару __YAAM_TEST_MODE__ /
// __YAAM_TEST_API_BASE_URL. Инертность старого глобала в публичном рантайме
// закрыта тестом в productionApiCutover.test.js — а вот e2e-обвязка осталась
// на старом имени, и её три копии helper'а никто не обновил. Симптом был
// максимально коварным: тесты не падали с «hook not found», они молча
// уводили браузер на https://api.yaam.su, получали «Не удалось загрузить
// рестораны» и падали на первом же ожидании карточки ресторана — то есть
// заявленные сценарии (заказ, оплата, restore) не проверялись вообще, а
// красный прогон выглядел как проблема продукта, а не обвязки.
//
// Проверяется контракт между двумя деревьями, поэтому тест намеренно читает
// и client/js/api.js, и e2e/fixtures/test-api-hook.ts: рассинхрон должен
// падать здесь, в быстром node --test, а не через пять минут прогона
// Playwright.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO = path.join(__dirname, '..', '..');
const apiJs = fs.readFileSync(path.join(REPO, 'client', 'js', 'api.js'), 'utf8');
const hookFixture = fs.readFileSync(
  path.join(REPO, 'e2e', 'fixtures', 'test-api-hook.ts'), 'utf8'
);
const E2E_TESTS_DIR = path.join(REPO, 'e2e', 'tests');
const specs = fs.readdirSync(E2E_TESTS_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => ({ name: f, source: fs.readFileSync(path.join(E2E_TESTS_DIR, f), 'utf8') }));

test('api.js признаёт тестовый режим только по паре __YAAM_TEST_MODE__ + __YAAM_TEST_API_BASE_URL', () => {
  assert.match(apiJs, /window\.__YAAM_TEST_MODE__ === true/);
  assert.match(apiJs, /hasOwnProperty\.call\(window, '__YAAM_TEST_API_BASE_URL'\)/);
  // Одного флага мало: адрес обязан быть собственным свойством window, иначе
  // унаследованное из прототипа значение могло бы включить override.
  assert.match(apiJs, /__YAAM_TEST_MODE__ === true\s*\n?\s*&&\s*Object\.prototype\.hasOwnProperty/);
});

test('e2e-обвязка ставит ровно тот хук, который читает api.js', () => {
  assert.match(hookFixture, /TEST_API_HOOK_FLAG = '__YAAM_TEST_MODE__'/);
  assert.match(hookFixture, /TEST_API_HOOK_URL = '__YAAM_TEST_API_BASE_URL'/);
  assert.match(hookFixture, /\[flag\] = true/);
  assert.match(hookFixture, /\[urlKey\] = value/);
});

test('ни один e2e-spec не ставит хук в обход общей фикстуры', () => {
  for (const spec of specs) {
    assert.ok(
      !/addInitScript/.test(spec.source),
      `${spec.name}: addInitScript должен вызываться только из fixtures/test-api-hook.ts`
    );
    assert.ok(
      !/window\.YAAM_API_BASE_URL/.test(spec.source),
      `${spec.name}: legacy-глобал YAAM_API_BASE_URL больше не читается api.js`
    );
  }
});

test('legacy YAAM_API_BASE_URL не возвращён в production-рантайм', () => {
  // В api.js это имя не должно встречаться вовсе — ни как чтение, ни как
  // fallback. Регрессия сюда означала бы, что тесты «починили» ослаблением
  // production-поведения.
  assert.ok(!/YAAM_API_BASE_URL/.test(apiJs),
    'api.js не должен упоминать legacy-глобал YAAM_API_BASE_URL');
  const html = fs.readFileSync(path.join(REPO, 'client', 'index.html'), 'utf8');
  assert.ok(!/__YAAM_TEST_MODE__|__YAAM_TEST_API_BASE_URL|YAAM_API_BASE_URL/.test(html),
    'публичный index.html не имеет права выставлять тестовый хук');
});

test('тестовый хук fail-closed: включается только против локального backend', () => {
  // Ошибка в конфигурации не должна приводить к прогону сценариев создания
  // заказов против staging/production API.
  assert.match(hookFixture, /LOCAL_HOSTS/);
  assert.match(hookFixture, /'127\.0\.0\.1'/);
  assert.match(hookFixture, /throw new Error/);
  const install = hookFixture.slice(hookFixture.indexOf('export async function pointFrontendAtLocalBackend'));
  assert.ok(install.indexOf('assertLocalBackend') < install.indexOf('addInitScript'),
    'проверка адреса обязана идти до установки хука');
});
