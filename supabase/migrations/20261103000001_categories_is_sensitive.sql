-- Phase 3, migration 1 (H2-3.8): categories.is_sensitive, backfilled once for keys
-- that name health or other sensitive information. Idempotent; also folded into
-- supabase/schema.sql.

-- H2-3.8: sensitive categories (HUD CPD-17-01: they can't affect urgency). The backfill runs
-- only when the column is added, so re-running never re-flags a category the owner cleared.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'is_sensitive') THEN
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_sensitive BOOLEAN NOT NULL DEFAULT FALSE;  -- IF NOT EXISTS: Phase 2's test_migrations rule
    UPDATE categories SET is_sensitive = TRUE WHERE name ~* 'hiv|medical|substance|mental|diagnos|pregnan';
  END IF;
END $$;
