# YAAM No-Emoji Remediation Inventory

Статус: **OPEN — inventory only, UI не изменён**.

Дата scan: 2026-07-23. Правило определяется в `CLAUDE.md` и `AGENTS.md`.

## Метод

KODAWARI audit первоначально сообщил о 56 строках в HTML/JS. Повторный scan
диапазонов Unicode emoji/symbols по HTML/JS/CSS нашёл 58 строк: те же 56 плюс
две CSS pseudo-element строки с `🖼️`. Поэтому этот документ намеренно шире
первичного числа и ничего не оставляет за пределами inventory.

Категории:

- `DECORATIVE_EMOJI` — декоративный цветной emoji;
- `FUNCTIONAL_ICON` — emoji выполняет функцию иконки;
- `UNICODE_TEXT_SYMBOL` — допустимый типографический символ;
- `TEST_FIXTURE` — только тестовые данные, не пользовательский UI;
- `NON_USER_VISIBLE` — не отображается пользователю.

Допустимые символы: `←`, `→`, `✓`, `★`, `+`. Все остальные строки ниже,
помеченные `yes`, требуют отдельной UI-задачи. Никакая замена в рамках этого
inventory не выполнена.

## Findings

| Файл:строка | Символ | Где отображается | Категория | Нарушение | Предлагаемая замена | UX-риск | Необходимый тест |
|---|---|---|---|---|---|---|---|
| `client/css/style.css:225` | `🖼️` | placeholder карточки без фото | DECORATIVE_EMOJI | yes | CSS/SVG image placeholder | low: изменится fallback | screenshot no-photo card |
| `client/css/style.css:228` | `🖼️` | hero placeholder без фото | DECORATIVE_EMOJI | yes | CSS/SVG image placeholder | low: изменится fallback | screenshot no-photo hero |
| `client/index.html:105` | `🛡️` | trust/payment protection block | FUNCTIONAL_ICON | yes | shield SVG из единого набора | medium: важный trust cue | mobile checkout screenshot |
| `client/index.html:145` | `🍽️` | начальная status icon | FUNCTIONAL_ICON | yes | neutral order/status SVG | medium: status recognition | status screen visual test |
| `client/js/app.js:153` | `🍽️` | restaurant fallback model | DECORATIVE_EMOJI | yes | neutral restaurant SVG/CSS | low: fallback only | no-image restaurant card |
| `client/js/app.js:161` | `🍽️` | menu item fallback model | DECORATIVE_EMOJI | yes | neutral dish SVG/CSS | low: fallback only | no-image dish card |
| `client/js/app.js:193` | `★` | restaurant rating chip | UNICODE_TEXT_SYMBOL | no | keep `★` | none | rating chip regression |
| `client/js/app.js:220` | `🌙` | “Город спит” empty state | DECORATIVE_EMOJI | yes | moon/night SVG or CSS | low: empty-state mood | closed-city screenshot |
| `client/js/app.js:320` | `📋 👨‍🍳 🛵 ✅` | delivery status steps | FUNCTIONAL_ICON | yes | order/chef/courier/check SVG set | high: status comprehension | full delivery status walk |
| `client/js/app.js:326` | `📋 👨‍🍳 ✅` | pickup status steps | FUNCTIONAL_ICON | yes | order/chef/check SVG set | high: status comprehension | full pickup status walk |
| `client/js/app.js:355` | `★` | rating buttons | UNICODE_TEXT_SYMBOL | no | keep `★` | none | keyboard/tap rating test |
| `client/js/app.js:371` | `✓` | completed progress step | UNICODE_TEXT_SYMBOL | no | keep `✓` | none | progress transition test |
| `client/js/app.js:421` | `★` | restaurant rating meta | UNICODE_TEXT_SYMBOL | no | keep `★` | none | rating meta regression |
| `client/js/app.js:421` | `🕐` | restaurant hours meta | FUNCTIONAL_ICON | yes | clock SVG or text label | low: compact metadata | restaurant header screenshot |
| `client/js/app.js:423` | `★` | mobile sticky rating | UNICODE_TEXT_SYMBOL | no | keep `★` | none | sticky bar regression |
| `client/js/app.js:1195` | `⏳` | waiting status icon | FUNCTIONAL_ICON | yes | hourglass/progress SVG/CSS | medium: waiting feedback | timer/status screenshot |
| `client/js/app.js:1519` | `💳` | payment status icon | FUNCTIONAL_ICON | yes | card/payment SVG | high: payment context | payment screen screenshot |
| `client/js/app.js:1616` | `⏳` | pending/wait status icon | FUNCTIONAL_ICON | yes | progress SVG/CSS | medium: waiting feedback | pending restore test |
| `client/js/app.js:1868` | `✓` | selected vote button | UNICODE_TEXT_SYMBOL | no | keep `✓` | none | vote state regression |
| `client/js/data.js:40` | `🍢` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:41` | `🥩` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:42` | `🍗` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:44` | `🥟` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:45` | `🫓` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:46` | `🍜` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:48` | `🫖` | demo drink fallback | DECORATIVE_EMOJI | yes | drink-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:49` | `🥛` | demo drink fallback | DECORATIVE_EMOJI | yes | drink-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:53` | `🍕` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:54` | `🧀` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:55` | `🍅` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:57` | `🍟` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:58` | `🍗` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:62` | `🍔` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:63` | `🍔` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:64` | `🌯` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:68` | `🍰` | demo dessert fallback | DECORATIVE_EMOJI | yes | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:69` | `🍯` | demo dessert fallback | DECORATIVE_EMOJI | yes | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:70` | `🧁` | demo dessert fallback | DECORATIVE_EMOJI | yes | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:72` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:73` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:77` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:78` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:79` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:80` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:81` | `☕` | demo drink fallback | DECORATIVE_EMOJI | yes | coffee SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:83` | `🍰` | demo dessert fallback | DECORATIVE_EMOJI | yes | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:84` | `🍮` | demo dessert fallback | DECORATIVE_EMOJI | yes | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:85` | `🥐` | demo bakery fallback | DECORATIVE_EMOJI | yes | bakery-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:86` | `🧁` | demo dessert fallback | DECORATIVE_EMOJI | yes | dessert-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:88` | `🥪` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:89` | `🥪` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:90` | `🥪` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:91` | `🍅` | demo dish fallback | DECORATIVE_EMOJI | yes | dish-category SVG/CSS | low: demo fallback | demo menu visual |
| `client/js/data.js:99` | `🍢` | demo restaurant fallback | DECORATIVE_EMOJI | yes | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:100` | `☕` | demo restaurant fallback | DECORATIVE_EMOJI | yes | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:101` | `🍔` | demo restaurant fallback | DECORATIVE_EMOJI | yes | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:102` | `🥟` | demo restaurant fallback | DECORATIVE_EMOJI | yes | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:103` | `🍰` | demo restaurant fallback | DECORATIVE_EMOJI | yes | restaurant/category SVG | medium: restaurant identity | restaurant card visual |
| `client/js/data.js:104` | `🍜` | demo restaurant fallback | DECORATIVE_EMOJI | yes | restaurant/category SVG | medium: restaurant identity | restaurant card visual |

## Summary

- Candidate lines: **58**.
- Allowed-only lines: **5** (`★`/`✓`). Ещё одна mixed line 421 содержит
  допустимый `★` и запрещённый `🕐`, поэтому считается нарушением.
- Violating lines requiring remediation: **53**.
- `TEST_FIXTURE`: **0** — `data.js` сейчас является публичным demo-контентом,
  поэтому его fallback symbols считаются пользовательским UI.
- `NON_USER_VISIBLE`: **0**.

## Required implementation task

1. Выбрать единый SVG/CSS icon set и mapping.
2. Заменить только строки с `Нарушение=yes`.
3. Сохранить смысл status/payment/trust icons и fallback readability.
4. Добавить автоматический scan, который запрещает новые emoji ranges в
   `client/`, но разрешает утверждённый allowlist `← → ✓ ★ +`.
5. Запустить frontend unit tests и Playwright screenshots 390×844 для demo
   home/menu/checkout/payment/status/empty states.
6. Провести отдельный visual review; не смешивать remediation с payment или
   production changes.
