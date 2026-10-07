# Embedding search

How the semantic search over individual profiles is set up and how it behaves.

## Overview

The search uses OpenAI's `text-embedding-3-large` model (3072 dimensions) to turn
each profile into a vector, so a query like "veteran with diabetes" can find
people whose records never contain that exact phrase. The embedded text covers:

- name
- age, height, weight, gender
- substance abuse history, medical conditions, mental health issues
- veteran status, housing status, behavior
- urgency score and override (only when embedded via the `/generate` endpoints;
  see below)

Only these fields are embedded. The list is hardcoded in
`backend/services/embedding_service.py:50-90`, so custom categories are not part
of the vector.

## Architecture

```
Search tab → POST /api/embeddings/search → name/JSONB text match
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
make one OpenAI call per individual.

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
2. If that fails, it falls back to `api.searchIndividuals()`, a direct Supabase
   name query.
3. With an empty query, the screen lists everyone via `api.searchIndividuals('')`.
4. Results carry `similarity_score` and `search_type` (`exact` or `semantic`),
   which the screen shows as a match percentage. The search endpoint returns no
   last-seen date, so the app fills in the current time for these results
   (`mobile/services/api.ts:310-312`).

## How it works

### 1. Search
`POST /api/embeddings/search` is a hybrid:

1. **Text match.** Names matching `%query%` (case-insensitive), plus anyone whose
   JSONB `data` contains the query as a substring. These are `search_type:
   "exact"` with a score of 1.0.
2. **Semantic match.** The query is embedded, compared with every stored vector,
   and results at or above `similarity_threshold` are kept, up to `top_k`.
3. Text matches come first, then semantic matches by score, with duplicates
   removed.

Both steps load the whole `individuals` / `individual_embeddings` table, so
search time grows linearly with the number of people.

### 2. Text representation
`generate_individual_embedding` builds one line of text per profile, for example:

```
Name: John Doe Age: 45 years old Height: 72 inches Weight: 180 pounds Gender: Male
Substance abuse: Moderate Medical conditions: Diabetes Veteran status: No Urgency score: 52
```

The `embedding_text` column stores a readable summary alongside the vector. It
is built separately and is not always exactly the text that was embedded.

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
    )
    return result
```

The task embeds the profile and upserts it:

```python
supabase.table("individual_embeddings").upsert({
    "individual_id": individual_id,
    "embedding_data": embedding,
    "embedding_text": embedding_text,
}, on_conflict="individual_id").execute()
```

`on_conflict="individual_id"` makes a re-save replace the person's existing
vector instead of failing on the unique constraint. The background task passes
only `id`, `name` and `data`, so vectors made on save do not include the urgency
score; vectors made by `/generate` and `/generate-all` do.

If the task fails (for example, OpenAI is unreachable), the error is logged and
the save is unaffected. There is no retry; run `/generate` or `/generate-all` to
fill gaps, and check `/status` for coverage.

## Performance and cost

- Each vector is 3072 floats, stored as JSON text (tens of KB per row).
- `text-embedding-3-large` costs $0.13 per million tokens; a profile is roughly
  50-100 tokens, so embedding 1,000 profiles costs well under a cent.
- Search is O(n) in the number of individuals. Past a few thousand records, move
  the vectors to pgvector and let Postgres do the nearest-neighbour search.

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
- **500 "Failed to generate embedding":** check `OPENAI_API_KEY`, quota and rate
  limits.
- **A new person never shows up in semantic results:** look in the backend log
  for "Background task: Failed to generate embedding", then call `/generate` for
  that id. Text matches still work without a vector.
- **Too many weak matches:** raise `similarity_threshold` in the request.

## Privacy

Embeddings and `embedding_text` are derived from personal and medical data and
are covered by the same row-level security as the rest of the database: any
signed-in user can read them. Treat them as sensitive.
