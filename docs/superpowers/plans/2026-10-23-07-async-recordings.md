# Async Recordings and Offline Queue Implementation Plan

> **For agentic workers:** Implement this plan task by task yourself, in order (no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A finished recording is queued on the phone, uploaded in the background when there is a connection, processed by an in-process worker on the backend, and reviewed as a draft, so a worker never loses a note to a dead connection or a 2-minute spinner.

**Architecture:** The app moves each recording into `documentDirectory/recordings/`, records its metadata in `expo-sqlite`, and uploads it with `FileSystem.uploadAsync` (multipart, background session) to `POST /api/recordings`. That route stores the file in a private Supabase Storage bucket, inserts a `recordings` row and answers 202. Two asyncio loops started in the FastAPI `lifespan` claim jobs through `claim_recording_job()` (`FOR UPDATE SKIP LOCKED`) and run the same stage functions `/api/transcribe` now calls. The app polls `GET /api/recordings/{id}` with TanStack Query and opens `TranscriptionResults` on the stored result. No Redis, no Celery: Postgres plus the one process.

**Tech Stack:** FastAPI 0.142 (lifespan, `UploadFile`/`Form`), supabase-py 2.32 (PostgREST `rpc`, Storage), Postgres plpgsql; Expo SDK 53: `expo-sqlite` ~15.2.14, `expo-file-system` 18.1.11 (classic API), `@react-native-community/netinfo` 11.4.1, `@tanstack/react-query` (v5, from Phase 6), Jest + jest-expo.

**Spec:** `docs/superpowers/plans/2026-10-23-00-roadmap.md` (Phase 7, plus Global constraints and the interfaces of Phases 1, 2, 3 and 6).

## Global Constraints

- Python 3.11. If the venv is wrong, recreate it: `python3.11 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt -r requirements-dev.txt`.
- Every task must end with all of these passing: `python -m pytest -q` (repo root, offline), `ruff check backend --select F,E9`, `cd mobile && npx tsc --noEmit && npx jest`.
- Tests are offline. No test may call OpenAI or Supabase. `FakeSupabase` is strict: an unscripted query fails the test. Storage gets an equally strict fake (Task 3).
- CLAUDE.md rules still hold: no unauthenticated routes (only `/health` is open); never reintroduce `skin_color`; never call `supabase.from` in `mobile/`; no PII in logs (`backend/tests/test_no_pii_logs.py`, `mobile/test/noDataLogs.test.ts`); database text reaches a model only as a delimited `user` item or tool output.
- A task that changes a rule CLAUDE.md or README states (here, the upload format and the recording flow) updates CLAUDE.md and README in the same task.
- Migrations: `supabase/migrations/2026110700000S_<snake_name>.sql`, idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`), folded into `supabase/schema.sql`. `test_schema_contract.py` and `test_schema_sql.py` keep passing and are extended. Each migration gets a line in the manual-steps file.
- Agents never apply anything to hosted Supabase or Railway. Owner steps go into `docs/superpowers/plans/2026-10-23-manual-steps.md` (sections: Apply migrations, Environment variables, Device checks, Owner actions outside code).
- Git: branch `hardening-2`; one commit per task, conventional prefix, every message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never commit `.env` files or keys. Never push.
- Device-only behaviour (background upload, Data Protection, app kill) goes into the manual-steps Device checks section and does not block a task.
- No new infrastructure services. One process stays deliberate.
- Comments: short "why" comments; new items use the code `H2-7.<n>` (for example `(H2-7.3)`).
- Status copy (exact): "Uploading", "Queued: no connection", "Transcribing", "Ready to review".

## Interfaces consumed from earlier phases

These are the names the earlier phase plans define (checked across plans on 2026-10-23). Before Task 1, run the grep to confirm the code has them.

| From | Name used here | Check with |
|---|---|---|
| P1 | `db/client.py: async def run_db(fn: Callable[[], T]) -> T` | `grep -n "def run_db" backend/db/client.py` |
| P1 | `db/client.py: get_supabase() -> Client` (tests patch `api.<module>.get_supabase`) | `grep -rn "get_supabase" backend/api` |
| P1 | `services/openai_service.py: get_openai_service() -> OpenAIService` | `grep -n "def get_openai_service" backend/services/openai_service.py` |
| P1 | The M4A duration check (mutagen; 400 under 5 s or over 125 s): `services/openai_service.py: check_audio_duration(path: str, limits: AudioLimits) -> float` with `RECORDING_LIMITS` (seconds; raises `ValueError` with the client message) | `grep -n "def check_audio_duration\|RECORDING_LIMITS =" backend/services/openai_service.py` |
| P1 | `api/device.py: get_device_id` (FastAPI dependency; `None` when the header is missing or malformed) | `grep -n "def get_device_id" backend/api/device.py` |
| P1 | `rate_limit(bucket, env_var, default)` dependency, keyed on user id plus `X-Device-Id` | `backend/services/rate_limit.py` |
| P1 | `BODY_LIMITS` in `backend/main.py` | `grep -n "BODY_LIMITS" backend/main.py` |
| P2 | Strict `rpc` scripting on `FakeSupabase`: `sb.on_rpc(name, data=..., error=..., times=...)` and `sb.rpc_params(name) -> list[dict]` | `grep -n "def on_rpc\|def rpc_params" backend/tests/helpers.py` |
| P2 | The `Idempotency-Key` UUID that `TranscriptionResults` creates per review session and passes to `api.saveIndividual` | `grep -rn "Idempotency" mobile/` |
| P2 | `supabase/migrations/` and `seed.sql` exist; README says "fresh setup = schema then seed; upgrades = migrations in order" | `ls supabase/migrations` |
| P3 | The extraction and duplicate code as Phase 3 left it: `await categorize_transcription(transcription, categories) -> dict` (unchanged name and `dict` return; `extract_fields` is the `Extraction` variant), `validate_categorized_data`, `await DuplicateDetectionService(supabase, openai_service).find_duplicates(data, max_candidates=50, *, categories=rows, location=loc)` returning up to 3 matches | `backend/api/transcription.py` |
| P6 | `QueryClientProvider` around the tabs, `focusManager`/`onlineManager` wired to AppState and NetInfo, `@react-native-community/netinfo` installed and mocked in Jest | `grep -rn "QueryClient\|netinfo" mobile/App.tsx mobile/test mobile/package.json` |
| P6 | `mobile/services/deviceId.ts: getDeviceId(): Promise<string>`; `authedFetch` sends it as `X-Device-Id` | `cat mobile/services/deviceId.ts` |
| P2 | The app's one UUID helper, `mobile/utils/requestId.ts: newRequestId(): string` (Phase 6's `getDeviceId` uses it too) | `cat mobile/utils/requestId.ts` |
| P5, P6 | The recorder's `onRecordingComplete(uri, location)` hand-off (two arguments on both the normal stop and P5's interruption Keep path), with duration read from the recorder status (`durationMillis`, P5); location from `utils/location.ts` (P6) | `grep -n "onRecordingComplete" mobile/components/ModernAudioRecorder.tsx` |

## Verified library facts

- **expo-file-system 18.1.11 (installed; SDK 53 classic API, default import `expo-file-system`):** `uploadAsync(url, fileUri, { httpMethod, headers, uploadType: FileSystemUploadType.MULTIPART, fieldName, mimeType, parameters: Record<string,string>, sessionType: FileSystemSessionType.BACKGROUND })` returns `{ status, headers, body, mimeType }` (`build/FileSystem.types.d.ts:73-121`). `sessionType` already defaults to BACKGROUND on iOS (`ios/FileSystemRecords.swift:51`). If `fieldName` is omitted, the iOS code uses the file name (`ios/NetworkingHelpers.swift:64`), so pass `fieldName: 'audio'`.
- **The multipart copy:** for MULTIPART, iOS writes the whole body (the audio included) to `Library/Caches/uploads/<source file name>` and uploads from there (`NetworkingHelpers.swift:40-62`). Nothing deletes it. The queue deletes `${FileSystem.cacheDirectory}uploads/<client_recording_id>.m4a` after a 202.
- **The background session doesn't outlive the process:** Expo creates the background `URLSession` with a fresh `UUID().uuidString` identifier at each launch (`NetworkingHelpers.swift:16`), so a relaunched app can't reattach to an upload started before it was killed, and the JS promise is lost. "App killed mid-upload" therefore means: the queue re-uploads, and the server's `client_recording_id` idempotency makes that safe.
- **expo-sqlite ~15.2.14** (SDK 53's `bundledNativeModules.json`): `openDatabaseAsync(name)`, `db.execAsync(sql)`, `db.runAsync(sql, params) -> { changes, lastInsertRowId }`, `db.getAllAsync<T>(sql, params)`, `db.getFirstAsync<T>(sql, params)`, `withTransactionAsync`. Basic use needs no config plugin, but it is a native module, so the committed `ios/` needs `npx expo prebuild --platform ios` (manual step).
- **NetInfo 11.4.1:** `NetInfo.addEventListener(listener)` returns an unsubscribe and calls the listener soon after subscribing. `NetInfo.fetch()` resolves a `NetInfoState`. `isConnected` and `isInternetReachable` are `boolean | null`. `useNetInfo()` is the hook. The Jest mock is `@react-native-community/netinfo/jest/netinfo-mock.js`.
- **supabase-py Storage (2.32):** `supabase.storage.from_(bucket).upload(path: str, file: bytes, file_options={"content-type": "audio/mp4", "upsert": "true"})`. `upsert` is sent as the `x-upsert` header, and only on POST. `.download(path) -> bytes`. `.remove(paths: list[str]) -> list[dict]`. These calls are sync, so they go through `run_db`. Deleting `storage.objects` rows from SQL doesn't delete the stored file (Supabase troubleshooting guide), so purging files has to go through the Storage API.
- **FastAPI lifespan:** `FastAPI(lifespan=fn)`, where `fn` is an `@asynccontextmanager` that starts `asyncio.create_task(...)` before `yield` and cancels after it. `TestClient(app)` runs the lifespan only when used as a context manager (`with TestClient(app) as c:`). The existing tests use `TestClient(app)` and `TestClient(app).websocket_connect(...)`, so they don't start the worker. `conftest.py` also sets `RECORDING_WORKER_ENABLED=0`.
- **PostgREST and composite returns:** a function declared `RETURNS recordings` that finds no row comes back as one all-null object, not as "no row". `RETURNS SETOF recordings` comes back as `[]` or `[row]` (see Deviations).
- **TanStack Query v5:** `refetchInterval` may be `(query) => number | false`. Return `false` to stop polling.

## Deviations from roadmap

1. **`claim_recording_job()` returns `SETOF recordings` (0 or 1 row), not `recordings`.** Through PostgREST, a composite return with no row is a row of nulls, which a worker could mistake for a job. An empty list can't be misread.
2. **A stale job on its last attempt is marked `failed` by the claim function.** The roadmap's `attempts < 3` filter alone would leave a job that went stale on attempt 3 in `transcribing` forever, and the app would poll it forever. The claim first sets those rows to `failed` with `"Processing failed. Please record again."`.
3. **Retry backoff.** A job that failed transiently goes back to `queued`, and it can be claimed again only after `attempts * 30 s`. Without that, three attempts would burn through within 6 s of an OpenAI blip.
4. **The Storage file is deleted as soon as the transcription is saved** (stage 1), and `storage_path` is set to NULL. The roadmap deletes it after save or discard. No later stage needs the audio, and less audio at rest is the privacy goal of item 8. `DELETE /api/recordings/{id}` and the purge still remove a file that is left over (for example, a job that never got transcribed).
5. **The 7-day purge runs in the backend.** `purge_old_recordings(p_days int DEFAULT 7) RETURNS SETOF text` deletes the rows and returns their `storage_path`s, and the worker calls it hourly and removes those files through the Storage API (deleting `storage.objects` from SQL would orphan the stored files). The commented `pg_cron` line is kept as the roadmap asks, with a comment that it purges rows only.
6. **The Drafts list reads `GET /api/recordings` without a status filter**, so a recording that failed or is still in progress (not just the current one) is visible and can be discarded. The `?status=` filter is implemented as specified. The Record tab badge counts `ready` only.
7. **"The caller's" recordings means the user id, plus the device id when `X-Device-Id` is sent** (list only). Every phone shares the demo account, and one worker shouldn't see another phone's drafts. GET and DELETE by id check only the user id, because the id is an unguessable UUID the phone already holds.
8. **Uploads share the `transcribe` rate-limit bucket** (`RATE_LIMIT_TRANSCRIBE_PER_MIN`, 30/min). It is the same paid pipeline, so the deprecated route and the new one share one budget.
9. **`duration_ms` from the client is bounds-checked (0-125000) but the server stores its own mutagen measurement.** The server is the trust boundary for the 5 s and 125 s rule.
10. **`onRecordingComplete` gains a third argument, `durationMs`.** The roadmap's upload carries `duration_ms`, and only the recorder knows it.
11. **`NSFileProtectionComplete` and background uploads conflict while the phone is locked.** iOS can't read a Complete-class file while the phone is locked, so an upload that is still running when the worker locks the phone may fail. The roadmap's stronger class is kept. A failed upload is retried on the next foreground, and Device check P7-4 confirms nothing is lost.
12. **Reviewing a draft always re-checks duplicates on Save, and uses the recording id as the save's `Idempotency-Key`.** A draft can be reviewed hours later, so its matches are stale. A save whose `DELETE /api/recordings/{id}` then fails leaves the draft listed, and saving it again must return the first save (Phase 2), not create a second person.

13. **(Task 2, during execution) Small fallout.** The four other test files that patched
    `services.duplicate_detection_service.DuplicateDetectionService` for `/api/transcribe`
    (`test_error_contract`, `test_normalised_paths`, `test_no_pii_logs`, `test_duplicate_service_unit`)
    now patch `services.recording_pipeline.DuplicateDetectionService`, where the stage looks it up.
    The deprecation test reads the route from `api.transcription.router`: the app includes routers
    lazily (see `test_security_routes._http_routes`), so `app.routes` doesn't list it by path.

14. **(Task 8, during execution) The tabs move into `MainTabs`, mounted only when signed in.** The
    badge's `useReadyDraftCount` and the queue start live there, so neither runs before the
    sign-in, and signing out unmounts them, which stops the queue (the plan's `[user]` effect,
    by mounting instead). `@react-navigation/bottom-tabs` 7.4 has no
    `tabBarBadgeAccessibilityLabel`: the tab's `tabBarAccessibilityLabel` reads
    "Record, <n> drafts ready to review" instead (the badge itself is hidden from VoiceOver).

## Review Focus

1. **Two queued recordings of the same new person.** Both are processed before either is saved, so the second draft's `potential_matches` can't contain the first. Expected: Save on a draft re-checks duplicates and offers the first person. Test: Task 7, `re-checks unedited data when recheckDuplicates is set (a draft reviewed later)`.
2. **A draft is saved but its DELETE fails, and the worker saves it again later.** Expected: no second person. Test: Task 7, `uses the given idempotencyKey as the save's Idempotency-Key`, plus the screen test `saving a draft passes its recording id as the idempotency key and deletes the recording`.
3. **The app is killed while an item is `uploading`.** Expected: on the next launch the item goes back to `pending` and is uploaded again, and the server returns the existing row (no second job). Tests: Task 6, `start resets items left uploading and uploads them`; Task 3, `test_repeated_client_recording_id_returns_the_existing_row_without_reuploading`.
4. **The draft is discarded while the worker is processing it.** Expected: the worker stops quietly at its next status write, and doesn't re-create the row or fail loudly. Test: Task 4, `test_a_job_deleted_mid_run_stops_quietly`.
5. **The multipart copy Expo leaves in `Library/Caches/uploads/`.** Expected: no audio is left on the phone after a 202. Test: Task 6, `a 202 deletes the queued file, Expo's multipart copy and the row`.

---

## File structure

**Backend**
- Create `supabase/migrations/20261107000001_recordings.sql`: the table, `updated_at` trigger, indexes, RLS.
- Create `supabase/migrations/20261107000002_recording_jobs.sql`: `claim_recording_job()`, `purge_old_recordings()`, and the commented pg_cron line.
- Modify `supabase/schema.sql`: fold both in.
- Create `backend/services/recording_pipeline.py`: the stage functions both entry points call (one code path), plus the upload check.
- Modify `backend/api/transcription.py`: `_transcribe` calls the stages; the route is marked `deprecated=True`.
- Modify `backend/db/models.py`: `TranscribeResponse` moves here (still importable from `api.transcription`), plus the recording response models.
- Create `backend/api/recordings.py`: POST, GET one, GET list, DELETE.
- Create `backend/services/recording_worker.py`: `process_job`, `run_once`, `worker_loop`, `purge_once`, `purge_loop`, `start_workers`, `stop_workers`.
- Modify `backend/main.py`: `lifespan`, `BODY_LIMITS["/api/recordings"]`, include the router.
- Modify `backend/tests/helpers.py`: `FakeStorage` on `FakeSupabase.storage`.
- Modify `backend/tests/conftest.py`: `RECORDING_WORKER_ENABLED=0`.
- Tests: create `backend/tests/test_recording_pipeline.py`, `test_recordings_routes.py`, `test_recording_worker.py`; modify `test_transcribe_route.py`, `test_request_limits.py`, `test_rate_limit.py`, `test_security_routes.py`, `test_schema_contract.py`, `test_schema_sql.py`, `test_no_pii_logs.py`.

**Mobile**
- Modify `mobile/services/api.ts`: `uploadRecording`, `getRecording`, `listRecordings`, `deleteRecording`, types; export the 401 renewal; remove `transcribe` (Task 7).
- Create `mobile/services/recordingQueueStore.ts`: the expo-sqlite table, behind five functions.
- Create `mobile/services/recordingQueue.ts`: move, queue, upload, backoff, NetInfo/AppState triggers, events.
- Create `mobile/services/recordingQueries.ts`: TanStack hooks and query keys.
- Create `mobile/utils/recordingStatus.ts`: status label and poll interval (pure).
- Create `mobile/components/DraftsList.tsx`.
- Modify `mobile/screens/ModernRecordScreen.tsx`, `mobile/components/ModernAudioRecorder.tsx` (hand-off only), `mobile/components/TranscriptionResults.tsx` (two props), `mobile/App.tsx` (badge, queue start), `mobile/app.json` (entitlement), `mobile/package.json` (expo-sqlite).
- Modify `mobile/test/setup.js`; create `mobile/test/mocks/expoSqlite.js`.
- Tests: create `services/__tests__/recordingsApi.test.ts`, `recordingQueueStore.test.ts`, `recordingQueue.test.ts`, `utils/__tests__/recordingStatus.test.ts`, `components/__tests__/DraftsList.test.tsx`, `__tests__/appConfig.test.ts`; modify `screens/__tests__/ModernRecordScreen.test.tsx`, `components/__tests__/TranscriptionResults.test.tsx`, `components/__tests__/ModernAudioRecorder.test.tsx`, `services/__tests__/apiRequest.test.ts`, `__tests__/App.test.tsx`.

**Docs:** `README.md`, `CLAUDE.md`, `docs/VOICE_PIPELINE.md`, `backend/.env.example`, `docs/superpowers/plans/2026-10-23-manual-steps.md`.

---

### Task 1: The `recordings` table and the job functions

**Files:**
- Create: `supabase/migrations/20261107000001_recordings.sql`
- Create: `supabase/migrations/20261107000002_recording_jobs.sql`
- Modify: `supabase/schema.sql` (the table after `individual_embeddings`, near line 86; the trigger next to the other `set_updated_at` triggers, near lines 170-180; the indexes near line 196; `ALTER TABLE recordings ENABLE ROW LEVEL SECURITY` with the others, near lines 322-325; the functions at the end, before the verify block)
- Test: `backend/tests/test_schema_sql.py`, `backend/tests/test_schema_contract.py`
- Modify: `docs/superpowers/plans/2026-10-23-manual-steps.md`

**Interfaces:**
- Produces: table `recordings` with the columns below; `claim_recording_job() RETURNS SETOF recordings`; `purge_old_recordings(p_days int DEFAULT 7) RETURNS SETOF text`; the failure text `'Processing failed. Please record again.'` (Task 4 uses the same string).

- [x] **Step 1: Write the failing schema tests**

In `test_schema_sql.py`: add `"recordings"` to `TABLES`, so `test_rls_enabled` and `test_updated_at_trigger` cover it. Bump the `CREATE TABLE` count in `test_tables_and_indexes_are_guarded` by one. Add `claim_recording_job` and `purge_old_recordings` to Phase 2's `test_rpc_functions_are_not_callable_with_the_anon_key` parameter list (Phase 2 dropped the function count in `test_functions_and_triggers_are_replaceable`). Then add:

```python
STATUSES = ("queued", "transcribing", "extracting", "checking_duplicates", "ready", "failed")

def test_recordings_status_check_lists_exactly_the_job_states():
    m = re.search(r"CREATE TABLE IF NOT EXISTS recordings \((.*?)\n\);", SQL, re.S)
    assert m, "recordings table missing"
    check = re.search(r"CHECK \(status IN \(([^)]*)\)\)", m.group(1))
    assert tuple(s.strip(" '") for s in check.group(1).split(",")) == STATUSES
    assert "client_recording_id UUID NOT NULL UNIQUE" in _norm(m.group(1))
    assert "attempts INTEGER NOT NULL DEFAULT 0" in _norm(m.group(1))

def test_claim_recording_job_skips_locked_rows_and_honours_the_retry_rules():
    fn = _norm(SQL[SQL.index("FUNCTION claim_recording_job"):])
    fn = fn[:fn.index("$$;")]
    assert "RETURNS SETOF public.recordings" in fn
    assert "FOR UPDATE SKIP LOCKED" in fn
    assert "attempts < 3" in fn
    assert "INTERVAL '5 minutes'" in fn
    assert "attempts * INTERVAL '30 seconds'" in fn
    assert "attempts >= 3" in fn and "'Processing failed. Please record again.'" in fn  # Deviation 2

def test_purge_old_recordings_defaults_to_7_days_and_returns_paths():
    fn = _norm(SQL[SQL.index("FUNCTION purge_old_recordings"):])
    assert fn.startswith("FUNCTION purge_old_recordings(p_days int DEFAULT 7) RETURNS SETOF text")
    assert "RETURNING storage_path" in fn[:fn.index("$$;")]
    assert "-- SELECT cron.schedule('purge-old-recordings'" in RAW_SQL

def test_migrations_match_schema_sql_for_recordings():
    mig = Path(SCHEMA).parent / "migrations"
    table = (mig / "20261107000001_recordings.sql").read_text()
    jobs = (mig / "20261107000002_recording_jobs.sql").read_text()
    assert "CREATE TABLE IF NOT EXISTS recordings" in table
    assert "CREATE OR REPLACE FUNCTION claim_recording_job" in jobs
    assert "CREATE OR REPLACE FUNCTION purge_old_recordings" in jobs
```

In `test_schema_contract.py`: add `"recordings"` to the expected set in `test_schema_parser_sees_every_table_and_column`, and assert `SCHEMA["recordings"] == {"id", "user_id", "device_id", "client_recording_id", "status", "storage_path", "duration_ms", "location", "transcription", "result", "error", "attempts", "created_at", "updated_at"}`. `test_the_source_scan_finds_the_queries` will then fail until Task 3 queries the table. Mark it `@pytest.mark.xfail(strict=True, reason="recordings is queried from Task 3")` in this task, and remove the mark in Task 3.

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`
Expected: FAIL (no `recordings` table, no functions, no migration files).

- [x] **Step 3: Write `20261107000001_recordings.sql` and fold it into `schema.sql`**

```sql
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
```

The migration file repeats `set_updated_at()` with `CREATE OR REPLACE` at its top, copied verbatim from `schema.sql` (Phase 2's `test_migrations.py` requires identical function text), so it runs on its own. In `schema.sql`, put each piece in the matching section listed under Files.

- [x] **Step 4: Write `20261107000002_recording_jobs.sql` and fold it in**

```sql
-- Claim one job for the in-process worker (H2-7.3). SKIP LOCKED lets two worker
-- loops claim different rows. A row is claimable when it is queued (after a backoff of
-- attempts * 30 s) or stuck in progress for 5 minutes (its worker died), and has had
-- fewer than 3 attempts. SETOF: no job is [], never a row of NULLs.
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
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`
Expected: PASS (the one strict xfail is reported as xfailed).

- [x] **Step 6: Append the owner steps to `2026-10-23-manual-steps.md`**

- Under **Apply migrations**, in order: `20261107000001_recordings.sql`, then `20261107000002_recording_jobs.sql`.
- Under **Owner actions outside code**, "Create the private Storage bucket `recordings`": Dashboard → Storage → New bucket. Name `recordings`, Public **off**, file size limit 8 MB, allowed MIME type `audio/mp4`. Or run this in the SQL Editor:
  `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('recordings', 'recordings', false, 8388608, array['audio/mp4']) on conflict (id) do nothing;`
  Add no storage policies: the backend's service key is the only reader and writer. To check it, `select public from storage.buckets where id = 'recordings'` should return `false`.
- Optional: enable pg_cron and uncomment the purge line. Note that the backend already purges hourly.

- [x] **Step 7: Run the full checks and commit**

Run: `python -m pytest -q && ruff check backend --select F,E9 && (cd mobile && npx tsc --noEmit && npx jest)`
Expected: all pass.

```bash
git add supabase/ backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(db): recordings job table, claim_recording_job and purge_old_recordings (H2-7.1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: One pipeline, as stage functions

**Files:**
- Create: `backend/services/recording_pipeline.py`
- Modify: `backend/api/transcription.py` (the body of `_transcribe`, today lines 58-157, as Phases 1 and 3 left it; the decorator at line 46)
- Modify: `backend/db/models.py` (add `TranscribeResponse`, moved from `api/transcription.py:34-43`)
- Test: create `backend/tests/test_recording_pipeline.py`; modify `backend/tests/test_transcribe_route.py`

**Interfaces:**
- Consumes: `run_db`, `get_supabase`, `get_openai_service`, `check_audio_duration` and `RECORDING_LIMITS` (P1); `validate_categorized_data -> ValidationResult` (`services/validation_helper.py`); `DuplicateDetectionService` (P3's version).
- Produces (in `services/recording_pipeline.py`):
  - `class NoCategories(RuntimeError)`, with the existing message `"No categories found in database. Please ensure categories are properly configured."`
  - `async def load_categories(supabase) -> list[dict]`: the `{name, display_name, type, is_required, options, is_sensitive}` dicts the extractor gets after Phase 3. Raises `NoCategories` when there are none.
  - `def check_upload(data: bytes) -> int`: raises `ValueError("File is not in M4A format")` when `b"ftyp"` isn't in the first 12 bytes, writes the bytes with `temp_audio_file`, runs `check_audio_duration(path, RECORDING_LIMITS)`, and returns the duration in ms. Called from inside `run_db` (it does file I/O).
  - `async def transcribe_stage(audio_path: str, openai_service) -> str`
  - `async def extract_stage(transcription: str, categories: list[dict], openai_service) -> ValidationResult` (`await openai_service.categorize_transcription(transcription, categories)`, a `dict`, then `validate_categorized_data`)
  - `async def duplicate_stage(categorized_data: dict, supabase, openai_service, *, categories: list[dict] | None = None, location: dict | None = None) -> tuple[list[dict], bool]`: `(matches, duplicate_check_failed)`, calling `find_duplicates(categorized_data, categories=categories, location=location)` (Phase 3). Logs only the exception type on failure.
  - `def build_transcribe_response(transcription: str, validation: ValidationResult, matches: list[dict], duplicate_check_failed: bool) -> TranscribeResponse`
- `db/models.py: TranscribeResponse`, with the same fields as today. `api/transcription.py` re-imports it, so `from api.transcription import TranscribeResponse` keeps working.

- [x] **Step 1: Write the failing stage tests** (`test_recording_pipeline.py`)

```python
def test_load_categories_formats_rows_for_the_extractor():
    sb = FakeSupabase().on("categories", "select", data=CATEGORIES)
    cats = asyncio.run(load_categories(sb))
    assert [c["name"] for c in cats] == ["name", "height", "weight", "gender"]
    assert sb.calls[0].mod("order") == (("created_at",), {})

def test_load_categories_with_none_raises_no_categories():
    with pytest.raises(NoCategories):
        asyncio.run(load_categories(FakeSupabase().on("categories", "select", data=[])))

def test_extract_stage_returns_the_normalised_validation():
    openai = MagicMock(categorize_transcription=AsyncMock(return_value={"name": "Ann", "height": "5'10"}))
    v = asyncio.run(extract_stage("Met Ann", CATEGORIES, openai))
    assert v.normalized_data == {"name": "Ann", "height": 70} and v.missing_required == ["weight"]

def test_duplicate_stage_reports_a_failed_check_instead_of_no_match():
    with patch("services.recording_pipeline.DuplicateDetectionService") as dup:
        dup.return_value.find_duplicates = AsyncMock(side_effect=RuntimeError("db down"))
        assert asyncio.run(duplicate_stage({"name": "Ann"}, object(), object())) == ([], True)

def test_check_upload_rejects_non_m4a_before_measuring():
    with patch("services.recording_pipeline.check_audio_duration") as dur:
        with pytest.raises(ValueError, match="File is not in M4A format"):
            check_upload(b"not audio")
        dur.assert_not_called()

def test_check_upload_returns_milliseconds_and_removes_its_temp_file():
    seen = {}
    def measure(path, limits):
        seen["path"] = path
        return 61.5
    with patch("services.recording_pipeline.check_audio_duration", side_effect=measure):
        assert check_upload(b"\x00\x00\x00\x18ftypM4A rest") == 61500
    assert not os.path.exists(seen["path"])
```

In `test_transcribe_route.py`: update `_run`'s patch targets to `services.recording_pipeline.DuplicateDetectionService` and to Phase 1's getters as the route now uses them. Add:

```python
def test_transcribe_route_is_marked_deprecated():
    route = next(r for r in app.routes if getattr(r, "path", "") == "/api/transcribe")
    assert route.deprecated is True
```

Every existing test in the file must still pass unchanged in its assertions. That is what proves the refactor kept the behaviour.

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_recording_pipeline.py backend/tests/test_transcribe_route.py -q`
Expected: FAIL with `ModuleNotFoundError: services.recording_pipeline`.

- [x] **Step 3: Implement the stages and rewire `_transcribe`**

Move the code out of `_transcribe` without changing what it does. `_transcribe` becomes: `load_categories` → the audio branch (base64 into `temp_audio_file` → `transcribe_stage`; `audio_url` → `openai_service.transcribe_audio`) → `extract_stage` → `duplicate_stage(..., categories=categories)` (as Phase 3's route passes them; no location) → `build_transcribe_response`. Map `NoCategories` to the same 500 detail as today, and keep the `AudioTooLarge` / `ValueError` / `pydantic.ValidationError` mapping exactly as Phase 1 left it. If Phase 1 put the duration check inside `OpenAIService.transcribe_audio_file`, `transcribe_stage` doesn't call it again. Add `deprecated=True` to `@router.post("/api/transcribe", ...)`, with a comment: `# Deprecated (H2-7.5): the app uses POST /api/recordings; kept for one release.`

- [x] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest backend/tests/test_recording_pipeline.py backend/tests/test_transcribe_route.py backend/tests/test_normalised_paths.py backend/tests/test_request_limits.py backend/tests/test_no_pii_logs.py -q`
Expected: PASS.

- [x] **Step 5: Run the full checks and commit**

```bash
git add backend/services/recording_pipeline.py backend/api/transcription.py backend/db/models.py backend/tests/
git commit -m "refactor(api): split /api/transcribe into stage functions the worker can share (H2-7.3)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The recordings API

**Files:**
- Create: `backend/api/recordings.py`
- Modify: `backend/main.py` (`BODY_LIMITS` at lines 85-89; the router list at lines 392-399)
- Modify: `backend/db/models.py` (response models), `backend/services/recording_pipeline.py` (two constants)
- Modify: `backend/tests/helpers.py` (add `FakeStorage`; `FakeSupabase.__init__` sets `self.storage = FakeStorage()`)
- Test: create `backend/tests/test_recordings_routes.py`; modify `test_request_limits.py`, `test_rate_limit.py` (`PAID_ROUTES`, lines 84-93), `test_security_routes.py` (`_http_routes` line 28: also replace `{recording_id}`), `test_schema_contract.py` (remove the Task 1 xfail)
- Modify: `README.md` (the API table and the Limits table), `backend/README.md` (endpoint detail)

**Interfaces:**
- Consumes: `check_upload` (Task 2); `run_db`, `get_supabase`, `rate_limit` (P1); `LocationData` (`db/models.py:16`).
- Produces:
  - `RECORDINGS_BUCKET = "recordings"` and `IN_PROGRESS = ("queued", "transcribing", "extracting", "checking_duplicates")`, added to `services/recording_pipeline.py` (the routes and the worker both import them from there).
  - `def storage_path_for(client_recording_id: UUID) -> str` returns `f"{client_recording_id}.m4a"`.
  - Models in `db/models.py`:
    - `RecordingAccepted(id: str, status: str)`
    - `RecordingDetail(id: str, status: str, error: Optional[str], result: Optional[TranscribeResponse], location: Optional[dict], duration_ms: Optional[int], created_at: str)`
    - `RecordingSummary(id: str, status: str, error: Optional[str], name: Optional[str], duration_ms: Optional[int], created_at: str)`
    - `RecordingsListResponse(recordings: list[RecordingSummary])`
  - Routes (all need a token):
    - `POST /api/recordings` (multipart: `audio` file, `client_recording_id` UUID, `duration_ms` int 0-125000, `location` JSON string ≤ 2000 chars, optional) → **202** `RecordingAccepted`. Depends on `rate_limit("transcribe", "RATE_LIMIT_TRANSCRIBE_PER_MIN", 30)`.
    - `GET /api/recordings/{recording_id}` → `RecordingDetail`; 404 if it isn't the caller's.
    - `GET /api/recordings?status=<one of the six>` → `RecordingsListResponse`, newest first, at most 50, the caller's (user id, and device id when `X-Device-Id` is sent). An unknown status is 422.
    - `DELETE /api/recordings/{recording_id}` → 204. Removes the Storage file (when `storage_path` is set), then the row. 404 if it isn't the caller's.
  - `FakeStorage`: `from_(bucket)` returns an object with `upload(path, file, file_options=None)`, `download(path) -> bytes`, `remove(paths) -> list`. Each call is recorded in `storage.calls` as `(bucket, verb, path_or_paths, file_options)`, and files are kept in `storage.files[(bucket, path)]`. `download` of a missing file raises `RuntimeError("not found")`. `storage.fail[verb] = exc` makes that verb raise. Docstring it like `FakeSupabase`.

- [x] **Step 1: Write the failing route tests** (`test_recordings_routes.py`)

Use a module-level `M4A = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 64`, `CRID = "6f1c0d1e-0000-4000-8000-000000000001"`, `LOC = {"latitude": 37.78, "longitude": -122.41, "address": "Market St"}`. Patch `api.recordings.get_supabase` to return the fake and `services.recording_pipeline.check_audio_duration` to return `61.5`. Post with `files={"audio": ("a.m4a", M4A, "audio/mp4")}` and `data={"client_recording_id": CRID, "duration_ms": "61000", "location": json.dumps(LOC)}`.

```python
def test_upload_stores_the_file_and_queues_a_job_202():
    sb = FakeSupabase()
    sb.on("recordings", "select", data=[])
    sb.on("recordings", "insert", data=lambda c: [{"id": RID, **c.payload}])
    r = _post(sb, headers={"X-Device-Id": "dev-1"})
    assert r.status_code == 202 and r.json() == {"id": RID, "status": "queued"}
    assert sb.storage.calls == [("recordings", "upload", f"{CRID}.m4a", {"content-type": "audio/mp4", "upsert": "true"})]
    assert sb.storage.files[("recordings", f"{CRID}.m4a")] == M4A
    assert sb.payloads("recordings", "insert") == [{
        "user_id": "test-user-123", "device_id": "dev-1", "client_recording_id": CRID, "status": "queued",
        "storage_path": f"{CRID}.m4a", "duration_ms": 61500, "location": LOC}]

def test_repeated_client_recording_id_returns_the_existing_row_without_reuploading():
    sb = FakeSupabase().on("recordings", "select", data=[{"id": RID, "user_id": "test-user-123", "status": "ready"}])
    r = _post(sb)
    assert r.status_code == 202 and r.json() == {"id": RID, "status": "ready"}
    assert sb.storage.calls == [] and sb.calls_to("recordings", "insert") == []

def test_a_concurrent_duplicate_insert_returns_the_row_that_won():
    from postgrest.exceptions import APIError
    sb = FakeSupabase()
    sb.on("recordings", "select", data=[], times=1)
    sb.on("recordings", "insert", error=APIError({"code": "23505", "message": "duplicate key"}))
    sb.on("recordings", "select", data=[{"id": RID, "user_id": "test-user-123", "status": "queued"}])
    r = _post(sb)
    assert r.status_code == 202 and r.json()["id"] == RID

def test_another_users_client_recording_id_is_409():
    sb = FakeSupabase().on("recordings", "select", data=[{"id": RID, "user_id": "someone-else", "status": "queued"}])
    assert _post(sb).status_code == 409

@pytest.mark.parametrize("audio,measure,detail", [
    (b"not audio", None, "File is not in M4A format"),
    (M4A, ValueError("Audio must be at least 5 seconds long"), "Audio must be at least 5 seconds long"),
])
def test_bad_audio_is_400_before_any_storage_or_database_work(audio, measure, detail): ...
    # asserts status 400, {"detail": detail}, sb.calls == [] and sb.storage.calls == []

def test_bad_location_json_is_422(): ...            # data location="{not json" -> 422, nothing written
def test_duration_ms_out_of_range_is_422(): ...     # "125001" -> 422

def test_failed_insert_removes_the_uploaded_file_and_is_500():
    sb = FakeSupabase().on("recordings", "select", data=[])
    sb.on("recordings", "insert", error=RuntimeError("db down"))
    r = _post(sb)
    assert r.status_code == 500 and r.json() == {"detail": "Recording upload failed"}
    assert ("recordings", "remove", [f"{CRID}.m4a"], None) in sb.storage.calls

def test_get_returns_status_and_result_for_the_owner(): ...
    # select returns a ready row whose result is a TranscribeResponse dict -> 200 body equals RecordingDetail of it;
    # the chain has eq("id", RID) and eq("user_id", "test-user-123")
def test_get_someone_elses_recording_is_404(): ...   # select returns [] -> 404 {"detail": "Recording not found"}

def test_list_is_the_callers_newest_first_with_the_name_from_the_result():
    # select returns two rows; asserts eq("user_id"), eq("device_id", "dev-1"), eq("status", "ready"),
    # order("created_at", desc=True), limit(50); each summary's name == result["categorized_data"]["name"] or None
def test_list_without_a_device_header_filters_by_user_only(): ...
def test_list_rejects_an_unknown_status_with_422(): ...

def test_delete_removes_the_stored_file_then_the_row_204(): ...
    # storage.calls == [("recordings", "remove", [f"{CRID}.m4a"], None)], then a recordings delete eq("id", RID)
def test_delete_skips_storage_when_the_file_is_already_gone(): ...  # storage_path None -> no storage call
def test_delete_is_404_when_not_the_callers(): ...
def test_delete_keeps_the_row_when_storage_removal_fails_500(): ...  # storage.fail["remove"] -> 500, no delete call
```

In `test_request_limits.py`:

```python
def test_recording_upload_over_8mb_is_413_before_any_work():
    with patch("api.recordings.get_supabase") as gs:
        r = _client().post("/api/recordings", files={"audio": ("a.m4a", b"\x00" * (8 * MB + 1), "audio/mp4")},
                           data={"client_recording_id": CRID, "duration_ms": "1000"})
    assert r.status_code == 413
    gs.assert_not_called()
```

In `test_rate_limit.py` `PAID_ROUTES`, add `("RATE_LIMIT_TRANSCRIBE_PER_MIN", "post", "/api/recordings", {"files": {"audio": ("a.m4a", b"x", "audio/mp4")}, "data": {"client_recording_id": CRID, "duration_ms": "1000"}})`, and expect `400` for its first call (the bytes aren't M4A). In `test_security_routes.py`, `_http_routes` also replaces `{recording_id}` with `SAMPLE_ID`, so the four new routes are in `PROTECTED` and get 401 without a token.

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_recordings_routes.py backend/tests/test_request_limits.py backend/tests/test_rate_limit.py backend/tests/test_security_routes.py -q`
Expected: FAIL (404s: no routes yet).

- [x] **Step 3: Implement `FakeStorage`, the models and `api/recordings.py`; register the router and `BODY_LIMITS["/api/recordings"] = 8 * MB`**

POST order (this is the contract the tests pin):
1. Read `audio` (8 MB is already enforced by the middleware), then `await run_db(lambda: check_upload(data))`. A `ValueError` (`AudioTooLarge` included) becomes 400 with its message.
2. Parse `location` with `LocationData.model_validate_json` (a `ValidationError` becomes 422, with the detail formatted the way FastAPI formats it).
3. Select `id, user_id, status` where `client_recording_id` matches, with `maybe_single`. Another owner gives 409 `"This recording id is already in use."`; the same owner gives 202 with the existing row.
4. Upload to `storage_path_for(id)` with `{"content-type": "audio/mp4", "upsert": "true"}`. Upsert makes a retried upload of the same id harmless.
5. Insert. A `postgrest.exceptions.APIError` with `code == "23505"` means re-select and return the row that won. Any other failure removes the stored file (best effort) and raises `internal_error("Recording upload", e)`.

Take the device id with `device_id: str | None = Depends(get_device_id)` from `api.device` (Phase 1); it is `None` when the header is missing or malformed. Every PostgREST and Storage call goes through `run_db`. Log only ids and exception types.

- [x] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest backend/tests/test_recordings_routes.py backend/tests/test_request_limits.py backend/tests/test_rate_limit.py backend/tests/test_security_routes.py backend/tests/test_schema_contract.py -q`
Expected: PASS. The schema contract's static scan now sees `.table("recordings")` chains whose `eq`/`order`/`select` columns all exist, so remove the Task 1 xfail.

- [x] **Step 5: Document the API**

In the README API table, add the four routes. Mark `POST /api/transcribe` as **deprecated** ("kept for one release; the app uses `POST /api/recordings`"). In Limits, add `POST /api/recordings` body 8 MB → 413, sharing `RATE_LIMIT_TRANSCRIBE_PER_MIN`. Change "Audio is sent to the backend inline (base64), so no Storage bucket is needed" (README Setup §1) to name the private `recordings` bucket and point to the manual step. Put the endpoint detail in `backend/README.md`.

- [x] **Step 6: Run the full checks and commit**

```bash
git add backend/ README.md
git commit -m "feat(api): POST/GET/DELETE /api/recordings with idempotent client_recording_id (H2-7.2, H2-7.4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The in-process worker

**Files:**
- Create: `backend/services/recording_worker.py`
- Modify: `backend/main.py` (add `lifespan`, and pass `lifespan=lifespan` to the `FastAPI(...)` call at line 65)
- Modify: `backend/tests/conftest.py` (after line 20: `os.environ.setdefault("RECORDING_WORKER_ENABLED", "0")`)
- Modify: `backend/.env.example`
- Test: create `backend/tests/test_recording_worker.py`; modify `backend/tests/test_no_pii_logs.py`
- Modify: `docs/superpowers/plans/2026-10-23-manual-steps.md` (Environment variables)

**Interfaces:**
- Consumes: the stages (Task 2); `RECORDINGS_BUCKET`, `IN_PROGRESS` (`services/recording_pipeline.py`, Task 3); `claim_recording_job`, `purge_old_recordings` (Task 1); `run_db`, `get_supabase`, `get_openai_service` (P1); `on_rpc` (P2).
- Produces (in `services/recording_worker.py`):
  - `POLL_SECONDS = 2.0`, `PURGE_INTERVAL_SECONDS = 3600.0`, `MAX_ATTEMPTS = 3`, `GENERIC_FAILURE = "Processing failed. Please record again."`
  - `def worker_concurrency() -> int`: `RECORDING_WORKER_CONCURRENCY`, default 2. A value that is bad or < 1 falls back to 2 (the `limit_from_env` pattern).
  - `def worker_enabled() -> bool`: `RECORDING_WORKER_ENABLED != "0"` (default on).
  - `async def process_job(job: dict, supabase, openai_service) -> None`: never raises (except `CancelledError`).
  - `async def run_once(supabase=None, openai_service=None) -> bool`: claims through `rpc("claim_recording_job", {})`. Returns False when there is no job; otherwise awaits `process_job` and returns True.
  - `async def worker_loop(stop: asyncio.Event, *, run_once=run_once, sleep=asyncio.sleep, poll_seconds=POLL_SECONDS) -> None`
  - `async def purge_once(supabase=None) -> int`: the number of rows purged.
  - `async def purge_loop(stop: asyncio.Event, *, purge_once=purge_once, sleep=asyncio.sleep, interval=PURGE_INTERVAL_SECONDS) -> None`
  - `def start_workers(concurrency: int | None = None) -> tuple[asyncio.Event, list[asyncio.Task]]`: `concurrency` worker loops plus one purge loop.
  - `async def stop_workers(stop: asyncio.Event, tasks: list[asyncio.Task]) -> None`: sets `stop`, cancels and awaits the tasks, and swallows their errors.

`process_job` stage order (the tests pin the exact writes; each write is `update(...).eq("id", job["id"])`, and an update that returns no rows means the row was deleted, so stop quietly):
1. If `job["transcription"]` is null: download `storage_path`, run `temp_audio_file` → `transcribe_stage`, then write `{"transcription": t, "status": "extracting"}`. That write comes **before** anything else (roadmap: a retry doesn't pay for Whisper again). Then remove the stored file (best effort) and write `{"storage_path": None}` (Deviation 4).
2. Run `load_categories` → `extract_stage`, then write `{"status": "checking_duplicates"}`.
3. Run `duplicate_stage(..., categories=categories, location=job["location"])` → `build_transcribe_response`, then write `{"status": "ready", "result": response.model_dump(), "error": None}`.
4. On an exception: `pydantic.ValidationError` and anything else that isn't a `ValueError` count as transient. When `job["attempts"] < MAX_ATTEMPTS`, write `{"status": "queued"}`; otherwise write `{"status": "failed", "error": GENERIC_FAILURE}`. A `ValueError` (the client-safe audio messages) writes `{"status": "failed", "error": str(e)}` straight away. Log `"Recording job %s failed: %s"` with the id and `type(e).__name__` only. If the failure write itself fails, log its type; the row goes stale and is reclaimed.

`worker_loop`: until `stop` is set, `did = await run_once()`. On an exception (a database outage at claim), log its type and treat it as idle. When idle, `await sleep(poll_seconds)`. After a job, claim the next one straight away.

- [x] **Step 1: Write the failing worker tests** (`test_recording_worker.py`)

Fixtures: `JOB = {"id": RID, "storage_path": f"{CRID}.m4a", "transcription": None, "attempts": 1, "status": "transcribing"}`. `sb` is a `FakeSupabase` with `on("recordings", "update", data=lambda c: [{**JOB, **c.payload}])`, `on("categories", "select", data=CATEGORIES)` and `sb.storage.files[("recordings", JOB["storage_path"])] = M4A`. `openai` is a `MagicMock` with `transcribe_audio_file=AsyncMock(return_value="Met Ann")` and `categorize_transcription=AsyncMock(return_value={"name": "Ann"})`. `services.recording_pipeline.DuplicateDetectionService` is patched to return `[MATCH]`. No test sleeps: every loop test injects `sleep`.

```python
def test_run_once_is_false_when_no_job_is_claimed():
    sb = FakeSupabase(); sb.on_rpc("claim_recording_job", data=[])
    assert asyncio.run(run_once(sb, MagicMock())) is False

def test_a_job_runs_every_stage_and_stores_the_transcribe_response(sb, openai):
    asyncio.run(process_job(dict(JOB), sb, openai))
    expected = TranscribeResponse(transcription="Met Ann", categorized_data={"name": "Ann"},
        missing_required=["height", "weight"], potential_matches=[MATCH]).model_dump()
    assert sb.payloads("recordings", "update") == [
        {"transcription": "Met Ann", "status": "extracting"},
        {"storage_path": None},
        {"status": "checking_duplicates"},
        {"status": "ready", "result": expected, "error": None},
    ]
    assert [c[1] for c in sb.storage.calls] == ["download", "remove"]

def test_a_retry_after_transcription_skips_whisper_and_the_download(sb, openai):
    asyncio.run(process_job({**JOB, "transcription": "Met Ann", "storage_path": None}, sb, openai))
    openai.transcribe_audio_file.assert_not_called()
    assert sb.storage.calls == []
    assert sb.payloads("recordings", "update")[0] == {"status": "checking_duplicates"}

def test_a_client_error_fails_the_job_with_its_message(sb, openai):
    openai.transcribe_audio_file.side_effect = ValueError("Audio must be at least 5 seconds long")
    asyncio.run(process_job(dict(JOB), sb, openai))
    assert sb.payloads("recordings", "update") == [{"status": "failed", "error": "Audio must be at least 5 seconds long"}]

@pytest.mark.parametrize("attempts,expected", [(1, {"status": "queued"}), (2, {"status": "queued"}),
                                               (3, {"status": "failed", "error": GENERIC_FAILURE})])
def test_a_transient_error_requeues_until_the_third_attempt(sb, openai, attempts, expected):
    openai.categorize_transcription.side_effect = RuntimeError("upstream 503")
    asyncio.run(process_job({**JOB, "attempts": attempts}, sb, openai))
    assert sb.payloads("recordings", "update")[-1] == expected

def test_a_job_deleted_mid_run_stops_quietly(openai):
    sb = FakeSupabase(); sb.on("recordings", "update", data=[])          # the row is gone
    sb.storage.files[("recordings", JOB["storage_path"])] = M4A
    asyncio.run(process_job(dict(JOB), sb, openai))
    openai.categorize_transcription.assert_not_called()
    assert len(sb.calls_to("recordings", "update")) == 1                 # no failure write either

def test_a_failed_duplicate_check_still_reaches_ready_with_the_flag(sb, openai): ...
    # DuplicateDetectionService.find_duplicates raises -> last write has result["duplicate_check_failed"] is True

def test_worker_loop_sleeps_2s_only_when_idle():
    results, sleeps, stop = iter([True, False, False]), [], asyncio.Event()
    async def fake_run_once(): return next(results)
    async def fake_sleep(s):
        sleeps.append(s)
        if len(sleeps) == 2: stop.set()
    asyncio.run(worker_loop(stop, run_once=fake_run_once, sleep=fake_sleep))
    assert sleeps == [2.0, 2.0]

def test_worker_loop_survives_a_claim_error():
    calls, stop = [], asyncio.Event()
    async def boom(): calls.append(1); raise RuntimeError("db down")
    async def fake_sleep(s): stop.set()
    asyncio.run(worker_loop(stop, run_once=boom, sleep=fake_sleep))
    assert calls == [1]

def test_start_workers_runs_the_configured_number_of_loops_plus_the_purge(monkeypatch):
    monkeypatch.setenv("RECORDING_WORKER_CONCURRENCY", "3")
    # patch worker_loop/purge_loop with coroutines that await stop.wait(); start, assert 4 tasks, stop_workers -> all done
@pytest.mark.parametrize("value", ["", "0", "abc"])
def test_worker_concurrency_defaults_to_2(monkeypatch, value): ...

def test_purge_once_removes_the_stored_files_of_purged_rows():
    sb = FakeSupabase(); sb.on_rpc("purge_old_recordings", data=["a.m4a", None, "b.m4a"])
    assert asyncio.run(purge_once(sb)) == 3
    assert sb.storage.calls == [("recordings", "remove", ["a.m4a", "b.m4a"], None)]
    assert sb.rpc_params("purge_old_recordings") == [{"p_days": 7}]

def test_lifespan_starts_and_stops_the_worker(monkeypatch):
    import main
    monkeypatch.setenv("RECORDING_WORKER_ENABLED", "1")
    started, stopped = [], []
    monkeypatch.setattr(main, "start_workers", lambda: started.append(1) or ("stop", ["t"]))
    async def fake_stop(stop, tasks): stopped.append((stop, tasks))
    monkeypatch.setattr(main, "stop_workers", fake_stop)
    with TestClient(main.app):
        assert started == [1]
    assert stopped == [("stop", ["t"])]

def test_lifespan_leaves_the_worker_off_when_disabled(monkeypatch): ...  # RECORDING_WORKER_ENABLED=0 -> never started
```

In `test_no_pii_logs.py`, add `test_recording_worker_logs_no_transcript_or_fields(capture, capsys)`. It runs `process_job` with the sentinel person as the transcript and fields, once on the success path and once with `categorize_transcription` raising an exception whose message contains the sentinel. It asserts the sentinel is nowhere in the captured logs or in stdout/stderr.

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_recording_worker.py -q`
Expected: FAIL with `ModuleNotFoundError: services.recording_worker`.

- [x] **Step 3: Implement `recording_worker.py` and `lifespan`**

```python
@asynccontextmanager
async def lifespan(app):
    # One process, two loops (H2-7.3): Postgres is the queue; no Redis or Celery.
    handle = start_workers() if worker_enabled() else None
    try:
        yield
    finally:
        if handle:
            await stop_workers(*handle)
```

`main.py` imports `start_workers`, `stop_workers` and `worker_enabled` by name, so tests can monkeypatch `main.start_workers`. A job that is cancelled at shutdown stays in progress, and the 5-minute stale rule reclaims it.

- [x] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest backend/tests/test_recording_worker.py backend/tests/test_no_pii_logs.py backend/tests/test_auth.py -q`
Expected: PASS. `test_auth`'s WebSocket tests don't start the worker.

- [x] **Step 5: Config docs**

In `backend/.env.example`, add `RECORDING_WORKER_CONCURRENCY=2` and `RECORDING_WORKER_ENABLED=1`, each with a one-line comment. Add both to the README `backend/.env` table. In the manual steps, under **Environment variables**: `RECORDING_WORKER_CONCURRENCY` (default 2, backend/Railway: how many jobs run at once in the one process) and `RECORDING_WORKER_ENABLED` (default 1, backend: set to 0 only to pause processing).

- [x] **Step 6: Run the full checks and commit**

```bash
git add backend/ README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(worker): in-process recordings worker in the FastAPI lifespan, with the 7-day purge (H2-7.3, H2-7.8)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The app's recordings client

**Files:**
- Modify: `mobile/services/api.ts` (export the 401 renewal, today `renewAuthToken` at lines 51-63; add the types next to `TranscriptionResult` at line 196; add the four calls to `api`)
- Test: create `mobile/services/__tests__/recordingsApi.test.ts`

**Interfaces:**
- Consumes: `getAuthToken`, `getApiUrl`, `ApiError`, `throwIfNotOk`, `apiRequest`; `getDeviceId` (P6).
- Produces:
  ```ts
  export type RecordingState = 'queued' | 'transcribing' | 'extracting' | 'checking_duplicates' | 'ready' | 'failed';
  export interface RecordingDetail { id: string; status: RecordingState; error: string | null;
    result: TranscriptionResult | null; location: LocationData | null; duration_ms: number | null; created_at: string; }
  export interface RecordingSummary { id: string; status: RecordingState; error: string | null;
    name: string | null; duration_ms: number | null; created_at: string; }
  export interface RecordingUpload { clientRecordingId: string; fileUri: string; durationMs: number; location: LocationData | null; }
  export const renewAuthToken: () => Promise<string>;
  api.uploadRecording(u: RecordingUpload): Promise<{ id: string; status: RecordingState }>
  api.getRecording(id: string): Promise<RecordingDetail>
  api.listRecordings(status?: RecordingState): Promise<RecordingSummary[]>
  api.deleteRecording(id: string): Promise<void>   // 404 counts as done
  ```

- [x] **Step 1: Write the failing tests**

Mock `expo-file-system` as `{ uploadAsync: jest.fn(), FileSystemUploadType: { MULTIPART: 1 }, FileSystemSessionType: { BACKGROUND: 0 } }` and `../deviceId` as `{ getDeviceId: async () => 'dev-1' }`. Mock supabase the way `apiRequest.test.ts` does.

```ts
it('uploads as a background multipart request with the fields the server reads', async () => {
  (FileSystem.uploadAsync as jest.Mock).mockResolvedValue({ status: 202, body: '{"id":"r1","status":"queued"}' });
  await expect(api.uploadRecording({ clientRecordingId: 'c1', fileUri: 'file:///docs/recordings/c1.m4a',
    durationMs: 61000, location: LOC })).resolves.toEqual({ id: 'r1', status: 'queued' });
  expect(FileSystem.uploadAsync).toHaveBeenCalledWith(getApiUrl('/api/recordings'), 'file:///docs/recordings/c1.m4a', {
    httpMethod: 'POST', uploadType: 1, sessionType: 0, fieldName: 'audio', mimeType: 'audio/mp4',
    parameters: { client_recording_id: 'c1', duration_ms: '61000', location: JSON.stringify(LOC) },
    headers: { Authorization: 'Bearer tok', 'X-Device-Id': 'dev-1' },
  });
});
it('leaves location out when there is none', ...);              // parameters has no "location" key
it('renews the session and retries once after a 401', ...);     // 401 then 202 -> two calls, second with the new token
it("throws the server's detail for a 4xx", ...);                // 400 {"detail":"File is not in M4A format"} -> ApiError(400, that, 'http')
it('a rejected upload is a network ApiError (status 0)', ...);  // uploadAsync rejects -> ApiError kind 'network'
it('getRecording reads GET /api/recordings/{id}', ...);
it('listRecordings passes the status filter', ...);             // '/api/recordings?status=ready'; no query when omitted
it('deleteRecording treats 404 as done', ...);
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd mobile && npx jest services/__tests__/recordingsApi.test.ts`
Expected: FAIL (`api.uploadRecording is not a function`).

- [x] **Step 3: Implement**

`uploadRecording` builds its own headers (`uploadAsync` bypasses `authedFetch`). It turns a non-2xx `{status, body}` into an `ApiError` through the same detail parsing `throwIfNotOk` uses (factor out `apiErrorFrom(status: number, bodyText: string): ApiError` and use it in both). It turns a rejected `uploadAsync` into `ApiError(0, 'No connection to the server. Check your network and try again.', 'network')`. Comment why it's a background session (H2-7.6): the upload carries on while the app is suspended.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && npx jest services/__tests__ && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Run the full checks and commit**

```bash
git add mobile/services/api.ts mobile/services/__tests__/recordingsApi.test.ts
git commit -m "feat(mobile): recordings API client with background multipart upload (H2-7.6)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The offline recording queue

**Files:**
- Modify: `mobile/package.json` (`npx expo install expo-sqlite` gives ~15.2.14)
- Create: `mobile/services/recordingQueueStore.ts`, `mobile/services/recordingQueue.ts`, `mobile/test/mocks/expoSqlite.js`
- Modify: `mobile/test/setup.js` (global `expo-sqlite` mock; the NetInfo mock if Phase 6 didn't add it)
- Test: create `mobile/services/__tests__/recordingQueueStore.test.ts`, `mobile/services/__tests__/recordingQueue.test.ts`
- Modify: `docs/superpowers/plans/2026-10-23-manual-steps.md`

**Interfaces:**
- Consumes: `api.uploadRecording`, `ApiError` (Task 5); `newRequestId` (P2, `utils/requestId.ts`) for each `client_recording_id`; `LocationData` (`mobile/types`).
- Produces:
  ```ts
  // recordingQueueStore.ts: the only file that touches expo-sqlite
  export type QueueState = 'pending' | 'uploading' | 'rejected';
  export interface QueuedRecording { clientRecordingId: string; fileUri: string; durationMs: number;
    location: LocationData | null; createdAt: string; state: QueueState; attempts: number;
    nextAttemptAt: number; lastError: string | null; }
  export async function insertQueued(item: QueuedRecording): Promise<void>
  export async function updateQueued(id: string, patch: Partial<Pick<QueuedRecording, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError'>>): Promise<void>
  export async function deleteQueued(id: string): Promise<void>
  export async function allQueued(): Promise<QueuedRecording[]>          // oldest first
  export async function resetUploading(): Promise<number>                // 'uploading' -> 'pending'
  // recordingQueue.ts
  export const RECORDINGS_DIR: string;      // `${FileSystem.documentDirectory}recordings/`
  export const UPLOAD_COPY_DIR: string;     // `${FileSystem.cacheDirectory}uploads/` (expo-file-system's multipart copy)
  export const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
  export type QueueEvent = { type: 'changed' } | { type: 'uploaded'; clientRecordingId: string; recordingId: string };
  export function isOnlineState(s: { isConnected: boolean | null; isInternetReachable?: boolean | null }): boolean
  export async function enqueueRecording(sourceUri: string, durationMs: number, location: LocationData | null): Promise<QueuedRecording>
  export async function listQueued(): Promise<QueuedRecording[]>
  export async function removeQueued(clientRecordingId: string): Promise<void>
  export async function flushQueue(): Promise<void>
  export function subscribe(listener: (e: QueueEvent) => void): () => void
  export function startRecordingQueue(): () => void
  ```
- The SQLite table (`recording-queue.db`) holds exactly: `client_recording_id TEXT PRIMARY KEY NOT NULL, file_uri TEXT NOT NULL, duration_ms INTEGER NOT NULL, location TEXT, created_at TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT`. No transcript or case-data column (roadmap: audio plus location only).

Behaviour the tests pin:
- `enqueueRecording` makes `RECORDINGS_DIR` (`intermediates: true`), moves `sourceUri` to `${RECORDINGS_DIR}<id>.m4a`, inserts `state: 'pending'`, emits `changed`, and does **not** start a flush (the caller does, after it has recorded the id; see Task 7).
- `flushQueue` is single-flight: a call while a flush is running joins that flush. It reads `NetInfo.fetch()`, and when offline it changes nothing. It then uploads the due items (`nextAttemptAt <= Date.now()`, `state === 'pending'`), oldest first, one at a time, each set to `uploading` first.
  - On success: delete the queued file, delete `${UPLOAD_COPY_DIR}<id>.m4a` (both `idempotent: true`), delete the row, then emit `uploaded`.
  - On `ApiError` status 0, 408, 429, ≥ 500 or kind `auth`: `pending`, `attempts + 1`, `nextAttemptAt = now + BACKOFF_MS[min(attempts, 3)]`, and `lastError` set to the error's detail. Arm one timer for the earliest `nextAttemptAt`.
  - On any other 4xx: `rejected`, with `lastError = detail`. Never retried.
- `startRecordingQueue` calls `resetUploading()` (the app was killed mid-upload), flushes, and flushes again on every NetInfo change to online and on every AppState change to `active`. It returns a stop function that removes the listeners and the timer.
- `removeQueued` deletes the file and the row and emits `changed` (discarding a recording before it is uploaded).
- `__DEV__`-guarded logs pass error objects only (`noDataLogs.test.ts`).

- [x] **Step 1: Write the failing store tests** (`recordingQueueStore.test.ts`, against `test/mocks/expoSqlite.js`, whose `openDatabaseAsync` resolves one shared fake db with `jest.fn` `execAsync`/`runAsync`/`getAllAsync`/`getFirstAsync`)

```ts
it('creates the table with only audio, location and upload-state columns', async () => {
  await allQueued();
  const ddl = (db.execAsync as jest.Mock).mock.calls.map(c => c[0]).join('\n');
  const cols = [...ddl.matchAll(/^\s*(\w+) (TEXT|INTEGER)/gm)].map(m => m[1]);
  expect(cols).toEqual(['client_recording_id', 'file_uri', 'duration_ms', 'location', 'created_at', 'state',
                        'attempts', 'next_attempt_at', 'last_error']);
});
it('opens the database once', ...);                        // two calls -> openDatabaseAsync called once
it('inserts with bound parameters and the location as JSON', ...);
it('maps rows back to QueuedRecording, parsing location', ...);
it('resetUploading moves uploading rows back to pending', ...);   // UPDATE ... WHERE state = 'uploading'
```

- [x] **Step 2: Write the failing queue tests** (`recordingQueue.test.ts`)

Mock `../recordingQueueStore` with an in-memory array behind the same five functions. Mock `expo-file-system` with `documentDirectory: 'file:///docs/'`, `cacheDirectory: 'file:///cache/'`, `makeDirectoryAsync`, `moveAsync`, `deleteAsync`. Mock `../api` with `api.uploadRecording: jest.fn()` and the real `ApiError`. Use NetInfo's jest mock with `fetch` set per test, and an `AppState.addEventListener` spy. Use `jest.useFakeTimers()`, with `Date.now` driven by the fake timers. `newRequestId` (mock `../../utils/requestId`) returns `'c1'`, `'c2'`, ...

```ts
it('moves the recording into documentDirectory/recordings and queues it without uploading yet', async () => {
  const item = await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/rec.m4a', to: 'file:///docs/recordings/c1.m4a' });
  expect(item).toMatchObject({ clientRecordingId: 'c1', state: 'pending', attempts: 0, location: LOC });
  expect(api.uploadRecording).not.toHaveBeenCalled();
});
it('does not upload while offline', ...);                       // fetch -> isConnected false -> no upload, still pending
it('a 202 deletes the queued file, Expo\'s multipart copy and the row', async () => {
  // online; uploadRecording -> {id:'r1', status:'queued'}
  await flushQueue();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///docs/recordings/c1.m4a', { idempotent: true });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/uploads/c1.m4a', { idempotent: true });
  expect(await listQueued()).toEqual([]);
  expect(listener).toHaveBeenCalledWith({ type: 'uploaded', clientRecordingId: 'c1', recordingId: 'r1' });
});
it('a network failure backs off 5 s, then retries', ...);      // attempts 1, nextAttemptAt now+5000; advance 5000 -> 2nd upload
it('backs off 5 s, 30 s, 120 s, then every 600 s', ...);
it('a 400 rejects the item with the server detail and never retries it', ...);
it('two flushes at once upload each item once', ...);
it('start resets items left uploading and uploads them', ...);  // store has an 'uploading' row -> pending -> uploaded
it('uploads when the connection comes back', ...);             // NetInfo listener called with online -> flush
it('uploads when the app returns to the foreground', ...);     // AppState 'active' -> flush
it('stop removes the listeners and the retry timer', ...);
it('removeQueued deletes the file and the row', ...);
it('treats unknown reachability as online', () => {
  expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true);
  expect(isOnlineState({ isConnected: false, isInternetReachable: null })).toBe(false);
  expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
});
```

- [x] **Step 3: Run them to verify they fail**

Run: `cd mobile && npx jest services/__tests__/recordingQueue`
Expected: FAIL (modules missing).

- [x] **Step 4: Install and implement**

Run `cd mobile && npx expo install expo-sqlite`, then write the two modules. The database opens lazily with one cached promise (`SQLite.openDatabaseAsync('recording-queue.db')`, then `CREATE TABLE IF NOT EXISTS ...`). Comment on `RECORDINGS_DIR` that it's `documentDirectory`, not the cache, because the OS may clear the cache and a queued note must survive (H2-7.6).

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd mobile && npx jest && npx tsc --noEmit`
Expected: PASS, `noDataLogs.test.ts` included.

- [x] **Step 6: Manual step**

Under **Owner actions outside code** in the manual steps: "After pulling Phase 7: `cd mobile && npx expo prebuild --platform ios` (adds the ExpoSQLite pod), review the `ios/` diff, commit it, and rebuild the dev build (`npx expo run:ios`). An older build crashes on the Record tab without it." Task 9 adds the entitlement to the same prebuild, so the owner can do both in one pass.

- [x] **Step 7: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/services/recordingQueue*.ts mobile/services/__tests__/recordingQueue*.test.ts mobile/test/ docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): offline recording queue on expo-sqlite with background upload and backoff (H2-7.6)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The Record screen queues, polls and reviews

**Files:**
- Create: `mobile/utils/recordingStatus.ts`, `mobile/services/recordingQueries.ts`
- Modify: `mobile/screens/ModernRecordScreen.tsx` (the recording flow, today lines 28-147 and the record-tab JSX at lines 237-321)
- Modify: `mobile/components/ModernAudioRecorder.tsx` (the props type at line 29; the hand-off at lines 260-264 only)
- Modify: `mobile/components/TranscriptionResults.tsx` (the props at lines 33-49; the save at lines 118-125; the re-check condition at line 169)
- Modify: `mobile/services/api.ts` (remove `transcribe` and `TRANSCRIBE_TIMEOUT_MS`)
- Test: create `mobile/utils/__tests__/recordingStatus.test.ts`; rewrite `mobile/screens/__tests__/ModernRecordScreen.test.tsx`; extend `components/__tests__/TranscriptionResults.test.tsx` and `components/__tests__/ModernAudioRecorder.test.tsx`; drop the `transcribe uses a 120 s timeout` case in `services/__tests__/apiRequest.test.ts` (line 220)
- Modify: `README.md`, `CLAUDE.md`, `docs/VOICE_PIPELINE.md`

**Interfaces:**
- Consumes: the queue (Task 6), the API (Task 5), TanStack Query (P6), `useNetInfo`.
- Produces:
  ```ts
  // utils/recordingStatus.ts
  export const IN_PROGRESS: RecordingState[] = ['queued', 'transcribing', 'extracting', 'checking_duplicates'];
  export const POLL_MS = 2000;
  export function recordingPollInterval(status: RecordingState | undefined): number | false  // POLL_MS while in progress or unknown
  export interface StatusView { label: string; tone: 'progress' | 'ready' | 'error'; detail?: string }
  export function recordingStatusView(local: QueuedRecording | null, online: boolean,
                                      server: { status: RecordingState; error: string | null } | null): StatusView
  // services/recordingQueries.ts
  export const recordingKeys = { all: ['recordings'] as const, list: () => ['recordings', 'list'] as const,
                                 detail: (id: string) => ['recordings', 'detail', id] as const };
  export function useRecording(id: string | null): UseQueryResult<RecordingDetail>   // refetchInterval from recordingPollInterval
  export function useRecordingsList(): UseQueryResult<RecordingSummary[]>            // refetchInterval 30_000
  export function useReadyDraftCount(): number
  export function useQueuedRecordings(): QueuedRecording[]                           // listQueued + subscribe
  ```
  - `ModernAudioRecorder` props: `onRecordingComplete: (uri: string, location: RecordingLocation | undefined, durationMs: number) => void`. This task owns the change. Every call site passes the recorder status's `durationMillis` at that moment: the normal stop, the 2:00 auto-stop, and Phase 5's interruption **Keep** path. Phases 5 and 6 left the callback at two arguments.
  - `TranscriptionResults` gains two optional props: `idempotencyKey?: string` (used instead of the per-session UUID Phase 2 creates) and `recheckDuplicates?: boolean` (Save runs `check-duplicates` even when the fields are unedited, exactly as for `duplicate_check_failed`).

The `recordingStatusView` copy (exact):

| Input | label | tone | detail |
|---|---|---|---|
| local `pending`/`uploading`, offline | `Queued: no connection` | progress | |
| local `pending`/`uploading`, online | `Uploading` | progress | |
| local `rejected` | `Couldn't upload this recording` | error | `lastError` |
| server status in `IN_PROGRESS` | `Transcribing` | progress | |
| server `ready` | `Ready to review` | ready | |
| server `failed` | `Couldn't process this recording` | error | `error` |

Screen behaviour:
- `handleRecordingComplete(uri, fix, durationMs)` calls `enqueueRecording(uri, durationMs, (manualLocation ?? fix)?.location ?? null)`, sets `currentRef`/`current = { clientRecordingId, recordingId: null }`, clears the hand-picked location (C-02: it belonged to this recording), then calls `void flushQueue()`.
- The queue's `uploaded` event for the current id sets `recordingId`, and the screen then polls `useRecording(recordingId)`.
- The recorder is shown again as soon as the recording is queued. It is hidden only while a review is open; queued work can't race now, which replaces C-13.
- The status card shows `recordingStatusView`, with these buttons:
  - ready: **Review now** (opens the review) and **Later** (clears `current`; the recording stays in Drafts);
  - failed: **Discard** (`api.deleteRecording`);
  - rejected: **Discard** (`removeQueued`).
- A review renders `TranscriptionResults` with `result={rec.result}`, `location={manualLocation?.location ?? rec.location ?? undefined}`, `idempotencyKey={rec.id}`, `recheckDuplicates`, `onSave={() => finish(rec.id)}` and `onCancel={() => confirmDiscard(rec.id)}`.
  - `finish` calls `api.deleteRecording`. If that fails, toast `Saved. Couldn't remove the draft.` (a second save of it is idempotent).
  - `confirmDiscard` shows `Alert.alert('Discard this recording?', 'The audio and its transcript will be deleted.', [{text: 'Cancel', style: 'cancel'}, {text: 'Discard', style: 'destructive', onPress: ...}])`.
  - Either one invalidates `recordingKeys.all` and clears the review, `current` and the locations.
- `openDraft(id: string)` (used by Task 8) runs `queryClient.fetchQuery(detail(id))` and opens the review when the status is `ready`.
- Removed: `holdRecording`, the cache-file cleanup, `uploadAudioFile`/`transcribeAudio` and their toasts, `retryTranscription`. The queue now owns the file, and retrying is automatic.

- [x] **Step 1: Write the failing tests**

`recordingStatus.test.ts`: one `it` per table row, asserting `recordingStatusView(...)` equals `{label, tone, detail?}` exactly. Plus `recordingPollInterval`: `'transcribing'` → 2000, `undefined` → 2000, `'ready'` → `false`, `'failed'` → `false`.

`TranscriptionResults.test.tsx`:

```ts
it('re-checks unedited data when recheckDuplicates is set (a draft reviewed later)', async () => {
  // render with recheckDuplicates, unedited result, no matches; mock checkDuplicates -> [MATCH]
  // tap Save -> api.checkDuplicates called once with the fields, and MergeUI opens for MATCH
});
it('uses the given idempotencyKey as the save\'s Idempotency-Key', async () => {
  // render with idempotencyKey="rec-1"; save -> api.saveIndividual was called with expect.objectContaining({ idempotency_key: 'rec-1' }) (Phase 2's field)
});
```

`ModernAudioRecorder.test.tsx`: in `auto-stops at 2:00 and reports the recording`, assert the third argument is `120000` (or whatever duration the recorder status reports at auto-stop), and in the interruption Keep test, `onComplete('file://a.m4a', undefined, 42000)`.

`ModernRecordScreen.test.tsx` (rewrite). Mock `../../services/recordingQueue` (`enqueueRecording`, `flushQueue`, `subscribe` capturing the listener, `listQueued`, `removeQueued`) and `../../services/api` (`getRecording`, `deleteRecording`, `listRecordings`). The recorder stub calls `onRecordingComplete(mockNextUri, mockNextFix, 61000)`. Render inside a `QueryClientProvider` with `retry: false`, using Phase 6's test wrapper if it has one. Keep the existing C-02/C-04 location cases, rewritten against `enqueueRecording`'s third argument:

```ts
it('queues the recording with its own fix, then starts the upload', ...);   // enqueue('file:///clip.m4a', 61000, fix.location), then flushQueue
it("does not reuse the previous recording's fix", ...);
it("uses a hand-picked location over the recording's fix", ...);
it('does not carry a hand-picked location over to the next recording', ...);
it('opens the picker at the current location', ...);
it('shows "Queued: no connection" while offline', ...);                    // NetInfo mock offline
it('shows "Uploading" while the queued recording is sent', ...);
it('polls the recording every 2 s while it is transcribing', ...);         // uploaded event -> getRecording; advance 2000 -> called again
it('shows "Ready to review" and stops polling once ready', ...);
it('Review now opens the stored result with the recording location', ...); // TranscriptionResults stub shows Loc: <address>
it('saving a draft passes its recording id as the idempotency key and deletes the recording', ...);
it('Later keeps the recording for Drafts without deleting it', ...);
it('discarding asks first, then deletes the recording', ...);
it('a failed recording shows its error and can be discarded', ...);
it('shows the recorder again as soon as a recording is queued', ...);      // replaces the C-13 "hides the recorder" case
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd mobile && npx jest utils/__tests__/recordingStatus.test.ts screens/__tests__/ModernRecordScreen.test.tsx components/__tests__/TranscriptionResults.test.tsx components/__tests__/ModernAudioRecorder.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement**

Write the helpers, the query hooks, the screen changes, the two `TranscriptionResults` props and the recorder's third argument. Remove `api.transcribe`. Status card text needs `accessibilityLiveRegion="polite"` and `accessibilityRole` on the buttons (Phase 6 a11y rules).

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && npx jest && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Docs (the upload format changed)**

- README "How it works": step 1 becomes `POST /api/recordings (multipart m4a) → 202`, with a worker box (transcribe → extract → duplicate check), then a `GET /api/recordings/{id}` poll.
- "Data leaving the system", first row: the phone keeps the audio in `documentDirectory/recordings/` until the server answers 202. The server keeps it in the private `recordings` bucket until the transcription is saved. The transcript and result live in `recordings` until the draft is saved or discarded, or for at most 7 days.
- `docs/VOICE_PIPELINE.md` §1 Retry and §2 Upload are rewritten for the queue and the worker, and §3 says the stages are shared (`services/recording_pipeline.py`).
- CLAUDE.md, under "Recording": "A finished recording is queued (`mobile/services/recordingQueue.ts`) and uploaded to `POST /api/recordings`; the backend's lifespan worker processes it; `/api/transcribe` is deprecated."

- [x] **Step 6: Commit**

```bash
git add mobile/ README.md CLAUDE.md docs/VOICE_PIPELINE.md
git commit -m "feat(mobile): Record screen queues recordings and reviews them when ready (H2-7.5, H2-7.7)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Drafts list, the Record tab badge, and starting the queue

**Files:**
- Create: `mobile/components/DraftsList.tsx`
- Modify: `mobile/screens/ModernRecordScreen.tsx` (render `<DraftsList>` under the recorder card)
- Modify: `mobile/App.tsx` (the Record `Tab.Screen` options, today lines 125-129; an effect in `AppContent` that runs once signed in)
- Test: create `mobile/components/__tests__/DraftsList.test.tsx`; extend `mobile/__tests__/App.test.tsx`
- Modify: `README.md` (remove "No offline support" from Shortcuts; describe Drafts)

**Interfaces:**
- Consumes: `useRecordingsList`, `useQueuedRecordings`, `useReadyDraftCount`, `recordingKeys` (Task 7); `recordingStatusView`; `startRecordingQueue`, `subscribe`, `removeQueued` (Task 6); `api.deleteRecording`.
- Produces: `DraftsList: React.FC<{ excludeIds: string[]; onReview: (recordingId: string) => void }>`.
  - Rows: local queued items first, then the server list minus `excludeIds` (the recording shown in the status card), newest first.
  - Each row shows the time (`toLocaleTimeString`), the duration `m:ss`, the server's `name` when present (else "Recording"), and the `recordingStatusView` label.
  - A `ready` row is a button that calls `onReview(id)`. `failed` and `rejected` rows have a **Discard** button.
  - The header reads `Drafts (n)`. Nothing renders when there are no rows.

- [x] **Step 1: Write the failing tests**

`DraftsList.test.tsx` (wrap in a `QueryClientProvider`; mock the queue and the API):

```ts
it('lists queued and server drafts with their status', ...);   // one local pending offline + one ready + one transcribing -> 3 rows, exact labels
it('leaves out the recording the status card already shows', ...);
it('a ready draft opens the review', ...);                    // press -> onReview('r1')
it('a failed draft can be discarded', ...);                   // Discard -> api.deleteRecording('r2'), list refetched
it('a rejected upload can be discarded', ...);                // Discard -> removeQueued('c1')
it('renders nothing when there are no drafts', ...);
it('shows the extracted name, never the transcript', ...);    // the transcript text from result is not rendered
```

`App.test.tsx`: add `listRecordings` to the mocked `api`, mock `../services/recordingQueue` (`startRecordingQueue` returns a jest.fn stop; `subscribe` returns a jest.fn unsubscribe), then:

```ts
it('badges the Record tab with the number of ready drafts', ...);    // listRecordings -> 2 ready + 1 failed -> badge text "2"
it('starts the recording queue once signed in and stops it on sign-out', ...);
it('refreshes the drafts when the queue reports an upload', ...);   // emit {type:'uploaded'} -> listRecordings called again
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd mobile && npx jest components/__tests__/DraftsList.test.tsx __tests__/App.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement**

In `AppContent`, inside Phase 6's `QueryClientProvider`, add `useEffect(() => { if (!user) return; const stop = startRecordingQueue(); const off = subscribe(e => { if (e.type === 'uploaded') queryClient.invalidateQueries({ queryKey: recordingKeys.all }); }); return () => { off(); stop(); }; }, [user])`. The Record tab gets `tabBarBadge: readyCount > 0 ? readyCount : undefined` and `tabBarBadgeAccessibilityLabel` reading `"<n> drafts ready to review"`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && npx jest && npx tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add mobile/ README.md
git commit -m "feat(mobile): Drafts list and Record tab badge for recordings ready to review (H2-7.7)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Audio at rest: Data Protection, docs and device checks

**Files:**
- Modify: `mobile/app.json` (`expo.ios`)
- Test: create `mobile/__tests__/appConfig.test.ts`
- Modify: `README.md` (privacy and Known issues), `docs/superpowers/plans/2026-10-23-manual-steps.md`

**Interfaces:**
- Produces: `expo.ios.entitlements = { "com.apple.developer.default-data-protection": "NSFileProtectionComplete" }`. It applies to every file the app creates: the queued audio, Expo's `Caches/uploads` copy and the SQLite database.

- [ ] **Step 1: Write the failing test**

```ts
import appJson from '../app.json';
it('gives every app file iOS Data Protection Complete (H2-7.8)', () => {
  expect(appJson.expo.ios.entitlements).toEqual({ 'com.apple.developer.default-data-protection': 'NSFileProtectionComplete' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mobile && npx jest __tests__/appConfig.test.ts`
Expected: FAIL (`entitlements` undefined).

- [ ] **Step 3: Add the entitlement to `app.json`**

- [ ] **Step 4: Run it to verify it passes**

Run: `cd mobile && npx jest __tests__/appConfig.test.ts && npx tsc --noEmit`
Expected: PASS. If `resolveJsonModule` isn't on, read the file with `fs` instead of importing it.

- [ ] **Step 5: README**

In the privacy section, add a short "Audio at rest" paragraph:
- on the phone: Data Protection Complete, which makes the files unreadable while the phone is locked; the queue file and Expo's multipart copy are deleted on a 202;
- on the server: the private bucket, the file deleted once transcribed, rows purged after 7 days;
- deliberate trade-off: `documentDirectory` is included in device backups, so a backup taken while a recording is still queued contains it. The cache was rejected because iOS may clear it before an offline note is uploaded.

Remove "No offline support" from Shortcuts if Task 8 hasn't already.

- [ ] **Step 6: Append to the manual steps**

Under **Owner actions outside code**: "Enable the Data Protection capability for the App ID (Apple Developer → Identifiers; needs the paid account), then `cd mobile && npx expo prebuild --platform ios` and check that `ios/SFHomelessOutreach/SFHomelessOutreach.entitlements` has `com.apple.developer.default-data-protection = NSFileProtectionComplete` and that `CODE_SIGN_ENTITLEMENTS` points at it; commit the `ios/` diff."

Under **Device checks** (physical iPhone, dev build):
- **P7-1 Airplane-mode queueing.** Turn on airplane mode and record two notes. Expected: each shows "Queued: no connection" and both are in Drafts. Turn airplane mode off. Expected: within about 10 s both go "Uploading" → "Transcribing" → "Ready to review", and the Record tab badge shows 2.
- **P7-2 App killed mid-upload.** Settings → Developer → Network Link Conditioner "Very Bad Network". Record, and force-quit while "Uploading". Turn the conditioner off and relaunch. Expected: the item uploads again and exactly one draft appears (Supabase: one `recordings` row for that `client_recording_id`).
- **P7-3 Background upload.** On a slow network, record and press Home straight away (don't lock). Wait 60 s and reopen. Expected: the recording is "Transcribing" or "Ready to review", not uploading from the start.
- **P7-4 Locked during upload.** On a slow network, record and lock the phone straight away. Unlock after 2 minutes and open the app. Expected: the recording ends up uploaded, at once or on that foreground retry, and is never lost (Deviation 11).
- **P7-5 Entitlement shipped.** `codesign -d --entitlements - <path to the built .app>` lists `com.apple.developer.default-data-protection` = `NSFileProtectionComplete`.
- **P7-6 No audio left behind.** After P7-1, Xcode → Devices → the app → Download Container. Expected: `Documents/recordings/` and `Library/Caches/uploads/` are empty. In Supabase Storage, the `recordings` bucket has no object for a transcribed recording.
- **P7-7 Save and discard clean up.** Save one draft and discard another. Expected: both rows are gone from `recordings` and the badge drops to 0.

- [ ] **Step 7: Run the full checks and commit**

Run: `python -m pytest -q && ruff check backend --select F,E9 && (cd mobile && npx tsc --noEmit && npx jest)`
Expected: all pass.

```bash
git add mobile/app.json mobile/__tests__/appConfig.test.ts README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): iOS Data Protection for queued audio; Phase 7 device checks (H2-7.8)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
