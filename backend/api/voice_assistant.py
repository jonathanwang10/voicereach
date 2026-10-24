"""
Voice Assistant helper endpoints. The realtime WebSocket proxy itself is in main.py;
spoken questions stream over it (H2-5.6), so there is no upload route.
"""
import logging
from fastapi import APIRouter, HTTPException, Depends
from api.auth import get_current_user
from api.errors import internal_error

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice-assistant")

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

# WebSocket endpoint moved to main.py to avoid conflicts
