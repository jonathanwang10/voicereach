# Voice pipeline

How a voice note becomes a saved record, and how the voice assistant answers a
question. File paths are relative to the repo root.

## 1. Recording (app)

`mobile/components/ModernAudioRecorder.tsx`, on the Record tab.

- **Format:** M4A with AAC at 64 kbps. iOS uses expo-av's `LOW_QUALITY` preset
  (which is AAC `.m4a`); Android overrides it with an explicit AAC/MPEG-4 config.
- **Length:** 5 s minimum (stopping earlier shows "Too Short" and keeps
  recording), 2 min maximum. The progress bar turns amber at 1:30 and red at
  1:45, a warning alert appears at 1:45, and recording stops itself at 2:00.
- **Location:** when recording starts, the app asks for location permission,
  reads the GPS position and reverse-geocodes it with `expo-location`. If that
  fails, recording continues without a location.

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
   weight) and for height in inches. The reply is then cleaned per type:
   - numbers become floats; a height given as text ("5 ft 10", `5' 10"`) is
     parsed to inches, and a bare number under 10 is treated as feet;
   - single-select values must match an option label (case-insensitive) or
     become `null`;
   - multi-select values become a list, keeping only known options
     (case-insensitive).
4. **Validate.** `validation_helper.validate_categorized_data` returns
   `missing_required` and `validation_errors` (height and weight outside 0-300,
   non-numeric or non-finite numbers, unknown select options).
5. **Find duplicates.** `duplicate_detection_service.find_duplicates` needs a
   name of at least two characters. It collects up to 50 candidates: exact name
   (case-insensitive), partial name, then a text scan of the JSONB `data` of the
   200 most recently updated people. LIKE wildcards in the name are escaped.
   `gpt-4o` scores the first three candidates 0-100; scores below 60 are dropped
   and only the single best match is returned. If the LLM call fails, a simple
   name comparison stands in. A failure here never fails the request.
6. **Respond.** `{transcription, categorized_data, missing_required,
   validation_errors, potential_matches}`. Nothing is saved yet.

## 4. Review (app)

`mobile/components/TranscriptionResults.tsx`.

- The worker sees the transcript and an editable form of the extracted fields.
  Save is blocked until every required category has a value.
- If there is a match, Save opens `MergeUI`, which loads the existing profile and
  shows the fields side by side, defaulting each to the new value. The worker
  can merge (the payload gets `merge_with_id`), create a new person anyway, or
  cancel. There is no automatic merge at any confidence.
- With no match, Save creates a new person.
- Before saving, height is converted to inches (`mobile/utils/height.ts`), and
  the transcript and recording location are attached.

Manual entry (`ManualEntryForm.tsx`) follows the same path, except duplicates
come from `POST /api/individuals/check-duplicates`.

## 5. Save

`POST /api/individuals` (`backend/api/individuals.py`,
`backend/services/individual_service.py`).

1. The request model requires `name`, `height` and `weight`. If `merge_with_id`
   is set, that person must exist (404 otherwise). The data is validated against
   the categories again (400 with details on failure).
2. The urgency score is computed (`urgency_calculator.py`): weighted average of
   `number` and `single_select` fields, or 100 if an auto-trigger fires. For a
   single-select auto-trigger that means the chosen option's value is > 0.
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
