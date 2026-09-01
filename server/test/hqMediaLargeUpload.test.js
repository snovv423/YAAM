'use strict';

// Контракт «владелец загружает обычный крупный оригинал с камеры».
//
// До этой правки штатный pipeline отклонял всё тяжелее 15 МиБ, хотя кадр
// современной камеры/телефона в максимальном качестве — это 18-25 МиБ
// (реальный пример из фотосессии ресторана: 5152x7728, 21.4 МиБ). Владелец
// был вынужден пережимать фотографию вручную. Верхний байтовый предел поднят
// до 40 МиБ; пиксельные пределы (8000px по стороне, 40 Мп по площади)
// СОХРАНЕНЫ — именно они, а не байты, ограничивают работу декодера.
//
// Генерация тяжёлых фикстур: сплошная заливка сжимается в килобайты, поэтому
// «тяжёлый» JPEG делается из псевдослучайного шума — он практически
// несжимаем и даёт нужный вес при умеренном разрешении.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const limits = require('../services/hq/media/limits');
const pipeline = require('../services/hq/media/imagePipeline');
const { ValidationError } = require('../services/hq/restaurantLifecycle');

const MiB = 1024 * 1024;

function noiseRgb(width, height, seed = 1) {
  const buf = Buffer.allocUnsafe(width * height * 3);
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    // xorshift32 — детерминированный шум без зависимостей.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    buf[i] = s & 0xff;
  }
  return sharp(buf, { raw: { width, height, channels: 3 } });
}

async function noisyJpegAtLeast(bytes) {
  // Подбираем разрешение, пока не наберём нужный вес; шум q100 даёт
  // примерно 1.5-2 байта на пиксель.
  for (const side of [3200, 4000, 4600, 5200, 5800]) {
    const buf = await noiseRgb(side, side, side).jpeg({ quality: 100 }).toBuffer();
    if (buf.length >= bytes) return buf;
  }
  throw new Error('не удалось собрать достаточно тяжёлую фикстуру');
}

let bigJpeg;
let smallJpeg;

test.before(async () => {
  bigJpeg = await noisyJpegAtLeast(15 * MiB + 1);
  smallJpeg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 90, b: 40 } } })
    .jpeg({ quality: 90 }).toBuffer();
});

// ── единый источник лимитов ───────────────────────────────────────────────

test('лимиты объявлены в одном модуле и совпадают во всех слоях', () => {
  assert.equal(limits.MAX_SOURCE_BYTES, 40 * MiB);
  // imagePipeline реэкспортирует те же значения — старые импорты не сломаны.
  assert.equal(pipeline.MAX_SOURCE_BYTES, limits.MAX_SOURCE_BYTES);
  assert.equal(pipeline.MAX_SOURCE_PIXELS, limits.MAX_SOURCE_PIXELS);
  assert.equal(pipeline.MAX_SOURCE_DIMENSION_PX, limits.MAX_SOURCE_DIMENSION_PX);

  // Слой представления и проверка диска читают тот же модуль, без литералов.
  const view = require('../hq/photosViews');
  assert.equal(view.MAX_SOURCE_BYTES, limits.MAX_SOURCE_BYTES);
  const diskUsage = require('../services/hq/media/diskUsage');
  assert.equal(diskUsage.MIN_FREE_BYTES_FOR_UPLOAD, limits.MAX_SOURCE_BYTES * 3);

  for (const rel of ['hq/photosViews.js', 'routes/hq/restaurants.js', 'services/hq/media/diskUsage.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.doesNotMatch(src, /15 \* 1024 \* 1024|40 \* 1024 \* 1024/,
      `${rel}: байтовый лимит должен читаться из services/hq/media/limits.js, а не быть литералом`);
  }
});

test('пиксельные пределы НЕ ослаблены вместе с байтовым', () => {
  assert.equal(limits.MAX_SOURCE_PIXELS, 40_000_000);
  assert.equal(limits.MAX_SOURCE_DIMENSION_PX, 8000);
  // Целевой реальный кадр 5152x7728 обязан укладываться в оба предела.
  assert.ok(5152 <= limits.MAX_SOURCE_DIMENSION_PX && 7728 <= limits.MAX_SOURCE_DIMENSION_PX);
  assert.ok(5152 * 7728 <= limits.MAX_SOURCE_PIXELS, '5152x7728 = 39.81 Мп должно проходить');
  // Явная защита libvips на входе, а не только наша проверка.
  const src = fs.readFileSync(path.join(__dirname, '../services/hq/media/imagePipeline.js'), 'utf8');
  // limitInputPixels стоит на декодере (processImage). На metadata() его
  // ставить нельзя: libvips бросил бы на открытии, и владелец получил бы
  // «файл повреждён» вместо понятного сообщения о разрешении.
  assert.match(src, /sharp\(buffer, \{ limitInputPixels: MAX_SOURCE_PIXELS \}\)\s*\n\s*\.rotate\(\)/);
  assert.match(src, /metadata = await sharp\(buffer\)\.metadata\(\);/);
});

