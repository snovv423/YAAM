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

// Тестовая маркировка HQ (HQ_ENV_LABEL) — намеренно читает process.env
// НАПРЯМУЮ, а не принимает параметром: layout() вызывается из ~50 мест
// (routes/hq/pages.js, restaurants.js, settlements.js, payouts.js), и
// страница логина (routes/hq/auth.js) вообще не использует layout() —
// протаскивать один и тот же флаг через сигнатуры всех этих функций было
// бы как раз тем, что легко забыть на одной из страниц. Прямое чтение
// здесь гарантирует "несъёмность" по построению: НИ ОДНА страница HQ не
// может случайно забыть его вывести, потому что ни одна не решает это сама.
// Production никогда не задаёт HQ_ENV_LABEL — значит там renderTestBanner()
// всегда возвращает '', полностью безобидно (fail-safe в сторону "баннера
// нет", не "баннер показан там, где не должен").
const TEST_BANNER_HEIGHT_PX = 32;

function renderTestBanner() {
  const label = process.env.HQ_ENV_LABEL;
  if (!label) return '';
  // Текст — фиксированный, НЕ зависит от значения переменной (значение —
  // только boolean-триггер показа); само значение допускается небольшой
  // экранированной подсказкой в скобках, чтобы отличать несколько тестовых
  // окружений друг от друга, если их когда-нибудь станет больше одного.
  return `<div class="hq-test-banner" role="alert">ТЕСТОВЫЙ РЕЖИМ — ДАННЫЕ И ОПЕРАЦИИ НЕ РЕАЛЬНЫЕ (${esc(label)})</div>`;
}

