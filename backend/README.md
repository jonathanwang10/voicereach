# VoiceReach backend

FastAPI service for VoiceReach. It owns every OpenAI call (Whisper, GPT-4o,
embeddings, the Realtime proxy) and all server-side database access. The root
[`README.md`](../README.md) covers the whole project; this file is the backend
detail.

## Setup

Prerequisites: Python 3.11, a Supabase project set up as in the root README
(schema plus the demo user), and an OpenAI API key.

```bash
# from the repo root
python3.11 -m venv .venv && source .venv/bin/activate
python -m pip install -r requirements.txt -r requirements-dev.txt
cp backend/.env.example backend/.env    # fill in the values below

cd backend && python -m uvicorn main:app --reload --port 8001
# On a physical phone, start with --host 0.0.0.0 so the device can reach it:
# cd backend && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8001
```

Run uvicorn from inside `backend/`: modules import each other absolutely
(`from services... import ...`), and `load_dotenv()` reads `backend/.env` from the
working directory.

Environment variables (`backend/.env`):

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | Every Supabase client |
| `SUPABASE_SECRET_KEY` | All database access from the routes and services (bypasses RLS); legacy fallback `SUPABASE_SERVICE_KEY` (`db.client.supabase_secret_key`) |
| `SUPABASE_PUBLISHABLE_KEY` | Only `api/auth.py`, to verify users' access tokens; legacy fallback `SUPABASE_ANON_KEY` (`auth.supabase_public_key`) |
| `OPENAI_API_KEY` | Whisper, GPT-4o, embeddings and the Realtime API |
| `ALLOWED_USER_EMAILS` | Optional allowlist of account emails (comma-separated); others get a 403. Unset, or set but empty = any user of the project |
| `CORS_ALLOW_ORIGINS` | Optional comma-separated browser origins (unset = none); the app doesn't need it |
| `RATE_LIMIT_*_PER_MIN` | Optional per-user-and-device limits on the paid or heavy endpoints; `RATE_LIMIT_*_TOTAL_PER_MIN` caps each bucket per process (default 5x). See the root README's Limits |
| `LOG_LEVEL` | Optional backend log level (default `INFO`) |
| `REALTIME_MAX_SESSION_SECONDS` | Optional cap on one realtime assistant connection (default 600) |
| `REALTIME_MAX_SESSIONS_PER_USER`, `REALTIME_MAX_SESSIONS_TOTAL` | Optional caps on open realtime sessions per phone (default 2) and per process (default 20) |
| `ENABLE_API_DOCS` | Optional: `1` serves `/docs`, `/redoc` and `/openapi.json` (unset = off) |
| `CHAT_MODEL`, `TRANSCRIBE_MODEL`, `REALTIME_MODEL`, `EMBEDDING_MODEL`, `DUPLICATE_MODEL` | Optional OpenAI model names (defaults `gpt-4o`, `gpt-transcribe`, `gpt-realtime-2.1`, `text-embedding-3-large`, `gpt-4o-mini`; `services/model_config.py`) |

Then: API at `http://localhost:8001`, health check at `/health`. The interactive
docs (`/docs`, `/redoc`, `/openapi.json`) are off unless `ENABLE_API_DOCS=1`. `backend/.env` is loaded once at startup (`load_dotenv()` never
overwrites a variable that is already set), so restart the backend after
editing it, `ALLOWED_USER_EMAILS` included.

## Layout

