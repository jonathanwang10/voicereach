# VoiceReach

![CI](https://github.com/jonathanwang10/voicereach/actions/workflows/ci.yml/badge.svg)

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
  scripts/        backfill_embeddings.py, rescore_urgency.py — run after upgrading
  tests/          pytest suites; tests/integration/ needs a live backend (see Testing)
mobile/           React Native (Expo) app, iOS only; mobile/ios/ is the committed (prebuilt) Xcode project
  screens/        5 tab screens + the profile screen pushed from Search
  components/     Shared UI
  services/       API + Supabase clients
  config/api.ts   Reads the backend URL and Supabase settings from mobile/.env
supabase/
  schema.sql      ← the database (full current schema for a fresh install). See Setup.
  seed.sql        Optional demo people; run after schema.sql, never on production
  migrations/     Numbered, idempotent upgrades for an existing database, in filename order
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
                  │       with read-only retrieval tools     │
                  └───────────────┬──────────────────────────┘
                                  ▼
                           Supabase Postgres
```

Every request carries the signed-in user's Supabase access token (see
[Auth](#auth)). All app data access goes through these backend routes
(`mobile/services/api.ts`): the Search list, the manual urgency override and
delete included. The app's Supabase client is used only to sign in, and the
backend reads and writes the tables with the service key.

**Deleting a person** (profile screen, trash icon) has a short undo window. The
person disappears from Search at once and a "Tap to undo" toast shows for about
5 seconds; the real `DELETE /api/individuals/{id}` is sent only when that
window ends (`mobile/utils/delayedDelete.ts`). Undo cancels it. While a delete
is pending, Search doesn't toast a failed background refresh, so the undo toast
stays up. If the DELETE fails, the person reappears in Search and an error toast says so. The pending
delete lives only in memory, so **if the app is closed or killed within those
5 seconds, the person is not deleted.** Once sent, the delete is permanent: it
cascades to the person's interactions and embedding. Deleting a person
hard-deletes their history; that is the deliberate right-to-deletion choice.

"Last seen", everywhere in the app, is the backend's `last_seen`: the latest
interaction, else when the record was created. It is shown in whole days, with
"today" for anything in the last 24 hours.

Three separate AI capabilities, easy to confuse:

| Capability | Model (env var) | Where |
|---|---|---|
| Transcribe + extract fields | `gpt-transcribe` (`TRANSCRIBE_MODEL`, with a fixed SF place/street vocabulary prompt, no person names) + `gpt-4o` (`CHAT_MODEL`, Structured Outputs) | `services/openai_service.py`, `services/category_schema.py` |
| Score duplicate candidates | `gpt-4o-mini` (`DUPLICATE_MODEL`) | `services/duplicate_detection_service.py` |
| Semantic search over profiles | `text-embedding-3-large` (`EMBEDDING_MODEL`) | `services/embedding_service.py` |
| Live spoken assistant | `gpt-realtime-2.1` with server-side read-only retrieval tools (`REALTIME_MODEL`); the worker's speech streamed as PCM16 over the proxy; input transcription (`TRANSCRIBE_MODEL`) for the bubble | `main.py` (the WS proxy); `api/voice_assistant.py` (helper endpoints) |

The model names live in `backend/services/model_config.py`; each env var
overrides its default (blank or unset = the default).

[`docs/VOICE_PIPELINE.md`](docs/VOICE_PIPELINE.md) walks through the whole
recording-to-save path and the assistant path step by step.

### The data model in one paragraph

`categories` is **schema-as-data**: each row defines a field the app collects
(its type, whether it is required, and how heavily it weighs into the urgency
score). `individuals` holds one row per person with the current aggregated state
in a JSONB `data` column. `interactions` is the encounter log: the app only ever
adds to it, and the database refuses any edit to an interaction (a trigger;
deleting a person deletes their interactions too), and its `changes`
column holds only what *changed* at each encounter (the whole payload on the
first one), plus the transcript and location. `individual_embeddings` backs
semantic search. `duplicate_decisions` records, for each save made from the merge
screen, which match was shown, its confidence, and whether the worker merged or
saved new: labels for the duplicate eval. Because fields live in `categories` rather than in columns,
adding a new field at runtime does not require a migration.

**Creating a category** (Categories tab, or `POST /api/categories`). The name
you type (1–50 characters, at least one letter or digit) is kept as the label
(`display_name`, e.g. "HIV status"); its key (`category_key`: lower case,
spaces and hyphens to `_`, e.g. `hiv_status`) is stored as `name` and used in
every person's `data`. A name whose key matches an existing category is
rejected (409), so "Veteran status" can't duplicate the preset. Single- and
multi-select fields need options, typed comma-separated; for single-select,
`Label=0.5` gives an option a value from 0 to 1 (default 0), which is the share
of the category's weight it adds to urgency. The weight box (0–100) appears for
number and single-select fields only. A number field also has an optional
"Scale max": the value that counts as its full weight (blank means 300; for
"days without food", 10 makes 5 days half the weight). A "Sensitive" toggle marks
health or similar information; a name whose key matches
`hiv|medical|substance|mental|diagnos|pregnan` is flagged automatically. A
sensitive category can't have a weight or auto-trigger (400 "Sensitive fields
can't affect urgency."). Categories are create-only, so changing the flag later
is a SQL edit. A weighted or auto-trigger category
changes everyone's urgency (every weighted category is in the denominator), so
creating one re-scores every stored person, every row, in the background after
the create is answered (`rescore_all_individuals`; only changed scores are
written, 500 at a time through the `rescore_batch` SQL function; overrides are
kept, and a person saved meanwhile is skipped rather than overwritten). Every category, custom ones
included, becomes an export column, part of each person's semantic-search text,
and a field the voice assistant is shown (`services/field_registry.py`).

**Export CSV** (Categories tab) writes the file to the app's cache and opens the
share sheet, so the worker chooses where it goes; the cached copy is deleted
when the sheet closes. Columns: one per category, then "Urgency Score" (the
override if set) and "Last Seen". Cells that a spreadsheet would run as a
formula (starting `=`, `+`, `-`, `@`) are prefixed with `'`. An empty database
gives a header-only file.

## Setup

You need Python 3.11, a current Node.js LTS, a Supabase project and an OpenAI API key.

### 1. Database

1. Create a new Supabase project.
2. In the SQL Editor, run **`supabase/schema.sql`**. That file is the whole
   current schema: tables, constraints, indexes, an `updated_at` trigger,
   preset categories, and row-level security switched on with **no policies**.
   It inserts no people. Then, optionally, run **`supabase/seed.sql`** for six
   demo individuals with one seed interaction each (demo only, never on
   production). `seed.sql` is safe to run again: it never duplicates the seed
   people or adds seed history to anyone who already has some. Seed people are
   matched by name, though, so running it again re-adds a demo person you
   deleted (or renamed).
3. In **Authentication → Users → Add user**, create `demo@sfgov.org` with
   password `demo123456` and tick **Auto Confirm User**. The app signs in as
   this user; without it every request fails.
4. In **Authentication** settings, disable new user sign-ups and keep
   anonymous sign-ins disabled. The backend accepts any user of the project,
   and the demo credentials are public in this repo. To restrict it to named
   accounts as well, set `ALLOWED_USER_EMAILS` in `backend/.env` (see below).

Only the backend reads or writes the tables, using the service key, which
bypasses row-level security. With RLS on and no policies, the anon key and
every user's own token get nothing: a direct `select` returns no rows, and
inserts, updates and deletes are refused. The app uses Supabase for sign-in
only.

Audio is sent to the backend inline (base64), so no Storage bucket is needed.

#### Upgrading a database created from an older schema.sql

Apply `supabase/migrations/*.sql` in filename order (each file is idempotent).
Re-running the current `supabase/schema.sql` also works. On an existing database it:

- drops every policy earlier versions created, leaving RLS on with none;
- adds `NOT NULL` to the timestamp, flag, weight and score columns (the
  `ALTER COLUMN ... SET NOT NULL` lines; columns such as `individuals.data`
  and `interactions.changes` are `NOT NULL` only on a fresh install) and the
  `CHECK (urgency_override BETWEEN 0 AND 100)` constraint, after filling NULLs with the column defaults, clamping
  out-of-range overrides, and deleting interactions that have no individual
  (no route can reach those);
- adds the `updated_at` trigger and swaps the old indexes for the ones the
  queries use;
- inserts nothing that already exists. (Re-running `seed.sql` also recomputes
  the urgency score of a seed person while their data is still exactly the seed
  data.)

Then rebuild everyone's embeddings (step 4 below: `POST /api/embeddings/generate-all`
or `backend/scripts/backfill_embeddings.py`). The embedding text is now built
from the categories (`build_embedding_text`), and vectors made by an older
version still describe the old text (custom fields missing, for instance)
until they are regenerated.

