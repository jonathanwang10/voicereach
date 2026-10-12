# VoiceReach demo script

A 5-6 minute walkthrough of the app.

### Before the demo

- Complete the README's Setup: Supabase project with `supabase/schema.sql` run
  and the demo user created, backend running on port 8001, `mobile/.env` filled in.
- **Generate the embeddings** (README Setup step 4). The seed people start
  without them, so the semantic search in step 4 below finds nothing until you
  run, from the repo root with the venv active:
  `cd backend && python scripts/backfill_embeddings.py`
  (or `POST /api/embeddings/generate-all` with a token). Run it again after
  re-running `schema.sql` or upgrading.
- Open the app in the iOS simulator (or on a phone with
  `EXPO_PUBLIC_API_BASE_URL` set to your machine's LAN address).
- The seed data includes six people, among them **John Doe** (45, 6 ft, 180 lb,
  diabetes). The recording below is written to match him, so it will trigger the
  merge flow.

---

### 1. Launch and auto-login (30 seconds)

**Script:** "The app signs in automatically with the demo account and opens on
the Record tab, so a worker can start talking straight away."

**Actions:**
- Launch the app; there is no login screen.
- Point out the Record tab: voice recording or manual entry, plus a Set
  Location button for adjusting the position by hand.

---

### 2. Voice recording and AI transcription (2 minutes)

**Script:** "I'll record a short note the way a worker would after an encounter."

**Actions:**
1. **Record** (about 30 seconds)
   - Tap record and point out the live timer. Recording starts at once and GPS
     is captured alongside it; after you stop, a "Location Set" card shows this
     recording's address.
   - Say: "Met John near Market Street. About 45 years old, 6 feet tall, maybe 180
     pounds. Shows signs of moderate substance abuse, been on streets 3 months.
     Needs diabetes medication."
   - Recordings must be at least 5 seconds; the timer turns red at 1:30, an
     alert warns at 1:45, and the recorder stops itself at 2:00.
2. **Processing** (about 30 seconds)
   - Explain: "The audio goes to our FastAPI backend. Whisper transcribes it,
     GPT-4o pulls out structured fields, and GPT-4o compares the result with
     existing records to look for duplicates."
3. **Results** (about 1 minute)
   - Show the transcript and the extracted fields (name, age, height in inches,
     weight, substance history, medical conditions).
   - Point out that name, height and weight are required; save is blocked until
     they have values.
   - Edit a field to show the worker can correct the AI.

---

### 3. Duplicate detection and merge (1 minute)

**Script:** "The AI thinks this may be someone we've already met."

**Actions:**
1. Tap Save. Because there is a likely match, the merge screen opens.
   - Show the confidence score (for example, 87%) and the side-by-side fields.
   - Every match of 60% or more opens this same screen; nothing is merged
     without the worker confirming.
2. Pick which value to keep for a field or two, then tap Merge.
   - Mention the alternative: "Create New" saves a separate person.

**Key points:** LLM-scored duplicate detection; field-by-field choice; the
encounter is logged as an interaction with only the fields that changed.

---

### 4. Search and profile (1 minute)

**Script:** "Back at the office, or before the next visit, we can look John up."

**Actions:**
1. **Search tab**
   - Search for "John". Show the results with their urgency scores and
     green/yellow/red colouring.
   - Try a descriptive search such as "veteran with heart disease" to show
     semantic search (James Brown is the seeded veteran with heart disease; it
     needs the embeddings from "Before the demo", as the text match alone finds
     nobody).
2. **Profile**
   - Open John Doe. Show the fields, the map of the last known location and the
     interaction history, including the encounter just recorded.
   - Use the urgency override slider, and explain that the override is shown
     instead of the calculated score without replacing it.

---

### 5. Voice assistant (1 minute)

**Script:** "Before approaching someone, a worker can just ask."

**Actions:**
- Open the Assistant tab; it connects on its own and shows "Connected".
- Ask, by voice or text: "What should I know before approaching John Doe?"
- Explain: "The question is transcribed with Whisper. The backend spots the
  name, looks John up and gives OpenAI's realtime model his record as context,
  so the spoken answer reflects what's on file."

---

### 6. Categories and export (30 seconds)

**Script:** "The fields we collect are data, not code."

**Actions:**
1. **Categories tab:** show the field list with types and priorities, and the
   add-category form. For a single-select field, type options like
   `Calm, Agitated=0.5, Violent=1` and a weight (0–100).
2. **Export CSV:** tap the export button. The share sheet opens with the CSV
   (one column per category, plus Urgency Score and Last Seen); save it to Files
   or AirDrop it to a laptop.

---

### Wrap-up (30 seconds)

**Script:** "A thirty-second voice note replaces a page of typing. The AI does
the transcription and data entry, the urgency score helps teams prioritise, and
the assistant puts what we already know in front of the worker when they need it."

---

### Architecture summary

- **Backend:** FastAPI + Supabase (Postgres) + OpenAI
- **App:** React Native (Expo)
- **AI:** Whisper (transcription), GPT-4o (extraction and duplicate scoring),
  `text-embedding-3-large` (semantic search), `gpt-realtime` (assistant)
- **Data:** Postgres with a JSONB `data` column, so new fields need no migration

---

### Demo tips

1. Keep moving; don't get stuck on technical detail.
2. Use the seeded people so search and the assistant have something to find.
3. If a live call fails, say so and move on; have screenshots ready.
4. Keep to time.
5. **Resetting between runs.** The merge changes John Doe, and re-running
   `schema.sql` doesn't undo it (seed people are matched by name). Delete John
   Doe in the app (and any extra "John" a run created with Create New), or run
   `DELETE FROM individuals WHERE name = 'John Doe';` in the SQL Editor, then
   re-run `supabase/schema.sql`: it re-adds him with his seed data and seed
   interaction. Then run the backfill again so he has an embedding.

---

### Q&A preparation

- **"What happens to the audio?"** It's sent to the backend inline, written to a
  temporary file and sent to OpenAI's Whisper for transcription; the backend's
  copy is deleted straight after, and the phone's once the record is saved or
  discarded. The transcript is kept with the interaction. OpenAI also sees the
  transcript, candidate records for duplicate checks and the assistant's
  context, under its API data policy. The README's "Data leaving the system"
  table lists all of it. The backend's own logs hold no names, transcripts or
  locations, but a hosting platform or proxy in front of it may log request
  URLs, including list-search terms (`?search=`).
- **"Can it work offline?"** No. It needs a connection throughout.
- **"Is it secure enough for real client data?"** Not yet. Every request needs a
  signed-in session and the database refuses direct access, but every account
  the backend accepts can read every record through the API (an email
  allowlist can narrow that). A real deployment needs per-agency access rules
  and a proper account system.
- **"Why FastAPI rather than Supabase alone?"** It keeps the OpenAI calls, the
  prompts and the API key on a server we control.
- **"How do you handle duplicates?"** GPT-4o scores likely candidates 0-100, and
  anything at 60 or above goes to the worker to confirm or reject.
- **"How is urgency calculated?"** A weighted average of the numeric and
  single-choice fields that carry a weight. A recorded behaviour issue (verbal or
  physical) sets it straight to 100. Workers can override it.
