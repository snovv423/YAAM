'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

test('opening a dish remembers the exact menu scroll position', () => {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.test' });
  loadAppInSandbox(sandbox);
  sandbox.document.getElementById('menu').classList.add('active');
  sandbox.scrollY = 8420;
  evalInContext(sandbox, `curRest={menu:[{cat:'Лапша',items:[{id:1,n:'Удон с курицей',d:'',p:360,available:true,g:''}]}]}`);

  evalInContext(sandbox, `openDish('0_0')`);

  assert.equal(evalInContext(sandbox, 'menuReturnScrollY'), 8420);
  teardown(sandbox);
});

test('restoring the menu returns to the remembered position, not the top', () => {
  const { sandbox } = createSandbox();
  const scrollCalls = [];
  sandbox.scrollTo = (...args) => scrollCalls.push(args);
  loadAppInSandbox(sandbox);

  evalInContext(sandbox, 'menuReturnScrollY=8420;restoreMenuPosition()');

  assert.deepEqual(scrollCalls.at(-1), [0, 8420]);
  assert.ok(scrollCalls.every(call => call[1] === 8420), 'возврат не должен промежуточно прыгать к началу меню');
  teardown(sandbox);
});

test('dish back button uses scroll-preserving navigation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="dish"[\s\S]*?onclick="backFromDish\(\)"/);
  assert.doesNotMatch(html, /id="dish"[\s\S]*?onclick="go\('menu'\)"/);
});
