# Phase 4: Search and Retrieval Implementation Plan

> **For agentic workers:** Implement this plan task by task yourself, in order (no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move semantic search into Postgres (pgvector `halfvec(3072)` + HNSW), fuse vector, full-text and trigram ranks in one SQL function, embed visits as well as profiles, re-embed only stale rows, keep sensitive fields out of embedding text, and give the assistant (Phase 5) four read-only retrieval functions.

**Architecture:** Vectors live in `halfvec(3072)` columns with HNSW `halfvec_cosine_ops` indexes. `search_individuals_hybrid` does reciprocal rank fusion (k = 60) of three legs inside Postgres and pins an exact name match first; the backend only embeds the query (cached, 3+ characters) and calls the RPC. Freshness is a sha256 of the text that would be embedded now, compared with the stored `text_hash`. `services/retrieval.py` wraps the SQL functions into compact, clipped dicts that Phase 5 serialises as tool outputs.

**Tech Stack:** Python 3.11, FastAPI, supabase-py (PostgREST RPC), Postgres 15+ with pgvector ≥ 0.7.0 and pg_trgm, OpenAI `text-embedding-3-large`, Expo / React Native (Search screen), pytest, Jest.

**Spec:** `docs/superpowers/plans/2026-10-23-00-roadmap.md` (Phase 4; Global constraints; Phase 1-3 interfaces). Executors read the roadmap first, then this plan.

## Global Constraints

- Python 3.11: `python3.11 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt -r requirements-dev.txt`.
- Checks that must pass at the end of every task: `python -m pytest -q` (repo root, offline), `ruff check backend --select F,E9`, `cd mobile && npx tsc --noEmit && npx jest`.
- Tests are offline. No test may call OpenAI or Supabase. Backend tests use `backend/tests/helpers.py` fakes (`FakeSupabase` is strict: an unscripted query fails the test), including Phase 2's strict `rpc` scripting.
- CLAUDE.md rules still hold: no unauthenticated routes (only `/health` is open); never reintroduce `skin_color`; never call `supabase.from` in `mobile/`; all data goes through the backend; no PII in logs (`backend/tests/test_no_pii_logs.py`, `mobile/test/noDataLogs.test.ts`); database text reaches a model only as a delimited `user` item or a delimited tool output, never as a `system` message.
- When a phase changes a rule that CLAUDE.md or README states, the same task updates CLAUDE.md and README.
- Database changes: a new file in `supabase/migrations/` named `2026110400000S_<snake_name>.sql`; idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`); the same change folded into `supabase/schema.sql` (the full current schema for a fresh database); `test_schema_contract.py` and `test_schema_sql.py` keep passing and are extended; every migration gets a line in `docs/superpowers/plans/2026-10-23-manual-steps.md`.
- Code only: never apply anything to the hosted Supabase project or Railway.
- Git: branch `hardening-2`; one commit per task, conventional prefix, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; never commit `.env` files or keys; never push.
- Keep it simple: no new infrastructure services. Comments short and "why"; new audit codes `H2-4.<n>`.
- `EMBEDDING_MODEL` (Phase 1, `services/model_config.py`, default `text-embedding-3-large`) must produce 3072 dimensions; another size needs a migration of both `halfvec(3072)` columns.

## Verified pgvector and Postgres facts this plan relies on

Checked on 2026-10-23 against the pgvector README, `CHANGELOG.md`, `sql/vector.sql` and `src/halfvec.c` on `master`, and Postgres `pg_proc.dat` (REL_15):

- `halfvec` was added in pgvector **0.7.0** (CHANGELOG "Added `halfvec` type"). Supabase must report `extversion >= 0.7.0` (manual step).
- HNSW indexes `vector` up to 2,000 dimensions and **`halfvec` up to 4,000**, so 3072 needs `halfvec` (a `vector(3072)` HNSW index fails).
- `halfvec_cosine_ops` exists for `USING hnsw` (`sql/vector.sql`), serving `<=>`, which is **cosine distance** (similarity = `1 - distance`). Zero vectors are not indexed for cosine.
- There is no `jsonb -> halfvec` cast, but the text input accepts `[1,2,3]` and skips whitespace (`halfvec_isspace`), so `(embedding_data::text)::halfvec(3072)` converts a JSONB array (whose text is `[0.1, 0.2, ...]`). The `(3072)` typmod rejects any other length, so rows are filtered to `jsonb_array_length = 3072` first.
- `hnsw.ef_search` defaults to **40** and caps how many rows one HNSW scan returns. The vector leg asks for up to 150 rows (`LIMIT p_limit * 3`, `p_limit` at most 50), so each function sets `SET hnsw.ef_search = 100` in its definition (a function `SET` clause is scoped to the call, like `SET LOCAL`). An HNSW index serves only `ORDER BY embedding <=> $q LIMIT n` with **no second sort key**, so tie-breaks are applied in an outer query.
- `hnsw.iterative_scan` is 0.8.0+ only; it is **not** used (setting an unknown `hnsw.*` variable errors on 0.7).
- `jsonb_to_tsvector(regconfig, jsonb, jsonb)` is IMMUTABLE (the regconfig-less overload is STABLE), so it may appear in a generated column; with the filter `'["string"]'` it indexes string values only, never keys. `websearch_to_tsquery(regconfig, text)` is IMMUTABLE.
- On Supabase, `vector` and `pg_trgm` live in the `extensions` schema, so every new function pins `SET search_path = public, extensions`.
- PostgREST accepts a JSON array for a `halfvec` RPC argument or column value (it goes through the type's text input); it returns `halfvec` as a string, so Python never selects `embedding`.

## Consumed from earlier phases (exact names)

- Phase 1, `backend/db/client.py`: `async def run_db(fn: Callable[[], T]) -> T`; `def get_supabase() -> Client`; `def fetch_all(build: Callable[[], Any], page_size: int = 1000) -> list[dict]`. Modules import `get_supabase` by name, so tests patch `api.embeddings.get_supabase`, `api.individuals.get_supabase`, `services.retrieval.get_supabase`, `services.embedding_refresh.get_supabase`, `scripts.backfill_embeddings.get_supabase`.
- Phase 1, `backend/services/model_config.py`: `EMBEDDING_MODEL: str`.
- Phase 2: `supabase/migrations/`, `supabase/seed.sql`, `individuals.version int`, `pg_trgm` with a GIN trigram index on `individuals.name`, interactions UPDATE-blocked, `changes._removed`, and strict RPC scripting on `FakeSupabase`: `sb.on_rpc(name, data=..., error=..., times=...)`, `sb.rpc(name, params)`, `sb.rpc_params(name) -> list[dict]` (the params of each executed call) and `pg_error(code)`. An unscripted `rpc(...)` fails. Phase 2's `test_migrations.py` already checks every migration for `IF NOT EXISTS` / `CREATE OR REPLACE` and that its objects are folded into `schema.sql` with identical function text.
- Phase 3: `categories.is_sensitive boolean NOT NULL DEFAULT false` and `field_registry.sensitive_keys(categories: list[dict]) -> set[str]` (the `name` of every category with a truthy `is_sensitive`). Phases 3 and 4 run in parallel: if Phase 3's Task 1 hasn't landed when Task 2 runs, add `sensitive_keys` with exactly that signature and Phase 3 keeps it.
- Line numbers below are from `main` at `ce238db`; Phases 1-3 move them. Find code by the symbol named.

## Deviations from roadmap

1. **The column is `embedding_data`, not `embedding`** (`schema.sql:81`). The migration adds `embedding halfvec(3072)`, casts `embedding_data` into it, then drops `embedding_data`. Rows whose array isn't 3072 long can't be cast and were never searchable (C-34): they are deleted, and `--stale` re-creates them (a missing row is stale). `embedding` is then `NOT NULL`, so "no vector" always means "no row".
2. **`search_tsv` is on `individuals`, generated from the name plus the string values of `data`** (`jsonb_to_tsvector('simple', data, '["string"]')`), not on `individual_embeddings.embedding_text`. The embedding text carries labels ("Veteran Status: No"), so "veteran" would match everyone with that field: the C-01 bug that `test_embeddings_search_does_not_return_everyone_for_a_key_word` guards. After item 6 it also lacks sensitive values, so a text search for "diabetes" would stop finding people. And it would depend on a background OpenAI call having succeeded. The tsquery is `websearch_to_tsquery('simple', q)` OR'd with a prefix query of the query's alphanumeric tokens (`diab:*`), which keeps today's word-start rule ("diab" finds Diabetes; "male" doesn't find Female).
3. **`search_individuals_hybrid` gains `p_min_similarity double precision DEFAULT 0.15` and a `similarity` output column.** Without a floor, the vector leg always returns its nearest neighbours, so a nonsense query would list 20 people. 0.15 is today's `DEFAULT_SIMILARITY_THRESHOLD`. The roadmap's three-argument call still works. It also returns `version` (Phase 2).
4. **Staleness is decided by the hash, not by `source_updated_at`.** `individuals.updated_at` also moves on every urgency re-score and override, which don't change the text. A row is stale when it is missing, its `model` differs from `EMBEDDING_MODEL`, or its `text_hash` differs from the hash of the text built now. That last test also catches a category label change and an `is_sensitive` flip, so no trigger is needed to "mark" rows. `source_updated_at` is still written (the `individuals.updated_at` the text came from) as a record, not as a decision input.
5. **`generate-all` refreshes stale rows only** (the "same code path" as `--stale`). A full re-embed is `backfill_embeddings.py` without `--stale`.
6. **Batches close at 100 texts or 200,000 characters**, whichever comes first, because a batch of 100 long transcripts (Phase 1 caps them at 20,000 characters) could pass the embeddings endpoint's per-request token limit.
7. **`match_interactions` is used by `search_people`**: people found only through a matching visit are appended after the hybrid results (`match: "visit"`). The roadmap fixes four tool functions and none of them takes a visit query, so this is how visit chunks reach the assistant. It is a Python merge, not a fourth RRF leg.
8. **`most_urgent` calls a new SQL function, `most_urgent_individuals`** (the roadmap names no function). An unknown `near` raises `retrieval.UnknownAreaError` (a `ValueError`) instead of returning `[]`, which the assistant would read as "nobody urgent there".
9. **Search screen:** queries of 3+ characters wait for a 600 ms pause. Shorter ones keep 300 ms: the server does no semantic leg for them, so waiting longer buys nothing.

**Executor deviations (recorded while implementing):**

- Task 1: Phase 1's `test_embeddings_use_embedding_model` fake reply now carries `index` and a 3072-float vector (the dimension check moved into `generate_embeddings`). The background-task test patches `api.individuals.get_embedding_service`, and a new test checks the save passes `updated_at` to it.
- Task 4: `test_error_contract.py`'s broken-database fake now breaks `rpc()` as well as `table()`. `test_search_matching.py`'s `test_person_found_by_text_and_semantic_appears_once_as_text` was deleted with the other route tests (it drove the deleted Python merge). In `schema.sql` the `search_tsv` column is also added in the upgrade section (as the migration does), so re-running `schema.sql` on an older database adds it.

## Review Focus

1. **Query text that is SQL, LIKE or tsquery syntax** (`50%_`, `a & !b`, `"`, `O'Brien`, `:*`, emoji): it should be searched literally and never cause a 500. Task 4 adds a route test that sends these strings unchanged as `p_query`, plus static SQL checks for the ILIKE escape and the alphanumeric-only prefix tokens. Phase 8's db tests run them for real.
2. **An OpenAI outage or timeout while embedding the query:** the search should still return text and name results with 200, and log only the error type. Task 4 and Task 8 test this.
3. **The exactly-3-character boundary and padded input** (`"Al "`, `" ab "`, `"a b"`): the rule counts the normalised query. Task 3 tests it.
4. **A person with no interactions, no `last_location`, or a non-numeric latitude:** they should drop out of a `near` filter without an SQL cast error, and their `last_seen` should fall back to `created_at`. Task 7 adds the static `jsonb_typeof` guard check; Task 8 tests the fallback.
5. **A category flipped to sensitive after people were embedded:** the next refresh should re-embed those people without the field. Task 6 tests it; README says the old vector stays until a refresh runs.

---

### Task 1: halfvec storage with model, hash and source time

**Files:**
- Create: `supabase/migrations/20261104000001_pgvector_halfvec_embeddings.sql`
- Modify: `supabase/schema.sql:74-86` (the `individual_embeddings` table; add `CREATE EXTENSION` before the tables)
- Modify: `backend/services/embedding_service.py:20-79` (`EmbeddingService`, `store_individual_embedding`)
- Modify: `backend/api/embeddings.py:55-90` (`/generate`), `backend/api/individuals.py:57-79,149-159` (background task)
- Modify: `docs/superpowers/plans/2026-10-23-manual-steps.md`
- Test: `backend/tests/test_embedding_text.py`, `backend/tests/test_schema_sql.py`, `backend/tests/test_schema_contract.py:140-147`

**Interfaces:**
- Consumes: `run_db`, `get_supabase`, `EMBEDDING_MODEL`.
- Produces (in `services/embedding_service.py`):
  - `def embedding_text_hash(text: str) -> str`: `hashlib.sha256(text.encode("utf-8")).hexdigest()`, equal to Postgres `encode(sha256(convert_to(t, 'UTF8')), 'hex')`.
  - `def get_embedding_service() -> EmbeddingService`: one per process (Phase 1 added no embedding singleton; this is the first). `conftest._reset_process_state` resets it.
  - `async def EmbeddingService.generate_embeddings(self, texts: list[str]) -> list[list[float]]`: one `embeddings.create(model=self.model, input=texts)` call, results sorted by `item.index`. Raises `ValueError` if any vector isn't `self.dimensions` (3072) long.
  - `generate_embedding(text)` becomes `(await self.generate_embeddings([text]))[0]`.
  - `async def EmbeddingService.store_individual_embedding(self, supabase, individual: dict, categories: list[dict], *, force: bool = False) -> bool`: `individual` has `id`, `name`, `data`, `updated_at`. It builds the text and its hash and reads the existing row (`select("model, text_hash").eq("individual_id", id).limit(1)`). With `force=False`, a row whose `model == self.model` and whose `text_hash` matches is fresh: no OpenAI call, no write, returns `False`. Otherwise it embeds and upserts `{"individual_id", "embedding", "embedding_text", "model", "text_hash", "source_updated_at"}` with `on_conflict="individual_id"` and returns `True`. Every `.execute()` goes through `run_db`. `source_updated_at` is `individual["updated_at"]`, else the current UTC time in ISO format.

- [x] **Step 1: Write the failing tests**

In `test_embedding_text.py`, add `"updated_at": "2026-09-09T00:00:00+00:00"` to `PERSON`. Move the store tests (`test_stored_text_is_the_embedded_text`, `test_wrong_dimension_vector_is_not_stored`, `test_background_task_uses_categories`, `test_generate_route_uses_categories`) from `MagicMock`/`_Tables` onto `FakeSupabase`, scripting `on("individual_embeddings", "select", data=[])` plus an upsert that echoes. Then add:

```python
def test_embedding_text_hash_is_sha256_hex():
    assert embedding_text_hash("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

def test_store_writes_vector_model_hash_and_source_time():
    # FakeSupabase: existing-row select -> [], upsert echoes
    assert asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES)) is True
    row = sb.payloads("individual_embeddings", "upsert")[0]
    text = build_embedding_text(PERSON, CATEGORIES)
    assert set(row) == {"individual_id", "embedding", "embedding_text", "model", "text_hash", "source_updated_at"}
    assert (row["model"], row["text_hash"], row["source_updated_at"]) == (
        EMBEDDING_MODEL, embedding_text_hash(text), PERSON["updated_at"])
    assert len(row["embedding"]) == 3072 and "embedding_data" not in row

def test_store_skips_the_call_when_hash_and_model_match():
    # existing row {"model": EMBEDDING_MODEL, "text_hash": hash_of_current_text}
    assert asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES)) is False
    svc.client.embeddings.create.assert_not_awaited()
    assert sb.calls_to("individual_embeddings", "upsert") == []

def test_store_re_embeds_when_the_model_differs():      # existing model "text-embedding-ada-002" -> True, one upsert
def test_store_force_ignores_a_fresh_row():             # fresh row + force=True -> True, one upsert

def test_generate_embeddings_sends_one_array_call_in_input_order():
    # client.embeddings.create returns data=[{index: 1, embedding: B}, {index: 0, embedding: A}]
    assert asyncio.run(svc.generate_embeddings(["t0", "t1"])) == [A, B]
    svc.client.embeddings.create.assert_awaited_once_with(model=EMBEDDING_MODEL, input=["t0", "t1"])

def test_generate_embeddings_rejects_a_wrong_dimension_vector():   # one 1536-long vector -> ValueError
```

Build these tests' `svc` with `EmbeddingService.__new__` and `svc.client = MagicMock(embeddings=MagicMock(create=AsyncMock(...)))`, so `generate_embeddings` really runs. `test_background_task_uses_categories` also asserts that the payload passed to `generate_embedding_background` carries `updated_at`.

In `test_schema_sql.py` add:

```python
MIGRATIONS = SCHEMA.parent / "migrations"

def test_vector_extension_and_halfvec_column():
    assert "CREATE EXTENSION IF NOT EXISTS vector" in FLAT
    assert "halfvec(3072) NOT NULL" in _column_def("individual_embeddings", "embedding")
    assert "embedding_data" not in SQL

@pytest.mark.parametrize("column,type_", [("model", "TEXT NOT NULL"), ("text_hash", "TEXT NOT NULL"),
                                          ("source_updated_at", "TIMESTAMPTZ NOT NULL")])
def test_individual_embeddings_freshness_columns(column, type_):
    assert _column_def("individual_embeddings", column).startswith(type_)

def test_individual_embeddings_hnsw_index():
    assert re.search(r"CREATE INDEX IF NOT EXISTS \w+ ON individual_embeddings "
                     r"USING hnsw \(embedding halfvec_cosine_ops\)", FLAT)

def test_halfvec_migration_casts_json_text_and_drops_jsonb():
    m = _norm((MIGRATIONS / "20261104000001_pgvector_halfvec_embeddings.sql").read_text())
    assert "(embedding_data::text)::halfvec(3072)" in m
    assert "jsonb_array_length(embedding_data) <> 3072" in m
    assert "DROP COLUMN embedding_data" in m
    assert "encode(sha256(convert_to(embedding_text, 'UTF8')), 'hex')" in m
    assert "USING hnsw (embedding halfvec_cosine_ops)" in m
```

Phase 2's `test_migrations.py` covers idempotency and the `schema.sql` fold for this file; don't add a second check.

`test_schema_contract.py::test_embedding_upsert_uses_existing_columns` scripts `on("individual_embeddings", "select", data=[])` before the upsert. Phase 1's `test_event_loop.py::test_background_embedding_reads_and_upserts_off_the_loop` also scripts that select and expects `["select", "select", "upsert"]` (categories, existing row, upsert).

- [x] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest backend/tests/test_embedding_text.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`
Expected: FAIL (`embedding_text_hash` is not defined, there is no `embedding` column, the migration file is missing).

- [x] **Step 3: Write the migration** (exact SQL; the order matters)

```sql
-- H2-4.1: embeddings move from a JSONB array to pgvector halfvec(3072) with an HNSW index
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS embedding halfvec(3072);
ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS text_hash TEXT;
ALTER TABLE individual_embeddings ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'individual_embeddings'
               AND column_name = 'embedding_data') THEN
    -- Another size can't be cast and was never searchable (C-34); --stale re-creates it
    DELETE FROM individual_embeddings
     WHERE CASE WHEN jsonb_typeof(embedding_data) = 'array'
                THEN jsonb_array_length(embedding_data) <> 3072 ELSE TRUE END;
    UPDATE individual_embeddings SET embedding = (embedding_data::text)::halfvec(3072)
     WHERE embedding IS NULL;
    ALTER TABLE individual_embeddings DROP COLUMN embedding_data;
  END IF;
