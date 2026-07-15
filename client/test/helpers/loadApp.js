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
    style: new Proxy({}, { get: () => '', set: () => true }),
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

function createSandbox({ apiBaseUrl } = {}) {
  const store = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
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
    location: { href: '' },
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
  };
  sandbox.window = sandbox; // как в реальном браузере — window === глобальный объект
  sandbox.window.YAAM_API_BASE_URL = apiBaseUrl || undefined;
  // fetch не используется в demo-режиме (USE_API=false, apiBaseUrl не задан) —
  // тестовые сценарии этой задачи все проходят через demo-ветку app.js.
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
// теста (qrInterval, preTimer, preAutoTimer, orderPollTimer) — чтобы один
// тест не "звонил" в уже завершившийся тестовый процесс другого файла.
function teardown(sandbox) {
  evalInContext(sandbox, `
    try{clearInterval(qrInterval);}catch(e){}
    try{clearInterval(preTimer);}catch(e){}
    try{clearTimeout(preAutoTimer);}catch(e){}
    try{clearInterval(orderPollTimer);}catch(e){}
  `);
}

module.exports = { createSandbox, loadAppInSandbox, evalInContext, teardown };
