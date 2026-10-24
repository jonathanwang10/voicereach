-- Phase 7 (H2-7.3, H2-7.8): claiming jobs and purging old recordings. Idempotent;
-- folded into schema.sql.
-- ---------------------------------------------------------------------------
-- Claim one job for the in-process worker (H2-7.3). SKIP LOCKED lets two worker
-- loops claim different rows. A row is claimable when it is queued (after a backoff of
-- attempts * 30 s) or stuck in progress for 5 minutes (its worker died), and has had
-- fewer than 3 attempts. SETOF: no job is [], never a row of NULLs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_recording_job() RETURNS SETOF public.recordings
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    -- Stuck on its last attempt: it will never be claimed again, so fail it
    UPDATE public.recordings
       SET status = 'failed', error = 'Processing failed. Please record again.'
     WHERE status IN ('transcribing', 'extracting', 'checking_duplicates')
       AND updated_at < NOW() - INTERVAL '5 minutes'
       AND attempts >= 3;

    RETURN QUERY
    UPDATE public.recordings r
       SET status   = CASE WHEN r.transcription IS NULL THEN 'transcribing' ELSE 'extracting' END,
           attempts = r.attempts + 1,
           error    = NULL
     WHERE r.id = (
           SELECT c.id FROM public.recordings c
            WHERE c.attempts < 3
              AND ((c.status = 'queued' AND c.updated_at <= NOW() - c.attempts * INTERVAL '30 seconds')
                   OR (c.status IN ('transcribing', 'extracting', 'checking_duplicates')
                       AND c.updated_at < NOW() - INTERVAL '5 minutes'))
            ORDER BY c.created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED)
    RETURNING r.*;
END;
$$;

-- Rows older than p_days are deleted (H2-7.8). The stored files must go through the
-- Storage API, so this returns their paths and the backend worker removes them hourly.
CREATE OR REPLACE FUNCTION purge_old_recordings(p_days int DEFAULT 7) RETURNS SETOF text
LANGUAGE sql
SET search_path = ''
AS $$
    DELETE FROM public.recordings
     WHERE created_at < NOW() - make_interval(days => p_days)
    RETURNING storage_path;
$$;
-- Backend only (Phase 2's D7 pattern)
REVOKE EXECUTE ON FUNCTION claim_recording_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_recording_job() TO service_role;
REVOKE EXECUTE ON FUNCTION purge_old_recordings(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_old_recordings(int) TO service_role;
-- Optional, rows only (leaves any stored file behind; the backend purge is preferred):
-- SELECT cron.schedule('purge-old-recordings', '17 3 * * *', $$SELECT public.purge_old_recordings(7)$$);
