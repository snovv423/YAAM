'use strict';

// Интеграция «крупный оригинал с камеры» против настоящего embedded
// PostgreSQL и настоящего LocalMediaProvider.
//
// Юнит-тесты (test/hqMediaLargeUpload.test.js) проверяют сам pipeline на
// буферах. Здесь важно другое: что файл тяжелее прежних 15 МиБ доходит до
// БД и хранилища целиком и корректно, что при этом не ломается логика
// primary/gallery, и что после ошибки обработки не остаётся ни строки в БД,
// ни объектов в хранилище, ни временных файлов на диске.
//
// L1 — большой JPEG (>15 МиБ, 39.8 Мп) проходит upload: 4 варианта на диске,
//      строка в БД, первый снимок автоматически primary.
// L2 — второй большой снимок уходит в галерею и НЕ становится вторым primary.
// L3 — ошибка обработки на большом файле: БД и хранилище остаются чистыми,
//      временные файлы не появляются.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');
const MiB = 1024 * 1024;

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-media-large-upload');
});

// Без остановки кластера процесс node --test не завершается, и в общем
// прогоне npm run test:postgresql следующие файлы просто не стартуют.
after(async () => {
  await cluster.stop();
});

async function freshDatabase(name) {
  await cluster.createDatabase(name);
  const setupClient = cluster.getClient(name);
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();
  return cluster.connectionString(name);
}

// Псевдослучайный шум практически несжимаем — единственный способ получить
// честно тяжёлый JPEG без гигантского разрешения и без внешней фикстуры.
function noiseRgb(width, height, seed) {
  const buf = Buffer.allocUnsafe(width * height * 3);
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    buf[i] = s & 0xff;
  }
  return sharp(buf, { raw: { width, height, channels: 3 } });
}

// 3600x3600 шума при q100 даёт ~17.3 МиБ — заведомо больше прежнего предела
// в 15 МиБ, но втрое дешевле по пикселям, чем настоящий кадр 39.8 Мп: здесь
// проверяется именно проходимость байтового лимита через БД и хранилище,
// а пиксельные границы закрыты отдельными юнит-тестами.
async function bigCameraJpeg(seed) {
  const buf = await noiseRgb(3600, 3600, seed).jpeg({ quality: 100 }).toBuffer();
  assert.ok(buf.length > 15 * MiB, `фикстура должна быть >15 МиБ, получено ${buf.length}`);
  return buf;
}

function loadFresh() {
  for (const p of [
    require.resolve('../../db/postgresql'),
    require.resolve('../../services/hq/media/photoService'),
  ]) delete require.cache[p];
  return {
    db: require('../../db/postgresql'),
    photoService: require('../../services/hq/media/photoService'),
    LocalMediaProvider: require('../../services/hq/media/provider').LocalMediaProvider,
  };
}

