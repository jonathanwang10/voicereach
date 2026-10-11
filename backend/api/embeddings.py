"""
Embedding API endpoints for semantic search and embedding management
"""
from fastapi import APIRouter, Depends, HTTPException
import logging
import os
from services.embedding_service import EmbeddingService, DEFAULT_SIMILARITY_THRESHOLD
from uuid import UUID
from api.auth import get_current_user
from api.errors import internal_error
from supabase import create_client, Client
from pydantic import BaseModel, Field
from services.rate_limit import rate_limit
from services.individual_service import IndividualService, fetch_last_seen
from services.urgency_calculator import get_display_urgency_score
from services.search_matching import MATCH_TIER, match_individual

# Text matches as search results: matcher kind -> search_type and score
TEXT_MATCH = {
    "name": {"search_type": "exact", "similarity_score": 1.0},
    "value": {"search_type": "value", "similarity_score": 0.9},
}
# Sort tier per search_type (exact = name match)
TIER_OF = {"exact": MATCH_TIER["name"], "value": MATCH_TIER["value"], "semantic": MATCH_TIER["semantic"]}

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


def get_supabase_client() -> Client:
    """Get Supabase client instance"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")
    
    # Ensure real Supabase credentials are provided
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be provided - no mock data allowed")
    
    return create_client(url, key)


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
        supabase = get_supabase_client()
        
        # Get individual data from database
        individual_id = str(request.individual_id)
        result = supabase.table("individuals").select("*").eq("id", individual_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Individual not found")
        
        individual = result.data[0]
        categories = supabase.table("categories").select("*").order("created_at").execute().data or []

        # Same text and storage as every other embedding path (C-34)
        dimensions = await embedding_service.store_individual_embedding(supabase, individual, categories)

        return {
            "success": True,
            "message": f"Embedding generated and stored for individual {individual_id}",
            "embedding_dimensions": dimensions
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
    Hybrid search. Results are tiered: name matches ("exact", 1.0), then data-value
    matches ("value", 0.9), then semantic matches by cosine score. Text matching uses
    services/search_matching.match_individual (values only, never keys).
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Text leg: the shared value-only matcher (C-01). A name match is "exact"
        # (score 1.0), a match in a data value is "value" (score 0.9).
        # A database failure here is an outage, not "no matches": let it become a 500 (C-17).
        text_results = []
        if request.query.strip():
            for ind in supabase.table("individuals").select("*").execute().data or []:
                kind = match_individual(request.query, ind)
                if kind:
                    text_results.append(dict(ind, **TEXT_MATCH[kind]))

        # Now semantic matches. Embedding failures (e.g. an OpenAI outage) degrade to
        # exact matches only; the log names the error type, never the query.
        embedding_results = []
        try:
            result = supabase.table("individual_embeddings").select("*, individuals(*)").execute()
            # Rows from another embedding model (another vector size) can't be compared
            # with the query and would make the whole comparison fail: skip them (C-34)
            rows = [r for r in (result.data or [])
                    if r.get('individuals') and isinstance(r.get('embedding_data'), list)
                    and len(r['embedding_data']) == embedding_service.dimensions]
            if rows:
                search_results = await embedding_service.semantic_search(
                    request.query,
                    [(r['individual_id'], r['embedding_data']) for r in rows],
                    request.top_k,
                    request.similarity_threshold
                )
                by_id = {r['individual_id']: r['individuals'] for r in rows}
                for search_result in search_results:
                    individual_data = by_id.get(search_result['individual_id'])
                    if individual_data:
                        embedding_results.append({
                            **individual_data,
                            "id": search_result['individual_id'],
                            "similarity_score": search_result['similarity_score'],
                            "search_type": "semantic"
                        })
        except Exception as e:
            logger.warning("Embedding search failed: %s", type(e).__name__)
            embedding_results = []

        # Combine and deduplicate: a text match wins over a semantic hit for the same person
        candidates = text_results + embedding_results
        seen_ids = set()
        unique = []
        for r in candidates:
            if r['id'] not in seen_ids:
                seen_ids.add(r['id'])
                unique.append(r)

        # last_seen / address come from ONE interactions query for all results
        latest = fetch_last_seen(supabase, [r['id'] for r in unique])
        abbreviate = IndividualService(supabase).abbreviate_address
        all_results = []
        for r in unique:
            seen = latest.get(r['id'])
            location = (seen or {}).get("location") or r.get("last_location")
            address = (location or {}).get("address")
            all_results.append({
                "id": r['id'],
                "name": r.get('name'),
                "urgency_score": r.get('urgency_score'),
                "urgency_override": r.get('urgency_override'),
                "display_score": get_display_urgency_score(r),
                "last_seen": seen["last_seen"] if seen else r.get('created_at'),
                "abbreviated_address": abbreviate(address) if address else None,
                "data": r.get('data') or {},
                "search_type": r['search_type'],
                "similarity_score": r['similarity_score'],
            })

        # Tiers: name match, then value match, then semantic (by cosine score)
        all_results.sort(key=lambda x: (TIER_OF[x['search_type']], -x['similarity_score']))

        return {
            "results": all_results,
            "query": request.query,
            "total_results": len(all_results),
            "normal_results": len([r for r in all_results if r['search_type'] != 'semantic']),
            "semantic_results": len([r for r in all_results if r['search_type'] == 'semantic']),
            "similarity_threshold": request.similarity_threshold
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Search", e)


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
        supabase = get_supabase_client()
        
        # Get all individuals
        result = supabase.table("individuals").select("*").execute()
        
        if not result.data:
            return {"message": "No individuals found in database"}
        
        individuals = result.data
        categories = supabase.table("categories").select("*").order("created_at").execute().data or []

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
async def get_embedding_status(user_id: str = Depends(get_current_user)):
    """
    Get status of embeddings in the database
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
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
