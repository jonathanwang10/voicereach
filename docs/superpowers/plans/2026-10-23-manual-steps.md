# Hardening round 2: manual steps for the owner

Agents never apply anything to the hosted Supabase project or Railway (roadmap,
owner decision 2). Every step that needs the owner is listed here, by phase.

## Apply migrations

Apply in this order (Supabase SQL editor, or `psql "$SUPABASE_DB_URL" -f <file>`).
Each file is idempotent.

- Phase 1: no migrations.

1. `supabase/migrations/20261102000001_save_individual.sql` (Phase 2, Task 3): run in the SQL Editor. Check: `select version, count(*) from individuals group by 1;` returns version 1 for every row.
2. `supabase/migrations/20261102000002_interactions_append_only.sql` (Phase 2, Task 8). Check: `update interactions set user_name = user_name where false;` succeeds, and the same without `where false` fails with "interactions are append-only".
3. `supabase/migrations/20261102000003_audit_log.sql` (Phase 2, Task 9). Check: `delete from audit_log;` fails with "audit_log is append-only".
4. `supabase/migrations/20261102000004_number_scale_max.sql` (Phase 2, Task 11). Check: `select number_scale_max from categories;` is null for every existing row (scores unchanged).
5. `supabase/migrations/20261102000005_rescore_batch.sql` (Phase 2, Task 13). Then: `cd backend && python scripts/rescore_urgency.py`.
6. `supabase/migrations/20261102000006_name_trigram_index.sql` (Phase 2, Task 14). Before it, see Owner actions item 5 (pg_trgm's schema).
7. `supabase/migrations/20261102000007_coarsen_old_locations.sql` (Phase 2, Task 15). Check: `select coarsen_old_locations(30);` returns a count; a second run returns 0.
8. `supabase/migrations/20261103000001_categories_is_sensitive.sql` (Phase 3, Task 1), then `cd backend && python scripts/rescore_urgency.py`. Then check `SELECT name, urgency_weight, auto_trigger FROM categories WHERE is_sensitive AND (urgency_weight > 0 OR auto_trigger);`: those rows no longer score; the owner decides whether to clear their weights.
9. `supabase/migrations/20261103000002_find_duplicate_candidates.sql` (Phase 3, Task 6; needs migration 6, `pg_trgm`, first). Check: `SELECT name FROM find_duplicate_candidates('Jon Smith');` returns a "John Smith" if one exists.
10. `supabase/migrations/20261103000003_duplicate_decisions.sql` (Phase 3, Task 10).
11. `supabase/migrations/20261104000001_pgvector_halfvec_embeddings.sql` (Phase 4, Task 1). Before it, check `select extversion from pg_extension where extname = 'vector';` and expect `0.7.0` or later. If no row comes back, the migration installs it; if it's older than 0.7.0, run `ALTER EXTENSION vector UPDATE;` first.
12. `supabase/migrations/20261104000002_hybrid_search.sql` (Phase 4, Task 4; the generated column rewrites `individuals` once). Smoke check: `select name, match_source from search_individuals_hybrid('John Doe', null, 5);` returns John Doe first with `match_source = 'exact'`.
13. `supabase/migrations/20261104000003_interaction_embeddings.sql` (Phase 4, Task 5).
14. `supabase/migrations/20261104000004_most_urgent.sql` (Phase 4, Task 7).
    Then (after the Phase 4 migrations) run `cd backend && python scripts/backfill_embeddings.py --stale` once. It embeds every visit transcript, plus each person whose text changed now that sensitive fields are left out.
15. `supabase/migrations/20261107000001_recordings.sql` (Phase 7, Task 1). Check: `select count(*) from recordings;` returns 0.
16. `supabase/migrations/20261107000002_recording_jobs.sql` (Phase 7, Task 1). Check: `select * from claim_recording_job();` returns no rows.

## Environment variables

| Name | Default | Service | Phase |
|---|---|---|---|
| `CHAT_MODEL` | `gpt-4o` | backend | 1 |
| `TRANSCRIBE_MODEL` | `gpt-transcribe` (Phase 3; was `whisper-1` in Phase 1) | backend | 1, 3 |
| `REALTIME_MODEL` | `gpt-realtime-2.1` (Phase 5 Task 6; `gpt-realtime` shuts down 2027-01-20) | backend | 1, 5 |
| `EMBEDDING_MODEL` | `text-embedding-3-large` | backend | 1 |
| `RATE_LIMIT_SAVE_PER_MIN` | 30 | backend | 1 |
| `RATE_LIMIT_CATEGORY_CREATE_PER_MIN` | 10 | backend | 1 |
| `RATE_LIMIT_DELETE_PER_MIN` | 30 | backend | 1 |
| `RATE_LIMIT_<NAME>_TOTAL_PER_MIN` | 5 x that bucket's per-device limit | backend | 1 |
| `REALTIME_MAX_SESSIONS_PER_USER` | 2 (per user + `X-Device-Id`) | backend | 1 |
| `REALTIME_MAX_SESSIONS_TOTAL` | 20 (per process) | backend | 1 |
| `DUPLICATE_MODEL` | `gpt-4o-mini` | backend | 3 |
| `ENABLE_API_DOCS` | unset (off; `1` serves `/docs`, `/redoc`, `/openapi.json`) | backend | 1 |
| `RECORDING_WORKER_CONCURRENCY` | 2 (how many recording jobs run at once in the one process) | backend (Railway) | 7 |
| `RECORDING_WORKER_ENABLED` | 1 (set to 0 only to pause processing) | backend (Railway) | 7 |

## Device checks

Numbered steps with the expected result. Run them on a physical iPhone after a
native rebuild (`npx expo prebuild --platform ios && npx expo run:ios --device`).

- Phase 1: none (backend only).

1. D2.1 (Phase 2, Task 5) `expo-crypto` is a new native module: run `cd mobile && npx expo prebuild --platform ios` (or `pod install` in `mobile/ios`), rebuild with `npx expo run:ios`, record and save one person. Expected: the save succeeds and the backend log shows no 400 for `Idempotency-Key`.

2. D5.1 (Phase 5, Task 1) Native rebuild for Phase 5. `cd mobile && npm install && npx expo prebuild --platform ios && cd ios && pod install && cd .. && npx expo run:ios --device`. Expected: the build succeeds; `ios/Podfile.lock` gains `ExpoAudio` and `RNAudioAPI` (and, after Task 8, loses `EXAV`); `Info.plist` has no `UIBackgroundModes` `audio` entry. Commit the regenerated `ios/` (it stays committed). If pod install fails, follow the last row of the Phase 5 Task 1 decision table.
3. D5.2 (Phase 5, Task 1) Mic frames are 24 kHz. On the Assistant, start listening and speak for 5 s. Expected: the worker bubble shows a sensible transcript, and the reply addresses what was said. Garbled or sped-up/slowed audio means the recorder ignored `sampleRate`: add linear resampling from `buffer.sampleRate` to 24000 in `micStream.ts` (helper `resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array` in `audioProcessor.ts`, with a unit test) and re-check.
4. D5.3 (Phase 5, Task 3) Record-tab interruption. Start a field-note recording, record 10 s, then trigger Siri (or have someone call the phone). Expected: recording stops; "Recording was interrupted at 0:1x. You can keep what was recorded or record again." with Keep and Record again; Keep goes on to transcription with the audio up to the interruption. Also record 10 s normally: the file is about 40 KB (32 kbps).
5. D5.4 (Phase 5, Task 7) Speaker routing. Type a question on the Assistant, then ask one by voice with listening on. Expected: both replies play from the loudspeaker, not the earpiece, with the ringer switch on silent too. If the voice-mode reply uses the earpiece, apply the audio-route row of the Task 1 decision table and re-check.
6. D5.5 (Phase 5, Task 7) Streaming latency. Ask a question that needs a long answer. Expected: audio starts while the text is still growing (well under a second after the first words appear), with no gaps or clicks between chunks.
7. D5.6 (Phase 5, Task 8) Mic streaming. Tap the Assistant mic, ask "What should I do if someone is unresponsive?", then stay quiet. Expected: the bubble shows "[Listening...]", then the transcript; the answer arrives without tapping stop. Tap stop mid-sentence on a second question: it is still answered.
8. D5.7 (Phase 5, Task 8) Echo. Listening on, phone on a table, volume at maximum, ask for a long answer. Expected: the reply plays to the end without cutting itself off. If it cuts itself off, set `FULL_DUPLEX_MIC = false` in `mobile/utils/assistantMessages.ts`, rebuild, re-check (barge-in then works by tap only), and note the result here.
9. D5.8 (Phase 5, Task 8) Assistant mic vs Record tab. Assistant listening, switch to Record and record 10 s. Expected: the field note records normally (not paused, correct length); back on the Assistant, the mic is off.
10. D5.9 (Phase 5, Task 9) Barge-in by voice. During a long reply, say "Stop, a different question: where is the nearest shelter?". Expected: playback stops within about half a second; the next answer is about the shelter; asked "what were you saying?", the assistant doesn't repeat the unheard part. No error toast appears.
11. D5.10 (Phase 5, Task 9) Barge-in by tap. During a reply, tap the mic. Expected: playback stops at once and listening is on.
12. D5.11 (Phase 5, Task 9) Record tab while a reply streams. Ask a long question, switch to the Record tab during the reply, start a field note and record 10 s. Expected: the reply stops (its text stays), the recording isn't paused and its length is right.
13. D5.12 (Phase 5, Task 10) Reconnect. Open the Assistant, ask one question, put the app in the background for longer than `REALTIME_MAX_SESSION_SECONDS` (or turn on airplane mode for 10 s, turn it off, then return). Expected: the chat is still there and the badge returns to Connected within about 7 s without tapping Retry. With the backend stopped, three tries run and then the Retry card shows.
14. D5.13 (Phase 5, Task 11) Tools on the phone. With the seed data loaded, ask "When did we last see <a seed person's name>?". Expected: "let me check", then an answer with the visit date. Ask about a name that isn't in the database: the answer says there is no record. Ask "who is most urgent near the Mission?": people last seen there, most urgent first.
15. D6.1 (H2-6.12) (Phase 6, Task 3) Session storage upgrade. Install a build from `main` and let it sign in. Install this branch's build over it (`npx expo run:ios`, after Phase 6 Task 15). Expected: it opens straight to the Record tab with no "Can't sign in". In Xcode → Devices → the app → Download Container, `Library/Application Support/<bundle>/RCTAsyncLocalStorage_V1/manifest.json` holds a hex string for `sb-…-auth-token`, not JSON. Restore the phone from a backup made after the upgrade: the app opens signed in again (a fresh auto sign-in).
16. D6.2 (H2-6.1) (Phase 6, Task 4) Location offline. With location on, record once (this caches a fix). Turn on Airplane Mode, then record within 2 minutes. Expected: the review shows the location card with "Unknown Address", and the saved interaction has coordinates. In the location picker, with Airplane Mode on, Confirm returns a pin with "Unknown Address".
17. D6.3 (H2-6.3, H2-6.11) (Phase 6, Task 5) Mic prompt and VoiceOver. Fresh install: opening the Record tab shows no mic prompt; the first Record tap shows it. Deny it, tap again: the "Microphone access is off" alert; "Open Settings" opens VoiceReach's page in Settings. With VoiceOver on: the button reads "Start recording, button", and at 1:00 VoiceOver says "1 minute recorded". Rotate an iPad: the progress track resizes.
18. D6.4 (H2-6.6) (Phase 6, Task 7) Refetch. Open Search. Background the app, change a person's urgency override from another phone, and return. Expected: the list updates without pulling. Turn Airplane Mode on, then off, on the profile screen. Expected: the profile refetches once the connection is back. Offline at launch, Search shows "Couldn't load — tap to retry", not an endless spinner.
19. D6.5 (H2-6.10) (Phase 6, Task 11) Paging. With more than 50 people (`supabase/seed.sql` plus manual entries, or a local script), scroll Search to the end. Expected: the next page loads with a footer spinner, no row repeats, and scrolling stays smooth. Undo a delete near the bottom: the list scrolls to the restored row.
20. D6.6 (H2-6.14) (Phase 6, Task 14) App switcher. Swipe up to the app switcher from each of: Search, a profile, an open interaction detail, the location picker and a voice review. Expected: the card shows the white "VoiceReach" screen, never the content. Return: the content is back at once. A system permission prompt also shows the overlay behind it (expected).
21. D6.0 (H2-6) (Phase 6, Task 15) Rebuild first. Rebuild the iOS dev client (`cd mobile && npx expo run:ios --device`) before running the Phase 5 and Phase 6 device checks. The branch already carries the regenerated `ios/` (`npx expo prebuild --platform ios --no-install` and `pod install` ran; `Podfile.lock` gains ExpoAudio, RNAudioAPI, ExpoSecureStore, react-native-netinfo, RNFlashList and react-native-get-random-values and loses EXAV). Only the Xcode build and the run on a phone are left, which D5.1 also covers.

## Owner actions outside code

1. Request OpenAI zero data retention and, if records are real client data, a BAA.
2. Confirm the keys leaked in git history (2025: an OpenAI key and Supabase
   service-role keys) are revoked.
3. Run `eas init` for the mobile project (Phase 8 adds `mobile/eas.json`).
4. Choose the App Store bundle id (Phase 8 leaves a placeholder).
5. (Phase 2, Task 14) Check `select extnamespace::regnamespace from pg_extension where extname = 'pg_trgm';` returns `extensions`. If it says `public` (installed earlier), run `ALTER EXTENSION pg_trgm SET SCHEMA extensions;` then re-run migration 6.
6. (Phase 2, Task 15) Enable pg_cron (Dashboard → Database → Extensions), then run the commented `cron.schedule` line from `supabase/schema.sql` once. Check: `select jobname, schedule from cron.job;` lists `coarsen-old-locations`.
7. (Phase 3, Task 5) After deploying, make one recording and confirm the transcript comes back. If OpenAI rejects `prompt` or `response_format=json` for the default `gpt-transcribe`, set `TRANSCRIBE_MODEL` to another transcription model that accepts both (for example `gpt-4o-mini-transcribe` until its 2027-02-26 shutdown) and report it.
8. (Phase 3, Task 11) Record live extraction replies: `cd backend && EVAL_LIVE=1 python -m evals.eval_extraction --live --record && python -m evals.eval_extraction --update-baseline`, then review and commit the diff. This replaces the hand-written replies with real ones. Repeat after changing `CHAT_MODEL` or the schema.
9. (Phase 3, Task 12) Record live duplicate replies: `cd backend && EVAL_LIVE=1 python -m evals.eval_duplicates --live --record && python -m evals.eval_duplicates --update-baseline`, then review and commit the diff. Later, once `duplicate_decisions` has real labels, consider adding synthetic pairs that mirror the error patterns seen there; never copy real records.
10. **M5.1** (Phase 5, Task 11) Optionally run `cd backend && EVAL_LIVE=1 python -m evals.eval_assistant` with a real `OPENAI_API_KEY` after Phase 5 lands. Expected: five PASS lines; the absent-person answer says there is no record.
11. (Phase 7, Task 1) Create the private Storage bucket `recordings`: Dashboard → Storage → New bucket. Name `recordings`, Public **off**, file size limit 8 MB, allowed MIME type `audio/mp4`. Or run this in the SQL Editor:
    `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('recordings', 'recordings', false, 8388608, array['audio/mp4']) on conflict (id) do nothing;`
    Add no storage policies: the backend's service key is the only reader and writer. Check: `select public from storage.buckets where id = 'recordings'` returns `false`.
12. (Phase 7, Task 1) Optional: enable pg_cron and uncomment the `purge-old-recordings` line in `supabase/schema.sql`. The backend already purges hourly, and the cron line purges rows only (it leaves stored files behind).
