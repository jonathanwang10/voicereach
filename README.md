# VoiceReach

A field-documentation app for San Francisco homeless-outreach workers.

A social worker finishes a street interaction and, instead of typing notes back at
the office, speaks for thirty seconds. The app transcribes the audio, pulls
structured fields out of it (name, height, weight, medical conditions), scores
urgency from those fields, checks whether this person is already in the database,
and either creates a new record or merges into the existing one.

There is also a hands-free voice assistant: the worker can ask "what should I know
before approaching John?" and get an answer grounded in what the database already
holds about that person.

> **Status: hackathon MVP.** This was built in 36 hours as a demo and cleaned up
> afterwards. It works end-to-end against real OpenAI and Supabase, but it keeps
> deliberate shortcuts that are *not* safe for production — see
> [Shortcuts](#shortcuts-taken) at the bottom. It handles what is effectively
> medical data, and any signed-in user can read and write every row.
>
> The original Railway deployment and Supabase project no longer exist. To try
> it, run it locally against your own Supabase project (see [Setup](#setup)).

---

## Repository layout

```
backend/          FastAPI service — all API logic and OpenAI calls
  api/            HTTP routers, one per resource (auth.py is a dependency, not a router)
  services/       Business logic (categorization, dedup, embeddings, urgency)
  db/             Pydantic models
  scripts/        backfill_embeddings.py — the only script
  tests/          pytest suites; tests/integration/ needs a live backend (see Testing)
mobile/           React Native (Expo) app, built and demoed on iOS
  screens/        5 tab screens + the profile screen pushed from Search
  components/     Shared UI
  services/       API + Supabase clients
  config/api.ts   Reads the backend URL and Supabase settings from mobile/.env
supabase/
  schema.sql      ← the database. Run this once. See Setup.
docs/             Architecture, PRD, and feature deep-dives
main.py           Railway entrypoint; re-exports backend.main:app
requirements.txt  Backend dependencies (pinned); requirements-dev.txt adds test tools
```

## How it works

```
                  ┌──────────────────────────────────────────┐
   Expo app ─────▶│ FastAPI (backend/)                       │
                  │                                          │
   1. record m4a  │  POST /api/transcribe   (base64 audio)   │
                  │    ├─ Whisper        → transcript        │
                  │    ├─ GPT-4o         → structured fields │
                  │    └─ GPT-4o         → duplicate check   │
                  │                                          │
   2. save        │  POST /api/individuals                   │
                  │    ├─ urgency score  → computed          │
                  │    └─ embedding      → generated in bg   │
                  │                                          │
   3. ask         │  WS /api/voice-assistant/realtime/ws     │
                  │    └─ proxy to OpenAI Realtime API,      │
                  │       primed with DB context             │
                  └───────────────┬──────────────────────────┘
                                  ▼
                           Supabase Postgres
```

Every request carries the signed-in user's Supabase access token (see
[Auth](#auth)). A few app features skip the backend and talk to Supabase
directly with that session: the default Search list, the manual urgency
override, and delete (`mobile/services/api.ts`). That is why the row-level
security policy matters even though the backend itself uses the service key.

Three separate AI capabilities, easy to confuse:

| Capability | Model | Where |
|---|---|---|
| Transcribe + extract fields | `whisper-1` + `gpt-4o` | `services/openai_service.py` |
| Semantic search over profiles | `text-embedding-3-large` | `services/embedding_service.py` |
| Live spoken assistant | `gpt-realtime` (questions transcribed by `whisper-1`) | `main.py` (the WS proxy); `api/voice_assistant.py` (helper endpoints) |

[`docs/VOICE_PIPELINE.md`](docs/VOICE_PIPELINE.md) walks through the whole
recording-to-save path and the assistant path step by step.

### The data model in one paragraph

`categories` is **schema-as-data**: each row defines a field the app collects
(its type, whether it is required, and how heavily it weighs into the urgency
score). `individuals` holds one row per person with the current aggregated state
in a JSONB `data` column. `interactions` is an append-only log; its `changes`
column holds only what *changed* at each encounter (the whole payload on the
first one), plus the transcript and location. `individual_embeddings` backs
semantic search. Because fields live in `categories` rather than in columns,
adding a new field at runtime does not require a migration.

## Setup

You need Python 3.11, a current Node.js LTS, a Supabase project and an OpenAI API key.

### 1. Database

1. Create a new Supabase project.
2. In the SQL Editor, run **`supabase/schema.sql`** once. That single file is the
   whole schema: tables, indexes, preset categories, six demo individuals with
   one seed interaction each, and the row-level security policies. There is no
   migration chain.
3. In **Authentication → Users → Add user**, create `demo@sfgov.org` with
   password `demo123456` and tick **Auto Confirm User**. The app signs in as
   this user; without it every request fails.

Audio is sent to the backend inline (base64), so no Storage bucket is needed.

#### Upgrading a database created from an older schema.sql

Older versions of `schema.sql` granted the `anon` role full access. To switch an
existing database to the signed-in-only policies, run:

```sql
DROP POLICY "demo all categories"  ON categories;
DROP POLICY "demo all individuals" ON individuals;
DROP POLICY "demo all inter"       ON interactions;
DROP POLICY "demo all embeddings"  ON individual_embeddings;
```

then run the four `CREATE POLICY "signed-in users: …"` statements at the end of
`supabase/schema.sql`.

### 2. Backend

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt        # add -r requirements-dev.txt for tests

cp backend/.env.example backend/.env             # fill in the values below

# Run from inside backend/ -- its modules import each other absolutely
# (e.g. `from services.context_service import ...`), so backend/ must be on
# sys.path. The root main.py shim exists for Railway, not for local dev.
cd backend && python -m uvicorn main:app --reload --port 8001
```

`backend/.env`:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Whisper, GPT-4o, embeddings, Realtime |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_KEY` | All server-side database access (bypasses RLS) |
| `SUPABASE_ANON_KEY` | Used only by `api/auth.py` to verify users' access tokens |

`.env.example` also lists `DEMO_EMAIL`, `DEMO_PASSWORD` and `PORT`; the backend
reads none of them.

Sanity check: `curl localhost:8001/health` should return `{"status":"ok"}`.

### 3. Mobile

```bash
cd mobile
cp .env.example .env      # then fill in the three values
npm install
npx expo start
```

`mobile/.env`:

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Backend URL. Defaults to `http://localhost:8001`, which works in the iOS simulator. On a physical phone use your machine's LAN address, e.g. `http://<your-LAN-IP>:8001` — `localhost` would resolve to the phone. |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL (Project Settings → API) |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |

These are the only settings the app reads (`mobile/config/api.ts`). If the two
Supabase values are missing, the app stops at startup with a "Supabase is not
configured" error. Restart Expo after editing `.env`; the values are inlined at
build time.

The app signs in as the demo user automatically and opens on the Record tab.

### 4. Optional: backfill embeddings

The seeded demo individuals start without embeddings; new and updated
individuals get one automatically in the background. To embed the seed rows (or
anything else that predates that), either call `POST /api/embeddings/generate-all`
or run:

```bash
cd backend && python scripts/backfill_embeddings.py
```

### Auth

Every `/api/*` route except `/health` requires
`Authorization: Bearer <Supabase access token>`. The backend checks the token
with Supabase Auth (`auth.get_user`) and caches a valid result for 60 seconds
(`backend/api/auth.py`). There is no fallback user: a missing or invalid token
gets a 401. The realtime WebSocket checks the same header during the handshake
and closes with code 1008 if it is missing or invalid (`backend/main.py:123-131`).

The app gets its token by signing in as the demo user before its first request
(`getAuthToken` in `mobile/services/api.ts`) and sends it on every call,
including the WebSocket handshake.

To call the API by hand, get a token from the repo root with the venv active:

```bash
TOKEN=$(python - <<'PY'
import os; from dotenv import load_dotenv; from supabase import create_client
load_dotenv('backend/.env')
c = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_ANON_KEY"])
print(c.auth.sign_in_with_password({"email": "demo@sfgov.org", "password": "demo123456"}).session.access_token)
PY
)
curl -H "Authorization: Bearer $TOKEN" localhost:8001/api/categories
```

## API

Base URL `http://localhost:8001`. Everything under `/api` needs a bearer token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check (public) |
| `GET` | `/` | API name (public) |
| `POST` | `/api/transcribe` | Audio → transcript → structured fields → duplicate candidates |
| `POST` | `/api/individuals` | Create a person, or merge into one with `merge_with_id` |
| `GET` | `/api/individuals` | List / text search (`search`, `limit`, `offset`, `sort_by`, `sort_order`) |
| `GET` | `/api/individuals/{id}` | Full profile plus the 10 most recent interactions |
| `GET` | `/api/individuals/{id}/interactions` | Encounter history |
| `PUT` | `/api/individuals/{id}/urgency-override` | Set or clear (`null`) the manual urgency override |
| `POST` | `/api/individuals/check-duplicates` | Duplicate candidates for manually entered data |
| `GET` / `POST` | `/api/categories` | Read / define collected fields |
| `GET` | `/api/export` | CSV of every individual |
| `POST` | `/api/embeddings/search` | Name + JSONB text match, then semantic matches |
| `GET` | `/api/embeddings/status` | Embedding coverage |
| `POST` | `/api/embeddings/generate` | Embed one individual (`{"individual_id": ...}`) |
| `POST` | `/api/embeddings/generate-all` | Embed every individual |
| `WS` | `/api/voice-assistant/realtime/ws` | Realtime assistant proxy (defined in `main.py`) |
| `POST` | `/api/voice-assistant/transcribe` | Whisper-only transcription of an assistant question (multipart `audio`) |
| `POST` | `/api/voice-assistant/context` | DB context for the names in a message |
| `GET` | `/api/voice-assistant/guidelines` | Static safety guidelines |

`POST /api/transcribe` takes `{"audio_data": "<base64, data-URL prefix optional>"}`
or `{"audio_url": "..."}` (which must be on a `*.supabase.co` host,
`services/openai_service.py:44`). The app always sends `audio_data`. It returns
`transcription`, `categorized_data`, `missing_required`, `validation_errors` and
`potential_matches`, and saves nothing.

Interactive docs are at `/docs` when the server is running. Endpoint detail and
request bodies are in [`backend/README.md`](backend/README.md).

### Two rules worth knowing before changing anything

**Urgency score.** Only `number` and `single_select` types may carry an urgency
weight or an auto-trigger — enforced in `db/models.py:155-163`. Each contributing
category adds `normalized_value * weight` to a running sum, where a number is
`min(value / 300, 1.0)` (so it clamps above 300) and a select is its option's
value. The result is then **normalized by the total weight** and scaled:
`int(weighted_sum / total_weight * 100)`. Skipping that last step is the easy
mistake — the per-category term alone is not the score. A category flagged
`auto_trigger` pins the score to 100, but only when it actually fires: for a
single-select, the chosen option's value must be greater than 0 (so the preset
`behavior` field set to "None" does not trigger); for a number, the value must be
non-zero (`services/urgency_calculator.py:7-22`). A manual override is shown
instead of the computed score without overwriting it, and an override of 0 counts
as an override. See `services/urgency_calculator.py`.

**Duplicate detection — the code and the spec disagree here.** The backend
gathers candidates by exact name, partial name and a text scan of the JSONB data,
asks GPT-4o to score the first three 0–100, drops anything below 60
(`services/duplicate_detection_service.py:216`), and returns only the best match.
`docs/PRD.md` calls for an automatic merge at ≥ 95, but **that threshold is not
implemented**: the frontend opens the same field-by-field merge UI for *every*
surviving match (`mobile/components/TranscriptionResults.tsx:150`). The merge UI
defaults each field to the newer value, but the worker can flip any field, or
choose to create a new person instead. Note also that the backend does not merge
server-side — `services/individual_service.py:152` replaces the whole `data`
JSONB with what the client posts, so any field the client omits is dropped.

## Testing

```bash
python -m pip install -r requirements-dev.txt
python -m pytest              # from the repo root
```

Expected: **154 passed, 18 skipped.** The suite runs offline; OpenAI and Supabase
are mocked. The 18 skipped tests are in `backend/tests/integration/` and need a
running backend plus a populated Supabase project. To run them:

```bash
VOICEREACH_INTEGRATION=1 python -m pytest backend/tests/integration
# VOICEREACH_API_URL defaults to http://localhost:8001
```

```bash
cd mobile
npx jest          # 25 tests in 9 suites, all passing
npx tsc --noEmit  # 0 errors
```

## Deployment

`railway.toml` is kept for reference: Railway builds from the repo root and
starts `python -m uvicorn main:app`, and the root `main.py` re-exports
`backend.main:app` so the backend package resolves. Only the backend deploys;
`mobile/` and `docs/` are excluded via `.railwayignore`. The original deployment
has been taken down.

## Documentation

| File | Contents |
|---|---|
| [`backend/README.md`](backend/README.md) | Backend setup and endpoint-by-endpoint detail |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Codebase tour |
| [`docs/VOICE_PIPELINE.md`](docs/VOICE_PIPELINE.md) | Audio → transcript → fields → save, and the assistant path |
| [`docs/EMBEDDINGS.md`](docs/EMBEDDINGS.md) | Semantic search setup and behaviour |
| [`docs/DEMO.md`](docs/DEMO.md) | Demo walkthrough script |
| [`docs/PRD.md`](docs/PRD.md) | The original product spec; see its header for where the code differs |

## Known issues

These are still true:

- **The deployed demo is offline.** Run it locally against your own Supabase
  project.
- **Categories are effectively create-only.** Editing a category in the app only
  changes local state; there is no backend update route
  (`mobile/screens/CategoriesScreen.tsx:205`). The create form does not send
  `urgency_weight` or `auto_trigger` (`CategoriesScreen.tsx:129-130`), so the
  Danger Weight control has no effect.
- **Export CSV in the app does not save the file.** It fetches the CSV from
  `GET /api/export` and shows a success alert, but nothing is written or shared
  (`CategoriesScreen.tsx:66-85`). Use `curl` against the endpoint to get the file.
- **The match list says "Streamlined confirmation" for matches ≥ 95%**
  (`TranscriptionResults.tsx:437`), but Save opens the same merge UI as any other
  match.
- **Undo after delete recreates the person as a new record.** Deleting cascades
  to their interactions, so the restored profile has a new id and no history
  (`mobile/screens/ModernIndividualProfileScreen.tsx:107`).
- **Semantic search ignores custom categories.** The text that gets embedded is
  built from a hardcoded field list (`services/embedding_service.py:50-90`).
  Embeddings are stored as JSONB and compared in Python, and list/search loads
  the whole table; pgvector would be the scalable choice.
- **Search results from the semantic endpoint show "today" as last seen.** The
  endpoint returns no last-seen date, so the app fills in the current time
  (`mobile/services/api.ts:310-312`).
- **`GET /api/individuals/{id}` reports database errors as 404**
  (`services/individual_service.py:394-397`).
- **Not yet re-verified against live services.** After the dependency upgrade,
  the OpenAI and Supabase calls were checked only offline (mocks and
  introspection). Run the curl check in [Auth](#auth) and one recording after
  setup. Sending the `Authorization` header on React Native's WebSocket has not
  yet been confirmed on a physical device.

## Shortcuts taken

Listed explicitly so nobody mistakes them for finished work:

- **Row-level security allows any signed-in user to read and write all rows.**
  The anon key alone sees nothing, but there is no per-agency or per-user
  scoping. A real deployment needs it — this is sensitive personal and medical
  data.
- **Keys were once committed to git history** (in 2025: an OpenAI key and
  Supabase service-role keys for a project that has since been deleted). History
  was not rewritten; those keys are treated as compromised and must stay revoked.
- **One shared demo account, auto-logged-in.** The credentials are hardcoded in
  `mobile/services/supabase.ts`, there is no email verification, and every
  interaction is recorded as "Demo User" (`api/individuals.py:30-34`).
- **CORS allows all origins.**
- **No offline support.** The app requires connectivity throughout.
- Audio is M4A/AAC, **5 s** minimum and 2 min maximum per recording
  (`mobile/components/ModernAudioRecorder.tsx:223`). `docs/PRD.md` says 10 s; the
  code says 5.
