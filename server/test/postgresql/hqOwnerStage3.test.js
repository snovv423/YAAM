'use strict';

// YAAM HQ Stage 3 — владелец HQ хранится в PostgreSQL (hq_owner), не в .env.
// Интеграционные тесты против настоящего embedded PostgreSQL (тот же
// harness, что и во всех Stage/Wave тестах этой директории).
//
// A — services/hq/ownerService.js и services/hq/securityLog.js напрямую
//     (оба модуля требуют db/postgresql как top-level singleton — не
//     принимают db параметром, поэтому это по своей природе интеграционные,
//     а не подменяемые unit-тесты).
// B — полный HTTP-цикл (login/logout/смена логина/смена пароля/bootstrap)
//     через настоящий createPostgresqlApp().
// C — CLI server/scripts/reset-hq-owner.js как отдельный процесс.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startEmbeddedPostgres } = require('./helpers/embeddedPg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../../db/postgresql/schema.sql'), 'utf8');

const HQ_MODULE_PATHS = [
  require.resolve('../../services/postgresql/app.js'),
  require.resolve('../../routes/hq/index.js'),
  require.resolve('../../routes/hq/auth.js'),
  require.resolve('../../routes/hq/pages.js'),
  require.resolve('../../routes/hq/middleware.js'),
];

const TEST_SESSION_SECRET = 'c'.repeat(48);

let cluster;

before(async () => {
  cluster = await startEmbeddedPostgres('hq-owner-stage3');
});

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

function reloadHqAppModule() {
  for (const p of HQ_MODULE_PATHS) delete require.cache[p];
  // ownerService/securityLog требуют db/postgresql напрямую (singleton) —
  // не в HQ_MODULE_PATHS специально: пул соединений должен остаться тем же
  // между перезагрузками роутеров в одном тестовом процессе (пересоздание
  // пула на каждый reload было бы намного дороже и не нужно для этих тестов).
  return require('../../services/postgresql/app.js');
}

function cookieHeaderFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  if (!m) throw new Error('CSRF-токен не найден на странице');
  return m[1];
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

// ===========================================================================
// A. services/hq/ownerService.js + services/hq/securityLog.js
// ===========================================================================

let ownerService;
let securityLog;
let hashPassword;

