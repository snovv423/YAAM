// Загружает реальный client/js/app.js (вместе с data.js/api.js — тот же
// порядок, что в index.html) в изолированный vm-контекст с минимальными
// заглушками DOM/localStorage. Не требует новых зависимостей (jsdom и т.п.) —
// только встроенный node:vm. Цель — тестировать РЕАЛЬНЫЙ файл, а не его
// переписанную копию.
//
// Ограничение (честно): это не полноценный браузер — визуальный рендеринг,
// CSS, реальные события мыши/клавиатуры не воспроизводятся. Для логики этой
// задачи (сохранение/восстановление qrDeadline в localStorage, какая функция
// какой сценарий вызывает) этого достаточно и детерминировано;
// для полной уверенности всё равно нужен живой прогон в браузере (см. отчёт).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

function makeFakeElement(id) {
  const listeners = {};
  return {
    id,
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    innerHTML: '',
    value: '',
    disabled: false,
    // YAAM HQ Stage 5B — прежний стаб был read-only (set() всегда сообщал
    // об успехе, но ничего не сохранял), из-за чего renderGallery()/
    // gallerySet() (client/js/app.js) нельзя было проверить: любое чтение
    // .style.display после записи всегда давало ''. Теперь Proxy реально
    // хранит значения — существующие тесты этого не касались (ни один
    // test/*.test.js до Stage 5B не читал .style.*), так что это чистое
    // расширение возможностей, не смена уже проверяемого поведения.
    // YAAM HQ Stage 5B.1 — setProperty/getPropertyValue добавлены как
    // настоящие методы (не свойства style.<name>=...) — .dhero::before
    // читает CSS custom property --dhero-bg, которую app.js выставляет
    // через style.setProperty(), а не прямым присваиванием.
    style: (() => {
      const store = {};
      return new Proxy(store, {
        get: (target, key) => {
          if (key === 'setProperty') return (name, value) => { target[name] = value; };
          if (key === 'getPropertyValue') return (name) => (name in target ? target[name] : '');
          return key in target ? target[key] : '';
        },
        set: (target, key, value) => { target[key] = value; return true; },
      });
    })(),
    // Реальный, а не всегда-false стаб — нужен для cur(id) (используется и
    // существующим app.js, и новыми тестами order-state-machine hardening,
    // проверяющими go('status')/go('rejected') через cur()). Прежний
    // всегда-false стаб ни один существующий тест не проверял напрямую (см.
    // отсутствие classList/cur( в остальных test/*.test.js), так что это
    // расширение возможностей, а не смена уже проверяемого поведения.
    classList: (() => {
      const set = new Set();
      return {
        add(cls) { set.add(cls); },
        remove(cls) { set.delete(cls); },
        toggle(cls) { if (set.has(cls)) { set.delete(cls); return false; } set.add(cls); return true; },
        contains(cls) { return set.has(cls); },
      };
    })(),
    dataset: {},
    attributes: {},
    onclick: null,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild() {},
    insertBefore() {},
    querySelector() { return makeFakeElement(id + '__child'); },
    querySelectorAll() { return []; },
    animate() {},
    focus() {},
    click() {},
    closest() { return this; }, // достаточно для validateCheckout() (toggle .err на "ближайшем" поле)
    offsetHeight: 0,
    // Раньше classList.contains() был всегда-false стабом (см. выше), поэтому
    // cur('home')-guard в onScroll() (initIntroLayerFX(), app.js) никогда не
    // пропускал выполнение дальше и getBoundingClientRect() не вызывался.
    // Теперь classList стал реальным — go('home') может делать cur('home')
    // истинным, и без этого стаба это падало бы TypeError на любом тесте,
    // вызывающем resetAll()/go('home').
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}

function createSandbox({ apiBaseUrl, locationSearch, locationHref, useProductionDefault = false } = {}) {
  const store = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  const sessionStore = {};
  const sessionStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null),
    setItem: (k, v) => { sessionStore[k] = String(v); },
    removeItem: (k) => { delete sessionStore[k]; },
    clear: () => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; },
  };

  const elementCache = new Map();
  const documentStub = {
    getElementById(id) {
      if (!elementCache.has(id)) elementCache.set(id, makeFakeElement(id));
      return elementCache.get(id);
    },
    querySelector() { return makeFakeElement('__qs'); },
    querySelectorAll() { return []; },
    createElement() { return makeFakeElement('__created'); },
    addEventListener() {},
    removeEventListener() {},
    body: makeFakeElement('body'),
    documentElement: makeFakeElement('documentElement'),
  };

  let webLockTail = Promise.resolve();
  const sandbox = {
    console,
    localStorage,
    sessionStorage,
    document: documentStub,
    navigator: {
      vibrate() {},
      locks: {
        request(_name, _options, task) {
          const run = webLockTail.then(task);
          webLockTail = run.catch(() => {});
          return run;
        },
      },
    },
    crypto: webcrypto,
    Uint8Array,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    history: { pushState() {}, replaceState() {} },
    // Реальные URL/URLSearchParams (Node built-ins) — Stage 11A staging-
    // activation логика в api.js их использует; без них resolveApiBaseUrl()
    // просто безопасно откатывается на demo (try/catch), но чтобы РЕАЛЬНО
    // протестировать саму активацию, они здесь нужны настоящими.
    URL,
    URLSearchParams,
    location: { href: locationHref || ('https://yaam.su/' + (locationSearch || '')), search: locationSearch || '' },
    requestAnimationFrame: (fn) => fn(),
    AbortController,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Promise, Error,
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    // YAAM HQ Stage 5B — doOpenRest()/openDish() (client/js/app.js) создают
    // `new Image()` для hero-фото с onerror-фолбэком на заглушку; браузерный
    // global, которого раньше не было в этом стабе (ни один тест до этого не
    // проходил через ветку с реальным photoUrl/im — см. hasSrc-проверки).
    Image: class {
      constructor() { this.src = ''; this.alt = ''; this.onerror = null; }
      remove() {}
    },
  };
  sandbox.window = sandbox; // как в реальном браузере — window === глобальный объект
  if (!useProductionDefault) {
    sandbox.window.__YAAM_TEST_MODE__ = true;
    sandbox.window.__YAAM_TEST_API_BASE_URL = apiBaseUrl || null;
  }
  // Старые unit-тесты изолированы от production API через test-only override.
  sandbox.fetch = async () => { throw new Error('fetch не должен вызываться в demo-режиме этого теста'); };

  vm.createContext(sandbox);
  return { sandbox, store, elementCache };
}

