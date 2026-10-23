-- ============================================================================
-- VoiceReach demo data (optional). Six demo individuals and one seed
-- interaction each, so search, profiles and the voice assistant have something
-- to show. Run it AFTER supabase/schema.sql (it needs the preset categories),
-- and never on a production database.
--
-- Re-running it re-adds a demo person who was deleted (people are matched by
-- name), and refreshes the score of a demo row whose data is still exactly the
-- seed data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A few demo individuals across all three urgency bands, so search and the
-- voice assistant have something to find. Names match the demo script.
--
-- urgency_score is exactly what services/urgency_calculator.py computes for
-- each row against the preset categories in schema.sql (denominator = all weighted
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
