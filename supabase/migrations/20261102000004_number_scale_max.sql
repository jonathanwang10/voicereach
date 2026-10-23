-- Phase 2, migration 4 (H2-2.8): categories.number_scale_max, the value of a number
-- category that counts as its full urgency weight. NULL means 300, so existing
-- scores don't change. Idempotent; also folded into supabase/schema.sql.

ALTER TABLE categories ADD COLUMN IF NOT EXISTS number_scale_max NUMERIC;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_number_scale_max_positive;
ALTER TABLE categories ADD CONSTRAINT categories_number_scale_max_positive
    CHECK (number_scale_max IS NULL OR number_scale_max > 0);