END $$;

DELETE FROM individual_embeddings WHERE embedding IS NULL;
-- Old rows were all text-embedding-3-large; hashing the stored text means an unchanged
-- person isn't re-embedded by --stale
UPDATE individual_embeddings SET
    model             = COALESCE(model, 'text-embedding-3-large'),
    text_hash         = COALESCE(text_hash, encode(sha256(convert_to(embedding_text, 'UTF8')), 'hex')),
    source_updated_at = COALESCE(source_updated_at, updated_at)
WHERE model IS NULL OR text_hash IS NULL OR source_updated_at IS NULL;

ALTER TABLE individual_embeddings
    ALTER COLUMN embedding         SET NOT NULL,
    ALTER COLUMN model             SET NOT NULL,
    ALTER COLUMN text_hash         SET NOT NULL,
    ALTER COLUMN source_updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_individual_embeddings_hnsw
    ON individual_embeddings USING hnsw (embedding halfvec_cosine_ops);

NOTIFY pgrst, 'reload schema';
```

- [x] **Step 4: Fold the change into `schema.sql`**

Put `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;` before the first table. Rewrite the `individual_embeddings` table as `id`, `individual_id` (unchanged), `embedding halfvec(3072) NOT NULL`, `embedding_text TEXT NOT NULL`, `model TEXT NOT NULL`, `text_hash TEXT NOT NULL -- sha256 hex of embedding_text`, `source_updated_at TIMESTAMPTZ NOT NULL -- individuals.updated_at the text was built from`, then the timestamps and `UNIQUE (individual_id)`. Replace the "JSON array / pgvector would be the right home" comment, and add the HNSW index next to `idx_interactions_latest`. `schema.sql` is for a fresh database; an existing one upgrades through the migration.

- [x] **Step 5: Implement the `embedding_service.py` interfaces above**

Then update the callers. `/generate` calls `store_individual_embedding(..., force=True)` and still returns `"embedding_dimensions": svc.dimensions`. The background task's `individual_data` gains `"updated_at": result.individual.updated_at.isoformat()`. The search route's Python cosine leg keeps reading `embedding_data`: against the new schema it finds none and falls back to text matches only, until Task 4 replaces it.

- [x] **Step 6: Append to the manual-steps file**

Under **Apply migrations** (the file Phase 1 created): `20261104000001_pgvector_halfvec_embeddings.sql`. Before it, check the version with `select extversion from pg_extension where extname = 'vector';` and expect `0.7.0` or later. If no row comes back, the migration installs it; if it's older than 0.7.0, run `ALTER EXTENSION vector UPDATE;` first.

- [x] **Step 7: Run the tests, then the global checks**

Run: `python -m pytest backend/tests/test_embedding_text.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`, then the three global checks.
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add supabase/migrations/20261104000001_pgvector_halfvec_embeddings.sql supabase/schema.sql backend/services/embedding_service.py backend/api/embeddings.py backend/api/individuals.py backend/tests docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(db): store embeddings as halfvec(3072) with an HNSW index and a text hash (H2-4.1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Sensitive fields out of the embedding text

**Files:**
- Modify: `backend/services/field_registry.py:292-320` (`build_embedding_text`)
- Modify: `README.md` (the "Data leaving the system" embeddings row, around line 526), `docs/EMBEDDINGS.md` ("Text representation"), `CLAUDE.md` (the Categories rule)
- Test: `backend/tests/test_embedding_text.py`

**Interfaces:**
- Consumes: `categories.is_sensitive` (Phase 3).
- Produces: `build_embedding_text(individual, categories)` leaves out the value of every category with a truthy `is_sensitive`. A sensitive key is also left out of the "uncategorised keys" loop (add it to `used`). If Phase 3 didn't add a helper, add `def sensitive_keys(categories: list) -> set[str]` (the `name` of each category with a truthy `is_sensitive`).

- [x] **Step 1: Write the failing tests**

```python
SENSITIVE = [dict(c, is_sensitive=True) if c["name"] in ("hiv_status", "medical_conditions") else c
             for c in CATEGORIES]

