'use strict';
// Единственный клиентский скрипт HQ — универсальная защита от повторной
// отправки ЛЮБОЙ формы (не только логина — Stage 4 добавляет создание/
// правку ресторана, паузу, архивирование) + polling «Обзора» ресторана.
// Вынесен в отдельный статический файл (не инлайн <script>) намеренно: CSP
// страницы (server/services/hq/securityHeaders.js) — строгий self-only
// `script-src 'self'` без 'unsafe-inline', поэтому инлайн-скрипт браузер бы
// просто заблокировал.
(function () {
  // Chrome может восстановить вкладку с устаревшим результатом media-query
  // до первого resize. Явно синхронизируем режим с фактической шириной при
  // загрузке/возврате из back-forward cache; resize остаётся страховкой.
  function syncLayoutMode() {
    var wide = document.documentElement.clientWidth > 760;
    document.documentElement.classList.toggle('hq-wide', wide);
    document.documentElement.classList.toggle('hq-narrow', !wide);
  }
  syncLayoutMode();
  window.addEventListener('pageshow', syncLayoutMode);
  window.addEventListener('resize', syncLayoutMode);

  // -------------------------------------------------------------------------
  // Подтверждение необратимых действий: data-confirm на <form>.
  //
  // Инлайновый onsubmit="return confirm(...)" в HQ не работает и работать не
  // может: CSP страницы (services/hq/securityHeaders.js) — script-src 'self'
  // без 'unsafe-inline', поэтому обработчик, записанный АТРИБУТОМ, браузер
  // молча выбрасывает. Единственное CSP-корректное место для подтверждения —
  // этот внешний скрипт: делегированный слушатель на document + собственный
  // диалог в стиле остальных sheet'ов HQ.
  //
  // Весь текст берётся из data-атрибутов формы и вставляется через
  // textContent — разметка из данных не собирается ни здесь, ни на сервере,
  // поэтому имя блюда с кавычками/угловыми скобками безопасно и не ломает
  // диалог (у инлайнового confirm() с этим были ровно обратные проблемы).
  //
  // Слушатель регистрируется ДО double-submit guard ниже и при перехвате
  // вызывает stopImmediatePropagation(): иначе guard успел бы заблокировать
  // кнопку формы, которая в итоге так и не отправилась, и повторное нажатие
  // после «Отмена» стало бы невозможным.
  //
  // Без JS форма отправляется как обычно, без диалога — то же осознанное
  // поведение, что и у остального HQ (перетаскивание, кроп): сама операция
  // остаётся достижимой, теряется только подтверждение.
  var confirmUi = null;
  var pendingForm = null;

  function closeConfirm() {
    if (!confirmUi) return;
    confirmUi.backdrop.classList.remove('open');
    pendingForm = null;
  }

  function ensureConfirmUi() {
    if (confirmUi) return confirmUi;
    var backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop confirm-backdrop';
    var sheet = document.createElement('div');
    sheet.className = 'sheet confirm-sheet';
    sheet.setAttribute('role', 'alertdialog');
    sheet.setAttribute('aria-modal', 'true');
    var title = document.createElement('div');
    title.className = 'confirm-title';
    var text = document.createElement('div');
    text.className = 'confirm-text';
    var actions = document.createElement('div');
    actions.className = 'confirm-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost compact';
    cancel.textContent = 'Отмена';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'danger compact';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    sheet.appendChild(title);
    sheet.appendChild(text);
    sheet.appendChild(actions);
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);

    cancel.addEventListener('click', closeConfirm);
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeConfirm();
    });
    ok.addEventListener('click', function () {
      var form = pendingForm;
      closeConfirm();
      if (!form) return;
      // Повторная отправка проходит мимо этого же слушателя по флагу
      // confirmed. requestSubmit(), а не submit(): submit() не порождает
      // событие submit вовсе, и double-submit guard ниже перестал бы
      // защищать именно необратимые действия.
      form.dataset.confirmed = '1';
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    });

    confirmUi = { backdrop: backdrop, sheet: sheet, title: title, text: text, ok: ok, cancel: cancel };
    return confirmUi;
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var message = form.getAttribute('data-confirm');
    if (!message) return;
    if (form.dataset.confirmed === '1') {
      form.dataset.confirmed = '';
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    var ui = ensureConfirmUi();
    ui.title.textContent = form.getAttribute('data-confirm-title') || 'Подтвердите действие';
    ui.text.textContent = message;
    ui.ok.textContent = form.getAttribute('data-confirm-ok') || 'Подтвердить';
    pendingForm = form;
    ui.backdrop.classList.add('open');
    ui.ok.focus();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && confirmUi && confirmUi.backdrop.classList.contains('open')) closeConfirm();
  });

  // Double-submit guard — делегированный слушатель на document, работает для
  // любой формы HQ без необходимости давать каждой свой уникальный id/script.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    if (btn.dataset.busyText) btn.textContent = btn.dataset.busyText;
  });
})();

