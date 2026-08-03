'use strict';

// YAAM HQ — автоматическое еженедельное закрытие расчётных периодов
// (docs/HQ-PRODUCT-SPEC.md, раздел «Расчётные периоды»).
//
// ГРАНИЦЫ НЕДЕЛИ (единственное определение в проекте):
//   период = понедельник 00:00:00 .. воскресенье 23:59:59.999 по
//   Europe/Moscow; закрывается в ПОНЕДЕЛЬНИК 07:00 МСК сразу после этой
//   недели — то есть через 7 часов после её окончания, а не через неделю.
//
// Почему так: settlement_periods хранит period_from/period_to как DATE
// (включительные границы, см. EXCLUDE-constraint по daterange '[]'), а весь
// финансовый расчёт уже использует resolvePeriodRange({period:'custom'}),
// который переводит эти даты в UTC-диапазон [начало period_from 00:00 МСК,
// начало дня ПОСЛЕ period_to). То есть заказ ровно на границе суток попадает
// строго в одну неделю, а «новая неделя начинается сразу после границы
// предыдущей» выполняется по построению — здесь не вводится второе,
// параллельное определение диапазона.
//
// Закрываемая неделя — ПРЕДЫДУЩАЯ полная (пн..вс), а не текущая. Момент
// закрытия — понедельник 07:00 МСК: неделя к этому времени уже полностью
// завершилась (последний её заказ мог быть в вс 23:59), и семь часов буфера
// покрывают поздние переходы заказов в delivered. Закрывать в воскресенье
// 07:00 было бы нельзя — это отрезало бы продажи воскресного дня.
const db = require('../../db/postgresql');
const settlementService = require('./settlementService');
const { logAuditEvent } = require('./auditLog');
const { PROJECT_TIMEZONE_OFFSET_MINUTES } = require('./dashboardMetrics');

// Расписание: ПОНЕДЕЛЬНИК 07:00 по времени проекта — первый рабочий момент
// после конца недели. Ресторан не ждёт лишние семь суток.
const SETTLEMENT_WEEKDAY = 1; // понедельник
const SETTLEMENT_HOUR = 7;

// Ключ advisory-локи: защищает от ОДНОВРЕМЕННОГО запуска job на нескольких
// процессах/инстансах. SERIALIZABLE + EXCLUDE-constraint уже не дают создать
// пересекающиеся периоды, но без локи два процесса выполнили бы одинаковую
// работу и один получил бы ошибку — лока делает второй запуск тихим no-op,
// как и требует «конкурентные запуски не создают дубли».
const ADVISORY_LOCK_KEY = 8724301; // произвольная фиксированная константа проекта

// Сколько недель job закрывает за ОДИН запуск. Простой мог длиться сколько
// угодно, но закрывать сто периодов в одном проходе — это длинная серия
// транзакций, в середине которой любой сбой оставил бы половину работы без
// понятного состояния. Поэтому backlog обрабатывается ПАКЕТАМИ: самые старые
// недели первыми, остаток — на следующем запуске планировщика (каждые 15
// минут), и так до полного исчерпания. Ни одна неделя не теряется.
const CATCH_UP_BATCH_SIZE = 8;

// Абсолютного предела глубины истории НЕТ — сознательно. Раньше здесь стоял
// MAX_BACKLOG_WEEKS = 120, и активная неделя старше этого предела молча
// выпадала из очереди. Нижняя граница теперь берётся из фактических данных
// (settlementService.listWeeksWithFinancialActivity), поэтому и бесконечного
// сканирования пустой истории тоже нет: перебираются не «все недели подряд»,
// а только те, в которых реально были деньги.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function offsetMs() {
  return PROJECT_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
}

// UTC-момент -> «календарные» компоненты по времени проекта. Читаем UTC-
// геттеры сдвинутой копии, а не локальные геттеры процесса: сервер может
// стоять в любом TZ (тот же приём, что во всём остальном коде проекта).
function toProjectLocal(utcDate) {
  return new Date(utcDate.getTime() + offsetMs());
}