function loadAppInSandbox(sandbox) {
  const clientDir = path.join(__dirname, '..', '..', 'js');
  for (const file of ['data.js', 'api.js', 'app.js']) {
    const code = fs.readFileSync(path.join(clientDir, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
}

// app.js объявляет своё состояние через top-level let/const — такие биндинги
// НЕ становятся свойствами sandbox-объекта (в отличие от var), поэтому
// снаружи их нельзя ни прочитать, ни записать через sandbox.qrDeadline.
// evalInContext выполняет код в ТОМ ЖЕ контексте (та же лексическая область
// видимости) — это единственный способ читать/писать currentOrderCode,
// qrDeadline и т.п. напрямую, без изменения production-кода ради тестов.
function evalInContext(sandbox, code) {
  return vm.runInContext(code, sandbox);
}

// Останавливает все интервалы/таймауты, которые могли быть запущены во время
// теста (qrInterval, preTimer, preAutoTimer, orderPollTimer, sharedViewPollTimer)
// — чтобы один тест не "звонил" в уже завершившийся тестовый процесс другого
// файла. sharedViewPollTimer — фича «Поделиться заказом» (openSharedOrder()),
// тот же риск незавершённого setInterval, что и у orderPollTimer.
function teardown(sandbox) {
  evalInContext(sandbox, `
    try{clearInterval(qrInterval);}catch(e){}
    try{clearInterval(preTimer);}catch(e){}
    try{clearTimeout(preAutoTimer);}catch(e){}
    try{clearInterval(orderPollTimer);}catch(e){}
    try{clearInterval(sharedViewPollTimer);}catch(e){}
  `);
}

module.exports = { createSandbox, loadAppInSandbox, evalInContext, teardown };
