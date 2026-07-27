'use strict';

// YAAM HQ Stage 5B — валидация и обработка загруженных изображений (задание,
// раздел 5). Единственное место в кодовой базе, которое трогает пиксели.
// Использует sharp (libvips) — согласно заданию, писать собственный
// image-процессор запрещено.
//
// Ключевой принцип безопасности (задание, раздел 11 — polyglot-файлы,
// неверное расширение, SVG/HTML/скриптуемые форматы): исходные байты
// загруженного файла НИКОГДА не сохраняются и никогда не отдаются клиенту
// напрямую. Формат подтверждается по настоящей сигнатуре (magic bytes), а
// не по расширению файла и не по Content-Type от браузера, а после этого
// файл полностью ДЕКОДИРУЕТСЯ в пиксели через sharp/libvips и заново
// перекодируется в WebP. Даже валидный JPEG/PNG/WebP-полиглот с внедрённым
// вредоносным payload'ом за пределами настоящих данных изображения не
// переживает полный цикл decode->re-encode: наружу уходят только пиксели.
const sharp = require('sharp');
const { ValidationError } = require('../restaurantLifecycle');

// Разумные верхние пределы (задание, раздел 5: "reasonable max source file
// size", "reasonable max image dimensions", "decompression-bomb
// protection") — защита от опечаток/абсурдных файлов и от decompression
// bomb (крошечный файл, распаковывающийся в гигантский растр), а не
// бизнес-ограничение: ни один настоящий ресторан не должен в них упереться.
const MAX_SOURCE_BYTES = 15 * 1024 * 1024; // 15 МБ
const MAX_SOURCE_DIMENSION_PX = 8000; // по каждой стороне
const MAX_SOURCE_PIXELS = 40_000_000; // ~40 МП — с запасом выше типичных телефонных фото

// Детерминированные WebP-варианты (см. server/db/postgresql/schema.sql,
// комментарий к restaurant_photos/menu_item_photos): каждому базовому
// storage_key соответствуют ровно эти три суффикса.
const VARIANTS = {
  thumb: { maxEdge: 320, quality: 78 },
  card: { maxEdge: 800, quality: 82 },
  full: { maxEdge: 1920, quality: 85 },
};

const SIGNATURES = [
  { format: 'jpeg', mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    format: 'png',
    mime: 'image/png',
    test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    format: 'webp',
    mime: 'image/webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

// Определяет формат ИСКЛЮЧИТЕЛЬНО по настоящей сигнатуре байт (задание,
// раздел 5: "validated by real MIME/signature, not just extension"; раздел
// 11: SVG/HTML и прочие скриптуемые форматы отклоняются самим фактом
// отсутствия у них разрешённой сигнатуры — allowlist, не blocklist).
function detectFormat(buffer) {
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return sig;
  }
  return null;
}

async function validateSourceImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError('Файл фотографии пуст или повреждён.');
  }
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new ValidationError(`Файл слишком большой (максимум ${Math.floor(MAX_SOURCE_BYTES / 1024 / 1024)} МБ).`);
  }
  const sig = detectFormat(buffer);
  if (!sig) {
    throw new ValidationError('Разрешены только файлы JPEG, PNG или WebP.');
  }

  let metadata;
  try {
    // sharp сам по умолчанию ограничивает входные пиксели (limitInputPixels,
    // ~268 МП) — это защита от decompression bomb уровня библиотеки,
    // сохранена как есть (defense in depth) поверх наших более строгих
    // продуктовых лимитов ниже.
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new ValidationError('Не удалось прочитать файл как изображение — он повреждён или не является настоящим изображением.');
  }

  if (metadata.format !== sig.format) {
    // Сигнатура (первые байты) не совпала с тем, что реально декодировал
    // libvips — явный признак подделки/полиглота, отклоняем.
    throw new ValidationError('Формат файла не подтверждён при декодировании.');
  }
  if (!metadata.width || !metadata.height) {
    throw new ValidationError('Не удалось определить размеры изображения.');
  }
  if (metadata.width > MAX_SOURCE_DIMENSION_PX || metadata.height > MAX_SOURCE_DIMENSION_PX) {
    throw new ValidationError(`Слишком большое разрешение (максимум ${MAX_SOURCE_DIMENSION_PX}px по стороне).`);
  }
  if (metadata.width * metadata.height > MAX_SOURCE_PIXELS) {
    throw new ValidationError('Слишком большое разрешение изображения.');
  }

  return { format: sig.format, width: metadata.width, height: metadata.height };
}

// Обрабатывает валидированное изображение в три WebP-варианта.
// Возвращает { variants: { thumb, card, full }, sourceFormat, sourceWidth, sourceHeight }.
// Каждый variant: { buffer, width, height }.
//
// .rotate() без аргументов — авто-поворот по EXIF Orientation (задание,
// раздел 5: "fix EXIF orientation"); withMetadata() сознательно НЕ
// вызывается — sharp по умолчанию не копирует EXIF/ICC в вывод, то есть
// метаданные (включая GPS и прочее приватное) вырезаются сами (задание,
// раздел 5: "strip extraneous EXIF metadata").
async function processImage(buffer) {
  const source = await validateSourceImage(buffer);

  const variants = {};
  for (const [name, opts] of Object.entries(VARIANTS)) {
    const pipeline = sharp(buffer)
      .rotate()
      .resize({ width: opts.maxEdge, height: opts.maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    variants[name] = { buffer: data, width: info.width, height: info.height };
  }

  return {
    variants,
    sourceFormat: source.format,
    sourceWidth: source.width,
    sourceHeight: source.height,
  };
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_DIMENSION_PX,
  MAX_SOURCE_PIXELS,
  VARIANTS,
  detectFormat,
  validateSourceImage,
  processImage,
};
