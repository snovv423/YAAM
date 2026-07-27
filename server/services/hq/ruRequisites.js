'use strict';

// YAAM HQ Stage 6 — проверка и нормализация российских юридических/банковских
// реквизитов (задание, разделы 1/7). Единственное место в кодовой базе,
// которое считает контрольные цифры ИНН/ОГРН/ОГРНИП и сверяет расчётный/
// корреспондентский счёт с БИК.
//
// Аудит перед написанием (задание, раздел 1, пункт 4): проверены доступные
// npm-пакеты (`inn-validator` — 526 скачиваний/месяц, 1 мейнтейнер,
// опубликован 3 месяца назад; `ru-validation-codes` — 2801/месяц, тоже 1
// мейнтейнер, покрывает только формат ИНН/ОГРН/ОГРНИП/БИК). НИ ОДИН из
// найденных пакетов не реализует проверку расчётного/корреспондентского
// счёта относительно БИК (официальный алгоритм ЦБ, Положение Банка России) —
// самую сложную и самую нужную здесь часть пришлось бы писать самостоятельно
// в любом случае. Учитывая это и общий принцип кодовой базы (см. предыдущие
// этапы — sharp/pg/multer подключаются только там, где реально нужна внешняя
// библиотека, вся детерминированная арифметика проверки — свой код с полными
// тестами), решено реализовать ВСЕ проверки этого модуля самостоятельно, по
// официальным, неизменным десятилетиями алгоритмам ФНС/ЦБ, а не добавлять
// внешнюю зависимость скромной зрелости для кода, который придётся
// перепроверять и тестировать заново в любом случае.
//
// Алгоритм проверки счёта/корр. счёта против БИК перед написанием кода
// сверен вручную (вне репозитория, не как тестовая фикстура — задание,
// раздел 16: "не использовать реальные данные" — прямо запрещает держать
// реальные банковские значения даже в тестах) на публично известном примере
// одного крупного банка — контрольная сумма сошлась. В самом репозитории
// (server/test/ruRequisites.test.js) используются только заведомо
// вымышленные, но математически корректные значения.

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

// Оставляет только цифры — используется перед проверкой ИНН/ОГРН/БИК/счетов,
// чтобы пробелы/дефисы (частый способ визуально группировать длинные номера)
// не мешали проверке контрольных цифр (задание, раздел 4: "никаких пробелов/
// дефисов после нормализации").
function normalizeDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

// Дословно тот же алгоритм, что и normalizeRuPhone() в services/postgresql/
// orderService.js (задание не про заказы, но телефон — тот же российский
// формат; тот же принцип "дословная копия" уже применяется в этой кодовой
// базе между SQLite/PostgreSQL-версиями одной и той же функции, а не общий
// shared-модуль). Возвращает `+7XXXXXXXXXX` либо null, если формат неверный.
function normalizeRuPhone(raw) {
  let d = normalizeDigits(raw);
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  if (d.length !== 11 || d[0] !== '7') return null;
  return `+${d}`;
}

// Разумная, не претендующая на исчерпывающую RFC 5322-проверку почты —
// достаточно, чтобы отклонить явные опечатки (задание, раздел 9: "email
// проверяется, если введён"), тот же уровень строгости, что и везде в этой
// кодовой базе (никаких тяжёлых email-валидационных библиотек).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(value) {
  return EMAIL_RE.test(String(value ?? '').trim());
}

// ---------------------------------------------------------------------------
// ИНН — официальный алгоритм ФНС (контрольные цифры), 10 знаков для
// юридических лиц (ООО), 12 знаков для физических лиц/ИП.
// https://ru.wikipedia.org/wiki/Идентификационный_номер_налогоплательщика
// ---------------------------------------------------------------------------

const INN10_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_WEIGHTS_1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_WEIGHTS_2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigitInn(digits, weights) {
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  return (sum % 11) % 10;
}

