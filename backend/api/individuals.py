"""
Individual management API endpoints
"""
import logging
from fastapi import APIRouter, HTTPException, Depends, status, Query, BackgroundTasks, Body, Header
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from uuid import UUID
from typing import Any, Dict, Optional
from api.auth import get_current_user
from api.device import get_device_id
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
from services.embedding_service import get_embedding_service
from services.individual_service import (IndividualNotFound, IndividualService, VERSION_CONFLICT_DETAIL,
                                         VersionConflictError)
from services.openai_service import get_openai_service
from services.validation_helper import validate_categorized_data
from services.context_service import invalidate_context_cache
from services import model_config
from services.audit import record_audit
from services.duplicate_decisions import record_duplicate_decision
from services.rate_limit import rate_limit


router = APIRouter()
logger = logging.getLogger(__name__)


def get_current_user_name(user_id: str = Depends(get_current_user)) -> str:
    """Get user display name - flexible for future enhancement"""
    # For MVP/demo, return fixed name
    # Future: Could parse from JWT claims or user profile
    return "Demo User"


async def generate_embedding_background(individual_id: str, individual_data: dict,
                                        categories: Optional[list] = None,
                                        interaction: Optional[dict] = None):
    """
    Background task: embed one saved individual (field_registry.build_embedding_text,
    the same text every embedding path uses) and, when the visit had a transcript,
    that visit (H2-4.3). The two are separate, so one failing doesn't skip the other.

    Args:
        individual_id: ID of the individual
        individual_data: {"id", "name", "data", "updated_at"} of the saved individual
        categories: the category rows the save already fetched (fetched here if None)
        interaction: {"id", "individual_id", "transcription"} of the visit, or None
    """
    service = get_embedding_service()
    supabase = None
    try:
        supabase = get_supabase()
        if categories is None:
            categories = (await run_db(lambda: supabase.table("categories").select("*")
                                       .order("created_at").execute())).data or []
        await service.store_individual_embedding(supabase, {**individual_data, "id": str(individual_id)}, categories)
    except Exception as e:
        # Id and error type only: no names, no upstream error text
        logger.warning("Background embedding failed for %s: %s", individual_id, type(e).__name__)
    if interaction:
        try:
            await service.store_interaction_embedding(supabase or get_supabase(), interaction)
        except Exception as e:
            logger.warning("Background visit embedding failed for %s: %s", interaction.get("id"), type(e).__name__)


@router.post("", response_model=SaveIndividualResponse)
async def save_individual(
    request: SaveIndividualRequest,
    background_tasks: BackgroundTasks,
    # Each save starts a paid embedding call (H2-1.7)
    user_id: str = Depends(rate_limit("save", "RATE_LIMIT_SAVE_PER_MIN", 30)),
    user_name: str = Depends(get_current_user_name),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    device_id: Optional[str] = Depends(get_device_id),
):
    """
    Save a new individual or merge into an existing one (one save_individual
    transaction, H2-2.2).

    - `Idempotency-Key` (a UUID, optional): a retry with the same key returns the
      first save's result (`replayed: true`) and writes nothing (H2-2.4). Anything
      that isn't a UUID is a 400 before any database call.
    - A merge sends the `expected_version` it loaded; a stale one is a 409 with
      VERSION_CONFLICT_DETAIL (H2-2.3). A missing target is a 404.
    - Data is validated against the categories (400 with field details); only the
      normalised data is stored.
    - A replayed save schedules no embedding.
    """
    request_id = None
    if idempotency_key is not None:
        try:
            request_id = UUID(idempotency_key)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Idempotency-Key must be a UUID")
    try:
        supabase = get_supabase()
        service = IndividualService(supabase)

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
            audio_url=request.audio_url,
            expected_version=request.expected_version,
            client_request_id=request_id,
        )

        invalidate_context_cache()

        decision = request.duplicate_decision
        if decision is not None:
            # A label for the duplicate eval; the Idempotency-Key keeps it to one per save (H2-3.6)
            background_tasks.add_task(
                record_duplicate_decision, supabase, candidate_id=str(result.individual.id),
                matched_id=str(decision.matched_id), confidence=decision.confidence,
                decision=decision.decision, model=model_config.DUPLICATE_MODEL,
                client_request_id=str(request_id) if request_id else None)

        if not result.replayed:
            # Ids only: never the name or fields (H2-2.7)
            await run_db(lambda: record_audit(
                supabase, user_id=user_id, device_id=device_id,
                action="merge_individual" if request.merge_with_id else "create_individual",
                entity_type="individual", entity_id=str(result.individual.id),
                detail={"interaction_id": str(result.interaction.id)}))
            background_tasks.add_task(
                generate_embedding_background,
                result.individual.id,
                {
                    "id": result.individual.id,
                    "name": result.individual.name,
                    "data": result.individual.data,
                    "updated_at": result.individual.updated_at.isoformat(),   # source_updated_at (H2-4.1)
                },
                categories,
                interaction=({"id": str(result.interaction.id), "individual_id": str(result.individual.id),
                              "transcription": request.transcription}
                             if request.transcription and request.transcription.strip() else None),
            )

        return result

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except VersionConflictError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=VERSION_CONFLICT_DETAIL)
    except IndividualNotFound:
        # The merge target doesn't exist, or was deleted mid-save
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
    user_id: str = Depends(get_current_user),
    device_id: Optional[str] = Depends(get_device_id),
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

        await run_db(lambda: record_audit(supabase, user_id=user_id, device_id=device_id, action="view_profile",
                                          entity_type="individual", entity_id=str(individual_id)))
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
    user_id: str = Depends(get_current_user),
    device_id: Optional[str] = Depends(get_device_id),
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
        supabase = get_supabase()
        service = IndividualService(supabase)

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
        await run_db(lambda: record_audit(
            supabase, user_id=user_id, device_id=device_id, action="override_urgency",
            entity_type="individual", entity_id=str(individual_id),
            detail={"urgency_override": request.urgency_override}))
        return result

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        raise internal_error("Update urgency override", e)


@router.delete("/{individual_id}", response_model=DeleteIndividualResponse)
async def delete_individual(
    individual_id: UUID,
    user_id: str = Depends(rate_limit("delete", "RATE_LIMIT_DELETE_PER_MIN", 30)),
    device_id: Optional[str] = Depends(get_device_id),
):
    """
    Delete an individual. FK cascades remove their interactions and embeddings;
    the voice-assistant context cache is invalidated so it stops serving them.
    404 if there is no such individual.
    """
    try:
        supabase = get_supabase()
        service = IndividualService(supabase)

        if not await service.delete_individual(individual_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Individual not found: {individual_id}"
            )

        invalidate_context_cache()
        await run_db(lambda: record_audit(supabase, user_id=user_id, device_id=device_id, action="delete_individual",
                                          entity_type="individual", entity_id=str(individual_id)))
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
        # The categories say which fields are sensitive (kept out of the prompt, H2-3.8)
        categories = (await run_db(lambda: supabase.table("categories").select("*").execute())).data or []

        # Find potential duplicates using the same logic as transcription
        potential_matches = await duplicate_service.find_duplicates(data, categories=categories)
        
        return JSONResponse(content={
            "potential_matches": potential_matches
        })
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Duplicate check", e)