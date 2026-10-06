import asyncio

import pytest

from main import app


def _paths():
    return {getattr(r, "path", "") for r in app.routes}


def test_api_key_route_removed():
    assert "/api/voice-assistant/api-key" not in _paths()


def test_debug_routes_removed():
    p = _paths()
    for gone in ["/test-ws", "/api/voice-assistant/test", "/api/voice-assistant/chat",
                 "/api/voice-assistant/resources"]:
        assert gone not in p


def test_kept_assistant_routes_present():
    p = _paths()
    for kept in ["/api/voice-assistant/context", "/api/voice-assistant/guidelines",
                 "/api/voice-assistant/transcribe", "/api/voice-assistant/realtime/ws"]:
        assert kept in p


def test_ssrf_guard_rejects_lookalike_host():
    from services.openai_service import OpenAIService
    svc = OpenAIService.__new__(OpenAIService)
    with pytest.raises(ValueError):
        asyncio.run(svc.transcribe_audio("https://supabase.evil.com/x.m4a"))
