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
| `SUPABASE_SERVICE_KEY` | All database access from the routes and services (bypasses RLS) |
| `SUPABASE_ANON_KEY` | Only `api/auth.py`, to verify users' access tokens |
| `OPENAI_API_KEY` | Whisper, GPT-4o, embeddings and the Realtime API |

Then: API at `http://localhost:8001`, interactive docs at `/docs`, health check
at `/health`.

## Layout

```
main.py              App, CORS, router registration, and the realtime WebSocket proxy
api/
  auth.py            get_current_user dependency: verifies the bearer token with Supabase Auth
  transcription.py   POST /api/transcribe
  individuals.py     /api/individuals routes and the background embedding task
  categories.py      /api/categories and GET /api/export
  embeddings.py      /api/embeddings routes
  voice_assistant.py /api/voice-assistant helper routes
services/
  openai_service.py             Whisper, GPT-4o extraction, height parsing, duplicate scoring call
  duplicate_detection_service.py Candidate search + GPT-4o comparison (threshold 60)
  individual_service.py         Save / merge, search, profile, interaction history
  urgency_calculator.py         Urgency score and display score
  validation_helper.py          Required fields and per-type validation
  embedding_service.py          text-embedding-3-large and cosine similarity
  context_service.py            Name extraction and DB context for the assistant
db/models.py         Pydantic request/response models
scripts/backfill_embeddings.py  Embed every individual
tests/               Offline pytest suite; tests/integration/ needs a live backend
```

## Authentication

Every `/api/*` route depends on `get_current_user` (`api/auth.py`), which expects
`Authorization: Bearer <Supabase access token>` and checks it with
`auth.get_user`. Valid tokens are cached for 60 seconds. Missing or invalid
tokens get a 401; there is no demo fallback. The realtime WebSocket checks the
same header before accepting and closes with code 1008 otherwise. Only `GET
/health` and `GET /` are public. The root README shows how to get a token for
curl.

## Endpoints

### Transcription

**`POST /api/transcribe`** — Body: `{"audio_data": "<base64>"}` (a `data:` URL
prefix is stripped) or `{"audio_url": "https://<project>.supabase.co/..."}`
(other hosts are rejected). Loads categories, transcribes with `whisper-1`,
extracts fields with `gpt-4o`, validates, and looks for duplicates. Returns:

```json
{
  "transcription": "...",
  "categorized_data": {"name": "John", "height": 72, "weight": 180, "...": null},
  "missing_required": [],
  "validation_errors": [{"field": "weight", "message": "Value 400 exceeds maximum of 300"}],
  "potential_matches": [{"id": "uuid", "name": "John Doe", "confidence": 87}]
}
```

Nothing is saved. `potential_matches` holds at most one match, with confidence
≥ 60.

### Individuals (`api/individuals.py`, mounted at `/api/individuals`)

**`POST /api/individuals`** — Create a person, or merge into an existing one.

```json
{
  "data": {"name": "John Doe", "height": 72, "weight": 180, "age": 45},
  "merge_with_id": "uuid or omitted",
  "location": {"latitude": 37.78, "longitude": -122.41, "address": "Market St & 5th St"},
  "transcription": "optional",
  "audio_url": "optional"
}
```

`data` must contain `name`, `height` and `weight` (422 otherwise), and is then
validated against the categories (400 with details on failure). A missing merge target is a 404. The
urgency score is computed on every save. A merge **replaces** `data` with what
was posted and logs only the changed fields; a new person's first interaction
logs everything. Returns `{individual, interaction}`. An embedding is generated
in the background.

**`GET /api/individuals`** — Query: `search`, `limit` (1-100, default 20),
`offset`, `sort_by` (`last_seen`, `urgency_score`, `name`), `sort_order`
(`asc`, `desc`). Searches the name and the JSONB data. Returns `{individuals,
total, offset, limit}`; each entry has `display_score`, `last_seen` and an
abbreviated `last_location`.

**`GET /api/individuals/{id}`** — Returns `{individual, recent_interactions}`
(the last 10). 404 if not found — and, currently, also on a database error.

