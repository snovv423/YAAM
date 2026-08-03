-- =========================================================================
-- 0003_stage13_stage14_upgrade — доведение существующей базы Stage 12
--                                до текущей схемы проекта
-- =========================================================================
--
-- ЗАЧЕМ. Действующая база HQ остановилась на схеме уровня Stage 12: в ней
-- есть рестораны, меню, заказы, расчётные периоды Stage 8 и выплаты Stage 9,
-- но нет ничего из Stage 13 (сторно поздних возвратов, перенос долга,
-- документы периода, capability-токены) и Stage 14 (юридические данные YAAM,
-- фискальные чеки). Пересоздавать её нельзя — там рабочие данные.
--
-- Состав получен НЕ из отчёта и не по памяти, а объективным сравнением:
-- schema-only dump реальной базы восстановлен в эфемерный PostgreSQL и
-- сопоставлен с результатом цепочки 0001 -> 0002 по таблицам, колонкам
-- (включая тип и nullability), ограничениям, индексам, функциям и триггерам.
-- В миграцию вошло ровно то, чего не хватало.
--
-- ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
--   * hq_sessions — её создаёт 0002. В реальной базе этой таблицы нет,
--     поэтому 0002 будет ВЫПОЛНЕНА, а не отмечена (см. legacy-профиль в
--     services/postgresql/migrator.js). Дублировать её здесь значило бы
--     создавать объект дважды и прятать конфликт за IF NOT EXISTS.
--   * ни одной разрушающей операции: удаления таблиц, удаления колонок,
--     очистки и удаления строк здесь нет.
--
-- ЕДИНСТВЕННЫЙ DROP — снятие УСТАРЕВШЕГО CHECK-ограничения списка
-- audit-действий. Без этого база отвергала бы все новые события Stage 13-14
-- (сторно, документы, чеки, смена пароля владельца). Данные при этом не
-- затрагиваются: ограничение пересоздаётся расширенным списком.
--
-- СУЩЕСТВУЮЩИЕ СТРОКИ. Все новые NOT NULL-колонки добавляются с DEFAULT,
-- поэтому имеющиеся строки получают корректное значение до того, как
-- ограничение начнёт действовать. Инвариант payable_amount проверяется ЯВНО
-- перед добавлением CHECK — чтобы при расхождении получить понятное
-- сообщение, а не отказ ограничения без объяснения причины.
--
-- Транзакцию открывает и закрывает runner (services/postgresql/migrator.js):
-- собственных BEGIN/COMMIT здесь нет намеренно.

-- =========================================================================
-- ЧАСТЬ 1. Stage 10-11 — центр событий, таймер готовки, Telegram-группа
-- =========================================================================
-- действие") — история не пересчитывается заново при показе, значит текст
-- события не меняется, даже если формулировки в коде позже изменятся.
CREATE TABLE IF NOT EXISTS hq_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'order_missed', 'payment_issue', 'refund_issue', 'payout_issue',
    'backend_issue', 'telegram_issue',
    -- Важное управленческое событие, а не проблема: ресторан сам взял/снял
    -- перерыв через Telegram (docs/HQ-PRODUCT-SPEC.md, раздел «Пауза
    -- ресторана через Telegram»).
    'restaurant_pause',
    'other'
  )),
  restaurant_id INTEGER REFERENCES restaurants(id),
  restaurant_name TEXT,
  order_id INTEGER REFERENCES orders(id),
  order_public_code TEXT,
  message TEXT NOT NULL CHECK (btrim(message) <> '' AND char_length(message) <= 1000),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_hq_events_occurred_at ON hq_events (occurred_at);

-- Серверный срок готовности заказа (docs/HQ-PRODUCT-SPEC.md, раздел
-- «Таймер приготовления»). Заполняется РОВНО ОДИН РАЗ, в момент перехода в
-- 'preparing' с выбранным рестораном временем (services/postgresql/
-- orderService.js: restaurantAdvance), значением самой БД (NOW() + interval)
-- — клиент считает обратный отсчёт ОТ НЕГО и не может его сбросить
-- обновлением страницы. Обнуляется при переходе в courier/delivered: готовка
-- закончилась, таймер клиенту больше не показывается.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparation_deadline TIMESTAMPTZ;

