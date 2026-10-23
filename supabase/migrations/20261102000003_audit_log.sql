-- Phase 2, migration 3 (H2-2.7): the append-only audit_log table. RLS on with no
-- policies, like every other table. Idempotent; also folded into supabase/schema.sql.

-- ---------------------------------------------------------------------------
-- audit_log — who (user id, device id) did what to which record id, when
-- (H2-2.7). Ids and counts only: never names or field values. No foreign key,
-- so a deleted person's audit rows stay. Append-only: a trigger refuses UPDATE,
-- DELETE and TRUNCATE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id     TEXT NOT NULL,
    device_id   TEXT,
    action      TEXT NOT NULL CHECK (action IN ('view_profile','export_csv','delete_individual',
                    'override_urgency','merge_individual','create_individual','create_category')),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('individual','category','export')),
    entity_id   TEXT,
    detail      JSONB NOT NULL DEFAULT '{}'
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
