"""
Audio transcription and categorization endpoints
"""
import os
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from supabase import create_client, Client

from api.auth import get_current_user
from services.openai_service import OpenAIService
from services.validation_helper import validate_categorized_data


router = APIRouter()


class TranscribeRequest(BaseModel):
    audio_url: Optional[str] = None
    audio_data: Optional[str] = None  # Base64 encoded audio data


class TranscribeResponse(BaseModel):
    transcription: str
    categorized_data: Dict[str, Any]
    missing_required: List[str]
    potential_matches: List[Dict[str, Any]]
    validation_errors: List[Dict[str, str]] = []


@router.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe_audio_endpoint(
    request: TranscribeRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Transcribe audio and extract categorized data
    
    Process:
    1. Fetch all categories from database
    2. Transcribe audio using Whisper
    3. Categorize transcription using GPT-4o
    4. Validate required fields
    5. Find potential duplicates
    6. Return complete results (no streaming)
    """
    try:
        # Initialize services
        openai_service = OpenAIService()
        supabase: Client = create_client(
            os.getenv("SUPABASE_URL"),
            os.getenv("SUPABASE_SERVICE_KEY")  # Use service key for full access
        )
        
        # 1. Fetch all categories from database
        categories_response = supabase.table("categories").select("*").order("created_at").execute()
        
        if not categories_response.data:
            raise HTTPException(
                status_code=500, 
                detail="No categories found in database. Please ensure categories are properly configured."
            )
        
        # Format categories for GPT-4o
        categories = []
        for cat in categories_response.data:
            category_data = {
                "name": cat["name"],
                "type": cat["type"],
                "is_required": cat["is_required"],
                "options": cat.get("options", None)
            }
            categories.append(category_data)
        
        print(f"Fetched {len(categories)} categories from database: {[cat['name'] for cat in categories]}")
        
        # 2. Transcribe audio
        if request.audio_data:
            # Handle base64 audio data
            import base64
            import tempfile
            
            # Decode base64 audio data
            audio_data = base64.b64decode(request.audio_data.split(',', 1)[-1])  # Strip optional data URL prefix
            
            # Create temporary file
            with tempfile.NamedTemporaryFile(delete=False, suffix='.m4a') as temp_file:
                temp_file.write(audio_data)
                temp_file_path = temp_file.name
            
            try:
                # Transcribe from temporary file
                transcription = await openai_service.transcribe_audio_file(temp_file_path)
            finally:
                # Clean up temporary file
                os.unlink(temp_file_path)
        elif request.audio_url:
            # Handle audio URL
            transcription = await openai_service.transcribe_audio(request.audio_url)
        else:
            raise HTTPException(status_code=400, detail="Either audio_url or audio_data must be provided")
        
        # 3. Categorize transcription
        categorized_data = await openai_service.categorize_transcription(transcription, categories)
        
        # 4. Validate categorized data
        validation_result = validate_categorized_data(categorized_data, categories)
        missing_required = validation_result.missing_required
        
        # 5. Find potential duplicates using real database search and LLM comparison
        potential_matches = []

        # Import and initialize duplicate detection service
        from services.duplicate_detection_service import DuplicateDetectionService

        duplicate_service = DuplicateDetectionService(supabase, openai_service)

        # Find potential duplicates
        try:
            potential_matches = await duplicate_service.find_duplicates(categorized_data)
        except Exception as e:
            # Log error but don't fail the request
            print(f"Duplicate detection error: {str(e)}")
            potential_matches = []
        
        # 6. Return complete results
        return TranscribeResponse(
            transcription=transcription,
            categorized_data=categorized_data,
            missing_required=missing_required,
            potential_matches=potential_matches,
            validation_errors=validation_result.validation_errors
        )
        
    except ValueError as e:
        # Handle validation errors from services
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Log error for debugging
        print(f"Transcription error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")