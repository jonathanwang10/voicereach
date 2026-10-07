from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from main import app

pytestmark = pytest.mark.real_auth


def _auth_client(user_id=None, raises=False):
    client = MagicMock()
    if raises:
        client.auth.get_user.side_effect = Exception("invalid JWT")
    else:
        client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id=user_id))
    return client


@pytest.fixture(autouse=True)
def _clear_cache():
    from api import auth
    auth._cache.clear()


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
    with pytest.raises(WebSocketDisconnect):
        with TestClient(app).websocket_connect("/api/voice-assistant/realtime/ws") as ws:
            ws.receive_text()


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