// Non-destructive photo crop editor. State is stored as a normalized source
// rectangle, so it remains exact at every responsive display size.
(function () {
  var viewports = document.querySelectorAll('[data-cropper]');
  if (!viewports.length) return;

  viewports.forEach(function (viewport) {
    var form = viewport.closest('.crop-form');
    var input = form.querySelector('input[name="crop"]');
    var zoom = form.querySelector('[data-crop-zoom]');
    var img = viewport.querySelector('img');
    var reset = form.querySelector('[data-crop-reset]');
    var rotationInput = form.querySelector('[data-crop-rotation]');
    var editor = viewport.closest('[data-photo-editor]');
    var target = form.getAttribute('data-crop-panel');
    var preview = editor && editor.querySelector('[data-crop-preview="' + target + '"]');
    var previewImg = preview && preview.querySelector('img');
    var aspect = Number(viewport.getAttribute('data-aspect'));
    var rotation = Number(rotationInput.value) || 0;
    var state = null;
    var start = null;

    function clampCrop(crop) {
      var base = defaultCrop();
      var width = Math.max(0.000001, Math.min(base.width, Number(crop.width) || base.width));
      var height = width / (base.width / base.height);
      if (height > base.height) {
        height = base.height;
        width = height * (base.width / base.height);
      }
      return {
        x: Math.max(0, Math.min(1 - width, Number(crop.x) || 0)),
        y: Math.max(0, Math.min(1 - height, Number(crop.y) || 0)),
        width: width,
        height: height,
      };
    }

    function paint(currentImg, crop, turn) {
      if (!currentImg || !currentImg.naturalWidth) return;
      var frame = currentImg.parentElement.getBoundingClientRect();
      if (!frame.width || !frame.height) return;
      var quarterTurn = turn === 90 || turn === 270;
      var orientedWidth = quarterTurn ? currentImg.naturalHeight : currentImg.naturalWidth;
      var orientedHeight = quarterTurn ? currentImg.naturalWidth : currentImg.naturalHeight;
      var scale = Math.max(frame.width / (crop.width * orientedWidth), frame.height / (crop.height * orientedHeight));
      var renderedWidth = currentImg.naturalWidth * scale;
      var renderedHeight = currentImg.naturalHeight * scale;
      var cropX = crop.x * orientedWidth * scale;
      var cropY = crop.y * orientedHeight * scale;
      currentImg.style.left = '0';
      currentImg.style.top = '0';
      currentImg.style.width = renderedWidth + 'px';
      currentImg.style.height = renderedHeight + 'px';
      if (turn === 90) currentImg.style.transform = 'matrix(0,1,-1,0,' + (renderedHeight - cropX) + ',' + (-cropY) + ')';
      else if (turn === 180) currentImg.style.transform = 'matrix(-1,0,0,-1,' + (renderedWidth - cropX) + ',' + (renderedHeight - cropY) + ')';
      else if (turn === 270) currentImg.style.transform = 'matrix(0,-1,1,0,' + (-cropX) + ',' + (renderedWidth - cropY) + ')';
      else currentImg.style.transform = 'matrix(1,0,0,1,' + (-cropX) + ',' + (-cropY) + ')';
    }

    function defaultCrop() {
      var sourceAspect = img.naturalWidth / img.naturalHeight;
      if (rotation === 90 || rotation === 270) sourceAspect = 1 / sourceAspect;
      if (sourceAspect > aspect) {
        var width = aspect / sourceAspect;
        return { x: (1 - width) / 2, y: 0, width: width, height: 1 };
      }
      var height = sourceAspect / aspect;
      return { x: 0, y: (1 - height) / 2, width: 1, height: height };
    }
    function parseInitial() {
      try {
        var parsed = JSON.parse(input.value);
        if (parsed && parsed.width > 0 && parsed.height > 0) return clampCrop(parsed);
      } catch (_) { /* centred fallback */ }
      return defaultCrop();
    }
    function render() {
      if (!state) return;
      [img, previewImg].forEach(function (currentImg) {
        if (!currentImg) return;
        paint(currentImg, state, rotation);
      });
      rotationInput.value = String(rotation);
      input.value = JSON.stringify({ x: state.x, y: state.y, width: state.width, height: state.height });
    }
    function syncZoom() {
      var base = defaultCrop();
      var factor = Math.max(0.2, Math.min(1, state.width / base.width));
      zoom.value = String(Math.round((1 - factor) / 0.8 * 100));
    }
    function init() { state = parseInitial(); syncZoom(); render(); }
    if (img.complete && img.naturalWidth) init(); else img.addEventListener('load', init, { once: true });

    zoom.addEventListener('input', function () {
      if (!state) return;
      var base = defaultCrop();
      var factor = 1 - (Number(zoom.value) / 100) * 0.8;
      var cx = state.x + state.width / 2;
      var cy = state.y + state.height / 2;
      state = clampCrop({
        x: cx - base.width * factor / 2,
        y: cy - base.height * factor / 2,
        width: base.width * factor,
        height: base.height * factor,
      });
      render();
    });
    reset.addEventListener('click', function () {
      if (editor) editor.dispatchEvent(new CustomEvent('cropreset'));
    });
    if (editor) {
      editor.addEventListener('rotationchange', function (event) {
        rotation = event.detail.rotation;
        state = defaultCrop();
        zoom.value = '0';
        render();
      });
      editor.addEventListener('cropreset', function () {
        rotation = 0;
        state = defaultCrop();
        zoom.value = '0';
        render();
      });
      // Пока панель скрыта (display:none), её кадр имеет нулевой размер и
      // paint() выходит сразу — так что первый render() после загрузки
      // страницы ничего не рисует. Редактор теперь открыт не по умолчанию, а
      // по кнопке, и вкладка пресета переключается на лету, поэтому обе эти
      // ситуации обязаны заново запрашивать отрисовку уже видимой панели.
      editor.addEventListener('croprerender', function () {
        if (!state) return;
        render();
      });
    }
    viewport.addEventListener('pointerdown', function (event) {
      if (!state) return;
      event.preventDefault();
      viewport.setPointerCapture(event.pointerId);
      start = { x: event.clientX, y: event.clientY, cropX: state.x, cropY: state.y };
    });
    viewport.addEventListener('pointermove', function (event) {
      if (!start || !state) return;
      var rect = viewport.getBoundingClientRect();
      state.x = Math.max(0, Math.min(1 - state.width, start.cropX - (event.clientX - start.x) / rect.width * state.width));
      state.y = Math.max(0, Math.min(1 - state.height, start.cropY - (event.clientY - start.y) / rect.height * state.height));
      render();
    });
    function end() { start = null; }
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    window.addEventListener('resize', render);
  });

  document.querySelectorAll('[data-photo-card]').forEach(function (card) {
    var open = card.querySelector('[data-photo-open]');
    var editor = card.querySelector('[data-photo-editor]');
    if (!editor || !open) return;
    function rerender() {
      // Кадр становится измеримым только после того, как секция реально
      // показана, поэтому просим отрисовку в следующем кадре.
      requestAnimationFrame(function () {
        editor.dispatchEvent(new CustomEvent('croprerender'));
      });
    }
    function setOpen(value) {
      editor.classList.toggle('is-open', value);
      open.setAttribute('aria-expanded', String(value));
      if (value) rerender();
    }
    // Редактор всегда стартует закрытым (разметка не содержит is-open) и
    // раскрывается ТОЛЬКО этим кликом — ни page load, ни reload, ни
    // back/forward, ни смена основного фото его не открывают.
    open.addEventListener('click', function () { setOpen(!editor.classList.contains('is-open')); });
    var close = editor.querySelector('[data-photo-close]');
    if (close) close.addEventListener('click', function () { setOpen(false); open.focus(); });
    var initialRotationInput = editor.querySelector('[data-crop-rotation]');
    var currentRotation = Number(initialRotationInput && initialRotationInput.value) || 0;
    function publishRotation() {
      var label = editor.querySelector('[data-rotation-label]');
      if (label) label.textContent = currentRotation + '°';
      editor.dispatchEvent(new CustomEvent('rotationchange', { detail: { rotation: currentRotation } }));
    }
    editor.querySelectorAll('[data-rotate]').forEach(function (button) {
      button.addEventListener('click', function () {
        currentRotation = (currentRotation + Number(button.getAttribute('data-rotate')) + 360) % 360;
        publishRotation();
      });
    });
    editor.addEventListener('cropreset', function () {
      currentRotation = 0;
      var label = editor.querySelector('[data-rotation-label]');
      if (label) label.textContent = '0°';
    });
    editor.querySelectorAll('[data-crop-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.getAttribute('data-crop-tab');
        editor.querySelectorAll('[data-crop-tab]').forEach(function (other) {
          var selected = other === tab;
          other.classList.toggle('is-active', selected);
          other.setAttribute('aria-selected', String(selected));
        });
        editor.querySelectorAll('[data-crop-panel]').forEach(function (panel) {
          panel.classList.toggle('is-active', panel.getAttribute('data-crop-panel') === target);
        });
        // Предпросмотр справа теперь один — того же пресета, что и вкладка.
        // Второй остаётся в DOM (чтобы не потерять уже загруженные crop-данные
        // второго пресета), но скрыт.
        editor.querySelectorAll('[data-crop-preview-card]').forEach(function (previewCard) {
          previewCard.classList.toggle('is-active', previewCard.getAttribute('data-crop-preview-card') === target);
        });
        rerender();
      });
    });
  });
})();

