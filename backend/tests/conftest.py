"""Make every backend test importable offline, and give every test a clean process.

The Supabase client (db.client.get_supabase) is built lazily on first use, but
the OpenAI SDK and api/auth still read these env vars, so tests need *some*
values. These dummies point nowhere; anything that really calls out must mock
the client (patch the importing module's `get_supabase`). The one live test is
tests/integration/test_live_smoke.py, skipped unless its env vars are set.
"""
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_DUMMY_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.dummy-signature"
os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:9")
os.environ.setdefault("SUPABASE_ANON_KEY", _DUMMY_JWT)
os.environ.setdefault("SUPABASE_SERVICE_KEY", _DUMMY_JWT)
os.environ.setdefault("OPENAI_API_KEY", "sk-test-dummy")
# The recordings worker (H2-7.3) never starts under test unless a test turns it on
os.environ.setdefault("RECORDING_WORKER_ENABLED", "0")
# Forced, not setdefault: load_dotenv() never overrides a set variable, so a developer's
# backend/.env can't turn the API docs on under test (H2-1.6).
os.environ["ENABLE_API_DOCS"] = "0"


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _no_background_embeddings(request, monkeypatch):
    """POST /api/individuals schedules an OpenAI embedding call; never let tests make it."""
    if request.node.get_closest_marker("real_embedding_task"):
        return

    async def _noop(*args, **kwargs):
        return None

    import api.individuals as individuals_api
    monkeypatch.setattr(individuals_api, "generate_embedding_background", _noop)


@pytest.fixture(autouse=True)
def _no_query_embeddings(request, monkeypatch):
    """Search would embed the query through OpenAI; never let tests do that. By default
    every search is text-only (the query embedding "fails"), unless a test is marked
    real_query_embedding (and mocks OpenAI itself)."""
    if request.node.get_closest_marker("real_query_embedding"):
        return
    from services.embedding_service import EmbeddingService

    async def _disabled(self, query):
        raise RuntimeError("query embedding disabled in tests")

    monkeypatch.setattr(EmbeddingService, "embed_query", _disabled)


@pytest.fixture(autouse=True)
def _reset_process_state():
    """Reset every piece of process-global state before AND after each test.

    - rate-limit windows (services.rate_limit)
    - the verified-token cache and the Supabase Auth client (api.auth._cache, _auth_client)
    - the shared service-key Supabase client (db.client._client) and OpenAIService
      (services.openai_service._service)
    - app.dependency_overrides: restored to exactly what it was, so a test that
      installs an override (or pops the fake user) can't leak it into the next one
    """
    from main import app
    from api import auth
    from db import client as db_client
    from services import openai_service
    from services import embedding_service
    from services.rate_limit import reset_rate_limits

    def reset():
        reset_rate_limits()
        auth._cache.clear()
        auth._auth_client = None
        db_client._client = None
        openai_service._service = None
        embedding_service._service = None
        embedding_service.clear_query_cache()

    overrides = dict(app.dependency_overrides)
    reset()
    yield
    reset()
    app.dependency_overrides.clear()
    app.dependency_overrides.update(overrides)


@pytest.fixture(autouse=True)
def _fake_auth(request, _reset_process_state):
    """Authenticate every test as "test-user-123", unless it is marked real_auth.

    Modules don't install auth overrides of their own. A test may change one mid-test
    (e.g. to act as a second user); _reset_process_state puts it back afterwards.
    """
    from main import app
    from api.auth import get_current_user
    if request.node.get_closest_marker("real_auth"):
        app.dependency_overrides.pop(get_current_user, None)
        yield
        return
    app.dependency_overrides[get_current_user] = lambda: "test-user-123"
    yield
