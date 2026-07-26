'use strict';

// YAAM HQ Stage 4.1 — единственное место, которое знает точные правила
// lifecycle-статуса ресторана (задание, раздел 4: "закрепить таблицу
// состояний"). Чистые, не обращающиеся к БД функции — резолвер статуса и
// transition-guards — используются и services/hq/restaurantAdminService.js
// (реальные UPDATE), и hq/restaurantsViews.js (какие кнопки показывать), и
// напрямую юнит-тестами (задание, раздел 15A), одной и той же логикой, не
// двумя потенциально расходящимися копиями.
//
// Модель: is_open отвечает ТОЛЬКО на "принимает ли ресторан заказы прямо
// сейчас", published_at — "виден ли он вообще клиентам". Это два независимых
// измерения (задание, раздел 0) — статус ниже их не путает.
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

const STATUSES = ['draft', 'open', 'closed', 'paused', 'archived'];

const STATUS_LABELS = {
  draft: 'Черновик',
  open: 'Опубликован · открыт',
  closed: 'Опубликован · закрыт',
  paused: 'На паузе',
  archived: 'Архивирован',
};

function isPaused(restaurant, now) {
  if (!restaurant.paused_until) return false;
  const until = restaurant.paused_until instanceof Date ? restaurant.paused_until : new Date(restaurant.paused_until);
  return until.getTime() > now.getTime();
}

// Единственный резолвер итогового статуса — таблица состояний из задания
// (раздел 4), буквально построчно:
//   A. Черновик: published_at=NULL, archived_at=NULL
//   B. Опубликован и открыт: published_at!=NULL, archived_at=NULL, is_open=1
//   C. Опубликован и закрыт: published_at!=NULL, archived_at=NULL, is_open=0, не на паузе
//   D. На паузе: published_at!=NULL, archived_at=NULL, paused_until в будущем
//   E. Архивирован: archived_at!=NULL
// `now` — явный параметр (не Date.now() внутри) — тот же принцип, что и
// dashboardMetrics.todayRangeUtc/resolvePeriodRange, ради чистой
// тестируемости без мока времени.
function resolveLifecycleStatus(restaurant, now = new Date()) {
  if (restaurant.archived_at) return 'archived';
  if (!restaurant.published_at) return 'draft';
  if (isPaused(restaurant, now)) return 'paused';
  return restaurant.is_open ? 'open' : 'closed';
}

// ---------------------------------------------------------------------------
// Transition guards — каждая функция либо молча возвращает (переход
// разрешён), либо бросает ValidationError с понятным русским текстом
// (задание, раздел 9: «Сначала опубликуйте ресторан.» и т.п.). Ни одна не
// трогает БД — вызывающий код (restaurantAdminService) сам решает, выполнять
// ли UPDATE, уже зная, что переход валиден.
// ---------------------------------------------------------------------------

function assertCanPublish(restaurant) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан в архиве — сначала восстановите его.');
  }
  if (restaurant.published_at) {
    throw new ValidationError('Ресторан уже опубликован.');
  }
}

function assertCanUnpublish(restaurant) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан в архиве.');
  }
  if (!restaurant.published_at) {
    throw new ValidationError('Ресторан ещё не опубликован.');
  }
}

// «Открыть ресторан можно только если: он опубликован; не архивирован; не на
// паузе» (задание, раздел 9, дословно) — черновик отклоняется отдельным
// понятным сообщением, не общим "нельзя".
function assertCanOpen(restaurant, now = new Date()) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан в архиве.');
  }
  if (!restaurant.published_at) {
    throw new ValidationError('Сначала опубликуйте ресторан.');
  }
  if (isPaused(restaurant, now)) {
    throw new ValidationError('Ресторан на паузе — сначала возобновите приём заказов.');
  }
  if (restaurant.is_open) {
    throw new ValidationError('Ресторан уже открыт.');
  }
}

// Симметричный «Закрыть» — вручную, бессрочно, отдельно от таймированной
// паузы (задание описывает состояние C «Опубликован и закрыт» как
// самостоятельное целевое состояние, не только транзитное между публикацией
// и первым открытием — без этого действия оно было бы недостижимо повторно).
function assertCanClose(restaurant, now = new Date()) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан в архиве.');
  }
  if (!restaurant.published_at) {
    throw new ValidationError('Ресторан не опубликован.');
  }
  if (isPaused(restaurant, now)) {
    throw new ValidationError('Ресторан на паузе.');
  }
  if (!restaurant.is_open) {
    throw new ValidationError('Ресторан уже закрыт.');
  }
}

// «Пауза разрешена только опубликованному неархивированному ресторану. Для
// черновика — пауза бессмысленна и должна быть недоступна» (задание, раздел
// 9, дословно).
function assertCanPause(restaurant, now = new Date()) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан в архиве.');
  }
  if (!restaurant.published_at) {
    throw new ValidationError('Сначала опубликуйте ресторан.');
  }
  if (isPaused(restaurant, now)) {
    throw new ValidationError('Ресторан уже на паузе.');
  }
  if (!restaurant.is_open) {
    throw new ValidationError('Ресторан закрыт — поставить на паузу можно только открытый.');
  }
}

// Resume — ТОЛЬКО снятие реальной паузы (задание: «не открывает ресторан
// автоматически, если он был закрыт [а не на паузе]») — намеренно НЕ
// используется как скрытый способ открыть вручную закрытый ресторан, для
// этого есть отдельное assertCanOpen/openRestaurant.
function assertCanResume(restaurant, now = new Date()) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан в архиве.');
  }
  if (!isPaused(restaurant, now)) {
    throw new ValidationError('Ресторан не на паузе.');
  }
}

function assertCanArchive(restaurant) {
  if (restaurant.archived_at) {
    throw new ValidationError('Ресторан уже в архиве.');
  }
}

function assertCanRestore(restaurant) {
  if (!restaurant.archived_at) {
    throw new ValidationError('Ресторан не в архиве.');
  }
}

module.exports = {
  ValidationError,
  STATUSES,
  STATUS_LABELS,
  resolveLifecycleStatus,
  assertCanPublish,
  assertCanUnpublish,
  assertCanOpen,
  assertCanClose,
  assertCanPause,
  assertCanResume,
  assertCanArchive,
  assertCanRestore,
};
