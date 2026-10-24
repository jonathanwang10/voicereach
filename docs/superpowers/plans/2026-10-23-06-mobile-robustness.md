# Phase 6: Mobile Robustness and Privacy Implementation Plan

> **For agentic workers:** Implement this plan task by task yourself, in order (no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Expo app hold up under real use (GPS failures, permission denials, slow networks, a crash, a long list) and keep case data off the device: in memory only, never in the app switcher, and with the stored session encrypted.

**Architecture:** Server state moves to TanStack Query with an in-memory cache only (no persister). It refetches when the app comes to the foreground (`focusManager` + AppState) and when the network comes back (`onlineManager` + NetInfo), and the cache is cleared on Sign Out. A root `ErrorBoundary` and an app-switcher `PrivacyOverlay` wrap the app. Navigation moves to the native stack with typed params, and Search moves to FlashList, reading the list a page at a time through a cursor. The Supabase session is stored with Supabase's LargeSecureStore pattern. Location capture and the mic-permission prompt move out of `ModernAudioRecorder.tsx` into small modules, so Phase 5's rewrite of that file's audio code doesn't conflict with this phase.

**Tech Stack:** Expo SDK 53, React Native 0.79.6 (New Architecture on: `app.json` `newArchEnabled: true`), React 19, TypeScript 5.8, Jest (jest-expo 53). New libraries: `@tanstack/react-query` ^5.90.5, `@react-native-community/netinfo` 11.4.1, `@shopify/flash-list` 1.7.6, `@react-navigation/native-stack` ~7.3.26, `expo-secure-store` ~14.2.4, `react-native-get-random-values` ~1.11.0, `aes-js` 3.1.2 (+ `@types/aes-js` 3.1.4). Backend: FastAPI (one route).

**Spec:** `docs/superpowers/plans/2026-10-23-00-roadmap.md` (Phase 6, plus Owner decisions and Global constraints). Executors read the roadmap first, then this plan.

## Library facts relied on (checked 2026-10-23)

- **Versions for SDK 53** come from `mobile/node_modules/expo/bundledNativeModules.json` (what `npx expo install` installs): netinfo `11.4.1`, flash-list `1.7.6`, expo-secure-store `~14.2.4`, react-native-get-random-values `~1.11.0`, react-native-screens `~4.11.1` (already installed). Native modules are installed with `npx expo install <pkg>`. Plain JS packages are installed with `npm install`.
- **FlashList v1, not v2.** v2 runs only on the New Architecture. This app has it on, so v2 would run, but SDK 53 bundles 1.7.6, and v2 would fail `npx expo install --check` (Phase 8 runs it in CI). v1 needs `estimatedItemSize`, has no `onScrollToIndexFailed`, and is a class component whose `scrollToIndex` can be spied on its prototype. Jest needs `require('@shopify/flash-list/jestSetup')` (FlashList 1.x testing docs).
- **native-stack 7.3.26** has peer `@react-navigation/native ^7.1.17`, which is the installed version (7.1.17). Later 7.x releases need native ^7.5, so don't install `@latest`. `freezeOnBlur` is a per-screen option on bottom tabs and native stack (react-native-screens ≥ 3.16): a hidden screen stops re-rendering, but its timers and promises keep running and its effects don't run until it is shown again.
- **TanStack Query v5 on React Native** (TanStack React Native docs):
  - Online status: `onlineManager.setEventListener(setOnline => NetInfo.addEventListener(state => setOnline(...)))`.
  - App focus: `AppState.addEventListener('change', s => focusManager.setFocused(s === 'active'))`.
  - Screen focus: a `useRefreshOnFocus` built on `useFocusEffect` that skips the first focus.
  - `onlineManager.setEventListener` runs its setup at once.
  - `isRefetchError` is true only when a refetch failed while data was already there.
  - `select` results are structurally shared, so the same data keeps the same array.
- **NetInfo's mock** is `@react-native-community/netinfo/jest/netinfo-mock.js`. At launch `isConnected` can be `null` (unknown).
- **Supabase LargeSecureStore** (Supabase "Expo React Native" tutorial):
  - imports `AsyncStorage`, `expo-secure-store`, `aes-js` and `'react-native-get-random-values'`;
  - `_encrypt` makes a fresh 256-bit key per write (`crypto.getRandomValues(new Uint8Array(256 / 8))`), encrypts with `new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(1))`, stores the key hex in SecureStore under the same key, and returns the ciphertext hex;
  - `getItem`, `setItem` and `removeItem` read and write the ciphertext in AsyncStorage (`removeItem` also deletes the SecureStore key);
  - install: `npm install aes-js react-native-get-random-values`, `npm install --save-dev @types/aes-js`, `npx expo install expo-secure-store`.
  - The tutorial has no migration path from a plaintext session. Task 3 adds one.
- **expo-secure-store** keys may contain only `[A-Za-z0-9._-]`. Supabase's key, `sb-<ref>-auth-token`, qualifies. `keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` keeps the key out of iCloud Keychain and device backups.
- **expo-location** `getLastKnownPositionAsync({ maxAge, requiredAccuracy })` returns `null` when no cached fix meets both.
- **`expo-screen-capture` ~7.2.0** (SDK 53) does have `enableAppSwitcherProtectionAsync`, a native blur. It is not used here: the roadmap asks for an opaque overlay with the app name, and the overlay below also covers modals (Task 14).

## Deviations from roadmap

1. **Item 4, the env var name.** The variable is `EXPO_PUBLIC_API_BASE_URL` (`mobile/config/api.ts:7`, `.env.example`, README), not `EXPO_PUBLIC_API_URL`. The check uses the real name.
2. **Item 10, the cursor key.** The cursor has the form `?cursor=<timestamp>,<id>&limit=50` and the response returns `next_cursor`, as specified. But the timestamp is the row's **`last_seen`**, not `updated_at`.
   - Why: the default list is ordered by `last_seen`, meaning the latest interaction, else `created_at` (`individual_service.py:385-390`). `test_last_seen_is_latest_interaction_else_created_at_never_updated_at` pins that order.
   - Keying on `updated_at` would reorder the list. Every re-score bumps `updated_at` for every row (`individual_service.py:70`), and so does every override, though neither is a sighting.
   - No column holds `last_seen`, so the keyset is applied in Python, over the full read the endpoint already does through Phase 1's `fetch_all`.
   - What this buys: stable pages (no repeats when someone new is recorded mid-scroll), 50-row payloads, and correct results past 1,000 rows. It doesn't shrink the server read.
   - When to do more: once the table outgrows an in-memory read, add an `individuals.last_seen_at` column maintained by Phase 2's `save_individual` and move the keyset into SQL. This is recorded in README.
3. **Item 13, the temp file.** It is already deleted when sharing throws (`utils/csvExport.ts:41-49`, test `deletes the cached file even when sharing fails, and rethrows`). Task 13 extends this to a failed *write*, which today leaves a partial file behind.
4. **Item 3, Record screen.** There is no separate upload step: one `POST /api/transcribe` carries the audio inline. So `isUploading` and `uploadError` are removed rather than "set". There is one "Transcribing..." state and one error, which carries the backend's reason.
5. **Item 14, overlay placement.** React Native `Modal`s render in their own native window above the root view, so a root overlay can't cover them. `PrivacyOverlay` is therefore also rendered inside the two modals that show case data (`InteractionDetailModal`, `LocationPicker`).
6. **Item 8, profile presentation.** The JS stack showed the profile with `forModalPresentationIOS` but dismissed it with a horizontal gesture (`App.tsx:28-58`). The native stack uses the standard iOS push (`presentation: 'card'`).
7. **Item 6, network mode.** Queries and mutations use `networkMode: 'always'`. Otherwise TanStack pauses requests while NetInfo reports offline, so the Search "Couldn't load — tap to retry" state (C-17) and the override's error toast would never appear. `onlineManager` still triggers the refetch on reconnect.
8. **Search's scroll retry.** FlashList v1 has no `onScrollToIndexFailed` and computes offsets itself, so `handleScrollToIndexFailed` (`ModernSearchScreen.tsx:186-197`) and its test `retries a failed scrollToIndex at most once` are removed.
9. **(Task 3, during execution) Migration checks for plaintext first.** `getItem` re-encrypts a value
   that starts with `{` whether or not the Keychain still has an old key for it (ciphertext is hex,
   so it never starts with `{`); only then does a missing key mean "ciphertext whose key is gone".
   This covers the two specified cases and also a plaintext session next to a stale key.
   `npx expo install expo-secure-store` added its config plugin to `app.json` (committed); the
   native rebuild is Task 15 / the device checks. The full checks for this task also turned up
   a flaky Phase 3 test (`test_the_last_seen_area_is_sent_for_both_sides` asserted `"123"` was
   absent from a prompt that holds a random UUID); its assertion now names the house numbers.

## Global Constraints

- Mobile only, plus one backend change: cursor pagination on `GET /api/individuals`.
- Sign-in behaviour is unchanged: the app still auto-signs in as the demo account (Owner decision 1). Encrypting the stored session is in scope; an app lock is not.
- Checks that must pass at the end of every task:
  - `python -m pytest -q` (repo root, offline);
  - `ruff check backend --select F,E9`;
  - `cd mobile && npx tsc --noEmit && npx jest`.
- Python 3.11. Recreate the venv first if needed: `python3.11 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt -r requirements-dev.txt`.
- Tests are offline. No test calls OpenAI or Supabase. `FakeSupabase` and `FakeListDB` are strict.
- CLAUDE.md rules still hold:
  - no unauthenticated routes;
  - never call `supabase.from` in `mobile/`;
  - all data goes through the backend;
  - no PII in logs (`mobile/test/noDataLogs.test.ts`: every `console.*` is guarded by `__DEV__` on the same line and logs error objects only).
- **Memory only.** No TanStack persister, and no case data written to AsyncStorage, SecureStore or files. The only new things stored on the device are the device id and the encrypted session.
- **Phase 5 boundary.** Phase 5 rewrites the audio code in `components/ModernAudioRecorder.tsx` and `screens/ModernVoiceAssistantScreen.tsx`.
  - In the recorder, this phase changes only location capture (moved to `utils/location.ts`), the mic-permission prompt (moved to `utils/micPermission.ts`), the error toasts that replace `ErrorHandler`, accessibility, and `useWindowDimensions`.
  - It doesn't touch the Assistant screen beyond its `utils/errors` import.
  - Phase 6 may run before Phase 5. Phase 5 must keep these call sites: `ensureMicPermission(...)` on the first tap, `captureLocation()` and `awaitLocation()`, the Record button's accessibility props, and the minute announcement.
  - If Phase 5 has already landed, the recorder uses expo-audio and its test file mocks `expo-audio` and `services/audioSession` and advances time with `at(ms)`. Write this phase's recorder tests in that style: pass `requestRecordingPermissionsAsync` to `ensureMicPermission`, assert on `prepareToRecordAsync` instead of `mockCreateAsync`, and use `at(60_000)` instead of `tick(60_000)`.
  - The completion callback `onRecordingComplete(uri, location)` is unchanged here; Phase 7 adds `durationMs`.
- **Phase 4 overlap.** Phase 4 adds a 600 ms pause before semantic search on the Search screen. If it has landed, keep that behaviour and its test inside `useIndividualSearch` (Task 11). Whichever phase lands second rebases.
- **Phase 2 and 3 overlap.** Both edit `MergeUI` and `TranscriptionResults` (409 handling, "Other possible matches"). Keep this phase's edits to those files to the category and fetch lines named in Task 8 and Task 12.
- **Installs:**
  - native modules: `npx expo install <pkg>` (SDK 53 versions above);
  - JS packages: `npm install <pkg>@<version>`;
  - never `@latest` for `@react-navigation/*`.
- New jest mocks for native modules go in `mobile/test/setup.js` (Tasks 2, 3, 7, 11).
- Git:
  - Work on branch `hardening-2`; never commit to `main`.
  - One commit per task, conventional prefix, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Never commit `.env` files.
- Device-only checks are appended to `docs/superpowers/plans/2026-10-23-manual-steps.md` under **Device checks**.
  - Number the entries to continue the file's numbering, and tag each `(H2-6.n)`.
  - Phase 1 creates the file. If it doesn't exist yet, create it with the four sections the roadmap lists.
  - These checks never block a task.
- Code comments match the surrounding style: short "why" comments with codes `(H2-6.<item>)`, for example `(H2-6.12)` for the session storage.
- When a task changes a rule that CLAUDE.md or README states, the same task updates them.

## Review Focus

1. **Connectivity is unknown or offline at launch** (NetInfo `isConnected: null`, or `false`). Search must still request and then show "Couldn't load — tap to retry". It must not sit on a spinner because TanStack paused the query. Pinned in Task 7 (`networkMode: 'always'`, and `null` counts as online).
2. **Sign Out, then Sign In.** No person from the previous session may reappear from the memory cache. Pinned in Task 7 (the cache is cleared when `user` becomes null).
3. **An existing install upgrades.** If the phone holds a plaintext session (old build), or ciphertext with no Keychain key (a restored backup), the app must open signed in. It migrates the session, or falls back to the normal auto sign-in, and never crashes or shows "Can't sign in". Pinned in Task 3.
4. **Categories refetch while the worker types a manual entry** (the app comes back to the foreground). Typed values must survive. Pinned in Task 8.
5. **The app switcher opens while an interaction's transcript modal is showing.** The overlay must cover the modal, not just the screen behind it. Pinned in Task 14, plus device check (H2-6.14).

---

### Task 1: Replace the legacy ErrorHandler with `utils/errors.ts`

**Files:**
- Create: `mobile/utils/errors.ts`
- Delete: `mobile/utils/errorHandler.ts`, `mobile/utils/__tests__/errorHandler.test.ts`
- Create: `mobile/utils/__tests__/errors.test.ts`
- Modify (import path only): `contexts/AuthContext.tsx:4`, `contexts/CategoryContext.tsx:3`, `utils/delayedDelete.ts:11`, `screens/ModernRecordScreen.tsx:23`, `screens/ModernSearchScreen.tsx:23`, `screens/ModernVoiceAssistantScreen.tsx:21`, `screens/UserProfileScreen.tsx:12`, `screens/CategoriesScreen.tsx:20`, `screens/ModernIndividualProfileScreen.tsx:19`, `components/TranscriptionResults.tsx:5`, `components/MergeUI.tsx:4`, `components/ManualEntryForm.tsx:5`, the comment at `services/api.ts:11`
- Modify: `components/ModernAudioRecorder.tsx:14,120-134,227-231,266-274` (only the `ErrorHandler` calls)
- Test: `mobile/components/__tests__/ModernAudioRecorder.test.tsx`

**Interfaces:**
- Produces:
  - `errorMessage(e: unknown): string`, moved unchanged from `errorHandler.ts:204-214`;
  - `showApiError(e: unknown, title?: string): void`, moved unchanged from `errorHandler.ts:217-227`;
  - `RECORDING_FAILED = 'Could not record audio. Please try again.'`.

- [x] **Step 1: Write the failing tests.** Move the `errorMessage`/`showApiError` cases from `errorHandler.test.ts` into `errors.test.ts`, importing from `../errors`. Drop the `ErrorHandler.handleError` cases. Add to `ModernAudioRecorder.test.tsx`:

```tsx
it('a failed start shows one "Recording failed" toast with a plain message', async () => {
  mockCreateAsync.mockRejectedValueOnce(new Error('Only one Recording object can be prepared'));
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  expect(Toast.show).toHaveBeenCalledTimes(1);
  expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
    text1: 'Recording failed', text2: 'Could not record audio. Please try again.' });
});
```
(Add `jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }))` and `import Toast from 'react-native-toast-message'` to the file.)

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest utils/__tests__/errors.test.ts components/__tests__/ModernAudioRecorder.test.tsx`
Expected: FAIL. `Cannot find module '../errors'`, and the toast has `text1: 'Error'`.

- [x] **Step 3: Implement.**
  - Create `utils/errors.ts` with the two functions and the constant.
  - Point every listed import at `../utils/errors` (or `./errors`).
  - In the recorder, replace each `ErrorHandler.handleRecordingError(...)`/`showError` pair with `showApiError(RECORDING_FAILED, 'Recording failed')`. Leave the mount-time permission effect (lines 120-134) as it is for now, calling `showApiError('Allow microphone access to record.', 'Microphone')`; Task 5 replaces it.
  - Delete `errorHandler.ts` and its test.
  - `grep -rn "errorHandler\|ErrorHandler" mobile --include='*.ts*' --exclude-dir=node_modules --exclude-dir=ios` must print nothing. If Phase 5 has already rewritten the recorder, replace whatever `ErrorHandler` calls remain in the same way.

- [x] **Step 4: Run the checks.**
Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: PASS.

- [x] **Step 5: Commit.**
```bash
git add -A mobile/utils mobile/contexts mobile/screens mobile/components mobile/services/api.ts
git commit -m "refactor(mobile): remove the legacy ErrorHandler in favour of showApiError (H2-6.16)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fail fast on a missing backend URL, and send `X-Device-Id`

**Files:**
- Modify: `mobile/config/api.ts:3-7`
- Create: `mobile/services/deviceId.ts`; and `mobile/utils/requestId.ts` only if Phase 2 hasn't landed (see Interfaces)
- Modify: `mobile/services/api.ts:65-72,93-118` (`buildHeaders`, `authedFetch`)
- Test: `mobile/config/__tests__/api.test.ts`, `mobile/services/__tests__/deviceId.test.ts` (new), `mobile/services/__tests__/apiRequest.test.ts`
- Docs: `README.md` (the `mobile/.env` table at about lines 269-278; a new **On the phone** list after **What is logged**, about line 559)

**Interfaces:**
- Produces:
  - No UUID helper of this phase's own. The app's one UUID helper is Phase 2's `mobile/utils/requestId.ts: newRequestId(): string` (`expo-crypto`'s `randomUUID()`). If Phase 2 hasn't landed yet, create that file exactly as Phase 2 Task 5 specifies (`npx expo install expo-crypto`, plus the `jest.mock('expo-crypto', ...)` line in `test/setup.js`); Phase 2 then finds it and keeps it. `react-native-get-random-values` is installed in Task 3, only for `aes-js`.
  - `getDeviceId(): Promise<string>` and `__resetDeviceIdForTests(): void` in `services/deviceId.ts`.
    - Storage key: `DEVICE_ID_KEY = 'voicereach.device_id'`.
    - The first call reads AsyncStorage. If nothing is stored, it creates `newRequestId()` and stores it.
    - The promise is memoised, so concurrent first calls agree.
    - If AsyncStorage throws, it returns an in-memory id for this run.
  - Every `authedFetch` request carries the header `X-Device-Id: <id>`. Phase 1 reads it for rate limits and Phase 2 for the audit log, both through Phase 1's `backend/api/device.py: get_device_id`, which treats the header as optional.

