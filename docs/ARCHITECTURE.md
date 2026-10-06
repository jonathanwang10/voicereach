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
  account) and open CORS. See the README's Shortcuts section.

## Technology stack

### Backend
- **Framework:** FastAPI on Python 3.11 (pinned in `requirements.txt` at the
  repo root)
- **Database:** Postgres via Supabase, accessed with the service key
- **Auth:** Supabase Auth. Every `/api/*` route verifies the bearer token with
  `auth.get_user` (`backend/api/auth.py`)
- **AI:** `whisper-1`, `gpt-4o`, `text-embedding-3-large`, `gpt-realtime`
- **Tests:** pytest, offline with mocks; integration tests opt-in

### App
- **Framework:** React Native with Expo SDK 53, built and demoed on iOS
- **Navigation:** bottom tabs (Record, Search, Assistant, Categories, Profile),
  with a stack inside Search for the individual profile
- **State:** React Context (`AuthContext`, `CategoryContext`)
- **Audio:** `expo-av`, M4A/AAC at 64 kbps
- **Location and maps:** `expo-location` for GPS and reverse geocoding,
  `react-native-maps` for the profile map
- **Tests:** Jest (`jest-expo`) and `tsc --noEmit`

### Infrastructure
- **Database:** one Supabase project, set up by running `supabase/schema.sql`
  once in the SQL Editor; there is no migration chain
- **Storage:** none. Audio is posted inline as base64 and only touches disk as a
  temp file during transcription
- **Hosting:** runs locally. `railway.toml` and the root `main.py` remain for a
  Railway deployment of the backend

## Database schema

From `supabase/schema.sql`:

```sql
categories (
    id UUID PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    type TEXT,               -- text/number/single_select/multi_select/date/location
    options JSONB,           -- [{label, value}] for single_select, [text] for multi_select
    priority TEXT,           -- high/medium/low (display only)
    urgency_weight INTEGER,  -- only meaningful for number/single_select
    auto_trigger BOOLEAN,    -- can pin the urgency score to 100
    is_required BOOLEAN,
    is_preset BOOLEAN,
    is_active BOOLEAN,
    created_at, updated_at TIMESTAMPTZ
)

individuals (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    data JSONB,              -- every field, keyed by category name
    urgency_score INTEGER,   -- calculated
    urgency_override INTEGER,-- manual, shown instead of the score when set
    last_location JSONB,     -- {latitude, longitude, address}
    created_at, updated_at TIMESTAMPTZ
)

interactions (
    id UUID PRIMARY KEY,
    individual_id UUID REFERENCES individuals ON DELETE CASCADE,
    user_id TEXT,            -- the Supabase user id, stored as text
    user_name TEXT,          -- always "Demo User" today
    transcription TEXT,
    audio_url TEXT,
    location JSONB,
    changes JSONB,           -- only the fields that changed (everything on the first visit)
    created_at TIMESTAMPTZ
)

individual_embeddings (
    id UUID PRIMARY KEY,
    individual_id UUID UNIQUE REFERENCES individuals ON DELETE CASCADE,
    embedding_data JSONB,    -- 3072 floats
    embedding_text TEXT,
    created_at, updated_at TIMESTAMPTZ
)
```

Row-level security is enabled on all four tables with one policy each: the
`authenticated` role may read and write every row. The backend's service key
bypasses RLS; the app's direct queries (search list, urgency override, delete)
run as the signed-in demo user.

## API structure

All routes except `GET /health` and `GET /` need
`Authorization: Bearer <Supabase access token>`.

- **Transcription:** `POST /api/transcribe` — audio to transcript, fields and
  duplicate candidates; saves nothing
- **Individuals:** `POST /api/individuals` (create or merge), `GET
  /api/individuals` (list/search), `GET /api/individuals/{id}`, `GET
  /api/individuals/{id}/interactions`, `PUT
  /api/individuals/{id}/urgency-override`, `POST
  /api/individuals/check-duplicates`
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
(`backend/db/models.py:29`) and by the preset categories. Height and weight must
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
   - score = `int(sum / total_weight * 100)`
3. The display score is `urgency_override` if it is set (0 included), else the
   calculated score.
4. Colours in the app: 0-33 green `#10B981`, 34-66 yellow `#F59E0B`, 67-100 red
   `#EF4444`.

### Duplicate detection and merging
1. Candidates: exact name, partial name, then a text scan of recent JSONB data
   (`backend/services/duplicate_detection_service.py`).
2. GPT-4o scores the first three 0-100. Matches below 60 are dropped; only the
   best is returned.