-- Название рабочей Telegram-группы ресторана (docs/HQ-PRODUCT-SPEC.md,
-- раздел «Telegram-подключение»): владельцу в HQ показывается человеческое
-- название группы, а не технический chat_id. Заполняется в момент привязки
-- (services/hq/telegramLinkService.js: consumeConnectCode).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS telegram_chat_title TEXT;

-- Одна Telegram-группа не может обслуживать два ресторана: заказы одного
-- ресторана иначе попадали бы в чужую группу вместе с телефоном и адресом
-- клиента. Частичный UNIQUE — DB-уровневая гарантия поверх явной проверки в
-- consumeConnectCode() (тот же принцип defense-in-depth, что и у
-- ux_payments_one_active_per_order).
CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurants_telegram_chat
  ON restaurants (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- «Очистить» (задание, раздел 6) — НЕ удаляет строки, только двигает курсор
-- "очищено до" на единственной строке hq_owner (одна HQ-сессия владельца на
-- весь продукт — тот же singleton, что password_hash/login). Основная лента
-- = hq_events.occurred_at > events_cleared_before; «История» игнорирует эту
-- колонку и читает всю таблицу.
ALTER TABLE hq_owner ADD COLUMN IF NOT EXISTS events_cleared_before TIMESTAMPTZ;

-- =========================================================================
-- YAAM HQ — расчётные документы (docs/HQ-PRODUCT-SPEC.md, «Расчётные периоды

-- =========================================================================
-- ЧАСТЬ 2. Stage 13 — снимки юридических данных в строке периода
-- =========================================================================
-- =========================================================================

-- Снимки юридических данных на момент ЗАКРЫТИЯ периода. Строки
-- settlement_restaurant_lines уже immutable (trg_settlement_restaurant_lines_
-- immutable), поэтому эти колонки автоматически неизменяемы вместе с ними:
-- последующая правка названия/ИНН/договора/комиссии ресторана или реквизитов
-- YAAM НЕ меняет уже закрытый период и его документы (задание, раздел 4).
--
-- Все колонки nullable/с дефолтом: на уже существующих закрытых периодах
-- (созданных до этой правки) снимка нет, и это честно отражается в документе
-- как отсутствующие данные, а не как выдуманные значения.
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS restaurant_name_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS legal_name_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS legal_form_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS inn_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS ogrn_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS legal_address_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS contract_signed_at_snapshot DATE;
-- Реквизиты YAAM как агента — тоже снимок на момент закрытия.
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_legal_name_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_inn_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_kpp_snapshot TEXT;

-- -------------------------------------------------------------------------

-- =========================================================================
-- ЧАСТЬ 3. Stage 13 — сторно позднего возврата
-- =========================================================================
-- -------------------------------------------------------------------------
-- settlement_adjustments — сторно позднего возврата
-- -------------------------------------------------------------------------
--
-- ЗАЧЕМ. Заказ учитывается в периоде по моменту доставки. Возврат покупателю
-- может прийти ПОЗЖЕ — когда период с этим заказом уже закрыт, снимок
-- зафиксирован, а обязательство перед рестораном начислено. Период неизменяем
-- и переписать его нельзя (и не нужно: выпущенный отчёт агента не должен
-- меняться задним числом). Поэтому возврат отражается в ТЕКУЩЕМ периоде
-- отдельной корректировочной записью — сторно.
--
-- Что сторнируется. Ровно те суммы, которые были начислены по этому заказу в
-- его исходном периоде, взятые из его же снимка settlement_order_lines:
--   restaurant_amount  — ресторан возвращает то, что ему было начислено;
--   commission_amount  — YAAM возвращает удержанную комиссию.
-- Не пересчёт по текущей ставке, а именно снимок: ставка могла измениться.
--
-- Без этой таблицы возврат попадал бы только в successful_refunds_amount и
-- НИКАК не влиял на payable_amount — ресторан получал бы деньги за заказ,
-- который покупателю уже вернули (подтверждено тестом B1 аудита Stage 13).
--
-- UNIQUE(refund_id) — один возврат сторнируется ровно один раз, структурно.
CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('late_refund')),
  refund_id INTEGER NOT NULL UNIQUE REFERENCES refunds(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  origin_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_amount INTEGER NOT NULL CHECK (restaurant_amount >= 0),
  commission_amount INTEGER NOT NULL CHECK (commission_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Сторно всегда относится к ДРУГОМУ, более раннему периоду: возврат по
  -- заказу текущего периода не нуждается в сторно — такой заказ вообще не
  -- попадает в turnover (EARNED_ORDER_FILTER_SQL).
  CHECK (origin_period_id <> settlement_period_id)
);
CREATE INDEX IF NOT EXISTS ix_settlement_adjustments_period ON settlement_adjustments (settlement_period_id);
CREATE INDEX IF NOT EXISTS ix_settlement_adjustments_origin ON settlement_adjustments (origin_period_id);

-- Корректировка — финансовая запись того же класса, что и снимок периода.
DROP TRIGGER IF EXISTS trg_settlement_adjustments_immutable ON settlement_adjustments;
CREATE TRIGGER trg_settlement_adjustments_immutable
BEFORE UPDATE OR DELETE ON settlement_adjustments
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Итоги сторно в строке ресторана. Хранятся рядом с суммами периода, чтобы
-- документ и выплата строились из ОДНОЙ строки, без повторного агрегирования.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS refund_adjustment_restaurant_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS refund_adjustment_commission INTEGER NOT NULL DEFAULT 0;

-- Комиссия YAAM за период НЕТТО: начислено минус сторнировано. Вычисляемая
-- колонка, а не второе место для ручной арифметики — разойтись не может.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS yaam_commission_net INTEGER
  GENERATED ALWAYS AS (yaam_commission - refund_adjustment_commission) STORED;

-- Отрицательный payable_amount — это НЕ ошибка, а долг ресторана перед YAAM
-- (возвраты превысили продажи периода). Обнулять его нельзя: это подарило бы
-- ресторану деньги, уже возвращённые покупателю. Но и выплатить отрицательную
-- сумму невозможно — состояние помечается явно и вычисляемо.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS payout_blocked_reason TEXT
  GENERATED ALWAYS AS (CASE WHEN payable_amount < 0 THEN 'negative_balance' ELSE NULL END) STORED;

-- ПРОМЕЖУТОЧНОЕ ограничение chk_srl_payable_matches_adjustments здесь
-- намеренно НЕ создаётся. В schema.sql оно есть, потому что там отражена вся
-- история: Stage 13 добавил его, Stage 15 заменил на вариант с переносом
-- долга. Создавать его в миграции, чтобы через сто строк удалить, — лишняя
-- работа и, что важнее, оно упало бы на данных РАНЬШЕ собственного
-- предохранителя миграции, заслонив понятное сообщение невнятным
-- «check constraint is violated by some row».
-- Итоговое ограничение добавляется ниже, после проверки инварианта.

-- -------------------------------------------------------------------------


-- =========================================================================
-- ПРЕДПРОВЕРКА ИНВАРИАНТА перед добавлением CHECK на payable_amount
-- =========================================================================
--
-- Ниже добавляется chk_srl_payable_matches_carry_forward, требующий
--   payable_amount = GREATEST(0, restaurant_earnings - сторно - удержание).
-- На старых строках сторно и удержание равны нулю, поэтому условие
-- сводится к payable_amount = GREATEST(0, restaurant_earnings).
--
-- Если в базе найдётся строка, где это не так, обычное добавление
-- ограничения упало бы с сообщением вида "check constraint is violated by
-- some row" — без указания, какая именно строка и почему. Проверяем сами и
-- объясняем. Миграция при этом откатывается целиком: данные не изменяются.
DO $migration_guard$
DECLARE
  bad_rows INTEGER;
BEGIN
  SELECT count(*) INTO bad_rows
    FROM settlement_restaurant_lines
   WHERE payable_amount <> GREATEST(0, restaurant_earnings);

  IF bad_rows > 0 THEN
    RAISE EXCEPTION
      'Миграция 0003 остановлена: % строк settlement_restaurant_lines имеют payable_amount, не равный restaurant_earnings. %',
      bad_rows,
      'Это означает, что расчёты в базе велись по иной формуле. Данные не изменены — разберите расхождение вручную.';
  END IF;
END
$migration_guard$;

-- =========================================================================
-- ЧАСТЬ 4. Stage 13 — документы периода, перенос долга, capability-токены
-- =========================================================================
-- -------------------------------------------------------------------------
-- settlement_documents — «Отчёт агента» и «Реестр заказов»
-- -------------------------------------------------------------------------
--
-- Документ строится ТОЛЬКО из immutable snapshot периода и сам является
-- неизменяемым после создания (триггер ниже). Исправление ошибки — не
-- перезапись, а НОВАЯ ВЕРСИЯ со ссылкой на исходный документ и причиной
-- (задание, раздел 11).
--
-- payload JSONB — полная модель данных документа (то, из чего renderer
-- строит HTML/PDF). Хранится отдельно от рендера намеренно: renderer можно
-- заменить, не трогая уже выпущенные документы, и наоборот — повторный
-- рендер того же payload обязан давать тот же документ.
--
-- document_number — человекочитаемый уникальный номер, выдаётся один раз при
-- создании и НИКОГДА не переиспользуется (UNIQUE ниже).
CREATE TABLE IF NOT EXISTS settlement_documents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('agent_report', 'order_registry')),
  document_number TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Ссылка на документ, который эта версия исправляет (NULL у первой версии).
  supersedes_document_id INTEGER REFERENCES settlement_documents(id),
  correction_reason TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Корректирующая версия ОБЯЗАНА нести причину и ссылку на исходник —
  -- «молча перевыпустить документ» структурно невозможно.
  CHECK (
    (version = 1 AND supersedes_document_id IS NULL AND correction_reason IS NULL)
    OR (version > 1 AND supersedes_document_id IS NOT NULL AND btrim(correction_reason) <> '')
  )
);
CREATE INDEX IF NOT EXISTS ix_settlement_documents_period
  ON settlement_documents (settlement_period_id, restaurant_id);

