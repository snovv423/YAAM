'use strict';

// YAAM HQ Stage 5B.2 — операционная проверка места на диске для постоянного
// local media storage (задание, раздел 11). Фотографий немного (масштаб
// YAAM — Чечня, один VPS), поэтому полный рекурсивный обход каталога для
// подсчёта размера — не проблема производительности; отдельный dashboard
// не нужен, только: свободное место в файловой системе + текущий размер
// самого media-каталога.
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_SOURCE_BYTES } = require('./imagePipeline');

// Достаточно места для одной загрузки: исходный файл (до MAX_SOURCE_BYTES)
// решает временно существовать на диске дважды при atomic write (временный
// файл + старый, если это перезапись) плюс 4 WebP-варианта (thumb/card/full/
// master — на практике заметно компактнее исходника благодаря сжатию). 3x
// MAX_SOURCE_BYTES — операционный запас с кратным избытком, не точный расчёт
// байт в байт (задание: "fail-closed только при реально опасном остатке").
const MIN_FREE_BYTES_FOR_UPLOAD = MAX_SOURCE_BYTES * 3;

// Порог для лог-предупреждения (не блокирует загрузку) — заметно выше
// MIN_FREE_BYTES_FOR_UPLOAD, чтобы владелец YAAM успел отреагировать до
// того, как загрузка реально начнёт отказывать.
const LOW_SPACE_WARNING_BYTES = 2 * 1024 * 1024 * 1024; // 2 ГиБ

async function directorySize(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(full);
        total += st.size;
      } catch {
        // Файл исчез между readdir и stat (например, параллельное удаление
        // фото) — не ошибка операционной проверки, просто пропускаем.
      }
    }
  }
  return total;
}

// Возвращает { freeBytes, totalBytes, usedByMediaBytes }. Никогда не бросает
// наружу — вызывающий код (photoService.js, HQ «Настройки») должен уметь
// продолжить работу, даже если статистика диска временно недоступна (задание:
// "без лишнего шума").
async function getMediaDiskUsage(mediaRoot) {
  const [stats, usedByMediaBytes] = await Promise.all([
    fs.statfs(mediaRoot),
    directorySize(mediaRoot),
  ]);
  return {
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
    usedByMediaBytes,
  };
}

module.exports = {
  MIN_FREE_BYTES_FOR_UPLOAD,
  LOW_SPACE_WARNING_BYTES,
  directorySize,
  getMediaDiskUsage,
};
