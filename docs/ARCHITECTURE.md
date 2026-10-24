# Architecture

A tour of the VoiceReach codebase. For setup, see the root [README](../README.md).

## Project overview

- **What:** a mobile app for SF homeless-outreach workers. They record a voice
  note after an encounter; AI turns it into a structured record, scores urgency
  and checks for duplicates. A realtime voice assistant answers questions about
  people already on file.
- **Origin:** a 36-hour hackathon MVP, later cleaned up. Core flows (record,
  extract, merge or create, search, profile, assistant, categories, export)
  work end to end against your own Supabase project; the original hosted demo is
  gone.
- **Character:** simple solutions over patterns. Demo-grade auth (one shared
  account). CORS allows only the browser origins listed in `CORS_ALLOW_ORIGINS`
  (none by default), never with credentials. See the README's "Known limitations
  (deliberate)".

## Technology stack

### Backend
- **Framework:** FastAPI on Python 3.11 (pinned in `requirements.txt` at the
  repo root)
- **Database:** Postgres via Supabase, accessed with the service key
- **Auth:** Supabase Auth. Every `/api/*` route verifies the bearer token:
  ES256/RS256 locally against the project JWKS, anything else with
  `auth.get_user` (`backend/api/auth.py`)
- **AI:** `gpt-transcribe` (`TRANSCRIBE_MODEL`), `gpt-4o` with Structured Outputs
  (`CHAT_MODEL`), `gpt-4o-mini` for duplicates (`DUPLICATE_MODEL`),
  `text-embedding-3-large`, `gpt-realtime-2.1` with server-side tools
  (`services/model_config.py`). Every client is built by
  `services/openai_client.make_async_openai`, which returns the load-test fake
  when `VOICEREACH_FAKE_OPENAI=1` (refused in production)
- **Async work:** an in-process recording worker started by the FastAPI lifespan
  (`services/recording_worker.py`), with Postgres as the queue (`SKIP LOCKED`)
- **Observability:** one JSON summary line per request, job and realtime session
  (`services/request_log.py`, fields allowlisted), `X-Request-Id` on every
  response, optional Sentry with scrubbing (`SENTRY_DSN`)
- **Tests:** pytest, offline with mocks; db tests on a real Postgres; offline
  evals; one opt-in live smoke test; a Locust load test. CI runs ruff, pytest,
  the db job and a gitleaks scan

### App
- **Framework:** React Native with Expo SDK 53, iOS only. `mobile/ios/` is
  committed (prebuilt), so `app.json` changes need `npx expo prebuild --platform ios`
- **Navigation:** bottom tabs (Record, Search, Assistant, Categories, Profile),
  with a stack inside Search for the individual profile
- **State:** TanStack Query for server data, memory only
  (`services/queryClient.ts`, keys in `services/queries.ts`); React Context for
  auth and categories (`AuthContext`, `CategoryContext`)
- **Audio:** `expo-audio` for field notes (M4A/AAC, 16 kHz mono, 32 kbps,
  `FIELD_NOTE_RECORDING`); `react-native-audio-api` to stream the assistant's mic
  and play its replies; only `services/audioSession.ts` changes the audio session
- **Recording queue:** recordings are queued in SQLite (`expo-sqlite`,
  `services/recordingQueueStore.ts`) and uploaded in the background
  (`expo-file-system` `uploadAsync`), protected at rest (NSFileProtectionComplete)
- **Session storage:** the Supabase session is encrypted with a key kept in the
  Keychain (`expo-secure-store`, `services/secureSessionStorage.ts`)
- **Errors:** an `ErrorBoundary` and optional Sentry, JS errors only, scrubbed
  (`services/sentry.ts`)
- **Location and maps:** `expo-location` for GPS and reverse geocoding,
  `react-native-maps` for the profile map
- **Tests:** Jest (`jest-expo`) and `tsc --noEmit`; five Maestro flows in
  `mobile/.maestro/` (run by hand on the simulator)
- **Builds:** EAS profiles in `mobile/eas.json` (development, preview, production)

### Infrastructure
- **Database:** one Supabase project. A fresh database runs `supabase/schema.sql`
  (then `supabase/seed.sql` for demo people only); an existing one applies
  `supabase/migrations/` in filename order. Every migration is idempotent, and
  `supabase/check_migrations.sh` proves it (CI applies each one twice). Extensions:
  `pg_trgm` and `vector` (pgvector, `halfvec` with HNSW)
