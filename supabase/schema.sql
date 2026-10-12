-- ============================================================================
-- VoiceReach database schema. Run it in the Supabase SQL Editor. It creates
-- every table, turns row-level security on with NO policies, and seeds the
-- preset categories and six demo individuals. There is no migration chain.
--
-- Safe to re-run: tables, indexes, triggers and seeds are guarded, and it also
-- upgrades a database created by an older version of this file (old policies
-- dropped, NOT NULL / CHECK constraints added, stale seed scores refreshed).
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
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- maintained by set_updated_at()
);

-- ---------------------------------------------------------------------------
-- interactions — append-only history. `changes` holds ONLY the fields that
-- changed in that visit (the whole payload on the first interaction).
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
-- A few demo individuals across all three urgency bands, so search and the
-- voice assistant have something to find. Names match the demo script.
--
-- urgency_score is exactly what services/urgency_calculator.py computes for
-- each row against the categories above (denominator = all weighted
-- categories: veteran 20 + housing 30 + behavior 40 = 90; Robert's behavior
-- auto-triggers 100). backend/tests/test_schema_sql.py checks this.
--
-- A seed person is inserted only if nobody with that name exists. The
-- `rescored` step fixes the score of a seed row left by an older version of
-- this file, but only while its data is still exactly the seed data.
-- ---------------------------------------------------------------------------
WITH seed (name, data, urgency_score) AS (VALUES
  ('Sarah Smith',
   '{"age":32,"height":65,"weight":140,"gender":"Female","substance_abuse_history":["None"],
     "veteran_status":"No","medical_conditions":["None"],"housing_priority":"Low"}'::jsonb, 3),

  ('Michael Chen',
   '{"age":28,"height":68,"weight":155,"gender":"Male","substance_abuse_history":["None"],
     "veteran_status":"No","medical_conditions":["None"],"housing_priority":"Medium"}'::jsonb, 13),

  ('John Doe',
   '{"age":45,"height":72,"weight":180,"gender":"Male","substance_abuse_history":["Moderate"],
     "veteran_status":"No","medical_conditions":["Diabetes"],"housing_priority":"High"}'::jsonb, 23),

  ('Maria Garcia',
   '{"age":38,"height":63,"weight":150,"gender":"Female","substance_abuse_history":["Moderate"],
     "veteran_status":"No","medical_conditions":["Mental Health"],"housing_priority":"Critical"}'::jsonb, 33),

  ('Robert Johnson',
   '{"age":58,"height":70,"weight":200,"gender":"Male","substance_abuse_history":["Severe"],
     "veteran_status":"Yes","medical_conditions":["Chronic Pain"],"housing_priority":"Critical",
     "behavior":"Verbal Only"}'::jsonb, 100),

  ('James Brown',
   '{"age":52,"height":72,"weight":185,"gender":"Male","substance_abuse_history":["None"],
     "veteran_status":"Yes","medical_conditions":["Heart Disease"],"housing_priority":"High"}'::jsonb, 45)
),
rescored AS (
  UPDATE individuals i
  SET    urgency_score = s.urgency_score
  FROM   seed s
  WHERE  i.name = s.name AND i.data = s.data AND i.urgency_score <> s.urgency_score
  RETURNING i.id
)
INSERT INTO individuals (name, data, urgency_score)
SELECT s.name, s.data, s.urgency_score
FROM   seed s
WHERE  NOT EXISTS (SELECT 1 FROM individuals i WHERE i.name = s.name);

-- Give each demo person one seed interaction so history and last-seen render,
-- but only a seed person who has no history yet (never a real person's).
INSERT INTO interactions (individual_id, user_id, user_name, transcription, location, changes)
SELECT
    i.id,
    'demo-user',
    'Demo User',
    'Seed interaction for ' || i.name || '.',
    '{"latitude":37.7821638619815,"longitude":-122.41033921502972,"address":"Market St & 5th St, San Francisco, CA"}'::jsonb,
    i.data
FROM individuals i
WHERE i.name IN ('Sarah Smith', 'Michael Chen', 'John Doe', 'Maria Garcia', 'Robert Johnson', 'James Brown')
  AND NOT EXISTS (SELECT 1 FROM interactions x WHERE x.individual_id = i.id);

-- The app reads individuals.last_location for the profile map. The backend sets
-- it on every write (individual_service.py), but the seed above inserts
-- interactions directly, so backfill it here or the demo profiles show no map.
UPDATE individuals i
SET    last_location = sub.location
FROM  (SELECT DISTINCT ON (individual_id) individual_id, location
       FROM   interactions
       WHERE  location IS NOT NULL
       ORDER  BY individual_id, created_at DESC) AS sub
WHERE i.id = sub.individual_id
  AND i.last_location IS NULL;

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