- [x] **Step 1: Write the failing tests.**

```ts
// config/__tests__/api.test.ts
it('throws at startup in a release build when EXPO_PUBLIC_API_BASE_URL is unset (H2-6.4)', () => {
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
  (global as any).__DEV__ = false;
  try { expect(() => require('../api')).toThrow(/EXPO_PUBLIC_API_BASE_URL/); }
  finally { (global as any).__DEV__ = true; }
});
it('keeps the localhost default in development', () => { /* __DEV__ true, unset -> 'http://localhost:8001' (existing test) */ });

// services/__tests__/deviceId.test.ts
beforeEach(async () => { __resetDeviceIdForTests(); await AsyncStorage.clear(); });
it('creates one v4 UUID, stores it, and returns the same id afterwards', async () => {
  const id = await getDeviceId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await AsyncStorage.getItem('voicereach.device_id')).toBe(id);
  __resetDeviceIdForTests();
  expect(await getDeviceId()).toBe(id);   // read back from storage, not regenerated
});
it('concurrent first calls agree', async () => {
  const [a, b] = await Promise.all([getDeviceId(), getDeviceId()]);
  expect(a).toBe(b);
});
it('still returns an id when storage fails', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
  expect(await getDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
});

// services/__tests__/apiRequest.test.ts (mock '../deviceId' -> getDeviceId: async () => 'dev-1')
it('sends X-Device-Id on every request, the 401 retry included', async () => { /* 401 then 200; both calls' headers['X-Device-Id'] === 'dev-1' */ });
```

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest config services/__tests__/deviceId.test.ts services/__tests__/apiRequest.test.ts`
Expected: FAIL (no throw; `Cannot find module '../deviceId'`; header missing).

- [x] **Step 3: Install and implement.**
  - In `config/api.ts`, when `!__DEV__ && !process.env.EXPO_PUBLIC_API_BASE_URL`, throw `new Error('The backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL in mobile/.env, then rebuild the app.')`. Keep the localhost default for `__DEV__`.
  - `buildHeaders(init, token, deviceId)` adds `'X-Device-Id': deviceId`. `authedFetch` awaits `getDeviceId()` once per call.
  - The Assistant's WebSocket handshake (`ModernVoiceAssistantScreen.tsx:509`): if Phase 5 has already landed (the screen has `connect({ quiet })`), add `'X-Device-Id': await getDeviceId()` beside `Authorization` there, with a screen test asserting the header. Otherwise leave the screen alone: Phase 5 Task 10 adds it.

- [x] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest config services`
Expected: PASS.

