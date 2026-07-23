# YAAM No-Emoji Remediation Inventory

Статус: **CLOSED — remediation и regression guard завершены**.

Дата исходного scan и remediation: 2026-07-23. Правило определяется в
`CLAUDE.md` и `AGENTS.md`.

## Метод

KODAWARI audit первоначально сообщил о 56 строках в HTML/JS. Повторный scan
диапазонов Unicode emoji/symbols по HTML/JS/CSS нашёл 58 строк: те же 56 плюс
две CSS pseudo-element строки с `🖼️`. Контекстный scan перед реализацией
дополнительно нашёл `↻` в pull-to-refresh подписи, который не входил в прежний
диапазонный regexp. Итоговый baseline: 59 уникальных source lines, 54
нарушения.

Категории:

- `DECORATIVE_EMOJI` — декоративный цветной emoji;
- `FUNCTIONAL_ICON` — emoji выполняет функцию иконки;
- `UNICODE_TEXT_SYMBOL` — допустимый типографический символ;
- `TEST_FIXTURE` — только тестовые данные, не пользовательский UI;
- `NON_USER_VISIBLE` — не отображается пользователю.

Допустимые символы: `←`, `→`, `✓`, `★`, `+`. Колонка «Финальный статус»
фиксирует результат каждой записи: `FIXED` для устранённого нарушения,
`ALLOWED` для обоснованной типографики. Координаты строк относятся к исходному
snapshot до remediation и сохранены для трассируемости.

## Findings

