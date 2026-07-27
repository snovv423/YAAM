'use strict';

// Общий layout HQ — та же цветовая система (--bg/--panel/--txt/--amber/--bord),
// что и server/admin/layout.js, чтобы HQ визуально узнавался как часть YAAM,
// но с собственной навигацией (Обзор/Рестораны/Финансы/Настройки) — HQ не
// является просто перекраской старой /admin, это отдельный инструмент.
//
// HQ — рабочий инструмент, а не публичная страница: сознательно НЕ копируем
// маркетинговую вёрстку client/ (шрифты/декор/анимации), только чистая
// структура с минимумом визуального шума (п.8 задания).
const { hqRootPath } = require('../services/hq/basePath');

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Stage 2.1 — clean-root routing: ссылки строятся из linkBasePath ('/hq'
// локально, '' за отдельным поддоменом hq.yaam.su) — см.
// services/hq/basePath.js. Пункт «Обзор» — особый случай (корень раздела,
// без суффикса): '/hq' + '' = '/hq' локально, но '' + '' = '' было бы
// невалидным href (означало бы "текущий документ", не "корень") — поэтому
// использует hqRootPath(), а не голую конкатенацию.
function buildNavItems(linkBasePath) {
  return [
    { key: 'overview', href: hqRootPath(linkBasePath), label: 'Обзор' },
    { key: 'restaurants', href: `${linkBasePath}/restaurants`, label: 'Рестораны' },
    { key: 'finance', href: `${linkBasePath}/finance`, label: 'Финансы' },
    { key: 'settings', href: `${linkBasePath}/settings`, label: 'Настройки' },
  ];
}

// active — ключ текущего раздела (для подсветки и aria-current).
// csrfToken — нужен форме логаута (POST-запрос, требует CSRF, см.
// server/services/hq/csrf.js).
// linkBasePath — см. services/hq/basePath.js; по умолчанию '/hq'
// (сохраняет локальное поведение Stage 2 без единой правки вызывающего кода).
function layout({ title, active, body, csrfToken, linkBasePath = '/hq' }) {
  const navItems = buildNavItems(linkBasePath);
  const logoutAction = `${linkBasePath}/logout`;
  const navHtml = navItems.map((item) => {
    const isActive = item.key === active;
    return `<a href="${item.href}" class="${isActive ? 'on' : ''}"${isActive ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`;
  }).join('\n  ');

  const mobileNavHtml = navItems.map((item) => {
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

  /* Формы — общие для всего HQ (создание/правка ресторана, фильтры,
     настройки безопасности из Stage 3) — раньше жили только инлайново на
     странице логина; вынесено сюда один раз, чтобы не дублировать в каждом
     новом экране Stage 4. */
  label{display:block;font-size:12px;color:var(--txt2);font-weight:700;margin:14px 0 6px;text-transform:uppercase}
  label:first-child{margin-top:0}
  input,select,textarea{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--bord);background:rgba(255,255,255,.05);color:var(--txt);font-size:15px;font-family:inherit}
  textarea{resize:vertical;min-height:70px}
  input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
  button{background:var(--amber);color:#3a1c00;border:none;border-radius:10px;padding:11px 18px;font-weight:800;cursor:pointer;font-size:14px}
  button.ghost{background:rgba(255,255,255,.08);color:var(--txt)}
  button.danger{background:#c0303c;color:#fff}
  button:disabled{opacity:.6;cursor:default}
  a.btn{display:inline-block;background:var(--amber);color:#3a1c00;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}
  a.btn.ghost{background:rgba(255,255,255,.08);color:var(--txt)}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  .row>*{flex:1;min-width:160px}
  .error{margin-top:12px;color:var(--danger);font-size:13px}
  .notice{margin-top:12px;color:var(--ok);font-size:13px}

  /* Вкладки страницы ресторана (Обзор/Заказы/Оценки/Статистика/Настройки). */
  .tabs{display:flex;gap:4px;border-bottom:1px solid var(--bord);margin-bottom:20px;overflow-x:auto}
  .tabs a{padding:10px 14px;color:var(--txt2);text-decoration:none;font-weight:600;font-size:14px;white-space:nowrap;border-bottom:2px solid transparent;min-height:44px;display:flex;align-items:center}
  .tabs a.on{color:var(--amber);border-bottom-color:var(--amber)}

  /* Пагинация — простая, без произвольного page size. */
  .pagination{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:16px;flex-wrap:wrap}
  .pagination a,.pagination span{padding:8px 12px;border-radius:8px;font-size:13px;text-decoration:none;color:var(--txt2);min-height:36px;display:flex;align-items:center}
  .pagination a{border:1px solid var(--bord)}
  .pagination .current{background:var(--amber);color:#3a1c00;font-weight:700}

  /* Простой CSS-столбчатый график распределения заказов по дням —
     без библиотек, без декоративных случайных данных (задание, раздел 9). */
  .chart{display:flex;align-items:flex-end;gap:3px;height:110px;margin:26px 0 10px;padding:0 2px}
  .chart-bar{flex:1;background:var(--amber);border-radius:3px 3px 0 0;min-height:2px;position:relative}
  .chart-bar.zero{background:var(--bord)}
  .chart-bar .chart-label{position:absolute;bottom:-20px;left:0;right:0;text-align:center;font-size:9px;color:var(--txt2);white-space:nowrap}
  .chart-bar .chart-value{position:absolute;top:-18px;left:0;right:0;text-align:center;font-size:10px;color:var(--txt2)}

  /* Фильтры/поиск над списками. */
  .filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end}
  .filters .field{display:flex;flex-direction:column;gap:4px;min-width:140px}
  .filters label{margin:0;font-size:11px}
  .filters input,.filters select{padding:9px 10px;font-size:13px}
  .filters button{padding:9px 16px;font-size:13px}

  /* YAAM HQ Stage 5B — сетка фотографий (ресторан/блюдо). Один и тот же
     набор классов для обоих разделов (hq/photosViews.js) — минимализм:
     карточка = превью + primary-бейдж + компактные действия, без лишней
     хромированности "CMS-таблицы файлов". */
  .photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:14px}
  .photo-card{position:relative;border:1px solid var(--bord);border-radius:12px;overflow:hidden;background:rgba(255,255,255,.03)}
  .photo-card.archived{opacity:.5}
  .photo-card img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:rgba(255,255,255,.04)}
  .photo-badge{position:absolute;top:8px;left:8px;background:var(--amber);color:#3a1c00;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;letter-spacing:.02em;text-transform:uppercase}
  .photo-body{padding:10px}
  .photo-alt-form{display:flex;gap:6px;margin-top:8px}
  .photo-alt-form input{flex:1;padding:7px 9px;font-size:12px}
  .photo-alt-form button{padding:7px 10px;font-size:12px}
  .photo-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .photo-actions form{margin:0}
  .photo-actions button{padding:7px 10px;font-size:12px}
  .photo-upload{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:14px}
  .photo-upload .field{flex:1;min-width:180px}
  .photo-meta{font-size:12px;color:var(--txt2);margin-top:10px}
  details.photo-archived summary{cursor:pointer;font-size:13px;color:var(--txt2);font-weight:600;margin-top:16px}

  /* Мобильный responsive-table: превращает строки в компактные карточки без
     дублирования разметки (задание, раздел 14 — "на mobile строки заказов
     превращать в компактные карточки"). Каждый <td> несёт data-label,
     показанный через ::before только в узком viewport. */
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

    table.responsive{border:0}
    table.responsive thead{display:none}
    table.responsive tr{display:block;background:var(--panel);border:1px solid var(--bord);border-radius:12px;margin-bottom:10px;padding:10px 12px}
    table.responsive td{display:flex;justify-content:space-between;align-items:center;gap:10px;border:0;padding:7px 0;font-size:13px;text-align:right}
    table.responsive td::before{content:attr(data-label);color:var(--txt2);font-weight:600;font-size:11px;text-transform:uppercase;text-align:left}
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
    <form class="logout-form" method="post" action="${logoutAction}">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <button type="submit" class="logout-btn">Выйти</button>
    </form>
  </aside>
  <main>${body}</main>
</div>
<div class="mobile-top">
  <span class="brand">YAAM HQ</span>
  <form class="logout-form" method="post" action="${logoutAction}">
    <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
    <button type="submit" class="logout-btn">Выйти</button>
  </form>
</div>
<nav class="mobile-nav">
  ${mobileNavHtml}
</nav>
<script src="${linkBasePath}/static/hq.js" defer></script>
</body>
</html>`;
}

module.exports = { layout, esc, buildNavItems };
