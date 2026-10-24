"""conftest resets process-global state around every test (C-49). The first test dirties
everything; the second, which runs after it in file order, must see none of it."""
from main import app
from api import auth
from api.auth import get_current_user
from services import rate_limit

SENTINEL = object()


def test_1_dirty_every_global():
    auth._cache["tok"] = ("u", "e@x.org", 1e18)
    auth._auth_client = SENTINEL
    rate_limit.check_rate_limit("bucket", "user", 1)
    app.dependency_overrides[get_current_user] = lambda: "someone-else"
    app.dependency_overrides[SENTINEL] = lambda: None


def test_2_starts_clean():
    assert auth._cache == {}
    assert auth._auth_client is None
    assert rate_limit.check_rate_limit("bucket", "user", 1) is True  # a fresh window
    assert SENTINEL not in app.dependency_overrides
    assert app.dependency_overrides[get_current_user]() == "test-user-123"
