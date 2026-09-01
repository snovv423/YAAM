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
    function setOpen(value) {
      editor.classList.toggle('is-open', value);
      open.setAttribute('aria-expanded', String(value));
    }
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
      });
    });
  });
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

  function itemsOf(list) {
    return Array.prototype.slice.call(
      list.getAttribute('data-reorder') === 'categories'
        ? list.querySelectorAll(':scope > .cat-block')
        : list.querySelectorAll(':scope > .dish-row')
    );
  }

  function idOf(el) {
    return el.getAttribute('data-category-id') || el.getAttribute('data-item-id');
  }

  function persist(list) {
    var endpoint = list.getAttribute('data-endpoint');
    if (!endpoint) return;
    var tokenInput = document.querySelector('input[name="_csrf"]');
    if (!tokenInput) return;
    var order = itemsOf(list).map(idOf).filter(Boolean);
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _csrf: tokenInput.value, order: order })
    }).catch(function () { /* порядок применится при следующей попытке; страница не ломается */ });
  }

  lists.forEach(function (list) {
    list.addEventListener('pointerdown', function (event) {
      var handle = event.target.closest('.drag-handle');
      if (!handle || !list.contains(handle)) return;
      var row = handle.closest('.cat-block') || handle.closest('.dish-row');
      if (!row) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      row.classList.add('dragging');

      function onMove(moveEvent) {
        var target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        if (!target) return;
        var overRow = target.closest('.cat-block') || target.closest('.dish-row');
        if (!overRow || overRow === row || overRow.parentNode !== list) return;
        var rect = overRow.getBoundingClientRect();
        var after = moveEvent.clientY > rect.top + rect.height / 2;
        list.insertBefore(row, after ? overRow.nextSibling : overRow);
      }

      function onUp() {
        row.classList.remove('dragging');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        persist(list);
      }

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  });
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