def test_embedding_text_leaves_out_sensitive_fields():
    text = build_embedding_text(PERSON, SENSITIVE)
    assert "HIV status" not in text and "Negative" not in text
    assert "Diabetes" not in text and "Medical Conditions" not in text
    assert "Housing Priority: High" in text          # non-sensitive fields stay

def test_marking_a_category_sensitive_changes_the_hash():
    assert embedding_text_hash(build_embedding_text(PERSON, CATEGORIES)) != \
           embedding_text_hash(build_embedding_text(PERSON, SENSITIVE))
```

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_embedding_text.py -q -k sensitive`
Expected: FAIL ("HIV status" is still in the text).

- [x] **Step 3: Implement it in `build_embedding_text`**

Update its docstring. In docs: the README embeddings row says sensitive fields are never sent for embedding; EMBEDDINGS.md says the same; CLAUDE.md's Categories rule adds "`is_sensitive` fields never enter embedding text".

- [x] **Step 4: Run the tests, then the global checks.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add backend/services/field_registry.py backend/tests/test_embedding_text.py README.md docs/EMBEDDINGS.md CLAUDE.md
git commit -m "feat(privacy): keep sensitive fields out of embedding text (H2-4.6)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Query-embedding cache and the 3-character minimum

**Files:**
- Modify: `backend/services/embedding_service.py`
- Modify: `backend/tests/conftest.py` (reset the cache; block real query embeddings), `pytest.ini` (marker)
- Test: Create `backend/tests/test_query_embedding_cache.py`

**Interfaces:**
- Produces (in `services/embedding_service.py`):
  - `QUERY_CACHE_SIZE = 256`, `QUERY_CACHE_TTL_S = 600`, `SEMANTIC_MIN_CHARS = 3`.
  - `def normalize_query(query: str) -> str`: casefold, runs of whitespace collapsed to one space, stripped.
  - `async def EmbeddingService.embed_query(self, query: str) -> list[float] | None`: returns `None` without any call when the normalised query is shorter than `SEMANTIC_MIN_CHARS`. Otherwise it returns the cached vector for the normalised query, or embeds the **normalised** text with `generate_embeddings([q])[0]`. The cache is process-level (a module `OrderedDict` of `q -> (stored_at, vector)`): least recently used out first, 256 entries, entries older than 600 s ignored and replaced. Failures raise and are never cached. The clock is a module-level `_now = time.monotonic`, so tests can patch it.
  - `def clear_query_cache() -> None`.
- The cache holds query text in memory only; it is never logged.

- [x] **Step 1: Write the failing tests** (marked `@pytest.mark.real_query_embedding`; `svc.generate_embeddings = AsyncMock(side_effect=lambda texts: [[0.1] * 3072 for _ in texts])`)

```python
def test_same_normalised_query_embeds_once():
    run(svc.embed_query("Veteran  near Market ")); run(svc.embed_query("veteran near market"))
    svc.generate_embeddings.assert_awaited_once_with(["veteran near market"])

@pytest.mark.parametrize("query,embedded", [("ab", False), ("  ab  ", False), ("a b", True), ("Al ", False), ("abc", True)])
def test_semantic_leg_needs_three_characters(query, embedded):
    assert (run(svc.embed_query(query)) is not None) is embedded
    assert svc.generate_embeddings.await_count == (1 if embedded else 0)

def test_entries_expire_after_ten_minutes(monkeypatch):
    # _now -> 0, embed; -> 599, cached (1 call); -> 601, embeds again (2 calls)

def test_cache_keeps_the_256_most_recently_used():
    # embed q0..q255; touch q0; embed q256 -> q1 evicted (re-embeds), q0 still cached

def test_failures_are_not_cached():
    # first generate_embeddings raises RuntimeError, second returns -> two awaits, second returns the vector
```

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_query_embedding_cache.py -q`
Expected: FAIL (`embed_query` and the marker don't exist).

- [x] **Step 3: Implement the interfaces above; register the marker; update conftest**

`pytest.ini` gets the marker `real_query_embedding: run the real EmbeddingService.embed_query (OpenAI must be mocked)`. In `conftest.py`, `_reset_process_state.reset()` also calls `clear_query_cache()`. A new autouse fixture `_no_query_embeddings` patches `EmbeddingService.embed_query` to raise `RuntimeError("query embedding disabled in tests")` unless the test is marked `real_query_embedding`. So no test can reach OpenAI, and by default every search is text-only.

- [x] **Step 4: Run the tests, then the global checks.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add backend/services/embedding_service.py backend/tests/conftest.py backend/tests/test_query_embedding_cache.py pytest.ini
git commit -m "feat(search): cache query embeddings (256 entries, 10 min) and skip queries under 3 characters (H2-4.5)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Hybrid search in SQL (`search_individuals_hybrid`)

**Files:**
- Create: `supabase/migrations/20261104000002_hybrid_search.sql`
- Modify: `supabase/schema.sql` (the `individuals` table, indexes, the function, its grants)
- Modify: `backend/api/embeddings.py:18-24,93-194` (the search route; remove `TEXT_MATCH` and `TIER_OF`)
- Modify: `backend/services/embedding_service.py:81-152` (delete `search_similar_individuals` and `semantic_search`, and the numpy/sklearn imports)
- Modify: `requirements.txt` (drop `numpy` and `scikit-learn` if `git grep -nE "numpy|sklearn" backend` finds no other use)
- Modify: `README.md` (Search section ~494-513, endpoints table row for `/api/embeddings/search`, "Search is demo-scale" limitation ~633-639), `docs/EMBEDDINGS.md` (Overview, Architecture, Search, Performance), `CLAUDE.md` (a new Search rule), `backend/README.md:279`, `docs/ARCHITECTURE.md:96-102`
- Test: rewrite `backend/tests/test_embeddings.py`. Delete the three `/api/embeddings/search` tests in `test_search_matching.py:148-186,209-216` (their behaviour moved into SQL and is pinned below). Update `test_list_individuals.py:84-114`, `test_no_pii_logs.py:182-191`, `test_request_limits.py:108-121`, `test_rate_limit.py:51-58` and `test_embedding_text.py::test_search_skips_vectors_of_another_dimension` (delete: no Python comparison is left). Extend `test_schema_sql.py` and `test_schema_contract.py`.

**Interfaces:**
- Consumes: `embed_query`, `get_embedding_service`, `run_db`, `fetch_last_seen`, `FakeSupabase.on_rpc`.
- Produces:
  - The SQL function `search_individuals_hybrid(p_query text, p_query_embedding halfvec(3072), p_limit int DEFAULT 20, p_min_similarity double precision DEFAULT 0.15) RETURNS TABLE (id uuid, name text, data jsonb, urgency_score int, urgency_override int, last_location jsonb, version int, created_at timestamptz, updated_at timestamptz, score double precision, match_source text, similarity double precision)`. `match_source` is one of `'exact' | 'name' | 'text' | 'semantic'`.
  - `individuals.search_tsv` and its GIN index.
  - `POST /api/embeddings/search` result rows: `{id, name, urgency_score, urgency_override, display_score, last_seen, abbreviated_address, data, search_type, similarity_score, score}`. Here `search_type` maps `match_source` as exact→`"exact"`, name→`"name"`, text→`"value"`, semantic→`"semantic"`; `similarity_score` is `1.0` for exact, else the row's `similarity` (may be `None`). The top level is `{results, query, total_results, normal_results, semantic_results, similarity_threshold, semantic_used}`, where `normal_results` counts `search_type != "semantic"`.

- [x] **Step 1: Write the failing route tests** (`test_embeddings.py`; patch `api.embeddings.get_supabase` with a `FakeSupabase`; interactions select scripted to `[]` unless stated)

```python
VEC = [0.01] * 3072

def test_search_calls_the_hybrid_rpc_with_the_query_embedding(monkeypatch):
    monkeypatch.setattr(EmbeddingService, "embed_query", AsyncMock(return_value=VEC))
    sb.on_rpc("search_individuals_hybrid", data=[])
    body = post({"query": "veteran near market"})
    assert sb.rpc_params("search_individuals_hybrid") == [{"p_query": "veteran near market",
        "p_query_embedding": VEC, "p_limit": 10, "p_min_similarity": 0.15}]
    assert body["semantic_used"] is True

