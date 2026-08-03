'use strict';

// YAAM HQ — хранилище сессий в PostgreSQL (Stage 15).
//
// ЗАЧЕМ. До этого этапа использовался дефолтный MemoryStore express-session.
// Это production-блокер по трём причинам сразу:
//   1. любой перезапуск (деплой, systemd restart, падение) разлогинивал
//      владельца — сессии жили только в памяти процесса;
//   2. MemoryStore течёт: истёкшие записи никогда не удаляются;
//   3. два процесса приложения не видели бы сессии друг друга.
//
// ПОЧЕМУ СВОЙ СТОР, А НЕ connect-pg-simple. Контракт express-session Store —
// четыре метода. Своя реализация на уже имеющемся пуле `pg` избавляет от
// новой зависимости в production-контуре и делает поведение (в том числе
// очистку истёкших записей) явным и проверяемым тестом.
//
// БЕЗОПАСНОСТЬ. В таблице лежит сериализованная сессия: hqUser,
// hqCredentialsVersion, CSRF-токен. Пароля там нет и быть не может.
// session_id хранится как есть — это и есть значение cookie; защита от
// подделки обеспечивается подписью cookie (express-session secret), а от
// утечки дампа — тем, что доступ к таблице имеет только приложение.
const { Store } = require('express-session');
const db = require('../../db/postgresql');

// Раз в 15 минут — достаточно, чтобы таблица не росла, и достаточно редко,
// чтобы не мешать. Чистка НЕ блокирует запросы: это отдельный интервал.
const DEFAULT_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

class PgSessionStore extends Store {
  constructor({ pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS, autoPrune = true } = {}) {
    super();
    this.pruneTimer = null;
    if (autoPrune && pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => {
        this.prune().catch((err) => {
          console.error('[hq/session-store] очистка истёкших сессий не удалась:', err.message);
        });
      }, pruneIntervalMs);
      // unref: незавершённый таймер не должен удерживать процесс при
      // выключении — этим управляет lifecycle, а не стор.
      if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
    }
  }

  // Истёкшая сессия считается отсутствующей ДАЖЕ если строка ещё не удалена:
  // полагаться только на фоновую чистку означало бы окно, в котором
  // просроченная сессия продолжает работать.
  get(sid, callback) {
    db.query(
      'SELECT sess FROM hq_sessions WHERE sid = $1 AND expires_at > NOW()', [sid],
    ).then((rows) => {
      if (!rows[0]) return callback(null, null);
      const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
      return callback(null, sess);
    }).catch((err) => callback(err));
  }

  set(sid, session, callback) {
    const expiresAt = this._expiry(session);
    db.execute(
      `INSERT INTO hq_sessions (sid, sess, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expires_at = EXCLUDED.expires_at`,
      [sid, JSON.stringify(session), expiresAt],
    ).then(() => callback(null)).catch((err) => callback(err));
  }

  destroy(sid, callback) {
    db.execute('DELETE FROM hq_sessions WHERE sid = $1', [sid])
      .then(() => callback(null)).catch((err) => callback(err));
  }

  // rolling:true продлевает сессию на каждом запросе. Без touch() продление
  // требовало бы перезаписи всей сессии — здесь обновляется только срок.
  touch(sid, session, callback) {
    db.execute('UPDATE hq_sessions SET expires_at = $2 WHERE sid = $1', [sid, this._expiry(session)])
      .then(() => callback(null)).catch((err) => callback(err));
  }

  async prune() {
    const res = await db.execute('DELETE FROM hq_sessions WHERE expires_at <= NOW()');
    return res.rowCount || 0;
  }

  // Остановка таймера — вызывается lifecycle при выключении.
  close() {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  _expiry(session) {
    const cookie = session && session.cookie;
    if (cookie && cookie.expires) return new Date(cookie.expires);
    const maxAge = cookie && cookie.maxAge ? cookie.maxAge : 24 * 60 * 60 * 1000;
    return new Date(Date.now() + maxAge);
  }
}

module.exports = { PgSessionStore, DEFAULT_PRUNE_INTERVAL_MS };
