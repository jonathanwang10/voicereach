# Backend Runtime Correctness Implementation Plan

> **For agentic workers:** Implement this plan task by task yourself, in order (no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FastAPI backend correct under real load: no sync database call on the event loop, one shared Supabase and OpenAI client, no silent 1,000-row truncation, honest error codes, bounded bodies and sessions, per-device rate limits, model names from config, typed Whisper errors and a server-side recording-length check.

**Architecture:** A new `backend/db/client.py` owns the one service-key Supabase client (`get_supabase`), the thread hop (`run_db`) and paged reads (`fetch_all`). The test fakes in `backend/tests/helpers.py` become strict about the event loop, so a missed `run_db` fails a test. Rate limits, device ids and realtime session slots stay in process memory (`services/rate_limit.py`, new `api/device.py`).

**Tech Stack:** Python 3.11, FastAPI 0.142, supabase-py 2.32 (sync client), openai 3.26 (`AsyncOpenAI`, `openai.BadRequestError`), starlette `run_in_threadpool`, mutagen 1.47, pytest 9 with `asyncio_mode = auto`.

**Spec:** `docs/superpowers/plans/2026-10-23-00-roadmap.md` (Phase 1, items 1-10). Read it first.

## Global Constraints

- Python 3.11. The repo's `.venv` points at Python 3.14, where httpcore fails to import. Recreate it first: `python3.11 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt -r requirements-dev.txt`.
- Checks that must pass at the end of every task: `python -m pytest -q` (repo root, offline), `ruff check backend --select F,E9`, `cd mobile && npx tsc --noEmit && npx jest`.
- Tests are offline. No test may call OpenAI or Supabase. Backend tests use `backend/tests/helpers.py` fakes (`FakeSupabase` is strict: an unscripted query fails the test).
- CLAUDE.md rules still hold: no unauthenticated routes (only `/health` is open); never reintroduce `skin_color`; never call `supabase.from` in `mobile/`; all data goes through the backend; no PII in logs (`backend/tests/test_no_pii_logs.py`, `mobile/test/noDataLogs.test.ts`); database text reaches a model only as a delimited `user` item or a delimited tool output, never as a `system` message.
- When a task changes a rule that CLAUDE.md or README states (recording format, duplicate behaviour, urgency, upload format, assistant behaviour), the same task updates CLAUDE.md and README.
- Every new env var gets a line in `docs/superpowers/plans/2026-10-23-manual-steps.md` (**Environment variables**: name, default, which service) and in `backend/.env.example`.
- Git: work on branch `hardening-2` (never commit to `main`). One commit per task, conventional prefix, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never commit `.env` files or keys. Never push to `jasonyi33/voicereach` (upstream); pushing at all is the owner's call.
- Keep it simple: no new infrastructure services (no Redis, no Celery, no queues). The in-memory fixed window stays (deliberate while there is one process).
- Comment density, naming and style match the surrounding code: short "why" comments; new items use the code `H2-1.<n>`, where `<n>` is the roadmap item number (for example `(H2-1.3)` for `fetch_all`).

**Full checks** (the "run the full checks" step in every task):

```bash
source .venv/bin/activate
python -m pytest -q                      # expect: all pass, 1 skipped (live smoke)
ruff check backend --select F,E9         # expect: All checks passed!
(cd mobile && npx tsc --noEmit && npx jest)   # expect: no type errors, all suites pass
```

**Commit form** (every task):

```bash
git commit -m "<type>(<scope>): <summary>" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Line numbers below are as of `main` at `ce238db`. Earlier tasks shift them, so find the code by the function name quoted next to each range.

## Deviations from roadmap

1. **There is no `PUT /api/individuals/{id}`.** A merge is `POST /api/individuals` with `merge_with_id` (`api/individuals.py:81-173`). The 256 KB body cap (item 5) and the save rate limit (item 7) go on `POST /api/individuals` only. `BodySizeLimitMiddleware` matches exact paths, so the `"/api/individuals"` key covers the save; the tiny `PUT /{id}/urgency-override` body stays uncapped, as it is today.
2. **Realtime session caps key on `limit_key(user_id, device_id)`, not the bare user id.** Every phone signs in as the shared demo account (owner decision 1), so "2 per user" would mean 2 sessions for the whole fleet. When a phone sends `X-Device-Id`, the cap is 2 per phone; without the header (until Phase 6 ships it) the key is the user id. The per-process cap of 20 bounds everything.
3. **The merge target vanishing during the first read is also a 404.** `individual_service.py:233-234` raises `ValueError` (400) on the same race as `:262`. Both now raise `IndividualNotFound` (404). `update_urgency_override` (`:515-525`) uses it too, so the route no longer turns a `ValidationError` into a 404 through `except ValueError`.
4. **`backend/scripts/` keep their own `create_client`.** They are separate processes, so "one client per process" holds. Phase 4 rewrites `backfill_embeddings.py`. They still benefit from `fetch_all` through `rescore_all_individuals`.

**Executor deviations (recorded while implementing):**

- Task 1: the roadmap and phase plans were already committed on `hardening-2` (15251d2), so Task 1's commit adds only the manual-steps file (`docs: add hardening-2 manual-steps file`). Baseline: 718 passed, 5 skipped (all five are the live smoke tests in `test_live_smoke.py`), not 1 skipped; jest 40/40 suites (the first cold run timed out 4 suites, a rerun passed; not a code failure).

## Decisions the roadmap left open

- **Routes that await nothing become plain `def`** instead of wrapping each `.execute()` in `run_db`: `get_categories`, `export_csv`, `create_category` (`api/categories.py`) and `get_embedding_status` (`api/embeddings.py`). FastAPI already runs `def` routes in its threadpool (roadmap item 1). This also moves the re-score at `categories.py:231` off the loop.
- **`fetch_last_seen` also pages** through `fetch_all`, one paged read per 50-id chunk. Its docstring admits the same 1,000-row cap.
- **"Search's text leg keeps its own result limit"** means the paged read feeds the matcher, and the response is still cut by `limit`/`offset` (`search_individuals`) and `top_k` (semantic leg). Only the read stops truncating.
- **`fetch_all` skips a row whose `id` it already returned**, so a person inserted mid-read can't appear twice in an export (see Review Focus).
- **Per-process totals:** each bucket's total is read from `RATE_LIMIT_<NAME>_TOTAL_PER_MIN` (the bucket's env var with `_PER_MIN` replaced by `_TOTAL_PER_MIN`). Unset, it is 5 times the effective per-device limit (`DEFAULT_TOTAL_MULTIPLIER = 5`).
- **New per-minute defaults:** save 30, category create 10, delete 30.
- **A malformed `X-Device-Id` is ignored, not refused.** The header must match `^[A-Za-z0-9-]{8,64}$`; anything else counts as absent, so an odd client still works and the per-process total still caps it.
- **Assistant-question messages:** `"Question must be at least 1 second long"` and `"Question must be under 1 minute"`.

## Review Focus

1. **The background embedding task after a save** (`generate_embedding_background`) runs on the event loop after the response. Its category read and upsert must also run off the loop. The test goes in Task 3.
2. **Several threadpool workers calling `get_supabase()` for the first time at once**, for example at startup under load, must build exactly one client. A failed first build (missing env) must not be cached. The tests go in Task 2.
3. **Rows inserted while `fetch_all` pages**: a row shifts onto the next page, and a reasonable person expects no one to appear twice in the list or the export. The test goes in Task 4.
4. **A realtime session that ends through an upstream failure, or a client that drops**, must give its slot back. Otherwise one bad network day locks a phone out of the assistant. The test goes in Task 13.
5. **An upload with an M4A `ftyp` header that mutagen can't parse** (truncated, or not an audio MP4) must be a 400 "File is not in M4A format", never a 500. The test goes in Task 7.

---

### Task 1: Environment, branch and the manual-steps file

**Files:**
- Create: `docs/superpowers/plans/2026-10-23-manual-steps.md`
- Recreate: `.venv/` (not committed)

**Interfaces:**
- Produces: the manual-steps file with four sections that every later task and phase appends to.

- [x] **Step 1: Create or switch to the branch**

Run: `git switch hardening-2 2>/dev/null || git switch -c hardening-2 main`
Expected: `git branch --show-current` prints `hardening-2`.

- [x] **Step 2: Recreate the venv with Python 3.11**

Run: `rm -rf .venv && python3.11 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt -r requirements-dev.txt`
Expected: `python --version` prints `Python 3.11.x`, and `python -c "import httpcore, supabase, openai"` exits 0.

- [x] **Step 3: Record the baseline**

Run the full checks. Expected: everything passes, with 1 skipped. Note the passed count in the task report. A failure here is pre-existing: stop and report it rather than fixing it inside this phase.

- [x] **Step 4: Write the manual-steps file**

Write exactly this content:

```markdown
# Hardening round 2: manual steps for the owner

Agents never apply anything to the hosted Supabase project or Railway (roadmap,
owner decision 2). Every step that needs the owner is listed here, by phase.

## Apply migrations

Apply in this order (Supabase SQL editor, or `psql "$SUPABASE_DB_URL" -f <file>`).
Each file is idempotent.

- Phase 1: no migrations.

## Environment variables

| Name | Default | Service | Phase |
|---|---|---|---|

## Device checks

Numbered steps with the expected result. Run them on a physical iPhone after a
native rebuild (`npx expo prebuild --platform ios && npx expo run:ios --device`).

- Phase 1: none (backend only).

## Owner actions outside code

1. Request OpenAI zero data retention and, if records are real client data, a BAA.
2. Confirm the keys leaked in git history (2025: an OpenAI key and Supabase
   service-role keys) are revoked.
3. Run `eas init` for the mobile project (Phase 8 adds `mobile/eas.json`).
4. Choose the App Store bundle id (Phase 8 leaves a placeholder).
```

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/
git commit -m "docs: add hardening-2 roadmap, phase plans and manual-steps file" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: One shared Supabase client (`get_supabase`)

Roadmap item 2, first half.

**Files:**
- Create: `backend/db/client.py`
- Modify: `backend/api/transcription.py:11,70-76` (`_transcribe`)
- Modify: `backend/api/individuals.py:5,10-11,42-54` (delete `get_supabase_client`), and its call sites at `:71,100,196,234,273,306,341,365`
- Modify: `backend/api/categories.py:8,11,71-74,114-118,180-183`
- Modify: `backend/api/embeddings.py:6,11,43-52` (delete `get_supabase_client`), and its call sites
- Modify: `backend/api/voice_assistant.py:5,11,24-27,129`
- Modify: `backend/main.py:15,156-159,196` (`process_client_message_with_context` calls `get_context_service(get_supabase())`)
- Modify: `backend/tests/conftest.py:3-6` (docstring), `:54-58` (`reset()` also sets `db.client._client = None`)
- Modify (rename patch targets): `backend/tests/test_create_category.py`, `test_delete_individual.py`, `test_duplicate_service_unit.py`, `test_embedding_text.py`, `test_error_contract.py`, `test_export_and_upsert.py`, `test_individuals_routes.py`, `test_list_individuals.py`, `test_no_pii_logs.py`, `test_normalised_paths.py`, `test_rate_limit.py`, `test_request_limits.py`, `test_rescore.py`
- Test: `backend/tests/test_db_client.py` (new)

**Interfaces:**
- Produces: `backend/db/client.py: def get_supabase() -> Client`. The client is built lazily, once, under a `threading.Lock`, and is the only `create_client` call for the service key. `POSTGREST_TIMEOUT_SECONDS = 20`. The cached client lives in module-level `_client`.
- Produces (test convention, used by every later task and phase): routes import the name (`from db.client import get_supabase`), and tests patch it per module: `patch("api.individuals.get_supabase", return_value=fake)`.

- [x] **Step 1: Write the failing tests** in `backend/tests/test_db_client.py`

```python
import os, threading, time
from pathlib import Path
import pytest
from db import client as db_client

BACKEND_DIR = Path(__file__).resolve().parents[1]

def test_get_supabase_builds_one_client_with_a_20s_postgrest_timeout(monkeypatch):
    built = []
    monkeypatch.setattr(db_client, "create_client",
                        lambda url, key, options=None: built.append((url, key, options)) or object())
    assert db_client.get_supabase() is db_client.get_supabase()
    assert len(built) == 1
    url, key, options = built[0]
    assert (url, key) == (os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    assert options.postgrest_client_timeout == 20

def test_concurrent_first_calls_build_one_client(monkeypatch):          # Review Focus 2
    built = []
    def slow_create(url, key, options=None):
        time.sleep(0.05); built.append(1); return object()
    monkeypatch.setattr(db_client, "create_client", slow_create)
    results = []
    threads = [threading.Thread(target=lambda: results.append(db_client.get_supabase())) for _ in range(8)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert len(built) == 1 and len({id(r) for r in results}) == 1

def test_missing_credentials_raise_runtime_error_and_are_not_cached(monkeypatch):  # Review Focus 2
    monkeypatch.setattr(db_client, "create_client", lambda url, key, options=None: object())
    monkeypatch.delenv("SUPABASE_SERVICE_KEY")
    with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_KEY"):
        db_client.get_supabase()
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "k")
    assert db_client.get_supabase() is not None

def test_only_db_client_and_auth_create_supabase_clients():
    offenders = {str(p.relative_to(BACKEND_DIR)) for p in BACKEND_DIR.rglob("*.py")
                 if not {"tests", "scripts", ".venv"} & set(p.parts) and "create_client(" in p.read_text()}
    assert offenders == {"db/client.py", "api/auth.py"}

def test_no_module_builds_a_client_at_import():
    import main
    from api import voice_assistant
    assert not hasattr(main, "supabase") and not hasattr(voice_assistant, "supabase")
```

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_db_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'db.client'`.

- [x] **Step 3: Implement `get_supabase() -> Client` in `backend/db/client.py`**

The client is `create_client(url, key, options=ClientOptions(postgrest_client_timeout=POSTGREST_TIMEOUT_SECONDS))`, with `ClientOptions` from `supabase`. Use double-checked locking on `_client`. Raise `RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")` when either is unset. It must be a `RuntimeError`, not a `ValueError`: `/api/transcribe` maps `ValueError` to a 400. Don't call `load_dotenv` (`main.py` already does). Add a "why" comment: a 20 s PostgREST timeout sits below the 110 s transcribe deadline (H2-1.2).

Then replace every service-key `create_client` and `get_supabase_client()` listed under **Files** with `get_supabase()`. Delete the import-time clients at `main.py:156-159` and `voice_assistant.py:24-27`. Update `conftest.py` so its docstring no longer says modules build clients at import, and add `db_client._client = None` to `reset()`.

- [x] **Step 4: Rename the test patch targets**

Run from the repo root:

```bash
grep -rlE "get_supabase_client|(transcription|categories)\.create_client" backend/tests | xargs sed -i '' \
  -e 's/api\.individuals\.get_supabase_client/api.individuals.get_supabase/g' \
  -e 's/api\.embeddings\.get_supabase_client/api.embeddings.get_supabase/g' \
  -e 's/api\.transcription\.create_client/api.transcription.get_supabase/g' \
  -e 's/api\.categories\.create_client/api.categories.get_supabase/g'
```

Expected: `grep -rn "get_supabase_client\|\.create_client\"" backend/tests` finds only `test_rescore.py` (the script's own `get_supabase_client`, which stays).

- [x] **Step 5: Run the new tests and the full checks**

Run: `python -m pytest backend/tests/test_db_client.py -v`. Expected: 5 passed. Then run the full checks.

- [x] **Step 6: Commit**

```bash
git add backend/db/client.py backend/api backend/main.py backend/tests
git commit -m "refactor(db): one shared service-key Supabase client with a 20 s timeout" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `run_db`: database calls off the event loop

Roadmap item 1.

**Files:**
- Modify: `backend/db/client.py` (add `run_db`)
- Modify: `backend/services/individual_service.py:175-346` (`save_individual`), `:350-429` (`search_individuals`), `:431-438` (`delete_individual`), `:440-499` (`get_individual_by_id`), `:501-531` (`update_urgency_override`), `:533-561` (`get_interactions`)
- Modify: `backend/services/duplicate_detection_service.py:134-149` (`_find_candidates`)
- Modify: `backend/services/embedding_service.py:74-78` (`store_individual_embedding`)
- Modify: `backend/services/context_service.py:186,231` (use `run_db` instead of `run_in_threadpool`, so there is one helper)
- Modify: `backend/api/transcription.py:79`; `backend/api/individuals.py:73,115`; `backend/api/embeddings.py:70,76,113,122,159,212,218`
- Modify: `backend/api/categories.py:57,108,155` (`export_csv`, `get_categories`, `create_category` become `def`); `backend/api/embeddings.py:247` (`get_embedding_status` becomes `def`)
- Modify: `backend/tests/helpers.py:140-155,204,286` (off-loop assertion in all three fakes)
- Modify: `CLAUDE.md` ("Rules the code enforces": add a **Database access** bullet)
- Test: `backend/tests/test_event_loop.py` (new)

**Interfaces:**
- Consumes: `get_supabase()` (Task 2).
- Produces: `backend/db/client.py: async def run_db(fn: Callable[[], T]) -> T`, built on `starlette.concurrency.run_in_threadpool`. It returns `fn()`'s value and propagates its exception.
- Produces: `FakeSupabase`, `FakePeopleDB` and `FakeListDB` raise `AssertionError("... ran on the event loop thread; wrap it in run_db (H2-1.1)")` when `execute()` runs while an asyncio loop is running in the current thread. Later phases' fakes (Phase 2's `rpc`) follow the same rule.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_event_loop.py`

```python
import asyncio, threading, time
from unittest.mock import AsyncMock, patch
import httpx, pytest
from fastapi.testclient import TestClient
from main import app
from db.client import run_db
from tests.helpers import FakeSupabase

ID = "550e8400-e29b-41d4-a716-446655440001"

async def test_run_db_runs_the_call_in_a_worker_thread():
    assert await run_db(threading.get_ident) != threading.get_ident()

async def test_run_db_propagates_the_error():
    def boom(): raise RuntimeError("boom")
    with pytest.raises(RuntimeError, match="boom"):
        await run_db(boom)

def test_fake_supabase_refuses_a_query_on_the_event_loop():
    sb = FakeSupabase().on("categories", "select", data=[])
    async def on_loop(): return sb.table("categories").select("*").execute()
    with pytest.raises(AssertionError, match="event loop"):
        asyncio.run(on_loop())

async def test_a_slow_database_call_does_not_stall_other_requests():
    sb = FakeSupabase().on("individuals", "select", data=lambda call: time.sleep(0.5) or [])
    with patch("api.individuals.get_supabase", return_value=sb):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            slow = asyncio.create_task(c.get("/api/individuals"))
            await asyncio.sleep(0.1)
            started = time.monotonic()
            assert (await c.get("/health")).status_code == 200
            assert time.monotonic() - started < 0.3
            assert (await slow).status_code == 200

# (method, path, body, patch target, [(table, verb, data)], expected status).
# An on-loop execute() would be an AssertionError, which the route turns into a 500 "... failed".
OFF_LOOP_ROUTES = [
    ("post", "/api/embeddings/search", {"query": "x"}, "api.embeddings.get_supabase",
     [("individuals", "select", []), ("individual_embeddings", "select", [])], 200),
    ("post", "/api/embeddings/generate", {"individual_id": ID}, "api.embeddings.get_supabase",
     [("individuals", "select", [])], 404),
    ("post", "/api/embeddings/generate-all", None, "api.embeddings.get_supabase", [("individuals", "select", [])], 200),
    ("get", "/api/embeddings/status", None, "api.embeddings.get_supabase",
     [("individuals", "select", []), ("individual_embeddings", "select", [])], 200),
    ("get", "/api/categories", None, "api.categories.get_supabase", [("categories", "select", [])], 200),
    ("get", "/api/export", None, "api.categories.get_supabase",
     [("categories", "select", []), ("individuals", "select", [])], 200),
    ("get", f"/api/individuals/{ID}", None, "api.individuals.get_supabase", [("individuals", "select", [])], 404),
    ("get", f"/api/individuals/{ID}/interactions", None, "api.individuals.get_supabase",
     [("interactions", "select", [])], 200),
    ("put", f"/api/individuals/{ID}/urgency-override", {"urgency_override": 5}, "api.individuals.get_supabase",
     [("individuals", "update", [])], 404),
    ("delete", f"/api/individuals/{ID}", None, "api.individuals.get_supabase", [("individuals", "delete", [])], 404),
    ("post", "/api/individuals/check-duplicates", {"name": "Ann Lee"}, "api.individuals.get_supabase",
     [("individuals", "select", [])], 200),
]

@pytest.mark.parametrize("method,path,body,target,script,status", OFF_LOOP_ROUTES)
def test_route_queries_run_off_the_event_loop(method, path, body, target, script, status):
    sb = FakeSupabase()
    for table, verb, data in script:
        sb.on(table, verb, data=data)
    with patch(target, return_value=sb):
        r = TestClient(app, raise_server_exceptions=False).request(
            method, path, **({"json": body} if body is not None else {}))
    assert r.status_code == status, r.text

def test_transcribe_categories_read_runs_off_the_loop():
    sb = FakeSupabase().on("categories", "select", data=[])
    with patch("api.transcription.get_supabase", return_value=sb):
        r = TestClient(app, raise_server_exceptions=False).post("/api/transcribe", json={"audio_data": "AAAA"})
    assert r.json()["detail"].startswith("No categories found")

@pytest.mark.real_embedding_task                                          # Review Focus 1
async def test_background_embedding_reads_and_upserts_off_the_loop():
    from api.individuals import generate_embedding_background
    sb = FakeSupabase().on("categories", "select", data=[]).on("individual_embeddings", "upsert", data=[])
    with patch("api.individuals.get_supabase", return_value=sb), \
         patch("services.embedding_service.EmbeddingService.generate_embedding",
               new=AsyncMock(return_value=[0.0] * 3072)):
        await generate_embedding_background(ID, {"id": ID, "name": "Ann", "data": {}})
    assert [c.verb for c in sb.calls] == ["select", "upsert"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_event_loop.py -v`
Expected: FAIL. `run_db` can't be imported, and once it exists the fake and route cases fail until the fakes check the loop and the paths are moved.

- [ ] **Step 3: Implement `async def run_db(fn: Callable[[], T]) -> T` in `backend/db/client.py`**

It is `return await run_in_threadpool(fn)`. Add the off-loop check to the three fakes' `execute()`, first, before the call is recorded in `calls`/`queries` (the background-task test relies on that, because `generate_embedding_background` swallows errors): `asyncio.get_running_loop()` succeeding means the call is on the loop, so raise the AssertionError from **Interfaces**.

- [ ] **Step 4: Move every path off the loop**

- In each `async` method and route listed under **Files**, wrap each `.execute()` chain, and each call to a sync helper that executes (`fetch_last_seen`), as `await run_db(lambda: <chain>.execute())`. Keep the logic as it is.
- In `save_individual`, the compensating delete at `:313` is wrapped too.
- Make the four no-await routes `def`.
- Add this CLAUDE.md bullet: "**Database access:** one service-key client from `db.client.get_supabase()`; every `.execute()` reached from `async` code goes through `await run_db(...)` (the test fakes fail a query made on the event loop)."

- [ ] **Step 5: Run the tests and the full checks**

Run: `python -m pytest backend/tests/test_event_loop.py -v`. Expected: all pass. Then run the full checks. Any older test that now fails with "ran on the event loop thread" points at a path still to wrap. Fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add backend/db/client.py backend/services backend/api backend/tests CLAUDE.md
git commit -m "fix(api): run every Supabase call off the event loop through run_db" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `fetch_all`: no silent stop at 1,000 rows

Roadmap item 3.

**Files:**
- Modify: `backend/db/client.py` (add `fetch_all`)
- Modify: `backend/services/individual_service.py:46-50` (`fetch_last_seen`, per chunk), `:74` (`rescore_all_individuals`), `:371` (`search_individuals`), plus their docstrings (`:38-41`, `:66-67`, `:362-364`)
- Modify: `backend/api/categories.py:77` (`export_csv`); `backend/api/embeddings.py:113,122,212`
- Modify: `backend/scripts/rescore_urgency.py:9` (docstring: no row cap)
- Modify: `backend/tests/helpers.py` (add `paged`; `_ListQuery.range` slices individuals and interactions)
- Modify: `backend/tests/test_export_and_upsert.py:28`, `test_embedding_text.py:155`, `test_rate_limit.py:47-50,63-64,75-76`, `test_request_limits.py:118-119` (their hand-made MagicMock chains add the `range` link)
- Modify: `README.md:196`, `:505-509`, `:633-637` (drop the "1000 by default" caveats for list, search, export, generate-all and re-score; the backfill script keeps it until Phase 4)
- Modify: `CLAUDE.md` (the **Database access** bullet from Task 3 adds: "whole-table reads go through `fetch_all`, ordered by a unique key")
- Test: `backend/tests/test_db_client.py`, `backend/tests/test_list_individuals.py`, `backend/tests/test_rescore.py`, `backend/tests/test_export_and_upsert.py`

**Interfaces:**
- Consumes: `run_db` (Task 3). `fetch_all` is sync, so callers write `await run_db(lambda: fetch_all(lambda: sb.table(...).select(...).order("id")))`.
- Produces: `backend/db/client.py: def fetch_all(build: Callable[[], Any], page_size: int = 1000) -> list[dict]`. Each caller's `build` must order by a unique key (add `.order("id")` as the last tiebreak), or pages can overlap.
- Produces: `backend/tests/helpers.py: def paged(rows: list) -> Callable[[Call], list]`, which returns the slice the call's `.range(a, b)` asks for (every row if there is no range). Use it as `data=` for a scripted select.

- [ ] **Step 1: Write the failing tests**

In `test_db_client.py`:

```python
from db.client import fetch_all
from tests.helpers import FakeSupabase, paged

def _rows(n): return [{"id": i} for i in range(n)]

def test_fetch_all_reads_every_page_until_a_short_one():
    sb = FakeSupabase().on("individuals", "select", data=paged(_rows(2500)))
    assert fetch_all(lambda: sb.table("individuals").select("*").order("id")) == _rows(2500)
    assert [c.mod("range")[0] for c in sb.calls] == [(0, 999), (1000, 1999), (2000, 2999)]

def test_fetch_all_on_an_exact_multiple_stops_after_an_empty_page():
    sb = FakeSupabase().on("individuals", "select", data=paged(_rows(2000)))
    assert len(fetch_all(lambda: sb.table("individuals").select("*").order("id"))) == 2000
    assert len(sb.calls) == 3

def test_fetch_all_skips_a_row_already_returned():                       # Review Focus 3
    pages = [[{"id": 1}, {"id": 2}], [{"id": 2}, {"id": 3}], []]          # row 2 shifted onto page 2
    sb = FakeSupabase().on("individuals", "select", data=lambda call: pages.pop(0))
    assert fetch_all(lambda: sb.table("individuals").select("*").order("id"), page_size=2) == \
        [{"id": 1}, {"id": 2}, {"id": 3}]
```

In `test_list_individuals.py`, `test_rescore.py` and `test_export_and_upsert.py`:

```python
async def test_search_counts_people_past_the_first_1000():
    people = [person(1, id=str(uuid.UUID(int=i)), name=f"P{i}") for i in range(1, 1501)]
    res = await IndividualService(FakeListDB(people, [])).search_individuals(sort_by="name", limit=5)
    assert res.total == 1500

def test_rescore_reads_every_page():
    rows = [{"id": str(uuid.UUID(int=i)), "urgency_score": 0, "data": {}} for i in range(1, 1501)]
    sb = FakeSupabase().on("individuals", "select", data=paged(rows)).on("categories", "select", data=[])
    assert rescore_all_individuals(sb) == 0
    assert len(sb.calls_to("individuals", "select")) == 2

def test_export_includes_people_past_the_first_1000():
    # FakeSupabase: categories [], individuals paged(1001 rows), interactions [];
    # patch("api.categories.get_supabase", return_value=sb)
    assert len(r.text.strip().splitlines()) == 1 + 1001
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_db_client.py backend/tests/test_list_individuals.py backend/tests/test_rescore.py backend/tests/test_export_and_upsert.py -v`
Expected: FAIL. `fetch_all` and `paged` don't exist yet, and once they do, search, rescore and export still read one page.

- [ ] **Step 3: Implement `fetch_all(build, page_size=1000) -> list[dict]` and `paged(rows)`**

`fetch_all` loops `start = 0, page_size, ...`, running `build().range(start, start + page_size - 1).execute().data or []`. It appends rows whose `id` is new, or that have no `id`, and stops after a page shorter than `page_size`. Then switch every read listed under **Files** to it, inside `run_db` (or directly, in the sync `rescore_all_individuals` and `fetch_last_seen`), each with a unique `.order(...)`. Give `_ListQuery` a `range(start, end)` that slices the rows it returns.

- [ ] **Step 4: Run the tests and the full checks**

Expected: the new tests pass. Then run the full checks; fix any hand-made MagicMock chain listed under **Files** by adding `"range"` to its chained-method tuple.

- [ ] **Step 5: Commit**

```bash
git add backend/db/client.py backend/services backend/api backend/scripts backend/tests README.md CLAUDE.md
git commit -m "fix(api): page whole-table reads past PostgREST's 1,000-row cap" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: One shared `OpenAIService`

Roadmap item 2, second half.

**Files:**
- Modify: `backend/services/openai_service.py` (add `_service` and `get_openai_service` after the class, `:55-64`)
- Modify: `backend/api/transcription.py:14,72`; `backend/api/individuals.py:368-371` (`check_duplicates`; import at module top); `backend/api/voice_assistant.py:12,57`
- Modify: `backend/tests/conftest.py` (`reset()` also sets `openai_service._service = None`)
- Modify (rename patch targets): `test_duplicate_service_unit.py`, `test_error_contract.py`, `test_no_pii_logs.py`, `test_normalised_paths.py`, `test_request_limits.py`, `test_transcribe_route.py`
- Test: `backend/tests/test_openai_service.py`

**Interfaces:**
- Produces: `services/openai_service.py: def get_openai_service() -> OpenAIService` (lazy, module-level `_service`). Tests patch it per module: `patch("api.transcription.get_openai_service", return_value=fake)`.

- [ ] **Step 1: Write the failing tests** in `test_openai_service.py`

```python
from pathlib import Path
from services.openai_service import get_openai_service

def test_get_openai_service_returns_one_shared_service():
    assert get_openai_service() is get_openai_service()
    assert isinstance(get_openai_service(), OpenAIService)

def test_no_route_builds_its_own_openai_service():
    api_dir = Path(__file__).resolve().parents[1] / "api"
    assert not [p.name for p in api_dir.glob("*.py") if "OpenAIService()" in p.read_text()]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_openai_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'get_openai_service'`.

- [ ] **Step 3: Implement `get_openai_service() -> OpenAIService`, then switch the three routes to it.** Rename the test patch targets:

```bash
grep -rl "OpenAIService" backend/tests | xargs sed -i '' \
  -e 's/api\.transcription\.OpenAIService/api.transcription.get_openai_service/g' \
  -e 's/api\.voice_assistant\.OpenAIService/api.voice_assistant.get_openai_service/g' \
  -e 's/"services\.openai_service\.OpenAIService"/"api.individuals.get_openai_service"/g'
```

The calling convention is unchanged (`get_openai_service()` replaces `OpenAIService()`), so a patched `return_value` behaves as before.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/openai_service.py backend/api backend/tests
git commit -m "refactor(api): share one OpenAIService per process" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Model names from config

Roadmap item 8.

**Files:**
- Create: `backend/services/model_config.py`
- Modify: `backend/services/openai_service.py:69` (`_whisper`), `:222` (`categorize_transcription`), `:317` (`compare_individuals`)
- Modify: `backend/services/embedding_service.py:24,39` (`self.model` becomes a read-only property returning `model_config.EMBEDDING_MODEL`)
- Modify: `backend/main.py:286` (session `model`), `:327` (`openai_ws_url` query)
- Modify: `backend/.env.example`; `README.md:94-98` (the AI table names the env vars); `backend/README.md:31-38` (env table); the manual-steps **Environment variables** table (4 rows, Phase 1, service "backend")
- Test: `backend/tests/test_model_config.py` (new), `backend/tests/test_realtime_guard.py`

**Interfaces:**
- Produces: `services/model_config.py` with the module constants `CHAT_MODEL` (default `gpt-4o`), `TRANSCRIBE_MODEL` (`whisper-1`), `REALTIME_MODEL` (`gpt-realtime`) and `EMBEDDING_MODEL` (`text-embedding-3-large`). Each is read at import from the env var of the same name; blank or unset uses the default. Consumers write `from services import model_config` and read `model_config.X` at call time, so tests can `monkeypatch.setattr(model_config, "X", ...)`. Phase 3 adds `DUPLICATE_MODEL` and changes the `TRANSCRIBE_MODEL` default to `gpt-transcribe`; Phase 5 reads `TRANSCRIBE_MODEL` for the realtime input transcription. `whisper-1` stays this phase's default so behaviour doesn't change until Phase 3 also adds the vocabulary prompt.

- [ ] **Step 1: Write the failing tests** in `test_model_config.py`

```python
import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from services import model_config

NAMES = ("CHAT_MODEL", "TRANSCRIBE_MODEL", "REALTIME_MODEL", "EMBEDDING_MODEL")

@pytest.fixture(autouse=True)
def _restore():
    yield
    importlib.reload(model_config)

def test_defaults(monkeypatch):
    for n in NAMES: monkeypatch.delenv(n, raising=False)
    importlib.reload(model_config)
    assert [getattr(model_config, n) for n in NAMES] == \
        ["gpt-4o", "whisper-1", "gpt-realtime", "text-embedding-3-large"]

def test_env_overrides_and_blank_means_default(monkeypatch):
    monkeypatch.setenv("CHAT_MODEL", "gpt-test"); monkeypatch.setenv("REALTIME_MODEL", "  ")
    importlib.reload(model_config)
    assert model_config.CHAT_MODEL == "gpt-test" and model_config.REALTIME_MODEL == "gpt-realtime"

def _chat_reply(content="{}"):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])

async def test_categorize_and_compare_use_chat_model(monkeypatch):
    from services.openai_service import OpenAIService
    monkeypatch.setattr(model_config, "CHAT_MODEL", "chat-x")
    svc = OpenAIService(); create = AsyncMock(return_value=_chat_reply())
    monkeypatch.setattr(svc.client.chat.completions, "create", create)
    await svc.categorize_transcription("hi", []); await svc.compare_individuals("p")
    assert [c.kwargs["model"] for c in create.call_args_list] == ["chat-x", "chat-x"]

async def test_whisper_uses_transcribe_model(monkeypatch, tmp_path):
    # svc.whisper_client.audio.transcriptions.create patched; await svc._whisper(path)
    assert create.call_args.kwargs["model"] == "stt-x"

async def test_embeddings_use_embedding_model(monkeypatch):
    # EmbeddingService().client.embeddings.create patched; await generate_embedding("x")
    assert create.call_args.kwargs["model"] == "emb-x"
```

In `test_realtime_guard.py`:

```python
def test_ws_session_uses_realtime_model(ws_env, monkeypatch):
    import main
    from services import model_config
    urls = []
    monkeypatch.setattr(model_config, "REALTIME_MODEL", "rt-x")
    monkeypatch.setattr(main.websockets, "connect", lambda url, **k: urls.append(url) or ws_env)
    with _connect() as ws:
        ws.send_text(json.dumps({"type": "response.cancel"}))
    assert _FakeSecretClient.session["session"]["model"] == "rt-x"
    assert urls == ["wss://api.openai.com/v1/realtime?model=rt-x"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_model_config.py backend/tests/test_realtime_guard.py -k "model" -v`
Expected: FAIL with `ImportError: cannot import name 'model_config'`.

- [ ] **Step 3: Implement `services/model_config.py`** with a private `_env(name: str, default: str) -> str` helper (strip; blank means default). Replace the six hardcoded names listed under **Files**. Update `.env.example`, both READMEs and the manual-steps env table.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services backend/main.py backend/.env.example backend/tests README.md backend/README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(api): read OpenAI model names from config" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The server enforces the recording limits

Roadmap item 10.

**Files:**
- Modify: `requirements.txt` (add `mutagen==1.47.0`)
- Modify: `backend/services/openai_service.py` (add `AudioLimits`, `RECORDING_LIMITS`, `QUESTION_LIMITS`, `audio_duration_seconds` and `check_audio_duration` next to `AudioTooLarge`, `:31-32`; `transcribe_audio` (`:96-127`) and `transcribe_audio_file` (`:129-163`) take `limits: AudioLimits = RECORDING_LIMITS` and call `check_audio_duration` after the `ftyp` check, before `_whisper`)
- Modify: `backend/api/voice_assistant.py:57` (pass `limits=QUESTION_LIMITS`)
- Create: `backend/tests/fixtures/audio_2s.m4a`, `backend/tests/fixtures/audio_6s.m4a`
- Modify: `backend/tests/helpers.py` (add `fixture_audio`)
- Modify: `backend/tests/test_openai_service.py:9` (`M4A = fixture_audio("audio_6s.m4a")`), `test_request_limits.py:217` (stream the fixture bytes), `test_error_contract.py:201` (write the fixture bytes)
- Modify: `CLAUDE.md:45-46` (Recording rule: "the server re-checks the length with mutagen: 400 under 5 s or over 125 s (2:00 plus 5 s slack); assistant questions 1-60 s"); `README.md` Limits table (`:392-402`); `backend/README.md:93-99`
- Test: `backend/tests/test_audio_limits.py` (new)

**Interfaces:**
- Consumes: `get_openai_service` (Task 5).
- Produces, in `services/openai_service.py`, for Task 8 and Phase 7:
  - `@dataclass(frozen=True) class AudioLimits: min_seconds: float; max_seconds: float; too_short: str; too_long: str`
  - `RECORDING_LIMITS = AudioLimits(5, 125, "Audio must be at least 5 seconds long", "Audio must be less than 2 minutes")`
  - `QUESTION_LIMITS = AudioLimits(1, 60, "Question must be at least 1 second long", "Question must be under 1 minute")`
  - `def audio_duration_seconds(path: str) -> float`: `mutagen.mp4.MP4(path).info.length`, with `mutagen.MutagenError` re-raised as `ValueError("File is not in M4A format")`.
  - `def check_audio_duration(path: str, limits: AudioLimits) -> float`: `ValueError(limits.too_short)` below `min_seconds`, `ValueError(limits.too_long)` above `max_seconds`; returns the duration.
- Produces, in `tests/helpers.py`: `def fixture_audio(name: str) -> bytes` reads `backend/tests/fixtures/<name>`.

- [ ] **Step 1: Add mutagen and make the fixtures** (macOS `afconvert`, once; the files are committed and about 4 KB each)

Add `mutagen==1.47.0` to `requirements.txt` and run `python -m pip install -r requirements.txt`. Then:

```bash
mkdir -p backend/tests/fixtures && cd backend/tests/fixtures && python - <<'EOF'
import wave
for s in (2, 6):
    with wave.open(f"silence_{s}s.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000 * s)
EOF
for s in 2 6; do afconvert -f m4af -d aac -b 32000 silence_${s}s.wav audio_${s}s.m4a && rm silence_${s}s.wav; done
```

Expected: `python -c "import mutagen.mp4 as m; print(m.MP4('audio_2s.m4a').info.length, m.MP4('audio_6s.m4a').info.length)"` prints about `2.18 6.14`.

- [ ] **Step 2: Write the failing tests** in `test_audio_limits.py`

```python
import base64
from unittest.mock import AsyncMock, patch
import pytest
from fastapi.testclient import TestClient
from main import app
from services import openai_service
from services.openai_service import (OpenAIService, QUESTION_LIMITS, RECORDING_LIMITS,
                                     audio_duration_seconds, check_audio_duration)
from tests.helpers import FakeSupabase, fixture_audio

def _write(tmp_path, data):
    p = tmp_path / "a.m4a"; p.write_bytes(data); return str(p)

def test_duration_of_a_real_m4a(tmp_path):
    assert 6 < audio_duration_seconds(_write(tmp_path, fixture_audio("audio_6s.m4a"))) < 6.5

def test_m4a_header_that_mutagen_cannot_read_is_not_m4a(tmp_path):       # Review Focus 5
    with pytest.raises(ValueError, match="^File is not in M4A format$"):
        audio_duration_seconds(_write(tmp_path, b"\x00\x00\x00\x18ftypM4A " + b"x" * 100))

@pytest.mark.parametrize("seconds,error", [(4.9, "Audio must be at least 5 seconds long"), (5.0, None),
                                           (125.0, None), (125.1, "Audio must be less than 2 minutes")])
def test_recording_limits(monkeypatch, seconds, error):
    monkeypatch.setattr(openai_service, "audio_duration_seconds", lambda path: seconds)
    if error:
        with pytest.raises(ValueError, match=f"^{error}$"): check_audio_duration("x", RECORDING_LIMITS)
    else:
        assert check_audio_duration("x", RECORDING_LIMITS) == seconds

@pytest.mark.parametrize("seconds,error", [(0.9, "Question must be at least 1 second long"), (1.0, None),
                                           (60.0, None), (60.1, "Question must be under 1 minute")])
def test_question_limits_never_mention_5_seconds(monkeypatch, seconds, error):
    monkeypatch.setattr(openai_service, "audio_duration_seconds", lambda path: seconds)
    if error:
        with pytest.raises(ValueError, match=f"^{error}$"): check_audio_duration("x", QUESTION_LIMITS)
        assert "5 seconds" not in error
    else:
        assert check_audio_duration("x", QUESTION_LIMITS) == seconds

async def test_short_recording_never_reaches_whisper(tmp_path):
    svc = OpenAIService(); svc._whisper = AsyncMock(return_value="x")
    with pytest.raises(ValueError, match="at least 5 seconds"):
        await svc.transcribe_audio_file(_write(tmp_path, fixture_audio("audio_2s.m4a")))
    svc._whisper.assert_not_awaited()

async def test_two_second_question_is_transcribed(tmp_path):
    svc = OpenAIService(); svc._whisper = AsyncMock(return_value="hi")
    assert await svc.transcribe_audio_file(_write(tmp_path, fixture_audio("audio_2s.m4a")),
                                           limits=QUESTION_LIMITS) == "hi"

def test_transcribe_route_rejects_a_2s_recording_with_400():
    svc = OpenAIService(); svc._whisper = AsyncMock(return_value="x")
    sb = FakeSupabase().on("categories", "select",
                           data=[{"name": "name", "type": "text", "is_required": True, "options": None}])
    with patch("api.transcription.get_supabase", return_value=sb), \
         patch("api.transcription.get_openai_service", return_value=svc):
        r = TestClient(app).post("/api/transcribe",
                                 json={"audio_data": base64.b64encode(fixture_audio("audio_2s.m4a")).decode()})
    assert (r.status_code, r.json()) == (400, {"detail": "Audio must be at least 5 seconds long"})
    svc._whisper.assert_not_awaited()

def test_assistant_route_rejects_a_61s_question(monkeypatch):
    monkeypatch.setattr(openai_service, "audio_duration_seconds", lambda path: 61.0)
    svc = OpenAIService(); svc._whisper = AsyncMock(return_value="x")
    with patch("api.voice_assistant.get_openai_service", return_value=svc):
        r = TestClient(app).post("/api/voice-assistant/transcribe",
                                 files={"audio": ("q.m4a", fixture_audio("audio_6s.m4a"), "audio/m4a")})
    assert (r.status_code, r.json()) == (400, {"detail": "Question must be under 1 minute"})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_audio_limits.py -v`
Expected: FAIL with `ImportError: cannot import name 'QUESTION_LIMITS'`.

- [ ] **Step 4: Implement**

- Add the names listed under **Interfaces**, and call `check_audio_duration(path, limits)` in both transcribe methods. For the URL path, call it inside the `temp_audio_file` block.
- Switch the three older tests to the fixture bytes.
- Update CLAUDE.md and the READMEs.

- [ ] **Step 5: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add requirements.txt backend/services/openai_service.py backend/api/voice_assistant.py backend/tests CLAUDE.md README.md backend/README.md
git commit -m "feat(api): enforce recording and question length on the server" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Typed Whisper errors

Roadmap item 9.

**Files:**
- Modify: `backend/services/openai_service.py:119-127` (`transcribe_audio`) and `:143-163` (`transcribe_audio_file`: drop the blanket `try/except Exception` string match)
- Modify: `backend/tests/helpers.py` (add `openai_bad_request`)
- Modify: `backend/tests/test_openai_service.py:68-75` (replace the string-matching test)

**Interfaces:**
- Consumes: `AudioLimits`, `RECORDING_LIMITS`, `QUESTION_LIMITS` (Task 7).
- Produces: `services/openai_service.py: def whisper_client_message(exc: Exception, limits: AudioLimits) -> str | None`. It returns `limits.too_short` for an `openai.BadRequestError` whose `code == "audio_too_short"`, `limits.too_long` for `code == "audio_too_long"`, and `None` for anything else (which is re-raised, so the route answers 500).
- Produces: `tests/helpers.py: def openai_bad_request(code: str, param: str = "file") -> openai.BadRequestError`, built as `openai.BadRequestError("bad request", response=httpx2.Response(400, request=httpx2.Request("POST", "https://api.openai.com/v1/audio/transcriptions")), body={"code": code, "param": param})`. openai 3.26 ships `httpx2`.

- [ ] **Step 1: Write the failing tests** in `test_openai_service.py`

```python
import openai
from services.openai_service import QUESTION_LIMITS
from tests.helpers import fixture_audio, openai_bad_request

URL = f"{PROJECT_URL}/storage/v1/object/audio/a.m4a"

@pytest.mark.parametrize("code,message", [("audio_too_short", "Audio must be at least 5 seconds long"),
                                          ("audio_too_long", "Audio must be less than 2 minutes")])
def test_typed_whisper_errors_become_client_messages(svc, code, message):
    svc._whisper.side_effect = openai_bad_request(code)
    with pytest.raises(ValueError) as exc:
        _transcribe(svc, URL)
    assert str(exc.value) == message

def test_error_text_alone_is_no_longer_matched(svc):
    svc._whisper.side_effect = RuntimeError("Audio file is too short")
    with pytest.raises(RuntimeError):
        _transcribe(svc, URL)

def test_other_bad_requests_propagate(svc):
    svc._whisper.side_effect = openai_bad_request("invalid_value", param="model")
    with pytest.raises(openai.BadRequestError):
        _transcribe(svc, URL)

async def test_short_question_message_never_says_5_seconds(tmp_path):
    path = tmp_path / "q.m4a"; path.write_bytes(fixture_audio("audio_2s.m4a"))
    s = OpenAIService(); s._whisper = AsyncMock(side_effect=openai_bad_request("audio_too_short"))
    with pytest.raises(ValueError) as exc:
        await s.transcribe_audio_file(str(path), limits=QUESTION_LIMITS)
    assert str(exc.value) == "Question must be at least 1 second long" and "5 seconds" not in str(exc.value)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_openai_service.py -v`
Expected: FAIL. The typed errors aren't mapped (the string match misses them), and the untyped `RuntimeError` is still turned into a `ValueError`.

- [ ] **Step 3: Implement `whisper_client_message`**

Both transcribe methods wrap only the `_whisper` call:

```python
except openai.BadRequestError as e:
    message = whisper_client_message(e, limits)
    if message:
        raise ValueError(message) from e
    raise
```

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/openai_service.py backend/tests
git commit -m "fix(api): map Whisper duration errors by error code, not message text" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Error mapping

Roadmap item 4.

**Files:**
- Modify: `backend/services/individual_service.py` (add `class IndividualNotFound(LookupError)` near `:28`; raise it at `:233-234`, at `:262` when `update_response.data` is empty, and at `:515-525`)
- Modify: `backend/api/individuals.py:163-173` (`save_individual`: `except IndividualNotFound` gives 404 `f"Individual not found: {request.merge_with_id}"`, then `except ValidationError as e: raise internal_error("Save individual", e)`, both before `except ValueError`), and `:275-283` (`update_urgency_override` catches `IndividualNotFound`, not `ValueError`)
- Modify: `backend/api/transcription.py:148-157` and `backend/api/voice_assistant.py:64-70` (`except ValidationError` gives `internal_error(...)`, before `except ValueError`)
- Modify: `backend/db/models.py:40` (`f"Missing required fields: {', '.join(missing)}"`)
- Modify: `backend/tests/test_models.py:120,146` (comma form); `backend/tests/test_individual_service.py:40-48` (expects `IndividualNotFound`)
- Test: `backend/tests/test_error_contract.py`, `backend/tests/test_models.py`

**Interfaces:**
- Produces: `services/individual_service.py: class IndividualNotFound(LookupError)`. Phase 2's RPC save raises it when the target row is gone.
- Rule: in `backend/api/`, every `except ValueError` that answers 400 is preceded by `except ValidationError` (`from pydantic import ValidationError`), which answers `internal_error`.

- [ ] **Step 1: Write the failing tests** in `test_error_contract.py` (reuse `ID`, `T1` and `_db` from `test_individuals_routes.py` by importing them)

```python
from tests.test_individuals_routes import ID, T1, _db

def test_merge_whose_target_is_deleted_before_the_update_is_404():
    sb = _db()                                 # the route's existence check sees EXISTING
    sb.rules = [r for r in sb.rules if not (r.table == "individuals" and r.verb == "update")]
    sb.on("individuals", "update", data=[])    # ...then the update matches no row
    with patch("api.individuals.get_supabase", return_value=sb):
        r = _client().post("/api/individuals", json={"data": {"name": "Ann Lee", "height": 70, "weight": 150},
                                                     "merge_with_id": ID})
    assert (r.status_code, r.json()) == (404, {"detail": f"Individual not found: {ID}"})
    assert sb.calls_to("interactions", "insert") == []

def test_bad_stored_row_on_save_is_a_generic_500_that_echoes_nothing():
    sb = _db(existing=None)
    sb.rules = [r for r in sb.rules if not (r.table == "individuals" and r.verb == "insert")]
    sb.on("individuals", "insert", data=lambda call: [
        {"id": ID, "urgency_override": None, "last_location": None, "created_at": T1, "updated_at": T1,
         **call.payload, "urgency_score": "SECRET-not-a-number"}])
    with patch("api.individuals.get_supabase", return_value=sb):
        r = _client().post("/api/individuals", json={"data": {"name": "Ann", "height": 70, "weight": 150}})
    assert (r.status_code, r.json()) == (500, {"detail": "Save individual failed"})
    assert "SECRET" not in r.text

def test_bad_match_shape_on_transcribe_is_a_generic_500_that_echoes_nothing():
    # openai mock: transcribe_audio_file -> "t", categorize_transcription -> {};
    # DuplicateDetectionService patched so find_duplicates returns ["SECRET-MATCH"]
    assert (r.status_code, r.json()) == (500, {"detail": "Transcription failed"})
    assert "SECRET" not in r.text
```

In `test_models.py`:

```python
def test_missing_required_fields_are_listed_with_commas():
    with pytest.raises(ValidationError) as exc:
        SaveIndividualRequest(data={"name": "Ann"})
    assert "Missing required fields: height, weight" in str(exc.value) and "['" not in str(exc.value)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_error_contract.py backend/tests/test_models.py -v`
Expected: FAIL. The merge race gives a 500 (an `IndexError`), the bad row gives a 400 that echoes the value, and the message still prints `['height', 'weight']`.

- [ ] **Step 3: Implement** the changes listed under **Files**, and update the two older tests (`test_models.py:120,146` and `test_individual_service.py:40-48`) to the new behaviour.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/individual_service.py backend/api backend/db/models.py backend/tests
git commit -m "fix(api): 404 for a vanished merge target, 500 for bad stored rows" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Body and field limits on save

Roadmap item 5.

**Files:**
- Modify: `backend/main.py:85-89` (`BODY_LIMITS` adds `"/api/individuals": 256 * 1024`)
- Modify: `backend/db/models.py:12,23-45` (`MAX_TRANSCRIPTION_LENGTH = 20000`, `MAX_DATA_FIELDS = 100`; `transcription: Optional[str] = Field(None, max_length=MAX_TRANSCRIPTION_LENGTH)`; `validate_required_fields` raises `ValueError(f"data can have at most {MAX_DATA_FIELDS} fields")`)
- Modify: `README.md` Limits table (`:392-402`); `backend/README.md:120-140`
- Test: `backend/tests/test_request_limits.py`

**Interfaces:**
- Produces: `BODY_LIMITS["/api/individuals"] == 262144`. Phase 7 adds `/api/recordings` to the same dict.

- [ ] **Step 1: Write the failing tests** in `test_request_limits.py`

```python
VALID = {"name": "A", "height": 70, "weight": 150}

def test_save_body_over_256kb_is_413_before_any_work():
    with patch("api.individuals.get_supabase") as gs:
        r = _client().post("/api/individuals", json={"data": VALID, "notes": "x" * (256 * 1024)})
    assert r.status_code == 413 and r.json()["detail"] == "Request body too large (max 256 KB)"
    gs.assert_not_called()

def test_save_transcription_over_20000_chars_is_422():
    from db.models import SaveIndividualRequest
    assert SaveIndividualRequest(data=VALID, transcription="x" * 20000)
    assert _client().post("/api/individuals", json={"data": VALID, "transcription": "x" * 20001}).status_code == 422

def test_save_data_over_100_fields_is_422():
    from db.models import SaveIndividualRequest
    fields = {**VALID, **{f"f{i}": "v" for i in range(97)}}            # 100 keys
    assert SaveIndividualRequest(data=fields)
    r = _client().post("/api/individuals", json={"data": {**fields, "f97": "v"}})
    assert r.status_code == 422 and "at most 100 fields" in r.text
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_request_limits.py -k save -v`
Expected: FAIL. The 256 KB body reaches the route, and 20,001 characters or 101 fields are accepted.

- [ ] **Step 3: Implement** the changes listed under **Files**.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/db/models.py backend/tests README.md backend/README.md
git commit -m "fix(api): cap the save body at 256 KB, transcripts at 20,000 chars, data at 100 fields" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: API docs off by default, `/` removed

Roadmap item 6.

**Files:**
- Modify: `backend/main.py:65` (`app = FastAPI(title=..., version=..., **api_docs_urls(os.getenv("ENABLE_API_DOCS")))`) and `:166-174` (delete `root`)
- Modify: `backend/tests/test_security_routes.py:12` (`PUBLIC = {"/health"}`), `:53-56`, `:69-72`
- Modify: `backend/tests/conftest.py:17-20` (force `os.environ["ENABLE_API_DOCS"] = "0"`, not `setdefault`: `main.py` calls `load_dotenv()`, which never overrides a set variable, so a developer's `backend/.env` can't turn the docs on under test)
- Modify: `backend/.env.example`; `README.md:427`; `backend/README.md:42`; the manual-steps env table (`ENABLE_API_DOCS`, unset = off, backend)
- Test: `backend/tests/test_security_routes.py`

**Interfaces:**
- Produces: `main.py: def api_docs_urls(value: str | None) -> dict[str, str | None]`.

- [ ] **Step 1: Write the failing tests** in `test_security_routes.py`

```python
from main import api_docs_urls

def test_api_docs_urls_only_with_enable_api_docs_1():
    off = {"docs_url": None, "redoc_url": None, "openapi_url": None}
    assert api_docs_urls(None) == off and api_docs_urls("0") == off and api_docs_urls("true") == off
    assert api_docs_urls("1") == {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}

@pytest.mark.real_auth
@pytest.mark.parametrize("path", ["/", "/docs", "/redoc", "/openapi.json"])
def test_docs_and_root_are_404_by_default(path):
    assert TestClient(app).get(path).status_code == 404
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_security_routes.py -v`
Expected: FAIL with `ImportError: cannot import name 'api_docs_urls'`.

- [ ] **Step 3: Implement** `api_docs_urls` (only the exact string `"1"` enables the docs), delete `root`, set `PUBLIC = {"/health"}`, and update the docs.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass. `test_every_api_route_is_401_without_a_token` still covers every route.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests backend/.env.example README.md backend/README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "fix(api): hide /docs and /openapi.json unless ENABLE_API_DOCS=1; drop /" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Per-device rate limits, with save, category create and delete limited

Roadmap item 7 (limits and `X-Device-Id`).

**Files:**
- Create: `backend/api/device.py`
- Modify: `backend/services/rate_limit.py:1-9` (docstring), `:64-78` (`rate_limit`), and add `limit_key`, `total_env_var`, `check_keyed_limit` and `DEFAULT_TOTAL_MULTIPLIER = 5`
- Modify: `backend/api/individuals.py:85` (save: `user_id: str = Depends(rate_limit("save", "RATE_LIMIT_SAVE_PER_MIN", 30))`) and `:298` (delete: `rate_limit("delete", "RATE_LIMIT_DELETE_PER_MIN", 30)`)
- Modify: `backend/api/categories.py:157` (`rate_limit("category_create", "RATE_LIMIT_CATEGORY_CREATE_PER_MIN", 10)`)
- Modify: `backend/main.py:277-280` (the ws connect check uses `check_keyed_limit` with `clean_device_id(websocket.headers.get("x-device-id"))`)
- Modify: `backend/.env.example`; `README.md:403-415` (per-device keying, the three new rows, the `_TOTAL_PER_MIN` rule; reword "Every phone on the shared demo account shares one budget"; say the in-memory fixed window is deliberate while there is one process) and `:672`; `backend/README.md:38`; `CLAUDE.md:69-71` (the rule covers paid **or heavy** routes: save, category create and delete too; limits key on user id plus `X-Device-Id`, with a per-process total); the manual-steps env table
- Test: `backend/tests/test_rate_limit.py`, `backend/tests/test_realtime_guard.py`

**Interfaces:**
- Produces: `api/device.py`:
  - `DEVICE_ID_HEADER = "X-Device-Id"`
  - `def clean_device_id(value: str | None) -> str | None` (strips surrounding whitespace, then `^[A-Za-z0-9-]{8,64}$`, else None)
  - `def get_device_id(x_device_id: str | None = Header(None, alias=DEVICE_ID_HEADER)) -> str | None` (a FastAPI dependency returning `clean_device_id(x_device_id)`). This is the **only** backend reader of the header: Phase 2's audit log and Phase 7's recordings take `Depends(get_device_id)` from `api.device`; no phase adds a second helper. The header is optional, because Phase 6 (which makes the app send it) may land after Phases 2-4: a missing or malformed header is `None` and never fails a request.
- Produces: `services/rate_limit.py`:
  - `def limit_key(user_id: str, device_id: str | None) -> str`: `f"{user_id}:{device_id}"`, or `user_id` alone.
  - `def total_env_var(env_var: str) -> str`: `"RATE_LIMIT_SAVE_PER_MIN"` becomes `"RATE_LIMIT_SAVE_TOTAL_PER_MIN"`.
  - `def check_keyed_limit(bucket: str, user_id: str, device_id: str | None, env_var: str, default_per_minute: int) -> int | None`: None when allowed, else the Retry-After seconds. It checks the key's window first, then the bucket's per-process window under the key `"__process__"`, with total = `limit_from_env(total_env_var(env_var), per_key * DEFAULT_TOTAL_MULTIPLIER)`.
  - `rate_limit(bucket, env_var, default_per_minute)` keeps its signature. Its dependency also takes `device_id: str | None = Depends(get_device_id)` and uses `check_keyed_limit`.

- [ ] **Step 1: Write the failing tests** in `test_rate_limit.py`

```python
from api.device import clean_device_id

UUID_ID = "3f2b8c1e-0d4a-4c1e-9a7b-2b1f0c9d8e7a"

@pytest.mark.parametrize("raw,expected", [(None, None), ("", None), ("short", None), ("x" * 65, None),
                                          ("bad id!!", None), (UUID_ID, UUID_ID), (f"  {UUID_ID} ", UUID_ID)])
def test_clean_device_id(raw, expected):
    assert clean_device_id(raw) == expected

def test_limit_key_and_total_env_var():
    assert rl.limit_key("u1", None) == "u1" and rl.limit_key("u1", UUID_ID) == f"u1:{UUID_ID}"
    assert rl.total_env_var("RATE_LIMIT_SAVE_PER_MIN") == "RATE_LIMIT_SAVE_TOTAL_PER_MIN"

def test_each_device_has_its_own_budget_under_one_process_total(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_SAVE_PER_MIN", "1"); monkeypatch.setenv("RATE_LIMIT_SAVE_TOTAL_PER_MIN", "2")
    body = {"json": {"data": {"name": "Ann", "height": 70, "weight": 150}}}
    with patch("api.individuals.get_supabase", side_effect=RuntimeError("no db")):
        codes = [_client().post("/api/individuals", headers={"X-Device-Id": d}, **body).status_code
                 for d in ("device-aaaa", "device-aaaa", "device-bbbb", "device-cccc")]
    assert codes == [500, 429, 500, 429]

def test_total_defaults_to_five_times_the_per_device_limit(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_X_PER_MIN", "1")
    allowed = [rl.check_keyed_limit("x", "u", f"device-{i:04d}", "RATE_LIMIT_X_PER_MIN", 9) is None for i in range(6)]
    assert allowed == [True] * 5 + [False]
```

Add these rows to `PAID_ROUTES` (`:85-94`), and add `patch("api.categories.get_supabase", side_effect=RuntimeError("no db"))` to the test's `with` block (expected first status 500 for all three):

```python
("RATE_LIMIT_SAVE_PER_MIN", "post", "/api/individuals", {"json": {"data": {"name": "Ann", "height": 70, "weight": 150}}}),
("RATE_LIMIT_CATEGORY_CREATE_PER_MIN", "post", "/api/categories", {"json": {"name": "Shoes", "type": "text"}}),
("RATE_LIMIT_DELETE_PER_MIN", "delete", "/api/individuals/11111111-1111-1111-1111-111111111111", {}),
```

In `test_realtime_guard.py`, give `_connect(device_id=None)` an optional `X-Device-Id` header, then:

```python
def test_ws_connect_limit_is_per_device(ws_env, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_WS_CONNECT_PER_MIN", "1")
    with _connect("device-aaaa") as ws:
        ws.send_text(json.dumps({"type": "response.cancel"}))
    with _connect("device-aaaa") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    with _connect("device-bbbb") as ws:                 # another phone still gets in
        ws.send_text(json.dumps({"type": "response.cancel"}))
        # poll ws_env.sent (as test_ws_drops_session_update_and_reports_it does) for the cancel
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_rate_limit.py backend/tests/test_realtime_guard.py -k "device or limit or paid" -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.device'`. Once that exists, the three new routes are still not limited.

- [ ] **Step 3: Implement** the names listed under **Interfaces**. Then switch the save, delete and category-create routes and the ws check, and update the docs listed under **Files**.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass, including `test_limits_are_per_user` and `test_rate_limit_runs_after_auth`.

- [ ] **Step 5: Commit**

```bash
git add backend/api backend/services/rate_limit.py backend/main.py backend/tests backend/.env.example README.md backend/README.md CLAUDE.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(api): key rate limits on user plus X-Device-Id; limit save, category create and delete" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Realtime session caps

Roadmap item 7 (concurrent sessions).

**Files:**
- Modify: `backend/services/rate_limit.py` (add `acquire_session`, `release_session` and `active_sessions`; `reset_rate_limits` also clears the session counts)
- Modify: `backend/main.py:271-389` (`websocket_realtime_proxy`: after the connect-rate check and before the client-secret request, acquire a slot for `limit_key(user_id, device_id)` with `limit_from_env("REALTIME_MAX_SESSIONS_PER_USER", 2)` and `limit_from_env("REALTIME_MAX_SESSIONS_TOTAL", 20)`; if that fails, close 1008 `"Too many voice sessions open. Close one and try again."`; release in the outer `finally` at `:388`, only if a slot was acquired)
- Modify: `backend/.env.example`; `README.md` Limits table (`:401`); `CLAUDE.md:69-71`; the manual-steps env table (2 rows)
- Test: `backend/tests/test_rate_limit.py`, `backend/tests/test_realtime_guard.py`

**Interfaces:**
- Consumes: `limit_key`, `clean_device_id` (Task 12).
- Produces: `services/rate_limit.py`:
  - `def acquire_session(key: str, per_key: int, total: int) -> bool`
  - `def release_session(key: str) -> None` (never below 0)
  - `def active_sessions(key: str | None = None) -> int` (None means the process total)

  Phase 5's reconnect relies on the 1008 close and on slots being released in `finally`.

- [ ] **Step 1: Write the failing tests**

In `test_rate_limit.py`:

```python
def test_session_slots_per_key_and_per_process():
    assert rl.acquire_session("a", 2, 3) and rl.acquire_session("a", 2, 3)
    assert not rl.acquire_session("a", 2, 3)                 # per key
    assert rl.acquire_session("b", 2, 3)
    assert not rl.acquire_session("c", 2, 3)                 # per process
    rl.release_session("a")
    assert rl.acquire_session("c", 2, 3)
    assert (rl.active_sessions(), rl.active_sessions("a")) == (3, 1)

def test_release_never_goes_below_zero():
    rl.release_session("nobody")
    assert rl.active_sessions("nobody") == 0 and rl.active_sessions() == 0
```

In `test_realtime_guard.py`:

```python
import time
from services import rate_limit as rl

def _wait_for_no_sessions():
    for _ in range(200):
        if rl.active_sessions() == 0: return True
        time.sleep(0.01)
    return False

def test_ws_third_session_for_one_user_is_refused(ws_env):
    assert rl.acquire_session("user-ws", 2, 20) and rl.acquire_session("user-ws", 2, 20)
    with _connect() as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008 and "voice sessions" in exc.value.reason

def test_ws_process_cap(ws_env, monkeypatch):
    monkeypatch.setenv("REALTIME_MAX_SESSIONS_TOTAL", "1")
    assert rl.acquire_session("someone-else", 2, 20)
    with _connect() as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008

def test_ws_releases_its_slot_when_the_session_ends(ws_env):
    with _connect() as ws:
        ws.send_text(json.dumps({"type": "response.cancel"}))
    assert _wait_for_no_sessions()

def test_ws_releases_its_slot_after_an_upstream_failure(monkeypatch):    # Review Focus 4
    # same setup as test_ws_upstream_secret_failure_closes_with_1011 (_Fail secret client)
    assert _wait_for_no_sessions()

def test_rate_limited_connect_holds_no_slot(ws_env, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_WS_CONNECT_PER_MIN", "1")
    # first connect normal, second refused with 1008 (as test_ws_connect_is_rate_limited)
    assert _wait_for_no_sessions()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_rate_limit.py backend/tests/test_realtime_guard.py -k "session or slot" -v`
Expected: FAIL with `AttributeError: module 'services.rate_limit' has no attribute 'acquire_session'`.

- [ ] **Step 3: Implement** the three functions under the existing `_lock`, as a `dict[str, int]` plus a total. Wire them into the proxy as listed under **Files**, and update the docs.

- [ ] **Step 4: Run the tests and the full checks.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/rate_limit.py backend/main.py backend/tests backend/.env.example README.md CLAUDE.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(api): cap concurrent realtime sessions per device and per process" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task order

Run the tasks in order, 1 to 13.

- Task 3 needs Task 2.
- Task 4 needs Task 3 (`fetch_all` runs inside `run_db`, and the strict fakes check it).
- Task 7 needs Task 5 (tests patch `get_openai_service`).
- Task 8 needs Task 7 (`AudioLimits`, the fixtures).
- Task 13 needs Task 12 (`limit_key`, `clean_device_id`).
- Tasks 6, 9, 10 and 11 are independent of each other, but keep the order so line references stay close.

## Interfaces produced for later phases

| Name | Where | Used by |
|---|---|---|
| `get_supabase() -> Client` (lazy, one per process, PostgREST timeout 20 s) | `backend/db/client.py` | every phase; Phase 2 calls `get_supabase().rpc(...)` |
| `async def run_db(fn: Callable[[], T]) -> T` | `backend/db/client.py` | Phase 2 (`save_individual` RPC, `record_audit`), 3 (`find_duplicate_candidates`), 4 (`retrieval.py`), 7 (worker) |
| `def fetch_all(build: Callable[[], Any], page_size: int = 1000) -> list[dict]` (order by a unique key) | `backend/db/client.py` | Phase 2 (batched re-score), 4 (`backfill --stale`), 6 (cursor pagination) |
| Test convention: `patch("<module>.get_supabase", return_value=fake)`, `patch("<module>.get_openai_service", return_value=fake)`; conftest resets `db.client._client` and `services.openai_service._service` | `backend/tests/` | every backend phase |
| Strict fakes: `execute()` on the event loop raises `AssertionError`; `paged(rows)`; `_ListQuery.range` | `backend/tests/helpers.py` | Phase 2 extends `FakeSupabase` with `on_rpc` / `rpc` / `rpc_params` / `pg_error` under the same rule |
| `fixture_audio(name)`, `openai_bad_request(code, param="file")`, `backend/tests/fixtures/audio_{2,6}s.m4a` | `backend/tests/helpers.py` | Phases 3, 7 |
| `get_openai_service() -> OpenAIService` | `services/openai_service.py` | Phases 3, 5, 7 |
| `CHAT_MODEL`, `TRANSCRIBE_MODEL`, `REALTIME_MODEL`, `EMBEDDING_MODEL` (read as `model_config.X` at call time) | `services/model_config.py` | Phase 3 adds `DUPLICATE_MODEL` and changes the `TRANSCRIBE_MODEL` default to `gpt-transcribe`; Phase 5 reads `REALTIME_MODEL` and `TRANSCRIBE_MODEL` |
| `AudioLimits`, `RECORDING_LIMITS`, `QUESTION_LIMITS`, `audio_duration_seconds(path) -> float`, `check_audio_duration(path, limits) -> float`, `whisper_client_message(exc, limits) -> str \| None` | `services/openai_service.py` | Phase 3 (new transcribe model keeps typed errors), Phase 7 (`POST /api/recordings` runs the same M4A and duration checks) |
| `IndividualNotFound(LookupError)` (routes answer 404) | `services/individual_service.py` | Phase 2 (RPC save maps SQLSTATE `P0002` to it; no second not-found class) |
| `BODY_LIMITS` (exact-path keys) | `backend/main.py` | Phase 7 adds `/api/recordings` at 8 MB |
| `DEVICE_ID_HEADER`, `clean_device_id(value)`, `get_device_id` dependency (the one backend helper; header optional) | `backend/api/device.py` | Phase 2 (audit `device_id`: `Depends(get_device_id)`), Phase 6 (the app sends `X-Device-Id`), Phase 7 (`recordings.device_id`: `Depends(get_device_id)`) |
| `rate_limit(bucket, env_var, default)`, `check_keyed_limit(...)`, `limit_key(user_id, device_id)`, `total_env_var(env_var)` | `services/rate_limit.py` | Phase 7 (`POST /api/recordings`, rate-limited like transcribe) |
| `acquire_session`, `release_session`, `active_sessions`; ws close 1008 `"Too many voice sessions open. Close one and try again."` | `services/rate_limit.py`, `backend/main.py` | Phase 5 (reconnect with backoff) |
| `api_docs_urls(value)`; `ENABLE_API_DOCS=1` | `backend/main.py` | Phase 8 (docs) |
| Env vars added: `CHAT_MODEL`, `TRANSCRIBE_MODEL`, `REALTIME_MODEL`, `EMBEDDING_MODEL`, `ENABLE_API_DOCS`, `RATE_LIMIT_SAVE_PER_MIN`, `RATE_LIMIT_CATEGORY_CREATE_PER_MIN`, `RATE_LIMIT_DELETE_PER_MIN`, `RATE_LIMIT_*_TOTAL_PER_MIN`, `REALTIME_MAX_SESSIONS_PER_USER`, `REALTIME_MAX_SESSIONS_TOTAL` | manual-steps file, `backend/.env.example` | Phase 8 (README known limitations) |
