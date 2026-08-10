'use strict';

// YAAM Stage 38 — единственная граница между продуктовыми целыми рублями
// (то, что вводит владелец ресторана: цена блюда, минимальная сумма заказа)
// и финансовым ядром в integer minor units (копейках): комиссия, платежи,
// возвраты, расчётные периоды, корректировки, долг, выплаты.
//
// Утверждённая владельцем денежная модель (Stage 38, раздел 0):
//   - продуктовый слой остаётся целыми рублями (350 ₽, не 349.99 ₽);
//   - финансовое ядро хранит и считает ТОЛЬКО integer minor units
//     (1 ₽ = 100 minor units), никогда float как source of truth;
//   - переход рубли -> minor units происходит РОВНО ОДИН РАЗ, внутри
//     orderService.js:createOrder(), когда доверенные (server-side)
//     цены позиций суммируются в items_total.
//
// Это единственный файл, который знает про коэффициент 100 — ни один
// другой модуль не должен умножать/делить денежную сумму на 100 напрямую
// (задание, раздел 2: "не размазывать один и тот же ×100 по нескольким
// местам — тогда кто-то посчитает дважды, кто-то забудет посчитать").
const MINOR_UNITS_PER_RUBLE = 100;

// Строгая проверка входа: только целое число рублей. JS float на этой
// границе означал бы, что где-то выше по стеку уже накопилась
// нецелочисленная сумма — это симптом более раннего бага, а не то, что
// эта функция должна молча "исправлять" округлением.
function rublesToMinor(integerRubles) {
  if (!Number.isInteger(integerRubles)) {
    throw new TypeError(`rublesToMinor: ожидается целое число рублей, получено ${integerRubles}`);
  }
  return integerRubles * MINOR_UNITS_PER_RUBLE;
}

// Единственный формат отображения minor units человеку (владельцу в HQ,
// клиенту, документам) — "418 ₽" для круглых сумм, "73,50 ₽" для сумм с
// копейками, без лишнего ",00" на круглых суммах (задание, раздел 13:
// "без ненужного 418,00 ₽").
function formatMinorRub(amountMinor) {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`formatMinorRub: ожидается целое число minor units, получено ${amountMinor}`);
  }
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const rubles = Math.floor(abs / MINOR_UNITS_PER_RUBLE);
  const kopecks = abs % MINOR_UNITS_PER_RUBLE;
  const sign = negative ? '−' : '';
  if (kopecks === 0) return `${sign}${rubles} ₽`;
  return `${sign}${rubles},${String(kopecks).padStart(2, '0')} ₽`;
}

// ---------------------------------------------------------------------------
// Провайдерская граница (Stage 38, раздел 8). services/paymentService.js и
// оба провайдера (mockProvider.js/yookassaProvider.js) СОЗНАТЕЛЬНО НЕ
// переведены на minor units — они общие с legacy SQLite-путём
// (services/orderService.js тоже требует paymentService.js), а Stage 38
// касается только PostgreSQL-финансового ядра (CLAUDE.md: "SQLite и
// PostgreSQL paths нельзя незаметно смешивать в одном сервисе"). Поэтому
// вся граница minor<->рубли для провайдерского вызова лежит на стороне
// ВЫЗЫВАЮЩЕГО (services/postgresql/orderService.js), не внутри самого
// paymentService.js. minorToRublesNumber — для НОВОГО (исходящего) вызова
// paymentService.createPayment/refundPayment (тот принимает число рублей,
// как и раньше); minorToRubleDecimalString/rubleDecimalStringToMinor — для
// точного сравнения/разбора decimal-string сумм (например webhook
// event.amount) без повторного float-умножения.
function minorToRublesNumber(amountMinor) {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`minorToRublesNumber: ожидается целое число minor units, получено ${amountMinor}`);
  }
  return amountMinor / MINOR_UNITS_PER_RUBLE;
}

function minorToRubleDecimalString(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new TypeError(`minorToRubleDecimalString: ожидается неотрицательное целое minor units, получено ${amountMinor}`);
  }
  const rubles = Math.floor(amountMinor / MINOR_UNITS_PER_RUBLE);
  const kopecks = amountMinor % MINOR_UNITS_PER_RUBLE;
  return `${rubles}.${String(kopecks).padStart(2, '0')}`;
}

// Обратное преобразование — разбор строки посимвольно (RegExp на целую и
// дробную часть), не Number(str)*100 (тот же класс ошибки, которого эта
// граница обязана избежать — 1050.29*100 в float даёт 104999.99999999999,
// не 105029).
function rubleDecimalStringToMinor(value) {
  const s = String(value);
  const m = /^(\d+)\.(\d{2})$/.exec(s);
  if (!m) {
    throw new TypeError(`rubleDecimalStringToMinor: ожидается строка вида "X.YY", получено ${JSON.stringify(value)}`);
  }
  const [, rublesPart, kopecksPart] = m;
  return Number(rublesPart) * MINOR_UNITS_PER_RUBLE + Number(kopecksPart);
}

// Формула комиссии — структурно та же, что и в Stage 7/37
// (Math.round(amount*bps/10000)), только теперь применяется к minor units,
// а не к рублям, поэтому и результат имеет точность до копейки, а не до
// рубля. Integer-safe без BigInt: при реалистичных для YAAM суммах
// (amountMinor * commissionBps) остаётся на много порядков ниже
// Number.MAX_SAFE_INTEGER (см. отчёт Stage 38, раздел "Rounding rule" —
// проверено исчерпывающим тестом).
function computeCommissionMinor(amountMinor, commissionBps) {
  return Math.round((amountMinor * commissionBps) / 10000);
}

module.exports = {
  MINOR_UNITS_PER_RUBLE,
  rublesToMinor,
  formatMinorRub,
  minorToRublesNumber,
  minorToRubleDecimalString,
  rubleDecimalStringToMinor,
  computeCommissionMinor,
};