// Современная загрузка фотографии.
//
// Здесь НЕТ synthetic .click() по input: плитка содержит сам <input
// type="file">, растянутый на всю её площадь и прозрачный, поэтому системный
// выбор файла открывается настоящим trusted-жестом пользователя (иначе
// Safari/iOS вправе его заблокировать), а на телефоне появляется штатный
// chooser «Медиатека / Снять фото / Обзор».
//
// Скрипт показывает превью выбранного файла, локальную ошибку и держит кнопку
// «Загрузить» выключенной, пока файл не выбран. Если JS отключён, форма
// отправляется как обычная multipart-форма (кнопка остаётся активной, её
// выключает только скрипт), а обязательность файла обеспечивает required.
(function () {
  var forms = document.querySelectorAll('[data-photo-upload]');
  if (!forms.length) return;

  var ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

  forms.forEach(function (form) {
    var input = form.querySelector('[data-upload-input]');
    var tile = form.querySelector('[data-upload-tile]');
    var selected = form.querySelector('[data-upload-selected]');
    var thumb = form.querySelector('[data-upload-thumb]');
    var nameEl = form.querySelector('[data-upload-name]');
    var clear = form.querySelector('[data-upload-clear]');
    var busy = form.querySelector('[data-upload-busy]');
    var errorEl = form.querySelector('[data-upload-error]');
    var submitBtn = form.querySelector('[data-upload-submit]');
    if (!input || !tile || !selected || !thumb) return;

    // «Загрузить» до выбора файла раньше выглядела рабочей, но нажатие не
    // делало ничего: браузер блокировал отправку из-за required у скрытого
    // input и не показывал подсказку. Кнопка включается только при выбранном
    // файле — и включается ИЗ СКРИПТА, чтобы без JS форма осталась обычной
    // рабочей multipart-формой (её проверяет сервер).
    function setSubmitEnabled(enabled) {
      if (!submitBtn) return;
      submitBtn.disabled = !enabled;
    }
    setSubmitEnabled(false);

    var maxBytes = Number(form.getAttribute('data-max-bytes')) || 0;
    var objectUrl = null;

    function showError(message) {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.classList.toggle('is-visible', !!message);
    }

    function releaseUrl() {
      if (!objectUrl) return;
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }

    function reset() {
      releaseUrl();
      input.value = '';
      selected.hidden = true;
      tile.hidden = false;
      thumb.removeAttribute('src');
      if (nameEl) nameEl.textContent = '';
      if (busy) busy.hidden = true;
      setSubmitEnabled(false);
    }

    function accept(file) {
      // Локальная проверка до отправки: при отказе файл ОСТАЁТСЯ выбранным,
      // страница не перезагружается, и пользователь может сразу повторить.
      if (ALLOWED.indexOf(file.type) === -1) {
        showError('Поддерживаются только JPEG, PNG и WebP.');
        return false;
      }
      if (maxBytes && file.size > maxBytes) {
        // Тот же текст, что отдаёт сервер (services/hq/media/limits.js):
        // владелец не должен видеть две разные формулировки одного отказа.
        showError('Фото слишком большое. Максимальный размер исходного файла — '
          + Math.floor(maxBytes / (1024 * 1024)) + ' МБ.');
        return false;
      }
      showError('');
      return true;
    }

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) { reset(); return; }
      releaseUrl();
      objectUrl = URL.createObjectURL(file);
      thumb.src = objectUrl;
      if (nameEl) nameEl.textContent = file.name;
      tile.hidden = true;
      selected.hidden = false;
      if (busy) busy.hidden = true;
      setSubmitEnabled(accept(file));
    });

    if (clear) {
      clear.addEventListener('click', function () {
        reset();
        showError('');
        // Фокус возвращается на сам input — он и есть кликабельная плитка.
        input.focus();
      });
    }

    form.addEventListener('submit', function (event) {
      var file = input.files && input.files[0];
      if (!file) return;
      if (!accept(file)) {
        event.preventDefault();
        return;
      }
      // Индикатор живёт на самой миниатюре — страницу не затемняем.
      if (busy) busy.hidden = false;
    });

    window.addEventListener('pagehide', releaseUrl);
  });
})();

