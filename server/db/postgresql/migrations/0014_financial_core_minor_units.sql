-- 0014_financial_core_minor_units — Stage 38.
--
-- УТВЕРЖДЁННАЯ ВЛАДЕЛЬЦЕМ ДЕНЕЖНАЯ МОДЕЛЬ (задание, раздел 0):
--   - продуктовый слой (цена блюда, минимальная сумма заказа) остаётся
--     целыми рублями — владелец вводит 350, не 349.99;
--   - финансовое ядро (комиссия, платежи, возвраты, расчётные периоды,
--     корректировки, долг, выплаты) отныне хранит ТОЛЬКО integer minor
--     units (копейки), 1 ₽ = 100 minor units, никогда не float.
--
-- ГРАНИЦА (полное обоснование — server/output/md/STAGE38_MINOR_UNIT_MIGRATION.md,
-- раздел "Money map"): переход рубли -> minor units происходит РОВНО ОДИН
-- РАЗ, внутри services/postgresql/orderService.js:createOrder(), когда
-- доверенные (server-side) цены позиций суммируются в items_total. Именно
-- поэтому эта миграция трогает orders.items_total и orders.commission_amount
-- — это уже ФИНАНСОВЫЕ снимки, а не продуктовые поля — но НЕ трогает
-- menu_items.price/order_items.price/restaurants.min_order, которые
-- остаются целыми рублями навсегда.
--
-- ПОЧЕМУ ×100 НА МЕСТЕ, А НЕ НОВЫЕ *_minor КОЛОНКИ — см. итоговый отчёт,
-- раздел "Migration strategy". Коротко: ни одна колонка не публикуется во
-- внешний API как есть, и несколько колонок settlement_restaurant_lines
-- связаны CHECK-ограничениями МЕЖДУ СОБОЙ в одной строке
-- (chk_srl_payable_matches_carry_forward, GENERATED yaam_commission_net) —
-- параллельные *_minor колонки означали бы дублирование этих ограничений.
--
-- НАЙДЕННЫЙ ФАКТ ПЕРЕД НАПИСАНИЕМ (проверено прямым чтением схемы, не
-- предположением): половина затрагиваемых таблиц защищена триггерами
-- immutability, рассчитанными на ОБЫЧНЫЕ (прикладные) UPDATE — они не
-- отличают "владелец/код пытается тайно изменить финансовый факт" от
-- "системная миграция меняет единицу измерения ВСЕХ строк за один раз".
--
-- Stage 38.1 (GATE B, финансовый аудит перед деплоем): ПЕРЕСМОТРЕНО.
-- Первая версия этой миграции использовала `ALTER TABLE ... DISABLE
-- TRIGGER ALL`. Прямая проверка на реальном hqtest (`pg_trigger`, не
-- `information_schema.triggers` — та скрывает внутренние триггеры)
-- показала: КАЖДАЯ из этих таблиц имеет ТАКЖЕ внутренние
-- `RI_ConstraintTrigger_*` (tgisinternal=true) — системные триггеры
-- проверки внешних ключей. `DISABLE TRIGGER ALL` отключил бы И их —
-- больше, чем действительно необходимо, и ровно то, от чего задание
-- Stage 38.1 прямо предостерегает ("не отключать FK/constraint/system
-- triggers без необходимости"). Ниже — минимальная замена: отключаются
-- ПОИМЁННО только фактические YAAM user-defined immutability-триггеры,
-- которые реально блокируют конкретный UPDATE ниже (проверено чтением
-- каждой функции-триггера, а не общим "на всякий случай"):
--   refunds                     — trg_refunds_immutable_fields (BEFORE
--                                  UPDATE; amount входит в защищённый
--                                  список полей). trg_refunds_amount_
--                                  matches_payment/trg_refunds_block_
--                                  after_succeeded — оба BEFORE INSERT,
--                                  на UPDATE вообще не срабатывают, их
--                                  отключать НЕ нужно.
--   settlement_restaurant_lines — trg_settlement_restaurant_lines_immutable
--   settlement_order_lines      — trg_settlement_order_lines_immutable
--   settlement_refunds          — trg_settlement_refunds_immutable
--   settlement_adjustments      — trg_settlement_adjustments_immutable
--   restaurant_balance_entries  — trg_restaurant_balance_entries_immutable
--   restaurant_payouts          — trg_restaurant_payouts_amount_immutable
--                                  (безусловно блокирует смену amount) И
--                                  trg_restaurant_payouts_block_update_
--                                  after_terminal (блокирует ЛЮБОЙ UPDATE
--                                  terminal-строки). trg_restaurant_
--                                  payouts_valid_transition НЕ отключается
--                                  — читает её функцию
--                                  (fn_restaurant_payouts_valid_transition):
--                                  "IF OLD.status = NEW.status THEN RETURN
--                                  NEW", а это UPDATE меняет только amount,
--                                  не status — триггер проходит сам.
--   payout_attempt_requisites   — trg_payout_attempt_requisites_block_update
-- orders/payments/restaurant_settlement_balances НЕ защищены никакими
-- триггерами (проверено — совпадений нет), их UPDATE ничем не оборачивается.
--
-- Ни один RI_ConstraintTrigger_* (внешние ключи) НИГДЕ в этом файле не
-- отключается — они остаются включёнными на всём протяжении миграции.
--
-- Права на выполнение: подтверждено на hqtest (`\du`, `pg_tables.tableowner`)
-- — прикладная роль (`yaam_hqtest_app`) является ВЛАДЕЛЬЦЕМ каждой из этих
-- таблиц (обычное состояние для роли, создавшей схему через миграции), а
-- `ALTER TABLE ... DISABLE/ENABLE TRIGGER <имя>` для пользовательского
-- (не системного/always/replica) триггера требует ровно прав владельца
-- таблицы — суперпользователь не требуется, права роли повышать не
-- пришлось.
--
-- ОДНОКРАТНОСТЬ. Выполняется РОВНО ОДИН РАЗ тем же механизмом, что и
-- миграции 0002-0013 (services/postgresql/migrator.js: BEGIN/COMMIT на
-- файл целиком + schema_migrations по version — "adopt" относится
-- ИСКЛЮЧИТЕЛЬНО к 0001_baseline, никогда к последующим, проверено прямым
-- чтением migrator.js). Проверено отдельным тестом, реально вызывающим
-- migrator.migrate() дважды подряд на одной базе: второй прогон не
-- удваивает умножение (версия 14 уже в schema_migrations — SQL этого
-- файла просто не выполняется повторно). CHECK-ограничение
-- chk_srl_payable_matches_carry_forward служит ВТОРОЙ, независимой линией
-- защиты: если бы миграция каким-то образом выполнилась дважды на одной и
-- той же строке, GREATEST(0, ...) после второго ×100 почти всегда
-- перестал бы совпадать с уже удвоенным payable_amount, и транзакция
-- откатилась бы с ошибкой CHECK violation вместо того, чтобы тихо
-- испортить данные.
--
-- Отдельная транзакция на файл — при сбое на любом шаге ВСЯ миграция
-- откатывается целиком (включая состояние триггеров), база остаётся в
-- исходном (полностью рублёвом) состоянии, а не наполовину рубли/
-- наполовину minor units (задание, раздел 6).

-- ---------------------------------------------------------------------------
-- orders — граница пересекается здесь. order_items.price НЕ ТРОГАЕТСЯ.
-- ---------------------------------------------------------------------------
UPDATE orders SET items_total = items_total * 100, commission_amount = commission_amount * 100;

COMMENT ON COLUMN orders.items_total IS
  'Финансовый снимок суммы заказа в minor units (копейках) — 1 ₽ = 100. '
  'НЕ рубли с миграции 0014 (Stage 38). Продуктовая цена блюда '
  '(menu_items.price/order_items.price) по-прежнему целые рубли — граница '
  'единственная, внутри orderService.js:createOrder().';
COMMENT ON COLUMN orders.commission_amount IS
  'Комиссия YAAM в minor units (копейках) с миграции 0014 (Stage 38). '
  'round(items_total_minor * commission_bps / 10000).';

-- ---------------------------------------------------------------------------
-- payments — без immutability-триггера на amount, оборачивать не требуется.
-- ---------------------------------------------------------------------------
UPDATE payments SET amount = amount * 100;
COMMENT ON COLUMN payments.amount IS
  'Сумма платежа в minor units (копейках) с миграции 0014 (Stage 38). '
  'Провайдерский адаптер (services/paymentProviders/*) по-прежнему '
  'работает в рублях — конвертация minor<->рубли выполняется ИСКЛЮЧИТЕЛЬНО '
  'в services/postgresql/orderService.js на границе вызова (services/money.js).';

-- ---------------------------------------------------------------------------
-- refunds — trg_refunds_immutable_fields блокирует изменение amount.
-- Именной DISABLE/ENABLE — FK-триггеры этой таблицы не затрагиваются.
-- ---------------------------------------------------------------------------
ALTER TABLE refunds DISABLE TRIGGER trg_refunds_immutable_fields;
UPDATE refunds SET amount = amount * 100;
ALTER TABLE refunds ENABLE TRIGGER trg_refunds_immutable_fields;
COMMENT ON COLUMN refunds.amount IS
  'Сумма возврата в minor units (копейках) с миграции 0014 (Stage 38). '
  'trg_refunds_amount_matches_payment сравнивает с payments.amount — обе '
  'колонки мигрированы в одной транзакции, тождество сохраняется.';

-- ---------------------------------------------------------------------------
-- settlement_restaurant_lines — ВСЕ денежные операнды CHECK-ограничения
-- chk_srl_payable_matches_carry_forward и GENERATED yaam_commission_net
-- обновляются в ОДНОМ UPDATE, чтобы ограничение проверялось только против
-- уже полностью согласованной (все ×100 одновременно) строки.
-- ---------------------------------------------------------------------------
ALTER TABLE settlement_restaurant_lines DISABLE TRIGGER trg_settlement_restaurant_lines_immutable;
UPDATE settlement_restaurant_lines
   SET turnover = turnover * 100,
       yaam_commission = yaam_commission * 100,
       restaurant_earnings = restaurant_earnings * 100,
       successful_refunds_amount = successful_refunds_amount * 100,
       payable_amount = payable_amount * 100,
       refund_adjustment_restaurant_amount = refund_adjustment_restaurant_amount * 100,
       refund_adjustment_commission = refund_adjustment_commission * 100,
       carry_forward_applied = carry_forward_applied * 100,
       carry_forward_remaining = carry_forward_remaining * 100;
ALTER TABLE settlement_restaurant_lines ENABLE TRIGGER trg_settlement_restaurant_lines_immutable;
-- yaam_commission_net (GENERATED ALWAYS AS (yaam_commission - refund_adjustment_commission) STORED)
-- и payout_blocked_reason (GENERATED, знак-only сравнение) пересчитываются
-- PostgreSQL автоматически на этом же UPDATE.

COMMENT ON COLUMN settlement_restaurant_lines.turnover IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.yaam_commission IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.restaurant_earnings IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.successful_refunds_amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.payable_amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.refund_adjustment_restaurant_amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.refund_adjustment_commission IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.carry_forward_applied IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_restaurant_lines.carry_forward_remaining IS 'Minor units (копейки) с миграции 0014 (Stage 38).';

-- ---------------------------------------------------------------------------
-- settlement_order_lines / settlement_refunds — snapshot-строки.
-- ---------------------------------------------------------------------------
ALTER TABLE settlement_order_lines DISABLE TRIGGER trg_settlement_order_lines_immutable;
UPDATE settlement_order_lines
   SET items_total_snapshot = items_total_snapshot * 100,
       commission_amount_snapshot = commission_amount_snapshot * 100,
       restaurant_amount_snapshot = restaurant_amount_snapshot * 100;
ALTER TABLE settlement_order_lines ENABLE TRIGGER trg_settlement_order_lines_immutable;
COMMENT ON COLUMN settlement_order_lines.items_total_snapshot IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_order_lines.commission_amount_snapshot IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_order_lines.restaurant_amount_snapshot IS 'Minor units (копейки) с миграции 0014 (Stage 38).';

ALTER TABLE settlement_refunds DISABLE TRIGGER trg_settlement_refunds_immutable;
UPDATE settlement_refunds SET amount_snapshot = amount_snapshot * 100;
ALTER TABLE settlement_refunds ENABLE TRIGGER trg_settlement_refunds_immutable;
COMMENT ON COLUMN settlement_refunds.amount_snapshot IS 'Minor units (копейки) с миграции 0014 (Stage 38).';

-- ---------------------------------------------------------------------------
-- settlement_adjustments — та же immutable-после-создания снимок-строка.
-- ---------------------------------------------------------------------------
ALTER TABLE settlement_adjustments DISABLE TRIGGER trg_settlement_adjustments_immutable;
UPDATE settlement_adjustments
   SET restaurant_amount = restaurant_amount * 100,
       commission_amount = commission_amount * 100;
ALTER TABLE settlement_adjustments ENABLE TRIGGER trg_settlement_adjustments_immutable;
COMMENT ON COLUMN settlement_adjustments.restaurant_amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN settlement_adjustments.commission_amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';

-- ---------------------------------------------------------------------------
-- restaurant_settlement_balances — без immutability-триггера (это ЖИВОЙ
-- текущий остаток, не append-only ledger), оборачивать не требуется.
-- restaurant_balance_entries — append-only ledger, ЗАЩИЩЁН.
-- ---------------------------------------------------------------------------
UPDATE restaurant_settlement_balances SET debt_amount = debt_amount * 100;
COMMENT ON COLUMN restaurant_settlement_balances.debt_amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';

ALTER TABLE restaurant_balance_entries DISABLE TRIGGER trg_restaurant_balance_entries_immutable;
UPDATE restaurant_balance_entries
   SET amount = amount * 100,
       balance_after = balance_after * 100;
ALTER TABLE restaurant_balance_entries ENABLE TRIGGER trg_restaurant_balance_entries_immutable;
COMMENT ON COLUMN restaurant_balance_entries.amount IS 'Minor units (копейки) с миграции 0014 (Stage 38).';
COMMENT ON COLUMN restaurant_balance_entries.balance_after IS 'Minor units (копейки) с миграции 0014 (Stage 38).';

-- ---------------------------------------------------------------------------
-- restaurant_payouts — ДВА именных триггера способны заблокировать UPDATE:
-- amount-immutability (всегда) и block-update-after-terminal (для
-- succeeded-строк). trg_restaurant_payouts_valid_transition НЕ отключается
-- — её функция пропускает UPDATE без смены status (см. обоснование в
-- заголовке файла), а эта миграция status не трогает.
-- ---------------------------------------------------------------------------
ALTER TABLE restaurant_payouts DISABLE TRIGGER trg_restaurant_payouts_amount_immutable;
ALTER TABLE restaurant_payouts DISABLE TRIGGER trg_restaurant_payouts_block_update_after_terminal;
UPDATE restaurant_payouts SET amount = amount * 100;
ALTER TABLE restaurant_payouts ENABLE TRIGGER trg_restaurant_payouts_amount_immutable;
ALTER TABLE restaurant_payouts ENABLE TRIGGER trg_restaurant_payouts_block_update_after_terminal;
COMMENT ON COLUMN restaurant_payouts.amount IS
  'Сумма выплаты в minor units (копейках) с миграции 0014 (Stage 38). '
  'Копируется РОВНО ОДИН РАЗ из settlement_restaurant_lines.payable_amount '
  '(уже в minor units) при подготовке выплаты — не пересчитывается.';

-- ---------------------------------------------------------------------------
-- payout_attempt_requisites — БЕЗУСЛОВНАЯ immutability (любой UPDATE).
-- ---------------------------------------------------------------------------
ALTER TABLE payout_attempt_requisites DISABLE TRIGGER trg_payout_attempt_requisites_block_update;
UPDATE payout_attempt_requisites SET amount = amount * 100;
ALTER TABLE payout_attempt_requisites ENABLE TRIGGER trg_payout_attempt_requisites_block_update;
COMMENT ON COLUMN payout_attempt_requisites.amount IS
  'Неизменяемый снимок суммы попытки выплаты в minor units (копейках) с '
  'миграции 0014 (Stage 38) — должен совпадать с restaurant_payouts.amount '
  '(checkPayoutInvariants проверяет это тождество явно).';