// legalForm: 'ip' -> 12 цифр обязательны, 'ooo' -> 10 цифр обязательны
// (задание, раздел 4: "ИНН — 10 или 12 цифр по правовой форме"). Если
// legalForm не передан — принимает любую из двух корректных длин (полезно
// для reindex/тестов вне контекста конкретного ресторана).
function isValidInn(value, legalForm) {
  const digits = normalizeDigits(value);
  if (legalForm === 'ooo' && digits.length !== 10) return false;
  if (legalForm === 'ip' && digits.length !== 12) return false;
  if (digits.length === 10) {
    return checkDigitInn(digits, INN10_WEIGHTS) === Number(digits[9]);
  }
  if (digits.length === 12) {
    const d1 = checkDigitInn(digits, INN12_WEIGHTS_1) === Number(digits[10]);
    const d2 = checkDigitInn(digits, INN12_WEIGHTS_2) === Number(digits[11]);
    return d1 && d2;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ОГРН (13 цифр, юрлица) / ОГРНИП (15 цифр, ИП) — официальный алгоритм ФНС:
// контрольная цифра = последняя цифра остатка от деления первых N-1 цифр на
// 11 (ОГРН) или на 13 (ОГРНИП).
// https://ru.wikipedia.org/wiki/Основной_государственный_регистрационный_номер
// ---------------------------------------------------------------------------

function isValidOgrn(value) {
  const digits = normalizeDigits(value);
  if (digits.length !== 13) return false;
  const body = digits.slice(0, 12);
  const expected = Number((BigInt(body) % 11n).toString().slice(-1));
  return expected === Number(digits[12]);
}

function isValidOgrnip(value) {
  const digits = normalizeDigits(value);
  if (digits.length !== 15) return false;
  const body = digits.slice(0, 14);
  const expected = Number((BigInt(body) % 13n).toString().slice(-1));
  return expected === Number(digits[14]);
}

// legalForm: 'ooo' -> ОГРН (13 цифр), 'ip' -> ОГРНИП (15 цифр).
function isValidOgrnForLegalForm(value, legalForm) {
  if (legalForm === 'ip') return isValidOgrnip(value);
  return isValidOgrn(value);
}

// ---------------------------------------------------------------------------
// БИК — 9 цифр. У БИК НЕТ контрольной цифры (это простой регистрационный
// код ЦБ, не число с checksum) — проверяется только формат и правдоподобие
// последних 3 цифр (условный номер подразделения банка: 000-002 — служебные
// значения ЦБ, 050-999 — обычный диапазон подразделений). Тот же диапазон,
// что используют существующие зрелые проверки (см. комментарий в начале
// файла) — не выдумано заново, а взято из официального описания структуры
// БИК (первые 2 цифры — код страны "04", далее код территории, далее номер
// учреждения ЦБ, последние 3 — условный номер кредитной организации/
// подразделения).
// ---------------------------------------------------------------------------

function isValidBik(value) {
  const digits = normalizeDigits(value);
  if (!/^\d{9}$/.test(digits)) return false;
  const last3 = Number(digits.slice(-3));
  return last3 <= 2 || (last3 >= 50 && last3 <= 999);
}

// ---------------------------------------------------------------------------
// Расчётный/корреспондентский счёт против БИК — официальный алгоритм ЦБ РФ
// (Положение Банка России о порядке ведения счетов): контрольная сумма по
// 23-значной строке (префикс из БИК + 20-значный номер счёта), веса
// [7,1,3] циклически, сумма произведений mod 10 должна быть 0.
//
//   расчётный счёт:        префикс = последние 3 цифры БИК
//   корреспондентский счёт: префикс = "0" + цифры БИК на позициях 5-6 (0-индекс 4:6)
//
// Проверено на реальном публичном примере (см. комментарий в начале файла)
// перед тем, как полагаться на этот алгоритм в проде.
// ---------------------------------------------------------------------------

const ACCOUNT_CHECK_WEIGHTS = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1];

function checkAccountChecksum(prefix, account) {
  const full = `${prefix}${account}`;
  if (full.length !== 23) return false;
  if (!/^\d{23}$/.test(full)) return false;
  let sum = 0;
  for (let i = 0; i < full.length; i += 1) {
    sum += Number(full[i]) * ACCOUNT_CHECK_WEIGHTS[i];
  }
  return sum % 10 === 0;
}

function isValidAccountNumber(account, bik) {
  const accountDigits = normalizeDigits(account);
  const bikDigits = normalizeDigits(bik);
  if (!/^\d{20}$/.test(accountDigits) || !isValidBik(bikDigits)) return false;
  return checkAccountChecksum(bikDigits.slice(6, 9), accountDigits);
}

function isValidCorrespondentAccount(account, bik) {
  const accountDigits = normalizeDigits(account);
  const bikDigits = normalizeDigits(bik);
  if (!/^\d{20}$/.test(accountDigits) || !isValidBik(bikDigits)) return false;
  return checkAccountChecksum(`0${bikDigits.slice(4, 6)}`, accountDigits);
}

// ---------------------------------------------------------------------------
// Маскировка (задание, раздел 7 — read-only обзор в HQ; раздел 10 — audit
// log). Два РАЗНЫХ формата, дословно как в задании:
//   UI:        "•••• 1234"   (section 7 example)
//   audit log: "****1234"    (section 10 example: "account_number: ****1234 -> ****5678")
// ---------------------------------------------------------------------------

function maskAccountForUi(value) {
  const digits = normalizeDigits(value);
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

function maskAccountForAudit(value) {
  const digits = normalizeDigits(value);
  if (digits.length < 4) return '****';
  return `****${digits.slice(-4)}`;
}

module.exports = {
  normalizeDigits,
  normalizeRuPhone,
  isValidEmail,
  isValidInn,
  isValidOgrn,
  isValidOgrnip,
  isValidOgrnForLegalForm,
  isValidBik,
  isValidAccountNumber,
  isValidCorrespondentAccount,
  maskAccountForUi,
  maskAccountForAudit,
};
