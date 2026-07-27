'use strict';

// YAAM HQ Stage 5B/5B.2 — юнит-тесты media provider interface (задание,
// раздел 14A: "persistent root validation", "temporary mode", "production
// persistent mode", "restart не удаляет файлы", "public/private path
// separation", "path traversal", "absolute path", "symlink escape",
// "atomic write", "delete missing = success", "private master не имеет
// public URL", "размер и свободное место"). Ни один тест не обращается к
// PostgreSQL — LocalMediaProvider работает с настоящей файловой системой
// (временный каталог), но это не делает тест интеграционным в смысле
// задания (никакой БД/сети). Единственный провайдер теперь LocalMediaProvider
// — S3 больше не является частью YAAM на этом масштабе (задание Stage 5B.2,
// раздел 1/5).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  LocalMediaProvider,
  MediaProviderConfigError,
  createMediaProviderFromEnv,
  assertSafeObjectKey,
} = require('../services/hq/media/provider');

test('LocalMediaProvider: upload -> getPublicUrl -> файл реально на диске', async () => {
  const p = new LocalMediaProvider({ baseUrl: 'http://x.test/media' });
  await p.upload('public/restaurants/1/photos/a/card.webp', Buffer.from('hello'), 'image/webp');
  // baseUrl уже представляет корень public/ (см. комментарий в provider.js) —
  // сам префикс "public/" не дублируется в выведенном URL.
  assert.equal(p.getPublicUrl('public/restaurants/1/photos/a/card.webp'), 'http://x.test/media/restaurants/1/photos/a/card.webp');
  const onDisk = await p.readFileForTest('public/restaurants/1/photos/a/card.webp');
  assert.equal(onDisk.toString(), 'hello');
  await p.cleanup();
});

test('LocalMediaProvider: delete идемпотентен — повторное удаление не бросает', async () => {
  const p = new LocalMediaProvider();
  await p.upload('public/x/y/card.webp', Buffer.from('a'), 'image/webp');
  await p.delete('public/x/y/card.webp');
  await assert.doesNotReject(() => p.delete('public/x/y/card.webp'));
  await assert.doesNotReject(() => p.delete('public/never-existed/card.webp'), 'удаление никогда не существовавшего ключа — тоже успех (ENOENT = success)');
  await p.cleanup();
});

test('LocalMediaProvider: getPublicUrl без сети/upload — чистая функция', () => {
  const p = new LocalMediaProvider({ baseUrl: 'http://x.test/media' });
  assert.equal(p.getPublicUrl('public/a/b/thumb.webp'), 'http://x.test/media/a/b/thumb.webp');
});

test('LocalMediaProvider: getPublicUrl отклоняет ключ вне public/ — приватный master не может получить публичный URL', () => {
  const p = new LocalMediaProvider({ baseUrl: 'http://x.test/media' });
  assert.throws(() => p.getPublicUrl('private/masters/restaurants/1/a/master.webp'));
  assert.throws(() => p.getPublicUrl('restaurants/1/a/master.webp'), 'ключ вообще без префикса public/ тоже отклоняется');
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
  assert.doesNotThrow(() => assertSafeObjectKey('public/restaurants/12/a1b2c3/card.webp'));
  assert.doesNotThrow(() => assertSafeObjectKey('private/masters/menu-items/7/uuid/master.webp'));
});

test('LocalMediaProvider.upload/delete отклоняют небезопасный objectKey', async () => {
  const p = new LocalMediaProvider();
  await assert.rejects(() => p.upload('../evil', Buffer.from('x'), 'image/webp'));
  await assert.rejects(() => p.delete('../evil'));
  await p.cleanup();
});

test('LocalMediaProvider: resolved path не может выйти за пределы media root даже если regex почему-то пропустил бы значение', async () => {
  const p = new LocalMediaProvider();
  // Второй, независимый от regex слой защиты (задание, раздел 8) —
  // проверяем сам _resolvePath напрямую, не полагаясь только на
  // assertSafeObjectKey.
  assert.throws(() => p._resolvePath('a/../../../etc/passwd'));
  await p.cleanup();
});

test('LocalMediaProvider: атомарная запись — upload той же файловой системы не оставляет частично записанный файл по финальному имени', async () => {
  const p = new LocalMediaProvider();
  const bigBuffer = Buffer.alloc(200_000, 7);
  await p.upload('public/r/1/full.webp', bigBuffer, 'image/webp');
  const onDisk = await p.readFileForTest('public/r/1/full.webp');
  assert.equal(onDisk.length, bigBuffer.length);
  // Никаких осиротевших .tmp-файлов не должно остаться рядом.
  const dir = path.join(p.baseDir, 'public/r/1');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  await p.cleanup();
});