// ── A: валидный файл >15 МиБ и <40 МиБ ────────────────────────────────────

test('A: валидное изображение тяжелее прежних 15 МиБ проходит настоящий pipeline', async () => {
  assert.ok(bigJpeg.length > 15 * MiB, `фикстура должна быть >15 МиБ, получено ${bigJpeg.length}`);
  assert.ok(bigJpeg.length < limits.MAX_SOURCE_BYTES);

  const meta = await pipeline.validateSourceImage(bigJpeg);
  assert.equal(meta.format, 'jpeg');

  const out = await pipeline.processImage(bigJpeg);
  assert.deepEqual(Object.keys(out.variants).sort(), ['card', 'full', 'master', 'thumb']);
  const edges = { thumb: 320, card: 800, full: 1920, master: 3200 };
  for (const [name, maxEdge] of Object.entries(edges)) {
    const v = out.variants[name];
    assert.ok(Math.max(v.width, v.height) <= maxEdge, `${name}: длинная сторона ${v.width}x${v.height} > ${maxEdge}`);
    // Настоящий WebP: RIFF....WEBP.
    assert.equal(v.buffer.subarray(0, 4).toString('ascii'), 'RIFF', `${name}: не RIFF`);
    assert.equal(v.buffer.subarray(8, 12).toString('ascii'), 'WEBP', `${name}: не WEBP`);
    const vm = await sharp(v.buffer).metadata();
    assert.equal(vm.format, 'webp');
  }
  // Смысл всей операции: постоянно хранится заметно меньше исходника.
  const stored = Object.values(out.variants).reduce((s, v) => s + v.buffer.length, 0);
  assert.ok(stored < bigJpeg.length, 'сумма вариантов должна быть меньше исходника');
});

// ── B: файл больше нового предела ─────────────────────────────────────────

test('B: файл больше 40 МиБ отклоняется контролируемо и с понятным текстом', async () => {
  const oversized = Buffer.alloc(limits.MAX_SOURCE_BYTES + 1, 0xff);
  await assert.rejects(
    () => pipeline.validateSourceImage(oversized),
    (err) => {
      assert.ok(err instanceof ValidationError, 'должна быть ValidationError, а не 500');
      assert.equal(err.message, limits.TOO_LARGE_MESSAGE);
      assert.match(err.message, /40 МБ/);
      return true;
    },
  );
});

test('B: multer настроен на тот же предел и отдаёт по нему отдельное сообщение', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hq/restaurants.js'), 'utf8');
  assert.match(src, /limits: \{ fileSize: MAX_SOURCE_BYTES, files: 1 \}/);
  assert.match(src, /require\('\.\.\/\.\.\/services\/hq\/media\/limits'\)/);
  assert.match(src, /err\.code === 'LIMIT_FILE_SIZE'/);
  assert.match(src, /return TOO_LARGE_MESSAGE/);
  // Оба HQ entry point (фото блюда и фото ресторана) используют один и тот же
  // upload и один и тот же текст ошибки.
  // Два вызова в обработчиках ошибок; третье вхождение — само объявление.
  assert.equal((src.match(/error: uploadErrorMessage\(err\)/g) || []).length, 2);
  assert.equal((src.match(/photoUpload\.single\('photo'\)/g) || []).length, 2);
});

// ── C: в пределах байтов, но за пиксельным лимитом ────────────────────────

test('C: изображение в пределах 40 МиБ, но свыше 40 Мп отклоняется, сервер не падает', async () => {
  // 7000x6000 = 42 Мп: обе стороны в пределах 8000, превышена именно площадь.
  const bomb = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .jpeg({ quality: 70 }).toBuffer();
  assert.ok(bomb.length < limits.MAX_SOURCE_BYTES, 'фикстура должна проходить по байтам');
  assert.ok(7000 * 6000 > limits.MAX_SOURCE_PIXELS);
  await assert.rejects(
    () => pipeline.validateSourceImage(bomb),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /разрешение/i);
      assert.doesNotMatch(err.message, /40 МБ/, 'сообщение про пиксели не должно путаться с сообщением про байты');
      return true;
    },
  );
});

