'use strict';

// YAAM HQ Stage 4.1 — юнит-тесты чистой логики lifecycle-статуса ресторана
// (services/hq/restaurantLifecycle.js): резолвер итогового статуса и все
// transition-guard'ы. Ни один тест не обращается к PostgreSQL — те же
// принципы, что и test/hqRestaurantAdmin.test.js (Stage 4). Реальные UPDATE
// на этих же правилах проверены отдельно в test/postgresql/
// hqRestaurantLifecycleStage41.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  resolveLifecycleStatus,
  assertCanPublish,
  assertCanUnpublish,
  assertCanOpen,
  assertCanClose,
  assertCanPause,
  assertCanResume,
  assertCanArchive,
  assertCanRestore,
} = require('../services/hq/restaurantLifecycle');

const NOW = new Date('2026-07-27T12:00:00Z');
const FUTURE = new Date('2026-07-27T13:00:00Z');
const PAST = new Date('2026-07-27T11:00:00Z');

function draft() {
  return { published_at: null, archived_at: null, is_open: 0, paused_until: null };
}
function openR() {
  return { published_at: new Date('2026-01-01'), archived_at: null, is_open: 1, paused_until: null };
}
function closedR() {
  return { published_at: new Date('2026-01-01'), archived_at: null, is_open: 0, paused_until: null };
}
function pausedR() {
  return { published_at: new Date('2026-01-01'), archived_at: null, is_open: 0, paused_until: FUTURE };
}
function expiredPauseR() {
  return { published_at: new Date('2026-01-01'), archived_at: null, is_open: 0, paused_until: PAST };
}
function archivedR() {
  return { published_at: new Date('2026-01-01'), archived_at: new Date('2026-01-02'), is_open: 0, paused_until: null };
}

// ---------------------------------------------------------------------------
// resolveLifecycleStatus — задание, раздел 4, таблица состояний A-E.
// ---------------------------------------------------------------------------

test('resolveLifecycleStatus: A. черновик — published_at=NULL, archived_at=NULL', () => {
  assert.equal(resolveLifecycleStatus(draft(), NOW), 'draft');
});

test('resolveLifecycleStatus: B. опубликован и открыт', () => {
  assert.equal(resolveLifecycleStatus(openR(), NOW), 'open');
});

test('resolveLifecycleStatus: C. опубликован и закрыт (не на паузе)', () => {
  assert.equal(resolveLifecycleStatus(closedR(), NOW), 'closed');
});

test('resolveLifecycleStatus: D. на паузе — paused_until в будущем', () => {
  assert.equal(resolveLifecycleStatus(pausedR(), NOW), 'paused');
});

test('resolveLifecycleStatus: истёкшая (в прошлом) пауза классифицируется как "закрыт", не "на паузе"', () => {
  assert.equal(resolveLifecycleStatus(expiredPauseR(), NOW), 'closed');
});

test('resolveLifecycleStatus: E. архивирован — приоритет над всеми остальными полями', () => {
  assert.equal(resolveLifecycleStatus(archivedR(), NOW), 'archived');
  // Даже если бы (гипотетически) is_open=1/паuза была одновременно выставлена —
  // archived_at всё равно должен победить в резолвере.
  assert.equal(resolveLifecycleStatus({ ...archivedR(), is_open: 1, paused_until: FUTURE }, NOW), 'archived');
});

// ---------------------------------------------------------------------------
// assertCanPublish / assertCanUnpublish
// ---------------------------------------------------------------------------

test('assertCanPublish: черновик — разрешено (не бросает)', () => {
  assert.doesNotThrow(() => assertCanPublish(draft()));
});

test('assertCanPublish: уже опубликован — отклонено', () => {
  assert.throws(() => assertCanPublish(closedR()), ValidationError);
});

test('assertCanPublish: архивирован — отклонено с понятным сообщением про восстановление', () => {
  assert.throws(() => assertCanPublish(archivedR()), /восстанов/i);
});

test('assertCanUnpublish: опубликован — разрешено', () => {
  assert.doesNotThrow(() => assertCanUnpublish(openR()));
});

test('assertCanUnpublish: черновик — отклонено ("ещё не опубликован")', () => {
  assert.throws(() => assertCanUnpublish(draft()), ValidationError);
});

// ---------------------------------------------------------------------------
// assertCanOpen — задание, раздел 9, дословные правила.
// ---------------------------------------------------------------------------