test('LocalMediaProvider: healthCheck/upload работают одинаково temp и persistent режимах', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-test-persist-'));
  try {
    const p = new LocalMediaProvider({ baseDir: root, baseUrl: 'https://media.test', persistent: true });
    p.validateConfig();
    assert.ok(fs.existsSync(path.join(root, 'public')), 'persistent-режим должен создать public/ сразу при validateConfig()');
    assert.ok(fs.existsSync(path.join(root, 'private', 'masters')), 'persistent-режим должен создать private/masters/ сразу при validateConfig()');
    await p.upload('public/restaurants/1/x/card.webp', Buffer.from('data'), 'image/webp');
    assert.equal((await p.healthCheck()).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LocalMediaProvider: persistent-режим требует абсолютный baseDir', () => {
  assert.throws(() => new LocalMediaProvider({ baseDir: 'relative/path', persistent: true }), MediaProviderConfigError);
});

test('LocalMediaProvider: persistent-режим требует явный baseDir (нельзя авто-создать temp-каталог)', () => {
  assert.throws(() => new LocalMediaProvider({ persistent: true }), MediaProviderConfigError);
});

test('LocalMediaProvider: cleanup() запрещён в persistent-режиме — защита от удаления реальных production-файлов', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-test-persist2-'));
  try {
    const p = new LocalMediaProvider({ baseDir: root, persistent: true });
    p.validateConfig();
    await assert.rejects(() => p.cleanup());
    assert.ok(fs.existsSync(root), 'каталог должен остаться нетронутым после отклонённого cleanup()');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LocalMediaProvider: restart (пересоздание провайдера над тем же persistent root) не теряет уже загруженные файлы', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-test-restart-'));
  try {
    const first = new LocalMediaProvider({ baseDir: root, persistent: true });
    first.validateConfig();
    await first.upload('public/restaurants/1/x/card.webp', Buffer.from('survives-restart'), 'image/webp');

    // Новый процесс/новый инстанс над тем же корне (имитация restart backend).
    const second = new LocalMediaProvider({ baseDir: root, persistent: true });
    second.validateConfig();
    const onDisk = await second.readFileForTest('public/restaurants/1/x/card.webp');
    assert.equal(onDisk.toString(), 'survives-restart');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LocalMediaProvider.getDiskUsage: возвращает freeBytes/totalBytes/usedByMediaBytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-test-disk-'));
  try {
    const p = new LocalMediaProvider({ baseDir: root, persistent: true });
    p.validateConfig();
    await p.upload('public/restaurants/1/x/card.webp', Buffer.alloc(1000, 1), 'image/webp');
    const usage = await p.getDiskUsage();
    assert.ok(usage.freeBytes > 0);
    assert.ok(usage.totalBytes > 0);
    assert.ok(usage.usedByMediaBytes >= 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createMediaProviderFromEnv: MEDIA_PROVIDER не задан -> null (медиа выключено, не ошибка)', () => {
  assert.equal(createMediaProviderFromEnv({}), null);
});

test('createMediaProviderFromEnv: неизвестное значение -> MediaProviderConfigError (S3 больше не поддерживается)', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 'ftp' }), MediaProviderConfigError);
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 's3' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: local запрещён в production без MEDIA_LOCAL_ROOT (APP_ENV)', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 'local', APP_ENV: 'production' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: local запрещён в production без MEDIA_LOCAL_ROOT (NODE_ENV, defense in depth)', () => {
  assert.throws(() => createMediaProviderFromEnv({ MEDIA_PROVIDER: 'local', NODE_ENV: 'production' }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: local + MEDIA_LOCAL_ROOT разрешён в production (persistent-режим)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-media-test-env-prod-'));
  try {
    const provider = createMediaProviderFromEnv({
      MEDIA_PROVIDER: 'local', APP_ENV: 'production', MEDIA_LOCAL_ROOT: root, MEDIA_LOCAL_BASE_URL: 'https://media.test',
    });
    assert.ok(provider instanceof LocalMediaProvider);
    assert.equal(provider.persistent, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createMediaProviderFromEnv: MEDIA_LOCAL_ROOT и MEDIA_LOCAL_DIR одновременно -> ошибка (неоднозначно)', () => {
  assert.throws(() => createMediaProviderFromEnv({
    MEDIA_PROVIDER: 'local', MEDIA_LOCAL_ROOT: '/tmp/a', MEDIA_LOCAL_DIR: '/tmp/b',
  }), MediaProviderConfigError);
});

test('createMediaProviderFromEnv: local разрешён вне production и создаёт временный каталог', async () => {
  const provider = createMediaProviderFromEnv({ MEDIA_PROVIDER: 'local', APP_ENV: 'local' });
  assert.ok(provider instanceof LocalMediaProvider);
  assert.equal(provider.persistent, false);
  assert.ok(fs.existsSync(provider.baseDir));
  await provider.cleanup();
});
