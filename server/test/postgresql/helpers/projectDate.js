'use strict';

// Единственный источник "сегодня" для PostgreSQL-тестов, работающих с
// расчётными периодами (settlement_periods.period_from/period_to).
// Production-логика (services/hq/dashboardMetrics.js:todayRangeUtc(),
// services/hq/restaurantStatsService.js:dateOnlyToUtcStart()) интерпретирует
// период_from/period_to как календарную дату Europe/Moscow (фиксированное
// смещение +180 минут, без DST — см. комментарий в dashboardMetrics.js), а
// не как дату по чистому UTC-календарю. До этого файла пять тестовых файлов
// независимо друг от друга определяли одинаковый, но НЕВЕРНЫЙ todayStr(),
// считавший "сегодня" по чистому UTC — рядом с границей 21:00-24:00 UTC
// (00:00-03:00 МСК) это давало другую календарную дату, чем production-код,
// и тесты падали в это конкретное окно времени суток, а не из-за реального
// дефекта. PROJECT_TIMEZONE_OFFSET_MINUTES импортирован из
// dashboardMetrics.js, не задан заново — при изменении там тесты не
// рассинхронизируются молча.
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('../../../services/hq/dashboardMetrics');

// Возвращает календарную дату проекта (Europe/Moscow) как "YYYY-MM-DD" для
// nowUtc + offsetDays суток. nowUtc принимает явный Date — по умолчанию
// текущий момент, но точечные граничные тесты (20:59/21:00/23:59/00:00 UTC)
// обязаны передавать его явно, чтобы не зависеть от реального времени
// запуска CI.
function projectTodayStr(offsetDays = 0, nowUtc = new Date()) {
  const offsetMs = PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(nowUtc.getTime() + offsetMs + offsetDays * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

module.exports = { projectTodayStr, PROJECT_TIMEZONE_OFFSET_MINUTES };
