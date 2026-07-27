'use strict';

// YAAM HQ Stage 5B/5B.1/5B.2 — интерфейс media provider (задание, раздел 4).
//
// Единый контракт, через который весь остальной код (imagePipeline.js,
// photoService.js) работает с хранилищем файлов, никогда не зная деталей
// реализации:
//
//   async upload(objectKey, buffer, contentType) -> void   атомарно
//   async delete(objectKey) -> void        идемпотентно: удаление уже
//                                           отсутствующего ключа — не ошибка
//   getPublicUrl(objectKey) -> string      синхронно, чистый вывод (без
//                                           побочных эффектов, без сети).
//                                           Бросает, если objectKey не
//                                           начинается с `public/` —
//                                           приватный master физически не
//                                           может получить публичный URL
//                                           через этот метод (задание,
//                                           раздел 3).
//   validateConfig() -> void               бросает MediaProviderConfigError
//                                           при неполной конфигурации —
//                                           fail-closed, вызывается СРАЗУ при
//                                           создании провайдера, не лениво
//   async healthCheck() -> { ok, detail }  никогда не бросает, только
//                                           докладывает
//   async getDiskUsage() -> { freeBytes, totalBytes, usedByMediaBytes }
//                                           операционная проверка (задание,
//                                           раздел 11) — не часть строгого
//                                           контракта провайдера (duck-typed,
//                                           вызывающий код проверяет
//                                           typeof === 'function' перед
//                                           использованием)
//
// objectKey — это уже готовый, безопасный, детерминированный ключ объекта,
// формируется вызывающим кодом (photoService.js), никогда не выводится из
// пользовательского ввода (оригинальное имя файла нигде не используется как
// часть пути — задание, раздел 5). Ключ ВСЕГДА начинается с одного из двух
// непересекающихся префиксов (задание, раздел 3):
//   `public/...`          — thumb/card/full, отдаётся наружу (Nginx в
//                            production, Express static в dev/test);
//   `private/masters/...` — master, НИКОГДА не раздаётся ни одним публичным
//                            маршрутом и не может получить URL через
//                            getPublicUrl() (см. assertPublicObjectKey ниже).
//
// YAAM работает в масштабе одного региона (Чечня), фотографии загружает
// только владелец через HQ, ресторанов — не тысячи. Отдельное S3-совместимое
// хранилище на этом масштабе — инфраструктура "на вырост", которая не нужна
// (задание Stage 5B.2, раздел 1) — единственный провайдер теперь
// LocalMediaProvider с двумя режимами (temp — тесты/dev, persistent —
// постоянная директория на VPS). Бинарные данные никогда не попадают в
// PostgreSQL — этот модуль единственное место в кодовой базе, которое
// реально пишет/удаляет файлы объектов.

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

class MediaProviderConfigError extends Error {}

// Разрешаем только относительные ключи вида `a/b/c.ext` — никаких `..`,
// никакого абсолютного пути, никакого `\`. Защита от path traversal
// (задание, раздел 8).
const SAFE_OBJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

function assertSafeObjectKey(objectKey) {
  if (typeof objectKey !== 'string' || !objectKey) {
    throw new Error('objectKey обязателен и должен быть непустой строкой.');
  }
  if (objectKey.includes('..') || objectKey.includes('\\') || objectKey.startsWith('/')) {
    throw new Error(`Небезопасный objectKey: ${objectKey}`);
  }
  if (!SAFE_OBJECT_KEY_RE.test(objectKey)) {
    throw new Error(`objectKey содержит недопустимые символы: ${objectKey}`);
  }
}

const PUBLIC_PREFIX = 'public/';

// Единственное место, решающее "можно ли вообще вывести публичный URL для
// этого ключа" — не полагается на то, что вызывающий код (photoService.js)
// всегда аккуратен, реальная проверка здесь (задание, раздел 3/9).
function assertPublicObjectKey(objectKey) {
  if (!objectKey.startsWith(PUBLIC_PREFIX)) {
    throw new Error(`getPublicUrl() отклонён: "${objectKey}" не находится под публичным префиксом "${PUBLIC_PREFIX}".`);
  }
}

