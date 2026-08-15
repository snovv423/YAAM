'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('dish screen starts below the iPhone status-bar safe area', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /#dish\{[^}]*padding-top:env\(safe-area-inset-top\)[^}]*\}/);
});

test('dish back button remains positioned inside the safe-area-shifted hero', () => {
  assert.match(html, /id="dish"[\s\S]*?<div class="dhero"[\s\S]*?<button class="back"/);
  assert.match(css, /\.back\{[^}]*top:16px[^}]*z-index:3[^}]*\}/);
});
