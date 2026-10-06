"""
Voice Assistant API endpoints for OpenAI Realtime API integration
"""
import os
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import tempfile
from supabase import create_client, Client
from services.openai_service import OpenAIService
from services.context_service import get_context_service

router = APIRouter(prefix="/api/voice-assistant")
security = HTTPBearer()

# Initialize Supabase client
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_ANON_KEY")
supabase: Client = create_client(supabase_url, supabase_key)

class VoiceAssistantRequest(BaseModel):
    message: str
    context: Optional[Dict[str, Any]] = None

class VoiceAssistantResponse(BaseModel):
    response: str
    suggestions: Optional[list] = None

class ContextRequest(BaseModel):
    message: str

class ContextResponse(BaseModel):
    context: str
    individuals_found: List[Dict[str, Any]]
    names_detected: List[str]

@router.post("/transcribe")
async def transcribe_voice_audio(
    audio: UploadFile = File(...),
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """
    Transcribe audio file for voice assistant
    """
    try:
        print(f"🎤 Received audio file: {audio.filename}, type: {audio.content_type}")
        
        # Validate file type
        if not audio.content_type or not audio.content_type.startswith('audio/'):
            raise HTTPException(status_code=400, detail="File must be an audio file")
        
        # Save uploaded file to temporary location
        with tempfile.NamedTemporaryFile(delete=False, suffix='.m4a') as temp_file:
            content = await audio.read()
            temp_file.write(content)
            temp_file_path = temp_file.name
        
        try:
            # Initialize OpenAI service
            openai_service = OpenAIService()
            
            # Transcribe the audio file
            print(f"🎤 Transcribing audio file: {temp_file_path}")
            transcription = await openai_service.transcribe_audio_file(temp_file_path)
            
            print(f"✅ Transcription successful: {transcription[:100]}...")
            
            return {
                "transcription": transcription,
                "status": "success"
            }
            
        finally:
            # Clean up temporary file
            if os.path.exists(temp_file_path):
                os.unlink(temp_file_path)
                
    except Exception as e:
        print(f"❌ Transcription error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@router.get("/guidelines")
async def get_safety_guidelines(credentials: HTTPAuthorizationCredentials = Depends(security)):
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
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get guidelines: {str(e)}")

@router.post("/context", response_model=ContextResponse)
async def get_context_for_message(
    request: ContextRequest,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """
    Get individual context for a message containing names

    This endpoint analyzes a user message, extracts potential names,
    searches the database for matching individuals, and returns
    formatted context information for the AI assistant.
    """
    try:
        print(f"🔍 Getting context for message: {request.message}")

        context_service = get_context_service(supabase)

        # Get context for the message
        result = await context_service.get_context_for_message(request.message)

        print(f"📊 Found {len(result['individuals_found'])} individuals")
        print(f"🏷️ Detected names: {result['names_detected']}")

        return ContextResponse(
            context=result["context"],
            individuals_found=result["individuals_found"],
            names_detected=result["names_detected"]
        )

    except Exception as e:
        print(f"❌ Error getting context: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get context: {str(e)}")

# WebSocket endpoint moved to main.py to avoid conflicts
