'use strict';

// YAAM — структурированные серверные логи с редактированием (Stage 15).
//
// ЗАЧЕМ. Логи — самое частое место утечки: секрет попадает туда не через
// злой умысел, а через `console.log(req.headers)` или `console.error(err)`,
// где в объекте оказался токен. На VPS логи читает systemd-journal, их видит
// любой, у кого есть доступ к серверу, и они переживают ротацию.
//
// ПРИНЦИП РЕДАКТИРОВАНИЯ. Не «искать секреты», а не пускать целые классы
// данных: ключи с говорящими именами вырезаются по имени, значения с
// узнаваемой формой (capability-токен, Bearer, cookie сессии) — по образцу.
// Оба слоя нужны: имя ловит `{ password: '...' }`, образец ловит секрет,
// приехавший внутри строки URL.
//
// Внешняя observability-платформа намеренно не вводится: JSON-строка в stdout
// разбирается journald и любым сборщиком, а зависимости не растут.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[REDACTED]';

// Имена полей, значение которых не должно попадать в лог никогда.
const SENSITIVE_KEY_RE = /(pass|secret|token|authorization|cookie|credential|api[-_]?key|shop[-_]?id|account_number|correspondent_account|card|cvv|hash)/i;

// Персональные данные клиента. Не «секрет», но и в логах им делать нечего:
// адрес и комментарий не нужны ни для одной эксплуатационной задачи.
const PII_KEY_RE = /^(customer_name|customerName|customer_phone|customerPhone|address|comment|phone)$/i;

// Узнаваемые формы секретов в свободном тексте.
const VALUE_PATTERNS = [
  // Capability-токен документа: yaam_doc_v1_<43 символа base64url>.
  [/yaam_doc_v1_[A-Za-z0-9_-]{10,}/g, 'yaam_doc_v1_[REDACTED]'],
  // Share-токен заказа.
  [/yaam_shr_v1_[A-Za-z0-9_-]{10,}/g, 'yaam_shr_v1_[REDACTED]'],
  // Bearer-заголовок.
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  // Ключи YooKassa.
  [/\b(test|live)_[A-Za-z0-9_-]{10,}/g, '$1_[REDACTED]'],
  // Cookie сессии HQ.
  [/yaam\.hq\.sid=[^;\s]+/g, 'yaam.hq.sid=[REDACTED]'],
  // Строка подключения к БД с паролем.
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDACTED]@'],
];

function redactString(value) {
  let out = String(value);
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Рекурсивное редактирование. depth ограничен: логировать глубокие графы
// объектов не нужно, а бесконечная рекурсия на циклической ссылке — реальный
// способ уронить процесс логом.
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth >= 4) return '[DEPTH_LIMIT]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k) || PII_KEY_RE.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redact(v, depth + 1, seen);
    }
    return out;
  }
  return REDACTED;
}

// Путь без секретов: capability-роут содержит токен ПРЯМО В URL, поэтому
// originalUrl логировать нельзя. Query-строка отбрасывается целиком — там
// нет ничего, что стоило бы риска.
function safeRoute(req) {
  const raw = String(req.originalUrl || req.url || '');
  const withoutQuery = raw.split('?')[0];
  // /d/<token> -> /d/:token
  const masked = withoutQuery.replace(/^\/d\/[^/]+/, '/d/:token');
  return redactString(masked);
}

function createLogger({ level = process.env.LOG_LEVEL || 'info', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;

  function write(lvl, message, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactString(message),
      ...redact(fields),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    level,
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    // Итог фоновой задачи — отдельный метод: у них нет request ID, но есть
    // тип и результат, и по ним разбирают ночные инциденты.
    job: (name, result, fields = {}) => write(
      result === 'failed' ? 'error' : 'info',
      `job ${name} ${result}`,
      { job: name, result, ...fields },
    ),
  };
}

// Express-middleware доступа. Логирует ЗАВЕРШЕНИЕ запроса: до него неизвестны
// ни статус, ни длительность.
function createRequestLogger(logger) {
  return function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info('request', {
        requestId: req.id || null,
        method: req.method,
        route: safeRoute(req),
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      });
    });
    next();
  };
}

module.exports = {
  LEVELS, REDACTED, redact, redactString, safeRoute, createLogger, createRequestLogger,
};
