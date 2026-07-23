'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ALLOWED_TYPOGRAPHY,
  findForbiddenEmoji,
  scanClientSources,
} = require('../scripts/check-no-emoji');

test('user-facing client sources contain no forbidden emoji-like symbols', () => {
  assert.deepEqual(scanClientSources(), []);
});

test('scanner reports a forbidden emoji with source coordinates', () => {
  const forbidden = String.fromCodePoint(0x1F4A5);
  const findings = findForbiddenEmoji(`safe\nstatus ${forbidden}`, 'fixture.html');
  assert.equal(findings.length, 1);
  assert.deepEqual(
    { file: findings[0].file, line: findings[0].line, symbol: findings[0].symbol },
    { file: 'fixture.html', line: 2, symbol: forbidden },
  );
});

test('scanner catches variation selectors, ZWJ sequences, flags and emoji modifiers', () => {
  const fixtures = [
    String.fromCodePoint(0x2615, 0xFE0F),
    String.fromCodePoint(0x1F469, 0x200D, 0x1F373),
    String.fromCodePoint(0x1F1F7, 0x1F1FA),
    String.fromCodePoint(0x1F44D, 0x1F3FD),
  ];
  for (const fixture of fixtures) {
    assert.ok(findForbiddenEmoji(fixture).length > 0, `expected detection for ${fixture.codePointAt(0)}`);
  }
});

test('documented neutral typography remains allowed', () => {
  const source = [...ALLOWED_TYPOGRAPHY].join(' ');
  assert.deepEqual(findForbiddenEmoji(source), []);
});

test('all status SVG templates are decorative, currentColor and viewBox based', () => {
  const appSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'js', 'app.js'),
    'utf8',
  );
  assert.match(appSource, /viewBox="0 0 24 24"/);
  assert.match(appSource, /stroke="currentColor"/);
  assert.match(appSource, /aria-hidden="true"/);
  assert.match(appSource, /focusable="false"/);
  assert.doesNotMatch(appSource, /ic\.textContent=icons\[statusStep\]/);
});

test('rating stars keep a distinct accessible name for every score', () => {
  const appSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'js', 'app.js'),
    'utf8',
  );
  assert.match(appSource, /aria-label="Оценить на \$\{n\}/);
});

test('static trust icon is decorative and uses the same SVG contract', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'index.html'),
    'utf8',
  );
  assert.match(
    html,
    /class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" focusable="false"/,
  );
});
