'use strict';

// YAAM — PostgreSQL restaurant-pause scheduler, Production Switch Stage 5
// (изолированный, не запускающийся автоматически модуль).
//
// SQLite-оригинал НЕ имеет отдельного "scheduler"-модуля вообще — в
// server.js это три голых `setInterval(() => orderService.sweepXxx(), N)`
// без какой-либо lifecycle-обёртки (нет clearInterval, нет graceful
// shutdown этих таймеров, нет способа их остановить программно). Задание
// Stage 5 прямо требует явную start()/stop() модель для PostgreSQL-версии —
// это НОВАЯ, добавленная здесь абстракция (не перенос существующего
// SQLite-модуля, которого не существует), спроектированная так, чтобы
// корректно освобождать таймер и явно завершаться — то, чего исходные три
// строки в server.js структурно не умеют.
//
// Этот модуль НЕ импортируется ни из server.js, ни откуда-либо ещё в
// приложении — та же архитектурная граница, что у routes/postgresql/,
// bot/postgresql/, routes/postgresql/admin.js. НЕ запускается
// автоматически при require() — создание фабрикой (createPauseExpiryScheduler)
// НЕ стартует таймер, требуется явный .start().
//
// Использует только server/services/postgresql/orderService.js
// (sweepPauseExpiry, Stage 5) — не открывает SQLite DatabaseSync ни прямо,
// ни как побочный эффект require().

const pgOrderService = require('./orderService');

// Тот же интервал, что и server.js для sweepPauseExpiry (30 секунд) —
// сохранён по умолчанию для параметра, но НЕ жёстко зашит: тесты передают
// свой, короткий intervalMs, не дожидаясь реальных 30 секунд.
const DEFAULT_INTERVAL_MS = 30_000;

// createPauseExpiryScheduler(options) — фабрика, не singleton: можно создать
// несколько независимых инстансов (например, тест создаёт новый инстанс на
// каждый сценарий, не разделяя состояние между тестами).
//
// options.intervalMs — период между sweep'ами (default 30с, как в server.js).
// options.onError(err) — вызывается, если sweepPauseExpiry() бросил
//   исключение внутри тика; если не передан — логируется в console.error.
//   Один неудачный тик НЕ останавливает scheduler и не мешает следующему
//   (тот же принцип устойчивости, что и у sweepTimeouts/sweepStuckRefunds в
//   SQLite-оригинале — падение одного прогона не должно ронять весь процесс).
function createPauseExpiryScheduler({ intervalMs = DEFAULT_INTERVAL_MS, onError } = {}) {
  let timer = null;

  async function tick() {
    try {
      await pgOrderService.sweepPauseExpiry();
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] sweepPauseExpiry failed:', err.message);
    }
  }

  return {
    // Идемпотентен — повторный start() на уже запущенном scheduler'е НЕ
    // создаёт второй таймер (не накапливает интервалы).
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      // unref() — таймер не удерживает Node-процесс живым сам по себе
      // (актуально для короткоживущих скриптов/тестов, которые забыли
      // вызвать stop() явно в edge-кейсе; НЕ заменяет собой обязательный
      // явный stop() в нормальном потоке управления, только подстраховка
      // от "зависшего" процесса из-за забытого таймера).
      if (typeof timer.unref === 'function') timer.unref();
    },

    // Идемпотентен — повторный stop() на уже остановленном scheduler'е
    // безопасен (не бросает).
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    isRunning() {
      return timer !== null;
    },

    // Тестовый (и operational — например, ручной запуск sweep'а из ops-
    // инструмента) хук: выполняет ровно один sweep немедленно, не дожидаясь
    // таймера. Не зависит от того, запущен ли scheduler через start().
    async runOnce() {
      await tick();
    },
  };
}

