import asyncio

import pytest

from main import app


def _all_paths(application):
    """Flat list of every route path, including routers mounted via include_router
    (newer FastAPI keeps them as _IncludedRouter objects instead of flattening)."""
    out = []
    for r in application.routes:
        if hasattr(r, "original_router"):
            prefix = r.include_context.prefix
            out += [prefix + x.path for x in r.original_router.routes]
        else:
            out.append(getattr(r, "path", ""))
    return out


def _paths():
    return set(_all_paths(app))


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
