# Phase 2: Data Integrity and the Database Implementation Plan

> **For agentic workers:** Implement this plan task by task yourself, in order (no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every write to the VoiceReach database transactional, idempotent, concurrency-safe and auditable, keep history immutable, and give the schema a real migration chain.

**Architecture:** Postgres functions (`save_individual`, `rescore_batch`, `coarsen_old_locations`) do the multi-row work in one transaction. The backend calls them through `supabase.rpc(...)`, maps their SQLSTATEs to HTTP codes, and the strict test fake learns to script `rpc`. Each schema change is a numbered idempotent migration, also folded into `schema.sql`. The app sends a per-review `Idempotency-Key` and the merge target's `version`, and handles the resulting 409.

**Tech Stack:** Python 3.11, FastAPI, supabase-py / postgrest-py, PL/pgSQL (Supabase Postgres 15+), pytest; Expo SDK 53 / React Native 0.79, TypeScript, Jest; `expo-crypto` (new).

**Spec:** `docs/superpowers/plans/2026-10-23-00-roadmap.md` (Owner decisions, Global constraints, Phase 1 interfaces, and "Phase 2: data integrity and the database"). Read it first.

**Line numbers** below are from `main@ce238db`, before Phase 1. Phase 1 moves code around (`run_db`, `get_supabase`, `fetch_all`), so use the named function to find the code and the line range only as a guide.

## Global Constraints

- Python 3.11 venv: `python3.11 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt -r requirements-dev.txt`.
- Every task ends green on: `python -m pytest -q` (repo root, offline), `ruff check backend --select F,E9`, `cd mobile && npx tsc --noEmit && npx jest`.
- Tests are offline. `FakeSupabase` is strict: an unscripted query fails the test. This phase extends it to script `rpc` the same strict way (Task 1).
- CLAUDE.md rules hold: no unauthenticated routes; never reintroduce `skin_color`; never call `supabase.from` in `mobile/`; no PII in logs (`backend/tests/test_no_pii_logs.py`, `mobile/test/noDataLogs.test.ts`); database text reaches a model only as a delimited `user` item.
- A change to a rule CLAUDE.md or README states updates CLAUDE.md and README in the same task.
- Migrations: new files in `supabase/migrations/` named `2026110P0000SS_<snake_name>.sql` (this phase: `20261102000001_...` onwards). They must be idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`). The same change is folded into `supabase/schema.sql`. `test_schema_contract.py` and `test_schema_sql.py` keep passing and are extended. Every migration gets a line in the manual-steps file.
- Manual-steps file: `docs/superpowers/plans/2026-10-23-manual-steps.md` (created by Phase 1). Append to its sections **Apply migrations**, **Environment variables**, **Device checks** and **Owner actions outside code**. Agents never apply anything to hosted Supabase or Railway.
- Git: branch `hardening-2`, one commit per task, conventional prefix, every message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never commit `.env` files. Never push to `jasonyi33/voicereach`.
- Device-only checks go into the manual-steps file and never block a task.
- Keep it simple: no new services. Comment style matches the surrounding code. New items use the audit code `H2-2.<n>`, with n the roadmap item number (e.g. `(H2-2.3)` for optimistic concurrency).

## Review Focus

1. **ManualEntryForm saves a second person after a successful save.** The form stays mounted. If it reused the first save's `Idempotency-Key`, the server would replay the first person's result and silently drop the second person. The key must be renewed after every successful save (test in Task 6).
2. **A merge retry after a lost response.** The first attempt committed (version N to N+1); the retry sends the same key with `expected_version` N. It must replay (200), not 409. So the SQL function checks the key before the version, and Python never 409s on its own read (tests in Tasks 3 and 4).
3. **An urgency override or a background re-score lands between opening the merge screen and pressing Merge.** It must not cause a 409. Only `save_individual` bumps `version`; override and `rescore_batch` leave it alone (tests in Tasks 4, 13 and 3).
4. **Old interactions whose location is malformed, missing, already coarsened, or the person's newest.** `coarsen_old_locations` skips them without error and never rewrites one twice (test in Task 15).
5. **A data key, or a category, named `_removed`.** It would corrupt the merge diff, so both are rejected with 422 (test in Task 7).

## Deviations from roadmap

| # | Roadmap | This plan | Why |
|---|---|---|---|
| D1 | Move `schema.sql:251-301` into `seed.sql` | Move 251-313: the `last_location` backfill (303-313) goes too | It exists only for the seed rows. Left behind, it would rewrite real rows on every re-run. |
| D2 | Item 6: a trigger on `interactions` raises on UPDATE | One exemption: inside `coarsen_old_locations`, which sets the transaction-local `voicereach.coarsening = 'on'`, an UPDATE that changes only `location` is allowed | Item 11 must UPDATE `interactions.location`; without the exemption the two items contradict. |
| D3 | Item 11 rounds lat/lng only | Also strips a leading house number from `location.address` and marks the point `"coarsened": true` | A street address like "123 Market St" pins the spot to a few metres, which defeats rounding. The marker makes re-runs no-ops. |
| D4 | Item 2 names SQLSTATE `P0409` only | The function also raises `P0002` (no_data_found) for a missing merge target, mapped to 404 `Individual not found: <id>` | Phase 1's 404-on-race moves into the function. |
| D5 | Item 3: "A merge sends `expected_version`" | `expected_version` is optional on the API. A merge without it uses the version the service just read | Guards the service's own read-modify-write for an older client. The app always sends it. |
| D6 | Item 4 names `TranscriptionResults` / MergeUI | `ManualEntryForm` also sends an `Idempotency-Key` (renewed after each successful save) | It saves through the same endpoint, and a retried save there can duplicate people too. |
| D7 | (not stated) | Every new non-trigger function gets `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE ... TO service_role` | Supabase exposes `public` functions on `/rest/v1/rpc` to the anon key. |
| D8 | Item 10: `CREATE EXTENSION IF NOT EXISTS pg_trgm` | `... WITH SCHEMA extensions`; the index uses `extensions.gin_trgm_ops` | Supabase convention (its linter flags extensions in `public`). Phases 3 and 4 reach `similarity()` / `%` (and pgvector) through `SET search_path = public, extensions`, which `test_every_function_pins_its_search_path` accepts. |
| D9 | Item 9: upsert **or** `rescore_batch` | `rescore_batch(p_rows jsonb)` with a per-row `version` guard | An upsert of `{id, urgency_score}` fails `individuals.name NOT NULL` on its INSERT path. The guard stops a re-score overwriting a save that landed after the read. |
| D10 | (not stated) | `SaveIndividualResponse` gains `replayed: bool = False` | The route must not audit or re-embed a replayed save. |

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `backend/tests/helpers.py` | `FakeSupabase.on_rpc/rpc/rpc_params`, `pg_error`, `save_rpc` | 1, 4 |
| `backend/tests/test_fake_supabase.py` (new) | The fake's own contract | 1 |
| `supabase/seed.sql` (new) | Demo people + seed interactions + their `last_location` backfill | 2 |
| `supabase/migrations/*.sql` (new, 7 files) | One idempotent change each | 3, 8, 9, 11, 13, 14, 15 |
| `supabase/schema.sql` | Full current schema for a fresh database | 2, 3, 8, 9, 11, 13, 14, 15 |
| `backend/tests/test_migrations.py` (new) | Naming, idempotency and schema.sql parity of every migration | 3 |
| `backend/services/individual_service.py` | Save through the RPC, version, `_removed` diff, batched re-score | 4, 7, 13 |
| `backend/api/individuals.py` | Idempotency-Key, 409/404 mapping, audit calls | 4, 10 |
| `backend/services/audit.py` (new) | `record_audit`, `AUDIT_ACTIONS` | 9 |
| `backend/api/device.py` (Phase 1) | `get_device_id` dependency, consumed as is | 10 |
| `backend/api/categories.py` | Audit calls, `number_scale_max`, background re-score | 10, 11, 13 |
| `backend/db/models.py` | `version`, `expected_version`, `replayed`, `_removed` guard, `number_scale_max` | 4, 7, 11 |
| `backend/services/urgency_calculator.py` | Scale max in the number term | 11 |
| `mobile/utils/requestId.ts` (new), `mobile/utils/saveConflict.ts` (new) | `newRequestId()`, `isVersionConflict()`, `VERSION_CONFLICT_MESSAGE` | 5 |
| `mobile/services/api.ts`, `mobile/types/index.ts` | Header, expected_version, one keyed retry, `version` on the profile | 5 |
| `mobile/components/MergeUI.tsx`, `TranscriptionResults.tsx`, `ManualEntryForm.tsx` | Version pass-through, 409 reload, per-session key | 6 |
| `mobile/components/InteractionDetailModal.tsx` | Removed fields shown as "removed" | 7 |
| `mobile/utils/categoryPayload.ts`, `mobile/screens/CategoriesScreen.tsx` | "Scale max" input | 12 |
| `README.md`, `CLAUDE.md`, `backend/README.md` | Rules and setup that changed | 2, 4, 8, 9, 11, 13, 15 |

---

### Task 1: Strict `rpc` scripting in FakeSupabase

**Files:**
- Modify: `backend/tests/helpers.py:33-155` (FakeSupabase, `_Chain`)
- Create: `backend/tests/test_fake_supabase.py`

**Interfaces:**
- Consumes: the existing `FakeSupabase`, `Call`, `_Rule`, `_Chain`.
- Produces (later tasks and phases use exactly these):
  - `FakeSupabase.on_rpc(name: str, data: Any = None, error: BaseException | None = None, times: int | None = None) -> FakeSupabase`. Same rule semantics as `on()`: used in the order added, `times=n` uses a rule n times, otherwise it stays; `data` may be a callable taking the `Call`.
  - `FakeSupabase.rpc(name: str, params: dict | None = None) -> _Chain`. The chain accepts the existing modifiers (`eq`, `limit`, `order`, `range`, `single`, `maybe_single`, ...) and `.execute()`. A second verb on it is an AssertionError.
  - It records `Call(table=name, verb="rpc", payload=copy.deepcopy(params or {}))`. `sb.calls_to(name, "rpc")` works.
  - `FakeSupabase.rpc_params(name: str) -> list[dict]`: the params of every executed call to that function, in order.
  - `execute()` on an rpc chain with no matching rule raises `AssertionError("FakeSupabase: nothing scripted for rpc('<name>').execute()")`. An `on(table, verb)` rule never answers an rpc, and an `on_rpc` rule never answers a table query.
  - `execute()` asserts `json.dumps(params)` succeeds, else raises `AssertionError` with "JSON" and the function name in the message. The real client serialises params with `json`, so a raw `UUID` or `datetime` must fail here as it would live.
  - An rpc result is `SimpleNamespace(data=<scripted value>)`, unchanged: a scripted `None` stays `None`, a dict stays a dict. The `None -> []` coercion is for table queries only. `single`/`maybe_single` behave as for tables.
  - `pg_error(code: str, message: str = "database error") -> postgrest.exceptions.APIError`, built from `{"code": code, "message": message, "details": None, "hint": None}`, so `.code == code`. Use it to simulate a `RAISE ... USING ERRCODE`.

- [x] **Step 1: Write the failing tests** in `backend/tests/test_fake_supabase.py`

```python
from uuid import uuid4
import pytest
from tests.helpers import FakeSupabase, pg_error

def test_unscripted_rpc_fails_naming_the_function():
    with pytest.raises(AssertionError, match=r"rpc\('save_individual'\)"):
        FakeSupabase().rpc("save_individual", {"p_name": "x"}).execute()

def test_rpc_returns_scripted_data_and_records_params():
    sb = FakeSupabase().on_rpc("save_individual", data={"replayed": False})
    assert sb.rpc("save_individual", {"p_name": "Ann"}).execute().data == {"replayed": False}
    assert sb.rpc_params("save_individual") == [{"p_name": "Ann"}]
    assert [c.verb for c in sb.calls_to("save_individual", "rpc")] == ["rpc"]

def test_rpc_data_callable_receives_the_call():
    sb = FakeSupabase().on_rpc("f", data=lambda call: call.payload["p_x"] * 2)
    assert sb.rpc("f", {"p_x": 21}).execute().data == 42

def test_rpc_error_is_raised_with_its_sqlstate():
    sb = FakeSupabase().on_rpc("save_individual", error=pg_error("P0409"))
    with pytest.raises(Exception) as info:
        sb.rpc("save_individual", {}).execute()
    assert info.value.code == "P0409"

def test_rpc_params_must_be_json_serialisable():
    sb = FakeSupabase().on_rpc("f", data=1)
    with pytest.raises(AssertionError, match="JSON"):
        sb.rpc("f", {"p_id": uuid4()}).execute()

def test_rpc_times_then_next_rule():
    sb = FakeSupabase().on_rpc("f", data=1, times=1).on_rpc("f", data=2)
    assert [sb.rpc("f").execute().data for _ in range(3)] == [1, 2, 2]

def test_rpc_and_table_rules_never_answer_each_other():
    sb = FakeSupabase().on_rpc("individuals", data=[]).on("rescore_batch", "select", data=[])
    with pytest.raises(AssertionError):
        sb.table("individuals").select("*").execute()
    with pytest.raises(AssertionError):
        sb.rpc("rescore_batch", {"p_rows": []}).execute()

def test_rpc_null_result_stays_none():
    assert FakeSupabase().on_rpc("f", data=None).rpc("f").execute().data is None
```

- [x] **Step 2: Run them and check they fail**

Run: `python -m pytest backend/tests/test_fake_supabase.py -q`
Expected: FAIL. `on_rpc`, `rpc` and `pg_error` don't exist yet.

- [x] **Step 3: Implement** `on_rpc`, `rpc`, `rpc_params` and `pg_error` in `backend/tests/helpers.py`. Store rpc rules as `_Rule(table=name, verb="rpc", ...)`. In `on()`, keep `assert verb in _VERBS` so `"rpc"` can only come through `on_rpc`. Give `_Chain` a constructor path that starts with the rpc `Call` already set. Extend the class docstring with the rpc chain shape.

- [x] **Step 4: Run the new tests and the whole suite**

Run: `python -m pytest -q`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add backend/tests/helpers.py backend/tests/test_fake_supabase.py
git commit -m "test: script supabase rpc calls strictly in FakeSupabase (H2-2.2)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Seed data out of schema.sql

**Files:**
- Create: `supabase/seed.sql`
- Modify: `supabase/schema.sql:1-19` (header), `:238-313` (remove the seed people, seed interactions and the `last_location` backfill; see D1)
- Modify: `backend/tests/test_schema_sql.py:1-29, 85-106, 139-151` (seed tests read `seed.sql`)
- Modify: `README.md` (Repository layout; Setup, 1. Database; Upgrading; Known issues "Re-running schema.sql re-adds..."; 4. Backfill embeddings), `CLAUDE.md` (Commands)

**Interfaces:**
- Produces: `supabase/seed.sql` is the only file that inserts demo people. `schema.sql` keeps the preset categories, which are required config, not demo data.

- [x] **Step 1: Write the failing tests** in `test_schema_sql.py`. Add `SEED_RAW = (ROOT/"supabase"/"seed.sql").read_text()` and `SEED_SQL` (comments stripped, as `SQL` is) plus `SEED_FLAT`. Then `_seed_individuals()` parses `SEED_SQL`, and the two guard tests (`test_seed_individuals_are_guarded_by_name`, `test_seed_interactions_only_for_seeded_people_without_history`) slice `SEED_FLAT`. Add:

```python
def test_schema_sql_inserts_no_demo_people():
    assert "INSERT INTO individuals" not in SQL and "INSERT INTO interactions" not in SQL
    for name in SEED_NAMES:
        assert f"'{name}'" not in SQL

def test_seed_backfills_last_location_only_where_missing():
    assert "UPDATE individuals i SET last_location = sub.location" in SEED_FLAT
    assert "AND i.last_location IS NULL" in SEED_FLAT

def test_seed_header_says_run_schema_first():
    assert "schema.sql" in SEED_RAW[:SEED_RAW.index("WITH seed")]
```

- [x] **Step 2: Run them and check they fail**

Run: `python -m pytest backend/tests/test_schema_sql.py -q`
Expected: FAIL. `seed.sql` is missing.

- [x] **Step 3: Move** `schema.sql:238-313` verbatim into `seed.sql`, under a header saying: optional demo data; run after `schema.sql`; never on production; re-running re-adds a deleted demo person (matched by name). In `schema.sql`, rewrite the header (lines 1-8). It is the full current schema for a fresh database: no demo people; upgrades are `supabase/migrations/` in order; still safe to re-run. Update the comment in `test_schema_sql.py`'s module docstring to say where each shape lives.

- [x] **Step 4: Update docs.**
  - README, Setup step 2: run `schema.sql`, then optionally `seed.sql` for the six demo people.
  - README, "Upgrading": apply `supabase/migrations/*.sql` in filename order. Re-running the current `schema.sql` also works.
  - README, Known issue: now "Re-running `seed.sql` re-adds a deleted demo person".
  - README, layout block: add `seed.sql` and `migrations/`.
  - CLAUDE.md, Commands: `# database: fresh = supabase/schema.sql then supabase/seed.sql (demo only); upgrade = supabase/migrations/ in order`.

- [x] **Step 5: Run the full checks**

Run: `python -m pytest -q && ruff check backend --select F,E9`
Expected: PASS (the seed urgency tests still find 6 people).

- [x] **Step 6: Commit**

```bash
git add supabase/schema.sql supabase/seed.sql backend/tests/test_schema_sql.py README.md CLAUDE.md
git commit -m "refactor(db): move demo people into supabase/seed.sql (H2-2.1)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migration 1, `save_individual`, `version` and `client_request_id`

**Files:**
- Create: `supabase/migrations/20261102000001_save_individual.sql`
- Create: `backend/tests/test_migrations.py`
- Modify: `supabase/schema.sql`: `individuals` table (44-55), `interactions` table (62-72), the upgrade section (88-154), a new "Functions" section after the `updated_at` triggers (after 180)
- Modify: `backend/tests/test_schema_sql.py:127-136` and new tests; `backend/tests/test_schema_contract.py:41-45`
- Modify: `docs/superpowers/plans/2026-10-23-manual-steps.md` (Apply migrations)

**Interfaces:**
- Produces:
  - Column `individuals.version INTEGER NOT NULL DEFAULT 1`.
  - Column `interactions.client_request_id UUID UNIQUE`. Its unique index `interactions_client_request_id_key` is the lookup index (roadmap item 10).
  - The SQL function below. It returns `{"individual": <individuals row>, "interaction": <interactions row>, "replayed": bool}`, each row as `to_jsonb(row)`.
  - SQLSTATE `P0409` means a version conflict; `P0002` means the merge target is missing.
  - `test_migrations.py` rules that every later migration (all phases) must pass.

- [x] **Step 1: Write the failing tests.**

`backend/tests/test_migrations.py`:
- `test_migration_names_follow_the_convention`: every file matches `^2026110[1-8]0000\d\d_[a-z0-9_]+\.sql$`, and the numeric prefixes are unique. Assert `len(files) >= 1` so the test is never vacuous.
- `test_migrations_are_idempotent`, parametrised per file, on the comment-stripped SQL:
  - every `CREATE TABLE` is `CREATE TABLE IF NOT EXISTS`;
  - every `CREATE [UNIQUE] INDEX` is `... IF NOT EXISTS`;
  - every `CREATE FUNCTION` is `CREATE OR REPLACE FUNCTION`;
  - every `CREATE EXTENSION` is `... IF NOT EXISTS`;
  - every `ADD COLUMN` is `ADD COLUMN IF NOT EXISTS`;
  - every `CREATE TRIGGER t ... ON tbl` is preceded by `DROP TRIGGER IF EXISTS t ON tbl;`;
  - every `ADD CONSTRAINT c` is preceded by `DROP CONSTRAINT IF EXISTS c`.
- `test_migrations_insert_no_demo_data`: no file contains `INSERT INTO individuals` or `INSERT INTO interactions`.
- `test_every_migration_object_is_in_schema_sql`, parametrised per file. Every table, `ADD COLUMN` column, index, trigger and constraint name the migration creates appears in `schema.sql` too. Every function's normalised block (`CREATE OR REPLACE FUNCTION name(` up to its closing `$$;`, whitespace collapsed) is **identical** in `schema.sql`. Every `REVOKE`/`GRANT EXECUTE` line is in `schema.sql` as well.

`backend/tests/test_schema_sql.py`:

```python
def _function(name):  # normalised block from "CREATE OR REPLACE FUNCTION name(" to its "$$;"
    start = FLAT.index(f"CREATE OR REPLACE FUNCTION {name}(")
    return FLAT[start:FLAT.index("$$;", FLAT.index("$$", start) + 2) + 3]

def test_individuals_version_and_interactions_request_id_columns():
    assert "INTEGER NOT NULL DEFAULT 1" in _column_def("individuals", "version")
    assert "UUID UNIQUE" in _column_def("interactions", "client_request_id")
    assert "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;" in FLAT
    assert "ALTER TABLE interactions ADD COLUMN IF NOT EXISTS client_request_id UUID UNIQUE;" in FLAT

def test_save_individual_signature():
    assert re.search(r"CREATE OR REPLACE FUNCTION save_individual\( ?p_individual_id uuid, p_name text, "
                     r"p_data jsonb, p_urgency_score int, p_interaction jsonb, p_expected_version int, "
                     r"p_client_request_id uuid ?\) RETURNS jsonb", FLAT)

def test_save_individual_replays_a_known_key_before_any_write():
    fn = _function("save_individual")
    lock, check = fn.index("pg_advisory_xact_lock"), fn.index("WHERE client_request_id = p_client_request_id")
    assert lock < check < fn.index("INSERT INTO public.individuals") and check < fn.index("UPDATE public.individuals")
    assert "'replayed', true" in fn and "'replayed', false" in fn

def test_save_individual_guards_and_bumps_the_version():
    fn = _function("save_individual")
    assert "version = version + 1" in fn
    assert "(p_expected_version IS NULL OR version = p_expected_version)" in fn
    assert "ERRCODE = 'P0409'" in fn and "ERRCODE = 'P0002'" in fn

def test_only_save_individual_changes_the_version():   # Review Focus 3
    others = FLAT.replace(_function("save_individual"), "")
    assert "version = version + 1" not in others

def test_every_function_pins_its_search_path():
    # '' (every name schema-qualified) or a fixed list; Phases 3 and 4 use public, extensions for pg_trgm/pgvector
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\(", FLAT):
        assert re.search(r"SET search_path = (''|public, extensions|public) ", _function(m.group(1))), m.group(1)

@pytest.mark.parametrize("fn", ["save_individual"])   # Tasks 13/15 append rescore_batch, coarsen_old_locations; P3 find_duplicate_candidates; P7 claim_recording_job, purge_old_recordings
def test_rpc_functions_are_not_callable_with_the_anon_key(fn):
    assert re.search(rf"REVOKE EXECUTE ON FUNCTION {fn}\([^)]*\) FROM PUBLIC, anon, authenticated;", FLAT)
    assert re.search(rf"GRANT EXECUTE ON FUNCTION {fn}\([^)]*\) TO service_role;", FLAT)
```

Also change `test_functions_and_triggers_are_replaceable` so every `CREATE ... FUNCTION` must be `CREATE OR REPLACE FUNCTION` (no longer exactly one). Its trigger regex becomes `CREATE TRIGGER (\w+) BEFORE [A-Z ]+? ON (\w+)`. In `test_schema_contract.py`, `test_schema_parser_sees_every_table_and_column` gains `version` on individuals and `client_request_id` on interactions.

- [x] **Step 2: Run them and check they fail**

Run: `python -m pytest backend/tests/test_migrations.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`
Expected: FAIL (there are no migrations, no function and no columns yet).

- [x] **Step 3: Write the migration and fold it into `schema.sql`.** The migration and `schema.sql` carry the same statements:
  - `ALTER TABLE individuals ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`
  - `ALTER TABLE interactions ADD COLUMN IF NOT EXISTS client_request_id UUID UNIQUE;`
  - In `schema.sql` the same two columns also go into the `CREATE TABLE` bodies, each with a one-line comment (`-- bumped only by save_individual (H2-2.3)`, `-- the save's Idempotency-Key (H2-2.4)`).
  - Then the function, its `REVOKE`/`GRANT` lines, and a comment block above it that explains the behaviour. Body (`LANGUAGE plpgsql`, `SET search_path = ''`, every table schema-qualified):

```sql
CREATE OR REPLACE FUNCTION save_individual(
    p_individual_id uuid, p_name text, p_data jsonb, p_urgency_score int,
    p_interaction jsonb, p_expected_version int, p_client_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_ind public.individuals; v_int public.interactions; v_loc jsonb;
BEGIN
    IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_interaction) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'p_data and p_interaction must be JSON objects' USING ERRCODE = '22023';
    END IF;
    -- 1. Idempotency: one save per key. The lock serialises two retries of the same key.
    IF p_client_request_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('save_individual:' || p_client_request_id::text, 0));
        SELECT * INTO v_int FROM public.interactions WHERE client_request_id = p_client_request_id;
        IF FOUND THEN
            SELECT * INTO v_ind FROM public.individuals WHERE id = v_int.individual_id;
            RETURN jsonb_build_object('individual', to_jsonb(v_ind), 'interaction', to_jsonb(v_int), 'replayed', true);
        END IF;
    END IF;
    v_loc := NULLIF(p_interaction->'location', 'null'::jsonb);   -- absent or JSON null -> SQL NULL
    -- 2. The person: insert, or update guarded by the version the client saw
    IF p_individual_id IS NULL THEN
        INSERT INTO public.individuals (name, data, urgency_score, last_location)
        VALUES (p_name, p_data, p_urgency_score, v_loc) RETURNING * INTO v_ind;
    ELSE
        UPDATE public.individuals
        SET name = p_name, data = p_data, urgency_score = p_urgency_score,
            last_location = COALESCE(v_loc, last_location), version = version + 1
        WHERE id = p_individual_id AND (p_expected_version IS NULL OR version = p_expected_version)
        RETURNING * INTO v_ind;
        IF NOT FOUND THEN
            IF EXISTS (SELECT 1 FROM public.individuals WHERE id = p_individual_id) THEN
                RAISE EXCEPTION 'This person was changed by someone else. Reload and try again.' USING ERRCODE = 'P0409';
            END IF;
            RAISE EXCEPTION 'Individual not found' USING ERRCODE = 'P0002';
        END IF;
    END IF;
    -- 3. The visit, in the same transaction (no compensating delete any more)
    INSERT INTO public.interactions (individual_id, user_id, user_name, transcription, audio_url,
                                     location, changes, client_request_id)
    VALUES (v_ind.id, p_interaction->>'user_id', COALESCE(p_interaction->>'user_name', 'Unknown'),
            p_interaction->>'transcription', p_interaction->>'audio_url', v_loc,
            COALESCE(NULLIF(p_interaction->'changes', 'null'::jsonb), '{}'::jsonb), p_client_request_id)
    RETURNING * INTO v_int;
    RETURN jsonb_build_object('individual', to_jsonb(v_ind), 'interaction', to_jsonb(v_int), 'replayed', false);
END;
$$;
```

Why the `UPDATE ... WHERE version = p_expected_version` is safe without `FOR UPDATE`: two concurrent merges with the same expected version queue on the row lock. Under READ COMMITTED the second re-checks its `WHERE` against the committed row, sees `version + 1`, matches nothing, and raises `P0409`. `updated_at` comes from the existing `set_updated_at` trigger.

- [x] **Step 4: Append to the manual-steps file**, under **Apply migrations**: `1. supabase/migrations/20261102000001_save_individual.sql (Phase 2, Task 3): run in the SQL Editor. Check: select version, count(*) from individuals group by 1; returns version 1 for every row.`

- [x] **Step 5: Run the checks**

Run: `python -m pytest -q && ruff check backend --select F,E9`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add supabase/ backend/tests/test_migrations.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(db): save_individual function with version guard and idempotency key (H2-2.2, H2-2.3, H2-2.4)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Backend saves through the RPC, with 409 and Idempotency-Key

**Files:**
- Modify: `backend/services/individual_service.py:175-346` (`save_individual`), `:440-499` (`get_individual_by_id` response building)
- Modify: `backend/api/individuals.py:81-173` (save route)
- Modify: `backend/db/models.py:23-45` (`SaveIndividualRequest`), `:65-75` (`IndividualResponse`), `:97-100` (`SaveIndividualResponse`)
- Modify: `backend/tests/helpers.py` (add `save_rpc`), `backend/tests/test_individuals_routes.py:38-205`, `test_individual_service.py:42-59`, `test_schema_contract.py:94-128`, `test_no_pii_logs.py:55-100` (its `FakeDB` gains `rpc`). Also every other test that POSTs `/api/individuals`: find them with `grep -ln 'post("/api/individuals"' backend/tests`.
- Modify: `README.md` (Known issues: delete "Saving is not transactional"; Duplicate detection paragraph), `CLAUDE.md` (Duplicates rule), `backend/README.md` (`POST /api/individuals`)

**Interfaces:**
- Consumes: Task 1 (`on_rpc`, `rpc_params`, `pg_error`), Task 3 (function and return shape), Phase 1 (`run_db`, `get_supabase`, and the save route's `Depends(rate_limit(...))` that yields `user_id`).
- Produces:
  - `services/individual_service.py`:
    - `VERSION_CONFLICT_DETAIL = "This person was changed by someone else. Reload and try again."`
    - `class VersionConflictError(Exception)`
    - no new not-found class: reuse Phase 1's `IndividualNotFound(LookupError)` from the same module
    - `_individual_response(row: dict) -> IndividualResponse` and `_interaction_summary(row: dict) -> InteractionSummary`, shared with `get_individual_by_id`
    - `async def save_individual(self, user_id: str, user_name: str, data: dict, merge_with_id: UUID | None = None, location: LocationData | None = None, transcription: str | None = None, audio_url: str | None = None, expected_version: int | None = None, client_request_id: UUID | None = None) -> SaveIndividualResponse`
  - `db/models.py`:
    - `IndividualResponse.version: int`, filled with `row.get("version", 1)` so pre-migration fixtures still validate
    - `SaveIndividualRequest.expected_version: Optional[int] = Field(None, ge=1)`; a model validator answers 422 `expected_version needs merge_with_id` when it is set without `merge_with_id`
    - `SaveIndividualResponse.replayed: bool = False`
  - The route reads `Idempotency-Key` (`Header(None, alias="Idempotency-Key")`). Any value that `uuid.UUID()` rejects is a 400 `Idempotency-Key must be a UUID`, before any database call.
  - Errors: `VersionConflictError` gives 409 `VERSION_CONFLICT_DETAIL`; `IndividualNotFound` gives 404 `Individual not found: <id>`; any other `APIError` gives `internal_error`.
  - `tests/helpers.py: save_rpc(existing: dict | None = None, *, new_id: str = ID1, interaction_id: str = ID2, at: str = "2026-02-01T00:00:00+00:00") -> Callable[[Call], dict]`. It plays the function's behaviour from the params: insert or update, `version` = existing + 1 or 1, `last_location` = location or existing, and an interaction row holding the `p_interaction` fields plus `client_request_id`. It returns `replayed: False`.

Service flow (the order matters for Review Focus 2):
1. Read the categories. Normalise; on errors raise `ValueError` (unchanged). Compute the urgency score.
2. For a merge, read `select("id, data, version").eq("id", ...).maybe_single()`. None raises `IndividualNotFound`. Diff with `get_changed_fields`.
3. Set `p_expected_version` to `expected_version` if given, else the version just read. **Never compare versions in Python.** The function checks the key first.
4. Call `await run_db(lambda: self.supabase.rpc("save_individual", params).execute())`. Every UUID in `params` is a `str`. `p_interaction = {"user_id", "user_name", "transcription", "audio_url", "location", "changes"}`; `location` is the dict or `None`; `changes` is the full `data` for a new person.
5. Map `APIError.code` `"P0409"` to `VersionConflictError` and `"P0002"` to `IndividualNotFound`. Build the response from the returned rows, with `replayed`.

Delete the compensating delete and the `"updated_at"` write (the trigger sets it). The route drops its own `get_individual_by_id` pre-check, because the service's read covers it. On `result.replayed` the route skips the background embedding (and, from Task 10, the audit).

- [ ] **Step 1: Write the failing tests.** In `test_individuals_routes.py`, `_db()` scripts `sb.on_rpc("save_individual", data=save_rpc(existing))` instead of the `individuals`/`interactions` insert and update rules. `_writes(sb)` also returns rpc calls as `(name, "rpc")`. Rewrite the POST tests to assert on `sb.rpc_params("save_individual")`:

```python
def test_new_person_is_one_rpc_with_normalised_data_urgency_and_location():
    ...  # same request as today's test_new_person_insert_carries_normalised_data_computed_urgency_and_location
    assert sb.rpc_params("save_individual") == [{
        "p_individual_id": None, "p_name": "Ann Lee", "p_data": data, "p_urgency_score": 45,
        "p_interaction": {"user_id": "test-user-123", "user_name": "Demo User",
                          "transcription": "Met Ann by the library", "audio_url": "audio/u/1.m4a",
                          "location": LOCATION, "changes": data},
        "p_expected_version": None, "p_client_request_id": None}]
    assert _writes(sb) == [("save_individual", "rpc")]          # no table writes, no compensating delete
    assert r.json()["individual"]["version"] == 1

def test_merge_sends_the_clients_expected_version_and_only_the_changes():
    sb = _db(existing={**EXISTING, "version": 3})
    r = _merge(sb, {"name": "Ann Lee", "height": 71, "weight": 150, "veteran_status": "Yes",
                    "medical_conditions": ["Diabetes"]}, expected_version=3)
    [params] = sb.rpc_params("save_individual")
    assert (params["p_individual_id"], params["p_expected_version"]) == (ID, 3)
    assert params["p_interaction"]["changes"] == {"height": 71, "veteran_status": "Yes"}
    assert r.json()["individual"]["version"] == 4

def test_merge_without_expected_version_guards_with_the_version_it_read():
    sb = _db(existing={**EXISTING, "version": 4})
    _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150, "medical_conditions": ["Diabetes"]})
    assert sb.rpc_params("save_individual")[0]["p_expected_version"] == 4

def test_version_conflict_is_409_with_the_exact_message():
    sb = _db(); sb.rules = [x for x in sb.rules if x.verb != "rpc"]
    sb.on_rpc("save_individual", error=pg_error("P0409"))
    with patch("api.individuals.invalidate_context_cache") as invalidate:
        r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150}, expected_version=1)
    assert r.status_code == 409
    assert r.json() == {"detail": "This person was changed by someone else. Reload and try again."}
    invalidate.assert_not_called()

def test_target_deleted_before_the_rpc_is_404():       # P0002 from the function
    ...  # on_rpc error=pg_error("P0002") -> 404 {"detail": f"Individual not found: {ID}"}

def test_other_database_error_from_the_rpc_is_a_500_without_its_text():
    ...  # pg_error("XX000", "Ann Lee leaked") -> 500, "Ann Lee" not in r.text

def test_idempotency_key_becomes_client_request_id():
    ...  # headers={"Idempotency-Key": KEY} -> params["p_client_request_id"] == KEY (a str)

@pytest.mark.parametrize("key", ["abc", "", "550e8400-e29b-41d4-a716"])
def test_a_key_that_is_not_a_uuid_is_400_before_any_query(key):
    ...  # -> 400 {"detail": "Idempotency-Key must be a UUID"}; sb.calls == []

def test_a_replayed_save_returns_the_first_result_and_schedules_no_embedding():
    ...  # on_rpc returns {..., "replayed": True}; patch api.individuals.generate_embedding_background
         # -> 200, body["individual"]["id"] == first id, body["replayed"] is True, embedding not scheduled

def test_retry_with_a_stale_expected_version_replays_instead_of_409():   # Review Focus 2
    ...  # existing version 2, expected_version=1, Idempotency-Key set, rpc scripted to replay -> 200

def test_expected_version_without_merge_with_id_is_422():
    ...

def test_profile_includes_version():
    ...  # GET /api/individuals/{ID} with existing version 7 -> body["individual"]["version"] == 7
```

Keep, adapted to rpc params: the auto-trigger, no-location (`p_interaction["location"] is None`, `p_individual_id is None`), override-survives (no param carries `urgency_override`), omitted-fields-dropped (`p_data` lacks `medical_conditions`; Task 7 adds the `_removed` assertion), merge-with-location, 404-merge, cache-invalidation and all 400/422-write-nothing tests.

In `test_individual_service.py`, replace the race test with `test_merge_target_missing_raises_individual_not_found_and_calls_no_rpc`. Its calls are `[("categories","select"), ("individuals","select")]`, and no `rpc` call is made.

In `test_schema_contract.py`:
- `_recording_db` adds `on_rpc("save_individual", data=save_rpc(ROW))`.
- `test_individual_writes_use_existing_columns` asserts the table writes are only `{("individuals","update")}` (the override).
- Add `test_rpc_params_match_the_function_signature`: for every rpc call, `set(call.payload)` equals the parameter names parsed from `CREATE OR REPLACE FUNCTION <name>(...)` in `schema.sql`. Also `set(payload["p_interaction"]) <= SCHEMA["interactions"]`.
- Add a static test, `test_every_rpc_names_a_function_in_schema_sql`: every `\.rpc\("(\w+)"` in `BACKEND_SOURCES` has a `CREATE OR REPLACE FUNCTION \1(` in `schema.sql`.

- [ ] **Step 2: Run them and check they fail**

Run: `python -m pytest backend/tests/test_individuals_routes.py backend/tests/test_individual_service.py backend/tests/test_schema_contract.py -q`
Expected: FAIL (the code still writes tables directly).

- [ ] **Step 3: Implement** the service, route and model changes listed under Interfaces. Then update every other test that POSTs `/api/individuals` (`grep` above) to script `on_rpc("save_individual", data=save_rpc(...))`. Give `test_no_pii_logs.FakeDB` an `rpc(name, params)` that echoes a row the same way.

- [ ] **Step 4: Update docs.**
  - README: delete the "Saving is not transactional" known issue. In "Duplicate detection", say a save is one transaction (`save_individual`), a merge sends the version it loaded and a stale one gets 409 with the message, and `Idempotency-Key` makes a retry return the first save's result.
  - CLAUDE.md Duplicates rule, after "A merge replaces the whole `data` JSONB...": add "guarded by `individuals.version` (409 `This person was changed by someone else. Reload and try again.`); a save is one `save_individual` transaction and `Idempotency-Key` makes it idempotent."
  - `backend/README.md`: the request fields, header and status codes.

- [ ] **Step 5: Run the full checks**

Run: `python -m pytest -q && ruff check backend --select F,E9`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/ README.md CLAUDE.md
git commit -m "feat(api): save through save_individual with 409 on stale version and Idempotency-Key (H2-2.2, H2-2.3, H2-2.4)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: App API client, Idempotency-Key, expected_version and one keyed retry

**Files:**
- Create: `mobile/utils/requestId.ts`, `mobile/utils/saveConflict.ts`, `mobile/utils/__tests__/requestId.test.ts`
- Modify: `mobile/services/api.ts:89-118` (`authedFetch`), `:207-254` (`SaveIndividualRequest`, `saveIndividual`), `:283-308` (`getIndividualProfile`)
- Modify: `mobile/types/index.ts` (`IndividualProfile.version: number`), `mobile/test/setup.js` (mock `expo-crypto`)
- Modify: `mobile/services/__tests__/saveIndividual.test.ts`, `mobile/services/__tests__/dataAccess.test.ts`
- Modify: `mobile/package.json` (`npx expo install expo-crypto`), manual-steps file (Device checks)

**Interfaces:**
- Produces:
  - `utils/requestId.ts: export const newRequestId = (): string`, a UUID v4 from `expo-crypto`'s `randomUUID()`. This is the app's one UUID helper: Phase 6's `getDeviceId` and Phase 7's `client_recording_id` use it (Phase 6 still adds `react-native-get-random-values`, but only for `aes-js`). If Phase 6 ran first and already created this file (and the `expo-crypto` install and mock) exactly as specified here, keep it.
  - `utils/saveConflict.ts: export const VERSION_CONFLICT_MESSAGE = 'This person was changed by someone else. Reload and try again.'` and `export const isVersionConflict = (e: unknown): boolean` (`(e as any)?.status === 409`, duck-typed so tests that mock `services/api` still work).
  - `api.ts`:
    - `SaveIndividualRequest` gains `expected_version?: number | null` and `idempotency_key?: string`.
    - `authedFetch(path, init, opts: { timeoutMs?: number; retryNetwork?: boolean })`: `retryNetwork` adds the GET-style single retry after `NETWORK_RETRY_DELAY_MS` for a non-GET.
    - `saveIndividual` sends `idempotency_key` as the `Idempotency-Key` header, never in the body. It sends `expected_version` in the body only with `merge_with_id`. It passes `retryNetwork: !!req.idempotency_key`. Timeouts and HTTP errors are never retried.
    - `getIndividualProfile` maps `version: individual.version ?? 1`.
  - If Phase 6 has already rewritten `getIndividualProfile` (`Promise.all`), add `version` to its new shape. If Phase 6 also added `api.getIndividual(id)` (MergeUI's loader), it already returns the raw individual, `version` included.

- [ ] **Step 1: Write the failing tests.**

`saveIndividual.test.ts`:

```typescript
const KEY = '7d444840-9dc0-11d1-b245-5ffdce74fad2';
const headersOf = (m: jest.Mock, i = 0) => (m.mock.calls[i] as any)[1].headers;

it('sends idempotency_key as the Idempotency-Key header, never in the body', async () => {
  const fetchMock = jest.fn(async () => okResponse({ individual: { id: 'x' } }));
  (global as any).fetch = fetchMock;
  await api.saveIndividual({ data: { name: 'Ann' }, idempotency_key: KEY });
  expect(headersOf(fetchMock)['Idempotency-Key']).toBe(KEY);
  expect(Object.keys(sentBody(fetchMock))).toEqual(['data']);
});

it('sends expected_version only with merge_with_id', async () => {
  // with merge_with_id: body.expected_version === 3; without: no expected_version key
});

it('retries a keyed save once after a network failure, with the same key', async () => {
  const fetchMock = jest.fn()
    .mockRejectedValueOnce(new TypeError('Network request failed'))
    .mockResolvedValueOnce(okResponse({ individual: { id: 'x' } }));
  (global as any).fetch = fetchMock;
  await expect(api.saveIndividual({ data: { name: 'Ann' }, idempotency_key: KEY })).resolves.toMatchObject({ id: 'x' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(headersOf(fetchMock, 1)['Idempotency-Key']).toBe(KEY);
});

it('does not retry an unkeyed save after a network failure', async () => { /* 1 call, ApiError kind 'network' */ });
it('does not retry a keyed save after an HTTP 500', async () => { /* 1 call, ApiError status 500 */ });
```

`dataAccess.test.ts`: `getIndividualProfile` returns `version: 4` from `{individual: {..., version: 4}}`, and `1` when the field is absent.

`utils/__tests__/requestId.test.ts`: `newRequestId()` matches `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`, and two calls differ. `isVersionConflict` is true for `{status: 409}` and false for `{status: 400}`, `null` and `new Error()`.

- [ ] **Step 2: Run them and check they fail**

Run: `cd mobile && npx jest services utils/__tests__/requestId.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Run `cd mobile && npx expo install expo-crypto`. In `test/setup.js`, add `jest.mock('expo-crypto', () => ({ randomUUID: () => require('crypto').randomUUID() }))`. Then write the code listed under Interfaces.