// ---------------------------------------------------------------------------
// Production Switch — Stage 8: order-timeout и refund-reconciliation schedulers
// ---------------------------------------------------------------------------
//
// SQLite-оригинал (server.js) запускает sweepTimeouts (окно ответа
// ресторана, 3 минуты) и sweepStuckRefunds (сверка "зависших" возвратов)
// как два голых setInterval — та же ситуация, что уже была у sweepPauseExpiry
// до Stage 5 (см. header-комментарий createPauseExpiryScheduler выше). До
// этой задачи ни один из двух не был подключён к PostgreSQL-стороне вообще:
// sweepTimeouts не запускался периодически НИКЕМ (заказы никогда не
// истекали бы по таймауту), а sweepStuckRefunds на PostgreSQL-стороне до
// Stage 8 просто не существовал (см. services/postgresql/orderService.js —
// весь refund network orchestration добавлен этой же задачей). Оба —
// новые, явные start()/stop() обёртки, тем же паттерном, что и
// createPauseExpiryScheduler (не singleton, не auto-start, идемпотентны,
// unref'нутый таймер, runOnce() для тестов/ops).

const DEFAULT_ORDER_TIMEOUT_INTERVAL_MS = 10_000; // тот же интервал, что sweepTimeouts в server.js
const DEFAULT_REFUND_RECONCILIATION_INTERVAL_MS = 10_000; // тот же интервал, что sweepStuckRefunds в server.js

function createOrderTimeoutScheduler({ intervalMs = DEFAULT_ORDER_TIMEOUT_INTERVAL_MS, onError } = {}) {
  let timer = null;

  async function tick() {
    try {
      await pgOrderService.sweepTimeouts();
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] sweepTimeouts failed:', err.message);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
    async runOnce() {
      await tick();
    },
  };
}

// options.limit — прокинут в sweepStuckRefunds({limit}) (bounded batch, см.
// orderService.js) — конфигурируемо для тестов (маленький batch на
// маленьком тестовом наборе строк не имеет значения, но параметр не должен
// быть жёстко зашит на случай будущей ops-настройки).
function createRefundReconciliationScheduler({ intervalMs = DEFAULT_REFUND_RECONCILIATION_INTERVAL_MS, limit, onError } = {}) {
  let timer = null;

  async function tick() {
    try {
      await pgOrderService.sweepStuckRefunds(limit !== undefined ? { limit } : undefined);
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] sweepStuckRefunds failed:', err.message);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
    async runOnce() {
      await tick();
    },
  };
}

// ---------------------------------------------------------------------------
// Еженедельное закрытие расчётных периодов (docs/HQ-PRODUCT-SPEC.md)
// ---------------------------------------------------------------------------
//
// НЕ полагается только на setInterval (задание, раздел 1): сам job каждый раз
// заново вычисляет, какие недели ДОЛЖНЫ быть закрыты к текущему моменту
// (weeklySettlementService.findDueWeeks), поэтому пропущенный тик, рестарт
// процесса или многодневный простой не теряют период — при следующем запуске
// сработает catch-up. Таймер здесь — только «когда посмотреть», а не
// «источник истины о том, что пора закрывать».
//
// Тик раз в 15 минут: точность до минуты для еженедельной бухгалтерии не
// нужна, а редкие тики дешевле и не создают нагрузки. Первый прогон
// выполняется сразу при старте (runOnStart) — именно он и закрывает
// пропущенное, если сервер лежал в воскресенье.
const DEFAULT_WEEKLY_SETTLEMENT_INTERVAL_MS = 15 * 60 * 1000;

function createWeeklySettlementScheduler({
  intervalMs = DEFAULT_WEEKLY_SETTLEMENT_INTERVAL_MS, runOnStart = true, onError,
  // Уведомление ресторана о готовых документах закрытого периода.
  //
  // getBot — функция, а не сам клиент: бот запускается и останавливается
  // независимо от планировщика, поэтому клиент нужно спрашивать в момент
  // тика, а не запоминать при создании (иначе после рестарта бота здесь
  // остался бы мёртвый объект).
  //
  // publicBaseUrl — база для capability-ссылок (PUBLIC_BACKEND_URL). Пустое
  // значение допустимо: ссылки просто не выдаются, документы остаются в HQ.
  getBot = null, publicBaseUrl = null,
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    // Перекрытие тиков невозможно: длинный прогон не должен запускаться
    // второй раз параллельно самому себе (advisory-лока в самом job — вторая,
    // межпроцессная линия защиты; этот флаг — внутрипроцессная).
    if (running) return;
    running = true;
    try {
      const weeklySettlementService = require('../hq/weeklySettlementService');
      await weeklySettlementService.runWeeklySettlementJob({
        bot: typeof getBot === 'function' ? getBot() : null,
        publicBaseUrl,
      });
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] runWeeklySettlementJob failed:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      // Catch-up после простоя — сразу, не дожидаясь первого тика.
      if (runOnStart) {
        tick().catch((err) => console.error('[scheduler/postgresql] стартовый прогон settlement job:', err.message));
      }
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
    async runOnce() {
      await tick();
    },
  };
}