```
main.py              App, CORS, router registration, and the realtime WebSocket proxy
api/
  auth.py            get_current_user dependency: verifies the bearer token with Supabase Auth
  transcription.py   POST /api/transcribe
  individuals.py     /api/individuals routes and the background embedding task
  categories.py      /api/categories and GET /api/export
  embeddings.py      /api/embeddings routes
  voice_assistant.py /api/voice-assistant helper routes (only `/guidelines`)
services/
  openai_service.py             Whisper, GPT-4o extraction, duplicate scoring call
  field_registry.py             Field normaliser, category_key, height parsing; labels,
                                embedding text and export columns from the categories
  duplicate_detection_service.py Candidate search + GPT-4o comparison (threshold 60)
  individual_service.py         Save / merge, search, profile, interaction history
  urgency_calculator.py         Urgency score and display score
  validation_helper.py          Normalise, then check required fields
  embedding_service.py          text-embedding-3-large, the text hash and the query cache
  assistant_tools.py            Read-only retrieval tools the realtime proxy runs
db/models.py         Pydantic request/response models
scripts/backfill_embeddings.py  Embed every individual
scripts/rescore_urgency.py      Re-score every individual (run after upgrading)
tests/               Offline pytest suite; tests/integration/ needs a live backend
```

## Authentication

Every `/api/*` route depends on `get_current_user` (`api/auth.py`), which expects
`Authorization: Bearer <Supabase access token>` and checks it with
`auth.get_user`. Valid tokens are cached for 60 seconds. Missing or invalid
tokens get a 401; there is no demo fallback. When `ALLOWED_USER_EMAILS` is set
(comma-separated, case-insensitive, checked on every call), a valid user whose
email isn't listed gets a 403 `{"detail": "This account is not allowed to use
this service"}`; only allowed users are cached. The realtime WebSocket checks
the same header before accepting and refuses the handshake otherwise, which the
client sees as an HTTP 403 (closing before `accept()` can't send a close code).
An Auth outage (503) is accepted and closed with 1011. Only `GET
/health` is public. The root README shows how to get a token for
curl.

## Endpoints

### Transcription

**`POST /api/transcribe`** — **Deprecated** (kept for one release; the app uploads
through `POST /api/recordings`). Both run the same stage functions
(`services/recording_pipeline.py`). Body: `{"audio_data": "<base64>"}` (a `data:` URL
prefix is stripped; the body is capped at 8 MB) or `{"audio_url": "..."}` on the
same host as `SUPABASE_URL` (other hosts are a 400; the download stops at 5 MB
and doesn't follow redirects: a 3xx fails like any other download error, with a
500 "Transcription failed"). Loads categories, transcribes with `TRANSCRIBE_MODEL` (default `gpt-transcribe`, with a fixed SF vocabulary prompt and no person names),
extracts fields with `gpt-4o`, validates, and looks for duplicates. The M4A's
length is read with mutagen before Whisper is called: under 5 s or over 125 s is
a 400 (`RECORDING_LIMITS`).
413 over a size cap, 429 over the rate limit, 504 after 110 s. Returns:

```json
{
  "transcription": "...",
  "categorized_data": {"name": "John", "height": 72, "weight": 180, "...": null},
  "missing_required": [],
  "validation_errors": [{"field": "weight", "message": "Value 400 exceeds maximum of 300"}],
  "potential_matches": [{"id": "uuid", "name": "John Doe", "confidence": 87}],
  "duplicate_check_failed": false
}
```

Nothing is saved. `potential_matches` holds at most one match, with confidence
≥ 60. `duplicate_check_failed` is true when the duplicate search itself failed
(e.g. a database error): the transcript is still returned, but an empty
`potential_matches` then means "unknown", not "no match". An LLM failure is not
a failed check: a name comparison stands in.

### Recordings (`api/recordings.py`, prefix `/api/recordings`)

- **`POST /api/recordings`** — Multipart: `audio` (an M4A; the body is capped at
  8 MB), `client_recording_id` (a UUID the phone makes), `duration_ms` (0-125000,
  bounds-checked only: the server stores its own mutagen measurement) and an
  optional `location` (a JSON `{latitude, longitude, address}` string, at most 2000
  characters). The file must be an M4A of 5 s to 125 s (400 otherwise, before any
  storage or database work). It is stored in the private `recordings` bucket at
  `<client_recording_id>.m4a` (upsert) and a `recordings` row is queued: **202**
  `{"id", "status": "queued"}`. A repeated `client_recording_id` returns the existing
  row (202, no second upload); another user's is a 409. Shares the
  `RATE_LIMIT_TRANSCRIBE_PER_MIN` budget with `/api/transcribe`.
- **`GET /api/recordings/{id}`** — `{id, status, error, result, location,
  duration_ms, created_at}`; `result` is the `/api/transcribe` response once the
  status is `ready`. 404 if it isn't the caller's.
- **`GET /api/recordings?status=`** — The caller's recordings (and this phone's
  only, when `X-Device-Id` is sent), newest first, at most 50, each with the
  extracted `name` when there is one. An unknown status is a 422.