// CSS, общий для layout() (авторизованные страницы) и routes/hq/auth.js
// (страница логина, свой отдельный HTML) — единственное место, определяющее
// геометрию баннера, чтобы оба шаблона не могли разойтись в отступах.
function testBannerStyle() {
  return `.hq-test-banner{position:fixed;top:0;left:0;right:0;z-index:5;height:${TEST_BANNER_HEIGHT_PX}px;line-height:${TEST_BANNER_HEIGHT_PX}px;background:#c0303c;color:#fff;font-weight:800;font-size:11px;letter-spacing:.02em;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 12px}`;
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
    // «Выплаты» — НЕ пункт основной навигации (docs/HQ-PRODUCT-SPEC.md,
    // раздел «Финансы → Реестр выплат»): реестр это дочерний экран финансов,
    // открываемый кнопкой «Все выплаты». Маршрут /payouts, прямые ссылки и
    // карточки выплат продолжают работать без изменений — убран только пункт
    // меню. active:'payouts' на этих страницах остаётся валидным ключом,
    // просто ни один пункт им больше не подсвечивается.
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

  // HQ_ENV_LABEL — см. renderTestBanner() выше. bannerOffset сдвигает ВСЕ
  // остальные фиксированные элементы (мобильный header/нижняя навигация)
  // и обычный поток (desktop sidebar+main) ровно на высоту баннера — та же
  // величина применяется везде ниже, поэтому относительные отступы между
  // элементами не меняются, просто всё целиком сдвигается вниз. Когда
  // баннера нет (production), bannerOffset=0 — ни одна из этих строк не
  // производит видимого эффекта.
  const testBannerHtml = renderTestBanner();
  const bannerOffset = testBannerHtml ? TEST_BANNER_HEIGHT_PX : 0;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>${esc(title)} — YAAM HQ</title>
<style>
  :root{--bg:#0A2417;--panel:#123322;--txt:#F1F7F2;--txt2:rgba(241,247,242,.62);--amber:#FF9A2E;--bord:rgba(255,255,255,.14);--danger:#FF7059;--ok:#34D38C;--terminal-bg:#1A1B1E;--terminal-time:rgba(255,154,46,.72)}
  *{box-sizing:border-box}
  ${testBannerHtml ? testBannerStyle() : ''}
  body{font-family:-apple-system,Manrope,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:${bannerOffset}px 0 0;min-height:100vh}
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

  /* HQ «Обзор» — переключатель периода (docs/HQ-PRODUCT-SPEC.md). Обычные
     ссылки (?period=...), не JS — работает без скриптов, полная перезагрузка
     страницы приемлема для внутреннего инструмента (тот же принцип, что и
     остальная HQ-навигация). */
  .period-switch{display:flex;gap:6px;margin-bottom:16px}
  .period-switch a{padding:8px 16px;border-radius:999px;font-size:13px;font-weight:700;color:var(--txt2);text-decoration:none;border:1px solid var(--bord)}
  .period-switch a.on{background:var(--amber);color:#3a1c00;border-color:var(--amber)}
  .metric-grid.compact{grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
  .metric-grid.compact .metric{padding:14px}
  .metric-grid.compact .metric .value{font-size:22px}

  /* «Центр событий» (задание, раздел 3-4) — тёмно-серый терминал, ОТДЕЛЬНЫЙ
     от зелёной палитры --panel всего остального HQ (задание: "тёмно-серый
     фон", не тот же тон, что у обычных панелей). Моноширинный шрифт,
     минимум визуального шума: без рамок/разделителей/иконок/бейджей внутри. */
  .event-center{background:var(--terminal-bg);border-radius:16px;padding:14px 16px;margin-bottom:20px}
  .event-center-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;color:var(--txt2);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px}
  .event-expand-btn{background:rgba(255,255,255,.06);color:var(--txt2);border:1px solid var(--bord);border-radius:8px;height:26px;line-height:1;cursor:pointer;font-size:11px;font-weight:700;padding:0 10px}
  .event-expand-btn:hover{color:var(--txt)}
  .event-center-scroll{max-height:220px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-overflow-scrolling:touch}
  .event-row{padding:9px 0}
  .event-row+.event-row{border-top:none}
  .event-time{color:var(--terminal-time);font-size:12px}
  .event-restaurant{color:#fff;font-weight:700;font-size:13px;margin-top:2px}
  .event-message{color:var(--txt2);font-size:13px;margin-top:2px;white-space:pre-line;line-height:1.4}
  .event-empty{color:var(--txt2);font-size:13px;text-align:center;padding:18px 0}
  .event-center-footer{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
  .event-center-footer a{color:var(--txt2);font-size:12px;text-decoration:none;padding:6px 4px}
  .event-center-footer a:hover{color:var(--txt)}
  .event-clear-btn{background:transparent;color:var(--txt2);border:none;padding:6px 4px;font-size:12px;font-weight:600;cursor:pointer}
  .event-clear-btn:hover{color:var(--txt)}

  /* Полноэкранное раскрытие (задание, раздел 4 — "почти полноэкранный режим,
     продолжает поддерживать прокрутку") — переключается hq.js добавлением
     этого класса, чистый CSS без JS-анимации/библиотек. */
  .event-center.expanded{position:fixed;inset:16px;z-index:30;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .event-center.expanded .event-center-scroll{flex:1;max-height:none}

  /* «История» — та же терминальная лента, без ограничения высоты (задание,
     раздел 6: "поддерживает нормальную прокрутку страницы"). */
  .event-center-full .event-center-scroll{max-height:none}

  /* ------------------------------------------------------------------
     Раздел «Рестораны» (docs/HQ-PRODUCT-SPEC.md). Компактные карточки
     вместо технической таблицы; кнопки маленькие (.compact) — крупные
     кнопки и перегруженные панели спецификацией запрещены.
     ------------------------------------------------------------------ */
  .btn.compact,button.compact{padding:8px 14px;font-size:13px}
  a.btn.compact{padding:8px 14px;font-size:13px}
  .add-restaurant-row{display:flex;justify-content:center;margin-bottom:18px}
  .candidates-link-row{display:flex;justify-content:flex-end;margin-bottom:8px}
  .rest-list{display:flex;flex-direction:column;gap:10px}
  .rest-card{background:var(--panel);border:1px solid var(--bord);border-radius:14px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .rest-card-main{min-width:0;flex:1}
  .rest-card-title{font-weight:700;font-size:15px}
  .rest-card-cities{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
  .city-chip{display:inline-block;background:rgba(255,255,255,.07);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--txt2)}
  .city-chip.muted{opacity:.7}
  .rest-card-meta{color:var(--txt2);font-size:12px;margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .rest-header{margin-bottom:14px}
  .rest-header h1{margin:0 0 6px}
  .rest-header-meta{color:var(--txt2);font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .panel-title{font-weight:700;margin-bottom:14px}

  /* Обзор ресторана — блок «Заказы»: две равные части, цифры ПОД подписями,
     без внутренних рамок и разделителей (спецификация). */
  .orders-split{display:flex}
  .orders-part{flex:1}
  .orders-label{color:var(--txt2);font-size:12px;text-transform:uppercase;letter-spacing:.02em}
  .orders-value{font-size:28px;font-weight:800;line-height:1.15;margin-top:4px}
  .payout-block .payout-line{font-weight:700;font-size:15px}
  .payout-block .payout-amount{font-size:24px;font-weight:800;margin-top:4px}
  .payout-block .payout-sub{color:var(--txt2);font-size:13px;margin-top:4px}

  @media (max-width: 420px){
    .rest-card{flex-direction:column;align-items:stretch}
    .rest-card .btn.compact{text-align:center}
  }

  /* ------------------------------------------------------------------
     Меню ресторана (docs/HQ-PRODUCT-SPEC.md, разделы «Меню»/«Категории»/
     «Компактные карточки блюд»). Категории — аккордеоны на <details>,
     блюда — компактные строки, вся строка кликабельна.
     ------------------------------------------------------------------ */
  .menu-toolbar{display:flex;gap:8px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}
  .add-cat summary{list-style:none;display:inline-block;cursor:pointer}
  .add-cat summary::-webkit-details-marker{display:none}
  .add-cat[open] summary{margin-bottom:10px}
  .add-cat-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .add-cat-form input{width:auto;min-width:180px;flex:1;padding:8px 12px;font-size:13px}

  .cat-list{display:flex;flex-direction:column;gap:10px}
  .cat-block{background:var(--panel);border:1px solid var(--bord);border-radius:14px;overflow:hidden}
  .cat-summary{list-style:none;cursor:pointer;padding:14px 16px;display:flex;align-items:center;gap:10px}
  .cat-summary::-webkit-details-marker{display:none}
  .cat-titles{display:flex;flex-direction:column;min-width:0}
  .cat-name{font-weight:700;font-size:15px}
  .cat-count{color:var(--txt2);font-size:12px;margin-top:2px}
  .cat-body{padding:0 16px 14px}
  .cat-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}

  /* Handle перетаскивания — рисуется CSS (две колонки точек), без символов
     и иконочных шрифтов. Отдельный маленький handle, а не вся строка:
     иначе на мобильном обычная прокрутка переставляла бы элементы. */
  /* Точки рисуются в content-box 16x20, а кликабельная/тапабельная площадь
     увеличена padding'ом до 32x44 (минимальный комфортный размер для пальца);
     отрицательные margin'ы возвращают элементу прежнее место в потоке, так
     что вёрстка строки не меняется. */
  .drag-handle{flex:0 0 auto;box-sizing:content-box;width:16px;height:20px;
    padding:12px 8px;margin:-12px -8px;cursor:grab;touch-action:none;
    background-image:radial-gradient(circle,var(--txt2) 1px,transparent 1px);
    background-size:5px 5px;background-position:2px 3px;background-repeat:repeat;
    background-origin:content-box;background-clip:content-box;opacity:.5}
  .drag-handle:active{cursor:grabbing}
  .drag-handle:hover{opacity:.85}
  /* Перетаскиваемая строка приподнята и следует за указателем через
     transform; соседи при этом переставляются в потоке. Никаких transition
     на transform у .dragging быть не должно — иначе строка тянется за
     пальцем с задержкой. */
  .dragging{position:relative;z-index:5;opacity:.9;cursor:grabbing;
    box-shadow:0 14px 34px rgba(0,0,0,.45);border-radius:12px;
    background:var(--panel);will-change:transform}
  /* Во время жеста ничего не выделяется и ссылка блюда не перехватывает
     указатель — иначе браузер начинает «тащить» текст или ссылку. */
  html.is-reordering{user-select:none;-webkit-user-select:none}
  html.is-reordering .dish-link,html.is-reordering .cat-summary{pointer-events:none}
  .reorder-saving{opacity:.92}
  .reorder-failed{outline:2px solid rgba(220,80,80,.75);outline-offset:4px;border-radius:12px}

  .dish-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
  /* scroll-margin-top — для НАТИВНОГО перехода по якорю #dish-N (возврат из
     карточки блюда без JS): иначе строка встаёт вплотную под фиксированную
     мобильную шапку. Восстановление через hq.js считает смещение само и от
     этого правила не зависит. */
  .dish-row{display:flex;align-items:center;gap:8px;padding:6px 0;scroll-margin-top:88px;border-radius:10px}
  /* Подсветка строки, из которой владелец только что вернулся: строки меню
     похожи друг на друга, и без неё непонятно, какое блюдо редактировалось.
     Гаснет сама, класс снимается по animationend (hq.js). */
  .dish-row-focus{animation:dish-row-focus 2.4s ease-out 1}
  @keyframes dish-row-focus{
    0%,45%{background:rgba(255,154,46,.20);box-shadow:0 0 0 6px rgba(255,154,46,.20)}
    100%{background:transparent;box-shadow:0 0 0 6px rgba(255,154,46,0)}
  }
  @media (prefers-reduced-motion: reduce){ .dish-row-focus{animation-duration:.01s} }
  .dish-link{flex:1;min-width:0;display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit;padding:4px 0}
  .dish-link.static{cursor:default}
  .dish-thumb{flex:0 0 auto;width:48px;height:48px;border-radius:8px;object-fit:cover;background:rgba(255,255,255,.05)}
  .dish-thumb.placeholder{background:rgba(255,255,255,.05)}
  .dish-main{flex:1;min-width:0;display:flex;flex-direction:column}
  .dish-name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dish-meta{color:var(--txt2);font-size:12px;margin-top:2px}
  .dish-photo-count{flex:0 0 auto;color:var(--txt2);font-size:12px;white-space:nowrap}
  /* Шеврон — CSS-треугольник из границ, не типографский символ. */
  .dish-chevron{flex:0 0 auto;width:7px;height:7px;border-right:2px solid var(--txt2);border-top:2px solid var(--txt2);transform:rotate(45deg);opacity:.6}
  .archive-row{gap:10px;flex-wrap:wrap}
  .restore-form{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .restore-form select{width:auto;min-width:130px;padding:7px 9px;font-size:12px}
  .item-status{color:var(--txt2);font-size:13px;margin-bottom:14px}
  .item-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--bord)}
  .item-actions form{margin:0}

  /* Фильтр по датам (заказы, свой период статистики). На узком экране
     кнопка уходит на свою строку и не накладывается на поля дат
     (docs/HQ-PRODUCT-SPEC.md, раздел «Заказы ресторана»). */
  .date-filter{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}
  .date-filter .field{display:flex;flex-direction:column;gap:4px;min-width:0}
  .date-filter label{margin:0;font-size:11px}
  .date-filter input{padding:9px 10px;font-size:13px}
  @media (max-width: 520px){
    .date-filter{grid-template-columns:1fr 1fr}
    .date-filter button{grid-column:1 / -1;justify-self:start}
  }

  /* Настройки ресторана: выбор городов из поддерживаемого списка YAAM
     (docs/HQ-PRODUCT-SPEC.md — ввод одной строкой через запятую запрещён),
     блок управления и «Сохранить», не прижатая к границам контейнера. */
  .city-checks{display:flex;flex-wrap:wrap;gap:8px}
  .city-check{display:inline-flex;align-items:center;gap:6px;margin:0;padding:7px 12px;border:1px solid var(--bord);border-radius:999px;cursor:pointer;text-transform:none;font-size:13px;font-weight:600;color:var(--txt2)}
  .city-check input{width:auto;margin:0;accent-color:var(--amber)}
  .city-check:has(input:checked){border-color:var(--amber);color:var(--txt)}
  .save-row{margin-top:20px}
  .manage-actions{display:flex;gap:8px;flex-wrap:wrap}
  .manage-actions form{margin:0}
  .connect-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px;font-weight:700;letter-spacing:.08em;background:rgba(255,255,255,.06);border-radius:10px;padding:12px 14px;margin-bottom:14px;text-align:center;user-select:all}

  /* ------------------------------------------------------------------
     Финансы: «Статус выплат» и реестр выплат (docs/HQ-PRODUCT-SPEC.md).
     Компактные строки вместо технических таблиц; фирменные цветные
     статусы YAAM без эмодзи.
     ------------------------------------------------------------------ */
  .status-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
  .status-badge.ok{background:rgba(52,211,140,.18);color:var(--ok)}
  .status-badge.warn{background:rgba(255,154,46,.18);color:var(--amber)}
  .status-badge.danger{background:rgba(255,112,89,.18);color:var(--danger)}
  .status-badge.muted{background:rgba(255,255,255,.08);color:var(--txt2)}

  .panel-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .panel-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .panel-head-actions form{margin:0}

  .payout-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
  .payout-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0}
  .payout-row+.payout-row{border-top:1px solid var(--bord)}
  .payout-row-main{min-width:0;flex:1}
  .payout-row-name{font-weight:600;font-size:14px}
  .payout-row-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:5px}
  .payout-row-amount{font-size:13px;font-weight:700}
  .payout-row-sub{color:var(--txt2);font-size:12px;margin-top:4px}
  .payout-row-actions{display:flex;gap:8px;align-items:center;flex-shrink:0}
  .payout-row-actions form{margin:0}

  .attempt-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
  .attempt-row{padding:11px 0}
  .attempt-row+.attempt-row{border-top:1px solid var(--bord)}
  .attempt-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .attempt-number{font-weight:600;font-size:13px}
  .attempt-error{color:var(--danger);font-size:12px;margin-top:5px}
  .attempt-requisites{margin-top:8px}
  .attempt-requisites summary{cursor:pointer;color:var(--txt2);font-size:12px}
  .attempt-requisites td{font-size:12px;padding:6px 0}

  @media (max-width: 520px){
    .payout-row{flex-direction:column;align-items:stretch}
    .payout-row-actions{justify-content:flex-start}
  }

  /* Формы — общие для всего HQ (создание/правка ресторана, фильтры,
     настройки безопасности из Stage 3) — раньше жили только инлайново на
     странице логина; вынесено сюда один раз, чтобы не дублировать в каждом
     новом экране Stage 4. */
  /* Вертикальный ритм формы задаётся здесь один раз, а не отдельными
     margin у каждого поля: раньше label отбивался от своего input всего на
     6px и визуально «прилипал» к нему, а соседние строки .row стояли
     вплотную. Сейчас связка label->input читается как одна группа (8px
     внутри), а между группами и строками — заметно больший интервал. */
  label{display:block;font-size:12px;color:var(--txt2);font-weight:700;margin:20px 0 8px;text-transform:uppercase}
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
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-top:20px}
  .row>*{flex:1;min-width:160px}
  /* label внутри .row уже отбит самим отступом строки — иначе получалось
     20px (row) + 20px (label) и «дыра» между блоками Вес/Калории и БЖУ. */
  .row label{margin-top:0}
  /* Кнопка сохранения не должна прилипать к последнему полю. */
  .panel>form>button[type=submit]{margin-top:24px}
  /* Возврат на родительский экран. Общий паттерн для detail/edit-страниц HQ
     (renderBackLink) — виден сразу, до заголовка, и не полагается на
     history.back(): цель всегда явный адрес. */
  .detail-back{display:inline-flex;align-items:center;gap:6px;margin-bottom:14px;padding:8px 14px;border-radius:10px;background:rgba(255,255,255,.08);color:var(--txt);text-decoration:none;font-weight:700;font-size:13px;min-height:38px}
  .detail-back:hover{background:rgba(255,255,255,.14)}
  .detail-back:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
  .error{margin-top:12px;color:var(--danger);font-size:13px}
  .notice{margin-top:12px;color:var(--ok);font-size:13px}
  /* Stage 14 — компактный sheet настроек и поля пароля. */
  .panel-title{font-weight:700;margin-bottom:14px}
  .panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}
  .panel-head .panel-title{margin-bottom:0}
  .badge.muted{background:rgba(255,255,255,.08);color:var(--txt2)}
  .hint{color:var(--txt2);font-size:12px;line-height:1.5;margin-top:10px}
  /* «Текст на главной» (HQ «Обзор») — спокойный блок под Центром событий.
     Поля растут по содержимому (hq.js, data-autogrow), поэтому у них нет
     собственной прокрутки и минимальной «ямы» на пол-экрана. */
  .home-text textarea{min-height:0;resize:none;overflow:hidden;line-height:1.5}
  .home-text button[type=submit]{margin-top:18px}
  .home-text-saved{color:var(--ok);font-size:12px;font-weight:700;white-space:nowrap}
  .sheet-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:flex-end;justify-content:center;z-index:60}
  .sheet-backdrop.open{display:flex}
  .sheet{background:var(--panel);border:1px solid var(--bord);border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:520px;max-height:88vh;overflow-y:auto;padding-bottom:calc(20px + env(safe-area-inset-bottom))}
  .sheet-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .sheet-close{background:none;border:none;color:var(--txt2);font-size:26px;line-height:1;padding:0 4px;width:auto;cursor:pointer}
  .pw-field{position:relative;display:flex;align-items:center;gap:8px}
  .pw-field input{flex:1;min-width:0}
  .pw-toggle{background:none;border:1px solid var(--bord);color:var(--txt2);font-size:12px;padding:8px 10px;border-radius:8px;width:auto;white-space:nowrap;cursor:pointer;margin:0}
  @media(min-width:560px){ .sheet-backdrop{align-items:center} .sheet{border-radius:16px} }
  /* Диалог подтверждения необратимых действий (hq/static/hq.js, data-confirm).
     Своя разметка, а не window.confirm: инлайновый onsubmit блокируется CSP,
     а нативный confirm выглядит чужеродно и на мобильном перекрывается
     системным «Заблокировать диалоги этой страницы». */
  .confirm-sheet{max-width:440px}
  .confirm-title{font-weight:800;font-size:16px;margin-bottom:10px}
  .confirm-text{color:var(--txt2);font-size:14px;line-height:1.5}
  .confirm-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap}
  .confirm-actions button{min-height:44px}
  @media(max-width:420px){ .confirm-actions button{flex:1 1 140px} }
  /* Кнопка удаления в архиве — рядом с «Восстановить», а не вместо неё. */
  .archive-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .archive-actions form{margin:0}
  /* На узком экране обе кнопки строки архива получают полноценную площадь
     нажатия (тот же порог 44px, что у вкладок и кнопок диалога выше):
     «Удалить навсегда» необратима, промахнуться по ней пальцем — худший из
     возможных промахов. */
  @media(max-width:560px){ .archive-actions button{min-height:44px} }

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
  .photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-top:14px}
  .photo-grid-dish{grid-template-columns:repeat(3,minmax(0,1fr))}
  .photo-card{position:relative;border:1px solid var(--bord);border-radius:16px;background:rgba(255,255,255,.03);transition:border-color .18s,box-shadow .18s,transform .18s;min-width:0}
  .photo-card:hover{border-color:rgba(255,255,255,.28);transform:translateY(-1px)}
  .photo-card:focus-within{box-shadow:0 0 0 3px rgba(255,154,46,.2)}
  .photo-card.is-primary{border:2px solid var(--amber);box-shadow:0 12px 30px rgba(0,0,0,.18)}
  .photo-open{display:block;width:100%;padding:0;border:0;border-radius:14px 14px 0 0;overflow:hidden;background:#101614;position:relative;color:#fff;text-align:left}
  .photo-open .photo-master-preview{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;object-position:center;background:rgba(255,255,255,.04)}
  .photo-badge{position:absolute;z-index:2;top:9px;left:9px;background:var(--amber);color:#3a1c00;font-size:10px;font-weight:800;padding:5px 9px;border-radius:999px;letter-spacing:.02em;text-transform:uppercase;box-shadow:0 5px 16px rgba(0,0,0,.25)}
  .photo-body{padding:12px}
  .photo-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .photo-actions form{margin:0}
  .photo-actions button{padding:8px 11px;font-size:12px}
  .primary-choice{background:transparent!important;color:var(--amber)!important;border:1px solid rgba(255,154,46,.55)!important}
  .primary-selected{display:inline-flex;align-items:center;font-size:12px;font-weight:750;color:var(--amber);padding:8px 0;white-space:nowrap}
  .photo-section-title{font-weight:700;margin-bottom:6px}
  .photo-meta{font-size:12px;color:var(--txt2);margin-bottom:16px}

  /* Загрузка фотографии. Настоящий <input type="file"> лежит ВНУТРИ плитки и
     сам является её кликабельной поверхностью (см. .upload-tile input ниже):
     системный диалог открывается настоящим действием пользователя прямо по
     контролу, без посредника label[for] и без обрезанного до 1×1 элемента. */
  .visually-hidden{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
  /* Правила ниже задают display:flex у элементов, которые скрываются
     атрибутом hidden. Авторский display перебивает display:none из UA-таблицы,
     поэтому hidden надо восстановить в правах явно — иначе плитка и её
     превью показывались бы одновременно, а «Загрузка…» висела бы всегда. */
  [hidden]{display:none!important}
  .photo-upload{margin-top:22px}
  .upload-row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end}
  .upload-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:128px;height:128px;border-radius:14px;border:1.5px dashed rgba(255,255,255,.28);background:rgba(255,255,255,.035);color:var(--txt2);font-size:12px;font-weight:700;line-height:1.25;text-align:center;cursor:pointer;margin:0;text-transform:none;letter-spacing:0;transition:border-color .18s,background .18s,color .18s}
  .upload-tile:hover{border-color:var(--amber);color:var(--txt);background:rgba(255,154,46,.07)}
  .upload-plus{font-size:30px;font-weight:400;line-height:1;color:var(--amber)}
  /* Сам <input type="file"> и есть кликабельная поверхность плитки: он лежит
     внутри неё, прозрачен и растянут на всю площадь. Так открытие системного
     выбора файла не зависит ни от совпадения id с label[for], ни от того,
     считает ли браузер обрезанный до 1×1 контрол пригодным для активации и
     для нативной валидации required. Ширину/высоту задаёт плитка, поэтому
     менять их в media-запросах по-прежнему достаточно у .upload-tile. */
  .upload-tile{position:relative}
  .upload-tile input[type=file]{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:pointer;font-size:0}
  .upload-tile:focus-within{outline:2px solid var(--amber);outline-offset:2px;border-color:var(--amber)}
  .upload-submit[disabled]{opacity:.45;cursor:not-allowed}
  .upload-selected{display:flex;flex-direction:column;gap:6px;max-width:128px}
  .upload-thumb{position:relative;width:128px;height:128px;border-radius:14px;overflow:hidden;border:1px solid var(--bord);background:#101614}
  .upload-thumb img{display:block;width:100%;height:100%;object-fit:cover}
  .upload-clear{position:absolute;top:6px;right:6px;width:26px;height:26px;padding:0;border-radius:50%;border:0;background:rgba(8,22,16,.82)!important;color:#fff!important;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:none}
  .upload-clear:hover{background:rgba(200,60,60,.9)!important}
  .upload-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,22,16,.72);font-size:12px;font-weight:700;color:#fff}
  .upload-filename{font-size:11px;color:var(--txt2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .upload-submit{align-self:flex-end}
  .upload-error{display:none;margin:12px 0 0;padding:10px 12px;border-radius:10px;background:rgba(220,80,80,.12);border:1px solid rgba(220,80,80,.4);color:#ffb4b4;font-size:13px}
  .upload-error.is-visible{display:block}
  .photo-editor{display:none;grid-column:1/-1;margin:0 -1px -1px;padding:20px;border-top:1px solid var(--bord);background:rgba(5,18,12,.55);border-radius:0 0 15px 15px}
  .photo-editor.is-open{display:block}
  /* С раскрытым редактором карточка занимает всю ширину сетки. Превью при
     этом остаётся компактным, а действия встают рядом с ним — иначе справа
     от фотографии оставалась пустая полоса во всю ширину панели. */
  .photo-card:has(.photo-editor.is-open){grid-column:1/-1;display:grid;grid-template-columns:280px minmax(0,1fr);align-items:start}
  .photo-card:has(.photo-editor.is-open)>.photo-open{max-width:280px;border-radius:14px 0 0 0}
  .photo-card:has(.photo-editor.is-open)>.photo-editor{grid-column:1/-1}
  .photo-editor-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px}
  .photo-editor-heading strong{display:block;font-size:18px}.photo-editor-heading span{display:block;color:var(--txt2);font-size:12px;margin-top:4px}
  .crop-preset-tabs{display:flex;gap:8px;margin-bottom:18px;padding:4px;background:rgba(255,255,255,.045);border-radius:12px;width:max-content;max-width:100%}
  .crop-preset-tabs button{background:transparent;color:var(--txt2);box-shadow:none;padding:10px 14px;font-size:13px}
  .crop-preset-tabs button span{opacity:.65;margin-left:4px}.crop-preset-tabs button.is-active{background:var(--amber);color:#3a1c00}
  .rotation-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 18px}.rotation-controls>span{font-size:12px;color:var(--txt2)}.rotation-controls strong{color:var(--txt)}
  .rotation-controls button{min-height:40px}
  .crop-workspace{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:22px;align-items:start}
  .crop-form{display:none}.crop-form.is-active{display:block}
  .crop-hint{font-size:12px;color:var(--txt2);margin-top:10px}
  .crop-stage{display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(0,0,0,.58);border:1px solid rgba(255,255,255,.09);border-radius:14px;min-height:330px;box-shadow:inset 0 0 50px rgba(0,0,0,.4)}
  /* box-shadow:0 0 0 999px rgba(0,0,0,.32) здесь раньше рисовал «подсветку»
     кадра. Тень со spread 999px не обрезается ничем на пути к корню, поэтому
     на странице появлялась широкая полупрозрачная тёмная полоса через всю
     вёрстку, включая боковое меню. Редактор — обычная inline-секция, никакого
     затемнения страницы у него быть не должно; рамка кадра задаётся border. */
  /* max-height:440px здесь раньше молча ломал сам смысл пресета: у кадра 1:1
     при ширине ~530px высота обрезалась до 440, и «квадрат» на деле имел
     пропорции 1.2. Владелец кадрировал по одной рамке, а сайт показывал
     другую. Высоту теперь диктует aspect-ratio, а разумный предел задаётся
     шириной — для 7:3 её ограничивать не нужно (высота и так втрое меньше). */
  .crop-viewport{position:relative;overflow:hidden;background:#111;touch-action:none;cursor:grab;border:2px solid rgba(255,255,255,.92);border-radius:8px;user-select:none;width:100%}
  .crop-viewport:active{cursor:grabbing}
  .crop-menu_card{aspect-ratio:7/3}
  .crop-dish_detail{aspect-ratio:1/1;max-width:min(100%,420px)}
  /* transform-origin ОБЯЗАН быть 0 0: paint() в static/hq.js считает matrix()
     от левого верхнего угла изображения. При transform-origin:center (было)
     0° работал случайно — там matrix чисто трансляционная и origin неважен, —
     а 90/180/270 уводили картинку целиком за пределы overflow:hidden кадра,
     и пользователь видел чёрный прямоугольник вместо фотографии. */
  .crop-viewport img{position:absolute;max-width:none!important;max-height:none!important;aspect-ratio:auto!important;object-fit:fill!important;pointer-events:none;transform-origin:0 0}
  .crop-guide{position:absolute;inset:0;pointer-events:none;background:linear-gradient(to right,transparent 33.1%,rgba(255,255,255,.35) 33.3%,transparent 33.6%,transparent 66.3%,rgba(255,255,255,.35) 66.6%,transparent 66.9%),linear-gradient(to bottom,transparent 33.1%,rgba(255,255,255,.35) 33.3%,transparent 33.6%,transparent 66.3%,rgba(255,255,255,.35) 66.6%,transparent 66.9%)}
  .crop-controls{display:flex;gap:10px;align-items:center;margin-top:16px}.crop-controls button{flex:0 0 auto;min-height:40px}
  .crop-zoom{display:flex;align-items:center;gap:10px;margin:16px 0 0;font-size:12px;text-transform:none;letter-spacing:0}.crop-zoom input{margin:0;padding:0;min-width:80px;width:100%}
  .crop-preview-heading{font-size:12px;font-weight:750;margin-bottom:12px}
  /* Предпросмотр показывается только для активного пресета: верхний
     переключатель — единственное место выбора формата, второй блок раньше
     дублировал его и перегружал экран. Скрытая карточка остаётся в DOM, её
     crop-данные не теряются при переключении вкладок. */
  .crop-preview-card{display:none}.crop-preview-card.is-active{display:block}
  .crop-preview{position:relative;overflow:hidden;border-radius:10px;background:#111;border:1px solid var(--bord)}.crop-preview img{position:absolute;max-width:none!important;max-height:none!important;aspect-ratio:auto!important;object-fit:fill!important;transform-origin:0 0}
  @media(max-width:900px){.photo-grid-dish{grid-template-columns:repeat(2,minmax(0,1fr))}.crop-workspace{grid-template-columns:1fr}.crop-live-previews{max-width:260px}}
  @media(max-width:620px){.photo-grid-dish{grid-template-columns:1fr 1fr;gap:10px}.photo-card:has(.photo-editor.is-open){grid-template-columns:1fr}.photo-card:has(.photo-editor.is-open)>.photo-open{max-width:none}.photo-editor{padding:14px}.photo-editor-heading{align-items:center}.crop-stage{padding:14px;min-height:220px}.crop-preset-tabs{display:grid;grid-template-columns:1fr 1fr;width:100%}.crop-preset-tabs button{padding:10px 8px}.rotation-controls>span{flex:1 1 100%;order:-1}.rotation-controls button{flex:1;min-height:44px;padding:9px 6px}.crop-controls{flex-wrap:wrap}.crop-controls button{flex:1 1 auto;min-height:44px}.crop-live-previews{max-width:none}.dish-photo-count{font-size:11px}.upload-row{gap:12px}.upload-tile,.upload-thumb{width:112px;height:112px}.upload-selected{max-width:112px}.upload-submit{min-height:44px}}

  /* Мобильный responsive-table: превращает строки в компактные карточки без
     дублирования разметки (задание, раздел 14 — "на mobile строки заказов
     превращать в компактные карточки"). Каждый <td> несёт data-label,
     показанный через ::before только в узком viewport. */
  @media (max-width: 760px){
    .side{display:none}
    main{padding:76px 16px 90px}
    .mobile-top{display:flex;position:fixed;top:${bannerOffset}px;left:0;right:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--bord);align-items:center;justify-content:space-between;padding:14px 16px}
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
  /* Страховка для восстановленной Chrome-вкладки: hq.js сверяет режим с
     фактической шириной при первом показе, не дожидаясь ручного resize. */
  html.hq-wide .side{display:flex}
  html.hq-wide main{padding:28px 24px 100px}
  html.hq-wide .mobile-top,html.hq-wide .mobile-nav{display:none}
  html.hq-narrow .side{display:none}
</style>
</head>
<body>
${testBannerHtml}
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

// Переиспользуемая навигация «назад» для detail/edit-страниц HQ.
//
// Именно ссылка на явный адрес, а не history.back(): на detail-страницу
// попадают и по прямому URL, и после редиректа формы (POST -> 303 -> GET), и
// из письма — в этих случаях «назад» браузера уводит куда угодно, только не
// на родительский экран. Ссылка ставится ПЕРЕД заголовком, поэтому видна
// сразу при открытии страницы, без прокрутки.
function renderBackLink({ href, label = 'Назад' }) {
  return `<a class="detail-back" href="${esc(href)}"><span aria-hidden="true">←</span> ${esc(label)}</a>`;
}

module.exports = {
  layout, esc, buildNavItems, renderBackLink, renderTestBanner, testBannerStyle, TEST_BANNER_HEIGHT_PX,
};