// ---------------------------------------------------------------------------
// Сверка платежей с провайдером (Stage 22, закрытие CRITICAL-1)
// ---------------------------------------------------------------------------
//
// Тот же принцип, что у сверки возвратов: таймер — только «когда посмотреть»,
// а что именно сверять, job вычисляет заново из состояния базы. Пропущенный
// тик и рестарт процесса ничего не теряют.
const DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

function createPaymentReconciliationScheduler({
  intervalMs = DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS, runOnStart = false, limit, onError,
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const service = require('./paymentReconciliationService');
      await service.runPaymentReconciliation(limit !== undefined ? { limit } : undefined);
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] runPaymentReconciliation failed:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      if (runOnStart) tick().catch(() => {});
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    isRunning() { return timer !== null; },
    tick,
  };
}

// ---------------------------------------------------------------------------
// Telegram-outbox dispatcher (Stage 31, раздел 1.2)
// ---------------------------------------------------------------------------
//
// Тот же getBot()-паттерн, что и у createWeeklySettlementScheduler выше:
// бот запускается/останавливается независимо от планировщика, поэтому
// клиент спрашивается в момент тика, а не запоминается при создании.
// Короткий интервал (5с по умолчанию) — критичные уведомления (order:new)
// не должны ждать долго между попытками; backoff внутри самих строк
// bot_notifications (botOutboxService.BACKOFF_SCHEDULE_MS) уже управляет
// РЕАЛЬНЫМ интервалом между попытками одной строки, этот тик лишь "когда
// посмотреть, не пора ли попробовать снова" — тот же принцип, что и у всех
// остальных sweep-планировщиков в этом файле.
const DEFAULT_BOT_OUTBOX_INTERVAL_MS = 5_000;

function createBotOutboxScheduler({ intervalMs = DEFAULT_BOT_OUTBOX_INTERVAL_MS, getBot, onError } = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const bot = typeof getBot === 'function' ? getBot() : null;
      if (bot) {
        const botOutboxService = require('./botOutboxService');
        await botOutboxService.dispatchPending(bot);
      }
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] bot outbox dispatch failed:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
    async runOnce() {
      await tick();
    },
  };
}

// ---------------------------------------------------------------------------
// Контроль расчётных инвариантов и достройка документов (Stage 22)
// ---------------------------------------------------------------------------
//
// Две проверки в одном таймере намеренно: обе редкие, обе фоновые, обе про
// целостность уже закрытых периодов. Отдельный таймер для каждой добавил бы
// только шум в readiness.
const DEFAULT_FINANCIAL_HEALTH_INTERVAL_MS = 60 * 60 * 1000;

function createFinancialHealthScheduler({
  intervalMs = DEFAULT_FINANCIAL_HEALTH_INTERVAL_MS, runOnStart = true, onError,
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await require('../hq/settlementInvariantMonitor').runInvariantCheck();
      await require('../hq/settlementDocumentService').retryMissingDocuments();
    } catch (err) {
      if (onError) onError(err);
      else console.error('[scheduler/postgresql] financial health check failed:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      if (runOnStart) tick().catch(() => {});
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    isRunning() { return timer !== null; },
    tick,
  };
}

module.exports = {
  createPaymentReconciliationScheduler,
  createFinancialHealthScheduler,
  DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS,
  DEFAULT_FINANCIAL_HEALTH_INTERVAL_MS,
  createWeeklySettlementScheduler,
  DEFAULT_WEEKLY_SETTLEMENT_INTERVAL_MS,
  createPauseExpiryScheduler,
  DEFAULT_INTERVAL_MS,
  createOrderTimeoutScheduler,
  createRefundReconciliationScheduler,
  DEFAULT_ORDER_TIMEOUT_INTERVAL_MS,
  DEFAULT_REFUND_RECONCILIATION_INTERVAL_MS,
  createBotOutboxScheduler,
  DEFAULT_BOT_OUTBOX_INTERVAL_MS,
};
