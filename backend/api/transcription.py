"""
Audio transcription and categorization endpoints
"""
import asyncio
import base64
import logging
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, ValidationError
from typing import Optional

from api.errors import internal_error
from db.client import get_supabase
from db.models import TranscribeResponse  # noqa: F401 (also importable from here)
from services.openai_service import AudioTooLarge, get_openai_service, temp_audio_file
from services.rate_limit import rate_limit
from services.recording_pipeline import (NoCategories, build_transcribe_response, duplicate_stage, extract_stage,
                                         load_categories, transcribe_stage)

logger = logging.getLogger(__name__)


router = APIRouter()

# Answer before the app's 120 s transcribe timeout gives up: the chained OpenAI calls
# can take ~180 s in the worst case (see services/openai_service.py).
TRANSCRIBE_DEADLINE_SECONDS = 110
# The request body (base64 audio) is capped at 8 MB by main.BodySizeLimitMiddleware.


class TranscribeRequest(BaseModel):
    audio_url: Optional[str] = None
    audio_data: Optional[str] = None  # Base64 encoded audio data


# Deprecated (H2-7.5): the app uses POST /api/recordings; kept for one release.
@router.post("/api/transcribe", response_model=TranscribeResponse, deprecated=True)
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
    Transcribe audio and extract categorized data: categories, transcription,
    extraction and validation, duplicate check (services/recording_pipeline.py).
    """
    try:
        openai_service = get_openai_service()
        supabase = get_supabase()

        # 1. Categories (the stages are shared with the recordings worker, H2-7.3)
        try:
            categories = await load_categories(supabase)
        except NoCategories as e:
            raise HTTPException(status_code=500, detail=str(e))

        # 2. Transcribe audio
        if request.audio_data:
            # Base64 audio (an optional data-URL prefix is stripped). The temp file is
            # removed on every path, including a failed write (C-65).
            audio_data = base64.b64decode(request.audio_data.split(',', 1)[-1])
            with temp_audio_file(audio_data) as temp_file_path:
                transcription = await transcribe_stage(temp_file_path, openai_service)
        elif request.audio_url:
            transcription = await openai_service.transcribe_audio(request.audio_url)
        else:
            raise HTTPException(status_code=400, detail="Either audio_url or audio_data must be provided")

        # 3-4. Categorize, normalise and validate
        validation = await extract_stage(transcription, categories, openai_service)

        # 5. Potential duplicates; a failed check is reported, never shown as "no match"
        matches, duplicate_check_failed = await duplicate_stage(
            validation.normalized_data, supabase, openai_service, categories=categories)

        # 6. Return complete results
        return build_transcribe_response(transcription, validation, matches, duplicate_check_failed)

    except HTTPException:
        raise
    except AudioTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e))
    except ValidationError as e:
        # A ValueError subclass, but it means bad data from the database or a service:
        # a 500 that echoes nothing (H2-1.4)
        raise internal_error("Transcription", e)
    except ValueError as e:
        # Client-facing validation messages from the services ("File is not in M4A format",
        # "Audio must be at least 5 seconds long", bad base64)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise internal_error("Transcription", e)