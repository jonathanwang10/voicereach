"""Per-user rate limits on the paid endpoints (C-12, R-4)."""
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from services import rate_limit as rl


def test_check_rate_limit_counts_per_bucket_and_key():
    assert rl.check_rate_limit("b", "u1", 2)
    assert rl.check_rate_limit("b", "u1", 2)
    assert not rl.check_rate_limit("b", "u1", 2)
    assert rl.check_rate_limit("b", "u2", 2)       # another user has their own window
    assert rl.check_rate_limit("other", "u1", 2)   # and so does another bucket


def test_window_resets(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(rl.time, "monotonic", lambda: now[0])
    assert rl.check_rate_limit("b", "u", 1)
    assert not rl.check_rate_limit("b", "u", 1)
    now[0] += 60.0
    assert rl.check_rate_limit("b", "u", 1)


def test_reset_rate_limits_empties_buckets():
    assert rl.check_rate_limit("b", "u", 1)
    rl.reset_rate_limits()
    assert rl.check_rate_limit("b", "u", 1)


def test_bad_env_value_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_X", "lots")
    assert rl.limit_from_env("RATE_LIMIT_X", 7) == 7
    monkeypatch.setenv("RATE_LIMIT_X", "0")
    assert rl.limit_from_env("RATE_LIMIT_X", 7) == 7
    monkeypatch.setenv("RATE_LIMIT_X", "3")
    assert rl.limit_from_env("RATE_LIMIT_X", 7) == 3


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _search_client():
    sb = MagicMock()
    sb.table.return_value.select.return_value.execute.return_value.data = []
    return sb


def test_route_returns_429_with_retry_after(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN", "2")
    with patch("api.embeddings.get_supabase_client", return_value=_search_client()):
        codes = [_client().post("/api/embeddings/search", json={"query": "x"}) for _ in range(3)]
    assert [r.status_code for r in codes] == [200, 200, 429]
    assert codes[2].json() == {"detail": "Too many requests. Try again in a minute."}
    assert 1 <= int(codes[2].headers["Retry-After"]) <= 60


def test_generate_all_defaults_to_one_per_minute():
    sb = MagicMock()
    sb.table.return_value.select.return_value.execute.return_value.data = []
    with patch("api.embeddings.get_supabase_client", return_value=sb):
        first = _client().post("/api/embeddings/generate-all")
        second = _client().post("/api/embeddings/generate-all")
    assert first.status_code == 200
    assert second.status_code == 429


def test_limits_are_per_user(monkeypatch):
    from api.auth import get_current_user
    monkeypatch.setenv("RATE_LIMIT_GENERATE_ALL_PER_MIN", "1")
    sb = MagicMock()
    sb.table.return_value.select.return_value.execute.return_value.data = []
    with patch("api.embeddings.get_supabase_client", return_value=sb):
        assert _client().post("/api/embeddings/generate-all").status_code == 200
        app.dependency_overrides[get_current_user] = lambda: "someone-else"
        assert _client().post("/api/embeddings/generate-all").status_code == 200


# Each paid route carries its own bucket: once the env limit is 1, the second call is 429,
# before any OpenAI or database work happens.
PAID_ROUTES = [
    ("RATE_LIMIT_TRANSCRIBE_PER_MIN", "post", "/api/transcribe", {"json": {}}),
    ("RATE_LIMIT_ASSISTANT_TRANSCRIBE_PER_MIN", "post", "/api/voice-assistant/transcribe",
     {"files": {"audio": ("a.m4a", b"x", "text/plain")}}),
    ("RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN", "post", "/api/embeddings/search", {"json": {"query": "x"}}),
    ("RATE_LIMIT_EMBEDDINGS_GENERATE_PER_MIN", "post", "/api/embeddings/generate",
     {"json": {"individual_id": "11111111-1111-1111-1111-111111111111"}}),
    ("RATE_LIMIT_GENERATE_ALL_PER_MIN", "post", "/api/embeddings/generate-all", {}),
    ("RATE_LIMIT_DUPLICATE_CHECK_PER_MIN", "post", "/api/individuals/check-duplicates", {"json": {"name": ""}}),
]


@pytest.mark.parametrize("env_var,method,path,kwargs", PAID_ROUTES)
def test_every_paid_route_is_rate_limited(env_var, method, path, kwargs, monkeypatch):
    monkeypatch.setenv(env_var, "1")
    with patch("api.embeddings.get_supabase_client", side_effect=RuntimeError("no db")), \
         patch("api.individuals.get_supabase_client", side_effect=RuntimeError("no db")), \
         patch("api.transcription.create_client", side_effect=RuntimeError("no db")):
        first = getattr(_client(), method)(path, **kwargs)
        second = getattr(_client(), method)(path, **kwargs)
    # the first call gets through to the route (which then fails on the missing database,
    # or on the non-audio upload); only the second is limited
    assert first.status_code == (400 if path == "/api/voice-assistant/transcribe" else 500)
    assert second.status_code == 429


def test_rate_limit_runs_after_auth():
    """An unauthenticated caller gets 401, not 429, and doesn't use anyone's quota."""
    from api.auth import get_current_user
    app.dependency_overrides.pop(get_current_user, None)
    r = _client().post("/api/embeddings/generate-all")
    assert r.status_code == 401