def test_embedding_failure_falls_back_to_text_only():   # default conftest: embed_query raises
    # -> 200, p_query_embedding is None, semantic_used False

@pytest.mark.real_query_embedding
def test_short_query_is_text_only_without_an_openai_call():
    # "ab" -> p_query_embedding None; EmbeddingService.generate_embeddings not awaited

def test_blank_query_returns_nothing_without_a_database_call():
    # {"query": "   "} -> results == [] and sb.calls == [] and no rpc

@pytest.mark.parametrize("q", ["50%_", "a & !b", '"quoted', "O'Brien", "diab:*", "🙂 ann"])
def test_query_text_reaches_sql_unchanged(q):           # Review Focus 1
    assert sb.rpc_params("search_individuals_hybrid")[0]["p_query"] == q.strip()

def test_results_keep_sql_order_and_map_match_source():
    # rpc rows: exact Ann (similarity None), name Annie, text Bob, semantic Cy (similarity 0.42)
    assert [(r["name"], r["search_type"], r["similarity_score"]) for r in results] == [
        ("Ann", "exact", 1.0), ("Annie", "name", None), ("Bob", "value", None), ("Cy", "semantic", 0.42)]
    assert results[0]["score"] == ROWS[0]["score"]

def test_search_database_error_is_500():                # rpc error=RuntimeError -> 500 (C-17)
```

In `test_list_individuals.py`, the search test scripts the rpc instead of `FakeListDB`, and `test_one_default_similarity_threshold` drops the `inspect` loop over the deleted methods. In `test_no_pii_logs.py`, `test_semantic_search_logs_no_query_or_names` patches `embed_query` to raise `RuntimeError(f"bad query {SENTINEL_NAME}")`, scripts the rpc to return `PERSON`, and still asserts a non-empty result and a clean log. `test_request_limits.py` and `test_rate_limit.py` script `on_rpc("search_individuals_hybrid", data=[])`, and so does Phase 1's `test_event_loop.py` `OFF_LOOP_ROUTES` row for `/api/embeddings/search` (replacing its `individual_embeddings` select).

Static SQL tests (`test_schema_sql.py`):

```python
def _function_sql(text: str, name: str) -> str:
    """Normalised CREATE OR REPLACE FUNCTION <name>(...) ... $$; block."""

PHASE4_FUNCTIONS = {"search_individuals_hybrid": "20261104000002_hybrid_search.sql"}  # Tasks 5 and 7 add theirs

@pytest.mark.parametrize("name,migration", PHASE4_FUNCTIONS.items())
def test_phase4_functions_match_their_migrations(name, migration):
    assert _function_sql(SQL, name) == _function_sql(re.sub(r"--[^\n]*", "", (MIGRATIONS / migration).read_text()), name)

@pytest.mark.parametrize("name", PHASE4_FUNCTIONS)
def test_phase4_functions_are_backend_only(name):
    assert re.search(rf"REVOKE EXECUTE ON FUNCTION {name}\([^)]*\) FROM PUBLIC, anon, authenticated;", FLAT)
    assert re.search(rf"GRANT EXECUTE ON FUNCTION {name}\([^)]*\) TO service_role;", FLAT)

def test_hybrid_search_signature_and_settings():
    fn = _function_sql(SQL, "search_individuals_hybrid")
    assert ("search_individuals_hybrid( p_query text, p_query_embedding halfvec(3072), "
            "p_limit int DEFAULT 20, p_min_similarity double precision DEFAULT 0.15 )") in fn
    assert "SET search_path = public, extensions" in fn and "SET hnsw.ef_search = 100" in fn

def test_hybrid_search_fuses_with_rrf_k60_and_pins_exact_names_first():
    fn = _function_sql(SQL, "search_individuals_hybrid")
    assert "sum(1.0 / (60 + rnk))" in fn
    assert "ORDER BY (i.name ILIKE p.esc) DESC, f.score DESC, i.updated_at DESC, i.id" in fn

def test_hybrid_search_legs():
    fn = _function_sql(SQL, "search_individuals_hybrid")
    assert "websearch_to_tsquery('simple', q)" in fn and "|| ':*'" in fn and "'[^[:alnum:]]+'" in fn
    assert "similarity(i.name, p.q)" in fn and "i.name % p.q" in fn
    assert r"replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')" in fn
    # the HNSW index can serve only ORDER BY <distance> LIMIT, with no second key
    assert "ORDER BY e.embedding <=> p_query_embedding LIMIT" in fn

def test_search_tsv_indexes_name_and_string_values_never_keys():
    col = _column_def("individuals", "search_tsv")
    assert "GENERATED ALWAYS AS" in col and """'["string"]'::jsonb""" in FLAT
    assert re.search(r"CREATE INDEX IF NOT EXISTS \w+ ON individuals USING gin \(search_tsv\)", FLAT)
```

In `test_schema_contract.py`, `test_schema_parser_sees_every_table_and_column` adds `"search_tsv"` (and Phase 2's `"version"`) to the `individuals` set.

- [x] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_embeddings.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`
Expected: FAIL (no rpc call, no function in `schema.sql`).

