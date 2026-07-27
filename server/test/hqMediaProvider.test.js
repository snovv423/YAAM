'use strict';

// YAAM HQ Stage 5B — юнит-тесты media provider interface (задание, раздел
// 14A: "provider interface", "storage key"/path-traversal, fail-closed
// конфигурация). Ни один тест не обращается к PostgreSQL — LocalMediaProvider
// работает с настоящей файловой системой (временный каталог), но это не
// делает тест интеграционным в смысле задания (никакой БД/сети).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  LocalMediaProvider,
  S3MediaProvider,
  MediaProviderConfigError,
  createMediaProviderFromEnv,
  assertSafeObjectKey,
} = require('../services/hq/media/provider');

test('LocalMediaProvider: upload -> getPublicUrl -> файл реально на диске', async () => {
  const p = new LocalMediaProvider({ baseUrl: 'http://x.test/media' });
  await p.upload('restaurants/1/photos/a-card.webp', Buffer.from('hello'), 'image/webp');
  assert.equal(p.getPublicUrl('restaurants/1/photos/a-card.webp'), 'http://x.test/media/restaurants/1/photos/a-card.webp');
  const onDisk = await p.readFileForTest('restaurants/1/photos/a-card.webp');
  assert.equal(onDisk.toString(), 'hello');
  await p.cleanup();
});

test('LocalMediaProvider: delete идемпотентен — повторное удаление не бросает', async () => {
  const p = new LocalMediaProvider();
  await p.upload('x/y-card.webp', Buffer.from('a'), 'image/webp');
  await p.delete('x/y-card.webp');
  await assert.doesNotReject(() => p.delete('x/y-card.webp'));
  await p.cleanup();
});

test('LocalMediaProvider: getPublicUrl без сети/upload — чистая функция', () => {
  const p = new LocalMediaProvider({ baseUrl: 'http://x.test/media' });
  assert.equal(p.getPublicUrl('a/b-thumb.webp'), 'http://x.test/media/a/b-thumb.webp');
});

test('LocalMediaProvider: healthCheck отражает реальное состояние каталога', async () => {
  const p = new LocalMediaProvider();
  const health = await p.healthCheck();
  assert.equal(health.ok, true);
  await p.cleanup();
});

test('assertSafeObjectKey: path traversal и абсолютные пути отклоняются', () => {
  for (const bad of ['../evil', 'a/../../etc/passwd', '/etc/passwd', 'a\\b', '', 'a b']) {
    assert.throws(() => assertSafeObjectKey(bad), undefined, `ожидали отказ для "${bad}"`);
  }
});

test('assertSafeObjectKey: обычные сгенерированные ключи проходят', () => {
  assert.doesNotThrow(() => assertSafeObjectKey('restaurants/12/a1b2c3-card.webp'));
  assert.doesNotThrow(() => assertSafeObjectKey('menu-items/7/uuid-full.webp'));
});

test('LocalMediaProvider.upload/delete отклоняют небезопасный objectKey', async () => {
  const p = new LocalMediaProvider();
  await assert.rejects(() => p.upload('../evil', Buffer.from('x'), 'image/webp'));
  await assert.rejects(() => p.delete('../evil'));
  await p.cleanup();
});

test('S3MediaProvider.validateConfig: бросает MediaProviderConfigError при неполной конфигурации', () => {
  const p = new S3MediaProvider({});
  assert.throws(() => p.validateConfig(), MediaProviderConfigError);
});

test('S3MediaProvider.validateConfig: проходит при полном наборе полей', () => {
  const p = new S3MediaProvider({
    endpoint: 'https://s3.example.com',
    region: 'ru-1',
    bucket: 'yaam-media',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    publicBaseUrl: 'https://cdn.example.com',
  });
  assert.doesNotThrow(() => p.validateConfig());
});

test('S3MediaProvider.getPublicUrl: чистый вывод без сети', () => {
  const p = new S3MediaProvider({
    endpoint: 'https://s3.example.com', region: 'ru-1', bucket: 'b',
    accessKeyId: 'AK', secretAccessKey: 'SK', publicBaseUrl: 'https://cdn.example.com/',
  });
  assert.equal(p.getPublicUrl('restaurants/1/a-card.webp'), 'https://cdn.example.com/restaurants/1/a-card.webp');
});

test('createMediaProviderFromEnv: MEDIA_PROVIDER не задан -> null (медиа выключено, не ошибка)', () => {
  assert.equal(createMediaProviderFromEnv({}), null);
});

test('createMediaProviderFromEnv: неизвестное значение -> MediaProviderConfigError', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 'ftp' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: s3 без переменных -> fail-closed', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 's3' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: s3 с полным набором переменных -> S3MediaProvider', () => {
  const provider = createMediaProviderFromEnv({
    MEDIA_PROVIDER: 's3',
    MEDIA_S3_ENDPOINT: 'https://s3.example.com',
    MEDIA_S3_REGION: 'ru-1',
    MEDIA_S3_BUCKET: 'b',
    MEDIA_S3_ACCESS_KEY_ID: 'AK',
    MEDIA_S3_SECRET_ACCESS_KEY: 'SK',
    MEDIA_S3_PUBLIC_BASE_URL: 'https://cdn.example.com',
  });
  assert.ok(provider instanceof S3MediaProvider);
});

test('createMediaProviderFromEnv: local запрещён в production (APP_ENV)', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 'local', APP_ENV: 'production' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: local запрещён в production (NODE_ENV, defense in depth)', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 'local', NODE_ENV: 'production' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: local разрешён вне production и создаёт временный каталог', async () => {
  const provider = createMediaProviderFromEnv({ MEDIA_PROVIDER: 'local', APP_ENV: 'local' });
  assert.ok(provider instanceof LocalMediaProvider);
  assert.ok(fs.existsSync(provider.baseDir));
  await provider.cleanup();
});