// ---------------------------------------------------------------------------
// LocalMediaProvider — единственный провайдер (см. заголовочный комментарий).
// Два режима:
//   temp/dev/test (persistent=false) — как и раньше: baseDir опционален
//   (mkdtempSync, если не передан), cleanup() полностью стирает каталог
//   после теста.
//   persistent (persistent=true) — постоянная директория на VPS
//   (MEDIA_LOCAL_ROOT), не создаётся во временном каталоге, не стирается при
//   restart/deploy, cleanup() запрещён (defense-in-depth против случайного
//   вызова над реальными production-файлами).
// ---------------------------------------------------------------------------

class LocalMediaProvider {
  constructor({ baseDir, baseUrl, persistent } = {}) {
    this.persistent = Boolean(persistent);
    if (this.persistent) {
      if (!baseDir) {
        throw new MediaProviderConfigError('LocalMediaProvider: persistent-режим требует baseDir (MEDIA_LOCAL_ROOT).');
      }
      if (!path.isAbsolute(baseDir)) {
        throw new MediaProviderConfigError(`LocalMediaProvider: MEDIA_LOCAL_ROOT должен быть абсолютным путём, получено "${baseDir}".`);
      }
      this.baseDir = baseDir;
    } else {
      this.baseDir = baseDir || fsSync.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-local-'));
    }
    this.baseUrl = (baseUrl || 'local-media://fixtures').replace(/\/$/, '');
    this._contentTypes = new Map();
  }

  // Синхронно (тот же контракт, что и раньше — вызывается сразу при
  // создании провайдера, задание: fail-closed при неправильной
  // конфигурации). В persistent-режиме дополнительно создаёт обязательные
  // public/ и private/masters/ подкаталоги (идемпотентно, `recursive: true`)
  // и проверяет права чтения/записи — ошибка здесь останавливает старт
  // приложения понятным сообщением, а не необъяснимым ENOENT/EACCES при
  // первой реальной загрузке.
  validateConfig() {
    if (!this.persistent) return;
    try {
      fsSync.mkdirSync(path.join(this.baseDir, 'public'), { recursive: true });
      fsSync.mkdirSync(path.join(this.baseDir, 'private', 'masters'), { recursive: true });
      fsSync.accessSync(this.baseDir, fsSync.constants.R_OK | fsSync.constants.W_OK);
    } catch (err) {
      throw new MediaProviderConfigError(`LocalMediaProvider: MEDIA_LOCAL_ROOT "${this.baseDir}" недоступен для чтения/записи: ${err.message}`);
    }
  }