Also re-score everyone's urgency: `cd backend && python scripts/rescore_urgency.py`.
The SQL re-scores only untouched seed rows (`seed.sql`), so every other person keeps a
score from the older maths until re-saved. The script recomputes each stored
`urgency_score` with the current categories and writes only the rows that
changed (the `updated_at` trigger bumps those rows); `urgency_override` is never
touched. It reads every row: whole-table reads page past Supabase's API row
limit (`fetch_all` in `backend/db/client.py`), and writes in batches of 500
through `rescore_batch` (migration `20261102000005`, so apply the migrations first).

The SQL Editor may ask you to confirm because the file contains `DROP` and
`DELETE` statements. If you only want to close direct table access, this is
the part that does it:

```sql
DROP POLICY IF EXISTS "Allow all operations on categories"   ON categories;
DROP POLICY IF EXISTS "Allow all operations on individuals"  ON individuals;
DROP POLICY IF EXISTS "Allow all operations on interactions" ON interactions;
DROP POLICY IF EXISTS "demo all categories"  ON categories;
DROP POLICY IF EXISTS "demo all individuals" ON individuals;
DROP POLICY IF EXISTS "demo all inter"       ON interactions;
DROP POLICY IF EXISTS "demo all embeddings"  ON individual_embeddings;
DROP POLICY IF EXISTS "signed-in users: categories"   ON categories;
DROP POLICY IF EXISTS "signed-in users: individuals"  ON individuals;
DROP POLICY IF EXISTS "signed-in users: interactions" ON interactions;
DROP POLICY IF EXISTS "signed-in users: embeddings"   ON individual_embeddings;
```

