'use strict';

// Stage 2.1 — clean-root routing для hq.yaam.su.
//
// HQ-роутер ВСЕГДА монтируется в services/postgresql/app.js под '/hq'
// (внутренний mount point не меняется — см. routes/hq/index.js) — меняется
// только то, какой префикс само приложение использует при ГЕНЕРАЦИИ ссылок/
// redirect'ов/form action/cookie path в собственных ответах:
//   - локально/по умолчанию: '/hq' (совпадает со Stage 2, ничего не ломает);
//   - за reverse-proxy на отдельном поддомене (hq.yaam.su): '' — тогда
//     приложение само рендерит '/', '/login', '/static/hq.js' и т.д., а
//     Nginx (см. docs) добавляет '/hq' обратно ТОЛЬКО на пути ВНУТРЬ, к
//     backend'у — наружу, в браузер, префикс никогда не попадает.
//
// Валидация здесь узкая специально: единственный поддерживаемый вид
// непустого значения — один сегмент вида "/hq" (буквы/цифры/-/_, без
// вложенных путей и без завершающего слэша) — этого достаточно для
// поддерживаемого сценария и исключает опечатки вроде "/hq/" (двойной
// слэш в сгенерированных ссылках) или "hq" (без ведущего слэша).
const SEGMENT_RE = /^\/[a-zA-Z0-9_-]+$/;

function normalizeHqLinkBasePath(value) {
  if (value === undefined || value === null) return '/hq';
  if (value === '') return '';
  if (typeof value === 'string' && SEGMENT_RE.test(value)) return value;
  throw new Error(
    `HQ_LINK_BASE_PATH="${value}" недопустим — используйте пустую строку "" для clean-root `
    + 'или один сегмент вида "/hq" (буквы/цифры/-/_, без завершающего слэша).'
  );
}

// '/hq' -> '/hq' (локальный корень как и был);  '' -> '/' (публичный корень
// clean-root — пустая строка НЕ является валидным Cookie Path/href).
function hqRootPath(linkBasePath) {
  return linkBasePath === '' ? '/' : linkBasePath;
}

module.exports = { normalizeHqLinkBasePath, hqRootPath };
