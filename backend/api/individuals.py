"""
Individual management API endpoints
"""
import logging
from fastapi import APIRouter, HTTPException, Depends, status, Query, BackgroundTasks, Body
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from uuid import UUID
from typing import Any, Dict, Optional
from api.auth import get_current_user
from api.errors import internal_error
from db.client import get_supabase, run_db
from db.models import (
    SaveIndividualRequest,
    SaveIndividualResponse,
    SearchIndividualsResponse,
    IndividualDetailResponse,
    UrgencyOverrideRequest,
    UrgencyOverrideResponse,
    InteractionsResponse,
    DeleteIndividualResponse
)
from services.duplicate_detection_service import DuplicateDetectionService
from services.individual_service import IndividualNotFound, IndividualService
from services.openai_service import get_openai_service
from services.validation_helper import validate_categorized_data
from services.context_service import invalidate_context_cache
from services.rate_limit import rate_limit


router = APIRouter()
logger = logging.getLogger(__name__)


def get_current_user_name(user_id: str = Depends(get_current_user)) -> str:
    """Get user display name - flexible for future enhancement"""
    # For MVP/demo, return fixed name
    # Future: Could parse from JWT claims or user profile
    return "Demo User"


async def generate_embedding_background(individual_id: str, individual_data: dict,
                                        categories: Optional[list] = None):
    """
    Background task: embed one saved individual (field_registry.build_embedding_text,
    the same text every embedding path uses) and store the vector with that text.

    Args:
        individual_id: ID of the individual
        individual_data: {"id", "name", "data"} of the saved individual
        categories: the category rows the save already fetched (fetched here if None)
    """
    try:
        from services.embedding_service import EmbeddingService

        supabase = get_supabase()
        if categories is None:
            categories = (await run_db(lambda: supabase.table("categories").select("*")
                                       .order("created_at").execute())).data or []
        await EmbeddingService().store_individual_embedding(
            supabase, {**individual_data, "id": str(individual_id)}, categories)
    except Exception as e:
        # Id and error type only: no names, no upstream error text
        logger.warning("Background embedding failed for %s: %s", individual_id, type(e).__name__)


@router.post("", response_model=SaveIndividualResponse)
async def save_individual(
    request: SaveIndividualRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user),
    user_name: str = Depends(get_current_user_name)
):
    """
    Save new individual or update existing (merge).
    
    Flow:
    1. Validate merge_with_id exists (if provided)
    2. Fetch categories for validation
    3. Validate data using validation_helper
    4. Use individual_service to save
    5. Return individual and interaction records
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        # Initialize service
        service = IndividualService(supabase)
        
        # If merge_with_id provided, verify it exists first
        if request.merge_with_id:
            existing = await service.get_individual_by_id(request.merge_with_id)
            if not existing:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Individual not found: {request.merge_with_id}"
                )
        
        # Fetch categories for validation
        categories_response = await run_db(lambda: supabase.table("categories").select("*").order("created_at").execute())
        categories = categories_response.data
        
        # Validate the categorized data
        validation_result = validate_categorized_data(request.data, categories)
        
        # If validation fails, return error with details
        if not validation_result.is_valid:
            # Combine missing required and validation errors
            error_detail = []
            if validation_result.missing_required:
                error_detail.append("Missing required fields: " + ", ".join(validation_result.missing_required))
            if validation_result.validation_errors:
                for error in validation_result.validation_errors:
                    error_detail.append(f"{error['field']}: {error['message']}")
            
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=". ".join(error_detail)
            )
        
        # Save the normalised data (types coerced, empty values dropped)
        result = await service.save_individual(
            user_id=user_id,
            user_name=user_name,
            data=validation_result.normalized_data,
            merge_with_id=request.merge_with_id,
            location=request.location,
            transcription=request.transcription,
            audio_url=request.audio_url
        )
        
        invalidate_context_cache()

        # Add background task to generate embedding
        background_tasks.add_task(
            generate_embedding_background,
            result.individual.id,
            {
                "id": result.individual.id,
                "name": result.individual.name,
                "data": result.individual.data
            },
            categories,
        )
        
        return result
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except IndividualNotFound:
        # The merge target was deleted after the existence check above
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Individual not found: {request.merge_with_id}"
        )
    except ValidationError as e:
        # A pydantic ValidationError is a ValueError, but here it means a bad stored
        # row: a 500 that echoes nothing, not a 400 with the row's values (H2-1.4)
        raise internal_error("Save individual", e)
    except ValueError as e:
        # Handle validation errors from service
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise internal_error("Save individual", e)


@router.get("", response_model=SearchIndividualsResponse)
async def search_individuals(
    search: Optional[str] = Query(None, description="Search term for name and data fields"),
    limit: int = Query(20, ge=1, le=100, description="Maximum results per page"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    sort_by: str = Query("last_seen", pattern="^(last_seen|urgency_score|name)$", description="Sort field"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$", description="Sort order"),
    user_id: str = Depends(get_current_user)
):
    """
    Search and list individuals.
    
    Features:
    - Search across name and all JSONB data fields
    - Pagination with limit/offset
    - Sorting by last_seen (default), urgency_score, or name
    - Returns abbreviated addresses for display
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        # Initialize service
        service = IndividualService(supabase)
        
        # Perform search
        result = await service.search_individuals(
            search=search,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_order=sort_order
        )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Search individuals", e)


