'use strict';

// YAAM HQ Stage 5B — интерфейс media provider (задание, раздел 4).
//
// Единый контракт, через который весь остальной код (imagePipeline.js,
// photoService.js) работает с хранилищем файлов, никогда не зная, какой
// именно адаптер активен:
//
//   async upload(objectKey, buffer, contentType) -> void
//   async delete(objectKey) -> void        идемпотентно: удаление уже
//                                           отсутствующего ключа — не ошибка
//   getPublicUrl(objectKey) -> string      синхронно, чистый вывод (без
//                                           побочных эффектов, без сети)
//   validateConfig() -> void               бросает MediaProviderConfigError
//                                           при неполной конфигурации —
//                                           fail-closed, вызывается СРАЗУ при
//                                           создании провайдера, не лениво
//   async healthCheck() -> { ok, detail }  никогда не бросает, только
//                                           докладывает
//
// objectKey — это уже готовый, безопасный, детерминированный ключ объекта
// (например `restaurants/12/photos/<uuid>-card.webp`), формируется вызывающим
// кодом (photoService.js), никогда не выводится из пользовательского ввода
// (оригинальное имя файла нигде не используется как часть пути — задание,
// раздел 5).
//
// Бинарные данные никогда не попадают в PostgreSQL — этот модуль единственное
// место в кодовой базе, которое реально пишет/удаляет файлы объектов.

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

class MediaProviderConfigError extends Error {}

// Разрешаем только относительные ключи вида `a/b/c-suffix.ext` — никаких `..`,
// никакого абсолютного пути, никакого `\`. Тот же принцип защиты от
// path traversal, что требует задание (раздел 5, 11), применяется в ОБОИХ
// адаптерах одинаково, а не только в локальном.
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

// ---------------------------------------------------------------------------
// LocalMediaProvider — только тесты и локальная разработка (задание,
// раздел 4: "never used in production"). Хранит файлы во временном каталоге
// (по умолчанию создаётся сам через fs.mkdtempSync), URL выводится из
// baseUrl, переданного вызывающим кодом (Playwright указывает реальный
// локальный HTTP-адрес, unit-тесты — произвольную строку-заглушку).
// ---------------------------------------------------------------------------

class LocalMediaProvider {
  constructor({ baseDir, baseUrl } = {}) {
    this.baseDir = baseDir || fsSync.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-local-'));
    this.baseUrl = (baseUrl || 'local-media://fixtures').replace(/\/$/, '');
    this._contentTypes = new Map();
  }

  validateConfig() {
    // Локальный адаптер валиден всегда, как только у него есть каталог —
    // конструктор уже гарантирует это (создаёт его при отсутствии).
  }

