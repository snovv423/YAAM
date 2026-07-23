# YAAM Cross-Device Compatibility

Обновлено: 2026-07-23. Дополняет `docs/PROJECT_STATUS.md`/`docs/PROJECT_BACKLOG.md`,
не дублирует их.

## REAL ANDROID USER VERIFICATION

**Status: PASS**

Ручная проверка опубликованного `https://yaam.su` выполнена владельцем проекта
на реальном Android-устройстве после публикации фикса. Наблюдаемый результат:

- logo glow отображается корректно;
- layout корректен;
- регрессий рендеринга не замечено;
- сайт работает нормально.

Это закрывает последний открытый пункт по Android из этого документа (см.
историю расследования и фикс ниже — неизменны).

## Повод

Реальный пользователь на Android-телефоне сообщил, что неоновое свечение
логотипа YAAM в состоянии покоя отсутствует или выглядит иначе, чем на
iPhone. Инструментального доступа к тому конкретному устройству не было —
ниже honest-разделение того, что доказано инструментально, и что требует
подтверждения на реальном железе.

## Root cause (PLAUSIBLE, не CONFIRMED на реальном Android)

Свечение логотипа (`.wm::before`) держалось на `filter:blur(7px)` внутри
`position:sticky`-родителя (`.top`), у которого есть собственный
`backdrop-filter`. Вложенная `filter`/`backdrop-filter`-композиция — уже
задокументированный в этом файле класс хрупкости: та же комбинация один раз
ломала анимацию `.partners` в реальном Safari и не воспроизводилась в
десктопном/эмулируемом Chromium (см. комментарий у `.partners` в
`client/css/style.css`). На реальном Android дефект логотипа соответствует
именно этому классу.

**Инструментально проверено** (Chromium/WebKit/Firefox, desktop и
mobile-viewport/UA/DPR эмуляция): во всех доступных движках `filter:blur()`
и computed styles логотипа рендерились корректно и идентично — то есть сам
дефект не воспроизводится ни в одном инструменте, доступном в этой среде.
Desktop-based Chromium с mobile viewport не эмулирует реальный GPU-компоузинг
мобильного Android — это принципиальное ограничение, не пробел в тестировании.

## Что сделано

- `.wm::before` переведён с `filter:blur()` на многослойный `text-shadow` —
  тот же приём, что уже безотказно работает в этом файле для `.wm.neon` и
  `.intro-title`. `text-shadow` не зависит от GPU-filter-compositing и не
  участвует в вложенном `sticky`+`backdrop-filter` конфликте.
- `@keyframes wmBreath` больше не анимирует `filter` (только `opacity`) —
  устранена вторая, более редкая форма той же хрупкости (анимируемый blur).
- Визуальный паритет подтверждён скриншотами логотипа в состоянии покоя на
  Chromium desktop, Chromium с Android viewport/UA/DPR (360×800, 412×915),
  WebKit с iPhone viewport/UA/DPR (390×844), WebKit desktop, Firefox desktop.
- Regression-тест `client/test/logoGlowCompatibility.test.js` фиксирует
  структурный инвариант (text-shadow-механизм, отсутствие анимируемого
  filter), не сравнивает произвольную CSS-строку.

## Найденный попутно defect: safe-area

`index.html` включает `viewport-fit=cover`, но `env(safe-area-inset-bottom)`
нигде не применялся. `.dish-add`, `.cartbar` и `.sheet` — fixed-блоки у
нижнего края экрана (кнопка добавления в корзину, sticky cart bar, шторка
корзины/чекаута) — на iPhone с home indicator и Android с жест-навигацией
могли визуально упираться в системную зону снизу. Добавлен
`padding-bottom:calc(<исходное значение> + env(safe-area-inset-bottom))` как
второе объявление после базового — на браузерах без поддержки `env()` строка
целиком невалидна и браузер оставляет прежний `padding-bottom`, без
`@supports`. Покрыто тем же regression-тестом.

## Browser support target

- **Полностью проверено** (реальные движки, не эмуляция): Chromium, WebKit,
  Firefox — desktop и mobile viewport/UA/device-scale-factor.
- **Real-device verification**: реальный Android подтверждён вручную (см.
  "REAL ANDROID USER VERIFICATION" выше) — PASS. Реальный iPhone не
  проверялся напрямую (WebKit engine — близкий, но не идентичный прокси для
  iOS Safari: отличаются font rendering и GPU driver) — остаётся открытым.

## Fallback policy

- Любой glow/decorative-эффект в `.wm` не должен быть единственным способом
  распознать логотип — текст `YAAM` всегда рендерится (сейчас через `::after`
  с `-webkit-text-stroke`), glow — чисто декоративное усиление.
- Новые decorative-эффекты в этом компоненте предпочитать реализовывать через
  `text-shadow`/`box-shadow`/`opacity`/`transform`, а не через `filter`/
  `backdrop-filter` внутри `position:sticky`-контуров, пока не появится
  отдельный, целевой тест на реальном мобильном GPU.

## Known limitations

- Chromium mobile-viewport-эмуляция и WebKit iPhone-viewport-эмуляция — это
  реальные движки рендеринга, но не реальные мобильные GPU/OS. Итоговое
  подтверждение фикса логотипа на реальном Android получено (см. выше) —
  этот пункт закрыт для Android.
- Real iPhone/Safari verification вне Chromium/WebKit desktop-движков не
  проводилась в этой задаче — открытый пункт `docs/PROJECT_BACKLOG.md`
  ("Полный WebKit/iOS Safari прогон") этим не закрывается полностью.

## Real-device verification checklist (для пользователя) — выполнено для Android

Чек-лист использовался для подтверждения на реальном Android-устройстве:

1. Модель устройства.
2. Версия Android.
3. Браузер и его версия (Chrome/Samsung Internet/другой).
4. Скриншот логотипа в состоянии покоя (без тапа).
5. Включён ли режим экономии батареи/трафика (Data Saver).
6. Тёмная/светлая системная тема.
7. Масштаб текста браузера/системы (если увеличен).
8. Открывался ли сайт в обычном браузере или во встроенном browser'е
   Telegram/WhatsApp.

Итоговый статус: **ANDROID CHROMIUM EMULATION PASS, REAL ANDROID USER
VERIFICATION PASS** (см. "REAL ANDROID USER VERIFICATION" в начале документа).
Открытым остаётся только реальный iPhone (см. "Known limitations" выше).
