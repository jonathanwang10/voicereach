-- Phase 2, migration 7 (H2-2.11): coarsen_old_locations, which rounds visit
-- locations older than 30 days. Idempotent; also folded into supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- coarsen_old_locations (H2-2.11): a visit's exact GPS point is kept only while
-- it is recent. Interactions older than p_days (30) get lat/lng rounded to 3
-- decimals (about 110 m), a leading house number stripped from the address
-- (a street address pins the spot to a few metres), and a "coarsened" marker so
-- a re-run never rewrites a point twice. Malformed or missing locations are
-- skipped. The person's newest visit keeps its exact point, and
-- individuals.last_location is never touched, so outreach can still find them.
-- It sets voicereach.coarsening for its own transaction, the one UPDATE the
-- interactions_append_only trigger lets through. Returns the rows coarsened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coarsen_old_locations(p_days int DEFAULT 30) RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_count int;
BEGIN
    IF p_days IS NULL OR p_days < 1 THEN
        RAISE EXCEPTION 'p_days must be at least 1' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('voicereach.coarsening', 'on', true);      -- lets interactions_append_only pass (D2)
    UPDATE public.interactions x
    SET location = x.location
        || jsonb_build_object('latitude',  round((x.location->>'latitude')::numeric, 3),
                              'longitude', round((x.location->>'longitude')::numeric, 3),
                              'coarsened', true)
        || CASE WHEN jsonb_typeof(x.location->'address') = 'string'
                THEN jsonb_build_object('address',
                     regexp_replace(x.location->>'address', '^\s*\d+[A-Za-z]?(-\d+)?\s+', ''))
                ELSE '{}'::jsonb END                                -- D3: drop the house number
    WHERE x.created_at < now() - make_interval(days => p_days)
      AND jsonb_typeof(x.location) = 'object'
      AND jsonb_typeof(x.location->'latitude') = 'number'
      AND jsonb_typeof(x.location->'longitude') = 'number'
      AND NOT (x.location ? 'coarsened')                           -- each point once
      AND x.id <> (SELECT y.id FROM public.interactions y           -- the person's newest visit keeps its exact point
                   WHERE y.individual_id = x.individual_id
                   ORDER BY y.created_at DESC, y.id DESC LIMIT 1);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_config('voicereach.coarsening', 'off', true);
    RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION coarsen_old_locations(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coarsen_old_locations(int) TO service_role;

-- Daily at 03:17, once the owner enables pg_cron (see the manual steps):
-- SELECT cron.schedule('coarsen-old-locations', '17 3 * * *', $$SELECT public.coarsen_old_locations(30)$$);
