-- Phase 2, migration 1 (H2-2.2, H2-2.3, H2-2.4): individuals.version,
-- interactions.client_request_id and the transactional save_individual function.
-- Idempotent; also folded into supabase/schema.sql.

-- version: bumped only by save_individual (H2-2.3).
-- client_request_id: the save's Idempotency-Key (H2-2.4); its UNIQUE index
-- (interactions_client_request_id_key) is the replay lookup.
ALTER TABLE individuals ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS client_request_id UUID UNIQUE;

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
