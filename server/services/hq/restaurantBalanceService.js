'use strict';

// YAAM HQ — перенос отрицательного остатка ресторана между периодами
// (docs/HQ-PRODUCT-SPEC.md, раздел «Перенос долга»).
//
// ЗАДАЧА. Поздний возврат может превысить продажи периода: покупателю деньги
// вернули, а начислений периода не хватило, чтобы удержать их с ресторана.
// Разницу нельзя ни простить (это подарок за чужой счёт), ни выплатить
// (сумма отрицательная). Она становится ДОЛГОМ и гасится из начислений
// следующих периодов — сколько бы периодов на это ни ушло.
//
// ПРИМЕР (задание):
//   долг 930, период начислил 500  -> к выплате 0,   остаток долга 430
//   долг 430, период начислил 1000 -> к выплате 570, долг погашен
//
// ГДЕ ТОЧКА СЕРИАЛИЗАЦИИ. restaurant_settlement_balances — одна строка на
// ресторан, которая берётся SELECT ... FOR UPDATE ВНУТРИ той же транзакции,
// что и закрытие периода. Без этой блокировки два одновременных закрытия
// прочитали бы один и тот же долг и удержали бы его дважды. Дополнительно
// UNIQUE(restaurant_id, settlement_period_id, kind) на проводках делает
// повторное удержание структурно невозможным даже при ошибке в коде.
const db = require('../../db/postgresql');

// Текущий долг ресторана с блокировкой строки на время транзакции.
// Строка создаётся при первом обращении: отсутствие записи и нулевой долг —
// одно и то же состояние, и заводить его заранее для всех ресторанов незачем.
async function lockBalance(restaurantId, client) {
  const existing = await db.query(
    'SELECT debt_amount FROM restaurant_settlement_balances WHERE restaurant_id = $1 FOR UPDATE',
    [restaurantId],
    client,
  );
  if (existing[0]) return existing[0].debt_amount;

  await db.execute(
    `INSERT INTO restaurant_settlement_balances (restaurant_id, debt_amount)
     VALUES ($1, 0) ON CONFLICT (restaurant_id) DO NOTHING`,
    [restaurantId],
    client,
  );
  const created = await db.query(
    'SELECT debt_amount FROM restaurant_settlement_balances WHERE restaurant_id = $1 FOR UPDATE',
    [restaurantId],
    client,
  );
  return created[0] ? created[0].debt_amount : 0;
}

// Чистое начисление периода до переноса: заработок минус сторно поздних
// возвратов. Может быть отрицательным — это и есть новый долг.
//
// Возвращает полностью посчитанную раскладку, БЕЗ обращения к БД: чистая
// функция, которую можно проверить тестом отдельно от транзакции.
function computeCarryForward({ netEarnings, openingDebt }) {
  const debtSettled = Math.min(openingDebt, Math.max(netEarnings, 0));
  const debtAccrued = Math.max(0, -netEarnings);
  const payable = Math.max(0, netEarnings - openingDebt);
  const closingDebt = openingDebt - debtSettled + debtAccrued;
  return { debtSettled, debtAccrued, payable, closingDebt };
}

// Применяет перенос при закрытии периода. Вызывается ВНУТРИ транзакции
// закрытия — проводки, новый баланс и строка периода фиксируются вместе либо
// не фиксируются вовсе.
async function applyCarryForward({ restaurantId, periodId, netEarnings }, client) {
  const openingDebt = await lockBalance(restaurantId, client);
  const result = computeCarryForward({ netEarnings, openingDebt });

  if (result.debtSettled > 0) {
    await db.execute(
      `INSERT INTO restaurant_balance_entries
         (restaurant_id, settlement_period_id, kind, amount, balance_after)
       VALUES ($1,$2,'debt_settled',$3,$4)`,
      [restaurantId, periodId, result.debtSettled, openingDebt - result.debtSettled],
      client,
    );
  }
  if (result.debtAccrued > 0) {
    await db.execute(
      `INSERT INTO restaurant_balance_entries
         (restaurant_id, settlement_period_id, kind, amount, balance_after)
       VALUES ($1,$2,'debt_accrued',$3,$4)`,
      [restaurantId, periodId, result.debtAccrued, result.closingDebt],
      client,
    );
  }
  if (result.closingDebt !== openingDebt) {
    await db.execute(
      `UPDATE restaurant_settlement_balances
          SET debt_amount = $2, updated_at = NOW()
        WHERE restaurant_id = $1`,
      [restaurantId, result.closingDebt],
      client,
    );
  }

  return { ...result, openingDebt };
}

async function getDebt(restaurantId) {
  const rows = await db.query(
    'SELECT debt_amount FROM restaurant_settlement_balances WHERE restaurant_id = $1',
    [restaurantId],
  );
  return rows[0] ? rows[0].debt_amount : 0;
}

// Полная история долга — для аудита и разбора спорных ситуаций.
async function listEntries(restaurantId) {
  return db.query(
    `SELECT rbe.*, sp.period_from, sp.period_to
       FROM restaurant_balance_entries rbe
       JOIN settlement_periods sp ON sp.id = rbe.settlement_period_id
      WHERE rbe.restaurant_id = $1
      ORDER BY rbe.id`,
    [restaurantId],
  );
}

module.exports = {
  computeCarryForward,
  applyCarryForward,
  getDebt,
  listEntries,
};
