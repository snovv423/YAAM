'use strict';

// Общий layout HQ — та же цветовая система (--bg/--panel/--txt/--amber/--bord),
// что и server/admin/layout.js, чтобы HQ визуально узнавался как часть YAAM,
// но с собственной навигацией (Обзор/Рестораны/Финансы/Настройки) — HQ не
// является просто перекраской старой /admin, это отдельный инструмент.
//
// HQ — рабочий инструмент, а не публичная страница: сознательно НЕ копируем
// маркетинговую вёрстку client/ (шрифты/декор/анимации), только чистая
// структура с минимумом визуального шума (п.8 задания).

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV_ITEMS = [
  { key: 'overview', href: '/hq', label: 'Обзор' },
  { key: 'restaurants', href: '/hq/restaurants', label: 'Рестораны' },
  { key: 'finance', href: '/hq/finance', label: 'Финансы' },
  { key: 'settings', href: '/hq/settings', label: 'Настройки' },
];

// active — ключ текущего раздела (для подсветки и aria-current).
// csrfToken — нужен форме логаута (POST-запрос, требует CSRF, см.
// server/services/hq/csrf.js).
function layout({ title, active, body, csrfToken }) {
  const navHtml = NAV_ITEMS.map((item) => {
    const isActive = item.key === active;
    return `<a href="${item.href}" class="${isActive ? 'on' : ''}"${isActive ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`;
  }).join('\n  ');

  const mobileNavHtml = NAV_ITEMS.map((item) => {
    const isActive = item.key === active;
    return `<a href="${item.href}" class="${isActive ? 'on' : ''}"${isActive ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`;
  }).join('\n  ');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>${esc(title)} — YAAM HQ</title>
<style>
  :root{--bg:#0A2417;--panel:#123322;--txt:#F1F7F2;--txt2:rgba(241,247,242,.62);--amber:#FF9A2E;--bord:rgba(255,255,255,.14);--danger:#FF7059;--ok:#34D38C}
  *{box-sizing:border-box}
  body{font-family:-apple-system,Manrope,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:0;min-height:100vh}
  a{color:inherit}
  .shell{display:flex;min-height:100vh}
  .side{width:220px;flex-shrink:0;border-right:1px solid var(--bord);padding:20px 14px;display:flex;flex-direction:column}
  .side .brand{font-weight:800;font-size:16px;padding:0 10px 20px}
  .side nav{display:flex;flex-direction:column;gap:2px;flex:1}
  .side nav a{display:block;padding:10px 12px;border-radius:10px;color:var(--txt2);text-decoration:none;font-weight:600;font-size:14px}
  .side nav a.on{background:rgba(255,154,46,.14);color:var(--amber)}
  .side nav a:hover{color:var(--txt)}
  .logout-form{margin:0;padding:0 10px}
  .logout-btn{width:100%;background:rgba(255,255,255,.06);color:var(--txt2);border:1px solid var(--bord);border-radius:10px;padding:10px 12px;font-weight:700;cursor:pointer;font-size:13px}
  .logout-btn:hover{color:var(--txt);border-color:rgba(255,255,255,.28)}
  main{flex:1;max-width:960px;margin:0 auto;padding:28px 24px 100px;width:100%}
  h1{font-size:22px;margin:0 0 18px}
  .panel{background:var(--panel);border:1px solid var(--bord);border-radius:14px;padding:20px;margin-bottom:20px}
  .metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px}
  .metric{background:var(--panel);border:1px solid var(--bord);border-radius:14px;padding:16px}
  .metric .value{font-size:26px;font-weight:800;line-height:1.1}
  .metric .label{font-size:12px;color:var(--txt2);margin-top:6px;text-transform:uppercase;letter-spacing:.02em}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--bord);font-size:14px}
  th{color:var(--txt2);font-weight:600;font-size:12px;text-transform:uppercase}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
  .badge.open{background:rgba(52,211,140,.18);color:var(--ok)}
  .badge.closed{background:rgba(255,112,89,.18);color:var(--danger)}
  .badge.paused{background:rgba(255,154,46,.18);color:var(--amber)}
  .empty-state{color:var(--txt2);font-size:14px;padding:8px 0}
  .attention-ok{color:var(--ok);font-weight:600}
  .attention-item{color:var(--danger);font-weight:600}
  .mobile-nav{display:none}
  .mobile-top{display:none}
  @media (max-width: 760px){
    .side{display:none}
    main{padding:76px 16px 90px}
    .mobile-top{display:flex;position:fixed;top:0;left:0;right:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--bord);align-items:center;justify-content:space-between;padding:14px 16px}
    .mobile-top .brand{font-weight:800;font-size:15px}
    .mobile-top .logout-form{padding:0}
    .mobile-top .logout-btn{width:auto;padding:8px 14px}
    .mobile-nav{display:flex;position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--bord);justify-content:space-around;padding:6px 4px calc(6px + env(safe-area-inset-bottom));z-index:2}
    .mobile-nav a{flex:1;text-align:center;padding:8px 4px;color:var(--txt2);text-decoration:none;font-size:12px;font-weight:600;border-radius:10px;min-height:44px;display:flex;align-items:center;justify-content:center}
    .mobile-nav a.on{color:var(--amber)}
  }
</style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <div class="brand">YAAM HQ</div>
    <nav>
      ${navHtml}
    </nav>
    <form class="logout-form" method="post" action="/hq/logout">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <button type="submit" class="logout-btn">Выйти</button>
    </form>
  </aside>
  <main>${body}</main>
</div>
<div class="mobile-top">
  <span class="brand">YAAM HQ</span>
  <form class="logout-form" method="post" action="/hq/logout">
    <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
    <button type="submit" class="logout-btn">Выйти</button>
  </form>
</div>
<nav class="mobile-nav">
  ${mobileNavHtml}
</nav>
</body>
</html>`;
}

module.exports = { layout, esc, NAV_ITEMS };