test('assertCanOpen: опубликован, закрыт, не на паузе — разрешено', () => {
  assert.doesNotThrow(() => assertCanOpen(closedR(), NOW));
});

test('assertCanOpen: черновик — «Сначала опубликуйте ресторан.»', () => {
  assert.throws(() => assertCanOpen(draft(), NOW), /Сначала опубликуйте ресторан\./);
});

test('assertCanOpen: на паузе — отклонено', () => {
  assert.throws(() => assertCanOpen(pausedR(), NOW), ValidationError);
});

test('assertCanOpen: архивирован — отклонено', () => {
  assert.throws(() => assertCanOpen(archivedR(), NOW), ValidationError);
});

test('assertCanOpen: уже открыт — отклонено (идемпотентность, не тихий no-op)', () => {
  assert.throws(() => assertCanOpen(openR(), NOW), ValidationError);
});

test('assertCanOpen: истёкшая пауза (paused_until в прошлом) — открыть можно', () => {
  assert.doesNotThrow(() => assertCanOpen(expiredPauseR(), NOW));
});

// ---------------------------------------------------------------------------
// assertCanClose
// ---------------------------------------------------------------------------

test('assertCanClose: открыт — разрешено', () => {
  assert.doesNotThrow(() => assertCanClose(openR(), NOW));
});

test('assertCanClose: черновик — отклонено', () => {
  assert.throws(() => assertCanClose(draft(), NOW), ValidationError);
});

test('assertCanClose: уже закрыт — отклонено', () => {
  assert.throws(() => assertCanClose(closedR(), NOW), ValidationError);
});

test('assertCanClose: на паузе — отклонено (пауза — не то же самое, что закрыть)', () => {
  assert.throws(() => assertCanClose(pausedR(), NOW), ValidationError);
});

// ---------------------------------------------------------------------------
// assertCanPause / assertCanResume — задание, раздел 9.
// ---------------------------------------------------------------------------

test('assertCanPause: опубликован и открыт — разрешено', () => {
  assert.doesNotThrow(() => assertCanPause(openR(), NOW));
});

test('assertCanPause: черновик — «пауза бессмысленна и должна быть недоступна»', () => {
  assert.throws(() => assertCanPause(draft(), NOW), /Сначала опубликуйте ресторан\./);
});

test('assertCanPause: уже закрыт (не на паузе) — отклонено (пауза только для открытого)', () => {
  assert.throws(() => assertCanPause(closedR(), NOW), ValidationError);
});

test('assertCanPause: уже на паузе — отклонено', () => {
  assert.throws(() => assertCanPause(pausedR(), NOW), ValidationError);
});

test('assertCanPause: архивирован — отклонено', () => {
  assert.throws(() => assertCanPause(archivedR(), NOW), ValidationError);
});

test('assertCanResume: реально на паузе — разрешено', () => {
  assert.doesNotThrow(() => assertCanResume(pausedR(), NOW));
});

test('assertCanResume: НЕ на паузе (просто закрыт) — отклонено; resume не подменяет собой "Открыть"', () => {
  assert.throws(() => assertCanResume(closedR(), NOW), /не на паузе/);
});

test('assertCanResume: черновик — отклонено (черновик не может быть на паузе)', () => {
  assert.throws(() => assertCanResume(draft(), NOW), ValidationError);
});

test('assertCanResume: истёкшая пауза — считается уже не паузой, отклонено', () => {
  assert.throws(() => assertCanResume(expiredPauseR(), NOW), ValidationError);
});

// ---------------------------------------------------------------------------
// assertCanArchive / assertCanRestore
// ---------------------------------------------------------------------------

test('assertCanArchive: любой неархивированный статус — разрешено (включая черновик)', () => {
  assert.doesNotThrow(() => assertCanArchive(draft()));
  assert.doesNotThrow(() => assertCanArchive(openR()));
  assert.doesNotThrow(() => assertCanArchive(pausedR()));
});

test('assertCanArchive: уже архивирован — отклонено', () => {
  assert.throws(() => assertCanArchive(archivedR()), ValidationError);
});

test('assertCanRestore: архивирован — разрешено', () => {
  assert.doesNotThrow(() => assertCanRestore(archivedR()));
});

test('assertCanRestore: не архивирован — отклонено ("публикация архивированного без предварительного восстановления" запрещена симметрично)', () => {
  assert.throws(() => assertCanRestore(draft()), ValidationError);
  assert.throws(() => assertCanRestore(openR()), ValidationError);
});
