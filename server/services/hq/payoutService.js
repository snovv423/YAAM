'use strict';

// YAAM HQ Stage 9.5 — Payout Attempts Foundation for Russian T-Bank
// Integration (NO bank integration — задание, раздел "Hard restrictions").
//
// АУДИТ ПЕРЕД ИЗМЕНЕНИЕМ (задание, раздел 1) — что именно в Stage 9 стало
// неверным с появлением реальных попыток обращения к банку:
//   - Stage 9 смешивал "долг перед рестораном" (обязательство) и "одна
//     попытка отправить деньги банку" в ОДНОЙ строке restaurant_payouts:
//     markProcessing/markSucceeded/markFailed мутировали САМО обязательство.
//     failed был terminal И immutable на уровне обязательства ОДНОВРЕМЕННО —
//     то есть после первого же провала retry был архитектурно невозможен
//     без стирания истории первой попытки (было бы нужно либо снять
//     immutability, либо переиспользовать ту же строку — оба варианта
//     ломают финансовый аудит).
//   - Оба независимых исследования после Stage 9 (T-Bank T-API документация
//     и индустриальное исследование Stripe/Adyen/Wise/PayPal/Razorpay/Open
//     Banking/Shopify/Kill Bill) независимо подтвердили один и тот же вывод:
//     нужно РАЗДЕЛИТЬ "обязательство" и "попытку" на две сущности — см.
//     YAAM-TBank-API-Documentation-Audit.md и
//     YAAM-Payout-Architecture-Industry-Research.md.
//
// Что ОСТАЁТСЯ БЕЗ ИЗМЕНЕНИЙ из Stage 9 (задание, раздел 2: "Preserve the
// obligation model"): restaurant_payouts — единственное обязательство на
// пару (settlement_period_id, restaurant_id); amount копируется РОВНО ОДИН
// РАЗ из settlement_restaurant_lines.payable_amount и никогда не
// пересчитывается; prepareRestaurantPayout() — та же функция, без изменений
// в проверках создания.
//
// Что МЕНЯЕТСЯ (задание, раздел 6): статусы обязательства — prepared /
// processing / unknown / succeeded / blocked (failed убран — это теперь
// статус ПОПЫТКИ, не обязательства). succeeded — единственный terminal
// статус обязательства (задание: "Do not retain obligation-level failed as
// a permanent dead end").
//
// Что ДОБАВЛЯЕТСЯ (задание, раздел 3-7): payout_attempts — новая таблица,
// каждая РЕАЛЬНАЯ попытка обращения к банку — своя строка со своим
// payment_id, своей неизменяемой историей после terminal (succeeded/failed).
const db = require('../../db/postgresql');
const crypto = require('node:crypto');
const { ValidationError } = require('./restaurantLifecycle');
// Stage 9.6 — снимок реквизитов на попытку (задание, раздел 5). Требуются
// ДО создания любой попытки (не только для readiness-предпросмотра — сама
// попытка физически не может быть создана без готового снимка, начиная с
// этого этапа). tbankPayoutReadiness.js НЕ требует этот файл обратно (нет
// цикла) — см. комментарий в начале того файла.
const yaamBankDetailsService = require('./yaamBankDetailsService');
const restaurantBankDetailsService = require('./restaurantBankDetailsService');
const restaurantContractService = require('./restaurantContractService');
const { buildPaymentPurpose } = require('./tbankPayoutReadiness');
const { normalizeKppForTBank } = require('./tbankRequestMapper');

const OBLIGATION_STATUSES = ['prepared', 'processing', 'unknown', 'succeeded', 'blocked'];
const OBLIGATION_TERMINAL_STATUSES = ['succeeded'];
const OBLIGATION_ACTIVE_ATTEMPT_ALLOWED_FROM = ['prepared', 'blocked'];

const STATUS_LABELS = {
  prepared: 'Подготовлена',
  processing: 'В обработке',
  unknown: 'Неопределённый результат',
  succeeded: 'Успешно',
  blocked: 'Заблокирована',
};

const ATTEMPT_STATUSES = ['created', 'submitting', 'processing', 'unknown', 'succeeded', 'failed'];
const ATTEMPT_ACTIVE_STATUSES = ['created', 'submitting', 'processing', 'unknown'];
const ATTEMPT_TERMINAL_STATUSES = ['succeeded', 'failed'];

const ATTEMPT_STATUS_LABELS = {
  created: 'Создана',
  submitting: 'Отправляется',
  processing: 'В обработке банком',
  unknown: 'Результат неизвестен',
  succeeded: 'Успешно',
  failed: 'Ошибка',
};

const MAX_ERROR_MESSAGE_LENGTH = 500;

