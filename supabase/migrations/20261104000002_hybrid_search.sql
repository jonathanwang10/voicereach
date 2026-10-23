-- Phase 4, migration 2. The generated column rewrites individuals once.
-- H2-4.2: full-text over the name and data VALUES (never keys, C-01), always current
ALTER TABLE individuals ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(name, ''))
        || jsonb_to_tsvector('simple'::regconfig, coalesce(data, '{}'::jsonb), '["string"]'::jsonb)) STORED;
CREATE INDEX IF NOT EXISTS idx_individuals_search_tsv ON individuals USING gin (search_tsv);

-- ---------------------------------------------------------------------------
-- search_individuals_hybrid (H2-4.2): one ranked search over three legs.
--   - Legs: each returns at most 3 x limit candidates, ranked from 1 and tie-broken
--     by id. name: an ILIKE substring match or a trigram match at pg_trgm's default
--     0.3, substring matches first, then by similarity; text: search_tsv @@ tsq, by
--     ts_rank_cd; vector: nearest by cosine distance, keeping only similarity >=
--     p_min_similarity.
--   - Fusion: score = sum of 1/(60 + rank) over the legs a person appears in.
--   - Exact names: a case-insensitive exact name match (ILIKE on the escaped query,
--     which is equality) sorts first whatever its score.
--   - Ties: score desc, then updated_at desc, then id. match_source is 'exact', else
--     the leg where the person ranked best (a tie goes to name, then text, then
--     semantic). similarity is the cosine similarity when the vector leg had the
--     person, else NULL.
--   - No embedding: a NULL embedding (the text-only fallback) empties the vector leg,
--     and the other two fuse alone. A blank query returns no rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_individuals_hybrid(
    p_query text, p_query_embedding halfvec(3072),
    p_limit int DEFAULT 20, p_min_similarity double precision DEFAULT 0.15
)
RETURNS TABLE (id uuid, name text, data jsonb, urgency_score int, urgency_override int,
               last_location jsonb, version int, created_at timestamptz, updated_at timestamptz,
               score double precision, match_source text, similarity double precision)
LANGUAGE sql STABLE
SET search_path = public, extensions
SET hnsw.ef_search = 100
AS $$
WITH raw AS (
    SELECT btrim(coalesce(p_query, '')) AS q, least(greatest(coalesce(p_limit, 20), 1), 50) AS lim
), p AS (
    SELECT q, lim, lim * 3 AS k,
           -- the query is literal text: LIKE wildcards are escaped
           replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') AS esc,
           -- whole words (websearch) OR word prefixes ("diab" finds Diabetes, "male" not Female)
           CASE WHEN pre.tsq IS NULL THEN websearch_to_tsquery('simple', q)
                ELSE websearch_to_tsquery('simple', q) || pre.tsq END AS tsq
    FROM raw, LATERAL (
        SELECT to_tsquery('simple', string_agg(tok || ':*', ' & ')) AS tsq
        FROM regexp_split_to_table(lower(raw.q), '[^[:alnum:]]+') AS tok WHERE tok <> ''
    ) pre
), name_leg AS (
    SELECT i.id, row_number() OVER (ORDER BY (i.name ILIKE '%' || p.esc || '%') DESC,
                                             similarity(i.name, p.q) DESC, i.id) AS rnk
    FROM individuals i, p
    WHERE p.q <> '' AND (i.name ILIKE '%' || p.esc || '%' OR i.name % p.q)
    ORDER BY rnk LIMIT (SELECT k FROM p)
), text_leg AS (
    SELECT i.id, row_number() OVER (ORDER BY ts_rank_cd(i.search_tsv, p.tsq) DESC, i.id) AS rnk
    FROM individuals i, p
    WHERE p.q <> '' AND i.search_tsv @@ p.tsq
    ORDER BY rnk LIMIT (SELECT k FROM p)
), vector_nn AS (
    SELECT e.individual_id AS id, e.embedding <=> p_query_embedding AS dist
    FROM individual_embeddings e
    WHERE p_query_embedding IS NOT NULL AND (SELECT q FROM p) <> ''
    ORDER BY e.embedding <=> p_query_embedding LIMIT (SELECT k FROM p)
), vector_leg AS (
    SELECT id, 1 - dist AS sim, row_number() OVER (ORDER BY dist, id) AS rnk
    FROM vector_nn WHERE 1 - dist >= coalesce(p_min_similarity, 0.15)
), legs AS (
    SELECT id, rnk, 1 AS leg, NULL::double precision AS sim FROM name_leg
    UNION ALL SELECT id, rnk, 2, NULL FROM text_leg
    UNION ALL SELECT id, rnk, 3, sim FROM vector_leg
), fused AS (
    SELECT id, sum(1.0 / (60 + rnk))::double precision AS score,
           (array_agg(leg ORDER BY rnk, leg))[1] AS best_leg, max(sim) AS similarity
    FROM legs GROUP BY id
)
SELECT i.id, i.name, i.data, i.urgency_score, i.urgency_override, i.last_location, i.version,
       i.created_at, i.updated_at, f.score,
       CASE WHEN i.name ILIKE p.esc THEN 'exact' ELSE (ARRAY['name', 'text', 'semantic'])[f.best_leg] END,
       f.similarity
FROM fused f JOIN individuals i ON i.id = f.id CROSS JOIN p
ORDER BY (i.name ILIKE p.esc) DESC, f.score DESC, i.updated_at DESC, i.id
LIMIT (SELECT lim FROM p);
$$;

REVOKE EXECUTE ON FUNCTION search_individuals_hybrid(text, halfvec, int, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION search_individuals_hybrid(text, halfvec, int, double precision) TO service_role;
NOTIFY pgrst, 'reload schema';
