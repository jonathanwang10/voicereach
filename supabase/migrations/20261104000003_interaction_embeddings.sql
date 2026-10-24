-- Phase 4, migration 3 (H2-4.3): visit-level embeddings and match_interactions.
-- RLS on with no policies. Idempotent; also folded into supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- interaction_embeddings — one vector per visit transcript (H2-4.3), so a
-- question about something said on one visit can find it. The transcript itself
-- stays on the interaction; this holds only the vector, its model and the text hash.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interaction_embeddings (
    interaction_id UUID PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    individual_id  UUID NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
    embedding      halfvec(3072) NOT NULL,
    model          TEXT NOT NULL,
    text_hash      TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interaction_embeddings_hnsw
    ON interaction_embeddings USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_interaction_embeddings_individual ON interaction_embeddings (individual_id);

ALTER TABLE interaction_embeddings ENABLE ROW LEVEL SECURITY;

-- match_interactions (H2-4.3): the visits nearest the query by cosine distance (ties by
-- id), optionally for one person, with no threshold: callers apply their own floor.
-- Load pgvector in this session first: until then hnsw.ef_search is an unknown
-- placeholder, and Supabase's postgres role (not a superuser) can't SET one on a function
DO $$ BEGIN PERFORM '[1]'::extensions.halfvec; END $$;
CREATE OR REPLACE FUNCTION match_interactions(
    p_query_embedding halfvec(3072), p_individual_id uuid DEFAULT NULL, p_limit int DEFAULT 5
)
RETURNS TABLE (interaction_id uuid, individual_id uuid, created_at timestamptz,
               transcription text, location jsonb, similarity double precision)
LANGUAGE sql STABLE
SET search_path = public, extensions
SET hnsw.ef_search = 100
AS $$
SELECT nn.interaction_id, nn.individual_id, x.created_at, x.transcription, x.location, 1 - nn.dist
FROM (
    SELECT e.interaction_id, e.individual_id, e.embedding <=> p_query_embedding AS dist
    FROM interaction_embeddings e
    WHERE p_query_embedding IS NOT NULL
      AND (p_individual_id IS NULL OR e.individual_id = p_individual_id)
    ORDER BY e.embedding <=> p_query_embedding LIMIT least(greatest(coalesce(p_limit, 5), 1), 50)
) nn JOIN interactions x ON x.id = nn.interaction_id
ORDER BY nn.dist, nn.interaction_id;
$$;

REVOKE EXECUTE ON FUNCTION match_interactions(halfvec, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_interactions(halfvec, uuid, int) TO service_role;
NOTIFY pgrst, 'reload schema';
