'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(
  path.join(__dirname, '../css/style.css'),
  'utf8',
);

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
  assert.ok(match, `expected to find rule for ${selector}`);
  return match[1];
}

// @keyframes blocks nest braces per percentage step, so a naive `[^}]*}`
// regex would stop at the first inner `}` — walk braces to find the match.
function blockBody(openerPattern) {
  const opener = css.match(openerPattern);
  assert.ok(opener, `expected to find block matching ${openerPattern}`);
  const start = opener.index + opener[0].length;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(start, i - 1);
}

test('logo resting glow (.wm::before) is text-shadow based, not filter:blur dependent', () => {
  const body = ruleBody('.wm::before');
  assert.match(
    body,
    /text-shadow\s*:/,
    'resting glow must use text-shadow as its visibility mechanism',
  );
  const shadowLayers = (body.match(/text-shadow\s*:\s*([^;]+)/) || [])[1] || '';
  const layerCount = shadowLayers.split(/,(?![^(]*\))/).length;
  assert.ok(
    layerCount >= 2,
    `expected a multi-layer glow (>=2 shadow layers), found ${layerCount}`,
  );
  assert.doesNotMatch(
    body,
    /filter\s*:\s*blur/,
    'filter:blur must not be the (re-)introduced mechanism for the resting glow — ' +
      'it degrades on some real Android GPU/compositor configurations while ' +
      'text-shadow renders consistently across Chromium/WebKit/Firefox (see CSS comment above .wm::before)',
  );
});

test('wmBreath keyframes animate opacity only, not filter', () => {
  const body = blockBody(/@keyframes\s+wmBreath\s*\{/);
  assert.match(body, /opacity\s*:/, 'wmBreath should still animate opacity');
  assert.doesNotMatch(
    body,
    /filter\s*:/,
    'wmBreath must not animate filter — animating filter blur radius is the ' +
      'same fragile GPU-compositing pattern being avoided for the base glow',
  );
});

test('tap-triggered neon flash still suppresses the resting glow layers', () => {
  const body = ruleBody('.wm.neon::before,.wm.neon::after');
  assert.match(body, /opacity\s*:\s*0\s*!important/);
});

test('fixed-bottom cart/sheet UI accounts for env(safe-area-inset-bottom)', () => {
  // index.html opts into viewport-fit=cover; without safe-area-inset-bottom,
  // these fixed(bottom:0) blocks sit under the iPhone home indicator / Android
  // gesture nav bar. The base padding-bottom is kept as a fallback declaration
  // ahead of the env()-based one, so browsers without env() support keep it.
  for (const selector of ['.dish-add', '.cartbar', '.sheet']) {
    const body = ruleBody(selector);
    assert.match(
      body,
      /padding-bottom\s*:\s*calc\([^)]*env\(safe-area-inset-bottom\)[^)]*\)/,
      `${selector} must add env(safe-area-inset-bottom) to its bottom padding`,
    );
  }
});
