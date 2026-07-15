const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Встроенный SQLite из Node (без native-компиляции — better-sqlite3 не собирался
// на этой машине из-за несовпадения версии Node и системного C++ тулчейна).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'yaam.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
try {
  db.exec(schema);
} catch (err) {
  // Partial UNIQUE-индексы намеренно не «чинят» старые финансовые дубли
  // молча. Если legacy-БД уже содержит две активные попытки или одинаковый
  // provider_payment_id, запуск останавливается: такие строки должен разобрать
  // человек, иначе автоматическое удаление могло бы скрыть реальный платёж.
  if (err && /UNIQUE constraint failed: payments\./.test(err.message)) {
    throw new Error(`Нарушен платёжный инвариант legacy-БД; требуется ручная сверка перед запуском: ${err.message}`);
  }
  throw err;
}

// Список обязан быть идентичен CHECK-ограничению в schema.sql (см. комментарий
// там) — используется только здесь, для миграции legacy-БД, у которых
// таблица orders уже существует без CHECK (CREATE TABLE IF NOT EXISTS выше
// его не добавляет в уже существующую таблицу).
const ORDERS_STATUS_CHECK_VALUES = [
  'awaiting_payment', 'awaiting_restaurant', 'accepted', 'preparing', 'courier',
  'delivered', 'payment_failed', 'declined', 'timed_out', 'cancelled',
];

// orders.status раньше была единственной статусной колонкой во всей схеме без
// CHECK (payments/refunds/payment_initial_attempts/payment_retry_attempts его
// всегда имели) — независимый аудит State Machine это подтвердил и
// эмпирически показал, что БД принимала произвольную строку без единой
// проверки. Свежая БД получает CHECK сразу в CREATE TABLE (schema.sql); эта
// функция — аддитивная миграция для уже существующей (legacy) таблицы orders,
// у которой ограничения ещё нет. SQLite не поддерживает ALTER TABLE ADD CHECK
// напрямую — используется официально документированный паттерн "создать новую
// таблицу с нужной схемой, скопировать данные, подменить имя".
function migrateOrdersStatusCheck() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (!table || !table.sql) return; // таблицы ещё нет — быть не должно после успешного schema.exec() выше
  if (/CHECK\s*\(\s*status\s+IN/i.test(table.sql)) return; // уже мигрирована либо создана свежей — идемпотентно

  // Fail-closed: если в legacy-БД уже есть заказ с недопустимым статусом, эта
  // строка НЕ исправляется молча и НЕ удаляется — миграция останавливается с
  // понятной ошибкой, требующей ручной сверки, прежде чем ограничение будет
  // добавлено (иначе сам ALTER ниже не смог бы скопировать такую строку и
  // упал бы с непонятным CHECK constraint failed без объяснения, какая именно
  // строка виновата).
  // "NOT IN" — трёхзначная SQL-логика: строка с status IS NULL молча НЕ
  // попала бы в список недопустимых (NULL NOT IN (...) => NULL, не TRUE).
  // status у orders всегда NOT NULL на уровне схемы, так что штатно это
  // недостижимо, но явная проверка здесь — не полагаться на "и так не должно
  // быть", а fail-closed даже для повреждённого файла БД.
  const placeholders = ORDERS_STATUS_CHECK_VALUES.map(() => '?').join(', ');
  const invalidRows = db.prepare(
    `SELECT id, public_code, status FROM orders WHERE status NOT IN (${placeholders}) OR status IS NULL`,
  ).all(...ORDERS_STATUS_CHECK_VALUES);
  if (invalidRows.length > 0) {
    const sample = invalidRows.slice(0, 5)
      .map((r) => `id=${r.id} public_code=${r.public_code} status=${JSON.stringify(r.status)}`)
      .join('; ');
    throw new Error(
      `Миграция CHECK-ограничения orders.status остановлена: найдено ${invalidRows.length} ` +
      `заказ(ов) с недопустимым статусом (${sample}${invalidRows.length > 5 ? '; …' : ''}). ` +
      'Статусы НЕ были изменены, заказы НЕ были удалены — требуется ручная сверка перед добавлением ограничения.',
    );
  }

  const checkList = ORDERS_STATUS_CHECK_VALUES.map((v) => `'${v}'`).join(', ');
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE orders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          public_code TEXT NOT NULL UNIQUE,
          restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
          city TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          address TEXT NOT NULL,
          fulfillment_type TEXT NOT NULL DEFAULT 'delivery',
          comment TEXT NOT NULL DEFAULT '',
          items_total INTEGER NOT NULL,
          commission_amount INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(status IN (${checkList})),
          status_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          rating INTEGER,
          estimated_ready_minutes INTEGER
        );
      `);
      db.exec(`
        INSERT INTO orders_new (
          id, public_code, restaurant_id, city, customer_name, customer_phone, address,
          fulfillment_type, comment, items_total, commission_amount, status,
          status_updated_at, created_at, rating, estimated_ready_minutes
        )
        SELECT
          id, public_code, restaurant_id, city, customer_name, customer_phone, address,
          fulfillment_type, comment, items_total, commission_amount, status,
          status_updated_at, created_at, rating, estimated_ready_minutes
        FROM orders;
      `);

      // КРИТИЧНО: AUTOINCREMENT в SQLite хранит "исторический максимум" id в
      // sqlite_sequence, который переживает DELETE (ровно в этом и есть смысл
      // AUTOINCREMENT — id никогда не переиспользуется, даже после удаления
      // самой "свежей" строки). INSERT...SELECT выше копирует только ЖИВЫЕ на
      // момент миграции строки — если хоть одна строка с прежним максимальным
      // id когда-либо была удалена (ручная чистка дублей/тестовых заказов,
      // seed.js и т.п.), orders_new увидит только копированные id и заведёт
      // сам себе МЕНЬШИЙ sqlite_sequence, чем был у оригинальной orders. Без
      // явного переноса следующий новый заказ получил бы уже использованный
      // (переиспользованный) id и, следовательно, тот же public_code, что
      // раньше был выдан другому, несвязанному заказу — прямое нарушение
      // документированного инварианта formatPublicCode() ("никогда не
      // переиспользуется", см. services/orderService.js) и риск, что старая
      // Telegram-кнопка бота (accept:/decline:/advance: с id в callback_data,
      // см. bot/index.js) случайно продействует над совсем другим заказом.
      const oldSeq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orders'").get();
      if (oldSeq) {
        const newSeqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orders_new'").get();
        if (newSeqRow) {
          db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'orders_new' AND seq < ?")
            .run(oldSeq.seq, oldSeq.seq);
        } else {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('orders_new', ?)").run(oldSeq.seq);
        }
      }

      db.exec('DROP TABLE orders;');
      db.exec('ALTER TABLE orders_new RENAME TO orders;');

      // Сверка целостности внешних ключей — ВНУТРИ той же транзакции, до
      // COMMIT (не отдельным вызовом после): если проверка выполняется уже
      // после COMMIT, падение процесса ровно в этом узком окне навсегда
      // пропускает её на будущих запусках (idempotency-guard в начале функции
      // видит уже добавленный CHECK и выходит раньше, чем дойдёт до повторной
      // FK-проверки). Здесь же — либо вся миграция целиком (данные + FK) успешна
      // и коммитится одним куском, либо откатывается целиком.
      const fkViolations = db.prepare('PRAGMA foreign_key_check(orders)').all();
      if (fkViolations.length > 0) {
        throw new Error(`Миграция orders.status нарушила целостность внешних ключей: ${JSON.stringify(fkViolations)}`);
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
migrateOrdersStatusCheck();

// Маленькая обёртка транзакции — в node:sqlite нет db.transaction(), как в better-sqlite3.
function transaction(fn, beginSql = 'BEGIN') {
  return (...args) => {
    db.exec(beginSql);
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}
db.transaction = transaction;
db.immediateTransaction = (fn) => transaction(fn, 'BEGIN IMMEDIATE');

module.exports = db;
