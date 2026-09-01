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
  PUBLIC_VARIANT_NAMES,
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

test('processImage: создаёт ровно 4 WebP-варианта (thumb/card/full/master) с корректными размерами', async () => {
  const src = await makeJpeg(2000, 1000);
  const result = await processImage(src);
  assert.deepEqual(Object.keys(result.variants).sort(), ['card', 'full', 'master', 'thumb']);
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

test('processImage: EXIF orientation from iPhone/camera is applied before editor rotation metadata', async () => {
  const portraitPixelsWithLandscapeExif = await sharp({
    create: { width: 90, height: 160, channels: 3, background: { r: 40, g: 80, b: 120 } },
  }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await processImage(portraitPixelsWithLandscapeExif);
  assert.equal(result.variants.full.width, 160);
  assert.equal(result.variants.full.height, 90);
  const metadata = await sharp(result.variants.full.buffer).metadata();
  assert.equal(metadata.orientation, undefined);
});

// --- Stage 5B.1: master-вариант (сохранение для будущей повторной генерации) ---

test('PUBLIC_VARIANT_NAMES: содержит ровно thumb/card/full, БЕЗ master (не публичный вариант)', () => {
  assert.deepEqual(PUBLIC_VARIANT_NAMES.sort(), ['card', 'full', 'thumb']);
  assert.ok(!PUBLIC_VARIANT_NAMES.includes('master'));
});

test('master-вариант: заметно выше разрешение и качество, чем у full (задание: "future re-generation")', async () => {
  const src = await makeJpeg(3000, 1500);
  const result = await processImage(src);
  assert.ok(result.variants.master.width > result.variants.full.width);
  assert.ok(VARIANTS.master.quality >= VARIANTS.full.quality);
  assert.equal(VARIANTS.master.public, false);
});

test('качество WebP-вариантов приведено к диапазону 88-95 (Stage 5B.1: приоритет качества фото еды)', () => {
  for (const [name, opts] of Object.entries(VARIANTS)) {
    assert.ok(opts.quality >= 88 && opts.quality <= 95, `${name}: quality=${opts.quality} вне ожидаемого диапазона`);
  }
});

// --- Stage 5B.1: минимальный набор сценариев из задания (яркое блюдо с
// мелкими деталями / тёмное мясное блюдо / суп / выпечка / vertical/
// horizontal/square) — синтетические изображения (нет доступа к реальной
// фотографии еды), приближающие соответствующие характеристики (высокая
// частота деталей, низкая яркость, гладкий градиент, разные пропорции).
// Автоматическая проверка: корректное декодирование, сохранение пропорций,
// разумное соотношение размер/качество (не переразжато). Итоговое
// визуальное сравнение (заметна ли потеря фактуры на глаз) сделано отдельно
// через Chrome DevTools — см. финальный отчёт Stage 5B.1, раздел про
// визуальную проверку качества.
async function makeDetailedTexture(width, height, seed) {
  // Высокочастотный шум а-ля мелкая текстура (корочка/зелень/специи) —
  // сложнее всего сжимать без артефактов, поэтому лучший прокси для "яркое
  // блюдо с мелкими деталями".
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 190, b: 120 } } })
    .composite([{
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
          <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${seed}"/></filter>
          <rect width="100%" height="100%" filter="url(#n)" opacity="0.5"/>
        </svg>`,
      ),
    }])
    .jpeg({ quality: 95 })
    .toBuffer();
}
async function makeDarkMeat(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 45, g: 22, b: 18 } } })
    .composite([{
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
          <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.15" numOctaves="2"/></filter>
          <rect width="100%" height="100%" filter="url(#n)" opacity="0.35"/>
        </svg>`,
      ),
    }])
    .jpeg({ quality: 95 })
    .toBuffer();
}
async function makeSmoothGradient(width, height) {
  // Гладкий градиент а-ля поверхность супа — уязвим к banding при низком
  // качестве/агрессивной цветовой субдискретизации.
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><radialGradient id="g"><stop offset="0%" stop-color="#e8b050"/><stop offset="100%" stop-color="#7a3c10"/></radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`,
  );
  return sharp(svg).jpeg({ quality: 95 }).toBuffer();
}
async function makePastry(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 195, g: 150, b: 90 } } })
    .composite([{
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
          <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="4"/></filter>
          <rect width="100%" height="100%" filter="url(#n)" opacity="0.4"/>
        </svg>`,
      ),
    }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

const FOOD_SCENARIOS = [
  { name: 'яркое блюдо с мелкими деталями', make: makeDetailedTexture, width: 1600, height: 1200 },
  { name: 'тёмное мясное блюдо', make: makeDarkMeat, width: 1600, height: 1200 },
  { name: 'суп (гладкий градиент)', make: makeSmoothGradient, width: 1600, height: 1200 },
  { name: 'выпечка', make: makePastry, width: 1600, height: 1200 },
  { name: 'вертикальная фотография', make: makeDetailedTexture, width: 1200, height: 1600 },
  { name: 'горизонтальная фотография', make: makeDetailedTexture, width: 1920, height: 1080 },
  { name: 'квадратная фотография', make: makeDetailedTexture, width: 1400, height: 1400 },
];

for (const scenario of FOOD_SCENARIOS) {
  test(`processImage: ${scenario.name} — корректно обрабатывается, пропорции сохранены, разумный размер файла`, async () => {
    const src = await scenario.make(scenario.width, scenario.height, 1);
    const result = await processImage(src);
    const srcRatio = scenario.width / scenario.height;
    for (const [name, v] of Object.entries(result.variants)) {
      const decoded = await sharp(v.buffer).metadata();
      assert.equal(decoded.format, 'webp', `${scenario.name}/${name}: должен декодироваться как webp`);
      const ratio = v.width / v.height;
      assert.ok(Math.abs(ratio - srcRatio) < 0.02, `${scenario.name}/${name}: пропорции искажены (${ratio} vs ${srcRatio})`);
      // Не переразжато: даже thumb детализированной текстуры не должен
      // схлопываться в единицы байт (был бы явный признак деградации).
      assert.ok(v.buffer.length > 200, `${scenario.name}/${name}: подозрительно маленький файл (${v.buffer.length} байт) — возможна чрезмерная потеря качества`);
    }
  });
}
