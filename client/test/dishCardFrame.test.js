'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

test('menu dish cards keep the fixed thin 7:3 frame', () => {
  assert.match(css, /\.dphoto\{[^}]*aspect-ratio:7\/3[^}]*\}/);
  assert.doesNotMatch(css, /\.dphoto\{[^}]*aspect-ratio:4\/3[^}]*\}/);
});

test('uploaded dish photos fill the card frame instead of resizing it', () => {
  assert.match(css, /\.dphoto>img\{[^}]*width:100%[^}]*height:100%[^}]*object-fit:cover[^}]*object-position:center[^}]*\}/);
});
