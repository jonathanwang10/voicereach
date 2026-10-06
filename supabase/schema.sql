-- ============================================================================
-- VoiceReach database schema. Run once in the Supabase SQL Editor on a new
-- project; it creates every table, enables RLS with signed-in-only policies, and
-- seeds categories and six demo individuals. There is no migration chain.
-- After running it, create the demo user (Authentication -> Add user,
-- demo@sfgov.org / demo123456, Auto Confirm).
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
    priority       TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
    urgency_weight INTEGER DEFAULT 0,
    auto_trigger   BOOLEAN DEFAULT FALSE,
    is_required    BOOLEAN DEFAULT FALSE,
    is_preset      BOOLEAN DEFAULT FALSE,
    is_active      BOOLEAN DEFAULT TRUE,   -- reserved; not currently filtered on
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- individuals — current aggregated state, one row per person
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS individuals (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    data             JSONB NOT NULL DEFAULT '{}',
    urgency_score    INTEGER DEFAULT 0,
    urgency_override INTEGER,
    last_location    JSONB,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- interactions — append-only history. `changes` holds ONLY the fields that
-- changed in that visit (the whole payload on the first interaction).
-- user_id is TEXT, not a UUID FK: the backend passes the demo user's id as text.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interactions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    individual_id UUID REFERENCES individuals(id) ON DELETE CASCADE,
    user_id       TEXT,
    user_name     TEXT,
    transcription TEXT,
    audio_url     TEXT,
    location      JSONB,
    changes       JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW()
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
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (individual_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_individuals_name          ON individuals(name);
CREATE INDEX IF NOT EXISTS idx_individuals_data          ON individuals USING GIN(data);
CREATE INDEX IF NOT EXISTS idx_individuals_urgency       ON individuals(urgency_score);
CREATE INDEX IF NOT EXISTS idx_interactions_individual   ON interactions(individual_id);
CREATE INDEX IF NOT EXISTS idx_interactions_created      ON interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_embeddings_individual     ON individual_embeddings(individual_id);

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
-- ---------------------------------------------------------------------------
INSERT INTO individuals (name, data, urgency_score, urgency_override) VALUES
  ('Sarah Smith',
   '{"age":32,"height":65,"weight":140,"gender":"Female","substance_abuse_history":["None"],
     "veteran_status":"No","medical_conditions":["None"],"housing_priority":"Low"}'::jsonb, 15, NULL),

  ('Michael Chen',
   '{"age":28,"height":68,"weight":155,"gender":"Male","substance_abuse_history":["None"],
     "veteran_status":"No","medical_conditions":["None"],"housing_priority":"Medium"}'::jsonb, 28, NULL),

  ('John Doe',
   '{"age":45,"height":72,"weight":180,"gender":"Male","substance_abuse_history":["Moderate"],
     "veteran_status":"No","medical_conditions":["Diabetes"],"housing_priority":"High"}'::jsonb, 52, NULL),

  ('Maria Garcia',
   '{"age":38,"height":63,"weight":150,"gender":"Female","substance_abuse_history":["Moderate"],
     "veteran_status":"No","medical_conditions":["Mental Health"],"housing_priority":"Critical"}'::jsonb, 61, NULL),

  ('Robert Johnson',
   '{"age":58,"height":70,"weight":200,"gender":"Male","substance_abuse_history":["Severe"],
     "veteran_status":"Yes","medical_conditions":["Chronic Pain"],"housing_priority":"Critical",
     "behavior":"Verbal Only"}'::jsonb, 100, NULL),

  ('James Brown',
   '{"age":52,"height":72,"weight":185,"gender":"Male","substance_abuse_history":["None"],
     "veteran_status":"Yes","medical_conditions":["Heart Disease"],"housing_priority":"High"}'::jsonb, 44, NULL)
ON CONFLICT DO NOTHING;

-- Give each demo person one seed interaction so history and last-seen render.
INSERT INTO interactions (individual_id, user_id, user_name, transcription, location, changes)
SELECT
    i.id,
    'demo-user',
    'Demo User',
    'Seed interaction for ' || i.name || '.',
    '{"latitude":37.7821638619815,"longitude":-122.41033921502972,"address":"Market St & 5th St, San Francisco, CA"}'::jsonb,
    i.data
FROM individuals i;

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
-- RLS: only signed-in users can read or write. The backend uses the service
-- key (bypasses RLS); the app signs in as the demo user before any query.
-- A real deployment would scope rows per agency.
-- ---------------------------------------------------------------------------
ALTER TABLE categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE individuals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE individual_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signed-in users: categories"  ON categories            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "signed-in users: individuals" ON individuals           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "signed-in users: interactions" ON interactions         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "signed-in users: embeddings"  ON individual_embeddings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
SELECT 'categories'  AS table_name, COUNT(*) FROM categories
UNION ALL SELECT 'individuals',  COUNT(*) FROM individuals
UNION ALL SELECT 'interactions', COUNT(*) FROM interactions;