- **`DELETE /api/recordings/{id}`** — Removes the stored file (if any), then the
  row: 204. A failed file removal keeps the row (500), so it can be retried.

### Individuals (`api/individuals.py`, mounted at `/api/individuals`)

**`POST /api/individuals`** — Create a person, or merge into an existing one.

```json
{
  "data": {"name": "John Doe", "height": 72, "weight": 180, "age": 45},
  "merge_with_id": "uuid or omitted",
  "location": {"latitude": 37.78, "longitude": -122.41, "address": "Market St & 5th St"},
  "transcription": "optional",
  "audio_url": "optional",
  "expected_version": "int, optional: the merge target's version when it was loaded"
}
```

Header `Idempotency-Key: <uuid>` (optional; anything else is a 400): a retry
with the same key returns the first save's result with `"replayed": true` and
writes nothing. The save is one `save_individual` SQL transaction (person plus
interaction). A merge with a stale `expected_version` is a 409 `This person was
changed by someone else. Reload and try again.` (without it, the service guards
with the version it reads); `expected_version` without `merge_with_id` is a 422.

The body is capped at 256 KB (413), `transcription` at 20,000 characters and
`data` at 100 fields (422). `data` must contain `name`, `height` and `weight` (422 otherwise), and is then
normalised and validated against the categories (`normalize_individual_data`
in `services/field_registry.py`; 400 with `field: message` details on failure).
Only the normalised data is stored: empty values are dropped, numbers are real
numbers and select labels are canonical. A missing merge target is a 404. The
urgency score is computed on every save. A merge **replaces** `data` with what
was posted and logs only the changed fields; a new person's first interaction
logs everything. Returns `{individual, interaction, replayed}`; `individual`
carries `version`. An embedding is generated in the background (not for a replay).

**`GET /api/individuals`** — Query: `search`, `limit` (1-100, default 20),
`offset`, `sort_by` (`last_seen`, `urgency_score`, `name`), `sort_order`
(`asc`, `desc`). A search matches the name (substring) or any string value /
list item in `data` at a word start ("male" does not match "Female"), never field names (`services/search_matching.match_individual`); name
matches sort before value matches, then `sort_by` orders each group
(`urgency_score` sorts by the display score, `last_seen` by parsed time). Returns
`{individuals, total, offset, limit}`; each entry has `display_score`, `last_seen`
and an abbreviated `last_location`. `last_seen` is the latest interaction's
`created_at`, falling back to the person's `created_at` (never `updated_at`),
fetched by `fetch_last_seen` in chunks of 50 ids per `interactions` query. The
table is read once and matched in memory: demo scale, and the read is capped by
Supabase's API row limit (1000 by default).

**`GET /api/individuals/{id}`** — Returns `{individual, recent_interactions}`
(the last 10). 404 if not found; a database error is a 500.

**`GET /api/individuals/{id}/interactions`** — Query: `limit` (default 50),
`offset`. Newest first. Each item has `created_at`, `user_name`,
`transcription`, `location` and `changes`.

**`PUT /api/individuals/{id}/urgency-override`** — Body:
`{"urgency_override": 0-100 or null}`. Returns `urgency_score`,
`urgency_override` and `display_score`; 404 if absent. It doesn't write
`updated_at` itself; the database trigger `set_updated_at` (in
`supabase/schema.sql`) sets it on every update.