test('A: services/hq/ownerService.js + securityLog.js против реального PostgreSQL', async (t) => {
  const databaseUrl = await freshDatabase('yaam_hq_owner_service_test');
  process.env.DATABASE_URL = databaseUrl;
  delete require.cache[require.resolve('../../db/postgresql')];
  delete require.cache[require.resolve('../../services/hq/ownerService')];
  delete require.cache[require.resolve('../../services/hq/securityLog')];
  delete require.cache[require.resolve('../../services/hq/passwordHash')];
  const db = require('../../db/postgresql');
  ownerService = require('../../services/hq/ownerService');
  securityLog = require('../../services/hq/securityLog');
  ({ hashPassword } = require('../../services/hq/passwordHash'));

  await t.test('A1: getOwner() -> null, когда таблица пуста', async () => {
    assert.equal(await ownerService.getOwner(), null);
    assert.equal(await ownerService.getCredentialsVersion(), null);
  });

  let firstHash;
  await t.test('A2: bootstrapOwnerFromEnv() создаёт владельца, когда таблица пуста', async () => {
    firstHash = await hashPassword('FirstBootstrapPass123!');
    const { created } = await ownerService.bootstrapOwnerFromEnv({ login: 'bootuser', passwordHash: firstHash });
    assert.equal(created, true);
    const owner = await ownerService.getOwner();
    assert.equal(owner.login, 'bootuser');
    assert.equal(owner.password_hash, firstHash);
    assert.equal(owner.credentials_version, 1);
  });

  await t.test('A3: повторный bootstrapOwnerFromEnv() — no-op, НЕ перезаписывает существующего владельца', async () => {
    const differentHash = await hashPassword('CompletelyDifferentPass456!');
    const { created } = await ownerService.bootstrapOwnerFromEnv({ login: 'anotheruser', passwordHash: differentHash });
    assert.equal(created, false, 'второй bootstrap не должен ничего создавать');
    const owner = await ownerService.getOwner();
    assert.equal(owner.login, 'bootuser', 'логин не должен был измениться');
    assert.equal(owner.password_hash, firstHash, 'хеш пароля не должен был измениться');
    assert.equal(owner.credentials_version, 1, 'версия не должна была увеличиться — реального изменения не произошло');
  });

  await t.test('A4: changeOwnerLogin() меняет логин и увеличивает credentials_version', async () => {
    const newVersion = await ownerService.changeOwnerLogin('renameduser');
    assert.equal(newVersion, 2);
    const owner = await ownerService.getOwner();
    assert.equal(owner.login, 'renameduser');
    assert.equal(owner.credentials_version, 2);
  });

  await t.test('A5: changeOwnerPassword() меняет хеш пароля и увеличивает credentials_version', async () => {
    const newHash = await hashPassword('NewPassword789!');
    const newVersion = await ownerService.changeOwnerPassword(newHash);
    assert.equal(newVersion, 3);
    const owner = await ownerService.getOwner();
    assert.equal(owner.password_hash, newHash);
    assert.equal(owner.credentials_version, 3);
  });

  await t.test('A6: resetOwner() на существующем владельце — заменяет логин/пароль, увеличивает версию', async () => {
    const resetHash = await hashPassword('EmergencyResetPass!');
    const newVersion = await ownerService.resetOwner({ login: 'resetuser', passwordHash: resetHash });
    assert.equal(newVersion, 4);
    const owner = await ownerService.getOwner();
    assert.equal(owner.login, 'resetuser');
    assert.equal(owner.password_hash, resetHash);
  });

  await t.test('A7: DB-backstop — вторая строка hq_owner (другой id) отклоняется CHECK-ограничением', async () => {
    await assert.rejects(
      db.query('INSERT INTO hq_owner (id, login, password_hash) VALUES (2, $1, $2)', ['second', 'irrelevant']),
      /check constraint|hq_owner_id_check/i,
    );
  });

  await t.test('A8: DB-backstop — повторная строка с id=1 отклоняется PRIMARY KEY', async () => {
    await assert.rejects(
      db.query('INSERT INTO hq_owner (id, login, password_hash) VALUES (1, $1, $2)', ['dup', 'irrelevant']),
      /duplicate key|hq_owner_pkey/i,
    );
  });

  await t.test('A9: logSecurityEvent() пишет каждый тип события; неизвестный тип не пишется и не роняет вызов', async () => {
    for (const eventType of securityLog.EVENT_TYPES) {
      await securityLog.logSecurityEvent({ eventType, ip: '203.0.113.1' });
    }
    const rows = await db.query('SELECT event_type, ip FROM hq_security_log ORDER BY id');
    assert.equal(rows.length, securityLog.EVENT_TYPES.length);
    for (let i = 0; i < securityLog.EVENT_TYPES.length; i += 1) {
      assert.equal(rows[i].event_type, securityLog.EVENT_TYPES[i]);
      assert.equal(rows[i].ip, '203.0.113.1');
    }
    // Программная ошибка (опечатка в имени события) — не должна ни бросить,
    // ни создать невалидную строку.
    await securityLog.logSecurityEvent({ eventType: 'not_a_real_event', ip: '203.0.113.1' });
    const countAfter = await db.query('SELECT COUNT(*)::int AS c FROM hq_security_log');
    assert.equal(countAfter[0].c, securityLog.EVENT_TYPES.length, 'невалидный eventType не должен создавать строку');
  });

  await db.close();
  delete process.env.DATABASE_URL;
});

// ===========================================================================
// B. Полный HTTP-цикл через createPostgresqlApp()
// ===========================================================================

