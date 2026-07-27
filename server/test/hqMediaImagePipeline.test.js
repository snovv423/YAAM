'use strict';

// YAAM HQ Stage 5B — юнит-тесты обработки изображений (задание, раздел 14A:
// "MIME/signature, filename, size, dimensions, storage key, image
// variants"). Использует настоящий sharp (не мокается — задание раздел 1
// прямо требует зрелую библиотеку, тестировать имеет смысл именно её
// реальное поведение), но никакой БД/сети — чистый юнит-уровень.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  detectFormat,
  validateSourceImage,
  processImage,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_DIMENSION_PX,
  VARIANTS,
} = require('../services/hq/media/imagePipeline');

async function makeJpeg(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 60, b: 200 } } }).jpeg({ quality: 90 }).toBuffer();
}
async function makePng(width, height) {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 200, b: 60, alpha: 1 } } }).png().toBuffer();
}
async function makeWebp(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 10 } } }).webp().toBuffer();
}

test('detectFormat: распознаёт JPEG/PNG/WebP по настоящей сигнатуре байт', async () => {
  assert.equal(detectFormat(await makeJpeg(10, 10)).format, 'jpeg');
  assert.equal(detectFormat(await makePng(10, 10)).format, 'png');
  assert.equal(detectFormat(await makeWebp(10, 10)).format, 'webp');
});

test('detectFormat: отклоняет всё, чего нет в allowlist (SVG/HTML/GIF/пустой буфер)', () => {
  assert.equal(detectFormat(Buffer.from('<svg onload=alert(1)></svg>')), null);
  assert.equal(detectFormat(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(detectFormat(Buffer.from('GIF89a')), null);
  assert.equal(detectFormat(Buffer.alloc(0)), null);
});

test('validateSourceImage: отклоняет файл с чужим расширением, но верной сигнатурой — принимает по сигнатуре, не по имени', async () => {
  // Задание, раздел 5: "validated by real MIME/signature, not just
  // extension" — эта функция вообще не принимает имя файла как аргумент,
  // поэтому расширение физически не может повлиять на решение.
  const jpeg = await makeJpeg(200, 200);
  const result = await validateSourceImage(jpeg);
  assert.equal(result.format, 'jpeg');
});

test('validateSourceImage: отклоняет файл без валидной сигнатуры', async () => {
  await assert.rejects(() => validateSourceImage(Buffer.from('not an image at all, just text')));
});

test('validateSourceImage: отклоняет подделанную сигнатуру (PNG magic bytes + мусор вместо реальных данных)', async () => {
  const fakePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('this is not really png pixel data, just padding bytes'.repeat(3)),
  ]);
  await assert.rejects(() => validateSourceImage(fakePng));
});

test('validateSourceImage: отклоняет файл больше MAX_SOURCE_BYTES', async () => {
  const oversized = Buffer.alloc(MAX_SOURCE_BYTES + 1, 0);
  await assert.rejects(() => validateSourceImage(oversized));
});

test('validateSourceImage: отклоняет изображение больше MAX_SOURCE_DIMENSION_PX по стороне', async () => {
  // sharp create для однотонного растра дёшев даже на больших размерах —
  // не требует декомпрессии настоящего файла (не настоящий decompression
  // bomb сценарий, но проверяет ИМЕННО ветку лимита размеров).
  const huge = await sharp({
    create: { width: MAX_SOURCE_DIMENSION_PX + 100, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } },
  }).jpeg({ quality: 50 }).toBuffer();
  await assert.rejects(() => validateSourceImage(huge));
});

test('validateSourceImage: принимает нормальное изображение и возвращает реальные размеры', async () => {
  const result = await validateSourceImage(await makeJpeg(640, 480));
  assert.equal(result.format, 'jpeg');
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
});

test('processImage: создаёт ровно 3 WebP-варианта (thumb/card/full) с корректными размерами', async () => {
  const src = await makeJpeg(2000, 1000);
  const result = await processImage(src);
  assert.deepEqual(Object.keys(result.variants).sort(), ['card', 'full', 'thumb']);
  for (const [name, opts] of Object.entries(VARIANTS)) {
    const v = result.variants[name];
    assert.ok(v.buffer.toString('ascii', 8, 12) === 'WEBP', `${name} должен быть настоящим WebP`);
    // fit:'inside' сохраняет пропорции — длинная сторона не должна превышать
    // заявленный maxEdge варианта (задание, раздел 5: "don't stretch/distort").
    assert.ok(Math.max(v.width, v.height) <= opts.maxEdge, `${name}: ${v.width}x${v.height} превышает maxEdge=${opts.maxEdge}`);
  }
  // Соотношение сторон исходника (2:1) сохранено во всех вариантах —
  // никакого искажения/растяжения.
  for (const v of Object.values(result.variants)) {
    assert.ok(Math.abs(v.width / v.height - 2) < 0.05);
  }
});

test('processImage: не увеличивает маленькое изображение сверх исходного размера (withoutEnlargement)', async () => {
  const src = await makeJpeg(100, 80);
  const result = await processImage(src);
  assert.ok(result.variants.full.width <= 100 && result.variants.full.height <= 80);
});

test('processImage: работает одинаково для PNG и WebP источников (не только JPEG)', async () => {
  const png = await processImage(await makePng(300, 200));
  assert.equal(png.sourceFormat, 'png');
  const webp = await processImage(await makeWebp(300, 200));
  assert.equal(webp.sourceFormat, 'webp');
});

test('processImage: результат не содержит EXIF/метаданные источника (sharp по умолчанию не копирует их в WebP-вывод)', async () => {
  const withExif = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withMetadata({ exif: { IFD0: { Copyright: 'sensitive-owner-info' } } })
    .jpeg()
    .toBuffer();
  const result = await processImage(withExif);
  const meta = await sharp(result.variants.full.buffer).metadata();
  assert.equal(meta.exif, undefined, 'обработанный вариант не должен содержать EXIF исходника');
});