**`GET /api/individuals/{id}/interactions`** — Query: `limit` (default 50),
`offset`. Newest first. Each item has `created_at`, `user_name`,
`transcription`, `location` and `changes`.

**`PUT /api/individuals/{id}/urgency-override`** — Body:
`{"urgency_override": 0-100 or null}`. Returns `urgency_score`,
`urgency_override` and `display_score`. (The app currently writes the override
through Supabase directly instead.)

**`POST /api/individuals/check-duplicates`** — Body: the same field dictionary as
`data` above. Returns `{"potential_matches": [...]}` using the same detection as
transcription. Used by manual entry.

### Categories and export (`api/categories.py`)

**`GET /api/categories`** — Returns `{"categories": [...]}` with `name`, `type`,
`is_required`, `is_preset`, `priority`, `urgency_weight`, `auto_trigger` and
`options`.

**`POST /api/categories`** — Body: `name`, `type` (`text`, `number`,
`single_select`, `multi_select`, `date`, `location`), optional `priority`,
`urgency_weight` (0-100), `auto_trigger`, `is_required`, `options`. Rules:
only `number` and `single_select` may have a weight or auto-trigger;
single-select options are `[{"label": ..., "value": <number>}]`, multi-select
options are strings; names are unique (case-insensitive, 409 otherwise) and are
stored capitalised. Returns 201 with the category. There is no update or delete.

**`GET /api/export`** — CSV of every individual: name, height, weight, urgency
score (the override if set, including 0), last seen (`updated_at`), age, gender,
substance abuse history, medical conditions, veteran status, housing priority
and behavior. 404 if there are no individuals.

### Embeddings (`api/embeddings.py`, prefix `/api/embeddings`)

- **`POST /search`** — `{"query", "top_k": 10, "similarity_threshold": 0.15}`.
  Text matches on name and JSONB first, then semantic matches. See
  [`docs/EMBEDDINGS.md`](../docs/EMBEDDINGS.md).
- **`POST /generate`** — `{"individual_id": "uuid"}`.
- **`POST /generate-all`** — Embed every individual.
- **`GET /status`** — `total_individuals`, `total_embeddings`,
  `coverage_percentage`.

### Voice assistant

- **`WS /api/voice-assistant/realtime/ws`** (in `main.py`) — Proxy to OpenAI's
  `gpt-realtime`. Text messages that name someone in the database get a
  `CONTEXT:` system message injected ahead of them.
- **`POST /api/voice-assistant/transcribe`** — Multipart field `audio`; returns
  `{"transcription", "status"}`. Whisper only.
- **`POST /api/voice-assistant/context`** — `{"message"}`; returns `context`,
  `individuals_found` and `names_detected`.
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
- **`individual_embeddings`** — `individual_id` (unique), `embedding_data`
  (JSONB array of 3072 floats), `embedding_text`, timestamps.

## Testing

```bash
python -m pytest     # from the repo root: 154 passed, 18 skipped
```

The suite is offline: OpenAI and Supabase are mocked, and a fake user stands in
for token verification except in tests marked `real_auth`. The skipped tests in
`tests/integration/` call a running backend; enable them with
`VOICEREACH_INTEGRATION=1` (`VOICEREACH_API_URL` defaults to
`http://localhost:8001`).

## Deployment

Railway builds from the repo root, not this directory:

- `../railway.toml` — build and start command (`python -m uvicorn main:app`)
- `../runtime.txt` — Python 3.11
- `../requirements.txt` — pinned dependencies
- `../main.py` — entrypoint; adds `backend/` to the path and re-exports `backend.main:app`
- `../.railwayignore` — excludes `mobile/` and `docs/`

The original deployment no longer exists.

## Notes

- CORS allows all origins (demo setting).
- Audio is never stored: it arrives inline, goes to a temp file for Whisper and
  is deleted straight after.
- Interactions record the user id from the token, but `user_name` is always
  "Demo User".
- Several handlers make synchronous Supabase calls inside `async` functions, and
  list/search loads whole tables. Fine at demo scale, not beyond it.
