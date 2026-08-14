'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

const PRODUCTION_URL = 'https://api.yaam.su';
const DEMO_NAMES = /ASCOFFEE|Сладкий дом/;

test('published HTML cache-busts both changed runtime scripts with one cutover version', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /href="css\/style\.css\?v=menu-scroll-memory-2"/);
  assert.match(html, /src="js\/api\.js\?v=menu-scroll-memory-2"/);
  assert.match(html, /src="js\/app\.js\?v=menu-scroll-memory-2"/);
});

async function loadProduction(fetchImpl, locationSearch = '') {
  const { sandbox } = createSandbox({ useProductionDefault: true, locationSearch });
  sandbox.fetch = fetchImpl;
  loadAppInSandbox(sandbox);
  await evalInContext(sandbox, 'renderList(true)');
  return sandbox;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('public runtime always selects production API and ignores former staging query/session switches', async () => {
  const requests = [];
  const { sandbox } = createSandbox({ useProductionDefault: true, locationSearch: '?yaam_staging_api=1' });
  sandbox.sessionStorage.setItem('yaam_staging_api_active', '1');
  sandbox.fetch = async (url) => {
    requests.push(url);
    return jsonResponse([]);
  };
  loadAppInSandbox(sandbox);
  await evalInContext(sandbox, 'renderList(true)');

  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), PRODUCTION_URL);
  assert.equal(evalInContext(sandbox, 'USE_API'), true);
  assert.equal(evalInContext(sandbox, 'IS_STAGING_MODE'), false);
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((url) => url.startsWith(PRODUCTION_URL)));
  assert.ok(requests.every((url) => !url.includes('api-pg') && !url.includes('hqtest')));
  teardown(sandbox);
});

test('empty production catalog renders honest empty state without demo fallback', async () => {
  const sandbox = await loadProduction(async () => jsonResponse([]));
  const html = sandbox.document.getElementById('list').innerHTML;

  assert.match(html, /В этом городе пока нет ресторанов/);
  assert.doesNotMatch(html, DEMO_NAMES);
  assert.equal(evalInContext(sandbox, 'restaurantsCache.length'), 0);
  teardown(sandbox);
});

test('production API error renders retry guidance and never exposes demo restaurants', async () => {
  const sandbox = await loadProduction(async () => { throw new Error('network unavailable'); });
  const html = sandbox.document.getElementById('list').innerHTML;

  assert.match(html, /Не удалось загрузить рестораны/);
  assert.match(html, /попробуйте ещё раз/);
  assert.doesNotMatch(html, DEMO_NAMES);
  assert.equal(evalInContext(sandbox, 'restaurantsCache.length'), 0);
  teardown(sandbox);
});

test('legacy public YAAM_API_BASE_URL override cannot redirect requests away from production', async () => {
  const { sandbox } = createSandbox({ useProductionDefault: true });
  sandbox.YAAM_API_BASE_URL = 'https://api-pg.yaam.su';
  sandbox.fetch = async () => jsonResponse([]);
  loadAppInSandbox(sandbox);
  await evalInContext(sandbox, 'renderList(true)');

  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), PRODUCTION_URL);
  teardown(sandbox);
});

test('test harness can still isolate legacy UI tests without creating a public runtime fallback', () => {
  const { sandbox } = createSandbox({ apiBaseUrl: null });
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), null);
  assert.equal(evalInContext(sandbox, 'USE_API'), false);
  teardown(sandbox);
});
