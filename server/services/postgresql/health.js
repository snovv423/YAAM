'use strict';

// YAAM — PostgreSQL health check, Production Switch Stage 6 (operational
// infrastructure). Изолированный, не подключённый к production модуль.
//
// server.js (SQLite) сегодня имеет только статический `GET /health` →
// `res.json({ ok: true })` — не проверяет вообще ничего (ни БД, ни таймеры),
// просто подтверждает, что HTTP-сервер отвечает. Этот модуль даёт РЕАЛЬНУЮ
// проверку для PostgreSQL-стороны, с явным разделением liveness/readiness —
// задание прямо требует оба вида и явно перечисляет минимальный набор:
// "PostgreSQL connection; pool state; scheduler state; process uptime".
//
// Liveness и readiness намеренно РАЗНЫЕ проверки (стандартная практика
// health-check'ов, не изобретение этой задачи): liveness отвечает на вопрос
// "процесс жив и event loop отвечает" и НЕ должен зависеть от внешних
// систем — если это сделать зависимым от БД, временный сбой PostgreSQL
// заставил бы оркестратор (systemd/k8s/etc.) убить и перезапустить ЖИВОЙ,
// исправный процесс, что только усугубляет ситуацию во время как раз
// восстановления БД. Readiness — наоборот, обязана проверять реальные
// зависимости (это и есть её смысл: "готов ли процесс реально обслуживать
// трафик прямо сейчас").
const db = require('../../db/postgresql');

// getSchedulers() — функция, а не массив, чтобы health-check всегда видел
// АКТУАЛЬНый набор schedulers на момент вызова (на случай, если вызывающий
// код когда-нибудь начнёт/остановит scheduler динамически), а не снимок на
// момент createHealthCheck().
//
// getBotState() — Stage 7 добавление, полностью опциональное (default отдаёт
// null, обратная совместимость со Stage 6 вызывающим кодом/тестами, которые
// этот параметр не передают). Bot state НЕ участвует в `ok` — временный
// сбой Telegram не должен превращать readiness в false (см.
// server/docs/postgresql-application-assembly.md, раздел "Bot lifecycle и
// readiness"), только наблюдаемое поле в ответе.
function createHealthCheck({ getSchedulers = () => [], getBotState = () => null } = {}) {
  async function checkDatabase() {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function checkPool() {
    const pool = db.getPool();
    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  }

  function checkSchedulers() {
    return getSchedulers().map((scheduler, index) => ({
      index,
      running: scheduler.isRunning(),
    }));
  }

  // Liveness — НЕ трогает БД/пул намеренно (см. header-комментарий).
  async function liveness() {
    return {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
    };
  }

  // Readiness — реальная проверка всех зависимостей, перечисленных заданием.
  // `bot` — наблюдаемое поле (см. комментарий у getBotState выше), не влияет
  // на `ok`: null, если вызывающий код не передал getBotState (Stage 6
  // поведение не меняется, bot ещё не существовал на момент Stage 6).
  async function readiness() {
    const database = await checkDatabase();
    const pool = checkPool();
    const schedulers = checkSchedulers();
    const bot = getBotState();
    return {
      ok: database.ok,
      uptimeSec: Math.floor(process.uptime()),
      database,
      pool,
      schedulers,
      bot,
    };
  }

  return { liveness, readiness };
}

module.exports = { createHealthCheck };