- [x] **Step 5: Docs.**
  - README `mobile/.env` table: `EXPO_PUBLIC_API_BASE_URL` is required in release builds (the app stops at startup without it); `localhost` is the default only in development.
  - Add an **On the phone** list after **What is logged**. Its first bullet: "A random device id (`voicereach.device_id` in AsyncStorage) is sent as `X-Device-Id` so rate limits and the audit log can tell phones on the shared account apart. It is not derived from the hardware."

- [x] **Step 6: Run the global checks and commit.**
```bash
git add mobile/config mobile/utils mobile/services mobile/screens mobile/test/setup.js mobile/package.json mobile/package-lock.json README.md
git commit -m "feat(mobile): fail fast without a backend URL and send X-Device-Id (H2-6.4, H2-6.15)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Encrypted session storage (LargeSecureStore) with migration

**Files:**
- Create: `mobile/services/secureSessionStorage.ts`
- Modify: `mobile/services/supabase.ts:1-29` (`storage: new LargeSecureStore()`)
- Modify: `mobile/test/setup.js` (in-memory `expo-secure-store` mock; `react-native-get-random-values` mock and the `crypto` polyfill)
- Modify: `mobile/package.json` (`npx expo install expo-secure-store react-native-get-random-values`; `npm install aes-js@3.1.2`; `npm install --save-dev @types/aes-js@3.1.4`)
- Test: `mobile/services/__tests__/secureSessionStorage.test.ts` (new), `mobile/services/__tests__/supabase.test.ts`
- Docs: README "Data leaving the system" row "The worker's email and session tokens" (about line 531) and the **On the phone** list; manual-steps **Device checks**

**Interfaces:**
- Produces `class LargeSecureStore { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }`. It follows Supabase's example (see Library facts), plus:
  - SecureStore writes pass `{ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }`.
  - **Migration in `getItem`.** If AsyncStorage holds a value but SecureStore has no key for it:
    - when the value starts with `{` (the plaintext JSON the old `storage: AsyncStorage` wrote), re-save it through `setItem` (encrypting it in place) and return it;
    - otherwise (ciphertext whose key is gone, for example a restored backup), remove it from AsyncStorage and return `null`. The normal auto sign-in then runs.

- [x] **Step 1: Write the failing tests** (`beforeEach`: `AsyncStorage.clear()` and `(SecureStore as any).__store.clear()`).

```ts
const KEY = 'sb-abc-auth-token';
const SESSION = JSON.stringify({ access_token: 'secret-token', refresh_token: 'r' });
it('AsyncStorage never holds the plaintext session', async () => {
  await new LargeSecureStore().setItem(KEY, SESSION);
  const raw = await AsyncStorage.getItem(KEY);
  expect(raw).toMatch(/^[0-9a-f]+$/);
  expect(raw).not.toContain('secret-token');
  expect(await SecureStore.getItemAsync(KEY)).toMatch(/^[0-9a-f]{64}$/);
});
it('round-trips the session', async () => { /* setItem then getItem === SESSION */ });
it('uses a fresh key for every write', async () => { /* two setItem calls -> different SecureStore values */ });
it('keeps the key on this device only', async () => {
  await new LargeSecureStore().setItem(KEY, SESSION);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY, expect.any(String),
    { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
});
it('migrates a plaintext session written by the old storage', async () => {
  await AsyncStorage.setItem(KEY, SESSION);
  expect(await new LargeSecureStore().getItem(KEY)).toBe(SESSION);
  expect(await AsyncStorage.getItem(KEY)).toMatch(/^[0-9a-f]+$/);
});
it('drops ciphertext whose key is gone instead of failing', async () => {
  await AsyncStorage.setItem(KEY, 'abcdef0123');
  expect(await new LargeSecureStore().getItem(KEY)).toBeNull();
  expect(await AsyncStorage.getItem(KEY)).toBeNull();
});
it('removeItem clears both stores', async () => { /* ... both null */ });

// services/__tests__/supabase.test.ts: capture createClient's options in a `mockCreateArgs` variable
it('stores the session through LargeSecureStore (H2-6.12)', () => {
  expect(mockCreateArgs[2].auth.storage).toBeInstanceOf(LargeSecureStore);
});
```

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest services/__tests__/secureSessionStorage.test.ts services/__tests__/supabase.test.ts`
Expected: FAIL (`Cannot find module '../secureSessionStorage'`).

- [x] **Step 3: Install and implement.**
  - Run the installs (`react-native-get-random-values` should come out at `~1.11.0`). It is here only because `aes-js` key generation needs `crypto.getRandomValues`; UUIDs come from Phase 2's `newRequestId()`.
  - In `test/setup.js`, add `jest.mock('react-native-get-random-values', () => ({}))`, and define `globalThis.crypto` from Node's `require('crypto').webcrypto` when `globalThis.crypto?.getRandomValues` is missing.
  - Add the SecureStore mock to `test/setup.js`. It is a factory-local `Map` exposed as `__store`, with `getItemAsync`/`setItemAsync`/`deleteItemAsync` as `jest.fn` over it, and `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'`.
  - Write `secureSessionStorage.ts` with `import 'react-native-get-random-values'` first.
  - `supabase.ts` passes `storage: new LargeSecureStore()`. Nothing else changes: the same demo sign-in and the same `autoRefreshToken`/`persistSession`.

- [x] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest services`
Expected: PASS.

- [x] **Step 5: Docs and device check.**
  - README row: "Supabase Auth; on the phone the session is AES-256 encrypted in AsyncStorage, with its key in the iOS Keychain (this device only)". Add the same as an **On the phone** bullet.
  - Manual steps, Device checks:
    > (H2-6.12) Install a build from `main` and let it sign in. Install this branch's build over it (`npx expo run:ios`, after Task 15). Expect: it opens straight to the Record tab with no "Can't sign in". In Xcode → Devices → the app → Download Container, `Library/Application Support/<bundle>/RCTAsyncLocalStorage_V1/manifest.json` holds a hex string for `sb-…-auth-token`, not JSON. Restore the phone from a backup made after the upgrade: the app opens signed in again (a fresh auto sign-in).

- [x] **Step 6: Run the global checks and commit.**
```bash
git add mobile/services mobile/test/setup.js mobile/package.json mobile/package-lock.json README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): encrypt the stored session with LargeSecureStore and migrate the old one (H2-6.12)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

If `npx expo install expo-secure-store` added a `plugins` entry to `app.json`, commit that too. Task 15 runs the prebuild.

---

### Task 4: Location keeps coordinates without an address; the map is uncontrolled

**Files:**
- Modify: `mobile/utils/location.ts` (adds capture helpers)
- Modify: `mobile/components/ModernAudioRecorder.tsx:20-26,36-74,216` (delete `captureLocation`/`awaitLocation`; import them; re-export `RecordingLocation` and `LOCATION_WAIT_MS`)
- Modify: `mobile/components/LocationPicker.tsx:88-140,155-186`
- Test: `mobile/utils/__tests__/location.test.ts` (new), `mobile/components/__tests__/LocationPicker.test.tsx`, `mobile/components/__tests__/ModernAudioRecorder.test.tsx` (its `expo-location` mock gains `getLastKnownPositionAsync: jest.fn(async () => null)`)
- Docs: `CLAUDE.md` Recording rule: `LOCATION_WAIT_MS` now lives in `mobile/utils/location.ts`

**Interfaces:**
- Produces, in `utils/location.ts`:
  - `UNKNOWN_ADDRESS = 'Unknown Address'`, `LOCATION_WAIT_MS = 3000`, `LAST_KNOWN_MAX_AGE_MS = 120_000`, `LAST_KNOWN_MAX_ACCURACY_M = 100`;
  - `interface RecordingLocation { location: LocationData }` (`LocationData` from `types/index.ts`);
  - `addressFor(latitude: number, longitude: number): Promise<string>`: the reverse geocode via `formatGeocodedAddress`, else `UNKNOWN_ADDRESS`. Never throws.
  - `captureLocation(): Promise<RecordingLocation | undefined>`:
    - if permission is denied, returns `undefined`;
    - otherwise tries `getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS, requiredAccuracy: LAST_KNOWN_MAX_ACCURACY_M })` (its own try/catch);
    - falls back to `getCurrentPositionAsync({ accuracy: High })`;
    - then `addressFor(...)`;
    - returns `undefined` only when there are no coordinates at all.
  - `awaitLocation(pending: Promise<RecordingLocation | undefined> | null, waitMs = LOCATION_WAIT_MS)`, moved unchanged.
- Phase 5 consumes `captureLocation`/`awaitLocation` from here.

- [x] **Step 1: Write the failing tests.**

```ts
// utils/__tests__/location.test.ts (jest.mock('expo-location', ...) with all four functions as jest.fn)
it('uses a last-known fix under 2 minutes old without waiting for GPS (H2-6.1)', async () => {
  last.mockResolvedValue({ coords: { latitude: 37.78, longitude: -122.41 } });
  const r = await captureLocation();
  expect(last).toHaveBeenCalledWith({ maxAge: 120000, requiredAccuracy: 100 });
  expect(current).not.toHaveBeenCalled();
  expect(r?.location).toMatchObject({ latitude: 37.78, longitude: -122.41 });
});
it('falls back to a fresh fix when there is no recent one', async () => { /* last -> null; current called */ });
it('keeps the coordinates with "Unknown Address" when reverse geocoding throws', async () => {
  last.mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
  geocode.mockRejectedValue(new Error('offline'));
  expect(await captureLocation()).toEqual({ location: { latitude: 1, longitude: 2, address: 'Unknown Address' } });
});
it('uses "Unknown Address" when the geocoder returns nothing', async () => { /* geocode -> [] */ });
it('returns undefined when permission is denied', async () => { /* status denied */ });
it('still gets a fresh fix when getLastKnownPositionAsync throws', async () => { /* last rejects; current resolves */ });

// components/__tests__/LocationPicker.test.tsx: MapView mock becomes a forwardRef exposing animateToRegion: mockAnimateToRegion
it('confirms coordinates without an address (H2-6.2)', async () => {
  (Location.reverseGeocodeAsync as jest.Mock).mockRejectedValue(new Error('offline'));
  // render, wait for 'Confirm Location', press it
  expect(onLocationSelected).toHaveBeenCalledWith({ location: expect.objectContaining({ address: 'Unknown Address' }) });
  expect(Alert.alert).not.toHaveBeenCalled();
});
it('gives the map an initialRegion and animates to a newly picked point instead of a controlled region', async () => {
  // after load: map props.region is undefined, props.initialRegion has the fix
  // fireEvent(map, 'press', { nativeEvent: { coordinate: { latitude: 37.7, longitude: -122.4 } } })
  expect(mockAnimateToRegion).toHaveBeenCalledWith(expect.objectContaining({ latitude: 37.7, longitude: -122.4 }), expect.any(Number));
});
```

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest utils/__tests__/location.test.ts components/__tests__/LocationPicker.test.tsx`
Expected: FAIL (no export `captureLocation`; the picker shows an Alert; `region` is set).

- [x] **Step 3: Implement.**
  - `utils/location.ts` as in Interfaces. The recorder imports from it (its other code is unchanged).
  - `LocationPicker`:
    - `updateAddress` and `handleConfirmLocation` use `addressFor`;
    - Confirm always calls `onLocationSelected` with the address, or `UNKNOWN_ADDRESS`, and drops the "Unable to get address" Alert at `:128-131`;
    - the map takes `ref={mapRef}` and `initialRegion={{ ...start, latitudeDelta: 0.01, longitudeDelta: 0.01 }}`;
    - a `useEffect` on `selectedLocation` calls `mapRef.current?.animateToRegion({...}, 300)`.

- [x] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest utils components`
Expected: PASS. All 11 existing recorder tests still pass, including `reports the location captured while recording` and `waits only a short time for a pending fix at stop`.

- [x] **Step 5: Device check and docs.**
  - CLAUDE.md Recording rule: "...waited for at most `LOCATION_WAIT_MS` (3 s, `mobile/utils/location.ts`) at stop; a fix under 2 minutes old is used at once; a failed address lookup keeps the coordinates as 'Unknown Address'."
  - Manual steps:
    > (H2-6.1) With location on, record once (this caches a fix). Turn on Airplane Mode, then record within 2 minutes. Expect: the review shows the location card with "Unknown Address", and the saved interaction has coordinates. In the location picker, with Airplane Mode on, Confirm returns a pin with "Unknown Address".

- [x] **Step 6: Run the global checks and commit.**
```bash
git add mobile/utils mobile/components CLAUDE.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "fix(mobile): keep GPS coordinates when the address lookup fails; uncontrolled map (H2-6.1, H2-6.2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mic permission on the first tap, and accessibility

**Files:**
- Create: `mobile/utils/micPermission.ts`
- Modify: `mobile/components/ModernAudioRecorder.tsx`:
  - remove the mount effect (`:120-134`);
  - call `ensureMicPermission` at the top of `startRecording` (`:190-192`);
  - add a minute-announcement effect;
  - Record button a11y (`:348-358`);
  - `useWindowDimensions` instead of `:9,18,434-435`.
- Modify: `mobile/components/ui/Card.tsx:35-44` (`accessibilityRole="button"` when `onPress`; props pass through)
- Modify: `mobile/screens/ModernIndividualProfileScreen.tsx:61-67` (`accessibilityRole="button"` on the delete icon)
- Modify: `mobile/screens/ModernSearchScreen.tsx` rows (`:221-228`): `accessibilityLabel={`${item.name}, urgency ${Math.round(urgencyScore)}, last seen ${formatLastSeen(item.last_seen_days)}`}`
- Test: `mobile/utils/__tests__/micPermission.test.ts` (new), `mobile/components/__tests__/ModernAudioRecorder.test.tsx`, `mobile/screens/__tests__/ModernSearchScreen.test.tsx`

**Interfaces:**
- Produces `ensureMicPermission(request: () => Promise<{ granted: boolean }>): Promise<boolean>`.
  - Returns `true` when granted.
  - On a denial it shows `Alert.alert('Microphone access is off', 'VoiceReach needs the microphone to record. Turn it on in Settings.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }])` and returns `false`.
  - If `request` throws, it shows `showApiError('Could not check microphone access. Please try again.', 'Recording failed')` and returns `false`.
- The recorder passes `Audio.requestPermissionsAsync` (expo-av). Phase 5 passes expo-audio's `requestRecordingPermissionsAsync`; both resolve a `PermissionResponse` with `granted`.
- `minuteAnnouncement(seconds: number): string | null`, exported from the recorder: `'1 minute recorded'` at 60, `'2 minutes recorded'` at 120, else `null`.

- [x] **Step 1: Write the failing tests.**

```ts
// micPermission.test.ts
it('a denial offers Open Settings, which opens the app settings (H2-6.3)', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  expect(await ensureMicPermission(async () => ({ granted: false }))).toBe(false);
  const buttons = alert.mock.calls[0][2]!;
  expect(buttons.map(b => b.text)).toEqual(['Cancel', 'Open Settings']);
  buttons[1].onPress!();
  expect(open).toHaveBeenCalled();
});
it('a grant returns true with no alert', async () => { /* ... */ });

// ModernAudioRecorder.test.tsx
it('does not ask for the microphone at mount', () => {
  render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  expect(Audio.requestPermissionsAsync).not.toHaveBeenCalled();
});
it('asks on the first tap and records nothing when denied', async () => {
  (Audio.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false, status: 'denied' });
  await press(screen);
  expect(Audio.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(mockCreateAsync).not.toHaveBeenCalled();
});
it('labels the Record button for VoiceOver (H2-6.11)', async () => {
  const button = screen.getByTestId('record-button');
  expect(button.props.accessibilityRole).toBe('button');
  expect(button.props.accessibilityLabel).toBe('Start recording');
  await press(screen);
  expect(screen.getByTestId('record-button').props.accessibilityLabel).toBe('Stop recording');
});
it('announces each full minute while recording', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  await press(screen); await tick(60_000);
  expect(announce).toHaveBeenCalledWith('1 minute recorded');
  expect(announce).toHaveBeenCalledTimes(1);
});
it('sizes the progress track from the window width', () => {
  // jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }) }))
  expect(StyleSheet.flatten(screen.getByTestId('progress-track').props.style).width).toBe(400 - theme.spacing.lg * 2);
});

// ModernSearchScreen.test.tsx
it('reads each row as name, urgency and last seen', async () => {
  // after load: getByLabelText('Ann Lee, urgency 10, last seen 1 day ago') has accessibilityRole 'button'
});
```
Update the `expo-av` mock: `requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' }))`.

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest utils/__tests__/micPermission.test.ts components/__tests__/ModernAudioRecorder.test.tsx screens/__tests__/ModernSearchScreen.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement.**
  - Record button: `accessibilityRole="button"`, `accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}`, `accessibilityState={{ disabled: isFinishing }}`.
  - Progress track: `testID="progress-track"`, with `width: width - theme.spacing.lg * 2` from `useWindowDimensions()` in the inline style. Delete the module-level `Dimensions`.
  - The announcement effect runs on `[duration, isRecording]`: when recording and `minuteAnnouncement(duration)` returns text, it calls `AccessibilityInfo.announceForAccessibility`.
  - `ensureMicPermission` runs after `startingRef.current = true` and before `setAudioModeAsync`. On `false`, return. The `finally` block clears `startingRef`.

- [x] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest`
Expected: PASS.

- [x] **Step 5: Device check.**
  > (H2-6.3, H2-6.11)
  > - Fresh install: opening the Record tab shows no mic prompt. The first Record tap shows it.
  > - Deny it, tap again: the "Microphone access is off" alert. "Open Settings" opens VoiceReach's page in Settings.
  > - With VoiceOver on: the button reads "Start recording, button", and at 1:00 VoiceOver says "1 minute recorded".
  > - Rotate an iPad: the progress track resizes.

- [x] **Step 6: Run the global checks and commit.**
```bash
git add mobile/utils mobile/components mobile/screens docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): ask for the mic on the first tap with Open Settings; label icon buttons (H2-6.3, H2-6.11)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Record screen: one "Transcribing..." state with the real reason

**Files:**
- Modify: `mobile/screens/ModernRecordScreen.tsx:46-50,66-131,134-147,239-320`
- Test: `mobile/screens/__tests__/ModernRecordScreen.test.tsx`

**Interfaces:**
- Consumes `errorMessage` (Task 1).
- Produces no new exports. State is `isTranscribing: boolean` and `transcriptionError: string | null`; `isUploading`, `uploadError` and `uploadAudioFile` are deleted.

- [x] **Step 1: Write the failing tests.**

```tsx
it('shows "Transcribing..." while the recording is processed (H2-6.3)', async () => {
  (api.transcribe as jest.Mock).mockReturnValue(new Promise(() => {}));
  fireEvent.press(screen.getByText('Stub Recorder'));
  await screen.findByText('Transcribing...');
  expect(screen.queryByText('Uploading audio...')).toBeNull();
});
it("shows the backend's reason on the error card", async () => {
  (api.transcribe as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('File is not in M4A format'), { detail: 'File is not in M4A format', status: 400 }));
  fireEvent.press(screen.getByText('Stub Recorder'));
  await screen.findByText('File is not in M4A format');
  expect(screen.getByText('Try Again')).toBeTruthy();
});
it('shows one toast per failure, not two', async () => { /* reject; Toast.show error calls === 1 */ });
```

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest screens/__tests__/ModernRecordScreen.test.tsx`
Expected: FAIL. The screen shows "Uploading audio...", and the card says "Transcription failed".

- [x] **Step 3: Implement.**
  - `handleRecordingComplete` and `retryTranscription` call `transcribeAudio(uri)` directly.
  - The "Processing Audio" info toast is dropped: the card says it.
  - `transcriptionError = errorMessage(error)`.
  - The recorder card stays hidden while `isTranscribing` (C-13).

- [x] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest screens/__tests__/ModernRecordScreen.test.tsx`
Expected: PASS, the C-38 and C-65 tests included.

- [x] **Step 5: Run the global checks and commit.**
```bash
git add mobile/screens
git commit -m "fix(mobile): show Transcribing and the backend's reason on the Record screen (H2-6.3)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: TanStack Query (memory only), focus and online wiring, and the ErrorBoundary

**Files:**
- Create: `mobile/services/queryClient.ts`, `mobile/services/queries.ts`, `mobile/components/ErrorBoundary.tsx`, `mobile/test/renderWithQuery.tsx`
- Modify: `mobile/App.tsx:157-164` and `AppContent` (`:64-155`)
- Modify: `mobile/test/setup.js` (NetInfo mock); `mobile/package.json` (`transformIgnorePatterns` gains `@tanstack/.*`; deps)
- Test: `mobile/services/__tests__/queryClient.test.ts` (new), `mobile/components/__tests__/ErrorBoundary.test.tsx` (new), `mobile/__tests__/App.test.tsx`
- Docs: README **On the phone** list and the paragraph at about line 72-76; CLAUDE.md "App structure"; manual-steps Device checks

**Interfaces:**
- Produces, in `services/queryClient.ts`:
  - `createQueryClient(): QueryClient` with `defaultOptions`:
    - `queries: { retry: false, networkMode: 'always', staleTime: 0, gcTime: 5 * 60_000 }` (`authedFetch` already retries a GET once);
    - `mutations: { retry: false, networkMode: 'always' }`;
  - `queryClient: QueryClient`: the app's single client;
  - `wireQueryManagers(): () => void`:
    - AppState `change` → `focusManager.setFocused(state === 'active')`;
    - `onlineManager.setEventListener(setOnline => NetInfo.addEventListener(s => setOnline(s.isConnected !== false)))`, so `null` (unknown) counts as online;
    - returns a cleanup.
- Produces, in `services/queries.ts`:
  - `queryKeys = { categories: ['categories'], individualsList: ['individuals', 'list'], individualSearch: (q: string) => ['individuals', 'search', q], individual: (id: string) => ['individual', id] } as const`;
  - `useRefreshOnFocus(refetch: () => unknown): void` (TanStack's RN recipe: `useFocusEffect`, skipping the first focus).
- Produces `class ErrorBoundary extends React.Component<{ children: React.ReactNode; onReset?: () => void }, { hasError: boolean }>`.
  - Fallback copy: title `Something went wrong.`, a button `Restart` (`accessibilityRole="button"`).
  - Restart calls `onReset?.()`, then clears `hasError` so the children mount fresh.
  - `componentDidCatch`: `if (__DEV__) console.error('ErrorBoundary caught', error);`.
- Produces `renderWithQuery(ui: React.ReactElement, client = createQueryClient()): RenderResult & { client: QueryClient }` in `test/renderWithQuery.tsx`.
- `App` tree: `ErrorBoundary(onReset = () => queryClient.clear())` › `QueryClientProvider` › `AuthProvider` › (`AppContent`, `Toast`).
  - `AppContent` runs `useEffect(() => wireQueryManagers(), [])`.
  - It calls `queryClient.clear()` whenever `user` becomes null (Sign Out).

- [x] **Step 1: Write the failing tests.**

```ts
// services/__tests__/queryClient.test.ts
it('the app comes to the foreground: queries see focus (H2-6.6)', () => {
  let handler: (s: string) => void = () => {};
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, h: any) => { handler = h; return { remove: jest.fn() } as any; });
  const cleanup = wireQueryManagers();
  act(() => handler('background')); expect(focusManager.isFocused()).toBe(false);
  act(() => handler('active'));     expect(focusManager.isFocused()).toBe(true);
  cleanup();
});
it('NetInfo drives onlineManager; unknown connectivity counts as online', () => {
  wireQueryManagers();
  const listener = (NetInfo.addEventListener as jest.Mock).mock.calls[0][0];
  listener({ isConnected: false }); expect(onlineManager.isOnline()).toBe(false);
  listener({ isConnected: null });  expect(onlineManager.isOnline()).toBe(true);
});
it('a query offline still runs and fails instead of pausing', async () => {
  onlineManager.setOnline(false);
  const client = createQueryClient();
  await expect(client.fetchQuery({ queryKey: ['x'], queryFn: async () => { throw new Error('No connection') } }))
    .rejects.toThrow('No connection');
  onlineManager.setOnline(true);
});
it('has no persister: nothing is written to AsyncStorage', async () => {
  const client = createQueryClient();
  await client.fetchQuery({ queryKey: ['p'], queryFn: async () => ({ name: 'Ann Lee' }) });
  expect(await AsyncStorage.getAllKeys()).toEqual([]);
});