- [ ] **Step 4: Append to the manual-steps file**, under **Device checks**: `N. (Phase 2, Task 5) expo-crypto is a new native module: run cd mobile && npx expo prebuild --platform ios (or pod install in mobile/ios), rebuild with npx expo run:ios, record and save one person. Expected: the save succeeds and the backend log shows no 400 for Idempotency-Key.`

- [ ] **Step 5: Run the full checks**

Run: `cd mobile && npx tsc --noEmit && npx jest`, then `python -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/ docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(mobile): send Idempotency-Key and expected_version on save, retry a keyed save once (H2-2.3, H2-2.4)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Review screens, per-session key, version pass-through and 409 reload

**Files:**
- Modify: `mobile/components/MergeUI.tsx:14-25` (props), `:54-74` (load effect), `:95-130` (submit, handleMerge)
- Modify: `mobile/components/TranscriptionResults.tsx:119-125` (`save`), `:202-232` (`handleMerge`, `handleCreateNew`)
- Modify: `mobile/components/ManualEntryForm.tsx:77-86` (`resetForm`), `:131-214` (save handlers)
- Test: `mobile/components/__tests__/MergeUI.test.tsx`, `TranscriptionResults.test.tsx`, `ManualEntryForm.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`newRequestId`, `isVersionConflict`, `SaveIndividualRequest.expected_version` / `idempotency_key`, `IndividualProfile.version`).
- Produces:
  - `MergeUIProps.onMerge: (mergedData: Record<string, any>, mergeWithId: string, expectedVersion?: number) => void | Promise<void>`.
  - Optional prop `existingVersion?: number`, used with `existingData`.
  - MergeUI keeps the loaded profile's `version` next to its data. When `onMerge` rejects with a version conflict, MergeUI:
    1. shows the error once (`showApiError(e, 'Save failed')`, whose text is the server detail);
    2. drops the loaded person and the worker's field choices;
    3. re-fetches the person (a `reloadKey` state in the load effect's deps; this also applies after a conflict when `existingData` was passed). Before Phase 6 that is `api.getIndividualProfile(id)`; after Phase 6 Task 12 it is `api.getIndividual(id)`. Use whichever the file calls, and mock that one in the tests below;
    4. passes the new version on the next Merge.
  - Parents (`TranscriptionResults`, `ManualEntryForm`) re-throw an error for which `isVersionConflict(error)` is true, without showing it, so MergeUI handles it. Every other error keeps today's handling (one toast, from the parent).
  - Idempotency-Key:
    - `TranscriptionResults` makes one key per mount (`useRef(newRequestId())`) and sends it on every save of that review: new, merge and Create New.
    - `ManualEntryForm` keeps its key in a ref and renews it in `resetForm()`, so after every successful save (Review Focus 1). A failed save keeps the key for the retry.

- [ ] **Step 1: Write the failing tests.**

`MergeUI.test.tsx` (`conflict` is `Object.assign(new Error(MSG), { status: 409, detail: MSG, kind: 'http' })`):
- `it('passes the loaded version to onMerge')`: the profile resolves `{ data: mockExistingData, version: 3 }`. After Merge, `expect(onMerge).toHaveBeenCalledWith(expect.any(Object), mockPotentialMatch.id, 3)`.
- `it('on a 409 shows the message once and reloads the person, then merges with the new version')`: `onMerge` rejects once with `conflict`. The profile resolves version 3, then `{ data: {...mockExistingData, age: 50}, version: 4 }`. Then:
  - `Toast.show` was called once with `expect.objectContaining({ text2: MSG })`;
  - `api.getIndividualProfile` was called twice;
  - `'50'` is on screen;
  - a second Merge calls `onMerge` with `..., 4`.
- `it('resets the field choices after a conflict reload')`: flip a field to Existing, hit the conflict, and after the reload that field is back at its default selection.

`TranscriptionResults.test.tsx`:
- `it('sends one Idempotency key for every save attempt in a review')`: the first `saveIndividual` rejects with `outage`, the second resolves. Both calls carry the same `idempotency_key`, which matches the UUID regex.
- `it('passes expected_version from the loaded match to the merge save')`: the profile has version 5. `saveIndividual` was called with `expect.objectContaining({ merge_with_id: MATCH_ID, expected_version: 5 })`.
- `it('leaves a 409 on merge to MergeUI: one toast, and the person is re-fetched')`: `saveIndividual` rejects with `conflict`, `Toast.show` is called once, and `getIndividualProfile` is called twice.

`ManualEntryForm.test.tsx`:
- `it('uses a new Idempotency key after a successful save')`: save person A, fill in and save person B. The two calls' `idempotency_key` differ.
- `it('reuses the key when a failed save is retried')`.

- [ ] **Step 2: Run them and check they fail**

Run: `cd mobile && npx jest components/__tests__/MergeUI.test.tsx components/__tests__/TranscriptionResults.test.tsx components/__tests__/ManualEntryForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block. The parents' `save(...)` helpers pass `expected_version` and `idempotency_key` to `api.saveIndividual`. The existing test "a failed merge save shows one error toast (the parent catches; MergeUI adds none)" must still pass unchanged.

- [ ] **Step 4: Run the full checks**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/components
git commit -m "feat(mobile): merge sends the loaded version, reloads on 409, one Idempotency-Key per review (H2-2.3, H2-2.4)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Merge history records removed fields

**Files:**
- Modify: `backend/services/individual_service.py:108-136` (`get_changed_fields`)
- Modify: `backend/db/models.py:31-45` (`SaveIndividualRequest.validate_required_fields`), `:163-172` (`CreateCategoryRequest.clean_name`)
- Modify: `mobile/components/InteractionDetailModal.tsx:29-32, 95-106`
- Test: `backend/tests/test_individual_service.py`, `test_individuals_routes.py` (`test_merge_replaces_data_wholesale_so_omitted_fields_are_dropped`), `test_models.py`, `test_create_category.py`, `mobile/components/__tests__/InteractionDetailModal.test.tsx`

**Interfaces:**
- Produces:
  - `REMOVED_KEY = "_removed"` in `services/individual_service.py`.
  - `get_changed_fields(old_data, new_data) -> dict`. A key whose old value is non-empty but which is absent or empty in `new_data` becomes `changes[key] = None`. Its name goes into `changes["_removed"]`, sorted. `_removed` is present only when something was removed, and a `_removed` key in either input is ignored.
  - A `data` key that `category_key()` maps to `"_removed"` is a 422: `_removed is a reserved field name`.
  - A category name whose `category_key()` is `"_removed"` is a 422: `That name is reserved`.
  - Mobile: `InteractionDetailModal` lists each field in `data._removed` as `<label>: removed`. It never renders `_removed` itself as a field.

- [ ] **Step 1: Write the failing tests.**

```python
def test_get_changed_fields_records_a_removed_field_as_null_with_a_removed_list(service):
    old = {"name": "Ann", "notes": "x", "age": 40, "conditions": ["Diabetes"]}
    assert service.get_changed_fields(old, {"name": "Ann", "age": 41}) == {
        "age": 41, "notes": None, "conditions": None, "_removed": ["conditions", "notes"]}

def test_an_empty_old_value_is_not_a_removal(service):
    assert service.get_changed_fields({"name": "Ann", "notes": "", "tags": []}, {"name": "Ann"}) == {}

def test_a_removed_key_in_the_inputs_is_ignored(service):
    assert service.get_changed_fields({"_removed": ["x"]}, {"_removed": ["y"]}) == {}
```

- Route test: the merge that omits `medical_conditions` has `p_interaction["changes"] == {"medical_conditions": None, "_removed": ["medical_conditions"]}`.
- `test_models.py`: `SaveIndividualRequest(data={"name": "A", "height": 1, "weight": 1, "_Removed": 1})` raises with `_removed is a reserved field name`.
- `test_create_category.py`: posting `{"name": "_removed", "type": "text"}` gives 422 with `That name is reserved`, and nothing is inserted.
- Jest:

```typescript
it('shows each removed field as "removed" and never the _removed list itself', () => {
  const interaction: any = { id: 'i1', individual_id: 'p1', user_id: '', created_at: '2026-01-01T00:00:00Z',
    data: { age: 41, notes: null, hiv_status: null, _removed: ['hiv_status', 'notes'] } };
  const screen = render(<InteractionDetailModal visible interaction={interaction} onClose={jest.fn()}
    categories={[{ name: 'hiv_status', display_name: 'HIV status', type: 'text' }]} />);
  expect(screen.getByText('HIV status:')).toBeTruthy();
  expect(screen.getByText('Notes:')).toBeTruthy();
  expect(screen.getAllByText('removed')).toHaveLength(2);
  expect(screen.queryByText('Removed:')).toBeNull();
  expect(screen.queryByText('hiv_status, notes')).toBeNull();
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `python -m pytest backend/tests/test_individual_service.py backend/tests/test_individuals_routes.py backend/tests/test_models.py backend/tests/test_create_category.py -q; cd mobile && npx jest components/__tests__/InteractionDetailModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block. In the modal, removed rows use the existing `value` style plus a muted italic style.

- [ ] **Step 4: Run all checks** (backend, ruff, tsc, jest).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/ mobile/components
git commit -m "feat: merge history records removed fields as _removed and shows them (H2-2.5)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Migration 2, interactions are append-only

**Files:**
- Create: `supabase/migrations/20261102000002_interactions_append_only.sql`
- Modify: `supabase/schema.sql` (Functions section; triggers next to `set_updated_at`'s), `:57-61` (table comment)
- Test: `backend/tests/test_schema_sql.py`, `backend/tests/test_schema_contract.py`
- Modify: `README.md` (data model paragraph; deleting a person), manual-steps file

**Interfaces:**
- Produces:
  - Trigger function `interactions_append_only()` and trigger `interactions_append_only` (`BEFORE UPDATE ON interactions FOR EACH ROW`).
  - The coarsening exemption (D2): the transaction-local setting `voicereach.coarsening`. Task 15 sets it.
  - DELETE stays allowed, so the person's cascade still works.

Trigger body (`plpgsql`, `SET search_path = ''`):

```sql
IF current_setting('voicereach.coarsening', true) = 'on'
   AND (to_jsonb(NEW) - 'location') = (to_jsonb(OLD) - 'location') THEN
    RETURN NEW;                          -- coarsen_old_locations only (H2-2.11)
END IF;
RAISE EXCEPTION 'interactions are append-only' USING ERRCODE = '55000';
```

- [ ] **Step 1: Write the failing tests.**
  - `test_interactions_reject_update`: `FLAT` contains `DROP TRIGGER IF EXISTS interactions_append_only ON interactions;` before `CREATE TRIGGER interactions_append_only BEFORE UPDATE ON interactions FOR EACH ROW EXECUTE FUNCTION interactions_append_only()`. The function contains `RAISE EXCEPTION 'interactions are append-only'`, `current_setting('voicereach.coarsening', true) = 'on'` and `(to_jsonb(NEW) - 'location') = (to_jsonb(OLD) - 'location')`.
  - `test_interactions_delete_is_still_allowed`: no `BEFORE DELETE` or `BEFORE UPDATE OR DELETE` trigger on `interactions`, and `REFERENCES individuals(id) ON DELETE CASCADE` is still on `interactions.individual_id`.
  - `test_contract`, in `test_schema_contract.py`: `test_no_backend_code_updates_interactions`. No `.table("interactions")` chain in `CHAINS` contains `.update(` or `.upsert(`.

- [ ] **Step 2: Run them and check they fail** (`python -m pytest backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`).

- [ ] **Step 3: Write the migration and fold it into `schema.sql`.** Change the `interactions` table comment to "append-only: a trigger refuses UPDATE (except location coarsening); DELETE is allowed so a person's history goes with them".

- [ ] **Step 4: Docs and manual step.** README data model paragraph: "the database refuses any edit to an interaction". README "Deleting a person": "Deleting a person hard-deletes their history; that is the deliberate right-to-deletion choice." Manual-steps file, Apply migrations: `2. 20261102000002_interactions_append_only.sql. Check: update interactions set user_name = user_name where false; succeeds, and the same without "where false" fails with "interactions are append-only".`

- [ ] **Step 5: Run the checks** (`python -m pytest -q && ruff check backend --select F,E9`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/ backend/tests README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(db): interactions are append-only; delete stays allowed (H2-2.6)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Migration 3, the audit log table and `record_audit`

**Files:**
- Create: `supabase/migrations/20261102000003_audit_log.sql`, `backend/services/audit.py`, `backend/tests/test_audit.py`
- Modify: `supabase/schema.sql` (new table, RLS line, trigger functions and triggers)
- Modify: `backend/tests/test_schema_sql.py` (`TABLES` gains `audit_log`; the `CREATE TABLE` count goes from 4 to 5), `backend/tests/test_schema_contract.py:41-42` (table set)
- Modify: `README.md` ("Data leaving the system": new row), manual-steps file

**Interfaces:**
- Consumes: Phase 1's `backend/api/device.py: get_device_id` dependency (and `clean_device_id`). This phase adds no device-id helper of its own. The header is optional: until Phase 6 makes the app send it, `device_id` is `None` in the audit rows.
- Produces:
  - Table (`schema.sql` format: one column per line, closing `\n);`):
    ```sql
    CREATE TABLE IF NOT EXISTS audit_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id     TEXT NOT NULL,
        device_id   TEXT,
        action      TEXT NOT NULL CHECK (action IN ('view_profile','export_csv','delete_individual',
                        'override_urgency','merge_individual','create_individual','create_category')),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('individual','category','export')),
        entity_id   TEXT,
        detail      JSONB NOT NULL DEFAULT '{}'
    );
    ```
    No FK, so a deleted person's audit rows stay (ids only, no personal data). RLS is enabled with no policies.
  - Function `audit_log_append_only()` (`plpgsql`, `SET search_path = ''`; `RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '55000'`) with two triggers: `audit_log_append_only` (`BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW`) and `audit_log_no_truncate` (`BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT`).
  - `services/audit.py`:
    - `AUDIT_ACTIONS: frozenset[str]`, the seven actions.
    - `AUDIT_ENTITY_TYPES = frozenset({"individual", "category", "export"})`.
    - `def record_audit(supabase, *, user_id: str, device_id: str | None, action: str, entity_type: str, entity_id: str | None, detail: dict | None = None) -> None`. It inserts `{"user_id", "device_id", "action", "entity_type", "entity_id", "detail": detail or {}}` into `audit_log`. It never raises.
    - An unknown action or entity type is not written; it logs `logger.warning("Audit skipped: unknown action %s", action)`.
    - Any exception, including a strict fake's `AssertionError`, is logged as `logger.warning("Audit write failed for %s: %s", action, type(e).__name__)` (no ids, no detail).
    - It is sync. Async routes call it as `await run_db(lambda: record_audit(...))`.
    - `detail` must never hold names or field values (see Task 10's table).

- [ ] **Step 1: Write the failing tests** in `test_audit.py`:

```python
def test_record_audit_inserts_one_row():
    sb = FakeSupabase().on("audit_log", "insert", data=lambda c: [c.payload])
    record_audit(sb, user_id="u1", device_id="device-1234", action="view_profile",
                 entity_type="individual", entity_id=ID)
    assert sb.payloads("audit_log", "insert") == [{"user_id": "u1", "device_id": "device-1234",
        "action": "view_profile", "entity_type": "individual", "entity_id": ID, "detail": {}}]

def test_record_audit_never_raises_and_logs_no_personal_data(caplog):
    sb = FakeSupabase().on("audit_log", "insert", error=RuntimeError("Ann Lee, HIV positive"))
    with caplog.at_level(logging.WARNING):
        assert record_audit(sb, user_id="u1", device_id=None, action="export_csv",
                            entity_type="export", entity_id=None, detail={"rows": 3}) is None
    assert "RuntimeError" in caplog.text and "export_csv" in caplog.text and "Ann" not in caplog.text

def test_an_unknown_action_is_not_written(caplog): ...      # FakeSupabase() with nothing scripted; sb.calls == []

def test_audit_actions_match_the_schema_check():
    check = re.search(r"action TEXT NOT NULL CHECK \(action IN \(([^)]*)\)\)", FLAT_SCHEMA).group(1)
    assert set(re.findall(r"'(\w+)'", check)) == AUDIT_ACTIONS

def test_audit_routes_use_phase_1s_device_dependency():
    from api import device, individuals, categories
    assert individuals.get_device_id is device.get_device_id and categories.get_device_id is device.get_device_id
```

(`clean_device_id` is already tested in Phase 1's `test_rate_limit.py`.)

In `test_schema_sql.py`, add `test_audit_log_is_append_only` (both triggers, each with its `DROP TRIGGER IF EXISTS` first, and the function's `RAISE`) and `test_audit_log_has_no_foreign_key` (`REFERENCES` is absent from its body). `test_rls_enabled` covers `audit_log` through `TABLES`.

- [ ] **Step 2: Run them and check they fail** (`python -m pytest backend/tests/test_audit.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`).

- [ ] **Step 3: Implement** the migration, `schema.sql` fold and `audit.py`. `test_the_source_scan_finds_the_queries` needs `audit_log` among the source tables; `record_audit`'s `.table("audit_log").insert(...).execute()` provides it.

- [ ] **Step 4: Docs and manual step.** README "Data leaving the system": add a row saying `audit_log` keeps who (user id, device id) did what to which record id, when. No names or field values, and it is kept after a person is deleted. Manual-steps file: `3. 20261102000003_audit_log.sql. Check: delete from audit_log; fails with "audit_log is append-only".`

- [ ] **Step 5: Run the checks.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/ backend/ README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(db): append-only audit_log table and record_audit (H2-2.7)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Record the seven audited actions

**Files:**
- Modify: `backend/api/individuals.py` (save `:81-173`, profile `:218-254`, override `:257-292`, delete `:295-320`), `backend/api/categories.py` (export `:56-104`, create `:154-255`)
- Test: `backend/tests/test_individuals_routes.py`, `test_delete_individual.py`, `test_export_and_upsert.py`, `test_create_category.py`

**Interfaces:**
- Consumes: Task 9 (`record_audit`, `get_device_id`), Task 4 (`result.replayed`), Phase 1 (`run_db`, `get_supabase`, the rate-limit dependency that yields `user_id`).
- Produces: one audit row per successful action, written before the response. Nothing is written for a 4xx/5xx or for a replayed save.

| Route (on success) | action | entity_type | entity_id | detail |
|---|---|---|---|---|
| `GET /api/individuals/{id}` | `view_profile` | `individual` | id | `{}` |
| `GET /api/export` | `export_csv` | `export` | `None` | `{"rows": <individuals written>}` |
| `DELETE /api/individuals/{id}` | `delete_individual` | `individual` | id | `{}` |
| `PUT /api/individuals/{id}/urgency-override` | `override_urgency` | `individual` | id | `{"urgency_override": <int or null>}` |
| `POST /api/individuals` (merge, not replayed) | `merge_individual` | `individual` | id | `{"interaction_id": <id>}` |
| `POST /api/individuals` (new, not replayed) | `create_individual` | `individual` | id | `{"interaction_id": <id>}` |
| `POST /api/categories` | `create_category` | `category` | new id | `{"name": <category key>}` |

Every route takes `device_id: Optional[str] = Depends(get_device_id)`, imported with `from api.device import get_device_id` (Phase 1). `record_audit` swallows the strict fake's `AssertionError` by design, so a test that doesn't script `audit_log` still passes. **Every test below scripts `on("audit_log", "insert", data=lambda c: [c.payload])` and asserts the payload.**

- [ ] **Step 1: Write the failing tests**, one per row of the table: `test_<action>_is_audited_with_user_and_device`. Each sends `headers={"X-Device-Id": "device-1234"}` and asserts `sb.payloads("audit_log", "insert") == [{"user_id": "test-user-123", "device_id": "device-1234", "action": ..., "entity_type": ..., "entity_id": ..., "detail": ...}]`. Plus:
  - `test_a_404_profile_is_not_audited`, `test_a_404_delete_is_not_audited`, `test_a_409_merge_is_not_audited`, `test_a_replayed_save_is_not_audited` (each with `audit_log` scripted, asserting `payloads == []`);
  - `test_an_audit_failure_never_fails_the_request`: `on("audit_log", "insert", error=RuntimeError())`, and the profile is still 200;
  - `test_audit_detail_never_carries_names_or_field_values`: after a create and a merge of "Ann Lee", `"Ann"` doesn't appear in `json.dumps(sb.payloads("audit_log", "insert"))`.

- [ ] **Step 2: Run them and check they fail**

Run: `python -m pytest backend/tests/test_individuals_routes.py backend/tests/test_delete_individual.py backend/tests/test_export_and_upsert.py backend/tests/test_create_category.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement** the calls (`await run_db(lambda: record_audit(...))` in async routes).

- [ ] **Step 4: Run the full checks**, including `backend/tests/test_no_pii_logs.py`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(api): audit profile views, exports, deletes, overrides, saves and category creates (H2-2.7)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Migration 4, `number_scale_max` in the backend

**Files:**
- Create: `supabase/migrations/20261102000004_number_scale_max.sql`
- Modify: `supabase/schema.sql:24-39` (`categories`) and the upgrade section
- Modify: `backend/services/urgency_calculator.py:49-102`, `backend/db/models.py:143-187, 224-237`, `backend/api/categories.py:107-146, 195-209, 235-248`
- Test: `backend/tests/test_urgency_calculator.py`, `test_create_category.py`, `test_models.py`, `test_schema_sql.py`, `test_schema_contract.py`
- Modify: `CLAUDE.md` (Urgency rule), `README.md` ("Urgency score" paragraph; "Creating a category"), `backend/README.md`, manual-steps file

**Interfaces:**
- Produces:
  - Column `categories.number_scale_max NUMERIC` (nullable) with `CONSTRAINT categories_number_scale_max_positive CHECK (number_scale_max IS NULL OR number_scale_max > 0)`. The upgrade section adds it with `ADD COLUMN IF NOT EXISTS`, then `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT`.
  - `urgency_calculator.DEFAULT_NUMBER_SCALE_MAX = 300`.
  - The number term is `min(max(value, 0) / scale, 1) * weight`, where `scale = _as_number(category.get("number_scale_max"))` if that is > 0, else 300.
  - Auto-trigger is unchanged (a non-zero number fires).
  - `CreateCategoryRequest.number_scale_max: Optional[float] = Field(None, gt=0, le=1_000_000)`. Set on a type other than `number`, it is a 422 `number_scale_max is only allowed for number categories`.
  - `CategoryResponse.number_scale_max: Optional[float] = None`. `GET /api/categories` items include `number_scale_max`.

- [ ] **Step 1: Write the failing tests.**

```python
DAYS = {"name": "days", "type": "number", "urgency_weight": 50, "auto_trigger": False}

@pytest.mark.parametrize("scale,value,expected", [
    (10, 5, 50), (10, 20, 100), (None, 150, 50), (0, 150, 50), (-5, 150, 50), ("junk", 150, 50), ("10", 5, 50)])
def test_number_term_uses_its_scale_max(scale, value, expected):
    assert calculate_urgency_score({"days": value}, [{**DAYS, "number_scale_max": scale}]) == expected

def test_a_category_without_the_column_scores_as_before():
    assert calculate_urgency_score({"days": 150}, [DAYS]) == 50
```

- `test_create_category.py`:
  - a number category with `"number_scale_max": 10` inserts `number_scale_max == 10`, and the 201 body carries it;
  - an omitted value inserts `None`;
  - `0` and `-1` are 422;
  - a `single_select` with a scale is 422 with the message above;
  - `GET /api/categories` returns `number_scale_max`.
- `test_schema_sql.py`: the column, the named CHECK, and its idempotent re-add.
- `test_schema_contract.py`: the categories columns include `number_scale_max`. The category-insert contract test already checks written keys.

- [ ] **Step 2: Run them and check they fail** (`python -m pytest backend/tests/test_urgency_calculator.py backend/tests/test_create_category.py backend/tests/test_schema_sql.py -q`).

- [ ] **Step 3: Implement** the migration, the `schema.sql` fold and the code from the Interfaces block. Update the `calculate_urgency_score` docstring formula.

- [ ] **Step 4: Docs and manual step.**
  - CLAUDE.md Urgency rule: "Number → `min(value / (number_scale_max or 300), 1) * weight`".
  - README "Urgency score": the same formula, plus a note that the scale is set per number category ("Scale max"; blank means 300).
  - README "Creating a category": the Scale max box.
  - `backend/README.md`: the new field.
  - Manual-steps file: `4. 20261102000004_number_scale_max.sql. Check: select number_scale_max from categories; is null for every existing row (scores unchanged).`

- [ ] **Step 5: Run the checks.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/ backend/ CLAUDE.md README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(urgency): per-category number_scale_max, default 300 (H2-2.8)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: "Scale max" input on the Categories screen

**Files:**
- Modify: `mobile/utils/categoryPayload.ts:9-29` (`Category`, `CategoryForm`), `:104-136` (`validateCategoryForm`, `buildCategoryPayload`)
- Modify: `mobile/screens/CategoriesScreen.tsx:35-95` (state, form, reset), `:242-262` (the weighted block)
- Test: `mobile/utils/__tests__/categoryPayload.test.ts`, `mobile/screens/__tests__/CategoriesScreen.test.tsx`

**Interfaces:**
- Consumes: Task 11's API field `number_scale_max`.
- Produces:
  - `Category.number_scale_max?: number | null`; `CategoryForm.scaleMax?: string`.
  - `buildCategoryPayload` sends `number_scale_max: Number(scaleMax)` for a `number` type with a non-blank box, else `null`.
  - `validateCategoryForm`, for a number type with a non-blank box that isn't a finite number > 0, returns `'Scale max must be a number greater than 0'`.
  - The screen shows a `TextInput` with placeholder `"300"` and label `Scale max (optional)` only when the type is `number`. It resets with the form.

- [ ] **Step 1: Write the failing tests.**
  - `categoryPayload.test.ts`: `buildCategoryPayload({...numberForm, scaleMax: '10'}).number_scale_max === 10`; a blank box gives `null`; a single-select with `scaleMax: '10'` gives `null`; `validateCategoryForm` rejects `'0'`, `'-2'` and `'abc'` for number and accepts `''`.
  - `CategoriesScreen.test.tsx`:
    - `it('shows Scale max only for number categories and sends it')`: choose Number, type 10 into Scale max, add. `api.createCategory` was called with `expect.objectContaining({ number_scale_max: 10 })`.
    - `it('hides Scale max for single-select')`.
    - `it('blocks a scale max of 0 before calling the API')`.

- [ ] **Step 2: Run them and check they fail** (`cd mobile && npx jest utils/__tests__/categoryPayload.test.ts screens/__tests__/CategoriesScreen.test.tsx`).

- [ ] **Step 3: Implement** the Interfaces block. Reuse the `dangerWeightContainer` styles; no new design.

- [ ] **Step 4: Run** `cd mobile && npx tsc --noEmit && npx jest`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/
git commit -m "feat(mobile): optional Scale max for number categories (H2-2.8)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Migration 5, batched re-scoring after the response

**Files:**
- Create: `supabase/migrations/20261102000005_rescore_batch.sql`
- Modify: `supabase/schema.sql` (Functions section)
- Modify: `backend/services/individual_service.py:59-86` (`rescore_all_individuals`), `backend/api/categories.py:154-255` (`create_category`), `backend/scripts/rescore_urgency.py` (docstring: no row cap)
- Test: `backend/tests/test_rescore.py`, `test_schema_sql.py` (`test_rpc_functions_are_not_callable_with_the_anon_key` gains `rescore_batch`)
- Modify: `README.md` ("Upgrading"; "Creating a category"), `CLAUDE.md` (Urgency rule's re-score clause), manual-steps file

**Interfaces:**
- Consumes: Phase 1 `fetch_all(build, page_size=1000)`, Task 1 `on_rpc`, Task 3 `version`.
- Produces:
  - SQL `rescore_batch(p_rows jsonb) RETURNS int` (`plpgsql`, `SET search_path = ''`, `REVOKE`/`GRANT` as D7). It raises `22023` unless `jsonb_typeof(p_rows) = 'array'`. Then:
    ```sql
    UPDATE public.individuals i SET urgency_score = r.urgency_score
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, urgency_score int, version int)
    WHERE i.id = r.id AND i.version = r.version AND i.urgency_score IS DISTINCT FROM r.urgency_score;
    GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
    ```
    The `version` guard skips a row saved since the read. It never changes `version` or `urgency_override`.
  - `RESCORE_BATCH_SIZE = 500` in `services/individual_service.py`.
  - `def rescore_all_individuals(supabase: Client) -> int`:
    1. Read the individuals with `fetch_all(lambda: supabase.table("individuals").select("id, urgency_score, data, version").order("id"))`, and the categories with one read.
    2. Score each person as today, keeping only the rows whose score changed.
    3. Send them in chunks of 500: `supabase.rpc("rescore_batch", {"p_rows": [{"id": str, "urgency_score": int, "version": int}, ...]}).execute()`.
    4. Return the sum of the returned counts. Invalidate the context cache when that sum is > 0.
  - `api/categories.py: def rescore_in_background() -> None` gets `get_supabase()` and runs the re-score, logging a failure as `"Re-scoring after category create failed: %s", type(e).__name__`. `create_category` takes `background_tasks: BackgroundTasks` and, for a weighted or auto-trigger category, does `background_tasks.add_task(rescore_in_background)` instead of re-scoring inline.

- [ ] **Step 1: Write the failing tests** in `test_rescore.py`. The fixtures gain `"version": 1`. `_db()` scripts `on_rpc("rescore_batch", data=lambda c: len(c.payload["p_rows"]))`. The route patch target becomes Phase 1's `get_supabase` in `api.categories`. Add:

```python
def test_rescore_sends_only_changed_rows_through_rescore_batch():
    ...  # JAMES, ANA, SAM with the new number category
    assert rescore_all_individuals(sb) == 2
    assert sb.rpc_params("rescore_batch") == [{"p_rows": [
        {"id": "id-james", "urgency_score": 41, "version": 1}, {"id": "id-ana", "urgency_score": 41, "version": 1}]}]
    assert not sb.calls_to("individuals", "update")

def test_rescore_writes_in_batches_of_500():
    ...  # 1001 changed rows -> [len(p["p_rows"]) for p in sb.rpc_params("rescore_batch")] == [500, 500, 1]

def test_rescore_returns_what_the_database_updated():
    ...  # on_rpc data=1 for a batch of 2 (one saved meanwhile) -> returns 1

def test_rescore_sends_nothing_when_no_score_changed():
    ...  # no rpc calls; cache not invalidated

def test_rescore_never_sends_the_override():
    ...  # no p_rows item has a key other than id, urgency_score, version

async def test_create_category_answers_before_rescoring():
    from fastapi import BackgroundTasks
    import api.categories as cats
    tasks = BackgroundTasks()
    with patch.object(cats, "rescore_all_individuals") as rescore, patch.object(cats, "get_supabase", return_value=_db()):
        await cats.create_category(CreateCategoryRequest(**NEW_NUMBER), background_tasks=tasks, user_id="u")
    rescore.assert_not_called()
    assert [t.func for t in tasks.tasks] == [cats.rescore_in_background]
```

(Add the route's other dependencies, such as `device_id`, as keyword arguments, matching its final signature.) Keep `test_a_rescore_failure_still_returns_the_created_category` and the other route tests: `TestClient` runs background tasks before it returns. Also add `test_rescore_batch_function` to `test_schema_sql.py`: the signature, `i.version = r.version`, and that the body has no `version =` assignment.

- [ ] **Step 2: Run them and check they fail** (`python -m pytest backend/tests/test_rescore.py backend/tests/test_schema_sql.py -q`).

- [ ] **Step 3: Implement** the migration, the `schema.sql` fold and the Python from the Interfaces block. If the static chain scan in `test_schema_contract.py` can't see a `fetch_all(lambda: ...)` read, follow whatever pattern Phase 1 set for it.

- [ ] **Step 4: Docs and manual step.**
  - README: re-scoring now covers every row (no 1000-row cap), runs after the create is answered, and skips rows saved meanwhile.
  - CLAUDE.md: "Creating a weighted or auto-trigger category re-scores everyone in the background (`rescore_all_individuals`, batches of 500 via `rescore_batch`)".
  - Manual-steps file: `5. 20261102000005_rescore_batch.sql. Then: cd backend && python scripts/rescore_urgency.py.`

- [ ] **Step 5: Run the checks.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/ backend/ README.md CLAUDE.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "perf: re-score in batches of 500 through rescore_batch, after the category create returns (H2-2.9)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Migration 6, `pg_trgm` and the name trigram index

**Files:**
- Create: `supabase/migrations/20261102000006_name_trigram_index.sql`
- Modify: `supabase/schema.sql:182-196` (index section and its comment; the `pg_trgm` line goes at the top, before the tables)
- Test: `backend/tests/test_schema_sql.py`
- Modify: manual-steps file (Apply migrations; Owner actions)

**Interfaces:**
- Produces:
  - `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;` (D8).
  - `CREATE INDEX IF NOT EXISTS idx_individuals_name_trgm ON individuals USING gin (name extensions.gin_trgm_ops);`.
  - Phase 3's `find_duplicate_candidates` and Phase 4's search functions pin `SET search_path = public, extensions`, so `similarity(...)` and `%` resolve to the `extensions` copies.
  - The `client_request_id` lookup is served by `interactions_client_request_id_key` from Task 3; there is no second index.

- [ ] **Step 1: Write the failing tests.**
  - `test_pg_trgm_and_name_trigram_index`: both statements are in `FLAT`, and the extension comes before the index.
  - `test_client_request_id_has_no_redundant_index`: no `CREATE INDEX ... ON interactions ?\(client_request_id\)`.
  - `test_unused_indexes_dropped` keeps `idx_individuals_name` (the old b-tree); its comment changes to "replaced by the trigram index".

- [ ] **Step 2: Run them and check they fail.**

- [ ] **Step 3: Write the migration and fold it into `schema.sql`.** Update the index comment block: `idx_individuals_name_trgm` serves `ILIKE`/`%`/`similarity()` name lookups (duplicate candidates, Phase 3/4 search).

- [ ] **Step 4: Manual steps.** Apply migrations: `6. 20261102000006_name_trigram_index.sql.` Owner actions: `Check select extnamespace::regnamespace from pg_extension where extname = 'pg_trgm'; returns extensions. If it says public (installed earlier), run ALTER EXTENSION pg_trgm SET SCHEMA extensions; then re-run migration 6.`

- [ ] **Step 5: Run the checks.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/ backend/tests/test_schema_sql.py docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "perf(db): pg_trgm GIN index on individuals.name (H2-2.10)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Migration 7, `coarsen_old_locations`

**Files:**
- Create: `supabase/migrations/20261102000007_coarsen_old_locations.sql`
- Modify: `supabase/schema.sql` (Functions section, plus the commented `pg_cron` line)
- Test: `backend/tests/test_schema_sql.py` (also add `coarsen_old_locations` to `test_rpc_functions_are_not_callable_with_the_anon_key`)
- Modify: `README.md` ("Data leaving the system": the "Everything saved" row and a privacy note), manual-steps file (Apply migrations; Owner actions)

**Interfaces:**
- Consumes: Task 8's coarsening exemption (`voicereach.coarsening`).
- Produces: `coarsen_old_locations(p_days int DEFAULT 30) RETURNS int`, the number of interactions coarsened. `plpgsql`, `SET search_path = ''`, `REVOKE`/`GRANT` as D7. Body:

```sql
IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'p_days must be at least 1' USING ERRCODE = '22023';
END IF;
PERFORM set_config('voicereach.coarsening', 'on', true);      -- lets interactions_append_only pass (D2)
UPDATE public.interactions x
SET location = x.location
    || jsonb_build_object('latitude',  round((x.location->>'latitude')::numeric, 3),
                          'longitude', round((x.location->>'longitude')::numeric, 3),
                          'coarsened', true)
    || CASE WHEN jsonb_typeof(x.location->'address') = 'string'
            THEN jsonb_build_object('address',
                 regexp_replace(x.location->>'address', '^\s*\d+[A-Za-z]?(-\d+)?\s+', ''))
            ELSE '{}'::jsonb END                                -- D3: drop the house number
WHERE x.created_at < now() - make_interval(days => p_days)
  AND jsonb_typeof(x.location) = 'object'
  AND jsonb_typeof(x.location->'latitude') = 'number'
  AND jsonb_typeof(x.location->'longitude') = 'number'
  AND NOT (x.location ? 'coarsened')                           -- each point once
  AND x.id <> (SELECT y.id FROM public.interactions y           -- the person's newest visit keeps its exact point
               WHERE y.individual_id = x.individual_id
               ORDER BY y.created_at DESC, y.id DESC LIMIT 1);
GET DIAGNOSTICS v_count = ROW_COUNT;
PERFORM set_config('voicereach.coarsening', 'off', true);
RETURN v_count;
```

`individuals.last_location` is never touched. Below the function, a commented schedule (it stays a comment in both files):
`-- SELECT cron.schedule('coarsen-old-locations', '17 3 * * *', $$SELECT public.coarsen_old_locations(30)$$);`

- [ ] **Step 1: Write the failing tests** in `test_schema_sql.py`:

```python
def test_coarsen_signature_and_guard():
    fn = _function("coarsen_old_locations")
    assert re.search(r"coarsen_old_locations\(p_days int DEFAULT 30\) RETURNS int", fn)
    assert "p_days < 1" in fn and "ERRCODE = '22023'" in fn

def test_coarsen_rounds_to_three_decimals_and_strips_the_house_number():
    fn = _function("coarsen_old_locations")
    for axis in ("latitude", "longitude"):
        assert f"round((x.location->>'{axis}')::numeric, 3)" in fn
    assert "regexp_replace(x.location->>'address'" in fn and "'coarsened', true" in fn

def test_coarsen_skips_malformed_already_coarsened_and_newest_points():   # Review Focus 4
    fn = _function("coarsen_old_locations")
    assert "jsonb_typeof(x.location->'latitude') = 'number'" in fn
    assert "jsonb_typeof(x.location->'longitude') = 'number'" in fn
    assert "NOT (x.location ? 'coarsened')" in fn
    assert "ORDER BY y.created_at DESC, y.id DESC LIMIT 1" in fn

def test_coarsen_never_touches_last_location_and_uses_the_trigger_exemption():
    fn = _function("coarsen_old_locations")
    assert "public.individuals" not in fn and "last_location" not in fn
    assert fn.index("set_config('voicereach.coarsening', 'on', true)") < fn.index("UPDATE public.interactions")

def test_pg_cron_schedule_is_only_a_comment():
    assert "-- SELECT cron.schedule('coarsen-old-locations'" in RAW_SQL
    assert "cron.schedule" not in SQL
```

- [ ] **Step 2: Run them and check they fail.**

- [ ] **Step 3: Write the migration and fold it into `schema.sql`.** Add a comment block above the function saying why: about 110 m after 30 days; the newest visit and `last_location` stay exact for outreach.

- [ ] **Step 4: Docs and manual steps.**
  - README "Data leaving the system": the "Everything saved" row now says interaction locations older than 30 days are rounded to about 110 m with the house number removed, once the owner schedules `coarsen_old_locations`. The newest visit and the person's last location stay exact.
  - Manual-steps file, Apply migrations: `7. 20261102000007_coarsen_old_locations.sql. Check: select coarsen_old_locations(30); returns a count; a second run returns 0.`
  - Manual-steps file, Owner actions: `Enable pg_cron (Dashboard → Database → Extensions), then run the commented cron.schedule line from schema.sql once. Check: select jobname, schedule from cron.job; lists coarsen-old-locations.`

- [ ] **Step 5: Run all checks** (`python -m pytest -q`, `ruff check backend --select F,E9`, `cd mobile && npx tsc --noEmit && npx jest`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/ backend/tests/test_schema_sql.py README.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(privacy): coarsen_old_locations rounds visit locations older than 30 days (H2-2.11)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Interfaces produced for later phases

| Interface | Defined in | Used by |
|---|---|---|
| `FakeSupabase.on_rpc(name, data=None, error=None, times=None)`, `.rpc(name, params)`, `.rpc_params(name)`; unscripted rpc raises; params must be JSON-serialisable; rpc data returned unchanged | Task 1, `backend/tests/helpers.py` | P3 (`find_duplicate_candidates`), P4 (`search_individuals_hybrid`, `match_interactions`, `most_urgent_individuals`), P7 (`claim_recording_job`, `purge_old_recordings`). There is no `rpc_calls`. |
| `pg_error(code, message="database error") -> APIError` | Task 1 | Any test simulating a `RAISE ... USING ERRCODE` |
| `save_rpc(existing=None, *, new_id, interaction_id, at)` (fake `save_individual` result) | Task 4, helpers | P3 (`duplicate_decision` on save), P7 (drafts saved through the normal save) |
| `test_migrations.py` rules: name pattern `2026110[1-8]0000\d\d_*.sql`, idempotent guards, every object folded into `schema.sql` with identical function text, no demo inserts | Task 3 | Every migration in P3, P4, P7; P8's `db` CI job |
| `test_rpc_functions_are_not_callable_with_the_anon_key` parametrised list + D7 `REVOKE ... FROM PUBLIC, anon, authenticated` / `GRANT ... TO service_role` pattern; `SET search_path = ''` on every function | Task 3 | Every new SQL function |
| SQL `save_individual(p_individual_id uuid, p_name text, p_data jsonb, p_urgency_score int, p_interaction jsonb, p_expected_version int, p_client_request_id uuid) returns jsonb` → `{individual, interaction, replayed}`; `P0409` conflict, `P0002` missing | Task 3 | P7, P8 (`backend/tests/db/`) |
| `individuals.version` (bumped only by `save_individual`), `interactions.client_request_id UUID UNIQUE` | Task 3 | P4 (freshness may read `version`), P7 |
| `IndividualService.save_individual(..., expected_version: int | None = None, client_request_id: UUID | None = None) -> SaveIndividualResponse` (with `replayed`); `VersionConflictError`, `IndividualNotFound`, `VERSION_CONFLICT_DETAIL` | Task 4 | P3, P7 |
| `IndividualResponse.version`; `SaveIndividualRequest.expected_version`; header `Idempotency-Key` (UUID, else 400) | Task 4 | P6 (TanStack mutations), P7 |
| `REMOVED_KEY = "_removed"`; `changes` shape `{"field": null, "_removed": ["field"]}` | Task 7 | P4 (visit-level embedding text must skip `_removed`), P5 (`recent_interactions`) |
| `interactions_append_only` trigger + the `voicereach.coarsening` exemption | Task 8 | Anything that would UPDATE `interactions` (none may) |
| `audit_log` table; `services/audit.py: record_audit(supabase, *, user_id, device_id, action, entity_type, entity_id, detail=None) -> None`, `AUDIT_ACTIONS`, `AUDIT_ENTITY_TYPES` (a new action needs a migration that re-creates the CHECK) | Task 9 | P6 (export confirmation relies on `export_csv` being recorded), P7 |
| (no new device-id helper: every route uses Phase 1's `api/device.py: get_device_id`) | | P7 (`recordings.device_id`) |
| `categories.number_scale_max`; `DEFAULT_NUMBER_SCALE_MAX = 300` | Task 11 | P3 (`is_sensitive` follows the same column pattern) |
| SQL `rescore_batch(p_rows jsonb) returns int`; `RESCORE_BATCH_SIZE = 500`; `rescore_in_background()` | Task 13 | P3 (a sensitive-flag change re-scores the same way) |
| `pg_trgm` in schema `extensions`; `idx_individuals_name_trgm`; call `extensions.similarity` / `OPERATOR(extensions.%)` | Task 14 | P3 `find_duplicate_candidates`, P4 `search_individuals_hybrid` |
| SQL `coarsen_old_locations(p_days int DEFAULT 30) returns int` | Task 15 | P7 (the purge function follows its commented-`pg_cron` pattern) |
| Mobile `utils/requestId.ts: newRequestId()` (the one UUID helper), `utils/saveConflict.ts: isVersionConflict(e)`, `VERSION_CONFLICT_MESSAGE`; `api.saveIndividual({..., expected_version, idempotency_key})`; `authedFetch(..., { retryNetwork })`; `IndividualProfile.version`; `MergeUI.onMerge(data, id, expectedVersion?)` | Tasks 5, 6 | P6 (`getDeviceId` uses `newRequestId`; TanStack migration keeps the 409 path), P7 (`client_recording_id` = `newRequestId()`; a draft's `idempotency_key` = its recording id) |
