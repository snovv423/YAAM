'use strict';

// Stage 11A — покрывает resolveApiBaseUrl() (client/js/api.js): единственный
// безопасный способ включить staging API для controlled browser E2E, без
// риска случайно затронуть обычных посетителей demo yaam.su.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSandbox, loadAppInSandbox, evalInContext } = require('./helpers/loadApp');

const STAGING_URL = 'https://api-pg.yaam.su';

test('demo mode остаётся default: без query, без sessionStorage, без override', () => {
  const { sandbox } = createSandbox({});
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), null);
  assert.equal(evalInContext(sandbox, 'USE_API'), false);
  assert.equal(evalInContext(sandbox, 'IS_STAGING_MODE'), false);
});

test('?yaam_staging_api=1 включает staging и использует ТОЛЬКО жёстко зашитый https://api-pg.yaam.su', () => {
  const { sandbox } = createSandbox({ locationSearch: '?yaam_staging_api=1' });
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), STAGING_URL);
  assert.equal(evalInContext(sandbox, 'USE_API'), true);
  assert.equal(evalInContext(sandbox, 'IS_STAGING_MODE'), true);
});

test('произвольное значение параметра (не "1"/"0") не активирует staging и не читается как URL', () => {
  // Защита от open-redirect-подобной атаки: параметр — булев переключатель,
  // не источник адреса backend.
  const { sandbox } = createSandbox({ locationSearch: '?yaam_staging_api=https://evil.example.com' });
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), null);
  assert.equal(evalInContext(sandbox, 'USE_API'), false);
});

test('активация переживает reload через sessionStorage (симулирует возврат с YooKassa hosted-формы без query-параметра)', () => {
  const { sandbox: first } = createSandbox({ locationSearch: '?yaam_staging_api=1' });
  loadAppInSandbox(first);
  const persisted = first.sessionStorage.getItem('yaam_staging_api_active');
  assert.equal(persisted, '1');

  // Новая "загрузка страницы" (YOOKASSA_RETURN_URL=https://yaam.su/, без
  // query) — тот же sessionStorage должен быть перенесён вручную (в реальном
  // браузере он общий на вкладку сам по себе; здесь эмулируем явной передачей
  // того же значения в новый sandbox).
  const { sandbox: second } = createSandbox({ locationSearch: '' });
  second.sessionStorage.setItem('yaam_staging_api_active', persisted);
  loadAppInSandbox(second);
  assert.equal(evalInContext(second, 'API_BASE_URL'), STAGING_URL);
  assert.equal(evalInContext(second, 'IS_STAGING_MODE'), true);
});

test('?yaam_staging_api=0 выключает staging и чистит sessionStorage — весь rollback, без backend/VPS', () => {
  const { sandbox } = createSandbox({ locationSearch: '?yaam_staging_api=0' });
  sandbox.sessionStorage.setItem('yaam_staging_api_active', '1');
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), null);
  assert.equal(evalInContext(sandbox, 'USE_API'), false);
  assert.equal(sandbox.sessionStorage.getItem('yaam_staging_api_active'), null);
});

test('sessionStorage сам по себе (без query) активирует staging — устойчивость к произвольным reload внутри той же вкладки', () => {
  const { sandbox } = createSandbox({ locationSearch: '' });
  sandbox.sessionStorage.setItem('yaam_staging_api_active', '1');
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), STAGING_URL);
});

test('явный window.YAAM_API_BASE_URL override сохраняет приоритет над query/session (не ломает существующие тесты/будущий production switch)', () => {
  const CUSTOM = 'http://localhost:4000';
  const { sandbox } = createSandbox({ apiBaseUrl: CUSTOM, locationSearch: '?yaam_staging_api=1' });
  loadAppInSandbox(sandbox);
  assert.equal(evalInContext(sandbox, 'API_BASE_URL'), CUSTOM);
  assert.equal(evalInContext(sandbox, 'IS_STAGING_MODE'), false, 'override на нестейджинговый URL не должен считаться staging-режимом');
});

test('staging-индикатор (#stgBadge) скрыт в demo, показан в staging режиме', () => {
  const { sandbox: demo } = createSandbox({});
  loadAppInSandbox(demo);
  const demoBadge = demo.document.getElementById('stgBadge');
  assert.notEqual(demoBadge.hidden, false, 'бейдж не должен быть явно показан в demo');

  const { sandbox: staging } = createSandbox({ locationSearch: '?yaam_staging_api=1' });
  loadAppInSandbox(staging);
  const stagingBadge = staging.document.getElementById('stgBadge');
  assert.equal(stagingBadge.hidden, false, 'бейдж должен быть показан в staging-режиме');
});
