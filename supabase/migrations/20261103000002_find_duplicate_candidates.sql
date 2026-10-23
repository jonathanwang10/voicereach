-- Phase 3, migration 2 (H2-3.5): find_duplicate_candidates. Needs Phase 2's pg_trgm
-- migration (20261102000006) first. Idempotent; also folded into supabase/schema.sql.

-- H2-3.5: duplicate candidates in one call. Name leg: trigram match (`%`, served by the GIN
-- trigram index) or a token ILIKE (tokens of 3+ letters/digits, else of 2, as
-- DuplicateDetectionService._name_tokens). Value leg: a string value (or list item) of the
-- 200 most recently updated people that starts a word with the whole name, e.g. an "aka";
-- values only, never keys (C-01). Name matches first, closest name first.
CREATE OR REPLACE FUNCTION find_duplicate_candidates(p_name text, p_limit int DEFAULT 50)
RETURNS SETOF individuals
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH words AS (
    SELECT w FROM regexp_split_to_table(lower(btrim(p_name)), '[^[:alnum:]]+') AS w WHERE w <> ''
  ),
  patterns AS (
    SELECT '%' || w || '%' AS p FROM words
    WHERE length(w) >= CASE WHEN EXISTS (SELECT 1 FROM words WHERE length(w) >= 3) THEN 3 ELSE 2 END
  ),
  needle AS (
    SELECT replace(replace(replace(lower(btrim(p_name)), '\', '\\'), '%', '\%'), '_', '\_') AS n
  ),
  recent AS (SELECT id FROM individuals ORDER BY updated_at DESC LIMIT 200)
  SELECT i.* FROM individuals i
  WHERE i.name % p_name
     OR i.name ILIKE ANY (SELECT p FROM patterns)
     OR (i.id IN (SELECT id FROM recent) AND CASE WHEN jsonb_typeof(i.data) = 'object' THEN EXISTS (
           SELECT 1 FROM jsonb_each(i.data) e,
                LATERAL jsonb_array_elements_text(CASE jsonb_typeof(e.value)
                    WHEN 'array' THEN e.value WHEN 'string' THEN jsonb_build_array(e.value)
                    ELSE '[]'::jsonb END) AS v(t)
           WHERE lower(v.t) LIKE (SELECT n FROM needle) || '%'
              OR lower(v.t) LIKE '% ' || (SELECT n FROM needle) || '%') ELSE FALSE END)
  ORDER BY (i.name % p_name OR i.name ILIKE ANY (SELECT p FROM patterns)) DESC,
           similarity(i.name, p_name) DESC, i.updated_at DESC
  LIMIT p_limit;
$$;
REVOKE EXECUTE ON FUNCTION find_duplicate_candidates(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION find_duplicate_candidates(text, int) TO service_role;
