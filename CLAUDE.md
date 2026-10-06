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
cd backend && python -m uvicorn main:app --reload --port 8001   # always port 8001
python -m pytest                                # from the repo root; runs offline
cd mobile && npx jest && npx tsc --noEmit
```

Backend needs `backend/.env` (see `backend/.env.example`); the app needs
`mobile/.env` (see `mobile/.env.example`). Integration tests in
`backend/tests/integration/` are skipped unless `VOICEREACH_INTEGRATION=1`.

## Rules the code enforces

- **Required fields:** `name`, `height`, `weight` (`backend/db/models.py:29`).
  Height is stored in inches; weight in pounds; both 0-300.
- **Do not reintroduce `skin_color`.** It was removed on purpose (it was a scored
  field with different urgency values per skin tone). See `supabase/schema.sql`.
- **Recording:** M4A/AAC, 5 s minimum, 2 min maximum, warning at 1:45, auto-stop
  at 2:00, GPS captured at start (`mobile/components/ModernAudioRecorder.tsx`).
- **Urgency** (`backend/services/urgency_calculator.py`): only `number` and
  `single_select` categories can have a weight or auto-trigger. Number →
  `min(value/300, 1) * weight`; select → `option_value * weight`; final score is
  `int(sum / total_weight * 100)`. Auto-trigger pins 100 only when the chosen
  select option's value is > 0 (or a number is non-zero). An `urgency_override`
  is displayed instead of the score, and an override of 0 still counts.
- **Duplicates:** GPT-4o scores up to 3 candidates; matches below 60 are dropped
  and only the best is returned. There is no 95% auto-merge: every match opens the
  merge UI. A merge replaces the whole `data` JSONB with what the client sends.
- **Auth:** every `/api/*` route except `/health`, and the realtime WebSocket,
  needs `Authorization: Bearer <Supabase access token>` (`backend/api/auth.py`).
  The app auto-signs in as demo@sfgov.org. Don't add unauthenticated routes.
- **Categories** are schema-as-data rows; the API names are `urgency_weight` and
  `single_select` (UI labels may say "Danger Weight").

## App structure

Five tabs: Record (default), Search (pushes the individual profile), Assistant,
Categories, Profile. API client: `mobile/services/api.ts`. Search list, urgency
override and delete go to Supabase directly with the user's session.

## Git

Conventional commits (`feat:`, `fix:`, `docs:` ...). Never commit `.env` files or keys.