// components/__tests__/ErrorBoundary.test.tsx
it('shows "Something went wrong." with Restart, and Restart remounts the children (H2-6.7)', () => {
  let explode = true;
  const Bomb = () => { if (explode) throw new Error('boom'); return <Text>fine</Text>; };
  const onReset = jest.fn();
  const s = render(<ErrorBoundary onReset={onReset}><Bomb /></ErrorBoundary>);
  expect(s.getByText('Something went wrong.')).toBeTruthy();
  explode = false;
  fireEvent.press(s.getByText('Restart'));
  expect(onReset).toHaveBeenCalled();
  expect(s.getByText('fine')).toBeTruthy();
});

// __tests__/App.test.tsx (afterEach: queryClient.clear())
it('Sign Out clears cached case data from memory', async () => {
  // sign in; queryClient.setQueryData(['individual', 'p1'], { name: 'Ann Lee' }); press 'Profile Sign Out'
  await waitFor(() => expect(queryClient.getQueryData(['individual', 'p1'])).toBeUndefined());
});
```

- [x] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest services/__tests__/queryClient.test.ts components/__tests__/ErrorBoundary.test.tsx __tests__/App.test.tsx`
Expected: FAIL (missing modules).

- [x] **Step 3: Install and implement.**
  - `cd mobile && npm install @tanstack/react-query@^5.90.5 && npx expo install @react-native-community/netinfo` (expect `11.4.1`).
  - Add to `test/setup.js`: `jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'))`.
  - Add `@tanstack/.*` to the `transformIgnorePatterns` allowlist.
  - Write the four files and wire `App.tsx` as in Interfaces.

