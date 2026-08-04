'use strict';

// Stage 27 — единственное место HQ-представлений, конвертирующее TIMESTAMPTZ
// в московское время для показа владельцу.
//
// ПОЧЕМУ ЭТО ПОТРЕБОВАЛОСЬ. Хранение в БД — всегда UTC (PostgreSQL
// TIMESTAMPTZ), это не меняется и не должно меняться. Но владелец вводит и
// воспринимает время как Europe/Moscow — та же константа
// PROJECT_TIMEZONE_OFFSET_MINUTES уже используется в двух местах: разбор
// формы "Дата и время платежа" (services/hq/payoutService.js,
// parseProjectLocalDateTime) и Центр событий
// (services/hq/eventLogService.js, formatEventTimestamp). До Stage 27
// formatDateTime в payoutViews.js/settlementViews.js/
// settlementDocumentViews.js/restaurantsViews.js каждый определял СВОЮ копию
// на сырых getUTCHours() без какого-либо сдвига и без пометки часового
// пояса — то есть реально показывал UTC, расходясь и с Центром событий, и с
// тем, что владелец только что сам ввёл в форму (Stage 26, раздел 2: ввод
// "20:00" по Москве давал на экране "17:00" без единого объяснения, что это
// другой пояс).
//
// Здесь — только сам сдвиг (toMskDate), не полный форматтер: у разных
// экранов HQ разные, уже устоявшиеся визуальные форматы дат (ISO-подобный
// "YYYY-MM-DD HH:mm" на карточке выплаты и расчётном периоде, точечный
// "DD.MM.YYYY HH:mm[:ss]" на документах и в истории ресторана) — Stage 27
// не меняет эти форматы, только чинит часовой пояс под ними и требует
// суффикса "МСК" рядом с каждым значением.
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('../services/hq/dashboardMetrics');

// Возвращает Date, чьи getUTC*() уже отражают московское время суток —
// тот же приём, что и в eventLogService.formatEventTimestamp: не полагаемся
// на часовой пояс ОС процесса (toLocaleString и т.п.), сдвигаем сам момент
// времени на фиксированные +180 минут и читаем компоненты как UTC.
// Возвращает null для отсутствующего/невалидного значения — вызывающий код
// сам решает, как честно показать "даты нет" (обычно "—"), а не рисует
// придуманную дату.
function toMskDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
}

// Суффикс, который обязан стоять рядом с любым значением времени в HQ,
// показывающим момент (не календарную дату без времени — period_from/
// period_to остаются как есть, это отдельная, уже закрытая область).
const MSK_SUFFIX = ' МСК';

module.exports = { toMskDate, MSK_SUFFIX, PROJECT_TIMEZONE_OFFSET_MINUTES };
