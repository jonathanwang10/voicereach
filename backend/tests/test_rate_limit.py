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
    from tests.helpers import FakeSupabase
    return FakeSupabase().on_rpc("search_individuals_hybrid", data=[])


def test_route_returns_429_with_retry_after(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN", "2")
    with patch("api.embeddings.get_supabase", return_value=_search_client()):
        codes = [_client().post("/api/embeddings/search", json={"query": "x"}) for _ in range(3)]
    assert [r.status_code for r in codes] == [200, 200, 429]
    assert codes[2].json() == {"detail": "Too many requests. Try again in a minute."}
    assert 1 <= int(codes[2].headers["Retry-After"]) <= 60


def test_generate_all_defaults_to_one_per_minute():
    sb = MagicMock()
    q = sb.table.return_value
    for method in ("select", "order", "range", "in_"):
        getattr(q, method).return_value = q
    q.execute.return_value.data = []
    with patch("api.embeddings.get_supabase", return_value=sb):
        first = _client().post("/api/embeddings/generate-all")
        second = _client().post("/api/embeddings/generate-all")
    assert first.status_code == 200
    assert second.status_code == 429


def test_limits_are_per_user(monkeypatch):
    from api.auth import get_current_user
    monkeypatch.setenv("RATE_LIMIT_GENERATE_ALL_PER_MIN", "1")
    sb = MagicMock()
    q = sb.table.return_value
    for method in ("select", "order", "range", "in_"):
        getattr(q, method).return_value = q
    q.execute.return_value.data = []
    with patch("api.embeddings.get_supabase", return_value=sb):
        assert _client().post("/api/embeddings/generate-all").status_code == 200
        app.dependency_overrides[get_current_user] = lambda: "someone-else"
        assert _client().post("/api/embeddings/generate-all").status_code == 200


# Each paid route carries its own bucket: once the env limit is 1, the second call is 429,
# before any OpenAI or database work happens.
PAID_ROUTES = [
    ("RATE_LIMIT_TRANSCRIBE_PER_MIN", "post", "/api/transcribe", {"json": {}}),
    ("RATE_LIMIT_EMBEDDINGS_SEARCH_PER_MIN", "post", "/api/embeddings/search", {"json": {"query": "x"}}),
    ("RATE_LIMIT_EMBEDDINGS_GENERATE_PER_MIN", "post", "/api/embeddings/generate",
     {"json": {"individual_id": "11111111-1111-1111-1111-111111111111"}}),
    ("RATE_LIMIT_GENERATE_ALL_PER_MIN", "post", "/api/embeddings/generate-all", {}),
    ("RATE_LIMIT_DUPLICATE_CHECK_PER_MIN", "post", "/api/individuals/check-duplicates", {"json": {"name": ""}}),
    ("RATE_LIMIT_SAVE_PER_MIN", "post", "/api/individuals", {"json": {"data": {"name": "Ann", "height": 70, "weight": 150}}}),
    ("RATE_LIMIT_CATEGORY_CREATE_PER_MIN", "post", "/api/categories", {"json": {"name": "Shoes", "type": "text"}}),
    ("RATE_LIMIT_DELETE_PER_MIN", "delete", "/api/individuals/11111111-1111-1111-1111-111111111111", {}),
]


@pytest.mark.parametrize("env_var,method,path,kwargs", PAID_ROUTES)
def test_every_paid_route_is_rate_limited(env_var, method, path, kwargs, monkeypatch):
    monkeypatch.setenv(env_var, "1")
    with patch("api.embeddings.get_supabase", side_effect=RuntimeError("no db")), \
         patch("api.individuals.get_supabase", side_effect=RuntimeError("no db")), \
         patch("api.transcription.get_supabase", side_effect=RuntimeError("no db")), \
         patch("api.categories.get_supabase", side_effect=RuntimeError("no db")):
        first = getattr(_client(), method)(path, **kwargs)
        second = getattr(_client(), method)(path, **kwargs)
    # the first call gets through to the route (which then fails on the missing database);
    # only the second is limited
    assert first.status_code == 500
    assert second.status_code == 429


def test_rate_limit_runs_after_auth():
    """An unauthenticated caller gets 401, not 429, and doesn't use anyone's quota."""
    from api.auth import get_current_user
    app.dependency_overrides.pop(get_current_user, None)
    r = _client().post("/api/embeddings/generate-all")
    assert r.status_code == 401


# --- per-device keys and per-process totals (H2-1.7) ---------------------------------------

from api.device import clean_device_id  # noqa: E402

UUID_ID = "3f2b8c1e-0d4a-4c1e-9a7b-2b1f0c9d8e7a"

@pytest.mark.parametrize("raw,expected", [(None, None), ("", None), ("short", None), ("x" * 65, None),
                                          ("bad id!!", None), (UUID_ID, UUID_ID), (f"  {UUID_ID} ", UUID_ID)])
def test_clean_device_id(raw, expected):
    assert clean_device_id(raw) == expected

def test_limit_key_and_total_env_var():
    assert rl.limit_key("u1", None) == "u1" and rl.limit_key("u1", UUID_ID) == f"u1:{UUID_ID}"
    assert rl.total_env_var("RATE_LIMIT_SAVE_PER_MIN") == "RATE_LIMIT_SAVE_TOTAL_PER_MIN"

def test_each_device_has_its_own_budget_under_one_process_total(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_SAVE_PER_MIN", "1"); monkeypatch.setenv("RATE_LIMIT_SAVE_TOTAL_PER_MIN", "2")
    body = {"json": {"data": {"name": "Ann", "height": 70, "weight": 150}}}
    with patch("api.individuals.get_supabase", side_effect=RuntimeError("no db")):
        codes = [_client().post("/api/individuals", headers={"X-Device-Id": d}, **body).status_code
                 for d in ("device-aaaa", "device-aaaa", "device-bbbb", "device-cccc")]
    assert codes == [500, 429, 500, 429]

def test_total_defaults_to_five_times_the_per_device_limit(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_X_PER_MIN", "1")
    allowed = [rl.check_keyed_limit("x", "u", f"device-{i:04d}", "RATE_LIMIT_X_PER_MIN", 9) is None for i in range(6)]
    assert allowed == [True] * 5 + [False]


# --- realtime session slots (H2-1.7) ---------------------------------------------------

def test_session_slots_per_key_and_per_process():
    assert rl.acquire_session("a", 2, 3) and rl.acquire_session("a", 2, 3)
    assert not rl.acquire_session("a", 2, 3)                 # per key
    assert rl.acquire_session("b", 2, 3)
    assert not rl.acquire_session("c", 2, 3)                 # per process
    rl.release_session("a")
    assert rl.acquire_session("c", 2, 3)
    assert (rl.active_sessions(), rl.active_sessions("a")) == (3, 1)

def test_release_never_goes_below_zero():
    rl.release_session("nobody")
    assert rl.active_sessions("nobody") == 0 and rl.active_sessions() == 0
