// Список разрешённых origin — из env (через запятую), а не хардкод по коду.
// Если переменную не задали — по умолчанию только боевой домен YAAM, а не
// открытый доступ откуда угодно (fail-safe в сторону строгости, а не наоборот).
const DEFAULT_PROD_ORIGINS = ['https://yaam.su', 'https://www.yaam.su'];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function buildCorsOptions() {
  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowList = envOrigins.length ? envOrigins : DEFAULT_PROD_ORIGINS;
  const allowLocalhost = process.env.NODE_ENV !== 'production';

  return {
    origin(origin, callback) {
      // Без Origin — не браузерный кросс-origin запрос (curl, вебхук провайдера,
      // health-check и т.п.), CORS тут ни при чём, пропускаем.
      if (!origin) return callback(null, true);
      if (allowList.includes(origin)) return callback(null, true);
      if (allowLocalhost && LOCALHOST_RE.test(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin "${origin}" не разрешён`));
    },
  };
}

module.exports = { buildCorsOptions };