@router.get("/{individual_id}", response_model=IndividualDetailResponse)
async def get_individual(
    individual_id: UUID,
    user_id: str = Depends(get_current_user)
):
    """
    Get individual details with recent interactions.
    
    Returns:
    - Full individual data with all fields
    - Last 10 interactions (summary only)
    - Calculated display danger score
    - 404 if individual not found
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        # Initialize service
        service = IndividualService(supabase)
        
        # Get individual details
        result = await service.get_individual_by_id(individual_id)
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Individual not found: {individual_id}"
            )
        
        return result
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise internal_error("Get individual", e)


@router.put("/{individual_id}/urgency-override", response_model=UrgencyOverrideResponse)
async def update_urgency_override(
    individual_id: UUID,
    request: UrgencyOverrideRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Update manual urgency score override.

    Features:
    - Set urgency_override to provided value (0-100)
    - Pass null to remove override
    - Returns all urgency scores for UI update
    - 404 if individual not found
    """
    try:
        service = IndividualService(get_supabase())

        try:
            result = await service.update_urgency_override(
                individual_id, request.urgency_override
            )
        except IndividualNotFound:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Individual not found: {individual_id}"
            )

        invalidate_context_cache()
        return result

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise internal_error("Update urgency override", e)


@router.delete("/{individual_id}", response_model=DeleteIndividualResponse)
async def delete_individual(
    individual_id: UUID,
    user_id: str = Depends(get_current_user)
):
    """
    Delete an individual. FK cascades remove their interactions and embeddings;
    the voice-assistant context cache is invalidated so it stops serving them.
    404 if there is no such individual.
    """
    try:
        service = IndividualService(get_supabase())

        if not await service.delete_individual(individual_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Individual not found: {individual_id}"
            )

        invalidate_context_cache()
        return DeleteIndividualResponse(id=individual_id, deleted=True)

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Delete individual", e)


@router.get("/{individual_id}/interactions", response_model=InteractionsResponse)
async def get_interactions(
    individual_id: UUID,
    limit: int = Query(50, ge=1, le=100, description="Maximum interactions per page"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    user_id: str = Depends(get_current_user)
):
    """
    Get detailed interaction history for an individual.
    
    Features:
    - Returns all interaction records in chronological order (newest first)
    - Shows full addresses (not abbreviated)
    - Contains only fields that changed in each interaction
    - Includes transcription for voice entries
    - Supports pagination with limit/offset
    """
    try:
        service = IndividualService(get_supabase())
        return await service.get_interactions(individual_id, limit=limit, offset=offset)

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Get interactions", e)


@router.post("/check-duplicates")
async def check_duplicates(
    data: Dict[str, Any] = Body(..., description="The person's fields, e.g. {\"name\": \"Ann\", \"age\": 40}"),
    user_id: str = Depends(rate_limit(
        "duplicate_check", "RATE_LIMIT_DUPLICATE_CHECK_PER_MIN", 30)),
):
    """
    Check for potential duplicate individuals using sophisticated matching
    
    This endpoint uses the same duplicate detection logic as the transcription API
    but works with manually entered data. The body is a JSON object of fields, at
    most 20 KB (main.BodySizeLimitMiddleware answers 413 above that).
    """
    try:
        # Get Supabase client
        supabase = get_supabase()
        
        duplicate_service = DuplicateDetectionService(supabase, get_openai_service())
        
        # Find potential duplicates using the same logic as transcription
        potential_matches = await duplicate_service.find_duplicates(data)
        
        return JSONResponse(content={
            "potential_matches": potential_matches
        })
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Duplicate check", e)