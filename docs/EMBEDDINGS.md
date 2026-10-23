# Embedding search

How the semantic search over individual profiles is set up and how it behaves.

## Overview

The search uses OpenAI's `text-embedding-3-large` model (3072 dimensions) to turn
each profile into a vector, so a query like "veteran with diabetes" can find
people whose records never contain that exact phrase. The embedded text covers
the name and **every non-empty field in the person's `data`**, labelled with its
category's label and in category order, so custom categories and free-text
notes (`additional_information`) are searchable too. Urgency is never part of
the text. It is built by one function,
`field_registry.build_embedding_text(individual, categories)`, which every
embedding path uses.

## Architecture

```
Search tab → POST /api/embeddings/search → query embedding (OpenAI, cached; none under 3 characters)
                                         → search_individuals_hybrid (Postgres):
                                             trigram name leg + full-text leg + pgvector cosine leg,
                                             fused by reciprocal rank, exact name first
```

Vectors live in `individual_embeddings.embedding` as pgvector `halfvec(3072)`,
one row per individual (`UNIQUE (individual_id)`), with an HNSW index
(`halfvec_cosine_ops`). Each row also stores the embedded text, the model, a
sha256 `text_hash` of the text, and the `individuals.updated_at` it came from
(H2-4.1).

## Setup

### 1. Install dependencies

From the repo root, in a Python 3.11 virtualenv:

```bash
python -m pip install -r requirements.txt
```

The nearest-neighbour search runs in Postgres (pgvector 0.7.0 or later), so the
backend needs no vector library.

### 2. Database

