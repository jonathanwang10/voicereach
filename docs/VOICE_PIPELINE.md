# Voice pipeline

How a voice note becomes a saved record, and how the voice assistant answers a
question. File paths are relative to the repo root.

## 1. Recording (app)

`mobile/components/ModernAudioRecorder.tsx`, on the Record tab.

- **Format:** M4A with AAC at 64 kbps. iOS uses expo-av's `LOW_QUALITY` preset
  (which is AAC `.m4a`); Android overrides it with an explicit AAC/MPEG-4 config.
- **Length:** 5 s minimum (stopping earlier shows "Too Short" and keeps
  recording), 2 min maximum. The timer text turns red at 1:30; the progress bar
  turns amber at 1:30 and red at 1:45; a warning alert appears at 1:45; and
  recording stops itself at 2:00. Taps while the recorder is starting are
  ignored.
- **Location:** recording starts first. Alongside it, the app asks for location
  permission, reads the GPS position and reverse-geocodes it with
  `expo-location`. At stop it waits at most `LOCATION_WAIT_MS` (3 s) for that
  fix, showing "Saving location..." with the button disabled; if the fix is late
  or fails, the recording goes on without a location.
  The Record screen uses each recording's own fix unless the worker picked a
  location by hand (the picker opens at the current location, else the GPS fix,
  else a San Francisco default). Both are cleared after a save or discard.
- **Retry:** if transcription fails, "Try Again" re-sends the same recording;
  "Record again" discards it.

## 2. Upload (app → backend)

`api.transcribe` in `mobile/services/api.ts` reads the recorded file, encodes it
as a base64 data URL and posts it inline:

```
POST /api/transcribe
Authorization: Bearer <access token>
{"audio_data": "data:audio/...;base64,...."}
```

There is no Storage upload. The backend strips the optional `data:` prefix. It
also accepts `{"audio_url": ...}`, but only for a `*.supabase.co` host; the app
never uses that path.

## 3. Backend processing

`backend/api/transcription.py`, using `backend/services/`.

1. **Load categories.** Every row of `categories` defines a field to extract,
   with its type, options and whether it is required.
2. **Transcribe.** The audio is written to a temp `.m4a` file and sent to
   `whisper-1` (`openai_service.transcribe_audio_file`).
3. **Extract.** `categorize_transcription` sends the transcript and the category
   list to `gpt-4o` in JSON mode (`response_format={"type": "json_object"}`,
   temperature 0.3). The prompt asks for the required fields (name, height,
   weight) and for height in inches. Reply keys are matched to category names
   case- and spacing-insensitively (`field_registry.category_key`, so "Name" or
   "Housing Status" still land). The reply is then cleaned per type:
   - numbers become floats; height goes through
     `field_registry.parse_height_inches` ("5 ft 10", `5' 10"`, "5.5 feet",
     "5, 10", "178 cm", "1.78 m"; a bare 1-9 is feet);
   - single-select values must match an option label (case-insensitive) or
     become `null`;
   - multi-select values become a list ("Diabetes, Cancer" is split on commas),
     keeping only known options (case-insensitive).
4. **Normalise and validate.** `validation_helper.validate_categorized_data`
   runs the shared `field_registry.normalize_individual_data` and returns
   `normalized_data`, `missing_required` and `validation_errors` (height and
   weight outside 0-300, negative, non-numeric or non-finite numbers, unknown
   select options). From here on the endpoint uses only the normalised data:
   `null` and empty values are dropped and labels are canonical.
5. **Find duplicates.** `duplicate_detection_service.find_duplicates` needs a
   name of at least two characters. It collects up to 50 candidates, most
   recently updated first: one ILIKE per name token of 3+ letters/digits, ORed
   (so "John Doe" also finds a first visit saved as "John", and "Jon Smith"
   finds "John Smith"; a name with no 3-character token uses its 2-character
   ones), then people among the latest 200 whose data values match the name
   (`match_individual`, e.g. an "aka" field). Tokens are letters and digits only,
   so no wildcard or filter syntax reaches the query. Candidates are pre-ranked
   by name tokens matched, then height (within 12 in) and weight (within 50 lb)
   closeness, and `gpt-4o` scores the top 8 0-100 on name, height, weight, age
   and history (not skin colour). Scores below 60 are dropped and only the
   single best match is returned.
   If the LLM call fails, or its reply is empty, nested or names none of the
   candidates, a whole-word name comparison stands in (80 same name, 70 one
   name's words all in the other, 60 a word in common; capped at 80 because a
   name alone is never near-certain). When GPT is unavailable the fallback
   compares names only, so a candidate found only through other fields (an
   "aka" value, say) isn't offered. If the candidate search
   itself fails (database error), the request still succeeds but sets
   `duplicate_check_failed: true` with no matches.
6. **Respond.** `{transcription, categorized_data, missing_required,
   validation_errors, potential_matches, duplicate_check_failed}`. Nothing is
   saved yet.

## 4. Review (app)

`mobile/components/TranscriptionResults.tsx`.

