'use strict';

// YAAM Stage 29.1, п.3 — реальное персистентное голосование "Кого ждём".
// Против настоящего embedded PostgreSQL, тот же harness, что и остальные
// Stage-тесты этой директории.
//
// A — services/hq/restaurantCandidateService.castVote() напрямую: первый
//     голос, повтор с того же устройства, голос другого устройства,
//     параллельный двойной запрос, несуществующий/удалённый кандидат,
//     персистентность (повторное независимое чтение из БД — "после
//     перезагрузки страницы" с точки зрения сервера).
// B — публичный HTTP-роут POST /api/restaurant-candidates/:id/vote и
//     видимость результата в GET (клиент/HQ читают одно и то же число).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

let cluster;
let db;
let svc;

before(async () => {
  cluster = await startEmbeddedPostgres('candidate-voting-stage29');
  await cluster.createDatabase('yaam_candidate_voting_test');
  const setupClient = cluster.getClient('yaam_candidate_voting_test');
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = cluster.connectionString('yaam_candidate_voting_test');
  db = require('../../db/postgresql/index.js');
  svc = require('../../services/hq/restaurantCandidateService.js');
});

after(async () => {
  await db.close();
  delete process.env.DATABASE_URL;
  await cluster.stop();
});

function uniqueDeviceId() {
  return `dev_${crypto.randomBytes(8).toString('hex')}`;
}

// ===========================================================================
// A. castVote() напрямую
// ===========================================================================

test('A1: первый голос — votes становится 1, alreadyVoted=false', async () => {
  const candidate = await svc.createCandidate({ name: 'KFC', cuisine: 'Фастфуд' });
  const device = uniqueDeviceId();
  const result = await svc.castVote(candidate.id, device);
  assert.equal(result.alreadyVoted, false);
  assert.equal(result.votes, 1);
});

test('A2: повтор с ТОГО ЖЕ устройства за того же кандидата — votes НЕ растёт, alreadyVoted=true', async () => {
  const candidate = await svc.createCandidate({ name: 'Домино\'с Пицца', cuisine: 'Пицца' });
  const device = uniqueDeviceId();
  const first = await svc.castVote(candidate.id, device);
  assert.equal(first.votes, 1);

  const second = await svc.castVote(candidate.id, device);
  assert.equal(second.alreadyVoted, true);
  assert.equal(second.votes, 1, 'повторный голос тем же устройством не увеличивает счётчик');

  const third = await svc.castVote(candidate.id, device);
  assert.equal(third.votes, 1, 'и третий раз тоже — не накапливается');

  const rows = await db.query('SELECT votes FROM restaurant_candidates WHERE id = $1', [candidate.id]);
  assert.equal(rows[0].votes, 1);
});

test('A3: голос ДРУГОГО устройства за того же кандидата — votes растёт', async () => {
  const candidate = await svc.createCandidate({ name: 'Пекарня', cuisine: 'Выпечка' });
  const deviceA = uniqueDeviceId();
  const deviceB = uniqueDeviceId();
  await svc.castVote(candidate.id, deviceA);
  const result = await svc.castVote(candidate.id, deviceB);
  assert.equal(result.alreadyVoted, false);
  assert.equal(result.votes, 2);
});

test('A4: параллельный двойной запрос (гонка) тем же устройством — ровно ОДИН учтён, votes=1, не 2', async () => {
  const candidate = await svc.createCandidate({ name: 'Суши-бар', cuisine: 'Японская' });
  const device = uniqueDeviceId();
  const [r1, r2] = await Promise.all([
    svc.castVote(candidate.id, device),
    svc.castVote(candidate.id, device),
  ]);
  // Ровно один из двух конкурентных вызовов должен был реально засчитаться,
  // другой — идемпотентный no-op (alreadyVoted=true). UNIQUE(candidate_id,
  // device_id) в БД гарантирует это даже при истинной гонке двух соединений.
  const alreadyVotedFlags = [r1.alreadyVoted, r2.alreadyVoted].sort();
  assert.deepEqual(alreadyVotedFlags, [false, true], 'ровно один конкурентный запрос должен был реально засчитаться');
  assert.equal(r1.votes, 1);
  assert.equal(r2.votes, 1);
  const rows = await db.query('SELECT votes FROM restaurant_candidates WHERE id = $1', [candidate.id]);
  assert.equal(rows[0].votes, 1, 'в БД ровно один голос, не два — гонка не привела к двойному инкременту');
  const voteRows = await db.query('SELECT count(*)::int AS n FROM restaurant_candidate_votes WHERE candidate_id = $1', [candidate.id]);
  assert.equal(voteRows[0].n, 1);
});

test('A5: несуществующий кандидат — ValidationError "Кандидат не найден.", ничего не создаётся', async () => {
  await assert.rejects(
    () => svc.castVote(999999999, uniqueDeviceId()),
    (err) => err instanceof svc.ValidationError && /не найден/.test(err.message),
  );
});