- [x] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest`
Expected: PASS, including the existing App tests (`a failed sign-in blocks the app with Retry...`).

- [x] **Step 5: Docs and device check.**
  - README **On the phone**: "Server data is cached by TanStack Query in memory only. There is no persister, so nothing about a person is written to the phone's storage. The cache is cleared on Sign Out. It refetches when the app returns to the foreground and when the network comes back."
  - CLAUDE.md "App structure": add "Server state: TanStack Query, memory only (`mobile/services/queryClient.ts`, keys in `services/queries.ts`); never add a persister."
  - Manual steps:
    > (H2-6.6) Open Search. Background the app, change a person's urgency override from another phone, and return. Expect: the list updates without pulling. Turn Airplane Mode on, then off, on the profile screen. Expect: the profile refetches once the connection is back. Offline at launch, Search shows "Couldn't load — tap to retry", not an endless spinner.

- [x] **Step 6: Run the global checks and commit.**
```bash
git add mobile/App.tsx mobile/services mobile/components/ErrorBoundary.tsx mobile/components/__tests__/ErrorBoundary.test.tsx mobile/test mobile/__tests__ mobile/package.json mobile/package-lock.json README.md CLAUDE.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): TanStack Query in memory with focus/online refetch and a root ErrorBoundary (H2-6.6, H2-6.7)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Memoised contexts; categories only from CategoryContext

**Files:**
- Modify: `mobile/contexts/AuthContext.tsx:44-58,96-115` (`useCallback` for `signIn` and `handleSignOut`; `useMemo` for `value`)
- Modify: `mobile/contexts/CategoryContext.tsx:25-60` (`useQuery` plus `useMemo`)
- Modify: `mobile/components/TranscriptionResults.tsx:60-87,332-357` (delete local category state and `fetchCategories`; use `useCategories()`)
- Modify: `mobile/components/ManualEntryForm.tsx:43-71,287-298` (the same; the form fills its keys from the context)
- Modify: `mobile/utils/categoryPayload.ts:9-20` (`is_sensitive?: boolean` on `Category`, for Phase 3 and Task 13)
- Test: `mobile/contexts/__tests__/AuthContext.test.tsx`, `contexts/__tests__/CategoryContext.test.tsx`, `components/__tests__/TranscriptionResults.test.tsx`, `components/__tests__/ManualEntryForm.test.tsx` (each renders with `renderWithQuery(<CategoryProvider>…</CategoryProvider>)`; their `api.getCategories` mocks stay)

**Interfaces:**
- Consumes `queryKeys.categories` and `renderWithQuery` (Task 7).
- `CategoryContextType` is unchanged: `{ categories, isLoading, error, refreshCategories }`.
  - `categories` is `query.data` (sorted with `select: sortCategories`, a module-level function), or a module-level empty array.
  - `isLoading` is `query.isPending`; `error` is `errorMessage(query.error)` or `null`.
  - `refreshCategories` awaits `query.refetch()`.
  - `staleTime` is 5 min.
- Both context values are referentially stable while their inputs don't change.

- [ ] **Step 1: Write the failing tests.**

```tsx
// AuthContext.test.tsx
it('keeps the same context value across a re-render (H2-6.9)', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const seen: any[] = [];
  const Spy = () => { seen.push(useAuth()); return null; };
  const s = render(<AuthProvider><Spy /></AuthProvider>);
  await waitFor(() => expect(seen.at(-1).loading).toBe(false));
  s.rerender(<AuthProvider><Spy /></AuthProvider>);
  expect(seen.at(-1)).toBe(seen.at(-2));
});
// CategoryContext.test.tsx: the same stability test for useCategories; the two existing tests keep passing.

// TranscriptionResults.test.tsx
it('reads categories from CategoryContext and fetches none of its own (H2-6.5)', async () => {
  renderWithQuery(<CategoryProvider><TranscriptionResults result={RESULT} onSave={jest.fn()} onCancel={jest.fn()} /></CategoryProvider>);
  await screen.findByPlaceholderText('Enter name');
  expect(api.getCategories).toHaveBeenCalledTimes(1);   // the provider's one load
});
// ManualEntryForm.test.tsx: the same, plus
it('keeps typed values when the categories reload', async () => {
  const { client } = renderWithQuery(<CategoryProvider><ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} /></CategoryProvider>);
  fireEvent.changeText(await screen.findByPlaceholderText('Enter name'), 'Ann');
  await act(() => client.invalidateQueries({ queryKey: ['categories'] }));
  expect(screen.getByDisplayValue('Ann')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest contexts components/__tests__/TranscriptionResults.test.tsx components/__tests__/ManualEntryForm.test.tsx`
Expected: FAIL. The values differ, and `getCategories` is called 2 times.

- [ ] **Step 3: Implement.**
  - `ManualEntryForm` fills its form with `useEffect(() => setFormData(prev => ({ ...emptyForm(categories), ...prev })), [categories])`. `resetForm` is unchanged.
  - Both components render `<CategoryLoadError error={error} onRetry={refreshCategories} …/>` when `categories.length === 0`, and a spinner while `isLoading`.
  - `MergeUI` keeps getting `categories` as a prop.

- [ ] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest`
Expected: PASS. This includes `a failed category load shows the error and Retry reloads the form` and `shows the error with Retry and no Save; Retry loads the fields`.

- [ ] **Step 5: Run the global checks and commit.**
```bash
git add mobile/contexts mobile/components mobile/utils/categoryPayload.ts
git commit -m "refactor(mobile): memoise contexts and read categories only from CategoryContext (H2-6.5, H2-6.9)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Native stack with typed navigation, and freezeOnBlur

**Files:**
- Create: `mobile/navigation/types.ts`
- Modify: `mobile/App.tsx:1-62,98-150`
- Modify: `mobile/screens/ModernSearchScreen.tsx:34-36`, `mobile/screens/ModernIndividualProfileScreen.tsx:42-45` (typed props)
- Modify: `mobile/package.json` (`npm install @react-navigation/native-stack@~7.3.26`; `npm uninstall @react-navigation/stack`)
- Test: `mobile/__tests__/App.test.tsx`. The Search and profile tests pass `navigation={nav as any}` and `route={route as any}`.
- Docs: CLAUDE.md "App structure": "Search pushes the profile on a native stack (`SearchStackParamList` in `mobile/navigation/types.ts`)."

