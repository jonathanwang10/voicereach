-- Phase 4, migration 4 (H2-4.7). Idempotent; also folded into supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- most_urgent_individuals (H2-4.7): the most urgent people, optionally within a
-- radius of a point (haversine on last_location, no PostGIS). Display urgency is
-- the override if set (an override of 0 counts), else the score, as
-- get_display_urgency_score. last_seen is the newest interaction. It scans
-- individuals once per call, fine to tens of thousands of rows; the trigger for
-- change is PostGIS or earthdistance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION most_urgent_individuals(
    p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
    p_radius_m double precision DEFAULT NULL, p_limit int DEFAULT 5
)
RETURNS TABLE (id uuid, name text, data jsonb, urgency_score int, urgency_override int,
               last_location jsonb, created_at timestamptz, updated_at timestamptz,
               display_urgency int, last_seen timestamptz, distance_m double precision)
LANGUAGE sql STABLE
SET search_path = public
AS $$
WITH located AS (
    SELECT i.id, i.name, i.data, i.urgency_score, i.urgency_override, i.last_location,
           i.created_at, i.updated_at,
           CASE WHEN p_lat IS NULL OR p_lng IS NULL THEN NULL
                -- a missing or non-numeric coordinate can't be placed (no cast error)
                WHEN jsonb_typeof(i.last_location->'latitude') = 'number'
                 AND jsonb_typeof(i.last_location->'longitude') = 'number'
                THEN 2 * 6371000 * asin(least(1, sqrt(
                       power(sin(radians((i.last_location->>'latitude')::float8 - p_lat) / 2), 2)
                     + cos(radians(p_lat)) * cos(radians((i.last_location->>'latitude')::float8))
                     * power(sin(radians((i.last_location->>'longitude')::float8 - p_lng) / 2), 2))))
           END AS distance_m
    FROM individuals i
)
SELECT l.id, l.name, l.data, l.urgency_score, l.urgency_override, l.last_location,
       l.created_at, l.updated_at,
       COALESCE(l.urgency_override, l.urgency_score) AS display_urgency,
       (SELECT max(x.created_at) FROM interactions x WHERE x.individual_id = l.id) AS last_seen,
       l.distance_m
FROM located l
WHERE p_lat IS NULL OR p_lng IS NULL
   OR (l.distance_m IS NOT NULL AND l.distance_m <= coalesce(p_radius_m, 1000))
ORDER BY display_urgency DESC, last_seen DESC NULLS LAST, l.id
LIMIT least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

REVOKE EXECUTE ON FUNCTION most_urgent_individuals(double precision, double precision, double precision, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION most_urgent_individuals(double precision, double precision, double precision, int) TO service_role;
NOTIFY pgrst, 'reload schema';