// ===========================================================================
// Вкладка «Меню» — возврат ровно туда, откуда ушли редактировать блюдо.
// ===========================================================================
//
// ЗАДАЧА. Владелец раскрывает категорию, прокручивает до нужного блюда,
// открывает его карточку — и по «← Назад» обязан вернуться к ТОЙ ЖЕ строке:
// категория раскрыта, прокрутка на месте, остальные открытые категории тоже
// остались открытыми.
//
// ЧТО ДЕЛАЕТ СЕРВЕР, А ЧТО КЛИЕНТ. Ссылка «← Назад» ведёт на
// /menu?item=N#dish-N — это и есть состояние навигации, а не догадка:
//   * ?item=N   — сервер сам рендерит <details open> у категории блюда;
//   * #dish-N   — браузер сам прокручивает к строке (работает без JS вообще).
// Этот скрипт добавляет то, чего в адресе быть не может: ТОЧНОЕ смещение
// строки в окне (та же позиция, что была в момент ухода) и раскрытие всех
// прочих категорий, открытых владельцем.
//
// ПОЧЕМУ sessionStorage, А НЕ ТАЙМЕРЫ. Ничего не откладывается и не
// «дожидается» — состояние пишется в момент реального события (клик по
// строке блюда, pagehide) и читается в pageshow, который срабатывает и при
// обычной загрузке, и при возврате из bfcache. Размеры превью заданы
// атрибутами width/height, поэтому строки не «прыгают» после подгрузки
// картинок и измеренное смещение остаётся верным.
//
// scrollRestoration='manual' ставится ТОЛЬКО на записи истории этого экрана:
// иначе браузер сначала восстановил бы свою позицию (снятую до раскрытия
// категории, то есть неверную), а уже потом её поправил бы этот код —
// видимый двойной прыжок.
(function () {
  var screen = document.querySelector('[data-menu-screen]');
  if (!screen) return;

  var KEY = 'hq.menu.' + screen.getAttribute('data-menu-screen');

  // sessionStorage может быть недоступен (приватный режим, запрет хранилища).
  // Тогда экран просто работает как без скрипта: категория раскрыта сервером,
  // якорь #dish-N отрабатывает браузером.
  function readState() {
    try {
      var raw = window.sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeState(state) {
    try { window.sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* хранилище недоступно */ }
  }

  function openCategoryIds() {
    return Array.prototype.slice.call(document.querySelectorAll('details.cat-block[open]'))
      .map(function (el) { return el.getAttribute('data-category-id'); })
      .filter(function (id) { return /^\d+$/.test(id || ''); });
  }

  // pendingFocus живёт ровно до ухода со страницы: блюдо запоминается ТОЛЬКО
  // если владелец ушёл именно в его карточку. Уход куда-либо ещё (вкладка
  // «Заказы», кнопка «назад» браузера) обязан очистить фокус — иначе
  // следующее открытие меню утаскивало бы к давно отредактированному блюду
  // вместо последней реальной позиции чтения.
  var pendingFocus = null;

  function save(focus) {
    writeState({
      open: openCategoryIds(),
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
      item: focus ? focus.item : null,
      itemTop: focus ? focus.itemTop : null,
    });
  }

  function focusIdFromUrl() {
    var match = /[?&]item=(\d+)/.exec(window.location.search);
    return match ? match[1] : null;
  }

  function restore() {
    var state = readState();
    var focusId = focusIdFromUrl() || (state && state.item) || null;

    // 1. Раскрыть категории — ДО измерений: иначе смещение считалось бы по
    //    ещё свёрнутому списку и прокрутка ушла бы мимо.
    if (state && state.open) {
      state.open.forEach(function (id) {
        if (!/^\d+$/.test(id)) return;
        var block = document.querySelector('details.cat-block[data-category-id="' + id + '"]');
        if (block) block.open = true;
      });
    }

    // 2. Вернуть позицию. Приоритет — строка блюда: она переживает и правку
    //    названия, и изменение высоты соседей, в отличие от голого scrollY.
    var row = focusId ? document.getElementById('dish-' + focusId) : null;
    if (row) {
      var block = row.closest('details.cat-block');
      if (block) block.open = true;
      var absoluteTop = row.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
      var offsetInViewport = state && typeof state.itemTop === 'number'
        ? state.itemTop
        : Math.round(window.innerHeight / 3);
      window.scrollTo(0, Math.max(0, Math.round(absoluteTop - offsetInViewport)));
      // Короткая подсветка: строк много и они похожи — без неё непонятно,
      // какое из блюд только что редактировалось. Класс снимается по
      // animationend, а не по таймеру.
      row.classList.add('dish-row-focus');
      row.addEventListener('animationend', function () {
        row.classList.remove('dish-row-focus');
      }, { once: true });
    } else if (state && typeof state.scrollY === 'number') {
      window.scrollTo(0, state.scrollY);
    }
  }

  if ('scrollRestoration' in window.history) {
    try { window.history.scrollRestoration = 'manual'; } catch (e) { /* браузер не даёт — не критично */ }
  }

  // Клик по строке блюда — единственный момент, когда точно известно, КУДА
  // возвращать: запоминаем и само блюдо, и его смещение в окне.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var link = target.closest('.dish-link');
    if (!link) return;
    var row = link.closest('.dish-row');
    if (!row) return;
    var id = row.getAttribute('data-item-id');
    if (!/^\d+$/.test(id || '')) return;
    pendingFocus = { item: id, itemTop: Math.round(row.getBoundingClientRect().top) };
    save(pendingFocus);
  });

  // Уход со страницы любым другим путём (кнопка «назад» браузера, переход по
  // вкладке, отправка формы) — сохраняем хотя бы раскрытые категории и
  // прокрутку.
  window.addEventListener('pagehide', function () { save(pendingFocus); });

  // Скрипт подключён с defer — на обычной загрузке DOM уже готов, и позицию
  // надо вернуть НЕМЕДЛЕННО, до отрисовки, а не по 'load' (тот ждёт картинки
  // и дал бы видимый рывок). pageshow нужен только для возврата из bfcache,
  // где скрипт заново не исполняется вовсе; на обычной загрузке он сработал
  // бы ВТОРОЙ раз — уже после того, как владелец мог прокрутить страницу
  // сам, — поэтому там он и отсекается по event.persisted.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) restore();
  });
  restore();
})();

