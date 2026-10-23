-- Phase 3, migration 3 (H2-3.6): duplicate_decisions, the merge / save-new labels.
-- RLS on with no policies, like every other table. Idempotent; also folded into
-- supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- duplicate_decisions — labels for the duplicate eval (H2-3.6): for each save
-- made from the merge screen, the match shown, its confidence, and whether the
-- worker merged or saved new. candidate_id is the record the save wrote (the new
-- person, or the merge target); matched_id the match on screen. One row per
-- save: client_request_id is the save's Idempotency-Key. No index beyond the PK
-- and UNIQUE: nothing reads it yet.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duplicate_decisions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    candidate_id      UUID NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
    matched_id        UUID NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
    confidence        INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    decision          TEXT NOT NULL CHECK (decision IN ('merged','saved_new')),
    model             TEXT,
    client_request_id UUID UNIQUE
);

ALTER TABLE duplicate_decisions ENABLE ROW LEVEL SECURITY;