3. The app opens the same field-by-field merge UI for any match. There is no
   automatic merge at 95% or anywhere else.
4. The app sends the merged data with `merge_with_id`; the backend replaces the
   person's `data` with it and logs the changed fields as an interaction.

### Audio flow
1. Record M4A (5 s minimum, 2 min maximum; warning at 1:45, auto-stop at 2:00);
   GPS captured at start.
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
│   └── voice_assistant.py     # /api/voice-assistant helper routes
├── services/
│   ├── openai_service.py      # Whisper, GPT-4o extraction, height parsing
│   ├── duplicate_detection_service.py
│   ├── individual_service.py  # Save/merge, search, profile, history
│   ├── urgency_calculator.py
│   ├── validation_helper.py
│   ├── embedding_service.py
│   └── context_service.py     # Name lookup for the assistant
├── db/models.py               # Pydantic schemas
├── scripts/backfill_embeddings.py
└── tests/                     # Offline suite; tests/integration/ is opt-in
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
│   ├── CategoriesScreen.tsx              # Categories tab, CSV export
│   └── UserProfileScreen.tsx             # Profile tab (worker)
├── components/
│   ├── ModernAudioRecorder.tsx  # 5 s - 2 min recorder
│   ├── TranscriptionResults.tsx # Review, edit, save or merge
│   ├── ManualEntryForm.tsx
│   ├── MergeUI.tsx              # Field-by-field duplicate resolution
│   ├── UrgencyScore.tsx         # Score display and override slider
│   ├── LocationPicker.tsx, IndividualLocationMap.tsx
│   ├── InteractionHistoryItem.tsx, InteractionDetailModal.tsx
│   └── ui/                      # Button, Card, Badge, Input, AnimatedView
├── services/
│   ├── api.ts                 # Backend client; getAuthToken signs in first
│   └── supabase.ts            # Supabase client and demo auto-login
├── contexts/                  # AuthContext, CategoryContext
└── utils/                     # height parsing, urgency colours, error handling
```

## Implementation patterns

### Errors
Routes raise `HTTPException` with a string `detail`: 400 for validation, 401 for
auth, 404 for missing records, 409 for a duplicate category name, 500 otherwise.
Request-model failures (for example, a save without `height`) are FastAPI's
standard 422. The app's `apiRequest` retries once after refreshing the session on
401/403, retries once on a network failure, and shows a toast for other errors.

### Auth in the app
```typescript
// mobile/services/api.ts
export const getAuthToken = async () => {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    await autoLogin();                     // signs in as demo@sfgov.org
    ({ data: { session } } = await supabase.auth.getSession());
  }
  if (!session) throw new Error('Not signed in. ...');
  return session.access_token;
};
```

Every backend call, the direct Supabase queries and the assistant WebSocket
handshake use this token.

## Edge cases

- **Recording under 5 s:** an alert asks for more and recording continues.
- **Recording reaches 2:00:** it stops and submits on its own.
- **Missing required fields:** the review form blocks Save and lists them; the
  backend rejects them as well (422 from the request model).
- **Height formats:** "70", "5'10", "5 ft 10 in", "178cm" are all converted to
  inches before saving.
- **Several duplicate matches:** only the best one is returned and shown.
- **Create new despite a match:** allowed from the merge UI.
- **Failed save:** an error is shown and the form keeps its data.
- **No connection:** requests fail with an error toast; there is no offline mode.

## Testing

- **Backend:** `python -m pytest` from the repo root runs the offline suite
  (OpenAI and Supabase mocked, a fake user for auth). Integration tests in
  `backend/tests/integration/` need a running backend and real services and run
  only with `VOICEREACH_INTEGRATION=1`.
- **App:** `npx jest` (component and service tests with mocked native modules)
  and `npx tsc --noEmit`.

## Configuration

```bash
# backend/.env
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...      # server-side database access
SUPABASE_ANON_KEY=...         # token verification only
OPENAI_API_KEY=...

# mobile/.env
EXPO_PUBLIC_API_BASE_URL=http://localhost:8001   # LAN address on a physical phone
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
```

## Known limitations

1. No offline support.
2. Categories are effectively create-only (edits are local; weight and
   auto-trigger aren't sent on create).
3. One shared demo account; every signed-in user can read and write every row.
4. Built and demoed on iOS; Android has had little testing.
5. English only.
6. Two-minute recording limit, enforced in the app.
7. Semantic search embeds a fixed set of fields, stores vectors as JSONB and
   compares them in Python.
8. List and search endpoints load whole tables.
9. No audit trail beyond the interactions log.

## Quick reference

```sql
-- Search individuals by name or any field
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
