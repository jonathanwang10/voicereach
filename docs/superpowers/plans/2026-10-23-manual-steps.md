# Hardening round 2: manual steps for the owner

Agents never apply anything to the hosted Supabase project or Railway (roadmap,
owner decision 2). Every step that needs the owner is listed here, by phase.

## Apply migrations

Apply in this order (Supabase SQL editor, or `psql "$SUPABASE_DB_URL" -f <file>`).
Each file is idempotent.

- Phase 1: no migrations.

1. `supabase/migrations/20261102000001_save_individual.sql` (Phase 2, Task 3): run in the SQL Editor. Check: `select version, count(*) from individuals group by 1;` returns version 1 for every row.
2. `supabase/migrations/20261102000002_interactions_append_only.sql` (Phase 2, Task 8). Check: `update interactions set user_name = user_name where false;` succeeds, and the same without `where false` fails with "interactions are append-only".
3. `supabase/migrations/20261102000003_audit_log.sql` (Phase 2, Task 9). Check: `delete from audit_log;` fails with "audit_log is append-only".
4. `supabase/migrations/20261102000004_number_scale_max.sql` (Phase 2, Task 11). Check: `select number_scale_max from categories;` is null for every existing row (scores unchanged).
5. `supabase/migrations/20261102000005_rescore_batch.sql` (Phase 2, Task 13). Then: `cd backend && python scripts/rescore_urgency.py`.
6. `supabase/migrations/20261102000006_name_trigram_index.sql` (Phase 2, Task 14). Before it, see Owner actions item 5 (pg_trgm's schema).
7. `supabase/migrations/20261102000007_coarsen_old_locations.sql` (Phase 2, Task 15). Check: `select coarsen_old_locations(30);` returns a count; a second run returns 0.
8. `supabase/migrations/20261103000001_categories_is_sensitive.sql` (Phase 3, Task 1), then `cd backend && python scripts/rescore_urgency.py`. Then check `SELECT name, urgency_weight, auto_trigger FROM categories WHERE is_sensitive AND (urgency_weight > 0 OR auto_trigger);`: those rows no longer score; the owner decides whether to clear their weights.
9. `supabase/migrations/20261103000002_find_duplicate_candidates.sql` (Phase 3, Task 6; needs migration 6, `pg_trgm`, first). Check: `SELECT name FROM find_duplicate_candidates('Jon Smith');` returns a "John Smith" if one exists.

## Environment variables

| Name | Default | Service | Phase |
|---|---|---|---|
| `CHAT_MODEL` | `gpt-4o` | backend | 1 |
| `TRANSCRIBE_MODEL` | `gpt-transcribe` (Phase 3; was `whisper-1` in Phase 1) | backend | 1, 3 |
| `REALTIME_MODEL` | `gpt-realtime` | backend | 1 |
| `EMBEDDING_MODEL` | `text-embedding-3-large` | backend | 1 |
| `RATE_LIMIT_SAVE_PER_MIN` | 30 | backend | 1 |
| `RATE_LIMIT_CATEGORY_CREATE_PER_MIN` | 10 | backend | 1 |
| `RATE_LIMIT_DELETE_PER_MIN` | 30 | backend | 1 |
| `RATE_LIMIT_<NAME>_TOTAL_PER_MIN` | 5 x that bucket's per-device limit | backend | 1 |
| `REALTIME_MAX_SESSIONS_PER_USER` | 2 (per user + `X-Device-Id`) | backend | 1 |
| `REALTIME_MAX_SESSIONS_TOTAL` | 20 (per process) | backend | 1 |
| `ENABLE_API_DOCS` | unset (off; `1` serves `/docs`, `/redoc`, `/openapi.json`) | backend | 1 |

## Device checks

Numbered steps with the expected result. Run them on a physical iPhone after a
native rebuild (`npx expo prebuild --platform ios && npx expo run:ios --device`).

- Phase 1: none (backend only).

1. D2.1 (Phase 2, Task 5) `expo-crypto` is a new native module: run `cd mobile && npx expo prebuild --platform ios` (or `pod install` in `mobile/ios`), rebuild with `npx expo run:ios`, record and save one person. Expected: the save succeeds and the backend log shows no 400 for `Idempotency-Key`.

## Owner actions outside code

1. Request OpenAI zero data retention and, if records are real client data, a BAA.
2. Confirm the keys leaked in git history (2025: an OpenAI key and Supabase
   service-role keys) are revoked.
3. Run `eas init` for the mobile project (Phase 8 adds `mobile/eas.json`).
4. Choose the App Store bundle id (Phase 8 leaves a placeholder).
5. (Phase 2, Task 14) Check `select extnamespace::regnamespace from pg_extension where extname = 'pg_trgm';` returns `extensions`. If it says `public` (installed earlier), run `ALTER EXTENSION pg_trgm SET SCHEMA extensions;` then re-run migration 6.
6. (Phase 2, Task 15) Enable pg_cron (Dashboard → Database → Extensions), then run the commented `cron.schedule` line from `supabase/schema.sql` once. Check: `select jobname, schedule from cron.job;` lists `coarsen-old-locations`.
7. (Phase 3, Task 5) After deploying, make one recording and confirm the transcript comes back. If OpenAI rejects `prompt` or `response_format=json` for the default `gpt-transcribe`, set `TRANSCRIBE_MODEL` to another transcription model that accepts both (for example `gpt-4o-mini-transcribe` until its 2027-02-26 shutdown) and report it.
