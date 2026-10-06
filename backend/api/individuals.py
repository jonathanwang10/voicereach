"""
Individual management API endpoints
"""
import os
from fastapi import APIRouter, HTTPException, Depends, status, Query, BackgroundTasks
from fastapi.responses import JSONResponse
from uuid import UUID
from typing import Optional
from datetime import datetime, timezone
from supabase import create_client, Client
from dotenv import load_dotenv

from api.auth import get_current_user
from db.models import (
    SaveIndividualRequest,
    SaveIndividualResponse,
    SearchIndividualsResponse,
    IndividualDetailResponse,
    UrgencyOverrideRequest,
    UrgencyOverrideResponse,
    InteractionsResponse
)
from services.individual_service import IndividualService
from services.validation_helper import validate_categorized_data


router = APIRouter()


def get_current_user_name(user_id: str = Depends(get_current_user)) -> str:
    """Get user display name - flexible for future enhancement"""
    # For MVP/demo, return fixed name
    # Future: Could parse from JWT claims or user profile
    return "Demo User"


def get_supabase_client() -> Client:
    """Get Supabase client with credentials from environment"""
    load_dotenv()
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")
    
    if not url or not key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Missing Supabase credentials"
        )
    
    return create_client(url, key)


async def generate_embedding_background(individual_id: str, individual_data: dict):
    """
    Background task to generate embedding for an individual
    
    Args:
        individual_id: ID of the individual
        individual_data: Individual data dictionary
    """
    try:
        from services.embedding_service import EmbeddingService
        
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Initialize embedding service
        embedding_service = EmbeddingService()
        
        # Generate embedding
        embedding = await embedding_service.generate_individual_embedding(individual_data)
        
        # Create text representation for storage
        text_parts = []
        if individual_data.get('name'):
            text_parts.append(f"Name: {individual_data['name']}")
        if individual_data.get('data'):
            data = individual_data['data']
            if isinstance(data, dict):
                for key, value in data.items():
                    if value and str(value).strip():
                        text_parts.append(f"{key}: {value}")
        
        embedding_text = " | ".join(text_parts)
        
        # Store embedding in database
        supabase.table("individual_embeddings").upsert({
            "individual_id": individual_id,
            "embedding_data": embedding,
            "embedding_text": embedding_text
        }, on_conflict="individual_id").execute()
        
        print(f"✅ Background task: Generated embedding for individual: {individual_data.get('name', 'Unknown')}")
        
    except Exception as e:
        print(f"❌ Background task: Failed to generate embedding for {individual_data.get('name', 'Unknown')}: {str(e)}")


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
        supabase = get_supabase_client()
        
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
        categories_response = supabase.table("categories").select("*").execute()
        categories = categories_response.data
        
        # Validate the categorized data
        validation_result = validate_categorized_data(request.data, categories)
        
        # If validation fails, return error with details
        if not validation_result.is_valid:
            # Combine missing required and validation errors
            error_detail = []
            if validation_result.missing_required:
                error_detail.append(f"Missing required fields: {validation_result.missing_required}")
            if validation_result.validation_errors:
                for error in validation_result.validation_errors:
                    error_detail.append(f"{error['field']}: {error['message']}")
            
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=". ".join(error_detail)
            )
        
        # Save individual using service
        result = await service.save_individual(
            user_id=user_id,
            user_name=user_name,
            data=request.data,
            merge_with_id=request.merge_with_id,
            location=request.location,
            transcription=request.transcription,
            audio_url=request.audio_url
        )
        
        # Add background task to generate embedding
        background_tasks.add_task(
            generate_embedding_background,
            result.individual.id,
            {
                "id": result.individual.id,
                "name": result.individual.name,
                "data": result.individual.data
            }
        )
        
        return result
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except ValueError as e:
        # Handle validation errors from service
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        # Log error for debugging
        print(f"Error saving individual: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save individual: {str(e)}"
        )


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
        supabase = get_supabase_client()
        
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
        
    except Exception as e:
        # Log error for debugging
        print(f"Error searching individuals: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to search individuals: {str(e)}"
        )


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
        supabase = get_supabase_client()
        
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
        # Log error for debugging
        print(f"Error getting individual {individual_id}: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get individual: {str(e)}"
        )


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
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Update the urgency_override field
        update_result = supabase.table("individuals").update({
            "urgency_override": request.urgency_override,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }).eq("id", str(individual_id)).execute()
        
        # Check if individual was found and updated
        if not update_result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Individual not found: {individual_id}"
            )
        
        # Get the updated individual data
        individual = update_result.data[0]
        
        # Calculate display score
        display_score = individual["urgency_override"] if individual["urgency_override"] is not None else individual["urgency_score"]
        
        return UrgencyOverrideResponse(
            urgency_score=individual["urgency_score"],
            urgency_override=individual["urgency_override"],
            display_score=display_score
        )
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        # Log error for debugging
        print(f"Error updating urgency override for {individual_id}: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update urgency override: {str(e)}"
        )


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
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Query interactions for this individual
        interactions_result = supabase.table("interactions").select("*").eq(
            "individual_id", str(individual_id)
        ).order(
            "created_at", desc=True
        ).limit(
            limit
        ).offset(
            offset
        ).execute()
        
        # Transform to response format
        interactions = []
        for interaction in interactions_result.data:
            interactions.append({
                "id": interaction["id"],
                "created_at": interaction["created_at"],
                "user_name": interaction["user_name"],
                "transcription": interaction.get("transcription"),
                "location": interaction.get("location"),
                "changes": interaction.get("changes", {})
            })
        
        return InteractionsResponse(interactions=interactions)
        
    except Exception as e:
        # Log error for debugging
        print(f"Error getting interactions for {individual_id}: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get interactions: {str(e)}"
        )


@router.post("/check-duplicates")
async def check_duplicates(
    data: dict,
    user_id: str = Depends(get_current_user)
):
    """
    Check for potential duplicate individuals using sophisticated matching
    
    This endpoint uses the same duplicate detection logic as the transcription API
    but works with manually entered data.
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Initialize duplicate detection service
        from services.duplicate_detection_service import DuplicateDetectionService
        from services.openai_service import OpenAIService
        
        openai_service = OpenAIService()
        duplicate_service = DuplicateDetectionService(supabase, openai_service)
        
        # Find potential duplicates using the same logic as transcription
        potential_matches = await duplicate_service.find_duplicates(data)
        
        return JSONResponse(content={
            "potential_matches": potential_matches
        })
        
    except Exception as e:
        print(f"Duplicate detection error: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"detail": f"Duplicate detection failed: {str(e)}"}
        )