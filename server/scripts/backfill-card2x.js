'use strict';

// Достройка HiDPI-варианта card2x для уже загруженных фотографий.
//
// ЗАЧЕМ. card2x появился после того, как эти фотографии были загружены, и для
// них на диске лежат только thumb/card/full. Пока файла нет, клиент не должен
// на него ссылаться — иначе браузер получит 404 внутри srcset. Поэтому вариант
// сначала достраивается этим скриптом, и только потом клиент начинает его
// предлагать.
//
// ОТКУДА БЕРУТСЯ ПИКСЕЛИ. Из непубличного master (3200 px, quality 95),
// который pipeline сохраняет ровно для такого случая — «повторная генерация
// вариантов при смене настроек обработки без повторной загрузки владельцем».
// Оригинальные загруженные байты не читаются и не существуют на диске вовсе
// (см. imagePipeline: наружу уходят только пиксели после decode/re-encode).
//
// БЕЗОПАСНОСТЬ.
//   - идемпотентен: уже существующий card2x пропускается, повторный запуск
//     ничего не портит и не плодит дублей;
//   - ничего не перезаписывает: thumb/card/full/master не трогаются вовсе,
//     запись идёт только в новый файл card2x.webp;
//   - в БД не пишет: варианты выводятся из storage_key, миграция не нужна;
//   - ошибка одной фотографии не останавливает остальные — она считается и
//     печатается в конце;
//   - --dry-run показывает план, ничего не записывая.
//
// Параметры обработки берутся из самого pipeline (VARIANTS.card2x), а не
// дублируются здесь: иначе достроенные файлы разошлись бы с теми, что создаёт
// обычная загрузка.

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { VARIANTS } = require('../services/hq/media/imagePipeline');

const DRY = process.argv.includes('--dry-run');
const MEDIA_ROOT = process.env.MEDIA_LOCAL_ROOT || '/opt/yaam-prod/media';
// Раскладка хранилища: приватные мастера и публичные варианты лежат в двух
// разных поддеревьях с одинаковой внутренней структурой
// (<owner-type>/<id>/<uuid>/), поэтому путь к публичному каталогу получается
// переносом относительного пути из одного корня в другой.
const MASTERS_ROOT = path.join(MEDIA_ROOT, 'private', 'masters');
const PUBLIC_ROOT = path.join(MEDIA_ROOT, 'public');
const VARIANT = 'card2x';
const opts = VARIANTS[VARIANT];

if (!opts) {
  console.error(`В pipeline нет варианта ${VARIANT} — нечего достраивать.`);
  process.exit(1);
}

// Обходим дерево мастеров: .../private/masters/<owner-type>/<id>/<uuid>/master.webp
function findMasters(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findMasters(p, acc);
    else if (e.name === 'master.webp') acc.push(p);
  }
  return acc;
}

function publicDirForMaster(masterPath) {
  const rel = path.relative(MASTERS_ROOT, path.dirname(masterPath));
  return path.join(PUBLIC_ROOT, rel);
}

(async () => {
  if (!fs.existsSync(MASTERS_ROOT)) {
    console.error(`Каталог мастеров не найден: ${MASTERS_ROOT}`);
    process.exit(1);
  }
  const masters = findMasters(MASTERS_ROOT);
  let created = 0; let skipped = 0; let missingDir = 0;
  const failures = [];

  for (const master of masters) {
    const outDir = publicDirForMaster(master);
    const outFile = path.join(outDir, `${VARIANT}.webp`);
    try {
      if (!fs.existsSync(outDir)) {
        // Публичных вариантов нет — фотография удалена или ещё не разложена.
        // Создавать каталог наугад нельзя: он попал бы в раздачу без остальных
        // вариантов.
        missingDir += 1;
        continue;
      }
      if (fs.existsSync(outFile)) { skipped += 1; continue; }
      if (DRY) { created += 1; continue; }

      const { data, info } = await sharp(master)
        .rotate()
        .resize({ width: opts.maxEdge, height: opts.maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: opts.quality, effort: 6, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });

      // Пишем через временный файл и переименование: наполовину записанный
      // card2x.webp не должен попасть в раздачу.
      const tmp = `${outFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, outFile);
      created += 1;
      if (created % 25 === 0) console.log(`  создано ${created}…`);
      void info;
    } catch (err) {
      failures.push(`${master}: ${err.message}`);
    }
  }

  console.log(`\n${DRY ? '[dry-run] ' : ''}мастеров найдено: ${masters.length}`);
  console.log(`  создано ${VARIANT}: ${created}`);
  console.log(`  уже было: ${skipped}`);
  if (missingDir) console.log(`  без публичного каталога (пропущено): ${missingDir}`);
  if (failures.length) {
    console.log(`  ошибок: ${failures.length}`);
    failures.slice(0, 10).forEach((f) => console.log(`    ${f}`));
    process.exitCode = 1;
  }
})();
