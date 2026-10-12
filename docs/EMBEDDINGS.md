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
Search tab → POST /api/embeddings/search → name / data-value text match (search_matching.py)
                                         → query embedding (OpenAI)
                                         → cosine similarity in Python against every stored vector
                                         → combined, de-duplicated results
```

Vectors live in the `individual_embeddings` table as a JSONB array, one row per
individual (`UNIQUE (individual_id)`). Similarity is computed with scikit-learn,
not in the database; pgvector would be the scalable choice.

## Setup

### 1. Install dependencies

From the repo root, in a Python 3.11 virtualenv:

```bash
python -m pip install -r requirements.txt
```

`numpy` and `scikit-learn` (both pinned there) handle the vector maths.

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
`POST /api/embeddings/search` is a hybrid:

1. **Text match.** `match_individual` (`backend/services/search_matching.py`, the
   same matcher the list search and duplicate detection use) is case-insensitive.
   The name matches as a substring; a string value or list item in `data` matches
   only where the query starts a word ("male" finds "Male", not "Female"; "diab"
   finds "Diabetes"). It never matches field names, so "veteran" does not hit
   everyone with a `veteran_status` key. A name match is `search_type: "exact"`
   with a score of 1.0; a data-value match is `"value"` with 0.9.
2. **Semantic match.** The query is embedded, compared with every stored vector,
   and results at or above `similarity_threshold` are kept, up to `top_k`.
3. Results are ranked in tiers (`MATCH_TIER`): name matches, then value matches,
   then semantic matches by score. A semantic score above 0.9 still ranks below a
   value match. A person found by both text and semantic search appears once, as
   the text match.

Both steps load the whole `individuals` / `individual_embeddings` table and work
in Python, so search time grows linearly with the number of people: demo scale.
Each read is also capped by Supabase's API row limit (1000 rows by default).

### 2. Text representation
`build_embedding_text` (`backend/services/field_registry.py`) builds one line
per profile: the name, then each non-empty `data` value labelled with the
category's `display_name` (else its key title-cased); data keys that match no
category follow, labelled from the key. The category order is fixed whatever
order a caller fetched them in (name, required, other presets, then the rest,
each by `created_at` then key), so every path builds the same text. Lists are joined
with ", " and a location is its address. For example, the seeded John Doe with a
custom "HIV status" category added:

```
Name: John Doe. Height: 72; Weight: 180; Age: 45; Gender: Male; Substance Abuse History: Moderate; Housing Priority: High; Medical Conditions: Diabetes; Veteran Status: No; HIV status: Negative
```

`EmbeddingService.store_individual_embedding` embeds that text and upserts the
vector with **exactly that text** as `embedding_text`. All four paths use it:
the background task on save, `/generate`, `/generate-all` and
`scripts/backfill_embeddings.py`, so the same person always gets the same text.
A vector that isn't 3072 long is rejected rather than stored, and search skips
stored vectors of another length (left by an older model) instead of failing
the whole semantic comparison.

Creating a category doesn't re-embed anyone: existing people pick up the new
field's label when they are next saved, or run `/generate-all` or the backfill
script.

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
        {"id": result.individual.id, "name": result.individual.name, "data": result.individual.data},
        categories,   # the rows the save already loaded
    )
    return result
```

The task calls `store_individual_embedding`, which upserts:

```python
supabase.table("individual_embeddings").upsert({
    "individual_id": individual["id"],
    "embedding_data": embedding,
    "embedding_text": text,          # the exact text that was embedded
}, on_conflict="individual_id").execute()
```

`on_conflict="individual_id"` makes a re-save replace the person's existing
vector instead of failing on the unique constraint.

If the task fails (for example, OpenAI is unreachable), the error is logged and
the save is unaffected. There is no retry; run `/generate` or `/generate-all` to
fill gaps, and check `/status` for coverage.

## Performance and cost

- Each vector is 3072 floats, stored as JSON text (tens of KB per row).
- `text-embedding-3-large` costs $0.13 per million tokens; a profile is roughly
  50-100 tokens, so embedding 1,000 profiles costs well under a cent.
- Search is O(n) in the number of individuals, and a single read returns at most
  Supabase's row limit (1000 by default). Beyond demo scale, move the vectors to
  pgvector and let Postgres do the nearest-neighbour search.

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