- [x] **Step 3: Write the migration** (the same text goes into `schema.sql`, with the column inside `CREATE TABLE individuals`. Write its first line as `search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(name, ''))`, so `_column_def` sees `GENERATED ALWAYS AS`, and start the continuation line with `||`, so the contract parser doesn't read it as a column)

```sql
-- H2-4.2: full-text over the name and data VALUES (never keys, C-01), always current
ALTER TABLE individuals ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(name, ''))
        || jsonb_to_tsvector('simple'::regconfig, coalesce(data, '{}'::jsonb), '["string"]'::jsonb)) STORED;
CREATE INDEX IF NOT EXISTS idx_individuals_search_tsv ON individuals USING gin (search_tsv);

CREATE OR REPLACE FUNCTION search_individuals_hybrid(
    p_query text, p_query_embedding halfvec(3072),
    p_limit int DEFAULT 20, p_min_similarity double precision DEFAULT 0.15
)
RETURNS TABLE (id uuid, name text, data jsonb, urgency_score int, urgency_override int,
               last_location jsonb, version int, created_at timestamptz, updated_at timestamptz,
               score double precision, match_source text, similarity double precision)
LANGUAGE sql STABLE
SET search_path = public, extensions
SET hnsw.ef_search = 100
AS $$
WITH raw AS (
    SELECT btrim(coalesce(p_query, '')) AS q, least(greatest(coalesce(p_limit, 20), 1), 50) AS lim
), p AS (
    SELECT q, lim, lim * 3 AS k,
           -- the query is literal text: LIKE wildcards are escaped
           replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') AS esc,
           -- whole words (websearch) OR word prefixes ("diab" finds Diabetes, "male" not Female)
           CASE WHEN pre.tsq IS NULL THEN websearch_to_tsquery('simple', q)
                ELSE websearch_to_tsquery('simple', q) || pre.tsq END AS tsq
    FROM raw, LATERAL (
        SELECT to_tsquery('simple', string_agg(tok || ':*', ' & ')) AS tsq
        FROM regexp_split_to_table(lower(raw.q), '[^[:alnum:]]+') AS tok WHERE tok <> ''
    ) pre
), name_leg AS (
    SELECT i.id, row_number() OVER (ORDER BY (i.name ILIKE '%' || p.esc || '%') DESC,
                                             similarity(i.name, p.q) DESC, i.id) AS rnk
    FROM individuals i, p
    WHERE p.q <> '' AND (i.name ILIKE '%' || p.esc || '%' OR i.name % p.q)
    ORDER BY rnk LIMIT (SELECT k FROM p)
), text_leg AS (
    SELECT i.id, row_number() OVER (ORDER BY ts_rank_cd(i.search_tsv, p.tsq) DESC, i.id) AS rnk
    FROM individuals i, p
    WHERE p.q <> '' AND i.search_tsv @@ p.tsq
    ORDER BY rnk LIMIT (SELECT k FROM p)
), vector_nn AS (
    SELECT e.individual_id AS id, e.embedding <=> p_query_embedding AS dist
    FROM individual_embeddings e
    WHERE p_query_embedding IS NOT NULL AND (SELECT q FROM p) <> ''
    ORDER BY e.embedding <=> p_query_embedding LIMIT (SELECT k FROM p)
), vector_leg AS (
    SELECT id, 1 - dist AS sim, row_number() OVER (ORDER BY dist, id) AS rnk
    FROM vector_nn WHERE 1 - dist >= coalesce(p_min_similarity, 0.15)
), legs AS (
    SELECT id, rnk, 1 AS leg, NULL::double precision AS sim FROM name_leg
    UNION ALL SELECT id, rnk, 2, NULL FROM text_leg
    UNION ALL SELECT id, rnk, 3, sim FROM vector_leg
), fused AS (
    SELECT id, sum(1.0 / (60 + rnk))::double precision AS score,
           (array_agg(leg ORDER BY rnk, leg))[1] AS best_leg, max(sim) AS similarity
    FROM legs GROUP BY id
)
SELECT i.id, i.name, i.data, i.urgency_score, i.urgency_override, i.last_location, i.version,
       i.created_at, i.updated_at, f.score,
       CASE WHEN i.name ILIKE p.esc THEN 'exact' ELSE (ARRAY['name', 'text', 'semantic'])[f.best_leg] END,
       f.similarity
FROM fused f JOIN individuals i ON i.id = f.id CROSS JOIN p
ORDER BY (i.name ILIKE p.esc) DESC, f.score DESC, i.updated_at DESC, i.id
LIMIT (SELECT lim FROM p);
$$;

REVOKE EXECUTE ON FUNCTION search_individuals_hybrid(text, halfvec, int, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION search_individuals_hybrid(text, halfvec, int, double precision) TO service_role;
NOTIFY pgrst, 'reload schema';
```

How the function behaves (put this as its header comment):
- **Legs:** each leg returns at most `3 × limit` candidates, ranked from 1 and tie-broken by id. The legs are:
  - name: an ILIKE substring match or a trigram match at pg_trgm's default 0.3, with substring matches before fuzzy ones, then by `similarity` descending;
  - text: `search_tsv @@ tsq`, by `ts_rank_cd` descending;
  - vector: nearest by cosine distance, keeping only rows with similarity ≥ `p_min_similarity`.
- **Fusion:** `score = Σ 1/(60 + rank)` over the legs a person appears in.
- **Exact names:** a case-insensitive exact name match (ILIKE on the escaped query, which is equality) sorts first whatever its score.
- **Ties:** `score` desc, then `updated_at` desc, then `id`. `match_source` is `'exact'`, else the leg where the person ranked best (a tie goes to name, then text, then semantic). `similarity` is the cosine similarity when the vector leg had the person, else NULL.
- **No embedding:** a NULL embedding (the text-only fallback) empties the vector leg, and the other two fuse alone. A blank query returns no rows.

- [x] **Step 4: Rewrite the route**

For a blank `query.strip()`, return the empty response with no database call. Otherwise:
1. `vec = await get_embedding_service().embed_query(q)` inside `try`; any exception logs `"Query embedding failed: %s", type(e).__name__` and sets `vec = None`.
2. `rows = (await run_db(lambda: supabase.rpc("search_individuals_hybrid", {...}).execute())).data or []`, passing `p_limit=request.top_k` and `p_min_similarity=request.similarity_threshold`.
3. `last_seen` and `abbreviated_address` come from one `fetch_last_seen` (via `run_db`) exactly as today.
4. Keep the SQL order; build the response shape above.

`SearchRequest` is unchanged. Delete the Python cosine methods and imports.

- [x] **Step 5: Docs**

README's Search section describes the three legs, RRF k = 60, exact name first, values never keys, no semantic leg under 3 characters, and the query cache. It drops "vectors are JSONB, not pgvector" and the demo-scale wording for search; the list search (`GET /api/individuals`) is unchanged, so its own demo-scale note stays. The endpoints row reads "Hybrid search in Postgres (`search_individuals_hybrid`): exact name first, then fused name/full-text/semantic rank". EMBEDDINGS.md rewrites Architecture, How it works § 1 and Performance to match, and drops the numpy/scikit-learn setup line. CLAUDE.md gains under "Rules the code enforces":

> **Search** (`search_individuals_hybrid`): reciprocal rank fusion (k = 60) of trigram name, full-text (values, never keys) and pgvector cosine legs; an exact name match is always first; no semantic leg under 3 characters.

`backend/README.md:279` and the `docs/ARCHITECTURE.md` table snippet list the new `individual_embeddings` columns.

- [x] **Step 6: Append to manual steps**

Under **Apply migrations**: `20261104000002_hybrid_search.sql` (it adds a generated column, which rewrites `individuals` once). Add a smoke check after it: `select name, match_source from search_individuals_hybrid('John Doe', null, 5);` should return John Doe first with `match_source = 'exact'`.

- [x] **Step 7: Run the tests, then the global checks.** Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add supabase backend requirements.txt README.md docs/EMBEDDINGS.md docs/ARCHITECTURE.md CLAUDE.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(search): hybrid search in Postgres with reciprocal rank fusion, exact name first (H2-4.2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Visit-level chunks (`interaction_embeddings`, `match_interactions`)

**Files:**
- Create: `supabase/migrations/20261104000003_interaction_embeddings.sql`
- Modify: `supabase/schema.sql` (table, indexes, RLS line, function, grants)
- Modify: `backend/services/embedding_service.py`, `backend/api/individuals.py` (`generate_embedding_background` and its `add_task` call in `save_individual`)
- Modify: `README.md` (a "Data leaving the system" row for visit transcripts; the delete row now mentions visit embeddings), `docs/EMBEDDINGS.md`
- Test: `backend/tests/test_embedding_text.py`, `test_schema_sql.py` (add `interaction_embeddings` to `TABLES` and the CREATE TABLE count), `test_schema_contract.py` (table set)

**Interfaces:**
- Produces:
  - The table `interaction_embeddings`:
    - `interaction_id UUID PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE`
    - `individual_id UUID NOT NULL REFERENCES individuals(id) ON DELETE CASCADE`
    - `embedding halfvec(3072) NOT NULL`
    - `model TEXT NOT NULL`
    - `text_hash TEXT NOT NULL`
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

    Indexes: `idx_interaction_embeddings_hnsw USING hnsw (embedding halfvec_cosine_ops)` and `idx_interaction_embeddings_individual (individual_id)`. RLS on, no policies.
  - The SQL function `match_interactions(p_query_embedding halfvec(3072), p_individual_id uuid DEFAULT NULL, p_limit int DEFAULT 5) RETURNS TABLE (interaction_id uuid, individual_id uuid, created_at timestamptz, transcription text, location jsonb, similarity double precision)`.
  - `MAX_CHUNK_CHARS = 20000`.
  - `async def EmbeddingService.store_interaction_embedding(self, supabase, interaction: dict, *, force: bool = False) -> bool`, where `interaction` is `{"id", "individual_id", "transcription"}`. The text is `transcription.strip()[:MAX_CHUNK_CHARS]`; empty or None returns `False` with no call. Hash and model gating work as for individuals (`select("model, text_hash").eq("interaction_id", id).limit(1)`). It upserts `{"interaction_id", "individual_id", "embedding", "model", "text_hash"}` with `on_conflict="interaction_id"`.
  - `async def generate_embedding_background(individual_id: str, individual_data: dict, categories: list | None = None, interaction: dict | None = None) -> None`. The person and the visit are embedded in separate `try` blocks, so one failure doesn't skip the other; each failure logs only the id and error type. `save_individual` passes `interaction={"id": str(result.interaction.id), "individual_id": str(result.individual.id), "transcription": request.transcription}` when the transcription isn't blank, else `None`.

- [ ] **Step 1: Write the failing tests**

```python
def test_store_interaction_embedding_writes_the_chunk():
    assert run(svc.store_interaction_embedding(sb, {"id": IID, "individual_id": PID, "transcription": "  Lost his ID.  "})) is True
    row = sb.payloads("interaction_embeddings", "upsert")[0]
    assert set(row) == {"interaction_id", "individual_id", "embedding", "model", "text_hash"}
    assert row["text_hash"] == embedding_text_hash("Lost his ID.")

@pytest.mark.parametrize("t", [None, "", "   "])
def test_blank_transcripts_are_not_embedded(t):        # -> False, no OpenAI call, no upsert

def test_long_transcripts_are_clipped_before_embedding():   # 25,000 chars -> generate_embeddings got 20,000

@pytest.mark.real_embedding_task
def test_background_task_embeds_the_person_and_the_visit():
    # FakeSupabase: both tables' selects -> [], both upserts echo -> one upsert each

@pytest.mark.real_embedding_task
def test_a_failed_person_embedding_still_embeds_the_visit():   # first generate_embeddings raises

def test_save_route_passes_the_visit_to_the_background_task():
    # patch generate_embedding_background with a recorder; POST with transcription "Seen at 16th" ->
    # kwargs/args include interaction={"id": ..., "individual_id": ..., "transcription": "Seen at 16th"};
    # without a transcription -> interaction is None
```

Static tests: `test_interaction_embeddings_table` (each column definition above, including `ON DELETE CASCADE` on both FKs) and `test_interaction_embeddings_hnsw_index`. `match_interactions` → `20261104000003_interaction_embeddings.sql` joins `PHASE4_FUNCTIONS`, plus:

```python
def test_match_interactions_signature():
    fn = _function_sql(SQL, "match_interactions")
    assert ("match_interactions( p_query_embedding halfvec(3072), p_individual_id uuid DEFAULT NULL, "
            "p_limit int DEFAULT 5 )") in fn
    assert "ORDER BY e.embedding <=> p_query_embedding LIMIT" in fn and "SET hnsw.ef_search = 100" in fn
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_embedding_text.py backend/tests/test_schema_sql.py backend/tests/test_schema_contract.py -q`
Expected: FAIL.

- [ ] **Step 3: Write the migration** (also folded into `schema.sql`): the table, the indexes, `ALTER TABLE interaction_embeddings ENABLE ROW LEVEL SECURITY;`, then:

```sql
CREATE OR REPLACE FUNCTION match_interactions(
    p_query_embedding halfvec(3072), p_individual_id uuid DEFAULT NULL, p_limit int DEFAULT 5
)
RETURNS TABLE (interaction_id uuid, individual_id uuid, created_at timestamptz,
               transcription text, location jsonb, similarity double precision)
LANGUAGE sql STABLE
SET search_path = public, extensions
SET hnsw.ef_search = 100
AS $$
SELECT nn.interaction_id, nn.individual_id, x.created_at, x.transcription, x.location, 1 - nn.dist
FROM (
    SELECT e.interaction_id, e.individual_id, e.embedding <=> p_query_embedding AS dist
    FROM interaction_embeddings e
    WHERE p_query_embedding IS NOT NULL
      AND (p_individual_id IS NULL OR e.individual_id = p_individual_id)
    ORDER BY e.embedding <=> p_query_embedding LIMIT least(greatest(coalesce(p_limit, 5), 1), 50)
) nn JOIN interactions x ON x.id = nn.interaction_id
ORDER BY nn.dist, nn.interaction_id;
$$;
```

Then `REVOKE`/`GRANT` as in Task 4 for `match_interactions(halfvec, uuid, int)`, and `NOTIFY pgrst, 'reload schema';`. Ranking is pure cosine distance (ties by id) with no threshold; callers apply their own floor.

- [ ] **Step 4: Implement `store_interaction_embedding` and the background-task change**

README's new data-flow row: "Each visit's transcript → OpenAI embeddings → `interaction_embeddings` (vector only; the transcript is already stored with the interaction). It was already sent to OpenAI to be transcribed, so this sends nothing new."

- [ ] **Step 5: Append to manual steps:** `20261104000003_interaction_embeddings.sql`.

- [ ] **Step 6: Run the tests, then the global checks.** Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase backend README.md docs/EMBEDDINGS.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(search): embed each visit's transcript and add match_interactions (H2-4.3)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Freshness: one refresh path for `--stale`, the full backfill and `generate-all`

**Files:**
- Create: `backend/services/embedding_refresh.py`
- Modify: `backend/scripts/backfill_embeddings.py` (rewrite), `backend/api/embeddings.py:197-243` (`generate-all`)
- Modify: `README.md` (Setup step 4 "Backfill embeddings", the endpoints row for `generate-all`, the limitation about new categories), `docs/EMBEDDINGS.md` (Setup § 4, Monitoring, Troubleshooting)
- Test: Create `backend/tests/test_embedding_refresh.py`; replace `test_embedding_text.py::test_generate_all_route_uses_categories` and `::test_backfill_script_uses_categories`; adjust `test_rate_limit.py:60-80` (generate-all fakes) and Phase 1's `test_event_loop.py` `OFF_LOOP_ROUTES` row for `/api/embeddings/generate-all` (script the five paged reads)

**Interfaces:**
- Consumes: `fetch_all`, `run_db`, `build_embedding_text`, `embedding_text_hash`, `EmbeddingService.generate_embeddings`, `MAX_CHUNK_CHARS`.
- Produces (in `services/embedding_refresh.py`):
  - `EMBED_BATCH_SIZE = 100`, `EMBED_BATCH_MAX_CHARS = 200_000`.
  - `@dataclass class RefreshReport`: `individuals_embedded: int = 0`, `individuals_fresh: int = 0`, `interactions_embedded: int = 0`, `interactions_fresh: int = 0`, `errors: list[str]` (each `"<id>: <ErrorType>"`).
  - `async def refresh_embeddings(supabase, *, stale_only: bool = True, service: EmbeddingService | None = None) -> RefreshReport`.

    It reads, each through `run_db(lambda: fetch_all(...))` and ordered by their key: categories (`order("created_at")`), `individuals` (`id, name, data, updated_at`), `individual_embeddings` (`individual_id, model, text_hash`), `interactions` (`id, individual_id, transcription`) and `interaction_embeddings` (`interaction_id, model, text_hash`).

    A person is stale when `stale_only` is false, or they have no row, or the row's `model != service.model`, or its `text_hash != embedding_text_hash(build_embedding_text(person, categories))`. A visit is stale the same way, but only if its transcript is non-blank (clipped to `MAX_CHUNK_CHARS`).

    Stale texts go out in batches that close at `EMBED_BATCH_SIZE` texts or `EMBED_BATCH_MAX_CHARS` characters. Each batch is one `generate_embeddings` call and one list `upsert` (`on_conflict` `individual_id` / `interaction_id`) with the same row shapes as Tasks 1 and 5. A failed batch adds one error per id in it and the run carries on. Database read errors propagate.
- `backfill_embeddings.py` exposes `async def main(argv: list[str] | None = None) -> int`: `argparse` with `--stale` ("only rows that are missing, from another model, or whose text changed"); without it, every person and visit is re-embedded. It prints the four counts and at most 5 errors (ids and error types only, never names), and returns 1 if there were errors, else 0. `if __name__ == "__main__": sys.exit(asyncio.run(main()))`.
- `POST /api/embeddings/generate-all` runs `refresh_embeddings(supabase, stale_only=True)` and returns `{"success": True, "message": f"Generated embeddings for {n} individuals", "generated_count": n, "fresh_count", "interactions_embedded", "errors"}`. Its rate limit is unchanged.

- [ ] **Step 1: Write the failing tests** (`svc.generate_embeddings = AsyncMock(side_effect=lambda texts: [[0.0] * 3072 for _ in texts])`; `FakeSupabase` selects scripted per table)

```python
def test_stale_only_embeds_missing_changed_and_other_model_rows():
    # A: no row; B: fresh; C: hash differs; D: model "text-embedding-ada-002"
    report = run(refresh_embeddings(sb, service=svc))
    assert [len(c.args[0]) for c in svc.generate_embeddings.await_args_list] == [3]
    assert {r["individual_id"] for r in sb.payloads("individual_embeddings", "upsert")[0]} == {A, C, D}
    assert (report.individuals_embedded, report.individuals_fresh) == (3, 1)

def test_without_stale_everyone_is_re_embedded():          # stale_only=False -> 4 embedded, 0 fresh

def test_batches_hold_at_most_100_texts():                 # 250 people -> batch sizes [100, 100, 50], 3 upserts

def test_batches_also_close_at_200k_characters():          # 3 visits of 90,000 chars -> [2, 1]

def test_a_failed_batch_is_reported_by_id_and_error_type_and_the_rest_continue():
    # 150 people; the first call raises RuntimeError("SENTINEL Ann Lee") ->
    # 100 errors like f"{id}: RuntimeError", no "Ann Lee" in any error, the second batch stored

def test_visits_are_refreshed_too():
    # transcripts "Seen at 16th", "", None, and one with a fresh chunk -> exactly one embedded

def test_flipping_a_category_to_sensitive_makes_its_people_stale():   # Review Focus 5
    # stored hash = hash(text with hiv_status); categories now mark hiv_status sensitive -> re-embedded

def test_every_read_is_paginated(monkeypatch):
    # spy on services.embedding_refresh.fetch_all -> called for all five tables

def test_backfill_stale_flag_selects_the_stale_refresh():
    # patch scripts.backfill_embeddings.refresh_embeddings (AsyncMock -> RefreshReport());
    # main(["--stale"]) -> awaited with stale_only=True; main([]) -> stale_only=False; returns 0

def test_generate_all_uses_the_stale_refresh():
    # patch api.embeddings.refresh_embeddings -> RefreshReport(individuals_embedded=2, individuals_fresh=1)
    # -> 200, generated_count 2, fresh_count 1, called with stale_only=True
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_embedding_refresh.py -q`
Expected: FAIL (`No module named services.embedding_refresh`).

- [ ] **Step 3: Implement `embedding_refresh.py`, the script and the route as specified above**

- [ ] **Step 4: Docs and manual steps**

README Setup § 4 and EMBEDDINGS.md:
- `cd backend && python scripts/backfill_embeddings.py --stale` embeds only what's missing or changed (the usual run);
- without `--stale` it re-embeds everyone;
- `generate-all` is the in-app equivalent of `--stale`;
- after flipping a category's sensitive flag, or editing a category label, run `--stale`; until then the old vector and text stay.

Replace the "first 1000 people" limitation line (the reads are paginated now). In the manual-steps file's **Apply migrations** section, after the Phase 4 migrations, add: "Then run `cd backend && python scripts/backfill_embeddings.py --stale` once. It embeds every visit transcript, plus each person whose text changed now that sensitive fields are left out."

- [ ] **Step 5: Run the tests, then the global checks.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend README.md docs/EMBEDDINGS.md docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(embeddings): re-embed only stale rows, in batches of 100, for people and visits (H2-4.4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: SF neighbourhoods and `most_urgent_individuals`

**Files:**
- Create: `backend/services/sf_neighborhoods.py`, `supabase/migrations/20261104000004_most_urgent.sql`
- Modify: `supabase/schema.sql`
- Test: Create `backend/tests/test_sf_neighborhoods.py`; extend `test_schema_sql.py`

**Interfaces:**
- Produces (in `services/sf_neighborhoods.py`):
  - `class Neighborhood(NamedTuple): lat: float; lng: float; radius_m: int; aliases: tuple[str, ...]`
  - `NEIGHBORHOODS: dict[str, Neighborhood]`, keyed by display name.
  - `def resolve_area(name: str) -> tuple[float, float, float] | None`: `(lat, lng, radius_m)`. Matching is on a normalised name (casefold; `&` → `and`; non-alphanumerics → space; whitespace collapsed; a leading `the ` and a trailing ` district` / ` neighborhood` / ` neighbourhood` / ` area` dropped), looked up against every normalised name and alias. It is exact, not fuzzy; blank or unknown gives `None`.
  - `def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float`: Earth radius 6,371,000 m.
  - `def area_name(lat: float, lng: float) -> str | None`: the neighbourhood whose circle contains the point, with the smallest `distance / radius_m`; else `None`.
- The SQL function `most_urgent_individuals(p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL, p_radius_m double precision DEFAULT NULL, p_limit int DEFAULT 5) RETURNS TABLE (id uuid, name text, data jsonb, urgency_score int, urgency_override int, last_location jsonb, created_at timestamptz, updated_at timestamptz, display_urgency int, last_seen timestamptz, distance_m double precision)`.

The data (approximate centroids; the owner may refine them; keep this list):

| Name | lat, lng | radius m | aliases |
|---|---|---|---|
| Mission | 37.7599, -122.4148 | 1200 | mission district |
| Tenderloin | 37.7847, -122.4145 | 500 | tl, the tl |
| SoMa | 37.7785, -122.4056 | 1200 | south of market, soma |
| Civic Center | 37.7793, -122.4176 | 450 | civic centre, city hall |
| Mid-Market | 37.7810, -122.4120 | 400 | mid market |
| Union Square | 37.7880, -122.4075 | 400 | |
| Financial District | 37.7946, -122.3999 | 700 | fidi |
| Chinatown | 37.7941, -122.4078 | 400 | |
| North Beach | 37.8061, -122.4103 | 600 | |
| Nob Hill | 37.7930, -122.4161 | 500 | |
| Russian Hill | 37.8011, -122.4194 | 600 | |
| Embarcadero | 37.7955, -122.3937 | 800 | |
| Hayes Valley | 37.7759, -122.4245 | 500 | |
| Western Addition | 37.7816, -122.4339 | 900 | fillmore, the fillmore |
| Japantown | 37.7854, -122.4294 | 350 | |
| Lower Haight | 37.7720, -122.4310 | 500 | |
| Haight-Ashbury | 37.7692, -122.4481 | 700 | haight, upper haight, haight ashbury |
| Duboce Triangle | 37.7669, -122.4330 | 350 | |
| Castro | 37.7609, -122.4350 | 600 | |
| Noe Valley | 37.7502, -122.4337 | 900 | |
| Twin Peaks | 37.7544, -122.4477 | 700 | |
| Glen Park | 37.7340, -122.4336 | 600 | |
| Bernal Heights | 37.7389, -122.4152 | 900 | bernal |
| Potrero Hill | 37.7605, -122.4009 | 900 | potrero |
| Dogpatch | 37.7577, -122.3880 | 600 | |
| Mission Bay | 37.7706, -122.3915 | 800 | |
| Bayview-Hunters Point | 37.7290, -122.3920 | 1800 | bayview, hunters point |
| Excelsior | 37.7244, -122.4256 | 1100 | |
| Outer Mission | 37.7206, -122.4420 | 900 | |
| Portola | 37.7284, -122.4067 | 700 | |
| Visitacion Valley | 37.7131, -122.4057 | 900 | vis valley |
| Oceanview-Ingleside | 37.7200, -122.4560 | 900 | ingleside, oceanview, omi |
| Lakeshore | 37.7190, -122.4850 | 1200 | lake merced |
| Inner Sunset | 37.7602, -122.4690 | 900 | |
| Outer Sunset | 37.7550, -122.4940 | 1500 | sunset |
| Golden Gate Park | 37.7694, -122.4862 | 2000 | the park, ggp |
| Inner Richmond | 37.7802, -122.4645 | 1000 | |
| Outer Richmond | 37.7775, -122.4950 | 1300 | richmond |
| Marina | 37.8030, -122.4370 | 700 | |
| Pacific Heights | 37.7925, -122.4382 | 800 | pac heights |
| Presidio | 37.7989, -122.4662 | 1500 | |
| Treasure Island | 37.8235, -122.3706 | 900 | |

- [ ] **Step 1: Write the failing tests**

```python
def test_names_and_aliases_resolve_to_the_same_centre():
    assert resolve_area("Mission") == resolve_area("the Mission District") == resolve_area("MISSION ") == (37.7599, -122.4148, 1200)
    assert resolve_area("south of market") == resolve_area("SoMa")
    assert resolve_area("the TL") == resolve_area("Tenderloin")

@pytest.mark.parametrize("name", ["", "   ", "Atlantis", "Mission St", "Oakland"])
def test_unknown_areas_are_none(name):
    assert resolve_area(name) is None

def test_about_forty_neighbourhoods_all_inside_sf():
    assert 38 <= len(NEIGHBORHOODS) <= 45
    assert all(37.70 <= n.lat <= 37.84 and -122.52 <= n.lng <= -122.35 and 200 <= n.radius_m <= 2500
               for n in NEIGHBORHOODS.values())

def test_haversine_one_hundredth_of_a_degree_of_latitude():
    assert haversine_m(37.7749, -122.4194, 37.7849, -122.4194) == pytest.approx(1112, abs=2)

def test_area_name_picks_the_containing_neighbourhood():
    assert area_name(37.7847, -122.4145) == "Tenderloin"
    assert area_name(37.0, -122.0) is None
```

Static SQL: `most_urgent_individuals` → `20261104000004_most_urgent.sql` joins `PHASE4_FUNCTIONS`, plus:

```python
def test_most_urgent_uses_haversine_and_guards_bad_coordinates():
    fn = _function_sql(SQL, "most_urgent_individuals")
    assert "2 * 6371000 * asin(least(1, sqrt(" in fn
    assert "jsonb_typeof(i.last_location->'latitude') = 'number'" in fn
    assert "ORDER BY display_urgency DESC, last_seen DESC NULLS LAST, l.id" in fn
    assert "COALESCE(l.urgency_override, l.urgency_score)" in fn
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_sf_neighborhoods.py backend/tests/test_schema_sql.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement `sf_neighborhoods.py` and the migration** (also folded into `schema.sql`)

```sql
-- H2-4.7: most urgent people, optionally within a radius of a point (haversine, no PostGIS)
CREATE OR REPLACE FUNCTION most_urgent_individuals(
    p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
    p_radius_m double precision DEFAULT NULL, p_limit int DEFAULT 5
)
RETURNS TABLE (id uuid, name text, data jsonb, urgency_score int, urgency_override int,
               last_location jsonb, created_at timestamptz, updated_at timestamptz,
               display_urgency int, last_seen timestamptz, distance_m double precision)
LANGUAGE sql STABLE
SET search_path = public
AS $$
WITH located AS (
    SELECT i.id, i.name, i.data, i.urgency_score, i.urgency_override, i.last_location,
           i.created_at, i.updated_at,
           CASE WHEN p_lat IS NULL OR p_lng IS NULL THEN NULL
                -- a missing or non-numeric coordinate can't be placed (no cast error)
                WHEN jsonb_typeof(i.last_location->'latitude') = 'number'
                 AND jsonb_typeof(i.last_location->'longitude') = 'number'
                THEN 2 * 6371000 * asin(least(1, sqrt(
                       power(sin(radians((i.last_location->>'latitude')::float8 - p_lat) / 2), 2)
                     + cos(radians(p_lat)) * cos(radians((i.last_location->>'latitude')::float8))
                     * power(sin(radians((i.last_location->>'longitude')::float8 - p_lng) / 2), 2))))
           END AS distance_m
    FROM individuals i
)
SELECT l.id, l.name, l.data, l.urgency_score, l.urgency_override, l.last_location,
       l.created_at, l.updated_at,
       COALESCE(l.urgency_override, l.urgency_score) AS display_urgency,
       (SELECT max(x.created_at) FROM interactions x WHERE x.individual_id = l.id) AS last_seen,
       l.distance_m
FROM located l
WHERE p_lat IS NULL OR p_lng IS NULL
   OR (l.distance_m IS NOT NULL AND l.distance_m <= coalesce(p_radius_m, 1000))
ORDER BY display_urgency DESC, last_seen DESC NULLS LAST, l.id
LIMIT least(greatest(coalesce(p_limit, 5), 1), 50);
$$;
```

Then `REVOKE`/`GRANT` for `most_urgent_individuals(double precision, double precision, double precision, int)` and `NOTIFY pgrst, 'reload schema';`. The display urgency matches `get_display_urgency_score`: an override of 0 counts. It scans `individuals` once per call, which is fine to tens of thousands of rows; the trigger for change is PostGIS or `earthdistance`, and a comment says so.

- [ ] **Step 4: Append to manual steps:** `20261104000004_most_urgent.sql`.

- [ ] **Step 5: Run the tests, then the global checks.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/sf_neighborhoods.py backend/tests supabase docs/superpowers/plans/2026-10-23-manual-steps.md
git commit -m "feat(retrieval): SF neighbourhood lookup and most_urgent_individuals with a haversine filter (H2-4.7)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The retrieval service for the assistant

**Files:**
- Create: `backend/services/retrieval.py`
- Modify: `backend/services/field_registry.py` (add `clip_value`), `backend/services/context_service.py:78-84` (`_clip` becomes an alias of `clip_value`, so `context_service` still works until Phase 5 deletes it)
- Test: Create `backend/tests/test_retrieval.py`

**Interfaces:**
- Consumes:
  - `get_supabase`, `run_db`, `fetch_last_seen`, `IndividualService.abbreviate_address`, `export_columns`, `display_label`, `format_field_value`;
  - `sensitive_keys` (or Phase 3's helper), `get_embedding_service().embed_query`, `DEFAULT_SIMILARITY_THRESHOLD`;
  - `resolve_area`, `area_name`, and the SQL functions from Tasks 4, 5 and 7.
- Produces in `field_registry.py`: `def clip_value(value: Any, limit: int = 100) -> Any`: numbers and bools as-is; lists joined with ", "; a dict through `format_field_value`; everything else `str(value)[:limit]` (today's `context_service._clip`). `retrieval.py` imports `clip_value` from `field_registry` and **nothing** from `context_service` (Phase 5 deletes that module); `grep -n context_service backend/services/retrieval.py` must print nothing.
- Produces in `services/retrieval.py` (exact signatures; Phase 5 calls them):
  - `async def search_people(query: str, limit: int = 5) -> list[dict]`
  - `async def get_person(individual_id: str) -> dict | None`
  - `async def recent_interactions(individual_id: str, limit: int = 5) -> list[dict]`
  - `async def most_urgent(near: str | None = None, limit: int = 5) -> list[dict]`
  - `class UnknownAreaError(ValueError)`: raised by `most_urgent` for a `near` that `resolve_area` doesn't know, with the message `"Unknown area"` (the name is not echoed).
  - Constants: `MAX_LIMIT = 20`, `MAX_LABEL_CHARS = 50`, `MAX_TRANSCRIPT_CHARS = 500`, `MAX_EXCERPT_CHARS = 200`, `SUMMARY_MAX_FACTS = 6`, `RECENT_VISITS = 5`.

**Return shapes** (plain JSON-safe dicts; values clipped with `clip_value`, labels with `display_label(...)[:MAX_LABEL_CHARS]`; not escaped, since Phase 5 serialises and delimits them):

```text
PersonSummary (search_people, most_urgent):
  id                  str
  name                str            clipped to 100
  urgency             int            display score (override if set, an override of 0 counts)
  urgency_overridden  bool
  last_seen           str            ISO 8601: newest interaction's created_at, else the person's created_at
  last_seen_area      str | None     area_name() of the newest interaction's location (else last_location),
                                     else its abbreviated address ("Unknown Address" counts as none), else None
  facts               dict[str, Any] up to SUMMARY_MAX_FACTS non-empty, NON-sensitive fields in export_columns
                                     order, name excluded; label -> clipped value
search_people adds:
  match               str            "exact" | "name" | "text" | "semantic" | "visit"
  matched_visit       {"date": str ISO, "excerpt": str (MAX_EXCERPT_CHARS)} | None
most_urgent adds:
  distance_m          int | None     rounded metres from the area's centre; None without `near`

Person (get_person):
  id, name, urgency, urgency_overridden, last_seen, last_seen_area   as above
  first_seen          str            the person's created_at
  fields              dict[str, Any] EVERY non-empty field, sensitive included: categories in export_columns
                                     order, then uncategorised data keys (sorted, labelled from the key);
                                     name excluded; a repeated label becomes "<label> (<key>)"
  sensitive_fields    list[str]      labels in `fields` that come from is_sensitive categories
  recent_interactions list[Interaction]  newest first, at most RECENT_VISITS

Interaction (get_person, recent_interactions):
  id                  str
  date                str            ISO created_at
  area                str | None     same rule as last_seen_area, for this visit's location
  worker              str            user_name clipped to 100
  transcript          str | None     clipped to MAX_TRANSCRIPT_CHARS
  changed_fields      list[str]      labels of the keys in `changes`; each key in changes["_removed"]
                                     (Phase 2) as "<label> (removed)"; never the values
```

Behaviour:
- `limit` is clamped to `1..MAX_LIMIT`.
- Every database call goes through `run_db`, and database errors propagate (Phase 5 turns them into a tool error).
- **`search_people`**: a blank query gives `[]` with no calls. Otherwise `vec = embed_query(q)`; an exception logs the error type and sets `vec = None`. It calls the hybrid RPC with `p_limit=limit`, `p_min_similarity=DEFAULT_SIMILARITY_THRESHOLD`. When `vec` isn't `None`, it also calls `match_interactions(p_query_embedding=vec, p_individual_id=None, p_limit=limit)` and keeps visits with `similarity >= DEFAULT_SIMILARITY_THRESHOLD`. It attaches each person's best visit as `matched_visit`. People who appear only through a visit are appended after the hybrid rows in visit order, with `match: "visit"`, fetched with one `individuals` select `.in_("id", ids)`. The result is cut to `limit`.
- **`get_person`** / **`recent_interactions`**: an id that isn't a valid UUID gives `None` / `[]` with no database call, and so does an unknown id. Visits come from `interactions` with `.order("created_at", desc=True).limit(n)`.
- **`most_urgent`**: `near` is `None` or blank → `p_lat`/`p_lng`/`p_radius_m` are `None`. Otherwise `resolve_area`; `None` raises `UnknownAreaError` before any call. The RPC order is kept.

- [ ] **Step 1: Write the failing tests** (patch `services.retrieval.get_supabase` with a `FakeSupabase`; `categories` scripted with `hiv_status` sensitive; `interactions` scripted)

```python
SUMMARY_KEYS = {"id", "name", "urgency", "urgency_overridden", "last_seen", "last_seen_area", "facts"}

def test_signatures_match_the_roadmap():
    assert str(inspect.signature(retrieval.search_people)) == "(query: str, limit: int = 5) -> list[dict]"
    assert str(inspect.signature(retrieval.get_person)) == "(individual_id: str) -> dict | None"
    assert str(inspect.signature(retrieval.recent_interactions)) == "(individual_id: str, limit: int = 5) -> list[dict]"
    assert str(inspect.signature(retrieval.most_urgent)) == "(near: str | None = None, limit: int = 5) -> list[dict]"
    assert all(inspect.iscoroutinefunction(f) for f in (retrieval.search_people, retrieval.get_person,
                                                       retrieval.recent_interactions, retrieval.most_urgent))

def test_search_people_returns_compact_summaries_without_sensitive_facts():
    # rpc rows: Ann (exact, override 80, hiv_status "Negative", housing "High"); match_interactions -> []
    [ann] = run(retrieval.search_people("Ann Lee"))
    assert set(ann) == SUMMARY_KEYS | {"match", "matched_visit"}
    assert (ann["match"], ann["urgency"], ann["urgency_overridden"]) == ("exact", 80, True)
    assert "HIV status" not in ann["facts"] and ann["facts"]["Housing Priority"] == "High"
    assert ann["last_seen"] == NEWEST_INTERACTION["created_at"]

def test_search_people_under_three_characters_is_text_only():
    # "Al" -> hybrid p_query_embedding None; no match_interactions call

def test_search_people_embedding_outage_still_answers():   # Review Focus 2: embed_query raises -> rows returned

def test_search_people_appends_people_found_only_through_a_visit():
    # match_interactions -> visit of Cy (similarity 0.5, transcript 400 chars), Cy not in the hybrid rows ->
    # last item is Cy with match "visit" and len(matched_visit["excerpt"]) == 200

def test_search_people_clamps_the_limit_and_ignores_blank_queries():
    # limit=100 -> p_limit 20; "   " -> [] and sb.calls == []

def test_get_person_has_every_field_sensitive_included_and_five_visits():
    p = run(retrieval.get_person(PID))
    assert p["fields"]["HIV status"] == "Negative" and p["sensitive_fields"] == ["HIV status"]
    assert len(p["recent_interactions"]) <= 5
    assert sb.calls_to("interactions", "select")[0].mod("limit") == ((5,), {})
    v = p["recent_interactions"][0]
    assert set(v) == {"id", "date", "area", "worker", "transcript", "changed_fields"}
    assert len(v["transcript"]) == 500 and "Behavior (removed)" in v["changed_fields"]

@pytest.mark.parametrize("bad", ["not-a-uuid", "", "1; drop table individuals"])
def test_get_person_malformed_id_is_none_without_a_query(bad):    # None, sb.calls == []

def test_get_person_unknown_id_is_none():                 # maybe_single -> None

def test_values_and_labels_are_clipped():                 # a 300-char value -> 100; a 300-char label -> 50

def test_recent_interactions_newest_first_and_clamped():  # limit=50 -> .limit(20); order desc

def test_most_urgent_near_an_area_passes_its_centre():
    rows = run(retrieval.most_urgent(near="the Mission"))
    assert sb.rpc_params("most_urgent_individuals")[0] == {"p_lat": 37.7599, "p_lng": -122.4148,
                                                          "p_radius_m": 1200, "p_limit": 5}
    assert isinstance(rows[0]["distance_m"], int)

def test_most_urgent_without_near_has_no_distance():      # params all None except p_limit; distance_m None

def test_most_urgent_unknown_area_raises_before_any_query():   # UnknownAreaError, sb.calls == []

def test_last_seen_falls_back_to_created_at_without_visits():  # Review Focus 4; last_seen_area None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest backend/tests/test_retrieval.py -q`
Expected: FAIL (`No module named services.retrieval`).

- [ ] **Step 3: Implement `clip_value` and `retrieval.py` as specified**

Run `python -m pytest backend/tests/test_context_service.py -q` too: `_clip` behaves as before.

- [ ] **Step 4: Run the tests, then the global checks.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/retrieval.py backend/services/field_registry.py backend/services/context_service.py backend/tests/test_retrieval.py
git commit -m "feat(retrieval): search_people, get_person, recent_interactions and most_urgent for the assistant (H2-4.7)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Search screen: 600 ms pause before semantic search, new match badges

**Files:**
- Modify: `mobile/screens/ModernSearchScreen.tsx:29,155-167,232-249`
- Modify: `mobile/types/index.ts:25` (`search_type`)
- Modify: `README.md` ("On the Search tab, typing runs one search per 300 ms pause"), `docs/EMBEDDINGS.md` (Frontend integration § 1, § 4, § 5)
- Test: `mobile/screens/__tests__/ModernSearchScreen.test.tsx`

**Interfaces:**
- Consumes: the `POST /api/embeddings/search` response from Task 4 (`search_type` `"exact" | "name" | "value" | "semantic"`; `similarity_score` may be `null`).
- Produces: `SearchResult.search_type?: 'exact' | 'name' | 'value' | 'semantic'`. In the screen, constants `TEXT_DEBOUNCE_MS = 300`, `SEMANTIC_DEBOUNCE_MS = 600`, `SEMANTIC_MIN_CHARS = 3`, and `debounceFor(query: string): number`, which returns 600 when the trimmed query, with whitespace collapsed, has 3 or more characters, else 300. If Phase 6 has already moved this screen to TanStack Query, apply the same rule to the debounced query value it uses.

- [ ] **Step 1: Write the failing tests**

```tsx
it('waits for a 600 ms pause before searching three or more characters', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  (api.semanticSearchIndividuals as jest.Mock).mockResolvedValue([ann]);
  const { getByText, getByPlaceholderText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Ann Lee'));
  fireEvent.changeText(getByPlaceholderText(box), 'ann');
  await act(async () => { await new Promise(r => setTimeout(r, 450)); });
  expect(api.semanticSearchIndividuals).not.toHaveBeenCalled();
  await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledWith('ann'));
});

it('searches a one- or two-character query after 300 ms', async () => {
  // type 'an'; after 150 ms not called; waitFor called with 'an' within 1000 ms
});

it('shows Name, Details and percentage badges by match type', async () => {
  // semantic results: {search_type: 'name', similarity_score: null}, {search_type: 'value', similarity_score: null},
  // {search_type: 'semantic', similarity_score: 0} -> 'Name', 'Details', '0%'
});
```

Remove the existing `renders the match badge for a 0 similarity score` test; the third test above covers it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mobile && npx jest screens/__tests__/ModernSearchScreen.test.tsx`
Expected: FAIL (the call comes at 300 ms; there is no "Name" badge).

- [ ] **Step 3: Implement it**

The search effect uses `setTimeout(() => performSearch(query), debounceFor(query))`. The badge renders when `item.search_type != null`. Its label is "Exact" for exact, "Name" for name, "Details" for value, else `` `${Math.round((item.similarity_score ?? 0) * 100)}%` ``; the icon is `bulb-outline` only for semantic. Keep the sequencing, the fallback to `api.searchIndividuals`, and `api.ts` as they are. Docs: README and EMBEDDINGS.md say "one search per pause: 600 ms for 3+ characters (the semantic leg), 300 ms for shorter queries (text only)" and list the four badges.

- [ ] **Step 4: Run the tests, then the global checks**

Run: `cd mobile && npx tsc --noEmit && npx jest`, then the backend checks.
Expected: PASS. The existing sequencing tests still pass because `waitFor`'s 1000 ms timeout covers the 600 ms debounce.

- [ ] **Step 5: Commit**

```bash
git add mobile/screens/ModernSearchScreen.tsx mobile/types/index.ts mobile/screens/__tests__/ModernSearchScreen.test.tsx README.md docs/EMBEDDINGS.md
git commit -m "feat(mobile): semantic search after a 600 ms pause, and Name/Details/semantic badges (H2-4.5)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Interfaces produced for later phases

**Phase 5 (voice tools).** `backend/services/retrieval.py`, exactly:
- `async def search_people(query: str, limit: int = 5) -> list[dict]`: PersonSummary plus `match`, `matched_visit`.
- `async def get_person(individual_id: str) -> dict | None`: Person, with sensitive fields and the latest 5 visits.
- `async def recent_interactions(individual_id: str, limit: int = 5) -> list[dict]`: Interaction.
- `async def most_urgent(near: str | None = None, limit: int = 5) -> list[dict]`: PersonSummary plus `distance_m`. It raises `UnknownAreaError` (a `ValueError`) for an unknown area; map it to a tool output such as `{"error": "unknown_area"}`.
- The shapes are the ones in Task 8. Every result has `last_seen` (the newest interaction, else `created_at`), never `updated_at`. `limit` is clamped to 1-20.
- Values are clipped but not escaped: Phase 5 serialises them with `build_context_item`'s delimiting rules.
- Database errors propagate; embedding errors degrade to text-only.
- The tools' JSON schemas: `query: string`, `individual_id: string (uuid)`, `near: string` (an SF neighbourhood name), and `limit: integer` with minimum 1 and a maximum of at most 20 (Phase 5's tools cap it at 10).

Also produced:
- `services/sf_neighborhoods.py`: `resolve_area(name) -> tuple[float, float, float] | None`, `area_name(lat, lng) -> str | None`, `haversine_m(...)`, `NEIGHBORHOODS`.
- `services/embedding_service.py`: `get_embedding_service()`, `EmbeddingService.embed_query(query) -> list[float] | None` (cached; `None` under 3 characters), `embedding_text_hash(text)`, `generate_embeddings(texts)`, `store_individual_embedding(..., force=False) -> bool`, `store_interaction_embedding(..., force=False) -> bool`, `clear_query_cache()`, `normalize_query()`.
- `field_registry.clip_value(value, limit=100)`.

**Phase 7 (async recordings).** Its worker saves through the same `POST /api/individuals` path, or calls `generate_embedding_background(individual_id, individual_data_with_updated_at, categories, interaction={"id", "individual_id", "transcription"})` directly. `refresh_embeddings(supabase, stale_only=True)` repairs anything a crash skipped.

**Phase 8 (CI db tests, ops).** The SQL functions to call against local Postgres and the cases to pin:
- `search_individuals_hybrid(p_query, p_query_embedding, p_limit, p_min_similarity)`:
  - an exact case-insensitive name is first even when another person scores higher;
  - a person in all three legs outranks one in a single leg;
  - a NULL embedding still returns name and text matches;
  - "veteran" doesn't match a person whose only veteran mention is the `veteran_status` key;
  - "diab" finds Diabetes and "male" doesn't find Female;
  - `50%_`, `a & !b` and `O'Brien` run without error and match literally;
  - a blank query returns no rows.
- `match_interactions(p_query_embedding, p_individual_id, p_limit)`: ordered by cosine distance; the per-person filter works.
- `most_urgent_individuals(p_lat, p_lng, p_radius_m, p_limit)`: the radius filter; a non-numeric latitude is excluded without error; ordered by display urgency (an override of 0 counts).
- All four Phase 4 migrations applied twice are no-ops.
- The structured logs (Phase 8.1) may add `embed_ms` around `embed_query` and `generate_embeddings`. The batch report's error strings already carry only ids and error types.
