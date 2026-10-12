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
  (none by default), never with credentials. See the README's Shortcuts section.

## Technology stack

### Backend
- **Framework:** FastAPI on Python 3.11 (pinned in `requirements.txt` at the
  repo root)
- **Database:** Postgres via Supabase, accessed with the service key
- **Auth:** Supabase Auth. Every `/api/*` route verifies the bearer token with
  `auth.get_user` (`backend/api/auth.py`)
- **AI:** `whisper-1`, `gpt-4o`, `text-embedding-3-large`, `gpt-realtime`
- **Tests:** pytest, offline with mocks; one opt-in live smoke test. CI also
  runs `ruff check backend --select F,E9`

### App
- **Framework:** React Native with Expo SDK 53, iOS only. `mobile/ios/` is
  committed (prebuilt), so `app.json` changes need `npx expo prebuild --platform ios`
- **Navigation:** bottom tabs (Record, Search, Assistant, Categories, Profile),
  with a stack inside Search for the individual profile
- **State:** React Context (`AuthContext`, `CategoryContext`)
- **Audio:** `expo-av`, M4A/AAC at 64 kbps
- **Location and maps:** `expo-location` for GPS and reverse geocoding,
  `react-native-maps` for the profile map
- **Tests:** Jest (`jest-expo`) and `tsc --noEmit`

### Infrastructure
- **Database:** one Supabase project, set up by running `supabase/schema.sql`
  in the SQL Editor; there is no migration chain, and re-running it is safe
  (it also upgrades a database made by an older version)
- **Storage:** none. Audio is posted inline as base64 and only touches disk as a
  temp file during transcription
- **Hosting:** runs locally. `railway.toml` (with a `/health` deploy
  healthcheck), `.python-version` and the root `main.py` remain for a Railway
  deployment of the backend

## Database schema

From `supabase/schema.sql`, as a fresh install creates it. A database upgraded by
re-running the file gets only the `NOT NULL`s its `ALTER TABLE` statements add
(see "Upgrading" in the README), not every one shown here:

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
    is_required BOOLEAN NOT NULL,
    is_preset BOOLEAN NOT NULL,
    is_active BOOLEAN NOT NULL,      -- reserved; not filtered on
    created_at, updated_at TIMESTAMPTZ NOT NULL
)

individuals (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    data JSONB NOT NULL,     -- every field, keyed by category name
    urgency_score INTEGER NOT NULL,  -- calculated
    urgency_override INTEGER,-- manual (CHECK 0-100), shown instead of the score when set
    last_location JSONB,     -- {latitude, longitude, address}
    created_at, updated_at TIMESTAMPTZ NOT NULL
)

interactions (
    id UUID PRIMARY KEY,
    individual_id UUID NOT NULL REFERENCES individuals ON DELETE CASCADE,
    user_id TEXT,            -- the Supabase user id, stored as text
    user_name TEXT NOT NULL, -- always "Demo User" today
    transcription TEXT,
    audio_url TEXT,
    location JSONB,
    changes JSONB NOT NULL,  -- only the fields that changed (everything on the first visit)
    created_at TIMESTAMPTZ NOT NULL
)