Afterwards, this should return no rows:

```sql
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('categories', 'individuals', 'interactions', 'individual_embeddings');
```

### 2. Backend

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt        # add -r requirements-dev.txt for tests

cp backend/.env.example backend/.env             # fill in the values below

# Run from inside backend/ -- its modules import each other absolutely
# (e.g. `from services.retrieval import ...`), so backend/ must be on
# sys.path. The root main.py shim exists for Railway, not for local dev.
cd backend && python -m uvicorn main:app --reload --port 8001
# On a physical phone, start with --host 0.0.0.0 so the device can reach it:
# cd backend && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8001
```

`backend/.env`:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Whisper, GPT-4o, embeddings, Realtime |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_KEY` | All server-side database access (bypasses RLS) |
| `SUPABASE_ANON_KEY` | Used only by `api/auth.py` to verify users' access tokens |
| `ALLOWED_USER_EMAILS` | Optional. Comma-separated emails (case-insensitive) allowed to use the API, e.g. `demo@sfgov.org`. When set, any other signed-in user gets a 403. Unset, or set but empty, means every user of the Supabase project is accepted. Checked on every request, but `backend/.env` is loaded at startup, so restart the backend after changing it. |
| `CORS_ALLOW_ORIGINS` | Optional. Comma-separated browser origins allowed to call the API (for example a web dashboard). Unset means none. The mobile app is not a browser and does not need it. Credentials (cookies) are never allowed; auth is a bearer header. |
| `RATE_LIMIT_*_PER_MIN` | Optional. Per-account limits on the endpoints that cost OpenAI money; see [Limits](#limits) for the names and defaults. |
| `REALTIME_MAX_SESSION_SECONDS` | Optional. How long one voice-assistant connection may stay open (default 600). |
| `LOG_LEVEL` | Optional. The backend's own log level (default `INFO`). HTTP-client and SDK loggers stay at `WARNING` regardless; see [Data leaving the system](#data-leaving-the-system). |

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
| `EXPO_PUBLIC_API_BASE_URL` | Backend URL. Defaults to `http://localhost:8001`, which works in the iOS simulator. On a physical phone use your machine's LAN address, e.g. `http://<your-LAN-IP>:8001` — `localhost` would resolve to the phone, and uvicorn must be started with `--host 0.0.0.0`. |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL (Project Settings → API) |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |

These are the only settings the app reads (`mobile/config/api.ts`). If the two
Supabase values are missing, the app stops at startup with a "Supabase is not
configured" error. Restart Expo after editing `.env`; the values are inlined at
build time.

The app signs in as the demo user automatically and opens on the Record tab.
If that sign-in fails (the demo user is missing, or Supabase is unreachable), it
shows a "Can't sign in" screen with the reason and a Retry button instead of the
tabs. The Profile tab shows the signed-in account's email and last sign-in time.
**Sign Out** there really ends the session on that device (other phones on the
shared demo account stay signed in): the app shows a "Signed out" screen with a
Sign In button, and it **signs in again automatically the next time it
starts**. Until then no request signs in on its own: a delete still in its undo
window when the worker signs out fails ("the profile was kept"). If the session ends any other way (a failed refresh, for example), the
app signs in again quietly without leaving the current screen.

The app is **iOS only** (there is no Android script, Maps key or testing).
Expo Go from the App Store may only support the latest Expo SDK; this app uses
SDK 53, so a physical device may need a development build
(`npx expo run:ios --device`). The simulator works with `npx expo start`.
`mobile/ios/` is committed, already prebuilt: `npx expo run:ios` builds it as
it is, so a change to `app.json` (permissions, Info.plist strings, plugins)
reaches the iOS build only after `npx expo prebuild --platform ios`; review
that diff before committing it.

**After pulling, rebuild any existing development build** (`npx expo run:ios`):
CSV export added the native module `expo-sharing`. An older build still opens,
but Export CSV fails with "Rebuild it" until you rebuild.

### 4. Backfill embeddings (needed for semantic search)

The seeded demo individuals (`seed.sql`) start without embeddings, so a descriptive search
("veteran with heart disease") finds nothing among them until you run this;
new and updated individuals get one automatically in the background. To embed
the seed rows (or anything else that predates that, or after
[upgrading](#upgrading-a-database-created-from-an-older-schemasql)), run:

```bash
cd backend && python scripts/backfill_embeddings.py --stale   # only what's missing or changed
cd backend && python scripts/backfill_embeddings.py           # re-embed everyone
```

`--stale` embeds people and visit transcripts that have no vector, one from
another model, or whose text changed; `POST /api/embeddings/generate-all` is the
in-app equivalent of `--stale`. After flipping a category's sensitive flag or
editing a category label, run `--stale`; until then the old vector and text stay.
Embeddings go out in batches of up to 100 texts.

### Auth

Every `/api/*` route except `/health` requires
`Authorization: Bearer <Supabase access token>`. The backend checks the token
with Supabase Auth (`auth.get_user`) and caches a valid result for 60 seconds
(`backend/api/auth.py`). There is no fallback user: a missing, empty or invalid
token gets a 401. If `ALLOWED_USER_EMAILS` is set, a valid user whose email is
not on it gets a 403 `{"detail": "This account is not allowed to use this
service"}`; the list is checked on every request, cached tokens included. The
realtime WebSocket checks the same header during the handshake and refuses it if
the token is missing or invalid, or the user isn't allowed; the client sees that
as an **HTTP 403** on the upgrade, not a WebSocket close code
(`websocket_realtime_proxy` in `backend/main.py`). If Supabase Auth itself is
unreachable, the socket is accepted and closed with 1011.

The app signs in as the demo user at launch and shows no tabs until that sign-in
settles (`AuthContext`). Every sign-in shares one in-flight attempt (`autoLogin`
in `mobile/services/supabase.ts`), so the launch sign-in and a request that needs
a token never race. The token (`getAuthToken` in `mobile/services/api.ts`) goes
on every call, including the WebSocket handshake. On a 401 the app refreshes the session (or
signs in again if the refresh fails) and retries the request once (`authedFetch`).

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
| `GET` | `/api/individuals` | List / text search (`search`, `limit`, `offset`, `sort_by`, `sort_order`). A search matches the name or any data *value* (never field names; see [Search](#search)); name matches sort first. `last_seen` is the latest interaction (else `created_at`). Matching is in memory over the whole table (demo scale; see [Search](#search)) |
| `GET` | `/api/individuals/{id}` | Full profile plus the 10 most recent interactions |
| `GET` | `/api/individuals/{id}/interactions` | Encounter history |
| `DELETE` | `/api/individuals/{id}` | Delete a person (cascades interactions and embeddings); 404 if absent |
| `PUT` | `/api/individuals/{id}/urgency-override` | Set or clear (`null`) the manual urgency override |
| `POST` | `/api/individuals/check-duplicates` | Duplicate candidates for manually entered data |
| `GET` / `POST` | `/api/categories` | Read / define collected fields |
| `GET` | `/api/export` | CSV of every individual |
| `POST` | `/api/embeddings/search` | Hybrid search in Postgres (`search_individuals_hybrid`): exact name first, then fused name/full-text/semantic rank |
| `GET` | `/api/embeddings/status` | Embedding coverage |
| `POST` | `/api/embeddings/generate` | Embed one individual (`{"individual_id": ...}`) |
| `POST` | `/api/embeddings/generate-all` | Embed every stale person and visit (as `backfill_embeddings.py --stale`) |
| `WS` | `/api/voice-assistant/realtime/ws` | Realtime assistant proxy (defined in `main.py`) |
| `GET` | `/api/voice-assistant/guidelines` | Static safety guidelines |

`POST /api/transcribe` takes `{"audio_data": "<base64, data-URL prefix optional>"}`
or `{"audio_url": "..."}` (which must be on the same host as `SUPABASE_URL`;
the download stops at 5 MB, `OpenAIService.transcribe_audio`). The app always
sends `audio_data`. It returns `transcription`, `categorized_data`,
`missing_required`, `validation_errors` and `potential_matches`, and saves
nothing. It answers within 110 s (`TRANSCRIBE_DEADLINE_SECONDS`), with a 504 if
OpenAI is that slow, so the app's 120 s timeout never fires first.

### Limits

Anyone who can sign in can spend the owner's OpenAI credit, so the paid surfaces
are bounded. All of these are per process and in memory (they reset on restart).

| Limit | Value | Over it |
|---|---|---|
| `POST /api/transcribe` body (base64 audio) | 8 MB | 413 |
| `audio_url` download | 5 MB, same host as `SUPABASE_URL` | 413; another host or a missing file 400; a redirect is not followed and fails like any other download error, with a 500 |
| Recording length (read from the M4A header with mutagen) | 5 s to 125 s (2:00 plus 5 s slack) | 400 "Audio must be at least 5 seconds long" / "Audio must be less than 2 minutes"; an unreadable M4A is 400 "File is not in M4A format" |
| Assistant question length | 1 s to 60 s | 400 "Question must be at least 1 second long" / "Question must be under 1 minute" |
| `POST /api/individuals/check-duplicates` body | 20 KB, a JSON object | 413 / 422 |
| `POST /api/individuals` body (a save or merge) | 256 KB; `transcription` ≤ 20,000 chars; `data` ≤ 100 fields | 413 / 422 |
| `POST /api/embeddings/search` | `query` ≤ 500 chars, `top_k` 1–50, `similarity_threshold` 0–1 | 422 |
| A saved `name` | 200 characters | 422 |
| Realtime client frame | 1 MB; only the allowed event types (below) | error event, frame dropped |
| Realtime session | `REALTIME_MAX_SESSION_SECONDS` (600) | close 1008 |
| Open realtime sessions | `REALTIME_MAX_SESSIONS_PER_USER` (2, per user + `X-Device-Id`), `REALTIME_MAX_SESSIONS_TOTAL` (20, per process) | close 1008 "Too many voice sessions open. Close one and try again." |

Requests per minute (a fixed 60 s window; a 429 carries `Retry-After`). Each
window is keyed on the user id plus the phone's `X-Device-Id` header when it sends
one, so one phone can't use up the shared demo account's budget; without the header
the key is the user id. Every bucket also has a per-process total across all keys:
`RATE_LIMIT_<NAME>_TOTAL_PER_MIN` (for example `RATE_LIMIT_SAVE_TOTAL_PER_MIN`),
default 5 times the per-device limit. The windows live in memory, which is
deliberate while the backend runs as one process (several processes would each
allow the full limit). Set the env var to a positive integer to change one:

| Env var | Default | Route |
|---|---|---|
| `RATE_LIMIT_TRANSCRIBE_PER_MIN` | 30 | `POST /api/transcribe` |
| `RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN` | 60 | `POST /api/embeddings/search` |
| `RATE_LIMIT_EMBEDDINGS_GENERATE_PER_MIN` | 30 | `POST /api/embeddings/generate` |
| `RATE_LIMIT_GENERATE_ALL_PER_MIN` | 1 | `POST /api/embeddings/generate-all` |
| `RATE_LIMIT_DUPLICATE_CHECK_PER_MIN` | 30 | `POST /api/individuals/check-duplicates` |
| `RATE_LIMIT_WS_CONNECT_PER_MIN` | 10 | `WS /api/voice-assistant/realtime/ws` (close 1008) |
| `RATE_LIMIT_SAVE_PER_MIN` | 30 | `POST /api/individuals` (save and merge; each starts an embedding call) |
| `RATE_LIMIT_CATEGORY_CREATE_PER_MIN` | 10 | `POST /api/categories` (a weighted category re-scores everyone) |
| `RATE_LIMIT_DELETE_PER_MIN` | 30 | `DELETE /api/individuals/{id}` |

The realtime proxy is not an open relay: the server sets the session (instructions,
voice, tools) once, and a client may send only `input_audio_buffer.append` /
`commit` / `clear`, `conversation.item.create` (a `user` message with `input_text`
or `input_audio` parts), `response.create` (any `response` overrides are
stripped), `response.cancel` and a typed `conversation.item.truncate` (barge-in).
Anything else, `session.update` and `function_call_output` included, is
dropped and answered with `{"type": "error", "error": {"code":
"event_not_allowed", ...}}` (`services/realtime_guard.py`). Database records reach
the model only as the output of the server's read-only tools
(`services/assistant_tools.py`), fenced as REFERENCE DATA that the session
instructions say never to obey.

Interactive docs are at `/docs` when the server runs with `ENABLE_API_DOCS=1` (off by default). Endpoint detail and
request bodies are in [`backend/README.md`](backend/README.md).

### Two rules worth knowing before changing anything

**Urgency score.** Only `number` and `single_select` types may carry an urgency
weight or an auto-trigger — enforced in `CreateCategoryRequest`
(`db/models.py`). Each category with a value adds `normalized_value * weight` to
a running sum, where a number is `min(max(value, 0) / (number_scale_max or 300), 1.0)`
(so it clamps above the scale) and a select is its option's value. Each number
category sets its own scale ("Scale max" when creating it; blank means 300). The result is then **normalized
by the total weight** and scaled: `int(weighted_sum / total_weight * 100)`,
clamped to 0–100. The total weight is the sum of `urgency_weight` over **every**
`number`/`single_select` category with a weight above 0, whether or not the
person has a value for it: a missing value counts as 0 rather than leaving the
denominator. So stating a benign fact ("behavior: None") never moves the score.
Skipping the normalization step is the easy mistake — the per-category term
alone is not the score. A category flagged `is_sensitive` (health and similar
information, H2-3.8) never scores or auto-triggers, whatever its stored weight.
A category flagged `auto_trigger` pins the score to 100,
but only when it actually fires: for a single-select, the chosen option's value
must be greater than 0 (so the preset `behavior` field set to "None" does not
trigger); for a number, the value must be non-zero. A NULL weight counts as 0,
and an empty or non-numeric value never raises. A manual override is shown
instead of the computed score without overwriting it, and an override of 0
counts as an override. See `calculate_urgency_score` in
`services/urgency_calculator.py`.

**Field values are normalised on the server.** `normalize_individual_data`
(`services/field_registry.py`) runs on GPT output in `/api/transcribe` (whose
`categorized_data` is the normalised dict, with any problems listed in
`validation_errors`) and on every `POST /api/individuals` before the change diff
and the urgency calculation. Keys are matched case- and spacing-insensitively to
category names (`category_key`); `null`, `""`, whitespace and `[]` are dropped;
numbers become `int`/`float` (negative is an error, height and weight above 300
are errors); select labels are matched case-insensitively to the canonical label;
a multi-select string is split on commas, and the labels come back in the
category's option order, so re-ordering a selection is never logged as a change;
names are stripped. Height goes through `parse_height_inches`: a bare numeric
*string* from 1 to 9 ("6", "5.5") is feet, while a JSON number is already inches
(so normalising twice is harmless); "5'10", "5′10″", "5 ft 10", "5.5 feet",
"5, 10", "178 cm" and "1.78 m" are understood; any other number is inches. A
small number GPT returns for height (e.g. `6`) is converted from feet in
`parse_extraction` (`services/category_schema.py`), where it first enters.
Extraction uses a strict JSON schema built from the categories: every value
comes with its evidence (the transcript words it came from), and a value whose
evidence isn't in the transcript is dropped, so nothing is inferred.
Keys that match no category are kept, after the same cleaning.
The app sends the same shapes (`mobile/utils/fieldValues.ts`): typed numbers,
height already in inches, canonical labels and multi-select arrays, with empty
fields left out, and its screens skip empty values rather than showing "null".

**Duplicate detection — the code and the spec disagree here.** The backend
gathers candidates with one call to the SQL function `find_duplicate_candidates`:
a trigram or name-token match (words of 3+ characters, so "John Doe" finds
"John" and "Jon Smith" finds "John Smith"), plus a data value that starts a word
with the name (an "aka") among the 200 most recently updated people (values
only, never field names), ranks them by tokens matched (with sound-alikes and
close spellings: metaphone and Jaro-Winkler) and height/weight closeness, asks
`DUPLICATE_MODEL` (default `gpt-4o-mini`, temperature 0) to score the top 8
0–100 from name, aka, age, height, weight, gender and the last-seen street area
only (never medical or other sensitive fields), drops anything below 60, and
returns the top 3, best first (`services/duplicate_detection_service.py`). Voice review adds the match from
its own re-check to the server's (`topMatches`: de-duplicated, best first, at
most 3 shown). The merge screen opens on the best match; "Other possible matches
(n)" switches to one of the others. If GPT-4o fails, a name comparison
stands in; if the search itself fails, the app is told
(`duplicate_check_failed`, or a 500 from `check-duplicates`) and asks
"Duplicate check unavailable. Save as new anyway?" rather than saving a possible
duplicate silently. Voice review re-checks when the worker corrects a field.
`docs/PRD.md` calls for an automatic merge at ≥ 95, but **that threshold is not
implemented**: the frontend opens the same field-by-field merge UI for *every*
surviving match (`handleSave` in `mobile/components/TranscriptionResults.tsx`). The merge UI
defaults each field to the newer value, but the worker can flip any field, or
choose to create a new person instead. Note also that the backend does not merge
server-side — `IndividualService.save_individual` replaces the whole `data`
JSONB with what the client posts, so any field the client omits is dropped.

A save is one transaction: the `save_individual` SQL function writes the person
and the interaction row together, so there is no half-saved state. A merge sends
the `version` of the person it loaded (`expected_version`); if someone else
saved that person in between, the save is refused with 409 "This person was
changed by someone else. Reload and try again." and the app reloads the person.
Each review session sends an `Idempotency-Key` header, so a retried save (after a
lost response) returns the first save's result instead of saving twice.

### Search

**The Search tab** (`POST /api/embeddings/search`) runs in Postgres: one call to
`search_individuals_hybrid` fuses three legs by reciprocal rank (k = 60). The
name leg is a substring (the query is literal text: `%` and `_` are escaped) or
trigram match; the full-text leg searches the name and the string values of
`data` (never field names, so "veteran" doesn't match everyone through a
`veteran_status` key; "diab" finds Diabetes, "male" doesn't find Female); the
semantic leg is a pgvector cosine search (HNSW) of the query's embedding. A
case-insensitive exact name match always comes first. A query under 3
characters gets no semantic leg, and query embeddings are cached in memory (256
queries, 10 minutes); if embedding fails, the search runs on the other two legs.

**The list** (`GET /api/individuals?search=`) and duplicate-candidate fallbacks
use `match_individual` in `backend/services/search_matching.py`: the name as a
case-insensitive substring ("ann" finds "Joanne"), or a string value or list item
in `data` where the query starts a word, never field names; name matches sort
first. It matches in Python over the whole table (demo scale), reading it in
pages past Supabase's API row limit with `fetch_all`, so nobody drops out of the
list or export past the first 1000.

On the Search tab, typing runs one search per pause: 600 ms for 3+ characters
(the semantic leg), 300 ms for shorter queries (text only), and only the newest
response is shown. Each result shows its match: "Exact" (the whole name),
"Name" (part of a name), "Details" (a field value) or a percentage (semantic). The list loads on each focus; after the first load it
refreshes in the background, keeping the last good list if the refresh fails.

## Data leaving the system

The app holds personal and medical information about people who never signed up
for anything. This is everything that leaves the phone, where it goes, and what
is logged.

| What | Goes to | When | Kept |
|---|---|---|---|
| A recording: M4A audio (16 kHz mono AAC) of the worker describing the person | The backend, then OpenAI transcription (`TRANSCRIBE_MODEL`, default `gpt-transcribe`), with a fixed prompt of SF place and street names (no person names) | Each recording (`POST /api/transcribe`) | Backend: only as a temp file, deleted on every path (`openai_service.temp_audio_file`). Phone: in the app's cache until the record is saved or discarded, a new recording replaces it, or the Record screen goes away (kept until then so "Try Again" can resend it). OpenAI: under its API data policy and your account's retention settings. |
| The transcript, with every category's name, type and options | OpenAI GPT-4o | Each recording, to extract the fields | Supabase: the transcript is saved with the interaction. |
| The new person's name, aka, age, height, weight, gender and the street part of the last location, with the same for up to 8 existing candidates; never medical or sensitive fields | OpenAI `DUPLICATE_MODEL` (default `gpt-4o-mini`) | Each duplicate check: after a recording, on a manual entry, and when an edited voice record is re-checked. Never the GPS location of the encounter. | Not stored. |
| A person's name and labelled fields (`build_embedding_text`); never a sensitive (`is_sensitive`) field | OpenAI embeddings (`text-embedding-3-large`) | After each save, `POST /api/embeddings/generate` or `generate-all`, and the backfill script | Supabase: the vector and that text, in `individual_embeddings`. |
| Each visit's transcript | OpenAI embeddings (`EMBEDDING_MODEL`) | After a save that carried a transcript | Supabase: the vector only, in `interaction_embeddings` (the transcript is already stored with the interaction). It was already sent to OpenAI to be transcribed, so this sends nothing new. |
| A Search-tab query | The backend; OpenAI embeddings for the semantic half (`POST /api/embeddings/search`) | Each search | Not stored. The list search sends it in the URL (`GET /api/individuals?search=`), see logging below. |
| An assistant question: the worker's speech as a PCM16 stream (or the typed text) | The OpenAI Realtime API (`REALTIME_MODEL`, default `gpt-realtime-2.1`), through the backend proxy; it also transcribes the speech (`TRANSCRIBE_MODEL`) for the worker's bubble | Each question | Phone: nothing is stored; the stream stops when listening stops, the tab is left, the app goes to the background or the socket closes. OpenAI: as above. |
| Records returned by the assistant's tools (`search_people`, `get_person`, `recent_interactions`, `most_urgent`), each value clipped | The OpenAI Realtime API, as a delimited tool output | Each tool call | For that assistant session. |
| Everything saved: name, fields, urgency, last location, transcripts and each interaction's location | Supabase (Postgres) | Each save | Until the person is deleted, which also removes their interactions, their embeddings and their visit embeddings. Once the owner schedules `coarsen_old_locations`, interaction locations older than 30 days are rounded to about 110 m with the house number removed; the newest visit and the person's last location stay exact. |
| Who did what to which record: user id, device id, action, record id, a count or an override value (`audit_log`) | Supabase (Postgres) | Viewing a profile, export, delete, an urgency override, a merge, a new person, a new category | Kept after the person is deleted (no names or field values; the table is append-only). |
| The worker's email and session tokens | Supabase Auth | Sign-in | Supabase Auth; the session also on the phone. |
| The GPS position of each recording, and of a location picked by hand | The phone platform's geocoder, through `expo-location`'s `reverseGeocodeAsync` (Apple on iOS, Google Play services on Android) | Each recording, and in the location picker | The platform's own policy. |
| The area shown on a map (location picker, profile map) | The map tile provider of `react-native-maps` (Apple Maps on iOS, Google Maps on Android) | Each map shown | Tile requests reveal the area being viewed. |

A custom category of type `location` is an ordinary field: its value lives in
`data`, so it goes to GPT-4o (extraction and duplicate checks), into the
embedding text and into the assistant's tool results like any other field. Only the
encounter's GPS position (`last_location`, the interaction's `location`) is kept
out of those.

**What is logged**

- **Backend.** Lifecycle events, counts, ids and error types only, through
  Python `logging` at `LOG_LEVEL` (default `INFO`). Never names, transcripts,
  questions, field values, GPS or a person's urgency. Exception messages aren't
  logged either, because an upstream error can echo the data that was sent.
  - The `httpx`, `httpx2`, `httpcore`, `openai`, Supabase-client and
    `websockets` loggers stay at `WARNING` whatever `LOG_LEVEL` says: at
    `INFO`/`DEBUG` they log request URLs (PostgREST filters carry names) and
    request bodies.
  - uvicorn's access log drops query strings, so `?search=` terms aren't in it.
  - `backend/tests/test_no_pii_logs.py` drives the save, transcribe, search
    and WebSocket (including a tool call) paths with a sentinel person and fails if any of it
    reaches a log or stdout/stderr.
- **Not covered.** Anything in front of the backend (a hosting platform's HTTP
  log, a reverse proxy) may record full URLs, including `?search=` terms.
- **Mobile.** Every `console.*` call is behind `__DEV__`, so a release build
  writes nothing to the device log. Development builds log error objects only,
  never case data. `mobile/test/noDataLogs.test.ts` scans the source for both.

## Testing

```bash
python -m pip install -r requirements-dev.txt
python -m pytest                    # from the repo root
ruff check backend --select F,E9    # the lint CI runs (rules in ruff.toml)
```

The backend suite runs offline: OpenAI is mocked, Supabase is replaced by small
fakes (`backend/tests/helpers.py`; the strict `FakeSupabase` fails any query a
test didn't script, so tests assert on what was actually written), and a fake
user stands in for token verification except in tests marked `real_auth`.
`backend/tests/conftest.py` resets process-wide state (rate-limit windows, the
token cache, the shared clients, `app.dependency_overrides`) around
every test, so the order tests run in doesn't matter. A test that builds a real
Supabase client fails (see `pytest.ini`).

The only skipped tests are the read-only live smoke test in
`backend/tests/integration/test_live_smoke.py`. It runs only when both variables
are set, against a running backend and its real Supabase project:

```bash
VOICEREACH_API_URL=http://localhost:8001 \
VOICEREACH_LIVE_TOKEN=<a Supabase access token for an allowed user> \
python -m pytest backend/tests/integration
```

It writes nothing and calls no OpenAI endpoint.

### Evals

`backend/evals/` measures the AI steps on synthetic data (no real people):

- `eval_extraction.py`: 30 transcripts with expected fields. It reports per-field
  precision and recall, micro precision/recall, how many values the evidence rule
  dropped, and the hallucination rate (values the transcript doesn't state) before
  and after that rule.
- `eval_duplicates.py`: 40 labelled pairs (20 the same person: identical names,
  nicknames, spellings, first name only; 20 not). It reports precision (of the pairs
  scored at or above the threshold, how many really are the same person) and recall
  (of the same-person pairs, how many reach it) at confidence 50, 60, 70 and 80. The
  production cut-off is 60. It also counts prompts that carried a sensitive value,
  which must be 0.

Offline (the default) replays cached model replies in `backend/evals/fixtures/`
through the real parsing and normalising code, so it is deterministic and costs
nothing; `backend/tests/test_evals.py` runs it in CI and fails when a metric drops
below `backend/evals/baseline.json`.

```bash
cd backend
python -m evals.eval_extraction                     # offline, against the baseline
EVAL_LIVE=1 python -m evals.eval_extraction --live  # ask the model (OPENAI_API_KEY; tolerance 0.05)
EVAL_LIVE=1 python -m evals.eval_extraction --live --record   # cache real replies
python -m evals.eval_extraction --update-baseline   # store the offline metrics as the baseline
python -m evals.eval_duplicates                     # the same flags
```

The first cached replies are hand-written (`"source": "hand-written"`); record
live ones, regenerate the baseline and review the diff after changing the model
or the schema.

```bash
cd mobile
npx jest          # component, screen and service tests; native modules are mocked
npx tsc --noEmit  # must report 0 errors
```

## Deployment

`railway.toml` is kept for reference: Railway builds from the repo root and
starts `python -m uvicorn main:app`, with `/health` as the deploy healthcheck;
the root `main.py` re-exports `backend.main:app` so the backend package
resolves, and `.python-version` pins Python 3.11. Only the backend deploys;
`mobile/` and `docs/` are excluded via `.railwayignore`. The original deployment
has been taken down.

CI (`.github/workflows/ci.yml`) runs the ruff lint and the backend suite, then
`tsc` and Jest for the app, with read-only repo permissions. A `pip-audit` step
reports known-vulnerable Python dependencies without failing the build.

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
- **Categories are create-only.** There is no edit, delete or on/off switch for
  a category, in the app or the API. The Categories tab lists them and creates
  new ones; any change to an existing category is a SQL edit in Supabase.
- **A delete is lost if the app is killed during the undo window.** The pending
  delete is kept in memory only for about 5 seconds (`DELETE_UNDO_MS`, see
  "Deleting a person" above), so the person is still there on next launch and
  has to be deleted again.
- **The list search is demo-scale.** The list (`GET /api/individuals?search=`)
  and export read the whole table and work in Python (paged past Supabase's API
  row limit); the Search tab's hybrid search runs in Postgres. After creating or
  editing a category, existing people's embeddings only pick up the change when
  they are next saved, or when `backfill_embeddings.py --stale` (or
  `POST /api/embeddings/generate-all`) runs.
- **Re-running `seed.sql` re-adds a deleted demo person.** Seed people are
  matched by name (see [Database](#1-database)).
- **iOS only.** There is no Android build setup, and `mobile/ios/` is committed
  prebuilt, so `app.json` changes need `npx expo prebuild --platform ios` (see
  [Mobile](#3-mobile)). After pulling, rebuild any existing development build
  (`npx expo run:ios`): CSV export needs the native `expo-sharing` module.
- **Not yet re-verified against live services.** After the dependency upgrade,
  the OpenAI and Supabase calls were checked only offline (mocks and
  introspection). Run the curl check in [Auth](#auth) and one recording after
  setup. Sending the `Authorization` header on React Native's WebSocket has not
  yet been confirmed on a physical device.

## Shortcuts taken

Listed explicitly so nobody mistakes them for finished work:

- **No per-agency or per-user scoping.** Row-level security blocks all direct
  table access, but every user the backend accepts (any user of the Supabase
  project, or those in `ALLOWED_USER_EMAILS`) can read and change every record
  through the API. A real deployment needs scoping — this is sensitive personal
  and medical data.
- **Keys were once committed to git history** (in 2025: an OpenAI key and
  Supabase service-role keys for a project that has since been deleted). History
  was not rewritten; those keys are treated as compromised and must stay revoked.
- **One shared demo account, auto-logged-in.** The credentials are hardcoded in
  `mobile/services/supabase.ts`, there is no email verification, and every
  interaction is recorded as "Demo User" (`get_current_user_name` in
  `backend/api/individuals.py`). Rate limits tell phones apart only by the
  `X-Device-Id` header the app sends.
  Sign Out (Profile tab) ends the session on the device, but the next launch
  signs in again automatically, so it is not a lock on a shared or lost phone.
- **No offline support.** The app requires connectivity throughout.