**Interfaces:**
- Produces, in `navigation/types.ts`:
  - `type SearchStackParamList = { SearchMain: undefined; IndividualProfile: { individualId: string } }`;
  - `type RootTabParamList = { Record: undefined; Search: NavigatorScreenParams<SearchStackParamList>; VoiceAssistant: undefined; Categories: undefined; Profile: undefined }`;
  - `declare global { namespace ReactNavigation { interface RootParamList extends RootTabParamList {} } }`.
- Screen props: `NativeStackScreenProps<SearchStackParamList, 'SearchMain'>` and `NativeStackScreenProps<SearchStackParamList, 'IndividualProfile'>`. No `navigation: any` remains (`grep -rn "navigation: any" mobile/screens mobile/App.tsx` prints nothing).
- `FROZEN_TABS: ReadonlyArray<keyof RootTabParamList> = ['Search', 'Categories', 'Profile']` is exported from `App.tsx`. Those tabs get `freezeOnBlur: true`.
  - Record is not frozen, because its 2:00 auto-stop runs from an effect on `duration`.
  - VoiceAssistant is not frozen, because its focus gating and socket belong to Phase 5.

- [ ] **Step 1: Write the failing tests.**

```tsx
it('freezes only the tabs whose hidden work need not run (H2-6.8)', () => {
  expect(FROZEN_TABS).toEqual(['Search', 'Categories', 'Profile']);
});
it('the Search tab renders its stack', async () => {
  // signed in; fireEvent.press(getByText('Search')) -> 'Search screen'
});
```

- [ ] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest __tests__/App.test.tsx`
Expected: FAIL (`FROZEN_TABS` is undefined).

- [ ] **Step 3: Install and implement.**
  - `createNativeStackNavigator<SearchStackParamList>()` with `IndividualProfile` options `{ title: 'Individual Profile', presentation: 'card' }`.
  - `createBottomTabNavigator<RootTabParamList>()`.
  - Native-stack renders under jest-expo: React Native's jest setup mocks `requireNativeComponent`, which react-native-screens' native views go through. The existing bottom tabs already run through react-native-screens in these tests.

- [ ] **Step 4: Run the checks.**
Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add mobile/navigation mobile/App.tsx mobile/screens mobile/__tests__ mobile/package.json mobile/package-lock.json CLAUDE.md
git commit -m "refactor(mobile): native stack with typed RootTabParamList/SearchStackParamList and freezeOnBlur (H2-6.8)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Backend: cursor pagination for the default list

**Files:**
- Modify: `backend/db/models.py:103-108` (`SearchIndividualsResponse.next_cursor: Optional[str] = None`)
- Modify: `backend/services/individual_service.py:350-429` (`cursor` parameter, `(last_seen, id)` order, `next_cursor`); add `encode_cursor`/`decode_cursor` beside `_parse_timestamp` (`:89-99`)
- Modify: `backend/api/individuals.py:176-215` (the `cursor` query parameter, validation, and passing it through)
- Test: `backend/tests/test_list_individuals.py`, `backend/tests/test_individuals_routes.py`
- Docs: README API table row `GET /api/individuals` (about line 362) and the "Search is demo-scale" shortcut (about line 633)

**Interfaces:**
- Consumes Phase 1's `fetch_all`/`run_db` reads, which `search_individuals` already uses after Phase 1. Keep them, and add no new queries.
- Produces:
  - `encode_cursor(last_seen: datetime, individual_id: str) -> str`, giving `f"{last_seen.isoformat()},{individual_id}"`;
  - `decode_cursor(raw: str) -> tuple[datetime, str]`: `rsplit(",", 1)`, `_parse_timestamp` (rejecting the "oldest" fallback) and `uuid.UUID(...)` validation; raises `ValueError`;
  - `IndividualService.search_individuals(..., cursor: Optional[tuple[datetime, str]] = None)`.
- Rules:
  - The default list (no search term, `sort_by=last_seen`, `sort_order=desc`) is ordered by `(last_seen, str(id))`, descending.
  - With a `cursor`, only rows whose `(last_seen, id)` is strictly less than the cursor are kept, then the first `limit` are taken. `total` is still the whole list's count.
  - `next_cursor` is `encode_cursor` of the page's last row when more rows follow, else `None`. It is always `None` for a search or another sort.
- Route: `cursor: Optional[str] = Query(None, max_length=100)`.
  - A cursor together with a search term, a non-default sort or `offset > 0` returns 400 `"cursor works only with the default list (no search, newest first, no offset)"`.
  - An undecodable cursor returns 400 `"Invalid cursor"`.
  - The default `limit` stays 20. The app sends 50.

- [ ] **Step 1: Write the failing tests.**

```python
# test_list_individuals.py
def _three():  # last_seen 2026-01-03 > 01-02 > 01-01 via created_at
    return FakeListDB([person(1), person(2), person(3)], [])

def test_default_list_returns_next_cursor_after_a_full_page():
    res = asyncio.run(IndividualService(_three()).search_individuals(limit=2))
    assert [r.name for r in res.individuals] == ["Person 3", "Person 2"]
    assert res.next_cursor == f"2026-01-02T00:00:00+00:00,{ID2}"

def test_cursor_returns_the_rows_after_it_and_the_last_page_has_no_cursor():
    cursor = decode_cursor(f"2026-01-02T00:00:00+00:00,{ID2}")
    res = asyncio.run(IndividualService(_three()).search_individuals(limit=2, cursor=cursor))
    assert [r.name for r in res.individuals] == ["Person 1"]
    assert res.next_cursor is None and res.total == 3

def test_equal_last_seen_is_ordered_by_id_so_pages_never_overlap():
    same = "2026-05-01T00:00:00+00:00"
    sb = FakeListDB([person(1, created_at=same), person(2, created_at=same), person(3, created_at=same)], [])
    p1 = asyncio.run(IndividualService(sb).search_individuals(limit=2))
    p2 = asyncio.run(IndividualService(sb).search_individuals(limit=2, cursor=decode_cursor(p1.next_cursor)))
    ids = [str(r.id) for r in p1.individuals + p2.individuals]
    assert len(ids) == len(set(ids)) == 3

def test_a_search_never_returns_a_cursor():
    res = asyncio.run(IndividualService(_three()).search_individuals(search="Person", limit=1))
    assert res.next_cursor is None