**`DELETE /api/individuals/{id}`** — Deletes the person (FK cascades remove their
interactions and embeddings). Returns
`{"id", "deleted": true}`; 404 if absent, 422 for a bad UUID.

**`POST /api/individuals/check-duplicates`** — Body: the same field dictionary as
`data` above. Returns `{"potential_matches": [...]}` using the same detection as
transcription. Used by manual entry, and by voice review when the worker edited
the fields or the transcribe check failed. A failed check is a 500
(`{"detail": "Duplicate check failed"}`), never an empty list.

### Categories and export (`api/categories.py`)

**`GET /api/categories`** — Returns `{"categories": [...]}` with `name` (the
key used in `data`), `display_name` (the label as typed; may be null for
presets created without one), `type`, `is_required`, `is_preset`, `priority`,
`urgency_weight`, `auto_trigger` and `options`.

**`POST /api/categories`** — Body: `name`, `type` (`text`, `number`,
`single_select`, `multi_select`, `date`, `location`), optional `priority`,
`urgency_weight` (0-100), `auto_trigger`, `is_required`, `options`,
`number_scale_max` (number only, > 0, up to 1,000,000; null = 300). Rules
(`CreateCategoryRequest`, 422 otherwise):
- `name` is stripped (inner whitespace collapsed), 1-50 characters, with at
  least one letter or digit. It is stored as `display_name`, and its
  `category_key` (`"HIV status"` -> `"hiv_status"`) as `name`.
- only `number` and `single_select` may have a weight or auto-trigger, and only
  `number` a `number_scale_max`;
- `single_select` and `multi_select` need at least one option (at most 50).
  Single-select options are `[{"label": ..., "value": <number 0-1>}]`,
  multi-select options are strings. Labels are stripped, non-blank, at most 50
  characters, unique ignoring case, and can't contain commas. Other types
  can't have options.

A category with `urgency_weight > 0` or `auto_trigger` changes everyone's
urgency (every weighted category is in the denominator), so after the insert
`rescore_all_individuals` (`services/individual_service.py`) recomputes every
stored `urgency_score` and writes only the rows that changed (the `updated_at`
trigger bumps them; `urgency_override` is never touched). It reads every row
in pages (`fetch_all`). If the re-score fails, the error type is logged and the 201 stands;
`scripts/rescore_urgency.py` runs the same function, and is also the step to
run after upgrading a database (next to `scripts/backfill_embeddings.py`).

A name whose key equals the key of an existing category's `name` or
`display_name` is a 409 (`"Veteran status"` vs the preset `veteran_status`,
`"Housing-status"` vs `"Housing status"`). Keys are compared in Python, so `%`
and `_` are not wildcards; a concurrent duplicate that reaches the UNIQUE
constraint (Postgres `23505`) is also a 409. Returns 201 with the category
(including `display_name`). There is no update or delete.

**`GET /api/export`** — `text/csv` of every individual. Columns come from
`field_registry.export_columns(categories)`: one per category (Name first, then
required fields, other presets, then custom ones, headed with the category's
label), then "Urgency Score" (`get_display_urgency_score`: the override if set,
including 0) and "Last Seen" (`fetch_last_seen`: the latest interaction, else
`created_at`; never `updated_at`). A category label that repeats one of those
two headers or an earlier column's gets its key appended ("Urgency Score
(urgency_score)"), so headers are distinct. Lists are comma-separated and a location is
its address. A text cell starting with `=`, `+`, `-`, `@`, tab or CR gets a
leading `'` so a spreadsheet won't run it as a formula. No individuals gives a
header-only CSV (200).

### Embeddings (`api/embeddings.py`, prefix `/api/embeddings`)