individual_embeddings (
    id UUID PRIMARY KEY,
    individual_id UUID NOT NULL UNIQUE REFERENCES individuals ON DELETE CASCADE,
    embedding_data JSONB NOT NULL,   -- 3072 floats
    embedding_text TEXT NOT NULL,    -- exactly the text that was embedded
    created_at, updated_at TIMESTAMPTZ NOT NULL
)
```

Row-level security is enabled on all four tables with **no policies**, so the
anon key and users' own tokens can't read or write any row directly. The
backend's service key bypasses RLS. A `set_updated_at` trigger maintains
`updated_at` on `categories`, `individuals` and `individual_embeddings`. The
only extra index is `interactions(individual_id, created_at DESC)`. The app no
longer queries tables directly: its Supabase client is
used only to sign in, and every read and write goes through the backend routes
below.

## API structure

All routes except `GET /health` and `GET /` need
`Authorization: Bearer <Supabase access token>`.

- **Transcription:** `POST /api/transcribe` — audio to transcript, fields and
  duplicate candidates; saves nothing
- **Individuals:** `POST /api/individuals` (create or merge), `GET
  /api/individuals` (list/search), `GET /api/individuals/{id}`, `GET
  /api/individuals/{id}/interactions`, `PUT
  /api/individuals/{id}/urgency-override`, `DELETE /api/individuals/{id}`
  (the app sends it after a 5 s undo window, `mobile/utils/delayedDelete.ts`),
  `POST /api/individuals/check-duplicates`
- **Categories:** `GET` and `POST /api/categories`; `GET /api/export` (CSV)
- **Embeddings:** `POST /api/embeddings/search`, `GET /api/embeddings/status`,
  `POST /api/embeddings/generate`, `POST /api/embeddings/generate-all`
- **Voice assistant:** `WS /api/voice-assistant/realtime/ws` (in
  `backend/main.py`), `POST /api/voice-assistant/transcribe`, `POST
  /api/voice-assistant/context`, `GET /api/voice-assistant/guidelines`

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
1. Candidates: an OR of name ILIKEs, one per name token of 3+ characters, then a
   match on the values (never the field names) of recent records, via
   `match_individual` in `backend/services/search_matching.py`
   (`backend/services/duplicate_detection_service.py`). They are pre-ranked by
   tokens matched plus height/weight closeness.
2. GPT-4o scores the top 8 0-100. Matches below 60 are dropped; only the best is
   returned. If the LLM fails or its reply can't be read, a whole-word name
   comparison stands in (at most 80, names only). If the candidate search fails, `check-duplicates`
   returns 500 and `/api/transcribe` sets `duplicate_check_failed`; the app then
   asks "Duplicate check unavailable. Save as new anyway?" instead of saving a
   possible duplicate silently.
3. Voice review re-checks before saving when the worker edited any field (or the
   server's check failed) and decides on the re-check's matches together with
   the server's; manual entry always checks. Matches whose delayed
   delete is pending are never offered.
4. The app opens the same field-by-field merge UI for any match. There is no
   automatic merge at 95% or anywhere else. Its buttons are disabled while a save
   is in flight, and if the match can't be loaded it still offers Create New.
5. The app sends the merged data with `merge_with_id`; the backend replaces the
   person's `data` with it and logs the changed fields as an interaction.

### Audio flow
1. Record M4A (5 s minimum, 2 min maximum; timer red from 1:30, warning alert
   at 1:45, auto-stop at 2:00). Recording starts on tap and the GPS fix is
   captured alongside it; a location picked by hand overrides it. After a failed
   transcription, "Try Again" re-sends the same recording.
2. `POST /api/transcribe` with the audio as base64.
3. Backend: Whisper → GPT-4o extraction → validation → duplicate check.
4. The worker reviews and edits; height is converted to inches.
5. `POST /api/individuals` saves, with the transcript on the interaction.
6. A background task refreshes the person's embedding.

The full walkthrough is in [`VOICE_PIPELINE.md`](VOICE_PIPELINE.md).

## File structure

### Backend
```
backend/
├── main.py                    # App, CORS, routers, realtime WebSocket proxy
├── api/
│   ├── auth.py                # Bearer-token verification dependency
│   ├── transcription.py       # POST /api/transcribe
│   ├── individuals.py         # /api/individuals routes, background embedding task
│   ├── categories.py          # /api/categories and GET /api/export
│   ├── embeddings.py          # /api/embeddings routes
│   ├── errors.py              # internal_error: fixed "<action> failed" 500s
│   └── voice_assistant.py     # /api/voice-assistant helper routes
├── services/
│   ├── openai_service.py      # Whisper, GPT-4o extraction
│   ├── field_registry.py      # Shared field normaliser, category_key, height parsing
│   ├── duplicate_detection_service.py
│   ├── individual_service.py  # Save/merge, search, profile, history
│   ├── urgency_calculator.py
│   ├── validation_helper.py
│   ├── embedding_service.py
│   ├── search_matching.py     # match_individual: the one text matcher
│   ├── rate_limit.py          # Per-account limits on the paid routes
│   ├── realtime_guard.py      # Allowlist for client Realtime events, context item
│   └── context_service.py     # Name lookup for the assistant
├── db/models.py               # Pydantic schemas
├── scripts/                   # backfill_embeddings.py, rescore_urgency.py
└── tests/                     # Offline suite; tests/integration/ is the opt-in live smoke test
```

### App
```
mobile/
├── App.tsx                    # Tabs and the Search stack
├── config/api.ts              # Backend URL and Supabase settings from .env
├── screens/
│   ├── ModernRecordScreen.tsx            # Record tab (voice + manual entry)
│   ├── ModernSearchScreen.tsx            # Search tab
│   ├── ModernIndividualProfileScreen.tsx # Profile, pushed from Search
│   ├── ModernVoiceAssistantScreen.tsx    # Assistant tab
│   ├── CategoriesScreen.tsx              # Categories tab: list, create form, CSV export
│   └── UserProfileScreen.tsx             # Profile tab: signed-in email, last sign-in, Sign Out
├── components/
│   ├── ModernAudioRecorder.tsx  # 5 s - 2 min recorder
│   ├── TranscriptionResults.tsx # Review, edit, save or merge
│   ├── ManualEntryForm.tsx
│   ├── MergeUI.tsx              # Field-by-field duplicate resolution
│   ├── CategoryLoadError.tsx    # "Couldn't load form fields" + Retry (both forms)
│   ├── UrgencyScore.tsx         # Score display and override slider
│   ├── LocationPicker.tsx, IndividualLocationMap.tsx
│   ├── InteractionHistoryItem.tsx, InteractionDetailModal.tsx
│   └── ui/                      # Button, Card, Badge, Input, AnimatedView (FadeInView)
├── services/
│   ├── api.ts                 # Backend client: getAuthToken, authedFetch, apiRequest, ApiError
│   └── supabase.ts            # Supabase client (auth only): shared autoLogin, signOut
├── contexts/                  # AuthContext, CategoryContext
└── utils/                     # height parsing, urgency colours, error handling,
                               # categoryPayload (create form), categoryDisplay (field
                               # order and labels), duplicateMatches (incl. confidence
                               # colours), csvExport (share sheet), fieldValues (typed
                               # values), delayedDelete (undo window), assistantMessages
                               # and audioProcessor (assistant replies), location
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