- **Storage:** one private Supabase Storage bucket, `recordings`. An uploaded voice
  note waits there until its transcript is saved; the worker then deletes it, and
  anything older than 7 days is purged hourly
- **Hosting:** runs locally. `railway.toml` (with a `/health` deploy
  healthcheck), `.python-version` and the root `main.py` remain for a Railway
  deployment of the backend
- **Errors:** Sentry, optional on both sides (`SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN`)

## Database schema

From `supabase/schema.sql`, which is the full current schema. Abridged; see the
file for every CHECK and default:

```sql
categories (
    id UUID PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,       -- the key used in data (category_key)
    display_name TEXT,               -- the label as typed
    type TEXT NOT NULL,      -- CHECK: text/number/single_select/multi_select/date/location
    options JSONB,           -- [{label, value}] for single_select, [text] for multi_select
    priority TEXT NOT NULL,  -- CHECK: high/medium/low (display only)
    urgency_weight INTEGER NOT NULL,  -- only meaningful for number/single_select
    auto_trigger BOOLEAN NOT NULL,    -- can pin the urgency score to 100
    is_required, is_preset, is_active BOOLEAN NOT NULL,   -- is_active: reserved
    is_sensitive BOOLEAN NOT NULL,   -- never scored, kept out of prompts and embeddings
    number_scale_max NUMERIC,        -- a number's full-weight value; NULL = 300
    created_at, updated_at TIMESTAMPTZ NOT NULL
)

individuals (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    data JSONB NOT NULL,     -- every field, keyed by category name
    urgency_score INTEGER NOT NULL,  -- calculated
    urgency_override INTEGER,-- manual (CHECK 0-100), shown instead of the score when set
    last_location JSONB,     -- {latitude, longitude, address}
    version INTEGER NOT NULL,-- bumped only by save_individual (optimistic concurrency)
    search_tsv tsvector GENERATED,   -- full text over the name and data values, never keys
    created_at, updated_at TIMESTAMPTZ NOT NULL
)

interactions (               -- append-only (a trigger refuses UPDATE)
    id UUID PRIMARY KEY,
    individual_id UUID NOT NULL REFERENCES individuals ON DELETE CASCADE,
    user_id TEXT,            -- the Supabase user id, stored as text
    user_name TEXT NOT NULL, -- always "Demo User" today
    transcription TEXT,
    audio_url TEXT,
    location JSONB,          -- coarsened to ~110 m after 30 days (coarsen_old_locations)
    changes JSONB NOT NULL,  -- only the fields that changed (everything on the first visit)
    client_request_id UUID UNIQUE,   -- the save's Idempotency-Key
    created_at TIMESTAMPTZ NOT NULL
)

individual_embeddings (
    id UUID PRIMARY KEY,
    individual_id UUID NOT NULL UNIQUE REFERENCES individuals ON DELETE CASCADE,
    embedding halfvec(3072) NOT NULL, -- pgvector, HNSW (halfvec_cosine_ops)
    embedding_text TEXT NOT NULL,    -- exactly the text that was embedded
    model TEXT NOT NULL, text_hash TEXT NOT NULL,  -- fresh while both match
    source_updated_at TIMESTAMPTZ NOT NULL,
    created_at, updated_at TIMESTAMPTZ NOT NULL
)

interaction_embeddings (     -- one vector per visit transcript, for the assistant
    interaction_id UUID PRIMARY KEY REFERENCES interactions ON DELETE CASCADE,
    individual_id UUID NOT NULL REFERENCES individuals ON DELETE CASCADE,
    embedding halfvec(3072) NOT NULL, model TEXT NOT NULL, text_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
)

recordings (                 -- the async transcription jobs
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL, device_id TEXT,
    client_recording_id UUID NOT NULL UNIQUE,   -- makes a repeated upload safe
    status TEXT NOT NULL,    -- queued/transcribing/extracting/checking_duplicates/ready/failed
    storage_path TEXT,       -- the file in the recordings bucket, NULL once transcribed
    duration_ms INTEGER, location JSONB,
    transcription TEXT, result JSONB, error TEXT,
    attempts INTEGER NOT NULL,       -- at most 3
    created_at, updated_at TIMESTAMPTZ NOT NULL
)

audit_log (                  -- append-only: UPDATE, DELETE and TRUNCATE are refused
    id UUID PRIMARY KEY, at TIMESTAMPTZ NOT NULL,
    user_id TEXT NOT NULL, device_id TEXT,
    action TEXT NOT NULL,    -- view_profile, export_csv, delete_individual, merge_individual, ...
    entity_type TEXT NOT NULL, entity_id TEXT,
    detail JSONB NOT NULL    -- ids and counts only, never names or values
)

duplicate_decisions (        -- labels for the duplicate eval: one row per merge-screen save
    id UUID PRIMARY KEY, at TIMESTAMPTZ NOT NULL,
    candidate_id, matched_id UUID NOT NULL REFERENCES individuals ON DELETE CASCADE,
    confidence INTEGER NOT NULL, decision TEXT NOT NULL,   -- merged / saved_new
    model TEXT, client_request_id UUID UNIQUE
)
```