- **`POST /search`** — `{"query" (≤ 500 chars), "top_k": 10 (1-50),
  "similarity_threshold": 0.15 (0-1)}`; out of range is a 422.
  One call to `search_individuals_hybrid` (Postgres): an exact name match first
  (`search_type: "exact"`, 1.0), then reciprocal-rank fusion of the name
  (`"name"`), full-text (`"value"`) and pgvector semantic (`"semantic"`, its cosine
  similarity) legs. Results carry `score`; the response adds `semantic_used`
  (false when the query is under 3 characters or embedding it failed). See
  [`docs/EMBEDDINGS.md`](../docs/EMBEDDINGS.md).
- **`POST /generate`** — `{"individual_id": "uuid"}`.

All four embedding paths (the save's background task, `/generate`,
`/generate-all`, the backfill script) go through
`EmbeddingService.store_individual_embedding`: the text is
`field_registry.build_embedding_text(individual, categories)` (every category,
labelled, no urgency), and that exact text is stored as `embedding_text`. A
vector of the wrong length is rejected, not stored.
- **`POST /generate-all`** — Embed every individual. One call per user per
  minute by default; `scripts/backfill_embeddings.py` does the same offline.
- **`GET /status`** — `total_individuals`, `total_embeddings`,
  `coverage_percentage`.

### Voice assistant

- **`WS /api/voice-assistant/realtime/ws`** (in `main.py`) — Proxy to OpenAI's
  `REALTIME_MODEL` (default `gpt-realtime-2.1`). The server sets the session once; client frames pass through
  the allowlist in `services/realtime_guard.py` (others get an `event_not_allowed`
  error event). The session declares four read-only tools (`search_people`,
  `get_person`, `recent_interactions`, `most_urgent`; `services/assistant_tools.py`);
  the proxy runs the model's calls on the server and sends each result back as a
  `function_call_output` fenced as REFERENCE DATA (never a `system` message).
  A client can't send `function_call_output` itself. Close codes after `accept()`: 1000
  normal, 1008 session time limit or too many connects, 1011 upstream or Auth
  outage.
- **`GET /api/voice-assistant/guidelines`** — Static safety guidance.

The pipeline end to end is in [`docs/VOICE_PIPELINE.md`](../docs/VOICE_PIPELINE.md).

## Database

`supabase/schema.sql` is the whole schema. The tables the backend uses:

- **`individuals`** — `id`, `name`, `data` (JSONB, every field), `urgency_score`,
  `urgency_override`, `last_location` (JSONB), `created_at`, `updated_at`.
- **`interactions`** — `id`, `individual_id`, `user_id` (TEXT), `user_name`,
  `transcription`, `audio_url`, `location` (JSONB), `changes` (JSONB: only the
  changed fields), `created_at`.
- **`categories`** — `id`, `name`, `display_name`, `type`, `options`,
  `priority`, `urgency_weight`, `auto_trigger`, `is_required`, `is_preset`,
  `is_active`, timestamps.
- **`individual_embeddings`** — `individual_id` (unique), `embedding`
  (pgvector `halfvec(3072)`, HNSW-indexed), `embedding_text`, `model`,
  `text_hash` (sha256 of the text), `source_updated_at`, timestamps.

Row-level security is on with no policies, so only the service key can touch
these tables. A `set_updated_at` trigger maintains `updated_at` on
`individuals`, `categories` and `individual_embeddings`; `urgency_override`
has a 0-100 `CHECK`, and `urgency_score`, `interactions.individual_id` and
`interactions.user_name` are `NOT NULL`.

## Testing

```bash
python -m pytest     # from the repo root
```

CI also runs `ruff check backend --select F,E9` (rules in `../ruff.toml`).

The suite is offline: OpenAI is mocked, Supabase is faked (`tests/helpers.py`:
the strict `FakeSupabase` raises on any query a test didn't script and records
every insert/update payload), and a fake user stands in for token verification
except in tests marked `real_auth`. `tests/conftest.py` resets rate limits, the
token cache, the shared clients and `app.dependency_overrides` around
every test. Tests are named by subject (`test_individuals_routes.py`,
`test_transcribe_route.py`, `test_schema_contract.py`, ...).