  async healthCheck() {
    try {
      await fs.access(this.baseDir, fsSync.constants.W_OK);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  async getDiskUsage() {
    const { getMediaDiskUsage } = require('./diskUsage');
    return getMediaDiskUsage(this.baseDir);
  }

  // Вычисляет реальный путь на диске для objectKey и проверяет, что он
  // остаётся строго внутри baseDir (задание, раздел 8: "resolved path
  // остаётся внутри media root") — защита не только на уровне regex
  // (assertSafeObjectKey), но и на уровне фактически разрешённого пути,
  // независимый второй слой проверки.
  _resolvePath(objectKey) {
    assertSafeObjectKey(objectKey);
    const resolvedRoot = path.resolve(this.baseDir);
    const resolvedPath = path.resolve(resolvedRoot, objectKey);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Небезопасный objectKey (выход за пределы media root): ${objectKey}`);
    }
    return resolvedPath;
  }

  // Атомарная запись (задание, раздел 8): пишем во временный файл В ТОЙ ЖЕ
  // директории (тот же раздел файловой системы — иначе rename() не был бы
  // атомарным, а свёлся бы к copy+unlink), затем rename() поверх финального
  // имени. Одновременный upload с тем же ключом (что структурно не должно
  // происходить — ключ включает crypto.randomUUID() — но проверяется как
  // defense-in-depth) не может оставить частично записанный файл по
  // финальному пути: rename() либо ещё не произошёл (виден старый/
  // отсутствующий файл), либо уже произошёл целиком.
  async upload(objectKey, buffer, contentType) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('upload() ожидает Buffer.');
    }
    const filePath = this._resolvePath(objectKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);
    this._contentTypes.set(objectKey, contentType || 'application/octet-stream');
  }

  async delete(objectKey) {
    const filePath = this._resolvePath(objectKey);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this._contentTypes.delete(objectKey);
  }

  // baseUrl уже представляет корень public/ (Express static монтирует
  // baseDir/public, Nginx alias в production указывает на .../media/public/
  // — см. server/deploy/nginx-yaam-postgresql.conf) — поэтому сам префикс
  // `public/` из objectKey СТРИПАЕТСЯ при выводе URL, иначе он задвоился бы
  // (.../media/public/public/...). assertPublicObjectKey всё равно
  // проверяет полный objectKey (с префиксом) — это по-прежнему единственный
  // источник истины о том, публичный ключ или нет.
  getPublicUrl(objectKey) {
    assertSafeObjectKey(objectKey);
    assertPublicObjectKey(objectKey);
    const relative = objectKey.slice(PUBLIC_PREFIX.length);
    return `${this.baseUrl}/${relative}`;
  }

  // Не часть общего интерфейса — вспомогательный метод только для тестов,
  // чтобы прочитать физически записанный файл и проверить его содержимое.
  async readFileForTest(objectKey) {
    return fs.readFile(this._resolvePath(objectKey));
  }

  // Не часть общего интерфейса — полная очистка временного каталога после
  // теста (задание, раздел 4: "auto-cleans after tests"). Запрещён в
  // persistent-режиме — вызов над реальным MEDIA_LOCAL_ROOT стёр бы
  // production-фотографии; ни один production-код его не вызывает (только
  // тесты), но проверка здесь — простой и дешёвый defense-in-depth.
  async cleanup() {
    if (this.persistent) {
      throw new Error('LocalMediaProvider.cleanup() запрещён в persistent-режиме (защита от удаления реальных файлов).');
    }
    await fs.rm(this.baseDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Фабрика: выбор провайдера по переменным окружения. Fail-closed (задание,
// раздел 4): если MEDIA_PROVIDER не задан вовсе — возвращает null, и
// вызывающий код (services/postgresql/app.js) обязан НЕ монтировать медиа-
// функциональность вовсе, а не тихо откатываться на что-то другое.
//
// Единственный поддерживаемый kind — "local", с двумя режимами, различаемыми
// тем, какая переменная окружения задана:
//   MEDIA_LOCAL_ROOT задан -> persistent (production VPS storage);
//   MEDIA_LOCAL_DIR задан (или не задано ничего) -> temp/dev/test.
// Обе одновременно — ошибка конфигурации (неоднозначно, какой режим имелся
// в виду). В production (APP_ENV или NODE_ENV === 'production') ТОЛЬКО
// persistent разрешён — temp-режим означал бы, что фотографии исчезают при
// каждом restart/deploy, что для реального VPS неприемлемо.
// ---------------------------------------------------------------------------

function createMediaProviderFromEnv(env = process.env) {
  const kind = env.MEDIA_PROVIDER;
  if (!kind) return null;

  if (kind !== 'local') {
    throw new MediaProviderConfigError(`Неизвестный MEDIA_PROVIDER: ${kind} (единственный поддерживаемый — "local").`);
  }

  const hasRoot = Boolean(env.MEDIA_LOCAL_ROOT);
  const hasDir = Boolean(env.MEDIA_LOCAL_DIR);
  if (hasRoot && hasDir) {
    throw new MediaProviderConfigError('Заданы одновременно MEDIA_LOCAL_ROOT и MEDIA_LOCAL_DIR — укажите ровно один (persistent либо temp/test).');
  }

  const isProduction = env.APP_ENV === 'production' || env.NODE_ENV === 'production';
  if (isProduction && !hasRoot) {
    throw new MediaProviderConfigError('В production MEDIA_PROVIDER=local требует MEDIA_LOCAL_ROOT (постоянная директория) — временный/auto-каталог запрещён.');
  }

  const provider = new LocalMediaProvider({
    baseDir: env.MEDIA_LOCAL_ROOT || env.MEDIA_LOCAL_DIR,
    baseUrl: env.MEDIA_LOCAL_BASE_URL,
    persistent: hasRoot,
  });
  provider.validateConfig();
  return provider;
}

module.exports = {
  MediaProviderConfigError,
  LocalMediaProvider,
  createMediaProviderFromEnv,
  assertSafeObjectKey,
  assertPublicObjectKey,
  PUBLIC_PREFIX,
};
