-- Phase 2, migration 6 (H2-2.10): pg_trgm (in the `extensions` schema, Supabase's
-- convention) and a GIN trigram index on individuals.name, for ILIKE / % /
-- similarity() name lookups (duplicate candidates, search). The Idempotency-Key
-- lookup is already served by interactions_client_request_id_key (migration 1).
-- Idempotent; also folded into supabase/schema.sql.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_individuals_name_trgm ON individuals USING gin (name extensions.gin_trgm_ops);
