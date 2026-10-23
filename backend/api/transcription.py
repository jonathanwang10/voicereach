"""
Audio transcription and categorization endpoints
"""
import asyncio
import base64
import logging
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from api.errors import internal_error
from db.client import get_supabase, run_db
from services.openai_service import AudioTooLarge, OpenAIService, temp_audio_file
from services.rate_limit import rate_limit
from services.validation_helper import validate_categorized_data

logger = logging.getLogger(__name__)


router = APIRouter()

# Answer before the app's 120 s transcribe timeout gives up: the chained OpenAI calls
# can take ~180 s in the worst case (see services/openai_service.py).
TRANSCRIBE_DEADLINE_SECONDS = 110
# The request body (base64 audio) is capped at 8 MB by main.BodySizeLimitMiddleware.


class TranscribeRequest(BaseModel):
    audio_url: Optional[str] = None
    audio_data: Optional[str] = None  # Base64 encoded audio data


class TranscribeResponse(BaseModel):
    transcription: str
    categorized_data: Dict[str, Any]
    missing_required: List[str]
    potential_matches: List[Dict[str, Any]]
    validation_errors: List[Dict[str, str]] = []
    # True when the duplicate check itself failed (e.g. the database was unreachable),
    # so an empty potential_matches means "unknown", not "no match" (C-08). The app
    # re-checks before saving.
    duplicate_check_failed: bool = False


@router.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe_audio_endpoint(
    request: TranscribeRequest,
    user_id: str = Depends(rate_limit("transcribe", "RATE_LIMIT_TRANSCRIBE_PER_MIN", 30)),
):
    """Transcribe and categorise, within TRANSCRIBE_DEADLINE_SECONDS (504 after that)."""
    try:
        return await asyncio.wait_for(_transcribe(request), TRANSCRIBE_DEADLINE_SECONDS)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Transcription took too long. Please try again.")


async def _transcribe(request: TranscribeRequest) -> TranscribeResponse:
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
        supabase = get_supabase()
        
        # 1. Fetch all categories from database
        categories_response = await run_db(lambda: supabase.table("categories").select("*").order("created_at").execute())
        
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
        
        # 2. Transcribe audio
        if request.audio_data:
            # Base64 audio (an optional data-URL prefix is stripped). The temp file is
            # removed on every path, including a failed write (C-65).
            audio_data = base64.b64decode(request.audio_data.split(',', 1)[-1])
            with temp_audio_file(audio_data) as temp_file_path:
                transcription = await openai_service.transcribe_audio_file(temp_file_path)
        elif request.audio_url:
            # Handle audio URL
            transcription = await openai_service.transcribe_audio(request.audio_url)
        else:
            raise HTTPException(status_code=400, detail="Either audio_url or audio_data must be provided")
        
        # 3. Categorize transcription
        categorized_data = await openai_service.categorize_transcription(transcription, categories)
        
        # 4. Normalise and validate categorized data. From here on only the
        # normalised dict is used (no None / "" values, canonical labels).
        validation_result = validate_categorized_data(categorized_data, categories)
        categorized_data = validation_result.normalized_data
        missing_required = validation_result.missing_required
        
        # 5. Find potential duplicates using real database search and LLM comparison
        potential_matches = []

        # Import and initialize duplicate detection service
        from services.duplicate_detection_service import DuplicateDetectionService

        duplicate_service = DuplicateDetectionService(supabase, openai_service)

        # Find potential duplicates. A failure doesn't fail the transcription (the
        # worker keeps the transcript), but it is reported, never shown as "no match".
        duplicate_check_failed = False
        try:
            potential_matches = await duplicate_service.find_duplicates(categorized_data)
        except Exception as e:
            logger.warning("Duplicate detection failed: %s", type(e).__name__)
            potential_matches = []
            duplicate_check_failed = True
        
        # 6. Return complete results
        return TranscribeResponse(
            transcription=transcription,
            categorized_data=categorized_data,
            missing_required=missing_required,
            potential_matches=potential_matches,
            validation_errors=validation_result.validation_errors,
            duplicate_check_failed=duplicate_check_failed,
        )
        
    except HTTPException:
        raise
    except AudioTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e))
    except ValueError as e:
        # Client-facing validation messages from the services ("File is not in M4A format",
        # "Audio must be at least 5 seconds long", bad base64)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise internal_error("Transcription", e)