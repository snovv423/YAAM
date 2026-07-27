'use strict';

// YAAM HQ Stage 5B — генерирует настоящий JPEG-файл на диске для e2e/*.spec.ts
// (Playwright не может require('sharp') из своего собственного дерева
// зависимостей — этот helper физически лежит в server/, поэтому require('sharp')
// внутри него резолвится через server/node_modules, тот же приём, что e2e/
// global-setup.ts уже использует для db/postgresql и services/postgresql/app.js).
const sharp = require('sharp');

async function generateTestJpeg(outputPath, { width = 900, height = 600, color = { r: 120, g: 60, b: 200 } } = {}) {
  const buffer = await sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
  require('node:fs').writeFileSync(outputPath, buffer);
  return outputPath;
}

module.exports = { generateTestJpeg };
