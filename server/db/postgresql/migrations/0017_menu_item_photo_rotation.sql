-- Per-media display rotation. Generated files and the private master stay
-- untouched; legacy rows keep the previous upright display via DEFAULT 0.
ALTER TABLE menu_item_photos
  ADD COLUMN IF NOT EXISTS rotation_degrees INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE menu_item_photos
    ADD CONSTRAINT menu_item_photos_rotation_degrees_check
    CHECK (rotation_degrees IN (0, 90, 180, 270));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Rollback policy: DEFAULT 0 and the additive column are harmless to the old
-- application, so roll back application code first and retain the metadata.
-- Destructive down, only after explicit approval:
--   ALTER TABLE menu_item_photos DROP CONSTRAINT menu_item_photos_rotation_degrees_check;
--   ALTER TABLE menu_item_photos DROP COLUMN rotation_degrees;
