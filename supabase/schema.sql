-- ============================================================================
-- VoiceReach database schema: the full current schema for a fresh database.
-- Run it in the Supabase SQL Editor. It creates every table, turns row-level
-- security on with NO policies, and seeds the preset categories (required
-- config). It inserts no demo people: those are in supabase/seed.sql, which is
-- optional and never for production (H2-2.1).
--
-- Upgrading an existing database: apply supabase/migrations/*.sql in filename
-- order. This file is also still safe to re-run: tables, indexes, triggers and
-- the preset categories are guarded, and it upgrades a database created by an
-- older version of this file (old policies dropped, NOT NULL / CHECK constraints
-- added).
--
-- Access model: only the backend touches these tables, with the service key
-- (which bypasses RLS). With RLS on and no policies, the anon key and every
-- signed-in user's token can read nothing and write nothing directly.
--
-- After running it:
--   1. Authentication -> Add user: demo@sfgov.org / demo123456, Auto Confirm.
--   2. Authentication -> Sign In / Providers: disable sign-ups ("Allow new users
--      to sign up" off) and keep anonymous sign-ins disabled. The backend
--      accepts ANY user of this project unless ALLOWED_USER_EMAILS is set.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- categories — the schema-as-data table. Rows here define the app's fields.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT UNIQUE NOT NULL,
    display_name   TEXT,
    type           TEXT NOT NULL
                   CHECK (type IN ('text','number','single_select','multi_select','date','location')),
    options        JSONB,
    priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
    urgency_weight INTEGER NOT NULL DEFAULT 0,
    auto_trigger   BOOLEAN NOT NULL DEFAULT FALSE,
    is_required    BOOLEAN NOT NULL DEFAULT FALSE,
    is_preset      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,   -- reserved; not currently filtered on
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- maintained by set_updated_at()
);

-- ---------------------------------------------------------------------------
-- individuals — current aggregated state, one row per person
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS individuals (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    data             JSONB NOT NULL DEFAULT '{}',
    urgency_score    INTEGER NOT NULL DEFAULT 0,
    urgency_override INTEGER
                     CONSTRAINT individuals_urgency_override_range
                     CHECK (urgency_override IS NULL OR urgency_override BETWEEN 0 AND 100),
    last_location    JSONB,
    version          INTEGER NOT NULL DEFAULT 1,          -- bumped only by save_individual (H2-2.3)
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- maintained by set_updated_at()
);

-- ---------------------------------------------------------------------------
-- interactions — append-only history: a trigger refuses UPDATE (except location
-- coarsening); DELETE is allowed so a person's history goes with them.
-- `changes` holds ONLY the fields that changed in that visit (the whole payload
-- on the first interaction).
-- user_id is TEXT, not a UUID FK: the backend passes the demo user's id as text.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interactions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    individual_id UUID NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
    user_id       TEXT,
    user_name     TEXT NOT NULL DEFAULT 'Unknown',
    transcription TEXT,
    audio_url     TEXT,
    location      JSONB,
    changes       JSONB NOT NULL DEFAULT '{}',
    client_request_id UUID UNIQUE,                   -- the save's Idempotency-Key (H2-2.4)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- individual_embeddings — 3072-dim vectors stored as a JSON array.
-- (pgvector would be the right home; the app does cosine similarity in Python.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS individual_embeddings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    individual_id  UUID NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
    embedding_data JSONB NOT NULL,
    embedding_text TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- maintained by set_updated_at()
    UNIQUE (individual_id)
);

-- ---------------------------------------------------------------------------
-- Upgrade tables created by an older version of this file. CREATE TABLE IF NOT
-- EXISTS leaves an existing table alone, so its constraints are applied here.
-- Every statement is a no-op on a fresh database and safe to repeat.
-- ---------------------------------------------------------------------------
UPDATE categories SET
    priority       = COALESCE(priority, 'medium'),
    urgency_weight = COALESCE(urgency_weight, 0),
    auto_trigger   = COALESCE(auto_trigger, FALSE),
    is_required    = COALESCE(is_required, FALSE),
    is_preset      = COALESCE(is_preset, FALSE),
    is_active      = COALESCE(is_active, TRUE),
    created_at     = COALESCE(created_at, NOW()),
    updated_at     = COALESCE(updated_at, NOW())
WHERE priority IS NULL OR urgency_weight IS NULL OR auto_trigger IS NULL OR is_required IS NULL
   OR is_preset IS NULL OR is_active IS NULL OR created_at IS NULL OR updated_at IS NULL;

ALTER TABLE categories
    ALTER COLUMN priority       SET NOT NULL,
    ALTER COLUMN urgency_weight SET NOT NULL,
    ALTER COLUMN auto_trigger   SET NOT NULL,
    ALTER COLUMN is_required    SET NOT NULL,
    ALTER COLUMN is_preset      SET NOT NULL,
    ALTER COLUMN is_active      SET NOT NULL,
    ALTER COLUMN created_at     SET NOT NULL,
    ALTER COLUMN updated_at     SET NOT NULL;

UPDATE individuals SET
    urgency_score = COALESCE(urgency_score, 0),
    created_at    = COALESCE(created_at, NOW()),
    updated_at    = COALESCE(updated_at, NOW())
WHERE urgency_score IS NULL OR created_at IS NULL OR updated_at IS NULL;

UPDATE individuals SET urgency_override = LEAST(GREATEST(urgency_override, 0), 100)
WHERE urgency_override NOT BETWEEN 0 AND 100;

ALTER TABLE individuals
    ALTER COLUMN urgency_score SET NOT NULL,
    ALTER COLUMN created_at    SET NOT NULL,
    ALTER COLUMN updated_at    SET NOT NULL;

ALTER TABLE individuals DROP CONSTRAINT IF EXISTS individuals_urgency_override_range;
ALTER TABLE individuals ADD CONSTRAINT individuals_urgency_override_range
    CHECK (urgency_override IS NULL OR urgency_override BETWEEN 0 AND 100);

-- An interaction with no individual belongs to nobody: no route can reach it.
DELETE FROM interactions WHERE individual_id IS NULL;

UPDATE interactions SET
    user_name  = COALESCE(user_name, 'Unknown'),
    created_at = COALESCE(created_at, NOW())
WHERE user_name IS NULL OR created_at IS NULL;

ALTER TABLE interactions
    ALTER COLUMN user_name     SET DEFAULT 'Unknown',
    ALTER COLUMN individual_id SET NOT NULL,
    ALTER COLUMN user_name     SET NOT NULL,
    ALTER COLUMN created_at    SET NOT NULL;

UPDATE individual_embeddings SET
    created_at = COALESCE(created_at, NOW()),
    updated_at = COALESCE(updated_at, NOW())
WHERE created_at IS NULL OR updated_at IS NULL;

ALTER TABLE individual_embeddings
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN updated_at SET NOT NULL;

-- Phase 2 columns (supabase/migrations/20261102000001_save_individual.sql)
ALTER TABLE individuals ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS client_request_id UUID UNIQUE;

-- ---------------------------------------------------------------------------
-- updated_at is set by the database on every UPDATE, so it no longer depends
-- on which writer (or whose clock) made the change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_at ON categories;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON individuals;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON individuals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON individual_embeddings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON individual_embeddings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

-- ---------------------------------------------------------------------------
-- save_individual: one save (a new person, or a merge into an existing one)
-- plus its interaction row, in one transaction (H2-2.2).
--   - Idempotent (H2-2.4): a save carries the app's Idempotency-Key as
--     p_client_request_id. A key already stored on an interaction replays that
--     save's result ('replayed': true) and writes nothing. The key is checked
--     BEFORE the version, so a retry after a lost response replays instead of
--     409-ing. An advisory lock serialises two retries of the same key.
--   - Optimistic concurrency (H2-2.3): a merge updates only while
--     individuals.version still equals p_expected_version (NULL skips the check)
--     and bumps it. A mismatch raises P0409 (the backend answers 409); a
--     missing target raises P0002 (404). Only this function changes `version`.
--     Two concurrent merges with the same expected version queue on the row
--     lock; under READ COMMITTED the second re-checks its WHERE against the
--     committed row, matches nothing and raises P0409, so no FOR UPDATE is needed.
--   - Returns {"individual": row, "interaction": row, "replayed": bool}.
-- Only the backend (service_role) may call it: Supabase exposes public functions
-- on /rest/v1/rpc to the anon key otherwise.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_individual(
    p_individual_id uuid, p_name text, p_data jsonb, p_urgency_score int,
    p_interaction jsonb, p_expected_version int, p_client_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_ind public.individuals; v_int public.interactions; v_loc jsonb;
BEGIN
    IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_interaction) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'p_data and p_interaction must be JSON objects' USING ERRCODE = '22023';
    END IF;
    -- 1. Idempotency: one save per key. The lock serialises two retries of the same key.
    IF p_client_request_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('save_individual:' || p_client_request_id::text, 0));
        SELECT * INTO v_int FROM public.interactions WHERE client_request_id = p_client_request_id;
        IF FOUND THEN
            SELECT * INTO v_ind FROM public.individuals WHERE id = v_int.individual_id;
            RETURN jsonb_build_object('individual', to_jsonb(v_ind), 'interaction', to_jsonb(v_int), 'replayed', true);
        END IF;
    END IF;
    v_loc := NULLIF(p_interaction->'location', 'null'::jsonb);   -- absent or JSON null -> SQL NULL
    -- 2. The person: insert, or update guarded by the version the client saw
    IF p_individual_id IS NULL THEN
        INSERT INTO public.individuals (name, data, urgency_score, last_location)
        VALUES (p_name, p_data, p_urgency_score, v_loc) RETURNING * INTO v_ind;
    ELSE
        UPDATE public.individuals
        SET name = p_name, data = p_data, urgency_score = p_urgency_score,
            last_location = COALESCE(v_loc, last_location), version = version + 1
        WHERE id = p_individual_id AND (p_expected_version IS NULL OR version = p_expected_version)
        RETURNING * INTO v_ind;
        IF NOT FOUND THEN
            IF EXISTS (SELECT 1 FROM public.individuals WHERE id = p_individual_id) THEN
                RAISE EXCEPTION 'This person was changed by someone else. Reload and try again.' USING ERRCODE = 'P0409';
            END IF;
            RAISE EXCEPTION 'Individual not found' USING ERRCODE = 'P0002';
        END IF;
    END IF;
    -- 3. The visit, in the same transaction (no compensating delete any more)
    INSERT INTO public.interactions (individual_id, user_id, user_name, transcription, audio_url,
                                     location, changes, client_request_id)
    VALUES (v_ind.id, p_interaction->>'user_id', COALESCE(p_interaction->>'user_name', 'Unknown'),
            p_interaction->>'transcription', p_interaction->>'audio_url', v_loc,
            COALESCE(NULLIF(p_interaction->'changes', 'null'::jsonb), '{}'::jsonb), p_client_request_id)
    RETURNING * INTO v_int;
    RETURN jsonb_build_object('individual', to_jsonb(v_ind), 'interaction', to_jsonb(v_int), 'replayed', false);
END;
$$;

REVOKE EXECUTE ON FUNCTION save_individual(uuid, text, jsonb, int, jsonb, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_individual(uuid, text, jsonb, int, jsonb, int, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Indexes. Only the ones a query actually uses:
--   - interactions(individual_id, created_at DESC): history and "latest
--     interaction per person" (last seen); also serves individual_id lookups
-- individual_embeddings(individual_id) is already indexed by its UNIQUE.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_individuals_data;          -- GIN on data: no query used it
DROP INDEX IF EXISTS idx_individuals_urgency;       -- urgency sorting happens in Python
DROP INDEX IF EXISTS idx_embeddings_individual;     -- duplicate of the UNIQUE index
DROP INDEX IF EXISTS idx_interactions_individual;   -- prefix of the composite below
DROP INDEX IF EXISTS idx_interactions_created;      -- superseded by the composite below
DROP INDEX IF EXISTS idx_individuals_name;          -- names are sorted and matched in Python;
                                                    -- a plain b-tree can't serve ILIKE

CREATE INDEX IF NOT EXISTS idx_interactions_latest    ON interactions(individual_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Preset categories.
-- NOTE: skin_color is deliberately absent — it was removed earlier in the project
-- because it was a *scored* field with different urgency values per skin tone.
-- Do not reintroduce it.
-- ---------------------------------------------------------------------------
INSERT INTO categories
  (name, display_name, type, is_required, is_preset, priority, urgency_weight, auto_trigger, options)
VALUES
  ('name',   'Name',   'text',   TRUE,  TRUE, 'high',   0,  FALSE, NULL),
  ('height', 'Height', 'number', TRUE,  TRUE, 'medium', 0,  FALSE, NULL),
  ('weight', 'Weight', 'number', TRUE,  TRUE, 'medium', 0,  FALSE, NULL),
  ('age',    'Age',    'number', FALSE, TRUE, 'medium', 0,  FALSE, NULL),

  ('gender', 'Gender', 'single_select', FALSE, TRUE, 'medium', 0, FALSE,
   '[{"label":"Male","value":0},{"label":"Female","value":0},
     {"label":"Other","value":0},{"label":"Unknown","value":0}]'::jsonb),

  ('substance_abuse_history', 'Substance Abuse History', 'multi_select', FALSE, TRUE, 'high', 0, FALSE,
   '["None","Mild","Moderate","Severe","In Recovery"]'::jsonb),

  ('medical_conditions', 'Medical Conditions', 'multi_select', FALSE, FALSE, 'high', 0, FALSE,
   '["Diabetes","Heart Disease","Mental Health","Mobility Issues","Chronic Pain","None"]'::jsonb),

  ('veteran_status', 'Veteran Status', 'single_select', FALSE, FALSE, 'high', 20, FALSE,
   '[{"label":"Yes","value":1},{"label":"No","value":0},{"label":"Unknown","value":0}]'::jsonb),

  ('housing_priority', 'Housing Priority', 'single_select', FALSE, FALSE, 'high', 30, FALSE,
   '[{"label":"Critical","value":1},{"label":"High","value":0.7},
     {"label":"Medium","value":0.4},{"label":"Low","value":0.1}]'::jsonb),

  -- auto_trigger: pins the urgency score to 100 only when the chosen option's
  -- value is > 0, so "None" does not trigger
  ('behavior', 'Behavior', 'single_select', FALSE, FALSE, 'high', 40, TRUE,
   '[{"label":"None","value":0},{"label":"Verbal Only","value":0.3},
     {"label":"Physical","value":1}]'::jsonb),

  ('additional_information', 'Additional Information', 'text', FALSE, TRUE, 'low', 0, FALSE, NULL)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS: enabled on every table, with NO policies. The anon key and signed-in
-- users' tokens therefore see no rows and can't write any; the app uses
-- Supabase for sign-in only and reaches data through the backend, whose
-- service key bypasses RLS. Do not add policies back: every earlier one
-- (dropped below) granted full access to everyone signed in.
-- ---------------------------------------------------------------------------
ALTER TABLE categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE individuals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE individual_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on categories"   ON categories;
DROP POLICY IF EXISTS "Allow all operations on individuals"  ON individuals;
DROP POLICY IF EXISTS "Allow all operations on interactions" ON interactions;
DROP POLICY IF EXISTS "demo all categories"  ON categories;
DROP POLICY IF EXISTS "demo all individuals" ON individuals;
DROP POLICY IF EXISTS "demo all inter"       ON interactions;
DROP POLICY IF EXISTS "demo all embeddings"  ON individual_embeddings;
DROP POLICY IF EXISTS "signed-in users: categories"   ON categories;
DROP POLICY IF EXISTS "signed-in users: individuals"  ON individuals;
DROP POLICY IF EXISTS "signed-in users: interactions" ON interactions;
DROP POLICY IF EXISTS "signed-in users: embeddings"   ON individual_embeddings;

-- ---------------------------------------------------------------------------
-- Verify. "policies" must be 0; anything else is a policy this file doesn't
-- know about. Find it with:
--   SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';
-- ---------------------------------------------------------------------------
SELECT 'categories'  AS table_name, COUNT(*) FROM categories
UNION ALL SELECT 'individuals',  COUNT(*) FROM individuals
UNION ALL SELECT 'interactions', COUNT(*) FROM interactions
UNION ALL SELECT 'policies',     COUNT(*) FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename IN ('categories', 'individuals', 'interactions', 'individual_embeddings');