// Живое обновление «Обзора» ресторана (Stage 4, GET .../overview.json)
// удалено вместе с самим блоком «Активные заказы»: docs/HQ-PRODUCT-SPEC.md
// прямо исключает оперативную сводку активных заказов из HQ (HQ — кабинет
// владельца, а не диспетчерская). Опрашивать стало нечего — оставлять
// мёртвый poll-цикл ради удалённой разметки не нужно.

(function () {
  // HQ «Обзор» — Центр событий (docs/HQ-PRODUCT-SPEC.md).
  //   1. Раскрытие/сворачивание — чистый CSS-класс, без анимационных
  //      библиотек (задание, раздел 4).
  //   2. Живое дополнение ленты — тот же JSON-poll паттерн, что и live
  //      overview выше, но сервер уже возвращает готовый HTML КАЖДОГО
  //      нового события (routes/hq/pages.js: GET .../events/feed) — этот
  //      файл только вставляет его, никакого клиентского шаблонизатора.
  //   3. "Новое событие не должно резко перебрасывать читающего вниз"
  //      (задание, раздел 7) — автоскролл к низу происходит, ТОЛЬКО если
  //      пользователь уже был прокручен к низу перед добавлением; иначе
  //      позиция чтения сохраняется как есть.
  var center = document.getElementById('hq-event-center');
  if (!center) return;
  var scrollBox = center.querySelector('.event-center-scroll');
  var expandBtn = center.querySelector('.event-expand-btn');

  if (expandBtn) {
    expandBtn.addEventListener('click', function () {
      var isExpanded = center.classList.toggle('expanded');
      expandBtn.setAttribute('aria-expanded', String(isExpanded));
      expandBtn.textContent = isExpanded ? 'Свернуть' : 'Раскрыть';
    });
  }

  var endpoint = center.getAttribute('data-endpoint');
  if (!endpoint || !scrollBox) return;
  var lastId = Number(center.getAttribute('data-last-id')) || 0;
  var timer = null;

  function isScrolledToBottom() {
    return scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 24;
  }

  function poll() {
    fetch(endpoint + '?afterId=' + lastId, { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.items || !data.items.length) return;
        var wasAtBottom = isScrolledToBottom();
        var emptyState = scrollBox.querySelector('.event-empty');
        if (emptyState) emptyState.remove();
        data.items.forEach(function (item) {
          scrollBox.insertAdjacentHTML('beforeend', item.html);
          lastId = item.id;
        });
        if (wasAtBottom) scrollBox.scrollTop = scrollBox.scrollHeight;
      })
      .catch(function () { /* тихо игнорируем сетевой сбой — следующий тик попробует снова */ });
  }

  function start() {
    if (timer) return;
    timer = setInterval(poll, 20000);
  }
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });
  if (!document.hidden) start();
})();

