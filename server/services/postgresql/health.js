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
const migrator = require('./migrator');
const { inspectEnv } = require('../config/env');
const { createLogger } = require('../observability/logger');

const defaultLogger = createLogger();

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
// getCommitSha() — какой именно commit реально обслуживает этот процесс,
// без доступа по SSH (см. YAAM-HQ-Test-Environment-Deployment-Plan.md,
// раздел 10 — на api-pg.yaam.su сегодня это нельзя проверить удалённо
// вообще). Читает GIT_COMMIT_SHA из окружения деплоя (не из `git`
// напрямую — на самом сервере может не быть .git вообще, если деплой идёт
// архивом/tarball, а не git checkout) — 'unknown' безопасное значение по
// умолчанию, если переменная не задана (не бросает, не путает с реальным
// хэшем). Не участвует в `ok` — то же самое разделение "информационное
// поле, не влияющее на смысл проверки", что уже применено к getBotState()
// (см. header-комментарий выше).
function createHealthCheck({
  getSchedulers = () => [], getBotState = () => null, getCommitSha = () => 'unknown',
  getFinancialHealth = () => null,
  logger = defaultLogger,
} = {}) {
  async function checkDatabase() {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      // Stage 15: сообщение драйвера НЕ отдаётся наружу. Оно способно
      // содержать строку подключения с паролем, имя пользователя и хост —
      // readiness анонимен, и это была бы прямая утечка. Наружу — только
      // факт недоступности; подробности уходят в лог с редактированием.
      logger.error('readiness: база недоступна', { error: err });
      return { ok: false, error: 'database unavailable' };
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
  // Stage 15: миграции и конфигурация — часть готовности.
  //
  // ЧТО ДЕЛАЕТ not ready, а что только предупреждение:
  //   not ready — недоступна БД, есть непринятые миграции, конфигурация
  //     запрещает запуск. Во всех трёх случаях обслуживать трафик нельзя:
  //     запрос либо упадёт, либо отработает по неполной схеме.
  //   предупреждение — Telegram недоступен, планировщик временно не
  //     запущен. Заказы при этом принимаются и оплачиваются, снимать
  //     инстанс с трафика было бы вреднее.
  async function checkMigrations() {
    try {
      return await migrator.getMigrationStatus();
    } catch (err) {
      return { ok: false, error: 'migration status unavailable' };
    }
  }

  function checkConfig() {
    try {
      const { mode, errors } = inspectEnv();
      // Наружу — только КОЛИЧЕСТВО проблем и режим. Тексты ошибок содержат
      // имена переменных окружения и не должны быть доступны анонимно.
      return { ok: errors.length === 0, mode, problems: errors.length };
    } catch (err) {
      return { ok: false, mode: 'unknown', problems: 1 };
    }
  }

  async function readiness() {
    const database = await checkDatabase();
    const pool = checkPool();
    const schedulers = checkSchedulers();
    const bot = getBotState();
    // Stage 22: финансовая готовность отделена от технической. Приложение
    // может быть полностью живым и при этом иметь необъяснённое расхождение
    // в расчётах — тогда `ok` остаётся true, но состояние видно явно.
    const financial = getFinancialHealth();
    const commitSha = getCommitSha();
    const migrations = await checkMigrations();
    const config = checkConfig();
    return {
      ok: database.ok && migrations.ok && config.ok,
      migrations: { ok: migrations.ok, applied: migrations.applied, total: migrations.total },
      config,
      uptimeSec: Math.floor(process.uptime()),
      database,
      pool,
      schedulers,
      bot,
      ...(financial ? { financial } : {}),
      // Строго не пустая произвольная строка — только либо реальный commit
      // hash, либо ровно 'unknown'. Никаких других env-переменных/секретов
      // это поле не раскрывает (см. п.2 задания) — только этот один вывод
      // getCommitSha().
      commitSha: typeof commitSha === 'string' && commitSha.trim() ? commitSha.trim() : 'unknown',
    };
  }

  return { liveness, readiness };
}

module.exports = { createHealthCheck };
