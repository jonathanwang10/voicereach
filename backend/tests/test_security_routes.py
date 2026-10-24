"""Route registry: removed routes stay removed, and every API route needs a token."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.helpers import all_route_paths

SAMPLE_ID = "550e8400-e29b-41d4-a716-446655440001"
# The only HTTP routes that answer without a token
PUBLIC = {"/health"}


def _paths():
    return set(all_route_paths(app))


def _http_routes():
    """(method, path) for every HTTP route, path parameters filled with a sample UUID."""
    out = []
    for r in app.routes:
        routes = r.original_router.routes if hasattr(r, "original_router") else [r]
        prefix = r.include_context.prefix if hasattr(r, "original_router") else ""
        for x in routes:
            for method in sorted(getattr(x, "methods", None) or []):
                if method != "HEAD":
                    out.append((method, (prefix + x.path).replace("{individual_id}", SAMPLE_ID)))
    return out


PROTECTED = [(m, p) for m, p in _http_routes() if p not in PUBLIC]


def test_api_key_route_removed():
    assert "/api/voice-assistant/api-key" not in _paths()


def test_debug_routes_removed():
    p = _paths()
    for gone in ["/test-ws", "/api/voice-assistant/test", "/api/voice-assistant/chat",
                 "/api/voice-assistant/resources", "/api/voice-assistant/context",
                 "/api/voice-assistant/transcribe"]:
        assert gone not in p


def test_kept_assistant_routes_present():
    p = _paths()
    for kept in ["/api/voice-assistant/guidelines", "/api/voice-assistant/realtime/ws"]:
        assert kept in p


def test_public_routes_are_exactly_the_expected_ones():
    """A new route is protected unless it is added to PUBLIC on purpose."""
    assert {p for _, p in _http_routes()} & PUBLIC == PUBLIC
    assert len(PROTECTED) >= 16  # guards the route walk itself (it once missed included routers)


@pytest.mark.real_auth
@pytest.mark.parametrize("method,path", PROTECTED, ids=[f"{m} {p}" for m, p in PROTECTED])
def test_every_api_route_is_401_without_a_token(method, path):
    """Exactly 401: a 422 here would mean the body was validated before auth ran, i.e. no auth."""
    kwargs = {"json": {}} if method in ("POST", "PUT") else {}
    response = TestClient(app).request(method, path, **kwargs)
    assert response.status_code == 401, (method, path, response.text)
    assert response.json() == {"detail": "Missing bearer token"}


@pytest.mark.real_auth
@pytest.mark.parametrize("path", sorted(PUBLIC))
def test_public_routes_answer_without_a_token(path):
    assert TestClient(app).get(path).status_code == 200


def test_ssrf_guard_rejects_lookalike_host():
    from services.openai_service import OpenAIService
    svc = OpenAIService.__new__(OpenAIService)
    with pytest.raises(ValueError):
        asyncio.run(svc.transcribe_audio("https://supabase.evil.com/x.m4a"))


from main import api_docs_urls  # noqa: E402

def test_api_docs_urls_only_with_enable_api_docs_1():
    off = {"docs_url": None, "redoc_url": None, "openapi_url": None}
    assert api_docs_urls(None) == off and api_docs_urls("0") == off and api_docs_urls("true") == off
    assert api_docs_urls("1") == {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}

@pytest.mark.real_auth
@pytest.mark.parametrize("path", ["/", "/docs", "/redoc", "/openapi.json"])
def test_docs_and_root_are_404_by_default(path):
    assert TestClient(app).get(path).status_code == 404