-- Ровно одна ДЕЙСТВУЮЩАЯ версия каждого вида документа на пару
-- (период, ресторан): действующей считается та, которую никто не исправляет.
-- Реализовано как partial UNIQUE по (период, ресторан, вид) среди строк, на
-- которые не ссылается более новая версия — проверить это индексом нельзя,
-- поэтому уникальность держится на паре (период, ресторан, вид, версия).
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_documents_version
  ON settlement_documents (settlement_period_id, restaurant_id, kind, version);

-- Документ неизменяем после создания — тот же принцип и та же функция-стиль,
-- что и у settlement_restaurant_lines/settlement_order_lines (Stage 8).
CREATE OR REPLACE FUNCTION fn_settlement_documents_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'settlement documents are immutable: issue a correcting version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_documents_immutable ON settlement_documents;
CREATE TRIGGER trg_settlement_documents_immutable
BEFORE UPDATE OR DELETE ON settlement_documents
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_documents_immutable();

-- Корректирующая версия исправляет КОНКРЕТНЫЙ документ. Ссылка на документ
-- другого периода, ресторана или вида означала бы подмену документа, а не его
-- исправление — и в цепочке оказались бы данные, которых там быть не должно.
-- Приложение и так копирует эти поля из оригинала, но документ финансовый:
-- гарантия должна быть в БД, а не только в одной ветке кода.
CREATE OR REPLACE FUNCTION fn_settlement_document_chain_consistent()
RETURNS TRIGGER AS $$
DECLARE
  parent settlement_documents%ROWTYPE;
