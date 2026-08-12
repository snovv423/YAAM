-- earned_at — финансовый якорь. Первоначальная установка разрешена,
-- последующее изменение или обнуление запрещено на уровне PostgreSQL.
CREATE OR REPLACE FUNCTION fn_orders_earned_at_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.earned_at IS NOT NULL AND NEW.earned_at IS DISTINCT FROM OLD.earned_at THEN
    RAISE EXCEPTION 'orders.earned_at is immutable after first assignment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_earned_at_immutable ON orders;
CREATE TRIGGER trg_orders_earned_at_immutable
BEFORE UPDATE OF earned_at ON orders
FOR EACH ROW
EXECUTE FUNCTION fn_orders_earned_at_immutable();

-- Неудача генерации документа существует до появления settlement_document,
-- поэтому bounded retry нельзя хранить в immutable строке самого документа.
CREATE TABLE IF NOT EXISTS settlement_document_generation_failures (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_period_id INTEGER NOT NULL REFERENCES settlement_periods(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('agent_report', 'order_registry')),
  failure_count INTEGER NOT NULL DEFAULT 1 CHECK (failure_count > 0),
  last_error_safe TEXT NOT NULL DEFAULT '',
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (settlement_period_id, restaurant_id, kind)
);
