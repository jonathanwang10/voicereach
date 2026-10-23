"""
Embedding API endpoints for semantic search and embedding management
"""
from fastapi import APIRouter, Depends, HTTPException
import logging
from services.embedding_service import EmbeddingService, DEFAULT_SIMILARITY_THRESHOLD, get_embedding_service
from uuid import UUID
from api.auth import get_current_user
from api.errors import internal_error
from db.client import fetch_all, get_supabase, run_db
from pydantic import BaseModel, Field
from services.rate_limit import rate_limit
from services.individual_service import IndividualService, fetch_last_seen
from services.urgency_calculator import get_display_urgency_score

# search_individuals_hybrid's match_source -> the API's search_type
SEARCH_TYPE = {"exact": "exact", "name": "name", "text": "value", "semantic": "semantic"}

router = APIRouter(prefix="/api/embeddings", tags=["embeddings"])
logger = logging.getLogger(__name__)
embedding_service = EmbeddingService()


# Request models
class SearchRequest(BaseModel):
    # Bounded so one call can't ask for every row or a huge embedding (C-12)
    query: str = Field(..., max_length=500)
    top_k: int = Field(10, ge=1, le=50)
    similarity_threshold: float = Field(DEFAULT_SIMILARITY_THRESHOLD, ge=0, le=1)


class GenerateEmbeddingRequest(BaseModel):
    individual_id: UUID


@router.post("/generate")
async def generate_embedding_for_individual(
    request: GenerateEmbeddingRequest,
    user_id: str = Depends(rate_limit(
        "embeddings_generate", "RATE_LIMIT_EMBEDDINGS_GENERATE_PER_MIN", 30)),
):
    """
    Generate embedding for a specific individual
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        # Get individual data from database
        individual_id = str(request.individual_id)
        result = await run_db(lambda: supabase.table("individuals").select("*").eq("id", individual_id).execute())
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Individual not found")
        
        individual = result.data[0]
        categories = (await run_db(lambda: supabase.table("categories").select("*")
                                   .order("created_at").execute())).data or []

        # Same text and storage as every other embedding path (C-34)
        # An explicit request: re-embed even a fresh row
        await embedding_service.store_individual_embedding(supabase, individual, categories, force=True)

        return {
            "success": True,
            "message": f"Embedding generated and stored for individual {individual_id}",
            "embedding_dimensions": embedding_service.dimensions
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Generate embedding", e)


@router.post("/search")
async def semantic_search_individuals(
    request: SearchRequest,
    user_id: str = Depends(rate_limit(
        "embeddings_search", "RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN", 60)),
):
    """
    Hybrid search in Postgres (`search_individuals_hybrid`, H2-4.2): an exact name
    match first, then reciprocal-rank fusion of a trigram name leg, a full-text leg
    over data values (never keys, C-01) and a pgvector cosine leg. The query is
    embedded here (cached; none for a query under 3 characters). If embedding fails
    (an OpenAI outage), the search runs text-only; the log names the error type,
    never the query. A database error is a 500, not "no matches" (C-17).
    """
    q = request.query.strip()
    if not q:
        return _search_response(request, [], semantic_used=False)
    try:
        supabase = get_supabase()
        try:
            vector = await get_embedding_service().embed_query(q)
        except Exception as e:
            logger.warning("Query embedding failed: %s", type(e).__name__)
            vector = None
        params = {"p_query": q, "p_query_embedding": vector, "p_limit": request.top_k,
                  "p_min_similarity": request.similarity_threshold}
        rows = (await run_db(lambda: supabase.rpc("search_individuals_hybrid", params).execute())).data or []

        # last_seen / address come from ONE interactions query for all results
        latest = await run_db(lambda: fetch_last_seen(supabase, [r['id'] for r in rows]))
        abbreviate = IndividualService(supabase).abbreviate_address
        results = []
        for r in rows:  # SQL order is the ranking
            seen = latest.get(str(r['id']))
            location = (seen or {}).get("location") or r.get("last_location")
            address = (location or {}).get("address")
            search_type = SEARCH_TYPE[r.get("match_source") or "semantic"]
            results.append({
                "id": r['id'],
                "name": r.get('name'),
                "urgency_score": r.get('urgency_score'),
                "urgency_override": r.get('urgency_override'),
                "display_score": get_display_urgency_score(r),
                "last_seen": seen["last_seen"] if seen else r.get('created_at'),
                "abbreviated_address": abbreviate(address) if address else None,
                "data": r.get('data') or {},
                "search_type": search_type,
                "similarity_score": 1.0 if search_type == "exact" else r.get("similarity"),
                "score": r.get("score"),
            })
        return _search_response(request, results, semantic_used=vector is not None)

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Search", e)


def _search_response(request: SearchRequest, results: list, *, semantic_used: bool) -> dict:
    return {
        "results": results,
        "query": request.query,
        "total_results": len(results),
        "normal_results": len([r for r in results if r['search_type'] != 'semantic']),
        "semantic_results": len([r for r in results if r['search_type'] == 'semantic']),
        "similarity_threshold": request.similarity_threshold,
        "semantic_used": semantic_used,
    }


@router.post("/generate-all")
async def generate_embeddings_for_all_individuals(
    user_id: str = Depends(rate_limit(
        "embeddings_generate_all", "RATE_LIMIT_GENERATE_ALL_PER_MIN", 1)),
):
    """
    Generate embeddings for all individuals in the database (one OpenAI call per
    person, so 1 call per user per minute by default; the backfill script is the
    usual way to do this)
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        # Get all individuals
        individuals = await run_db(lambda: fetch_all(
            lambda: supabase.table("individuals").select("*").order("id")))

        if not individuals:
            return {"message": "No individuals found in database"}

        categories = (await run_db(lambda: supabase.table("categories").select("*")
                                   .order("created_at").execute())).data or []

        generated_count = 0
        errors = []
        
        for individual in individuals:
            try:
                await embedding_service.store_individual_embedding(supabase, individual, categories)
                generated_count += 1
                
            except Exception as e:
                # Id and error type only: no names, no upstream error text (R-13)
                errors.append(f"{individual.get('id')}: {type(e).__name__}")
                continue
        
        return {
            "success": True,
            "message": f"Generated embeddings for {generated_count} individuals",
            "generated_count": generated_count,
            "errors": errors
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Generate embeddings", e)


@router.get("/status")
def get_embedding_status(user_id: str = Depends(get_current_user)):
    """
    Get status of embeddings in the database
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        # Count total individuals
        total_result = supabase.table("individuals").select("id", count="exact").execute()
        total_individuals = total_result.count if hasattr(total_result, 'count') else len(total_result.data)
        
        # Count individuals with embeddings
        embedding_result = supabase.table("individual_embeddings").select("id", count="exact").execute()
        total_embeddings = embedding_result.count if hasattr(embedding_result, 'count') else len(embedding_result.data)
        
        return {
            "total_individuals": total_individuals,
            "total_embeddings": total_embeddings,
            "coverage_percentage": round((total_embeddings / total_individuals * 100) if total_individuals > 0 else 0, 2)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Embedding status", e)