| Файл:строка | Символ | Где отображается | Категория | Финальный статус | Предлагаемая замена | UX-риск | Необходимый тест |
|---|---|---|---|---|---|---|---|
| `client/index.html:38` | `↻` | pull-to-refresh подпись | FUNCTIONAL_ICON | FIXED | оставить понятный текст «Обновление…» | none | mobile home screenshot |
| `client/css/style.css:225` | `🖼️` | placeholder карточки без фото | DECORATIVE_EMOJI | FIXED | CSS/SVG image placeholder | low: изменится fallback | screenshot no-photo card |
| `client/css/style.css:228` | `🖼️` | hero placeholder без фото | DECORATIVE_EMOJI | FIXED | CSS/SVG image placeholder | low: изменится fallback | screenshot no-photo hero |
| `client/index.html:105` | `🛡️` | trust/payment protection block | FUNCTIONAL_ICON | FIXED | shield SVG из единого набора | medium: важный trust cue | mobile checkout screenshot |
| `client/index.html:145` | `🍽️` | начальная status icon | FUNCTIONAL_ICON | FIXED | neutral order/status SVG | medium: status recognition | status screen visual test |
| `client/js/app.js:153` | `🍽️` | restaurant fallback model | DECORATIVE_EMOJI | FIXED | neutral restaurant SVG/CSS | low: fallback only | no-image restaurant card |
| `client/js/app.js:161` | `🍽️` | menu item fallback model | DECORATIVE_EMOJI | FIXED | neutral dish SVG/CSS | low: fallback only | no-image dish card |
| `client/js/app.js:193` | `★` | restaurant rating chip | UNICODE_TEXT_SYMBOL | ALLOWED | keep `★` | none | rating chip regression |
| `client/js/app.js:220` | `🌙` | “Город спит” empty state | DECORATIVE_EMOJI | FIXED | moon/night SVG or CSS | low: empty-state mood | closed-city screenshot |
| `client/js/app.js:320` | `📋 👨‍🍳 🛵 ✅` | delivery status steps | FUNCTIONAL_ICON | FIXED | order/chef/courier/check SVG set | high: status comprehension | full delivery status walk |
| `client/js/app.js:326` | `📋 👨‍🍳 ✅` | pickup status steps | FUNCTIONAL_ICON | FIXED | order/chef/check SVG set | high: status comprehension | full pickup status walk |
| `client/js/app.js:355` | `★` | rating buttons | UNICODE_TEXT_SYMBOL | ALLOWED | keep `★` | none | keyboard/tap rating test |
| `client/js/app.js:371` | `✓` | completed progress step | UNICODE_TEXT_SYMBOL | ALLOWED | keep `✓` | none | progress transition test |
| `client/js/app.js:421` | `★` | restaurant rating meta | UNICODE_TEXT_SYMBOL | ALLOWED | keep `★` | none | rating meta regression |
| `client/js/app.js:421` | `🕐` | restaurant hours meta | FUNCTIONAL_ICON | FIXED | clock SVG or text label | low: compact metadata | restaurant header screenshot |
| `client/js/app.js:423` | `★` | mobile sticky rating | UNICODE_TEXT_SYMBOL | ALLOWED | keep `★` | none | sticky bar regression |
| `client/js/app.js:1195` | `⏳` | waiting status icon | FUNCTIONAL_ICON | FIXED | hourglass/progress SVG/CSS | medium: waiting feedback | timer/status screenshot |
| `client/js/app.js:1519` | `💳` | payment status icon | FUNCTIONAL_ICON | FIXED | card/payment SVG | high: payment context | payment screen screenshot |
| `client/js/app.js:1616` | `⏳` | pending/wait status icon | FUNCTIONAL_ICON | FIXED | progress SVG/CSS | medium: waiting feedback | pending restore test |
| `client/js/app.js:1868` | `✓` | selected vote button | UNICODE_TEXT_SYMBOL | ALLOWED | keep `✓` | none | vote state regression |
| `client/js/data.js:40` | `🍢` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:41` | `🥩` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:42` | `🍗` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:44` | `🥟` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:45` | `🫓` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:46` | `🍜` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:48` | `🫖` | demo drink fallback | DECORATIVE_EMOJI | FIXED | drink-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:49` | `🥛` | demo drink fallback | DECORATIVE_EMOJI | FIXED | drink-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:53` | `🍕` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:54` | `🧀` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:55` | `🍅` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:57` | `🍟` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:58` | `🍗` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:62` | `🍔` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:63` | `🍔` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:64` | `🌯` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:68` | `🍰` | demo dessert fallback | DECORATIVE_EMOJI | FIXED | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:69` | `🍯` | demo dessert fallback | DECORATIVE_EMOJI | FIXED | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:70` | `🧁` | demo dessert fallback | DECORATIVE_EMOJI | FIXED | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:72` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:73` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:77` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:78` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:79` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:80` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:81` | `☕` | demo drink fallback | DECORATIVE_EMOJI | FIXED | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:83` | `🍰` | demo dessert fallback | DECORATIVE_EMOJI | FIXED | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:84` | `🍮` | demo dessert fallback | DECORATIVE_EMOJI | FIXED | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:85` | `🥐` | demo bakery fallback | DECORATIVE_EMOJI | FIXED | bakery-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:86` | `🧁` | demo dessert fallback | DECORATIVE_EMOJI | FIXED | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:88` | `🥪` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:89` | `🥪` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:90` | `🥪` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:91` | `🍅` | demo dish fallback | DECORATIVE_EMOJI | FIXED | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:99` | `🍢` | demo restaurant fallback | DECORATIVE_EMOJI | FIXED | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:100` | `☕` | demo restaurant fallback | DECORATIVE_EMOJI | FIXED | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:101` | `🍔` | demo restaurant fallback | DECORATIVE_EMOJI | FIXED | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:102` | `🥟` | demo restaurant fallback | DECORATIVE_EMOJI | FIXED | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:103` | `🍰` | demo restaurant fallback | DECORATIVE_EMOJI | FIXED | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:104` | `🍜` | demo restaurant fallback | DECORATIVE_EMOJI | FIXED | restaurant/category SVG | medium: restaurant identity | restaurant card visual |

## Итог

- Baseline candidate source lines: **59**.
- Baseline violations: **54**.
- Allowed-only source lines: **5** (`★`/`✓`). Ещё одна mixed line 421
  содержит допустимый `★`, который сохранён, и исправленный `🕐`.
- Финальный automated scan: **0 forbidden findings**.
- `TEST_FIXTURE`: **0** — `data.js` сейчас является публичным demo-контентом,
  поэтому его fallback symbols считаются пользовательским UI.
- `NON_USER_VISIBLE`: **0**.

## Реализация

- Декоративные food fallback emoji удалены вместе с неиспользуемым полем `e`;
  отсутствие фото отображается спокойным текстом «Фото недоступно».
- Trust, order, preparing, delivery, completed, waiting и payment states
  используют единый минимальный inline SVG helper с `currentColor`.
- SVG декоративны (`aria-hidden`, `focusable=false`), а смысл всегда
  продублирован соседним текстом. Rating stars сохраняют допустимый `★` и
  получили отдельные accessible names.
- `client/scripts/check-no-emoji.js` сканирует user-facing HTML/JS/CSS,
  исключая tests, scripts, dependencies, reports и generated artifacts.
  Проверяются emoji presentation, Extended Pictographic, variation selectors,
  ZWJ, flags, modifiers и отдельный denylist emoji-like UI symbols.
- `client/test/noEmojiSource.test.js` проверяет чистый source, координаты
  findings, compound sequences, allowlist, SVG accessibility и rating labels.
- Mutation proof с контролируемым in-memory forbidden symbol завершился
  ожидаемым exit code 1; после него обычный scan снова PASS.
- Chromium browser acceptance выполнен на desktop и `390x844` для home, menu,
  cart/checkout, payment timer, status walk, delivered/rating и error state.
  WebKit остаётся отдельным открытым browser-quality gate.
