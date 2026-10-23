-- Phase 2, migration 5 (H2-2.9): rescore_batch, the batched, version-guarded
-- urgency re-score. Idempotent; also folded into supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- rescore_batch: write re-computed urgency scores in one statement (H2-2.9).
-- p_rows is [{"id", "urgency_score", "version"}, ...] from rescore_all_individuals.
-- A row is updated only while its version is still the one that was read, so a
-- save that landed after the read is never overwritten (and only save_individual
-- changes `version`). urgency_override is never touched. Returns the rows updated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rescore_batch(p_rows jsonb) RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_count int;
BEGIN
    IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
    END IF;
    UPDATE public.individuals i SET urgency_score = r.urgency_score
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, urgency_score int, version int)
    WHERE i.id = r.id AND i.version = r.version AND i.urgency_score IS DISTINCT FROM r.urgency_score;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION rescore_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rescore_batch(jsonb) TO service_role;