@pytest.mark.parametrize("raw", ["", "nope", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00,not-a-uuid", f"garbage,{ID1}"])
def test_decode_cursor_rejects_malformed_values(raw):
    with pytest.raises(ValueError):
        decode_cursor(raw)

# test_individuals_routes.py
def test_list_cursor_round_trips_through_the_query_string():
    sb = FakeListDB([person(i) for i in range(1, 4)], [])
    first = _call(sb, "GET", "/api/individuals?limit=2").json()
    second = _call(sb, "GET", "/api/individuals", params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [p["name"] for p in second["individuals"]] == ["Person 1"]   # the "+00:00" survived URL encoding

def test_list_rejects_a_malformed_cursor_with_400(): ...        # cursor=bad -> 400 "Invalid cursor"
def test_list_rejects_a_cursor_with_a_search_term_with_400(): ... # search=Ann&cursor=<valid> -> 400
```
`test_list_defaults_to_twenty_newest_first` and `test_last_seen_is_latest_interaction_else_created_at_never_updated_at` must still pass unchanged.

- [ ] **Step 2: Run them to verify they fail.**
Run: `python -m pytest backend/tests/test_list_individuals.py backend/tests/test_individuals_routes.py -q -k "cursor or overlap"`
Expected: FAIL (`ImportError: cannot import name 'decode_cursor'`).

- [ ] **Step 3: Implement** as in Interfaces. The sort key for `last_seen` becomes `(_parse_timestamp(...), str(x["id"]))`.

- [ ] **Step 4: Run them to verify they pass.**
Run: `python -m pytest -q && ruff check backend --select F,E9`
Expected: PASS.

- [ ] **Step 5: Docs.**
  - README API row: add "`cursor` (from the previous page's `next_cursor`, default list only; keyset on `last_seen, id`)".
  - "Search is demo-scale" shortcut: the list is paged by cursor, but each page still reads the whole table, and the trigger to move the keyset into SQL is an `individuals.last_seen_at` column (Deviation 2).

- [ ] **Step 6: Commit.**
```bash
git add backend/db/models.py backend/services/individual_service.py backend/api/individuals.py backend/tests README.md
git commit -m "feat(api): cursor pagination for the default individuals list (H2-6.10)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Search on TanStack Query and FlashList, a page at a time

**Files:**
- Modify: `mobile/services/api.ts:256-264` (add `listIndividuals`; `searchIndividuals` is used only with a term)
- Modify: `mobile/services/queries.ts` (list and search hooks; `removeIndividualFromCache`; `useEvictCommittedDeletes`)
- Create: `mobile/utils/useDebouncedValue.ts`
- Modify: `mobile/screens/ModernSearchScreen.tsx`:
  - lines 37-205 become hooks; the sequence refs (`:60-66`) and `handleScrollToIndexFailed` (`:186-197`) go;
  - rows become a memoised `SearchResultRow`;
  - `FlatList` (`:380-388`) becomes `FlashList`.
- Modify: `mobile/App.tsx` (`AppContent` calls `useEvictCommittedDeletes()`)
- Modify: `mobile/test/setup.js` (`require('@shopify/flash-list/jestSetup')`); `mobile/package.json` (`npx expo install @shopify/flash-list`, expect `1.7.6`; `transformIgnorePatterns` gains `@shopify/flash-list`)
- Test: `mobile/services/__tests__/dataAccess.test.ts`, `mobile/screens/__tests__/ModernSearchScreen.test.tsx`
  - list mocks move from `searchIndividuals('')` to `listIndividuals`;
  - render with `renderWithQuery`;
  - `FlatList.prototype` spies become `FlashList.prototype`;
  - delete `retries a failed scrollToIndex at most once` (Deviation 8).

**Interfaces:**
- Produces:
  - `LIST_PAGE_SIZE = 50`;
  - `interface IndividualsPage { items: SearchResult[]; nextCursor: string | null; total: number }`;
  - `api.listIndividuals(cursor: string | null): Promise<IndividualsPage>`: `GET /api/individuals?limit=50[&cursor=…]`, built with `URLSearchParams`.
- Produces in `queries.ts`:
  - `useIndividualsList()`: `useInfiniteQuery` on `queryKeys.individualsList` with `initialPageParam: null as string | null` and `getNextPageParam: last => last.nextCursor ?? undefined`;
  - `useIndividualSearch(query: string)`: `useQuery` on `queryKeys.individualSearch(query)`, `enabled: query !== ''`. It tries semantic search and falls back to `searchIndividuals` on failure (today's `performSearch` logic, plus Phase 4's 600 ms semantic pause if present);
  - `removeIndividualFromCache(client: QueryClient, id: string): void`: removes the id from the list pages and every search result, and removes `queryKeys.individual(id)`;
  - `useEvictCommittedDeletes(): void`: subscribes to `subscribePendingDeletes` and calls `removeIndividualFromCache` on `committed`.
- Produces `useDebouncedValue<T>(value: T, ms: number): T`.
- Screen rules:
  - `SEARCH_DEBOUNCE_MS = 300` stays.
  - `isSearching = hasQuery && (debounced !== searchQuery.trim() || search.isPending)`.
  - The full-screen error shows only when there is no data.
  - A background failure (`isRefetchError`) toasts once per `errorUpdatedAt`, unless `hasPendingDeletes()` (Minor 5).
  - Refresh on screen focus: `useRefreshOnFocus` refetches the list and, if there is a query, the search.
  - `onEndReached` loads the next page only with no query and `hasNextPage && !isFetchingNextPage`.
  - Rows are de-duplicated by id across pages.
  - The stats card's Total is the server's `total` for the list minus the loaded rows hidden as pending deletes, and `visibleResults.length` for a search. The High/Medium/Low counts cover the loaded rows.
  - FlashList: `estimatedItemSize={104}`, `extraData={highlightedId}`, `ListFooterComponent` (a spinner while `isFetchingNextPage`).

- [ ] **Step 1: Write the failing tests.**

```ts
// dataAccess.test.ts (replaces 'the default list is GET /api/individuals with an empty search and limit 100')
it('the default list is GET /api/individuals?limit=50, then the next page by cursor (H2-6.10)', async () => {
  fetchMock().mockResolvedValueOnce(jsonResponse(200, { individuals: [], total: 0, next_cursor: '2026-01-02T00:00:00+00:00,abc' }));
  const page = await api.listIndividuals(null);
  expect(lastCall().url.searchParams.get('limit')).toBe('50');
  expect(lastCall().url.searchParams.has('cursor')).toBe(false);
  expect(page.nextCursor).toBe('2026-01-02T00:00:00+00:00,abc');
  await api.listIndividuals(page.nextCursor);
  expect(lastCall().url.searchParams.get('cursor')).toBe('2026-01-02T00:00:00+00:00,abc');
});

// ModernSearchScreen.test.tsx
it('loads the next page at the end of the list with the cursor', async () => {
  (api.listIndividuals as jest.Mock)
    .mockResolvedValueOnce({ items: [ann], nextCursor: 'c1', total: 2 })
    .mockResolvedValueOnce({ items: [{ ...ann, id: 'b2', name: 'Bob Day' }], nextCursor: null, total: 2 });
  const s = renderWithQuery(<ModernSearchScreen navigation={nav as any} route={route as any} />);
  await s.findByText('Ann Lee');
  await act(async () => { s.UNSAFE_getByType(FlashList).props.onEndReached(); });
  await s.findByText('Bob Day');
  expect(api.listIndividuals).toHaveBeenLastCalledWith('c1');
});
it('does not page while search results are shown', async () => { /* type 'ann'; onEndReached -> listIndividuals called once */ });
it('drops a committed delete from the cache without reloading', async () => { /* scheduleDelete + advance past DELETE_UNDO_MS; row gone; listIndividuals called once */ });
```
The rest of the file's behaviour tests keep their names and assertions:
- `shows a retry state when loading fails, and retries on tap`;
- `searches once per pause in typing, not twice per keystroke`;
- `a slow response for "v" never overwrites the results for "veteran"`;
- `loads the list once on mount`;
- `a failed refresh keeps the last good list and shows a toast instead of the retry state`;
- `a failed refresh shows no toast while a delete is waiting for undo`;
- `a failed search refresh shows no toast while a delete is waiting for undo`;
- `a refresh shows new data without a full-screen spinner`;
- `scrolls to a row whose pending delete was undone`;
- `waits for the list to come back from a search spinner before scrolling`;
- `renders the match badge for a 0 similarity score`.

- [ ] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest services/__tests__/dataAccess.test.ts screens/__tests__/ModernSearchScreen.test.tsx`
Expected: FAIL (`api.listIndividuals is not a function`).

- [ ] **Step 3: Install and implement** as in Interfaces.

- [ ] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: PASS.

- [ ] **Step 5: Device check.**
  > (H2-6.10) With more than 50 people (`supabase/seed.sql` plus manual entries, or a local script), scroll Search to the end. Expect: the next page loads with a footer spinner, no row repeats, and scrolling stays smooth. Undo a delete near the bottom: the list scrolls to the restored row.

- [ ] **Step 6: Run the global checks and commit.**
```bash
git add mobile/services mobile/utils/useDebouncedValue.ts mobile/screens mobile/App.tsx mobile/test/setup.js mobile/package.json mobile/package-lock.json docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): Search on TanStack Query and FlashList with cursor pages (H2-6.6, H2-6.10)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Profile on TanStack Query; parallel load; the override as a mutation; MergeUI loads only the person

**Files:**
- Modify: `mobile/services/api.ts:281-308` (`Promise.all`; add `getIndividual`)
- Modify: `mobile/services/queries.ts` (`useIndividualProfile`, `useUrgencyOverride`)
- Modify: `mobile/screens/ModernIndividualProfileScreen.tsx`:
  - lines 13, 40 (unused `Dimensions`/`width`) and 46-97 become the hook plus a 404 effect;
  - lines 136-140 (refresh) and 152-169 (override) change.
- Modify: `mobile/components/MergeUI.tsx:66` (`api.getIndividual`)
- Test: `mobile/services/__tests__/dataAccess.test.ts`, `mobile/screens/__tests__/ModernIndividualProfileScreen.test.tsx` (renders with `renderWithQuery`), `mobile/components/__tests__/MergeUI.test.tsx` (the mock becomes `getIndividual`). If Phases 2 and 3 have landed, their MergeUI and `TranscriptionResults` tests that mock `api.getIndividualProfile` for MergeUI's load (the 409 reload, "passes the loaded version", "Other possible matches") switch to `api.getIndividual` resolving `{ id, name, data, version }`; their assertions stay.

**Interfaces:**
- Produces `api.getIndividual(id: string): Promise<{ id: string; name: string; data: Record<string, any>; [k: string]: any }>`, which returns `GET /api/individuals/{id}`'s `individual`. It carries `version` once Phase 2 adds it.
- `api.getIndividualProfile(id)` keeps its signature and return. It now starts both requests together: `Promise.all([apiRequest(`/api/individuals/${id}`), api.getInteractions(id)])`.
- Produces `useIndividualProfile(id: string)`: `useQuery` on `queryKeys.individual(id)`.
- Produces `useUrgencyOverride(id: string)`: `useMutation<{ urgency_score: number; urgency_override: number | null; display_score: number }, unknown, number | null, { previous?: IndividualProfile }>`, with:
  - `onMutate`: `cancelQueries`, snapshot, then optimistic `urgency_override`;
  - `onError`: restore the snapshot and `showApiError(e, 'Update failed')`;
  - `onSuccess`: write the returned `urgency_score`/`urgency_override` into the profile;
  - `onSettled`: `invalidateQueries({ queryKey: ['individuals'] })`, so the Search list and searches refetch.
- Screen rules:
  - A 404 (`error.status === 404`), on the first load or a background refetch, shows `Toast 'Individual not found'` and calls `navigation.goBack()` once.
  - Another error with no data shows "Couldn't load profile" with Retry (`refetch`).
  - Pull-to-refresh awaits `refetch()`. If it fails while data exists, it shows `showApiError(error, "Couldn't refresh profile")`.

- [ ] **Step 1: Write the failing tests.**

```ts
// dataAccess.test.ts
it('loads the person and the history in parallel (H2-6.5)', async () => {
  const pending: Array<(r: any) => void> = [];
  (global as any).fetch = jest.fn(() => new Promise(r => pending.push(r)));
  const p = api.getIndividualProfile('p1');
  await waitForCalls(2);                 // helper: flushes microtasks until fetch has 2 calls, max 20 ticks
  expect(fetchMock().mock.calls.map(c => new URL(c[0]).pathname)).toEqual(
    expect.arrayContaining(['/api/individuals/p1', '/api/individuals/p1/interactions']));
  pending.forEach(resolve => resolve(jsonResponse(200, { individual: PERSON, interactions: [] })));
  await p;
});

// MergeUI.test.tsx
it('loads only the matched person, not their history (H2-6.5)', async () => {
  (api.getIndividual as jest.Mock).mockResolvedValue({ id: MATCH.id, name: 'Ann Lee', data: { name: 'Ann Lee' } });
  render(<MergeUI ... />);
  await waitFor(() => expect(api.getIndividual).toHaveBeenCalledWith(MATCH.id));
  expect((api as any).getIndividualProfile).toBeUndefined();   // the mock no longer provides it
});

// ModernIndividualProfileScreen.test.tsx: the existing C-10 tests keep their names; add
it('an override refreshes the Search list', async () => {
  const { client } = renderWithQuery(<ModernIndividualProfileScreen navigation={navigation as any} route={route as any} />);
  const spy = jest.spyOn(client, 'invalidateQueries');
  // set the override through the UrgencyScore stub
  await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['individuals'] }));
});
it('a person deleted elsewhere (404 on a background refetch) goes back once', async () => {
  // first load ok; mockRejectedValue(apiError(404)); act(() => client.refetchQueries()); goBack called 1 time
});
```

- [ ] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest services/__tests__/dataAccess.test.ts components/__tests__/MergeUI.test.tsx screens/__tests__/ModernIndividualProfileScreen.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces. Delete the hand-written optimistic code and the `profile`/`isLoading`/`loadError` state. `useLayoutEffect`'s `headerRight` reads the query's `data`.

- [ ] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: PASS. This includes `shows the scores the PUT returns, not the optimistic value`, `shows the optimistic value while the PUT is in flight`, `reverts and shows the backend error once when the PUT fails`, `a 404 says "not found" and goes back`, `an outage offers a retry and does not go back`, `a failed refresh keeps the profile and shows one error` and `does not flip to the full-screen spinner while refreshing`.

- [ ] **Step 5: Run the global checks and commit.**
```bash
git add mobile/services mobile/screens mobile/components
git commit -m "feat(mobile): profile on TanStack Query with a parallel load and an override mutation (H2-6.5, H2-6.6)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Confirm before exporting, naming the sensitive columns

**Files:**
- Modify: `mobile/utils/csvExport.ts:33-50` (add `exportWarning`; move the write inside the `try`)
- Modify: `mobile/screens/CategoriesScreen.tsx:49-58` (Alert first, then `shareCsvExport`)
- Test: `mobile/utils/__tests__/csvExport.test.ts`, `mobile/screens/__tests__/CategoriesScreen.test.tsx`
  - its `csvExport` mock becomes `{ shareCsvExport: jest.fn(), exportWarning: jest.requireActual('../../utils/csvExport').exportWarning }`;
  - `hiv_status` in `mockCategories` gains `is_sensitive: true`.
- Docs: README "Export CSV" paragraph (about lines 131-134)

**Interfaces:**
- Consumes `Category.is_sensitive?: boolean` (Task 8; Phase 3 fills it in) and `categoryLabel`.
- Produces `exportWarning(categories: Category[]): string`.
  - With sensitive categories: `The file has every person's records, including these sensitive fields: ${labels.join(', ')}. Share it only with someone allowed to see them.`
  - Without any: `The file has every person's records. Share it only with someone allowed to see them.`
  - `labels` are `categoryLabel(c)`, in the context's order.
- The Alert is `Alert.alert('Export CSV?', exportWarning(categories), [{ text: 'Cancel', style: 'cancel' }, { text: 'Export', onPress: runExport }])`.
- The backend's `export_csv` audit entry is Phase 2's. Nothing to do here.

- [ ] **Step 1: Write the failing tests.**

```ts
// csvExport.test.ts
it('names the sensitive columns (H2-6.13)', () => {
  expect(exportWarning([cat('name'), { ...cat('hiv_status'), display_name: 'HIV status', is_sensitive: true }]))
    .toBe("The file has every person's records, including these sensitive fields: HIV status. Share it only with someone allowed to see them.");
});
it('says nothing about sensitive fields when none are flagged', () => { /* ... */ });
it('deletes the cached file when writing it fails', async () => {
  (FileSystem.writeAsStringAsync as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  await expect(shareCsvExport()).rejects.toThrow('disk full');
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
  expect(Sharing.shareAsync).not.toHaveBeenCalled();
});

// CategoriesScreen.test.tsx (the two existing export tests press 'Export' in the alert first)
it('asks before exporting and names the sensitive columns', () => {
  fireEvent.press(screen.getByText('Export CSV'));
  expect(alertSpy).toHaveBeenCalledWith('Export CSV?', expect.stringContaining('HIV status'), expect.any(Array));
  expect(shareCsvExport).not.toHaveBeenCalled();
});
it('Cancel exports nothing', () => { /* press the Cancel button's onPress (if any) -> shareCsvExport not called */ });
```

- [ ] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest utils/__tests__/csvExport.test.ts screens/__tests__/CategoriesScreen.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest`
Expected: PASS.

- [ ] **Step 5: Docs.** README "Export CSV": "...asks first, naming the fields marked sensitive; the cached copy is deleted when the sheet closes or when writing or sharing fails."

- [ ] **Step 6: Run the global checks and commit.**
```bash
git add mobile/utils mobile/screens README.md
git commit -m "feat(mobile): confirm CSV export naming the sensitive columns (H2-6.13)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: App-switcher privacy overlay

**Files:**
- Create: `mobile/components/PrivacyOverlay.tsx`
- Modify: `mobile/App.tsx` (rendered after `<Toast />`, so it covers toasts too)
- Modify: `mobile/components/InteractionDetailModal.tsx:51-56` (the last child inside the `Modal`), `mobile/components/LocationPicker.tsx:158-224` (the last child inside the map `Modal`)
- Test: `mobile/components/__tests__/PrivacyOverlay.test.tsx` (new), `mobile/components/__tests__/InteractionDetailModal.test.tsx`
- Docs: README **On the phone**; manual-steps Device checks

**Interfaces:**
- Produces `PRIVACY_OVERLAY_TEXT = 'VoiceReach'` and `PrivacyOverlay(): React.ReactElement | null`.
  - It subscribes to AppState and renders only when the state is `'inactive'` or `'background'` (never for `'active'` or `'unknown'`).
  - When shown: an opaque `View` with `StyleSheet.absoluteFill`, `backgroundColor: theme.colors.background`, `zIndex: 1000`, centred `Text` with `PRIVACY_OVERLAY_TEXT`, `pointerEvents="none"`, `accessibilityElementsHidden` and `importantForAccessibility="no-hide-descendants"`.
- A system permission prompt also makes the app `inactive`, so the overlay shows behind it. That is acceptable and stated in the device check.

- [ ] **Step 1: Write the failing tests.**

```tsx
let emit: (s: string) => void = () => {};
beforeEach(() => jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, h: any) => { emit = h; return { remove: jest.fn() } as any; }));

it('covers the screen with the app name when the app is inactive or in the background (H2-6.14)', () => {
  const s = render(<PrivacyOverlay />);
  expect(s.queryByText('VoiceReach')).toBeNull();
  act(() => emit('inactive'));   expect(s.getByText('VoiceReach')).toBeTruthy();
  act(() => emit('background')); expect(s.getByText('VoiceReach')).toBeTruthy();
  act(() => emit('active'));     expect(s.queryByText('VoiceReach')).toBeNull();
});
it('stays hidden for "unknown"', () => { /* ... */ });
// InteractionDetailModal.test.tsx
it('covers an open interaction (a transcript) in the app switcher', () => {
  const s = render(<InteractionDetailModal visible interaction={interaction} onClose={jest.fn()} />);
  act(() => emit('inactive'));
  expect(s.getByText('VoiceReach')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail.**
Run: `cd mobile && npx jest components/__tests__/PrivacyOverlay.test.tsx components/__tests__/InteractionDetailModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run them to verify they pass.**
Run: `cd mobile && npx jest`
Expected: PASS.

- [ ] **Step 5: Docs and device check.**
  - README **On the phone**: "When the app leaves the foreground, an opaque VoiceReach screen covers it (modals included), so the app switcher's snapshot shows no case data."
  - Manual steps:
    > (H2-6.14) Swipe up to the app switcher from each of: Search, a profile, an open interaction detail, the location picker and a voice review. Expect: the card shows the white "VoiceReach" screen, never the content. Return: the content is back at once. A system permission prompt also shows the overlay behind it (expected).

- [ ] **Step 6: Run the global checks and commit.**
```bash
git add mobile/components mobile/App.tsx README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): cover the app with an opaque overlay in the app switcher (H2-6.14)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Native build for the new modules, and the phase-end check

**Files:**
- Modify: `mobile/ios/` (Podfile.lock and the generated project files after the prebuild and pods), `mobile/app.json` (only if `npx expo install` added plugins)
- Docs: README "Mobile" setup (about lines 293-302): after pulling, rebuild the dev client, because Phase 6 adds native modules (expo-secure-store, netinfo, flash-list, react-native-get-random-values). Manual-steps **Owner actions outside code** or **Device checks** gets a rebuild line.

**Interfaces:** none new.

- [ ] **Step 1: Verify the versions.**
Run: `cd mobile && npx expo install --check`
Expected: "Dependencies are up to date" (no SDK 53 mismatch for the packages this phase added).

- [ ] **Step 2: Regenerate the native project.**
Run: `cd mobile && npx expo prebuild --platform ios --no-install && cd ios && pod install`
Expected: the pods install, and `Podfile.lock` lists `ExpoSecureStore`, `react-native-netinfo`, `RNFlashList` and `react-native-get-random-values`. If CocoaPods isn't available on the machine, skip this step and add a manual step: "Run `cd mobile/ios && pod install` and commit Podfile.lock".

- [ ] **Step 3: Check that no data reaches the device's storage or logs.**
Run: `cd mobile && npx jest test/noDataLogs.test.ts && grep -rn "persistQueryClient\|createAsyncStoragePersister" --include='*.ts*' --exclude-dir=node_modules --exclude-dir=ios . ; grep -rn "supabase.from" --include='*.ts*' --exclude-dir=node_modules --exclude-dir=ios .`
Expected: the test passes and both greps print nothing.

- [ ] **Step 4: Run the full checks.**
Run: `python -m pytest -q && ruff check backend --select F,E9 && cd mobile && npx tsc --noEmit && npx jest`
Expected: all PASS.

- [ ] **Step 5: Docs, then commit.**
  - README rebuild note.
  - Manual step: "(H2-6) Rebuild the iOS dev client (`cd mobile && npx expo run:ios --device`) before running the H2-6 device checks."

```bash
git add mobile/ios mobile/app.json README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): regenerate iOS for secure-store, netinfo and flash-list (H2-6)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Interfaces produced for later phases

| Consumer | What | Where |
|---|---|---|
| Phase 1 (rate limits) | Header `X-Device-Id: <uuid>` on every `authedFetch` request | `mobile/services/api.ts`, `services/deviceId.ts: getDeviceId(): Promise<string>` |
| Phase 2 (audit log, idempotency) | `getDeviceId()` (built on Phase 2's `newRequestId()`); `api.getIndividual(id)` returns the raw individual (incl. `version`) for `MergeUI` | `services/deviceId.ts`, `utils/requestId.ts`, `services/api.ts` |
| Phase 3 (sensitive fields) | `Category.is_sensitive?: boolean` read by `exportWarning(categories)` | `utils/categoryPayload.ts`, `utils/csvExport.ts` |
| Phase 5 (voice) | `ensureMicPermission(request: () => Promise<{ granted: boolean }>): Promise<boolean>` (pass expo-audio's `requestRecordingPermissionsAsync`); `captureLocation()`, `awaitLocation()`, `LOCATION_WAIT_MS`; `showApiError`, `errorMessage`, `RECORDING_FAILED`; keep the Record button's `accessibilityRole`/`accessibilityLabel` and `minuteAnnouncement` effect; the WebSocket handshake's `'X-Device-Id': await getDeviceId()` beside `Authorization` is added by whichever of Phase 5 Task 10 / this phase's Task 2 lands second | `utils/micPermission.ts`, `utils/location.ts`, `utils/errors.ts`, `components/ModernAudioRecorder.tsx` |
| Phase 7 (async recordings) | `queryClient`, `createQueryClient()`, `wireQueryManagers()` (polling pauses in the background through `focusManager`); `queryKeys` (add `recording: (id) => ['recording', id]`); `useRefreshOnFocus`; `renderWithQuery` for tests; `<ErrorBoundary onReset>` at the root; `PrivacyOverlay` for any new modal showing drafts; NetInfo is installed and mocked in `test/setup.js` | `services/queryClient.ts`, `services/queries.ts`, `test/renderWithQuery.tsx`, `components/ErrorBoundary.tsx`, `components/PrivacyOverlay.tsx` |
| Phase 8 (ops) | `ErrorBoundary.componentDidCatch` is the hook point for `@sentry/react-native` capture; `GET /api/individuals` `cursor`/`next_cursor` for the load test and Maestro flows; native-stack route names `SearchMain`, `IndividualProfile` | `components/ErrorBoundary.tsx`, `backend/api/individuals.py`, `navigation/types.ts` |
