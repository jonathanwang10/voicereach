-- Phase 4, migration 1. Needs pgvector 0.7.0 or later (halfvec); see the manual steps.
-- H2-4.1: embeddings move from a JSONB array to pgvector halfvec(3072) with an HNSW index
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS embedding halfvec(3072);
ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS text_hash TEXT;
ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'individual_embeddings'
               AND column_name = 'embedding_data') THEN
    -- Another size can't be cast and was never searchable (C-34); --stale re-creates it
    DELETE FROM individual_embeddings
     WHERE CASE WHEN jsonb_typeof(embedding_data) = 'array'
                THEN jsonb_array_length(embedding_data) <> 3072 ELSE TRUE END;
    UPDATE individual_embeddings SET embedding = (embedding_data::text)::halfvec(3072)
     WHERE embedding IS NULL;
    ALTER TABLE individual_embeddings DROP COLUMN embedding_data;
  END IF;
END $$;

DELETE FROM individual_embeddings WHERE embedding IS NULL;
-- Old rows were all text-embedding-3-large; hashing the stored text means an unchanged
-- person isn't re-embedded by --stale
UPDATE individual_embeddings SET
    model             = COALESCE(model, 'text-embedding-3-large'),
    text_hash         = COALESCE(text_hash, encode(sha256(convert_to(embedding_text, 'UTF8')), 'hex')),
    source_updated_at = COALESCE(source_updated_at, updated_at)
WHERE model IS NULL OR text_hash IS NULL OR source_updated_at IS NULL;

ALTER TABLE individual_embeddings
    ALTER COLUMN embedding         SET NOT NULL,
    ALTER COLUMN model             SET NOT NULL,
    ALTER COLUMN text_hash         SET NOT NULL,
    ALTER COLUMN source_updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_individual_embeddings_hnsw
    ON individual_embeddings USING hnsw (embedding halfvec_cosine_ops);

NOTIFY pgrst, 'reload schema';
