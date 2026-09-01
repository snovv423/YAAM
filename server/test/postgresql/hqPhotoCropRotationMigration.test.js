'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const schemaPath = path.join(__dirname, '../../db/postgresql/schema.sql');
const migrationsDir = path.join(__dirname, '../../db/postgresql/migrations');
const migration16 = fs.readFileSync(path.join(migrationsDir, '0016_menu_item_photo_crops.sql'), 'utf8');
const migration17 = fs.readFileSync(path.join(migrationsDir, '0017_menu_item_photo_rotation.sql'), 'utf8');

// Production immediately before 0016: same schema without the three additive
// photo metadata declarations/backfill ALTER statements.
const legacySchema = fs.readFileSync(schemaPath, 'utf8')
  .split('\n')
  .filter((line) => !/menu_card_crop|dish_detail_crop|rotation_degrees/.test(line))
  .join('\n');

let cluster;

before(async () => { cluster = await startEmbeddedPostgres('hq-photo-crop-rotation-migration'); });
after(async () => { await cluster.stop(); });

test('0016 then 0017 preserve legacy media rows and remain old-app compatible', async () => {
  await cluster.createDatabase('photo_migration_clone');
  const client = cluster.getClient('photo_migration_clone');
  await client.connect();
  try {
    await client.query(legacySchema);
    const restaurant = (await client.query("INSERT INTO restaurants (name,cities) VALUES ('Legacy','[]') RETURNING id")).rows[0];
    const category = (await client.query("INSERT INTO categories (restaurant_id,name) VALUES ($1,'Основное') RETURNING id", [restaurant.id])).rows[0];
    const item = (await client.query("INSERT INTO menu_items (restaurant_id,category_id,name,price) VALUES ($1,$2,'Блюдо',500) RETURNING id", [restaurant.id, category.id])).rows[0];
    const original = (await client.query(
      "INSERT INTO menu_item_photos (menu_item_id,storage_key,width,height,sort_order,is_primary) VALUES ($1,'menu-items/legacy/photo',900,1600,4,1) RETURNING *",
      [item.id],
    )).rows[0];

    await client.query(migration16);
    await client.query(migration17);
    // Both migrations are intentionally idempotent for safe retry/restart.
    await client.query(migration16);
    await client.query(migration17);

    const migrated = (await client.query('SELECT * FROM menu_item_photos WHERE id=$1', [original.id])).rows[0];
    assert.equal(migrated.id, original.id);
    assert.equal(migrated.storage_key, original.storage_key);
    assert.equal(migrated.width, original.width);
    assert.equal(migrated.height, original.height);
    assert.equal(migrated.sort_order, original.sort_order);
    assert.equal(migrated.is_primary, original.is_primary);
    assert.equal(migrated.menu_card_crop, null);
    assert.equal(migrated.dish_detail_crop, null);
    assert.equal(migrated.rotation_degrees, 0);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM menu_item_photos')).rows[0].n, 1);

    // This is the exact legacy projection: an old application can continue to
    // read/write the original columns while ignoring additive metadata.
    const legacyProjection = (await client.query(
      'SELECT id,menu_item_id,storage_key,width,height,alt_text,sort_order,is_primary,created_at,updated_at FROM menu_item_photos WHERE id=$1',
      [original.id],
    )).rows[0];
    assert.equal(legacyProjection.storage_key, original.storage_key);
    await client.query('UPDATE menu_item_photos SET alt_text=$1 WHERE id=$2', ['old-app-write', original.id]);
    assert.equal((await client.query('SELECT alt_text FROM menu_item_photos WHERE id=$1', [original.id])).rows[0].alt_text, 'old-app-write');
  } finally {
    await client.end();
  }
});

test('migrations contain DB-only DDL and cannot touch master/derived media files', () => {
  const sql = `${migration16}\n${migration17}`;
  assert.match(sql, /ALTER TABLE menu_item_photos/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|storage_key\s*=|COPY\s|PROGRAM/i);
});