(function () {
  // Перестановка категорий и блюд перетаскиванием (docs/HQ-PRODUCT-SPEC.md,
  // раздел «Категории»): кнопки «Выше»/«Ниже» удалены, порядок меняется
  // только здесь. Pointer Events — один код для мыши и тача, без библиотек.
  //
  // Тянуть можно ТОЛЬКО за маленький handle (.drag-handle), а не за всю
  // строку: спецификация прямо требует, чтобы обычная прокрутка страницы
  // пальцем не переставляла элементы случайно. touch-action:none стоит
  // только на самом handle (см. layout.js) — остальная строка продолжает
  // нормально скроллиться.
  var lists = document.querySelectorAll('[data-reorder]');
  if (!lists.length) return;

  // Списки вложены друг в друга: ul[data-reorder=items] лежит внутри
  // details.cat-block, который сам является строкой .cat-list[data-reorder=
  // categories]. Поэтому строку НЕЛЬЗЯ искать как closest('.cat-block') ||
  // closest('.dish-row'): для handle блюда первый селектор попадал в
  // родительскую категорию, и «перетаскивание блюда» на деле таскало всю
  // категорию, а pointerdown всплывал ОБОИМ спискам сразу — сервер получал
  // два POST-а (это видно в production access-логе: reorder-categories и
  // reorder-items приходили парой), а порядок не менялся ни там, ни там.
  var ROW_SELECTOR = { categories: '.cat-block', items: '.dish-row' };

  function rowSelector(list) {
    return ROW_SELECTOR[list.getAttribute('data-reorder')] || null;
  }

  function itemsOf(list) {
    var selector = rowSelector(list);
    if (!selector) return [];
    return Array.prototype.slice.call(list.querySelectorAll(':scope > ' + selector));
  }

  function idOf(el) {
    return el.getAttribute('data-category-id') || el.getAttribute('data-item-id');
  }

  function orderOf(list) {
    return itemsOf(list).map(idOf).filter(Boolean).join(',');
  }

  function persist(list) {
    var endpoint = list.getAttribute('data-endpoint');
    if (!endpoint) return;
    var tokenInput = document.querySelector('input[name="_csrf"]');
    if (!tokenInput) return;
    var order = itemsOf(list).map(idOf).filter(Boolean);
    list.classList.add('reorder-saving');
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _csrf: tokenInput.value, order: order })
    }).then(function (response) {
      if (!response.ok) throw new Error('reorder failed');
      list.classList.remove('reorder-saving');
    }).catch(function () {
      // Порядок на экране остаётся новым, но владелец должен видеть, что на
      // сервер он не доехал: молча расходиться экран и БД не должны.
      list.classList.remove('reorder-saving');
      list.classList.add('reorder-failed');
      setTimeout(function () { list.classList.remove('reorder-failed'); }, 4000);
    });
  }

  // Куда вставить перетаскиваемую строку: сравниваем указатель с серединами
  // СОСЕДЕЙ. Через elementFromPoint делать это нельзя — приподнятая строка
  // сама находится под курсором и перекрывает цель.
  function placeBy(list, row, clientY) {
    var siblings = itemsOf(list).filter(function (el) { return el !== row; });
    var before = null;
    for (var i = 0; i < siblings.length; i++) {
      var rect = siblings[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) { before = siblings[i]; break; }
    }
    if (before) {
      if (row.nextElementSibling !== before) list.insertBefore(row, before);
    } else if (list.lastElementChild !== row) {
      list.appendChild(row);
    }
  }

  lists.forEach(function (list) {
    list.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      var handle = event.target.closest && event.target.closest('.drag-handle');
      if (!handle) return;
      // Событие обрабатывает ТОЛЬКО ближайший к handle список — иначе
      // внешний список категорий тоже начал бы тащить свою строку.
      if (handle.closest('[data-reorder]') !== list) return;
      var selector = rowSelector(list);
      if (!selector) return;
      var row = handle.closest(selector);
      if (!row || row.parentNode !== list) return;

      event.preventDefault();
      event.stopPropagation();

      var orderBefore = orderOf(list);
      var pointerId = event.pointerId;
      // Все расчёты — в координатах документа: во время жеста страница может
      // прокручиваться (см. tick ниже), и viewport-координаты «уехали» бы
      // вместе с ней, отрывая строку от пальца.
      var startPageY = event.clientY + window.scrollY;
      var startTopDoc = row.getBoundingClientRect().top + window.scrollY;
      var lastClientY = event.clientY;
      var moved = false;
      var rafId = 0;

      // Захват на самом списке, а не на handle: insertBefore на мгновение
      // вынимает строку из документа, и захват, висевший на handle внутри
      // неё, браузер сбросил бы прямо посреди жеста (палец «отрывался» бы от
      // строки после первой же перестановки).
      try { list.setPointerCapture(pointerId); } catch (e) { /* мышь без захвата тоже работает */ }
      row.classList.add('dragging');
      list.classList.add('is-reordering');
      document.documentElement.classList.add('is-reordering');

      function follow(clientY) {
        row.style.transform = '';
        var currentTopDoc = row.getBoundingClientRect().top + window.scrollY;
        var pageY = clientY + window.scrollY;
        row.style.transform = 'translateY(' + (startTopDoc + (pageY - startPageY) - currentTopDoc) + 'px)';
      }

      function apply(clientY) {
        placeBy(list, row, clientY);
        follow(clientY);
      }

      // Длинный список (или раскрытая категория) не помещается на экран, а
      // палец во время жеста «прибит» к строке — без автопрокрутки у края
      // переставить элемент дальше видимой области было бы невозможно.
      function tick() {
        rafId = window.requestAnimationFrame(tick);
        if (!moved) return;
        var edge = 72;
        var speed = 0;
        if (lastClientY < edge) speed = -Math.ceil((edge - lastClientY) / 5);
        else if (lastClientY > window.innerHeight - edge) speed = Math.ceil((lastClientY - (window.innerHeight - edge)) / 5);
        if (!speed) return;
        var scrollBefore = window.scrollY;
        window.scrollBy(0, speed);
        if (window.scrollY !== scrollBefore) apply(lastClientY);
      }

      function onMove(moveEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        lastClientY = moveEvent.clientY;
        if (!moved && Math.abs(moveEvent.clientY + window.scrollY - startPageY) < 3) return;
        moved = true;
        apply(moveEvent.clientY);
      }

      function onUp(upEvent) {
        if (upEvent && upEvent.pointerId !== undefined && upEvent.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        if (rafId) window.cancelAnimationFrame(rafId);
        try { list.releasePointerCapture(pointerId); } catch (e) { /* уже отпущен */ }
        row.style.transform = '';
        row.classList.remove('dragging');
        list.classList.remove('is-reordering');
        document.documentElement.classList.remove('is-reordering');
        if (moved && orderOf(list) !== orderBefore) persist(list);
        if (moved) {
          // Категория — это <summary> внутри <details>: клик, завершающий
          // перетаскивание, иначе свернул бы/развернул бы только что
          // переставленную категорию. Перехват снимается и по таймеру —
          // после тач-жеста клик может не прийти вовсе, и «съеденным»
          // оказался бы следующий обычный клик пользователя.
          var swallow = function (clickEvent) {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            release();
          };
          var release = function () {
            window.removeEventListener('click', swallow, true);
            window.clearTimeout(swallowTimer);
          };
          var swallowTimer = window.setTimeout(release, 350);
          window.addEventListener('click', swallow, true);
        }
      }

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      rafId = window.requestAnimationFrame(tick);
    });
  });
})();

