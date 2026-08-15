'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSandbox, loadAppInSandbox, evalInContext, teardown } = require('./helpers/loadApp');

test('city switch removes previous restaurants before the new request completes', async () => {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.test' });
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  loadAppInSandbox(sandbox);
  await evalInContext(sandbox, 'renderList(true)');
  const list = sandbox.document.getElementById('list');
  list.innerHTML = '<div>RAZRYAD</div>';
  evalInContext(sandbox, `api.getRestaurants=()=>new Promise(resolve=>{window.resolveCity=resolve})`);

  const switching = evalInContext(sandbox, `selectCity('Аргун')`);
  assert.equal(list.innerHTML, '');
  assert.equal(list.style.opacity, '0');
  assert.equal(list.attributes['aria-busy'], 'true');

  evalInContext(sandbox, 'resolveCity([])');
  await switching;
  assert.doesNotMatch(list.innerHTML, /RAZRYAD/);
  assert.equal(list.style.opacity, '1');
  teardown(sandbox);
});

test('late response from a previous city cannot overwrite the latest city', async () => {
  const { sandbox } = createSandbox({ apiBaseUrl: 'https://api.test' });
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  loadAppInSandbox(sandbox);
  await evalInContext(sandbox, 'renderList(true)');
  evalInContext(sandbox, `
    window.cityResolvers={};
    api.getRestaurants=city=>new Promise(resolve=>{cityResolvers[city]=resolve});
  `);

  const argun = evalInContext(sandbox, `selectCity('Аргун')`);
  const grozny = evalInContext(sandbox, `selectCity('Грозный')`);
  evalInContext(sandbox, `cityResolvers['Грозный']([])`);
  await grozny;
  evalInContext(sandbox, `cityResolvers['Аргун']([{id:1,name:'RAZRYAD',cities:['Аргун']}])`);
  await argun;

  const list = sandbox.document.getElementById('list');
  assert.doesNotMatch(list.innerHTML, /RAZRYAD/);
  assert.match(list.innerHTML, /В этом городе пока нет ресторанов/);
  assert.equal(evalInContext(sandbox, 'selectedCity'), 'Грозный');
  teardown(sandbox);
});