async function seedDish(db) {
  const rest = await db.execute("INSERT INTO restaurants (name, cities) VALUES ('Large Upload','[]') RETURNING id");
  const restaurantId = rest.rows[0].id;
  const cat = await db.execute('INSERT INTO categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [restaurantId, 'Основное']);
  const item = await db.execute(
    'INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id',
    [restaurantId, cat.rows[0].id, 'Блюдо', 500],
  );
  return { restaurantId, menuItemId: item.rows[0].id };
}

test('L1: JPEG тяжелее прежних 15 МиБ проходит upload целиком — 4 варианта в хранилище и строка в БД', async () => {
  process.env.DATABASE_URL = await freshDatabase('media_large_ok');
  const { db, photoService, LocalMediaProvider } = loadFresh();
  const provider = new LocalMediaProvider();
  try {
    const { restaurantId, menuItemId } = await seedDish(db);
    const source = await bigCameraJpeg(11);

    const photo = await photoService.uploadMenuItemPhoto(provider, restaurantId, menuItemId, source, '');

    assert.ok(photo.id, 'должна появиться строка menu_item_photos');
    assert.equal(photo.is_primary, 1, 'первое фото блюда становится основным');
    assert.ok(photo.width > 0 && photo.height > 0);

    const rows = await db.query('SELECT COUNT(*)::int AS n FROM menu_item_photos WHERE menu_item_id = $1', [menuItemId]);
    assert.equal(rows[0].n, 1);

    // Все четыре варианта физически существуют, каждый — настоящий WebP и
    // заметно легче исходника.
    let stored = 0;
    // Та же раскладка ключей, что и в photoService.variantObjectKey():
    // публичные варианты в public/, непубличный master — в private/masters/.
    const keyOf = (variant) => (variant === 'master'
      ? `private/masters/${photo.storage_key}/master.webp`
      : `public/${photo.storage_key}/${variant}.webp`);
    for (const variant of ['thumb', 'card', 'full', 'master']) {
      const key = keyOf(variant);
      const buf = await provider.readFileForTest(key);
      stored += buf.length;
      const md = await sharp(buf).metadata();
      assert.equal(md.format, 'webp', `${variant}: не WebP`);
      const maxEdge = { thumb: 320, card: 800, full: 1920, master: 3200 }[variant];
      assert.ok(Math.max(md.width, md.height) <= maxEdge, `${variant}: ${md.width}x${md.height} > ${maxEdge}`);
    }
    assert.ok(stored < source.length,
      `постоянное хранение (${stored}) должно быть меньше исходника (${source.length})`);

    // Исходные байты нигде не сохраняются: в каталоге хранилища только .webp.
    const all = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else all.push(full);
      }
    })(provider.baseDir);
    assert.ok(all.length > 0);
    assert.ok(all.every((f) => f.endsWith('.webp')), `в хранилище есть не-WebP файлы: ${all.filter((f) => !f.endsWith('.webp'))}`);
  } finally {
    await provider.cleanup();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('L2: второй большой снимок уходит в галерею и не создаёт второй primary', async () => {
  process.env.DATABASE_URL = await freshDatabase('media_large_gallery');
  const { db, photoService, LocalMediaProvider } = loadFresh();
  const provider = new LocalMediaProvider();
  try {
    const { restaurantId, menuItemId } = await seedDish(db);
    const first = await photoService.uploadMenuItemPhoto(provider, restaurantId, menuItemId, await bigCameraJpeg(21), '');
    const second = await photoService.uploadMenuItemPhoto(provider, restaurantId, menuItemId, await bigCameraJpeg(22), '');

    assert.equal(first.is_primary, 1);
    assert.equal(second.is_primary, 0, 'второй снимок не должен становиться основным');

    const primaries = await db.query(
      'SELECT COUNT(*)::int AS n FROM menu_item_photos WHERE menu_item_id = $1 AND is_primary = 1', [menuItemId],
    );
    assert.equal(primaries[0].n, 1, 'основное фото обязано остаться ровно одно');

    const list = await photoService.listMenuItemPhotos(restaurantId, menuItemId);
    assert.equal(list.length, 2);
  } finally {
    await provider.cleanup();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});

test('L3: сбой обработки большого файла не оставляет ни строки в БД, ни объектов, ни временных файлов', async () => {
  process.env.DATABASE_URL = await freshDatabase('media_large_cleanup');
  const { db, photoService, LocalMediaProvider } = loadFresh();
  const real = new LocalMediaProvider();
  const uploadedKeys = [];
  const deletedKeys = [];
  // Падение на третьем варианте — уже после того, как часть объектов легла
  // в хранилище: проверяем именно компенсирующую уборку.
  let n = 0;
  const flaky = {
    async upload(key, buf, ct) {
      n += 1;
      if (n === 3) throw new Error('simulated storage outage on large upload');
      uploadedKeys.push(key);
      return real.upload(key, buf, ct);
    },
    async delete(key) { deletedKeys.push(key); return real.delete(key); },
    getPublicUrl: (key) => real.getPublicUrl(key),
    getDiskUsage: () => real.getDiskUsage(),
  };
  try {
    const { restaurantId, menuItemId } = await seedDish(db);
    const source = await bigCameraJpeg(31);
    await assert.rejects(
      () => photoService.uploadMenuItemPhoto(flaky, restaurantId, menuItemId, source, ''),
      /simulated storage outage/,
    );

    const rows = await db.query('SELECT COUNT(*)::int AS n FROM menu_item_photos WHERE menu_item_id = $1', [menuItemId]);
    assert.equal(rows[0].n, 0, 'битой media-записи в БД быть не должно');
    assert.equal(deletedKeys.length, uploadedKeys.length,
      'каждый успевший загрузиться вариант должен быть удалён компенсирующим действием');

    // Хранилище пусто: частично записанных вариантов не осталось.
    const left = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else left.push(full);
      }
    })(real.baseDir);
    assert.deepEqual(left, [], `в хранилище остались артефакты: ${left}`);

    // Временных файлов не остаётся не потому, что мы их подчищаем, а потому
    // что их не существует: приём идёт через multer.memoryStorage(), и до
    // хранилища доходят только уже перекодированные WebP-буферы. Проверяем
    // это структурно — наблюдать за общесистемным os.tmpdir() нельзя,
    // соседние тесты в том же процессе создают там свои каталоги.
    const routes = fs.readFileSync(path.join(__dirname, '../../routes/hq/restaurants.js'), 'utf8');
    assert.match(routes, /storage: multer\.memoryStorage\(\)/);
    assert.doesNotMatch(routes, /diskStorage|dest:/,
      'приём файла не должен писать исходник на диск');
  } finally {
    await real.cleanup();
    await db.close();
    delete process.env.DATABASE_URL;
  }
});