// ---------------------------------------------------------------------------
// payment_id (задание, раздел 8) — генерируется YAAM (НЕ банком, см. T-Bank
// audit, раздел 6: поле "id" в запросе создания платежа заполняет ВСЕГДА
// вызывающая сторона и оно же служит ключом идемпотентности Т-Банка).
// Формат: детерминированная привязка к (payoutId, attemptNumber) + случайный
// hex-суффикс (unpredictability поверх уникальности — T-Bank этого не
// требует, но это дешёвая дополнительная защита, не более). ≤64 символов
// (T-Bank лимит на поле id), никаких имён ресторанов/счетов/ИНН/ПДн.
function generatePaymentId(payoutId, attemptNumber) {
  if (!Number.isInteger(payoutId) || payoutId < 1) {
    throw new Error('generatePaymentId: payoutId должен быть положительным целым числом');
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error('generatePaymentId: attemptNumber должен быть положительным целым числом');
  }
  const suffix = crypto.randomBytes(4).toString('hex');
  const id = `yaam-po-${payoutId}-a${attemptNumber}-${suffix}`;
  // Defense-in-depth: если формат когда-нибудь изменят так, что он превысит
  // лимит T-Bank, тест/вызов должен упасть громко здесь, а не тихо на
  // будущем HTTP-запросе к банку.
  if (id.length > 64) {
    throw new Error(`generatePaymentId: сгенерированный id длиннее 64 символов (${id.length})`);
  }
  return id;
}