// Переключатель наличия блюда (form[data-stock-toggle]).
//
// ГЛАВНОЕ ПРАВИЛО: переключатель показывает то, что РЕАЛЬНО лежит в базе, а не
// то, что человек нажал. Поэтому он не переключается оптимистично: клик
// уходит на тот же адрес, что и обычная отправка формы, сервер отвечает
// фактически сохранённым is_available, и только этот ответ двигает ползунок.
// Ошибка (валидация, сеть, 4xx/5xx) оставляет прежнее положение и показывает
// причину рядом — «успешного» вида при неуспешном сохранении не бывает.
//
// Без JS форма остаётся обычной формой: браузер отправит её сам и перезагрузит
// страницу уже с новым состоянием — поведение то же, просто без анимации.
(function () {
  var forms = document.querySelectorAll('form[data-stock-toggle]');
  if (!forms.length) return;

  forms.forEach(function (form) {
    var toggle = form.querySelector('.stock-toggle');
    var hidden = form.querySelector('input[name="available"]');
    var errorEl = form.querySelector('.stock-error');
    if (!toggle || !hidden) return;

    function showError(message) {
      if (!errorEl) return;
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }

    // Единственное место, где меняется вид переключателя. Принимает уже
    // сохранённое значение (0/1) и приводит к нему и разметку, и то, что
    // отправится следующим кликом.
    function applyState(isAvailable) {
      form.setAttribute('data-state', isAvailable ? 'on' : 'off');
      toggle.setAttribute('aria-checked', isAvailable ? 'true' : 'false');
      hidden.value = isAvailable ? '0' : '1';
    }

    form.addEventListener('submit', function (event) {
      if (typeof window.fetch !== 'function') return; // нет fetch — обычная отправка формы
      event.preventDefault();
      if (form.hasAttribute('data-busy')) return;
      form.setAttribute('data-busy', '');
      toggle.disabled = true;
      showError('');

      // urlencoded, а не FormData: маршрут читает тело обычным
      // express.urlencoded (multipart разбирается только на загрузке фото),
      // и _csrf обязан приехать тем же способом, что и при обычной отправке.
      fetch(form.action, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams(new FormData(form)).toString(),
        credentials: 'same-origin',
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          if (!response.ok || !data || typeof data.is_available !== 'number') {
            throw new Error((data && data.error) || 'Не удалось сохранить. Попробуйте ещё раз.');
          }
          return data;
        });
      }).then(function (data) {
        applyState(data.is_available === 1);
        // Сервер может сообщить о побочном следствии (например, ресторан
        // закрылся, потому что доступных блюд не осталось) — показываем как
        // есть, рядом с переключателем.
        if (data.notice) showError(data.notice);
      }).catch(function (err) {
        // Положение НЕ меняем: в базе осталось прежнее значение.
        showError(err.message || 'Не удалось сохранить.');
      }).then(function () {
        form.removeAttribute('data-busy');
        toggle.disabled = false;
      });
    });
  });
})();

