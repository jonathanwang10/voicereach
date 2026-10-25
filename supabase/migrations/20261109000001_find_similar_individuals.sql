-- Phase 9, migration 1 (H2-9.1): find_similar_individuals, the duplicate check's meaning
-- leg. Needs Phase 4's individual_embeddings (20261104000001) first. Idempotent; also
-- folded into supabase/schema.sql.

-- Load pgvector in this session first: until then hnsw.ef_search is an unknown
-- placeholder, and Supabase's postgres role (not a superuser) can't SET one on a function
DO $$ BEGIN PERFORM '[1]'::extensions.halfvec; END $$;
-- find_similar_individuals (H2-9.1): the people whose stored vector is nearest a new
-- record's (cosine), at or above a similarity floor, closest first (ties by id). The
-- duplicate check's meaning leg: it finds "Big Red" for a record of "Mike" when the rest
-- of the record matches, which a name match can't. People with no vector aren't found.
CREATE OR REPLACE FUNCTION find_similar_individuals(
    p_embedding halfvec(3072), p_limit int DEFAULT 5, p_min_similarity double precision DEFAULT 0.6
)
RETURNS TABLE (id uuid, name text, data jsonb, last_location jsonb, similarity double precision)
LANGUAGE sql STABLE
SET search_path = public, extensions
SET hnsw.ef_search = 100
AS $$
SELECT i.id, i.name, i.data, i.last_location, 1 - nn.dist
FROM (
    SELECT e.individual_id, e.embedding <=> p_embedding AS dist
    FROM individual_embeddings e
    WHERE p_embedding IS NOT NULL
    ORDER BY e.embedding <=> p_embedding LIMIT least(greatest(coalesce(p_limit, 5), 1), 20)
) nn JOIN individuals i ON i.id = nn.individual_id
WHERE 1 - nn.dist >= coalesce(p_min_similarity, 0.6)
ORDER BY nn.dist, i.id;
$$;

REVOKE EXECUTE ON FUNCTION find_similar_individuals(halfvec, int, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION find_similar_individuals(halfvec, int, double precision) TO service_role;
