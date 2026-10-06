"""Make every backend test importable offline.

backend/main.py and api/embeddings.py create Supabase/OpenAI clients at import
time, so tests need *some* values. These dummies point nowhere; anything that
really calls out must mock the client or live under tests/integration/.
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


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _no_background_embeddings(request, monkeypatch):
    """POST /api/individuals schedules an OpenAI embedding call; never let tests make it."""
    if request.node.get_closest_marker("real_embedding_task"):
        return

    async def _noop(*args, **kwargs):
        return None

    try:
        import api.individuals as individuals_api
    except Exception:
        return
    monkeypatch.setattr(individuals_api, "generate_embedding_background", _noop)


@pytest.fixture(autouse=True)
def _fake_auth(request):
    """Authenticate every test as a fake user, unless it is marked real_auth.

    Several test modules also set and clear app.dependency_overrides themselves
    at import/teardown time, which made results depend on file order.
    """
    if request.node.get_closest_marker("real_auth"):
        yield
        return
    try:
        from main import app
        from api.auth import get_current_user
    except Exception:
        yield
        return
    app.dependency_overrides[get_current_user] = lambda: "test-user-123"
    yield
    app.dependency_overrides.pop(get_current_user, None)