// Поля, растущие по содержимому (textarea[data-autogrow]).
//
// Высота выставляется из scrollHeight: сначала сбрасывается, иначе поле умеет
// только расти и после удаления текста осталось бы прежней высоты. Считаем на
// вводе и один раз при загрузке — уже сохранённый текст должен быть виден
// целиком сразу, без первого нажатия клавиши.
(function () {
  var fields = document.querySelectorAll('textarea[data-autogrow]');
  if (!fields.length) return;

  function fit(el) {
    el.style.height = 'auto';
    // border-box: scrollHeight не включает рамки, поэтому добавляем их сами —
    // иначе поле каждый раз оказывалось бы на пару пикселей ниже текста.
    var styles = window.getComputedStyle(el);
    var borders = parseFloat(styles.borderTopWidth || 0) + parseFloat(styles.borderBottomWidth || 0);
    el.style.height = (el.scrollHeight + borders) + 'px';
  }

  fields.forEach(function (el) {
    fit(el);
    el.addEventListener('input', function () { fit(el); });
  });
  // Ширина поля меняется вместе с окном — вместе с ней меняется и число строк.
  window.addEventListener('resize', function () { fields.forEach(fit); });
})();

// Stage 14 — экран «Настройки»: sheet смены пароля, показ/скрытие пароля,
// защита от повторной отправки.
//
// Формы работают и без этого скрипта: он только показывает/прячет sheet и
// блокирует вторую отправку. Если JS отключён, sheet остаётся открытым при
// ошибке (класс open проставляет сервер), а форма отправляется как обычно.
(function () {
  'use strict';

  function openSheet(name) {
    var el = document.querySelector('[data-sheet="' + name + '"]');
    if (!el) return;
    el.classList.add('open');
    var first = el.querySelector('input:not([type=hidden])');
    if (first) first.focus();
  }

  function closeSheet(el) {
    if (el) el.classList.remove('open');
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open-sheet]');
    if (opener) {
      e.preventDefault();
      openSheet(opener.getAttribute('data-open-sheet'));
      return;
    }

    if (e.target.closest('[data-close-sheet]')) {
      e.preventDefault();
      closeSheet(e.target.closest('.sheet-backdrop'));
      return;
    }

    // Клик по затемнению (но не внутри самого sheet) — закрыть.
    if (e.target.classList && e.target.classList.contains('sheet-backdrop')) {
      closeSheet(e.target);
      return;
    }

    var toggle = e.target.closest('[data-toggle-password]');
    if (toggle) {
      e.preventDefault();
      var input = document.getElementById(toggle.getAttribute('data-toggle-password'));
      if (!input) return;
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? 'Скрыть' : 'Показать';
      toggle.setAttribute('aria-label', hidden ? 'Скрыть пароль' : 'Показать пароль');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('.sheet-backdrop.open');
    if (open) closeSheet(open);
  });

  // Двойной клик по «Сохранить» не должен отправить форму дважды: смена
  // пароля и сохранение реквизитов — не те операции, которые стоит повторять
  // случайно.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.hasAttribute || !form.hasAttribute('data-single-submit')) return;
    if (form.dataset.submitted === '1') {
      e.preventDefault();
      return;
    }
    form.dataset.submitted = '1';
    var btn = form.querySelector('button[type=submit]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Сохраняем…';
    }
  });
})();
