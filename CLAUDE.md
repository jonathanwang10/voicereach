# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

VoiceReach: a hackathon MVP for SF homeless-outreach workers. A worker records a
short voice note; the FastAPI backend transcribes it (Whisper), extracts structured
fields (GPT-4o), scores urgency, checks for duplicates, and the Expo app saves a new
person or merges into an existing one. A realtime voice assistant answers questions
using what the database knows. Read `README.md` first; it is the accurate overview.

## Principles

- Keep it simple. This is a demo-scale MVP: no new abstractions, no future-proofing.
- `docs/PRD.md` is the original spec. Check it for intent, but where the code and
  README diverge from it, the code and README win (the PRD header lists the gaps).
- No UI redesign or behavior change unless the task asks for it.

## Commands

```bash
python3.11 -m venv .venv && source .venv/bin/activate
python -m pip install -r requirements.txt -r requirements-dev.txt
cd backend && python -m uvicorn main:app --reload --port 8001   # always port 8001; add --host 0.0.0.0 for a physical phone
python -m pytest                                # from the repo root; runs offline
ruff check backend --select F,E9                # the lint CI runs
cd mobile && npx jest && npx tsc --noEmit
cd backend && python -m evals.eval_extraction   # offline eval vs backend/evals/baseline.json
# database: fresh = supabase/schema.sql then supabase/seed.sql (demo only); upgrade = supabase/migrations/ in order
```

Backend needs `backend/.env` (see `backend/.env.example`); the app needs
`mobile/.env` (see `mobile/.env.example`). The one live test,
`backend/tests/integration/test_live_smoke.py`, is skipped unless both
`VOICEREACH_API_URL` and `VOICEREACH_LIVE_TOKEN` are set. The app is iOS-only and
`mobile/ios/` is committed (prebuilt), so an `app.json` change reaches the build
only after `npx expo prebuild --platform ios`.

## Rules the code enforces

- **Required fields:** `name`, `height`, `weight` (`SaveIndividualRequest` in
  `backend/db/models.py`).
  Height is stored in inches; weight in pounds; both 0-300.
- **Do not reintroduce `skin_color`.** It was removed on purpose (it was a scored
  field with different urgency values per skin tone). See `supabase/schema.sql`.
- **Recording:** M4A/AAC, 5 s minimum, 2 min maximum, timer red from 1:30,
  warning alert at 1:45, auto-stop at 2:00. Recording starts on tap; the GPS fix
  is captured alongside it and waited for at most `LOCATION_WAIT_MS` (3 s) at
  stop (`mobile/components/ModernAudioRecorder.tsx`). Each recording uses its
  own fix unless the worker picked a location by hand. The server re-checks the
  length with mutagen: 400 under 5 s or over 125 s (2:00 plus 5 s slack);
  assistant questions 1-60 s (`services/openai_service.py`, `RECORDING_LIMITS`).
- **Urgency** (`backend/services/urgency_calculator.py`): only `number` and
  `single_select` categories can have a weight or auto-trigger. Number →
  `min(value / (number_scale_max or 300), 1) * weight`; select → `option_value * weight`; final score is
  `int(sum / total_weight * 100)`, where `total_weight` sums the weight of every
  weighted number/single_select category, so a missing value counts as 0.
  Auto-trigger pins 100 only when the chosen select option's value is > 0 (or a
  number is non-zero). An `urgency_override` is displayed instead of the score,
  and an override of 0 still counts. Creating a weighted or auto-trigger category
  re-scores everyone in the background (`rescore_all_individuals`, batches of 500 via
  `rescore_batch`; run `backend/scripts/rescore_urgency.py` after upgrading). A category
  with `is_sensitive` never scores or auto-triggers, and `POST /api/categories` refuses a
  weight or auto-trigger on one with 400 `Sensitive fields can't affect urgency.`
- **Extraction** (`services/category_schema.py`): a strict json_schema built from the
  categories, temperature 0; every value carries `evidence` (transcript words), and a
  value whose evidence isn't in the transcript is dropped (numbers: their digits or
  number word suffice). Nothing is inferred; a missing required field is
  `missing_required`. The transcript is its own fenced `user` message. Transcription
  uses `model_config.TRANSCRIBE_MODEL` (default `gpt-transcribe`) with the SF
  vocabulary prompt in `services/transcribe_vocab.py` (places and terms, never person names).
- **Duplicates:** candidates come from the SQL function `find_duplicate_candidates`
  (trigram or token name match, plus a data-value match over the 200 most recent
  people), are pre-ranked (name tokens, sound-alikes and close spellings, then
  height/weight closeness) and GPT (`DUPLICATE_MODEL`, default gpt-4o-mini) scores the
  top 8 (`MAX_LLM_CANDIDATES`) from name, aka, age, height, weight, gender and last-seen
  area only (no sensitive or medical fields); matches below 60 are dropped and the
  backend returns the top 3, best first. Voice review may add a
  re-check's matches to the server's (`topMatches`, at most 3 shown); the merge
  screen opens on the best match, and "Other possible matches (n)" switches to another. There is no 95% auto-merge:
  every match opens the merge UI. A merge replaces the whole `data` JSONB with
  what the client sends, guarded by `individuals.version` (409 `This person was
  changed by someone else. Reload and try again.`); a save is one `save_individual`
  transaction and `Idempotency-Key` makes it idempotent.
- **Auth:** every `/api/*` route except `/health`, and the realtime WebSocket,
  needs `Authorization: Bearer <Supabase access token>` (`backend/api/auth.py`).
  The app auto-signs in as demo@sfgov.org. An optional `ALLOWED_USER_EMAILS`
  allowlist gives other users a 403. Don't add unauthenticated routes.
- **Paid or heavy endpoints and the realtime proxy:** routes that call OpenAI in the
  request, plus save, category create and delete, take `Depends(rate_limit(...))`
  (`backend/services/rate_limit.py`) instead of `get_current_user`; limits key on the
  user id plus `X-Device-Id` (`api/device.py`), with a per-process total per bucket.
  Open realtime sessions are capped per phone and per process (`acquire_session`;
  the proxy releases the slot in `finally`).
  Large bodies are capped in `BODY_LIMITS` (`backend/main.py`).
  The proxy forwards only the client events in `services/realtime_guard.py`; database
  text goes to the model only as a delimited `user` item (`build_context_item`), never
  as a `system` message.
- **Database access:** one service-key client from `db.client.get_supabase()`; every
  `.execute()` reached from `async` code goes through `await run_db(...)` (the test fakes
  fail a query made on the event loop); whole-table reads go through `fetch_all`,
  ordered by a unique key.
- **Categories** are schema-as-data rows; the API names are `urgency_weight` and
  `single_select`. A category's `name` is its key (`category_key`, e.g. `hiv_status`)
  and `display_name` is the label as typed; export columns, embedding text and the
  assistant's fields all come from the categories (`services/field_registry.py`).
  `is_sensitive` is set on create (toggle, or a key matching `SENSITIVE_KEY_PATTERN`);
  there is no edit route.

## App structure

Five tabs: Record (default), Search (pushes the individual profile), Assistant,
Categories, Profile. API client: `mobile/services/api.ts`. All data access goes
through the backend; the app's Supabase client is for auth only (never call
`supabase.from` in mobile/). Delete is delayed for an undo window
(`mobile/utils/delayedDelete.ts`).

## Git

Conventional commits (`feat:`, `fix:`, `docs:` ...). Never commit `.env` files or keys.