function formatDateOnly(localDate) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth() + 1)}-${pad(localDate.getUTCDate())}`;
}

// Понедельник той недели, в которую попадает localDate (00:00 по проекту).
function startOfProjectWeek(localDate) {
  const day = localDate.getUTCDay(); // 0=вс
  const daysSinceMonday = (day + 6) % 7; // пн=0 ... вс=6
  return new Date(Date.UTC(
    localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate() - daysSinceMonday,
  ));
}

// Последняя ПОЛНАЯ неделя (пн..вс), завершившаяся к моменту now.
// В воскресенье ДО 07:00 расчёта ещё не было — закрываем позапрошлую неделю
// только если её ещё не закрыли; сама эта функция отвечает лишь на вопрос
// «какая неделя уже полностью закончилась».
function lastCompletedWeek(now = new Date()) {
  const local = toProjectLocal(now);
  const thisWeekMonday = startOfProjectWeek(local);
  const prevMonday = new Date(thisWeekMonday.getTime() - 7 * MS_PER_DAY);
  const prevSunday = new Date(thisWeekMonday.getTime() - MS_PER_DAY);
  return { periodFrom: formatDateOnly(prevMonday), periodTo: formatDateOnly(prevSunday) };
}

// Момент планового закрытия для недели, ЗАКАНЧИВАЮЩЕЙСЯ указанным
// воскресеньем: понедельник СРАЗУ после него, 07:00 МСК, выраженный в UTC.
function scheduledCloseAt(periodToDateStr) {
  const [y, m, d] = periodToDateStr.split('-').map(Number);
  // periodTo — воскресенье конца недели; закрытие — на следующий день.
  const localClose = Date.UTC(y, m - 1, d + 1, SETTLEMENT_HOUR, 0, 0, 0);
  return new Date(localClose - offsetMs());
}

// Очередь недель, подлежащих закрытию: от самой старой к самой новой.
//
// ОТКУДА БЕРЁТСЯ НИЖНЯЯ ГРАНИЦА. Не из константы «столько-то недель назад», а
// из данных:
//   1) недели с фактической финансовой активностью — один SQL-запрос,
//      возвращающий только те понедельники, в которых был заработанный заказ
//      или успешный возврат (пустая история не перебирается вообще);
//   2) недели существующих draft-периодов — их создали, но не закрыли.
// Из объединения вычитаются уже существующие периоды и недели, чей плановый
// момент закрытия ещё не наступил.
//
// Почему НЕ «следующая неделя после последнего закрытого периода» как
// единственное правило: между закрытыми периодами может остаться дыра —
// например, если неделя упала с ошибкой, а следующая закрылась успешно
// (см. тест K4). Правило «после последнего закрытого» навсегда потеряло бы
// такую неделю. Поэтому граница — самая ранняя НЕПОКРЫТАЯ активная неделя,
// что в обычном случае и есть «следующая после последнего закрытого».
async function findDueWeeks(now = new Date()) {
  const { periodTo: lastCompletedSunday } = lastCompletedWeek(now);

  const activityWeeks = await settlementService.listWeeksWithFinancialActivity();

  // Существующие периоды одним запросом: сравнивать по неделям в памяти
  // дешевле, чем спрашивать базу про каждую неделю отдельно.
  const existingRows = await db.query(
    'SELECT id, status, period_from, period_to FROM settlement_periods',
  );
  const existingByFrom = new Map();
  for (const row of existingRows) {
    existingByFrom.set(dateOnly(row.period_from), row);
  }

  // Кандидаты: активные недели + недели незакрытых черновиков.
  const candidates = new Set(activityWeeks);
  for (const row of existingRows) {
    if (row.status === 'draft') candidates.add(dateOnly(row.period_from));
  }

  const due = [];
  for (const periodFrom of [...candidates].sort()) {
    const mondayLocal = new Date(`${periodFrom}T00:00:00Z`);
    const periodTo = formatDateOnly(new Date(mondayLocal.getTime() + 6 * MS_PER_DAY));

    // Неделя ещё не завершилась либо её плановое закрытие не наступило.
    if (periodTo > lastCompletedSunday) continue;
    if (scheduledCloseAt(periodTo).getTime() > now.getTime()) continue;

    const existing = existingByFrom.get(periodFrom);
    if (existing) {
      // Закрытый период трогать нечего; черновик надо довести до закрытия.
      if (existing.status === 'draft') due.push({ periodFrom, periodTo, existingId: existing.id });
      continue;
    }

    due.push({ periodFrom, periodTo, existingId: null });
  }

  // От СТАРЫХ к новым: пропущенные недели обязаны закрываться в
  // хронологическом порядке, иначе перенос долга (carry-forward) лёг бы не в
  // тот период.
  return due;
}

// DATE из pg приходит либо строкой, либо Date — нормализуем к 'YYYY-MM-DD'.
function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Есть ли в неделе хоть одна операция, формирующая финансовый результат.
//
// Больше НЕ используется при построении очереди: там недели с активностью
// выбираются одним запросом (settlementService.listWeeksWithFinancialActivity),
// а не проверяются по одной. Функция сохранена как точечная проверка «была ли
// активность в конкретной неделе» и использует ТОТ ЖЕ источник истины, что и
// сам расчёт, а не собственный параллельный SQL.
async function weekHasActivity(periodFrom, periodTo) {
  const { restaurantLines } = await settlementService.computeSettlementPreview(
    settlementService.resolvePeriodRangeForPeriod(periodFrom, periodTo),
  );
  return restaurantLines.length > 0;
}

// Одна попытка закрыть одну неделю. Идемпотентна на всех уровнях:
//   - период уже closed -> closeSettlementPeriod вернёт alreadyClosed;
//   - период не существует -> создаётся черновик, затем закрывается;
//   - гонка на создании -> EXCLUDE-constraint (23P01) -> тихо перечитываем
//     существующий период и закрываем его.
async function closeWeek({ periodFrom, periodTo, existingId }, { now = new Date(), createdBy = 'system' } = {}) {
  let periodId = existingId;

  if (!periodId) {
    try {
      const draft = await settlementService.createDraftSettlementPeriod(
        { periodFrom, periodTo, notes: 'Автоматическое еженедельное закрытие', createdBy },
        now,
      );
      periodId = draft.id;
      await logAuditEvent({
        action: 'settlement_period_created', restaurantId: null,
        details: `период ${periodFrom}–${periodTo} создан автоматически`, ip: null,
      });
    } catch (err) {
      // Пересечение — период уже создан кем-то другим (параллельный запуск
      // либо ручная операторская функция). Не ошибка: перечитываем и идём
      // дальше к закрытию.
      const existing = await db.query(
        'SELECT id FROM settlement_periods WHERE period_from = $1 AND period_to = $2',
        [periodFrom, periodTo],
      );
      if (!existing[0]) throw err;
      periodId = existing[0].id;
    }
  }

  const result = await settlementService.closeSettlementPeriod(periodId, { now });
  if (result.alreadyClosed) {
    await logAuditEvent({
      action: 'settlement_period_close_skipped', restaurantId: null,
      details: `период ${periodFrom}–${periodTo} уже был закрыт`, ip: null,
    });
    return { periodId, closed: false, alreadyClosed: true, lines: result.lines };
  }

  await logAuditEvent({
    action: 'settlement_period_closed', restaurantId: null,
    details: `период ${periodFrom}–${periodTo} закрыт автоматически, строк: ${result.lines.length}`, ip: null,
  });

  // Перенос долга — отдельные события: без них движение денег между периодами
  // не восстановить по аудиту. Пишутся ПОСЛЕ коммита закрытия.
  for (const c of result.carryEvents || []) {
    if (c.debtSettled > 0) {
      // eslint-disable-next-line no-await-in-loop
      await logAuditEvent({
        action: 'settlement_carry_forward_applied', restaurantId: c.restaurantId,
        details: `период ${periodFrom}–${periodTo}: удержано ${c.debtSettled} ₽ долга прошлых периодов, остаток долга ${c.closingDebt} ₽`,
        ip: null,
      });
    }
    if (c.debtAccrued > 0) {
      // eslint-disable-next-line no-await-in-loop
      await logAuditEvent({
        action: 'settlement_carry_forward_accrued', restaurantId: c.restaurantId,
        details: `период ${periodFrom}–${periodTo}: начислен долг ${c.debtAccrued} ₽, итого долг ${c.closingDebt} ₽`,
        ip: null,
      });
    }
  }
  return { periodId, closed: true, alreadyClosed: false, lines: result.lines };
}

// Главная точка входа job. Отдельно вызываемая и тестируемая (задание,
// раздел 1) — scheduler ниже только зовёт её по таймеру, вся логика здесь.
//
// Advisory-лока НЕ блокирующая (pg_try_advisory_lock): если job уже идёт на
// другом процессе, второй запуск тихо выходит, а не ждёт и не дублирует.
async function runWeeklySettlementJob({ now = new Date(), generateDocuments = true } = {}) {
  const lockClient = await db.getPool().connect();
  let locked = false;
  try {
    const lockRes = await lockClient.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
    locked = lockRes.rows[0].acquired === true;
    if (!locked) {
      return {
        skipped: true, reason: 'already_running', closed: [], failed: [],
        queued: 0, processed: 0, remaining: 0, remainingWeeks: [],
      };
    }

    await logAuditEvent({ action: 'settlement_job_started', restaurantId: null, details: null, ip: null });

    const allDue = await findDueWeeks(now);
    const closed = [];
    const failed = [];

    // ПАКЕТ: самые старые недели первыми. Хронологический порядок обязателен —
    // перенос долга ресторана между периодами (carry-forward) считается по
    // цепочке, и закрытие «через одну» положило бы удержание не туда.
    const batch = allDue.slice(0, CATCH_UP_BATCH_SIZE);
    const deferred = allDue.slice(CATCH_UP_BATCH_SIZE);

    if (allDue.length > 0) {
      await logAuditEvent({
        action: 'settlement_backlog_queued', restaurantId: null,
        details: `очередь недель: ${allDue.length}, в этом запуске: ${batch.length}, останется: ${deferred.length}`,
        ip: null,
      });
    }

    for (const week of batch) {
      try {
        // Каждая неделя — СВОЯ транзакция (closeSettlementPeriod внутри
        // closeWeek). Сбой одной не откатывает уже закрытые и не мешает
        // следующим: backlog доедет за несколько запусков.
        // eslint-disable-next-line no-await-in-loop
        const result = await closeWeek(week, { now });
        if (result.closed) {
          closed.push({ ...week, periodId: result.periodId, lines: result.lines.length });
          // Закрытие «задним числом» отличается от планового и должно быть
          // видно в аудите отдельно.
          const plannedAt = scheduledCloseAt(week.periodTo);
          if (now.getTime() - plannedAt.getTime() > MS_PER_DAY) {
            // eslint-disable-next-line no-await-in-loop
            await logAuditEvent({
              action: 'settlement_period_catch_up', restaurantId: null,
              details: `период ${week.periodFrom}–${week.periodTo} закрыт с опозданием (плановое закрытие ${plannedAt.toISOString()})`,
              ip: null,
            });
          }
          if (generateDocuments) {
            // Документы формируются ПОСЛЕ фиксации периода и не могут
            // отменить уже выполненное закрытие — ошибка документа
            // изолирована (статус «Ошибка» у документа, а не откат бухгалтерии).
            // eslint-disable-next-line no-await-in-loop
            await safeGenerateDocuments(result.periodId);
          }
        }
      } catch (err) {
        console.error(`[weeklySettlement] не удалось закрыть период ${week.periodFrom}–${week.periodTo}:`, err.message);
        failed.push({ ...week, error: err.message });
        // eslint-disable-next-line no-await-in-loop
        await logAuditEvent({
          action: 'settlement_job_failed', restaurantId: null,
          details: `период ${week.periodFrom}–${week.periodTo}: ${err.message}`, ip: null,
        });
      }
    }

    // Остаток очереди НИКОГДА не исчезает молча: он и в аудите, и в
    // возвращаемом результате, и следующий запуск продолжит с него.
    if (deferred.length > 0) {
      await logAuditEvent({
        action: 'settlement_backlog_deferred', restaurantId: null,
        details: `осталось недель в очереди: ${deferred.length}, ближайшая ${deferred[0].periodFrom}–${deferred[0].periodTo}`,
        ip: null,
      });
      console.error(`[weeklySettlement] backlog: осталось ${deferred.length} недель, продолжим следующим запуском`);
    }

    await logAuditEvent({
      action: 'settlement_job_finished', restaurantId: null,
      details: `закрыто периодов: ${closed.length}, с ошибкой: ${failed.length}, осталось в очереди: ${deferred.length}`,
      ip: null,
    });
    return {
      skipped: false, closed, failed,
      queued: allDue.length, processed: batch.length, remaining: deferred.length,
      remainingWeeks: deferred,
    };
  } finally {
    if (locked) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      } catch (err) {
        console.error('[weeklySettlement] не удалось освободить advisory-локу:', err.message);
      }
    }
    lockClient.release();
  }
}

// Ленивый require — documentService зависит от settlementService, а тот от
// этого модуля не зависит; ленивый вызов исключает любой цикл на будущее.
async function safeGenerateDocuments(periodId) {
  try {
    const documentService = require('./settlementDocumentService');
    return await documentService.generateDocumentsForPeriod(periodId);
  } catch (err) {
    console.error(`[weeklySettlement] генерация документов периода ${periodId} не удалась:`, err.message);
    return null;
  }
}

module.exports = {
  SETTLEMENT_WEEKDAY,
  SETTLEMENT_HOUR,
  ADVISORY_LOCK_KEY,
  toProjectLocal,
  startOfProjectWeek,
  lastCompletedWeek,
  scheduledCloseAt,
  findDueWeeks,
  weekHasActivity,
  closeWeek,
  runWeeklySettlementJob,
  CATCH_UP_BATCH_SIZE,
};
