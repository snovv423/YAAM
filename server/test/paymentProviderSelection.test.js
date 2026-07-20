'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const serverDir = path.join(__dirname, '..');

test('unknown PAYMENT_PROVIDER fails closed instead of silently loading mock', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./services/paymentService')"], {
    cwd: serverDir,
    env: { ...process.env, PAYMENT_PROVIDER: 'yookasa-typo' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAYMENT_PROVIDER=.*не поддерживается/);
});
