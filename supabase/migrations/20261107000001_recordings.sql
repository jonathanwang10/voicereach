-- Phase 7 (H2-7.1): the recordings job table. Idempotent; folded into schema.sql.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- recordings: async transcription jobs (H2-7.1). One row per uploaded voice note,
-- from upload to review. No policies: only the backend (service key) touches it.
CREATE TABLE IF NOT EXISTS recordings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             TEXT NOT NULL,
    device_id           TEXT,
    client_recording_id UUID NOT NULL UNIQUE,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','transcribing','extracting','checking_duplicates','ready','failed')),
    storage_path        TEXT,
    duration_ms         INTEGER,
    location            JSONB,
    transcription       TEXT,
    result              JSONB,
    error               TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- maintained by set_updated_at()
);
DROP TRIGGER IF EXISTS set_updated_at ON recordings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON recordings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_recordings_claim ON recordings(status, created_at);
CREATE INDEX IF NOT EXISTS idx_recordings_owner ON recordings(user_id, created_at DESC);
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