`supabase/schema.sql` creates `individual_embeddings` along with every other
table. Run it once in the Supabase SQL Editor (see the README's Setup section).

### 3. Environment variables

`backend/.env` needs `OPENAI_API_KEY` in addition to the Supabase values.

### 4. Generate initial embeddings

The seeded demo individuals have no embeddings. Generate them with either:

```bash
cd backend && python scripts/backfill_embeddings.py
```

or, with the backend running, `POST /api/embeddings/generate-all` (below). Both
re-embed every individual, one OpenAI call each. Run one again after upgrading
from an older version, so every stored text matches `build_embedding_text`.

### 5. Start the backend

```bash
cd backend && python -m uvicorn main:app --reload --port 8001
# On a physical phone, start with --host 0.0.0.0 so the device can reach it:
# cd backend && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8001
```

## API endpoints

All of these need `Authorization: Bearer <Supabase access token>`; the README's
Auth section shows how to get one for curl.

### Generate an embedding for one individual
```
POST /api/embeddings/generate
Body: {"individual_id": "uuid"}
```

### Search
```
POST /api/embeddings/search
Body: {
  "query": "search text",
  "top_k": 10,
  "similarity_threshold": 0.15
}
```

`top_k` and `similarity_threshold` are optional; 10 and 0.15 are the defaults.

### Generate all embeddings
```
POST /api/embeddings/generate-all
```

### Embedding coverage
```
GET /api/embeddings/status
```

## Frontend integration

1. **ModernSearchScreen** calls `api.semanticSearchIndividuals()` for a typed
   query (`top_k` 20, threshold 0.15).
2. If that fails, it falls back to `api.searchIndividuals()`, which is
   `GET /api/individuals?search=...` (the backend's text search).
3. With an empty query, the screen lists everyone via `api.searchIndividuals('')`
   (`GET /api/individuals`, most recently seen first, up to 100).
4. Results carry `similarity_score` and `search_type`. The screen shows "Exact"
   for a name match, "Details" for a data-value match and the match percentage for
   a semantic match, plus `last_seen` and `display_score`. `last_seen` uses the
   same rule as the list (latest interaction, else `created_at`).
5. Typing runs one search per 300 ms pause. Each search takes a sequence number,
   and a response that is no longer the newest is dropped, so a slow result for
   "v" never replaces the one for "veteran".

## How it works

### 1. Search
`POST /api/embeddings/search` embeds the query (a process cache of 256 queries for
10 minutes; no semantic leg for a query under 3 characters) and makes one call to
the SQL function `search_individuals_hybrid` (H2-4.2). It has three legs, each
returning at most 3 x `top_k` candidates:

1. **Name:** an ILIKE substring match (the query is escaped, so `%` and `_` are
   literal) or a `pg_trgm` trigram match; substring matches rank first.
2. **Full text:** `individuals.search_tsv`, generated from the name and the string
   values of `data` (never field names, so "veteran" doesn't hit everyone with a
   `veteran_status` key; C-01). The query matches as whole words or as word
   prefixes ("diab" finds Diabetes; "male" doesn't find Female).
3. **Semantic:** the nearest stored vectors by cosine distance (HNSW), keeping
   only similarity >= `similarity_threshold`.

The legs are fused by reciprocal rank (`score = Σ 1/(60 + rank)`), and a
case-insensitive exact name match always comes first. Each result's
`search_type` is `"exact"`, else the leg where it ranked best (`"name"`,
`"value"` for full text, `"semantic"`); `similarity_score` is 1.0 for an exact
name, else the cosine similarity when the semantic leg had the person. If
embedding the query fails, the search runs on the name and full-text legs
alone (`semantic_used: false`).

### 2. Text representation
`build_embedding_text` (`backend/services/field_registry.py`) builds one line
per profile: the name, then each non-empty `data` value labelled with the
category's `display_name` (else its key title-cased); data keys that match no
category follow, labelled from the key. A category flagged `is_sensitive` (health
and similar information) is never included (H2-4.6): its value doesn't go to the
embeddings API, and flagging a category changes the text, so the stored vector is
stale until the next refresh. The category order is fixed whatever
order a caller fetched them in (name, required, other presets, then the rest,
each by `created_at` then key), so every path builds the same text. Lists are joined
with ", " and a location is its address. For example, the seeded John Doe with a
custom "HIV status" category added (before Phase 3 flagged Substance Abuse
History and Medical Conditions as sensitive; today, those two fields and a
sensitive HIV status are left out):

```
Name: John Doe. Height: 72; Weight: 180; Age: 45; Gender: Male; Substance Abuse History: Moderate; Housing Priority: High; Medical Conditions: Diabetes; Veteran Status: No; HIV status: Negative
```

`EmbeddingService.store_individual_embedding` embeds that text and upserts the
vector with **exactly that text** as `embedding_text`. All four paths use it:
the background task on save, `/generate`, `/generate-all` and
`scripts/backfill_embeddings.py`, so the same person always gets the same text.
A vector that isn't 3072 long is rejected rather than stored (the
`halfvec(3072)` column couldn't take it). A row whose model and text hash match
the text built now is left alone: no OpenAI call.

Creating a category doesn't re-embed anyone: existing people pick up the new
field's label when they are next saved, or run `/generate-all` or the backfill
script.

### 2b. Visit chunks
Each visit's transcript is embedded too (H2-4.3): `interaction_embeddings` holds
one `halfvec(3072)` per interaction (the transcript itself stays on the
interaction), up to 20,000 characters, with the same model/text-hash freshness
rule. `match_interactions(query_embedding, individual_id?, limit)` returns the
nearest visits by cosine distance. The save's background task embeds the person
and the visit separately, so one failing doesn't skip the other.

### 3. Automatic generation on save
Every successful `POST /api/individuals` (create or merge) schedules a FastAPI
background task, so the save returns without waiting for OpenAI:

```python
@router.post("", response_model=SaveIndividualResponse)   # mounted at /api/individuals
async def save_individual(request, background_tasks: BackgroundTasks, user_id=Depends(get_current_user), ...):
    result = await service.save_individual(...)
    background_tasks.add_task(
        generate_embedding_background,
        result.individual.id,
        {"id": ..., "name": ..., "data": ..., "updated_at": ...},
        categories,   # the rows the save already loaded
    )
    return result
```

The task calls `store_individual_embedding`, which skips a fresh row and
otherwise upserts:

```python
supabase.table("individual_embeddings").upsert({
    "individual_id": individual["id"],
    "embedding": embedding,          # halfvec(3072)
    "embedding_text": text,          # the exact text that was embedded
    "model": model, "text_hash": sha256(text), "source_updated_at": individual["updated_at"],
}, on_conflict="individual_id").execute()
```

`on_conflict="individual_id"` makes a re-save replace the person's existing
vector instead of failing on the unique constraint.

If the task fails (for example, OpenAI is unreachable), the error is logged and
the save is unaffected. There is no retry; run `/generate` or `/generate-all` to
fill gaps, and check `/status` for coverage.

## Performance and cost

- Each vector is 3072 half-precision floats (about 6 KB per row), indexed by HNSW.
- `text-embedding-3-large` costs $0.13 per million tokens; a profile is roughly
  50-100 tokens, so embedding 1,000 profiles costs well under a cent.
- Search is one SQL call: the vector leg is an HNSW nearest-neighbour scan
  (`hnsw.ef_search = 100` for the call), and the name and full-text legs use GIN
  indexes (trigram and `search_tsv`). A repeated query within 10 minutes reuses
  its cached embedding.

## Monitoring

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8001/api/embeddings/status

curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:8001/api/embeddings/generate-all

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"individual_id": "uuid"}' \
  http://localhost:8001/api/embeddings/generate
```

## Troubleshooting

- **401 from every endpoint:** missing or expired access token.
- **500 "Generate embedding failed"** (or "Generate embeddings failed" from
  `/generate-all`): check `OPENAI_API_KEY` and your OpenAI quota. A **429** is
  this backend's own per-account limit (`RATE_LIMIT_*_PER_MIN`; `/generate-all`
  allows one call a minute).
- **A new person never shows up in semantic results:** look in the backend log
  for "Background embedding failed for <id>", then call `/generate` for that
  id. Text matches still work without a vector.
- **Too many weak matches:** raise `similarity_threshold` in the request.

## Privacy

Embeddings and `embedding_text` are derived from personal and medical data and
are covered by the same row-level security as the rest of the database (on,
with no policies): nobody can read them directly, only through the backend,
which any accepted user can call. Treat them as sensitive.