  async healthCheck() {
    try {
      await fs.access(this.baseDir, fsSync.constants.W_OK);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  async upload(objectKey, buffer, contentType) {
    assertSafeObjectKey(objectKey);
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('upload() ожидает Buffer.');
    }
    const filePath = path.join(this.baseDir, objectKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    this._contentTypes.set(objectKey, contentType || 'application/octet-stream');
  }

  async delete(objectKey) {
    assertSafeObjectKey(objectKey);
    const filePath = path.join(this.baseDir, objectKey);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this._contentTypes.delete(objectKey);
  }

  getPublicUrl(objectKey) {
    assertSafeObjectKey(objectKey);
    return `${this.baseUrl}/${objectKey}`;
  }

  // Не часть общего интерфейса — вспомогательный метод только для тестов,
  // чтобы прочитать физически записанный файл и проверить его содержимое.
  async readFileForTest(objectKey) {
    assertSafeObjectKey(objectKey);
    return fs.readFile(path.join(this.baseDir, objectKey));
  }

  // Не часть общего интерфейса — полная очистка временного каталога после
  // теста (задание, раздел 4: "auto-cleans after tests").
  async cleanup() {
    await fs.rm(this.baseDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S3MediaProvider — S3-совместимое object storage через официальный
// AWS SDK v3 (@aws-sdk/client-s3). Публичные фотографии — bucket отдаётся
// как public-read через bucket policy на стороне хранилища (не через ACL
// на каждый объект), поэтому здесь ACL сознательно не выставляется.
// getPublicUrl() выводит URL из явно заданного publicBaseUrl (может быть
// CDN-доменом, не обязательно = endpoint), а не хранится в БД (задание,
// раздел 3/4).
// ---------------------------------------------------------------------------

class S3MediaProvider {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, publicBaseUrl }) {
    this.endpoint = endpoint;
    this.region = region;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.forcePathStyle = forcePathStyle !== false;
    this.publicBaseUrl = publicBaseUrl ? publicBaseUrl.replace(/\/$/, '') : publicBaseUrl;
    this._client = null;
  }

  validateConfig() {
    const missing = [];
    if (!this.endpoint) missing.push('MEDIA_S3_ENDPOINT');
    if (!this.region) missing.push('MEDIA_S3_REGION');
    if (!this.bucket) missing.push('MEDIA_S3_BUCKET');
    if (!this.accessKeyId) missing.push('MEDIA_S3_ACCESS_KEY_ID');
    if (!this.secretAccessKey) missing.push('MEDIA_S3_SECRET_ACCESS_KEY');
    if (!this.publicBaseUrl) missing.push('MEDIA_S3_PUBLIC_BASE_URL');
    if (missing.length) {
      throw new MediaProviderConfigError(
        `S3MediaProvider: неполная конфигурация, отсутствуют переменные окружения: ${missing.join(', ')}.`
      );
    }
  }

  _getClient() {
    if (this._client) return this._client;
    // Ленивый require — @aws-sdk/client-s3 нужен только когда реально
    // выбран s3-провайдер, LocalMediaProvider (тесты) его не тянет.
    const { S3Client } = require('@aws-sdk/client-s3');
    this._client = new S3Client({
      endpoint: this.endpoint,
      region: this.region,
      forcePathStyle: this.forcePathStyle,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });
    return this._client;
  }

  async upload(objectKey, buffer, contentType) {
    assertSafeObjectKey(objectKey);
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('upload() ожидает Buffer.');
    }
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await this._getClient().send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
      // Ключи объектов детерминированы и никогда не переиспользуются повторно
      // под тем же именем (задание, раздел 15) — безопасно кэшировать вечно.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  async delete(objectKey) {
    assertSafeObjectKey(objectKey);
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    // DeleteObject у S3-совместимого API идемпотентен по спецификации —
    // удаление уже отсутствующего ключа не считается ошибкой.
    await this._getClient().send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }));
  }

  getPublicUrl(objectKey) {
    assertSafeObjectKey(objectKey);
    return `${this.publicBaseUrl}/${objectKey}`;
  }

  async healthCheck() {
    try {
      const { HeadBucketCommand } = require('@aws-sdk/client-s3');
      await this._getClient().send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

// ---------------------------------------------------------------------------
// Фабрика: выбор провайдера по переменным окружения. Fail-closed (задание,
// раздел 4): если выбран s3, но конфигурация неполная — бросает сразу здесь,
// а не при первой реальной загрузке. Если MEDIA_PROVIDER не задан вовсе —
// возвращает null, и вызывающий код (server.postgresql.js) обязан НЕ
// монтировать медиа-функциональность вовсе, а не тихо откатываться на
// LocalMediaProvider. LocalMediaProvider из env НИКОГДА не создаётся в
// production, даже если явно запрошен.
// ---------------------------------------------------------------------------

function createMediaProviderFromEnv(env = process.env) {
  const kind = env.MEDIA_PROVIDER;
  if (!kind) return null;

  if (kind === 'local') {
    // Основной флаг production в этом кодовом пути — APP_ENV (см.
    // services/postgresql/app.js:validateAppEnv), не Node-конвенция
    // NODE_ENV — но проверяются оба (тот же defense-in-depth приём, что и
    // createBotLifecycleAdapter isProduction в app.js), чтобы не зависеть
    // от того, какая из двух переменных реально выставлена в конкретном
    // окружении.
    if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
      throw new MediaProviderConfigError(
        'MEDIA_PROVIDER=local запрещён в production (задание, раздел 4) — используйте s3.'
      );
    }
    const provider = new LocalMediaProvider({
      baseDir: env.MEDIA_LOCAL_DIR,
      baseUrl: env.MEDIA_LOCAL_BASE_URL,
    });
    provider.validateConfig();
    return provider;
  }

  if (kind === 's3') {
    const provider = new S3MediaProvider({
      endpoint: env.MEDIA_S3_ENDPOINT,
      region: env.MEDIA_S3_REGION,
      bucket: env.MEDIA_S3_BUCKET,
      accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE !== 'false',
      publicBaseUrl: env.MEDIA_S3_PUBLIC_BASE_URL,
    });
    provider.validateConfig(); // бросает при неполной конфигурации — приложение не должно молча продолжить
    return provider;
  }

  throw new MediaProviderConfigError(`Неизвестный MEDIA_PROVIDER: ${kind} (ожидалось "local" или "s3").`);
}

module.exports = {
  MediaProviderConfigError,
  LocalMediaProvider,
  S3MediaProvider,
  createMediaProviderFromEnv,
  assertSafeObjectKey,
};