The skipped tests are `tests/integration/test_live_smoke.py`, a read-only smoke
test against a running backend. It runs only when `VOICEREACH_API_URL` and
`VOICEREACH_LIVE_TOKEN` (a real Supabase access token) are both set.

## Deployment

Railway builds from the repo root, not this directory:

- `../railway.toml` — build and start command (`python -m uvicorn main:app`),
  and `/health` as the deploy healthcheck (`healthcheckPath` under `[deploy]`)
- `../.python-version` — Python 3.11
- `../requirements.txt` — pinned dependencies
- `../main.py` — entrypoint; adds `backend/` to the path and re-exports `backend.main:app`
- `../.railwayignore` — excludes `mobile/` and `docs/`

The original deployment no longer exists.

## Limits

Size caps (`BODY_LIMITS` in `main.py`, plus the route checks) give a 413
`{"detail": ...}`: `/api/transcribe` body 8 MB, `audio_url`
download 5 MB, `check-duplicates` body 20 KB. A saved `name` is at most 200
characters (422).

Per-account rate limits (`services/rate_limit.py`, keyed by the user id, a fixed
60 s window in memory, per process) give a 429 with `Retry-After`. Every phone on
the shared demo account shares one budget. Each is read from its env var on every
request; a missing or invalid value uses the default:

| Env var | Default / min | Applies to |
|---|---|---|
| `RATE_LIMIT_TRANSCRIBE_PER_MIN` | 30 | `POST /api/transcribe` |
| `RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN` | 60 | `POST /api/embeddings/search` |
| `RATE_LIMIT_EMBEDDINGS_GENERATE_PER_MIN` | 30 | `POST /api/embeddings/generate` |
| `RATE_LIMIT_GENERATE_ALL_PER_MIN` | 1 | `POST /api/embeddings/generate-all` |
| `RATE_LIMIT_DUPLICATE_CHECK_PER_MIN` | 30 | `POST /api/individuals/check-duplicates` |
| `RATE_LIMIT_WS_CONNECT_PER_MIN` | 10 | the realtime WebSocket (close 1008) |

## Notes

- CORS: browser origins come from `CORS_ALLOW_ORIGINS` (comma-separated; unset
  means none), never with credentials. The mobile app is unaffected.
- Errors: every non-2xx body is `{"detail": string}`. A 500 says only
  `"<action> failed"` (`api/errors.py:internal_error`); the log records the
  exception type, not its message.
- OpenAI calls time out after 30 s with one retry; Whisper gets 60 s and no
  retry. `/api/transcribe` chains up to ~180 s of OpenAI time, so the route has
  its own 110 s deadline (504) to answer before the app's 120 s timeout.
- Audio is not stored by the backend: it arrives inline, goes to a temp file for
  Whisper and the file is deleted on every path (`openai_service.temp_audio_file`).
  It does leave the system: the audio goes to OpenAI, and so do transcripts,
  duplicate candidates' records and the assistant's tool results. The transcript is
  saved with the interaction. See "Data leaving the system" in the root README.
- Logging: Python `logging` at `LOG_LEVEL` (default `INFO`), configured in
  `main.configure_logging`. Logs carry lifecycle events, counts, ids and error
  types only, never names, transcripts, questions, field values, GPS or a
  person's urgency, and never exception messages. HTTP-client and SDK loggers
  (`QUIET_LIBRARY_LOGGERS`) stay at `WARNING` because they log request URLs and
  bodies. uvicorn's access log drops query strings (`DropQueryString`). There are
  no `print` calls outside `scripts/`; `tests/test_no_pii_logs.py` enforces both.
- Interactions record the user id from the token, but `user_name` is always
  "Demo User".
- Several handlers make synchronous Supabase calls inside `async` functions, and
  list, search and export load whole tables, each read capped by Supabase's API
  row limit (1000 by default). Fine at demo scale, not beyond it.
