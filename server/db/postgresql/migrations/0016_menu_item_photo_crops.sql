-- Independent, non-destructive crops for the public menu card (7:3) and
-- dish detail hero (1:1). The original/master and generated variants remain
-- untouched; NULL preserves the previous centred fallback.
ALTER TABLE menu_item_photos ADD COLUMN IF NOT EXISTS menu_card_crop JSONB;
ALTER TABLE menu_item_photos ADD COLUMN IF NOT EXISTS dish_detail_crop JSONB;

-- Rollback policy: the old application tolerates these additive nullable
-- columns, so application rollback does not require a database down migration.
-- If metadata must be discarded later, the explicit destructive down is:
--   ALTER TABLE menu_item_photos DROP COLUMN menu_card_crop, DROP COLUMN dish_detail_crop;