// error_message — санитизированное, ОГРАНИЧЕННОЕ поле (задание, раздел 3:
// "must be safe and bounded, not raw response storage"). Обрезает и
// нормализует, но НЕ пытается парсить/разбирать сырой ответ банка —
// ответственность вызывающего кода передать сюда уже безопасную строку
// (никогда полный raw payload).
function sanitizeErrorMessage(raw, maxLen = MAX_ERROR_MESSAGE_LENGTH) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  return str.slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Подготовка обязательства (задание: "The existing «Подготовить выплату»
// action may remain only for creating the obligation, not an attempt") —
// БЕЗ ИЗМЕНЕНИЙ по сравнению с Stage 9.
// ---------------------------------------------------------------------------
async function prepareRestaurantPayout(settlementPeriodId, restaurantId, { createdBy = null, notes = '' } = {}) {
  const lineRows = await db.query(
    `SELECT srl.*, sp.status AS period_status
     FROM settlement_restaurant_lines srl
     JOIN settlement_periods sp ON sp.id = srl.settlement_period_id
     WHERE srl.settlement_period_id = $1 AND srl.restaurant_id = $2`,
    [settlementPeriodId, restaurantId],
  );
  const line = lineRows[0];
  if (!line) {
    throw new ValidationError('Для этого ресторана нет зафиксированной строки обязательства в этом периоде.');
  }
  if (line.period_status !== 'closed') {
    throw new ValidationError('Период ещё не закрыт — подготовить выплату нельзя.');
  }
  if (line.payable_amount <= 0) {
    throw new ValidationError('Сумма к выплате не положительна — подготавливать нечего.');
  }

  const trimmedNotes = String(notes || '').trim().slice(0, 500);
  try {
    const inserted = await db.execute(
      `INSERT INTO restaurant_payouts (restaurant_id, settlement_period_id, amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [restaurantId, settlementPeriodId, line.payable_amount, trimmedNotes, createdBy || ''],
    );
    return inserted.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw new ValidationError('Для этой пары (период, ресторан) выплата уже существует.');
    }
    throw err;
  }
}

async function getPayoutById(payoutId) {
  const numericId = Number.parseInt(payoutId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM restaurant_payouts WHERE id = $1', [numericId]);
  return rows[0] || null;
}

async function getAttemptById(attemptId) {
  const numericId = Number.parseInt(attemptId, 10);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  const rows = await db.query('SELECT * FROM payout_attempts WHERE id = $1', [numericId]);
  return rows[0] || null;
}

async function listAttemptsForPayout(payoutId) {
  return db.query('SELECT * FROM payout_attempts WHERE payout_id = $1 ORDER BY attempt_number', [payoutId]);
}

// Stage 9.6 — снимок реквизитов конкретной попытки (задание, раздел 10:
// "snapshot реквизитов попытки в маскированном виде" на карточке выплаты).
// Маскировка — забота вызывающего кода (hq/payoutViews.js), не этой функции:
// она возвращает сырые значения, как и getAttemptById/getPayoutById.
async function getAttemptRequisites(attemptId) {
  const rows = await db.query('SELECT * FROM payout_attempt_requisites WHERE attempt_id = $1', [attemptId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Внутренний помощник: перевод обязательства строго ИЗ одного из ожидаемых
// статусов (conditional UPDATE — вторая независимая линия защиты от гонки,
// тот же принцип, что и во всём этом файле; ТРЕТЬЯ линия —
// fn_restaurant_payouts_valid_transition в БД). extraSet/extraParams — для
// кэш-полей обязательства (processing_at/completed_at/failed_at/
// failure_reason), которые обновляются ВМЕСТЕ со статусом атомарно.
// ---------------------------------------------------------------------------
async function transitionPayoutStatus(payoutId, fromStatuses, toStatus, client, extraSql = '', extraParams = []) {
  const params = [payoutId, toStatus, fromStatuses, ...extraParams];
  const updated = await db.execute(
    `UPDATE restaurant_payouts
       SET status = $2, updated_at = NOW() ${extraSql}
     WHERE id = $1 AND status = ANY($3::text[])
     RETURNING *`,
    params,
    client,
  );
  if (updated.rowCount !== 1) {
    throw new ValidationError('Не удалось перевести обязательство в новый статус — статус уже изменился (гонка).');
  }
  return updated.rows[0];
}

async function requireAttemptForUpdate(attemptId, client) {
  const rows = await db.query('SELECT * FROM payout_attempts WHERE id = $1 FOR UPDATE', [attemptId], client);
  const attempt = rows[0];
  if (!attempt) throw new ValidationError('Попытка выплаты не найдена.');
  return attempt;
}

// ---------------------------------------------------------------------------
// Stage 9.6 — построение и вставка immutable snapshot реквизитов (задание,
// раздел 5) ВНУТРИ той же транзакции, что и создание самой попытки: если
// снимок невозможно построить (нет реквизитов YAAM/ресторана, договор не
// подписан, назначение платежа не определено), ВСЯ попытка не создаётся —
// откатывается вместе со снимком (задание, раздел 6: "запрещать создание
// body, если отсутствуют реквизиты YAAM или ресторана" — здесь это уже
// применено на уровень раньше, к самому созданию попытки, не только к
// финальной сборке T-Bank request body).
//
// recipient_kpp трансформируется в T-Bank представление ('' -> '0' для ИП)
// ЗДЕСЬ, один раз, в момент создания снимка (см. db/postgresql/schema.sql,
// комментарий у payout_attempt_requisites.recipient_kpp, за полным
// обоснованием, почему трансформация не отложена до mapper'а).
async function buildAndInsertAttemptRequisites(client, payout, attemptId) {
  // Stage 9.8 (аудит Stage 9.7, находка F1): ВСЕ три чтения ниже теперь
  // явно передают `client` — до этого исправления они уходили на ОТДЕЛЬНЫЕ
  // соединения из пула (getYaamBankDetails/getBankDetails/getContract не
  // принимали client вообще), что означало два одновременно занятых
  // соединения пула на один createPayoutAttempt() и разрыв единой границы
  // транзакции для этих чтений. Теперь все чтения этой функции происходят
  // строго на клиенте ОДНОЙ транзакции createPayoutAttempt — как и
  // settlement_periods-чтение ниже, которое всегда было корректным.
  const yaamDetails = await yaamBankDetailsService.getYaamBankDetails(client);
  if (!yaamDetails) {
    throw new ValidationError('Реквизиты YAAM не заполнены — создать попытку нельзя.');
  }
  if (!yaamBankDetailsService.isStoredRecordValid(yaamDetails)) {
    throw new ValidationError('Реквизиты YAAM некорректны — создать попытку нельзя.');
  }

  const restaurantDetails = await restaurantBankDetailsService.getBankDetails(payout.restaurant_id, client);
  if (!restaurantDetails) {
    throw new ValidationError('Банковские реквизиты ресторана не заполнены — создать попытку нельзя.');
  }
  if (!restaurantBankDetailsService.isStoredRecordValid(restaurantDetails)) {
    throw new ValidationError('Банковские реквизиты ресторана некорректны — создать попытку нельзя.');
  }

  const contract = await restaurantContractService.getContract(payout.restaurant_id, client);
  if (!contract || contract.status !== 'signed') {
    throw new ValidationError('Договор с рестораном не подписан — создать попытку нельзя.');
  }

  const periodRows = await db.query(
    'SELECT period_from, period_to FROM settlement_periods WHERE id = $1',
    [payout.settlement_period_id],
    client,
  );
  const period = periodRows[0] || {};
  const paymentPurpose = buildPaymentPurpose({
    defaultPurpose: restaurantDetails.default_payment_purpose,
    contractNumber: contract.contract_number,
    periodFrom: period.period_from,
    periodTo: period.period_to,
    payoutId: payout.id,
  });
  if (!paymentPurpose) {
    throw new ValidationError('Не удалось определить назначение платежа — заполните его в реквизитах ресторана.');
  }

  await db.execute(
    `INSERT INTO payout_attempt_requisites
       (attempt_id, recipient_name, recipient_inn, recipient_kpp, account_number, bik,
        bank_name, correspondent_account, payment_purpose, amount, payer_account_number, payer_kpp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      attemptId, restaurantDetails.recipient_name, restaurantDetails.recipient_inn,
      normalizeKppForTBank(restaurantDetails.recipient_kpp), restaurantDetails.account_number, restaurantDetails.bik,
      restaurantDetails.bank_name, restaurantDetails.correspondent_account, paymentPurpose, payout.amount,
      yaamDetails.account_number, yaamDetails.kpp,
    ],
    client,
  );
}

// ---------------------------------------------------------------------------
// createPayoutAttempt (задание, раздел 7) — единственный способ создать
// НОВУЮ попытку. Проверки: обязательство prepared/blocked; если blocked —
// ПОСЛЕДНЯЯ попытка должна быть retryable=true; активной попытки не должно
// существовать (partial UNIQUE-индекс — последняя линия защиты, но явная
// проверка здесь даёт понятную ValidationError, а не сырую ошибку 23505).
// НЕ меняет статус обязательства (задание, раздел 6: "processing: an active
// attempt is submitting or processing" — НЕ "created"; обязательство
// переходит в processing только в markAttemptSubmitting).
//
// Stage 9.6: попытка теперь ФИЗИЧЕСКИ не может быть создана без immutable
// snapshot реквизитов (buildAndInsertAttemptRequisites выше) — обе вставки
// (payout_attempts + payout_attempt_requisites) происходят в ОДНОЙ
// транзакции; если снимок невозможен, вся попытка откатывается.
// ---------------------------------------------------------------------------
async function createPayoutAttempt(payoutId) {
  return db.transaction(async (client) => {
    const payoutRows = await db.query('SELECT * FROM restaurant_payouts WHERE id = $1 FOR UPDATE', [payoutId], client);
    const payout = payoutRows[0];
    if (!payout) throw new ValidationError('Выплата не найдена.');
    if (!OBLIGATION_ACTIVE_ATTEMPT_ALLOWED_FROM.includes(payout.status)) {
      throw new ValidationError(
        `Нельзя создать попытку для выплаты в статусе "${payout.status}" (разрешено только из "prepared" или "blocked").`,
      );
    }

    const activeRows = await db.query(
      `SELECT id FROM payout_attempts WHERE payout_id = $1 AND status = ANY($2::text[])`,
      [payoutId, ATTEMPT_ACTIVE_STATUSES],
      client,
    );
    if (activeRows.length > 0) {
      throw new ValidationError('У этой выплаты уже есть активная попытка — создать вторую нельзя.');
    }

    if (payout.status === 'blocked') {
      const lastRows = await db.query(
        `SELECT retryable FROM payout_attempts WHERE payout_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
        [payoutId],
        client,
      );
      const last = lastRows[0];
      if (!last || last.retryable !== true) {
        throw new ValidationError('Последняя попытка не отмечена как retryable — новая попытка требует решения оператора.');
      }
    }

    const nextNumberRows = await db.query(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number FROM payout_attempts WHERE payout_id = $1`,
      [payoutId],
      client,
    );
    const attemptNumber = nextNumberRows[0].next_number;
    const paymentId = generatePaymentId(payoutId, attemptNumber);

    const inserted = await db.execute(
      `INSERT INTO payout_attempts (payout_id, attempt_number, payment_id, status)
       VALUES ($1, $2, $3, 'created') RETURNING *`,
      [payoutId, attemptNumber, paymentId],
      client,
    );
    const attempt = inserted.rows[0];
    await buildAndInsertAttemptRequisites(client, payout, attempt.id);
    return attempt;
  });
}

// markAttemptSubmitting — created -> submitting. ПЕРВЫЙ момент, когда
// обязательство вообще меняется после createPayoutAttempt: prepared/blocked
// -> processing (задание, раздел 6).
async function markAttemptSubmitting(attemptId) {
  return db.transaction(async (client) => {
    const attempt = await requireAttemptForUpdate(attemptId, client);
    if (attempt.status !== 'created') {
      throw new ValidationError(`Нельзя перевести попытку в submitting из статуса "${attempt.status}" (разрешено только из "created").`);
    }
    const updatedAttempt = await db.execute(
      `UPDATE payout_attempts SET status = 'submitting', request_started_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'created' RETURNING *`,
      [attemptId],
      client,
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new ValidationError('Не удалось перевести попытку в submitting — статус уже изменился (гонка).');
    }
    const payout = await transitionPayoutStatus(
      attempt.payout_id, OBLIGATION_ACTIVE_ATTEMPT_ALLOWED_FROM, 'processing', client,
      ', processing_at = NOW()',
    );
    return { attempt: updatedAttempt.rows[0], payout };
  });
}

// markAttemptProcessing — submitting|unknown -> processing (задание,
// раздел 7: "markAttemptProcessing(attemptId, bankStatus?)"). Обязательство:
// processing|unknown -> processing (переход processing->processing —
// no-op для уже processing-обязательства; unknown->processing — попытка
// снова в обработке после того, как была неопределённой).
async function markAttemptProcessing(attemptId, bankStatus = null) {
  return db.transaction(async (client) => {
    const attempt = await requireAttemptForUpdate(attemptId, client);
    if (!['submitting', 'unknown'].includes(attempt.status)) {
      throw new ValidationError(`Нельзя перевести попытку в processing из статуса "${attempt.status}" (разрешено только из "submitting" или "unknown").`);
    }
    const updatedAttempt = await db.execute(
      `UPDATE payout_attempts
         SET status = 'processing', response_received_at = COALESCE(response_received_at, NOW()),
             last_checked_at = NOW(), bank_status = COALESCE($2, bank_status), updated_at = NOW()
       WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`,
      [attemptId, bankStatus, ['submitting', 'unknown']],
      client,
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new ValidationError('Не удалось перевести попытку в processing — статус уже изменился (гонка).');
    }
    const payout = await transitionPayoutStatus(attempt.payout_id, ['processing', 'unknown'], 'processing', client);
    return { attempt: updatedAttempt.rows[0], payout };
  });
}

// markAttemptUnknown — submitting|processing -> unknown (задание: "YAAM
// cannot determine whether the bank accepted/executed the request").
// Обязательство: processing -> unknown.
// bankStatus (опционально, тот же COALESCE-паттерн, что и у markAttemptProcessing/
// markAttemptSucceeded/markAttemptFailed) — добавлено для T-Bank status-mapper'а
// (см. tbankPayoutStatusMapper.js): нераспознанный внешний статус тоже должен
// сохраняться сырым в bank_status ("сохранить исходное значение"), не только
// попадать в error_message/лог.
async function markAttemptUnknown(attemptId, safeReason = null, bankStatus = null) {
  return db.transaction(async (client) => {
    const attempt = await requireAttemptForUpdate(attemptId, client);
    if (!['submitting', 'processing'].includes(attempt.status)) {
      throw new ValidationError(`Нельзя перевести попытку в unknown из статуса "${attempt.status}" (разрешено только из "submitting" или "processing").`);
    }
    const updatedAttempt = await db.execute(
      `UPDATE payout_attempts
         SET status = 'unknown', last_checked_at = NOW(),
             error_message = COALESCE($2, error_message), bank_status = COALESCE($3, bank_status), updated_at = NOW()
       WHERE id = $1 AND status = ANY($4::text[]) RETURNING *`,
      [attemptId, sanitizeErrorMessage(safeReason), bankStatus, ['submitting', 'processing']],
      client,
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new ValidationError('Не удалось перевести попытку в unknown — статус уже изменился (гонка).');
    }
    const payout = await transitionPayoutStatus(attempt.payout_id, ['processing'], 'unknown', client);
    return { attempt: updatedAttempt.rows[0], payout };
  });
}

// markAttemptSucceeded — processing|unknown -> succeeded (terminal,
// immutable). Обязательство: processing|unknown -> succeeded, completed_at
// фиксируется на обязательстве (задание: "succeeded attempt moves parent
// payout to succeeded and sets actual completed_at").
async function markAttemptSucceeded(attemptId, bankStatus = null) {
  return db.transaction(async (client) => {
    const attempt = await requireAttemptForUpdate(attemptId, client);
    if (!['processing', 'unknown'].includes(attempt.status)) {
      throw new ValidationError(`Нельзя перевести попытку в succeeded из статуса "${attempt.status}" (разрешено только из "processing" или "unknown").`);
    }
    const updatedAttempt = await db.execute(
      `UPDATE payout_attempts
         SET status = 'succeeded', completed_at = NOW(), last_checked_at = NOW(),
             bank_status = COALESCE($2, bank_status), updated_at = NOW()
       WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`,
      [attemptId, bankStatus, ['processing', 'unknown']],
      client,
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new ValidationError('Не удалось перевести попытку в succeeded — статус уже изменился (гонка).');
    }
    const payout = await transitionPayoutStatus(
      attempt.payout_id, ['processing', 'unknown'], 'succeeded', client,
      ', completed_at = NOW()',
    );
    return { attempt: updatedAttempt.rows[0], payout };
  });
}

// markAttemptFailed — submitting|processing|unknown -> failed (terminal,
// immutable). ВАЖНО (задание, раздел 4, дословно): "timeout / exception /
// HTTP 500 alone must never cause failed" — эта функция ТРЕБУЕТ явного
// errorMessage/retryable от вызывающего кода на каждый вызов; она не может
// быть вызвана "просто по таймауту" без осознанного решения (это
// ответственность будущего Stage 10 bank-адаптера, не этого файла).
// retryable ОБЯЗАТЕЛЕН (не имеет значения по умолчанию) — переход
// обязательства (prepared, если можно повторить сразу, или blocked, если
// нужно решение оператора) должен быть осознанным решением вызывающего
// кода, а не тихим допущением.
async function markAttemptFailed(attemptId, { bankStatus = null, errorCode = null, errorMessage, retryable } = {}) {
  if (typeof retryable !== 'boolean') {
    throw new ValidationError('retryable обязателен и должен быть true или false.');
  }
  if (!errorMessage || !String(errorMessage).trim()) {
    throw new ValidationError('errorMessage обязателен для перехода в failed.');
  }
  return db.transaction(async (client) => {
    const attempt = await requireAttemptForUpdate(attemptId, client);
    if (!['submitting', 'processing', 'unknown'].includes(attempt.status)) {
      throw new ValidationError(
        `Нельзя перевести попытку в failed из статуса "${attempt.status}" (разрешено только из "submitting", "processing" или "unknown").`,
      );
    }
    const updatedAttempt = await db.execute(
      `UPDATE payout_attempts
         SET status = 'failed', failed_at = NOW(), last_checked_at = NOW(),
             bank_status = COALESCE($2, bank_status), error_code = $3,
             error_message = $4, retryable = $5, updated_at = NOW()
       WHERE id = $1 AND status = ANY($6::text[]) RETURNING *`,
      [attemptId, bankStatus, errorCode, sanitizeErrorMessage(errorMessage), retryable, ['submitting', 'processing', 'unknown']],
      client,
    );
    if (updatedAttempt.rowCount !== 1) {
      throw new ValidationError('Не удалось перевести попытку в failed — статус уже изменился (гонка).');
    }
    const nextObligationStatus = retryable ? 'prepared' : 'blocked';
    const payout = await transitionPayoutStatus(
      attempt.payout_id, ['processing', 'unknown'], nextObligationStatus, client,
      ', failed_at = NOW(), failure_reason = $4',
      [sanitizeErrorMessage(errorMessage)],
    );
    return { attempt: updatedAttempt.rows[0], payout, blocked: nextObligationStatus === 'blocked' };
  }).then((result) => {
    // HQ «Центр событий» — "ошибка выплаты ресторану" (docs/HQ-PRODUCT-
    // SPEC.md). Только 'blocked' (retryable=false) считается реальной
    // проблемой, требующей владельца: retryable=true возвращает
    // обязательство в 'prepared' и будет автоматически повторено — задание,
    // раздел 3: "без информационного шума", терминальная лента не для
    // самовосстанавливающихся сбоев.
    if (result.blocked) {
      logPayoutBlockedEvent(result.payout).catch((err) => {
        console.error(`[services/hq/payoutService] hq_events log failed for payout ${result.payout.id}:`, err.message);
      });
    }
    return result;
  });
}

async function logPayoutBlockedEvent(payout) {
  const eventLogService = require('./eventLogService');
  const [row] = await db.query(`SELECT name FROM restaurants WHERE id = $1`, [payout.restaurant_id]);
  return eventLogService.createEvent({
    category: 'payout_issue',
    restaurantId: payout.restaurant_id,
    restaurantName: row ? row.name : null,
    message: `Выплата ресторану на сумму ${payout.amount} ₽ заблокирована: ${payout.failure_reason}. Требует решения.`,
  });
}

// ---------------------------------------------------------------------------
// Чтение для UI
// ---------------------------------------------------------------------------

async function getPayoutForSettlementLine(settlementPeriodId, restaurantId) {
  const rows = await db.query(
    'SELECT * FROM restaurant_payouts WHERE settlement_period_id = $1 AND restaurant_id = $2',
    [settlementPeriodId, restaurantId],
  );
  return rows[0] || null;
}

async function listPayoutsForPeriod(settlementPeriodId) {
  const rows = await db.query('SELECT * FROM restaurant_payouts WHERE settlement_period_id = $1', [settlementPeriodId]);
  return new Map(rows.map((r) => [r.restaurant_id, r]));
}

async function listPayouts() {
  return db.query(`
    SELECT rp.*, r.name AS restaurant_name, sp.period_from, sp.period_to
    FROM restaurant_payouts rp
    JOIN restaurants r ON r.id = rp.restaurant_id
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    ORDER BY rp.created_at DESC, rp.id DESC
  `);
}

async function getPayoutDetail(payoutId) {
  const rows = await db.query(`
    SELECT rp.*, r.name AS restaurant_name, sp.period_from, sp.period_to, sp.status AS period_status
    FROM restaurant_payouts rp
    JOIN restaurants r ON r.id = rp.restaurant_id
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    WHERE rp.id = $1
  `, [payoutId]);
  return rows[0] || null;
}

// Dashboard-статистика (задание, раздел 11): "obligations prepared;
// processing; unknown; blocked; succeeded; amount succeeded; amount still
// owed. Do not count failed attempts as failed obligations. Avoid
// double-counting one obligation with multiple attempts." — restaurant_payouts
// ВСЕГДА ровно одна строка на обязательство независимо от числа попыток
// (они живут в отдельной таблице payout_attempts), поэтому обычный GROUP BY
// по этой таблице структурно не может задвоить обязательство — двойного
// счёта здесь физически неоткуда взяться.
async function getPayoutDashboardStats() {
  const [row] = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'prepared')::int AS prepared_count,
      COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
      COUNT(*) FILTER (WHERE status = 'unknown')::int AS unknown_count,
      COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0)::int AS succeeded_amount,
      COALESCE(SUM(amount) FILTER (WHERE status <> 'succeeded'), 0)::int AS owed_amount
    FROM restaurant_payouts
  `);
  return {
    preparedCount: row.prepared_count,
    processingCount: row.processing_count,
    unknownCount: row.unknown_count,
    blockedCount: row.blocked_count,
    succeededCount: row.succeeded_count,
    succeededAmount: row.succeeded_amount,
    owedAmount: row.owed_amount,
  };
}

// ---------------------------------------------------------------------------
// Invariant checks — тот же принцип, что checkFinancialInvariants (Stage 7)
// и checkSettlementInvariants (Stage 8): тестируемая health-функция, НЕ
// подключена ни к одному HTTP-маршруту.
// ---------------------------------------------------------------------------
async function checkPayoutInvariants() {
  const violations = [];

  const amountMismatchRows = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    JOIN settlement_restaurant_lines srl
      ON srl.settlement_period_id = rp.settlement_period_id AND srl.restaurant_id = rp.restaurant_id
    WHERE rp.amount <> srl.payable_amount
  `);
  if (amountMismatchRows.length > 0) {
    violations.push({ kind: 'payout_amount_mismatch', count: amountMismatchRows.length });
  }

  const dupObligationRows = await db.query(`
    SELECT settlement_period_id, restaurant_id FROM restaurant_payouts
    GROUP BY settlement_period_id, restaurant_id HAVING COUNT(*) > 1
  `);
  if (dupObligationRows.length > 0) {
    violations.push({ kind: 'multiple_payouts_for_same_period_restaurant', count: dupObligationRows.length });
  }

  const succeededWithoutCompletedAt = await db.query(
    "SELECT id FROM restaurant_payouts WHERE status = 'succeeded' AND completed_at IS NULL",
  );
  if (succeededWithoutCompletedAt.length > 0) {
    violations.push({ kind: 'obligation_succeeded_without_completed_at', count: succeededWithoutCompletedAt.length });
  }

  const nonPositiveRows = await db.query('SELECT id FROM restaurant_payouts WHERE amount <= 0');
  if (nonPositiveRows.length > 0) {
    violations.push({ kind: 'non_positive_amount', count: nonPositiveRows.length });
  }

  const payoutForNonClosedPeriod = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    JOIN settlement_periods sp ON sp.id = rp.settlement_period_id
    WHERE sp.status <> 'closed'
  `);
  if (payoutForNonClosedPeriod.length > 0) {
    violations.push({ kind: 'payout_for_non_closed_period', count: payoutForNonClosedPeriod.length });
  }

  // Больше одной АКТИВНОЙ попытки на одно обязательство — партиальный UNIQUE
  // индекс (ux_payout_attempts_one_active_per_payout) делает это невозможным
  // на уровне схемы; проверяем данные явно (тот же "trust but verify").
  const multipleActiveAttempts = await db.query(`
    SELECT payout_id FROM payout_attempts WHERE status = ANY($1::text[])
    GROUP BY payout_id HAVING COUNT(*) > 1
  `, [ATTEMPT_ACTIVE_STATUSES]);
  if (multipleActiveAttempts.length > 0) {
    violations.push({ kind: 'multiple_active_attempts', count: multipleActiveAttempts.length });
  }

  // attempt_number не последователен без пропусков с 1 — UNIQUE(payout_id,
  // attempt_number) не гарантирует ОТСУТСТВИЕ пропусков сам по себе.
  const nonSequentialAttempts = await db.query(`
    SELECT payout_id FROM payout_attempts
    GROUP BY payout_id
    HAVING MAX(attempt_number) <> COUNT(*) OR MIN(attempt_number) <> 1
  `);
  if (nonSequentialAttempts.length > 0) {
    violations.push({ kind: 'non_sequential_attempt_numbers', count: nonSequentialAttempts.length });
  }

  // Обязательство succeeded, У КОТОРОГО ЕСТЬ история попыток, но НИ ОДНА из
  // них не succeeded — рассогласование. ВАЖНО: "succeeded БЕЗ единой
  // попытки вообще" — НЕ нарушение (задание, раздел 13: backfill создаёт
  // синтетическую попытку ТОЛЬКО для бывших 'failed' строк — succeeded
  // остаётся валидным статусом без изменений, значит унаследованные Stage 9
  // succeeded-строки закономерно не имеют ни одной попытки в payout_attempts
  // и это не ошибка данных, а честная историческая граница модели).
  const obligationSucceededWithConflictingAttempts = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    WHERE rp.status = 'succeeded'
      AND EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa.payout_id = rp.id)
      AND NOT EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa.payout_id = rp.id AND pa.status = 'succeeded')
  `);
  if (obligationSucceededWithConflictingAttempts.length > 0) {
    violations.push({ kind: 'obligation_succeeded_without_succeeded_attempt', count: obligationSucceededWithConflictingAttempts.length });
  }

  // Обратное рассогласование: есть succeeded-попытка, но обязательство НЕ
  // succeeded (структурно не должно быть возможно — markAttemptSucceeded
  // атомарно переводит оба в одной транзакции).
  const succeededAttemptWithoutObligation = await db.query(`
    SELECT DISTINCT pa.payout_id FROM payout_attempts pa
    JOIN restaurant_payouts rp ON rp.id = pa.payout_id
    WHERE pa.status = 'succeeded' AND rp.status <> 'succeeded'
  `);
  if (succeededAttemptWithoutObligation.length > 0) {
    violations.push({ kind: 'succeeded_attempt_with_non_succeeded_obligation', count: succeededAttemptWithoutObligation.length });
  }

  // -------------------------------------------------------------------------
  // Stage 9.6 (задание, раздел 2 — "Legacy consistency"): новые проверки
  // рассогласования между статусом обязательства и реальным набором его
  // попыток. Ни одна из них НЕ должна срабатывать на данных, созданных
  // только через сервисный слой (markAttemptSubmitting/Processing/Unknown
  // всегда атомарно синхронизируют оба статуса в одной транзакции) — их
  // единственная цель — обнаружить порчу данных В ОБХОД сервисного слоя
  // (прямой SQL, ручное вмешательство, будущий баг).
  // -------------------------------------------------------------------------

  // Stage 9.8 (аудит Stage 9.7, находка F7): processing БЕЗ processing_at —
  // обязательство утверждает "попытка сейчас в обработке с такого-то
  // момента", но сам момент не записан. Схема больше не требует этого
  // жёстко (Stage 9.5 сознательно ослабила старый строгий Stage 9 CHECK,
  // см. комментарий у restaurant_payouts_status_completed_at_check) — но
  // при нормальной работе сервисного слоя processing_at ВСЕГДА
  // проставляется атомарно с переходом в processing (markAttemptSubmitting:
  // transitionPayoutStatus(..., ', processing_at = NOW()')), поэтому
  // отсутствие processing_at при processing достижимо только в обход
  // сервисного слоя (прямой SQL) — та же цель, что и у остальных проверок
  // этого раздела.
  const processingWithoutProcessingAt = await db.query(
    "SELECT id FROM restaurant_payouts WHERE status = 'processing' AND processing_at IS NULL",
  );
  if (processingWithoutProcessingAt.length > 0) {
    violations.push({ kind: 'processing_without_processing_at', count: processingWithoutProcessingAt.length });
  }

  // processing БЕЗ единой активной попытки — обязательство утверждает, что
  // "попытка сейчас отправляется/обрабатывается", но в payout_attempts нет
  // ни одной строки, подтверждающей это.
  const processingWithoutActiveAttempt = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    WHERE rp.status = 'processing'
      AND NOT EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa.payout_id = rp.id AND pa.status = ANY($1::text[]))
  `, [ATTEMPT_ACTIVE_STATUSES]);
  if (processingWithoutActiveAttempt.length > 0) {
    violations.push({ kind: 'processing_without_active_attempt', count: processingWithoutActiveAttempt.length });
  }

  // unknown БЕЗ попытки именно в статусе unknown (не просто "какая-то
  // активная" — конкретно unknown, зеркально статусу родителя).
  const unknownWithoutUnknownAttempt = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    WHERE rp.status = 'unknown'
      AND NOT EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa.payout_id = rp.id AND pa.status = 'unknown')
  `);
  if (unknownWithoutUnknownAttempt.length > 0) {
    violations.push({ kind: 'unknown_without_unknown_attempt', count: unknownWithoutUnknownAttempt.length });
  }

  // prepared/blocked С активной попыткой — обратное рассогласование:
  // обязательство утверждает "сейчас нет попытки в работе", но она есть.
  const preparedOrBlockedWithActiveAttempt = await db.query(`
    SELECT rp.id FROM restaurant_payouts rp
    WHERE rp.status IN ('prepared', 'blocked')
      AND EXISTS (SELECT 1 FROM payout_attempts pa WHERE pa.payout_id = rp.id AND pa.status = ANY($1::text[]))
  `, [ATTEMPT_ACTIVE_STATUSES]);
  if (preparedOrBlockedWithActiveAttempt.length > 0) {
    violations.push({ kind: 'prepared_or_blocked_with_active_attempt', count: preparedOrBlockedWithActiveAttempt.length });
  }

  // Снимок реквизитов (задание, раздел 5: "snapshot amount должен совпадать
  // с obligation amount") — проверяется ТОЛЬКО там, где снимок вообще
  // существует (задание Stage 9.5, раздел 13, тот же принцип: legacy-
  // попытки/обязательства без снимка — не нарушение, а честная историческая
  // граница модели, см. комментарий у obligation_succeeded_without_
  // succeeded_attempt выше).
  const snapshotAmountMismatch = await db.query(`
    SELECT par.attempt_id FROM payout_attempt_requisites par
    JOIN payout_attempts pa ON pa.id = par.attempt_id
    JOIN restaurant_payouts rp ON rp.id = pa.payout_id
    WHERE par.amount <> rp.amount
  `);
  if (snapshotAmountMismatch.length > 0) {
    violations.push({ kind: 'attempt_requisites_amount_mismatch', count: snapshotAmountMismatch.length });
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  ValidationError,
  OBLIGATION_STATUSES,
  OBLIGATION_TERMINAL_STATUSES,
  STATUS_LABELS,
  ATTEMPT_STATUSES,
  ATTEMPT_ACTIVE_STATUSES,
  ATTEMPT_TERMINAL_STATUSES,
  ATTEMPT_STATUS_LABELS,
  MAX_ERROR_MESSAGE_LENGTH,
  generatePaymentId,
  sanitizeErrorMessage,
  prepareRestaurantPayout,
  createPayoutAttempt,
  markAttemptSubmitting,
  markAttemptProcessing,
  markAttemptUnknown,
  markAttemptSucceeded,
  markAttemptFailed,
  getPayoutById,
  getAttemptById,
  getAttemptRequisites,
  listAttemptsForPayout,
  getPayoutForSettlementLine,
  listPayoutsForPeriod,
  listPayouts,
  getPayoutDetail,
  getPayoutDashboardStats,
  checkPayoutInvariants,
};