test('A6: удалённый кандидат — голос отклоняется, старые голоса удалены каскадом (ON DELETE CASCADE)', async () => {
  const candidate = await svc.createCandidate({ name: 'Скоро удалим', cuisine: '' });
  const device = uniqueDeviceId();
  await svc.castVote(candidate.id, device);
  const voteRowsBefore = await db.query('SELECT count(*)::int AS n FROM restaurant_candidate_votes WHERE candidate_id = $1', [candidate.id]);
  assert.equal(voteRowsBefore[0].n, 1);

  await svc.deleteCandidate(candidate.id);

  await assert.rejects(
    () => svc.castVote(candidate.id, uniqueDeviceId()),
    (err) => err instanceof svc.ValidationError && /не найден/.test(err.message),
    'удалённый кандидат больше не принимает голоса',
  );
  const voteRowsAfter = await db.query('SELECT count(*)::int AS n FROM restaurant_candidate_votes WHERE candidate_id = $1', [candidate.id]);
  assert.equal(voteRowsAfter[0].n, 0, 'ON DELETE CASCADE убрал старые голоса удалённого кандидата');
});

test('A7: некорректный (нечисловой) id — честный "Кандидат не найден.", не сырая ошибка PostgreSQL', async () => {
  await assert.rejects(
    () => svc.castVote('не-число', uniqueDeviceId()),
    (err) => err instanceof svc.ValidationError && err.message === 'Кандидат не найден.',
  );
});

test('A8: пустой/слишком длинный deviceId отклоняется отдельной ошибкой (не молча игнорируется)', async () => {
  const candidate = await svc.createCandidate({ name: 'Проверка deviceId', cuisine: '' });
  await assert.rejects(() => svc.castVote(candidate.id, ''), svc.ValidationError);
  await assert.rejects(() => svc.castVote(candidate.id, 'x'.repeat(200)), svc.ValidationError);
  const rows = await db.query('SELECT votes FROM restaurant_candidates WHERE id = $1', [candidate.id]);
  assert.equal(rows[0].votes, 0);
});

test('A9: персистентность — голос виден при НЕЗАВИСИМОМ повторном чтении из БД ("после перезагрузки страницы")', async () => {
  const candidate = await svc.createCandidate({ name: 'Персистентный ресторан', cuisine: '' });
  const device = uniqueDeviceId();
  await svc.castVote(candidate.id, device);

  // "Перезагрузка страницы" с точки зрения сервера — независимый, свежий
  // SELECT, не переиспользующий никакое состояние из вызова castVote выше.
  const freshRead = await svc.getCandidateById(candidate.id);
  assert.equal(freshRead.votes, 1);

  const listRead = await svc.listCandidates();
  const found = listRead.find((c) => c.id === candidate.id);
  assert.equal(found.votes, 1);
});

// ===========================================================================
// B. Публичный HTTP-роут
// ===========================================================================

const HTTP_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/postgresql/api.js'),
];

function reloadHttpModule() {
  for (const p of HTTP_MODULE_PATHS) delete require.cache[p];
  return require('../../services/postgresql/app.js');
}

async function waitForAddress(instance, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = instance.address();
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('httpServer никогда не начал слушать');
}

test('B1: POST /api/restaurant-candidates/:id/vote без авторизации — реальный голос, виден в следующем GET', async () => {
  const databaseUrl = cluster.connectionString('yaam_candidate_voting_http_b1');
  await cluster.createDatabase('yaam_candidate_voting_http_b1');
  const setupClient = cluster.getClient('yaam_candidate_voting_http_b1');
  await setupClient.connect();
  await setupClient.query(SCHEMA_SQL);
  await setupClient.end();

  process.env.DATABASE_URL = databaseUrl;
  process.env.PAYMENT_PROVIDER = 'mock';
  const appModule = reloadHttpModule();
  const instance = appModule.createPostgresqlApp({ port: 0, host: '127.0.0.1', schedulerIntervalMs: 1_000_000 });
  await instance.start();
  const { port } = await waitForAddress(instance);
  const base = `http://127.0.0.1:${port}`;

  try {
    const httpDb = require('../../db/postgresql');
    const created = await httpDb.query(
      "INSERT INTO restaurant_candidates (name, cuisine) VALUES ('HTTP Кандидат', '') RETURNING id",
    );
    const candidateId = created[0].id;

    const voteRes = await fetch(`${base}/api/restaurant-candidates/${candidateId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'http-device-1' }),
    });
    assert.equal(voteRes.status, 200);
    const voteBody = await voteRes.json();
    assert.equal(voteBody.votes, 1);
    assert.equal(voteBody.alreadyVoted, false);

    const listRes = await fetch(`${base}/api/restaurant-candidates`);
    const list = await listRes.json();
    const found = list.find((c) => c.id === candidateId);
    assert.equal(found.votes, 1, 'HQ и публичный API читают одно и то же число после реального голоса');

    // Повтор тем же deviceId по HTTP.
    const repeatRes = await fetch(`${base}/api/restaurant-candidates/${candidateId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'http-device-1' }),
    });
    const repeatBody = await repeatRes.json();
    assert.equal(repeatBody.alreadyVoted, true);
    assert.equal(repeatBody.votes, 1);

    // Несуществующий кандидат — честный 404, не 500.
    const missingRes = await fetch(`${base}/api/restaurant-candidates/999999999/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'http-device-2' }),
    });
    assert.equal(missingRes.status, 404);
  } finally {
    await instance.stop();
    delete process.env.DATABASE_URL;
  }
});
