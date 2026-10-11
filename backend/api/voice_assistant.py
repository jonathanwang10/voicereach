"""
Voice Assistant API endpoints for OpenAI Realtime API integration
"""
import logging
import os
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from api.auth import get_current_user
from api.errors import internal_error
from pydantic import BaseModel
from typing import Dict, Any, List
from supabase import create_client, Client
from services.openai_service import OpenAIService, temp_audio_file
from services.context_service import get_context_service
from services.rate_limit import rate_limit

logger = logging.getLogger(__name__)

# Assistant questions are short; anything bigger is refused with 413 (C-12).
# main.BodySizeLimitMiddleware also refuses a request body much over this.
MAX_ASSISTANT_AUDIO_BYTES = 3 * 1024 * 1024

router = APIRouter(prefix="/api/voice-assistant")

# Initialize Supabase client
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_SERVICE_KEY")
supabase: Client = create_client(supabase_url, supabase_key)

class ContextRequest(BaseModel):
    message: str

class ContextResponse(BaseModel):
    context: str
    individuals_found: List[Dict[str, Any]]
    names_detected: List[str]

@router.post("/transcribe")
async def transcribe_voice_audio(
    audio: UploadFile = File(...),
    user_id: str = Depends(rate_limit(
        "assistant_transcribe", "RATE_LIMIT_ASSISTANT_TRANSCRIBE_PER_MIN", 30)),
):
    """
    Transcribe audio file for voice assistant (max 3 MB, else 413)
    """
    try:
        # Validate file type
        if not audio.content_type or not audio.content_type.startswith('audio/'):
            raise HTTPException(status_code=400, detail="File must be an audio file")

        content = await audio.read(MAX_ASSISTANT_AUDIO_BYTES + 1)
        if len(content) > MAX_ASSISTANT_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio file is larger than 3 MB")

        # The temp file is removed on every path, including a failed write (C-65)
        with temp_audio_file(content) as temp_file_path:
            transcription = await OpenAIService().transcribe_audio_file(temp_file_path)

        return {
            "transcription": transcription,
            "status": "success"
        }

    except HTTPException:
        raise
    except ValueError as e:
        # Client-facing audio validation messages ("File is not in M4A format", ...)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise internal_error("Transcription", e)

@router.get("/guidelines")
async def get_safety_guidelines(user_id: str = Depends(get_current_user)):
    """
    Get safety guidelines and protocols
    """
    try:
        guidelines = {
            "crisis_intervention": [
                "Approach slowly and calmly",
                "Maintain a safe distance initially",
                "Use non-threatening body language",
                "Listen actively and validate their concerns",
                "Avoid judgmental language or tone"
            ],
            "medical_emergency": [
                "Call 911 immediately for life-threatening situations",
                "Assess consciousness and breathing",
                "Provide basic first aid if trained",
                "Stay with the person until help arrives",
                "Document the incident"
            ],
            "de_escalation": [
                "Stay calm and speak softly",
                "Give the person space",
                "Avoid direct eye contact if they seem agitated",
                "Use 'I' statements instead of 'you' statements",
                "Offer choices when possible"
            ],
            "safety_protocols": [
                "Never work alone in dangerous areas",
                "Carry a phone and emergency contacts",
                "Trust your instincts - if you feel unsafe, leave",
                "Report incidents to your supervisor",
                "Follow your organization's safety policies"
            ]
        }
        
        return guidelines
        
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Get guidelines", e)

@router.post("/context", response_model=ContextResponse)
async def get_context_for_message(
    request: ContextRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Get individual context for a message containing names

    This endpoint analyzes a user message, extracts potential names,
    searches the database for matching individuals, and returns
    formatted context information for the AI assistant.
    """
    try:
        context_service = get_context_service(supabase)

        # Get context for the message
        result = await context_service.get_context_for_message(request.message)

        # Counts only: never the question or the names (R-14)
        logger.info("Context lookup: %d name(s), %d individual(s)",
                    len(result["names_detected"]), len(result["individuals_found"]))

        return ContextResponse(
            context=result["context"],
            individuals_found=result["individuals_found"],
            names_detected=result["names_detected"]
        )

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Get context", e)

# WebSocket endpoint moved to main.py to avoid conflicts