**SQL functions**, all callable by `service_role` only:
- `save_individual`: one save (new person or merge) plus its interaction in one
  transaction; idempotent by key, and a stale `version` is P0409 (409).
- `rescore_batch`: writes re-computed scores, skipping a row saved since the read.
- `coarsen_old_locations`: rounds visits older than 30 days to about 110 m.
- `find_duplicate_candidates`: the duplicate candidates.
- `search_individuals_hybrid`: the Search tab.
- `match_interactions` and `most_urgent_individuals`: assistant tools.
- `claim_recording_job` and `purge_old_recordings`: the worker.

Row-level security is enabled on every table with **no policies**, so the anon
key and users' own tokens can't read or write any row directly. The backend's
service key bypasses RLS. A `set_updated_at` trigger maintains `updated_at`. The
indexes are:
- `interactions(individual_id, created_at DESC)`;
- trigram GIN on `individuals.name`, and GIN on `search_tsv`;
- HNSW on both embedding tables;
- two on `recordings`.

The app never queries tables directly: its Supabase client is used only to sign
in, and every read and write goes through the backend routes below.

## API structure

All routes except `GET /health` need
`Authorization: Bearer <Supabase access token>`.

- **Recordings:** `POST /api/recordings` (multipart upload, 202), `GET
  /api/recordings/{id}` (poll), `GET /api/recordings` (this phone's drafts),
  `DELETE /api/recordings/{id}` (discard)
- **Transcription:** `POST /api/transcribe`, **deprecated**: the old synchronous
  path, kept for one release; saves nothing
- **Individuals:** `POST /api/individuals` (create or merge; `Idempotency-Key`),
  `GET /api/individuals` (list by cursor, or search), `GET /api/individuals/{id}`,
  `GET /api/individuals/{id}/interactions`, `PUT
  /api/individuals/{id}/urgency-override`, `DELETE /api/individuals/{id}`
  (the app sends it after a 5 s undo window, `mobile/utils/delayedDelete.ts`),
  `POST /api/individuals/check-duplicates`
- **Categories:** `GET` and `POST /api/categories`; `GET /api/export` (CSV)
- **Embeddings:** `POST /api/embeddings/search` (hybrid search), `GET
  /api/embeddings/status`, `POST /api/embeddings/generate`, `POST
  /api/embeddings/generate-all`
- **Voice assistant:** `WS /api/voice-assistant/realtime/ws` (in
  `backend/main.py`), `GET /api/voice-assistant/guidelines`

Details: [`backend/README.md`](../backend/README.md).

## Core business logic

### Required fields
`name`, `height` and `weight` are required by the save request model
(`SaveIndividualRequest` in `backend/db/models.py`) and by the preset categories. Height and weight must
be 0-300 (inches and pounds). Skin color was a required field in early drafts;
it was removed on purpose and must not come back.

### Urgency score
`backend/services/urgency_calculator.py`:

1. Auto-trigger: if a `number` or `single_select` category has `auto_trigger`
   and it fires, the score is 100. A single-select fires only when the chosen
   option's value is greater than 0; a number fires when non-zero.
2. Otherwise a weighted average over categories with a weight:
   - number: `min(value / 300, 1) * weight`
   - single-select: `option_value * weight`
   - score = `int(sum / total_weight * 100)`, clamped to 0-100
   - `total_weight` covers every weighted `number`/`single_select` category; a
     missing value counts as 0 instead of dropping out of the denominator.
   The input is the normalised data (`normalize_individual_data` in
   `backend/services/field_registry.py`), so numbers are real numbers and select
   labels are canonical.
3. The display score is `urgency_override` if it is set (0 included), else the
   calculated score.
   The stored score is computed on every save, and creating a weighted or
   auto-trigger category re-scores everyone (`rescore_all_individuals`;
   `backend/scripts/rescore_urgency.py` does the same after an upgrade).
4. Colours in the app: 0-33 green `#10B981`, 34-66 yellow `#F59E0B`, 67-100 red
   `#EF4444`, as half-open bands (below 34, 34 up to 67, 67 and up), so 33.5 is
   green and 66.5 yellow; a missing score counts as green. One helper decides the
   band for the score colour, the badges and the labels (`getUrgencyLevel` in
   `mobile/utils/urgencyScore.ts`).

### Duplicate detection and merging
1. Candidates: one call to the SQL function `find_duplicate_candidates`, a
   trigram or token name match plus a data-value match (never field names) over
   the 200 most recently updated people
   (`backend/services/duplicate_detection_service.py`). They are pre-ranked by
   name tokens, sound-alikes and close spellings, then height/weight closeness.
2. `DUPLICATE_MODEL` (default `gpt-4o-mini`) scores the top 8 0-100 from name,
   aka, age, height, weight, gender and the last-seen area only (no sensitive or
   medical fields). Matches below 60 are dropped; the top 3 are returned, best
   first. If the LLM fails or its reply can't be read, a whole-word name
   comparison stands in (at most 80, names only). If the candidate search fails,
   `check-duplicates` returns 500 and the recording's result sets
   `duplicate_check_failed`; the app then asks "Duplicate check unavailable. Save
   as new anyway?" instead of saving a possible duplicate silently.
3. Reviewing a draft re-checks before saving (its matches may be hours old), and
   decides on the re-check's matches together with the server's (`topMatches`,
   at most 3 shown); manual entry always checks. Matches whose delayed delete is
   pending are never offered.
4. The app opens the same field-by-field merge UI for any match, on the best one;
   "Other possible matches (n)" switches to another. There is no automatic merge at
   95% or anywhere else. Its buttons are disabled while a save is in flight, and if
   the match can't be loaded it still offers Create New.
5. The app sends the merged data with `merge_with_id` and the `expected_version` it
   loaded; the backend replaces the person's `data` with it in one `save_individual`
   transaction and logs the changed fields as an interaction. A stale version is a
   409 ("This person was changed by someone else. Reload and try again.").

### Audio flow
1. Record M4A (16 kHz mono, 32 kbps; 5 s minimum, 2 min maximum; timer red from
   1:30, warning alert at 1:45, auto-stop at 2:00). Recording starts on tap and
   the GPS fix is captured alongside it; a location picked by hand overrides it.
   An interruption (a call, Siri) stops it and offers Keep or Record again.
2. The recording is queued on the phone (SQLite) and uploaded in the background
   to `POST /api/recordings` when there is a connection (202).
3. Backend worker: transcribe (`TRANSCRIBE_MODEL`, with the SF vocabulary prompt)
   → strict-schema extraction with evidence → validation → duplicate check. The
   app polls `GET /api/recordings/{id}` and lists the job under Drafts.
4. The worker reviews and edits the ready draft; height is converted to inches.
5. `POST /api/individuals` saves, with the transcript on the interaction and the
   recording's id as the `Idempotency-Key`; the draft is then deleted.
6. A background task refreshes the person's and the visit's embeddings.

The full walkthrough is in [`VOICE_PIPELINE.md`](VOICE_PIPELINE.md).

## File structure

### Backend
```
backend/
├── main.py                    # App, lifespan (worker), middleware, routers, realtime WebSocket proxy
├── api/
│   ├── auth.py                # Bearer-token verification (JWKS, else auth.get_user)
│   ├── device.py              # X-Device-Id
│   ├── recordings.py          # /api/recordings (upload, poll, list, discard)
│   ├── transcription.py       # POST /api/transcribe (deprecated)
│   ├── individuals.py         # /api/individuals routes, background embedding task
│   ├── categories.py          # /api/categories and GET /api/export
│   ├── embeddings.py          # /api/embeddings routes
│   ├── errors.py              # internal_error: fixed "<action> failed" 500s
│   └── voice_assistant.py     # GET /api/voice-assistant/guidelines
├── services/
│   ├── openai_service.py      # Transcription, extraction, duplicate scoring call
│   ├── openai_client.py       # make_async_openai (and fake_openai.py for load tests)
│   ├── model_config.py        # Model names from the env
│   ├── category_schema.py     # Extraction json_schema and the evidence check
│   ├── transcribe_vocab.py    # SF vocabulary prompt (no person names)
│   ├── recording_pipeline.py  # The stage functions both transcribe paths run
│   ├── recording_worker.py    # Claims jobs, purges old recordings
│   ├── field_registry.py      # Shared field normaliser, category_key, height parsing
│   ├── duplicate_detection_service.py, duplicate_decisions.py
│   ├── individual_service.py  # Save/merge, list, profile, history, rescore
│   ├── urgency_calculator.py, validation_helper.py
│   ├── embedding_service.py, embedding_refresh.py
│   ├── retrieval.py           # Hybrid search and the assistant's retrieval
│   ├── assistant_tools.py     # The realtime model's four read-only tools
│   ├── search_matching.py     # match_individual: the list search's text matcher
│   ├── sf_neighborhoods.py    # Neighbourhood centroids for the assistant's "near" lookups
│   ├── rate_limit.py          # Per-device limits and realtime session caps
│   ├── realtime_guard.py      # Allowlist for client Realtime events, delimited tool output
│   ├── audit.py               # audit_log writes
│   ├── request_log.py         # Request ids, JSON summary lines (allowlisted fields)
│   └── sentry_setup.py        # Optional Sentry with scrubbing
├── db/                        # client.py (get_supabase, run_db, fetch_all), models.py
├── evals/                     # Offline extraction, duplicate and assistant evals
├── loadtest/                  # Locust load test
├── scripts/                   # backfill_embeddings.py, rescore_urgency.py
└── tests/                     # Offline suite; tests/db/ real Postgres; tests/integration/ live smoke
```

### App
```
mobile/
├── App.tsx                    # Tabs (FROZEN_TABS), the Search stack, the sign-in gate
├── config/api.ts              # Backend URL, Supabase and Sentry settings from .env
├── navigation/types.ts        # Param lists for the tabs and the Search stack
├── screens/
│   ├── ModernRecordScreen.tsx            # Record tab (voice, drafts, manual entry)
│   ├── ModernSearchScreen.tsx            # Search tab
│   ├── ModernIndividualProfileScreen.tsx # Profile, pushed from Search
│   ├── ModernVoiceAssistantScreen.tsx    # Assistant tab (mic streaming, barge-in)
│   ├── CategoriesScreen.tsx              # Categories tab: list, create form, CSV export
│   └── UserProfileScreen.tsx             # Profile tab: signed-in email, last sign-in, Sign Out
├── components/
│   ├── ModernAudioRecorder.tsx  # 5 s - 2 min recorder
│   ├── DraftsList.tsx           # Queued and ready recordings
│   ├── TranscriptionResults.tsx # Review, edit, save or merge
│   ├── ManualEntryForm.tsx
│   ├── MergeUI.tsx              # Field-by-field duplicate resolution
│   ├── ErrorBoundary.tsx, PrivacyOverlay.tsx, CategoryLoadError.tsx
│   ├── UrgencyScore.tsx         # Score display and override slider
│   ├── LocationPicker.tsx, IndividualLocationMap.tsx
│   ├── InteractionHistoryItem.tsx, InteractionDetailModal.tsx
│   └── ui/                      # Button, Card, Badge, Input, AnimatedView (FadeInView)
├── services/
│   ├── api.ts                 # Backend client: getAuthToken, authedFetch, apiRequest, ApiError
│   ├── supabase.ts            # Supabase client (auth only): shared autoLogin, signOut
│   ├── secureSessionStorage.ts, deviceId.ts, sentry.ts
│   ├── queryClient.ts, queries.ts, recordingQueries.ts   # TanStack Query
│   ├── recordingQueue.ts, recordingQueueStore.ts         # The offline upload queue
│   └── audioSession.ts, micStream.ts, replyPlayer.ts     # Audio session, assistant mic and playback
├── contexts/                  # AuthContext, CategoryContext
├── utils/                     # height parsing, urgency colours, errors, location,
│                              # micPermission, categoryPayload, categoryDisplay,
│                              # duplicateMatches, csvExport, fieldValues, delayedDelete,
│                              # recordingStatus, saveConflict, assistantMessages,
│                              # audioProcessor (PCM helpers)
├── .maestro/                  # Five end-to-end flows
└── eas.json                   # EAS build profiles
```

## Implementation patterns

### Errors
Every non-2xx body is `{"detail": string}`: 400 for validation, 401 for auth,
403 for a user outside `ALLOWED_USER_EMAILS` (when set), 404
for missing records, 409 for a duplicate category name. Request-model failures
(for example, a save without `height`) are FastAPI's standard 422, whose `detail`
is a list of `{loc, msg, type}`. Each route re-raises `HTTPException` first, so a
client error raised inside its `try` keeps its status; anything else goes through
`api/errors.py:internal_error`, which returns a fixed `"<action> failed"` 500 and
logs only the action and the exception type. Services let database errors
propagate: only a zero-row result means "not found".

OpenAI clients use a 30 s timeout with one retry (transcription 60 s, no retry),
instead of the SDK's 600 s default.

In the app, `services/api.ts` has one transport. `authedFetch` adds the bearer
token and `X-Device-Id`, aborts after 30 s, on a 401
refreshes the session (falling back to `autoLogin`) and retries once, and retries
a network failure once for GET only. `apiRequest` adds JSON parsing and throws a
single `ApiError` (`status`, `detail`, `kind`) carrying the backend `detail` (a
422 list becomes "height: Field required; weight: ...", each `msg` prefixed with
the last name in its `loc`). It never toasts; the caller shows the error once (`showApiError` in
`utils/errors.ts`, or its own inline state). Reads throw instead of
returning `null` or `[]`, so an outage shows "Couldn't load — tap to retry" on
Search and a retry view on a profile, and only a real 404 means "not found".

### Auth in the app
```typescript
// mobile/services/api.ts
export const getAuthToken = async () => {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    await autoLogin();                     // signs in as demo@sfgov.org
    ({ data: { session } } = await supabase.auth.getSession());
  }
  if (!session) throw new ApiError(0, 'Not signed in. ...', 'auth');
  return session.access_token;
};
```

Every backend call and the assistant WebSocket handshake use this token.

`autoLogin` (`mobile/services/supabase.ts`) keeps one sign-in in flight and hands
it to every caller, so `AuthContext` at launch and `getAuthToken` never race two
`signInWithPassword` calls; once it settles, the next call tries again.
`AuthContext` keeps `loading` true until the launch sign-in settles (a null
`INITIAL_SESSION` doesn't end it). With no user afterwards, `App.tsx` renders a
blocking "Can't sign in" (with the reason) or "Signed out" screen with a
Retry/Sign In button, and mounts `CategoryProvider` and the tabs only once
signed in. `CategoryContext` exposes `error`, and the Categories tab and both
forms show a failed category load with Retry. Sign Out on the Profile tab calls
`supabase.auth.signOut({ scope: 'local' })`, so only this device is signed out
(the default global scope would revoke every phone's session on the shared demo
account), and reports a failure; the next launch signs in again. Only a sign-out
the worker asked for shows "Signed out": any other `SIGNED_OUT` event keeps the
screens mounted and signs in again quietly through the shared `autoLogin`.
After the worker's Sign Out, `getAuthToken` and the 401 retry in `services/api.ts`
never call `autoLogin` (`isSignedOutByUser` in `services/supabase.ts`, cleared by
the next launch, Retry or Sign In), so a request that runs late, such as a delayed
delete committing, fails instead of signing the device back in.

Match-confidence colours mean the same on every screen (`confidenceColor` in
`mobile/utils/duplicateMatches.ts`): 95 and up green, 60-94 yellow.

## Edge cases

- **Recording under 5 s:** an alert asks for more and recording continues.
- **Recording reaches 2:00:** it stops and submits on its own.
- **Missing required fields:** the review form blocks Save and lists them; the
  backend rejects them as well (422 from the request model).
- **Height formats:** "70", "70.5", "5'10", "5 ft 10 in", "5.5 feet", "5, 10",
  "178cm" are all converted to inches before saving, and a bare 1-9 ("6", "5.5")
  means feet (`mobile/utils/height.ts`, matching the backend's
  `parse_height_inches`).
- **Field values:** both forms send typed values (`mobile/utils/fieldValues.ts`):
  numbers as numbers, select labels in the category's case, multi-selects as
  arrays (a quick option toggles membership). Empty fields are not sent, and
  screens skip empty values instead of showing "null".
- **Several duplicate matches:** the backend returns up to 3, best first. Review
  adds its re-check's matches (`topMatches`, at most 3 shown); the merge screen
  opens on the best and "Other possible matches (n)" switches.
- **Create new despite a match:** allowed from the merge UI.
- **Failed save:** the backend's reason (for example "weight: Value 400 exceeds
  maximum of 300") is shown in the form, which keeps its data; problems found by
  `/api/transcribe` (`validation_errors`) or the client checks are shown under
  their fields.
- **No connection:** a recording is queued and uploads when the connection
  returns ("Queued: no connection"). Other requests fail with one error message
  (Search shows "Couldn't load — tap to retry").

## Testing

- **Backend:** `python -m pytest` from the repo root runs the offline suite
  (OpenAI mocked, Supabase faked by `backend/tests/helpers.py`, a fake user for
  auth), the offline evals included (`backend/tests/test_evals.py`). The one live
  test, `backend/tests/integration/test_live_smoke.py`, is read-only and runs only
  when `VOICEREACH_API_URL` and `VOICEREACH_LIVE_TOKEN` are set.
- **Database:** `backend/tests/db/` (marker `db`) calls the real SQL functions on a
  local Postgres. They are skipped unless `SUPABASE_DB_URL` is set, and CI runs
  them. `supabase/check_migrations.sh` applies a schema and then every migration
  twice: CI does it from `schema.sql` and from the pre-hardening schema (ce238db).
- **App:** `npx jest` (component and service tests with mocked native modules)
  and `npx tsc --noEmit`. `mobile/test/releaseConfig.test.ts` keeps the Maestro
  flows and `eas.json` in step with the app.
- **End to end:** `maestro test mobile/.maestro/` on the iOS simulator (by hand,
  no CI job).
- **Load:** `backend/loadtest/locustfile.py` against a backend in fake-OpenAI mode,
  on a local or staging database.

README Testing has the commands.

## Configuration

```bash
# backend/.env (see backend/.env.example)
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...       # server-side database access (legacy: SUPABASE_SERVICE_KEY)
SUPABASE_PUBLISHABLE_KEY=...  # token verification only (legacy: SUPABASE_ANON_KEY)
OPENAI_API_KEY=...
# Optional: ALLOWED_USER_EMAILS, CORS_ALLOW_ORIGINS, RATE_LIMIT_*_PER_MIN and
# RATE_LIMIT_*_TOTAL_PER_MIN, ENABLE_API_DOCS, CHAT_MODEL, TRANSCRIBE_MODEL,
# REALTIME_MODEL, EMBEDDING_MODEL, DUPLICATE_MODEL, LOG_LEVEL, LOG_FORMAT,
# REALTIME_MAX_SESSIONS_PER_USER, REALTIME_MAX_SESSIONS_TOTAL,
# REALTIME_MAX_SESSION_SECONDS, RECORDING_WORKER_CONCURRENCY,
# RECORDING_WORKER_ENABLED, SENTRY_DSN, ENVIRONMENT, VOICEREACH_FAKE_OPENAI
# (load tests only). backend/.env is read at startup: restart after changing it.

# mobile/.env (see mobile/.env.example); EAS builds take these from the EAS environment
EXPO_PUBLIC_API_BASE_URL=http://localhost:8001   # LAN address on a physical phone
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...   # legacy: EXPO_PUBLIC_SUPABASE_ANON_KEY
# Optional: EXPO_PUBLIC_SENTRY_DSN
```

## Known limitations

The first five are deliberate; README "Known limitations (deliberate)" gives the
why and the trigger for change of each.

1. One shared demo account, auto-signed-in; every accepted user can read and
   write every record through the API (`ALLOWED_USER_EMAILS` can limit which
   accounts that is).
2. One backend process: in-memory rate limits and session caps, an in-process
   recording worker.
3. No WebRTC: voice goes through the backend proxy.
4. No multiple organisations.
5. A locally verified token outlives Sign Out until it expires.
6. iOS only: there is no Android build setup.
7. English only.

Also still true (README "Known issues"): categories are create-only; offline is
recording-only; the list search (`GET /api/individuals?search=`) and export read
whole tables and match in Python, demo scale.

## Quick reference

```sql
-- Rough manual search by name or anything in data (unlike the app, this
-- also matches field names such as veteran_status)
SELECT * FROM individuals
WHERE name ILIKE '%john%'
   OR data::text ILIKE '%john%';

-- Interaction history for one person
SELECT * FROM interactions
WHERE individual_id = 'uuid'
ORDER BY created_at DESC;

-- Set an urgency override
UPDATE individuals
SET urgency_override = 75
WHERE id = 'uuid';
```
