-- Phase 2, migration 2 (H2-2.6): interactions are append-only. A trigger refuses
-- every UPDATE except coarsen_old_locations' location-only change; DELETE stays
-- allowed. Idempotent; also folded into supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- interactions are append-only (H2-2.6): history can't be edited. The one
-- exemption is coarsen_old_locations (H2-2.11), which sets the transaction-local
-- voicereach.coarsening = 'on' and may change only `location`. DELETE stays
-- allowed, so deleting a person still removes their history (ON DELETE CASCADE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION interactions_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF current_setting('voicereach.coarsening', true) = 'on'
       AND (to_jsonb(NEW) - 'location') = (to_jsonb(OLD) - 'location') THEN
        RETURN NEW;                          -- coarsen_old_locations only (H2-2.11)
    END IF;
    RAISE EXCEPTION 'interactions are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS interactions_append_only ON interactions;
CREATE TRIGGER interactions_append_only BEFORE UPDATE ON interactions
    FOR EACH ROW EXECUTE FUNCTION interactions_append_only();