test('C: сторона больше 8000px по-прежнему отклоняется отдельным сообщением', async () => {
  const wide = await sharp({ create: { width: 8200, height: 200, channels: 3, background: { r: 5, g: 5, b: 5 } } })
    .jpeg({ quality: 70 }).toBuffer();
  await assert.rejects(() => pipeline.validateSourceImage(wide), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /8000px/);
    return true;
  });
});

// ── D: подделки и мусор ───────────────────────────────────────────────────

test('D: подделанный тип и не-изображение отклоняются так же, как раньше', async () => {
  const fakeJpegExt = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  await assert.rejects(() => pipeline.validateSourceImage(fakeJpegExt), ValidationError);

  // Верная сигнатура PNG + мусор вместо данных.
  const fakePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4096, 0x41),
  ]);
  await assert.rejects(() => pipeline.validateSourceImage(fakePng), ValidationError);

  await assert.rejects(() => pipeline.validateSourceImage(Buffer.alloc(0)), ValidationError);

  // GIF не входит в allowlist, хотя sharp его читает.
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  await assert.rejects(() => pipeline.validateSourceImage(gif), ValidationError);
});

// ── E: обычные небольшие файлы без регрессий ──────────────────────────────

test('E: обычные JPEG/PNG/WebP меньше 15 МиБ обрабатываются как прежде', async () => {
  const png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 30, g: 160, b: 90 } } })
    .png().toBuffer();
  const webp = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 90, g: 30, b: 160 } } })
    .webp().toBuffer();
  for (const [label, buf] of [['jpeg', smallJpeg], ['png', png], ['webp', webp]]) {
    assert.ok(buf.length < 15 * MiB);
    const out = await pipeline.processImage(buf);
    assert.equal(Object.keys(out.variants).length, 4, `${label}: должно быть 4 варианта`);
    assert.equal(out.sourceFormat, label);
  }
});

// ── H: HQ-валидация синхронизирована с сервером ───────────────────────────

test('H: HQ больше не блокирует допустимый файл 16-40 МиБ прежним лимитом', () => {
  const { renderPhotoManager } = require('../hq/photosViews');
  const html = renderPhotoManager({
    title: 'Фотографии блюда', photos: [], uploadAction: '/hq/items/1/photos',
    actionBase: '/hq/items/1/photos', csrfToken: 't', maxPhotos: 20, mediaConfigured: true,
  });
  assert.match(html, new RegExp(`data-max-bytes="${limits.MAX_SOURCE_BYTES}"`));
  assert.doesNotMatch(html, /data-max-bytes="15728640"/, 'старый лимит 15 МиБ не должен попадать в разметку');

  const script = fs.readFileSync(path.join(__dirname, '../hq/static/hq.js'), 'utf8');
  // Клиент читает предел из атрибута формы, а не хранит своё число.
  assert.match(script, /data-max-bytes/);
  assert.match(script, /file\.size > maxBytes/);
  assert.match(script, /Максимальный размер исходного файла/);
  assert.doesNotMatch(script, /15 \* 1024 \* 1024|15728640/);
});

test('H: индикатор загрузки локальный, без затемнения страницы', () => {
  const layout = fs.readFileSync(path.join(__dirname, '../hq/layout.js'), 'utf8');
  const rule = /\.upload-busy\{([^}]*)\}/.exec(layout);
  assert.ok(rule, 'правило .upload-busy не найдено');
  assert.match(rule[1], /position:absolute/);
  assert.doesNotMatch(rule[1], /position:fixed/);
});

// ── reverse proxy ─────────────────────────────────────────────────────────

test('nginx пропускает запрос больше прикладного лимита, чтобы ошибку отдавало приложение', () => {
  // Если client_max_body_size окажется меньше MAX_SOURCE_BYTES, владелец
  // получит голый 413 от nginx вместо понятного текста про 40 МБ.
  const appLimitMib = limits.MAX_SOURCE_BYTES / MiB;
  for (const conf of ['deploy/nginx-yaam-production.conf', 'deploy/nginx-hqtest.yaam.su.conf']) {
    const src = fs.readFileSync(path.join(__dirname, '..', conf), 'utf8');
    const uploadLimits = [...src.matchAll(/client_max_body_size (\d+)m;/g)].map((m) => Number(m[1]));
    assert.ok(uploadLimits.length, `${conf}: не найден client_max_body_size в мегабайтах`);
    assert.ok(Math.max(...uploadLimits) > appLimitMib,
      `${conf}: максимальный client_max_body_size (${Math.max(...uploadLimits)}m) должен быть больше ${appLimitMib} МиБ`);
  }
});