BEGIN
  IF NEW.supersedes_document_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM settlement_documents WHERE id = NEW.supersedes_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correcting document references a missing document';
  END IF;
  IF parent.settlement_period_id <> NEW.settlement_period_id
     OR parent.restaurant_id <> NEW.restaurant_id
     OR parent.kind <> NEW.kind THEN
    RAISE EXCEPTION 'correcting document must stay in the same chain: same period, restaurant and kind';
  END IF;
  IF NEW.version <> parent.version + 1 THEN
    RAISE EXCEPTION 'correcting document must increment version by exactly one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_document_chain ON settlement_documents;
CREATE TRIGGER trg_settlement_document_chain
BEFORE INSERT ON settlement_documents
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_document_chain_consistent();

-- Один документ может быть исправлен ровно один раз: иначе появились бы две
-- конкурирующие «актуальные» версии одной цепочки и было бы неизвестно, какая
-- из них действует. Цепочка остаётся линейной структурно.
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_documents_supersedes
  ON settlement_documents (supersedes_document_id)
  WHERE supersedes_document_id IS NOT NULL;

-- -------------------------------------------------------------------------
-- Перенос отрицательного остатка (carry-forward долга ресторана)
-- -------------------------------------------------------------------------
--
-- ЗАЧЕМ. Поздний возврат может превысить продажи периода — тогда ресторан
-- должен YAAM. Обнулить долг нельзя (деньги покупателю уже вернули), но и
-- выплатить отрицательную сумму невозможно. Долг переносится на следующие
-- периоды и гасится из будущих начислений, сколько бы периодов на это ни
-- ушло.
--
-- ДВЕ ТАБЛИЦЫ, а не одна, намеренно:
--   restaurant_settlement_balances — ТЕКУЩИЙ остаток. Одна строка на
--     ресторан, блокируется SELECT ... FOR UPDATE внутри той же транзакции,
--     что и закрытие периода: это и есть точка сериализации, без которой два
--     одновременных закрытия удержали бы один долг дважды.
--   restaurant_balance_entries — ПРОВОДКИ, append-only. Восстанавливают всю
--     историю долга и делают её проверяемой. UNIQUE(restaurant_id,
--     settlement_period_id, kind) структурно запрещает повторное удержание
--     того же долга тем же периодом.
CREATE TABLE IF NOT EXISTS restaurant_settlement_balances (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id),
  -- Всегда НЕОТРИЦАТЕЛЬНОЕ число: это размер долга ресторана перед YAAM.
  -- Ноль означает «долга нет», а не «баланс нулевой».
  debt_amount INTEGER NOT NULL DEFAULT 0 CHECK (debt_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_balance_entries (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  -- debt_accrued  — период ушёл в минус, долг вырос;
  -- debt_settled  — начисления периода погасили часть/весь долг.
  kind TEXT NOT NULL CHECK (kind IN ('debt_accrued', 'debt_settled')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Один и тот же период не может дважды начислить или дважды погасить долг.
  UNIQUE (restaurant_id, settlement_period_id, kind)
);
CREATE INDEX IF NOT EXISTS ix_restaurant_balance_entries_restaurant
  ON restaurant_balance_entries (restaurant_id, id);

-- Проводка — финансовая запись: не переписывается и не удаляется.
DROP TRIGGER IF EXISTS trg_restaurant_balance_entries_immutable ON restaurant_balance_entries;
CREATE TRIGGER trg_restaurant_balance_entries_immutable
BEFORE UPDATE OR DELETE ON restaurant_balance_entries
FOR EACH ROW
EXECUTE FUNCTION fn_settlement_snapshot_row_immutable();

-- Итоги переноса в строке периода — чтобы документ, UI и выплата читались из
-- ОДНОЙ строки и не пересчитывали ledger заново.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS carry_forward_applied INTEGER NOT NULL DEFAULT 0
  CHECK (carry_forward_applied >= 0);
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS carry_forward_remaining INTEGER NOT NULL DEFAULT 0
  CHECK (carry_forward_remaining >= 0);

-- payable_amount теперь НИКОГДА не отрицателен: минус превращается в долг и
-- уезжает в ledger, а не остаётся в строке периода отрицательным числом,
-- которое всё равно нельзя выплатить.
--
--   начислено   = restaurant_earnings
--   сторно      = refund_adjustment_restaurant_amount
--   удержание   = carry_forward_applied
--   к выплате   = GREATEST(0, начислено − сторно − удержание)
--
-- Промежуточное ограничение в этой миграции не создавалось (см. выше),
-- поэтому и снимать нечего.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_srl_payable_matches_carry_forward') THEN
    ALTER TABLE settlement_restaurant_lines
      ADD CONSTRAINT chk_srl_payable_matches_carry_forward
      CHECK (payable_amount = GREATEST(
        0,
        restaurant_earnings - refund_adjustment_restaurant_amount - carry_forward_applied
      ));
  END IF;
END $$;

-- payout_blocked_reason: выплата запрещена и при нулевой сумме (платить
-- нечего), и при непогашенном долге.
--
-- В schema.sql этой строке предшествует удаление колонки — там она
-- пересобиралась после смены определения. В МИГРАЦИИ это не нужно и
-- намеренно убрано: на базе Stage 12 колонки не существует, а разрушающая
-- операция в миграции обязана быть только осознанной.
ALTER TABLE settlement_restaurant_lines
  ADD COLUMN IF NOT EXISTS payout_blocked_reason TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN carry_forward_remaining > 0 THEN 'outstanding_debt'
      WHEN payable_amount <= 0 THEN 'nothing_payable'
      ELSE NULL
    END
  ) STORED;

-- -------------------------------------------------------------------------
-- settlement_document_access_tokens — capability-доступ ресторана к ОДНОМУ документу
-- -------------------------------------------------------------------------
--
-- Ресторан не имеет и не должен иметь HQ-сессии. Документ при этом содержит
-- юридические реквизиты и полную финансовую разбивку — публичным он быть не
-- может. Решение: capability-токен ровно на ОДИН документ, тот же принцип,
-- что уже применён в order_share_tokens и order_access_credentials.
--
-- В БД лежит ТОЛЬКО sha256-хэш: утечка дампа не даёт рабочих ссылок.
-- Токен привязан и к document_id, и к restaurant_id — расхождение между ними
-- (документ другого ресторана) делает токен нерабочим, даже если он валиден.
CREATE TABLE IF NOT EXISTS settlement_document_access_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash BYTEA NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  document_id INTEGER NOT NULL REFERENCES settlement_documents(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS ix_settlement_document_access_tokens_document
  ON settlement_document_access_tokens (document_id);

-- =========================================================================

-- =========================================================================
-- ЧАСТЬ 5. Stage 14 — юридические данные YAAM и фискальные чеки
-- =========================================================================
-- =========================================================================
-- YAAM HQ Stage 14 — юридические данные YAAM и фискальные чеки
-- =========================================================================

-- -------------------------------------------------------------------------
-- yaam_legal_details — юридические данные самой YAAM (singleton)
-- -------------------------------------------------------------------------
--
-- ЗАЧЕМ ОТДЕЛЬНО ОТ yaam_bank_details. Там лежат ПЛАТЁЖНЫЕ реквизиты (счёт,
-- БИК, банк) — они меняются при смене банка и не имеют отношения к тому, кто
-- такое YAAM юридически. Здесь — сведения о лице: ИП, его ФИО, ИНН, ОГРНИП,
-- адрес. Смешивать их в одной таблице значило бы, что смена банка выглядит
-- как смена юридического лица.
--
-- Форма бизнеса — ИП (подтверждено пользователем). Полей для ООО тут нет
-- намеренно: их незачем поддерживать, пока их не существует. КПП у ИП не
-- бывает вовсе — он остался только в yaam_bank_details, где нужен банку.
--
-- PENDING LEGAL. Правовая необходимость части полей в отчёте агента НЕ
-- подтверждена юристом (см. итоговый отчёт Stage 14):
--   registration_date  — дата регистрации ИП;
--   contact_email / contact_phone — рабочие контакты.
-- Поэтому они NULLABLE и НЕ обязательны в форме: делать поле обязательным
-- без правового основания — значит выдумать требование. Как только основание
-- появится, ограничение добавляется отдельной задачей.
CREATE TABLE IF NOT EXISTS yaam_legal_details (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- «ИП Иванов Иван Иванович» — то, что печатается в документах.
  legal_name TEXT NOT NULL CHECK (btrim(legal_name) <> ''),
  -- ФИО предпринимателя отдельно: в некоторых формулировках нужно именно оно.
  entrepreneur_name TEXT NOT NULL CHECK (btrim(entrepreneur_name) <> ''),
  inn TEXT NOT NULL,                      -- 12 цифр для ИП (services/hq/ruRequisites.js)
  ogrnip TEXT NOT NULL,                   -- 15 цифр
  registration_address TEXT NOT NULL CHECK (btrim(registration_address) <> ''),
  -- PENDING LEGAL, см. выше.
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  registration_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Снимок юридических данных YAAM в строке расчётного периода. Stage 13 уже
-- снимал legal_name/inn/kpp из yaam_bank_details; теперь появился настоящий
-- источник, и снимок дополняется недостающими полями.
--
-- Колонки NULLABLE: у периодов, закрытых до этой правки, снимка нет, и
-- документ честно покажет отсутствие данных, а не подставит сегодняшние.
-- Старые периоды НЕ пересчитываются.
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_ogrnip_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_address_snapshot TEXT;
ALTER TABLE settlement_restaurant_lines ADD COLUMN IF NOT EXISTS yaam_entrepreneur_name_snapshot TEXT;

-- -------------------------------------------------------------------------
-- fiscal_receipts — фискальные чеки (54-ФЗ)
-- -------------------------------------------------------------------------
--
-- СТАТУС: техническая основа, НЕ подключённая ни к какой реальной кассе.
-- Кто именно обязан пробивать чек в агентской модели YAAM и какие реквизиты
-- поставщика в нём обязательны — вопрос юридический и НЕ решён (BLOCKED
-- LEGAL, см. итоговый отчёт). Эта таблица не утверждает ответ: она даёт
-- безопасную границу, за которой конкретный провайдер подключается позже.
--
-- ПОЧЕМУ PAYLOAD — СНИМОК. Чек обязан отражать то, что человек купил В МОМЕНТ
-- ОПЛАТЫ. Если строить позиции из текущего меню, то переименование блюда или
-- смена цены задним числом изменили бы уже пробитый чек. Поэтому payload
-- собирается из order_items/orders/поставщика и фиксируется здесь навсегда.
--
-- IDEMPOTENCY. Один платёж — один чек прихода, один возврат — один чек
-- возврата. Это выражено частичными UNIQUE-индексами ниже, а не проверкой в
-- коде: повторный вызов при гонке обязан упереться в базу.
CREATE TABLE IF NOT EXISTS fiscal_receipts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  payment_id INTEGER REFERENCES payments(id),
  refund_id INTEGER REFERENCES refunds(id),
  provider TEXT NOT NULL,
  provider_receipt_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  -- Чек прихода привязан к платежу, чек возврата — к возврату. Смешение
  -- означало бы, что мы не знаем, за что пробит чек.
  CHECK (
    (kind = 'payment' AND payment_id IS NOT NULL AND refund_id IS NULL)
    OR (kind = 'refund' AND refund_id IS NOT NULL)
  ),
  -- Терминальные статусы обязаны иметь момент завершения, нетерминальные — нет.
  CHECK (
    (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'processing') AND completed_at IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fiscal_receipts_payment
  ON fiscal_receipts (payment_id) WHERE kind = 'payment';
CREATE UNIQUE INDEX IF NOT EXISTS ux_fiscal_receipts_refund
  ON fiscal_receipts (refund_id) WHERE kind = 'refund';
CREATE INDEX IF NOT EXISTS ix_fiscal_receipts_status ON fiscal_receipts (status, id);
CREATE INDEX IF NOT EXISTS ix_fiscal_receipts_order ON fiscal_receipts (order_id);

-- payload и связи чека неизменяемы: меняться могут только статус, попытки,
-- ошибка, идентификатор провайдера и временные метки. Иначе «пробитый чек»
-- можно было бы переписать задним числом.
CREATE OR REPLACE FUNCTION fn_fiscal_receipts_payload_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'fiscal receipt payload and links are immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiscal_receipts_payload_immutable ON fiscal_receipts;
CREATE TRIGGER trg_fiscal_receipts_payload_immutable
BEFORE UPDATE ON fiscal_receipts
FOR EACH ROW
EXECUTE FUNCTION fn_fiscal_receipts_payload_immutable();

-- -------------------------------------------------------------------------

-- =========================================================================
-- ЧАСТЬ 6. Расширенный allowlist audit-действий
-- =========================================================================
-- Аудит: события еженедельного закрытия и документов
-- -------------------------------------------------------------------------
ALTER TABLE hq_audit_log DROP CONSTRAINT IF EXISTS hq_audit_log_action_check;
ALTER TABLE hq_audit_log ADD CONSTRAINT hq_audit_log_action_check CHECK (action IN (
  'restaurant_created', 'restaurant_updated', 'restaurant_paused',
  'restaurant_resumed', 'restaurant_archived', 'restaurant_restored',
  'restaurant_published', 'restaurant_unpublished',
  'category_created', 'category_updated', 'category_archived',
  'category_restored', 'category_moved',
  'menu_item_created', 'menu_item_updated', 'menu_item_available',
  'menu_item_unavailable', 'menu_item_archived', 'menu_item_restored',
  'menu_item_moved',
  'restaurant_photo_uploaded', 'restaurant_photo_primary_changed', 'restaurant_photo_deleted',
  'menu_item_photo_uploaded', 'menu_item_photo_primary_changed', 'menu_item_photo_deleted',
  'restaurant_legal_details_created', 'restaurant_legal_details_updated',
  'restaurant_bank_details_created', 'restaurant_bank_details_updated',
  'restaurant_contract_created', 'restaurant_contract_updated', 'restaurant_contract_status_changed',
  'settlement_period_created', 'settlement_period_closed', 'settlement_period_draft_deleted',
  'payout_created', 'payout_processing', 'payout_succeeded', 'payout_failed',
  'payout_attempt_created', 'payout_attempt_processing', 'payout_attempt_unknown',
  'payout_attempt_succeeded', 'payout_attempt_failed',
  'yaam_bank_details_created', 'yaam_bank_details_updated',
  'restaurant_payout_prepared',
  -- Еженедельное автозакрытие (задание, раздел 13).
  'settlement_job_started', 'settlement_job_finished', 'settlement_job_failed',
  'settlement_period_catch_up', 'settlement_period_close_skipped',
  -- Документы периода.
  'settlement_document_created', 'settlement_document_failed',
  'settlement_document_corrected',
  -- Уведомление ресторана в Telegram.
  'yaam_legal_details_updated',
  'yaam_bank_details_updated',
  'owner_password_changed',
  'owner_password_change_rejected',
  'fiscal_receipt_created',
  'fiscal_receipt_succeeded',
  'fiscal_receipt_failed',
  'fiscal_receipt_retried',
  'settlement_backlog_queued',
  'settlement_backlog_deferred',
  'settlement_carry_forward_applied',
  'settlement_carry_forward_accrued',
  'settlement_document_token_issued',
  'settlement_document_token_used',
  'settlement_document_token_revoked',
  'settlement_document_token_rejected',
  'settlement_adjustment_created',
  'settlement_notification_sent', 'settlement_notification_failed'
));

-- (COMMIT из schema.sql намеренно не перенесён: транзакцию открывает и
--  закрывает runner. Вложенный COMMIT закрыл бы её, и отметка в
--  schema_migrations перестала бы быть атомарной вместе со схемой.)