- The worker sees the transcript and an editable form of the extracted fields.
  Any `validation_errors` from `/api/transcribe` appear under their fields. Save
  is blocked until every required category has a value and every value passes
  the same checks as manual entry (`validateFieldValue` in
  `mobile/utils/fieldValues.ts`, mirroring the backend normaliser).
- Quick options set a single-select value; for a multi-select they toggle the
  option in or out of the list.
- If there is a match, Save opens `MergeUI`, which loads the existing profile and
  shows the fields side by side, defaulting each to the new value. The worker
  can merge (`MergeUI` hands back the chosen fields and the target id
  separately, and the request carries `merge_with_id` at its root), create a new
  person anyway, or cancel. There is no automatic merge at any confidence.
- Save first decides whether the server's check still applies. If the worker
  changed any field (a misheard name is the common case) or the server set
  `duplicate_check_failed`, the app runs `POST /api/individuals/check-duplicates`
  on the data it is about to save. The answer is added to the server's matches
  (one entry per person, at the higher confidence), so a match already on
  screen is never dropped, and the "Potential Matches" list then shows exactly
  the list Save decided on. If that check fails and no server match is on
  offer, it asks "Duplicate check unavailable. Save as new anyway?" and saves
  only on "Save as new".
- A match whose delayed delete is pending (`isPendingDelete`) is never offered.
- With no match, Save creates a new person. One success toast confirms it.
- Save itself ignores a second tap while a save is in flight. In `MergeUI`,
  Merge, Create New and Cancel are disabled while a save is in flight, so a
  double tap can't save twice; a handler that rejects is reported once. If the matched person can't be
  loaded (deleted, or a network error), the error state offers Create New as
  well as Cancel. The field choices are built from the loaded person, so their
  existing-only fields are kept on Merge.
- While a recording is being uploaded or transcribed, the recorder is hidden,
  so a second recording can't race the first.
- Before saving, values are given their real types (`coerceFieldData`: numbers,
  height in inches via `mobile/utils/height.ts` with a bare 1-9 meaning feet,
  canonical select labels, multi-select arrays) and empty fields are dropped.
  `api.saveIndividual({data, merge_with_id, location, transcription})` sends the
  fields in `data` and the rest at the root. If the backend rejects the save, its
  reason is shown in the form.

Manual entry (`ManualEntryForm.tsx`) follows the same path, except duplicates
always come from `POST /api/individuals/check-duplicates` (with the same
"Save as new anyway?" question if it fails). After a successful save the form
is cleared.

## 5. Save

`POST /api/individuals` (`backend/api/individuals.py`,
`backend/services/individual_service.py`).

1. The request model requires `name`, `height` and `weight`. If `merge_with_id`
   is set, that person must exist (404 otherwise). The data is normalised and
   validated against the categories again (400 with `field: message` details on
   failure), and only the normalised data is saved, diffed and scored.
2. The urgency score is computed (`urgency_calculator.py`): weighted average of
   `number` and `single_select` fields over the total weight of every weighted
   category (a missing value counts as 0), or 100 if an auto-trigger fires. For
   a single-select auto-trigger that means the chosen option's value is > 0.
3. **New person:** insert into `individuals`, then an `interactions` row whose
   `changes` holds the whole payload.
   **Merge:** replace the person's `data` with the posted data (fields the client
   leaves out are dropped), update name, score and `last_location`, and log an
   interaction whose `changes` holds only the fields that differ.
4. The interaction stores the transcript, the location and the user id; the
   display name is always "Demo User".
5. A background task embeds the profile with `text-embedding-3-large` and
   upserts it into `individual_embeddings` on `individual_id`, so re-saves
   refresh the vector. Failures are logged and do not affect the save.

## 6. Voice assistant

`mobile/screens/ModernVoiceAssistantScreen.tsx` and `backend/main.py`.

1. The screen opens `WS /api/voice-assistant/realtime/ws` with the
   `Authorization` header. The backend verifies the token before accepting
   (close code 1008 otherwise).
2. The backend creates an ephemeral key at OpenAI, connects to the
   `gpt-realtime` WebSocket and sends a `session.update`: short, practical
   outreach guidance, audio output, 24 kHz PCM, server-side voice activity
   detection.
3. When the worker speaks a question, the app records it and posts it to
   `POST /api/voice-assistant/transcribe` (multipart `audio`, `whisper-1` only).
   It then sends the text over the socket as a `conversation.item.create` with
   `input_text`, followed by `response.create`. Typed questions take the same
   route.
4. For each text message, the proxy pulls capitalised names out of it
   (`services/context_service.py`), looks them up in `individuals` (results
   cached for five minutes) and, if anyone matches, first sends a system message
   starting `CONTEXT:` with their urgency, age, gender, height, weight, medical,
   substance, behaviour, housing and veteran fields.
5. OpenAI's reply streams back through the proxy. The app plays the audio and
   shows the transcript. When either side disconnects, the proxy stops both
   directions and closes the upstream socket.

`POST /api/voice-assistant/context` exposes step 4 on its own, for debugging.
