from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from main import app

pytestmark = pytest.mark.real_auth


def _auth_client(user_id=None, raises=False, email="worker@example.org"):
    client = MagicMock()
    if raises:
        client.auth.get_user.side_effect = Exception("invalid JWT")
    else:
        client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id=user_id, email=email))
    return client


@pytest.fixture(autouse=True)
def _no_allowlist(monkeypatch):
    # The token cache and auth client are reset around every test by conftest
    monkeypatch.delenv("ALLOWED_USER_EMAILS", raising=False)


def test_missing_token_is_rejected():
    assert TestClient(app).get("/api/categories").status_code == 401


def test_invalid_token_is_rejected():
    with patch("api.auth._get_auth_client", return_value=_auth_client(raises=True)):
        r = TestClient(app).get("/api/categories", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_valid_token_returns_user_id():
    from api.auth import verify_token
    with patch("api.auth._get_auth_client", return_value=_auth_client("user-123")):
        assert verify_token("good") == "user-123"


def test_verified_tokens_are_cached():
    from api.auth import verify_token
    client = _auth_client("user-123")
    with patch("api.auth._get_auth_client", return_value=client):
        verify_token("good")
        verify_token("good")
    assert client.auth.get_user.call_count == 1


def test_health_stays_public():
    assert TestClient(app).get("/health").status_code == 200


def test_realtime_websocket_requires_token():
    with pytest.raises(WebSocketDisconnect) as exc:
        with TestClient(app).websocket_connect("/api/voice-assistant/realtime/ws") as ws:
            ws.receive_text()
    assert exc.value.code == 1008  # policy violation, before accept()


def test_missing_env_var_gives_503(monkeypatch):
    from api import auth
    monkeypatch.setattr(auth, "_auth_client", None)
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    r = TestClient(app).get("/api/categories", headers={"Authorization": "Bearer t"})
    assert r.status_code == 503
    assert r.json()["detail"] == "Auth service unavailable"
    assert "t" not in auth._cache


def test_auth_api_error_gives_401():
    from supabase_auth.errors import AuthApiError
    client = MagicMock()
    client.auth.get_user.side_effect = AuthApiError("bad jwt", 401, "bad_jwt")
    with patch("api.auth._get_auth_client", return_value=client):
        r = TestClient(app).get("/api/categories", headers={"Authorization": "Bearer t"})
    assert r.status_code == 401


def test_connection_error_gives_503():
    import httpx
    from api import auth
    client = MagicMock()
    client.auth.get_user.side_effect = httpx.ConnectError("refused")
    with patch("api.auth._get_auth_client", return_value=client):
        r = TestClient(app).get("/api/categories", headers={"Authorization": "Bearer t"})
    assert r.status_code == 503
    assert "t" not in auth._cache


# --- C-29 / R-1: empty tokens and the optional ALLOWED_USER_EMAILS allowlist ---

NOT_ALLOWED = "This account is not allowed to use this service"


@pytest.mark.parametrize("token", ["", "   "])
def test_empty_token_is_rejected_without_calling_supabase(token):
    """get_user("") would fall back to the shared client's own session; never call it."""
    from fastapi import HTTPException
    from api.auth import verify_token
    client = _auth_client("user-123")
    with patch("api.auth._get_auth_client", return_value=client):
        with pytest.raises(HTTPException) as exc:
            verify_token(token)
    assert exc.value.status_code == 401
    client.auth.get_user.assert_not_called()


def test_bearer_header_with_empty_token_gives_401():
    client = _auth_client("user-123")
    with patch("api.auth._get_auth_client", return_value=client):
        r = TestClient(app).get("/api/categories", headers={"Authorization": "Bearer "})
    assert r.status_code == 401
    client.auth.get_user.assert_not_called()


def test_allowlist_unset_accepts_any_valid_user():
    from api.auth import verify_token
    with patch("api.auth._get_auth_client", return_value=_auth_client("u1", email="anyone@else.org")):
        assert verify_token("good") == "u1"


def test_allowlist_rejects_unlisted_email_with_403(monkeypatch):
    monkeypatch.setenv("ALLOWED_USER_EMAILS", "demo@sfgov.org")
    with patch("api.auth._get_auth_client", return_value=_auth_client("u1", email="intruder@example.org")):
        r = TestClient(app).get("/api/categories", headers={"Authorization": "Bearer t"})
    assert r.status_code == 403
    assert r.json() == {"detail": NOT_ALLOWED}


def test_allowlist_is_case_insensitive_and_trims_entries(monkeypatch):
    from api.auth import verify_token
    monkeypatch.setenv("ALLOWED_USER_EMAILS", " other@x.org , Demo@SFGov.org ,")
    with patch("api.auth._get_auth_client", return_value=_auth_client("u1", email="demo@sfgov.ORG")):
        assert verify_token("good") == "u1"


def test_allowlist_rejects_user_without_email(monkeypatch):
    """Anonymous / phone-only users have no email, so a set allowlist never admits them."""
    from fastapi import HTTPException
    from api.auth import verify_token
    monkeypatch.setenv("ALLOWED_USER_EMAILS", "demo@sfgov.org")
    with patch("api.auth._get_auth_client", return_value=_auth_client("anon", email=None)):
        with pytest.raises(HTTPException) as exc:
            verify_token("t")
    assert exc.value.status_code == 403


def test_rejected_users_are_not_cached(monkeypatch):
    from fastapi import HTTPException
    from api import auth
    monkeypatch.setenv("ALLOWED_USER_EMAILS", "demo@sfgov.org")
    client = _auth_client("u1", email="intruder@example.org")
    with patch("api.auth._get_auth_client", return_value=client):
        for _ in range(2):
            with pytest.raises(HTTPException):
                auth.verify_token("t")
    assert "t" not in auth._cache
    assert client.auth.get_user.call_count == 2


def test_allowlist_is_read_on_every_call_even_for_cached_tokens(monkeypatch):
    """Tightening the allowlist takes effect at once, not after the 60 s cache."""
    from fastapi import HTTPException
    from api.auth import verify_token
    client = _auth_client("u1", email="worker@example.org")
    with patch("api.auth._get_auth_client", return_value=client):
        assert verify_token("good") == "u1"           # cached while the allowlist is unset
        monkeypatch.setenv("ALLOWED_USER_EMAILS", "demo@sfgov.org")
        with pytest.raises(HTTPException) as exc:
            verify_token("good")
    assert exc.value.status_code == 403


def test_realtime_websocket_rejects_unlisted_user(monkeypatch):
    monkeypatch.setenv("ALLOWED_USER_EMAILS", "demo@sfgov.org")
    with patch("api.auth._get_auth_client", return_value=_auth_client("u1", email="intruder@example.org")):
        with pytest.raises(WebSocketDisconnect) as exc:
            with TestClient(app).websocket_connect(
                "/api/voice-assistant/realtime/ws", headers={"Authorization": "Bearer t"}
            ) as ws:
                ws.receive_text()
    assert exc.value.code == 1008  # policy violation, before accept()