async function login(port, { username, password }) {
  const loginRes = await fetch(`http://127.0.0.1:${port}/hq/login`);
  const loginHtml = await loginRes.text();
  const cookie = cookieHeaderFrom(loginRes);
  const csrf = extractCsrf(loginHtml);
  const body = new URLSearchParams({ _csrf: csrf, username, password });
  const postRes = await fetch(`http://127.0.0.1:${port}/hq/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
  });
  return { status: postRes.status, cookie: cookieHeaderFrom(postRes) || cookie };
}

test('B1-B2: bootstrap происходит один раз; повторный запуск с ДРУГИМИ .env-данными не перезаписывает владельца', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_bootstrap_once_test');
  const { hashPassword: hp } = require('../../services/hq/passwordHash');
  const firstHash = await hp('FirstOwnerPass123!');
  const secondHash = await hp('SecondOwnerPass456!');

  process.env.DATABASE_URL = databaseUrl;
  let appModule = reloadHqAppModule();
  let instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, hqSessionSecret: TEST_SESSION_SECRET,
    hqAdminUser: 'firstowner', hqAdminPasswordHash: firstHash,
  });
  await instance.start();
  let { port } = await waitForAddress(instance);

  const firstLogin = await login(port, { username: 'firstowner', password: 'FirstOwnerPass123!' });
  assert.equal(firstLogin.status, 302, 'первый владелец из .env должен уметь войти после bootstrap');
  await instance.stop();
  delete process.env.DATABASE_URL;

  // Второй запуск — ДРУГИЕ ADMIN_USER/HASH в .env, та же БД.
  process.env.DATABASE_URL = databaseUrl;
  appModule = reloadHqAppModule();
  instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, hqSessionSecret: TEST_SESSION_SECRET,
    hqAdminUser: 'secondowner', hqAdminPasswordHash: secondHash,
  });
  await instance.start();
  ({ port } = await waitForAddress(instance));

  const oldStillWorks = await login(port, { username: 'firstowner', password: 'FirstOwnerPass123!' });
  assert.equal(oldStillWorks.status, 302, 'владелец из ПЕРВОГО bootstrap должен продолжать работать');

  const newDoesNotWork = await login(port, { username: 'secondowner', password: 'SecondOwnerPass456!' });
  assert.equal(newDoesNotWork.status, 401, 'второй набор .env-данных НЕ должен был создать/заменить владельца');

  await instance.stop();
  delete process.env.DATABASE_URL;
});

test('B3: fail-closed — пустой hq_owner (без bootstrap-переменных) отклоняет любой логин', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_empty_owner_test');
  process.env.DATABASE_URL = databaseUrl;
  const appModule = reloadHqAppModule();
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, hqSessionSecret: TEST_SESSION_SECRET,
    // hqAdminUser/hqAdminPasswordHash сознательно НЕ заданы — таблица
    // остаётся пустой, bootstrap не происходит вовсе.
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  try {
    const res = await login(port, { username: 'anything', password: 'anything' });
    assert.equal(res.status, 401);
  } finally {
    await instance.stop();
    delete process.env.DATABASE_URL;
  }
});

async function settingsPageAndCsrf(port, cookie) {
  const res = await fetch(`http://127.0.0.1:${port}/hq/settings`, { headers: { Cookie: cookie } });
  const html = await res.text();
  return { html, csrf: extractCsrf(html) };
}

test('B4-B10: смена логина/пароля, logout после смены, старые cookie недействительны, security log', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_change_creds_test');
  const { hashPassword: hp } = require('../../services/hq/passwordHash');
  const initialHash = await hp('InitialOwnerPass123!');

  process.env.DATABASE_URL = databaseUrl;
  const appModule = reloadHqAppModule();
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, hqSessionSecret: TEST_SESSION_SECRET,
    hqAdminUser: 'owner', hqAdminPasswordHash: initialHash,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);
  const db = require('../../db/postgresql');

  try {
    // --- B4: смена логина, неверный текущий пароль сначала (B5) ---
    let { cookie } = await login(port, { username: 'owner', password: 'InitialOwnerPass123!' });

    let { html, csrf } = await settingsPageAndCsrf(port, cookie);
    let body = new URLSearchParams({ _csrf: csrf, currentPassword: 'WRONG-password', newLogin: 'shouldnothappen' });
    let res = await fetch(`http://127.0.0.1:${port}/hq/settings/change-login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 401, 'B5: неверный текущий пароль должен отклонить смену логина');
    assert.match(await res.text(), /Неверный текущий пароль/);
    const stillOldLogin = await login(port, { username: 'owner', password: 'InitialOwnerPass123!' });
    assert.equal(stillOldLogin.status, 302, 'логин не должен был поменяться после отклонённой попытки');

    // --- B4: смена логина, верный текущий пароль ---
    ({ html, csrf } = await settingsPageAndCsrf(port, cookie));
    body = new URLSearchParams({ _csrf: csrf, currentPassword: 'InitialOwnerPass123!', newLogin: 'newowner' });
    res = await fetch(`http://127.0.0.1:${port}/hq/settings/change-login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/hq/login?changed=login');

    // старая сессия немедленно недействительна (логаут произошёл при самой смене).
    const afterChangeSameCookie = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(afterChangeSameCookie.status, 302);
    assert.equal(afterChangeSameCookie.headers.get('location'), '/hq/login');

    const oldLoginNoLongerWorks = await login(port, { username: 'owner', password: 'InitialOwnerPass123!' });
    assert.equal(oldLoginNoLongerWorks.status, 401, 'старый логин не должен работать после смены');

    const newLoginWorks = await login(port, { username: 'newowner', password: 'InitialOwnerPass123!' });
    assert.equal(newLoginWorks.status, 302, 'новый логин с тем же паролем должен работать');
    cookie = newLoginWorks.cookie;

    // --- B6/B7/B8/B9: смена пароля ---
    ({ html, csrf } = await settingsPageAndCsrf(port, cookie));
    body = new URLSearchParams({ _csrf: csrf, currentPassword: 'WRONG', newPassword: 'ValidNewPass123!', confirmPassword: 'ValidNewPass123!' });
    res = await fetch(`http://127.0.0.1:${port}/hq/settings/change-password`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 401, 'B7: неверный текущий пароль должен отклонить смену пароля');
    assert.match(await res.text(), /Неверный текущий пароль/);

    ({ html, csrf } = await settingsPageAndCsrf(port, cookie));
    body = new URLSearchParams({ _csrf: csrf, currentPassword: 'InitialOwnerPass123!', newPassword: 'ValidNewPass123!', confirmPassword: 'DOES-NOT-MATCH' });
    res = await fetch(`http://127.0.0.1:${port}/hq/settings/change-password`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 400, 'B8: несовпадающее повторение пароля должно быть отклонено');
    assert.match(await res.text(), /не совпадают/);

    ({ html, csrf } = await settingsPageAndCsrf(port, cookie));
    body = new URLSearchParams({ _csrf: csrf, currentPassword: 'InitialOwnerPass123!', newPassword: 'short', confirmPassword: 'short' });
    res = await fetch(`http://127.0.0.1:${port}/hq/settings/change-password`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 400, 'B9: слишком короткий пароль должен быть отклонён');
    assert.match(await res.text(), /не короче/);

    // Ни одна из отклонённых попыток не должна была тронуть текущую сессию.
    const stillLoggedIn = await fetch(`http://127.0.0.1:${port}/hq`, { headers: { Cookie: cookie } });
    assert.equal(stillLoggedIn.status, 200, 'отклонённые попытки смены пароля не должны были разлогинить текущую сессию');

    // --- B6: успешная смена пароля ---
    ({ html, csrf } = await settingsPageAndCsrf(port, cookie));
    body = new URLSearchParams({ _csrf: csrf, currentPassword: 'InitialOwnerPass123!', newPassword: 'ValidNewPass123!', confirmPassword: 'ValidNewPass123!' });
    res = await fetch(`http://127.0.0.1:${port}/hq/settings/change-password`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/hq/login?changed=password');

    const oldPasswordNoLongerWorks = await login(port, { username: 'newowner', password: 'InitialOwnerPass123!' });
    assert.equal(oldPasswordNoLongerWorks.status, 401, 'старый пароль не должен работать после смены');

    const newPasswordWorks = await login(port, { username: 'newowner', password: 'ValidNewPass123!' });
    assert.equal(newPasswordWorks.status, 302, 'новый пароль должен работать');

    // --- B10: security log содержит ожидаемую последовательность событий ---
    const events = await db.query('SELECT event_type FROM hq_security_log ORDER BY id');
    const types = events.map((e) => e.event_type);
    assert.ok(types.includes('login_success'));
    assert.ok(types.includes('login_failed'));
    assert.ok(types.includes('login_change'));
    assert.ok(types.includes('password_change'));
    // Ни один тип события не хранит пароль/хеш — сама таблица физически не
    // имеет для этого колонки (см. db/postgresql/schema.sql), но также
    // явно проверим, что ни в одной строке лога нет намёка на пароль.
    const allRows = await db.query('SELECT * FROM hq_security_log');
    for (const row of allRows) {
      assert.ok(!Object.keys(row).some((k) => /password|hash/i.test(k)), 'hq_security_log не должен иметь колонок, похожих на пароль/хеш');
    }
  } finally {
    await instance.stop();
    delete process.env.DATABASE_URL;
  }
});

// ===========================================================================
// C. CLI server/scripts/reset-hq-owner.js
// ===========================================================================

test('C1-C2: CLI reset-hq-owner.js — обновляет владельца, разлогинивает существующие сессии, не печатает пароль', async () => {
  const databaseUrl = await freshDatabase('yaam_hq_cli_reset_test');
  const { hashPassword: hp } = require('../../services/hq/passwordHash');
  const initialHash = await hp('BeforeResetPass123!');

  process.env.DATABASE_URL = databaseUrl;
  const appModule = reloadHqAppModule();
  const instance = appModule.createPostgresqlApp({
    port: 0, schedulerIntervalMs: 1_000_000, hqSessionSecret: TEST_SESSION_SECRET,
    hqAdminUser: 'clibefore', hqAdminPasswordHash: initialHash,
  });
  await instance.start();
  const { port } = await waitForAddress(instance);

  try {
    const beforeLogin = await login(port, { username: 'clibefore', password: 'BeforeResetPass123!' });
    assert.equal(beforeLogin.status, 302);
    const sessionBeforeReset = beforeLogin.cookie;

    // CLI работает отдельным процессом — та же embedded PG база через
    // DATABASE_URL, но собственное подключение (не тот же pool, что у
    // работающего приложения — реалистично воспроизводит "владелец забыл
    // пароль, запускает скрипт руками на VPS, пока сайт продолжает работать").
    const cliOutput = execFileSync(process.execPath, [path.join(__dirname, '../../scripts/reset-hq-owner.js')], {
      input: 'clireset\nAfterResetPass456!\n',
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    });
    assert.match(cliOutput, /HQ owner reset completed\./);
    assert.ok(!cliOutput.includes('BeforeResetPass123!'));
    assert.ok(!cliOutput.includes('AfterResetPass456!'), 'CLI не должен печатать новый пароль');

    // C2: сессия, залогиненная ДО сброса, больше не работает.
    const afterResetOldCookie = await fetch(`http://127.0.0.1:${port}/hq`, {
      headers: { Cookie: sessionBeforeReset }, redirect: 'manual',
    });
    assert.equal(afterResetOldCookie.status, 302);
    assert.equal(afterResetOldCookie.headers.get('location'), '/hq/login');

    const oldCredsNoLongerWork = await login(port, { username: 'clibefore', password: 'BeforeResetPass123!' });
    assert.equal(oldCredsNoLongerWork.status, 401);

    const newCredsWork = await login(port, { username: 'clireset', password: 'AfterResetPass456!' });
    assert.equal(newCredsWork.status, 302);
  } finally {
    await instance.stop();
    delete process.env.DATABASE_URL;
  }
});