OpenAI clients use a 30 s timeout with one retry (Whisper 60 s), instead of the
SDK's 600 s default.

In the app, `services/api.ts` has one transport. `authedFetch` adds the bearer
token, aborts after 30 s (transcribe 120 s, assistant transcribe 60 s), on a 401
refreshes the session (falling back to `autoLogin`) and retries once, and retries
a network failure once for GET only. `apiRequest` adds JSON parsing and throws a
single `ApiError` (`status`, `detail`, `kind`) carrying the backend `detail` (a
422 list becomes "height: Field required; weight: ...", each `msg` prefixed with
the last name in its `loc`). It never toasts; the caller shows the error once (`showApiError` in
`utils/errorHandler.ts`, or its own inline state). Reads throw instead of
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
- **Several duplicate matches:** the backend returns only the best. Voice review
  adds its re-check's match (`unionMatches`), so its list can show two; Save
  offers the best (`bestMergeableMatch`).
- **Create new despite a match:** allowed from the merge UI.
- **Failed save:** the backend's reason (for example "weight: Value 400 exceeds
  maximum of 300") is shown in the form, which keeps its data; problems found by
  `/api/transcribe` (`validation_errors`) or the client checks are shown under
  their fields.
- **No connection:** requests fail with one error message (Search shows "Couldn't
  load — tap to retry"); there is no offline mode.

## Testing

- **Backend:** `python -m pytest` from the repo root runs the offline suite
  (OpenAI mocked, Supabase faked by `backend/tests/helpers.py`, a fake user for
  auth). The one live test, `backend/tests/integration/test_live_smoke.py`, is
  read-only and runs only when `VOICEREACH_API_URL` and `VOICEREACH_LIVE_TOKEN`
  are set.
- **App:** `npx jest` (component and service tests with mocked native modules)
  and `npx tsc --noEmit`.

## Configuration

```bash
# backend/.env
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...      # server-side database access
SUPABASE_ANON_KEY=...         # token verification only
OPENAI_API_KEY=...
# Optional: ALLOWED_USER_EMAILS, CORS_ALLOW_ORIGINS, RATE_LIMIT_*_PER_MIN,
# REALTIME_MAX_SESSION_SECONDS, LOG_LEVEL (see the README). backend/.env is
# read at startup: restart the backend after changing it.

# mobile/.env
EXPO_PUBLIC_API_BASE_URL=http://localhost:8001   # LAN address on a physical phone
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
```

## Known limitations

1. No offline support.
2. Categories are create-only: no edit, delete or on/off switch in the app or
   the API.
3. One shared demo account. Direct table access is closed (RLS, no policies),
   but every user the backend accepts can read and write every record through
   the API; `ALLOWED_USER_EMAILS` can limit which accounts that is.
4. iOS only: there is no Android build setup.
5. English only.
6. Two-minute recording limit, enforced in the app.
7. Semantic search embeds every category's field (`build_embedding_text`), but
   stores vectors as JSONB and compares them in Python. A new category reaches
   existing people's vectors only when they are re-saved or re-embedded.
8. List, search and export load whole tables and match text in Python
   (`backend/services/search_matching.py`): demo scale, and each read is capped
   by Supabase's API row limit (1000 by default).
9. No audit trail beyond the interactions log.
10. Saves are not transactional: individual first, then the interaction (a new
    person is deleted again if their interaction fails; a merge's update stays).

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
